import test from "node:test";
import assert from "node:assert/strict";
import { decide, settleFilingFee, type Policy } from "../court/verdict.ts";
import type { Judgment } from "../court/judge.ts";
import type { CheckState, Finding, ReasonCode, Sale } from "../shared/types.ts";

const TX = "0x1111111111111111111111111111111111111111111111111111111111111111";
const policy: Policy = { autoRefundMax: 50n, escalateAbove: 100n, filingFee: 5n };

function sale(amount = 40n): Sale {
  return {
    tx: TX, payer: "0x01", payee: "0x02", amount, settledAt: 0,
    resource: "GET /quote?symbol=TSLA", requestHash: "h",
    signedOrderValid: true, receipt: null, acceptance: null,
  } as Sale;
}
function finding(code: ReasonCode, state: CheckState, reason = "r"): Finding {
  return { claimId: "c1", code, state, reason, evidence: ["e1"] };
}
const judg = (o: Partial<Judgment> = {}): Judgment => ({
  upheld: true, confidence: 0.9, rationale: "bad", citedEvidence: ["k"], ...o,
});

test("no sale escalates with no liability", () => {
  const r = decide(finding("A12", "DIFFERENCE_CONFIRMED"), null, policy);
  assert.equal(r.verdict, "ESCALATE");
  assert.equal(r.liable, "NONE");
  assert.equal(r.refund, 0n);
});

for (const code of ["A10", "A12", "A13.1", "A13.3", "A14"] as const) {
  test(`confirmed ${code} refunds the sale amount, seller liable`, () => {
    const r = decide(finding(code, "DIFFERENCE_CONFIRMED"), sale(), policy);
    assert.equal(r.verdict, "REFUND");
    assert.equal(r.liable, "SELLER");
    assert.equal(r.refund, 40n);
    assert.equal(r.decidedBy, "code");
    assert.equal(r.tx, TX);
  });
}

test("confirmed above escalateAbove escalates, same liable", () => {
  const r = decide(finding("A12", "DIFFERENCE_CONFIRMED"), sale(101n), policy);
  assert.equal(r.verdict, "ESCALATE");
  assert.equal(r.liable, "SELLER");
  assert.equal(r.refund, 0n);
  assert.equal(decide(finding("A12", "DIFFERENCE_CONFIRMED"), sale(100n), policy).verdict, "REFUND");
});

test("no difference rejects; A10 puts liability on the principal", () => {
  const a10 = decide(finding("A10", "NO_DIFFERENCE_FOUND"), sale(), policy);
  assert.equal(a10.verdict, "REJECT");
  assert.equal(a10.liable, "PRINCIPAL");
  assert.equal(a10.refund, 0n);
  const a12 = decide(finding("A12", "NO_DIFFERENCE_FOUND"), sale(), policy);
  assert.equal(a12.verdict, "REJECT");
  assert.equal(a12.liable, "NONE");
  assert.equal(a12.decidedBy, "code");
});

test("unchecked without judgment escalates, never rejects", () => {
  for (const code of ["A10", "A12", "A13.1", "A13.3", "A14"] as const) {
    const r = decide(finding(code, "COULD_NOT_BE_CHECKED", "why"), sale(), policy);
    assert.equal(r.verdict, "ESCALATE");
    assert.equal(r.refund, 0n);
  }
});

test("A13.3 judgment: confident upheld refunds", () => {
  const r = decide(finding("A13.3", "COULD_NOT_BE_CHECKED"), sale(), policy, judg({ confidence: 0.8 }));
  assert.equal(r.verdict, "REFUND");
  assert.equal(r.liable, "SELLER");
  assert.equal(r.refund, 40n);
  assert.equal(r.decidedBy, "model");
  assert.deepEqual(r.evidence, ["e1", "k"]);
});

test("A13.3 judgment: confident upheld above cap escalates", () => {
  const r = decide(finding("A13.3", "COULD_NOT_BE_CHECKED"), sale(500n), policy, judg());
  assert.equal(r.verdict, "ESCALATE");
  assert.equal(r.liable, "SELLER");
});

