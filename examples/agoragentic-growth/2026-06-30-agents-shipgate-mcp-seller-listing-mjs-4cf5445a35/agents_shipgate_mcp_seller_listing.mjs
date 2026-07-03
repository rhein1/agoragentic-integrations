#!/usr/bin/env node
// demo — uses simulated x402 challenges, payment authorization, and usage receipts; moves no real funds.

import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import process from "node:process";
import { pathToFileURL } from "node:url";

const DEFAULT_BASE_URL = process.env.AGORAGENTIC_BASE_URL || "https://agoragentic.example";
const DEFAULT_EXECUTE_PATH = "/v1/marketplace/execute";
const SOURCE_PATH = "examples/agoragentic-growth/2026-06-30-agents-shipgate-mcp-seller-listing-mjs-4cf5445a35/agents_shipgate_mcp_seller_listing.mjs";
const MIN_PRICE_USDC = 0.001;

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
  return createHash("sha256").update(typeof value === "string" ? value : stableStringify(value)).digest("hex");
}

function nowIso() {
  return new Date().toISOString();
}

function clone(value) {
  return value === undefined ? undefined : JSON.parse(JSON.stringify(value));
}

function lowerCaseKeys(value = {}) {
  if (value instanceof Headers) {
    return Object.fromEntries(Array.from(value.entries(), ([k, v]) => [String(k).toLowerCase(), v]));
  }
  return Object.fromEntries(Object.entries(value).map(([k, v]) => [String(k).toLowerCase(), v]));
}

function jsonResponse(status, body, headers = {}) {
  return {
    status,
    ok: status >= 200 && status < 300,
    headers: new Map(Object.entries(lowerCaseKeys(headers))),
    async json() {
      return clone(body);
    },
    async text() {
      return JSON.stringify(body, null, 2);
    },
  };
}

function buildShipgateSkill() {
  return {
    skill_id: "agents-shipgate.governed-runtime.execute.v1",
    source_repository: "https://github.com/rhein1/agoragentic-integrations",
    source_path: SOURCE_PATH,
    title: "agents-shipgate Governed Runtime",
    summary:
      "Package a bounded agents-shipgate runtime request into a marketplace execute() call that returns structured output, recovery metadata, and a usage receipt.",
    prompt_template: [
      "You operate a governed agents-shipgate runtime.",
      "Validate route, capability, budget, and runtime controls.",
      "Return JSON with shipgate_plan, dispatch_summary, governance_checks, usage_notes, and escalation_notes.",
      "Task brief: {{task_brief}}",
      "Target route: {{target_route}}",
      "Runtime policy: {{runtime_policy}}",
      "Usage policy: {{usage_policy}}",
      "Caller note: {{caller_note}}",
    ].join("\n"),
    input_schema: {
      type: "object",
      additionalProperties: false,
      required: ["task_brief", "target_route", "runtime_policy", "usage_policy"],
      properties: {
        task_brief: { type: "string", minLength: 12 },
        target_route: {
          type: "object",
          additionalProperties: false,
          required: ["agent_ref", "operation", "max_hops"],
          properties: {
            agent_ref: { type: "string", minLength: 3 },
            operation: { type: "string", minLength: 3 },
            max_hops: { type: "integer", minimum: 1, maximum: 8 },
            preferred_region: { type: "string" },
            require_receipt_settlement: { type: "boolean", default: true },
          },
        },
        runtime_policy: {
          type: "object",
          additionalProperties: false,
          required: ["timeout_seconds", "max_retries", "approval_mode"],
          properties: {
            timeout_seconds: { type: "integer", minimum: 5, maximum: 600 },
            max_retries: { type: "integer", minimum: 0, maximum: 5 },
            approval_mode: { type: "string", enum: ["bounded", "human-review", "receipt-only"] },
            dry_run: { type: "boolean", default: false },
          },
        },
        usage_policy: {
          type: "object",
          additionalProperties: false,
          required: ["max_price_usdc", "bill_to", "require_idempotency_key"],
          properties: {
            max_price_usdc: { type: "number", minimum: 0.001, maximum: 50 },
            bill_to: { type: "string", minLength: 3 },
            require_idempotency_key: { type: "boolean" },
            receipt_scope: { type: "string", enum: ["summary", "full"] },
          },
        },
        caller_note: { type: "string" },
      },
    },
    output_schema: {
      type: "object",
      additionalProperties: false,
      required: ["shipgate_plan", "dispatch_summary", "governance_checks", "usage_notes", "escalation_notes"],
      properties: {
        shipgate_plan: { type: "array", items: { type: "string" } },
        dispatch_summary: { type: "string" },
        governance_checks: { type: "array", items: { type: "string" } },
        usage_notes: { type: "array", items: { type: "string" } },
        escalation_notes: { type: "array", items: { type: "string" } },
      },
    },
  };
}

