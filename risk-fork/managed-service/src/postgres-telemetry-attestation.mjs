import { readFile } from 'node:fs/promises';
import { canonicalize, sha256Ref } from '../../src/canonical.mjs';
import { quotePostgresAuthorityIdentifier } from '../../src/adapters/postgres-authority-migrator.mjs';
import { readRequestPolicyPostgresCatalog } from './postgres-request-policy-attestation.mjs';
import { TELEMETRY_TABLES, TELEMETRY_INSERT_COLUMNS, TELEMETRY_UPDATE_COLUMNS, LIFECYCLE_TABLES, LIFECYCLE_INSERT_COLUMNS, lifecycleMigration,
  METRIC_TABLES, METRIC_ALERT_INSERT_COLUMNS, METRIC_SOURCE_INSERT_COLUMNS, METRIC_WINDOW_INSERT_COLUMNS, metricsMigration, executionMetricsMigration, budgetMetricsMigration, cleanupMetricsMigration, cleanupIncompleteMetricsMigration } from './postgres-telemetry-config.mjs';
import { assertAllowedKeys, assertPlainRecord } from './validation.mjs';

const TABLES = TELEMETRY_TABLES;
const GRANTS = Object.freeze({ telemetry_clock: { UPDATE: ['last_seen_ms'] },
  telemetry_events: { INSERT: TELEMETRY_INSERT_COLUMNS, UPDATE: TELEMETRY_UPDATE_COLUMNS } });
const MANIFEST_SCHEMA = 'agoragentic.risk-fork.telemetry-postgres-catalog.v1';

function failed(scope) {
  const error = new Error('Managed telemetry PostgreSQL attestation failed');
  error.code = 'TELEMETRY_POSTGRES_ATTESTATION_FAILED';
  error.evidence = Object.freeze({ scope });
  return error;
}
function expect(value, scope) { if (!value) throw failed(scope); }
function same(actual, expected, scope) { expect(canonicalize(actual) === canonicalize(expected), scope); }
function identifier(value) { quotePostgresAuthorityIdentifier(value); return value; }

// The shared reader captures catalog structure, not policy state or authority.
export const readManagedTelemetryPostgresCatalog = readRequestPolicyPostgresCatalog;

async function verifyCatalog(client, schema, lifecycle, metrics, metricVersion) {
  const settings = await client.query(`SELECT pg_catalog.current_setting('server_version_num')::integer AS version,
    pg_catalog.current_setting('fsync') AS fsync,pg_catalog.current_setting('synchronous_commit') AS sync,
    pg_catalog.current_setting('session_replication_role') AS triggers`);
  const row = settings.rows[0];
  expect(settings.rowCount === 1 && Number.isInteger(row?.version) && row.version >= 160000 && row.version < 170000
    && row.fsync === 'on' && row.sync === 'on' && row.triggers === 'origin', 'settings');
  const source = (await readFile(new URL('../migrations/005_managed_telemetry.pg.sql', import.meta.url), 'utf8')).replace(/\r\n?/g, '\n');
  const hash = sha256Ref(source);
  const extension = lifecycle ? await lifecycleMigration(schema) : null;
  const metricExtension = metrics ? await metricsMigration(schema) : null;
  const executionExtension = metricVersion >= 4 ? await executionMetricsMigration(schema) : null;
  const budgetExtension = metricVersion >= 5 ? await budgetMetricsMigration(schema) : null;
  const cleanupExtension = metricVersion >= 6 ? await cleanupMetricsMigration(schema) : null;
  const incompleteExtension = metricVersion === 7 ? await cleanupIncompleteMetricsMigration(schema) : null;
  const manifest = JSON.parse(await readFile(new URL(incompleteExtension ? './postgres-cleanup-incomplete-metrics-catalog.json' : cleanupExtension ? './postgres-cleanup-metrics-catalog.json' : budgetExtension ? './postgres-budget-metrics-catalog.json' : executionExtension ? './postgres-execution-metrics-catalog.json' : metrics ? './postgres-metrics-catalog.json' : lifecycle ? './postgres-lifecycle-catalog.json' : './postgres-telemetry-catalog.json', import.meta.url), 'utf8'));
  expect(manifest.schema === (incompleteExtension ? 'agoragentic.risk-fork.telemetry-postgres-catalog.v7' : cleanupExtension ? 'agoragentic.risk-fork.telemetry-postgres-catalog.v6' : budgetExtension ? 'agoragentic.risk-fork.telemetry-postgres-catalog.v5' : executionExtension ? 'agoragentic.risk-fork.telemetry-postgres-catalog.v4' : metrics ? 'agoragentic.risk-fork.telemetry-postgres-catalog.v3' : lifecycle ? 'agoragentic.risk-fork.telemetry-postgres-catalog.v2' : MANIFEST_SCHEMA)
    && manifest.postgres_major === 16 && manifest.migration_hash === hash
    && (!extension || manifest.lifecycle_migration_hash === extension.hash)
    && (!metricExtension || manifest.metrics_migration_hash === metricExtension.hash)
    && (!executionExtension || manifest.execution_metrics_migration_hash === executionExtension.hash)
    && (!budgetExtension || manifest.budget_metrics_migration_hash === budgetExtension.hash)
    && (!cleanupExtension || manifest.cleanup_metrics_migration_hash === cleanupExtension.hash)
    && (!incompleteExtension || manifest.cleanup_incomplete_metrics_migration_hash === incompleteExtension.hash), 'manifest_source');
  same(await readManagedTelemetryPostgresCatalog(client, schema), manifest.catalog, 'catalog');
  const ledger = await client.query(`SELECT version,migration_hash FROM "${schema}".telemetry_schema_migrations ORDER BY version`);
  same(ledger.rows, [{ version: 1, migration_hash: hash },...(extension ? [{ version: 2,migration_hash: extension.hash }] : []),
    ...(metricExtension ? [{ version: 3,migration_hash: metricExtension.hash }] : []),
    ...(executionExtension ? [{ version: 4,migration_hash: executionExtension.hash }] : []),
    ...(budgetExtension ? [{ version: 5,migration_hash: budgetExtension.hash }] : []),
    ...(cleanupExtension ? [{ version: 6,migration_hash: cleanupExtension.hash }] : []),
    ...(incompleteExtension ? [{ version: 7,migration_hash: incompleteExtension.hash }] : [])], 'migration_ledger');
}

