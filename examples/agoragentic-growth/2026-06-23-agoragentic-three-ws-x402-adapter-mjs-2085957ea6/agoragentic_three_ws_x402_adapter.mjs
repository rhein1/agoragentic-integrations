// demo — moves no real funds
import crypto from "node:crypto";
import { pathToFileURL } from "node:url";

const DEFAULT_BASE_URL = "https://agoragentic.com";
const EXECUTE_PATH = "/api/x402/execute";
const MATCH_PATH = "/api/x402/execute/match";
const INTERNAL_NETWORK_ERROR = Symbol("internalNetworkError");

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

function sanitizeCause(cause) {
  if (!cause || typeof cause !== "object") return null;
  const summary = {};
  if (typeof cause.name === "string") summary.name = cause.name;
  if (Number.isInteger(cause.status)) summary.status = cause.status;
  if (typeof cause.code === "string") summary.code = cause.code;
  return Object.freeze(summary);
}

function createNetworkError(message, details = {}) {
  const error = new Error(message);
  error.name = "NetworkError";
  const { replayHeaders, cause, ...publicDetails } = details;
  Object.assign(error, publicDetails);
  if (cause !== undefined) {
    Object.defineProperty(error, "cause", {
      value: sanitizeCause(cause),
      enumerable: false,
    });
  }
  if (replayHeaders) {
    Object.defineProperty(error, "replayHeaders", {
      value: Object.freeze({ ...replayHeaders }),
      enumerable: false,
    });
  }
  Object.defineProperty(error, INTERNAL_NETWORK_ERROR, { value: true });
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
    Object.assign(attemptHeaders, usingPayment ? buildPaymentHeaders(cachedPayment) : {});
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
        throw createHttpError("Paid request was rejected with another HTTP 402 challenge; refusing to re-authorize payment", {
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

      // The prior guard rejects a second 402 after payment; this is the first authorization.
      {
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
      if (error?.[INTERNAL_NETWORK_ERROR]) {
        throw error;
      }
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
          authorizedPaymentPrepared: true,
          authorizedPaymentReused: true,
          replayAvailable: true,
          replayHeaders: buildPaymentHeaders(cachedPayment),
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

function buildPaymentHeaders(cachedPayment) {
  const headers = {};
  if (cachedPayment?.authorizationHeader) headers.authorization = cachedPayment.authorizationHeader;
  if (cachedPayment?.paymentSignature) headers["payment-signature"] = cachedPayment.paymentSignature;
  return headers;
}

function normalizePreferredOptions(options = {}) {
  const headers = {
    "content-type": "application/json",
    "idempotency-key": options.idempotencyKey,
    ...lowerCaseHeaders(options.headers || {}),
  };
  const body = options.body === undefined
    ? undefined
    : typeof options.body === "string"
      ? options.body
      : JSON.stringify(options.body);
  return {
    ...options,
    headers,
    body,
  };
}

async function x402Fetch(url, options) {
  const preferred = await importPreferredX402Fetch();
  if (preferred) {
    let paymentCallbackInvoked = false;
    const preferredOptions = {
      ...options,
      pay: typeof options?.pay === "function"
        ? (...args) => {
          paymentCallbackInvoked = true;
          return options.pay(...args);
        }
        : options?.pay,
    };
    const response = await preferred(url, normalizePreferredOptions(preferredOptions));
    return markX402Meta(response, {
      paymentAttempted: paymentCallbackInvoked
        || Boolean(readHeader(response, "payment-receipt") || readHeader(response, "payment-response")),
      idempotencyKey: options?.idempotencyKey ?? null,
    });
  }
  return localX402Fetch(url, options);
}

export function buildReceiptChecklist({ response, payload, quoteId, idempotencyKey, paymentAttempted }) {
  const headers = normalizeResponseHeaders(response);
  const paymentReceipt = headers["payment-receipt"] ?? null;
  const paymentResponse = headers["payment-response"] ?? null;
  const invocationId = payload?.invocation_id ?? payload?.invocationId ?? null;
  const price = payload?.price_usdc ?? payload?.price ?? payload?.cost ?? null;

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
      retryable: false,
      message: error.message,
      idempotencyKey: error.idempotencyKey ?? null,
      paymentState: error.paymentState ?? null,
      guidance: "Do not retry execute(); reconcile the receipt or provider status before any new attempt.",
    };
  }

  if (error.name === "HttpError") {
    return {
      kind: "http_failure",
      retryable: error.retryable ?? (!error.paymentAttempted && error.status >= 500),
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
    this.reconciliationRequired = false;

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

    if (this.reconciliationRequired) {
      throw createHttpError("Previous paid execution requires receipt reconciliation before retrying", {
        code: "PAID_EXECUTION_REQUIRES_RECONCILIATION",
        idempotencyKey,
        paymentAttempted: true,
        retryable: false,
      });
    }

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
    let paymentCallbackInvoked = false;
    const guardedPay = typeof pay === "function"
      ? (...args) => {
        paymentCallbackInvoked = true;
        return pay(...args);
      }
      : pay;

    let response;
    try {
      response = await x402Fetch(executeUrl, {
        fetchImpl: this.fetchImpl,
        pay: guardedPay,
        idempotencyKey,
        method: "POST",
        body,
        signal,
        headers: this.defaultHeaders,
        maxNetworkRetries: this.maxNetworkRetries,
      });
    } catch (error) {
      if (paymentCallbackInvoked || error?.paymentAttempted) {
        this.reconciliationRequired = true;
      }
      throw error;
    }

    const paymentAttempted = Boolean(
      paymentCallbackInvoked
      || response?.x402Meta?.paymentAttempted
      || readHeader(response, "payment-receipt")
      || readHeader(response, "payment-response")
    );

    if (paymentAttempted && !response.ok) {
      this.reconciliationRequired = true;
    }

    let payload;
    try {
      payload = await readJsonResponse(response);
    } catch (error) {
      if (paymentAttempted) {
        this.reconciliationRequired = true;
      }
      throw error;
    }

    if (!response.ok) {
      throw createHttpError(`Execute failed with HTTP ${response.status}`, {
        status: response.status,
        payload: payload.json,
        idempotencyKey,
        paymentAttempted,
        retryable: !paymentAttempted && response.status >= 500,
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

  let namedNetworkAttempts = 0;
  const namedNetworkResult = await createThreeWSAgoragenticAdapter({
    baseUrl: DEFAULT_BASE_URL,
    fetchImpl: async () => {
      namedNetworkAttempts += 1;
      if (namedNetworkAttempts === 1) return new SimpleResponse(402, { "PAYMENT-REQUIRED": "demo-challenge" });
      if (namedNetworkAttempts === 2) {
        const error = new Error("named transport failure");
        error.name = "NetworkError";
        throw error;
      }
      return new SimpleResponse(200, { "Payment-Receipt": "receipt_named-network" }, { success: true });
    },
    pay: async () => ({ authorizationHeader: "demo-authorization" }),
    maxNetworkRetries: 1,
  }).execute("threews.generate.preview", { prompt: "named network retry regression" }, {
    quoteId: "quote_named-network",
    idempotencyKey: "demo-named-network-regression",
  });
  if (namedNetworkAttempts !== 3 || namedNetworkResult.x402?.networkRetriesUsed !== 1) {
    throw new Error("A caller-supplied NetworkError must consume the post-authorization retry and then succeed");
  }

  const postAuthorizationStatuses = [408, 409, 425, 429, 500, 502, 503, 504];
  for (const status of postAuthorizationStatuses) {
    let statusAttempts = 0;
    let statusPayCalls = 0;
    let statusError = null;
    try {
      await createThreeWSAgoragenticAdapter({
        baseUrl: DEFAULT_BASE_URL,
        fetchImpl: async () => {
          statusAttempts += 1;
          if (statusAttempts === 1) return new SimpleResponse(402, { "PAYMENT-REQUIRED": "demo-challenge" });
          return new SimpleResponse(status, {}, { error: "ambiguous_paid_response" });
        },
        pay: async () => {
          statusPayCalls += 1;
          return { authorizationHeader: "demo-authorization" };
        },
        maxNetworkRetries: 1,
      }).execute("threews.generate.preview", { prompt: `status ${status} regression` }, {
        quoteId: `quote-status-${status}`,
        idempotencyKey: `demo-status-${status}`,
      });
    } catch (error) {
      statusError = error;
    }
    if (statusAttempts !== 2 || statusPayCalls !== 1 || statusError?.status !== status
        || classifyExecuteError(statusError).retryable !== false) {
      throw new Error(`Post-authorization HTTP ${status} must be terminal without a paid replay`);
    }
  }

  let bodyFailureAttempts = 0;
  let bodyFailurePayCalls = 0;
  let bodyFailureError = null;
  const bodyFailureAdapter = createThreeWSAgoragenticAdapter({
    baseUrl: DEFAULT_BASE_URL,
    fetchImpl: async () => {
      bodyFailureAttempts += 1;
      if (bodyFailureAttempts === 1) return new SimpleResponse(402, { "PAYMENT-REQUIRED": "demo-challenge" });
      const response = new SimpleResponse(503, {}, { error: "ambiguous_paid_response" });
      response.text = async () => {
        throw new Error("ambiguous paid body read");
      };
      return response;
    },
    pay: async () => {
      bodyFailurePayCalls += 1;
      return { authorizationHeader: "demo-authorization" };
    },
  });
  try {
    await bodyFailureAdapter.execute("threews.generate.preview", { prompt: "body failure lock regression" }, {
      quoteId: "quote-body-failure-lock",
      idempotencyKey: "demo-body-failure-a",
    });
  } catch (error) {
    bodyFailureError = error;
  }
  const bodyFailureLockErrors = [];
  for (const retryOptions of [
    { quoteId: "quote-body-failure-lock", idempotencyKey: "demo-body-failure-a" },
    { quoteId: "quote-body-failure-lock", idempotencyKey: "demo-body-failure-b" },
    { quoteId: "quote-body-failure-lock" },
  ]) {
    try {
      await bodyFailureAdapter.execute("threews.generate.preview", { prompt: "body failure lock regression" }, retryOptions);
    } catch (error) {
      bodyFailureLockErrors.push(error);
    }
  }
  if (bodyFailureError?.message !== "ambiguous paid body read" || bodyFailureLockErrors.length !== 3
      || bodyFailureLockErrors.some((error) => error.code !== "PAID_EXECUTION_REQUIRES_RECONCILIATION")
      || bodyFailureAttempts !== 2 || bodyFailurePayCalls !== 1) {
    throw new Error("A paid body-read failure must lock every later execute() call until receipt reconciliation");
  }

  let exhaustedError = null;
  let exhaustedAttempts = 0;
  try {
    await createThreeWSAgoragenticAdapter({
      baseUrl: DEFAULT_BASE_URL,
      fetchImpl: async () => {
        exhaustedAttempts += 1;
        if (exhaustedAttempts === 1) {
          return new SimpleResponse(402, { "PAYMENT-REQUIRED": "demo-challenge" });
        }
        const error = new Error("simulated persistent network failure");
        error.name = "NetworkError";
        error.replayHeaders = {
          authorization: "secret-authorization",
          "payment-signature": "secret-payment-signature",
        };
        throw error;
      },
      pay: async () => ({
        authorizationHeader: "secret-authorization",
        paymentSignature: "secret-payment-signature",
      }),
      maxNetworkRetries: 1,
    }).execute(
      "threews.generate.preview",
      { prompt: "retry regression" },
      { quoteId: "quote_retry_regression", idempotencyKey: "demo-threews-retry-regression" },
    );
  } catch (error) {
    exhaustedError = error;
  }
  if (!exhaustedError || exhaustedError.name !== "NetworkError") {
    throw new Error(`Expected exhausted post-authorization retries to reject with NetworkError; got ${exhaustedError?.name ?? "no error"}: ${exhaustedError?.message ?? "no message"}`);
  }
  const serializedExhaustedError = JSON.stringify(exhaustedError);
  if (serializedExhaustedError.includes("secret-authorization")
      || serializedExhaustedError.includes("secret-payment-signature")
      || Object.prototype.propertyIsEnumerable.call(exhaustedError, "cause")
      || Object.prototype.propertyIsEnumerable.call(exhaustedError, "replayHeaders")) {
    throw new Error("Serialized payment retry errors must not expose nested payment credentials");
  }

  const recoveryExample = classifyExecuteError(
    createNetworkError("simulated retry guidance", {
      idempotencyKey: "demo-threews-idem-001",
      authorizedPaymentReused: true,
    })
  );
  if (recoveryExample.retryable !== false || !recoveryExample.guidance.includes("reconcile")) {
    throw new Error("Exhausted paid NetworkError guidance must require reconciliation before retrying");
  }

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
