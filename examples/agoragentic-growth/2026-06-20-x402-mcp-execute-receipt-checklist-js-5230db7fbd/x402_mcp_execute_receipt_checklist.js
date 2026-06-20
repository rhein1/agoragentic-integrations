#!/usr/bin/env node
'use strict';

// demo — moves no real funds

const DEFAULT_BASE_URL = 'https://agoragentic.com';
const DEFAULT_MAX_ATTEMPTS = 3;
const DEFAULT_RECEIPT_POLL_ATTEMPTS = 4;
const DEFAULT_RECEIPT_POLL_INTERVAL_MS = 25;

class FinalFlowError extends Error {
  constructor(message, state) {
    super(message);
    this.name = 'FinalFlowError';
    this.state = state ? cloneJson(state) : null;
  }
}

class MemoryReceiptStore {
  constructor() {
    this.states = new Map();
  }

  async load(sessionId) {
    return this.states.has(sessionId) ? cloneJson(this.states.get(sessionId)) : null;
  }

  async save(state) {
    this.states.set(state.session_id, cloneJson(state));
  }
}

class X402McpExecuteReceiptChecklist {
  constructor(options = {}) {
    const globalFetch = options.fetchImpl || globalThis.fetch;
    if (typeof globalFetch !== 'function') {
      throw new Error('fetch implementation is required (Node 18+ or pass fetchImpl)');
    }
    if (typeof options.payChallenge !== 'function') {
      throw new Error('payChallenge callback is required');
    }

    this.baseUrl = normalizeBaseUrl(options.baseUrl || DEFAULT_BASE_URL);
    this.fetchImpl = globalFetch;
    this.payChallenge = options.payChallenge;
    this.apiKey = options.apiKey || null;
    this.receiptStore = options.receiptStore || new MemoryReceiptStore();
    this.maxAttempts = positiveInt(options.maxAttempts, DEFAULT_MAX_ATTEMPTS);
    this.receiptPollAttempts = positiveInt(options.receiptPollAttempts, DEFAULT_RECEIPT_POLL_ATTEMPTS);
    this.receiptPollIntervalMs = nonNegativeInt(options.receiptPollIntervalMs, DEFAULT_RECEIPT_POLL_INTERVAL_MS);
    this.shouldRetry = options.shouldRetry || defaultRetryDecision;
  }

  async previewToolCall(request) {
    const query = {
      task: request.task || `${request.server}/${request.tool}`,
      mcp_server: request.server,
      tool_name: request.tool,
      max_price_usdc: request.maxPriceUsdc,
      buyer: request.buyer,
    };

    const response = await this.fetchImpl(
      `${this.baseUrl}/api/x402/execute/match${buildQuery(query)}`,
      { headers: this.buildCommonHeaders() }
    );

    const payload = await safeJson(response);
    if (!response.ok) {
      throw new Error(`preview failed with HTTP ${response.status}: ${payload.error || response.statusText}`);
    }
    return payload;
  }

