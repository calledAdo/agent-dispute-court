import express from "express";
import type { Express, Request } from "express";
import { fileURLToPath } from "node:url";
import { HTTPFacilitatorClient, x402ResourceServer, x402HTTPResourceServer } from "@x402/core/server";
import { paymentMiddlewareFromHTTPServer } from "@x402/express";
import { METAL_NETWORKS, registerMetalScheme } from "@metalntwx/metal-pay";
import { requireSignedOffer, signedOfferOf } from "@metalntwx/metal-pay/mandates";
import type { Acceptance } from "../shared/types.ts";
import { buildOffer, buildReceipt, canonicalRequest } from "./offer.ts";
import { makeQuote } from "./quotes.ts";
import type { Faults } from "./quotes.ts";
import { ReceiptLog } from "./receipts.ts";

export const DEFAULT_PRICE = "0.05";
export const DEFAULT_ACCEPTANCE: Acceptance = { verifier: "quote-v1", maxStalenessMs: 60000, maxDeviationBps: 50 };

export interface SellerOptions {
  payTo: string;
  rpcUrl: string;
  facilitatorUrl?: string;
  price?: string;
  acceptance?: Acceptance;
  upstream: (symbol: string) => number;
  log: ReceiptLog;
  now: () => number;
  faults?: Faults;
}

/** Parses `stale:TSLA,wrong:MSFT` into Faults. Throws on an unknown kind or an empty symbol. */
export function parseFaults(text: string | undefined): Faults {
  const faults: Faults = {};
  for (const part of (text ?? "").split(",").map((p) => p.trim()).filter((p) => p !== "")) {
    const [kind, symbol, ...rest] = part.split(":").map((p) => p.trim());
    if (rest.length > 0 || !symbol) throw new Error(`bad SELLER_FAULTS entry: ${part}`);
    const sym = symbol.toUpperCase();
    if (kind === "stale") (faults.staleSymbols ??= []).push(sym);
    else if (kind === "wrong") (faults.wrongSymbols ??= []).push(sym);
    else throw new Error(`bad SELLER_FAULTS kind: ${kind}`);
  }
  return faults;
}

export function defaultUpstream(symbol: string): number {
  return 100 + (symbol.charCodeAt(0) % 50) + 0.25;
}

export function createSeller(opts: SellerOptions): Express {
  const price = opts.price ?? DEFAULT_PRICE;
  const acceptance = opts.acceptance ?? DEFAULT_ACCEPTANCE;
  const facilitatorUrl = opts.facilitatorUrl ?? METAL_NETWORKS.testnet.facilitatorUrl;

  const facilitator = new HTTPFacilitatorClient({ url: facilitatorUrl });
  const server = requireSignedOffer(registerMetalScheme(new x402ResourceServer(facilitator), { networks: ["testnet"] }), { rpcUrl: opts.rpcUrl });

  server.onAfterSettle(async ({ paymentPayload, requirements, result, transportContext }) => {
    const settlement = result.extra?.settlement;
    if (!result.success || !settlement?.first) return;
    const body = Buffer.from(transportContext?.responseBody ?? []).toString("utf8");
    const receipt = buildReceipt({
      tx: result.transaction, payer: result.payer ?? "", amount: price,
      resource: requirements.extra?.resource as string, requestHash: requirements.extra?.requestHash as string,
      status: transportContext?.responseStatus ?? 200, body,
      signedOrder: signedOfferOf(paymentPayload) as string, settledAt: opts.now(),
    });
    opts.log.append(receipt);
    console.log("settled", receipt.tx, receipt.resource);
  });

  // Initialisation needs the network. Try once at startup; on failure, retry lazily per request.
  let ready: Promise<void> | null = null;
  const ensureInitialized = (): Promise<void> => {
    ready ??= Promise.resolve(server.initialize()).catch((err) => {
      ready = null;
      throw err;
    });
    return ready;
  };
  ensureInitialized().catch((err) => console.error("x402 initialize failed, will retry on first request:", err instanceof Error ? err.message : err));

  const app = express();
  app.use(async (req, res, next) => {
    if (req.path !== "/quote") return next();
    try {
      await ensureInitialized();
    } catch (err) {
      res.status(503).json({ error: "payment server not ready" });
      return;
    }
    const resource = canonicalRequest(req.method, req.path, req.query as Record<string, string | string[]>);
    const routes = buildOffer({ payTo: opts.payTo, price, resource, acceptance });
    // One HTTP server per request so the 402 offer (and therefore the signed order) names this request.
    const http = new x402HTTPResourceServer(server, routes as never);
    return paymentMiddlewareFromHTTPServer(http, undefined, undefined, false)(req, res, next);
  });
  app.get("/quote", (req: Request, res) => {
    const symbol = String(req.query.symbol ?? "AAPL").toUpperCase();
    res.json(makeQuote(symbol, opts.now(), opts.upstream, opts.faults));
  });
  return app;
}

function main(): void {
  const payTo = process.env.SELLER_PAY_TO;
  const rpcUrl = process.env.METAL_RPC_URL;
  if (!payTo || !rpcUrl) {
    console.error("SELLER_PAY_TO and METAL_RPC_URL are required");
    process.exit(1);
  }
  const port = Number(process.env.PORT ?? 4021);
  const log = new ReceiptLog(process.env.RECEIPT_LOG ?? new URL("../data/receipts.jsonl", import.meta.url).pathname);
  let faults: Faults;
  try {
    faults = parseFaults(process.env.SELLER_FAULTS);
  } catch (err) {
    console.error(err instanceof Error ? err.message : err);
    process.exit(1);
  }
  const app = createSeller({ payTo, rpcUrl, upstream: defaultUpstream, log, now: () => Date.now(), faults });
  app.listen(port, () => console.log("seller on :" + port, "payTo", payTo));
}

if (process.argv[1] === fileURLToPath(import.meta.url)) main();
