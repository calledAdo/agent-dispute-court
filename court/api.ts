import express from "express";
import type { Express, NextFunction, Request, RequestHandler, Response } from "express";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";
import { x402HTTPResourceServer } from "@x402/core/server";
import type { x402ResourceServer } from "@x402/core/server";
import { paymentMiddlewareFromHTTPServer } from "@x402/express";
import type { CaseInput, CaseResult } from "./case.ts";
import type { CaseStore } from "./store.ts";
import type { ExecuteOutcome, PublishOutcome } from "./remedy.ts";
import { settleFilingFee } from "./verdict.ts";
import type { Policy, Ruling } from "./verdict.ts";

export type CaseStatus = "RUNNING" | "DECIDED" | "AWAITING_HUMAN" | "PUBLISHED" | "CLOSED" | "FILER_MISMATCH" | "FAILED";

export interface Approval {
  claimId: string;
  decision: "REFUND" | "REJECT";
  amount: bigint;
  approver: string;
  at: number;
}

/** What the store holds: the court's CaseResult plus the API's bookkeeping. */
export interface StoredCase extends CaseResult {
  status: CaseStatus;
  payer: string;
  complaint: string;
  txs: string[];
  feeTx: string | null;
  feeRefundTx: string | null;
  feeRefundError: string | null;
  approvals: Approval[];
  publishResults: PublishOutcome[] | null;
  executeResults: ExecuteOutcome[] | null;
  error: string | null;
  createdAt: number;
}

export interface CourtAppDeps {
  /** null = no payment gate (tests); `payer` then comes from the body. */
  x402: { server: x402ResourceServer; routes: unknown; gate?: RequestHandler } | null;
  runCase: (input: CaseInput) => Promise<CaseResult>;
  store: CaseStore;
  remedy: {
    publish: (rulings: Ruling[], payerOf: (tx: string) => `0x${string}`) => Promise<PublishOutcome[]>;
    execute: (txs: string[]) => Promise<ExecuteOutcome[]>;
  };
  feeRefund: (payer: string, amount: bigint, caseId: string) => Promise<{ hash: string }>;
  /** Supplies filingFee (the amount refunded) and the rule behind refundFee. */
  policy: Policy;
  operatorToken: string;
  now: () => number;
}

const ADDRESS = /^0x[0-9a-fA-F]{40}$/;
const TX_HASH = /^0x[0-9a-fA-F]{64}$/;
const MAX_TXS = 50;
const MAX_COMPLAINT = 5000;
const PENDING_TTL_MS = 10 * 60 * 1000;

/** Error text that is safe to store, log or serve: class and short message only, no URLs, no long hex tokens. */
export function sanitizeError(e: unknown): string {
  const raw = e instanceof Error ? `${e.name}: ${(e as { shortMessage?: string }).shortMessage ?? e.message}` : String(e);
  return raw.split("\n")[0].replace(/https?:\/\/\S+/g, "<url>").replace(/[0-9a-fA-F]{32,}/g, "<redacted>").slice(0, 200);
}

const cleanReason = <T extends { reason?: string }>(o: T): T => (o.reason === undefined ? o : { ...o, reason: sanitizeError(o.reason) });

const same = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();
const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

/** Hand-written validation. Returns the input (without an id) or the reason it is invalid. */
export function validateDispute(body: unknown): { ok: true; value: Omit<CaseInput, "id"> } | { ok: false; error: string } {
  if (!isRecord(body)) return { ok: false, error: "body must be a JSON object" };
  const { complaint, payer, txs, buyerOrders } = body;
  if (typeof complaint !== "string" || complaint.trim() === "" || complaint.length > MAX_COMPLAINT) return { ok: false, error: "complaint must be a non-empty string" };
  if (typeof payer !== "string" || !ADDRESS.test(payer)) return { ok: false, error: "payer must be a 0x address" };
  if (!Array.isArray(txs) || txs.length === 0 || txs.length > MAX_TXS) return { ok: false, error: `txs must be a list of 1 to ${MAX_TXS} transaction hashes` };
  if (!txs.every((t) => typeof t === "string" && TX_HASH.test(t))) return { ok: false, error: "every tx must be a 0x 32-byte hash" };
  if (new Set(txs.map((t: string) => t.toLowerCase())).size !== txs.length) return { ok: false, error: "txs must not repeat" };
  let orders: Record<string, string> | undefined;
  if (buyerOrders !== undefined) {
    if (!isRecord(buyerOrders)) return { ok: false, error: "buyerOrders must be an object" };
    for (const [k, v] of Object.entries(buyerOrders)) {
      if (!TX_HASH.test(k) || typeof v !== "string") return { ok: false, error: "buyerOrders must map tx hashes to signed order strings" };
    }
    orders = buyerOrders as Record<string, string>;
  }
  const value: Omit<CaseInput, "id"> = { complaint, payer: payer as `0x${string}`, txs: txs as `0x${string}`[] };
  if (orders !== undefined) value.buyerOrders = orders;
  return { ok: true, value };
}

