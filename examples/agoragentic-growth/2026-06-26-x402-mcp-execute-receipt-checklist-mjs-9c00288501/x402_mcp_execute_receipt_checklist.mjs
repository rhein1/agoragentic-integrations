// demo — moves no real funds

import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { pathToFileURL } from "node:url";

const DEFAULT_BASE_URL = process.env.AGORAGENTIC_URL || "https://agoragentic.com";
const MATCH_PATH = "/api/x402/execute/match";
const EXECUTE_PATH = "/api/x402/execute";

function lowerCaseHeaders(input = {}) {
  if (typeof Headers !== "undefined" && input instanceof Headers) {
    return Object.fromEntries(Array.from(input.entries(), ([k, v]) => [String(k).toLowerCase(), v]));
  }
  return Object.fromEntries(Object.entries(input || {}).map(([k, v]) => [String(k).toLowerCase(), v]));
}

function readHeader(source, name) {
  if (!source) return null;
  if (typeof source.get === "function") {
    return source.get(name) ?? source.get(String(name).toLowerCase()) ?? null;
  }
  const headers = lowerCaseHeaders(source.headers || source);
  return headers[String(name).toLowerCase()] ?? null;
}

function buildUrl(baseUrl, path, query = {}) {
  const url = new URL(path, baseUrl);
  for (const [key, value] of Object.entries(query || {})) {
    if (value === undefined || value === null || value === "") continue;
    url.searchParams.set(key, String(value));
  }
  return url.toString();
}

async function safeJson(response) {
  const text = await response.text();
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    return { raw: text };
  }
}

function createHttpError(message, extra = {}) {
  const error = new Error(message);
  error.name = "HttpError";
  Object.assign(error, extra);
  return error;
}

function createNetworkError(message, extra = {}) {
  const error = new Error(message);
  error.name = "NetworkError";
  Object.assign(error, extra);
  return error;
}

function normalizeRequestForX402(options = {}) {
  const idempotencyKey = options.idempotencyKey ?? randomUUID();
  const headers = lowerCaseHeaders(options.headers || {});
  delete headers["idempotency-key"];
  delete headers["x-idempotency-key"];

  let body = options.body;
  if (body !== undefined && body !== null && typeof body !== "string") {
    body = JSON.stringify(body);
    if (!headers["content-type"]) headers["content-type"] = "application/json";
  }

  return {
    ...options,
    idempotencyKey,
    body,
    headers: {
      accept: "application/json",
      ...headers,
      "idempotency-key": idempotencyKey,
    },
  };
}

function buildX402RequestHeaders(baseHeaders, idempotencyKey) {
  const requestHeaders = { accept: "application/json" };
  Object.assign(requestHeaders, baseHeaders);
  requestHeaders["idempotency-key"] = idempotencyKey;
  return requestHeaders;
}

function normalizePayResult(payment) {
  if (!payment || typeof payment !== "object") {
    throw new Error("pay callback must return an object");
  }
  if (!payment.authorizationHeader && !payment.paymentSignature) {
    throw new Error("pay callback must return authorizationHeader or paymentSignature");
  }
  return payment;
}

async function importPreferredX402Fetch() {
  try {
    const mod = await import("agoragentic/x402-client");
    if (typeof mod.x402Fetch === "function") return mod.x402Fetch;
  } catch {}
  return null;
}