  async executeToolCall(input) {
    assertRequiredString(input?.server, 'server');
    assertRequiredString(input?.tool, 'tool');
    assertRequiredString(input?.quoteId, 'quoteId');

    const existing = input.sessionId ? await this.receiptStore.load(input.sessionId) : null;
    const state = existing || createState(input);
    const body = {
      quote_id: state.quote_id,
      input: {
        transport: 'mcp',
        server: input.server,
        tool: input.tool,
        arguments: input.arguments || {},
      },
    };

    while (state.attempt_count < this.maxAttempts) {
      state.attempt_count += 1;
      appendTimeline(state, 'initial_request', `attempt ${state.attempt_count} started`);
      await this.receiptStore.save(state);

      try {
        const initial = await this.fetchImpl(`${this.baseUrl}/api/x402/execute`, {
          method: 'POST',
          headers: this.buildExecuteHeaders(state.idempotency_key),
          body: JSON.stringify(body),
        });

        if (initial.status !== 402) {
          const directPayload = await safeJson(initial);
          mergeResponseEvidence(state, directPayload, initial);
          appendTimeline(state, initial.ok ? 'succeeded' : 'failed', `initial response ${initial.status}`);
          await this.receiptStore.save(state);

          if (!initial.ok) {
            throw new FinalFlowError(`initial request failed with HTTP ${initial.status}`, state);
          }

          return this.buildResult(state, directPayload);
        }

        state.payment_required_header = getHeader(initial.headers, 'payment-required');
        if (!state.payment_required_header) {
          throw new Error('missing payment-required header on HTTP 402 response');
        }

        appendTimeline(state, 'payment_required', `402 received on attempt ${state.attempt_count}`);
        await this.receiptStore.save(state);

        if (!state.payment_authorization) {
          appendTimeline(state, 'authorizing_payment', `calling payChallenge on attempt ${state.attempt_count}`);
          const authorization = await this.payChallenge(state.payment_required_header, {
            url: `${this.baseUrl}/api/x402/execute`,
            method: 'POST',
            body,
            sessionId: state.session_id,
            idempotencyKey: state.idempotency_key,
            attempt: state.attempt_count,
          });
          validateAuthorization(authorization);
          state.payment_authorization = {
            authorizationHeader: authorization.authorizationHeader || null,
            paymentSignature: authorization.paymentSignature || null,
            paymentId: authorization.paymentId || null,
          };
          state.wallet_receipt = authorization.receipt || null;
          appendTimeline(state, 'authorized_payment', 'stored reusable payment authorization from 402 challenge');
          await this.receiptStore.save(state);
        } else {
          appendTimeline(state, 'reusing_payment', 'reusing prior payment authorization after non-402 retry');
          await this.receiptStore.save(state);
        }

        appendTimeline(state, 'retrying_paid_request', `retrying paid request for attempt ${state.attempt_count}`);
        const settled = await this.fetchImpl(`${this.baseUrl}/api/x402/execute`, {
          method: 'POST',
          headers: this.buildPaidHeaders(state.payment_authorization, state.idempotency_key),
          body: JSON.stringify(body),
        });

        const payload = await safeJson(settled);
        mergeResponseEvidence(state, payload, settled);
        await this.tryReconcile(state);

        if (settled.ok) {
          appendTimeline(state, state.receipt_snapshot || state.proof_snapshot ? 'reconciled' : 'succeeded', `paid response ${settled.status}`);
          await this.receiptStore.save(state);
          return this.buildResult(state, payload);
        }

        const decision = this.shouldRetry({ response: settled, state: cloneJson(state) });
        if (!decision.retry || state.attempt_count >= this.maxAttempts) {
          state.last_error = `paid execution failed with HTTP ${settled.status}`;
          appendTimeline(state, 'failed', state.last_error);
          await this.receiptStore.save(state);
          throw new FinalFlowError(state.last_error, state);
        }

        appendTimeline(state, 'awaiting_reconciliation', decision.reason);
        await this.receiptStore.save(state);
      } catch (error) {
        state.last_error = error instanceof Error ? error.message : String(error);
        await this.tryReconcile(state);

        if (error instanceof FinalFlowError) {
          appendTimeline(state, 'failed', state.last_error);
          await this.receiptStore.save(state);
          throw error;
        }

        const decision = this.shouldRetry({ error, state: cloneJson(state) });
        if (!decision.retry || state.attempt_count >= this.maxAttempts) {
          appendTimeline(state, 'failed', state.last_error);
          await this.receiptStore.save(state);
          throw new Error(`${state.last_error}; session_id=${state.session_id}`);
        }

        appendTimeline(state, 'awaiting_reconciliation', `${decision.reason}; retrying`);
        await this.receiptStore.save(state);
      }
    }

    state.last_error = `exhausted ${this.maxAttempts} attempts without a terminal settlement signal`;
    appendTimeline(state, 'failed', state.last_error);
    await this.receiptStore.save(state);
    throw new Error(`${state.last_error}; session_id=${state.session_id}`);
  }

