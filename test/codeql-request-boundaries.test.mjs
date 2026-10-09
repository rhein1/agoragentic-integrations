import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { createDemoShipyardServer } from '../examples/agoragentic-growth/2026-06-21-shipyard-inference-x402-receipt-flow-mjs-222449486a/shipyard-inference-x402-receipt-flow.mjs';

const require = createRequire(import.meta.url);
const { runCli } = require('../sdk/node/agent-os.js');
const encode = (value) => Buffer.from(JSON.stringify(value)).toString('base64url');
const endpoint = '/v1/paid-tools/shipyard-inference';

test('caller-controlled route/header values never replace Shipyard authorization verification', async () => {
  const server = await createDemoShipyardServer({ failPaidAttemptOnce: false });
  const body = { tool: 'shipyard-inference', prompt: 'unsigned attacker input' };
  const headers = { 'content-type': 'application/json', 'x-idempotency-key': 'attacker-selected-key' };
  const request = (authorization, input = body) => fetch(server.baseUrl + endpoint, {
    method: 'POST', headers: { ...headers, ...(authorization ? { 'x-payment-authorization': authorization } : {}) },
    body: JSON.stringify(input),
  });
  try {
    const initial = await request();
    assert.equal(initial.status, 402);
    const { challenge } = await initial.json();
    const valid = server.createPaymentAuthorization({ challenge });
    for (const changed of [
      { ...valid, payer: 'different-payer' },
      { ...valid, challenge_id: 'caller-selected-challenge' },
      { ...valid, fingerprint: '0'.repeat(64) },
      { ...valid, authorization: '0'.repeat(64) },
      { payer: valid.payer },
    ]) {
      const rejected = await request(encode(changed));
      assert.equal(rejected.status, 402);
      assert.equal((await rejected.json()).error, 'invalid_payment_authorization');
    }
    assert.equal((await request(encode(valid), { ...body, prompt: 'changed after signing' })).status, 402);
    assert.equal((await request('malformed-nonempty-header')).status, 500);
    assert.equal((await request(encode(null))).status, 500);
    assert.deepEqual(server.inspect(), { cached_executions: 0, paid_attempt_count: {}, observed_authorizations: {} });
    const accepted = await request(encode(valid));
    assert.equal(accepted.status, 200);
    assert.equal((await accepted.json()).receipt.payment.settled, false);
  } finally { await server.close(); }
});

async function listen(server) {
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  return `http://127.0.0.1:${server.address().port}`;
}

const close = (server) => new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));

for (const redirectStatus of [null, 302, 307]) {
  test(`CLI sends only the explicitly selected JSON file and rejects redirect ${redirectStatus}`, async () => {
    const root = mkdtempSync(join(tmpdir(), 'agoragentic-cli-selected-file-'));
    const selected = { text: 'explicitly selected public fixture' };
    const file = join(root, 'selected.json');
    writeFileSync(file, JSON.stringify(selected));
    writeFileSync(join(root, 'unselected.json'), JSON.stringify({ secret: 'unselected-fixture' }));
    let destinationRequests = 0;
    const destination = http.createServer((request, response) => {
      destinationRequests += 1; request.resume(); response.end('{}');
    });
    const destinationUrl = await listen(destination);
    const sourceRequests = [];
    const source = http.createServer(async (request, response) => {
      const chunks = [];
      for await (const chunk of request) chunks.push(chunk);
      sourceRequests.push({ path: request.url, body: JSON.parse(Buffer.concat(chunks).toString()) });
      response.writeHead(redirectStatus || 200, redirectStatus
        ? { location: `${destinationUrl}/unapproved-destination` } : { 'content-type': 'application/json' });
      response.end('{}');
    });
    const sourceUrl = await listen(source);
    const io = { stdout: { write() {} }, stderr: { write() {} } };
    try {
      const code = await runCli(['x402', 'invoke', 'cap_file_boundary', '--input', file],
        { AGORAGENTIC_BASE_URL: sourceUrl }, io);
      assert.equal(code, redirectStatus ? 1 : 0);
      assert.deepEqual(sourceRequests, [{ path: '/api/x402/invoke/cap_file_boundary', body: { input: selected } }]);
      assert.equal(destinationRequests, 0);
      writeFileSync(file, 'invalid JSON');
      assert.equal(await runCli(['x402', 'invoke', 'cap_file_boundary', '--input', file],
        { AGORAGENTIC_BASE_URL: sourceUrl }, io), 2);
      assert.equal(sourceRequests.length, 1, 'invalid selected JSON must fail before network I/O');
    } finally {
      await Promise.all([close(source), close(destination)]);
      rmSync(root, { recursive: true, force: true });
    }
  });
}
