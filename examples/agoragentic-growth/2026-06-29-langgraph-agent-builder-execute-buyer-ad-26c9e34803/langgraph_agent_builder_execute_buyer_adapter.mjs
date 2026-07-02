#!/usr/bin/env node
/* demo — simulates payment authorization and usage receipts; moves no real funds */

import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import process from "node:process";
import { pathToFileURL } from "node:url";

const DEFAULT_BASE_URL = process.env.AGORAGENTIC_BASE_URL || "https://agoragentic.example";
const EXECUTE_PATH = "/api/x402/execute";
const WRAPPER_FILE = "examples/agoragentic-growth/2026-06-29-langgraph-agent-builder-execute-buyer-ad-26c9e34803/langgraph_agent_builder_execute_buyer_adapter.mjs";
const DEFAULT_SERVER_NAME = "langgraph-agent-builder";
const DEFAULT_TOOL_NAME = "execute";
const DEFAULT_CAPABILITY_ID = "agoragentic.langgraph.agent_builder.execute.v1";
const DEFAULT_LISTING_ID = "langgraph-agent-builder.execute.demo";

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

function lowerCaseKeys(headers) {
  const out = {};
  if (!headers) return out;
  if (typeof headers.entries === "function") {
    for (const [key, value] of headers.entries()) {
      out[String(key).toLowerCase()] = value;
    }
    return out;
  }
  for (const [key, value] of Object.entries(headers)) {
    out[String(key).toLowerCase()] = value;
  }
  return out;
}

function asErrorMessage(error) {
  return error instanceof Error ? error.message : String(error);
}

function createTextResult(text, structuredContent, isError = false) {
  return {
    content: [{ type: "text", text }],
    structuredContent,
    isError,
  };
}

class AdapterValidationError extends Error {
  constructor(message, details = {}) {
    super(message);
    this.name = "AdapterValidationError";
    this.details = details;
  }
}

class UpstreamHttpError extends Error {
  constructor(message, details = {}) {
    super(message);
    this.name = "UpstreamHttpError";
    this.details = details;
  }
}

class NetworkExecutionError extends Error {
  constructor(message, details = {}) {
    super(message);
    this.name = "NetworkExecutionError";
    this.details = details;
  }
}

function validateExecuteInput(input) {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    throw new AdapterValidationError("execute() requires an object input");
  }
  if (typeof input.agent_id !== "string" || !input.agent_id.trim()) {
    throw new AdapterValidationError("agent_id must be a non-empty string", { field: "agent_id" });
  }
  if (typeof input.graph_id !== "string" || !input.graph_id.trim()) {
    throw new AdapterValidationError("graph_id must be a non-empty string", { field: "graph_id" });
  }
  if (typeof input.assistant_id !== "string" || !input.assistant_id.trim()) {
    throw new AdapterValidationError("assistant_id must be a non-empty string", { field: "assistant_id" });
  }
  if (typeof input.thread_id !== "string" || !input.thread_id.trim()) {
    throw new AdapterValidationError("thread_id must be a non-empty string", { field: "thread_id" });
  }
  if (typeof input.prompt !== "string" || !input.prompt.trim()) {
    throw new AdapterValidationError("prompt must be a non-empty string", { field: "prompt" });
  }
  if (input.input !== undefined && (!input.input || typeof input.input !== "object" || Array.isArray(input.input))) {
    throw new AdapterValidationError("input must be an object when provided", { field: "input" });
  }
  if (input.context !== undefined && (!input.context || typeof input.context !== "object" || Array.isArray(input.context))) {
    throw new AdapterValidationError("context must be an object when provided", { field: "context" });
  }
  if (input.tags !== undefined) {
    if (!Array.isArray(input.tags) || input.tags.some((item) => typeof item !== "string" || !item.trim())) {
      throw new AdapterValidationError("tags must be an array of non-empty strings", { field: "tags" });
    }
  }
  if (input.max_steps !== undefined && (!Number.isInteger(input.max_steps) || input.max_steps < 1 || input.max_steps > 64)) {
    throw new AdapterValidationError("max_steps must be an integer between 1 and 64", { field: "max_steps" });
  }
}

