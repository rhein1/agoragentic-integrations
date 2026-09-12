// demo pay callback in the self-test moves no real funds.
import crypto from "node:crypto";

const DEFAULT_BASE_URL = "https://agoragentic.com";
const MATCH_PATH = "/api/x402/execute/match";
const EXECUTE_PATH = "/api/x402/execute";

function stableId(prefix = "idem") {
  return `${prefix}_${crypto.randomUUID()}`;
}

function lowerCaseHeaders(headers = {}) {
  if (headers instanceof Headers || typeof headers.entries === "function") {
    return Object.fromEntries(Array.from(headers.entries()).map(([key, value]) => [String(key).toLowerCase(), String(value)]));
  }
  const out = {};
  for (const [key, value] of Object.entries(headers)) {
    if (value === undefined || value === null) continue;
    out[String(key).toLowerCase()] = String(value);
  }
  return out;
}

function buildUrl(baseUrl, path, params = {}) {
  const url = new URL(path, baseUrl.endsWith("/") ? baseUrl : `${baseUrl}/`);
  for (const [key, value] of Object.entries(params)) {
    if (value === undefined || value === null || value === "") continue;
    url.searchParams.set(key, String(value));
  }
  return url;
}

function safeJsonParse(text, fallback = {}) {
  if (!text) return fallback;
  try {
    return JSON.parse(text);
  } catch {
    return fallback;
  }
}

class SimpleHeaders {
  constructor(init = {}) {
    this.map = new Map();
    for (const [key, value] of Object.entries(init)) {
      this.set(key, value);
    }
  }

  get(name) {
    return this.map.get(String(name).toLowerCase()) ?? null;
  }

