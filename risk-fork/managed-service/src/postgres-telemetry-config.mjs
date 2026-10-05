import { readFile } from 'node:fs/promises';
import { sha256Ref } from '../../src/canonical.mjs';
import { quotePostgresAuthorityIdentifier } from '../../src/adapters/postgres-authority-migrator.mjs';
import { assertAllowedKeys, assertPlainRecord, deepFreeze, managedError, requireInteger } from './validation.mjs';
import { policyDbInteger, checkPolicySignal } from './postgres-request-policy-config.mjs';

export { policyDbInteger as telemetryDbInteger, checkPolicySignal as checkTelemetrySignal };
export const TELEMETRY_TABLES = Object.freeze(['telemetry_clock','telemetry_events','telemetry_schema_migrations','telemetry_settings']);
export const TELEMETRY_INSERT_COLUMNS = Object.freeze(['event_ref','event_hash','event','route_class','status','outcome',
  'duration_ms','tenant_hash','key_hash','created_ms']);
export const TELEMETRY_UPDATE_COLUMNS = Object.freeze(['state','generation','attempts','claim_hash','lease_expires_ms',
  'next_attempt_ms','acknowledged_ms','acknowledgement_hash','last_error_code']);

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
    'connectionTimeoutMs','statementTimeoutMs','deploymentMode','disposableDb','limits','expectedOwner', ...extraKeys], 'PostgreSQL telemetry options');
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
  return Object.freeze({ schemaName, quotedSchema, limits, settingsHash: sha256Ref(limits), requireTls,
    expectedOwner: options.expectedOwner,
    statementTimeoutMs: requireInteger(options.statementTimeoutMs ?? 2000, 'statementTimeoutMs', { min: 100, max: 30_000 }) });
}

export async function telemetryMigration(schemaName) {
  const source = (await readFile(new URL('../migrations/005_managed_telemetry.pg.sql', import.meta.url), 'utf8')).replace(/\r\n?/g, '\n');
  return Object.freeze({ hash: sha256Ref(source), sql: source.replaceAll('__RISK_FORK_TELEMETRY_SCHEMA__', quotePostgresAuthorityIdentifier(schemaName)) });
}

export async function verifyTelemetrySettings(client, config, hash) {
  const settings = await client.query(`SELECT version,migration_hash FROM ${config.quotedSchema}.telemetry_schema_migrations ORDER BY version`);
  if (settings.rowCount !== 1 || settings.rows[0].version !== 1 || settings.rows[0].migration_hash !== hash) throw new TypeError('Telemetry migration drift');
  const result = await client.query(`SELECT settings_hash,max_events,max_events_per_tenant,lease_ms,retry_ms,retention_ms
    FROM ${config.quotedSchema}.telemetry_settings WHERE singleton=true`);
  const row = result.rows[0], l = config.limits;
  if (result.rowCount !== 1 || row.settings_hash !== config.settingsHash || row.max_events !== l.maxEvents
    || row.max_events_per_tenant !== l.maxEventsPerTenant || row.lease_ms !== l.leaseMs
    || row.retry_ms !== l.retryMs || row.retention_ms !== l.retentionMs) throw new TypeError('Telemetry settings drift');
}

export function telemetryClaimHash(value) {
  if (typeof value !== 'string' || !/^[A-Za-z0-9_-]{43,86}$/.test(value)) throw new TypeError('Invalid telemetry claim token');
  return sha256Ref({ domain: 'risk-fork-managed-telemetry-claim-v1', token: value });
}
