import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runCase } from "../court/case.ts";
import type { CaseDeps, CaseInput } from "../court/case.ts";
import { createCaseStore } from "../court/store.ts";
import type { EvidenceDeps } from "../court/evidence.ts";
import { INTAKE_SYSTEM_PROMPT } from "../court/judge.ts";
import { buildReceipt, sha256Hex } from "../seller/offer.ts";

const SELLER = "0x00000000000000000000000000000000000000aa" as const;
const PAYER = "0x00000000000000000000000000000000000000cc" as const;
const TX1 = ("0x" + "11".repeat(32)) as `0x${string}`;
const TX2 = ("0x" + "22".repeat(32)) as `0x${string}`;
const AMOUNT = 50000000000000000n;
const SETTLED_MS = 1_700_000_000_000;
const acceptance = { verifier: "quote-v1", maxStalenessMs: 60000, maxDeviationBps: 50 } as const;
const b64 = (v: unknown) => Buffer.from(JSON.stringify(v)).toString("base64url");

function signedOrder(resource: string): string {
  const jwt = [b64({ alg: "none" }), b64({ id: SELLER, amount: String(AMOUNT), extra: { requestHash: sha256Hex(resource), acceptance } }), "sig"].join(".");
  return ["sdjwt", b64(["salt", { vct: "checkout", checkout_jwt: jwt, line_items: [{ id: resource }] }]), "kb"].join("~");
}

const quote = (price: number) => JSON.stringify({ symbol: "TSLA", price, asOf: new Date(SETTLED_MS - 1000).toISOString() });
function record(tx: string, body: string) {
  const resource = "GET /quote?symbol=TSLA";
  return buildReceipt({ tx, payer: PAYER, amount: "0.05", resource, requestHash: sha256Hex(resource), status: 200, body, signedOrder: signedOrder(resource), settledAt: 1 });
}

function evidenceDeps(bodies: Record<string, string>, principal: string = PAYER): EvidenceDeps {
  return {
    publicClient: { getBlock: async () => ({ timestamp: BigInt(SETTLED_MS / 1000) }), readContract: async () => true },
    verify: async () => ({ ok: true, steps: [], mandate: { principal }, payments: [{ kind: "payment", txHash: TX1, block: 77n, to: SELLER, amount: AMOUNT, problems: [] }] }),
    ledger: "0x00000000000000000000000000000000000000dd",
    ledgerAbi: [],
    seller: SELLER,
    receipts: Object.entries(bodies).map(([tx, body]) => record(tx, body)),
    batches: [],
  } as unknown as EvidenceDeps;
}

const policy = { autoRefundMax: 100000000000000000n, escalateAbove: 1000000000000000000n, filingFee: 1000n };
const textReply = (v: unknown) => ({ content: [{ type: "text", text: JSON.stringify(v) }] });

function stubModel(intakeClaims: unknown[], judgment: unknown) {
  const calls: string[] = [];
  const prompts: string[] = [];
  const client = {
    messages: {
      create: async (args: { system: string; messages: { content: string }[] }) => {
        prompts.push(args.messages[0].content);
        const isIntake = args.system === INTAKE_SYSTEM_PROMPT;
        calls.push(isIntake ? "intake" : "judge");
        return textReply(isIntake ? { claims: intakeClaims } : judgment);
      },
    },
  };
  return { calls, prompts, model: { client, name: "stub-model" } };
}

function makeDeps(over: Partial<CaseDeps> & { bodies: Record<string, string> }): CaseDeps {
  const { bodies, ...rest } = over;
  return {
    evidence: evidenceDeps(bodies),
    model: null,
    policy,
    reference: async (symbol, at) => ({ symbol, price: 100, at }),
    priceList: { "GET /quote": AMOUNT },
    duplicateWindowMs: 60_000,
    now: () => SETTLED_MS,
    ...rest,
  };
}

const input = (txs: `0x${string}`[]): CaseInput => ({ id: "case-1", complaint: "bad quotes", payer: PAYER, txs });

test("full case with a stubbed model: code decides A14, model settles unchecked A13.3", async () => {
  const { calls, model } = stubModel(
    [{ tx: TX1, code: "A14" }, { tx: TX2, code: "A13.3" }],
    { upheld: true, confidence: 0.95, rationale: "price looks wrong", citedEvidence: [`receipt:${TX2}`, "not-a-key"] },
  );
  const deps = makeDeps({ bodies: { [TX1]: quote(100), [TX2]: quote(100) }, model, reference: async () => null });
  const result = await runCase(input([TX1, TX2]), deps);

  assert.deepEqual(calls, ["intake", "judge"]); // judge only for the A13.3 claim that could not be checked
  assert.equal(result.findings[0].state, "NO_DIFFERENCE_FOUND");
  assert.equal(result.findings[1].state, "COULD_NOT_BE_CHECKED");
  assert.equal(result.rulings[0].verdict, "REJECT");
  assert.equal(result.rulings[0].decidedBy, "code");
  assert.equal(result.rulings[1].verdict, "REFUND");
  assert.equal(result.rulings[1].decidedBy, "model");
  assert.equal(result.rulings[1].refund, AMOUNT);
  assert.deepEqual(result.rulings[1].evidence.filter((e) => e === "not-a-key"), []);
  assert.equal(result.refundFee, true);
  assert.match(result.summary, /Total refund: 50000000000000000/);
  assert.ok(`receipt:${TX2}` in result.evidence);
});