  set(name, value) {
    this.map.set(String(name).toLowerCase(), String(value));
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

  async json() {
    return safeJsonParse(await this.text(), {});
  }
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

function readHeader(response, name) {
  return response?.headers?.get?.(name)
    ?? response?.headers?.get?.(String(name).toLowerCase())
    ?? normalizeHeaders(response)[String(name).toLowerCase()]
    ?? null;
}

async function readJsonResponse(response) {
  const text = await response.text();
  return {
    text,
    json: safeJsonParse(text, {}),
  };
}

function createHttpError(message, details = {}) {
  const error = new Error(message);
  error.name = "HttpError";
  Object.assign(error, details);
  return error;
}

function createNetworkError(message, details = {}) {
  const error = new Error(message);
  error.name = "NetworkError";
  Object.assign(error, details);
  return error;
}

function challengeFingerprint(paymentRequiredHeader, request) {
  return crypto
    .createHash("sha256")
    .update(JSON.stringify({
      paymentRequiredHeader,
      url: request.url,
      method: request.method,
      body: request.body,
      idempotencyKey: request.idempotencyKey,
    }))
    .digest("hex");
}

function attachX402Meta(response, meta) {
  if (response && typeof response === "object") {
    response.x402Meta = {
      ...(response.x402Meta || {}),
      ...meta,
    };
  }
  return response;
}

async function loadSharedX402Fetch() {
  try {
    const mod = await import("agoragentic/x402-client");
    if (typeof mod.x402Fetch === "function") {
      return mod.x402Fetch;
    }
  } catch {
    // Optional dependency.
  }
  return null;
}

async function localX402Fetch(url, options = {}) {
  const {
    fetchImpl = globalThis.fetch,
    pay,
    idempotencyKey,
    method = "POST",
    headers = {},
    body,
    signal,
    maxNetworkRetries = 1,
  } = options;

  if (typeof fetchImpl !== "function") {
    throw new Error("fetchImpl is required");
  }
  if (!idempotencyKey) {
    throw new Error("idempotencyKey is required");
  }

  const requestBody = body === undefined ? undefined : JSON.stringify(body);
  const baseHeaders = {
    ...lowerCaseHeaders(headers),
    "content-type": "application/json",
    "idempotency-key": idempotencyKey,
  };

  let cachedPayment = null;
  let sawPaymentChallenge = false;
  let networkRetriesUsed = 0;

  async function dispatch() {
    const attemptHeaders = { ...baseHeaders };
    if (cachedPayment?.authorizationHeader) {
      if (attemptHeaders.authorization) {
        attemptHeaders["x-payment-authorization"] = cachedPayment.authorizationHeader;
      } else {
        attemptHeaders.authorization = cachedPayment.authorizationHeader;
      }
    }
    if (cachedPayment?.paymentSignature) {
      attemptHeaders["payment-signature"] = cachedPayment.paymentSignature;
    }
    return fetchImpl(url, {
      method,
      headers: attemptHeaders,
      body: requestBody,
      signal,
    });
  }

  while (true) {
    try {
      const response = await dispatch();
      if (response.status !== 402) {
        return attachX402Meta(response, {
          paymentAttempted: sawPaymentChallenge,
          paymentAuthorized: Boolean(cachedPayment),
          networkRetriesUsed,
          idempotencyKey,
        });
      }

      sawPaymentChallenge = true;
      if (cachedPayment) {
        throw createHttpError("Paid retry was rejected with HTTP 402; refusing to reuse rejected payment authorization", {
          status: 402,
          idempotencyKey,
          paymentAttempted: true,
          authorizedPaymentReused: true,
        });
      }
      const paymentRequiredHeader = readHeader(response, "payment-required") || readHeader(response, "x-payment-required");
      if (!paymentRequiredHeader) {
        throw createHttpError("Received HTTP 402 without PAYMENT-REQUIRED header", { status: 402, idempotencyKey });
      }
      if (typeof pay !== "function") {
        throw createHttpError("Paid call requires a caller-supplied pay callback", { status: 402, idempotencyKey });
      }

      if (!cachedPayment) {
        const payRequest = {
          url,
          method,
          body,
          idempotencyKey,
          headers: { ...baseHeaders },
          challengeFingerprint: challengeFingerprint(paymentRequiredHeader, {
            url,
            method,
            body,
            idempotencyKey,
          }),
        };
        cachedPayment = await pay(paymentRequiredHeader, payRequest);
        if (!cachedPayment || (!cachedPayment.authorizationHeader && !cachedPayment.paymentSignature)) {
          throw new Error("pay callback must return authorizationHeader or paymentSignature");
        }
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
          authorizedPaymentReused: true,
          idempotencyKey,
          paymentAttempted: sawPaymentChallenge,
          networkRetriesUsed,
        });
      }
      networkRetriesUsed += 1;
    }
  }
}

export async function x402Fetch(url, options = {}) {
  const shared = await loadSharedX402Fetch();
  if (shared) {
    const callerHeaders = lowerCaseHeaders(options.headers || {});
    const normalizedIdempotencyKey = options.idempotencyKey ?? callerHeaders["idempotency-key"] ?? stableId("x402");
    const normalizedOptions = {
      ...options,
      idempotencyKey: normalizedIdempotencyKey,
      headers: {
        ...callerHeaders,
        "idempotency-key": normalizedIdempotencyKey,
      },
      body: options.body === undefined || typeof options.body === "string" ? options.body : JSON.stringify(options.body),
    };
    const response = await shared(url, normalizedOptions);
    return attachX402Meta(response, {
      paymentAttempted: Boolean(readHeader(response, "payment-receipt") || readHeader(response, "payment-response")),
      idempotencyKey: normalizedIdempotencyKey,
    });
  }
  return localX402Fetch(url, options);
}

