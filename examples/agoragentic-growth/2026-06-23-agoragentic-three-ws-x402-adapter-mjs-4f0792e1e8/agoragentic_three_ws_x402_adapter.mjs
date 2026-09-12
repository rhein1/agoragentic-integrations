// demo — moves no real funds
import crypto from "node:crypto";
import { pathToFileURL } from "node:url";

const DEFAULT_BASE_URL = "https://agoragentic.com";
const EXECUTE_PATH = "/api/x402/execute";
const MATCH_PATH = "/api/x402/execute/match";

function randomId(prefix = "idmp") {
  return `${prefix}_${crypto.randomUUID()}`;
}

function lowerCaseHeaders(headers = {}) {
  const out = {};
  for (const [key, value] of Object.entries(headers)) {
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

function parseJsonOrBase64Json(value, fallback = null) {
  if (!value) return fallback;
  const text = String(value);
  try {
    return JSON.parse(text);
  } catch {
    try {
      return JSON.parse(Buffer.from(text, "base64").toString("utf8"));
    } catch {
      return fallback;
    }
  }
}

function firstPresent(...values) {
  for (const value of values) {
    if (value !== undefined && value !== null && value !== "") return value;
  }
  return null;
}

function quoteIdFrom(value) {
  if (!value || typeof value !== "object") return null;
  return firstPresent(
    value.quote_id,
    value.quoteId,
    value.quote?.quote_id,
    value.quote?.quoteId,
    value.receipt?.quote_id,
    value.receipt?.quoteId,
  );
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

  toJSON() {
    return Object.fromEntries(this.map.entries());
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

async function readJsonResponse(response) {
  const text = await response.text();
  return {
    text,
    json: safeJsonParse(text, {}),
  };
}

function normalizeResponseHeaders(response) {
  if (!response?.headers) return {};
  if (typeof response.headers.entries === "function") {
    return Object.fromEntries(Array.from(response.headers.entries()).map(([k, v]) => [String(k).toLowerCase(), String(v)]));
  }
  return lowerCaseHeaders(response.headers);
}

function readHeader(response, name) {
  return response?.headers?.get?.(name)
    ?? response?.headers?.get?.(String(name).toLowerCase())
    ?? normalizeResponseHeaders(response)[String(name).toLowerCase()]
    ?? null;
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

function paymentStateSummary(cachedPayment, paymentRequiredHeader, request) {
  return {
    authorizationPrepared: Boolean(cachedPayment),
    hasAuthorizationHeader: Boolean(cachedPayment?.authorizationHeader),
    hasPaymentSignature: Boolean(cachedPayment?.paymentSignature),
    challengeFingerprint: paymentRequiredHeader
      ? challengeFingerprint(paymentRequiredHeader, request)
      : null,
    retryWithSameIdempotencyKey: true,
  };
}

async function importPreferredX402Fetch() {
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

function markX402Meta(response, meta) {
  if (response && typeof response === "object") {
    response.x402Meta = {
      ...(response.x402Meta || {}),
      ...meta,
    };
  }
  return response;
}

async function localX402Fetch(url, options) {
  const {
    fetchImpl = globalThis.fetch,
    pay,
    idempotencyKey,
    method = "POST",
    headers = {},
    body,
    maxNetworkRetries = 1,
    signal,
  } = options ?? {};

  if (typeof fetchImpl !== "function") {
    throw new Error("fetchImpl is required");
  }
  if (!idempotencyKey) {
    throw new Error("idempotencyKey is required");
  }

  const requestBody = body === undefined ? undefined : JSON.stringify(body);
  const baseHeaders = {
    "content-type": "application/json",
    "idempotency-key": idempotencyKey,
    ...lowerCaseHeaders(headers),
  };

  let cachedPayment = null;
  let paymentRequiredHeader = null;
  let sawPaymentChallenge = false;
  let networkFailuresAfterAuthorization = 0;
  let lastError = null;

  async function dispatch(usingPayment) {
    const attemptHeaders = { ...baseHeaders };
    if (usingPayment && cachedPayment?.authorizationHeader) {
      attemptHeaders.authorization = cachedPayment.authorizationHeader;
    }
    if (usingPayment && cachedPayment?.paymentSignature) {
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
      const response = await dispatch(Boolean(cachedPayment));

      if (response.status !== 402) {
        return markX402Meta(response, {
          paymentAttempted: sawPaymentChallenge,
          paymentAuthorized: Boolean(cachedPayment),
          networkRetriesUsed: networkFailuresAfterAuthorization,
          idempotencyKey,
        });
      }

      sawPaymentChallenge = true;
      paymentRequiredHeader = readHeader(response, "payment-required");
      if (!paymentRequiredHeader) {
        throw createHttpError("Received HTTP 402 without PAYMENT-REQUIRED header", {
          status: 402,
        });
      }

      if (cachedPayment) {
        throw createHttpError("Paid retry was rejected with another HTTP 402", {
          status: 402,
          idempotencyKey,
          paymentAttempted: true,
          retryable: false,
          paymentState: paymentStateSummary(cachedPayment, paymentRequiredHeader, {
            url,
            method,
            body,
            idempotencyKey,
          }),
        });
      }

      if (typeof pay !== "function") {
        throw createHttpError("Paid call requires a pay callback", {
          status: 402,
          idempotencyKey,
        });
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
          throw new Error("pay callback did not return authorizationHeader or paymentSignature");
        }
      }

      continue;
    } catch (error) {
      lastError = error;
      const isHttpLike = typeof error?.status === "number";
      if (isHttpLike) {
        throw error;
      }

      if (!cachedPayment) {
        throw error;
      }

      if (networkFailuresAfterAuthorization >= maxNetworkRetries) {
        throw createNetworkError(`Network error after payment authorization was prepared: ${error.message}`, {
          cause: error,
          authorizedPaymentReused: true,
          idempotencyKey,
          paymentAttempted: sawPaymentChallenge,
          networkRetriesUsed: networkFailuresAfterAuthorization,
          paymentState: paymentStateSummary(cachedPayment, paymentRequiredHeader, {
            url,
            method,
            body,
            idempotencyKey,
          }),
        });
      }

      networkFailuresAfterAuthorization += 1;
    }
  }

  throw lastError ?? new Error("x402Fetch failed without a response");
}

async function x402Fetch(url, options) {
  const preferred = await importPreferredX402Fetch();
  if (preferred) {
    const response = await preferred(url, options);
    return markX402Meta(response, {
      paymentAttempted: Boolean(readHeader(response, "payment-receipt") || readHeader(response, "payment-response")),
      idempotencyKey: options?.idempotencyKey ?? null,
    });
  }
  return localX402Fetch(url, options);
}

export function buildReceiptChecklist({ response, payload, quoteId, idempotencyKey, paymentAttempted }) {
  const headers = normalizeResponseHeaders(response);
  const paymentReceipt = headers["payment-receipt"] ?? null;
  const paymentResponse = headers["payment-response"] ?? null;
  const parsedReceipt = parseJsonOrBase64Json(paymentReceipt, null);
  const invocationId = payload?.invocation_id ?? payload?.invocationId ?? null;
  const price = firstPresent(payload?.price_usdc, payload?.price, payload?.cost);
  const payloadQuoteId = quoteIdFrom(payload);
  const receiptQuoteId = quoteIdFrom(parsedReceipt);
  const observedQuoteId = firstPresent(payloadQuoteId, receiptQuoteId);
  const quoteMatches = !observedQuoteId || !quoteId || observedQuoteId === quoteId;

  const items = [
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
      item: "invocation_reference",
      status: invocationId ? "pass" : "warn",
      evidence: invocationId || "response has no invocation_id",
    },
    {
      item: "payment_receipt_header",
      status: paymentAttempted ? (paymentReceipt ? "pass" : "warn") : "skip",
      evidence: paymentAttempted ? (paymentReceipt || "header missing") : "no x402 payment challenge observed",
    },
    {
      item: "payment_response_header",
      status: paymentAttempted ? (paymentResponse ? "pass" : "warn") : "skip",
      evidence: paymentAttempted ? (paymentResponse || "header missing") : "no x402 payment challenge observed",
    },
    {
      item: "price_visibility",
      status: price !== null ? "pass" : "warn",
      evidence: price !== null ? String(price) : "response omitted price/cost fields",
    },
    {
      item: "quote_matches_request",
      status: quoteMatches ? (observedQuoteId ? "pass" : "warn") : "fail",
      evidence: observedQuoteId
        ? `requested=${quoteId || "missing"} observed=${observedQuoteId}`
        : "response omitted quote_id in payload and receipt",
    },
  ];

  return {
    paymentAttempted,
    responseStatus: response.status,
    quoteId,
    idempotencyKey,
    paymentReceipt,
    paymentResponse,
    invocationId,
    checks: items,
    uncertain: [
      "This checklist only inspects HTTP response evidence available to the buyer adapter.",
      "A Payment-Receipt header is treated as transport evidence, not as independent chain settlement proof.",
      "On-chain proof should be checked separately if the workflow requires terminal verification.",
    ],
  };
}

export function classifyExecuteError(error) {
  if (!error) {
    return {
      kind: "unknown",
      retryable: false,
      message: "Unknown execute error",
    };
  }

  if (error.name === "NetworkError") {
    return {
      kind: "network_after_payment_authorized",
      retryable: true,
      message: error.message,
      idempotencyKey: error.idempotencyKey ?? null,
      paymentState: error.paymentState ?? null,
      guidance: "Retry the same execute() call with the same idempotency key and reuse the existing payment authorization if your x402 helper exposes it.",
    };
  }

  if (error.name === "HttpError") {
    return {
      kind: "http_failure",
      retryable: error.retryable ?? error.status >= 500,
      status: error.status ?? null,
      message: error.message,
      idempotencyKey: error.idempotencyKey ?? null,
      paymentState: error.paymentState ?? null,
      guidance: error.status === 402
        ? "Execution still requires a caller-supplied pay callback. Do not auto-pay without an explicit gate."
        : "Inspect the response payload before retrying.",
    };
  }

  return {
    kind: "unexpected",
    retryable: false,
    message: error.message,
  };
}

export class ThreeWSAgoragenticX402Adapter {
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
      idempotencyKey = randomId(),
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

    const body = { quote_id: resolvedQuoteId, input };
    const executeUrl = buildUrl(this.baseUrl, EXECUTE_PATH);

    const response = await x402Fetch(executeUrl, {
      fetchImpl: this.fetchImpl,
      pay,
      idempotencyKey,
      method: "POST",
      body,
      signal,
      headers: this.defaultHeaders,
      maxNetworkRetries: this.maxNetworkRetries,
    });

    const payload = await readJsonResponse(response);
    const paymentAttempted = Boolean(
      response?.x402Meta?.paymentAttempted
      || readHeader(response, "payment-receipt")
      || readHeader(response, "payment-response")
    );

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
      receiptChecklist: buildReceiptChecklist({
        response,
        payload: payload.json,
        quoteId: resolvedQuoteId,
        idempotencyKey,
        paymentAttempted,
      }),
    };
  }
}

export function createThreeWSAgoragenticAdapter(options = {}) {
  return new ThreeWSAgoragenticX402Adapter(options);
}

export function createMockPaidFetch() {
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
        quote_id: "quote_threews_paid_001",
        match: {
          provider: "three.ws",
          price_usdc: 0.05,
          receipt_supported: true,
        },
      });
    }

    if (path === EXECUTE_PATH && method === "POST") {
      executeAttempts += 1;
      const idempotencyKey = headers["idempotency-key"] || null;
      seenIdempotencyKeys.push(idempotencyKey);
      const auth = headers.authorization || null;
      const paymentSignature = headers["payment-signature"] || null;
      if (auth) {
        seenAuthHeaders.push(auth);
      }

      if (!auth && !paymentSignature) {
        return new SimpleResponse(402, {
          "PAYMENT-REQUIRED": JSON.stringify({
            type: "x402",
            network: "base",
            asset: "USDC",
            max_amount_usdc: "0.05",
            pay_to: "demo:threews",
          }),
        }, {
          error: "payment_required",
          quote_id: "quote_threews_paid_001",
          provider: "three.ws",
          price_usdc: 0.05,
        });
      }

      if (firstPaidRetryDrops) {
        firstPaidRetryDrops = false;
        throw new Error("simulated transient network drop after payment authorization");
      }

      return new SimpleResponse(200, {
        "content-type": "application/json",
        "Payment-Receipt": "receipt_demo_123",
        "PAYMENT-RESPONSE": "paid",
      }, {
        success: true,
        provider: "three.ws",
        quote_id: "quote_threews_paid_001",
        invocation_id: "inv_threews_001",
        result: {
          summary: "three.ws processed the request",
          echoed_input: safeJsonParse(init.body, {}).input || null,
        },
        cost: "0.05",
      });
    }

    return new SimpleResponse(404, { "content-type": "application/json" }, { error: "not_found", path, method });
  }

  async function pay(paymentRequiredHeader, request) {
    payCalls += 1;
    return {
      authorizationHeader: `X402 demo-authorization ${request.challengeFingerprint}`,
      paymentSignature: `demo-signature-${crypto.createHash("sha256").update(paymentRequiredHeader).digest("hex").slice(0, 12)}`,
      receipt: {
        demo: true,
        note: "No real wallet, chain tx, or funds movement.",
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

async function runSelfTest() {
  const mock = createMockPaidFetch();
  const adapter = createThreeWSAgoragenticAdapter({
    baseUrl: DEFAULT_BASE_URL,
    fetchImpl: mock.fetchImpl,
    pay: mock.pay,
    maxNetworkRetries: 1,
  });

  const result = await adapter.execute(
    "threews.generate.preview",
    { prompt: "Render a low-poly lighthouse at dusk." },
    { constraints: { max_cost: 0.05 }, idempotencyKey: "demo-threews-idem-001" }
  );

  const stats = mock.stats();
  if (stats.payCalls !== 1) {
    throw new Error(`Expected pay() to be called once, got ${stats.payCalls}`);
  }
  if (stats.executeAttempts !== 3) {
    throw new Error(`Expected execute path to be hit three times (402 + paid retry + network retry), got ${stats.executeAttempts}`);
  }
  if (new Set(stats.seenIdempotencyKeys).size !== 1 || stats.seenIdempotencyKeys[0] !== "demo-threews-idem-001") {
    throw new Error(`Expected one stable idempotency key, got ${JSON.stringify(stats.seenIdempotencyKeys)}`);
  }
  if (new Set(stats.seenAuthHeaders).size !== 1) {
    throw new Error(`Expected the same payment authorization to be reused, got ${JSON.stringify(stats.seenAuthHeaders)}`);
  }
  if (result.receiptChecklist.paymentReceipt !== "receipt_demo_123") {
    throw new Error("Missing payment receipt evidence in checklist");
  }
  if (result.x402?.networkRetriesUsed !== 1) {
    throw new Error(`Expected exactly one post-authorization network retry, got ${result.x402?.networkRetriesUsed}`);
  }

  const recoveryExample = classifyExecuteError(
    createNetworkError("simulated retry guidance", {
      idempotencyKey: "demo-threews-idem-001",
      authorizedPaymentReused: true,
    })
  );

  return {
    ok: true,
    payCalls: stats.payCalls,
    executeAttempts: stats.executeAttempts,
    idempotencyKeys: stats.seenIdempotencyKeys,
    receiptChecklist: result.receiptChecklist,
    payload: result.payload,
    recoveryExample,
  };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  runSelfTest()
    .then((summary) => {
      console.log(JSON.stringify(summary, null, 2));
    })
    .catch((error) => {
      console.error(error.stack || error.message);
      process.exitCode = 1;
    });
}
