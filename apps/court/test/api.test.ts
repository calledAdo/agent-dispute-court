import { test } from "node:test";
import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import { createCourtApp, sanitizeError } from "@dispute-court/court";
import type { CourtAppDeps, StoredCase } from "@dispute-court/court";
import type { CaseInput, CaseResult } from "@dispute-court/court";
import type { SellerConfig } from "@dispute-court/court";
import type { CaseStore } from "@dispute-court/court";
import type { Ruling } from "@dispute-court/court";
import type { NextFunction, Request, Response } from "express";

const PAYER = "0x1111111111111111111111111111111111111111";
const TX1 = `0x${"a1".repeat(32)}`;
const TX2 = `0x${"b2".repeat(32)}`;
const TOKEN = "op-secret";
const FEE = 10_000_000_000_000_000n;
const AMOUNT = 50_000_000_000_000_000n;
const policy = { autoRefundMax: AMOUNT, escalateAbove: AMOUNT, filingFee: FEE };

const DATA_CO: SellerConfig = { name: "DataCo", address: "0x00000000000000000000000000000000000000aa", receipts: "data/co.jsonl", priceList: { "GET /quote": "0.05" } };
const SWIFT: SellerConfig = { name: "Swift", address: "0x00000000000000000000000000000000000000bb", receipts: "data/swift.jsonl", priceList: { "GET /infer": "0.02" } };
const SELLERS = [DATA_CO, SWIFT];

const ruling = (claimId: string, tx: string, verdict: Ruling["verdict"]): Ruling => ({
  claimId, tx, code: "A13.3", verdict, liable: verdict === "REFUND" ? "SELLER" : "NONE",
  refund: verdict === "REFUND" ? AMOUNT : 0n, proposedRefund: AMOUNT, reason: "t", evidence: [tx], decidedBy: "code",
});

function memoryStore(): CaseStore {
  const m = new Map<string, CaseResult>();
  return { save: (r) => void m.set(r.id, structuredClone(r)), get: (id) => m.get(id), list: () => [...m.values()] };
}

interface Harness { base: string; close: () => Promise<void>; calls: { publish: number; execute: number; feeRefund: { payer: string; amount: bigint; caseId: string }[]; ran: number; sellers: string[]; publishedFor: string[] } }

async function start(rulings: Ruling[], over: Partial<CourtAppDeps> = {}, refundFee = true): Promise<Harness> {
  const calls: Harness["calls"] = { publish: 0, execute: 0, feeRefund: [], ran: 0, sellers: [], publishedFor: [] };
  const app = createCourtApp({
    x402: null,
    sellers: SELLERS,
    runCase: async (input: CaseInput) => {
      calls.ran++;
      calls.sellers.push(input.seller);
      return { id: input.id, claims: [], findings: [], rulings, refundFee, summary: "s", evidence: {} };
    },
    store: memoryStore(),
    remedy: {
      publish: async (rs, _payerOf, seller) => { calls.publish++; calls.publishedFor.push(seller); return rs.filter((r) => r.verdict === "REFUND").map((r) => ({ tx: r.tx, status: "published" as const, hash: "0xpub" })); },
      execute: async (txs) => { calls.execute++; return txs.map((tx) => ({ tx, status: "paid" as const, hash: "0xpaid" })); },
    },
    feeRefund: async (payer, amount, caseId) => { calls.feeRefund.push({ payer, amount, caseId }); return { hash: "0xfeerefund" }; },
    policy, operatorToken: TOKEN, now: () => 1000, ...over,
  });
  const server = await new Promise<import("node:http").Server>((resolve) => { const s = app.listen(0, "127.0.0.1", () => resolve(s)); });
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return { base, calls, close: () => new Promise((r) => server.close(() => r())) };
}

const post = (h: Harness, path: string, body: unknown, token: string | null = TOKEN) =>
  fetch(h.base + path, { method: "POST", headers: { "content-type": "application/json", ...(token ? { "x-operator-token": token } : {}) }, body: JSON.stringify(body) });
const getCase = async (h: Harness, id: string) => (await (await fetch(`${h.base}/cases/${id}`)).json()) as StoredCase;

