import { readFile } from 'node:fs/promises';

import { sha256Ref } from '../../../src/canonical.mjs';

const TABLES = [
  'managed_worker_delivery_attempts',
  'managed_worker_delivery_namespaces',
  'managed_worker_delivery_schema_migrations',
];
const FUNCTIONS = [
  'protect_managed_worker_delivery_namespace',
  'protect_managed_worker_delivery_record',
  'reject_managed_worker_delivery_delete',
  'reject_managed_worker_delivery_truncate',
];
const TRIGGERS = [
  'managed_worker_delivery_namespace_no_delete',
  'managed_worker_delivery_namespace_no_truncate',
  'managed_worker_delivery_no_delete',
  'managed_worker_delivery_no_truncate',
  'managed_worker_delivery_protect_namespace',
  'managed_worker_delivery_protect_record',
];
const COLUMNS = {
  managed_worker_delivery_schema_migrations: [
    ['version', 'integer', true, ''], ['migration_hash', 'text', true, ''],
    ['applied_at', 'timestamp with time zone', true, 'clock_timestamp()'],
  ],
  managed_worker_delivery_namespaces: [
    ['namespace', 'text', true, ''], ['max_attempts', 'integer', true, ''],
    ['created_at', 'timestamp with time zone', true, 'clock_timestamp()'],
  ],
  managed_worker_delivery_attempts: [
    ['namespace', 'text', true, ''], ['attempt_ref', 'text', true, ''],
    ['key_id', 'text', true, ''], ['iv', 'text', true, ''],
    ['ciphertext', 'text', true, ''], ['tag', 'text', true, ''],
    ['acknowledged', 'boolean', true, 'false'], ['response_hash', 'text', false, ''],
    ['created_at', 'timestamp with time zone', true, 'clock_timestamp()'],
    ['acknowledged_at', 'timestamp with time zone', false, ''],
  ],
};
const MIGRATION_SOURCE = readFile(new URL('../../migrations/002_worker_delivery.pg.sql', import.meta.url), 'utf8')
  .then((source) => source.replace(/\r\n?/g, '\n'));

function hasMutation(state, prefix) {
  return [...state.mutations].some((scope) => scope.startsWith(prefix));
}

function bodyFor(source, name) {
  return source.split(`CREATE FUNCTION __RISK_FORK_MANAGED_SCHEMA__.${name}()`)[1]?.split('AS $$')[1]?.split('$$;')[0];
}

