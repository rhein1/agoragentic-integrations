#!/usr/bin/env node
/* demo — simulates payment authorization and usage receipts; moves no real funds */

import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';

const DEFAULT_BASE_URL = process.env.AGORAGENTIC_BASE_URL || 'https://agoragentic.example';
const DEFAULT_MATCH_PATH = '/api/x402/execute/match';
const DEFAULT_EXECUTE_PATH = '/api/x402/execute';
const DEFAULT_TOOL_NAME = 'agoragentic_execute';
const DEFAULT_MODEL = 'gpt-4.1-mini';

function clone(value) {
  return value === undefined ? undefined : JSON.parse(JSON.stringify(value));
}

function normalizeBaseUrl(value) {
  return String(value || DEFAULT_BASE_URL).replace(/\/+$/, '');
}

function stableStringify(value) {
  if (Array.isArray(value)) {
    return `[${value.map((item) => stableStringify(item)).join(',')}]`;
  }
  if (value && typeof value === 'object') {
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`)
      .join(',')}}`;
  }
  return JSON.stringify(value);
}

function sha256(value) {
  return createHash('sha256').update(typeof value === 'string' ? value : stableStringify(value)).digest('hex');
}

function lowerCaseHeaders(headers = {}) {
  if (headers instanceof Headers) {
    return Object.fromEntries(Array.from(headers.entries(), ([key, value]) => [String(key).toLowerCase(), String(value)]));
  }
  return Object.fromEntries(Object.entries(headers).map(([key, value]) => [String(key).toLowerCase(), String(value)]));
}

function mergeHeaders(...parts) {
  const merged = new Headers();
  for (const part of parts) {
    if (!part) continue;
    const entries = part instanceof Headers ? part.entries() : Object.entries(part);
    for (const [key, value] of entries) {
      if (value !== undefined && value !== null) {
        merged.set(String(key), String(value));
      }
    }
  }
  return merged;
}

function readHeader(headers, name) {
  if (!headers) return null;
  if (typeof headers.get === 'function') {
    return headers.get(name) ?? headers.get(String(name).toLowerCase()) ?? null;
  }
  return lowerCaseHeaders(headers)[String(name).toLowerCase()] ?? null;
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

function compactJson(value) {
  return JSON.stringify(value, null, 2);
}

function ensureObject(value, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new TypeError(`${label} must be an object`);
  }
  return value;
}

function normalizeArgs(args) {
  ensureObject(args, 'tool arguments');
  const task = String(args.task || '').trim();
  const mcpServer = String(args.mcp_server || args.server || '').trim();
  const toolName = String(args.tool_name || args.tool || '').trim();
  if (!task) throw new TypeError('task is required');
  if (!mcpServer) throw new TypeError('mcp_server is required');
  if (!toolName) throw new TypeError('tool_name is required');

  return {
    task,
    mcp_server: mcpServer,
    tool_name: toolName,
    tool_arguments: args.tool_arguments && typeof args.tool_arguments === 'object' && !Array.isArray(args.tool_arguments)
      ? clone(args.tool_arguments)
      : {},
    max_price_usdc: args.max_price_usdc ?? null,
    quote_id: args.quote_id ?? null,
    metadata: args.metadata && typeof args.metadata === 'object' && !Array.isArray(args.metadata)
      ? clone(args.metadata)
      : {},
  };
}

function buildDefaultInputSchema() {
  return {
    type: 'object',
    additionalProperties: false,
    required: ['task', 'mcp_server', 'tool_name'],
    properties: {
      task: {
        type: 'string',
        description: 'Natural-language task Agoragentic should execute against the marketplace listing.',
      },
      mcp_server: {
        type: 'string',
        description: 'Marketplace MCP server name to route to.',
      },
      tool_name: {
        type: 'string',
        description: 'MCP tool name exposed by the seller listing.',
      },
      tool_arguments: {
        type: 'object',
        additionalProperties: true,
        description: 'Arguments forwarded to the seller tool.',
      },
      max_price_usdc: {
        type: 'number',
        description: 'Optional buyer-side spend ceiling used during quote matching.',
      },
      quote_id: {
        type: 'string',
        description: 'Optional pre-fetched quote_id. When omitted, the wrapper requests one from execute/match.',
      },
      metadata: {
        type: 'object',
        additionalProperties: true,
        description: 'Caller metadata echoed into the execute request for governance or tracing.',
      },
    },
  };
}

