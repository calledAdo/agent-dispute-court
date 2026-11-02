import type { Claim, Finding, ReferencePrice, Sale } from "@dispute-court/protocol";
import { checkClaim } from "./checks.ts";
import { assembleHistory } from "./evidence.ts";
import type { EvidenceDeps } from "./evidence.ts";
import { explain, intake, judgeQuality } from "./judge.ts";
import type { Judgment, ModelClient } from "./judge.ts";
import { decide, settleFilingFee } from "./verdict.ts";
import type { Policy, Ruling } from "./verdict.ts";

export interface CaseInput {
  id: string;
  seller: `0x${string}`;
  complaint: string;
  payer: `0x${string}`;
  txs: `0x${string}`[];
  buyerOrders?: Record<string, string>;
}

export interface CaseDeps {
  evidence: EvidenceDeps;
  model: { client: ModelClient; name: string } | null;
  policy: Policy;
  reference: (symbol: string, at: number) => Promise<ReferencePrice>;
  priceList: Record<string, bigint>;
  duplicateWindowMs: number;
  now: () => number;
}

export interface CaseResult {
  id: string;
  claims: Claim[];
  findings: Finding[];
  rulings: Ruling[];
  refundFee: boolean;
  summary: string;
  evidence: Record<string, unknown>;
  /** True when the model's intake failed and the fixed one-claim-per-tx fallback was used. */
  intakeFallback?: boolean;
  /** Sanitized cause of the intake failure; set with intakeFallback. */
  intakeFallbackReason?: string;
}

const same = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();

/** Without a model (or if intake fails) every transaction is disputed on the quality code. */
function fallbackClaims(txs: `0x${string}`[]): Claim[] {
  return txs.map((tx, i) => ({ id: `claim-${i + 1}`, tx, code: "A13.3" as const }));
}

/** Short, single-line error text with no URLs or long hex tokens. (Same rule as api.ts; not imported to avoid loading express.) */
function sanitizeReason(e: unknown): string {
  const raw = e instanceof Error ? `${e.name}: ${e.message}` : String(e);
  return raw.split("\n")[0].replace(/https?:\/\/\S+/g, "<url>").replace(/[0-9a-fA-F]{32,}/g, "<redacted>").slice(0, 200);
}

async function buildClaims(
  input: CaseInput,
  sales: Sale[],
  deps: CaseDeps,
): Promise<{ claims: Claim[]; fallbackReason?: string }> {
  if (deps.model === null) return { claims: fallbackClaims(input.txs) };
  try {
    const summary = sales.map((s) => ({ tx: s.tx, resource: s.resource, settledAt: s.settledAt }));
    return { claims: await intake(input.complaint, summary, deps.model.client, deps.model.name) };
  } catch (e) {
    return { claims: fallbackClaims(input.txs), fallbackReason: sanitizeReason(e) };
  }
}

/** A real complaint that produced no claims is never dismissed: a human decides each disputed tx. */
function needsHumanRulings(input: CaseInput, sales: Sale[]): Ruling[] {
  return input.txs.map((tx, i) => {
    const sale = sales.find((s) => same(s.tx, tx)) ?? null;
    return {
      claimId: `unclassified-${i + 1}`,
      tx,
      code: "A13.3",
      verdict: "ESCALATE",
      liable: "NONE",
      refund: 0n,
      proposedRefund: sale?.amount ?? 0n,
      reason: "no_claims_identified_needs_human",
      evidence: sale ? [sale.tx] : [],
      decidedBy: "code",
    };
  });
}

function requestedSymbol(resource: string): string | null {
  const q = resource.indexOf("?");
  if (q === -1) return null;
  const symbol = new URLSearchParams(resource.slice(q + 1).split("#")[0]).get("symbol");
  return symbol === null || symbol === "" ? null : symbol;
}

