#!/usr/bin/env node
/* demo — simulates x402 payment authorization and usage receipts; moves no real funds */

import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import process from "node:process";
import { pathToFileURL } from "node:url";

const DEFAULT_BASE_URL = process.env.AGORAGENTIC_BASE_URL || "https://agoragentic.example";
const DEFAULT_MATCH_PATH = "/api/x402/execute/match";
const DEFAULT_EXECUTE_PATH = "/api/x402/execute";
const DEFAULT_TOOL_NAME = "agoragentic_execute";
const DEFAULT_UPSTREAM_SERVER = "demo-memory";
const DEFAULT_UPSTREAM_TOOL = "search_memories";
const RECEIPT_SCHEMA = "agoragentic:litellm-execute-receipt:v1";

function nowIso() {
  return new Date().toISOString();
}

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
  const serialized = typeof value === "string" ? value : stableStringify(value);
  return createHash("sha256").update(serialized).digest("hex");
}

function lowerCaseHeaders(headersLike = {}) {
  if (headersLike instanceof Headers) {
    return Object.fromEntries(Array.from(headersLike.entries(), ([k, v]) => [String(k).toLowerCase(), String(v)]));
  }
  return Object.fromEntries(Object.entries(headersLike).map(([k, v]) => [String(k).toLowerCase(), String(v)]));
}

function readHeader(source, name) {
  if (!source) return null;
  if (typeof source.get === "function") {
    return source.get(name) ?? source.get(String(name).toLowerCase()) ?? null;
  }
  const headers = lowerCaseHeaders(source.headers || source);
  return headers[String(name).toLowerCase()] ?? null;
}

function normalizeBaseUrl(baseUrl) {
  return String(baseUrl || DEFAULT_BASE_URL).replace(/\/+$/, "");
}

function buildUrl(baseUrl, path, query = {}) {
  const url = new URL(path, `${normalizeBaseUrl(baseUrl)}/`);
  for (const [key, value] of Object.entries(query)) {
    if (value === undefined || value === null || value === "") continue;
    url.searchParams.set(key, String(value));
  }
  return url;
}

function coerceObject(value, fieldName) {
  if (value === undefined) return {};
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError(`${fieldName} must be an object when provided`);
  }
  return clone(value);
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

async function safeJson(response) {
  if (!response) return null;
  try {
    if (typeof response.clone === "function") {
      return await response.clone().json();
    }
  } catch {}
  try {
    if (typeof response.text === "function") {
      const text = await response.text();
      if (!text) return null;
      return JSON.parse(text);
    }
  } catch {}
  return null;
}

function extractTextSummary(payload) {
  const result = payload?.result ?? payload?.output ?? payload;
  const chunks = Array.isArray(result?.content)
    ? result.content
        .filter((item) => item?.type === "text" && typeof item.text === "string")
        .map((item) => item.text.trim())
        .filter(Boolean)
    : [];
  if (chunks.length) return chunks.join("\n\n");
  if (typeof result?.text === "string" && result.text.trim()) return result.text.trim();
  return null;
}

function normalizePayResult(payment) {
  if (!payment || typeof payment !== "object") {
    throw new Error("pay callback must return an object");
  }
  const authorizationHeader = payment.authorizationHeader || payment.authorization || payment.paymentAuthorization || null;
  const paymentSignature = payment.paymentSignature || null;
  if (!authorizationHeader && !paymentSignature) {
    throw new Error("pay callback must return authorizationHeader, authorization, or paymentSignature");
  }
  return {
    authorizationHeader,
    paymentSignature,
    receipt: payment.receipt || null,
    paymentId: payment.paymentId || null,
  };
}

class AgoragenticExecuteError extends Error {
  constructor(message, details = {}) {
    super(message);
    this.name = "AgoragenticExecuteError";
    this.kind = details.kind || "execution_error";
    this.code = details.code || "EXECUTION_ERROR";
    this.status = details.status ?? null;
    this.retryable = Boolean(details.retryable);
    this.idempotencyKey = details.idempotencyKey || null;
    this.details = details.details || null;
    this.cause = details.cause;
  }
}

class InMemoryUsageReceiptStore {
  constructor(limit = 200) {
    this.limit = limit;
    this.entries = [];
  }

  append(entry) {
    this.entries.push(clone(entry));
    if (this.entries.length > this.limit) {
      this.entries.splice(0, this.entries.length - this.limit);
    }
    return entry;
  }

