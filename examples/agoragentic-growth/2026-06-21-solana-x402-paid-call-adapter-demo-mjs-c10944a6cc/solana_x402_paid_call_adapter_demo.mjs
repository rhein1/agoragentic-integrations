// demo — moves no real funds.

import http from 'node:http';
import assert from 'node:assert/strict';
import { createHmac, randomUUID, timingSafeEqual } from 'node:crypto';
import { pathToFileURL } from 'node:url';

const RETRYABLE_STATUS = new Set([408, 425, 429, 500, 502, 503, 504]);
const DEMO_SECRET = 'demo-x402-secret';
const DEMO_VERSION = '0.2';

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isRetryableNetworkError(error) {
  if (!error) return false;
  const code = error.code || error.cause?.code;
  return ['ECONNRESET', 'ECONNREFUSED', 'EAI_AGAIN', 'ETIMEDOUT', 'UND_ERR_CONNECT_TIMEOUT'].includes(code);
}

function normalizeHeaders(headersLike = {}) {
  const out = {};
  if (headersLike instanceof Headers) {
    for (const [key, value] of headersLike.entries()) out[key.toLowerCase()] = value;
    return out;
  }
  for (const [key, value] of Object.entries(headersLike)) {
    out[String(key).toLowerCase()] = String(value);
  }
  return out;
}

