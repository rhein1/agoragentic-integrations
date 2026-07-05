#!/usr/bin/env node
// demo — moves no real funds

import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import http from "node:http";

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

function encodeStructuredValue(value) {
  return Buffer.from(JSON.stringify(value), "utf8").toString("base64");
}

function decodeStructuredValue(value) {
  if (!value || typeof value !== "string") return null;
  const candidates = [value.trim()];
  try {
    candidates.push(Buffer.from(value.trim(), "base64").toString("utf8"));
  } catch {}
  for (const candidate of candidates) {
    try {
      return JSON.parse(candidate);
    } catch {}
  }
  return null;
}

function parsePaymentRequired(raw) {
  const decoded = decodeStructuredValue(raw);
  if (Array.isArray(decoded)) return decoded;
  if (decoded && Array.isArray(decoded.challenges)) return decoded.challenges;
  return [];
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
  for (const specifier of ["agoragentic/x402-client", "../lib/x402-client.mjs", "./lib/x402-client.mjs"]) {
    try {
      const mod = await import(specifier);
      if (typeof mod.x402Fetch === "function") {
        return { fn: mod.x402Fetch, source: specifier };
      }
    } catch {}
  }
  return null;
}

async function inlineX402Fetch(url, options = {}) {
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
  let lastPaymentRequired = null;
  let networkRetriesUsed = 0;
  let sawPaymentChallenge = false;

  while (true) {
    const requestHeaders = {
      accept: "application/json",
      "idempotency-key": idempotencyKey,
      ...baseHeaders,
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
          helper: "inline-fallback",
          helperSource: "inline-fallback",
          idempotencyKey,
          networkRetriesUsed,
          paymentAttempted: sawPaymentChallenge,
          paymentAuthorized: Boolean(cachedPayment),
          paymentRequired: lastPaymentRequired,
          authorizedPaymentReused: networkRetriesUsed > 0,
        };
        return response;
      }

      sawPaymentChallenge = true;
      lastPaymentRequired = readHeader(response, "payment-required");
      if (!lastPaymentRequired) {
        throw createHttpError("Received HTTP 402 without payment-required header", {
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
          challenge: parsePaymentRequired(lastPaymentRequired)[0] ?? null,
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
          paymentRequired: lastPaymentRequired,
        });
      }
      networkRetriesUsed += 1;
    }
  }
}

async function x402Fetch(url, options = {}) {
  const preferred = await importPreferredX402Fetch();
  if (!preferred) {
    return inlineX402Fetch(url, options);
  }
  const response = await preferred.fn(url, options);
  response.x402Meta = {
    helper: preferred.source,
    helperSource: preferred.source,
    idempotencyKey: options.idempotencyKey ?? null,
    networkRetriesUsed: 0,
    paymentAttempted: Boolean(readHeader(response, "payment-receipt") || readHeader(response, "payment-response")),
    paymentAuthorized: Boolean(readHeader(response, "payment-response")),
    paymentRequired: null,
    authorizedPaymentReused: null,
  };
  return response;
}

function buildReceiptChecklist({ response, payload, quoteId, idempotencyKey, paymentRequiredRaw = null, paymentAttempted = false }) {
  const challenge = parsePaymentRequired(paymentRequiredRaw)[0] ?? null;
  const paymentReceipt = readHeader(response, "payment-receipt");
  const paymentResponse = decodeStructuredValue(readHeader(response, "payment-response"));
  const receipt = payload?.receipt ?? null;
  const receiptId = payload?.receipt_id ?? receipt?.id ?? paymentReceipt ?? null;
  const invocationId = payload?.invocation_id ?? null;
  const echoedIdempotencyKey = receipt?.idempotency_key ?? paymentResponse?.idempotency_key ?? readHeader(response, "x-idempotency-key");
  const challengeId = challenge?.challengeId ?? challenge?.challenge_id ?? null;
  const receiptChallengeId = receipt?.challenge_id ?? null;
  const paymentAmount = paymentResponse?.maxAmountRequired ?? paymentResponse?.amount ?? null;
  const price = payload?.cost ?? payload?.price_usdc ?? payload?.price ?? null;

  return {
    quoteId,
    idempotencyKey,
    responseStatus: response.status,
    paymentAttempted,
    receiptId,
    invocationId,
    checks: [
      { item: "http_ok", status: response.ok ? "pass" : "fail", evidence: `HTTP ${response.status}` },
      { item: "idempotency_key_present", status: idempotencyKey ? "pass" : "fail", evidence: idempotencyKey || "missing" },
      { item: "idempotency_key_echo", status: echoedIdempotencyKey === idempotencyKey ? "pass" : "warn", evidence: echoedIdempotencyKey || "missing" },
      { item: "receipt_reference", status: receiptId ? "pass" : "warn", evidence: receiptId || "missing" },
      { item: "payment_receipt_header", status: paymentAttempted ? (paymentReceipt ? "pass" : "warn") : "skip", evidence: paymentAttempted ? (paymentReceipt || "missing") : "no x402 challenge observed" },
      { item: "payment_response_header", status: paymentAttempted ? (paymentResponse ? "pass" : "warn") : "skip", evidence: paymentAttempted ? JSON.stringify(paymentResponse) : "no x402 challenge observed" },
      { item: "receipt_matches_paid_challenge", status: paymentAttempted ? (challengeId && receiptChallengeId === challengeId ? "pass" : "warn") : "skip", evidence: paymentAttempted ? `${receiptChallengeId || "missing"} vs ${challengeId || "missing"}` : "no x402 challenge observed" },
      { item: "quoted_amount_visible", status: challenge?.maxAmountRequired || paymentAmount ? "pass" : "warn", evidence: `${challenge?.maxAmountRequired || "missing"} vs ${paymentAmount || "missing"}` },
      { item: "invocation_reference", status: invocationId ? "pass" : "warn", evidence: invocationId || "missing" },
      { item: "price_visibility", status: price === null ? "warn" : "pass", evidence: price === null ? "missing" : String(price) },
    ],
    uncertainty: [
      "This checklist only inspects buyer-visible HTTP evidence plus echoed receipt fields.",
      "A payment-receipt header is transport evidence, not independent chain settlement proof.",
      "Verify terminal settlement separately if the marketplace exposes a proof or receipt endpoint.",
    ],
  };
}

