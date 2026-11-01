// Inference providers: one program, run three times with different env.
//
//   PROVIDER_NAME=Swift    PROVIDER_MODEL=claude-haiku-5-5  PROVIDER_PRICE=0.02 PORT=4061 \
//     PROVIDER_PAY_TO=0x... METAL_RPC_URL=... ANTHROPIC_API_KEY=... OPERATOR_TOKEN=... \
//     RECEIPT_LOG=data/receipts-swift.jsonl node providers/server.ts
//   PROVIDER_NAME=Sterling PROVIDER_MODEL=claude-sonnet-5-5 PROVIDER_PRICE=0.03 PORT=4062 ...
//   PROVIDER_NAME=Summit   PROVIDER_MODEL=claude-opus-5-5   PROVIDER_PRICE=0.06 PORT=4063 ...
//
// Receipts are anchored with the existing scripts/anchor.ts, pointed at each provider's
// RECEIPT_LOG through SELLER_RECEIPTS (and at that provider's key through SELLER_KEY_FILE).
import express from "express";
import type { Express, NextFunction, Request, RequestHandler, Response } from "express";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";
import Anthropic from "@anthropic-ai/sdk";
import { HTTPFacilitatorClient, x402ResourceServer, x402HTTPResourceServer } from "@x402/core/server";
import { paymentMiddlewareFromHTTPServer } from "@x402/express";
import { METAL_NETWORKS, registerMetalScheme } from "@metalntwx/metal-pay";
import { requireSignedOffer, signedOfferOf } from "@metalntwx/metal-pay/mandates";
import { isValidPrice } from "../agents/upstream.ts";
import { DEFAULT_INFER_ACCEPTANCE } from "../shared/infer.ts";
import type { InferOutput } from "../shared/infer.ts";
import type { InferAcceptance } from "../shared/types.ts";
import { buildOffer, buildReceipt, canonicalRequest, sha256Hex } from "../seller/offer.ts";
import type { Query } from "../seller/offer.ts";
import { ReceiptLog } from "../seller/receipts.ts";

export const DEFAULT_PROVIDER_PRICE = "0.02";
export const MAX_TEXT_CHARS = 1500;
export const MAX_STATUS_DELAY_MS = 30000;
export const PROVIDER_FAULTS = ["none", "empty", "truncated", "wrong_request"] as const;
export type ProviderFault = (typeof PROVIDER_FAULTS)[number];

/** Subset of the Anthropic SDK client; injected so tests never touch the network. */
export interface ModelClient {
  messages: { create(args: unknown): Promise<unknown> };
}

const SUMMARY_SCHEMA = {
  type: "object",
  properties: {
    summary: { type: "string" },
    keywords: { type: "array", items: { type: "string" } },
  },
  required: ["summary", "keywords"],
  additionalProperties: false,
};

export interface ProviderOptions {
  name: string;
  model: string;
  payTo: string;
  rpcUrl: string;
  operatorToken: string;
  anthropic: ModelClient;
  log: ReceiptLog;
  now: () => number;
  price?: string;
  statusDelayMs?: number;
  facilitatorUrl?: string;
  /** Test seam: replaces the x402 gate. Production leaves it unset and gets the real middleware. */
  gate?: RequestHandler;
}

export interface AdminUpdate {
  price?: string;
  statusDelayMs?: number;
  fault?: ProviderFault;
  faultCount?: number;
}

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

const isStatusDelay = (v: unknown): v is number =>
  typeof v === "number" && Number.isInteger(v) && v >= 0 && v <= MAX_STATUS_DELAY_MS;

const isFaultCount = (v: unknown): v is number => typeof v === "number" && Number.isInteger(v) && v >= 1;

const isFault = (v: unknown): v is ProviderFault =>
  typeof v === "string" && (PROVIDER_FAULTS as readonly string[]).includes(v);

