#!/usr/bin/env node
/* demo — moves no real funds */

import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { setTimeout as sleep } from 'node:timers/promises';

const DEFAULT_BASE_URL = 'https://agoragentic.com';
const DEFAULT_EXECUTE_ATTEMPTS = 3;
const DEFAULT_RECEIPT_POLL_ATTEMPTS = 4;
const DEFAULT_RECEIPT_POLL_INTERVAL_MS = 50;

export class X402AdapterError extends Error {
  constructor(message, details = {}) {
    super(message, details.cause ? { cause: details.cause } : undefined);
    this.name = 'X402AdapterError';
    this.code = details.code || 'X402_ADAPTER_ERROR';
    this.kind = details.kind || 'adapter_error';
    this.status = details.status ?? null;
    this.retryable = Boolean(details.retryable);
    this.attempts = details.attempts ?? 0;
    this.idempotencyKey = details.idempotencyKey || null;
    this.details = details.details ?? null;
  }

  toJSON() {
    return {
      name: this.name,
      code: this.code,
      kind: this.kind,
      status: this.status,
      retryable: this.retryable,
      attempts: this.attempts,
      idempotencyKey: this.idempotencyKey,
      message: this.message,
      details: this.details,
    };
  }
}

export class X402ExecuteReceiptValidationAdapter {
  constructor(options = {}) {
    this.baseUrl = normalizeBaseUrl(options.baseUrl || process.env.AGORAGENTIC_BASE_URL || DEFAULT_BASE_URL);
    this.fetchImpl = options.fetchImpl || globalThis.fetch;
    this.apiKey = options.apiKey || process.env.AGORAGENTIC_API_KEY || null;
    this.pay = options.pay || null;
    this.maxExecuteAttempts = positiveInt(options.maxExecuteAttempts, DEFAULT_EXECUTE_ATTEMPTS);
    this.receiptPollAttempts = positiveInt(options.receiptPollAttempts, DEFAULT_RECEIPT_POLL_ATTEMPTS);
    this.receiptPollIntervalMs = nonNegativeInt(options.receiptPollIntervalMs, DEFAULT_RECEIPT_POLL_INTERVAL_MS);
    this.x402FetchPromise = options.x402Fetch
      ? Promise.resolve(options.x402Fetch)
      : resolveX402Fetch();

    if (typeof this.fetchImpl !== 'function') {
      throw new TypeError('fetch implementation is required (Node 18+ or pass fetchImpl)');
    }
  }

  async execute(request, options = {}) {
    const quoteId = request?.quoteId || request?.quote_id;
    const input = request?.input;

    if (!quoteId || !String(quoteId).trim()) {
      throw new TypeError('quoteId is required');
    }
    if (!input || typeof input !== 'object') {
      throw new TypeError('input is required');
    }

    const idempotencyKey = options.idempotencyKey || request.idempotencyKey || randomUUID();
    const validateReceipt = options.validateReceipt ?? request.validateReceipt ?? true;
    const payGate = options.pay || request.pay || this.pay;
    const memoizedPay = createMemoizedPay(payGate);
    const x402Fetch = await this.x402FetchPromise;
    const body = { quote_id: quoteId, input };

    let lastError = null;

    for (let attempt = 1; attempt <= this.maxExecuteAttempts; attempt += 1) {
      try {
        const settled = await x402Fetch(new URL('/api/x402/execute', this.baseUrl), {
          method: 'POST',
          headers: this.buildJsonHeaders(),
          body: JSON.stringify(body),
          fetchImpl: this.fetchImpl,
          pay: memoizedPay,
          idempotencyKey,
        });

        const normalized = await normalizeX402FetchResult(settled);
        if (!normalized.ok) {
          throw new X402AdapterError(`execute failed with HTTP ${normalized.status}`, {
            code: 'EXECUTE_HTTP_ERROR',
            kind: 'http_error',
            status: normalized.status,
            retryable: isRetryableHttpStatus(normalized.status),
            attempts: attempt,
            idempotencyKey,
            details: normalized.body,
          });
        }

        const evidence = extractExecutionEvidence(normalized);
        const validation = validateReceipt
          ? await this.validateReceipt({
              receiptId: evidence.receiptId,
              invocationId: evidence.invocationId,
              quoteId,
              idempotencyKey,
            })
          : null;

        return {
          ok: true,
          idempotencyKey,
          attempts: attempt,
          quoteId,
          paymentAuthorized: memoizedPay.authorization != null,
          paymentAuthorization: sanitizePaymentAuthorization(memoizedPay.authorization),
          execute: {
            status: normalized.status,
            headers: normalized.headers,
            body: normalized.body,
            receiptId: evidence.receiptId,
            invocationId: evidence.invocationId,
            paymentReceiptHeader: evidence.paymentReceiptHeader,
            paymentResponseHeader: evidence.paymentResponseHeader,
          },
          validation,
        };
      } catch (error) {
        const mapped = mapExecuteError(error, { attempt, idempotencyKey });
        lastError = mapped;
        if (!mapped.retryable || attempt >= this.maxExecuteAttempts) {
          throw mapped;
        }
      }
    }

    throw lastError || new X402AdapterError('execute failed without an error', {
      code: 'EXECUTE_UNKNOWN_FAILURE',
      kind: 'unexpected_error',
      idempotencyKey,
    });
  }

