# T2: DataCo seller service

Turn `seller/spike-seller.mjs` (working, tested live) into a typed, testable service. **Keep its x402 wiring exactly as it is.** It was verified on Metal testnet; do not "simplify" the per-request `x402HTTPResourceServer`.

## Allowed dependencies
`express`, `viem`, `@metalntwx/metal-pay@0.3.3`, `@x402/core@2.28.0`, `@x402/express@2.28.0`, `@x402/evm@2.28.0`. Pin these exact versions in package.json.

## Files
- `seller/offer.ts`: pure helpers, no network.
  - `canonicalRequest(method: string, path: string, query: Record<string, string | string[]>): string`. Example: `GET /quote?a=1&symbol=TSLA`. Sort the query keys; repeated keys keep their value order; no `?` when the query is empty.
  - `buildOffer(opts: { payTo: string; price: string; resource: string; acceptance: Acceptance }): RouteConfig`. Returns the `"GET /quote"` route config: `scheme "exact"`, `network "eip155:63825"`, `extra = { signedOffer: "required", resource, requestHash: sha256Hex(resource), acceptance }`. `Acceptance` comes from `shared/types.ts`.
  - `buildReceipt(input: { tx: string; payer: string; amount: string; resource: string; requestHash: string; status: number; body: string; signedOrder: string; settledAt: number }): ReceiptRecord`. Adds `responseHash = sha256Hex(body)`.
- `seller/quotes.ts`: `makeQuote(symbol: string, now: number, upstream: (symbol: string) => number): { symbol; price; asOf }`. `asOf` is an ISO string of `now`.
- `seller/receipts.ts`: `ReceiptLog` class. Append-only JSONL at a given path; `append(r)`, `all()`, `byTx(tx)`. One record per tx: a second append for the same tx is ignored and returns `false`.
- `seller/server.ts`: Express app factory `createSeller({ payTo, rpcUrl, facilitatorUrl, price, acceptance, upstream, log, now })`, plus a `main` that reads `SELLER_PAY_TO`, `METAL_RPC_URL`, `PORT` from `process.env` when run directly. Same hooks as the spike: `requireSignedOffer`, and `onAfterSettle` writing a receipt only when `settlement.first` is true.
- `test/seller.test.ts`: unit tests for `offer.ts`, `quotes.ts` and `receipts.ts` only. **No network in tests.**

## Defaults
Price `"0.05"`. Acceptance `{ verifier: "quote-v1", maxStalenessMs: 60000, maxDeviationBps: 50 }`.

## Testing hooks for the demo
`upstream` is injectable so the demo can serve a stale or wrong quote on purpose. Add an optional `faults: { staleSymbols?: string[]; wrongSymbols?: string[] }`:
- a stale symbol gets `asOf = now - 5 minutes`;
- a wrong symbol gets a price 3% off upstream.

Default: no faults.

## Out of scope
Merkle anchoring (that's T3). Contracts. Anything that needs a private key.
