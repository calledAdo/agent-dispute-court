import express from "express";
import type { Express } from "express";
import { fileURLToPath } from "node:url";
import { HTTPFacilitatorClient, x402ResourceServer, x402HTTPResourceServer } from "@x402/core/server";
import { paymentMiddlewareFromHTTPServer } from "@x402/express";
import { METAL_NETWORKS, registerMetalScheme } from "@metalntwx/metal-pay";
import { isValidPrice } from "@dispute-court/protocol";
import { METAL_TESTNET } from "@dispute-court/seller";

export const DEFAULT_UPSTREAM_PRICE = "0.02";

export interface UpstreamOptions {
  payTo: string;
  priceOf?: () => string;
  /** Changes the price returned by priceOf. Omit to disable POST /admin/price. */
  setPrice?: (price: string) => void;
  operatorToken: string;
  facilitatorUrl?: string;
}

export function createUpstream(opts: UpstreamOptions): Express {
  let current = DEFAULT_UPSTREAM_PRICE;
  const priceOf = opts.priceOf ?? (() => current);
  const setPrice = opts.setPrice ?? ((p: string) => { current = p; });
  const facilitator = new HTTPFacilitatorClient({ url: opts.facilitatorUrl ?? METAL_NETWORKS.testnet.facilitatorUrl });
  const server = registerMetalScheme(new x402ResourceServer(facilitator), { networks: ["testnet"] });

  let ready: Promise<void> | null = null;
  const ensureInitialized = (): Promise<void> => {
    ready ??= Promise.resolve(server.initialize()).catch((err) => { ready = null; throw err; });
    return ready;
  };

  const app = express();
  app.use(express.json());

  // Operator-only price change; drives the 0.02 -> 0.04 scene.
  app.post("/admin/price", (req, res) => {
    if (req.header("x-operator-token") !== opts.operatorToken) {
      res.status(401).json({ error: "bad operator token" });
      return;
    }
    const price = req.body?.price;
    if (!isValidPrice(price)) {
      res.status(400).json({ error: "price must be a decimal with two places" });
      return;
    }
    setPrice(price);
    res.json({ price: priceOf() });
  });

  app.use(async (req, res, next) => {
    if (req.path !== "/raw") return next();
    try {
      await ensureInitialized();
    } catch {
      res.status(503).json({ error: "payment server not ready" });
      return;
    }
    // Built per request so a price change applies to the next 402 offer.
    const routes = {
      "GET /raw": {
        accepts: { scheme: "exact", network: METAL_TESTNET, payTo: opts.payTo, price: priceOf() },
        description: "One raw upstream data point",
      },
    };
    const http = new x402HTTPResourceServer(server, routes as never);
    return paymentMiddlewareFromHTTPServer(http, undefined, undefined, false)(req, res, next);
  });
  app.get("/raw", (req, res) => {
    const symbol = String(req.query.symbol ?? "AAPL").toUpperCase();
    res.json({ symbol, price: 100 + (symbol.charCodeAt(0) % 50) + 0.25 });
  });
  return app;
}

function main(): void {
  const payTo = process.env.UPSTREAM_PAY_TO;
  const operatorToken = process.env.OPERATOR_TOKEN;
  if (!payTo || !operatorToken) {
    console.error("UPSTREAM_PAY_TO and OPERATOR_TOKEN are required");
    process.exit(1);
  }
  const port = Number(process.env.PORT ?? 4022);
  createUpstream({ payTo, operatorToken }).listen(port, () => console.log("upstream on :" + port));
}

if (process.argv[1] === fileURLToPath(import.meta.url)) main();
