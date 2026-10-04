import { readFile } from 'node:fs/promises';

import { sha256Ref, canonicalize } from '../../src/canonical.mjs';
import { quotePostgresAuthorityIdentifier } from '../../src/adapters/postgres-authority-migrator.mjs';
import {
  assertAllowedKeys,
  assertPlainRecord,
} from './validation.mjs';

const DEFAULT_SCHEMA = 'risk_fork_worker_delivery';
const TABLES = Object.freeze([
  'managed_worker_delivery_attempts',
  'managed_worker_delivery_namespaces',
  'managed_worker_delivery_schema_migrations',
]);
const FUNCTIONS = Object.freeze([
  'protect_managed_worker_delivery_namespace',
  'protect_managed_worker_delivery_record',
  'reject_managed_worker_delivery_delete',
  'reject_managed_worker_delivery_truncate',
]);
const PRIMARY_KEYS = Object.freeze([
  'managed_worker_delivery_attempts_pkey',
  'managed_worker_delivery_namespaces_pkey',
  'managed_worker_delivery_schema_migrations_pkey',
]);
const TRIGGERS = Object.freeze([
  'managed_worker_delivery_namespace_no_delete',
  'managed_worker_delivery_namespace_no_truncate',
  'managed_worker_delivery_no_delete',
  'managed_worker_delivery_no_truncate',
  'managed_worker_delivery_protect_namespace',
  'managed_worker_delivery_protect_record',
]);
const COLUMNS = Object.freeze({
  managed_worker_delivery_schema_migrations: [
    ['version', 'integer', true, ''],
    ['migration_hash', 'text', true, ''],
    ['applied_at', 'timestamp with time zone', true, 'clock_timestamp()'],
  ],
  managed_worker_delivery_namespaces: [
    ['namespace', 'text', true, ''],
    ['max_attempts', 'integer', true, ''],
    ['created_at', 'timestamp with time zone', true, 'clock_timestamp()'],
  ],
  managed_worker_delivery_attempts: [
    ['namespace', 'text', true, ''],
    ['attempt_ref', 'text', true, ''],
    ['key_id', 'text', true, ''],
    ['iv', 'text', true, ''],
    ['ciphertext', 'text', true, ''],
    ['tag', 'text', true, ''],
    ['acknowledged', 'boolean', true, 'false'],
    ['response_hash', 'text', false, ''],
    ['created_at', 'timestamp with time zone', true, 'clock_timestamp()'],
    ['acknowledged_at', 'timestamp with time zone', false, ''],
  ],
});
const REQUIRED_TABLE_PRIVILEGES = Object.freeze({
  managed_worker_delivery_schema_migrations: ['SELECT'],
  managed_worker_delivery_namespaces: ['SELECT', 'INSERT'],
  managed_worker_delivery_attempts: ['SELECT', 'INSERT'],
});
const FORBIDDEN_TABLE_PRIVILEGES = Object.freeze([
  'UPDATE', 'DELETE', 'TRUNCATE', 'REFERENCES', 'TRIGGER',
]);
const FORBIDDEN_TABLE_PRIVILEGES_BY_TABLE = Object.freeze({
  managed_worker_delivery_schema_migrations: ['INSERT', ...FORBIDDEN_TABLE_PRIVILEGES],
  managed_worker_delivery_namespaces: FORBIDDEN_TABLE_PRIVILEGES,
  managed_worker_delivery_attempts: FORBIDDEN_TABLE_PRIVILEGES,
});

function failed(scope) {
  const error = new Error('Worker delivery PostgreSQL attestation failed');
  error.code = 'WORKER_DELIVERY_POSTGRES_ATTESTATION_FAILED';
  error.evidence = Object.freeze({ scope });
  return error;
}

function expect(condition, scope) {
  if (!condition) throw failed(scope);
}

function equal(actual, expected, scope) {
  if (canonicalize(actual) !== canonicalize(expected)) throw failed(scope);
}

async function exactlyOne(client, sql, params, scope) {
  const result = await client.query(sql, params);
  expect(result.rowCount === 1, scope);
  return result.rows[0];
}

function validateIdentifier(value, scope) {
  try { quotePostgresAuthorityIdentifier(value); } catch { throw failed(scope); }
  return value;
}

function normalizeDefinition(definition, schemaName) {
  return definition.replaceAll(`"${schemaName}".`, '__schema__.')
    .replaceAll(`${schemaName}.`, '__schema__.');
}

