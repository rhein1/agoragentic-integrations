import { acquirePostgresAuthorityClient, createPostgresAuthorityPool } from '../../src/adapters/postgres-authority-migrator.mjs';
import { backlogAlertsMigration, backlogGaugesMigration, budgetMetricsMigration, cleanupIncompleteMetricsMigration, cleanupMetricsMigration, diagnosticMetricsMigration, executionMetricsMigration, lifecycleMigration, metricsMigration, normalizeTelemetryOptions, telemetryDbInteger, telemetryMigration, verifyTelemetrySettings } from './postgres-telemetry-config.mjs';
import { verifyPostgresManagedTelemetryAttestation } from './postgres-telemetry-attestation.mjs';
import { managedError } from './validation.mjs';
import { metricSettingsHash } from './metric-event.mjs';
import { baselineMetricSources, metricTotalsHash, verifyMetricTotals } from './postgres-metric-state.mjs';
import { backlogSettingsHash, backlogTotalsHash } from './backlog-gauge.mjs';
import { verifyBacklogCustody } from './postgres-backlog-gauge-state.mjs';
import { backlogAlertSettingsHash, backlogAlertTotalsHash } from './backlog-alert.mjs';
import { baselineBacklogAlerts, verifyBacklogAlertCustody } from './postgres-backlog-alert-state.mjs';
import { diagnosticSettingsHash } from './diagnostic-event.mjs';
import { workerDiagnosticSettingsHash } from './worker-diagnostic-event.mjs';
import { workerDiagnosticMetricsMigration } from './postgres-telemetry-config.mjs';

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
        if (config.metricVersion >= 4) {
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
        if (config.metricVersion >= 5) {
          const ledger = await client.query(`SELECT version FROM ${s}.telemetry_schema_migrations ORDER BY version`);
          if (ledger.rowCount === 4) {
            // Existing settings remain byte-equivalent in meaning. Adding the
            // new rule to existing v3/v4 custody fails before this DDL.
            await verifyPostgresManagedTelemetryAttestation(client,{ schemaName: config.schemaName,lifecycle: true,metrics: true,metricVersion: 4 });
            await verifyTelemetrySettings(client,{ ...config,metricVersion: 4 },migration.hash);
            await verifyMetricTotals(client,config);
            const extension = await budgetMetricsMigration(config.schemaName);
            await client.query(extension.sql);
            await client.query(`INSERT INTO ${s}.telemetry_schema_migrations VALUES (5,$1)`,[extension.hash]);
          }
        }
        if (config.metricVersion >= 6) {
          const ledger = await client.query(`SELECT version FROM ${s}.telemetry_schema_migrations ORDER BY version`);
          if (ledger.rowCount === 5) {
            // Existing settings remain byte-equivalent in meaning. Adding the
            // new cleanup rules to existing v5 custody fails before this DDL.
            await verifyPostgresManagedTelemetryAttestation(client,{ schemaName: config.schemaName,lifecycle: true,metrics: true,metricVersion: 5 });
            await verifyTelemetrySettings(client,{ ...config,metricVersion: 5 },migration.hash);
            await verifyMetricTotals(client,config);
            const extension = await cleanupMetricsMigration(config.schemaName);
            await client.query(extension.sql);
            await client.query(`INSERT INTO ${s}.telemetry_schema_migrations VALUES (6,$1)`,[extension.hash]);
          }
        }
        if (config.metricVersion >= 7) {
          const ledger = await client.query(`SELECT version FROM ${s}.telemetry_schema_migrations ORDER BY version`);
          if (ledger.rowCount === 6) {
            // Exact prior settings/custody are immutable, even for an empty v6
            // schema. This adds catalog vocabulary, never a rule-set rewrite.
            await verifyPostgresManagedTelemetryAttestation(client,{ schemaName: config.schemaName,lifecycle: true,metrics: true,metricVersion: 6 });
            await verifyTelemetrySettings(client,{ ...config,metricVersion: 6 },migration.hash);
            await verifyMetricTotals(client,config);
            const extension = await cleanupIncompleteMetricsMigration(config.schemaName);
            await client.query(extension.sql);
            await client.query(`INSERT INTO ${s}.telemetry_schema_migrations VALUES (7,$1)`,[extension.hash]);
          }
        }
        if (config.metricVersion >= 8) {
          const ledger = await client.query(`SELECT version FROM ${s}.telemetry_schema_migrations ORDER BY version`);
          if (ledger.rowCount === 7) {
            await verifyPostgresManagedTelemetryAttestation(client,{ schemaName: config.schemaName,lifecycle: true,metrics: true,metricVersion: 7 });
            await verifyTelemetrySettings(client,{ ...config,metricVersion: 7 },migration.hash);
            await verifyMetricTotals(client,config);
            const extension = await backlogGaugesMigration(config.schemaName);
            await client.query(extension.sql);
            await client.query(`INSERT INTO ${s}.telemetry_schema_migrations VALUES (8,$1)`,[extension.hash]);
            await client.query(`INSERT INTO ${s}.telemetry_backlog_settings VALUES (true,$1,$2)`,[backlogSettingsHash(config.backlogSettings),config.backlogSettings]);
            await client.query(`INSERT INTO ${s}.telemetry_backlog_totals VALUES (true,0,$1)`,[backlogTotalsHash(0)]);
          }
        }
        if (config.metricVersion >= 9) {
          const ledger = await client.query(`SELECT version FROM ${s}.telemetry_schema_migrations ORDER BY version`);
          if (ledger.rowCount === 8) {
            await verifyPostgresManagedTelemetryAttestation(client,{ schemaName: config.schemaName,lifecycle: true,metrics: true,metricVersion: 8 });
            await verifyTelemetrySettings(client,{ ...config,metricVersion: 8 },migration.hash);
            await verifyMetricTotals(client,config); await verifyBacklogCustody(client,config);
            const extension = await backlogAlertsMigration(config.schemaName);
            await client.query(extension.sql);
            await client.query(`INSERT INTO ${s}.telemetry_schema_migrations VALUES (9,$1)`,[extension.hash]);
            await client.query(`INSERT INTO ${s}.telemetry_backlog_alert_settings VALUES (true,$1,$2)`,[backlogAlertSettingsHash(config.backlogAlertSettings),config.backlogAlertSettings]);
            await client.query(`INSERT INTO ${s}.telemetry_backlog_alert_totals VALUES (true,0,$1)`,[backlogAlertTotalsHash(0)]);
            // Retain existing gauges exactly; no stale/historical alert backfill.
            // Only the next successful new source view evaluates v9 conditions.
            await baselineBacklogAlerts(client,config);
          }
        }
        if (config.metricVersion >= 10) {
          const ledger = await client.query(`SELECT version FROM ${s}.telemetry_schema_migrations ORDER BY version`);
          if (ledger.rowCount === 9) {
            const previous = { ...config,metricVersion: 9,diagnosticSettings: undefined };
            await verifyPostgresManagedTelemetryAttestation(client,{ schemaName: config.schemaName,lifecycle: true,metrics: true,metricVersion: 9 });
            await verifyTelemetrySettings(client,previous,migration.hash);
            await verifyMetricTotals(client,previous); await verifyBacklogCustody(client,previous); await verifyBacklogAlertCustody(client,previous);
            const extension = await diagnosticMetricsMigration(config.schemaName);
            await client.query(extension.sql);
            await client.query(`INSERT INTO ${s}.telemetry_schema_migrations VALUES (10,$1)`,[extension.hash]);
            await client.query(`INSERT INTO ${s}.telemetry_diagnostic_settings VALUES (true,$1,$2)`,[diagnosticSettingsHash(config.diagnosticSettings),config.diagnosticSettings]);
            // No inferred historical observations or prior settings/hash rewrite.
          }
        }
        if (config.metricVersion === 11) {
          const ledger = await client.query(`SELECT version FROM ${s}.telemetry_schema_migrations ORDER BY version`);
          if (ledger.rowCount === 10) {
            const previous = { ...config,metricVersion: 10,workerDiagnosticSettings: undefined };
            await verifyPostgresManagedTelemetryAttestation(client,{ schemaName: config.schemaName,lifecycle: true,metrics: true,metricVersion: 10 });
            await verifyTelemetrySettings(client,previous,migration.hash);
            await verifyMetricTotals(client,previous); await verifyBacklogCustody(client,previous); await verifyBacklogAlertCustody(client,previous);
            const extension = await workerDiagnosticMetricsMigration(config.schemaName);
            await client.query(extension.sql);
            await client.query(`INSERT INTO ${s}.telemetry_schema_migrations VALUES (11,$1)`,[extension.hash]);
            await client.query(`INSERT INTO ${s}.telemetry_worker_diagnostic_settings VALUES (true,$1,$2)`,[workerDiagnosticSettingsHash(config.workerDiagnosticSettings),config.workerDiagnosticSettings]);
          }
        }
        await verifyPostgresManagedTelemetryAttestation(client, { schemaName: config.schemaName,lifecycle: config.lifecycle,metrics: config.metrics,metricVersion: config.metricVersion });
        await verifyTelemetrySettings(client, config, migration.hash);
        await verifyMetricTotals(client,config);
        await verifyBacklogCustody(client,config);
        await verifyBacklogAlertCustody(client,config);
        await client.query('COMMIT');
      } catch (error) { await client.query('ROLLBACK').catch(() => {}); throw error; }
      return Object.freeze({ schema_name: config.schemaName, migration_version: config.metrics ? config.metricVersion : config.lifecycle ? 2 : 1, migration_hash: migration.hash,
        settings_hash: config.settingsHash, runtime_privileges_verified: false, production_qualified: false });
    } finally { client.release(); }
  } catch { throw managedError('Telemetry migration unavailable or drifted', 'TELEMETRY_MIGRATION_FAILED', 503); }
  finally { if (owned) await pool.end().catch(() => {}); }
}
