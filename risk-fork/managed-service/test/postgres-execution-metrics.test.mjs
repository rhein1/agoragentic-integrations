import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { rootCertificates } from 'node:tls';
import pg from 'pg';
import { sha256Ref } from '../../src/canonical.mjs';
import { createManagedAuditEvent, verifyManagedAuditWindow } from '../src/audit.mjs';
import { createManagedAuthenticator, hashManagedApiKey } from '../src/auth.mjs';
import { createManagedServiceConfig } from '../src/config.mjs';
import { createManagedRiskForkControlPlane } from '../src/control-plane.mjs';
import { lifecycleTenantHash } from '../src/lifecycle-event.mjs';
import { createManagedProviderRegistry } from '../src/provider-registry.mjs';
import { migrateManagedServicePostgres } from '../src/postgres-migrator.mjs';
import { PostgresManagedServiceStore } from '../src/postgres-store.mjs';
import { createPostgresManagedTelemetryStore } from '../src/postgres-telemetry-store.mjs';
import { migratePostgresManagedTelemetry } from '../src/postgres-telemetry-migrator.mjs';
import { prunePostgresManagedTelemetry } from '../src/postgres-telemetry-maintenance.mjs';
import { createManagedTelemetryDrainer } from '../src/telemetry-drainer.mjs';
import { createManagedTelemetryEvent } from '../src/telemetry-event.mjs';
import { createFixture, invocationRequest, TestProvider, TEST_TOKEN, WORKER_SCOPES } from './helpers.mjs';

const connectionString = process.env.RISK_FORK_MANAGED_TEST_POSTGRES_URL;
if (!connectionString && process.env.RISK_FORK_MANAGED_REQUIRE_POSTGRES_TESTS === '1') throw new Error('Mandatory execution metrics require PostgreSQL');
const skip = !connectionString;
if (connectionString) {
  const url = new URL(connectionString);
  if (!['127.0.0.1','localhost','[::1]'].includes(url.hostname) || url.pathname !== '/risk_fork_managed_test'
    || process.env.RISK_FORK_MANAGED_TEST_CONFIRM_DISPOSABLE !== 'YES_DELETE_DATA') throw new Error('Execution metrics require explicit disposable loopback DB');
}
const qid = (value) => { assert.match(value, /^[a-z_][a-z0-9_]*$/); return `"${value}"`; };
const token = () => randomBytes(32).toString('base64url');
const limits = { maxEvents: 100, maxEventsPerTenant: 100, leaseMs: 1000, retryMs: 200, retentionMs: 1000 };
const metricSettings = { maxSources: 100, maxSourcesPerTenant: 100, maxWindows: 100, maxWindowsPerTenant: 100,
  maxAlerts: 100, maxAlertsPerTenant: 100, rules: [{ rule_id: 'execution_failure_observed', threshold: 1, window_ms: 60_000 }] };
const oldSettings = { ...metricSettings, rules: [{ rule_id: 'rate_denied', threshold: 1, window_ms: 60_000 }] };
const tenantHash = lifecycleTenantHash('tenant_alpha');
function wrapper(pool, intercept) { return { async connect() { const client = await pool.connect();
  return { release: () => client.release(), query: (sql, params) => intercept(client, sql, params) }; } }; }

