// Pure helpers. No DOM access, so they can be imported by tests.

export const REASONS = {
  "A10": { name: "Not authorized", visa: "10.4" },
  "A12": { name: "Duplicate", visa: "12.6.1" },
  "A13.1": { name: "Not received", visa: "13.1" },
  "A13.3": { name: "Not as described", visa: "13.3" },
  "A14": { name: "Offer drift", visa: null },
};

export const EXPLORER = "https://testnet.metalntwx.com/tx/";

/** Base units (18 decimals, decimal string or bigint) to "0.05 *USDZ", at most 4 decimals, truncated. */
export function formatUsdz(value) {
  let n;
  try { n = BigInt(value); } catch { return "n/a"; }
  const neg = n < 0n;
  if (neg) n = -n;
  const unit = 10n ** 18n;
  const whole = n / unit;
  const frac4 = ((n % unit) * 10000n) / unit;
  let frac = frac4.toString().padStart(4, "0").replace(/0+$/, "");
  const sub = n > 0n && whole === 0n && frac === "";
  const text = sub ? "<0.0001" : `${whole}${frac ? "." + frac : ""}`;
  return `${neg ? "-" : ""}${text} *USDZ`;
}

export function sumAmounts(values) {
  return values.reduce((a, v) => a + BigInt(v), 0n);
}

export function shortHex(h, head = 6, tail = 4) {
  if (typeof h !== "string" || h.length <= head + tail + 1) return h ?? "";
  return `${h.slice(0, head)}…${h.slice(-tail)}`;
}

/** Relative time: "just now", "4m ago", "in 2h". */
export function relativeTime(ms, now) {
  const diff = ms - now;
  const s = Math.round(Math.abs(diff) / 1000);
  if (s < 5) return "just now";
  let t;
  if (s < 60) t = `${s}s`;
  else if (s < 3600) t = `${Math.floor(s / 60)}m`;
  else if (s < 86400) t = `${Math.floor(s / 3600)}h`;
  else t = `${Math.floor(s / 86400)}d`;
  return diff < 0 ? `${t} ago` : `in ${t}`;
}

/** Countdown to a unix-seconds timestamp (bigint string). Returns null when unknown. */
export function countdown(executableAtSec, nowMs) {
  let at;
  try { at = Number(BigInt(executableAtSec)) * 1000; } catch { return null; }
  const s = Math.ceil((at - nowMs) / 1000);
  if (s <= 0) return "ready now";
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), r = s % 60;
  return h > 0 ? `${h}h ${m}m` : m > 0 ? `${m}m ${r}s` : `${r}s`;
}

export const explorerUrl = (hash) => `${EXPLORER}${hash}`;
export const isHash = (s) => typeof s === "string" && /^0x[0-9a-fA-F]{64}$/.test(s);

/** Total refund on a case: sum of REFUND rulings. */
export function totalRefund(rulings) {
  return sumAmounts((rulings ?? []).filter((r) => r.verdict === "REFUND").map((r) => r.refund));
}

/** The numbers shown on the docket row from a full case. */
export function summarize(c) {
  const counts = { REFUND: 0, REJECT: 0, ESCALATE: 0 };
  for (const r of c.rulings ?? []) counts[r.verdict] = (counts[r.verdict] ?? 0) + 1;
  return { claims: (c.claims ?? []).length, counts, refund: totalRefund(c.rulings) };
}

export const feeOutcome = (c) => {
  if (!c.feeTx) return "No fee recorded";
  if (c.status === "RUNNING" || c.status === "AWAITING_HUMAN") return "Pending";
  if (c.feeRefundTx) return "Refunded";
  if (c.refundFee) return "Refund due";
  return c.rulings?.length ? "Forfeited" : "Pending";
};
