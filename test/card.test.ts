import { test } from "node:test";
import assert from "node:assert/strict";
import { decideCard } from "../card/decide.ts";
import { buildEvidencePdf } from "../card/evidence-pdf.ts";
import { AirwallexClient, AirwallexError } from "../card/airwallex.ts";

const policy = { disputeFee: 15, minWinProbability: 0.4 };
const d = (reasonCode: string, amount: number, evidence = {}) => ({ amount, currency: "USD", reasonCode, evidence });

test("fraud with strong evidence and large amount: CHALLENGE", () => {
  const r = decideCard(d("10.4", 500, { deviceMatchesPriorOrders: true, priorUndisputedOrders: 3, deliverySigned: true }), policy);
  assert.equal(r.action, "CHALLENGE");
  assert.equal(r.winProbability, 0.85);
  assert.equal(r.expectedValue, 0.85 * 500 - 15); // gain over accepting
});
test("fraud with no evidence: ACCEPT (p below minimum)", () => {
  const r = decideCard(d("10.4", 500), policy);
  assert.equal(r.action, "ACCEPT");
  assert.equal(r.winProbability, 0.25);
  assert.equal(r.expectedValue, 0.25 * 500 - 15);
});
test("fraud: 2 prior orders does not count, 3 does", () => {
  assert.equal(decideCard(d("10.4", 100, { priorUndisputedOrders: 2 }), policy).winProbability, 0.25);
  assert.equal(decideCard(d("10.4", 100, { priorUndisputedOrders: 3 }), policy).winProbability, 0.4);
});
test("small not-received with only a scan: ACCEPT", () => {
  const r = decideCard(d("13.1", 20, { deliveryScanned: true }), policy);
  assert.equal(r.action, "ACCEPT");
  assert.equal(r.winProbability, 0.3);
});
test("not-received: signature matters far more than scan", () => {
  const signed = decideCard(d("13.1", 200, { deliverySigned: true }), policy).winProbability;
  const scanned = decideCard(d("13.1", 200, { deliveryScanned: true }), policy).winProbability;
  assert.ok(signed - scanned > 0.3);
});
test("credit not processed, unanswered support: ESCALATE", () => {
  const r = decideCard(d("13.6", 80, { customerContactedSupport: 2, supportReplied: false }), policy);
  assert.equal(r.action, "ESCALATE");
});
test("credit not processed, support replied: not escalated", () => {
  const r = decideCard(d("13.6", 80, { customerContactedSupport: 2, supportReplied: true }), policy);
  assert.notEqual(r.action, "ESCALATE");
});
test("credit not processed, never contacted support: not escalated", () => {
  assert.notEqual(decideCard(d("13.6", 80), policy).action, "ESCALATE");
});
test("fee above expected win: ACCEPT even with p over minimum", () => {
  const r = decideCard(d("13.1", 10, { deliverySigned: true }), { disputeFee: 15, minWinProbability: 0.4 });
  assert.equal(r.action, "ACCEPT");
  assert.equal(r.winProbability, 0.75);
  assert.equal(r.expectedValue, 0.75 * 10 - 15);
});
test("unknown reason code is conservative and deterministic", () => {
  const a = decideCard(d("99.9", 1000), policy);
  assert.deepEqual(a, decideCard(d("99.9", 1000), policy));
  assert.equal(a.action, "ACCEPT");
});

test("PDF starts with %PDF- and ends with %%EOF, xref offsets are right", () => {
  const bytes = buildEvidencePdf(["Hello (world)", "line \\ two"]);
  const s = new TextDecoder().decode(bytes);
  assert.ok(s.startsWith("%PDF-"));
  assert.ok(s.endsWith("%%EOF"));
  const xref = Number(/startxref\n(\d+)/.exec(s)![1]);
  assert.ok(s.slice(xref).startsWith("xref"));
  const offsets = [...s.matchAll(/(\d{10}) 00000 n/g)].map((m) => Number(m[1]));
  offsets.forEach((o, i) => assert.ok(s.slice(o).startsWith(`${i + 1} 0 obj`)));
  assert.ok(s.includes("(Hello \\(world\\)) Tj"));
});

type Call = { url: string; init: RequestInit };
function stub(handler: (c: Call, n: number) => Response) {
  const calls: Call[] = [];
  const fn = (async (url: string | URL | Request, init: RequestInit = {}) => {
    const c = { url: String(url), init };
    calls.push(c);
    return handler(c, calls.length);
  }) as typeof fetch;
  return { calls, fn };
}
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });
const okHandler = (c: Call) => (c.url.endsWith("/authentication/login") ? json({ token: "tok" }, 201) : json({ id: "dst_1" }));
const body = (c: Call) => JSON.parse(String(c.init.body));

test("login is cached until near expiry, then refreshed", async () => {
  let t = 0;
  const s = stub(okHandler);
  const c = new AirwallexClient({ clientId: "id", apiKey: "key", fetch: s.fn, now: () => t });
  await c.getDispute("dst_1");
  await c.getDispute("dst_1");
  assert.equal(s.calls.filter((x) => x.url.endsWith("/authentication/login")).length, 1);
  const login = s.calls[0]!;
  assert.equal(login.url, "https://api.sandbox.airwallex.com/api/v1/authentication/login");
  assert.deepEqual(login.init.headers, { "x-client-id": "id", "x-api-key": "key" });
  assert.equal(login.init.body, undefined);
  t = 30 * 60_000;
  await c.getDispute("dst_1");
  assert.equal(s.calls.filter((x) => x.url.endsWith("/authentication/login")).length, 2);
});

