#!/usr/bin/env node
/* demo — simulates x402 payment authorization and receipts for an ibanforge-style execute flow; moves no real funds */

import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import process from "node:process";
import { pathToFileURL } from "node:url";

const DEFAULT_BASE_URL = process.env.IBANFORGE_BASE_URL || "https://ibanforge.example";
const DEFAULT_EXECUTE_PATH = "/v1/execute";
const DEFAULT_CAPABILITY_ID = "agoragentic.ibanforge.execute.v1";
const DEFAULT_LISTING_ID = "ibanforge.execute.demo";
const DEFAULT_TOOL_NAME = "execute_ibanforge_check";
const DEFAULT_SERVER_NAME = "ibanforge-paid-api";

function stableStringify(value) {
  if (Array.isArray(value)) {
    return `[${value.map((item) => stableStringify(item)).join(",")}]`;
  }
  if (value && typeof value === "object") {
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

function sha256(value) {
  const text = typeof value === "string" ? value : stableStringify(value);
  return createHash("sha256").update(text).digest("hex");
}

function clone(value) {
  return value === undefined ? undefined : JSON.parse(JSON.stringify(value));
}

function nowIso() {
  return new Date().toISOString();
}

function lowerCaseKeys(input = {}) {
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
  const headers = lowerCaseKeys(source.headers || source);
  return headers[String(name).toLowerCase()] ?? null;
}

async function safeJson(response) {
  if (!response) return null;
  const text = await response.text();
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    return { raw: text };
  }
}

function jsonResponse(status, body, headers = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "content-type": "application/json",
      ...headers,
    },
  });
}

function normalizeBaseUrl(baseUrl) {
  return String(baseUrl || DEFAULT_BASE_URL).replace(/\/+$/, "");
}

function buildExecuteUrl(baseUrl, executePath = DEFAULT_EXECUTE_PATH) {
  return new URL(executePath, `${normalizeBaseUrl(baseUrl)}/`).toString();
}

function encodePaymentRequired(challenge) {
  return Buffer.from(JSON.stringify([challenge]), "utf8").toString("base64");
}

function decodePaymentRequired(encoded) {
  if (!encoded) return null;
  try {
    const parsed = JSON.parse(Buffer.from(String(encoded), "base64").toString("utf8"));
    return Array.isArray(parsed) ? parsed[0] || null : parsed;
  } catch {
    return null;
  }
}

function normalizePayResult(payment) {
  if (!payment || typeof payment !== "object") {
    throw new Error("pay callback must return an object");
  }
  const authorizationHeader = payment.authorizationHeader
    || payment.authorization
    || payment.paymentAuthorization
    || null;
  const paymentSignature = payment.paymentSignature || null;
  if (!authorizationHeader && !paymentSignature) {
    throw new Error("pay callback must return authorizationHeader, authorization, or paymentSignature");
  }
  return { authorizationHeader, paymentSignature };
}

class AdapterValidationError extends Error {
  constructor(message, details = {}) {
    super(message);
    this.name = "AdapterValidationError";
    this.details = details;
  }
}

class ExecuteHttpError extends Error {
  constructor(message, details = {}) {
    super(message);
    this.name = "ExecuteHttpError";
    this.details = details;
    this.status = details.status ?? null;
  }
}

class ExecuteNetworkError extends Error {
  constructor(message, details = {}) {
    super(message);
    this.name = "ExecuteNetworkError";
    this.details = details;
  }
}

async function resolvePreferredX402Fetch() {
  const candidates = [
    "agoragentic/x402-client",
    "../lib/x402-client.mjs",
    "./lib/x402-client.mjs",
  ];

  for (const specifier of candidates) {
    try {
      const mod = await import(specifier);
      if (typeof mod.x402Fetch === "function") {
        return { x402Fetch: mod.x402Fetch, source: specifier };
      }
    } catch {}
  }

  return { x402Fetch: createFallbackX402Fetch(), source: "inline-demo-fallback" };
}

