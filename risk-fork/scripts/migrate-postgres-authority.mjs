#!/usr/bin/env node

import { migratePostgresDistributedAuthority } from '../src/adapters/postgres-authority-migrator.mjs';

function requiredEnvironment(name) {
  const value = process.env[name];
  if (typeof value !== 'string' || value.length === 0) {
    const error = new Error(`Required migration environment variable is absent: ${name}`);
    error.code = 'POSTGRES_AUTHORITY_MIGRATION_CONFIG_MISSING';
    throw error;
  }
  return value;
}

async function main() {
  const connectionString = requiredEnvironment('RISK_FORK_MIGRATION_DATABASE_URL');
  const ca = requiredEnvironment('RISK_FORK_TLS_CA');
  const schemaName = process.env.RISK_FORK_SCHEMA_NAME || 'risk_fork_authority';
  const result = await migratePostgresDistributedAuthority({
    connectionString,
    schemaName,
    requireTls: true,
    tls: { ca },
  });
  process.stdout.write(`${JSON.stringify({
    status: 'ok',
    schema_name: result.schema_name,
    migrations: result.migrations,
  })}\n`);
}

main().catch((error) => {
  process.stderr.write(`${JSON.stringify({
    status: 'failed',
    code: typeof error?.code === 'string'
      ? error.code
      : 'POSTGRES_AUTHORITY_MIGRATION_FAILED',
  })}\n`);
  process.exitCode = 1;
});
