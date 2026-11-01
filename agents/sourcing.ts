// The sourcing agent's I/O loop: probe the market, rank, buy, check the delivery, and file disputes.
// Every dependency (fetch, CLI, clock) is injected, so the whole loop runs in tests without a network.
import { canonicalRequest, sha256Hex } from "../seller/offer.ts";
import { checkInferOutput, DEFAULT_INFER_ACCEPTANCE } from "../shared/infer.ts";
import type { InferViolation } from "../shared/infer.ts";
import { parseUsdz } from "./cli.ts";
import type { CliStatus, PayOptions } from "./cli.ts";
import { rank } from "./router.ts";
import type { ProviderStatus, Reputation } from "./router.ts";

const TASK = "summary-v1";
/** A step pays at most three times: the first choice plus one retry per remaining provider. */
const MAX_ATTEMPTS = 3;
const ADDRESS = /^0x[0-9a-fA-F]{40}$/;
const ZERO_ADDRESS: `0x${string}` = "0x0000000000000000000000000000000000000000";

/** The slice of fetch the agent uses, so tests can supply a fake. */
export interface HttpResponse {
  ok: boolean;
  status: number;
  json(): Promise<unknown>;
}
export type FetchLike = (url: string, init?: { signal?: AbortSignal }) => Promise<HttpResponse>;
export interface ProbeDeps {
  fetch: FetchLike;
  now: () => number;
}

/** A provider plus the model name its /status route advertised, for the market table. */
export interface ProbedProvider extends ProviderStatus {
  model: string | null;
}

/** The slice of the metal CLI the agent uses. */
export interface PaidDelivery {
  status: CliStatus;
  transaction?: string;
  body?: string;
  refusalCode?: string;
  error?: string;
}
export interface PayCli {
  pay(url: string, credential: string, opts?: PayOptions): Promise<PaidDelivery>;
}

/** One step of the buyer's job: which document to summarise, and how to name it in a complaint. */
export interface SourcingStep {
  index: number;
  label: string;
  text: string;
}

export interface DisputeContext {
  courtUrl: string;
  cred: string;
  payer: `0x${string}`;
  cli: PayCli;
}

export interface SourcingContext extends DisputeContext {
  providers: string[]; // provider base URLs, as configured
  maxPrice: string;
  maxLatencyMs: number;
  probeTimeoutMs: number;
  fetch: FetchLike;
  now: () => number;
}

/** One purchase attempt. A violation means money moved and the delivery was broken. */
export interface Attempt {
  provider: string;
  tx: string | null;
  ok: boolean;
  violation?: InferViolation;
  refused?: string;
  error?: string;
}

/** A paid delivery that failed the signed infer-v1 standard: the evidence for one court claim. */
export interface BadDelivery {
  step: number;
  label: string;
  provider: string;
  seller: `0x${string}`;
  tx: string;
  violation: InferViolation;
}

export interface StepResult {
  step: number;
  provider: string | null;
  tx: string | null;
  ok: boolean;
  body: string | null; // the accepted delivery, null when the step failed
  attempts: Attempt[];
  badDeliveries: BadDelivery[];
}

export interface FiledDispute {
  provider: string;
  seller: `0x${string}`;
  caseId: string;
  feeTx: string | null;
  txs: string[];
}

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

const withoutTrailingSlash = (url: string) => url.replace(/\/$/, "");

/** GET /status for every provider in parallel. A timeout or error gives latencyMs null. */
export async function probe(
  urls: readonly string[],
  timeoutMs: number,
  deps: ProbeDeps = { fetch: globalThis.fetch as FetchLike, now: () => Date.now() },
): Promise<ProbedProvider[]> {
  return Promise.all(urls.map((url) => probeOne(url, timeoutMs, deps)));
}

async function probeOne(url: string, timeoutMs: number, deps: ProbeDeps): Promise<ProbedProvider> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const startedAt = deps.now();
  try {
    const res = await deps.fetch(`${withoutTrailingSlash(url)}/status`, { signal: controller.signal });
    if (!res.ok) return failedStatus(url);
    const value: unknown = await res.json();
    return readStatus(url, value, Math.round(deps.now() - startedAt)) ?? failedStatus(url);
  } catch {
    return failedStatus(url);
  } finally {
    clearTimeout(timer);
  }
}

/** A provider we could not read: it is still listed, so the ranking can say it was slow. */
function failedStatus(url: string): ProbedProvider {
  return { name: url, url, price: "0", payTo: ZERO_ADDRESS, latencyMs: null, model: null };
}

function readStatus(url: string, value: unknown, latencyMs: number): ProbedProvider | null {
  if (!isRecord(value)) return null;
  const { name, price, payTo, model } = value;
  if (typeof name !== "string" || name.trim() === "") return null;
  if (typeof price !== "string" || !isUsdz(price)) return null;
  if (typeof payTo !== "string" || !ADDRESS.test(payTo)) return null;
  return { name, url, price, payTo: payTo as `0x${string}`, latencyMs, model: typeof model === "string" ? model : null };
}

function isUsdz(s: string): boolean {
  try {
    parseUsdz(s);
    return true;
  } catch {
    return false;
  }
}

/** GET /reputation from the court. Any failure means "no record yet", never an exception. */
export async function reputation(
  courtUrl: string,
  fetchFn: FetchLike = globalThis.fetch as FetchLike,
): Promise<Reputation[]> {
  try {
    const res = await fetchFn(`${withoutTrailingSlash(courtUrl)}/reputation`);
    if (!res.ok) return [];
    const value: unknown = await res.json();
    if (!Array.isArray(value)) return [];
    return value.filter(isReputationRow).map((r) => ({ address: r.address, claims: r.claims, upheld: r.upheld }));
  } catch {
    return [];
  }
}

