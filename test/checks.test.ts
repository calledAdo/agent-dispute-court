import test from "node:test";
import assert from "node:assert/strict";
import {
  checkClaim,
  routeOf,
  sha256Hex,
  type CheckContext,
} from "../court/checks.ts";
import type {
  Acceptance,
  Claim,
  Receipt,
  Sale,
} from "../shared/types.ts";

const TX = "0x1111111111111111111111111111111111111111111111111111111111111111";
const TX_EARLIER = "0x2222222222222222222222222222222222222222222222222222222222222222";
const TX_LATER = "0x3333333333333333333333333333333333333333333333333333333333333333";
const PAYER = "0x4444444444444444444444444444444444444444444444444444444444444444";
const PAYEE = "0x5555555555555555555555555555555555555555555555555555555555555555";
const OTHER_PAYEE = "0x6666666666666666666666666666666666666666666666666666666666666666";
const SETTLED_AT = Date.parse("2026-10-29T12:00:00.000Z");

const ACCEPTANCE: Acceptance = {
  verifier: "quote-v1",
  maxStalenessMs: 60_000,
  maxDeviationBps: 100,
};

const RESOURCE = "GET /quote?symbol=TSLA";

function quoteBody(price = 100, asOf = "2026-10-29T12:00:00.000Z", symbol = "TSLA"): string {
  return JSON.stringify({ symbol, price, asOf });
}

function receiptFor(body: string, overrides: Partial<Receipt> = {}): Receipt {
  return {
    status: 200,
    responseHash: sha256Hex(body),
    body,
    anchored: true,
    ...overrides,
  };
}

function makeSale(overrides: Partial<Sale> = {}): Sale {
  return {
    tx: TX,
    payer: PAYER,
    payee: PAYEE,
    amount: 1_000n,
    settledAt: SETTLED_AT,
    resource: RESOURCE,
    requestHash: sha256Hex(RESOURCE),
    signedOrderValid: true,
    receipt: receiptFor(quoteBody()),
    acceptance: ACCEPTANCE,
    ...overrides,
  };
}

function makeCtx(overrides: Partial<CheckContext> = {}): CheckContext {
  const sale = makeSale();
  return {
    sale,
    history: [sale],
    reference: { symbol: "TSLA", price: 100, at: SETTLED_AT },
    priceList: { "GET /quote": 1_000n },
    expectedPayee: PAYEE,
    duplicateWindowMs: 60_000,
    ...overrides,
  };
}

function claimFor(code: Claim["code"], overrides: Partial<Claim> = {}): Claim {
  return { id: "claim-1", tx: TX, code, ...overrides };
}

test("sha256Hex hashes the string", () => {
  assert.equal(
    sha256Hex(""),
    "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
  );
  assert.equal(sha256Hex("abc"), sha256Hex("abc"));
  assert.notEqual(sha256Hex("abc"), sha256Hex("abd"));
});

test("routeOf drops the query string and fragment", () => {
  assert.equal(routeOf("GET /quote?symbol=TSLA"), "GET /quote");
  assert.equal(routeOf("GET /quote?symbol=TSLA#frag"), "GET /quote");
  assert.equal(routeOf("GET /quote"), "GET /quote");
});

test("checkClaim with sale: null cannot check", () => {
  const finding = checkClaim(claimFor("A10"), makeCtx({ sale: null }));
  assert.equal(finding.state, "COULD_NOT_BE_CHECKED");
  assert.equal(finding.reason, "sale_not_found");
});

test("checkClaim never throws and reports unexpected errors", () => {
  const ctx = makeCtx();
  Object.defineProperty(ctx, "history", {
    get() {
      throw new Error("boom");
    },
  });

  const finding = checkClaim(claimFor("A12"), ctx);
  assert.equal(finding.state, "COULD_NOT_BE_CHECKED");
  assert.equal(finding.reason, "internal_error:boom");
});

// A10: "My agent never placed this order"

