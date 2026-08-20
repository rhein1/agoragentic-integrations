import { readFile } from 'node:fs/promises';

import { sha256Ref } from '../canonical.mjs';
import { distributedAuthorityError } from '../distributed-authority.mjs';
import {
  assertAllowedKeys,
  assertPlainObject,
  deepFreeze,
  requireString,
  safeEqual,
} from '../util.mjs';

const MIGRATIONS = Object.freeze([
  Object.freeze({
    version: 1,
    url: new URL('../../migrations/001_distributed_authority.pg.sql', import.meta.url),
  }),
]);
const SAFE_STARTUP_OPTIONS = '-c synchronous_commit=on -c search_path=pg_catalog';
const REQUIRED_RELATIONS = Object.freeze([
  'authority_schema_migrations',
  'authority_meta',
  'parent_heads',
  'commit_approvals',
  'execution_authorizations',
  'operations',
  'audit_events',
]);
const EXPECTED_CATALOG_FINGERPRINTS = Object.freeze({
  columns: Object.freeze({
    count: 100,
    sha256: 'f68ab21d7b0e7db35cfc75450d75b5317851646bd443f02b3171fd5064ff02cc',
  }),
  constraints: Object.freeze({
    count: 74,
    sha256: 'd851c63225a61275a594364b1cc7c170695f7a62ad46a435fa6fd560ce898a99',
  }),
  indexes: Object.freeze({
    count: 12,
    sha256: 'e3a4a48cdc774298e1f28eb51915fae3520e6fae138f3079f44ee7a396acf849',
  }),
});
const EXPECTED_AUDIT_FUNCTION_BODY = [
  'BEGIN',
  "  RAISE EXCEPTION 'risk fork authority audit events are append-only'",
  "    USING ERRCODE = '55000';",
  'END;',
].join('\n');
const RUNTIME_TABLE_PRIVILEGES = Object.freeze({
  authority_schema_migrations: Object.freeze({
    required: Object.freeze(['SELECT']),
    forbidden: Object.freeze(['INSERT', 'UPDATE', 'DELETE', 'TRUNCATE', 'REFERENCES', 'TRIGGER']),
  }),
  authority_meta: Object.freeze({
    required: Object.freeze(['SELECT', 'INSERT', 'UPDATE']),
    forbidden: Object.freeze(['DELETE', 'TRUNCATE', 'REFERENCES', 'TRIGGER']),
  }),
  parent_heads: Object.freeze({
    required: Object.freeze(['SELECT', 'INSERT', 'UPDATE']),
    forbidden: Object.freeze(['DELETE', 'TRUNCATE', 'REFERENCES', 'TRIGGER']),
  }),
  commit_approvals: Object.freeze({
    required: Object.freeze(['SELECT', 'INSERT', 'UPDATE']),
    forbidden: Object.freeze(['DELETE', 'TRUNCATE', 'REFERENCES', 'TRIGGER']),
  }),
  execution_authorizations: Object.freeze({
    required: Object.freeze(['SELECT', 'INSERT', 'UPDATE']),
    forbidden: Object.freeze(['DELETE', 'TRUNCATE', 'REFERENCES', 'TRIGGER']),
  }),
  operations: Object.freeze({
    required: Object.freeze(['SELECT', 'INSERT', 'UPDATE']),
    forbidden: Object.freeze(['DELETE', 'TRUNCATE', 'REFERENCES', 'TRIGGER']),
  }),
  audit_events: Object.freeze({
    required: Object.freeze(['SELECT', 'INSERT']),
    forbidden: Object.freeze(['UPDATE', 'DELETE', 'TRUNCATE', 'REFERENCES', 'TRIGGER']),
  }),
});

function configurationError(message, code) {
  const error = new TypeError(message);
  error.code = code;
  return error;
}

function requireBoolean(value, label) {
  if (typeof value !== 'boolean') throw new TypeError(`${label} must be a boolean`);
  return value;
}

function requireInteger(value, label, min, max) {
  if (!Number.isSafeInteger(value) || value < min || value > max) {
    throw new TypeError(`${label} must be an integer between ${min} and ${max}`);
  }
  return value;
}

function parseAuthorityConnectionUrl(connectionString) {
  let url;
  try {
    url = new URL(connectionString);
  } catch {
    throw configurationError(
      'PostgreSQL authority requires an absolute postgres connection URL',
      'POSTGRES_AUTHORITY_CONNECTION_STRING_INVALID',
    );
  }
  if (!['postgres:', 'postgresql:'].includes(url.protocol) || url.hostname.length === 0) {
    throw configurationError(
      'PostgreSQL authority requires a network postgres connection URL',
      'POSTGRES_AUTHORITY_CONNECTION_STRING_INVALID',
    );
  }
  if ([...url.searchParams.keys()].length !== 0) {
    throw configurationError(
      'PostgreSQL authority connection URLs must not contain query parameters',
      'POSTGRES_AUTHORITY_CONNECTION_PARAMETERS_FORBIDDEN',
    );
  }
  return url;
}

function normalizeTlsOptions(tls, requireTls) {
  if (tls == null) {
    if (requireTls) {
      throw configurationError(
        'Production PostgreSQL authority requires a pinned TLS certificate authority',
        'POSTGRES_AUTHORITY_TLS_REQUIRED',
      );
    }
    return null;
  }
  assertPlainObject(tls, 'PostgreSQL authority TLS options');
  if (Object.hasOwn(tls, 'servername')) {
    throw configurationError(
      'PostgreSQL TLS servername overrides are not supported; the connection URL host must match the certificate',
      'POSTGRES_AUTHORITY_TLS_SERVERNAME_OVERRIDE_FORBIDDEN',
    );
  }
  assertAllowedKeys(tls, ['ca'], 'PostgreSQL authority TLS options');
  const normalized = {
    ca: requireString(tls.ca, 'PostgreSQL authority TLS CA', { maxLength: 1_048_576 }),
    rejectUnauthorized: true,
  };
  return normalized;
}

