import { acquirePostgresAuthorityClient, createPostgresAuthorityPool } from '../../src/adapters/postgres-authority-migrator.mjs';
import { checkTelemetrySignal, normalizeTelemetryOptions, telemetryDbInteger, telemetryMigration, verifyTelemetrySettings } from './postgres-telemetry-config.mjs';
import { verifyPostgresManagedTelemetryAttestation } from './postgres-telemetry-attestation.mjs';
import { managedError, requireInteger } from './validation.mjs';

// Explicit owner maintenance, never scheduled by the runtime or exposed over
// HTTP. Capacity retains unresolved obligations indefinitely; only terminal
// acknowledgements beyond the configured retention are eligible for deletion.
export async function prunePostgresManagedTelemetry(options) {
  const config = normalizeTelemetryOptions(options,['maxDelete','signal']);
  if (config.expectedOwner === undefined) throw new TypeError('Retention requires the exact separate owner');
  const maxDelete = requireInteger(options.maxDelete ?? 100,'maxDelete',{ min: 1, max: 1000 });
  const migration = await telemetryMigration(config.schemaName), signal = options.signal;
  checkTelemetrySignal(signal);
  const owned = options.pool == null;
  const pool = options.pool ?? await createPostgresAuthorityPool({ connectionString: options.connectionString,
    requireTls: config.requireTls,tls: options.tls,maxConnections: options.maxConnections ?? 2,
    connectionTimeoutMs: options.connectionTimeoutMs,statementTimeoutMs: config.statementTimeoutMs,
    applicationName: 'risk-fork-telemetry-retention' });
  try {
    const client = await acquirePostgresAuthorityClient(pool,{ requireTls: config.requireTls });
    try {
      await client.query('BEGIN');
      try {
        await client.query('SET LOCAL synchronous_commit = on');
        await client.query(`SET LOCAL statement_timeout = ${config.statementTimeoutMs}`);
        await client.query(`SET LOCAL lock_timeout = ${config.statementTimeoutMs}`);
        await client.query(`SET LOCAL idle_in_transaction_session_timeout = ${config.statementTimeoutMs}`);
        const ownership = await client.query(`SELECT current_user=$2 AND session_user=$2 AND
          n.nspowner=(SELECT oid FROM pg_catalog.pg_roles WHERE rolname=$2) AND NOT EXISTS (
          SELECT 1 FROM pg_catalog.pg_class c WHERE c.relnamespace=n.oid AND c.relowner<>n.nspowner) AS allowed
          FROM pg_catalog.pg_namespace n WHERE n.nspname=$1`,[config.schemaName,config.expectedOwner]);
        if (ownership.rowCount !== 1 || ownership.rows[0].allowed !== true) throw new TypeError('Retention owner mismatch');
        await verifyPostgresManagedTelemetryAttestation(client,{ schemaName: config.schemaName });
        const s = config.quotedSchema;
        const clock = await client.query(`SELECT last_seen_ms FROM ${s}.telemetry_clock WHERE singleton=true FOR UPDATE`);
        if (clock.rowCount !== 1) throw new TypeError('Missing telemetry clock');
        await verifyPostgresManagedTelemetryAttestation(client,{ schemaName: config.schemaName });
        await verifyTelemetrySettings(client,config,migration.hash);
        const sample = await client.query('SELECT floor(extract(epoch FROM clock_timestamp()) * 1000)::bigint AS now_ms');
        const now = telemetryDbInteger(sample.rows[0]?.now_ms), prior = telemetryDbInteger(clock.rows[0].last_seen_ms);
        if (sample.rowCount !== 1 || now < prior) throw new TypeError('Telemetry clock regressed');
        checkTelemetrySignal(signal);
        await client.query(`UPDATE ${s}.telemetry_clock SET last_seen_ms=$1 WHERE singleton=true`,[now]);
        const removed = await client.query(`DELETE FROM ${s}.telemetry_events WHERE event_ref IN (
          SELECT event_ref FROM ${s}.telemetry_events WHERE state='acked' AND acknowledged_ms <= $1
          ORDER BY acknowledged_ms,event_ref LIMIT $2 FOR UPDATE) RETURNING event_ref`,[now-config.limits.retentionMs,maxDelete]);
        checkTelemetrySignal(signal); await client.query('COMMIT'); checkTelemetrySignal(signal);
        return Object.freeze({ removed: removed.rowCount,production_qualified: false });
      } catch (error) { await client.query('ROLLBACK').catch(() => {}); throw error; }
    } finally { client.release(); }
  } catch {
    checkTelemetrySignal(signal);
    throw managedError('Telemetry retention unavailable','TELEMETRY_RETENTION_FAILED',503);
  } finally { if (owned) await pool.end().catch(() => {}); }
}
