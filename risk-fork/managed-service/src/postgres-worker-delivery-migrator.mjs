import { readFile } from 'node:fs/promises';

import {
  acquirePostgresAuthorityClient,
  createPostgresAuthorityPool,
  quotePostgresAuthorityIdentifier,
} from '../../src/adapters/postgres-authority-migrator.mjs';
import { sha256Ref } from '../../src/canonical.mjs';
import {
  assertAllowedKeys,
  assertPlainRecord,
  deepFreeze,
  managedError,
  requireInteger,
} from './validation.mjs';

const VERSION = 1;

async function loadMigration(schemaName) {
  const source = (await readFile(
    new URL('../migrations/002_worker_delivery.pg.sql', import.meta.url),
    'utf8',
  )).replace(/\r\n?/g, '\n');
  return {
    version: VERSION,
    migration_hash: sha256Ref(source),
    sql: source.replaceAll('__RISK_FORK_MANAGED_SCHEMA__', quotePostgresAuthorityIdentifier(schemaName)),
  };
}

export async function migratePostgresWorkerDelivery(options = {}) {
  assertPlainRecord(options, 'worker delivery migration options');
  assertAllowedKeys(options, [
    'pool', 'connectionString', 'schemaName', 'tls', 'requireTls',
    'maxConnections', 'connectionTimeoutMs', 'statementTimeoutMs', 'deploymentMode', 'disposableDb',
  ], 'worker delivery migration options');
  const schemaName = options.schemaName ?? 'risk_fork_worker_delivery';
  const requireTls = options.requireTls ?? true;
  if (typeof requireTls !== 'boolean') throw new TypeError('requireTls must be boolean');
  const deploymentMode = options.deploymentMode ?? 'local_test';
  if (deploymentMode !== 'local_test') throw managedError('Worker delivery is local_test only', 'WORKER_NOT_QUALIFIED', 503);
  if (options.pool && options.connectionString) throw new TypeError('Provide either pool or connectionString, not both');
  if (!requireTls && (deploymentMode !== 'local_test' || options.disposableDb !== true)) throw managedError('TLS bypass requires explicit disposableDb=true', 'WORKER_TLS_REQUIRED', 503);
  if (options.pool && requireTls) throw managedError('CA-pinned transport requires a factory-owned pool', 'WORKER_POSTGRES_TLS_POOL_UNTRUSTED', 503);
  const statementTimeoutMs = requireInteger(options.statementTimeoutMs ?? 30_000, 'statementTimeoutMs', { min: 100, max: 300_000 });
  const ownsPool = !options.pool;
  const pool = options.pool ?? await createPostgresAuthorityPool({
    connectionString: options.connectionString, requireTls, tls: options.tls,
    maxConnections: options.maxConnections ?? 2, connectionTimeoutMs: options.connectionTimeoutMs,
    statementTimeoutMs, applicationName: 'agoragentic-risk-fork-worker-delivery-migrator',
  });
  const migration = await loadMigration(schemaName);
  const quotedSchema = quotePostgresAuthorityIdentifier(schemaName, 'managed PostgreSQL schema name');
  const verifiedClients = new WeakSet();
  try {
    const client = await acquirePostgresAuthorityClient(pool, { requireTls, verifiedClients });
    try {
      await client.query('BEGIN ISOLATION LEVEL SERIALIZABLE');
      try {
        await client.query('SET LOCAL synchronous_commit = on');
        await client.query(`SET LOCAL statement_timeout = ${statementTimeoutMs}`);
        await client.query(`SET LOCAL lock_timeout = ${statementTimeoutMs}`);
        await client.query(`SET LOCAL idle_in_transaction_session_timeout = ${statementTimeoutMs}`);
        await client.query('SELECT pg_advisory_xact_lock(1380338246, 307)');
        await client.query(`CREATE SCHEMA IF NOT EXISTS ${quotedSchema}`);
        const ledgerRelation = await client.query(
          'SELECT to_regclass($1) AS ledger',
          [`${schemaName}.managed_worker_delivery_schema_migrations`],
        );
        const applied = ledgerRelation.rows[0]?.ledger
          ? await client.query(
            `SELECT migration_hash FROM ${quotedSchema}.managed_worker_delivery_schema_migrations WHERE version = $1`,
            [1],
          )
          : { rowCount: 0, rows: [] };
        if (applied.rowCount === 0) {
          const ledgerProbe = await client.query(
            `SELECT to_regclass($1) AS attempts, to_regclass($2) AS namespaces, to_regclass($3) AS ledger`,
            [`${schemaName}.managed_worker_delivery_attempts`, `${schemaName}.managed_worker_delivery_namespaces`, `${schemaName}.managed_worker_delivery_schema_migrations`],
          );
          if (ledgerProbe.rows[0]?.attempts || ledgerProbe.rows[0]?.namespaces || ledgerProbe.rows[0]?.ledger) {
            throw managedError('Worker delivery objects exist without the owner migration ledger', 'WORKER_MIGRATION_PARTIAL', 503);
          }
          await client.query(migration.sql);
          await client.query(
            `INSERT INTO ${quotedSchema}.managed_worker_delivery_schema_migrations (version, migration_hash) VALUES ($1, $2)`,
            [1, migration.migration_hash],
          );
        } else if (applied.rowCount !== 1 || applied.rows[0].migration_hash !== migration.migration_hash) {
          throw managedError('Worker delivery migration hash differs from reviewed source', 'WORKER_MIGRATION_HASH_MISMATCH', 503);
        }
        const ledger = await client.query(
          `SELECT version, migration_hash FROM ${quotedSchema}.managed_worker_delivery_schema_migrations ORDER BY version`,
          [],
        );
        if (ledger.rowCount !== 1 || Number(ledger.rows[0].version) !== 1
          || ledger.rows[0].migration_hash !== migration.migration_hash) {
          throw managedError('Worker delivery owner ledger hash is not exact', 'WORKER_MIGRATION_LEDGER_MISMATCH', 503);
        }
        await client.query('COMMIT');
      } catch (error) { await client.query('ROLLBACK').catch(() => {}); throw error; }
      return deepFreeze({ schema_name: schemaName, migration_version: migration.version,
        migration_hash: migration.migration_hash, production_qualified: false });
    } finally { client.release(); }
  } finally { if (ownsPool) await pool.end().catch(() => {}); }
}
