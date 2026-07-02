#!/usr/bin/env node
// demo — the built-in self-test and demo pay gate move no real funds.
import assert from "node:assert/strict";
import crypto from "node:crypto";
import readline from "node:readline";
import { pathToFileURL } from "node:url";

const DEFAULT_BASE_URL = "https://agoragentic.com";
const MATCH_PATH = "/api/x402/execute/match";
const EXECUTE_PATH = "/api/x402/execute";
const SERVER_INFO = {
  name: "arcis-execute-receipt-checklist",
  version: "0.1.0",
};

const TOOLS = [
  {
    name: "arcis.execute",
    description: "Run a paid execute() call through Agoragentic with x402 retry recovery and a buyer-visible receipt checklist.",
    inputSchema: {
      type: "object",
      properties: {
        task: { type: "string", description: "Natural-language task to route through execute()." },
        input: { type: "object", description: "JSON payload forwarded to the matched provider." },
        quote_id: { type: "string", description: "Optional quote id. When omitted, the wrapper performs a match() first." },
        max_cost: { type: "number", description: "Optional max_cost passed to the match step when quote_id is omitted." },
        idempotency_key: { type: "string", description: "Optional stable idempotency key to reuse across buyer retries." },
        allow_demo_payment: { type: "boolean", description: "When true, the local demo pay gate authorizes mock payment headers for the self-test transport only." },
      },
      required: ["task"],
    },
  },
  {
    name: "arcis.last_receipt",
    description: "Return the most recent receipt checklist produced by this wrapper instance.",
    inputSchema: {
      type: "object",
      properties: {},
    },
  },
  {
    name: "arcis.health",
    description: "Return wrapper health and configured upstream base URL.",
    inputSchema: {
      type: "object",
      properties: {},
    },
  },
];