  checklist(stateOrResult) {
    const state = stateOrResult && stateOrResult.state ? stateOrResult.state : stateOrResult;
    if (!state) {
      throw new Error('state is required');
    }

    const receiptStatus = state.receipt_snapshot?.status || state.receipt_snapshot?.settlement || state.receipt_snapshot?.payment?.settlement_status || null;
    const proofStatus = state.proof_snapshot?.on_chain?.status || state.proof_snapshot?.status || null;

    const checks = [
      makeCheck('session_id', Boolean(state.session_id), state.session_id),
      makeCheck('quote_id', Boolean(state.quote_id), state.quote_id),
      makeCheck('idempotency_key', Boolean(state.idempotency_key), state.idempotency_key),
      makeCheck('saw_execute_attempt', state.attempt_count > 0, state.last_http_status),
      makeCheck('payment_required_header', Boolean(state.payment_required_header), state.payment_required_header),
      makeCheck('reused_single_authorization', countTimeline(state, 'authorizing_payment') <= 1 && Boolean(state.payment_authorization), countTimeline(state, 'authorizing_payment')),
      makeCheck('wallet_receipt', Boolean(state.wallet_receipt), state.wallet_receipt),
      makeCheck('payment_receipt_header', Boolean(state.payment_receipt_header), state.payment_receipt_header),
      makeCheck('payment_response_header', Boolean(state.payment_response_header), state.payment_response_header),
      makeCheck('receipt_id', Boolean(state.receipt_id), state.receipt_id),
      makeCheck('invocation_id', Boolean(state.invocation_id), state.invocation_id),
      makeCheck('settlement_or_proof_terminal', isTerminalReceiptStatus(receiptStatus) || isTerminalProofStatus(proofStatus), { receiptStatus, proofStatus }),
      makeCheck('retry_happened_after_payment', countTimeline(state, 'retrying_paid_request') >= 1, countTimeline(state, 'retrying_paid_request')),
    ];

    return { ok: checks.every((entry) => entry.ok), checks };
  }

  buildResult(state, payload) {
    return {
      ok: true,
      response: {
        ...payload,
        payment_receipt: state.payment_receipt_header,
        payment_response: state.payment_response_header,
        wallet_receipt: state.wallet_receipt,
      },
      receipt: state.receipt_snapshot,
      proof: state.proof_snapshot,
      state: cloneJson(state),
      checklist: this.checklist(state),
    };
  }

  buildCommonHeaders() {
    const headers = { Accept: 'application/json' };
    if (this.apiKey) {
      headers.Authorization = `Bearer ${this.apiKey}`;
    }
    return headers;
  }

  buildExecuteHeaders(idempotencyKey) {
    return {
      ...this.buildCommonHeaders(),
      'Content-Type': 'application/json',
      'X-Idempotency-Key': idempotencyKey,
    };
  }

  buildPaidHeaders(paymentAuthorization, idempotencyKey) {
    const headers = this.buildExecuteHeaders(idempotencyKey);
    if (paymentAuthorization.authorizationHeader) headers.Authorization = paymentAuthorization.authorizationHeader;
    if (paymentAuthorization.paymentSignature) headers['PAYMENT-SIGNATURE'] = paymentAuthorization.paymentSignature;
    if (paymentAuthorization.paymentId) headers['PAYMENT-ID'] = paymentAuthorization.paymentId;
    return headers;
  }

  async tryReconcile(state) {
    if (state.receipt_id && this.apiKey) {
      const receipt = await this.fetchReceipt(state.receipt_id);
      if (receipt) {
        state.receipt_snapshot = receipt;
        if (isTerminalReceiptStatus(readReceiptStatus(receipt))) {
          appendTimeline(state, 'reconciled', `receipt ${state.receipt_id} reached terminal settlement state`);
          await this.receiptStore.save(state);
          return;
        }
      }
    }

    if (state.invocation_id) {
      const proof = await this.fetchProof(state.invocation_id);
      if (proof) {
        state.proof_snapshot = proof;
        if (isTerminalProofStatus(readProofStatus(proof))) {
          appendTimeline(state, 'reconciled', `proof ${state.invocation_id} reached terminal verification state`);
          await this.receiptStore.save(state);
          return;
        }
      }
    }

    for (let poll = 0; poll < this.receiptPollAttempts; poll += 1) {
      if (state.receipt_id && this.apiKey) {
        const receipt = await this.fetchReceipt(state.receipt_id);
        if (receipt) {
          state.receipt_snapshot = receipt;
          if (isTerminalReceiptStatus(readReceiptStatus(receipt))) {
            appendTimeline(state, 'reconciled', `receipt ${state.receipt_id} settled after poll ${poll + 1}`);
            await this.receiptStore.save(state);
            return;
          }
        }
      }

      if (state.invocation_id) {
        const proof = await this.fetchProof(state.invocation_id);
        if (proof) {
          state.proof_snapshot = proof;
          if (isTerminalProofStatus(readProofStatus(proof))) {
            appendTimeline(state, 'reconciled', `proof ${state.invocation_id} became terminal after poll ${poll + 1}`);
            await this.receiptStore.save(state);
            return;
          }
        }
      }

      if (poll < this.receiptPollAttempts - 1) {
        await sleep(this.receiptPollIntervalMs);
      }
    }
  }

