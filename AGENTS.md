# Agent Dispute Court: engineering rules

You are implementing one task at a time for the Agent Dispute Court. A senior engineer reviews every change. Read this file and the task file you are given before you write code.

## What the product is
A seller (DataCo) sells market data per request over x402 on Metal testnet. The buying agent signs an order for the exact request. Each delivery is logged as a receipt and anchored on chain as a Merkle root. When a customer disputes charges, the court decides each claim from evidence. Refunds are paid from a seller reserve through the `CourtVault` contract (see `contracts/`).

## Hard rules
- Runtime: Node 26, ESM, **TypeScript run natively by Node** (type stripping). Only *erasable* TypeScript: no `enum`, no `namespace`, no parameter properties. Import local files with the `.ts` extension.
- No new dependencies unless the task allows them. Tests use `node:test` and `node:assert/strict`.
- Never read, create or ask for secrets, private keys or `.env` files. Code takes config via function arguments or `process.env` names given in the task.
- Money is always `bigint` in base units (18 decimals for *USDZ). Never use floating point for amounts.
- Pure logic must be deterministic: pass the current time in (`now: number`, ms) instead of calling `Date.now()` inside it.
- Code decides facts (signatures, amounts, duplicates, deadlines). The model (Claude) never overrides a code finding.
- Every check returns one of three states: `DIFFERENCE_CONFIRMED`, `NO_DIFFERENCE_FOUND`, `COULD_NOT_BE_CHECKED`. `COULD_NOT_BE_CHECKED` always carries a reason. An unchecked claim must never look like a rejected one.
- Keep functions small, named for what they decide, and commented only where the reason is not obvious.
- Do not modify files outside the task's scope. Do not touch `contracts/` unless asked.

## When you finish
Run `npm test`. All tests must pass. End with a short list of the files you changed and anything you were unsure about.