  list() {
    return clone(this.entries);
  }
}

async function importPreferredX402Fetch() {
  for (const specifier of ["agoragentic/x402-client", "../lib/x402-client.mjs", "./lib/x402-client.mjs"]) {
    try {
      const mod = await import(specifier);
      if (typeof mod.x402Fetch === "function") {
        return { fn: mod.x402Fetch, source: specifier };
      }
    } catch {}
  }
  return null;
}

function createInlineX402Fetch() {
  return async function inlineX402Fetch(url, options = {}) {
    const {
      fetchImpl = globalThis.fetch,
      pay,
      idempotencyKey = randomUUID(),
      method = "GET",
      headers = {},
      body,
      signal,
      maxNetworkRetries = 1,
    } = options;

    if (typeof fetchImpl !== "function") {
      throw new Error("fetchImpl is required");
    }

    const baseHeaders = lowerCaseHeaders(headers);
    let cachedPayment = null;
    let attempts = 0;
    let networkRetriesUsed = 0;
    let saw402 = false;
    let paidChallenge = null;

    while (true) {
      attempts += 1;
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
          return {
            response,
            responseBody: await safeJson(response),
            attempts,
            idempotencyKey,
            paymentAuthorization: cachedPayment ? clone(cachedPayment) : null,
            x402Meta: {
              helper: "inline-fallback",
              paymentAttempted: saw402,
              paidChallenge,
              networkRetriesUsed,
            },
          };
        }

        saw402 = true;
        const paymentRequired = readHeader(response, "payment-required");
        if (!paymentRequired) {
          throw new AgoragenticExecuteError("Received HTTP 402 without payment-required header", {
            code: "MISSING_PAYMENT_REQUIRED",
            kind: "payment_protocol_error",
            status: 402,
            retryable: false,
            idempotencyKey,
          });
        }
        if (typeof pay !== "function") {
          throw new AgoragenticExecuteError("HTTP 402 requires a caller-supplied pay callback", {
            code: "PAY_CALLBACK_REQUIRED",
            kind: "payment_required",
            status: 402,
            retryable: false,
            idempotencyKey,
            details: { paymentRequired },
          });
        }
        if (!cachedPayment) {
          paidChallenge = paymentRequired;
          cachedPayment = normalizePayResult(await pay(paymentRequired, {
            url: String(url),
            method,
            headers: clone(requestHeaders),
            body: requestBody,
            idempotencyKey,
          }));
          continue;
        }
        throw new AgoragenticExecuteError("Server returned a repeated HTTP 402 after payment authorization was attached", {
          code: "REPEATED_402",
          kind: "payment_protocol_error",
          status: 402,
          retryable: false,
          idempotencyKey,
        });
      } catch (error) {
        if (error instanceof AgoragenticExecuteError) throw error;
        if (!cachedPayment) {
          throw new AgoragenticExecuteError(`Execute request failed before payment authorization: ${error?.message || error}`, {
            code: "EXECUTE_NETWORK_ERROR",
            kind: "network_error",
            retryable: true,
            idempotencyKey,
            cause: error,
          });
        }
        if (networkRetriesUsed >= maxNetworkRetries) {
          throw new AgoragenticExecuteError(`Network error after payment authorization was prepared: ${error?.message || error}`, {
            code: "NETWORK_AFTER_PAYMENT_AUTHORIZED",
            kind: "network_after_payment_authorized",
            retryable: true,
            idempotencyKey,
            details: { networkRetriesUsed, paidChallenge },
            cause: error,
          });
        }
        networkRetriesUsed += 1;
      }
    }
  };
}

async function resolveX402Fetch() {
  const preferred = await importPreferredX402Fetch();
  if (preferred) return preferred;
  return { fn: createInlineX402Fetch(), source: "inline-fallback" };
}

function sanitizePaymentAuthorization(payment) {
  if (!payment) return null;
  return {
    authorizationHeaderPresent: Boolean(payment.authorizationHeader),
    paymentSignaturePresent: Boolean(payment.paymentSignature),
    paymentId: payment.paymentId || null,
    receipt: payment.receipt || null,
  };
}

