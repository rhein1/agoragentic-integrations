import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { rootCertificates } from 'node:tls';
import pg from 'pg';
import { sha256Ref } from '../../src/canonical.mjs';
import { createManagedAuditEvent, verifyManagedAuditWindow } from '../src/audit.mjs';
import { lifecycleTenantHash } from '../src/lifecycle-event.mjs';
import { managedError } from '../src/validation.mjs';
import { createManagedAuthenticator, hashManagedApiKey } from '../src/auth.mjs';
import { createManagedServiceConfig } from '../src/config.mjs';
import { createManagedRiskForkControlPlane } from '../src/control-plane.mjs';
import { createManagedProviderRegistry } from '../src/provider-registry.mjs';
import { createManagedServiceHttpHandler } from '../src/http-handler.mjs';
import { createManagedRequestPolicy } from '../src/request-policy.mjs';
import { migrateManagedServicePostgres } from '../src/postgres-migrator.mjs';
import { PostgresManagedServiceStore } from '../src/postgres-store.mjs';
import { createPostgresManagedTelemetryStore } from '../src/postgres-telemetry-store.mjs';
import { migratePostgresManagedTelemetry } from '../src/postgres-telemetry-migrator.mjs';
import { prunePostgresManagedTelemetry } from '../src/postgres-telemetry-maintenance.mjs';
import { createManagedTelemetryDrainer } from '../src/telemetry-drainer.mjs';
import { createManagedTelemetryEvent } from '../src/telemetry-event.mjs';
import { createFixture, TestProvider, TEST_TOKEN, invocationRequest } from './helpers.mjs';

const connectionString = process.env.RISK_FORK_MANAGED_TEST_POSTGRES_URL;
if (!connectionString && process.env.RISK_FORK_MANAGED_REQUIRE_POSTGRES_TESTS === '1') throw new Error('Mandatory budget metrics require PostgreSQL');
const skip = !connectionString;
if (connectionString) {
  const url = new URL(connectionString);
  if (!['127.0.0.1','localhost','[::1]'].includes(url.hostname) || url.pathname !== '/risk_fork_managed_test'
    || process.env.RISK_FORK_MANAGED_TEST_CONFIRM_DISPOSABLE !== 'YES_DELETE_DATA') throw new Error('Budget metrics require explicitly disposable loopback DB');
}
const qid = (name) => { assert.match(name, /^[a-z_][a-z0-9_]*$/); return `"${name}"`; };
const token = () => randomBytes(32).toString('base64url');
const limits = { maxEvents: 100, maxEventsPerTenant: 100, leaseMs: 1000, retryMs: 200, retentionMs: 1000 };
const settings = { maxSources: 100, maxSourcesPerTenant: 100, maxWindows: 100, maxWindowsPerTenant: 100,
  maxAlerts: 100, maxAlertsPerTenant: 100, rules: [{ rule_id: 'budget_denied', threshold: 1, window_ms: 86400000 }] };
const oldSettings = { ...settings, rules: [{ rule_id: 'rate_denied', threshold: 1, window_ms: 86400000 }] };
const tenantHash = sha256Ref('synthetic budget tenant');
const packet = (event = 'daily_budget_denied', tenant_hash = tenantHash) => createManagedTelemetryEvent({ event,
  route_class: 'admission', status: 429, outcome: 'budget_limited', duration_ms: 0,
  tenant_hash, key_hash: sha256Ref('synthetic budget key') });
const wrap = (pool, intercept) => ({ async connect() { const client = await pool.connect();
  return { release: () => client.release(), query: (sql, params) => intercept(client, sql, params) }; } });

