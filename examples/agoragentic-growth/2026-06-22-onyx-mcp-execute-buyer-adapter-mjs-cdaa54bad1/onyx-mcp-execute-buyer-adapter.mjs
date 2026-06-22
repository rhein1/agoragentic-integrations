#!/usr/bin/env node
/* demo — moves no real funds */

import { pathToFileURL } from 'node:url';

const DEFAULT_BASE_URL = 'https://agoragentic.com';
const DEFAULT_SERVER = 'onyx-mcp';
const DEFAULT_MAX_ATTEMPTS = 4;
const DEFAULT_RECEIPT_POLL_ATTEMPTS = 4;
const DEFAULT_RECEIPT_POLL_INTERVAL_MS = 10;

export class FinalFlowError extends Error {
  constructor(message, state, cause = null) {
    super(message);
    this.name = 'FinalFlowError';
    this.state = state ? cloneJson(state) : null;
    this.cause = cause;
  }
}

export class MemoryReceiptStore {
  constructor() {
    this.map = new Map();
  }

  async load(sessionId) {
    return this.map.has(sessionId) ? cloneJson(this.map.get(sessionId)) : null;
  }

  async save(state) {
    this.map.set(state.session_id, cloneJson(state));
  }
}

export class OnyxMcpExecuteBuyerAdapter {
  constructor(options = {}) {
    if (typeof (options.fetchImpl || globalThis.fetch) !== 'function') {
      throw new Error('fetch implementation is required (Node 18+ or pass fetchImpl)');
    }
    if (typeof options.pay !== 'function') {
      throw new Error('pay callback is required and is the explicit payment gate');
    }

    this.baseUrl = normalizeBaseUrl(options.baseUrl || DEFAULT_BASE_URL);
    this.fetchImpl = options.fetchImpl || globalThis.fetch;
    this.apiKey = options.apiKey || null;
    this.pay = options.pay;
    this.server = options.server || DEFAULT_SERVER;
    this.receiptStore = options.receiptStore || new MemoryReceiptStore();
    this.maxAttempts = positiveInt(options.maxAttempts, DEFAULT_MAX_ATTEMPTS);
    this.receiptPollAttempts = positiveInt(options.receiptPollAttempts, DEFAULT_RECEIPT_POLL_ATTEMPTS);
    this.receiptPollIntervalMs = nonNegativeInt(options.receiptPollIntervalMs, DEFAULT_RECEIPT_POLL_INTERVAL_MS);
    this.shouldRetry = options.shouldRetry || defaultRetryDecision;
    this.x402FetchPromise = options.x402Fetch ? Promise.resolve(options.x402Fetch) : resolveX402Fetch();
  }

  async preview(request) {
    assertRequiredString(request?.tool, 'tool');

    const response = await this.fetchImpl(
      `${this.baseUrl}/api/x402/execute/match${buildQuery({
        task: request.task || `${this.server}/${request.tool}`,
        mcp_server: request.server || this.server,
        tool_name: request.tool,
        buyer: request.buyer,
        max_price_usdc: request.maxPriceUsdc,
      })}`,
      { headers: this.buildCommonHeaders() }
    );

    const payload = await safeJson(response);
    if (!response.ok) {
      throw new Error(`preview failed with HTTP ${response.status}: ${payload.error || response.statusText}`);
    }
    return payload;
  }

