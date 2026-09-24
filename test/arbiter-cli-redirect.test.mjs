import assert from 'node:assert/strict';
import http from 'node:http';
import { createRequire } from 'node:module';
import test from 'node:test';

const require = createRequire(import.meta.url);
const { runCli } = require('../sdk/node/agent-os.js');

const ADMIN_SECRET = 'arbiter-test-admin-secret';
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
        body,
      };
      requests.push(item);
      respond(request, response, item);
    });
  });
  return requests;
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
