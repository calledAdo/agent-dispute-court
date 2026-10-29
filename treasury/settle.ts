import fs from "node:fs";
import path from "node:path";
import { SWIFT_FEE_EUR_CENTS } from "./airwallex.ts";

const USDZ_CENT = 10n ** 16n; // base units per cent (18 decimals)

/** The Airwallex calls settle.ts needs, so tests can stub them. */
export interface TreasuryClient {
  simulateDeposit(a: { global_account_id: string; amount: number; reference: string }): Promise<any>;
  fxQuote(a: { sell_currency: string; buy_currency: string; buy_amount: number }): Promise<any>;
  fxConvert(a: { quote_id?: string; sell_currency: string; buy_currency: string; buy_amount: number }): Promise<any>;
  createTransfer(a: { beneficiary_id: string; transfer_amount: number; transfer_currency: string; transfer_method: "LOCAL" | "SWIFT"; reference: string }): Promise<any>;
}

/** Append-only JSONL ledger keyed by "credit:<txHash>" or "fee:<invoiceId>". The last line for a key wins. */
export class Ledger {
  private file: string;
  constructor(file: string) {
    this.file = file;
  }
  get(key: string): any | undefined {
    if (!fs.existsSync(this.file)) return undefined;
    let found: any;
    for (const line of fs.readFileSync(this.file, "utf8").split("\n")) {
      if (!line.trim()) continue;
      const row = JSON.parse(line);
      if (row.key === key) found = row.value;
    }
    return found;
  }
  put(key: string, value: unknown): void {
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    fs.appendFileSync(this.file, JSON.stringify({ key, value }) + "\n");
  }
}

const major = (cents: bigint): number => Number(cents / 100n) + Number(cents % 100n) / 100;

export interface SettleArgs { amountUsdz: bigint; metalTxHash: string; ledger: Ledger; client: TreasuryClient; globalAccountId: string }
export interface SettleResult { metalTxHash: string; usdCents: string; deposit: any; replayed: boolean }

/**
 * Sandbox can't receive stablecoins: record the Metal tx as credited, then simulate a USD deposit of the
 * same amount with the tx hash as `reference`. A second call with the same hash returns the stored result.
 */
export async function settleEarnings(a: SettleArgs): Promise<SettleResult> {
  const key = `credit:${a.metalTxHash.toLowerCase()}`;
  const stored = a.ledger.get(key);
  if (stored?.deposit) return { ...stored, replayed: true };
  const usdCents = a.amountUsdz / USDZ_CENT; // whole cents, rounded down
  if (usdCents <= 0n) throw new Error("amount below one cent");
  // Credit first so a crash after the deposit cannot double-credit on retry with a new reference.
  a.ledger.put(key, { metalTxHash: a.metalTxHash, usdCents: String(usdCents), deposit: null });
  const deposit = await a.client.simulateDeposit({ global_account_id: a.globalAccountId, amount: major(usdCents), reference: a.metalTxHash });
  const result = { metalTxHash: a.metalTxHash, usdCents: String(usdCents), deposit };
  a.ledger.put(key, result);
  return { ...result, replayed: false };
}

export interface FeeArgs {
  eurAmount: number; // major units, e.g. 50
  beneficiary: string; // beneficiary id
  invoiceId: string;
  ledger: Ledger;
  client: TreasuryClient;
}
export interface FeeResult { invoiceId: string; quoteId?: string; conversionId?: string; transferId?: string; replayed: boolean }

/** Quote USD->EUR for the fee plus the flat SWIFT charge, convert, then create the SWIFT transfer. Idempotent by invoice id. */
export async function payLicenceFee(a: FeeArgs): Promise<FeeResult> {
  const key = `fee:${a.invoiceId}`;
  const stored = a.ledger.get(key);
  if (stored?.transferId) return { ...stored, replayed: true };
  const feeCents = BigInt(Math.round(a.eurAmount * 100));
  const buyEur = major(feeCents + SWIFT_FEE_EUR_CENTS); // EUR 50 -> EUR 62.85
  const quote = await a.client.fxQuote({ sell_currency: "USD", buy_currency: "EUR", buy_amount: buyEur });
  const conversion = await a.client.fxConvert({ quote_id: quote?.id ?? quote?.quote_id, sell_currency: "USD", buy_currency: "EUR", buy_amount: buyEur }); // UNVERIFIED quote id field
  const transfer = await a.client.createTransfer({
    beneficiary_id: a.beneficiary,
    transfer_amount: major(feeCents),
    transfer_currency: "EUR",
    transfer_method: "SWIFT",
    reference: a.invoiceId,
  });
  const result = { invoiceId: a.invoiceId, quoteId: quote?.id ?? quote?.quote_id, conversionId: conversion?.id ?? conversion?.conversion_id, transferId: transfer?.id ?? transfer?.transfer_id };
  a.ledger.put(key, result);
  return { ...result, replayed: false };
}
