import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import pg from 'pg';
import { sha256Ref } from '../../src/canonical.mjs';
import { createManagedWorkerDiagnosticObservation } from '../src/worker-diagnostic-event.mjs';
import { createManagedDiagnosticObservation } from '../src/diagnostic-event.mjs';
import { createManagedTelemetryEvent } from '../src/telemetry-event.mjs';
import { lifecycleTenantHash } from '../src/lifecycle-event.mjs';
import { createManagedRiskForkWorker } from '../src/worker.mjs';
import { migratePostgresManagedTelemetry } from '../src/postgres-telemetry-migrator.mjs';
import { createPostgresManagedTelemetryStore } from '../src/postgres-telemetry-store.mjs';
import { prunePostgresManagedTelemetry } from '../src/postgres-telemetry-maintenance.mjs';
import { createManagedTelemetryDrainer } from '../src/telemetry-drainer.mjs';
import { workerDiagnosticFixture } from './helpers/worker-diagnostic-fixture.mjs';

const connectionString = process.env.RISK_FORK_MANAGED_TEST_POSTGRES_URL;
if (!connectionString && process.env.RISK_FORK_MANAGED_REQUIRE_POSTGRES_TESTS === '1') throw new Error('Mandatory worker diagnostics require PostgreSQL');
const skip = !connectionString;
if (connectionString) {
  const url = new URL(connectionString);
  if (!['127.0.0.1','localhost','[::1]'].includes(url.hostname) || url.pathname !== '/risk_fork_managed_test'
    || process.env.RISK_FORK_MANAGED_TEST_CONFIRM_DISPOSABLE !== 'YES_DELETE_DATA') throw new Error('Worker diagnostics need explicit disposable loopback DB');
}
const limits = { maxEvents: 100,maxEventsPerTenant: 100,leaseMs: 30000,retryMs: 100,retentionMs: 1000 };
const metricSettings = { maxSources: 100,maxSourcesPerTenant: 100,maxWindows: 100,maxWindowsPerTenant: 100,maxAlerts: 100,maxAlertsPerTenant: 100,
  rules: [{ rule_id: 'rate_denied',threshold: 1,window_ms: 86400000 }] };
const diagnosticSettings = { bucket_ms: 1000,max_age_ms: 60000,max_future_ms: 1000,
  rules: [{ rule_id: 'observer_backlog_source_read_unconfirmed',threshold: 2,window_ms: 86400000 }] };
const workerDiagnosticSettings = { ...diagnosticSettings,rules: [{ rule_id: 'worker_provider_call_unconfirmed',threshold: 2,window_ms: 86400000 }] };
const tenantHash = lifecycleTenantHash('tenant_alpha'), token = (n) => `claim_${String(n).padStart(5,'0')}_${'x'.repeat(48)}`;
const packet = (observed_ms = Date.now(),more = {},settings = workerDiagnosticSettings) => createManagedWorkerDiagnosticObservation({
  tenant_hash: tenantHash,worker_hash: sha256Ref('worker'),boundary: 'provider_call',observed_ms,...more },settings);