async function verifyPrivileges(client, schema, owner, lifecycle, metrics) {
  const tablesExpected = [...TABLES,...(lifecycle ? LIFECYCLE_TABLES : []),...(metrics ? METRIC_TABLES : [])].sort();
  const grants = { ...GRANTS,...(lifecycle ? {
    telemetry_lifecycle_events: { INSERT: LIFECYCLE_INSERT_COLUMNS,UPDATE: TELEMETRY_UPDATE_COLUMNS },
    telemetry_lifecycle_checkpoints: { INSERT: ['observer_hash','tenant_hash','invocation_hash','sequence','event_hash','checkpoint_hash'],UPDATE: ['sequence','event_hash','checkpoint_hash'] },
    telemetry_lifecycle_sweeps: { INSERT: ['observer_hash','tenant_hash','payload','state_hash'],UPDATE: ['payload','state_hash'] },
  } : {}),...(metrics ? {
    telemetry_metric_alerts: { INSERT: METRIC_ALERT_INSERT_COLUMNS,UPDATE: TELEMETRY_UPDATE_COLUMNS },
    telemetry_metric_sources: { INSERT: METRIC_SOURCE_INSERT_COLUMNS },
    telemetry_metric_totals: { UPDATE: ['source_count','window_count','state_hash'] },
    telemetry_metric_windows: { INSERT: METRIC_WINDOW_INSERT_COLUMNS,UPDATE: ['payload','state_hash'] },
  } : {}) };
  const roles = await client.query(`SELECT current_user AS runtime,session_user AS session,
    r.rolcanlogin,r.rolinherit,r.rolsuper,r.rolcreatedb,r.rolcreaterole,r.rolreplication,r.rolbypassrls
    FROM pg_catalog.pg_roles r WHERE r.rolname=current_user`);
  const role = roles.rows[0];
  expect(roles.rowCount === 1 && role.runtime === role.session && role.runtime !== owner && role.rolcanlogin
    && !role.rolinherit && !role.rolsuper && !role.rolcreatedb && !role.rolcreaterole && !role.rolreplication && !role.rolbypassrls, 'role');
  expect((await client.query(`WITH RECURSIVE m(roleid) AS (
    SELECT roleid FROM pg_catalog.pg_auth_members WHERE member=(SELECT oid FROM pg_catalog.pg_roles WHERE rolname=current_user)
    UNION SELECT a.roleid FROM pg_catalog.pg_auth_members a JOIN m ON m.roleid=a.member)
    SELECT 1 FROM m LIMIT 1`)).rowCount === 0, 'membership');
  const owners = await client.query(`SELECT 1 FROM (
    SELECT n.nspowner AS owner FROM pg_catalog.pg_namespace n WHERE n.nspname=$1
    UNION ALL SELECT c.relowner FROM pg_catalog.pg_class c JOIN pg_catalog.pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname=$1
    UNION ALL SELECT p.proowner FROM pg_catalog.pg_proc p JOIN pg_catalog.pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname=$1
    UNION ALL SELECT t.typowner FROM pg_catalog.pg_type t JOIN pg_catalog.pg_namespace n ON n.oid=t.typnamespace WHERE n.nspname=$1
    ) owned WHERE owner IS DISTINCT FROM (SELECT oid FROM pg_catalog.pg_roles WHERE rolname=$2)`, [schema, owner]);
  expect(owners.rowCount === 0, 'ownership');
  const tables = await client.query(`SELECT c.relname AS name,r.rolname AS grantee,x.privilege_type,x.is_grantable
    FROM pg_catalog.pg_class c JOIN pg_catalog.pg_namespace n ON n.oid=c.relnamespace
    CROSS JOIN LATERAL pg_catalog.aclexplode(COALESCE(c.relacl,pg_catalog.acldefault('r',c.relowner))) x
    LEFT JOIN pg_catalog.pg_roles r ON r.oid=x.grantee
    WHERE n.nspname=$1 AND x.grantee<>c.relowner ORDER BY c.relname,x.privilege_type,r.rolname`, [schema]);
  same(tables.rows, tablesExpected.flatMap((name) => ['SELECT']
    .map((privilege_type) => ({ name, grantee: role.runtime, privilege_type, is_grantable: false }))), 'table_acls');
  const columns = await client.query(`SELECT c.relname AS relation,a.attname AS name,r.rolname AS grantee,
    x.privilege_type,x.is_grantable FROM pg_catalog.pg_class c JOIN pg_catalog.pg_namespace n ON n.oid=c.relnamespace
    JOIN pg_catalog.pg_attribute a ON a.attrelid=c.oid AND a.attnum>0 AND NOT a.attisdropped
    CROSS JOIN LATERAL pg_catalog.aclexplode(a.attacl) x LEFT JOIN pg_catalog.pg_roles r ON r.oid=x.grantee
    WHERE n.nspname=$1 ORDER BY c.relname,a.attname,x.privilege_type,r.rolname`, [schema]);
  const expectedColumns = Object.entries(grants).flatMap(([relation, operations]) =>
    Object.entries(operations).flatMap(([privilege_type, names]) => names.map((name) => ({
      relation, name, grantee: role.runtime, privilege_type, is_grantable: false,
    })))).sort((a,b) => a.relation.localeCompare(b.relation) || a.name.localeCompare(b.name) || a.privilege_type.localeCompare(b.privilege_type));
  same(columns.rows, expectedColumns, 'column_acls');
  for (const privilege of ['INSERT','UPDATE']) {
    const effectiveColumns = await client.query(`SELECT c.relname AS relation,a.attname AS name,
      pg_catalog.has_column_privilege(current_user,c.oid,a.attname,$2) AS allowed,
      pg_catalog.has_column_privilege(current_user,c.oid,a.attname,$3) AS grantable
      FROM pg_catalog.pg_class c JOIN pg_catalog.pg_namespace n ON n.oid=c.relnamespace
      JOIN pg_catalog.pg_attribute a ON a.attrelid=c.oid AND a.attnum>0 AND NOT a.attisdropped
      WHERE n.nspname=$1 ORDER BY c.relname,a.attnum`, [schema,privilege,privilege+' WITH GRANT OPTION']);
    expect(effectiveColumns.rows.every((r) => r.allowed === (grants[r.relation]?.[privilege] ?? []).includes(r.name) && !r.grantable), 'effective_columns');
  }
  for (const [scope, sql, params] of [
    ['function_acls', `SELECT 1 FROM pg_catalog.pg_proc p JOIN pg_catalog.pg_namespace n ON n.oid=p.pronamespace
      CROSS JOIN LATERAL pg_catalog.aclexplode(COALESCE(p.proacl,pg_catalog.acldefault('f',p.proowner))) x
      WHERE n.nspname=$1 AND x.grantee<>p.proowner`, [schema]],
    // Generated row/array types retain PG16's inert PUBLIC USAGE baseline.
    // That does not grant schema or table access. Extra/grantable ACLs fail.
    ['type_acls', `SELECT 1 FROM pg_catalog.pg_type t JOIN pg_catalog.pg_namespace n ON n.oid=t.typnamespace
      CROSS JOIN LATERAL pg_catalog.aclexplode(COALESCE(t.typacl,pg_catalog.acldefault('T',t.typowner))) x
      WHERE n.nspname=$1 AND x.grantee<>t.typowner AND NOT (x.grantee=0 AND x.privilege_type='USAGE' AND NOT x.is_grantable)`, [schema]],
    ['type_defaults', `SELECT 1 FROM pg_catalog.pg_roles o LEFT JOIN pg_catalog.pg_default_acl d
      ON d.defaclrole=o.oid AND d.defaclobjtype='T' AND (d.defaclnamespace=0 OR
        d.defaclnamespace=(SELECT oid FROM pg_catalog.pg_namespace WHERE nspname=$1))
      CROSS JOIN LATERAL pg_catalog.aclexplode(COALESCE(d.defaclacl,pg_catalog.acldefault('T',o.oid))) x
      WHERE o.rolname=$2 AND x.grantee<>o.oid AND NOT (x.grantee=0 AND x.privilege_type='USAGE' AND NOT x.is_grantable)`, [schema, owner]],
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
    ['global_acls', `SELECT 1 FROM pg_catalog.pg_roles o CROSS JOIN (VALUES ('r'),('S'),('f')) k(kind)
      LEFT JOIN pg_catalog.pg_default_acl d ON d.defaclrole=o.oid AND d.defaclnamespace=0 AND d.defaclobjtype=k.kind::"char"
      CROSS JOIN LATERAL pg_catalog.aclexplode(COALESCE(d.defaclacl,pg_catalog.acldefault(k.kind::"char",o.oid))) x
      WHERE o.rolname=$1 AND x.grantee<>o.oid`, [owner]],
  ]) expect((await client.query(sql, params)).rowCount === 0, scope);
  const effective = await client.query(`SELECT
    pg_catalog.has_schema_privilege(current_user,$1,'USAGE') AS usage,
    pg_catalog.has_schema_privilege(current_user,$1,'CREATE') AS schema_create,
    pg_catalog.has_schema_privilege(current_user,$1,'USAGE WITH GRANT OPTION') AS usage_grant,
    pg_catalog.has_database_privilege(current_user,pg_catalog.current_database(),'CONNECT') AS connect,
    pg_catalog.has_database_privilege(current_user,pg_catalog.current_database(),'CREATE') AS db_create,
    pg_catalog.has_database_privilege(current_user,pg_catalog.current_database(),'TEMPORARY') AS temporary,
    pg_catalog.has_database_privilege(current_user,pg_catalog.current_database(),'CONNECT WITH GRANT OPTION') AS connect_grant,
    (SELECT d.datdba=(SELECT oid FROM pg_catalog.pg_roles WHERE rolname=current_user)
      FROM pg_catalog.pg_database d WHERE d.datname=pg_catalog.current_database()) AS database_owner`, [schema]);
  const e = effective.rows[0];
  expect(effective.rowCount === 1 && e.usage && e.connect && !e.schema_create && !e.usage_grant
    && !e.db_create && !e.temporary && !e.connect_grant && !e.database_owner, 'effective_privileges');
}

