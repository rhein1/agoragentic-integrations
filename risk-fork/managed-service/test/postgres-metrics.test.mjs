import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { rootCertificates } from 'node:tls';
import pg from 'pg';
import { createPostgresManagedTelemetryStore } from '../src/postgres-telemetry-store.mjs';
import { migratePostgresManagedTelemetry } from '../src/postgres-telemetry-migrator.mjs';
import { prunePostgresManagedTelemetry } from '../src/postgres-telemetry-maintenance.mjs';
import { createManagedTelemetryEvent } from '../src/telemetry-event.mjs';
import { createManagedTelemetryDrainer } from '../src/telemetry-drainer.mjs';
import { lifecycleTenantHash } from '../src/lifecycle-event.mjs';
import { metricRulesHash } from '../src/metric-event.mjs';
import { metricTotalsHash } from '../src/postgres-metric-state.mjs';
import { sha256Ref } from '../../src/canonical.mjs';
import { createFixture, invocationRequest } from './helpers.mjs';

const connectionString = process.env.RISK_FORK_MANAGED_TEST_POSTGRES_URL;
if (!connectionString && process.env.RISK_FORK_MANAGED_REQUIRE_POSTGRES_TESTS === '1') throw new Error('Mandatory metrics PG tests require a database');
const skip = !connectionString;
if (connectionString) {
  const url = new URL(connectionString);
  if (!['127.0.0.1','localhost','[::1]'].includes(url.hostname) || url.pathname !== '/risk_fork_managed_test'
    || process.env.RISK_FORK_MANAGED_TEST_CONFIRM_DISPOSABLE !== 'YES_DELETE_DATA') throw new Error('Metrics tests require explicit disposable loopback DB');
}
const qid = (value) => { assert.match(value,/^[a-z_][a-z0-9_]*$/); return `"${value}"`; };
const token = () => randomBytes(32).toString('base64url');
const limits = { maxEvents: 100,maxEventsPerTenant: 80,leaseMs: 1000,retryMs: 200,retentionMs: 1000 };
const settings = { maxSources: 100,maxSourcesPerTenant: 80,maxWindows: 40,maxWindowsPerTenant: 30,maxAlerts: 40,maxAlertsPerTenant: 30,
  rules: [{ rule_id: 'rate_denied',threshold: 2,window_ms: 1000 },{ rule_id: 'control_disabled',threshold: 1,window_ms: 1000 },
    { rule_id: 'lease_expiry_observed',threshold: 1,window_ms: 1000 }] };
const tenant = sha256Ref('metrics tenant'), otherTenant = sha256Ref('other metrics tenant');
const event = (tenant_hash = tenant, override = {}) => createManagedTelemetryEvent({ event: 'rate_denied',route_class: 'admission',
  status: 429,outcome: 'rate_limited',duration_ms: 1,tenant_hash,key_hash: sha256Ref('metrics key'),...override });
function wrapper(pool, intercept) { return { async connect() { const client = await pool.connect();
  return { release: () => client.release(),query: (sql,params) => intercept(client,sql,params) }; } }; }
// Transactions and persisted state are real PostgreSQL. Only the DB sample is
// deliberately controlled to exercise window/expiry boundaries without sleeps.
async function fixture(run,{ metricSettings = settings,upgrade = false,clockControl = true } = {}) {
  const schemaName = `metrics_${randomUUID().replaceAll('-','')}`, s = qid(schemaName);
  const pool = new pg.Pool({ connectionString,max: 6 }), stores = [];
  let now;
  const timed = wrapper(pool,async (client,sql,params) => {
    const result = await client.query(sql,params);
    return clockControl && sql === 'SELECT floor(extract(epoch FROM clock_timestamp()) * 1000)::bigint AS now_ms'
      ? { ...result,rows: [{ now_ms: String(now) }] } : result;
  });
  const base = { pool: timed,schemaName,limits,requireTls: false,disposableDb: true,lifecycle: true };
  const options = { ...base,metrics: true,metricSettings };
  const makeStore = async (eventKind = 'policy',extra = {}) => {
    const store = await createPostgresManagedTelemetryStore({ ...(upgrade ? base : options),eventKind,...extra }); stores.push(store); return store;
  };
  try {
    now = Number((await pool.query('SELECT floor(extract(epoch FROM clock_timestamp()) * 1000)::bigint AS now_ms')).rows[0].now_ms);
    if (clockControl) now = Math.ceil((now+10_000)/1000)*1000;
    await migratePostgresManagedTelemetry(upgrade ? base : options);
    const a = await makeStore(), b = await makeStore();
    const owner = (await pool.query('SELECT current_user AS name')).rows[0].name;
    const count = async (table) => { assert.match(table,/^telemetry_[a-z_]+$/); return (await pool.query(`SELECT count(*)::integer AS n FROM ${s}.${table}`)).rows[0].n; };
    const prune = async (eventKind) => prunePostgresManagedTelemetry({ ...options,eventKind,expectedOwner: owner });
    await run({ pool,s,base,options,a,b,makeStore,count,prune,now: () => now,advance: (ms) => { now += ms; } });
  } finally {
    const errors = [], cleanup = async (fn) => { try { await fn(); } catch (e) { errors.push(e); } };
    for (const store of stores) await cleanup(() => store.close());
    await cleanup(() => pool.query(`DROP SCHEMA IF EXISTS ${s} CASCADE`));
    await cleanup(async () => assert.equal((await pool.query('SELECT 1 FROM pg_namespace WHERE nspname=$1',[schemaName])).rowCount,0));
    await cleanup(() => pool.end());
    if (errors.length) throw new AggregateError(errors,'Metrics disposable cleanup failed');
  }
}
async function ack(store) {
  const claimToken = token(), c = await store.claim({ claimToken }); assert.ok(c);
  await store.acknowledge({ event_ref: c.event.event_ref,generation: c.generation,claimToken,
    acknowledgement: { event_ref: c.event.event_ref,delivered: true } }); return c.event;
}
async function lifecyclePacket(source) {
  const { invocation } = await source.controlPlane.admitInvocation(source.principal,invocationRequest({ estimated_cost_micros: 0 }));
  const ref = invocation.invocation_ref;
  return { ref,packet: { scope: { observer_hash: sha256Ref('metrics observer'),tenant_hash: lifecycleTenantHash('tenant_alpha') },
    tenant_id: 'tenant_alpha',expected_sweep: null,expected_checkpoint: null,
    page: await source.controlPlane.listAuditInvocations(source.principal,{ limit: 1 }),
    window: await source.controlPlane.readAuditWindow(source.principal,ref,{ limit: 64 }) } };
}