function createFallbackX402Fetch() {
  return async function x402Fetch(url, options = {}) {
    const {
      fetchImpl = globalThis.fetch,
      pay,
      idempotencyKey = randomUUID(),
      method = "POST",
      headers = {},
      body,
      signal,
      maxNetworkRetries = 1,
    } = options;

    if (typeof fetchImpl !== "function") {
      throw new Error("fetchImpl is required");
    }

    const baseHeaders = lowerCaseKeys(headers);
    let cachedPayment = null;
    let paidChallenge = null;
    let paymentAttempted = false;
    let networkRetriesUsed = 0;

    while (true) {
      const requestHeaders = {
        accept: "application/json",
        "idempotency-key": idempotencyKey,
        ...baseHeaders,
      };

      let requestBody = body;
      if (requestBody !== undefined && requestBody !== null && typeof requestBody !== "string") {
        requestBody = JSON.stringify(requestBody);
      }
      if (requestBody !== undefined && requestBody !== null && !requestHeaders["content-type"]) {
        requestHeaders["content-type"] = "application/json";
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
            helper: "inline-demo-fallback",
            idempotencyKey,
            paymentAttempted,
            paymentAuthorized: Boolean(cachedPayment),
            authorizedPaymentReused: networkRetriesUsed > 0,
            networkRetriesUsed,
            paidChallengeId: paidChallenge?.challenge_id || null,
          };
          return response;
        }

        paymentAttempted = true;
        const encodedChallenge = readHeader(response, "payment-required") ?? readHeader(response, "x-payment-required");
        const challengePayload = decodePaymentRequired(encodedChallenge);
        if (!challengePayload || typeof challengePayload !== "object") {
          throw new ExecuteHttpError("HTTP 402 did not include a valid payment-required challenge", {
            status: 402,
            idempotencyKey,
            paymentRequired: encodedChallenge ?? null,
          });
        }
        const challengeId = challengePayload.challenge_id || challengePayload.id || null;

        if (typeof pay !== "function") {
          throw new ExecuteHttpError("HTTP 402 requires a caller-supplied pay callback", {
            status: 402,
            challenge: challengePayload,
            idempotencyKey,
          });
        }
        if (cachedPayment) {
          throw new ExecuteHttpError("Paid request received another HTTP 402 challenge; refusing to re-authorize payment", {
            status: 402,
            challenge: challengePayload,
            idempotencyKey,
            paymentAuthorized: true,
          });
        }

        if (!cachedPayment) {
          cachedPayment = normalizePayResult(await pay(challengePayload, {
            url,
            method,
            headers: clone(requestHeaders),
            body: requestBody,
            idempotencyKey,
          }));
          paidChallenge = { challenge_id: challengeId };
        }
      } catch (error) {
        if (error instanceof ExecuteHttpError) throw error;
        if (!cachedPayment) throw error;
        if (networkRetriesUsed >= maxNetworkRetries) {
          throw new ExecuteNetworkError(`Network error after payment authorization was prepared: ${error.message}`, {
            cause: error,
            idempotencyKey,
            paymentAttempted,
            paidChallengeId: paidChallenge?.challenge_id || null,
            authorizedPaymentReused: true,
            networkRetriesUsed,
          });
        }
        networkRetriesUsed += 1;
      }
    }
  };
}