export function quotePostgresAuthorityIdentifier(value, label = 'PostgreSQL schema name') {
  const normalized = requireString(value, label, { maxLength: 63 });
  if (!/^[a-z_][a-z0-9_]*$/.test(normalized)) {
    throw new TypeError(`${label} must be a lowercase PostgreSQL identifier`);
  }
  return `"${normalized}"`;
}

export function buildPostgresAuthorityPoolConfig(options = {}) {
  assertPlainObject(options, 'PostgreSQL authority pool options');
  assertAllowedKeys(options, [
    'connectionString',
    'requireTls',
    'tls',
    'maxConnections',
    'connectionTimeoutMs',
    'statementTimeoutMs',
    'applicationName',
  ], 'PostgreSQL authority pool options');
  const connectionString = requireString(
    options.connectionString,
    'PostgreSQL connection string',
    { maxLength: 8192 },
  );
  parseAuthorityConnectionUrl(connectionString);
  const requireTls = requireBoolean(options.requireTls ?? false, 'requireTls');
  const maxConnections = requireInteger(
    options.maxConnections ?? 16,
    'maxConnections',
    1,
    100,
  );
  const connectionTimeoutMs = requireInteger(
    options.connectionTimeoutMs ?? 5_000,
    'connectionTimeoutMs',
    100,
    120_000,
  );
  const statementTimeoutMs = requireInteger(
    options.statementTimeoutMs ?? 30_000,
    'statementTimeoutMs',
    100,
    300_000,
  );
  const applicationName = requireString(
    options.applicationName ?? 'agoragentic-risk-fork-authority',
    'PostgreSQL application name',
    { maxLength: 63 },
  );
  const ssl = normalizeTlsOptions(options.tls ?? null, requireTls);
  return {
    connectionString,
    max: maxConnections,
    connectionTimeoutMillis: connectionTimeoutMs,
    query_timeout: statementTimeoutMs,
    statement_timeout: statementTimeoutMs,
    lock_timeout: statementTimeoutMs,
    idle_in_transaction_session_timeout: statementTimeoutMs,
    application_name: applicationName,
    options: SAFE_STARTUP_OPTIONS,
    ...(ssl ? { ssl } : {}),
  };
}

async function loadPoolConstructor() {
  let postgres;
  try {
    postgres = await import('pg');
  } catch (error) {
    const unavailable = new Error('The PostgreSQL authority requires the reviewed pg package');
    unavailable.code = 'POSTGRES_AUTHORITY_DRIVER_UNAVAILABLE';
    unavailable.cause = error;
    throw unavailable;
  }
  const Pool = postgres.Pool ?? postgres.default?.Pool;
  if (typeof Pool !== 'function') throw new Error('The pg package does not export Pool');
  return Pool;
}

export async function createPostgresAuthorityPool(options = {}) {
  const Pool = await loadPoolConstructor();
  return new Pool(buildPostgresAuthorityPoolConfig(options));
}

export async function verifyPostgresAuthorityClientTransport(
  client,
  options = {},
) {
  if (!client || typeof client.query !== 'function') {
    throw new TypeError('PostgreSQL authority client must provide query()');
  }
  assertPlainObject(options, 'PostgreSQL authority transport verification options');
  assertAllowedKeys(
    options,
    ['requireTls'],
    'PostgreSQL authority transport verification options',
  );
  const requireTls = requireBoolean(options.requireTls ?? false, 'requireTls');
  if (!requireTls) return deepFreeze({ tls_verified: false });
  let result;
  try {
    result = await client.query(
      `SELECT ssl, version, cipher,
              current_setting('fsync') AS fsync,
              current_setting('synchronous_commit') AS synchronous_commit,
              current_setting('session_replication_role') AS session_replication_role
         FROM pg_catalog.pg_stat_ssl
        WHERE pid = pg_backend_pid()`,
    );
  } catch {
    throw distributedAuthorityError(
      'PostgreSQL did not provide verifiable TLS transport evidence',
      'POSTGRES_AUTHORITY_TLS_NOT_VERIFIED',
      {},
    );
  }
  if (result.rowCount !== 1 || result.rows[0]?.ssl !== true) {
    throw distributedAuthorityError(
      'PostgreSQL authority transport is not TLS verified',
      'POSTGRES_AUTHORITY_TLS_NOT_VERIFIED',
      {},
    );
  }
  const settings = result.rows[0];
  if (settings.fsync !== 'on'
    || settings.synchronous_commit !== 'on'
    || settings.session_replication_role !== 'origin') {
    throw distributedAuthorityError(
      'PostgreSQL authority durability or trigger settings are unsafe',
      'POSTGRES_AUTHORITY_SESSION_SETTINGS_INVALID',
      {
        fsync: settings.fsync ?? null,
        synchronous_commit: settings.synchronous_commit ?? null,
        session_replication_role: settings.session_replication_role ?? null,
      },
    );
  }
  return deepFreeze({
    tls_verified: true,
    protocol: typeof result.rows[0].version === 'string' ? result.rows[0].version : null,
    cipher: typeof result.rows[0].cipher === 'string' ? result.rows[0].cipher : null,
    durability_verified: true,
    trigger_mode_verified: true,
  });
}

