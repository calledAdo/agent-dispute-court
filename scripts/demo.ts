// One-take demo: stages the whole court story and records every tx hash to data/demo-run.json.
// Env: SELLER_URL, COURT_URL, CUSTOMER_CRED, CUSTOMER_ACCOUNT, OPERATOR_TOKEN, SELLER_KEY_FILE, COURT_VAULT, METAL_RPC_URL,
//      COURT_LEDGER, COURT_LEDGER_FROM_BLOCK, SELLER_RECEIPTS (anchoring), DEMO_PAUSE_MS (1500), DEMO_APPROVE=yes.
import fs from "node:fs";
import { fileURLToPath } from "node:url";
import { formatUnits, parseAbi, parseUnits } from "viem";
import type { Address } from "viem";
import { createMetalCli, parseUsdz } from "../agents/cli.ts";
import type { CliResult } from "../agents/cli.ts";
import { GAS, metalClients, requiredEnv } from "../shared/chain.ts";
import { ReceiptLog } from "../seller/receipts.ts";
import { DEFAULT_PRICE } from "../seller/server.ts";
import { anchorNew, parseFromBlock } from "./anchor.ts";

const COMPLAINT = "My agent never asked for NVDA, it wanted AMD. I was charged twice for AAPL. The TSLA quote was stale and the MSFT price was wrong. The GOOG price also looked wrong, but I can't tell you by how much.";
const SYMBOLS = ["AAPL", "AAPL", "TSLA", "MSFT", "NVDA", "GOOG"];
const MIN_RESERVE = parseUnits("0.5", 18);
const TOP_UP = parseUnits("1", 18);
const abi = parseAbi([
  "function heldBalanceOf(address owner, address spender) view returns (uint256)",
  "function reserve(uint256 amount)",
  "function objectionWindow() view returns (uint64)",
  "function token() view returns (address)",
  "function approve(address spender, uint256 amount) returns (bool)",
  "function balanceOf(address owner) view returns (uint256)",
]);

