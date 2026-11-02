# T13: Split the product from the demos (npm workspaces)

The repository is one flat package. Restructure it so the **product** (the court service, the contracts and two SDKs) is separate from the **examples and demos**. Behaviour must not change. This is moves, splits and import paths only.

## Rules
- Use `git mv` for every move, so history is kept. Commit nothing; I review and commit.
- Do not change logic. The only allowed code edits are import paths, `package.json` files, re-exports, and the two splits described below.
- The tests are the safety net. Run `npm test` from the root after each phase. The count must stay **251 passing**, or report exactly why it changed.
- Never read or print `.env*` files or anything in `keys/`.
- Node 26 runs `.ts` files directly (type stripping). Keep explicit `.ts` extensions in imports. Do not add a build step, tsconfig paths or a bundler.

## Target layout

```
package.json                 root: "private": true, "workspaces": ["packages/*", "apps/*", "examples/*"]
packages/
  protocol/   name @dispute-court/protocol
    src/  ← shared/types.ts, shared/merkle.ts, shared/chain.ts, shared/batches.ts, shared/infer.ts
    index.ts  re-exports the public API of every src file
  seller/     name @dispute-court/seller
    src/  ← seller/offer.ts, seller/receipts.ts, seller/anchor.ts, plus the generic middleware split out of seller/server.ts (see Split 1)
    index.ts
  buyer/      name @dispute-court/buyer
    src/  ← agents/cli.ts, agents/router.ts, agents/sourcing.ts
    index.ts
  contracts/  name @dispute-court/contracts
    ← contracts/ (CourtLedger.sol, CourtVault.sol, build/), scripts/compile.ts
apps/
  court/      name @dispute-court/court   (the deployable service)
    src/      ← court/*.ts (move court/spike-verify.mjs to examples/demos/spikes/)
    console/  ← console/*
    card/     ← card/*
examples/
  dataco/     name @dispute-court/example-dataco
    ← seller/quotes.ts, the DataCo quote server (Split 1), seller/spike-seller.mjs, agents/upstream.ts, agents/mandates.ts, treasury/*
  inference-providers/   name @dispute-court/example-inference-providers
    ← providers/server.ts
  demos/      name @dispute-court/demos
    ← scripts/demo.ts, sourcing-demo.ts, kit11-demo.ts, card-demo.ts, lib.ts, anchor.ts, setup-beneficiary.ts, smoke-*.ts
docs/tasks/  ← tasks/*
```

- Each workspace `package.json`: `"type": "module"`, `"private": true` (we are not publishing yet), `"exports": { ".": "./index.ts" }` for packages, and only the dependencies its files import. Cross-workspace dependencies use `"@dispute-court/protocol": "*"`.
- Imports between workspaces use the package name (`import { ... } from "@dispute-court/protocol"`). Imports inside one workspace stay relative.
- `agents/upstream.ts` exports `isValidPrice`, which `providers/server.ts` uses. Move `isValidPrice` into `@dispute-court/protocol` (a `src/price.ts`) and import it from there in both places. This is the one allowed function move.

## Split 1: `seller/server.ts`
- **Generic part** → `packages/seller/src/server.ts`: everything that is not quote-specific (signed-offer requirement, metal scheme registration, the per-request resource server, receipt logging in `onAfterSettle`), exported as a function that takes the route, price, acceptance and a handler. Look at how `providers/server.ts` repeats the same pattern. If both can use the new helper without logic changes, switch them both. If that needs a logic change, **do not** switch `providers/server.ts`; leave it as is and say so.
- **DataCo part** → `examples/dataco/server.ts`: the `/quote` route, `makeQuote`, faults and `main()`.
- If the split cannot be done without changing behaviour, move the whole file to `examples/dataco/server.ts` instead, export the reusable pieces it already has, and report that.

## Split 2: none needed for sourcing
`agents/sourcing.ts` is already the reusable loop; `scripts/sourcing-demo.ts` is the demo. Just move them.

## Tests
- Move each test next to the code it tests, into a `test/` folder inside that workspace.
- Root `npm test` runs every workspace's tests: `node --test` with explicit globs, or `npm test --workspaces`. Pick one, and make sure the total is 251.
- `test/console.test.ts` and `test/demo.test.ts` go with what they test (apps/court and examples/demos).

## Runtime paths
- Code that defaults to files via `new URL("../data/...", import.meta.url)` must keep resolving to the **repository root `data/`** after the move. Fix the relative depth (for example `../../../data/`). `data/` stays at the root.
- The `console/` static dir in `court/api.ts` must still resolve.
- The contract build output path used by the scripts must still resolve.

## Also update
- `README.md`: the "Repository" section and every command or path that changed (for example `node court/main.ts` becomes `node apps/court/src/main.ts`). Add a short "Packages" table: name, what it is, product or example.
- `AGENTS.md`: the paths.
- `../video/*.sh`: the script paths (`node scripts/demo.ts` → `node examples/demos/demo.ts`, `court/main.ts`, `providers/server.ts`, and so on). These files are outside the repo; edit only the paths in them.
- Root `package.json` scripts: `test`, `compile`, and add `court` (start the court), `demo`, `demo:sourcing`.

## Done when
- `npm install` succeeds at the root, so the workspaces are linked.
- `npm test` gives 251 passing.
- `node --check` style smoke: `node -e "import('@dispute-court/protocol')"`, and the same for seller and buyer.
- Starting the court resolves its imports: run `node apps/court/src/main.ts` with no env, which must fail only on missing env, not on a missing module.
- `git status` shows renames, not deletes plus adds.
- Report: the final tree (2 levels), the test count, any file you could not place, and anything you left unswitched.
