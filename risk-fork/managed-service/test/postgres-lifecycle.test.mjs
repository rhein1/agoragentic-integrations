import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { rootCertificates } from 'node:tls';
import pg from 'pg';
import { createPostgresManagedTelemetryStore } from '../src/postgres-telemetry-store.mjs';
import { migratePostgresManagedTelemetry } from '../src/postgres-telemetry-migrator.mjs';
import { prunePostgresManagedTelemetry } from '../src/postgres-telemetry-maintenance.mjs';
import { createManagedLifecycleObserver } from '../src/lifecycle-observer.mjs';
import { createManagedTelemetryDrainer } from '../src/telemetry-drainer.mjs';
import { createManagedTelemetryEvent } from '../src/telemetry-event.mjs';
import { lifecycleTenantHash } from '../src/lifecycle-event.mjs';
import { sha256Ref } from '../../src/canonical.mjs';
import { createFixture, invocationRequest } from './helpers.mjs';

const connectionString = process.env.RISK_FORK_MANAGED_TEST_POSTGRES_URL;
if (!connectionString && process.env.RISK_FORK_MANAGED_REQUIRE_POSTGRES_TESTS === '1') throw new Error('Mandatory lifecycle PG tests require a database');
const skip = !connectionString;
if (connectionString) {
  const url = new URL(connectionString);
  if (!['127.0.0.1','localhost','[::1]'].includes(url.hostname) || url.pathname !== '/risk_fork_managed_test'
    || process.env.RISK_FORK_MANAGED_TEST_CONFIRM_DISPOSABLE !== 'YES_DELETE_DATA') throw new Error('Lifecycle tests require explicit disposable loopback DB');
}
const qid = (value) => { assert.match(value,/^[a-z_][a-z0-9_]*$/); return `"${value}"`; };
const token = () => randomBytes(32).toString('base64url');
const limits = { maxEvents: 200,maxEventsPerTenant: 150,leaseMs: 10_000,retryMs: 200,retentionMs: 1000 };
const scope = (tenant = 'tenant_alpha') => ({ observer_hash: sha256Ref('stable observer'),tenant_hash: lifecycleTenantHash(tenant) });
function wrapper(pool, intercept) { return { async connect() { const client = await pool.connect();
  return { release: () => client.release(),query: (sql,params) => intercept(client,sql,params) }; } }; }
async function fixture(run, override = {}) {
  const schemaName = `lifecycle_${randomUUID().replaceAll('-','')}`, s = qid(schemaName);
  const pool = new pg.Pool({ connectionString,max: 6 }), stores = [];
  const options = { pool,schemaName,limits: { ...limits,...override },requireTls: false,disposableDb: true,lifecycle: true,eventKind: 'lifecycle' };
  try {
    await migratePostgresManagedTelemetry(options);
    const a = await createPostgresManagedTelemetryStore(options), b = await createPostgresManagedTelemetryStore(options); stores.push(a,b);
    const source = await createFixture({ concurrency: 16 });
    const admitted = await source.controlPlane.admitInvocation(source.principal,invocationRequest({ estimated_cost_micros: 0 }));
    const ref = admitted.invocation.invocation_ref;
    const page = await source.controlPlane.listAuditInvocations(source.principal,{ limit: 1 });
    const window = await source.controlPlane.readAuditWindow(source.principal,ref,{ limit: 64 });
    const packet = { scope: scope(),tenant_id: 'tenant_alpha',expected_sweep: null,expected_checkpoint: null,page,window };
    await run({ pool,s,options,a,b,stores,source,ref,packet });
  } finally {
    const errors = [], cleanup = async (fn) => { try { await fn(); } catch (e) { errors.push(e); } };
    for (const store of stores) await cleanup(() => store.close());
    await cleanup(() => pool.query(`DROP SCHEMA ${s} CASCADE`));
    await cleanup(async () => assert.equal((await pool.query('SELECT 1 FROM pg_namespace WHERE nspname=$1',[schemaName])).rowCount,0));
    await cleanup(() => pool.end());
    if (errors.length) throw new AggregateError(errors,'Lifecycle disposable cleanup failed');
  }
}

