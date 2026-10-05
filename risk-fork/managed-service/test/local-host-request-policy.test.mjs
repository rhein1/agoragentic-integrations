import assert from 'node:assert/strict';
import test from 'node:test';
import { createManagedRiskForkLocalHost } from '../host/local-host.mjs';
import { createManagedRequestPolicy } from '../src/request-policy.mjs';
import { createManagedTelemetryDrainer } from '../src/telemetry-drainer.mjs';
import { createFixture } from './helpers.mjs';

function deliveryStore() {
  const rows = new Map();
  return {
    async insert(record) { const key = `${record.namespace}:${record.attempt_ref}`; if (rows.has(key)) return false; rows.set(key, { record, acknowledged: false }); return true; },
    async get(namespace, ref) { return rows.get(`${namespace}:${ref}`) ?? null; },
    async acknowledge(namespace, ref, hash) { const row = rows.get(`${namespace}:${ref}`); row.acknowledged = true; row.response_hash = hash; },
    async listPending(namespace, limit) { return [...rows.values()].filter((row) => row.record.namespace === namespace && !row.acknowledged).map((row) => row.record.attempt_ref).slice(0, limit); },
  };
}

async function hostWithPolicy(policy, fixture, invokeProvider = async () => {}, telemetryDrainer, captureOptions) {
  const options = {
    enabled: true, controlPlane: fixture.controlPlane, publicAuthenticator: fixture.authenticator,
    workerAuthenticator: fixture.authenticator, providerRegistry: fixture.providerRegistry,
    executionPrincipal: fixture.principal, cleanupPrincipal: fixture.sameTenantPrincipal,
    recoveryPrincipal: fixture.recoveryPrincipal, workerId: 'worker:policy-test', deliveryStore: deliveryStore(),
    deliveryEncryptionKey: Buffer.alloc(32, 0x61), deliveryKeyId: 'key:policy-test', deliveryNamespace: 'ns:policy-test',
    deadlineMs: 100, requestPolicy: policy, telemetryDrainer,
    workerOptions: {
      loadPrepareInput: async () => ({ operation: {} }), invokeProvider,
      lookupResources: async () => ({ savepoint_ref: null, fork_ref: null, absent_resource_kinds: [] }), measureCostMicros: async () => 0,
    },
  };
  const host = createManagedRiskForkLocalHost(options); captureOptions?.(options); return host;
}

test('enabled local host gates direct execute before provider effects and permits cleanup/recovery policy classes', async () => {
  const fixture = await createFixture(); let providerCalls = 0; const routes = [];
  const policy = createManagedRequestPolicy({
    readControl: async () => ({ enabled: false, epoch: 1 }),
    consumeRateLimit: async ({ route_class }) => { routes.push(route_class); return { allowed: true, retry_after_seconds: 0 }; },
    emitTelemetry: async () => {},
  });
  const host = await hostWithPolicy(policy, fixture, async () => { providerCalls += 1; });
  await host.start();
  try {
    await assert.rejects(host.execute('missing'), { code: 'MANAGED_SERVICE_DISABLED' });
    await assert.rejects(host.cleanup('missing'));
    await assert.rejects(host.recover('missing'));
    assert.equal(providerCalls, 0); assert.deepEqual(routes, ['cleanup', 'recovery']);
  } finally { await host.close(); }
});

test('direct policy callback hangs are bounded by local host deadline', async () => {
  const fixture = await createFixture(); const started = Date.now();
  const pending = new Promise(() => {});
  const policy = createManagedRequestPolicy({
    readControl: async () => pending,
    consumeRateLimit: async () => ({ allowed: true, retry_after_seconds: 0 }),
    emitTelemetry: async () => {},
  });
  const host = await hostWithPolicy(policy, fixture);
  await host.start();
  try { await assert.rejects(host.execute('missing'), { code: 'REQUEST_TIMEOUT' }); }
  finally { await host.close(); }
  assert.ok(Date.now() - started < 1500);
});

test('omitting policy preserves direct local operation path', async () => {
  const fixture = await createFixture(); const host = await hostWithPolicy(undefined, fixture);
  await host.start();
  try {
    const result = host.execute('missing');
    assert.equal(typeof result?.then, 'function');
    await assert.rejects(result);
  } finally { await host.close(); }
});

test('local host explicitly owns observer scheduling and closes ingress/effects before bounded telemetry drain', async () => {
  const fixture = await createFixture(); let claims = 0;
  const drainer = createManagedTelemetryDrainer({ intervalMs: 100,store: {
    async claim() { claims += 1; return null; },async acknowledge() {},async retry() {},
  },deliver: async () => { throw new Error('no event means no sink call'); } });
  const policy = createManagedRequestPolicy({ readControl: async () => ({ enabled: false,epoch: 1 }),
    consumeRateLimit: async () => ({ allowed: true,retry_after_seconds: 0 }),
    recordTelemetry: async (event) => ({ event_ref: event.event_ref,persisted: true }) });
  const host = await hostWithPolicy(policy,fixture,undefined,drainer);
  assert.equal(drainer.health().running,false); await host.start();
  try {
    await assert.rejects(host.execute('missing'),{ code: 'MANAGED_SERVICE_DISABLED' });
    await new Promise((resolve) => setTimeout(resolve,160)); assert.ok(claims > 0);
    assert.equal(host.health().telemetry_delivery.running,true);
  } finally { await host.close(); }
  assert.equal(drainer.health().closed,true); assert.equal(host.health().telemetry_close.recording.settled,true);
  assert.equal(host.health().telemetry_close.observer.settled,true);
  const count = claims; await new Promise((resolve) => setTimeout(resolve,160)); assert.equal(claims,count);
  await assert.rejects(hostWithPolicy(policy,fixture,undefined,{ start() {},close() {} }),/original managed telemetry drainer/);
});

test('host retains the validated observer and original policy despite caller option mutation', async () => {
  const fixture = await createFixture(); let options, replacements = 0;
  const drainer = createManagedTelemetryDrainer({ store: {
    async claim() { return null; },async acknowledge() {},async retry() {},
  },deliver: async () => { throw new Error('no delivery'); } });
  const policy = createManagedRequestPolicy({ readControl: async () => ({ enabled: false,epoch: 1 }),
    consumeRateLimit: async () => ({ allowed: true,retry_after_seconds: 0 }),emitTelemetry: async () => {} });
  const host = await hostWithPolicy(policy,fixture,undefined,drainer,(value) => { options = value; });
  const replacement = () => { replacements += 1; throw new Error('replacement must not run'); };
  options.telemetryDrainer = { start: replacement,close: replacement,health: replacement };
  options.requestPolicy = { beforeMutation: replacement,flushTelemetry: replacement,telemetryHealth: replacement };
  await host.start();
  try { await assert.rejects(host.execute('missing'),{ code: 'MANAGED_SERVICE_DISABLED' }); assert.equal(host.health().telemetry_delivery.running,true); }
  finally { await host.close(); }
  assert.equal(replacements,0); assert.equal(drainer.health().closed,true);
});
