import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import pg from 'pg';
import { sha256Ref } from '../../src/canonical.mjs';
import { createManagedBacklogSnapshot, MANAGED_BACKLOG_COUNT_FIELDS } from '../src/backlog-snapshot.mjs';
import { createManagedBacklogObserver } from '../src/backlog-observer.mjs';
import { lifecycleTenantHash } from '../src/lifecycle-event.mjs';
import { migratePostgresManagedTelemetry } from '../src/postgres-telemetry-migrator.mjs';
import { createPostgresManagedTelemetryStore } from '../src/postgres-telemetry-store.mjs';
import { prunePostgresManagedTelemetry } from '../src/postgres-telemetry-maintenance.mjs';
import { createManagedTelemetryDrainer } from '../src/telemetry-drainer.mjs';
import { backlogAlertStateHash, backlogAlertTotalsHash, createManagedBacklogAlert } from '../src/backlog-alert.mjs';
import { createFixture } from './helpers.mjs';

const connectionString = process.env.RISK_FORK_MANAGED_TEST_POSTGRES_URL;
if (!connectionString && process.env.RISK_FORK_MANAGED_REQUIRE_POSTGRES_TESTS === '1') throw new Error('Mandatory backlog alerts require PostgreSQL');
const skip = !connectionString;
if (connectionString) {
  const url = new URL(connectionString);
  if (!['127.0.0.1','localhost','[::1]'].includes(url.hostname) || url.pathname !== '/risk_fork_managed_test'
    || process.env.RISK_FORK_MANAGED_TEST_CONFIRM_DISPOSABLE !== 'YES_DELETE_DATA') throw new Error('Backlog alerts require explicit disposable loopback DB');
}
const limits = { maxEvents: 100,maxEventsPerTenant: 100,leaseMs: 30000,retryMs: 100,retentionMs: 1000 };
const metricSettings = { maxSources: 100,maxSourcesPerTenant: 100,maxWindows: 100,maxWindowsPerTenant: 100,maxAlerts: 100,maxAlertsPerTenant: 100,
  rules: [{ rule_id: 'rate_denied',threshold: 1,window_ms: 60000 }] };
const backlogAlertSettings = { maxAlerts: 100,maxAlertsPerTenant: 20,rules: [{ rule_id: 'cleanup_pending_count',threshold: 2 }] };
const tenantHash = lifecycleTenantHash('tenant_alpha'), token = (n) => `claim_${String(n).padStart(5,'0')}_${'x'.repeat(48)}`;
const packet = (ms = 0, count = 2, tenant = 'tenant_alpha', expected_state = null, recovery = 0) => ({ tenant_id: tenant,
  observer_hash: sha256Ref('observer'),expected_state,snapshot: createManagedBacklogSnapshot({ tenant_id: tenant,
    snapshot_at: new Date(Date.parse('2026-10-06T00:00:00.000Z')+ms).toISOString(),
    ...Object.fromEntries(MANAGED_BACKLOG_COUNT_FIELDS.map((key) => [key,key === 'cleanup_pending_count' ? count : key === 'recovery_required_count' ? recovery : 0])) }) });
