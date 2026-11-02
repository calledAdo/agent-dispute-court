import { test } from "node:test";
import assert from "node:assert/strict";
import { createMetalCli, parseKeyValueLines, statusOfExit } from "@dispute-court/buyer";
import { parseRefusalCode, parseStatus, parseUsdz, formatUsdz } from "@dispute-court/buyer";

test("parseKeyValueLines splits key and rest", () => {
  assert.deepEqual(parseKeyValueLines("status paid\ntx 0xabc\n\nreason over cap\nflag\n"), { status: "paid", tx: "0xabc", reason: "over cap", flag: "" });
});
test("exit codes map", () => {
  assert.deepEqual([0, 1, 3, 4, 2].map((c) => statusOfExit(c, true)), ["paid", "refused", "pending", "held", "error"]);
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
  assert.deepEqual(calls[0].args, ["--no-install", "metal-agent", "mandate", "pull", "--credential", "c.json", "--to", "0xabc", "--amount", "0.50", "--network", "testnet", "--payment-id", "p1"]);
  assert.deepEqual(calls[0].env, { METAL_RPC_URL: "http://rpc.test" });
});

test("pay, replace and verify use the documented flags", async () => {
  const seen: string[][] = [];
  const cli = createMetalCli({ rpcUrl: "x", run: async (_f, args) => (seen.push(args), { exitCode: 0, stdout: "", stderr: "" }) });
  await cli.pay("http://u/raw", "new.json");
  await cli.replace({ credential: "new.json", replaces: "old.json", key: "owner.json" });
  await cli.verify({ credential: "c.json", issuer: "i.json", tx: "0x1" });
  assert.deepEqual(seen[0], ["--no-install", "metal-agent", "pay", "http://u/raw", "--mandate", "new.json", "--network", "testnet"]);
  assert.deepEqual(seen[1], ["--no-install", "metal-agent", "mandate", "replace", "--credential", "new.json", "--replaces", "old.json", "--key", "owner.json", "--network", "testnet"]);
  assert.deepEqual(seen[2], ["--no-install", "metal-agent", "mandate", "verify", "--credential", "c.json", "--issuer", "i.json", "--network", "testnet", "--tx", "0x1"]);
});

test("refusal code is parsed from the error line", async () => {
  const text = "error: payment refused: mandate_cap_exceeded (the amount is above the mandate's per-payment cap) ... nothing was paid";
  assert.equal(parseRefusalCode(text), "mandate_cap_exceeded");
  assert.equal(parseRefusalCode("status paid"), undefined);
  const cli = createMetalCli({ rpcUrl: "x", run: async () => ({ exitCode: 1, stdout: "", stderr: text }) });
  const r = await cli.pay("http://u/raw", "c.json");
  assert.equal(r.status, "refused");
  assert.equal(r.refusalCode, "mandate_cap_exceeded");
});
test("status parses spent and budget to base units", async () => {
  const out = "spent 0.04 *USDZ of 10 *USDZ\npayments 2\n";
  assert.deepEqual(parseStatus(out), { spent: 4n * 10n ** 16n, budget: 10n * 10n ** 18n, payments: 2 });
  const seen: string[][] = [];
  const cli = createMetalCli({ rpcUrl: "x", run: async (_f, a) => (seen.push(a), { exitCode: 0, stdout: out, stderr: "" }) });
  const s = await cli.status("c.json");
  assert.equal(s.spent, 4n * 10n ** 16n);
  assert.deepEqual(seen[0], ["--no-install", "metal-agent", "mandate", "status", "--credential", "c.json", "--network", "testnet"]);
  assert.throws(() => parseStatus("nothing"));
});
test("usdz format round-trips to the cent", () => {
  assert.equal(parseUsdz("0.04"), 4n * 10n ** 16n);
  assert.equal(formatUsdz(parseUsdz("10")), "10.00");
  assert.equal(formatUsdz(parseUsdz("0.5")), "0.50");
  assert.throws(() => parseUsdz("1e3"));
});
test("credentialCreate passes payee and mandate key file", async () => {
  const seen: string[][] = [];
  const cli = createMetalCli({ rpcUrl: "x", run: async (_f, a) => (seen.push(a), { exitCode: 0, stdout: "", stderr: "" }) });
  await cli.credentialCreate({ principal: "0xp", cap: "0.04", budget: "9.00", out: "s.v2.json", key: "o.json", payees: ["0xu,Upstream"], mandateKeyFile: "s.key.json" });
  assert.deepEqual(seen[0], ["--no-install", "metal-agent", "mandate", "credential", "create", "--principal", "0xp", "--cap", "0.04", "--budget", "9.00", "--out", "s.v2.json", "--key", "o.json", "--network", "testnet", "--payee", "0xu,Upstream", "--mandate-key-file", "s.key.json"]);
});

test("exit 1 with no refusal line is an error, not a refusal, and the stderr tail is redacted", async () => {
  const cli = createMetalCli({ rpcUrl: "x", run: async () => ({ exitCode: 1, stdout: "", stderr: `npm error 404 https://registry.npmjs.org/metal-agent ${"ab".repeat(20)}` }) });
  const r = await cli.pay("http://u/raw", "c.json");
  assert.equal(r.status, "error");
  assert.equal(r.refusalCode, undefined);
  assert.ok(r.error?.includes("[url]") && r.error.includes("[hex]") && !r.error.includes("registry"));
  await assert.rejects(cli.status("c.json"), /no spent line: .*\[url\]/);
});
test("a refusal line gives refused with its code", async () => {
  const cli = createMetalCli({ rpcUrl: "x", run: async () => ({ exitCode: 1, stdout: "", stderr: "error: payment refused: mandate_budget_exceeded (over budget)" }) });
  const r = await cli.pay("http://u/raw", "c.json");
  assert.equal(r.status, "refused");
  assert.equal(r.refusalCode, "mandate_budget_exceeded");
  assert.equal(r.error, undefined);
});

test("pay passes method, body and headers and parses body and transaction", async () => {
  const seen: string[][] = [];
  const cli = createMetalCli({ run: async (_f, args) => { seen.push(args); return { exitCode: 0, stdout: "transaction 0xabc\nbody {\"caseId\":\"c1\"}\n", stderr: "" }; } });
  const r = await cli.pay("http://c/disputes", "c.json", { method: "POST", body: "{\"a\":1}", headers: { "x-k": "v" } });
  assert.deepEqual(seen[0], ["--no-install", "metal-agent", "pay", "http://c/disputes", "--mandate", "c.json", "--network", "testnet", "--method", "POST", "--body", "{\"a\":1}", "--header", "x-k: v"]);
  assert.equal(r.status, "paid");
  assert.equal(r.transaction, "0xabc");
  assert.equal(r.body, "{\"caseId\":\"c1\"}");
});
test("parsePayOutput reads a body that follows on the next lines, and tolerates absence", async () => {
  const { parsePayOutput } = await import("@dispute-court/buyer");
  assert.deepEqual(parsePayOutput("status ok\nbody\n{\"x\":1}\n"), { body: "{\"x\":1}" });
  assert.deepEqual(parsePayOutput("nothing here"), {});
});
