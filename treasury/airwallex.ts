// Treasury calls on the Airwallex sandbox. Reuses the login, bearer and 429 retry of card/airwallex.ts.
//
// Sources: https://www.airwallex.com/docs/api (transactional_fx conversions create, payouts beneficiaries
// schema/create, transfers create, simulation deposits create). Calls confirmed live: listGlobalAccounts, simulateDeposit, getBalances, fxQuote, fxConvert, beneficiarySchema; the rest is UNVERIFIED.
import { AirwallexClient, defined, enc } from "../card/airwallex.ts";

export type TransferMethod = "LOCAL" | "SWIFT";
export type TransferStatus = "CREATED" | "SENT" | "PAID" | "FAILED" | "CANCELLED" | string; // UNVERIFIED enum

/** EUR SWIFT costs a flat EUR 12.85 (guide). Kept in cents. */
export const SWIFT_FEE_EUR_CENTS = 1285n;

export class TreasuryAirwallexClient extends AirwallexClient {
  listGlobalAccounts(): Promise<any> {
    return this.call("GET", `${this.baseUrl}/global_accounts`);
  }

  createGlobalAccount(a: { country_code: string; currency: string; requestId?: string }) {
    return this.post("/global_accounts/create", { country_code: a.country_code, currency: a.currency }, a.requestId); // UNVERIFIED
  }

  // Sandbox only. Confirmed live.
  simulateDeposit(a: { global_account_id: string; amount: number; reference: string; requestId?: string }) {
    return this.post("/simulation/deposit/create", { global_account_id: a.global_account_id, amount: a.amount, reference: a.reference }, a.requestId);
  }

  getBalances(): Promise<any> {
    return this.call("GET", `${this.baseUrl}/balances/current`);
  }

  // Confirmed live (no x-api-version header is ever sent on FX calls).
  fxQuote(a: { sell_currency: string; buy_currency: string; buy_amount: number }) {
    return this.call("GET", `${this.baseUrl}/fx/rates/current?${new URLSearchParams({
      sell_currency: a.sell_currency, buy_currency: a.buy_currency, buy_amount: String(a.buy_amount),
    })}`);
  }

  // POST /fx/conversions/create, no x-api-version (guide). Confirmed live.
  fxConvert(a: { quote_id?: string; sell_currency: string; buy_currency: string; buy_amount: number; requestId?: string }) {
    return this.post(
      "/fx/conversions/create",
      defined({ quote_id: a.quote_id, sell_currency: a.sell_currency, buy_currency: a.buy_currency, buy_amount: a.buy_amount, reason: "payment to supplier", term_agreement: true }),
      a.requestId,
    );
  }

  // Confirmed live.
  beneficiarySchema(q: { bank_country_code: string; account_currency: string; transfer_method: TransferMethod }) {
    return this.call("POST", `${this.baseUrl}/beneficiary_api_schemas/generate`, q);
  }

  createBeneficiary(beneficiary: Record<string, unknown>, requestId?: string) {
    return this.post("/beneficiaries/create", { beneficiary }, requestId); // UNVERIFIED wrapper key
  }

  // Guide: send transfer_currency / transfer_amount (not payment_*); amounts in major units.
  createTransfer(a: { beneficiary_id: string; transfer_amount: number; transfer_currency: string; transfer_method: TransferMethod; reference: string; requestId?: string }) {
    return this.post(
      "/transfers/create",
      {
        beneficiary_id: a.beneficiary_id,
        transfer_amount: a.transfer_amount,
        transfer_currency: a.transfer_currency,
        transfer_method: a.transfer_method,
        reference: a.reference,
        source_currency: a.transfer_currency, // UNVERIFIED: required source fields
        reason: "payment to supplier", // UNVERIFIED
      },
      a.requestId,
    );
  }

  getTransfer(id: string): Promise<any> {
    return this.call("GET", `${this.baseUrl}/transfers/${enc(id)}`); // UNVERIFIED path
  }

  // Sandbox only. A failed transfer ends CANCELLED; SENT is in flight, not final (guide).
  simulateTransferTransition(id: string, status: string) {
    return this.call("POST", `${this.baseUrl}/simulation/transfers/${enc(id)}/transition`, { status }); // UNVERIFIED
  }
}
