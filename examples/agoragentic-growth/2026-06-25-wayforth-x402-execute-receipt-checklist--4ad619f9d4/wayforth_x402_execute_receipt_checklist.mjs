#!/usr/bin/env node
// demo — moves no real funds

import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";

const DEFAULT_BASE_URL = process.env.AGORAGENTIC_URL || "https://agoragentic.com";
const MATCH_PATH = "/api/x402/execute/match";
const EXECUTE_PATH = "/api/x402/execute";

function lowerCaseHeaders(input = {}) {
  if (input instanceof Headers) {
    return Object.fromEntries(Array.from(input.entries(), ([key, value]) => [String(key).toLowerCase(), value]));
  }
  return Object.fromEntries(Object.entries(input).map(([key, value]) => [String(key).toLowerCase(), value]));
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
  const candidates = [
    "agoragentic/x402-client",
    "../lib/x402-client.mjs",
    "./lib/x402-client.mjs",
  ];

  for (const candidate of candidates) {
    try {
      const mod = await import(candidate);
      if (typeof mod.x402Fetch === "function") {
        return { helper: mod.x402Fetch, source: candidate };
      }
    } catch {
      // try next candidate
    }
  }

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
    const requestHeaders = {
      ...baseHeaders,
      accept: "application/json",
      "idempotency-key": idempotencyKey,
    };

    let requestBody = body;
    if (requestBody !== undefined && requestBody !== null && typeof requestBody !== "string") {
      requestBody = JSON.stringify(requestBody);
      if (!requestHeaders["content-type"]) {
        requestHeaders["content-type"] = "application/json";
      }
    }

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
          helper: "local-fallback",
          paymentAttempted: sawPaymentChallenge,
          paymentAuthorized: Boolean(cachedPayment),
          authorizedPaymentReused: Boolean(cachedPayment),
          networkRetriesUsed,
          idempotencyKey,
        };
        return response;
      }

      sawPaymentChallenge = true;
      if (cachedPayment) {
        throw createHttpError("Paid retry was rejected with HTTP 402; refusing to reuse a rejected authorization", {
          status: 402,
          idempotencyKey,
          paymentAttempted: true,
          authorizedPaymentReused: true,
        });
      }
      const paymentRequired = readHeader(response, "payment-required");
      if (!paymentRequired) {
        throw createHttpError("Received HTTP 402 without payment-required header", {
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
      if (!cachedPayment) {
        cachedPayment = normalizePayResult(await pay(paymentRequired, {
          url,
          method,
          headers: requestHeaders,
          body: requestBody,
          idempotencyKey,
        }));
      }
    } catch (error) {
      if (typeof error?.status === "number") {
        throw error;
      }
      if (!cachedPayment) {
        throw error;
      }
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
  if (!preferred) {
    return localX402Fetch(url, options);
  }

  const response = await preferred.helper(url, options);
  const helperMeta = response.x402Meta || {};
  response.x402Meta = {
    ...helperMeta,
    helper: preferred.source,
    paymentAttempted: helperMeta.paymentAttempted ?? Boolean(readHeader(response, "payment-receipt") || readHeader(response, "payment-response")),
    paymentAuthorized: helperMeta.paymentAuthorized ?? Boolean(readHeader(response, "payment-response") || readHeader(response, "payment-receipt")),
    authorizedPaymentReused: helperMeta.authorizedPaymentReused ?? true,
    networkRetriesUsed: helperMeta.networkRetriesUsed ?? 0,
    idempotencyKey: options.idempotencyKey ?? null,
  };
  return response;
}

function extractReceiptReference(payload, response) {
  return payload?.receipt_id
    ?? payload?.receipt?.id
    ?? payload?.receipt?.receipt_id
    ?? payload?.receipt?.receiptId
    ?? readHeader(response, "payment-receipt")
    ?? null;
}

export function buildReceiptChecklist({ response, payload, quoteId, idempotencyKey, paymentAttempted, integration }) {
  const receiptId = extractReceiptReference(payload, response);
  const paymentReceipt = readHeader(response, "payment-receipt");
  const paymentResponse = readHeader(response, "payment-response");
  const invocationId = payload?.invocation_id ?? payload?.invocationId ?? null;
  const cost = payload?.cost ?? payload?.price ?? payload?.price_usdc ?? null;
  const returnedQuoteId = payload?.quote_id ?? payload?.quoteId ?? payload?.receipt?.quote_id ?? payload?.receipt?.quoteId ?? null;
  const quoteMatches = !returnedQuoteId || !quoteId || returnedQuoteId === quoteId;

  return {
    integration,
    quoteId,
    idempotencyKey,
    responseStatus: response.status,
    paymentAttempted,
    receiptId,
    invocationId,
    checks: [
      { item: "http_ok", status: response.ok ? "pass" : "fail", evidence: `HTTP ${response.status}` },
      { item: "idempotency_key_present", status: idempotencyKey ? "pass" : "fail", evidence: idempotencyKey || "missing" },
      { item: "receipt_reference", status: receiptId ? "pass" : "warn", evidence: receiptId || "missing" },
      { item: "quote_binding", status: quoteMatches ? "pass" : "fail", evidence: returnedQuoteId ? `${returnedQuoteId} vs ${quoteId || "missing"}` : "no returned quote id" },
      { item: "payment_receipt_header", status: paymentAttempted ? (paymentReceipt ? "pass" : "warn") : "skip", evidence: paymentAttempted ? (paymentReceipt || "missing") : "no x402 challenge observed" },
      { item: "payment_response_header", status: paymentAttempted ? (paymentResponse ? "pass" : "warn") : "skip", evidence: paymentAttempted ? (paymentResponse || "missing") : "no x402 challenge observed" },
      { item: "invocation_reference", status: invocationId ? "pass" : "warn", evidence: invocationId || "missing" },
      { item: "price_visibility", status: cost === null ? "warn" : "pass", evidence: cost === null ? "missing" : String(cost) },
      { item: "wayforth_buyer_flow", status: integration?.seller === "WayforthOfficial" && integration?.buyer === "wayforth" ? "pass" : "warn", evidence: `${integration?.seller || "unknown"}/${integration?.buyer || "unknown"}` },
    ],
    uncertainty: [
      "This checklist only inspects buyer-visible HTTP evidence.",
      "A payment-receipt header is transport evidence, not independent chain settlement proof.",
      "Check the marketplace receipt or proof endpoint separately when terminal verification is required.",
    ],
  };
}

export function classifyExecuteError(error) {
  if (!error) {
    return { kind: "unknown", retryable: false, message: "Unknown execute error" };
  }
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

export class WayforthX402ExecuteBuyer {
  constructor({
    baseUrl = DEFAULT_BASE_URL,
    fetchImpl = globalThis.fetch,
    pay,
    headers = {},
    maxNetworkRetries = 1,
    seller = "WayforthOfficial",
    buyer = "wayforth",
    task = "WayforthOfficial/wayforth/execute",
  } = {}) {
    if (typeof fetchImpl !== "function") {
      throw new Error("fetchImpl is required");
    }
    this.baseUrl = baseUrl;
    this.fetchImpl = fetchImpl;
    this.pay = pay;
    this.headers = lowerCaseHeaders(headers);
    this.maxNetworkRetries = maxNetworkRetries;
    this.integration = { seller, buyer, task };
  }

  async match(constraints = {}) {
    const response = await this.fetchImpl(buildUrl(this.baseUrl, MATCH_PATH, {
      ...constraints,
      task: this.integration.task,
      seller: this.integration.seller,
      buyer: this.integration.buyer,
    }), {
      method: "GET",
      headers: { accept: "application/json", ...this.headers },
    });
    const payload = await safeJson(response);
    if (!response.ok) {
      throw createHttpError(`Match failed with HTTP ${response.status}`, { status: response.status, payload });
    }
    return payload;
  }

  async execute(input = {}, options = {}) {
    const pay = options.pay ?? this.pay;
    const idempotencyKey = options.idempotencyKey ?? randomUUID();
    let quoteId = options.quoteId ?? null;
    let matchPayload = null;

    if (!quoteId) {
      matchPayload = await this.match(options.constraints || {});
      quoteId = matchPayload?.quote_id ?? matchPayload?.quote?.quote_id ?? null;
      if (!quoteId) {
        throw new Error("match() did not return quote_id");
      }
    }

    const executePayload = {
      quote_id: quoteId,
      input: {
        ...input,
        integration: this.integration,
      },
    };

    const response = await x402Fetch(buildUrl(this.baseUrl, EXECUTE_PATH), {
      fetchImpl: this.fetchImpl,
      pay,
      idempotencyKey,
      method: "POST",
      headers: this.headers,
      body: executePayload,
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
    const returnedQuoteId = payload?.quote_id ?? payload?.quoteId ?? payload?.receipt?.quote_id ?? payload?.receipt?.quoteId ?? null;
    if (returnedQuoteId && returnedQuoteId !== quoteId) {
      throw createHttpError("Execute response quote_id did not match requested quote_id", {
        status: response.status,
        payload,
        idempotencyKey,
        requestedQuoteId: quoteId,
        returnedQuoteId,
      });
    }

    return {
      integration: this.integration,
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
        integration: this.integration,
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

export function createMockWayforthPaidFetch() {
  const state = {
    payCalls: 0,
    executeAttempts: 0,
    matchQueries: [],
    idempotencyKeys: [],
    authHeaders: [],
    paymentSignatures: [],
    executeBodies: [],
  };
  let dropOnceAfterAuthorization = true;

  async function fetchImpl(url, init = {}) {
    const target = new URL(typeof url === "string" ? url : url.toString());
    const method = String(init.method || "GET").toUpperCase();
    const headers = lowerCaseHeaders(init.headers || {});

    if (target.pathname === MATCH_PATH && method === "GET") {
      state.matchQueries.push(Object.fromEntries(target.searchParams.entries()));
      return jsonResponse(200, {
        quote_id: "quote_wayforth_demo_001",
        match: {
          id: "listing_wayforth_docs_001",
          seller: "WayforthOfficial",
          buyer: "wayforth",
          price_usdc: 0.015,
        },
      });
    }

    if (target.pathname === EXECUTE_PATH && method === "POST") {
      state.executeAttempts += 1;
      state.executeBodies.push(init.body ? JSON.parse(init.body) : null);
      state.idempotencyKeys.push(headers["idempotency-key"] ?? null);
      state.authHeaders.push(headers.authorization ?? null);
      state.paymentSignatures.push(headers["payment-signature"] ?? null);

      if (!headers.authorization && !headers["payment-signature"]) {
        return jsonResponse(402, {
          error: "payment_required",
          quote_id: "quote_wayforth_demo_001",
        }, {
          "payment-required": encodePaymentRequired([{ scheme: "exact", network: "base", maxAmountRequired: "15000", asset: "USDC" }]),
        });
      }

      if (dropOnceAfterAuthorization) {
        dropOnceAfterAuthorization = false;
        throw new Error("simulated connection reset after authorization");
      }

      return jsonResponse(200, {
        ok: true,
        invocation_id: "inv_wayforth_demo_001",
        receipt_id: "rcpt_wayforth_demo_001",
        cost: 0.015,
        result: {
          provider: "WayforthOfficial",
          buyer: "wayforth",
          checklist_status: "ready",
        },
      }, {
        "payment-receipt": "rcpt_wayforth_demo_001",
        "payment-response": "accepted",
      });
    }

    return jsonResponse(404, { error: "not_found", path: target.pathname });
  }

  return { fetchImpl, state };
}

async function demo() {
  const { fetchImpl, state } = createMockWayforthPaidFetch();
  const buyer = new WayforthX402ExecuteBuyer({
    baseUrl: "https://mock.agoragentic.test",
    fetchImpl,
    headers: { "Idempotency-Key": "caller-stale-key" },
    maxNetworkRetries: 2,
    async pay(paymentRequired, request) {
      state.payCalls += 1;
      const decoded = JSON.parse(Buffer.from(paymentRequired, "base64").toString("utf8"));
      assert.equal(Array.isArray(decoded), true);
      assert.equal(typeof request.idempotencyKey, "string");
      return {
        authorizationHeader: `X402 demo authorization for ${request.idempotencyKey}`,
        paymentSignature: `demo-signature:${request.idempotencyKey}`,
      };
    },
  });

  const result = await buyer.execute({
    action: "fetch-checklist",
    listing_id: "listing_wayforth_docs_001",
    integration: { seller: "attacker", buyer: "spoof" },
  }, {
    constraints: { task: "attacker/task", seller: "attacker", buyer: "spoof" },
  });

  assert.equal(state.payCalls, 1, "payment authorization should be created once");
  assert.equal(state.executeAttempts, 3, "expected initial 402, one network drop, then successful retry");
  assert.equal(new Set(state.idempotencyKeys).size, 1, "same idempotency key must be reused across retries");
  assert.equal(state.idempotencyKeys[0], result.idempotencyKey, "caller idempotency header must not override tracked key");
  assert.equal(state.matchQueries[0].task, buyer.integration.task, "match task must not be overridden");
  assert.equal(state.matchQueries[0].seller, buyer.integration.seller, "match seller must not be overridden");
  assert.equal(state.matchQueries[0].buyer, buyer.integration.buyer, "match buyer must not be overridden");
  assert.equal(state.authHeaders[1], state.authHeaders[2], "same authorization must be reused after network failure");
  assert.deepEqual(state.executeBodies[0].input.integration, buyer.integration, "Wayforth routing fields must not be overridden");
  assert.equal(result.receiptChecklist.receiptId, "rcpt_wayforth_demo_001");
  assert.equal(result.receiptChecklist.checks.find((entry) => entry.item === "quote_binding").status, "pass");
  assert.equal(result.receiptChecklist.checks.find((entry) => entry.item === "payment_receipt_header").status, "pass");
  assert.equal(result.x402.networkRetriesUsed, 1);

  const nestedReceiptChecklist = buildReceiptChecklist({
    response: jsonResponse(200, { ok: true }),
    payload: { receipt: { receipt_id: "rcpt_nested_snake_case" } },
    quoteId: "quote_wayforth_demo_001",
    idempotencyKey: "idem_nested",
    paymentAttempted: false,
    integration: buyer.integration,
  });
  assert.equal(nestedReceiptChecklist.receiptId, "rcpt_nested_snake_case", "nested receipt.receipt_id must be recognized");

  const mismatchedQuoteChecklist = buildReceiptChecklist({
    response: jsonResponse(200, { ok: true }),
    payload: { quote_id: "quote_other", receipt_id: "rcpt_other" },
    quoteId: "quote_wayforth_demo_001",
    idempotencyKey: "idem_mismatch",
    paymentAttempted: true,
    integration: buyer.integration,
  });
  assert.equal(mismatchedQuoteChecklist.checks.find((entry) => entry.item === "quote_binding").status, "fail");

  let rejectedPayCalls = 0;
  let rejectedAttempts = 0;
  await assert.rejects(
    localX402Fetch(buildUrl("https://mock.agoragentic.test", EXECUTE_PATH), {
      fetchImpl: async (_url, init = {}) => {
        rejectedAttempts += 1;
        const headers = lowerCaseHeaders(init.headers || {});
        return jsonResponse(402, { error: "payment_required" }, {
          "payment-required": encodePaymentRequired([{ scheme: "exact", network: "base", maxAmountRequired: "15000", asset: "USDC" }]),
          ...(headers.authorization ? { "payment-response": "rejected" } : {}),
        });
      },
      method: "POST",
      body: { quote_id: "quote_wayforth_demo_001", input: { action: "reject-after-payment" } },
      idempotencyKey: "idem_rejected_paid_402",
      async pay() {
        rejectedPayCalls += 1;
        return { authorizationHeader: "X402 rejected demo authorization" };
      },
    }),
    /Paid retry was rejected/
  );
  assert.equal(rejectedPayCalls, 1, "rejected paid 402 must not call pay again");
  assert.equal(rejectedAttempts, 2, "rejected paid 402 must stop after one paid retry");

  console.log(JSON.stringify({
    demo: "wayforth x402 execute receipt checklist",
    helper: result.x402.helper,
    integration: result.integration,
    idempotencyKey: result.idempotencyKey,
    quoteId: result.quoteId,
    receiptChecklist: result.receiptChecklist,
    payload: result.payload,
    assertions: "passed",
  }, null, 2));
}

if (import.meta.url === `file://${process.argv[1]}`) {
  demo().catch((error) => {
    console.error(JSON.stringify({ error: error.message, classified: classifyExecuteError(error) }, null, 2));
    process.exitCode = 1;
  });
}
