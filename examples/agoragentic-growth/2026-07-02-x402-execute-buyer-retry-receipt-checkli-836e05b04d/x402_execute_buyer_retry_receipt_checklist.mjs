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

function readFirstHeader(response, names) {
  for (const name of names) {
    const value = readHeader(response, name);
    if (value) return value;
  }
  return null;
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
    paymentReceiptHeader: readFirstHeader(response, ["payment-receipt", "x-payment-receipt", "x-receipt-id"]),
    paymentResponseHeader: readFirstHeader(response, ["payment-response", "x-payment-response"]),
    status: firstPresent(payload.status, payload.result?.status, payload.success === true ? "success" : null),
    settlement: firstPresent(payload.settlement, receipt.settlement),
    amountUsdc: firstPresent(payload.cost, payload.amount_usdc, receipt.amount_usdc),
  };
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
    try {
      const parsed = JSON.parse(candidate);
      return parsed && typeof parsed === "object" ? parsed : null;
    } catch {
      // Try the next representation.
    }
  }
  return null;
}

function makeHttpError(message, response, kind = "http_after_authorization") {
  const error = new Error(message);
  error.status = response?.status ?? null;
  error.kind = kind;
  error.retryable = [429, 500, 502, 503, 504].includes(Number(error.status));
  return error;
}

export function classifyX402Error(error) {
  const status = error?.status ?? error?.response?.status ?? null;
  const kind = error?.kind
    ?? (status ? "http_after_authorization" : "network_after_authorization");
  const retryableStatus = [429, 500, 502, 503, 504].includes(Number(status));
  return {
    kind,
    status,
    retryable: error?.retryable !== undefined
      ? Boolean(error.retryable)
      : kind === "network_after_authorization" || retryableStatus,
    message: error?.message ?? String(error),
  };
}

export async function x402Fetch(url, options = {}) {
  const {
    fetchImpl,
    pay,
    idempotencyKey,
    method = "POST",
    body,
    authorization = null,
  } = options;

  const requestBody = JSON.stringify(body ?? {});
  const baseHeaders = {
    "content-type": "application/json",
    "idempotency-key": idempotencyKey,
  };

  const requestWithAuthorization = async (auth = null) => {
    const headers = { ...baseHeaders };
    if (auth?.authorizationHeader) headers.authorization = auth.authorizationHeader;
    if (auth?.paymentSignature) headers["payment-signature"] = auth.paymentSignature;
    return fetchImpl(url, {
      method,
      headers,
      body: requestBody,
    });
  };

  try {
    const firstResponse = await requestWithAuthorization(authorization);
    if (authorization) {
      firstResponse.x402Meta = {
        paymentAttempted: true,
        reusedAuthorization: true,
        networkRetriesUsed: 0,
      };
      return firstResponse;
    }
    if (firstResponse.status !== 402) {
      return firstResponse;
    }

    const paymentRequiredHeader = readFirstHeader(firstResponse, [
      "payment-required",
      "x-payment-required",
      "x-payment-challenge",
    ]);
    if (!paymentRequiredHeader) {
      throw makeHttpError("Received HTTP 402 without payment-required header", firstResponse, "payment_required_challenge_missing");
    }
    const challenge = parsePaymentRequiredHeader(paymentRequiredHeader);
    if (!challenge) {
      throw makeHttpError("HTTP 402 did not include a valid payment-required challenge", firstResponse, "payment_required_challenge_invalid");
    }
    const challengeFingerprint = crypto
      .createHash("sha256")
      .update(JSON.stringify(challenge) || String(paymentRequiredHeader ?? "missing"))
      .digest("hex");
    const paymentAuthorization = await pay(paymentRequiredHeader, {
      challenge,
      challengeFingerprint,
      idempotencyKey,
      url: String(url),
      method,
    });
    const paidResponse = await requestWithAuthorization(paymentAuthorization);
    if (paidResponse.status === 402) {
      throw makeHttpError("paid request was rejected with another payment challenge", paidResponse, "paid_request_rejected");
    }
    paidResponse.x402Meta = {
      paymentAttempted: true,
      challengeFingerprint,
      networkRetriesUsed: 0,
    };
    return paidResponse;
  } catch (error) {
    if (error?.status || error?.kind) throw error;
    throw Object.assign(error, {
      kind: "network_after_authorization",
      retryable: true,
    });
  }
}

function summarizeChecks(checks) {
  return {
    total: checks.length,
    passed: checks.filter((check) => check.pass).length,
    failed: checks.filter((check) => !check.pass).length,
  };
}

export function buildReceiptChecklist({ payload, response, attempts, errorLog, authorizationStats, idempotencyKey, quoteId }) {
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
      id: "receipt-quote-matches-request",
      pass: !receipt.quoteId || receipt.quoteId === quoteId,
      evidence: JSON.stringify({ requested: quoteId, receipt: receipt.quoteId }),
    },
    {
      id: "settlement-treated-as-informational",
      pass: true,
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
  let cachedAuthorization = null;

  async function authorizeOnce(paymentRequiredHeader, request) {
    if (cachedAuthorization) return cachedAuthorization;
    cachedAuthorization = await pay(paymentRequiredHeader, request);
    return cachedAuthorization;
  }

  for (let buyerAttempt = 1; buyerAttempt <= maxAttempts; buyerAttempt += 1) {
    try {
      const response = await x402Fetch(url, {
        fetchImpl,
        pay: authorizeOnce,
        idempotencyKey,
        method: "POST",
        maxNetworkRetries: maxNetworkRetriesPerCall,
        authorization: cachedAuthorization,
        body: {
          quote_id: quoteId,
          task,
          input,
        },
      });
      const payload = await readJsonResponse(response);
      if (!response.ok) {
        throw makeHttpError(`execute failed with HTTP ${response.status}`, response);
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
    quoteId: "quote_demo_receipt_recovery",
  });

  assert.equal(execution.ok, true);
  assert.equal(execution.payload.receipt_id, "rcpt_demo_recovered_001");
  assert.equal(stats.authorizeCalls, 1);
  assert.equal(stats.payCalls, 1);
  assert.equal(stats.paidAttemptCount, 2);
  assert.equal(checklist.summary.failed, 0);
  assert.equal(execution.errorLog[0].kind, "network_after_authorization");
  assert.equal(new Set(stats.executeHistory.map((entry) => entry.idempotencyKey)).size, 1);

  return {
    ok: true,
    idempotencyKey: execution.idempotencyKey,
    attempts: execution.attempts,
    receiptChecklist: checklist,
    errorLog: execution.errorLog,
    executeHistory: stats.executeHistory,
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
