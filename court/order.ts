import { readInferAcceptance } from "../shared/infer.ts";
import type { Acceptance } from "../shared/types.ts";

export interface DecodedOrder {
  resource: string;
  requestHash: string;
  acceptance: Acceptance | null;
  amount: string;
  payTo: string;
}

function segment(s: string): unknown {
  return JSON.parse(Buffer.from(s, "base64url").toString("utf8"));
}

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

export function readAcceptance(v: unknown): Acceptance | null {
  if (!isObject(v)) return null;
  if (v.verifier === "infer-v1") return readInferAcceptance(v);
  if (v.verifier !== "quote-v1") return null;
  if (typeof v.maxStalenessMs !== "number" || typeof v.maxDeviationBps !== "number") return null;
  return { verifier: "quote-v1", maxStalenessMs: v.maxStalenessMs, maxDeviationBps: v.maxDeviationBps };
}

/**
 * Reads what the agent signed: the line item id is the request, the checkout JWT payload holds
 * the offer's requestHash, amount, payee and acceptance. Does NOT verify any signature; that is
 * verifyMandatePayment's job. Returns null on any malformed input.
 */
export function decodeSignedOrder(signedOrder: string): DecodedOrder | null {
  try {
    if (typeof signedOrder !== "string") return null;
    const disclosure = segment(signedOrder.split("~")[1] ?? "");
    if (!Array.isArray(disclosure) || !isObject(disclosure[1])) return null;
    const body = disclosure[1];
    const jwt = body.checkout_jwt;
    const items = body.line_items;
    if (typeof jwt !== "string" || !Array.isArray(items) || !isObject(items[0])) return null;
    const resource = items[0].id;
    const offer = segment(jwt.split(".")[1] ?? "");
    if (!isObject(offer) || !isObject(offer.extra)) return null;
    const { requestHash } = offer.extra;
    const { amount, id } = offer;
    if (typeof resource !== "string" || typeof requestHash !== "string") return null;
    if (typeof amount !== "string" && typeof amount !== "number") return null;
    if (typeof id !== "string") return null;
    return { resource, requestHash, acceptance: readAcceptance(offer.extra.acceptance), amount: String(amount), payTo: id };
  } catch {
    return null;
  }
}
