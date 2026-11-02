import { buildTree, receiptLeaf } from "./merkle.ts";

/**
 * Batches for the evidence module: a batch is one DeliveriesCommitted event of SELLER on the ledger.
 * The seller anchors receipts in log order, so batch k (ascending) covers the next `count` receipts of
 * SELLER_RECEIPTS. A batch is accepted only if the root recomputed from those receipts equals the root in
 * the event; a mismatched batch still consumes its `count` receipts (so later batches stay aligned) but
 * maps to nothing, which the evidence module reports as "not anchored / could not check".
 */
export function mapBatches(
  events: { batch: bigint; root: string; count: bigint }[],
  receipts: { tx: string; resource: string; requestHash: string; responseHash: string }[],
): { batch: bigint; txs: string[] }[] {
  const out: { batch: bigint; txs: string[] }[] = [];
  let cursor = 0;
  for (const ev of [...events].sort((a, b) => (a.batch < b.batch ? -1 : a.batch > b.batch ? 1 : 0))) {
    const slice = receipts.slice(cursor, cursor + Number(ev.count));
    cursor += Number(ev.count);
    if (slice.length !== Number(ev.count) || slice.length === 0) continue;
    if (buildTree(slice.map(receiptLeaf)).root.toLowerCase() === ev.root.toLowerCase()) out.push({ batch: ev.batch, txs: slice.map((r) => r.tx) });
  }
  return out;
}

/**
 * Which receipts still need anchoring. The seller anchors receipts in log order, so the receipts already
 * committed are the first sum(counts) of the log (a mismatched batch still consumes its count, as in mapBatches).
 * Returns the indexes of the unanchored tail; empty when everything is anchored.
 */
export function unanchoredIndexes(committedCounts: bigint[], receiptsLength: number): number[] {
  const committed = committedCounts.reduce((a, b) => a + b, 0n);
  if (committed >= BigInt(receiptsLength)) return [];
  const start = Number(committed);
  return Array.from({ length: receiptsLength - start }, (_, i) => start + i);
}