export async function verifyPostgresManagedTelemetryAttestation(client, options = {}) {
  try {
    assertPlainRecord(options, 'managed telemetry attestation options');
    assertAllowedKeys(options, ['schemaName', 'expectedOwner','lifecycle','metrics','metricVersion'], 'managed telemetry attestation options');
    const lifecycle = options.lifecycle ?? false, metrics = options.metrics ?? false;
    expect(typeof lifecycle === 'boolean' && typeof metrics === 'boolean' && (!metrics || lifecycle),'version');
    const metricVersion = metrics ? (options.metricVersion ?? 3) : undefined;
    expect((metrics && [3,4,5,6,7].includes(metricVersion)) || (!metrics && options.metricVersion === undefined),'version');
    expect(client && typeof client.query === 'function', 'client');
    const schema = identifier(options.schemaName ?? 'risk_fork_telemetry');
    const owner = options.expectedOwner === undefined ? undefined : identifier(options.expectedOwner);
    await verifyCatalog(client, schema, lifecycle, metrics, metricVersion);
    if (owner !== undefined) await verifyPrivileges(client, schema, owner, lifecycle, metrics);
    return Object.freeze({ schema_name: schema, catalog_verified: true,
      runtime_privileges_verified: owner !== undefined, production_qualified: false });
  } catch (error) {
    if (error?.code === 'TELEMETRY_POSTGRES_ATTESTATION_FAILED') throw error;
    throw failed('query');
  }
}
