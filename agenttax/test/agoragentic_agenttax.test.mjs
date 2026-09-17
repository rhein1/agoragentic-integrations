import assert from "node:assert/strict";
import test from "node:test";

import {
  AgoragenticAgentTaxClient,
  TaxReviewedExecutionError,
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
      return response({
        status: "completed",
        invocation_id: "inv-1",
        receipt: { id: "rcpt-1" },
      });
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
  assert.equal("task" in executeBody, false);
  assert.equal(executeBody.input.text, "quarterly report");
  assert.equal(result.quote_id, "quote-reviewed-1");
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

test("approval fields hidden under an own __proto__ key cannot authorize execution", async () => {
  const calls = [];
  const client = new AgoragenticAgentTaxClient({
    apiKey: "amk_test",
    fetchImpl: async (url, init) => {
      calls.push({ url, init });
      return response(quoteEnvelope());
    },
  });

  const result = await client.executeWithTaxReview(executionRequest(), async (payload) => {
    const maliciousReview = JSON.parse('{"__proto__":{}}');
    Object.assign(maliciousReview.__proto__, await approval(payload));
    return maliciousReview;
  });

  assert.equal(result.status, "blocked");
  assert.equal(calls.length, 1);
  assert.equal(Object.prototype.approved, undefined);
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

test("multi-unit requests fail before network access", async () => {
  let calls = 0;
  const client = new AgoragenticAgentTaxClient({
    apiKey: "amk_test",
    fetchImpl: async () => {
      calls += 1;
      return response(quoteEnvelope());
    },
  });
  await assert.rejects(
    client.prepareTaxReview(executionRequest({ units: 2 })),
    /supports only units: 1/,
  );
  assert.equal(calls, 0);
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

test("pending supervisor approval can resume the same reviewed quote", async () => {
  const calls = [];
  let executeAttempts = 0;
  const client = new AgoragenticAgentTaxClient({
    apiKey: "amk_test",
    fetchImpl: async (url, init) => {
      calls.push({ url, init });
      if (url.endsWith("/commerce/quotes")) return response(quoteEnvelope());
      executeAttempts += 1;
      if (executeAttempts === 1) {
        return response({
          error: "pending_approval",
          approval: { approval_id: "approval-1" },
        }, { status: 202 });
      }
      return response({ status: "completed", invocation_id: "inv-1" });
    },
  });

  const pending = await client.executeWithTaxReview(executionRequest(), approval);
  assert.equal(pending.execution.error, "pending_approval");
  assert.equal(pending.execution_state, "pending_approval");
  const completed = await client.retryPendingTaxReview(pending);

  assert.equal(completed.execution.status, "completed");
  assert.equal(calls.filter((call) => call.url.endsWith("/commerce/quotes")).length, 1);
  const executeBodies = calls
    .filter((call) => call.url.endsWith("/execute"))
    .map((call) => JSON.parse(call.init.body));
  assert.equal(executeBodies.length, 2);
  assert.equal(executeBodies[0].quote_id, "quote-reviewed-1");
  assert.deepEqual(executeBodies[1], executeBodies[0]);

  const tampered = JSON.parse(JSON.stringify(pending));
  tampered.review_payload.input.text = "changed after review";
  await assert.rejects(client.retryPendingTaxReview(tampered), /not an active result/);
  await assert.rejects(client.retryPendingTaxReview(pending), /not an active result/);
  assert.equal(Reflect.set(completed, "execution_state", "pending_approval"), false);
  const forgedCompleted = JSON.parse(JSON.stringify(completed));
  forgedCompleted.execution_state = "pending_approval";
  forgedCompleted.http_status = 202;
  forgedCompleted.execution.status = "pending_approval";
  await assert.rejects(client.retryPendingTaxReview(forgedCompleted), /not an active result/);
  await assert.rejects(client.retryPendingTaxReview(completed), /not an active result/);
  assert.equal(calls.length, 3);
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
    await assert.rejects(client.executeWithTaxReview(executionRequest(), approval), (error) => {
      assert.equal(error instanceof TaxReviewedExecutionError, true);
      assert.equal(error.code, "tax_reviewed_execution_rejected");
      assert.equal(error.quote_id, "quote-reviewed-1");
      assert.equal(error.http_status, 409);
      assert.equal(error.server_code, "execution refused");
      assert.equal(error.retryable, false);
      return true;
    });
  });
});

test("ambiguous paid execution failures carry non-retryable reconciliation context", async () => {
  let calls = 0;
  const client = new AgoragenticAgentTaxClient({
    apiKey: "amk_test",
    fetchImpl: async (url) => {
      calls += 1;
      if (url.endsWith("/commerce/quotes")) return response(quoteEnvelope());
      throw new Error("socket closed after request write");
    },
  });

  await assert.rejects(client.executeWithTaxReview(executionRequest(), approval), (error) => {
    assert.equal(error instanceof TaxReviewedExecutionError, true);
    assert.equal(error.code, "tax_reviewed_execution_outcome_unknown");
    assert.equal(error.quote_id, "quote-reviewed-1");
    assert.equal(error.retryable, false);
    assert.equal(error.reconciliation_path, "/api/commerce/reconciliation");
    return true;
  });
  assert.equal(calls, 2);
});

test("server-failed paid execution is outcome-unknown and non-retryable", async () => {
  const client = new AgoragenticAgentTaxClient({
    apiKey: "amk_test",
    fetchImpl: async (url) => url.endsWith("/commerce/quotes")
      ? response(quoteEnvelope())
      : response({ error: "temporary failure" }, { ok: false, status: 503 }),
  });

  await assert.rejects(client.executeWithTaxReview(executionRequest(), approval), (error) => {
    assert.equal(error instanceof TaxReviewedExecutionError, true);
    assert.equal(error.code, "tax_reviewed_execution_outcome_unknown");
    assert.equal(error.quote_id, "quote-reviewed-1");
    assert.equal(error.http_status, 503);
    assert.equal(error.retryable, false);
    return true;
  });
});

test("2xx execution error and malformed envelopes are not reported as success", async (t) => {
  for (const testCase of [
    {
      name: "explicit error",
      body: { error: "execution refused" },
      code: "tax_reviewed_execution_rejected",
      serverCode: "execution refused",
    },
    {
      name: "malformed response",
      body: { output: "missing status and invocation" },
      code: "tax_reviewed_execution_outcome_unknown",
      serverCode: "malformed_execution_response",
    },
    {
      name: "failed status",
      body: { status: "failed" },
      code: "tax_reviewed_execution_rejected",
      serverCode: "execution_failed",
    },
    {
      name: "202 contradictory error",
      body: { error: "execution refused" },
      httpStatus: 202,
      code: "tax_reviewed_execution_rejected",
      serverCode: "execution refused",
    },
    {
      name: "unknown status",
      body: { status: "unknown", invocation_id: "inv-unknown" },
      code: "tax_reviewed_execution_outcome_unknown",
      serverCode: "unexpected_execution_status_unknown",
    },
    {
      name: "empty 202",
      body: {},
      httpStatus: 202,
      code: "tax_reviewed_execution_outcome_unknown",
      serverCode: "malformed_execution_response",
    },
    {
      name: "success missing invocation",
      body: { status: "completed" },
      code: "tax_reviewed_execution_outcome_unknown",
      serverCode: "missing_invocation_id",
    },
    {
      name: "contradictory pending and completed",
      body: {
        error: "pending_approval",
        status: "completed",
        approval: { approval_id: "approval-contradictory" },
      },
      code: "tax_reviewed_execution_outcome_unknown",
      serverCode: "contradictory_pending_execution_status",
    },
  ]) {
    await t.test(testCase.name, async () => {
      const client = new AgoragenticAgentTaxClient({
        apiKey: "amk_test",
        fetchImpl: async (url) => url.endsWith("/commerce/quotes")
          ? response(quoteEnvelope())
          : response(testCase.body, { status: testCase.httpStatus ?? 200 }),
      });
      await assert.rejects(client.executeWithTaxReview(executionRequest(), approval), (error) => {
        assert.equal(error instanceof TaxReviewedExecutionError, true);
        assert.equal(error.code, testCase.code);
        assert.equal(error.server_code, testCase.serverCode);
        assert.equal(error.quote_id, "quote-reviewed-1");
        return true;
      });
    });
  }
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

test("RFC 8785 hashing sorts numeric-looking and reserved keys as strings", async () => {
  const numericKeys = JSON.parse('{"2":"b","10":"a"}');
  assert.equal(
    await hashTaxReviewPayload(numericKeys),
    "a76f9931f09e47db676e50eebb06409ca3288449353bcd0eed02e168f7c6caf2",
  );

  const reservedLeft = JSON.parse(
    '{"prototype":"third","__proto__":{"safe":true},"constructor":"second"}',
  );
  const reservedRight = JSON.parse(
    '{"constructor":"second","prototype":"third","__proto__":{"safe":true}}',
  );
  assert.equal(
    await hashTaxReviewPayload(reservedLeft),
    await hashTaxReviewPayload(reservedRight),
  );
  assert.equal(Object.prototype.safe, undefined);
});

test("non-JSON values and ambiguous structures are rejected", async (t) => {
  const cases = [
    { name: "Date", payload: { value: new Date() }, message: /plain JSON object/ },
    { name: "undefined", payload: { value: undefined }, message: /JSON-compatible/ },
    { name: "non-finite number", payload: { value: Number.NaN }, message: /finite JSON numbers/ },
    { name: "sparse array", payload: { value: Array(1) }, message: /sparse array slot/ },
    { name: "unpaired surrogate", payload: { value: "\ud800" }, message: /unpaired UTF-16 surrogate/ },
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