async function fixture(run,overrides = {}) {
  const schemaName = `worker_diag_${randomUUID().replaceAll('-','')}`, s = '"'+schemaName+'"', pool = new pg.Pool({ connectionString,max: 8 });
  const stores = [], options = { pool,schemaName,requireTls: false,disposableDb: true,limits,lifecycle: true,metrics: true,metricVersion: 11,
    metricSettings,backlogSettings: { maxTenants: 100 },backlogAlertSettings: { maxAlerts: 100,maxAlertsPerTenant: 100,
      rules: [{ rule_id: 'cleanup_pending_count',threshold: 2 }] },diagnosticSettings,workerDiagnosticSettings,...overrides };
  const make = async (more = {}) => { const store = await createPostgresManagedTelemetryStore({ ...options,...more }); stores.push(store); return store; };
  const snapshot = async () => {
    const result = {};
    for (const table of ['telemetry_schema_migrations','telemetry_settings','telemetry_metric_settings','telemetry_metric_sources','telemetry_metric_windows',
      'telemetry_metric_totals','telemetry_metric_alerts','telemetry_diagnostic_settings','telemetry_backlog_settings','telemetry_backlog_state',
      'telemetry_backlog_totals','telemetry_backlog_alert_settings','telemetry_backlog_alert_state','telemetry_backlog_alert_totals','telemetry_backlog_alerts',
      ...(options.metricVersion === 11 ? ['telemetry_worker_diagnostic_settings'] : [])]) result[table] = (await pool.query(`SELECT * FROM ${s}.${table} ORDER BY 1,2`)).rows;
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
    await cleanup(() => pool.end()); if (errors.length) throw new AggregateError(errors,'Worker diagnostic test cleanup failed');
  }
}
test('v11 worker buckets coalesce across instances, remain distinct from v10 observers and use the existing alert lane', { skip,timeout: 90000 }, async () => {
  await fixture(async ({ make,pool,s,ack }) => {
    const a = await make(), b = await make(), delivery = await make({ eventKind: 'alert' }), event = packet();
    assert.deepEqual(await Promise.all([a.appendWorkerDiagnosticObservation(event),b.appendWorkerDiagnosticObservation(event)]),
      [{ event_ref: event.event_ref,persisted: true },{ event_ref: event.event_ref,persisted: true }]);
    await a.appendDiagnosticObservation(createManagedDiagnosticObservation({ tenant_hash: tenantHash,observer_hash: sha256Ref('worker'),
      boundary: 'backlog_source_read',observed_ms: event.bucket_start_ms },diagnosticSettings));
    assert.equal((await a.readMetrics({ tenant_hash: tenantHash })).retained_sources,2);
    assert.equal(await delivery.claim({ claimToken: token(1) }),null);
    await b.appendWorkerDiagnosticObservation(packet(event.bucket_start_ms-1000));
    const custody = (await pool.query(`SELECT payload FROM ${s}.telemetry_metric_sources WHERE event_ref=$1`,[event.event_ref])).rows[0].payload;
    assert.deepEqual(custody.worker_diagnostic_event,event); assert.equal(custody.legacy_uncounted,false);
    const claim = await delivery.claim({ claimToken: token(1) }); assert.equal(claim.event.source_kind,'worker_diagnostic');
    assert.equal(claim.event.evidence_class,'host_worker_self_attested'); assert.equal(claim.event.coverage,'ingested_unconfirmed_buckets_only');
    assert.equal(claim.event.production_qualified,false); assert.equal(claim.event.count,2);
    assert.equal(await a.claim({ claimToken: token(5) }),null);
    await assert.rejects(delivery.acknowledge({ event_ref: claim.event.event_ref,generation: claim.generation,claimToken: token(2),
      acknowledgement: { event_ref: claim.event.event_ref,delivered: true } }),{ code: 'TELEMETRY_STALE_CLAIM' });
    await ack(delivery,claim,1); const restarted = await make(); await restarted.appendWorkerDiagnosticObservation(event);
    const metrics = await restarted.readMetrics({ tenant_hash: tenantHash });
    assert.equal(metrics.windows.find((w) => w.rule_id === 'worker_provider_call_unconfirmed').count,2);
    assert.equal((await delivery.stats()).acked,1);
  });
});
test('v11 worker persistence rolls back every edge and replay after unknown COMMIT or age expiry never recounts', { skip,timeout: 90000 }, async () => {
  await fixture(async ({ make,pool,s,snapshot }) => {
    let fault = null,lost = false;
    const wrapped = { async connect() { const c = await pool.connect(); return { release: () => c.release(),async query(sql,params) {
      if (fault && sql.startsWith(fault)) { fault = null; throw null; }
      const result = await c.query(sql,params); if (lost && sql === 'COMMIT') { lost = false; throw new Error('unknown commit'); } return result;
    } }; } };
    const a = await make({ pool: wrapped }), b = await make(), event = packet(); await a.appendWorkerDiagnosticObservation(event);
    const second = packet(event.bucket_start_ms-1000);
    for (const point of ['INSERT INTO '+s+'.telemetry_metric_alerts','UPDATE '+s+'.telemetry_metric_windows',
      'INSERT INTO '+s+'.telemetry_metric_sources','UPDATE '+s+'.telemetry_metric_totals','COMMIT']) {
      const before = await snapshot(); fault = point;
      await assert.rejects(a.appendWorkerDiagnosticObservation(second),{ code: 'TELEMETRY_UNAVAILABLE' }); assert.deepEqual(await snapshot(),before);
    }
    lost = true; await assert.rejects(a.appendWorkerDiagnosticObservation(second),{ code: 'TELEMETRY_UNAVAILABLE' });
    const committed = await snapshot(); await b.appendWorkerDiagnosticObservation(second); assert.deepEqual(await snapshot(),committed);
    let now = Date.now()+120000;
    const timed = { async connect() { const c = await pool.connect(); return { release: () => c.release(),async query(sql,params) {
      const result = await c.query(sql,params);
      return sql === 'SELECT floor(extract(epoch FROM clock_timestamp()) * 1000)::bigint AS now_ms' ? { ...result,rows: [{ now_ms: String(now) }] } : result;
    } }; } };
    const aged = await make({ pool: timed });
    await aged.appendWorkerDiagnosticObservation(second); assert.deepEqual(await snapshot(),committed);
    await assert.rejects(aged.appendWorkerDiagnosticObservation(packet(event.bucket_start_ms-2000)),{ code: 'TELEMETRY_UNAVAILABLE' });
    now -= 1; await assert.rejects(aged.appendWorkerDiagnosticObservation(second),{ code: 'TELEMETRY_UNAVAILABLE' });
    assert.deepEqual(await snapshot(),committed);
  });
});
test('v11 worker DB clock-lock cancellation never commits a late diagnostic after its deadline', { skip,timeout: 90000 }, async () => {
  await fixture(async ({ make,pool,s,snapshot }) => {
    const store = await make(), locker = await pool.connect(), before = await snapshot(), controller = new AbortController();
    try {
      await locker.query('BEGIN'); await locker.query(`SELECT last_seen_ms FROM ${s}.telemetry_clock WHERE singleton=true FOR UPDATE`);
      const pending = store.appendWorkerDiagnosticObservation(packet(),{ signal: controller.signal });
      await delay(30); controller.abort(); await locker.query('COMMIT');
      await assert.rejects(pending,{ code: 'REQUEST_TIMEOUT' }); assert.deepEqual(await snapshot(),before);
    } finally { await locker.query('ROLLBACK').catch(() => {}); locker.release(); }
  });
});
test('v11 worker metrics share all six global/per-tenant caps with policy and observer sources', { skip,timeout: 90000 }, async () => {
  for (const cap of ['maxSources','maxSourcesPerTenant','maxWindows','maxWindowsPerTenant','maxAlerts','maxAlertsPerTenant']) {
    const settings = { ...workerDiagnosticSettings,rules: [{ ...workerDiagnosticSettings.rules[0],threshold: 1 }] };
    await fixture(async ({ make,snapshot }) => {
      const store = await make(); await store.append(createManagedTelemetryEvent({ event: 'rate_denied',route_class: 'admission',status: 429,
        outcome: 'rate_limited',duration_ms: 0,tenant_hash: tenantHash,key_hash: sha256Ref('key') }));
      const before = await snapshot(); await assert.rejects(store.appendWorkerDiagnosticObservation(packet(Date.now(),{},settings)),{ code: 'TELEMETRY_CAPACITY' });
      assert.deepEqual(await snapshot(),before);
    },{ workerDiagnosticSettings: settings,metricSettings: { ...metricSettings,[cap]: 1,...(!cap.endsWith('PerTenant') ? { [cap+'PerTenant']: 1 } : {}) } });
  }
});
test('v11 worker stale/future admission, cancelled work, settings and catalog drift fail closed', { skip,timeout: 90000 }, async () => {
  await fixture(async ({ make,pool,s,options,snapshot }) => {
    const store = await make(), before = await snapshot();
    for (const event of [packet(0),packet(Date.now()+100000)]) {
      await assert.rejects(store.appendWorkerDiagnosticObservation(event),{ code: 'TELEMETRY_UNAVAILABLE' }); assert.deepEqual(await snapshot(),before);
    }
    const abort = new AbortController(); abort.abort(); await assert.rejects(store.appendWorkerDiagnosticObservation(packet(),{ signal: abort.signal }));
    assert.deepEqual(await snapshot(),before);
    await assert.rejects(make({ workerDiagnosticSettings: { ...workerDiagnosticSettings,max_age_ms: 61000 } }),{ code: 'TELEMETRY_UNAVAILABLE' });
    await pool.query(`ALTER TABLE ${s}.telemetry_worker_diagnostic_settings ADD COLUMN drift text`);
    const drifted = await snapshot(); await assert.rejects(store.stats(),{ code: 'TELEMETRY_UNAVAILABLE' });
    await assert.rejects(migratePostgresManagedTelemetry(options),{ code: 'TELEMETRY_MIGRATION_FAILED' }); assert.deepEqual(await snapshot(),drifted);
  });
});
test('v11 worker exact replay refuses packet, window and alert custody drift', { skip,timeout: 90000 }, async () => {
  for (const kind of ['source','window','alert']) await fixture(async ({ make,pool,s }) => {
    const store = await make(), event = packet(); await store.appendWorkerDiagnosticObservation(event);
    await store.appendWorkerDiagnosticObservation(packet(event.bucket_start_ms-1000));
    if (kind === 'source') await pool.query(`UPDATE ${s}.telemetry_metric_sources SET payload=jsonb_set(payload,'{worker_diagnostic_event,boundary}','"recovery_lookup"') WHERE event_ref=$1`,[event.event_ref]);
    if (kind === 'window') await pool.query(`UPDATE ${s}.telemetry_metric_windows SET payload=jsonb_set(payload,'{rules_hash}',$1::jsonb)`,[JSON.stringify(sha256Ref('bad'))]);
    if (kind === 'alert') await pool.query(`UPDATE ${s}.telemetry_metric_alerts SET payload=jsonb_set(payload,'{evidence_class}','"provider_verified"')`);
    await assert.rejects(store.appendWorkerDiagnosticObservation(event));
  });
});
test('v11 additive owner upgrade preserves v10 observer custody and rejects stale runtimes and immutable setting drift', { skip,timeout: 90000 }, async () => {
  await fixture(async ({ make,pool,s,options,snapshot }) => {
    const old = await make(), observer = createManagedDiagnosticObservation({ tenant_hash: tenantHash,observer_hash: sha256Ref('observer'),
      boundary: 'backlog_source_read',observed_ms: Date.now() },diagnosticSettings);
    await old.appendDiagnosticObservation(observer); const before = await snapshot();
    const upgraded = { ...options,metricVersion: 11,workerDiagnosticSettings };
    await migratePostgresManagedTelemetry(upgraded);
    const after = await snapshot(); for (const table of Object.keys(before).filter((name) => name !== 'telemetry_schema_migrations')) assert.deepEqual(after[table],before[table]);
    assert.deepEqual(after.telemetry_schema_migrations.slice(0,10),before.telemetry_schema_migrations);
    await assert.rejects(old.stats(),{ code: 'TELEMETRY_UNAVAILABLE' });
    const modern = await make({ metricVersion: 11,workerDiagnosticSettings }); await modern.appendDiagnosticObservation(observer);
    assert.equal((await modern.readMetrics({ tenant_hash: tenantHash })).retained_sources,1);
    await modern.appendWorkerDiagnosticObservation(packet()); assert.equal((await modern.readMetrics({ tenant_hash: tenantHash })).retained_sources,2);
    await pool.query(`UPDATE ${s}.telemetry_worker_diagnostic_settings SET settings_hash=$1`,[sha256Ref('drift')]);
    await assert.rejects(modern.stats(),{ code: 'TELEMETRY_UNAVAILABLE' });
  },{ metricVersion: 10,workerDiagnosticSettings: undefined });
});
test('v11 pruned ACKed delivery retains worker bucket custody and never synthesizes a clear or second threshold', { skip,timeout: 90000 }, async () => {
  await fixture(async ({ make,pool,s,options,ack }) => {
    const store = await make(), delivery = await make({ eventKind: 'alert' }), event = packet();
    await store.appendWorkerDiagnosticObservation(event); await store.appendWorkerDiagnosticObservation(packet(event.bucket_start_ms-1000));
    await ack(delivery,await delivery.claim({ claimToken: token(1) }),1); await delay(1050);
    const owner = (await pool.query('SELECT current_user AS name')).rows[0].name;
    assert.equal((await prunePostgresManagedTelemetry({ ...options,expectedOwner: owner,eventKind: 'alert' })).removed,1);
    assert.equal((await pool.query(`SELECT count(*)::integer AS n FROM ${s}.telemetry_metric_alerts`)).rows[0].n,0);
    await store.appendWorkerDiagnosticObservation(event); assert.equal((await store.readMetrics({ tenant_hash: tenantHash })).windows[0].count,2);
    assert.equal(await delivery.claim({ claimToken: token(2) }),null);
  });
});
test('v11 actual worker producer persists a rejected local provider call and existing drainer verifies sink ACK without granting cleanup proof', { skip,timeout: 90000 }, async () => {
  const settings = { ...workerDiagnosticSettings,rules: [{ ...workerDiagnosticSettings.rules[0],threshold: 1 }] };
  await fixture(async ({ make,pool,s }) => {
    const store = await make(), delivery = await make({ eventKind: 'alert' });
    const f = await workerDiagnosticFixture({ setupProvider(provider) { provider.createSavepoint = () => { throw null; }; } });
    const worker = createManagedRiskForkWorker({ ...f.options,workerDiagnosticSettings: settings,workerDiagnosticStore: store,workerDiagnosticTimeoutMs: 5000 });
    let bad,good;
    try {
      await assert.rejects(worker.execute(f.admitted.invocation_ref)); assert.equal((await worker.flushDiagnostics({ timeoutMs: 5000 })).settled,true);
      assert.equal(worker.status().diagnostics.recorded,2); assert.equal((await store.readMetrics({ tenant_hash: tenantHash })).retained_sources,2);
      assert.equal(worker.status().diagnostics.failure_counts.broker_contract,1,'primitive propagation is not independently distinguishable from a broker rewrite');
      assert.equal((await pool.query(`SELECT count(*)::integer AS n FROM ${s}.telemetry_backlog_state`)).rows[0].n,0);
      // Keep the deliberately small sink deadline separate from real PG catalog
      // attestation waits under the full concurrent suite. Timeout tests use
      // deterministic callbacks elsewhere; this case verifies INVALID_ACK retry.
      bad = createManagedTelemetryDrainer({ store: delivery,eventKind: 'alert',deliver: async () => ({ event_ref: 'wrong',delivered: true }),deliveryTimeoutMs: 50,storeTimeoutMs: 5000 });
      const rejected = await bad.runOnce(); assert.equal(rejected.failed,1); assert.equal(rejected.store_timed_out,0);
      assert.equal((await delivery.stats()).acked,0);
      const retained = (await pool.query(`SELECT state,last_error_code FROM ${s}.telemetry_metric_alerts`)).rows;
      assert.deepEqual(retained,[{ state: 'pending',last_error_code: 'INVALID_ACK' }]);
      await bad.close(); await delay(limits.retryMs+50);
      good = createManagedTelemetryDrainer({ store: delivery,eventKind: 'alert',deliver: async (event) => ({ event_ref: event.event_ref,delivered: true }),deliveryTimeoutMs: 50,storeTimeoutMs: 5000 });
      const accepted = await good.runOnce(); assert.equal(accepted.delivered,1); assert.equal(accepted.failed,0);
      assert.equal(accepted.store_timed_out,0); assert.equal((await delivery.stats()).acked,1);
      assert.equal((await f.controlPlane.getInvocation(f.principal,f.admitted.invocation_ref)).savepoint_ref,null);
    } finally { await bad?.close(); await good?.close(); worker.close(); f.worker.close(); }
  },{ workerDiagnosticSettings: settings });
});
