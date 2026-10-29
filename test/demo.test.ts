import { test } from "node:test";
import assert from "node:assert/strict";
import { parseFaults } from "../seller/server.ts";
import { unanchoredIndexes } from "../shared/batches.ts";

test("parseFaults reads stale and wrong symbols", () => {
  assert.deepEqual(parseFaults("stale:TSLA,wrong:MSFT"), { staleSymbols: ["TSLA"], wrongSymbols: ["MSFT"] });
  assert.deepEqual(parseFaults(" stale:tsla , stale:AAPL "), { staleSymbols: ["TSLA", "AAPL"] });
  assert.deepEqual(parseFaults(undefined), {});
  assert.deepEqual(parseFaults(""), {});
});
test("parseFaults rejects bad entries", () => {
  assert.throws(() => parseFaults("late:TSLA"));
  assert.throws(() => parseFaults("stale:"));
  assert.throws(() => parseFaults("stale"));
});
test("unanchoredIndexes returns the tail after the committed counts", () => {
  assert.deepEqual(unanchoredIndexes([], 3), [0, 1, 2]);
  assert.deepEqual(unanchoredIndexes([2n, 3n], 8), [5, 6, 7]);
  assert.deepEqual(unanchoredIndexes([2n, 3n], 5), []);
  assert.deepEqual(unanchoredIndexes([4n], 2), []);
  assert.deepEqual(unanchoredIndexes([], 0), []);
});

import { parseUnavailable } from "../court/reference.ts";
test("parseUnavailable splits, trims and upper-cases", () => {
  assert.deepEqual(parseUnavailable("GOOG, msft ,,"), ["GOOG", "MSFT"]);
  assert.deepEqual(parseUnavailable(undefined), []);
  assert.deepEqual(parseUnavailable(""), []);
});
