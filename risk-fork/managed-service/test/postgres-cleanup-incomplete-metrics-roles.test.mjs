import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { rootCertificates } from 'node:tls';
import pg from 'pg';
import { sha256Ref } from '../../src/canonical.mjs';
import { createManagedAuditEvent, verifyManagedAuditWindow } from '../src/audit.mjs';
import { lifecycleTenantHash } from '../src/lifecycle-event.mjs';
import { createPostgresManagedTelemetryStore } from '../src/postgres-telemetry-store.mjs';
import { migratePostgresManagedTelemetry } from '../src/postgres-telemetry-migrator.mjs';

const connectionString = process.env.RISK_FORK_MANAGED_TEST_POSTGRES_URL;
if (!connectionString && process.env.RISK_FORK_MANAGED_REQUIRE_POSTGRES_TESTS === '1') throw new Error('Mandatory cleanup metrics role tests require PostgreSQL');
const skip = !connectionString;
if (connectionString) {
  const url = new URL(connectionString);
  if (!['127.0.0.1','localhost','[::1]'].includes(url.hostname) || url.pathname !== '/risk_fork_managed_test'
    || process.env.RISK_FORK_MANAGED_TEST_CONFIRM_DISPOSABLE !== 'YES_DELETE_DATA') throw new Error('Cleanup metrics roles require explicit disposable loopback DB');
}
const qid = (value) => { assert.match(value, /^[a-z_][a-z0-9_]*$/); return `"${value}"`; };
const limits = { maxEvents: 100, maxEventsPerTenant: 100, leaseMs: 1000, retryMs: 200, retentionMs: 1000 };
const metricSettings = { maxSources: 100, maxSourcesPerTenant: 100, maxWindows: 100, maxWindowsPerTenant: 100,
  maxAlerts: 100, maxAlertsPerTenant: 100, rules: [
    { rule_id: 'cleanup_incomplete_observed', threshold: 1, window_ms: 60_000 },
    { rule_id: 'recovery_absence_verified', threshold: 1, window_ms: 60_000 },
  ] };
const tenantHash = lifecycleTenantHash('tenant_alpha');

function historicalPacket(label, observer, ref) {
  const event = createManagedAuditEvent({ event_ref: `evt_${ref}`, tenant_id: 'tenant_alpha', invocation_ref: ref,
    sequence: 1, event_type: label, occurred_at: '2026-09-05T12:00:00.000Z', details: {}, prior_event_hash: null });
  const anchor = { tenant_id: 'tenant_alpha', invocation_ref: ref, audit_event_count: 1,
    audit_head_hash: event.event_hash, prior_event: null, events: [event] };
  return { scope: { observer_hash: sha256Ref(observer), tenant_hash: tenantHash }, tenant_id: 'tenant_alpha',
    expected_sweep: null, expected_checkpoint: null,
    page: { tenant_id: 'tenant_alpha', upper_ref: ref, invocations: [{ invocation_ref: ref,
      audit_event_count: 1, audit_head_hash: event.event_hash }], complete: true, next_after_ref: ref },
    window: verifyManagedAuditWindow(anchor, { tenant_id: 'tenant_alpha', invocation_ref: ref,
      after_sequence: 0, prior_event_hash: null, limit: 64 }) };
}

