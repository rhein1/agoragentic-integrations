import { readFile } from 'node:fs/promises';
import { sha256Ref } from '../../src/canonical.mjs';
import {
  acquirePostgresAuthorityClient,
  createPostgresAuthorityPool,
  quotePostgresAuthorityIdentifier,
} from '../../src/adapters/postgres-authority-migrator.mjs';
import {
  assertAllowedKeys,
  assertPlainRecord,
  deepFreeze,
  managedError,
  requireInteger,
} from './validation.mjs';

const MIGRATION_FILES = ['001_managed_control_plane.pg.sql', '002_journal_purpose.pg.sql',
  '003_control_plane_lock_helpers.pg.sql'];
const REQUIRED_TABLES = Object.freeze([
  'managed_schema_migrations',
  'managed_tenants',
  'managed_api_keys',
  'managed_usage_buckets',
  'managed_invocations',
  'managed_lease_token_uses',
  'managed_resource_journal_receipts',
  'managed_audit_events',
]);

async function loadMigrations(schemaName) {
  return Promise.all(MIGRATION_FILES.map(async (file, index) => {
    const source = (await readFile(new URL(`../migrations/${file}`, import.meta.url), 'utf8'))
      .replace(/\r\n?/g, '\n');
    return { version: index + 1, migration_hash: sha256Ref(source),
      sql: source.replaceAll('__RISK_FORK_MANAGED_SCHEMA__', quotePostgresAuthorityIdentifier(schemaName)) };
  }));
}

async function verifyTables(client, schemaName) {
  const result = await client.query(
    `SELECT table_name
       FROM information_schema.tables
      WHERE table_schema = $1
        AND table_name = ANY($2::text[])
      ORDER BY table_name`,
    [schemaName, REQUIRED_TABLES],
  );
  const observed = result.rows.map((row) => row.table_name).sort();
  const expected = [...REQUIRED_TABLES].sort();
  if (JSON.stringify(observed) !== JSON.stringify(expected)) {
    throw managedError(
      'Managed PostgreSQL schema is incomplete',
      'MANAGED_SCHEMA_INCOMPLETE',
      503,
      { expected_count: expected.length, observed_count: observed.length },
    );
  }
}

export async function migrateManagedServicePostgres(options = {}) {
  assertPlainRecord(options, 'managed PostgreSQL migration options');
  assertAllowedKeys(options, [
    'pool',
    'connectionString',
    'schemaName',
    'requireTls',
    'tls',
    'maxConnections',
    'connectionTimeoutMs',
    'statementTimeoutMs',
  ], 'managed PostgreSQL migration options');
  const schemaName = options.schemaName ?? 'risk_fork_managed';
  const quotedSchema = quotePostgresAuthorityIdentifier(schemaName, 'managed PostgreSQL schema name');
  const requireTls = options.requireTls ?? true;
  if (typeof requireTls !== 'boolean') throw new TypeError('requireTls must be a boolean');
  if (options.pool && options.connectionString) {
    throw new TypeError('Provide either pool or connectionString, not both');
  }
  if (options.pool && requireTls) {
    throw managedError(
      'A supplied pool cannot establish its own CA-pinned transport provenance',
      'MANAGED_POSTGRES_TLS_POOL_UNTRUSTED',
      503,
    );
  }
  const statementTimeoutMs = requireInteger(
    options.statementTimeoutMs ?? 30_000,
    'statementTimeoutMs',
    { min: 100, max: 300_000 },
  );
  const ownsPool = !options.pool;
  const pool = options.pool ?? await createPostgresAuthorityPool({
    connectionString: options.connectionString,
    requireTls,
    tls: options.tls,
    maxConnections: options.maxConnections ?? 2,
    connectionTimeoutMs: options.connectionTimeoutMs,
    statementTimeoutMs,
    applicationName: 'agoragentic-risk-fork-managed-migrator',
  });
  const migrations = await loadMigrations(schemaName);
  const migration = migrations.at(-1);
  const verifiedClients = new WeakSet();
  try {
    const client = await acquirePostgresAuthorityClient(pool, { requireTls, verifiedClients });
    try {
      await client.query('BEGIN');
      try {
        await client.query('SET LOCAL synchronous_commit = on');
        await client.query(`SET LOCAL statement_timeout = ${statementTimeoutMs}`);
        await client.query(`SET LOCAL lock_timeout = ${statementTimeoutMs}`);
        await client.query('SELECT pg_advisory_xact_lock(1380338246, 306)');
        await client.query(`CREATE SCHEMA IF NOT EXISTS ${quotedSchema}`);
        await client.query(
          `CREATE TABLE IF NOT EXISTS ${quotedSchema}.managed_schema_migrations (
             version integer PRIMARY KEY CHECK (version >= 1),
             migration_hash text NOT NULL CHECK (migration_hash ~ '^sha256:[a-f0-9]{64}$'),
             applied_at timestamptz NOT NULL DEFAULT clock_timestamp()
           )`,
        );
        const applied = await client.query(
          `SELECT version, migration_hash
             FROM ${quotedSchema}.managed_schema_migrations
            ORDER BY version`,
        );
        if (applied.rowCount > migrations.length || applied.rows.some((row, index) =>
          Number(row.version) !== migrations[index].version
          || row.migration_hash !== migrations[index].migration_hash)) {
          throw managedError('Managed PostgreSQL migration set differs from reviewed source',
            'MANAGED_MIGRATION_SET_MISMATCH', 503);
        }
        for (const next of migrations.slice(applied.rowCount)) {
          await client.query(next.sql);
          await client.query(
            `INSERT INTO ${quotedSchema}.managed_schema_migrations
               (version, migration_hash, applied_at)
             VALUES ($1, $2, clock_timestamp())`,
            [next.version, next.migration_hash],
          );
        }
        await verifyTables(client, schemaName);
        await client.query('COMMIT');
      } catch (error) {
        await client.query('ROLLBACK').catch(() => {});
        throw error;
      }
      return deepFreeze({
        schema_name: schemaName,
        migration_version: migration.version,
        migration_hash: migration.migration_hash,
        production_qualified: false,
      });
    } finally {
      client.release();
    }
  } finally {
    if (ownsPool) await pool.end().catch(() => {});
  }
}
