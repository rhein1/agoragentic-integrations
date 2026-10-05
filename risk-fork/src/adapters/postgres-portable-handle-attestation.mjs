import { canonicalize } from '../canonical.mjs';
import { readFile } from 'node:fs/promises';
import { assertAllowedKeys } from '../util.mjs';
import { quotePostgresAuthorityIdentifier } from './postgres-authority-migrator.mjs';

const RELATIONS = Object.freeze([
  'handle_consumptions', 'handle_namespaces', 'handle_schema_migrations', 'portable_handles',
]);
const COLUMNS = Object.freeze({
  handle_schema_migrations: [
    ['version', 'integer', true, null], ['migration_hash', 'text', true, null],
  ],
  handle_namespaces: [
    ['tenant_ref', 'text', true, null], ['key_id', 'text', true, null],
    ['key_fingerprint', 'text', true, null], ['max_entries', 'integer', true, null],
  ],
  portable_handles: [
    ['tenant_ref', 'text', true, null], ['key_id', 'text', true, null],
    ['handle_hash', 'text', true, null], ['binding', 'jsonb', true, null],
    ['expires_at', 'timestamp with time zone', true, null],
    ['max_consumptions', 'integer', true, null],
    ['consumption_count', 'integer', true, '0'], ['revoked_at', 'timestamp with time zone', false, null],
  ],
  handle_consumptions: [
    ['tenant_ref', 'text', true, null], ['key_id', 'text', true, null],
    ['handle_hash', 'text', true, null], ['request_hash', 'text', true, null],
    ['authorization_receipt', 'jsonb', true, null], ['consumed_at', 'timestamp with time zone', true, null],
  ],
});
const PKS = Object.freeze([
  'handle_consumptions_pkey', 'handle_namespaces_pkey',
  'handle_schema_migrations_pkey', 'portable_handles_pkey',
]);
const TRIGGERS = Object.freeze([
  'handle_consumptions_immutable', 'handle_consumptions_no_truncate',
  'handle_migrations_immutable', 'handle_migrations_no_truncate',
  'handle_namespaces_immutable', 'handle_namespaces_no_truncate',
  'portable_handle_binding_immutable', 'portable_handles_no_truncate',
]);
const REQUIRED = Object.freeze({
  handle_schema_migrations: ['SELECT'],
  handle_namespaces: ['SELECT', 'INSERT'],
  portable_handles: ['SELECT', 'INSERT'],
  handle_consumptions: ['SELECT', 'INSERT'],
});
const FORBIDDEN = Object.freeze({
  handle_schema_migrations: ['INSERT', 'UPDATE', 'DELETE', 'TRUNCATE', 'REFERENCES', 'TRIGGER'],
  handle_namespaces: ['UPDATE', 'DELETE', 'TRUNCATE', 'REFERENCES', 'TRIGGER'],
  portable_handles: ['UPDATE', 'DELETE', 'TRUNCATE', 'REFERENCES', 'TRIGGER'],
  handle_consumptions: ['UPDATE', 'DELETE', 'TRUNCATE', 'REFERENCES', 'TRIGGER'],
});

function invalid(message, evidence = {}) {
  const error = new TypeError(message);
  error.code = 'MCP_PORTABLE_HANDLE_POSTGRES_ATTESTATION_FAILED';
  error.evidence = evidence;
  throw error;
}
async function one(client, sql, params = []) {
  const result = await client.query(sql, params);
  if (result.rowCount !== 1) invalid('Portable-handle attestation query was ambiguous');
  return result.rows[0];
}
function check(actual, expected, scope) {
  if (canonicalize(actual) !== canonicalize(expected)) invalid('Portable-handle catalog drift', { scope });
}

