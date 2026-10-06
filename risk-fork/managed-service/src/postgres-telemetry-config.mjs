import { readFile } from 'node:fs/promises';
import { canonicalize, sha256Ref } from '../../src/canonical.mjs';
import { quotePostgresAuthorityIdentifier } from '../../src/adapters/postgres-authority-migrator.mjs';
import { assertAllowedKeys, assertPlainRecord, deepFreeze, managedError, requireInteger } from './validation.mjs';
import { policyDbInteger, checkPolicySignal } from './postgres-request-policy-config.mjs';
import { metricSettingsHash, normalizeMetricSettings } from './metric-event.mjs';
import { normalizeBacklogSettings } from './backlog-gauge.mjs';
import { normalizeBacklogAlertSettings } from './backlog-alert.mjs';
import { diagnosticSettingsHash, normalizeDiagnosticSettings } from './diagnostic-event.mjs';

export { policyDbInteger as telemetryDbInteger, checkPolicySignal as checkTelemetrySignal };
export const TELEMETRY_TABLES = Object.freeze(['telemetry_clock','telemetry_events','telemetry_schema_migrations','telemetry_settings']);
export const TELEMETRY_INSERT_COLUMNS = Object.freeze(['event_ref','event_hash','event','route_class','status','outcome',
  'duration_ms','tenant_hash','key_hash','created_ms']);
export const TELEMETRY_UPDATE_COLUMNS = Object.freeze(['state','generation','attempts','claim_hash','lease_expires_ms',
  'next_attempt_ms','acknowledged_ms','acknowledgement_hash','last_error_code']);
export const LIFECYCLE_TABLES = Object.freeze(['telemetry_lifecycle_checkpoints','telemetry_lifecycle_events','telemetry_lifecycle_sweeps']);
export const LIFECYCLE_INSERT_COLUMNS = Object.freeze(['event_ref','event_hash','tenant_hash','invocation_hash','source_sequence','payload','created_ms']);
export const METRIC_TABLES = Object.freeze(['telemetry_metric_alerts','telemetry_metric_settings','telemetry_metric_sources','telemetry_metric_totals','telemetry_metric_windows']);
export const METRIC_ALERT_INSERT_COLUMNS = Object.freeze(['event_ref','event_hash','tenant_hash','payload','created_ms']);
export const METRIC_SOURCE_INSERT_COLUMNS = Object.freeze(['source_kind','event_ref','event_hash','tenant_hash','payload','state_hash']);
export const METRIC_WINDOW_INSERT_COLUMNS = Object.freeze(['tenant_hash','rule_id','window_start_ms','payload','state_hash']);
export const BACKLOG_TABLES = Object.freeze(['telemetry_backlog_settings','telemetry_backlog_state','telemetry_backlog_totals']);
export const BACKLOG_ALERT_TABLES = Object.freeze(['telemetry_backlog_alert_settings','telemetry_backlog_alert_state','telemetry_backlog_alert_totals','telemetry_backlog_alerts']);
export const BACKLOG_ALERT_INSERT_COLUMNS = Object.freeze(['event_ref','event_hash','tenant_hash','rule_id','episode','transition','payload','created_ms']);
export const DIAGNOSTIC_TABLES = Object.freeze(['telemetry_diagnostic_settings']);

export function normalizeTelemetryLimits(value) {
  assertPlainRecord(value, 'telemetry limits');
  assertAllowedKeys(value, ['maxEvents','maxEventsPerTenant','leaseMs','retryMs','retentionMs'], 'telemetry limits');
  const maxEvents = requireInteger(value.maxEvents, 'maxEvents', { min: 1, max: 1_000_000 });
  return deepFreeze({ maxEvents,
    maxEventsPerTenant: requireInteger(value.maxEventsPerTenant, 'maxEventsPerTenant', { min: 1, max: maxEvents }),
    leaseMs: requireInteger(value.leaseMs, 'leaseMs', { min: 100, max: 30_000 }),
    retryMs: requireInteger(value.retryMs, 'retryMs', { min: 100, max: 60_000 }),
    retentionMs: requireInteger(value.retentionMs, 'retentionMs', { min: 1000, max: 604_800_000 }) });
}