  async execute(input) {
    assertRequiredString(input?.tool, 'tool');
    assertRequiredString(input?.quoteId, 'quoteId');

    const existing = input.sessionId ? await this.receiptStore.load(input.sessionId) : null;
    const state = existing || createState({
      sessionId: input.sessionId,
      quoteId: input.quoteId,
      server: input.server || this.server,
      tool: input.tool,
      idempotencyKey: input.idempotencyKey,
    });

    if (existing && existing.quote_id !== input.quoteId) {
      throw new Error(`existing session ${state.session_id} is bound to quote ${existing.quote_id}, not ${input.quoteId}`);
    }

    const body = {
      quote_id: state.quote_id,
      input: {
        transport: 'mcp',
        server: input.server || this.server,
        tool: input.tool,
        arguments: input.arguments || {},
      },
    };

    const x402Fetch = await this.x402FetchPromise;
    state.request_body = cloneJson(body);
    appendTimeline(state, 'initial_request', 'execute() request prepared');
    await this.receiptStore.save(state);

    try {
      const result = await x402Fetch(`${this.baseUrl}/api/x402/execute`, {
        method: 'POST',
        headers: this.buildExecuteHeaders(state.idempotency_key),
        body: JSON.stringify(body),
        fetchImpl: this.fetchImpl,
        idempotencyKey: state.idempotency_key,
        maxAttempts: this.maxAttempts,
        shouldRetry: (ctx) => {
          const decision = this.shouldRetry(ctx);
          if (ctx.attemptNumber) {
            state.attempt_count = Math.max(state.attempt_count, ctx.attemptNumber);
          }
          if (ctx.phase === 'initial' && ctx.response?.status === 402) {
            state.payment_required_header = getHeader(ctx.response.headers, 'payment-required');
            appendTimeline(state, 'payment_required', `402 received on attempt ${ctx.attemptNumber}`);
          } else if (ctx.phase === 'paid_retry' && ctx.response) {
            appendTimeline(state, 'paid_response', `paid retry returned HTTP ${ctx.response.status}`);
          } else if (ctx.error) {
            appendTimeline(state, 'transient_error', ctx.error.message || String(ctx.error));
          }
          return decision;
        },
        pay: async (paymentRequired, requestContext) => {
          state.payment_required_header = paymentRequired;
          if (state.payment_authorization) {
            appendTimeline(state, 'payment_reused', 'reusing cached payment authorization after prior 402');
            return cloneJson(state.payment_authorization);
          }

          appendTimeline(state, 'authorizing_payment', 'calling pay exactly once for this session after HTTP 402');
          const authorization = await this.pay(paymentRequired, {
            url: requestContext.url,
            method: requestContext.method,
            body: cloneJson(body),
            sessionId: state.session_id,
            idempotencyKey: state.idempotency_key,
            quoteId: state.quote_id,
            server: input.server || this.server,
            tool: input.tool,
            attempt: requestContext.attemptNumber,
          });

          validateAuthorization(authorization);
          state.payment_authorization = {
            authorizationHeader: authorization.authorizationHeader || null,
            paymentSignature: authorization.paymentSignature || null,
            paymentId: authorization.paymentId || null,
            receipt: authorization.receipt || null,
            payer: authorization.payer || null,
            chain: authorization.chain || null,
          };
          state.wallet_receipt = authorization.receipt || state.wallet_receipt;
          await this.receiptStore.save(state);
          return cloneJson(state.payment_authorization);
        },
      });

      mergeResponseEvidence(state, result.responseBody, result.response);
      state.attempt_count = Math.max(state.attempt_count, result.attempts || 1);
      state.wallet_receipt = result.paymentAuthorization?.receipt || state.wallet_receipt;
      if (result.paymentAuthorization) {
        state.payment_authorization = {
          authorizationHeader: result.paymentAuthorization.authorizationHeader || null,
          paymentSignature: result.paymentAuthorization.paymentSignature || null,
          paymentId: result.paymentAuthorization.paymentId || null,
          receipt: result.paymentAuthorization.receipt || null,
          payer: result.paymentAuthorization.payer || null,
          chain: result.paymentAuthorization.chain || null,
        };
      }

      appendTimeline(state, result.authorized ? 'retrying_paid_request' : 'succeeded', `terminal HTTP ${result.response.status}`);
      await this.tryReconcile(state);
      appendTimeline(state, state.receipt_snapshot || state.proof_snapshot ? 'reconciled' : 'succeeded', 'terminal response captured');
      await this.receiptStore.save(state);
      return this.buildResult(state, result.responseBody);
    } catch (error) {
      if (error?.response) {
        const bodyPayload = error.responseBody || await safeJson(error.response);
        mergeResponseEvidence(state, bodyPayload, error.response);
      }
      state.attempt_count = Math.max(state.attempt_count, error.attempts || state.attempt_count || 1);
      state.last_error = error instanceof Error ? error.message : String(error);
      await this.tryReconcile(state);
      appendTimeline(state, 'failed', state.last_error);
      await this.receiptStore.save(state);
      throw new FinalFlowError(state.last_error, state, error);
    }
  }

