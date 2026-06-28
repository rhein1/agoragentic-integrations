#!/usr/bin/env node
// demo — self-test moves no real funds; pay() returns mock authorization only.

import assert from "node:assert/strict";
import crypto from "node:crypto";
import process from "node:process";

const DEFAULT_BASE_URL = process.env.AGORAGENTIC_BASE_URL || "https://agoragentic.com";
const DEFAULT_EXECUTE_PATH = "/api/x402/execute";
const DEFAULT_MATCH_PATH = "/api/x402/execute/match";
const DEFAULT_TOOL_ID = "agoragentic_execute";
const DEFAULT_MANIFEST_TOOL_ID = "agoragentic_manifest_preview";
const DEFAULT_LISTING_ID = "irsa070501.advanced-ai-agents.mcp.execute.v1";
const DEFAULT_LISTING_NAME = "Advanced AI Agents MCP Execute Wrapper";
const DEMO_NOTE = "demo — draft seller listing manifest and self-test only; not published; moves no real funds";

function nowIso() {
  return new Date().toISOString();
}

function randomId(prefix) {
  return `${prefix}_${crypto.randomUUID().replace(/-/g, "")}`;
}

function stableJson(value) {
  if (Array.isArray(value)) {
    return `[${value.map((item) => stableJson(item)).join(",")}]`;
  }
  if (value && typeof value === "object") {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

function sha256(value) {
  return `sha256:${crypto.createHash("sha256").update(String(value)).digest("hex")}`;
}

function deepClone(value) {
  return value === undefined ? undefined : JSON.parse(JSON.stringify(value));
}

function isPlainObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function assertPlainObject(value, label) {
  if (!isPlainObject(value)) {
    throw new TypeError(`${label} must be an object`);
  }
}

function requireNonEmptyString(value, label) {
  const normalized = String(value || "").trim();
  if (!normalized) {
    throw new TypeError(`${label} must be a non-empty string`);
  }
  return normalized;
}

function lowerCaseHeaders(input = {}) {
  if (input instanceof Headers) {
    return Object.fromEntries(Array.from(input.entries(), ([key, val]) => [String(key).toLowerCase(), val]));
  }
  return Object.fromEntries(Object.entries(input || {}).map(([key, val]) => [String(key).toLowerCase(), val]));
}

function readHeader(source, name) {
  if (!source) return null;
  const wanted = String(name).toLowerCase();
  if (typeof source.get === "function") return source.get(name) ?? source.get(wanted) ?? null;
  const headers = lowerCaseHeaders(source.headers || source);
  return headers[wanted] ?? null;
}

function buildUrl(baseUrl, path) {
  return new URL(path, baseUrl.endsWith("/") ? baseUrl : `${baseUrl}/`).toString();
}

async function safeJson(response) {
  const raw = await response.text();
  if (!raw) return null;
  try {
    return JSON.parse(raw);
  } catch {
    return { raw };
  }
}

function extractInvocationId(payload) {
  return payload?.invocation_id ?? payload?.invocationId ?? payload?.result?.invocation_id ?? null;
}

function extractReceiptId(payload, response = null) {
  return payload?.receipt_id
    ?? payload?.receipt?.receipt_id
    ?? payload?.receipt?.id
    ?? readHeader(response, "payment-receipt")
    ?? null;
}

function normalizeToolDefinition(definition) {
  const name = requireNonEmptyString(definition?.name, "tool.name");
  const description = requireNonEmptyString(definition?.description || `${name} local capability`, "tool.description");
  const inputSchema = isPlainObject(definition?.inputSchema)
    ? deepClone(definition.inputSchema)
    : { type: "object", additionalProperties: true };
  const handler = definition?.handler ?? definition?.run ?? definition?.execute;
  if (typeof handler !== "function") {
    throw new TypeError(`tool ${name} must define handler(), run(), or execute()`);
  }
  return { name, description, inputSchema, handler, metadata: deepClone(definition?.metadata || {}) };
}

function responseJson(status, body, headers = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "content-type": "application/json",
      ...headers,
    },
  });
}

