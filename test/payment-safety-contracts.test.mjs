import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

import { AgoragenticAgenticWalletClient } from '../coinbase-agentic-wallets/agoragentic_agentic_wallet.ts';
import {
  X402ExecuteBuyer,
  classifyExecuteError,
} from '../examples/agoragentic-growth/2026-07-09-mcp-execute-buyer-retry-receipt-checklis-ce132a27eb/mcp-execute-buyer-retry-receipt-checklist.mjs';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = (path) => readFileSync(join(root, path), 'utf8');
const asset = '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913';
const payTo = '0x1111111111111111111111111111111111111111';

const quote = (overrides = {}) => ({
  quote_id: 'quote_test',
  quoted_price_usdc: 0.02,
  payment_network_caip2: 'eip155:8453',
  settlement_network_caip2: 'eip155:8453',
  settlement_asset_address: asset,
  execution_ready: true,
  ...overrides,
});

const authorization = (overrides = {}) => ({
  payment_authorized: true,
  max_amount_usdc: 0.02,
  expected_network: 'eip155:8453',
  expected_asset: asset,
  expected_pay_to: payTo,
  idempotency_key: 'x402-test-intent',
  ...overrides,
});

function challengeHeader({
  amount = '20000',
  network = 'base',
  challengeAsset = asset,
  challengePayTo = payTo,
  scheme = 'exact',
  topLevelResource = 'https://example.test/api/x402/execute',
} = {}) {
  return Buffer.from(JSON.stringify({
    x402Version: 2,
    resource: { url: topLevelResource },
    accepts: [{ scheme, network, amount, asset: challengeAsset, payTo: challengePayTo }],
  })).toString('base64');
}

function paymentResponseHeader(overrides = {}) {
  return Buffer.from(JSON.stringify({
    receipt_id: 'payment-receipt-proof',
    quote_id: 'quote_test',
    settlement_status: 'settled',
    amount_usdc: 0.02,
    ...overrides,
  })).toString('base64');
}

