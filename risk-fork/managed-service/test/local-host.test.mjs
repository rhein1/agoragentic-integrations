import assert from 'node:assert/strict';
import { request } from 'node:http';
import { createServer } from 'node:net';
import test from 'node:test';
import { createManagedRiskForkLocalHost } from '../host/local-host.mjs';
import { createManagedWorkerDeliveryJournal } from '../src/worker-delivery.mjs';
import { createFixture, invocationRequest, testLeaseToken, TEST_TOKEN } from './helpers.mjs';

function deliveryStore() {
  const rows = new Map();
  return {
    async insert(record) {
      const key = `${record.namespace}:${record.attempt_ref}`;
      if (rows.has(key)) return false;
      rows.set(key, { record: structuredClone(record), acknowledged: false });
      return true;
    },
    async get(namespace, ref) { return structuredClone(rows.get(`${namespace}:${ref}`) ?? null); },
    async acknowledge(namespace, ref, hash) {
      const row = rows.get(`${namespace}:${ref}`);
      if (!row) throw new Error('missing delivery row');
      row.acknowledged = true; row.response_hash = hash;
    },
    async listPending(namespace, limit) {
      return [...rows.values()]
        .filter((row) => row.record.namespace === namespace && !row.acknowledged)
        .map((row) => row.record.attempt_ref).slice(0, limit);
    },
  };
}

function post(url, path, body, token = TEST_TOKEN) {
  return new Promise((resolve, reject) => {
    const req = request(`${url}${path}`, { method: 'POST', headers: {
      authorization: `Bearer ${token}`, 'content-type': 'application/json',
      'content-length': Buffer.byteLength(body),
    } }, (res) => {
      let text = ''; res.on('data', (chunk) => { text += chunk; });
      res.on('end', () => resolve({ status: res.statusCode, body: JSON.parse(text) }));
    });
    req.on('error', reject); req.end(body);
  });
}

async function freePort() {
  const server = createServer();
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const port = server.address().port;
  await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  return port;
}

function hostOptions(fixture) {
  return {
    enabled: true,
    controlPlane: fixture.controlPlane,
    publicAuthenticator: fixture.authenticator,
    workerAuthenticator: fixture.authenticator,
    providerRegistry: fixture.providerRegistry,
    executionPrincipal: fixture.principal,
    cleanupPrincipal: fixture.sameTenantPrincipal,
    recoveryPrincipal: fixture.recoveryPrincipal,
    workerId: 'worker:local-host',
    deliveryStore: deliveryStore(),
    deliveryEncryptionKey: Buffer.alloc(32, 0x51),
    deliveryKeyId: 'key:local-host',
    deliveryNamespace: 'namespace:local-host',
    workerOptions: {
      loadPrepareInput: async () => ({ operation: {} }),
      invokeProvider: async () => { throw new Error('provider callback must not run in ingress test'); },
      lookupResources: async () => ({ savepoint_ref: null, fork_ref: null, absent_resource_kinds: [] }),
      measureCostMicros: async () => 0,
    },
    reaperOptions: { intervalMs: 100 },
  };
}

test('local host is default-off and composes only explicitly supplied dependencies', async () => {
  const disabled = createManagedRiskForkLocalHost();
  assert.equal(disabled.health().enabled, false);
  await assert.rejects(disabled.start(), { code: 'HOST_DISABLED' });

  const fixture = await createFixture();
  const host = createManagedRiskForkLocalHost(hostOptions(fixture));
  const listeners = await host.start();
  try {
    assert.match(listeners.public.url, /^http:\/\/127\.0\.0\.1:/);
    assert.match(listeners.worker.url, /^http:\/\/127\.0\.0\.1:/);
    assert.equal(host.health().reaper.scheduled, true);
    const publicRejectsWorker = await post(
      listeners.public.url,
      '/internal/v1/invocations/rfi_missing/claim-execution',
      '{}',
    );
    assert.equal(publicRejectsWorker.status, 404);
    const workerRejectsPublic = await post(
      listeners.worker.url,
      '/v1/invocations',
      '{}',
    );
    assert.equal(workerRejectsPublic.status, 404);
  } finally {
    await host.close();
  }
  assert.equal(host.health().closed, true);
  assert.equal(host.health().reaper.scheduled, false);
});

