#!/usr/bin/env node
// demo — moves no real funds

import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { pathToFileURL } from "node:url";

const DEFAULT_BASE_URL = process.env.AGORAGENTIC_URL || "https://agoragentic.com";
const MATCH_PATH = "/api/x402/execute/match";
const EXECUTE_PATH = "/api/x402/execute";

function lowerCaseHeaders(input = {}) {
  if (input instanceof Headers) {
    return Object.fromEntries(Array.from(input.entries(), ([k, v]) => [String(k).toLowerCase(), v]));
  }
  return Object.fromEntries(Object.entries(input).map(([k, v]) => [String(k).toLowerCase(), v]));
}

function readHeader(source, name) {
  if (!source) return null;
  if (typeof source.get === "function") return source.get(name) ?? source.get(String(name).toLowerCase()) ?? null;
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

function normalizePayResult(payment) {
  if (!payment || typeof payment !== "object") {
    throw new Error("pay callback must return an object");
  }
  if (!payment.authorizationHeader && !payment.paymentSignature) {
    throw new Error("pay callback must return authorizationHeader or paymentSignature");
  }
  return payment;
}

function clonePaymentAuthorization(payment) {
  if (!payment) return null;
  return {
    authorizationHeader: payment.authorizationHeader ?? null,
    paymentSignature: payment.paymentSignature ?? null,
  };
}

function buildRequestHeaders(baseHeaders, idempotencyKey) {
  return {
    accept: "application/json",
    ...baseHeaders,
    "idempotency-key": idempotencyKey,
  };
}

function attachPaymentHeaders(requestHeaders, cachedPayment) {
  if (!cachedPayment) return;
  if (cachedPayment.paymentSignature) {
    requestHeaders["payment-signature"] = cachedPayment.paymentSignature;
    return;
  }
  if (cachedPayment.authorizationHeader && requestHeaders.authorization) {
    requestHeaders["payment-signature"] = cachedPayment.authorizationHeader;
    return;
  }
  if (cachedPayment.authorizationHeader) {
    requestHeaders.authorization = cachedPayment.authorizationHeader;
  }
}

function networkAfterPaymentError(error, { idempotencyKey, sawPaymentChallenge, networkRetriesUsed, cachedPayment }) {
  return createNetworkError(`Network error after payment authorization was prepared: ${error.message}`, {
    cause: error,
    idempotencyKey,
    paymentAttempted: sawPaymentChallenge,
    authorizedPaymentReused: true,
    networkRetriesUsed,
    paymentAuthorization: clonePaymentAuthorization(cachedPayment),
  });
}

async function importPreferredX402Fetch() {
  try {
    const mod = await import("agoragentic/x402-client");
    if (typeof mod.x402Fetch === "function") return mod.x402Fetch;
  } catch {}
  return null;
}

async function localX402Fetch(url, options = {}) {
  const {
    fetchImpl = globalThis.fetch,
    pay,
    idempotencyKey = randomUUID(),
    method = "GET",
    headers = {},
    body,
    signal,
    maxNetworkRetries = 1,
  } = options;

  if (typeof fetchImpl !== "function") {
    throw new Error("fetchImpl is required");
  }

  const baseHeaders = lowerCaseHeaders(headers);
  let cachedPayment = null;
  let sawPaymentChallenge = false;
  let networkRetriesUsed = 0;
  while (true) {
    const requestHeaders = buildRequestHeaders(baseHeaders, idempotencyKey);

    let requestBody = body;
    if (requestBody !== undefined && requestBody !== null && typeof requestBody !== "string") {
      requestBody = JSON.stringify(requestBody);
      if (!requestHeaders["content-type"]) requestHeaders["content-type"] = "application/json";
    }

    attachPaymentHeaders(requestHeaders, cachedPayment);

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
        throw createHttpError("paid request received another HTTP 402 challenge; refusing to re-authorize payment", {
          status: 402,
          idempotencyKey,
          paymentRequired,
          paymentAuthorization: clonePaymentAuthorization(cachedPayment),
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
        throw networkAfterPaymentError(error, {
          idempotencyKey,
          sawPaymentChallenge,
          networkRetriesUsed,
          cachedPayment,
        });
      }
      networkRetriesUsed += 1;
    }
  }
}

async function x402Fetch(url, options = {}) {
  const preferred = await importPreferredX402Fetch();
  if (!preferred) return localX402Fetch(url, options);
  const response = await preferred(url, options);
  response.x402Meta = {
    paymentAttempted: Boolean(readHeader(response, "payment-receipt") || readHeader(response, "payment-response")),
    paymentAuthorized: Boolean(readHeader(response, "payment-response")),
    networkRetriesUsed: 0,
    idempotencyKey: options.idempotencyKey ?? null,
    helper: "agoragentic/x402-client",
  };
  return response;
}

function extractReceiptReference(payload, response) {
  return payload?.receipt_id
    ?? payload?.receiptId
    ?? payload?.receipt?.receipt_id
    ?? payload?.receipt?.id
    ?? readHeader(response, "payment-receipt")
    ?? null;
}

function receiptQuoteBindingCheck(receiptQuoteId, quoteId) {
  if (!receiptQuoteId) {
    return { item: "receipt_quote_matches_execute_quote", status: "warn", evidence: "receipt quote_id missing" };
  }
  return {
    item: "receipt_quote_matches_execute_quote",
    status: receiptQuoteId === quoteId ? "pass" : "fail",
    evidence: `${receiptQuoteId} vs ${quoteId}`,
  };
}

function buildChecklistItems({ response, idempotencyKey, receiptId, paymentReceipt, paymentResponse, invocationId, receiptQuoteId, quoteId, cost, paymentAttempted }) {
  return [
    { item: "http_ok", status: response.ok ? "pass" : "fail", evidence: `HTTP ${response.status}` },
    { item: "idempotency_key_present", status: idempotencyKey ? "pass" : "fail", evidence: idempotencyKey || "missing" },
    { item: "receipt_reference", status: receiptId ? "pass" : "warn", evidence: receiptId || "missing" },
    { item: "payment_receipt_header", status: paymentAttempted ? (paymentReceipt ? "pass" : "warn") : "skip", evidence: paymentAttempted ? (paymentReceipt || "missing") : "no x402 challenge observed" },
    { item: "payment_response_header", status: paymentAttempted ? (paymentResponse ? "pass" : "warn") : "skip", evidence: paymentAttempted ? (paymentResponse || "missing") : "no x402 challenge observed" },
    { item: "invocation_reference", status: invocationId ? "pass" : "warn", evidence: invocationId || "missing" },
    receiptQuoteBindingCheck(receiptQuoteId, quoteId),
    { item: "price_visibility", status: cost === null ? "warn" : "pass", evidence: cost === null ? "missing" : String(cost) },
  ];
}

export function buildReceiptChecklist({ response, payload, quoteId, idempotencyKey, paymentAttempted }) {
  const receiptId = extractReceiptReference(payload, response);
  const paymentReceipt = readHeader(response, "payment-receipt");
  const paymentResponse = readHeader(response, "payment-response");
  const invocationId = payload?.invocation_id ?? payload?.invocationId ?? null;
  const cost = payload?.cost ?? payload?.price ?? payload?.price_usdc ?? null;
  const receiptQuoteId = payload?.quote_id ?? payload?.quoteId ?? payload?.receipt?.quote_id ?? payload?.receipt?.quoteId ?? null;

  return {
    quoteId,
    idempotencyKey,
    responseStatus: response.status,
    paymentAttempted,
    receiptId,
    invocationId,
    checks: buildChecklistItems({ response, idempotencyKey, receiptId, paymentReceipt, paymentResponse, invocationId, receiptQuoteId, quoteId, cost, paymentAttempted }),
    uncertainty: [
      "This checklist only inspects buyer-visible HTTP evidence.",
      "A payment-receipt header is transport evidence, not independent chain settlement proof.",
      "Check the marketplace receipt or proof endpoint separately when terminal verification is required.",
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
    const response = await this.fetchImpl(buildUrl(this.baseUrl, MATCH_PATH, { ...constraints, task }), {
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
      || readHeader(response, "payment-response")
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
          "payment-required": encodePaymentRequired([{ scheme: "exact", network: "base", maxAmountRequired: "10000", asset: "USDC" }]),
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
  const buyer = new X402ExecuteBuyer({
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

  const result = await buyer.execute("weather", { city: "Lisbon" });

  assert.equal(state.payCalls, 1, "payment authorization should be created once");
  assert.equal(state.executeAttempts, 3, "expected initial 402, one network drop, then successful retry");
  assert.equal(new Set(state.idempotencyKeys).size, 1, "same idempotency key must be reused across retries");
  assert.equal(state.authHeaders[1], state.authHeaders[2], "same authorization must be reused after network failure");
  assert.equal(result.receiptChecklist.receiptId, "rcpt_demo_001");
  assert.equal(result.receiptChecklist.checks.find((x) => x.item === "payment_receipt_header").status, "pass");
  assert.equal(result.x402.networkRetriesUsed, 1);

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
