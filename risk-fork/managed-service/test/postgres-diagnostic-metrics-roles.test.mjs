import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { rootCertificates } from 'node:tls';
import pg from 'pg';
import { sha256Ref } from '../../src/canonical.mjs';
import { createManagedDiagnosticObservation } from '../src/diagnostic-event.mjs';
import { migratePostgresManagedTelemetry } from '../src/postgres-telemetry-migrator.mjs';
import { createPostgresManagedTelemetryStore } from '../src/postgres-telemetry-store.mjs';

const connectionString = process.env.RISK_FORK_MANAGED_TEST_POSTGRES_URL;
if (!connectionString && process.env.RISK_FORK_MANAGED_REQUIRE_POSTGRES_TESTS === '1') throw new Error('Mandatory diagnostic roles require PostgreSQL');
const skip = !connectionString;
if (connectionString) {
  const url = new URL(connectionString);
  if (!['127.0.0.1','localhost','[::1]'].includes(url.hostname) || url.pathname !== '/risk_fork_managed_test'
    || process.env.RISK_FORK_MANAGED_TEST_CONFIRM_DISPOSABLE !== 'YES_DELETE_DATA') throw new Error('Diagnostic roles need explicit disposable loopback DB');
}
const qid = (value) => { assert.match(value,/^[a-z_][a-z0-9_]*$/); return `"${value}"`; };
test('v10 diagnostics qualify actual positive CA TLS, separate roles and SELECT-only immutable settings', { skip,timeout: 90000 }, async () => {
  const suffix = randomUUID().replaceAll('-','').slice(0,16), db = `diag_role_${suffix}`, owner = `diag_owner_${suffix}`, runtime = `diag_runtime_${suffix}`;
  const schemaName = `diag_${suffix}`, s = qid(schemaName), root = new pg.Pool({ connectionString });
  const url = new URL(connectionString), password = `disposable-${randomUUID()}`;
  let admin,ownerPool,runtimePool,store,delivery,created = false;
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
    const diagnosticSettings = { bucket_ms: 1000,max_age_ms: 60000,max_future_ms: 1000,
      rules: [{ rule_id: 'observer_backlog_source_read_unconfirmed',threshold: 1,window_ms: 60000 }] };
    const options = { schemaName,lifecycle: true,metrics: true,metricVersion: 10,backlogSettings: { maxTenants: 2 },diagnosticSettings,
      backlogAlertSettings: { maxAlerts: 100,maxAlertsPerTenant: 20,rules: [{ rule_id: 'cleanup_pending_count',threshold: 2 }] },
      limits: { maxEvents: 100,maxEventsPerTenant: 100,leaseMs: 30000,retryMs: 100,retentionMs: 1000 },
      metricSettings: { maxSources: 100,maxSourcesPerTenant: 100,maxWindows: 100,maxWindowsPerTenant: 100,maxAlerts: 100,maxAlertsPerTenant: 100,
        rules: [{ rule_id: 'rate_denied',threshold: 1,window_ms: 60000 }] } };
    await migratePostgresManagedTelemetry({ ...options,pool: ownerPool,requireTls: false,disposableDb: true }); await ownerPool.query(grants);
    for (const file of ['lifecycle-grants.sql.template','metrics-grants.sql.template','backlog-grants.sql.template','backlog-alert-grants.sql.template','diagnostic-grants.sql.template']) {
      await ownerPool.query(replace(await readFile(new URL('../ops/postgres/'+file,import.meta.url),'utf8')));
    }
    url.username = runtime; runtimePool = new pg.Pool({ connectionString: url.toString() });
    const ca = process.env.RISK_FORK_TEST_POSTGRES_TLS_CA; assert.equal(typeof ca,'string');
    const runtimeOptions = { ...options,connectionString: url.toString(),expectedOwner: owner,tls: { ca } };
    store = await createPostgresManagedTelemetryStore(runtimeOptions); delivery = await createPostgresManagedTelemetryStore({ ...runtimeOptions,eventKind: 'alert' });
    assert.equal((await store.initialize()).runtime_privileges_verified,true);
    const event = createManagedDiagnosticObservation({ tenant_hash: sha256Ref('tenant'),observer_hash: sha256Ref('observer'),
      boundary: 'backlog_source_read',observed_ms: Date.now() },diagnosticSettings);
    await store.appendDiagnosticObservation(event); assert.equal((await store.readMetrics({ tenant_hash: event.tenant_hash })).retained_sources,1);
    const claimToken = 'claim_'+randomUUID()+'_'+'x'.repeat(32), claim = await delivery.claim({ claimToken });
    await delivery.acknowledge({ event_ref: claim.event.event_ref,generation: claim.generation,claimToken,acknowledgement: { event_ref: claim.event.event_ref,delivered: true } });
    for (const sql of [
      `UPDATE ${s}.telemetry_diagnostic_settings SET payload='{}'`, `DELETE FROM ${s}.telemetry_diagnostic_settings`,
      `INSERT INTO ${s}.telemetry_diagnostic_settings VALUES (false,'${sha256Ref('bad')}','{}')`,
      `UPDATE ${s}.telemetry_metric_sources SET payload='{}'`, `DELETE FROM ${s}.telemetry_metric_sources`,
      `UPDATE ${s}.telemetry_metric_alerts SET payload='{}'`, `TRUNCATE ${s}.telemetry_metric_alerts`,
      `ALTER TABLE ${s}.telemetry_diagnostic_settings ADD COLUMN bypass text`,
    ]) await assert.rejects(runtimePool.query(sql),{ code: '42501' });
    await assert.rejects(createPostgresManagedTelemetryStore({ ...runtimeOptions,tls: { ca: rootCertificates[0] } }),{ code: 'TELEMETRY_UNAVAILABLE' });
    await ownerPool.query(`GRANT UPDATE (payload) ON ${s}.telemetry_diagnostic_settings TO ${qid(runtime)}`);
    await assert.rejects(store.stats(),{ code: 'TELEMETRY_UNAVAILABLE' });
    assert.equal((await ownerPool.query(`SELECT count(*)::integer AS n FROM ${s}.telemetry_metric_sources`)).rows[0].n,1);
  } finally {
    const errors = [], cleanup = async (fn) => { try { await fn(); } catch (error) { errors.push(error); } };
    await cleanup(() => delivery?.close()); await cleanup(() => store?.close()); await cleanup(() => runtimePool?.end()); await cleanup(() => ownerPool?.end()); await cleanup(() => admin?.end());
    if (created) await cleanup(() => root.query(`DROP DATABASE ${qid(db)}`));
    for (const role of [runtime,owner]) await cleanup(() => root.query(`DROP ROLE IF EXISTS ${qid(role)}`));
    await cleanup(async () => assert.equal((await root.query('SELECT 1 FROM pg_database WHERE datname=$1',[db])).rowCount,0));
    await cleanup(async () => assert.equal((await root.query('SELECT 1 FROM pg_roles WHERE rolname=ANY($1::text[])',[[owner,runtime]])).rowCount,0));
    await cleanup(() => root.end()); if (errors.length) throw new AggregateError(errors,'Diagnostic role cleanup failed');
  }
});
