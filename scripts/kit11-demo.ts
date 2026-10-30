// Kit 11 story against LIVE services. Do not run without the reviewer. Reads only env:
//   METAL_RPC_URL
//   SOURCING_CRED, SUPPORT_CRED, TREASURY_CRED   credential file paths (keys sit beside them as <name>.key.json)
//   SOURCING_CAP, SUPPORT_CAP, TREASURY_CAP      per-payment caps, decimal *USDZ (e.g. 0.03). The credential file
//                                                format is not documented, so the cap is passed in, not parsed.
//   DATACO_ACCOUNT                               principal address of DataCo's Metal account
//   UPSTREAM_PAY_TO, UPSTREAM_URL, SELLER_URL, OPERATOR_TOKEN
//   OWNER_KEY                                    owner key file path
//   SETTLEMENT_ADDRESS                           where the treasury moves earnings
//   AWX_CLIENT_ID, AWX_API_KEY, AWX_GLOBAL_ACCOUNT_ID, AWX_BENEFICIARY_ID
//   APPROVE=yes                                  optional: apply the proposed limits
import path from "node:path";
import { createMetalCli, formatUsdz, parseUsdz } from "../agents/cli.ts";
import type { CliResult } from "../agents/cli.ts";
import { planLimits } from "../agents/mandates.ts";
import { TreasuryAirwallexClient } from "../treasury/airwallex.ts";
import { Ledger, settleEarnings, payLicenceFee } from "../treasury/settle.ts";

const need = (name: string): string => {
  const v = process.env[name];
  if (!v) throw new Error(`missing env ${name}`);
  return v;
};
let step = 0;
const say = (msg: string) => console.log(`Step ${++step}: ${msg}`);
const sub = (msg: string) => console.log(`        ${msg}`);
// ERROR (the tool failed) is never shown as REFUSED (the mandate said no). Any ERROR stops the script.
const outcome = (r: CliResult) => {
  if (r.status === "error") throw new Error(`ERROR (exit ${r.exitCode}): ${r.error ?? "no output"}`);
  return r.status === "refused" ? `REFUSED${r.refusalCode ? ` (${r.refusalCode})` : ""}` : r.status.toUpperCase();
};