test('metric exact duplicates across instances count once; tenant/windows and intentional disable remain separate', { skip,timeout: 60_000 }, async () => {
  await fixture(async ({ a,b,makeStore,count,pool,s,advance }) => {
    const first = event(); await Promise.all(Array.from({ length: 8 },(_,i) => (i%2 ? a : b).append(first)));
    assert.equal((await a.readMetrics({ tenant_hash: tenant })).windows[0].count,1);
    assert.equal(await count('telemetry_metric_sources'),1); assert.equal(await count('telemetry_metric_alerts'),0);
    await b.append(event()); await a.append(event()); await b.append(event(otherTenant));
    assert.equal((await a.readMetrics({ tenant_hash: tenant })).windows[0].count,3);
    assert.equal((await a.readMetrics({ tenant_hash: otherTenant })).windows[0].count,1);
    assert.equal(await count('telemetry_metric_alerts'),1);
    advance(1000); await a.append(event()); await b.append(event());
    await a.append(event(tenant,{ event: 'control_denied',status: 503,outcome: 'disabled' }));
    assert.equal(await count('telemetry_metric_alerts'),3);
    const alerts = await makeStore('alert'), received = new Map();
    const drainer = createManagedTelemetryDrainer({ store: alerts,eventKind: 'alert',maxBatch: 64,deliver: async (packet) => {
      received.set(packet.event_ref,packet); return { event_ref: packet.event_ref,delivered: true };
    } });
    try { assert.equal((await drainer.runOnce()).delivered,3); } finally { await drainer.close(); }
    assert.equal(received.size,3); assert.equal((await alerts.stats()).acked,3);
    for (const packet of received.values()) { assert.equal(packet.production_qualified,false); assert.equal(packet.coverage,'ingested_observations_only'); }
    const kept = JSON.stringify((await pool.query(`SELECT payload FROM ${s}.telemetry_metric_sources`)).rows);
    for (const secret of ['metrics tenant','metrics key','tenant_alpha','lease_token','provider_recovery']) assert.equal(kept.includes(secret),false);
  });
});

test('source/count/alert/custody writes roll back together when any later projection write fails', { skip,timeout: 60_000 }, async () => {
  for (const table of ['telemetry_metric_alerts','telemetry_metric_windows','telemetry_metric_sources']) {
    await fixture(async ({ pool,s,options,makeStore,count,a }) => {
      let armed = false;
      const broken = wrapper(options.pool,async (client,sql,params) => armed && sql.startsWith(`INSERT INTO ${s}.${table}`)
        ? client.query('SELECT 1/0') : client.query(sql,params));
      const failed = await makeStore('policy',{ pool: broken }); armed = true;
      const packet = event(tenant,{ event: 'control_denied',status: 503,outcome: 'disabled' });
      await assert.rejects(failed.append(packet),{ code: 'TELEMETRY_UNAVAILABLE' });
      for (const name of ['telemetry_events','telemetry_metric_sources','telemetry_metric_windows','telemetry_metric_alerts']) assert.equal(await count(name),0,table+' rollback '+name);
      assert.equal((await pool.query(`SELECT source_count,window_count FROM ${s}.telemetry_metric_totals`)).rows[0].source_count,0);
      await a.append(packet); assert.equal(await count('telemetry_metric_sources'),1); assert.equal(await count('telemetry_metric_alerts'),1);
    });
  }
});

