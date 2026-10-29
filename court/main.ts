import fs from "node:fs";
import { fileURLToPath } from "node:url";
import Anthropic from "@anthropic-ai/sdk";
import { createPublicClient, createWalletClient, defineChain, http, keccak256, parseAbi, parseUnits, toHex } from "viem";
import type { Abi, Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { HTTPFacilitatorClient, x402ResourceServer } from "@x402/core/server";
import { METAL_NETWORKS, registerMetalScheme } from "@metalntwx/metal-pay";
import { verifyMandatePayment } from "@metalntwx/metal-pay/mandates";
import { buildTree, receiptLeaf } from "../shared/merkle.ts";
import { ReceiptLog } from "../seller/receipts.ts";
import { METAL_TESTNET } from "../seller/offer.ts";
import { defaultUpstream } from "../seller/server.ts";
import { createCourtApp } from "./api.ts";
import { runCase } from "./case.ts";
import type { CaseDeps, CaseInput } from "./case.ts";
import { createCaseStore } from "./store.ts";
import { executeDue, publishRulings } from "./remedy.ts";
import type { RemedyDeps } from "./remedy.ts";
import type { EvidenceDeps } from "./evidence.ts";
import type { Policy } from "./verdict.ts";

const LOG_CHUNK = 50000n;
const GAS = { gas: 300000n, maxFeePerGas: 1n, maxPriorityFeePerGas: 1n } as const;
const tokenAbi = parseAbi(["function transfer(address to, uint256 amount) returns (bool)"]);
const ledgerEvents = parseAbi(["event DeliveriesCommitted(address indexed seller, uint256 indexed batch, bytes32 root, uint256 count, string uri)"]);

function required(name: string): string {
  const v = process.env[name];
  if (v === undefined || v === "") {
    console.error(`${name} is required`);
    process.exit(1);
  }
  return v;
}

const abiOf = (file: string): Abi => (JSON.parse(fs.readFileSync(new URL(file, import.meta.url), "utf8")) as { abi: Abi }).abi;

/** The one place the court key is read: from the file named by COURT_KEY_FILE. Never logged. */
function loadKey(path: string): Hex {
  const text = fs.readFileSync(path, "utf8").trim();
  const key = text.startsWith("{") ? (JSON.parse(text) as { privateKey: string }).privateKey : text;
  return (key.startsWith("0x") ? key : `0x${key}`) as Hex;
}

/**
 * Batches for the evidence module: a batch is one DeliveriesCommitted event of SELLER on the ledger.
 * The seller anchors receipts in log order, so batch k (ascending) covers the next `count` receipts of
 * SELLER_RECEIPTS. A batch is accepted only if the root recomputed from those receipts equals the root in
 * the event; a mismatched batch still consumes its `count` receipts (so later batches stay aligned) but
 * maps to nothing, which the evidence module reports as "not anchored / could not check".
 */
export function mapBatches(
  events: { batch: bigint; root: string; count: bigint }[],
  receipts: { tx: string; resource: string; requestHash: string; responseHash: string }[],
): { batch: bigint; txs: string[] }[] {
  const out: { batch: bigint; txs: string[] }[] = [];
  let cursor = 0;
  for (const ev of [...events].sort((a, b) => (a.batch < b.batch ? -1 : a.batch > b.batch ? 1 : 0))) {
    const slice = receipts.slice(cursor, cursor + Number(ev.count));
    cursor += Number(ev.count);
    if (slice.length !== Number(ev.count) || slice.length === 0) continue;
    if (buildTree(slice.map(receiptLeaf)).root.toLowerCase() === ev.root.toLowerCase()) out.push({ batch: ev.batch, txs: slice.map((r) => r.tx) });
  }
  return out;
}

function main(): void {
  const port = Number(process.env.COURT_PORT ?? 4022);
  const rpcUrl = required("METAL_RPC_URL");
  const keyFile = required("COURT_KEY_FILE");
  const vault = required("COURT_VAULT") as `0x${string}`;
  const ledger = required("COURT_LEDGER") as `0x${string}`;
  const seller = required("SELLER") as `0x${string}`;
  const receiptsPath = required("SELLER_RECEIPTS");
  const operatorToken = required("OPERATOR_TOKEN");
  const filingFee = process.env.FILING_FEE ?? "0.01";
  const fromBlockText = required("COURT_LEDGER_FROM_BLOCK");
  if (!/^\d+$/.test(fromBlockText)) {
    console.error("COURT_LEDGER_FROM_BLOCK must be a decimal block number");
    process.exit(1);
  }
  const ledgerFromBlock = BigInt(fromBlockText);
  const anthropicKey = process.env.ANTHROPIC_API_KEY;

  const account = privateKeyToAccount(loadKey(keyFile));
  const chain = defineChain({ id: 63825, name: "Metal Testnet", nativeCurrency: { name: "USDZ", symbol: "USDZ", decimals: 18 }, rpcUrls: { default: { http: [rpcUrl] } } });
  const publicClient = createPublicClient({ chain, transport: http(rpcUrl) });
  const walletClient = createWalletClient({ chain, transport: http(rpcUrl), account });

  const vaultAbi = abiOf("../contracts/build/CourtVault.json");
  const ledgerAbi = abiOf("../contracts/build/CourtLedger.json");
  const receiptLog = new ReceiptLog(receiptsPath);

  // Not specified by the task: escalation limits come from optional env, defaulting to 1 USDZ.
  const policy: Policy = {
    autoRefundMax: parseUnits(process.env.COURT_AUTO_REFUND_MAX ?? "1", 18),
    escalateAbove: parseUnits(process.env.COURT_ESCALATE_ABOVE ?? "1", 18),
    filingFee: parseUnits(filingFee, 18),
  };
  const model = anthropicKey ? { client: new Anthropic({ apiKey: anthropicKey }) as never, name: process.env.COURT_MODEL ?? "claude-sonnet-5-5" } : null;

  const remedyDeps: RemedyDeps = {
    publicClient, walletClient, vault, vaultAbi, seller,
    evidenceRoot: (r) => keccak256(toHex(JSON.stringify([r.claimId, r.tx, r.code, r.evidence]))),
  };

  // Metal's RPC caps eth_getLogs ranges, so scan in chunks and remember what was scanned.
  const events: { batch: bigint; root: string; count: bigint }[] = [];
  let scannedTo = ledgerFromBlock - 1n;
  async function syncEvents(): Promise<void> {
    const head = await publicClient.getBlockNumber();
    while (scannedTo < head) {
      const from = scannedTo + 1n;
      const to = from + LOG_CHUNK - 1n < head ? from + LOG_CHUNK - 1n : head;
      const logs = await publicClient.getLogs({ address: ledger, event: ledgerEvents[0], args: { seller }, fromBlock: from, toBlock: to });
      for (const l of logs) events.push({ batch: l.args.batch!, root: l.args.root!, count: l.args.count! });
      scannedTo = to; // advance only after the chunk succeeded, so a failure retries it
    }
  }

  // Receipts and batches are re-read for every case, so new anchors are picked up without a restart.
  async function caseDeps(): Promise<CaseDeps> {
    const receipts = receiptLog.all();
    await syncEvents();
    const batches = mapBatches(events, receipts);
    const evidence: EvidenceDeps = { publicClient, verify: verifyMandatePayment, ledger, ledgerAbi, seller, receipts, batches };
    return {
      evidence, model, policy,
      reference: async (symbol, at) => ({ symbol, price: defaultUpstream(symbol), at }),
      priceList: { "GET /quote": parseUnits("0.05", 18) },
      duplicateWindowMs: 60000,
      now: () => Date.now(),
    };
  }

  const server = registerMetalScheme(
    new x402ResourceServer(new HTTPFacilitatorClient({ url: METAL_NETWORKS.testnet.facilitatorUrl })),
    { networks: ["testnet"] },
  );
  const routes = {
    "POST /disputes": {
      accepts: { scheme: "exact", network: METAL_TESTNET, payTo: account.address, price: filingFee },
      description: "Dispute filing bond (refunded if any claim wins)",
    },
  };

  // The token is the vault's MIP20; the filing fee refund is a plain transfer from the court key.
  async function feeRefund(payer: string, amount: bigint): Promise<{ hash: string }> {
    const token = (await publicClient.readContract({ address: vault, abi: vaultAbi, functionName: "token" })) as `0x${string}`;
    const hash = await walletClient.writeContract({ address: token, abi: tokenAbi, functionName: "transfer", args: [payer as `0x${string}`, amount], chain, account, ...GAS });
    const receipt = await publicClient.waitForTransactionReceipt({ hash });
    if (receipt.status !== "success") throw new Error(`fee refund reverted: ${hash}`);
    return { hash };
  }

  const app = createCourtApp({
    x402: { server, routes },
    runCase: async (input: CaseInput) => runCase(input, await caseDeps()),
    store: createCaseStore(process.env.COURT_DATA_DIR ?? new URL("../data/", import.meta.url).pathname),
    remedy: {
      publish: (rulings, payerOf) => publishRulings(rulings, payerOf, remedyDeps),
      execute: (txs) => executeDue(txs, remedyDeps),
    },
    feeRefund,
    policy,
    operatorToken,
    now: () => Date.now(),
  });
  app.listen(port, () => console.log("court on :" + port, "payTo", account.address));
}

if (process.argv[1] === fileURLToPath(import.meta.url)) main();
