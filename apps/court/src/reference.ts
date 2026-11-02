/** `GOOG, msft` to ["GOOG","MSFT"]: symbols with no independent price feed. */
export function parseUnavailable(text: string | undefined): string[] {
  return (text ?? "").split(",").map((s) => s.trim().toUpperCase()).filter((s) => s !== "");
}

/**
 * Demo reference feed: a deterministic stand-in for an independent market price source.
 * The example DataCo seller uses the same function as its upstream, so honest quotes match it.
 * A production court replaces this with a real feed.
 */
export function defaultUpstream(symbol: string): number {
  return 100 + (symbol.charCodeAt(0) % 50) + 0.25;
}