test('actual unknown COMMIT and exact replay after source/alert pruning retain one count and no new delivery', { skip,timeout: 60_000 }, async () => {
  await fixture(async ({ options,makeStore,a,b,count,prune,advance }) => {
    let armed = false;
    const unreliable = wrapper(options.pool,async (client,sql,params) => {
      const result = await client.query(sql,params);
      if (armed && sql === 'COMMIT') { armed = false; throw new Error('lost metrics COMMIT reply SECRET'); } return result;
    });
    const lost = await makeStore('policy',{ pool: unreliable });
    const packet = event(tenant,{ event: 'control_denied',status: 503,outcome: 'disabled' }); armed = true;
    await assert.rejects(lost.append(packet),{ code: 'TELEMETRY_UNAVAILABLE' });
    assert.equal(await count('telemetry_events'),1); assert.equal(await count('telemetry_metric_alerts'),1);
    assert.equal((await b.append(packet)).persisted,true); assert.equal((await a.readMetrics({ tenant_hash: tenant })).windows[0].count,1);
    const alerts = await makeStore('alert'); await ack(a); await ack(alerts); advance(2000);
    assert.equal((await prune('policy')).removed,1); assert.equal((await prune('alert')).removed,1);
    const fresh = await makeStore(); await fresh.append(packet);
    assert.equal(await count('telemetry_events'),0); assert.equal(await count('telemetry_metric_alerts'),0);
    assert.equal((await fresh.readMetrics({ tenant_hash: tenant })).windows[0].count,1);
    await assert.rejects(fresh.append({ ...packet,duration_ms: 2 }),{ code: 'TELEMETRY_EVENT_CONFLICT' });
    assert.equal(await count('telemetry_metric_sources'),1);
  });
});

test('pending alert deletion or payload corruption cannot masquerade as healthy exact replay', { skip,timeout: 60_000 }, async () => {
  for (const mutation of ['delete','payload']) await fixture(async ({ a,b,pool,s }) => {
    const packet = event(tenant,{ event: 'control_denied',status: 503,outcome: 'disabled' }); await a.append(packet);
    if (mutation === 'delete') await pool.query(`DELETE FROM ${s}.telemetry_metric_alerts`);
    else await pool.query(`UPDATE ${s}.telemetry_metric_alerts SET payload=jsonb_set(payload,'{threshold}','999')`);
    await assert.rejects(b.append(packet),{ code: 'TELEMETRY_METRIC_DRIFT' },'pending alert custody must remain intact');
  });
});

test('exact lifecycle batch replay revalidates metric custody and counts lease expiry only once', { skip,timeout: 60_000 }, async () => {
  await fixture(async ({ makeStore,pool,s }) => {
    const source = await createFixture(), { ref,packet } = await lifecyclePacket(source);
    await source.controlPlane.claimExecution(source.principal,{ invocation_ref: ref,lease_token: source.nextLeaseToken(),worker_id: 'metric_expiry',lease_ms: 5000 });
    source.setNow('2026-09-05T12:00:06.000Z'); await source.controlPlane.sweepExpiredLeases();
    packet.window = await source.controlPlane.readAuditWindow(source.principal,ref,{ limit: 64 });
    const life = await makeStore('lifecycle'); await life.appendLifecycleWindow(packet); await life.appendLifecycleWindow(packet);
    const view = await life.readMetrics({ tenant_hash: packet.scope.tenant_hash });
    assert.equal(view.windows.length,1); assert.equal(view.windows[0].rule_id,'lease_expiry_observed'); assert.equal(view.windows[0].count,1);
    await pool.query(`UPDATE ${s}.telemetry_metric_sources SET state_hash=$1`,[sha256Ref('corrupted permanent lifecycle custody')]);
    await assert.rejects(life.appendLifecycleWindow(packet),{ code: 'TELEMETRY_EVENT_CONFLICT' });
  });
});

test('v2 upgrade preserves existing rows as uncounted baseline and rejects changed lifecycle row metadata', { skip,timeout: 60_000 }, async () => {
  for (const corrupt of [false,true]) await fixture(async ({ a,makeStore,pool,s,options }) => {
    const policy = event(); await a.append(policy);
    const source = await createFixture(), { packet } = await lifecyclePacket(source);
    const life = await makeStore('lifecycle'); await life.appendLifecycleWindow(packet);
    if (corrupt) {
      await pool.query(`UPDATE ${s}.telemetry_lifecycle_events SET source_sequence=source_sequence+1`);
      await assert.rejects(migratePostgresManagedTelemetry(options),{ code: 'TELEMETRY_MIGRATION_FAILED' });
      assert.equal((await pool.query(`SELECT max(version) AS version FROM ${s}.telemetry_schema_migrations`)).rows[0].version,2);
      return;
    }
    assert.equal((await migratePostgresManagedTelemetry(options)).migration_version,3);
    const fresh = await makeStore('policy',options); await fresh.append(policy);
    const before = await fresh.readMetrics({ tenant_hash: tenant }); assert.equal(before.legacy_uncounted,1); assert.equal(before.windows.length,0);
    assert.equal((await pool.query(`SELECT count(*)::integer AS n FROM ${s}.telemetry_metric_sources`)).rows[0].n,2);
    const upgradedLife = await makeStore('lifecycle',{ ...options,eventKind: 'lifecycle' }); await upgradedLife.appendLifecycleWindow(packet);
    await fresh.append(event()); await fresh.append(event());
    assert.equal((await fresh.readMetrics({ tenant_hash: tenant })).windows[0].count,2);
    assert.equal((await pool.query(`SELECT count(*)::integer AS n FROM ${s}.telemetry_metric_alerts`)).rows[0].n,1);
    await assert.rejects(a.stats(),{ code: 'TELEMETRY_UNAVAILABLE' },'v2 runtime must not silently accept v3 schema');
  },{ upgrade: true });
});