async function file(h: Harness, body: unknown = { complaint: "bad price", payer: PAYER, txs: [TX1] }): Promise<string> {
  const res = await post(h, "/disputes", body, null);
  assert.equal(res.status, 202);
  const { caseId } = (await res.json()) as { caseId: string };
  for (let i = 0; i < 100; i++) {
    const c = await getCase(h, caseId);
    if (c.status !== "RUNNING") return caseId;
    await new Promise((r) => setTimeout(r, 5));
  }
  throw new Error("case stayed RUNNING");
}

test("health", async () => {
  const h = await start([]);
  try { assert.deepEqual(await (await fetch(h.base + "/health")).json(), { ok: true }); } finally { await h.close(); }
});

test("invalid bodies are rejected with 400 and nothing runs", async () => {
  const h = await start([]);
  try {
    const bad = [
      {}, { complaint: "", payer: PAYER, txs: [TX1] }, { complaint: "x", payer: "nope", txs: [TX1] },
      { complaint: "x", payer: PAYER, txs: [] }, { complaint: "x", payer: PAYER, txs: ["0x12"] },
      { complaint: "x", payer: PAYER, txs: [TX1, TX1.toUpperCase().replace("0X", "0x")] },
      { complaint: "x", payer: PAYER, txs: [TX1], buyerOrders: { [TX1]: 5 } }, [],
    ];
    for (const b of bad) assert.equal((await post(h, "/disputes", b, null)).status, 400, JSON.stringify(b));
    const res = await fetch(h.base + "/disputes", { method: "POST", headers: { "content-type": "application/json" }, body: "{not json" });
    assert.equal(res.status, 400);
    assert.equal(h.calls.ran, 0);
  } finally { await h.close(); }
});

test("happy path: 202 then DECIDED", async () => {
  const h = await start([ruling("claim-1", TX1, "REFUND")]);
  try {
    const id = await file(h);
    const c = await getCase(h, id);
    assert.equal(c.status, "DECIDED");
    assert.equal(c.rulings[0].refund, AMOUNT.toString() as never); // bigint travels as a decimal string
    const list = (await (await fetch(h.base + "/cases")).json()) as { id: string; status: string; counts: Record<string, number> }[];
    assert.deepEqual(list, [{ id, status: "DECIDED", counts: { REFUND: 1, REJECT: 0, ESCALATE: 0 }, seller: DATA_CO.address, sellerName: "DataCo" }]);
    assert.equal((await fetch(h.base + "/cases/nope")).status, 404);
  } finally { await h.close(); }
});

test("a failing runCase leaves the case FAILED with the error", async () => {
  const h = await start([], { runCase: async () => { throw new Error("boom"); } });
  try {
    const c = await getCase(h, await file(h));
    assert.equal(c.status, "FAILED");
    assert.equal(c.error, "Error: boom");
  } finally { await h.close(); }
});

/** Stands in for the x402 middleware: like the real one it settles (calling onAfterSettle) before the response is flushed. */
function fakeGate() {
  let hook: ((ctx: unknown) => Promise<void>) | undefined;
  const server = { onAfterSettle: (f: typeof hook) => { hook = f; }, initialize: async () => {} };
  const gate = (req: Request, res: Response, next: NextFunction) => {
    const send = res.send.bind(res);
    res.send = ((b: string) => {
      void hook!({ result: { success: true, payer: req.header("x-test-payer"), transaction: "0xfeepaid" }, transportContext: { responseBody: Buffer.from(b) } }).then(() => send(b));
      return res;
    }) as typeof res.send;
    next();
  };
  return { x402: { server: server as never, routes: {}, gate } };
}
const paidBy = (h: Harness, payer: string, body: unknown = { complaint: "x", payer: PAYER, txs: [TX1] }) =>
  fetch(h.base + "/disputes", { method: "POST", headers: { "content-type": "application/json", "x-test-payer": payer }, body: JSON.stringify(body) });

test("settled payer matching the body payer (case-insensitive) runs the case and keeps the fee tx", async () => {
  const h = await start([ruling("claim-1", TX1, "REFUND")], fakeGate());
  try {
    const { caseId } = (await (await paidBy(h, PAYER.toUpperCase().replace("0X", "0x"))).json()) as { caseId: string };
    for (let i = 0; i < 100 && (await getCase(h, caseId)).status === "RUNNING"; i++) await new Promise((r) => setTimeout(r, 5));
    const c = await getCase(h, caseId);
    assert.equal(c.status, "DECIDED");
    assert.equal(c.feeTx, "0xfeepaid");
    assert.equal(h.calls.ran, 1);
  } finally { await h.close(); }
});

