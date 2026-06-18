#!/usr/bin/env node
'use strict';

/**
 * three.ws x402 buyer adapter:
 * - fetches an executable quote preview
 * - performs execute() with 402 payment challenge recovery
 * - collects receipt/proof evidence into a checklist
 *
 * Run the self-test (from this file's directory):
 *   node three_ws_x402_adapter.js
 */

const DEFAULT_BASE_URL = 'https://three.ws';
const DEFAULT_MAX_ATTEMPTS = 3;
const DEFAULT_RECONCILE_POLLS = 4;
const DEFAULT_RECONCILE_DELAY_MS = 10;

class FinalExecutionError extends Error {
  constructor(message, state) {
    super(message);
    this.name = 'FinalExecutionError';
    this.state = state ? cloneJson(state) : null;
  }
}

class MemoryExecutionStore {
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

class ThreeWsX402Adapter {
  constructor(options = {}) {
    const fetchImpl = options.fetchImpl || globalThis.fetch;
    if (typeof fetchImpl !== 'function') {
      throw new Error('fetch implementation is required (Node 18+ or pass fetchImpl)');
    }
    if (typeof options.payChallenge !== 'function') {
      throw new Error('payChallenge callback is required');
    }

    this.baseUrl = stripTrailingSlash(options.baseUrl || DEFAULT_BASE_URL);
    this.apiKey = options.apiKey || null;
    this.previewPath = options.previewPath || '/api/x402/execute/match';
    this.executePath = options.executePath || '/api/x402/execute';
    this.receiptPathTemplate = options.receiptPathTemplate || '/api/commerce/receipts/{receiptId}';
    this.proofPathTemplate = options.proofPathTemplate || '/api/x402/invocations/{invocationId}/proof';
    this.fetchImpl = fetchImpl;
    this.payChallenge = options.payChallenge;
    this.executionStore = options.executionStore || new MemoryExecutionStore();
    this.maxAttempts = positiveInt(options.maxAttempts, DEFAULT_MAX_ATTEMPTS);
    this.reconcilePolls = positiveInt(options.reconcilePolls, DEFAULT_RECONCILE_POLLS);
    this.reconcileDelayMs = nonNegativeInt(options.reconcileDelayMs, DEFAULT_RECONCILE_DELAY_MS);
    this.shouldRetry = typeof options.shouldRetry === 'function' ? options.shouldRetry : defaultRetryDecision;
  }

  async preview(task, constraints = {}) {
    if (!task || typeof task !== 'string') {
      throw new Error('task is required');
    }

    const url = `${this.baseUrl}${this.previewPath}${buildQuery({ task, ...constraints })}`;
    const response = await this.fetchImpl(url, { headers: this.buildCommonHeaders() });
    const payload = await safeJson(response);

    if (!response.ok) {
      throw new Error(`preview failed with HTTP ${response.status}: ${payload.error || response.statusText}`);
    }

    return payload;
  }

