import type { Abi, PublicClient } from "viem";
import type { verifyMandatePayment, MandateVerification, VerifiedPayment } from "@metalntwx/metal-pay/mandates";
import { buildTree, receiptLeaf } from "@dispute-court/protocol";
import type { Receipt, Sale } from "@dispute-court/protocol";
import type { ReceiptRecord } from "@dispute-court/seller";
import { decodeSignedOrder } from "./order.ts";

export interface EvidenceDeps {
  publicClient: PublicClient;
  verify: typeof verifyMandatePayment;
  ledger: `0x${string}`;
  ledgerAbi: Abi;
  seller: `0x${string}`;
  receipts: ReceiptRecord[];
  batches: { batch: bigint; txs: string[] }[];
}

type AssembleResult = { sale: Sale | null; discrepancies: string[]; evidence: Record<string, unknown> };

const same = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();

async function runVerify(tx: `0x${string}`, signedOrder: string | undefined, deps: EvidenceDeps): Promise<MandateVerification | null> {
  try {
    const opts = signedOrder === undefined ? { tx } : { tx, checkoutMandate: signedOrder };
    return await deps.verify(deps.publicClient, opts);
  } catch {
    return null;
  }
}

/** Merkle proof check on chain. null = receipt is in no anchored batch, or the call failed. */
async function checkAnchored(record: ReceiptRecord, deps: EvidenceDeps): Promise<{ anchored: boolean | null; proof: unknown }> {
  const batch = deps.batches.find((b) => b.txs.some((t) => same(t, record.tx)));
  if (!batch) return { anchored: null, proof: null };
  try {
    const records = batch.txs.map((t) => deps.receipts.find((r) => same(r.tx, t)));
    if (records.some((r) => r === undefined)) return { anchored: null, proof: null };
    const leaves = (records as ReceiptRecord[]).map(receiptLeaf);
    const index = batch.txs.findIndex((t) => same(t, record.tx));
    const tree = buildTree(leaves);
    const proof = tree.proof(index);
    const anchored = await deps.publicClient.readContract({
      address: deps.ledger,
      abi: deps.ledgerAbi,
      functionName: "proves",
      args: [deps.seller, batch.batch, BigInt(index), leaves[index], proof],
    });
    if (typeof anchored !== "boolean") return { anchored: null, proof: null };
    return { anchored, proof: { batch: batch.batch.toString(), index, leaf: leaves[index], siblings: proof, root: tree.root } };
  } catch {
    return { anchored: null, proof: null };
  }
}

function pickPayment(v: MandateVerification, seller: string): { payment: VerifiedPayment | null; count: number } {
  const mine = v.payments.filter((p) => p.kind === "payment" && same(p.to, seller));
  return { payment: mine[0] ?? null, count: mine.length };
}

export async function assembleSale(tx: `0x${string}`, deps: EvidenceDeps, buyerSignedOrder?: string): Promise<AssembleResult> {
  const discrepancies: string[] = [];
  const evidence: Record<string, unknown> = { tx };
  const record = deps.receipts.find((r) => same(r.tx, tx));

  // Order source precedence: the buyer's own copy, then the receipt's. A seller who logs nothing must not erase the order.
  const candidates = [buyerSignedOrder, record?.signedOrder].filter((c): c is string => c !== undefined);
  if (candidates.length === 2 && candidates[0] !== candidates[1]) discrepancies.push("signed_order_copies_differ");
  const unique = [...new Set(candidates)];
  const attempts = await Promise.all(unique.map((c) => runVerify(tx, c, deps)));
  const best = Math.max(0, attempts.findIndex((v) => v?.ok === true)); // buyer's copy first when several verify
  const signedOrder = unique[best];
  let verification: MandateVerification | null = attempts[best] ?? null;
  const signedOrderValid: boolean | null = verification ? verification.ok : null;
  // The order may be the reason verify throws; retry without it so the chain facts are still available.
  if (!verification) verification = await runVerify(tx, undefined, deps);

  const order = signedOrder === undefined ? null : decodeSignedOrder(signedOrder);
  if (signedOrder !== undefined && order === null) discrepancies.push("signed order is malformed and could not be decoded");
  if (order === null) discrepancies.push("no_signed_order");
  evidence.signedRequest = order;
  evidence.signedOrderValid = signedOrderValid;
  evidence.verifySteps = verification?.steps ?? null;
  if (!verification) {
    discrepancies.push("verifyMandatePayment could not run for this tx");
    return { sale: null, discrepancies, evidence };
  }

  const { payment, count } = pickPayment(verification, deps.seller);
  if (!payment) return { sale: null, discrepancies: [...discrepancies, "no payment to the seller found on chain for this tx"], evidence };
  if (count > 1) discrepancies.push(`tx carries ${count} payments to the seller; the first was used`);

  let settledAt: number;
  try {
    const block = await deps.publicClient.getBlock({ blockNumber: payment.block });
    settledAt = Number(block.timestamp) * 1000;
  } catch {
    return { sale: null, discrepancies: [...discrepancies, "block timestamp could not be read"], evidence };
  }
  evidence.blockNumber = payment.block.toString();
  evidence.payment = { to: payment.to, amount: payment.amount.toString(), payer: verification.mandate?.principal ?? null };

  let receipt: Receipt | null = null;
  if (record) {
    if (order && record.resource !== order.resource) discrepancies.push(`receipt resource "${record.resource}" differs from signed "${order.resource}"; signed value used`);
    if (order && record.requestHash !== order.requestHash) discrepancies.push(`receipt requestHash "${record.requestHash}" differs from signed "${order.requestHash}"; signed value used`);
    const { anchored, proof } = await checkAnchored(record, deps);
    evidence.merkleProof = proof;
    receipt = { status: record.status, responseHash: record.responseHash, body: record.body, anchored };
  }

  const payer = verification.mandate?.principal;
  if (!payer) return { sale: null, discrepancies: [...discrepancies, "payer (mandate principal) not reported by verification"], evidence };

  const sale: Sale = {
    tx,
    payer,
    payee: payment.to,
    amount: payment.amount,
    settledAt,
    resource: order?.resource ?? "",
    requestHash: order?.requestHash ?? "",
    signedOrderValid: order ? signedOrderValid : null,
    receipt,
    acceptance: order?.acceptance ?? null,
  };
  return { sale, discrepancies, evidence };
}

export async function assembleHistory(payer: `0x${string}`, txs: `0x${string}`[], deps: EvidenceDeps, buyerOrders?: Record<string, string>): Promise<Sale[]> {
  const sales: Sale[] = [];
  for (const tx of txs) {
    const { sale } = await assembleSale(tx, deps, buyerOrders?.[tx]);
    if (sale && same(sale.payer, payer)) sales.push(sale);
  }
  return sales;
}
