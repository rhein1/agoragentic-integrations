import assert from 'node:assert/strict';
import test from 'node:test';
import { sha256Ref } from '../../src/canonical.mjs';
import { createManagedRiskForkControlPlane } from '../src/control-plane.mjs';
import { createTrustedOAuthAuthenticator, hashManagedApiKey } from '../src/auth.mjs';
import { createManagedServiceConfig } from '../src/config.mjs';
import { createManagedServiceHttpHandler, createManagedWorkerHttpHandler } from '../src/http-handler.mjs';
import { createManagedBacklogSnapshot, MANAGED_BACKLOG_COUNT_FIELDS,
  normalizeManagedBacklogSnapshot } from '../src/backlog-snapshot.mjs';
import { normalizeManagedLifecycleEvent } from '../src/lifecycle-event.mjs';
import { normalizeManagedTelemetryEvent } from '../src/telemetry-event.mjs';
import { createFixture, invocationRequest, TEST_TOKEN } from './helpers.mjs';

const expected = (values) => Object.fromEntries(MANAGED_BACKLOG_COUNT_FIELDS.map((field, index) => [field, values[index]]));
const counts = (snapshot) => Object.fromEntries(MANAGED_BACKLOG_COUNT_FIELDS.map((field) => [field, snapshot[field]]));
const fields = { tenant_id: 'tenant_alpha', snapshot_at: '2026-09-05T12:00:00.000Z', ...expected([0, 0, 0, 0, 0]) };

test('backlog snapshots require closed own data, exact tenant/hash and safe counts', () => {
  const snapshot = createManagedBacklogSnapshot(fields);
  assert.equal(Object.isFrozen(snapshot), true);
  assert.throws(() => normalizeManagedLifecycleEvent(snapshot), /unsupported field/);
  assert.throws(() => normalizeManagedTelemetryEvent(snapshot), /unsupported field/);
  assert.deepEqual(normalizeManagedBacklogSnapshot(snapshot, fields.tenant_id), snapshot);
  assert.deepEqual(createManagedBacklogSnapshot(fields), snapshot, 'same time/state has deterministic identity');
  assert.notEqual(createManagedBacklogSnapshot({ ...fields, cleanup_pending_count: 1 }).snapshot_hash, snapshot.snapshot_hash);
  assert.notEqual(createManagedBacklogSnapshot({ ...fields, snapshot_at: '2026-09-05T12:00:00.001Z' }).snapshot_hash, snapshot.snapshot_hash);
  for (const value of [-1, 0.5, null, '0', Number.MAX_SAFE_INTEGER + 1, Infinity]) {
    assert.throws(() => createManagedBacklogSnapshot({ ...fields, recovery_required_count: value }));
  }
  for (const field of Object.keys(snapshot)) {
    const missing = { ...snapshot }; delete missing[field];
    assert.throws(() => normalizeManagedBacklogSnapshot(missing, fields.tenant_id));
  }
  for (const patch of [{ extra: true }, { production_qualified: true }, { evidence_class: 'independent' },
    { snapshot_hash: sha256Ref('wrong') }, { cleanup_pending_count: 1 }]) {
    assert.throws(() => normalizeManagedBacklogSnapshot({ ...snapshot, ...patch }, fields.tenant_id));
  }
  assert.throws(() => normalizeManagedBacklogSnapshot(snapshot, 'tenant_other'));
  assert.throws(() => normalizeManagedBacklogSnapshot(Object.assign(Object.create(snapshot), {}), fields.tenant_id));
  assert.throws(() => normalizeManagedBacklogSnapshot({ ...snapshot, get cleanup_pending_count() { throw new Error('getter invoked'); } }, fields.tenant_id), /enumerable data/);
});

