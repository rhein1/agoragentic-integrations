import { acquirePostgresAuthorityClient, createPostgresAuthorityPool } from '../../src/adapters/postgres-authority-migrator.mjs';
import { executionMetricsMigration, lifecycleMigration, metricsMigration, normalizeTelemetryOptions, telemetryDbInteger, telemetryMigration, verifyTelemetrySettings } from './postgres-telemetry-config.mjs';
import { verifyPostgresManagedTelemetryAttestation } from './postgres-telemetry-attestation.mjs';
import { managedError } from './validation.mjs';
import { metricSettingsHash } from './metric-event.mjs';
import { baselineMetricSources, metricTotalsHash, verifyMetricTotals } from './postgres-metric-state.mjs';

export async function migratePostgresManagedTelemetry(options = {}) {
  const config = normalizeTelemetryOptions(options), migration = await telemetryMigration(config.schemaName);
  // expectedOwner belongs to runtime-role attestation, which must reject the
  // migration owner itself. Never silently turn that request into catalog-only.
  if (options.expectedOwner !== undefined) throw new TypeError('expectedOwner is runtime-only; attest the separately provisioned store');
  const owned = options.pool == null;
  const pool = options.pool ?? await createPostgresAuthorityPool({ connectionString: options.connectionString,
    requireTls: config.requireTls, tls: options.tls, maxConnections: options.maxConnections ?? 2,
    connectionTimeoutMs: options.connectionTimeoutMs, statementTimeoutMs: config.statementTimeoutMs,
    applicationName: 'risk-fork-telemetry-migrator' });
  try {
    const client = await acquirePostgresAuthorityClient(pool, { requireTls: config.requireTls });
    try {
      await client.query('BEGIN');
      try {
        await client.query('SET LOCAL synchronous_commit = on');
        await client.query(`SET LOCAL statement_timeout = ${config.statementTimeoutMs}`);
        await client.query(`SET LOCAL lock_timeout = ${config.statementTimeoutMs}`);
        await client.query('SELECT pg_advisory_xact_lock(1380338246, 309)');
        const s = config.quotedSchema;
        const existing = await client.query('SELECT oid FROM pg_catalog.pg_namespace WHERE nspname=$1', [config.schemaName]);
        if (existing.rowCount === 0) {
          await client.query(`CREATE SCHEMA ${s}`); await client.query(migration.sql);
          await client.query(`INSERT INTO ${s}.telemetry_schema_migrations VALUES (1,$1)`, [migration.hash]);
          const l = config.limits;
          await client.query(`INSERT INTO ${s}.telemetry_settings VALUES (true,$1,$2,$3,$4,$5,$6)`,
            [config.settingsHash,l.maxEvents,l.maxEventsPerTenant,l.leaseMs,l.retryMs,l.retentionMs]);
        } else if (existing.rowCount !== 1) throw new TypeError('Ambiguous telemetry schema');
        if (config.lifecycle) {
          const ledger = await client.query(`SELECT version FROM ${s}.telemetry_schema_migrations ORDER BY version`);
          if (ledger.rowCount === 1) {
            // Attest the complete old catalog/ledger/settings BEFORE upgrade.
            // Neither frozen source nor drifted fixtures are repaired in place.
            await verifyPostgresManagedTelemetryAttestation(client,{ schemaName: config.schemaName });
            await verifyTelemetrySettings(client,{ ...config,lifecycle: false,metrics: false,metricVersion: undefined },migration.hash);
            const extension = await lifecycleMigration(config.schemaName);
            await client.query(extension.sql);
            await client.query(`INSERT INTO ${s}.telemetry_schema_migrations VALUES (2,$1)`,[extension.hash]);
          }
        }
        if (config.metrics) {
          const ledger = await client.query(`SELECT version FROM ${s}.telemetry_schema_migrations ORDER BY version`);
          if (ledger.rowCount === 2) {
            await verifyPostgresManagedTelemetryAttestation(client,{ schemaName: config.schemaName,lifecycle: true });
            await verifyTelemetrySettings(client,{ ...config,metrics: false,metricVersion: undefined },migration.hash);
            const extension = await metricsMigration(config.schemaName);
            await client.query(extension.sql);
            await client.query(`INSERT INTO ${s}.telemetry_schema_migrations VALUES (3,$1)`,[extension.hash]);
            await client.query(`INSERT INTO ${s}.telemetry_metric_settings VALUES (true,$1,$2)`,[metricSettingsHash(config.metricSettings),config.metricSettings]);
            await client.query(`INSERT INTO ${s}.telemetry_metric_totals VALUES (true,0,0,$1)`,[metricTotalsHash(0,0)]);
            const clock = await client.query(`SELECT last_seen_ms FROM ${s}.telemetry_clock WHERE singleton=true FOR UPDATE`);
            const sample = await client.query('SELECT floor(extract(epoch FROM clock_timestamp()) * 1000)::bigint AS now_ms');
            const now = telemetryDbInteger(sample.rows[0]?.now_ms);
            if (clock.rowCount !== 1 || sample.rowCount !== 1 || now < telemetryDbInteger(clock.rows[0].last_seen_ms)) throw new TypeError('Metric baseline clock drift');
            await baselineMetricSources(client,config,now);
            await client.query(`UPDATE ${s}.telemetry_clock SET last_seen_ms=$1 WHERE singleton=true`,[now]);
          }
        }
        if (config.metricVersion === 4) {
          const ledger = await client.query(`SELECT version FROM ${s}.telemetry_schema_migrations ORDER BY version`);
          if (ledger.rowCount === 3) {
            // The settings hash also binds every retained contribution/window.
            // Never rewrite it to enable a new rule in an existing v3 history.
            await verifyPostgresManagedTelemetryAttestation(client,{ schemaName: config.schemaName,lifecycle: true,metrics: true });
            await verifyTelemetrySettings(client,{ ...config,metricVersion: 3 },migration.hash);
            await verifyMetricTotals(client,config);
            const extension = await executionMetricsMigration(config.schemaName);
            await client.query(extension.sql);
            await client.query(`INSERT INTO ${s}.telemetry_schema_migrations VALUES (4,$1)`,[extension.hash]);
          }
        }
        await verifyPostgresManagedTelemetryAttestation(client, { schemaName: config.schemaName,lifecycle: config.lifecycle,metrics: config.metrics,metricVersion: config.metricVersion });
        await verifyTelemetrySettings(client, config, migration.hash);
        await verifyMetricTotals(client,config);
        await client.query('COMMIT');
      } catch (error) { await client.query('ROLLBACK').catch(() => {}); throw error; }
      return Object.freeze({ schema_name: config.schemaName, migration_version: config.metrics ? config.metricVersion : config.lifecycle ? 2 : 1, migration_hash: migration.hash,
        settings_hash: config.settingsHash, runtime_privileges_verified: false, production_qualified: false });
    } finally { client.release(); }
  } catch { throw managedError('Telemetry migration unavailable or drifted', 'TELEMETRY_MIGRATION_FAILED', 503); }
  finally { if (owned) await pool.end().catch(() => {}); }
}
