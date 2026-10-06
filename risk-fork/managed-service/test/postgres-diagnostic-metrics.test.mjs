import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import pg from 'pg';
import { sha256Ref } from '../../src/canonical.mjs';
import { createManagedDiagnosticObservation } from '../src/diagnostic-event.mjs';
import { createManagedTelemetryEvent } from '../src/telemetry-event.mjs';
import { createManagedBacklogObserver } from '../src/backlog-observer.mjs';
import { createManagedLifecycleObserver } from '../src/lifecycle-observer.mjs';
import { lifecycleTenantHash } from '../src/lifecycle-event.mjs';
import { migratePostgresManagedTelemetry } from '../src/postgres-telemetry-migrator.mjs';
import { createPostgresManagedTelemetryStore } from '../src/postgres-telemetry-store.mjs';
import { prunePostgresManagedTelemetry } from '../src/postgres-telemetry-maintenance.mjs';
import { createManagedTelemetryDrainer } from '../src/telemetry-drainer.mjs';
import { createFixture, invocationRequest } from './helpers.mjs';

const connectionString = process.env.RISK_FORK_MANAGED_TEST_POSTGRES_URL;
if (!connectionString && process.env.RISK_FORK_MANAGED_REQUIRE_POSTGRES_TESTS === '1') throw new Error('Mandatory diagnostic metrics require PostgreSQL');
const skip = !connectionString;
if (connectionString) {
  const url = new URL(connectionString);
  if (!['127.0.0.1','localhost','[::1]'].includes(url.hostname) || url.pathname !== '/risk_fork_managed_test'
    || process.env.RISK_FORK_MANAGED_TEST_CONFIRM_DISPOSABLE !== 'YES_DELETE_DATA') throw new Error('Diagnostics need explicit disposable loopback DB');
}
const limits = { maxEvents: 100,maxEventsPerTenant: 100,leaseMs: 30000,retryMs: 100,retentionMs: 1000 };
const metricSettings = { maxSources: 100,maxSourcesPerTenant: 100,maxWindows: 100,maxWindowsPerTenant: 100,maxAlerts: 100,maxAlertsPerTenant: 100,
  rules: [{ rule_id: 'rate_denied',threshold: 1,window_ms: 86400000 }] };
const diagnosticSettings = { bucket_ms: 1000,max_age_ms: 60000,max_future_ms: 1000,
  rules: [{ rule_id: 'observer_backlog_source_read_unconfirmed',threshold: 2,window_ms: 86400000 }] };
const tenantHash = lifecycleTenantHash('tenant_alpha'), token = (n) => `claim_${String(n).padStart(5,'0')}_${'x'.repeat(48)}`;
const packet = (observed_ms = Date.now(),more = {},settings = diagnosticSettings) => createManagedDiagnosticObservation({
  tenant_hash: tenantHash,observer_hash: sha256Ref('observer'),boundary: 'backlog_source_read',observed_ms,...more },settings);
