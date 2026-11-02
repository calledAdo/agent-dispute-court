# T6: Court HTTP API with an x402 filing bond

An Express service that customers (or their agents) use to file disputes. **Filing costs a small x402 payment** (the filing bond), refunded if any claim in the case wins. It drives the existing modules: `court/case.ts`, `court/remedy.ts`, `court/store.ts`, `card/*`.

## Endpoints
| Method/path | Paid | Does |
|---|---|---|
| `POST /disputes` | **x402 exact, price = `FILING_FEE` (default "0.01")**, payTo = court address | Body `{ complaint, payer, txs[], buyerOrders? }`. Validate it (zod-free, hand-written). **Reject with 400 before payment** if invalid (the middleware then doesn't settle). The settled payer (`result.payer`, via `onAfterSettle`) must equal `body.payer`, case-insensitive; if not, the case is created with status `FILER_MISMATCH` and not run. Otherwise `runCase` runs **asynchronously** and the call answers `202 { caseId }`. Keep the fee payment tx on the case. |
| `GET /cases` | no | List: id, status, counts by verdict. |
| `GET /cases/:id` | no | Full `CaseResult` plus status, fee tx, approvals, remedy results. |
| `POST /cases/:id/approve` | no (operator token header `x-operator-token` = `OPERATOR_TOKEN`) | Body `{ claimId, decision: "REFUND" \| "REJECT", amount, approver }`. Only for `ESCALATE` rulings. **`amount` must equal the ruling's `proposedRefund` as a decimal string of base units, or 409** (the approval is bound to the amount shown). The ruling becomes REFUND/REJECT with `decidedBy: "human"`. |
| `POST /cases/:id/publish` | operator | `publishRulings` for REFUND rulings; saves the results. Idempotent. |
| `POST /cases/:id/execute` | operator | `executeDue`; then, if `refundFee` and not yet refunded, refund the filing fee to the payer **once**, with the fee-refund tx stored on the case. Idempotent: never refund the fee twice. |
| `GET /health` | no | `{ ok: true }` |

Case statuses: `RUNNING` → `DECIDED` → `AWAITING_HUMAN` (if any ESCALATE is unapproved) → `PUBLISHED` → `CLOSED` (all refunds paid or not owed), or `FILER_MISMATCH` / `FAILED` (with an error).

## x402 wiring
Copy the pattern from `seller/server.ts`: `registerMetalScheme`, a lazy `initialize`, Express middleware. No signed order is needed on this route (`extra` has no `signedOffer`). Use a fixed route config, not one per request.

## Files
- `court/api.ts`: `createCourtApp(deps: CourtAppDeps)`. Inject:
  - `x402: { server, routes } | null` (null in tests means the route is free and `payer` comes from the body);
  - `runCase`, `store`, `remedy: { publish, execute }`;
  - `feeRefund: (payer, amount, caseId) => Promise<{ hash }>`;
  - `operatorToken`, `now`.
- `court/main.ts`: reads `COURT_PORT`, `METAL_RPC_URL`, `COURT_KEY_FILE` (**path only**; load the key here and nowhere else), `COURT_VAULT`, `COURT_LEDGER`, `SELLER`, `SELLER_RECEIPTS`, `ANTHROPIC_API_KEY` (optional; null model if absent), `OPERATOR_TOKEN`, `FILING_FEE`. Builds the real deps:
  - `feeRefund` is a plain MIP20 `transfer` from the court key, with Metal gas `gas: 300000n, maxFeePerGas: 1n, maxPriorityFeePerGas: 1n`, waiting for the receipt;
  - `reference` is a simple upstream function (same formula as `seller/server.ts` `defaultUpstream`);
  - the batches list is read from the ledger's `DeliveriesCommitted` events for `SELLER`, mapped to receipts by recomputing roots from `SELLER_RECEIPTS` in order. Document the approach.
- `test/api.test.ts`: supertest-free. Start the app on port 0 and use `fetch`. Cover:
  - an invalid body → 400;
  - a happy path → 202, then DECIDED;
  - `FILER_MISMATCH`;
  - approve with a wrong amount → 409, and with the right one → 200;
  - approve without a token → 401;
  - publish/execute idempotency;
  - the fee refunded exactly once.

  Stub everything else.

## Rules
Bigints cross JSON as decimal strings. Never log keys or tokens.