export function normalizeTelemetryOptions(options, extraKeys = []) {
  assertPlainRecord(options, 'PostgreSQL telemetry options');
  assertAllowedKeys(options, ['pool','connectionString','schemaName','requireTls','tls','maxConnections',
    'connectionTimeoutMs','statementTimeoutMs','deploymentMode','disposableDb','limits','expectedOwner','lifecycle','eventKind','metrics','metricSettings','metricVersion','backlogSettings','backlogAlertSettings','diagnosticSettings', ...extraKeys], 'PostgreSQL telemetry options');
  const lifecycle = options.lifecycle ?? false, metrics = options.metrics ?? false, eventKind = options.eventKind ?? 'policy';
  if (typeof lifecycle !== 'boolean' || typeof metrics !== 'boolean' || !['policy','lifecycle','alert','backlog_alert'].includes(eventKind)
    || (eventKind === 'lifecycle' && !lifecycle) || (metrics && !lifecycle) || (['alert','backlog_alert'].includes(eventKind) && !metrics)) throw new TypeError('Invalid telemetry version selection');
  if (!metrics && options.metricSettings !== undefined) throw new TypeError('Metric settings require explicit metrics=true');
  if (!metrics && options.metricVersion !== undefined) throw new TypeError('Metric version requires explicit metrics=true');
  const metricVersion = metrics ? (options.metricVersion ?? 3) : undefined;
  if (metrics && ![3,4,5,6,7,8,9,10].includes(metricVersion)) throw new TypeError('Invalid metric version');
  if (![8,9,10].includes(metricVersion) && options.backlogSettings !== undefined) throw new TypeError('Backlog settings require explicit metricVersion=8 or later');
  const backlogSettings = metricVersion >= 8 ? normalizeBacklogSettings(options.backlogSettings) : undefined;
  if (![9,10].includes(metricVersion) && (options.backlogAlertSettings !== undefined || eventKind === 'backlog_alert')) throw new TypeError('Backlog alerts require explicit metricVersion=9 or later');
  const backlogAlertSettings = metricVersion >= 9 ? normalizeBacklogAlertSettings(options.backlogAlertSettings) : undefined;
  if (metricVersion !== 10 && options.diagnosticSettings !== undefined) throw new TypeError('Diagnostics require explicit metricVersion=10');
  const diagnosticSettings = metricVersion === 10 ? normalizeDiagnosticSettings(options.diagnosticSettings) : undefined;
  const metricSettings = metrics ? normalizeMetricSettings(options.metricSettings) : undefined;
  if (metricVersion === 3 && metricSettings.rules.some((rule) => rule.rule_id === 'execution_failure_observed')) {
    throw new TypeError('Execution failure metrics require explicit metricVersion=4');
  }
  if (metrics && metricVersion < 5 && metricSettings.rules.some((rule) => rule.rule_id === 'budget_denied')) {
    throw new TypeError('Budget denial metrics require explicit metricVersion=5');
  }
  if (metrics && metricVersion < 6 && metricSettings.rules.some((rule) => ['cleanup_verified','recovery_absence_verified'].includes(rule.rule_id))) {
    throw new TypeError('Cleanup verification metrics require explicit metricVersion=6');
  }
  if (metrics && metricVersion < 7 && metricSettings.rules.some((rule) => rule.rule_id === 'cleanup_incomplete_observed')) {
    throw new TypeError('Incomplete cleanup metrics require explicit metricVersion=7');
  }
  if ((options.deploymentMode ?? 'local_test') !== 'local_test') {
    throw managedError('Telemetry is source-only local_test', 'TELEMETRY_NOT_QUALIFIED', 503);
  }
  const requireTls = options.requireTls ?? true;
  if (typeof requireTls !== 'boolean') throw new TypeError('requireTls must be boolean');
  if (!requireTls && options.disposableDb !== true) throw new TypeError('TLS bypass requires disposableDb=true');
  if (options.pool != null && options.connectionString != null) throw new TypeError('Provide pool or connectionString, not both');
  if (options.pool != null && (requireTls || typeof options.pool.connect !== 'function')) throw new TypeError('Injected pools require disposable non-TLS local testing');
  const schemaName = options.schemaName ?? 'risk_fork_telemetry';
  const quotedSchema = quotePostgresAuthorityIdentifier(schemaName);
  if (options.expectedOwner !== undefined) quotePostgresAuthorityIdentifier(options.expectedOwner);
  const limits = normalizeTelemetryLimits(options.limits);
  return Object.freeze({ schemaName, quotedSchema, limits, settingsHash: sha256Ref(limits), requireTls,lifecycle,eventKind,metrics,metricSettings,metricVersion,backlogSettings,backlogAlertSettings,diagnosticSettings,
    expectedOwner: options.expectedOwner,
    statementTimeoutMs: requireInteger(options.statementTimeoutMs ?? 2000, 'statementTimeoutMs', { min: 100, max: 30_000 }) });
}