async function resolveX402Fetch() {
  for (const specifier of ['agoragentic/x402-client', '../lib/x402-client.mjs', './lib/x402-client.mjs']) {
    try {
      const mod = await import(specifier);
      if (typeof mod.x402Fetch === 'function') {
        return { x402Fetch: mod.x402Fetch, source: specifier };
      }
    } catch {
      // keep searching so the example stays runnable outside the target repo
    }
  }
  return { x402Fetch: createInlineX402Fetch(), source: 'inline-demo-fallback' };
}

function createInlineX402Fetch() {
  return async function x402Fetch(url, options = {}) {
    const {
      fetchImpl = globalThis.fetch,
      pay,
      idempotencyKey,
      method = 'GET',
      headers = {},
      body,
      signal,
      maxNetworkRetries = 1,
    } = options;

    if (typeof fetchImpl !== 'function') {
      throw new TypeError('fetchImpl is required');
    }
    if (!idempotencyKey) {
      throw new TypeError('idempotencyKey is required');
    }

    const baseHeaders = lowerCaseHeaders(headers);
    let cachedPayment = null;
    let paymentChallenge = null;
    let networkRetriesUsed = 0;

    while (true) {
      const requestHeaders = {
        accept: 'application/json',
        'x-idempotency-key': idempotencyKey,
        ...baseHeaders,
      };
      if (cachedPayment?.authorization) {
        requestHeaders['x-payment-authorization'] = cachedPayment.authorization;
      }
      if (cachedPayment?.paymentSignature) {
        requestHeaders['x-payment-signature'] = cachedPayment.paymentSignature;
      }
      if (cachedPayment?.authorizationHeader) {
        requestHeaders.authorization = cachedPayment.authorizationHeader;
      }

      let requestBody = body;
      if (requestBody !== undefined && requestBody !== null && typeof requestBody !== 'string') {
        requestBody = JSON.stringify(requestBody);
        if (!requestHeaders['content-type']) {
          requestHeaders['content-type'] = 'application/json';
        }
      }

      try {
        const response = await fetchImpl(url, { method, headers: requestHeaders, body: requestBody, signal });
        if (response.status !== 402) {
          response.x402Meta = {
            idempotencyKey,
            paymentAuthorized: Boolean(cachedPayment),
            networkRetriesUsed,
            paymentChallenge,
          };
          return response;
        }

        if (typeof pay !== 'function') {
          const error = new Error('HTTP 402 requires a caller-supplied pay callback');
          error.status = 402;
          throw error;
        }

        if (!cachedPayment) {
          paymentChallenge = await safeJson(response);
          cachedPayment = await pay(paymentChallenge, {
            url: String(url),
            method,
            headers: clone(requestHeaders),
            body: requestBody,
            idempotencyKey,
          });
          if (!cachedPayment || typeof cachedPayment !== 'object') {
            throw new TypeError('pay callback must return an authorization object');
          }
          if (!cachedPayment.authorization && !cachedPayment.authorizationHeader) {
            throw new TypeError('pay callback must return authorization or authorizationHeader');
          }
        } else {
          const error = new Error('server repeated HTTP 402 after payment authorization was already prepared');
          error.status = 402;
          error.paymentChallenge = paymentChallenge;
          throw error;
        }
      } catch (error) {
        if (typeof error?.status === 'number') {
          throw error;
        }
        if (!cachedPayment) {
          throw error;
        }
        if (networkRetriesUsed >= maxNetworkRetries) {
          error.message = `network error after payment authorization reuse: ${error.message}`;
          error.idempotencyKey = idempotencyKey;
          throw error;
        }
        networkRetriesUsed += 1;
      }
    }
  };
}

export class AgoragenticExecuteError extends Error {
  constructor(message, details = {}) {
    super(message);
    this.name = 'AgoragenticExecuteError';
    this.code = details.code || 'AGORAGENTIC_EXECUTE_ERROR';
    this.kind = details.kind || 'execution_error';
    this.status = details.status ?? null;
    this.details = details.details ?? null;
    this.idempotencyKey = details.idempotencyKey ?? null;
    this.cause = details.cause;
  }
}

export class AgoragenticExecuteClient {
  constructor(options = {}) {
    this.baseUrl = normalizeBaseUrl(options.baseUrl || DEFAULT_BASE_URL);
    this.matchPath = options.matchPath || DEFAULT_MATCH_PATH;
    this.executePath = options.executePath || DEFAULT_EXECUTE_PATH;
    this.fetchImpl = options.fetchImpl || globalThis.fetch;
    this.apiKey = options.apiKey || null;
    this.pay = options.pay || null;
    this.idempotencyKeyFactory = options.idempotencyKeyFactory || (() => randomUUID());
    this.x402FetchPromise = options.x402Fetch
      ? Promise.resolve({ x402Fetch: options.x402Fetch, source: options.x402FetchSource || 'injected' })
      : resolveX402Fetch();

    if (typeof this.fetchImpl !== 'function') {
      throw new TypeError('fetch implementation is required (Node 18+ or pass fetchImpl)');
    }
  }