test('lifetime source/window/alert caps stop without partial writes or deleting retained custody', { skip,timeout: 60_000 }, async () => {
  for (const cap of ['Sources','Windows','Alerts']) await fixture(async ({ a,prune,makeStore,advance,count }) => {
    const first = event(tenant,{ event: 'control_denied',status: 503,outcome: 'disabled' }); await a.append(first);
    await ack(a); const alerts = await makeStore('alert'); await ack(alerts); advance(2000);
    assert.equal((await prune('policy')).removed,1);
    if (cap !== 'Alerts') assert.equal((await prune('alert')).removed,1);
    const second = event(tenant,{ event: 'control_denied',status: 503,outcome: 'disabled' });
    await assert.rejects(a.append(second),{ code: 'TELEMETRY_CAPACITY' });
    assert.equal(await count('telemetry_events'),0); assert.equal(await count('telemetry_metric_sources'),1); assert.equal(await count('telemetry_metric_windows'),1);
    await a.append(first); assert.equal(await count('telemetry_events'),0,'exact retained replay stays available at capacity');
  },{ metricSettings: { ...settings,['max'+cap]: 1,['max'+cap+'PerTenant']: 1 } });
});

test('tenant metric caps cannot consume another tenant allowance or leave a partial projection', { skip,timeout: 60_000 }, async () => {
  for (const cap of ['Sources','Windows','Alerts']) await fixture(async ({ a,b,count,advance }) => {
    const disabled = (hash) => event(hash,{ event: 'control_denied',status: 503,outcome: 'disabled' });
    await a.append(disabled(tenant)); advance(1000);
    await assert.rejects(a.append(disabled(tenant)),{ code: 'TELEMETRY_CAPACITY' });
    await b.append(disabled(otherTenant));
    assert.equal(await count('telemetry_events'),2); assert.equal(await count('telemetry_metric_sources'),2);
    assert.equal(await count('telemetry_metric_windows'),2); assert.equal(await count('telemetry_metric_alerts'),2);
  },{ metricSettings: { ...settings,['max'+cap+'PerTenant']: 1 } });
});

test('alert backoff/takeover fences stale generations; ACK and permanent evidence commit or roll back together', { skip,timeout: 60_000 }, async () => {
  await fixture(async ({ a,makeStore,options,pool,s,advance,prune,count }) => {
    const packet = event(tenant,{ event: 'control_denied',status: 503,outcome: 'disabled' }); await a.append(packet);
    const alerts = await makeStore('alert'), c1Token = token(), c1 = await alerts.claim({ claimToken: c1Token });
    await alerts.retry({ event_ref: c1.event.event_ref,generation: c1.generation,claimToken: c1Token,errorCode: 'SINK_UNAVAILABLE' });
    assert.equal(await alerts.claim({ claimToken: token() }),null);
    advance(200); const c2Token = token(), c2 = await alerts.claim({ claimToken: c2Token }); assert.equal(c2.generation,2);
    const acknowledge = (store,c,claimToken) => store.acknowledge({ event_ref: c.event.event_ref,generation: c.generation,claimToken,
      acknowledgement: { event_ref: c.event.event_ref,delivered: true } });
    await assert.rejects(acknowledge(alerts,c1,c1Token),{ code: 'TELEMETRY_STALE_CLAIM' });
    advance(1000); const c3Token = token(), c3 = await alerts.claim({ claimToken: c3Token }); assert.equal(c3.generation,3);
    await assert.rejects(acknowledge(alerts,c2,c2Token),{ code: 'TELEMETRY_STALE_CLAIM' });
    let armed = false;
    const broken = wrapper(options.pool,(client,sql,params) => armed && sql.startsWith(`UPDATE ${s}.telemetry_metric_windows SET payload=`)
      ? client.query('SELECT 1/0') : client.query(sql,params));
    const failing = await makeStore('alert',{ pool: broken }); armed = true;
    await assert.rejects(acknowledge(failing,c3,c3Token),{ code: 'TELEMETRY_UNAVAILABLE' });
    assert.equal((await alerts.stats()).claimed,1);
    assert.equal((await a.readMetrics({ tenant_hash: tenant })).windows[0].alert_acknowledgement_hash,null);
    let loseCommit = false;
    const unreliable = wrapper(options.pool,async (client,sql,params) => {
      const result = await client.query(sql,params);
      if (loseCommit && sql === 'COMMIT') { loseCommit = false; throw new Error('lost alert ACK commit'); } return result;
    });
    const lost = await makeStore('alert',{ pool: unreliable }); loseCommit = true;
    await assert.rejects(acknowledge(lost,c3,c3Token),{ code: 'TELEMETRY_UNAVAILABLE' });
    assert.equal((await alerts.stats()).acked,1); assert.equal((await acknowledge(alerts,c3,c3Token)).acknowledged,true);
    const window = (await a.readMetrics({ tenant_hash: tenant })).windows[0];
    assert.equal(window.alert_acknowledgement_hash,sha256Ref({ event_ref: c3.event.event_ref,delivered: true }));
    advance(1000); assert.equal((await prune('alert')).removed,1); await a.append(packet);
    assert.equal(await count('telemetry_metric_alerts'),0,'permanent ACK permits legitimate prune without redelivery');
    await pool.query(`UPDATE ${s}.telemetry_metric_windows SET payload=jsonb_set(payload,'{alert_acknowledgement_hash}',$1::jsonb)`,[JSON.stringify(sha256Ref('forged ACK'))]);
    await assert.rejects(a.append(packet),{ code: 'TELEMETRY_METRIC_DRIFT' });
  });
});

