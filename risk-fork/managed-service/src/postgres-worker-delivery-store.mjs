import {
  acquirePostgresAuthorityClient,
  createPostgresAuthorityPool,
  quotePostgresAuthorityIdentifier,
} from '../../src/adapters/postgres-authority-migrator.mjs';
import { verifyPostgresWorkerDeliveryAttestation } from './postgres-worker-delivery-attestation.mjs';
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
  #expectedOwner;
  #verifiedClients = new WeakSet();
  #ownsPool;
  #requireTls;
  #statementTimeoutMs;
  #closed = false;

  constructor({ pool, schemaName = 'risk_fork_worker_delivery', ownsPool = false,
    requireTls = true, disposableDb = false, controlPlane, expectedOwner, statementTimeoutMs = 30_000 } = {}) {
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
    if (expectedOwner !== undefined) quotePostgresAuthorityIdentifier(expectedOwner, 'worker delivery expected owner');
    this.#expectedOwner = expectedOwner;
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
    return verifyPostgresWorkerDeliveryAttestation(client, {
      schemaName: this.#schemaName, expectedOwner: this.#expectedOwner,
    });
  }

  async initialize() {
    return this.#transaction(async (client, attestation) => attestation);
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
        const attestation = await this.#assertSchema(client);
        const result = await callback(client, attestation);
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
  assertAllowedKeys(options, ['pool', 'connectionString', 'schemaName', 'tls', 'maxConnections', 'connectionTimeoutMs', 'statementTimeoutMs', 'controlPlane', 'requireTls', 'disposableDb', 'expectedOwner'], 'worker delivery PostgreSQL store options');
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
  try { const store = new PostgresWorkerDeliveryStore({ pool, schemaName: options.schemaName, ownsPool,
    requireTls, disposableDb: options.disposableDb, controlPlane: options.controlPlane,
    expectedOwner: options.expectedOwner, statementTimeoutMs: options.statementTimeoutMs ?? 30_000 });
    await store.initialize();
    return store; }
  catch (error) { if (ownsPool) await pool.end().catch(() => {}); throw error; }
}
