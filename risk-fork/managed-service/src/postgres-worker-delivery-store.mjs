import { readFile } from 'node:fs/promises';

import {
  acquirePostgresAuthorityClient,
  createPostgresAuthorityPool,
  quotePostgresAuthorityIdentifier,
} from '../../src/adapters/postgres-authority-migrator.mjs';
import { sha256Ref } from '../../src/canonical.mjs';
import {
  assertAllowedKeys,
  assertPlainRecord,
  cloneJson,
  deepFreeze,
  managedError,
  requireInteger,
  requireOpaqueRef,
  requireSha256,
} from './validation.mjs';

const SCHEMA = 'agoragentic.risk-fork.worker-delivery.v1';
const trustedPools = new WeakSet();
const MAX_RECORD_BYTES = 65_536;
const EXPECTED_COLUMNS = Object.freeze({
  managed_worker_delivery_schema_migrations: [
    ['version', 'integer', true], ['migration_hash', 'text', true], ['applied_at', 'timestamp with time zone', true],
  ],
  managed_worker_delivery_namespaces: [
    ['namespace', 'text', true], ['max_attempts', 'integer', true], ['created_at', 'timestamp with time zone', true],
  ],
  managed_worker_delivery_attempts: [
    ['namespace', 'text', true], ['attempt_ref', 'text', true], ['key_id', 'text', true],
    ['iv', 'text', true], ['ciphertext', 'text', true], ['tag', 'text', true],
    ['acknowledged', 'boolean', true], ['response_hash', 'text', false],
    ['created_at', 'timestamp with time zone', true], ['acknowledged_at', 'timestamp with time zone', false],
  ],
});
let migrationHashPromise;

function migrationHash() {
  migrationHashPromise ??= readFile(
    new URL('../migrations/002_worker_delivery.pg.sql', import.meta.url),
    'utf8',
  ).then((source) => sha256Ref(source.replace(/\r\n?/g, '\n')));
  return migrationHashPromise;
}

function invalid(message = 'Worker delivery store is unavailable') {
  throw managedError(message, 'WORKER_DELIVERY_STORE_INVALID', 503);
}

function normalizeRecord(value, namespace, attemptRef) {
  const record = cloneJson(value, 'worker delivery record');
  assertPlainRecord(record, 'worker delivery record');
  assertAllowedKeys(record, ['schema', 'namespace', 'attempt_ref', 'key_id', 'iv', 'ciphertext', 'tag'], 'worker delivery record');
  if (record.schema !== SCHEMA || record.namespace !== namespace || record.attempt_ref !== attemptRef) invalid();
  requireOpaqueRef(record.key_id, 'worker delivery key_id');
  const encoded = (value, label, max) => {
    if (typeof value !== 'string' || value.length === 0 || value.length > max || !/^[A-Za-z0-9_-]+$/.test(value)) invalid();
    const bytes = Buffer.from(value, 'base64url');
    if (bytes.toString('base64url') !== value) invalid();
    return value;
  };
  encoded(record.iv, 'iv', 16);
  encoded(record.ciphertext, 'ciphertext', Math.ceil(MAX_RECORD_BYTES * 4 / 3) + 8);
  encoded(record.tag, 'tag', 22);
  if (Buffer.from(record.iv, 'base64url').length !== 12
    || Buffer.from(record.tag, 'base64url').length !== 16
    || Buffer.from(record.ciphertext, 'base64url').length > MAX_RECORD_BYTES) invalid();
  if (Buffer.byteLength(JSON.stringify(record), 'utf8') > MAX_RECORD_BYTES * 2) invalid();
  return deepFreeze(record);
}

export class PostgresWorkerDeliveryStore {
  #pool;
  #schema;
  #schemaName;
  #verifiedClients = new WeakSet();
  #ownsPool;
  #requireTls;
  #statementTimeoutMs;
  #closed = false;