function classifyExecuteError(error) {
  if (!error) {
    return { kind: "unknown", retryable: false, message: "Unknown execute error" };
  }
  if (error.name === "NetworkError") {
    return {
      kind: "network_after_payment_authorized",
      retryable: true,
      message: error.message,
      idempotencyKey: error.idempotencyKey ?? null,
      guidance: "Retry with the same idempotency key and reuse the existing payment authorization.",
    };
  }
  if (error.name === "HttpError") {
    return {
      kind: "http_failure",
      retryable: Number(error.status) >= 500,
      status: error.status ?? null,
      message: error.message,
    };
  }
  return { kind: "unexpected", retryable: false, message: error.message };
}

class McpX402ExecuteBuyer {
  constructor({ baseUrl = DEFAULT_BASE_URL, fetchImpl = globalThis.fetch, pay, headers = {}, maxNetworkRetries = 1 } = {}) {
    if (typeof fetchImpl !== "function") {
      throw new Error("fetchImpl is required");
    }
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
      throw createHttpError(`match() failed with HTTP ${response.status}`, { status: response.status, payload });
    }
    return payload;
  }

  async execute({ task, server, tool, arguments: toolArguments = {}, quoteId = null, idempotencyKey = randomUUID(), constraints = {}, signal } = {}) {
    if (!task) throw new Error("task is required");
    if (!server) throw new Error("server is required");
    if (!tool) throw new Error("tool is required");

    let matchPayload = null;
    let effectiveQuoteId = quoteId;
    if (!effectiveQuoteId) {
      matchPayload = await this.match(task, constraints);
      effectiveQuoteId = matchPayload?.quote_id ?? matchPayload?.quote?.quote_id ?? null;
      if (!effectiveQuoteId) {
        throw new Error("match() did not return quote_id");
      }
    }

    const requestBody = {
      quote_id: effectiveQuoteId,
      input: {
        transport: "mcp",
        server,
        tool,
        arguments: toolArguments,
      },
    };

    const response = await x402Fetch(buildUrl(this.baseUrl, EXECUTE_PATH), {
      fetchImpl: this.fetchImpl,
      pay: this.pay,
      idempotencyKey,
      method: "POST",
      headers: this.headers,
      body: requestBody,
      signal,
      maxNetworkRetries: this.maxNetworkRetries,
    });

    const payload = await safeJson(response);
    if (!response.ok) {
      throw createHttpError(`execute() failed with HTTP ${response.status}`, {
        status: response.status,
        payload,
        idempotencyKey,
      });
    }

    const paymentAttempted = Boolean(
      response?.x402Meta?.paymentAttempted ||
      readHeader(response, "payment-receipt") ||
      readHeader(response, "payment-response")
    );

    return {
      task,
      quoteId: effectiveQuoteId,
      idempotencyKey,
      match: matchPayload,
      payload,
      x402: response.x402Meta || null,
      receiptChecklist: buildReceiptChecklist({
        response,
        payload,
        quoteId: effectiveQuoteId,
        idempotencyKey,
        paymentAttempted,
        paymentRequiredRaw: response?.x402Meta?.paymentRequired ?? null,
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

async function readRequestJson(req) {
  const chunks = [];
  for await (const chunk of req) {
    chunks.push(chunk);
  }
  return chunks.length ? JSON.parse(Buffer.concat(chunks).toString("utf8")) : null;
}

async function createMockMcpExecuteServer() {
  const state = {
    quoteId: "quote_mcp_weather_demo",
    challengeId: `challenge_${randomUUID()}`,
    payCalls: 0,
    matchCalls: 0,
    executeAttempts: 0,
    idempotencyKeys: [],
    authorizationHeaders: [],
    authorizedDropInjected: false,
  };

  const paymentChallenge = [{
    scheme: "exact",
    network: "base-sepolia",
    asset: "USDC",
    maxAmountRequired: "10000",
    challengeId: state.challengeId,
    memo: "demo only; no real funds move",
  }];

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, "http://127.0.0.1");
    const headers = lowerCaseHeaders(req.headers);

    if (req.method === "GET" && url.pathname === MATCH_PATH) {
      state.matchCalls += 1;
      return sendJson(res, 200, {
        quote_id: state.quoteId,
        match: {
          task: url.searchParams.get("task") || "demo.mcp.weather.lookup",
          listing_id: "listing_mcp_weather_demo",
          provider: "mcp/demo-weather",
          price_usdc: 0.01,
        },
      });
    }

    if (req.method === "POST" && url.pathname === EXECUTE_PATH) {
      state.executeAttempts += 1;
      state.idempotencyKeys.push(headers["idempotency-key"] ?? null);
      state.authorizationHeaders.push(headers.authorization ?? null);
      const body = await readRequestJson(req);

      if (!headers.authorization) {
        return sendJson(res, 402, {
          error: "payment_required",
          quote_id: body?.quote_id ?? state.quoteId,
        }, {
          "payment-required": encodeStructuredValue(paymentChallenge),
          "x-challenge-id": state.challengeId,
        });
      }

      if (!state.authorizedDropInjected) {
        state.authorizedDropInjected = true;
        req.socket.destroy(new Error("simulated connection drop after payment authorization"));
        return;
      }

      const receiptId = `rcpt_${stableHash(headers.authorization)}`;
      const paymentResponse = {
        challenge_id: state.challengeId,
        quote_id: body?.quote_id ?? state.quoteId,
        idempotency_key: headers["idempotency-key"] ?? null,
        maxAmountRequired: "10000",
        asset: "USDC",
        network: "base-sepolia",
        authorization_fingerprint: stableHash(headers.authorization),
        status: "accepted_by_demo_server",
      };

      return sendJson(res, 200, {
        ok: true,
        invocation_id: `inv_${stableHash(JSON.stringify(body))}`,
        receipt_id: receiptId,
        cost: 0.01,
        result: {
          transport: "mcp",
          server: body?.input?.server,
          tool: body?.input?.tool,
          content: [{ type: "text", text: `forecast for ${body?.input?.arguments?.city || "unknown"}: sunny` }],
        },
        receipt: {
          id: receiptId,
          challenge_id: state.challengeId,
          idempotency_key: headers["idempotency-key"] ?? null,
          authorization_fingerprint: stableHash(headers.authorization),
        },
        payment: paymentResponse,
      }, {
        "payment-receipt": receiptId,
        "payment-response": encodeStructuredValue(paymentResponse),
        "x-idempotency-key": headers["idempotency-key"] ?? "",
      });
    }

    return sendJson(res, 404, { error: "not_found", path: url.pathname });
  });

  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();

  return {
    baseUrl: `http://127.0.0.1:${address.port}`,
    state,
    async close() {
      await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    },
  };
}

async function demo() {
  const mock = await createMockMcpExecuteServer();
  try {
    const buyer = new McpX402ExecuteBuyer({
      baseUrl: mock.baseUrl,
      maxNetworkRetries: 2,
      async pay(paymentRequired, request) {
        mock.state.payCalls += 1;
        const challenge = parsePaymentRequired(paymentRequired)[0] ?? null;
        assert.equal(challenge.challengeId, mock.state.challengeId);
        assert.equal(typeof request.idempotencyKey, "string");
        return {
          authorizationHeader: `X402 demo authorization ${challenge.challengeId} ${request.idempotencyKey}`,
        };
      },
    });

    const result = await buyer.execute({
      task: "demo.mcp.weather.lookup",
      server: "mcp/demo-weather",
      tool: "weather.lookup",
      arguments: { city: "Lisbon", units: "metric" },
    });

    assert.equal(mock.state.matchCalls, 1);
    assert.equal(mock.state.payCalls, 1);
    assert.equal(mock.state.executeAttempts, 3);
    assert.equal(new Set(mock.state.idempotencyKeys).size, 1);
    assert.equal(mock.state.authorizationHeaders[1], mock.state.authorizationHeaders[2]);
    assert.equal(result.receiptChecklist.checks.find((check) => check.item === "receipt_matches_paid_challenge").status, "pass");
    assert.equal(result.x402.networkRetriesUsed, 1);
    assert.equal(result.payload.result.server, "mcp/demo-weather");
    assert.equal(result.payload.result.tool, "weather.lookup");

    console.log(JSON.stringify({
      demo: "mcp x402 execute receipt checklist",
      helper: result.x402.helper,
      helperSource: result.x402.helperSource,
      quoteId: result.quoteId,
      idempotencyKey: result.idempotencyKey,
      receiptChecklist: result.receiptChecklist,
      payload: result.payload,
      assertions: "passed",
    }, null, 2));
  } finally {
    await mock.close();
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  demo().catch((error) => {
    console.error(JSON.stringify({
      error: error.message,
      classified: classifyExecuteError(error),
    }, null, 2));
    process.exitCode = 1;
  });
}

export {
  McpX402ExecuteBuyer,
  buildReceiptChecklist,
  classifyExecuteError,
  createMockMcpExecuteServer,
  parsePaymentRequired,
  x402Fetch,
};