async function fixture(run, overrides = {}) {
  const schemaName = `backlog_alerts_${randomUUID().replaceAll('-','')}`, s = `"${schemaName}"`, pool = new pg.Pool({ connectionString,max: 8 });
  const stores = [], options = { pool,schemaName,requireTls: false,disposableDb: true,limits,lifecycle: true,metrics: true,metricVersion: 9,
    metricSettings,backlogSettings: { maxTenants: 100 },backlogAlertSettings,...overrides };
  const make = async (more = {}) => { const store = await createPostgresManagedTelemetryStore({ ...options,...more }); stores.push(store); return store; };
  const snapshot = async () => {
    const state = {};
    for (const table of ['telemetry_backlog_settings','telemetry_backlog_state','telemetry_backlog_totals','telemetry_backlog_alert_settings',
      'telemetry_backlog_alert_state','telemetry_backlog_alerts','telemetry_backlog_alert_totals']) state[table] = (await pool.query(`SELECT * FROM ${s}.${table} ORDER BY 1`)).rows;
    return state;
  };
  const ack = (store,claim,n) => store.acknowledge({ event_ref: claim.event.event_ref,generation: claim.generation,claimToken: token(n),
    acknowledgement: { event_ref: claim.event.event_ref,delivered: true } });
  try { await migratePostgresManagedTelemetry(options); await run({ pool,s,options,make,snapshot,ack }); }
  finally {
    const errors = [], cleanup = async (fn) => { try { await fn(); } catch (error) { errors.push(error); } };
    for (const store of stores) await cleanup(() => store.close());
    await cleanup(() => pool.query(`DROP SCHEMA IF EXISTS ${s} CASCADE`));
    await cleanup(async () => assert.equal((await pool.query('SELECT 1 FROM pg_namespace WHERE nspname=$1',[schemaName])).rowCount,0));
    await cleanup(() => pool.end()); if (errors.length) throw new AggregateError(errors,'Backlog alert cleanup failed');
  }
}
test('v9 atomically persists named open/clear/reopen alerts and delivers in rule order after restart', { skip,timeout: 90000 }, async () => {
  await fixture(async ({ make,pool,s,ack }) => {
    const a = await make(), b = await make({ eventKind: 'backlog_alert' }); let expected = null;
    for (const [ms,count] of [[0,2],[1,9],[2,0],[3,2]]) expected = (await a.appendBacklogSnapshot(packet(ms,count,'tenant_alpha',expected))).state;
    const state = await b.readBacklogAlertState({ tenant_hash: tenantHash });
    assert.equal(state.rules[0].episode,2); assert.equal(state.rules[0].transition,3);
    assert.equal((await pool.query(`SELECT count(*)::integer AS n FROM ${s}.telemetry_metric_sources`)).rows[0].n,0);
    const first = await b.claim({ claimToken: token(1) }); assert.equal(first.event.condition,'condition_observed');
    assert.equal(await a.claim({ claimToken: token(9) }),null,'policy store cannot claim backlog alerts');
    assert.equal(await b.claim({ claimToken: token(2) }),null,'clear cannot overtake claimed opening');
    await ack(b,first,1); assert.deepEqual(await ack(b,first,1),{ event_ref: first.event.event_ref,acknowledged: true });
    const second = await b.claim({ claimToken: token(2) }); assert.equal(second.event.condition,'threshold_cleared'); await ack(b,second,2);
    await assert.rejects(b.acknowledge({ event_ref: second.event.event_ref,generation: second.generation,claimToken: token(1),acknowledgement: { event_ref: second.event.event_ref,delivered: true } }),{ code: 'TELEMETRY_STALE_CLAIM' });
    const restarted = await make({ eventKind: 'backlog_alert' }), third = await restarted.claim({ claimToken: token(3) });
    assert.equal(third.event.condition,'threshold_crossed'); assert.equal(third.event.episode,2); await ack(restarted,third,3);
    assert.deepEqual(await restarted.stats(),{ pending: 0,claimed: 0,acked: 3,exhausted: 0,production_qualified: false });
  });
});
test('v9 identical/stale/competing observations do not emit duplicates or clear missing samples', { skip,timeout: 90000 }, async () => {
  await fixture(async ({ make,pool,s }) => {
    const a = await make(), b = await make(), request = packet();
    const committed = await a.appendBacklogSnapshot(request); const before = await a.readBacklogAlertState({ tenant_hash: tenantHash });
    assert.deepEqual(await b.appendBacklogSnapshot(request),committed);
    assert.deepEqual((await b.appendBacklogSnapshot({ ...request,expected_state: committed.state })).state,committed.state);
    await assert.rejects(a.appendBacklogSnapshot(packet(-1,0,'tenant_alpha',committed.state)),{ code: 'TELEMETRY_BACKLOG_STALE' });
    assert.deepEqual(await b.readBacklogAlertState({ tenant_hash: tenantHash }),before);
    const results = await Promise.allSettled([a.appendBacklogSnapshot(packet(1,0,'tenant_alpha',committed.state)),b.appendBacklogSnapshot(packet(2,1,'tenant_alpha',committed.state))]);
    assert.equal(results.filter((r) => r.status === 'fulfilled').length,1);
    assert.equal(results.find((r) => r.status === 'rejected').reason.code,'TELEMETRY_BACKLOG_CONFLICT');
    assert.equal((await pool.query(`SELECT count(*)::integer AS n FROM ${s}.telemetry_backlog_alerts`)).rows[0].n,2);
    assert.equal(await b.readBacklogAlertState({ tenant_hash: lifecycleTenantHash('missing_tenant') }),null);
  });
});
test('v9 rollback at every persistence edge and exact latest unknown-COMMIT replay retain custody', { skip,timeout: 90000 }, async () => {
  await fixture(async ({ make,pool,s }) => {
    let fault = null, lost = false;
    const wrapped = { async connect() { const client = await pool.connect(); return { release: () => client.release(),async query(sql,params) {
      if (fault && sql.startsWith(fault)) { fault = null; throw new Error('injected rollback'); }
      const result = await client.query(sql,params); if (lost && sql === 'COMMIT') { lost = false; throw new Error('lost commit response'); } return result;
    } }; } };
    const a = await make({ pool: wrapped }), b = await make(); const request = packet();
    for (const point of ['INSERT INTO '+s+'.telemetry_backlog_state','INSERT INTO '+s+'.telemetry_backlog_alerts',
      'INSERT INTO '+s+'.telemetry_backlog_alert_state','UPDATE '+s+'.telemetry_backlog_alert_totals']) {
      fault = point; await assert.rejects(a.appendBacklogSnapshot(request),{ code: 'TELEMETRY_UNAVAILABLE' });
      assert.equal(await b.readBacklogGauge({ tenant_hash: tenantHash }),null); assert.equal(await b.readBacklogAlertState({ tenant_hash: tenantHash }),null);
      assert.equal((await pool.query(`SELECT count(*)::integer AS n FROM ${s}.telemetry_backlog_alerts`)).rows[0].n,0);
    }
    lost = true; await assert.rejects(a.appendBacklogSnapshot(request),{ code: 'TELEMETRY_UNAVAILABLE' });
    const result = await b.appendBacklogSnapshot(request); assert.equal(result.state.generation,1);
    assert.equal((await b.readBacklogAlertState({ tenant_hash: tenantHash })).rules[0].transition,1);
    await a.appendBacklogSnapshot(packet(1,0,'tenant_alpha',result.state));
    await assert.rejects(a.appendBacklogSnapshot(request),{ code: 'TELEMETRY_BACKLOG_CONFLICT' });
  });
});
test('v9 global/per-tenant capacity includes recovery alerts and rolls back gauge freshness', { skip,timeout: 90000 }, async () => {
  for (const settings of [{ ...backlogAlertSettings,maxAlerts: 1,maxAlertsPerTenant: 1 },{ ...backlogAlertSettings,maxAlertsPerTenant: 1 }]) {
    await fixture(async ({ make,snapshot }) => {
      const a = await make(), first = await a.appendBacklogSnapshot(packet()), before = await snapshot();
      await assert.rejects(a.appendBacklogSnapshot(packet(1,0,'tenant_alpha',first.state)),{ code: 'TELEMETRY_CAPACITY' });
      assert.deepEqual(await snapshot(),before); assert.equal((await a.readBacklogAlertState({ tenant_hash: tenantHash })).rules[0].active,true);
    },{ backlogAlertSettings: settings });
  }
});
test('v9 retry/exhaustion blocks only its rule; named rules and tenants remain isolated', { skip,timeout: 90000 }, async () => {
  await fixture(async ({ make,pool,s }) => {
    const a = await make(), b = await make({ eventKind: 'backlog_alert' });
    const first = await a.appendBacklogSnapshot(packet(0,2,'tenant_alpha',null,1));
    await a.appendBacklogSnapshot(packet(1,0,'tenant_alpha',first.state,1));
    await a.appendBacklogSnapshot(packet(0,2,'tenant_other'));
    const opened = await b.claim({ claimToken: token(1) }); assert.equal(opened.event.rule_id,'cleanup_pending_count');
    await b.retry({ event_ref: opened.event.event_ref,generation: opened.generation,claimToken: token(1),errorCode: 'SINK_UNAVAILABLE' });
    const pending = (await pool.query(`SELECT * FROM ${s}.telemetry_backlog_alerts WHERE event_ref=$1`,[opened.event.event_ref])).rows[0];
    assert.equal(pending.state,'pending'); assert.equal(pending.last_error_code,'SINK_UNAVAILABLE'); assert.equal(pending.claim_hash,null);
    await pool.query(`UPDATE ${s}.telemetry_backlog_alerts SET attempts=1000000 WHERE event_ref=$1`,[opened.event.event_ref]);
    const others = [await b.claim({ claimToken: token(2) }),await b.claim({ claimToken: token(3) })];
    assert.equal(others.some((c) => c.event.rule_id === 'recovery_required_count'),true);
    assert.equal(others.some((c) => c.event.tenant_hash === lifecycleTenantHash('tenant_other')),true);
    assert.equal(await b.claim({ claimToken: token(4) }),null); assert.equal((await b.stats()).exhausted,1);
  },{ backlogAlertSettings: { ...backlogAlertSettings,rules: [...backlogAlertSettings.rules,{ rule_id: 'recovery_required_count',threshold: 1 }] } });
});
test('v9 contiguous ACK pruning retains replay chain and rejects generation rollback after compaction', { skip,timeout: 90000 }, async () => {
  await fixture(async ({ make,pool,s,options,ack }) => {
    const a = await make(), b = await make({ eventKind: 'backlog_alert' }), firstRequest = packet(), first = await a.appendBacklogSnapshot(firstRequest);
    const closeRequest = packet(1,0,'tenant_alpha',first.state), closed = await a.appendBacklogSnapshot(closeRequest);
    const owner = (await pool.query('SELECT current_user AS name')).rows[0].name;
    const prune = () => prunePostgresManagedTelemetry({ ...options,eventKind: 'backlog_alert',expectedOwner: owner,maxDelete: 1 });
    assert.equal((await prune()).removed,0,'pending prefixes cannot disappear');
    const one = await b.claim({ claimToken: token(1) }); await ack(b,one,1);
    assert.equal((await prune()).removed,0,'fresh ACK is not expired');
    await delay(1100); assert.equal((await prune()).removed,1);
    const state = await a.readBacklogAlertState({ tenant_hash: tenantHash });
    assert.equal(state.rules[0].pruned_through,1); assert.equal(state.rules[0].pruned_generation,1); assert.match(state.rules[0].ack_checkpoint_hash,/^sha256:/);
    assert.deepEqual((await a.appendBacklogSnapshot(closeRequest)).state,closed.state,'latest replay validates retained tail after prune');
    const two = await b.claim({ claimToken: token(2) }); await ack(b,two,2); await delay(1100); assert.equal((await prune()).removed,1);
    assert.equal((await a.readBacklogAlertState({ tenant_hash: tenantHash })).rules[0].pruned_through,2);
    assert.deepEqual((await a.appendBacklogSnapshot(closeRequest)).state,closed.state,'fully compacted exact replay remains valid');
    const reopened = await a.appendBacklogSnapshot(packet(2,2,'tenant_alpha',closed.state));
    const row = (await pool.query(`SELECT * FROM ${s}.telemetry_backlog_alerts`)).rows[0], { event_ref,schema,event,coverage,evidence_class,production_qualified,...fields } = row.payload;
    const forged = createManagedBacklogAlert({ ...fields,gauge_generation: 1 });
    await pool.query(`UPDATE ${s}.telemetry_backlog_alerts SET event_ref=$2,event_hash=$3,payload=$4 WHERE event_ref=$1`,[row.event_ref,forged.event_ref,sha256Ref(forged),forged]);
    // Even coherent owner-rewritten hashes cannot erase generation ordering.
    const retained = (await pool.query(`SELECT payload FROM ${s}.telemetry_backlog_alert_state`)).rows[0].payload;
    retained.rules[0].emitted_hash = sha256Ref(forged);
    await pool.query(`UPDATE ${s}.telemetry_backlog_alert_state SET payload=$1,state_hash=$2`,[retained,backlogAlertStateHash(retained)]);
    await assert.rejects(a.appendBacklogSnapshot(packet(2,2,'tenant_alpha',closed.state)),{ code: 'TELEMETRY_BACKLOG_ALERT_DRIFT' });
    assert.equal(reopened.state.generation,3);
  });
});
test('v9 rejects missing/disconnected state or alerts before claim, ACK, retry, and exact replay', { skip,timeout: 90000 }, async () => {
  for (const method of ['claim','ack','retry','replay']) await fixture(async ({ make,pool,s }) => {
    const a = await make(), b = await make({ eventKind: 'backlog_alert' }), request = packet(); await a.appendBacklogSnapshot(request);
    const claim = method === 'ack' || method === 'retry' ? await b.claim({ claimToken: token(1) }) : null;
    const state = (await pool.query(`SELECT payload FROM ${s}.telemetry_backlog_alert_state`)).rows[0].payload;
    state.gauge_hash = sha256Ref('disconnected gauge');
    await pool.query(`UPDATE ${s}.telemetry_backlog_alert_state SET payload=$1,state_hash=$2`,[state,backlogAlertStateHash(state)]);
    const action = method === 'claim' ? () => b.claim({ claimToken: token(2) }) : method === 'replay' ? () => a.appendBacklogSnapshot(request)
      : method === 'ack' ? () => b.acknowledge({ event_ref: claim.event.event_ref,generation: claim.generation,claimToken: token(1),acknowledgement: { event_ref: claim.event.event_ref,delivered: true } })
        : () => b.retry({ event_ref: claim.event.event_ref,generation: claim.generation,claimToken: token(1),errorCode: 'SINK_UNAVAILABLE' });
    await assert.rejects(action(),{ code: 'TELEMETRY_BACKLOG_ALERT_DRIFT' });
  });
});
test('v8 to v9 baseline is bounded, settings-preserving and never backfills old high observations', { skip,timeout: 90000 }, async () => {
  await fixture(async ({ make,pool,s,options }) => {
    const old = await make(), gauges = [];
    for (let i = 0; i < 65; i += 1) gauges.push((await old.appendBacklogSnapshot(packet(0,2,`tenant_${i}`))).state);
    const settings = (await pool.query(`SELECT * FROM ${s}.telemetry_metric_settings`)).rows;
    await migratePostgresManagedTelemetry({ ...options,metricVersion: 9,backlogAlertSettings });
    assert.deepEqual((await pool.query(`SELECT * FROM ${s}.telemetry_metric_settings`)).rows,settings);
    const current = await make({ metricVersion: 9,backlogAlertSettings });
    await assert.rejects(old.readBacklogGauge({ tenant_hash: lifecycleTenantHash('tenant_0') }),{ code: 'TELEMETRY_UNAVAILABLE' });
    assert.equal((await pool.query(`SELECT count(*)::integer AS n FROM ${s}.telemetry_backlog_alerts`)).rows[0].n,0);
    for (let i = 0; i < 65; i += 1) assert.deepEqual(await current.readBacklogGauge({ tenant_hash: lifecycleTenantHash(`tenant_${i}`) }),gauges[i]);
    assert.equal((await current.readBacklogAlertState({ tenant_hash: lifecycleTenantHash('tenant_0') })).rules[0].active,null);
    await current.appendBacklogSnapshot(packet(1,2,'tenant_0',gauges[0]));
    assert.equal((await pool.query(`SELECT payload FROM ${s}.telemetry_backlog_alerts`)).rows[0].payload.condition,'condition_observed');
    await assert.rejects(migratePostgresManagedTelemetry({ ...options,metricVersion: 9,backlogAlertSettings: { ...backlogAlertSettings,maxAlerts: 99 } }),{ code: 'TELEMETRY_MIGRATION_FAILED' });
  },{ metricVersion: 8,backlogAlertSettings: undefined });
});
test('v9 real observer source expiry preserves gauge and condition; shared sink failure retains replay', { skip,timeout: 90000 }, async () => {
  await fixture(async ({ make }) => {
    const f = await createFixture(), store = await make();
    const observer = createManagedBacklogObserver({ controlPlane: f.controlPlane,store,auditPrincipals: [f.principal],observerId: 'v9-source' });
    try {
      assert.equal((await observer.runOnce()).sampled,1); const before = await store.readBacklogAlertState({ tenant_hash: tenantHash });
      f.setNow('2026-09-06T00:00:00.000Z'); assert.equal((await observer.runOnce()).failed,1);
      assert.deepEqual(await store.readBacklogAlertState({ tenant_hash: tenantHash }),before);
    } finally { await observer.close(); }
    const gauge = await store.readBacklogGauge({ tenant_hash: tenantHash });
    await store.appendBacklogSnapshot(packet(0,2,'tenant_alpha',gauge));
    const delivery = await make({ eventKind: 'backlog_alert' }), seen = []; let failing = true;
    const drainer = createManagedTelemetryDrainer({ eventKind: 'backlog_alert',store: delivery,storeTimeoutMs: 5000,deliver: async (event) => {
      seen.push(event.event_ref); if (failing) throw new Error('offline'); return { event_ref: event.event_ref,delivered: true };
    } });
    try { assert.equal((await drainer.runOnce()).failed,1); failing = false; await delay(150); assert.equal((await drainer.runOnce()).delivered,1); assert.equal(seen[0],seen[1]); }
    finally { await drainer.close(); }
  });
});