test('lost alert ACK reply cannot redeliver a durably acknowledged sink packet after restart', { skip,timeout: 60_000 }, async () => {
  await fixture(async ({ a,makeStore,options }) => {
    await a.append(event(tenant,{ event: 'control_denied',status: 503,outcome: 'disabled' }));
    let armed = false, ackWritten = false, calls = 0;
    const unreliable = wrapper(options.pool,async (client,sql,params) => {
      const result = await client.query(sql,params);
      if (armed && sql.includes("SET state='acked'")) ackWritten = true;
      if (armed && ackWritten && sql === 'COMMIT') { armed = false; throw new Error('lost persisted alert ACK'); } return result;
    });
    const bad = await makeStore('alert',{ pool: unreliable }), healthy = await makeStore('alert'); armed = true;
    const sink = new Set(), deliver = async (packet) => { calls += 1; sink.add(packet.event_ref); return { event_ref: packet.event_ref,delivered: true }; };
    const first = createManagedTelemetryDrainer({ store: bad,eventKind: 'alert',deliver });
    try { const result = await first.runOnce(); assert.equal(result.delivered,0); assert.equal(result.failed,1); }
    finally { await first.close(); }
    const second = createManagedTelemetryDrainer({ store: healthy,eventKind: 'alert',deliver });
    try { assert.equal((await second.runOnce()).processed,0); } finally { await second.close(); }
    assert.equal((await healthy.stats()).acked,1); assert.equal(calls,1); assert.equal(sink.size,1);
  });
});

test('permanent source/window deletion, totals or catalog/settings drift fail closed without self-repair', { skip,timeout: 60_000 }, async () => {
  for (const mutation of ['sources','windows','totals','settings','catalog']) await fixture(async ({ a,b,pool,s,count }) => {
    await a.append(event());
    if (mutation === 'sources' || mutation === 'windows') await pool.query(`DELETE FROM ${s}.telemetry_metric_${mutation}`);
    if (mutation === 'totals') await pool.query(`UPDATE ${s}.telemetry_metric_totals SET state_hash=$1`,[sha256Ref('bad totals')]);
    if (mutation === 'settings') await pool.query(`UPDATE ${s}.telemetry_metric_settings SET payload=jsonb_set(payload,'{maxSources}','99')`);
    if (mutation === 'catalog') await pool.query(`ALTER TABLE ${s}.telemetry_metric_sources ADD COLUMN unreviewed text`);
    await assert.rejects(b.stats(),{ code: ['sources','windows','totals'].includes(mutation) ? 'TELEMETRY_METRIC_DRIFT' : 'TELEMETRY_UNAVAILABLE' });
    assert.equal(await count('telemetry_events'),1);
  });
});