  async validateReceipt({ receiptId, invocationId, quoteId, idempotencyKey }) {
    if (!receiptId && !invocationId) {
      throw new X402AdapterError('execute response did not include a receipt_id or invocation_id', {
        code: 'RECEIPT_REFERENCE_MISSING',
        kind: 'receipt_error',
        idempotencyKey,
        details: { quoteId },
      });
    }

    let lastReceipt = null;
    let lastProof = null;

    for (let poll = 1; poll <= this.receiptPollAttempts; poll += 1) {
      if (receiptId) {
        lastReceipt = await this.fetchReceipt(receiptId, idempotencyKey);
        const receiptStatus = normalizeReceiptStatus(
          lastReceipt?.status || lastReceipt?.settlement || lastReceipt?.payment?.settlement_status
        );

        if (quoteId && lastReceipt?.quote_id && lastReceipt.quote_id !== quoteId) {
          throw new X402AdapterError(`receipt ${receiptId} does not match quote ${quoteId}`, {
            code: 'RECEIPT_QUOTE_MISMATCH',
            kind: 'receipt_error',
            idempotencyKey,
            details: { receiptId, receiptQuoteId: lastReceipt.quote_id, quoteId, receipt: lastReceipt },
          });
        }

        if (isRejectedReceiptStatus(receiptStatus)) {
          throw new X402AdapterError(`receipt ${receiptId} ended in terminal failure state ${receiptStatus}`, {
            code: 'RECEIPT_REJECTED',
            kind: 'receipt_error',
            idempotencyKey,
            details: { receiptId, receipt: lastReceipt, status: receiptStatus },
          });
        }

        if (isSettledReceiptStatus(receiptStatus)) {
          return {
            ok: true,
            source: 'receipt',
            terminal: true,
            status: receiptStatus,
            receipt: lastReceipt,
            proof: lastProof,
            polls: poll,
          };
        }
      }

      if (invocationId) {
        lastProof = await this.fetchProof(invocationId, idempotencyKey);
        const proofStatus = normalizeProofStatus(lastProof?.on_chain?.status || lastProof?.status);

        if (isRejectedProofStatus(proofStatus)) {
          throw new X402AdapterError(`proof ${invocationId} ended in terminal failure state ${proofStatus}`, {
            code: 'PROOF_REJECTED',
            kind: 'receipt_error',
            idempotencyKey,
            details: { invocationId, proof: lastProof, status: proofStatus },
          });
        }

        if (isSettledProofStatus(proofStatus)) {
          return {
            ok: true,
            source: 'proof',
            terminal: true,
            status: proofStatus,
            receipt: lastReceipt,
            proof: lastProof,
            polls: poll,
          };
        }
      }

      if (poll < this.receiptPollAttempts) {
        await sleep(this.receiptPollIntervalMs);
      }
    }

    return {
      ok: false,
      source: receiptId ? 'receipt' : 'proof',
      terminal: false,
      status: normalizeReceiptStatus(
        lastReceipt?.status || lastReceipt?.settlement || lastReceipt?.payment?.settlement_status
      ) || normalizeProofStatus(lastProof?.on_chain?.status || lastProof?.status) || 'pending',
      receipt: lastReceipt,
      proof: lastProof,
      polls: this.receiptPollAttempts,
    };
  }