test('lifecycle batch rollback cannot advance checkpoint before outbox; unknown commit and prune replay converge', { skip,timeout: 60_000 }, async () => {
  await fixture(async ({ pool,s,options,a,b,stores,packet,ref }) => {
    let armed = false;
    const broken = wrapper(pool,(client,sql,params) => armed && sql.startsWith(`INSERT INTO ${s}.telemetry_lifecycle_checkpoints`) ? client.query('SELECT 1/0') : client.query(sql,params));
    const failed = await createPostgresManagedTelemetryStore({ ...options,pool: broken }); stores.push(failed); armed = true;
    await assert.rejects(failed.appendLifecycleWindow(packet),{ code: 'TELEMETRY_UNAVAILABLE' });
    assert.equal((await a.stats()).pending,0); assert.equal(await a.readLifecycleSweep(scope()),null);
    const unreliable = wrapper(pool,async (client,sql,params) => {
      const result = await client.query(sql,params);
      if (armed && sql === 'COMMIT') { armed = false; throw new Error('lost committed lifecycle reply SECRET'); } return result;
    });
    armed = false; const lost = await createPostgresManagedTelemetryStore({ ...options,pool: unreliable }); stores.push(lost); armed = true;
    await assert.rejects(lost.appendLifecycleWindow(packet),{ code: 'TELEMETRY_UNAVAILABLE' });
    const kept = await b.readLifecycleSweep(scope()); assert.equal(kept.version,1);
    assert.equal((await b.readLifecycleCheckpoint(scope(),ref)).sequence,1);
    assert.equal((await b.appendLifecycleWindow(packet)).persisted,true); assert.equal((await a.stats()).pending,1);
    const original = (await pool.query(`SELECT checkpoint_hash FROM ${s}.telemetry_lifecycle_checkpoints`)).rows[0].checkpoint_hash;
    await pool.query(`UPDATE ${s}.telemetry_lifecycle_checkpoints SET checkpoint_hash=$1`,[sha256Ref('corrupt retained checkpoint')]);
    await assert.rejects(b.appendLifecycleWindow(packet),{ code: 'TELEMETRY_CHECKPOINT_DRIFT' },'exact replay must validate retained checkpoint, not only sweep count');
    await pool.query(`UPDATE ${s}.telemetry_lifecycle_checkpoints SET checkpoint_hash=$1`,[original]);
    const claimToken = token(), c = await a.claim({ claimToken });
    await a.acknowledge({ event_ref: c.event.event_ref,generation: c.generation,claimToken,acknowledgement: { event_ref: c.event.event_ref,delivered: true } });
    await pool.query(`UPDATE ${s}.telemetry_lifecycle_events SET acknowledged_ms=0`);
    const owner = (await pool.query('SELECT current_user AS name')).rows[0].name;
    assert.equal((await prunePostgresManagedTelemetry({ ...options,expectedOwner: owner })).removed,1);
    assert.equal((await a.stats()).pending,0);
    assert.deepEqual((await b.appendLifecycleWindow(packet)).sweep,kept);
    assert.equal((await a.stats()).pending,0,'retained exact batch replay must not recreate pruned delivery');
    await pool.query(`DELETE FROM ${s}.telemetry_lifecycle_checkpoints`);
    await assert.rejects(a.readLifecycleSweep(scope()),{ code: 'TELEMETRY_CHECKPOINT_DRIFT' });
    await assert.rejects(b.appendLifecycleWindow(packet),{ code: 'TELEMETRY_CHECKPOINT_DRIFT' });
  });
});