test('same-count corruption distinguishes aggregate health from exact source/window/alert validation', { skip,timeout: 60_000 }, async () => {
  for (const mutation of ['source','window','alert']) await fixture(async ({ a,b,pool,s,count }) => {
    const packet = event(tenant,{ event: 'control_denied',status: 503,outcome: 'disabled' }); await a.append(packet);
    if (mutation === 'source') {
      // Deliberate owner misuse, not runtime UPDATE permission. Even a
      // self-consistent custody hash is not independent source provenance.
      const original = (await pool.query(`SELECT payload FROM ${s}.telemetry_metric_sources`)).rows[0].payload;
      const forged = { ...original,event_hash: sha256Ref('same-count forged source identity') };
      await pool.query(`UPDATE ${s}.telemetry_metric_sources SET event_hash=$1,payload=$2,state_hash=$3`,
        [forged.event_hash,forged,sha256Ref({ domain: 'risk-fork-metric-custody-v1',value: forged })]);
    } else if (mutation === 'window') {
      await pool.query(`UPDATE ${s}.telemetry_metric_windows SET state_hash=$1`,[sha256Ref('same-count corrupted window')]);
    } else {
      await pool.query(`UPDATE ${s}.telemetry_metric_alerts SET event_hash=$1`,[sha256Ref('same-count corrupted alert')]);
    }
    for (const name of ['telemetry_metric_sources','telemetry_metric_windows','telemetry_metric_alerts']) assert.equal(await count(name),1);
    const snapshot = async () => JSON.stringify((await pool.query(`SELECT payload,state_hash FROM ${s}.telemetry_metric_sources`)).rows)
      + JSON.stringify((await pool.query(`SELECT payload,state_hash FROM ${s}.telemetry_metric_windows`)).rows)
      + JSON.stringify((await pool.query(`SELECT payload,event_hash FROM ${s}.telemetry_metric_alerts`)).rows);
    const before = await snapshot();
    if (mutation === 'alert') await assert.rejects(b.stats(),{ code: 'TELEMETRY_METRIC_DRIFT' });
    else assert.equal((await b.stats()).pending,1,'aggregate health is not complete source/window authentication');
    if (mutation === 'window') await assert.rejects(b.readMetrics({ tenant_hash: tenant }),{ code: 'TELEMETRY_METRIC_DRIFT' });
    await assert.rejects(b.append(packet),{ code: mutation === 'source' ? 'TELEMETRY_EVENT_CONFLICT' : 'TELEMETRY_METRIC_DRIFT' });
    assert.equal(await snapshot(),before,'validation must not repair observer state');
  });
});

test('legacy baseline above explicit lifetime custody cap aborts upgrade without changing v2 rows or ledger', { skip,timeout: 60_000 }, async () => {
  await fixture(async ({ a,options,pool,s }) => {
    await a.append(event()); await a.append(event());
    await assert.rejects(migratePostgresManagedTelemetry(options),{ code: 'TELEMETRY_MIGRATION_FAILED' });
    assert.equal((await a.stats()).pending,2);
    assert.equal((await pool.query(`SELECT max(version) AS n FROM ${s}.telemetry_schema_migrations`)).rows[0].n,2);
    assert.equal((await pool.query('SELECT 1 FROM information_schema.tables WHERE table_schema=$1 AND table_name=$2',
      [options.schemaName,'telemetry_metric_sources'])).rowCount,0);
  },{ upgrade: true,metricSettings: { ...settings,maxSources: 1,maxSourcesPerTenant: 1 } });
});

test('metric v3 store requires positive CA TLS and rejects wrong CA and stale version selection', { skip,timeout: 60_000 }, async () => {
  const ca = process.env.RISK_FORK_TEST_POSTGRES_TLS_CA; assert.equal(typeof ca,'string');
  await fixture(async ({ options,makeStore }) => {
    const tlsOptions = { connectionString,schemaName: options.schemaName,limits,lifecycle: true,metrics: true,metricSettings: settings,eventKind: 'alert' };
    const tls = await createPostgresManagedTelemetryStore({ ...tlsOptions,tls: { ca } });
    try { assert.equal((await tls.initialize()).exact_catalog_verified,true); assert.equal((await tls.stats()).pending,0); }
    finally { await tls.close(); }
    await assert.rejects(createPostgresManagedTelemetryStore({ ...tlsOptions,tls: { ca: rootCertificates[0] } }),{ code: 'TELEMETRY_UNAVAILABLE' });
    await assert.rejects(makeStore('policy',{ metrics: false,metricSettings: undefined }),{ code: 'TELEMETRY_UNAVAILABLE' });
    await assert.rejects(makeStore('alert',{ metrics: false,metricSettings: undefined }),/Invalid telemetry version/);
  },{ clockControl: false });
});

