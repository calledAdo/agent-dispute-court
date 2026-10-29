import { decodeEventLog, parseAbi } from "viem";
import type { Address, Hex, PublicClient, WalletClient } from "viem";
import { buildTree, receiptLeaf } from "../shared/merkle.ts";

const abi = parseAbi([
  "function commit(bytes32 root, uint256 count, string uri) returns (uint256 batch)",
  "event DeliveriesCommitted(address indexed seller, uint256 indexed batch, bytes32 root, uint256 count, string uri)",
]);

type Receipt = { tx: string; resource: string; requestHash: string; responseHash: string };

export async function anchorBatch(args: {
  publicClient: PublicClient;
  walletClient: WalletClient;
  ledger: Address;
  receipts: Receipt[];
  uri: string;
}): Promise<{ batch: bigint; root: Hex; tx: Hex; indexOf: Record<string, number> }> {
  const { publicClient, walletClient, ledger, receipts, uri } = args;
  const tree = buildTree(receipts.map(receiptLeaf));
  const indexOf: Record<string, number> = {};
  receipts.forEach((r, i) => { indexOf[r.tx] = i; });

  // Metal cannot estimate gas, so gas and fees are explicit.
  const tx = await walletClient.writeContract({
    address: ledger,
    abi,
    functionName: "commit",
    args: [tree.root, BigInt(receipts.length), uri],
    gas: 300000n,
    maxFeePerGas: 1n,
    maxPriorityFeePerGas: 1n,
    chain: walletClient.chain,
    account: walletClient.account!,
  });
  const receipt = await publicClient.waitForTransactionReceipt({ hash: tx });
  if (receipt.status !== "success") throw new Error(`commit transaction reverted: ${tx}`);

  for (const log of receipt.logs) {
    if (log.address.toLowerCase() !== ledger.toLowerCase()) continue;
    try {
      const ev = decodeEventLog({ abi, data: log.data, topics: log.topics });
      if (ev.eventName === "DeliveriesCommitted") return { batch: ev.args.batch, root: tree.root, tx, indexOf };
    } catch {
      // not our event
    }
  }
  throw new Error("DeliveriesCommitted event not found in receipt");
}
