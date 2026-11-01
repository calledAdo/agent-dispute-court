// One-take demo: a buyer agent runs a six-document job across three inference providers. It reroutes on
// a price spike, a slow provider and a broken delivery; it files a dispute with the court by itself;
// and it then routes by the court's reputation. Every tx hash goes to data/sourcing-run.json.
//
// Env: PROVIDER_URLS, COURT_URL, CUSTOMER_CRED, CUSTOMER_ACCOUNT, OPERATOR_TOKEN,
//      PROVIDER_KEY_FILES (same order as PROVIDER_URLS), COURT_VAULT, METAL_RPC_URL,
//      COURT_LEDGER, COURT_LEDGER_FROM_BLOCK (anchoring), COURT_SELLERS (the court's seller file:
//      each provider's receipt log is read from it), FILING_FEE (0.01),
//      STEP_MAX_PRICE (0.06), STEP_MAX_LATENCY_MS (2000), DEMO_PAUSE_MS (1500), DEMO_APPROVE=yes.
import fs from "node:fs";
import { fileURLToPath } from "node:url";
import { parseUnits } from "viem";
import type { Address } from "viem";
import { createMetalCli, formatUsdz, parseUsdz } from "../agents/cli.ts";
import { rank } from "../agents/router.ts";
import type { Reputation, RouteDecision } from "../agents/router.ts";
import { fileDisputes, probe, reputation, runStep } from "../agents/sourcing.ts";
import type { Attempt, BadDelivery, FetchLike, ProbedProvider, SourcingContext, StepResult } from "../agents/sourcing.ts";
import { loadSellers } from "../court/sellers.ts";
import { metalClients, requiredEnv } from "../shared/chain.ts";
import { ReceiptLog } from "../seller/receipts.ts";
import { anchorNew, parseFromBlock } from "./anchor.ts";
import { courtClient, ensureReserve, fail, short, sleep, usdz, VAULT_ABI, vaultToken } from "./lib.ts";

const MIN_RESERVE = parseUnits("0.2", 18);
const TOP_UP = parseUnits("0.5", 18);

interface Doc { title: string; text: string }

// Six short business documents. Each stays well under the provider's 1500-character limit.
const DOCS: Doc[] = [
  {
    title: "invoice dispute email",
    text: "Subject: Invoice INV-4471 is wrong. Hello, we were billed 4,200 USD for October hosting but our contract caps the monthly fee at 3,500 USD. The extra 700 USD appears to be for storage that we cancelled in August. Please issue a corrected invoice and confirm the credit before the next payment run on the 15th. Our purchase order PO-8821 covers only the contracted services.",
  },
  {
    title: "Q3 revenue memo",
    text: "Q3 revenue reached 12.4M USD, up 18 percent year over year and 4 percent above plan. Subscription revenue contributed 9.1M, services 2.2M and marketplace fees 1.1M. Gross margin improved to 71 percent as infrastructure costs flattened. Net revenue retention was 112 percent. The sales team closed 34 new logos, the strongest quarter this year. We expect Q4 revenue between 13.0M and 13.6M and are raising the full-year guidance accordingly.",
  },
  {
    title: "supplier delay notice",
    text: "Dear customer, this is a notice that shipment SH-20931 will be delayed by seven business days. The delay is caused by a shortage of the controller board at our contract manufacturer in Penang. The new estimated delivery date is 14 November. We have reserved priority allocation for your order and will cover expedited freight at our cost. No action is required from you. We apologise for the disruption and will confirm dispatch as soon as the goods leave the warehouse.",
  },
  {
    title: "policy update",
    text: "Policy update: effective 1 December, all remote access to production systems requires a hardware security key in addition to single sign-on. Shared administrator accounts will be disabled. Teams must nominate at least two on-call administrators per service and complete the migration checklist by 24 November. The security team will run tabletop exercises in the first week of December. Requests for exceptions must be approved by the CISO and will be reviewed quarterly. This change follows the incident review published last month.",
  },
  {
    title: "incident report",
    text: "Incident INC-118: on 3 October at 09:12 UTC the checkout service returned errors for 23 minutes. A configuration change reduced the database connection pool from 40 to 4 connections, and requests queued until timeouts fired. About 1,800 checkout attempts failed. The on-call engineer rolled back the change at 09:35 and traffic recovered within four minutes. No customer data was lost. Actions: add a connection-pool guardrail to the deploy pipeline, require a second reviewer for configuration changes, and add a synthetic checkout check.",
  },
  {
    title: "contract renewal note",
    text: "Contract renewal note for the Meridian account. The current agreement expires on 31 January. Meridian proposes a 24-month renewal at 96,000 USD per year, a 4 percent increase over the current rate, with payment quarterly in advance. They ask for a 99.9 percent uptime commitment and a 30-day termination right for convenience after month twelve. Legal has flagged the termination clause. Commercial terms are otherwise acceptable. We need a decision by 20 December to keep the current pricing.",
  },
];