function buildToolDefinition(toolName = DEFAULT_TOOL_NAME) {
  return {
    name: toolName,
    description: "Execute a LangGraph-backed agent through Agoragentic's governed execute() runtime and return a usage receipt.",
    input_schema: {
      type: "object",
      additionalProperties: false,
      required: ["agent_id", "graph_id", "assistant_id", "thread_id", "prompt"],
      properties: {
        agent_id: {
          type: "string",
          description: "Stable seller-chosen identifier for the agent listing or agent package.",
        },
        graph_id: {
          type: "string",
          description: "LangGraph graph identifier.",
        },
        assistant_id: {
          type: "string",
          description: "LangGraph assistant identifier for the published agent.",
        },
        thread_id: {
          type: "string",
          description: "Stable thread id; callers should reuse it when resuming the same unit of work.",
        },
        prompt: {
          type: "string",
          description: "Primary instruction sent to the agent.",
        },
        input: {
          type: "object",
          additionalProperties: true,
          description: "Structured input passed into the agent run.",
        },
        context: {
          type: "object",
          additionalProperties: true,
          description: "Optional routing and governance metadata.",
        },
        tags: {
          type: "array",
          items: { type: "string" },
          description: "Optional listing, billing, or policy tags.",
        },
        max_steps: {
          type: "integer",
          minimum: 1,
          maximum: 64,
          default: 8,
          description: "Upper bound on LangGraph transitions before the run is aborted.",
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
      required: ["invocation_id", "capability_id", "output", "usage_receipt", "seller_listing", "wrapper"],
      properties: {
        invocation_id: { type: "string" },
        capability_id: { type: "string" },
        output: { type: "object", additionalProperties: true },
        usage_receipt: { type: "object", additionalProperties: true },
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
      },
    },
  };
}

export function createMinimalSellerListing(options = {}) {
  const serverName = options.serverName || DEFAULT_SERVER_NAME;
  const capabilityId = options.capabilityId || DEFAULT_CAPABILITY_ID;
  const listingId = options.listingId || DEFAULT_LISTING_ID;
  const tool = buildToolDefinition(options.toolName || DEFAULT_TOOL_NAME);

  const listing = {
    manifest_version: "1.0",
    listing_id: listingId,
    capability_id: capabilityId,
    title: "LangGraph Agent Builder Starter",
    summary:
      "Minimal seller listing example for exposing a LangGraph agent through Agoragentic's execute() path with governed inputs, caller-gated x402 payment, and usage receipts.",
    visibility: "draft",
    seller: {
      id: "example/langgraph-agent-builder",
      display_name: "langgraph-agent-builder",
      repository: "https://github.com/rhein1/agoragentic-integrations",
    },
    runtime: {
      framework: "langgraph",
      transport: "marketplace.execute",
      path: EXECUTE_PATH,
      thread_resume_safe: true,
      wrapper_runtime: "node>=18",
      wrapper_file: WRAPPER_FILE,
    },
    payment: {
      rail: "x402",
      asset: "USDC",
      max_price_usdc: "0.05",
      requires_caller_pay_gate: true,
      idempotency_required: true,
    },
    governance: {
      bounded_runtime: true,
      notes: [
        "Payment authorization is created only after HTTP 402 and then reused on retry.",
        "Every request carries an idempotency key so network retries do not double-charge.",
        "The listing exposes one bounded execute() entrypoint for agent builders.",
      ],
    },
    mcp: {
      server_name: serverName,
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
    example_agent: {
      agent_id: "support-triage-agent",
      graph_id: "support_triage",
      assistant_id: "langgraph-support-assistant",
      default_tags: ["langgraph", "governed", "draft"],
      example_input: {
        thread_id: "ticket-1001",
        prompt: "Summarize the ticket and propose the next operator-safe action.",
        input: {
          ticket_id: "T-1001",
          customer_tier: "gold",
          issue: "Refund request after duplicate charge",
        },
      },
    },
    tool,
    digests: {
      tool_input_schema_digest: sha256(tool.input_schema),
      tool_output_schema_digest: sha256(tool.output_schema),
      manifest_digest: null,
    },
  };

  listing.digests.manifest_digest = sha256(listing);
  return listing;
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
      // Keep the example runnable when the shared helper is unavailable locally.
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
    } = options;

    if (typeof fetchImpl !== "function") {
      throw new AdapterValidationError("x402Fetch requires fetchImpl when global fetch is unavailable");
    }
    if (!idempotencyKey) {
      throw new AdapterValidationError("x402Fetch requires idempotencyKey");
    }

    let paymentAuthorization = null;
    let paidChallengeId = null;
    let paidNetworkRetries = 0;

    for (let attempt = 1; attempt <= 3; attempt += 1) {
      const requestHeaders = {
        accept: "application/json",
        "content-type": "application/json",
        "x-idempotency-key": idempotencyKey,
        ...headers,
      };
      attachPaymentAuthorizationHeaders(requestHeaders, paymentAuthorization);

      let response;
      try {
        response = await fetchImpl(url, { method, headers: requestHeaders, body });
      } catch (error) {
        if (canRetryPaidNetworkError(paymentAuthorization, paidNetworkRetries)) {
          paidNetworkRetries += 1;
          continue;
        }
        throw buildNetworkExecutionError(error, { url, method, idempotencyKey });
      }

      if (response.status !== 402) {
        response.x402 = {
          attempts: attempt,
          authorized: Boolean(paymentAuthorization),
          paymentAuthorization: clone(paymentAuthorization),
        };
        return response;
      }

      if (typeof pay !== "function") {
        throw new AdapterValidationError("x402Fetch received HTTP 402 but no pay callback was supplied");
      }

      const challenge = await response.json();
      const challengeId = challenge.challenge_id || challenge.id || null;
      if (paymentAuthorization && paidChallengeId && challengeId === paidChallengeId) {
        throw new UpstreamHttpError(`server repeated challenge ${challengeId} after payment authorization`, {
          status: 402,
          challenge,
        });
      }

      if (!paymentAuthorization) {
        paymentAuthorization = await pay({
          challenge,
          url,
          method,
          body,
          idempotencyKey,
          attempt,
        });
        if (!paymentAuthorization || typeof paymentAuthorization.authorization !== "string" || !paymentAuthorization.authorization) {
          throw new AdapterValidationError("pay callback must return { authorization } after HTTP 402");
        }
        paidChallengeId = challengeId;
      }
    }

    throw new UpstreamHttpError("x402Fetch exhausted retries while waiting for a non-402 response", { status: 402 });
  };
}

function attachPaymentAuthorizationHeaders(requestHeaders, paymentAuthorization) {
  if (!paymentAuthorization) return;
  requestHeaders["x-payment-authorization"] = paymentAuthorization.authorization;
  requestHeaders["payment-signature"] = paymentAuthorization.paymentSignature || paymentAuthorization.authorization;
  if (paymentAuthorization.paymentSignature) {
    requestHeaders["x-payment-signature"] = paymentAuthorization.paymentSignature;
  }
}

function canRetryPaidNetworkError(paymentAuthorization, paidNetworkRetries) {
  return Boolean(paymentAuthorization) && paidNetworkRetries < 1;
}

function buildNetworkExecutionError(error, { url, method, idempotencyKey }) {
  return new NetworkExecutionError(`network error before HTTP response: ${asErrorMessage(error)}`, {
    url,
    method,
    idempotencyKey,
    cause: asErrorMessage(error),
  });
}

async function readJsonResponse(response) {
  const text = await response.text();
  return text ? JSON.parse(text) : {};
}

function createUsageReceipt({ listing, requestBody, responseBody, responseHeaders, response, idempotencyKey, x402Meta }) {
  const invocationId =
    responseBody?.invocation_id || responseBody?.invocation?.id || responseHeaders["x-invocation-id"] || `invoke_${randomUUID()}`;
  const upstreamReceipt = clone(responseBody?.usage_receipt || responseBody?.receipt || {});
  return {
    schema: "agoragentic:usage-receipt:v1",
    receipt_id:
      upstreamReceipt?.receipt_id ||
      upstreamReceipt?.id ||
      responseHeaders["x-payment-receipt-id"] ||
      `receipt_${randomUUID()}`,
    created_at: nowIso(),
    listing_id: listing.listing_id,
    capability_id: listing.capability_id,
    invocation_id: invocationId,
    request_digest: sha256(requestBody),
    response_digest: sha256(responseBody),
    manifest_digest: listing.digests.manifest_digest,
    idempotency_key: idempotencyKey,
    payment: {
      rail: listing.payment.rail,
      asset: listing.payment.asset,
      authorization_present: Boolean(x402Meta?.paymentAuthorization?.authorization),
      challenge_id:
        upstreamReceipt?.payment?.challenge_id ||
        responseBody?.payment?.challenge_id ||
        responseHeaders["x-payment-challenge-id"] ||
        null,
      settlement_status:
        upstreamReceipt?.payment?.settlement_status ||
        responseBody?.payment?.settlement_status ||
        responseHeaders["x-payment-status"] ||
        "authorized",
    },
    result: {
      ok: response.ok,
      status: response.status,
      output_digest: sha256(responseBody?.output || responseBody?.result || {}),
    },
    transport: {
      path: EXECUTE_PATH,
      x402_attempts: x402Meta?.attempts || 1,
      headers: {
        "x-idempotency-key": idempotencyKey,
        "x-invocation-id": responseHeaders["x-invocation-id"] || null,
      },
    },
  };
}

export class LangGraphExecuteBuyerAdapter {
  constructor(options = {}) {
    this.baseUrl = normalizeBaseUrl(options.baseUrl);
    this.fetchImpl = options.fetchImpl || globalThis.fetch;
    this.pay = options.pay;
    this.serverName = options.serverName || DEFAULT_SERVER_NAME;
    this.toolName = options.toolName || DEFAULT_TOOL_NAME;
    this.capabilityId = options.capabilityId || DEFAULT_CAPABILITY_ID;
    this.listing = createMinimalSellerListing({
      serverName: this.serverName,
      capabilityId: this.capabilityId,
      toolName: this.toolName,
      listingId: options.listingId || DEFAULT_LISTING_ID,
    });
    this.x402ModulePromise = options.x402Fetch
      ? Promise.resolve({ x402Fetch: options.x402Fetch, source: "custom" })
      : maybeImportX402Fetch();
  }

  getSellerListing() {
    return clone(this.listing);
  }

  listTools() {
    return clone(this.listing.mcp.tools);
  }

  async execute(input = {}, runtime = {}) {
    validateExecuteInput(input);
    const pay = runtime.pay || this.pay;
    if (typeof pay !== "function") {
      throw new AdapterValidationError("execute() requires a caller-supplied pay callback; the adapter never auto-pays");
    }
    if (typeof this.fetchImpl !== "function") {
      throw new AdapterValidationError("fetchImpl is required when global fetch is unavailable");
    }

    const idempotencyKey = input.idempotency_key || runtime.idempotencyKey || `idem_${randomUUID()}`;
    const requestBody = {
      capability_id: this.listing.capability_id,
      listing_id: this.listing.listing_id,
      seller_mcp_server: this.serverName,
      tool_name: this.toolName,
      agent: {
        agent_id: input.agent_id,
        graph_id: input.graph_id,
        assistant_id: input.assistant_id,
        thread_id: input.thread_id,
        max_steps: input.max_steps || 8,
      },
      prompt: input.prompt,
      input: clone(input.input || {}),
      context: {
        ...(clone(input.context || {})),
        tags: clone(input.tags || []),
      },
    };

    const { x402Fetch, source } = await this.x402ModulePromise;
    const response = await x402Fetch(`${this.baseUrl}${EXECUTE_PATH}`, {
      fetchImpl: this.fetchImpl,
      pay,
      idempotencyKey,
      headers: {
        "x-mcp-server": this.serverName,
        "x-capability-id": this.listing.capability_id,
        "x-listing-id": this.listing.listing_id,
      },
      body: JSON.stringify(requestBody),
    });

    const responseHeaders = lowerCaseKeys(response.headers);
    const responseBody = await readJsonResponse(response);

    if (!response.ok) {
      throw new UpstreamHttpError(`execute() failed with HTTP ${response.status}`, {
        status: response.status,
        response_body: responseBody,
        idempotency_key: idempotencyKey,
      });
    }

    const usageReceipt = createUsageReceipt({
      listing: this.listing,
      requestBody,
      responseBody,
      responseHeaders,
      response,
      idempotencyKey,
      x402Meta: response.x402,
    });

    return {
      invocation_id: usageReceipt.invocation_id,
      capability_id: this.listing.capability_id,
      output: clone(responseBody.output || responseBody.result || responseBody),
      usage_receipt: usageReceipt,
      seller_listing: this.getSellerListing(),
      wrapper: {
        x402_fetch_source: source,
        idempotency_key: idempotencyKey,
        server_name: this.serverName,
      },
      raw_response: clone(responseBody),
    };
  }

  async callTool(name, args = {}, runtime = {}) {
    const expected = this.toolName;
    if (name !== expected) {
      return createTextResult(
        JSON.stringify({ ok: false, error: `unknown tool: ${name}`, expected_tool: expected }, null, 2),
        { ok: false, error: `unknown tool: ${name}`, expected_tool: expected },
        true,
      );
    }

    try {
      const result = await this.execute(args, runtime);
      return createTextResult(
        JSON.stringify(
          {
            ok: true,
            invocation_id: result.invocation_id,
            capability_id: result.capability_id,
            listing_id: result.seller_listing.listing_id,
            usage_receipt_id: result.usage_receipt.receipt_id,
            payment_status: result.usage_receipt.payment.settlement_status,
            output: result.output,
          },
          null,
          2,
        ),
        result,
        false,
      );
    } catch (error) {
      return createTextResult(
        JSON.stringify(
          {
            ok: false,
            error_type: error?.name || "Error",
            message: asErrorMessage(error),
            details: error?.details || null,
          },
          null,
          2,
        ),
        {
          ok: false,
          error_type: error?.name || "Error",
          message: asErrorMessage(error),
          details: error?.details || null,
        },
        true,
      );
    }
  }
}

function jsonHeaders(headers = {}) {
  const normalized = lowerCaseKeys(headers);
  const map = new Map(Object.entries(normalized));
  return {
    get(name) {
      return map.get(String(name).toLowerCase()) || null;
    },
    entries() {
      return map.entries();
    },
  };
}

function jsonResponse(status, body, headers = {}) {
  return {
    status,
    ok: status >= 200 && status < 300,
    headers: jsonHeaders(headers),
    async text() {
      return JSON.stringify(body);
    },
    async json() {
      return clone(body);
    },
  };
}

export function createDemoFetch() {
  const state = {
    requests: [],
    seenByIdempotencyKey: new Map(),
  };

  async function fetchImpl(url, init = {}) {
    const headers = lowerCaseKeys(init.headers || {});
    const body = init.body ? JSON.parse(init.body) : {};
    const idempotencyKey = headers["x-idempotency-key"];
    state.requests.push({ url, headers: clone(headers), body: clone(body) });

    if (!idempotencyKey) {
      return jsonResponse(400, { error: { code: "missing_idempotency_key" } });
    }

    const seen = state.seenByIdempotencyKey.get(idempotencyKey) || {
      count: 0,
      challengeId: `challenge_${randomUUID()}`,
    };
    seen.count += 1;
    state.seenByIdempotencyKey.set(idempotencyKey, seen);

    const paymentAuthorization = headers["x-payment-authorization"] || headers["payment-signature"];
    if (!paymentAuthorization) {
      return jsonResponse(
        402,
        {
          challenge_id: seen.challengeId,
          amount_usdc: "0.01",
          pay_to: "demo-langgraph-seller",
          memo: "demo only",
        },
        {
          "payment-required": JSON.stringify({ challenge_id: seen.challengeId, amount_usdc: "0.01" }),
          "x-payment-challenge-id": seen.challengeId,
        },
      );
    }

    if (paymentAuthorization !== `auth:${seen.challengeId}`) {
      return jsonResponse(403, {
        error: { code: "invalid_payment_authorization", challenge_id: seen.challengeId },
      });
    }

    return jsonResponse(
      200,
      {
        invocation_id: `invoke_${randomUUID()}`,
        output: {
          run_id: `run_${randomUUID()}`,
          agent_id: body.agent?.agent_id,
          graph_id: body.agent?.graph_id,
          assistant_id: body.agent?.assistant_id,
          thread_id: body.agent?.thread_id,
          echoed_input: body.input,
          summary: `Completed LangGraph agent ${body.agent?.agent_id} for thread ${body.agent?.thread_id}`,
          next_action: "review the structured output and persist the usage receipt",
        },
        usage_receipt: {
          id: `receipt_${randomUUID()}`,
          payment: {
            challenge_id: seen.challengeId,
            settlement_status: "authorized",
          },
        },
      },
      {
        "x-invocation-id": `invoke_header_${randomUUID()}`,
        "x-payment-receipt-id": `receipt_header_${randomUUID()}`,
        "x-payment-status": "authorized",
      },
    );
  }

  return { fetchImpl, state };
}

export async function selfTest() {
  const { fetchImpl, state } = createDemoFetch();
  const payCalls = [];
  const adapter = new LangGraphExecuteBuyerAdapter({
    baseUrl: "https://demo.agoragentic.local",
    fetchImpl,
    pay: async ({ challenge, idempotencyKey }) => {
      payCalls.push({ challenge: clone(challenge), idempotencyKey });
      return { authorization: `auth:${challenge.challenge_id}`, payer: "demo-buyer" };
    },
  });

  const listing = adapter.getSellerListing();
  assert.equal(listing.listing_id, DEFAULT_LISTING_ID);
  assert.equal(listing.runtime.path, EXECUTE_PATH);
  assert.equal(listing.mcp.tools[0].name, DEFAULT_TOOL_NAME);
  assert.equal(listing.example_agent.agent_id, "support-triage-agent");

  const result = await adapter.execute({
    agent_id: "support-triage-agent",
    graph_id: "support_triage",
    assistant_id: "langgraph-support-assistant",
    thread_id: "ticket-1001",
    prompt: "Summarize the ticket and propose the next operator-safe action.",
    input: { ticket_id: "T-1001", customer_tier: "gold" },
    context: { requester: "agent-builder-demo" },
    tags: ["langgraph", "demo"],
  });

  assert.equal(payCalls.length, 1, "payment should be authorized exactly once");
  assert.equal(state.requests.length, 2, "request should retry once after HTTP 402");
  assert.equal(state.requests[0].headers["x-idempotency-key"], state.requests[1].headers["x-idempotency-key"]);
  assert.equal(state.requests[1].headers["payment-signature"], `auth:${payCalls[0].challenge.challenge_id}`);
  assert.equal(result.output.agent_id, "support-triage-agent");
  assert.equal(result.seller_listing.listing_id, DEFAULT_LISTING_ID);
  assert.equal(result.usage_receipt.payment.settlement_status, "authorized");
  assert.equal(result.wrapper.idempotency_key, state.requests[0].headers["x-idempotency-key"]);

  const toolResult = await adapter.callTool(DEFAULT_TOOL_NAME, {
    agent_id: "support-triage-agent",
    graph_id: "support_triage",
    assistant_id: "langgraph-support-assistant",
    thread_id: "ticket-1002",
    prompt: "Draft the reply.",
    input: { ticket_id: "T-1002" },
  });
  assert.equal(toolResult.isError, false);

  const badResult = await adapter.callTool(DEFAULT_TOOL_NAME, {
    agent_id: "support-triage-agent",
    graph_id: "support_triage",
    assistant_id: "langgraph-support-assistant",
    thread_id: "ticket-1003",
  });
  assert.equal(badResult.isError, true);
  assert.match(badResult.content[0].text, /prompt must be a non-empty string/);

  return {
    ok: true,
    listing_id: listing.listing_id,
    manifest_digest: listing.digests.manifest_digest,
    payment_authorizations: payCalls.length,
    request_attempts: state.requests.length,
    sample_receipt_id: result.usage_receipt.receipt_id,
    sample_invocation_id: result.invocation_id,
  };
}

async function main() {
  const summary = await selfTest();
  console.log(JSON.stringify(summary, null, 2));
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error(JSON.stringify({ ok: false, error: asErrorMessage(error), stack: error?.stack || null }, null, 2));
    process.exitCode = 1;
  });
}