  async fetchReceipt(receiptId, idempotencyKey) {
    const response = await this.fetchImpl(new URL(`/api/x402/receipts/${encodeURIComponent(receiptId)}`, this.baseUrl), {
      method: 'GET',
      headers: this.buildHeaders(),
    });
    const payload = await safeJson(response);

    if (response.status === 404) {
      return null;
    }
    if (!response.ok) {
      throw new X402AdapterError(`receipt lookup failed with HTTP ${response.status}`, {
        code: 'RECEIPT_LOOKUP_HTTP_ERROR',
        kind: 'http_error',
        status: response.status,
        retryable: isRetryableHttpStatus(response.status),
        idempotencyKey,
        details: { receiptId, payload },
      });
    }
    return payload;
  }

  async fetchProof(invocationId, idempotencyKey) {
    const response = await this.fetchImpl(
      new URL(`/api/x402/execute/proof/${encodeURIComponent(invocationId)}`, this.baseUrl),
      {
        method: 'GET',
        headers: this.buildHeaders(),
      }
    );
    const payload = await safeJson(response);

    if (response.status === 404) {
      return null;
    }
    if (!response.ok) {
      throw new X402AdapterError(`proof lookup failed with HTTP ${response.status}`, {
        code: 'PROOF_LOOKUP_HTTP_ERROR',
        kind: 'http_error',
        status: response.status,
        retryable: isRetryableHttpStatus(response.status),
        idempotencyKey,
        details: { invocationId, payload },
      });
    }
    return payload;
  }

  buildHeaders() {
    const headers = { accept: 'application/json' };
    if (this.apiKey) headers.authorization = `Bearer ${this.apiKey}`;
    return headers;
  }

  buildJsonHeaders() {
    return {
      ...this.buildHeaders(),
      'content-type': 'application/json',
    };
  }
}

async function resolveX402Fetch() {
  for (const candidate of ['agoragentic/x402-client', '../lib/x402-client.mjs']) {
    try {
      const mod = await import(candidate);
      if (typeof mod.x402Fetch === 'function') {
        return mod.x402Fetch;
      }
    } catch {
      // try next candidate
    }
  }
  return createFallbackX402Fetch();
}

function createFallbackX402Fetch() {
  return async function x402Fetch(url, options = {}) {
    const {
      fetchImpl = globalThis.fetch,
      pay,
      idempotencyKey,
      method = 'GET',
      headers = {},
      body,
      ...rest
    } = options;

    if (typeof fetchImpl !== 'function') {
      throw new TypeError('fetch implementation is required');
    }
    if (!idempotencyKey) {
      throw new TypeError('idempotencyKey is required');
    }

    const baseHeaders = mergeHeaders(headers, { 'x-idempotency-key': idempotencyKey });

    let first;
    try {
      first = await fetchImpl(url, { ...rest, method, headers: baseHeaders, body });
    } catch (cause) {
      throw new X402AdapterError(`execute request failed before payment: ${cause?.message || cause}`, {
        code: 'EXECUTE_NETWORK_ERROR',
        kind: 'network_error',
        retryable: true,
        attempts: 1,
        idempotencyKey,
        cause,
      });
    }

    if (first.status !== 402) {
      return finalizeFallbackResult(first, null, 1, idempotencyKey);
    }

    const paymentRequired = getHeader(first.headers, 'payment-required');
    if (!paymentRequired) {
      throw new X402AdapterError('HTTP 402 response missing payment-required header', {
        code: 'PAYMENT_REQUIRED_HEADER_MISSING',
        kind: 'payment_error',
        status: 402,
        retryable: false,
        attempts: 1,
        idempotencyKey,
      });
    }
    if (typeof pay !== 'function') {
      throw new X402AdapterError('pay callback is required after HTTP 402', {
        code: 'PAY_CALLBACK_REQUIRED',
        kind: 'payment_error',
        status: 402,
        retryable: false,
        attempts: 1,
        idempotencyKey,
      });
    }

    const authorization = await pay(paymentRequired, {
      url: String(url),
      method,
      headers: Object.fromEntries(baseHeaders.entries()),
      body,
      idempotencyKey,
      attemptNumber: 1,
    });
    const paidHeaders = mergeHeaders(baseHeaders, buildPaymentHeaders(authorization));

    let second;
    try {
      second = await fetchImpl(url, { ...rest, method, headers: paidHeaders, body });
    } catch (cause) {
      throw new X402AdapterError(`execute retry failed after payment authorization reuse: ${cause?.message || cause}`, {
        code: 'EXECUTE_NETWORK_ERROR',
        kind: 'network_error',
        retryable: true,
        attempts: 2,
        idempotencyKey,
        cause,
        details: { paymentAuthorized: true },
      });
    }

    return finalizeFallbackResult(second, authorization, 2, idempotencyKey);
  };
}