export async function telemetryMigration(schemaName) {
  const source = (await readFile(new URL('../migrations/005_managed_telemetry.pg.sql', import.meta.url), 'utf8')).replace(/\r\n?/g, '\n');
  return Object.freeze({ hash: sha256Ref(source), sql: source.replaceAll('__RISK_FORK_TELEMETRY_SCHEMA__', quotePostgresAuthorityIdentifier(schemaName)) });
}
export async function lifecycleMigration(schemaName) {
  const source = (await readFile(new URL('../migrations/006_managed_lifecycle.pg.sql', import.meta.url), 'utf8')).replace(/\r\n?/g, '\n');
  return Object.freeze({ hash: sha256Ref(source),sql: source.replaceAll('__RISK_FORK_TELEMETRY_SCHEMA__',quotePostgresAuthorityIdentifier(schemaName)) });
}
export async function metricsMigration(schemaName) {
  const source = (await readFile(new URL('../migrations/007_managed_metrics_alerts.pg.sql',import.meta.url),'utf8')).replace(/\r\n?/g,'\n');
  return Object.freeze({ hash: sha256Ref(source),sql: source.replaceAll('__RISK_FORK_TELEMETRY_SCHEMA__',quotePostgresAuthorityIdentifier(schemaName)) });
}
export async function executionMetricsMigration(schemaName) {
  const source = (await readFile(new URL('../migrations/009_managed_execution_metrics.pg.sql',import.meta.url),'utf8')).replace(/\r\n?/g,'\n');
  return Object.freeze({ hash: sha256Ref(source),sql: source.replaceAll('__RISK_FORK_TELEMETRY_SCHEMA__',quotePostgresAuthorityIdentifier(schemaName)) });
}
export async function budgetMetricsMigration(schemaName) {
  const source = (await readFile(new URL('../migrations/010_managed_budget_metrics.pg.sql',import.meta.url),'utf8')).replace(/\r\n?/g,'\n');
  return Object.freeze({ hash: sha256Ref(source),sql: source.replaceAll('__RISK_FORK_TELEMETRY_SCHEMA__',quotePostgresAuthorityIdentifier(schemaName)) });
}
export async function cleanupMetricsMigration(schemaName) {
  const source = (await readFile(new URL('../migrations/011_managed_cleanup_metrics.pg.sql',import.meta.url),'utf8')).replace(/\r\n?/g,'\n');
  return Object.freeze({ hash: sha256Ref(source),sql: source.replaceAll('__RISK_FORK_TELEMETRY_SCHEMA__',quotePostgresAuthorityIdentifier(schemaName)) });
}
export async function cleanupIncompleteMetricsMigration(schemaName) {
  const source = (await readFile(new URL('../migrations/012_managed_cleanup_incomplete_metrics.pg.sql',import.meta.url),'utf8')).replace(/\r\n?/g,'\n');
  return Object.freeze({ hash: sha256Ref(source),sql: source.replaceAll('__RISK_FORK_TELEMETRY_SCHEMA__',quotePostgresAuthorityIdentifier(schemaName)) });
}
export async function backlogGaugesMigration(schemaName) {
  const source = (await readFile(new URL('../migrations/013_managed_backlog_gauges.pg.sql',import.meta.url),'utf8')).replace(/\r\n?/g,'\n');
  return Object.freeze({ hash: sha256Ref(source),sql: source.replaceAll('__RISK_FORK_TELEMETRY_SCHEMA__',quotePostgresAuthorityIdentifier(schemaName)) });
}
export async function backlogAlertsMigration(schemaName) {
  const source = (await readFile(new URL('../migrations/014_managed_backlog_threshold_alerts.pg.sql',import.meta.url),'utf8')).replace(/\r\n?/g,'\n');
  return Object.freeze({ hash: sha256Ref(source),sql: source.replaceAll('__RISK_FORK_TELEMETRY_SCHEMA__',quotePostgresAuthorityIdentifier(schemaName)) });
}
export async function diagnosticMetricsMigration(schemaName) {
  const source = (await readFile(new URL('../migrations/015_managed_diagnostic_metrics.pg.sql',import.meta.url),'utf8')).replace(/\r\n?/g,'\n');
  return Object.freeze({ hash: sha256Ref(source),sql: source.replaceAll('__RISK_FORK_TELEMETRY_SCHEMA__',quotePostgresAuthorityIdentifier(schemaName)) });
}