test("a different settled payer gives FILER_MISMATCH and the case is not run", async () => {
  const h = await start([ruling("claim-1", TX1, "REFUND")], fakeGate());
  try {
    const res = await paidBy(h, "0x2222222222222222222222222222222222222222");
    assert.equal(res.status, 202);
    const { caseId } = (await res.json()) as { caseId: string };
    const c = await getCase(h, caseId);
    assert.equal(c.status, "FILER_MISMATCH");
    assert.equal(c.feeTx, "0xfeepaid");
    assert.equal(h.calls.ran, 0);
    // A mismatched case cannot be published.
    assert.equal((await post(h, `/cases/${caseId}/publish`, {})).status, 409);
  } finally { await h.close(); }
});

test("an invalid body is rejected before the payment gate is reached", async () => {
  let gated = 0;
  const g = fakeGate();
  const h = await start([], { x402: { ...g.x402, gate: (_q, _s, n) => { gated++; n(); } } });
  try {
    assert.equal((await paidBy(h, PAYER, { complaint: "", payer: PAYER, txs: [TX1] })).status, 400);
    assert.equal(gated, 0);
  } finally { await h.close(); }
});

const escalated = () => [ruling("claim-1", TX1, "ESCALATE")];

test("approve: no token is 401, a wrong token is 401", async () => {
  const h = await start(escalated());
  try {
    const id = await file(h);
    const body = { claimId: "claim-1", decision: "REFUND", amount: AMOUNT.toString(), approver: "ops" };
    assert.equal((await post(h, `/cases/${id}/approve`, body, null)).status, 401);
    assert.equal((await post(h, `/cases/${id}/approve`, body, "wrong")).status, 401);
    assert.equal((await post(h, `/cases/${id}/publish`, {}, null)).status, 401);
    assert.equal((await post(h, `/cases/${id}/execute`, {}, null)).status, 401);
    assert.equal((await getCase(h, id)).status, "AWAITING_HUMAN");
  } finally { await h.close(); }
});

test("approve: wrong amount is 409, the right one is 200 and records a human REFUND", async () => {
  const h = await start(escalated());
  try {
    const id = await file(h);
    const mk = (amount: string) => ({ claimId: "claim-1", decision: "REFUND", amount, approver: "ops" });
    assert.equal((await post(h, `/cases/${id}/approve`, mk((AMOUNT - 1n).toString()))).status, 409);
    assert.equal((await post(h, `/cases/${id}/approve`, mk("0"))).status, 409);
    assert.equal((await getCase(h, id)).status, "AWAITING_HUMAN");
    const ok = await post(h, `/cases/${id}/approve`, mk(AMOUNT.toString()));
    assert.equal(ok.status, 200);
    const c = (await ok.json()) as StoredCase;
    assert.equal(c.status, "DECIDED");
    assert.equal(c.rulings[0].verdict, "REFUND");
    assert.equal(c.rulings[0].decidedBy, "human");
    assert.equal(c.rulings[0].refund, AMOUNT.toString() as never);
    assert.equal(c.refundFee, true);
    assert.equal(c.approvals.length, 1);
    // Already decided: a second approval is refused.
    assert.equal((await post(h, `/cases/${id}/approve`, mk(AMOUNT.toString()))).status, 409);
  } finally { await h.close(); }
});

test("approve REJECT keeps the fee; bad bodies and unknown claims are refused", async () => {
  const h = await start(escalated(), {}, false);
  try {
    const id = await file(h);
    assert.equal((await post(h, `/cases/${id}/approve`, { claimId: "claim-1" })).status, 400);
    assert.equal((await post(h, `/cases/${id}/approve`, { claimId: "nope", decision: "REJECT", amount: AMOUNT.toString(), approver: "ops" })).status, 404);
    const c = (await (await post(h, `/cases/${id}/approve`, { claimId: "claim-1", decision: "REJECT", amount: AMOUNT.toString(), approver: "ops" })).json()) as StoredCase;
    assert.equal(c.rulings[0].verdict, "REJECT");
    assert.equal(c.rulings[0].refund, "0" as never);
    assert.equal(c.refundFee, false);
  } finally { await h.close(); }
});

