import { test } from "node:test";
import assert from "node:assert/strict";
import { parseUsdz } from "@dispute-court/buyer";
import type { PayOptions } from "@dispute-court/buyer";
import { rank } from "@dispute-court/buyer";
import type { ProviderStatus } from "@dispute-court/buyer";
import { complaintFor, fileDisputes, probe, reputation, runStep } from "@dispute-court/buyer";
import type { BadDelivery, FetchLike, HttpResponse, PaidDelivery, PayCli, SourcingContext, SourcingStep } from "@dispute-court/buyer";
import { canonicalRequest, sha256Hex } from "@dispute-court/seller";

const PAY_TO_A = "0x1111111111111111111111111111111111111111";
const PAY_TO_B = "0x2222222222222222222222222222222222222222";
const PAY_TO_C = "0x3333333333333333333333333333333333333333";
const PAYER = "0x4444444444444444444444444444444444444444";

const U = (s: string) => parseUsdz(s);
const RANK_OPTS = { maxPrice: "0.05", maxLatencyMs: 2000 };

function provider(over: Partial<ProviderStatus> = {}): ProviderStatus {
  return { name: "Swift", url: "http://swift.test", price: "0.02", payTo: PAY_TO_A, latencyMs: 100, ...over };
}

// ----- rank -----

test("rank excludes slow, timed-out and over-cap providers and says why", () => {
  const providers = [
    provider({ name: "Fast", url: "http://fast.test", price: "0.02", latencyMs: 100 }),
    provider({ name: "Late", url: "http://late.test", price: "0.01", latencyMs: 2500 }),
    provider({ name: "Dead", url: "http://dead.test", price: "0.01", latencyMs: null }),
    provider({ name: "Pricey", url: "http://pricey.test", price: "0.07" }),
  ];
  const d = rank(providers, [], RANK_OPTS);
  assert.equal(d.chosen?.name, "Fast");
  assert.deepEqual(
    d.ranked.map((r) => [r.name, r.excluded ?? null]),
    [["Fast", null], ["Dead", "slow"], ["Late", "slow"], ["Pricey", "over_cap"]],
  );
  assert.equal(d.ranked.find((r) => r.name === "Dead")?.score, null);
});

test("rank excludes a provider that already failed this step", () => {
  const providers = [
    provider({ name: "Sterling", url: "http://sterling.test", price: "0.03", payTo: PAY_TO_A }),
    provider({ name: "Summit", url: "http://summit.test", price: "0.06", payTo: PAY_TO_B }),
  ];
  const d = rank(providers, [], { maxPrice: "0.07", maxLatencyMs: 2000, avoid: ["Sterling"] });
  assert.equal(d.chosen?.name, "Summit");
  assert.equal(d.ranked.find((r) => r.name === "Sterling")?.excluded, "failed_this_step");
  assert.equal(d.ranked.find((r) => r.name === "Sterling")?.score, null);
});

test("a provider that loses every dispute costs three times its sticker price", () => {
  const providers = [
    provider({ name: "Sterling", url: "http://sterling.test", price: "0.03", payTo: PAY_TO_A }),
    provider({ name: "Summit", url: "http://summit.test", price: "0.06", payTo: PAY_TO_B }),
  ];
  const d = rank(providers, [{ address: PAY_TO_A, claims: 1, upheld: 1 }], { maxPrice: "0.10", maxLatencyMs: 2000 });
  assert.equal(d.ranked.find((r) => r.name === "Sterling")?.score, U("0.09"));
  assert.equal(d.ranked.find((r) => r.name === "Summit")?.score, U("0.06"));
  assert.equal(d.chosen?.name, "Summit");
});

test("a partial loss raises the score by its loss rate", () => {
  const p = provider({ name: "Sterling", price: "0.03", payTo: PAY_TO_A });
  const d = rank([p], [{ address: PAY_TO_A, claims: 2, upheld: 1 }], { maxPrice: "0.10", maxLatencyMs: 2000 });
  assert.equal(d.ranked[0].score, U("0.06")); // 0.03 * (1 + 2 * 0.5)
});

test("reputation is matched by address, case-insensitively", () => {
  const p = provider({ name: "Sterling", price: "0.03", payTo: PAY_TO_A.toLowerCase() as `0x${string}` });
  const d = rank([p], [{ address: PAY_TO_A.toUpperCase().replace("0X", "0x"), claims: 1, upheld: 1 }], { maxPrice: "0.10", maxLatencyMs: 2000 });
  assert.equal(d.ranked[0].score, U("0.09"));
});

