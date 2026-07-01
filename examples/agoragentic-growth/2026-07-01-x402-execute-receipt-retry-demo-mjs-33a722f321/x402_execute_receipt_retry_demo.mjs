#!/usr/bin/env node
// demo — moves no real funds

import assert from "node:assert/strict";
import { randomUUID, createHash } from "node:crypto";
import http from "node:http";

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

function stableHash(value) {
  return createHash("sha256").update(String(value)).digest("hex").slice(0, 16);
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
  let networkRetriesUsed = 0;
  let lastPaymentRequired = null;

  while (true) {
    const requestHeaders = {
      accept: "application/json",
      "idempotency-key": idempotencyKey,
      ...baseHeaders,
    };

    let requestBody = body;
    if (requestBody !== undefined && requestBody !== null && typeof requestBody !== "string") {
      requestBody = JSON.stringify(requestBody);
      if (!requestHeaders["content-type"]) requestHeaders["content-type"] = "application/json";
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
          idempotencyKey,
          networkRetriesUsed,
          paymentAuthorized: Boolean(cachedPayment),
          paymentAttempted: Boolean(lastPaymentRequired),
          paymentRequired: lastPaymentRequired,
        };
        return response;
      }

      lastPaymentRequired = readHeader(response, "payment-required");
      if (!lastPaymentRequired) {
        throw createHttpError("Received HTTP 402 without PAYMENT-REQUIRED header", {
          status: 402,
          idempotencyKey,
        });
      }
      if (typeof pay !== "function") {
        throw createHttpError("HTTP 402 requires a caller-supplied pay callback", {
          status: 402,
          idempotencyKey,
          paymentRequired: lastPaymentRequired,
        });
      }
      if (!cachedPayment) {
        cachedPayment = normalizePayResult(await pay(lastPaymentRequired, {
          url,
          method,
          headers: requestHeaders,
          body: requestBody,
          idempotencyKey,
        }));
      }
    } catch (error) {
      if (typeof error?.status === "number") throw error;
      if (!cachedPayment) throw error;
      if (networkRetriesUsed >= maxNetworkRetries) {
        throw createNetworkError(`Network error after payment authorization was prepared: ${error.message}`, {
          cause: error,
          idempotencyKey,
          paymentAttempted: true,
          authorizedPaymentReused: true,
          networkRetriesUsed,
          paymentRequired: lastPaymentRequired,
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
    helper: "agoragentic/x402-client",
    idempotencyKey: options.idempotencyKey ?? null,
    networkRetriesUsed: 0,
    paymentAuthorized: Boolean(readHeader(response, "payment-response")),
    paymentAttempted: Boolean(readHeader(response, "payment-receipt") || readHeader(response, "payment-response")),
    paymentRequired: null,
  };
  return response;
}

function decodePaymentRequired(encoded) {
  if (!encoded) return null;
  try {
    return JSON.parse(Buffer.from(encoded, "base64").toString("utf8"));
  } catch {
    return null;
  }
}

function extractReceiptReference(payload, response) {
  return payload?.receipt_id
    ?? payload?.receipt?.id
    ?? readHeader(response, "payment-receipt")
    ?? null;
}

export function buildReceiptChecklist({ response, payload, quoteId, idempotencyKey, paymentAttempted, paymentRequired }) {
  const receiptId = extractReceiptReference(payload, response);
  const paymentReceipt = readHeader(response, "payment-receipt");
  const paymentResponse = readHeader(response, "payment-response");
  const invocationId = payload?.invocation_id ?? payload?.invocationId ?? null;
  const cost = payload?.cost ?? payload?.price ?? payload?.price_usdc ?? null;
  const receipt = payload?.receipt ?? null;
  const decodedPaymentRequired = decodePaymentRequired(paymentRequired);
  const paidChallenge = Array.isArray(decodedPaymentRequired) ? decodedPaymentRequired[0] : decodedPaymentRequired;
  const challengeId = paidChallenge?.challengeId ?? null;
  const receiptChallengeId = receipt?.challenge_id ?? null;
  const echoedIdempotencyKey = receipt?.idempotency_key ?? readHeader(response, "x-idempotency-key");

  return {
    quoteId,
    idempotencyKey,
    responseStatus: response.status,
    paymentAttempted,
    receiptId,
    invocationId,
    challengeId,
    checks: [
      { item: "http_ok", status: response.ok ? "pass" : "fail", evidence: `HTTP ${response.status}` },
      { item: "idempotency_key_present", status: idempotencyKey ? "pass" : "fail", evidence: idempotencyKey || "missing" },
      { item: "idempotency_key_echo", status: echoedIdempotencyKey === idempotencyKey ? "pass" : "warn", evidence: echoedIdempotencyKey || "missing" },
      { item: "receipt_reference", status: receiptId ? "pass" : "warn", evidence: receiptId || "missing" },
      { item: "payment_receipt_header", status: paymentAttempted ? (paymentReceipt ? "pass" : "warn") : "skip", evidence: paymentAttempted ? (paymentReceipt || "missing") : "no x402 challenge observed" },
      { item: "payment_response_header", status: paymentAttempted ? (paymentResponse ? "pass" : "warn") : "skip", evidence: paymentAttempted ? (paymentResponse || "missing") : "no x402 challenge observed" },
      { item: "receipt_matches_paid_challenge", status: paymentAttempted ? (challengeId && receiptChallengeId === challengeId ? "pass" : "warn") : "skip", evidence: paymentAttempted ? `${receiptChallengeId || "missing"} vs ${challengeId || "missing"}` : "no x402 challenge observed" },
      { item: "invocation_reference", status: invocationId ? "pass" : "warn", evidence: invocationId || "missing" },
      { item: "price_visibility", status: cost === null ? "warn" : "pass", evidence: cost === null ? "missing" : String(cost) },
    ],
    uncertainty: [
      "This checklist inspects buyer-visible HTTP evidence plus echoed receipt fields.",
      "A payment-receipt header is transport evidence, not independent chain settlement proof.",
      "Use a separate proof or receipt endpoint if you need terminal verification beyond the execute response.",
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
        paymentRequired: response?.x402Meta?.paymentRequired ?? null,
      }),
    };
  }
}

