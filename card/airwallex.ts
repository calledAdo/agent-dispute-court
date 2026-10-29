// Airwallex sandbox client (card rail). fetch is injected for tests.
//
// Sources for request shapes:
//  [CHALLENGE] https://www.airwallex.com/docs/api/payments/payment_disputes/challenge.md
//  [ACCEPT]    https://www.airwallex.com/docs/api/payments/payment_disputes/accept.md
//  [SIM]       https://www.airwallex.com/docs/api/simulation/payments  (escalate, resolve)
//  [FILES]     https://www.airwallex.com/docs/api/supporting_services/file_service
//  [T5]        tasks/T5-card-rail.md (calls verified live on our sandbox, Oct 29)

export type FetchFn = typeof fetch;

export type AirwallexOptions = {
  clientId: string;
  apiKey: string;
  baseUrl?: string;
  filesUrl?: string;
  fetch?: FetchFn;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  maxRetries?: number;
};

/** Strips URLs and 32+ hex tokens, like court/api.ts sanitizeError. */
export function redact(s: string): string {
  return s.replace(/https?:\/\/\S+/g, "[url]").replace(/(?:0x)?[0-9a-fA-F]{32,}/g, "[hex]");
}

/** ": <code>: <message>" from an Airwallex error body, redacted; empty when the body has neither. */
function detailOf(body: unknown): string {
  const b = body as { code?: unknown; message?: unknown } | null;
  const code = typeof b?.code === "string" ? b.code : "";
  const message = typeof b?.message === "string" ? b.message : "";
  if (!code && !message) return "";
  return redact(`: ${[code, message].filter(Boolean).join(": ")}`);
}

export class AirwallexError extends Error {
  status: number;
  body: unknown;
  constructor(status: number, body: unknown, where: string) {
    super(`Airwallex ${where} failed with ${status}${detailOf(body)}`);
    this.name = "AirwallexError";
    this.status = status;
    this.body = body;
  }
}

// [CHALLENGE] reason enum
export type ChallengeReason =
  | "CUSTOMER_WITHDRAWN" | "CUSTOMER_REFUNDED" | "PRODUCT_RECEIVED" | "PURCHASE_HISTORY"
  | "NOT_ENTITLED" | "SEPARATE_PRODUCT" | "AUTHENTIC_PRODUCT" | "OTHER_REASONS";
// [CHALLENGE] product_type enum (required by the docs at CHARGEBACK stage)
export type ProductType =
  | "PHYSICAL_GOODS" | "DIGITAL_PRODUCT_OR_SERVICE" | "OFFLINE_SERVICE" | "TRAVEL"
  | "RESERVE_OR_BOOKING" | "OTHERS";
// [ACCEPT] reason enum
export type AcceptReason =
  | "AGREEMENT_REACHED_WITH_CUSTOMER" | "CUSTOMER_RELATIONSHIP_MAINTENANCE" | "LOW_VALUE_TRANSACTION"
  | "VALID_CUSTOMER_DISPUTE" | "COLLABORATION_ACCEPTED_MANUAL" | "OTHERS";

export type ChallengeInput = {
  reason?: ChallengeReason;
  productType?: ProductType;
  description?: string;
  fileIds?: string[];
  challengedBy?: string;
  requestId?: string;
};
export type AcceptInput = { reason?: AcceptReason; description?: string; acceptedBy?: string; requestId?: string };

const DEFAULT_BASE = "https://api.sandbox.airwallex.com/api/v1";
const DEFAULT_FILES = "https://files.sandbox.airwallex.com";
const TOKEN_TTL_MS = 30 * 60_000; // [T5] 30-minute bearer token
const REFRESH_MARGIN_MS = 60_000;

export class AirwallexClient {
  private clientId: string;
  private apiKey: string;
  protected baseUrl: string;
  private filesUrl: string;
  private f: FetchFn;
  private now: () => number;
  private sleep: (ms: number) => Promise<void>;
  private maxRetries: number;
  private token: string | undefined;
  private tokenExpiresAt = 0;