test("creates carry a fresh request_id, base URL and bearer", async () => {
  const s = stub(okHandler);
  const c = new AirwallexClient({ clientId: "id", apiKey: "key", fetch: s.fn });
  await c.createPaymentIntent({ amount: 12.5, currency: "USD", merchantOrderId: "o1" });
  await c.createPaymentIntent({ amount: 12.5, currency: "USD", merchantOrderId: "o1" });
  const [, a, b] = s.calls;
  assert.equal(a!.url, "https://api.sandbox.airwallex.com/api/v1/pa/payment_intents/create");
  assert.equal((a!.init.headers as Record<string, string>).Authorization, "Bearer tok");
  assert.match(body(a!).request_id, /^[0-9a-f-]{36}$/);
  assert.notEqual(body(a!).request_id, body(b!).request_id);
  assert.equal(body(a!).amount, 12.5);
  assert.equal(body(a!).merchant_order_id, "o1");
});

test("request_id is reused on 429 retry and backoff is used", async () => {
  const sleeps: number[] = [];
  let n = 0;
  const s = stub((c) => (c.url.endsWith("/login") ? json({ token: "t" }) : ++n === 1 ? json({}, 429) : json({ ok: 1 })));
  const c = new AirwallexClient({ clientId: "i", apiKey: "k", fetch: s.fn, sleep: async (ms) => void sleeps.push(ms) });
  await c.acceptDispute("dst_1");
  const posts = s.calls.filter((x) => x.url.includes("/accept"));
  assert.equal(posts.length, 2);
  assert.equal(body(posts[0]!).request_id, body(posts[1]!).request_id);
  assert.deepEqual(sleeps, [250]);
});

test("errors surface as AirwallexError", async () => {
  const s = stub((c) => (c.url.endsWith("/login") ? json({ token: "t" }) : json({ code: "bad" }, 400)));
  const c = new AirwallexClient({ clientId: "i", apiKey: "k", fetch: s.fn });
  await assert.rejects(() => c.escalate("dst_1", { dueAt: "2026-11-01T00:00:00Z" }), (e: unknown) => e instanceof AirwallexError && e.status === 400);
});

test("accept, challenge, escalate, resolve bodies and paths", async () => {
  const s = stub(okHandler);
  const c = new AirwallexClient({ clientId: "i", apiKey: "k", fetch: s.fn });
  await c.acceptDispute("dst_1", { reason: "LOW_VALUE_TRANSACTION", description: "small" });
  await c.challengeDispute("dst_1", { reason: "PURCHASE_HISTORY", productType: "DIGITAL_PRODUCT_OR_SERVICE", description: "why", fileIds: ["f1"] });
  await c.escalate("dst_1", { dueAt: "2026-11-01T00:00:00Z", comment: "no" });
  await c.resolve("dst_1", { inFavorOf: "MERCHANT" });
  const [, acc, chal, esc, res] = s.calls;
  assert.ok(acc!.url.endsWith("/pa/payment_disputes/dst_1/accept"));
  assert.deepEqual({ ...body(acc!), request_id: 0 }, { request_id: 0, reason: "LOW_VALUE_TRANSACTION", description: "small" });
  assert.ok(chal!.url.endsWith("/pa/payment_disputes/dst_1/challenge"));
  assert.deepEqual(body(chal!).supporting_documents, { documents: [{ type: "PRIMARY", description: "why", file_ids: ["f1"] }] });
  assert.equal(body(chal!).product_type, "DIGITAL_PRODUCT_OR_SERVICE");
  assert.ok(esc!.url.endsWith("/simulation/pa/payment_disputes/dst_1/escalate"));
  assert.deepEqual(body(esc!), { due_at: "2026-11-01T00:00:00Z", comment: "no" });
  assert.ok(res!.url.endsWith("/simulation/pa/payment_disputes/dst_1/resolve"));
  assert.deepEqual(body(res!), { in_favor_of: "MERCHANT" });
});

test("evidence upload goes to the files host as multipart with a PDF", async () => {
  const s = stub((c) => (c.url.endsWith("/login") ? json({ token: "t" }) : json({ file_id: "file_1" }, 201)));
  const c = new AirwallexClient({ clientId: "i", apiKey: "k", fetch: s.fn });
  const r = await c.uploadEvidencePdf(buildEvidencePdf(["x"]), "evidence.pdf");
  assert.equal(r.file_id, "file_1");
  const up = s.calls[1]!;
  assert.equal(up.url, "https://files.sandbox.airwallex.com/api/v1/files/upload");
  const form = up.init.body as FormData;
  assert.ok(form instanceof FormData);
  const file = form.get("file") as File;
  assert.equal(file.name, "evidence.pdf");
  assert.equal(file.type, "application/pdf");
});