test('tenant backlog reads current obligations, all inclusive expiries and never mutates source', async () => {
  const f = await createFixture({ concurrency: 8, verifyResourceBinding: async () => true });
  assert.deepEqual(counts(await f.controlPlane.readCleanupRecoveryBacklog(f.principal)), expected([0, 0, 0, 0, 0]));
  const refs = [], leases = [];
  for (let index = 0; index < 4; index += 1) {
    const ref = (await f.controlPlane.admitInvocation(f.principal, invocationRequest({ idempotency_key: `backlog-source-alpha-${index}` }))).invocation.invocation_ref;
    refs.push(ref);
    leases.push(await f.controlPlane.claimExecution(f.principal, { invocation_ref: ref,
      lease_token: f.nextLeaseToken(), worker_id: 'backlog_source', lease_ms: index === 2 ? 5000 : index === 3 ? 10000 : 30000 }));
  }
  for (const index of [0, 1]) {
    await f.controlPlane.recordResources(f.principal, { invocation_ref: refs[index], lease_token: leases[index].lease_token,
      savepoint_ref: `savepoint_${index}`, fork_ref: `fork_${index}` });
    await f.controlPlane.recordExecutionOutcome(f.principal, { invocation_ref: refs[index], lease_token: leases[index].lease_token,
      outcome: 'succeeded', actual_cost_micros: 0, execution_evidence_hash: sha256Ref('fixture'), result_hash: sha256Ref('result') });
  }
  const otherRef = (await f.controlPlane.admitInvocation(f.otherPrincipal, invocationRequest())).invocation.invocation_ref;
  const otherLease = await f.controlPlane.claimExecution(f.otherPrincipal, { invocation_ref: otherRef,
    lease_token: f.nextLeaseToken(), worker_id: 'backlog_source', lease_ms: 5000 });
  f.setNow('2026-09-05T12:00:05.000Z');
  await f.controlPlane.sweepExpiredLeases();
  await f.controlPlane.claimCleanup(f.principal, { invocation_ref: refs[0], lease_token: f.nextLeaseToken(), worker_id: 'backlog_source', lease_ms: 5000 });
  await f.controlPlane.claimRecovery(f.principal, { invocation_ref: refs[2], lease_token: f.nextLeaseToken(), worker_id: 'backlog_source', lease_ms: 5000 });
  const readSource = () => Promise.all(refs.map((ref) => f.store.getAuditSnapshot('tenant_alpha', ref)));
  const before = await readSource();
  for (const [at, values] of [['2026-09-05T12:00:09.999Z', [2, 1, 0, 0, 0]], ['2026-09-05T12:00:10.000Z', [2, 1, 1, 1, 1]]]) {
    f.setNow(at);
    const snapshot = await f.controlPlane.readCleanupRecoveryBacklog(f.principal);
    assert.equal(snapshot.tenant_id, 'tenant_alpha'); assert.equal(snapshot.snapshot_at, at);
    assert.deepEqual(counts(snapshot), expected(values));
    assert.equal(snapshot.evidence_class, 'control_plane_self_attested'); assert.equal(snapshot.production_qualified, false);
    assert.deepEqual(await readSource(), before);
    assert.deepEqual(counts(await f.controlPlane.readCleanupRecoveryBacklog(f.otherPrincipal)), expected([0, 1, 0, 0, 0]));
    for (const hidden of ['operation', 'invocation_ref', 'provider_id', 'provider_recovery_key', 'lease_token', 'key_hash', otherLease.lease_token]) {
      assert.equal(JSON.stringify(snapshot).includes(hidden), false);
    }
  }
});

test('backlog read rejects forged/wrong-scope principals and inactive source credentials', async () => {
  const f = await createFixture();
  await assert.rejects(f.controlPlane.readCleanupRecoveryBacklog({ ...f.principal }), { code: 'AUTHENTICATION_REQUIRED' });
  await assert.rejects(f.controlPlane.readCleanupRecoveryBacklog(f.recoveryPrincipal), { code: 'AUTHORIZATION_DENIED' });
  await assert.rejects(f.store.readCleanupRecoveryBacklog({ tenant_id: 'tenant_other', claimant_key_id: 'key_alpha' }), { code: 'AUTHENTICATION_FAILED' });
  await assert.rejects(f.store.readCleanupRecoveryBacklog({ tenant_id: 'tenant_alpha', claimant_key_id: 'key_alpha', clock: 0 }));
  f.setNow('2026-09-06T00:00:00.000Z');
  await assert.rejects(f.controlPlane.readCleanupRecoveryBacklog(f.principal), { code: 'AUTHENTICATION_FAILED' });
});