export async function acquirePostgresAuthorityClient(
  pool,
  options = {},
) {
  if (!pool || typeof pool.connect !== 'function') {
    throw new TypeError('PostgreSQL authority pool must provide connect()');
  }
  assertPlainObject(options, 'PostgreSQL authority client acquisition options');
  assertAllowedKeys(
    options,
    ['requireTls', 'verifiedClients'],
    'PostgreSQL authority client acquisition options',
  );
  const requireTls = requireBoolean(options.requireTls ?? false, 'requireTls');
  const verifiedClients = options.verifiedClients ?? new WeakSet();
  if (!(verifiedClients instanceof WeakSet)) {
    throw new TypeError('verifiedClients must be a WeakSet');
  }
  const client = await pool.connect();
  try {
    if (!verifiedClients.has(client)) {
      await verifyPostgresAuthorityClientTransport(client, { requireTls });
      verifiedClients.add(client);
    }
    return client;
  } catch (error) {
    client.release();
    throw error;
  }
}

async function loadMigrationPlan(schemaName) {
  const quotedSchema = quotePostgresAuthorityIdentifier(schemaName);
  const plan = [];
  for (const migration of MIGRATIONS) {
    const template = (await readFile(migration.url, 'utf8')).replace(/\r\n?/g, '\n');
    plan.push(Object.freeze({
      version: migration.version,
      migration_hash: sha256Ref(template),
      sql: template.replaceAll('__RISK_FORK_SCHEMA__', quotedSchema),
    }));
  }
  return Object.freeze(plan);
}

function tableName(schemaName, relationName) {
  return `${schemaName}.${relationName}`;
}

function migrationMismatch(message, code, schemaName, details = {}) {
  return distributedAuthorityError(message, code, {
    schema_name: schemaName,
    ...details,
  });
}

async function readAppliedMigrations(client, schemaName, quotedSchema) {
  try {
    return await client.query(
      `SELECT version, migration_hash
         FROM ${quotedSchema}.authority_schema_migrations
        ORDER BY version ASC`,
    );
  } catch {
    throw migrationMismatch(
      'PostgreSQL authority schema is not initialized',
      'DISTRIBUTED_AUTHORITY_SCHEMA_UNAVAILABLE',
      schemaName,
    );
  }
}

async function verifyMigrationSet(client, schemaName, quotedSchema, plan) {
  const applied = await readAppliedMigrations(client, schemaName, quotedSchema);
  if (applied.rowCount !== plan.length) {
    throw migrationMismatch(
      'Applied PostgreSQL authority migrations differ from the reviewed set',
      'DISTRIBUTED_AUTHORITY_MIGRATION_SET_MISMATCH',
      schemaName,
      { expected_count: plan.length, observed_count: applied.rowCount },
    );
  }
  for (let index = 0; index < plan.length; index += 1) {
    const expected = plan[index];
    const observed = applied.rows[index];
    if (Number.parseInt(observed?.version, 10) !== expected.version
      || !safeEqual(observed?.migration_hash, expected.migration_hash)) {
      throw migrationMismatch(
        'Applied PostgreSQL authority migration differs from the reviewed source',
        'DISTRIBUTED_AUTHORITY_MIGRATION_HASH_MISMATCH',
        schemaName,
        { version: expected.version },
      );
    }
  }
}

function assertCatalogFingerprint(result, expected, schemaName, scope) {
  const row = result.rowCount === 1 ? result.rows[0] : null;
  const count = Number.parseInt(row?.item_count, 10);
  if (count !== expected.count || row?.fingerprint !== expected.sha256) {
    throw migrationMismatch(
      'PostgreSQL authority catalog differs from the reviewed migration',
      'DISTRIBUTED_AUTHORITY_SCHEMA_INVALID',
      schemaName,
      {
        scope,
        expected_count: expected.count,
        observed_count: Number.isSafeInteger(count) ? count : null,
      },
    );
  }
}

