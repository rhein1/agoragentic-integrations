import { acquirePostgresAuthorityClient, createPostgresAuthorityPool } from '../../src/adapters/postgres-authority-migrator.mjs';
import { sha256Ref } from '../../src/canonical.mjs';
import { assertAllowedKeys, assertPlainRecord, managedError, requireInteger } from './validation.mjs';
import { checkTelemetrySignal, normalizeTelemetryOptions, telemetryClaimHash, telemetryDbInteger, telemetryMigration, verifyTelemetrySettings } from './postgres-telemetry-config.mjs';
import { verifyPostgresManagedTelemetryAttestation } from './postgres-telemetry-attestation.mjs';
import { managedTelemetryEventHash, normalizeManagedTelemetryEvent, requireTelemetryRef } from './telemetry-event.mjs';

const FIELDS = 'event_ref,event_hash,event,route_class,status,outcome,duration_ms,tenant_hash,key_hash,created_ms';
const DELIVERY_FIELDS = `${FIELDS},state,generation,attempts,claim_hash,lease_expires_ms,next_attempt_ms,acknowledged_ms,acknowledgement_hash,last_error_code`;
const KNOWN_ERRORS = new Set(['TELEMETRY_CAPACITY','TELEMETRY_EVENT_CONFLICT','TELEMETRY_STALE_CLAIM','TELEMETRY_CLAIM_EXPIRED']);
const fail = (code) => managedError('Telemetry operation unavailable', code, 503);
function input(value, fields) { assertPlainRecord(value, 'telemetry request'); assertAllowedKeys(value, fields, 'telemetry request'); return value; }
function readEvent(row) {
  const event = normalizeManagedTelemetryEvent(Object.fromEntries(['event_ref','event','route_class','status','outcome','duration_ms','tenant_hash','key_hash'].map((name) => [name,row[name]])));
  if (managedTelemetryEventHash(event) !== row.event_hash || telemetryDbInteger(row.created_ms) < 0) throw new TypeError('Telemetry payload drift');
  return event;
}
function claimResult(row) {
  return Object.freeze({ event: readEvent(row), generation: requireInteger(telemetryDbInteger(row.generation), 'generation', { min: 1 }),
    attempts: requireInteger(row.attempts, 'attempts', { min: 1, max: 1_000_000 }),
    lease_expires_ms: requireInteger(telemetryDbInteger(row.lease_expires_ms), 'lease_expires_ms') });
}

