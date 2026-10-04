import assert from 'node:assert/strict';
import { request } from 'node:http';
import test from 'node:test';
import { createManagedLoopbackServer } from '../host/loopback-server.mjs';

function send(url, body = '', headers = {}) {
  return new Promise((resolve, reject) => {
    const req = request(url, { method: 'POST', headers: { 'content-length': Buffer.byteLength(body), ...headers } }, (res) => {
      let text = ''; res.on('data', (chunk) => { text += chunk; });
      res.on('end', () => resolve({ status: res.statusCode, body: JSON.parse(text) }));
    });
    req.on('error', reject); req.end(body);
  });
}

test('loopback ingress is default off, bounded, no-store and never publicly bound', async () => {
  assert.throws(() => createManagedLoopbackServer({ handler() {} }), /enabled/);
  let calls = 0;
  const server = createManagedLoopbackServer({ enabled: true, maxBodyBytes: 4,
    handler: async () => { calls++; return { status: 200, body: { local_test: true } }; } });
  try {
    const { url, production_qualified } = await server.start();
    assert.match(url, /^http:\/\/127\.0\.0\.1:/); assert.equal(production_qualified, false);
    assert.equal((await send(url, '{}')).status, 200);
    assert.equal((await send(url, '12345')).status, 413);
    assert.equal(calls, 1);
    assert.equal((await send(url, '{}', { Authorization: ['Bearer first', 'Bearer second'] })).status, 400);
  } finally { await server.close(); }
});

test('deadline rejects delayed handler results and shutdown closes active sockets', async () => {
  let release;
  const delayed = new Promise((resolve) => { release = resolve; });
  const server = createManagedLoopbackServer({ enabled: true, deadlineMs: 100,
    handler: async () => { await delayed; return { status: 200, body: { late: true } }; } });
  try {
    const { url } = await server.start();
    const result = await send(url, '{}'); assert.equal(result.status, 408);
    release();
  } finally { release(); await server.close(); }
});
