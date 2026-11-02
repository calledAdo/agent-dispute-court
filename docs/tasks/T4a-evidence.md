# T4a: Evidence assembler

Build the court's `Sale` (see `shared/types.ts`) for a disputed transaction **from what the court can verify**, not from what the seller claims.

## Trust model (the core of this task)
| Field | Source | Never from |
|---|---|---|
| `resource`, `requestHash`, `acceptance` | the **signed order**: decode the checkout JWT inside it (see `court/spike-verify.mjs` → `signedRequest`) | the seller's receipt fields |
| `payer`, `payee`, `amount` | the on-chain payment returned by `verifyMandatePayment` | the seller's log |
| `settledAt` | the block timestamp of the payment's block (ms; Metal has `timestampMillisPart`, but seconds × 1000 is acceptable) | the seller's log |
| `signedOrderValid` | `verifyMandatePayment(publicClient, { tx, checkoutMandate: signedOrder }).ok`; `null` if the call throws | n/a |
| `receipt.anchored` | `CourtLedger.proves(seller, batch, index, leaf, proof)` via `readContract`; `null` if the receipt is not in any anchored batch or the call fails | n/a |

If the seller's receipt disagrees with the signed order (different `resource` or `requestHash`), record it in a `discrepancies: string[]` field on the result. The signed values win.

## Files
- `court/order.ts`: pure. `decodeSignedOrder(signedOrder: string): { resource: string; requestHash: string; acceptance: Acceptance | null; amount: string; payTo: string } | null`. Returns null on any malformed input; never throws.
- `court/evidence.ts`:
  ```ts
  export interface EvidenceDeps {
    publicClient: PublicClient;            // viem, injected
    verify: typeof verifyMandatePayment;   // injected so tests can stub it
    ledger: `0x${string}`; ledgerAbi: Abi; seller: `0x${string}`;
    receipts: ReceiptRecord[];             // seller's log (seller/offer.ts type)
    batches: { batch: bigint; txs: string[] }[]; // which receipts went into which anchored batch, in leaf order
  }
  export async function assembleSale(tx: `0x${string}`, deps: EvidenceDeps): Promise<{ sale: Sale | null; discrepancies: string[]; evidence: Record<string, unknown> }>;
  export async function assembleHistory(payer: `0x${string}`, txs: `0x${string}`[], deps: EvidenceDeps): Promise<Sale[]>;
  ```
  - `sale: null` when the tx has no payment to `deps.seller` on chain.
  - The leaf, proof and root use `shared/merkle.ts` (`receiptLeaf`, `buildTree`) over the receipts of that batch, in order.
  - `evidence` holds what a human or Claude should see: tx, signed request, verify steps, Merkle proof, block number.
- `test/evidence.test.ts`: **no network.** Stub `publicClient.readContract`, `publicClient.getBlock` and `verify`. Build a real signed-order-shaped string in the test (base64url JSON segments, as decoded by `decodeSignedOrder`). Cover:
  - the happy path;
  - an invalid order (verify returns `ok: false`);
  - verify throws (`signedOrderValid: null`);
  - the receipt is missing;
  - the receipt is not in any batch (`anchored: null`);
  - the receipt disagrees with the signed order (signed values win, discrepancy recorded);
  - a malformed signed order;
  - a payment to another payee (`sale: null`).

Read the shape of `verifyMandatePayment`'s result from `node_modules/@metalntwx/metal-pay/src/mandates/verify.ts`. Find where it exposes the payments' `from`, `to`, `value` and block, and use those fields.

## Out of scope
Network calls in tests, keys, the model.