async function finalizeFallbackResult(response, paymentAuthorization, attempts, idempotencyKey) {
  const body = await safeJson(response);
  return {
    ok: response.ok,
    status: response.status,
    headers: headersToObject(response.headers),
    body,
    response,
    responseBody: body,
    attempts,
    idempotencyKey,
    paymentAuthorization,
  };
}

async function normalizeX402FetchResult(result) {
  if (result instanceof Response) {
    return {
      ok: result.ok,
      status: result.status,
      headers: headersToObject(result.headers),
      body: await safeJson(result),
      attempts: 1,
      paymentAuthorization: null,
    };
  }

  if (result && typeof result === 'object') {
    const response = result.response instanceof Response ? result.response : null;
    const body = result.responseBody ?? result.body ?? (response ? await safeJson(response) : result);
    const status = result.status ?? response?.status ?? (typeof body?.status === 'number' ? body.status : null);
    const ok = result.ok ?? response?.ok ?? (typeof status === 'number' ? status >= 200 && status < 300 : true);
    const headers = result.headers
      ? normalizeHeadersObject(result.headers)
      : response
        ? headersToObject(response.headers)
        : {};

    return {
      ok,
      status,
      headers,
      body,
      attempts: result.attempts ?? 1,
      paymentAuthorization: result.paymentAuthorization ?? null,
    };
  }

  return {
    ok: true,
    status: 200,
    headers: {},
    body: result,
    attempts: 1,
    paymentAuthorization: null,
  };
}

function extractExecutionEvidence(normalized) {
  const body = normalized.body || {};
  const response = body.response || body;
  const receiptId =
    response.receipt_id ||
    response.receiptId ||
    response.payment_receipt_id ||
    response.receipt?.receipt_id ||
    tryParseJsonHeader(normalized.headers['payment-receipt'])?.receipt_id ||
    null;

  const invocationId =
    response.invocation_id ||
    response.invocationId ||
    response.proof_id ||
    response.execution_id ||
    response.meta?.invocation_id ||
    null;

  return {
    receiptId,
    invocationId,
    paymentReceiptHeader: normalized.headers['payment-receipt'] || null,
    paymentResponseHeader: normalized.headers['payment-response'] || null,
  };
}

function mapExecuteError(error, context = {}) {
  if (error instanceof X402AdapterError) {
    if (!error.idempotencyKey && context.idempotencyKey) {
      error.idempotencyKey = context.idempotencyKey;
    }
    if (!error.attempts && context.attempt) {
      error.attempts = context.attempt;
    }
    return error;
  }

  const message = String(error?.message || error || 'unknown execute error');
  return new X402AdapterError(message, {
    code: 'UNEXPECTED_EXECUTE_ERROR',
    kind: /fetch|network|socket|timeout|econnreset|temporar/i.test(message) ? 'network_error' : 'unexpected_error',
    retryable: /fetch|network|socket|timeout|econnreset|temporar/i.test(message),
    attempts: context.attempt || 0,
    idempotencyKey: context.idempotencyKey || null,
    cause: error,
  });
}

function createMemoizedPay(pay) {
  const state = {
    authorization: null,
    calls: 0,
  };

  const memoized = async (paymentRequired, context) => {
    if (state.authorization) {
      return state.authorization;
    }
    if (typeof pay !== 'function') {
      throw new X402AdapterError('pay callback is required after HTTP 402', {
        code: 'PAY_CALLBACK_REQUIRED',
        kind: 'payment_error',
        status: 402,
        retryable: false,
        idempotencyKey: context?.idempotencyKey || null,
      });
    }
    const authorization = await pay(paymentRequired, context);
    if (!authorization || typeof authorization !== 'object') {
      throw new X402AdapterError('pay callback must return an authorization object', {
        code: 'PAY_CALLBACK_INVALID',
        kind: 'payment_error',
        retryable: false,
        idempotencyKey: context?.idempotencyKey || null,
      });
    }
    state.authorization = authorization;
    state.calls += 1;
    return authorization;
  };

  Object.defineProperties(memoized, {
    authorization: { get: () => state.authorization },
    calls: { get: () => state.calls },
  });

  return memoized;
}