/** Hand-written validation. Returns the update or the reason it is invalid. */
export function validateAdminUpdate(body: unknown): { ok: true; value: AdminUpdate } | { ok: false; error: string } {
  if (!isRecord(body)) return { ok: false, error: "body must be a JSON object" };
  const value: AdminUpdate = {};
  if (body.price !== undefined) {
    if (!isValidPrice(body.price)) return { ok: false, error: "price must be a decimal with two places" };
    value.price = body.price;
  }
  if (body.statusDelayMs !== undefined) {
    if (!isStatusDelay(body.statusDelayMs)) {
      return { ok: false, error: `statusDelayMs must be an integer from 0 to ${MAX_STATUS_DELAY_MS}` };
    }
    value.statusDelayMs = body.statusDelayMs;
  }
  if (body.fault !== undefined) {
    if (!isFault(body.fault)) return { ok: false, error: `fault must be one of ${PROVIDER_FAULTS.join(", ")}` };
    value.fault = body.fault;
  }
  if (body.faultCount !== undefined) {
    if (!isFaultCount(body.faultCount)) return { ok: false, error: "faultCount must be an integer of at least 1" };
    value.faultCount = body.faultCount;
  }
  return { ok: true, value };
}

/** Same redaction style as court/api.ts sanitizeError: class and short message, no URLs, no long hex tokens. */
export function sanitizeError(e: unknown): string {
  const raw = e instanceof Error ? `${e.name}: ${(e as { shortMessage?: string }).shortMessage ?? e.message}` : String(e);
  return raw.split("\n")[0].replace(/https?:\/\/\S+/g, "<url>").replace(/[0-9a-fA-F]{32,}/g, "<redacted>").slice(0, 200);
}

function tokenMatches(given: string | undefined, expected: string): boolean {
  if (expected === "" || given === undefined) return false;
  const h = (s: string) => crypto.createHash("sha256").update(s).digest();
  return crypto.timingSafeEqual(h(given), h(expected));
}

/**
 * Parse the JSON object from the text blocks of a Messages API response.
 * Thinking blocks are skipped. Returns the object, or a short reason it is unusable.
 * Copied from court/judge.ts so providers do not depend on the court.
 */
function jsonOutput(response: unknown): { ok: true; value: Record<string, unknown> } | { ok: false; reason: string } {
  if (typeof response !== "object" || response === null) return { ok: false, reason: "no_response" };
  const r = response as { content?: unknown; stop_reason?: unknown };
  if (r.stop_reason === "max_tokens") return { ok: false, reason: "truncated_max_tokens" };
  if (!Array.isArray(r.content)) return { ok: false, reason: "no_content" };
  const text = r.content
    .filter((b) => typeof b === "object" && b !== null && (b as { type?: unknown }).type === "text")
    .map((b) => (b as { text?: unknown }).text)
    .filter((t): t is string => typeof t === "string")
    .join("");
  if (text === "") return { ok: false, reason: "no_text_block" };
  try {
    const parsed: unknown = JSON.parse(text);
    if (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)) {
      return { ok: true, value: parsed as Record<string, unknown> };
    }
    return { ok: false, reason: "not_a_json_object" };
  } catch {
    return { ok: false, reason: "unparseable_json" };
  }
}

/** Builds the infer-v1 body and clamps it, so an honest provider always conforms. */
export function buildInferOutput(
  value: Record<string, unknown>,
  resource: string,
  acceptance: InferAcceptance,
): InferOutput | null {
  const { summary, keywords } = value;
  if (typeof summary !== "string" || summary.trim() === "") return null;
  if (!Array.isArray(keywords)) return null;
  const clean = keywords
    .filter((k): k is string => typeof k === "string" && k.trim() !== "")
    .slice(0, acceptance.maxKeywords);
  if (clean.length === 0) return null;
  return {
    task: "summary-v1",
    requestHash: sha256Hex(resource),
    summary: summary.slice(0, acceptance.maxChars),
    keywords: clean,
  };
}

