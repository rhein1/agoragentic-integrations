import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import pg from 'pg';
import { sha256Ref } from '../../src/canonical.mjs';
import { createManagedAuditEvent, verifyManagedAuditWindow } from '../src/audit.mjs';
import { createCleanupVerificationEvidence } from '../../src/provider.mjs';
import { createManagedAuthenticator, hashManagedApiKey } from '../src/auth.mjs';
import { createManagedServiceConfig } from '../src/config.mjs';
import { createManagedRiskForkControlPlane } from '../src/control-plane.mjs';
import { createManagedProviderRegistry } from '../src/provider-registry.mjs';
import { migrateManagedServicePostgres } from '../src/postgres-migrator.mjs';
import { PostgresManagedServiceStore } from '../src/postgres-store.mjs';
import { createPostgresManagedTelemetryStore } from '../src/postgres-telemetry-store.mjs';
import { migratePostgresManagedTelemetry } from '../src/postgres-telemetry-migrator.mjs';
import { prunePostgresManagedTelemetry } from '../src/postgres-telemetry-maintenance.mjs';
import { createManagedTelemetryDrainer } from '../src/telemetry-drainer.mjs';
import { createManagedLifecycleObserver } from '../src/lifecycle-observer.mjs';
import { lifecycleTenantHash } from '../src/lifecycle-event.mjs';
import { TestProvider, TEST_TOKEN, WORKER_SCOPES, invocationRequest } from './helpers.mjs';