test("a provider with no record scores its sticker price", () => {
  const d = rank([provider({ price: "0.02" })], [], RANK_OPTS);
  assert.equal(d.ranked[0].score, U("0.02"));
});

test("equal scores break the tie by name", () => {
  const providers = [
    provider({ name: "Summit", url: "http://summit.test", price: "0.03", payTo: PAY_TO_B }),
    provider({ name: "Sterling", url: "http://sterling.test", price: "0.03", payTo: PAY_TO_A }),
  ];
  const d = rank(providers, [], RANK_OPTS);
  assert.deepEqual(d.ranked.map((r) => r.name), ["Sterling", "Summit"]);
  assert.equal(d.chosen?.name, "Sterling");
});

test("the score is exact bigint integer math, never a float", () => {
  const p = provider({ name: "Sterling", price: "0.03", payTo: PAY_TO_A });
  const d = rank([p], [{ address: PAY_TO_A, claims: 3, upheld: 1 }], { maxPrice: "1", maxLatencyMs: 2000 });
  const score = d.ranked[0].score;
  assert.equal(typeof score, "bigint");
  // 0.03 * (1000 + 2000/3) / 1000 = 0.03 * 1666 / 1000 = 0.04998 exactly.
  assert.equal(score, 49_980_000_000_000_000n);
});

test("no providers means no choice", () => {
  const d = rank([], [{ address: PAY_TO_A, claims: 1, upheld: 1 }], RANK_OPTS);
  assert.equal(d.chosen, null);
  assert.deepEqual(d.ranked, []);
});

// ----- runStep -----

const TEXT = "Q3 revenue memo";
const STEP: SourcingStep = { index: 3, label: "summary of 'Q3 revenue memo'", text: TEXT };
const resourceFor = (text: string) => canonicalRequest("GET", "/infer", { task: "summary-v1", text });
const validBody = (text = TEXT) => JSON.stringify({
  task: "summary-v1", requestHash: sha256Hex(resourceFor(text)), summary: "Revenue rose.", keywords: ["revenue"],
});
const brokenBody = (text = TEXT) => validBody(text).slice(0, 24);

function json(value: unknown, ok = true, status = 200): HttpResponse {
  return { ok, status, json: async () => value };
}

/** Serves /status for the given providers and an empty /reputation. */
function marketFetch(providers: ProviderStatus[]): FetchLike {
  return async (url) => {
    if (url.endsWith("/reputation")) return json([]);
    const p = providers.find((x) => url === `${x.url}/status`);
    if (p === undefined) return json({ error: "not found" }, false, 404);
    return json({ name: p.name, model: "claude-haiku-5-5", price: p.price, payTo: p.payTo });
  };
}

function fakeCli(respond: (url: string) => PaidDelivery): { calls: { url: string; cred: string; opts?: PayOptions }[]; cli: PayCli } {
  const calls: { url: string; cred: string; opts?: PayOptions }[] = [];
  const cli: PayCli = {
    pay: async (url, cred, opts) => {
      calls.push({ url, cred, ...(opts === undefined ? {} : { opts }) });
      return respond(url);
    },
  };
  return { calls, cli };
}

function context(providers: ProviderStatus[], cli: PayCli): SourcingContext {
  return {
    providers: providers.map((p) => p.url),
    courtUrl: "http://court.test",
    cred: "cred.json",
    payer: PAYER,
    cli,
    maxPrice: "0.07",
    maxLatencyMs: 2000,
    probeTimeoutMs: 2000,
    fetch: marketFetch(providers),
    now: () => 0,
  };
}

const twoProviders = () => [
  provider({ name: "Swift", url: "http://swift.test", price: "0.02", payTo: PAY_TO_A }),
  provider({ name: "Summit", url: "http://summit.test", price: "0.06", payTo: PAY_TO_B }),
];

test("runStep pays the cheapest provider and accepts a conforming delivery", async () => {
  const providers = twoProviders();
  const { calls, cli } = fakeCli((url) => ({
    status: "paid", transaction: url.includes("swift") ? "0xaaa" : "0xbbb", body: validBody(),
  }));
  const r = await runStep(STEP, context(providers, cli));
  assert.equal(r.ok, true);
  assert.equal(r.provider, "Swift");
  assert.equal(r.tx, "0xaaa");
  assert.equal(r.body, validBody());
  assert.equal(r.attempts.length, 1);
  assert.deepEqual(r.badDeliveries, []);
  assert.equal(calls.length, 1);
  assert.match(calls[0].url, /^http:\/\/swift\.test\/infer\?task=summary-v1&text=/);
  assert.equal(calls[0].cred, "cred.json");
});

