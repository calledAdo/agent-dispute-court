import type { Finding, ReasonCode, Sale } from "../shared/types.ts";
import type { Judgment } from "./judge.ts";

export type Verdict = "REFUND" | "REJECT" | "ESCALATE";
export type Liable = "SELLER" | "PRINCIPAL" | "NONE";

export interface Ruling {
  claimId: string;
  tx: string;
  code: ReasonCode;
  verdict: Verdict;
  liable: Liable;
  refund: bigint;
  /** What would be paid if approved: sale.amount for a confirmed-but-escalated claim, else refund. */
  proposedRefund: bigint;
  reason: string;
  evidence: string[];
  decidedBy: "code" | "model" | "human";
}

export interface Policy {
  autoRefundMax: bigint;
  escalateAbove: bigint;
  filingFee: bigint;
}

export const MODEL_CONFIDENCE_MIN = 0.8;

// Claim carries the tx, but Finding does not; the sale supplies it.
// With no sale we have no tx, so the ruling uses an empty string.
function base(f: Finding, sale: Sale | null) {
  return {
    claimId: f.claimId,
    tx: sale?.tx ?? "",
    code: f.code,
    evidence: [...f.evidence],
  };
}

/** A confirmed seller-side fault: refund, unless the amount is too big to pay out automatically. */
function refundOrEscalate(
  f: Finding,
  sale: Sale,
  policy: Policy,
  decidedBy: "code" | "model",
  reason: string,
  evidence: string[],
): Ruling {
  const over = sale.amount > policy.escalateAbove;
  return {
    ...base(f, sale),
    evidence,
    verdict: over ? "ESCALATE" : "REFUND",
    liable: "SELLER",
    refund: over ? 0n : sale.amount,
    proposedRefund: sale.amount,
    reason: over ? `${reason}; amount_above_escalation_limit` : reason,
    decidedBy,
  };
}

export function decide(
  f: Finding,
  sale: Sale | null,
  policy: Policy,
  judgment?: Judgment,
): Ruling {
  if (sale === null) {
    return {
      ...base(f, null),
      verdict: "ESCALATE",
      liable: "NONE",
      refund: 0n,
      proposedRefund: 0n,
      reason: "sale_not_found",
      decidedBy: "code",
    };
  }

  if (f.state === "DIFFERENCE_CONFIRMED") {
    return refundOrEscalate(f, sale, policy, "code", f.reason || "difference_confirmed", base(f, sale).evidence);
  }

  if (f.state === "NO_DIFFERENCE_FOUND") {
    return {
      ...base(f, sale),
      verdict: "REJECT",
      // A10: the customer's own agent signed the order.
      liable: f.code === "A10" ? "PRINCIPAL" : "NONE",
      refund: 0n,
      proposedRefund: 0n,
      reason: f.reason || "no_difference_found",
      decidedBy: "code",
    };
  }

  // COULD_NOT_BE_CHECKED: only A13.3 may be settled by the model.
  if (f.code === "A13.3" && judgment !== undefined) {
    return decideFromJudgment(f, sale, policy, judgment);
  }
  return {
    ...base(f, sale),
    verdict: "ESCALATE",
    liable: "NONE",
    refund: 0n,
    proposedRefund: 0n,
    reason: f.reason || "could_not_be_checked",
    decidedBy: "code",
  };
}

function decideFromJudgment(f: Finding, sale: Sale, policy: Policy, j: Judgment): Ruling {
  const evidence = [...f.evidence, ...j.citedEvidence.filter((e) => !f.evidence.includes(e))];
  const confident = j.confidence >= MODEL_CONFIDENCE_MIN;
  if (confident && j.upheld) {
    return refundOrEscalate(f, sale, policy, "model", j.rationale, evidence);
  }
  if (confident) {
    return {
      ...base(f, sale),
      evidence,
      verdict: "REJECT",
      liable: "NONE",
      refund: 0n,
      proposedRefund: 0n,
      reason: j.rationale,
      decidedBy: "model",
    };
  }
  return {
    ...base(f, sale),
    evidence,
    verdict: "ESCALATE",
    liable: "NONE",
    refund: 0n,
    proposedRefund: 0n,
    reason: `low_model_confidence: ${j.rationale}`,
    decidedBy: "model",
  };
}

/** The filing fee comes back if the customer won at least one claim. */
export function settleFilingFee(rulings: Ruling[], _policy: Policy): { refundFee: boolean } {
  return { refundFee: rulings.some((r) => r.verdict === "REFUND") };
}