  constructor(o: AirwallexOptions) {
    this.clientId = o.clientId;
    this.apiKey = o.apiKey;
    this.baseUrl = (o.baseUrl ?? DEFAULT_BASE).replace(/\/$/, "");
    this.filesUrl = (o.filesUrl ?? DEFAULT_FILES).replace(/\/$/, "");
    this.f = o.fetch ?? fetch;
    this.now = o.now ?? Date.now;
    this.sleep = o.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
    this.maxRetries = o.maxRetries ?? 3;
  }

  // [T5] POST /authentication/login, x-client-id / x-api-key headers, no body.
  // The response field `token` is UNVERIFIED (not in the docs we could fetch).
  async login(): Promise<string> {
    const res = await this.f(`${this.baseUrl}/authentication/login`, {
      method: "POST",
      headers: { "x-client-id": this.clientId, "x-api-key": this.apiKey },
    });
    const body = await readJson(res);
    if (!res.ok) throw new AirwallexError(res.status, body, "login");
    const token = (body as { token?: string }).token; // UNVERIFIED field name
    if (!token) throw new AirwallexError(res.status, body, "login (no token)");
    this.token = token;
    this.tokenExpiresAt = this.now() + TOKEN_TTL_MS - REFRESH_MARGIN_MS;
    return token;
  }

  private async bearer(): Promise<string> {
    if (this.token && this.now() < this.tokenExpiresAt) return this.token;
    return this.login();
  }