test("runStep reroutes once when the paid delivery is broken", async () => {
  const providers = twoProviders();
  const { calls, cli } = fakeCli((url) => (url.includes("swift")
    ? { status: "paid", transaction: "0xaaa", body: brokenBody() }
    : { status: "paid", transaction: "0xbbb", body: validBody() }));
  const r = await runStep(STEP, context(providers, cli));
  assert.equal(r.ok, true);
  assert.equal(r.provider, "Summit");
  assert.equal(r.tx, "0xbbb");
  assert.equal(calls.length, 2);
  assert.equal(r.attempts[0].violation, "body_unparseable");
  assert.equal(r.attempts[0].tx, "0xaaa");
  assert.equal(r.attempts[1].ok, true);
  assert.deepEqual(r.badDeliveries, [
    { step: 3, label: "summary of 'Q3 revenue memo'", provider: "Swift", seller: PAY_TO_A, tx: "0xaaa", violation: "body_unparseable" },
  ]);
});

test("runStep fails when every provider delivers a broken body", async () => {
  const providers = twoProviders();
  const { calls, cli } = fakeCli(() => ({ status: "paid", transaction: "0xbbb", body: brokenBody() }));
  const r = await runStep(STEP, context(providers, cli));
  assert.equal(r.ok, false);
  assert.equal(r.body, null);
  assert.equal(r.provider, "Summit");
  assert.equal(r.tx, "0xbbb");
  assert.equal(r.attempts.length, 2);
  assert.equal(r.badDeliveries.length, 2);
  assert.equal(calls.length, 2);
});

test("runStep treats a refusal as no payment and reroutes", async () => {
  const providers = twoProviders();
  const { calls, cli } = fakeCli((url) => (url.includes("swift")
    ? { status: "refused", refusalCode: "mandate_cap_exceeded" }
    : { status: "paid", transaction: "0xbbb", body: validBody() }));
  const r = await runStep(STEP, context(providers, cli));
  assert.equal(r.ok, true);
  assert.equal(r.provider, "Summit");
  assert.deepEqual(r.attempts[0], { provider: "Swift", tx: null, ok: false, refused: "mandate_cap_exceeded" });
  assert.deepEqual(r.badDeliveries, []); // no money moved, so it is not a bad delivery
  assert.equal(calls.length, 2);
});

test("runStep pays at most three times even with four providers", async () => {
  const providers = [
    provider({ name: "A", url: "http://a.test", price: "0.01", payTo: PAY_TO_A }),
    provider({ name: "B", url: "http://b.test", price: "0.02", payTo: PAY_TO_B }),
    provider({ name: "C", url: "http://c.test", price: "0.03", payTo: PAY_TO_C }),
    provider({ name: "D", url: "http://d.test", price: "0.04", payTo: PAY_TO_A }),
  ];
  const { calls, cli } = fakeCli((url) => ({ status: "paid", transaction: `0x${url.length}`, body: brokenBody() }));
  const r = await runStep(STEP, context(providers, cli));
  assert.equal(r.ok, false);
  assert.equal(calls.length, 3);
  assert.equal(r.attempts.length, 3);
  assert.equal(r.badDeliveries.length, 3);
});

// ----- probe -----

test("probe measures latency and records a timeout as null", async () => {
  const fast: FetchLike = async () => json({ name: "Swift", model: "m", price: "0.02", payTo: PAY_TO_A });
  let clock = 0;
  const [ok] = await probe(["http://swift.test"], 1000, { fetch: fast, now: () => (clock += 7) });
  assert.equal(ok.name, "Swift");
  assert.equal(ok.url, "http://swift.test");
  assert.equal(ok.latencyMs, 7);
  assert.equal(ok.model, "m");

  const hanging: FetchLike = (_url, init) => new Promise((_resolve, reject) => {
    init?.signal?.addEventListener("abort", () => reject(new Error("aborted")));
  });
  const [slow] = await probe(["http://slow.test"], 10, { fetch: hanging, now: () => 0 });
  assert.equal(slow.latencyMs, null);
  assert.equal(slow.name, "http://slow.test");
});

