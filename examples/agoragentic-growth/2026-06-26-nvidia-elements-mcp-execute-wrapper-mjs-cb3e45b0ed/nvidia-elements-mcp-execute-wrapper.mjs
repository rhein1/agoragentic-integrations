// demo — simulates payment authorization and usage receipts; moves no real funds.

import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { createServer } from "node:http";
import { once } from "node:events";
import readline from "node:readline";

const DEFAULT_BASE_URL = process.env.AGORAGENTIC_BASE_URL || "http://127.0.0.1:0";
const DEFAULT_EXECUTE_PATH = process.env.AGORAGENTIC_EXECUTE_PATH || "/api/x402/execute";

function sha256(value) {
  const text = typeof value === "string" ? value : stableStringify(value);
  return createHash("sha256").update(text).digest("hex");
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

function lowerCaseHeaders(input = {}) {
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
  const headers = lowerCaseHeaders(source.headers || source);
  return headers[String(name).toLowerCase()] ?? null;
}

function parsePaymentHeader(value) {
  if (!value) return null;
  const raw = String(value);
  const trimmed = raw.startsWith("x402:") ? raw.slice(5) : raw;
  try {
    return JSON.parse(trimmed);
  } catch {
    try {
      return JSON.parse(Buffer.from(trimmed, "base64").toString("utf8"));
    } catch {
      return { raw };
    }
  }
}

function normalizePaymentProof(payment) {
  if (!payment || typeof payment !== "object") return null;
  const authorizationHeader =
    payment.authorizationHeader ||
    payment.authorization ||
    payment.paymentAuthorization ||
    payment.token ||
    null;
  const paymentSignature = payment.paymentSignature || payment.signature || null;
  const paymentResponse = payment.paymentResponse || null;
  if (!authorizationHeader && !paymentSignature && !paymentResponse) {
    return null;
  }
  return { authorizationHeader, paymentSignature, paymentResponse };
}

function buildUrl(baseUrl, path) {
  return new URL(path, baseUrl).toString();
}

async function safeJson(response) {
  const text = await response.text();
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    return { raw: text };
  }
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

async function maybeImportX402Fetch() {
  const candidates = ["agoragentic/x402-client", "../lib/x402-client.mjs"];
  for (const specifier of candidates) {
    try {
      const mod = await import(specifier);
      if (typeof mod.x402Fetch === "function") {
        return { x402Fetch: mod.x402Fetch, source: specifier };
      }
    } catch {
      // Fall back to a local demo-compatible helper.
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
      maxNetworkRetries = 1,
    } = options;

    if (typeof fetchImpl !== "function") {
      throw new Error("x402Fetch requires fetchImpl when global fetch is unavailable");
    }
    if (!idempotencyKey) {
      throw new Error("x402Fetch requires an idempotencyKey");
    }

    const baseHeaders = {
      accept: "application/json",
      "x-idempotency-key": idempotencyKey,
      "idempotency-key": idempotencyKey,
      ...headers,
    };

    let authorization = null;
    let paidChallengeId = null;
    let networkRetriesUsed = 0;

    for (;;) {
      const requestHeaders = { ...baseHeaders };
      if (authorization?.authorizationHeader) {
        if (requestHeaders.authorization && authorization.paymentSignature) {
          requestHeaders["x-payment-authorization"] = authorization.authorizationHeader;
        } else {
          requestHeaders.authorization = authorization.authorizationHeader;
        }
      }
      if (authorization?.paymentSignature) {
        requestHeaders["payment-signature"] = authorization.paymentSignature;
      }
      if (authorization?.paymentResponse) {
        requestHeaders["payment-response"] = authorization.paymentResponse;
      }

      try {
        const response = await fetchImpl(url, {
          method,
          headers: requestHeaders,
          body,
          signal,
        });

        if (response.status !== 402) {
          response.x402Meta = {
            helper: "inline-demo-compat",
            idempotencyKey,
            paymentAuthorized: Boolean(authorization),
            networkRetriesUsed,
            paidChallengeId,
          };
          return response;
        }

        if (typeof pay !== "function") {
          throw createHttpError("x402Fetch received HTTP 402 but no pay callback was supplied", {
            status: 402,
            idempotencyKey,
          });
        }

        if (authorization) {
          throw createHttpError("Server returned HTTP 402 after payment proof was already provided", {
            status: 402,
            idempotencyKey,
            paidChallengeId,
          });
        }

        const challengeHeader = readHeader(response, "payment-required") || readHeader(response, "x-payment-required");
        const challenge = challengeHeader ? parsePaymentHeader(challengeHeader) : await safeJson(response);
        const challengeId = challenge?.challenge_id ?? challenge?.id ?? null;

        const payment = await pay({
          challenge,
          paymentRequired: challengeHeader,
          url,
          method,
          body,
          idempotencyKey,
        });

        authorization = normalizePaymentProof(payment);
        if (!authorization) {
          throw new Error("pay callback must return payment proof headers");
        }
        paidChallengeId = challengeId;
      } catch (error) {
        if (typeof error?.status === "number") {
          throw error;
        }
        if (!authorization) {
          throw error;
        }
        if (networkRetriesUsed >= maxNetworkRetries) {
          throw createNetworkError(`Network error after payment authorization was prepared: ${error.message}`, {
            cause: error,
            idempotencyKey,
            paidChallengeId,
            paymentAuthorized: true,
            networkRetriesUsed,
          });
        }
        networkRetriesUsed += 1;
      }
    }
  };
}

export class NvidiaElementsExecuteWrapper {
  constructor(options = {}) {
    this.marketplaceBaseUrl = options.marketplaceBaseUrl || DEFAULT_BASE_URL;
    this.executePath = options.executePath || DEFAULT_EXECUTE_PATH;
    this.capabilityId = options.capabilityId || "nvidia/elements.execute";
    this.provider = options.provider || "nvidia-elements";
    this.pay = options.pay;
    this.fetchImpl = options.fetchImpl || globalThis.fetch;
    this.apiKey = options.apiKey || null;
    this.defaultHeaders = lowerCaseHeaders(options.headers || {});
    this.defaultTrustMode = options.defaultTrustMode || "trust-checked";
    this.defaultSeller = options.defaultSeller || "demo-seller";
    this.x402 = null;
  }

  async init() {
    if (!this.x402) {
      this.x402 = await maybeImportX402Fetch();
    }
    return this;
  }

  toolDefinition() {
    return {
      name: "nvidia_elements_execute",
      title: "Agoragentic NVIDIA Elements execute() wrapper",
      description:
        "Run a seller-packaged NVIDIA Elements capability through Agoragentic execute() with trust metadata and x402 usage receipts.",
      inputSchema: {
        type: "object",
        additionalProperties: false,
        required: ["tool", "input"],
        properties: {
          tool: {
            type: "string",
            description: "Seller-defined NVIDIA Elements tool name, for example image.generate or video.caption.",
          },
          input: {
            type: "object",
            description: "JSON input passed through to the seller tool.",
          },
          capabilityId: {
            type: "string",
            description: "Optional override for the marketplace capability id.",
          },
          seller: {
            type: "string",
            description: "Optional seller slug or account id.",
          },
          trustMode: {
            type: "string",
            enum: ["trust-checked", "best-effort"],
            description: "Marketplace trust mode to request.",
          },
          traceId: {
            type: "string",
            description: "Optional trace id for cross-system observability.",
          },
          idempotencyKey: {
            type: "string",
            description: "Optional caller-provided idempotency key.",
          },
        },
      },
    };
  }

  buildExecutePayload(args = {}) {
    const capabilityId = args.capabilityId || this.capabilityId;
    return {
      task: capabilityId,
      input: {
        transport: "mcp",
        provider: this.provider,
        seller: args.seller || this.defaultSeller,
        tool: args.tool,
        arguments: args.input,
      },
      constraints: {
        trust_mode: args.trustMode || this.defaultTrustMode,
        provider: this.provider,
        seller: args.seller || this.defaultSeller,
      },
      capability_id: capabilityId,
      seller: args.seller || this.defaultSeller,
      provider: this.provider,
      trust_mode: args.trustMode || this.defaultTrustMode,
      execute: {
        tool: args.tool,
        input: args.input,
      },
      trace_id: args.traceId || `trace_${randomUUID()}`,
      requested_at: new Date().toISOString(),
      client: {
        wrapper: "nvidia-elements-mcp-execute-wrapper",
        version: "1.0.0",
      },
    };
  }

  buildUsageReceipt({ payload, response, idempotencyKey, x402Meta, requestDigest }) {
    const rawReceipt =
      payload?.usage_receipt ||
      payload?.receipt ||
      payload?.result?.usage_receipt ||
      null;

    const receiptId =
      rawReceipt?.id ||
      payload?.receipt_id ||
      readHeader(response, "payment-receipt") ||
      readHeader(response, "x-payment-receipt") ||
      null;

    const paymentResponse =
      rawReceipt?.payment_response ||
      readHeader(response, "payment-response") ||
      readHeader(response, "x-payment-response") ||
      null;

    const challengeId =
      rawReceipt?.challenge_id ||
      x402Meta?.paidChallengeId ||
      payload?.payment?.challenge_id ||
      null;

    const resultDigest = sha256(payload?.result ?? payload?.output ?? payload ?? {});
    return {
      id: receiptId,
      invocation_id: payload?.invocation_id ?? payload?.invocationId ?? null,
      challenge_id: challengeId,
      payment_response: paymentResponse,
      idempotency_key: idempotencyKey,
      trust: {
        mode: payload?.trust?.mode ?? payload?.trust_mode ?? this.defaultTrustMode,
        verified: typeof payload?.trust?.verified === "boolean" ? payload.trust.verified : null,
      },
      digests: {
        request: requestDigest,
        result: resultDigest,
      },
      headers: {
        payment_receipt: readHeader(response, "payment-receipt") || readHeader(response, "x-payment-receipt"),
        payment_response: readHeader(response, "payment-response") || readHeader(response, "x-payment-response"),
      },
      source: rawReceipt ? "body" : "headers-and-body",
    };
  }

  async execute(args = {}) {
    await this.init();

    if (!args.tool || typeof args.tool !== "string") {
      throw new Error("execute() requires a string tool name");
    }
    if (!args.input || typeof args.input !== "object" || Array.isArray(args.input)) {
      throw new Error("execute() requires an input object");
    }

    const idempotencyKey = args.idempotencyKey || randomUUID();
    const bodyPayload = this.buildExecutePayload({ ...args, idempotencyKey });
    const requestDigest = sha256({
      method: "POST",
      path: this.executePath,
      body: bodyPayload,
    });

    const response = await this.x402.x402Fetch(buildUrl(this.marketplaceBaseUrl, this.executePath), {
      fetchImpl: this.fetchImpl,
      pay: this.pay,
      idempotencyKey,
      method: "POST",
      headers: this.buildExecuteHeaders(),
      body: JSON.stringify(bodyPayload),
    });

    const payload = await safeJson(response);

    if (!response.ok) {
      throw createHttpError(`Agoragentic execute() failed with HTTP ${response.status}`, {
        status: response.status,
        payload,
        idempotencyKey,
      });
    }

    const receipt = this.buildUsageReceipt({
      payload,
      response,
      idempotencyKey,
      x402Meta: response.x402Meta || {},
      requestDigest,
    });

    return {
      ok: true,
      helper: this.x402.source,
      idempotencyKey,
      invocationId: payload?.invocation_id ?? payload?.invocationId ?? null,
      output: payload?.result ?? payload?.output ?? payload,
      receipt,
      raw: payload,
    };
  }

  buildExecuteHeaders() {
    const headers = {
      ...this.defaultHeaders,
      "content-type": "application/json",
    };
    if (this.apiKey) {
      headers.authorization = `Bearer ${this.apiKey}`;
    }
    return headers;
  }
}

export class LocalMcpServer {
  constructor({ wrapper, input = process.stdin, output = process.stdout, error = process.stderr } = {}) {
    if (!wrapper) {
      throw new Error("LocalMcpServer requires a wrapper instance");
    }
    this.wrapper = wrapper;
    this.input = input;
    this.output = output;
    this.error = error;
  }

  async handleMessage(message) {
    const id = message?.id ?? null;
    const isNotification = id === null || id === undefined;

    try {
      switch (message?.method) {
        case "initialize":
          return {
            jsonrpc: "2.0",
            id,
            result: {
              protocolVersion: "2024-11-05",
              serverInfo: {
                name: "nvidia-elements-execute-wrapper",
                version: "1.0.0",
              },
              capabilities: {
                tools: {},
              },
            },
          };

        case "tools/list":
          return {
            jsonrpc: "2.0",
            id,
            result: {
              tools: [this.wrapper.toolDefinition()],
            },
          };

        case "tools/call": {
          const toolName = message?.params?.name;
          if (toolName !== "nvidia_elements_execute") {
            throw createHttpError(`Unknown tool: ${toolName}`, { status: 400 });
          }

          const result = await this.wrapper.execute(message?.params?.arguments || {});
          return {
            jsonrpc: "2.0",
            id,
            result: {
              content: [
                {
                  type: "text",
                  text: JSON.stringify(result, null, 2),
                },
              ],
              structuredContent: result,
              isError: false,
            },
          };
        }

        default:
          if (isNotification) {
            return null;
          }
          return {
            jsonrpc: "2.0",
            id,
            error: {
              code: -32601,
              message: `Method not found: ${message?.method}`,
            },
          };
      }
    } catch (error) {
      if (isNotification) {
        return null;
      }
      return {
        jsonrpc: "2.0",
        id,
        error: {
          code: typeof error?.status === "number" ? error.status : -32000,
          message: error?.message || "Unhandled server error",
          data: {
            name: error?.name || "Error",
            payload: error?.payload || null,
          },
        },
      };
    }
  }

  async serve() {
    const rl = readline.createInterface({
      input: this.input,
      crlfDelay: Infinity,
    });

    for await (const line of rl) {
      const trimmed = line.trim();
      if (!trimmed) continue;

      let message;
      try {
        message = JSON.parse(trimmed);
      } catch (error) {
        this.output.write(
          `${JSON.stringify({
            jsonrpc: "2.0",
            id: null,
            error: { code: -32700, message: `Parse error: ${error.message}` },
          })}\n`,
        );
        continue;
      }

      const response = await this.handleMessage(message);
      if (response !== null) {
        this.output.write(`${JSON.stringify(response)}\n`);
      }
    }
  }
}

async function createDemoMarketplaceServer() {
  const state = {
    requests: [],
    payments: new Map(),
    resultsByIdempotencyKey: new Map(),
  };

  const server = createServer(async (req, res) => {
    if (req.method !== "POST" || req.url !== DEFAULT_EXECUTE_PATH) {
      res.writeHead(404, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: "not_found" }));
      return;
    }

    const bodyChunks = [];
    for await (const chunk of req) {
      bodyChunks.push(chunk);
    }
    const rawBody = Buffer.concat(bodyChunks).toString("utf8");
    const body = rawBody ? JSON.parse(rawBody) : {};
    const headers = lowerCaseHeaders(req.headers);
    const idempotencyKey = headers["x-idempotency-key"] || headers["idempotency-key"] || null;
    const apiAuthorization = headers.authorization || null;
    const paymentSignature = headers["payment-signature"] || null;
    const paymentAuthorization =
      headers["x-payment-authorization"] ||
      (apiAuthorization?.startsWith("Bearer demo_paid_") ? apiAuthorization : null);
    const challengeId = `challenge_${sha256(`${idempotencyKey}:${body?.execute?.tool || "tool"}`).slice(0, 16)}`;

    state.requests.push({
      method: req.method,
      url: req.url,
      headers,
      body,
      idempotencyKey,
      apiAuthorization,
      paymentAuthorization,
      paymentSignature,
      challengeId,
    });

    if (!idempotencyKey) {
      res.writeHead(400, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: "missing_idempotency_key" }));
      return;
    }

    if (!paymentAuthorization && !paymentSignature) {
      res.writeHead(402, { "content-type": "application/json" });
      res.end(
        JSON.stringify({
          challenge_id: challengeId,
          asset: "USDC",
          amount: "0.01",
          seller: body?.seller || "demo-seller",
          capability_id: body?.capability_id || "nvidia/elements.execute",
        }),
      );
      return;
    }

    const expectedAuthorization = `Bearer demo_paid_${sha256(`${challengeId}:${idempotencyKey}`).slice(0, 24)}`;
    if (paymentAuthorization && paymentAuthorization !== expectedAuthorization) {
      res.writeHead(403, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: "invalid_payment_authorization", challenge_id: challengeId }));
      return;
    }

    let cached = state.resultsByIdempotencyKey.get(idempotencyKey);
    if (!cached) {
      cached = {
        invocation_id: `inv_${sha256(`invoke:${idempotencyKey}`).slice(0, 16)}`,
        capability_id: body.capability_id,
        trust: {
          mode: body.trust_mode,
          verified: true,
        },
        result: {
          tool: body?.execute?.tool,
          provider: body?.provider,
          seller: body?.seller,
          echoed_input: body?.execute?.input,
          asset_url: `https://demo.nvidia-elements.local/assets/${sha256(stableStringify(body?.execute?.input)).slice(0, 12)}.png`,
          summary: "Simulated NVIDIA Elements execution result",
        },
        usage_receipt: {
          id: `rcpt_${sha256(`receipt:${idempotencyKey}`).slice(0, 16)}`,
          challenge_id: challengeId,
          payment_response: `payment_response_${sha256(paymentAuthorization || paymentSignature).slice(0, 16)}`,
        },
      };
      state.resultsByIdempotencyKey.set(idempotencyKey, cached);
    }

    state.payments.set(idempotencyKey, {
      challengeId,
      paymentAuthorization,
      paymentSignature,
      receiptId: cached.usage_receipt.id,
    });

    res.writeHead(200, {
      "content-type": "application/json",
      "payment-receipt": cached.usage_receipt.id,
      "payment-response": cached.usage_receipt.payment_response,
    });
    res.end(JSON.stringify(cached));
  });

  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();

  return {
    state,
    close: () =>
      new Promise((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      }),
    baseUrl: `http://127.0.0.1:${address.port}`,
  };
}

