import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import test from 'node:test';
import { sha256Ref } from '../../src/canonical.mjs';
import { createCleanupVerificationEvidence } from '../../src/provider.mjs';
import { createPostgresAuthorityPool, quotePostgresAuthorityIdentifier } from '../../src/adapters/postgres-authority-migrator.mjs';
import { createManagedAuthenticator, hashManagedApiKey } from '../src/auth.mjs';
import { createManagedServiceConfig } from '../src/config.mjs';
import { createManagedRiskForkControlPlane } from '../src/control-plane.mjs';
import { migrateManagedServicePostgres } from '../src/postgres-migrator.mjs';
import { PostgresManagedServiceStore } from '../src/postgres-store.mjs';
import { createManagedProviderRegistry } from '../src/provider-registry.mjs';
import { invocationRequest, testLeaseToken, TestProvider, TEST_TOKEN } from './helpers.mjs';

const connectionString = process.env.RISK_FORK_MANAGED_TEST_POSTGRES_URL;
let skip = 'An explicit disposable loopback risk_fork_managed_test database is required';
try {
  const url = new URL(connectionString);
  if (['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname)
    && url.pathname === '/risk_fork_managed_test'
    && process.env.RISK_FORK_MANAGED_TEST_CONFIRM_DISPOSABLE === 'YES_DELETE_DATA') skip = false;
} catch { /* Absence or an invalid URL must never select another database. */ }
if (skip && process.env.RISK_FORK_MANAGED_REQUIRE_POSTGRES_TESTS === '1') throw new Error(skip);

const scopes = ['audit:read', 'invocations:read', 'invocations:write', 'worker:claim', 'worker:write'];
const denied = (error) => ['AUTHENTICATION_FAILED', 'AUTHORIZATION_DENIED'].includes(error.code);
const leaseHash = (token) => `sha256:${createHash('sha256')
  .update('agoragentic-risk-fork-managed-lease-v1\0').update(token).digest('hex')}`;

async function fixture(t) {
  const schemaName = `risk_fork_scope_test_${randomUUID().replaceAll('-', '')}`;
  const schema = quotePostgresAuthorityIdentifier(schemaName);
  const pool = await createPostgresAuthorityPool({ connectionString, requireTls: false, maxConnections: 4 });
  t.after(async () => {
    try { await pool.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`); }
    finally { await pool.end(); }
  });
  await migrateManagedServicePostgres({ pool, schemaName, requireTls: false });
  await pool.query(`INSERT INTO ${schema}.managed_tenants
    (tenant_id, status, daily_budget_micros, max_invocation_cost_micros, max_concurrent_invocations)
    VALUES ('tenant_alpha', 'active', 1000000, 500000, 4)`);
  await pool.query(`INSERT INTO ${schema}.managed_api_keys
    (key_hash, key_id, tenant_id, scopes, not_before, expires_at)
    VALUES ($1, 'key_alpha', 'tenant_alpha', $2::jsonb,
      clock_timestamp() - interval '1 minute', clock_timestamp() + interval '1 hour')`,
  [hashManagedApiKey(TEST_TOKEN), JSON.stringify(scopes)]);
  const setScopes = async (next) => pool.query(
    `UPDATE ${schema}.managed_api_keys SET scopes = $1::jsonb WHERE key_id = 'key_alpha'`,
    [JSON.stringify(next)],
  );
  const hooks = { resource: async () => {}, cleanup: async () => {} };
  const providerRegistry = createManagedProviderRegistry([{
    provider: new TestProvider(), enabled: true,
    adapter_digest: sha256Ref({ fixture: 'worker-scopes' }), qualification_class: 'local_test',
    qualification_receipt_hash: sha256Ref({ test: true }), tenant_ids: ['tenant_alpha'],
    verify_resource_binding: async () => { await hooks.resource(); return true; },
    verify_cleanup_evidence: async () => { await hooks.cleanup(); return true; },
    verify_recovery_absence: async () => false,
  }]);
  function restart() {
    const store = new PostgresManagedServiceStore({ pool, schemaName, requireTls: false });
    const auth = createManagedAuthenticator({ store });
    const control = createManagedRiskForkControlPlane({
      config: createManagedServiceConfig({ enabled: true, environment: 'local_test' }),
      store, providerRegistry, requirePrincipal: auth.requirePrincipal,
    });
    return { store, auth, control };
  }
  const current = restart();
  const principal = await current.auth.authenticate(`Bearer ${TEST_TOKEN}`, 'invocations:write');
  const { invocation } = await current.control.admitInvocation(principal, invocationRequest());
  const token = testLeaseToken('scoped_pg');
  const claimRequest = { invocation_ref: invocation.invocation_ref, lease_token: token,
    worker_id: 'worker_scope_test', lease_ms: 120_000 };
  const resources = { invocation_ref: invocation.invocation_ref, lease_token: token,
    savepoint_ref: 'savepoint_scope', fork_ref: 'fork_scope' };
  const base = { tenant_id: 'tenant_alpha', claimant_key_id: 'key_alpha',
    invocation_ref: invocation.invocation_ref, lease_token_hash: leaseHash(token) };
  return { ...current, pool, schema, schemaName, setScopes, hooks, restart, principal, invocation,
    claimRequest, resources, base };
}

test('PostgreSQL checks current scopes at the store boundary, including claim replays', { skip }, async (t) => {
  const f = await fixture(t);
  // Withdraw authority after application authentication, before store admission.
  const originalClaim = f.store.claimLease.bind(f.store);
  let captured;
  f.store.claimLease = async (input) => {
    captured = input;
    await f.setScopes(scopes.filter((scope) => scope !== 'worker:claim'));
    return originalClaim(input);
  };
  await assert.rejects(f.control.claimExecution(f.principal, f.claimRequest), denied);
  assert.deepEqual(await f.store.getInvocation('tenant_alpha', f.invocation.invocation_ref), f.invocation);
  f.store.claimLease = originalClaim;
  await f.setScopes(scopes);
  const first = await f.control.claimExecution(f.principal, f.claimRequest);
  await f.setScopes(scopes.filter((scope) => scope !== 'worker:claim'));
  await assert.rejects(originalClaim(captured), denied);
  assert.equal((await f.store.getAuditSnapshot('tenant_alpha', f.invocation.invocation_ref)).events.length, 2);
  await f.setScopes(scopes);
  const replay = await f.control.claimExecution(f.principal, f.claimRequest);
  assert.equal(replay.claim_replayed, true);
  assert.deepEqual(replay.invocation, first.invocation);
});

test('PostgreSQL blocks a scope withdrawn during provider verification without journaling resources', { skip }, async (t) => {
  const f = await fixture(t);
  await f.control.claimExecution(f.principal, f.claimRequest);
  const before = await f.store.getAuditSnapshot('tenant_alpha', f.invocation.invocation_ref);
  f.hooks.resource = () => f.setScopes(scopes.filter((scope) => scope !== 'worker:write'));
  await assert.rejects(f.control.recordResources(f.principal, f.resources), denied);
  assert.deepEqual(await f.store.getAuditSnapshot('tenant_alpha', f.invocation.invocation_ref), before);
  const receipts = await f.pool.query(`SELECT count(*)::int AS count FROM ${f.schema}.managed_resource_journal_receipts`);
  assert.equal(receipts.rows[0].count, 0);
  f.hooks.resource = async () => {};
  await f.setScopes(scopes);
  assert.equal((await f.control.recordResources(f.principal, f.resources)).state, 'running');
});

test('PostgreSQL rejects withdrawn write authority for renewal, preflight, settlement and restart receipt replay', { skip }, async (t) => {
  const f = await fixture(t);
  await f.control.claimExecution(f.principal, f.claimRequest);
  let journalInput;
  const transition = f.store.transitionInvocation.bind(f.store);
  f.store.transitionInvocation = async (input) => { journalInput = input; return transition(input); };
  const running = await f.control.recordResources(f.principal, f.resources);
  const before = await f.store.getAuditSnapshot('tenant_alpha', f.invocation.invocation_ref);
  await f.setScopes(scopes.filter((scope) => scope !== 'worker:write'));
  const { store } = f.restart();
  const base = { ...f.base, now: new Date().toISOString() };
  for (const operation of [
    () => store.assertActiveLease({ ...base, lease_kind: 'execution', expected_states: ['running'] }),
    () => store.renewLease({ ...base, lease_ms: 120_000 }),
    () => store.settleExecutionOutcome({ ...base, actual_cost_micros: 10,
      execution_outcome: 'succeeded', execution_evidence_hash: sha256Ref({ ok: true }), result_hash: sha256Ref({ result: true }) }),
    () => store.transitionInvocation({ ...journalInput, now: base.now }),
    () => store.findResourceJournalReceipt({ ...base, request_hash: journalInput.resource_journal_request_hash }),
  ]) await assert.rejects(operation(), denied);
  assert.deepEqual(await store.getAuditSnapshot('tenant_alpha', f.invocation.invocation_ref), before);
  await f.setScopes(scopes);
  assert.deepEqual(await store.transitionInvocation({ ...journalInput, now: new Date().toISOString() }), running);
});

test('PostgreSQL keeps cleanup pending when authority is withdrawn during absence verification', { skip }, async (t) => {
  const f = await fixture(t);
  await f.control.claimExecution(f.principal, f.claimRequest);
  await f.control.recordResources(f.principal, f.resources);
  await f.control.recordExecutionOutcome(f.principal, {
    invocation_ref: f.invocation.invocation_ref, lease_token: f.claimRequest.lease_token,
    outcome: 'succeeded', actual_cost_micros: 10,
    execution_evidence_hash: sha256Ref({ ok: true }), result_hash: sha256Ref({ result: true }),
  });
  const lease = await f.control.claimCleanup(f.principal, {
    ...f.claimRequest, lease_token: testLeaseToken('scope_cleanup'),
  });
  const cleanup = { invocation_ref: f.invocation.invocation_ref, lease_token: lease.lease_token,
    cleanup_evidence: lease.invocation.cleanup_requests.map((request) => createCleanupVerificationEvidence(request, {
      status: 'verified', observed_at: new Date().toISOString(), evidence_ref: `observed_${request.resource_kind}`,
      observation_hash: sha256Ref({ absent: request.resource_ref }),
    })) };
  const before = await f.store.getAuditSnapshot('tenant_alpha', f.invocation.invocation_ref);
  f.hooks.cleanup = () => f.setScopes(scopes.filter((scope) => scope !== 'worker:write'));
  await assert.rejects(f.control.completeCleanup(f.principal, cleanup), denied);
  assert.deepEqual(await f.store.getAuditSnapshot('tenant_alpha', f.invocation.invocation_ref), before);
  f.hooks.cleanup = async () => {};
  await f.setScopes(scopes);
  assert.equal((await f.control.completeCleanup(f.principal, cleanup)).state, 'completed');
});


test('PostgreSQL serializes credential changes behind the final lease decision', { skip, timeout: 10_000 }, async (t) => {
  const f = await fixture(t);
  let notifyLocked;
  let resume;
  const locked = new Promise((resolve) => { notifyLocked = resolve; });
  const proceed = new Promise((resolve) => { resume = resolve; });
  let paused = false;
  const gatedPool = {
    async connect() {
      const client = await f.pool.connect();
      return {
        async query(...args) {
          const result = await client.query(...args);
          if (!paused && /SELECT EXISTS[\s\S]*managed_api_keys/.test(args[0])) {
            paused = true;
            notifyLocked();
            await proceed;
          }
          return result;
        },
        release() { client.release(); },
      };
    },
  };
  const store = new PostgresManagedServiceStore({ pool: gatedPool, schemaName: f.schemaName, requireTls: false });
  const now = new Date().toISOString();
  const claim = { ...f.base, purpose: 'execution', worker_id: 'worker_scope_lock',
    lease_ms: 120_000, min_lease_ms: 5_000, max_lease_ms: 120_000,
    max_invocation_age_ms: 900_000, now, expires_at: new Date(Date.parse(now) + 120_000).toISOString() };
  const pendingClaim = store.claimLease(claim);
  // Attach the failure observer before the transaction reaches the barrier.
  const reached = await Promise.race([locked.then(() => true), pendingClaim.then(() => false)]);
  assert.equal(reached, true);
  const editor = await f.pool.connect();
  try {
    await editor.query('BEGIN');
    await editor.query("SET LOCAL lock_timeout = '100ms'");
    await assert.rejects(editor.query(
      `UPDATE ${f.schema}.managed_api_keys SET scopes = '["invocations:read"]'::jsonb WHERE key_id = 'key_alpha'`,
    ), (error) => error.code === '55P03');
  } finally {
    await editor.query('ROLLBACK');
    editor.release();
    resume();
    await pendingClaim;
  }
  await f.setScopes(['invocations:read']);
  await assert.rejects(store.claimLease({ ...claim, now: new Date().toISOString() }), denied);
  assert.equal((await f.store.getAuditSnapshot('tenant_alpha', f.invocation.invocation_ref)).events.length, 2);
});

for (const expiry of ['lease', 'credential']) {
  test(`PostgreSQL rejects claim replay when ${expiry} expires while waiting for a credential lock`,
    { skip, timeout: 15_000 }, async (t) => {
      const f = await fixture(t);
      await f.control.claimExecution(f.principal, f.claimRequest);
      const table = expiry === 'lease' ? 'managed_invocations' : 'managed_api_keys';
      const column = expiry === 'lease' ? 'lease_expires_at' : 'expires_at';
      const updated = await f.pool.query(
        `UPDATE ${f.schema}.${table} SET ${column} = clock_timestamp() + interval '2 seconds'
         RETURNING ${column} AS expires_at`,
      );
      const expiresAt = updated.rows[0].expires_at;
      const before = await f.store.getAuditSnapshot('tenant_alpha', f.invocation.invocation_ref);
      const blocker = await f.pool.connect();
      let pending;
      let settled = false;
      try {
        await blocker.query('BEGIN');
        await blocker.query(`SELECT key_id FROM ${f.schema}.managed_api_keys
          WHERE key_id = 'key_alpha' FOR UPDATE`);
        const pid = (await blocker.query('SELECT pg_backend_pid() AS pid')).rows[0].pid;
        pending = f.store.claimLease({ ...f.base, purpose: 'execution', worker_id: 'worker_scope_test',
          lease_ms: 120_000, min_lease_ms: 5_000, max_lease_ms: 120_000,
          max_invocation_age_ms: 900_000, now: new Date().toISOString() })
          .then((value) => { settled = true; return { value }; },
            (error) => { settled = true; return { error }; });
        let waiting = false;
        const deadline = Date.now() + 1_500;
        while (!settled && Date.now() < deadline) {
          const observed = await f.pool.query(
            'SELECT EXISTS (SELECT 1 FROM pg_stat_activity WHERE $1 = ANY(pg_blocking_pids(pid))) AS waiting',
            [pid],
          );
          if (observed.rows[0].waiting) { waiting = true; break; }
          await new Promise((resolve) => setTimeout(resolve, 10));
        }
        t.diagnostic(`credential lock wait observed: ${waiting}; replay completed before release: ${settled}`);
        assert.equal(waiting, true, 'replay must reach the held credential lock before expiry');
        // Wait only until the database-authoritative expiry, bounded by the two-second fixture.
        await blocker.query(`SELECT pg_sleep(LEAST(2.1,
          GREATEST(0, EXTRACT(EPOCH FROM ($1::timestamptz - clock_timestamp()))) + 0.05))`, [expiresAt]);
        const clock = await blocker.query('SELECT clock_timestamp() > $1::timestamptz AS expired', [expiresAt]);
        assert.equal(clock.rows[0].expired, true);
      } finally {
        await blocker.query('ROLLBACK');
        blocker.release();
        if (pending) await pending;
      }
      const result = await pending;
      assert.equal(result.error?.code, expiry === 'lease' ? 'LEASE_EXPIRED' : 'AUTHENTICATION_FAILED');
      assert.deepEqual(await f.store.getAuditSnapshot('tenant_alpha', f.invocation.invocation_ref), before);
    });
}