export function createIbanforgeManifest(options = {}) {
  const tool = {
    name: options.toolName || DEFAULT_TOOL_NAME,
    description: "Execute a bounded ibanforge request through an x402-gated endpoint and return receipt evidence.",
    input_schema: {
      type: "object",
      additionalProperties: false,
      required: ["route", "iban"],
      properties: {
        route: {
          type: "string",
          enum: ["validate", "format", "bank_lookup"],
          description: "ibanforge operation to execute.",
        },
        iban: {
          type: "string",
          description: "IBAN to validate or inspect.",
        },
        country_hint: {
          type: "string",
          description: "Optional ISO country hint for route-specific logic.",
        },
        include_bank_metadata: {
          type: "boolean",
          description: "Request bank metadata when available.",
          default: false,
        },
        metadata: {
          type: "object",
          additionalProperties: true,
          description: "Optional buyer metadata forwarded to the seller.",
        },
        idempotency_key: {
          type: "string",
          description: "Caller-supplied idempotency key. Generated if omitted.",
        },
      },
    },
    output_schema: {
      type: "object",
      additionalProperties: false,
      required: ["invocation_id", "capability_id", "output", "usage_receipt", "receipt_checklist", "seller_listing", "wrapper", "raw_response"],
      properties: {
        invocation_id: { type: "string" },
        capability_id: { type: "string" },
        output: { type: "object", additionalProperties: true },
        usage_receipt: { type: "object", additionalProperties: true },
        receipt_checklist: { type: "object", additionalProperties: true },
        seller_listing: { type: "object", additionalProperties: true },
        wrapper: {
          type: "object",
          additionalProperties: false,
          required: ["x402_fetch_source", "idempotency_key", "server_name"],
          properties: {
            x402_fetch_source: { type: "string" },
            idempotency_key: { type: "string" },
            server_name: { type: "string" },
          },
        },
        raw_response: { type: "object", additionalProperties: true },
      },
    },
  };

  const manifest = {
    manifest_version: "1.0",
    listing_id: options.listingId || DEFAULT_LISTING_ID,
    capability_id: options.capabilityId || DEFAULT_CAPABILITY_ID,
    title: "ibanforge execute() x402 adapter",
    summary: "Runnable buyer-side adapter example for ibanforge paid calls with x402 gating, receipt capture, and retry-safe execute() behavior.",
    visibility: "draft",
    seller: {
      id: "example/ibanforge",
      display_name: "ibanforge",
      repository: "https://github.com/rhein1/agoragentic-integrations",
    },
    runtime: {
      framework: "http",
      transport: "marketplace.execute",
      path: DEFAULT_EXECUTE_PATH,
      wrapper_runtime: "node>=18",
      wrapper_file: "examples/agoragentic-growth/2026-07-02-ibanforge-x402-execute-receipt-adapter-m-9a04cdff61/ibanforge_x402_execute_receipt_adapter.mjs",
    },
    payment: {
      rail: "x402",
      asset: "USDC",
      requires_caller_pay_gate: true,
      idempotency_required: true,
      price_hint: "seller-defined per paid call",
    },
    governance: {
      bounded_runtime: true,
      notes: [
        "The adapter never auto-pays; the caller must supply pay().",
        "Payment authorization is reused on retry and only created after HTTP 402.",
        "A receipt checklist is returned from buyer-visible HTTP evidence only.",
      ],
    },
    mcp: {
      server_name: options.serverName || DEFAULT_SERVER_NAME,
      protocol: "mcp",
      tools: [
        {
          name: tool.name,
          description: tool.description,
          input_schema: clone(tool.input_schema),
          output_schema: clone(tool.output_schema),
        },
      ],
    },
    tool,
    digests: {
      manifest_digest: null,
      input_schema_digest: sha256(tool.input_schema),
      output_schema_digest: sha256(tool.output_schema),
    },
  };

  manifest.digests.manifest_digest = sha256({
    listing_id: manifest.listing_id,
    capability_id: manifest.capability_id,
    tool: manifest.tool,
    payment: manifest.payment,
    runtime: manifest.runtime,
  });

  return manifest;
}

export function validateIbanforgeInput(input) {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    throw new AdapterValidationError("execute() requires an object input");
  }
  if (!["validate", "format", "bank_lookup"].includes(input.route)) {
    throw new AdapterValidationError("route must be one of validate, format, or bank_lookup", { field: "route" });
  }
  if (typeof input.iban !== "string" || !input.iban.trim()) {
    throw new AdapterValidationError("iban must be a non-empty string", { field: "iban" });
  }
  if (input.country_hint !== undefined && (typeof input.country_hint !== "string" || !input.country_hint.trim())) {
    throw new AdapterValidationError("country_hint must be a non-empty string when provided", { field: "country_hint" });
  }
  if (input.include_bank_metadata !== undefined && typeof input.include_bank_metadata !== "boolean") {
    throw new AdapterValidationError("include_bank_metadata must be a boolean when provided", { field: "include_bank_metadata" });
  }
  if (input.metadata !== undefined && (!input.metadata || typeof input.metadata !== "object" || Array.isArray(input.metadata))) {
    throw new AdapterValidationError("metadata must be an object when provided", { field: "metadata" });
  }
}