function tableRef(schemaName, tableName) {
  return `"${schemaName}"."${tableName}"`;
}

async function verifyCatalog(client, schemaName, migrationSource, migrationHash) {
  const version = await client.query("SELECT pg_catalog.current_setting('server_version_num') AS version");
  expect(version.rowCount === 1 && Number(version.rows[0].version) >= 160000
    && Number(version.rows[0].version) < 170000, 'postgres_version');
  const relations = await client.query(
    `SELECT c.relname AS name,c.relkind AS kind,c.relpersistence AS persistence,
            c.relrowsecurity AS row_security,c.relforcerowsecurity AS force_row_security,
            c.reloptions,c.relispartition,c.relpartbound
       FROM pg_catalog.pg_class c JOIN pg_catalog.pg_namespace n ON n.oid=c.relnamespace
      WHERE n.nspname=$1 AND c.relkind NOT IN ('i','I') ORDER BY c.relname`,
    [schemaName],
  );
  equal(relations.rows, TABLES.map((name) => ({
    name, kind: 'r', persistence: 'p', row_security: false, force_row_security: false,
    reloptions: null, relispartition: false, relpartbound: null,
  })), 'relations');

  const columns = await client.query(
    `SELECT c.relname AS relation,a.attname AS name,a.attnum,
            pg_catalog.format_type(a.atttypid,a.atttypmod) AS type_name,
            a.attnotnull AS not_null,COALESCE(pg_catalog.pg_get_expr(d.adbin,d.adrelid),'') AS default_expr
       FROM pg_catalog.pg_class c JOIN pg_catalog.pg_namespace n ON n.oid=c.relnamespace
       JOIN pg_catalog.pg_attribute a ON a.attrelid=c.oid AND a.attnum>0 AND NOT a.attisdropped
       LEFT JOIN pg_catalog.pg_attrdef d ON d.adrelid=c.oid AND d.adnum=a.attnum
      WHERE n.nspname=$1 AND c.relname=ANY($2::text[]) ORDER BY c.relname,a.attnum`,
    [schemaName, TABLES],
  );
  const expectedColumns = TABLES.flatMap((table) => (COLUMNS[table] ?? []).map(
    ([name, type_name, not_null, default_expr], index) => ({
      relation: table, name, attnum: index + 1, type_name, not_null, default_expr,
    }),
  ));
  equal(columns.rows, expectedColumns, 'columns');

  const constraints = await client.query(
    `SELECT c.relname AS relation,con.conname,con.contype,con.convalidated,
            con.condeferrable,con.condeferred,
            pg_catalog.pg_get_constraintdef(con.oid,true) AS definition
       FROM pg_catalog.pg_constraint con JOIN pg_catalog.pg_class c ON c.oid=con.conrelid
       JOIN pg_catalog.pg_namespace n ON n.oid=c.relnamespace
      WHERE n.nspname=$1 AND c.relname=ANY($2::text[]) ORDER BY c.relname,con.conname`,
    [schemaName, TABLES],
  );
  const expectedConstraints = [
    ['managed_worker_delivery_attempts', 'managed_worker_delivery_attempts_attempt_ref_check', 'c', "CHECK (attempt_ref ~ '^sha256:[a-f0-9]{64}$'::text)"],
    ['managed_worker_delivery_attempts', 'managed_worker_delivery_attempts_check', 'c', 'CHECK (acknowledged = false AND response_hash IS NULL AND acknowledged_at IS NULL OR acknowledged = true AND response_hash IS NOT NULL AND acknowledged_at IS NOT NULL)'],
    ['managed_worker_delivery_attempts', 'managed_worker_delivery_attempts_ciphertext_check', 'c', "CHECK (ciphertext ~ '^[A-Za-z0-9_-]+$'::text)"],
    ['managed_worker_delivery_attempts', 'managed_worker_delivery_attempts_iv_check', 'c', "CHECK (iv ~ '^[A-Za-z0-9_-]+$'::text)"],
    ['managed_worker_delivery_attempts', 'managed_worker_delivery_attempts_key_id_check', 'c', "CHECK (key_id ~ '^[A-Za-z0-9][A-Za-z0-9._:@/-]{0,199}$'::text)"],
    ['managed_worker_delivery_attempts', 'managed_worker_delivery_attempts_namespace_check', 'c', "CHECK (namespace ~ '^[A-Za-z0-9][A-Za-z0-9._:@/-]{0,199}$'::text)"],
    ['managed_worker_delivery_attempts', 'managed_worker_delivery_attempts_namespace_fkey', 'f', 'FOREIGN KEY (namespace) REFERENCES __schema__.managed_worker_delivery_namespaces(namespace)'],
    ['managed_worker_delivery_attempts', 'managed_worker_delivery_attempts_pkey', 'p', 'PRIMARY KEY (namespace, attempt_ref)'],
    ['managed_worker_delivery_attempts', 'managed_worker_delivery_attempts_response_hash_check', 'c', "CHECK (response_hash IS NULL OR response_hash ~ '^sha256:[a-f0-9]{64}$'::text)"],
    ['managed_worker_delivery_attempts', 'managed_worker_delivery_attempts_tag_check', 'c', "CHECK (tag ~ '^[A-Za-z0-9_-]+$'::text)"],
    ['managed_worker_delivery_namespaces', 'managed_worker_delivery_namespaces_max_attempts_check', 'c', 'CHECK (max_attempts >= 1 AND max_attempts <= 10000)'],
    ['managed_worker_delivery_namespaces', 'managed_worker_delivery_namespaces_namespace_check', 'c', "CHECK (namespace ~ '^[A-Za-z0-9][A-Za-z0-9._:@/-]{0,199}$'::text)"],
    ['managed_worker_delivery_namespaces', 'managed_worker_delivery_namespaces_pkey', 'p', 'PRIMARY KEY (namespace)'],
    ['managed_worker_delivery_schema_migrations', 'managed_worker_delivery_schema_migrations_migration_hash_check', 'c', "CHECK (migration_hash ~ '^sha256:[a-f0-9]{64}$'::text)"],
    ['managed_worker_delivery_schema_migrations', 'managed_worker_delivery_schema_migrations_pkey', 'p', 'PRIMARY KEY (version)'],
    ['managed_worker_delivery_schema_migrations', 'managed_worker_delivery_schema_migrations_version_check', 'c', 'CHECK (version >= 1)'],
  ];
  const actualConstraints = constraints.rows.map((row) => [row.relation,row.conname,row.contype,
    normalizeDefinition(row.definition, schemaName)]);
  equal(actualConstraints, expectedConstraints, 'constraints');
  expect(constraints.rows.every((row) => row.convalidated && !row.condeferrable && !row.condeferred), 'constraint_flags');

  const indexes = await client.query(
    `SELECT i.relname AS name,ix.indisunique AS unique_index,ix.indisprimary AS primary_index,
            ix.indisvalid AS valid_index,ix.indisready AS ready_index,
            pg_catalog.pg_get_indexdef(i.oid) AS definition
       FROM pg_catalog.pg_index ix JOIN pg_catalog.pg_class i ON i.oid=ix.indexrelid
       JOIN pg_catalog.pg_class c ON c.oid=ix.indrelid
       JOIN pg_catalog.pg_namespace n ON n.oid=c.relnamespace
      WHERE n.nspname=$1 AND c.relname=ANY($2::text[]) ORDER BY i.relname`,
    [schemaName, TABLES],
  );
  equal(indexes.rows.map((row) => row.name), PRIMARY_KEYS, 'indexes');
  expect(indexes.rows.every((row) => row.unique_index && row.primary_index && row.valid_index && row.ready_index), 'index_flags');
  equal(indexes.rows.map((row) => normalizeDefinition(row.definition, schemaName)),
    [
      'CREATE UNIQUE INDEX managed_worker_delivery_attempts_pkey ON __schema__.managed_worker_delivery_attempts USING btree (namespace, attempt_ref)',
      'CREATE UNIQUE INDEX managed_worker_delivery_namespaces_pkey ON __schema__.managed_worker_delivery_namespaces USING btree (namespace)',
      'CREATE UNIQUE INDEX managed_worker_delivery_schema_migrations_pkey ON __schema__.managed_worker_delivery_schema_migrations USING btree (version)',
  ], 'index_definitions');
  const schemaIndexes = await client.query(
    `SELECT i.relname AS name,pg_catalog.pg_get_indexdef(i.oid) AS definition,
            ix.indisunique AS unique_index,ix.indisprimary AS primary_index,
            ix.indisvalid AS valid_index,ix.indisready AS ready_index
       FROM pg_catalog.pg_class i JOIN pg_catalog.pg_namespace n ON n.oid=i.relnamespace
       LEFT JOIN pg_catalog.pg_index ix ON ix.indexrelid=i.oid
      WHERE n.nspname=$1 AND i.relkind IN ('i','I') ORDER BY i.relname`, [schemaName]);
  equal(schemaIndexes.rows.map((row) => row.name), PRIMARY_KEYS, 'schema_indexes');
  expect(schemaIndexes.rows.every((row) => row.unique_index && row.primary_index
    && row.valid_index && row.ready_index), 'schema_index_flags');

  const triggers = await client.query(
    `SELECT t.tgname AS name,t.tgenabled AS enabled,
            pg_catalog.pg_get_triggerdef(t.oid,true) AS definition
       FROM pg_catalog.pg_trigger t JOIN pg_catalog.pg_class c ON c.oid=t.tgrelid
       JOIN pg_catalog.pg_namespace n ON n.oid=c.relnamespace
      WHERE n.nspname=$1 AND NOT t.tgisinternal ORDER BY t.tgname`, [schemaName],
  );
  equal(triggers.rows.map((row) => row.name), TRIGGERS, 'triggers');
  expect(triggers.rows.every((row) => row.enabled === 'O'), 'trigger_flags');
  const triggerDefs = [
    ['managed_worker_delivery_namespace_no_delete', 'CREATE TRIGGER managed_worker_delivery_namespace_no_delete BEFORE DELETE ON __schema__.managed_worker_delivery_namespaces FOR EACH ROW EXECUTE FUNCTION __schema__.reject_managed_worker_delivery_delete()'],
    ['managed_worker_delivery_namespace_no_truncate', 'CREATE TRIGGER managed_worker_delivery_namespace_no_truncate BEFORE TRUNCATE ON __schema__.managed_worker_delivery_namespaces FOR EACH STATEMENT EXECUTE FUNCTION __schema__.reject_managed_worker_delivery_truncate()'],
    ['managed_worker_delivery_no_delete', 'CREATE TRIGGER managed_worker_delivery_no_delete BEFORE DELETE ON __schema__.managed_worker_delivery_attempts FOR EACH ROW EXECUTE FUNCTION __schema__.reject_managed_worker_delivery_delete()'],
    ['managed_worker_delivery_no_truncate', 'CREATE TRIGGER managed_worker_delivery_no_truncate BEFORE TRUNCATE ON __schema__.managed_worker_delivery_attempts FOR EACH STATEMENT EXECUTE FUNCTION __schema__.reject_managed_worker_delivery_truncate()'],
    ['managed_worker_delivery_protect_namespace', 'CREATE TRIGGER managed_worker_delivery_protect_namespace BEFORE UPDATE ON __schema__.managed_worker_delivery_namespaces FOR EACH ROW EXECUTE FUNCTION __schema__.protect_managed_worker_delivery_namespace()'],
    ['managed_worker_delivery_protect_record', 'CREATE TRIGGER managed_worker_delivery_protect_record BEFORE UPDATE ON __schema__.managed_worker_delivery_attempts FOR EACH ROW EXECUTE FUNCTION __schema__.protect_managed_worker_delivery_record()'],
  ];
  equal(triggers.rows.map((row) => [row.name, normalizeDefinition(row.definition, schemaName)]), triggerDefs, 'trigger_definitions');

  const functions = await client.query(
    `SELECT p.proname AS name,pg_catalog.pg_get_function_identity_arguments(p.oid) AS args,
            pg_catalog.format_type(p.prorettype,NULL) AS returns,p.prosrc AS body,p.prosecdef,
            p.proconfig,p.provolatile,p.proparallel,p.proleakproof,p.proisstrict,
            p.prokind,l.lanname AS language
       FROM pg_catalog.pg_proc p JOIN pg_catalog.pg_namespace n ON n.oid=p.pronamespace
       JOIN pg_catalog.pg_language l ON l.oid=p.prolang
      WHERE n.nspname=$1 ORDER BY p.proname`, [schemaName],
  );
  equal(functions.rows.map((row) => [row.name,row.args,row.returns]), FUNCTIONS.map((name) => [name,'','trigger']), 'functions');
  for (const row of functions.rows) {
    const body = migrationSource.split(`CREATE FUNCTION __RISK_FORK_MANAGED_SCHEMA__.${row.name}()`)[1]?.split('AS $$')[1]?.split('$$;')[0];
    expect(body && row.body === body && !row.prosecdef && row.proconfig === null
      && row.provolatile === 'v' && row.proparallel === 'u' && !row.proleakproof
      && !row.proisstrict && row.prokind === 'f' && row.language === 'plpgsql', `function_${row.name}`);
  }

  for (const [scope, sql] of [
    ['inheritance', `SELECT 1 FROM pg_catalog.pg_inherits i WHERE i.inhparent IN (SELECT c.oid FROM pg_catalog.pg_class c JOIN pg_catalog.pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname=$1 AND c.relname=ANY($2::text[])) OR i.inhrelid IN (SELECT c.oid FROM pg_catalog.pg_class c JOIN pg_catalog.pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname=$1 AND c.relname=ANY($2::text[])) LIMIT 1`],
    ['policies', `SELECT 1 FROM pg_catalog.pg_policy p JOIN pg_catalog.pg_class c ON c.oid=p.polrelid JOIN pg_catalog.pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname=$1 AND c.relname=ANY($2::text[]) LIMIT 1`],
    ['rewrites', `SELECT 1 FROM pg_catalog.pg_rewrite r JOIN pg_catalog.pg_class c ON c.oid=r.ev_class JOIN pg_catalog.pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname=$1 AND c.relname=ANY($2::text[]) AND r.rulename<>'_RETURN' LIMIT 1`],
    ['generated_columns', `SELECT 1 FROM pg_catalog.pg_attribute a JOIN pg_catalog.pg_class c ON c.oid=a.attrelid JOIN pg_catalog.pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname=$1 AND c.relname=ANY($2::text[]) AND a.attgenerated<>'' LIMIT 1`],
    ['identity_or_dropped_columns', `SELECT 1 FROM pg_catalog.pg_attribute a JOIN pg_catalog.pg_class c ON c.oid=a.attrelid JOIN pg_catalog.pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname=$1 AND c.relname=ANY($2::text[]) AND (a.attidentity<>'' OR a.attisdropped) LIMIT 1`],
    ['nondefault_collations', `SELECT 1 FROM pg_catalog.pg_attribute a JOIN pg_catalog.pg_class c ON c.oid=a.attrelid JOIN pg_catalog.pg_namespace n ON n.oid=c.relnamespace JOIN pg_catalog.pg_type t ON t.oid=a.atttypid WHERE n.nspname=$1 AND c.relname=ANY($2::text[]) AND a.attnum>0 AND NOT a.attisdropped AND a.attcollation<>t.typcollation LIMIT 1`],
  ]) {
    const result = await client.query(sql, [schemaName, TABLES]);
    expect(result.rowCount === 0, scope);
  }

  const ledger = await client.query(
    `SELECT version, migration_hash, applied_at FROM ${tableRef(schemaName, 'managed_worker_delivery_schema_migrations')} ORDER BY version`,
  );
  equal(ledger.rows.map((row) => ({ version: row.version, migration_hash: row.migration_hash, applied_at: row.applied_at !== null })),
    [{ version: 1, migration_hash: migrationHash, applied_at: true }], 'migration_ledger');
}