interface CaseJson {
  id: string;
  status: string;
  claims: { id: string; tx: string; code: string }[];
  findings: { claimId: string; state: string }[];
  rulings: { claimId: string; tx: string; verdict: string; decidedBy: string; refund: string; proposedRefund: string; reason?: string }[];
  publishResults: { tx: string; status: string; hash?: string; reason?: string }[] | null;
  executeResults: { tx: string; status: string; hash?: string; reason?: string }[] | null;
  feeRefundTx: string | null;
  feeRefundError: string | null;
  error: string | null;
}

interface Payment { step: number; provider: string; price: string; tx: string; accepted: boolean }

const messageOf = (e: unknown): string => (e instanceof Error ? (e as { shortMessage?: string }).shortMessage ?? e.message : String(e));

async function main(): Promise<void> {
  const urls = csv(requiredEnv("PROVIDER_URLS"));
  const keyFiles = csv(requiredEnv("PROVIDER_KEY_FILES"));
  if (urls.length === 0) fail("PROVIDER_URLS is empty");
  if (keyFiles.length !== urls.length) fail("PROVIDER_URLS and PROVIDER_KEY_FILES must list the same number of providers");

  const courtUrl = requiredEnv("COURT_URL");
  const cred = requiredEnv("CUSTOMER_CRED");
  const customer = requiredEnv("CUSTOMER_ACCOUNT") as `0x${string}`;
  const operatorToken = requiredEnv("OPERATOR_TOKEN");
  const vault = requiredEnv("COURT_VAULT") as Address;
  const ledger = requiredEnv("COURT_LEDGER") as Address;
  const fromBlock = parseFromBlock(requiredEnv("COURT_LEDGER_FROM_BLOCK"));
  const rpcUrl = requiredEnv("METAL_RPC_URL");
  // 0.06 by default: the doc 4 reroute must be able to reach Summit at 0.06, while Swift's 0.07 spike stays out.
  const maxPrice = process.env.STEP_MAX_PRICE ?? "0.06";
  const maxLatencyMs = Number(process.env.STEP_MAX_LATENCY_MS ?? 2000);
  const pauseMs = Number(process.env.DEMO_PAUSE_MS ?? 1500);
  const autoApprove = process.env.DEMO_APPROVE === "yes";
  const fee = parseUsdz(process.env.FILING_FEE ?? "0.01");
  if (!Number.isInteger(maxLatencyMs) || maxLatencyMs <= 0) fail("STEP_MAX_LATENCY_MS must be a positive integer");

  const sellers = loadSellers(process.env);
  const sellerByAddress = new Map(sellers.map((s) => [s.address.toLowerCase(), s]));
  const clients = keyFiles.map((file) => metalClients(rpcUrl, file));
  const cli = createMetalCli();
  const court = courtClient(courtUrl, operatorToken);
  const fetchFn: FetchLike = (url, init) => fetch(url, init);
  const pause = () => sleep(pauseMs);
  const startedAt = Date.now();
  const timings: Record<string, number> = {};
  const record: Record<string, unknown> = {};
  let t = Date.now();
  const lap = (name: string) => { timings[name] = Date.now() - t; t = Date.now(); };
  const step = (n: number, line: string) => console.log(`\nStep ${n}: ${line}`);
  const detail = (line: string) => console.log(`    ${line}`);

  const ctx: SourcingContext = {
    providers: urls,
    courtUrl,
    cred,
    payer: customer,
    cli,
    maxPrice,
    maxLatencyMs,
    probeTimeoutMs: maxLatencyMs,
    fetch: fetchFn,
    now: () => Date.now(),
  };

  const market = async (): Promise<{ statuses: ProbedProvider[]; rep: Reputation[] }> => ({
    statuses: await probe(urls, maxLatencyMs, { fetch: fetchFn, now: () => Date.now() }),
    rep: await reputation(courtUrl, fetchFn),
  });

  let latest: ProbedProvider[] = [];
  const urlByName = new Map<string, string>();
  const urlOf = (name: string): string => {
    const url = urlByName.get(name);
    if (url === undefined) fail(`provider ${name} was not in the step 2 market probe`);
    return url;
  };
  // A timed-out probe has no name, so a ranking entry may be a URL; show the name we learned earlier.
  const displayName = (name: string): string => {
    for (const [known, url] of urlByName) if (url === name) return known;
    return name;
  };
  const priceOf = (provider: string): string => {
    const p = latest.find((x) => x.name === provider) ?? latest.find((x) => x.url === provider);
    return p?.price ?? "0";
  };
  const admin = async (name: string, body: unknown): Promise<void> => {
    const res = await fetch(`${urlOf(name).replace(/\/$/, "")}/admin`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-operator-token": operatorToken },
      body: JSON.stringify(body),
    });
    if (res.status !== 200) fail(`${name} admin update failed (HTTP ${res.status})`);
  };
  const excludedOf = (decision: RouteDecision, name: string): string =>
    decision.ranked.find((r) => r.name === name)?.excluded ?? "not excluded";
  const summaryOf = (body: string | null): string => {
    try {
      const v = JSON.parse(body ?? "") as { summary?: unknown };
      return typeof v.summary === "string" ? v.summary.replace(/\s+/g, " ").slice(0, 120) : "-";
    } catch {
      return "-";
    }
  };
  const describeAttempts = (attempts: Attempt[]): string =>
    attempts.map((a) => `${a.provider}: ${a.violation ?? a.refused ?? a.error ?? (a.ok ? "accepted" : "failed")}`).join(", ");

  const payments: Payment[] = [];
  const runs: StepResult[] = [];
  const bad: BadDelivery[] = [];
  const recordPayments = (r: StepResult): void => {
    for (const a of r.attempts) {
      if (a.tx === null) continue; // a refusal or a CLI error: no money moved
      payments.push({ step: r.step, provider: a.provider, price: priceOf(a.provider), tx: a.tx, accepted: a.ok });
    }
  };
  const buy = async (docIndex: number): Promise<StepResult> => {
    const doc = DOCS[docIndex - 1];
    const r = await runStep({ index: docIndex, label: `summary of '${doc.title}'`, text: doc.text }, ctx);
    for (const a of r.attempts) if (a.refused !== undefined) detail(`${a.provider} refused (${a.refused}), nothing was paid`);
    recordPayments(r);
    runs.push(r);
    if (!r.ok) fail(`doc ${docIndex} (${doc.title}) could not be delivered: ${describeAttempts(r.attempts)}`);
    return r;
  };

  // 1. Reserves
  step(1, "Check every provider's dispute reserve");
  const token = await vaultToken(clients[0].publicClient, vault);
  for (const c of clients) {
    const seller = sellerByAddress.get(c.account.address.toLowerCase());
    const label = seller?.name ?? short(c.account.address);
    try {
      const r = await ensureReserve({
        publicClient: c.publicClient, walletClient: c.walletClient, account: c.account, chain: c.chain,
        vault, token, min: MIN_RESERVE, topUp: TOP_UP,
      });
      detail(`${label}: ${usdz(r.held)} *USDZ held${r.toppedUp ? ` (topped up by ${usdz(TOP_UP)})` : ""}`);
    } catch (e) {
      fail(`reserve for ${label}: ${messageOf(e)}`);
    }
  }
  lap("reserve"); await pause();

  // 2. Market
  step(2, "The market: probe every provider");
  let m = await market();
  latest = m.statuses;
  for (const p of m.statuses) urlByName.set(p.name, p.url);
  detail("provider | model | price | latency | court record");
  for (const p of m.statuses) {
    const r = m.rep.find((x) => x.address.toLowerCase() === p.payTo.toLowerCase());
    detail([
      p.name.padEnd(8), (p.model ?? "-").padEnd(18), `${p.price} *USDZ`,
      p.latencyMs === null ? "timeout" : `${p.latencyMs} ms`, r ? `${r.upheld}/${r.claims}` : "0/0",
    ].join(" | "));
  }
  lap("market"); await pause();

  // 3. Docs 1-2
  step(3, "Docs 1-2: the cheapest provider wins");
  for (const i of [1, 2]) {
    const r = await buy(i);
    detail(`${DOCS[i - 1].title}: ${r.provider} at ${priceOf(r.provider)} *USDZ, tx ${short(r.tx!)}`);
    detail(`summary: ${summaryOf(r.body)}`);
  }
  lap("docs-1-2"); await pause();

  // 4. Price spike
  step(4, "Price spike: Swift goes to 0.07, above the cap");
  await admin("Swift", { price: "0.07" });
  m = await market(); latest = m.statuses;
  detail(`Swift excluded: ${excludedOf(rank(latest, m.rep, { maxPrice, maxLatencyMs }), "Swift")}`);
  const doc3 = await buy(3);
  detail(`doc 3 rerouted to ${doc3.provider} at ${priceOf(doc3.provider)} *USDZ, tx ${short(doc3.tx!)}`);
  lap("price-spike"); await pause();

  // 5. Broken delivery
  step(5, "Broken delivery: Sterling truncates one body, the router re-buys");
  await admin("Sterling", { fault: "truncated", faultCount: 1 });
  m = await market(); latest = m.statuses;
  const doc4 = await buy(4);
  for (const a of doc4.attempts) {
    detail(`${a.provider}: ${a.violation ? `rejected (${a.violation})` : "accepted"}${a.tx ? `, tx ${short(a.tx)}` : ""}`);
  }
  if (doc4.attempts.length < 2) fail("doc 4 was not rerouted; is Sterling's fault armed?");
  bad.push(...doc4.badDeliveries);
  lap("broken-delivery"); await pause();

  // 6. Slow provider
  step(6, "Slow provider: Summit takes 5 s, so doc 5 goes to Sterling");
  await admin("Summit", { statusDelayMs: 5000 });
  m = await market(); latest = m.statuses;
  detail(`Summit excluded: ${excludedOf(rank(latest, m.rep, { maxPrice, maxLatencyMs }), urlOf("Summit"))}`);
  const doc5 = await buy(5);
  detail(`doc 5 delivered by ${doc5.provider}, tx ${short(doc5.tx!)}`);
  await admin("Summit", { statusDelayMs: 0 });
  detail("Summit's delay reset to 0");
  lap("slow-provider"); await pause();

  // 7. Anchor Sterling's receipts, so the broken delivery is provable before the dispute is filed.
  step(7, "Anchor Sterling's receipts before filing");
  const sterlingIndex = urls.indexOf(urlOf("Sterling"));
  if (sterlingIndex < 0) fail("Sterling's URL is not in PROVIDER_URLS");
  const sterling = clients[sterlingIndex];
  const sterlingSeller = sellerByAddress.get(sterling.account.address.toLowerCase());
  if (sterlingSeller === undefined) fail("Sterling's address is not in COURT_SELLERS");
  const brokenTx = bad[0]?.tx;
  const sterlingLog = new ReceiptLog(sterlingSeller.receipts);
  for (let i = 0; i < 30 && brokenTx !== undefined && sterlingLog.byTx(brokenTx) === undefined; i++) await sleep(1000);
  if (brokenTx !== undefined && sterlingLog.byTx(brokenTx) === undefined) {
    fail("Sterling has not logged the broken delivery receipt (is COURT_SELLERS pointing at the provider's RECEIPT_LOG?)");
  }
  const anchored = await anchorNew({
    publicClient: sterling.publicClient, walletClient: sterling.walletClient, ledger,
    seller: sterling.account.address, fromBlock, receiptsPath: sterlingSeller.receipts,
  });
  if (anchored === null) detail("nothing new to anchor");
  else {
    detail(`batch ${anchored.batch}, ${anchored.count} receipts`);
    detail(`root ${anchored.root}`);
    detail(`tx   ${short(anchored.tx)}`);
    record.anchor = { batch: anchored.batch.toString(), root: anchored.root, tx: anchored.tx, count: anchored.count };
  }
  lap("anchor"); await pause();

  // 8. Recourse
  step(8, "Recourse: the agent files a dispute by itself");
  const filed = await fileDisputes(bad, ctx);
  const primary = filed[0];
  if (primary === undefined) fail("no dispute was filed");
  for (const f of filed) {
    detail(`case ${f.caseId}: ${f.provider} (${f.txs.length} tx)`);
    detail(`fee tx ${f.feeTx === null ? "unknown" : short(f.feeTx)}`);
  }
  record.cases = filed;
  lap("file"); await pause();

  // 9. Verdict
  step(9, "Verdict: wait for the court, publish, execute");
  const getCase = async (id: string): Promise<CaseJson> => (await court.get(`/cases/${id}`)).json as CaseJson;
  const showTable = (cs: CaseJson) => {
    for (const cl of cs.claims) {
      const f = cs.findings.find((x) => x.claimId === cl.id);
      const r = cs.rulings.find((x) => x.claimId === cl.id);
      detail([cl.id, cl.code, f?.state ?? "-", r?.verdict ?? "-", r?.decidedBy ?? "-", r ? `${usdz(r.refund)} *USDZ` : "-"].join(" | "));
    }
  };
  const caseId = primary.caseId;
  let c = await getCase(caseId);
  const waitMs = Number(process.env.DEMO_DECISION_TIMEOUT_MS ?? 300_000);
  for (let waited = 0; c.status === "RUNNING" && waited < waitMs; waited += 2000) { await sleep(2000); c = await getCase(caseId); }
  if (c.status === "RUNNING") fail(`timed out after ${waitMs / 1000} s waiting for the decision`);
  if (c.status === "FAILED" || c.status === "FILER_MISMATCH") fail(`case ${c.status}: ${c.error ?? ""}`);
  detail("claim | code | finding | verdict | decided by | refund");
  showTable(c);

  const open = (cs: CaseJson) => cs.rulings.filter((r) => r.verdict === "ESCALATE");
  const escalated = open(c);
  if (escalated.length === 0) detail("no escalations, nothing for a human to decide");
  for (const r of escalated) detail(`${r.claimId} escalated (${usdz(r.proposedRefund)} *USDZ at stake): ${r.reason ?? "no reason recorded"}`);
  if (escalated.length > 0) {
    if (autoApprove) {
      for (const r of escalated) {
        const refund = BigInt(r.proposedRefund) > 0n;
        const res = await court.post(`/cases/${caseId}/approve`, {
          claimId: r.claimId, decision: refund ? "REFUND" : "REJECT", amount: r.proposedRefund, approver: "sourcing-demo",
        });
        if (res.status !== 200) fail(`approve ${r.claimId} failed (${res.status}): ${res.json?.error ?? ""}`);
        detail(refund ? `${r.claimId}: REFUND approved` : `${r.claimId}: nothing at stake, REJECT recorded`);
      }
    } else {
      detail(`open the console and approve: ${courtUrl}/console/`);
      while (open(c).length > 0) { await sleep(2000); c = await getCase(caseId); }
    }
    c = await getCase(caseId);
    if (open(c).length > 0) fail("escalations remain");
    detail("no escalations remain");
    showTable(c);
  }
  lap("decision"); await pause();

  const pub = await court.post(`/cases/${caseId}/publish`, {});
  if (pub.status !== 200) fail(`publish failed (${pub.status}): ${pub.json?.error ?? ""}`);
  const published = (pub.json as CaseJson).publishResults ?? [];
  for (const p of published) detail(`${short(p.tx)}: ${p.status}${p.hash ? `  ${short(p.hash)}` : ""}${p.reason ? `  ${p.reason}` : ""}`);
  if (published.some((p) => p.status === "failed")) fail("a ruling failed to publish");
  record.publishTxs = published.map((p) => ({ tx: p.tx, status: p.status, hash: p.hash ?? null }));

  const windowS = Number(await sterling.publicClient.readContract({ address: vault, abi: VAULT_ABI, functionName: "objectionWindow" }) as bigint);
  const tty = process.stdout.isTTY === true;
  for (let left = windowS + 2; left > 0; left--) {
    if (tty) process.stdout.write(`\r    executable in ${String(left).padStart(4)} s   `);
    else if (left % 5 === 0 || left === windowS + 2) detail(`executable in ${left} s`);
    await sleep(1000);
  }
  if (tty) process.stdout.write("\r    objection window over                \n");
  else detail("objection window over");
  lap("window");

  let done = (await court.post(`/cases/${caseId}/execute`, {})).json as CaseJson;
  for (let i = 0; i < 5 && (done.executeResults ?? []).some((o) => o.status === "not_yet"); i++) {
    await sleep(3000); // block time can lag the wall clock
    done = (await court.post(`/cases/${caseId}/execute`, {})).json as CaseJson;
  }
  for (const o of done.executeResults ?? []) detail(`${short(o.tx)}: ${o.status}${o.hash ? `  ${short(o.hash)}` : ""}${o.reason ? `  ${o.reason}` : ""}`);
  if (done.feeRefundError) fail(`fee refund failed: ${done.feeRefundError}`);
  detail(`fee refund tx: ${done.feeRefundTx ? short(done.feeRefundTx) : "none (fee kept)"}`);
  if ((done.executeResults ?? []).some((o) => o.status === "failed" || o.status === "not_yet")) fail("a refund did not execute");
  lap("execute"); await pause();

  const paidTxs = new Set((done.executeResults ?? []).filter((o) => o.status === "paid" || o.status === "already_paid").map((o) => o.tx));
  const refunded = done.rulings.filter((r) => r.verdict === "REFUND" && paidTxs.has(r.tx)).reduce((a, r) => a + BigInt(r.refund), 0n);

  // 10. Reputation
  step(10, "Reputation: the loss makes Sterling expensive, so doc 6 goes to Swift");
  await admin("Swift", { price: "0.02" });
  detail("Swift's price reset to 0.02");
  m = await market(); latest = m.statuses;
  const sterlingRecord = m.rep.find((r) => r.address.toLowerCase() === sterling.account.address.toLowerCase());
  detail(`Sterling's court record: ${sterlingRecord?.upheld ?? 0}/${sterlingRecord?.claims ?? 0}`);
  const doc6 = await buy(6);
  detail(`doc 6: ${doc6.provider} at ${priceOf(doc6.provider)} *USDZ, tx ${short(doc6.tx!)}`);
  const finalRank = rank(latest, m.rep, { maxPrice, maxLatencyMs });
  detail("ranking by effective price, price x (1 + 2 x loss rate):");
  for (const row of finalRank.ranked) {
    detail(`${displayName(row.name).padEnd(8)} ${row.score === null ? `excluded: ${row.excluded}` : `${formatUsdz(row.score)} *USDZ`}`);
  }
  detail("Sterling: 0.03 x 3 = 0.09 after one loss in one claim, worse than Summit's 0.06");
  lap("reputation"); await pause();

  // 11. Summary
  step(11, "Summary");
  const completed = runs.filter((r) => r.ok).length;
  const spent = payments.reduce((a, p) => a + parseUsdz(p.price), 0n);
  const feeRefunded = done.feeRefundTx !== null;
  const net = spent + fee - refunded - (feeRefunded ? fee : 0n);
  detail(`${completed}/${DOCS.length} docs completed; ${payments.length} payments`);
  detail(`spent ${usdz(spent)} *USDZ + ${usdz(fee)} filing fee`);
  detail(`recovered ${usdz(refunded)} *USDZ${feeRefunded ? ` + ${usdz(fee)} fee` : " (fee kept)"}`);
  detail(`net cost ${usdz(net)} *USDZ`);
  detail("provider | payments | spent | accepted | refunded");
  for (const name of urlByName.keys()) {
    const ps = payments.filter((p) => p.provider === name);
    const providerSpent = ps.reduce((a, p) => a + parseUsdz(p.price), 0n);
    const providerRefund = done.rulings
      .filter((r) => r.verdict === "REFUND" && ps.some((p) => p.tx === r.tx))
      .reduce((a, r) => a + BigInt(r.refund), 0n);
    detail([name.padEnd(8), String(ps.length).padEnd(8), `${usdz(providerSpent)} *USDZ`, String(ps.filter((p) => p.accepted).length).padEnd(8), `${usdz(providerRefund)} *USDZ`].join(" | "));
  }
  record.steps = runs.map((r) => ({ step: r.step, provider: r.provider, tx: r.tx, ok: r.ok, attempts: r.attempts }));
  record.payments = payments;
  record.refunded = refunded.toString();
  record.feeRefundTx = done.feeRefundTx;
  record.spent = spent.toString();
  record.net = net.toString();
  record.ranking = finalRank.ranked.map((r) => ({ name: displayName(r.name), score: r.score?.toString() ?? null, excluded: r.excluded ?? null }));
  record.timingsMs = timings;
  record.totalMs = Date.now() - startedAt;
  const out = new URL("../data/sourcing-run.json", import.meta.url);
  fs.mkdirSync(new URL("./", out), { recursive: true });
  fs.writeFileSync(out, JSON.stringify(record, null, 2) + "\n");
  detail("wrote data/sourcing-run.json");
}

function csv(value: string): string[] {
  return value.split(",").map((s) => s.trim()).filter((s) => s !== "");
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch((err) => fail(messageOf(err)));
}
