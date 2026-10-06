import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { rootCertificates } from 'node:tls';
import pg from 'pg';
import { sha256Ref } from '../../src/canonical.mjs';
import { createManagedBacklogSnapshot, MANAGED_BACKLOG_COUNT_FIELDS } from '../src/backlog-snapshot.mjs';
import { lifecycleTenantHash } from '../src/lifecycle-event.mjs';
import { migratePostgresManagedTelemetry } from '../src/postgres-telemetry-migrator.mjs';
import { createPostgresManagedTelemetryStore } from '../src/postgres-telemetry-store.mjs';

const connectionString = process.env.RISK_FORK_MANAGED_TEST_POSTGRES_URL;
if (!connectionString && process.env.RISK_FORK_MANAGED_REQUIRE_POSTGRES_TESTS === '1') throw new Error('Mandatory backlog gauge roles require PostgreSQL');
const skip = !connectionString;
if (connectionString) {
  const url = new URL(connectionString);
  if (!['127.0.0.1','localhost','[::1]'].includes(url.hostname) || url.pathname !== '/risk_fork_managed_test'
    || process.env.RISK_FORK_MANAGED_TEST_CONFIRM_DISPOSABLE !== 'YES_DELETE_DATA') throw new Error('Backlog roles require explicit disposable loopback DB');
}
const qid = (value) => { assert.match(value,/^[a-z_][a-z0-9_]*$/); return `"${value}"`; };
test('v8 latest gauges use pinned CA, separate runtime and exact column-only grants', { skip,timeout: 90000 }, async () => {
  const suffix = randomUUID().replaceAll('-','').slice(0,16), db = `backlog_role_${suffix}`, owner = `backlog_owner_${suffix}`, runtime = `backlog_runtime_${suffix}`;
  const schemaName = `backlog_${suffix}`, s = qid(schemaName), root = new pg.Pool({ connectionString });
  const url = new URL(connectionString), password = `disposable-${randomUUID()}`;
  let admin, ownerPool, runtimePool, store, created = false;
  try {
    await root.query(`CREATE DATABASE ${qid(db)}`); created = true;
    const adminUrl = new URL(connectionString); adminUrl.pathname = `/${db}`; admin = new pg.Pool({ connectionString: adminUrl.toString() });
    await admin.query(`CREATE ROLE ${qid(owner)} LOGIN NOINHERIT PASSWORD '${password}'`);
    await admin.query(`CREATE ROLE ${qid(runtime)} LOGIN NOINHERIT PASSWORD '${password}'`);
    const replace = (text) => text.replaceAll('__TELEMETRY_DATABASE__',qid(db)).replaceAll('__TELEMETRY_SCHEMA__',s)
      .replaceAll('__TELEMETRY_MIGRATOR__',qid(owner)).replaceAll('__TELEMETRY_RUNTIME__',qid(runtime));
    const [bootstrap,grants] = replace(await readFile(new URL('../ops/postgres/telemetry-roles.sql.template',import.meta.url),'utf8'))
      .split('-- Dedicated migrator AFTER migratePostgresManagedTelemetry:');
    await admin.query(bootstrap);
    url.pathname = `/${db}`; url.username = owner; url.password = password; ownerPool = new pg.Pool({ connectionString: url.toString() });
    const options = { schemaName,lifecycle: true,metrics: true,metricVersion: 8,backlogSettings: { maxTenants: 2 },
      limits: { maxEvents: 100,maxEventsPerTenant: 100,leaseMs: 1000,retryMs: 100,retentionMs: 1000 },
      metricSettings: { maxSources: 100,maxSourcesPerTenant: 100,maxWindows: 100,maxWindowsPerTenant: 100,maxAlerts: 100,maxAlertsPerTenant: 100,
        rules: [{ rule_id: 'rate_denied',threshold: 1,window_ms: 60000 }] } };
    await migratePostgresManagedTelemetry({ ...options,pool: ownerPool,requireTls: false,disposableDb: true });
    await ownerPool.query(grants);
    for (const file of ['lifecycle-grants.sql.template','metrics-grants.sql.template','backlog-grants.sql.template']) {
      await ownerPool.query(replace(await readFile(new URL('../ops/postgres/'+file,import.meta.url),'utf8')));
    }
    url.username = runtime; runtimePool = new pg.Pool({ connectionString: url.toString() });
    const ca = process.env.RISK_FORK_TEST_POSTGRES_TLS_CA; assert.equal(typeof ca,'string');
    const runtimeOptions = { ...options,connectionString: url.toString(),expectedOwner: owner,tls: { ca } };
    store = await createPostgresManagedTelemetryStore(runtimeOptions);
    assert.equal((await store.initialize()).runtime_privileges_verified,true);
    let expected = null;
    for (const ms of [0,1]) {
      const snapshot = createManagedBacklogSnapshot({ tenant_id: 'tenant_alpha',snapshot_at: new Date(Date.parse('2026-10-06T00:00:00.000Z')+ms).toISOString(),
        ...Object.fromEntries(MANAGED_BACKLOG_COUNT_FIELDS.map((key,i) => [key,i+ms])) });
      expected = (await store.appendBacklogSnapshot({ tenant_id: snapshot.tenant_id,observer_hash: sha256Ref('runtime observer'),expected_state: expected,snapshot })).state;
      assert.deepEqual(await store.readBacklogGauge({ tenant_hash: lifecycleTenantHash('tenant_alpha') }),expected);
    }
    assert.equal(expected.generation,2); assert.equal(expected.production_qualified,false);
    for (const sql of [
      `UPDATE ${s}.telemetry_backlog_state SET tenant_hash='${sha256Ref('other')}'`,
      `DELETE FROM ${s}.telemetry_backlog_state`, `TRUNCATE ${s}.telemetry_backlog_state`,
      `INSERT INTO ${s}.telemetry_backlog_settings VALUES (false,'${sha256Ref('bad')}','{}')`,
      `UPDATE ${s}.telemetry_backlog_settings SET payload='{}'`,
      `UPDATE ${s}.telemetry_schema_migrations SET migration_hash='bad'`,
      `UPDATE ${s}.telemetry_metric_settings SET payload='{}'`,
      `ALTER TABLE ${s}.telemetry_backlog_state ADD COLUMN bypass text`,
    ]) await assert.rejects(runtimePool.query(sql),{ code: '42501' });
    await assert.rejects(createPostgresManagedTelemetryStore({ ...runtimeOptions,tls: { ca: rootCertificates[0] } }),{ code: 'TELEMETRY_UNAVAILABLE' });
    await ownerPool.query(`GRANT DELETE ON ${s}.telemetry_backlog_state TO ${qid(runtime)}`);
    await assert.rejects(store.readBacklogGauge({ tenant_hash: lifecycleTenantHash('tenant_alpha') }),{ code: 'TELEMETRY_UNAVAILABLE' });
    assert.equal((await ownerPool.query(`SELECT count(*)::integer AS n FROM ${s}.telemetry_backlog_state`)).rows[0].n,1);
  } finally {
    const errors = [], cleanup = async (fn) => { try { await fn(); } catch (error) { errors.push(error); } };
    await cleanup(() => store?.close()); await cleanup(() => runtimePool?.end()); await cleanup(() => ownerPool?.end()); await cleanup(() => admin?.end());
    if (created) await cleanup(() => root.query(`DROP DATABASE ${qid(db)}`));
    for (const role of [runtime,owner]) await cleanup(() => root.query(`DROP ROLE IF EXISTS ${qid(role)}`));
    await cleanup(async () => assert.equal((await root.query('SELECT 1 FROM pg_database WHERE datname=$1',[db])).rowCount,0));
    await cleanup(async () => assert.equal((await root.query('SELECT 1 FROM pg_roles WHERE rolname=ANY($1::text[])',[[owner,runtime]])).rowCount,0));
    await cleanup(() => root.end()); if (errors.length) throw new AggregateError(errors,'Backlog gauge role cleanup failed');
  }
});
