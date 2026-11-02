import { test } from "node:test";
import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import { createCourtApp } from "@dispute-court/court";
import { formatUsdz, shortHex, relativeTime, countdown, summarize, totalRefund, feeOutcome } from "@dispute-court/court/console/format.js";

const policy = { autoRefundMax: 1n, escalateAbove: 1n, filingFee: 1n };
async function withServer(fn: (base: string) => Promise<void>) {
  const m = new Map();
  const app = createCourtApp({
    x402: null, runCase: async (i) => ({ id: i.id, claims: [], findings: [], rulings: [], refundFee: false, summary: "", evidence: {} }),
    sellers: [{ name: "DataCo", address: "0x00000000000000000000000000000000000000aa", receipts: "data/co.jsonl", priceList: { "GET /quote": "0.05" } }],
    store: { save: (r) => void m.set(r.id, r), get: (id) => m.get(id), list: () => [...m.values()] },
    remedy: { publish: async () => [], execute: async () => [] }, feeRefund: async () => ({ hash: "0x" }),
    policy, operatorToken: "t", now: () => 0,
  });
  const server = app.listen(0);
  try { await fn(`http://127.0.0.1:${(server.address() as AddressInfo).port}`); } finally { server.close(); }
}

test("console serves html without inline handlers or inline scripts", async () => {
  await withServer(async (base) => {
    const res = await fetch(`${base}/console/`);
    assert.equal(res.status, 200);
    assert.match(res.headers.get("content-type") ?? "", /text\/html/);
    assert.match(res.headers.get("content-security-policy") ?? "", /script-src 'self'/);
    const html = await res.text();
    assert.doesNotMatch(html, /\son[a-z]+\s*=/i);
    assert.doesNotMatch(html, /<script(?![^>]*\bsrc=)/i);
    assert.doesNotMatch(html, /https?:\/\//);
    for (const f of ["app.js", "styles.css", "format.js"]) assert.equal((await fetch(`${base}/console/${f}`)).status, 200);
  });
});

test("root redirects to the console", async () => {
  await withServer(async (base) => {
    const res = await fetch(`${base}/`, { redirect: "manual" });
    assert.ok(res.status === 301 || res.status === 302);
    assert.equal(res.headers.get("location"), "/console/");
  });
});

test("formatUsdz truncates to 4 decimals from 18-decimal base units", () => {
  assert.equal(formatUsdz("50000000000000000"), "0.05 *USDZ");
  assert.equal(formatUsdz("0"), "0 *USDZ");
  assert.equal(formatUsdz("1234567890000000000"), "1.2345 *USDZ");
  assert.equal(formatUsdz("10000000000000"), "<0.0001 *USDZ");
  assert.equal(formatUsdz("nope"), "n/a");
});

test("time and hash helpers", () => {
  assert.equal(shortHex("0x" + "ab".repeat(32), 6, 4), "0xabab…abab");
  assert.equal(relativeTime(0, 120_000), "2m ago");
  assert.equal(relativeTime(7_200_000, 0), "in 2h");
  assert.equal(relativeTime(1000, 1000), "just now");
  assert.equal(countdown("100", 99_000), "1s");
  assert.equal(countdown("100", 100_000), "ready now");
  assert.equal(countdown("x", 0), null);
});

test("case summaries", () => {
  const rulings = [{ verdict: "REFUND", refund: "5" }, { verdict: "REJECT", refund: "0" }, { verdict: "REFUND", refund: "7" }];
  assert.equal(totalRefund(rulings), 12n);
  assert.deepEqual(summarize({ claims: [1, 2, 3], rulings }), { claims: 3, counts: { REFUND: 2, REJECT: 1, ESCALATE: 0 }, refund: 12n });
  assert.equal(feeOutcome({ feeTx: "0x1", status: "CLOSED", feeRefundTx: "0x2", rulings }), "Refunded");
  assert.equal(feeOutcome({ feeTx: "0x1", status: "DECIDED", refundFee: false, rulings: [rulings[1]] }), "Forfeited");
});
