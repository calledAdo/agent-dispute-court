import { test } from "node:test";
import assert from "node:assert/strict";
import { assembleSale, assembleHistory } from "../court/evidence.ts";
import type { EvidenceDeps } from "../court/evidence.ts";
import { decodeSignedOrder } from "../court/order.ts";
import { buildReceipt, sha256Hex } from "../seller/offer.ts";
import { buildTree, receiptLeaf } from "../shared/merkle.ts";

const SELLER = "0x00000000000000000000000000000000000000aa" as const;
const OTHER = "0x00000000000000000000000000000000000000bb" as const;
const PAYER = "0x00000000000000000000000000000000000000cc" as const;
const TX1 = "0x" + "11".repeat(32) as `0x${string}`;
const TX2 = "0x" + "22".repeat(32) as `0x${string}`;
const acceptance = { verifier: "quote-v1", maxStalenessMs: 60000, maxDeviationBps: 50 } as const;
const b64 = (v: unknown) => Buffer.from(JSON.stringify(v)).toString("base64url");

function signedOrder(resource: string, opts: { requestHash?: string } = {}): string {
  const jwt = [b64({ alg: "none" }), b64({ id: SELLER, amount: "50000000000000000", extra: { requestHash: opts.requestHash ?? sha256Hex(resource), acceptance } }), "sig"].join(".");
  return ["sdjwt", b64(["salt", { vct: "checkout", checkout_jwt: jwt, line_items: [{ id: resource }] }]), "kb"].join("~");
}

function record(tx: string, resource = "GET /quote?symbol=TSLA", over: Partial<Parameters<typeof buildReceipt>[0]> = {}) {
  return buildReceipt({ tx, payer: PAYER, amount: "0.05", resource, requestHash: sha256Hex(resource), status: 200, body: "{}", signedOrder: signedOrder(resource), settledAt: 1, ...over });
}

const payment = (to: string = SELLER) => ({ kind: "payment" as const, txHash: TX1, block: 77n, to, amount: 50000000000000000n, problems: [] });
const verification = (ok: boolean, payments = [payment()]) => ({ ok, steps: [], mandate: { principal: PAYER }, payments });

interface Opts { verify?: (opts: { checkoutMandate?: string }) => unknown; proves?: boolean | "throw"; batches?: EvidenceDeps["batches"]; receipts?: EvidenceDeps["receipts"] }
function makeDeps(o: Opts = {}): EvidenceDeps {
  const receipts = o.receipts ?? [record(TX1), record(TX2, "GET /quote?symbol=AAPL")];
  const calls: unknown[] = [];
  const deps = {
    publicClient: {
      getBlock: async () => ({ timestamp: 1_700_000_000n }),
      readContract: async (args: unknown) => {
        calls.push(args);
        if (o.proves === "throw") throw new Error("rpc down");
        return o.proves ?? true;
      },
    },
    verify: async (_c: unknown, opts: { checkoutMandate?: string }) => {
      const r = o.verify ? o.verify(opts) : verification(true);
      if (r instanceof Error) throw r;
      return r;
    },
    ledger: "0x00000000000000000000000000000000000000dd",
    ledgerAbi: [],
    seller: SELLER,
    receipts,
    batches: o.batches ?? [{ batch: 3n, txs: [TX1, TX2] }],
  } as unknown as EvidenceDeps;
  (deps as unknown as { calls: unknown[] }).calls = calls;
  return deps;
}

test("decodeSignedOrder reads what was signed", () => {
  const d = decodeSignedOrder(signedOrder("GET /quote?symbol=TSLA"));
  assert.deepEqual(d, { resource: "GET /quote?symbol=TSLA", requestHash: sha256Hex("GET /quote?symbol=TSLA"), acceptance, amount: "50000000000000000", payTo: SELLER });
});