function sendJson(res, status, body, headers = {}) {
  const text = JSON.stringify(body);
  res.writeHead(status, {
    "content-type": "application/json",
    "content-length": Buffer.byteLength(text),
    ...headers,
  });
  res.end(text);
}

function encodePaymentRequired(payload) {
  return Buffer.from(JSON.stringify(payload), "utf8").toString("base64");
}

async function readRequestJson(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  if (chunks.length === 0) return null;
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

export async function createMockMcpServer() {
  const state = {
    payCalls: 0,
    matchCalls: 0,
    executeAttempts: 0,
    idempotencyKeys: [],
    authHeaders: [],
    challengeId: `challenge_${randomUUID()}`,
    quoteId: "quote_demo_paid_weather",
    authorizedDropInjected: false,
  };

  const paymentRequiredPayload = [{
    scheme: "exact",
    network: "base-sepolia",
    asset: "USDC",
    maxAmountRequired: "10000",
    challengeId: state.challengeId,
    settlement: "demo-only",
    note: "demo only; no funds move",
  }];
  const paymentRequired = encodePaymentRequired(paymentRequiredPayload);

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, "http://127.0.0.1");
    const headers = lowerCaseHeaders(req.headers);

    if (req.method === "GET" && url.pathname === MATCH_PATH) {
      state.matchCalls += 1;
      return sendJson(res, 200, {
        quote_id: state.quoteId,
        match: {
          id: "listing_demo_paid_weather",
          transport: "mock-mcp-server",
          tool: "weather.lookup",
          price_usdc: 0.01,
        },
      });
    }

    if (req.method === "POST" && url.pathname === EXECUTE_PATH) {
      state.executeAttempts += 1;
      state.idempotencyKeys.push(headers["idempotency-key"] ?? null);
      state.authHeaders.push(headers.authorization ?? null);
      const body = await readRequestJson(req);

      if (!headers.authorization) {
        return sendJson(res, 402, {
          error: "payment_required",
          quote_id: body?.quote_id ?? state.quoteId,
        }, {
          "payment-required": paymentRequired,
          "x-challenge-id": state.challengeId,
        });
      }

      if (!state.authorizedDropInjected) {
        state.authorizedDropInjected = true;
        req.socket.destroy(new Error("simulated connection reset after authorization"));
        return;
      }

      const receiptId = `rcpt_${stableHash(headers.authorization)}`;
      return sendJson(res, 200, {
        ok: true,
        invocation_id: `inv_${stableHash(body?.quote_id ?? state.quoteId)}`,
        receipt_id: receiptId,
        cost: 0.01,
        result: {
          server: "mock-mcp-server",
          tool: "weather.lookup",
          output: { city: body?.input?.city ?? "unknown", forecast: "sunny", units: "metric" },
        },
        receipt: {
          id: receiptId,
          challenge_id: state.challengeId,
          idempotency_key: headers["idempotency-key"] ?? null,
          authorization_fingerprint: stableHash(headers.authorization),
          status: "accepted_by_demo_server",
        },
      }, {
        "payment-receipt": receiptId,
        "payment-response": "accepted",
        "x-idempotency-key": headers["idempotency-key"] ?? "",
        "x-challenge-id": state.challengeId,
      });
    }

    return sendJson(res, 404, { error: "not_found", path: url.pathname });
  });

  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  const baseUrl = `http://127.0.0.1:${address.port}`;

  return {
    baseUrl,
    state,
    paymentRequired,
    async close() {
      await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    },
  };
}