async function fixture(run, extra = {}) {
  const { migrate = true, ...overrides } = extra;
  const schemaName = `budget_metrics_${randomUUID().replaceAll('-', '')}`, s = qid(schemaName);
  const pool = new pg.Pool({ connectionString, max: 8 }), stores = [];
  let offset = 0;
  const timed = wrap(pool, async (client, sql, params) => {
    const result = await client.query(sql, params);
    return sql === 'SELECT floor(extract(epoch FROM clock_timestamp()) * 1000)::bigint AS now_ms'
      ? { ...result, rows: [{ now_ms: String(Number(result.rows[0].now_ms) + offset) }] } : result;
  });
  const options = { pool: timed, schemaName, limits, lifecycle: true, metrics: true, metricVersion: 5,
    metricSettings: settings, requireTls: false, disposableDb: true, ...overrides };
  const make = async (eventKind = 'policy', more = {}) => {
    const store = await createPostgresManagedTelemetryStore({ ...options, eventKind, ...more }); stores.push(store); return store;
  };
  const snapshot = async () => {
    const state = {};
    for (const table of ['telemetry_events','telemetry_schema_migrations','telemetry_metric_settings',
      'telemetry_metric_sources','telemetry_metric_windows','telemetry_metric_alerts','telemetry_metric_totals']) {
      state[table] = (await pool.query(`SELECT * FROM ${s}.${table} ORDER BY 1,2`)).rows;
    }
    return state;
  };
  try {
    if (migrate) await migratePostgresManagedTelemetry(options);
    await run({ pool, s, schemaName, options, make, snapshot, advance: (ms) => { offset += ms; } });
  } finally {
    const errors = [], cleanup = async (fn) => { try { await fn(); } catch (e) { errors.push(e); } };
    for (const store of stores) await cleanup(() => store.close());
    await cleanup(() => pool.query(`DROP SCHEMA IF EXISTS ${s} CASCADE`));
    await cleanup(async () => assert.equal((await pool.query('SELECT 1 FROM pg_namespace WHERE nspname=$1', [schemaName])).rowCount, 0));
    await cleanup(() => pool.end()); if (errors.length) throw new AggregateError(errors, 'Budget telemetry cleanup failed');
  }
}

async function pgSource(pool, run) {
  const schemaName = `budget_source_${randomUUID().replaceAll('-', '')}`, s = qid(schemaName);
  try {
    await migrateManagedServicePostgres({ pool, schemaName, requireTls: false });
    await pool.query(`INSERT INTO ${s}.managed_tenants (tenant_id,status,daily_budget_micros,max_invocation_cost_micros,max_concurrent_invocations)
      VALUES ('tenant_alpha','active',75000,50000,4)`);
    await pool.query(`INSERT INTO ${s}.managed_api_keys (key_hash,key_id,tenant_id,scopes,not_before,expires_at)
      VALUES ($1,'key_alpha','tenant_alpha',$2,clock_timestamp()-interval '1 minute',clock_timestamp()+interval '1 hour')`,
    [hashManagedApiKey(TEST_TOKEN), JSON.stringify(['invocations:write'])]);
    const store = new PostgresManagedServiceStore({ pool, schemaName, requireTls: false });
    const auth = createManagedAuthenticator({ store });
    const registry = createManagedProviderRegistry([{ provider: new TestProvider(), enabled: true, adapter_digest: sha256Ref('budget fixture'),
      qualification_class: 'local_test', qualification_receipt_hash: sha256Ref('fixture only'), tenant_ids: ['tenant_alpha'],
      verify_resource_binding: async () => true, verify_cleanup_evidence: async () => true, verify_recovery_absence: async () => true }]);
    const controlPlane = createManagedRiskForkControlPlane({ store, config: createManagedServiceConfig({ enabled: true,
      environment: 'local_test', limits: { max_invocation_cost_micros: 500000, daily_budget_micros: 1000000 } }),
      providerRegistry: registry, requirePrincipal: auth.requirePrincipal });
    const snapshot = async () => {
      const state = {};
      for (const table of ['managed_invocations','managed_usage_buckets','managed_audit_events']) {
        state[table] = (await pool.query(`SELECT * FROM ${s}.${table} ORDER BY 1,2`)).rows;
      }
      return state;
    };
    await run({ controlPlane, auth, snapshot });
  } finally {
    await pool.query(`DROP SCHEMA IF EXISTS ${s} CASCADE`);
    assert.equal((await pool.query('SELECT 1 FROM pg_namespace WHERE nspname=$1', [schemaName])).rowCount, 0);
  }
}