function normalizeX402Result(settled) {
  if (settedLike(settled)) {
    return settled;
  }
  if (settled instanceof Response) {
    return {
      response: settled,
      responseBody: null,
      attempts: 1,
      paymentAuthorization: null,
      idempotencyKey: null,
      x402Meta: {
        helper: "unknown-response",
        paymentAttempted: Boolean(readHeader(settled, "payment-response") || readHeader(settled, "payment-receipt")),
        paidChallenge: null,
        networkRetriesUsed: 0,
      },
    };
  }
  if (settled?.response instanceof Response || typeof settled?.response?.status === "number") {
    return {
      response: settled.response,
      responseBody: settled.responseBody ?? settled.body ?? null,
      attempts: settled.attempts ?? 1,
      paymentAuthorization: settled.paymentAuthorization ?? null,
      idempotencyKey: settled.idempotencyKey ?? null,
      x402Meta: {
        helper: settled?.x402Meta?.helper || "normalized-wrapper",
        paymentAttempted: Boolean(settled?.x402Meta?.paymentAttempted),
        paidChallenge: settled?.x402Meta?.paidChallenge || null,
        networkRetriesUsed: settled?.x402Meta?.networkRetriesUsed ?? 0,
      },
    };
  }
  throw new Error("x402Fetch returned an unsupported result shape");
}

function settedLike(value) {
  return Boolean(value && (value.response instanceof Response || typeof value?.response?.status === "number") && "x402Meta" in value);
}

function classifyError(error) {
  if (error instanceof AgoragenticExecuteError) {
    return error;
  }
  return new AgoragenticExecuteError(error?.message || String(error), {
    code: "UNEXPECTED_ERROR",
    kind: "unexpected_error",
    retryable: false,
    cause: error,
  });
}

function normalizeQuotePayload(payload, fallback = {}) {
  const quoteId = payload?.quote_id || payload?.quoteId || fallback.quoteId || null;
  if (!quoteId) {
    throw new AgoragenticExecuteError("execute match did not return quote_id", {
      code: "MISSING_QUOTE_ID",
      kind: "preview_error",
      retryable: false,
      details: payload,
    });
  }
  return {
    raw: payload,
    quoteId,
    priceUsdc: payload?.price_usdc ?? payload?.price ?? payload?.quote?.price_usdc ?? null,
    listingId: payload?.listing_id || payload?.listingId || null,
    capabilityId: payload?.capability_id || payload?.capabilityId || null,
  };
}

function buildResultEnvelope({ request, executePayload, receipt, ok, error }) {
  const summary = extractTextSummary(executePayload);
  return {
    ok,
    request,
    result: ok
      ? {
          summary,
          structured: executePayload?.result?.structuredContent ?? executePayload?.output?.structuredContent ?? null,
          raw: executePayload,
        }
      : null,
    error: ok ? null : error,
    usage_receipt: receipt,
  };
}

export class LiteLLMAgoragenticExecuteTool {
  constructor(options = {}) {
    this.toolName = options.toolName || DEFAULT_TOOL_NAME;
    this.baseUrl = normalizeBaseUrl(options.baseUrl || DEFAULT_BASE_URL);
    this.matchPath = options.matchPath || DEFAULT_MATCH_PATH;
    this.executePath = options.executePath || DEFAULT_EXECUTE_PATH;
    this.defaultServer = options.defaultServer || DEFAULT_UPSTREAM_SERVER;
    this.defaultUpstreamTool = options.defaultUpstreamTool || DEFAULT_UPSTREAM_TOOL;
    this.apiKey = options.apiKey || process.env.AGORAGENTIC_API_KEY || null;
    this.fetchImpl = options.fetchImpl || globalThis.fetch;
    this.pay = options.pay || null;
    this.receiptStore = options.receiptStore || new InMemoryUsageReceiptStore();
    this.auditSink = typeof options.auditSink === "function" ? options.auditSink : () => {};
    this.x402FetchPromise = options.x402Fetch
      ? Promise.resolve({ fn: options.x402Fetch, source: "caller-supplied" })
      : resolveX402Fetch();

    if (typeof this.fetchImpl !== "function") {
      throw new TypeError("fetch implementation is required");
    }
  }

  buildLiteLLMToolDefinition() {
    return {
      type: "function",
      function: {
        name: this.toolName,
        description: "Call a governed Agoragentic execute() runtime and return the tool output with a usage receipt.",
        parameters: {
          type: "object",
          additionalProperties: false,
          required: ["task"],
          properties: {
            task: {
              type: "string",
              description: "High-level task used for execute() quote matching and audit logging.",
            },
            mcp_server: {
              type: "string",
              description: "Marketplace MCP server to invoke.",
              default: this.defaultServer,
            },
            tool_name: {
              type: "string",
              description: "Tool name exposed by the target MCP server.",
              default: this.defaultUpstreamTool,
            },
            arguments: {
              type: "object",
              description: "JSON arguments passed to the upstream tool.",
              additionalProperties: true,
            },
            max_price_usdc: {
              type: "number",
              description: "Optional quote ceiling for execute() preview matching.",
            },
            metadata: {
              type: "object",
              description: "Optional local audit metadata such as conversation or request identifiers.",
              additionalProperties: true,
            },
            idempotency_key: {
              type: "string",
              description: "Optional caller-provided idempotency key. Generated automatically when omitted.",
            },
          },
        },
      },
    };
  }