test("A10 confirms when the signed order is invalid", () => {
  const finding = checkClaim(
    claimFor("A10"),
    makeCtx({ sale: makeSale({ signedOrderValid: false }) }),
  );
  assert.equal(finding.state, "DIFFERENCE_CONFIRMED");
});

test("A10 finds no difference when the signed order is valid", () => {
  const finding = checkClaim(
    claimFor("A10"),
    makeCtx({ sale: makeSale({ signedOrderValid: true }) }),
  );
  assert.equal(finding.state, "NO_DIFFERENCE_FOUND");
});

test("A10 names the signed resource when the alleged request differs", () => {
  const finding = checkClaim(
    claimFor("A10", { allegedResource: "GET /quote?symbol=AAPL" }),
    makeCtx({ sale: makeSale({ signedOrderValid: true }) }),
  );
  assert.equal(finding.state, "NO_DIFFERENCE_FOUND");
  assert.match(finding.reason, new RegExp(RESOURCE.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
});

test("A10 cannot check when signature verification did not run", () => {
  const finding = checkClaim(
    claimFor("A10"),
    makeCtx({ sale: makeSale({ signedOrderValid: null }) }),
  );
  assert.equal(finding.state, "COULD_NOT_BE_CHECKED");
  assert.ok(finding.reason.length > 0);
});

// A12: "Charged twice for the same request"

test("A12 confirms an earlier duplicate within the window", () => {
  const sale = makeSale();
  const earlier = makeSale({
    tx: TX_EARLIER,
    settledAt: SETTLED_AT - 30_000,
  });
  const finding = checkClaim(claimFor("A12"), makeCtx({ sale, history: [sale, earlier] }));
  assert.equal(finding.state, "DIFFERENCE_CONFIRMED");
  assert.ok(finding.evidence.includes(TX_EARLIER));
});

test("A12 finds no difference when there is no earlier duplicate", () => {
  const sale = makeSale();
  const finding = checkClaim(claimFor("A12"), makeCtx({ sale, history: [sale] }));
  assert.equal(finding.state, "NO_DIFFERENCE_FOUND");
});

test("A12 ignores a duplicate that is later than this sale", () => {
  const sale = makeSale();
  const later = makeSale({
    tx: TX_LATER,
    settledAt: SETTLED_AT + 30_000,
  });
  const finding = checkClaim(claimFor("A12"), makeCtx({ sale, history: [sale, later] }));
  assert.equal(finding.state, "NO_DIFFERENCE_FOUND");
});

test("A12 ignores an earlier sale outside the duplicate window", () => {
  const sale = makeSale();
  const earlier = makeSale({
    tx: TX_EARLIER,
    settledAt: SETTLED_AT - 120_000,
  });
  const finding = checkClaim(claimFor("A12"), makeCtx({ sale, history: [sale, earlier] }));
  assert.equal(finding.state, "NO_DIFFERENCE_FOUND");
});

test("A12 ignores an earlier sale for a different request", () => {
  const sale = makeSale();
  const earlier = makeSale({
    tx: TX_EARLIER,
    settledAt: SETTLED_AT - 30_000,
    requestHash: sha256Hex("GET /quote?symbol=AAPL"),
  });
  const finding = checkClaim(claimFor("A12"), makeCtx({ sale, history: [sale, earlier] }));
  assert.equal(finding.state, "NO_DIFFERENCE_FOUND");
});

test("A12 cannot check when history is empty", () => {
  const finding = checkClaim(claimFor("A12"), makeCtx({ history: [] }));
  assert.equal(finding.state, "COULD_NOT_BE_CHECKED");
  assert.equal(finding.reason, "history_empty");
});

test("A12 cannot check when history does not contain this sale", () => {
  const other = makeSale({ tx: TX_EARLIER });
  const finding = checkClaim(claimFor("A12"), makeCtx({ history: [other] }));
  assert.equal(finding.state, "COULD_NOT_BE_CHECKED");
  assert.equal(finding.reason, "sale_not_in_history");
});

// A13.1: "Paid, got nothing"

test("A13.1 confirms when no receipt was logged", () => {
  const finding = checkClaim(
    claimFor("A13.1"),
    makeCtx({ sale: makeSale({ receipt: null }) }),
  );
  assert.equal(finding.state, "DIFFERENCE_CONFIRMED");
});

test("A13.1 confirms an error status", () => {
  const body = quoteBody();
  const finding = checkClaim(
    claimFor("A13.1"),
    makeCtx({ sale: makeSale({ receipt: receiptFor(body, { status: 500 }) }) }),
  );
  assert.equal(finding.state, "DIFFERENCE_CONFIRMED");
});

test("A13.1 finds no difference for an anchored, intact delivery", () => {
  const finding = checkClaim(claimFor("A13.1"), makeCtx());
  assert.equal(finding.state, "NO_DIFFERENCE_FOUND");
});

test("A13.1 cannot check when the anchor could not be verified", () => {
  const body = quoteBody();
  const finding = checkClaim(
    claimFor("A13.1"),
    makeCtx({ sale: makeSale({ receipt: receiptFor(body, { anchored: null }) }) }),
  );
  assert.equal(finding.state, "COULD_NOT_BE_CHECKED");
  assert.equal(finding.reason, "anchor_unavailable");
});

test("A13.1 reports receipt_tampered when the body was edited after hashing", () => {
  const body = quoteBody();
  const receipt = receiptFor(body);
  receipt.body = quoteBody(999);

  const finding = checkClaim(
    claimFor("A13.1"),
    makeCtx({ sale: makeSale({ receipt }) }),
  );
  assert.equal(finding.state, "COULD_NOT_BE_CHECKED");
  assert.equal(finding.reason, "receipt_tampered");
});

test("A13.1 cannot check a receipt that is not anchored", () => {
  const body = quoteBody();
  const finding = checkClaim(
    claimFor("A13.1"),
    makeCtx({ sale: makeSale({ receipt: receiptFor(body, { anchored: false }) }) }),
  );
  assert.equal(finding.state, "COULD_NOT_BE_CHECKED");
  assert.equal(finding.reason, "receipt_not_anchored");
});

// A13.3: "Data not as described"

test("A13.3 finds no difference when the quote meets the criteria", () => {
  const finding = checkClaim(claimFor("A13.3"), makeCtx());
  assert.equal(finding.state, "NO_DIFFERENCE_FOUND");
});

test("A13.3 passes exactly at maxDeviationBps (inclusive)", () => {
  const body = quoteBody(101); // 100 bps above a reference of 100
  const finding = checkClaim(
    claimFor("A13.3"),
    makeCtx({ sale: makeSale({ receipt: receiptFor(body) }) }),
  );
  assert.equal(finding.state, "NO_DIFFERENCE_FOUND");
});

test("A13.3 confirms a deviation above maxDeviationBps", () => {
  const body = quoteBody(102); // 200 bps above a reference of 100
  const finding = checkClaim(
    claimFor("A13.3"),
    makeCtx({ sale: makeSale({ receipt: receiptFor(body) }) }),
  );
  assert.equal(finding.state, "DIFFERENCE_CONFIRMED");
});

test("A13.3 confirms a stale quote", () => {
  const body = quoteBody(100, "2026-10-29T11:58:00.000Z"); // 2 minutes old
  const finding = checkClaim(
    claimFor("A13.3"),
    makeCtx({ sale: makeSale({ receipt: receiptFor(body) }) }),
  );
  assert.equal(finding.state, "DIFFERENCE_CONFIRMED");
});

test("A13.3 confirms a quote from the future", () => {
  const body = quoteBody(100, "2026-10-29T12:00:01.000Z");
  const finding = checkClaim(
    claimFor("A13.3"),
    makeCtx({ sale: makeSale({ receipt: receiptFor(body) }) }),
  );
  assert.equal(finding.state, "DIFFERENCE_CONFIRMED");
});

test("A13.3 cannot check without acceptance criteria", () => {
  const finding = checkClaim(
    claimFor("A13.3"),
    makeCtx({ sale: makeSale({ acceptance: null }) }),
  );
  assert.equal(finding.state, "COULD_NOT_BE_CHECKED");
  assert.equal(finding.reason, "acceptance_missing");
});

test("A13.3 cannot check without a receipt", () => {
  const finding = checkClaim(
    claimFor("A13.3"),
    makeCtx({ sale: makeSale({ receipt: null }) }),
  );
  assert.equal(finding.state, "COULD_NOT_BE_CHECKED");
  assert.equal(finding.reason, "receipt_missing");
});

test("A13.3 cannot check an unparseable body", () => {
  const finding = checkClaim(
    claimFor("A13.3"),
    makeCtx({ sale: makeSale({ receipt: receiptFor("not json") }) }),
  );
  assert.equal(finding.state, "COULD_NOT_BE_CHECKED");
  assert.equal(finding.reason, "body_unparseable");
});

test("A13.3 cannot check without a reference price", () => {
  const finding = checkClaim(claimFor("A13.3"), makeCtx({ reference: null }));
  assert.equal(finding.state, "COULD_NOT_BE_CHECKED");
  assert.equal(finding.reason, "reference_unavailable");
});

test("A13.3 confirms wrong_symbol when the quote is for another symbol", () => {
  const body = quoteBody(100, "2026-10-29T12:00:00.000Z", "AAPL");
  const finding = checkClaim(
    claimFor("A13.3"),
    makeCtx({ sale: makeSale({ receipt: receiptFor(body) }), reference: null }),
  );
  assert.equal(finding.state, "DIFFERENCE_CONFIRMED");
  assert.equal(finding.reason, "wrong_symbol");
});

test("A13.3 compares the requested symbol case-insensitively", () => {
  const sale = makeSale({ resource: "GET /quote?symbol=tsla" });
  const finding = checkClaim(claimFor("A13.3"), makeCtx({ sale, history: [sale] }));
  assert.equal(finding.state, "NO_DIFFERENCE_FOUND");
});

test("A13.3 cannot check when the request names no symbol", () => {
  const sale = makeSale({ resource: "GET /quote" });
  const finding = checkClaim(claimFor("A13.3"), makeCtx({ sale, history: [sale] }));
  assert.equal(finding.state, "COULD_NOT_BE_CHECKED");
  assert.equal(finding.reason, "requested_symbol_unknown");
});

test("A13.3 cannot check when the reference is for another symbol", () => {
  const finding = checkClaim(
    claimFor("A13.3"),
    makeCtx({ reference: { symbol: "AAPL", price: 100, at: SETTLED_AT } }),
  );
  assert.equal(finding.state, "COULD_NOT_BE_CHECKED");
  assert.equal(finding.reason, "reference_symbol_mismatch");
});

test("A12 matches payers case-insensitively", () => {
  const checksummed = "0xAbCdEf1111111111111111111111111111111111111111111111111111111111";
  const sale = makeSale({ payer: checksummed.toLowerCase() as `0x${string}` });
  const earlier = makeSale({
    tx: TX_EARLIER,
    payer: checksummed,
    settledAt: SETTLED_AT - 30_000,
  });
  const finding = checkClaim(claimFor("A12"), makeCtx({ sale, history: [sale, earlier] }));
  assert.equal(finding.state, "DIFFERENCE_CONFIRMED");
});

test("A14 matches payees case-insensitively", () => {
  const checksummed = "0xAbCdEf2222222222222222222222222222222222222222222222222222222222";
  const sale = makeSale({ payee: checksummed.toLowerCase() as `0x${string}` });
  const finding = checkClaim(
    claimFor("A14"),
    makeCtx({ sale, history: [sale], expectedPayee: checksummed }),
  );
  assert.equal(finding.state, "NO_DIFFERENCE_FOUND");
});

// A14: "Price/payee wasn't the usual one"

test("A14 finds no difference when amount and payee match", () => {
  const finding = checkClaim(claimFor("A14"), makeCtx());
  assert.equal(finding.state, "NO_DIFFERENCE_FOUND");
});

test("A14 confirms an amount mismatch", () => {
  const finding = checkClaim(
    claimFor("A14"),
    makeCtx({ sale: makeSale({ amount: 2_000n }) }),
  );
  assert.equal(finding.state, "DIFFERENCE_CONFIRMED");
  assert.equal(finding.reason, "amount_mismatch");
});

test("A14 confirms a payee mismatch", () => {
  const finding = checkClaim(
    claimFor("A14"),
    makeCtx({ sale: makeSale({ payee: OTHER_PAYEE }) }),
  );
  assert.equal(finding.state, "DIFFERENCE_CONFIRMED");
  assert.equal(finding.reason, "payee_mismatch");
});

test("A14 cannot check a route missing from the price list", () => {
  const finding = checkClaim(
    claimFor("A14"),
    makeCtx({ priceList: { "GET /other": 1_000n } }),
  );
  assert.equal(finding.state, "COULD_NOT_BE_CHECKED");
  assert.equal(finding.reason, "route_not_in_price_list");
});

// A13.3 on an infer-v1 sale: the signed delivery standard decides, and no reference is used.

const INFER_RESOURCE = "GET /infer?task=summary-v1&text=what+changed";
const INFER_ACCEPTANCE: Acceptance = { verifier: "infer-v1", task: "summary-v1", maxChars: 20, maxKeywords: 2 };

function inferBody(over: Record<string, unknown> = {}): string {
  return JSON.stringify({ task: "summary-v1", requestHash: sha256Hex(INFER_RESOURCE), summary: "short summary", keywords: ["a"], ...over });
}

function inferSale(body: string = inferBody(), overrides: Partial<Sale> = {}): Sale {
  return makeSale({
    resource: INFER_RESOURCE,
    requestHash: sha256Hex(INFER_RESOURCE),
    acceptance: INFER_ACCEPTANCE,
    receipt: receiptFor(body),
    ...overrides,
  });
}

test("A13.3 infer-v1 finds no difference when the output meets the signed standard", () => {
  const finding = checkClaim(claimFor("A13.3"), makeCtx({ sale: inferSale(), reference: null }));
  assert.equal(finding.state, "NO_DIFFERENCE_FOUND");
  assert.equal(finding.reason, "output_meets_acceptance");
  assert.deepEqual(finding.evidence, [TX, `acceptance:${TX}`, `receipt:${TX}`]);
});

const INFER_VIOLATIONS: [string, string][] = [
  ["body_unparseable", "not json"],
  ["wrong_task", inferBody({ task: "translate-v1" })],
  ["wrong_request", inferBody({ requestHash: sha256Hex("GET /infer?task=summary-v1&text=other") })],
  ["empty_summary", inferBody({ summary: "   " })],
  ["summary_too_long", inferBody({ summary: "x".repeat(21) })],
  ["bad_keywords", inferBody({ keywords: [] })],
];

for (const [violation, body] of INFER_VIOLATIONS) {
  test(`A13.3 infer-v1 confirms ${violation}`, () => {
    const finding = checkClaim(claimFor("A13.3"), makeCtx({ sale: inferSale(body), reference: null }));
    assert.equal(finding.state, "DIFFERENCE_CONFIRMED");
    assert.equal(finding.reason, violation);
  });
}

test("A13.3 infer-v1 cannot check a body edited after hashing", () => {
  const receipt = receiptFor(inferBody());
  receipt.body = inferBody({ summary: "edited later" });
  const finding = checkClaim(claimFor("A13.3"), makeCtx({ sale: inferSale(inferBody(), { receipt }), reference: null }));
  assert.equal(finding.state, "COULD_NOT_BE_CHECKED");
  assert.equal(finding.reason, "receipt_tampered");
});

test("A13.3 infer-v1 cannot check without a receipt", () => {
  const finding = checkClaim(claimFor("A13.3"), makeCtx({ sale: inferSale(inferBody(), { receipt: null }), reference: null }));
  assert.equal(finding.state, "COULD_NOT_BE_CHECKED");
  assert.equal(finding.reason, "receipt_missing");
});