async function demo() {
  const server = await createMockMcpServer();

  try {
    const buyer = new X402ExecuteBuyer({
      baseUrl: server.baseUrl,
      maxNetworkRetries: 2,
      async pay(paymentRequired, request) {
        server.state.payCalls += 1;
        const decoded = decodePaymentRequired(paymentRequired);
        assert.equal(Array.isArray(decoded), true);
        assert.equal(decoded[0].challengeId, server.state.challengeId);
        assert.equal(typeof request.idempotencyKey, "string");
        return {
          authorizationHeader: `X402 demo authorization ${decoded[0].challengeId} ${request.idempotencyKey}`,
        };
      },
    });

    const result = await buyer.execute("weather", { city: "Lisbon" });

    assert.equal(server.state.matchCalls, 1, "match() should be called once");
    assert.equal(server.state.payCalls, 1, "payment authorization should be created once");
    assert.equal(server.state.executeAttempts, 3, "expected 402 challenge, one dropped authorized request, then success");
    assert.equal(new Set(server.state.idempotencyKeys).size, 1, "same idempotency key must be reused across retries");
    assert.equal(server.state.authHeaders[1], server.state.authHeaders[2], "same authorization must be reused after network failure");
    assert.equal(result.receiptChecklist.receiptId, result.payload.receipt.id);
    assert.equal(result.receiptChecklist.checks.find((x) => x.item === "receipt_matches_paid_challenge").status, "pass");
    assert.equal(result.x402.networkRetriesUsed, 1);

    console.log(JSON.stringify({
      demo: "x402 execute receipt checklist with mock MCP server",
      helper: result.x402.helper,
      quoteId: result.quoteId,
      idempotencyKey: result.idempotencyKey,
      receiptChecklist: result.receiptChecklist,
      payload: result.payload,
      assertions: "passed",
    }, null, 2));
  } finally {
    await server.close();
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  demo().catch((error) => {
    console.error(JSON.stringify({ error: error.message, classified: classifyExecuteError(error) }, null, 2));
    process.exitCode = 1;
  });
}
