import type { InferAcceptance } from "./types.ts";

/**
 * The infer-v1 delivery standard. Used by providers (to build output), the router (to check
 * output before accepting it) and the court (A13.3 on an infer-v1 sale). Pure and deterministic,
 * so all three always agree.
 *
 * A conforming body is JSON: { task, requestHash, summary, keywords }, where requestHash is the
 * sha256 hex of the signed resource. Echoing it binds the output to the exact request that was paid for.
 */
export interface InferOutput {
  task: "summary-v1";
  requestHash: string;
  summary: string;
  keywords: string[];
}

export type InferViolation =
  | "body_unparseable"
  | "wrong_task"
  | "wrong_request"
  | "empty_summary"
  | "summary_too_long"
  | "bad_keywords";

export const DEFAULT_INFER_ACCEPTANCE: InferAcceptance = { verifier: "infer-v1", task: "summary-v1", maxChars: 400, maxKeywords: 5 };

/** Returns null when the body meets the standard, otherwise the first violation found. */
export function checkInferOutput(body: string, requestHash: string, acceptance: InferAcceptance): InferViolation | null {
  let value: unknown;
  try {
    value = JSON.parse(body);
  } catch {
    return "body_unparseable";
  }
  if (typeof value !== "object" || value === null || Array.isArray(value)) return "body_unparseable";
  const o = value as Record<string, unknown>;
  if (o.task !== acceptance.task) return "wrong_task";
  if (o.requestHash !== requestHash) return "wrong_request";
  if (typeof o.summary !== "string" || o.summary.trim() === "") return "empty_summary";
  if (o.summary.length > acceptance.maxChars) return "summary_too_long";
  const k = o.keywords;
  if (!Array.isArray(k) || k.length === 0 || k.length > acceptance.maxKeywords) return "bad_keywords";
  if (k.some((w) => typeof w !== "string" || w.trim() === "")) return "bad_keywords";
  return null;
}

/** Reads an infer-v1 acceptance from untrusted JSON (a signed offer). null if malformed. */
export function readInferAcceptance(v: unknown): InferAcceptance | null {
  if (typeof v !== "object" || v === null || Array.isArray(v)) return null;
  const o = v as Record<string, unknown>;
  if (o.verifier !== "infer-v1" || o.task !== "summary-v1") return null;
  if (!Number.isInteger(o.maxChars) || (o.maxChars as number) <= 0) return null;
  if (!Number.isInteger(o.maxKeywords) || (o.maxKeywords as number) <= 0) return null;
  return { verifier: "infer-v1", task: "summary-v1", maxChars: o.maxChars as number, maxKeywords: o.maxKeywords as number };
}