export async function verifyTelemetrySettings(client, config, hash) {
  const settings = await client.query(`SELECT version,migration_hash FROM ${config.quotedSchema}.telemetry_schema_migrations ORDER BY version`);
  const extension = config.lifecycle ? await lifecycleMigration(config.schemaName) : null;
  const metrics = config.metrics ? await metricsMigration(config.schemaName) : null;
  const execution = config.metricVersion >= 4 ? await executionMetricsMigration(config.schemaName) : null;
  const budget = config.metricVersion >= 5 ? await budgetMetricsMigration(config.schemaName) : null;
  const cleanup = config.metricVersion >= 6 ? await cleanupMetricsMigration(config.schemaName) : null;
  const incomplete = config.metricVersion >= 7 ? await cleanupIncompleteMetricsMigration(config.schemaName) : null;
  const backlog = config.metricVersion >= 8 ? await backlogGaugesMigration(config.schemaName) : null;
  const backlogAlerts = config.metricVersion >= 9 ? await backlogAlertsMigration(config.schemaName) : null;
  const diagnostic = config.metricVersion === 10 ? await diagnosticMetricsMigration(config.schemaName) : null;
  if (settings.rowCount !== (diagnostic ? 10 : backlogAlerts ? 9 : backlog ? 8 : incomplete ? 7 : cleanup ? 6 : budget ? 5 : execution ? 4 : metrics ? 3 : extension ? 2 : 1) || settings.rows[0].version !== 1 || settings.rows[0].migration_hash !== hash
    || (extension && (settings.rows[1].version !== 2 || settings.rows[1].migration_hash !== extension.hash))
    || (metrics && (settings.rows[2].version !== 3 || settings.rows[2].migration_hash !== metrics.hash))
    || (execution && (settings.rows[3].version !== 4 || settings.rows[3].migration_hash !== execution.hash))
    || (budget && (settings.rows[4].version !== 5 || settings.rows[4].migration_hash !== budget.hash))
    || (cleanup && (settings.rows[5].version !== 6 || settings.rows[5].migration_hash !== cleanup.hash))
    || (incomplete && (settings.rows[6].version !== 7 || settings.rows[6].migration_hash !== incomplete.hash))
    || (backlog && (settings.rows[7].version !== 8 || settings.rows[7].migration_hash !== backlog.hash))
    || (backlogAlerts && (settings.rows[8].version !== 9 || settings.rows[8].migration_hash !== backlogAlerts.hash))
    || (diagnostic && (settings.rows[9].version !== 10 || settings.rows[9].migration_hash !== diagnostic.hash))) throw new TypeError('Telemetry migration drift');
  const result = await client.query(`SELECT settings_hash,max_events,max_events_per_tenant,lease_ms,retry_ms,retention_ms
    FROM ${config.quotedSchema}.telemetry_settings WHERE singleton=true`);
  const row = result.rows[0], l = config.limits;
  if (result.rowCount !== 1 || row.settings_hash !== config.settingsHash || row.max_events !== l.maxEvents
    || row.max_events_per_tenant !== l.maxEventsPerTenant || row.lease_ms !== l.leaseMs
    || row.retry_ms !== l.retryMs || row.retention_ms !== l.retentionMs) throw new TypeError('Telemetry settings drift');
  if (config.metrics) {
    const bound = await client.query(`SELECT settings_hash,payload FROM ${config.quotedSchema}.telemetry_metric_settings WHERE singleton=true`);
    const state = bound.rows[0], normalized = state ? normalizeMetricSettings(state.payload) : null;
    if (bound.rowCount !== 1 || state.settings_hash !== metricSettingsHash(config.metricSettings)
      || metricSettingsHash(normalized) !== state.settings_hash || canonicalize(normalized) !== canonicalize(state.payload)) throw new TypeError('Metric settings drift');
  }
  if (diagnostic) {
    const bound = await client.query(`SELECT settings_hash,payload FROM ${config.quotedSchema}.telemetry_diagnostic_settings WHERE singleton=true`);
    const state = bound.rows[0], normalized = state ? normalizeDiagnosticSettings(state.payload) : null;
    if (bound.rowCount !== 1 || state.settings_hash !== diagnosticSettingsHash(config.diagnosticSettings)
      || diagnosticSettingsHash(normalized) !== state.settings_hash || canonicalize(normalized) !== canonicalize(state.payload)) throw new TypeError('Diagnostic settings drift');
  }
}

export function telemetryClaimHash(value) {
  if (typeof value !== 'string' || !/^[A-Za-z0-9_-]{43,86}$/.test(value)) throw new TypeError('Invalid telemetry claim token');
  return sha256Ref({ domain: 'risk-fork-managed-telemetry-claim-v1', token: value });
}
