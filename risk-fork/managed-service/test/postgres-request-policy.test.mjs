import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import pg from 'pg';
import { quotePostgresAuthorityIdentifier as qid } from '../../src/adapters/postgres-authority-migrator.mjs';
import { sha256Ref } from '../../src/canonical.mjs';
import { createManagedRequestPolicy } from '../src/request-policy.mjs';
import { migratePostgresManagedRequestPolicy } from '../src/postgres-request-policy-migrator.mjs';
import { createPostgresManagedRequestPolicyStore, PostgresManagedRequestPolicyStore } from '../src/postgres-request-policy-store.mjs';
import { normalizeRequestQuotas, policyDbInteger, policySubjectHash, POLICY_ROUTES, requestPolicyMigration, requestQuotaWindow } from '../src/postgres-request-policy-config.mjs';

const quotas = Object.fromEntries(POLICY_ROUTES.map((route) => [route, { windowMs: 3_600_000, perKey: 3, perTenant: 5, maxSubjects: 20 }]));
const connectionString = process.env.RISK_FORK_MANAGED_TEST_POSTGRES_URL;
let skip = 'Explicit disposable loopback risk_fork_managed_test database required';
try {
  const url = new URL(connectionString);
  if (['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname) && url.pathname === '/risk_fork_managed_test'
    && process.env.RISK_FORK_MANAGED_TEST_CONFIRM_DISPOSABLE === 'YES_DELETE_DATA') skip = false;
} catch { /* Never choose an unreviewed database. */ }
if (skip && process.env.RISK_FORK_MANAGED_REQUIRE_POSTGRES_TESTS === '1') throw new Error(skip);

test('durable policy rejects malformed quotas, unsafe integer data and production/TLS laundering', async () => {
  const normalized = normalizeRequestQuotas(quotas);
  assert.equal(Object.isFrozen(normalized.cleanup), true);
  for (const q of [{}, { ...quotas, extra: quotas.read }, { ...quotas, read: { ...quotas.read, perKey: 0 } },
    { ...quotas, read: { ...quotas.read, windowMs: 999 } }, { ...quotas, read: { ...quotas.read, maxSubjects: 1 } }]) {
    assert.throws(() => normalizeRequestQuotas(q));
  }
  for (const value of [null, undefined, true, '-1', '01', '1.0', 1.5, '9007199254740992']) assert.throws(() => policyDbInteger(value));
  assert.notEqual(policySubjectHash('key', 'tenant_one', 'same'), policySubjectHash('key', 'tenant_two', 'same'));
  assert.deepEqual(requestQuotaWindow(0, 60_000), { start: 0, retry: 60 });
  assert.deepEqual(requestQuotaWindow(59_999, 60_000), { start: 0, retry: 1 });
  assert.deepEqual(requestQuotaWindow(60_000, 60_000), { start: 60_000, retry: 60 });
  assert.deepEqual(requestQuotaWindow(3_599_999, 3_600_000), { start: 0, retry: 1 });
  assert.throws(() => requestQuotaWindow(Number.MAX_SAFE_INTEGER, 1000));
  const pool = { connect: async () => { throw new Error('private DSN/credential'); } };
  assert.throws(() => new PostgresManagedRequestPolicyStore({ pool, quotas }), /disposable non-TLS/);
  await assert.rejects(createPostgresManagedRequestPolicyStore({ pool, quotas, deploymentMode: 'production' }), { code: 'POLICY_NOT_QUALIFIED' });
  const store = new PostgresManagedRequestPolicyStore({ pool, quotas, requireTls: false, disposableDb: true });
  await assert.rejects(store.readControl(), (e) => e.code === 'POLICY_UNAVAILABLE' && !e.message.includes('private'));
  const abort = new AbortController(); abort.abort();
  await assert.rejects(store.readControl(abort.signal), { code: 'REQUEST_TIMEOUT' });
  await store.close(); await store.close();
  await assert.rejects(store.readControl(), { code: 'POLICY_UNAVAILABLE' });
});

test('abort waits for in-flight SQL rollback; late/unknown commit never returns an allow', async () => {
  const hash = (await requestPolicyMigration('risk_fork_request_policy')).hash;
  for (const point of ['write', 'commit']) {
    const abort = new AbortController(), events = [];
    let releaseWrite, entered;
    const gate = new Promise((resolve) => { releaseWrite = resolve; });
    const atWrite = new Promise((resolve) => { entered = resolve; });
    const client = {
      async query(sql) {
        events.push(sql);
        if (sql.startsWith('SELECT last_seen_ms')) return { rowCount: 1, rows: [{ last_seen_ms: '0' }] };
        if (sql.includes("current_setting('server_version_num')")) return { rowCount: 1, rows: [{ version: 160015, fsync: 'on', sync: 'on', triggers: 'origin' }] };
        if (sql.startsWith('SELECT version, migration_hash')) return { rowCount: 1, rows: [{ version: 1, migration_hash: hash }] };
        if (sql.startsWith('SELECT enabled')) return { rowCount: 1, rows: [{ enabled: true, epoch: '0', policy_hash: sha256Ref(normalizeRequestQuotas(quotas)) }] };
        if (sql.startsWith('SELECT route_class, window_ms')) return { rowCount: 5, rows: POLICY_ROUTES.map((route_class) => ({ route_class,
          window_ms: quotas[route_class].windowMs, per_key: 3, per_tenant: 5, max_subjects: 20 })) };
        if (sql.startsWith('SELECT floor')) return { rowCount: 1, rows: [{ now_ms: '1700000000000' }] };
        if (sql.startsWith('SELECT route_class FROM')) return { rowCount: 1, rows: [{ route_class: 'admission' }] };
        if (sql.startsWith('SELECT subject_kind')) return { rowCount: 0, rows: [] };
        if (sql.startsWith('SELECT count')) return { rowCount: 1, rows: [{ subjects: 0 }] };
        if (sql.startsWith('INSERT INTO') && point === 'write') { entered(); await gate; }
        if (sql === 'COMMIT' && point === 'commit') { abort.abort(); throw new Error('private unknown commit'); }
        return { rowCount: 1, rows: [] };
      },
      release() { events.push('released'); },
    };
    const store = new PostgresManagedRequestPolicyStore({ pool: { connect: async () => client }, quotas, requireTls: false, disposableDb: true });
    const pending = store.consumeRateLimit({ tenant_id: 'tenant_abort', key_id: 'key_abort', route_class: 'admission', signal: abort.signal });
    const rejected = assert.rejects(pending, { code: 'REQUEST_TIMEOUT' });
    if (point === 'write') {
      await atWrite; abort.abort(); await new Promise((resolve) => setImmediate(resolve));
      assert.equal(events.includes('released'), false); releaseWrite();
    }
    await rejected;
    assert.equal(events.at(-2), 'ROLLBACK'); assert.equal(events.at(-1), 'released');
    if (point === 'write') assert.equal(events.includes('COMMIT'), false);
    else assert.equal(events.filter((sql) => sql.startsWith('INSERT INTO')).length, 2);
    await store.close();
  }
});

test('durable policy real PostgreSQL multi-instance, restart, quotas, disable and failures', { skip, timeout: 90_000 }, async (t) => {
  const schemaName = `policy_test_${randomUUID().replaceAll('-', '')}`, s = qid(schemaName);
  const pool = new pg.Pool({ connectionString, max: 8 });
  const options = { pool, schemaName, quotas, requireTls: false, disposableDb: true, statementTimeoutMs: 200 };
  const stores = [];
  try {
    const migrated = await migratePostgresManagedRequestPolicy(options);
    assert.equal(migrated.production_qualified, false);
    assert.deepEqual(await migratePostgresManagedRequestPolicy(options), migrated);
    const a = await createPostgresManagedRequestPolicyStore(options), b = await createPostgresManagedRequestPolicyStore(options);
    stores.push(a, b);
    assert.deepEqual(await a.readControl(), { enabled: false, epoch: 0 });
    const report = await a.initialize();
    assert.equal(report.exact_catalog_verified, false); assert.equal(report.runtime_privileges_verified, false);
    const input = { tenant_id: 'tenant_alpha', key_id: 'key_alpha', route_class: 'admission' };
    const maintain = async (run) => {
      const client = await pool.connect();
      try {
        await client.query('BEGIN'); await client.query(`SELECT last_seen_ms FROM ${s}.request_policy_clock FOR UPDATE`);
        const result = await run(client); await client.query('COMMIT'); return result;
      } catch (error) { await client.query('ROLLBACK'); throw error; }
      finally { client.release(); }
    };
    const enable = (enabled, expectedEpoch) => maintain(async (client) => {
      const epoch = expectedEpoch ?? Number((await client.query(`SELECT epoch FROM ${s}.request_policy_control`)).rows[0].epoch);
      return client.query(`UPDATE ${s}.request_policy_control SET enabled=$1, epoch=epoch+1 WHERE singleton=true AND epoch=$2 RETURNING enabled,epoch`, [enabled, epoch]);
    });
    const wrap = (store, overrides = {}) => createManagedRequestPolicy({ readControl: (signal) => store.readControl(signal),
      consumeRateLimit: (request) => store.consumeRateLimit(request), emitTelemetry: async () => {}, ...overrides });
    const principal = { key_id: input.key_id, tenant_id: input.tenant_id, scopes: ['invocations:write'] };

    if (process.env.RISK_FORK_TEST_POSTGRES_TLS_CA) {
      await t.test('factory-owned CA-verified TLS survives initialization and later checkout', async () => {
        const secure = await createPostgresManagedRequestPolicyStore({ connectionString, schemaName, quotas,
          tls: { ca: process.env.RISK_FORK_TEST_POSTGRES_TLS_CA }, requireTls: true });
        try { assert.deepEqual(await secure.readControl(), { enabled: false, epoch: 0 }); }
        finally { await secure.close(); await secure.close(); }
        await assert.rejects(createPostgresManagedRequestPolicyStore({ connectionString, schemaName, quotas,
          tls: { ca: 'invalid certificate authority' }, requireTls: true }), { code: 'POLICY_UNAVAILABLE' });
      });
    }
    await t.test('partial schemas are rejected without adding or repairing tables', async () => {
      const partial = `${schemaName}_p`, quoted = qid(partial);
      await pool.query(`CREATE SCHEMA ${quoted}; CREATE TABLE ${quoted}.request_policy_control (singleton boolean)`);
      try {
        await assert.rejects(migratePostgresManagedRequestPolicy({ ...options, schemaName: partial }));
        const tables = await pool.query('SELECT tablename FROM pg_tables WHERE schemaname=$1', [partial]);
        assert.deepEqual(tables.rows.map((r) => r.tablename), ['request_policy_control']);
      } finally { await pool.query(`DROP SCHEMA ${quoted} CASCADE`); }
    });

    await t.test('default-off execution and independent cleanup/recovery capacity', async () => {
      await assert.rejects(wrap(a).beforeMutation({ principal, routeClass: 'execution' }), { code: 'MANAGED_SERVICE_DISABLED' });
      for (const routeClass of ['cleanup', 'recovery', 'read']) await wrap(a).beforeMutation({ principal, routeClass });
      const execution = await pool.query(`SELECT 1 FROM ${s}.request_policy_subjects WHERE route_class='execution'`);
      assert.equal(execution.rowCount, 0); await enable(true);
    });
    await t.test('two independent instances charge both scopes all-or-neither', async () => {
      const results = await Promise.all(Array.from({ length: 12 }, (_, i) => (i % 2 ? a : b).consumeRateLimit(input)));
      assert.equal(results.filter((r) => r.allowed).length, 3);
      assert.ok(results.filter((r) => !r.allowed).every((r) => r.retry_after_seconds >= 1 && r.retry_after_seconds <= 3600));
      const second = { ...input, key_id: 'key_beta' };
      assert.equal((await a.consumeRateLimit(second)).allowed, true);
      assert.equal((await b.consumeRateLimit(second)).allowed, true);
      assert.equal((await b.consumeRateLimit(second)).allowed, false);
      const other = { ...input, tenant_id: 'tenant_beta' };
      assert.equal((await a.consumeRateLimit(other)).allowed, true);
      const rows = (await pool.query(`SELECT subject_kind, subject_hash, used FROM ${s}.request_policy_subjects WHERE route_class='admission'`)).rows;
      assert.equal(rows.find((r) => r.subject_hash === policySubjectHash('tenant', input.tenant_id)).used, 5);
      assert.equal(rows.find((r) => r.subject_hash === policySubjectHash('key', input.tenant_id, input.key_id)).used, 3);
      assert.ok(rows.every((r) => /^sha256:[a-f0-9]{64}$/.test(r.subject_hash)));
      assert.equal(JSON.stringify(rows).includes('tenant_alpha'), false);
      assert.equal((await a.consumeRateLimit({ ...input, route_class: 'cleanup' })).allowed, true);
      const distinct = await Promise.all(Array.from({ length: 12 }, (_, i) => (i % 2 ? a : b).consumeRateLimit({ ...input,
        tenant_id: 'tenant_parallel', key_id: `key_parallel_${i}`, route_class: 'execution' })));
      assert.equal(distinct.filter((r) => r.allowed).length, 5);
      const tenantUsed = await pool.query(`SELECT used FROM ${s}.request_policy_subjects WHERE route_class='execution' AND subject_kind='tenant' AND subject_hash=$1`,
        [policySubjectHash('tenant', 'tenant_parallel')]);
      assert.equal(tenantUsed.rows[0].used, 5);
    });
    await t.test('fresh store instances retain quota and control epoch', async () => {
      await a.close(); const restarted = await createPostgresManagedRequestPolicyStore(options); stores.push(restarted);
      assert.equal((await restarted.consumeRateLimit(input)).allowed, false);
      await enable(false); assert.deepEqual(await restarted.readControl(), { enabled: false, epoch: 2 });
      assert.equal((await enable(true, 1)).rowCount, 0); // stale owner CAS grants nothing
      await assert.rejects(wrap(restarted).beforeMutation({ principal, routeClass: 'admission' }), { code: 'MANAGED_SERVICE_DISABLED' });
      await assert.rejects(pool.query(`UPDATE ${s}.request_policy_control SET enabled=true WHERE singleton=true`));
      for (const change of ['epoch=epoch+2', `epoch=epoch+1,policy_hash='sha256:${'0'.repeat(64)}'`, 'epoch=epoch+1,singleton=false']) {
        await assert.rejects(maintain((client) => client.query(`UPDATE ${s}.request_policy_control SET ${change}`)));
      }
      await enable(true);
      let changed = false;
      const raced = wrap(restarted, { consumeRateLimit: async (request) => { const result = await restarted.consumeRateLimit(request); if (!changed) { changed = true; await enable(false); } return result; } });
      await assert.rejects(raced.beforeMutation({ principal, routeClass: 'execution' }), { code: 'POLICY_EPOCH_CHANGED' });
    });
    await t.test('capacity bounds reclaim expired windows without refunding a live scope', async () => {
      // All owner fixture mutations hold the same first lock as runtime.
      const setup = await pool.connect();
      try {
        await setup.query('BEGIN'); await setup.query(`SELECT last_seen_ms FROM ${s}.request_policy_clock FOR UPDATE`);
        const clock = Number((await setup.query('SELECT floor(extract(epoch FROM clock_timestamp())*1000)::bigint AS n')).rows[0].n);
        const start = Math.floor(clock / quotas.read.windowMs) * quotas.read.windowMs;
        for (let i = 0; i < 18; i += 1) await setup.query(`INSERT INTO ${s}.request_policy_subjects VALUES ('read','key',$1,$2,1)`, [policySubjectHash('key', 'tenant_fixture', `fixture_${i}`), start]);
        await setup.query('COMMIT');
      } finally { setup.release(); }
      assert.equal((await b.consumeRateLimit({ ...input, tenant_id: 'tenant_fresh', key_id: 'key_fresh', route_class: 'read' })).allowed, false);
      await maintain((client) => client.query(`UPDATE ${s}.request_policy_subjects SET bucket_start_ms=bucket_start_ms-$1 WHERE route_class='read'`, [quotas.read.windowMs]));
      assert.equal((await b.consumeRateLimit({ ...input, tenant_id: 'tenant_fresh', key_id: 'key_fresh', route_class: 'read' })).allowed, true);
      assert.equal((await pool.query(`SELECT count(*)::integer AS n FROM ${s}.request_policy_subjects WHERE route_class='read'`)).rows[0].n, 2);
    });
    await t.test('clock rollback across routes/control reads denies and rolls back', async () => {
      const before = (await pool.query(`SELECT last_seen_ms FROM ${s}.request_policy_clock`)).rows[0].last_seen_ms;
      const counters = JSON.stringify((await pool.query(`SELECT * FROM ${s}.request_policy_subjects ORDER BY route_class,subject_kind,subject_hash`)).rows);
      await maintain((client) => client.query(`UPDATE ${s}.request_policy_clock SET last_seen_ms=9007199254740991`));
      await assert.rejects(b.readControl(), { code: 'POLICY_UNAVAILABLE' });
      for (const route_class of POLICY_ROUTES) await assert.rejects(b.consumeRateLimit({ ...input, route_class }), { code: 'POLICY_UNAVAILABLE' });
      assert.equal(JSON.stringify((await pool.query(`SELECT * FROM ${s}.request_policy_subjects ORDER BY route_class,subject_kind,subject_hash`)).rows), counters);
      assert.equal((await pool.query(`SELECT last_seen_ms FROM ${s}.request_policy_clock`)).rows[0].last_seen_ms, '9007199254740991');
      // Disposable fault-fixture restoration only, never runtime time rollback.
      await maintain((client) => client.query(`UPDATE ${s}.request_policy_clock SET last_seen_ms=$1`, [before]));
    });
    await t.test('lock timeout, abort and backend loss never allow or partially charge', async () => {
      const blocker = await pool.connect();
      const before = JSON.stringify((await pool.query(`SELECT * FROM ${s}.request_policy_subjects ORDER BY route_class,subject_kind,subject_hash`)).rows);
      try {
        await blocker.query('BEGIN'); await blocker.query(`SELECT last_seen_ms FROM ${s}.request_policy_clock FOR UPDATE`);
        await assert.rejects(b.consumeRateLimit({ ...input, route_class: 'execution' }), { code: 'POLICY_UNAVAILABLE' });
        const abort = new AbortController(); const pending = b.consumeRateLimit({ ...input, route_class: 'execution', signal: abort.signal });
        const rejected = assert.rejects(pending, { code: 'REQUEST_TIMEOUT' }); abort.abort();
        await blocker.query('ROLLBACK'); await rejected;
      } finally { await blocker.query('ROLLBACK'); blocker.release(); }
      assert.equal(JSON.stringify((await pool.query(`SELECT * FROM ${s}.request_policy_subjects ORDER BY route_class,subject_kind,subject_hash`)).rows), before);
      const lost = new pg.Pool({ connectionString });
      const lostStore = await createPostgresManagedRequestPolicyStore({ ...options, pool: lost });
      await lost.end(); await assert.rejects(lostStore.readControl(), { code: 'POLICY_UNAVAILABLE' }); await lostStore.close();
      // Fault-inject an error on the second INSERT: the first (tenant) write
      // must roll back, not leave a torn per-tenant/per-key charge.
      await maintain((client) => client.query(`CREATE FUNCTION ${s}.policy_test_fail_key() RETURNS trigger LANGUAGE plpgsql
        AS $$ BEGIN IF NEW.subject_kind='key' THEN RAISE EXCEPTION 'synthetic key write loss'; END IF; RETURN NEW; END $$;
        CREATE TRIGGER policy_test_fail_key BEFORE INSERT ON ${s}.request_policy_subjects FOR EACH ROW EXECUTE FUNCTION ${s}.policy_test_fail_key()`));
      try {
        await assert.rejects(b.consumeRateLimit({ tenant_id: 'tenant_torn', key_id: 'key_torn', route_class: 'recovery' }), { code: 'POLICY_UNAVAILABLE' });
        assert.equal((await pool.query(`SELECT 1 FROM ${s}.request_policy_subjects WHERE subject_hash=ANY($1::text[])`,
          [[policySubjectHash('tenant', 'tenant_torn'), policySubjectHash('key', 'tenant_torn', 'key_torn')]])).rowCount, 0);
      } finally {
        await maintain((client) => client.query(`DROP TRIGGER policy_test_fail_key ON ${s}.request_policy_subjects; DROP FUNCTION ${s}.policy_test_fail_key()`));
      }
    });
    await t.test('migration/config/counter drift rejects without automatic repair', async () => {
      await pool.query(`UPDATE ${s}.request_policy_schema_migrations SET migration_hash=$1`, [`sha256:${'0'.repeat(64)}`]);
      await assert.rejects(b.initialize(), { code: 'POLICY_UNAVAILABLE' });
      await pool.query(`UPDATE ${s}.request_policy_schema_migrations SET migration_hash=$1`, [migrated.migration_hash]);
      await pool.query(`UPDATE ${s}.request_policy_routes SET per_key=per_key+1 WHERE route_class='read'`);
      await assert.rejects(b.readControl(), { code: 'POLICY_UNAVAILABLE' });
      await pool.query(`UPDATE ${s}.request_policy_routes SET per_key=per_key-1 WHERE route_class='read'`);
      await pool.query(`UPDATE ${s}.request_policy_subjects SET used=1000000 WHERE route_class='cleanup'`);
      await assert.rejects(b.consumeRateLimit({ ...input, route_class: 'cleanup' }), { code: 'POLICY_UNAVAILABLE' });
      assert.equal((await pool.query(`SELECT min(used) AS n FROM ${s}.request_policy_subjects WHERE route_class='cleanup'`)).rows[0].n, 1_000_000);
    });
  } finally {
    for (const store of stores) await store.close();
    await pool.query(`DROP SCHEMA IF EXISTS ${s} CASCADE`);
    assert.equal((await pool.query('SELECT 1 FROM pg_namespace WHERE nspname=$1', [schemaName])).rowCount, 0);
    await pool.end();
  }
});

test('dedicated policy runtime grants consume quotas but cannot change control/configuration', { skip, timeout: 90_000 }, async () => {
  const suffix = randomUUID().replaceAll('-', '').slice(0, 16);
  const db = `policy_role_${suffix}`, owner = `policy_owner_${suffix}`, runtime = `policy_runtime_${suffix}`, schemaName = `policy_${suffix}`;
  const root = new pg.Pool({ connectionString }), child = new URL(connectionString); child.pathname = `/${db}`;
  const admin = new pg.Pool({ connectionString: child.toString() });
  let created = false, ownerPool, runtimePool;
  const password = `disposable-${randomUUID()}`;
  try {
    await root.query(`CREATE DATABASE ${qid(db)}`); created = true;
    await admin.query(`CREATE ROLE ${qid(owner)} LOGIN NOINHERIT PASSWORD '${password}'`);
    await admin.query(`CREATE ROLE ${qid(runtime)} LOGIN NOINHERIT PASSWORD '${password}'`);
    const source = await readFile(new URL('../ops/postgres/request-policy-roles.sql.template', import.meta.url), 'utf8');
    const template = source.replaceAll('__POLICY_DATABASE__', qid(db)).replaceAll('__POLICY_SCHEMA__', qid(schemaName))
      .replaceAll('__POLICY_MIGRATOR__', qid(owner)).replaceAll('__POLICY_RUNTIME__', qid(runtime));
    const [bootstrap, grants] = template.split('-- Dedicated migrator AFTER migratePostgresManagedRequestPolicy:');
    await admin.query(bootstrap);
    const url = new URL(child); url.username = owner; url.password = password;
    ownerPool = new pg.Pool({ connectionString: url.toString() });
    const options = { schemaName, quotas, requireTls: false, disposableDb: true };
    await migratePostgresManagedRequestPolicy({ ...options, pool: ownerPool });
    await ownerPool.query(grants);
    url.username = runtime; runtimePool = new pg.Pool({ connectionString: url.toString() });
    const store = await createPostgresManagedRequestPolicyStore({ ...options, pool: runtimePool });
    assert.equal((await store.consumeRateLimit({ tenant_id: 'tenant_role', key_id: 'key_role', route_class: 'cleanup' })).allowed, true);
    for (const sql of [`UPDATE ${qid(schemaName)}.request_policy_control SET enabled=true,epoch=epoch+1`,
      `UPDATE ${qid(schemaName)}.request_policy_routes SET per_key=100`,
      `DELETE FROM ${qid(schemaName)}.request_policy_schema_migrations`,
      `TRUNCATE ${qid(schemaName)}.request_policy_subjects`,
      `CREATE TABLE ${qid(schemaName)}.forbidden (id integer)`]) await assert.rejects(runtimePool.query(sql), { code: '42501' });
    await store.close();
  } finally {
    if (runtimePool) await runtimePool.end(); if (ownerPool) await ownerPool.end(); await admin.end();
    if (created) { await root.query('SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname=$1', [db]); await root.query(`DROP DATABASE ${qid(db)}`); }
    await root.query(`DROP ROLE IF EXISTS ${qid(runtime)}`); await root.query(`DROP ROLE IF EXISTS ${qid(owner)}`);
    assert.equal((await root.query('SELECT 1 FROM pg_database WHERE datname=$1', [db])).rowCount, 0);
    assert.equal((await root.query('SELECT 1 FROM pg_roles WHERE rolname=ANY($1::text[])', [[owner, runtime]])).rowCount, 0);
    await root.end();
  }
});
