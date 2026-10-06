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
if (!connectionString && process.env.RISK_FORK_MANAGED_REQUIRE_POSTGRES_TESTS === '1') throw new Error('Mandatory backlog alert roles require PostgreSQL');
const skip = !connectionString;
if (connectionString) {
  const url = new URL(connectionString);
  if (!['127.0.0.1','localhost','[::1]'].includes(url.hostname) || url.pathname !== '/risk_fork_managed_test'
    || process.env.RISK_FORK_MANAGED_TEST_CONFIRM_DISPOSABLE !== 'YES_DELETE_DATA') throw new Error('Backlog alert roles require explicit disposable loopback DB');
}
const qid = (value) => { assert.match(value,/^[a-z_][a-z0-9_]*$/); return `"${value}"`; };
test('v9 backlog alerts use positive CA TLS, distinct roles and immutable outbox columns', { skip,timeout: 90000 }, async () => {
  const suffix = randomUUID().replaceAll('-','').slice(0,16), db = `alerts_role_${suffix}`, owner = `alerts_owner_${suffix}`, runtime = `alerts_runtime_${suffix}`;
  const schemaName = `alerts_${suffix}`, s = qid(schemaName), root = new pg.Pool({ connectionString });
  const url = new URL(connectionString), password = `disposable-${randomUUID()}`;
  let admin, ownerPool, runtimePool, store, delivery, created = false;
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
    const options = { schemaName,lifecycle: true,metrics: true,metricVersion: 9,backlogSettings: { maxTenants: 2 },
      backlogAlertSettings: { maxAlerts: 100,maxAlertsPerTenant: 20,rules: [{ rule_id: 'cleanup_pending_count',threshold: 2 }] },
      limits: { maxEvents: 100,maxEventsPerTenant: 100,leaseMs: 30000,retryMs: 100,retentionMs: 1000 },
      metricSettings: { maxSources: 100,maxSourcesPerTenant: 100,maxWindows: 100,maxWindowsPerTenant: 100,maxAlerts: 100,maxAlertsPerTenant: 100,
        rules: [{ rule_id: 'rate_denied',threshold: 1,window_ms: 60000 }] } };
    await migratePostgresManagedTelemetry({ ...options,pool: ownerPool,requireTls: false,disposableDb: true });
    await ownerPool.query(grants);
    for (const file of ['lifecycle-grants.sql.template','metrics-grants.sql.template','backlog-grants.sql.template','backlog-alert-grants.sql.template']) {
      await ownerPool.query(replace(await readFile(new URL('../ops/postgres/'+file,import.meta.url),'utf8')));
    }
    url.username = runtime; runtimePool = new pg.Pool({ connectionString: url.toString() });
    const ca = process.env.RISK_FORK_TEST_POSTGRES_TLS_CA; assert.equal(typeof ca,'string');
    const runtimeOptions = { ...options,connectionString: url.toString(),expectedOwner: owner,tls: { ca } };
    store = await createPostgresManagedTelemetryStore(runtimeOptions);
    delivery = await createPostgresManagedTelemetryStore({ ...runtimeOptions,eventKind: 'backlog_alert' });
    assert.equal((await store.initialize()).runtime_privileges_verified,true);
    let expected = null;
    for (const [ms,count] of [[0,2],[1,0]]) {
      const snapshot = createManagedBacklogSnapshot({ tenant_id: 'tenant_alpha',snapshot_at: new Date(Date.parse('2026-10-06T00:00:00.000Z')+ms).toISOString(),
        ...Object.fromEntries(MANAGED_BACKLOG_COUNT_FIELDS.map((key) => [key,key === 'cleanup_pending_count' ? count : 0])) });
      expected = (await store.appendBacklogSnapshot({ tenant_id: snapshot.tenant_id,observer_hash: sha256Ref('runtime observer'),expected_state: expected,snapshot })).state;
    }
    assert.equal((await store.readBacklogAlertState({ tenant_hash: lifecycleTenantHash('tenant_alpha') })).rules[0].transition,2);
    const claimToken = 'claim_'+randomUUID()+'_'+'x'.repeat(32), claim = await delivery.claim({ claimToken });
    await delivery.acknowledge({ event_ref: claim.event.event_ref,generation: claim.generation,claimToken,acknowledgement: { event_ref: claim.event.event_ref,delivered: true } });
    for (const sql of [
      `UPDATE ${s}.telemetry_backlog_alerts SET payload='{}'`, `UPDATE ${s}.telemetry_backlog_alerts SET transition=99`,
      `UPDATE ${s}.telemetry_backlog_alerts SET event_hash='${sha256Ref('bad')}'`,
      `DELETE FROM ${s}.telemetry_backlog_alerts`, `TRUNCATE ${s}.telemetry_backlog_alerts`,
      `UPDATE ${s}.telemetry_backlog_alert_state SET tenant_hash='${sha256Ref('other')}'`,
      `UPDATE ${s}.telemetry_backlog_alert_settings SET payload='{}'`,
      `UPDATE ${s}.telemetry_schema_migrations SET migration_hash='bad'`,
      `ALTER TABLE ${s}.telemetry_backlog_alerts ADD COLUMN bypass text`,
    ]) await assert.rejects(runtimePool.query(sql),{ code: '42501' });
    await assert.rejects(createPostgresManagedTelemetryStore({ ...runtimeOptions,tls: { ca: rootCertificates[0] } }),{ code: 'TELEMETRY_UNAVAILABLE' });
    await ownerPool.query(`GRANT DELETE ON ${s}.telemetry_backlog_alerts TO ${qid(runtime)}`);
    await assert.rejects(delivery.stats(),{ code: 'TELEMETRY_UNAVAILABLE' });
    assert.equal((await ownerPool.query(`SELECT count(*)::integer AS n FROM ${s}.telemetry_backlog_alerts`)).rows[0].n,2);
  } finally {
    const errors = [], cleanup = async (fn) => { try { await fn(); } catch (error) { errors.push(error); } };
    await cleanup(() => delivery?.close()); await cleanup(() => store?.close()); await cleanup(() => runtimePool?.end()); await cleanup(() => ownerPool?.end()); await cleanup(() => admin?.end());
    if (created) await cleanup(() => root.query(`DROP DATABASE ${qid(db)}`));
    for (const role of [runtime,owner]) await cleanup(() => root.query(`DROP ROLE IF EXISTS ${qid(role)}`));
    await cleanup(async () => assert.equal((await root.query('SELECT 1 FROM pg_database WHERE datname=$1',[db])).rowCount,0));
    await cleanup(async () => assert.equal((await root.query('SELECT 1 FROM pg_roles WHERE rolname=ANY($1::text[])',[[owner,runtime]])).rowCount,0));
    await cleanup(() => root.end()); if (errors.length) throw new AggregateError(errors,'Backlog alert role cleanup failed');
  }
});
