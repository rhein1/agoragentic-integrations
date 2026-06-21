#!/usr/bin/env node
// demo — moves no real funds. The bundled server simulates x402 and the default pay() callback signs a demo-only authorization.

import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import http from 'node:http';

const DEMO_PAYMENT_SECRET = 'demo-x402-secret-do-not-use-on-chain';

function nowIso() {
  return new Date().toISOString();
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function sha256(value) {
  return crypto.createHash('sha256').update(String(value)).digest('hex');
}

function randomId(prefix) {
  return `${prefix}_${crypto.randomUUID().replace(/-/g, '')}`;
}

function stableJson(value) {
  if (Array.isArray(value)) {
    return `[${value.map((item) => stableJson(item)).join(',')}]`;
  }
  if (value && typeof value === 'object') {
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`)
      .join(',')}}`;
  }
  return JSON.stringify(value);
}

function paymentChallengeFingerprint(challenge) {
  return sha256(
    stableJson({
      challenge_id: challenge.challenge_id,
      pay_to: challenge.pay_to,
      amount_micro_usdc: challenge.amount_micro_usdc,
      asset: challenge.asset,
      tool: challenge.tool,
      idempotency_key: challenge.idempotency_key,
    }),
  );
}

function createDemoPaymentAuthorization({ challenge, payer = 'demo-buyer' }) {
  const fingerprint = paymentChallengeFingerprint(challenge);
  const signature = crypto
    .createHmac('sha256', DEMO_PAYMENT_SECRET)
    .update(`${fingerprint}:${payer}`)
    .digest('hex');

  return {
    scheme: 'demo-hmac',
    payer,
    challenge_id: challenge.challenge_id,
    authorization: signature,
    fingerprint,
    created_at: nowIso(),
    note: 'demo authorization only; no real wallet signing or settlement',
  };
}

async function readJsonBody(req) {
  const chunks = [];
  for await (const chunk of req) {
    chunks.push(chunk);
  }
  const raw = Buffer.concat(chunks).toString('utf8');
  if (!raw) {
    return {};
  }
  return JSON.parse(raw);
}

function sendJson(res, statusCode, payload, extraHeaders = {}) {
  const body = JSON.stringify(payload, null, 2);
  res.writeHead(statusCode, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(body),
    ...extraHeaders,
  });
  res.end(body);
}

function createExecutionOutput(input) {
  const prompt = String(input.prompt || '');
  const tokenEstimate = prompt.trim() ? prompt.trim().split(/\s+/).length : 0;
  return {
    model: input.model || 'shipyard-inference-demo',
    completion: `shipyard-inference processed ${tokenEstimate} prompt token(s): ${prompt.toUpperCase()}`,
    token_estimate: tokenEstimate,
  };
}

function encodePaymentRequiredHeader(challenge) {
  return Buffer.from(JSON.stringify([challenge]), 'utf8').toString('base64');
}