test("probe keeps a provider whose /status is unreadable, with null latency", async () => {
  const bad: FetchLike = async () => json({ name: "Broken" });
  const [p] = await probe(["http://broken.test"], 1000, { fetch: bad, now: () => 0 });
  assert.equal(p.latencyMs, null);
});

// ----- reputation -----

test("reputation returns [] on any error and keeps valid rows", async () => {
  const failing: FetchLike = async () => { throw new Error("ECONNREFUSED"); };
  assert.deepEqual(await reputation("http://court.test", failing), []);

  const notAList: FetchLike = async () => json({ rows: [] });
  assert.deepEqual(await reputation("http://court.test", notAList), []);

  const list: FetchLike = async () => json([
    { name: "Sterling", address: PAY_TO_A, cases: 1, claims: 2, upheld: 1, refunded: "0.03" },
    { name: "Broken", address: "not-an-address", claims: 1, upheld: 1 },
  ]);
  assert.deepEqual(await reputation("http://court.test", list), [{ address: PAY_TO_A, claims: 2, upheld: 1 }]);
});

// ----- fileDisputes -----

test("fileDisputes groups by provider and writes one deterministic complaint per provider", async () => {
  const deliveries: BadDelivery[] = [
    { step: 3, label: "summary of 'Q3 revenue memo'", provider: "Sterling", seller: PAY_TO_A, tx: "0xabc1234567890", violation: "body_unparseable" },
    { step: 4, label: "summary of 'policy update'", provider: "Sterling", seller: PAY_TO_A, tx: "0xdef1234567890", violation: "empty_summary" },
    { step: 5, label: "summary of 'incident report'", provider: "Summit", seller: PAY_TO_B, tx: "0x9876543210fed", violation: "wrong_request" },
  ];
  let n = 0;
  const { calls, cli } = fakeCli(() => ({ status: "paid", transaction: "0xfee", body: JSON.stringify({ caseId: `case-${++n}` }) }));

  const filed = await fileDisputes(deliveries, { courtUrl: "http://court.test/", cred: "cred.json", payer: PAYER, cli });

  assert.equal(calls.length, 2);
  assert.equal(calls[0].url, "http://court.test/disputes");
  assert.equal(calls[0].opts?.method, "POST");
  const body = JSON.parse(calls[0].opts?.body ?? "") as { complaint: string; payer: string; txs: string[]; seller: string };
  assert.equal(body.payer, PAYER);
  assert.equal(body.seller, PAY_TO_A);
  assert.deepEqual(body.txs, ["0xabc1234567890", "0xdef1234567890"]);
  assert.equal(body.complaint, [
    "Step 3 (summary of 'Q3 revenue memo') from Sterling, tx 0xabc12345…: the delivered output failed the signed summary-v1 standard (body_unparseable).",
    "Step 4 (summary of 'policy update') from Sterling, tx 0xdef12345…: the delivered output failed the signed summary-v1 standard (empty_summary).",
  ].join("\n"));

  assert.deepEqual(filed.map((f) => [f.provider, f.caseId, f.feeTx]), [["Sterling", "case-1", "0xfee"], ["Summit", "case-2", "0xfee"]]);
  assert.deepEqual(filed[1].txs, ["0x9876543210fed"]);
});

test("complaintFor names the step, the provider, the tx and the violation", () => {
  const d: BadDelivery = {
    step: 3, label: "summary of 'Q3 revenue memo'", provider: "Sterling", seller: PAY_TO_A,
    tx: "0xabc1234567890", violation: "body_unparseable",
  };
  assert.equal(
    complaintFor([d]),
    "Step 3 (summary of 'Q3 revenue memo') from Sterling, tx 0xabc12345…: the delivered output failed the signed summary-v1 standard (body_unparseable).",
  );
});

test("fileDisputes refuses to pretend a failed filing worked", async () => {
  const { cli } = fakeCli(() => ({ status: "refused", refusalCode: "mandate_budget_exceeded" }));
  const d: BadDelivery = { step: 1, label: "summary of 'x'", provider: "Sterling", seller: PAY_TO_A, tx: "0xabc", violation: "body_unparseable" };
  await assert.rejects(fileDisputes([d], { courtUrl: "http://court.test", cred: "cred.json", payer: PAYER, cli }), /mandate_budget_exceeded/);
});