async function verifyPrivileges(client, schemaName, expectedOwner) {
  const role = await exactlyOne(client, `SELECT current_user AS current_role,session_user AS session_role,
    r.rolcanlogin AS can_login,r.rolinherit AS inherit,r.rolsuper AS superuser,r.rolcreatedb AS createdb,
    r.rolcreaterole AS createrole,r.rolreplication AS replication,r.rolbypassrls AS bypassrls,
    pg_catalog.current_setting('fsync') AS fsync,pg_catalog.current_setting('synchronous_commit') AS synchronous_commit,
    pg_catalog.current_setting('session_replication_role') AS replication_role
    FROM pg_catalog.pg_roles r WHERE r.rolname=current_user`, [], 'role');
  expect(role.current_role === role.session_role && role.can_login && !role.inherit && !role.superuser
    && !role.createdb && !role.createrole && !role.replication && !role.bypassrls
    && role.fsync === 'on' && role.synchronous_commit === 'on' && role.replication_role === 'origin', 'role');
  const memberships = await client.query(`WITH RECURSIVE m(roleid) AS (
    SELECT am.roleid FROM pg_catalog.pg_auth_members am WHERE am.member=(SELECT oid FROM pg_catalog.pg_roles WHERE rolname=current_user)
    UNION SELECT am.roleid FROM pg_catalog.pg_auth_members am JOIN m ON m.roleid=am.member) SELECT 1 FROM m LIMIT 1`);
  expect(memberships.rowCount === 0, 'membership');
  const db = await exactlyOne(client, `SELECT pg_catalog.has_database_privilege(current_user,pg_catalog.current_database(),'CONNECT') AS connect,
    pg_catalog.has_database_privilege(current_user,pg_catalog.current_database(),'CREATE') AS create_db,
    pg_catalog.has_database_privilege(current_user,pg_catalog.current_database(),'TEMPORARY') AS temporary,
    pg_catalog.has_database_privilege(current_user,pg_catalog.current_database(),'CONNECT WITH GRANT OPTION') AS connect_grant`, [], 'database');
  expect(db.connect && !db.create_db && !db.temporary && !db.connect_grant, 'database');
  const schema = await exactlyOne(client, `SELECT pg_catalog.has_schema_privilege(current_user,$1,'USAGE') AS usage,
    pg_catalog.has_schema_privilege(current_user,$1,'CREATE') AS create_schema,
    pg_catalog.has_schema_privilege(current_user,$1,'USAGE WITH GRANT OPTION') AS usage_grant`, [schemaName], 'schema');
  expect(schema.usage && !schema.create_schema && !schema.usage_grant, 'schema');

  // Effective runtime privileges alone cannot detect the same allowed privilege
  // leaked to PUBLIC or to an unrelated role. Inspect every explicit ACL entry.
  const objectAcl = await client.query(`/* delivery_object_acl_boundary */
    WITH roles AS (
      SELECT (SELECT oid FROM pg_catalog.pg_roles WHERE rolname=current_user) AS runtime,
             (SELECT oid FROM pg_catalog.pg_roles WHERE rolname=$2) AS migrator
    )
    SELECT 'database' AS object_kind,x.privilege_type FROM pg_catalog.pg_database d
    CROSS JOIN roles r
    CROSS JOIN LATERAL pg_catalog.aclexplode(COALESCE(d.datacl,pg_catalog.acldefault('d',d.datdba))) x
    WHERE d.datname=pg_catalog.current_database() AND NOT (
      x.grantee=d.datdba OR
      (x.grantee=r.migrator AND x.privilege_type IN ('CONNECT','CREATE') AND NOT x.is_grantable) OR
      (x.grantee=r.runtime AND x.privilege_type='CONNECT' AND NOT x.is_grantable))
    UNION ALL
    SELECT 'schema',x.privilege_type FROM pg_catalog.pg_namespace n
    CROSS JOIN roles r
    CROSS JOIN LATERAL pg_catalog.aclexplode(COALESCE(n.nspacl,pg_catalog.acldefault('n',n.nspowner))) x
    WHERE n.nspname=$1 AND NOT (x.grantee=n.nspowner OR
      (x.grantee=r.runtime AND x.privilege_type='USAGE' AND NOT x.is_grantable))
    UNION ALL
    SELECT 'table',x.privilege_type FROM pg_catalog.pg_class c
    JOIN pg_catalog.pg_namespace n ON n.oid=c.relnamespace CROSS JOIN roles r
    CROSS JOIN LATERAL pg_catalog.aclexplode(COALESCE(c.relacl,pg_catalog.acldefault('r',c.relowner))) x
    WHERE n.nspname=$1 AND c.relname=ANY($3::text[]) AND NOT (x.grantee=c.relowner OR
      (x.grantee=r.runtime AND NOT x.is_grantable AND (x.privilege_type='SELECT' OR
        (x.privilege_type='INSERT' AND c.relname<>'managed_worker_delivery_schema_migrations'))))
    UNION ALL
    SELECT 'function',x.privilege_type FROM pg_catalog.pg_proc p
    JOIN pg_catalog.pg_namespace n ON n.oid=p.pronamespace
    CROSS JOIN LATERAL pg_catalog.aclexplode(COALESCE(p.proacl,pg_catalog.acldefault('f',p.proowner))) x
    WHERE n.nspname=$1 AND x.grantee<>p.proowner`, [schemaName, expectedOwner, TABLES]);
  expect(objectAcl.rowCount === 0, 'object_acls');

  for (const table of TABLES) {
    const required = REQUIRED_TABLE_PRIVILEGES[table] ?? [];
    for (const privilege of required) {
      const row = await exactlyOne(client, 'SELECT pg_catalog.has_table_privilege(current_user,$1,$2) AS allowed, pg_catalog.has_table_privilege(current_user,$1,$3) AS grantable',
        [tableRef(schemaName, table), privilege, `${privilege} WITH GRANT OPTION`], `table_${table}_${privilege}`);
      expect(row.allowed && !row.grantable, `table_${table}_${privilege}`);
    }
    for (const privilege of FORBIDDEN_TABLE_PRIVILEGES_BY_TABLE[table]) {
      const row = await exactlyOne(client, 'SELECT pg_catalog.has_table_privilege(current_user,$1,$2) AS allowed', [tableRef(schemaName, table), privilege], `table_${table}_${privilege}`);
      expect(!row.allowed, `table_${table}_${privilege}`);
    }
    const columns = await client.query(`SELECT a.attname AS name,
      pg_catalog.has_column_privilege(current_user,a.attrelid,a.attname,'UPDATE') AS update_allowed,
      pg_catalog.has_column_privilege(current_user,a.attrelid,a.attname,'UPDATE WITH GRANT OPTION') AS update_grant
      FROM pg_catalog.pg_attribute a WHERE a.attrelid=$1::regclass AND a.attnum>0 AND NOT a.attisdropped ORDER BY a.attnum`,
    [tableRef(schemaName, table)]);
    const allowedUpdates = table === 'managed_worker_delivery_attempts'
      ? ['acknowledged', 'response_hash', 'acknowledged_at'] : [];
    equal(columns.rows.map((row) => ({ name: row.name, update_allowed: row.update_allowed, update_grant: row.update_grant })),
      (COLUMNS[table] ?? []).map(([name]) => ({ name, update_allowed: allowedUpdates.includes(name), update_grant: false })), `columns_${table}`);
  }
  const columnGrants = await client.query(`SELECT c.relname AS relation,a.attname AS column_name,
      r.rolname AS grantee,current_user AS current_role,x.privilege_type,x.is_grantable
    FROM pg_catalog.pg_class c JOIN pg_catalog.pg_namespace n ON n.oid=c.relnamespace
    JOIN pg_catalog.pg_attribute a ON a.attrelid=c.oid AND a.attnum>0 AND NOT a.attisdropped
    JOIN LATERAL pg_catalog.aclexplode(a.attacl) x ON true
    LEFT JOIN pg_catalog.pg_roles r ON r.oid=x.grantee
    WHERE n.nspname=$1 AND c.relname=ANY($2::text[]) AND a.attacl IS NOT NULL
    ORDER BY c.relname,a.attnum,x.privilege_type,r.rolname`, [schemaName, TABLES]);
  equal(columnGrants.rows, columnGrants.rows.length === 0 ? [] : columnGrants.rows.filter((row) => (
    row.relation === 'managed_worker_delivery_attempts'
    && ['acknowledged', 'response_hash', 'acknowledged_at'].includes(row.column_name)
    && row.grantee === row.current_role
    && row.privilege_type === 'UPDATE' && !row.is_grantable
  )), 'column_grants');

  const owners = await client.query(`SELECT object_kind,object_name,owner FROM (
    SELECT 'schema' AS object_kind,n.nspname AS object_name,r.rolname AS owner FROM pg_catalog.pg_namespace n JOIN pg_catalog.pg_roles r ON r.oid=n.nspowner WHERE n.nspname=$1
    UNION ALL SELECT 'relation',c.relname,r.rolname FROM pg_catalog.pg_class c JOIN pg_catalog.pg_namespace n ON n.oid=c.relnamespace JOIN pg_catalog.pg_roles r ON r.oid=c.relowner WHERE n.nspname=$1 AND c.relname=ANY($2::text[])
    UNION ALL SELECT 'index',i.relname,r.rolname FROM pg_catalog.pg_index x JOIN pg_catalog.pg_class i ON i.oid=x.indexrelid JOIN pg_catalog.pg_class c ON c.oid=x.indrelid JOIN pg_catalog.pg_namespace n ON n.oid=c.relnamespace JOIN pg_catalog.pg_roles r ON r.oid=i.relowner WHERE n.nspname=$1 AND c.relname=ANY($2::text[])
    UNION ALL SELECT 'function',p.proname,r.rolname FROM pg_catalog.pg_proc p JOIN pg_catalog.pg_namespace n ON n.oid=p.pronamespace JOIN pg_catalog.pg_roles r ON r.oid=p.proowner WHERE n.nspname=$1 AND p.proname=ANY($3::text[])
  ) q WHERE owner<>$4 OR owner=current_user`, [schemaName, TABLES, FUNCTIONS, expectedOwner]);
  expect(owners.rowCount === 0, 'ownership');

  const functionExecute = await client.query(`SELECT p.proname,
      pg_catalog.has_function_privilege(current_user,p.oid,'EXECUTE') AS allowed,
      pg_catalog.has_function_privilege(current_user,p.oid,'EXECUTE WITH GRANT OPTION') AS grantable
    FROM pg_catalog.pg_proc p JOIN pg_catalog.pg_namespace n ON n.oid=p.pronamespace
    WHERE n.nspname=$1 AND p.proname=ANY($2::text[]) ORDER BY p.proname`, [schemaName, FUNCTIONS]);
  equal(functionExecute.rows.map((row) => [row.proname, row.allowed, row.grantable]),
    FUNCTIONS.map((name) => [name, false, false]), 'function_execute');
  const defaultAcl = await client.query(`/* delivery_default_acl_boundary */ SELECT d.defaclobjtype,x.privilege_type,x.is_grantable,
      x.grantee,r.rolname AS grantee_name
    FROM pg_catalog.pg_default_acl d
    CROSS JOIN LATERAL pg_catalog.aclexplode(COALESCE(d.defaclacl,'{}'::pg_catalog.aclitem[])) x
    LEFT JOIN pg_catalog.pg_roles r ON r.oid=x.grantee
    WHERE d.defaclnamespace=(SELECT oid FROM pg_catalog.pg_namespace WHERE nspname=$1)
      AND d.defaclrole=(SELECT oid FROM pg_catalog.pg_roles WHERE rolname=$2)
      AND x.grantee<>d.defaclrole`, [schemaName, expectedOwner]);
  expect(defaultAcl.rowCount === 0, 'default_privileges');
  // Scoped defaults add to global defaults. No pg_default_acl row means the
  // PostgreSQL built-in default, including PUBLIC EXECUTE for functions.
  const globalDefaults = await client.query(`/* delivery_global_acl_boundary */ SELECT k.kind,x.privilege_type
    FROM pg_catalog.pg_roles o CROSS JOIN (VALUES ('r'),('S'),('f')) k(kind)
    LEFT JOIN pg_catalog.pg_default_acl d ON d.defaclrole=o.oid
      AND d.defaclnamespace=0 AND d.defaclobjtype=k.kind::"char"
    CROSS JOIN LATERAL pg_catalog.aclexplode(COALESCE(d.defaclacl,
      pg_catalog.acldefault(k.kind::"char",o.oid))) x
    WHERE o.rolname=$1 AND x.grantee<>o.oid`, [expectedOwner]);
  expect(globalDefaults.rowCount === 0, 'global_default_privileges');
  const grantable = await client.query(`SELECT 1 FROM pg_catalog.pg_class c JOIN pg_catalog.pg_namespace n ON n.oid=c.relnamespace,
    LATERAL pg_catalog.aclexplode(COALESCE(c.relacl,pg_catalog.acldefault('r',c.relowner))) x
    WHERE n.nspname=$1 AND c.relname=ANY($2::text[]) AND x.grantee=(SELECT oid FROM pg_catalog.pg_roles WHERE rolname=current_user) AND x.is_grantable`, [schemaName, TABLES]);
  expect(grantable.rowCount === 0, 'grant_options');
}