export async function createWorkerDeliveryCatalogFixture({
  schemaName = 'risk_fork_worker_delivery',
  runtimeRole = 'worker_runtime',
  migrationOwner = 'worker_migrator',
  postgresMajor = 16,
} = {}) {
  const source = await MIGRATION_SOURCE;
  const migrationHash = sha256Ref(source);
  const state = { mutations: new Set(), rows: new Map() };
  const columns = TABLES.flatMap((relation) => COLUMNS[relation].map(
    ([name, type_name, not_null, default_expr], index) => ({ relation, name, attnum: index + 1, type_name, not_null, default_expr }),
  ));
  const relationRows = TABLES.map((name) => ({ name, kind: 'r', persistence: 'p', row_security: false, force_row_security: false, reloptions: null, relispartition: false, relpartbound: null }));
  const triggerRows = TRIGGERS.map((name) => ({ name, enabled: 'O', definition: triggerDefinition(schemaName, name) }));
  const pool = {
    async connect() {
      const client = {
        async query(sql, params = []) {
          if (/^(BEGIN|COMMIT|ROLLBACK|SET LOCAL|SELECT pg_advisory)/.test(sql)) return { rowCount: 0, rows: [] };
          if (sql.includes("current_setting('server_version_num')")) return { rowCount: 1, rows: [{ version: `${postgresMajor}0000` }] };
          if (sql.includes('pg_stat_ssl')) return { rowCount: 1, rows: [{ ssl: true, version: 'TLS', cipher: 'fixture' }] };
          if (sql.includes('FROM pg_catalog.pg_class c JOIN pg_catalog.pg_namespace') && sql.includes('relkind NOT IN')) {
            if (state.mutations.has('relations')) return { rowCount: 1, rows: [{ ...relationRows[0], kind: 'v' }] };
            return { rowCount: relationRows.length, rows: relationRows };
          }
          if (sql.includes('pg_catalog.pg_attribute') && sql.includes('pg_attrdef')) return { rowCount: columns.length, rows: columns };
          if (sql.includes('pg_catalog.pg_constraint')) return { rowCount: 16, rows: constraints(schemaName) };
          if (sql.includes('SELECT object_kind')) return state.mutations.has('ownership')
            ? { rowCount: 1, rows: [{ object_kind: 'schema', object_name: schemaName, owner: runtimeRole }] }
            : { rowCount: 0, rows: [] };
          if (sql.includes('pg_catalog.pg_index') && sql.includes('pg_get_indexdef')) return { rowCount: 3, rows: indexes(schemaName) };
          if (sql.includes('pg_catalog.pg_index')) return { rowCount: 3, rows: indexes(schemaName) };
          if (sql.includes('pg_catalog.pg_trigger')) return { rowCount: triggerRows.length, rows: triggerRows };
          if (sql.includes('pg_catalog.pg_proc p') && sql.includes('p.prosrc')) {
            return { rowCount: FUNCTIONS.length, rows: FUNCTIONS.map((name) => ({
              name, args: '', returns: 'trigger', body: bodyFor(source, name), prosecdef: false,
              proconfig: null, provolatile: 'v', proparallel: 'u', proleakproof: false,
              proisstrict: false, prokind: 'f', language: 'plpgsql',
            })) };
          }
          // These marker queries model the attestor's exact ACL boundary probes.
          // A clean fixture has no rows; each scoped mutation represents one
          // PUBLIC or outsider grant that must make strict attestation fail.
          if (sql.includes('/* delivery_object_acl_boundary */')) {
            return hasMutation(state, 'object_acl_')
              ? { rowCount: 1, rows: [{ relation: 'managed_worker_delivery_attempts', grantee: 'PUBLIC', privilege_type: 'SELECT', is_grantable: false }] }
              : { rowCount: 0, rows: [] };
          }
          if (sql.includes('/* delivery_default_acl_boundary */')) {
            return (hasMutation(state, 'default_acl_') || state.mutations.has('default_function'))
              ? { rowCount: 1, rows: [{ object_type: 'r', grantee: 'PUBLIC', privilege_type: 'SELECT', is_grantable: false }] }
              : { rowCount: 0, rows: [] };
          }
          if (sql.includes('/* delivery_global_acl_boundary */')) {
            return (hasMutation(state, 'global_acl_') || state.mutations.has('default_function'))
              ? { rowCount: 1, rows: [{ object_type: 'f', grantee: 'PUBLIC', privilege_type: 'EXECUTE', is_grantable: false }] }
              : { rowCount: 0, rows: [] };
          }
          if (sql.includes('pg_inherits') || sql.includes('pg_policy') || sql.includes('pg_rewrite') || sql.includes('attgenerated') || sql.includes('attidentity') || sql.includes('attcollation')) return { rowCount: 0, rows: [] };
          if (sql.includes('managed_worker_delivery_schema_migrations') && sql.includes('applied_at')) return { rowCount: 1, rows: [{ version: 1, migration_hash: migrationHash, applied_at: new Date(0) }] };
          if (sql.includes('FROM pg_catalog.pg_roles r')) return { rowCount: 1, rows: [{ current_role: runtimeRole, session_role: runtimeRole, can_login: true, inherit: false, superuser: false, createdb: false, createrole: false, replication: false, bypassrls: false, fsync: 'on', synchronous_commit: 'on', replication_role: 'origin' }] };
          if (sql.includes('pg_auth_members')) return state.mutations.has('membership') ? { rowCount: 1, rows: [{ '?column?': 1 }] } : { rowCount: 0, rows: [] };
          if (sql.includes('has_database_privilege')) return { rowCount: 1, rows: [{ connect: true, create_db: false, temporary: false, connect_grant: false }] };
          if (sql.includes('has_schema_privilege')) return { rowCount: 1, rows: [{ usage: true, create_schema: false, usage_grant: false }] };
          if (sql.includes('has_table_privilege')) {
            const privilege = params[1];
            const allowed = state.mutations.has('table_grant')
              || privilege === 'SELECT' || (privilege === 'INSERT' && !String(params[0]).includes('schema_migrations'));
            const grantable = state.mutations.has('select_grant') && privilege === 'SELECT';
            return { rowCount: 1, rows: [{ allowed, grantable }] };
          }
          if (sql.includes('has_column_privilege')) {
            const table = TABLES.find((name) => String(params[0]).endsWith(`."${name}"`));
            return { rowCount: COLUMNS[table].length, rows: COLUMNS[table].map(([name]) => ({ name, update_allowed: (state.mutations.has('column_grant') && name === 'key_id') || (table === 'managed_worker_delivery_attempts' && ['acknowledged', 'response_hash', 'acknowledged_at'].includes(name)), update_grant: false })) };
          }
          if (sql.includes('a.attacl IS NOT NULL')) return state.mutations.has('public_column_grant') ? { rowCount: 1, rows: [{ relation: 'managed_worker_delivery_attempts', column_name: 'key_id', grantee: 'PUBLIC', current_role: runtimeRole, privilege_type: 'INSERT', is_grantable: false }] } : { rowCount: 0, rows: [] };
          if (sql.includes('owner<>$4')) return state.mutations.has('ownership') ? { rowCount: 1, rows: [{ object_kind: 'schema', object_name: schemaName, owner: runtimeRole }] } : { rowCount: 0, rows: [] };
          if (sql.includes('has_function_privilege')) return { rowCount: FUNCTIONS.length, rows: FUNCTIONS.map((name) => ({ proname: name, allowed: state.mutations.has('function_execute'), grantable: false })) };
          if (sql.includes('pg_default_acl')) return state.mutations.has('default_function') ? { rowCount: 1, rows: [{ defaclobjtype: 'f', privilege_type: 'EXECUTE', is_grantable: false, grantee: 0, grantee_name: 'PUBLIC' }] } : { rowCount: 0, rows: [] };
          if (sql.includes('pg_roles o')) return state.mutations.has('default_function') ? { rowCount: 1, rows: [{ kind: 'f', privilege_type: 'EXECUTE' }] } : { rowCount: 0, rows: [] };
          if (sql.includes('aclexplode')) return state.mutations.has('grantable') ? { rowCount: 1, rows: [{ '?column?': 1 }] } : { rowCount: 0, rows: [] };
          if (sql.includes('SELECT count(*)::integer')) return { rowCount: 1, rows: [{ count: state.rows.size }] };
          if (sql.includes('INSERT INTO') && sql.includes('managed_worker_delivery_namespaces')) return { rowCount: 1, rows: [{ max_attempts: params[1] }] };
          if (sql.includes('INSERT INTO')) {
            const key = `${params[0]}:${params[1]}`;
            if (state.rows.has(key)) return { rowCount: 0, rows: [] };
            state.rows.set(key, { namespace: params[0], attempt_ref: params[1], key_id: params[2], iv: params[3], ciphertext: params[4], tag: params[5], acknowledged: false, response_hash: null });
            return { rowCount: 1, rows: [] };
          }
          if (sql.includes('SELECT 1 FROM')) return state.rows.has(`${params[0]}:${params[1]}`) ? { rowCount: 1, rows: [{ '?column?': 1 }] } : { rowCount: 0, rows: [] };
          if (sql.includes('SET acknowledged')) {
            const row = state.rows.get(`${params[0]}:${params[1]}`);
            if (row?.acknowledged === false) { row.acknowledged = true; row.response_hash = params[2]; return { rowCount: 1, rows: [{ attempt_ref: params[1] }] }; }
            return { rowCount: 0, rows: [] };
          }
          if (sql.includes('SELECT acknowledged, response_hash')) { const row = state.rows.get(`${params[0]}:${params[1]}`); return row ? { rowCount: 1, rows: [row] } : { rowCount: 0, rows: [] }; }
          if (sql.includes('SELECT namespace, attempt_ref')) { const row = state.rows.get(`${params[0]}:${params[1]}`); return row ? { rowCount: 1, rows: [row] } : { rowCount: 0, rows: [] }; }
          if (sql.includes('SELECT attempt_ref')) return { rowCount: 0, rows: [] };
          throw new Error(`unexpected fixture SQL: ${sql}`);
        },
        release() {},
      };
      return client;
    },
    async end() {},
  };
  return Object.freeze({ pool, state, mutate(scope) { state.mutations.add(scope); }, clear(scope) { state.mutations.delete(scope); } });
}

