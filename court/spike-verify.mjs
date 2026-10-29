// The court's cryptographic test: for each disputed sale, check the stored signed order
// against the on-chain payment, then read which exact request the agent signed.
import fs from "node:fs";
import { createPublicClient, http } from "viem";
import { verifyMandatePayment } from "@metalntwx/metal-pay/mandates";
const rpc = fs.readFileSync(new URL("./.env", import.meta.url), "utf8").match(/METAL_RPC_URL=(.*)/)[1];
const client = createPublicClient({ transport: http(rpc) });
const b64 = (s) => JSON.parse(Buffer.from(s, "base64url").toString());
function signedRequest(order) {
  const disclosure = b64(order.split("~")[1]);           // [salt, {vct, checkout_jwt, ...}]
  const offer = b64(disclosure[1].checkout_jwt.split(".")[1]);
  return { lineItem: disclosure[1].line_items[0].id, requestHash: offer.extra.requestHash, amount: offer.amount, payTo: offer.id };
}
const sales = fs.readFileSync("deliveries.jsonl", "utf8").trim().split("\n").map(JSON.parse);
const s = sales.at(-1);
const r = await verifyMandatePayment(client, { tx: s.tx, checkoutMandate: s.signedOrder });
console.log("A. genuine order vs its tx      ->", r.ok ? "VALID" : "FAIL", "|", r.steps.map(x => `${x.outcome}`).join(","));
console.log("   agent signed for             ->", signedRequest(s.signedOrder));
const other = sales.find(x => x.tx !== s.tx);
if (other) {
  const r2 = await verifyMandatePayment(client, { tx: other.tx, checkoutMandate: s.signedOrder }).catch(e => ({ ok: false, steps: [{ outcome: "fail", detail: e.message }] }));
  console.log("B. order replayed on other tx   ->", r2.ok ? "VALID" : "FAIL:", r2.steps?.find(x => x.outcome === "fail")?.detail);
}
const parts = s.signedOrder.split("~"); const d = b64(parts[1]); d[1].line_items[0].id = "GET /quote?symbol=AAPL";
const forged = [parts[0], Buffer.from(JSON.stringify(d)).toString("base64url"), ...parts.slice(2)].join("~");
const r3 = await verifyMandatePayment(client, { tx: s.tx, checkoutMandate: forged }).catch(e => ({ ok: false, steps: [{ outcome: "fail", detail: e.message }] }));
console.log("C. line item edited to AAPL     ->", r3.ok ? "VALID (BAD!)" : "FAIL:", r3.steps?.find(x => x.outcome === "fail")?.detail);
const r4 = await verifyMandatePayment(client, { tx: s.tx });
console.log("D. tx alone (no order)          ->", r4.ok ? "VALID" : "FAIL", "|", r4.steps.at(-1)?.detail?.slice(-60));
console.log("E. response hash still matches  ->", (await import("node:crypto")).createHash("sha256").update(s.response).digest("hex") === s.responseHash);
