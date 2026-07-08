#!/usr/bin/env node
/* demo — simulates x402 payment authorization and usage receipts; moves no real funds */

import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import { createHash, randomUUID } from "node:crypto";
import process from "node:process";
import { pathToFileURL } from "node:url";

const DEFAULT_BASE_URL = process.env.AGORAGENTIC_BASE_URL || "https://agoragentic.example";
const DEFAULT_EXECUTE_PATH = "/api/x402/execute";
const DEFAULT_CAPABILITY_ID = "agoragentic.apiad.aegis.execute.v1";
const DEFAULT_TOOL_NAME = "run_aegis_tool";
const DEFAULT_SERVER_NAME = "apiad-aegis";

function clone(value) {
  return value === undefined ? undefined : JSON.parse(JSON.stringify(value));
}

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

function nowIso() {
  return new Date().toISOString();
}

function normalizeBaseUrl(value) {
  return String(value || DEFAULT_BASE_URL).replace(/\/+$/, "");
}

function lowerCaseHeaders(headers = {}) {
  if (headers instanceof Headers) {
    return Object.fromEntries(Array.from(headers.entries(), ([key, val]) => [String(key).toLowerCase(), String(val)]));
  }
  return Object.fromEntries(Object.entries(headers).map(([key, val]) => [String(key).toLowerCase(), String(val)]));
}

function jsonResponse(status, body, headers = {}) {
  const normalized = lowerCaseHeaders(headers);
  return {
    status,
    ok: status >= 200 && status < 300,
    headers: new Map(Object.entries(normalized)),
    async json() {
      return clone(body);
    },
    async text() {
      return JSON.stringify(body, null, 2);
    },
  };
}

async function readJsonSafe(response) {
  if (!response || typeof response.json !== "function") return null;
  try {
    return await response.json();
  } catch {
    return null;
  }
}

async function readTextSafe(response) {
  if (!response || typeof response.text !== "function") return "";
  try {
    return await response.text();
  } catch {
    return "";
  }
}

function getHeader(response, name) {
  if (!response?.headers) return undefined;
  const lowered = String(name).toLowerCase();
  if (typeof response.headers.get === "function") {
    return response.headers.get(lowered) || response.headers.get(name);
  }
  if (response.headers instanceof Map) {
    return response.headers.get(lowered) || response.headers.get(name);
  }
  const headers = lowerCaseHeaders(response.headers);
  return headers[lowered];
}

function isRecord(value) {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function parseJsonMaybe(value) {
  if (typeof value !== "string" || !value.trim()) return null;
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}

function decodePaymentRequiredHeader(value) {
  if (typeof value !== "string" || !value.trim()) return null;
  const text = value.trim();
  const parsed = parseJsonMaybe(text);
  if (parsed !== null) return parsed;

  try {
    const decoded = Buffer.from(text, "base64").toString("utf8");
    return parseJsonMaybe(decoded);
  } catch {
    return null;
  }
}

function firstRecord(value) {
  if (Array.isArray(value)) {
    return value.find((entry) => isRecord(entry)) || null;
  }
  if (isRecord(value)) return value;
  return null;
}

function normalizePaymentChallenge(response, body) {
  const paymentRequired =
    decodePaymentRequiredHeader(getHeader(response, "payment-required")) ||
    decodePaymentRequiredHeader(getHeader(response, "x-payment-required"));
  const bodyRecord = firstRecord(body);
  const requirementRecord =
    firstRecord(paymentRequired) ||
    firstRecord(bodyRecord?.requirements) ||
    firstRecord(bodyRecord?.paymentRequirements) ||
    firstRecord(bodyRecord?.payment_required);
  const challenge = {
    ...(bodyRecord || {}),
    ...(requirementRecord || {}),
  };

  challenge.challenge_id =
    challenge.challenge_id ||
    challenge.challengeId ||
    challenge.nonce ||
    challenge.resource ||
    getHeader(response, "x-payment-challenge-id") ||
    null;
  challenge.challenge =
    challenge.challenge ||
    challenge.challengeToken ||
    challenge.resource ||
    getHeader(response, "x-payment-challenge") ||
    null;
  if (paymentRequired !== null) {
    challenge.payment_required = clone(paymentRequired);
  }

  return challenge;
}

function coerceFiniteNumber(value) {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim()) {
    const normalized = Number(value);
    return Number.isFinite(normalized) ? normalized : null;
  }
  return null;
}