function constraints(schema) {
  const rows = [
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
  return rows.map(([relation, conname, contype, definition]) => ({ relation, conname, contype, convalidated: true, condeferrable: false, condeferred: false, definition: definition.replaceAll('__schema__', schema) }));
}
function indexes(schema) {
  return [
    ['managed_worker_delivery_attempts', '(namespace, attempt_ref)'],
    ['managed_worker_delivery_namespaces', '(namespace)'],
    ['managed_worker_delivery_schema_migrations', '(version)'],
  ].map(([name, key]) => ({ name: `${name}_pkey`, unique_index: true, primary_index: true, valid_index: true, ready_index: true, definition: `CREATE UNIQUE INDEX ${name}_pkey ON ${schema}.${name} USING btree ${key}` }));
}
function triggerDefinition(schema, name) {
  const table = name.includes('namespace') ? 'managed_worker_delivery_namespaces' : 'managed_worker_delivery_attempts';
  const event = name.includes('truncate') ? 'TRUNCATE' : name.includes('delete') ? 'DELETE' : 'UPDATE';
  const fn = name.includes('protect_namespace') ? 'protect_managed_worker_delivery_namespace'
    : name.includes('protect_record') ? 'protect_managed_worker_delivery_record'
      : name.includes('truncate') ? 'reject_managed_worker_delivery_truncate' : 'reject_managed_worker_delivery_delete';
  const each = event === 'TRUNCATE' ? 'FOR EACH STATEMENT' : 'FOR EACH ROW';
  return `CREATE TRIGGER ${name} BEFORE ${event} ON ${schema}.${table} ${each} EXECUTE FUNCTION ${schema}.${fn}()`;
}