test('real PostgreSQL HTTP budget producers record only after admission rollback and preserve original responses', { skip, timeout: 90000 }, async () => {
  await fixture(async ({ pool, make }) => pgSource(pool, async ({ controlPlane, auth, snapshot }) => {
    const telemetry = await make(), events = [];
    const p = createManagedRequestPolicy({ readControl: async () => ({ enabled: true, epoch: 0 }),
      consumeRateLimit: async () => ({ allowed: true, retry_after_seconds: 0 }), observeBudgetDenials: true,
      recordTelemetry: async (event, options) => {
        events.push(event);
        if (event.outcome === 'budget_limited') assert.deepEqual(await snapshot(), expected);
        return telemetry.append(event, options);
      } });
    const handler = createManagedServiceHttpHandler({ controlPlane, authenticator: auth, requestPolicy: p });
    const request = (cost, id) => ({ method: 'POST', path: '/v1/invocations',
      headers: { authorization: `Bearer ${TEST_TOKEN}`, 'content-type': 'application/json' },
      body: JSON.stringify(invocationRequest({ estimated_cost_micros: cost, idempotency_key: id })) });
    let expected = await snapshot();
    let result = await handler(request(100000, 'invocation-denial-00001'));
    assert.equal(result.status, 429); assert.equal(result.body.error.code, 'INVOCATION_BUDGET_EXCEEDED');
    await p.flushTelemetry(); assert.deepEqual(await snapshot(), expected);
    assert.equal((await handler(request(50000, 'accepted-request-00001'))).status, 201);
    expected = await snapshot();
    result = await handler(request(50000, 'daily-denial-request-00001'));
    assert.equal(result.status, 429); assert.equal(result.body.error.code, 'DAILY_BUDGET_EXCEEDED');
    await p.flushTelemetry(); assert.deepEqual(await snapshot(), expected);
    const budget = events.filter((event) => event.outcome === 'budget_limited');
    assert.deepEqual(budget.map((event) => event.event), ['invocation_budget_denied','daily_budget_denied']);
    const read = await telemetry.readMetrics({ tenant_hash: budget[0].tenant_hash });
    assert.equal(read.windows[0].count, 2); assert.equal(read.production_qualified, false);
    assert.equal((await handler(request(50000, 'accepted-request-00001'))).status, 200);
    await p.flushTelemetry(); assert.equal(events.filter((event) => event.outcome === 'budget_limited').length, 2);
    assert.equal(JSON.stringify(budget).includes(TEST_TOKEN), false);
    assert.equal(JSON.stringify(budget).includes('estimated_cost_micros'), false);
  }));
});

test('v5 exact replay, unknown COMMIT/ACK, restart and pruning retain one count and alert custody', { skip, timeout: 90000 }, async () => {
  await fixture(async ({ pool, s, options, make, advance }) => {
    let armed = false;
    const unreliable = wrap(options.pool, async (client, sql, params) => {
      const result = await client.query(sql, params);
      if (armed && sql === 'COMMIT') { armed = false; throw new Error('lost synthetic commit PRIVATE'); } return result;
    });
    const event = packet(), lost = await make('policy', { pool: unreliable }); armed = true;
    await assert.rejects(lost.append(event), { code: 'TELEMETRY_UNAVAILABLE' });
    const a = await make(), b = await make();
    await Promise.all(Array.from({ length: 6 }, (_, i) => (i % 2 ? a : b).append(event)));
    assert.equal((await a.readMetrics({ tenant_hash: tenantHash })).windows[0].count, 1);
    await assert.rejects(a.append({ ...event, duration_ms: 1 }), { code: 'TELEMETRY_EVENT_CONFLICT' });
    const alerts = await make('alert', { pool: unreliable }), claimToken = token(), claim = await alerts.claim({ claimToken });
    assert.equal(claim.event.rule_id, 'budget_denied'); assert.equal(claim.event.evidence_class, 'host_policy_self_attested');
    assert.equal(claim.event.coverage, 'ingested_observations_only'); assert.equal(claim.event.production_qualified, false);
    const ack = { event_ref: claim.event.event_ref, generation: claim.generation, claimToken,
      acknowledgement: { event_ref: claim.event.event_ref, delivered: true } };
    armed = true; await assert.rejects(alerts.acknowledge(ack), { code: 'TELEMETRY_UNAVAILABLE' });
    assert.equal((await alerts.acknowledge(ack)).acknowledged, true);
    const drainer = createManagedTelemetryDrainer({ store: a, deliver: async (event) => ({ event_ref: event.event_ref, delivered: true }) });
    try { assert.equal((await drainer.runOnce()).delivered, 1); } finally { await drainer.close(); }
    advance(2000); const owner = (await pool.query('SELECT current_user AS name')).rows[0].name;
    for (const eventKind of ['policy','alert']) assert.equal((await prunePostgresManagedTelemetry({ ...options, expectedOwner: owner, eventKind })).removed, 1);
    await (await make()).append(event);
    assert.equal((await a.readMetrics({ tenant_hash: tenantHash })).windows[0].count, 1);
    for (const table of ['telemetry_events','telemetry_metric_alerts']) assert.equal((await pool.query(`SELECT count(*)::integer AS n FROM ${s}.${table}`)).rows[0].n, 0);
  });
});

