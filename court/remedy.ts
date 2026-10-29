import type { Abi, PublicClient, WalletClient } from "viem";
import type { Ruling } from "./verdict.ts";

export interface RemedyDeps {
  publicClient: PublicClient;
  walletClient: WalletClient;
  vault: `0x${string}`;
  vaultAbi: Abi;
  seller: `0x${string}`;
  evidenceRoot: (r: Ruling) => `0x${string}`;
}

export interface PublishOutcome { tx: string; status: "published" | "skipped" | "already_ruled" | "failed"; hash?: string; reason?: string }
export interface ExecuteOutcome { tx: string; status: "paid" | "not_yet" | "objected" | "already_paid" | "failed"; hash?: string; reason?: string }

// Metal testnet needs explicit gas settings on every write.
const GAS = { gas: 400000n, maxFeePerGas: 1n, maxPriorityFeePerGas: 1n } as const;

const reasonOf = (e: unknown) => (e instanceof Error && e.message === "reverted_onchain" ? e.message : e instanceof Error ? ((e as { shortMessage?: string }).shortMessage ?? e.message) : String(e));

/** On-chain state of a ruling: 0 none, 1 pending, 2 paid, 3 objected. */
async function readRuling(txHash: `0x${string}`, deps: RemedyDeps): Promise<{ state: number; executableAt: bigint }> {
  const r = (await deps.publicClient.readContract({
    address: deps.vault,
    abi: deps.vaultAbi,
    functionName: "rulings",
    args: [txHash],
  })) as readonly [string, string, bigint, bigint, number | bigint];
  return { state: Number(r[4]), executableAt: BigInt(r[3]) };
}

const REVERTED = "reverted_onchain";

/** Simulate, send, then wait for the receipt; one write at a time. A reverted receipt throws. A revert in simulation throws before anything is sent. */
async function write(functionName: string, args: unknown[], deps: RemedyDeps): Promise<string> {
  const { request } = await deps.publicClient.simulateContract({
    address: deps.vault,
    abi: deps.vaultAbi,
    functionName,
    args,
    account: deps.walletClient.account,
    ...GAS,
  } as never);
  const hash = await deps.walletClient.writeContract({ ...(request as object), ...GAS } as never);
  const receipt = await deps.publicClient.waitForTransactionReceipt({ hash });
  if (receipt.status !== "success") throw new Error(REVERTED, { cause: hash });
  return hash;
}

export async function publishRulings(
  rulings: Ruling[],
  payerOf: (tx: string) => `0x${string}`,
  deps: RemedyDeps,
): Promise<PublishOutcome[]> {
  const out: PublishOutcome[] = [];
  const seen = new Set<string>(); // one ruling per payment, even before the first one is mined
  for (const ruling of rulings) {
    const tx = ruling.tx;
    if (ruling.verdict !== "REFUND" || ruling.refund <= 0n) {
      out.push({ tx, status: "skipped" });
      continue;
    }
    const key = tx.toLowerCase();
    if (seen.has(key)) {
      out.push({ tx, status: "already_ruled" });
      continue;
    }
    seen.add(key);
    try {
      const existing = await readRuling(tx as `0x${string}`, deps);
      if (existing.state !== 0) {
        out.push({ tx, status: "already_ruled" });
        continue;
      }
      const hash = await write(
        "rule",
        [tx, deps.seller, payerOf(tx), ruling.refund, ruling.code, deps.evidenceRoot(ruling)],
        deps,
      );
      out.push({ tx, status: "published", hash });
    } catch (e) {
      out.push({ tx, status: "failed", reason: reasonOf(e) });
    }
  }
  return out;
}

export async function executeDue(txs: string[], deps: RemedyDeps): Promise<ExecuteOutcome[]> {
  const out: ExecuteOutcome[] = [];
  for (const tx of txs) {
    try {
      const ruling = await readRuling(tx as `0x${string}`, deps);
      if (ruling.state === 2) out.push({ tx, status: "already_paid" });
      else if (ruling.state === 3) out.push({ tx, status: "objected" });
      else if (ruling.state !== 1) out.push({ tx, status: "failed", reason: "no_ruling" });
      else {
        const block = await deps.publicClient.getBlock({ blockTag: "latest" });
        if (block.timestamp < ruling.executableAt) out.push({ tx, status: "not_yet" });
        else out.push({ tx, status: "paid", hash: await write("execute", [tx], deps) });
      }
    } catch (e) {
      out.push({ tx, status: "failed", reason: reasonOf(e) });
    }
  }
  return out;
}
