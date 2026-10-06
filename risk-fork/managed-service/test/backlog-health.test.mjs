import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import pg from 'pg';
import test from 'node:test';
import { sha256Ref } from '../../src/canonical.mjs';
import { quotePostgresAuthorityIdentifier } from '../../src/adapters/postgres-authority-migrator.mjs';
import { createManagedAuthenticator, hashManagedApiKey } from '../src/auth.mjs';
import { createManagedServiceConfig } from '../src/config.mjs';
import { createManagedRiskForkControlPlane } from '../src/control-plane.mjs';
import { createManagedServiceHttpHandler } from '../src/http-handler.mjs';
import { migrateManagedServicePostgres } from '../src/postgres-migrator.mjs';
import { PostgresManagedServiceStore } from '../src/postgres-store.mjs';
import { createManagedProviderRegistry } from '../src/provider-registry.mjs';
import { createFixture, invocationRequest, TestProvider, TEST_TOKEN, WORKER_SCOPES } from './helpers.mjs';

const countFields = ['cleanup_pending_count', 'recovery_required_count',
  'expired_execution_lease_count', 'expired_cleanup_lease_count', 'expired_recovery_lease_count'];
const counts = (health) => Object.fromEntries(countFields.map((field) => [field, health[field]]));
const expectedCounts = (values) => Object.fromEntries(countFields.map((field, index) => [field, values[index]]));

async function prepareCleanup(fixture, ref, leaseToken) {
  await fixture.controlPlane.recordResources(fixture.principal, {
    invocation_ref: ref, lease_token: leaseToken, savepoint_ref: `savepoint_${ref}`, fork_ref: `fork_${ref}`,
  });
  await fixture.controlPlane.recordExecutionOutcome(fixture.principal, {
    invocation_ref: ref, lease_token: leaseToken, outcome: 'succeeded', actual_cost_micros: 0,
    execution_evidence_hash: sha256Ref('health-fixture-execution'), result_hash: sha256Ref('health-fixture-result'),
  });
}

test('memory health counts current obligations at one inclusive clock without mutating them', async () => {
  const f = await createFixture({ concurrency: 8, verifyResourceBinding: async () => true });
  const zero = await f.controlPlane.health();
  assert.deepEqual(counts(zero.storage), expectedCounts([0, 0, 0, 0, 0]));
  assert.equal(zero.storage.snapshot_at, '2026-09-05T12:00:00.000Z');
  const refs = [];
  for (let index = 0; index < 4; index += 1) {
    refs.push((await f.controlPlane.admitInvocation(f.principal,
      invocationRequest({ idempotency_key: `backlog-health-admission-${index}` }))).invocation.invocation_ref);
  }
  const leases = [];
  for (let index = 0; index < refs.length; index += 1) {
    leases.push(await f.controlPlane.claimExecution(f.principal, {
      invocation_ref: refs[index], lease_token: f.nextLeaseToken(`health_${index}`), worker_id: 'health_fixture',
      lease_ms: index < 2 ? 30_000 : index === 2 ? 5_000 : 10_000,
    }));
  }
  await prepareCleanup(f, refs[0], leases[0].lease_token);
  await prepareCleanup(f, refs[1], leases[1].lease_token);
  const cleanupOnly = await f.controlPlane.health();
  assert.equal(cleanupOnly.ready, true, 'cleanup backlog alone preserves existing readiness');
  assert.deepEqual(counts(cleanupOnly.storage), expectedCounts([2, 0, 0, 0, 0]));
  f.setNow('2026-09-05T12:00:05.000Z');
  await f.controlPlane.sweepExpiredLeases();
  await f.controlPlane.claimCleanup(f.principal, {
    invocation_ref: refs[0], lease_token: f.nextLeaseToken('cleanup_health'), worker_id: 'health_fixture', lease_ms: 5_000,
  });
  await f.controlPlane.claimRecovery(f.principal, {
    invocation_ref: refs[2], lease_token: f.nextLeaseToken('recovery_health'), worker_id: 'health_fixture', lease_ms: 5_000,
  });
  const durableSnapshot = async () => Promise.all(refs.map((ref) => f.store.getAuditSnapshot('tenant_alpha', ref)));
  const before = await durableSnapshot();
  for (const [at, expected] of [
    ['2026-09-05T12:00:09.999Z', [2, 1, 0, 0, 0]],
    ['2026-09-05T12:00:10.000Z', [2, 1, 1, 1, 1]],
  ]) {
    f.setNow(at);
    const health = await f.controlPlane.health();
    assert.equal(health.ready, false);
    assert.equal(health.storage.snapshot_at, at);
    assert.deepEqual(counts(health.storage), expectedCounts(expected));
    assert.equal(Object.isFrozen(health.storage), true);
    assert.equal(health.production_qualified, false);
    assert.deepEqual(await durableSnapshot(), before, 'health does not reap, settle or append audit');
  }
  const handle = createManagedServiceHttpHandler({ controlPlane: f.controlPlane, authenticator: f.authenticator });
  const ready = await handle({ method: 'GET', path: '/readyz', headers: {} });
  assert.deepEqual(ready.body, { ready: false, readiness_scope: 'not_ready', production_qualified: false,
    deployed: false, live_traffic_protected: false });
  assert.equal(countFields.some((field) => Object.hasOwn(ready.body, field)), false);
  await f.controlPlane.sweepExpiredLeases();
  const reaped = await f.controlPlane.health();
  assert.deepEqual(counts(reaped.storage), expectedCounts([2, 2, 0, 0, 0]));
  assert.equal(reaped.ready, false, 'reaping an expired lease does not prove resource absence');
});

