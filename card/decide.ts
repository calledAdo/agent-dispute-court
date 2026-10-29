// Kit 4 evidence-versus-cost decision for card chargebacks. Pure and deterministic.
// Amounts are major units (numbers), matching Airwallex's card API.

export type CardEvidence = {
  deviceMatchesPriorOrders?: boolean;
  priorUndisputedOrders?: number;
  deliverySigned?: boolean;
  deliveryScanned?: boolean;
  customerContactedSupport?: number;
  supportReplied?: boolean;
};

export type CardDispute = {
  amount: number;
  currency: string;
  reasonCode: string;
  evidence: CardEvidence;
};

export type CardPolicy = { disputeFee: number; minWinProbability: number };

// expectedValue is the gain from challenging instead of accepting:
//   EV(challenge) = -(1 - p) * amount - disputeFee   (the fee is paid either way)
//   EV(accept)    = -amount
//   expectedValue = EV(challenge) - EV(accept) = p * amount - disputeFee
export type CardDecision = {
  action: "CHALLENGE" | "ACCEPT" | "ESCALATE";
  winProbability: number;
  expectedValue: number;
  reason: string;
};

// Default fee, since the sandbox charges none (Kit 4 notes).
export const DEFAULT_DISPUTE_FEE = 15;

// Win probability table (judgement values, not Airwallex data). Each row is a
// base plus additive bumps, capped at 0.9.
//   10.4 fraud:          base 0.25, +0.20 device match, +0.15 if >= 3 prior
//                        undisputed orders, +0.25 signed delivery
//   13.1 not received:   base 0.20, +0.55 signed delivery, +0.10 scan
//                        (scan is weak proof, so only a small bump)
//   13.6 credit not      base 0.30, +0.00 (decided by the escalate rule below)
//        processed:
//   anything else:       base 0.10
const CAP = 0.9;
const PRIOR_ORDERS_THRESHOLD = 3;

function round4(n: number): number {
  return Math.round(n * 10_000) / 10_000;
}

export function winProbability(reasonCode: string, e: CardEvidence): number {
  let p: number;
  switch (reasonCode) {
    case "10.4":
      p = 0.25;
      if (e.deviceMatchesPriorOrders === true) p += 0.2;
      if ((e.priorUndisputedOrders ?? 0) >= PRIOR_ORDERS_THRESHOLD) p += 0.15;
      if (e.deliverySigned === true) p += 0.25;
      break;
    case "13.1":
      p = 0.2;
      if (e.deliverySigned === true) p += 0.55;
      if (e.deliveryScanned === true) p += 0.1;
      break;
    case "13.6":
      p = 0.3;
      break;
    default:
      p = 0.1;
  }
  return round4(Math.min(p, CAP));
}

// 13.6: the customer asked for a credit and heard nothing. Challenging would be
// arguing against our own silence, so a human must handle it.
function unansweredSupport(e: CardEvidence): boolean {
  return (e.customerContactedSupport ?? 0) > 0 && e.supportReplied !== true;
}

export function decideCard(d: CardDispute, policy: CardPolicy): CardDecision {
  const p = winProbability(d.reasonCode, d.evidence);
  const gain = round4(p * d.amount - policy.disputeFee);

  if (d.reasonCode === "13.6" && unansweredSupport(d.evidence)) {
    return {
      action: "ESCALATE",
      winProbability: p,
      expectedValue: gain,
      reason: "Customer contacted support about an unprocessed credit and got no reply; needs a human.",
    };
  }
  if (gain > 0 && p >= policy.minWinProbability) {
    return {
      action: "CHALLENGE",
      winProbability: p,
      expectedValue: gain,
      reason: `Challenging gains ${gain} over accepting and p ${p} >= ${policy.minWinProbability}.`,
    };
  }
  const why =
    p < policy.minWinProbability
      ? `win probability ${p} is below the minimum ${policy.minWinProbability}`
      : `challenging gains ${gain}, not above zero`;
  return { action: "ACCEPT", winProbability: p, expectedValue: gain, reason: `Accept: ${why}.` };
}