async function fixture(run, { version = 4, settings = metricSettings, migrate = true } = {}) {
  const schemaName = `execution_metrics_${randomUUID().replaceAll('-', '')}`, s = qid(schemaName);
  const pool = new pg.Pool({ connectionString, max: 8 }), stores = [];
  let offset = 0;
  const timed = wrapper(pool, async (client, sql, params) => {
    const result = await client.query(sql, params);
    return sql === 'SELECT floor(extract(epoch FROM clock_timestamp()) * 1000)::bigint AS now_ms'
      ? { ...result, rows: [{ now_ms: String(Number(result.rows[0].now_ms) + offset) }] } : result;
  });
  const base = { pool: timed, schemaName, limits, lifecycle: true, requireTls: false, disposableDb: true };
  const options = { ...base, metrics: true, metricVersion: version, metricSettings: settings };
  const make = async (eventKind = 'lifecycle', extra = {}) => {
    const store = await createPostgresManagedTelemetryStore({ ...options, eventKind, ...extra }); stores.push(store); return store;
  };
  const count = async (table) => { assert.match(table, /^telemetry_[a-z_]+$/); return (await pool.query(`SELECT count(*)::integer AS n FROM ${s}.${table}`)).rows[0].n; };
  const snapshot = async () => {
    const state = {};
    for (const table of ['telemetry_lifecycle_events', 'telemetry_lifecycle_checkpoints', 'telemetry_lifecycle_sweeps', 'telemetry_schema_migrations', 'telemetry_metric_settings', 'telemetry_metric_sources',
      'telemetry_metric_windows', 'telemetry_metric_alerts', 'telemetry_metric_totals']) {
      state[table] = (await pool.query(`SELECT * FROM ${s}.${table} ORDER BY 1,2`)).rows;
    }
    return state;
  };
  try {
    if (migrate) assert.equal((await migratePostgresManagedTelemetry(options)).migration_version, version);
    await run({ pool, timed, s, schemaName, base, options, make, count, snapshot, advance: (ms) => { offset += ms; } });
  } finally {
    const errors = [], cleanup = async (fn) => { try { await fn(); } catch (error) { errors.push(error); } };
    for (const store of stores) await cleanup(() => store.close());
    await cleanup(() => pool.query(`DROP SCHEMA IF EXISTS ${s} CASCADE`));
    await cleanup(async () => assert.equal((await pool.query('SELECT 1 FROM pg_namespace WHERE nspname=$1', [schemaName])).rowCount, 0));
    await cleanup(() => pool.end());
    if (errors.length) throw new AggregateError(errors, 'Execution metrics cleanup failed');
  }
}

// A historically valid old label is not reclassified from unavailable details.
function historicalPacket(label = 'execution_outcome_recorded', observer = 'historical', tenant = 'tenant_alpha',
  ref = 'rfi_historical', occurredAt = '2026-09-05T12:00:00.000Z') {
  const event = createManagedAuditEvent({ event_ref: `evt_${ref}`, tenant_id: tenant, invocation_ref: ref,
    sequence: 1, event_type: label, occurred_at: occurredAt, details: { outcome: 'failed' }, prior_event_hash: null });
  const anchor = { tenant_id: tenant, invocation_ref: ref, audit_event_count: 1, audit_head_hash: event.event_hash, prior_event: null, events: [event] };
  return { scope: { observer_hash: sha256Ref(observer), tenant_hash: lifecycleTenantHash(tenant) }, tenant_id: tenant,
    expected_sweep: null, expected_checkpoint: null,
    page: { tenant_id: tenant, upper_ref: ref, invocations: [{ invocation_ref: ref, audit_event_count: 1, audit_head_hash: event.event_hash }], complete: true, next_after_ref: ref },
    window: verifyManagedAuditWindow(anchor, { tenant_id: tenant, invocation_ref: ref, after_sequence: 0, prior_event_hash: null, limit: 64 }) };
}
async function settledSource(f, outcome) {
  const control = f.controlPlane, principal = f.principal;
  const { invocation } = await control.admitInvocation(principal, invocationRequest());
  const ref = invocation.invocation_ref;
  const lease = await control.claimExecution(principal, { invocation_ref: ref, lease_token: token(), worker_id: 'execution_metric_worker', lease_ms: 30_000 });
  if (f.attestResourceBinding) f.attestResourceBinding(invocation, { savepoint_ref: 'metric_savepoint', fork_ref: 'metric_fork' });
  await control.recordResources(principal, { invocation_ref: ref, lease_token: lease.lease_token, savepoint_ref: 'metric_savepoint', fork_ref: 'metric_fork' });
  const packet = { invocation_ref: ref, lease_token: lease.lease_token, outcome, actual_cost_micros: 0,
    execution_evidence_hash: sha256Ref('synthetic execution'), result_hash: sha256Ref('synthetic result') };
  const settled = await control.recordExecutionOutcome(principal, packet);
  assert.equal(settled.state, 'cleanup_pending');
  const events = await control.listAuditEvents(principal, ref);
  assert.equal(events.at(-1).event_type, outcome === 'failed' ? 'execution_failure_observed' : 'execution_outcome_recorded');
  await assert.rejects(control.recordExecutionOutcome(principal, packet));
  assert.deepEqual(await control.listAuditEvents(principal, ref), events);
  return { scope: { observer_hash: sha256Ref('actual outcome observer'), tenant_hash: tenantHash }, tenant_id: 'tenant_alpha',
    expected_sweep: null, expected_checkpoint: null, page: await control.listAuditInvocations(principal, { limit: 1 }),
    window: await control.readAuditWindow(principal, ref, { limit: 64 }) };
}
async function pgSource(pool, run) {
  const schemaName = `execution_source_${randomUUID().replaceAll('-', '')}`, s = qid(schemaName);
  try {
    await migrateManagedServicePostgres({ pool, schemaName, requireTls: false });
    await pool.query(`INSERT INTO ${s}.managed_tenants (tenant_id,status,daily_budget_micros,max_invocation_cost_micros,max_concurrent_invocations)
      VALUES ('tenant_alpha','active',1000000,500000,4)`);
    await pool.query(`INSERT INTO ${s}.managed_api_keys (key_hash,key_id,tenant_id,scopes,not_before,expires_at)
      VALUES ($1,'key_alpha','tenant_alpha',$2,clock_timestamp()-interval '1 minute',clock_timestamp()+interval '1 hour')`,
    [hashManagedApiKey(TEST_TOKEN), JSON.stringify(['audit:read','invocations:read','invocations:write', ...WORKER_SCOPES])]);
    const store = new PostgresManagedServiceStore({ pool, schemaName, requireTls: false });
    const auth = createManagedAuthenticator({ store });
    const registry = createManagedProviderRegistry([{ provider: new TestProvider(), enabled: true, adapter_digest: sha256Ref('outcome fixture'),
      qualification_class: 'local_test', qualification_receipt_hash: sha256Ref('local fixture only'), tenant_ids: ['tenant_alpha'],
      verify_resource_binding: async () => true, verify_cleanup_evidence: async () => true, verify_recovery_absence: async () => true }]);
    const controlPlane = createManagedRiskForkControlPlane({ store, config: createManagedServiceConfig({ enabled: true, environment: 'local_test' }),
      providerRegistry: registry, requirePrincipal: auth.requirePrincipal });
    const principal = await auth.authenticate(`Bearer ${TEST_TOKEN}`, 'invocations:write');
    await run({ controlPlane, principal });
  } finally {
    await pool.query(`DROP SCHEMA IF EXISTS ${s} CASCADE`);
    assert.equal((await pool.query('SELECT 1 FROM pg_namespace WHERE nspname=$1', [schemaName])).rowCount, 0);
  }
}