test('storage health errors remain typed and non-ready without fabricated zero observations', async () => {
  const f = await createFixture();
  f.store.health = async () => { throw Object.assign(new Error('private dependency detail'), { code: 'HEALTH_DEPENDENCY_LOST' }); };
  const health = await f.controlPlane.health();
  assert.deepEqual(health.storage, { ready: false, error_code: 'HEALTH_DEPENDENCY_LOST' });
  assert.equal(health.ready, false);
  assert.equal(JSON.stringify(health).includes('private dependency detail'), false);
});

const connectionString = process.env.RISK_FORK_MANAGED_TEST_POSTGRES_URL;
const skip = !connectionString;
if (skip && process.env.RISK_FORK_MANAGED_REQUIRE_POSTGRES_TESTS === '1') throw new Error('Mandatory backlog health requires PostgreSQL');
if (connectionString) {
  const url = new URL(connectionString);
  if (!['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname)
    || url.pathname !== '/risk_fork_managed_test'
    || process.env.RISK_FORK_MANAGED_TEST_CONFIRM_DISPOSABLE !== 'YES_DELETE_DATA') {
    throw new Error('Backlog health requires an explicit disposable loopback database');
  }
}

async function postgresFixture(run) {
  const schemaName = `backlog_health_${randomUUID().replaceAll('-', '')}`;
  const s = quotePostgresAuthorityIdentifier(schemaName);
  const pool = new pg.Pool({ connectionString, max: 4 });
  try {
    await migrateManagedServicePostgres({ pool, schemaName, requireTls: false });
    await pool.query(`INSERT INTO ${s}.managed_tenants
      (tenant_id,status,daily_budget_micros,max_invocation_cost_micros,max_concurrent_invocations)
      VALUES ('tenant_alpha','active',1000000,500000,8)`);
    await pool.query(`INSERT INTO ${s}.managed_api_keys (key_hash,key_id,tenant_id,scopes,not_before,expires_at)
      VALUES ($1,'key_alpha','tenant_alpha',$2,clock_timestamp()-interval '1 minute',clock_timestamp()+interval '1 hour')`,
    [hashManagedApiKey(TEST_TOKEN), JSON.stringify(['audit:read', 'invocations:read', 'invocations:write', ...WORKER_SCOPES])]);
    const store = new PostgresManagedServiceStore({ pool, schemaName, requireTls: false });
    const authenticator = createManagedAuthenticator({ store });
    const providerRegistry = createManagedProviderRegistry([{ provider: new TestProvider(), enabled: true,
      adapter_digest: sha256Ref('backlog-fixture'), qualification_class: 'local_test', qualification_receipt_hash: sha256Ref('fixture'),
      tenant_ids: ['tenant_alpha'], verify_resource_binding: async () => true,
      verify_cleanup_evidence: async () => true, verify_recovery_absence: async () => true }]);
    const controlPlane = createManagedRiskForkControlPlane({ store, providerRegistry, requirePrincipal: authenticator.requirePrincipal,
      config: createManagedServiceConfig({ enabled: true, environment: 'local_test', limits: { max_concurrent_invocations: 8 } }) });
    const principal = await authenticator.authenticate(`Bearer ${TEST_TOKEN}`, 'invocations:write');
    await run({ store, pool, s, schemaName, controlPlane, principal });
  } finally {
    try {
      await pool.query(`DROP SCHEMA IF EXISTS ${s} CASCADE`);
      assert.equal((await pool.query('SELECT 1 FROM pg_namespace WHERE nspname=$1', [schemaName])).rowCount, 0);
    } finally { await pool.end(); }
  }
}

test('real PostgreSQL health counts all lease classes and preserves durable records', { skip, timeout: 120_000 }, async () => {
  await postgresFixture(async (f) => {
    const zero = await f.store.health('1900-01-01T00:00:00.000Z');
    assert.deepEqual(counts(zero), expectedCounts([0, 0, 0, 0, 0]));
    assert.ok(Date.parse(zero.snapshot_at) > Date.parse('2026-01-01T00:00:00.000Z'), 'PG ignores caller clock');
    const refs = [];
    for (let index = 0; index < 4; index += 1) refs.push((await f.controlPlane.admitInvocation(f.principal,
      invocationRequest({ idempotency_key: `pg-backlog-health-${index}` }))).invocation.invocation_ref);
    const leases = [];
    for (const ref of refs) leases.push(await f.controlPlane.claimExecution(f.principal, {
      invocation_ref: ref, lease_token: randomUUID().replaceAll('-', ''), worker_id: 'backlog_fixture', lease_ms: 30_000,
    }));
    await prepareCleanup(f, refs[0], leases[0].lease_token);
    await prepareCleanup(f, refs[1], leases[1].lease_token);
    await f.pool.query(`UPDATE ${f.s}.managed_invocations SET lease_expires_at=clock_timestamp()-interval '1 second'
      WHERE invocation_ref=$1`, [refs[2]]);
    await f.controlPlane.sweepExpiredLeases();
    await f.controlPlane.claimCleanup(f.principal, { invocation_ref: refs[0], lease_token: randomUUID().replaceAll('-', ''),
      worker_id: 'backlog_fixture', lease_ms: 30_000 });
    await f.controlPlane.claimRecovery(f.principal, { invocation_ref: refs[2], lease_token: randomUUID().replaceAll('-', ''),
      worker_id: 'backlog_fixture', lease_ms: 30_000 });
    const active = await f.store.health();
    assert.deepEqual(counts(active), expectedCounts([2, 1, 0, 0, 0]));
    await f.pool.query(`UPDATE ${f.s}.managed_invocations SET lease_expires_at=clock_timestamp()-interval '1 second'
      WHERE lease_kind IS NOT NULL`);
    const durableSnapshot = async () => {
      const result = {};
      for (const table of ['managed_invocations', 'managed_usage_buckets', 'managed_audit_events',
        'managed_lease_token_uses', 'managed_resource_journal_receipts']) {
        result[table] = (await f.pool.query(`SELECT * FROM ${f.s}.${table} ORDER BY 1,2`)).rows;
      }
      return result;
    };
    const before = await durableSnapshot();
    const expired = await f.controlPlane.health();
    assert.deepEqual(counts(expired.storage), expectedCounts([2, 1, 1, 1, 1]));
    assert.equal(expired.ready, false);
    assert.equal(expired.production_qualified, false);
    assert.deepEqual(await durableSnapshot(), before);
    await f.controlPlane.sweepExpiredLeases();
    const reaped = await f.store.health();
    assert.deepEqual(counts(reaped), expectedCounts([2, 2, 0, 0, 0]));
  });
});

test('real PostgreSQL health retains one state snapshot across concurrent catalog/count reads', { skip, timeout: 120_000 }, async () => {
  await postgresFixture(async (f) => {
    const ref = (await f.controlPlane.admitInvocation(f.principal, invocationRequest())).invocation.invocation_ref;
    // Synthetic local state transition isolates health MVCC; it is not provider evidence.
    await f.pool.query(`UPDATE ${f.s}.managed_invocations SET state='cleanup_pending' WHERE invocation_ref=$1`, [ref]);
    let interleaved = false;
    const pausedPool = { async connect() {
      const client = await f.pool.connect();
      return { release: () => client.release(), async query(sql, params) {
        const result = await client.query(sql, params);
        if (sql.includes('information_schema.tables') && !interleaved) {
          interleaved = true;
          await f.pool.query(`UPDATE ${f.s}.managed_invocations SET state='recovery_required' WHERE invocation_ref=$1`, [ref]);
        }
        return result;
      } };
    } };
    const snapshotStore = new PostgresManagedServiceStore({ pool: pausedPool, schemaName: f.schemaName, requireTls: false });
    const before = await snapshotStore.health();
    assert.equal(interleaved, true);
    assert.deepEqual(counts(before), expectedCounts([1, 0, 0, 0, 0]));
    assert.equal(before.ready, true);
    const after = await f.store.health();
    assert.deepEqual(counts(after), expectedCounts([0, 1, 0, 0, 0]));
    assert.equal(after.ready, false);
  });
});

test('PostgreSQL health rolls back and releases a failed read rather than returning zero counts', async () => {
  const queries = []; let released = false;
  const store = new PostgresManagedServiceStore({ requireTls: false, pool: { async connect() { return {
    async query(sql) {
      queries.push(sql);
      if (sql.includes('information_schema.tables')) throw Object.assign(new Error('unavailable'), { code: 'HEALTH_READ_LOST' });
      return { rowCount: 0, rows: [] };
    }, release() { released = true; },
  }; } } });
  await assert.rejects(store.health(), { code: 'HEALTH_READ_LOST' });
  assert.equal(queries[0], 'BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
  assert.equal(queries.at(-1), 'ROLLBACK');
  assert.equal(queries.includes('COMMIT'), false);
  assert.equal(released, true);
});
