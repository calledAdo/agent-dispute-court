// Anchors every receipt in SELLER_RECEIPTS that is not yet anchored, as one new batch.
// Env: METAL_RPC_URL, SELLER_KEY_FILE (path), SELLER_RECEIPTS (path), COURT_LEDGER (address), COURT_LEDGER_FROM_BLOCK (decimal).
import { fileURLToPath } from "node:url";
import type { Address, Hex, PublicClient, WalletClient } from "viem";
import { unanchoredIndexes } from "@dispute-court/protocol";
import { LOG_CHUNK, ledgerEvents, metalClients, requiredEnv } from "@dispute-court/protocol";
import { ReceiptLog } from "@dispute-court/seller";
import { anchorBatch } from "@dispute-court/seller";

export interface AnchorResult { batch: bigint; root: Hex; tx: Hex; count: number; txs: string[] }

/** Counts of every DeliveriesCommitted event of `seller`, scanned in chunks (Metal caps getLogs ranges). */
export async function committedCounts(publicClient: PublicClient, ledger: Address, seller: Address, fromBlock: bigint): Promise<bigint[]> {
  const head = await publicClient.getBlockNumber();
  const events: { batch: bigint; count: bigint }[] = [];
  for (let from = fromBlock; from <= head; from += LOG_CHUNK) {
    const to = from + LOG_CHUNK - 1n < head ? from + LOG_CHUNK - 1n : head;
    const logs = await publicClient.getLogs({ address: ledger, event: ledgerEvents[0], args: { seller }, fromBlock: from, toBlock: to });
    for (const l of logs) events.push({ batch: l.args.batch!, count: l.args.count! });
  }
  return events.sort((a, b) => (a.batch < b.batch ? -1 : a.batch > b.batch ? 1 : 0)).map((e) => e.count);
}

/** Anchors the unanchored tail of the receipt log; returns null when there is nothing to anchor. */
export async function anchorNew(args: {
  publicClient: PublicClient; walletClient: WalletClient; ledger: Address; seller: Address; fromBlock: bigint; receiptsPath: string;
}): Promise<AnchorResult | null> {
  const all = new ReceiptLog(args.receiptsPath).all();
  const counts = await committedCounts(args.publicClient, args.ledger, args.seller, args.fromBlock);
  const idx = unanchoredIndexes(counts, all.length);
  if (idx.length === 0) return null;
  const tail = idx.map((i) => all[i]);
  const r = await anchorBatch({ publicClient: args.publicClient, walletClient: args.walletClient, ledger: args.ledger, receipts: tail, uri: `receipts:${idx[0]}-${idx[idx.length - 1]}` });
  return { batch: r.batch, root: r.root, tx: r.tx, count: tail.length, txs: tail.map((t) => t.tx) };
}

export function parseFromBlock(text: string): bigint {
  if (!/^\d+$/.test(text)) throw new Error("COURT_LEDGER_FROM_BLOCK must be a decimal block number");
  return BigInt(text);
}

async function main(): Promise<void> {
  const { publicClient, walletClient, account } = metalClients(requiredEnv("METAL_RPC_URL"), requiredEnv("SELLER_KEY_FILE"));
  const r = await anchorNew({
    publicClient, walletClient, seller: account.address,
    ledger: requiredEnv("COURT_LEDGER") as Address,
    fromBlock: parseFromBlock(requiredEnv("COURT_LEDGER_FROM_BLOCK")),
    receiptsPath: requiredEnv("SELLER_RECEIPTS"),
  });
  if (r === null) return void console.log("nothing to anchor");
  console.log(`anchored batch ${r.batch}`, `\n  root  ${r.root}`, `\n  tx    ${r.tx}`, `\n  count ${r.count}`);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch((err) => {
    console.error(err instanceof Error ? (err as { shortMessage?: string }).shortMessage ?? err.message : String(err));
    process.exit(1);
  });
}