function buildPaymentHeaders(authorization) {
  if (!authorization || typeof authorization !== 'object') {
    throw new TypeError('authorization object is required');
  }
  const headers = {};
  if (authorization.authorizationHeader) headers.authorization = authorization.authorizationHeader;
  if (authorization.paymentSignature) headers['x-payment-signature'] = authorization.paymentSignature;
  if (authorization.paymentId) headers['x-payment-id'] = authorization.paymentId;
  if (authorization.payer) headers['x-payment-payer'] = authorization.payer;
  if (authorization.chain) headers['x-payment-chain'] = authorization.chain;
  if (authorization.receipt) headers['x-payment-authorization'] = JSON.stringify(authorization.receipt);
  return headers;
}

function sanitizePaymentAuthorization(value) {
  if (!value) return null;
  return {
    paymentId: value.paymentId || null,
    payer: value.payer || null,
    chain: value.chain || null,
    receipt: value.receipt || null,
  };
}

function normalizeBaseUrl(value) {
  return String(value || DEFAULT_BASE_URL).replace(/\/$/, '');
}

function normalizeReceiptStatus(value) {
  return value == null ? null : String(value).trim().toLowerCase();
}

function normalizeProofStatus(value) {
  return value == null ? null : String(value).trim().toLowerCase();
}

function isSettledReceiptStatus(status) {
  return ['settled', 'confirmed', 'finalized', 'paid', 'complete', 'completed', 'succeeded', 'success'].includes(status);
}

function isRejectedReceiptStatus(status) {
  return ['failed', 'rejected', 'expired', 'cancelled', 'canceled', 'void', 'refunded'].includes(status);
}

function isSettledProofStatus(status) {
  return ['confirmed', 'finalized', 'settled', 'success', 'succeeded'].includes(status);
}

function isRejectedProofStatus(status) {
  return ['failed', 'rejected', 'dropped', 'reverted', 'expired'].includes(status);
}

function isRetryableHttpStatus(status) {
  return status === 408 || status === 409 || status === 425 || status === 429 || (status >= 500 && status <= 599);
}

async function safeJson(response) {
  if (!(response instanceof Response)) return response;
  const text = await response.text();
  if (!text) return {};
  try {
    return JSON.parse(text);
  } catch {
    return { raw: text };
  }
}

function headersToObject(headers) {
  const out = {};
  if (!headers) return out;
  for (const [key, value] of headers.entries()) {
    out[String(key).toLowerCase()] = String(value);
  }
  return out;
}

function normalizeHeadersObject(headers) {
  if (headers instanceof Headers) return headersToObject(headers);
  const out = {};
  for (const [key, value] of Object.entries(headers || {})) {
    out[String(key).toLowerCase()] = String(value);
  }
  return out;
}

function getHeader(headers, name) {
  if (!headers) return null;
  if (headers instanceof Headers) return headers.get(name);
  for (const [key, value] of Object.entries(headers)) {
    if (String(key).toLowerCase() === String(name).toLowerCase()) {
      return String(value);
    }
  }
  return null;
}

function mergeHeaders(...parts) {
  const headers = new Headers();
  for (const part of parts) {
    if (!part) continue;
    const entries = part instanceof Headers ? part.entries() : Object.entries(part);
    for (const [key, value] of entries) {
      if (value !== undefined && value !== null) {
        headers.set(String(key), String(value));
      }
    }
  }
  return headers;
}

function tryParseJsonHeader(value) {
  if (!value || typeof value !== 'string') return null;
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}

function positiveInt(value, fallback) {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function nonNegativeInt(value, fallback) {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed >= 0 ? parsed : fallback;
}

function jsonResponse(status, payload, headers = {}) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: mergeHeaders({ 'content-type': 'application/json' }, headers),
  });
}