  async execute(input) {
    if (!input || !input.quoteId) {
      throw new Error('quoteId is required');
    }

    const priorState = input.sessionId ? await this.executionStore.load(input.sessionId) : null;
    const state = priorState || createState(input);
    const executeUrl = `${this.baseUrl}${this.executePath}`;
    const requestBody = {
      quote_id: state.quote_id,
      input: input.input || {},
      metadata: input.metadata || {},
    };

    while (state.attempt_count < this.maxAttempts) {
      state.attempt_count += 1;
      addEvent(state, 'initial_request', `attempt ${state.attempt_count} started`);
      await this.executionStore.save(state);

      try {
        // Reuse an already-authorized payment on a retry. Re-issuing an UNPAID request
        // here would draw a fresh 402 and authorize a SECOND payment for the SAME
        // execution — a real double charge if the server is not idempotent. A new
        // payment is authorized ONLY when the server explicitly returns 402 (below).
        const reusingPayment = Boolean(state.payment_authorization);
        if (reusingPayment) {
          addEvent(state, 'retrying_paid_request', `resending the authorized paid execute on attempt ${state.attempt_count}`);
          await this.executionStore.save(state);
        }

        const response = await this.fetchImpl(executeUrl, {
          method: 'POST',
          headers: reusingPayment
            ? this.buildPaidHeaders(state.payment_authorization, state.idempotency_key)
            : this.buildExecuteHeaders(state.idempotency_key),
          body: JSON.stringify(requestBody),
        });

        if (response.status !== 402) {
          const payload = await safeJson(response);
          mergeExecutionEvidence(state, payload, response);
          await this.reconcile(state);

          if (response.ok) {
            addEvent(
              state,
              hasTerminalReceiptEvidence(state) ? 'reconciled' : 'succeeded',
              `${reusingPayment ? 'paid' : 'initial'} response ${response.status}`
            );
            await this.executionStore.save(state);
            return this.buildSuccessResult(state, payload);
          }

          // Non-402 failure. Retry transient errors WITHOUT re-paying (we keep the same
          // authorization + idempotency key); a fresh 402 on the next attempt is the only
          // thing that triggers a new payment.
          state.last_error = `execute failed with HTTP ${response.status}`;
          const decision = this.shouldRetry({ response, state: cloneJson(state) });
          if (!decision.retry || state.attempt_count >= this.maxAttempts) {
            addEvent(state, 'failed', state.last_error);
            await this.executionStore.save(state);
            throw new FinalExecutionError(state.last_error, state);
          }
          addEvent(state, 'awaiting_reconciliation', decision.reason || `retry after HTTP ${response.status}`);
          await this.executionStore.save(state);
          continue;
        }

        // HTTP 402 — the server is (re-)requesting payment. Authorize one now.
        state.payment_required_header = getHeader(response.headers, 'payment-required');
        if (!state.payment_required_header) {
          throw new Error('missing payment-required header on HTTP 402 response');
        }

        addEvent(state, 'payment_required', `received 402 on attempt ${state.attempt_count}`);
        await this.executionStore.save(state);

        const payment = await this.payChallenge(state.payment_required_header, {
          url: executeUrl,
          method: 'POST',
          body: requestBody,
          sessionId: state.session_id,
          idempotencyKey: state.idempotency_key,
          attempt: state.attempt_count,
        });

        if (!payment || (!payment.authorizationHeader && !payment.paymentSignature)) {
          throw new Error('payChallenge must return authorizationHeader and/or paymentSignature');
        }

        // Persist the authorization so a subsequent retry RE-SENDS it rather than paying again.
        state.payment_authorization = payment;
        state.wallet_receipt = payment.receipt || null;
        addEvent(state, 'retrying_paid_request', `retrying paid execute on attempt ${state.attempt_count}`);
        await this.executionStore.save(state);

        const paidResponse = await this.fetchImpl(executeUrl, {
          method: 'POST',
          headers: this.buildPaidHeaders(payment, state.idempotency_key),
          body: JSON.stringify(requestBody),
        });

        const payload = await safeJson(paidResponse);
        mergeExecutionEvidence(state, payload, paidResponse);
        await this.reconcile(state);

        if (paidResponse.ok) {
          addEvent(
            state,
            hasTerminalReceiptEvidence(state) ? 'reconciled' : 'succeeded',
            `paid response ${paidResponse.status}`
          );
          await this.executionStore.save(state);
          return this.buildSuccessResult(state, payload);
        }

        const decision = this.shouldRetry({ response: paidResponse, state: cloneJson(state) });
        if (!decision.retry || state.attempt_count >= this.maxAttempts) {
          state.last_error = `paid execute failed with HTTP ${paidResponse.status}`;
          addEvent(state, 'failed', state.last_error);
          await this.executionStore.save(state);
          throw new FinalExecutionError(state.last_error, state);
        }

        addEvent(state, 'awaiting_reconciliation', decision.reason || 'retry requested after paid response');
        await this.executionStore.save(state);
      } catch (error) {
        state.last_error = error instanceof Error ? error.message : String(error);
        await this.reconcile(state);

        if (error instanceof FinalExecutionError) {
          addEvent(state, 'failed', state.last_error);
          await this.executionStore.save(state);
          throw error;
        }

        const decision = this.shouldRetry({ error, state: cloneJson(state) });
        if (!decision.retry || state.attempt_count >= this.maxAttempts) {
          addEvent(state, 'failed', state.last_error);
          await this.executionStore.save(state);
          throw new Error(`${state.last_error}; session_id=${state.session_id}`);
        }

        addEvent(state, 'awaiting_reconciliation', `${decision.reason || 'retry requested'}; retrying`);
        await this.executionStore.save(state);
      }
    }

    state.last_error = `exhausted ${this.maxAttempts} attempts without terminal settlement evidence`;
    addEvent(state, 'failed', state.last_error);
    await this.executionStore.save(state);
    throw new Error(`${state.last_error}; session_id=${state.session_id}`);
  }

