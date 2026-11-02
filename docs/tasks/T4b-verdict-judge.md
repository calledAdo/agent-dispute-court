# T4b: Verdicts, liability and the Claude judge

Turn findings (T1) into rulings. Claude is used for two narrow jobs: **intake** and **residual judgment**.

## Allowed dependency
`@anthropic-ai/sdk` (latest). The model id comes from `process.env.COURT_MODEL`, default `"claude-sonnet-5-5"`. The API key comes from `ANTHROPIC_API_KEY`, read by the SDK itself. Never log it.

## Files

### `court/verdict.ts` (pure, deterministic)
```ts
export type Verdict = "REFUND" | "REJECT" | "ESCALATE";
export type Liable = "SELLER" | "PRINCIPAL" | "NONE";
export interface Ruling { claimId: string; tx: string; code: ReasonCode; verdict: Verdict; liable: Liable; refund: bigint; reason: string; evidence: string[]; decidedBy: "code" | "model" | "human" }
export interface Policy { autoRefundMax: bigint; escalateAbove: bigint; filingFee: bigint }
export function decide(f: Finding, sale: Sale | null, policy: Policy, judgment?: Judgment): Ruling;
```
Rules, applied in this order:
1. `sale === null` → `ESCALATE`, liable `NONE`, refund 0.
2. `DIFFERENCE_CONFIRMED`:
   - `A10`, `A12`, `A13.1`, `A13.3` → `REFUND` of `sale.amount`, liable `SELLER`;
   - `A14` → `REFUND`, liable `SELLER`;
   - if `sale.amount > policy.escalateAbove`, the verdict is `ESCALATE` instead (same liable). `decidedBy: "code"`.
3. `NO_DIFFERENCE_FOUND` → `REJECT`, liable `PRINCIPAL` for `A10` (its own agent signed), `NONE` otherwise. `decidedBy: "code"`.
4. `COULD_NOT_BE_CHECKED`:
   - with a `judgment` (only allowed for `A13.3`): `confidence >= 0.8` and `upheld` → `REFUND` (subject to the escalate cap); `confidence >= 0.8` and not upheld → `REJECT`; otherwise `ESCALATE`. `decidedBy: "model"`.
   - without a judgment → `ESCALATE`.
   - **Never REJECT an unchecked claim without a judgment.**
5. The model can never turn a code `REJECT`/`REFUND` into something else. `decide` ignores `judgment` unless the state is `COULD_NOT_BE_CHECKED` and the code is `A13.3`.

Also export `settleFilingFee(rulings: Ruling[], policy): { refundFee: boolean }`: the fee is refunded if any ruling in the case is `REFUND`.

### `court/judge.ts`
```ts
export interface Judgment { upheld: boolean; confidence: number; rationale: string; citedEvidence: string[] }
export interface ModelClient { messages: { create(args: unknown): Promise<unknown> } } // subset of Anthropic SDK; injected
export async function intake(text: string, sales: { tx: string; resource: string; settledAt: number }[], client: ModelClient, model: string): Promise<Claim[]>;
export async function judgeQuality(claim: Claim, evidence: Record<string, unknown>, complaint: string, client: ModelClient, model: string): Promise<Judgment>;
export function explain(rulings: Ruling[]): string; // deterministic plain-English summary, no model
```
- Use **tool use with a forced tool** (`tool_choice: { type: "tool", name }`) for structured output. Validate the tool input strictly:
  - `intake`: drop claims whose `tx` is not in `sales`. Map the complaint to codes: "never asked / didn't order" → `A10`; "charged twice" → `A12`; "got nothing / error" → `A13.1`; "wrong / stale / bad data" → `A13.3`; "price or payee looked off" → `A14`. Set `allegedResource` when the text names a different symbol.
  - `judgeQuality`: clamp `confidence` to [0, 1]; `citedEvidence` must be keys present in `evidence`, otherwise drop them. If the response is malformed, return `{ upheld: false, confidence: 0, rationale: "model_output_invalid", citedEvidence: [] }`, which `decide` turns into `ESCALATE`.
- The system prompts must state that cryptographic findings are final and the model only weighs data quality.

### `test/verdict.test.ts` and `test/judge.test.ts`
No network. Stub `ModelClient`. Cover every rule above. Test the "model can't override code" rule explicitly. For intake, cover dropping an unknown tx and the `allegedResource` extraction.

## Out of scope
On-chain refunds (T4c), HTTP API.
