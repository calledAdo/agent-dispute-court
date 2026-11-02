import express from "express";
import type { Express, Request } from "express";
import { fileURLToPath } from "node:url";
import { DEFAULT_PRICE, ReceiptLog, createPaidRoute } from "@dispute-court/seller";
import { defaultUpstream } from "@dispute-court/court";
import type { Acceptance } from "@dispute-court/protocol";
import { makeQuote } from "./quotes.ts";
import type { Faults } from "./quotes.ts";

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

export function createSeller(opts: SellerOptions): Express {
  const price = opts.price ?? DEFAULT_PRICE;
  const acceptance = opts.acceptance ?? DEFAULT_ACCEPTANCE;
  const paid = createPaidRoute({
    payTo: opts.payTo, rpcUrl: opts.rpcUrl, facilitatorUrl: opts.facilitatorUrl,
    path: "/quote", route: "GET /quote", description: "One market quote",
    price, acceptance, log: opts.log, now: opts.now,
  });

  const app = express();
  app.use(paid.middleware);
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
  const log = new ReceiptLog(process.env.RECEIPT_LOG ?? new URL("../../data/receipts.jsonl", import.meta.url).pathname);
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
