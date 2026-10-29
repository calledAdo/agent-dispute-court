import { test } from "node:test";
import assert from "node:assert/strict";
import { planLimits, CENT } from "../agents/mandates.ts";
import { createMetalCli, parseKeyValueLines, statusOfExit } from "../agents/cli.ts";
import { isValidPrice } from "../agents/upstream.ts";

const U = (cents: number) => BigInt(cents) * CENT;
const TOTAL = U(2000);
const state = () => ({
  sourcing: { spent: U(6), budget: U(1000), cap: U(3) },
  support: { spent: U(0), budget: U(400), cap: U(100) },
  treasury: { spent: U(0), budget: U(600), cap: U(600) },
});

test("price jump: cap raised to upstream, sum within total, spend carried", () => {
  const p = planLimits(state(), U(4), U(5), TOTAL);
  assert.ok(!("error" in p));
  assert.equal(p.proposal.sourcing.cap, U(4));
  const sum = p.proposal.sourcing.budget + p.proposal.support.budget + p.proposal.treasury.budget;
  assert.ok(sum <= TOTAL);
  assert.ok(p.proposal.sourcing.budget > U(6));
});
test("margin under 0.01 proposes a new sale price with 0.01 margin", () => {
  const p = planLimits(state(), U(4), U(4), TOTAL);
  assert.ok(!("error" in p));
  assert.equal(p.salePrice, U(5));
});
test("healthy margin keeps the sale price", () => {
  const p = planLimits(state(), U(2), U(5), TOTAL);
  assert.ok(!("error" in p));
  assert.equal(p.salePrice, U(5));
});
test("everything is whole cents", () => {
  const s = state();
  s.sourcing.spent = U(6) + 12345n;
  const p = planLimits(s, U(4) + 7n, U(5), TOTAL);
  assert.ok(!("error" in p));
  for (const a of [p.proposal.sourcing, p.proposal.support, p.proposal.treasury]) {
    assert.equal(a.budget % CENT, 0n);
    assert.equal(a.cap % CENT, 0n);
  }
  assert.ok(p.proposal.sourcing.cap >= U(4) + 7n);
});
test("over-allocated budgets are trimmed to the total", () => {
  const s = state();
  s.sourcing.budget = U(1500);
  const p = planLimits(s, U(4), U(5), TOTAL);
  assert.ok(!("error" in p));
  assert.ok(p.proposal.sourcing.budget + p.proposal.support.budget + p.proposal.treasury.budget <= TOTAL);
});
test("impossible: spend already exhausts the total", () => {
  const s = state();
  s.sourcing.spent = U(1990);
  s.support.spent = U(10);
  assert.ok("error" in planLimits(s, U(4), U(5), TOTAL));
});

test("parseKeyValueLines splits key and rest", () => {
  assert.deepEqual(parseKeyValueLines("status paid\ntx 0xabc\n\nreason over cap\nflag\n"), { status: "paid", tx: "0xabc", reason: "over cap", flag: "" });
});
test("exit codes map", () => {
  assert.deepEqual([0, 1, 3, 4, 2].map(statusOfExit), ["paid", "refused", "pending", "held", "error"]);
});
test("pull uses an args array and passes only METAL_RPC_URL", async () => {
  const calls: { file: string; args: string[]; env: Record<string, string> }[] = [];
  const cli = createMetalCli({
    rpcUrl: "http://rpc.test",
    run: async (file, args, env) => {
      calls.push({ file, args, env });
      return { exitCode: 3, stdout: "status pending\n", stderr: "" };
    },
  });
  const r = await cli.pull({ credential: "c.json", to: "0xabc", amount: "0.50", paymentId: "p1" });
  assert.equal(r.status, "pending");
  assert.deepEqual(r.fields, { status: "pending" });
  assert.equal(calls[0].file, "npx");
  assert.deepEqual(calls[0].args, ["metal-agent", "mandate", "pull", "--credential", "c.json", "--to", "0xabc", "--amount", "0.50", "--network", "testnet", "--payment-id", "p1"]);
  assert.deepEqual(calls[0].env, { METAL_RPC_URL: "http://rpc.test" });
});
test("price validation", () => {
  assert.ok(isValidPrice("0.04"));
  assert.ok(!isValidPrice("0.4"));
  assert.ok(!isValidPrice("-0.04"));
  assert.ok(!isValidPrice(0.04));
});

test("pay, replace and verify use the documented flags", async () => {
  const seen: string[][] = [];
  const cli = createMetalCli({ rpcUrl: "x", run: async (_f, args) => (seen.push(args), { exitCode: 0, stdout: "", stderr: "" }) });
  await cli.pay("http://u/raw", "new.json");
  await cli.replace({ credential: "new.json", replaces: "old.json", key: "owner.json" });
  await cli.verify({ credential: "c.json", issuer: "i.json", tx: "0x1" });
  assert.deepEqual(seen[0], ["metal-agent", "pay", "http://u/raw", "--mandate", "new.json", "--network", "testnet"]);
  assert.deepEqual(seen[1], ["metal-agent", "mandate", "replace", "--credential", "new.json", "--replaces", "old.json", "--key", "owner.json", "--network", "testnet"]);
  assert.deepEqual(seen[2], ["metal-agent", "mandate", "verify", "--credential", "c.json", "--issuer", "i.json", "--network", "testnet", "--tx", "0x1"]);
});