for (const outcome of ['failed','succeeded']) {
  test(`actual PostgreSQL ${outcome} producer projects exactly once with v4 alert truth`, { skip, timeout: 90_000 }, async () => {
    await fixture(async ({ pool, make, count }) => pgSource(pool, async (f) => {
      const packet = await settledSource(f, outcome), a = await make(), b = await make();
      await Promise.all(Array.from({ length: 6 }, (_, i) => (i % 2 ? a : b).appendLifecycleWindow(packet)));
      const result = await a.readMetrics({ tenant_hash: tenantHash });
      assert.equal(result.retained_sources, packet.window.events.length);
      assert.equal(result.windows.length, outcome === 'failed' ? 1 : 0);
      if (outcome === 'failed') assert.equal(result.windows[0].count, 1);
      assert.equal(result.production_qualified, false); assert.equal(result.coverage, 'ingested_observations_only');
      assert.equal(await count('telemetry_metric_alerts'), outcome === 'failed' ? 1 : 0);
      const alerts = await make('alert'), delivered = [];
      const drainer = createManagedTelemetryDrainer({ store: alerts, eventKind: 'alert', deliver: async (event) => {
        delivered.push(event); return { event_ref: event.event_ref, delivered: true };
      } });
      try { assert.equal((await drainer.runOnce()).delivered, outcome === 'failed' ? 1 : 0); } finally { await drainer.close(); }
      if (outcome === 'failed') {
        assert.equal(delivered[0].evidence_class, 'control_plane_self_attested');
        assert.equal(delivered[0].source_kind, 'lifecycle'); assert.equal(delivered[0].production_qualified, false);
        assert.equal(JSON.stringify(delivered).includes(TEST_TOKEN), false);
      }
    }));
  });
}

