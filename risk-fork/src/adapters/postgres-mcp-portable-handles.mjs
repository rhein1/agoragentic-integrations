import { readFile } from 'node:fs/promises';
import { canonicalize, sha256Ref } from '../canonical.mjs';
import {
  RiskForkMcpPortableHandleError,
  RISK_FORK_MCP_PORTABLE_HANDLE_DIAGNOSTIC_CODES as CODES,
} from '../mcp-portable-handle-boundary.mjs';
import {
  assertAllowedKeys, boundedInteger, deepFreeze, requireOpaqueRef, requireSha256Ref,
} from '../util.mjs';
import {
  acquirePostgresAuthorityClient, createPostgresAuthorityPool,
  quotePostgresAuthorityIdentifier,
} from './postgres-authority-migrator.mjs';

const MIGRATION_URL = new URL('../../migrations/mcp-portable-handles/001_registry.pg.sql', import.meta.url);
const stores = new WeakSet();
const failure = (code, message) => new RiskForkMcpPortableHandleError(code, message);

function scopeValues(scope) {
  assertAllowedKeys(scope, ['tenant_ref', 'key_id', 'key_fingerprint'], 'handle storage namespace');
  return [requireOpaqueRef(scope.tenant_ref, 'tenant_ref'),
    requireOpaqueRef(scope.key_id, 'key_id'), requireSha256Ref(scope.key_fingerprint, 'key_fingerprint')];
}

async function migrationSource() {
  const sql = (await readFile(MIGRATION_URL, 'utf8')).replace(/\r\n?/g, '\n');
  return { sql, hash: sha256Ref(sql) };
}

async function connection(options) {
  assertAllowedKeys(options, [
    'pool', 'connectionString', 'schemaName', 'requireTls', 'tls',
    'maxConnections', 'connectionTimeoutMs', 'statementTimeoutMs',
  ], 'PostgreSQL portable-handle options');
  const schemaName = options.schemaName ?? 'risk_fork_mcp_handles';
  const schema = quotePostgresAuthorityIdentifier(schemaName);
  const requireTls = options.requireTls ?? true;
  if (typeof requireTls !== 'boolean') throw new TypeError('requireTls must be boolean');
  if (options.pool && options.connectionString) throw new TypeError('Provide pool or connectionString');
  if (options.pool && requireTls) {
    throw failure(CODES.INVALID_CONFIGURATION, 'CA-validated storage must construct its own pool');
  }
  const timeout = boundedInteger(options.statementTimeoutMs ?? 10_000, 'statementTimeoutMs',
    { min: 100, max: 300_000 });
  const pool = options.pool ?? await createPostgresAuthorityPool({
    connectionString: options.connectionString, requireTls, tls: options.tls,
    maxConnections: options.maxConnections ?? 8,
    connectionTimeoutMs: options.connectionTimeoutMs, statementTimeoutMs: timeout,
    applicationName: 'risk-fork-mcp-portable-handles',
  });
  if (typeof pool.connect !== 'function') throw new TypeError('PostgreSQL pool must provide connect');
  return { schemaName, schema, requireTls, timeout, pool, ownsPool: !options.pool,
    verifiedClients: new WeakSet() };
}

async function transaction(config, operation) {
  const client = await acquirePostgresAuthorityClient(config.pool, {
    requireTls: config.requireTls, verifiedClients: config.verifiedClients,
  });
  try {
    await client.query('BEGIN');
    try {
      await client.query('SET LOCAL synchronous_commit = on');
      await client.query(`SET LOCAL statement_timeout = ${config.timeout}`);
      await client.query(`SET LOCAL lock_timeout = ${config.timeout}`);
      await client.query(`SET LOCAL idle_in_transaction_session_timeout = ${config.timeout}`);
      const result = await operation(client);
      await client.query('COMMIT');
      return result;
    } catch (error) {
      await client.query('ROLLBACK').catch(() => {});
      // A lost COMMIT acknowledgement is terminal. No implicit retry can turn
      // an uncertain consumption into another authorization/effect.
      throw error;
    }
  } finally { client.release(); }
}

