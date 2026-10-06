import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import { sha256Ref } from '../../src/canonical.mjs';
import { createCleanupVerificationEvidence } from '../../src/provider.mjs';
import { createPostgresAuthorityPool, quotePostgresAuthorityIdentifier } from '../../src/adapters/postgres-authority-migrator.mjs';
import { createManagedAuthenticator, hashManagedApiKey } from '../src/auth.mjs';
import { cancellationRequest } from '../src/cancellation.mjs';
import { createManagedServiceConfig } from '../src/config.mjs';
import { createManagedRiskForkControlPlane } from '../src/control-plane.mjs';
import { managedProviderRecoveryKey } from '../src/invocation-integrity.mjs';
import { migrateManagedServicePostgres } from '../src/postgres-migrator.mjs';
import { PostgresManagedServiceStore } from '../src/postgres-store.mjs';
import { createPostgresManagedTelemetryStore } from '../src/postgres-telemetry-store.mjs';
import { migratePostgresManagedTelemetry } from '../src/postgres-telemetry-migrator.mjs';
import { prunePostgresManagedTelemetry } from '../src/postgres-telemetry-maintenance.mjs';
import { createManagedLifecycleObserver } from '../src/lifecycle-observer.mjs';
import { lifecycleTenantHash } from '../src/lifecycle-event.mjs';
import { createManagedTelemetryDrainer } from '../src/telemetry-drainer.mjs';
import { createManagedProviderRegistry } from '../src/provider-registry.mjs';
import { invocationRequest, SAME_TENANT_TOKEN, testLeaseToken, TestProvider, TEST_TOKEN, WORKER_SCOPES } from './helpers.mjs';

