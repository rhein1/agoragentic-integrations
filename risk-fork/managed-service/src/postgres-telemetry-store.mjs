import { acquirePostgresAuthorityClient, createPostgresAuthorityPool } from '../../src/adapters/postgres-authority-migrator.mjs';
import { canonicalize, sha256Ref } from '../../src/canonical.mjs';
import { assertAllowedKeys, assertPlainRecord, managedError, requireInteger, requireInvocationRef, requireSha256 } from './validation.mjs';
import { checkTelemetrySignal, normalizeTelemetryOptions, telemetryClaimHash, telemetryDbInteger, telemetryMigration, verifyTelemetrySettings } from './postgres-telemetry-config.mjs';
import { verifyPostgresManagedTelemetryAttestation } from './postgres-telemetry-attestation.mjs';
import { managedTelemetryEventHash, normalizeManagedTelemetryEvent, requireTelemetryRef } from './telemetry-event.mjs';
import { lifecycleInvocationHash, lifecycleTenantHash, normalizeManagedLifecycleEvent, projectManagedLifecycleEvent } from './lifecycle-event.mjs';
import { lifecycleCheckpoint, lifecycleScope, lifecycleStateHash, lifecycleSweep } from './lifecycle-state.mjs';
import { verifyAuditInvocationPage } from './audit-read.mjs';
import { verifyManagedAuditWindow } from './audit.mjs';
import { acknowledgeMetricAlert, readMetricAlert, readMetricWindow, recordMetricSource, replayMetricSource, verifyMetricTotals } from './postgres-metric-state.mjs';

const FIELDS = 'event_ref,event_hash,event,route_class,status,outcome,duration_ms,tenant_hash,key_hash,created_ms';
const DELIVERY_FIELDS = `${FIELDS},state,generation,attempts,claim_hash,lease_expires_ms,next_attempt_ms,acknowledged_ms,acknowledgement_hash,last_error_code`;
const LIFECYCLE_FIELDS = 'event_ref,event_hash,tenant_hash,invocation_hash,source_sequence,payload,created_ms';
const LIFECYCLE_DELIVERY_FIELDS = `${LIFECYCLE_FIELDS},state,generation,attempts,claim_hash,lease_expires_ms,next_attempt_ms,acknowledged_ms,acknowledgement_hash,last_error_code`;
const ALERT_FIELDS = 'event_ref,event_hash,tenant_hash,payload,created_ms';
const ALERT_DELIVERY_FIELDS = `${ALERT_FIELDS},state,generation,attempts,claim_hash,lease_expires_ms,next_attempt_ms,acknowledged_ms,acknowledgement_hash,last_error_code`;
const KNOWN_ERRORS = new Set(['TELEMETRY_CAPACITY','TELEMETRY_EVENT_CONFLICT','TELEMETRY_STALE_CLAIM','TELEMETRY_CLAIM_EXPIRED','TELEMETRY_CHECKPOINT_CONFLICT','TELEMETRY_CHECKPOINT_DRIFT','TELEMETRY_METRIC_DRIFT']);
const fail = (code) => managedError('Telemetry operation unavailable', code, 503);
function input(value, fields) { assertPlainRecord(value, 'telemetry request'); assertAllowedKeys(value, fields, 'telemetry request'); return value; }
function readEvent(row, kind = 'policy', settings) {
  const event = kind === 'alert' ? readMetricAlert(row,settings) : kind === 'lifecycle' ? normalizeManagedLifecycleEvent(row.payload)
    : normalizeManagedTelemetryEvent(Object.fromEntries(['event_ref','event','route_class','status','outcome','duration_ms','tenant_hash','key_hash'].map((name) => [name,row[name]])));
  if (sha256Ref(event) !== row.event_hash || telemetryDbInteger(row.created_ms) < 0
    || (kind === 'lifecycle' && (row.event_ref !== event.event_ref || row.tenant_hash !== event.tenant_hash
      || row.invocation_hash !== event.invocation_hash || row.source_sequence !== event.source_sequence))) throw new TypeError('Telemetry payload drift');
  return event;
}
function claimResult(row, kind, settings) {
  return Object.freeze({ event: readEvent(row,kind,settings), generation: requireInteger(telemetryDbInteger(row.generation), 'generation', { min: 1 }),
    attempts: requireInteger(row.attempts, 'attempts', { min: 1, max: 1_000_000 }),
    lease_expires_ms: requireInteger(telemetryDbInteger(row.lease_expires_ms), 'lease_expires_ms') });
}

