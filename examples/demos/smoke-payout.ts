import { TreasuryAirwallexClient } from "@dispute-court/example-dataco";
const c: any = new TreasuryAirwallexClient({ clientId: process.env.AWX_CLIENT_ID!, apiKey: process.env.AWX_API_KEY! } as any);
const t = async (l: string, f: () => Promise<any>) => { try { const r = await f(); console.log("OK  ", l, JSON.stringify(r).slice(0, 300)); return r; } catch (e) { console.log("FAIL", l, String((e as Error).message).slice(0, 400)); return null; } };
const ben = await t("createBeneficiary", () => c.createBeneficiary({
  beneficiary: { entity_type: "COMPANY", company_name: "Euro Data Licensing GmbH",
    address: { country_code: "DE", city: "Berlin", street_address: "Friedrichstrasse 100", postcode: "10117" },
    bank_details: { account_currency: "EUR", account_name: "Euro Data Licensing GmbH", bank_country_code: "DE", iban: "DE89370400440532013000", swift_code: "COBADEFFXXX" } },
  transfer_methods: ["SWIFT"], nickname: "EU licence" }));
const id = ben?.id ?? ben?.beneficiary_id;
if (id) {
  const tr = await t("createTransfer", () => c.createTransfer({ beneficiary_id: id, transfer_amount: 50, transfer_currency: "EUR", transfer_method: "SWIFT", reference: "LIC-SMOKE", reason: "professional_business_services" }));
  if (tr?.id) { await t("getTransfer", () => c.getTransfer(tr.id)); await t("transition SENT", () => c.simulateTransferTransition(tr.id, "SENT")); await t("transition PAID", () => c.simulateTransferTransition(tr.id, "PAID")); }
}