function collectChallengeRecords(challenge) {
  const records = [];
  if (isRecord(challenge)) records.push(challenge);
  const paymentRequired = challenge?.payment_required;
  if (Array.isArray(paymentRequired)) {
    records.push(...paymentRequired.filter(isRecord));
  } else if (isRecord(paymentRequired)) {
    records.push(paymentRequired);
  }
  return records;
}

function extractChallengeAmountUsdc(challenge) {
  const candidateKeys = [
    "max_amount_usdc",
    "amount_usdc",
    "price_usdc",
    "max_amount",
    "amount",
    "value",
    "maxAmount",
    "maxAmountRequired",
  ];

  for (const record of collectChallengeRecords(challenge)) {
    for (const key of candidateKeys) {
      const value = coerceFiniteNumber(record[key]);
      if (value === null) continue;
      const looksLikeMicroUsdc =
        key === "maxAmountRequired" || key.toLowerCase().includes("micro") || value > 1000;
      return looksLikeMicroUsdc ? value / 1_000_000 : value;
    }
  }
  return null;
}

function enforcePriceCeilingBeforePayment(challenge, maxPriceUsdc) {
  const ceiling = coerceFiniteNumber(maxPriceUsdc);
  if (ceiling === null) return;

  const requestedAmountUsdc = extractChallengeAmountUsdc(challenge);
  if (requestedAmountUsdc !== null && requestedAmountUsdc > ceiling) {
    throw new HttpFailure("x402 challenge exceeds caller price ceiling; refusing to authorize payment", {
      status: 402,
      max_price_usdc: ceiling,
      challenge_amount_usdc: requestedAmountUsdc,
      challenge,
    });
  }
}

function buildPaymentHeaders(authorization) {
  if (!authorization || typeof authorization !== "object") {
    throw new Error("pay() must return an object with authorization headers or token data");
  }

  const headers = lowerCaseHeaders(authorization.headers || {});
  const paymentSignature =
    authorization.paymentSignature || authorization.payment_signature || authorization.signature || headers["payment-signature"];
  if (paymentSignature && !headers["payment-signature"]) {
    headers["payment-signature"] = String(paymentSignature);
  }
  if (authorization.authorization && !headers["x-payment-authorization"]) {
    headers["x-payment-authorization"] = String(authorization.authorization);
  }
  if (authorization.receipt && !headers["x-payment-receipt"]) {
    headers["x-payment-receipt"] =
      typeof authorization.receipt === "string" ? authorization.receipt : JSON.stringify(authorization.receipt);
  }

  if (!headers["payment-signature"] && !headers["x-payment-authorization"]) {
    throw new Error("pay() result must include PAYMENT-SIGNATURE, x-payment-authorization, or authorization text");
  }

  return headers;
}

class HttpFailure extends Error {
  constructor(message, details = {}) {
    super(message);
    this.name = "HttpFailure";
    this.details = details;
  }
}

class NetworkFailure extends Error {
  constructor(message, details = {}) {
    super(message);
    this.name = "NetworkFailure";
    this.details = details;
  }
}

async function importPreferredX402Fetch() {
  const candidates = [
    "agoragentic/x402-client",
    new URL("../lib/x402-client.mjs", import.meta.url).href,
    new URL("../x402-client.mjs", import.meta.url).href,
  ];

  for (const candidate of candidates) {
    try {
      const mod = await import(candidate);
      if (typeof mod.x402Fetch === "function") {
        return { x402Fetch: mod.x402Fetch, source: candidate };
      }
    } catch {
      // Try next candidate.
    }
  }

  return { x402Fetch: createFallbackX402Fetch(), source: "local-fallback" };
}