test("decodeSignedOrder returns null on garbage and never throws", () => {
  for (const bad of ["", "nope", "a~!!!~b", "a~" + b64([1]) + "~", "a~" + b64(["s", {}]) + "~", null as unknown as string]) assert.equal(decodeSignedOrder(bad), null);
});

test("happy path builds a fully verified sale", async () => {
  const deps = makeDeps();
  const { sale, discrepancies, evidence } = await assembleSale(TX1, deps);
  assert.deepEqual(discrepancies, []);
  assert.ok(sale);
  assert.equal(sale.payer, PAYER);
  assert.equal(sale.payee, SELLER);
  assert.equal(sale.amount, 50000000000000000n);
  assert.equal(sale.settledAt, 1_700_000_000_000);
  assert.equal(sale.resource, "GET /quote?symbol=TSLA");
  assert.equal(sale.requestHash, sha256Hex("GET /quote?symbol=TSLA"));
  assert.deepEqual(sale.acceptance, acceptance);
  assert.equal(sale.signedOrderValid, true);
  assert.equal(sale.receipt?.anchored, true);
  assert.equal(sale.receipt?.status, 200);
  assert.equal(evidence.blockNumber, "77");
  // The proof sent to the ledger matches the tree built over the batch in order.
  const tree = buildTree([receiptLeaf(deps.receipts[0]), receiptLeaf(deps.receipts[1])]);
  const call = (deps as unknown as { calls: { functionName: string; args: unknown[] }[] }).calls[0];
  assert.equal(call.functionName, "proves");
  assert.deepEqual(call.args, [SELLER, 3n, 0n, receiptLeaf(deps.receipts[0]), tree.proof(0)]);
});

test("second leaf in the batch uses its own index and proof", async () => {
  const deps = makeDeps();
  await assembleSale(TX2, deps);
  const call = (deps as unknown as { calls: { args: unknown[] }[] }).calls[0];
  assert.equal(call.args[2], 1n);
});

test("invalid order: verify ok false gives signedOrderValid false", async () => {
  const { sale } = await assembleSale(TX1, makeDeps({ verify: () => verification(false) }));
  assert.equal(sale?.signedOrderValid, false);
});

test("verify throws with the order: signedOrderValid null, chain facts still used", async () => {
  const { sale } = await assembleSale(TX1, makeDeps({ verify: (o) => (o.checkoutMandate ? new Error("boom") : verification(true)) }));
  assert.ok(sale);
  assert.equal(sale.signedOrderValid, null);
  assert.equal(sale.amount, 50000000000000000n);
});

test("verify throws entirely: no sale, reason recorded", async () => {
  const { sale, discrepancies } = await assembleSale(TX1, makeDeps({ verify: () => new Error("boom") }));
  assert.equal(sale, null);
  assert.match(discrepancies.join(), /could not run/);
});

test("seller logged nothing but payment is on chain, buyer copy given: sale with receipt null", async () => {
  const { sale, discrepancies } = await assembleSale(TX1, makeDeps({ receipts: [] }), signedOrder("GET /quote?symbol=TSLA"));
  assert.ok(sale);
  assert.equal(sale.receipt, null);
  assert.equal(sale.resource, "GET /quote?symbol=TSLA");
  assert.equal(sale.signedOrderValid, true);
  assert.deepEqual(discrepancies, []);
});

test("no signed order from either source: chain-only sale with no_signed_order", async () => {
  const { sale, discrepancies } = await assembleSale(TX1, makeDeps({ receipts: [] }));
  assert.ok(sale);
  assert.equal(sale.payer, PAYER);
  assert.equal(sale.payee, SELLER);
  assert.equal(sale.amount, 50000000000000000n);
  assert.equal(sale.settledAt, 1_700_000_000_000);
  assert.equal(sale.signedOrderValid, null);
  assert.equal(sale.resource, "");
  assert.equal(sale.requestHash, "");
  assert.equal(sale.acceptance, null);
  assert.equal(sale.receipt, null);
  assert.ok(discrepancies.includes("no_signed_order"));
});