// Trusted observer storage, not execution authority or a public route. Payloads
// are immutable under the reviewed runtime column grants. Delivery is at least
// once; consumers deduplicate event_ref. Unknown commits are never success.
export class PostgresManagedTelemetryStore {
  #pool; #config; #ownsPool; #migration; #closed = false;
  get #table() { return this.#config.eventKind === 'alert' ? 'telemetry_metric_alerts' : this.#config.eventKind === 'lifecycle' ? 'telemetry_lifecycle_events' : 'telemetry_events'; }
  get #fields() { return this.#config.eventKind === 'alert' ? ALERT_DELIVERY_FIELDS : this.#config.eventKind === 'lifecycle' ? LIFECYCLE_DELIVERY_FIELDS : DELIVERY_FIELDS; }
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
      requireTls: false, disposableDb: true, statementTimeoutMs: config.statementTimeoutMs,lifecycle: config.lifecycle,eventKind: config.eventKind,
      metrics: config.metrics,metricSettings: config.metricSettings });
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
        await verifyPostgresManagedTelemetryAttestation(client, { schemaName: this.#config.schemaName, expectedOwner: this.#config.expectedOwner,lifecycle: this.#config.lifecycle,metrics: this.#config.metrics });
        const clock = await client.query(`SELECT last_seen_ms FROM ${s}.telemetry_clock WHERE singleton=true FOR UPDATE`);
        if (clock.rowCount !== 1) throw new TypeError('Missing telemetry clock');
        await verifyPostgresManagedTelemetryAttestation(client, { schemaName: this.#config.schemaName, expectedOwner: this.#config.expectedOwner,lifecycle: this.#config.lifecycle,metrics: this.#config.metrics });
        await verifyTelemetrySettings(client, this.#config, migration.hash);
        await verifyMetricTotals(client,this.#config);
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
    if (this.#config.eventKind !== 'policy') throw new TypeError('Only policy packets use append; lifecycle/alerts require atomic source projection');
    const event = normalizeManagedTelemetryEvent(value), hash = managedTelemetryEventHash(event);
    input(options, ['signal']);
    return this.#transaction(options.signal, async (client, now) => {
      const s = this.#config.quotedSchema;
      const prior = await client.query(`SELECT ${FIELDS} FROM ${s}.telemetry_events WHERE event_ref=$1`, [event.event_ref]);
      const replay = await replayMetricSource(client,this.#config,event,'policy');
      if (prior.rowCount) {
        if (prior.rowCount !== 1 || prior.rows[0].event_hash !== hash) throw fail('TELEMETRY_EVENT_CONFLICT');
        readEvent(prior.rows[0]);
        if (this.#config.metrics && !replay) throw fail('TELEMETRY_METRIC_DRIFT');
        return Object.freeze({ event_ref: event.event_ref, persisted: true });
      }
      if (replay) return Object.freeze({ event_ref: event.event_ref,persisted: true });
      const count = await client.query(`SELECT count(*)::integer AS total,count(*) FILTER (WHERE tenant_hash=$1)::integer AS tenant FROM ${s}.telemetry_events`, [event.tenant_hash]);
      const size = count.rows[0], l = this.#config.limits;
      if (count.rowCount !== 1 || !Number.isInteger(size?.total) || !Number.isInteger(size?.tenant)) throw new TypeError('Invalid telemetry capacity');
      if (size.total >= l.maxEvents || size.tenant >= l.maxEventsPerTenant) throw fail('TELEMETRY_CAPACITY');
      await client.query(`INSERT INTO ${s}.telemetry_events (${FIELDS}) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
        [event.event_ref,hash,event.event,event.route_class,event.status,event.outcome,event.duration_ms,event.tenant_hash,event.key_hash,now]);
      await recordMetricSource(client,this.#config,event,'policy',now);
      return Object.freeze({ event_ref: event.event_ref, persisted: true });
    });
  }
  async claim(options) {
    input(options, ['claimToken','signal']); const hash = telemetryClaimHash(options.claimToken);
    return this.#transaction(options.signal, async (client, now) => {
      const s = this.#config.quotedSchema;
      const same = await client.query(`SELECT ${this.#fields} FROM ${s}.${this.#table} WHERE claim_hash=$1`, [hash]);
      if (same.rowCount) {
        if (same.rowCount !== 1) throw new TypeError('Ambiguous telemetry claim');
        const row = same.rows[0];
        if (row.state === 'acked') return null;
        if (row.state !== 'claimed' || telemetryDbInteger(row.lease_expires_ms) <= now) throw fail('TELEMETRY_CLAIM_EXPIRED');
        return claimResult(row,this.#config.eventKind,this.#config.metricSettings);
      }
      const due = await client.query(`SELECT ${this.#fields} FROM ${s}.${this.#table}
        WHERE ((state='pending' AND next_attempt_ms <= $1) OR (state='claimed' AND lease_expires_ms <= $1))
          AND attempts < 1000000 AND generation < 9007199254740991
        ORDER BY created_ms,event_ref LIMIT 1 FOR UPDATE SKIP LOCKED`, [now]);
      if (due.rowCount === 0) return null;
      const row = due.rows[0]; readEvent(row,this.#config.eventKind,this.#config.metricSettings);
      const generation = requireInteger(telemetryDbInteger(row.generation), 'generation', { max: Number.MAX_SAFE_INTEGER - 1 }) + 1;
      const attempts = requireInteger(row.attempts, 'attempts', { max: 999_999 }) + 1;
      const expiry = requireInteger(now + this.#config.limits.leaseMs, 'lease_expires_ms');
      const updated = await client.query(`UPDATE ${s}.${this.#table} SET state='claimed',generation=$2,attempts=$3,
        claim_hash=$4,lease_expires_ms=$5,last_error_code=NULL WHERE event_ref=$1 RETURNING ${this.#fields}`,
        [row.event_ref,generation,attempts,hash,expiry]);
      if (updated.rowCount !== 1) throw new TypeError('Claim lost');
      return claimResult(updated.rows[0],this.#config.eventKind,this.#config.metricSettings);
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
      const result = await client.query(`SELECT ${this.#fields} FROM ${s}.${this.#table} WHERE event_ref=$1 FOR UPDATE`, [ref]);
      const row = result.rows[0];
      if (result.rowCount !== 1 || telemetryDbInteger(row.generation) !== generation || row.claim_hash !== hash) throw fail('TELEMETRY_STALE_CLAIM');
      readEvent(row,this.#config.eventKind,this.#config.metricSettings);
      if (row.state === 'acked' && row.acknowledgement_hash === ackHash) return Object.freeze({ event_ref: ref, acknowledged: true });
      if (row.state !== 'claimed' || telemetryDbInteger(row.lease_expires_ms) <= now) throw fail('TELEMETRY_STALE_CLAIM');
      await client.query(`UPDATE ${s}.${this.#table} SET state='acked',acknowledged_ms=$2,acknowledgement_hash=$3,
        last_error_code=NULL WHERE event_ref=$1`, [ref,now,ackHash]);
      if (this.#config.eventKind === 'alert') await acknowledgeMetricAlert(client,this.#config,row,now);
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
      const result = await client.query(`SELECT ${this.#fields} FROM ${s}.${this.#table} WHERE event_ref=$1 FOR UPDATE`, [ref]);
      const row = result.rows[0];
      if (result.rowCount !== 1 || row.state !== 'claimed' || row.claim_hash !== hash
        || telemetryDbInteger(row.generation) !== generation || telemetryDbInteger(row.lease_expires_ms) <= now) throw fail('TELEMETRY_STALE_CLAIM');
      readEvent(row,this.#config.eventKind,this.#config.metricSettings);
      const next = requireInteger(now + this.#config.limits.retryMs, 'next_attempt_ms');
      await client.query(`UPDATE ${s}.${this.#table} SET state='pending',claim_hash=NULL,lease_expires_ms=NULL,
        next_attempt_ms=$2,last_error_code=$3 WHERE event_ref=$1`, [ref,next,options.errorCode]);
      return Object.freeze({ event_ref: ref, pending: true });
    });
  }
  async stats(options = {}) {
    input(options, ['signal']);
    return this.#transaction(options.signal, async (client) => {
      const result = await client.query(`SELECT state,count(*)::integer AS count FROM ${this.#config.quotedSchema}.${this.#table} GROUP BY state ORDER BY state`);
      const counts = { pending: 0, claimed: 0, acked: 0 };
      for (const row of result.rows) { if (!Object.hasOwn(counts,row.state) || !Number.isInteger(row.count) || row.count < 0) throw new TypeError('Invalid telemetry statistics'); counts[row.state] = row.count; }
      const exhausted = await client.query(`SELECT count(*)::integer AS count FROM ${this.#config.quotedSchema}.${this.#table}
        WHERE state<>'acked' AND (attempts=1000000 OR generation=9007199254740991)`);
      if (exhausted.rowCount !== 1 || !Number.isInteger(exhausted.rows[0]?.count) || exhausted.rows[0].count < 0) throw new TypeError('Invalid exhausted telemetry statistics');
      return Object.freeze({ ...counts, exhausted: exhausted.rows[0].count, production_qualified: false });
    });
  }
  #lifecycle() { if (!this.#config.lifecycle) throw new TypeError('Lifecycle v2 must be explicitly selected'); }
  async #readSweep(client, scope) {
    const s = this.#config.quotedSchema, key = [scope.observer_hash,scope.tenant_hash];
    const result = await client.query(`SELECT payload,state_hash FROM ${s}.telemetry_lifecycle_sweeps WHERE observer_hash=$1 AND tenant_hash=$2`,key);
    const count = await client.query(`SELECT count(*)::integer AS count FROM ${s}.telemetry_lifecycle_checkpoints WHERE observer_hash=$1 AND tenant_hash=$2`,key);
    const n = count.rows[0]?.count;
    if (count.rowCount !== 1 || !Number.isInteger(n) || n < 0 || n > this.#config.limits.maxEventsPerTenant) throw fail('TELEMETRY_CHECKPOINT_DRIFT');
    if (result.rowCount === 0) { if (n !== 0) throw fail('TELEMETRY_CHECKPOINT_DRIFT'); return null; }
    if (result.rowCount !== 1) throw fail('TELEMETRY_CHECKPOINT_DRIFT');
    const sweep = lifecycleSweep(result.rows[0].payload);
    // Permanent count detects checkpoint loss even after all delivered rows
    // have been pruned. Owner corruption is not independent evidence custody.
    if (sweep.prefix_count !== n || lifecycleStateHash(scope,sweep) !== result.rows[0].state_hash) throw fail('TELEMETRY_CHECKPOINT_DRIFT');
    return sweep;
  }
  async #readCheckpoint(client, scope, invocationHash) {
    const result = await client.query(`SELECT sequence,event_hash,checkpoint_hash FROM ${this.#config.quotedSchema}.telemetry_lifecycle_checkpoints
      WHERE observer_hash=$1 AND tenant_hash=$2 AND invocation_hash=$3`,[scope.observer_hash,scope.tenant_hash,invocationHash]);
    if (result.rowCount === 0) return null;
    if (result.rowCount !== 1) throw fail('TELEMETRY_CHECKPOINT_DRIFT');
    const value = lifecycleCheckpoint({ sequence: result.rows[0].sequence,event_hash: result.rows[0].event_hash });
    if (lifecycleStateHash(scope,{ invocation_hash: invocationHash,...value }) !== result.rows[0].checkpoint_hash) throw fail('TELEMETRY_CHECKPOINT_DRIFT');
    return value;
  }
  async readLifecycleSweep(scopeValue, options = {}) {
    this.#lifecycle(); const scope = lifecycleScope(scopeValue); input(options,['signal']);
    return this.#transaction(options.signal,(client) => this.#readSweep(client,scope));
  }
  async readLifecycleCheckpoint(scopeValue, invocationHashValue, options = {}) {
    this.#lifecycle(); const scope = lifecycleScope(scopeValue);
    const invocationHash = lifecycleInvocationHash(scope.tenant_hash,requireInvocationRef(invocationHashValue));
    // This API takes the raw bounded invocation reference only as input; it
    // never persists it outside the host-owned finite sweep cursor.
    input(options,['signal']);
    return this.#transaction(options.signal,async (client) => {
      await this.#readSweep(client,scope);
      return this.#readCheckpoint(client,scope,invocationHash);
    });
  }
  async appendLifecycleWindow(value, options = {}) {
    this.#lifecycle(); input(options,['signal']);
    input(value,['scope','tenant_id','expected_sweep','expected_checkpoint','page','window']);
    const scope = lifecycleScope(value.scope), expected = lifecycleSweep(value.expected_sweep);
    const checkpoint = lifecycleCheckpoint(value.expected_checkpoint);
    if (lifecycleTenantHash(value.tenant_id) !== scope.tenant_hash) throw new TypeError('Lifecycle tenant mismatch');
    const request = { after_ref: expected?.after_ref ?? null,upper_ref: expected?.upper_ref ?? null,limit: 1 };
    const page = verifyAuditInvocationPage(value.page,value.tenant_id,request);
    const ref = page.invocations[0]?.invocation_ref ?? null;
    let window = null;
    if (ref === null) {
      if (value.window !== null || checkpoint !== null) throw new TypeError('Empty lifecycle page has a window');
    } else {
      input(value.window,['tenant_id','invocation_ref','audit_event_count','audit_head_hash','prior_event','events',
        'complete','next_after_sequence','next_prior_event_hash']);
      window = verifyManagedAuditWindow(Object.fromEntries(['tenant_id','invocation_ref','audit_event_count','audit_head_hash','prior_event','events']
        .map((key) => [key,value.window[key]])),{ tenant_id: value.tenant_id,invocation_ref: ref,
        after_sequence: checkpoint?.sequence ?? 0,prior_event_hash: checkpoint?.event_hash ?? null,limit: 64 });
      if (canonicalize(window) !== canonicalize(value.window)) throw new TypeError('Lifecycle source result drift');
    }
    const batchHash = sha256Ref({ domain: 'risk-fork-lifecycle-batch-v1',scope,expected,checkpoint,page,window });
    const events = window?.events.map(projectManagedLifecycleEvent) ?? [];
    const invocationHash = ref === null ? null : lifecycleInvocationHash(scope.tenant_hash,ref);
    return this.#transaction(options.signal,async (client,now) => {
      const s = this.#config.quotedSchema, current = await this.#readSweep(client,scope);
      // Unknown COMMIT is never called successful by the failed attempt.
      // Exact retained packet replay confirms the single atomic advancement,
      // including after acknowledged outbox retention removed its rows.
      if (current?.last_batch_hash === batchHash && current.version === (expected?.version ?? 0)+1) {
        if (ref !== null) {
          const retained = await this.#readCheckpoint(client,scope,invocationHash);
          const committed = lifecycleCheckpoint({ sequence: window.next_after_sequence,event_hash: window.next_prior_event_hash });
          if (canonicalize(retained) !== canonicalize(committed)) throw fail('TELEMETRY_CHECKPOINT_DRIFT');
        }
        if (this.#config.metrics) for (const event of events) {
          if (!await replayMetricSource(client,this.#config,event,'lifecycle')) throw fail('TELEMETRY_METRIC_DRIFT');
        }
        return Object.freeze({ batch_hash: batchHash,persisted: true,projected: events.length,sweep: current });
      }
      if (canonicalize(current) !== canonicalize(expected)) throw fail('TELEMETRY_CHECKPOINT_CONFLICT');
      const prior = ref === null ? null : await this.#readCheckpoint(client,scope,invocationHash);
      if (canonicalize(prior) !== canonicalize(checkpoint)) throw fail('TELEMETRY_CHECKPOINT_CONFLICT');
      const newPrefix = ref !== null && prior === null;
      const l = this.#config.limits;
      if (newPrefix) {
        const count = await client.query(`SELECT count(*)::integer AS total,count(*) FILTER (WHERE tenant_hash=$1)::integer AS tenant FROM ${s}.telemetry_lifecycle_checkpoints`,[scope.tenant_hash]);
        if (count.rows[0].total >= l.maxEvents || count.rows[0].tenant >= l.maxEventsPerTenant) throw fail('TELEMETRY_CAPACITY');
      }
      if (current === null) {
        const count = await client.query(`SELECT count(*)::integer AS total FROM ${s}.telemetry_lifecycle_sweeps`);
        if (count.rows[0].total >= l.maxEvents) throw fail('TELEMETRY_CAPACITY');
      }
      for (const event of events) {
        checkTelemetrySignal(options.signal);
        const hash = sha256Ref(event);
        const existing = await client.query(`SELECT ${LIFECYCLE_FIELDS} FROM ${s}.telemetry_lifecycle_events WHERE event_ref=$1`,[event.event_ref]);
        const replay = await replayMetricSource(client,this.#config,event,'lifecycle');
        if (existing.rowCount) {
          if (existing.rowCount !== 1 || existing.rows[0].event_hash !== hash) throw fail('TELEMETRY_EVENT_CONFLICT');
          readEvent(existing.rows[0],'lifecycle');
          if (this.#config.metrics && !replay) throw fail('TELEMETRY_METRIC_DRIFT');
          continue;
        }
        if (replay) continue;
        const count = await client.query(`SELECT count(*)::integer AS total,count(*) FILTER (WHERE tenant_hash=$1)::integer AS tenant FROM ${s}.telemetry_lifecycle_events`,[scope.tenant_hash]);
        if (count.rows[0].total >= l.maxEvents || count.rows[0].tenant >= l.maxEventsPerTenant) throw fail('TELEMETRY_CAPACITY');
        await client.query(`INSERT INTO ${s}.telemetry_lifecycle_events (${LIFECYCLE_FIELDS}) VALUES ($1,$2,$3,$4,$5,$6,$7)`,
          [event.event_ref,hash,event.tenant_hash,event.invocation_hash,event.source_sequence,event,now]);
        await recordMetricSource(client,this.#config,event,'lifecycle',now);
      }
      checkTelemetrySignal(options.signal);
      // Append-before-checkpoint ordering is one transaction, not two commits.
      if (ref !== null) {
        const next = lifecycleCheckpoint({ sequence: window.next_after_sequence,event_hash: window.next_prior_event_hash });
        const hash = lifecycleStateHash(scope,{ invocation_hash: invocationHash,...next });
        if (newPrefix) await client.query(`INSERT INTO ${s}.telemetry_lifecycle_checkpoints VALUES ($1,$2,$3,$4,$5,$6)`,
          [scope.observer_hash,scope.tenant_hash,invocationHash,next.sequence,next.event_hash,hash]);
        else await client.query(`UPDATE ${s}.telemetry_lifecycle_checkpoints SET sequence=$4,event_hash=$5,checkpoint_hash=$6
          WHERE observer_hash=$1 AND tenant_hash=$2 AND invocation_hash=$3`,[scope.observer_hash,scope.tenant_hash,invocationHash,next.sequence,next.event_hash,hash]);
      }
      const nextSweep = lifecycleSweep({ version: (current?.version ?? 0)+1,cycle: (current?.cycle ?? 0)+(page.complete ? 1 : 0),
        after_ref: page.complete ? null : page.next_after_ref,upper_ref: page.complete ? null : page.upper_ref,
        prefix_count: (current?.prefix_count ?? 0)+(newPrefix ? 1 : 0),last_batch_hash: batchHash });
      const hash = lifecycleStateHash(scope,nextSweep);
      if (current === null) await client.query(`INSERT INTO ${s}.telemetry_lifecycle_sweeps VALUES ($1,$2,$3,$4)`,[scope.observer_hash,scope.tenant_hash,nextSweep,hash]);
      else await client.query(`UPDATE ${s}.telemetry_lifecycle_sweeps SET payload=$3,state_hash=$4 WHERE observer_hash=$1 AND tenant_hash=$2`,
        [scope.observer_hash,scope.tenant_hash,nextSweep,hash]);
      return Object.freeze({ batch_hash: batchHash,persisted: true,projected: events.length,sweep: nextSweep });
    });
  }
  async readMetrics(options) {
    if (!this.#config.metrics) throw new TypeError('Metric v3 must be explicitly selected');
    input(options,['tenant_hash','signal']); const tenant = requireSha256(options.tenant_hash,'tenant_hash');
    return this.#transaction(options.signal,async (client) => {
      const s = this.#config.quotedSchema;
      const rows = await client.query(`SELECT tenant_hash,rule_id,window_start_ms,payload,state_hash FROM ${s}.telemetry_metric_windows
        WHERE tenant_hash=$1 ORDER BY window_start_ms DESC,rule_id COLLATE "C" LIMIT 65`,[tenant]);
      const counts = await client.query(`SELECT count(*)::integer AS retained_sources,count(*) FILTER (WHERE (payload->>'legacy_uncounted')::boolean)::integer AS legacy_uncounted
        FROM ${s}.telemetry_metric_sources WHERE tenant_hash=$1`,[tenant]);
      if (counts.rowCount !== 1 || !Number.isInteger(counts.rows[0].retained_sources) || !Number.isInteger(counts.rows[0].legacy_uncounted)) throw fail('TELEMETRY_METRIC_DRIFT');
      return Object.freeze({ windows: Object.freeze(rows.rows.slice(0,64).map((row) => readMetricWindow(row,this.#config.metricSettings))),
        truncated: rows.rows.length > 64,...counts.rows[0],coverage: 'ingested_observations_only',production_qualified: false });
    });
  }
  async close() { if (this.#closed) return; this.#closed = true; if (this.#ownsPool) await this.#pool.end(); }
}

export const createPostgresManagedTelemetryStore = (options) => PostgresManagedTelemetryStore.create(options);