/** A failed or missing reference lookup is "unavailable", which the check reports as unchecked. Only quote-v1 uses a reference. */
async function fetchReference(sale: Sale | null, deps: CaseDeps): Promise<ReferencePrice> {
  if (sale === null || sale.acceptance?.verifier !== "quote-v1") return null;
  const symbol = requestedSymbol(sale.resource);
  if (symbol === null) return null;
  try {
    return await deps.reference(symbol, sale.settledAt);
  } catch {
    return null;
  }
}

const BODY_CAP = 2000;

/** The delivered body as the judge should read it: parsed JSON, else the raw text capped. */
function deliveredBody(body: string): unknown {
  try {
    return JSON.parse(body);
  } catch {
    return body.slice(0, BODY_CAP);
  }
}

/** Keys the judge may cite: the same identifiers the checks put in Finding.evidence. */
function evidenceFor(sales: Sale[], references: Map<string, ReferencePrice>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const sale of sales) {
    const { receipt, acceptance, ...rest } = sale;
    const settledAt = new Date(sale.settledAt).toISOString();
    out[sale.tx] = { ...rest, settledAt };
    if (receipt !== null) {
      out[`receipt:${sale.tx}`] = {
        status: receipt.status,
        responseHash: receipt.responseHash,
        anchored: receipt.anchored,
        settledAt,
        body: deliveredBody(receipt.body),
      };
    }
    if (acceptance !== null) {
      out[`acceptance:${sale.tx}`] = { ...acceptance, resource: sale.resource, settledAt };
    }
  }
  for (const ref of references.values()) {
    if (ref !== null) out[`reference:${ref.symbol}`] = ref;
  }
  return out;
}

export async function runCase(input: CaseInput, deps: CaseDeps): Promise<CaseResult> {
  const sales = await assembleHistory(input.payer, input.txs, deps.evidence, input.buyerOrders);
  const { claims, fallbackReason } = await buildClaims(input, sales, deps);
  const fallback = fallbackReason === undefined ? {} : { intakeFallback: true, intakeFallbackReason: fallbackReason };
  if (claims.length === 0 && input.complaint.trim() !== "") {
    const rulings = needsHumanRulings(input, sales);
    const { refundFee } = settleFilingFee(rulings, deps.policy);
    return { id: input.id, claims, findings: [], rulings, refundFee, summary: explain(rulings), evidence: evidenceFor(sales, new Map()), ...fallback };
  }
  const saleOf = (tx: string) => sales.find((s) => same(s.tx, tx)) ?? null;

  const references = new Map<string, ReferencePrice>();
  const findings: Finding[] = [];
  for (const claim of claims) {
    const sale = saleOf(claim.tx);
    let reference: ReferencePrice = null;
    if (claim.code === "A13.3") {
      reference = await fetchReference(sale, deps);
      references.set(claim.id, reference);
    }
    findings.push(
      checkClaim(claim, {
        sale,
        history: sales,
        reference,
        priceList: deps.priceList,
        expectedPayee: deps.evidence.seller,
        duplicateWindowMs: deps.duplicateWindowMs,
      }),
    );
  }

  const evidence = evidenceFor(sales, references);
  const rulings: Ruling[] = [];
  for (let i = 0; i < claims.length; i++) {
    const claim = claims[i];
    const finding = findings[i];
    let judgment: Judgment | undefined;
    if (deps.model !== null && claim.code === "A13.3" && finding.state === "COULD_NOT_BE_CHECKED") {
      try {
        judgment = await judgeQuality(claim, evidence, input.complaint, deps.model.client, deps.model.name);
      } catch {
        judgment = undefined; // no judgment: decide() escalates
      }
    }
    rulings.push(decide(finding, saleOf(claim.tx), deps.policy, judgment));
  }

  const { refundFee } = settleFilingFee(rulings, deps.policy);
  return { id: input.id, claims, findings, rulings, refundFee, summary: explain(rulings), evidence, ...fallback };
}
