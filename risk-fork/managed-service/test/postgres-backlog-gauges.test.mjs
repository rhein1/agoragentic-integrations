import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { sha256Ref } from '../../src/canonical.mjs';
import { createManagedBacklogSnapshot, MANAGED_BACKLOG_COUNT_FIELDS } from '../src/backlog-snapshot.mjs';
import { createManagedBacklogObserver } from '../src/backlog-observer.mjs';
import { backlogGaugeHash } from '../src/backlog-gauge.mjs';
import { lifecycleTenantHash } from '../src/lifecycle-event.mjs';
import { migratePostgresManagedTelemetry } from '../src/postgres-telemetry-migrator.mjs';
import { createPostgresManagedTelemetryStore } from '../src/postgres-telemetry-store.mjs';
import { prunePostgresManagedTelemetry } from '../src/postgres-telemetry-maintenance.mjs';
import { createManagedAuthenticator, hashManagedApiKey } from '../src/auth.mjs';
import { createManagedServiceConfig } from '../src/config.mjs';
import { createManagedRiskForkControlPlane } from '../src/control-plane.mjs';
import { createManagedProviderRegistry } from '../src/provider-registry.mjs';
import { migrateManagedServicePostgres } from '../src/postgres-migrator.mjs';
import { PostgresManagedServiceStore } from '../src/postgres-store.mjs';
import { createFixture, invocationRequest, TestProvider, TEST_TOKEN, WORKER_SCOPES } from './helpers.mjs';

const connectionString = process.env.RISK_FORK_MANAGED_TEST_POSTGRES_URL;
if (!connectionString && process.env.RISK_FORK_MANAGED_REQUIRE_POSTGRES_TESTS === '1') throw new Error('Mandatory backlog gauges require PostgreSQL');
const skip = !connectionString;
if (connectionString) {
  const url = new URL(connectionString);
  if (!['127.0.0.1','localhost','[::1]'].includes(url.hostname) || url.pathname !== '/risk_fork_managed_test'
    || process.env.RISK_FORK_MANAGED_TEST_CONFIRM_DISPOSABLE !== 'YES_DELETE_DATA') throw new Error('Backlog gauges require explicit disposable loopback DB');
}
const limits = { maxEvents: 100,maxEventsPerTenant: 100,leaseMs: 1000,retryMs: 100,retentionMs: 1000 };
const metricSettings = { maxSources: 100,maxSourcesPerTenant: 100,maxWindows: 100,maxWindowsPerTenant: 100,maxAlerts: 100,maxAlertsPerTenant: 100,
  rules: [{ rule_id: 'rate_denied',threshold: 1,window_ms: 60000 }] };
const tenantHash = lifecycleTenantHash('tenant_alpha');
const packet = (ms = 0, values = [1,2,3,4,5], tenant = 'tenant_alpha', expected_state = null) => ({ tenant_id: tenant,
  observer_hash: sha256Ref('observer'),expected_state,snapshot: createManagedBacklogSnapshot({ tenant_id: tenant,
    snapshot_at: new Date(Date.parse('2026-10-06T00:00:00.000Z')+ms).toISOString(),
    ...Object.fromEntries(MANAGED_BACKLOG_COUNT_FIELDS.map((key,i) => [key,values[i]])) }) });