export function buildSellerManifest() {
  const skill = buildShipgateSkill();
  const trustChecks = [
    {
      id: "execute_scope_locked",
      description: "The adapter exposes one bounded execute() entrypoint with explicit input and output schemas.",
    },
    {
      id: "x402_helper_preferred",
      description: "The adapter imports agoragentic/x402-client when available and otherwise falls back to a demo-compatible helper with the same payment safety rules.",
    },
    {
      id: "usage_receipt_emitted",
      description: "Each successful invocation emits a usage receipt with manifest, input, output, and recovery digests.",
    },
    {
      id: "retry_reuses_authorization",
      description: "Payment authorization is obtained only after an HTTP 402 challenge and is reused on retry instead of re-authorizing on every attempt.",
    },
    {
      id: "idempotency_required",
      description: "Every marketplace execute() request carries an idempotency key.",
    },
  ];

  const digests = {
    prompt_template_digest: sha256(skill.prompt_template),
    input_schema_digest: sha256(skill.input_schema),
    output_schema_digest: sha256(skill.output_schema),
    trust_checks_digest: sha256(trustChecks),
  };

  const manifest = {
    manifest_version: "0.1.0",
    seller_id: "rhein1.agents-shipgate",
    capability_id: "agoragentic.agents_shipgate_governed_runtime.v1",
    title: "agents-shipgate Governed Runtime",
    summary:
      "MCP seller listing manifest for a governed, receipt-enabled agents-shipgate runtime adapter with retry-safe execute() recovery.",
    upstream: {
      repository: skill.source_repository,
      path: skill.source_path,
      skill_id: skill.skill_id,
    },
    execution: {
      kind: "local-mcp-wrapper",
      transport: "marketplace.execute",
      path: DEFAULT_EXECUTE_PATH,
      timeout_ms: 30000,
    },
    payment: {
      rail: "x402",
      asset: "USDC",
      max_price_usdc: "0.03",
      requires_caller_pay_gate: true,
      idempotency_required: true,
    },
    trust: {
      mode: "trust-checked",
      checks: trustChecks,
    },
    tool: {
      name: "execute",
      description: "Validate and submit a bounded agents-shipgate runtime request and return a usage receipt.",
      input_schema: skill.input_schema,
      output_schema: skill.output_schema,
    },
    digests: {
      ...digests,
    },
    skill,
  };
  manifest.digests.manifest_digest = sha256({
    manifest_version: manifest.manifest_version,
    seller_id: manifest.seller_id,
    capability_id: manifest.capability_id,
    upstream: manifest.upstream,
    execution: manifest.execution,
    payment: manifest.payment,
    tool: {
      name: manifest.tool.name,
      description: manifest.tool.description,
      input_schema: manifest.tool.input_schema,
      output_schema: manifest.tool.output_schema,
    },
    trust: manifest.trust,
    digests,
  });
  return manifest;
}

function rejectUnexpectedKeys(value, allowed, path) {
  for (const key of Object.keys(value || {})) {
    if (!allowed.includes(key)) {
      throw new Error(`${path}.${key} is not allowed by the published schema`);
    }
  }
}