test('v4 lifecycle lost COMMIT, alert lost ACK and acknowledged pruning retain custody and one count', { skip, timeout: 90_000 }, async () => {
  await fixture(async ({ options, make, advance, count, pool, s }) => {
    const f = await createFixture(), packet = await settledSource(f, 'failed');
    let armed = false;
    const unreliable = wrapper(options.pool, async (client, sql, params) => {
      const result = await client.query(sql, params);
      if (armed && sql === 'COMMIT') { armed = false; throw new Error('lost synthetic commit SECRET'); } return result;
    });
    const lost = await make('lifecycle', { pool: unreliable }), fresh = await make(); armed = true;
    await assert.rejects(lost.appendLifecycleWindow(packet), { code: 'TELEMETRY_UNAVAILABLE' });
    await fresh.appendLifecycleWindow(packet);
    const alerts = await make('alert', { pool: unreliable }), claimToken = token(), claim = await alerts.claim({ claimToken });
    const ack = { event_ref: claim.event.event_ref, generation: claim.generation, claimToken,
      acknowledgement: { event_ref: claim.event.event_ref, delivered: true } };
    armed = true; await assert.rejects(alerts.acknowledge(ack), { code: 'TELEMETRY_UNAVAILABLE' });
    assert.equal((await alerts.acknowledge(ack)).acknowledged, true);
    const drainer = createManagedTelemetryDrainer({ store: fresh, eventKind: 'lifecycle', maxBatch: 64,
      deliver: async (event) => ({ event_ref: event.event_ref, delivered: true }) });
    try { assert.equal((await drainer.runOnce()).delivered, packet.window.events.length); } finally { await drainer.close(); }
    advance(2000);
    const owner = (await pool.query('SELECT current_user AS name')).rows[0].name;
    assert.equal((await prunePostgresManagedTelemetry({ ...options, expectedOwner: owner, eventKind: 'alert' })).removed, 1);
    assert.equal((await prunePostgresManagedTelemetry({ ...options, expectedOwner: owner, eventKind: 'lifecycle' })).removed, packet.window.events.length);
    await (await make()).appendLifecycleWindow(packet);
    assert.equal(await count('telemetry_lifecycle_events'), 0); assert.equal(await count('telemetry_metric_alerts'), 0);
    assert.equal((await fresh.readMetrics({ tenant_hash: tenantHash })).windows[0].count, 1);
    assert.ok((await pool.query(`SELECT payload FROM ${s}.telemetry_metric_windows`)).rows[0].payload.alert_acknowledgement_hash);
  });
});

test('v4 projection rollback and finite caps do not partially advance source, count, alert or checkpoint', { skip, timeout: 90_000 }, async () => {
  for (const table of ['telemetry_metric_sources','telemetry_metric_windows','telemetry_metric_alerts']) {
    await fixture(async ({ options, make, count }) => {
      const packet = historicalPacket('execution_failure_observed'); let armed = false;
      const broken = wrapper(options.pool, (client, sql, params) => armed && sql.startsWith(`INSERT INTO ${qid(options.schemaName)}.${table}`)
        ? client.query('SELECT 1/0') : client.query(sql, params));
      const store = await make('lifecycle', { pool: broken }); armed = true;
      await assert.rejects(store.appendLifecycleWindow(packet), { code: 'TELEMETRY_UNAVAILABLE' });
      for (const name of ['telemetry_lifecycle_events','telemetry_lifecycle_checkpoints','telemetry_lifecycle_sweeps',
        'telemetry_metric_sources','telemetry_metric_windows','telemetry_metric_alerts']) assert.equal(await count(name), 0);
      await (await make()).appendLifecycleWindow(packet); assert.equal(await count(table), 1);
    });
  }
  for (const cap of ['maxSources','maxWindows','maxAlerts']) await fixture(async ({ make, snapshot }) => {
    const store = await make(); await store.appendLifecycleWindow(historicalPacket('execution_failure_observed'));
    const before = await snapshot();
    await assert.rejects(store.appendLifecycleWindow(historicalPacket('execution_failure_observed','other observer','tenant_other')), { code: 'TELEMETRY_CAPACITY' });
    assert.deepEqual(await snapshot(), before);
  }, { settings: { ...metricSettings, [cap]: 1, [cap + 'PerTenant']: 1 } });
  for (const cap of ['maxSources','maxWindows','maxAlerts']) await fixture(async ({ make, snapshot, advance }) => {
    const store = await make(); await store.appendLifecycleWindow(historicalPacket('execution_failure_observed'));
    advance(60_000);
    const before = await snapshot();
    await assert.rejects(store.appendLifecycleWindow(historicalPacket('execution_failure_observed','second observer','tenant_alpha',
      'rfi_second', '2026-09-05T12:01:00.000Z')), { code: 'TELEMETRY_CAPACITY' });
    assert.deepEqual(await snapshot(), before);
    await store.appendLifecycleWindow(historicalPacket('execution_failure_observed','other observer','tenant_other'));
  }, { settings: { ...metricSettings, [cap]: 2, [cap + 'PerTenant']: 1 } });
});