async function verifyRequiredRelations(client, schemaName) {
  const columns = await client.query(
    `SELECT count(*)::integer AS item_count,
            pg_catalog.encode(pg_catalog.sha256(pg_catalog.convert_to(
              COALESCE(pg_catalog.string_agg(
                pg_catalog.concat_ws('|', relation.relname, relation.relkind,
                  relation.relpersistence, relation.relrowsecurity::text,
                  relation.relforcerowsecurity::text, relation.relreplident,
                  attribute.attnum::text, attribute.attname,
                  pg_catalog.format_type(attribute.atttypid, attribute.atttypmod),
                  attribute.attnotnull::text,
                  COALESCE(pg_catalog.pg_get_expr(default_value.adbin,
                    default_value.adrelid, true), '')),
                E'\\n' ORDER BY relation.relname, attribute.attnum), ''),
              'UTF8')), 'hex') AS fingerprint
       FROM pg_catalog.pg_class AS relation
       JOIN pg_catalog.pg_namespace AS namespace
         ON namespace.oid = relation.relnamespace
       JOIN pg_catalog.pg_attribute AS attribute
         ON attribute.attrelid = relation.oid
        AND attribute.attnum > 0
        AND NOT attribute.attisdropped
       LEFT JOIN pg_catalog.pg_attrdef AS default_value
         ON default_value.adrelid = relation.oid
        AND default_value.adnum = attribute.attnum
      WHERE namespace.nspname = $1
        AND relation.relname = ANY($2::text[])`,
    [schemaName, REQUIRED_RELATIONS],
  );
  assertCatalogFingerprint(
    columns,
    EXPECTED_CATALOG_FINGERPRINTS.columns,
    schemaName,
    'relations_and_columns',
  );

  const constraints = await client.query(
    `SELECT count(*)::integer AS item_count,
            pg_catalog.encode(pg_catalog.sha256(pg_catalog.convert_to(
              COALESCE(pg_catalog.string_agg(
                pg_catalog.concat_ws('|', relation.relname, constraint_record.conname,
                  constraint_record.contype, constraint_record.convalidated::text,
                  constraint_record.condeferrable::text,
                  constraint_record.condeferred::text,
                  pg_catalog.replace(
                    pg_catalog.pg_get_constraintdef(constraint_record.oid, true),
                    pg_catalog.format('%I.', $1::text), '__schema__.')),
                E'\\n' ORDER BY relation.relname, constraint_record.conname), ''),
              'UTF8')), 'hex') AS fingerprint
       FROM pg_catalog.pg_constraint AS constraint_record
       JOIN pg_catalog.pg_class AS relation
         ON relation.oid = constraint_record.conrelid
       JOIN pg_catalog.pg_namespace AS namespace
         ON namespace.oid = relation.relnamespace
      WHERE namespace.nspname = $1
        AND relation.relname = ANY($2::text[])`,
    [schemaName, REQUIRED_RELATIONS],
  );
  assertCatalogFingerprint(
    constraints,
    EXPECTED_CATALOG_FINGERPRINTS.constraints,
    schemaName,
    'constraints',
  );

  const indexes = await client.query(
    `SELECT count(*)::integer AS item_count,
            pg_catalog.encode(pg_catalog.sha256(pg_catalog.convert_to(
              COALESCE(pg_catalog.string_agg(
                pg_catalog.concat_ws('|', relation.relname, index_relation.relname,
                  index_record.indisunique::text, index_record.indisprimary::text,
                  index_record.indisvalid::text, index_record.indisready::text,
                  pg_catalog.replace(pg_catalog.pg_get_indexdef(index_relation.oid),
                    pg_catalog.format('%I.', $1::text), '__schema__.')),
                E'\\n' ORDER BY relation.relname, index_relation.relname), ''),
              'UTF8')), 'hex') AS fingerprint
       FROM pg_catalog.pg_index AS index_record
       JOIN pg_catalog.pg_class AS relation
         ON relation.oid = index_record.indrelid
       JOIN pg_catalog.pg_namespace AS namespace
         ON namespace.oid = relation.relnamespace
       JOIN pg_catalog.pg_class AS index_relation
         ON index_relation.oid = index_record.indexrelid
      WHERE namespace.nspname = $1
        AND relation.relname = ANY($2::text[])`,
    [schemaName, REQUIRED_RELATIONS],
  );
  assertCatalogFingerprint(
    indexes,
    EXPECTED_CATALOG_FINGERPRINTS.indexes,
    schemaName,
    'indexes',
  );

  const inheritance = await client.query(
    `WITH authority_relations AS (
       SELECT relation.oid
         FROM pg_catalog.pg_class AS relation
         JOIN pg_catalog.pg_namespace AS namespace
           ON namespace.oid = relation.relnamespace
        WHERE namespace.nspname = $1
          AND relation.relname = ANY($2::text[])
     )
     SELECT parent_namespace.nspname AS parent_schema,
            parent_relation.relname AS parent_relation,
            child_namespace.nspname AS child_schema,
            child_relation.relname AS child_relation
       FROM pg_catalog.pg_inherits AS inheritance_record
       JOIN pg_catalog.pg_class AS parent_relation
         ON parent_relation.oid = inheritance_record.inhparent
       JOIN pg_catalog.pg_namespace AS parent_namespace
         ON parent_namespace.oid = parent_relation.relnamespace
       JOIN pg_catalog.pg_class AS child_relation
         ON child_relation.oid = inheritance_record.inhrelid
       JOIN pg_catalog.pg_namespace AS child_namespace
         ON child_namespace.oid = child_relation.relnamespace
      WHERE inheritance_record.inhparent IN (SELECT oid FROM authority_relations)
         OR inheritance_record.inhrelid IN (SELECT oid FROM authority_relations)
      ORDER BY parent_namespace.nspname, parent_relation.relname,
               child_namespace.nspname, child_relation.relname
      LIMIT 1`,
    [schemaName, REQUIRED_RELATIONS],
  );
  if (inheritance.rowCount !== 0) {
    const edge = inheritance.rows[0] ?? {};
    throw migrationMismatch(
      'PostgreSQL authority relations must not participate in table inheritance',
      'DISTRIBUTED_AUTHORITY_SCHEMA_INVALID',
      schemaName,
      {
        scope: 'inheritance',
        parent_schema: edge.parent_schema ?? null,
        parent_relation: edge.parent_relation ?? null,
        child_schema: edge.child_schema ?? null,
        child_relation: edge.child_relation ?? null,
      },
    );
  }

  const rewriteRules = await client.query(
    `SELECT namespace.nspname AS relation_schema,
            relation.relname AS relation_name,
            rewrite_rule.rulename AS rule_name,
            rewrite_rule.ev_type AS event_type,
            rewrite_rule.is_instead
       FROM pg_catalog.pg_rewrite AS rewrite_rule
       JOIN pg_catalog.pg_class AS relation
         ON relation.oid = rewrite_rule.ev_class
       JOIN pg_catalog.pg_namespace AS namespace
         ON namespace.oid = relation.relnamespace
      WHERE namespace.nspname = $1
        AND relation.relname = ANY($2::text[])
      ORDER BY relation.relname, rewrite_rule.rulename
      LIMIT 1`,
    [schemaName, REQUIRED_RELATIONS],
  );
  if (rewriteRules.rowCount !== 0) {
    const rule = rewriteRules.rows[0] ?? {};
    throw migrationMismatch(
      'PostgreSQL authority relations must not have rewrite rules',
      'DISTRIBUTED_AUTHORITY_SCHEMA_INVALID',
      schemaName,
      {
        scope: 'rewrite_rules',
        relation: rule.relation_name ?? null,
        rule: rule.rule_name ?? null,
      },
    );
  }

  const rowSecurityPolicies = await client.query(
    `SELECT namespace.nspname AS relation_schema,
            relation.relname AS relation_name,
            policy.polname AS policy_name,
            policy.polcmd AS command,
            policy.polpermissive AS permissive
       FROM pg_catalog.pg_policy AS policy
       JOIN pg_catalog.pg_class AS relation
         ON relation.oid = policy.polrelid
       JOIN pg_catalog.pg_namespace AS namespace
         ON namespace.oid = relation.relnamespace
      WHERE namespace.nspname = $1
        AND relation.relname = ANY($2::text[])
      ORDER BY relation.relname, policy.polname
      LIMIT 1`,
    [schemaName, REQUIRED_RELATIONS],
  );
  if (rowSecurityPolicies.rowCount !== 0) {
    const policy = rowSecurityPolicies.rows[0] ?? {};
    throw migrationMismatch(
      'PostgreSQL authority relations must not have row-security policies',
      'DISTRIBUTED_AUTHORITY_SCHEMA_INVALID',
      schemaName,
      {
        scope: 'row_security_policies',
        relation: policy.relation_name ?? null,
        policy: policy.policy_name ?? null,
      },
    );
  }

  const unexpectedStorage = await client.query(
    `SELECT relation.relname AS relation_name,
            relation.relkind,
            access_method.amname AS access_method,
            relation.reloptions
       FROM pg_catalog.pg_class AS relation
       JOIN pg_catalog.pg_namespace AS namespace
         ON namespace.oid = relation.relnamespace
       LEFT JOIN pg_catalog.pg_am AS access_method
         ON access_method.oid = relation.relam
      WHERE namespace.nspname = $1
        AND relation.relname = ANY($2::text[])
        AND (
          relation.relkind <> 'r'
          OR access_method.amname IS DISTINCT FROM 'heap'
          OR COALESCE(pg_catalog.cardinality(relation.reloptions), 0) <> 0
        )
      ORDER BY relation.relname
      LIMIT 1`,
    [schemaName, REQUIRED_RELATIONS],
  );
  if (unexpectedStorage.rowCount !== 0) {
    const relation = unexpectedStorage.rows[0] ?? {};
    throw migrationMismatch(
      'PostgreSQL authority relation storage differs from the reviewed heap profile',
      'DISTRIBUTED_AUTHORITY_SCHEMA_INVALID',
      schemaName,
      {
        scope: 'table_storage',
        relation: relation.relation_name ?? null,
        relation_kind: relation.relkind ?? null,
        access_method: relation.access_method ?? null,
      },
    );
  }

  const generatedColumns = await client.query(
    `SELECT relation.relname AS relation_name,
            attribute.attname AS column_name,
            attribute.attidentity AS identity_kind,
            attribute.attgenerated AS generated_kind
       FROM pg_catalog.pg_attribute AS attribute
       JOIN pg_catalog.pg_class AS relation
         ON relation.oid = attribute.attrelid
       JOIN pg_catalog.pg_namespace AS namespace
         ON namespace.oid = relation.relnamespace
      WHERE namespace.nspname = $1
        AND relation.relname = ANY($2::text[])
        AND attribute.attnum > 0
        AND NOT attribute.attisdropped
        AND (attribute.attidentity <> '' OR attribute.attgenerated <> '')
      ORDER BY relation.relname, attribute.attnum
      LIMIT 1`,
    [schemaName, REQUIRED_RELATIONS],
  );
  if (generatedColumns.rowCount !== 0) {
    const column = generatedColumns.rows[0] ?? {};
    throw migrationMismatch(
      'PostgreSQL authority columns must not be identity or generated columns',
      'DISTRIBUTED_AUTHORITY_SCHEMA_INVALID',
      schemaName,
      {
        scope: 'generated_columns',
        relation: column.relation_name ?? null,
        column: column.column_name ?? null,
      },
    );
  }

  const unexpectedCollations = await client.query(
    `SELECT relation.relname AS relation_name,
            attribute.attname AS column_name,
            collation_namespace.nspname AS collation_schema,
        collation_record.collname AS collation_name,
        collation_record.collisdeterministic AS deterministic
       FROM pg_catalog.pg_attribute AS attribute
       JOIN pg_catalog.pg_class AS relation
         ON relation.oid = attribute.attrelid
       JOIN pg_catalog.pg_namespace AS namespace
         ON namespace.oid = relation.relnamespace
      JOIN pg_catalog.pg_collation AS collation_record
        ON collation_record.oid = attribute.attcollation
      JOIN pg_catalog.pg_namespace AS collation_namespace
        ON collation_namespace.oid = collation_record.collnamespace
      WHERE namespace.nspname = $1
        AND relation.relname = ANY($2::text[])
        AND attribute.attnum > 0
        AND NOT attribute.attisdropped
        AND (
          collation_namespace.nspname <> 'pg_catalog'
          OR collation_record.collname <> 'default'
          OR collation_record.collisdeterministic IS DISTINCT FROM true
        )
      ORDER BY relation.relname, attribute.attnum
      LIMIT 1`,
    [schemaName, REQUIRED_RELATIONS],
  );
  if (unexpectedCollations.rowCount !== 0) {
    const column = unexpectedCollations.rows[0] ?? {};
    throw migrationMismatch(
      'PostgreSQL authority columns must use the deterministic database-default collation',
      'DISTRIBUTED_AUTHORITY_SCHEMA_INVALID',
      schemaName,
      {
        scope: 'column_collation',
        relation: column.relation_name ?? null,
        column: column.column_name ?? null,
        collation_schema: column.collation_schema ?? null,
        collation_name: column.collation_name ?? null,
      },
    );
  }

  const triggers = await client.query(
    `SELECT relation.relname AS relation_name, trigger_record.tgname,
            trigger_record.tgenabled, trigger_record.tgtype,
            function_namespace.nspname AS function_schema,
            function_record.proname AS function_name,
            function_record.prosecdef AS security_definer,
            function_record.provolatile AS volatility,
            function_record.prokind AS function_kind,
            function_record.pronargs AS argument_count,
            pg_catalog.format_type(function_record.prorettype, NULL) AS return_type,
            language.lanname AS language_name,
            function_record.prosrc AS function_body,
            pg_catalog.replace(pg_catalog.pg_get_triggerdef(trigger_record.oid, true),
              pg_catalog.format('%I.', $1::text), '__schema__.') AS trigger_definition
       FROM pg_catalog.pg_trigger AS trigger_record
       JOIN pg_catalog.pg_class AS relation
         ON relation.oid = trigger_record.tgrelid
       JOIN pg_catalog.pg_namespace AS namespace
         ON namespace.oid = relation.relnamespace
       JOIN pg_catalog.pg_proc AS function_record
         ON function_record.oid = trigger_record.tgfoid
       JOIN pg_catalog.pg_namespace AS function_namespace
         ON function_namespace.oid = function_record.pronamespace
       JOIN pg_catalog.pg_language AS language
         ON language.oid = function_record.prolang
      WHERE namespace.nspname = $1
        AND relation.relname = ANY($2::text[])
        AND NOT trigger_record.tgisinternal
      ORDER BY relation.relname, trigger_record.tgname`,
    [schemaName, REQUIRED_RELATIONS],
  );
  const expectedTriggers = new Map([
    ['audit_events_no_delete', {
      type: 11,
      definition: 'CREATE TRIGGER audit_events_no_delete BEFORE DELETE ON __schema__.audit_events FOR EACH ROW EXECUTE FUNCTION __schema__.reject_audit_mutation()',
    }],
    ['audit_events_no_update', {
      type: 19,
      definition: 'CREATE TRIGGER audit_events_no_update BEFORE UPDATE ON __schema__.audit_events FOR EACH ROW EXECUTE FUNCTION __schema__.reject_audit_mutation()',
    }],
  ]);
  if (triggers.rowCount !== expectedTriggers.size) {
    throw migrationMismatch(
      'PostgreSQL authority audit triggers differ from the reviewed migration',
      'DISTRIBUTED_AUTHORITY_SCHEMA_INVALID',
      schemaName,
      { scope: 'audit_triggers', observed_count: triggers.rowCount },
    );
  }
  for (const row of triggers.rows) {
    const expected = expectedTriggers.get(row.tgname);
    const enabled = row.tgenabled === 'O' || row.tgenabled === 'A';
    if (!expected
      || row.relation_name !== 'audit_events'
      || !enabled
      || Number.parseInt(row.tgtype, 10) !== expected.type
      || row.function_schema !== schemaName
      || row.function_name !== 'reject_audit_mutation'
      || row.security_definer !== false
      || row.volatility !== 'v'
      || row.function_kind !== 'f'
      || Number.parseInt(row.argument_count, 10) !== 0
      || row.return_type !== 'trigger'
      || row.language_name !== 'plpgsql'
      || String(row.function_body).replace(/\r\n?/g, '\n').trim() !== EXPECTED_AUDIT_FUNCTION_BODY
      || row.trigger_definition !== expected.definition) {
      throw migrationMismatch(
        'PostgreSQL authority append-only audit trigger is not bound to the reviewed function',
        'DISTRIBUTED_AUTHORITY_SCHEMA_INVALID',
        schemaName,
        { scope: 'audit_triggers', trigger: row.tgname ?? null },
      );
    }
  }
}