test('memory backlog captures time after exclusive wait and fails expiry rather than emitting old authority', async () => {
  const f = await createFixture({ credentialExpiresAt: '2026-09-05T12:00:01.000Z' });
  let advanced = false;
  const first = f.store.readCleanupRecoveryBacklog({ tenant_id: 'tenant_alpha', claimant_key_id: 'key_alpha' }, { clock() {
    advanced = true; f.setNow('2026-09-05T12:00:01.000Z'); return '2026-09-05T12:00:00.000Z';
  } });
  const second = f.store.readCleanupRecoveryBacklog({ tenant_id: 'tenant_alpha', claimant_key_id: 'key_alpha' }, { clock: () => '2026-09-05T12:00:01.000Z' });
  await first; assert.equal(advanced, true);
  await assert.rejects(second, { code: 'AUTHENTICATION_FAILED' });
});

test('control plane reauthorizes original principal after a source wait and rejects wrong/tampered snapshots', async () => {
  for (const behavior of ['expiry', 'wrong_tenant', 'hash', 'unsupported', 'failure']) {
    const f = await createFixture({ credentialExpiresAt: '2026-09-05T12:00:01.000Z' });
    const read = f.store.readCleanupRecoveryBacklog.bind(f.store);
    if (behavior === 'unsupported') f.store.readCleanupRecoveryBacklog = undefined;
    else f.store.readCleanupRecoveryBacklog = async (...args) => {
      if (behavior === 'failure') throw Object.assign(new Error('dependency unavailable'), { code: 'LOCAL_READ_LOST' });
      const snapshot = await read(...args);
      if (behavior === 'expiry') { f.setNow('2026-09-05T12:00:01.000Z'); return snapshot; }
      if (behavior === 'hash') return { ...snapshot, cleanup_pending_count: 99 };
      return createManagedBacklogSnapshot({ ...fields, tenant_id: 'tenant_other' });
    };
    await assert.rejects(f.controlPlane.readCleanupRecoveryBacklog(f.principal), behavior === 'expiry' ? { code: 'AUTHENTICATION_FAILED' }
      : behavior === 'unsupported' ? { code: 'BACKLOG_OBSERVATION_UNSUPPORTED' } : behavior === 'failure' ? { code: 'LOCAL_READ_LOST' } : undefined);
  }
});

test('OAuth token expiry during source work denies release even when API credential remains active', async () => {
  const f = await createFixture(); let now = '2026-09-05T12:00:00.000Z';
  const auth = createTrustedOAuthAuthenticator({ store: f.store, issuer: 'https://issuer.invalid', audience: 'backlog-fixture', clock: () => new Date(now),
    verify: async () => ({ key_hash: hashManagedApiKey(TEST_TOKEN), key_id: 'key_alpha', tenant_id: 'tenant_alpha',
      issuer: 'https://issuer.invalid', audience: 'backlog-fixture', subject: 'key_alpha', scopes: ['audit:read'],
      not_before: '2026-09-05T11:59:59.000Z', expires_at: '2026-09-05T12:00:01.000Z' }) });
  const principal = await auth.authenticate(`Bearer ${'x'.repeat(32)}`, 'audit:read');
  const control = createManagedRiskForkControlPlane({ config: f.config, store: f.store, providerRegistry: f.providerRegistry,
    requirePrincipal: auth.requirePrincipal, clock: () => new Date(now) });
  const read = f.store.readCleanupRecoveryBacklog.bind(f.store);
  f.store.readCleanupRecoveryBacklog = async (...args) => { const snapshot = await read(...args); now = '2026-09-05T12:00:01.000Z'; return snapshot; };
  await assert.rejects(control.readCleanupRecoveryBacklog(principal), { code: 'AUTHENTICATION_FAILED' });
});

test('source snapshot stays unavailable over both HTTP surfaces and honors default-off control config', async () => {
  const f = await createFixture();
  for (const handle of [createManagedServiceHttpHandler({ controlPlane: f.controlPlane, authenticator: f.authenticator }),
    createManagedWorkerHttpHandler({ controlPlane: f.controlPlane, workerAuthenticator: f.authenticator })]) {
    assert.equal((await handle({ method: 'GET', path: '/v1/cleanup-backlog', headers: { authorization: `Bearer ${TEST_TOKEN}` } })).status, 404);
  }
  const off = createManagedRiskForkControlPlane({ config: createManagedServiceConfig(), store: f.store, providerRegistry: f.providerRegistry,
    requirePrincipal: f.authenticator.requirePrincipal });
  await assert.rejects(off.readCleanupRecoveryBacklog(f.principal), { code: 'MANAGED_SERVICE_DISABLED' });
});