interface CaseJson {
  id: string; status: string; claims: { id: string; tx: string; code: string }[];
  findings: { claimId: string; state: string }[];
  rulings: { claimId: string; reason?: string; tx: string; verdict: string; decidedBy: string; refund: string; proposedRefund: string }[];
  publishResults: { tx: string; status: string; hash?: string; reason?: string }[] | null;
  executeResults: { tx: string; status: string; hash?: string; reason?: string }[] | null;
  feeRefundTx: string | null; feeRefundError: string | null; error: string | null;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const short = (h: string) => `${h.slice(0, 10)}...${h.slice(-6)}`;
const usdz = (x: bigint | string) => formatUnits(BigInt(x), 18);

function fail(msg: string): never {
  console.error(`\nDemo stopped: ${msg}`);
  process.exit(1);
}

function cliOk(r: CliResult, what: string): void {
  if (r.status !== "paid") fail(`${what} did not complete (${r.status}${r.error ? `: ${r.error}` : ""})`);
}

async function main(): Promise<void> {
  const sellerUrl = requiredEnv("SELLER_URL");
  const courtUrl = requiredEnv("COURT_URL").replace(/\/$/, "");
  const cred = requiredEnv("CUSTOMER_CRED");
  const customer = requiredEnv("CUSTOMER_ACCOUNT") as Address;
  const operatorToken = requiredEnv("OPERATOR_TOKEN");
  const vault = requiredEnv("COURT_VAULT") as Address;
  const ledger = requiredEnv("COURT_LEDGER") as Address;
  const receiptsPath = requiredEnv("SELLER_RECEIPTS");
  const fromBlock = parseFromBlock(requiredEnv("COURT_LEDGER_FROM_BLOCK"));
  const pauseMs = Number(process.env.DEMO_PAUSE_MS ?? 1500);
  const autoApprove = process.env.DEMO_APPROVE === "yes";
  const { publicClient, walletClient, account, chain } = metalClients(requiredEnv("METAL_RPC_URL"), requiredEnv("SELLER_KEY_FILE"));
  const seller = account.address;
  const cli = createMetalCli();
  const startedAt = Date.now();
  const timings: Record<string, number> = {};
  const record: Record<string, unknown> = {};
  const pause = () => sleep(pauseMs);
  const read = <T>(functionName: string, args: unknown[] = [], address: Address = vault) =>
    publicClient.readContract({ address, abi, functionName, args } as never) as Promise<T>;
  const send = async (address: Address, functionName: string, args: unknown[]): Promise<string> => {
    const hash = await walletClient.writeContract({ address, abi, functionName, args, chain, account, ...GAS } as never);
    const rc = await publicClient.waitForTransactionReceipt({ hash });
    if (rc.status !== "success") fail(`${functionName} reverted: ${hash}`);
    return hash;
  };
  const court = async (path: string, init?: { method: string; body: unknown }): Promise<{ status: number; json: any }> => {
    const res = await fetch(courtUrl + path, init ? { method: init.method, headers: { "content-type": "application/json", "x-operator-token": operatorToken }, body: JSON.stringify(init.body) } : undefined);
    return { status: res.status, json: await res.json().catch(() => ({})) };
  };
  const getCase = async (id: string): Promise<CaseJson> => (await court(`/cases/${id}`)).json as CaseJson;
  const step = (n: number, line: string) => console.log(`\nStep ${n}: ${line}`);
  const detail = (line: string) => console.log(`    ${line}`);
  let t = Date.now();
  const lap = (name: string) => { timings[name] = Date.now() - t; t = Date.now(); };

  // 1. Reserve
  step(1, "Check the seller's dispute reserve");
  const token = await read<Address>("token");
  let held = await read<bigint>("heldBalanceOf", [seller, vault], token);
  if (held < MIN_RESERVE) {
    detail(`held ${usdz(held)} *USDZ is below 0.5, topping up by 1`);
    record.approveTx = await send(token, "approve", [vault, TOP_UP]);
    record.reserveTx = await send(vault, "reserve", [TOP_UP]);
    held = await read<bigint>("heldBalanceOf", [seller, vault], token);
  }
  detail(`reserve held: ${usdz(held)} *USDZ`);
  lap("reserve"); await pause();

  // 2. Purchases
  step(2, "The customer agent buys six quotes");
  const balanceBefore = await read<bigint>("balanceOf", [customer], token);
  const txs: string[] = [];
  const purchases: { symbol: string; tx: string; amount: string }[] = [];
  for (const symbol of SYMBOLS) {
    const r = await cli.pay(`${sellerUrl.replace(/\/$/, "")}/quote?symbol=${symbol}`, cred);
    cliOk(r, `purchase of ${symbol}`);
    if (!r.transaction) fail(`purchase of ${symbol}: no transaction in the output`);
    txs.push(r.transaction);
    purchases.push({ symbol, tx: r.transaction, amount: (r.fields.amount ?? DEFAULT_PRICE).replace(/\s*\*USDZ/g, "").trim() });
    detail(`${symbol.padEnd(5)} ${purchases[purchases.length - 1].amount} *USDZ  ${short(r.transaction)}`);
  }
  record.purchases = purchases;
  lap("purchases"); await pause();

  // 3. Anchor. The seller logs a receipt after settlement, so wait until all six are in the log.
  step(3, "Anchor the new receipts on chain");
  const log = new ReceiptLog(receiptsPath);
  for (let i = 0; i < 30 && !txs.every((x) => log.byTx(x)); i++) await sleep(1000);
  if (!txs.every((x) => log.byTx(x))) fail("the seller has not logged all six receipts (is SELLER_RECEIPTS the seller's RECEIPT_LOG?)");
  const anchored = await anchorNew({ publicClient, walletClient, ledger, seller, fromBlock, receiptsPath });
  if (anchored === null) detail("nothing to anchor");
  else {
    detail(`batch ${anchored.batch}, ${anchored.count} receipts`);
    detail(`root ${anchored.root}`);
    detail(`tx   ${short(anchored.tx)}`);
    record.anchor = { batch: anchored.batch.toString(), root: anchored.root, tx: anchored.tx, count: anchored.count };
  }
  lap("anchor"); await pause();

  // 4. File the dispute
  step(4, "File the dispute with the court");
  const filed = await cli.pay(`${courtUrl}/disputes`, cred, { method: "POST", body: JSON.stringify({ complaint: COMPLAINT, payer: customer, txs }) });
  cliOk(filed, "filing the dispute");
  let caseId: string | undefined;
  try { caseId = (JSON.parse(filed.body ?? "") as { caseId?: string }).caseId; } catch { /* reported below */ }
  if (!caseId) fail("the court did not return a case id");
  detail(`case ${caseId}`);
  detail(`fee tx ${filed.transaction ? short(filed.transaction) : "unknown"}`);
  record.caseId = caseId; record.feeTx = filed.transaction;
  lap("file"); await pause();

  // 5. Wait for the decision
  step(5, "Wait for the court's decision");
  let c = await getCase(caseId);
  const waitMs = Number(process.env.DEMO_DECISION_TIMEOUT_MS ?? 300_000);
  for (let waited = 0; c.status === "RUNNING" && waited < waitMs; waited += 2000) { await sleep(2000); c = await getCase(caseId); }
  if (c.status === "RUNNING") fail(`timed out after ${waitMs / 1000} s waiting for the decision`);
  if (c.status === "FAILED" || c.status === "FILER_MISMATCH") fail(`case ${c.status}: ${c.error ?? ""}`);
  const showTable = (cs: CaseJson) => {
    for (const cl of cs.claims) {
      const f = cs.findings.find((x) => x.claimId === cl.id);
      const r = cs.rulings.find((x) => x.claimId === cl.id);
      detail([cl.id, cl.code, f?.state ?? "-", r?.verdict ?? "-", r?.decidedBy ?? "-", r ? `${usdz(r.refund)} *USDZ` : "-"].join(" | "));
    }
  };
  detail("claim | code | finding | verdict | decided by | refund");
  showTable(c);
  lap("decision"); await pause();

  // 6. Human approval
  step(6, "Human approval of escalated claims");
  const open = (cs: CaseJson) => cs.rulings.filter((r) => r.verdict === "ESCALATE");
  const escalated = open(c);
  if (escalated.length === 0) detail("no escalations, nothing for a human to decide");
  for (const r of escalated) {
    const reason = (r as { reason?: string }).reason ?? "no reason recorded";
    detail(`${r.claimId} escalated (${usdz(r.proposedRefund)} *USDZ at stake): ${reason}`);
  }
  if (escalated.length > 0) {
    if (autoApprove) {
      for (const r of escalated) {
        const refund = BigInt(r.proposedRefund) > 0n;
        const res = await court(`/cases/${caseId}/approve`, { method: "POST", body: { claimId: r.claimId, decision: refund ? "REFUND" : "REJECT", amount: r.proposedRefund, approver: "demo-operator" } });
        if (res.status !== 200) fail(`approve ${r.claimId} failed (${res.status}): ${res.json?.error ?? ""}`);
        detail(refund ? `${r.claimId}: REFUND approved, bound to exactly ${usdz(r.proposedRefund)} *USDZ` : `${r.claimId}: nothing at stake, REJECT recorded`);
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
  lap("approval"); await pause();

  // 7. Publish
  step(7, "Publish the rulings on chain");
  const pub = await court(`/cases/${caseId}/publish`, { method: "POST", body: {} });
  if (pub.status !== 200) fail(`publish failed (${pub.status}): ${pub.json?.error ?? ""}`);
  const published = (pub.json as CaseJson).publishResults ?? [];
  for (const p of published) detail(`${short(p.tx)}: ${p.status}${p.hash ? `  ${short(p.hash)}` : ""}${p.reason ? `  ${p.reason}` : ""}`);
  if (published.some((p) => p.status === "failed")) fail("a ruling failed to publish");
  record.publishTxs = published.map((p) => ({ tx: p.tx, status: p.status, hash: p.hash ?? null }));
  lap("publish"); await pause();

  // 8. Objection window
  step(8, "Objection window (the seller may object)");
  const windowS = Number(await read<bigint>("objectionWindow"));
  const tty = process.stdout.isTTY === true;
  for (let left = windowS + 2; left > 0; left--) {
    if (tty) process.stdout.write(`\r    executable in ${String(left).padStart(4)} s   `);
    else if (left % 5 === 0 || left === windowS + 2) detail(`executable in ${left} s`);
    await sleep(1000);
  }
  if (tty) process.stdout.write("\r    objection window over                \n");
  else detail("objection window over");
  lap("window");

  // 9. Execute
  step(9, "Execute the refunds");
  let done = (await court(`/cases/${caseId}/execute`, { method: "POST", body: {} })).json as CaseJson;
  for (let i = 0; i < 5 && (done.executeResults ?? []).some((o) => o.status === "not_yet"); i++) {
    await sleep(3000); // block time can lag the wall clock
    done = (await court(`/cases/${caseId}/execute`, { method: "POST", body: {} })).json as CaseJson;
  }
  for (const o of done.executeResults ?? []) detail(`${short(o.tx)}: ${o.status}${o.hash ? `  ${short(o.hash)}` : ""}${o.reason ? `  ${o.reason}` : ""}`);
  if (done.feeRefundError) fail(`fee refund failed: ${done.feeRefundError}`);
  detail(`fee refund tx: ${done.feeRefundTx ? short(done.feeRefundTx) : "none (fee kept)"}`);
  if ((done.executeResults ?? []).some((o) => o.status === "failed" || o.status === "not_yet")) fail("a refund did not execute");
  lap("execute"); await pause();

  // 10. Summary
  step(10, "Summary");
  const paidTxs = new Set((done.executeResults ?? []).filter((o) => o.status === "paid" || o.status === "already_paid").map((o) => o.tx));
  const refunded = done.rulings.filter((r) => r.verdict === "REFUND" && paidTxs.has(r.tx)).reduce((a, r) => a + BigInt(r.refund), 0n);
  const balanceAfter = await read<bigint>("balanceOf", [customer], token);
  const delta = balanceAfter - balanceBefore;
  const fee = parseUsdz(process.env.FILING_FEE ?? "0.01");
  const paid = purchases.reduce((a, p) => a + parseUsdz(p.amount), 0n);
  detail(`customer paid ${usdz(paid)} for six quotes + ${usdz(fee)} filing fee; refunded ${usdz(refunded)}${done.feeRefundTx ? ` + ${usdz(fee)} fee` : " (fee kept)"}`);
  detail(`total refunded: ${usdz(refunded)} *USDZ (plus filing fee refund: ${done.feeRefundTx ? "yes" : "no"})`);
  detail(`buyer balance: ${usdz(balanceBefore)} -> ${usdz(balanceAfter)} (delta ${delta < 0n ? "-" : "+"}${usdz(delta < 0n ? -delta : delta)} *USDZ, after the purchases and the filing fee)`);
  record.executeTxs = (done.executeResults ?? []).map((o) => ({ tx: o.tx, status: o.status, hash: o.hash ?? null }));
  record.feeRefundTx = done.feeRefundTx;
  const out = new URL("../data/demo-run.json", import.meta.url);
  fs.mkdirSync(new URL("./", out), { recursive: true });
  fs.writeFileSync(out, JSON.stringify({ ...record, totalRefunded: refunded.toString(), buyerBalanceBefore: balanceBefore.toString(), buyerBalanceAfter: balanceAfter.toString(), buyerDelta: delta.toString(), timingsMs: timings, totalMs: Date.now() - startedAt }, null, 2) + "\n");
  detail("wrote data/demo-run.json");
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch((err) => fail(err instanceof Error ? (err as { shortMessage?: string }).shortMessage ?? err.message : String(err)));
}
