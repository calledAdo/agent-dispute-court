import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { canonicalRequest, buildOffer, buildReceipt, sha256Hex } from "@dispute-court/seller";
import { ReceiptLog } from "@dispute-court/seller";

const acceptance = { verifier: "quote-v1", maxStalenessMs: 60000, maxDeviationBps: 50 } as const;

test("canonicalRequest sorts query keys", () => {
  assert.equal(canonicalRequest("GET", "/quote", { symbol: "TSLA", a: "1" }), "GET /quote?a=1&symbol=TSLA");
});
test("canonicalRequest has no ? for empty query", () => {
  assert.equal(canonicalRequest("GET", "/quote", {}), "GET /quote");
});
test("canonicalRequest keeps repeated value order", () => {
  assert.equal(canonicalRequest("GET", "/quote", { s: ["B", "A"], a: "1" }), "GET /quote?a=1&s=B&s=A");
});

test("buildOffer shapes the route config", () => {
  const resource = "GET /quote?symbol=TSLA";
  const o = buildOffer({ payTo: "0xabc", price: "0.05", resource, acceptance });
  const a = o["GET /quote"].accepts;
  assert.equal(a.scheme, "exact");
  assert.equal(a.network, "eip155:63825");
  assert.equal(a.payTo, "0xabc");
  assert.deepEqual(a.extra, { signedOffer: "required", resource, requestHash: sha256Hex(resource), acceptance });
});

test("buildReceipt adds responseHash", () => {
  const r = buildReceipt({ tx: "0x1", payer: "0xp", amount: "0.05", resource: "GET /quote", requestHash: "h", status: 200, body: "{}", signedOrder: "s", settledAt: 1 });
  assert.equal(r.responseHash, sha256Hex("{}"));
  assert.equal(r.body, "{}");
});

test("ReceiptLog appends once per tx and reads back", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "rl-"));
  const log = new ReceiptLog(path.join(dir, "d.jsonl"));
  assert.deepEqual(log.all(), []);
  const r = buildReceipt({ tx: "0x1", payer: "p", amount: "0.05", resource: "GET /quote", requestHash: "h", status: 200, body: "b", signedOrder: "s", settledAt: 1 });
  assert.equal(log.append(r), true);
  assert.equal(log.append({ ...r, body: "other" }), false);
  assert.equal(log.all().length, 1);
  assert.deepEqual(log.byTx("0x1"), r);
  assert.equal(log.byTx("0x2"), undefined);
  assert.equal(new ReceiptLog(log.path).all().length, 1);
});
