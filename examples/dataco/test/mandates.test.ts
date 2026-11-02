import { test } from "node:test";
import assert from "node:assert/strict";
import { planLimits, CENT } from "@dispute-court/example-dataco";
import { isValidPrice } from "@dispute-court/protocol";

const U = (cents: number) => BigInt(cents) * CENT;
const TOTAL = U(2000);
const state = () => ({
  sourcing: { spent: U(6), budget: U(1000), cap: U(3) },
  support: { spent: U(0), budget: U(400), cap: U(100) },
  treasury: { spent: U(0), budget: U(600), cap: U(600) },
});

test("price jump: cap raised to upstream, sum within total, spend carried", () => {
  const p = planLimits(state(), U(4), U(5), TOTAL);
  assert.ok(!("error" in p));
  assert.equal(p.proposal.sourcing.cap, U(4));
  const sum = p.proposal.sourcing.budget + p.proposal.support.budget + p.proposal.treasury.budget;
  assert.ok(sum <= TOTAL);
  assert.ok(p.proposal.sourcing.budget > U(6));
});
test("margin under 0.01 proposes a new sale price with 0.01 margin", () => {
  const p = planLimits(state(), U(4), U(4), TOTAL);
  assert.ok(!("error" in p));
  assert.equal(p.salePrice, U(5));
});
test("healthy margin keeps the sale price", () => {
  const p = planLimits(state(), U(2), U(5), TOTAL);
  assert.ok(!("error" in p));
  assert.equal(p.salePrice, U(5));
});
test("everything is whole cents", () => {
  const s = state();
  s.sourcing.spent = U(6) + 12345n;
  const p = planLimits(s, U(4) + 7n, U(5), TOTAL);
  assert.ok(!("error" in p));
  for (const a of [p.proposal.sourcing, p.proposal.support, p.proposal.treasury]) {
    assert.equal(a.budget % CENT, 0n);
    assert.equal(a.cap % CENT, 0n);
  }
  assert.ok(p.proposal.sourcing.cap >= U(4) + 7n);
});
test("over-allocated budgets are trimmed to the total", () => {
  const s = state();
  s.sourcing.budget = U(1500);
  const p = planLimits(s, U(4), U(5), TOTAL);
  assert.ok(!("error" in p));
  assert.ok(p.proposal.sourcing.budget + p.proposal.support.budget + p.proposal.treasury.budget <= TOTAL);
});
test("impossible: spend already exhausts the total", () => {
  const s = state();
  s.sourcing.spent = U(1990);
  s.support.spent = U(10);
  assert.ok("error" in planLimits(s, U(4), U(5), TOTAL));
});

test("price validation", () => {
  assert.ok(isValidPrice("0.04"));
  assert.ok(!isValidPrice("0.4"));
  assert.ok(!isValidPrice("-0.04"));
  assert.ok(!isValidPrice(0.04));
});
