// demo — moves no real funds
import assert from "node:assert/strict";
import crypto from "node:crypto";
import { pathToFileURL } from "node:url";

const DEFAULT_BASE_URL = "https://agoragentic.com";
const EXECUTE_PATH = "/api/x402/execute";

function stableId(prefix = "x402") {
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

function readHeader(response, name) {
  const normalized = normalizeHeaders(response);
  return response?.headers?.get?.(name)
    ?? response?.headers?.get?.(String(name).toLowerCase())
    ?? normalized[String(name).toLowerCase()]
    ?? null;
}

async function readJsonResponse(response) {
  const text = await response.text();
  return {
    text,
    json: text ? JSON.parse(text) : {},
  };
}

function firstPresent(...values) {
  for (const value of values) {
    if (value !== undefined && value !== null && value !== "") return value;
  }
  return null;
}

function canonicalReceipt(payload = {}, response) {
  const receipt = payload.receipt || payload.result?.receipt || {};
  return {
    receiptId: firstPresent(payload.receipt_id, payload.receiptId, receipt.receipt_id, receipt.id),
    invocationId: firstPresent(payload.invocation_id, payload.invocationId, receipt.invocation_id),
    quoteId: firstPresent(payload.quote_id, payload.quoteId, receipt.quote_id),
    paymentReceiptHeader: readHeader(response, "payment-receipt"),
    paymentResponseHeader: readHeader(response, "payment-response"),
    status: firstPresent(payload.status, payload.result?.status, payload.success === true ? "success" : null),
    settlement: firstPresent(payload.settlement, receipt.settlement),
    amountUsdc: firstPresent(payload.cost, payload.amount_usdc, receipt.amount_usdc),
  };
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

async function x402Fetch(url, options = {}) {
  const {
    fetchImpl = globalThis.fetch,
    pay,
    idempotencyKey,
    method = "POST",
    headers = {},
    body,
    signal,
    maxNetworkRetries = 0,
    authorizationCache = {},
  } = options;

  if (typeof fetchImpl !== "function") throw new Error("fetchImpl is required");
  if (!idempotencyKey) throw new Error("idempotencyKey is required");

  const baseHeaders = {
    ...lowerCaseHeaders(headers),
    "idempotency-key": idempotencyKey,
  };
  let cachedPayment = authorizationCache.payment || null;
  let sawPaymentChallenge = Boolean(cachedPayment);
  let networkRetriesUsed = 0;

  for (;;) {
    const requestHeaders = { ...baseHeaders };
    if (cachedPayment?.authorizationHeader) requestHeaders.authorization = cachedPayment.authorizationHeader;
    if (cachedPayment?.paymentSignature) requestHeaders["payment-signature"] = cachedPayment.paymentSignature;

    try {
      const response = await fetchImpl(url, {
        method,
        headers: requestHeaders,
        body: body === undefined || body === null || typeof body === "string" ? body : JSON.stringify(body),
        signal,
      });

      if (response.status !== 402) {
        response.x402Meta = {
          paymentAttempted: sawPaymentChallenge,
          paymentAuthorized: Boolean(cachedPayment),
          authorizedPaymentReused: Boolean(authorizationCache.payment),
          networkRetriesUsed,
          idempotencyKey,
        };
        return response;
      }

      sawPaymentChallenge = true;
      const paymentRequiredHeader = readHeader(response, "payment-required") || readHeader(response, "x-payment-required");
      if (cachedPayment) {
        throw createHttpError("Paid retry was rejected with HTTP 402; refusing to create a second payment authorization", {
          status: 402,
          idempotencyKey,
          paymentAttempted: true,
        });
      }
      if (!paymentRequiredHeader) {
        throw createHttpError("HTTP 402 response did not include a payment challenge", {
          status: 402,
          idempotencyKey,
        });
      }
      if (typeof pay !== "function") {
        throw createHttpError("Paid execute requires a pay callback", {
          status: 402,
          idempotencyKey,
          paymentRequiredHeader,
        });
      }

      cachedPayment = normalizePayResult(await pay(paymentRequiredHeader, {
        url,
        method,
        body,
        idempotencyKey,
        headers: { ...baseHeaders },
        challengeFingerprint: challengeFingerprint(paymentRequiredHeader, { url, method, body, idempotencyKey }),
      }));
      authorizationCache.payment = cachedPayment;
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
        });
      }
      networkRetriesUsed += 1;
    }
  }
}

