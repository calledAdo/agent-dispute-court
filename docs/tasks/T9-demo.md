# T9: One-take demo orchestration

A single script that stages the whole court story live, prints clean numbered narration for the video, and records every tx hash.

## Changes
1. **`seller/server.ts`:** read `SELLER_FAULTS` from env in `main`, e.g. `stale:TSLA,wrong:MSFT`, and pass it as `faults` (`staleSymbols` / `wrongSymbols`). Keep `RECEIPT_LOG` support.
2. **`scripts/anchor.ts`:** anchors every receipt in `SELLER_RECEIPTS` that is not yet anchored, as one new batch.
   - Reuse `mapBatches` from `court/main.ts`. Move it to `shared/batches.ts` if needed, and keep `court/main.ts` importing it.
   - Read the existing `DeliveriesCommitted` events (chunked log scan from `COURT_LEDGER_FROM_BLOCK`, as in main.ts). The unanchored tail is everything after the total `count` already committed.
   - It uses `seller/anchor.ts` `anchorBatch` with the seller key from `SELLER_KEY_FILE` (a path).
   - Print the batch number, root, tx and the count. If there is nothing to anchor, print that and exit 0.
3. **`agents/cli.ts`:** `pay(url, credential, { method?, body?, headers? })` passes `--method`, `--body` and `--header` (see `tasks/metal-agent-help.txt`, under pay). Parse `body` and `transaction` from the output. Add tests.
4. **`scripts/demo.ts`:** the orchestrator. Env:
   - `SELLER_URL`, `COURT_URL`, `CUSTOMER_CRED`, `CUSTOMER_ACCOUNT`, `OPERATOR_TOKEN`;
   - `SELLER_KEY_FILE`, `COURT_VAULT`, `METAL_RPC_URL` (for the reserve check and anchoring);
   - `DEMO_PAUSE_MS` (default 1500, pause between narrated steps);
   - `DEMO_APPROVE=yes` (auto-approve escalations, as the operator would in the console).

   Steps, each printed as `Step N: <one line>` with short indented details:
   1. **Reserve check.** Read `heldBalanceOf(seller, vault)`. If it is below 0.5 *USDZ, top it up by 1 *USDZ: the seller approves the vault, then calls `vault.reserve` (Metal gas rules: `gas`, `maxFeePerGas: 1n`, `maxPriorityFeePerGas: 1n`). Print the held amount.
   2. **Purchases.** The customer agent buys `AAPL`, `AAPL` again (the duplicate), `TSLA` (served stale), `MSFT` (served 3% off), `NVDA` and `GOOG`. For each, print symbol, amount and the short tx, and keep the full tx in a map.
   3. **Anchor** the new receipts (call the anchor logic as a function, not a subprocess).
   4. **File the dispute** through `cli.pay(COURT_URL + "/disputes", CUSTOMER_CRED, {method: "POST", body})`. The complaint text: *"My agent never asked for NVDA, it wanted AMD. I was charged twice for AAPL. The TSLA quote was stale and the MSFT price was wrong. And GOOG just felt off to me."* `txs` = all six txs. Print the case id and the fee tx.
   5. **Wait for the decision.** Poll `GET /cases/:id` until it leaves RUNNING (timeout 120 s). Print a table: claim → code → finding → verdict → decided by → refund.
   6. **Human approval.** For each ESCALATE with `proposedRefund > 0`, if `DEMO_APPROVE=yes`, POST approve with the exact `proposedRefund` string and decision REFUND, and print that it is bound to that amount. Otherwise print the console URL and wait until no escalations remain.
   7. **Publish rulings,** then print each published ruling's tx.
   8. **Objection window.** Read `objectionWindow()` from the vault and count down in place (one line, updating every second).
   9. **Execute.** Print each refund tx and the fee-refund tx.
   10. **Summary.** Total refunded and the buyer's balance delta. Write `data/demo-run.json` with every tx hash, the case id and timings.

   All money logic stays in the existing modules; the script only orchestrates. Any CLI `error` result stops the script with a clear message.
5. **Tests:** cli pay options and parsing, the `SELLER_FAULTS` parser, and the anchor tail computation (pure function: given committed counts and the receipts length, which indexes to anchor).

Never read `.env` files or key contents in tests. The script reads keys only from paths.