  async fetchReceipt(receiptId) {
    try {
      const response = await this.fetchImpl(
        `${this.baseUrl}/api/commerce/receipts/${encodeURIComponent(receiptId)}`,
        { headers: this.buildCommonHeaders() }
      );
      if (!response.ok) return null;
      return safeJson(response);
    } catch {
      return null;
    }
  }

  async fetchProof(invocationId) {
    try {
      const response = await this.fetchImpl(
        `${this.baseUrl}/api/x402/invocations/${encodeURIComponent(invocationId)}/proof`,
        { headers: { Accept: 'application/json' } }
      );
      if (!response.ok) return null;
      return safeJson(response);
    } catch {
      return null;
    }
  }
}

function createState(input) {
  return {
    session_id: input.sessionId || generateSessionId(),
    quote_id: input.quoteId,
    server: input.server,
    tool: input.tool,
    idempotency_key: input.idempotencyKey || `${input.quoteId}:${Date.now()}`,
    attempt_count: 0,
    phase: 'created',
    last_http_status: null,
    invocation_id: null,
    receipt_id: null,
    payment_required_header: null,
    payment_receipt_header: null,
    payment_response_header: null,
    payment_authorization: null,
    wallet_receipt: null,
    receipt_snapshot: null,
    proof_snapshot: null,
    result_snapshot: null,
    last_error: null,
    timeline: [{ at: new Date().toISOString(), phase: 'created', note: 'state initialized' }],
  };
}

function appendTimeline(state, phase, note) {
  state.phase = phase;
  state.timeline.push({ at: new Date().toISOString(), phase, note });
  return state;
}

function mergeResponseEvidence(state, payload, response) {
  state.last_http_status = response.status;
  state.result_snapshot = payload;
  state.invocation_id = payload.invocation_id || payload.invocation?.id || state.invocation_id;
  state.payment_receipt_header = getHeader(response.headers, 'payment-receipt') || state.payment_receipt_header;
  state.payment_response_header = getHeader(response.headers, 'payment-response') || state.payment_response_header;
  state.receipt_id = extractReceiptId(state.payment_receipt_header, payload) || state.receipt_id;
}

function validateAuthorization(authorization) {
  if (!authorization || (!authorization.authorizationHeader && !authorization.paymentSignature)) {
    throw new Error('payChallenge must return authorizationHeader and/or paymentSignature');
  }
}

function assertRequiredString(value, name) {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new Error(`${name} is required`);
  }
}

function extractReceiptId(rawHeader, payload) {
  const direct = payload?.receipt_id || payload?.receipt?.receipt_id || payload?.receipt?.id;
  if (typeof direct === 'string' && direct.length > 0) return direct;
  if (!rawHeader) return null;

  const decoded = parseLooseJson(rawHeader) || decodeBase64Json(rawHeader);
  const nested = decoded?.receipt_id || decoded?.id || decoded?.receipt?.receipt_id;
  if (typeof nested === 'string' && nested.length > 0) return nested;

  const match = String(rawHeader).match(/(rcpt_[A-Za-z0-9_-]+|rec(?:eipt)?_[A-Za-z0-9_-]+)/i);
  if (match) return match[1];

  try {
    const url = new URL(rawHeader);
    const parts = url.pathname.split('/').filter(Boolean);
    return parts[parts.length - 1] || null;
  } catch {
    return String(rawHeader).trim() || null;
  }
}