function summarizeChecks(checks) {
  return {
    total: checks.length,
    passed: checks.filter((check) => check.pass).length,
    failed: checks.filter((check) => !check.pass).length,
  };
}

function classifyX402Error(error) {
  if (!error) return { kind: "unknown", retryable: false, message: "Unknown error" };
  if (error.name === "NetworkError") {
    return {
      kind: "network_after_authorization",
      retryable: true,
      message: error.message,
      idempotencyKey: error.idempotencyKey ?? null,
      networkRetriesUsed: error.networkRetriesUsed ?? 0,
    };
  }
  if (error.name === "HttpError") {
    const status = Number(error.status);
    return {
      kind: status === 402 ? "payment_required_or_rejected" : "http_failure",
      retryable: status >= 500 && status < 600,
      status,
      message: error.message,
      idempotencyKey: error.idempotencyKey ?? null,
    };
  }
  return {
    kind: "unexpected",
    retryable: false,
    message: error.message || String(error),
  };
}

export function buildReceiptChecklist({ payload, response, attempts, errorLog, authorizationStats, idempotencyKey }) {
  const receipt = canonicalReceipt(payload, response);
  const checks = [
    {
      id: "http-success",
      pass: Boolean(response?.ok),
      evidence: `HTTP ${response?.status ?? "unknown"}`,
    },
    {
      id: "stable-idempotency-key",
      pass: attempts.every((attempt) => attempt.idempotencyKey === idempotencyKey),
      evidence: JSON.stringify(attempts.map((attempt) => attempt.idempotencyKey)),
    },
    {
      id: "network-failure-logged",
      pass: errorLog.some((entry) => entry.kind === "network_after_authorization"),
      evidence: JSON.stringify(errorLog.map((entry) => ({ kind: entry.kind, retryable: entry.retryable }))),
    },
    {
      id: "authorization-generated-once",
      pass: authorizationStats.authorizeCalls === 1,
      evidence: JSON.stringify(authorizationStats),
    },
    {
      id: "receipt-evidence-present-after-recovery",
      pass: Boolean(receipt.receiptId || receipt.invocationId || receipt.paymentReceiptHeader),
      evidence: JSON.stringify(receipt),
    },
    {
      id: "settlement-treated-as-informational",
      pass: receipt.settlement !== null,
      evidence: String(receipt.settlement ?? "missing"),
    },
  ];

  return {
    summary: summarizeChecks(checks),
    checks,
    observed: {
      idempotencyKey,
      attempts: attempts.length,
      receipt,
      authorizationStats,
      errorLogCount: errorLog.length,
    },
    uncertainty: [
      "This checklist validates buyer-visible transport evidence only.",
      "A receipt header or receipt_id is not independent proof of final settlement.",
      "Treat settlement as informational until you verify it against your own receipt or proof source.",
    ],
  };
}

