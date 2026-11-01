# T11: Inference providers (x402 sellers backed by Claude)

Three inference providers sell one AI step each over x402 on Metal: **Swift** (Haiku, cheap), **Sterling** (Sonnet, mid-priced) and **Summit** (Opus, premium). They are one program run three times with different env.

Each provider is a court-registered seller, exactly like DataCo:
- signed offers name the exact request, plus an `infer-v1` acceptance;
- every paid delivery is logged as a receipt;
- receipts are anchored with the existing `scripts/anchor.ts`.

Already done, do not rewrite: `shared/infer.ts` (`checkInferOutput`, `DEFAULT_INFER_ACCEPTANCE`, `InferOutput`) and the `InferAcceptance` type in `shared/types.ts`.

## Files

1. **`seller/offer.ts`.** Generalise `buildOffer` to take `route` (for example `"GET /infer"`) and `description`, and default both to the existing quote values so the quote seller is unchanged. `acceptance` is typed `Acceptance` (the union).

2. **`providers/server.ts`.** Write `createProvider(opts)` and a `main()`, modelled on `seller/server.ts`:
   - `requireSignedOffer` and `registerMetalScheme`;
   - a per-request `x402HTTPResourceServer`, so the offer names the request;
   - `onAfterSettle` appends a receipt (`buildReceipt`) to `RECEIPT_LOG`.

   **Paid route: `GET /infer?task=summary-v1&text=<url-encoded, at most 1500 chars>`.**
   - The resource is `canonicalRequest(...)` and the offer carries `DEFAULT_INFER_ACCEPTANCE`.
   - The handler calls Claude with:
     - the model from `PROVIDER_MODEL`;
     - `max_tokens: 2000`;
     - `output_config: { format: { type: "json_schema", schema } }` with schema `{ summary: string, keywords: string[] }`.

     Copy the text-block parsing and thinking-block skipping from `court/judge.ts` (`jsonOutput`); don't import judge.ts.
   - It returns `{ task: "summary-v1", requestHash: sha256Hex(resource), summary, keywords }`.
   - Clamp `summary` to `maxChars` and `keywords` to `maxKeywords`, so an honest provider always conforms.
   - If the model call fails, return 502 `{ error }` with sanitized text. x402 does not settle on 4xx/5xx, so the buyer is not charged.
   - `text` missing or over 1500 chars → 400 before any payment.

   **Free route: `GET /status`.** Returns
   ```json
   { "name": "Swift", "model": "claude-haiku-5-5", "price": "0.02", "payTo": "0x...", "acceptance": { ... } }
   ```
   - It is delayed by the current `statusDelayMs`.
   - The router uses it to discover the live price and to measure latency.

   **Operator route: `POST /admin` with header `x-operator-token`.** The body may hold any of:
   - `price`: a two-place decimal; validate with `isValidPrice` from `agents/upstream.ts`.
   - `statusDelayMs`: an integer from 0 to 30000. It simulates a provider that has become slow.
   - `fault`: one of `"none"` | `"empty"` | `"truncated"` | `"wrong_request"`, plus `faultCount` (an integer of at least 1).

   It returns the current state.

   **Faults.** A fault applies to the next `faultCount` *paid* responses, then resets to `"none"`. It changes the 200 body after the model call:
   - `empty`: `summary: ""`.
   - `truncated`: the JSON text cut at half its length. It is still sent with status 200 and content-type JSON, so it is not valid JSON.
   - `wrong_request`: `requestHash` of a different string.

   These are the "delivered but broken" cases that the court must decide by code. Payment still settles, because the status is 200.

   **Env:**
   - `PROVIDER_NAME`, `PROVIDER_MODEL`, `PROVIDER_PRICE` (default "0.02");
   - `PROVIDER_PAY_TO`, `METAL_RPC_URL`, `ANTHROPIC_API_KEY`, `OPERATOR_TOKEN`;
   - `RECEIPT_LOG`, `PORT`.

   The Anthropic client is injected through `opts`, so tests never hit the network.

3. **`scripts/providers.sh` is not needed.** Instead, document the three launch commands in a comment at the top of `providers/server.ts`. Ports and prices:

   | Provider | Port | Model | Price |
   |---|---|---|---|
   | Swift | 4061 | claude-haiku-5-5 | 0.02 |
   | Sterling | 4062 | claude-sonnet-5-5 | 0.03 |
   | Summit | 4063 | claude-opus-5-5 | 0.06 |

4. **Tests (`test/providers.test.ts`).** Use supertest-style requests through `app.listen(0)` with the x402 middleware bypassed. Follow how `test/seller.test.ts` handles that; read it first.
   - `/status` shape and delay.
   - Admin: auth, validation, and the fault counting down.
   - Each fault produces a body that `checkInferOutput` rejects with the expected violation.
   - An honest response passes `checkInferOutput`.
   - Clamping works.
   - A model failure gives 502.
   - Bad `text` gives 400.
   - `buildOffer` defaults keep the quote seller's offer byte-identical (compare against the old output).

## Constraints
- Never log keys or the RPC URL. Errors go through the same redaction style as `court/api.ts` `sanitizeError`.
- Do not read `.env` or key files in tests.
- Run `npm test` and report the count.
