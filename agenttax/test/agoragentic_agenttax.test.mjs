import assert from "node:assert/strict";
import test from "node:test";

import {
  AgoragenticAgentTaxClient,
  hashTaxReviewPayload,
} from "../agoragentic_agenttax.ts";

function response(body, { ok = true, status = 200 } = {}) {
  return { ok, status, json: async () => body };
}

function quoteEnvelope(overrides = {}) {
  return {
    quote: {
      quote_id: "quote-reviewed-1",
      capability: { id: "cap-reviewed-1", category: "summarize" },
      quoted_price_usdc: 0.4,
      execution_ready: true,
      expires_at: new Date(Date.now() + 120_000).toISOString(),
      ...overrides,
    },
  };
}

function executionRequest(overrides = {}) {
  return {
    capabilityId: "cap-reviewed-1",
    task: "summarize",
    input: { text: "quarterly report", nested: { z: 1, a: 2 } },
    maxCost: 0.5,
    taxContext: { buyerJurisdiction: "US-NY", sellerJurisdiction: "US-CA" },
    ...overrides,
  };
}

async function approval(payload, overrides = {}) {
  return {
    approved: true,
    status: "approved",
    review_id: "tax-review-1",
    review_payload_sha256: await hashTaxReviewPayload(payload),
    expires_at: new Date(Date.now() + 60_000).toISOString(),
    ...overrides,
  };
}

test("approved execution consumes the exact reviewed quote and immutable input", async () => {
  const calls = [];
  const request = executionRequest();
  const client = new AgoragenticAgentTaxClient({
    apiKey: "amk_test",
    fetchImpl: async (url, init) => {
      calls.push({ url, init });
      if (url.endsWith("/commerce/quotes")) return response(quoteEnvelope());
      return response({ status: "completed", receipt: { id: "rcpt-1" } });
    },
  });

  const result = await client.executeWithTaxReview(request, async (payload) => {
    assert.equal(Object.isFrozen(payload), true);
    assert.equal(Object.isFrozen(payload.input), true);
    assert.equal(Object.isFrozen(payload.quote), true);
    assert.equal(Reflect.set(payload.input, "text", "callback mutation"), false);
    request.input.text = "caller mutation";
    return approval(payload);
  });

  assert.equal(calls.length, 2);
  assert.equal(calls[0].url, "https://agoragentic.com/api/commerce/quotes");
  assert.equal(calls[1].url, "https://agoragentic.com/api/execute");
  assert.equal(calls[0].init.method, "POST");
  assert.equal(calls[1].init.method, "POST");
  const quoteBody = JSON.parse(calls[0].init.body);
  const executeBody = JSON.parse(calls[1].init.body);
  assert.equal(quoteBody.capability_id, "cap-reviewed-1");
  assert.equal(quoteBody.input.text, "quarterly report");
  assert.equal(executeBody.quote_id, "quote-reviewed-1");
  assert.equal(executeBody.task, "summarize");
  assert.equal(executeBody.input.text, "quarterly report");
  assert.equal(result.review.review_id, "tax-review-1");
  assert.equal(result.execution.status, "completed");
});

test("approved true without explicit approved status fails closed", async () => {
  const calls = [];
  const client = new AgoragenticAgentTaxClient({
    apiKey: "amk_test",
    fetchImpl: async (url, init) => {
      calls.push({ url, init });
      return response(quoteEnvelope());
    },
  });

  const result = await client.executeWithTaxReview(executionRequest(), async (payload) => ({
    approved: true,
    review_id: "missing-status",
    review_payload_sha256: await hashTaxReviewPayload(payload),
    expires_at: new Date(Date.now() + 60_000).toISOString(),
  }));

  assert.equal(result.status, "blocked");
  assert.equal(calls.length, 1);
});

test("advisory reviews cannot authorize execution", async () => {
  const calls = [];
  const client = new AgoragenticAgentTaxClient({
    apiKey: "amk_test",
    fetchImpl: async (url, init) => {
      calls.push({ url, init });
      return response(quoteEnvelope());
    },
  });

  const result = await client.executeWithTaxReview(executionRequest(), async () => ({
    approved: false,
    status: "advisory",
  }));

  assert.equal(result.status, "blocked");
  assert.match(result.message, /advisory/i);
  assert.equal(calls.length, 1);
});

test("missing, expired, and mismatched approvals fail closed", async (t) => {
  const cases = [
    { name: "missing review id", overrides: { review_id: "" } },
    { name: "expired", overrides: { expires_at: new Date(Date.now() - 1).toISOString() } },
    { name: "mismatched digest", overrides: { review_payload_sha256: "0".repeat(64) } },
  ];

  for (const testCase of cases) {
    await t.test(testCase.name, async () => {
      let executeCalls = 0;
      const client = new AgoragenticAgentTaxClient({
        apiKey: "amk_test",
        fetchImpl: async (url) => {
          if (url.endsWith("/execute")) executeCalls += 1;
          return response(quoteEnvelope());
        },
      });
      const result = await client.executeWithTaxReview(
        executionRequest(),
        async (payload) => approval(payload, testCase.overrides),
      );
      assert.equal(result.status, "blocked");
      assert.equal(executeCalls, 0);
    });
  }
});