test('two instances converge on exact source batch and stale/scope-altered continuations cannot skip source', { skip,timeout: 60_000 }, async () => {
  await fixture(async ({ a,b,source,packet,ref,pool,s }) => {
    await Promise.all([a.appendLifecycleWindow(packet),b.appendLifecycleWindow(packet)]);
    assert.equal((await a.stats()).pending,1);
    assert.equal((await a.readLifecycleSweep(scope())).version,1);
    await assert.rejects(a.appendLifecycleWindow({ ...packet,scope: scope('tenant_other') }),/tenant mismatch/);
    await source.controlPlane.claimExecution(source.principal,{ invocation_ref: ref,lease_token: source.nextLeaseToken(),worker_id: 'observer_test',lease_ms: 5000 });
    const next = { ...packet,expected_sweep: await b.readLifecycleSweep(scope()),expected_checkpoint: await b.readLifecycleCheckpoint(scope(),ref),
      window: await source.controlPlane.readAuditWindow(source.principal,ref,{ after_sequence: 1,prior_event_hash: packet.window.next_prior_event_hash,limit: 64 }) };
    await b.appendLifecycleWindow(next); assert.equal((await a.stats()).pending,2);
    await assert.rejects(a.appendLifecycleWindow(packet),{ code: 'TELEMETRY_CHECKPOINT_CONFLICT' });
    const before = (await pool.query(`SELECT count(*)::integer AS count FROM ${s}.telemetry_lifecycle_events`)).rows[0].count;
    const altered = structuredClone(next); altered.expected_sweep.upper_ref = 'rfi_wrong';
    await assert.rejects(a.appendLifecycleWindow(altered)); assert.equal((await a.stats()).pending,before);
  });
});

test('cyclic observer rediscovers below/above cursor commits and drains busy invocation in fair bounded windows', { skip,timeout: 60_000 }, async () => {
  await fixture(async ({ a,source,pool,s,ref }) => {
    const leaseToken = source.nextLeaseToken();
    await source.controlPlane.claimExecution(source.principal,{ invocation_ref: ref,lease_token: leaseToken,worker_id: 'observer_test',lease_ms: 5000 });
    for (let i = 0; i < 68; i += 1) await source.controlPlane.renewLease(source.principal,{ invocation_ref: ref,lease_token: leaseToken,lease_ms: 5000,expected_lease_kind: 'execution' });
    await source.controlPlane.admitInvocation(source.principal,invocationRequest({ idempotency_key: 'observer-second-invocation',estimated_cost_micros: 0 }));
    const observer = createManagedLifecycleObserver({ controlPlane: source.controlPlane,store: a,auditPrincipals: [source.principal],observerId: 'stable' });
    try {
      assert.equal((await observer.runOnce()).recorded,64);
      assert.equal((await observer.runOnce()).recorded,65,'second invocation progresses before first backlog is drained');
      assert.equal((await observer.runOnce()).recorded,71);
      assert.equal((await observer.runOnce()).recorded,71);
      const sink = new Set(), drainer = createManagedTelemetryDrainer({ store: a,eventKind: 'lifecycle',maxBatch: 64,deliver: async (event) => {
        sink.add(event.event_ref); return { event_ref: event.event_ref,delivered: true };
      } });
      try { await drainer.runOnce(); await drainer.runOnce(); } finally { await drainer.close(); }
      assert.equal(sink.size,71); assert.equal((await a.stats()).acked,71);
      const serialized = JSON.stringify((await pool.query(`SELECT payload FROM ${s}.telemetry_lifecycle_events`)).rows);
      for (const forbidden of ['bounded input',leaseToken,ref,'key_alpha','provider_recovery']) assert.equal(serialized.includes(forbidden),false);
    } finally { assert.equal((await observer.close()).settled,true); }
  });
});