  buildResult(state, responsePayload) {
    return {
      ok: true,
      response: {
        ...responsePayload,
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

  checklist(stateOrResult) {
    const state = stateOrResult?.state ? stateOrResult.state : stateOrResult;
    if (!state) throw new Error('state is required');

    const receiptStatus = readReceiptStatus(state.receipt_snapshot);
    const proofStatus = readProofStatus(state.proof_snapshot);
    const demoEvidence = isDemoEvidenceStatus(receiptStatus)
      || isDemoEvidenceStatus(proofStatus)
      || state.wallet_receipt?.simulated === true;
    const terminalEvidence = isTerminalReceiptStatus(receiptStatus) || isTerminalProofStatus(proofStatus);

    const checks = [
      makeCheck('session_id', Boolean(state.session_id), state.session_id),
      makeCheck('quote_id', Boolean(state.quote_id), state.quote_id),
      makeCheck('idempotency_key', Boolean(state.idempotency_key), state.idempotency_key),
      makeCheck(
        'saw_402_before_payment',
        Boolean(state.payment_required_header) || state.timeline.some((entry) => entry.phase === 'payment_required'),
        state.payment_required_header
      ),
      makeCheck('pay_callback_used_once', countTimeline(state, 'authorizing_payment') === 1, countTimeline(state, 'authorizing_payment')),
      makeCheck('paid_retry_happened', countTimeline(state, 'retrying_paid_request') >= 1, countTimeline(state, 'retrying_paid_request')),
      makeCheck('payment_required_header', Boolean(state.payment_required_header), state.payment_required_header),
      makeCheck('wallet_receipt', Boolean(state.wallet_receipt), state.wallet_receipt),
      makeCheck('payment_receipt_header', Boolean(state.payment_receipt_header), state.payment_receipt_header),
      makeCheck('payment_response_header', Boolean(state.payment_response_header), state.payment_response_header),
      makeCheck('receipt_id', Boolean(state.receipt_id), state.receipt_id),
      makeCheck('invocation_id', Boolean(state.invocation_id), state.invocation_id),
      makeCheck('terminal_receipt_or_demo_evidence', terminalEvidence || demoEvidence, { receiptStatus, proofStatus, demoEvidence }),
      makeCheck('no_submitted_claimed_as_settled', receiptStatus !== 'submitted' && proofStatus !== 'submitted', { receiptStatus, proofStatus }),
      makeCheck('simulated_receipt_not_settled', !(state.wallet_receipt?.simulated === true && receiptStatus === 'settled'), { receiptStatus, simulated: state.wallet_receipt?.simulated === true }),
    ];

    return {
      ok: checks.every((entry) => entry.ok),
      checks,
    };
  }

  buildCommonHeaders() {
    const headers = { Accept: 'application/json' };
    if (this.apiKey) headers.Authorization = `Bearer ${this.apiKey}`;
    return headers;
  }

  buildExecuteHeaders(idempotencyKey) {
    return {
      ...this.buildCommonHeaders(),
      'Content-Type': 'application/json',
      'X-Idempotency-Key': idempotencyKey,
    };
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
      const response = await this.fetchImpl(`${this.baseUrl}/api/commerce/receipts/${encodeURIComponent(receiptId)}`, {
        headers: this.buildCommonHeaders(),
      });
      if (!response.ok) return null;
      return await safeJson(response);
    } catch {
      return null;
    }
  }

  async fetchProof(invocationId) {
    try {
      const response = await this.fetchImpl(`${this.baseUrl}/api/x402/invocations/${encodeURIComponent(invocationId)}/proof`, {
        headers: { Accept: 'application/json' },
      });
      if (!response.ok) return null;
      return await safeJson(response);
    } catch {
      return null;
    }
  }
}

export async function execute(request, options = {}) {
  const adapter = new OnyxMcpExecuteBuyerAdapter(options);
  return adapter.execute(request);
}

async function resolveX402Fetch() {
  const candidates = [
    'agoragentic/x402-client',
    '../lib/x402-client.mjs',
    './lib/x402-client.mjs',
  ];

  for (const candidate of candidates) {
    try {
      const mod = await import(candidate);
      if (typeof mod.x402Fetch === 'function') {
        return mod.x402Fetch;
      }
    } catch {
      // fall through
    }
  }

  return createFallbackX402Fetch();
}

function createFallbackX402Fetch() {
  return async function x402Fetch(url, options = {}) {
    const fetchImpl = options.fetchImpl || globalThis.fetch;
    if (typeof fetchImpl !== 'function') {
      throw new Error('fetchImpl is required');
    }
    if (typeof options.pay !== 'function') {
      throw new Error('pay callback is required');
    }

    const method = options.method || 'GET';
    const baseHeaders = normalizeHeaders(options.headers || {});
    const idempotencyKey = options.idempotencyKey || baseHeaders['x-idempotency-key'] || generateIdempotencyKey();
    const shouldRetry = options.shouldRetry || defaultRetryDecision;
    const maxAttempts = positiveInt(options.maxAttempts, DEFAULT_MAX_ATTEMPTS);
    const body = options.body;
    let authorization = null;
    let paidChallenge = null;
    let attemptNumber = 0;

    while (attemptNumber < maxAttempts) {
      attemptNumber += 1;
      const headers = denormalizeHeaders(baseHeaders);
      headers['x-idempotency-key'] = idempotencyKey;
      if (authorization?.authorizationHeader) headers.authorization = authorization.authorizationHeader;
      if (authorization?.paymentSignature) headers['payment-signature'] = authorization.paymentSignature;
      if (authorization?.paymentId) headers['payment-id'] = authorization.paymentId;

      let response;
      try {
        response = await fetchImpl(url, {
          ...options,
          method,
          headers,
          body,
        });
      } catch (error) {
        const decision = shouldRetry({ phase: authorization ? 'paid_retry' : 'initial', attemptNumber, error, authorization });
        if (decision.retry && attemptNumber < maxAttempts) {
          continue;
        }
        const terminal = new Error(error instanceof Error ? error.message : String(error));
        terminal.cause = error;
        terminal.attempts = attemptNumber;
        terminal.authorization = authorization;
        throw terminal;
      }

      const responseBody = await safeJson(response.clone());
      if (response.status === 402) {
        if (authorization) {
          const terminal = new Error('server returned HTTP 402 again after payment authorization was already provided');
          terminal.response = response;
          terminal.responseBody = responseBody;
          terminal.attempts = attemptNumber;
          terminal.authorization = authorization;
          throw terminal;
        }

        paidChallenge = getHeader(response.headers, 'payment-required');
        if (!paidChallenge) {
          const terminal = new Error('HTTP 402 response missing payment-required header');
          terminal.response = response;
          terminal.responseBody = responseBody;
          terminal.attempts = attemptNumber;
          throw terminal;
        }

        authorization = await options.pay(paidChallenge, {
          url,
          method,
          body: safeBodyForCallback(body),
          headers: cloneJson(headers),
          idempotencyKey,
          attemptNumber,
        });
        validateAuthorization(authorization);
        continue;
      }

      if (response.ok) {
        return {
          ok: true,
          authorized: Boolean(authorization),
          challenge: paidChallenge,
          attempts: attemptNumber,
          paymentAuthorization: authorization,
          response,
          responseBody,
        };
      }

      const decision = shouldRetry({
        phase: authorization ? 'paid_retry' : 'initial',
        attemptNumber,
        response,
        responseBody,
        authorization,
      });
      if (decision.retry && attemptNumber < maxAttempts) {
        continue;
      }

      const terminal = new Error(`HTTP ${response.status}`);
      terminal.response = response;
      terminal.responseBody = responseBody;
      terminal.attempts = attemptNumber;
      terminal.authorization = authorization;
      throw terminal;
    }

    const terminal = new Error(`exhausted ${maxAttempts} attempts`);
    terminal.attempts = maxAttempts;
    terminal.authorization = authorization;
    throw terminal;
  };
}

function createState(input) {
  return {
    session_id: input.sessionId || generateSessionId(),
    quote_id: input.quoteId,
    server: input.server,
    tool: input.tool,
    idempotency_key: input.idempotencyKey || generateIdempotencyKey(),
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
    request_body: null,
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
  state.invocation_id = payload?.invocation_id || payload?.invocation?.id || state.invocation_id;
  state.payment_receipt_header = getHeader(response.headers, 'payment-receipt') || state.payment_receipt_header;
  state.payment_response_header = getHeader(response.headers, 'payment-response') || state.payment_response_header;
  state.receipt_id = extractReceiptId(state.payment_receipt_header, payload) || state.receipt_id;
}

function validateAuthorization(authorization) {
  if (!authorization || (!authorization.authorizationHeader && !authorization.paymentSignature)) {
    throw new Error('pay must return authorizationHeader and/or paymentSignature');
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

  const parsed = parseLooseJson(rawHeader) || decodeBase64Json(rawHeader);
  const nested = parsed?.receipt_id || parsed?.id || parsed?.receipt?.receipt_id;
  if (typeof nested === 'string' && nested.length > 0) return nested;

  const match = String(rawHeader).match(/(rcpt_[A-Za-z0-9_-]+|rec(?:eipt)?_[A-Za-z0-9_-]+)/i);
  if (match) return match[1];
  return String(rawHeader).trim() || null;
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

function normalizeBaseUrl(baseUrl) {
  return String(baseUrl).replace(/\/$/, '');
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

function safeBodyForCallback(body) {
  if (typeof body !== 'string') return body;
  try {
    return JSON.parse(body);
  } catch {
    return body;
  }
}

function getHeader(headers, name) {
  return headers.get(name) || headers.get(name.toLowerCase()) || headers.get(name.toUpperCase()) || null;
}

function readReceiptStatus(receipt) {
  return normalizeStatus(receipt?.status || receipt?.settlement || receipt?.payment?.settlement_status || null);
}

function readProofStatus(proof) {
  return normalizeStatus(proof?.on_chain?.status || proof?.status || null);
}

function normalizeStatus(value) {
  return typeof value === 'string' ? value.toLowerCase() : null;
}

function isTerminalReceiptStatus(status) {
  return typeof status === 'string' && ['settled', 'completed', 'succeeded'].includes(status);
}

function isTerminalProofStatus(status) {
  return typeof status === 'string' && ['verified', 'settled', 'completed'].includes(status);
}

function isDemoEvidenceStatus(status) {
  return typeof status === 'string' && ['demo-accepted', 'demo-observed', 'simulated'].includes(status);
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
    return JSON.parse(Buffer.from(trimmed, 'base64').toString('utf8'));
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

function cloneJson(value) {
  return value == null ? value : JSON.parse(JSON.stringify(value));
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

function normalizeHeaders(headersLike) {
  const out = {};
  for (const [key, value] of Object.entries(headersLike || {})) {
    out[String(key).toLowerCase()] = String(value);
  }
  return out;
}

function denormalizeHeaders(headersLike) {
  return { ...headersLike };
}

function generateSessionId() {
  if (globalThis.crypto?.randomUUID) {
    return `x402_${globalThis.crypto.randomUUID()}`;
  }
  return `x402_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`;
}

function generateIdempotencyKey() {
  if (globalThis.crypto?.randomUUID) {
    return globalThis.crypto.randomUUID();
  }
  return `${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
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

async function demo() {
  const callLog = [];
  let paidAttempts = 0;
  let receiptPolls = 0;

  const fetchImpl = async (urlLike, options = {}) => {
    const url = String(urlLike);
    const method = options.method || 'GET';
    const headers = normalizeHeaders(options.headers || {});
    callLog.push({ url, method, headers, body: options.body || null });

    if (url.includes('/api/x402/execute/match')) {
      return jsonResponse(200, {
        quote_id: 'quote_demo_123',
        tool: 'search_docs',
        price: { amount: '2500', asset: 'USDC' },
      });
    }

    if (url.endsWith('/api/x402/execute') && method === 'POST') {
      const signed = Boolean(headers.authorization?.startsWith('Bearer paid:') || headers['payment-signature']);
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
        status: receiptPolls >= 2 ? 'demo-accepted' : 'pending',
        amount: '2500',
        asset: 'USDC',
        simulated: true,
        settlement_note: 'demo evidence only; no real funds moved',
      });
    }

    if (url.includes('/api/x402/invocations/inv_demo_456/proof')) {
      return jsonResponse(200, {
        invocation_id: 'inv_demo_456',
        on_chain: {
          status: receiptPolls >= 2 ? 'demo-observed' : 'pending',
          simulated: true,
          note: 'demo evidence only; no on-chain verification performed',
        },
      });
    }

    return jsonResponse(404, { error: `unhandled url ${url}` });
  };

  let payCalls = 0;
  const adapter = new OnyxMcpExecuteBuyerAdapter({
    apiKey: 'demo_api_key',
    baseUrl: 'https://demo.agoragentic.local',
    fetchImpl,
    receiptPollIntervalMs: 1,
    pay: async (paymentRequired, request) => {
      payCalls += 1;
      return {
        authorizationHeader: `Bearer paid:${paymentRequired}:${request.sessionId}`,
        paymentSignature: `sig:${request.idempotencyKey}`,
        paymentId: 'pay_demo_001',
        receipt: { simulated: true, quote_id: request.quoteId },
        chain: 'demo-solana',
      };
    },
  });

  const quote = await adapter.preview({
    server: 'onyx-mcp',
    tool: 'search_docs',
    buyer: 'demo-buyer',
    maxPriceUsdc: '0.0025',
  });

  if (quote.quote_id !== 'quote_demo_123') {
    throw new Error(`unexpected preview quote: ${JSON.stringify(quote)}`);
  }

  const result = await adapter.execute({
    server: 'onyx-mcp',
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
    throw new Error(`expected 1 pay call, saw ${payCalls}`);
  }

  const paidRequests = callLog.filter((entry) => entry.url.endsWith('/api/x402/execute') && entry.headers.authorization?.startsWith('Bearer paid:'));
  if (paidRequests.length !== 2) {
    throw new Error(`expected 2 paid execute attempts, saw ${paidRequests.length}`);
  }
  if (new Set(paidRequests.map((entry) => entry.headers.authorization)).size !== 1) {
    throw new Error('expected payment authorization to be reused across retries');
  }
  if (new Set(paidRequests.map((entry) => entry.headers['x-idempotency-key'])).size !== 1) {
    throw new Error('expected a stable idempotency key across retries');
  }

  console.log(JSON.stringify({
    quote,
    response: result.response,
    receipt: result.receipt,
    proof: result.proof,
    checklist: result.checklist,
    pay_calls: payCalls,
    execute_calls: callLog.filter((entry) => entry.url.endsWith('/api/x402/execute')).length,
    timeline: result.state.timeline,
  }, null, 2));
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  demo().catch((error) => {
    console.error(error?.stack || String(error));
    process.exitCode = 1;
  });
}
