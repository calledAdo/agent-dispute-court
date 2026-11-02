# T7: Treasury agent and Kit 11 business agents

DataCo's own agents (Kit 11). Three agents draw on DataCo's Metal account, each under its own mandate. **The 20 *USDZ total across them is held in code** (the chain caps each mandate, not their sum).

| Agent | Mandate | Job |
|---|---|---|
| sourcing | 10 *USDZ budget, cap 0.03 per purchase, payee = upstream | buys upstream data per query (x402) |
| support | 4 *USDZ, payee = any customer | pays goodwill refunds via `metal-agent mandate pull --payment-id` |
| treasury | 6 *USDZ, payee = DataCo's settlement address | moves earnings toward Airwallex and pays the EUR licence fee |

## Files
### `agents/upstream.ts`
An x402 seller (pattern: `seller/server.ts`, no signed order needed) at `GET /raw?symbol=X`. The price comes from an injected `priceOf(): string`, default `"0.02"`. `POST /admin/price {price}` changes it, guarded by an `x-operator-token` header. This drives the price-jump scene: 0.02 → 0.04.

### `agents/mandates.ts`
Pure planning for the price jump.
- `planLimits(state: { sourcing: {spent, budget, cap}; support: {...}; treasury: {...} }, upstreamPrice: bigint, salePrice: bigint, total: bigint): { proposal: {sourcing, support, treasury: {budget, cap}}; salePrice: bigint; rationale: string[] } | { error }`.
- Rules:
  - The new sourcing cap is ≥ upstreamPrice.
  - Each new budget is > that agent's spent (a replacement carries spend).
  - The budgets sum to ≤ total.
  - If the margin `salePrice − upstreamPrice` falls under 0.01, propose a new salePrice keeping a 0.01 margin.
  - Whole cents only (mandates pay whole cents).
- All amounts are bigint base units (18 decimals).

### `agents/cli.ts`
A thin, typed wrapper around `npx metal-agent` with `child_process.execFile` and an args array, never a shell string. Commands: `credentialCreate`, `bind`, `replace`, `pull({credential, to, amount, paymentId})`, `verify`, `pay(url, credential)`.
- Parse the `key value` lines of stdout into an object.
- Map the exit codes from the payouts doc: 0 paid, 1 refused, 3 pending (rerun the same command), 4 held.
- Pass `METAL_RPC_URL` through from env. Never log env values.

### `treasury/airwallex.ts`
Extend `card/airwallex.ts`'s `AirwallexClient` pattern (reuse its login/request helper; import it, don't copy it). Methods:
- `listGlobalAccounts`, `createGlobalAccount({country_code, currency})`, `simulateDeposit({global_account_id, amount, reference})`, `getBalances`;
- `fxQuote({sell_currency, buy_currency, buy_amount})`, `fxConvert({quote_id?, sell_currency, buy_currency, buy_amount})` at **`POST /fx/conversions/create`, with no `x-api-version` header**;
- `beneficiarySchema`, `createBeneficiary`, `createTransfer({beneficiary_id, transfer_amount, transfer_currency, transfer_method, reference})`, `getTransfer`, `simulateTransferTransition(id, status)`.

Guide rules: `request_id` UUID on every create; amounts in major units; send `transfer_currency`/`transfer_amount` (not `payment_*`); `transfer_method` is `LOCAL` or `SWIFT`; EUR SWIFT costs a flat EUR 12.85, which you must add to the conversion; a failed transfer ends `CANCELLED`; `SENT` is in flight, not final.

### `treasury/settle.ts`
`settleEarnings({ amountUsdz, metalTxHash, ledger })`: the guide's prescribed path. The Airwallex sandbox can't receive stablecoins, so:
1. record the Metal tx hash as credited in a local JSONL ledger (idempotent by tx hash);
2. simulate an Airwallex deposit of the same USD amount with the **tx hash as `reference`**;
3. return both.

A second call with the same hash does nothing and returns the stored result.

`payLicenceFee({ eurAmount, beneficiary })`:
1. quote USD→EUR for `eurAmount + 12.85` (SWIFT);
2. convert;
3. create the SWIFT transfer;
4. return ids.

It is idempotent by an invoice id stored in the ledger.

### `scripts/kit11-demo.ts`
Orchestrates the Kit 11 story against **live** services, reading only env (`METAL_RPC_URL`, credential **paths**, `AWX_CLIENT_ID`/`AWX_API_KEY`, operator token). **Do not run it**; the reviewer runs it. Steps:
1. the customer buys N quotes;
2. the sourcing agent buys upstream at 0.02 per sale;
3. the operator raises upstream to 0.04, the next purchase is refused (exit 1, reason printed), and the customer gets an error status;
4. `planLimits` proposes new limits; print them and wait for `APPROVE=yes` in env (or a prompt) before `replace`;
5. resume purchases;
6. the treasury settles earnings via `settleEarnings` and pays a EUR 50 licence fee.

### Tests: `test/treasury.test.ts`, `test/agents.test.ts`
No network: stub fetch and execFile. Cover:
- `planLimits` (cap raised, the sum ≤ 20, spend carry, whole cents, the price-increase case, an impossible case → error);
- CLI output parsing and exit-code mapping;
- `settleEarnings` idempotency;
- the licence fee including the 12.85 SWIFT fee;
- no `x-api-version` on FX calls.