test('finite sweep retains its original upper and rediscovers commits on both sides of the cursor', { skip,timeout: 60_000 }, async () => {
  await fixture(async ({ a }) => {
    const refs = ['rfi_Z','rfi_a','rfi_z','rfi_A'];
    const f = await createFixture({ concurrency: 16,invocationRef: () => refs.shift() });
    const admit = (i) => f.controlPlane.admitInvocation(f.principal,invocationRequest({ idempotency_key: `finite-observer-${i}`,estimated_cost_micros: 0 }));
    await admit(1); await admit(2);
    const observer = createManagedLifecycleObserver({ controlPlane: f.controlPlane,store: a,auditPrincipals: [f.principal],observerId: 'finite_observer' });
    try {
      assert.equal((await observer.runOnce()).recorded,1); // Z, original upper a
      await admit(3); await admit(4); // above original upper and below cursor
      assert.equal((await observer.runOnce()).recorded,2); // a closes old cycle
      assert.equal((await observer.runOnce()).recorded,3); // new cycle discovers A
      await observer.runOnce(); await observer.runOnce();
      assert.equal((await observer.runOnce()).recorded,4); // eventually z
      assert.equal((await a.stats()).pending,4);
    } finally { await observer.close(); }
  });
});

test('lifecycle capacity, payload/checkpoint drift and clock rollback fail without self-repair', { skip,timeout: 60_000 }, async () => {
  await fixture(async ({ a,b,pool,s,source,packet,ref }) => {
    await a.appendLifecycleWindow(packet);
    await source.controlPlane.claimExecution(source.principal,{ invocation_ref: ref,lease_token: source.nextLeaseToken(),worker_id: 'observer_test',lease_ms: 5000 });
    const next = { ...packet,expected_sweep: await a.readLifecycleSweep(scope()),expected_checkpoint: await a.readLifecycleCheckpoint(scope(),ref),
      window: await source.controlPlane.readAuditWindow(source.principal,ref,{ after_sequence: 1,prior_event_hash: packet.window.next_prior_event_hash,limit: 64 }) };
    await assert.rejects(b.appendLifecycleWindow(next),{ code: 'TELEMETRY_CAPACITY' });
    assert.equal((await a.readLifecycleCheckpoint(scope(),ref)).sequence,1);
    await pool.query(`UPDATE ${s}.telemetry_lifecycle_checkpoints SET checkpoint_hash=$1`,[sha256Ref('corrupt')]);
    await assert.rejects(a.readLifecycleCheckpoint(scope(),ref),{ code: 'TELEMETRY_CHECKPOINT_DRIFT' });
    await pool.query(`UPDATE ${s}.telemetry_lifecycle_events SET payload=jsonb_set(payload,'{source_event_type}','"forged"')`);
    await assert.rejects(b.claim({ claimToken: token() }),{ code: 'TELEMETRY_UNAVAILABLE' });
    await pool.query(`UPDATE ${s}.telemetry_clock SET last_seen_ms=9007199254740991`);
    await assert.rejects(a.readLifecycleSweep(scope()),{ code: 'TELEMETRY_UNAVAILABLE' });
    assert.equal((await pool.query(`SELECT count(*)::integer AS count FROM ${s}.telemetry_lifecycle_events`)).rows[0].count,1);
  },{ maxEvents: 1,maxEventsPerTenant: 1 });
});