function stableJson(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(',')}}`;
}

function parseMaybeJson(raw) {
  if (!raw) return null;
  try {
    return JSON.parse(raw);
  } catch {
    return raw;
  }
}

async function readRequestBody(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  return Buffer.concat(chunks).toString('utf8');
}

async function parseResponseBody(response) {
  const contentType = response.headers.get('content-type') || '';
  const text = await response.text();
  if (!text) return null;
  if (contentType.includes('application/json')) {
    try {
      return JSON.parse(text);
    } catch (error) {
      return {
        rawBody: text,
        parseError: error.message,
      };
    }
  }
  return text;
}

function createIdempotencyKey(prefix = 'x402-demo') {
  return `${prefix}-${randomUUID()}`;
}

function serializeBody(body, headers) {
  if (body === undefined || body === null) return undefined;
  if (typeof body === 'string' || body instanceof Uint8Array || body instanceof ArrayBuffer) return body;
  const contentType = headers.get('content-type') || '';
  if (!contentType) headers.set('content-type', 'application/json');
  if ((headers.get('content-type') || '').includes('application/json')) return stableJson(body);
  return String(body);
}

function normalizeChallenge(response, body) {
  const payload = typeof body === 'object' && body !== null ? body : {};
  return {
    version: response.headers.get('x402-version') || payload.version || DEMO_VERSION,
    scheme: response.headers.get('x402-scheme') || payload.scheme || 'demo-hmac',
    challengeId: response.headers.get('x402-challenge-id') || payload.challengeId || 'unknown-challenge',
    payTo: response.headers.get('x402-pay-to') || payload.payTo || 'demo://sink',
    amount: response.headers.get('x402-amount') || payload.amount || '0',
    asset: response.headers.get('x402-asset') || payload.asset || 'SOL',
    memo: response.headers.get('x402-memo') || payload.memo || '',
  };
}

function challengeSignatureInput(challenge, idempotencyKey) {
  return [
    challenge.challengeId,
    idempotencyKey,
    challenge.amount,
    challenge.asset,
    challenge.payTo,
    challenge.memo,
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
  const expected = Buffer.from(createDemoPaymentAuthorization({ challenge, idempotencyKey, secret }), 'utf8');
  const actual = Buffer.from(token, 'utf8');
  return expected.length === actual.length && timingSafeEqual(expected, actual);
}

function createCheck(name, ok, evidence, uncertainty = null) {
  return uncertainty ? { name, ok, evidence, uncertainty } : { name, ok, evidence };
}

export class X402PayKitAdapter {
  constructor({
    fetchImpl = globalThis.fetch,
    baseDelayMs = 40,
    maxDelayMs = 400,
    userAgent = 'agoragentic-solana-pay-kit-x402-demo/1.0',
  } = {}) {
    if (typeof fetchImpl !== 'function') {
      throw new Error('A fetch implementation is required (Node 18+ provides global fetch).');
    }
    this.fetchImpl = fetchImpl;
    this.baseDelayMs = baseDelayMs;
    this.maxDelayMs = maxDelayMs;
    this.userAgent = userAgent;
  }

  async authorizePayment({ pay, challenge, idempotencyKey, request, signal }) {
    if (typeof pay !== 'function') {
      throw new Error(
        'A caller-supplied pay callback is required before any payment authorization is created.'
      );
    }
    const result = await pay({ challenge, idempotencyKey, request, signal });
    if (!result || typeof result.token !== 'string' || !result.token) {
      throw new Error('pay() must resolve to an object with a non-empty token string.');
    }
    return {
      scheme: result.scheme || 'X402',
      token: result.token,
      meta: result.meta || null,
      createdAt: new Date().toISOString(),
    };
  }

  buildReceiptChecklist({
    initialChallenge,
    finalResponse,
    finalBody,
    authorization,
    idempotencyKey,
    attempts,
  }) {
    const headers = finalResponse ? normalizeHeaders(finalResponse.headers) : {};
    const body = typeof finalBody === 'object' && finalBody !== null ? finalBody : {};
    const authorizedAttempts = attempts.filter((item) => item.sentAuthorization);
    const authorizationFingerprints = new Set(authorizedAttempts.map((item) => item.authorizationFingerprint));
    const challengeIdEcho = headers['x402-challenge-id'];
    const challengeIdMatches = !initialChallenge || challengeIdEcho === initialChallenge.challengeId;
    const checks = [
      createCheck(
        'initial 402 challenge observed',
        Boolean(initialChallenge),
        initialChallenge
          ? `challengeId=${initialChallenge.challengeId} amount=${initialChallenge.amount} asset=${initialChallenge.asset}`
          : 'no 402 challenge captured'
      ),
      createCheck(
        'caller-supplied authorization used',
        Boolean(authorization?.token),
        authorization ? `scheme=${authorization.scheme} token_prefix=${authorization.token.slice(0, 18)}` : 'missing authorization'
      ),
      createCheck(
        'same idempotency key sent across attempts',
        attempts.length > 0 && attempts.every((item) => item.idempotencyKey === idempotencyKey),
        attempts.map((item) => item.idempotencyKey).join(', ') || 'no attempts logged'
      ),
      createCheck(
        'authorization reused after transient failure instead of repaying',
        authorizedAttempts.length <= 1 || authorizationFingerprints.size === 1,
        authorizedAttempts
          .map((item) => `${item.kind}:${item.status ?? 'network'}:${item.authorizationFingerprint}`)
          .join(' | ') || 'no post-payment retry required',
        authorizedAttempts.length <= 1 ? 'No transient post-payment retry occurred; reuse was not required.' : null
      ),
      createCheck(
        'final response is success',
        Boolean(finalResponse?.ok),
        finalResponse ? `status=${finalResponse.status}` : 'no final response'
      ),
      createCheck(
        'server echoed receipt identifiers for the paid challenge',
        Boolean(headers['x402-receipt-id'] && challengeIdEcho && challengeIdMatches),
        `x402-receipt-id=${headers['x402-receipt-id'] || 'missing'}, x402-challenge-id=${challengeIdEcho || 'missing'}, expected=${initialChallenge?.challengeId || 'none'}`,
        'This only checks HTTP evidence returned by the server; it does not imply on-chain settlement.'
      ),
      createCheck(
        'server receipt idempotency matches request key',
        headers['x-idempotency-key'] === idempotencyKey || body.idempotencyKey === idempotencyKey,
        `header=${headers['x-idempotency-key'] || 'missing'}, body=${body.idempotencyKey || 'missing'}`
      ),
    ];
    return {
      passed: checks.every((check) => check.ok),
      checks,
    };
  }

  async execute({
    url,
    method = 'POST',
    headers = {},
    body,
    pay,
    idempotencyKey = createIdempotencyKey(),
    maxAttempts = 5,
    signal,
  }) {
    if (!url) throw new Error('url is required.');
    if (maxAttempts < 2) throw new Error('maxAttempts must be at least 2.');

    let authorization = null;
    let initialChallenge = null;
    let lastError = null;
    const attempts = [];

    for (let attemptNumber = 1; attemptNumber <= maxAttempts; attemptNumber += 1) {
      const requestHeaders = new Headers(headers);
      if (!requestHeaders.has('accept')) requestHeaders.set('accept', 'application/json');
      requestHeaders.set('x-idempotency-key', idempotencyKey);
      requestHeaders.set('x402-client', this.userAgent);

      if (authorization) {
        requestHeaders.set('authorization', `${authorization.scheme} ${authorization.token}`);
        requestHeaders.set('PAYMENT-SIGNATURE', authorization.token);
      }

      const serializedBody = serializeBody(body, requestHeaders);
      const authorizationFingerprint = authorization
        ? `${authorization.scheme}:${authorization.token.slice(0, 16)}`
        : null;

      try {
        const response = await this.fetchImpl(url, {
          method,
          headers: requestHeaders,
          body: serializedBody,
          signal,
        });

        const responseBody = await parseResponseBody(response);
        attempts.push({
          attempt: attemptNumber,
          kind: 'http',
          status: response.status,
          idempotencyKey,
          sentAuthorization: Boolean(authorization),
          authorizationFingerprint,
        });

        if (response.status === 402) {
          if (authorization) {
            const error = new Error('server returned 402 after payment authorization was already sent');
            error.result = {
              ok: false,
              status: response.status,
              data: responseBody,
              headers: normalizeHeaders(response.headers),
              authorization,
              idempotencyKey,
              attempts,
            };
            throw error;
          }
          const challenge = normalizeChallenge(response, responseBody);
          if (!initialChallenge) initialChallenge = challenge;
          authorization = await this.authorizePayment({
            pay,
            challenge,
            idempotencyKey,
            request: { url, method, headers: normalizeHeaders(requestHeaders), body },
            signal,
          });
          lastError = new Error(`HTTP 402 payment required for challenge ${challenge.challengeId}`);
          continue;
        }

        if (RETRYABLE_STATUS.has(response.status) && attemptNumber < maxAttempts) {
          lastError = new Error(`HTTP ${response.status} retryable error`);
          await sleep(Math.min(this.baseDelayMs * 2 ** (attemptNumber - 1), this.maxDelayMs));
          continue;
        }

        const receiptChecklist = this.buildReceiptChecklist({
          initialChallenge,
          finalResponse: response,
          finalBody: responseBody,
          authorization,
          idempotencyKey,
          attempts,
        });

        if (!response.ok) {
          const error = new Error(`HTTP ${response.status}`);
          error.result = {
            ok: false,
            status: response.status,
            data: responseBody,
            headers: normalizeHeaders(response.headers),
            authorization,
            idempotencyKey,
            attempts,
            receiptChecklist,
          };
          throw error;
        }

        return {
          ok: true,
          status: response.status,
          data: responseBody,
          headers: normalizeHeaders(response.headers),
          authorization,
          idempotencyKey,
          attempts,
          receiptChecklist,
        };
      } catch (error) {
        if (error.result) {
          throw error;
        }
        const retryable = isRetryableNetworkError(error);
        attempts.push({
          attempt: attemptNumber,
          kind: 'network-error',
          status: null,
          error: error.message,
          idempotencyKey,
          sentAuthorization: Boolean(authorization),
          authorizationFingerprint,
        });
        lastError = error;
        if (!retryable || attemptNumber >= maxAttempts) throw error;
        await sleep(Math.min(this.baseDelayMs * 2 ** (attemptNumber - 1), this.maxDelayMs));
      }
    }

    throw lastError || new Error('x402 execute() exhausted retries.');
  }
}

export async function startDemoServer({ secret = DEMO_SECRET } = {}) {
  const callState = new Map();

  const server = http.createServer(async (req, res) => {
    try {
      if (req.url !== '/paid-call') {
        res.writeHead(404, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: 'not_found' }));
        return;
      }

      const idempotencyKey = String(req.headers['x-idempotency-key'] || '');
      if (!idempotencyKey) {
        res.writeHead(400, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: 'missing_idempotency_key' }));
        return;
      }

      const bodyText = await readRequestBody(req);
      const body = parseMaybeJson(bodyText) || {};
      const state = callState.get(idempotencyKey) || {
        challengeId: `challenge-${randomUUID()}`,
        payTo: 'demo://merchant/solana-foundation/pay-kit',
        amount: '2500',
        asset: 'lamports',
        memo: 'demo-paid-call',
        paidAttempts: 0,
      };
      callState.set(idempotencyKey, state);

      const challenge = {
        version: DEMO_VERSION,
        scheme: 'demo-hmac',
        challengeId: state.challengeId,
        payTo: state.payTo,
        amount: state.amount,
        asset: state.asset,
        memo: state.memo,
      };

      const authHeader = String(req.headers.authorization || '');
      const signatureHeader = String(req.headers['payment-signature'] || '');
      const token = signatureHeader || (authHeader.startsWith('X402 ') ? authHeader.slice(5) : '');

      if (!token) {
        res.writeHead(402, {
          'content-type': 'application/json',
          'x402-version': challenge.version,
          'x402-scheme': challenge.scheme,
          'x402-challenge-id': challenge.challengeId,
          'x402-pay-to': challenge.payTo,
          'x402-amount': challenge.amount,
          'x402-asset': challenge.asset,
          'x402-memo': challenge.memo,
        });
        res.end(JSON.stringify({
          error: 'payment_required',
          ...challenge,
        }));
        return;
      }

      if (!verifyDemoPaymentAuthorization({ token, challenge, idempotencyKey, secret })) {
        res.writeHead(402, {
          'content-type': 'application/json',
          'x402-version': challenge.version,
          'x402-scheme': challenge.scheme,
          'x402-challenge-id': challenge.challengeId,
          'x402-pay-to': challenge.payTo,
          'x402-amount': challenge.amount,
          'x402-asset': challenge.asset,
          'x402-memo': challenge.memo,
        });
        res.end(JSON.stringify({
          error: 'invalid_payment_authorization',
          ...challenge,
        }));
        return;
      }

      state.paidAttempts += 1;
      callState.set(idempotencyKey, state);

      if (state.paidAttempts === 1) {
        res.writeHead(503, {
          'content-type': 'application/json',
          'retry-after': '0',
          'x-idempotency-key': idempotencyKey,
          'x402-challenge-id': challenge.challengeId,
        });
        res.end(JSON.stringify({
          error: 'transient_upstream_failure',
          message: 'retry with the same authorization and idempotency key',
        }));
        return;
      }

      res.writeHead(200, {
        'content-type': 'application/json',
        'x402-version': challenge.version,
        'x402-receipt-id': `receipt-${randomUUID()}`,
        'x402-challenge-id': challenge.challengeId,
        'x-idempotency-key': idempotencyKey,
      });
      res.end(JSON.stringify({
        ok: true,
        item: 'paid-resource',
        settled: false,
        idempotencyKey,
        requestBody: body,
        note: 'demo server accepted the payment authorization and fulfilled the request',
      }));
    } catch (error) {
      res.writeHead(500, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: 'server_error', message: error.message }));
    }
  });

  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  const baseUrl = `http://127.0.0.1:${address.port}`;
  return {
    baseUrl,
    close: () => new Promise((resolve, reject) => server.close((err) => (err ? reject(err) : resolve()))),
  };
}

