import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import http from 'node:http';
import test from 'node:test';

import {
  createDemoShipyardServer,
  paymentChallengeFingerprint,
  X402PaidToolClient,
} from '../examples/agoragentic-growth/2026-06-21-shipyard-inference-x402-receipt-flow-mjs-222449486a/shipyard-inference-x402-receipt-flow.mjs';

const ENDPOINT = '/v1/paid-tools/shipyard-inference';

function encodeAuthorization(envelope) {
  return Buffer.from(JSON.stringify(envelope), 'utf8').toString('base64url');
}

function createLegacyFixedKeyAuthorization(challenge, payer = 'legacy-test-buyer') {
  const fingerprint = paymentChallengeFingerprint(challenge);
  const signature = crypto
    .createHmac('sha256', 'demo-x402-secret-do-not-use-on-chain')
    .update(`${fingerprint}:${payer}`)
    .digest('hex');

  return {
    scheme: 'demo-hmac',
    payer,
    challenge_id: challenge.challenge_id,
    authorization: signature,
    fingerprint,
  };
}

function listen(server) {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      server.removeListener('error', reject);
      resolve(`http://127.0.0.1:${server.address().port}`);
    });
  });
}

function close(server) {
  if (!server.listening) return Promise.resolve();
  return new Promise((resolve, reject) => {
    server.close((error) => error ? reject(error) : resolve());
  });
}

