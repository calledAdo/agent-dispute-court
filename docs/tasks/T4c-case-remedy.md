# T4c: Case runner and on-chain remedy

Wire T1 (checks), T4a (evidence) and T4b (verdict/judge) into one case, then execute refunds through `CourtVault` (`contracts/CourtVault.sol`, ABI in `contracts/build/CourtVault.json`).

## Files
### `court/case.ts`
```ts
export interface CaseInput { id: string; complaint: string; payer: `0x${string}`; txs: `0x${string}`[]; buyerOrders?: Record<string, string> }
export interface CaseDeps { evidence: EvidenceDeps; model: { client: ModelClient; name: string } | null; policy: Policy;
  reference: (symbol: string, at: number) => Promise<ReferencePrice>; priceList: Record<string, bigint>; duplicateWindowMs: number; now: () => number }
export interface CaseResult { id: string; claims: Claim[]; findings: Finding[]; rulings: Ruling[]; refundFee: boolean; summary: string; evidence: Record<string, unknown> }
export async function runCase(input: CaseInput, deps: CaseDeps): Promise<CaseResult>;
```
Steps:
1. `assembleHistory` for every tx.
2. `intake` turns the complaint into claims; with `model === null`, use a fixed fallback (an `A13.3` claim per tx).
3. For each claim, `checkClaim`.
4. Only for `A13.3` + `COULD_NOT_BE_CHECKED`, and only when the model is available, call `judgeQuality`.
5. `decide`, `settleFilingFee`, and `explain` for the summary.

`expectedPayee` is `evidence.seller`. `reference` is fetched per sale for `A13.3`, using the symbol from the signed resource and `settledAt`.

### `court/remedy.ts`
```ts
export interface RemedyDeps { publicClient: PublicClient; walletClient: WalletClient; vault: `0x${string}`; vaultAbi: Abi; seller: `0x${string}`; evidenceRoot: (r: Ruling) => `0x${string}` }
export async function publishRulings(rulings: Ruling[], payerOf: (tx: string) => `0x${string}`, deps: RemedyDeps): Promise<{ tx: string; status: "published" | "skipped" | "already_ruled"; hash?: string }[]>;
export async function executeDue(txs: string[], deps: RemedyDeps): Promise<{ tx: string; status: "paid" | "not_yet" | "objected" | "already_paid" | "failed"; hash?: string }[]>;
```
- Publish only `REFUND` rulings with `refund > 0n`: `rule(paymentTx, seller, payer, refund, code, evidenceRoot)`. `paymentTx` is the bytes32 tx hash.
- **Idempotent:** read `rulings(paymentTx)` first; if state ≠ 0, report `already_ruled` and send nothing.
- `executeDue`: read the ruling, then:
  - state 1 and `now >= executableAt` → `execute`;
  - state 1 and too early → `not_yet`;
  - state 2 → `already_paid`;
  - state 3 → `objected`.
- **Metal gas:** every write passes `gas: 400000n, maxFeePerGas: 1n, maxPriorityFeePerGas: 1n`.
- Simulate before each write. A revert becomes `failed` with its reason; never throw out of the loop.
- Use block time for "now" (`getBlock({ blockTag: "latest" }).timestamp`).

### `court/store.ts`
JSONL case store in a directory passed in: `save(result)`, `get(id)`, `list()`. BigInts serialize as strings with an `n` suffix and parse back.

### Tests: `test/case.test.ts`, `test/remedy.test.ts`
No network: stub the clients. Cover:
- the full case with a stubbed model;
- the no-model fallback;
- publish skipping non-refunds;
- `already_ruled` idempotency;
- each `executeDue` state;
- a revert becoming `failed`;
- the store round-trip with bigints.

## Out of scope
HTTP API (T6), console, keys.