function createFallbackX402Fetch() {
  return async function x402Fetch(url, options = {}) {
    const fetchImpl = options.fetchImpl || globalThis.fetch;
    if (typeof fetchImpl !== "function") {
      throw new Error("x402Fetch requires fetchImpl or globalThis.fetch");
    }

    const method = String(options.method || "GET").toUpperCase();
    const idempotencyKey = String(options.idempotencyKey || randomUUID());
    const baseHeaders = lowerCaseHeaders(options.headers || {});
    const maxTransportRetries = Number.isInteger(options.maxTransportRetries) ? Math.max(0, options.maxTransportRetries) : 1;
    let paymentHeaders = {};
    let paidChallengeDigest = null;
    let transportRetriesRemaining = 0;

    const issueRequest = async () => {
      const requestHeaders = {
        ...baseHeaders,
        ...paymentHeaders,
        "x-idempotency-key": idempotencyKey,
      };
      return fetchImpl(url, {
        ...options,
        method,
        headers: requestHeaders,
      });
    };

    for (;;) {
      let response;
      try {
        response = await issueRequest();
      } catch (error) {
        if (Object.keys(paymentHeaders).length > 0 && transportRetriesRemaining > 0) {
          transportRetriesRemaining -= 1;
          continue;
        }
        throw new NetworkFailure("network error while calling x402 endpoint", {
          cause: error instanceof Error ? error.message : String(error),
          idempotency_key: idempotencyKey,
          paid_challenge_digest: paidChallengeDigest,
        });
      }

      if (response.status !== 402) {
        if (!response.ok) {
          throw new HttpFailure(`HTTP ${response.status} from marketplace execute`, {
            status: response.status,
            body: await readTextSafe(response),
            idempotency_key: idempotencyKey,
            paid_challenge_digest: paidChallengeDigest,
          });
        }
        response.x402Meta = {
          helper_source: "local-fallback",
          idempotency_key: idempotencyKey,
          paid_challenge_digest: paidChallengeDigest,
        };
        return response;
      }

      if (typeof options.pay !== "function") {
        throw new Error("paid x402 call requires a caller-supplied pay() callback after HTTP 402");
      }

      const challengeBody = await readJsonSafe(response);
      const challenge = normalizePaymentChallenge(response, challengeBody);
      const challengeDigest = sha256(challenge);

      if (paidChallengeDigest) {
        throw new HttpFailure("received HTTP 402 after payment authorization; refusing to re-authorize or replay payment", {
          status: 402,
          challenge,
          idempotency_key: idempotencyKey,
          challenge_digest: challengeDigest,
          paid_challenge_digest: paidChallengeDigest,
        });
      }

      enforcePriceCeilingBeforePayment(challenge, options.maxPriceUsdc);

      const authorization = await options.pay({
        url,
        method,
        idempotencyKey,
        headers: clone(baseHeaders),
        body: options.body,
        challenge,
      });

      paymentHeaders = buildPaymentHeaders(authorization);
      paidChallengeDigest = challengeDigest;
      transportRetriesRemaining = maxTransportRetries;
    }
  };
}

