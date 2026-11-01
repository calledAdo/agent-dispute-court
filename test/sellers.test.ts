import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadSellers } from "../court/sellers.ts";

const DATA_CO = "0x00000000000000000000000000000000000000aa";
const SWIFT = "0x00000000000000000000000000000000000000bb";

function withSellersFile(value: unknown, fn: (path: string) => void): void {
  const dir = mkdtempSync(join(tmpdir(), "court-sellers-"));
  try {
    const path = join(dir, "sellers.json");
    writeFileSync(path, JSON.stringify(value));
    fn(path);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test("loadSellers reads a valid COURT_SELLERS file", () => {
  const file = [
    { name: "DataCo", address: DATA_CO, receipts: "data/co.jsonl", priceList: { "GET /quote": "0.05" } },
    { name: "Swift", address: SWIFT, receipts: "data/swift.jsonl", priceList: { "GET /infer": "0.02" } },
  ];
  withSellersFile(file, (path) => {
    assert.deepEqual(loadSellers({ COURT_SELLERS: path }), file);
  });
});

test("loadSellers refuses duplicate addresses, case-insensitively", () => {
  const file = [
    { name: "DataCo", address: DATA_CO, receipts: "data/co.jsonl", priceList: { "GET /quote": "0.05" } },
    { name: "Swift", address: DATA_CO.toUpperCase().replace("0X", "0x"), receipts: "data/swift.jsonl", priceList: { "GET /infer": "0.02" } },
  ];
  withSellersFile(file, (path) => {
    assert.throws(() => loadSellers({ COURT_SELLERS: path }), /duplicate seller address/);
  });
});

test("loadSellers refuses a price that is not a decimal amount", () => {
  const file = [{ name: "DataCo", address: DATA_CO, receipts: "data/co.jsonl", priceList: { "GET /quote": "five cents" } }];
  withSellersFile(file, (path) => {
    assert.throws(() => loadSellers({ COURT_SELLERS: path }), /not a decimal amount/);
  });
});

test("loadSellers refuses a numeric price or a bad address", () => {
  withSellersFile([{ name: "DataCo", address: DATA_CO, receipts: "data/co.jsonl", priceList: { "GET /quote": 0.05 } }], (path) => {
    assert.throws(() => loadSellers({ COURT_SELLERS: path }), /must be a decimal string/);
  });
  withSellersFile([{ name: "DataCo", address: "nope", receipts: "data/co.jsonl", priceList: { "GET /quote": "0.05" } }], (path) => {
    assert.throws(() => loadSellers({ COURT_SELLERS: path }), /address must be a 0x address/);
  });
});

test("loadSellers falls back to the single DataCo seller", () => {
  assert.deepEqual(loadSellers({ SELLER: DATA_CO, SELLER_RECEIPTS: "data/receipts.jsonl" }), [
    { name: "DataCo", address: DATA_CO, receipts: "data/receipts.jsonl", priceList: { "GET /quote": "0.05" } },
  ]);
  assert.deepEqual(loadSellers({ COURT_SELLERS: "", SELLER: DATA_CO, SELLER_RECEIPTS: "r.jsonl" })[0].name, "DataCo");
});

test("loadSellers explains what is missing in the fallback", () => {
  assert.throws(() => loadSellers({ SELLER_RECEIPTS: "r.jsonl" }), /SELLER is required/);
  assert.throws(() => loadSellers({ SELLER: DATA_CO }), /SELLER_RECEIPTS is required/);
});
