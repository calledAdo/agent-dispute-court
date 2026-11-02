// Small helpers shared by the one-take demo scripts: printing, the court client, and the seller reserve.
import { formatUnits, parseAbi } from "viem";
import type { Account, Address, Chain, Hex, PublicClient, WalletClient } from "viem";
import { GAS } from "@dispute-court/protocol";

export const VAULT_ABI = parseAbi([
  "function heldBalanceOf(address owner, address spender) view returns (uint256)",
  "function reserve(uint256 amount)",
  "function objectionWindow() view returns (uint64)",
  "function token() view returns (address)",
  "function approve(address spender, uint256 amount) returns (bool)",
  "function balanceOf(address owner) view returns (uint256)",
]);

export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
export const short = (h: string) => `${h.slice(0, 10)}...${h.slice(-6)}`;
export const usdz = (x: bigint | string) => formatUnits(BigInt(x), 18);

export function fail(msg: string): never {
  console.error(`\nDemo stopped: ${msg}`);
  process.exit(1);
}

/** Writes one contract call and waits for it. Returns the tx hash, or throws if it reverted. */
export async function writeAndWait(args: {
  publicClient: PublicClient;
  walletClient: WalletClient;
  account: Account;
  chain: Chain;
  address: Address;
  functionName: string;
  args: unknown[];
}): Promise<Hex> {
  const hash = await args.walletClient.writeContract({
    address: args.address, abi: VAULT_ABI, functionName: args.functionName, args: args.args,
    chain: args.chain, account: args.account, ...GAS,
  } as never);
  const rc = await args.publicClient.waitForTransactionReceipt({ hash });
  if (rc.status !== "success") throw new Error(`${args.functionName} reverted: ${hash}`);
  return hash;
}

/** The vault's *USDZ token, the contract that holds and moves the money. */
export async function vaultToken(publicClient: PublicClient, vault: Address): Promise<Address> {
  return (await publicClient.readContract({ address: vault, abi: VAULT_ABI, functionName: "token" })) as Address;
}

/**
 * Makes sure `account` has at least `min` held in the vault, topping up by `topUp` if not.
 * This is step 1 of scripts/demo.ts, generalised to any seller's key.
 */
export async function ensureReserve(args: {
  publicClient: PublicClient;
  walletClient: WalletClient;
  account: Account;
  chain: Chain;
  vault: Address;
  token: Address;
  min: bigint;
  topUp: bigint;
}): Promise<{ held: bigint; toppedUp: boolean; approveTx?: Hex; reserveTx?: Hex }> {
  const heldNow = async (): Promise<bigint> =>
    (await args.publicClient.readContract({
      address: args.token, abi: VAULT_ABI, functionName: "heldBalanceOf", args: [args.account.address, args.vault],
    })) as bigint;

  const held = await heldNow();
  if (held >= args.min) return { held, toppedUp: false };

  const approveTx = await writeAndWait({
    publicClient: args.publicClient, walletClient: args.walletClient, account: args.account, chain: args.chain,
    address: args.token, functionName: "approve", args: [args.vault, args.topUp],
  });
  const reserveTx = await writeAndWait({
    publicClient: args.publicClient, walletClient: args.walletClient, account: args.account, chain: args.chain,
    address: args.vault, functionName: "reserve", args: [args.topUp],
  });
  return { held: await heldNow(), toppedUp: true, approveTx, reserveTx };
}

export interface CourtReply { status: number; json: any }
export interface CourtClient {
  get(path: string): Promise<CourtReply>;
  post(path: string, body: unknown): Promise<CourtReply>;
}

/** The court's HTTP API. Operator routes carry the token; nothing secret is ever logged. */
export function courtClient(courtUrl: string, operatorToken: string): CourtClient {
  const base = courtUrl.replace(/\/$/, "");
  const call = async (path: string, init?: { method: string; body: unknown }): Promise<CourtReply> => {
    const res = await fetch(base + path, init
      ? { method: init.method, headers: { "content-type": "application/json", "x-operator-token": operatorToken }, body: JSON.stringify(init.body) }
      : undefined);
    return { status: res.status, json: await res.json().catch(() => ({})) };
  };
  return {
    get: (path) => call(path),
    post: (path, body) => call(path, { method: "POST", body }),
  };
}
