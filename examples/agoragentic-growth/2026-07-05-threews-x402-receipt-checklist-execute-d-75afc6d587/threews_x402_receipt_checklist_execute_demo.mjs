// demo — moves no real funds
import assert from "node:assert/strict";
import crypto from "node:crypto";
import { pathToFileURL } from "node:url";

const DEFAULT_ENDPOINT = "https://api.three.ws/v1/execute";

function makeIdempotencyKey(prefix = "threews") {
  return `${prefix}_${crypto.randomUUID()}`;
}

function lowerCaseHeaders(headers = {}) {
  const out = {};
  for (const [key, value] of Object.entries(headers || {})) {
    if (value === undefined || value === null) continue;
    out[String(key).toLowerCase()] = String(value);
  }
  return out;
}

function normalizeHeaders(response) {
  if (!response?.headers) return {};
  if (typeof response.headers.entries === "function") {
    return Object.fromEntries(
      Array.from(response.headers.entries()).map(([key, value]) => [String(key).toLowerCase(), String(value)]),
    );
  }
  return lowerCaseHeaders(response.headers);
}

function firstPresent(...values) {
  for (const value of values) {
    if (value !== undefined && value !== null && value !== "") return value;
  }
  return null;
}

function safeJsonParse(text, fallback = {}) {
  if (!text) return fallback;
  try {
    return JSON.parse(text);
  } catch {
    return fallback;
  }
}

function readHeader(source, name) {
  if (!source) return null;
  if (typeof source.get === "function") {
    return source.get(name) ?? source.get(String(name).toLowerCase()) ?? null;
  }
  const headers = source.headers ? normalizeHeaders(source) : lowerCaseHeaders(source);
  return headers[String(name).toLowerCase()] ?? null;
}

function readFirstHeader(source, names) {
  for (const name of names) {
    const value = readHeader(source, name);
    if (value) return value;
  }
  return null;
}

function parsePaymentRequiredHeader(headerValue) {
  if (!headerValue) return null;
  const raw = String(headerValue).trim();
  const candidates = [raw];
  try {
    candidates.push(Buffer.from(raw, "base64").toString("utf8"));
  } catch {
    // Ignore non-base64 challenge values.
  }

  for (const candidate of candidates) {
    const parsed = safeJsonParse(candidate, null);
    if (parsed && typeof parsed === "object") return parsed;
  }
  return null;
}

