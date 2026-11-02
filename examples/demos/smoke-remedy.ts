// Live check of court/remedy.ts against the deployed CourtVault. Key path and RPC come from env.
import fs from "node:fs";
import { createPublicClient, createWalletClient, http, defineChain, parseUnits, keccak256, toHex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { publishRulings, executeDue } from "@dispute-court/court";
const rpc = process.env.METAL_RPC_URL!;
const chain = defineChain({ id: 63825, name: "Metal Testnet", nativeCurrency: { name: "USDZ", symbol: "USDZ", decimals: 18 }, rpcUrls: { default: { http: [rpc] } } });
const publicClient = createPublicClient({ chain, transport: http(rpc) });
const walletClient = createWalletClient({ chain, transport: http(rpc), account: privateKeyToAccount(JSON.parse(fs.readFileSync(process.env.COURT_KEY_FILE!, "utf8")).privateKey) });
const { abi } = JSON.parse(fs.readFileSync("packages/contracts/contracts/build/CourtVault.json", "utf8"));
const deps = { publicClient, walletClient, vault: process.env.COURT_VAULT as `0x${string}`, vaultAbi: abi, seller: process.env.SELLER as `0x${string}`, evidenceRoot: () => keccak256(toHex("smoke-evidence")) } as any;
const tx = process.env.TX!, payer = process.env.PAYER as `0x${string}`;
const ruling = { claimId: "c1", tx, code: "A13.3", verdict: "REFUND", liable: "SELLER", refund: parseUnits("0.05", 18), proposedRefund: parseUnits("0.05", 18), reason: "stale_quote", evidence: [tx], decidedBy: "code" };
console.log("publish #1:", JSON.stringify(await publishRulings([ruling as any], () => payer, process.env.SELLER as `0x${string}`, deps)));
console.log("publish #2:", JSON.stringify(await publishRulings([ruling as any], () => payer, process.env.SELLER as `0x${string}`, deps)));
console.log("execute early:", JSON.stringify(await executeDue([tx], deps)));
await new Promise((r) => setTimeout(r, 25000));
console.log("execute after window:", JSON.stringify(await executeDue([tx], deps)));
console.log("execute again:", JSON.stringify(await executeDue([tx], deps)));
