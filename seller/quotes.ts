export interface Quote {
  symbol: string;
  price: number;
  asOf: string;
}

export interface Faults {
  staleSymbols?: string[];
  wrongSymbols?: string[];
}

export const STALE_BY_MS = 5 * 60_000;
export const WRONG_BY_BPS = 300; // 3%

export function makeQuote(symbol: string, now: number, upstream: (symbol: string) => number, faults: Faults = {}): Quote {
  const upstreamPrice = upstream(symbol);
  const wrong = faults.wrongSymbols?.includes(symbol) ?? false;
  const stale = faults.staleSymbols?.includes(symbol) ?? false;
  return {
    symbol,
    price: wrong ? upstreamPrice * 1.03 : upstreamPrice,
    asOf: new Date(stale ? now - STALE_BY_MS : now).toISOString(),
  };
}
