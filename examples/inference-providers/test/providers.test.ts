import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import type { RequestHandler } from "express";
import { buildOffer, canonicalRequest, sha256Hex } from "@dispute-court/seller";
import { ReceiptLog } from "@dispute-court/seller";
import { checkInferOutput, DEFAULT_INFER_ACCEPTANCE } from "@dispute-court/protocol";
import { createProvider } from "@dispute-court/example-inference-providers";
import type { ModelClient } from "@dispute-court/example-inference-providers";

const PAY_TO = "0x1111111111111111111111111111111111111111";
const TOKEN = "op-secret";
const NAME = "Swift";
const MODEL = "claude-haiku-5-5";

type ModelCall = { model?: unknown; max_tokens?: unknown; output_config?: unknown; messages?: unknown };

interface Harness {
  base: string;
  calls: ModelCall[];
  close: () => Promise<void>;
}

function honest(summary = "A short summary.", keywords = ["alpha"]) {
  return { content: [{ type: "text", text: JSON.stringify({ summary, keywords }) }] };
}

async function start(
  content: unknown = honest(),
  over: Partial<{ statusDelayMs: number; price: string; client: ModelClient }> = {},
): Promise<Harness> {
  const calls: ModelCall[] = [];
  const client: ModelClient = over.client ?? {
    messages: {
      create: async (args) => {
        calls.push(args as ModelCall);
        return content;
      },
    },
  };
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "provider-"));
  const app = createProvider({
    name: NAME,
    model: MODEL,
    price: over.price ?? "0.02",
    payTo: PAY_TO,
    rpcUrl: "http://127.0.0.1:9",
    operatorToken: TOKEN,
    anthropic: client,
    log: new ReceiptLog(path.join(dir, "receipts.jsonl")),
    now: () => 1_700_000_000_000,
    statusDelayMs: over.statusDelayMs ?? 0,
    // Bypass x402: the provider tests are about request/response behaviour, not settlement.
    gate: ((_req, _res, next) => next()) as RequestHandler,
  });
  const server = await new Promise<Server>((resolve) => {
    const s = app.listen(0, "127.0.0.1", () => resolve(s));
  });
  return {
    base: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
    calls,
    close: () => new Promise((resolve) => server.close(() => resolve())),
  };
}

const resourceFor = (text: string) => canonicalRequest("GET", "/infer", { task: "summary-v1", text });
const hashFor = (text: string) => sha256Hex(resourceFor(text));
const inferUrl = (h: Harness, text: string) =>
  `${h.base}/infer?task=summary-v1&text=${encodeURIComponent(text)}`;

const admin = (h: Harness, body: unknown, token: string | null = TOKEN) =>
  fetch(`${h.base}/admin`, {
    method: "POST",
    headers: { "content-type": "application/json", ...(token === null ? {} : { "x-operator-token": token }) },
    body: JSON.stringify(body),
  });

const pay = async (h: Harness, text: string) => {
  const res = await fetch(inferUrl(h, text));
  return { res, body: await res.text() };
};

test("status exposes the provider identity and the infer acceptance", async () => {
  const h = await start();
  try {
    const res = await fetch(`${h.base}/status`);
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), {
      name: NAME,
      model: MODEL,
      price: "0.02",
      payTo: PAY_TO,
      acceptance: DEFAULT_INFER_ACCEPTANCE,
    });
  } finally {
    await h.close();
  }
});

test("status is delayed by statusDelayMs", async () => {
  const h = await start(honest(), { statusDelayMs: 40 });
  try {
    const startedAt = performance.now();
    const res = await fetch(`${h.base}/status`);
    const elapsed = performance.now() - startedAt;
    assert.equal(res.status, 200);
    assert.ok(elapsed >= 30, `expected at least 30ms of delay, got ${elapsed}ms`);
  } finally {
    await h.close();
  }
});

