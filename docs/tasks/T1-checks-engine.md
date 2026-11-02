# T1: Mechanical checks engine

Implement the court's code-only checks: pure functions, no network.

## Files
- `shared/types.ts`: the types below.
- `court/checks.ts`: the check functions.
- `test/checks.test.ts`: tests.

## Types (`shared/types.ts`)
```ts
export type CheckState = "DIFFERENCE_CONFIRMED" | "NO_DIFFERENCE_FOUND" | "COULD_NOT_BE_CHECKED";
export type ReasonCode = "A10" | "A12" | "A13.1" | "A13.3" | "A14";

/** One paid sale, as the seller logged it and the court has verified it against the chain. */
export interface Sale {
  tx: `0x${string}`;          // settlement transaction hash
  payer: `0x${string}`;       // buyer's Metal account
  payee: `0x${string}`;
  amount: bigint;             // base units
  settledAt: number;          // ms
  resource: string;           // canonical request the agent signed, e.g. "GET /quote?symbol=TSLA"
  requestHash: string;        // sha256 hex of resource, from the signed offer
  signedOrderValid: boolean | null; // result of verifyMandatePayment(tx, signedOrder); null = could not run
  receipt: Receipt | null;    // anchored delivery receipt, null if none was logged
  acceptance: Acceptance | null;    // criteria from the signed offer
}

export interface Receipt {
  status: number;             // HTTP status the seller returned
  responseHash: string;       // sha256 hex of the body
  body: string;               // the body (must hash to responseHash)
  anchored: boolean | null;   // Merkle proof verified on chain; null = could not check
}

export interface Acceptance {
  verifier: "quote-v1";
  maxStalenessMs: number;     // quote.asOf must be within this of settledAt
  maxDeviationBps: number;    // |quote.price - reference| / reference, in basis points
}

/** Reference price at settlement time, from the upstream source. null = unavailable. */
export type ReferencePrice = { symbol: string; price: number; at: number } | null;

export interface Claim {
  id: string;
  tx: `0x${string}`;
  code: ReasonCode;
  /** For A10: the request the customer says its agent actually asked for (optional). */
  allegedResource?: string;
}

export interface Finding {
  claimId: string;
  code: ReasonCode;
  state: CheckState;
  /** Machine-readable reason; required when state is COULD_NOT_BE_CHECKED. */
  reason: string;
  /** Evidence identifiers used (tx hashes, "receipt:<tx>", "acceptance:<tx>", ...). */
  evidence: string[];
}
```

## Semantics: `DIFFERENCE_CONFIRMED` means the customer's claim is TRUE
| Code | Claim | DIFFERENCE_CONFIRMED when | NO_DIFFERENCE_FOUND when | COULD_NOT_BE_CHECKED when |
|---|---|---|---|---|
| `A10` | "My agent never placed this order" | `signedOrderValid === false` | `signedOrderValid === true` (and if `allegedResource` is given and differs from `sale.resource`, the reason says the signature names `sale.resource`) | `signedOrderValid === null` |
| `A12` | "Charged twice for the same request" | another sale in `history` has the same `payer` **and** `requestHash`, a different `tx`, an **earlier** `settledAt`, and is within `duplicateWindowMs` of this one | no such earlier sale | `history` is empty, or does not contain this sale |
| `A13.1` | "Paid, got nothing" | no receipt, or `receipt.status >= 400` | receipt exists, status < 400, body hashes to `responseHash`, `anchored === true` | `anchored === null`, or the body does not hash to `responseHash` (reason: `receipt_tampered`) |
| `A13.3` | "Data not as described" | the quote breaks the signed acceptance criteria (stale, or deviation above max) | it meets them | no `acceptance`, no receipt, unparseable body, `reference === null`, or symbol mismatch |
| `A14` | "Price/payee wasn't the usual one" | `sale.amount` differs from `priceList[routeOf(resource)]`, or `sale.payee` is not `expectedPayee` | both match | route not in the price list |

The quote body is JSON: `{ "symbol": string, "price": number, "asOf": ISO-8601 string }`.
Staleness = `sale.settledAt - Date.parse(asOf)`. A negative staleness (quote from the future) is a difference.
`routeOf("GET /quote?symbol=TSLA")` is `"GET /quote"`.

## Exports (`court/checks.ts`)
```ts
export function checkClaim(claim: Claim, ctx: CheckContext): Finding;
export interface CheckContext {
  sale: Sale | null;              // null => COULD_NOT_BE_CHECKED, reason "sale_not_found"
  history: Sale[];                // all sales by this payer (for A12)
  reference: ReferencePrice;      // for A13.3
  priceList: Record<string, bigint>; // route -> price, for A14
  expectedPayee: `0x${string}`;
  duplicateWindowMs: number;
}
export function sha256Hex(s: string): string; // node:crypto
export function routeOf(resource: string): string;
```
`checkClaim` must never throw. Any unexpected error becomes `COULD_NOT_BE_CHECKED` with reason `internal_error:<message>`.

## Tests (minimum)
At least one test per row and state in the table above, plus:
- an A12 case where the duplicate is *later*: the earlier sale is not the duplicate;
- an A13.3 case with exactly `maxDeviationBps`, which passes (inclusive);
- an A13.1 case where the body was edited after hashing (`receipt_tampered`);
- `checkClaim` with `sale: null`.