async function hasTablePrivilege(client, relation, privilege) {
  const result = await client.query(
    'SELECT has_table_privilege(current_user, $1, $2) AS allowed',
    [relation, privilege],
  );
  return result.rowCount === 1 && result.rows[0]?.allowed === true;
}

async function hasAnyColumnPrivilege(client, relation, privilege) {
  const result = await client.query(
    'SELECT has_any_column_privilege(current_user, $1, $2) AS allowed',
    [relation, privilege],
  );
  return result.rowCount === 1 && result.rows[0]?.allowed === true;
}

async function verifyRuntimePrivileges(client, schemaName) {
  const roleContext = await client.query(
    `SELECT current_user AS current_role, session_user AS session_role,
            role_record.rolcanlogin AS can_login,
            role_record.rolsuper AS is_superuser,
            role_record.rolcreatedb AS can_create_db,
            role_record.rolcreaterole AS can_create_role,
            role_record.rolreplication AS can_replicate,
            role_record.rolbypassrls AS can_bypass_rls,
            current_setting('fsync') AS fsync,
            current_setting('synchronous_commit') AS synchronous_commit,
            current_setting('session_replication_role') AS session_replication_role
       FROM pg_catalog.pg_roles AS role_record
      WHERE role_record.rolname = current_user`,
  );
  const role = roleContext.rowCount === 1 ? roleContext.rows[0] : null;
  if (!role
    || role.current_role !== role.session_role
    || role.can_login !== true
    || role.is_superuser !== false
    || role.can_create_db !== false
    || role.can_create_role !== false
    || role.can_replicate !== false
    || role.can_bypass_rls !== false
    || role.fsync !== 'on'
    || role.synchronous_commit !== 'on'
    || role.session_replication_role !== 'origin') {
    throw migrationMismatch(
      'PostgreSQL runtime session or role attributes are not least-privilege',
      'DISTRIBUTED_AUTHORITY_RUNTIME_PRIVILEGES_INVALID',
      schemaName,
      { scope: 'role_context' },
    );
  }
  const memberships = await client.query(
    `WITH RECURSIVE memberships(roleid) AS (
       SELECT membership.roleid
         FROM pg_catalog.pg_auth_members AS membership
        WHERE membership.member = (
          SELECT oid FROM pg_catalog.pg_roles WHERE rolname = current_user
        )
       UNION
       SELECT membership.roleid
         FROM pg_catalog.pg_auth_members AS membership
         JOIN memberships AS inherited ON inherited.roleid = membership.member
     )
     SELECT role_record.rolname AS role_name
       FROM memberships
       JOIN pg_catalog.pg_roles AS role_record ON role_record.oid = memberships.roleid
      ORDER BY role_record.rolname`,
  );
  if (memberships.rowCount !== 0) {
    throw migrationMismatch(
      'PostgreSQL runtime login must not be a member of another role',
      'DISTRIBUTED_AUTHORITY_RUNTIME_PRIVILEGES_INVALID',
      schemaName,
      { scope: 'role_membership', membership_count: memberships.rowCount },
    );
  }
  const databasePrivileges = await client.query(
    `SELECT has_database_privilege(current_user, current_database(), 'CONNECT') AS has_connect,
            has_database_privilege(current_user, current_database(), 'CREATE') AS has_create,
            has_database_privilege(current_user, current_database(), 'TEMPORARY') AS has_temporary`,
  );
  if (databasePrivileges.rowCount !== 1
    || databasePrivileges.rows[0]?.has_connect !== true
    || databasePrivileges.rows[0]?.has_create !== false
    || databasePrivileges.rows[0]?.has_temporary !== false) {
    throw migrationMismatch(
      'PostgreSQL runtime role database privileges are not least-privilege',
      'DISTRIBUTED_AUTHORITY_RUNTIME_PRIVILEGES_INVALID',
      schemaName,
      { scope: 'database' },
    );
  }
  const schemaPrivileges = await client.query(
    `SELECT
       has_schema_privilege(current_user, $1, 'USAGE') AS has_usage,
       has_schema_privilege(current_user, $1, 'CREATE') AS has_create`,
    [schemaName],
  );
  if (schemaPrivileges.rowCount !== 1
    || schemaPrivileges.rows[0]?.has_usage !== true
    || schemaPrivileges.rows[0]?.has_create !== false) {
    throw migrationMismatch(
      'PostgreSQL runtime role schema privileges are not least-privilege',
      'DISTRIBUTED_AUTHORITY_RUNTIME_PRIVILEGES_INVALID',
      schemaName,
      { scope: 'schema' },
    );
  }
  for (const [relationName, policy] of Object.entries(RUNTIME_TABLE_PRIVILEGES)) {
    const relation = tableName(schemaName, relationName);
    for (const privilege of policy.required) {
      if (!await hasTablePrivilege(client, relation, privilege)) {
        throw migrationMismatch(
          'PostgreSQL runtime role is missing a required table privilege',
          'DISTRIBUTED_AUTHORITY_RUNTIME_PRIVILEGES_INVALID',
          schemaName,
          { relation: relationName, privilege, expected: true },
        );
      }
    }
    for (const privilege of policy.forbidden) {
      if (await hasTablePrivilege(client, relation, privilege)) {
        throw migrationMismatch(
          'PostgreSQL runtime role has a forbidden table privilege',
          'DISTRIBUTED_AUTHORITY_RUNTIME_PRIVILEGES_INVALID',
          schemaName,
          { relation: relationName, privilege, expected: false },
        );
      }
      if (['INSERT', 'UPDATE', 'REFERENCES'].includes(privilege)
        && await hasAnyColumnPrivilege(client, relation, privilege)) {
        throw migrationMismatch(
          'PostgreSQL runtime role has a forbidden column privilege',
          'DISTRIBUTED_AUTHORITY_RUNTIME_PRIVILEGES_INVALID',
          schemaName,
          { relation: relationName, privilege, expected: false, scope: 'column' },
        );
      }
    }
  }
  const triggerFunction = `${schemaName}.reject_audit_mutation()`;
  const functionPrivilege = await client.query(
    'SELECT has_function_privilege(current_user, $1, $2) AS allowed',
    [triggerFunction, 'EXECUTE'],
  );
  if (functionPrivilege.rowCount !== 1
    || functionPrivilege.rows[0]?.allowed !== false) {
    throw migrationMismatch(
      'PostgreSQL runtime role may not execute the audit trigger function directly',
      'DISTRIBUTED_AUTHORITY_RUNTIME_PRIVILEGES_INVALID',
      schemaName,
      { scope: 'function', function: 'reject_audit_mutation', privilege: 'EXECUTE' },
    );
  }
}

