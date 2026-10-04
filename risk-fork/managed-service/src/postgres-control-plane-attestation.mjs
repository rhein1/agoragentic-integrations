import { readFile } from 'node:fs/promises';
import { canonicalize, sha256Ref } from '../../src/canonical.mjs';
import { quotePostgresAuthorityIdentifier } from '../../src/adapters/postgres-authority-migrator.mjs';
import { assertAllowedKeys, assertPlainRecord } from './validation.mjs';

const TABLES = Object.freeze([
  'managed_api_keys', 'managed_audit_events', 'managed_invocations',
  'managed_lease_token_uses', 'managed_resource_journal_receipts',
  'managed_schema_migrations', 'managed_tenants', 'managed_usage_buckets',
]);
const INSERT_TABLES = Object.freeze([
  'managed_audit_events', 'managed_invocations', 'managed_lease_token_uses',
  'managed_resource_journal_receipts', 'managed_usage_buckets',
]);
const UPDATE_TABLES = Object.freeze(['managed_invocations', 'managed_usage_buckets']);
const HELPERS = Object.freeze([
  'lock_managed_api_key_share', 'lock_managed_tenant_share', 'lock_managed_tenant_update',
]);
const MIGRATIONS = Object.freeze([
  '001_managed_control_plane.pg.sql', '002_journal_purpose.pg.sql',
  '003_control_plane_lock_helpers.pg.sql',
]);
// Schema-bounded read-only probes compare complete deparsed definitions.
const CATALOG_QUERIES = Object.freeze({
  relations: `SELECT c.relname AS name,c.relkind AS kind,c.relpersistence AS persistence,
    c.relrowsecurity,c.relforcerowsecurity,c.relispartition,c.relpartbound,c.reloptions
    FROM pg_catalog.pg_class c JOIN pg_catalog.pg_namespace n ON n.oid=c.relnamespace
    WHERE n.nspname=$1 AND c.relkind NOT IN ('i','I') ORDER BY c.relname`,
  columns: `SELECT c.relname AS relation,a.attname AS name,a.attnum,
    pg_catalog.format_type(a.atttypid,a.atttypmod) AS type_name,a.attnotnull,
    COALESCE(pg_catalog.pg_get_expr(d.adbin,d.adrelid),'') AS default_expr,
    a.attidentity,a.attgenerated,a.attisdropped,(a.attcollation=t.typcollation) AS default_collation
    FROM pg_catalog.pg_class c JOIN pg_catalog.pg_namespace n ON n.oid=c.relnamespace
    JOIN pg_catalog.pg_attribute a ON a.attrelid=c.oid AND a.attnum>0
    LEFT JOIN pg_catalog.pg_type t ON t.oid=a.atttypid
    LEFT JOIN pg_catalog.pg_attrdef d ON d.adrelid=c.oid AND d.adnum=a.attnum
    WHERE n.nspname=$1 AND c.relkind NOT IN ('i','I') ORDER BY c.relname,a.attnum`,
  constraints: `SELECT c.relname AS relation,con.conname,con.contype,con.convalidated,
    con.condeferrable,con.condeferred,con.connoinherit,
    pg_catalog.pg_get_constraintdef(con.oid,true) AS definition
    FROM pg_catalog.pg_constraint con JOIN pg_catalog.pg_class c ON c.oid=con.conrelid
    JOIN pg_catalog.pg_namespace n ON n.oid=c.relnamespace
    WHERE n.nspname=$1 ORDER BY c.relname,con.conname`,
  indexes: `SELECT i.relname AS name,i.relkind,i.reloptions,
    ix.indisunique,ix.indisprimary,ix.indisvalid,ix.indisready,ix.indislive,
    ix.indisreplident,ix.indnatts,ix.indnkeyatts,
    pg_catalog.pg_get_indexdef(i.oid) AS definition
    FROM pg_catalog.pg_class i JOIN pg_catalog.pg_namespace n ON n.oid=i.relnamespace
    LEFT JOIN pg_catalog.pg_index ix ON ix.indexrelid=i.oid
    WHERE n.nspname=$1 AND i.relkind IN ('i','I') ORDER BY i.relname`,
  triggers: `SELECT c.relname AS relation,t.tgname,t.tgenabled,
    pg_catalog.pg_get_triggerdef(t.oid,true) AS definition
    FROM pg_catalog.pg_trigger t JOIN pg_catalog.pg_class c ON c.oid=t.tgrelid
    JOIN pg_catalog.pg_namespace n ON n.oid=c.relnamespace
    WHERE n.nspname=$1 AND NOT t.tgisinternal ORDER BY c.relname,t.tgname`,
  functions: `SELECT p.proname AS name,p.prosecdef,p.proconfig,p.provolatile,p.proparallel,
    p.proleakproof,p.proisstrict,p.prokind,p.proretset,l.lanname AS language,
    pg_catalog.pg_get_function_identity_arguments(p.oid) AS args,
    pg_catalog.pg_get_functiondef(p.oid) AS definition
    FROM pg_catalog.pg_proc p JOIN pg_catalog.pg_namespace n ON n.oid=p.pronamespace
    JOIN pg_catalog.pg_language l ON l.oid=p.prolang
    WHERE n.nspname=$1 ORDER BY p.proname,pg_catalog.pg_get_function_identity_arguments(p.oid)`,
  types: `SELECT t.typname,t.typtype,t.typcategory,t.typnotnull,
    pg_catalog.format_type(t.typbasetype,NULL) AS base_type
    FROM pg_catalog.pg_type t JOIN pg_catalog.pg_namespace n ON n.oid=t.typnamespace
    WHERE n.nspname=$1 ORDER BY t.typname`,
  policies: `SELECT p.polname FROM pg_catalog.pg_policy p
    JOIN pg_catalog.pg_class c ON c.oid=p.polrelid JOIN pg_catalog.pg_namespace n ON n.oid=c.relnamespace
    WHERE n.nspname=$1 ORDER BY p.polname`,
  rewrites: `SELECT r.rulename FROM pg_catalog.pg_rewrite r
    JOIN pg_catalog.pg_class c ON c.oid=r.ev_class JOIN pg_catalog.pg_namespace n ON n.oid=c.relnamespace
    WHERE n.nspname=$1 ORDER BY r.rulename`,
  inheritance: `SELECT 1 FROM pg_catalog.pg_inherits i
    WHERE i.inhparent IN (SELECT c.oid FROM pg_catalog.pg_class c JOIN pg_catalog.pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname=$1)
    OR i.inhrelid IN (SELECT c.oid FROM pg_catalog.pg_class c JOIN pg_catalog.pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname=$1)`,
});