const connectionString = process.env.RISK_FORK_MANAGED_TEST_POSTGRES_URL;
if (!connectionString && process.env.RISK_FORK_MANAGED_REQUIRE_POSTGRES_TESTS === '1') throw new Error('Mandatory cleanup metrics require PostgreSQL');
const skip = !connectionString;
if (connectionString) {
  const url = new URL(connectionString);
  if (!['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname)
    || url.pathname !== '/risk_fork_managed_test'
    || process.env.RISK_FORK_MANAGED_TEST_CONFIRM_DISPOSABLE !== 'YES_DELETE_DATA') {
    throw new Error('Cleanup metrics require explicit disposable loopback DB');
  }
}
const qid = (value) => { assert.match(value, /^[a-z_][a-z0-9_]*$/); return `"${value}"`; };
const token = () => randomBytes(32).toString('base64url');
const limits = { maxEvents: 100, maxEventsPerTenant: 100, leaseMs: 1000, retryMs: 200, retentionMs: 1000 };
const settings = {
  maxSources: 100, maxSourcesPerTenant: 100, maxWindows: 100, maxWindowsPerTenant: 100,
  maxAlerts: 100, maxAlertsPerTenant: 100,
  rules: [
    { rule_id: 'cleanup_verified', threshold: 1, window_ms: 60_000 },
    { rule_id: 'recovery_absence_verified', threshold: 1, window_ms: 60_000 },
  ],
};
const oldSettings = { ...settings, rules: [{ rule_id: 'rate_denied', threshold: 1, window_ms: 60_000 }] };

function packet(label, ref = `rfi_${label}`, tenant = 'tenant_alpha', observer = 'cleanup-metrics-observer') {
  const event = createManagedAuditEvent({ event_ref: `evt_${ref}`, tenant_id: tenant, invocation_ref: ref,
    sequence: 1, event_type: label, occurred_at: '2026-10-06T00:00:00.000Z', details: { evidence_ref: 'redacted' }, prior_event_hash: null });
  const anchor = { tenant_id: tenant, invocation_ref: ref, audit_event_count: 1, audit_head_hash: event.event_hash, prior_event: null, events: [event] };
  return { scope: { observer_hash: sha256Ref(observer), tenant_hash: lifecycleTenantHash(tenant) }, tenant_id: tenant,
    expected_sweep: null, expected_checkpoint: null,
    page: { tenant_id: tenant, upper_ref: ref, invocations: [{ invocation_ref: ref, audit_event_count: 1, audit_head_hash: event.event_hash }], complete: true, next_after_ref: ref },
    window: verifyManagedAuditWindow(anchor, { tenant_id: tenant, invocation_ref: ref, after_sequence: 0, prior_event_hash: null, limit: 64 }) };
}

async function fixture(run, overrides = {}) {
  const { migrate = true, ...configOverrides } = overrides;
  const schemaName = `cleanup_metrics_${randomUUID().replaceAll('-', '')}`;
  const s = qid(schemaName); const pool = new pg.Pool({ connectionString, max: 8 }); const stores = []; let offset = 0;
  const timed = { async connect() { const client = await pool.connect(); return { release: () => client.release(), query: async (sql, params) => {
    const result = await client.query(sql, params);
    return sql === 'SELECT floor(extract(epoch FROM clock_timestamp()) * 1000)::bigint AS now_ms'
      ? { ...result, rows: [{ now_ms: String(Number(result.rows[0].now_ms) + offset) }] } : result;
  } }; } };
  const options = { pool, schemaName, limits, lifecycle: true, metrics: true, metricVersion: 6, metricSettings: settings,
    requireTls: false, disposableDb: true, ...configOverrides, pool: timed };
  const make = async (eventKind = 'lifecycle', more = {}) => {
    const store = await createPostgresManagedTelemetryStore({ ...options, eventKind, ...more }); stores.push(store); return store;
  };
  const snapshot = async () => {
    const state = {};
    for (const table of ['telemetry_clock', 'telemetry_lifecycle_events', 'telemetry_lifecycle_checkpoints', 'telemetry_lifecycle_sweeps',
      'telemetry_schema_migrations', 'telemetry_metric_settings', 'telemetry_metric_sources', 'telemetry_metric_windows', 'telemetry_metric_alerts', 'telemetry_metric_totals']) {
      state[table] = (await pool.query(`SELECT * FROM ${s}.${table} ORDER BY 1,2`)).rows;
    }
    return state;
  };
  try { if (migrate) await migratePostgresManagedTelemetry(options); await run({ pool, s, options, make, snapshot, advance: (ms) => { offset += ms; } }); }
  finally {
    const errors = []; const cleanup = async (fn) => { try { await fn(); } catch (error) { errors.push(error); } };
    for (const store of stores) await cleanup(() => store.close());
    await cleanup(() => pool.query(`DROP SCHEMA IF EXISTS ${s} CASCADE`));
    await cleanup(async () => assert.equal((await pool.query('SELECT 1 FROM pg_namespace WHERE nspname=$1', [schemaName])).rowCount, 0));
    await cleanup(() => pool.end()); if (errors.length) throw new AggregateError(errors, 'Cleanup metrics cleanup failed');
  }
}

async function projectRealPostgresProducers(pool, run) {
  const schemaName = `cleanup_source_${randomUUID().replaceAll('-', '')}`; const s = qid(schemaName);
  let store;
  const invocationRefs = ['rfi_00000001', 'rfi_00000002'];
  try {
    await migrateManagedServicePostgres({ pool, schemaName, requireTls: false });
    await pool.query(`INSERT INTO ${s}.managed_tenants (tenant_id,status,daily_budget_micros,max_invocation_cost_micros,max_concurrent_invocations)
      VALUES ('tenant_alpha','active',1000000,500000,4)`);
    await pool.query(`INSERT INTO ${s}.managed_api_keys (key_hash,key_id,tenant_id,scopes,not_before,expires_at)
      VALUES ($1,'key_alpha','tenant_alpha',$2,clock_timestamp()-interval '1 minute',clock_timestamp()+interval '1 hour')`,
    [hashManagedApiKey(TEST_TOKEN), JSON.stringify(['audit:read','invocations:read','invocations:write', ...WORKER_SCOPES])]);
    store = new PostgresManagedServiceStore({ pool, schemaName, requireTls: false });
    const auth = createManagedAuthenticator({ store });
    const registry = createManagedProviderRegistry([{ provider: new TestProvider(), enabled: true,
      adapter_digest: sha256Ref('cleanup-v6-fixture'), qualification_class: 'local_test', qualification_receipt_hash: sha256Ref('fixture'),
      tenant_ids: ['tenant_alpha'], verify_resource_binding: async () => true,
      verify_cleanup_evidence: async () => true, verify_recovery_absence: async () => true }]);
    const controlPlane = createManagedRiskForkControlPlane({ store, config: createManagedServiceConfig({ enabled: true, environment: 'local_test' }), invocationRef: () => invocationRefs.shift(),
      providerRegistry: registry, requirePrincipal: auth.requirePrincipal });
    const principal = await auth.authenticate(`Bearer ${TEST_TOKEN}`, 'invocations:write');
    const admitted = (await controlPlane.admitInvocation(principal, invocationRequest({ idempotency_key: 'pg-cleanup-v6-00000001' }))).invocation;
    const execution = await controlPlane.claimExecution(principal, { invocation_ref: admitted.invocation_ref, lease_token: token(), worker_id: 'pg_cleanup_v6', lease_ms: 30_000 });
    await controlPlane.recordResources(principal, { invocation_ref: admitted.invocation_ref, lease_token: execution.lease_token, savepoint_ref: 'pg_savepoint', fork_ref: 'pg_fork' });
    await controlPlane.recordExecutionOutcome(principal, { invocation_ref: admitted.invocation_ref, lease_token: execution.lease_token, outcome: 'succeeded', actual_cost_micros: 0,
      execution_evidence_hash: sha256Ref('pg execution'), result_hash: sha256Ref('pg result') });
    const cleanupLease = await controlPlane.claimCleanup(principal, { invocation_ref: admitted.invocation_ref, lease_token: token(), worker_id: 'pg_cleanup_v6', lease_ms: 30_000 });
    const observedAt = new Date().toISOString();
    const evidence = cleanupLease.invocation.cleanup_requests.map((request, index) => createCleanupVerificationEvidence(request, {
      status: 'verified', observed_at: observedAt, evidence_ref: `pg_cleanup_${index}`, observation_hash: sha256Ref({ index }),
    }));
    await controlPlane.completeCleanup(principal, { invocation_ref: admitted.invocation_ref, lease_token: cleanupLease.lease_token, cleanup_evidence: evidence });
    const cleanupPage = await controlPlane.listAuditInvocations(principal, { limit: 1 });
    const recoveryAdmitted = (await controlPlane.admitInvocation(principal, invocationRequest({ idempotency_key: 'pg-recovery-v6-00000001' }))).invocation;
    await controlPlane.claimExecution(principal, { invocation_ref: recoveryAdmitted.invocation_ref, lease_token: token(), worker_id: 'pg_recovery_v6', lease_ms: 5_000 });
    await new Promise((resolve) => setTimeout(resolve, 6_000));
    await controlPlane.sweepExpiredLeases();
    const recovery = await controlPlane.claimRecovery(principal, { invocation_ref: recoveryAdmitted.invocation_ref, lease_token: token(), worker_id: 'pg_recovery_v6', lease_ms: 30_000 });
    const recoveryEvidence = { schema: 'agoragentic.risk-fork.recovery-absence-evidence.v1', provider_recovery_key: recoveryAdmitted.provider_recovery_key,
      observed_at: new Date().toISOString(), evidence_ref: 'pg_recovery_absence', observation_hash: sha256Ref('pg recovery') };
    await controlPlane.completeRecoveryAbsence(principal, { invocation_ref: recoveryAdmitted.invocation_ref, lease_token: recovery.lease_token, recovery_evidence: recoveryEvidence });
    await run({ controlPlane, principal,
      cleanup: await controlPlane.readAuditWindow(principal, admitted.invocation_ref, { limit: 64 }),
      cleanupPage,
      recovery: await controlPlane.readAuditWindow(principal, recoveryAdmitted.invocation_ref, { limit: 64 }),
      recoveryRef: recoveryAdmitted.invocation_ref,
      recoveryPage: await controlPlane.listAuditInvocations(principal, { after_ref: cleanupPage.upper_ref, upper_ref: recoveryAdmitted.invocation_ref, limit: 1 }) });
  } finally { await store?.close(); await pool.query(`DROP SCHEMA IF EXISTS ${s} CASCADE`); }
}

test('real PostgreSQL control-plane cleanup and recovery producers project exact v6 labels', { skip, timeout: 120_000 }, async () => {
  await fixture(async ({ pool, make }) => {
    await projectRealPostgresProducers(pool, async ({ controlPlane, principal, cleanup, recovery }) => {
      const store = await make();
      const observer = createManagedLifecycleObserver({ controlPlane, store, auditPrincipals: [principal], observerId: 'pg_cleanup_v6_observer' });
      try {
        const first = await observer.runOnce();
        assert.equal(first.recorded, cleanup.events.length); assert.equal(first.failed, 0);
        const second = await observer.runOnce();
        assert.equal(second.recorded, cleanup.events.length + recovery.events.length); assert.equal(second.failed, 0);
      }
      finally { await observer.close(); }
      assert.equal(cleanup.events.at(-1).event_type, 'cleanup_verified');
      assert.equal(recovery.events.at(-1).event_type, 'recovery_absence_verified');
      const read = await store.readMetrics({ tenant_hash: lifecycleTenantHash('tenant_alpha') });
      assert.deepEqual(read.windows.map((row) => row.rule_id).sort(), ['cleanup_verified', 'recovery_absence_verified']);
      assert.deepEqual(read.windows.map((row) => row.count).sort(), [1, 1]);
      assert.equal(read.production_qualified, false);
    });
  });
});

test('fresh v6 accepts both exact labels and duplicate lifecycle replay counts once', { skip, timeout: 90_000 }, async () => {
  await fixture(async ({ make, pool, s }) => {
    const a = await make(); const b = await make();
    const cleanup = packet('cleanup_verified', 'rfi_cleanup'); const recovery = packet('recovery_absence_verified', 'rfi_recovery');
    await Promise.all([a.appendLifecycleWindow(cleanup), b.appendLifecycleWindow(cleanup)]);
    const scope = cleanup.scope;
    const sweep = await a.readLifecycleSweep(scope);
    const nextRecovery = { ...recovery, expected_sweep: sweep, expected_checkpoint: null };
    await Promise.all([a.appendLifecycleWindow(nextRecovery), b.appendLifecycleWindow(nextRecovery)]);
    const read = await a.readMetrics({ tenant_hash: lifecycleTenantHash('tenant_alpha') });
    assert.deepEqual(read.windows.map((row) => row.rule_id).sort(), ['cleanup_verified', 'recovery_absence_verified']);
    assert.deepEqual(read.windows.map((row) => row.count).sort(), [1, 1]);
    assert.equal(read.production_qualified, false); assert.equal(read.coverage, 'ingested_observations_only');
    assert.equal(JSON.stringify(read).includes('redacted'), false);
    await pool.query(`UPDATE ${s}.telemetry_metric_sources SET event_hash=$1`, [sha256Ref('corrupted-retained-source')]);
    await assert.rejects(a.appendLifecycleWindow(nextRecovery), { code: 'TELEMETRY_EVENT_CONFLICT' });
  });
});

for (const version of [3, 4, 5]) test(`v${version} settings cannot add v6 cleanup/recovery rules; v6 catalog-only upgrade preserves custody`, { skip, timeout: 90_000 }, async () => {
  await fixture(async ({ options, make, snapshot }) => {
    const old = await make(); await old.appendLifecycleWindow(packet('execution_outcome_recorded', `rfi_old_${version}`));
    const before = await snapshot();
    await assert.rejects(migratePostgresManagedTelemetry({ ...options, metricVersion: 6, metricSettings: settings }), { code: 'TELEMETRY_MIGRATION_FAILED' });
    assert.deepEqual(await snapshot(), before);
    await migratePostgresManagedTelemetry({ ...options, metricVersion: 6, metricSettings: oldSettings });
    const after = await snapshot();
    assert.deepEqual(after.telemetry_metric_settings, before.telemetry_metric_settings);
    assert.deepEqual(after.telemetry_metric_sources, before.telemetry_metric_sources);
    assert.deepEqual(after.telemetry_metric_windows, before.telemetry_metric_windows);
    assert.deepEqual(after.telemetry_metric_alerts, before.telemetry_metric_alerts);
    assert.deepEqual(after.telemetry_metric_totals, before.telemetry_metric_totals);
    assert.deepEqual(after.telemetry_schema_migrations.map((row) => row.version), [1, 2, 3, 4, 5, 6]);
  }, { metricVersion: version, metricSettings: oldSettings });
});

test('v6 unknown commit and alert ACK replay preserve one source/window/alert custody', { skip, timeout: 90_000 }, async () => {
  await fixture(async ({ options, make, pool, advance }) => {
    let armed = false;
    const broken = { async connect() { const client = await options.pool.connect(); return { release: () => client.release(), query: async (sql, params) => {
      const result = await client.query(sql, params); if (armed && sql === 'COMMIT') { armed = false; throw new Error('lost commit'); } return result;
    } }; } };
    const lost = await make('lifecycle', { pool: broken }); armed = true;
    await assert.rejects(lost.appendLifecycleWindow(packet('cleanup_verified')), { code: 'TELEMETRY_UNAVAILABLE' });
    const current = await make(); await current.appendLifecycleWindow(packet('cleanup_verified'));
    const alerts = await make('alert', { pool: broken }); const claimToken = token();
    const claim = await alerts.claim({ claimToken });
    const ack = { event_ref: claim.event.event_ref, generation: claim.generation, claimToken,
      acknowledgement: { event_ref: claim.event.event_ref, delivered: true } };
    armed = true; await assert.rejects(alerts.acknowledge(ack), { code: 'TELEMETRY_UNAVAILABLE' });
    assert.equal((await alerts.acknowledge(ack)).acknowledged, true);
    const owner = (await pool.query('SELECT current_user AS name')).rows[0].name;
    advance(2_000);
    assert.equal((await prunePostgresManagedTelemetry({ ...options, eventKind: 'alert', expectedOwner: owner })).removed, 1);
    const drainer = createManagedTelemetryDrainer({ store: current, eventKind: 'lifecycle', deliver: async (event) => ({ event_ref: event.event_ref, delivered: true }) });
    try { assert.equal((await drainer.runOnce()).delivered, 1); } finally { await drainer.close(); }
    assert.equal((await current.readMetrics({ tenant_hash: lifecycleTenantHash('tenant_alpha') })).windows[0].count, 1);
  });
});

for (const [name, globalCap, tenantCap] of [
  ['source', 'maxSources', 'maxSourcesPerTenant'], ['window', 'maxWindows', 'maxWindowsPerTenant'], ['alert', 'maxAlerts', 'maxAlertsPerTenant'],
]) for (const [order, labels] of [['cleanup-first', ['cleanup_verified', 'recovery_absence_verified']], ['recovery-first', ['recovery_absence_verified', 'cleanup_verified']]]) test(`v6 global and tenant ${name} caps roll back ${order}`, { skip, timeout: 90_000 }, async () => {
  await fixture(async ({ make, snapshot }) => {
    const store = await make(); await store.appendLifecycleWindow(packet(labels[0], `rfi_${order}_first`, 'tenant_alpha')); const before = await snapshot();
    await assert.rejects(store.appendLifecycleWindow(packet(labels[1], `rfi_${order}_second`, 'tenant_other')), { code: 'TELEMETRY_CAPACITY' });
    assert.deepEqual(await snapshot(), before);
  }, { metricSettings: { ...settings, [globalCap]: 1, [tenantCap]: 1 } });
  await fixture(async ({ make, snapshot }) => {
    const store = await make(); await store.appendLifecycleWindow(packet(labels[0], `rfi_${order}_tenant_first`, 'tenant_alpha', `observer-${order}-first`)); const before = await snapshot();
    await assert.rejects(store.appendLifecycleWindow(packet(labels[1], `rfi_${order}_tenant_second`, 'tenant_alpha', `observer-${order}-second`)), { code: 'TELEMETRY_CAPACITY' });
    assert.deepEqual(await snapshot(), before);
  }, { metricSettings: { ...settings, [globalCap]: 2, [tenantCap]: 1 } });
});

for (const lifecycle of [false, true]) test(`v${lifecycle ? 2 : 1} baseline to v6 keeps historical cleanup label legacy and uncounted`, { skip, timeout: 90_000 }, async () => {
  await fixture(async ({ options, make, pool, s }) => {
    const prior = { ...options, lifecycle, metrics: false, metricVersion: undefined, metricSettings: undefined };
    await migratePostgresManagedTelemetry(prior);
    if (lifecycle) await (await make('lifecycle', prior)).appendLifecycleWindow(packet('cleanup_verified', 'rfi_historical_cleanup'));
    const before = lifecycle ? (await pool.query(`SELECT * FROM ${s}.telemetry_lifecycle_events ORDER BY 1`)).rows : null;
    await migratePostgresManagedTelemetry(options);
    const current = await make('lifecycle');
    if (lifecycle) await current.appendLifecycleWindow(packet('cleanup_verified', 'rfi_historical_cleanup'));
    const read = await current.readMetrics({ tenant_hash: lifecycleTenantHash('tenant_alpha') });
    assert.equal(read.legacy_uncounted, lifecycle ? 1 : 0);
    assert.equal(read.windows.length, 0);
    if (lifecycle) assert.deepEqual((await pool.query(`SELECT * FROM ${s}.telemetry_lifecycle_events ORDER BY 1`)).rows, before);
    assert.deepEqual((await pool.query(`SELECT version FROM ${s}.telemetry_schema_migrations ORDER BY version`)).rows.map((row) => row.version), [1, 2, 3, 4, 5, 6]);
  }, { migrate: false });
});

test('v6 rejects v5 catalog and detects exact catalog drift without custody repair', { skip, timeout: 90_000 }, async () => {
  await fixture(async ({ options, make, pool, s, snapshot }) => {
    await migratePostgresManagedTelemetry({ ...options, metricVersion: 5, metricSettings: oldSettings });
    const old = await make('lifecycle', { metricVersion: 5, metricSettings: oldSettings });
    await old.appendLifecycleWindow(packet('cleanup_verified', 'rfi_catalog_v5'));
    const before = await snapshot();
    await assert.rejects(createPostgresManagedTelemetryStore({ ...options, metricVersion: 6, metricSettings: settings }).then((store) => store.initialize()), { code: 'TELEMETRY_UNAVAILABLE' });
    assert.deepEqual(await snapshot(), before);
    await migratePostgresManagedTelemetry({ ...options, metricVersion: 6, metricSettings: oldSettings });
    const current = await make('lifecycle', { metricVersion: 6, metricSettings: oldSettings });
    await pool.query(`ALTER TABLE ${s}.telemetry_metric_windows DROP CONSTRAINT telemetry_metric_windows_rule_id_check`);
    await assert.rejects(current.stats(), { code: 'TELEMETRY_UNAVAILABLE' });
    assert.equal((await pool.query(`SELECT count(*)::integer AS n FROM ${s}.telemetry_metric_sources`)).rows[0].n, 1);
  }, { migrate: false });
});