export async function verifyPostgresDistributedAuthoritySchema(client, options = {}) {
  if (!client || typeof client.query !== 'function') {
    throw new TypeError('PostgreSQL authority client must provide query()');
  }
  assertPlainObject(options, 'PostgreSQL authority schema verification options');
  assertAllowedKeys(
    options,
    ['schemaName', 'verifyRuntimePrivileges'],
    'PostgreSQL authority schema verification options',
  );
  const schemaName = requireString(
    options.schemaName ?? 'risk_fork_authority',
    'PostgreSQL schema name',
    { maxLength: 63 },
  );
  const quotedSchema = quotePostgresAuthorityIdentifier(schemaName);
  const verifyPrivileges = requireBoolean(
    options.verifyRuntimePrivileges ?? false,
    'verifyRuntimePrivileges',
  );
  const plan = await loadMigrationPlan(schemaName);
  await verifyMigrationSet(client, schemaName, quotedSchema, plan);
  await verifyRequiredRelations(client, schemaName);
  if (verifyPrivileges) await verifyRuntimePrivileges(client, schemaName);
  return deepFreeze({
    schema_name: schemaName,
    migration_versions: plan.map((migration) => migration.version),
    migration_hashes: plan.map((migration) => migration.migration_hash),
    runtime_privileges_verified: verifyPrivileges,
  });
}