for (const version of [3,4]) test(`existing v${version} settings cannot add budget rule; catalog-only v5 upgrade preserves custody`, { skip, timeout: 90000 }, async () => {
  await fixture(async ({ options, make, snapshot }) => {
    const old = await make();
    const legacy = createManagedTelemetryEvent({ event: 'rate_denied', route_class: 'admission', status: 429,
      outcome: 'rate_limited', duration_ms: 0, tenant_hash: tenantHash, key_hash: sha256Ref('key') });
    await old.append(legacy); const before = await snapshot();
    await assert.rejects(migratePostgresManagedTelemetry({ ...options, metricVersion: 5, metricSettings: settings }), { code: 'TELEMETRY_MIGRATION_FAILED' });
    assert.deepEqual(await snapshot(), before);
    assert.equal((await migratePostgresManagedTelemetry({ ...options, metricVersion: 5 })).migration_version, 5);
    await assert.rejects(old.stats(), { code: 'TELEMETRY_UNAVAILABLE' });
    const current = await make('policy', { metricVersion: 5 }); await current.append(packet());
    const read = await current.readMetrics({ tenant_hash: tenantHash });
    assert.equal(read.windows[0].rule_id, 'rate_denied'); assert.equal(read.windows[0].count, 1);
    const after = await snapshot();
    for (const table of ['telemetry_metric_settings','telemetry_metric_windows','telemetry_metric_alerts']) assert.deepEqual(after[table], before[table]);
  }, { metricVersion: version, metricSettings: oldSettings });
});

for (const version of [3,4]) test(`v${version} durable recorder rejects opt-in budget packets with truthful failed health`, { skip, timeout: 90000 }, async () => {
  await fixture(async ({ make, pool, s }) => {
    const store = await make(), f = await createFixture();
    const p = createManagedRequestPolicy({ readControl: async () => ({ enabled: true, epoch: 0 }),
      consumeRateLimit: async () => ({ allowed: true, retry_after_seconds: 0 }), observeBudgetDenials: true,
      recordTelemetry: (event, options) => store.append(event, options) });
    const decision = await p.beforeMutation({ principal: f.principal, routeClass: 'admission' });
    assert.equal(p.observeAdmissionDenial(decision, managedError('not retained', 'DAILY_BUDGET_EXCEEDED', 429)), true);
    assert.equal((await p.flushTelemetry()).settled, true);
    assert.equal(p.telemetryHealth().recorded, 1); assert.equal(p.telemetryHealth().failed, 1);
    assert.equal((await pool.query(`SELECT 1 FROM ${s}.telemetry_events WHERE outcome='budget_limited'`)).rowCount, 0);
    assert.equal((await store.readMetrics({ tenant_hash: tenantHash })).windows.length, 0);
  }, { metricVersion: version, metricSettings: oldSettings });
});