  async getState(sessionId) {
    return this.executionStore.load(sessionId);
  }

  checklist(stateOrResult) {
    const state = stateOrResult && stateOrResult.state ? stateOrResult.state : stateOrResult;
    if (!state) {
      throw new Error('state is required');
    }

    const checks = [
      makeCheck('session_id', Boolean(state.session_id), state.session_id),
      makeCheck('quote_id', Boolean(state.quote_id), state.quote_id),
      makeCheck('idempotency_key', Boolean(state.idempotency_key), state.idempotency_key),
      makeCheck('saw_402_or_direct_success', state.attempt_count > 0, state.last_http_status),
      makeCheck('payment_required_header', Boolean(state.payment_required_header), state.payment_required_header),
      makeCheck('wallet_receipt', Boolean(state.wallet_receipt), state.wallet_receipt),
      makeCheck('payment_receipt_header', Boolean(state.payment_receipt_header), state.payment_receipt_header),
      makeCheck('payment_response_header', Boolean(state.payment_response_header), state.payment_response_header),
      makeCheck('receipt_id', Boolean(state.receipt_id), state.receipt_id),
      makeCheck('invocation_id', Boolean(state.invocation_id), state.invocation_id),
      makeCheck('retry_happened_after_payment',
        state.timeline.some((entry) => entry.phase === 'retrying_paid_request'),
        state.timeline.filter((entry) => entry.phase === 'retrying_paid_request').length
      ),
      makeCheck(
        'terminal_receipt_or_proof',
        hasTerminalReceiptEvidence(state),
        state.receipt_snapshot?.status ||
          state.receipt_snapshot?.settlement ||
          state.proof_snapshot?.on_chain?.status ||
          state.proof_snapshot?.status ||
          null
      ),
    ];

    return {
      ok: checks.every((entry) => entry.ok),
      checks,
    };
  }