  constructor({ pool, schemaName = 'risk_fork_worker_delivery', ownsPool = false,
    requireTls = true, disposableDb = false, controlPlane, statementTimeoutMs = 30_000 } = {}) {
    if (!pool || typeof pool.connect !== 'function') throw new TypeError('Worker delivery store requires pool.connect()');
    if (controlPlane?.config?.environment !== 'local_test' || controlPlane.config.enabled !== true) {
      throw managedError('Worker delivery store is local_test only', 'WORKER_NOT_QUALIFIED', 503);
    }
    if (typeof requireTls !== 'boolean') throw new TypeError('requireTls must be boolean');
    if (!requireTls && disposableDb !== true) throw managedError('TLS bypass requires explicit disposableDb=true', 'WORKER_TLS_REQUIRED', 503);
    if (requireTls && !trustedPools.has(pool)) throw managedError('CA-pinned transport requires a factory-owned pool', 'WORKER_POSTGRES_TLS_POOL_UNTRUSTED', 503);
    this.#pool = pool;
    this.#schemaName = schemaName;
    this.#schema = quotePostgresAuthorityIdentifier(schemaName, 'managed PostgreSQL schema name');
    this.#ownsPool = ownsPool;
    this.#requireTls = requireTls;
    this.#statementTimeoutMs = requireInteger(statementTimeoutMs, 'statementTimeoutMs', { min: 100, max: 300_000 });
  }