async function localX402Fetch(url, options = {}) {
  const normalized = normalizeRequestForX402(options);
  const {
    fetchImpl = globalThis.fetch,
    pay,
    idempotencyKey,
    method = "GET",
    headers = {},
    body,
    signal,
    maxNetworkRetries = 1,
  } = normalized;

  if (typeof fetchImpl !== "function") {
    throw new Error("fetchImpl is required");
  }

  const baseHeaders = lowerCaseHeaders(headers);
  let cachedPayment = null;
  let sawPaymentChallenge = false;
  let networkRetriesUsed = 0;

  while (true) {
    const requestHeaders = buildX402RequestHeaders(baseHeaders, idempotencyKey);

    let requestBody = body;

    if (cachedPayment?.authorizationHeader) {
      requestHeaders.authorization = cachedPayment.authorizationHeader;
    }
    if (cachedPayment?.paymentSignature) {
      requestHeaders["payment-signature"] = cachedPayment.paymentSignature;
    }

    try {
      const response = await fetchImpl(url, {
        method,
        headers: requestHeaders,
        body: requestBody,
        signal,
      });

      if (response.status !== 402) {
        response.x402Meta = {
          paymentAttempted: sawPaymentChallenge,
          paymentAuthorized: Boolean(cachedPayment),
          authorizedPaymentReused: networkRetriesUsed > 0 && Boolean(cachedPayment),
          networkRetriesUsed,
          idempotencyKey,
          helper: "local-fallback",
        };
        return response;
      }

      sawPaymentChallenge = true;
      const paymentRequired = readHeader(response, "payment-required");
      if (!paymentRequired) {
        throw createHttpError("Received HTTP 402 without PAYMENT-REQUIRED header", {
          status: 402,
          idempotencyKey,
        });
      }
      if (typeof pay !== "function") {
        throw createHttpError("HTTP 402 requires a caller-supplied pay callback", {
          status: 402,
          idempotencyKey,
          paymentRequired,
        });
      }
      if (cachedPayment) {
        throw createHttpError("Paid retry received HTTP 402 after payment authorization", {
          status: 402,
          idempotencyKey,
          paymentRequired,
          paymentAttempted: sawPaymentChallenge,
        });
      }
      cachedPayment = normalizePayResult(await pay(paymentRequired, {
        url,
        method,
        headers: requestHeaders,
        body: requestBody,
        idempotencyKey,
      }));
    } catch (error) {
      if (typeof error?.status === "number") throw error;
      if (!cachedPayment) throw error;
      if (networkRetriesUsed >= maxNetworkRetries) {
        throw createNetworkError(`Network error after payment authorization was prepared: ${error.message}`, {
          cause: error,
          idempotencyKey,
          paymentAttempted: sawPaymentChallenge,
          authorizedPaymentReused: true,
          networkRetriesUsed,
        });
      }
      networkRetriesUsed += 1;
    }
  }
}

async function x402Fetch(url, options = {}) {
  const preferred = await importPreferredX402Fetch();
  if (!preferred) return localX402Fetch(url, options);
  const normalized = normalizeRequestForX402(options);
  const response = await preferred(url, normalized);
  response.x402Meta = {
    paymentAttempted: Boolean(readHeader(response, "payment-receipt") || readHeader(response, "payment-response")),
    paymentAuthorized: Boolean(readHeader(response, "payment-response")),
    authorizedPaymentReused: false,
    networkRetriesUsed: 0,
    idempotencyKey: normalized.idempotencyKey ?? null,
    helper: "agoragentic/x402-client",
  };
  return response;
}

function parseMaybeStructuredHeader(value) {
  if (!value || typeof value !== "string") return null;
  for (const candidate of [value, Buffer.from(value, "base64").toString("utf8")]) {
    try {
      const parsed = JSON.parse(candidate);
      if (parsed && typeof parsed === "object") return parsed;
    } catch {
      // Try the next representation.
    }
  }
  return null;
}

function extractReceiptIdFromHeader(value) {
  if (!value) return null;
  const parsed = parseMaybeStructuredHeader(value);
  if (parsed) {
    return parsed.receipt_id
      ?? parsed.receiptId
      ?? parsed.id
      ?? parsed.receipt?.receipt_id
      ?? parsed.receipt?.receiptId
      ?? parsed.receipt?.id
      ?? null;
  }
  return value;
}

function extractReceiptReference(payload, response) {
  const paymentReceipt = readHeader(response, "payment-receipt");
  return payload?.receipt_id
    ?? payload?.receipt?.receipt_id
    ?? payload?.receipt?.id
    ?? payload?.receipt?.receiptId
    ?? payload?.receiptId
    ?? extractReceiptIdFromHeader(paymentReceipt)
    ?? readHeader(response, "x-receipt-id")
    ?? null;
}

function extractSettlementHint(payload, response) {
  return payload?.receipt?.settlement_status
    ?? payload?.receipt?.settlement
    ?? payload?.settlement_status
    ?? payload?.settlement
    ?? readHeader(response, "payment-response")
    ?? null;
}