function validatePaymentChallenge(challenge) {
  if (!challenge || typeof challenge !== "object") {
    throw createHttpError("invalid payment-required challenge", { status: 402, kind: "payment_required_challenge_invalid" });
  }
  const amount = firstPresent(challenge.max_amount_usdc, challenge.maxAmountRequired, challenge.amount, challenge.price);
  const hasDestination = Boolean(firstPresent(challenge.pay_to, challenge.payTo, challenge.recipient, challenge.address));
  if (!firstPresent(challenge.network, challenge.chain) || !firstPresent(challenge.asset, challenge.token) || amount === null || !hasDestination) {
    throw createHttpError("invalid payment-required challenge: missing network, asset, amount, or payee", {
      status: 402,
      kind: "payment_required_challenge_invalid",
      challenge,
    });
  }
  return challenge;
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

export function classifyX402Error(error) {
  const status = error?.status ?? error?.response?.status ?? null;
  const kind = error?.kind ?? (status ? "http_after_authorization" : "network_after_authorization");
  const retryableStatus = [429, 500, 502, 503, 504].includes(Number(status));
  return {
    kind,
    status,
    retryable: error?.retryable !== undefined ? Boolean(error.retryable) : kind === "network_after_authorization" || retryableStatus,
    message: error?.message ?? String(error),
  };
}

export async function x402Fetch(url, options = {}) {
  const {
    fetchImpl,
    pay,
    idempotencyKey,
    method = "POST",
    headers = {},
    body,
    maxNetworkRetries = 1,
  } = options;

  if (typeof fetchImpl !== "function") throw new Error("fetchImpl is required");
  const requestBody = body === undefined || body === null || typeof body === "string" ? body : JSON.stringify(body);
  const baseHeaders = {
    "content-type": "application/json",
    ...lowerCaseHeaders(headers),
    "idempotency-key": idempotencyKey,
  };

  let cachedPayment = null;
  let challengeFingerprint = null;
  let networkRetriesUsed = 0;

  while (true) {
    const requestHeaders = { ...baseHeaders };
    if (cachedPayment?.authorizationHeader) {
      if (requestHeaders.authorization) {
        requestHeaders["payment-signature"] ??= cachedPayment.authorizationHeader;
      } else {
        requestHeaders.authorization = cachedPayment.authorizationHeader;
      }
    }
    if (cachedPayment?.paymentSignature) {
      requestHeaders["payment-signature"] = cachedPayment.paymentSignature;
    }

    try {
      const response = await fetchImpl(url, {
        method,
        headers: requestHeaders,
        body: requestBody,
      });

      if (response.status !== 402) {
        response.x402Meta = {
          paymentAttempted: Boolean(cachedPayment),
          paymentAuthorized: Boolean(cachedPayment),
          challengeFingerprint,
          networkRetriesUsed,
          idempotencyKey,
          helper: "inline-local-fallback",
        };
        return response;
      }

      const paymentRequired = readFirstHeader(response, [
        "payment-required",
        "x-payment-required",
        "x-payment-challenge",
      ]);
      if (!paymentRequired) {
        throw createHttpError("Received HTTP 402 without payment-required header", {
          status: 402,
          kind: "payment_required_challenge_missing",
          idempotencyKey,
        });
      }
      if (cachedPayment) {
        throw createHttpError("paid request was rejected with another HTTP 402; refusing to re-authorize payment or replay cached authorization", {
          status: 402,
          kind: "paid_request_rejected",
          idempotencyKey,
          paymentAttempted: true,
        });
      }
      if (typeof pay !== "function") {
        throw createHttpError("HTTP 402 requires a caller-supplied pay callback", {
          status: 402,
          kind: "payment_required_without_pay_callback",
          idempotencyKey,
        });
      }

      const challenge = validatePaymentChallenge(parsePaymentRequiredHeader(paymentRequired));
      challengeFingerprint = crypto
        .createHash("sha256")
        .update(JSON.stringify(challenge))
        .digest("hex");
      cachedPayment = normalizePayResult(await pay(paymentRequired, {
        challenge,
        challengeFingerprint,
        idempotencyKey,
        url: String(url),
        method,
        headers: requestHeaders,
        body: requestBody,
      }));
    } catch (error) {
      if (error?.status || error?.kind) throw error;
      if (!cachedPayment) throw error;
      if (networkRetriesUsed >= maxNetworkRetries) {
        throw createNetworkError(`Network error after payment authorization was prepared: ${error.message}`, {
          cause: error,
          idempotencyKey,
          paymentAttempted: true,
          authorizedPaymentReused: true,
          networkRetriesUsed,
        });
      }
      networkRetriesUsed += 1;
    }
  }
}

export function validateX402Receipt({ response, payload, quoteId, idempotencyKey }) {
  const headers = normalizeHeaders(response);
  const receipt = canonicalReceipt(payload, headers);
  const checks = [
    {
      item: "receipt_reference_present",
      status: receipt.receiptId || receipt.paymentReceiptHeader ? "pass" : "fail",
      evidence: JSON.stringify({ receiptId: receipt.receiptId, paymentReceiptHeader: receipt.paymentReceiptHeader }),
    },
    {
      item: "quote_matches_expected",
      status: !quoteId || !receipt.quoteId || receipt.quoteId === quoteId ? "pass" : "fail",
      evidence: JSON.stringify({ expected: quoteId ?? null, observed: receipt.quoteId ?? null }),
    },
    {
      item: "idempotency_key_present",
      status: idempotencyKey ? "pass" : "fail",
      evidence: idempotencyKey || "missing",
    },
  ];
  return {
    ok: checks.every((check) => check.status !== "fail"),
    checks,
    receipt,
  };
}

async function readJsonResponse(response) {
  const text = await response.text();
  return {
    text,
    json: safeJsonParse(text, {}),
  };
}

function summarizeChecks(checks) {
  return {
    total: checks.length,
    passed: checks.filter((entry) => entry.status === "pass").length,
    warnings: checks.filter((entry) => entry.status === "warn").length,
    failed: checks.filter((entry) => entry.status === "fail").length,
  };
}

function canonicalReceipt(payload = {}, headers = {}) {
  const receipt = payload.receipt || payload.result?.receipt || {};
  return {
    provider: firstPresent(payload.provider, receipt.provider),
    receiptId: firstPresent(payload.receipt_id, payload.receiptId, receipt.receipt_id, receipt.id),
    receiptUrl: firstPresent(payload.receipt_url, payload.receiptUrl, receipt.url),
    invocationId: firstPresent(payload.invocation_id, payload.invocationId, receipt.invocation_id),
    requestId: firstPresent(payload.request_id, payload.requestId, receipt.request_id),
    quoteId: firstPresent(payload.quote_id, payload.quoteId, receipt.quote_id),
    amountUsdc: firstPresent(payload.amount_usdc, payload.amount, payload.cost, receipt.amount_usdc),
    settlementState: firstPresent(payload.settlement_state, payload.settlement, receipt.settlement_state, receipt.settlement),
    paymentReceiptHeader: firstPresent(headers["payment-receipt"], headers["x-payment-receipt"], headers["x-receipt-id"]),
    paymentResponseHeader: firstPresent(headers["payment-response"], headers["x-payment-response"]),
  };
}

export function buildThreeWSReceiptChecklist({
  response,
  payload,
  idempotencyKey,
  endpoint,
  transportStats,
} = {}) {
  const headers = normalizeHeaders(response);
  const receipt = canonicalReceipt(payload, headers);
  const uniqueIdempotencyKeys = [...new Set(transportStats?.idempotencyKeysSeen || [])].filter(Boolean);
  const uniqueAuthorizationHeaders = [...new Set(transportStats?.authorizationHeadersSeen || [])].filter(Boolean);
  const checks = [
    {
      item: "http_ok",
      status: response?.ok ? "pass" : "fail",
      evidence: `HTTP ${response?.status ?? "unknown"}`,
    },
    {
      item: "idempotency_key_present",
      status: idempotencyKey ? "pass" : "fail",
      evidence: idempotencyKey || "missing",
    },
    {
      item: "idempotency_key_reused_on_retry",
      status: uniqueIdempotencyKeys.length === 1 && uniqueIdempotencyKeys[0] === idempotencyKey ? "pass" : "fail",
      evidence: JSON.stringify(uniqueIdempotencyKeys),
    },
    {
      item: "paid_once_on_402",
      status: transportStats?.payCalls === 1 ? "pass" : "fail",
      evidence: JSON.stringify({
        payCalls: transportStats?.payCalls ?? null,
        executeAttempts: transportStats?.executeAttempts ?? null,
      }),
    },
    {
      item: "authorization_reused_after_network_retry",
      status: uniqueAuthorizationHeaders.length === 1 && (transportStats?.executeAttempts ?? 0) >= 3 ? "pass" : "warn",
      evidence: JSON.stringify({
        authorizationHeadersSeen: transportStats?.authorizationHeadersSeen ?? [],
        executeAttempts: transportStats?.executeAttempts ?? 0,
      }),
    },
    {
      item: "receipt_reference_present",
      status: receipt.receiptId || receipt.paymentReceiptHeader ? "pass" : "fail",
      evidence: JSON.stringify({
        receiptId: receipt.receiptId,
        paymentReceiptHeader: receipt.paymentReceiptHeader,
      }),
    },
    {
      item: "invocation_reference_present",
      status: receipt.invocationId ? "pass" : "warn",
      evidence: receipt.invocationId || "missing",
    },
    {
      item: "amount_visible",
      status: receipt.amountUsdc !== null ? "pass" : "warn",
      evidence: receipt.amountUsdc !== null ? String(receipt.amountUsdc) : "missing",
    },
    {
      item: "settlement_state_not_overclaimed",
      status: ["submitted", "pending", "processing", null].includes(receipt.settlementState) ? "pass" : "warn",
      evidence: receipt.settlementState || "missing",
    },
    {
      item: "endpoint_recorded",
      status: endpoint ? "pass" : "warn",
      evidence: endpoint || "missing",
    },
  ];

  return {
    ok: checks.every((entry) => entry.status !== "fail"),
    summary: summarizeChecks(checks),
    checks,
    receipt,
    uncertainty: [
      "This checklist validates buyer-visible transport evidence only.",
      "Payment-Receipt and receipt_id prove the server returned a receipt reference, not final chain settlement.",
      "Treat settlement_state as informational until verified against a receipt or proof endpoint.",
    ],
  };
}

export function reconcileThreeWSReceipt({
  payload,
  response,
  endpoint,
  idempotencyKey,
  transportStats,
  expectedQuoteId,
} = {}) {
  const headers = normalizeHeaders(response);
  const receipt = canonicalReceipt(payload, headers);
  const validation = validateX402Receipt({
    response,
    payload,
    quoteId: expectedQuoteId,
    idempotencyKey,
  });
  const checklist = buildThreeWSReceiptChecklist({
    response,
    payload,
    idempotencyKey,
    endpoint,
    transportStats,
  });

  return {
    receipt,
    validation,
    checklist,
    reconciliation: {
      matchedReceiptReference: Boolean(receipt.receiptId || receipt.paymentReceiptHeader),
      matchedQuoteId: expectedQuoteId ? receipt.quoteId === expectedQuoteId : Boolean(receipt.quoteId),
      matchedInvocationId: Boolean(receipt.invocationId),
      transportReceiptHeader: receipt.paymentReceiptHeader,
    },
  };
}

export async function executeThreeWSBuyerCall({
  endpoint = DEFAULT_ENDPOINT,
  payload,
  pay,
  fetchImpl = globalThis.fetch,
  idempotencyKey = makeIdempotencyKey(),
  headers = {},
  transportStats,
  expectedQuoteId = firstPresent(payload?.quote_id, payload?.quoteId),
} = {}) {
  if (!payload || typeof payload !== "object") {
    throw new Error("payload is required");
  }
  if (typeof fetchImpl !== "function") {
    throw new Error("fetchImpl is required");
  }

  let response;
  try {
    response = await x402Fetch(endpoint, {
      fetchImpl,
      pay,
      idempotencyKey,
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...lowerCaseHeaders(headers),
      },
      body: payload,
      maxNetworkRetries: 1,
    });
  } catch (error) {
    const classified = classifyX402Error(error);
    classified.idempotencyKey = classified.idempotencyKey || idempotencyKey;
    throw classified;
  }

  const body = await readJsonResponse(response);
  if (!response.ok) {
    const failure = {
      kind: "http_failure",
      retryable: response.status >= 500,
      status: response.status,
      idempotencyKey,
      payload: body.json,
      message: `three.ws execute failed with HTTP ${response.status}`,
    };
    throw failure;
  }

  const finalTransportStats = typeof transportStats === "function" ? transportStats() : transportStats;
  const receiptReport = reconcileThreeWSReceipt({
    payload: body.json,
    response,
    endpoint,
    idempotencyKey,
    transportStats: finalTransportStats,
    expectedQuoteId,
  });

  return {
    ok: true,
    endpoint,
    idempotencyKey,
    payload: body.json,
    x402: response.x402Meta || {},
    ...receiptReport,
  };
}