  async #withClient(callback) {
    if (this.#closed) invalid('Worker delivery store is closed');
    const client = await acquirePostgresAuthorityClient(this.#pool, {
      requireTls: this.#requireTls,
      verifiedClients: this.#verifiedClients,
    });
    try { return await callback(client); } finally { client.release(); }
  }

  async #assertSchema(client) {
    const expected = await migrationHash();
    const migration = await client.query(
      `SELECT version, migration_hash FROM ${this.#schema}.managed_worker_delivery_schema_migrations ORDER BY version`,
    );
    const relations = await client.query(
      `SELECT c.relkind, c.relpersistence
         FROM pg_catalog.pg_class c
         JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
        WHERE n.nspname = $1 AND c.relname = ANY($2::text[]) ORDER BY c.relname`,
      [this.#schemaName, Object.keys(EXPECTED_COLUMNS)],
    );
    const columns = await client.query(
      `SELECT c.relname AS relation, a.attname AS name,
              pg_catalog.format_type(a.atttypid, a.atttypmod) AS type_name,
              a.attnotnull AS not_null
         FROM pg_catalog.pg_class c
         JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
         JOIN pg_catalog.pg_attribute a ON a.attrelid = c.oid AND a.attnum > 0 AND NOT a.attisdropped
        WHERE n.nspname = $1 AND c.relname = ANY($2::text[])
        ORDER BY c.relname, a.attnum`,
      [this.#schemaName, Object.keys(EXPECTED_COLUMNS)],
    );
    const triggers = await client.query(
      `SELECT t.tgname, t.tgenabled
         FROM pg_catalog.pg_trigger t
         JOIN pg_catalog.pg_class c ON c.oid = t.tgrelid
         JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
        WHERE n.nspname = $1 AND c.relname = ANY($2::text[])
          AND NOT t.tgisinternal ORDER BY t.tgname`,
      [this.#schemaName, ['managed_worker_delivery_attempts', 'managed_worker_delivery_namespaces']],
    );
    if (migration.rowCount !== 1 || migration.rows[0].version !== 1 || migration.rows[0].migration_hash !== expected
      || relations.rowCount !== Object.keys(EXPECTED_COLUMNS).length
      || relations.rows.some((row) => row.relkind !== 'r' || row.relpersistence !== 'p')
      || JSON.stringify(columns.rows.map((row) => [row.relation, row.name, row.type_name, row.not_null]))
        !== JSON.stringify(Object.entries(EXPECTED_COLUMNS).sort(([left], [right]) => left.localeCompare(right))
          .flatMap(([relation, entries]) => entries.map(([name, type, notNull]) => [relation, name, type, notNull])))
      || triggers.rowCount !== 6
      || triggers.rows.some((row) => row.tgenabled !== 'O')
      || JSON.stringify(triggers.rows.map((row) => row.tgname))
        !== JSON.stringify(['managed_worker_delivery_namespace_no_delete', 'managed_worker_delivery_namespace_no_truncate', 'managed_worker_delivery_no_delete', 'managed_worker_delivery_no_truncate', 'managed_worker_delivery_protect_namespace', 'managed_worker_delivery_protect_record'])) {
      invalid('Worker delivery migration, table, or immutable triggers are not verified');
    }
  }

  async #transaction(callback) {
    try {
      return await this.#withClient(async (client) => {
      await client.query('BEGIN ISOLATION LEVEL SERIALIZABLE');
      try {
        await client.query('SET LOCAL synchronous_commit = on');
        await client.query(`SET LOCAL statement_timeout = ${this.#statementTimeoutMs}`);
        await client.query(`SET LOCAL lock_timeout = ${this.#statementTimeoutMs}`);
        await client.query(`SET LOCAL idle_in_transaction_session_timeout = ${this.#statementTimeoutMs}`);
        await this.#assertSchema(client);
        const result = await callback(client);
        await client.query('COMMIT');
        return result;
      } catch (error) {
        await client.query('ROLLBACK').catch(() => {});
        throw error;
      }
      });
    } catch (error) {
      if (error?.code === '40001' || error?.code === '40P01') {
        throw managedError('Worker delivery transaction was not serialized; recovery is required', 'WORKER_TRANSACTION_CONFLICT', 503);
      }
      throw error;
    }
  }

  async insert(recordValue, maxAttemptsValue) {
    const maxAttempts = requireInteger(maxAttemptsValue, 'maxAttempts', { min: 1, max: 10_000 });
    assertPlainRecord(recordValue, 'worker delivery record');
    const namespace = requireOpaqueRef(recordValue.namespace, 'worker delivery namespace');
    const attemptRef = requireSha256(recordValue.attempt_ref, 'worker delivery attempt_ref');
    const record = normalizeRecord(recordValue, namespace, attemptRef);
    return this.#transaction(async (client) => {
      await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1, $2))', [namespace, 1380338246]);
      const namespacePolicy = await client.query(
        `INSERT INTO ${this.#schema}.managed_worker_delivery_namespaces (namespace, max_attempts)
         VALUES ($1, $2) ON CONFLICT (namespace) DO NOTHING RETURNING max_attempts`,
        [namespace, maxAttempts],
      );
      const policy = namespacePolicy.rowCount === 1
        ? maxAttempts
        : Number((await client.query(
          `SELECT max_attempts FROM ${this.#schema}.managed_worker_delivery_namespaces WHERE namespace = $1`,
          [namespace],
        )).rows[0]?.max_attempts);
      if (policy !== maxAttempts) {
        throw managedError('Worker delivery capacity policy cannot change', 'WORKER_CAPACITY_POLICY_MISMATCH', 409);
      }
      const existing = await client.query(
        `SELECT 1 FROM ${this.#schema}.managed_worker_delivery_attempts WHERE namespace = $1 AND attempt_ref = $2`,
        [namespace, attemptRef],
      );
      if (existing.rowCount !== 0) return false;
      const count = await client.query(
        `SELECT count(*)::integer AS count FROM ${this.#schema}.managed_worker_delivery_attempts WHERE namespace = $1`,
        [namespace],
      );
      if (Number(count.rows[0]?.count) >= maxAttempts) {
        throw managedError('Worker delivery capacity exhausted', 'WORKER_CAPACITY', 503);
      }
      const inserted = await client.query(
        `INSERT INTO ${this.#schema}.managed_worker_delivery_attempts
          (namespace, attempt_ref, key_id, iv, ciphertext, tag)
         VALUES ($1, $2, $3, $4, $5, $6)
         ON CONFLICT (namespace, attempt_ref) DO NOTHING`,
        [namespace, attemptRef, record.key_id, record.iv, record.ciphertext, record.tag],
      );
      return inserted.rowCount === 1;
    });
  }

  async get(namespaceValue, attemptRefValue) {
    const namespace = requireOpaqueRef(namespaceValue, 'worker delivery namespace');
    const attemptRef = requireSha256(attemptRefValue, 'worker delivery attempt_ref');
    return this.#transaction(async (client) => {
      const result = await client.query(
        `SELECT namespace, attempt_ref, key_id, iv, ciphertext, tag, acknowledged, response_hash
           FROM ${this.#schema}.managed_worker_delivery_attempts
          WHERE namespace = $1 AND attempt_ref = $2`,
        [namespace, attemptRef],
      );
      if (result.rowCount === 0) return null;
      if (result.rowCount !== 1) invalid('Worker delivery record lookup was ambiguous');
      const row = result.rows[0];
      const record = normalizeRecord({ schema: SCHEMA, namespace: row.namespace,
        attempt_ref: row.attempt_ref, key_id: row.key_id, iv: row.iv,
        ciphertext: row.ciphertext, tag: row.tag }, namespace, attemptRef);
      const acknowledged = row.acknowledged === true;
      const responseHash = row.response_hash == null ? null : requireSha256(row.response_hash, 'response_hash');
      if (acknowledged !== (responseHash !== null)) invalid('Worker delivery acknowledgement state is inconsistent');
      return deepFreeze({ record, acknowledged });
    });
  }

  async acknowledge(namespaceValue, attemptRefValue, responseHashValue) {
    const namespace = requireOpaqueRef(namespaceValue, 'worker delivery namespace');
    const attemptRef = requireSha256(attemptRefValue, 'worker delivery attempt_ref');
    const responseHash = requireSha256(responseHashValue, 'worker delivery response_hash');
    return this.#transaction(async (client) => {
      const updated = await client.query(
        `UPDATE ${this.#schema}.managed_worker_delivery_attempts
            SET acknowledged = true, response_hash = $3, acknowledged_at = clock_timestamp()
          WHERE namespace = $1 AND attempt_ref = $2 AND acknowledged = false
          RETURNING attempt_ref`,
        [namespace, attemptRef, responseHash],
      );
      if (updated.rowCount === 1) return true;
      const existing = await client.query(
        `SELECT acknowledged, response_hash FROM ${this.#schema}.managed_worker_delivery_attempts
          WHERE namespace = $1 AND attempt_ref = $2`,
        [namespace, attemptRef],
      );
      if (existing.rowCount !== 1 || existing.rows[0].acknowledged !== true
        || existing.rows[0].response_hash !== responseHash) {
        throw managedError('Worker delivery acknowledgement replay differs', 'WORKER_DELIVERY_ACK_REPLAY_MISMATCH', 409);
      }
      return false;
    });
  }

  async listPending(namespaceValue, limitValue) {
    const namespace = requireOpaqueRef(namespaceValue, 'worker delivery namespace');
    const limit = requireInteger(limitValue, 'worker delivery pending limit', { min: 1, max: 1000 });
    return this.#transaction(async (client) => {
      const result = await client.query(
        `SELECT attempt_ref FROM ${this.#schema}.managed_worker_delivery_attempts
          WHERE namespace = $1 AND acknowledged = false
          ORDER BY created_at, attempt_ref LIMIT $2`,
        [namespace, limit],
      );
      if (result.rows.length > limit) invalid('Worker delivery pending query exceeded limit');
      return deepFreeze(result.rows.map((row) => requireSha256(row.attempt_ref, 'attempt_ref')));
    });
  }

  async close() {
    if (this.#closed) return false;
    this.#closed = true;
    if (this.#ownsPool) await this.#pool.end();
    return true;
  }
}

export async function createPostgresWorkerDeliveryStore(options = {}) {
  assertPlainRecord(options, 'worker delivery PostgreSQL store options');
  assertAllowedKeys(options, ['pool', 'connectionString', 'schemaName', 'tls', 'maxConnections', 'connectionTimeoutMs', 'statementTimeoutMs', 'controlPlane', 'requireTls', 'disposableDb'], 'worker delivery PostgreSQL store options');
  if (options.controlPlane?.config?.environment !== 'local_test' || options.controlPlane.config.enabled !== true) {
    throw managedError('Worker delivery store is local_test only', 'WORKER_NOT_QUALIFIED', 503);
  }
  if (options.pool && options.connectionString) throw new TypeError('Provide either pool or connectionString, not both');
  const requireTls = options.requireTls ?? true;
  if (typeof requireTls !== 'boolean') throw new TypeError('requireTls must be boolean');
  if (!requireTls && options.disposableDb !== true) throw managedError('TLS bypass requires explicit disposableDb=true', 'WORKER_TLS_REQUIRED', 503);
  if (requireTls && options.pool) throw managedError('CA-pinned transport requires a factory-owned pool', 'WORKER_POSTGRES_TLS_POOL_UNTRUSTED', 503);
  const ownsPool = !options.pool;
  const pool = options.pool ?? await createPostgresAuthorityPool({
    connectionString: options.connectionString, requireTls, tls: options.tls,
    maxConnections: options.maxConnections, connectionTimeoutMs: options.connectionTimeoutMs,
    statementTimeoutMs: options.statementTimeoutMs,
    applicationName: 'agoragentic-risk-fork-worker-delivery',
  });
  if (ownsPool) trustedPools.add(pool);
  try { return new PostgresWorkerDeliveryStore({ pool, schemaName: options.schemaName, ownsPool,
    requireTls, disposableDb: options.disposableDb, controlPlane: options.controlPlane,
    statementTimeoutMs: options.statementTimeoutMs ?? 30_000 }); }
  catch (error) { if (ownsPool) await pool.end().catch(() => {}); throw error; }
}