function failed(scope) {
  const error = new Error('Managed PostgreSQL attestation failed');
  error.code = 'MANAGED_POSTGRES_ATTESTATION_FAILED';
  error.evidence = Object.freeze({ scope });
  return error;
}
function expect(value, scope) { if (!value) throw failed(scope); }
function identifier(value) { quotePostgresAuthorityIdentifier(value); return value; }
function normalize(value, schema) {
  if (typeof value === 'string') return value.replaceAll(`"${schema}".`, '__schema__.')
    .replaceAll(`${schema}.`, '__schema__.');
  if (Array.isArray(value)) return value.map((item) => normalize(item, schema));
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value)
    .map(([key, item]) => [key, normalize(item, schema)]));
  return value;
}

// Internal read-only capture for a reproducible PostgreSQL 16 manifest.
// No request or runtime option may supply the expected manifest.
export async function readManagedPostgresCatalog(client, schemaName) {
  const schema = identifier(schemaName);
  const catalog = {};
  for (const [name, query] of Object.entries(CATALOG_QUERIES)) {
    catalog[name] = normalize((await client.query(query, [schema])).rows, schema);
  }
  return catalog;
}

async function verifyCatalog(client, schema) {
  const version = await client.query("SELECT pg_catalog.current_setting('server_version_num') AS version");
  expect(version.rowCount === 1 && Number(version.rows[0].version) >= 160000
    && Number(version.rows[0].version) < 170000, 'postgres_version');
  const manifest = JSON.parse(await readFile(new URL('./postgres-control-plane-catalog.json', import.meta.url), 'utf8'));
  const sources = await Promise.all(MIGRATIONS.map(async (file) => (
    await readFile(new URL(`../migrations/${file}`, import.meta.url), 'utf8')).replace(/\r\n?/g, '\n')));
  expect(manifest.schema === 'agoragentic.risk-fork.managed-postgres-catalog.v1'
    && manifest.postgres_major === 16
    && canonicalize(manifest.migration_hashes) === canonicalize(sources.map(sha256Ref)), 'manifest_source');
  const observed = await readManagedPostgresCatalog(client, schema);
  for (const key of Object.keys(CATALOG_QUERIES)) {
    expect(canonicalize(observed[key]) === canonicalize(manifest.catalog[key]), `catalog_${key}`);
  }
  const ledger = await client.query(`SELECT version,migration_hash,applied_at
    FROM "${schema}".managed_schema_migrations ORDER BY version`);
  expect(canonicalize(ledger.rows.map((row) => ({
    version: row.version, migration_hash: row.migration_hash, applied: row.applied_at !== null,
  }))) === canonicalize(manifest.migration_hashes.map((hash, index) => ({
    version: index + 1, migration_hash: hash, applied: true,
  }))), 'migration_ledger');
}