class SimpleHeaders {
  constructor(init = {}) {
    this.map = new Map();
    for (const [key, value] of Object.entries(init || {})) {
      this.map.set(String(key).toLowerCase(), String(value));
    }
  }

  get(name) {
    return this.map.get(String(name).toLowerCase()) ?? null;
  }

  entries() {
    return this.map.entries();
  }
}

class SimpleResponse {
  constructor(status, headers = {}, body = undefined) {
    this.status = status;
    this.ok = status >= 200 && status < 300;
    this.headers = new SimpleHeaders(headers);
    this._body = body;
  }

  async text() {
    if (this._body === undefined || this._body === null) return "";
    return typeof this._body === "string" ? this._body : JSON.stringify(this._body);
  }
}

export function createMockThreeWSTransport() {
  const state = {
    payCalls: 0,
    executeAttempts: 0,
    idempotencyKeysSeen: [],
    authorizationHeadersSeen: [],
    paymentSignaturesSeen: [],
    firstAuthorizedAttemptDrops: true,
  };

  async function fetchImpl(url, init = {}) {
    const endpoint = typeof url === "string" ? url : url.toString();
    const headers = lowerCaseHeaders(init.headers || {});
    const method = String(init.method || "GET").toUpperCase();

    if (endpoint !== DEFAULT_ENDPOINT || method !== "POST") {
      return new SimpleResponse(404, { "content-type": "application/json" }, {
        error: "not_found",
        endpoint,
        method,
      });
    }

    state.executeAttempts += 1;
    state.idempotencyKeysSeen.push(headers["idempotency-key"] || null);
    if (headers.authorization) state.authorizationHeadersSeen.push(headers.authorization);
    if (headers["payment-signature"]) state.paymentSignaturesSeen.push(headers["payment-signature"]);

    if (!headers.authorization && !headers["payment-signature"]) {
      return new SimpleResponse(402, {
        "PAYMENT-REQUIRED": JSON.stringify({
          type: "x402",
          network: "base",
          asset: "USDC",
          max_amount_usdc: "0.03",
          pay_to: "demo:three.ws",
        }),
      }, {
        error: "payment_required",
        provider: "three.ws",
        quote_id: "quote_threews_demo_001",
        amount_usdc: "0.03",
      });
    }

    if (state.firstAuthorizedAttemptDrops) {
      state.firstAuthorizedAttemptDrops = false;
      throw new Error("simulated network drop after payment authorization");
    }

    return new SimpleResponse(200, {
      "content-type": "application/json",
      "Payment-Receipt": "receipt_threews_demo_001",
      "PAYMENT-RESPONSE": "accepted",
    }, {
      provider: "three.ws",
      status: "completed",
      quote_id: "quote_threews_demo_001",
      request_id: "req_threews_demo_001",
      invocation_id: "inv_threews_demo_001",
      receipt_id: "receipt_threews_demo_001",
      receipt_url: "https://api.three.ws/v1/receipts/receipt_threews_demo_001",
      amount_usdc: "0.03",
      settlement_state: "submitted",
      result: {
        summary: "three.ws accepted the buyer request",
        echoed_input: safeJsonParse(init.body, {}),
      },
    });
  }

  async function pay(paymentRequiredHeader, request) {
    state.payCalls += 1;
    const parsed = validatePaymentChallenge(parsePaymentRequiredHeader(paymentRequiredHeader));
    const authSuffix = crypto
      .createHash("sha256")
      .update(request.challengeFingerprint)
      .digest("hex")
      .slice(0, 16);

    return {
      authorizationHeader: `X402 demo-authorization ${authSuffix}`,
      paymentSignature: `demo-signature-${authSuffix}`,
      receipt: {
        demo: true,
        note: "No wallet, on-chain settlement, or funds movement.",
        challenge: parsed,
      },
    };
  }

  return {
    fetchImpl,
    pay,
    stats() {
      return {
        payCalls: state.payCalls,
        executeAttempts: state.executeAttempts,
        idempotencyKeysSeen: [...state.idempotencyKeysSeen],
        authorizationHeadersSeen: [...state.authorizationHeadersSeen],
        paymentSignaturesSeen: [...state.paymentSignaturesSeen],
      };
    },
  };
}