export function validateX402Receipt({ response, payload, quoteId, idempotencyKey }) {
  const headers = normalizeHeaders(response);
  const paymentReceipt = headers["payment-receipt"] ?? headers["x-payment-receipt"] ?? null;
  const paymentResponse = headers["payment-response"] ?? headers["x-payment-response"] ?? null;
  const invocationId = payload?.invocation_id ?? payload?.invocationId ?? null;
  const receiptId = payload?.receipt_id ?? payload?.receipt?.receipt_id ?? payload?.receipt?.id ?? paymentReceipt ?? null;
  const price = payload?.price_usdc ?? payload?.price ?? payload?.cost ?? null;
  const settlement = payload?.settlement ?? payload?.receipt?.settlement ?? null;
  const paymentAttempted = Boolean(response?.x402Meta?.paymentAttempted || paymentReceipt || paymentResponse);
  const returnedQuoteId = payload?.quote_id ?? payload?.quoteId ?? payload?.receipt?.quote_id ?? payload?.receipt?.quoteId ?? null;
  const quoteMatches = !returnedQuoteId || !quoteId || returnedQuoteId === quoteId;
  const failedSettlement = typeof settlement === "string" && ["failed", "error", "cancelled", "canceled", "rejected"].includes(settlement.toLowerCase());

  const checks = [
    {
      item: "http_ok",
      status: response.ok ? "pass" : "fail",
      evidence: `HTTP ${response.status}`,
    },
    {
      item: "idempotency_key_present",
      status: idempotencyKey ? "pass" : "fail",
      evidence: idempotencyKey || "missing",
    },
    {
      item: "receipt_header_present",
      status: paymentAttempted ? (paymentReceipt ? "pass" : "fail") : "skip",
      evidence: paymentAttempted ? (paymentReceipt || "header missing") : "no payment challenge observed",
    },
    {
      item: "receipt_reference_present",
      status: receiptId ? "pass" : (paymentAttempted ? "fail" : "warn"),
      evidence: receiptId || "response omitted receipt_id",
    },
    {
      item: "quote_binding",
      status: quoteMatches ? "pass" : "fail",
      evidence: returnedQuoteId ? `${returnedQuoteId} vs ${quoteId || "missing"}` : "no returned quote id",
    },
    {
      item: "invocation_reference_present",
      status: invocationId ? "pass" : "warn",
      evidence: invocationId || "response omitted invocation_id",
    },
    {
      item: "price_visible",
      status: price !== null ? "pass" : "warn",
      evidence: price !== null ? String(price) : "response omitted price/cost fields",
    },
    {
      item: "settlement_field_visible",
      status: failedSettlement ? "fail" : (settlement ? "pass" : "warn"),
      evidence: settlement || "no settlement field returned",
    },
  ];

  return {
    ok: checks.every((check) => check.status !== "fail"),
    paymentAttempted,
    quoteId,
    idempotencyKey,
    invocationId,
    receiptId,
    paymentReceipt,
    paymentResponse,
    settlement,
    checks,
    uncertainty: [
      "This adapter validates buyer-visible receipt evidence only.",
      "A Payment-Receipt header is transport evidence, not independent chain settlement proof.",
      "Treat settlement as informational unless separately verified against a receipt or proof endpoint.",
    ],
  };
}

export function classifyX402Error(error) {
  if (!error) {
    return { kind: "unknown", retryable: false, message: "Unknown x402 error" };
  }
  if (error.name === "NetworkError") {
    return {
      kind: "network_after_authorization",
      retryable: true,
      message: error.message,
      idempotencyKey: error.idempotencyKey ?? null,
      guidance: "Retry the same call with the same idempotency key and reuse the existing payment authorization.",
    };
  }
  if (error.name === "HttpError") {
    return {
      kind: "http_failure",
      retryable: (error.status ?? 0) >= 500,
      status: error.status ?? null,
      message: error.message,
      guidance: error.status === 402
        ? "Supply an explicit pay callback. Do not authorize payment without a caller-controlled gate."
        : "Inspect the response payload before retrying.",
    };
  }
  return {
    kind: "unexpected",
    retryable: false,
    message: error.message,
  };
}

export class X402ReceiptValidationAdapter {
  constructor(options = {}) {
    this.baseUrl = options.baseUrl || DEFAULT_BASE_URL;
    this.fetchImpl = options.fetchImpl || globalThis.fetch;
    this.defaultPay = options.pay;
    this.defaultHeaders = lowerCaseHeaders(options.headers || {});
    this.maxNetworkRetries = options.maxNetworkRetries ?? 1;

    if (typeof this.fetchImpl !== "function") {
      throw new Error("fetchImpl is required");
    }
  }