function isReputationRow(v: unknown): v is Reputation {
  if (!isRecord(v)) return false;
  const { address, claims, upheld } = v;
  return typeof address === "string" && ADDRESS.test(address)
    && Number.isInteger(claims) && (claims as number) >= 0
    && Number.isInteger(upheld) && (upheld as number) >= 0;
}

/**
 * Buys one step: probe, rank, pay the best provider, check the delivery against infer-v1.
 * A broken delivery is avoided and the step retries; a refusal excludes that provider without paying.
 */
export async function runStep(step: SourcingStep, ctx: SourcingContext): Promise<StepResult> {
  const statuses = await probe(ctx.providers, ctx.probeTimeoutMs, { fetch: ctx.fetch, now: ctx.now });
  const records = await reputation(ctx.courtUrl, ctx.fetch);
  const requestHash = sha256Hex(canonicalRequest("GET", "/infer", { task: TASK, text: step.text }));

  const avoid: string[] = [];
  const attempts: Attempt[] = [];
  const badDeliveries: BadDelivery[] = [];

  while (attempts.length < MAX_ATTEMPTS) {
    const { chosen } = rank(statuses, records, { maxPrice: ctx.maxPrice, maxLatencyMs: ctx.maxLatencyMs, avoid });
    if (chosen === null) break;

    const paid = await ctx.cli.pay(inferUrl(chosen.url, step.text), ctx.cred);
    if (paid.status === "refused") {
      // The mandate said no: no money moved, so this is not a bad delivery.
      attempts.push({ provider: chosen.name, tx: null, ok: false, refused: paid.refusalCode ?? "refused" });
      avoid.push(chosen.name);
      continue;
    }
    if (paid.status !== "paid" || paid.transaction === undefined) {
      // pending/held/error: the payment did not complete, so stop rather than pretend it did.
      attempts.push({ provider: chosen.name, tx: paid.transaction ?? null, ok: false, error: paid.error ?? paid.status });
      break;
    }

    const tx = paid.transaction;
    const violation = checkInferOutput(paid.body ?? "", requestHash, DEFAULT_INFER_ACCEPTANCE);
    if (violation === null) {
      attempts.push({ provider: chosen.name, tx, ok: true });
      return { step: step.index, provider: chosen.name, tx, ok: true, body: paid.body ?? "", attempts, badDeliveries };
    }
    attempts.push({ provider: chosen.name, tx, ok: false, violation });
    badDeliveries.push({ step: step.index, label: step.label, provider: chosen.name, seller: chosen.payTo, tx, violation });
    avoid.push(chosen.name);
  }

  const last = attempts[attempts.length - 1];
  return {
    step: step.index,
    provider: last?.provider ?? null,
    tx: last?.tx ?? null,
    ok: false,
    body: null,
    attempts,
    badDeliveries,
  };
}

function inferUrl(base: string, text: string): string {
  return `${withoutTrailingSlash(base)}/infer?task=${TASK}&text=${encodeURIComponent(text)}`;
}

/**
 * Files one dispute per provider for the deliveries that provider broke.
 * The complaint is assembled deterministically from the deliveries; no model is involved.
 */
export async function fileDisputes(badDeliveries: readonly BadDelivery[], ctx: DisputeContext): Promise<FiledDispute[]> {
  const groups = new Map<string, BadDelivery[]>();
  for (const d of badDeliveries) {
    const key = d.seller.toLowerCase();
    const group = groups.get(key);
    if (group === undefined) groups.set(key, [d]);
    else group.push(d);
  }

  const filed: FiledDispute[] = [];
  for (const group of groups.values()) {
    const first = group[0];
    const txs = group.map((d) => d.tx);
    const body = { complaint: complaintFor(group), payer: ctx.payer, txs, seller: first.seller };
    const paid = await ctx.cli.pay(`${withoutTrailingSlash(ctx.courtUrl)}/disputes`, ctx.cred, {
      method: "POST",
      body: JSON.stringify(body),
    });
    if (paid.status !== "paid") {
      const why = paid.refusalCode ?? paid.error ?? paid.status;
      throw new Error(`filing against ${first.provider} did not complete (${why})`);
    }
    const caseId = caseIdOf(paid.body);
    if (caseId === null) throw new Error(`filing against ${first.provider}: the court returned no case id`);
    filed.push({ provider: first.provider, seller: first.seller, caseId, feeTx: paid.transaction ?? null, txs });
  }
  return filed;
}

const shortTx = (tx: string) => `${tx.slice(0, 10)}…`;

/** One line per delivery, e.g. "Step 3 (summary of 'Q3 revenue memo') from Sterling, tx 0x1234…: ...". */
export function complaintFor(deliveries: readonly BadDelivery[]): string {
  return deliveries
    .map((d) => `Step ${d.step} (${d.label}) from ${d.provider}, tx ${shortTx(d.tx)}: the delivered output failed the signed ${TASK} standard (${d.violation}).`)
    .join("\n");
}

function caseIdOf(body: string | undefined): string | null {
  if (body === undefined) return null;
  try {
    const value: unknown = JSON.parse(body);
    return isRecord(value) && typeof value.caseId === "string" && value.caseId !== "" ? value.caseId : null;
  } catch {
    return null;
  }
}
