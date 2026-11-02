# T12: Sourcing agent with recourse (router, reputation, auto-dispute) and its demo

A buyer agent runs a multi-step job by purchasing each step from the best inference provider. It:
- reroutes on a price spike or a slow provider;
- checks every delivery against the signed `infer-v1` standard;
- **files a dispute with the court by itself** when a paid delivery is broken;
- routes by court-derived reputation, so providers that lose cases get used less.

Read first:
- `shared/infer.ts`;
- `agents/cli.ts` (`pay`, `parseUsdz`, `formatUsdz`);
- `scripts/demo.ts` (how the dispute is filed and polled; reuse its helpers, and move shared ones to `scripts/lib.ts` if needed);
- `tasks/T10-court-multiseller.md` and `tasks/T11-providers.md` for the court and provider APIs.

## Files

1. **`agents/router.ts`.** Pure logic, no I/O.
   ```ts
   export interface ProviderStatus { name: string; url: string; price: string; payTo: `0x${string}`; latencyMs: number | null } // null = timed out
   export interface Reputation { address: string; claims: number; upheld: number }
   export interface RouteDecision { chosen: ProviderStatus | null; ranked: { name: string; score: number | null; excluded?: string }[] }
   export function rank(providers: ProviderStatus[], rep: Reputation[], opts: { maxPrice: string; maxLatencyMs: number; avoid?: string[] }): RouteDecision
   ```
   - **Excluded**, with the reason in `excluded`:
     - `latencyMs === null` or above `maxLatencyMs` → `"slow"`;
     - price above `maxPrice` → `"over_cap"`;
     - the name is in `avoid` (a provider that already failed this step) → `"failed_this_step"`.
   - **Score** (lower is better): `priceBase * (1 + 2 * lossRate)`, where `lossRate = upheld / max(claims, 1)` for the provider's address (case-insensitive), or 0 if it has no record.
     - Prices go through `parseUsdz` (bigint). Compute the score with integer math, scaled by 1000: `price * (1000 + 2000 * upheld / max(claims,1)) / 1000` as bigint.
     - Ties break by name.
   - `chosen` is the lowest-scoring provider that is not excluded, or null.
   - The reason for the 2x weight: a provider that loses every dispute costs three times its sticker price. Mention this in a one-line comment.

2. **`agents/sourcing.ts`.** The I/O loop, with every dependency injected (fetch, cli, clock) so it is testable.
   - `probe(urls, timeoutMs)`: `GET /status` for each provider in parallel, using `AbortController`. Latency is measured, and null on timeout or error.
   - `reputation(courtUrl)`: `GET /reputation` from the court. On any error, return `[]` and never throw. The router still works, with no reputation.
   - `runStep(step, ctx)`:
     1. Probe, then rank with `avoid = []`.
     2. Pay the chosen provider with `cli.pay(url + "/infer?task=summary-v1&text=" + encodeURIComponent(text), cred)`.
     3. Run `checkInferOutput(body, sha256Hex(resource), DEFAULT_INFER_ACCEPTANCE)`, where `resource` is `canonicalRequest("GET", "/infer", { task, text })`.
     4. On a violation:
        - record `{ step, provider, tx, violation }` as a bad delivery;
        - add the provider to `avoid`, then re-rank and retry **once per remaining provider**.

        A step pays at most 3 times. If all fail, the step fails.
     5. A CLI `refused` (on-chain mandate cap) is recorded as `{ refused: code }`. Exclude that provider for this step and continue. Do not treat it as a bad delivery: no money moved.
     6. Return `{ step, provider, tx, ok, attempts: [...] }`.
   - `fileDisputes(badDeliveries, ctx)`:
     - Group the bad deliveries by provider and file **one dispute per provider** through `cli.pay(courtUrl + "/disputes", cred, { method: "POST", body })`, with body `{ complaint, payer, txs, seller }`.
     - The complaint is generated deterministically, with no LLM. Example: *"Step 3 (summary of 'Q3 revenue memo') from Sterling, tx 0xabc…: the delivered output failed the signed summary-v1 standard (body_unparseable)."* Use one line per delivery.
     - Return the case ids.