test('v7 cleanup metrics use pinned CA, exact grants and immutable catalog custody', { skip, timeout: 90_000 }, async () => {
  const suffix = randomUUID().replaceAll('-', '').slice(0, 16), db = `incomplete_role_${suffix}`;
  const owner = `cleanup_owner_${suffix}`, runtime = `cleanup_runtime_${suffix}`;
  const schemaName = `cleanup_${suffix}`, s = qid(schemaName), root = new pg.Pool({ connectionString });
  const url = new URL(connectionString), password = `disposable-${randomUUID()}`;
  let admin, ownerPool, runtimePool, lifecycle, alerts, created = false;
  try {
    await root.query(`CREATE DATABASE ${qid(db)}`); created = true;
    admin = new pg.Pool({ connectionString: (() => { const value = new URL(connectionString); value.pathname = `/${db}`; return value.toString(); })() });
    await admin.query(`CREATE ROLE ${qid(owner)} LOGIN NOINHERIT PASSWORD '${password}'`);
    await admin.query(`CREATE ROLE ${qid(runtime)} LOGIN NOINHERIT PASSWORD '${password}'`);
    const replace = (text) => text.replaceAll('__TELEMETRY_DATABASE__', qid(db)).replaceAll('__TELEMETRY_SCHEMA__', s)
      .replaceAll('__TELEMETRY_MIGRATOR__', qid(owner)).replaceAll('__TELEMETRY_RUNTIME__', qid(runtime));
    const [bootstrap, grants] = replace(await readFile(new URL('../ops/postgres/telemetry-roles.sql.template', import.meta.url), 'utf8'))
      .split('-- Dedicated migrator AFTER migratePostgresManagedTelemetry:');
    await admin.query(bootstrap);
    url.pathname = `/${db}`; url.username = owner; url.password = password;
    ownerPool = new pg.Pool({ connectionString: url.toString() });
    const options = { schemaName, limits, lifecycle: true, metrics: true, metricVersion: 7, metricSettings };
    await migratePostgresManagedTelemetry({ ...options, pool: ownerPool, requireTls: false, disposableDb: true });
    await ownerPool.query(grants);
    for (const file of ['lifecycle-grants.sql.template','metrics-grants.sql.template']) {
      await ownerPool.query(replace(await readFile(new URL('../ops/postgres/' + file, import.meta.url), 'utf8')));
    }
    url.username = runtime; runtimePool = new pg.Pool({ connectionString: url.toString() });
    const ca = process.env.RISK_FORK_TEST_POSTGRES_TLS_CA; assert.equal(typeof ca, 'string');
    const runtimeOptions = { ...options, connectionString: url.toString(), expectedOwner: owner, tls: { ca } };
    lifecycle = await createPostgresManagedTelemetryStore({ ...runtimeOptions, eventKind: 'lifecycle' });
    alerts = await createPostgresManagedTelemetryStore({ ...runtimeOptions, eventKind: 'alert' });
    assert.equal((await lifecycle.initialize()).runtime_privileges_verified, true);
    assert.equal((await alerts.initialize()).runtime_privileges_verified, true);
    await lifecycle.appendLifecycleWindow(historicalPacket('cleanup_incomplete', 'cleanup observer', 'rfi_cleanup'));
    await lifecycle.appendLifecycleWindow(historicalPacket('recovery_absence_verified', 'recovery observer', 'rfi_recovery'));
    const metrics = await lifecycle.readMetrics({ tenant_hash: tenantHash });
    assert.deepEqual(metrics.windows.map((row) => row.rule_id).sort(), ['cleanup_incomplete_observed','recovery_absence_verified']);
    assert.deepEqual(metrics.windows.map((row) => row.count).sort(), [1, 1]);
    assert.equal(metrics.production_qualified, false);
    assert.equal(metrics.coverage, 'ingested_observations_only');
    for (const sql of [
      `UPDATE ${s}.telemetry_lifecycle_events SET payload='{}'`,
      `UPDATE ${s}.telemetry_metric_sources SET payload='{}'`,
      `DELETE FROM ${s}.telemetry_metric_sources`,
      `TRUNCATE ${s}.telemetry_metric_windows`,
      `UPDATE ${s}.telemetry_metric_settings SET payload='{}'`,
      `UPDATE ${s}.telemetry_schema_migrations SET migration_hash='bad'`,
      `ALTER TABLE ${s}.telemetry_metric_windows ADD COLUMN bypass text`,
    ]) await assert.rejects(runtimePool.query(sql), { code: '42501' });
    await assert.rejects(createPostgresManagedTelemetryStore({ ...runtimeOptions, tls: { ca: rootCertificates[0] } }), { code: 'TELEMETRY_UNAVAILABLE' });
    await ownerPool.query(`ALTER TABLE ${s}.telemetry_metric_windows DROP CONSTRAINT telemetry_metric_windows_rule_id_check`);
    await assert.rejects(alerts.stats(), { code: 'TELEMETRY_UNAVAILABLE' });
  } finally {
    const errors = [], cleanup = async (fn) => { try { await fn(); } catch (error) { errors.push(error); } };
    await cleanup(() => lifecycle?.close()); await cleanup(() => alerts?.close());
    await cleanup(() => runtimePool?.end()); await cleanup(() => ownerPool?.end()); await cleanup(() => admin?.end());
    if (created) await cleanup(() => root.query(`DROP DATABASE ${qid(db)}`));
    for (const role of [runtime, owner]) await cleanup(() => root.query(`DROP ROLE IF EXISTS ${qid(role)}`));
    await cleanup(async () => assert.equal((await root.query('SELECT 1 FROM pg_database WHERE datname=$1', [db])).rowCount, 0));
    await cleanup(async () => assert.equal((await root.query('SELECT 1 FROM pg_roles WHERE rolname=ANY($1::text[])', [[owner, runtime]])).rowCount, 0));
    await cleanup(() => root.end());
    if (errors.length) throw new AggregateError(errors, 'Cleanup metrics role cleanup failed');
  }
});