async function runDemo() {
  const demoMarketplace = await createDemoMarketplaceServer();
  let payCalls = 0;

  try {
    const pay = async ({ challenge, idempotencyKey }) => {
      payCalls += 1;
      return {
        authorization: `Bearer demo_paid_${sha256(`${challenge.challenge_id}:${idempotencyKey}`).slice(0, 24)}`,
        paymentSignature: `sig_${sha256(`sig:${challenge.challenge_id}:${idempotencyKey}`).slice(0, 24)}`,
      };
    };

    const wrapper = await new NvidiaElementsExecuteWrapper({
      marketplaceBaseUrl: demoMarketplace.baseUrl,
      apiKey: "demo_api_key",
      capabilityId: "seller/demo/nvidia-elements.image.generate",
      defaultSeller: "demo-seller",
      pay,
    }).init();

    const server = new LocalMcpServer({ wrapper });

    const initializeResponse = await server.handleMessage({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {},
    });

    const listResponse = await server.handleMessage({
      jsonrpc: "2.0",
      id: 2,
      method: "tools/list",
      params: {},
    });

    const callResponse = await server.handleMessage({
      jsonrpc: "2.0",
      id: 3,
      method: "tools/call",
      params: {
        name: "nvidia_elements_execute",
        arguments: {
          tool: "image.generate",
          input: {
            prompt: "cinematic robot portrait, teal rim light",
            width: 1024,
            height: 1024,
          },
          trustMode: "trust-checked",
          traceId: "demo-trace-001",
        },
      },
    });
    const notificationResponse = await server.handleMessage({
      jsonrpc: "2.0",
      method: "notifications/initialized",
      params: {},
    });

    const structured = callResponse.result.structuredContent;
    const seenKeys = new Set(demoMarketplace.state.requests.map((request) => request.idempotencyKey));
    const paidRequest = demoMarketplace.state.requests.find((request) => request.paymentSignature);
    const expectedRequestDigest = sha256({
      method: "POST",
      path: wrapper.executePath,
      body: demoMarketplace.state.requests[0].body,
    });
    const unverifiedReceipt = wrapper.buildUsageReceipt({
      payload: { receipt_id: "rcpt_unverified" },
      response: new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { "x-payment-receipt": "rcpt_unverified" },
      }),
      idempotencyKey: "idem_unverified",
      x402Meta: {},
      requestDigest: "digest_unverified_request",
    });

    assert.equal(initializeResponse.result.serverInfo.name, "nvidia-elements-execute-wrapper");
    assert.equal(listResponse.result.tools[0].name, "nvidia_elements_execute");
    assert.equal(notificationResponse, null);
    assert.equal(structured.ok, true);
    assert.equal(payCalls, 1);
    assert.equal(demoMarketplace.state.requests.length, 2);
    assert.equal(demoMarketplace.state.requests.every((request) => request.url === "/api/x402/execute"), true);
    assert.equal(seenKeys.size, 1);
    assert.equal(
      demoMarketplace.state.requests[0].idempotencyKey,
      demoMarketplace.state.requests[1].idempotencyKey,
    );
    assert.equal(paidRequest.apiAuthorization, "Bearer demo_api_key");
    assert.equal(Boolean(paidRequest.paymentSignature), true);
    assert.equal(Boolean(paidRequest.paymentAuthorization), true);
    assert.equal(structured.receipt.id, structured.raw.usage_receipt.id);
    assert.equal(structured.receipt.challenge_id, structured.raw.usage_receipt.challenge_id);
    assert.equal(structured.receipt.digests.request, expectedRequestDigest);
    assert.equal(structured.output.tool, "image.generate");
    assert.equal(structured.output.provider, "nvidia-elements");
    assert.equal(structured.receipt.trust.mode, "trust-checked");
    assert.equal(unverifiedReceipt.trust.verified, null);
    assert.equal(unverifiedReceipt.headers.payment_receipt, "rcpt_unverified");

    process.stdout.write(`${JSON.stringify({
      demo: "ok",
      helper: structured.helper,
      initialize: initializeResponse.result,
      tools: listResponse.result.tools,
      execute: structured,
      requestCount: demoMarketplace.state.requests.length,
      payCalls,
    }, null, 2)}\n`);
  } finally {
    await demoMarketplace.close();
  }
}

async function main(argv = process.argv.slice(2)) {
  if (argv.includes("--serve")) {
    const wrapper = await new NvidiaElementsExecuteWrapper({
      marketplaceBaseUrl: process.env.AGORAGENTIC_BASE_URL || "https://agoragentic.example",
      capabilityId: process.env.AGORAGENTIC_CAPABILITY_ID || "seller/nvidia-elements.execute",
      defaultSeller: process.env.AGORAGENTIC_SELLER || "demo-seller",
      pay: async () => {
        throw new Error("No pay callback configured. Supply one when embedding this wrapper in a real host.");
      },
    }).init();

    const server = new LocalMcpServer({ wrapper });
    await server.serve();
    return;
  }

  await runDemo();
}

if (import.meta.url === new URL(`file://${process.argv[1]}`).toString()) {
  main().catch((error) => {
    process.stderr.write(`${error.stack || error.message}\n`);
    process.exitCode = 1;
  });
}
