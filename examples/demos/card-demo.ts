// Runs the three Kit 4 cases against the Airwallex SANDBOX. Reads AWX_CLIENT_ID / AWX_API_KEY
// from process.env only. Not run by tests; the reviewer runs it with real keys.
import { AirwallexClient } from "@dispute-court/court";
import { decideCard, DEFAULT_DISPUTE_FEE, type CardEvidence } from "@dispute-court/court";
import { buildEvidencePdf } from "@dispute-court/court";

const clientId = process.env.AWX_CLIENT_ID;
const apiKey = process.env.AWX_API_KEY;
if (!clientId || !apiKey) throw new Error("Set AWX_CLIENT_ID and AWX_API_KEY");

const awx = new AirwallexClient({ clientId, apiKey });
const policy = { disputeFee: DEFAULT_DISPUTE_FEE, minWinProbability: 0.4 };
const inDays = (n: number) => new Date(Date.now() + n * 86_400_000).toISOString();
const show = (label: string, v: unknown) => console.log(`\n== ${label}\n${JSON.stringify(v, null, 2)}`);

type Case = { name: string; amount: number; reasonCode: string; evidence: CardEvidence };
const cases: Case[] = [
  { name: "large fraud, strong evidence", amount: 500, reasonCode: "10.4",
    evidence: { deviceMatchesPriorOrders: true, priorUndisputedOrders: 5, deliverySigned: true } },
  { name: "small not-received", amount: 20, reasonCode: "13.1", evidence: { deliveryScanned: true } },
  { name: "credit not processed", amount: 80, reasonCode: "13.6",
    evidence: { customerContactedSupport: 2, supportReplied: false } },
];

for (const c of cases) {
  console.log(`\n######## ${c.name}`);
  const intent = await awx.createPaymentIntent({ amount: c.amount, currency: "USD", merchantOrderId: `demo-${crypto.randomUUID()}` });
  show("payment intent", intent);
  show("confirm", await awx.confirmWithTestCard(intent.id));
  const dispute = await awx.simulateDispute({ paymentIntentId: intent.id, reasonCode: c.reasonCode, dueAt: inDays(7) });
  show("dispute", dispute);

  const decision = decideCard({ amount: c.amount, currency: "USD", reasonCode: c.reasonCode, evidence: c.evidence }, policy);
  show("decision", decision);

  if (decision.action === "CHALLENGE") {
    const pdf = buildEvidencePdf([`Evidence for dispute ${dispute.id}`, `Reason code ${c.reasonCode}`, JSON.stringify(c.evidence)]);
    const file = await awx.uploadEvidencePdf(pdf, "evidence.pdf");
    show("upload", file);
    show("challenge", await awx.challengeDispute(dispute.id, {
      reason: "PURCHASE_HISTORY", productType: "DIGITAL_PRODUCT_OR_SERVICE",
      description: decision.reason, fileIds: [file.file_id],
    }));
    show("escalate (bank rejects evidence)", await awx.escalate(dispute.id, { dueAt: inDays(14), comment: "evidence declined" }));
    show("dispute after escalate", await awx.getDispute(dispute.id));
  } else if (decision.action === "ACCEPT") {
    show("accept", await awx.acceptDispute(dispute.id, { reason: "LOW_VALUE_TRANSACTION", description: decision.reason }));
  } else {
    console.log("ESCALATE to a human; no API call made.");
  }
}