export function buildReceiptChecklist({ response, payload, quoteId, idempotencyKey, paymentAttempted }) {
  const receiptId = extractReceiptReference(payload, response);
  const paymentReceipt = readHeader(response, "payment-receipt");
  const paymentResponse = readHeader(response, "payment-response");
  const invocationId = payload?.invocation_id ?? payload?.invocationId ?? null;
  const cost = payload?.cost ?? payload?.price ?? payload?.price_usdc ?? null;
  const settlement = extractSettlementHint(payload, response);

  return {
    quoteId,
    idempotencyKey,
    responseStatus: response.status,
    paymentAttempted,
    receiptId,
    invocationId,
    settlement,
    checks: [
      { item: "http_ok", status: response.ok ? "pass" : "fail", evidence: `HTTP ${response.status}` },
      { item: "idempotency_key_present", status: idempotencyKey ? "pass" : "fail", evidence: idempotencyKey || "missing" },
      { item: "receipt_reference", status: receiptId ? "pass" : "warn", evidence: receiptId || "missing" },
      {
        item: "payment_receipt_header",
        status: paymentAttempted ? (paymentReceipt ? "pass" : "warn") : "skip",
        evidence: paymentAttempted ? (paymentReceipt || "missing") : "no x402 challenge observed",
      },
      {
        item: "payment_response_header",
        status: paymentAttempted ? (paymentResponse ? "pass" : "warn") : "skip",
        evidence: paymentAttempted ? (paymentResponse || "missing") : "no x402 challenge observed",
      },
      { item: "invocation_reference", status: invocationId ? "pass" : "warn", evidence: invocationId || "missing" },
      { item: "price_visibility", status: cost === null ? "warn" : "pass", evidence: cost === null ? "missing" : String(cost) },
      {
        item: "settlement_hint",
        status: settlement ? "pass" : "warn",
        evidence: settlement || "missing",
      },
    ],
    uncertainty: [
      "This checklist only inspects buyer-visible HTTP evidence.",
      "A Payment-Receipt header is transport evidence, not independent chain settlement proof.",
      "Use the marketplace receipt or proof endpoint separately when terminal verification is required.",
    ],
  };
}

export function classifyExecuteError(error) {
  if (!error) return { kind: "unknown", retryable: false, message: "Unknown execute error" };
  if (error.name === "NetworkError") {
    return {
      kind: "network_after_payment_authorized",
      retryable: true,
      message: error.message,
      idempotencyKey: error.idempotencyKey ?? null,
      guidance: "Retry the same execute() call with the same idempotency key and reuse the existing payment authorization.",
    };
  }
  if (error.name === "HttpError") {
    return {
      kind: "http_failure",
      retryable: Number(error.status) >= 500,
      status: error.status ?? null,
      message: error.message,
      guidance: error.status === 402
        ? "Provide an explicit pay callback gate before retrying a paid call."
        : "Inspect the HTTP payload before retrying.",
    };
  }
  return { kind: "unexpected", retryable: false, message: error.message };
}

export class X402ExecuteBuyer {
  constructor({ baseUrl = DEFAULT_BASE_URL, fetchImpl = globalThis.fetch, pay, headers = {}, maxNetworkRetries = 1 } = {}) {
    if (typeof fetchImpl !== "function") throw new Error("fetchImpl is required");
    this.baseUrl = baseUrl;
    this.fetchImpl = fetchImpl;
    this.pay = pay;
    this.headers = lowerCaseHeaders(headers);
    this.maxNetworkRetries = maxNetworkRetries;
  }

  async match(task, constraints = {}) {
    const response = await this.fetchImpl(buildUrl(this.baseUrl, MATCH_PATH, { task, ...constraints }), {
      method: "GET",
      headers: { accept: "application/json", ...this.headers },
    });
    const payload = await safeJson(response);
    if (!response.ok) {
      throw createHttpError(`Match failed with HTTP ${response.status}`, { status: response.status, payload });
    }
    return payload;
  }

  async execute(task, input = {}, options = {}) {
    const pay = options.pay ?? this.pay;
    const idempotencyKey = options.idempotencyKey ?? randomUUID();
    let quoteId = options.quoteId ?? null;
    let matchPayload = null;

    if (!quoteId) {
      matchPayload = await this.match(task, options.constraints || {});
      quoteId = matchPayload?.quote_id ?? matchPayload?.quote?.quote_id ?? null;
      if (!quoteId) throw new Error("match() did not return quote_id");
    }

    const response = await x402Fetch(buildUrl(this.baseUrl, EXECUTE_PATH), {
      fetchImpl: this.fetchImpl,
      pay,
      idempotencyKey,
      method: "POST",
      headers: this.headers,
      body: { quote_id: quoteId, input },
      signal: options.signal,
      maxNetworkRetries: options.maxNetworkRetries ?? this.maxNetworkRetries,
    });

    const payload = await safeJson(response);
    const paymentAttempted = Boolean(
      response?.x402Meta?.paymentAttempted
      || readHeader(response, "payment-receipt")
      || readHeader(response, "payment-response"),
    );

    if (!response.ok) {
      throw createHttpError(`Execute failed with HTTP ${response.status}`, {
        status: response.status,
        payload,
        idempotencyKey,
      });
    }

    return {
      task,
      quoteId,
      idempotencyKey,
      match: matchPayload,
      payload,
      x402: response.x402Meta || null,
      receiptChecklist: buildReceiptChecklist({
        response,
        payload,
        quoteId,
        idempotencyKey,
        paymentAttempted,
      }),
    };
  }
}

