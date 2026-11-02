// Provider ranking for the sourcing agent. Pure logic: no I/O, no clock, no network.
// The score is money (a price in base units), so it is bigint, never a float.
import { parseUsdz } from "./cli.ts";

/** One provider as its free `/status` route reports it. latencyMs is null when the probe timed out. */
export interface ProviderStatus {
  name: string;
  url: string;
  price: string; // decimal *USDZ per request, as advertised
  payTo: `0x${string}`;
  latencyMs: number | null;
}

/** The court's record for one provider address, from GET /reputation. */
export interface Reputation {
  address: string;
  claims: number;
  upheld: number;
}

export type ExclusionReason = "slow" | "over_cap" | "failed_this_step";

export interface RankedProvider {
  name: string;
  score: bigint | null; // null when excluded
  excluded?: ExclusionReason;
}

export interface RouteDecision {
  chosen: ProviderStatus | null;
  ranked: RankedProvider[];
}

const UNIT = 1000n;
// A provider that loses every dispute costs three times its sticker price, hence the 2x loss weight on top of 1x.
const LOSS_WEIGHT = 2000n;

/**
 * Ranks providers cheapest-first by effective price: price * (1 + 2 * lossRate).
 * Excluded providers are kept in the list (score null) so the caller can say why they were skipped.
 */
export function rank(
  providers: readonly ProviderStatus[],
  rep: readonly Reputation[],
  opts: { maxPrice: string; maxLatencyMs: number; avoid?: string[] },
): RouteDecision {
  const maxPrice = parseUsdz(opts.maxPrice);
  const avoid = opts.avoid ?? [];
  const records = new Map<string, Reputation>();
  for (const r of rep) records.set(r.address.toLowerCase(), r);

  const ranked: RankedProvider[] = providers.map((p) => {
    const excluded = exclusionOf(p, maxPrice, opts.maxLatencyMs, avoid);
    if (excluded !== undefined) return { name: p.name, score: null, excluded };
    return { name: p.name, score: scoreOf(p, records.get(p.payTo.toLowerCase())) };
  });
  ranked.sort(byScoreThenName);

  const best = ranked.find((r) => r.score !== null);
  const chosen = best === undefined ? null : (providers.find((p) => p.name === best.name) ?? null);
  return { chosen, ranked };
}

function exclusionOf(p: ProviderStatus, maxPrice: bigint, maxLatencyMs: number, avoid: string[]): ExclusionReason | undefined {
  if (p.latencyMs === null || p.latencyMs > maxLatencyMs) return "slow";
  if (parseUsdz(p.price) > maxPrice) return "over_cap";
  if (avoid.includes(p.name)) return "failed_this_step";
  return undefined;
}

/** Integer math throughout: price * (1000 + 2000 * upheld / max(claims, 1)) / 1000, in base units. */
function scoreOf(p: ProviderStatus, record: Reputation | undefined): bigint {
  const claims = record?.claims ?? 0;
  const upheld = record?.upheld ?? 0;
  const factor = UNIT + (LOSS_WEIGHT * BigInt(upheld)) / BigInt(Math.max(claims, 1));
  return (parseUsdz(p.price) * factor) / UNIT;
}

/** Lowest score first; ties break by name. Excluded providers (null) come last, also by name. */
function byScoreThenName(a: RankedProvider, b: RankedProvider): number {
  if (a.score === null && b.score === null) return byName(a, b);
  if (a.score === null) return 1;
  if (b.score === null) return -1;
  if (a.score !== b.score) return a.score < b.score ? -1 : 1;
  return byName(a, b);
}

function byName(a: RankedProvider, b: RankedProvider): number {
  return a.name < b.name ? -1 : a.name > b.name ? 1 : 0;
}