  buildAuthHeaders() {
    return this.apiKey ? { authorization: `Bearer ${this.apiKey}` } : {};
  }

  async matchQuote(input) {
    const query = {
      task: input.task,
      mcp_server: input.mcp_server,
      tool_name: input.tool_name,
    };
    if (input.max_price_usdc !== null && input.max_price_usdc !== undefined) {
      query.max_price_usdc = input.max_price_usdc;
    }

    const url = new URL(this.matchPath, this.baseUrl);
    for (const [key, value] of Object.entries(query)) {
      url.searchParams.set(key, String(value));
    }

    let response;
    try {
      response = await this.fetchImpl(url, {
        method: 'GET',
        headers: mergeHeaders({ accept: 'application/json' }, this.buildAuthHeaders()),
      });
    } catch (error) {
      throw new AgoragenticExecuteError(`quote match failed before HTTP response: ${error.message}`, {
        code: 'MATCH_NETWORK_ERROR',
        kind: 'network_error',
        cause: error,
      });
    }

    const payload = await safeJson(response);
    if (!response.ok) {
      throw new AgoragenticExecuteError(`quote match failed with HTTP ${response.status}`, {
        code: 'MATCH_HTTP_ERROR',
        kind: 'http_error',
        status: response.status,
        details: payload,
      });
    }
    if (!payload?.quote_id) {
      throw new AgoragenticExecuteError('quote match did not return quote_id', {
        code: 'MATCH_MISSING_QUOTE',
        kind: 'protocol_error',
        details: payload,
      });
    }
    return payload;
  }

  async execute(rawArgs, runtime = {}) {
    const args = normalizeArgs(rawArgs);
    const quote = args.quote_id ? { quote_id: args.quote_id } : await this.matchQuote(args);
    const idempotencyKey = runtime.idempotencyKey || this.idempotencyKeyFactory();
    const pay = runtime.pay || this.pay;
    if (typeof pay !== 'function') {
      throw new AgoragenticExecuteError('execute() requires a caller-supplied pay callback; this wrapper never auto-pays', {
        code: 'PAY_CALLBACK_REQUIRED',
        kind: 'payment_error',
        idempotencyKey,
      });
    }

    const executeRequest = {
      quote_id: quote.quote_id,
      input: {
        transport: 'mcp',
        server: args.mcp_server,
        tool: args.tool_name,
        arguments: args.tool_arguments,
      },
      task: args.task,
      metadata: args.metadata,
    };

    const { x402Fetch, source } = await this.x402FetchPromise;
    let response;
    try {
      response = await x402Fetch(new URL(this.executePath, this.baseUrl), {
        method: 'POST',
        fetchImpl: this.fetchImpl,
        pay,
        idempotencyKey,
        headers: mergeHeaders({ 'content-type': 'application/json', accept: 'application/json' }, this.buildAuthHeaders()),
        body: JSON.stringify(executeRequest),
      });
    } catch (error) {
      if (error instanceof AgoragenticExecuteError) {
        throw error;
      }
      throw new AgoragenticExecuteError(error.message || 'execute call failed', {
        code: typeof error?.status === 'number' ? 'EXECUTE_HTTP_ERROR' : 'EXECUTE_NETWORK_ERROR',
        kind: typeof error?.status === 'number' ? 'http_error' : 'network_error',
        status: error?.status ?? null,
        idempotencyKey,
        details: error?.paymentChallenge || null,
        cause: error,
      });
    }

    const payload = await safeJson(response);
    if (!response.ok) {
      throw new AgoragenticExecuteError(`execute failed with HTTP ${response.status}`, {
        code: 'EXECUTE_HTTP_ERROR',
        kind: 'http_error',
        status: response.status,
        idempotencyKey,
        details: payload,
      });
    }

    return normalizeExecutionResult({
      args,
      quote,
      payload,
      response,
      idempotencyKey,
      x402FetchSource: source,
    });
  }
}

