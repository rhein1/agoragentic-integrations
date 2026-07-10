import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

import { AgoragenticAgenticWalletClient } from '../coinbase-agentic-wallets/agoragentic_agentic_wallet.ts';

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