test('v1/v2 to v4 baselines retained old outcomes; changed v3 settings reject without rewriting custody', { skip, timeout: 90_000 }, async () => {
  for (const lifecycle of [false, true]) await fixture(async ({ base, options, make, pool, s }) => {
    await migratePostgresManagedTelemetry({ ...base, lifecycle });
    const policyEvent = createManagedTelemetryEvent({ event: 'rate_denied', route_class: 'admission',
      status: 429, outcome: 'rate_limited', duration_ms: 1, tenant_hash: tenantHash, key_hash: sha256Ref('legacy synthetic key') });
    await (await make('policy', { lifecycle, metrics: false, metricVersion: undefined, metricSettings: undefined })).append(policyEvent);
    if (lifecycle) await (await make('lifecycle', { metrics: false, metricVersion: undefined, metricSettings: undefined })).appendLifecycleWindow(historicalPacket());
    assert.equal((await migratePostgresManagedTelemetry(options)).migration_version, 4);
    const store = await make();
    if (lifecycle) await store.appendLifecycleWindow(historicalPacket());
    await (await make('policy')).append(policyEvent);
    assert.equal((await store.readMetrics({ tenant_hash: tenantHash })).legacy_uncounted, lifecycle ? 2 : 1);
    assert.equal((await store.readMetrics({ tenant_hash: tenantHash })).windows.length, 0);
    assert.deepEqual((await pool.query(`SELECT version FROM ${s}.telemetry_schema_migrations ORDER BY version`)).rows.map((r) => r.version), [1,2,3,4]);
  }, { migrate: false });
  await fixture(async ({ options, make, snapshot, pool, s }) => {
    const policy = await make('policy'); const event = createManagedTelemetryEvent({ event: 'rate_denied', route_class: 'admission',
      status: 429, outcome: 'rate_limited', duration_ms: 1, tenant_hash: tenantHash, key_hash: sha256Ref('synthetic key') });
    await policy.append(event); const before = await snapshot();
    await assert.rejects(migratePostgresManagedTelemetry({ ...options, metricVersion: 4, metricSettings }), { code: 'TELEMETRY_MIGRATION_FAILED' });
    assert.deepEqual(await snapshot(), before);
    const migration = await migratePostgresManagedTelemetry({ ...options, metricVersion: 4 }); assert.equal(migration.migration_version, 4);
    assert.deepEqual((await snapshot()).telemetry_schema_migrations.slice(0, 3), before.telemetry_schema_migrations);
    await assert.rejects(policy.stats(), { code: 'TELEMETRY_UNAVAILABLE' });
    const current = await make('policy', { metricVersion: 4 }); await current.append(event);
    assert.equal((await current.readMetrics({ tenant_hash: tenantHash })).windows[0].count, 1);
    await (await make('lifecycle', { metricVersion: 4 })).appendLifecycleWindow(historicalPacket());
    assert.equal((await pool.query(`SELECT count(*)::integer AS n FROM ${s}.telemetry_metric_alerts`)).rows[0].n, 1);
  }, { version: 3, settings: oldSettings });
});