export function normalizeExecutionResult({ args, quote, payload, response, idempotencyKey, x402FetchSource }) {
  const receipt = payload?.usage_receipt ?? payload?.receipt ?? null;
  const result = payload?.result ?? payload?.output ?? payload;
  const content = Array.isArray(result?.content) ? result.content : [];
  const text = content
    .filter((item) => item?.type === 'text' && typeof item.text === 'string')
    .map((item) => item.text.trim())
    .filter(Boolean)
    .join('\n\n') || null;

  return {
    ok: true,
    task: args.task,
    quote,
    result,
    text,
    usage_receipt: receipt,
    receipt_summary: buildReceiptSummary({ receipt, response, idempotencyKey, quote }),
    transport: {
      idempotency_key: idempotencyKey,
      x402_fetch_source: x402FetchSource,
      payment_response_header: readHeader(response.headers, 'payment-response'),
      payment_receipt_header: readHeader(response.headers, 'payment-receipt'),
      x402_meta: response.x402Meta || null,
    },
    raw: payload,
  };
}

function buildReceiptSummary({ receipt, response, idempotencyKey, quote }) {
  return {
    idempotency_key: idempotencyKey,
    quote_id: quote.quote_id,
    receipt_id: receipt?.receipt_id ?? receipt?.id ?? readHeader(response.headers, 'payment-receipt') ?? null,
    challenge_id: receipt?.payment?.challenge_id ?? receipt?.challenge_id ?? null,
    amount_usdc: receipt?.payment?.amount_usdc ?? receipt?.amount_usdc ?? null,
    status: receipt?.status ?? null,
    trust_checks_ok: Array.isArray(receipt?.trust_checks)
      ? receipt.trust_checks.every((entry) => entry?.ok !== false)
      : null,
    output_digest: receipt?.digests?.output_digest ?? null,
  };
}

export function createOpenAIAgentsExecuteTool(options = {}) {
  const client = options.client instanceof AgoragenticExecuteClient
    ? options.client
    : new AgoragenticExecuteClient(options);

  const definition = {
    type: 'function',
    name: options.name || DEFAULT_TOOL_NAME,
    description: options.description || 'Execute a governed Agoragentic marketplace tool call and return the result plus a usage receipt summary.',
    strict: true,
    parameters: options.parameters || buildDefaultInputSchema(),
    async execute(args, runtime = {}) {
      return client.execute(args, runtime);
    },
    async asOpenAIAgentsTool() {
      return adaptToolForOpenAIAgents(this);
    },
  };

  return definition;
}

export async function adaptToolForOpenAIAgents(toolDefinition) {
  for (const specifier of ['@openai/agents', 'openai/agents']) {
    try {
      const mod = await import(specifier);
      if (typeof mod.tool === 'function') {
        return mod.tool({
          name: toolDefinition.name,
          description: toolDefinition.description,
          parameters: toolDefinition.parameters,
          strict: toolDefinition.strict,
          execute: toolDefinition.execute,
        });
      }
      if (typeof mod.functionTool === 'function') {
        return mod.functionTool({
          name: toolDefinition.name,
          description: toolDefinition.description,
          parameters: toolDefinition.parameters,
          strict: toolDefinition.strict,
          execute: toolDefinition.execute,
        });
      }
    } catch {
      // return the plain object when the SDK is not installed in the runnable demo environment
    }
  }
  return toolDefinition;
}

export async function runDemo() {
  const tracker = { payCalls: 0, postAttempts: 0 };
  const demoFetch = createDemoMarketplaceFetch(tracker);
  const tool = createOpenAIAgentsExecuteTool({
    baseUrl: 'https://demo.agoragentic.local',
    fetchImpl: demoFetch,
    pay: async (challenge, context) => {
      tracker.payCalls += 1;
      return {
        authorization: `demo-auth::${challenge.challenge_id}::${context.idempotencyKey}`,
        paymentSignature: `sig::${sha256(challenge.challenge_id).slice(0, 16)}`,
      };
    },
    idempotencyKeyFactory: () => 'demo-idempotency-key-001',
  });

  const sdkCompatible = await tool.asOpenAIAgentsTool();
  const result = await sdkCompatible.execute({
    task: 'Summarize the seller output and include the usage receipt facts.',
    mcp_server: 'seller-weather',
    tool_name: 'forecast',
    tool_arguments: { city: 'Paris', units: 'metric' },
    max_price_usdc: 0.02,
    metadata: { demo: true, requested_by: 'self-test' },
  });

  assert.equal(result.ok, true);
  assert.equal(result.quote.quote_id, 'quote_demo_001');
  assert.equal(result.result.structuredContent.city, 'Paris');
  assert.equal(result.usage_receipt.status, 'simulated-settled');
  assert.equal(result.receipt_summary.receipt_id, 'rcpt_demo_001');
  assert.equal(result.transport.idempotency_key, 'demo-idempotency-key-001');
  assert.equal(tracker.payCalls, 1);
  assert.equal(tracker.postAttempts, 3);

  return {
    tool_name: tool.name,
    sdk_adapter_kind: sdkCompatible === tool ? 'plain-object-fallback' : 'sdk-tool',
    quote_id: result.quote.quote_id,
    result_text: result.text,
    receipt_summary: result.receipt_summary,
    transport: result.transport,
    pay_calls: tracker.payCalls,
    post_attempts: tracker.postAttempts,
  };
}