test('lifecycle opt-in upgrade preserves frozen v1 events, validates old catalog and binds CA TLS', { skip,timeout: 60_000 }, async () => {
  const ca = process.env.RISK_FORK_TEST_POSTGRES_TLS_CA;
  assert.equal(typeof ca,'string','mandatory lifecycle lab supplies positive CA TLS');
  await fixture(async ({ options,pool,a }) => {
    const tls = await createPostgresManagedTelemetryStore({ connectionString,schemaName: options.schemaName,limits,lifecycle: true,eventKind: 'lifecycle',tls: { ca } });
    try { assert.equal((await tls.initialize()).exact_catalog_verified,true); }
    finally { await tls.close(); }
    await assert.rejects(createPostgresManagedTelemetryStore({ connectionString,schemaName: options.schemaName,limits,lifecycle: true,eventKind: 'lifecycle',tls: { ca: rootCertificates[0] } }),{ code: 'TELEMETRY_UNAVAILABLE' });
    await assert.rejects(createPostgresManagedTelemetryStore({ ...options,lifecycle: false,eventKind: 'policy' }),{ code: 'TELEMETRY_UNAVAILABLE' });
    const policy = await createPostgresManagedTelemetryStore({ ...options,eventKind: 'policy' });
    try {
      const packet = createManagedTelemetryEvent({ event: 'rate_denied',route_class: 'admission',status: 429,outcome: 'rate_limited',duration_ms: 1,
        tenant_hash: sha256Ref('tenant'),key_hash: sha256Ref('key') });
      await policy.append(packet); assert.equal((await policy.stats()).pending,1); assert.equal((await a.stats()).pending,0);
      assert.equal((await migratePostgresManagedTelemetry({ ...options,pool })).migration_version,2);
    } finally { await policy.close(); }
  });
});