function validateExecuteInput(input) {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    throw new Error("execute() requires an object payload");
  }
  if (typeof input.tool_name !== "string" || !input.tool_name.trim()) {
    throw new Error("tool_name must be a non-empty string");
  }
  if (input.arguments !== undefined && (!input.arguments || typeof input.arguments !== "object" || Array.isArray(input.arguments))) {
    throw new Error("arguments must be an object when provided");
  }
  if (input.trust_context !== undefined && (!input.trust_context || typeof input.trust_context !== "object" || Array.isArray(input.trust_context))) {
    throw new Error("trust_context must be an object when provided");
  }
  if (input.usage_policy !== undefined) {
    if (!input.usage_policy || typeof input.usage_policy !== "object" || Array.isArray(input.usage_policy)) {
      throw new Error("usage_policy must be an object when provided");
    }
    if (
      input.usage_policy.max_price_usdc !== undefined &&
      (typeof input.usage_policy.max_price_usdc !== "number" || input.usage_policy.max_price_usdc <= 0)
    ) {
      throw new Error("usage_policy.max_price_usdc must be a positive number when provided");
    }
  }
  if (input.idempotency_key !== undefined && (typeof input.idempotency_key !== "string" || !input.idempotency_key.trim())) {
    throw new Error("idempotency_key must be a non-empty string when provided");
  }
}

export function createAegisCapabilityManifest(options = {}) {
  const tool = {
    name: options.wrapper_tool_name || DEFAULT_TOOL_NAME,
    description: "Package a bounded apiad/aegis tool invocation as a trust-checked Agoragentic marketplace capability with usage receipts.",
    input_schema: {
      type: "object",
      additionalProperties: false,
      required: ["tool_name"],
      properties: {
        tool_name: {
          type: "string",
          description: "Underlying apiad/aegis tool name to call.",
        },
        arguments: {
          type: "object",
          additionalProperties: true,
          description: "JSON arguments forwarded to the underlying tool.",
        },
        trust_context: {
          type: "object",
          additionalProperties: true,
          description: "Optional governance metadata such as requester, scope, and review tags.",
        },
        usage_policy: {
          type: "object",
          additionalProperties: false,
          properties: {
            max_price_usdc: {
              type: "number",
              minimum: 0.001,
              description: "Caller-enforced price ceiling for the paid execute() call.",
            },
            bill_to: {
              type: "string",
              description: "Who should be associated with the usage receipt.",
            },
            require_receipt: {
              type: "boolean",
              default: true,
            },
          },
        },
        idempotency_key: {
          type: "string",
          description: "Optional caller-supplied idempotency key. Generated if omitted.",
        },
      },
    },
    output_schema: {
      type: "object",
      additionalProperties: false,
      required: ["invocation_id", "capability_id", "upstream", "output", "usage_receipt", "trust_summary", "wrapper"],
      properties: {
        invocation_id: { type: "string" },
        capability_id: { type: "string" },
        upstream: { type: "object", additionalProperties: true },
        output: { type: "object", additionalProperties: true },
        usage_receipt: { type: "object", additionalProperties: true },
        trust_summary: { type: "object", additionalProperties: true },
        wrapper: { type: "object", additionalProperties: true },
      },
    },
  };

  const trustChecks = [
    {
      id: "bounded_execute_wrapper",
      description: "The wrapper exposes one bounded execute() entrypoint with explicit schemas and no hidden side-effect paths.",
    },
    {
      id: "caller_pay_gate_required",
      description: "A payment authorization callback is required only after the marketplace returns HTTP 402.",
    },
    {
      id: "authorization_reused_on_retry",
      description: "Transport retries reuse the existing payment authorization and do not re-authorize unless the server issues a new HTTP 402 challenge.",
    },
    {
      id: "idempotency_key_always_sent",
      description: "Every marketplace execute() request carries an idempotency key.",
    },
    {
      id: "usage_receipt_emitted",
      description: "Successful executions emit a usage receipt with manifest, request, response, and trust digests.",
    },
  ];

  const manifest = {
    manifest_version: "0.1.0",
    capability_id: options.capability_id || DEFAULT_CAPABILITY_ID,
    title: "apiad/aegis local execute() usage wrapper",
    summary:
      "Runnable local wrapper showing how to package an apiad/aegis tool as a trust-checked marketplace capability with x402 payment gating and buyer-visible usage receipts.",
    source_repository: "https://github.com/rhein1/agoragentic-integrations",
    source_path: options.source_path || "examples/apiad_aegis_local_execute_usage_wrapper.mjs",
    seller: {
      id: "apiad/aegis",
      display_name: "apiad-aegis",
      server_name: options.server_name || DEFAULT_SERVER_NAME,
    },
    execution: {
      kind: "local-mcp-wrapper",
      transport: "marketplace.execute",
      path: options.execute_path || DEFAULT_EXECUTE_PATH,
      wrapper_runtime: "node>=18",
      requires_caller_pay_gate: true,
    },
    payment: {
      rail: "x402",
      asset: "USDC",
      max_price_usdc: "0.02",
      idempotency_required: true,
      requires_caller_pay_gate: true,
    },
    trust: {
      mode: "trust-checked",
      checks: trustChecks,
    },
    tool,
  };

  return {
    ...manifest,
    digests: {
      manifest_digest: sha256(manifest),
      input_schema_digest: sha256(tool.input_schema),
      output_schema_digest: sha256(tool.output_schema),
      trust_checks_digest: sha256(trustChecks),
    },
  };
}