for (const lifecycle of [false,true]) test(`v${lifecycle ? 2 : 1} upgrade to v5 preserves uncounted historical custody`, { skip, timeout: 90000 }, async () => {
  await fixture(async ({ options, pool, s, make }) => {
    const prior = { ...options, lifecycle, metrics: false, metricVersion: undefined, metricSettings: undefined };
    await migratePostgresManagedTelemetry(prior);
    const legacy = createManagedTelemetryEvent({ event: 'rate_denied', route_class: 'admission', status: 429,
      outcome: 'rate_limited', duration_ms: 0, tenant_hash: tenantHash, key_hash: sha256Ref('legacy') });
    await (await make('policy', prior)).append(legacy);
    let historical;
    if (lifecycle) {
      const event = createManagedAuditEvent({ event_ref: 'evt_historical', tenant_id: 'tenant_alpha', invocation_ref: 'rfi_historical',
        sequence: 1, event_type: 'execution_outcome_recorded', occurred_at: '2026-09-05T12:00:00.000Z',
        details: { outcome: 'failed' }, prior_event_hash: null });
      const anchor = { tenant_id: 'tenant_alpha', invocation_ref: 'rfi_historical', audit_event_count: 1,
        audit_head_hash: event.event_hash, prior_event: null, events: [event] };
      historical = { scope: { observer_hash: sha256Ref('historical'), tenant_hash: lifecycleTenantHash('tenant_alpha') },
        tenant_id: 'tenant_alpha', expected_sweep: null, expected_checkpoint: null,
        page: { tenant_id: 'tenant_alpha', upper_ref: 'rfi_historical', invocations: [{ invocation_ref: 'rfi_historical',
          audit_event_count: 1, audit_head_hash: event.event_hash }], complete: true, next_after_ref: 'rfi_historical' },
        window: verifyManagedAuditWindow(anchor, { tenant_id: 'tenant_alpha', invocation_ref: 'rfi_historical',
          after_sequence: 0, prior_event_hash: null, limit: 64 }) };
      await (await make('lifecycle', prior)).appendLifecycleWindow(historical);
    }
    const rows = (await pool.query(`SELECT * FROM ${s}.telemetry_events ORDER BY 1`)).rows;
    assert.equal((await migratePostgresManagedTelemetry(options)).migration_version, 5);
    const current = await make(); await current.append(legacy);
    if (historical) await (await make('lifecycle')).appendLifecycleWindow(historical);
    assert.deepEqual((await pool.query(`SELECT * FROM ${s}.telemetry_events ORDER BY 1`)).rows, rows);
    assert.equal((await current.readMetrics({ tenant_hash: tenantHash })).legacy_uncounted, 1);
    assert.equal((await pool.query(`SELECT 1 FROM ${s}.telemetry_metric_windows`)).rowCount, 0);
    assert.deepEqual((await pool.query(`SELECT version FROM ${s}.telemetry_schema_migrations ORDER BY version`)).rows.map((row) => row.version), [1,2,3,4,5]);
    if (historical) assert.equal((await current.readMetrics({ tenant_hash: lifecycleTenantHash('tenant_alpha') })).legacy_uncounted, 1);
    await current.append(packet()); assert.equal((await current.readMetrics({ tenant_hash: tenantHash })).windows[0].count, 1);
  }, { migrate: false });
});

test('v5 lifetime source capacity rolls back the entire packet/count transaction', { skip, timeout: 90000 }, async () => {
  await fixture(async ({ make, snapshot }) => {
    const store = await make(); await store.append(packet()); const before = await snapshot();
    await assert.rejects(store.append(packet()), { code: 'TELEMETRY_CAPACITY' });
    assert.deepEqual(await snapshot(), before);
  }, { metricSettings: { ...settings, maxSources: 1, maxSourcesPerTenant: 1 } });
});

for (const [name, cap, sameTenant] of [
  ['tenant source', { maxSourcesPerTenant: 1 }, true],
  ['global window', { maxWindows: 1, maxWindowsPerTenant: 1 }, false],
  ['tenant window', { maxWindowsPerTenant: 1 }, true],
  ['global alert', { maxAlerts: 1, maxAlertsPerTenant: 1 }, false],
  ['tenant alert', { maxAlertsPerTenant: 1 }, true],
]) test(`v5 ${name} capacity rolls back every source/count/alert write`, { skip, timeout: 90000 }, async () => {
  await fixture(async ({ make, snapshot, advance }) => {
    const store = await make(); await store.append(packet()); const before = await snapshot();
    if (sameTenant && name !== 'tenant source') advance(86400001);
    await assert.rejects(store.append(packet('daily_budget_denied', sameTenant ? tenantHash : sha256Ref('other tenant'))),
      { code: 'TELEMETRY_CAPACITY' });
    assert.deepEqual(await snapshot(), before);
    if (name.startsWith('tenant')) {
      await store.append(packet('invocation_budget_denied', sha256Ref('other tenant')));
      assert.equal((await store.readMetrics({ tenant_hash: sha256Ref('other tenant') })).windows[0].count, 1);
    }
  }, { metricSettings: { ...settings, ...cap } });
});