/** Bigints cross JSON as decimal strings. */
function send(res: Response, status: number, body: unknown): void {
  res.status(status).type("application/json").send(JSON.stringify(body, (_k, v) => (typeof v === "bigint" ? v.toString() : v)));
}

function tokenMatches(given: string | undefined, expected: string): boolean {
  if (expected === "" || given === undefined) return false;
  const h = (s: string) => crypto.createHash("sha256").update(s).digest();
  return crypto.timingSafeEqual(h(given), h(expected));
}

const hasOpenEscalation = (rulings: Ruling[]) => rulings.some((r) => r.verdict === "ESCALATE");

export function createCourtApp(deps: CourtAppDeps): Express {
  const { store, now } = deps;
  const stored = (id: string) => store.get(id) as StoredCase | undefined;
  const save = (c: StoredCase) => store.save(c);

  // Cases accepted by the route handler but not yet settled on chain.
  const pending = new Map<string, { input: CaseInput; at: number }>();
  // Cases with an operator action in flight: stops two requests racing (e.g. a double fee refund).
  const busy = new Set<string>();

  function startCase(input: CaseInput, feeTx: string | null): void {
    save({
      id: input.id, claims: [], findings: [], rulings: [], refundFee: false, summary: "", evidence: {},
      status: "RUNNING", payer: input.payer, complaint: input.complaint, txs: [...input.txs], feeTx, feeRefundTx: null, feeRefundError: null,
      approvals: [], publishResults: null, executeResults: null, error: null, createdAt: now(),
    });
    // Asynchronous on purpose: the caller already has its 202.
    deps.runCase(input).then(
      (result) => {
        const base = stored(input.id)!;
        save({ ...base, ...result, status: hasOpenEscalation(result.rulings) ? "AWAITING_HUMAN" : "DECIDED" });
      },
      (err: unknown) => save({ ...stored(input.id)!, status: "FAILED", error: sanitizeError(err) }),
    );
  }

  function recordSettlement(caseId: string, settledPayer: string | undefined, feeTx: string): void {
    const entry = pending.get(caseId);
    if (entry === undefined) return;
    pending.delete(caseId);
    if (settledPayer !== undefined && same(settledPayer, entry.input.payer)) {
      startCase(entry.input, feeTx);
      return;
    }
    // Someone else paid for this filing: keep the case on record but never run it.
    save({
      id: entry.input.id, claims: [], findings: [], rulings: [], refundFee: false, summary: "", evidence: {},
      status: "FILER_MISMATCH", payer: entry.input.payer, complaint: entry.input.complaint, txs: [...entry.input.txs], feeTx, feeRefundTx: null, feeRefundError: null,
      approvals: [], publishResults: null, executeResults: null,
      error: `settled payer ${settledPayer ?? "unknown"} does not match body payer`, createdAt: now(),
    });
  }

  const app = express();
  app.use(express.json({ limit: "256kb" }));

  // ----- operator console (static) -----
  const consoleDir = fileURLToPath(new URL("../console/", import.meta.url));
  app.get("/", (_req, res) => void res.redirect(302, "/console/"));
  app.use("/console", (_req, res, next) => {
    res.setHeader("Content-Security-Policy", "default-src 'self'; style-src 'self'; script-src 'self'; img-src 'self' data:; connect-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'");
    res.setHeader("X-Content-Type-Options", "nosniff");
    next();
  }, express.static(consoleDir, { index: "index.html" }));

  app.get("/health", (_req, res) => void res.json({ ok: true }));

  // ----- POST /disputes: validate first, so an invalid body is never charged -----
  app.post("/disputes", (req: Request, res: Response, next: NextFunction) => {
    const v = validateDispute(req.body);
    if (!v.ok) {
      res.status(400).json({ error: v.error });
      return;
    }
    res.locals.dispute = v.value;
    next();
  });

  if (deps.x402 !== null) {
    const { server, routes } = deps.x402;
    // `gate` is a test seam; production leaves it unset and gets the real x402 middleware.
    server.onAfterSettle(async ({ result, transportContext }) => {
      if (!result.success) return;
      try {
        const body = JSON.parse(Buffer.from(transportContext?.responseBody ?? []).toString("utf8")) as { caseId?: string };
        if (typeof body.caseId === "string") recordSettlement(body.caseId, result.payer, result.transaction);
      } catch {
        // not a dispute response: nothing to record
      }
    });

    // Initialisation needs the network; retry lazily per request, as the seller does.
    let ready: Promise<void> | null = null;
    const ensureInitialized = (): Promise<void> => {
      ready ??= Promise.resolve(server.initialize()).catch((err) => {
        ready = null;
        throw err;
      });
      return ready;
    };
    ensureInitialized().catch(() => console.error("x402 initialize failed, will retry on first request"));
    const gate = deps.x402.gate ?? paymentMiddlewareFromHTTPServer(new x402HTTPResourceServer(server, routes as never), undefined, undefined, false);

    app.post("/disputes", async (req, res, next) => {
      try {
        await ensureInitialized();
      } catch {
        res.status(503).json({ error: "payment server not ready" });
        return;
      }
      return gate(req, res, next);
    });
  }

  app.post("/disputes", (_req, res) => {
    const input: CaseInput = { ...(res.locals.dispute as Omit<CaseInput, "id">), id: `case-${crypto.randomUUID()}` };
    if (deps.x402 === null) {
      startCase(input, null);
    } else {
      // The case starts in onAfterSettle, once the real payer is known.
      for (const [id, p] of pending) if (now() - p.at > PENDING_TTL_MS) pending.delete(id);
      pending.set(input.id, { input, at: now() });
    }
    send(res, 202, { caseId: input.id });
  });

  // ----- reads -----
  app.get("/cases", (_req, res) => {
    send(res, 200, store.list().map((c) => {
      const s = c as StoredCase;
      const counts = { REFUND: 0, REJECT: 0, ESCALATE: 0 };
      for (const r of s.rulings) counts[r.verdict]++;
      return { id: s.id, status: s.status, counts };
    }));
  });

  app.get("/cases/:id", (req, res) => {
    const c = stored(String(req.params.id));
    if (c === undefined) return void send(res, 404, { error: "case not found" });
    send(res, 200, c);
  });

  // ----- operator routes -----
  const operator = (req: Request, res: Response, next: NextFunction) => {
    if (!tokenMatches(req.header("x-operator-token"), deps.operatorToken)) return void res.status(401).json({ error: "operator token required" });
    next();
  };

  /** Loads the case and takes the per-case lock for the duration of the handler. */
  const exclusive = (handler: (c: StoredCase, req: Request, res: Response) => Promise<void> | void) =>
    async (req: Request, res: Response) => {
      const id = String(req.params.id);
      const c = stored(id);
      if (c === undefined) return void res.status(404).json({ error: "case not found" });
      if (busy.has(id)) return void res.status(409).json({ error: "another action on this case is in progress" });
      busy.add(id);
      try {
        await handler(c, req, res);
      } finally {
        busy.delete(id);
      }
    };

  app.post("/cases/:id/approve", operator, exclusive((c, req, res) => {
    const b: unknown = req.body;
    if (!isRecord(b) || typeof b.claimId !== "string" || (b.decision !== "REFUND" && b.decision !== "REJECT") || typeof b.amount !== "string" || typeof b.approver !== "string" || b.approver.trim() === "") {
      return void res.status(400).json({ error: "body must be { claimId, decision: REFUND|REJECT, amount: decimal string, approver }" });
    }
    if (!/^\d+$/.test(b.amount)) return void res.status(400).json({ error: "amount must be a decimal string of base units" });
    const idx = c.rulings.findIndex((r) => r.claimId === b.claimId);
    if (idx === -1) return void res.status(404).json({ error: "claim not found" });
    const ruling = c.rulings[idx];
    if (ruling.verdict !== "ESCALATE") return void res.status(409).json({ error: "only ESCALATE rulings can be approved" });
    // The approval is bound to the amount the human was shown.
    if (BigInt(b.amount) !== ruling.proposedRefund) return void res.status(409).json({ error: "amount does not match the ruling's proposedRefund", proposedRefund: ruling.proposedRefund.toString() });
    if (b.decision === "REFUND" && ruling.proposedRefund <= 0n) return void res.status(409).json({ error: "nothing to refund for this ruling" });

    const decided: Ruling = b.decision === "REFUND"
      ? { ...ruling, verdict: "REFUND", liable: "SELLER", refund: ruling.proposedRefund, decidedBy: "human" }
      : { ...ruling, verdict: "REJECT", liable: "NONE", refund: 0n, decidedBy: "human" };
    const rulings = c.rulings.map((r, i) => (i === idx ? decided : r));
    const approval: Approval = { claimId: b.claimId, decision: b.decision, amount: ruling.proposedRefund, approver: b.approver, at: now() };
    const updated: StoredCase = {
      ...c, rulings, approvals: [...c.approvals, approval],
      refundFee: settleFilingFee(rulings, deps.policy).refundFee,
      status: c.status === "AWAITING_HUMAN" && !hasOpenEscalation(rulings) ? "DECIDED" : c.status,
    };
    save(updated);
    send(res, 200, updated);
  }));

  app.post("/cases/:id/publish", operator, exclusive(async (c, _req, res) => {
    if (c.status === "PUBLISHED" || c.status === "CLOSED") return void send(res, 200, c); // idempotent
    if (c.status !== "DECIDED") return void res.status(409).json({ error: `cannot publish a case in status ${c.status}` });
    const outcomes = (await deps.remedy.publish(c.rulings, () => c.payer as `0x${string}`)).map(cleanReason);
    // A failed publish leaves the case DECIDED so the operator can retry; the remedy skips rulings already on chain.
    const failed = outcomes.some((o) => o.status === "failed");
    const updated: StoredCase = { ...c, publishResults: outcomes, status: failed ? "DECIDED" : "PUBLISHED" };
    save(updated);
    send(res, 200, updated);
  }));

  app.post("/cases/:id/execute", operator, exclusive(async (c, _req, res) => {
    if (c.status !== "PUBLISHED" && c.status !== "CLOSED") return void res.status(409).json({ error: `cannot execute a case in status ${c.status}` });
    let current = c;
    if (c.status === "PUBLISHED") {
      const refundTxs = c.rulings.filter((r) => r.verdict === "REFUND" && r.refund > 0n).map((r) => r.tx);
      current = { ...c, executeResults: (await deps.remedy.execute([...new Set(refundTxs)])).map(cleanReason) };
      save(current);
    }
    // The fee goes back once, however many times execute is called.
    if (current.refundFee && current.feeRefundTx === null) {
      try {
        const { hash } = await deps.feeRefund(current.payer, deps.policy.filingFee, current.id);
        current = { ...current, feeRefundTx: hash, feeRefundError: null };
      } catch (err) {
        current = { ...current, feeRefundError: sanitizeError(err) };
      }
      save(current);
    }
    const paid = (current.executeResults ?? []).every((o) => o.status === "paid" || o.status === "already_paid" || o.status === "objected");
    const feeDone = !current.refundFee || current.feeRefundTx !== null;
    if (current.status === "PUBLISHED" && paid && feeDone) {
      current = { ...current, status: "CLOSED" };
      save(current);
    }
    send(res, current.feeRefundError !== null ? 502 : 200, current);
  }));

  // Malformed JSON and the like.
  app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
    console.error("request failed:", sanitizeError(err));
    const status = (err as { status?: number }).status;
    if (status !== undefined && status >= 400 && status < 500) return void res.status(status).json({ error: "bad request" });
    res.status(500).json({ error: "internal error" });
  });

  return app;
}
