import { test } from "node:test";
import assert from "node:assert/strict";
import { makeQuote } from "@dispute-court/example-dataco";

test("makeQuote without faults", () => {
  const now = Date.parse("2026-01-01T00:00:00Z");
  const q = makeQuote("TSLA", now, () => 200);
  assert.deepEqual(q, { symbol: "TSLA", price: 200, asOf: "2026-01-01T00:00:00.000Z" });
});
test("makeQuote stale symbol is 5 minutes old", () => {
  const now = Date.parse("2026-01-01T00:00:00Z");
  const q = makeQuote("TSLA", now, () => 200, { staleSymbols: ["TSLA"] });
  assert.equal(q.asOf, "2025-12-31T23:55:00.000Z");
  assert.equal(q.price, 200);
});
test("makeQuote wrong symbol is 3% off", () => {
  const q = makeQuote("TSLA", 0, () => 200, { wrongSymbols: ["TSLA"] });
  assert.ok(Math.abs(q.price - 206) < 1e-9);
  assert.equal(makeQuote("AAPL", 0, () => 200, { wrongSymbols: ["TSLA"] }).price, 200);
});