3. **`scripts/sourcing-demo.ts`.** A one-take orchestrated demo in the style of `scripts/demo.ts`: `Step N:` lines, short indented details, `DEMO_PAUSE_MS`, `DEMO_APPROVE`, and a run summary written to `data/sourcing-run.json`.

   **Env:**
   - `PROVIDER_URLS` (comma-separated), `COURT_URL`, `CUSTOMER_CRED`, `CUSTOMER_ACCOUNT`, `OPERATOR_TOKEN`;
   - `PROVIDER_KEY_FILES` (comma-separated, same order), plus `COURT_VAULT` and `METAL_RPC_URL`, for the reserve check and anchoring;
   - `STEP_MAX_PRICE` (default "0.05") and `STEP_MAX_LATENCY_MS` (default 2000).

   **The job:** summarise 6 short built-in business documents. Keep each under 600 chars: an invoice dispute email, a Q3 revenue memo, a supplier delay notice, a policy update, an incident report and a contract renewal note.

   **Steps:**
   1. **Reserves.** For each provider, make sure it has at least 0.2 *USDZ held in `CourtVault`, topping up by 0.5 if needed. Reuse the logic from step 1 of demo.ts, generalised to take a key file.
   2. **Market.** Probe and print a table: name, model, price, latency, court record (`upheld/claims`).
   3. **Docs 1–2.** They go to Swift, the cheapest. Print the provider, price, tx and a one-line summary.
   4. **Price spike.** `POST /admin {price:"0.07"}` to Swift (above the 0.05 cap). Doc 3 reroutes to Sterling. Print why: `Swift excluded: over_cap`.
   5. **Broken delivery.** Set Sterling `fault: "truncated", faultCount: 1`. Doc 4: Sterling is paid and returns a broken body. The router detects it (`body_unparseable`) and re-buys from Summit. Print both txs.
   6. **Slow provider.** Set Summit `statusDelayMs: 5000`. Doc 5: Summit is excluded as `slow`, so it goes to Sterling (the only option within cap). Then reset Summit's delay to 0.
   7. **Recourse.** File the dispute against Sterling for the doc 4 tx. Print the case id and fee tx.
   8. **Anchor** Sterling's receipts before filing: move this to just before step 7, so the receipt is provable. Use the anchor logic as a function, with Sterling's receipts log and key.
   9. **Verdict.**
      - Poll the case until it leaves RUNNING; print the claim → finding → verdict → decided-by table.
      - Then publish, count down the objection window, and execute, exactly as demo.ts does.
      - Print the refund tx and the fee refund.
   10. **Reputation updates.** Re-fetch `/reputation`, then reset Swift's price to 0.02. Doc 6:
       - Swift wins again on price (Swift has a clean record).
       - Then print the ranking table to show Sterling's score is now raised by its loss: 0.03 × 3 = 0.09, which is worse than Summit's 0.06.
   11. **Summary.**
       - Docs completed, total spent, refunds recovered, net cost.
       - The per-provider table.
       - Write `data/sourcing-run.json`.

   Any CLI `error` stops the script with a clear message. A `refused` result is shown, not fatal.

4. **Tests (`test/router.test.ts`).**
   - `rank`:
     - each exclusion reason;
     - reputation weighting, including the 0.03 → 0.09 case;
     - the tie-break;
     - bigint math with no float;
     - no providers → null.
   - `runStep` with a fake cli and fetch:
     - success;
     - broken then rerouted;
     - all broken;
     - refused then rerouted;
     - at most 3 payments.
   - `fileDisputes`: grouping and complaint text.
   - The probe timeout.

## Constraints
- All amounts are bigint; `formatUsdz` is only for display.
- Never print keys, credentials or the RPC URL.
- Tests never touch the network or key files.
- Run `npm test` and report the count.
