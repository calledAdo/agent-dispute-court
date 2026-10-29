import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { TreasuryAirwallexClient } from "../treasury/airwallex.ts";
import { Ledger, settleEarnings, payLicenceFee } from "../treasury/settle.ts";

const tmpLedger = () => new Ledger(path.join(fs.mkdtempSync(path.join(os.tmpdir(), "led-")), "l.jsonl"));
const json = (b: unknown, status = 200) => new Response(JSON.stringify(b), { status });

function stubClient() {
  const calls: { name: string; a: any }[] = [];
  const rec = (name: string, ret: unknown) => async (a: any) => (calls.push({ name, a }), ret);
  return {
    calls,
    client: {
      simulateDeposit: rec("deposit", { id: "dep1" }),
      fxQuote: rec("quote", { id: "q1" }),
      fxConvert: rec("convert", { id: "c1" }),
      createTransfer: rec("transfer", { id: "t1" }),
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

test("licence fee quotes and converts EUR 62.85 (50 + 12.85 SWIFT), transfers 50", async () => {
  const { client, calls } = stubClient();
  const r = await payLicenceFee({ eurAmount: 50, beneficiary: "ben1", invoiceId: "INV1", ledger: tmpLedger(), client });
  assert.equal(calls[0].a.buy_amount, 62.85);
  assert.equal(calls[1].a.buy_amount, 62.85);
  assert.equal(calls[1].a.quote_id, "q1");
  assert.equal(calls[2].a.transfer_method, "SWIFT");
  assert.equal(calls[2].a.transfer_amount, 50);
  assert.equal(calls[2].a.transfer_currency, "EUR");
  assert.equal(r.transferId, "t1");
});

test("licence fee is idempotent by invoice id", async () => {
  const ledger = tmpLedger();
  const { client, calls } = stubClient();
  await payLicenceFee({ eurAmount: 50, beneficiary: "b", invoiceId: "INV2", ledger, client });
  const again = await payLicenceFee({ eurAmount: 50, beneficiary: "b", invoiceId: "INV2", ledger, client });
  assert.equal(again.replayed, true);
  assert.equal(calls.length, 3);
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