async function applyMigrations(client, schemaName, statementTimeoutMs) {
  const quotedSchema = quotePostgresAuthorityIdentifier(schemaName);
  const plan = await loadMigrationPlan(schemaName);
  const outcomes = [];
  const pending = [];
  await client.query('BEGIN');
  try {
    await client.query('SET LOCAL synchronous_commit = on');
    await client.query(`SET LOCAL statement_timeout = ${statementTimeoutMs}`);
    await client.query(`SET LOCAL lock_timeout = ${statementTimeoutMs}`);
    await client.query(
      `SET LOCAL idle_in_transaction_session_timeout = ${statementTimeoutMs}`,
    );
    await client.query('SELECT pg_advisory_xact_lock(1380338246, 303)');
    await client.query(`CREATE SCHEMA IF NOT EXISTS ${quotedSchema}`);
    await client.query(
      `CREATE TABLE IF NOT EXISTS ${quotedSchema}.authority_schema_migrations (
         version integer PRIMARY KEY CHECK (version >= 1),
         migration_hash text NOT NULL CHECK (migration_hash ~ '^sha256:[a-f0-9]{64}$'),
         applied_at timestamptz NOT NULL DEFAULT clock_timestamp()
       )`,
    );
    const applied = await readAppliedMigrations(client, schemaName, quotedSchema);
    const appliedByVersion = new Map(applied.rows.map((row) => [
      Number.parseInt(row.version, 10),
      row.migration_hash,
    ]));
    for (const observedVersion of appliedByVersion.keys()) {
      if (!plan.some((migration) => migration.version === observedVersion)) {
        throw migrationMismatch(
          'Applied PostgreSQL authority migrations differ from the reviewed set',
          'DISTRIBUTED_AUTHORITY_MIGRATION_SET_MISMATCH',
          schemaName,
          { observed_version: observedVersion },
        );
      }
    }
    for (const migration of plan) {
      const observedHash = appliedByVersion.get(migration.version);
      if (observedHash == null) {
        await client.query(migration.sql);
        pending.push(migration);
        outcomes.push(Object.freeze({
          version: migration.version,
          migration_hash: migration.migration_hash,
          status: 'applied',
        }));
      } else if (!safeEqual(observedHash, migration.migration_hash)) {
        throw migrationMismatch(
          'Applied PostgreSQL authority migration differs from the reviewed source',
          'DISTRIBUTED_AUTHORITY_MIGRATION_HASH_MISMATCH',
          schemaName,
          { version: migration.version },
        );
      } else {
        outcomes.push(Object.freeze({
          version: migration.version,
          migration_hash: migration.migration_hash,
          status: 'current',
        }));
      }
    }
    await verifyRequiredRelations(client, schemaName);
    for (const migration of pending) {
      await client.query(
        `INSERT INTO ${quotedSchema}.authority_schema_migrations (
           version, migration_hash, applied_at
         ) VALUES ($1, $2, clock_timestamp())`,
        [migration.version, migration.migration_hash],
      );
    }
    await verifyMigrationSet(client, schemaName, quotedSchema, plan);
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    throw error;
  }
  return deepFreeze({ schema_name: schemaName, migrations: outcomes });
}