function decodePaymentRequiredHeader(value) {
  if (!value) {
    return [];
  }
  try {
    const decoded = Buffer.from(String(value), 'base64').toString('utf8');
    const parsed = JSON.parse(decoded);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

async function createDemoShipyardServer({ failPaidAttemptOnce = true } = {}) {
  const executionCache = new Map();
  const paidAttemptCount = new Map();
  const observedAuthorizations = new Map();

  const server = http.createServer(async (req, res) => {
    try {
      if (req.method !== 'POST' || req.url !== '/v1/paid-tools/shipyard-inference') {
        sendJson(res, 404, { error: 'not_found' });
        return;
      }

      const startedAt = Date.now();
      const idempotencyKey = req.headers['x-idempotency-key'];
      if (!idempotencyKey || typeof idempotencyKey !== 'string') {
        sendJson(res, 400, { error: 'missing_x_idempotency_key' });
        return;
      }

      const input = await readJsonBody(req);
      const tool = input.tool || 'shipyard-inference';
      const cached = executionCache.get(idempotencyKey);
      if (cached) {
        sendJson(res, 200, {
          ...cached,
          replayed_from_idempotency_cache: true,
        });
        return;
      }

      const challenge = {
        protocol: 'x402',
        challenge_id: `challenge:${sha256(`${idempotencyKey}:${tool}`).slice(0, 24)}`,
        tool,
        asset: 'USDC',
        network: 'base-sepolia-demo',
        amount_micro_usdc: 250000,
        pay_to: 'demo://shipyard-inference-seller',
        settlement: 'authorization-on-402-retry',
        idempotency_key: idempotencyKey,
        note: 'demo payment challenge; no funds move',
      };

      const presentedAuthorization = req.headers['x-payment-authorization'];
      if (!presentedAuthorization || typeof presentedAuthorization !== 'string') {
        sendJson(
          res,
          402,
          {
            error: 'payment_required',
            challenge,
          },
          {
            'payment-required': encodePaymentRequiredHeader(challenge),
          },
        );
        return;
      }

      const authorizationEnvelope = JSON.parse(
        Buffer.from(presentedAuthorization, 'base64url').toString('utf8'),
      );
      const expected = createDemoPaymentAuthorization({
        challenge,
        payer: authorizationEnvelope.payer,
      });

      if (
        authorizationEnvelope.challenge_id !== expected.challenge_id ||
        authorizationEnvelope.authorization !== expected.authorization ||
        authorizationEnvelope.fingerprint !== expected.fingerprint
      ) {
        sendJson(res, 402, { error: 'invalid_payment_authorization', challenge });
        return;
      }

      const authFingerprint = sha256(presentedAuthorization);
      observedAuthorizations.set(idempotencyKey, authFingerprint);
      const paidAttempts = (paidAttemptCount.get(idempotencyKey) || 0) + 1;
      paidAttemptCount.set(idempotencyKey, paidAttempts);

      if (failPaidAttemptOnce && paidAttempts === 1) {
        sendJson(res, 503, {
          error: 'temporary_executor_unavailable',
          retryable: true,
          detail: 'simulated transient failure after payment authorization',
        });
        return;
      }

      const output = createExecutionOutput(input);
      const invocationId = randomId('invoke');
      const receiptId = randomId('receipt');
      const responsePayload = {
        ok: true,
        invocation_id: invocationId,
        receipt_id: receiptId,
        tool,
        result: output,
        receipt: {
          receipt_id: receiptId,
          invocation_id: invocationId,
          tool,
          pricing: {
            asset: challenge.asset,
            amount_micro_usdc: challenge.amount_micro_usdc,
          },
          payment: {
            mode: 'demo',
            challenge_id: challenge.challenge_id,
            authorization_fingerprint: authFingerprint,
            authorization_reused_on_retry: paidAttempts > 1,
            settled: false,
            note: 'authorization accepted by demo server; no real funds moved',
          },
          governance: {
            idempotency_key: idempotencyKey,
            execution_policy: 'charge_only_on_402_then_retry_with_same_authorization',
          },
          audit: {
            request_hash: sha256(stableJson(input)),
            response_hash: sha256(stableJson(output)),
            elapsed_ms: Date.now() - startedAt,
            created_at: nowIso(),
          },
        },
      };

      executionCache.set(idempotencyKey, responsePayload);
      sendJson(res, 200, responsePayload);
    } catch (error) {
      sendJson(res, 500, {
        error: 'server_error',
        message: error instanceof Error ? error.message : String(error),
      });
    }
  });

  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  const baseUrl = `http://127.0.0.1:${address.port}`;

  return {
    baseUrl,
    close: () =>
      new Promise((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      ),
    inspect: () => ({
      cached_executions: executionCache.size,
      paid_attempt_count: Object.fromEntries(paidAttemptCount),
      observed_authorizations: Object.fromEntries(observedAuthorizations),
    }),
  };
}

class X402PaidToolClient {
  constructor({
    baseUrl,
    pay,
    fetchImpl = globalThis.fetch,
    maxAttempts = 5,
    retryDelayMs = 50,
  }) {
    if (!baseUrl) {
      throw new Error('baseUrl is required');
    }
    if (typeof fetchImpl !== 'function') {
      throw new Error('A fetch implementation is required');
    }
    if (typeof pay !== 'function') {
      throw new Error('pay callback is required; refusing to authorize payment implicitly');
    }

    this.baseUrl = baseUrl.replace(/\/$/, '');
    this.pay = pay;
    this.fetchImpl = fetchImpl;
    this.maxAttempts = maxAttempts;
    this.retryDelayMs = retryDelayMs;
  }

  async executeShipyardInference({
    prompt,
    model = 'shipyard-inference-demo',
    metadata = {},
  }) {
    const idempotencyKey = randomId('idem');
    const requestBody = {
      tool: 'shipyard-inference',
      prompt,
      model,
      metadata,
    };

    let cachedAuthorizationHeader = null;
    let cachedChallengeFingerprint = null;
    let payInvocations = 0;
    const httpAttempts = [];

    for (let attempt = 1; attempt <= this.maxAttempts; attempt += 1) {
      const requestStartedAt = Date.now();
      const headers = {
        'content-type': 'application/json',
        'x-idempotency-key': idempotencyKey,
      };
      if (cachedAuthorizationHeader) {
        headers['x-payment-authorization'] = cachedAuthorizationHeader;
      }

      const response = await this.fetchImpl(
        `${this.baseUrl}/v1/paid-tools/shipyard-inference`,
        {
          method: 'POST',
          headers,
          body: JSON.stringify(requestBody),
        },
      );

      const rawBody = await response.text();
      const parsedBody = rawBody ? JSON.parse(rawBody) : {};
      httpAttempts.push({
        attempt,
        status: response.status,
        elapsed_ms: Date.now() - requestStartedAt,
        reused_authorization: Boolean(cachedAuthorizationHeader),
      });

      if (response.status === 402) {
        const challenge =
          parsedBody.challenge ||
          decodePaymentRequiredHeader(response.headers.get('payment-required'))[0];

        if (!challenge) {
          throw new Error('402 response did not include a usable x402 challenge');
        }

        const challengeFingerprint = paymentChallengeFingerprint(challenge);

        if (
          !cachedAuthorizationHeader ||
          cachedChallengeFingerprint !== challengeFingerprint
        ) {
          const authorizationEnvelope = await this.pay({
            challenge,
            idempotencyKey,
            attempt,
          });
          payInvocations += 1;
          cachedAuthorizationHeader = Buffer.from(
            JSON.stringify(authorizationEnvelope),
            'utf8',
          ).toString('base64url');
          cachedChallengeFingerprint = challengeFingerprint;
        }

        continue;
      }

      if (
        response.status === 429 ||
        (response.status >= 500 && response.status <= 599)
      ) {
        if (attempt === this.maxAttempts) {
          throw new Error(
            `shipyard-inference failed after ${attempt} attempts: ${parsedBody.error || response.status}`,
          );
        }
        await sleep(this.retryDelayMs * attempt);
        continue;
      }

      if (!response.ok) {
        throw new Error(`shipyard-inference returned ${response.status}: ${rawBody}`);
      }

      return {
        tool: 'shipyard-inference',
        execution: parsedBody.result,
        upstream: parsedBody,
        receipt: {
          receipt_id: parsedBody.receipt?.receipt_id,
          invocation_id: parsedBody.receipt?.invocation_id,
          paid_call: {
            protocol: 'x402',
            idempotency_key: idempotencyKey,
            price: parsedBody.receipt?.pricing,
            settled: false,
            note: 'demo flow; receipt proves retry/governance behavior but does not settle funds',
          },
          runtime: {
            pay_callback_invocations: payInvocations,
            payment_authorization: {
              present: Boolean(cachedAuthorizationHeader),
              challenge_fingerprint: cachedChallengeFingerprint,
              reused: httpAttempts.some(
                (entry, index) => index > 0 && entry.reused_authorization,
              ),
            },
            http_attempts: httpAttempts,
            retry_count: httpAttempts.length - 1,
          },
          upstream_receipt: parsedBody.receipt,
          residual_uncertainty: [
            'demo authorization uses HMAC and proves no on-chain settlement',
            'final server response is authoritative only for this endpoint and idempotency key',
          ],
        },
      };
    }

    throw new Error('unreachable');
  }
}

async function selfTestAndDemo() {
  const demoServer = await createDemoShipyardServer();
  let payCalls = 0;

  try {
    const client = new X402PaidToolClient({
      baseUrl: demoServer.baseUrl,
      pay: async ({ challenge }) => {
        payCalls += 1;
        return createDemoPaymentAuthorization({
          challenge,
          payer: 'maintainer-demo-buyer',
        });
      },
    });

    const result = await client.executeShipyardInference({
      prompt:
        'Explain why x402 retries must reuse the same payment authorization after a 503.',
      model: 'shipyard-inference-demo',
      metadata: { example: 'receipt-and-retry-flow' },
    });

    assert.equal(payCalls, 1, 'pay callback should only run once');
    assert.equal(
      result.receipt.runtime.pay_callback_invocations,
      1,
      'receipt should show one payment authorization',
    );
    assert.deepEqual(
      result.receipt.runtime.http_attempts.map((entry) => entry.status),
      [402, 503, 200],
      'demo should show 402 challenge, retryable failure, then success',
    );
    assert.equal(
      result.receipt.runtime.payment_authorization.reused,
      true,
      'authorization should be reused on retry',
    );
    assert.match(
      result.execution.completion,
      /REUSE THE SAME PAYMENT AUTHORIZATION/i,
    );

    const payload = {
      summary:
        'x402 paid shipyard-inference call completed with governed retry and receipt generation',
      result,
      server_state: demoServer.inspect(),
    };

    console.log(JSON.stringify(payload, null, 2));
  } finally {
    await demoServer.close();
  }
}

export {
  X402PaidToolClient,
  createDemoPaymentAuthorization,
  createDemoShipyardServer,
  paymentChallengeFingerprint,
};

if (import.meta.url === `file://${process.argv[1]}`) {
  selfTestAndDemo().catch((error) => {
    console.error(error.stack || String(error));
    process.exitCode = 1;
  });
}