export async function demo() {
  const demoServer = await startDemoServer();
  const adapter = new X402PayKitAdapter();
  const payInvocations = [];

  try {
    const result = await adapter.execute({
      url: `${demoServer.baseUrl}/paid-call`,
      method: 'POST',
      body: { sku: 'pro-checkout', quantity: 1 },
      pay: async ({ challenge, idempotencyKey }) => {
        payInvocations.push({ challengeId: challenge.challengeId, idempotencyKey });
        return {
          scheme: 'X402',
          token: createDemoPaymentAuthorization({ challenge, idempotencyKey }),
          meta: { demo: true },
        };
      },
    });

    assert.equal(result.ok, true);
    assert.equal(result.status, 200);
    assert.equal(result.data.ok, true);
    assert.equal(payInvocations.length, 1, 'payment authorization should be created exactly once');
    assert.deepEqual(
      result.attempts.filter((entry) => entry.kind === 'http').map((entry) => entry.status),
      [402, 503, 200],
      'expected 402 challenge, transient retry, then success'
    );
    assert.equal(result.receiptChecklist.passed, true);

    console.log(JSON.stringify({
      demo: 'x402 execute() retry with receipt checklist',
      payInvocations,
      attempts: result.attempts,
      receiptChecklist: result.receiptChecklist,
      response: result.data,
    }, null, 2));
  } finally {
    await demoServer.close();
  }
}