async function fixture(run,overrides = {}) {
  const schemaName = `diagnostics_${randomUUID().replaceAll('-','')}`, s = `"${schemaName}"`, pool = new pg.Pool({ connectionString,max: 8 });
  const stores = [], options = { pool,schemaName,requireTls: false,disposableDb: true,limits,lifecycle: true,metrics: true,metricVersion: 10,
    metricSettings,backlogSettings: { maxTenants: 100 },backlogAlertSettings: { maxAlerts: 100,maxAlertsPerTenant: 100,
      rules: [{ rule_id: 'cleanup_pending_count',threshold: 2 }] },diagnosticSettings,...overrides };
  const make = async (more = {}) => { const store = await createPostgresManagedTelemetryStore({ ...options,...more }); stores.push(store); return store; };
  const snapshot = async () => {
    const result = {};
    for (const table of ['telemetry_schema_migrations','telemetry_settings','telemetry_metric_settings','telemetry_metric_sources','telemetry_metric_windows',
      'telemetry_metric_totals','telemetry_metric_alerts','telemetry_diagnostic_settings','telemetry_backlog_settings','telemetry_backlog_state',
      'telemetry_backlog_totals','telemetry_backlog_alert_settings','telemetry_backlog_alert_state','telemetry_backlog_alert_totals','telemetry_backlog_alerts']) {
      result[table] = (await pool.query(`SELECT * FROM ${s}.${table} ORDER BY 1,2`)).rows;
    }
    return result;
  };
  const ack = (store,claim,n) => store.acknowledge({ event_ref: claim.event.event_ref,generation: claim.generation,claimToken: token(n),
    acknowledgement: { event_ref: claim.event.event_ref,delivered: true } });
  try { await migratePostgresManagedTelemetry(options); await run({ pool,s,options,make,snapshot,ack }); }
  finally {
    const errors = [], cleanup = async (fn) => { try { await fn(); } catch (error) { errors.push(error); } };
    for (const store of stores) await cleanup(() => store.close());
    await cleanup(() => pool.query(`DROP SCHEMA IF EXISTS ${s} CASCADE`));
    await cleanup(async () => assert.equal((await pool.query('SELECT 1 FROM pg_namespace WHERE nspname=$1',[schemaName])).rowCount,0));
    await cleanup(() => pool.end()); if (errors.length) throw new AggregateError(errors,'Diagnostic test cleanup failed');
  }
}
test('v10 coalesces exact buckets across instances, retains typed source and delivers via the existing metric drainer', { skip,timeout: 90000 }, async () => {
  await fixture(async ({ make,pool,s,ack }) => {
    const a = await make(), b = await make(), delivery = await make({ eventKind: 'alert' }), event = packet();
    const replies = await Promise.all([a.appendDiagnosticObservation(event),b.appendDiagnosticObservation(event)]);
    assert.deepEqual(replies,[{ event_ref: event.event_ref,persisted: true },{ event_ref: event.event_ref,persisted: true }]);
    let metrics = await a.readMetrics({ tenant_hash: tenantHash }); assert.equal(metrics.retained_sources,1); assert.equal(metrics.windows[0].count,1);
    assert.equal(await delivery.claim({ claimToken: token(1) }),null);
    const second = packet(event.bucket_start_ms-1000); await b.appendDiagnosticObservation(second);
    const custody = (await pool.query(`SELECT payload FROM ${s}.telemetry_metric_sources WHERE event_ref=$1`,[event.event_ref])).rows[0].payload;
    assert.deepEqual(custody.diagnostic_event,event); assert.equal(custody.legacy_uncounted,false);
    const claim = await delivery.claim({ claimToken: token(1) }); assert.equal(claim.event.source_kind,'diagnostic');
    assert.equal(claim.event.coverage,'ingested_unconfirmed_buckets_only'); assert.equal(claim.event.count,2);
    assert.equal(await a.claim({ claimToken: token(7) }),null,'policy lane cannot consume diagnostic alerts');
    await assert.rejects(delivery.acknowledge({ event_ref: claim.event.event_ref,generation: claim.generation,claimToken: token(2),
      acknowledgement: { event_ref: claim.event.event_ref,delivered: true } }),{ code: 'TELEMETRY_STALE_CLAIM' });
    await ack(delivery,claim,1); assert.deepEqual(await ack(delivery,claim,1),{ event_ref: claim.event.event_ref,acknowledged: true });
    const restarted = await make(); await restarted.appendDiagnosticObservation(event);
    metrics = await restarted.readMetrics({ tenant_hash: tenantHash }); assert.equal(metrics.retained_sources,2); assert.equal(metrics.windows[0].count,2);
    const third = packet(event.bucket_start_ms-2000); await restarted.appendDiagnosticObservation(third);
    assert.equal((await restarted.readMetrics({ tenant_hash: tenantHash })).windows[0].count,3);
    assert.equal((await delivery.stats()).acked,1); assert.equal((await pool.query(`SELECT count(*)::integer AS n FROM ${s}.telemetry_metric_alerts`)).rows[0].n,1);
  });
});
test('v10 each persistence edge rolls back atomically and exact unknown-COMMIT replay never moves windows', { skip,timeout: 90000 }, async () => {
  await fixture(async ({ make,pool,s,snapshot }) => {
    let fault = null,lost = false;
    const wrapped = { async connect() { const c = await pool.connect(); return { release: () => c.release(),async query(sql,params) {
      if (fault && sql.startsWith(fault)) { fault = null; throw null; }
      const result = await c.query(sql,params); if (lost && sql === 'COMMIT') { lost = false; throw new Error('unknown commit'); } return result;
    } }; } };
    const a = await make({ pool: wrapped }), b = await make(), event = packet();
    await a.appendDiagnosticObservation(event); const second = packet(event.bucket_start_ms-1000);
    for (const point of ['INSERT INTO '+s+'.telemetry_metric_alerts','UPDATE '+s+'.telemetry_metric_windows',
      'INSERT INTO '+s+'.telemetry_metric_sources','UPDATE '+s+'.telemetry_metric_totals','COMMIT']) {
      const before = await snapshot(); fault = point;
      await assert.rejects(a.appendDiagnosticObservation(second),{ code: 'TELEMETRY_UNAVAILABLE' }); assert.deepEqual(await snapshot(),before);
    }
    lost = true; await assert.rejects(a.appendDiagnosticObservation(second),{ code: 'TELEMETRY_UNAVAILABLE' });
    const committed = await snapshot(); assert.deepEqual(await b.appendDiagnosticObservation(second),{ event_ref: second.event_ref,persisted: true });
    assert.deepEqual(await snapshot(),committed); assert.equal((await b.readMetrics({ tenant_hash: tenantHash })).windows[0].count,2);
  });
});
test('v10 diagnostic counts share legacy source/window/alert global and per-tenant capacity', { skip,timeout: 90000 }, async () => {
  for (const cap of ['maxSources','maxSourcesPerTenant','maxWindows','maxWindowsPerTenant','maxAlerts','maxAlertsPerTenant']) {
    await fixture(async ({ make,snapshot }) => {
      const store = await make();
      await store.append(createManagedTelemetryEvent({ event: 'rate_denied',route_class: 'admission',status: 429,outcome: 'rate_limited',duration_ms: 0,
        tenant_hash: tenantHash,key_hash: sha256Ref('key') }));
      const before = await snapshot();
      await assert.rejects(store.appendDiagnosticObservation(packet(Date.now(),{}, { ...diagnosticSettings,rules: [{ ...diagnosticSettings.rules[0],threshold: 1 }] })),{ code: 'TELEMETRY_CAPACITY' });
      assert.deepEqual(await snapshot(),before);
    },{ metricSettings: { ...metricSettings,[cap]: 1,...(!cap.endsWith('PerTenant') ? { [cap+'PerTenant']: 1 } : {}) },
      diagnosticSettings: { ...diagnosticSettings,rules: [{ ...diagnosticSettings.rules[0],threshold: 1 }] } });
  }
});
test('v10 clock admission, abort, settings/catalog drift fail closed without repairs or synthetic clears', { skip,timeout: 90000 }, async () => {
  await fixture(async ({ make,pool,s,options,snapshot }) => {
    const store = await make(), before = await snapshot();
    for (const event of [packet(0),packet(Date.now()+100000)]) {
      await assert.rejects(store.appendDiagnosticObservation(event),{ code: 'TELEMETRY_UNAVAILABLE' }); assert.deepEqual(await snapshot(),before);
    }
    const stopped = new AbortController(); stopped.abort(); await assert.rejects(store.appendDiagnosticObservation(packet(),{ signal: stopped.signal }));
    assert.deepEqual(await snapshot(),before);
    await assert.rejects(make({ diagnosticSettings: { ...diagnosticSettings,max_age_ms: 61000 } }),{ code: 'TELEMETRY_UNAVAILABLE' });
    await pool.query(`ALTER TABLE ${s}.telemetry_diagnostic_settings ADD COLUMN drift text`);
    const drifted = await snapshot(); await assert.rejects(store.stats(),{ code: 'TELEMETRY_UNAVAILABLE' });
    await assert.rejects(migratePostgresManagedTelemetry(options),{ code: 'TELEMETRY_MIGRATION_FAILED' }); assert.deepEqual(await snapshot(),drifted);
  });
});
test('v10 diagnostic source conflict, window and alert tampering are rejected on exact replay', { skip,timeout: 90000 }, async () => {
  for (const kind of ['source','window','alert']) await fixture(async ({ make,pool,s }) => {
    const store = await make(), event = packet(); await store.appendDiagnosticObservation(event); await store.appendDiagnosticObservation(packet(event.bucket_start_ms-1000));
    if (kind === 'source') await pool.query(`UPDATE ${s}.telemetry_metric_sources SET payload=jsonb_set(payload,'{diagnostic_event,boundary}','"audit_window_read"') WHERE event_ref=$1`,[event.event_ref]);
    if (kind === 'window') await pool.query(`UPDATE ${s}.telemetry_metric_windows SET payload=jsonb_set(payload,'{rules_hash}',$1::jsonb)`,[JSON.stringify(sha256Ref('bad'))]);
    if (kind === 'alert') await pool.query(`UPDATE ${s}.telemetry_metric_alerts SET payload=jsonb_set(payload,'{coverage}','"all_traffic"')`);
    await assert.rejects(store.appendDiagnosticObservation(event));
  });
});
test('v10 pruning ACKed threshold delivery preserves exact bucket custody and original windows', { skip,timeout: 90000 }, async () => {
  await fixture(async ({ make,pool,s,options,ack }) => {
    const store = await make(), event = packet(), delivery = await make({ eventKind: 'alert' });
    await store.appendDiagnosticObservation(event); await store.appendDiagnosticObservation(packet(event.bucket_start_ms-1000));
    const claim = await delivery.claim({ claimToken: token(1) }); await ack(delivery,claim,1);
    await delay(1050);
    const owner = (await pool.query('SELECT current_user AS name')).rows[0].name;
    const result = await prunePostgresManagedTelemetry({ ...options,expectedOwner: owner,eventKind: 'alert' }); assert.equal(result.removed,1);
    assert.equal((await pool.query(`SELECT count(*)::integer AS n FROM ${s}.telemetry_metric_alerts`)).rows[0].n,0);
    await store.appendDiagnosticObservation(event); assert.equal((await store.readMetrics({ tenant_hash: tenantHash })).windows[0].count,2);
    assert.equal(await delivery.claim({ claimToken: token(2) }),null,'absence never emits a clear or re-creates delivery');
  });
});
test('v10 real trusted observer records a failed source boundary and existing drainer rejects forged sink ACK', { skip,timeout: 90000 }, async () => {
  await fixture(async ({ make,pool,s }) => {
    const store = await make(), delivery = await make({ eventKind: 'alert' }), principal = Object.freeze({ tenant_id: 'tenant_alpha',scopes: Object.freeze(['audit:read']) });
    const now = Date.now(); let packets = 0;
    const observer = createManagedBacklogObserver({ store,auditPrincipals: [principal],observerId: 'actual-host-observer',diagnosticSettings,
      diagnosticClock: () => now,controlPlane: { async readCleanupRecoveryBacklog(original) { assert.equal(original,principal); packets++; throw null; } } });
    let drainer;
    try {
      const first = await observer.runOnce(); assert.equal(first.diagnostics.recorded,1); await observer.runOnce();
      assert.equal((await store.readMetrics({ tenant_hash: tenantHash })).retained_sources,1);
      const other = packet(now-1000,{ observer_hash: sha256Ref({ domain: 'risk-fork-backlog-observer-v1',observer_id: 'actual-host-observer' }) });
      await store.appendDiagnosticObservation(other);
      drainer = createManagedTelemetryDrainer({ store: delivery,eventKind: 'alert',deliver: async () => ({ delivered: true,event_ref: 'wrong' }),deliveryTimeoutMs: 50 });
      assert.equal((await drainer.runOnce()).failed,1); assert.equal((await delivery.stats()).acked,0); assert.equal(packets,2);
      assert.equal((await pool.query(`SELECT count(*)::integer AS n FROM ${s}.telemetry_backlog_state`)).rows[0].n,0);
    } finally { await drainer?.close(); await observer.close(); }
  });
});
test('v9 to v10 upgrade adds independent settings without modifying prior metric custody; legacy catalog fails closed', { skip,timeout: 90000 }, async () => {
  await fixture(async ({ pool,s,options }) => {
    const legacy = { ...options,metricVersion: 9,diagnosticSettings: undefined };
    // Start a separately owned v9 schema so this verifies the actual upgrade.
    const schemaName = options.schemaName+'_old', q = `"${schemaName}"`; let old, current;
    try {
      await migratePostgresManagedTelemetry({ ...legacy,schemaName }); old = await createPostgresManagedTelemetryStore({ ...legacy,schemaName });
      await old.append(createManagedTelemetryEvent({ event: 'rate_denied',route_class: 'admission',status: 429,outcome: 'rate_limited',duration_ms: 0,tenant_hash: tenantHash,key_hash: sha256Ref('key') }));
      const before = {};
      for (const table of ['telemetry_metric_settings','telemetry_metric_sources','telemetry_metric_windows','telemetry_metric_alerts','telemetry_metric_totals']) before[table] = (await pool.query(`SELECT * FROM ${q}.${table} ORDER BY 1`)).rows;
      await migratePostgresManagedTelemetry({ ...options,schemaName });
      for (const [table,rows] of Object.entries(before)) assert.deepEqual((await pool.query(`SELECT * FROM ${q}.${table} ORDER BY 1`)).rows,rows);
      await assert.rejects(old.stats(),{ code: 'TELEMETRY_UNAVAILABLE' });
      current = await createPostgresManagedTelemetryStore({ ...options,schemaName }); await current.appendDiagnosticObservation(packet());
      assert.equal((await current.readMetrics({ tenant_hash: tenantHash })).retained_sources,2);
      await assert.rejects(migratePostgresManagedTelemetry({ ...options,schemaName,metricSettings: { ...metricSettings,maxSources: 101 } }),{ code: 'TELEMETRY_MIGRATION_FAILED' });
      assert.equal((await pool.query(`SELECT count(*)::integer AS n FROM ${s}.telemetry_metric_sources`)).rows[0].n,0);
    } finally { await old?.close(); await current?.close(); await pool.query(`DROP SCHEMA IF EXISTS ${q} CASCADE`); }
  });
});
test('v10 exact stale replay is confirmable but DB rollback/new stale buckets and missing observations never clear', { skip,timeout: 90000 }, async () => {
  await fixture(async ({ make,pool,s,snapshot }) => {
    let now = Date.now()+1000;
    const timed = { async connect() { const c = await pool.connect(); return { release: () => c.release(),async query(sql,params) {
      const result = await c.query(sql,params);
      return sql === 'SELECT floor(extract(epoch FROM clock_timestamp()) * 1000)::bigint AS now_ms' ? { ...result,rows: [{ now_ms: String(now) }] } : result;
    } }; } };
    const store = await make({ pool: timed }), event = packet(now); await store.appendDiagnosticObservation(event);
    await store.appendDiagnosticObservation(packet(now-1000)); const original = await snapshot();
    now += 120000; await store.appendDiagnosticObservation(event); assert.deepEqual(await snapshot(),original);
    const metrics = await store.readMetrics({ tenant_hash: tenantHash }); assert.equal(metrics.windows.length,1); assert.equal(metrics.windows[0].count,2);
    assert.equal((await pool.query(`SELECT count(*)::integer AS n FROM ${s}.telemetry_metric_alerts`)).rows[0].n,1);
    await assert.rejects(store.appendDiagnosticObservation(packet(event.bucket_start_ms-2000)),{ code: 'TELEMETRY_UNAVAILABLE' });
    assert.deepEqual(await snapshot(),original);
    now -= 1; await assert.rejects(store.appendDiagnosticObservation(event),{ code: 'TELEMETRY_UNAVAILABLE' }); assert.deepEqual(await snapshot(),original);
  });
});
test('v10 DB clock lock cancellation never persists a late diagnostic after the caller deadline', { skip,timeout: 90000 }, async () => {
  await fixture(async ({ make,pool,s,snapshot }) => {
    const store = await make(), locker = await pool.connect(), before = await snapshot();
    const controller = new AbortController();
    try {
      await locker.query('BEGIN'); await locker.query(`SELECT last_seen_ms FROM ${s}.telemetry_clock WHERE singleton=true FOR UPDATE`);
      const pending = store.appendDiagnosticObservation(packet(),{ signal: controller.signal });
      await delay(30); controller.abort(); await locker.query('COMMIT');
      await assert.rejects(pending,{ code: 'REQUEST_TIMEOUT' }); assert.deepEqual(await snapshot(),before);
    } finally { await locker.query('ROLLBACK').catch(() => {}); locker.release(); }
  });
});
test('v10 actual lifecycle observer rejects malformed audit windows before append and retains exact diagnostic custody', { skip,timeout: 90000 }, async () => {
  const settings = { ...diagnosticSettings,rules: [{ rule_id: 'observer_audit_window_read_unconfirmed',threshold: 1,window_ms: 86400000 }] };
  await fixture(async ({ make,pool,s }) => {
    const f = await createFixture(); await f.controlPlane.admitInvocation(f.principal,invocationRequest({ estimated_cost_micros: 0 }));
    const store = await make(), observer = createManagedLifecycleObserver({ store,auditPrincipals: [f.principal],observerId: 'actual-lifecycle',diagnosticSettings: settings,
      controlPlane: { listAuditInvocations: (...args) => f.controlPlane.listAuditInvocations(...args),readAuditWindow: () => ({ events: [] }) } });
    try {
      const health = await observer.runOnce(); assert.equal(health.failed,1); assert.equal(health.failure_counts.audit_window_read,1); assert.equal(health.diagnostics.recorded,1);
      const row = (await pool.query(`SELECT payload FROM ${s}.telemetry_metric_sources`)).rows[0]; assert.equal(row.payload.diagnostic_event.boundary,'audit_window_read');
      assert.equal((await store.readMetrics({ tenant_hash: tenantHash })).windows[0].count,1);
      assert.equal((await pool.query(`SELECT count(*)::integer AS n FROM ${s}.telemetry_lifecycle_sweeps`)).rows[0].n,0);
    } finally { await observer.close(); }
  },{ diagnosticSettings: settings });
});
