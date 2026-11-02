import fs from "node:fs";
import { parseUnits } from "viem";

/** One seller the court serves: its payee, its receipt log and the prices it quotes. */
export interface SellerConfig {
  name: string;
  address: `0x${string}`;
  receipts: string;                   // path to this seller's receipt log
  priceList: Record<string, string>;  // route -> decimal *USDZ per request
}

const ADDRESS = /^0x[0-9a-fA-F]{40}$/;
const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

/**
 * The court's sellers: a JSON file named by COURT_SELLERS, or the single DataCo seller the
 * existing demo runs with. Throws a message safe to print when the configuration is invalid.
 */
export function loadSellers(env: Record<string, string | undefined>): SellerConfig[] {
  const path = env.COURT_SELLERS;
  if (path !== undefined && path !== "") return readSellersFile(path);
  return [dataCo(env)];
}

function readSellersFile(path: string): SellerConfig[] {
  let text: string;
  try {
    text = fs.readFileSync(path, "utf8");
  } catch (e) {
    throw new Error(`COURT_SELLERS: cannot read ${path}: ${messageOf(e)}`);
  }

  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    throw new Error(`COURT_SELLERS: ${path} is not valid JSON`);
  }
  if (!Array.isArray(value) || value.length === 0) {
    throw new Error("COURT_SELLERS must be a non-empty JSON array of sellers");
  }

  const sellers = value.map((v, i) => readSeller(v, i));
  const names = new Set<string>();
  const addresses = new Set<string>();
  for (const seller of sellers) {
    if (names.has(seller.name)) throw new Error(`COURT_SELLERS: duplicate seller name "${seller.name}"`);
    names.add(seller.name);
    const key = seller.address.toLowerCase();
    if (addresses.has(key)) throw new Error(`COURT_SELLERS: duplicate seller address ${seller.address}`);
    addresses.add(key);
  }
  return sellers;
}

function readSeller(v: unknown, i: number): SellerConfig {
  if (!isRecord(v)) throw new Error(`COURT_SELLERS[${i}] must be an object`);
  const { name, address, receipts, priceList } = v;
  if (typeof name !== "string" || name.trim() === "") {
    throw new Error(`COURT_SELLERS[${i}].name must be a non-empty string`);
  }
  if (typeof address !== "string" || !ADDRESS.test(address)) {
    throw new Error(`COURT_SELLERS[${i}].address must be a 0x address`);
  }
  if (typeof receipts !== "string" || receipts.trim() === "") {
    throw new Error(`COURT_SELLERS[${i}].receipts must be a non-empty path`);
  }
  if (!isRecord(priceList)) throw new Error(`COURT_SELLERS[${i}].priceList must be an object`);

  const prices: Record<string, string> = {};
  for (const [route, price] of Object.entries(priceList)) {
    if (typeof price !== "string") {
      throw new Error(`COURT_SELLERS[${i}].priceList["${route}"] must be a decimal string`);
    }
    try {
      parseUnits(price, 18);
    } catch {
      throw new Error(`COURT_SELLERS[${i}].priceList["${route}"] is not a decimal amount: "${price}"`);
    }
    prices[route] = price;
  }

  return { name, address: address as `0x${string}`, receipts, priceList: prices };
}

/** The original one-seller configuration, so the existing demo keeps working unchanged. */
function dataCo(env: Record<string, string | undefined>): SellerConfig {
  const address = env.SELLER;
  if (address === undefined || address === "") {
    throw new Error("SELLER is required when COURT_SELLERS is not set");
  }
  if (!ADDRESS.test(address)) throw new Error("SELLER must be a 0x address");
  const receipts = env.SELLER_RECEIPTS;
  if (receipts === undefined || receipts === "") {
    throw new Error("SELLER_RECEIPTS is required when COURT_SELLERS is not set");
  }
  return {
    name: "DataCo",
    address: address as `0x${string}`,
    receipts,
    priceList: { "GET /quote": "0.05" },
  };
}

function messageOf(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}
