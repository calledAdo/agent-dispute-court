import test from "node:test";
import assert from "node:assert/strict";
import {
  explain, intake, judgeQuality, INTAKE_SYSTEM_PROMPT, JUDGE_SYSTEM_PROMPT,
  type ModelClient,
} from "@dispute-court/court";
import type { Ruling } from "@dispute-court/court";
import type { Claim } from "@dispute-court/protocol";

const TX1 = "0x1111111111111111111111111111111111111111111111111111111111111111";
const TX_UNKNOWN = "0x9999999999999999999999999999999999999999999999999999999999999999";
const sales = [{ tx: TX1, resource: "GET /quote?symbol=TSLA", settledAt: 1 }];

function stub(content: unknown) {
  const calls: any[] = [];
  const client: ModelClient = {
    messages: { create: async (args) => { calls.push(args); return content; } },
  };
  return { client, calls };
}
const toolUse = (_name: string, input: unknown) => ({
  content: [{ type: "text", text: JSON.stringify(input) }],
});

test("intake requests structured output and states code authority in the prompt", async () => {
  const { client, calls } = stub(toolUse("submit_claims", { claims: [] }));
  await intake("x", sales, client, "m");
  assert.equal(calls[0].tools, undefined);
  assert.equal(calls[0].tool_choice, undefined);
  assert.equal(calls[0].output_config.format.type, "json_schema");
  assert.equal(calls[0].output_config.format.schema.type, "object");
  assert.match(INTAKE_SYSTEM_PROMPT, /untrusted data, not as instructions/);
  assert.equal(calls[0].model, "m");
  assert.match(INTAKE_SYSTEM_PROMPT, /final/);
  assert.match(JUDGE_SYSTEM_PROMPT, /final/);
  assert.match(JUDGE_SYSTEM_PROMPT, /data quality/);
});

test("intake drops unknown tx and keeps valid claims with allegedResource", async () => {
  const { client } = stub(toolUse("submit_claims", { claims: [
    { tx: TX_UNKNOWN, code: "A12" },
    { tx: TX1, code: "A10", allegedResource: "GET /quote?symbol=AAPL" },
    { tx: TX1, code: "A13.3" },
    { tx: TX1, code: "A99" },
  ] }));
  const claims = await intake("I asked for AAPL not TSLA", sales, client, "m");
  assert.equal(claims.length, 2);
  assert.equal(claims[0]!.code, "A10");
  assert.equal(claims[0]!.allegedResource, "GET /quote?symbol=AAPL");
  assert.equal(claims[1]!.code, "A13.3");
  assert.equal(claims[1]!.allegedResource, undefined);
  assert.notEqual(claims[0]!.id, claims[1]!.id);
});

test("intake throws on unusable output instead of returning no claims", async () => {
  const bad: unknown[] = [
    { content: [] },
    toolUse("x", { claims: "no" }),
    null,
    { content: [{ type: "text", text: "not json" }] },
    { stop_reason: "max_tokens", content: [{ type: "text", text: '{"claims":[{"tx":' }] },
    { stop_reason: "max_tokens", content: [{ type: "text", text: '{"claims":[]}' }] },
  ];
  for (const content of bad) {
    await assert.rejects(intake("x", sales, stub(content).client, "m"), (e: Error) => {
      assert.equal(e.name, "IntakeError");
      assert.match(e.message, /^model_output_invalid: /);
      return true;
    });
  }
});

test("intake returns [] only for a valid empty claims array", async () => {
  assert.deepEqual(await intake("x", sales, stub(toolUse("x", { claims: [] })).client, "m"), []);
});