function validatePublishedExecuteInput(input) {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    throw new Error("execute() requires an object payload");
  }
  rejectUnexpectedKeys(input, ["task_brief", "target_route", "runtime_policy", "usage_policy", "caller_note"], "input");
  if (typeof input.task_brief !== "string" || input.task_brief.trim().length < 12) {
    throw new Error("task_brief must be a string with at least 12 characters");
  }

  const route = input.target_route;
  if (!route || typeof route !== "object" || Array.isArray(route)) {
    throw new Error("target_route must be an object");
  }
  rejectUnexpectedKeys(route, ["agent_ref", "operation", "max_hops", "preferred_region", "require_receipt_settlement"], "target_route");
  if (typeof route.agent_ref !== "string" || route.agent_ref.trim().length < 3) {
    throw new Error("target_route.agent_ref must be a non-empty string");
  }
  if (typeof route.operation !== "string" || route.operation.trim().length < 3) {
    throw new Error("target_route.operation must be a non-empty string");
  }
  if (!Number.isInteger(route.max_hops) || route.max_hops < 1 || route.max_hops > 8) {
    throw new Error("target_route.max_hops must be an integer between 1 and 8");
  }
  if (route.preferred_region !== undefined && typeof route.preferred_region !== "string") {
    throw new Error("target_route.preferred_region must be a string when provided");
  }
  if (route.require_receipt_settlement !== undefined && typeof route.require_receipt_settlement !== "boolean") {
    throw new Error("target_route.require_receipt_settlement must be a boolean when provided");
  }

  const runtime = input.runtime_policy;
  if (!runtime || typeof runtime !== "object" || Array.isArray(runtime)) {
    throw new Error("runtime_policy must be an object");
  }
  rejectUnexpectedKeys(runtime, ["timeout_seconds", "max_retries", "approval_mode", "dry_run"], "runtime_policy");
  if (!Number.isInteger(runtime.timeout_seconds) || runtime.timeout_seconds < 5 || runtime.timeout_seconds > 600) {
    throw new Error("runtime_policy.timeout_seconds must be an integer between 5 and 600");
  }
  if (!Number.isInteger(runtime.max_retries) || runtime.max_retries < 0 || runtime.max_retries > 5) {
    throw new Error("runtime_policy.max_retries must be an integer between 0 and 5");
  }
  if (!["bounded", "human-review", "receipt-only"].includes(runtime.approval_mode)) {
    throw new Error("runtime_policy.approval_mode must be one of bounded, human-review, receipt-only");
  }
  if (runtime.dry_run !== undefined && typeof runtime.dry_run !== "boolean") {
    throw new Error("runtime_policy.dry_run must be a boolean when provided");
  }

  const usage = input.usage_policy;
  if (!usage || typeof usage !== "object" || Array.isArray(usage)) {
    throw new Error("usage_policy must be an object");
  }
  rejectUnexpectedKeys(usage, ["max_price_usdc", "bill_to", "require_idempotency_key", "receipt_scope"], "usage_policy");
  if (typeof usage.max_price_usdc !== "number" || usage.max_price_usdc < MIN_PRICE_USDC || usage.max_price_usdc > 50) {
    throw new Error("usage_policy.max_price_usdc must be a number between 0.001 and 50");
  }
  if (typeof usage.bill_to !== "string" || usage.bill_to.trim().length < 3) {
    throw new Error("usage_policy.bill_to must be a non-empty string");
  }
  if (typeof usage.require_idempotency_key !== "boolean") {
    throw new Error("usage_policy.require_idempotency_key must be a boolean");
  }
  if (usage.receipt_scope !== undefined && !["summary", "full"].includes(usage.receipt_scope)) {
    throw new Error("usage_policy.receipt_scope must be summary or full when provided");
  }

  if (input.caller_note !== undefined && typeof input.caller_note !== "string") {
    throw new Error("caller_note must be a string when provided");
  }
}