export function createDemoMarketplaceFetch(tracker = { payCalls: 0, postAttempts: 0 }) {
  const challengeByIdempotencyKey = new Map();
  const responseByIdempotencyKey = new Map();
  const networkFailureConsumed = new Set();

  return async function demoFetch(input, init = {}) {
    const url = new URL(String(input instanceof URL ? input : input?.url || input));
    const method = String(init.method || 'GET').toUpperCase();
    const headers = lowerCaseHeaders(init.headers || {});

    if (url.pathname === DEFAULT_MATCH_PATH && method === 'GET') {
      return jsonResponse(200, {
        quote_id: 'quote_demo_001',
        listing_id: 'listing_demo_weather',
        price_usdc: 0.01,
        mcp_server: 'seller-weather',
        tool_name: 'forecast',
      });
    }

    if (url.pathname === DEFAULT_EXECUTE_PATH && method === 'POST') {
      tracker.postAttempts += 1;
      const idempotencyKey = headers['x-idempotency-key'];
      const authorization = headers['x-payment-authorization'];
      const body = JSON.parse(String(init.body || '{}'));

      if (!idempotencyKey) {
        return jsonResponse(400, { error: 'missing_idempotency_key' });
      }

      if (!authorization) {
        const challenge = {
          challenge_id: `ch_${sha256(idempotencyKey).slice(0, 10)}`,
          amount_usdc: '0.01',
          asset: 'USDC',
          quote_id: body.quote_id,
        };
        challengeByIdempotencyKey.set(idempotencyKey, challenge);
        return jsonResponse(402, challenge);
      }

      const challenge = challengeByIdempotencyKey.get(idempotencyKey);
      const expectedAuthorization = `demo-auth::${challenge.challenge_id}::${idempotencyKey}`;
      if (authorization !== expectedAuthorization) {
        return jsonResponse(403, { error: 'invalid_payment_authorization' });
      }

      if (!networkFailureConsumed.has(idempotencyKey)) {
        networkFailureConsumed.add(idempotencyKey);
        throw new Error('simulated upstream socket reset after payment authorization');
      }

      if (!responseByIdempotencyKey.has(idempotencyKey)) {
        const output = {
          content: [
            {
              type: 'text',
              text: 'Forecast for Paris: 18C, light rain, carry an umbrella.',
            },
          ],
          structuredContent: {
            city: body?.input?.arguments?.city || 'unknown',
            units: body?.input?.arguments?.units || 'metric',
            forecast: 'light rain',
            temperature_c: 18,
          },
        };
        responseByIdempotencyKey.set(idempotencyKey, {
          invocation_id: 'inv_demo_001',
          result: output,
          usage_receipt: {
            receipt_id: 'rcpt_demo_001',
            status: 'simulated-settled',
            payment: {
              amount_usdc: '0.01',
              asset: 'USDC',
              challenge_id: challenge.challenge_id,
            },
            trust_checks: [
              { id: 'payment_gate_required', ok: true },
              { id: 'idempotency_key_forwarded', ok: true },
            ],
            digests: {
              output_digest: sha256(output),
            },
          },
        });
      }

      return jsonResponse(200, responseByIdempotencyKey.get(idempotencyKey), {
        'payment-response': JSON.stringify({ challenge_id: challenge.challenge_id, idempotency_key: idempotencyKey, status: 'authorized' }),
        'payment-receipt': 'rcpt_demo_001',
      });
    }

    return jsonResponse(404, { error: `unhandled route: ${method} ${url}` });
  };
}

function jsonResponse(status, payload, extraHeaders = {}) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: mergeHeaders({ 'content-type': 'application/json' }, extraHeaders),
  });
}

async function main() {
  const summary = await runDemo();
  console.log(compactJson(summary));
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.stack : String(error));
    process.exitCode = 1;
  });
}