test("approve is refused for a ruling that was not escalated", async () => {
  const h = await start([ruling("claim-1", TX1, "REFUND")]);
  try {
    const id = await file(h);
    assert.equal((await post(h, `/cases/${id}/approve`, { claimId: "claim-1", decision: "REFUND", amount: AMOUNT.toString(), approver: "ops" })).status, 409);
  } finally { await h.close(); }
});

test("publish is refused while a claim awaits a human, and is idempotent afterwards", async () => {
  const h = await start([ruling("claim-1", TX1, "REFUND"), ruling("claim-2", TX2, "ESCALATE")]);
  try {
    const id = await file(h, { complaint: "x", payer: PAYER, txs: [TX1, TX2] });
    assert.equal((await post(h, `/cases/${id}/publish`, {})).status, 409);
    await post(h, `/cases/${id}/approve`, { claimId: "claim-2", decision: "REJECT", amount: AMOUNT.toString(), approver: "ops" });
    const a = await post(h, `/cases/${id}/publish`, {});
    assert.equal(a.status, 200);
    assert.equal(((await a.json()) as StoredCase).status, "PUBLISHED");
    const b = await post(h, `/cases/${id}/publish`, {});
    assert.equal(b.status, 200);
    assert.equal(h.calls.publish, 1);
    assert.equal((await getCase(h, id)).publishResults?.[0].status, "published");
  } finally { await h.close(); }
});

test("execute pays due refunds, refunds the fee exactly once, and is idempotent", async () => {
  const h = await start([ruling("claim-1", TX1, "REFUND")]);
  try {
    const id = await file(h);
    assert.equal((await post(h, `/cases/${id}/execute`, {})).status, 409); // not published yet
    await post(h, `/cases/${id}/publish`, {});
    const first = (await (await post(h, `/cases/${id}/execute`, {})).json()) as StoredCase;
    assert.equal(first.status, "CLOSED");
    assert.equal(first.feeRefundTx, "0xfeerefund");
    assert.equal(first.executeResults?.[0].status, "paid");
    const second = await post(h, `/cases/${id}/execute`, {});
    assert.equal(second.status, 200);
    assert.deepEqual(h.calls.feeRefund, [{ payer: PAYER, amount: FEE, caseId: id }]);
    assert.equal(h.calls.execute, 1); // a closed case is not executed again
  } finally { await h.close(); }
});

test("concurrent executes refund the fee once", async () => {
  const h = await start([ruling("claim-1", TX1, "REFUND")], {
    feeRefund: async () => { await new Promise((r) => setTimeout(r, 30)); calls++; return { hash: "0xfee" }; },
  });
  let calls = 0;
  try {
    const id = await file(h);
    await post(h, `/cases/${id}/publish`, {});
    const rs = await Promise.all([post(h, `/cases/${id}/execute`, {}), post(h, `/cases/${id}/execute`, {})]);
    assert.deepEqual(rs.map((r) => r.status).sort(), [200, 409]);
    assert.equal(calls, 1);
  } finally { await h.close(); }
});

test("no fee refund when no claim won; a failed fee refund can be retried without double paying", async () => {
  const h = await start([ruling("claim-1", TX1, "REJECT")], {}, false);
  try {
    const id = await file(h);
    await post(h, `/cases/${id}/publish`, {});
    const c = (await (await post(h, `/cases/${id}/execute`, {})).json()) as StoredCase;
    assert.equal(c.status, "CLOSED");
    assert.equal(h.calls.feeRefund.length, 0);
  } finally { await h.close(); }

  let attempts = 0;
  const h2 = await start([ruling("claim-1", TX1, "REFUND")], {
    feeRefund: async () => { attempts++; if (attempts === 1) throw new Error("rpc down"); return { hash: "0xfee2" }; },
  });
  try {
    const id = await file(h2);
    await post(h2, `/cases/${id}/publish`, {});
    const bad = await post(h2, `/cases/${id}/execute`, {});
    assert.equal(bad.status, 502);
    assert.equal(((await bad.json()) as StoredCase).status, "PUBLISHED");
    const good = (await (await post(h2, `/cases/${id}/execute`, {})).json()) as StoredCase;
    assert.equal(good.status, "CLOSED");
    assert.equal(good.feeRefundTx, "0xfee2");
    assert.equal(attempts, 2);
  } finally { await h2.close(); }
});

