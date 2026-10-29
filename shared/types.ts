export type CheckState = "DIFFERENCE_CONFIRMED" | "NO_DIFFERENCE_FOUND" | "COULD_NOT_BE_CHECKED";
export type ReasonCode = "A10" | "A12" | "A13.1" | "A13.3" | "A14";

/** One paid sale, as the seller logged it and the court has verified it against the chain. */
export interface Sale {
  tx: `0x${string}`;          // settlement transaction hash
  payer: `0x${string}`;       // buyer's Metal account
  payee: `0x${string}`;
  amount: bigint;             // base units
  settledAt: number;          // ms
  resource: string;           // canonical request the agent signed, e.g. "GET /quote?symbol=TSLA"
  requestHash: string;        // sha256 hex of resource, from the signed offer
  signedOrderValid: boolean | null; // result of verifyMandatePayment(tx, signedOrder); null = could not run
  receipt: Receipt | null;    // anchored delivery receipt, null if none was logged
  acceptance: Acceptance | null;    // criteria from the signed offer
}

export interface Receipt {
  status: number;             // HTTP status the seller returned
  responseHash: string;       // sha256 hex of the body
  body: string;               // the body (must hash to responseHash)
  anchored: boolean | null;   // Merkle proof verified on chain; null = could not check
}

export interface Acceptance {
  verifier: "quote-v1";
  maxStalenessMs: number;     // quote.asOf must be within this of settledAt
  maxDeviationBps: number;    // |quote.price - reference| / reference, in basis points
}

/** Reference price at settlement time, from the upstream source. null = unavailable. */
export type ReferencePrice = { symbol: string; price: number; at: number } | null;

export interface Claim {
  id: string;
  tx: `0x${string}`;
  code: ReasonCode;
  /** For A10: the request the customer says its agent actually asked for (optional). */
  allegedResource?: string;
}

export interface Finding {
  claimId: string;
  code: ReasonCode;
  state: CheckState;
  /** Machine-readable reason; required when state is COULD_NOT_BE_CHECKED. */
  reason: string;
  /** Evidence identifiers used (tx hashes, "receipt:<tx>", "acceptance:<tx>", ...). */
  evidence: string[];
}