async function fixture(run, overrides = {}) {
  const schemaName = `backlog_gauges_${randomUUID().replaceAll('-','')}`, s = `"${schemaName}"`, pool = new pg.Pool({ connectionString,max: 8 });
  const stores = []; const options = { pool,schemaName,requireTls: false,disposableDb: true,limits,lifecycle: true,metrics: true,metricVersion: 8,
    metricSettings,backlogSettings: { maxTenants: 2 },...overrides };
  const make = async (more = {}) => { const store = await createPostgresManagedTelemetryStore({ ...options,...more }); stores.push(store); return store; };
  const snapshot = async () => {
    const state = {};
    for (const table of ['telemetry_backlog_settings','telemetry_backlog_state','telemetry_backlog_totals','telemetry_metric_settings','telemetry_metric_sources',
      'telemetry_metric_windows','telemetry_metric_alerts','telemetry_metric_totals']) state[table] = (await pool.query(`SELECT * FROM ${s}.${table} ORDER BY 1`)).rows;
    return state;
  };
  try { await migratePostgresManagedTelemetry(options); await run({ pool,s,options,make,snapshot }); }
  finally {
    const errors = [], cleanup = async (fn) => { try { await fn(); } catch (error) { errors.push(error); } };
    for (const store of stores) await cleanup(() => store.close());
    await cleanup(() => pool.query(`DROP SCHEMA IF EXISTS ${s} CASCADE`));
    await cleanup(async () => assert.equal((await pool.query('SELECT 1 FROM pg_namespace WHERE nspname=$1',[schemaName])).rowCount,0));
    await cleanup(() => pool.end()); if (errors.length) throw new AggregateError(errors,'Backlog gauge cleanup failed');
  }
}
test('v8 latest gauges persist restart without summing polls or growing permanent sources/windows', { skip,timeout: 90000 }, async () => {
  await fixture(async ({ make,pool,s }) => {
    const a = await make(), b = await make(); let current = null;
    for (let i = 0; i < 20; i += 1) {
      const request = packet(i,[i,2,3,4,5],'tenant_alpha',current);
      current = (await a.appendBacklogSnapshot(request)).state;
      assert.deepEqual(await b.readBacklogGauge({ tenant_hash: tenantHash }),current);
      assert.equal(current.cleanup_pending_count,i); assert.equal(current.generation,i+1);
    }
    for (const table of ['telemetry_metric_sources','telemetry_metric_windows','telemetry_metric_alerts']) assert.equal((await pool.query(`SELECT count(*)::integer AS n FROM ${s}.${table}`)).rows[0].n,0);
    assert.equal((await pool.query(`SELECT count(*)::integer AS n FROM ${s}.telemetry_backlog_state`)).rows[0].n,1);
    assert.equal(JSON.stringify(current).includes('tenant_alpha'),false); assert.equal(current.production_qualified,false);
    assert.equal(await b.readBacklogGauge({ tenant_hash: lifecycleTenantHash('tenant_other') }),null,'absence is no sample, not zero');
  });
});
test('v8 competing observers fence stale CAS; rollback/equal-time conflicts preserve latest state', { skip,timeout: 90000 }, async () => {
  await fixture(async ({ make }) => {
    const a = await make(), b = await make(), requests = [packet(10),packet(20,[6,7,8,9,10])];
    const results = await Promise.allSettled([a.appendBacklogSnapshot(requests[0]),b.appendBacklogSnapshot(requests[1])]);
    assert.equal(results.filter((r) => r.status === 'fulfilled').length,1);
    assert.equal(results.find((r) => r.status === 'rejected').reason.code,'TELEMETRY_BACKLOG_CONFLICT');
    let current = await a.readBacklogGauge({ tenant_hash: tenantHash });
    for (const ms of [-1,Date.parse(current.source_snapshot_at)-Date.parse('2026-10-06T00:00:00.000Z')]) {
      await assert.rejects(a.appendBacklogSnapshot(packet(ms,[99,0,0,0,0],'tenant_alpha',current)),{ code: 'TELEMETRY_BACKLOG_STALE' });
      assert.deepEqual(await b.readBacklogGauge({ tenant_hash: tenantHash }),current);
    }
    const same = { ...requests[results[0].status === 'fulfilled' ? 0 : 1],expected_state: current };
    assert.deepEqual((await a.appendBacklogSnapshot(same)).state,current,'identical snapshot never refreshes recorded time/generation');
    current = (await a.appendBacklogSnapshot(packet(30,[0,0,0,0,0],'tenant_alpha',current))).state;
    assert.equal(current.cleanup_pending_count,0,'only a successful new source view clears a gauge');
    await assert.rejects(b.appendBacklogSnapshot(requests[0]),{ code: 'TELEMETRY_BACKLOG_CONFLICT' });
  });
});
test('v8 unknown COMMIT replays exact latest packet only; state/totals append is atomic', { skip,timeout: 90000 }, async () => {
  await fixture(async ({ make,pool,s,options }) => {
    let lost = false, rollback = false;
    const wrapped = { async connect() { const client = await pool.connect(); return { release: () => client.release(),async query(sql,params) {
      if (rollback && sql.startsWith(`UPDATE ${s}.telemetry_backlog_totals`)) { rollback = false; throw new Error('injected before totals'); }
      const result = await client.query(sql,params); if (lost && sql === 'COMMIT') { lost = false; throw new Error('lost commit response'); } return result;
    } }; } };
    const a = await make({ pool: wrapped }), b = await make(); const request = packet();
    rollback = true; await assert.rejects(a.appendBacklogSnapshot(request),{ code: 'TELEMETRY_UNAVAILABLE' });
    assert.equal(await b.readBacklogGauge({ tenant_hash: tenantHash }),null);
    lost = true; await assert.rejects(a.appendBacklogSnapshot(request),{ code: 'TELEMETRY_UNAVAILABLE' });
    const result = await b.appendBacklogSnapshot(request); assert.equal(result.state.generation,1);
    assert.deepEqual(await a.appendBacklogSnapshot(request),result);
    const owner = (await pool.query('SELECT current_user AS name')).rows[0].name;
    assert.equal((await prunePostgresManagedTelemetry({ ...options,expectedOwner: owner })).removed,0);
    assert.deepEqual(await b.readBacklogGauge({ tenant_hash: tenantHash }),result.state,'delivery retention cannot delete latest gauge');
    await assert.rejects(migratePostgresManagedTelemetry({ ...options,backlogSettings: { maxTenants: 1 } }),{ code: 'TELEMETRY_MIGRATION_FAILED' });
    assert.deepEqual(await b.readBacklogGauge({ tenant_hash: tenantHash }),result.state);
  });
});
test('v8 tenant capacity bounds latest rows and rejects new tenants atomically', { skip,timeout: 90000 }, async () => {
  await fixture(async ({ make,snapshot }) => {
    const a = await make(); const first = (await a.appendBacklogSnapshot(packet())).state, before = await snapshot();
    await assert.rejects(a.appendBacklogSnapshot(packet(1,[0,0,0,0,0],'tenant_other')),{ code: 'TELEMETRY_CAPACITY' });
    assert.deepEqual(await snapshot(),before);
    assert.equal((await a.appendBacklogSnapshot(packet(1,[9,0,0,0,0],'tenant_alpha',first))).state.cleanup_pending_count,9);
  },{ backlogSettings: { maxTenants: 1 } });
});
test('v7 to v8 preserves event settings/custody and old runtime selection fails closed', { skip,timeout: 90000 }, async () => {
  await fixture(async ({ make,options,pool,s }) => {
    const before = (await pool.query(`SELECT * FROM ${s}.telemetry_metric_settings`)).rows;
    await migratePostgresManagedTelemetry({ ...options,metricVersion: 8,backlogSettings: { maxTenants: 2 } });
    assert.deepEqual((await pool.query(`SELECT * FROM ${s}.telemetry_metric_settings`)).rows,before);
    assert.deepEqual((await pool.query(`SELECT version FROM ${s}.telemetry_schema_migrations ORDER BY version`)).rows.map((row) => row.version),[1,2,3,4,5,6,7,8]);
    await assert.rejects(make(),{ code: 'TELEMETRY_UNAVAILABLE' });
    const current = await make({ metricVersion: 8,backlogSettings: { maxTenants: 2 } });
    assert.equal((await current.appendBacklogSnapshot(packet())).persisted,true);
    await assert.rejects(current.append(packet().snapshot));
  },{ metricVersion: 7,backlogSettings: undefined });
});
test('v8 detects missing tenant custody, touched state hash and catalog drift without repair', { skip,timeout: 90000 }, async () => {
  for (const behavior of ['delete','payload','catalog']) await fixture(async ({ make,pool,s }) => {
    const a = await make(); await a.appendBacklogSnapshot(packet());
    if (behavior === 'delete') await pool.query(`DELETE FROM ${s}.telemetry_backlog_state`);
    if (behavior === 'payload') await pool.query(`UPDATE ${s}.telemetry_backlog_state SET payload=jsonb_set(payload,'{cleanup_pending_count}','99')`);
    if (behavior === 'catalog') await pool.query(`ALTER TABLE ${s}.telemetry_backlog_state ADD COLUMN unreviewed text`);
    await assert.rejects(a.readBacklogGauge({ tenant_hash: tenantHash }),behavior === 'catalog' ? { code: 'TELEMETRY_UNAVAILABLE' } : { code: 'TELEMETRY_BACKLOG_DRIFT' });
  });
});
test('actual memory-source collector persists in PostgreSQL; source/auth failure retains prior gauge', { skip,timeout: 90000 }, async () => {
  await fixture(async ({ make }) => {
    const f = await createFixture(), store = await make();
    const observer = createManagedBacklogObserver({ controlPlane: f.controlPlane,store,auditPrincipals: [f.principal],observerId: 'memory-to-pg' });
    try {
      assert.equal((await observer.runOnce()).sampled,1);
      const before = await store.readBacklogGauge({ tenant_hash: tenantHash });
      f.setNow('2026-09-06T00:00:00.000Z');
      assert.equal((await observer.runOnce()).failed,1); assert.deepEqual(await store.readBacklogGauge({ tenant_hash: tenantHash }),before);
      assert.equal(observer.health().sampled,1);
    } finally { await observer.close(); }
  });
});
test('actual PostgreSQL control-plane source feeds latest gauge without provider calls or terminal cleanup claims', { skip,timeout: 90000 }, async () => {
  await fixture(async ({ make,pool }) => {
    const schemaName = `backlog_source_${randomUUID().replaceAll('-','')}`, s = `"${schemaName}"`; let sourceStore;
    try {
      await migrateManagedServicePostgres({ pool,schemaName,requireTls: false });
      await pool.query(`INSERT INTO ${s}.managed_tenants (tenant_id,status,daily_budget_micros,max_invocation_cost_micros,max_concurrent_invocations)
        VALUES ('tenant_alpha','active',1000000,500000,4)`);
      await pool.query(`INSERT INTO ${s}.managed_api_keys (key_hash,key_id,tenant_id,scopes,not_before,expires_at)
        VALUES ($1,'key_alpha','tenant_alpha',$2,clock_timestamp()-interval '1 minute',clock_timestamp()+interval '1 hour')`,[hashManagedApiKey(TEST_TOKEN),JSON.stringify(['audit:read','invocations:write',...WORKER_SCOPES])]);
      sourceStore = new PostgresManagedServiceStore({ pool,schemaName,requireTls: false });
      const auth = createManagedAuthenticator({ store: sourceStore });
      const registry = createManagedProviderRegistry([{ provider: new TestProvider(),enabled: true,adapter_digest: sha256Ref('source fixture'),
        qualification_class: 'local_test',qualification_receipt_hash: sha256Ref('fixture'),tenant_ids: ['tenant_alpha'],verify_resource_binding: async () => true,
        verify_cleanup_evidence: async () => true,verify_recovery_absence: async () => true }]);
      const control = createManagedRiskForkControlPlane({ store: sourceStore,config: createManagedServiceConfig({ enabled: true,environment: 'local_test' }),providerRegistry: registry,requirePrincipal: auth.requirePrincipal });
      const principal = await auth.authenticate(`Bearer ${TEST_TOKEN}`,'invocations:write');
      const ref = (await control.admitInvocation(principal,invocationRequest())).invocation.invocation_ref;
      const lease = await control.claimExecution(principal,{ invocation_ref: ref,lease_token: `lease_${randomUUID()}_${'x'.repeat(32)}`,worker_id: 'source',lease_ms: 30000 });
      await control.recordResources(principal,{ invocation_ref: ref,lease_token: lease.lease_token,savepoint_ref: 'synthetic_savepoint',fork_ref: 'synthetic_fork' });
      await control.recordExecutionOutcome(principal,{ invocation_ref: ref,lease_token: lease.lease_token,outcome: 'succeeded',actual_cost_micros: 0,execution_evidence_hash: sha256Ref('fixture'),result_hash: sha256Ref('result') });
      const store = await make(), observer = createManagedBacklogObserver({ controlPlane: control,store,auditPrincipals: [principal],observerId: 'pg-source' });
      try {
        assert.equal((await observer.runOnce()).sampled,1);
        const state = await store.readBacklogGauge({ tenant_hash: tenantHash });
        assert.equal(state.cleanup_pending_count,1); assert.equal(state.recovery_required_count,0);
        for (const hidden of [TEST_TOKEN,lease.lease_token,ref,'synthetic_fork','synthetic_savepoint']) assert.equal(JSON.stringify(state).includes(hidden),false);
        assert.equal(state.evidence_class,'control_plane_self_attested'); assert.equal(state.production_qualified,false);
        assert.equal(backlogGaugeHash(state).startsWith('sha256:'),true);
      } finally { await observer.close(); }
    } finally { await sourceStore?.close(); await pool.query(`DROP SCHEMA IF EXISTS ${s} CASCADE`); assert.equal((await pool.query('SELECT 1 FROM pg_namespace WHERE nspname=$1',[schemaName])).rowCount,0); }
  });
});