const SECRET = "a1b2c3d4".repeat(8);

test("sanitizeError strips URLs and long hex tokens", () => {
  const e = new Error(`HTTP request failed. URL: https://rpc.example/v1/${SECRET} token ${SECRET} tx 0x${SECRET}\nstack`);
  const out = sanitizeError(e);
  assert.ok(!out.includes("rpc.example") && !out.includes(SECRET) && !out.includes("\n"));
  assert.match(out, /<url>/);
  assert.equal(sanitizeError(`key ${"f".repeat(40)} ok`), "key <redacted> ok");
  assert.equal(sanitizeError(new Error("short")), "Error: short");
});

test("secrets in errors never reach GET /cases/:id", async () => {
  const leak = new Error(`getLogs failed at https://rpc.example/v1/${SECRET}`);
  let n = 0;
  const h = await start([ruling("claim-1", TX1, "REFUND")], {
    runCase: async () => { throw leak; },
    feeRefund: async () => { n++; throw leak; },
    remedy: {
      publish: async (rs) => rs.map((r) => ({ tx: r.tx, status: "failed" as const, reason: `rpc https://rpc.example/v1/${SECRET}` })),
      execute: async (txs) => txs.map((tx) => ({ tx, status: "failed" as const, reason: SECRET })),
    },
  });
  try {
    const id = await file(h);
    const c = await getCase(h, id);
    assert.equal(c.status, "FAILED");
    assert.match(c.error!, /<url>/);
    // Drive the publish/execute/fee paths on a case that did run.
    const h2 = await start([ruling("claim-1", TX1, "REFUND")], {
      feeRefund: async () => { throw leak; },
      remedy: {
        publish: async (rs) => rs.map((r) => ({ tx: r.tx, status: "published" as const, hash: "0xpub", reason: `rpc https://rpc.example/v1/${SECRET}` })),
        execute: async (txs) => txs.map((tx) => ({ tx, status: "failed" as const, reason: SECRET })),
      },
    });
    try {
      const id2 = await file(h2);
      await post(h2, `/cases/${id2}/publish`, {});
      const exec = await post(h2, `/cases/${id2}/execute`, {});
      const body = await exec.text();
      const all = body + JSON.stringify(await getCase(h2, id2)) + (await (await fetch(h2.base + "/cases")).text());
      assert.ok(!all.includes("rpc.example") && !all.includes(SECRET));
      assert.match(body, /feeRefundError/);
    } finally { await h2.close(); }
    const text = await (await fetch(`${h.base}/cases/${id}`)).text();
    assert.ok(!text.includes("rpc.example") && !text.includes(SECRET));
  } finally { await h.close(); }
  void n;
});

test("the complaint is stored on the case and returned by GET /cases/:id", async () => {
  const h = await start([ruling("claim-1", TX1, "REFUND")]);
  try {
    const id = await file(h, { complaint: "price was wrong <b>x</b>", payer: PAYER, txs: [TX1] });
    const c = await (await fetch(`${h.base}/cases/${id}`)).json() as { complaint: string };
    assert.equal(c.complaint, "price was wrong <b>x</b>");
  } finally { await h.close(); }
});

// ----- multiple sellers -----

const claim = (id: string, tx: string) => ({ id, tx, code: "A13.3" as const });
const refundOf = (claimId: string, tx: string, amount: bigint): Ruling => ({ ...ruling(claimId, tx, "REFUND"), refund: amount });

const storedCase = (over: Partial<StoredCase> & { id: string }): StoredCase => ({
  claims: [], findings: [], rulings: [], refundFee: false, summary: "", evidence: {},
  status: "DECIDED", seller: DATA_CO.address, sellerName: DATA_CO.name,
  payer: PAYER, complaint: "x", txs: [TX1], feeTx: null, feeRefundTx: null, feeRefundError: null,
  approvals: [], publishResults: null, executeResults: null, error: null, createdAt: 0,
  ...over,
});