export function buildReceiptChecklist({ response, payload, paidChallenge, idempotencyKey }) {
  const paymentReceipt = readHeader(response, "payment-receipt");
  const paymentResponse = readHeader(response, "payment-response");
  const quotedAmount = payload?.usage_receipt?.amount_usdc ?? payload?.price_usdc ?? null;
  const receiptId = payload?.usage_receipt?.receipt_id ?? payload?.receipt_id ?? paymentReceipt ?? null;

  return {
    challenge_id: paidChallenge?.challenge_id ?? null,
    idempotency_key: idempotencyKey,
    receipt_id: receiptId,
    checks: [
      {
        item: "idempotency_key_sent",
        status: idempotencyKey ? "pass" : "fail",
        evidence: idempotencyKey || "missing",
      },
      {
        item: "paid_call_completed",
        status: response.ok ? "pass" : "fail",
        evidence: `HTTP ${response.status}`,
      },
      {
        item: "payment_required_challenge_seen",
        status: paidChallenge ? "pass" : "warn",
        evidence: paidChallenge?.challenge_id || "no HTTP 402 challenge observed",
      },
      {
        item: "payment_receipt_header_captured",
        status: paymentReceipt ? "pass" : "warn",
        evidence: paymentReceipt || "missing",
      },
      {
        item: "payment_response_header_captured",
        status: paymentResponse ? "pass" : "warn",
        evidence: paymentResponse || "missing",
      },
      {
        item: "usage_receipt_body_captured",
        status: payload?.usage_receipt ? "pass" : "warn",
        evidence: payload?.usage_receipt?.receipt_id || "missing",
      },
      {
        item: "quoted_amount_captured",
        status: quotedAmount === null ? "warn" : "pass",
        evidence: quotedAmount === null ? "missing" : String(quotedAmount),
      },
    ],
    uncertainty: [
      "This checklist reflects buyer-visible HTTP headers and response body only.",
      "A payment header or usage receipt id is not independent settlement proof.",
      "Use the marketplace receipt or proof endpoint for terminal settlement confirmation.",
    ],
  };
}

export function classifyExecuteError(error) {
  if (error instanceof ExecuteNetworkError) {
    return {
      kind: "network_after_payment_authorized",
      retryable: true,
      message: error.message,
      idempotencyKey: error.details?.idempotencyKey ?? null,
      guidance: "Retry the same execute() call with the same idempotency key and reuse the existing payment authorization.",
    };
  }
  if (error instanceof ExecuteHttpError) {
    return {
      kind: "http_failure",
      retryable: error.status >= 500,
      status: error.status,
      message: error.message,
      guidance: error.status === 402
        ? "Provide an explicit pay callback gate before retrying a paid call."
        : "Inspect the HTTP body and seller response before retrying.",
    };
  }
  if (error instanceof AdapterValidationError) {
    return {
      kind: "validation",
      retryable: false,
      message: error.message,
      field: error.details?.field ?? null,
      guidance: "Fix the input payload before retrying.",
    };
  }
  return {
    kind: "unexpected",
    retryable: false,
    message: error instanceof Error ? error.message : String(error),
    guidance: "Inspect the thrown error and transport logs.",
  };
}

export class IbanforgeX402ExecuteAdapter {
  constructor(options = {}) {
    this.baseUrl = normalizeBaseUrl(options.baseUrl || DEFAULT_BASE_URL);
    this.executePath = options.executePath || DEFAULT_EXECUTE_PATH;
    this.serverName = options.serverName || DEFAULT_SERVER_NAME;
    this.fetchImpl = options.fetchImpl || globalThis.fetch;
    this.capabilityId = options.capabilityId || DEFAULT_CAPABILITY_ID;
  }