  // Sends a JSON request with bearer auth; retries on 429 with backoff ([T5] 10 req/s).
  protected async call(method: string, url: string, body?: unknown): Promise<any> {
    for (let attempt = 0; ; attempt++) {
      const res = await this.f(url, {
        method,
        headers: {
          Authorization: `Bearer ${await this.bearer()}`,
          ...(body === undefined ? {} : { "Content-Type": "application/json" }),
        },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
      if (res.status === 429 && attempt < this.maxRetries) {
        await this.sleep(250 * 2 ** attempt);
        continue;
      }
      const parsed = await readJson(res);
      if (!res.ok) throw new AirwallexError(res.status, parsed, `${method} ${url}`);
      return parsed;
    }
  }

  // The request_id is generated once per call and reused across 429 retries
  // because the body is built once.
  protected post(path: string, body: Record<string, unknown>, requestId?: string): Promise<any> {
    return this.call("POST", `${this.baseUrl}${path}`, { request_id: requestId ?? crypto.randomUUID(), ...body });
  }

  // [T5] amounts in major units.
  createPaymentIntent(a: { amount: number; currency: string; merchantOrderId: string; requestId?: string }) {
    return this.post(
      "/pa/payment_intents/create",
      { amount: a.amount, currency: a.currency, merchant_order_id: a.merchantOrderId },
      a.requestId,
    );
  }

  // [T5] sandbox test card 4035501000000008.
  confirmWithTestCard(intentId: string, name = "Test Buyer", requestId?: string) {
    return this.post(
      `/pa/payment_intents/${enc(intentId)}/confirm`,
      {
        payment_method: {
          type: "card",
          card: { number: "4035501000000008", expiry_month: "12", expiry_year: "2030", cvc: "123", name },
        },
      },
      requestId,
    );
  }

  listDisputes(): Promise<any> {
    return this.call("GET", `${this.baseUrl}/pa/payment_disputes`);
  }

  getDispute(id: string): Promise<any> {
    return this.call("GET", `${this.baseUrl}/pa/payment_disputes/${enc(id)}`); // UNVERIFIED: GET-by-id path assumed from REST convention
  }

  // [FILES] multipart POST on the files host; field `file` (name <= 50 chars). Response has `file_id`.
  // Bearer auth. [T5] JPG or PDF only.
  async uploadEvidencePdf(bytes: Uint8Array, name: string): Promise<{ file_id: string; [k: string]: unknown }> {
    const filename = name.slice(0, 50);
    for (let attempt = 0; ; attempt++) {
      const form = new FormData();
      form.append("file", new Blob([bytes as BlobPart], { type: "application/pdf" }), filename);
      const res = await this.f(`${this.filesUrl}/api/v1/files/upload`, {
        method: "POST",
        headers: { Authorization: `Bearer ${await this.bearer()}` },
        body: form,
      });
      if (res.status === 429 && attempt < this.maxRetries) {
        await this.sleep(250 * 2 ** attempt);
        continue;
      }
      const parsed = await readJson(res);
      if (!res.ok) throw new AirwallexError(res.status, parsed, "upload");
      return parsed;
    }
  }

  // [ACCEPT] body: request_id (required), reason?, description?, accepted_by?, refund? (omitted: refunds the full remaining amount at RFI).
  acceptDispute(id: string, i: AcceptInput = {}) {
    return this.post(
      `/pa/payment_disputes/${enc(id)}/accept`,
      defined({ reason: i.reason, description: i.description, accepted_by: i.acceptedBy }),
      i.requestId,
    );
  }

  // [CHALLENGE] body: request_id (required), reason?, product_type?, description? (deprecated in docs, so
  // the text goes in supporting_documents.documents[].description), challenged_by?,
  // supporting_documents.documents[{type:"PRIMARY", description, file_ids}].
  challengeDispute(id: string, i: ChallengeInput = {}) {
    const documents =
      i.fileIds && i.fileIds.length > 0
        ? { documents: [{ type: "PRIMARY", description: i.description, file_ids: i.fileIds }] }
        : undefined;
    return this.post(
      `/pa/payment_disputes/${enc(id)}/challenge`,
      defined({
        reason: i.reason,
        product_type: i.productType,
        challenged_by: i.challengedBy,
        supporting_documents: documents,
        description: documents ? undefined : i.description,
      }),
      i.requestId,
    );
  }

  // ===================== SANDBOX-ONLY SIMULATION CALLS =====================
  // None of these exist in production.

  // [T5] verified live. stage "RFI" so we can challenge it; never PRE_CHARGEBACK.
  simulateDispute(a: { paymentIntentId: string; reasonCode: string; dueAt: string; stage?: string; requestId?: string }) {
    return this.call("POST", `${this.baseUrl}/simulation/pa/payment_disputes/create`, {
      payment_intent_id: a.paymentIntentId,
      reason_code: a.reasonCode,
      stage: a.stage ?? "RFI",
      due_at: a.dueAt,
    });
  }

  // [SIM] body: due_at (required), amount?, comment?, documents? (file ids). 200 returns the dispute.
  // RFI -> CHARGEBACK; fails if already at CHARGEBACK ([T5]).
  escalate(id: string, a: { dueAt: string; comment?: string; amount?: number; documents?: string[] }) {
    return this.call("POST", `${this.baseUrl}/simulation/pa/payment_disputes/${enc(id)}/escalate`, defined({
      due_at: a.dueAt,
      amount: a.amount,
      comment: a.comment,
      documents: a.documents,
    }));
  }

  // [SIM] body: in_favor_of (required, CUSTOMER | MERCHANT), amount?, comment?.
  resolve(id: string, a: { inFavorOf: "CUSTOMER" | "MERCHANT"; amount?: number; comment?: string }) {
    return this.call("POST", `${this.baseUrl}/simulation/pa/payment_disputes/${enc(id)}/resolve`, defined({
      in_favor_of: a.inFavorOf,
      amount: a.amount,
      comment: a.comment,
    }));
  }
  // =================== END SANDBOX-ONLY SIMULATION CALLS ===================
}

export function enc(s: string): string {
  return encodeURIComponent(s);
}

export function defined(o: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined));
}

async function readJson(res: Response): Promise<unknown> {
  const text = await res.text();
  try {
    return text ? JSON.parse(text) : {};
  } catch {
    return { raw: text };
  }
}
