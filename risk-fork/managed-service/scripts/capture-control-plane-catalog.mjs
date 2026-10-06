// Explicit tooling-only PostgreSQL 16 capture. Expected runtime catalog bytes
// are never inferred at startup. Roll back all schema/DDL before emitting.
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import pg from 'pg';
import { sha256Ref } from '../../src/canonical.mjs';
import { readManagedPostgresCatalog } from '../src/postgres-control-plane-attestation.mjs';

const connectionString = process.env.RISK_FORK_MANAGED_TEST_POSTGRES_URL;
const url = new URL(connectionString);
if (!['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname)
  || url.pathname !== '/risk_fork_managed_test'
  || process.env.RISK_FORK_MANAGED_TEST_CONFIRM_DISPOSABLE !== 'YES_DELETE_DATA') {
  throw new Error('Control-plane capture requires the explicit disposable loopback lab');
}
const schemaName = `control_catalog_${randomUUID().replaceAll('-', '')}`;
const quoted = `"${schemaName}"`;
const pool = new pg.Pool({ connectionString, max: 1 });
const client = await pool.connect();
try {
  await client.query('BEGIN');
  await client.query('SET LOCAL synchronous_commit=on');
  await client.query(`CREATE SCHEMA ${quoted}`);
  await client.query(`CREATE TABLE ${quoted}.managed_schema_migrations (
    version integer PRIMARY KEY CHECK (version >= 1),
    migration_hash text NOT NULL CHECK (migration_hash ~ '^sha256:[a-f0-9]{64}$'),
    applied_at timestamptz NOT NULL DEFAULT clock_timestamp()
  )`);
  const files = ['001_managed_control_plane.pg.sql', '002_journal_purpose.pg.sql',
    '003_control_plane_lock_helpers.pg.sql', '008_managed_cancellation.pg.sql'];
  const migrationHashes = [];
  for (const file of files) {
    const source = (await readFile(new URL(`../migrations/${file}`, import.meta.url), 'utf8')).replace(/\r\n?/g, '\n');
    migrationHashes.push(sha256Ref(source));
    await client.query(source.replaceAll('__RISK_FORK_MANAGED_SCHEMA__', quoted));
  }
  const version = await client.query("SELECT current_setting('server_version_num')::integer AS version");
  if (version.rows[0].version < 160000 || version.rows[0].version >= 170000) throw new Error('PG16 catalog required');
  const manifest = { schema: 'agoragentic.risk-fork.managed-postgres-catalog.v2', postgres_major: 16,
    migration_hashes: migrationHashes, catalog: await readManagedPostgresCatalog(client, schemaName) };
  await client.query('ROLLBACK');
  if ((await client.query('SELECT 1 FROM pg_namespace WHERE nspname=$1', [schemaName])).rowCount !== 0) {
    throw new Error('Control-plane capture cleanup failed');
  }
  process.stdout.write(`RISK_FORK_CONTROL_CATALOG=${JSON.stringify(manifest)}\n`);
} finally {
  await client.query('ROLLBACK').catch(() => {});
  client.release();
  await pool.end();
}