async function verifySchema(client, config, expectedHash) {
  const migrations = await client.query(
    `SELECT version, migration_hash FROM ${config.schema}.handle_schema_migrations ORDER BY version`);
  if (migrations.rowCount !== 1 || migrations.rows[0].version !== 1
    || migrations.rows[0].migration_hash !== expectedHash) {
    throw failure(CODES.INVALID_CONFIGURATION, 'Portable-handle migration differs from reviewed source');
  }
  const tables = await client.query(
    `SELECT count(*)::integer AS count FROM information_schema.tables
     WHERE table_schema = $1 AND table_name = ANY($2::text[])`,
    [config.schemaName, ['handle_schema_migrations', 'handle_namespaces', 'portable_handles', 'handle_consumptions']]);
  if (tables.rows[0]?.count !== 4) {
    throw failure(CODES.INVALID_CONFIGURATION, 'Portable-handle schema is incomplete');
  }
  const triggers = await client.query(`SELECT t.tgname, t.tgenabled FROM pg_trigger t
    JOIN pg_class c ON c.oid=t.tgrelid JOIN pg_namespace n ON n.oid=c.relnamespace
    WHERE n.nspname=$1 AND NOT t.tgisinternal ORDER BY t.tgname`, [config.schemaName]);
  const required = ['handle_consumptions_immutable', 'handle_consumptions_no_truncate',
    'handle_migrations_immutable', 'handle_migrations_no_truncate', 'handle_namespaces_immutable',
    'handle_namespaces_no_truncate', 'portable_handle_binding_immutable', 'portable_handles_no_truncate'];
  if (canonicalize(triggers.rows.map((row) => row.tgname)) !== canonicalize(required)
    || triggers.rows.some((row) => row.tgenabled !== 'O')) {
    throw failure(CODES.INVALID_CONFIGURATION, 'Portable-handle integrity triggers are unavailable');
  }
}

// Explicit migration-owner operation. Runtime initialization never runs DDL.
export async function migrateMcpPortableHandlesPostgres(options = {}) {
  const config = await connection(options);
  const source = await migrationSource();
  try {
    return await transaction(config, async (client) => {
      await client.query('SELECT pg_advisory_xact_lock(1380338246, 375)');
      const exists = await client.query('SELECT to_regclass($1) AS relation',
        [`${config.schemaName}.handle_schema_migrations`]);
      if (exists.rows[0]?.relation === null) {
        await client.query(`CREATE SCHEMA IF NOT EXISTS ${config.schema}`);
        await client.query(source.sql.replaceAll('__MCP_HANDLE_SCHEMA__', config.schema));
        await client.query(`INSERT INTO ${config.schema}.handle_schema_migrations VALUES (1, $1)`, [source.hash]);
      }
      await verifySchema(client, config, source.hash);
      return deepFreeze({ schema_name: config.schemaName, migration_hash: source.hash,
        migration_version: 1, production_qualified: false });
    });
  } finally { if (config.ownsPool) await config.pool.end(); }
}