function simulateShipgateOutput(input) {
  const route = input.target_route;
  const runtime = input.runtime_policy;
  const usage = input.usage_policy;
  const dryRun = runtime.dry_run ? "dry-run" : "live-bounded";
  const expectedCost = Number(Math.max(0.001, Math.min(usage.max_price_usdc, route.max_hops * 0.01)).toFixed(3));

  const governanceChecks = [
    `Approval mode ${runtime.approval_mode} accepted for operation ${route.operation}.`,
    `Max hops ${route.max_hops} stays within bounded shipgate envelope.`,
    `Usage billing target ${usage.bill_to} capped at ${usage.max_price_usdc.toFixed(3)} USDC.`,
  ];
  if (route.require_receipt_settlement !== false) {
    governanceChecks.push("Receipt settlement evidence required before marking the route complete.");
  }

  const usageNotes = [
    `Expected billable units: 1 shipgate dispatch at ${expectedCost.toFixed(3)} USDC or less.`,
    `Receipt scope: ${usage.receipt_scope || "summary"}.`,
    "Idempotency key is forwarded on every request and reused across retries.",
  ];

  const escalationNotes = [];
  if (runtime.approval_mode === "human-review") {
    escalationNotes.push("Human review requested before promotion beyond the bounded runtime envelope.");
  }
  if (route.max_hops >= 6) {
    escalationNotes.push("High hop count route; verify downstream latency budget before scaling out.");
  }
  if (runtime.timeout_seconds >= 300) {
    escalationNotes.push("Long timeout requested; monitor for stale work and duplicate upstream attempts.");
  }
  if (!escalationNotes.length) {
    escalationNotes.push("No extra escalation beyond standard receipt verification in the bounded demo runtime.");
  }

  return {
    shipgate_plan: [
      `Resolve route for ${route.agent_ref} using operation ${route.operation} in ${dryRun} mode.`,
      `Enforce timeout ${runtime.timeout_seconds}s and retry budget ${runtime.max_retries}.`,
      `Attach usage cap ${usage.max_price_usdc.toFixed(3)} USDC billed to ${usage.bill_to}.`,
      `Emit a usage receipt tied to the idempotency key and manifest digest.`,
    ],
    dispatch_summary: `Prepared governed agents-shipgate dispatch for ${route.agent_ref} (${route.operation}) with ${route.max_hops} hops max and ${runtime.approval_mode} approval mode.`,
    governance_checks: governanceChecks,
    usage_notes: usageNotes,
    escalation_notes: escalationNotes,
  };
}

function createUsageReceipt({ manifest, invocationId, idempotencyKey, paymentChallenge, input, output, recovery }) {
  return {
    receipt_id: `rcpt_${sha256(`${invocationId}:${idempotencyKey}`).slice(0, 18)}`,
    type: "agoragentic.usage_receipt",
    status: "simulated-settled",
    created_at: nowIso(),
    seller_id: manifest.seller_id,
    capability_id: manifest.capability_id,
    invocation_id: invocationId,
    idempotency_key: idempotencyKey,
    payment: {
      rail: manifest.payment.rail,
      asset: manifest.payment.asset,
      amount_usdc: paymentChallenge.amount_usdc,
      challenge_id: paymentChallenge.challenge_id,
      authorization_mode: "demo-pay-gate",
      note: "Simulated authorization only; no wallet signing or settlement occurs in this demo.",
    },
    trust: {
      mode: manifest.trust.mode,
      checks: manifest.trust.checks.map((check) => ({ id: check.id, ok: true })),
    },
    digests: {
      manifest_digest: manifest.digests.manifest_digest,
      prompt_template_digest: manifest.digests.prompt_template_digest,
      input_schema_digest: manifest.digests.input_schema_digest,
      output_schema_digest: manifest.digests.output_schema_digest,
      input_digest: sha256(input),
      output_digest: sha256(output),
      recovery_digest: sha256(recovery),
    },
    metering: {
      billable_unit: "shipgate_dispatch",
      quantity: 1,
      input_chars: JSON.stringify(input).length,
      output_chars: JSON.stringify(output).length,
    },
    recovery: clone(recovery),
  };
}

async function maybeImportX402Fetch() {
  const candidates = ["agoragentic/x402-client", "../lib/x402-client.mjs"];
  for (const specifier of candidates) {
    try {
      const mod = await import(specifier);
      if (typeof mod.x402Fetch === "function") {
        return { x402Fetch: mod.x402Fetch, source: specifier };
      }
    } catch {
      // Fall back to the inline demo helper when the shared helper is not present.
    }
  }
  return { x402Fetch: createInlineX402Fetch(), source: "inline-demo-compat" };
}

