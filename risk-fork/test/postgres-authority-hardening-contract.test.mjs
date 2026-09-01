import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import pg from 'pg';

import { PostgresDistributedCommitAuthority } from '../src/adapters/postgres-authority.mjs';
import {
  buildPostgresAuthorityPoolConfig,
  migratePostgresDistributedAuthority,
  verifyPostgresAuthorityClientTransport,
  verifyPostgresDistributedAuthoritySchema,
} from '../src/adapters/postgres-authority-migrator.mjs';
import { sha256Ref } from '../src/canonical.mjs';

const CONNECTION_STRING = 'postgresql://runtime:secret@db.internal/risk_fork';
const TEST_CA = [
  '-----BEGIN CERTIFICATE-----',
  'contract-only-ca',
  '-----END CERTIFICATE-----',
].join('\n');
const SAFE_STARTUP_OPTIONS = '-c synchronous_commit=on -c search_path=pg_catalog';
const CATALOG_FINGERPRINTS = Object.freeze({
  pg_attribute: Object.freeze({
    item_count: 100,
    fingerprint: 'f68ab21d7b0e7db35cfc75450d75b5317851646bd443f02b3171fd5064ff02cc',
  }),
  pg_constraint: Object.freeze({
    item_count: 74,
    fingerprint: 'd851c63225a61275a594364b1cc7c170695f7a62ad46a435fa6fd560ce898a99',
  }),
  pg_index: Object.freeze({
    item_count: 12,
    fingerprint: 'e3a4a48cdc774298e1f28eb51915fae3520e6fae138f3079f44ee7a396acf849',
  }),
});

function catalogFingerprintResult(sql) {
  if (!/\bAS fingerprint\b/.test(sql)) return null;
  const match = Object.entries(CATALOG_FINGERPRINTS)
    .find(([catalog]) => sql.includes(`pg_catalog.${catalog}`));
  if (!match) return null;
  return { rowCount: 1, rows: [{ ...match[1] }] };
}

function reviewedTriggerRows(schemaName = 'contract_authority') {
  const functionBody = [
    'BEGIN',
    "  RAISE EXCEPTION 'risk fork authority audit events are append-only'",
    "    USING ERRCODE = '55000';",
    'END;',
  ].join('\n');
  return [
    {
      relation_name: 'audit_events',
      tgname: 'audit_events_no_delete',
      tgenabled: 'O',
      tgtype: 11,
      function_schema: schemaName,
      function_name: 'reject_audit_mutation',
      security_definer: false,
      volatility: 'v',
      function_kind: 'f',
      argument_count: 0,
      return_type: 'trigger',
      language_name: 'plpgsql',
      function_body: functionBody,
      trigger_definition: 'CREATE TRIGGER audit_events_no_delete BEFORE DELETE ON __schema__.audit_events FOR EACH ROW EXECUTE FUNCTION __schema__.reject_audit_mutation()',
    },
    {
      relation_name: 'audit_events',
      tgname: 'audit_events_no_update',
      tgenabled: 'O',
      tgtype: 19,
      function_schema: schemaName,
      function_name: 'reject_audit_mutation',
      security_definer: false,
      volatility: 'v',
      function_kind: 'f',
      argument_count: 0,
      return_type: 'trigger',
      language_name: 'plpgsql',
      function_body: functionBody,
      trigger_definition: 'CREATE TRIGGER audit_events_no_update BEFORE UPDATE ON __schema__.audit_events FOR EACH ROW EXECUTE FUNCTION __schema__.reject_audit_mutation()',
    },
  ];
}

async function reviewedMigrationHash() {
  const source = await readFile(
    new URL('../migrations/001_distributed_authority.pg.sql', import.meta.url),
    'utf8',
  );
  return sha256Ref(source.replace(/\r\n?/g, '\n'));
}