  async match(task, constraints = {}) {
    const url = buildUrl(this.baseUrl, MATCH_PATH, { task, ...constraints });
    const response = await this.fetchImpl(url, {
      method: "GET",
      headers: { ...this.defaultHeaders },
    });
    const payload = await readJsonResponse(response);
    if (!response.ok) {
      throw createHttpError(`Match failed with HTTP ${response.status}`, {
        status: response.status,
        payload: payload.json,
      });
    }
    return payload.json;
  }

  async execute(task, input = {}, options = {}) {
    const {
      quoteId,
      constraints = {},
      pay = this.defaultPay,
      idempotencyKey = stableId("x402"),
      signal,
    } = options;

    let resolvedQuoteId = quoteId;
    let matchPayload = null;

    if (!resolvedQuoteId) {
      matchPayload = await this.match(task, constraints);
      resolvedQuoteId = matchPayload?.quote_id ?? matchPayload?.quote?.quote_id ?? null;
      if (!resolvedQuoteId) {
        throw new Error("match() did not return quote_id");
      }
    }

    const response = await x402Fetch(buildUrl(this.baseUrl, EXECUTE_PATH), {
      fetchImpl: this.fetchImpl,
      pay,
      idempotencyKey,
      method: "POST",
      body: {
        quote_id: resolvedQuoteId,
        input,
      },
      signal,
      headers: this.defaultHeaders,
      maxNetworkRetries: this.maxNetworkRetries,
    });

    const payload = await readJsonResponse(response);
    if (!response.ok) {
      throw createHttpError(`Execute failed with HTTP ${response.status}`, {
        status: response.status,
        payload: payload.json,
        idempotencyKey,
      });
    }

    return {
      task,
      quoteId: resolvedQuoteId,
      idempotencyKey,
      match: matchPayload,
      payload: payload.json,
      x402: response.x402Meta || null,
      receiptValidation: validateX402Receipt({
        response,
        payload: payload.json,
        quoteId: resolvedQuoteId,
        idempotencyKey,
      }),
    };
  }
}

export function createMockX402Transport() {
  let executeAttempts = 0;
  let payCalls = 0;
  let firstPaidRetryDrops = true;
  const seenIdempotencyKeys = [];
  const seenAuthHeaders = [];

  async function fetchImpl(url, init = {}) {
    const target = typeof url === "string" ? new URL(url) : new URL(url.toString());
    const path = target.pathname;
    const method = String(init.method || "GET").toUpperCase();
    const headers = lowerCaseHeaders(init.headers || {});

    if (path === MATCH_PATH && method === "GET") {
      return new SimpleResponse(200, { "content-type": "application/json" }, {
        quote_id: "quote_receipt_validation_demo",
        match: {
          provider: "demo-provider",
          price_usdc: 0.07,
          receipt_supported: true,
        },
      });
    }

    if (path === EXECUTE_PATH && method === "POST") {
      executeAttempts += 1;
      seenIdempotencyKeys.push(headers["idempotency-key"] || null);
      const auth = headers.authorization || null;
      const paymentSignature = headers["payment-signature"] || null;
      if (auth) {
        seenAuthHeaders.push(auth);
      }

      if (!auth && !paymentSignature) {
        return new SimpleResponse(402, {
          "payment-required": JSON.stringify({
            type: "x402",
            network: "base",
            asset: "USDC",
            max_amount_usdc: "0.07",
            pay_to: "demo:merchant",
          }),
        }, {
          error: "payment_required",
          quote_id: "quote_receipt_validation_demo",
        });
      }

      if (firstPaidRetryDrops) {
        firstPaidRetryDrops = false;
        throw new Error("simulated transient network drop after payment authorization");
      }

      return new SimpleResponse(200, {
        "content-type": "application/json",
        "payment-receipt": "receipt_demo_456",
        "payment-response": "paid",
      }, {
        success: true,
        invocation_id: "inv_demo_456",
        receipt_id: "rcpt_demo_456",
        settlement: "submitted",
        cost: "0.07",
        result: {
          provider: "demo-provider",
          echoed_input: safeJsonParse(init.body, {}).input || null,
        },
      });
    }

    return new SimpleResponse(404, { "content-type": "application/json" }, { error: "not_found", path, method });
  }

  async function pay(paymentRequiredHeader, request) {
    payCalls += 1;
    return {
      authorizationHeader: `X402 demo-authorization ${request.challengeFingerprint}`,
      paymentSignature: `demo-signature-${crypto.createHash("sha256").update(paymentRequiredHeader).digest("hex").slice(0, 16)}`,
      receipt: {
        demo: true,
        note: "Self-test only. No real wallet or funds movement.",
      },
    };
  }

  return {
    fetchImpl,
    pay,
    stats() {
      return {
        executeAttempts,
        payCalls,
        seenIdempotencyKeys,
        seenAuthHeaders,
      };
    },
  };
}