  async execute(input, options = {}) {
    validateIbanforgeInput(input);

    const idempotencyKey = input.idempotency_key || options.idempotencyKey || `ibanforge_${randomUUID()}`;
    const executeUrl = buildExecuteUrl(this.baseUrl, this.executePath);
    const manifest = createIbanforgeManifest({
      capabilityId: this.capabilityId,
      serverName: this.serverName,
    });
    const { x402Fetch, source } = await resolvePreferredX402Fetch();

    const body = {
      capability_id: manifest.capability_id,
      listing_id: manifest.listing_id,
      server_name: this.serverName,
      tool_name: manifest.tool.name,
      input: {
        route: input.route,
        iban: input.iban,
        country_hint: input.country_hint ?? null,
        include_bank_metadata: input.include_bank_metadata ?? false,
        metadata: input.metadata ?? {},
      },
    };

    const response = await x402Fetch(executeUrl, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json",
      },
      body: JSON.stringify(body),
      fetchImpl: this.fetchImpl,
      pay: options.pay,
      idempotencyKey,
      maxNetworkRetries: options.maxNetworkRetries ?? 1,
    });

    const payload = await safeJson(response);
    if (!response.ok) {
      throw new ExecuteHttpError(`ibanforge execute failed with HTTP ${response.status}`, {
        status: response.status,
        body: payload,
        headers: lowerCaseKeys(response.headers),
        idempotencyKey,
      });
    }

    const paidChallengeId = response.x402Meta?.paidChallengeId ?? null;
    const receiptChecklist = buildReceiptChecklist({
      response,
      payload,
      paidChallenge: paidChallengeId ? { challenge_id: paidChallengeId } : null,
      idempotencyKey,
    });

    return {
      invocation_id: payload?.invocation_id || `inv_${randomUUID()}`,
      capability_id: manifest.capability_id,
      output: payload?.output || {},
      usage_receipt: payload?.usage_receipt || {},
      receipt_checklist: receiptChecklist,
      seller_listing: {
        listing_id: manifest.listing_id,
        server_name: this.serverName,
        tool_name: manifest.tool.name,
      },
      wrapper: {
        x402_fetch_source: source,
        idempotency_key: idempotencyKey,
        server_name: this.serverName,
      },
      raw_response: payload,
    };
  }
}

export async function executeIbanforgeBuyerRetryExample({ fetchImpl, pay } = {}) {
  const adapter = new IbanforgeX402ExecuteAdapter({
    baseUrl: "https://ibanforge.example",
    fetchImpl,
  });

  try {
    return await adapter.execute({
      route: "validate",
      iban: "DE89370400440532013000",
      include_bank_metadata: true,
      metadata: { caller: "buyer-retry-example" },
      idempotency_key: "ibanforge_demo_retry_key",
    }, {
      pay,
      maxNetworkRetries: 1,
    });
  } catch (error) {
    return {
      ok: false,
      error: classifyExecuteError(error),
    };
  }
}

