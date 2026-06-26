// demo — moves no real funds
import assert from "node:assert/strict";
import crypto from "node:crypto";
import { pathToFileURL } from "node:url";

const DEFAULT_BASE_URL = "https://agoragentic.com";
const MATCH_PATH = "/api/x402/execute/match";
const EXECUTE_PATH = "/api/x402/execute";

function stableId(prefix = "idem") {
  return `${prefix}_${crypto.randomUUID()}`;
}

function lowerCaseHeaders(headers = {}) {
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

function createHttpError(message, details = {}) {
  const error = new Error(message);
  error.name = "HttpError";
  Object.assign(error, details);
  return error;
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

async function readJsonResponse(response) {
  const text = await response.text();
  return {
    text,
    json: safeJsonParse(text, {}),
  };
}

function firstPresent(...values) {
  for (const value of values) {
    if (value !== undefined && value !== null && value !== "") return value;
  }
  return null;
}

function maskAuthorization(value) {
  if (!value) return null;
  if (value.length <= 16) return `${value.slice(0, 4)}…${value.slice(-4)}`;
  return `${value.slice(0, 8)}…${value.slice(-6)}`;
}

function canonicalReceiptShape(payload = {}) {
  const receipt = payload.receipt || payload.result?.receipt || payload.usage_receipt || payload.usage?.receipt || {};
  const settlement = payload.settlement || receipt.settlement || {};
  return {
    invocationId: firstPresent(
      payload.invocation_id,
      payload.invocationId,
      payload.result?.invocation_id,
      payload.result?.invocationId,
      receipt.invocation_id,
      receipt.invocationId,
    ),
    receiptId: firstPresent(
      payload.receipt_id,
      payload.receiptId,
      receipt.id,
      receipt.receipt_id,
      receipt.receiptId,
      settlement.receipt_id,
      settlement.receiptId,
    ),
    listingId: firstPresent(
      payload.listing_id,
      payload.listingId,
      payload.route?.listing_id,
      payload.route?.listingId,
      receipt.listing_id,
      receipt.listingId,
    ),
    providerId: firstPresent(
      payload.provider_id,
      payload.providerId,
      payload.route?.provider_id,
      payload.route?.providerId,
      receipt.provider_id,
      receipt.providerId,
    ),
    status: firstPresent(
      payload.status,
      payload.result?.status,
      receipt.status,
      settlement.status,
    ),
    receiptUrl: firstPresent(
      payload.receipt_url,
      payload.receiptUrl,
      receipt.url,
      receipt.receipt_url,
      settlement.url,
    ),
    paidAmount: firstPresent(
      payload.amount_usdc,
      payload.amount,
      receipt.amount_usdc,
      settlement.amount_usdc,
    ),
    settlementState: firstPresent(
      payload.settlement_state,
      payload.settlementState,
      settlement.state,
      settlement.status,
    ),
  };
}

function classifyChecklist(checks) {
  const passed = checks.filter((check) => check.pass).length;
  return {
    passed,
    failed: checks.length - passed,
    total: checks.length,
  };
}

export function buildReceiptChecklist({ response, payload, request, x402Meta } = {}) {
  const headers = normalizeHeaders(response);
  const shape = canonicalReceiptShape(payload);
  const checks = [
    {
      id: "http-success",
      pass: Boolean(response?.ok),
      evidence: `HTTP ${response?.status ?? "unknown"}`,
    },
    {
      id: "idempotency-key-sent",
      pass: Boolean(request?.idempotencyKey),
      evidence: request?.idempotencyKey ?? "missing idempotency key",
    },
    {
      id: "x402-helper-authorized-after-402",
      pass: x402Meta?.paymentAttempted === true && x402Meta?.paymentAuthorized === true,
      evidence: JSON.stringify({
        paymentAttempted: x402Meta?.paymentAttempted ?? null,
        paymentAuthorized: x402Meta?.paymentAuthorized ?? null,
        networkRetriesUsed: x402Meta?.networkRetriesUsed ?? null,
      }),
    },
    {
      id: "receipt-or-invocation-evidence",
      pass: Boolean(shape.invocationId || shape.receiptId || shape.receiptUrl || headers["x-receipt-id"]),
      evidence: JSON.stringify({
        invocationId: shape.invocationId,
        receiptId: shape.receiptId,
        receiptUrl: shape.receiptUrl,
        headerReceiptId: headers["x-receipt-id"] ?? null,
      }),
    },
    {
      id: "provider-route-echo",
      pass: Boolean(shape.providerId || shape.listingId),
      evidence: JSON.stringify({ providerId: shape.providerId, listingId: shape.listingId }),
    },
    {
      id: "terminal-status-reported",
      pass: Boolean(shape.status),
      evidence: shape.status ?? "missing status",
    },
  ];

  return {
    summary: classifyChecklist(checks),
    checks,
    observed: {
      invocationId: shape.invocationId,
      receiptId: shape.receiptId,
      listingId: shape.listingId,
      providerId: shape.providerId,
      status: shape.status,
      receiptUrl: shape.receiptUrl,
      paidAmount: shape.paidAmount,
      settlementState: shape.settlementState,
      paymentRequiredHeaderSeen: x402Meta?.paymentAttempted === true,
      networkRetriesUsed: x402Meta?.networkRetriesUsed ?? 0,
      idempotencyKey: request?.idempotencyKey ?? null,
    },
    limitations: [
      "This checklist only verifies buyer-visible HTTP evidence.",
      "It does not claim wallet settlement, trust checks, or provider-side completion beyond returned receipt fields.",
    ],
  };
}

async function resolveX402Fetch(explicit) {
  if (typeof explicit === "function") return explicit;

  const candidates = [
    "agoragentic/x402-client",
    "../lib/x402-client.mjs",
    "./lib/x402-client.mjs",
    "../x402/x402_receipt_validation_adapter.mjs",
  ];

  for (const candidate of candidates) {
    try {
      const mod = await import(candidate);
      if (typeof mod.x402Fetch === "function") {
        return mod.x402Fetch;
      }
    } catch {
      // Keep trying.
    }
  }

  throw new Error(
    "Unable to load x402Fetch. Install the agoragentic package or add a local x402 client helper.",
  );
}

export class PQSafeX402ChecklistClient {
  constructor(options = {}) {
    this.baseUrl = options.baseUrl ?? DEFAULT_BASE_URL;
    this.fetchImpl = options.fetchImpl ?? globalThis.fetch;
    this.pay = options.pay;
    this.apiKey = options.apiKey ?? process.env.AGORAGENTIC_API_KEY ?? null;
    this.idempotencyKeyFactory = options.idempotencyKeyFactory ?? (() => stableId("pqsafe"));
    this.x402FetchPromise = resolveX402Fetch(options.x402Fetch);
  }

  async match(task, input = {}, constraints = {}) {
    if (typeof this.fetchImpl !== "function") {
      throw new Error("fetchImpl is required");
    }

    const response = await this.fetchImpl(buildUrl(this.baseUrl, MATCH_PATH), {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...(this.apiKey ? { authorization: `Bearer ${this.apiKey}` } : {}),
      },
      body: JSON.stringify({ task, input, constraints }),
    });

    const { json, text } = await readJsonResponse(response);
    if (!response.ok) {
      throw createHttpError(`match() failed with HTTP ${response.status}`, {
        status: response.status,
        body: text,
      });
    }

    return json;
  }

  async execute(task, input = {}, options = {}) {
    if (typeof this.fetchImpl !== "function") {
      throw new Error("fetchImpl is required");
    }

    const x402Fetch = await this.x402FetchPromise;
    const idempotencyKey = options.idempotencyKey ?? this.idempotencyKeyFactory();
    const body = {
      task,
      input,
      constraints: options.constraints ?? {},
      buyer: {
        integration: "pqsafe",
        mode: options.mode ?? "receipt-checklist",
        ...options.buyer,
      },
    };

    const response = await x402Fetch(buildUrl(this.baseUrl, EXECUTE_PATH), {
      fetchImpl: this.fetchImpl,
      pay: this.pay,
      idempotencyKey,
      method: "POST",
      headers: {
        ...(this.apiKey ? { authorization: `Bearer ${this.apiKey}` } : {}),
        ...lowerCaseHeaders(options.headers ?? {}),
      },
      body,
      signal: options.signal,
    });

    const { json, text } = await readJsonResponse(response);
    if (!response.ok) {
      throw createHttpError(`execute() failed with HTTP ${response.status}`, {
        status: response.status,
        body: text,
        payload: json,
        idempotencyKey,
      });
    }

    const checklist = buildReceiptChecklist({
      response,
      payload: json,
      request: { idempotencyKey, task, input, body },
      x402Meta: response.x402Meta ?? {},
    });

    return {
      ok: true,
      status: response.status,
      idempotencyKey,
      payload: json,
      headers: normalizeHeaders(response),
      x402Meta: response.x402Meta ?? {},
      checklist,
    };
  }
}

function createMockFetchSequence() {
  const calls = [];
  let authorizedAttemptCount = 0;

  const fetchImpl = async (url, init = {}) => {
    const headers = lowerCaseHeaders(init.headers || {});
    calls.push({
      url: String(url),
      method: init.method || "GET",
      headers,
      body: safeJsonParse(init.body, init.body),
    });

    if (!headers.authorization) {
      return new SimpleResponse(402, {
        "payment-required": JSON.stringify({
          scheme: "exact",
          network: "base",
          asset: "USDC",
          maxAmount: "0.015",
          payTo: "demo:pqsafe",
        }),
      }, {
        error: "payment_required",
      });
    }

    authorizedAttemptCount += 1;
    if (authorizedAttemptCount === 1) {
      throw new Error("simulated transient network failure after payment authorization");
    }

    return new SimpleResponse(200, {
      "content-type": "application/json",
      "x-receipt-id": "rcpt_demo_001",
    }, {
      invocation_id: "inv_demo_001",
      status: "completed",
      route: {
        provider_id: "pqsafe-demo-provider",
        listing_id: "pqsafe-demo-listing",
      },
      receipt: {
        id: "rcpt_demo_001",
        url: "https://agoragentic.com/api/receipts/rcpt_demo_001",
        amount_usdc: "0.015",
        settlement: {
          state: "received",
        },
      },
      output: {
        ok: true,
        message: "PQSafe execute completed",
      },
    });
  };

  return { fetchImpl, calls };
}

async function selfTest() {
  const { fetchImpl, calls } = createMockFetchSequence();
  const payCalls = [];

  const client = new PQSafeX402ChecklistClient({
    baseUrl: DEFAULT_BASE_URL,
    fetchImpl,
    pay: async (paymentRequiredHeader, request) => {
      payCalls.push({ paymentRequiredHeader, request });
      return {
        authorizationHeader: `X402 demo token ${request.challengeFingerprint}`,
      };
    },
    idempotencyKeyFactory: () => "pqsafe_demo_idempotency_key",
  });

  const result = await client.execute(
    "buyer.retry.example",
    {
      objective: "validate PQSafe x402 paid execute retry handling",
      payload: { algo: "kyber", mode: "encapsulate" },
    },
    {
      constraints: {
        max_cost_usdc: 0.02,
        require_receipt: true,
      },
    },
  );

  assert.equal(payCalls.length, 1, "pay callback should run exactly once");
  assert.equal(calls.length, 3, "should perform challenge, retry-after-pay, then network retry reuse");
  assert.equal(calls[0].headers["idempotency-key"], "pqsafe_demo_idempotency_key");
  assert.equal(calls[1].headers["idempotency-key"], "pqsafe_demo_idempotency_key");
  assert.equal(calls[2].headers["idempotency-key"], "pqsafe_demo_idempotency_key");
  assert.ok(!calls[0].headers.authorization, "first request must be unpaid");
  assert.ok(calls[1].headers.authorization, "second request must attach payment authorization");
  assert.equal(calls[1].headers.authorization, calls[2].headers.authorization, "retry must reuse prior payment authorization");
  assert.equal(result.payload.receipt.id, "rcpt_demo_001");
  assert.equal(result.checklist.summary.failed, 0, "receipt checklist should pass in self-test");
  assert.equal(result.x402Meta.networkRetriesUsed, 1, "helper should report one authorized network retry");

  return {
    demo: "pqsafe execute buyer retry checklist",
    payCalls: payCalls.length,
    attempts: calls.map((call, index) => ({
      attempt: index + 1,
      idempotencyKey: call.headers["idempotency-key"],
      authorization: maskAuthorization(call.headers.authorization),
    })),
    checklist: result.checklist,
    observedReceipt: {
      invocationId: result.payload.invocation_id,
      receiptId: result.payload.receipt.id,
      receiptUrl: result.payload.receipt.url,
      settlementState: result.payload.receipt.settlement.state,
    },
  };
}

function isMainModule() {
  return process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
}

if (isMainModule()) {
  selfTest()
    .then((summary) => {
      console.log(JSON.stringify(summary, null, 2));
    })
    .catch((error) => {
      console.error(error.stack || error.message || String(error));
      process.exitCode = 1;
    });
}