  listUsageReceipts() {
    return this.receiptStore.list();
  }

  async invokeForLiteLLM(args = {}) {
    const result = await this.invoke(args);
    return JSON.stringify(result, null, 2);
  }

  async invoke(args = {}) {
    const request = this.#normalizeRequest(args);
    const startedAt = Date.now();
    const quote = await this.#matchQuote(request);
    const executeBody = {
      quote_id: quote.quoteId,
      input: {
        transport: "mcp",
        server: request.server,
        tool: request.upstreamTool,
        arguments: request.arguments,
      },
    };

    const { fn: x402Fetch, source: helperSource } = await this.x402FetchPromise;

    try {
      const settledRaw = await x402Fetch(buildUrl(this.baseUrl, this.executePath), {
        method: "POST",
        headers: this.#buildJsonHeaders(),
        body: JSON.stringify(executeBody),
        fetchImpl: this.fetchImpl,
        pay: request.pay,
        idempotencyKey: request.idempotencyKey,
      });
      const settled = normalizeX402Result(settledRaw);
      if (!settled.responseBody) {
        settled.responseBody = await safeJson(settled.response);
      }

      if (!settled.response.ok) {
        throw new AgoragenticExecuteError(`execute failed with HTTP ${settled.response.status}`, {
          code: "EXECUTE_HTTP_ERROR",
          kind: "http_error",
          status: settled.response.status,
          retryable: settled.response.status >= 500,
          idempotencyKey: request.idempotencyKey,
          details: settled.responseBody,
        });
      }

      const receipt = this.#buildUsageReceipt({
        request,
        quote,
        executePayload: settled.responseBody,
        executeResponse: settled.response,
        paymentAuthorization: settled.paymentAuthorization,
        helperSource,
        attempts: settled.attempts,
        paymentMeta: settled.x402Meta,
        startedAt,
      });