async function main(): Promise<void> {
  const cli = createMetalCli();
  const sourcing = need("SOURCING_CRED");
  const upstream = need("UPSTREAM_URL");
  const raw = `${upstream}/raw?symbol=AAPL`;
  const SALE = parseUsdz("0.05"); // DataCo's per-quote sale price

  say(`Customer buys quotes from DataCo at ${formatUsdz(SALE)} USDZ each (${need("SELLER_URL")}/quote)`);
  sub("run the buying agent separately; this script drives DataCo's own agents");

  say("Sourcing agent buys upstream data at 0.02 per sale");
  for (let i = 1; i <= 2; i++) sub(`purchase ${i}: ${outcome(await cli.pay(raw, sourcing))}`);

  say("Operator raises the upstream price from 0.02 to 0.04");
  const r = await fetch(`${upstream}/admin/price`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-operator-token": need("OPERATOR_TOKEN") },
    body: JSON.stringify({ price: "0.04" }),
  });
  sub(`upstream answered HTTP ${r.status}`);

  say("Sourcing agent tries to buy again");
  const refused = await cli.pay(raw, sourcing);
  sub(`result: ${outcome(refused)} (exit ${refused.exitCode}), nothing was paid`);
  if (refused.status !== "refused") sub("WARNING: expected a refusal");
  sub("the customer gets an error status: HTTP 503 upstream_price_exceeds_mandate");

  say("Reading all three mandates from the chain");
  const creds = { sourcing, support: need("SUPPORT_CRED"), treasury: need("TREASURY_CRED") };
  const caps = { sourcing: need("SOURCING_CAP"), support: need("SUPPORT_CAP"), treasury: need("TREASURY_CAP") };
  const state = {} as Record<"sourcing" | "support" | "treasury", { spent: bigint; budget: bigint; cap: bigint }>;
  for (const k of ["sourcing", "support", "treasury"] as const) {
    const s = await cli.status(creds[k]);
    state[k] = { spent: s.spent, budget: s.budget, cap: parseUsdz(caps[k]) };
    sub(`${k}: spent ${formatUsdz(s.spent)} of ${formatUsdz(s.budget)} USDZ, cap ${caps[k]}, ${s.payments} payments`);
  }

  say("Planning new limits for the new upstream price");
  const plan = planLimits(state, parseUsdz("0.04"), SALE, parseUsdz("20"));
  if ("error" in plan) {
    sub(`cannot plan: ${plan.error}`);
    return;
  }
  for (const k of ["sourcing", "support", "treasury"] as const) {
    sub(`${k}: budget ${formatUsdz(plan.proposal[k].budget)}, cap ${formatUsdz(plan.proposal[k].cap)}`);
  }
  sub(`sale price: ${formatUsdz(plan.salePrice)}`);
  for (const line of plan.rationale) sub(`why: ${line}`);

  say("Waiting for approval (set APPROVE=yes)");
  if (process.env.APPROVE !== "yes") {
    sub("not approved, stopping here");
    return;
  }
  sub("approved");

  say("Creating the new sourcing mandate, then replacing the old one");
  const dir = path.dirname(sourcing);
  const base = path.basename(sourcing, ".json");
  const next = path.join(dir, `${base}.v2.json`);
  const created = await cli.credentialCreate({
    principal: need("DATACO_ACCOUNT"),
    cap: formatUsdz(plan.proposal.sourcing.cap),
    budget: formatUsdz(plan.proposal.sourcing.budget),
    payees: [`${need("UPSTREAM_PAY_TO")},Upstream`],
    mandateKeyFile: path.join(dir, `${base}.key.json`), // the agent keeps its key
    out: next,
    key: need("OWNER_KEY"),
  });
  sub(`new mandate created: ${created.status === "paid" ? "done" : outcome(created)}`);
  if (created.exitCode !== 0) return;
  const replaced = await cli.replace({ credential: next, replaces: sourcing, key: need("OWNER_KEY") });
  sub(`old mandate replaced on chain: ${replaced.status === "paid" ? "done" : outcome(replaced)}`);
  if (replaced.exitCode !== 0) return;

  say("Sourcing agent resumes buying at 0.04");
  sub(`purchase: ${outcome(await cli.pay(raw, next))}`);

  say("Treasury moves earnings to the settlement address");
  // DEMO_RUN_ID lets a rehearsal or a new take get fresh ids; ids stay idempotent within a run.
  const date = new Date().toISOString().slice(0, 10) + (process.env.DEMO_RUN_ID ? `-${process.env.DEMO_RUN_ID}` : "");
  const pull = await cli.pull({ credential: need("TREASURY_CRED"), to: need("SETTLEMENT_ADDRESS"), amount: "1.00", paymentId: `earnings-${date}` });
  sub(`pull: ${outcome(pull)}`);
  const tx = pull.fields.transaction;
  if (!tx) {
    sub("no transaction hash in the output, stopping");
    return;
  }
  sub(`transaction ${tx}`);

  say("Settling earnings into the Airwallex sandbox");
  const client = new TreasuryAirwallexClient({ clientId: need("AWX_CLIENT_ID"), apiKey: need("AWX_API_KEY") });
  const ledger = new Ledger(new URL("../data/treasury-ledger.jsonl", import.meta.url).pathname);
  const s = await settleEarnings({ amountUsdz: parseUsdz("1.00"), metalTxHash: tx, ledger, client, globalAccountId: need("AWX_GLOBAL_ACCOUNT_ID") });
  sub(`${s.replayed ? "already settled" : "settled"}: ${s.usdCents} cents, reference ${tx}`);

  say("Paying the EUR 50 licence fee by SWIFT");
  const f = await payLicenceFee({ eurAmount: 50, beneficiary: need("AWX_BENEFICIARY_ID"), invoiceId: `LIC-${date}`, ledger, client });
  sub(`${f.replayed ? "already paid" : "paid"}: transfer ${f.transferId}`);
  if (f.feeAmount !== undefined) sub(`SWIFT fee charged by Airwallex: ${f.feeCurrency ?? "EUR"} ${f.feeAmount}, payer paid ${f.amountPayerPays}`);
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
