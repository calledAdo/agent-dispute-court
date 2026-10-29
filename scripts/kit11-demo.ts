// Kit 11 story against LIVE services. Do not run without the reviewer. Reads only env:
//   METAL_RPC_URL, SOURCING_CRED, SUPPORT_CRED, TREASURY_CRED (credential file PATHS),
//   AWX_CLIENT_ID, AWX_API_KEY, AWX_GLOBAL_ACCOUNT_ID, AWX_BENEFICIARY_ID,
//   OPERATOR_TOKEN, UPSTREAM_URL, SELLER_URL, SETTLEMENT_TX (hash of the earnings transfer),
//   OWNER_KEY (owner key file path), SOURCING_CRED_NEXT (new credential file path),
//   APPROVE=yes to apply the proposed limits.
import { createMetalCli } from "../agents/cli.ts";
import { planLimits, CENT } from "../agents/mandates.ts";
import { TreasuryAirwallexClient } from "../treasury/airwallex.ts";
import { Ledger, settleEarnings, payLicenceFee } from "../treasury/settle.ts";

function need(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`missing env ${name}`);
  return v;
}

async function main(): Promise<void> {
  const cli = createMetalCli();
  const sourcing = need("SOURCING_CRED");
  const upstream = need("UPSTREAM_URL");
  const seller = need("SELLER_URL");
  const N = 3;

  console.log("1. customer buys quotes (customer agent pays", seller + "/quote)");
  console.log("   run the buying agent separately; this script only drives the business agents");

  console.log("2. sourcing buys upstream at 0.02");
  for (let i = 0; i < N; i++) console.log("   ", (await cli.pay(`${upstream}/raw?symbol=AAPL`, sourcing)).status);

  console.log("3. operator raises upstream to 0.04");
  const r = await fetch(`${upstream}/admin/price`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-operator-token": need("OPERATOR_TOKEN") },
    body: JSON.stringify({ price: "0.04" }),
  });
  console.log("   admin status", r.status);
  const refused = await cli.pay(`${upstream}/raw?symbol=AAPL`, sourcing);
  console.log("   next purchase:", refused.status, "exit", refused.exitCode, refused.fields);
  if (refused.status !== "refused") console.log("   WARNING: expected a refusal (exit 1)");
  console.log("   tell the customer: HTTP 503 upstream_price_exceeds_mandate");

  console.log("4. planLimits");
  const state = {
    sourcing: { spent: 3n * 2n * CENT, budget: 10n * 100n * CENT, cap: 3n * CENT },
    support: { spent: 0n, budget: 4n * 100n * CENT, cap: 100n * CENT },
    treasury: { spent: 0n, budget: 6n * 100n * CENT, cap: 6n * 100n * CENT },
  };
  const plan = planLimits(state, 4n * CENT, 5n * CENT, 20n * 100n * CENT);
  console.log(JSON.stringify(plan, (_k, v) => (typeof v === "bigint" ? v.toString() : v), 2));
  if ("error" in plan) return;
  if (process.env.APPROVE !== "yes") {
    console.log("   set APPROVE=yes to apply; stopping");
    return;
  }
  console.log("   replace:", (await cli.replace({ credential: need("SOURCING_CRED_NEXT"), replaces: sourcing, key: need("OWNER_KEY") })).status);

  console.log("5. resume purchases");
  console.log("   ", (await cli.pay(`${upstream}/raw?symbol=AAPL`, sourcing)).status);

  console.log("6. treasury settles earnings and pays the licence fee");
  const client = new TreasuryAirwallexClient({ clientId: need("AWX_CLIENT_ID"), apiKey: need("AWX_API_KEY") });
  const ledger = new Ledger(new URL("../data/treasury-ledger.jsonl", import.meta.url).pathname);
  const s = await settleEarnings({ amountUsdz: 100n * CENT, metalTxHash: need("SETTLEMENT_TX"), ledger, client, globalAccountId: need("AWX_GLOBAL_ACCOUNT_ID") });
  console.log("   settled", s.replayed ? "(replay)" : "", s.usdCents, "cents");
  const f = await payLicenceFee({ eurAmount: 50, beneficiary: need("AWX_BENEFICIARY_ID"), invoiceId: "LIC-DEMO-1", ledger, client });
  console.log("   licence fee", f);
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
