import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import pg from 'pg';
import test from 'node:test';
import { createManagedAuthenticator, hashManagedApiKey } from '../src/auth.mjs';
import { createManagedServiceConfig } from '../src/config.mjs';
import { createManagedRiskForkControlPlane } from '../src/control-plane.mjs';
import { createManagedProviderRegistry } from '../src/provider-registry.mjs';
import { PostgresManagedServiceStore } from '../src/postgres-store.mjs';
import { migrateManagedServicePostgres } from '../src/postgres-migrator.mjs';
import { MANAGED_BACKLOG_COUNT_FIELDS, normalizeManagedBacklogSnapshot } from '../src/backlog-snapshot.mjs';
import { quotePostgresAuthorityIdentifier } from '../../src/adapters/postgres-authority-migrator.mjs';
import { sha256Ref } from '../../src/canonical.mjs';
import { invocationRequest, TestProvider, TEST_TOKEN, OTHER_TOKEN, WORKER_SCOPES } from './helpers.mjs';

const connectionString = process.env.RISK_FORK_MANAGED_TEST_POSTGRES_URL;
const skip = !connectionString;
if (skip && process.env.RISK_FORK_MANAGED_REQUIRE_POSTGRES_TESTS === '1') throw new Error('Mandatory backlog snapshot coverage requires PostgreSQL');
if (connectionString) {
  const url = new URL(connectionString);
  if (!['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname) || url.pathname !== '/risk_fork_managed_test'
    || process.env.RISK_FORK_MANAGED_TEST_CONFIRM_DISPOSABLE !== 'YES_DELETE_DATA') throw new Error('Backlog snapshots require an explicit disposable loopback database');
}
const counts = (snapshot) => MANAGED_BACKLOG_COUNT_FIELDS.map((field) => snapshot[field]);
const input = { tenant_id: 'tenant_alpha', claimant_key_id: 'key_alpha' };

async function fixture(run) {
  const schemaName = `backlog_snapshot_${randomUUID().replaceAll('-', '')}`, s = quotePostgresAuthorityIdentifier(schemaName);
  const pool = new pg.Pool({ connectionString, max: 4 });
  try {
    await migrateManagedServicePostgres({ pool, schemaName, requireTls: false });
    await pool.query(`INSERT INTO ${s}.managed_tenants (tenant_id,status,daily_budget_micros,max_invocation_cost_micros,max_concurrent_invocations)
      VALUES ('tenant_alpha','active',1000000,500000,8), ('tenant_other','active',1000000,500000,8)`);
    for (const [tenant, key, token] of [['tenant_alpha', 'key_alpha', TEST_TOKEN], ['tenant_other', 'key_other', OTHER_TOKEN]]) {
      await pool.query(`INSERT INTO ${s}.managed_api_keys (key_hash,key_id,tenant_id,scopes,not_before,expires_at)
        VALUES ($1,$2,$3,$4,clock_timestamp()-interval '1 minute',clock_timestamp()+interval '1 hour')`,
      [hashManagedApiKey(token), key, tenant, JSON.stringify(['audit:read', 'invocations:write', ...WORKER_SCOPES])]);
    }
    const store = new PostgresManagedServiceStore({ pool, schemaName, requireTls: false });
    const auth = createManagedAuthenticator({ store });
    const providerRegistry = createManagedProviderRegistry([{ provider: new TestProvider(), enabled: true, adapter_digest: sha256Ref('backlog-fixture'),
      qualification_class: 'local_test', qualification_receipt_hash: sha256Ref('fixture'), tenant_ids: ['tenant_alpha', 'tenant_other'],
      verify_resource_binding: async () => true, verify_cleanup_evidence: async () => true, verify_recovery_absence: async () => true }]);
    const control = createManagedRiskForkControlPlane({ config: createManagedServiceConfig({ enabled: true, environment: 'local_test' }),
      store, providerRegistry, requirePrincipal: auth.requirePrincipal });
    const principal = await auth.authenticate(`Bearer ${TEST_TOKEN}`, 'invocations:write');
    const other = await auth.authenticate(`Bearer ${OTHER_TOKEN}`, 'invocations:write');
    await run({ store, pool, s, schemaName, control, principal, other, auth, providerRegistry });
  } finally {
    try { await pool.query(`DROP SCHEMA IF EXISTS ${s} CASCADE`); assert.equal((await pool.query('SELECT 1 FROM pg_namespace WHERE nspname=$1', [schemaName])).rowCount, 0); }
    finally { await pool.end(); }
  }
}

test('real PG snapshots read tenant state directly, never use global health/telemetry or mutate custody', { skip, timeout: 120_000 }, async () => {
  await fixture(async (f) => {
    assert.deepEqual(counts(await f.control.readCleanupRecoveryBacklog(f.principal)), [0, 0, 0, 0, 0]);
    const refs = [];
    for (let index = 0; index < 4; index += 1) refs.push((await f.control.admitInvocation(f.principal,
      invocationRequest({ idempotency_key: `postgres-backlog-source-${index}` }))).invocation.invocation_ref);
    const otherRef = (await f.control.admitInvocation(f.other, invocationRequest())).invocation.invocation_ref;
    // Synthetic source-state setup isolates the aggregate; it is not provider evidence.
    await f.pool.query(`UPDATE ${f.s}.managed_invocations SET state=CASE WHEN invocation_ref=$1 THEN 'recovery_required' ELSE 'cleanup_pending' END
      WHERE invocation_ref=ANY($2::text[])`, [refs[2], [refs[0], refs[1], refs[2], otherRef]]);
    await f.pool.query(`UPDATE ${f.s}.managed_invocations SET lease_kind=$2,lease_owner='key_alpha',lease_token_hash=$3,
      lease_generation=1,lease_expires_at=clock_timestamp()-interval '1 second' WHERE invocation_ref=$1`, [refs[0], 'cleanup', sha256Ref('cleanup')]);
    await f.pool.query(`UPDATE ${f.s}.managed_invocations SET lease_kind=$2,lease_owner='key_alpha',lease_token_hash=$3,
      lease_generation=1,lease_expires_at=clock_timestamp()-interval '1 second' WHERE invocation_ref=$1`, [refs[2], 'recovery', sha256Ref('recovery')]);
    await assert.rejects(f.control.claimExecution(f.principal, { invocation_ref: refs[3], lease_token: randomUUID().replaceAll('-', ''),
      worker_id: 'snapshot_fixture', lease_ms: 30000 }), { code: 'TENANT_RECOVERY_REQUIRED' });
    await f.pool.query(`UPDATE ${f.s}.managed_invocations SET state='execution_leased',lease_kind='execution',lease_owner='key_alpha',
      lease_token_hash=$2,lease_generation=1,lease_expires_at=clock_timestamp()-interval '1 second' WHERE invocation_ref=$1`, [refs[3], sha256Ref('execution')]);
    const durable = async () => {
      const result = {};
      for (const table of ['managed_invocations', 'managed_audit_events', 'managed_usage_buckets', 'managed_lease_token_uses', 'managed_resource_journal_receipts']) {
        result[table] = (await f.pool.query(`SELECT * FROM ${f.s}.${table} ORDER BY 1,2`)).rows;
      }
      return result;
    };
    const before = await durable();
    const alpha = await f.control.readCleanupRecoveryBacklog(f.principal);
    assert.deepEqual(counts(alpha), [2, 1, 1, 1, 1]);
    assert.deepEqual(normalizeManagedBacklogSnapshot(alpha, 'tenant_alpha'), alpha);
    assert.deepEqual(counts(await f.control.readCleanupRecoveryBacklog(f.other)), [1, 0, 0, 0, 0]);
    assert.deepEqual(await durable(), before);
    assert.equal(alpha.production_qualified, false);
    await f.pool.query(`UPDATE ${f.s}.managed_tenants SET status='suspended' WHERE tenant_id='tenant_alpha'`);
    assert.deepEqual(counts(await f.control.readCleanupRecoveryBacklog(f.principal)), [2, 1, 1, 1, 1]);
    await assert.rejects(f.store.readCleanupRecoveryBacklog({ tenant_id: 'tenant_other', claimant_key_id: 'key_alpha' }), { code: 'AUTHENTICATION_FAILED' });
  });
});

test('real PG aggregate uses one MVCC view while a concurrent transition commits', { skip, timeout: 120_000 }, async () => {
  await fixture(async (f) => {
    const ref = (await f.control.admitInvocation(f.principal, invocationRequest())).invocation.invocation_ref;
    await f.pool.query(`UPDATE ${f.s}.managed_invocations SET state='cleanup_pending' WHERE invocation_ref=$1`, [ref]);
    let interleaved = false;
    const pool = { async connect() {
      const client = await f.pool.connect();
      return { release: () => client.release(), async query(sql, params) {
        const result = await client.query(sql, params);
        if (sql.includes('WITH source_clock') && !interleaved) {
          interleaved = true;
          await f.pool.query(`UPDATE ${f.s}.managed_invocations SET state='recovery_required' WHERE invocation_ref=$1`, [ref]);
        }
        return result;
      } };
    } };
    const source = new PostgresManagedServiceStore({ pool, schemaName: f.schemaName, requireTls: false });
    assert.deepEqual(counts(await source.readCleanupRecoveryBacklog(input)), [1, 0, 0, 0, 0]);
    assert.equal(interleaved, true);
    assert.deepEqual(counts(await f.store.readCleanupRecoveryBacklog(input)), [0, 1, 0, 0, 0]);
  });
});

test('real PG store rejects revoked, removed-scope and expired observation credentials', { skip, timeout: 120_000 }, async () => {
  await fixture(async (f) => {
    for (const patch of ["revoked_at=clock_timestamp()", "scopes='[]'::jsonb", "expires_at=clock_timestamp()-interval '1 second'"]) {
      await f.pool.query(`UPDATE ${f.s}.managed_api_keys SET ${patch} WHERE key_id='key_alpha'`);
      await assert.rejects(f.store.readCleanupRecoveryBacklog(input), { code: 'AUTHENTICATION_FAILED' });
      await f.pool.query(`UPDATE ${f.s}.managed_api_keys SET revoked_at=NULL,scopes='["audit:read"]'::jsonb,expires_at=clock_timestamp()+interval '1 hour'
        WHERE key_id='key_alpha'`);
    }
  });
});

test('real PG control rechecks credential revocation after a retained read snapshot', { skip, timeout: 120_000 }, async () => {
  await fixture(async (f) => {
    const read = f.store.readCleanupRecoveryBacklog.bind(f.store);
    f.store.readCleanupRecoveryBacklog = async (...args) => {
      const snapshot = await read(...args);
      await f.pool.query(`UPDATE ${f.s}.managed_api_keys SET revoked_at=clock_timestamp() WHERE key_id='key_alpha'`);
      return snapshot;
    };
    await assert.rejects(f.control.readCleanupRecoveryBacklog(f.principal), { code: 'AUTHENTICATION_FAILED' });
  });
});

test('PG dependency loss/malformed counts roll back, release and never invent zero backlog', async () => {
  for (const behavior of ['dependency', 'malformed', 'no_authority']) {
    const queries = []; let released = false;
    const pool = { async connect() { return { release() { released = true; }, async query(sql) {
      queries.push(sql);
      if (sql.includes('WITH source_clock')) {
        if (behavior === 'dependency') throw Object.assign(new Error('dependency lost'), { code: 'LOCAL_SNAPSHOT_LOST' });
        if (behavior === 'no_authority') return { rowCount: 0, rows: [] };
        return { rowCount: 1, rows: [{ snapshot_at: new Date(), cleanup_pending_count: 'NaN' }] };
      }
      return { rowCount: 0, rows: [] };
    } }; } };
    const source = new PostgresManagedServiceStore({ pool, requireTls: false });
    await assert.rejects(source.readCleanupRecoveryBacklog(input));
    assert.equal(queries[0], 'BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
    assert.equal(queries.at(-1), 'ROLLBACK'); assert.equal(queries.includes('COMMIT'), false); assert.equal(released, true);
  }
});