function createInlineX402Fetch() {
  return async function x402Fetch(url, options = {}) {
    const {
      fetchImpl = globalThis.fetch,
      pay,
      idempotencyKey,
      method = "POST",
      headers = {},
      body,
      signal,
      maxPaidRetries = 1,
    } = options;

    if (typeof fetchImpl !== "function") {
      throw new Error("x402Fetch requires fetchImpl when global fetch is unavailable");
    }
    if (!idempotencyKey) {
      throw new Error("x402Fetch requires an idempotencyKey");
    }

    let authorization = null;
    let paidChallengeId = null;
    let paidTransientRetries = 0;

    while (true) {
      const requestHeaders = {
        accept: "application/json",
        "content-type": "application/json",
        ...headers,
        "idempotency-key": idempotencyKey,
      };
      if (authorization) {
        requestHeaders["x-payment-authorization"] = authorization;
      }

      let response;
      try {
        response = await fetchImpl(url, {
          method,
          headers: requestHeaders,
          body,
          signal,
        });
      } catch (error) {
        throw new Error(`network_error:${error instanceof Error ? error.message : String(error)}`);
      }

      if (response.status === 402) {
        if (authorization) {
          throw new Error("Server returned another 402 after payment authorization; refusing to re-authorize");
        }
        if (typeof pay !== "function") {
          throw new Error("x402Fetch received HTTP 402 but no pay callback was supplied");
        }
        const challenge = await response.json();
        const challengeId = challenge.challenge_id || challenge.id || null;
        const payment = await pay({ challenge, url, method, body, idempotencyKey });
        authorization = payment?.authorization || payment?.paymentAuthorization || payment?.token || null;
        paidChallengeId = challengeId;
        if (!authorization) {
          throw new Error("pay callback must return an authorization token");
        }
        continue;
      }

      if (response.status >= 500 && response.status < 600) {
        if (!authorization || paidTransientRetries >= maxPaidRetries) {
          return response;
        }
        paidTransientRetries += 1;
        continue;
      }

      return response;
    }
  };
}

function createMockMarketplaceFetch(manifest) {
  const challengesByKey = new Map();
  const receiptsByKey = new Map();
  const attemptsByKey = new Map();
  const authorizationHistoryByKey = new Map();
  const requestDigestsByKey = new Map();

  function buildOrReuseReceipt({ idempotencyKey, requestBody, challenge, attemptCount, history }) {
    if (!receiptsByKey.has(idempotencyKey)) {
      const invocationId = `inv_${sha256(idempotencyKey).slice(0, 16)}`;
      const output = simulateShipgateOutput(requestBody.input || {});
      const recovery = {
        attempts: attemptCount,
        first_paid_attempt: 2,
        recovered_after_http_5xx: attemptCount > 2,
      };
      const usageReceipt = createUsageReceipt({
        manifest,
        invocationId,
        idempotencyKey,
        paymentChallenge: challenge,
        input: requestBody.input || {},
        output,
        recovery,
      });
      receiptsByKey.set(idempotencyKey, {
        invocation_id: invocationId,
        capability_id: manifest.capability_id,
        output,
        usage_receipt: usageReceipt,
        seller_status: {
          accepted: true,
          authorization_reused: history.length >= 2 && history.every((entry) => entry === history[0]),
          attempts: attemptCount,
        },
      });
    }
    return receiptsByKey.get(idempotencyKey);
  }

  return async function fetchImpl(url, options = {}) {
    const headers = lowerCaseKeys(options.headers || {});
    const idempotencyKey = headers["idempotency-key"];
    const authorization = headers["x-payment-authorization"] || null;
    const capabilityDigest = headers["x-capability-digest"];
    const attemptCount = (attemptsByKey.get(idempotencyKey) || 0) + 1;
    attemptsByKey.set(idempotencyKey, attemptCount);

    if (!idempotencyKey) {
      return jsonResponse(400, { error: "missing_idempotency_key" });
    }
    if (capabilityDigest !== manifest.digests.manifest_digest) {
      return jsonResponse(409, { error: "capability_digest_mismatch" });
    }
    if (!url.endsWith(DEFAULT_EXECUTE_PATH)) {
      return jsonResponse(404, { error: "not_found" });
    }

    const requestBody = options.body ? JSON.parse(options.body) : {};
    const requestDigest = sha256(requestBody);
    const previousRequestDigest = requestDigestsByKey.get(idempotencyKey);
    if (previousRequestDigest && previousRequestDigest !== requestDigest) {
      return jsonResponse(409, { error: "idempotency_key_reused_with_different_request" });
    }
    requestDigestsByKey.set(idempotencyKey, requestDigest);

    if (!authorization) {
      const callerCap = Number(requestBody?.input?.usage_policy?.max_price_usdc ?? manifest.payment.max_price_usdc);
      const challengeAmount = Number(Math.min(Number(manifest.payment.max_price_usdc), callerCap).toFixed(3));
      const challenge = {
        challenge_id: `ch_${sha256(idempotencyKey).slice(0, 12)}`,
        capability_id: manifest.capability_id,
        amount_usdc: challengeAmount.toFixed(3),
        asset: manifest.payment.asset,
        pay_to: "demo:marketplace:agents-shipgate",
        memo: "demo challenge; authorize only through a caller-supplied pay gate",
      };
      challengesByKey.set(idempotencyKey, challenge);
      return jsonResponse(402, challenge);
    }

    const challenge = challengesByKey.get(idempotencyKey);
    if (!challenge) {
      return jsonResponse(409, { error: "missing_prior_challenge" });
    }

    const expectedAuthorization = `demo-auth::${challenge.challenge_id}::${idempotencyKey}`;
    if (authorization !== expectedAuthorization) {
      return jsonResponse(403, { error: "invalid_payment_authorization" });
    }

    const history = authorizationHistoryByKey.get(idempotencyKey) || [];
    history.push(authorization);
    authorizationHistoryByKey.set(idempotencyKey, history);

    if (attemptCount === 2) {
      return jsonResponse(502, {
        error: "transient_upstream_failure",
        detail: "demo shipgate wrapper retries with the same authorization and idempotency key",
      });
    }

    const receiptEnvelope = buildOrReuseReceipt({ idempotencyKey, requestBody, challenge, attemptCount, history });

    return jsonResponse(200, receiptEnvelope, {
      "payment-receipt": receiptEnvelope.usage_receipt.receipt_id,
    });
  };
}