      const envelope = buildResultEnvelope({
        request,
        executePayload: settled.responseBody,
        receipt,
        ok: true,
      });
      this.#recordReceipt(receipt);
      return envelope;
    } catch (error) {
      const normalized = classifyError(error);
      const receipt = this.#buildUsageReceipt({
        request,
        quote,
        executePayload: null,
        executeResponse: null,
        paymentAuthorization: null,
        helperSource,
        attempts: 0,
        paymentMeta: { paymentAttempted: normalized.kind === "payment_required" || normalized.kind === "network_after_payment_authorized" },
        startedAt,
        error: normalized,
      });
      this.#recordReceipt(receipt);
      return buildResultEnvelope({
        request,
        executePayload: null,
        receipt,
        ok: false,
        error: {
          code: normalized.code,
          kind: normalized.kind,
          status: normalized.status,
          retryable: normalized.retryable,
          message: normalized.message,
          idempotency_key: normalized.idempotencyKey || request.idempotencyKey,
          details: normalized.details,
        },
      });
    }
  }

  async #matchQuote(request) {
    const url = buildUrl(this.baseUrl, this.matchPath, {
      task: request.task,
      mcp_server: request.server,
      tool_name: request.upstreamTool,
      max_price_usdc: request.maxPriceUsdc,
    });

    let response;
    try {
      response = await this.fetchImpl(url, { method: "GET", headers: this.#buildHeaders() });
    } catch (error) {
      throw new AgoragenticExecuteError(`execute match request failed: ${error?.message || error}`, {
        code: "MATCH_NETWORK_ERROR",
        kind: "network_error",
        retryable: true,
        idempotencyKey: request.idempotencyKey,
        cause: error,
      });
    }

    const payload = await safeJson(response);
    if (!response.ok) {
      throw new AgoragenticExecuteError(`execute match failed with HTTP ${response.status}`, {
        code: "MATCH_HTTP_ERROR",
        kind: "http_error",
        status: response.status,
        retryable: response.status >= 500,
        idempotencyKey: request.idempotencyKey,
        details: payload,
      });
    }
    return normalizeQuotePayload(payload);
  }

  #normalizeRequest(args) {
    const task = String(args.task || "").trim();
    if (!task) {
      throw new TypeError("task is required");
    }
    const metadata = coerceObject(args.metadata, "metadata");
    const providedArgs = coerceObject(args.arguments, "arguments");
    return {
      task,
      server: String(args.mcp_server || this.defaultServer),
      upstreamTool: String(args.tool_name || this.defaultUpstreamTool),
      arguments: providedArgs,
      metadata,
      maxPriceUsdc: args.max_price_usdc ?? null,
      idempotencyKey: args.idempotency_key || randomUUID(),
      pay: args.pay || this.pay,
    };
  }

  #buildHeaders() {
    return this.apiKey ? { authorization: `Bearer ${this.apiKey}` } : {};
  }

  #buildJsonHeaders() {
    return {
      ...this.#buildHeaders(),
      "content-type": "application/json",
    };
  }

  #buildUsageReceipt({ request, quote, executePayload, executeResponse, paymentAuthorization, helperSource, attempts, paymentMeta, startedAt, error = null }) {
    const finishedAt = Date.now();
    const receipt = {
      schema: RECEIPT_SCHEMA,
      recorded_at: nowIso(),
      tool_name: this.toolName,
      base_url: this.baseUrl,
      helper_source: helperSource,
      idempotency_key: request.idempotencyKey,
      request: {
        task: request.task,
        mcp_server: request.server,
        upstream_tool: request.upstreamTool,
        arguments_sha256: sha256(request.arguments),
        metadata: request.metadata,
      },
      quote: {
        quote_id: quote.quoteId,
        listing_id: quote.listingId,
        capability_id: quote.capabilityId,
        price_usdc: quote.priceUsdc,
      },
      payment: {
        attempted: Boolean(paymentMeta?.paymentAttempted),
        authorization_attached: Boolean(paymentAuthorization),
        authorization: sanitizePaymentAuthorization(paymentAuthorization),
        receipt_header: executeResponse ? readHeader(executeResponse, "payment-receipt") : null,
        response_header: executeResponse ? readHeader(executeResponse, "payment-response") : null,
      },
      execution: {
        ok: !error,
        http_status: executeResponse?.status ?? error?.status ?? null,
        duration_ms: finishedAt - startedAt,
        attempts: attempts || 0,
        invocation_id: executePayload?.invocation_id || executePayload?.invocation?.id || null,
        receipt_reference: executePayload?.receipt_id || executePayload?.receipt?.id || (executeResponse ? readHeader(executeResponse, "payment-receipt") : null),
        output_sha256: executePayload ? sha256(executePayload) : null,
      },
      summary: executePayload ? extractTextSummary(executePayload) : null,
      uncertainty: [
        "This receipt records buyer-visible HTTP and local audit evidence only.",
        "payment-receipt or payment-response headers are transport evidence, not independent settlement proof.",
      ],
    };

    if (error) {
      receipt.error = {
        code: error.code,
        kind: error.kind,
        status: error.status,
        retryable: error.retryable,
        message: error.message,
      };
    }

    return receipt;
  }

  #recordReceipt(receipt) {
    this.receiptStore.append(receipt);
    this.auditSink(clone(receipt));
  }
}

export function createDemoPayGate(callLog) {
  return async function demoPay(paymentRequired, context) {
    callLog.push({
      paymentRequired,
      idempotencyKey: context.idempotencyKey,
    });
    return {
      authorizationHeader: `Demo paid ${paymentRequired}`,
      paymentSignature: `demo-signature-${context.idempotencyKey}`,
      paymentId: `pay_${context.idempotencyKey.slice(0, 8)}`,
      receipt: {
        demo: true,
        challenge: paymentRequired,
      },
    };
  };
}