export function createMockIbanforgeFetch() {
  const state = {
    requests: [],
    payCalls: [],
    challenge: {
      challenge_id: "ch_demo_ibanforge_402",
      price_usdc: "0.02",
      pay_to: "demo:ibanforge",
      resource: "ibanforge.validate",
      network: "base-sepolia",
    },
    networkFailureInjected: false,
    authorizationByIdempotencyKey: new Map(),
  };

  async function fetchImpl(url, options = {}) {
    const headers = lowerCaseKeys(options.headers || {});
    const requestBody = typeof options.body === "string" && options.body
      ? JSON.parse(options.body)
      : null;

    state.requests.push({
      url,
      method: options.method || "GET",
      headers: clone(headers),
      body: clone(requestBody),
    });

    const idempotencyKey = headers["idempotency-key"] || null;
    const authorization = headers.authorization || headers["payment-signature"] || null;

    if (!authorization) {
      return jsonResponse(402, {
        error: "payment_required",
        challenge_id: state.challenge.challenge_id,
        price_usdc: state.challenge.price_usdc,
      }, {
        "payment-required": encodePaymentRequired(state.challenge),
      });
    }

    const expectedAuthorization = state.authorizationByIdempotencyKey.get(idempotencyKey);
    if (!expectedAuthorization || authorization !== expectedAuthorization) {
      return jsonResponse(401, { error: "invalid_payment_authorization" });
    }

    if (!state.networkFailureInjected) {
      state.networkFailureInjected = true;
      throw new Error("simulated network drop after payment authorization");
    }

    const iban = requestBody?.input?.iban || "";
    const compact = iban.replace(/\s+/g, "");
    const countryCode = compact.slice(0, 2);

    return jsonResponse(200, {
      invocation_id: "inv_demo_ibanforge_001",
      output: {
        route: requestBody?.input?.route || "validate",
        iban: compact,
        valid: compact === "DE89370400440532013000",
        country_code: countryCode,
        bank_metadata: requestBody?.input?.include_bank_metadata
          ? {
              bic: "COBADEFFXXX",
              bank_name: "Demo Bank",
            }
          : null,
      },
      usage_receipt: {
        receipt_id: "rcpt_demo_ibanforge_001",
        amount_usdc: state.challenge.price_usdc,
        settled: false,
        recorded_at: nowIso(),
      },
    }, {
      "payment-receipt": "rcpt_demo_ibanforge_001",
      "payment-response": `authorized:${state.challenge.challenge_id}`,
    });
  }

  async function pay(challenge, context) {
    state.payCalls.push({ challenge: clone(challenge), context: clone(context) });
    const authorizationHeader = `X402 demo-authorization ${challenge.challenge_id}`;
    state.authorizationByIdempotencyKey.set(context.idempotencyKey, authorizationHeader);
    return { authorizationHeader };
  }

  return { fetchImpl, pay, state };
}

export async function selfTest() {
  const mock = createMockIbanforgeFetch();
  const result = await executeIbanforgeBuyerRetryExample({
    fetchImpl: mock.fetchImpl,
    pay: mock.pay,
  });

  assert.equal(result.ok, undefined);
  assert.equal(result.output.valid, true);
  assert.equal(result.usage_receipt.receipt_id, "rcpt_demo_ibanforge_001");
  assert.equal(result.wrapper.idempotency_key, "ibanforge_demo_retry_key");
  assert.equal(mock.state.payCalls.length, 1, "pay() should only be called once");
  assert.equal(mock.state.requests.length, 3, "expected 402, one network failure attempt, then one successful retry");
  assert.equal(mock.state.requests[0].headers.authorization, undefined);
  assert.equal(mock.state.requests[1].headers.authorization, "X402 demo-authorization ch_demo_ibanforge_402");
  assert.equal(mock.state.requests[2].headers.authorization, "X402 demo-authorization ch_demo_ibanforge_402");
  assert.equal(mock.state.requests[1].headers["idempotency-key"], "ibanforge_demo_retry_key");
  assert.equal(mock.state.requests[2].headers["idempotency-key"], "ibanforge_demo_retry_key");
  assert.equal(result.receipt_checklist.receipt_id, "rcpt_demo_ibanforge_001");
  assert.equal(result.receipt_checklist.checks[0].status, "pass");
  assert.equal(result.receipt_checklist.checks[3].status, "pass");
  assert.equal(result.receipt_checklist.checks[4].status, "pass");

  return {
    ok: true,
    manifest_digest: createIbanforgeManifest().digests.manifest_digest,
    x402_fetch_source: result.wrapper.x402_fetch_source,
    pay_calls: mock.state.payCalls.length,
    request_count: mock.state.requests.length,
    idempotency_key: result.wrapper.idempotency_key,
    receipt_id: result.usage_receipt.receipt_id,
    valid_iban: result.output.valid,
  };
}

async function main() {
  const report = await selfTest();
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    process.stderr.write(`${error.stack || error.message}\n`);
    process.exitCode = 1;
  });
}