  buildSuccessResult(state, payload) {
    return {
      ok: true,
      state: cloneJson(state),
      response: {
        ...payload,
        payment_receipt: state.payment_receipt_header,
        payment_response: state.payment_response_header,
        wallet_receipt: state.wallet_receipt,
      },
      receipt: state.receipt_snapshot,
      proof: state.proof_snapshot,
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

  buildPaidHeaders(payment, idempotencyKey) {
    const headers = this.buildExecuteHeaders(idempotencyKey);
    if (payment.authorizationHeader) headers.Authorization = payment.authorizationHeader;
    if (payment.paymentSignature) headers['PAYMENT-SIGNATURE'] = payment.paymentSignature;
    if (payment.paymentId) headers['PAYMENT-ID'] = payment.paymentId;
    return headers;
  }

  async reconcile(state) {
    if (state.receipt_id && this.apiKey) {
      const receipt = await this.fetchReceipt(state.receipt_id);
      if (receipt) {
        state.receipt_snapshot = receipt;
        if (isTerminalStatus(receipt.status || receipt.settlement || receipt.payment?.settlement_status)) {
          addEvent(state, 'reconciled', `receipt ${state.receipt_id} reconciled`);
          await this.executionStore.save(state);
          return;
        }
      }
    }

    if (state.invocation_id) {
      const proof = await this.fetchProof(state.invocation_id);
      if (proof) {
        state.proof_snapshot = proof;
        if (isTerminalStatus(proof.on_chain?.status || proof.status)) {
          addEvent(state, 'reconciled', `proof ${state.invocation_id} verified`);
          await this.executionStore.save(state);
          return;
        }
      }
    }

    for (let index = 0; index < this.reconcilePolls; index += 1) {
      if (state.receipt_id && this.apiKey) {
        const receipt = await this.fetchReceipt(state.receipt_id);
        if (receipt) {
          state.receipt_snapshot = receipt;
          if (isTerminalStatus(receipt.status || receipt.settlement || receipt.payment?.settlement_status)) {
            addEvent(state, 'reconciled', `receipt ${state.receipt_id} settled after poll ${index + 1}`);
            await this.executionStore.save(state);
            return;
          }
        }
      }

      if (state.invocation_id) {
        const proof = await this.fetchProof(state.invocation_id);
        if (proof) {
          state.proof_snapshot = proof;
          if (isTerminalStatus(proof.on_chain?.status || proof.status)) {
            addEvent(state, 'reconciled', `proof ${state.invocation_id} verified after poll ${index + 1}`);
            await this.executionStore.save(state);
            return;
          }
        }
      }

      if (index < this.reconcilePolls - 1) {
        await sleep(this.reconcileDelayMs);
      }
    }
  }

  async fetchReceipt(receiptId) {
    try {
      const response = await this.fetchImpl(
        `${this.baseUrl}${fillTemplate(this.receiptPathTemplate, { receiptId: encodeURIComponent(receiptId) })}`,
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
        `${this.baseUrl}${fillTemplate(this.proofPathTemplate, { invocationId: encodeURIComponent(invocationId) })}`,
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
    idempotency_key: input.idempotencyKey || `${input.quoteId}:${Date.now()}`,
    attempt_count: 0,
    phase: 'created',
    last_http_status: null,
    invocation_id: null,
    receipt_id: null,
    payment_required_header: null,
    payment_receipt_header: null,
    payment_response_header: null,
    wallet_receipt: null,
    payment_authorization: null,
    receipt_snapshot: null,
    proof_snapshot: null,
    result_snapshot: null,
    last_error: null,
    timeline: [{ at: new Date().toISOString(), phase: 'created', note: 'state initialized' }],
  };
}

function mergeExecutionEvidence(state, payload, response) {
  state.last_http_status = response.status;
  state.result_snapshot = payload;
  state.invocation_id = payload.invocation_id || payload.invocation?.id || state.invocation_id;
  state.payment_receipt_header = getHeader(response.headers, 'payment-receipt');
  state.payment_response_header = getHeader(response.headers, 'payment-response');
  state.receipt_id = extractReceiptId(state.payment_receipt_header, payload) || state.receipt_id;
}

function extractReceiptId(rawHeader, payload) {
  const direct = payload?.receipt_id || payload?.receipt?.receipt_id || payload?.receipt?.id;
  if (typeof direct === 'string' && direct.length > 0) return direct;
  if (!rawHeader) return null;

  const parsed = parseLooseJson(rawHeader) || decodeBase64Json(rawHeader);
  const nested = parsed?.receipt_id || parsed?.id || parsed?.receipt?.receipt_id;
  if (typeof nested === 'string' && nested.length > 0) return nested;

  const match = String(rawHeader).match(/(rcpt_[A-Za-z0-9_-]+|receipt_[A-Za-z0-9_-]+)/i);
  if (match) return match[1];

  try {
    const url = new URL(rawHeader);
    const parts = url.pathname.split('/').filter(Boolean);
    return parts[parts.length - 1] || null;
  } catch {
    return String(rawHeader).trim() || null;
  }
}

function addEvent(state, phase, note) {
  state.phase = phase;
  state.timeline.push({
    at: new Date().toISOString(),
    phase,
    note,
  });
}

function hasTerminalReceiptEvidence(state) {
  return isTerminalStatus(
    state.receipt_snapshot?.status ||
      state.receipt_snapshot?.settlement ||
      state.receipt_snapshot?.payment?.settlement_status
  ) || isTerminalStatus(state.proof_snapshot?.on_chain?.status || state.proof_snapshot?.status);
}

function isTerminalStatus(status) {
  // 'submitted' is intentionally NOT terminal: an on-chain tx that is broadcast but not
  // yet confirmed is not settled, so it must not pass as terminal settlement evidence.
  return typeof status === 'string'
    && ['settled', 'completed', 'verified', 'succeeded'].includes(status.toLowerCase());
}

function defaultRetryDecision({ response, error }) {
  if (response && isRetryableStatus(response.status)) {
    return { retry: true, reason: `retryable HTTP ${response.status}` };
  }
  if (error) {
    return { retry: true, reason: 'transient paid execution error' };
  }
  return { retry: false, reason: 'non-retryable result' };
}

function isRetryableStatus(status) {
  return status === 408 || status === 409 || status === 425 || status === 429 || status >= 500;
}

function buildQuery(params) {
  const query = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value === undefined || value === null || value === '') continue;
    query.set(key, String(value));
  }
  const rendered = query.toString();
  return rendered ? `?${rendered}` : '';
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
  if (!headers || typeof headers.get !== 'function') return null;
  return headers.get(name) || headers.get(name.toLowerCase()) || headers.get(name.toUpperCase());
}

function parseLooseJson(value) {
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}

function decodeBase64Json(value) {
  try {
    return JSON.parse(Buffer.from(String(value), 'base64').toString('utf8'));
  } catch {
    return null;
  }
}

function fillTemplate(template, values) {
  return template.replace(/\{([^}]+)\}/g, (_, key) => values[key] || '');
}

function stripTrailingSlash(value) {
  return String(value).replace(/\/$/, '');
}

function generateSessionId() {
  if (globalThis.crypto && typeof globalThis.crypto.randomUUID === 'function') {
    return `x402_${globalThis.crypto.randomUUID()}`;
  }
  return `x402_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`;
}

function positiveInt(value, fallback) {
  return Number.isInteger(value) && value > 0 ? value : fallback;
}

function nonNegativeInt(value, fallback) {
  return Number.isInteger(value) && value >= 0 ? value : fallback;
}

function cloneJson(value) {
  return JSON.parse(JSON.stringify(value));
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function makeCheck(name, ok, evidence) {
  return { name, ok: Boolean(ok), evidence: evidence ?? null };
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
  const calls = [];
  let receiptPolls = 0;
  let paidAttemptCount = 0;

  const fetchImpl = async (url, options = {}) => {
    const method = options.method || 'GET';
    calls.push({
      url,
      method,
      headers: cloneJson(options.headers || {}),
    });

    if (url.includes('/api/x402/execute/match')) {
      return jsonResponse(200, {
        quote_id: 'quote_threews_demo',
        tool: 'three.ws.browser.run',
        price: { amount: '2500', asset: 'USDC' },
      });
    }

    if (url.endsWith('/api/x402/execute') && method === 'POST') {
      const headers = options.headers || {};
      const hasPayment = Boolean(
        (typeof headers.Authorization === 'string' && headers.Authorization.startsWith('Bearer paid:'))
          || headers['PAYMENT-SIGNATURE']
      );

      if (!hasPayment) {
        return jsonResponse(
          402,
          { error: 'payment required', quote_id: 'quote_threews_demo' },
          { 'payment-required': 'x402-demo-challenge' }
        );
      }

      paidAttemptCount += 1;
      if (paidAttemptCount === 1) {
        return jsonResponse(
          503,
          { error: 'temporary upstream failure', invocation_id: 'inv_threews_demo', receipt_id: 'rcpt_threews_demo' },
          {
            'payment-receipt': JSON.stringify({ receipt_id: 'rcpt_threews_demo' }),
            'payment-response': JSON.stringify({ status: 'accepted' }),
          }
        );
      }

      return jsonResponse(
        200,
        {
          ok: true,
          invocation_id: 'inv_threews_demo',
          receipt_id: 'rcpt_threews_demo',
          output: { browser_run_id: 'run_123', status: 'completed' },
        },
        {
          'payment-receipt': JSON.stringify({ receipt_id: 'rcpt_threews_demo' }),
          'payment-response': JSON.stringify({ status: 'accepted' }),
        }
      );
    }

    if (url.includes('/api/commerce/receipts/rcpt_threews_demo')) {
      receiptPolls += 1;
      return jsonResponse(200, {
        id: 'rcpt_threews_demo',
        status: receiptPolls >= 2 ? 'settled' : 'pending',
        amount: '2500',
        asset: 'USDC',
      });
    }

    if (url.includes('/api/x402/invocations/inv_threews_demo/proof')) {
      return jsonResponse(200, {
        invocation_id: 'inv_threews_demo',
        on_chain: { status: receiptPolls >= 2 ? 'verified' : 'pending' },
      });
    }

    return jsonResponse(404, { error: `unhandled URL ${url}` });
  };

  const adapter = new ThreeWsX402Adapter({
    baseUrl: 'https://demo.three.ws',
    apiKey: 'demo_api_key',
    fetchImpl,
    reconcileDelayMs: 1,
    payChallenge: async (paymentRequired, request) => ({
      authorizationHeader: `Bearer paid:${paymentRequired}:${request.sessionId}`,
      paymentSignature: `sig:${request.idempotencyKey}`,
      paymentId: `pay_${request.attempt}`,
      receipt: {
        provider: 'demo-wallet',
        challenge: paymentRequired,
        session_id: request.sessionId,
      },
    }),
  });

  const quote = await adapter.preview('browser automation', { provider: 'three.ws' });
  if (quote.quote_id !== 'quote_threews_demo') {
    throw new Error(`unexpected quote: ${JSON.stringify(quote)}`);
  }

  const result = await adapter.execute({
    quoteId: quote.quote_id,
    input: { url: 'https://example.com', action: 'screenshot' },
    metadata: { buyer: 'demo' },
    sessionId: 'session_threews_demo',
    idempotencyKey: 'idempo_threews_demo',
  });

  if (!result.ok) {
    throw new Error('expected ok result');
  }
  if (!result.checklist.ok) {
    throw new Error(`expected passing checklist: ${JSON.stringify(result.checklist)}`);
  }
  if (!result.state.timeline.some((entry) => entry.phase === 'retrying_paid_request')) {
    throw new Error('expected retrying_paid_request in timeline');
  }
  if (paidAttemptCount < 2) {
    throw new Error('expected at least one paid retry');
  }

  console.log(JSON.stringify({
    preview: quote,
    checklist: result.checklist,
    response: result.response,
    receipt: result.receipt,
    proof: result.proof,
    timeline: result.state.timeline,
    call_count: calls.length,
  }, null, 2));
}

module.exports = {
  ThreeWsX402Adapter,
  MemoryExecutionStore,
  FinalExecutionError,
};

if (require.main === module) {
  demo().catch((error) => {
    console.error(error && error.stack ? error.stack : String(error));
    process.exitCode = 1;
  });
}