export function createMockFetch({ mode = "success" } = {}) {
  const executeCalls = [];

  async function handler(input, init = {}) {
    const url = String(input instanceof URL ? input : input?.url || input);
    const method = String(init.method || "GET").toUpperCase();
    const headers = lowerCaseHeaders(init.headers || {});

    if (url.includes(DEFAULT_MATCH_PATH) && method === "GET") {
      const parsed = new URL(url);
      return jsonResponse(200, {
        quote_id: "quote_demo_001",
        price_usdc: 0.03,
        listing_id: "listing_demo_memory",
        capability_id: "cap_demo_memory_search",
        echoed_task: parsed.searchParams.get("task"),
      });
    }

    if (url.includes(DEFAULT_EXECUTE_PATH) && method === "POST") {
      const requestBody = JSON.parse(init.body || "{}");
      executeCalls.push({
        idempotencyKey: headers["idempotency-key"] || null,
        authorization: headers.authorization || null,
        paymentSignature: headers["payment-signature"] || null,
        body: requestBody,
      });

      if (mode === "governance-denied") {
        return jsonResponse(403, {
          error: {
            code: "governance_denied",
            message: "Request requires human approval.",
          },
        });
      }

      if (!headers.authorization) {
        return jsonResponse(402, {
          error: {
            code: "payment_required",
            message: "Payment authorization required.",
          },
        }, {
          "payment-required": "demo-challenge-001",
        });
      }

      if (mode === "network-after-payment" && executeCalls.length === 2) {
        throw new Error("simulated transient network loss after authorization");
      }

      return jsonResponse(200, {
        invocation_id: "inv_demo_001",
        receipt_id: "receipt_demo_001",
        result: {
          content: [
            {
              type: "text",
              text: "Found 2 memories about deployment windows and release approvals.",
            },
          ],
          structuredContent: {
            memories: [
              {
                id: "mem_001",
                excerpt: "Deploy after 22:00 UTC on weekdays.",
                score: 0.98,
              },
              {
                id: "mem_002",
                excerpt: "Avoid Friday deploys unless explicitly approved.",
                score: 0.95,
              },
            ],
          },
        },
      }, {
        "payment-receipt": "receipt_demo_001",
        "payment-response": "paid-demo-response-001",
      });
    }

    return jsonResponse(404, { error: { code: "not_found", url, method } });
  }

  handler.executeCalls = executeCalls;
  return handler;
}

export async function runSelfTest() {
  const payCalls = [];
  const mockFetch = createMockFetch({ mode: "success" });
  const tool = new LiteLLMAgoragenticExecuteTool({
    baseUrl: DEFAULT_BASE_URL,
    fetchImpl: mockFetch,
    pay: createDemoPayGate(payCalls),
  });

  const toolDefinition = tool.buildLiteLLMToolDefinition();
  assert.equal(toolDefinition.function.name, DEFAULT_TOOL_NAME);

  const result = await tool.invoke({
    task: "Search for deployment guidance for the current user",
    mcp_server: "m3-memory",
    tool_name: "search_memories",
    arguments: { query: "deployment windows", limit: 2 },
    metadata: { provider: "litellm", model: "gpt-4.1-mini" },
    idempotency_key: "idem_demo_success_001",
  });

  assert.equal(result.ok, true);
  assert.equal(result.usage_receipt.quote.quote_id, "quote_demo_001");
  assert.equal(result.usage_receipt.execution.receipt_reference, "receipt_demo_001");
  assert.equal(result.usage_receipt.payment.attempted, true);
  assert.equal(result.usage_receipt.payment.authorization_attached, true);
  assert.equal(result.usage_receipt.request.arguments_sha256, sha256({ query: "deployment windows", limit: 2 }));
  assert.equal(payCalls.length, 1);
  assert.equal(mockFetch.executeCalls.length, 2);
  assert.equal(mockFetch.executeCalls[0].idempotencyKey, "idem_demo_success_001");
  assert.equal(mockFetch.executeCalls[1].idempotencyKey, "idem_demo_success_001");
  assert.equal(mockFetch.executeCalls[1].authorization.startsWith("Demo paid demo-challenge-001"), true);
  assert.equal(tool.listUsageReceipts().length, 1);

  const withoutPay = new LiteLLMAgoragenticExecuteTool({
    baseUrl: DEFAULT_BASE_URL,
    fetchImpl: createMockFetch({ mode: "success" }),
  });
  const denied = await withoutPay.invoke({
    task: "Attempt paid tool without pay callback",
    arguments: { query: "fail" },
    idempotency_key: "idem_demo_failure_001",
  });
  assert.equal(denied.ok, false);
  assert.equal(denied.error.kind, "payment_required");
  assert.equal(denied.error.retryable, false);

  return {
    success_demo: result,
    failure_demo: denied,
  };
}

async function main() {
  const report = await runSelfTest();
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    const normalized = classifyError(error);
    process.stderr.write(`${normalized.name}: ${normalized.message}\n`);
    process.exitCode = 1;
  });
}