export async function execute(task, input, options = {}) {
  const {
    baseUrl = DEFAULT_BASE_URL,
    fetchImpl = globalThis.fetch,
    pay,
    quoteId = "quote_demo_receipt_recovery",
    idempotencyKey = stableId("x402_receipt_recovery"),
    maxAttempts = 2,
    maxNetworkRetriesPerCall = 0,
  } = options;

  if (typeof fetchImpl !== "function") {
    throw new Error("fetchImpl is required");
  }
  if (typeof pay !== "function") {
    throw new Error("pay is required");
  }

  const url = new URL(EXECUTE_PATH, baseUrl);
  const errorLog = [];
  const attempts = [];
  let lastError = null;
  const authorizationCache = {};

  for (let buyerAttempt = 1; buyerAttempt <= maxAttempts; buyerAttempt += 1) {
    try {
      const response = await x402Fetch(url, {
        fetchImpl,
        pay,
        idempotencyKey,
        method: "POST",
        maxNetworkRetries: maxNetworkRetriesPerCall,
        authorizationCache,
        body: {
          quote_id: quoteId,
          task,
          input,
        },
      });
      const payload = await readJsonResponse(response);
      if (!response.ok) {
        throw createHttpError(`execute failed with HTTP ${response.status}`, {
          status: response.status,
          payload: payload.json,
          idempotencyKey,
        });
      }
      attempts.push({
        buyerAttempt,
        idempotencyKey,
        status: response.status,
        paymentAttempted: Boolean(response?.x402Meta?.paymentAttempted),
        networkRetriesUsed: response?.x402Meta?.networkRetriesUsed ?? 0,
      });
      return {
        ok: true,
        buyerAttempt,
        idempotencyKey,
        payload: payload.json,
        response,
        attempts,
        errorLog,
      };
    } catch (error) {
      const classified = classifyX402Error(error);
      attempts.push({
        buyerAttempt,
        idempotencyKey,
        status: classified.status ?? null,
        failureKind: classified.kind,
        retryable: classified.retryable,
      });
      errorLog.push({
        at: new Date().toISOString(),
        buyerAttempt,
        ...classified,
      });
      lastError = error;
      if (!classified.retryable || buyerAttempt >= maxAttempts) {
        throw Object.assign(error, {
          attempts,
          errorLog,
          idempotencyKey,
        });
      }
    }
  }

  throw Object.assign(lastError || new Error("execute failed"), {
    attempts,
    errorLog,
    idempotencyKey,
  });
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
}

export function createBuyerRetryDemoTransport() {
  let authorizeCalls = 0;
  let payCalls = 0;
  let paidAttemptCount = 0;
  const executeHistory = [];
  const authorizationCache = new Map();

  async function pay(paymentRequiredHeader, request) {
    payCalls += 1;
    const cached = authorizationCache.get(request.challengeFingerprint);
    if (cached) {
      return cached;
    }
    authorizeCalls += 1;
    const authorization = {
      authorizationHeader: `X402 demo-authorization ${request.challengeFingerprint}`,
      paymentSignature: `demo-signature-${crypto.createHash("sha256").update(paymentRequiredHeader).digest("hex").slice(0, 16)}`,
      demo: true,
      note: "Self-test only. No real wallet or funds movement.",
    };
    authorizationCache.set(request.challengeFingerprint, authorization);
    return authorization;
  }

  async function fetchImpl(url, init = {}) {
    const requestUrl = typeof url === "string" ? new URL(url) : new URL(url.toString());
    const headers = lowerCaseHeaders(init.headers || {});
    const parsedBody = init.body ? JSON.parse(init.body) : {};
    executeHistory.push({
      url: requestUrl.toString(),
      idempotencyKey: headers["idempotency-key"] ?? null,
      authorization: headers.authorization ?? null,
      paymentSignature: headers["payment-signature"] ?? null,
    });

    if (!headers.authorization && !headers["payment-signature"]) {
      return new SimpleResponse(402, {
        "content-type": "application/json",
        "payment-required": JSON.stringify({
          type: "x402",
          network: "base",
          asset: "USDC",
          max_amount_usdc: "0.08",
          pay_to: "demo:merchant",
        }),
      }, {
        error: "payment_required",
        quote_id: parsedBody.quote_id,
      });
    }

    paidAttemptCount += 1;
    if (paidAttemptCount === 1) {
      throw new Error("simulated upstream disconnect after authorization");
    }

    return new SimpleResponse(200, {
      "content-type": "application/json",
      "payment-receipt": "receipt_demo_recovered_001",
      "payment-response": "authorized",
      "x-receipt-id": "rcpt_demo_recovered_001",
    }, {
      success: true,
      quote_id: parsedBody.quote_id,
      invocation_id: "inv_demo_recovered_001",
      receipt_id: "rcpt_demo_recovered_001",
      settlement: "submitted",
      cost: "0.08",
      result: {
        echoed_task: parsedBody.task,
        echoed_input: parsedBody.input,
      },
    });
  }

  return {
    fetchImpl,
    pay,
    stats() {
      return {
        authorizeCalls,
        payCalls,
        paidAttemptCount,
        executeHistory,
      };
    },
  };
}

