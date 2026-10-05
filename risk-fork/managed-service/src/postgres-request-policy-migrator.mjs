import { acquirePostgresAuthorityClient, createPostgresAuthorityPool } from '../../src/adapters/postgres-authority-migrator.mjs';
import { managedError } from './validation.mjs';
import { normalizePolicyOptions, POLICY_ROUTES, requestPolicyMigration, verifyRequestPolicy } from './postgres-request-policy-config.mjs';

export async function migratePostgresManagedRequestPolicy(options = {}) {
  const config = normalizePolicyOptions(options);
  const migration = await requestPolicyMigration(config.schemaName);
  const owned = options.pool == null;
  const pool = options.pool ?? await createPostgresAuthorityPool({ connectionString: options.connectionString,
    requireTls: config.requireTls, tls: options.tls, maxConnections: options.maxConnections ?? 2,
    connectionTimeoutMs: options.connectionTimeoutMs, statementTimeoutMs: config.statementTimeoutMs,
    applicationName: 'risk-fork-policy-migrator' });
  try {
    const client = await acquirePostgresAuthorityClient(pool, { requireTls: config.requireTls });
    try {
      await client.query('BEGIN');
      try {
        await client.query('SET LOCAL synchronous_commit = on');
        await client.query(`SET LOCAL statement_timeout = ${config.statementTimeoutMs}`);
        await client.query(`SET LOCAL lock_timeout = ${config.statementTimeoutMs}`);
        await client.query('SELECT pg_advisory_xact_lock(1380338246, 308)');
        const s = config.quotedSchema;
        const existing = await client.query('SELECT oid FROM pg_catalog.pg_namespace WHERE nspname = $1', [config.schemaName]);
        if (existing.rowCount === 0) {
          await client.query(`CREATE SCHEMA ${s}`);
          await client.query(migration.sql);
          await client.query(`INSERT INTO ${s}.request_policy_schema_migrations VALUES (1, $1)`, [migration.hash]);
          await client.query(`INSERT INTO ${s}.request_policy_control (singleton, enabled, epoch, policy_hash) VALUES (true, false, 0, $1)`, [config.policyHash]);
          for (const route of POLICY_ROUTES) {
            const q = config.quotas[route];
            await client.query(`INSERT INTO ${s}.request_policy_routes (route_class, window_ms, per_key, per_tenant, max_subjects) VALUES ($1,$2,$3,$4,$5)`,
              [route, q.windowMs, q.perKey, q.perTenant, q.maxSubjects]);
          }
        } else if (existing.rowCount !== 1) throw managedError('Request policy schema is ambiguous', 'POLICY_STORE_INVALID', 503);
        await verifyRequestPolicy(client, config, migration.hash);
        await client.query('COMMIT');
      } catch (error) { await client.query('ROLLBACK').catch(() => {}); throw error; }
      return Object.freeze({ schema_name: config.schemaName, migration_version: 1, migration_hash: migration.hash,
        policy_hash: config.policyHash, production_qualified: false });
    } finally { client.release(); }
  } finally { if (owned) await pool.end().catch(() => {}); }
}