async function verifyCatalog(client, schemaName) {
  const relations = await client.query(
    `SELECT c.relname AS name,c.relkind AS kind,c.relpersistence AS persistence,
            c.relrowsecurity AS row_security,c.relforcerowsecurity AS force_row_security
       FROM pg_catalog.pg_class c JOIN pg_catalog.pg_namespace n ON n.oid=c.relnamespace
      WHERE n.nspname=$1 AND c.relkind NOT IN ('i','I') ORDER BY c.relname`,
    [schemaName]);
  check(relations.rows, RELATIONS.map((name) => ({
    name, kind: 'r', persistence: 'p', row_security: false, force_row_security: false,
  })), 'relations');

  const columns = await client.query(
    `SELECT c.relname AS relation,a.attname AS name,a.attnum,
            pg_catalog.format_type(a.atttypid,a.atttypmod) AS type_name,
            a.attnotnull AS not_null,COALESCE(pg_catalog.pg_get_expr(d.adbin,d.adrelid),'') AS default_expr
       FROM pg_catalog.pg_class c JOIN pg_catalog.pg_namespace n ON n.oid=c.relnamespace
       JOIN pg_catalog.pg_attribute a ON a.attrelid=c.oid AND a.attnum>0 AND NOT a.attisdropped
       LEFT JOIN pg_catalog.pg_attrdef d ON d.adrelid=c.oid AND d.adnum=a.attnum
      WHERE n.nspname=$1 AND c.relname=ANY($2::text[]) ORDER BY c.relname,a.attnum`,
    [schemaName, RELATIONS]);
  const expectedColumns = RELATIONS.flatMap((relation) => COLUMNS[relation]
    .map(([name, type_name, not_null, default_expr], index) => ({
      relation, name, attnum: index + 1, type_name, not_null, default_expr: default_expr ?? '',
    })));
  check(columns.rows, expectedColumns, 'columns');

  const constraints = await client.query(
    `SELECT c.relname AS relation,con.conname,con.contype,con.convalidated,
            con.condeferrable,con.condeferred,
            pg_catalog.pg_get_constraintdef(con.oid,true) AS definition
       FROM pg_catalog.pg_constraint con JOIN pg_catalog.pg_class c ON c.oid=con.conrelid
       JOIN pg_catalog.pg_namespace n ON n.oid=c.relnamespace
      WHERE n.nspname=$1 AND c.relname=ANY($2::text[]) ORDER BY c.relname,con.conname`,
    [schemaName, RELATIONS]);
  const expectedConstraints = [
    ['handle_consumptions','handle_consumptions_authorization_receipt_check','c','CHECK (jsonb_typeof(authorization_receipt) = \'object\'::text)'],
    ['handle_consumptions','handle_consumptions_pkey','p','PRIMARY KEY (tenant_ref, key_id, handle_hash, request_hash)'],
    ['handle_consumptions','handle_consumptions_request_hash_check','c',"CHECK (request_hash ~ '^sha256:[a-f0-9]{64}$'::text)"],
    ['handle_consumptions','handle_consumptions_tenant_ref_key_id_handle_hash_fkey','f','FOREIGN KEY (tenant_ref, key_id, handle_hash) REFERENCES __schema__.portable_handles(tenant_ref, key_id, handle_hash)'],
    ['handle_namespaces','handle_namespaces_key_fingerprint_check','c',"CHECK (key_fingerprint ~ '^sha256:[a-f0-9]{64}$'::text)"],
    ['handle_namespaces','handle_namespaces_max_entries_check','c','CHECK (max_entries >= 1 AND max_entries <= 100000)'],
    ['handle_namespaces','handle_namespaces_pkey','p','PRIMARY KEY (tenant_ref, key_id)'],
    ['handle_schema_migrations','handle_schema_migrations_migration_hash_check','c',"CHECK (migration_hash ~ '^sha256:[a-f0-9]{64}$'::text)"],
    ['handle_schema_migrations','handle_schema_migrations_pkey','p','PRIMARY KEY (version)'],
    ['handle_schema_migrations','handle_schema_migrations_version_check','c','CHECK (version = 1)'],
    ['portable_handles','portable_handles_binding_check','c',"CHECK (jsonb_typeof(binding) = 'object'::text)"],
    ['portable_handles','portable_handles_check','c','CHECK (consumption_count >= 0 AND consumption_count <= max_consumptions)'],
    ['portable_handles','portable_handles_handle_hash_check','c',"CHECK (handle_hash ~ '^sha256:[a-f0-9]{64}$'::text)"],
    ['portable_handles','portable_handles_max_consumptions_check','c','CHECK (max_consumptions >= 1 AND max_consumptions <= 1000)'],
    ['portable_handles','portable_handles_pkey','p','PRIMARY KEY (tenant_ref, key_id, handle_hash)'],
    ['portable_handles','portable_handles_tenant_ref_key_id_fkey','f','FOREIGN KEY (tenant_ref, key_id) REFERENCES __schema__.handle_namespaces(tenant_ref, key_id)'],
  ];
  const actualConstraints = constraints.rows.map((row) => [row.relation,row.conname,row.contype,
    row.definition.replaceAll(schemaName, '__schema__')]);
  check(actualConstraints, expectedConstraints, 'constraints');
  if (constraints.rows.some((row) => !row.convalidated || row.condeferrable || row.condeferred)) {
    invalid('Portable-handle constraint flags differ', { scope: 'constraints' });
  }
  const indexes = await client.query(
    `SELECT i.relname AS name,ix.indisunique AS unique_index,ix.indisprimary AS primary_index,
            ix.indisvalid AS valid_index,ix.indisready AS ready_index,
            pg_catalog.pg_get_indexdef(i.oid) AS definition
       FROM pg_catalog.pg_index ix JOIN pg_catalog.pg_class i ON i.oid=ix.indexrelid
       JOIN pg_catalog.pg_class c ON c.oid=ix.indrelid
       JOIN pg_catalog.pg_namespace n ON n.oid=c.relnamespace
      WHERE n.nspname=$1 AND c.relname=ANY($2::text[]) ORDER BY i.relname`,
    [schemaName, RELATIONS]);
  if (canonicalize(indexes.rows.map((row) => row.name)) !== canonicalize(PKS)
      || indexes.rows.some((row) => !row.unique_index || !row.primary_index || !row.valid_index || !row.ready_index)) {
    invalid('Portable-handle indexes are invalid', { scope: 'indexes' });
  }
  check(indexes.rows.map((row) => row.definition.replaceAll(schemaName, '__schema__')), [
    'CREATE UNIQUE INDEX handle_consumptions_pkey ON __schema__.handle_consumptions USING btree (tenant_ref, key_id, handle_hash, request_hash)',
    'CREATE UNIQUE INDEX handle_namespaces_pkey ON __schema__.handle_namespaces USING btree (tenant_ref, key_id)',
    'CREATE UNIQUE INDEX handle_schema_migrations_pkey ON __schema__.handle_schema_migrations USING btree (version)',
    'CREATE UNIQUE INDEX portable_handles_pkey ON __schema__.portable_handles USING btree (tenant_ref, key_id, handle_hash)',
  ], 'index_definitions');
  const triggers = await client.query(
    `SELECT t.tgname AS name,t.tgenabled AS enabled,
            pg_catalog.pg_get_triggerdef(t.oid,true) AS definition
       FROM pg_catalog.pg_trigger t JOIN pg_catalog.pg_class c ON c.oid=t.tgrelid
       JOIN pg_catalog.pg_namespace n ON n.oid=c.relnamespace
      WHERE n.nspname=$1 AND NOT t.tgisinternal ORDER BY t.tgname`, [schemaName]);
  check(triggers.rows.map((row) => row.name), TRIGGERS, 'triggers');
  const expectedTriggerDefinitions = [
    ['handle_consumptions_immutable','CREATE TRIGGER handle_consumptions_immutable BEFORE DELETE OR UPDATE ON __schema__.handle_consumptions FOR EACH ROW EXECUTE FUNCTION __schema__.reject_handle_history_mutation()'],
    ['handle_consumptions_no_truncate','CREATE TRIGGER handle_consumptions_no_truncate BEFORE TRUNCATE ON __schema__.handle_consumptions FOR EACH STATEMENT EXECUTE FUNCTION __schema__.reject_handle_history_mutation()'],
    ['handle_migrations_immutable','CREATE TRIGGER handle_migrations_immutable BEFORE DELETE OR UPDATE ON __schema__.handle_schema_migrations FOR EACH ROW EXECUTE FUNCTION __schema__.reject_handle_history_mutation()'],
    ['handle_migrations_no_truncate','CREATE TRIGGER handle_migrations_no_truncate BEFORE TRUNCATE ON __schema__.handle_schema_migrations FOR EACH STATEMENT EXECUTE FUNCTION __schema__.reject_handle_history_mutation()'],
    ['handle_namespaces_immutable','CREATE TRIGGER handle_namespaces_immutable BEFORE DELETE OR UPDATE ON __schema__.handle_namespaces FOR EACH ROW EXECUTE FUNCTION __schema__.reject_handle_history_mutation()'],
    ['handle_namespaces_no_truncate','CREATE TRIGGER handle_namespaces_no_truncate BEFORE TRUNCATE ON __schema__.handle_namespaces FOR EACH STATEMENT EXECUTE FUNCTION __schema__.reject_handle_history_mutation()'],
    ['portable_handle_binding_immutable','CREATE TRIGGER portable_handle_binding_immutable BEFORE DELETE OR UPDATE ON __schema__.portable_handles FOR EACH ROW EXECUTE FUNCTION __schema__.protect_handle_binding()'],
    ['portable_handles_no_truncate','CREATE TRIGGER portable_handles_no_truncate BEFORE TRUNCATE ON __schema__.portable_handles FOR EACH STATEMENT EXECUTE FUNCTION __schema__.reject_handle_history_mutation()'],
  ];
  check(triggers.rows.map((row) => [row.name,row.definition.replaceAll(schemaName,'__schema__')]), expectedTriggerDefinitions, 'trigger_definitions');
  if (triggers.rows.some((row) => row.enabled !== 'O')) invalid('Portable-handle trigger disabled', { scope: 'triggers' });
  const functions = await client.query(`SELECT p.proname AS name,pg_get_function_identity_arguments(p.oid) AS args,
      format_type(p.prorettype,NULL) AS returns,p.prosrc AS body,p.prosecdef,
      p.proconfig,p.provolatile,p.proparallel,p.proleakproof,p.proisstrict,
      p.prokind,l.lanname AS language
    FROM pg_catalog.pg_proc p JOIN pg_catalog.pg_namespace n ON n.oid=p.pronamespace
    JOIN pg_catalog.pg_language l ON l.oid=p.prolang
    WHERE n.nspname=$1 ORDER BY p.proname`,
    [schemaName]);
  const migration = (await readFile(new URL('../../migrations/mcp-portable-handles/001_registry.pg.sql', import.meta.url), 'utf8'))
    .replace(/\r\n?/g, '\n');
  check(functions.rows.map((row) => [row.name,row.args,row.returns]), [
    ['protect_handle_binding','','trigger'], ['reject_handle_history_mutation','','trigger'],
  ], 'functions');
  for (const row of functions.rows) {
    const source = migration.split(`CREATE FUNCTION __MCP_HANDLE_SCHEMA__.${row.name}()`)[1];
    const expectedBody = source?.split('AS $$')[1]?.split('$$;')[0];
    if (!expectedBody || row.body.replace(/\r\n?/g, '\n') !== expectedBody
      || row.prosecdef || row.proconfig !== null || row.provolatile !== 'v'
      || row.proparallel !== 'u' || row.proleakproof || row.proisstrict
      || row.prokind !== 'f' || row.language !== 'plpgsql') {
      invalid('Portable-handle function body or attributes drift', { function: row.name });
    }
  }
  for (const [scope, sql] of [
    ['inheritance', `SELECT 1 FROM pg_catalog.pg_inherits i WHERE i.inhparent IN
      (SELECT c.oid FROM pg_catalog.pg_class c JOIN pg_catalog.pg_namespace n ON n.oid=c.relnamespace
       WHERE n.nspname=$1 AND c.relname=ANY($2::text[])) OR i.inhrelid IN
      (SELECT c.oid FROM pg_catalog.pg_class c JOIN pg_catalog.pg_namespace n ON n.oid=c.relnamespace
       WHERE n.nspname=$1 AND c.relname=ANY($2::text[])) LIMIT 1`],
    ['policies', `SELECT 1 FROM pg_catalog.pg_policy p JOIN pg_catalog.pg_class c ON c.oid=p.polrelid
      JOIN pg_catalog.pg_namespace n ON n.oid=c.relnamespace
      WHERE n.nspname=$1 AND c.relname=ANY($2::text[]) LIMIT 1`],
    ['rewrites', `SELECT 1 FROM pg_catalog.pg_rewrite r JOIN pg_catalog.pg_class c ON c.oid=r.ev_class
      JOIN pg_catalog.pg_namespace n ON n.oid=c.relnamespace
      WHERE n.nspname=$1 AND c.relname=ANY($2::text[]) AND r.rulename<>'_RETURN' LIMIT 1`],
    ['generated_columns', `SELECT 1 FROM pg_catalog.pg_attribute a JOIN pg_catalog.pg_class c ON c.oid=a.attrelid
      JOIN pg_catalog.pg_namespace n ON n.oid=c.relnamespace
      WHERE n.nspname=$1 AND c.relname=ANY($2::text[]) AND a.attgenerated<>'' LIMIT 1`],
  ]) {
    const result = await client.query(sql, [schemaName, RELATIONS]);
    if (result.rowCount) invalid('Portable-handle unexpected catalog object', { scope });
  }
}