function normalizeBaseUrl(baseUrl) {
  return String(baseUrl).replace(/\/$/, '');
}

function buildQuery(params) {
  const query = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value === undefined || value === null || value === '') continue;
    query.set(key, String(value));
  }
  const qs = query.toString();
  return qs ? `?${qs}` : '';
}

async function safeJson(response) {
  const text = await response.text();
  if (!text) return {};
  try {
    return JSON.parse(text);
  } catch {
    return { raw: text };
  }
}

function getHeader(headers, name) {
  return headers.get(name) || headers.get(name.toLowerCase()) || headers.get(name.toUpperCase()) || null;
}

function readReceiptStatus(receipt) {
  return receipt?.status || receipt?.settlement || receipt?.payment?.settlement_status || null;
}

function readProofStatus(proof) {
  return proof?.on_chain?.status || proof?.status || null;
}

function isTerminalReceiptStatus(status) {
  return typeof status === 'string' && ['settled', 'completed', 'succeeded'].includes(status.toLowerCase());
}

function isTerminalProofStatus(status) {
  return typeof status === 'string' && ['verified', 'settled', 'completed'].includes(status.toLowerCase());
}

function defaultRetryDecision({ response, error }) {
  if (response && isRetryableStatus(response.status)) {
    return { retry: true, reason: `retryable HTTP ${response.status}` };
  }
  if (error) {
    return { retry: true, reason: 'network or fetch error during paid flow' };
  }
  return { retry: false, reason: 'non-retryable response' };
}

function isRetryableStatus(status) {
  return status === 408 || status === 409 || status === 425 || status === 429 || status >= 500;
}

function decodeBase64Json(value) {
  try {
    const raw = String(value);
    const trimmed = raw.startsWith('x402:') ? raw.slice(5) : raw;
    const decoded = Buffer.from(trimmed, 'base64').toString('utf8');
    return JSON.parse(decoded);
  } catch {
    return null;
  }
}

function parseLooseJson(value) {
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}

function generateSessionId() {
  if (globalThis.crypto && typeof globalThis.crypto.randomUUID === 'function') {
    return `x402_${globalThis.crypto.randomUUID()}`;
  }
  return `x402_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`;
}