function schemaVerificationClient(migrationHash, { allowAuditUpdate = false } = {}) {
  const queries = [];
  const required = new Map([
    ['authority_schema_migrations', new Set(['SELECT'])],
    ['authority_meta', new Set(['SELECT', 'INSERT', 'UPDATE'])],
    ['parent_heads', new Set(['SELECT', 'INSERT', 'UPDATE'])],
    ['commit_approvals', new Set(['SELECT', 'INSERT', 'UPDATE'])],
    ['execution_authorizations', new Set(['SELECT', 'INSERT', 'UPDATE'])],
    ['operations', new Set(['SELECT', 'INSERT', 'UPDATE'])],
    ['audit_events', new Set(['SELECT', 'INSERT'])],
  ]);
  return {
    queries,
    async query(sql, parameters = []) {
      queries.push({ sql, parameters });
      const fingerprint = catalogFingerprintResult(sql);
      if (fingerprint) return fingerprint;
      if (/SELECT version, migration_hash/.test(sql)) {
        return { rowCount: 1, rows: [{ version: 1, migration_hash: migrationHash }] };
      }
      if (/SELECT to_regclass/.test(sql)) {
        return { rowCount: 1, rows: [{ relation_name: parameters[0] }] };
      }
      if (/FROM pg_catalog\.pg_trigger/.test(sql)) {
        return { rowCount: 2, rows: reviewedTriggerRows(parameters[0]) };
      }
      if (/FROM pg_catalog\.pg_inherits/.test(sql)) {
        return { rowCount: 0, rows: [] };
      }
      if (/FROM pg_catalog\.pg_rewrite/.test(sql)
        || /FROM pg_catalog\.pg_policy/.test(sql)
        || /JOIN pg_catalog\.pg_am/.test(sql)
        || /attribute\.attidentity/.test(sql)
        || /JOIN pg_catalog\.pg_collation/.test(sql)) {
        return { rowCount: 0, rows: [] };
      }
      if (/session_user\s+AS\s+session_role/i.test(sql)) {
        return {
          rowCount: 1,
          rows: [{
            current_role: 'risk_fork_runtime',
            session_role: 'risk_fork_runtime',
            can_login: true,
            is_superuser: false,
            can_create_db: false,
            can_create_role: false,
            can_replicate: false,
            can_bypass_rls: false,
            fsync: 'on',
            synchronous_commit: 'on',
            session_replication_role: 'origin',
          }],
        };
      }
      if (/pg_catalog\.pg_auth_members/.test(sql)) return { rowCount: 0, rows: [] };
      if (/has_database_privilege/.test(sql)) {
        return {
          rowCount: 1,
          rows: [{ has_connect: true, has_create: false, has_temporary: false }],
        };
      }
      if (/has_schema_privilege/.test(sql)) {
        return { rowCount: 1, rows: [{ has_usage: true, has_create: false }] };
      }
      if (/has_table_privilege/.test(sql)) {
        const relation = parameters[0].split('.').at(-1);
        const privilege = parameters[1];
        const allowed = required.get(relation)?.has(privilege)
          || (allowAuditUpdate && relation === 'audit_events' && privilege === 'UPDATE');
        return { rowCount: 1, rows: [{ allowed: Boolean(allowed) }] };
      }
      if (/has_any_column_privilege/.test(sql)) {
        return { rowCount: 1, rows: [{ allowed: false }] };
      }
      if (/has_function_privilege/.test(sql)) {
        return { rowCount: 1, rows: [{ allowed: false }] };
      }
      throw new Error(`Unexpected verification query: ${sql}`);
    },
  };
}

test('production authority requires pinned verified TLS and verify-only initialization', () => {
  assert.throws(
    () => new PostgresDistributedCommitAuthority({
      connectionString: CONNECTION_STRING,
      deploymentMode: 'production',
    }),
    (error) => error.code === 'POSTGRES_AUTHORITY_TLS_REQUIRED',
  );

  assert.throws(
    () => new PostgresDistributedCommitAuthority({
      connectionString: CONNECTION_STRING,
      deploymentMode: 'production',
      migrationMode: 'apply',
      tls: { ca: TEST_CA },
    }),
    (error) => error.code === 'POSTGRES_AUTHORITY_RUNTIME_DDL_FORBIDDEN',
  );

  const authority = new PostgresDistributedCommitAuthority({
    connectionString: CONNECTION_STRING,
    deploymentMode: 'production',
    tls: { ca: TEST_CA },
  });
  assert.equal(Object.isFrozen(authority), true);
});

