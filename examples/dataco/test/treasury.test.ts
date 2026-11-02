import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { TreasuryAirwallexClient } from "@dispute-court/example-dataco";
import { Ledger, settleEarnings, payLicenceFee } from "@dispute-court/example-dataco";

const tmpLedger = () => new Ledger(path.join(fs.mkdtempSync(path.join(os.tmpdir(), "led-")), "l.jsonl"));
const json = (b: unknown, status = 200) => new Response(JSON.stringify(b), { status });

function stubClient(eur = 0) {
  const calls: { name: string; a: any }[] = [];
  const rec = (name: string, ret: unknown) => async (a: any) => (calls.push({ name, a }), ret);
  return {
    calls,
    client: {
      getBalances: rec("balances", [{ currency: "EUR", available_amount: eur }]),
      simulateDeposit: rec("deposit", { id: "dep1" }),
      fxQuote: rec("quote", { id: "q1" }),
      fxConvert: rec("convert", { id: "c1" }),
      createTransfer: rec("transfer", { id: "t1", fee_amount: 13.47, fee_currency: "EUR", amount_payer_pays: 63.47 }),
    },
  };
}

test("settleEarnings is idempotent by tx hash and uses it as reference", async () => {
  const ledger = tmpLedger();
  const { client, calls } = stubClient();
  const base = { amountUsdz: 12_340_000_000_000_000_000n, metalTxHash: "0xABC", ledger, client, globalAccountId: "ga1" };
  const a = await settleEarnings(base);
  const b = await settleEarnings({ ...base, metalTxHash: "0xabc" });
  assert.equal(a.replayed, false);
  assert.equal(b.replayed, true);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].a.reference, "0xABC");
  assert.equal(calls[0].a.amount, 12.34);
  assert.deepEqual(b.deposit, a.deposit);
});

test("licence fee converts only the shortfall against fee + 20 buffer and records the real fee", async () => {
  const { client, calls } = stubClient(10);
  const ledger = tmpLedger();
  const r = await payLicenceFee({ eurAmount: 50, beneficiary: "ben1", invoiceId: "INV1", ledger, client });
  const names = calls.map((c) => c.name);
  assert.deepEqual(names, ["balances", "quote", "convert", "transfer"]);
  assert.equal(calls[1].a.buy_amount, 60); // 50 + 20 - 10
  assert.equal(calls[3].a.transfer_method, "SWIFT");
  assert.equal(calls[3].a.transfer_amount, 50);
  assert.equal(calls[3].a.source_currency, "EUR");
  assert.equal(r.feeAmount, 13.47);
  assert.equal(r.amountPayerPays, 63.47);
  assert.equal(ledger.get("fee:INV1").feeAmount, 13.47);
});

test("licence fee skips the conversion when the EUR balance covers it", async () => {
  const { client, calls } = stubClient(100);
  await payLicenceFee({ eurAmount: 50, beneficiary: "b", invoiceId: "INV3", ledger: tmpLedger(), client });
  assert.deepEqual(calls.map((c) => c.name), ["balances", "transfer"]);
});

test("feeBuffer is configurable", async () => {
  const { client, calls } = stubClient(0);
  await payLicenceFee({ eurAmount: 50, beneficiary: "b", invoiceId: "INV4", ledger: tmpLedger(), client, feeBufferEur: 5 });
  assert.equal(calls[1].a.buy_amount, 55);
});

test("licence fee is idempotent by invoice id", async () => {
  const ledger = tmpLedger();
  const { client, calls } = stubClient();
  await payLicenceFee({ eurAmount: 50, beneficiary: "b", invoiceId: "INV2", ledger, client });
  const again = await payLicenceFee({ eurAmount: 50, beneficiary: "b", invoiceId: "INV2", ledger, client });
  assert.equal(again.replayed, true);
  assert.equal(calls.length, 4);
});

test("FX calls carry no x-api-version; creates carry a request_id", async () => {
  const seen: { url: string; headers: Record<string, string>; body: any }[] = [];
  const f = (async (url: string, init: any) => {
    if (String(url).endsWith("/authentication/login")) return json({ token: "tok" });
    seen.push({ url: String(url), headers: init.headers, body: init.body ? JSON.parse(init.body) : undefined });
    return json({ id: "x" });
  }) as unknown as typeof fetch;
  const c = new TreasuryAirwallexClient({ clientId: "i", apiKey: "k", fetch: f });
  await c.fxQuote({ sell_currency: "USD", buy_currency: "EUR", buy_amount: 62.85 });
  await c.fxConvert({ sell_currency: "USD", buy_currency: "EUR", buy_amount: 62.85 });
  const conv = seen.find((s) => s.url.endsWith("/fx/conversions/create"));
  assert.ok(conv);
  assert.match(conv.body.request_id, /^[0-9a-f-]{36}$/);
  for (const s of seen) assert.ok(!Object.keys(s.headers).some((h) => h.toLowerCase() === "x-api-version"));
});

test("transfer body, transition key and beneficiary body match the live shapes", async () => {
  const seen: { url: string; body: any }[] = [];
  const f = (async (url: string, init: any) => {
    if (String(url).endsWith("/authentication/login")) return json({ token: "tok" });
    seen.push({ url: String(url), body: init.body ? JSON.parse(init.body) : undefined });
    return json({ id: "x" });
  }) as unknown as typeof fetch;
  const c = new TreasuryAirwallexClient({ clientId: "i", apiKey: "k", fetch: f });
  await c.createTransfer({ beneficiary_id: "b", transfer_amount: 50, transfer_currency: "EUR", transfer_method: "SWIFT", reference: "r" });
  await c.simulateTransferTransition("t1", "SENT");
  await c.createBeneficiary({ nickname: "n", transfer_methods: ["SWIFT"], beneficiary: { entity_type: "COMPANY" } });
  assert.equal(seen[0].body.reason, "professional_business_services");
  assert.equal(seen[0].body.source_currency, "EUR");
  assert.deepEqual(seen[1].body, { next_status: "SENT" });
  assert.ok(seen[2].url.endsWith("/beneficiaries/create"));
  assert.deepEqual(Object.keys(seen[2].body).sort(), ["beneficiary", "nickname", "request_id", "transfer_methods"]);
});

test("Airwallex errors carry redacted code and message", async () => {
  const f = (async (url: string) =>
    String(url).endsWith("/authentication/login")
      ? json({ token: "t" })
      : json({ code: "invalid_argument", message: `bad https://x.test/a ${"ab".repeat(20)}` }, 400)) as unknown as typeof fetch;
  const c = new TreasuryAirwallexClient({ clientId: "i", apiKey: "k", fetch: f });
  await assert.rejects(c.getTransfer("t"), (e: Error) => e.message.includes("invalid_argument") && e.message.includes("[url]") && e.message.includes("[hex]") && !e.message.includes("x.test"));
});
