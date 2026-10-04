import { acquirePostgresAuthorityClient, createPostgresAuthorityPool } from '../../src/adapters/postgres-authority-migrator.mjs';
import { assertAllowedKeys, assertPlainRecord, managedError, requireEnum, requireOpaqueRef, requireTenantId } from './validation.mjs';
import { checkPolicySignal, normalizePolicyOptions, POLICY_ROUTES, policyDbInteger, policySubjectHash, requestPolicyMigration, requestQuotaWindow, verifyRequestPolicy } from './postgres-request-policy-config.mjs';
import { verifyPostgresRequestPolicyAttestation } from './postgres-request-policy-attestation.mjs';

// These callbacks are trusted-host seams, not authenticator capabilities. Bind
// them through createManagedRequestPolicy, never expose them as public routes.
export class PostgresManagedRequestPolicyStore {
  #pool; #config; #migration; #ownsPool; #closed = false;
  constructor(options = {}) {
    this.#config = normalizePolicyOptions(options, ['ownsPool', 'expectedOwner']);
    if (!options.pool) throw new TypeError('Direct store requires a disposable injected pool; use the factory for TLS');
    if (options.ownsPool !== undefined && typeof options.ownsPool !== 'boolean') throw new TypeError('ownsPool must be boolean');
    this.#pool = options.pool; this.#ownsPool = options.ownsPool === true;
  }
  static async create(options = {}) {
    const config = normalizePolicyOptions(options, ['expectedOwner']);
    const owned = options.pool == null;
    const pool = options.pool ?? await createPostgresAuthorityPool({ connectionString: options.connectionString,
      requireTls: config.requireTls, tls: options.tls, maxConnections: options.maxConnections ?? 4,
      connectionTimeoutMs: options.connectionTimeoutMs, statementTimeoutMs: config.statementTimeoutMs,
      applicationName: 'risk-fork-request-policy' });
    // Factory provenance stays private; do not launder a caller pool into TLS.
    const store = new PostgresManagedRequestPolicyStore({ pool, quotas: config.quotas, schemaName: config.schemaName,
      requireTls: false, disposableDb: true, statementTimeoutMs: config.statementTimeoutMs });
    store.#config = config; store.#ownsPool = owned;
    try { await store.initialize(); return store; }
    catch (error) { if (owned) await pool.end().catch(() => {}); throw error; }
  }
  async #transaction(signal, run) {
    checkPolicySignal(signal);
    if (this.#closed) throw managedError('Request policy store is closed', 'POLICY_UNAVAILABLE', 503);
    const migration = this.#migration ?? await requestPolicyMigration(this.#config.schemaName);
    this.#migration = migration;
    let client;
    try { client = await acquirePostgresAuthorityClient(this.#pool, { requireTls: this.#config.requireTls }); }
    catch { checkPolicySignal(signal); throw managedError('Request policy backend unavailable', 'POLICY_UNAVAILABLE', 503); }
    try {
      checkPolicySignal(signal);
      if (this.#closed) throw managedError('Request policy store is closed', 'POLICY_UNAVAILABLE', 503);
      await client.query('BEGIN');
      try {
        await client.query('SET LOCAL synchronous_commit = on');
        await client.query(`SET LOCAL statement_timeout = ${this.#config.statementTimeoutMs}`);
        await client.query(`SET LOCAL lock_timeout = ${this.#config.statementTimeoutMs}`);
        await client.query(`SET LOCAL idle_in_transaction_session_timeout = ${this.#config.statementTimeoutMs}`);
        const s = this.#config.quotedSchema;
        // Shared clock lock is always first, including control reads. Never
        // roll a quota window backward on a different route or after restart.
        const lockedClock = await client.query(`SELECT last_seen_ms FROM ${s}.request_policy_clock WHERE singleton = true FOR UPDATE`);
        if (lockedClock.rowCount !== 1) throw new TypeError('Missing policy clock');
        await verifyPostgresRequestPolicyAttestation(client, { schemaName: this.#config.schemaName, expectedOwner: this.#config.expectedOwner });
        const control = await verifyRequestPolicy(client, this.#config, migration.hash);
        const sampled = await client.query('SELECT floor(extract(epoch FROM clock_timestamp()) * 1000)::bigint AS now_ms');
        const now = policyDbInteger(sampled.rows[0]?.now_ms), prior = policyDbInteger(lockedClock.rows[0].last_seen_ms);
        if (sampled.rowCount !== 1 || now < prior) throw new TypeError('Request policy database clock regressed');
        checkPolicySignal(signal);
        await client.query(`UPDATE ${s}.request_policy_clock SET last_seen_ms = $1 WHERE singleton = true`, [now]);
        const result = await run(client, control, now);
        checkPolicySignal(signal);
        await client.query('COMMIT');
        checkPolicySignal(signal); // An unknown/late commit is never an allow.
        return result;
      } catch (error) { await client.query('ROLLBACK').catch(() => {}); throw error; }
    } catch (error) {
      if (error?.code === 'REQUEST_TIMEOUT' || signal?.aborted) throw managedError('Request deadline expired', 'REQUEST_TIMEOUT', 408);
      throw managedError('Request policy backend unavailable', 'POLICY_UNAVAILABLE', 503);
    } finally { client.release(); }
  }
  async initialize() {
    await this.#transaction(undefined, async () => undefined);
    return Object.freeze({ production_qualified: false, live_traffic_protected: false, configuration_verified: true,
      exact_catalog_verified: true, runtime_privileges_verified: this.#config.expectedOwner !== undefined });
  }
  async readControl(signal) { return this.#transaction(signal, async (_client, control) => control); }
  async consumeRateLimit(input) {
    assertPlainRecord(input, 'rate request');
    assertAllowedKeys(input, ['tenant_id', 'key_id', 'route_class', 'signal'], 'rate request');
    const tenant = requireTenantId(input.tenant_id);
    const key = requireOpaqueRef(input.key_id, 'key_id');
    const route = requireEnum(input.route_class, POLICY_ROUTES, 'route_class');
    const signal = input.signal;
    return this.#transaction(signal, async (client, _control, now) => {
      const s = this.#config.quotedSchema;
      // The global clock row already serializes all consumers. Configuration
      // is owner-maintained only while this backend is drained.
      const locked = await client.query(`SELECT route_class FROM ${s}.request_policy_routes WHERE route_class = $1`, [route]);
      if (locked.rowCount !== 1) throw new TypeError('Missing route lock');
      checkPolicySignal(signal);
      const q = this.#config.quotas[route], { start, retry } = requestQuotaWindow(now, q.windowMs);
      // Reclamation is bounded by maxSubjects and serialized with consumption.
      // Only expired windows are deleted; the shared high-water forbids reuse.
      await client.query(`DELETE FROM ${s}.request_policy_subjects WHERE route_class = $1 AND bucket_start_ms < $2`, [route, start]);
      const hashes = [policySubjectHash('tenant', tenant), policySubjectHash('key', tenant, key)];
      const rows = await client.query(`SELECT subject_kind, subject_hash, bucket_start_ms, used FROM ${s}.request_policy_subjects
        WHERE route_class = $1 AND ((subject_kind = 'tenant' AND subject_hash = $2) OR (subject_kind = 'key' AND subject_hash = $3))`, [route, ...hashes]);
      const found = new Map();
      for (const row of rows.rows) {
        const bucket = policyDbInteger(row.bucket_start_ms), used = policyDbInteger(row.used);
        if (!['tenant', 'key'].includes(row.subject_kind) || found.has(row.subject_kind)
          || row.subject_hash !== hashes[row.subject_kind === 'tenant' ? 0 : 1]
          || !Number.isSafeInteger(bucket) || bucket < 0 || bucket > start || bucket % q.windowMs !== 0
          || !Number.isInteger(used) || used < 1 || used > (row.subject_kind === 'tenant' ? q.perTenant : q.perKey)) throw new TypeError('Invalid quota state');
        found.set(row.subject_kind, { bucket, used });
      }
      const count = await client.query(`SELECT count(*)::integer AS subjects FROM ${s}.request_policy_subjects WHERE route_class = $1`, [route]);
      const size = count.rows[0]?.subjects;
      if (count.rowCount !== 1 || !Number.isInteger(size) || size < found.size || size > q.maxSubjects) throw new TypeError('Invalid quota capacity');
      if (size + 2 - found.size > q.maxSubjects) return Object.freeze({ allowed: false, retry_after_seconds: retry });
      for (const kind of ['tenant', 'key']) {
        const previous = found.get(kind), limit = kind === 'tenant' ? q.perTenant : q.perKey;
        if (previous?.bucket === start && previous.used >= limit) return Object.freeze({ allowed: false, retry_after_seconds: retry });
      }
      checkPolicySignal(signal);
      for (const [index, kind] of ['tenant', 'key'].entries()) {
        const previous = found.get(kind), used = previous?.bucket === start ? previous.used + 1 : 1;
        await client.query(`INSERT INTO ${s}.request_policy_subjects (route_class, subject_kind, subject_hash, bucket_start_ms, used)
          VALUES ($1,$2,$3,$4,$5) ON CONFLICT (route_class, subject_kind, subject_hash)
          DO UPDATE SET bucket_start_ms = EXCLUDED.bucket_start_ms, used = EXCLUDED.used`, [route, kind, hashes[index], start, used]);
      }
      return Object.freeze({ allowed: true, retry_after_seconds: 0 });
    });
  }
  async close() { if (this.#closed) return; this.#closed = true; if (this.#ownsPool) await this.#pool.end(); }
}

export const createPostgresManagedRequestPolicyStore = (options) => PostgresManagedRequestPolicyStore.create(options);
