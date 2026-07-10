import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const demoPath = join(root, 'x402', 'buyer-demo.js');
const asset = '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913';
const payTo = '0x1111111111111111111111111111111111111111';

function canonicalEnvelope({ paymentRequired, priceUsdc, quoteId = 'quote_behavioral' }) {
  return {
    quote: {
      quote_id: quoteId,
      quoted_price_usdc: priceUsdc,
      payment_required: paymentRequired,
      next_step: {
        method: 'POST',
        url: '/api/x402/execute',
        body: { quote_id: quoteId, input: {} },
      },
    },
    selected_provider: { id: 'listing_behavioral', name: 'Behavioral Mock Provider' },
    quote_id: quoteId,
  };
}

function challengeHeader() {
  return Buffer.from(JSON.stringify({
    x402Version: 2,
    resource: { url: '/api/x402/execute' },
    accepts: [{ scheme: 'exact', network: 'base', amount: '50000', asset, payTo }],
  })).toString('base64');
}

function startMockRouter(analyzeMatchBody, options = {}) {
  const state = { executePosts: [] };
  const executeHeaders = Object.hasOwn(options, 'executeHeaders')
    ? options.executeHeaders
    : { 'PAYMENT-REQUIRED': challengeHeader() };
  const server = createServer((req, res) => {
    const chunks = [];
    req.on('data', (chunk) => chunks.push(chunk));
    req.on('end', () => {
      const url = new URL(req.url, 'http://127.0.0.1');
      const respond = (status, body, headers = {}) => {
        res.writeHead(status, { 'Content-Type': 'application/json', ...headers });
        res.end(JSON.stringify(body));
      };
      if (req.method === 'GET' && url.pathname === '/api/x402/info') {
        return respond(200, { name: 'Mock x402 Gateway', protocol: 'x402', network: 'eip155:8453', currency: 'USDC' });
      }
      if (req.method === 'GET' && url.pathname === '/api/x402/listings') {
        return respond(200, { listings: [] });
      }
      if (req.method === 'GET' && url.pathname === '/api/x402/execute/match') {
        if (url.searchParams.get('task') === 'analyze') {
          return respond(200, analyzeMatchBody);
        }
        return respond(200, { quote: null, selected_provider: null, quote_id: null });
      }
      if (req.method === 'POST' && url.pathname === '/api/x402/test/echo') {
        return respond(200, { method: 'echo', echoed: Buffer.concat(chunks).toString() });
      }
      if (req.method === 'POST' && url.pathname === '/api/x402/execute') {
        state.executePosts.push({
          headers: { ...req.headers },
          body: Buffer.concat(chunks).toString(),
        });
        return respond(402, { error: 'payment_required', price_usdc: 0.05 }, executeHeaders);
      }
      return respond(404, { error: 'not_found' });
    });
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      resolve({ server, state, baseUrl: `http://127.0.0.1:${server.address().port}` });
    });
  });
}

function stopMockRouter(mock) {
  return new Promise((resolve) => {
    mock.server.closeAllConnections();
    mock.server.close(resolve);
  });
}

function runPreflight(baseUrl) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [demoPath, '--paid-preflight'], {
      cwd: root,
      env: { ...process.env, AGORAGENTIC_URL: baseUrl },
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.on('error', reject);
    child.on('close', (code) => resolve({ code, stdout, stderr }));
  });
}

test('paid preflight posts exactly once, reports the 402, and never sends payment headers', async () => {
  const mock = await startMockRouter(canonicalEnvelope({ paymentRequired: true, priceUsdc: 0.05 }));
  try {
    const result = await runPreflight(mock.baseUrl);
    assert.equal(result.code, 0, `expected clean exit, stderr: ${result.stderr}`);

    assert.equal(mock.state.executePosts.length, 1, 'exactly one POST must reach the paid execute route (no retry after the 402)');
    const post = mock.state.executePosts[0];
    assert.equal(JSON.parse(post.body).quote_id, 'quote_behavioral');
    for (const header of Object.keys(post.headers)) {
      assert.doesNotMatch(header, /payment|authorization|signature/i, `unsigned preflight sent a payment header: ${header}`);
    }

    assert.match(result.stdout, /Matched paid listing: "Behavioral Mock Provider" — \$0\.05 USDC \(payment_required=true\)/);
    assert.match(result.stdout, /402 Payment Required received \(challenge header present\); preflight stops here without signing or retrying\./);
    assert.doesNotMatch(result.stdout, /Matched listing is free/);
    assert.doesNotMatch(result.stdout, /no payment needed/);
  } finally {
    await stopMockRouter(mock);
  }
});

test('a genuinely free canonical quote is reported free and never posts a payment', async () => {
  const mock = await startMockRouter(canonicalEnvelope({ paymentRequired: false, priceUsdc: 0 }));
  try {
    const result = await runPreflight(mock.baseUrl);
    assert.equal(result.code, 0, `expected clean exit, stderr: ${result.stderr}`);
    assert.match(result.stdout, /Matched listing is free \(payment_required=false\) — no payment needed/);
    assert.equal(mock.state.executePosts.length, 0, 'a free quote must never reach the paid execute route in preflight');
  } finally {
    await stopMockRouter(mock);
  }
});