export async function executeForMcpTool({
  task,
  input = {},
  quoteId = null,
  constraints = {},
  baseUrl = DEFAULT_BASE_URL,
  fetchImpl = globalThis.fetch,
  pay,
  headers = {},
  maxNetworkRetries = 1,
  idempotencyKey = randomUUID(),
} = {}) {
  const buyer = new X402ExecuteBuyer({
    baseUrl,
    fetchImpl,
    pay,
    headers,
    maxNetworkRetries,
  });

  try {
    const execution = await buyer.execute(task, input, {
      quoteId,
      constraints,
      idempotencyKey,
    });

    return {
      ok: true,
      tool: "agoragentic_execute",
      task,
      idempotencyKey: execution.idempotencyKey,
      quoteId: execution.quoteId,
      payload: execution.payload,
      receiptChecklist: execution.receiptChecklist,
      x402: execution.x402,
      content: [
        {
          type: "text",
          text: JSON.stringify({
            ok: true,
            task,
            quoteId: execution.quoteId,
            idempotencyKey: execution.idempotencyKey,
            receiptChecklist: execution.receiptChecklist,
            payload: execution.payload,
          }, null, 2),
        },
      ],
    };
  } catch (error) {
    const classified = classifyExecuteError(error);
    const errorPayload = {
      ok: false,
      isError: true,
      task,
      idempotencyKey,
      error: classified,
    };
    return {
      ok: false,
      isError: true,
      tool: "agoragentic_execute",
      task,
      idempotencyKey,
      error: classified,
      content: [
        {
          type: "text",
          text: JSON.stringify(errorPayload, null, 2),
        },
      ],
    };
  }
}

function jsonResponse(status, body, headers = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", ...headers },
  });
}

function encodePaymentRequired(payload) {
  return Buffer.from(JSON.stringify(payload), "utf8").toString("base64");
}

export function createMockPaidFetch() {
  const state = {
    payCalls: 0,
    executeAttempts: 0,
    idempotencyKeys: [],
    authHeaders: [],
    paymentSignatures: [],
  };
  let dropOnceAfterAuthorization = true;

  async function fetchImpl(url, init = {}) {
    const target = new URL(typeof url === "string" ? url : url.toString());
    const method = String(init.method || "GET").toUpperCase();
    const headers = lowerCaseHeaders(init.headers || {});

    if (target.pathname === MATCH_PATH && method === "GET") {
      return jsonResponse(200, {
        quote_id: "quote_demo_paid_weather",
        match: { id: "listing_demo_paid_weather", name: "Weather Pro", price_usdc: 0.01 },
      });
    }

    if (target.pathname === EXECUTE_PATH && method === "POST") {
      state.executeAttempts += 1;
      state.idempotencyKeys.push(headers["idempotency-key"] ?? null);
      state.authHeaders.push(headers.authorization ?? null);
      state.paymentSignatures.push(headers["payment-signature"] ?? null);

      if (!headers.authorization && !headers["payment-signature"]) {
        return jsonResponse(402, {
          error: "payment_required",
          quote_id: "quote_demo_paid_weather",
        }, {
          "payment-required": encodePaymentRequired([{
            scheme: "exact",
            network: "base",
            maxAmountRequired: "10000",
            asset: "USDC",
          }]),
        });
      }

      if (dropOnceAfterAuthorization) {
        dropOnceAfterAuthorization = false;
        throw new Error("simulated connection reset after authorization");
      }

      return jsonResponse(200, {
        ok: true,
        invocation_id: "inv_demo_001",
        receipt_id: "rcpt_demo_001",
        cost: 0.01,
        settlement: "submitted",
        result: { forecast: "sunny", units: "metric" },
      }, {
        "payment-receipt": "rcpt_demo_001",
        "payment-response": "accepted",
      });
    }

    return jsonResponse(404, { error: "not_found", path: target.pathname });
  }

  return { fetchImpl, state };
}