test("quote validation binds capability, ceiling, readiness, and expiry", async (t) => {
  const cases = [
    {
      name: "different capability",
      quote: { capability: { id: "cap-other", category: "summarize" } },
      message: /does not match/i,
    },
    { name: "over ceiling", quote: { quoted_price_usdc: 0.51 }, message: /exceeds maxCost/i },
    { name: "not ready", quote: { execution_ready: false }, message: /not execution-ready/i },
    {
      name: "expired quote",
      quote: { expires_at: new Date(Date.now() - 1).toISOString() },
      message: /expired/i,
    },
  ];

  for (const testCase of cases) {
    await t.test(testCase.name, async () => {
      const client = new AgoragenticAgentTaxClient({
        apiKey: "amk_test",
        fetchImpl: async () => response(quoteEnvelope(testCase.quote)),
      });
      await assert.rejects(client.prepareTaxReview(executionRequest()), testCase.message);
    });
  }
});

test("a quote that expires during review is not executed", async () => {
  const calls = [];
  const client = new AgoragenticAgentTaxClient({
    apiKey: "amk_test",
    fetchImpl: async (url, init) => {
      calls.push({ url, init });
      return response(quoteEnvelope({
        expires_at: new Date(Date.now() + 250).toISOString(),
      }));
    },
  });

  const result = await client.executeWithTaxReview(executionRequest(), async (payload) => {
    await new Promise((resolve) => setTimeout(resolve, 300));
    return approval(payload);
  });

  assert.equal(result.status, "blocked");
  assert.match(result.message, /quote expired/i);
  assert.equal(calls.length, 1);
});

test("quote and execute HTTP failures fail closed", async (t) => {
  await t.test("quote failure", async () => {
    const client = new AgoragenticAgentTaxClient({
      apiKey: "amk_test",
      fetchImpl: async () => response({ error: "quote unavailable" }, { ok: false, status: 503 }),
    });
    await assert.rejects(client.prepareTaxReview(executionRequest()), /HTTP 503: quote unavailable/);
  });

  await t.test("execute failure", async () => {
    const client = new AgoragenticAgentTaxClient({
      apiKey: "amk_test",
      fetchImpl: async (url) => url.endsWith("/commerce/quotes")
        ? response(quoteEnvelope())
        : response({ error: "execution refused" }, { ok: false, status: 409 }),
    });
    await assert.rejects(
      client.executeWithTaxReview(executionRequest(), approval),
      /HTTP 409: execution refused/,
    );
  });
});

test("hashing is deterministic across object and Unicode key order", async () => {
  const left = {
    "\u{1F600}": { z: 1, a: [true, null, "x"] },
    "é": "composed",
    A: 1,
  };
  const right = {
    A: 1,
    "é": "composed",
    "\u{1F600}": { a: [true, null, "x"], z: 1 },
  };
  assert.equal(await hashTaxReviewPayload(left), await hashTaxReviewPayload(right));
});

test("non-JSON values and ambiguous structures are rejected", async (t) => {
  const cases = [
    { name: "Date", payload: { value: new Date() }, message: /plain JSON object/ },
    { name: "undefined", payload: { value: undefined }, message: /JSON-compatible/ },
    { name: "non-finite number", payload: { value: Number.NaN }, message: /finite JSON numbers/ },
    { name: "sparse array", payload: { value: Array(1) }, message: /sparse array slot/ },
  ];
  for (const testCase of cases) {
    await t.test(testCase.name, async () => {
      await assert.rejects(hashTaxReviewPayload(testCase.payload), testCase.message);
    });
  }
});

test("legacy jurisdiction is normalized and conflicts are rejected", async () => {
  const client = new AgoragenticAgentTaxClient({
    apiKey: "amk_test",
    fetchImpl: async () => response(quoteEnvelope()),
  });
  const payload = await client.prepareTaxReview(executionRequest({
    taxContext: { jurisdiction: "US-NY", buyerJurisdiction: "US-NY" },
  }));
  assert.equal(payload.tax_context.buyer_jurisdiction, "US-NY");
  assert.equal(payload.tax_context.seller_jurisdiction, "US-NY");

  await assert.rejects(
    client.prepareTaxReview(executionRequest({
      taxContext: { jurisdiction: "US-NY", buyerJurisdiction: "US-CA" },
    })),
    /conflicts with taxContext\.buyerJurisdiction/,
  );
});