test("admin requires the operator token", async () => {
  const h = await start();
  try {
    assert.equal((await admin(h, { price: "0.03" }, null)).status, 401);
    assert.equal((await admin(h, { price: "0.03" }, "wrong")).status, 401);
    const state = (await (await fetch(`${h.base}/status`)).json()) as { price: string };
    assert.equal(state.price, "0.02");
  } finally {
    await h.close();
  }
});

test("admin rejects invalid updates and keeps the old state", async () => {
  const h = await start();
  try {
    const bad = [
      { price: "0.1" },
      { price: "0.000" },
      { price: "0.00" },
      { price: 3 },
      { statusDelayMs: -1 },
      { statusDelayMs: 30001 },
      { statusDelayMs: 1.5 },
      { statusDelayMs: "10" },
      { fault: "bogus" },
      { faultCount: 0 },
      { faultCount: 1.5 },
      { faultCount: "2" },
      { faultCount: 2 },
    ];
    for (const body of bad) assert.equal((await admin(h, body)).status, 400, JSON.stringify(body));

    const res = await admin(h, { price: "0.04", statusDelayMs: 5, fault: "empty", faultCount: 2 });
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), {
      name: NAME,
      model: MODEL,
      price: "0.04",
      payTo: PAY_TO,
      statusDelayMs: 5,
      fault: "empty",
      faultCount: 2,
    });
  } finally {
    await h.close();
  }
});

test("a fault applies for faultCount paid responses and then resets", async () => {
  const h = await start();
  try {
    assert.equal((await admin(h, { fault: "empty", faultCount: 2 })).status, 200);
    for (let i = 0; i < 2; i++) {
      const text = `text ${i}`;
      const { res, body } = await pay(h, text);
      assert.equal(res.status, 200);
      assert.equal(checkInferOutput(body, hashFor(text), DEFAULT_INFER_ACCEPTANCE), "empty_summary");
    }
    const text = "text 3";
    const third = await pay(h, text);
    assert.equal(checkInferOutput(third.body, hashFor(text), DEFAULT_INFER_ACCEPTANCE), null);
    const state = (await (await admin(h, {})).json()) as { fault: string; faultCount: number };
    assert.equal(state.fault, "none");
    assert.equal(state.faultCount, 0);
  } finally {
    await h.close();
  }
});

test("each fault makes checkInferOutput reject with the expected violation", async () => {
  const h = await start();
  try {
    const cases = [
      ["empty", "empty_summary"],
      ["truncated", "body_unparseable"],
      ["wrong_request", "wrong_request"],
    ] as const;
    for (const [fault, expected] of cases) {
      assert.equal((await admin(h, { fault, faultCount: 1 })).status, 200);
      const text = `summarize ${fault}`;
      const { res, body } = await pay(h, text);
      assert.equal(res.status, 200, fault);
      assert.match(res.headers.get("content-type") ?? "", /application\/json/, fault);
      assert.equal(checkInferOutput(body, hashFor(text), DEFAULT_INFER_ACCEPTANCE), expected, fault);
    }
  } finally {
    await h.close();
  }
});

test("an honest response passes infer-v1 and asks the model for the required shape", async () => {
  const h = await start(honest("A memo about revenue.", ["revenue", "memo"]));
  try {
    const text = "Q3 revenue memo";
    const { res, body } = await pay(h, text);
    assert.equal(res.status, 200);
    assert.equal(checkInferOutput(body, hashFor(text), DEFAULT_INFER_ACCEPTANCE), null);
    const parsed = JSON.parse(body) as { task: string; requestHash: string; keywords: string[] };
    assert.equal(parsed.task, "summary-v1");
    assert.equal(parsed.requestHash, hashFor(text));
    assert.deepEqual(parsed.keywords, ["revenue", "memo"]);
    assert.equal(h.calls[0].model, MODEL);
    assert.equal(h.calls[0].max_tokens, 2000);
    assert.deepEqual(h.calls[0].output_config, {
      format: {
        type: "json_schema",
        schema: {
          type: "object",
          properties: {
            summary: { type: "string" },
            keywords: { type: "array", items: { type: "string" } },
          },
          required: ["summary", "keywords"],
          additionalProperties: false,
        },
      },
    });
  } finally {
    await h.close();
  }
});