test('dedicated metric runtime has exact grants, cannot rewrite custody/alerts or prune, and detects extra grants', { skip,timeout: 90_000 }, async () => {
  const suffix = randomUUID().replaceAll('-','').slice(0,16), db = `metric_role_${suffix}`, owner = `metric_owner_${suffix}`, runtime = `metric_runtime_${suffix}`;
  const schemaName = `metrics_${suffix}`, s = qid(schemaName), root = new pg.Pool({ connectionString });
  const url = new URL(connectionString); url.pathname = `/${db}`;
  let admin, ownerPool, runtimePool, policy, alerts, created = false;
  const password = `disposable-${randomUUID()}`;
  try {
    await root.query(`CREATE DATABASE ${qid(db)}`); created = true; admin = new pg.Pool({ connectionString: url.toString() });
    await admin.query(`CREATE ROLE ${qid(owner)} LOGIN NOINHERIT PASSWORD '${password}'`);
    await admin.query(`CREATE ROLE ${qid(runtime)} LOGIN NOINHERIT PASSWORD '${password}'`);
    const replace = (text) => text.replaceAll('__TELEMETRY_DATABASE__',qid(db)).replaceAll('__TELEMETRY_SCHEMA__',s)
      .replaceAll('__TELEMETRY_MIGRATOR__',qid(owner)).replaceAll('__TELEMETRY_RUNTIME__',qid(runtime));
    const [bootstrap,grants] = replace(await readFile(new URL('../ops/postgres/telemetry-roles.sql.template',import.meta.url),'utf8'))
      .split('-- Dedicated migrator AFTER migratePostgresManagedTelemetry:');
    await admin.query(bootstrap); url.username = owner; url.password = password; ownerPool = new pg.Pool({ connectionString: url.toString() });
    const base = { schemaName,limits,requireTls: false,disposableDb: true,lifecycle: true,metrics: true,metricSettings: settings };
    await migratePostgresManagedTelemetry({ ...base,pool: ownerPool }); await ownerPool.query(grants);
    await ownerPool.query(replace(await readFile(new URL('../ops/postgres/lifecycle-grants.sql.template',import.meta.url),'utf8')));
    await ownerPool.query(replace(await readFile(new URL('../ops/postgres/metrics-grants.sql.template',import.meta.url),'utf8')));
    url.username = runtime; runtimePool = new pg.Pool({ connectionString: url.toString() });
    const ca = process.env.RISK_FORK_TEST_POSTGRES_TLS_CA; assert.equal(typeof ca,'string');
    const runtimeOptions = { schemaName,limits,lifecycle: true,metrics: true,metricSettings: settings,
      connectionString: url.toString(),expectedOwner: owner,tls: { ca } };
    policy = await createPostgresManagedTelemetryStore(runtimeOptions);
    alerts = await createPostgresManagedTelemetryStore({ ...runtimeOptions,eventKind: 'alert' });
    assert.equal((await alerts.initialize()).runtime_privileges_verified,true);
    const packet = event(tenant,{ event: 'control_denied',status: 503,outcome: 'disabled' }); await policy.append(packet);
    await ack(alerts); await policy.append(packet);
    for (const sql of [`UPDATE ${s}.telemetry_metric_alerts SET payload='{}'`,`UPDATE ${s}.telemetry_metric_sources SET payload='{}'`,
      `DELETE FROM ${s}.telemetry_metric_sources`,`DELETE FROM ${s}.telemetry_metric_windows`,`DELETE FROM ${s}.telemetry_metric_alerts`,
      `TRUNCATE ${s}.telemetry_metric_alerts`,`UPDATE ${s}.telemetry_metric_windows SET rule_id='rate_denied'`,
      `UPDATE ${s}.telemetry_metric_settings SET payload='{}'`,`UPDATE ${s}.telemetry_schema_migrations SET version=1`]) {
      await assert.rejects(runtimePool.query(sql),{ code: '42501' });
    }
    await ownerPool.query(`UPDATE ${s}.telemetry_metric_alerts SET acknowledged_ms=0`);
    // Corrupt ACK metadata cannot be used to accelerate retention. Restore the
    // real exact timestamp before checking owner-only pruning eligibility.
    await assert.rejects(prunePostgresManagedTelemetry({ ...base,pool: ownerPool,expectedOwner: owner,eventKind: 'alert' }),{ code: 'TELEMETRY_RETENTION_FAILED' });
    await ownerPool.query(`UPDATE ${s}.telemetry_metric_alerts a SET acknowledged_ms=(w.payload->>'alert_acknowledged_ms')::bigint
      FROM ${s}.telemetry_metric_windows w WHERE w.payload->>'last_alert_ref'=a.event_ref`);
    await assert.rejects(prunePostgresManagedTelemetry({ ...base,pool: runtimePool,expectedOwner: owner,eventKind: 'alert' }),{ code: 'TELEMETRY_RETENTION_FAILED' });
    await admin.query(`GRANT UPDATE (payload) ON ${s}.telemetry_metric_alerts TO ${qid(runtime)}`);
    await assert.rejects(alerts.stats(),{ code: 'TELEMETRY_UNAVAILABLE' });
    assert.equal((await ownerPool.query(`SELECT * FROM ${s}.telemetry_metric_sources`)).rowCount,1);
    await admin.query(`REVOKE UPDATE (payload) ON ${s}.telemetry_metric_alerts FROM ${qid(runtime)}`);
    assert.equal((await alerts.stats()).acked,1,'the exact runtime becomes healthy only after explicit owner ACL repair');
    const retentionClock = wrapper(ownerPool,async (client,sql,params) => {
      const result = await client.query(sql,params);
      return sql === 'SELECT floor(extract(epoch FROM clock_timestamp()) * 1000)::bigint AS now_ms'
        ? { ...result,rows: [{ now_ms: String(Number(result.rows[0].now_ms)+2000) }] } : result;
    });
    assert.equal((await prunePostgresManagedTelemetry({ ...base,pool: retentionClock,expectedOwner: owner,eventKind: 'alert' })).removed,1);
    assert.equal((await ownerPool.query(`SELECT * FROM ${s}.telemetry_metric_windows`)).rowCount,1);
    assert.equal((await ownerPool.query(`SELECT * FROM ${s}.telemetry_metric_sources`)).rowCount,1);
  } finally {
    const errors = [], cleanup = async (fn) => { try { await fn(); } catch (e) { errors.push(e); } };
    await cleanup(() => policy?.close()); await cleanup(() => alerts?.close());
    await cleanup(() => runtimePool?.end()); await cleanup(() => ownerPool?.end()); await cleanup(() => admin?.end());
    if (created) await cleanup(() => root.query(`DROP DATABASE ${qid(db)}`));
    await cleanup(() => root.query(`DROP ROLE IF EXISTS ${qid(runtime)}`)); await cleanup(() => root.query(`DROP ROLE IF EXISTS ${qid(owner)}`));
    await cleanup(async () => assert.equal((await root.query('SELECT 1 FROM pg_database WHERE datname=$1',[db])).rowCount,0));
    await cleanup(async () => assert.equal((await root.query('SELECT 1 FROM pg_roles WHERE rolname=ANY($1::text[])',[[owner,runtime]])).rowCount,0));
    await cleanup(() => root.end()); if (errors.length) throw new AggregateError(errors,'Metrics role/database cleanup failed');
  }
});