function cloneJson(value) {
  return JSON.parse(JSON.stringify(value));
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function positiveInt(value, fallback) {
  return Number.isInteger(value) && value > 0 ? value : fallback;
}

function nonNegativeInt(value, fallback) {
  return Number.isInteger(value) && value >= 0 ? value : fallback;
}

function makeCheck(name, ok, evidence) {
  return { name, ok: Boolean(ok), evidence: evidence ?? null };
}

function countTimeline(state, phase) {
  return state.timeline.filter((entry) => entry.phase === phase).length;
}

async function demo() {
  const callLog = [];
  let paidAttempts = 0;
  let receiptPolls = 0;

  const fetchImpl = async (url, options = {}) => {
    const method = options.method || 'GET';
    const headers = options.headers || {};
    callLog.push({ url, method, headers });

    if (url.includes('/api/x402/execute/match')) {
      return jsonResponse(200, {
        quote_id: 'quote_demo_123',
        tool: 'search_docs',
        price: { amount: '2500', asset: 'USDC' },
      });
    }

    if (url.endsWith('/api/x402/execute') && method === 'POST') {
      const authorization = headers.Authorization;
      const signed = Boolean((typeof authorization === 'string' && authorization.startsWith('Bearer paid:')) || headers['PAYMENT-SIGNATURE']);
      if (!signed) {
        return jsonResponse(
          402,
          { error: 'payment required', quote_id: 'quote_demo_123' },
          { 'payment-required': 'x402:ZGVtb19jaGFsbGVuZ2U=' }
        );
      }

      paidAttempts += 1;
      if (paidAttempts === 1) {
        return jsonResponse(
          502,
          { error: 'temporary upstream failure', invocation_id: 'inv_demo_456', receipt_id: 'rcpt_demo_789' },
          {
            'payment-receipt': JSON.stringify({ receipt_id: 'rcpt_demo_789' }),
            'payment-response': JSON.stringify({ status: 'accepted' }),
          }
        );
      }

      return jsonResponse(
        200,
        {
          ok: true,
          invocation_id: 'inv_demo_456',
          receipt_id: 'rcpt_demo_789',
          output: { result: 'tool output' },
        },
        {
          'payment-receipt': JSON.stringify({ receipt_id: 'rcpt_demo_789' }),
          'payment-response': JSON.stringify({ status: 'accepted' }),
        }
      );
    }

    if (url.includes('/api/commerce/receipts/rcpt_demo_789')) {
      receiptPolls += 1;
      return jsonResponse(200, {
        id: 'rcpt_demo_789',
        status: receiptPolls >= 2 ? 'settled' : 'pending',
        amount: '2500',
        asset: 'USDC',
      });
    }

    if (url.includes('/api/x402/invocations/inv_demo_456/proof')) {
      return jsonResponse(200, {
        invocation_id: 'inv_demo_456',
        on_chain: { status: receiptPolls >= 2 ? 'verified' : 'pending' },
      });
    }

    return jsonResponse(404, { error: `unhandled url ${url}` });
  };

  let payCalls = 0;
  const client = new X402McpExecuteReceiptChecklist({
    apiKey: 'demo_api_key',
    baseUrl: 'https://demo.agoragentic.local',
    fetchImpl,
    receiptPollIntervalMs: 1,
    payChallenge: async (paymentRequired, request) => {
      payCalls += 1;
      return {
        authorizationHeader: `Bearer paid:${paymentRequired}:${request.sessionId}`,
        paymentSignature: `sig:${request.idempotencyKey}`,
        paymentId: 'pay_demo_001',
        receipt: { simulated: true, quote_id: request.body.quote_id },
      };
    },
  });

  const quote = await client.previewToolCall({
    server: 'docs-server',
    tool: 'search_docs',
    buyer: 'demo-buyer',
    maxPriceUsdc: '0.0025',
  });

  if (quote.quote_id !== 'quote_demo_123') {
    throw new Error(`unexpected preview quote: ${JSON.stringify(quote)}`);
  }

  const result = await client.executeToolCall({
    server: 'docs-server',
    tool: 'search_docs',
    arguments: { query: 'x402 receipt checklist' },
    quoteId: quote.quote_id,
    sessionId: 'session_demo_001',
    idempotencyKey: 'demo-idempotency-key',
  });

  if (!result.ok) {
    throw new Error('result.ok was false');
  }
  if (!result.checklist.ok) {
    throw new Error(`checklist failed: ${JSON.stringify(result.checklist)}`);
  }
  if (payCalls !== 1) {
    throw new Error(`expected 1 payChallenge call, saw ${payCalls}`);
  }
  const paidRequests = callLog.filter((entry) => entry.url.endsWith('/api/x402/execute') && entry.headers.Authorization && entry.headers.Authorization.startsWith('Bearer paid:'));
  if (paidRequests.length !== 2) {
    throw new Error(`expected 2 paid execute attempts, saw ${paidRequests.length}`);
  }
  const distinctAuthValues = new Set(paidRequests.map((entry) => entry.headers.Authorization));
  if (distinctAuthValues.size !== 1) {
    throw new Error('expected payment authorization to be reused across retries');
  }

  console.log(JSON.stringify({
    quote,
    checklist: result.checklist,
    response: result.response,
    receipt: result.receipt,
    proof: result.proof,
    pay_calls: payCalls,
    execute_calls: callLog.filter((entry) => entry.url.endsWith('/api/x402/execute')).length,
    timeline: result.state.timeline,
  }, null, 2));
}

function jsonResponse(status, payload, headers = {}) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: {
      'content-type': 'application/json',
      ...headers,
    },
  });
}

module.exports = {
  X402McpExecuteReceiptChecklist,
  MemoryReceiptStore,
  FinalFlowError,
};

if (require.main === module) {
  demo().catch((error) => {
    console.error(error && error.stack ? error.stack : String(error));
    process.exitCode = 1;
  });
}
