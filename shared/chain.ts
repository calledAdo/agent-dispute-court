import fs from "node:fs";
import { createPublicClient, createWalletClient, defineChain, http, parseAbi } from "viem";
import type { Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";

export const LOG_CHUNK = 50000n;
// Metal cannot estimate gas, so gas and fees are explicit on every write.
export const GAS = { gas: 300000n, maxFeePerGas: 1n, maxPriorityFeePerGas: 1n } as const;
export const ledgerEvents = parseAbi(["event DeliveriesCommitted(address indexed seller, uint256 indexed batch, bytes32 root, uint256 count, string uri)"]);

/** Reads a key from the file at `path` (raw hex or JSON with privateKey). The value is never logged. */
export function loadKey(path: string): Hex {
  const text = fs.readFileSync(path, "utf8").trim();
  const key = text.startsWith("{") ? (JSON.parse(text) as { privateKey: string }).privateKey : text;
  return (key.startsWith("0x") ? key : `0x${key}`) as Hex;
}

export function metalClients(rpcUrl: string, keyFile: string) {
  const account = privateKeyToAccount(loadKey(keyFile));
  const chain = defineChain({ id: 63825, name: "Metal Testnet", nativeCurrency: { name: "USDZ", symbol: "USDZ", decimals: 18 }, rpcUrls: { default: { http: [rpcUrl] } } });
  return {
    account, chain,
    publicClient: createPublicClient({ chain, transport: http(rpcUrl) }),
    walletClient: createWalletClient({ chain, transport: http(rpcUrl), account }),
  };
}

export function requiredEnv(name: string): string {
  const v = process.env[name];
  if (v === undefined || v === "") throw new Error(`${name} is required`);
  return v;
}
