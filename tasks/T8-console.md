# T8: Court console (web UI)

A single-page console served by the court API, for the demo video and for operators. **The judges will see this.** It must look like a serious financial product: calm, precise and legible.

## Delivery
- `console/index.html`, `console/app.js` and `console/styles.css`: plain HTML, CSS and ES modules. No framework, no build, and no external scripts or fonts (offline-safe). Served by `court/api.ts` at `GET /console/*` (add a static route; touch only that part of api.ts).
- `GET /` redirects to `/console/`.

## Screens
1. **Docket (left column):** cases newest first, with status chips (RUNNING, AWAITING_HUMAN, DECIDED, PUBLISHED, CLOSED, FAILED), claim counts, total refund, and filed time. It polls `GET /cases` every 3 s.
2. **Case view (main):**
   - **Header:** case id, payer (shortened, with a copy button), filing fee tx, fee outcome (refunded or forfeited), and status.
   - **Complaint:** the customer's text, rendered as **text** (never `innerHTML`), with an "Untrusted input" label.
   - **Claims table,** one row per claim:
     - reason code with its plain-English name (A10 "Not authorized", A12 "Duplicate", A13.1 "Not received", A13.3 "Not as described", A14 "Offer drift") and its Visa analogue (10.4, 12.6.1, 13.1, 13.3, none);
     - the finding state as a 3-state badge;
     - the verdict;
     - liable party;
     - refund;
     - **decided by** (code, model or human, each with a distinct icon).
   - **Evidence drawer per claim:**
     - the signed request (`resource`);
     - signed acceptance criteria;
     - delivered body (pretty JSON);
     - response hash, anchored ✓/✗;
     - links to the explorer `https://testnet.metalntwx.com/tx/<hash>` for the payment, the anchor, the ruling and the refund tx;
     - for model decisions, the rationale and cited evidence keys.
   - **Human approval panel** for ESCALATE rulings:
     - shows `proposedRefund` formatted as *USDZ;
     - Approve refund / Reject buttons send `POST /cases/:id/approve` with the exact `amount` string shown, `approver`, and the operator token from a field kept in `sessionStorage`. **Never put the token in the URL**;
     - show 409/401 errors inline.
   - **Remedy:** Publish and Execute buttons (operator), with the per-claim result list (`published`, `not_yet` with a countdown to `executableAt` when known, `paid`, `already_paid`, `objected`, `failed`) and the fee-refund tx.
3. **Format:** bigint strings → `*USDZ` with up to 4 decimals (18-decimal base units). Times are local and relative.

## Design
- Neutral light theme with a dark-mode media query.
- One accent colour, and status colours used only for status.
- Tabular numerals for amounts. Base type size 14–15px.
- Keyboard focus visible. Works at 1280px and degrades to a single column under 900px.
- Empty and loading states.
- No emojis. Use inline SVG icons for code, model and human.

## Tests
`test/console.test.ts`: GET `/console/` returns HTML with a CSP-friendly structure (no inline event handlers), and `/` redirects. Add pure helper tests if you put the formatting helpers in `console/format.js` (import them from the test).