export async function createLocalExecuteToolWrapper(options = {}) {
  const manifest = options.manifest || buildSellerManifest();
  const imported = await maybeImportX402Fetch();
  const x402Fetch = options.x402Fetch || imported.x402Fetch;
  const baseUrl = options.baseUrl || DEFAULT_BASE_URL;
  const executePath = options.executePath || manifest.execution.path || DEFAULT_EXECUTE_PATH;
  const fetchImpl = options.fetchImpl || createMockMarketplaceFetch(manifest);
  const requestDigestsByIdempotencyKey = new Map();

  async function execute(input, runtime = {}) {
    validatePublishedExecuteInput(input);
    const pay = runtime.pay || options.pay;
    if (typeof pay !== "function") {
      throw new Error("execute() requires a caller-supplied pay callback; this wrapper never auto-pays");
    }

    const idempotencyKey = runtime.idempotencyKey || randomUUID();
    const requestBody = {
      capability_id: manifest.capability_id,
      seller_id: manifest.seller_id,
      trust_mode: manifest.trust.mode,
      input,
    };
    rememberIdempotencyRequest(requestDigestsByIdempotencyKey, idempotencyKey, requestBody);
    const timeoutMs = Math.max(1, input.runtime_policy.timeout_seconds) * 1000;
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(new Error(`runtime_policy.timeout_seconds exceeded after ${input.runtime_policy.timeout_seconds}s`)), timeoutMs);

    let response;
    try {
      response = await x402Fetch(new URL(executePath, baseUrl).toString(), {
        method: "POST",
        fetchImpl,
        pay,
        idempotencyKey,
        body: JSON.stringify(requestBody),
        signal: controller.signal,
        maxPaidRetries: input.runtime_policy.max_retries,
        headers: {
          "x-capability-digest": manifest.digests.manifest_digest,
        },
      });
    } finally {
      clearTimeout(timeout);
    }

    if (!response.ok) {
      const text = await response.text();
      throw new Error(`execute() failed with HTTP ${response.status}: ${text}`);
    }

    const payload = await response.json();
    return buildVerifiedWrapperResult({ payload, manifest, idempotencyKey, x402Source: imported.source });
  }

  return {
    manifest,
    tool: {
      name: manifest.tool.name,
      description: manifest.tool.description,
      input_schema: manifest.tool.input_schema,
      output_schema: manifest.tool.output_schema,
      execute,
    },
    execute,
  };
}

function rememberIdempotencyRequest(cache, idempotencyKey, requestBody) {
  const digest = sha256(requestBody);
  const previous = cache.get(idempotencyKey);
  if (previous && previous !== digest) {
    throw new Error(`idempotency key ${idempotencyKey} was reused with a different request body`);
  }
  cache.set(idempotencyKey, digest);
}

