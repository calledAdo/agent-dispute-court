import fs from "node:fs";
import type { ReceiptRecord } from "./offer.ts";

/** Append-only JSONL log, one record per settlement tx. */
export class ReceiptLog {
  path: string;
  constructor(path: string) {
    this.path = path;
  }

  all(): ReceiptRecord[] {
    if (!fs.existsSync(this.path)) return [];
    return fs.readFileSync(this.path, "utf8").split("\n").filter((l) => l.trim() !== "").map((l) => JSON.parse(l) as ReceiptRecord);
  }

  byTx(tx: string): ReceiptRecord | undefined {
    return this.all().find((r) => r.tx === tx);
  }

  /** Returns false (and writes nothing) if this tx is already logged. */
  append(r: ReceiptRecord): boolean {
    if (this.byTx(r.tx)) return false;
    fs.appendFileSync(this.path, JSON.stringify(r) + "\n");
    return true;
  }
}