function stableId(prefix = "arcis") {
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

function normalizeHeaders(headers) {
  if (!headers) return {};
  if (typeof headers.entries === "function") {
    return Object.fromEntries(Array.from(headers.entries()).map(([key, value]) => [String(key).toLowerCase(), String(value)]));
  }
  return lowerCaseHeaders(headers);
}

function safeJsonParse(text, fallback = {}) {
  if (!text) return fallback;
  try {
    return JSON.parse(text);
  } catch {
    return fallback;
  }
}

async function readJsonResponse(response) {
  const text = await response.text();
  return {
    text,
    json: safeJsonParse(text, {}),
  };
}

function headerValue(headers, names) {
  const normalized = normalizeHeaders(headers);
  for (const name of names) {
    const value = normalized[String(name).toLowerCase()];
    if (value !== undefined && value !== null && value !== "") return value;
  }
  return null;
}

function challengeFingerprint(paymentRequiredHeader) {
  return crypto.createHash("sha256").update(String(paymentRequiredHeader || "")).digest("hex");
}

class X402HttpError extends Error {
  constructor(message, options = {}) {
    super(message);
    this.name = "X402HttpError";
    Object.assign(this, options);
  }
}

async function x402Fetch(url, options = {}) {
  const {
    fetchImpl = globalThis.fetch,
    pay,
    idempotencyKey,
    method = "GET",
    body,
    maxNetworkRetries = 0,
  } = options;

  if (typeof fetchImpl !== "function") {
    throw new Error("fetchImpl is required");
  }

  const requestBody = body === undefined ? undefined : JSON.stringify(body);
  const baseHeaders = {
    accept: "application/json",
    "content-type": "application/json",
    "idempotency-key": idempotencyKey,
  };
  let authorization = null;
  let paymentAttempted = false;
  let networkRetriesUsed = 0;

  const send = async () => {
    const headers = { ...baseHeaders };
    if (authorization?.authorizationHeader) headers.authorization = authorization.authorizationHeader;
    if (authorization?.paymentSignature) headers["payment-signature"] = authorization.paymentSignature;
    return fetchImpl(url, { method, headers, body: requestBody });
  };

  let response = await send();
  if (response.status !== 402) {
    response.x402Meta = { paymentAttempted, networkRetriesUsed };
    return response;
  }

  if (typeof pay !== "function") {
    throw new X402HttpError("x402 payment required but no pay callback was configured", {
      status: response.status,
      response,
      retryable: false,
      kind: "payment_required",
      x402Meta: { paymentAttempted, networkRetriesUsed },
    });
  }

  const paymentRequiredHeader = headerValue(response.headers, [
    "payment-required",
    "x-payment-required",
    "x-payment-challenge",
  ]);
  if (!paymentRequiredHeader) {
    throw new X402HttpError("HTTP 402 response did not include a payment challenge", {
      status: response.status,
      response,
      retryable: false,
      kind: "missing_payment_challenge",
      x402Meta: { paymentAttempted, networkRetriesUsed },
    });
  }

  authorization = await pay(paymentRequiredHeader, {
    url: String(url),
    method,
    body,
    idempotencyKey,
    challengeFingerprint: challengeFingerprint(paymentRequiredHeader),
  });
  paymentAttempted = true;

  for (;;) {
    try {
      response = await send();
      if (response.status === 402) {
        throw new X402HttpError("x402 payment was rejected after authorization", {
          status: response.status,
          response,
          retryable: false,
          kind: "payment_rejected_after_authorization",
          x402Meta: { paymentAttempted, networkRetriesUsed },
        });
      }
      response.x402Meta = { paymentAttempted, networkRetriesUsed };
      return response;
    } catch (error) {
      if (error instanceof X402HttpError) throw error;
      if (networkRetriesUsed >= maxNetworkRetries) {
        error.x402Meta = { paymentAttempted, networkRetriesUsed };
        throw error;
      }
      networkRetriesUsed += 1;
    }
  }
}

function classifyX402Error(error) {
  const status = Number(error?.status || error?.response?.status || 0);
  if (error?.kind) {
    return {
      kind: error.kind,
      retryable: Boolean(error.retryable),
      status: status || null,
      message: error.message,
    };
  }
  if (error?.x402Meta?.paymentAttempted) {
    return {
      kind: "network_after_authorization",
      retryable: true,
      status: status || null,
      message: error.message,
    };
  }
  if ([408, 425, 429, 500, 502, 503, 504].includes(status)) {
    return {
      kind: "http_transient",
      retryable: true,
      status,
      message: error.message,
    };
  }
  return {
    kind: status ? "http_failure" : "network",
    retryable: !status,
    status: status || null,
    message: error.message,
  };
}

function validateX402Receipt({ response, payload, quoteId, idempotencyKey }) {
  const headers = normalizeHeaders(response?.headers);
  const receipt = payload?.receipt || payload?.result?.receipt || {};
  const paymentReceipt = headers["payment-receipt"] ?? headers["x-payment-receipt"] ?? null;
  const receiptId = payload?.receipt_id ?? receipt?.receipt_id ?? receipt?.id ?? paymentReceipt ?? null;
  return {
    ok: Boolean(response?.ok && (receiptId || payload?.invocation_id || paymentReceipt)),
    paymentReceipt,
    paymentResponse: headers["payment-response"] ?? headers["x-payment-response"] ?? null,
    receiptId,
    invocationId: payload?.invocation_id ?? receipt?.invocation_id ?? null,
    quoteId,
    quoteBound: payload?.quote_id === undefined || payload?.quote_id === quoteId,
    idempotencyKey,
  };
}

function buildUrl(baseUrl, path, params = {}) {
  const url = new URL(path, baseUrl.endsWith("/") ? baseUrl : `${baseUrl}/`);
  for (const [key, value] of Object.entries(params || {})) {
    if (value === undefined || value === null || value === "") continue;
    url.searchParams.set(key, String(value));
  }
  return url;
}

function jsonContent(data) {
  return {
    content: [
      {
        type: "text",
        text: JSON.stringify(data, null, 2),
      },
    ],
  };
}

function receiptSummary(payload, response) {
  const headers = normalizeHeaders(response?.headers);
  const result = payload?.result || {};
  const receipt = payload?.receipt || result?.receipt || {};
  return {
    quote_id: payload?.quote_id ?? receipt?.quote_id ?? null,
    invocation_id: payload?.invocation_id ?? receipt?.invocation_id ?? null,
    receipt_id: payload?.receipt_id ?? receipt?.receipt_id ?? receipt?.id ?? null,
    payment_receipt_header: headers["payment-receipt"] ?? headers["x-payment-receipt"] ?? null,
    payment_response_header: headers["payment-response"] ?? headers["x-payment-response"] ?? null,
    settlement: payload?.settlement ?? receipt?.settlement ?? null,
    amount_usdc: payload?.cost ?? payload?.price_usdc ?? receipt?.amount_usdc ?? null,
    provider: result?.provider ?? payload?.provider ?? headers["x-provider"] ?? null,
  };
}

function buildChecklist({ payload, response, attempts, recovery, authorizationStats, idempotencyKey, quoteId }) {
  const receipt = receiptSummary(payload, response);
  const hasAuthorizationStats = authorizationStats?.available !== false
    && Number(authorizationStats?.authorization_creates || 0) > 0
    && Number(authorizationStats?.unique_authorization_headers || 0) > 0;
  const networkRecovery = recovery.some((entry) => entry.kind === "network_after_authorization");
  const checks = [
    {
      id: "http_ok",
      pass: Boolean(response?.ok),
      evidence: `HTTP ${response?.status ?? "unknown"}`,
    },
    {
      id: "quote_bound",
      pass: Boolean(quoteId),
      evidence: quoteId ?? "missing",
    },
    {
      id: "stable_idempotency_key",
      pass: attempts.every((attempt) => attempt.idempotency_key === idempotencyKey),
      evidence: JSON.stringify(attempts.map((attempt) => attempt.idempotency_key)),
    },
    {
      id: "authorization_created_once",
      pass: hasAuthorizationStats ? authorizationStats.authorization_creates === 1 : true,
      evidence: hasAuthorizationStats ? JSON.stringify(authorizationStats) : "not recorded outside demo transport",
    },
    {
      id: "payment_reused_after_retry",
      pass: hasAuthorizationStats ? authorizationStats.unique_authorization_headers === 1 : true,
      evidence: hasAuthorizationStats ? JSON.stringify(authorizationStats) : "not recorded outside demo transport",
    },
    {
      id: "network_recovery_observed",
      pass: recovery.length === 0 || networkRecovery,
      evidence: recovery.length === 0 ? "no recovery needed" : JSON.stringify(recovery),
    },
    {
      id: "receipt_evidence_present",
      pass: Boolean(receipt.receipt_id || receipt.invocation_id || receipt.payment_receipt_header),
      evidence: JSON.stringify(receipt),
    },
    {
      id: "settlement_only_informational",
      pass: receipt.settlement !== null,
      evidence: String(receipt.settlement ?? "missing"),
    },
  ];

  return {
    ok: checks.every((check) => check.pass),
    summary: {
      total: checks.length,
      passed: checks.filter((check) => check.pass).length,
      failed: checks.filter((check) => !check.pass).length,
    },
    checks,
    receipt,
    uncertainty: [
      "This checklist validates buyer-visible transport evidence only.",
      "A Payment-Receipt header is not independent proof of final settlement.",
      "Settlement remains informational here unless a separate proof endpoint is verified.",
    ],
  };
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

function createCachingDemoPayGate(state) {
  return async function pay(paymentRequiredHeader, request) {
    state.pay_calls += 1;
    const cached = state.authorizations.get(request.challengeFingerprint);
    if (cached) {
      return cached;
    }
    state.authorization_creates += 1;
    const authorization = {
      authorizationHeader: `X402 demo-authorization ${request.challengeFingerprint}`,
      paymentSignature: `demo-signature-${crypto.createHash("sha256").update(paymentRequiredHeader).digest("hex").slice(0, 16)}`,
      receipt: {
        demo: true,
        note: "Self-test only. No real wallet or funds movement.",
      },
    };
    state.authorizations.set(request.challengeFingerprint, authorization);
    return authorization;
  };
}

export function createMockArcisTransport() {
  const state = {
    pay_calls: 0,
    authorization_creates: 0,
    match_calls: 0,
    execute_attempts: 0,
    first_paid_retry_drops: true,
    seen_idempotency_keys: [],
    seen_authorization_headers: [],
    authorizations: new Map(),
  };

  async function fetchImpl(url, init = {}) {
    const target = typeof url === "string" ? new URL(url) : new URL(url.toString());
    const path = target.pathname;
    const method = String(init.method || "GET").toUpperCase();
    const headers = lowerCaseHeaders(init.headers || {});
    const body = safeJsonParse(init.body, {});

    if (path === MATCH_PATH && method === "GET") {
      state.match_calls += 1;
      return new SimpleResponse(200, { "content-type": "application/json" }, {
        quote_id: "quote_arcis_demo_001",
        match: {
          provider: "arcis-demo-provider",
          price_usdc: 0.06,
          receipt_supported: true,
          route: "execute",
        },
      });
    }

    if (path === EXECUTE_PATH && method === "POST") {
      state.execute_attempts += 1;
      state.seen_idempotency_keys.push(headers["idempotency-key"] ?? null);
      if (headers.authorization) {
        state.seen_authorization_headers.push(headers.authorization);
      }

      if (!headers.authorization && !headers["payment-signature"]) {
        return new SimpleResponse(402, {
          "content-type": "application/json",
          "payment-required": JSON.stringify({
            type: "x402",
            network: "base",
            asset: "USDC",
            max_amount_usdc: "0.06",
            pay_to: "demo:arcis",
          }),
        }, {
          error: "payment_required",
          quote_id: body.quote_id,
        });
      }

      if (state.first_paid_retry_drops) {
        state.first_paid_retry_drops = false;
        throw new Error("simulated Arcis MCP upstream disconnect after payment authorization");
      }

      return new SimpleResponse(200, {
        "content-type": "application/json",
        "payment-receipt": "receipt_arcis_demo_001",
        "payment-response": "authorized",
        "x-provider": "arcis-demo-provider",
      }, {
        success: true,
        quote_id: body.quote_id,
        invocation_id: "inv_arcis_demo_001",
        receipt_id: "rcpt_arcis_demo_001",
        settlement: "submitted",
        cost: "0.06",
        result: {
          provider: "arcis-demo-provider",
          echoed_task: body.task,
          echoed_input: body.input ?? null,
        },
      });
    }

    return new SimpleResponse(404, { "content-type": "application/json" }, { error: "not_found", path, method });
  }

  return {
    fetchImpl,
    pay: createCachingDemoPayGate(state),
    stats() {
      return {
        available: true,
        pay_calls: state.pay_calls,
        authorization_creates: state.authorization_creates,
        match_calls: state.match_calls,
        execute_attempts: state.execute_attempts,
        seen_idempotency_keys: [...state.seen_idempotency_keys],
        seen_authorization_headers: [...state.seen_authorization_headers],
        unique_authorization_headers: new Set(state.seen_authorization_headers).size,
      };
    },
  };
}

async function matchQuote({ baseUrl, fetchImpl, task, maxCost, history }) {
  const url = buildUrl(baseUrl, MATCH_PATH, {
    task,
    max_cost: maxCost,
  });
  history.push({ kind: "request", step: "match", url: url.toString(), at: new Date().toISOString() });
  const response = await fetchImpl(url, {
    method: "GET",
    headers: { accept: "application/json" },
  });
  const payload = await readJsonResponse(response);
  if (!response.ok) {
    throw new Error(`match failed with HTTP ${response.status}`);
  }
  history.push({ kind: "step", step: "match_ok", quote_id: payload.json.quote_id ?? null });
  return payload.json;
}

async function executePaidCall({ baseUrl, fetchImpl, pay, quoteId, task, input, idempotencyKey, history }) {
  const response = await x402Fetch(buildUrl(baseUrl, EXECUTE_PATH), {
    fetchImpl,
    pay,
    idempotencyKey,
    method: "POST",
    maxNetworkRetries: 0,
    body: {
      quote_id: quoteId,
      task,
      input,
    },
  });
  const payload = await readJsonResponse(response);
  if (!response.ok) {
    throw new Error(`execute failed with HTTP ${response.status}`);
  }
  history.push({
    kind: "step",
    step: "execute_ok",
    response_status: response.status,
    payment_attempted: Boolean(response?.x402Meta?.paymentAttempted),
    network_retries_used: response?.x402Meta?.networkRetriesUsed ?? 0,
    receipt_id: payload.json?.receipt_id ?? null,
  });
  return {
    response,
    payload: payload.json,
  };
}

export async function runExecuteExample(args = {}, runtime = {}) {
  const {
    task,
    input = {},
    quote_id: suppliedQuoteId,
    max_cost: maxCost,
    idempotency_key: suppliedIdempotencyKey,
    allow_demo_payment: allowDemoPayment = false,
  } = args;

  if (!task || typeof task !== "string") {
    throw new Error("task is required");
  }

  const baseUrl = runtime.baseUrl || DEFAULT_BASE_URL;
  const fetchImpl = runtime.fetchImpl || globalThis.fetch;
  if (typeof fetchImpl !== "function") {
    throw new Error("fetchImpl is required");
  }

  const pay = runtime.pay || (allowDemoPayment ? runtime.demoPay : null);
  const idempotencyKey = suppliedIdempotencyKey || stableId("arcis_idem");
  const history = [{ kind: "step", step: "execute_started", at: new Date().toISOString() }];
  const recovery = [];
  const attempts = [];

  const matchPayload = suppliedQuoteId ? null : await matchQuote({
    baseUrl,
    fetchImpl,
    task,
    maxCost,
    history,
  });
  const quoteId = suppliedQuoteId || matchPayload?.quote_id || null;
  if (!quoteId) {
    throw new Error("quote_id is required or must be returned by the match step");
  }

  let success = null;
  for (let buyerAttempt = 1; buyerAttempt <= 2; buyerAttempt += 1) {
    history.push({
      kind: "request",
      step: "execute",
      buyer_attempt: buyerAttempt,
      quote_id: quoteId,
      idempotency_key: idempotencyKey,
      at: new Date().toISOString(),
    });
    try {
      success = await executePaidCall({
        baseUrl,
        fetchImpl,
        pay,
        quoteId,
        task,
        input,
        idempotencyKey,
        history,
      });
      attempts.push({
        buyer_attempt: buyerAttempt,
        idempotency_key: idempotencyKey,
        outcome: "success",
        payment_attempted: Boolean(success.response?.x402Meta?.paymentAttempted),
      });
      break;
    } catch (error) {
      const classified = classifyX402Error(error);
      attempts.push({
        buyer_attempt: buyerAttempt,
        idempotency_key: idempotencyKey,
        outcome: "error",
        kind: classified.kind,
        retryable: classified.retryable,
      });
      recovery.push({
        buyer_attempt: buyerAttempt,
        ...classified,
      });
      history.push({
        kind: "recovery",
        buyer_attempt: buyerAttempt,
        recovery_kind: classified.kind,
        retryable: classified.retryable,
        message: classified.message,
      });
      if (!classified.retryable || buyerAttempt >= 2) {
        throw Object.assign(error, { attempts, recovery, idempotencyKey, quoteId, history });
      }
    }
  }

  const authorizationStats = typeof runtime.getAuthorizationStats === "function"
    ? runtime.getAuthorizationStats()
    : {
        available: false,
        pay_calls: 0,
        authorization_creates: 0,
        unique_authorization_headers: 0,
      };

  const receiptValidation = validateX402Receipt({
    response: success.response,
    payload: success.payload,
    quoteId,
    idempotencyKey,
  });
  const checklist = buildChecklist({
    payload: success.payload,
    response: success.response,
    attempts,
    recovery,
    authorizationStats,
    idempotencyKey,
    quoteId,
  });

  const result = {
    ok: true,
    task,
    quote_id: quoteId,
    idempotency_key: idempotencyKey,
    match: matchPayload,
    payload: success.payload,
    receipt_validation: receiptValidation,
    receipt_checklist: checklist,
    attempts,
    recovery,
    history,
  };

  if (runtime.state) {
    runtime.state.lastReceipt = result;
  }

  return result;
}

async function callTool(name, args, runtime) {
  if (name === "arcis.execute") {
    return runExecuteExample(args, runtime);
  }
  if (name === "arcis.last_receipt") {
    return runtime.state?.lastReceipt || { ok: false, error: "no_receipt_available" };
  }
  if (name === "arcis.health") {
    return {
      ok: true,
      server: SERVER_INFO,
      base_url: runtime.baseUrl,
      last_receipt_available: Boolean(runtime.state?.lastReceipt),
    };
  }
  throw new Error(`Unknown tool: ${name}`);
}

function writeResponse(payload) {
  process.stdout.write(`${JSON.stringify(payload)}\n`);
}

function hasJsonRpcId(request) {
  return Object.prototype.hasOwnProperty.call(request, "id");
}

export async function startStdioServer(runtime = {}) {
  const rl = readline.createInterface({
    input: process.stdin,
    crlfDelay: Infinity,
  });

  for await (const line of rl) {
    if (!line.trim()) continue;
    const request = JSON.parse(line);
    if (!hasJsonRpcId(request)) {
      continue;
    }
    try {
      if (request.method === "initialize") {
        writeResponse({
          jsonrpc: "2.0",
          id: request.id,
          result: {
            protocolVersion: "2024-11-05",
            serverInfo: SERVER_INFO,
            capabilities: { tools: {} },
          },
        });
        continue;
      }

      if (request.method === "tools/list") {
        writeResponse({
          jsonrpc: "2.0",
          id: request.id,
          result: { tools: TOOLS },
        });
        continue;
      }

      if (request.method === "tools/call") {
        const result = await callTool(request.params?.name, request.params?.arguments || {}, runtime);
        writeResponse({
          jsonrpc: "2.0",
          id: request.id,
          result: jsonContent(result),
        });
        continue;
      }

      writeResponse({
        jsonrpc: "2.0",
        id: request.id,
        error: {
          code: -32601,
          message: `Method not found: ${request.method || "unknown"}`,
        },
      });
    } catch (error) {
      writeResponse({
        jsonrpc: "2.0",
        id: request.id,
        error: {
          code: -32000,
          message: error.message,
          data: {
            attempts: error.attempts || null,
            recovery: error.recovery || null,
            history: error.history || null,
          },
        },
      });
    }
  }
}

export async function runDemo() {
  const mock = createMockArcisTransport();
  const runtime = {
    baseUrl: DEFAULT_BASE_URL,
    fetchImpl: mock.fetchImpl,
    pay: mock.pay,
    demoPay: mock.pay,
    getAuthorizationStats: () => mock.stats(),
    state: { lastReceipt: null },
  };

  return runExecuteExample({
    task: "arcis.analyze",
    input: { text: "Show execute() retry recovery with receipt evidence." },
    max_cost: 0.06,
    idempotency_key: "demo-arcis-idem-001",
    allow_demo_payment: true,
  }, runtime);
}

export async function runSelfTest() {
  const mock = createMockArcisTransport();
  const runtime = {
    baseUrl: DEFAULT_BASE_URL,
    fetchImpl: mock.fetchImpl,
    pay: mock.pay,
    demoPay: mock.pay,
    getAuthorizationStats: () => mock.stats(),
    state: { lastReceipt: null },
  };

  const result = await runExecuteExample({
    task: "arcis.analyze",
    input: { text: "Show execute() retry recovery with receipt evidence." },
    max_cost: 0.06,
    idempotency_key: "demo-arcis-idem-001",
    allow_demo_payment: true,
  }, runtime);

  const stats = mock.stats();
  assert.equal(result.ok, true);
  assert.equal(result.payload.receipt_id, "rcpt_arcis_demo_001");
  assert.equal(result.payload.settlement, "submitted");
  assert.equal(stats.match_calls, 1);
  assert.equal(stats.execute_attempts, 4);
  assert.equal(stats.pay_calls, 2);
  assert.equal(stats.authorization_creates, 1);
  assert.equal(stats.unique_authorization_headers, 1);
  assert.equal(new Set(stats.seen_idempotency_keys).size, 1);
  assert.equal(stats.seen_idempotency_keys[0], "demo-arcis-idem-001");
  assert.equal(result.recovery.length, 1);
  assert.equal(result.recovery[0].kind, "network_after_authorization");
  assert.equal(result.receipt_validation.paymentReceipt, "receipt_arcis_demo_001");
  assert.equal(result.receipt_checklist.summary.failed, 0);

  return {
    ok: true,
    file: "mcp/arcis_execute_receipt_checklist_mcp.mjs",
    idempotency_key: result.idempotency_key,
    receipt_id: result.payload.receipt_id,
    stats,
  };
}

function buildRuntimeFromEnv() {
  return {
    baseUrl: process.env.AGORAGENTIC_BASE_URL || DEFAULT_BASE_URL,
    fetchImpl: globalThis.fetch,
    pay: null,
    demoPay: null,
    state: { lastReceipt: null },
  };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const args = new Set(process.argv.slice(2));
  const run = async () => {
    if (args.has("--self-test")) {
      console.log(JSON.stringify(await runSelfTest(), null, 2));
      return;
    }
    if (args.has("--demo")) {
      console.log(JSON.stringify(await runDemo(), null, 2));
      return;
    }
    await startStdioServer(buildRuntimeFromEnv());
  };

  run().catch((error) => {
    console.error(error.stack || error.message);
    process.exitCode = 1;
  });
}
