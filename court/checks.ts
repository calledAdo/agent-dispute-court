import { createHash } from "node:crypto";
import { checkInferOutput } from "../shared/infer.ts";
import type {
  Claim,
  Finding,
  InferAcceptance,
  QuoteAcceptance,
  Receipt,
  ReferencePrice,
  Sale,
} from "../shared/types.ts";

export interface CheckContext {
  sale: Sale | null;              // null => COULD_NOT_BE_CHECKED, reason "sale_not_found"
  history: Sale[];                // all sales by this payer (for A12)
  reference: ReferencePrice;      // for A13.3
  priceList: Record<string, bigint>; // route -> price, for A14
  expectedPayee: `0x${string}`;
  duplicateWindowMs: number;
}

export function sha256Hex(s: string): string {
  return createHash("sha256").update(s).digest("hex");
}

/** "GET /quote?symbol=TSLA" -> "GET /quote" */
export function routeOf(resource: string): string {
  const end = resource.search(/[?#]/);
  return end === -1 ? resource : resource.slice(0, end);
}

export function checkClaim(claim: Claim, ctx: CheckContext): Finding {
  try {
    const { sale } = ctx;
    if (sale === null) {
      return finding(claim, "COULD_NOT_BE_CHECKED", "sale_not_found", []);
    }

    switch (claim.code) {
      case "A10":
        return checkA10(claim, sale);
      case "A12":
        return checkA12(claim, sale, ctx);
      case "A13.1":
        return checkA13_1(claim, sale);
      case "A13.3":
        return checkA13_3(claim, sale, ctx);
      case "A14":
        return checkA14(claim, sale, ctx);
      default:
        return finding(
          claim,
          "COULD_NOT_BE_CHECKED",
          `unknown_claim_code:${String((claim as Claim).code)}`,
          [sale.tx],
        );
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return finding(claim, "COULD_NOT_BE_CHECKED", `internal_error:${message}`, []);
  }
}

function finding(
  claim: Claim,
  state: Finding["state"],
  reason: string,
  evidence: string[],
): Finding {
  return { claimId: claim.id, code: claim.code, state, reason, evidence };
}

function checkA10(claim: Claim, sale: Sale): Finding {
  if (sale.signedOrderValid === false) {
    return finding(claim, "DIFFERENCE_CONFIRMED", "signed_order_invalid", [sale.tx]);
  }

  if (sale.signedOrderValid === null) {
    return finding(claim, "COULD_NOT_BE_CHECKED", "signed_order_check_unavailable", [sale.tx]);
  }

  const reason =
    claim.allegedResource !== undefined && claim.allegedResource !== sale.resource
      ? `signature_names:${sale.resource}`
      : "signed_order_valid";
  return finding(claim, "NO_DIFFERENCE_FOUND", reason, [sale.tx]);
}

function checkA12(claim: Claim, sale: Sale, ctx: CheckContext): Finding {
  if (ctx.history.length === 0) {
    return finding(claim, "COULD_NOT_BE_CHECKED", "history_empty", [sale.tx]);
  }

  if (!ctx.history.some((entry) => entry.tx === sale.tx)) {
    return finding(claim, "COULD_NOT_BE_CHECKED", "sale_not_in_history", [sale.tx]);
  }

  const duplicate = ctx.history.find(
    (entry) =>
      entry.tx !== sale.tx &&
      sameAddress(entry.payer, sale.payer) &&
      entry.requestHash === sale.requestHash &&
      entry.settledAt < sale.settledAt &&
      sale.settledAt - entry.settledAt <= ctx.duplicateWindowMs,
  );

  if (duplicate !== undefined) {
    return finding(claim, "DIFFERENCE_CONFIRMED", "duplicate_charge_found", [
      sale.tx,
      duplicate.tx,
    ]);
  }

  return finding(claim, "NO_DIFFERENCE_FOUND", "no_earlier_duplicate", [sale.tx]);
}

function checkA13_1(claim: Claim, sale: Sale): Finding {
  const { receipt } = sale;

  if (receipt === null) {
    return finding(claim, "DIFFERENCE_CONFIRMED", "no_receipt", [sale.tx]);
  }

  const evidence = [sale.tx, `receipt:${sale.tx}`];

  if (receipt.status >= 400) {
    return finding(claim, "DIFFERENCE_CONFIRMED", `error_status:${receipt.status}`, evidence);
  }

  if (sha256Hex(receipt.body) !== receipt.responseHash) {
    return finding(claim, "COULD_NOT_BE_CHECKED", "receipt_tampered", evidence);
  }

  if (receipt.anchored === null) {
    return finding(claim, "COULD_NOT_BE_CHECKED", "anchor_unavailable", evidence);
  }

  if (receipt.anchored === false) {
    return finding(claim, "COULD_NOT_BE_CHECKED", "receipt_not_anchored", evidence);
  }

  return finding(claim, "NO_DIFFERENCE_FOUND", "delivery_verified", evidence);
}

function sameAddress(a: string, b: string): boolean {
  return a.toLowerCase() === b.toLowerCase();
}

/** Lowercased `symbol` query parameter of the signed resource, or null if absent/empty. */
function requestedSymbol(resource: string): string | null {
  const q = resource.indexOf("?");
  if (q === -1) return null;
  const end = resource.indexOf("#", q);
  const params = new URLSearchParams(resource.slice(q + 1, end === -1 ? undefined : end));
  const symbol = params.get("symbol");
  return symbol === null || symbol === "" ? null : symbol.toLowerCase();
}

interface Quote {
  symbol: string;
  price: number;
  asOf: string;
}

function checkA13_3(claim: Claim, sale: Sale, ctx: CheckContext): Finding {
  const { acceptance } = sale;
  const evidence = [sale.tx];

  if (acceptance === null) {
    return finding(claim, "COULD_NOT_BE_CHECKED", "acceptance_missing", evidence);
  }
  evidence.push(`acceptance:${sale.tx}`);

  if (sale.receipt === null) {
    return finding(claim, "COULD_NOT_BE_CHECKED", "receipt_missing", evidence);
  }
  const receipt = sale.receipt;
  evidence.push(`receipt:${sale.tx}`);

  return acceptance.verifier === "infer-v1"
    ? checkInferDelivery(claim, sale, receipt, acceptance, evidence)
    : checkQuoteDelivery(claim, sale, receipt, acceptance, ctx, evidence);
}

/** infer-v1 needs no reference price: the signed acceptance criteria alone settle the delivery. */
function checkInferDelivery(claim: Claim, sale: Sale, receipt: Receipt, acceptance: InferAcceptance, evidence: string[]): Finding {
  if (sha256Hex(receipt.body) !== receipt.responseHash) {
    return finding(claim, "COULD_NOT_BE_CHECKED", "receipt_tampered", evidence);
  }

  const violation = checkInferOutput(receipt.body, sale.requestHash, acceptance);
  return violation === null
    ? finding(claim, "NO_DIFFERENCE_FOUND", "output_meets_acceptance", evidence)
    : finding(claim, "DIFFERENCE_CONFIRMED", violation, evidence);
}

function checkQuoteDelivery(
  claim: Claim,
  sale: Sale,
  receipt: Receipt,
  acceptance: QuoteAcceptance,
  ctx: CheckContext,
  evidence: string[],
): Finding {
  const quote = parseQuote(receipt.body);
  if (quote === null) {
    return finding(claim, "COULD_NOT_BE_CHECKED", "body_unparseable", evidence);
  }

  const requested = requestedSymbol(sale.resource);
  if (requested === null) {
    return finding(claim, "COULD_NOT_BE_CHECKED", "requested_symbol_unknown", evidence);
  }

  // Needs no reference: the signed request names one symbol and the body another.
  if (quote.symbol.toLowerCase() !== requested) {
    return finding(claim, "DIFFERENCE_CONFIRMED", "wrong_symbol", evidence);
  }

  const { reference } = ctx;
  if (reference === null) {
    return finding(claim, "COULD_NOT_BE_CHECKED", "reference_unavailable", evidence);
  }
  evidence.push(`reference:${reference.symbol}`);

  if (reference.symbol.toLowerCase() !== requested) {
    return finding(claim, "COULD_NOT_BE_CHECKED", "reference_symbol_mismatch", evidence);
  }

  if (!Number.isFinite(reference.price) || reference.price <= 0) {
    return finding(claim, "COULD_NOT_BE_CHECKED", "reference_price_invalid", evidence);
  }

  const staleness = sale.settledAt - Date.parse(quote.asOf);
  if (staleness < 0) {
    return finding(claim, "DIFFERENCE_CONFIRMED", "quote_from_future", evidence);
  }
  if (staleness > acceptance.maxStalenessMs) {
    return finding(claim, "DIFFERENCE_CONFIRMED", "stale_quote", evidence);
  }

  // Cross-multiply so an exactly-at-limit deviation is not lost to float division.
  const deviation =
    Math.abs(quote.price - reference.price) * 10_000 >
    acceptance.maxDeviationBps * reference.price;
  if (deviation) {
    return finding(claim, "DIFFERENCE_CONFIRMED", "deviation_exceeds_max", evidence);
  }

  return finding(claim, "NO_DIFFERENCE_FOUND", "quote_meets_acceptance", evidence);
}

function parseQuote(body: string): Quote | null {
  try {
    const value: unknown = JSON.parse(body);
    if (typeof value !== "object" || value === null) return null;

    const { symbol, price, asOf } = value as Record<string, unknown>;
    if (typeof symbol !== "string" || typeof price !== "number" || typeof asOf !== "string") {
      return null;
    }
    if (!Number.isFinite(price) || Number.isNaN(Date.parse(asOf))) return null;

    return { symbol, price, asOf };
  } catch {
    return null;
  }
}

function checkA14(claim: Claim, sale: Sale, ctx: CheckContext): Finding {
  const route = routeOf(sale.resource);

  if (!Object.hasOwn(ctx.priceList, route)) {
    return finding(claim, "COULD_NOT_BE_CHECKED", "route_not_in_price_list", [
      sale.tx,
      `route:${route}`,
    ]);
  }

  const amountMatches = sale.amount === ctx.priceList[route];
  const payeeMatches = sameAddress(sale.payee, ctx.expectedPayee);

  if (!amountMatches && !payeeMatches) {
    return finding(claim, "DIFFERENCE_CONFIRMED", "amount_and_payee_mismatch", [sale.tx]);
  }
  if (!amountMatches) {
    return finding(claim, "DIFFERENCE_CONFIRMED", "amount_mismatch", [sale.tx]);
  }
  if (!payeeMatches) {
    return finding(claim, "DIFFERENCE_CONFIRMED", "payee_mismatch", [sale.tx]);
  }

  return finding(claim, "NO_DIFFERENCE_FOUND", "price_and_payee_match", [sale.tx]);
}