test('authority connection URLs reject every query parameter before pg can override config', () => {
  for (const query of [
    'ssl=false',
    'sslmode=disable',
    'sslmode=verify-full',
    'sslrootcert=%2Ftmp%2Fother-ca.pem',
    'sslnegotiation=direct',
    'uselibpqcompat=true',
    'options=-c%20synchronous_commit%3Doff',
    'query_timeout=999999999',
    'statement_timeout=0',
    'lock_timeout=0',
    'idle_in_transaction_session_timeout=0',
    'application_name=forged',
    'replication=database',
    'unknown_parameter=unsafe-by-default',
  ]) {
    assert.throws(
      () => buildPostgresAuthorityPoolConfig({
        connectionString: `${CONNECTION_STRING}?${query}`,
        requireTls: true,
        tls: { ca: TEST_CA },
      }),
      (error) => error.code === 'POSTGRES_AUTHORITY_CONNECTION_PARAMETERS_FORBIDDEN',
      query,
    );
    assert.throws(
      () => buildPostgresAuthorityPoolConfig({
        connectionString: `${CONNECTION_STRING}?${query}`,
        requireTls: false,
      }),
      (error) => error.code === 'POSTGRES_AUTHORITY_CONNECTION_PARAMETERS_FORBIDDEN',
      `development:${query}`,
    );
  }
});

test('TLS servername overrides are rejected because pg does not honor them reliably', () => {
  assert.throws(
    () => buildPostgresAuthorityPoolConfig({
      connectionString: CONNECTION_STRING,
      requireTls: true,
      tls: { ca: TEST_CA, servername: 'certificate.internal' },
    }),
    (error) => error.code === 'POSTGRES_AUTHORITY_TLS_SERVERNAME_OVERRIDE_FORBIDDEN',
  );
});

test('verified TLS pool configuration always authenticates the certificate and hostname', () => {
  const config = buildPostgresAuthorityPoolConfig({
    connectionString: CONNECTION_STRING,
    requireTls: true,
    tls: { ca: TEST_CA },
    maxConnections: 7,
    connectionTimeoutMs: 4_000,
    statementTimeoutMs: 9_000,
    applicationName: 'risk-fork-contract',
  });

  assert.equal(config.connectionString, CONNECTION_STRING);
  assert.equal(config.max, 7);
  assert.equal(config.connectionTimeoutMillis, 4_000);
  assert.equal(config.query_timeout, 9_000);
  assert.equal(config.statement_timeout, 9_000);
  assert.equal(config.lock_timeout, 9_000);
  assert.equal(config.idle_in_transaction_session_timeout, 9_000);
  assert.deepEqual(config.ssl, {
    ca: TEST_CA,
    rejectUnauthorized: true,
  });
  assert.equal(config.options, SAFE_STARTUP_OPTIONS);
  assert.equal('checkServerIdentity' in config.ssl, false);

  const client = new pg.Client(config);
  assert.equal(client.connectionParameters.query_timeout, 9_000);
  assert.equal(client.connectionParameters.statement_timeout, 9_000);
  assert.equal(client.connectionParameters.lock_timeout, 9_000);
  assert.equal(client.connectionParameters.idle_in_transaction_session_timeout, 9_000);
  assert.equal(client.connectionParameters.application_name, 'risk-fork-contract');
  assert.equal(client.connectionParameters.replication, undefined);
  assert.equal(client.connectionParameters.options, SAFE_STARTUP_OPTIONS);
  assert.equal(client.connectionParameters.ssl.rejectUnauthorized, true);
  assert.equal(client.connectionParameters.ssl.ca, TEST_CA);
});

test('backend TLS verification fails closed when pg_stat_ssl does not prove encryption', async () => {
  const queries = [];
  const client = {
    async query(sql) {
      queries.push(sql);
      return { rowCount: 1, rows: [{ ssl: false }] };
    },
  };

  await assert.rejects(
    verifyPostgresAuthorityClientTransport(client, { requireTls: true }),
    (error) => error.code === 'POSTGRES_AUTHORITY_TLS_NOT_VERIFIED',
  );
  assert.equal(queries.length, 1);
  assert.match(queries[0], /pg_stat_ssl/);
  assert.match(queries[0], /pg_backend_pid\(\)/);
});