test('an unrecognized match envelope fails closed instead of claiming free', async () => {
  const mock = await startMockRouter({ quote_id: 'legacy_quote', match: { name: 'Legacy Listing', price_usdc: 0.05 } });
  try {
    const result = await runPreflight(mock.baseUrl);
    assert.notEqual(result.code, 0, 'unrecognized envelope must exit non-zero');
    assert.match(result.stdout, /missing "quote" field/);
    assert.doesNotMatch(result.stdout, /Matched listing is free/);
    assert.doesNotMatch(result.stdout, /no payment needed/);
    assert.equal(mock.state.executePosts.length, 0);
  } finally {
    await stopMockRouter(mock);
  }
});

test('a quote without the payment_required boolean fails closed instead of claiming free', async () => {
  const envelope = canonicalEnvelope({ paymentRequired: true, priceUsdc: 0.05 });
  delete envelope.quote.payment_required;
  const mock = await startMockRouter(envelope);
  try {
    const result = await runPreflight(mock.baseUrl);
    assert.notEqual(result.code, 0, 'missing payment_required must exit non-zero');
    assert.match(result.stdout, /"quote\.payment_required"/);
    assert.doesNotMatch(result.stdout, /Matched listing is free/);
    assert.equal(mock.state.executePosts.length, 0);
  } finally {
    await stopMockRouter(mock);
  }
});

test('a hostile protocol-relative next_step.url cannot redirect the POST off-origin', async () => {
  const envelope = canonicalEnvelope({ paymentRequired: true, priceUsdc: 0.05 });
  envelope.quote.next_step.url = '//attacker.example/api/x402/execute';
  const mock = await startMockRouter(envelope);
  try {
    const result = await runPreflight(mock.baseUrl);
    assert.equal(result.code, 0, `expected clean exit, stderr: ${result.stderr}`);
    assert.equal(mock.state.executePosts.length, 1, 'the POST must land on the same-origin fallback route, not the foreign host');
    assert.match(result.stdout, /402 Payment Required received/);
  } finally {
    await stopMockRouter(mock);
  }
});

test('a slash-backslash next_step.url cannot redirect the POST off-origin', async () => {
  const foreignState = { posts: 0 };
  const foreignServer = createServer((req, res) => {
    if (req.method === 'POST') foreignState.posts += 1;
    res.writeHead(402, { 'Content-Type': 'application/json', 'PAYMENT-REQUIRED': challengeHeader() });
    res.end(JSON.stringify({ error: 'payment_required' }));
  });
  await new Promise((resolve) => foreignServer.listen(0, '127.0.0.1', resolve));

  const envelope = canonicalEnvelope({ paymentRequired: true, priceUsdc: 0.05 });
  envelope.quote.next_step.url = `/\\127.0.0.1:${foreignServer.address().port}/capture`;
  const mock = await startMockRouter(envelope);
  try {
    const result = await runPreflight(mock.baseUrl);
    assert.equal(result.code, 0, `expected clean exit, stderr: ${result.stderr}`);
    assert.equal(mock.state.executePosts.length, 1, 'the POST must use the same-origin execute fallback');
    assert.equal(foreignState.posts, 0, 'a backslash-normalized authority must never receive the POST');
    assert.match(result.stdout, /402 Payment Required received/);
  } finally {
    await stopMockRouter(mock);
    foreignServer.closeAllConnections();
    await new Promise((resolve) => foreignServer.close(resolve));
  }
});

test('HTTP 402 without PAYMENT-REQUIRED fails the preflight', async () => {
  const mock = await startMockRouter(
    canonicalEnvelope({ paymentRequired: true, priceUsdc: 0.05 }),
    { executeHeaders: {} },
  );
  try {
    const result = await runPreflight(mock.baseUrl);
    assert.notEqual(result.code, 0, 'a missing challenge header must fail the process');
    assert.equal(mock.state.executePosts.length, 1, 'the unsigned preflight still makes only its initial POST');
    assert.match(result.stdout, /HTTP 402 without PAYMENT-REQUIRED/);
    assert.doesNotMatch(result.stdout, /✅  402 Payment Required received/);
  } finally {
    await stopMockRouter(mock);
  }
});

test('a paid quote with an unparseable price fails closed instead of guessing', async () => {
  const envelope = canonicalEnvelope({ paymentRequired: true, priceUsdc: 0.05 });
  envelope.quote.quoted_price_usdc = 'not-a-number';
  const mock = await startMockRouter(envelope);
  try {
    const result = await runPreflight(mock.baseUrl);
    assert.notEqual(result.code, 0, 'unparseable price must exit non-zero');
    assert.match(result.stdout, /"quote\.quoted_price_usdc"/);
    assert.doesNotMatch(result.stdout, /Matched listing is free/);
    assert.equal(mock.state.executePosts.length, 0);
  } finally {
    await stopMockRouter(mock);
  }
});