// Trusted observer storage, not execution authority or a public route. Payloads
// are immutable under the reviewed runtime column grants. Delivery is at least
// once; consumers deduplicate event_ref. Unknown commits are never success.
export class PostgresManagedTelemetryStore {
  #pool; #config; #ownsPool; #migration; #closed = false;
  constructor(options = {}) {
    this.#config = normalizeTelemetryOptions(options, ['ownsPool']);
    if (!options.pool) throw new TypeError('Direct telemetry store requires a disposable injected pool');
    if (options.ownsPool !== undefined && typeof options.ownsPool !== 'boolean') throw new TypeError('ownsPool must be boolean');
    this.#pool = options.pool; this.#ownsPool = options.ownsPool === true;
  }
  static async create(options = {}) {
    const config = normalizeTelemetryOptions(options), owned = options.pool == null;
    const pool = options.pool ?? await createPostgresAuthorityPool({ connectionString: options.connectionString,
      requireTls: config.requireTls, tls: options.tls, maxConnections: options.maxConnections ?? 4,
      connectionTimeoutMs: options.connectionTimeoutMs, statementTimeoutMs: config.statementTimeoutMs,
      applicationName: 'risk-fork-managed-telemetry' });
    const store = new PostgresManagedTelemetryStore({ pool, limits: config.limits, schemaName: config.schemaName,
      requireTls: false, disposableDb: true, statementTimeoutMs: config.statementTimeoutMs });
    store.#config = config; store.#ownsPool = owned;
    try { await store.initialize(); return store; } catch (error) { if (owned) await pool.end().catch(() => {}); throw error; }
  }
  async #transaction(signal, operation) {
    checkTelemetrySignal(signal);
    if (this.#closed) throw fail('TELEMETRY_UNAVAILABLE');
    const migration = this.#migration ?? await telemetryMigration(this.#config.schemaName); this.#migration = migration;
    let client;
    try { client = await acquirePostgresAuthorityClient(this.#pool, { requireTls: this.#config.requireTls }); }
    catch { checkTelemetrySignal(signal); throw fail('TELEMETRY_UNAVAILABLE'); }
    try {
      checkTelemetrySignal(signal); if (this.#closed) throw fail('TELEMETRY_UNAVAILABLE');
      await client.query('BEGIN');
      try {
        await client.query('SET LOCAL synchronous_commit = on');
        await client.query(`SET LOCAL statement_timeout = ${this.#config.statementTimeoutMs}`);
        await client.query(`SET LOCAL lock_timeout = ${this.#config.statementTimeoutMs}`);
        await client.query(`SET LOCAL idle_in_transaction_session_timeout = ${this.#config.statementTimeoutMs}`);
        const s = this.#config.quotedSchema;
        await verifyPostgresManagedTelemetryAttestation(client, { schemaName: this.#config.schemaName, expectedOwner: this.#config.expectedOwner });
        const clock = await client.query(`SELECT last_seen_ms FROM ${s}.telemetry_clock WHERE singleton=true FOR UPDATE`);
        if (clock.rowCount !== 1) throw new TypeError('Missing telemetry clock');
        await verifyPostgresManagedTelemetryAttestation(client, { schemaName: this.#config.schemaName, expectedOwner: this.#config.expectedOwner });
        await verifyTelemetrySettings(client, this.#config, migration.hash);
        const sample = await client.query('SELECT floor(extract(epoch FROM clock_timestamp()) * 1000)::bigint AS now_ms');
        const now = telemetryDbInteger(sample.rows[0]?.now_ms), prior = telemetryDbInteger(clock.rows[0].last_seen_ms);
        if (sample.rowCount !== 1 || now < prior) throw new TypeError('Telemetry clock regressed');
        checkTelemetrySignal(signal);
        await client.query(`UPDATE ${s}.telemetry_clock SET last_seen_ms=$1 WHERE singleton=true`, [now]);
        const result = await operation(client, now);
        checkTelemetrySignal(signal); await client.query('COMMIT'); checkTelemetrySignal(signal);
        return result;
      } catch (error) { await client.query('ROLLBACK').catch(() => {}); throw error; }
    } catch (error) {
      if (error?.code === 'REQUEST_TIMEOUT' || signal?.aborted) throw managedError('Telemetry deadline expired', 'REQUEST_TIMEOUT', 408);
      if (KNOWN_ERRORS.has(error?.code)) throw fail(error.code);
      throw fail('TELEMETRY_UNAVAILABLE');
    } finally { client.release(); }
  }
  async initialize() {
    await this.#transaction(undefined, async () => undefined);
    return Object.freeze({ configuration_verified: true, exact_catalog_verified: true,
      runtime_privileges_verified: this.#config.expectedOwner !== undefined, production_qualified: false });
  }
  async append(value, options = {}) {
    const event = normalizeManagedTelemetryEvent(value), hash = managedTelemetryEventHash(event);
    input(options, ['signal']);
    return this.#transaction(options.signal, async (client, now) => {
      const s = this.#config.quotedSchema;
      const prior = await client.query(`SELECT ${FIELDS} FROM ${s}.telemetry_events WHERE event_ref=$1`, [event.event_ref]);
      if (prior.rowCount) {
        if (prior.rowCount !== 1 || prior.rows[0].event_hash !== hash) throw fail('TELEMETRY_EVENT_CONFLICT');
        readEvent(prior.rows[0]);
        return Object.freeze({ event_ref: event.event_ref, persisted: true });
      }
      const count = await client.query(`SELECT count(*)::integer AS total,count(*) FILTER (WHERE tenant_hash=$1)::integer AS tenant FROM ${s}.telemetry_events`, [event.tenant_hash]);
      const size = count.rows[0], l = this.#config.limits;
      if (count.rowCount !== 1 || !Number.isInteger(size?.total) || !Number.isInteger(size?.tenant)) throw new TypeError('Invalid telemetry capacity');
      if (size.total >= l.maxEvents || size.tenant >= l.maxEventsPerTenant) throw fail('TELEMETRY_CAPACITY');
      await client.query(`INSERT INTO ${s}.telemetry_events (${FIELDS}) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
        [event.event_ref,hash,event.event,event.route_class,event.status,event.outcome,event.duration_ms,event.tenant_hash,event.key_hash,now]);
      return Object.freeze({ event_ref: event.event_ref, persisted: true });
    });
  }
  async claim(options) {
    input(options, ['claimToken','signal']); const hash = telemetryClaimHash(options.claimToken);
    return this.#transaction(options.signal, async (client, now) => {
      const s = this.#config.quotedSchema;
      const same = await client.query(`SELECT ${DELIVERY_FIELDS} FROM ${s}.telemetry_events WHERE claim_hash=$1`, [hash]);
      if (same.rowCount) {
        if (same.rowCount !== 1) throw new TypeError('Ambiguous telemetry claim');
        const row = same.rows[0];
        if (row.state === 'acked') return null;
        if (row.state !== 'claimed' || telemetryDbInteger(row.lease_expires_ms) <= now) throw fail('TELEMETRY_CLAIM_EXPIRED');
        return claimResult(row);
      }
      const due = await client.query(`SELECT ${DELIVERY_FIELDS} FROM ${s}.telemetry_events
        WHERE ((state='pending' AND next_attempt_ms <= $1) OR (state='claimed' AND lease_expires_ms <= $1))
          AND attempts < 1000000 AND generation < 9007199254740991
        ORDER BY created_ms,event_ref LIMIT 1 FOR UPDATE SKIP LOCKED`, [now]);
      if (due.rowCount === 0) return null;
      const row = due.rows[0]; readEvent(row);
      const generation = requireInteger(telemetryDbInteger(row.generation), 'generation', { max: Number.MAX_SAFE_INTEGER - 1 }) + 1;
      const attempts = requireInteger(row.attempts, 'attempts', { max: 999_999 }) + 1;
      const expiry = requireInteger(now + this.#config.limits.leaseMs, 'lease_expires_ms');
      const updated = await client.query(`UPDATE ${s}.telemetry_events SET state='claimed',generation=$2,attempts=$3,
        claim_hash=$4,lease_expires_ms=$5,last_error_code=NULL WHERE event_ref=$1 RETURNING ${DELIVERY_FIELDS}`,
        [row.event_ref,generation,attempts,hash,expiry]);
      if (updated.rowCount !== 1) throw new TypeError('Claim lost');
      return claimResult(updated.rows[0]);
    });
  }
  async acknowledge(options) {
    input(options, ['event_ref','generation','claimToken','acknowledgement','signal']);
    const ref = requireTelemetryRef(options.event_ref), generation = requireInteger(options.generation, 'generation', { min: 1 });
    const hash = telemetryClaimHash(options.claimToken);
    input(options.acknowledgement, ['event_ref','delivered']);
    if (!Object.hasOwn(options.acknowledgement, 'event_ref') || !Object.hasOwn(options.acknowledgement, 'delivered')
      || options.acknowledgement.event_ref !== ref || options.acknowledgement.delivered !== true) throw new TypeError('Invalid telemetry delivery acknowledgement');
    const ackHash = sha256Ref({ event_ref: ref, delivered: true });
    return this.#transaction(options.signal, async (client, now) => {
      const s = this.#config.quotedSchema;
      const result = await client.query(`SELECT ${DELIVERY_FIELDS} FROM ${s}.telemetry_events WHERE event_ref=$1 FOR UPDATE`, [ref]);
      const row = result.rows[0];
      if (result.rowCount !== 1 || telemetryDbInteger(row.generation) !== generation || row.claim_hash !== hash) throw fail('TELEMETRY_STALE_CLAIM');
      readEvent(row);
      if (row.state === 'acked' && row.acknowledgement_hash === ackHash) return Object.freeze({ event_ref: ref, acknowledged: true });
      if (row.state !== 'claimed' || telemetryDbInteger(row.lease_expires_ms) <= now) throw fail('TELEMETRY_STALE_CLAIM');
      await client.query(`UPDATE ${s}.telemetry_events SET state='acked',acknowledged_ms=$2,acknowledgement_hash=$3,
        last_error_code=NULL WHERE event_ref=$1`, [ref,now,ackHash]);
      return Object.freeze({ event_ref: ref, acknowledged: true });
    });
  }
  async retry(options) {
    input(options, ['event_ref','generation','claimToken','errorCode','signal']);
    const ref = requireTelemetryRef(options.event_ref), generation = requireInteger(options.generation, 'generation', { min: 1 });
    const hash = telemetryClaimHash(options.claimToken);
    if (!['SINK_UNAVAILABLE','INVALID_ACK','REQUEST_TIMEOUT'].includes(options.errorCode)) throw new TypeError('Invalid redacted telemetry error');
    return this.#transaction(options.signal, async (client, now) => {
      const s = this.#config.quotedSchema;
      const result = await client.query(`SELECT ${DELIVERY_FIELDS} FROM ${s}.telemetry_events WHERE event_ref=$1 FOR UPDATE`, [ref]);
      const row = result.rows[0];
      if (result.rowCount !== 1 || row.state !== 'claimed' || row.claim_hash !== hash
        || telemetryDbInteger(row.generation) !== generation || telemetryDbInteger(row.lease_expires_ms) <= now) throw fail('TELEMETRY_STALE_CLAIM');
      readEvent(row);
      const next = requireInteger(now + this.#config.limits.retryMs, 'next_attempt_ms');
      await client.query(`UPDATE ${s}.telemetry_events SET state='pending',claim_hash=NULL,lease_expires_ms=NULL,
        next_attempt_ms=$2,last_error_code=$3 WHERE event_ref=$1`, [ref,next,options.errorCode]);
      return Object.freeze({ event_ref: ref, pending: true });
    });
  }
  async stats(options = {}) {
    input(options, ['signal']);
    return this.#transaction(options.signal, async (client) => {
      const result = await client.query(`SELECT state,count(*)::integer AS count FROM ${this.#config.quotedSchema}.telemetry_events GROUP BY state ORDER BY state`);
      const counts = { pending: 0, claimed: 0, acked: 0 };
      for (const row of result.rows) { if (!Object.hasOwn(counts,row.state) || !Number.isInteger(row.count) || row.count < 0) throw new TypeError('Invalid telemetry statistics'); counts[row.state] = row.count; }
      const exhausted = await client.query(`SELECT count(*)::integer AS count FROM ${this.#config.quotedSchema}.telemetry_events
        WHERE state<>'acked' AND (attempts=1000000 OR generation=9007199254740991)`);
      if (exhausted.rowCount !== 1 || !Number.isInteger(exhausted.rows[0]?.count) || exhausted.rows[0].count < 0) throw new TypeError('Invalid exhausted telemetry statistics');
      return Object.freeze({ ...counts, exhausted: exhausted.rows[0].count, production_qualified: false });
    });
  }
  async close() { if (this.#closed) return; this.#closed = true; if (this.#ownsPool) await this.#pool.end(); }
}

export const createPostgresManagedTelemetryStore = (options) => PostgresManagedTelemetryStore.create(options);