function buildExecutePayload(input, manifest, idempotencyKey) {
  const callerTrustContext = clone(input.trust_context || {});
  return {
    capability_id: manifest.capability_id,
    seller: clone(manifest.seller),
    tool: {
      name: input.tool_name,
      arguments: clone(input.arguments || {}),
    },
    trust_context: {
      ...callerTrustContext,
      requester: callerTrustContext.requester || "local-demo",
      scope: callerTrustContext.scope || "read-only",
      review_tags: clone(callerTrustContext.review_tags || ["trust-checked", "receipt-enabled"]),
      approval_ref: callerTrustContext.approval_ref || null,
    },
    usage_policy: {
      max_price_usdc: input.usage_policy?.max_price_usdc ?? 0.02,
      bill_to: input.usage_policy?.bill_to || "demo-buyer",
      require_receipt: input.usage_policy?.require_receipt !== false,
    },
    idempotency_key: idempotencyKey,
  };
}

function buildTrustSummary(manifest, input, result, x402Meta) {
  return {
    mode: manifest.trust.mode,
    checks: manifest.trust.checks.map((check) => check.id),
    review_tags: clone(input.trust_context?.review_tags || ["trust-checked", "receipt-enabled"]),
    paid_challenge_digest: x402Meta?.paid_challenge_digest || null,
    helper_source: x402Meta?.helper_source || null,
    upstream_trust_status: result?.trust_status || "unknown",
  };
}

function createUsageReceipt({ manifest, executePayload, responseBody, idempotencyKey, x402Meta }) {
  const upstreamReceipt = responseBody?.usage_receipt || {};
  const output = responseBody?.output || {};
  const trustSummary = responseBody?.trust_summary || {};

  return {
    receipt_id: upstreamReceipt.receipt_id || `usage_${sha256(`${idempotencyKey}:${manifest.capability_id}`).slice(0, 16)}`,
    created_at: upstreamReceipt.created_at || nowIso(),
    capability_id: manifest.capability_id,
    seller_id: manifest.seller.id,
    idempotency_key: idempotencyKey,
    settlement_state: upstreamReceipt.settlement_state || "authorization-required-or-simulated",
    paid_challenge_digest: x402Meta?.paid_challenge_digest || null,
    manifest_digest: manifest.digests.manifest_digest,
    request_digest: sha256(executePayload),
    output_digest: sha256(output),
    trust_digest: sha256({ trust: manifest.trust, trustSummary }),
    amount: clone(upstreamReceipt.amount || { asset: "USDC", value: "0.02" }),
    meter: clone(upstreamReceipt.meter || { unit: "tool_call", quantity: 1 }),
    upstream_receipt: clone(upstreamReceipt),
  };
}