test('v4 exact runtime grants and CA TLS reject payload/ledger mutation and catalog drift', { skip, timeout: 90_000 }, async () => {
  const suffix = randomUUID().replaceAll('-', '').slice(0, 16), db = `execution_role_${suffix}`;
  const owner = `execution_owner_${suffix}`, runtime = `execution_runtime_${suffix}`, schemaName = `execution_${suffix}`, s = qid(schemaName);
  const root = new pg.Pool({ connectionString }), url = new URL(connectionString); url.pathname = `/${db}`;
  let admin, ownerPool, runtimePool, lifecycle, alerts, created = false;
  const password = `disposable-${randomUUID()}`;
  try {
    await root.query(`CREATE DATABASE ${qid(db)}`); created = true; admin = new pg.Pool({ connectionString: url.toString() });
    await admin.query(`CREATE ROLE ${qid(owner)} LOGIN NOINHERIT PASSWORD '${password}'`);
    await admin.query(`CREATE ROLE ${qid(runtime)} LOGIN NOINHERIT PASSWORD '${password}'`);
    const replace = (text) => text.replaceAll('__TELEMETRY_DATABASE__', qid(db)).replaceAll('__TELEMETRY_SCHEMA__', s)
      .replaceAll('__TELEMETRY_MIGRATOR__', qid(owner)).replaceAll('__TELEMETRY_RUNTIME__', qid(runtime));
    const [bootstrap, grants] = replace(await readFile(new URL('../ops/postgres/telemetry-roles.sql.template', import.meta.url), 'utf8'))
      .split('-- Dedicated migrator AFTER migratePostgresManagedTelemetry:');
    await admin.query(bootstrap); url.username = owner; url.password = password;
    ownerPool = new pg.Pool({ connectionString: url.toString() });
    const options = { schemaName, limits, lifecycle: true, metrics: true, metricVersion: 4, metricSettings };
    await migratePostgresManagedTelemetry({ ...options, pool: ownerPool, requireTls: false, disposableDb: true });
    await ownerPool.query(grants);
    for (const file of ['lifecycle-grants.sql.template','metrics-grants.sql.template']) await ownerPool.query(replace(await readFile(new URL('../ops/postgres/' + file, import.meta.url), 'utf8')));
    url.username = runtime; runtimePool = new pg.Pool({ connectionString: url.toString() });
    const ca = process.env.RISK_FORK_TEST_POSTGRES_TLS_CA; assert.equal(typeof ca, 'string');
    const runtimeOptions = { ...options, connectionString: url.toString(), expectedOwner: owner, tls: { ca } };
    lifecycle = await createPostgresManagedTelemetryStore({ ...runtimeOptions, eventKind: 'lifecycle' });
    alerts = await createPostgresManagedTelemetryStore({ ...runtimeOptions, eventKind: 'alert' });
    assert.equal((await alerts.initialize()).runtime_privileges_verified, true);
    await lifecycle.appendLifecycleWindow(historicalPacket('execution_failure_observed'));
    assert.equal((await lifecycle.readMetrics({ tenant_hash: tenantHash })).windows[0].count, 1);
    await assert.rejects(createPostgresManagedTelemetryStore({ ...runtimeOptions, tls: { ca: rootCertificates[0] } }), { code: 'TELEMETRY_UNAVAILABLE' });
    for (const sql of [`UPDATE ${s}.telemetry_metric_alerts SET payload='{}'`, `UPDATE ${s}.telemetry_metric_sources SET payload='{}'`,
      `DELETE FROM ${s}.telemetry_metric_sources`, `TRUNCATE ${s}.telemetry_metric_windows`, `UPDATE ${s}.telemetry_metric_settings SET payload='{}'`,
      `UPDATE ${s}.telemetry_schema_migrations SET migration_hash='bad'`, `ALTER TABLE ${s}.telemetry_metric_windows ADD COLUMN bypass text`]) await assert.rejects(runtimePool.query(sql), { code: '42501' });
    await ownerPool.query(`ALTER TABLE ${s}.telemetry_metric_windows DROP CONSTRAINT telemetry_metric_windows_rule_id_check`);
    await assert.rejects(alerts.stats(), { code: 'TELEMETRY_UNAVAILABLE' });
    assert.equal((await ownerPool.query(`SELECT count(*)::integer AS n FROM ${s}.telemetry_metric_sources`)).rows[0].n, 1);
  } finally {
    const errors = [], cleanup = async (fn) => { try { await fn(); } catch (error) { errors.push(error); } };
    await cleanup(() => lifecycle?.close()); await cleanup(() => alerts?.close());
    await cleanup(() => runtimePool?.end()); await cleanup(() => ownerPool?.end()); await cleanup(() => admin?.end());
    if (created) await cleanup(() => root.query(`DROP DATABASE ${qid(db)}`));
    for (const role of [runtime,owner]) await cleanup(() => root.query(`DROP ROLE IF EXISTS ${qid(role)}`));
    await cleanup(async () => assert.equal((await root.query('SELECT 1 FROM pg_database WHERE datname=$1', [db])).rowCount, 0));
    await cleanup(async () => assert.equal((await root.query('SELECT 1 FROM pg_roles WHERE rolname=ANY($1::text[])', [[owner,runtime]])).rowCount, 0));
    await cleanup(() => root.end()); if (errors.length) throw new AggregateError(errors, 'Execution metrics role cleanup failed');
  }
});
