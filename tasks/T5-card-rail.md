# T5: Airwallex card rail (Kit 4)

The same court decides ordinary card chargebacks through Airwallex's sandbox. **Read the Kit 4 notes below carefully; they come from Airwallex's own guide.**

## Verified live on our sandbox (Oct 29)
- `POST /api/v1/pa/payment_intents/create` `{request_id, amount, currency, merchant_order_id}` → 201.
- `POST /api/v1/pa/payment_intents/{id}/confirm` `{request_id, payment_method: {type:"card", card:{number:"4035501000000008", expiry_month:"12", expiry_year:"2030", cvc:"123", name}}}` → `status: "SUCCEEDED"`.
- `POST /api/v1/simulation/pa/payment_disputes/create` `{payment_intent_id, reason_code:"13.1", stage:"RFI", due_at:<ISO>}` → 201 with `{id: "dst_…", stage, status: "REQUIRES_RESPONSE", amount, currency, …}`.
- `GET /api/v1/pa/payment_disputes` lists them.

## Kit 4 rules (from Airwallex)
- Base URL `https://api.sandbox.airwallex.com/api/v1`. Log in with `POST /authentication/login`, headers `x-client-id`/`x-api-key`, no body. The 30-minute bearer token is cached and refreshed.
- Amounts are **major units**. Every create needs a fresh `request_id` UUID, reused only on retry.
- Use REST for accept/challenge (`POST /pa/payment_disputes/{id}/accept`, `/challenge`). Look up the exact body fields and the accept/challenge reason enums with the Airwallex docs MCP (`https://mcp.sandbox.airwallex.com/docs`) or https://www.airwallex.com/docs/api/payments/payment_disputes/challenge.md. Record the fields you used in a comment.
- Evidence upload: `POST /api/v1/files/upload` on **`https://files.sandbox.airwallex.com`**, JPG or PDF only (PNG is rejected).
- The challenged case starts at `RFI`. Challenge it, then `POST /simulation/pa/payment_disputes/{id}/escalate` moves it to `CHARGEBACK`, where it is back in `REQUIRES_RESPONSE` (the "bank rejected our evidence" beat). Escalating from `CHARGEBACK` fails. `PRE_CHARGEBACK` auto-accepts, so never use it.
- `POST /simulation/pa/payment_disputes/{id}/resolve` exists for the end state.
- The sandbox does not charge a dispute fee. **Configure it in code** (`disputeFee`, default USD 15).
- Rate limit: 10 req/s per endpoint. Back off on 429.

## Files
- `card/airwallex.ts`: `AirwallexClient({ clientId, apiKey, baseUrl?, filesUrl?, fetch? })`. `fetch` is injected for tests. Methods: `login`, `createPaymentIntent`, `confirmWithTestCard`, `simulateDispute`, `listDisputes`, `getDispute`, `uploadEvidencePdf(bytes, name)`, `acceptDispute`, `challengeDispute`, `escalate`, `resolve`. All sandbox-only simulation calls live in one clearly marked section.
- `card/decide.ts`: pure, deterministic. `decideCard(d: { amount: number; currency: string; reasonCode: string; evidence: CardEvidence }, policy: { disputeFee: number; minWinProbability: number }): { action: "CHALLENGE" | "ACCEPT" | "ESCALATE"; winProbability: number; expectedValue: number; reason: string }`. This is Kit 4's evidence-versus-cost logic:
  - `CardEvidence` = `{ deviceMatchesPriorOrders?: boolean; priorUndisputedOrders?: number; deliverySigned?: boolean; deliveryScanned?: boolean; customerContactedSupport?: number; supportReplied?: boolean }`.
  - **Win probability by reason code:**
    - `10.4` (fraud): rises with a device match, ≥ 3 prior undisputed orders, and a signed delivery.
    - `13.1` (not received): rises with a signed delivery, and only slightly with a scan.
    - `13.6` (credit not processed): **ESCALATE** if the customer contacted support and got no reply.
  - `EV(challenge) = p × amount − disputeFee`; `EV(accept) = −amount`. Challenge only if `EV(challenge) > EV(accept)` and `p ≥ minWinProbability`; otherwise accept, unless a rule says escalate.
  - Document the probability table in code.
- `card/evidence-pdf.ts`: builds a minimal valid single-page PDF from text lines, by hand (a PDF is plain text objects plus an xref table). No new dependency.
- `scripts/card-demo.ts`: runs the three Kit 4 cases end to end against the sandbox: a large fraud claim with strong evidence (CHALLENGE, then escalate, then REQUIRES_RESPONSE again), a small not-received claim (ACCEPT), and credit-not-processed (ESCALATE). It reads `AWX_CLIENT_ID`/`AWX_API_KEY` from `process.env` only and prints each decision and API result. **Do not run it**; the reviewer runs it with real keys.
- `test/card.test.ts`: `decideCard` for all three scenarios and the edge cases; `AirwallexClient` with a stub `fetch` (login caching, `request_id` present, base URLs, the files host for upload); the PDF starts with `%PDF-` and ends with `%%EOF`.

## Out of scope
Real network in tests, reading any `.env` file.
