# T10: Court serves many sellers, and checks infer-v1 deliveries

The court today is wired to one seller. Inference providers are separate sellers (each has its own payee, receipt log and reserve), so one court instance must serve all of them. The contracts are already multi-seller: `CourtVault.rule(paymentTx, seller, …)` and `CourtLedger.proves(seller, …)`. Only the TypeScript wiring changes.

Already done, do not rewrite: `shared/types.ts` (`Acceptance` is now `QuoteAcceptance | InferAcceptance`) and `shared/infer.ts` (`checkInferOutput`, `readInferAcceptance`, `DEFAULT_INFER_ACCEPTANCE`).

## Changes

1. **`court/order.ts`.** `readAcceptance` returns a `QuoteAcceptance` for `quote-v1` (as today), or `readInferAcceptance(v)` for `infer-v1`.

2. **`court/checks.ts`, A13.3.** Dispatch on `acceptance.verifier`.
   - `quote-v1`: the existing logic, unchanged.
   - `infer-v1`:
     - Receipt missing → `COULD_NOT_BE_CHECKED`, reason `receipt_missing`.
     - Body hash mismatch → `COULD_NOT_BE_CHECKED`, reason `receipt_tampered`.
     - Otherwise `v = checkInferOutput(receipt.body, sale.requestHash, acceptance)`:
       - `v === null` → `NO_DIFFERENCE_FOUND`, reason `output_meets_acceptance`;
       - otherwise → `DIFFERENCE_CONFIRMED`, reason `v`.
     - Evidence: `[tx, acceptance:<tx>, receipt:<tx>]`.
     - No reference price is used.
   - Make sure nothing in case.ts tries to fetch a reference for an infer-v1 sale. A reference lookup must only happen for quote-v1.

3. **Seller registry.** A new file, `court/sellers.ts`.
   ```ts
   export interface SellerConfig { name: string; address: `0x${string}`; receipts: string; priceList: Record<string, string> } // decimal *USDZ per route
   export function loadSellers(env): SellerConfig[]
   ```
   - If `COURT_SELLERS` is set, it is a path to a JSON array of `SellerConfig`. Validate it:
     - each address is a 0x address;
     - names and addresses are unique (addresses compared case-insensitively);
     - each price parses with `parseUnits(x, 18)`.
   - Otherwise build one entry from the existing `SELLER`, `SELLER_RECEIPTS` and the `GET /quote` 0.05 price list, with the name `DataCo`. This keeps the existing demo working unchanged.
   - Throw a clear error on any invalid input.

4. **`court/main.ts`.**
   - Keep one `ReceiptLog` per seller.
   - Keep one log-scan cursor and event list per seller. The getLogs `args: { seller }` filter is already per seller.
   - `caseDeps(seller)` builds `EvidenceDeps` and `priceList` for that seller.
   - `remedyDeps` takes the seller per call, not from a closure.

5. **`court/api.ts`, `court/case.ts` and `court/remedy.ts`.**
   - The dispute body accepts an optional `seller` (0x address).
     - Unknown seller → 400 `unknown seller`.
     - Omitted → the first configured seller.
   - Store `seller` on `StoredCase`, and include `seller` and `sellerName` in `GET /cases` list items.
   - `CourtAppDeps.runCase(input)` receives `input.seller`.
   - `remedy.publish(rulings, payerOf, seller)` uses the case's seller.
   - `GET /sellers` (public) returns `[{ name, address }]`.
   - A new public route, **`GET /reputation`**, returns one row per configured seller:
     ```json
     { "name": "...", "address": "0x...", "cases": 3, "claims": 5, "upheld": 2, "refunded": "0.04" }
     ```
     - `upheld` counts rulings with verdict REFUND.
     - `refunded` is the sum of their refunds as a decimal *USDZ string (`formatUnits(x, 18)`).
     - Count only cases in status DECIDED, AWAITING_HUMAN, PUBLISHED or CLOSED.
     - The router agent uses this as its provider reputation, so keep the shape exactly as above.

6. **Console.** Show the seller name on each case row and in the case header. This is a small change.

7. **Tests.**
   - infer-v1 A13.3: one test per violation, plus a pass, plus a tampered body.
   - `readAcceptance` for both verifiers and for malformed input.
   - `loadSellers`: a valid file, duplicate addresses, a bad price, and the env fallback.
   - The API: unknown seller → 400, the seller stored on the case, and the `/reputation` aggregation (statuses filtered, sums correct).
   - The existing 192 tests must still pass.

## Constraints
- All money arithmetic is bigint. There is no float anywhere in refunds or reputation sums.
- Do not change the contracts.
- Do not read `.env` files or key files in tests.
- Run `npm test` and report the count.
