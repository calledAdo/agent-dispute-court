import crypto from "node:crypto";
import type { Acceptance } from "@dispute-court/protocol";

export const METAL_TESTNET = "eip155:63825";

export type Query = Record<string, string | string[]>;

export interface RouteConfig {
  accepts: {
    scheme: "exact";
    network: string;
    payTo: string;
    price: string;
    extra: {
      signedOffer: "required";
      resource: string;
      requestHash: string;
      acceptance: Acceptance;
    };
  };
  description: string;
}

export interface ReceiptRecord {
  tx: string;
  payer: string;
  amount: string;
  resource: string;
  requestHash: string;
  status: number;
  body: string;
  responseHash: string;
  signedOrder: string;
  settledAt: number;
}

export function sha256Hex(s: string): string {
  return crypto.createHash("sha256").update(s).digest("hex");
}

/** The string the agent signs: method, path, query sorted by key (value order kept). */
export function canonicalRequest(method: string, path: string, query: Query): string {
  const pairs: [string, string][] = [];
  for (const [k, v] of Object.entries(query)) {
    for (const value of Array.isArray(v) ? v : [v]) pairs.push([k, value]);
  }
  // Array.prototype.sort is stable, so repeated keys keep their original order.
  pairs.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  const qs = new URLSearchParams(pairs).toString();
  return `${method} ${path}${qs ? "?" + qs : ""}`;
}

/** Defaults keep the quote seller's offer unchanged; other sellers pass their own route and description. */
export function buildOffer(opts: {
  payTo: string;
  price: string;
  resource: string;
  acceptance: Acceptance;
  route?: string;
  description?: string;
}): Record<string, RouteConfig> {
  const route = opts.route ?? "GET /quote";
  return {
    [route]: {
      accepts: {
        scheme: "exact",
        network: METAL_TESTNET,
        payTo: opts.payTo,
        price: opts.price,
        extra: {
          signedOffer: "required",
          resource: opts.resource,
          requestHash: sha256Hex(opts.resource),
          acceptance: opts.acceptance,
        },
      },
      description: opts.description ?? "One market quote",
    },
  };
}

export function buildReceipt(input: Omit<ReceiptRecord, "responseHash">): ReceiptRecord {
  return { ...input, responseHash: sha256Hex(input.body) };
}