export async function selfTest() {
  const transport = createMockThreeWSTransport();
  const result = await executeThreeWSBuyerCall({
    endpoint: DEFAULT_ENDPOINT,
    payload: {
      task: "threews.render.preview",
      quote_id: "quote_threews_demo_001",
      input: {
        prompt: "Render a product hero image with a matte ceramic mug.",
      },
    },
    fetchImpl: transport.fetchImpl,
    pay: transport.pay,
    idempotencyKey: "demo-threews-idem-001",
    transportStats: transport.stats,
    expectedQuoteId: "quote_threews_demo_001",
  });

  const finalStats = transport.stats();
  assert.equal(result.ok, true);
  assert.equal(result.checklist.ok, true);
  assert.equal(result.validation.ok, true);
  assert.equal(result.reconciliation.matchedReceiptReference, true);
  assert.equal(finalStats.payCalls, 1);
  assert.equal(finalStats.executeAttempts, 3);
  assert.deepEqual([...new Set(finalStats.idempotencyKeysSeen)], ["demo-threews-idem-001"]);
  assert.equal(new Set(finalStats.authorizationHeadersSeen).size, 1);
  return { result, finalStats };
}

async function runDemo() {
  const transport = createMockThreeWSTransport();
  const idempotencyKey = "demo-threews-idem-001";
  const result = await executeThreeWSBuyerCall({
    endpoint: DEFAULT_ENDPOINT,
    payload: {
      task: "threews.render.preview",
      quote_id: "quote_threews_demo_001",
      input: {
        prompt: "Render a product hero image with a matte ceramic mug.",
      },
    },
    fetchImpl: transport.fetchImpl,
    pay: transport.pay,
    idempotencyKey,
    transportStats: transport.stats,
    expectedQuoteId: "quote_threews_demo_001",
  });

  const output = {
    endpoint: result.endpoint,
    idempotencyKey: result.idempotencyKey,
    x402: result.x402,
    checklist: buildThreeWSReceiptChecklist({
      response: {
        ok: true,
        status: 200,
        headers: new SimpleHeaders({
          "Payment-Receipt": result.receipt.paymentReceiptHeader,
          "PAYMENT-RESPONSE": result.receipt.paymentResponseHeader,
        }),
      },
      payload: result.payload,
      idempotencyKey,
      endpoint: DEFAULT_ENDPOINT,
      transportStats: transport.stats(),
    }),
    receipt: result.receipt,
    transport: transport.stats(),
  };

  console.log(JSON.stringify(output, null, 2));
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  runDemo().catch((error) => {
    console.error(JSON.stringify({ error }, null, 2));
    process.exitCode = 1;
  });
}
