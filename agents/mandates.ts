// Pure planning for the upstream price jump. All amounts are bigint base units (18 decimals).

export const CENT = 10n ** 16n;
const MARGIN = CENT; // minimum margin per sale: 0.01

export type AgentState = { spent: bigint; budget: bigint; cap: bigint };
export type LimitState = { sourcing: AgentState; support: AgentState; treasury: AgentState };
export type Limit = { budget: bigint; cap: bigint };
export type LimitPlan = {
  proposal: { sourcing: Limit; support: Limit; treasury: Limit };
  salePrice: bigint;
  rationale: string[];
};

const ceilCent = (x: bigint): bigint => ((x + CENT - 1n) / CENT) * CENT;
const fmt = (x: bigint): string => {
  const cents = x / CENT;
  return `${cents / 100n}.${String(cents % 100n).padStart(2, "0")}`;
};

export function planLimits(
  state: LimitState,
  upstreamPrice: bigint,
  salePrice: bigint,
  total: bigint,
): LimitPlan | { error: string } {
  const names = ["sourcing", "support", "treasury"] as const;
  const rationale: string[] = [];

  // Sale price: keep a 0.01 margin over the upstream cost.
  let newSale = ceilCent(salePrice);
  if (salePrice - upstreamPrice < MARGIN) {
    newSale = ceilCent(upstreamPrice) + MARGIN;
    rationale.push(`margin under 0.01, sale price ${fmt(salePrice)} -> ${fmt(newSale)}`);
  }

  // Sourcing cap must cover one upstream purchase; never lowered.
  const sourcingCap = ceilCent(upstreamPrice) > state.sourcing.cap ? ceilCent(upstreamPrice) : state.sourcing.cap;
  if (sourcingCap !== state.sourcing.cap) rationale.push(`sourcing cap ${fmt(state.sourcing.cap)} -> ${fmt(sourcingCap)}`);

  // Smallest legal budget per agent: strictly above spent (a replacement carries spend), whole cents.
  // Sourcing must also afford one purchase at its cap.
  const floor: Record<string, bigint> = {};
  for (const n of names) floor[n] = ceilCent(state[n].spent) + CENT;
  if (floor.sourcing < sourcingCap) floor.sourcing = sourcingCap;
  const floorSum = floor.sourcing + floor.support + floor.treasury;
  if (floorSum > total) {
    return { error: `minimum budgets ${fmt(floorSum)} exceed the ${fmt(total)} total` };
  }

  // Start from current budgets (whole cents), lift to the floor, then trim the largest slack to fit.
  const budget: Record<string, bigint> = {};
  for (const n of names) {
    const b = ceilCent(state[n].budget);
    budget[n] = b < floor[n] ? floor[n] : b;
  }
  let sum = budget.sourcing + budget.support + budget.treasury;
  while (sum > total) {
    const slack = (n: string) => budget[n] - floor[n];
    const pick = names.reduce((a, b) => (slack(b) > slack(a) ? b : a));
    const cut = sum - total < slack(pick) ? sum - total : slack(pick);
    budget[pick] -= cut;
    sum -= cut;
  }
  for (const n of names) {
    if (budget[n] !== state[n].budget) rationale.push(`${n} budget ${fmt(state[n].budget)} -> ${fmt(budget[n])} (spent ${fmt(state[n].spent)} carries over)`);
  }
  rationale.push(`budgets total ${fmt(sum)} of ${fmt(total)}`);

  const capOf = (n: typeof names[number]) => {
    const c = n === "sourcing" ? sourcingCap : ceilCent(state[n].cap);
    return c > budget[n] ? budget[n] : c;
  };
  return {
    proposal: {
      sourcing: { budget: budget.sourcing, cap: capOf("sourcing") },
      support: { budget: budget.support, cap: capOf("support") },
      treasury: { budget: budget.treasury, cap: capOf("treasury") },
    },
    salePrice: newSale,
    rationale,
  };
}
