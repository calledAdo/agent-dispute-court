// Treasury calls on the Airwallex sandbox. Reuses the login, bearer and 429 retry of card/airwallex.ts.
//
// Sources: https://www.airwallex.com/docs/api (transactional_fx conversions create, payouts beneficiaries
// schema/create, transfers create, simulation deposits create). Calls confirmed live: listGlobalAccounts, simulateDeposit, getBalances, fxQuote, fxConvert, beneficiarySchema; beneficiaries and transfers confirmed live too (see below). Anything marked UNVERIFIED is not.
import { AirwallexClient, defined, enc } from "../card/airwallex.ts";

export type TransferMethod = "LOCAL" | "SWIFT";
export type TransferStatus = "CREATED" | "SENT" | "PAID" | "FAILED" | "CANCELLED" | string;

export interface BeneficiaryBody {
  request_id?: string;
  beneficiary: Record<string, unknown>;
  transfer_methods: TransferMethod[];
  nickname: string;
}

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
    return this.call("POST", `${this.baseUrl}/beneficiaries/schema`, q);
  }

  // Confirmed live: same body as create without request_id; answers "OK".
  validateBeneficiary(body: BeneficiaryBody) {
    return this.call("POST", `${this.baseUrl}/beneficiaries/validate`, body);
  }

  // Confirmed live (201). The response id is `id`.
  createBeneficiary(body: BeneficiaryBody, requestId?: string) {
    return this.post("/beneficiaries/create", body as unknown as Record<string, unknown>, requestId);
  }

  // UNVERIFIED: path and response shape ({items:[{id, nickname}]}) used to reuse a beneficiary by nickname.
  listBeneficiaries(): Promise<any> {
    return this.call("GET", `${this.baseUrl}/beneficiaries`);
  }

  // Confirmed live (201). Response has id, fee_amount, fee_currency, amount_payer_pays.
  createTransfer(a: { beneficiary_id: string; transfer_amount: number; transfer_currency: string; transfer_method: TransferMethod; reference: string; source_currency?: string; reason?: string; requestId?: string }) {
    return this.post(
      "/transfers/create",
      {
        beneficiary_id: a.beneficiary_id,
        transfer_amount: a.transfer_amount,
        transfer_currency: a.transfer_currency,
        source_currency: a.source_currency ?? a.transfer_currency,
        transfer_method: a.transfer_method,
        reference: a.reference,
        reason: a.reason ?? "professional_business_services",
      },
      a.requestId,
    );
  }

  getTransfer(id: string): Promise<any> {
    return this.call("GET", `${this.baseUrl}/transfers/${enc(id)}`);
  }

  // Sandbox only, confirmed live: body key is next_status (SENT, then PAID). SENT is in flight; a failed transfer ends CANCELLED.
  simulateTransferTransition(id: string, nextStatus: string) {
    return this.call("POST", `${this.baseUrl}/simulation/transfers/${enc(id)}/transition`, { next_status: nextStatus });
  }
}