test("a dispute stores its seller; an omitted seller defaults to the first configured seller", async () => {
  const h = await start([ruling("claim-1", TX1, "REFUND")]);
  try {
    const first = await getCase(h, await file(h));
    assert.equal(first.seller, DATA_CO.address);
    assert.equal(first.sellerName, "DataCo");

    const second = await getCase(h, await file(h, { complaint: "x", payer: PAYER, txs: [TX2], seller: SWIFT.address }));
    assert.equal(second.seller, SWIFT.address);
    assert.equal(second.sellerName, "Swift");
    assert.deepEqual(h.calls.sellers, [DATA_CO.address, SWIFT.address]);

    const list = (await (await fetch(h.base + "/cases")).json()) as { id: string; seller: string; sellerName: string }[];
    const row = list.find((c) => c.id === second.id);
    assert.equal(row?.seller, SWIFT.address);
    assert.equal(row?.sellerName, "Swift");
  } finally { await h.close(); }
});

test("an unknown seller is refused with 400 and the case never runs", async () => {
  const h = await start([]);
  try {
    const res = await post(h, "/disputes", { complaint: "x", payer: PAYER, txs: [TX1], seller: "0x9999999999999999999999999999999999999999" }, null);
    assert.equal(res.status, 400);
    assert.deepEqual(await res.json(), { error: "unknown seller" });
    assert.equal(h.calls.ran, 0);
  } finally { await h.close(); }
});

test("publish rules against the case's own seller", async () => {
  const h = await start([ruling("claim-1", TX1, "REFUND")]);
  try {
    const id = await file(h, { complaint: "x", payer: PAYER, txs: [TX1], seller: SWIFT.address });
    await post(h, `/cases/${id}/publish`, {});
    assert.deepEqual(h.calls.publishedFor, [SWIFT.address]);
  } finally { await h.close(); }
});

test("GET /sellers lists the configured sellers", async () => {
  const h = await start([]);
  try {
    assert.deepEqual(await (await fetch(h.base + "/sellers")).json(), [
      { name: "DataCo", address: DATA_CO.address },
      { name: "Swift", address: SWIFT.address },
    ]);
  } finally { await h.close(); }
});

test("GET /reputation aggregates only decided-and-later cases, with exact bigint sums", async () => {
  const store = memoryStore();
  store.save(storedCase({
    id: "c1", seller: SWIFT.address, sellerName: "Swift", status: "DECIDED",
    claims: [claim("claim-1", TX1), claim("claim-2", TX2)],
    rulings: [refundOf("claim-1", TX1, 40_000_000_000_000_000n), ruling("claim-2", TX2, "REJECT")],
  }));
  store.save(storedCase({
    id: "c2", seller: SWIFT.address, sellerName: "Swift", status: "PUBLISHED",
    claims: [claim("claim-1", TX1)], rulings: [refundOf("claim-1", TX1, 10_000_000_000_000_000n)],
  }));
  // FAILED and RUNNING cases never count, whoever they name.
  store.save(storedCase({ id: "c3", seller: SWIFT.address, status: "FAILED", claims: [claim("claim-1", TX1)], rulings: [refundOf("claim-1", TX1, 99n)] }));
  store.save(storedCase({ id: "c4", seller: DATA_CO.address, status: "RUNNING", claims: [claim("claim-1", TX1)], rulings: [refundOf("claim-1", TX1, 99n)] }));
  // AWAITING_HUMAN counts, and addresses match case-insensitively.
  store.save(storedCase({
    id: "c5", seller: "0x00000000000000000000000000000000000000AA", status: "AWAITING_HUMAN",
    claims: [claim("claim-1", TX1), claim("claim-2", TX2)],
    rulings: [ruling("claim-1", TX1, "ESCALATE"), refundOf("claim-2", TX2, 0n)],
  }));
  store.save(storedCase({
    id: "c6", seller: DATA_CO.address, status: "CLOSED",
    claims: [claim("claim-1", TX1)], rulings: [refundOf("claim-1", TX1, 20_000_000_000_000_000n)],
  }));

  const h = await start([], { store });
  try {
    assert.deepEqual(await (await fetch(h.base + "/reputation")).json(), [
      { name: "DataCo", address: DATA_CO.address, cases: 2, claims: 3, upheld: 2, refunded: "0.02" },
      { name: "Swift", address: SWIFT.address, cases: 2, claims: 3, upheld: 2, refunded: "0.05" },
    ]);
  } finally { await h.close(); }
});
