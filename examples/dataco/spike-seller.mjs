// Hypothesis test: bind the agent's signed order to the exact request (query included),
// not just the route, by deriving extra.resource per request. Also keeps a delivery
// receipt (request hash, response hash, tx, signed order) for every paid sale.
import express from "express";
import fs from "node:fs";
import crypto from "node:crypto";
import { HTTPFacilitatorClient, x402ResourceServer, x402HTTPResourceServer } from "@x402/core/server";
import { paymentMiddlewareFromHTTPServer } from "@x402/express";
import { METAL_NETWORKS, registerMetalScheme } from "@metalntwx/metal-pay";
import { SIGNED_OFFER_REQUIRED, requireSignedOffer, signedOfferOf } from "@metalntwx/metal-pay/mandates";

const rpcUrl = fs.readFileSync(new URL("./.env", import.meta.url), "utf8").match(/METAL_RPC_URL=(.*)/)[1];
const PAY_TO = JSON.parse(fs.readFileSync(new URL("./keys/seller.key.json", import.meta.url))).address;
const MODE = process.env.BIND ?? "request"; // "request" = per-request resource, "route" = static resource
const sha = (s) => crypto.createHash("sha256").update(s).digest("hex");

const facilitator = new HTTPFacilitatorClient({ url: METAL_NETWORKS.testnet.facilitatorUrl });
const server = requireSignedOffer(registerMetalScheme(new x402ResourceServer(facilitator), { networks: ["testnet"] }), { rpcUrl });
await server.initialize();

// Canonical request: method, path, sorted query. This string is what the agent signs.
function canonical(req) {
  const q = new URLSearchParams(Object.entries(req.query).map(([k, v]) => [k, String(v)]).sort(([a], [b]) => a.localeCompare(b)));
  return `${req.method} ${req.path}${q.size ? "?" + q : ""}`;
}

server.onAfterSettle(async ({ paymentPayload, requirements, result, transportContext }) => {
  const settlement = result.extra?.settlement;
  if (!result.success || !settlement?.first) return;
  const body = Buffer.from(transportContext?.responseBody ?? []).toString("utf8");
  const receipt = {
    tx: result.transaction, payer: result.payer, resource: requirements.extra?.resource,
    requestHash: requirements.extra?.requestHash, responseHash: sha(body), response: body,
    signedOrder: signedOfferOf(paymentPayload), at: new Date().toISOString(),
  };
  fs.appendFileSync(new URL("./deliveries.jsonl", import.meta.url), JSON.stringify(receipt) + "\n");
  console.log("settled", receipt.tx, receipt.resource);
});

const app = express();
app.use((req, res, next) => {
  if (req.path !== "/quote") return next();
  const resource = MODE === "request" ? canonical(req) : "GET /quote";
  const routes = {
    "GET /quote": {
      accepts: {
        scheme: "exact", network: "eip155:63825", payTo: PAY_TO, price: "0.05",
        extra: { ...SIGNED_OFFER_REQUIRED, resource, requestHash: sha(resource) },
      },
      description: "One market quote",
    },
  };
  // One HTTP server per request so the 402 offer (and therefore the signed order) names this request.
  const http = new x402HTTPResourceServer(server, routes);
  return paymentMiddlewareFromHTTPServer(http, undefined, undefined, false)(req, res, next);
});
app.get("/quote", (req, res) => {
  const sym = String(req.query.symbol ?? "AAPL").toUpperCase();
  res.json({ symbol: sym, price: 100 + (sym.charCodeAt(0) % 50) + 0.25, source: "upstream-A", asOf: new Date().toISOString() });
});
app.listen(4021, () => console.log("seller on :4021 payTo", PAY_TO, "mode", MODE));