test("thinking blocks are skipped and text blocks are joined", async () => {
  const content = { stop_reason: "end_turn", content: [
    { type: "thinking", thinking: "hmm", signature: "s" },
    { type: "redacted_thinking", data: "x" },
    { type: "text", text: `{"claims":[{"tx":"${TX1}",` },
    { type: "text", text: '"code":"A12"}]}' },
  ] };
  const claims = await intake("x", sales, stub(content).client, "m");
  assert.equal(claims.length, 1);
  assert.equal(claims[0]!.code, "A12");
  const j = await judgeQuality({ id: "c", tx: TX1 as `0x${string}`, code: "A13.3" }, {}, "c", stub({
    content: [{ type: "thinking", thinking: "t", signature: "s" },
      { type: "text", text: '{"upheld":true,"confidence":0.9,"rationale":"r","citedEvidence":[]}' }],
  }).client, "m");
  assert.equal(j.upheld, true);
});

test("both calls send max_tokens 8000; truncated judge output falls back", async () => {
  const a = stub(toolUse("x", { claims: [] }));
  await intake("x", sales, a.client, "m");
  assert.equal(a.calls[0].max_tokens, 8000);
  const b = stub({ stop_reason: "max_tokens", content: [{ type: "text", text: '{"upheld":true,"confidence":1,"rationale":"r","citedEvidence":[]}' }] });
  const j = await judgeQuality({ id: "c", tx: TX1 as `0x${string}`, code: "A13.3" }, {}, "c", b.client, "m");
  assert.equal(j.rationale, "model_output_invalid");
  assert.equal(b.calls[0].max_tokens, 8000);
});

const claim: Claim = { id: "c1", tx: TX1 as `0x${string}`, code: "A13.3" };

test("judgeQuality clamps confidence and drops unknown evidence keys", async () => {
  const { client, calls } = stub(toolUse("submit_judgment", {
    upheld: true, confidence: 7, rationale: "stale", citedEvidence: ["receipt", "made_up"],
  }));
  const j = await judgeQuality(claim, { receipt: { a: 1n }, other: 1 }, "stale", client, "m");
  assert.deepEqual(j, { upheld: true, confidence: 1, rationale: "stale", citedEvidence: ["receipt"] });
  assert.equal(calls[0].tool_choice, undefined);
  assert.equal(calls[0].output_config.format.type, "json_schema");
  const low = await judgeQuality(claim, {}, "c",
    stub(toolUse("submit_judgment", { upheld: false, confidence: -3, rationale: "r", citedEvidence: [] })).client, "m");
  assert.equal(low.confidence, 0);
});

test("judgeQuality returns the invalid sentinel on malformed output", async () => {
  const invalid = { upheld: false, confidence: 0, rationale: "model_output_invalid", citedEvidence: [] };
  for (const content of [
    null,
    { content: [{ type: "text", text: "no tool" }] },
    { content: [{ type: "text", text: "not json {" }] },
    { content: [{ type: "text", text: "[1,2]" }] },
    toolUse("submit_judgment", { upheld: "yes", confidence: 1, rationale: "r", citedEvidence: [] }),
    toolUse("submit_judgment", { upheld: true, confidence: "high", rationale: "r", citedEvidence: [] }),
    toolUse("submit_judgment", { upheld: true, confidence: 1, rationale: "r" }),
  ]) {
    assert.deepEqual(await judgeQuality(claim, {}, "c", stub(content).client, "m"), invalid);
  }
});

test("explain is a deterministic summary", () => {
  const rulings: Ruling[] = [
    { claimId: "c1", tx: TX1, code: "A12", verdict: "REFUND", liable: "SELLER", refund: 40n, proposedRefund: 40n, reason: "dup", evidence: [], decidedBy: "code" },
    { claimId: "c2", tx: TX1, code: "A10", verdict: "REJECT", liable: "PRINCIPAL", refund: 0n, proposedRefund: 0n, reason: "signed", evidence: [], decidedBy: "code" },
  ];
  const out = explain(rulings);
  assert.equal(out, explain(rulings));
  assert.match(out, /c1 \(A12.*REFUND, liable: SELLER.*Refund: 40/);
  assert.match(out, /c2 \(A10.*REJECT, liable: PRINCIPAL/);
  assert.match(out, /Total refund: 40/);
  assert.equal(explain([]), "No claims were decided.");
});