export async function migratePostgresDistributedAuthority(options = {}) {
  assertPlainObject(options, 'PostgreSQL authority migration options');
  assertAllowedKeys(options, [
    'connectionString',
    'pool',
    'schemaName',
    'requireTls',
    'tls',
    'maxConnections',
    'connectionTimeoutMs',
    'statementTimeoutMs',
    'applicationName',
  ], 'PostgreSQL authority migration options');
  const schemaName = requireString(
    options.schemaName ?? 'risk_fork_authority',
    'PostgreSQL schema name',
    { maxLength: 63 },
  );
  quotePostgresAuthorityIdentifier(schemaName);
  const statementTimeoutMs = requireInteger(
    options.statementTimeoutMs ?? 30_000,
    'statementTimeoutMs',
    100,
    300_000,
  );
  const requireTls = requireBoolean(options.requireTls ?? true, 'requireTls');
  const suppliedPool = options.pool ?? null;
  if (suppliedPool != null && options.connectionString != null) {
    throw new TypeError('Provide either a PostgreSQL pool or connectionString, not both');
  }
  if (suppliedPool != null && typeof suppliedPool.connect !== 'function') {
    throw new TypeError('PostgreSQL authority pool must provide connect()');
  }
  if (suppliedPool != null && requireTls) {
    throw configurationError(
      'Secure PostgreSQL migration must construct its own CA-validated pool',
      'POSTGRES_AUTHORITY_TLS_POOL_UNTRUSTED',
    );
  }
  const ownsPool = suppliedPool == null;
  const pool = suppliedPool ?? await createPostgresAuthorityPool({
    connectionString: options.connectionString,
    requireTls,
    tls: options.tls,
    maxConnections: options.maxConnections ?? 2,
    connectionTimeoutMs: options.connectionTimeoutMs,
    statementTimeoutMs: options.statementTimeoutMs,
    applicationName: options.applicationName ?? 'agoragentic-risk-fork-migrator',
  });
  const verifiedClients = new WeakSet();
  try {
    const client = await acquirePostgresAuthorityClient(pool, { requireTls, verifiedClients });
    try {
      return await applyMigrations(client, schemaName, statementTimeoutMs);
    } finally {
      client.release();
    }
  } finally {
    if (ownsPool) await pool.end().catch(() => {});
  }
}