test("clamps summary and keywords to the acceptance limits", async () => {
  const h = await start(honest("x".repeat(500), ["a", "b", "c", "d", "e", "f", "g"]));
  try {
    const text = "long";
    const { body } = await pay(h, text);
    const parsed = JSON.parse(body) as { summary: string; keywords: string[] };
    assert.equal(parsed.summary.length, DEFAULT_INFER_ACCEPTANCE.maxChars);
    assert.equal(parsed.keywords.length, DEFAULT_INFER_ACCEPTANCE.maxKeywords);
    assert.equal(checkInferOutput(body, hashFor(text), DEFAULT_INFER_ACCEPTANCE), null);
  } finally {
    await h.close();
  }
});

test("a model failure returns 502 with sanitized text", async () => {
  const client: ModelClient = {
    messages: {
      create: async () => {
        throw new Error(`boom https://secret.example/rpc?key=abc 0x${"a".repeat(64)}`);
      },
    },
  };
  const h = await start(honest(), { client });
  try {
    const res = await fetch(inferUrl(h, "x"));
    assert.equal(res.status, 502);
    const body = (await res.json()) as { error: string };
    assert.match(body.error, /boom/);
    assert.equal(body.error.includes("secret.example"), false);
    assert.equal(body.error.includes("a".repeat(32)), false);
  } finally {
    await h.close();
  }
});

test("unreadable model output returns 502", async () => {
  const client: ModelClient = {
    messages: { create: async () => ({ content: [{ type: "text", text: "{not json" }] }) },
  };
  const h = await start(honest(), { client });
  try {
    const res = await fetch(inferUrl(h, "x"));
    assert.equal(res.status, 502);
    const body = (await res.json()) as { error: string };
    assert.match(body.error, /model_output_invalid: unparseable_json/);
  } finally {
    await h.close();
  }
});

test("missing or oversized text is rejected without calling the model", async () => {
  const h = await start();
  try {
    const queries = [
      "",
      "?task=summary-v1",
      "?task=summary-v1&text=",
      `?task=summary-v1&text=${encodeURIComponent("   ")}`,
      `?task=summary-v1&text=${encodeURIComponent("x".repeat(1501))}`,
    ];
    for (const q of queries) assert.equal((await fetch(`${h.base}/infer${q}`)).status, 400, q);
    assert.equal(h.calls.length, 0);
  } finally {
    await h.close();
  }
});

test("buildOffer defaults keep the quote seller's offer byte-identical", () => {
  const acceptance = { verifier: "quote-v1", maxStalenessMs: 60000, maxDeviationBps: 50 } as const;
  const resource = "GET /quote?symbol=TSLA";
  const expected = {
    "GET /quote": {
      accepts: {
        scheme: "exact",
        network: "eip155:63825",
        payTo: "0xabc",
        price: "0.05",
        extra: { signedOffer: "required", resource, requestHash: sha256Hex(resource), acceptance },
      },
      description: "One market quote",
    },
  };
  const offer = buildOffer({ payTo: "0xabc", price: "0.05", resource, acceptance });
  assert.equal(JSON.stringify(offer), JSON.stringify(expected));
});

test("buildOffer takes a custom route and description", () => {
  const resource = "GET /infer?task=summary-v1&text=hi";
  const offer = buildOffer({
    payTo: "0xabc",
    price: "0.02",
    resource,
    acceptance: DEFAULT_INFER_ACCEPTANCE,
    route: "GET /infer",
    description: "One inference step",
  });
  assert.deepEqual(Object.keys(offer), ["GET /infer"]);
  assert.deepEqual(offer["GET /infer"].accepts.extra, {
    signedOffer: "required",
    resource,
    requestHash: sha256Hex(resource),
    acceptance: DEFAULT_INFER_ACCEPTANCE,
  });
  assert.equal(offer["GET /infer"].description, "One inference step");
});
