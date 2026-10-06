import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { setTimeout as pause } from 'node:timers/promises';
import pg from 'pg';
import { sha256Ref } from '../../src/canonical.mjs';
import { quotePostgresAuthorityIdentifier as qid } from '../../src/adapters/postgres-authority-migrator.mjs';
import { createCleanupVerificationEvidence } from '../../src/provider.mjs';
import { createManagedAuthenticator, hashManagedApiKey } from '../src/auth.mjs';
import { createManagedServiceConfig } from '../src/config.mjs';
import { createManagedRiskForkControlPlane } from '../src/control-plane.mjs';
import { createManagedProviderRegistry } from '../src/provider-registry.mjs';
import { migrateManagedServicePostgres } from '../src/postgres-migrator.mjs';
import { PostgresManagedServiceStore } from '../src/postgres-store.mjs';
import { TestProvider, TEST_TOKEN, WORKER_SCOPES, invocationRequest } from './helpers.mjs';
import { waitForDisposableDatabaseDrain } from './disposable-database-drain.mjs';

const connectionString = process.env.RISK_FORK_MANAGED_TEST_POSTGRES_URL;
let skip = true;
if (connectionString) {
  const url = new URL(connectionString);
  if (!['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname)
    || url.pathname !== '/risk_fork_managed_test'
    || process.env.RISK_FORK_MANAGED_TEST_CONFIRM_DISPOSABLE !== 'YES_DELETE_DATA') {
    throw new Error('Cleanup incomplete tests require an explicit disposable loopback database');
  }
  skip = false;
}
if (skip && process.env.RISK_FORK_MANAGED_REQUIRE_POSTGRES_TESTS === '1') throw new Error('Mandatory cleanup incomplete PostgreSQL tests require a database');
const suffix = () => randomUUID().replaceAll('-', '').slice(0, 18);
const token = () => randomBytes(32).toString('base64url');

async function fixture(run) {
  const database = `risk_fork_control_role_${suffix()}`;
  const schemaName = `cleanup_incomplete_${suffix()}`; const s = qid(schemaName);
  const migrator = `cleanup_migrator_${suffix()}`; const runtime = `cleanup_runtime_${suffix()}`;
  const root = new pg.Pool({ connectionString, max: 4 }); const pools = []; let created = false;
  const child = new URL(connectionString); child.pathname = `/${database}`;
  const admin = new pg.Pool({ connectionString: child.toString(), max: 5 }); pools.push(admin);
  const makeRolePool = (role, password) => {
    const url = new URL(child); url.username = role; url.password = password;
    const pool = new pg.Pool({ connectionString: url.toString(), max: 4, application_name: 'rf_cleanup_incomplete_runtime' });
    pools.push(pool); return pool;
  };
  const migrationPassword = token(); const runtimePassword = token();
  const replacement = (sql) => sql.replaceAll('__RISK_FORK_MANAGED_DATABASE__', database)
    .replaceAll('__RISK_FORK_MANAGED_SCHEMA__', schemaName)
    .replaceAll('__RISK_FORK_MANAGED_MIGRATOR_ROLE__', migrator)
    .replaceAll('__RISK_FORK_MANAGED_RUNTIME_ROLE__', runtime);
  try {
    await root.query(`CREATE DATABASE ${qid(database)}`); created = true;
    await admin.query(`CREATE ROLE ${qid(migrator)} LOGIN NOINHERIT PASSWORD '${migrationPassword}'`);
    await admin.query(`CREATE ROLE ${qid(runtime)} LOGIN NOINHERIT PASSWORD '${runtimePassword}'`);
    await admin.query(replacement(await readFile(new URL('../ops/postgres/control-plane-owner-bootstrap.sql.template', import.meta.url), 'utf8')));
    const migrationPool = makeRolePool(migrator, migrationPassword); const runtimePool = makeRolePool(runtime, runtimePassword);
    await migrateManagedServicePostgres({ pool: migrationPool, schemaName, requireTls: false });
    await migrationPool.query(replacement(await readFile(new URL('../ops/postgres/control-plane-roles.sql.template', import.meta.url), 'utf8')));
    await admin.query(`INSERT INTO ${s}.managed_tenants (tenant_id,status,daily_budget_micros,max_invocation_cost_micros,max_concurrent_invocations)
      VALUES ('tenant_alpha','active',1000000,500000,4)`);
    await admin.query(`INSERT INTO ${s}.managed_api_keys (key_hash,key_id,tenant_id,scopes,not_before,expires_at)
      VALUES ($1,'key_alpha','tenant_alpha',$2,clock_timestamp()-interval '1 minute',clock_timestamp()+interval '1 hour')`,
    [hashManagedApiKey(TEST_TOKEN), JSON.stringify(['audit:read','invocations:read','invocations:write', ...WORKER_SCOPES])]);
    const makeStore = (pool = runtimePool) => new PostgresManagedServiceStore({ pool, schemaName, requireTls: false, expectedOwner: migrator });
    const store = makeStore(); await store.initialize();
    const auth = createManagedAuthenticator({ store });
    const registry = createManagedProviderRegistry([{ provider: new TestProvider(), enabled: true,
      adapter_digest: sha256Ref('cleanup incomplete fixture'), qualification_class: 'local_test',
      qualification_receipt_hash: sha256Ref('fixture'), tenant_ids: ['tenant_alpha'],
      verify_resource_binding: async () => true, verify_cleanup_evidence: async () => true,
      verify_recovery_absence: async () => true }]);
    const control = createManagedRiskForkControlPlane({ store, providerRegistry: registry, requirePrincipal: auth.requirePrincipal,
      config: createManagedServiceConfig({ enabled: true, environment: 'local_test' }) });
    const principal = await auth.authenticate(`Bearer ${TEST_TOKEN}`, 'invocations:write');
    const admitted = (await control.admitInvocation(principal, invocationRequest())).invocation;
    const execution = await control.claimExecution(principal, { invocation_ref: admitted.invocation_ref,
      lease_token: token(), worker_id: 'pg_incomplete_execution', lease_ms: 30_000 });
    await control.recordResources(principal, { invocation_ref: admitted.invocation_ref, lease_token: execution.lease_token,
      savepoint_ref: 'pg_incomplete_savepoint', fork_ref: 'pg_incomplete_fork' });
    await control.recordExecutionOutcome(principal, { invocation_ref: admitted.invocation_ref, lease_token: execution.lease_token,
      outcome: 'succeeded', actual_cost_micros: 0, execution_evidence_hash: sha256Ref('execution'), result_hash: sha256Ref('result') });
    const lease = await control.claimCleanup(principal, { invocation_ref: admitted.invocation_ref,
      lease_token: token(), worker_id: 'pg_incomplete_cleanup', lease_ms: 30_000 });
    const input = { invocation_ref: admitted.invocation_ref, lease_token: lease.lease_token, lease_generation: lease.invocation.lease_generation };
    const storeInput = () => ({ tenant_id: 'tenant_alpha', claimant_key_id: 'key_alpha', invocation_ref: input.invocation_ref,
      lease_generation: input.lease_generation, now: new Date().toISOString(),
      lease_token_hash: `sha256:${createHash('sha256').update('agoragentic-risk-fork-managed-lease-v1\0').update(input.lease_token).digest('hex')}` });
    const snapshot = () => store.getAuditSnapshot('tenant_alpha', input.invocation_ref);
    const waitForLock = async () => {
      for (let attempt = 0; attempt < 100; attempt += 1) {
        const result = await root.query(`SELECT count(*)::integer AS n FROM pg_stat_activity
          WHERE datname=$1 AND application_name='rf_cleanup_incomplete_runtime' AND wait_event_type='Lock'`, [database]);
        if (result.rows[0].n > 0) return;
        await pause(10);
      }
      throw new Error('Expected cleanup authority lock wait was not observed');
    };
    await run({ admin, s, store, makeStore, control, principal, input, lease, storeInput, snapshot, runtimePool, waitForLock });
  } finally {
    const failures = []; const attempt = async (action) => { try { await action(); } catch (error) { failures.push(error); } };
    for (const pool of pools.reverse()) await attempt(() => pool.end());
    if (created) await attempt(async () => { await waitForDisposableDatabaseDrain(root, database); await root.query(`DROP DATABASE ${qid(database)}`); });
    for (const role of [runtime, migrator]) await attempt(() => root.query(`DROP ROLE IF EXISTS ${qid(role)}`));
    await attempt(async () => {
      assert.equal((await root.query('SELECT 1 FROM pg_database WHERE datname=$1', [database])).rowCount, 0);
      assert.equal((await root.query('SELECT 1 FROM pg_roles WHERE rolname=ANY($1::text[])', [[runtime, migrator]])).rowCount, 0);
    });
    await attempt(() => root.end()); if (failures.length) throw new AggregateError(failures, 'Cleanup incomplete disposable role cleanup failed');
  }
}

test('separate-runtime PostgreSQL cleanup observation survives concurrent and COMMIT-then-lost response replay unchanged', { skip, timeout: 120_000 }, async () => {
  await fixture(async ({ store, makeStore, control, principal, input, storeInput, snapshot, runtimePool }) => {
    const before = await snapshot(); let armed = true;
    const lostPool = { async connect() { const client = await runtimePool.connect(); return { release: () => client.release(),
      query: async (sql, params) => { const result = await client.query(sql, params); if (armed && sql === 'COMMIT') { armed = false; throw new Error('lost cleanup observation COMMIT'); } return result; } }; } };
    const lostStore = makeStore(lostPool);
    await assert.rejects(lostStore.recordCleanupIncomplete(storeInput()));
    const restart = makeStore(); await restart.initialize();
    const [a, b] = await Promise.all([store.recordCleanupIncomplete(storeInput()), restart.recordCleanupIncomplete(storeInput())]);
    assert.deepEqual(a, b); const after = await snapshot();
    assert.equal(after.events.filter((event) => event.event_type === 'cleanup_incomplete').length, 1);
    assert.deepEqual({ ...after.invocation, audit_event_count: before.invocation.audit_event_count,
      audit_head_hash: before.invocation.audit_head_hash }, before.invocation);
    await control.renewLease(principal, { invocation_ref: input.invocation_ref, lease_token: input.lease_token, lease_ms: 30_000 });
    assert.deepEqual(await control.recordCleanupIncomplete(principal, input), a);
    assert.equal((await control.listAuditEvents(principal, input.invocation_ref)).filter((event) => event.event_type === 'cleanup_incomplete').length, 1);
    for (const secret of [input.lease_token, TEST_TOKEN, 'pg_incomplete_fork', 'pg_incomplete_savepoint']) assert.equal(JSON.stringify(a).includes(secret), false);
    for (const changed of [{ lease_generation: input.lease_generation + 1 }, { claimant_key_id: 'wrong_owner' },
      { lease_token_hash: sha256Ref('wrong token') }, { tenant_id: 'wrong_tenant' }]) {
      const current = await snapshot(); await assert.rejects(store.recordCleanupIncomplete({ ...storeInput(), ...changed }));
      assert.deepEqual(await snapshot(), current);
    }
  });
});

for (const scenario of ['lease_expiry', 'credential_expiry', 'revocation', 'scope_withdrawal']) {
  test(`cleanup observation rechecks ${scenario} after a real PostgreSQL authority lock wait, including retained replay`, { skip, timeout: 120_000 }, async () => {
    await fixture(async ({ admin, s, store, storeInput, snapshot, waitForLock }) => {
      await store.recordCleanupIncomplete(storeInput()); const blocker = await admin.connect();
      let pending;
      try {
        if (scenario === 'lease_expiry') await admin.query(`UPDATE ${s}.managed_invocations SET lease_expires_at=clock_timestamp()+interval '400 milliseconds'`);
        if (scenario === 'credential_expiry') await admin.query(`UPDATE ${s}.managed_api_keys SET expires_at=clock_timestamp()+interval '400 milliseconds'`);
        const before = await snapshot();
        await blocker.query('BEGIN');
        if (scenario === 'lease_expiry') await blocker.query(`SELECT invocation_ref FROM ${s}.managed_invocations FOR UPDATE`);
        else if (scenario === 'credential_expiry') await blocker.query(`SELECT key_id FROM ${s}.managed_api_keys FOR UPDATE`);
        else await blocker.query(`UPDATE ${s}.managed_api_keys SET ${scenario === 'revocation' ? 'revoked_at=clock_timestamp()' : "scopes='[]'::jsonb"}`);
        // Attach rejection handling immediately while the lock is held.
        pending = store.recordCleanupIncomplete(storeInput()).then((value) => ({ value }), (error) => ({ error }));
        await waitForLock(); if (scenario.endsWith('expiry')) await pause(500);
        await blocker.query('COMMIT'); const result = await pending;
        assert.ok(result.error); assert.equal(result.value, undefined);
        assert.equal(result.error.code, scenario === 'lease_expiry' ? 'LEASE_EXPIRED' : 'AUTHENTICATION_FAILED');
        assert.deepEqual(await snapshot(), before);
      } finally { await blocker.query('ROLLBACK').catch(() => {}); blocker.release(); if (pending) await pending; }
    });
  });
}

test('terminal cleanup, incomplete-attempt replay, and catalog drift cannot grant observation authority', { skip, timeout: 120_000 }, async () => {
  await fixture(async ({ control, principal, input, lease, store, admin, s, storeInput, snapshot }) => {
    await control.recordCleanupIncomplete(principal, input);
    const evidence = lease.invocation.cleanup_requests.map((request, index) => createCleanupVerificationEvidence(request, {
      status: 'verified', observed_at: new Date().toISOString(), evidence_ref: `pg_incomplete_terminal_${index}`,
      observation_hash: sha256Ref({ index }) }));
    await control.completeCleanup(principal, { invocation_ref: input.invocation_ref, lease_token: input.lease_token, cleanup_evidence: evidence });
    const before = await snapshot(); await assert.rejects(store.recordCleanupIncomplete(storeInput()), { code: 'CLEANUP_LEASE_REQUIRED' });
    assert.deepEqual(await snapshot(), before);
    await admin.query(`ALTER TABLE ${s}.managed_invocations ADD COLUMN unreviewed_observation text`);
    await assert.rejects(store.recordCleanupIncomplete(storeInput()), { code: 'MANAGED_POSTGRES_ATTESTATION_FAILED' });
    assert.equal((await admin.query(`SELECT count(*)::integer AS n FROM ${s}.managed_audit_events WHERE event_type='cleanup_incomplete'`)).rows[0].n, 1);
  });
});