export async function createPostgresMcpPortableHandleStore(options = {}) {
  const config = await connection(options);
  let closed = false;
  try {
    const source = await migrationSource();
    await transaction(config, (client) => verifySchema(client, config, source.hash));
  } catch (error) {
    if (config.ownsPool) await config.pool.end().catch(() => {});
    throw error;
  }
  const assertOpen = () => {
    if (closed) throw failure(CODES.CLOSED, 'Portable-handle storage is closed');
  };
  async function lockNamespace(client, scope, maxEntries = null) {
    const values = scopeValues(scope);
    if (maxEntries !== null) {
      await client.query(`INSERT INTO ${config.schema}.handle_namespaces
        (tenant_ref, key_id, key_fingerprint, max_entries) VALUES ($1,$2,$3,$4) ON CONFLICT DO NOTHING`, [...values, maxEntries]);
    }
    const result = await client.query(`SELECT key_fingerprint, max_entries FROM ${config.schema}.handle_namespaces
      WHERE tenant_ref=$1 AND key_id=$2 FOR ${maxEntries !== null ? 'UPDATE' : 'SHARE'}`, values.slice(0, 2));
    if (result.rowCount !== 1 || result.rows[0].key_fingerprint !== values[2]
      || (maxEntries !== null && result.rows[0].max_entries !== maxEntries)) {
      throw failure(CODES.INVALID_CONFIGURATION, 'Portable-handle namespace key is unavailable or differs');
    }
    return values.slice(0, 2);
  }
  async function dbNow(client) {
    const result = await client.query('SELECT clock_timestamp() AS now');
    return result.rows[0].now.toISOString();
  }
  async function register(scope, input, buildBinding) {
    assertOpen();
    assertAllowedKeys(input, ['handle_hash', 'max_entries', 'ttl_ms'], 'stored registration');
    const handleHash = requireSha256Ref(input.handle_hash, 'handle_hash');
    const maxEntries = boundedInteger(input.max_entries, 'max_entries', { min: 1, max: 100_000 });
    const ttlMs = boundedInteger(input.ttl_ms, 'ttl_ms', { min: 1_000, max: 300_000 });
    if (typeof buildBinding !== 'function') throw new TypeError('Binding constructor is required');
    return transaction(config, async (client) => {
      const namespace = await lockNamespace(client, scope, maxEntries);
      const prior = await client.query(`SELECT 1 FROM ${config.schema}.portable_handles
        WHERE tenant_ref=$1 AND key_id=$2 AND handle_hash=$3`, [...namespace, handleHash]);
      if (prior.rowCount) throw failure(CODES.ALREADY_REGISTERED, 'Portable handle already has a durable binding');
      const count = await client.query(`SELECT count(*)::integer AS count FROM ${config.schema}.portable_handles
        WHERE tenant_ref=$1 AND key_id=$2`, namespace);
      if (count.rows[0].count >= maxEntries) throw failure(CODES.CAPACITY_EXCEEDED, 'Portable-handle capacity exhausted');
      const now = await dbNow(client);
      const binding = JSON.parse(canonicalize(buildBinding(now)));
      if (binding.handle_hash !== handleHash || binding.issued_at !== now
        || Date.parse(binding.expires_at) - Date.parse(now) !== ttlMs) {
        throw failure(CODES.BINDING_MISMATCH, 'Binding constructor changed storage timing or identity');
      }
      await client.query(`INSERT INTO ${config.schema}.portable_handles
        (tenant_ref,key_id,handle_hash,binding,expires_at,max_consumptions)
        VALUES ($1,$2,$3,$4::jsonb,$5,$6)`,
      [...namespace, handleHash, JSON.stringify(binding), binding.expires_at, binding.max_consumptions]);
      return deepFreeze(binding);
    });
  }
  async function consume(scope, input, authorizeBinding) {
    assertOpen();
    assertAllowedKeys(input, ['handle_hash', 'consuming_request_hash'], 'stored consumption');
    const handleHash = requireSha256Ref(input.handle_hash, 'handle_hash');
    const requestHash = requireSha256Ref(input.consuming_request_hash, 'consuming_request_hash');
    if (typeof authorizeBinding !== 'function') throw new TypeError('Binding validator is required');
    return transaction(config, async (client) => {
      const namespace = await lockNamespace(client, scope);
      const identity = [...namespace, handleHash];
      const result = await client.query(`SELECT binding, expires_at, revoked_at, consumption_count, max_consumptions
        FROM ${config.schema}.portable_handles
        WHERE tenant_ref=$1 AND key_id=$2 AND handle_hash=$3 FOR UPDATE`, identity);
      if (!result.rowCount) throw failure(CODES.UNKNOWN_HANDLE, 'Portable handle is not registered');
      const row = result.rows[0];
      const now = await dbNow(client); // after both lock waits
      if (row.revoked_at !== null) throw failure(CODES.REVOKED, 'Portable handle is revoked');
      if (Date.parse(now) >= row.expires_at.getTime()) throw failure(CODES.EXPIRED, 'Portable handle is expired');
      const authorization = JSON.parse(canonicalize(authorizeBinding(row.binding, now)));
      const prior = await client.query(`SELECT 1 FROM ${config.schema}.handle_consumptions
        WHERE tenant_ref=$1 AND key_id=$2 AND handle_hash=$3 AND request_hash=$4`, [...identity, requestHash]);
      if (prior.rowCount) throw failure(CODES.REPLAY, 'Portable-handle request already consumed');
      if (row.consumption_count >= row.max_consumptions) {
        throw failure(row.max_consumptions === 1 ? CODES.REPLAY : CODES.USE_LIMIT, 'Portable-handle uses exhausted');
      }
      if (authorization.handle_hash !== handleHash || authorization.consuming_request_hash !== requestHash
        || authorization.authorized_at !== now) throw failure(CODES.BINDING_MISMATCH, 'Invalid consumption receipt');
      const updated = await client.query(`UPDATE ${config.schema}.portable_handles
        SET consumption_count=consumption_count+1
        WHERE tenant_ref=$1 AND key_id=$2 AND handle_hash=$3 AND revoked_at IS NULL
          AND expires_at > clock_timestamp() AND consumption_count < max_consumptions`, identity);
      if (updated.rowCount !== 1) throw failure(CODES.EXPIRED, 'Portable-handle validity ended before consumption');
      await client.query(`INSERT INTO ${config.schema}.handle_consumptions
        (tenant_ref,key_id,handle_hash,request_hash,authorization_receipt,consumed_at)
        VALUES ($1,$2,$3,$4,$5::jsonb,$6)`,
      [...identity, requestHash, JSON.stringify(authorization), now]);
      return deepFreeze(authorization);
    });
  }
  async function revoke(scope, input) {
    assertOpen();
    assertAllowedKeys(input, ['handle_hash'], 'stored revocation');
    const handleHash = requireSha256Ref(input.handle_hash, 'handle_hash');
    return transaction(config, async (client) => {
      const namespace = await lockNamespace(client, scope);
      const result = await client.query(`UPDATE ${config.schema}.portable_handles
        SET revoked_at=COALESCE(revoked_at,clock_timestamp())
        WHERE tenant_ref=$1 AND key_id=$2 AND handle_hash=$3`, [...namespace, handleHash]);
      if (result.rowCount !== 1) throw failure(CODES.UNKNOWN_HANDLE, 'Portable handle is not registered');
    });
  }
  async function close() { closed = true; if (config.ownsPool) await config.pool.end(); }
  const store = Object.freeze({ register, consume, revoke, close, production_qualified: false });
  stores.add(store);
  return store;
}

export function isPostgresMcpPortableHandleStore(value) { return stores.has(value); }