test("A13.3 judgment: confident not upheld rejects", () => {
  const r = decide(finding("A13.3", "COULD_NOT_BE_CHECKED"), sale(), policy, judg({ upheld: false }));
  assert.equal(r.verdict, "REJECT");
  assert.equal(r.decidedBy, "model");
});

test("A13.3 judgment: low confidence or invalid output escalates", () => {
  const low = decide(finding("A13.3", "COULD_NOT_BE_CHECKED"), sale(), policy, judg({ confidence: 0.79 }));
  assert.equal(low.verdict, "ESCALATE");
  const bad = decide(finding("A13.3", "COULD_NOT_BE_CHECKED"), sale(), policy,
    { upheld: false, confidence: 0, rationale: "model_output_invalid", citedEvidence: [] });
  assert.equal(bad.verdict, "ESCALATE");
});

test("judgment is ignored for other codes when unchecked", () => {
  const r = decide(finding("A12", "COULD_NOT_BE_CHECKED"), sale(), policy, judg());
  assert.equal(r.verdict, "ESCALATE");
  assert.equal(r.decidedBy, "code");
});

test("model cannot override a code REJECT or REFUND", () => {
  const rejected = decide(finding("A13.3", "NO_DIFFERENCE_FOUND"), sale(), policy, judg({ upheld: true }));
  assert.equal(rejected.verdict, "REJECT");
  assert.equal(rejected.decidedBy, "code");
  const refunded = decide(finding("A13.3", "DIFFERENCE_CONFIRMED"), sale(), policy, judg({ upheld: false }));
  assert.equal(refunded.verdict, "REFUND");
  assert.equal(refunded.decidedBy, "code");
  const noSale = decide(finding("A13.3", "COULD_NOT_BE_CHECKED"), null, policy, judg());
  assert.equal(noSale.verdict, "ESCALATE");
  assert.equal(noSale.decidedBy, "code");
});

test("filing fee is refunded if any ruling is a REFUND", () => {
  const rej = decide(finding("A12", "NO_DIFFERENCE_FOUND"), sale(), policy);
  const ref = decide(finding("A12", "DIFFERENCE_CONFIRMED"), sale(), policy);
  const esc = decide(finding("A12", "COULD_NOT_BE_CHECKED"), sale(), policy);
  assert.equal(settleFilingFee([rej, ref], policy).refundFee, true);
  assert.equal(settleFilingFee([rej, esc], policy).refundFee, false);
  assert.equal(settleFilingFee([], policy).refundFee, false);
});

test("proposedRefund shows the amount for escalated approvals", () => {
  const over = decide(finding("A12", "DIFFERENCE_CONFIRMED"), sale(500n), policy);
  assert.equal(over.refund, 0n);
  assert.equal(over.proposedRefund, 500n);
  const modelOver = decide(finding("A13.3", "COULD_NOT_BE_CHECKED"), sale(500n), policy, judg());
  assert.equal(modelOver.verdict, "ESCALATE");
  assert.equal(modelOver.proposedRefund, 500n);
  const ok = decide(finding("A12", "DIFFERENCE_CONFIRMED"), sale(), policy);
  assert.equal(ok.proposedRefund, ok.refund);
  assert.equal(ok.proposedRefund, 40n);
  const others = [
    decide(finding("A12", "NO_DIFFERENCE_FOUND"), sale(), policy),
    decide(finding("A12", "COULD_NOT_BE_CHECKED"), sale(), policy),
    decide(finding("A13.3", "COULD_NOT_BE_CHECKED"), sale(), policy, judg({ confidence: 0.1 })),
    decide(finding("A13.3", "COULD_NOT_BE_CHECKED"), sale(), policy, judg({ upheld: false })),
    decide(finding("A12", "DIFFERENCE_CONFIRMED"), null, policy),
  ];
  for (const r of others) assert.equal(r.proposedRefund, 0n);
});
