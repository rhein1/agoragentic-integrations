import assert from 'node:assert/strict';
import http from 'node:http';
import { createRequire } from 'node:module';
import test from 'node:test';

const require = createRequire(import.meta.url);
const { runCli } = require('../sdk/node/agent-os.js');
const agoragentic = require('../sdk/node');

const ADMIN_SECRET = 'arbiter-test-admin-secret';
const API_KEY = 'redirect-test-api-key';
const PAYMENT_SIGNATURE = 'redirect-test-payment-signature';
const REVIEW_PAYLOAD = { review_id: 'review-test-154', context: 'local fixture payload' };

function captureIo() {
  let stdout = '';
  let stderr = '';
  return {
    io: {
      stdout: { write: (value) => { stdout += value; } },
      stderr: { write: (value) => { stderr += value; } },
    },
    stdout: () => stdout,
    stderr: () => stderr,
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

function recordRequests(server, respond) {
  const requests = [];
  server.on('request', (request, response) => {
    const chunks = [];
    request.on('data', (chunk) => chunks.push(chunk));
    request.on('end', () => {
      const body = Buffer.concat(chunks).toString('utf8');
      const item = {
        method: request.method,
        url: request.url,
        adminSecret: request.headers['x-admin-secret'] || null,
        apiKey: request.headers['x-api-key'] || null,
        authorization: request.headers.authorization || null,
        paymentSignature: request.headers['payment-signature'] || null,
        body,
      };
      requests.push(item);
      respond(request, response, item);
    });
  });
  return requests;
}

async function runRedirectSensitiveCli(args, baseUrl, edgeBaseUrl = baseUrl) {
  const captured = captureIo();
  const code = await runCli(
    args,
    { AGORAGENTIC_BASE_URL: baseUrl },
    captured.io,
    { x402BaseUrl: edgeBaseUrl }
  );
  return { code, captured };
}

async function runReview(baseUrl, io) {
  return runCli(
    ['arbiter', 'review', '--payload', JSON.stringify(REVIEW_PAYLOAD)],
    { AGORAGENTIC_BASE_URL: baseUrl, AGORAGENTIC_ADMIN_SECRET: ADMIN_SECRET },
    io
  );
}

test('arbiter review sends the explicit payload to a configured self-hosted base URL', async (t) => {
  const server = http.createServer();
  const baseUrl = await listen(server);
  t.after(() => close(server));
  const requests = recordRequests(server, (_request, response) => {
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end(JSON.stringify({ reviewed: true }));
  });

  const captured = captureIo();
  assert.equal(await runReview(baseUrl, captured.io), 0);
  assert.equal(requests.length, 1);
  assert.equal(requests[0].method, 'POST');
  assert.equal(requests[0].url, '/api/arbiter/review');
  assert.equal(requests[0].adminSecret, ADMIN_SECRET);
  assert.deepEqual(JSON.parse(requests[0].body), {
    ...REVIEW_PAYLOAD,
    semantic: false,
    semantic_blocking: false,
  });
  assert.deepEqual(JSON.parse(captured.stdout()).result, { reviewed: true });
});

for (const status of [302, 307]) {
  test(`arbiter review rejects a ${status} redirect without forwarding its secret or payload`, async (t) => {
    const destination = http.createServer();
    const destinationBaseUrl = await listen(destination);
    t.after(() => close(destination));
    const destinationRequests = recordRequests(destination, (_request, response) => {
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end('{}');
    });

    const source = http.createServer();
    const sourceBaseUrl = await listen(source);
    t.after(() => close(source));
    const sourceRequests = recordRequests(source, (_request, response) => {
      response.writeHead(status, { location: `${destinationBaseUrl}/redirect-target` });
      response.end();
    });

    const captured = captureIo();
    assert.equal(await runReview(sourceBaseUrl, captured.io), 1);
    assert.equal(sourceRequests.length, 1);
    assert.equal(sourceRequests[0].method, 'POST');
    assert.equal(sourceRequests[0].url, '/api/arbiter/review');
    assert.equal(sourceRequests[0].adminSecret, ADMIN_SECRET);
    assert.deepEqual(JSON.parse(sourceRequests[0].body), {
      ...REVIEW_PAYLOAD,
      semantic: false,
      semantic_blocking: false,
    });
    assert.equal(destinationRequests.length, 0);
    assert.match(captured.stderr(), /redirect|fetch failed/i);
  });
}

const paymentSignatureCases = [
  {
    name: 'x402 test',
    args: ['x402', 'test', '--payment-signature', PAYMENT_SIGNATURE],
    path: '/api/x402/test/echo',
    useEdgeBaseUrl: false,
  },
  {
    name: 'x402 execute',
    args: ['x402', 'execute', '--task', 'redirect test', '--quote-id', 'quote-redirect-test', '--payment-signature', PAYMENT_SIGNATURE],
    path: '/api/x402/execute',
    useEdgeBaseUrl: false,
  },
  {
    name: 'x402 invoke',
    args: ['x402', 'invoke', 'cap_redirect_test', '--payment-signature', PAYMENT_SIGNATURE],
    path: '/api/x402/invoke/cap_redirect_test',
    useEdgeBaseUrl: false,
  },
  {
    name: 'x402 receipt',
    args: ['x402', 'receipt', 'receipt-redirect-test', '--payment-signature', PAYMENT_SIGNATURE],
    path: '/v1/receipt-reconciliation',
    useEdgeBaseUrl: true,
  },
];

for (const { name, args, path, useEdgeBaseUrl } of paymentSignatureCases) {
  for (const status of [302, 307]) {
    test(`${name} rejects a ${status} redirect without forwarding PAYMENT-SIGNATURE`, async (t) => {
      const destination = http.createServer();
      const destinationBaseUrl = await listen(destination);
      t.after(() => close(destination));
      const destinationRequests = recordRequests(destination, (_request, response) => {
        response.writeHead(200, { 'content-type': 'application/json' });
        response.end('{}');
      });

      const source = http.createServer();
      const sourceBaseUrl = await listen(source);
      t.after(() => close(source));
      const sourceRequests = recordRequests(source, (_request, response) => {
        response.writeHead(status, { location: `${destinationBaseUrl}/redirect-target` });
        response.end();
      });

      const { code, captured } = await runRedirectSensitiveCli(
        args,
        sourceBaseUrl,
        useEdgeBaseUrl ? sourceBaseUrl : undefined
      );
      assert.equal(code, 1);
      assert.equal(sourceRequests.length, 1);
      assert.equal(sourceRequests[0].url, path);
      assert.equal(sourceRequests[0].paymentSignature, PAYMENT_SIGNATURE);
      assert.equal(destinationRequests.length, 0);
      assert.match(captured.stderr(), /redirect|fetch failed/i);
    });
  }
}

const CLAIM_WALLET = `0x${'a'.repeat(40)}`;
const CLAIM_SIGNATURE = 'redirect-test-claim-proof-signature';

for (const status of [302, 307]) {
  test(`x402 claim rejects a ${status} redirect without forwarding its signed proof`, async (t) => {
    const destination = http.createServer();
    const destinationBaseUrl = await listen(destination);
    t.after(() => close(destination));
    const destinationRequests = recordRequests(destination, (_request, response) => {
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end('{}');
    });

    const source = http.createServer();
    const sourceBaseUrl = await listen(source);
    t.after(() => close(source));
    const sourceRequests = recordRequests(source, (_request, response) => {
      response.writeHead(status, { location: `${destinationBaseUrl}/redirect-target` });
      response.end();
    });

    const { code, captured } = await runRedirectSensitiveCli(
      ['x402', 'claim', '--wallet', CLAIM_WALLET, '--signature', CLAIM_SIGNATURE],
      sourceBaseUrl
    );
    assert.equal(code, 1);
    assert.equal(sourceRequests.length, 1);
    assert.equal(sourceRequests[0].url, '/api/x402/claim');
    assert.deepEqual(JSON.parse(sourceRequests[0].body).proof, {
      message: agoragentic.buildX402ClaimProofMessage(CLAIM_WALLET),
      signature: CLAIM_SIGNATURE,
    });
    assert.equal(destinationRequests.length, 0);
    assert.match(captured.stderr(), /redirect|fetch failed/i);
  });
}

for (const status of [302, 307]) {
  test(`Node SDK rejects a ${status} redirect without forwarding its API key`, async (t) => {
    const destination = http.createServer();
    const destinationBaseUrl = await listen(destination);
    t.after(() => close(destination));
    const destinationRequests = recordRequests(destination, (_request, response) => {
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end('{}');
    });

    const source = http.createServer();
    const sourceBaseUrl = await listen(source);
    t.after(() => close(source));
    const sourceRequests = recordRequests(source, (_request, response) => {
      response.writeHead(status, { location: `${destinationBaseUrl}/redirect-target` });
      response.end();
    });

    const client = agoragentic({ apiKey: API_KEY, baseUrl: sourceBaseUrl });
    await assert.rejects(client.account(), /fetch failed/i);
    assert.equal(sourceRequests.length, 1);
    assert.equal(sourceRequests[0].url, '/api/commerce/account');
    assert.equal(sourceRequests[0].apiKey, API_KEY);
    assert.equal(sourceRequests[0].authorization, `Bearer ${API_KEY}`);
    assert.equal(destinationRequests.length, 0);
  });
}

test('credential-bearing CLI and SDK requests succeed directly against a self-hosted base URL', async (t) => {
  const server = http.createServer();
  const baseUrl = await listen(server);
  t.after(() => close(server));
  const requests = recordRequests(server, (_request, response) => {
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end(JSON.stringify({ accepted: true }));
  });

  const cliResult = await runRedirectSensitiveCli(
    ['x402', 'test', '--payment-signature', PAYMENT_SIGNATURE],
    baseUrl
  );
  assert.equal(cliResult.code, 0);
  assert.deepEqual(JSON.parse(cliResult.captured.stdout()).result.body, { accepted: true });

  const claimResult = await runRedirectSensitiveCli(
    ['x402', 'claim', '--wallet', CLAIM_WALLET, '--signature', CLAIM_SIGNATURE],
    baseUrl
  );
  assert.equal(claimResult.code, 0);

  const client = agoragentic({ apiKey: API_KEY, baseUrl });
  assert.deepEqual(await client.account(), { accepted: true });

  assert.equal(requests.length, 3);
  assert.equal(requests[0].paymentSignature, PAYMENT_SIGNATURE);
  assert.equal(JSON.parse(requests[1].body).proof.signature, CLAIM_SIGNATURE);
  assert.equal(requests[2].apiKey, API_KEY);
});

test('credential-free CLI and SDK requests retain fetch redirect behavior', async (t) => {
  const destination = http.createServer();
  const destinationBaseUrl = await listen(destination);
  t.after(() => close(destination));
  const destinationRequests = recordRequests(destination, (_request, response) => {
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end(JSON.stringify({ redirected: true }));
  });

  const source = http.createServer();
  const sourceBaseUrl = await listen(source);
  t.after(() => close(source));
  const sourceRequests = recordRequests(source, (_request, response) => {
    response.writeHead(302, { location: `${destinationBaseUrl}/api/x402/info` });
    response.end();
  });

  const result = await runRedirectSensitiveCli(['x402', 'info'], sourceBaseUrl);
  assert.equal(result.code, 0);
  assert.deepEqual(JSON.parse(result.captured.stdout()).result, { redirected: true });

  const client = agoragentic({ baseUrl: sourceBaseUrl });
  assert.deepEqual(await client.stats(), { redirected: true });

  assert.equal(sourceRequests.length, 2);
  assert.equal(destinationRequests.length, 2);
});