test('backend TLS verification rejects durability and trigger-mode downgrades', async () => {
  for (const [field, value] of [
    ['fsync', 'off'],
    ['synchronous_commit', 'off'],
    ['session_replication_role', 'replica'],
  ]) {
    const client = {
      async query() {
        return {
          rowCount: 1,
          rows: [{
            ssl: true,
            version: 'TLSv1.3',
            cipher: 'test',
            fsync: 'on',
            synchronous_commit: 'on',
            session_replication_role: 'origin',
            [field]: value,
          }],
        };
      },
    };
    await assert.rejects(
      verifyPostgresAuthorityClientTransport(client, { requireTls: true }),
      (error) => error.code === 'POSTGRES_AUTHORITY_SESSION_SETTINGS_INVALID',
      `${field}=${value}`,
    );
  }
});

test('runtime adapter contains no migration DDL and the dedicated migrator owns it', async () => {
  const runtimeSource = await readFile(
    new URL('../src/adapters/postgres-authority.mjs', import.meta.url),
    'utf8',
  );
  const migratorSource = await readFile(
    new URL('../src/adapters/postgres-authority-migrator.mjs', import.meta.url),
    'utf8',
  );

  assert.doesNotMatch(runtimeSource, /CREATE\s+(?:SCHEMA|TABLE)/i);
  assert.match(migratorSource, /CREATE\s+SCHEMA/i);
  assert.match(migratorSource, /authority_schema_migrations/);
  assert.match(runtimeSource, /verifyPostgresDistributedAuthoritySchema/);
});

