import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { sha256Ref } from '../../src/canonical.mjs';
import { quotePostgresAuthorityIdentifier } from '../../src/adapters/postgres-authority-migrator.mjs';
import { assertAllowedKeys, assertPlainRecord, deepFreeze, managedError, requireInteger } from './validation.mjs';

export const POLICY_ROUTES = Object.freeze(['admission', 'execution', 'cleanup', 'recovery', 'read']);

export function normalizeRequestQuotas(value) {
  assertPlainRecord(value, 'quotas');
  assertAllowedKeys(value, POLICY_ROUTES, 'quotas');
  const quotas = {};
  for (const route of POLICY_ROUTES) {
    const rule = value[route];
    assertPlainRecord(rule, `quotas.${route}`);
    assertAllowedKeys(rule, ['windowMs', 'perKey', 'perTenant', 'maxSubjects'], `quotas.${route}`);
    quotas[route] = {
      windowMs: requireInteger(rule.windowMs, 'windowMs', { min: 1000, max: 3_600_000 }),
      perKey: requireInteger(rule.perKey, 'perKey', { min: 1, max: 1_000_000 }),
      perTenant: requireInteger(rule.perTenant, 'perTenant', { min: 1, max: 1_000_000 }),
      maxSubjects: requireInteger(rule.maxSubjects, 'maxSubjects', { min: 2, max: 1_000_000 }),
    };
  }
  return deepFreeze(quotas);
}

export function policySubjectHash(kind, tenant, key = '') {
  return `sha256:${createHash('sha256').update(`agoragentic-risk-fork-request-quota-v1:${kind}\0`)
    .update(JSON.stringify([tenant, key])).digest('hex')}`;
}

export function normalizePolicyOptions(options, extraKeys = []) {
  assertPlainRecord(options, 'PostgreSQL request policy options');
  assertAllowedKeys(options, ['pool', 'connectionString', 'schemaName', 'requireTls', 'tls',
    'maxConnections', 'connectionTimeoutMs', 'statementTimeoutMs', 'deploymentMode', 'disposableDb', 'quotas', ...extraKeys],
  'PostgreSQL request policy options');
  if ((options.deploymentMode ?? 'local_test') !== 'local_test') {
    throw managedError('Request policy is source-only local_test', 'POLICY_NOT_QUALIFIED', 503);
  }
  const requireTls = options.requireTls ?? true;
  if (typeof requireTls !== 'boolean') throw new TypeError('requireTls must be boolean');
  if (!requireTls && options.disposableDb !== true) throw new TypeError('TLS bypass requires disposableDb=true');
  if (options.pool != null && options.connectionString != null) throw new TypeError('Provide pool or connectionString, not both');
  if (options.pool != null && (requireTls || typeof options.pool.connect !== 'function')) {
    throw new TypeError('Injected pools require disposable non-TLS local testing');
  }
  const schemaName = options.schemaName ?? 'risk_fork_request_policy';
  const quotedSchema = quotePostgresAuthorityIdentifier(schemaName);
  const quotas = normalizeRequestQuotas(options.quotas);
  return Object.freeze({ schemaName, quotedSchema, quotas, policyHash: sha256Ref(quotas), requireTls,
    statementTimeoutMs: requireInteger(options.statementTimeoutMs ?? 5_000, 'statementTimeoutMs', { min: 100, max: 30_000 }) });
}

export async function requestPolicyMigration(schemaName) {
  const source = (await readFile(new URL('../migrations/004_request_policy.pg.sql', import.meta.url), 'utf8')).replace(/\r\n?/g, '\n');
  return Object.freeze({ hash: sha256Ref(source), sql: source.replaceAll('__RISK_FORK_POLICY_SCHEMA__', quotePostgresAuthorityIdentifier(schemaName)) });
}

export function checkPolicySignal(signal) {
  if (signal !== undefined && (!(signal instanceof AbortSignal) || signal.aborted)) {
    throw managedError('Request deadline expired', 'REQUEST_TIMEOUT', 408);
  }
}

export function policyDbInteger(value) {
  if (!['string', 'number'].includes(typeof value) || !/^(0|[1-9][0-9]*)$/.test(String(value))) throw new TypeError('Invalid database integer');
  const number = Number(value);
  if (!Number.isSafeInteger(number)) throw new TypeError('Unsafe database integer');
  return number;
}

export function requestQuotaWindow(now, windowMs) {
  requireInteger(now, 'database time', { max: Number.MAX_SAFE_INTEGER - windowMs });
  requireInteger(windowMs, 'windowMs', { min: 1000, max: 3_600_000 });
  const start = Math.floor(now / windowMs) * windowMs;
  return Object.freeze({ start, retry: Math.max(1, Math.min(3600, Math.ceil((start + windowMs - now) / 1000))) });
}

export async function verifyRequestPolicy(client, config, migrationHash) {
  const s = config.quotedSchema;
  const settings = await client.query("SELECT current_setting('server_version_num')::integer AS version, current_setting('fsync') AS fsync, current_setting('synchronous_commit') AS sync, current_setting('session_replication_role') AS triggers");
  const row = settings.rows[0];
  if (settings.rowCount !== 1 || !Number.isInteger(row?.version) || row.version < 160000 || row.version >= 170000 || row.fsync !== 'on' || row.sync !== 'on' || row.triggers !== 'origin') {
    throw managedError('Request policy database settings are unsafe', 'POLICY_STORE_INVALID', 503);
  }
  const ledger = await client.query(`SELECT version, migration_hash FROM ${s}.request_policy_schema_migrations ORDER BY version`);
  if (ledger.rowCount !== 1 || Number(ledger.rows[0].version) !== 1 || ledger.rows[0].migration_hash !== migrationHash) {
    throw managedError('Request policy migration differs from source', 'POLICY_STORE_INVALID', 503);
  }
  const control = await client.query(`SELECT enabled, epoch, policy_hash FROM ${s}.request_policy_control WHERE singleton = true`);
  const c = control.rows[0];
  if (control.rowCount !== 1 || typeof c?.enabled !== 'boolean' || c.policy_hash !== config.policyHash) {
    throw managedError('Request policy control differs from binding', 'POLICY_STORE_INVALID', 503);
  }
  const routes = await client.query(`SELECT route_class, window_ms, per_key, per_tenant, max_subjects FROM ${s}.request_policy_routes ORDER BY route_class`);
  if (routes.rowCount !== POLICY_ROUTES.length || routes.rows.some((r) => {
    const q = config.quotas[r.route_class];
    return !q || r.window_ms !== q.windowMs || r.per_key !== q.perKey || r.per_tenant !== q.perTenant || r.max_subjects !== q.maxSubjects;
  }) || new Set(routes.rows.map((r) => r.route_class)).size !== POLICY_ROUTES.length) {
    throw managedError('Request quota configuration differs from binding', 'POLICY_STORE_INVALID', 503);
  }
  return Object.freeze({ enabled: c.enabled, epoch: policyDbInteger(c.epoch) });
}