test('dedicated runtime upgrades v1 without losing policy rows and has exact immutable lifecycle grants', { skip,timeout: 90_000 }, async () => {
  const suffix = randomUUID().replaceAll('-','').slice(0,16), db = `lifecycle_role_${suffix}`, owner = `lifecycle_owner_${suffix}`, runtime = `lifecycle_runtime_${suffix}`;
  const schemaName = `lifecycle_${suffix}`, s = qid(schemaName), root = new pg.Pool({ connectionString });
  const url = new URL(connectionString); url.pathname = `/${db}`;
  let admin, ownerPool, runtimePool, policy, lifecycle, created = false;
  const password = `disposable-${randomUUID()}`;
  try {
    await root.query(`CREATE DATABASE ${qid(db)}`); created = true;
    admin = new pg.Pool({ connectionString: url.toString() });
    await admin.query(`CREATE ROLE ${qid(owner)} LOGIN NOINHERIT PASSWORD '${password}'`);
    await admin.query(`CREATE ROLE ${qid(runtime)} LOGIN NOINHERIT PASSWORD '${password}'`);
    const replace = (text) => text.replaceAll('__TELEMETRY_DATABASE__',qid(db)).replaceAll('__TELEMETRY_SCHEMA__',s)
      .replaceAll('__TELEMETRY_MIGRATOR__',qid(owner)).replaceAll('__TELEMETRY_RUNTIME__',qid(runtime));
    const [bootstrap,grants] = replace(await readFile(new URL('../ops/postgres/telemetry-roles.sql.template',import.meta.url),'utf8'))
      .split('-- Dedicated migrator AFTER migratePostgresManagedTelemetry:');
    await admin.query(bootstrap); url.username = owner; url.password = password;
    ownerPool = new pg.Pool({ connectionString: url.toString() });
    const base = { schemaName,limits,requireTls: false,disposableDb: true };
    await migratePostgresManagedTelemetry({ ...base,pool: ownerPool }); await ownerPool.query(grants);
    url.username = runtime; runtimePool = new pg.Pool({ connectionString: url.toString() });
    policy = await createPostgresManagedTelemetryStore({ ...base,pool: runtimePool,expectedOwner: owner });
    const policyEvent = createManagedTelemetryEvent({ event: 'rate_denied',route_class: 'admission',status: 429,outcome: 'rate_limited',duration_ms: 1,
      tenant_hash: sha256Ref('tenant'),key_hash: sha256Ref('key') });
    await policy.append(policyEvent); await policy.close(); policy = undefined;
    await migratePostgresManagedTelemetry({ ...base,pool: ownerPool,lifecycle: true });
    await ownerPool.query(grants);
    await ownerPool.query(replace(await readFile(new URL('../ops/postgres/lifecycle-grants.sql.template',import.meta.url),'utf8')));
    policy = await createPostgresManagedTelemetryStore({ ...base,pool: runtimePool,expectedOwner: owner,lifecycle: true });
    lifecycle = await createPostgresManagedTelemetryStore({ ...base,pool: runtimePool,expectedOwner: owner,lifecycle: true,eventKind: 'lifecycle' });
    assert.equal((await lifecycle.initialize()).runtime_privileges_verified,true); assert.equal((await policy.stats()).pending,1);
    const source = await createFixture();
    await source.controlPlane.admitInvocation(source.principal,invocationRequest({ estimated_cost_micros: 0 }));
    const observer = createManagedLifecycleObserver({ controlPlane: source.controlPlane,store: lifecycle,auditPrincipals: [source.principal],observerId: 'role_observer' });
    try { assert.equal((await observer.runOnce()).recorded,1); } finally { await observer.close(); }
    for (const sql of [`UPDATE ${s}.telemetry_lifecycle_events SET payload='{}'`,
      `DELETE FROM ${s}.telemetry_lifecycle_checkpoints`,`DELETE FROM ${s}.telemetry_lifecycle_sweeps`,
      `DELETE FROM ${s}.telemetry_lifecycle_events`,`TRUNCATE ${s}.telemetry_lifecycle_events`,
      `UPDATE ${s}.telemetry_settings SET max_events=1`]) await assert.rejects(runtimePool.query(sql),{ code: '42501' });
    const claimToken = token(), claimed = await lifecycle.claim({ claimToken });
    await lifecycle.acknowledge({ event_ref: claimed.event.event_ref,generation: claimed.generation,claimToken,
      acknowledgement: { event_ref: claimed.event.event_ref,delivered: true } });
    await ownerPool.query(`UPDATE ${s}.telemetry_lifecycle_events SET acknowledged_ms=0`);
    await assert.rejects(prunePostgresManagedTelemetry({ ...base,pool: runtimePool,expectedOwner: owner,lifecycle: true,eventKind: 'lifecycle' }),{ code: 'TELEMETRY_RETENTION_FAILED' });
    assert.equal((await prunePostgresManagedTelemetry({ ...base,pool: ownerPool,expectedOwner: owner,lifecycle: true,eventKind: 'lifecycle' })).removed,1);
    assert.equal((await ownerPool.query(`SELECT * FROM ${s}.telemetry_lifecycle_checkpoints`)).rowCount,1);
    await admin.query(`GRANT UPDATE (payload) ON ${s}.telemetry_lifecycle_events TO ${qid(runtime)}`);
    await assert.rejects(lifecycle.stats(),{ code: 'TELEMETRY_UNAVAILABLE' });
    assert.equal((await ownerPool.query(`SELECT * FROM ${s}.telemetry_lifecycle_checkpoints`)).rowCount,1);
  } finally {
    const errors = [], cleanup = async (fn) => { try { await fn(); } catch (e) { errors.push(e); } };
    await cleanup(() => policy?.close()); await cleanup(() => lifecycle?.close());
    await cleanup(() => runtimePool?.end()); await cleanup(() => ownerPool?.end()); await cleanup(() => admin?.end());
    if (created) await cleanup(() => root.query(`DROP DATABASE ${qid(db)}`));
    await cleanup(() => root.query(`DROP ROLE IF EXISTS ${qid(runtime)}`)); await cleanup(() => root.query(`DROP ROLE IF EXISTS ${qid(owner)}`));
    await cleanup(async () => assert.equal((await root.query('SELECT 1 FROM pg_database WHERE datname=$1',[db])).rowCount,0));
    await cleanup(async () => assert.equal((await root.query('SELECT 1 FROM pg_roles WHERE rolname=ANY($1::text[])',[[owner,runtime]])).rowCount,0));
    await cleanup(() => root.end());
    if (errors.length) throw new AggregateError(errors,'Lifecycle role/database cleanup failed');
  }
});
