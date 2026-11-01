import fs from "node:fs";
import { fileURLToPath } from "node:url";
import Anthropic from "@anthropic-ai/sdk";
import { createPublicClient, createWalletClient, defineChain, http, keccak256, parseAbi, parseUnits, toHex } from "viem";
import type { Abi, Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { HTTPFacilitatorClient, x402ResourceServer } from "@x402/core/server";
import { METAL_NETWORKS, registerMetalScheme } from "@metalntwx/metal-pay";
import { verifyMandatePayment } from "@metalntwx/metal-pay/mandates";
import { mapBatches } from "../shared/batches.ts";
import { ReceiptLog } from "../seller/receipts.ts";
import { METAL_TESTNET } from "../seller/offer.ts";
import { defaultUpstream } from "../seller/server.ts";
import { parseUnavailable } from "./reference.ts";
import { createCourtApp, sanitizeError } from "./api.ts";
import { runCase } from "./case.ts";
import type { CaseDeps, CaseInput } from "./case.ts";
import { loadSellers } from "./sellers.ts";
import type { SellerConfig } from "./sellers.ts";
import { createCaseStore } from "./store.ts";
import { executeDue, publishRulings } from "./remedy.ts";
import type { RemedyDeps } from "./remedy.ts";
import type { EvidenceDeps } from "./evidence.ts";
import type { Policy } from "./verdict.ts";

const LOG_CHUNK = 100000n; // Metal's eth_getLogs range limit
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

function main(): void {
  const port = Number(process.env.COURT_PORT ?? 4022);
  const rpcUrl = required("METAL_RPC_URL");
  const keyFile = required("COURT_KEY_FILE");
  const vault = required("COURT_VAULT") as `0x${string}`;
  const ledger = required("COURT_LEDGER") as `0x${string}`;
  const operatorToken = required("OPERATOR_TOKEN");
  const filingFee = process.env.FILING_FEE ?? "0.01";
  const fromBlockText = required("COURT_LEDGER_FROM_BLOCK");
  if (!/^\d+$/.test(fromBlockText)) {
    console.error("COURT_LEDGER_FROM_BLOCK must be a decimal block number");
    process.exit(1);
  }
  const ledgerFromBlock = BigInt(fromBlockText);
  const unavailable = parseUnavailable(process.env.REFERENCE_UNAVAILABLE);
  const anthropicKey = process.env.ANTHROPIC_API_KEY;
  let sellers: SellerConfig[];
  try {
    sellers = loadSellers(process.env);
  } catch (e) {
    console.error(e instanceof Error ? e.message : String(e));
    process.exit(1);
  }

  const account = privateKeyToAccount(loadKey(keyFile));
  const chain = defineChain({ id: 63825, name: "Metal Testnet", nativeCurrency: { name: "USDZ", symbol: "USDZ", decimals: 18 }, rpcUrls: { default: { http: [rpcUrl] } } });
  const publicClient = createPublicClient({ chain, transport: http(rpcUrl) });
  const walletClient = createWalletClient({ chain, transport: http(rpcUrl), account });

  const vaultAbi = abiOf("../contracts/build/CourtVault.json");
  const ledgerAbi = abiOf("../contracts/build/CourtLedger.json");

  // Not specified by the task: escalation limits come from optional env, defaulting to 1 USDZ.
  const policy: Policy = {
    autoRefundMax: parseUnits(process.env.COURT_AUTO_REFUND_MAX ?? "1", 18),
    escalateAbove: parseUnits(process.env.COURT_ESCALATE_ABOVE ?? "1", 18),
    filingFee: parseUnits(filingFee, 18),
  };
  const model = anthropicKey ? { client: new Anthropic({ apiKey: anthropicKey }) as never, name: process.env.COURT_MODEL ?? "claude-sonnet-5-5" } : null;

  const remedyDeps: RemedyDeps = {
    publicClient, walletClient, vault, vaultAbi,
    evidenceRoot: (r) => keccak256(toHex(JSON.stringify([r.claimId, r.tx, r.code, r.evidence]))),
  };

  interface SellerRuntime {
    config: SellerConfig;
    receipts: ReceiptLog;
    events: { batch: bigint; root: string; count: bigint }[];
    scannedTo: bigint;
    syncing: Promise<void> | null;
  }

  // Each seller has its own receipt log and its own place in the ledger's event stream.
  const runtimes = new Map<string, SellerRuntime>();
  for (const config of sellers) {
    runtimes.set(config.address.toLowerCase(), {
      config,
      receipts: new ReceiptLog(config.receipts),
      events: [],
      scannedTo: ledgerFromBlock - 1n,
      syncing: null,
    });
  }

  // Metal's RPC caps eth_getLogs ranges, so scan in chunks and remember what was scanned.
  // Concurrent callers share one scan, so an event is never recorded twice.
  function syncEvents(runtime: SellerRuntime): Promise<void> {
    runtime.syncing ??= scan(runtime).finally(() => { runtime.syncing = null; });
    return runtime.syncing;
  }

  async function scan(runtime: SellerRuntime): Promise<void> {
    const head = await publicClient.getBlockNumber();
    while (runtime.scannedTo < head) {
      const from = runtime.scannedTo + 1n;
      const to = from + LOG_CHUNK - 1n < head ? from + LOG_CHUNK - 1n : head;
      const logs = await publicClient.getLogs({ address: ledger, event: ledgerEvents[0], args: { seller: runtime.config.address }, fromBlock: from, toBlock: to });
      for (const l of logs) runtime.events.push({ batch: l.args.batch!, root: l.args.root!, count: l.args.count! });
      runtime.scannedTo = to; // advance only after the chunk succeeded, so a failure retries it
    }
  }

  // Receipts and batches are re-read for every case, so new anchors are picked up without a restart.
  async function caseDeps(seller: SellerConfig): Promise<CaseDeps> {
    const runtime = runtimes.get(seller.address.toLowerCase());
    if (runtime === undefined) throw new Error(`unknown seller ${seller.address}`);
    const receipts = runtime.receipts.all();
    await syncEvents(runtime);
    const batches = mapBatches(runtime.events, receipts);
    const evidence: EvidenceDeps = { publicClient, verify: verifyMandatePayment, ledger, ledgerAbi, seller: seller.address, receipts, batches };
    const priceList: Record<string, bigint> = {};
    for (const [route, price] of Object.entries(seller.priceList)) priceList[route] = parseUnits(price, 18);
    return {
      evidence, model, policy,
      reference: async (symbol, at) => (unavailable.includes(symbol.toUpperCase()) ? null : { symbol, price: defaultUpstream(symbol), at }),
      priceList,
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
    sellers,
    runCase: async (input: CaseInput) => {
      const seller = sellers.find((s) => s.address.toLowerCase() === input.seller.toLowerCase());
      if (seller === undefined) throw new Error(`unknown seller ${input.seller}`);
      return runCase(input, await caseDeps(seller));
    },
    store: createCaseStore(process.env.COURT_DATA_DIR ?? new URL("../data/", import.meta.url).pathname),
    remedy: {
      publish: (rulings, payerOf, seller) => publishRulings(rulings, payerOf, seller, remedyDeps),
      execute: (txs) => executeDue(txs, remedyDeps),
    },
    feeRefund,
    policy,
    operatorToken,
    now: () => Date.now(),
  });
  app.listen(port, () => console.log("court on :" + port, "payTo", account.address));
  // Catch up on every seller's anchors now, so the first case does not wait for a full scan.
  for (const runtime of runtimes.values()) {
    syncEvents(runtime).catch((e) => console.error("ledger scan failed, will retry on first case:", sanitizeError(e)));
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) main();