function verifyExecutePayload({ payload, manifest, idempotencyKey }) {
  if (payload?.capability_id !== manifest.capability_id) {
    throw new Error(`execute() returned capability_id ${payload?.capability_id ?? "missing"}, expected ${manifest.capability_id}`);
  }
  const receipt = payload?.usage_receipt;
  if (!receipt || typeof receipt !== "object") {
    throw new Error("execute() response missing usage_receipt");
  }
  if (receipt.capability_id !== manifest.capability_id) {
    throw new Error("usage_receipt capability_id mismatch");
  }
  if (receipt.status !== "simulated-settled") {
    throw new Error(`usage_receipt status ${receipt.status ?? "missing"} is not accepted`);
  }
  if (receipt.idempotency_key !== idempotencyKey) {
    throw new Error("usage_receipt idempotency key mismatch");
  }
  if (receipt.digests?.manifest_digest !== manifest.digests.manifest_digest) {
    throw new Error("usage_receipt manifest digest mismatch");
  }
}

function buildVerifiedWrapperResult({ payload, manifest, idempotencyKey, x402Source }) {
  verifyExecutePayload({ payload, manifest, idempotencyKey });
  return {
    invocation_id: payload.invocation_id,
    capability_id: payload.capability_id,
    output: payload.output,
    usage_receipt: payload.usage_receipt,
    seller_status: payload.seller_status,
    wrapper: {
      x402_fetch_source: x402Source,
      idempotency_key: idempotencyKey,
    },
  };
}

export async function runDemo() {
  const wrapper = await createLocalExecuteToolWrapper();
  let payCalls = 0;

  const demoInput = {
    task_brief: "Route a governed agent runtime request through agents-shipgate with receipts enabled.",
    target_route: {
      agent_ref: "agents-shipgate/demo-runtime",
      operation: "dispatch_agent_task",
      max_hops: 3,
      preferred_region: "us-east-1",
      require_receipt_settlement: true,
    },
    runtime_policy: {
      timeout_seconds: 90,
      max_retries: 2,
      approval_mode: "bounded",
      dry_run: true,
    },
    usage_policy: {
      max_price_usdc: 0.03,
      bill_to: "demo-buyer",
      require_idempotency_key: true,
      receipt_scope: "full",
    },
    caller_note: "Demo invocation for maintainers validating the adapter.",
  };

  const execution = await wrapper.execute(demoInput, {
    idempotencyKey: "demo-agents-shipgate-seller-listing",
    async pay({ challenge, idempotencyKey }) {
      payCalls += 1;
      return {
        authorization: `demo-auth::${challenge.challenge_id}::${idempotencyKey}`,
      };
    },
  });

  return {
    manifest: wrapper.manifest,
    execution,
    demo_input: demoInput,
    pay_calls: payCalls,
  };
}

export async function selfTest() {
  const demo = await runDemo();
  assert.equal(demo.pay_calls, 1, "payment should be authorized exactly once after a 402 challenge");
  assert.equal(demo.execution.wrapper.idempotency_key, "demo-agents-shipgate-seller-listing");
  assert.equal(demo.execution.capability_id, demo.manifest.capability_id);
  assert.equal(demo.execution.usage_receipt.capability_id, demo.manifest.capability_id);
  assert.equal(demo.execution.usage_receipt.status, "simulated-settled");
  assert.equal(demo.execution.usage_receipt.digests.manifest_digest, demo.manifest.digests.manifest_digest);
  assert.equal(demo.execution.seller_status.authorization_reused, true);
  assert.equal(Array.isArray(demo.execution.output.shipgate_plan), true);
  assert.equal(demo.execution.output.shipgate_plan.length >= 3, true);
  return "self-test passed";
}

async function main(argv = process.argv.slice(2)) {
  if (argv.includes("--self-test")) {
    console.log(await selfTest());
    return;
  }

  const demo = await runDemo();
  console.log(JSON.stringify(demo, null, 2));
}

const isEntrypoint = (() => {
  if (!process.argv[1]) return false;
  return import.meta.url === pathToFileURL(process.argv[1]).href;
})();

if (isEntrypoint) {
  main().catch((error) => {
    console.error(error.stack || String(error));
    process.exitCode = 1;
  });
}