test('bounded historical metric read truncates at 64 and real SQL timeout fails closed without partial writes', { skip,timeout: 60_000 }, async (t) => {
  const capacities = { ...settings,maxSources: 512,maxSourcesPerTenant: 512,maxWindows: 512,maxWindowsPerTenant: 512 };
  await fixture(async ({ a,pool,s,options,makeStore,now,count }) => {
    const windows = [], sources = [], rules_hash = metricRulesHash(capacities);
    // Synthetic already-committed/pruned history exercises retained-state
    // verification cost. It is not measured production traffic or max scale.
    for (let i = 0; i < 128; i += 1) {
      const packet = event(), window_start_ms = now()-i*1000;
      const payload = { tenant_hash: tenant,rule_id: 'rate_denied',window_start_ms,window_ms: 1000,count: 1,
        last_alert_ref: null,last_alert_hash: null,alert_acknowledged_ms: null,alert_acknowledgement_hash: null,rules_hash };
      windows.push({ tenant_hash: tenant,rule_id: 'rate_denied',window_start_ms,payload,
        state_hash: sha256Ref({ domain: 'risk-fork-metric-window-v1',value: payload }) });
      const custody = { source_kind: 'policy',event_ref: packet.event_ref,event_hash: sha256Ref(packet),tenant_hash: tenant,
        recorded_ms: window_start_ms+1,legacy_uncounted: false,contributions: [{ rule_id: 'rate_denied',window_start_ms,count_after: 1 }] };
      sources.push({ source_kind: 'policy',event_ref: packet.event_ref,event_hash: custody.event_hash,tenant_hash: tenant,payload: custody,
        state_hash: sha256Ref({ domain: 'risk-fork-metric-custody-v1',value: custody }) });
    }
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query(`INSERT INTO ${s}.telemetry_metric_windows SELECT * FROM jsonb_to_recordset($1::jsonb)
        AS v(tenant_hash text,rule_id text,window_start_ms bigint,payload jsonb,state_hash text)`,[JSON.stringify(windows)]);
      await client.query(`INSERT INTO ${s}.telemetry_metric_sources SELECT * FROM jsonb_to_recordset($1::jsonb)
        AS v(source_kind text,event_ref text,event_hash text,tenant_hash text,payload jsonb,state_hash text)`,[JSON.stringify(sources)]);
      await client.query(`UPDATE ${s}.telemetry_metric_totals SET source_count=128,window_count=128,state_hash=$1`,[metricTotalsHash(128,128)]);
      await client.query('COMMIT');
    } catch (e) { await client.query('ROLLBACK'); throw e; } finally { client.release(); }
    const started = performance.now(), view = await a.readMetrics({ tenant_hash: tenant });
    t.diagnostic(JSON.stringify({ retained_fixture_windows: 128,read_ms: performance.now()-started,max_scale_qualified: false }));
    assert.equal(view.windows.length,64); assert.equal(view.truncated,true); assert.equal(view.retained_sources,128);
    assert.deepEqual(view.windows.map((w) => w.window_start_ms),windows.slice(0,64).map((w) => w.window_start_ms));
    let armed = false;
    const stalled = wrapper(options.pool,(client,sql,params) => armed && sql.startsWith('SELECT (SELECT count(*)::integer')
      ? client.query('SELECT pg_sleep(0.2)') : client.query(sql,params));
    const failing = await makeStore('policy',{ pool: stalled,statementTimeoutMs: 100 }); armed = true;
    const packet = event(); await assert.rejects(failing.append(packet),{ code: 'TELEMETRY_UNAVAILABLE' });
    assert.equal(await count('telemetry_events'),0); assert.equal(await count('telemetry_metric_sources'),128);
    await a.append(packet); assert.equal(await count('telemetry_metric_sources'),129);
  },{ metricSettings: capacities });
});