async function verifyPrivileges(client, schema, owner) {
  const role = (await client.query(`SELECT current_user AS runtime,session_user AS session,
    r.rolcanlogin,r.rolinherit,r.rolsuper,r.rolcreatedb,r.rolcreaterole,r.rolreplication,r.rolbypassrls,
    pg_catalog.current_setting('fsync') AS fsync,
    pg_catalog.current_setting('synchronous_commit') AS synchronous_commit,
    pg_catalog.current_setting('session_replication_role') AS replication_role
    FROM pg_catalog.pg_roles r WHERE r.rolname=current_user`)).rows;
  expect(role.length === 1 && role[0].runtime === role[0].session && role[0].runtime !== owner
    && role[0].rolcanlogin && !role[0].rolinherit && !role[0].rolsuper && !role[0].rolcreatedb
    && !role[0].rolcreaterole && !role[0].rolreplication && !role[0].rolbypassrls
    && role[0].fsync === 'on' && role[0].synchronous_commit === 'on'
    && role[0].replication_role === 'origin', 'role');
  expect((await client.query(`SELECT 1 FROM pg_catalog.pg_auth_members
    WHERE member=(SELECT oid FROM pg_catalog.pg_roles WHERE rolname=current_user) LIMIT 1`)).rowCount === 0, 'membership');
  const owners = await client.query(`SELECT 1 FROM (
    SELECT n.nspowner AS owner FROM pg_catalog.pg_namespace n WHERE n.nspname=$1
    UNION ALL SELECT c.relowner FROM pg_catalog.pg_class c JOIN pg_catalog.pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname=$1
    UNION ALL SELECT p.proowner FROM pg_catalog.pg_proc p JOIN pg_catalog.pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname=$1
    UNION ALL SELECT t.typowner FROM pg_catalog.pg_type t JOIN pg_catalog.pg_namespace n ON n.oid=t.typnamespace WHERE n.nspname=$1
    ) owned WHERE owner IS DISTINCT FROM (SELECT oid FROM pg_catalog.pg_roles WHERE rolname=$2)`, [schema, owner]);
  expect(owners.rowCount === 0, 'ownership');
  const runtime = role[0].runtime;
  const tables = await client.query(`SELECT c.relname AS name,r.rolname AS grantee,
    x.privilege_type,x.is_grantable FROM pg_catalog.pg_class c
    JOIN pg_catalog.pg_namespace n ON n.oid=c.relnamespace
    CROSS JOIN LATERAL pg_catalog.aclexplode(COALESCE(c.relacl,pg_catalog.acldefault('r',c.relowner))) x
    LEFT JOIN pg_catalog.pg_roles r ON r.oid=x.grantee
    WHERE n.nspname=$1 AND c.relname=ANY($2::text[]) AND x.grantee<>c.relowner
    ORDER BY c.relname,x.privilege_type,r.rolname`, [schema, TABLES]);
  const expected = TABLES.flatMap((name) => ['SELECT',
    ...(INSERT_TABLES.includes(name) ? ['INSERT'] : []),
    ...(UPDATE_TABLES.includes(name) ? ['UPDATE'] : [])].sort().map((privilege_type) => ({
      name, grantee: runtime, privilege_type, is_grantable: false,
    })));
  expect(canonicalize(tables.rows) === canonicalize(expected), 'table_acls');
  const functions = await client.query(`SELECT p.proname AS name,r.rolname AS grantee,
    x.privilege_type,x.is_grantable FROM pg_catalog.pg_proc p
    JOIN pg_catalog.pg_namespace n ON n.oid=p.pronamespace
    CROSS JOIN LATERAL pg_catalog.aclexplode(COALESCE(p.proacl,pg_catalog.acldefault('f',p.proowner))) x
    LEFT JOIN pg_catalog.pg_roles r ON r.oid=x.grantee
    WHERE n.nspname=$1 AND x.grantee<>p.proowner ORDER BY p.proname,x.privilege_type,r.rolname`, [schema]);
  expect(canonicalize(functions.rows) === canonicalize(HELPERS.map((name) => ({
    name, grantee: runtime, privilege_type: 'EXECUTE', is_grantable: false,
  }))), 'function_acls');
  for (const [scope, sql, params] of [
    ['column_acls', `SELECT 1 FROM pg_catalog.pg_class c JOIN pg_catalog.pg_namespace n ON n.oid=c.relnamespace
      JOIN pg_catalog.pg_attribute a ON a.attrelid=c.oid
      CROSS JOIN LATERAL pg_catalog.aclexplode(a.attacl) x
      WHERE n.nspname=$1 AND x.grantee<>c.relowner`, [schema]],
    ['schema_acls', `SELECT 1 FROM pg_catalog.pg_namespace n
      CROSS JOIN LATERAL pg_catalog.aclexplode(COALESCE(n.nspacl,pg_catalog.acldefault('n',n.nspowner))) x
      WHERE n.nspname=$1 AND x.grantee<>n.nspowner AND NOT (
        x.grantee=(SELECT oid FROM pg_catalog.pg_roles WHERE rolname=current_user)
        AND x.privilege_type='USAGE' AND NOT x.is_grantable)`, [schema]],
    ['database_acls', `SELECT 1 FROM pg_catalog.pg_database d
      CROSS JOIN LATERAL pg_catalog.aclexplode(COALESCE(d.datacl,pg_catalog.acldefault('d',d.datdba))) x
      WHERE d.datname=pg_catalog.current_database() AND NOT (x.grantee=d.datdba OR (
        x.grantee=(SELECT oid FROM pg_catalog.pg_roles WHERE rolname=$1)
        AND x.privilege_type IN ('CONNECT','CREATE') AND NOT x.is_grantable) OR (
        x.grantee=(SELECT oid FROM pg_catalog.pg_roles WHERE rolname=current_user)
        AND x.privilege_type='CONNECT' AND NOT x.is_grantable))`, [owner]],
    ['default_acls', `SELECT 1 FROM pg_catalog.pg_default_acl d
      CROSS JOIN LATERAL pg_catalog.aclexplode(d.defaclacl) x
      WHERE d.defaclrole=(SELECT oid FROM pg_catalog.pg_roles WHERE rolname=$2)
      AND d.defaclnamespace=(SELECT oid FROM pg_catalog.pg_namespace WHERE nspname=$1)
      AND x.grantee<>d.defaclrole`, [schema, owner]],
    ['global_acls', `SELECT 1 FROM pg_catalog.pg_roles o
      CROSS JOIN (VALUES ('r'),('S'),('f')) k(kind)
      LEFT JOIN pg_catalog.pg_default_acl d ON d.defaclrole=o.oid AND d.defaclnamespace=0
        AND d.defaclobjtype=k.kind::"char"
      CROSS JOIN LATERAL pg_catalog.aclexplode(COALESCE(d.defaclacl,pg_catalog.acldefault(k.kind::"char",o.oid))) x
      WHERE o.rolname=$1 AND x.grantee<>o.oid`, [owner]],
  ]) expect((await client.query(sql, params)).rowCount === 0, scope);
  const effective = await client.query(`SELECT
    pg_catalog.has_schema_privilege(current_user,$1,'USAGE') AS usage,
    pg_catalog.has_schema_privilege(current_user,$1,'CREATE') AS schema_create,
    pg_catalog.has_database_privilege(current_user,pg_catalog.current_database(),'CONNECT') AS connect,
    pg_catalog.has_database_privilege(current_user,pg_catalog.current_database(),'CREATE') AS db_create,
    pg_catalog.has_database_privilege(current_user,pg_catalog.current_database(),'TEMPORARY') AS temporary,
    (SELECT d.datdba=(SELECT oid FROM pg_catalog.pg_roles WHERE rolname=current_user)
      FROM pg_catalog.pg_database d WHERE d.datname=pg_catalog.current_database()) AS database_owner`, [schema]);
  expect(effective.rowCount === 1 && effective.rows[0].usage && effective.rows[0].connect
    && !effective.rows[0].schema_create && !effective.rows[0].db_create
    && !effective.rows[0].temporary && !effective.rows[0].database_owner, 'effective_privileges');
}

export async function verifyPostgresControlPlaneAttestation(client, options = {}) {
  try {
    assertPlainRecord(options, 'managed PostgreSQL attestation options');
    assertAllowedKeys(options, ['schemaName', 'expectedOwner'], 'managed PostgreSQL attestation options');
    expect(client && typeof client.query === 'function', 'client');
    const schema = identifier(options.schemaName ?? 'risk_fork_managed');
    const owner = options.expectedOwner === undefined ? undefined : identifier(options.expectedOwner);
    await verifyCatalog(client, schema);
    if (owner !== undefined) await verifyPrivileges(client, schema, owner);
    return Object.freeze({ schema_name: schema, catalog_verified: true,
      runtime_privileges_verified: owner !== undefined, production_qualified: false });
  } catch (error) {
    if (error?.code === 'MANAGED_POSTGRES_ATTESTATION_FAILED') throw error;
    throw failed('query');
  }
}