async function demo() {
  const { fetchImpl, state } = createMockPaidFetch();

  const result = await executeForMcpTool({
    task: "weather",
    input: { city: "Lisbon" },
    baseUrl: "https://mock.agoragentic.test",
    fetchImpl,
    maxNetworkRetries: 2,
    async pay(paymentRequired, request) {
      state.payCalls += 1;
      const decoded = JSON.parse(Buffer.from(paymentRequired, "base64").toString("utf8"));
      assert.equal(Array.isArray(decoded), true);
      assert.equal(typeof request.idempotencyKey, "string");
      return {
        authorizationHeader: `X402 demo authorization for ${request.idempotencyKey}`,
      };
    },
  });

  assert.equal(result.ok, true);
  assert.equal(state.payCalls, 1, "payment authorization should be created once");
  assert.equal(state.executeAttempts, 3, "expected initial 402, one network drop, then successful retry");
  assert.equal(new Set(state.idempotencyKeys).size, 1, "same idempotency key must be reused across retries");
  assert.equal(state.authHeaders[1], state.authHeaders[2], "same authorization must be reused after network failure");
  assert.equal(result.receiptChecklist.receiptId, "rcpt_demo_001");
  assert.equal(result.receiptChecklist.checks.find((x) => x.item === "payment_receipt_header").status, "pass");
  assert.equal(result.x402.networkRetriesUsed, 1);
  assert.equal(result.receiptChecklist.settlement, "submitted");

  const explicitIdempotencyHeaders = [];
  await localX402Fetch("https://mock.agoragentic.test/api/x402/execute", {
    fetchImpl: async (url, init = {}) => {
      explicitIdempotencyHeaders.push(lowerCaseHeaders(init.headers || {}));
      return jsonResponse(200, { ok: true, receipt_id: "rcpt_explicit_idem" });
    },
    idempotencyKey: "explicit-idempotency-key",
    headers: { "Idempotency-Key": "stale-caller-key" },
    body: { ok: true },
  });
  assert.equal(
    explicitIdempotencyHeaders[0]["idempotency-key"],
    "explicit-idempotency-key",
    "explicit idempotencyKey option must not be overridden by caller headers",
  );

  let repeated402PayCalls = 0;
  let repeated402Attempts = 0;
  await assert.rejects(
    () =>
      localX402Fetch("https://mock.agoragentic.test/api/x402/execute", {
        fetchImpl: async () => {
          repeated402Attempts += 1;
          return jsonResponse(402, { error: "payment_required" }, {
            "payment-required": encodePaymentRequired([{ scheme: "exact", network: "base" }]),
          });
        },
        idempotencyKey: "repeated-402-idempotency-key",
        pay: async () => {
          repeated402PayCalls += 1;
          return { authorizationHeader: "rejected-demo-authorization" };
        },
      }),
    /Paid retry received HTTP 402/,
  );
  assert.equal(repeated402PayCalls, 1, "a second paid 402 must not call pay again");
  assert.equal(repeated402Attempts, 2, "the helper should stop after the rejected paid retry");

  const nestedReceiptChecklist = buildReceiptChecklist({
    response: jsonResponse(200, { ok: true }),
    payload: {
      invocation_id: "inv_nested",
      receipt: { receipt_id: "rcpt_nested" },
    },
    quoteId: "quote_nested",
    idempotencyKey: "nested-idempotency-key",
    paymentAttempted: false,
  });
  assert.equal(nestedReceiptChecklist.receiptId, "rcpt_nested");

  const encodedReceiptHeader = Buffer.from(JSON.stringify({ receipt_id: "rcpt_header_structured" }), "utf8").toString("base64");
  const headerReceiptChecklist = buildReceiptChecklist({
    response: jsonResponse(200, { ok: true }, { "payment-receipt": encodedReceiptHeader }),
    payload: { invocation_id: "inv_header" },
    quoteId: "quote_header",
    idempotencyKey: "header-idempotency-key",
    paymentAttempted: true,
  });
  assert.equal(headerReceiptChecklist.receiptId, "rcpt_header_structured");

  const failureToolResult = await executeForMcpTool({
    task: "weather",
    input: { city: "Lisbon" },
    baseUrl: "https://mock.agoragentic.test",
    fetchImpl: async () => jsonResponse(500, { error: "match_failed" }),
    pay: async () => ({ authorizationHeader: "unused" }),
  });
  assert.equal(failureToolResult.ok, false);
  assert.equal(failureToolResult.isError, true, "MCP failure results must set isError");

  console.log(JSON.stringify({
    demo: "x402 execute receipt checklist",
    helper: result.x402.helper,
    idempotencyKey: result.idempotencyKey,
    quoteId: result.quoteId,
    receiptChecklist: result.receiptChecklist,
    payload: result.payload,
    assertions: "passed",
  }, null, 2));
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  demo().catch((error) => {
    console.error(JSON.stringify({ error: error.message, classified: classifyExecuteError(error) }, null, 2));
    process.exitCode = 1;
  });
}