async function inlineX402Fetch(url, options = {}) {
  const {
    fetchImpl = globalThis.fetch,
    pay,
    idempotencyKey = crypto.randomUUID(),
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
  let authorization = null;
  let paymentSignature = null;
  let retries = 0;
  let saw402 = false;

  while (true) {
    const requestHeaders = {
      accept: "application/json",
      "idempotency-key": idempotencyKey,
      ...baseHeaders,
    };
    if (authorization) requestHeaders.authorization = authorization;
    if (paymentSignature) requestHeaders["payment-signature"] = paymentSignature;

    let requestBody = body;
    if (requestBody !== undefined && requestBody !== null && typeof requestBody !== "string") {
      requestBody = JSON.stringify(requestBody);
      if (!requestHeaders["content-type"]) requestHeaders["content-type"] = "application/json";
    }

    try {
      const response = await fetchImpl(url, { method, headers: requestHeaders, body: requestBody, signal });
      if (response.status !== 402) {
        response.x402Meta = {
          helper: "inline-fallback",
          idempotencyKey,
          paymentAttempted: saw402,
          paymentAuthorized: Boolean(authorization || paymentSignature),
          networkRetriesUsed: retries,
        };
        return response;
      }

      saw402 = true;
      if (authorization || paymentSignature) {
        throw Object.assign(new Error("Paid request returned HTTP 402 again after authorization"), { status: 402, idempotencyKey });
      }
      const challenge = readHeader(response, "payment-required");
      if (!challenge) {
        throw Object.assign(new Error("HTTP 402 missing payment-required header"), { status: 402, idempotencyKey });
      }
      if (typeof pay !== "function") {
        throw Object.assign(new Error("HTTP 402 requires a caller-supplied pay callback"), { status: 402, idempotencyKey });
      }
      const payment = await pay(challenge, {
        url,
        method,
        headers: requestHeaders,
        body: requestBody,
        idempotencyKey,
      });
      if (!payment || typeof payment !== "object") {
        throw new Error("pay callback must return an object with authorizationHeader or paymentSignature");
      }
      authorization = payment.authorizationHeader || payment.authorization || null;
      paymentSignature = payment.paymentSignature || null;
      if (!authorization && !paymentSignature) {
        throw new Error("pay callback must return authorizationHeader or paymentSignature");
      }
    } catch (error) {
      if (typeof error?.status === "number") throw error;
      if (!authorization && !paymentSignature) throw error;
      if (retries >= maxNetworkRetries) {
        const wrapped = new Error(`Network error after payment authorization was prepared: ${error.message}`);
        wrapped.name = "NetworkError";
        wrapped.idempotencyKey = idempotencyKey;
        wrapped.cause = error;
        throw wrapped;
      }
      retries += 1;
    }
  }
}

let cachedX402FetchPromise = null;
async function loadX402Fetch() {
  if (!cachedX402FetchPromise) {
    cachedX402FetchPromise = (async () => {
      try {
        const preferred = await import("agoragentic/x402-client");
        if (typeof preferred.x402Fetch === "function") return preferred.x402Fetch;
      } catch {}
      try {
        const fallback = await import("../../../x402/x402-receipt-validation-adapter.mjs");
        if (typeof fallback.x402FetchWithFallback === "function") return fallback.x402FetchWithFallback;
      } catch {}
      return inlineX402Fetch;
    })();
  }
  return cachedX402FetchPromise;
}

export class AdvancedAiAgentsAgoragenticExecuteWrapper {
  constructor(options = {}) {
    this.baseUrl = String(options.baseUrl || DEFAULT_BASE_URL).replace(/\/$/, "");
    this.executePath = options.executePath || DEFAULT_EXECUTE_PATH;
    this.matchPath = options.matchPath || DEFAULT_MATCH_PATH;
    this.fetchImpl = options.fetchImpl || globalThis.fetch;
    this.apiKey = options.apiKey || process.env.AGORAGENTIC_API_KEY || "";
    this.pay = options.pay;
    this.defaultTask = options.defaultTask || "advanced-ai-agents capability execution";
    this.defaultConstraints = deepClone(options.defaultConstraints || {});
    this.listingId = options.listingId || DEFAULT_LISTING_ID;
    this.listingName = options.listingName || DEFAULT_LISTING_NAME;
    this.listingVersion = options.listingVersion || "0.1.0";
    this.pricePerCallUsdc = Number(options.pricePerCallUsdc ?? 0.05);
    this.publicationState = options.publicationState || "draft";
    this.repositoryUrl = options.repositoryUrl || "https://github.com/Irsa070501/Advanced-AI-Agents";
    this.tools = new Map();

    if (typeof this.fetchImpl !== "function") {
      throw new TypeError("fetchImpl is required (Node 18+ or pass fetchImpl)");
    }
    if (!Number.isFinite(this.pricePerCallUsdc) || this.pricePerCallUsdc < 0) {
      throw new TypeError("pricePerCallUsdc must be a finite number >= 0");
    }

    for (const tool of options.tools || []) {
      this.registerLocalTool(tool);
    }
  }

  registerLocalTool(definition) {
    const tool = normalizeToolDefinition(definition);
    this.tools.set(tool.name, tool);
    return tool;
  }

  listLocalTools() {
    return Array.from(this.tools.values()).map((tool) => ({
      name: tool.name,
      description: tool.description,
      inputSchema: deepClone(tool.inputSchema),
      metadata: deepClone(tool.metadata),
    }));
  }

  buildHeaders(extraHeaders = {}) {
    const headers = {
      accept: "application/json",
      ...lowerCaseHeaders(extraHeaders),
    };
    if (this.apiKey) {
      headers.authorization = `Bearer ${this.apiKey}`;
    }
    return headers;
  }

  buildSellerManifest(overrides = {}) {
    const tools = this.listLocalTools();
    const manifest = {
      schema: "agoragentic.seller-listing.mcp.v1",
      id: overrides.listingId || this.listingId,
      version: overrides.version || this.listingVersion,
      name: overrides.name || this.listingName,
      summary: overrides.summary || "Expose Advanced-AI-Agents local tools as a draft Agoragentic MCP seller listing with execute()-compatible metadata and usage receipts.",
      notes: [DEMO_NOTE],
      provider: {
        org: "Irsa070501",
        service: "Advanced-AI-Agents",
        runtime: "mcp",
        repository: this.repositoryUrl,
        owner_hosted: true,
        trust_mode: "draft_local_wrapper",
      },
      listing: {
        listing_type: "service",
        category: overrides.category || "agent-framework",
        tags: ["advanced-ai-agents", "mcp", "execute-wrapper", "seller-manifest", "usage-receipts"],
        pricing_model: this.pricePerCallUsdc === 0 ? "free" : "per_call",
        price_per_call_usdc: this.pricePerCallUsdc,
        settlement_asset: "USDC",
        settlement_network: "base",
        publication_state: overrides.publicationState || this.publicationState,
        trust_signals: {
          receipts_emitted: true,
          draft_manifest_only: true,
          governed_publication_required: true,
          local_tool_inventory_hashed: true,
        },
      },
      mcp_server: {
        transport: "stdio",
        tool_count: tools.length,
        tools: tools.map((tool) => ({
          name: tool.name,
          description: tool.description,
          input_schema: deepClone(tool.inputSchema),
        })),
      },
      execute_wrapper: {
        entrypoint: `${DEFAULT_TOOL_ID}(task,input,constraints)`,
        task_examples: tools.slice(0, 3).map((tool) => `Route ${tool.name} through Agoragentic execute() with usage receipts.`),
        input_schema: {
          type: "object",
          additionalProperties: false,
          required: ["toolName", "input"],
          properties: {
            task: { type: "string", description: "Marketplace task label to route." },
            toolName: { type: "string", enum: tools.map((tool) => tool.name), description: "Local Advanced-AI-Agents tool to describe in manifest metadata." },
            quoteId: { type: "string" },
            idempotencyKey: { type: "string" },
            input: { type: "object", additionalProperties: true },
            constraints: { type: "object", additionalProperties: true },
            metadata: { type: "object", additionalProperties: true },
          },
        },
        output_schema: {
          type: "object",
          additionalProperties: false,
          required: ["ok", "tool", "manifest_id", "invocation_id", "idempotency_key", "payment", "result"],
          properties: {
            ok: { type: "boolean", const: true },
            tool: { type: "string" },
            manifest_id: { type: "string" },
            invocation_id: { type: "string" },
            idempotency_key: { type: "string" },
            receipt_id: { type: ["string", "null"] },
            payment: { type: "object", additionalProperties: true },
            result: { type: "object", additionalProperties: true },
          },
        },
      },
    };

    manifest.inventory_hash = sha256(stableJson(manifest.mcp_server.tools));
    manifest.generated_at = nowIso();
    return manifest;
  }

  describeTools() {
    return [
      {
        name: DEFAULT_TOOL_ID,
        description: "Route an Advanced-AI-Agents task through Agoragentic execute() using x402 payment gating and idempotent retries.",
        inputSchema: {
          type: "object",
          additionalProperties: false,
          required: ["toolName", "input"],
          properties: {
            task: { type: "string", description: "Marketplace task label. Defaults to a local wrapper task." },
            toolName: { type: "string", enum: this.listLocalTools().map((tool) => tool.name) },
            quoteId: { type: "string", description: "Optional quote_id to lock price before paid execution." },
            idempotencyKey: { type: "string", description: "Caller-supplied idempotency key. Generated if omitted." },
            input: { type: "object", additionalProperties: true },
            constraints: { type: "object", additionalProperties: true },
            metadata: { type: "object", additionalProperties: true },
          },
        },
        execute: async (args = {}) => this.execute(args),
      },
      {
        name: DEFAULT_MANIFEST_TOOL_ID,
        description: "Return a draft MCP seller listing manifest for the registered Advanced-AI-Agents tools.",
        inputSchema: {
          type: "object",
          additionalProperties: false,
          properties: {
            name: { type: "string" },
            summary: { type: "string" },
            listingId: { type: "string" },
            publicationState: { type: "string" },
          },
        },
        execute: async (args = {}) => this.buildSellerManifest(args),
      },
    ];
  }

  registerWithAdvancedAiAgents(host) {
    assertPlainObject(host, "host");
    const tools = this.describeTools();

    for (const tool of tools) {
      if (typeof host.registerTool === "function") {
        host.registerTool(tool);
      } else if (typeof host.addTool === "function") {
        host.addTool(tool.name, tool.description, tool.inputSchema, tool.execute);
      } else if (typeof host.tool === "function") {
        host.tool(tool.name, tool.description, tool.inputSchema, tool.execute);
      } else {
        if (!Array.isArray(host.tools)) host.tools = [];
        host.tools.push(tool);
      }
    }

    return tools;
  }

  async match(request = {}) {
    assertPlainObject(request, "request");
    const payload = {
      task: request.task || this.defaultTask,
      input: deepClone(request.input || {}),
      constraints: {
        ...deepClone(this.defaultConstraints),
        ...deepClone(request.constraints || {}),
      },
      metadata: {
        tool_name: request.toolName || null,
        local_manifest_id: this.listingId,
        ...deepClone(request.metadata || {}),
      },
    };

    const response = await this.fetchImpl(buildUrl(this.baseUrl, this.matchPath), {
      method: "POST",
      headers: {
        ...this.buildHeaders({ "content-type": "application/json" }),
      },
      body: JSON.stringify(payload),
    });

    const matchPayload = await safeJson(response);
    if (!response.ok) {
      const error = new Error(`match() failed with HTTP ${response.status}`);
      error.status = response.status;
      error.payload = matchPayload;
      throw error;
    }
    return matchPayload;
  }

  async execute(request = {}) {
    assertPlainObject(request, "request");
    const toolName = requireNonEmptyString(request.toolName, "request.toolName");
    if (!this.tools.has(toolName)) {
      throw new Error(`Unknown local tool: ${toolName}`);
    }
    assertPlainObject(request.input || {}, "request.input");

    const idempotencyKey = request.idempotencyKey || crypto.randomUUID();
    const x402Fetch = await loadX402Fetch();
    const payload = {
      task: request.task || this.defaultTask,
      input: deepClone(request.input || {}),
      constraints: {
        ...deepClone(this.defaultConstraints),
        ...deepClone(request.constraints || {}),
      },
      metadata: {
        tool_name: toolName,
        local_manifest_id: this.listingId,
        local_manifest_hash: this.buildSellerManifest().inventory_hash,
        local_repository: this.repositoryUrl,
        ...deepClone(request.metadata || {}),
      },
    };

    if (request.quoteId) {
      payload.quote_id = request.quoteId;
    }

    const response = await x402Fetch(buildUrl(this.baseUrl, this.executePath), {
      fetchImpl: this.fetchImpl,
      pay: request.pay || this.pay,
      idempotencyKey,
      method: "POST",
      headers: {
        ...this.buildHeaders({ "content-type": "application/json" }),
      },
      body: payload,
    });

    const executePayload = await safeJson(response);
    if (!response.ok) {
      const error = new Error(`execute() failed with HTTP ${response.status}`);
      error.status = response.status;
      error.payload = executePayload;
      error.idempotencyKey = idempotencyKey;
      throw error;
    }

    return {
      ok: true,
      tool: toolName,
      manifest_id: this.listingId,
      invocation_id: extractInvocationId(executePayload),
      receipt_id: extractReceiptId(executePayload, response),
      idempotency_key: idempotencyKey,
      payment: {
        payment_required: readHeader(response, "payment-required"),
        payment_response: readHeader(response, "payment-response"),
        payment_receipt: readHeader(response, "payment-receipt"),
        x402_meta: response.x402Meta || null,
      },
      result: executePayload,
    };
  }
}

function parseArgs(argv) {
  const args = {
    command: "self-test",
    input: null,
    pretty: true,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    switch (token) {
      case "--self-test":
        args.command = "self-test";
        break;
      case "--manifest":
        args.command = "manifest";
        break;
      case "--demo-execute":
        args.command = "demo-execute";
        break;
      case "--input":
        args.input = argv[index + 1] ?? null;
        index += 1;
        break;
      case "--compact":
        args.pretty = false;
        break;
      case "--help":
      case "-h":
        args.command = "help";
        break;
      default:
        if (token.startsWith("--input=")) {
          args.input = token.slice("--input=".length);
        } else {
          throw new Error(`Unknown argument: ${token}`);
        }
    }
  }

  return args;
}

function printJson(value, pretty = true) {
  process.stdout.write(`${JSON.stringify(value, null, pretty ? 2 : 0)}\n`);
}

function createMockAdvancedAiAgentsHost() {
  return {
    tools: [],
    registerTool(tool) {
      this.tools.push(tool);
    },
  };
}

function createMockFetch() {
  const state = {
    executeCalls: 0,
    matchCalls: 0,
    lastExecuteHeaders: null,
    payCallsObserved: 0,
  };

  const fetchImpl = async (url, init = {}) => {
    const pathname = new URL(url).pathname;
    const headers = lowerCaseHeaders(init.headers || {});

    if (pathname === DEFAULT_MATCH_PATH) {
      state.matchCalls += 1;
      return responseJson(200, {
        ok: true,
        providers: [
          {
            provider_id: "prov_demo_advanced_ai_agents",
            listing_id: DEFAULT_LISTING_ID,
            estimated_cost_usdc: 0.05,
          },
        ],
      });
    }

    if (pathname === DEFAULT_EXECUTE_PATH) {
      state.executeCalls += 1;
      state.lastExecuteHeaders = headers;
      const auth = headers.authorization || headers["payment-signature"] || "";
      if (!auth) {
        return responseJson(402, { ok: false, error: "payment_required" }, {
          "payment-required": JSON.stringify({
            challenge_id: "pc_demo_123",
            asset: "USDC",
            network: "base",
            amount: "0.05",
            pay_to: "demo_seller_wallet",
          }),
        });
      }

      return responseJson(200, {
        ok: true,
        invocation_id: "inv_demo_advanced_ai_agents",
        receipt_id: "rcpt_demo_advanced_ai_agents",
        output: {
          status: "accepted",
          provider: "prov_demo_advanced_ai_agents",
          echoed_input: JSON.parse(init.body).input,
        },
      }, {
        "payment-response": JSON.stringify({ authorization_id: "auth_demo_123" }),
        "payment-receipt": "rcpt_demo_advanced_ai_agents",
      });
    }

    return responseJson(404, { ok: false, error: "not_found", pathname });
  };

  return { state, fetchImpl };
}

export async function runSelfTest() {
  const { state, fetchImpl } = createMockFetch();
  let payCalls = 0;
  const wrapper = new AdvancedAiAgentsAgoragenticExecuteWrapper({
    baseUrl: "https://demo.agoragentic.invalid",
    fetchImpl,
    pay: async (paymentRequired, context) => {
      payCalls += 1;
      assert.equal(context.idempotencyKey.length > 10, true);
      assert.ok(String(paymentRequired).includes("pc_demo_123"));
      return { authorizationHeader: "Bearer mock_paid_authorization" };
    },
    tools: [
      {
        name: "research.summarize_brief",
        description: "Summarize a research brief into bounded action items.",
        inputSchema: {
          type: "object",
          additionalProperties: false,
          required: ["brief"],
          properties: {
            brief: { type: "string" },
          },
        },
        handler: async (input) => ({ ok: true, summary: input.brief.slice(0, 40) }),
      },
    ],
  });

  const host = createMockAdvancedAiAgentsHost();
  const tools = wrapper.registerWithAdvancedAiAgents(host);
  assert.equal(tools.length, 2);
  assert.equal(host.tools.length, 2);

  const manifest = wrapper.buildSellerManifest();
  assert.equal(manifest.schema, "agoragentic.seller-listing.mcp.v1");
  assert.equal(manifest.mcp_server.tool_count, 1);
  assert.equal(manifest.mcp_server.tools[0].name, "research.summarize_brief");
  assert.ok(manifest.inventory_hash.startsWith("sha256:"));

  const match = await wrapper.match({
    toolName: "research.summarize_brief",
    input: { brief: "Match request" },
  });
  assert.equal(match.ok, true);
  assert.equal(state.matchCalls, 1);

  const executeResult = await wrapper.execute({
    toolName: "research.summarize_brief",
    input: { brief: "Summarize the paid capability path" },
    metadata: { origin: "self-test" },
  });

  assert.equal(executeResult.ok, true);
  assert.equal(executeResult.invocation_id, "inv_demo_advanced_ai_agents");
  assert.equal(executeResult.receipt_id, "rcpt_demo_advanced_ai_agents");
  assert.equal(payCalls, 1, "payment authorization should be created once");
  assert.equal(state.executeCalls, 2, "execute should challenge once and succeed on retry");
  assert.ok(state.lastExecuteHeaders["idempotency-key"], "idempotency key header required");
  assert.equal(state.lastExecuteHeaders.authorization, "Bearer mock_paid_authorization");

  return {
    ok: true,
    registeredTools: host.tools.map((tool) => tool.name),
    listingId: manifest.id,
    inventoryHash: manifest.inventory_hash,
    execute: executeResult,
  };
}

async function runDemoExecute(inputArg) {
  const { fetchImpl } = createMockFetch();
  const wrapper = new AdvancedAiAgentsAgoragenticExecuteWrapper({
    baseUrl: "https://demo.agoragentic.invalid",
    fetchImpl,
    pay: async () => ({ authorizationHeader: "Bearer mock_paid_authorization" }),
    tools: [
      {
        name: "research.summarize_brief",
        description: "Summarize a research brief into bounded action items.",
        inputSchema: {
          type: "object",
          additionalProperties: false,
          required: ["brief"],
          properties: {
            brief: { type: "string" },
          },
        },
        handler: async (input) => ({ ok: true, summary: input.brief.slice(0, 40) }),
      },
    ],
  });

  const parsedInput = inputArg ? JSON.parse(inputArg) : { toolName: "research.summarize_brief", input: { brief: "Draft a monetizable seller manifest" } };
  return wrapper.execute(parsedInput);
}

async function main() {
  const args = parseArgs(process.argv.slice(2));

  if (args.command === "help") {
    process.stdout.write([
      "Usage:",
      "  node advanced_ai_agents_agoragentic_execute_wrapper.mjs --self-test",
      "  node advanced_ai_agents_agoragentic_execute_wrapper.mjs --manifest",
      "  node advanced_ai_agents_agoragentic_execute_wrapper.mjs --demo-execute --input '{\"toolName\":\"research.summarize_brief\",\"input\":{\"brief\":\"hello\"}}'",
    ].join("\n") + "\n");
    return;
  }

  if (args.command === "manifest") {
    const wrapper = new AdvancedAiAgentsAgoragenticExecuteWrapper({
      tools: [
        {
          name: "research.summarize_brief",
          description: "Summarize a research brief into bounded action items.",
          inputSchema: {
            type: "object",
            additionalProperties: false,
            required: ["brief"],
            properties: {
              brief: { type: "string" },
            },
          },
          handler: async (input) => ({ ok: true, summary: input.brief.slice(0, 40) }),
        },
      ],
    });
    printJson(wrapper.buildSellerManifest(), args.pretty);
    return;
  }

  if (args.command === "demo-execute") {
    printJson(await runDemoExecute(args.input), args.pretty);
    return;
  }

  printJson(await runSelfTest(), args.pretty);
}

const isMain = import.meta.url === new URL(process.argv[1], "file:").href;
if (isMain) {
  main().catch((error) => {
    const payload = {
      ok: false,
      error: error.message,
      name: error.name,
      status: error.status ?? null,
      idempotencyKey: error.idempotencyKey ?? null,
      payload: error.payload ?? null,
    };
    process.stderr.write(`${JSON.stringify(payload, null, 2)}\n`);
    process.exitCode = 1;
  });
}
