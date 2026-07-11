// demo — moves no real funds.
// Terminology: gpt-5.6-sol is a model identifier; Solana is the network; SOL is its native token; lamports are SOL's smallest unit.

import assert from 'node:assert/strict';
import { createHmac, randomUUID, timingSafeEqual } from 'node:crypto';
import { pathToFileURL } from 'node:url';

const DEMO_SECRET = 'demo-x402-secret';
const DEMO_VERSION = '0.3';

function normalizeHeaders(headersLike = {}) {
  if (headersLike instanceof Headers) {
    return Object.fromEntries([...headersLike.entries()].map(([k, v]) => [k.toLowerCase(), String(v)]));
  }
  if (Array.isArray(headersLike)) {
    return Object.fromEntries(headersLike.map(([k, v]) => [String(k).toLowerCase(), String(v)]));
  }
  return Object.fromEntries(Object.entries(headersLike).map(([k, v]) => [String(k).toLowerCase(), String(v)]));
}

function createAmbiguousPaidOutcome(message, details = {}) {
  const error = new Error(message);
  error.name = 'AmbiguousPaidOutcomeError';
  Object.assign(error, {
    ambiguousOutcome: true,
    outcomeUnknown: true,
    retryable: false,
    paymentAuthorizationMayHaveBeenConsumed: true,
    nextAction: 'reconcile_receipt_or_settlement',
    ...details,
  });
  return error;
}

function challengeSignatureInput(challenge, idempotencyKey) {
  return [
    challenge.challengeId,
    idempotencyKey,
    challenge.amount_lamports,
    challenge.asset,
    challenge.unit,
    challenge.network,
    challenge.payTo,
  ].join('|');
}

export function createDemoPaymentAuthorization({ challenge, idempotencyKey, secret = DEMO_SECRET }) {
  const mac = createHmac('sha256', secret)
    .update(challengeSignatureInput(challenge, idempotencyKey))
    .digest('hex');
  return `demo-hmac:${mac}`;
}

export function verifyDemoPaymentAuthorization({ token, challenge, idempotencyKey, secret = DEMO_SECRET }) {
  if (typeof token !== 'string' || !token.startsWith('demo-hmac:')) return false;
  const expected = Buffer.from(createDemoPaymentAuthorization({ challenge, idempotencyKey, secret }));
  const actual = Buffer.from(token);
  return expected.length === actual.length && timingSafeEqual(expected, actual);
}

function normalizeChallenge(response, payload = {}) {
  return {
    version: response.headers.get('x402-version') || payload.version || DEMO_VERSION,
    scheme: response.headers.get('x402-scheme') || payload.scheme || 'demo-hmac',
    challengeId: response.headers.get('x402-challenge-id') || payload.challengeId,
    network: response.headers.get('x402-network') || payload.network || 'solana',
    asset: response.headers.get('x402-asset') || payload.asset || 'SOL',
    unit: response.headers.get('x402-unit') || payload.unit || 'lamports',
    amount_lamports: response.headers.get('x402-amount-lamports') || payload.amount_lamports,
    payTo: response.headers.get('x402-pay-to') || payload.payTo,
  };
}

async function readJson(response) {
  const text = await response.text();
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch (cause) {
    const error = new Error('response body is not valid JSON');
    error.cause = cause;
    throw error;
  }
}

function isRedirect(status) {
  return status >= 300 && status < 400;
}

export class SolanaX402DemoClient {
  constructor({ fetchImpl = globalThis.fetch } = {}) {
    if (typeof fetchImpl !== 'function') throw new Error('fetchImpl is required');
    this.fetchImpl = fetchImpl;
    this.ambiguousPaymentOutcome = null;
  }

  reconcile({ receiptId = null, settlementStatus = 'unknown' } = {}) {
    if (!this.ambiguousPaymentOutcome) return false;
    if (!receiptId && settlementStatus === 'unknown') {
      throw new Error('reconciliation requires a receipt id or explicit settlement status');
    }
    this.ambiguousPaymentOutcome = null;
    return true;
  }