async function verifyPrivileges(client, schemaName, expectedOwner) {
  const role = await one(client, `SELECT current_user AS current_role,session_user AS session_role,
      r.rolcanlogin AS can_login,r.rolsuper AS superuser,r.rolcreatedb AS createdb,
      r.rolcreaterole AS createrole,r.rolreplication AS replication,r.rolbypassrls AS bypassrls,
      current_setting('fsync') AS fsync,current_setting('synchronous_commit') AS synchronous_commit,
      current_setting('session_replication_role') AS replication_role
      FROM pg_catalog.pg_roles r WHERE r.rolname=current_user`);
  if (role.current_role !== role.session_role || !role.can_login || role.superuser || role.createdb
      || role.createrole || role.replication || role.bypassrls || role.fsync !== 'on'
      || role.synchronous_commit !== 'on' || role.replication_role !== 'origin') {
    invalid('Portable-handle runtime role is not least privilege', { scope: 'role' });
  }
  const memberships = await client.query(`WITH RECURSIVE m(roleid) AS (
    SELECT am.roleid FROM pg_catalog.pg_auth_members am
    WHERE am.member=(SELECT oid FROM pg_catalog.pg_roles WHERE rolname=current_user)
    UNION SELECT am.roleid FROM pg_catalog.pg_auth_members am JOIN m ON m.roleid=am.member)
    SELECT 1 FROM m LIMIT 1`);
  if (memberships.rowCount) invalid('Portable-handle runtime role has membership', { scope: 'membership' });
  const db = await one(client, `SELECT has_database_privilege(current_user,current_database(),'CONNECT') AS connect,
    has_database_privilege(current_user,current_database(),'CREATE') AS create_db,
    has_database_privilege(current_user,current_database(),'TEMPORARY') AS temporary`);
  if (!db.connect || db.create_db || db.temporary) invalid('Portable-handle database ACL is unsafe', { scope: 'database' });
  const schema = await one(client, `SELECT has_schema_privilege(current_user,$1,'USAGE') AS usage,
    has_schema_privilege(current_user,$1,'CREATE') AS create_schema`, [schemaName]);
  if (!schema.usage || schema.create_schema) invalid('Portable-handle schema ACL is unsafe', { scope: 'schema' });
  for (const relation of RELATIONS) {
    for (const privilege of REQUIRED[relation]) {
      const row = await one(client, 'SELECT has_table_privilege(current_user,$1,$2) AS allowed',
        [`"${schemaName}"."${relation}"`, privilege]);
      if (!row.allowed) invalid('Portable-handle required privilege is missing', { relation, privilege });
    }
    for (const privilege of FORBIDDEN[relation]) {
      const row = await one(client, 'SELECT has_table_privilege(current_user,$1,$2) AS allowed',
        [`"${schemaName}"."${relation}"`, privilege]);
      if (row.allowed) invalid('Portable-handle forbidden privilege is present', { relation, privilege });
      if (['handle_namespaces', 'portable_handles'].includes(relation) && privilege === 'UPDATE') {
        const columns = await client.query(`SELECT a.attname AS name,
          has_column_privilege(current_user,a.attrelid,a.attname,'UPDATE') AS allowed
          FROM pg_catalog.pg_attribute a WHERE a.attrelid=$1::regclass
          AND a.attnum>0 AND NOT a.attisdropped ORDER BY a.attnum`,
        [`"${schemaName}"."${relation}"`]);
        const permitted = relation === 'handle_namespaces'
          ? ['max_entries'] : ['consumption_count', 'revoked_at'];
        check(columns.rows, COLUMNS[relation].map(([name]) => ({
          name, allowed: permitted.includes(name),
        })), `${relation}_update_privileges`);
        continue;
      }
      if (['INSERT', 'UPDATE', 'REFERENCES'].includes(privilege)) {
        const column = await one(client, 'SELECT has_any_column_privilege(current_user,$1,$2) AS allowed',
          [`"${schemaName}"."${relation}"`, privilege]);
        if (column.allowed) invalid('Portable-handle forbidden column privilege is present', { relation, privilege });
      }
    }
  }
  const owners = await client.query(`SELECT c.relname FROM pg_catalog.pg_class c
    JOIN pg_catalog.pg_namespace n ON n.oid=c.relnamespace JOIN pg_catalog.pg_roles r ON r.oid=c.relowner
    WHERE n.nspname=$1 AND c.relname=ANY($2::text[]) AND (r.rolname=current_user OR ($3::text IS NOT NULL AND r.rolname<>$3::text))`,
    [schemaName, RELATIONS, expectedOwner ?? null]);
  if (owners.rowCount) invalid('Portable-handle relation ownership is unsafe', { scope: 'ownership' });
  const funcs = await client.query(`SELECT p.proname FROM pg_catalog.pg_proc p
    JOIN pg_catalog.pg_namespace n ON n.oid=p.pronamespace JOIN pg_catalog.pg_roles r ON r.oid=p.proowner
    WHERE n.nspname=$1 AND p.proname=ANY($2::text[]) AND (r.rolname=current_user OR ($3::text IS NOT NULL AND r.rolname<>$3::text))`,
    [schemaName, ['protect_handle_binding', 'reject_handle_history_mutation'], expectedOwner ?? null]);
  if (funcs.rowCount) invalid('Portable-handle function ownership is unsafe', { scope: 'function_ownership' });
  const schemaOwner = await one(client, `SELECT r.rolname AS owner FROM pg_namespace n
    JOIN pg_roles r ON r.oid=n.nspowner WHERE n.nspname=$1`, [schemaName]);
  if (schemaOwner.owner !== expectedOwner) invalid('Portable-handle schema owner differs', { scope: 'schema_ownership' });
  for (const name of ['protect_handle_binding', 'reject_handle_history_mutation']) {
    const permission = await one(client, 'SELECT has_function_privilege(current_user,$1,$2) AS allowed',
      [`"${schemaName}"."${name}"()`, 'EXECUTE']);
    if (permission.allowed) invalid('Portable-handle direct function execution is forbidden', { scope: 'function_execute' });
  }
}

export async function verifyPostgresMcpPortableHandleAttestation(client, options = {}) {
  if (!client || typeof client.query !== 'function') throw new TypeError('client.query required');
  assertAllowedKeys(options, ['schemaName', 'deploymentMode', 'expectedOwner'], 'portable attestation options');
  const schemaName = options.schemaName ?? 'risk_fork_mcp_handles';
  quotePostgresAuthorityIdentifier(schemaName);
  if (!['local_test', 'production'].includes(options.deploymentMode ?? 'local_test')) {
    throw new TypeError('Invalid deploymentMode');
  }
  await verifyCatalog(client, schemaName);
  const production = (options.deploymentMode ?? 'local_test') === 'production';
  if (production) {
    if (typeof options.expectedOwner !== 'string' || options.expectedOwner.length === 0) {
      invalid('Production portable-handle attestation requires expectedOwner', { scope: 'ownership' });
    }
    await verifyPrivileges(client, schemaName, options.expectedOwner);
  }
  return Object.freeze({ schema_name: schemaName, catalog_verified: true,
    runtime_privileges_verified: production });
}