export async function verifyPostgresWorkerDeliveryAttestation(client, options = {}) {
  try {
    assertPlainRecord(options, 'worker delivery attestation options');
    assertAllowedKeys(options, ['schemaName', 'expectedOwner'], 'worker delivery attestation options');
    expect(client && typeof client.query === 'function', 'client');
    const schemaName = validateIdentifier(options.schemaName ?? DEFAULT_SCHEMA, 'schema_name');
    const expectedOwner = options.expectedOwner === undefined ? undefined : validateIdentifier(options.expectedOwner, 'expected_owner');
    const source = (await readFile(new URL('../migrations/002_worker_delivery.pg.sql', import.meta.url), 'utf8')).replace(/\r\n?/g, '\n');
    const migrationHash = sha256Ref(source);
    await verifyCatalog(client, schemaName, source, migrationHash);
    if (expectedOwner !== undefined) await verifyPrivileges(client, schemaName, expectedOwner);
    return Object.freeze({ schema_name: schemaName, catalog_verified: true,
      runtime_privileges_verified: expectedOwner !== undefined, production_qualified: false });
  } catch (error) {
    if (error?.code === 'WORKER_DELIVERY_POSTGRES_ATTESTATION_FAILED') throw error;
    throw failed(error?.message === 'worker delivery attestation options must be a plain object' ? 'options' : 'query');
  }
}
