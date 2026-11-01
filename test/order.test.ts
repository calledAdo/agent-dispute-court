import { test } from "node:test";
import assert from "node:assert/strict";
import { decodeSignedOrder, readAcceptance } from "../court/order.ts";
import { sha256Hex } from "../seller/offer.ts";

const SELLER = "0x00000000000000000000000000000000000000aa";
const RESOURCE = "GET /quote?symbol=TSLA";
const b64 = (v: unknown) => Buffer.from(JSON.stringify(v)).toString("base64url");

const QUOTE_ACCEPTANCE = { verifier: "quote-v1", maxStalenessMs: 60_000, maxDeviationBps: 50 };
const INFER_ACCEPTANCE = { verifier: "infer-v1", task: "summary-v1", maxChars: 400, maxKeywords: 5 };

/** A signed order whose offer carries the given acceptance and request. */
function signedOrder(acceptance: unknown, resource: string = RESOURCE): string {
  const jwt = [
    b64({ alg: "none" }),
    b64({ id: SELLER, amount: "0.05", extra: { requestHash: sha256Hex(resource), acceptance } }),
    "sig",
  ].join(".");
  return ["sdjwt", b64(["salt", { vct: "checkout", checkout_jwt: jwt, line_items: [{ id: resource }] }]), "kb"].join("~");
}

test("readAcceptance reads a quote-v1 acceptance", () => {
  assert.deepEqual(readAcceptance(QUOTE_ACCEPTANCE), QUOTE_ACCEPTANCE);
});

test("readAcceptance reads an infer-v1 acceptance", () => {
  assert.deepEqual(readAcceptance(INFER_ACCEPTANCE), INFER_ACCEPTANCE);
});

test("readAcceptance returns null for malformed acceptances", () => {
  assert.equal(readAcceptance(null), null);
  assert.equal(readAcceptance("quote-v1"), null);
  assert.equal(readAcceptance([]), null);
  assert.equal(readAcceptance({ verifier: "quote-v1", maxStalenessMs: "60000", maxDeviationBps: 50 }), null);
  assert.equal(readAcceptance({ verifier: "infer-v1", task: "summary-v1", maxChars: 0, maxKeywords: 5 }), null);
  assert.equal(readAcceptance({ verifier: "infer-v1", task: "other", maxChars: 400, maxKeywords: 5 }), null);
  assert.equal(readAcceptance({ verifier: "v2" }), null);
});

test("decodeSignedOrder carries either verifier through", () => {
  assert.deepEqual(decodeSignedOrder(signedOrder(QUOTE_ACCEPTANCE))?.acceptance, QUOTE_ACCEPTANCE);
  assert.deepEqual(decodeSignedOrder(signedOrder(INFER_ACCEPTANCE))?.acceptance, INFER_ACCEPTANCE);
});

test("decodeSignedOrder gives a null acceptance for malformed input", () => {
  assert.equal(decodeSignedOrder(signedOrder({ verifier: "quote-v1" }))?.acceptance, null);
  assert.equal(decodeSignedOrder(signedOrder(INFER_ACCEPTANCE)).acceptance !== null, true);
  assert.equal(decodeSignedOrder("not-an-order"), null);
  assert.equal(decodeSignedOrder(signedOrder(undefined))?.acceptance, null);
});