test('v5 separate-runtime CA TLS and unchanged exact grants reject mutation and catalog drift', { skip, timeout: 90000 }, async () => {
  const root = new pg.Pool({ connectionString });
  const suffix = randomUUID().replaceAll('-', ''), db = `budget_roles_${suffix}`, schemaName = 'budget_observer', s = qid(schemaName);
  const owner = `bm_owner_${suffix}`, runtime = `bm_runtime_${suffix}`, password = `disposable-${randomUUID()}`;
  const url = new URL(connectionString); url.pathname = `/${db}`;
  let admin, ownerPool, runtimePool, store, alerts, created = false;
  try {
    await root.query(`CREATE DATABASE ${qid(db)}`); created = true; admin = new pg.Pool({ connectionString: url.toString() });
    for (const role of [owner,runtime]) await admin.query(`CREATE ROLE ${qid(role)} LOGIN NOINHERIT PASSWORD '${password}'`);
    const replace = (text) => text.replaceAll('__TELEMETRY_DATABASE__', qid(db)).replaceAll('__TELEMETRY_SCHEMA__', s)
      .replaceAll('__TELEMETRY_MIGRATOR__', qid(owner)).replaceAll('__TELEMETRY_RUNTIME__', qid(runtime));
    const [bootstrap, grants] = replace(await readFile(new URL('../ops/postgres/telemetry-roles.sql.template', import.meta.url), 'utf8'))
      .split('-- Dedicated migrator AFTER migratePostgresManagedTelemetry:');
    await admin.query(bootstrap); url.username = owner; url.password = password; ownerPool = new pg.Pool({ connectionString: url.toString() });
    const options = { schemaName, limits, lifecycle: true, metrics: true, metricVersion: 5, metricSettings: settings };
    await migratePostgresManagedTelemetry({ ...options, pool: ownerPool, requireTls: false, disposableDb: true });
    await ownerPool.query(grants);
    for (const file of ['lifecycle-grants.sql.template','metrics-grants.sql.template']) await ownerPool.query(replace(await readFile(new URL('../ops/postgres/'+file, import.meta.url), 'utf8')));
    url.username = runtime; runtimePool = new pg.Pool({ connectionString: url.toString() });
    const ca = process.env.RISK_FORK_TEST_POSTGRES_TLS_CA; assert.equal(typeof ca, 'string');
    const runtimeOptions = { ...options, connectionString: url.toString(), expectedOwner: owner, tls: { ca } };
    store = await createPostgresManagedTelemetryStore(runtimeOptions); alerts = await createPostgresManagedTelemetryStore({ ...runtimeOptions, eventKind: 'alert' });
    assert.equal((await store.initialize()).runtime_privileges_verified, true);
    await store.append(packet()); assert.equal((await store.readMetrics({ tenant_hash: tenantHash })).windows[0].count, 1);
    await assert.rejects(createPostgresManagedTelemetryStore({ ...runtimeOptions, tls: { ca: rootCertificates[0] } }), { code: 'TELEMETRY_UNAVAILABLE' });
    for (const sql of [`UPDATE ${s}.telemetry_events SET event='policy_allowed'`, `UPDATE ${s}.telemetry_metric_sources SET payload='{}'`,
      `DELETE FROM ${s}.telemetry_metric_sources`, `TRUNCATE ${s}.telemetry_metric_windows`, `UPDATE ${s}.telemetry_metric_settings SET payload='{}'`,
      `UPDATE ${s}.telemetry_schema_migrations SET migration_hash='bad'`, `ALTER TABLE ${s}.telemetry_events ADD COLUMN bypass text`]) await assert.rejects(runtimePool.query(sql), { code: '42501' });
    await ownerPool.query(`ALTER TABLE ${s}.telemetry_events DROP CONSTRAINT telemetry_events_check`);
    await assert.rejects(alerts.stats(), { code: 'TELEMETRY_UNAVAILABLE' });
  } finally {
    const errors = [], cleanup = async (fn) => { try { await fn(); } catch (e) { errors.push(e); } };
    await cleanup(() => store?.close()); await cleanup(() => alerts?.close());
    for (const pool of [runtimePool,ownerPool,admin]) await cleanup(() => pool?.end());
    if (created) await cleanup(() => root.query(`DROP DATABASE ${qid(db)}`));
    for (const role of [runtime,owner]) await cleanup(() => root.query(`DROP ROLE IF EXISTS ${qid(role)}`));
    await cleanup(async () => assert.equal((await root.query('SELECT 1 FROM pg_database WHERE datname=$1', [db])).rowCount, 0));
    await cleanup(async () => assert.equal((await root.query('SELECT 1 FROM pg_roles WHERE rolname=ANY($1::text[])', [[owner,runtime]])).rowCount, 0));
    await cleanup(() => root.end()); if (errors.length) throw new AggregateError(errors, 'Budget role cleanup failed');
  }
});