test("no order and no payment to the seller: sale null", async () => {
  const { sale } = await assembleSale(TX1, makeDeps({ receipts: [], verify: () => verification(true, [payment(OTHER)]) }));
  assert.equal(sale, null);
});

test("buyer copy and receipt copy differ: discrepancy, the one that verifies wins (buyer first)", async () => {
  const buyer = signedOrder("GET /quote?symbol=TSLA");
  const sellerCopy = signedOrder("GET /quote?symbol=AAPL");
  const rec = record(TX1, "GET /quote?symbol=AAPL", { signedOrder: sellerCopy });
  // both verify: buyer wins
  let r = await assembleSale(TX1, makeDeps({ receipts: [rec] }), buyer);
  assert.ok(r.discrepancies.includes("signed_order_copies_differ"));
  assert.equal(r.sale?.resource, "GET /quote?symbol=TSLA");
  // only the seller's copy verifies: it wins
  r = await assembleSale(TX1, makeDeps({ receipts: [rec], verify: (o) => verification(o.checkoutMandate === sellerCopy) }), buyer);
  assert.ok(r.discrepancies.includes("signed_order_copies_differ"));
  assert.equal(r.sale?.resource, "GET /quote?symbol=AAPL");
  assert.equal(r.sale?.signedOrderValid, true);
});

test("receipt not in any batch: anchored null", async () => {
  const { sale } = await assembleSale(TX1, makeDeps({ batches: [] }));
  assert.equal(sale?.receipt?.anchored, null);
});

test("ledger call fails: anchored null; ledger says false: anchored false", async () => {
  assert.equal((await assembleSale(TX1, makeDeps({ proves: "throw" }))).sale?.receipt?.anchored, null);
  assert.equal((await assembleSale(TX1, makeDeps({ proves: false }))).sale?.receipt?.anchored, false);
});

test("receipt disagrees with signed order: signed values win and discrepancies recorded", async () => {
  const forged = record(TX1, "GET /quote?symbol=AAPL", { signedOrder: signedOrder("GET /quote?symbol=TSLA") });
  const { sale, discrepancies } = await assembleSale(TX1, makeDeps({ receipts: [forged] }));
  assert.equal(sale?.resource, "GET /quote?symbol=TSLA");
  assert.equal(sale?.requestHash, sha256Hex("GET /quote?symbol=TSLA"));
  assert.equal(discrepancies.length, 2);
  assert.match(discrepancies[0], /resource/);
  assert.match(discrepancies[1], /requestHash/);
});

test("malformed signed order: chain-only sale, malformed recorded", async () => {
  const bad = record(TX1, undefined, { signedOrder: "garbage" });
  const { sale, discrepancies } = await assembleSale(TX1, makeDeps({ receipts: [bad] }));
  assert.equal(sale?.resource, "");
  assert.equal(sale?.signedOrderValid, null);
  assert.equal(sale?.receipt?.status, 200);
  assert.match(discrepancies.join(), /malformed/);
});

test("payment to another payee: sale null", async () => {
  const { sale, discrepancies } = await assembleSale(TX1, makeDeps({ verify: () => verification(true, [payment(OTHER)]) }));
  assert.equal(sale, null);
  assert.match(discrepancies.join(), /no payment to the seller/);
});

test("assembleHistory keeps only this payer's assembled sales", async () => {
  const deps = makeDeps();
  const sales = await assembleHistory(PAYER, [TX1, TX2], deps);
  assert.equal(sales.length, 2);
  assert.equal((await assembleHistory(OTHER, [TX1], deps)).length, 0);
  const none = await assembleHistory(PAYER, [TX1], makeDeps({ receipts: [] }), { [TX1]: signedOrder("GET /quote?symbol=TSLA") });
  assert.equal(none[0].resource, "GET /quote?symbol=TSLA");
});