test('local host construction requires a host-owned delivery key and callbacks', async () => {
  const fixture = await createFixture();
  const options = hostOptions(fixture);
  delete options.deliveryEncryptionKey;
  assert.throws(() => createManagedRiskForkLocalHost(options), /32-byte encryption key/);
});

test('listener construction failure releases composed capabilities', async () => {
  const fixture = await createFixture();
  assert.throws(() => createManagedRiskForkLocalHost({
    ...hostOptions(fixture),
    maxBodyBytes: 0,
  }), /maxBodyBytes/);
});

test('startup failure closes the sibling listener and concurrent close shares completion', async () => {
  const fixture = await createFixture();
  const port = await freePort();
  const host = createManagedRiskForkLocalHost({
    ...hostOptions(fixture),
    publicPort: port,
    workerPort: port,
  });
  const starting = host.start();
  const closing = host.close();
  assert.equal(closing, host.close());
  await assert.rejects(starting, /HOST_CLOSED|EADDRINUSE|closed while starting/);
  await closing;
  assert.equal(host.health().reaper.scheduled, false);

  const probe = createServer();
  await new Promise((resolve, reject) => {
    probe.once('error', reject);
    probe.listen(port, '127.0.0.1', resolve);
  });
  await new Promise((resolve, reject) => probe.close((error) => error ? reject(error) : resolve()));
});

test('local host resumes retained delivery after key rotation without invoking the provider', async () => {
  const fixture = await createFixture();
  const { invocation } = await fixture.controlPlane.admitInvocation(fixture.principal, invocationRequest());
  const options = hostOptions(fixture);
  let calls = 0;
  const control = { ...fixture.controlPlane, async claimExecution(...args) {
    const result = await fixture.controlPlane.claimExecution(...args);
    if (++calls === 1) throw new Error('lost acknowledgement');
    return result;
  } };
  const old = createManagedWorkerDeliveryJournal({
    store: options.deliveryStore, encryptionKey: options.deliveryEncryptionKey,
    keyId: options.deliveryKeyId, namespace: options.deliveryNamespace,
    workerId: options.workerId, controlPlane: control, executionPrincipal: options.executionPrincipal,
    cleanupPrincipal: options.cleanupPrincipal, recoveryPrincipal: options.recoveryPrincipal,
  });
  await assert.rejects(old.deliver('execution', 'claimExecution', {
    invocation_ref: invocation.invocation_ref, worker_id: options.workerId,
    lease_token: testLeaseToken('host_rotation'), lease_ms: 10_000,
  }), /lost acknowledgement/);
  const [ref] = await old.listPending(); old.close();
  let providerCalls = 0;
  const host = createManagedRiskForkLocalHost({ ...options, controlPlane: control,
    deliveryEncryptionKey: Buffer.alloc(32, 0x52), deliveryKeyId: 'key:local-host-new',
    deliveryRetiredDecryptionKeys: [{ keyId: options.deliveryKeyId, encryptionKey: options.deliveryEncryptionKey }],
    workerOptions: { ...options.workerOptions, invokeProvider: async () => { providerCalls += 1; throw new Error('unexpected provider call'); } },
  });
  await host.start();
  try {
    assert.equal((await host.resumeDelivery(ref)).original_operation_resumed, false);
    assert.deepEqual(await host.listPendingDeliveries(), []);
    assert.equal(calls, 2); assert.equal(providerCalls, 0);
    assert.equal(host.health().production_qualified, false);
    assert.equal(host.health().live_traffic_protected, false);
  } finally { await host.close(); }
  assert.throws(() => host.resumeDelivery(ref), { code: 'HOST_DISABLED' });
  assert.equal(options.deliveryEncryptionKey[0], 0x51, 'host still owns its original key');
});
