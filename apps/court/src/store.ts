import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { CaseResult } from "./case.ts";

export interface CaseStore {
  save(result: CaseResult): void;
  get(id: string): CaseResult | undefined;
  list(): CaseResult[];
}

/** BigInts become {"$bigint":"123"}, so ordinary strings such as "42n" are never mistaken for them. */
function isTagged(v: unknown): v is { $bigint: string } {
  if (typeof v !== "object" || v === null) return false;
  const keys = Object.keys(v);
  return keys.length === 1 && keys[0] === "$bigint" && typeof (v as { $bigint: unknown }).$bigint === "string";
}

export function encode(value: unknown): string {
  return JSON.stringify(value, (_k, v) => (typeof v === "bigint" ? { $bigint: v.toString() } : v));
}

export function decode<T>(text: string): T {
  return JSON.parse(text, (_k, v) => (isTagged(v) ? BigInt(v.$bigint) : v)) as T;
}

/** Append-only JSONL: a later save with the same id supersedes the earlier line. */
export function createCaseStore(dir: string): CaseStore {
  const file = join(dir, "cases.jsonl");

  function list(): CaseResult[] {
    if (!existsSync(file)) return [];
    const latest = new Map<string, CaseResult>();
    for (const line of readFileSync(file, "utf8").split("\n")) {
      if (line.trim() === "") continue;
      const result = decode<CaseResult>(line);
      latest.delete(result.id); // keep insertion order = order of last save
      latest.set(result.id, result);
    }
    return [...latest.values()];
  }

  return {
    save(result) {
      mkdirSync(dir, { recursive: true });
      appendFileSync(file, encode(result) + "\n");
    },
    get: (id) => list().find((r) => r.id === id),
    list,
  };
}