  async execute({ url, body = {}, pay, idempotencyKey = randomUUID(), signal } = {}) {
    if (!url) throw new Error('url is required');
    if (this.ambiguousPaymentOutcome) {
      throw createAmbiguousPaidOutcome('client is locked after an ambiguous paid outcome', {
        ...this.ambiguousPaymentOutcome,
        blockedByPriorAmbiguousOutcome: true,
      });
    }
    if (typeof pay !== 'function') throw new Error('a caller-supplied pay callback is required');

    const baseHeaders = new Headers({
      accept: 'application/json',
      'content-type': 'application/json',
      'x-idempotency-key': idempotencyKey,
    });
    const requestBody = JSON.stringify(body);

    let challengeResponse;
    try {
      challengeResponse = await this.fetchImpl(url, {
        method: 'POST',
        headers: baseHeaders,
        body: requestBody,
        signal,
        redirect: 'manual',
      });
    } catch (error) {
      throw error;
    }

    if (challengeResponse.status !== 402) {
      return {
        ok: challengeResponse.ok,
        status: challengeResponse.status,
        payload: await readJson(challengeResponse),
        paymentAttempted: false,
        idempotencyKey,
      };
    }

    const challengePayload = await readJson(challengeResponse);
    const challenge = normalizeChallenge(challengeResponse, challengePayload);
    if (!challenge.challengeId || !challenge.amount_lamports || !challenge.payTo) {
      throw new Error('incomplete Solana x402 challenge');
    }
    if (challenge.network !== 'solana' || challenge.asset !== 'SOL' || challenge.unit !== 'lamports') {
      throw new Error('unsupported or ambiguous Solana asset/unit tuple');
    }

    const authorization = await pay({ challenge, idempotencyKey, signal });
    if (!authorization || typeof authorization.token !== 'string' || !authorization.token) {
      throw new Error('pay() must return a non-empty token');
    }

    const signedHeaders = new Headers(baseHeaders);
    signedHeaders.set('authorization', `${authorization.scheme || 'X402'} ${authorization.token}`);
    signedHeaders.set('payment-signature', authorization.token);

    let paidResponse;
    try {
      paidResponse = await this.fetchImpl(url, {
        method: 'POST',
        headers: signedHeaders,
        body: requestBody,
        signal,
        redirect: 'manual',
      });
    } catch (cause) {
      const error = createAmbiguousPaidOutcome('paid execute outcome is unknown after network loss', {
        cause,
        idempotencyKey,
        challengeId: challenge.challengeId,
        signedRequestAttempts: 1,
      });
      this.ambiguousPaymentOutcome = { idempotencyKey, challengeId: challenge.challengeId, signedRequestAttempts: 1 };
      throw error;
    }

    if (paidResponse.status === 402 || isRedirect(paidResponse.status) || !paidResponse.ok) {
      const error = createAmbiguousPaidOutcome(`paid execute returned HTTP ${paidResponse.status}`, {
        status: paidResponse.status,
        idempotencyKey,
        challengeId: challenge.challengeId,
        signedRequestAttempts: 1,
      });
      this.ambiguousPaymentOutcome = { idempotencyKey, challengeId: challenge.challengeId, status: paidResponse.status, signedRequestAttempts: 1 };
      throw error;
    }

    let payload;
    try {
      payload = await readJson(paidResponse);
    } catch (cause) {
      const error = createAmbiguousPaidOutcome('paid execute response was unreadable', {
        cause,
        idempotencyKey,
        challengeId: challenge.challengeId,
        signedRequestAttempts: 1,
      });
      this.ambiguousPaymentOutcome = { idempotencyKey, challengeId: challenge.challengeId, signedRequestAttempts: 1 };
      throw error;
    }

    const headers = normalizeHeaders(paidResponse.headers);
    const receiptId = headers['x402-receipt-id'] || payload?.receipt_id || null;
    const echoedChallenge = headers['x402-challenge-id'] || payload?.challenge_id || null;
    const echoedIdempotency = headers['x-idempotency-key'] || payload?.idempotency_key || null;
    const receiptVerified = Boolean(
      receiptId
      && echoedChallenge === challenge.challengeId
      && echoedIdempotency === idempotencyKey
    );

    return {
      ok: true,
      status: paidResponse.status,
      payload,
      paymentAttempted: true,
      paymentAuthorizationsCreated: 1,
      signedRequestAttempts: 1,
      idempotencyKey,
      receipt: {
        id: receiptId,
        verifiedAgainstChallenge: receiptVerified,
        settlementVerified: false,
      },
    };
  }
}