test("no model: fallback files an A13.3 claim per tx and code alone decides", async () => {
  const deps = makeDeps({ bodies: { [TX1]: quote(110), [TX2]: quote(100) } });
  const result = await runCase(input([TX1, TX2]), deps);

  assert.deepEqual(result.claims.map((c) => [c.tx, c.code]), [[TX1, "A13.3"], [TX2, "A13.3"]]);
  assert.equal(result.findings[0].reason, "deviation_exceeds_max");
  assert.equal(result.rulings[0].verdict, "REFUND");
  assert.equal(result.rulings[1].verdict, "REJECT");
  assert.equal(result.refundFee, true);
});

test("no model and reference unavailable: escalates, never judged", async () => {
  const deps = makeDeps({ bodies: { [TX1]: quote(100) }, reference: async () => { throw new Error("feed down"); } });
  const result = await runCase(input([TX1]), deps);
  assert.equal(result.findings[0].reason, "reference_unavailable");
  assert.equal(result.rulings[0].verdict, "ESCALATE");
  assert.equal(result.refundFee, false);
});

test("a sale by another payer is not found and escalates", async () => {
  const other = "0x00000000000000000000000000000000000000ee";
  const deps = makeDeps({ bodies: { [TX1]: quote(100) }, evidence: evidenceDeps({ [TX1]: quote(100) }, other) });
  const result = await runCase(input([TX1]), deps);
  assert.equal(result.findings[0].reason, "sale_not_found");
  assert.equal(result.rulings[0].verdict, "ESCALATE");
});

test("a model that throws falls back to code-only handling", async () => {
  const client = { messages: { create: async () => { throw new Error("network"); } } };
  const deps = makeDeps({ bodies: { [TX1]: quote(110) }, model: { client, name: "m" } });
  const result = await runCase(input([TX1]), deps);
  assert.equal(result.rulings[0].verdict, "REFUND");
});

test("store round-trips bigints and keeps the latest save per id", async () => {
  const dir = mkdtempSync(join(tmpdir(), "case-store-"));
  try {
    const deps = makeDeps({ bodies: { [TX1]: quote(110) } });
    const result = await runCase(input([TX1]), deps);
    const store = createCaseStore(dir);
    assert.deepEqual(store.list(), []);
    assert.equal(store.get("case-1"), undefined);
    store.save(result);
    assert.deepEqual(store.get("case-1"), result);
    assert.equal(store.get("case-1")?.rulings[0].refund, AMOUNT);
    store.save({ ...result, summary: "updated" });
    store.save({ ...result, id: "case-2" });
    assert.equal(store.list().length, 2);
    assert.equal(store.get("case-1")?.summary, "updated");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("store keeps a string like \"42n\" as a string and bigints as bigints", () => {
  const dir = mkdtempSync(join(tmpdir(), "case-store-"));
  try {
    const store = createCaseStore(dir);
    const r = { id: "x", claims: [], findings: [], rulings: [], refundFee: false, summary: "42n", evidence: { note: "42n", n: 42n } };
    store.save(r);
    const back = store.get("x");
    assert.equal(back?.summary, "42n");
    assert.deepEqual(back?.evidence, { note: "42n", n: 42n });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("the judge receives the delivered body, status, hash and signed request", async () => {
  const { prompts, model } = stubModel([{ tx: TX1, code: "A13.3" }], { upheld: false, confidence: 0.9, rationale: "ok", citedEvidence: [] });
  const deps = makeDeps({ bodies: { [TX1]: quote(123.45) }, model, reference: async () => null });
  const result = await runCase(input([TX1]), deps);
  const judgePrompt = prompts[1];
  assert.match(judgePrompt, /"price":123\.45/);
  assert.match(judgePrompt, /"resource":"GET \/quote\?symbol=TSLA"/);
  const receipt = result.evidence[`receipt:${TX1}`] as Record<string, unknown>;
  assert.deepEqual(Object.keys(receipt).sort(), ["anchored", "body", "responseHash", "settledAt", "status"]);
  assert.equal(receipt.settledAt, new Date(SETTLED_MS).toISOString());
  assert.deepEqual((receipt.body as { price: number }).price, 123.45);
});