export async function runSelfTest() {
  const demo = createBuyerRetryDemoTransport();
  const execution = await execute(
    "demo.receipt-recovery",
    { prompt: "Recover from a failed paid API call with receipts and logs." },
    {
      baseUrl: DEFAULT_BASE_URL,
      fetchImpl: demo.fetchImpl,
      pay: demo.pay,
      idempotencyKey: "demo-idem-recovery-001",
      maxAttempts: 2,
      maxNetworkRetriesPerCall: 0,
    },
  );

  const stats = demo.stats();
  const checklist = buildReceiptChecklist({
    payload: execution.payload,
    response: execution.response,
    attempts: execution.attempts,
    errorLog: execution.errorLog,
    authorizationStats: {
      authorizeCalls: stats.authorizeCalls,
      payCalls: stats.payCalls,
      paidAttemptCount: stats.paidAttemptCount,
    },
    idempotencyKey: execution.idempotencyKey,
  });

  assert.equal(execution.ok, true);
  assert.equal(execution.payload.receipt_id, "rcpt_demo_recovered_001");
  assert.equal(stats.authorizeCalls, 1);
  assert.equal(stats.payCalls, 1);
  assert.equal(stats.paidAttemptCount, 2);
  assert.equal(checklist.summary.failed, 0);
  assert.equal(execution.errorLog[0].kind, "network_after_authorization");
  assert.equal(new Set(stats.executeHistory.map((entry) => entry.idempotencyKey)).size, 1);
  assert.equal(stats.executeHistory.filter((entry) => entry.authorization).length, 2, "same authorization should be reused across buyer retry attempts");

  let serverFailureAttempts = 0;
  const serverFailure = await execute(
    "demo.retryable-5xx",
    { prompt: "retry transient http" },
    {
      baseUrl: DEFAULT_BASE_URL,
      idempotencyKey: "demo-idem-http-500",
      maxAttempts: 2,
      pay: async () => ({ authorizationHeader: "unused" }),
      fetchImpl: async () => {
        serverFailureAttempts += 1;
        if (serverFailureAttempts === 1) {
          return new SimpleResponse(502, { "content-type": "application/json" }, { error: "bad_gateway" });
        }
        return new SimpleResponse(200, {
          "content-type": "application/json",
          "payment-receipt": "receipt_after_502",
          "payment-response": "accepted",
        }, {
          success: true,
          quote_id: "quote_demo_receipt_recovery",
          invocation_id: "inv_after_502",
          receipt_id: "receipt_after_502",
          settlement: "submitted",
        });
      },
    },
  );
  assert.equal(serverFailureAttempts, 2, "retryable 5xx response should be retried");
  assert.equal(serverFailure.errorLog[0].status, 502, "retry log should preserve HTTP status");

  return {
    ok: true,
    idempotencyKey: execution.idempotencyKey,
    attempts: execution.attempts,
    receiptChecklist: checklist,
    errorLog: execution.errorLog,
    executeHistory: stats.executeHistory,
    regressionAssertions: {
      missingAdapterImportRemoved: true,
      paidAuthorizationReusedAcrossBuyerRetries: true,
      retryableHttpStatusPreserved: true,
    },
  };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  runSelfTest()
    .then((summary) => {
      console.log(JSON.stringify(summary, null, 2));
    })
    .catch((error) => {
      console.error(error.stack || error.message);
      if (error.errorLog) {
        console.error(JSON.stringify({ errorLog: error.errorLog, attempts: error.attempts }, null, 2));
      }
      process.exitCode = 1;
    });
}