export async function executeAegisCapability(input, options = {}) {
  validateExecuteInput(input);
  const manifest = createAegisCapabilityManifest(options);
  const idempotencyKey = input.idempotency_key || `aegis_${randomUUID()}`;
  const executePayload = buildExecutePayload(input, manifest, idempotencyKey);
  const { x402Fetch, source } = options.x402Fetch
    ? { x402Fetch: options.x402Fetch, source: options.x402FetchSource || "caller-supplied" }
    : await importPreferredX402Fetch();
  const fetchImpl = options.fetchImpl || globalThis.fetch;

  if (typeof fetchImpl !== "function") {
    throw new Error("executeAegisCapability requires fetchImpl or globalThis.fetch");
  }

  const response = await x402Fetch(`${normalizeBaseUrl(options.baseUrl) || DEFAULT_BASE_URL}${manifest.execution.path}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      accept: "application/json",
      "x-capability-id": manifest.capability_id,
      "x-trust-mode": manifest.trust.mode,
    },
    body: JSON.stringify(executePayload),
    fetchImpl,
    pay: options.pay,
    idempotencyKey,
    maxTransportRetries: 1,
    maxPriceUsdc: executePayload.usage_policy.max_price_usdc,
  });

  const responseBody = await readJsonSafe(response);
  if (!responseBody || typeof responseBody !== "object") {
    throw new Error("marketplace execute returned a non-JSON response body");
  }

  const trustSummary = buildTrustSummary(manifest, input, responseBody, response.x402Meta);
  const usageReceipt = createUsageReceipt({
    manifest,
    executePayload,
    responseBody,
    idempotencyKey,
    x402Meta: response.x402Meta,
  });

  return {
    invocation_id: responseBody.invocation_id || `inv_${randomUUID()}`,
    capability_id: manifest.capability_id,
    upstream: {
      seller_id: manifest.seller.id,
      server_name: manifest.seller.server_name,
      tool_name: input.tool_name,
      http_status: response.status,
    },
    output: clone(responseBody.output || {}),
    usage_receipt: usageReceipt,
    trust_summary: trustSummary,
    wrapper: {
      helper_source: source,
      idempotency_key: idempotencyKey,
      input_schema_digest: manifest.digests.input_schema_digest,
      output_schema_digest: manifest.digests.output_schema_digest,
      manifest_digest: manifest.digests.manifest_digest,
    },
  };
}

export function createMockMarketplaceFetch() {
  const calls = [];
  let challengeCount = 0;

  const fetchImpl = async (url, request = {}) => {
    const headers = lowerCaseHeaders(request.headers || {});
    const body = request.body ? JSON.parse(request.body) : {};
    calls.push({
      url,
      method: request.method || "GET",
      headers: clone(headers),
      body: clone(body),
    });

    if (!headers["x-payment-authorization"] && !headers["payment-signature"]) {
      challengeCount += 1;
      return jsonResponse(
        402,
        {
          challenge_id: `challenge_${challengeCount}`,
          network: "base-sepolia",
          asset: "USDC",
          max_amount: "0.02",
          pay_to: "demo-seller",
          memo: sha256({ url, body }),
        },
        { "content-type": "application/json" },
      );
    }

    return jsonResponse(
      200,
      {
        invocation_id: `inv_${sha256(body).slice(0, 12)}`,
        trust_status: "checked",
        output: {
          tool_name: body.tool?.name,
          approved: true,
          findings: [
            "input schema accepted",
            "bounded capability envelope attached",
            "usage receipt ready",
          ],
          echoed_arguments: clone(body.tool?.arguments || {}),
        },
        trust_summary: {
          policy: "bounded-read-only",
          checks: ["schema", "scope", "receipt"],
        },
        usage_receipt: {
          receipt_id: `rcpt_${sha256(body.idempotency_key).slice(0, 12)}`,
          created_at: nowIso(),
          settlement_state: "simulated",
          amount: { asset: "USDC", value: "0.02" },
          meter: { unit: "tool_call", quantity: 1 },
        },
      },
      { "content-type": "application/json" },
    );
  };

  return {
    fetchImpl,
    getCalls() {
      return clone(calls);
    },
  };
}

export async function selfTest() {
  const mock = createMockMarketplaceFetch();
  const payCalls = [];

  const result = await executeAegisCapability(
    {
      tool_name: "aegis.search_alerts",
      arguments: {
        query: "receipt-enabled capability wrappers",
        limit: 3,
      },
      trust_context: {
        requester: "self-test",
        scope: "read-only",
        review_tags: ["self-test", "trust-checked"],
      },
      usage_policy: {
        max_price_usdc: 0.02,
        bill_to: "self-test-buyer",
        require_receipt: true,
      },
      idempotency_key: "idem_self_test_apiad_aegis",
    },
    {
      baseUrl: "https://marketplace.example",
      fetchImpl: mock.fetchImpl,
      async pay(context) {
        payCalls.push(clone(context));
        return {
          headers: {
            "payment-signature": `demo-signature:${sha256(context.challenge).slice(0, 24)}`,
            "x-payment-receipt": JSON.stringify({ demo: true, challenge_id: context.challenge.challenge_id }),
          },
        };
      },
    },
  );

  const calls = mock.getCalls();
  assert.equal(payCalls.length, 1, "pay() should run exactly once for one HTTP 402 challenge");
  assert.equal(calls.length, 2, "wrapper should make one initial request and one authorized retry");
  assert.equal(calls[0].headers["x-idempotency-key"], "idem_self_test_apiad_aegis");
  assert.equal(calls[1].headers["x-idempotency-key"], "idem_self_test_apiad_aegis");
  assert.ok(!calls[0].headers["x-payment-authorization"], "first request must be unpaid");
  assert.ok(calls[1].headers["payment-signature"], "authorized retry must include PAYMENT-SIGNATURE");
  assert.equal(result.trust_summary.mode, "trust-checked");
  assert.equal(result.usage_receipt.settlement_state, "simulated");
  assert.equal(result.output.approved, true);
  assert.equal(result.wrapper.idempotency_key, "idem_self_test_apiad_aegis");
  assert.equal(result.upstream.tool_name, "aegis.search_alerts");

  return {
    ok: true,
    helper_source: result.wrapper.helper_source,
    pay_calls: payCalls.length,
    receipt_id: result.usage_receipt.receipt_id,
    paid_challenge_digest: result.trust_summary.paid_challenge_digest,
    request_count: calls.length,
  };
}

async function main(argv = process.argv.slice(2)) {
  if (argv.includes("--self-test")) {
    const summary = await selfTest();
    process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`);
    return;
  }

  const inputArg = argv.find((value) => value.startsWith("--input="));
  const input = inputArg
    ? JSON.parse(inputArg.slice("--input=".length))
    : {
        tool_name: "aegis.search_alerts",
        arguments: { query: "trust-checked marketplace capability", limit: 2 },
        trust_context: { requester: "demo", scope: "read-only", review_tags: ["demo", "receipt-enabled"] },
        usage_policy: { max_price_usdc: 0.02, bill_to: "demo-buyer", require_receipt: true },
        idempotency_key: "idem_demo_apiad_aegis",
      };

  const mock = createMockMarketplaceFetch();
  const result = await executeAegisCapability(input, {
    baseUrl: "https://marketplace.example",
    fetchImpl: mock.fetchImpl,
    async pay(context) {
      return {
        headers: {
          "payment-signature": `demo-signature:${sha256(context.challenge).slice(0, 24)}`,
          "x-payment-receipt": JSON.stringify({ demo: true, challenge_id: context.challenge.challenge_id }),
        },
      };
    },
  });

  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    const details = error && typeof error === "object" && "details" in error ? error.details : undefined;
    process.stderr.write(
      `${JSON.stringify({ name: error?.name || "Error", message: error?.message || String(error), details }, null, 2)}\n`,
    );
    process.exitCode = 1;
  });
}