/** Rejects a missing or oversized text before the payment gate, so an invalid request is never charged. */
function validateInferText(req: Request, res: Response, next: NextFunction): void {
  const text = req.query.text;
  if (typeof text !== "string" || text.trim() === "" || text.length > MAX_TEXT_CHARS) {
    res.status(400).json({ error: `text must be a non-empty string of at most ${MAX_TEXT_CHARS} characters` });
    return;
  }
  res.locals.text = text;
  next();
}

export function createProvider(opts: ProviderOptions): Express {
  let price = opts.price ?? DEFAULT_PROVIDER_PRICE;
  let statusDelayMs = opts.statusDelayMs ?? 0;
  let fault: ProviderFault = "none";
  let faultCount = 0;

  const facilitator = new HTTPFacilitatorClient({
    url: opts.facilitatorUrl ?? METAL_NETWORKS.testnet.facilitatorUrl,
  });
  const server = requireSignedOffer(
    registerMetalScheme(new x402ResourceServer(facilitator), { networks: ["testnet"] }),
    { rpcUrl: opts.rpcUrl },
  );

  server.onAfterSettle(async ({ paymentPayload, requirements, result, transportContext }) => {
    const settlement = result.extra?.settlement;
    if (!result.success || !settlement?.first) return;
    const body = Buffer.from(transportContext?.responseBody ?? []).toString("utf8");
    const receipt = buildReceipt({
      tx: result.transaction,
      payer: result.payer ?? "",
      amount: price,
      resource: requirements.extra?.resource as string,
      requestHash: requirements.extra?.requestHash as string,
      status: transportContext?.responseStatus ?? 200,
      body,
      signedOrder: signedOfferOf(paymentPayload) as string,
      settledAt: opts.now(),
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
  // Tests inject a gate, so skip the network entirely.
  if (opts.gate === undefined) {
    ensureInitialized().catch((err) =>
      console.error("x402 initialize failed, will retry on first request:", sanitizeError(err)),
    );
  }

  /** Applies the armed fault to a 200 body, then counts it down. Only paid responses reach here. */
  const nextBody = (output: InferOutput): string => {
    let value = output;
    let kind: ProviderFault = "none";
    if (fault !== "none" && faultCount > 0) {
      kind = fault;
      if (kind === "empty") value = { ...value, summary: "" };
      else if (kind === "wrong_request") value = { ...value, requestHash: sha256Hex("wrong-request") };
      faultCount -= 1;
      if (faultCount === 0) fault = "none";
    }
    const text = JSON.stringify(value);
    return kind === "truncated" ? text.slice(0, Math.floor(text.length / 2)) : text;
  };

  const app = express();
  app.use(express.json());

  app.get("/status", async (_req: Request, res: Response) => {
    if (statusDelayMs > 0) await new Promise<void>((resolve) => setTimeout(resolve, statusDelayMs));
    res.json({
      name: opts.name,
      model: opts.model,
      price,
      payTo: opts.payTo,
      acceptance: DEFAULT_INFER_ACCEPTANCE,
    });
  });

  app.post("/admin", (req: Request, res: Response) => {
    if (!tokenMatches(req.header("x-operator-token"), opts.operatorToken)) {
      res.status(401).json({ error: "bad operator token" });
      return;
    }
    const v = validateAdminUpdate(req.body ?? {});
    if (!v.ok) {
      res.status(400).json({ error: v.error });
      return;
    }
    const update = v.value;
    // A count without a fault would silently arm a later fault; refuse it.
    if (update.faultCount !== undefined && update.fault === undefined && fault === "none") {
      res.status(400).json({ error: "faultCount requires a fault" });
      return;
    }
    if (update.price !== undefined) price = update.price;
    if (update.statusDelayMs !== undefined) statusDelayMs = update.statusDelayMs;
    if (update.fault !== undefined) {
      fault = update.fault;
      faultCount = update.fault === "none" ? 0 : (update.faultCount ?? 1);
    } else if (update.faultCount !== undefined) {
      faultCount = update.faultCount;
    }
    res.json({ name: opts.name, model: opts.model, price, payTo: opts.payTo, statusDelayMs, fault, faultCount });
  });

  // Validation runs before the payment gate, so a bad request never reaches settlement.
  app.get("/infer", validateInferText);

  if (opts.gate !== undefined) {
    const gate = opts.gate;
    app.use((req: Request, res: Response, next: NextFunction) =>
      req.path === "/infer" ? gate(req, res, next) : next(),
    );
  } else {
    app.use(async (req: Request, res: Response, next: NextFunction) => {
      if (req.path !== "/infer") return next();
      try {
        await ensureInitialized();
      } catch {
        res.status(503).json({ error: "payment server not ready" });
        return;
      }
      const resource = canonicalRequest(req.method, req.path, req.query as Query);
      const routes = buildOffer({
        payTo: opts.payTo,
        price,
        resource,
        acceptance: DEFAULT_INFER_ACCEPTANCE,
        route: "GET /infer",
        description: "One inference step",
      });
      // One HTTP server per request so the 402 offer (and therefore the signed order) names this request.
      const http = new x402HTTPResourceServer(server, routes as never);
      return paymentMiddlewareFromHTTPServer(http, undefined, undefined, false)(req, res, next);
    });
  }

  app.get("/infer", async (req: Request, res: Response) => {
    const text = res.locals.text as string;
    const resource = canonicalRequest(req.method, req.path, req.query as Query);

    let response: unknown;
    try {
      response = await opts.anthropic.messages.create({
        model: opts.model,
        max_tokens: 2000,
        output_config: { format: { type: "json_schema", schema: SUMMARY_SCHEMA } },
        messages: [{ role: "user", content: text }],
      });
    } catch (err) {
      // x402 does not settle on 5xx, so the buyer is not charged for a failed model call.
      res.status(502).json({ error: sanitizeError(err) });
      return;
    }

    const out = jsonOutput(response);
    if (!out.ok) {
      res.status(502).json({ error: `model_output_invalid: ${out.reason}` });
      return;
    }
    const output = buildInferOutput(out.value, resource, DEFAULT_INFER_ACCEPTANCE);
    if (output === null) {
      res.status(502).json({ error: "model_output_invalid: bad_summary_or_keywords" });
      return;
    }
    res.status(200).type("application/json").send(nextBody(output));
  });

  return app;
}

function main(): void {
  const name = process.env.PROVIDER_NAME;
  const model = process.env.PROVIDER_MODEL;
  const payTo = process.env.PROVIDER_PAY_TO;
  const rpcUrl = process.env.METAL_RPC_URL;
  const apiKey = process.env.ANTHROPIC_API_KEY;
  const operatorToken = process.env.OPERATOR_TOKEN;
  if (!name || !model || !payTo || !rpcUrl || !apiKey || !operatorToken) {
    console.error("PROVIDER_NAME, PROVIDER_MODEL, PROVIDER_PAY_TO, METAL_RPC_URL, ANTHROPIC_API_KEY and OPERATOR_TOKEN are required");
    process.exit(1);
  }
  const price = process.env.PROVIDER_PRICE ?? DEFAULT_PROVIDER_PRICE;
  if (!isValidPrice(price)) {
    console.error("PROVIDER_PRICE must be a decimal with two places");
    process.exit(1);
  }
  const port = Number(process.env.PORT ?? 4061);
  const log = new ReceiptLog(
    process.env.RECEIPT_LOG ?? new URL(`../data/receipts-${name.toLowerCase()}.jsonl`, import.meta.url).pathname,
  );
  const app = createProvider({
    name,
    model,
    price,
    payTo,
    rpcUrl,
    operatorToken,
    anthropic: new Anthropic({ apiKey }) as never,
    log,
    now: () => Date.now(),
  });
  app.listen(port, () => console.log(`${name} provider on :${port}`, "payTo", payTo));
}

if (process.argv[1] === fileURLToPath(import.meta.url)) main();