test('registered execute rejects zero and sends a canonical positive ceiling', async () => {
  const calls = [];
  const previousFetch = globalThis.fetch;
  globalThis.fetch = async (url, options) => {
    calls.push({ url, options });
    return new Response(JSON.stringify({ status: 'success' }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  };

  try {
    const client = new AgoragenticAgenticWalletClient({ baseUrl: 'https://example.test', apiKey: 'amk_test' });
    await assert.rejects(client.match('summarize', { max_cost: 0 }), /router treats zero as an absent ceiling/);
    await assert.rejects(
      client.execute('summarize', {}, { max_cost: 0, payment_authorized: true, idempotency_key: 'zero-test' }),
      /router treats zero as an absent ceiling/,
    );
    assert.equal(calls.length, 0);

    await client.execute('summarize', { text: 'hello' }, {
      max_cost: 0.02,
      payment_authorized: true,
      idempotency_key: 'registered-test-intent',
    });
    assert.equal(calls.length, 1);
    const body = JSON.parse(calls[0].options.body);
    assert.deepEqual(body, {
      task: 'summarize',
      input: { text: 'hello' },
      constraints: { max_cost: 0.02 },
    });
    assert.equal(calls[0].options.headers['Idempotency-Key'], undefined);
    await assert.rejects(
      client.execute('summarize', { text: 'hello' }, {
        max_cost: 0.02,
        payment_authorized: true,
        idempotency_key: 'registered-test-intent',
      }),
      /already attempted by this client/,
    );
    assert.equal(calls.length, 1);
  } finally {
    globalThis.fetch = previousFetch;
  }
});

test('x402 rejects an over-cap challenge before the wallet callback', async () => {
  let payCallbacks = 0;
  const previousFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response(JSON.stringify({ error: 'payment_required' }), {
    status: 402,
    headers: {
      'Content-Type': 'application/json',
      'PAYMENT-REQUIRED': challengeHeader({ amount: '10000000' }),
    },
  });

  try {
    const client = new AgoragenticAgenticWalletClient({
      baseUrl: 'https://example.test',
      payChallenge: async () => {
        payCallbacks += 1;
        return { paymentSignature: 'should-not-be-used' };
      },
    });
    await assert.rejects(client.x402Execute(quote(), {}, authorization()), /amount does not match/);
    assert.equal(payCallbacks, 0);
  } finally {
    globalThis.fetch = previousFetch;
  }
});

test('x402 binds scheme, resource, network, asset, and recipient before signing', async () => {
  const cases = [
    { options: { scheme: 'upto' }, error: /scheme/ },
    { options: { topLevelResource: 'https://example.test/api/x402/invoke/other' }, error: /resource does not match/ },
    { options: { network: 'eip155:1' }, error: /network/ },
    { options: { challengeAsset: '0x2222222222222222222222222222222222222222' }, error: /asset/ },
    { options: { challengePayTo: '0x3333333333333333333333333333333333333333' }, error: /recipient/ },
  ];
  const previousFetch = globalThis.fetch;

  try {
    for (const entry of cases) {
      let payCallbacks = 0;
      globalThis.fetch = async () => new Response(JSON.stringify({ error: 'payment_required' }), {
        status: 402,
        headers: {
          'Content-Type': 'application/json',
          'PAYMENT-REQUIRED': challengeHeader(entry.options),
        },
      });
      const client = new AgoragenticAgenticWalletClient({
        baseUrl: 'https://example.test',
        payChallenge: async () => {
          payCallbacks += 1;
          return { paymentSignature: 'should-not-be-used' };
        },
      });
      await assert.rejects(client.x402Execute(quote(), {}, authorization()), entry.error);
      assert.equal(payCallbacks, 0);
    }
  } finally {
    globalThis.fetch = previousFetch;
  }
});

test('x402 fails closed on a second 402', async () => {
  let calls = 0;
  const previousFetch = globalThis.fetch;
  globalThis.fetch = async () => {
    calls += 1;
    return new Response(JSON.stringify({ error: 'payment_required_again' }), {
      status: 402,
      headers: {
        'Content-Type': 'application/json',
        'PAYMENT-REQUIRED': challengeHeader(),
      },
    });
  };

  try {
    const client = new AgoragenticAgenticWalletClient({
      baseUrl: 'https://example.test',
      payChallenge: async () => ({ paymentSignature: 'signed-payment' }),
    });
    await assert.rejects(client.x402Execute(quote(), {}, authorization()), /another payment challenge/);
    assert.equal(calls, 2);
  } finally {
    globalThis.fetch = previousFetch;
  }
});

test('x402 blocks reuse after an ambiguous signed retry failure', async () => {
  let calls = 0;
  const previousFetch = globalThis.fetch;
  globalThis.fetch = async () => {
    calls += 1;
    if (calls === 1) {
      return new Response(JSON.stringify({ error: 'payment_required' }), {
        status: 402,
        headers: { 'Content-Type': 'application/json', 'PAYMENT-REQUIRED': challengeHeader() },
      });
    }
    throw new Error('network failed after signing');
  };

  try {
    const client = new AgoragenticAgenticWalletClient({
      baseUrl: 'https://example.test',
      payChallenge: async () => ({ paymentSignature: 'signed-payment' }),
    });
    await assert.rejects(client.x402Execute(quote(), {}, authorization()), /network failed after signing/);
    await assert.rejects(client.x402Execute(quote(), {}, authorization()), /already attempted an x402 payment/);
    assert.equal(calls, 2);
  } finally {
    globalThis.fetch = previousFetch;
  }
});

test('x402 returns only a successful paid response with both proof headers', async () => {
  const responses = [
    new Response(JSON.stringify({ error: 'payment_required' }), {
      status: 402,
      headers: { 'Content-Type': 'application/json', 'PAYMENT-REQUIRED': challengeHeader() },
    }),
    new Response(JSON.stringify({ status: 'success' }), {
      status: 200,
      headers: {
        'Content-Type': 'application/json',
        'PAYMENT-RESPONSE': paymentResponseHeader(),
        'Payment-Receipt': 'payment-receipt-proof',
      },
    }),
  ];
  const previousFetch = globalThis.fetch;
  globalThis.fetch = async () => responses.shift();

  try {
    const client = new AgoragenticAgenticWalletClient({
      baseUrl: 'https://example.test',
      payChallenge: async () => ({ paymentSignature: 'signed-payment' }),
    });
    const result = await client.x402Execute(quote(), {}, authorization());
    assert.equal(result.status, 'success');
    assert.equal(result.payment_response.receipt_id, 'payment-receipt-proof');
    assert.equal(result.payment_receipt, 'payment-receipt-proof');
  } finally {
    globalThis.fetch = previousFetch;
  }
});

test('x402 rejects inconsistent payment proof headers', async () => {
  const responses = [
    new Response(JSON.stringify({ error: 'payment_required' }), {
      status: 402,
      headers: { 'Content-Type': 'application/json', 'PAYMENT-REQUIRED': challengeHeader() },
    }),
    new Response(JSON.stringify({ status: 'success' }), {
      status: 200,
      headers: {
        'Content-Type': 'application/json',
        'PAYMENT-RESPONSE': paymentResponseHeader({ receipt_id: 'different-receipt' }),
        'Payment-Receipt': 'payment-receipt-proof',
      },
    }),
  ];
  const previousFetch = globalThis.fetch;
  globalThis.fetch = async () => responses.shift();

  try {
    const client = new AgoragenticAgenticWalletClient({
      baseUrl: 'https://example.test',
      payChallenge: async () => ({ paymentSignature: 'signed-payment' }),
    });
    await assert.rejects(client.x402Execute(quote(), {}, authorization()), /receipt does not match/);
  } finally {
    globalThis.fetch = previousFetch;
  }
});

test('growth buyer fails closed after an ambiguous paid execute without replaying or reauthorizing', async () => {
  let matchCalls = 0;
  let executeCalls = 0;
  let payCalls = 0;
  let paidSideEffects = 0;

  const buyer = new X402ExecuteBuyer({
    baseUrl: 'https://example.test',
    async fetchImpl(url, options = {}) {
      const parsed = new URL(url);
      if (parsed.pathname.endsWith('/match')) {
        matchCalls += 1;
        return new Response(JSON.stringify({ quote_id: 'quote_ambiguous_paid_attempt' }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
      }

      executeCalls += 1;
      const headers = new Headers(options.headers);
      if (!headers.get('authorization')) {
        return new Response(JSON.stringify({ error: 'payment_required' }), {
          status: 402,
          headers: {
            'Content-Type': 'application/json',
            'PAYMENT-REQUIRED': 'ambiguous-paid-attempt-challenge',
          },
        });
      }

      paidSideEffects += 1;
      throw new TypeError('connection reset after the server accepted the paid request');
    },
    async pay() {
      payCalls += 1;
      return { authorizationHeader: 'X402 signed-payment-proof' };
    },
  });

  await assert.rejects(
    buyer.execute('summarize', { text: 'charge at most once' }, { idempotencyKey: 'ambiguous-intent' }),
    (error) => {
      assert.equal(error.name, 'NetworkError');
      assert.equal(error.outcomeUnknown, true);
      assert.equal(error.ambiguousOutcome, true);
      assert.equal(error.retryable, false);
      assert.equal(error.paymentAuthorizationMayHaveBeenConsumed, true);
      assert.equal(error.authorizedPaymentReused, false);
      assert.equal(error.signedRequestAttempts, 1);
      assert.equal(error.networkRetriesUsed, 0);
      assert.equal(error.quoteId, 'quote_ambiguous_paid_attempt');
      const classified = classifyExecuteError(error);
      assert.equal(classified.retryable, false);
      assert.equal(classified.quoteId, 'quote_ambiguous_paid_attempt');
      assert.equal(classified.ambiguousOutcome, true);
      assert.equal(classified.paymentAuthorizationMayHaveBeenConsumed, true);
      assert.equal(classified.signedRequestAttempts, 1);
      assert.equal(classified.nextAction, 'inspect_receipt_or_proof');
      assert.match(classified.guidance, /Do not retry or re-authorize automatically/);
      assert.match(classified.guidance, /\/api\/x402\/claim\/challenge/);
      assert.match(classified.guidance, /\/api\/commerce\/public-receipts\/\{receipt_id\}/);
      return true;
    },
  );

  assert.deepEqual(
    { matchCalls, executeCalls, payCalls, paidSideEffects },
    { matchCalls: 1, executeCalls: 2, payCalls: 1, paidSideEffects: 1 },
  );

  await assert.rejects(
    buyer.execute('summarize', { text: 'must remain blocked' }),
    (error) => {
      assert.equal(error.name, 'NetworkError');
      assert.equal(error.outcomeUnknown, true);
      assert.equal(error.retryable, false);
      assert.equal(error.blockedByPriorAmbiguousOutcome, true);
      assert.equal(error.idempotencyKey, 'ambiguous-intent');
      return true;
    },
  );

  assert.deepEqual(
    { matchCalls, executeCalls, payCalls, paidSideEffects },
    { matchCalls: 1, executeCalls: 2, payCalls: 1, paidSideEffects: 1 },
    'a caller-level retry on the same buyer must be blocked before match, payment, or execute',
  );
});

for (const headerShape of ['tuple-array', 'request-init-override']) {
  test(`growth buyer blocks a preferred-helper replay with ${headerShape} signed headers`, async () => {
    let matchCalls = 0;
    let executeCalls = 0;
    let signedCalls = 0;
    let payCalls = 0;

    const preferredX402Fetch = async (url, options) => {
      await options.fetchImpl(url, { method: 'POST', headers: [['Accept', 'application/json']] });
      const payment = await options.pay('preferred-helper-challenge', {
        url,
        method: 'POST',
        idempotencyKey: options.idempotencyKey,
      });
      const sendSigned = () => {
        const headers = [['Authorization', payment.authorizationHeader]];
        if (headerShape === 'tuple-array') {
          return options.fetchImpl(url, { method: 'POST', headers });
        }
        const request = new Request(url, {
          method: 'POST',
          headers: { Accept: 'application/json' },
        });
        return options.fetchImpl(request, { headers });
      };

      try {
        await sendSigned();
      } catch {}
      return sendSigned();
    };

    const buyer = new X402ExecuteBuyer({
      baseUrl: 'https://example.test',
      preferredX402Fetch,
      async fetchImpl(input, init = {}) {
        const url = typeof input === 'string' ? input : input.url;
        const parsed = new URL(url);
        if (parsed.pathname.endsWith('/match')) {
          matchCalls += 1;
          return new Response(JSON.stringify({ quote_id: `quote_preferred_${headerShape}` }), {
            status: 200,
            headers: { 'Content-Type': 'application/json' },
          });
        }

        executeCalls += 1;
        const inputHeaders = input instanceof Request ? input.headers : null;
        const headers = new Headers(init.headers !== undefined ? init.headers : inputHeaders ?? {});
        if (!headers.get('authorization')) {
          return new Response(JSON.stringify({ error: 'payment_required' }), {
            status: 402,
            headers: { 'PAYMENT-REQUIRED': 'preferred-helper-challenge' },
          });
        }

        signedCalls += 1;
        if (signedCalls === 1) {
          throw new TypeError('preferred helper lost the first signed response');
        }
        return new Response(JSON.stringify({ receipt_id: 'unsafe-replay-receipt' }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
      },
      async pay() {
        payCalls += 1;
        return { authorizationHeader: 'X402 preferred-signed-proof' };
      },
    });

    await assert.rejects(
      buyer.execute('summarize', { text: 'preferred helper must not replay' }, {
        idempotencyKey: `preferred-${headerShape}-intent`,
      }),
      (error) => {
        assert.equal(error.name, 'NetworkError');
        assert.equal(error.ambiguousOutcome, true);
        assert.equal(error.retryable, false);
        assert.equal(error.signedRequestAttempts, 1);
        assert.equal(classifyExecuteError(error).nextAction, 'inspect_receipt_or_proof');
        return true;
      },
    );

    assert.deepEqual(
      { matchCalls, executeCalls, signedCalls, payCalls },
      { matchCalls: 1, executeCalls: 2, signedCalls: 1, payCalls: 1 },
      'the preferred helper must not reach the underlying transport for a second signed request',
    );
  });
}

test('growth buyer locks after a paid response body becomes unreadable', async () => {
  let matchCalls = 0;
  let executeCalls = 0;
  let payCalls = 0;

  const buyer = new X402ExecuteBuyer({
    baseUrl: 'https://example.test',
    async fetchImpl(url, options = {}) {
      const parsed = new URL(url);
      if (parsed.pathname.endsWith('/match')) {
        matchCalls += 1;
        return new Response(JSON.stringify({ quote_id: 'quote_unreadable_paid_body' }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
      }

      executeCalls += 1;
      const headers = new Headers(options.headers);
      if (!headers.get('authorization')) {
        return new Response(JSON.stringify({ error: 'payment_required' }), {
          status: 402,
          headers: {
            'Content-Type': 'application/json',
            'PAYMENT-REQUIRED': 'unreadable-paid-body-challenge',
          },
        });
      }

      return new Response(new ReadableStream({
        start(controller) {
          controller.error(new TypeError('response stream reset after paid headers'));
        },
      }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    },
    async pay() {
      payCalls += 1;
      return { authorizationHeader: 'X402 signed-payment-proof' };
    },
  });

  await assert.rejects(
    buyer.execute('summarize', { text: 'body failure' }, { idempotencyKey: 'unreadable-body-intent' }),
    (error) => {
      assert.equal(error.name, 'NetworkError');
      assert.equal(error.ambiguousOutcome, true);
      assert.equal(error.paymentAuthorizationMayHaveBeenConsumed, true);
      assert.equal(error.signedRequestAttempts, 1);
      assert.equal(error.quoteId, 'quote_unreadable_paid_body');
      return true;
    },
  );

  await assert.rejects(
    buyer.execute('summarize', { text: 'must remain blocked' }),
    (error) => error.blockedByPriorAmbiguousOutcome === true,
  );
  assert.deepEqual(
    { matchCalls, executeCalls, payCalls },
    { matchCalls: 1, executeCalls: 2, payCalls: 1 },
  );
});

test('growth buyer treats a signed HTTP 500 as non-retryable until receipt reconciliation', async () => {
  let matchCalls = 0;
  let executeCalls = 0;
  let payCalls = 0;

  const buyer = new X402ExecuteBuyer({
    baseUrl: 'https://example.test',
    async fetchImpl(url, options = {}) {
      const parsed = new URL(url);
      if (parsed.pathname.endsWith('/match')) {
        matchCalls += 1;
        return new Response(JSON.stringify({ quote_id: 'quote_signed_http_500' }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
      }

      executeCalls += 1;
      const headers = new Headers(options.headers);
      if (!headers.get('authorization')) {
        return new Response(JSON.stringify({ error: 'payment_required' }), {
          status: 402,
          headers: { 'PAYMENT-REQUIRED': 'signed-http-500-challenge' },
        });
      }
      return new Response(JSON.stringify({ error: 'provider_failed_after_payment' }), {
        status: 500,
        headers: { 'Content-Type': 'application/json' },
      });
    },
    async pay() {
      payCalls += 1;
      return { authorizationHeader: 'X402 signed-payment-proof' };
    },
  });

  await assert.rejects(
    buyer.execute('summarize', { text: 'signed 500' }, { idempotencyKey: 'signed-http-500-intent' }),
    (error) => {
      assert.equal(error.name, 'NetworkError');
      assert.equal(error.status, 500);
      assert.equal(error.ambiguousOutcome, true);
      assert.equal(error.retryable, false);
      assert.equal(error.paymentAuthorizationMayHaveBeenConsumed, true);
      assert.equal(error.signedRequestAttempts, 1);
      assert.equal(classifyExecuteError(error).retryable, false);
      return true;
    },
  );

  await assert.rejects(
    buyer.execute('summarize', { text: 'must remain blocked' }),
    (error) => error.blockedByPriorAmbiguousOutcome === true,
  );
  assert.deepEqual(
    { matchCalls, executeCalls, payCalls },
    { matchCalls: 1, executeCalls: 2, payCalls: 1 },
  );
});

test('buyer demo is an honest keyless preflight', () => {
  const source = read('x402/buyer-demo.js');
  assert.match(source, /--paid-preflight/);
  assert.match(source, /stops here without signing or retrying/);
  assert.doesNotMatch(source, /process\.env\.WALLET_PRIVATE_KEY/);
  assert.doesNotMatch(source, /require\(['"]ethers['"]\)/);
});

test('root README references an existing offline verification command', () => {
  const readme = read('README.md');
  assert.match(readme, /node scripts\/verify-integrations-json\.js/);
  assert.doesNotMatch(readme, /scripts\/execute-path-proof\.mjs/);
});
