import assert from 'node:assert/strict';
import { request } from 'node:http';
import test from 'node:test';
import { createManagedLoopbackServer } from '../host/loopback-server.mjs';
import { createManagedServiceHttpHandler } from '../src/http-handler.mjs';
import { createManagedRequestPolicy } from '../src/request-policy.mjs';

function send(url, body = '', headers = {}) {
  return new Promise((resolve, reject) => {
    const req = request(url, { method: 'POST', headers: { 'content-length': Buffer.byteLength(body), ...headers } }, (res) => {
      let text = ''; res.on('data', (chunk) => { text += chunk; });
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: JSON.parse(text) }));
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

test('socket response forwards only bounded Retry-After from handler results', async () => {
  const server = createManagedLoopbackServer({ enabled: true, handler: async () => ({
    status: 429,
    headers: { 'retry-after': '9', location: 'https://private.invalid', 'set-cookie': ['secret=1'] },
    body: { error: { code: 'RATE_LIMITED' } },
  }) });
  try {
    const { url } = await server.start();
    const result = await send(url, '{}');
    assert.equal(result.status, 429);
    assert.equal(result.headers['retry-after'], '9');
    assert.equal(result.headers.location, undefined);
    assert.equal(result.headers['set-cookie'], undefined);
  } finally { await server.close(); }
});

test('invalid Retry-After values are ignored rather than forwarded', async () => {
  const server = createManagedLoopbackServer({ enabled: true, handler: async () => ({
    status: 429, headers: { 'retry-after': '3601' }, body: { error: { code: 'RATE_LIMITED' } },
  }) });
  try {
    const { url } = await server.start();
    const result = await send(url, '{}');
    assert.equal(result.status, 429); assert.equal(result.headers['retry-after'], undefined);
  } finally { await server.close(); }
});

test('real handler policy rate denial reaches the socket and blocks admission', async () => {
  let effects = 0;
  const principal = { key_id: 'key_1', tenant_id: 'tenant_1', scopes: ['invocations:write'] };
  const handler = createManagedServiceHttpHandler({
    controlPlane: { async health() { return { ready: true }; }, async admitInvocation() { effects += 1; return { created: true }; } },
    authenticator: { async authenticate() { return principal; } },
    requestPolicy: createManagedRequestPolicy({
      readControl: async () => ({ enabled: true, epoch: 1 }),
      consumeRateLimit: async () => ({ allowed: false, retry_after_seconds: 7 }),
      emitTelemetry: async () => {},
    }),
  });
  const server = createManagedLoopbackServer({ enabled: true, handler });
  try {
    const { url } = await server.start();
    const result = await send(`${url}/v1/invocations`, '{}', { authorization: 'Bearer fixture', 'content-type': 'application/json' });
    assert.equal(result.status, 429); assert.equal(result.headers['retry-after'], '7');
    assert.equal(result.body.error.code, 'RATE_LIMITED'); assert.equal(effects, 0);
  } finally { await server.close(); }
});