export function createMockFetch() {
  const state = {
    executeCalls: 0,
    payCallsSeenAtServer: 0,
    receiptPolls: 0,
    proofPolls: 0,
    idempotencyKeys: [],
  };

  const receiptId = 'rcpt_demo_001';
  const invocationId = 'invoke_demo_001';
  const expectedQuoteId = 'quote_demo_001';

  const fetchImpl = async (input, init = {}) => {
    const url = String(input instanceof URL ? input : input?.url || input);
    const method = String(init.method || 'GET').toUpperCase();
    const headers = normalizeHeadersObject(init.headers || {});
    const idempotencyKey = headers['x-idempotency-key'] || null;
    if (idempotencyKey) {
      state.idempotencyKeys.push(idempotencyKey);
    }

    if (url.endsWith('/api/x402/execute') && method === 'POST') {
      state.executeCalls += 1;
      const hasPayment =
        Boolean(headers.authorization?.startsWith('DemoPaid ')) ||
        Boolean(headers['x-payment-authorization']);

      if (!hasPayment) {
        return jsonResponse(
          402,
          { error: 'payment required' },
          { 'payment-required': 'demo-x402-challenge:1' }
        );
      }

      state.payCallsSeenAtServer += 1;

      if (state.executeCalls === 2) {
        return jsonResponse(502, { error: 'temporary upstream failure' }, { 'payment-response': 'retryable' });
      }

      const body = JSON.parse(String(init.body || '{}'));
      if (body.quote_id !== expectedQuoteId) {
        return jsonResponse(422, { error: 'quote mismatch', expectedQuoteId, receivedQuoteId: body.quote_id });
      }

      return jsonResponse(
        200,
        {
          ok: true,
          quote_id: body.quote_id,
          invocation_id: invocationId,
          result: {
            tool: body.input?.tool || body.input?.tool_name || 'demo-tool',
            output: 'demo execution complete',
          },
        },
        {
          'payment-response': 'accepted',
          'payment-receipt': JSON.stringify({ receipt_id: receiptId }),
        }
      );
    }

    if (url.endsWith(`/api/x402/receipts/${receiptId}`) && method === 'GET') {
      state.receiptPolls += 1;
      if (state.receiptPolls < 2) {
        return jsonResponse(200, {
          receipt_id: receiptId,
          quote_id: expectedQuoteId,
          status: 'pending',
          amount_usdc: '0.01',
        });
      }
      return jsonResponse(200, {
        receipt_id: receiptId,
        quote_id: expectedQuoteId,
        status: 'settled',
        amount_usdc: '0.01',
      });
    }

    if (url.endsWith(`/api/x402/execute/proof/${invocationId}`) && method === 'GET') {
      state.proofPolls += 1;
      return jsonResponse(200, {
        invocation_id: invocationId,
        on_chain: { status: 'confirmed' },
      });
    }

    return jsonResponse(404, { error: `unhandled route ${method} ${url}` });
  };

  fetchImpl.state = state;
  return fetchImpl;
}

export async function demo() {
  const fetchImpl = createMockFetch();
  let payCalls = 0;

  const adapter = new X402ExecuteReceiptValidationAdapter({
    baseUrl: 'https://demo.agoragentic.local',
    apiKey: 'demo-api-key',
    fetchImpl,
    maxExecuteAttempts: 3,
    receiptPollAttempts: 3,
    receiptPollIntervalMs: 1,
    pay: async (paymentRequired, context) => {
      payCalls += 1;
      return {
        authorizationHeader: `DemoPaid ${paymentRequired}`,
        paymentId: context.idempotencyKey,
        paymentSignature: 'demo-signature',
        payer: 'demo-payer',
        chain: 'demo-chain',
        receipt: { demo: true, challenge: paymentRequired },
      };
    },
  });

  const result = await adapter.execute({
    quoteId: 'quote_demo_001',
    input: {
      transport: 'mcp',
      server: 'demo-server',
      tool: 'demo-tool',
      arguments: { query: 'hello world' },
    },
  });

  assert.equal(result.ok, true);
  assert.equal(payCalls, 1, 'payment authorization should happen once');
  assert.equal(fetchImpl.state.payCallsSeenAtServer, 2, 'same authorization should be reused on execute retry');
  assert.ok(result.idempotencyKey);
  assert.ok(fetchImpl.state.idempotencyKeys.every((key) => key === result.idempotencyKey), 'idempotency key should be reused');
  assert.equal(result.execute.receiptId, 'rcpt_demo_001');
  assert.equal(result.execute.invocationId, 'invoke_demo_001');
  assert.equal(result.validation.ok, true);
  assert.equal(result.validation.status, 'settled');

  return {
    ok: result.ok,
    payCalls,
    executeCalls: fetchImpl.state.executeCalls,
    idempotencyKey: result.idempotencyKey,
    receiptId: result.execute.receiptId,
    validationSource: result.validation.source,
    validationStatus: result.validation.status,
  };
}

async function main() {
  const summary = await demo();
  console.log(JSON.stringify(summary, null, 2));
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((error) => {
    const printable = error instanceof X402AdapterError ? error.toJSON() : { message: String(error) };
    console.error(JSON.stringify(printable, null, 2));
    process.exitCode = 1;
  });
}