export function createMockSolanaX402Fetch({ mode = 'success', secret = DEMO_SECRET } = {}) {
  const state = { calls: 0, payCalls: 0, idempotencyKeys: [], signedCalls: 0 };
  const challenge = {
    version: DEMO_VERSION,
    scheme: 'demo-hmac',
    challengeId: `challenge-${randomUUID()}`,
    network: 'solana',
    asset: 'SOL',
    unit: 'lamports',
    amount_lamports: '2500',
    payTo: 'demo://merchant/solana',
  };

  const fetchImpl = async (_url, init = {}) => {
    state.calls += 1;
    const headers = new Headers(init.headers);
    const idempotencyKey = headers.get('x-idempotency-key');
    state.idempotencyKeys.push(idempotencyKey);
    const token = headers.get('payment-signature');

    if (!token) {
      return new Response(JSON.stringify({ error: 'payment_required', ...challenge }), {
        status: 402,
        headers: {
          'content-type': 'application/json',
          'x402-version': challenge.version,
          'x402-scheme': challenge.scheme,
          'x402-challenge-id': challenge.challengeId,
          'x402-network': challenge.network,
          'x402-asset': challenge.asset,
          'x402-unit': challenge.unit,
          'x402-amount-lamports': challenge.amount_lamports,
          'x402-pay-to': challenge.payTo,
        },
      });
    }

    state.signedCalls += 1;
    assert.equal(verifyDemoPaymentAuthorization({ token, challenge, idempotencyKey, secret }), true);
    if (mode === 'network-loss') throw Object.assign(new Error('simulated network loss'), { code: 'ECONNRESET' });
    if (mode === 'repeat-402') return new Response(JSON.stringify({ error: 'payment_required' }), { status: 402, headers: { 'content-type': 'application/json' } });
    if (mode === 'http-500') return new Response(JSON.stringify({ error: 'upstream_failure' }), { status: 500, headers: { 'content-type': 'application/json' } });
    if (mode === 'redirect') return new Response('', { status: 307, headers: { location: 'https://example.invalid/other' } });
    if (mode === 'unreadable') return new Response('{not-json', { status: 200, headers: { 'content-type': 'application/json' } });

    return new Response(JSON.stringify({ ok: true, settled: false }), {
      status: 200,
      headers: {
        'content-type': 'application/json',
        'x402-receipt-id': `receipt-${randomUUID()}`,
        'x402-challenge-id': challenge.challengeId,
        'x-idempotency-key': idempotencyKey,
      },
    });
  };

  const pay = async ({ challenge: required, idempotencyKey }) => {
    state.payCalls += 1;
    return {
      scheme: 'X402',
      token: createDemoPaymentAuthorization({ challenge: required, idempotencyKey, secret }),
    };
  };

  return { fetchImpl, pay, state, challenge };
}

export async function demo() {
  const mock = createMockSolanaX402Fetch();
  const client = new SolanaX402DemoClient({ fetchImpl: mock.fetchImpl });
  const result = await client.execute({
    url: 'https://example.invalid/paid-call',
    idempotencyKey: 'idem-solana-demo',
    body: { sku: 'demo' },
    pay: mock.pay,
  });
  assert.equal(result.ok, true);
  assert.equal(result.paymentAuthorizationsCreated, 1);
  assert.equal(result.signedRequestAttempts, 1);
  assert.equal(result.receipt.verifiedAgainstChallenge, true);
  assert.equal(result.receipt.settlementVerified, false);
  assert.equal(mock.state.calls, 2);
  assert.equal(mock.state.payCalls, 1);
  assert.equal(new Set(mock.state.idempotencyKeys).size, 1);
  console.log(JSON.stringify({ demo: 'Solana x402 fail-closed no-funds demo', result }, null, 2));
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  demo().catch((error) => {
    console.error(error.stack || error.message);
    process.exitCode = 1;
  });
}
