import { test } from "node:test";
import assert from "node:assert/strict";
import { executeDue, publishRulings } from "../court/remedy.ts";
import type { RemedyDeps } from "../court/remedy.ts";
import type { Ruling } from "../court/verdict.ts";

const SELLER = "0x00000000000000000000000000000000000000aa" as const;
const PAYER = "0x00000000000000000000000000000000000000cc" as const;
const VAULT = "0x00000000000000000000000000000000000000dd" as const;
const ROOT = ("0x" + "ab".repeat(32)) as `0x${string}`;
const tx = (n: number) => ("0x" + n.toString(16).padStart(2, "0").repeat(32)) as `0x${string}`;
const GAS = { gas: 400000n, maxFeePerGas: 1n, maxPriorityFeePerGas: 1n };

const ruling = (over: Partial<Ruling>): Ruling => ({
  claimId: "claim-1", tx: tx(1), code: "A13.1", verdict: "REFUND", liable: "SELLER", refund: 5n, proposedRefund: 5n,
  reason: "r", evidence: [], decidedBy: "code", ...over,
});

interface Stub { receiptStatus?: string; states?: Record<string, [bigint, number]>; now?: bigint; revert?: string }
function makeDeps(stub: Stub = {}) {
  const sims: any[] = [];
  const writes: any[] = [];
  const log: string[] = [];
  const deps = {
    publicClient: {
      readContract: async ({ args }: any) => {
        const [at, state] = stub.states?.[args[0]] ?? [0n, 0];
        return [SELLER, PAYER, 5n, at, state];
      },
      waitForTransactionReceipt: async ({ hash }: any) => { log.push("wait:" + hash); return { status: stub.receiptStatus ?? "success" }; },
      getBlock: async () => ({ timestamp: stub.now ?? 1000n }),
      simulateContract: async (args: any) => {
        sims.push(args);
        if (stub.revert) throw Object.assign(new Error("long"), { shortMessage: stub.revert });
        return { request: { address: args.address, abi: args.abi, functionName: args.functionName, args: args.args } };
      },
    },
    walletClient: { account: { address: "0x1" }, writeContract: async (req: any) => { log.push("write"); writes.push(req); return "0xhash"; } },
    vault: VAULT,
    vaultAbi: [],
    seller: SELLER,
    evidenceRoot: () => ROOT,
  } as unknown as RemedyDeps;
  return { deps, sims, writes, log };
}

test("publish sends only REFUND rulings with refund > 0, with Metal gas", async () => {
  const { deps, sims, writes } = makeDeps();
  const out = await publishRulings(
    [ruling({}), ruling({ tx: tx(2), verdict: "REJECT", refund: 0n }), ruling({ tx: tx(3), verdict: "ESCALATE", refund: 0n }), ruling({ tx: tx(4), refund: 0n })],
    () => PAYER,
    deps,
  );
  assert.deepEqual(out, [
    { tx: tx(1), status: "published", hash: "0xhash" },
    { tx: tx(2), status: "skipped" },
    { tx: tx(3), status: "skipped" },
    { tx: tx(4), status: "skipped" },
  ]);
  assert.equal(writes.length, 1);
  assert.equal(sims.length, 1);
  assert.equal(sims[0].functionName, "rule");
  assert.deepEqual(sims[0].args, [tx(1), SELLER, PAYER, 5n, "A13.1", ROOT]);
  for (const call of [sims[0], writes[0]]) {
    assert.equal(call.gas, GAS.gas);
    assert.equal(call.maxFeePerGas, 1n);
    assert.equal(call.maxPriorityFeePerGas, 1n);
  }
});

test("publish is idempotent: an existing ruling sends nothing", async () => {
  const { deps, sims, writes } = makeDeps({ states: { [tx(1)]: [0n, 1], [tx(2)]: [0n, 2] } });
  const out = await publishRulings([ruling({}), ruling({ tx: tx(2) })], () => PAYER, deps);
  assert.deepEqual(out.map((o) => o.status), ["already_ruled", "already_ruled"]);
  assert.equal(sims.length + writes.length, 0);
});

test("two refund rulings for one payment publish once", async () => {
  const { deps, writes } = makeDeps();
  const out = await publishRulings([ruling({}), ruling({ claimId: "claim-2" })], () => PAYER, deps);
  assert.deepEqual(out.map((o) => o.status), ["published", "already_ruled"]);
  assert.equal(writes.length, 1);
});

test("publish revert becomes failed with its reason and the loop continues", async () => {
  const { deps, writes } = makeDeps({ revert: "refund above cap" });
  const out = await publishRulings([ruling({}), ruling({ tx: tx(2) })], () => PAYER, deps);
  assert.deepEqual(out.map((o) => [o.status, o.reason]), [["failed", "refund above cap"], ["failed", "refund above cap"]]);
  assert.equal(writes.length, 0);
});

test("executeDue reports every state", async () => {
  const { deps, sims, writes } = makeDeps({
    now: 1000n,
    states: {
      [tx(1)]: [1000n, 1], // exactly due
      [tx(2)]: [1001n, 1], // too early
      [tx(3)]: [0n, 2],
      [tx(4)]: [0n, 3],
      [tx(5)]: [0n, 0],
    },
  });
  const out = await executeDue([tx(1), tx(2), tx(3), tx(4), tx(5)], deps);
  assert.deepEqual(out.map((o) => o.status), ["paid", "not_yet", "already_paid", "objected", "failed"]);
  assert.equal(out[0].hash, "0xhash");
  assert.equal(out[4].reason, "no_ruling");
  assert.equal(writes.length, 1);
  assert.equal(sims[0].functionName, "execute");
  assert.deepEqual(sims[0].args, [tx(1)]);
  assert.equal(writes[0].gas, GAS.gas);
  assert.equal(writes[0].maxPriorityFeePerGas, 1n);
});

test("executeDue revert becomes failed and does not stop later txs", async () => {
  const { deps, writes } = makeDeps({ revert: "not executable", states: { [tx(1)]: [0n, 1], [tx(2)]: [0n, 2] } });
  const out = await executeDue([tx(1), tx(2)], deps);
  assert.deepEqual(out.map((o) => o.status), ["failed", "already_paid"]);
  assert.equal(out[0].reason, "not executable");
  assert.equal(writes.length, 0);
});

test("executeDue survives an rpc error on read", async () => {
  const { deps } = makeDeps();
  (deps.publicClient as any).readContract = async () => { throw new Error("rpc down"); };
  const out = await executeDue([tx(1)], deps);
  assert.deepEqual(out, [{ tx: tx(1), status: "failed", reason: "rpc down" }]);
});

test("a reverted receipt becomes failed with reverted_onchain", async () => {
  const { deps } = makeDeps({ receiptStatus: "reverted", states: { [tx(2)]: [0n, 1] } });
  const pub = await publishRulings([ruling({})], () => PAYER, deps);
  assert.deepEqual(pub, [{ tx: tx(1), status: "failed", reason: "reverted_onchain" }]);
  const ex = await executeDue([tx(2)], deps);
  assert.deepEqual(ex, [{ tx: tx(2), status: "failed", reason: "reverted_onchain" }]);
});

test("writes are sequential: each is confirmed before the next is sent", async () => {
  const { deps, log } = makeDeps();
  await publishRulings([ruling({}), ruling({ tx: tx(2) })], () => PAYER, deps);
  assert.deepEqual(log, ["write", "wait:0xhash", "write", "wait:0xhash"]);
});