export async function runSelfTest() {
  const headerProbe = lowerCaseHeaders(new Headers({ Authorization: "Bearer api", "X-Test": "ok" }));
  if (headerProbe.authorization !== "Bearer api" || headerProbe["x-test"] !== "ok") {
    throw new Error(`Expected Headers instances to be normalized, saw ${JSON.stringify(headerProbe)}`);
  }

  const mock = createMockX402Transport();
  const adapter = new X402ReceiptValidationAdapter({
    baseUrl: DEFAULT_BASE_URL,
    fetchImpl: mock.fetchImpl,
    pay: mock.pay,
    maxNetworkRetries: 1,
  });

  const result = await adapter.execute(
    "demo.analyze",
    { prompt: "Validate this x402 receipt flow." },
    { constraints: { max_cost: 0.07 }, idempotencyKey: "demo-idem-001" },
  );

  const stats = mock.stats();
  if (stats.payCalls !== 1) {
    throw new Error(`Expected pay() to be called once, got ${stats.payCalls}`);
  }
  if (stats.executeAttempts !== 3) {
    throw new Error(`Expected three execute attempts (402 + paid retry + network retry), got ${stats.executeAttempts}`);
  }
  if (new Set(stats.seenIdempotencyKeys).size !== 1 || stats.seenIdempotencyKeys[0] !== "demo-idem-001") {
    throw new Error(`Expected one stable idempotency key, got ${JSON.stringify(stats.seenIdempotencyKeys)}`);
  }
  if (new Set(stats.seenAuthHeaders).size !== 1) {
    throw new Error(`Expected payment authorization reuse, got ${JSON.stringify(stats.seenAuthHeaders)}`);
  }
  if (result.receiptValidation.paymentReceipt !== "receipt_demo_456") {
    throw new Error("Expected payment receipt header evidence");
  }
  if (result.payload.settlement !== "submitted") {
    throw new Error("Expected settlement field to remain informational as submitted");
  }

  const missingReceiptValidation = validateX402Receipt({
    response: attachX402Meta(new SimpleResponse(200, { "content-type": "application/json" }, { ok: true }), { paymentAttempted: true }),
    payload: { ok: true, quote_id: result.quoteId, settlement: "submitted" },
    quoteId: result.quoteId,
    idempotencyKey: "missing-receipt",
  });
  if (missingReceiptValidation.ok) {
    throw new Error("Paid responses without receipt evidence must fail validation");
  }

  const failedSettlementValidation = validateX402Receipt({
    response: attachX402Meta(new SimpleResponse(200, { "x-payment-receipt": "rcpt_failed" }, { ok: true }), { paymentAttempted: true }),
    payload: { receipt_id: "rcpt_failed", quote_id: result.quoteId, settlement: "failed" },
    quoteId: result.quoteId,
    idempotencyKey: "failed-settlement",
  });
  if (failedSettlementValidation.ok) {
    throw new Error("Failed settlement states must fail validation");
  }

  const quoteMismatchValidation = validateX402Receipt({
    response: attachX402Meta(new SimpleResponse(200, { "payment-receipt": "rcpt_quote_mismatch" }, { ok: true }), { paymentAttempted: true }),
    payload: { receipt_id: "rcpt_quote_mismatch", quote_id: "quote_other", settlement: "settled" },
    quoteId: result.quoteId,
    idempotencyKey: "quote-mismatch",
  });
  if (quoteMismatchValidation.ok) {
    throw new Error("Returned quote ids must match the requested quote");
  }

  const apiAuthHeaders = [];
  await localX402Fetch("https://demo.agoragentic.local/api/x402/execute", {
    fetchImpl: async (_url, init = {}) => {
      const headers = lowerCaseHeaders(init.headers || {});
      apiAuthHeaders.push(headers);
      if (!headers["payment-signature"]) {
        return new SimpleResponse(402, { "x-payment-required": "x402:ZGVtb19jaGFsbGVuZ2U=" }, { error: "payment_required" });
      }
      return new SimpleResponse(200, { "x-payment-receipt": "rcpt_api_auth" }, { receipt_id: "rcpt_api_auth", settlement: "settled" });
    },
    headers: { Authorization: "Bearer api-key", "Idempotency-Key": "caller-stale" },
    idempotencyKey: "tracked-idempotency",
    body: { quote_id: result.quoteId, input: { prompt: "api auth preservation" } },
    pay: async () => ({ paymentSignature: "sig:api-auth-preserved" }),
  });
  if (apiAuthHeaders.some((headers) => headers["idempotency-key"] !== "tracked-idempotency")) {
    throw new Error("tracked idempotency key must override caller header");
  }
  if (apiAuthHeaders[1].authorization !== "Bearer api-key" || apiAuthHeaders[1]["payment-signature"] !== "sig:api-auth-preserved") {
    throw new Error("API Authorization must be preserved on paid retries when payment-signature is used");
  }

  let paid402PayCalls = 0;
  let paid402Attempts = 0;
  await assertRejects(
    () => localX402Fetch("https://demo.agoragentic.local/api/x402/execute", {
      fetchImpl: async (_url, init = {}) => {
        paid402Attempts += 1;
        const headers = lowerCaseHeaders(init.headers || {});
        return new SimpleResponse(402, {
          "payment-required": "x402:ZGVtb19jaGFsbGVuZ2U=",
          ...(headers["payment-signature"] ? { "payment-response": "rejected" } : {}),
        }, { error: "payment_required" });
      },
      idempotencyKey: "paid-402-stop",
      body: { quote_id: result.quoteId, input: { prompt: "reject paid retry" } },
      pay: async () => {
        paid402PayCalls += 1;
        return { paymentSignature: "sig:reject-on-paid-retry" };
      },
    }),
    /Paid retry was rejected/
  );
  if (paid402PayCalls !== 1 || paid402Attempts !== 2) {
    throw new Error("Second paid 402 must stop after one pay callback and one paid retry");
  }

  return {
    ok: true,
    executeAttempts: stats.executeAttempts,
    payCalls: stats.payCalls,
    idempotencyKeys: stats.seenIdempotencyKeys,
    receiptValidation: result.receiptValidation,
    recoveryExample: classifyX402Error(createNetworkError("retry with same authorization", {
      idempotencyKey: "demo-idem-001",
      authorizedPaymentReused: true,
    })),
  };
}

async function assertRejects(fn, pattern) {
  try {
    await fn();
  } catch (error) {
    if (!pattern.test(error.message || String(error))) {
      throw new Error(`expected rejection matching ${pattern}, saw ${error.message || String(error)}`);
    }
    return;
  }
  throw new Error(`expected rejection matching ${pattern}`);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  runSelfTest()
    .then((summary) => {
      console.log(JSON.stringify(summary, null, 2));
    })
    .catch((error) => {
      console.error(error.stack || error.message);
      process.exitCode = 1;
    });
}