test('legacy fixed-key authorization is rejected; route and idempotency guards remain', async () => {
  const server = await createDemoShipyardServer({ failPaidAttemptOnce: false });

  try {
    assert.match(server.baseUrl, /^http:\/\/127\.0\.0\.1:\d+$/);

    const routeResponse = await fetch(`${server.baseUrl}${ENDPOINT}`, { method: 'GET' });
    assert.equal(routeResponse.status, 404);

    const body = { tool: 'shipyard-inference', prompt: 'fixture', model: 'demo' };
    const missingKeyResponse = await fetch(`${server.baseUrl}${ENDPOINT}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
    assert.equal(missingKeyResponse.status, 400);
    assert.equal((await missingKeyResponse.json()).error, 'missing_x_idempotency_key');

    const headers = {
      'content-type': 'application/json',
      'x-idempotency-key': 'legacy-fixed-key-test',
    };
    const challengeResponse = await fetch(`${server.baseUrl}${ENDPOINT}`, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
    });
    assert.equal(challengeResponse.status, 402);
    const challenge = (await challengeResponse.json()).challenge;

    const legacyResponse = await fetch(`${server.baseUrl}${ENDPOINT}`, {
      method: 'POST',
      headers: {
        ...headers,
        'x-payment-authorization': encodeAuthorization(
          createLegacyFixedKeyAuthorization(challenge),
        ),
      },
      body: JSON.stringify(body),
    });
    assert.equal(legacyResponse.status, 402);
    assert.equal((await legacyResponse.json()).error, 'invalid_payment_authorization');

    const authorization = server.createPaymentAuthorization({ challenge });
    const acceptedResponse = await fetch(`${server.baseUrl}${ENDPOINT}`, {
      method: 'POST',
      headers: {
        ...headers,
        'x-payment-authorization': encodeAuthorization(authorization),
      },
      body: JSON.stringify(body),
    });
    assert.equal(acceptedResponse.status, 200);
    const accepted = await acceptedResponse.json();
    assert.equal(accepted.receipt.payment.mode, 'demo');
    assert.equal(accepted.receipt.payment.settled, false);
    assert.match(accepted.receipt.payment.note, /no real funds moved/);
  } finally {
    await server.close();
  }
});

test('ephemeral authorization is server-instance scoped and retries keep settlement disabled', async () => {
  const server = await createDemoShipyardServer();
  const otherServer = await createDemoShipyardServer({ failPaidAttemptOnce: false });

  try {
    assert.match(server.baseUrl, /^http:\/\/127\.0\.0\.1:\d+$/);
    assert.match(otherServer.baseUrl, /^http:\/\/127\.0\.0\.1:\d+$/);

    const client = new X402PaidToolClient({
      baseUrl: server.baseUrl,
      retryDelayMs: 0,
      pay: async ({ challenge }) => server.createPaymentAuthorization({ challenge }),
    });
    const result = await client.executeShipyardInference({
      prompt: 'Retry using the same authorization.',
    });

    assert.deepEqual(
      result.receipt.runtime.http_attempts.map(({ status }) => status),
      [402, 503, 200],
    );
    assert.equal(result.receipt.runtime.pay_callback_invocations, 1);
    assert.equal(result.receipt.runtime.payment_authorization.reused, true);
    assert.equal(result.receipt.paid_call.settled, false);
    assert.equal(result.receipt.upstream_receipt.payment.settled, false);
    assert.match(result.receipt.upstream_receipt.payment.note, /no real funds moved/);

    const requestBody = { tool: 'shipyard-inference', prompt: 'cross-instance', model: 'demo' };
    const headers = {
      'content-type': 'application/json',
      'x-idempotency-key': 'cross-instance-auth-test',
    };
    const challengeResponse = await fetch(`${server.baseUrl}${ENDPOINT}`, {
      method: 'POST',
      headers,
      body: JSON.stringify(requestBody),
    });
    assert.equal(challengeResponse.status, 402);
    const challenge = (await challengeResponse.json()).challenge;
    const firstInstanceAuthorization = server.createPaymentAuthorization({ challenge });
    const rejectedByOtherInstance = await fetch(`${otherServer.baseUrl}${ENDPOINT}`, {
      method: 'POST',
      headers: {
        ...headers,
        'x-payment-authorization': encodeAuthorization(firstInstanceAuthorization),
      },
      body: JSON.stringify(requestBody),
    });
    assert.equal(rejectedByOtherInstance.status, 402);
    assert.equal((await rejectedByOtherInstance.json()).error, 'invalid_payment_authorization');
  } finally {
    await Promise.all([server.close(), otherServer.close()]);
  }
});

for (const status of [302, 307]) {
  test(`paid demo retry rejects ${status} without forwarding its authorization`, async () => {
    let destinationRequests = 0;
    const destination = http.createServer((request, response) => {
      destinationRequests += 1;
      request.resume();
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end('{}');
    });
    const destinationBaseUrl = await listen(destination);

    let paidRequests = 0;
    const challenge = {
      protocol: 'x402',
      challenge_id: `challenge-redirect-${status}`,
      tool: 'shipyard-inference',
      asset: 'USDC',
      network: 'base-sepolia-demo',
      amount_micro_usdc: 250000,
      pay_to: 'demo://shipyard-inference-seller',
      settlement: 'authorization-on-402-retry',
      idempotency_key: `redirect-${status}`,
      request_hash: `test-hash-${status}`,
    };
    const source = http.createServer((request, response) => {
      request.resume();
      if (!request.headers['x-payment-authorization']) {
        response.writeHead(402, { 'content-type': 'application/json' });
        response.end(JSON.stringify({ challenge }));
        return;
      }
      paidRequests += 1;
      response.writeHead(status, { location: `${destinationBaseUrl}/redirect-target` });
      response.end();
    });
    const sourceBaseUrl = await listen(source);

    try {
      const client = new X402PaidToolClient({
        baseUrl: sourceBaseUrl,
        maxAttempts: 2,
        retryDelayMs: 0,
        pay: async () => ({
          scheme: 'demo-hmac',
          authorization: 'synthetic-no-funds',
        }),
      });
      await assert.rejects(
        client.executeShipyardInference({ prompt: 'redirect guard fixture' }),
        /fetch failed|redirect/i,
      );
      assert.equal(paidRequests, 1);
      assert.equal(destinationRequests, 0);
    } finally {
      await Promise.all([close(source), close(destination)]);
    }
  });
}