test('authority status contract is bounded, read-only, exact, and unavailable before initialization', async () => {
  const authority = new PostgresDistributedCommitAuthority({
    connectionString: CONNECTION_STRING,
  });
  assert.equal(typeof authority.getAuthorityStatus, 'function');
  assert.throws(
    () => authority.getAuthorityStatus(),
    /PostgreSQL distributed authority is not initialized/,
  );

  const runtimeSource = await readFile(
    new URL('../src/adapters/postgres-authority.mjs', import.meta.url),
    'utf8',
  );
  const start = runtimeSource.indexOf('async function getAuthorityStatus(state)');
  const end = runtimeSource.indexOf('\nasync function ', start + 1);
  assert.notEqual(start, -1);
  const implementation = runtimeSource.slice(start, end === -1 ? runtimeSource.length : end);
  assert.match(implementation, /BEGIN READ ONLY/);
  assert.match(implementation, /SET LOCAL statement_timeout/);
  assert.match(implementation, /verifyPostgresDistributedAuthoritySchema\(client/);
  assert.match(implementation, /status IN \('prepared', 'effect_started', 'ambiguous'\)/);
  assert.doesNotMatch(implementation, /\b(?:INSERT|UPDATE|DELETE|CREATE|ALTER|DROP|GRANT|REVOKE)\b/i);
  assert.equal(Object.isFrozen(PostgresDistributedCommitAuthority.prototype), true);
});

test('verify-only schema check performs no DDL and enforces runtime privilege negatives', async () => {
  const migrationHash = await reviewedMigrationHash();
  const accepted = schemaVerificationClient(migrationHash);
  const report = await verifyPostgresDistributedAuthoritySchema(accepted, {
    schemaName: 'contract_authority',
    verifyRuntimePrivileges: true,
  });

  assert.equal(report.runtime_privileges_verified, true);
  assert.deepEqual(report.migration_versions, [1]);
  assert.equal(
    accepted.queries.some(({ sql }) => /^\s*(?:CREATE|ALTER|DROP|GRANT|REVOKE)\b/i.test(sql)),
    false,
  );

  const overprivileged = schemaVerificationClient(migrationHash, { allowAuditUpdate: true });
  await assert.rejects(
    verifyPostgresDistributedAuthoritySchema(overprivileged, {
      schemaName: 'contract_authority',
      verifyRuntimePrivileges: true,
    }),
    (error) => error.code === 'DISTRIBUTED_AUTHORITY_RUNTIME_PRIVILEGES_INVALID'
      && error.evidence?.relation === 'audit_events'
      && error.evidence?.privilege === 'UPDATE',
  );
});

test('schema verification rejects replica-only audit triggers', async () => {
  const migrationHash = await reviewedMigrationHash();
  const client = schemaVerificationClient(migrationHash);
  const originalQuery = client.query.bind(client);
  client.query = async (sql, parameters = []) => {
    const result = await originalQuery(sql, parameters);
    if (/FROM pg_catalog\.pg_trigger/.test(sql)) {
      result.rows[0].tgenabled = 'R';
    }
    return result;
  };
  await assert.rejects(
    verifyPostgresDistributedAuthoritySchema(client, { schemaName: 'contract_authority' }),
    (error) => error.code === 'DISTRIBUTED_AUTHORITY_SCHEMA_INVALID',
  );
});

test('schema verification rejects a same-name trigger bound to another function', async () => {
  const migrationHash = await reviewedMigrationHash();
  const client = schemaVerificationClient(migrationHash);
  const originalQuery = client.query.bind(client);
  client.query = async (sql, parameters = []) => {
    const result = await originalQuery(sql, parameters);
    if (/FROM pg_catalog\.pg_trigger/.test(sql)) {
      result.rows[0].function_name = 'allow_audit_mutation';
    }
    return result;
  };
  await assert.rejects(
    verifyPostgresDistributedAuthoritySchema(client, { schemaName: 'contract_authority' }),
    (error) => error.code === 'DISTRIBUTED_AUTHORITY_SCHEMA_INVALID',
  );
});

test('schema verification rejects views masquerading as authority tables', async () => {
  const migrationHash = await reviewedMigrationHash();
  const client = schemaVerificationClient(migrationHash);
  const originalQuery = client.query.bind(client);
  client.query = async (sql, parameters = []) => {
    if (/FROM pg_catalog\.pg_class/.test(sql)) {
      return {
        rowCount: 7,
        rows: [
          { relation_name: 'authority_schema_migrations', relkind: 'v' },
          ...[
            'authority_meta',
            'parent_heads',
            'commit_approvals',
            'execution_authorizations',
            'operations',
            'audit_events',
          ].map((relationName) => ({ relation_name: relationName, relkind: 'r' })),
        ],
      };
    }
    return originalQuery(sql, parameters);
  };
  await assert.rejects(
    verifyPostgresDistributedAuthoritySchema(client, { schemaName: 'contract_authority' }),
    (error) => error.code === 'DISTRIBUTED_AUTHORITY_SCHEMA_INVALID',
  );
});

test('schema verification rejects inheritance edges involving authority relations', async () => {
  const migrationHash = await reviewedMigrationHash();
  const client = schemaVerificationClient(migrationHash);
  const originalQuery = client.query.bind(client);
  client.query = async (sql, parameters = []) => {
    if (/FROM pg_catalog\.pg_inherits/.test(sql)) {
      return {
        rowCount: 1,
        rows: [{
          parent_schema: 'contract_authority',
          parent_relation: 'authority_meta',
          child_schema: 'attacker',
          child_relation: 'authority_meta_shadow',
        }],
      };
    }
    return originalQuery(sql, parameters);
  };
  await assert.rejects(
    verifyPostgresDistributedAuthoritySchema(client, { schemaName: 'contract_authority' }),
    (error) => error.code === 'DISTRIBUTED_AUTHORITY_SCHEMA_INVALID'
      && error.evidence?.scope === 'inheritance',
  );
});

test('schema verification rejects rewrite rules, row policies, storage drift, generated columns, and collations', async (t) => {
  const migrationHash = await reviewedMigrationHash();
  const scenarios = [
    {
      name: 'rewrite rule',
      pattern: /FROM pg_catalog\.pg_rewrite/,
      scope: 'rewrite_rules',
      row: { relation_name: 'audit_events', rule_name: 'suppress_audit_insert' },
    },
    {
      name: 'row-security policy',
      pattern: /FROM pg_catalog\.pg_policy/,
      scope: 'row_security_policies',
      row: { relation_name: 'authority_meta', policy_name: 'dormant_policy' },
    },
    {
      name: 'relation options or access method',
      pattern: /JOIN pg_catalog\.pg_am/,
      scope: 'table_storage',
      row: {
        relation_name: 'authority_meta',
        relkind: 'r',
        access_method: 'unexpected',
        reloptions: ['fillfactor=70'],
      },
    },
    {
      name: 'identity or generated column',
      pattern: /attribute\.attidentity/,
      scope: 'generated_columns',
      row: {
        relation_name: 'audit_events',
        column_name: 'sequence',
        identity_kind: 'a',
        generated_kind: '',
      },
    },
    {
      name: 'non-default or nondeterministic column collation',
      pattern: /JOIN pg_catalog\.pg_collation/,
      scope: 'column_collation',
      row: {
        relation_name: 'operations',
        column_name: 'status',
        collation_schema: 'pg_catalog',
        collation_name: 'C',
        deterministic: true,
      },
    },
  ];
  for (const scenario of scenarios) {
    await t.test(scenario.name, async () => {
      const client = schemaVerificationClient(migrationHash);
      const originalQuery = client.query.bind(client);
      client.query = async (sql, parameters = []) => {
        if (scenario.pattern.test(sql)) {
          return { rowCount: 1, rows: [scenario.row] };
        }
        return originalQuery(sql, parameters);
      };
      await assert.rejects(
        verifyPostgresDistributedAuthoritySchema(client, {
          schemaName: 'contract_authority',
        }),
        (error) => error.code === 'DISTRIBUTED_AUTHORITY_SCHEMA_INVALID'
          && error.evidence?.scope === scenario.scope,
      );
    });
  }
});

test('relation RLS flags and column default expressions remain fingerprint-bound', async (t) => {
  const migrationHash = await reviewedMigrationHash();
  for (const drift of ['row-security flags', 'column default expression']) {
    await t.test(drift, async () => {
      const client = schemaVerificationClient(migrationHash);
      const originalQuery = client.query.bind(client);
      client.query = async (sql, parameters = []) => {
        if (/FROM pg_catalog\.pg_class AS relation/.test(sql)
          && /pg_catalog\.pg_attribute AS attribute/.test(sql)
          && /\bAS fingerprint\b/.test(sql)) {
          return {
            rowCount: 1,
            rows: [{
              item_count: CATALOG_FINGERPRINTS.pg_attribute.item_count,
              fingerprint: '0'.repeat(64),
            }],
          };
        }
        return originalQuery(sql, parameters);
      };
      await assert.rejects(
        verifyPostgresDistributedAuthoritySchema(client, {
          schemaName: 'contract_authority',
        }),
        (error) => error.code === 'DISTRIBUTED_AUTHORITY_SCHEMA_INVALID'
          && error.evidence?.scope === 'relations_and_columns',
      );
    });
  }
});

test('runtime privilege verification rejects role switching and privileged memberships', async () => {
  const migrationHash = await reviewedMigrationHash();
  for (const scenario of ['switched_session', 'membership']) {
    const client = schemaVerificationClient(migrationHash);
    const originalQuery = client.query.bind(client);
    client.query = async (sql, parameters = []) => {
      if (/session_user\s+AS\s+session_role/i.test(sql)) {
        return {
          rowCount: 1,
          rows: [{
            current_role: 'risk_fork_runtime',
            session_role: scenario === 'switched_session' ? 'risk_fork_owner' : 'risk_fork_runtime',
            can_login: true,
            is_superuser: false,
            can_create_db: false,
            can_create_role: false,
            can_replicate: false,
            can_bypass_rls: false,
            fsync: 'on',
            synchronous_commit: 'on',
            session_replication_role: 'origin',
          }],
        };
      }
      if (/pg_catalog\.pg_auth_members/.test(sql)) {
        return scenario === 'membership'
          ? { rowCount: 1, rows: [{ role_name: 'risk_fork_migrator' }] }
          : { rowCount: 0, rows: [] };
      }
      if (/has_database_privilege/.test(sql)) {
        return {
          rowCount: 1,
          rows: [{ has_connect: true, has_create: false, has_temporary: false }],
        };
      }
      if (/has_any_column_privilege/.test(sql)) {
        return { rowCount: 1, rows: [{ allowed: false }] };
      }
      return originalQuery(sql, parameters);
    };
    await assert.rejects(
      verifyPostgresDistributedAuthoritySchema(client, {
        schemaName: 'contract_authority',
        verifyRuntimePrivileges: true,
      }),
      (error) => error.code === 'DISTRIBUTED_AUTHORITY_RUNTIME_PRIVILEGES_INVALID',
      scenario,
    );
  }
});

test('runtime privilege verification rejects forbidden column-level grants', async () => {
  const migrationHash = await reviewedMigrationHash();
  for (const [relationName, privilege] of [
    ['authority_schema_migrations', 'UPDATE'],
    ['audit_events', 'UPDATE'],
  ]) {
    const client = schemaVerificationClient(migrationHash);
    const originalQuery = client.query.bind(client);
    client.query = async (sql, parameters = []) => {
      if (/session_user\s+AS\s+session_role/i.test(sql)) {
        return {
          rowCount: 1,
          rows: [{
            current_role: 'risk_fork_runtime',
            session_role: 'risk_fork_runtime',
            can_login: true,
            is_superuser: false,
            can_create_db: false,
            can_create_role: false,
            can_replicate: false,
            can_bypass_rls: false,
            fsync: 'on',
            synchronous_commit: 'on',
            session_replication_role: 'origin',
          }],
        };
      }
      if (/pg_catalog\.pg_auth_members/.test(sql)) return { rowCount: 0, rows: [] };
      if (/has_database_privilege/.test(sql)) {
        return {
          rowCount: 1,
          rows: [{ has_connect: true, has_create: false, has_temporary: false }],
        };
      }
      if (/has_any_column_privilege/.test(sql)) {
        const relation = parameters[0].split('.').at(-1);
        return {
          rowCount: 1,
          rows: [{ allowed: relation === relationName && parameters[1] === privilege }],
        };
      }
      return originalQuery(sql, parameters);
    };
    await assert.rejects(
      verifyPostgresDistributedAuthoritySchema(client, {
        schemaName: 'contract_authority',
        verifyRuntimePrivileges: true,
      }),
      (error) => error.code === 'DISTRIBUTED_AUTHORITY_RUNTIME_PRIVILEGES_INVALID'
        && error.evidence?.relation === relationName
        && error.evidence?.privilege === privilege,
      `${relationName}.${privilege}`,
    );
  }
});

test('secure migrator rejects a pool whose CA and hostname policy was not constructed internally', async () => {
  let connects = 0;
  const client = {
    async query(sql) {
      if (/pg_catalog\.pg_stat_ssl/.test(sql)) {
        return { rowCount: 1, rows: [{ ssl: true, version: 'TLSv1.3', cipher: 'test' }] };
      }
      return { rowCount: 0, rows: [] };
    },
    release() {},
  };
  const pool = {
    async connect() {
      connects += 1;
      return client;
    },
  };
  await assert.rejects(
    migratePostgresDistributedAuthority({
      pool,
      schemaName: 'contract_authority',
      requireTls: true,
    }),
    (error) => error.code === 'POSTGRES_AUTHORITY_TLS_POOL_UNTRUSTED',
  );
  assert.equal(connects, 0);
});

test('dedicated migrator owns DDL and releases but does not close an injected pool', async () => {
  const migrationHash = await reviewedMigrationHash();
  let applied = false;
  let releases = 0;
  let poolEnds = 0;
  const queries = [];
  const client = {
    async query(sql, parameters = []) {
      queries.push({ sql, parameters });
      const fingerprint = catalogFingerprintResult(sql);
      if (fingerprint) return fingerprint;
      if (/SELECT version, migration_hash/.test(sql)) {
        return applied
          ? { rowCount: 1, rows: [{ version: 1, migration_hash: migrationHash }] }
          : { rowCount: 0, rows: [] };
      }
      if (/INSERT INTO .*authority_schema_migrations/.test(sql)) applied = true;
      if (/SELECT to_regclass/.test(sql)) {
        return { rowCount: 1, rows: [{ relation_name: parameters[0] }] };
      }
      if (/FROM pg_catalog\.pg_trigger/.test(sql)) {
        return { rowCount: 2, rows: reviewedTriggerRows(parameters[0]) };
      }
      return { rowCount: 0, rows: [] };
    },
    release() {
      releases += 1;
    },
  };
  const pool = {
    async connect() {
      return client;
    },
    async end() {
      poolEnds += 1;
    },
  };

  const result = await migratePostgresDistributedAuthority({
    pool,
    schemaName: 'contract_authority',
    requireTls: false,
  });

  assert.equal(result.migrations[0].status, 'applied');
  assert.equal(releases, 1);
  assert.equal(poolEnds, 0);
  assert.equal(queries.some(({ sql }) => /CREATE SCHEMA IF NOT EXISTS/.test(sql)), true);
  assert.equal(queries.some(({ sql }) => /CREATE TABLE IF NOT EXISTS/.test(sql)), true);
  assert.equal(
    queries.some(({ sql }) => /SET LOCAL statement_timeout = 30000/.test(sql)),
    true,
  );
  assert.equal(
    queries.some(({ sql }) => /SET LOCAL lock_timeout = 30000/.test(sql)),
    true,
  );
  assert.equal(
    queries.some(({ sql }) => /SET LOCAL idle_in_transaction_session_timeout = 30000/.test(sql)),
    true,
  );
  assert.equal(
    queries.findIndex(({ sql }) => /SET LOCAL lock_timeout/.test(sql))
      < queries.findIndex(({ sql }) => /pg_advisory_xact_lock/.test(sql)),
    true,
  );
  assert.equal(queries.some(({ sql }) => /COMMIT/.test(sql)), true);
});

test('migration 001 stays byte-for-byte frozen', async () => {
  const source = await readFile(
    new URL('../migrations/001_distributed_authority.pg.sql', import.meta.url),
  );
  const digest = createHash('sha256').update(source).digest('hex');
  assert.equal(digest, '6dabb296a6e58ed9ffc28c520cd24d8a7f5ce992e3f080828a87ec7ab071adf6');
});

test('owner bootstrap and migrator post-grants form an executable non-circular role sequence', async () => {
  const bootstrap = await readFile(
    new URL('../ops/postgres/owner-bootstrap.sql.template', import.meta.url),
    'utf8',
  );
  const grants = await readFile(
    new URL('../ops/postgres/roles.sql.template', import.meta.url),
    'utf8',
  );

  assert.match(bootstrap, /GRANT CONNECT, CREATE ON DATABASE __RISK_FORK_DATABASE__/);
  assert.match(bootstrap, /CREATE SCHEMA IF NOT EXISTS __RISK_FORK_SCHEMA__/);
  assert.match(bootstrap, /REVOKE ALL ON SCHEMA __RISK_FORK_SCHEMA__ FROM PUBLIC/);
  assert.match(bootstrap, /GRANT USAGE ON SCHEMA __RISK_FORK_SCHEMA__/);
  assert.doesNotMatch(grants, /GRANT CONNECT|CREATE SCHEMA/);
  assert.match(
    grants,
    /GRANT SELECT ON TABLE\s+__RISK_FORK_SCHEMA__\.authority_schema_migrations/,
  );
  assert.match(grants, /GRANT SELECT, INSERT ON TABLE __RISK_FORK_SCHEMA__\.audit_events/);
  assert.match(grants, /REVOKE UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER[\s\S]*audit_events/);
  assert.match(grants, /REVOKE ALL PRIVILEGES \(%s\) ON TABLE/);
  assert.doesNotMatch(grants, /ALTER DEFAULT PRIVILEGES FOR ROLE/);
  assert.doesNotMatch(grants, /GRANT ALL[^;]*__RISK_FORK_RUNTIME_ROLE__/);
});
