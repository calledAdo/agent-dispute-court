// Creates (or reuses by nickname) the EU licence beneficiary on the Airwallex sandbox and prints its id.
// Env: AWX_CLIENT_ID, AWX_API_KEY. Optional: BENEFICIARY_NICKNAME (default "eu-licence").
// The bank details are Airwallex's public sandbox test values for a German company account.
import { TreasuryAirwallexClient } from "@dispute-court/example-dataco";

const need = (n: string): string => {
  const v = process.env[n];
  if (!v) throw new Error(`missing env ${n}`);
  return v;
};

async function main(): Promise<void> {
  const client = new TreasuryAirwallexClient({ clientId: need("AWX_CLIENT_ID"), apiKey: need("AWX_API_KEY") });
  const nickname = process.env.BENEFICIARY_NICKNAME ?? "eu-licence";
  const list = await client.listBeneficiaries(); // UNVERIFIED shape
  const rows: any[] = Array.isArray(list) ? list : (list?.items ?? []);
  const existing = rows.find((b) => b.nickname === nickname || b.beneficiary?.nickname === nickname);
  if (existing?.id) {
    console.log(`Reusing beneficiary "${nickname}": ${existing.id}`);
    return;
  }
  const created = await client.createBeneficiary({
    nickname,
    transfer_methods: ["SWIFT"],
    beneficiary: {
      entity_type: "COMPANY",
      company_name: "EU Data Licensing GmbH",
      address: { country_code: "DE", city: "Frankfurt", street_address: "Taunusanlage 1", postcode: "60329" },
      bank_details: {
        account_currency: "EUR",
        account_name: "EU Data Licensing GmbH",
        bank_country_code: "DE",
        iban: "DE89370400440532013000",
        swift_code: "COBADEFFXXX",
      },
    },
  });
  console.log(`Created beneficiary "${nickname}": ${created.id}`);
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