async function runEdgeCaseAssertions() {
  const challenge = {
    challengeId: 'challenge-single-success',
    amount: '2500',
    asset: 'lamports',
    payTo: 'demo://merchant/solana-foundation/pay-kit',
    memo: 'single-success',
  };

  let call = 0;
  const singleSuccessAdapter = new X402PayKitAdapter({
    fetchImpl: async (url, request) => {
      call += 1;
      assert.equal(request.headers.get('x-idempotency-key'), 'idem-single-success');
      if (call === 1) {
        return new Response(JSON.stringify({ error: 'payment_required', ...challenge }), {
          status: 402,
          headers: { 'content-type': 'application/json', 'x402-challenge-id': challenge.challengeId },
        });
      }
      assert.equal(request.headers.get('PAYMENT-SIGNATURE'), 'single-success-token');
      return new Response(JSON.stringify({ ok: true, idempotencyKey: 'idem-single-success' }), {
        status: 200,
        headers: {
          'content-type': 'application/json',
          'x402-receipt-id': 'receipt-single-success',
          'x402-challenge-id': challenge.challengeId,
          'x-idempotency-key': 'idem-single-success',
        },
      });
    },
  });
  const singleSuccess = await singleSuccessAdapter.execute({
    url: 'https://example.invalid/paid-call',
    idempotencyKey: 'idem-single-success',
    body: { sku: 'demo' },
    pay: async () => ({ scheme: 'X402', token: 'single-success-token' }),
  });
  assert.equal(singleSuccess.receiptChecklist.passed, true);
  assert.equal(singleSuccess.attempts.filter((entry) => entry.sentAuthorization).length, 1);

  let repeated402Calls = 0;
  const repeated402Adapter = new X402PayKitAdapter({
    fetchImpl: async () => {
      repeated402Calls += 1;
      return new Response(JSON.stringify({ error: 'payment_required', ...challenge }), {
        status: 402,
        headers: { 'content-type': 'application/json', 'x402-challenge-id': challenge.challengeId },
      });
    },
  });
  await assert.rejects(
    repeated402Adapter.execute({
      url: 'https://example.invalid/paid-call',
      idempotencyKey: 'idem-repeat-402',
      body: { sku: 'demo' },
      pay: async () => ({ scheme: 'X402', token: 'repeat-token' }),
    }),
    /after payment authorization/
  );
  assert.equal(repeated402Calls, 2);

  let malformedRetryCalls = 0;
  const malformedRetryAdapter = new X402PayKitAdapter({
    fetchImpl: async () => {
      malformedRetryCalls += 1;
      if (malformedRetryCalls === 1) {
        return new Response('{not-json', {
          status: 503,
          headers: { 'content-type': 'application/json' },
        });
      }
      return new Response(JSON.stringify({ ok: true, idempotencyKey: 'idem-malformed-retry' }), {
        status: 200,
        headers: { 'content-type': 'application/json', 'x-idempotency-key': 'idem-malformed-retry' },
      });
    },
  });
  const malformedRetryResult = await malformedRetryAdapter.execute({
    url: 'https://example.invalid/paid-call',
    idempotencyKey: 'idem-malformed-retry',
    body: { sku: 'demo' },
  });
  assert.equal(malformedRetryResult.status, 200);
  assert.equal(malformedRetryCalls, 2);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  runEdgeCaseAssertions()
    .then(() => demo())
    .catch((error) => {
    console.error(error.stack || error.message);
    process.exitCode = 1;
  });
}