const connectionString = process.env.RISK_FORK_MANAGED_TEST_POSTGRES_URL ?? null;
function postgresSkipReason() {
  if (connectionString === null) return 'RISK_FORK_MANAGED_TEST_POSTGRES_URL is not configured';
  let url;
  try { url = new URL(connectionString); } catch { return 'PostgreSQL test URL is invalid'; }
  if (!['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname) || url.pathname !== '/risk_fork_managed_test') {
    return 'Cancellation tests require the loopback risk_fork_managed_test database';
  }
  if (process.env.RISK_FORK_MANAGED_TEST_CONFIRM_DISPOSABLE !== 'YES_DELETE_DATA') {
    return 'RISK_FORK_MANAGED_TEST_CONFIRM_DISPOSABLE=YES_DELETE_DATA is required';
  }
  return false;
}
const skip = postgresSkipReason();
if (process.env.RISK_FORK_MANAGED_REQUIRE_POSTGRES_TESTS === '1' && skip !== false) {
  throw new Error(`Mandatory cancellation PostgreSQL tests are unavailable: ${skip}`);
}
const cancel = (ref, extra = {}) => ({ invocation_ref: ref, idempotency_key: 'pg-cancellation-request-0001',
  reason_hash: sha256Ref('synthetic cancellation test'), ...extra });
function wrapper(pool, intercept) {
  return { async connect() {
    const client = await pool.connect();
    return { release: () => client.release(), query: (sql, params) => intercept(client, sql, params) };
  } };
}

// The database, transactions, locks and COMMITs are real. Provider verification
// below is an explicit local fixture; it does not qualify external isolation.
async function fixture(run) {
  const schemaName = `risk_fork_managed_test_${randomUUID().replaceAll('-', '')}`;
  const s = quotePostgresAuthorityIdentifier(schemaName);
  const pool = await createPostgresAuthorityPool({ connectionString, requireTls: false, maxConnections: 4,
    applicationName: 'risk-fork-cancellation-test' });
  const stores = [];
  try {
    assert.equal((await migrateManagedServicePostgres({ pool, schemaName, requireTls: false })).migration_version, 4);
    await pool.query(`INSERT INTO ${s}.managed_tenants (tenant_id,status,daily_budget_micros,
      max_invocation_cost_micros,max_concurrent_invocations) VALUES ('tenant_alpha','active',1000000,500000,4)`);
    const scopes = JSON.stringify(['audit:read', 'invocations:read', 'invocations:write', 'invocations:cancel', ...WORKER_SCOPES]);
    for (const [token, id] of [[TEST_TOKEN, 'key_alpha'], [SAME_TENANT_TOKEN, 'key_alpha_secondary']]) {
      await pool.query(`INSERT INTO ${s}.managed_api_keys (key_hash,key_id,tenant_id,scopes,not_before,expires_at)
        VALUES ($1,$2,'tenant_alpha',$3::jsonb,clock_timestamp()-interval '1 minute',clock_timestamp()+interval '1 hour')`,
      [hashManagedApiKey(token), id, scopes]);
    }
    const providerRegistry = createManagedProviderRegistry([{
      provider: new TestProvider(), enabled: true, adapter_digest: sha256Ref('pg cancellation fixture adapter'),
      qualification_class: 'local_test', qualification_receipt_hash: sha256Ref('pg cancellation fixture only'),
      tenant_ids: ['tenant_alpha'], verify_resource_binding: async () => true,
      verify_cleanup_evidence: async () => true, verify_recovery_absence: async () => true,
    }]);
    const config = createManagedServiceConfig({ enabled: true, environment: 'local_test' });
    const make = async (selectedPool = pool) => {
      const store = new PostgresManagedServiceStore({ pool: selectedPool, schemaName, requireTls: false,
        eventRef: () => `evt_cancel_${randomUUID().replaceAll('-', '')}` });
      stores.push(store);
      const authenticator = createManagedAuthenticator({ store });
      const control = createManagedRiskForkControlPlane({ config, store, providerRegistry,
        requirePrincipal: authenticator.requirePrincipal,
        invocationRef: () => `rfi_cancel_${randomUUID().replaceAll('-', '')}` });
      const principal = await authenticator.authenticate(`Bearer ${TEST_TOKEN}`, 'invocations:write');
      const worker = await authenticator.authenticate(`Bearer ${SAME_TENANT_TOKEN}`, 'worker:execution:claim');
      return { store, control, principal, worker };
    };
    const current = await make();
    const { invocation } = await current.control.admitInvocation(current.principal, invocationRequest());
    const ref = invocation.invocation_ref;
    const usage = async () => {
      const result = await pool.query(`SELECT reserved_micros,spent_micros FROM ${s}.managed_usage_buckets
        WHERE tenant_id='tenant_alpha' AND budget_day_utc=$1::date`, [invocation.budget_day_utc]);
      assert.equal(result.rowCount, 1);
      return Object.fromEntries(Object.entries(result.rows[0]).map(([key, value]) => [key, Number(value)]));
    };
    const claim = () => current.control.claimExecution(current.worker, { invocation_ref: ref,
      worker_id: 'worker_pg_cancellation', lease_token: testLeaseToken('pg_cancel_execution'), lease_ms: 30_000 });
    await run({ ...current, pool, s, make, invocation, ref, usage, claim });
  } finally {
    const errors = [];
    const cleanup = async (fn) => { try { await fn(); } catch (error) { errors.push(error); } };
    for (const store of stores) await cleanup(() => store.close());
    await cleanup(() => pool.query(`DROP SCHEMA IF EXISTS ${s} CASCADE`));
    await cleanup(async () => assert.equal((await pool.query('SELECT 1 FROM pg_namespace WHERE nspname=$1', [schemaName])).rowCount, 0));
    await cleanup(() => pool.end());
    if (errors.length) throw new AggregateError(errors, 'Cancellation disposable schema cleanup failed');
  }
}

async function assertAuditAnchor(f) {
  const events = await f.control.listAuditEvents(f.principal, f.ref);
  const invocation = await f.control.getInvocation(f.principal, f.ref);
  assert.equal(events.filter((event) => event.event_type === 'cancellation_requested').length, 1);
  assert.equal(events.length, invocation.audit_event_count);
  assert.equal(events.at(-1).event_hash, invocation.audit_head_hash);
  for (let i = 1; i < events.length; i += 1) assert.equal(events[i].prior_event_hash, events[i - 1].event_hash);
  return events;
}

for (const metrics of [false,true]) {
  test(`PG cancellation lifecycle v${metrics ? 3 : 2} advances, replays unknown COMMIT and delivers redacted observations`, { skip,timeout: 60_000 }, async () => {
    await fixture(async (f) => {
      const schemaName = `telemetry_cancel_${randomUUID().replaceAll('-','')}`, s = quotePostgresAuthorityIdentifier(schemaName);
      const limits = { maxEvents: 100,maxEventsPerTenant: 100,leaseMs: 10_000,retryMs: 200,retentionMs: 1000 };
      const metricSettings = { maxSources: 100,maxSourcesPerTenant: 100,maxWindows: 100,maxWindowsPerTenant: 100,maxAlerts: 100,maxAlertsPerTenant: 100,
        rules: [{ rule_id: 'lease_expiry_observed',threshold: 1,window_ms: 60_000 }] };
      // Real DB transactions with a shared, forward-only synthetic sample
      // offset exercise retention without sleeps or rewriting clock/ACK rows.
      let clockOffset = 0;
      const clockPool = wrapper(f.pool,async (client,sql,params) => {
        const result = await client.query(sql,params);
        return sql === 'SELECT floor(extract(epoch FROM clock_timestamp()) * 1000)::bigint AS now_ms'
          ? { ...result,rows: [{ now_ms: String(Number(result.rows[0].now_ms)+clockOffset) }] } : result;
      });
      const options = { pool: clockPool,schemaName,limits,requireTls: false,disposableDb: true,lifecycle: true,eventKind: 'lifecycle',metrics,
        ...(metrics ? { metricSettings } : {}) };
      const stores = []; let observer, drainer;
      try {
        await migratePostgresManagedTelemetry(options);
        const makeStore = async (pool = clockPool) => {
          const store = await createPostgresManagedTelemetryStore({ ...options,pool }); stores.push(store); return store;
        };
        const a = await makeStore(), b = await makeStore(), observerId = 'pg_cancellation_lifecycle';
        const scope = { observer_hash: sha256Ref({ domain: 'risk-fork-lifecycle-observer-v1',observer_id: observerId }),
          tenant_hash: lifecycleTenantHash('tenant_alpha') };
        observer = createManagedLifecycleObserver({ controlPlane: f.control,store: a,auditPrincipals: [f.principal],observerId });
        assert.equal((await observer.runOnce()).recorded,1);
        const input = cancel(f.ref);
        await f.control.requestCancellation(f.principal,input);
        await f.control.requestCancellation(f.principal,input);
        const checkpoint = await b.readLifecycleCheckpoint(scope,f.ref);
        const packet = { scope,tenant_id: 'tenant_alpha',expected_sweep: await b.readLifecycleSweep(scope),expected_checkpoint: checkpoint,
          page: await f.control.listAuditInvocations(f.principal,{ limit: 1 }),
          window: await f.control.readAuditWindow(f.principal,f.ref,{ after_sequence: checkpoint.sequence,prior_event_hash: checkpoint.event_hash,limit: 64 }) };
        assert.deepEqual(packet.window.events.map((event) => event.event_type),['cancellation_requested']);
        let armed = false;
        const unreliable = wrapper(clockPool,async (client,sql,params) => {
          const result = await client.query(sql,params);
          if (armed && sql === 'COMMIT') { armed = false; throw new Error('synthetic lost cancellation projection COMMIT'); }
          return result;
        });
        const lost = await makeStore(unreliable); armed = true;
        await assert.rejects(lost.appendLifecycleWindow(packet),{ code: 'TELEMETRY_UNAVAILABLE' });
        assert.equal((await b.readLifecycleCheckpoint(scope,f.ref)).sequence,2);
        const sweep = await b.readLifecycleSweep(scope);
        assert.equal((await b.appendLifecycleWindow(packet)).persisted,true);
        assert.deepEqual(await a.readLifecycleSweep(scope),sweep);
        assert.equal((await a.stats()).pending,2);
        const delivered = new Map();
        drainer = createManagedTelemetryDrainer({ store: b,eventKind: 'lifecycle',maxBatch: 64,deliver: async (event) => {
          delivered.set(event.event_ref,event); return { event_ref: event.event_ref,delivered: true };
        } });
        assert.equal((await drainer.runOnce()).delivered,2);
        assert.equal(delivered.size,2);
        assert.equal([...delivered.values()].filter((event) => event.source_event_type === 'cancellation_requested').length,1);
        for (const privateValue of [f.ref,TEST_TOKEN,input.idempotency_key,input.reason_hash,f.principal.key_id,
          f.invocation.provider_recovery_key,'bounded input']) assert.equal(JSON.stringify([...delivered.values()]).includes(privateValue),false);
        if (metrics) {
          const view = await b.readMetrics({ tenant_hash: scope.tenant_hash });
          assert.equal(view.retained_sources,2); assert.deepEqual(view.windows,[]);
          assert.equal((await f.pool.query(`SELECT count(*)::integer AS count FROM ${s}.telemetry_metric_alerts`)).rows[0].count,0);
        }
        const owner = (await f.pool.query('SELECT current_user AS name')).rows[0].name;
        clockOffset += 2000;
        assert.equal((await prunePostgresManagedTelemetry({ ...options,expectedOwner: owner })).removed,2);
        const restarted = await makeStore();
        assert.equal((await restarted.appendLifecycleWindow(packet)).persisted,true);
        assert.equal((await restarted.stats()).pending,0);
        assert.equal((await restarted.readLifecycleCheckpoint(scope,f.ref)).sequence,2);
        if (metrics) assert.equal((await restarted.readMetrics({ tenant_hash: scope.tenant_hash })).retained_sources,2);
        await f.control.admitInvocation(f.principal,invocationRequest({ idempotency_key: 'after-cancellation-observer-regression' }));
        await observer.close();
        observer = createManagedLifecycleObserver({ controlPlane: f.control,store: restarted,auditPrincipals: [f.principal],observerId });
        await observer.runOnce(); await observer.runOnce();
        assert.equal(observer.health().failed,0); assert.equal(observer.health().recorded,1);
        assert.equal((await restarted.stats()).pending,1,'later invocations progress instead of stalling at cancellation');
      } finally {
        const errors = [], cleanup = async (fn) => { try { await fn(); } catch (error) { errors.push(error); } };
        await cleanup(() => observer?.close()); await cleanup(() => drainer?.close());
        for (const store of stores) await cleanup(() => store.close());
        await cleanup(() => f.pool.query(`DROP SCHEMA IF EXISTS ${s} CASCADE`));
        await cleanup(async () => assert.equal((await f.pool.query('SELECT 1 FROM pg_namespace WHERE nspname=$1',[schemaName])).rowCount,0));
        if (errors.length) throw new AggregateError(errors,'Cancellation telemetry disposable cleanup failed');
      }
    });
  });
}

test('PG cancellation concurrent exact replay releases the reservation once and keeps the audit anchor', { skip }, async () => {
  await fixture(async (f) => {
    const input = cancel(f.ref);
    const responses = await Promise.all([f.control.requestCancellation(f.principal, input), f.control.requestCancellation(f.principal, input)]);
    assert.deepEqual(responses[0], responses[1]);
    assert.equal(responses[0].state, 'failed_closed');
    assert.deepEqual(await f.usage(), { reserved_micros: 0, spent_micros: 0 });
    const before = await f.store.getAuditSnapshot('tenant_alpha', f.ref);
    await assert.rejects(f.control.requestCancellation(f.principal, cancel(f.ref, { reason_hash: sha256Ref('other reason') })),
      { code: 'CANCELLATION_CONFLICT' });
    assert.deepEqual(await f.store.getAuditSnapshot('tenant_alpha', f.ref), before);
    assert.equal((await assertAuditAnchor(f)).at(-1).event_type, 'cancellation_requested');
    await assert.rejects(f.claim(), { code: 'INVOCATION_NOT_CLAIMABLE' });
  });
});

for (const inFlight of [false, true]) {
  test(`PG cancellation unknown real COMMIT reply replays once after restart, in-flight ${inFlight}`, { skip }, async () => {
    await fixture(async (f) => {
      if (inFlight) await f.claim();
      let armed = false;
      const unreliable = wrapper(f.pool, async (client, sql, params) => {
        const result = await client.query(sql, params);
        if (armed && sql === 'COMMIT') { armed = false; throw new Error('synthetic lost cancellation COMMIT reply'); }
        return result;
      });
      const lost = await f.make(unreliable); armed = true;
      await assert.rejects(lost.control.requestCancellation(lost.principal, cancel(f.ref)),
        /synthetic lost cancellation COMMIT reply/);
      const committed = await f.control.getInvocation(f.principal, f.ref);
      assert.equal(committed.state, inFlight ? 'recovery_required' : 'failed_closed');
      await lost.store.close();
      const restarted = await f.make();
      const initialized = await restarted.store.initialize();
      assert.equal(initialized.catalog_verified, true);
      assert.equal(initialized.runtime_privileges_verified, false, 'owner fixture is catalog-only, not separate runtime qualification');
      assert.equal(initialized.production_qualified, false);
      assert.deepEqual(await restarted.control.requestCancellation(restarted.principal, cancel(f.ref)), committed);
      assert.deepEqual(await f.usage(), { reserved_micros: 0, spent_micros: inFlight ? 100_000 : 0 });
      await assertAuditAnchor(f);
      if (inFlight) {
        const recovery = await restarted.control.claimRecovery(restarted.worker, { invocation_ref: f.ref,
          worker_id: 'worker_pg_cancel_recovery', lease_token: testLeaseToken('pg_cancel_recovery'), lease_ms: 30_000 });
        const terminal = await restarted.control.completeRecoveryAbsence(restarted.worker, {
          invocation_ref: f.ref, lease_token: recovery.lease_token, recovery_evidence: {
            schema: 'agoragentic.risk-fork.recovery-absence-evidence.v1', provider_recovery_key: committed.provider_recovery_key,
            observed_at: new Date().toISOString(), evidence_ref: 'fixture:pg-cancel-total-absence',
            observation_hash: sha256Ref('synthetic absence fixture, not provider qualification'),
          },
        });
        assert.equal(terminal.state, 'failed_closed');
        assert.equal(terminal.execution_outcome, 'ambiguous');
        assert.equal(terminal.cancel_request_hash, committed.cancel_request_hash);
        assert.deepEqual(await f.usage(), { reserved_micros: 0, spent_micros: 100_000 });
      }
    });
  });
}

test('PG cancellation rechecks immutable invocation binding and current credential inside the transaction', { skip }, async () => {
  await fixture(async (f) => {
    const input = { ...cancellationRequest(f.invocation, f.principal.key_id, cancel(f.ref)), now: new Date().toISOString() };
    const before = await f.store.getAuditSnapshot('tenant_alpha', f.ref);
    await f.pool.query(`UPDATE ${f.s}.managed_invocations SET provider_binding_hash=$1 WHERE invocation_ref=$2`,
      [sha256Ref('synthetic changed binding'), f.ref]);
    await assert.rejects(f.store.requestCancellation(input), { code: 'RECOVERY_KEY_INTEGRITY_FAILED' });
    // A consistent but changed binding must also reject the earlier request,
    // independently of the recovery-key integrity guard above.
    await f.pool.query(`UPDATE ${f.s}.managed_invocations SET provider_recovery_key=$1 WHERE invocation_ref=$2`,
      [managedProviderRecoveryKey({ tenantId: 'tenant_alpha', idempotencyHash: f.invocation.idempotency_hash,
        providerBindingHash: sha256Ref('synthetic changed binding') }), f.ref]);
    await assert.rejects(f.store.requestCancellation(input), { code: 'CANCELLATION_BINDING_CHANGED' });
    await f.pool.query(`UPDATE ${f.s}.managed_invocations SET provider_binding_hash=$1,provider_recovery_key=$2 WHERE invocation_ref=$3`,
      [f.invocation.provider_binding_hash, f.invocation.provider_recovery_key, f.ref]);
    await f.pool.query(`UPDATE ${f.s}.managed_api_keys SET revoked_at=clock_timestamp() WHERE key_id='key_alpha'`);
    await assert.rejects(f.store.requestCancellation(input), { code: 'AUTHENTICATION_FAILED' });
    assert.deepEqual(await f.store.getAuditSnapshot('tenant_alpha', f.ref), before);
    assert.deepEqual(await f.usage(), { reserved_micros: 100_000, spent_micros: 0 });
  });
});

async function waitForBlocked(pool, pid) {
  const deadline = Date.now() + 1500;
  while (Date.now() < deadline) {
    const result = await pool.query('SELECT EXISTS (SELECT 1 FROM pg_stat_activity WHERE $1=ANY(pg_blocking_pids(pid))) AS waiting', [pid]);
    if (result.rows[0].waiting === true) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.fail('Cancellation did not reach the exact held PostgreSQL lock');
}
for (const lockKind of ['credential', 'budget']) {
  test(`PG cancellation expiry during the ${lockKind} lock wait rolls back audit, marker and usage`, { skip, timeout: 10_000 }, async () => {
    await fixture(async (f) => {
      const before = await f.store.getAuditSnapshot('tenant_alpha', f.ref);
      const expiry = (await f.pool.query(`UPDATE ${f.s}.managed_api_keys SET expires_at=clock_timestamp()+interval '2 second'
        WHERE key_id='key_alpha' RETURNING expires_at`)).rows[0].expires_at;
      const blocker = await f.pool.connect(); let pending;
      try {
        await blocker.query('BEGIN');
        const pid = (await blocker.query('SELECT pg_backend_pid() AS pid')).rows[0].pid;
        await blocker.query(lockKind === 'credential'
          ? `SELECT 1 FROM ${f.s}.managed_api_keys WHERE key_id='key_alpha' FOR UPDATE`
          : `SELECT 1 FROM ${f.s}.managed_usage_buckets WHERE tenant_id='tenant_alpha' FOR UPDATE`);
        pending = f.control.requestCancellation(f.principal, cancel(f.ref)).then((value) => ({ value }), (error) => ({ error }));
        await waitForBlocked(f.pool, pid);
        await blocker.query(`SELECT pg_sleep(LEAST(2.1,GREATEST(0,EXTRACT(EPOCH FROM ($1::timestamptz-clock_timestamp())))+0.05))`, [expiry]);
        assert.equal((await blocker.query('SELECT clock_timestamp()>$1::timestamptz AS expired', [expiry])).rows[0].expired, true);
      } finally { await blocker.query('ROLLBACK'); blocker.release(); if (pending) await pending; }
      assert.equal((await pending).error?.code, 'AUTHENTICATION_FAILED');
      assert.deepEqual(await f.store.getAuditSnapshot('tenant_alpha', f.ref), before);
      assert.deepEqual(await f.usage(), { reserved_micros: 100_000, spent_micros: 0 });
      assert.equal((await f.store.getInvocation('tenant_alpha', f.ref)).cancel_requested_at, null);
    });
  });
}

test('PG cancellation observer binds the interrupted worker token and generation; takeover retires it', { skip }, async () => {
  await fixture(async (f) => {
    const claim = await f.claim();
    const observation = { invocation_ref: f.ref, lease_token: claim.lease_token, lease_generation: claim.invocation.lease_generation };
    assert.equal((await f.control.observeExecutionCancellation(f.worker, observation)).cancel_requested, false);
    await assert.rejects(f.control.observeExecutionCancellation(f.principal, observation), { code: 'CANCELLATION_OBSERVATION_INVALID' });
    await f.control.requestCancellation(f.principal, cancel(f.ref));
    assert.equal((await f.control.observeExecutionCancellation(f.worker, observation)).cancel_requested, true);
    await assert.rejects(f.control.observeExecutionCancellation(f.principal, observation), { code: 'CANCELLATION_OBSERVATION_INVALID' });
    await assert.rejects(f.control.observeExecutionCancellation(f.worker,
      { ...observation, lease_token: testLeaseToken('pg_cancel_wrong_token') }), { code: 'CANCELLATION_OBSERVATION_INVALID' });
    await assert.rejects(f.control.renewLease(f.worker, { invocation_ref: f.ref, lease_token: claim.lease_token, lease_ms: 30_000 }));
    await f.control.claimRecovery(f.worker, { invocation_ref: f.ref, worker_id: 'pg_cancel_takeover',
      lease_token: testLeaseToken('pg_cancel_takeover'), lease_ms: 30_000 });
    await assert.rejects(f.control.observeExecutionCancellation(f.worker, observation), { code: 'CANCELLATION_OBSERVATION_STALE' });
    await assertAuditAnchor(f);
  });
});

test('PG cancellation marker cannot be cleared/rearmed; an active cleanup lease retains settled truth', { skip }, async () => {
  await fixture(async (f) => {
    const execution = await f.claim();
    await f.control.recordResources(f.worker, { invocation_ref: f.ref, lease_token: execution.lease_token,
      savepoint_ref: 'sp_pg_cancel', fork_ref: 'fork_pg_cancel' });
    await f.control.recordExecutionOutcome(f.worker, { invocation_ref: f.ref, lease_token: execution.lease_token,
      outcome: 'succeeded', actual_cost_micros: 12, execution_evidence_hash: sha256Ref('pg settled execution'), result_hash: sha256Ref('pg settled result') });
    const cleanup = await f.control.claimCleanup(f.worker, { invocation_ref: f.ref, worker_id: 'pg_cancel_cleanup',
      lease_token: testLeaseToken('pg_cancel_cleanup'), lease_ms: 30_000 });
    const canceled = await f.control.requestCancellation(f.principal, cancel(f.ref));
    assert.equal(canceled.lease_kind, 'cleanup');
    assert.equal(canceled.lease_generation, cleanup.invocation.lease_generation);
    assert.equal(canceled.lease_owner, f.worker.key_id);
    assert.equal(canceled.execution_outcome, 'succeeded');
    assert.equal(canceled.actual_cost_micros, 12);
    // Owner-fixture direct SQL proves permanence after first write, not a
    // hostile runtime's inability to bypass the application for initial writes.
    for (const field of ['cancel_requested_at', 'cancel_requested_by', 'cancel_request_hash', 'cancel_reason_hash']) {
      await assert.rejects(f.pool.query(`UPDATE ${f.s}.managed_invocations SET ${field}=NULL WHERE invocation_ref=$1`, [f.ref]), { code: '55000' });
    }
    const evidence = cleanup.invocation.cleanup_requests.map((request) => createCleanupVerificationEvidence(request, {
      status: 'verified', observed_at: new Date().toISOString(), evidence_ref: `fixture:pg-cancel-${request.resource_kind}`,
      observation_hash: sha256Ref(request),
    }));
    const terminal = await f.control.completeCleanup(f.worker, { invocation_ref: f.ref, lease_token: cleanup.lease_token, cleanup_evidence: evidence });
    assert.equal(terminal.state, 'failed_closed');
    assert.equal(terminal.execution_outcome, 'succeeded');
    assert.equal(terminal.cancel_request_hash, canceled.cancel_request_hash);
    assert.equal(terminal.cancel_requested_at, canceled.cancel_requested_at);
    assert.deepEqual(await f.usage(), { reserved_micros: 0, spent_micros: 12 });
    await assertAuditAnchor(f);
    await assert.rejects(f.pool.query(`UPDATE ${f.s}.managed_audit_events SET event_type='forged' WHERE invocation_ref=$1`, [f.ref]), { code: '55000' });
  });
});
