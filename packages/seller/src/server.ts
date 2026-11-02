import type { NextFunction, Request, RequestHandler, Response } from "express";
import { HTTPFacilitatorClient, x402ResourceServer, x402HTTPResourceServer } from "@x402/core/server";
import { paymentMiddlewareFromHTTPServer } from "@x402/express";
import { METAL_NETWORKS, registerMetalScheme } from "@metalntwx/metal-pay";
import { requireSignedOffer, signedOfferOf } from "@metalntwx/metal-pay/mandates";
import type { Acceptance } from "@dispute-court/protocol";
import { buildOffer, buildReceipt, canonicalRequest } from "./offer.ts";
import type { Query } from "./offer.ts";
import type { ReceiptLog } from "./receipts.ts";

export const DEFAULT_PRICE = "0.05";

export interface PaidRouteOptions {
  payTo: string;
  rpcUrl: string;
  facilitatorUrl?: string;
  /** The one path this route gates, e.g. "/quote". */
  path: string;
  /** The route key in the offer, e.g. "GET /quote". */
  route: string;
  description: string;
  /** A string, or a getter for sellers that change price at runtime. */
  price: string | (() => string);
  acceptance: Acceptance;
  log: ReceiptLog;
  now: () => number;
  /** Test seam: replaces the x402 gate. */
  gate?: RequestHandler;
  /** Optional redaction for the startup initialisation warning. */
  onInitError?: (err: unknown) => void;
}

export interface PaidRoute {
  /** Mount before the route handler. Ignores every path except opts.path. */
  middleware: RequestHandler;
  ensureInitialized: () => Promise<void>;
}

/**
 * The x402 plumbing every per-request seller shares: signed-offer enforcement, Metal scheme
 * registration, one resource server per request, and a receipt for every settled payment.
 */
export function createPaidRoute(opts: PaidRouteOptions): PaidRoute {
  const priceOf = typeof opts.price === "function" ? opts.price : () => opts.price as string;

  const facilitator = new HTTPFacilitatorClient({ url: opts.facilitatorUrl ?? METAL_NETWORKS.testnet.facilitatorUrl });
  const server = requireSignedOffer(registerMetalScheme(new x402ResourceServer(facilitator), { networks: ["testnet"] }), { rpcUrl: opts.rpcUrl });

  server.onAfterSettle(async ({ paymentPayload, requirements, result, transportContext }) => {
    const settlement = result.extra?.settlement;
    if (!result.success || !settlement?.first) return;
    const body = Buffer.from(transportContext?.responseBody ?? []).toString("utf8");
    const receipt = buildReceipt({
      tx: result.transaction, payer: result.payer ?? "", amount: priceOf(),
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

  const middleware: RequestHandler = opts.gate !== undefined
    ? (req: Request, res: Response, next: NextFunction) => (req.path === opts.path ? opts.gate!(req, res, next) : next())
    : async (req: Request, res: Response, next: NextFunction) => {
        if (req.path !== opts.path) return next();
        try {
          await ensureInitialized();
        } catch {
          res.status(503).json({ error: "payment server not ready" });
          return;
        }
        const resource = canonicalRequest(req.method, req.path, req.query as Query);
        const routes = buildOffer({
          payTo: opts.payTo, price: priceOf(), resource, acceptance: opts.acceptance,
          route: opts.route, description: opts.description,
        });
        // One HTTP server per request so the 402 offer (and therefore the signed order) names this request.
        const http = new x402HTTPResourceServer(server, routes as never);
        return paymentMiddlewareFromHTTPServer(http, undefined, undefined, false)(req, res, next);
      };

  // Tests inject a gate, so skip the network entirely.
  if (opts.gate === undefined) {
    const report = opts.onInitError ?? ((err: unknown) =>
      console.error("x402 initialize failed, will retry on first request:", err instanceof Error ? err.message : err));
    ensureInitialized().catch(report);
  }

  return { middleware, ensureInitialized };
}

