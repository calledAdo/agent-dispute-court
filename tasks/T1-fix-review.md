# T1 review fixes

Change only `court/checks.ts` and `test/checks.test.ts`.

1. **Case-insensitive addresses.** Compare `payer` (A12) and `payee`/`expectedPayee` (A14) case-insensitively: lowercase both sides. Tests: a duplicate where one sale has a checksummed payer and the other a lowercase one is still found; A14 with a checksummed `expectedPayee` and a lowercase `sale.payee` passes.
2. **Wrong symbol delivered (A13.3).** Read the requested symbol from the signed request: the `symbol` query parameter of `sale.resource`, compared case-insensitively.
   - Requested symbol missing from `sale.resource` → `COULD_NOT_BE_CHECKED`, reason `requested_symbol_unknown`.
   - Delivered `quote.symbol` ≠ requested symbol → `DIFFERENCE_CONFIRMED`, reason `wrong_symbol`. Check this before the reference price is used; it needs no reference.
   - `reference.symbol` ≠ requested symbol → `COULD_NOT_BE_CHECKED`, reason `reference_symbol_mismatch`.
   - Add tests for all three.
3. Keep every other behaviour and test. `npm test` must pass.
