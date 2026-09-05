import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import {
  acquirePostgresAuthorityClient,
  createPostgresAuthorityPool,
  quotePostgresAuthorityIdentifier,
} from '../../src/adapters/postgres-authority-migrator.mjs';
import { sha256Ref } from '../../src/canonical.mjs';
import { validateChildOperation } from '../../src/child-operation.mjs';
import { createManagedAuditEvent } from './audit.mjs';
import {
  ACTIVE_INVOCATION_STATES,
  INVOCATION_STATES,
  MANAGED_API_KEY_SCHEMA,
  MANAGED_AUDIT_EVENT_SCHEMA,
  MANAGED_INVOCATION_SCHEMA,
  MANAGED_RESOURCE_JOURNAL_RECEIPT_SCHEMA,
  MANAGED_SERVICE_PROTOCOL_LIMITS,
  TERMINAL_INVOCATION_STATES,
} from './constants.mjs';
import {
  assertAllowedKeys,
  assertDataArray,
  assertExecutionWithinBudgetDay,
  assertPlainRecord,
  cloneJson,
  deepFreeze,
  managedError,
  requireEnum,
  requireInteger,
  requireInvocationRef,
  requireIso,
  requireOpaqueRef,
  requireProviderId,
  requireSha256,
  requireTenantId,
  utcDay,
} from './validation.mjs';
import {
  assertManagedRecoveryKeyIntegrity,
  createManagedResourceJournalReceipt,
  managedClientRequestHash,
  normalizeManagedResourceJournalReceipt,
} from './invocation-integrity.mjs';

const trustedCaPinnedPools = new WeakSet();
const managedOwnedPools = new WeakSet();
const REQUIRED_TABLES = Object.freeze([
  'managed_schema_migrations',
  'managed_tenants',
  'managed_api_keys',
  'managed_usage_buckets',
  'managed_invocations',
  'managed_lease_token_uses',
  'managed_resource_journal_receipts',
  'managed_audit_events',
]);
const REQUIRED_AUDIT_TRIGGERS = Object.freeze([
  'managed_audit_events_no_update',
  'managed_audit_events_no_delete',
]);
const RESOURCE_JOURNAL_EVENT_TYPES = new Set([
  'provider_resource_journaled',
  'provider_resources_recorded',
  'provider_resources_recovered',
]);
let expectedMigrationHashPromise;

function expectedMigrationHash() {
  expectedMigrationHashPromise ??= readFile(
    new URL('../migrations/001_managed_control_plane.pg.sql', import.meta.url),
    'utf8',
  ).then((source) => sha256Ref(source.replace(/\r\n?/g, '\n')));
  return expectedMigrationHashPromise;
}

function pgInteger(value, label) {
  if (typeof value !== 'number'
    && (typeof value !== 'string' || !/^(?:0|[1-9]\d*)$/.test(value))) {
    throw new TypeError(`${label} must be a canonical non-negative integer`);
  }
  const parsed = typeof value === 'number' ? value : Number(value);
  return requireInteger(parsed, label, { min: 0, max: Number.MAX_SAFE_INTEGER });
}

function pgIso(value, label) {
  return requireIso(value, label);
}

function pgDay(value, label) {
  let day;
  if (value && typeof value === 'object') {
    day = requireIso(value, label).slice(0, 10);
  } else if (typeof value === 'string') {
    day = value.slice(0, 10);
  } else {
    throw new TypeError(`${label} is invalid`);
  }
  const midnight = `${day}T00:00:00.000Z`;
  const millis = Date.parse(midnight);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day)
    || !Number.isFinite(millis)
    || new Date(millis).toISOString() !== midnight) {
    throw new TypeError(`${label} is invalid`);
  }
  return day;
}

function normalizeInvocationRow(row, includeOperation = false) {
  if (!row) return null;
  assertPlainRecord(row, 'PostgreSQL invocation row');
  const estimatedCostMicros = pgInteger(row.estimated_cost_micros, 'estimated_cost_micros');
  const actualCostMicros = row.actual_cost_micros == null
    ? null
    : pgInteger(row.actual_cost_micros, 'actual_cost_micros');
  if (actualCostMicros !== null && actualCostMicros > estimatedCostMicros) {
    throw new TypeError('actual_cost_micros exceeds estimated_cost_micros');
  }
  const state = requireEnum(row.state, INVOCATION_STATES, 'state');
  const leaseKind = row.lease_kind == null
    ? null
    : requireEnum(row.lease_kind, ['execution', 'cleanup', 'recovery'], 'lease_kind');
  const leaseOwner = row.lease_owner == null
    ? null
    : requireOpaqueRef(row.lease_owner, 'lease_owner');
  const leaseTokenHash = row.lease_token_hash == null
    ? null
    : requireSha256(row.lease_token_hash, 'lease_token_hash');
  const leaseExpiresAt = row.lease_expires_at == null
    ? null
    : pgIso(row.lease_expires_at, 'lease_expires_at');
  if ([leaseOwner, leaseTokenHash, leaseExpiresAt].some((value) => (value === null) !== (leaseKind === null))) {
    throw new TypeError('stored lease fields are inconsistent');
  }
  const cleanupRequests = cloneJson(row.cleanup_requests ?? [], 'cleanup_requests');
  assertDataArray(cleanupRequests, 'cleanup_requests', { maxLength: 2 });
  const terminalAt = row.terminal_at == null ? null : pgIso(row.terminal_at, 'terminal_at');
  if ((terminalAt !== null) !== TERMINAL_INVOCATION_STATES.includes(state)) {
    throw new TypeError('stored terminal state is inconsistent');
  }
  const invocation = {
    schema: MANAGED_INVOCATION_SCHEMA,
    invocation_ref: requireInvocationRef(row.invocation_ref, 'invocation_ref'),
    tenant_id: requireTenantId(row.tenant_id),
    admitted_key_id: requireOpaqueRef(row.admitted_key_id, 'admitted_key_id'),
    provider_id: requireProviderId(row.provider_id),
    provider_binding_hash: requireSha256(row.provider_binding_hash, 'provider_binding_hash'),
    provider_adapter_digest: requireSha256(row.provider_adapter_digest, 'provider_adapter_digest'),
    provider_qualification_receipt_hash: requireSha256(
      row.provider_qualification_receipt_hash,
      'provider_qualification_receipt_hash',
    ),
    idempotency_hash: requireSha256(row.idempotency_hash, 'idempotency_hash'),
    request_hash: requireSha256(row.request_hash, 'request_hash'),
    operation_hash: requireSha256(row.operation_hash, 'operation_hash'),
    estimated_cost_micros: estimatedCostMicros,
    actual_cost_micros: actualCostMicros,
    budget_day_utc: pgDay(row.budget_day_utc, 'budget_day_utc'),
    state,
    lease_kind: leaseKind,
    lease_owner: leaseOwner,
    lease_expires_at: leaseExpiresAt,
    lease_generation: pgInteger(row.lease_generation, 'lease_generation'),
    savepoint_ref: row.savepoint_ref == null ? null : requireOpaqueRef(row.savepoint_ref, 'savepoint_ref'),
    fork_ref: row.fork_ref == null ? null : requireOpaqueRef(row.fork_ref, 'fork_ref'),
    cleanup_requests: cleanupRequests,
    provider_recovery_key: requireSha256(row.provider_recovery_key, 'provider_recovery_key'),
    execution_outcome: row.execution_outcome == null
      ? null
      : requireEnum(row.execution_outcome, ['succeeded', 'failed', 'ambiguous'], 'execution_outcome'),
    execution_evidence_hash: row.execution_evidence_hash == null
      ? null
      : requireSha256(row.execution_evidence_hash, 'execution_evidence_hash'),
    result_hash: row.result_hash == null ? null : requireSha256(row.result_hash, 'result_hash'),
    admitted_at: pgIso(row.admitted_at, 'admitted_at'),
    updated_at: pgIso(row.updated_at, 'updated_at'),
    terminal_at: terminalAt,
    audit_head_hash: row.audit_head_hash == null
      ? null
      : requireSha256(row.audit_head_hash, 'audit_head_hash'),
    audit_event_count: pgInteger(row.audit_event_count, 'audit_event_count'),
  };
  assertManagedRecoveryKeyIntegrity(invocation);
  if (includeOperation) {
    const operation = validateChildOperation(cloneJson(row.operation_json, 'stored operation'));
    if (sha256Ref(operation) !== requireSha256(invocation.operation_hash, 'operation_hash')) {
      throw managedError('Stored operation integrity check failed', 'OPERATION_INTEGRITY_FAILED', 503);
    }
    const expectedRequestHash = managedClientRequestHash({
      providerId: invocation.provider_id,
      operation,
      estimatedCostMicros: invocation.estimated_cost_micros,
    });
    if (expectedRequestHash !== requireSha256(invocation.request_hash, 'request_hash')) {
      throw managedError('Stored request integrity check failed', 'REQUEST_INTEGRITY_FAILED', 503);
    }
    invocation.operation = operation;
  }
  return deepFreeze(invocation);
}

function normalizeAuditRows(rows) {
  return rows.map((row) => ({
    schema: MANAGED_AUDIT_EVENT_SCHEMA,
    event_ref: row.event_ref,
    tenant_id: row.tenant_id,
    invocation_ref: row.invocation_ref,
    sequence: pgInteger(row.sequence, 'audit sequence'),
    event_type: row.event_type,
    occurred_at: pgIso(row.occurred_at, 'audit occurred_at'),
    details_hash: row.details_hash,
    prior_event_hash: row.prior_event_hash,
    evidence_class: row.evidence_class,
    event_hash: row.event_hash,
  }));
}

function normalizeResourceJournalReceiptRow(row) {
  if (!row) return null;
  return normalizeManagedResourceJournalReceipt({
    schema: MANAGED_RESOURCE_JOURNAL_RECEIPT_SCHEMA,
    tenant_id: row.tenant_id,
    invocation_ref: row.invocation_ref,
    request_hash: row.request_hash,
    claimant_key_id: row.claimant_key_id,
    lease_token_hash: row.lease_token_hash,
    response: row.response_json,
    response_hash: row.response_hash,
    created_at: pgIso(row.created_at, 'resource journal receipt created_at'),
  });
}

function requireMatchingResourceJournalReceipt(row, expected) {
  const receipt = normalizeResourceJournalReceiptRow(row);
  if (receipt === null) return null;
  if (receipt.tenant_id !== expected.tenantId
    || receipt.invocation_ref !== expected.invocationRef
    || receipt.request_hash !== expected.requestHash
    || receipt.claimant_key_id !== expected.claimantKeyId
    || receipt.lease_token_hash !== expected.leaseTokenHash) {
    throw managedError(
      'Resource journal receipt metadata is inconsistent',
      'RESOURCE_JOURNAL_RECEIPT_INTEGRITY_FAILED',
      503,
    );
  }
  return receipt;
}

export class PostgresManagedServiceStore {
  #pool;
  #schema;
  #requireTls;
  #verifiedClients = new WeakSet();
  #eventRef;
  #schemaName;
  #maxClockSkewMs;
  #closed = false;

  constructor({
    pool,
    schemaName = 'risk_fork_managed',
    requireTls = true,
    maxClockSkewMs = 5_000,
    eventRef = () => `evt_${randomUUID()}`,
  } = {}) {
    if (!pool || typeof pool.connect !== 'function') {
      throw new TypeError('PostgreSQL managed store requires pool.connect()');
    }
    if (typeof requireTls !== 'boolean') throw new TypeError('requireTls must be a boolean');
    if (requireTls && !trustedCaPinnedPools.has(pool)) {
      throw managedError(
        'A supplied pool cannot establish CA-pinned transport provenance',
        'MANAGED_POSTGRES_TLS_POOL_UNTRUSTED',
        503,
      );
    }
    if (typeof eventRef !== 'function') throw new TypeError('eventRef must be a function');
    this.#maxClockSkewMs = requireInteger(maxClockSkewMs, 'maxClockSkewMs', {
      min: 0,
      max: 60_000,
    });
    this.#pool = pool;
    this.#schema = quotePostgresAuthorityIdentifier(
      schemaName,
      'managed PostgreSQL schema name',
    );
    this.#schemaName = schemaName;
    this.#requireTls = requireTls;
    this.#eventRef = eventRef;
  }

  async #withClient(callback) {
    if (this.#closed) throw managedError('PostgreSQL store is closed', 'MANAGED_STORE_CLOSED', 503);
    const client = await acquirePostgresAuthorityClient(this.#pool, {
      requireTls: this.#requireTls,
      verifiedClients: this.#verifiedClients,
    });
    try {
      return await callback(client);
    } finally {
      client.release();
    }
  }

  async #withTransaction(callback, assertedNowValue) {
    for (let attempt = 1; attempt <= 3; attempt += 1) {
      try {
        return await this.#withClient(async (client) => {
          await client.query('BEGIN ISOLATION LEVEL SERIALIZABLE');
          try {
            await client.query('SET LOCAL synchronous_commit = on');
            if (assertedNowValue !== undefined && attempt === 1) {
              await this.#databaseNow(client, assertedNowValue);
            }
            const result = await callback(client);
            await client.query('COMMIT');
            return result;
          } catch (error) {
            await client.query('ROLLBACK').catch(() => {});
            throw error;
          }
        });
      } catch (error) {
        const retryable = error?.code === '40001'
          || error?.code === '40P01'
          || (error?.code === '23505'
            && [
              'managed_invocations_tenant_id_idempotency_hash_key',
              'managed_resource_journal_receipts_pkey',
            ].includes(error?.constraint));
        if (!retryable || attempt === 3) throw error;
      }
    }
    throw new Error('PostgreSQL transaction retry invariant failed');
  }

  async #withReadSnapshot(callback) {
    return this.#withClient(async (client) => {
      await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
      try {
        const result = await callback(client);
        await client.query('COMMIT');
        return result;
      } catch (error) {
        await client.query('ROLLBACK').catch(() => {});
        throw error;
      }
    });
  }

  async #selectInvocation(client, tenantId, invocationRef, lock = false) {
    const result = await client.query(
      `SELECT * FROM ${this.#schema}.managed_invocations
        WHERE tenant_id = $1 AND invocation_ref = $2${lock ? ' FOR UPDATE' : ''}`,
      [tenantId, invocationRef],
    );
    return result.rowCount === 1 ? result.rows[0] : null;
  }

  async #selectResourceJournalReceipt(client, tenantId, invocationRef, requestHash) {
    const result = await client.query(
      `SELECT tenant_id, invocation_ref, request_hash, claimant_key_id,
              lease_token_hash, response_json, response_hash, created_at
         FROM ${this.#schema}.managed_resource_journal_receipts
        WHERE tenant_id = $1 AND invocation_ref = $2 AND request_hash = $3`,
      [tenantId, invocationRef, requestHash],
    );
    return result.rowCount === 1 ? result.rows[0] : null;
  }

  async #databaseNow(client, assertedNowValue) {
    const result = await client.query('SELECT clock_timestamp() AS managed_now');
    if (result.rowCount !== 1) throw new Error('PostgreSQL clock query failed');
    const databaseNow = pgIso(result.rows[0].managed_now, 'PostgreSQL managed clock');
    if (assertedNowValue !== undefined) {
      const assertedNow = requireIso(assertedNowValue, 'caller clock');
      if (Math.abs(Date.parse(assertedNow) - Date.parse(databaseNow)) > this.#maxClockSkewMs) {
        throw managedError(
          'Caller clock differs from the PostgreSQL authority clock',
          'MANAGED_CLOCK_SKEW_EXCEEDED',
          503,
        );
      }
    }
    return databaseNow;
  }

  async #lockTenantStatus(client, tenantId) {
    const result = await client.query(
      `SELECT status FROM ${this.#schema}.managed_tenants WHERE tenant_id = $1 FOR SHARE`,
      [tenantId],
    );
    return result.rowCount === 1 ? result.rows[0].status : null;
  }

  #assertExecutionAllowed(status, leaseKind) {
    if (leaseKind === 'execution' && status !== 'active') {
      throw managedError('Tenant suspended execution authority', 'TENANT_NOT_ACTIVE', 403);
    }
  }

  #assertLeaseOwner(row, claimantKeyId) {
    const leaseOwner = row.lease_owner == null
      ? null
      : requireOpaqueRef(row.lease_owner, 'lease_owner');
    if (leaseOwner !== claimantKeyId) {
      throw managedError('Lease belongs to a different credential', 'LEASE_OWNER_MISMATCH', 403);
    }
  }

  async #isClaimantCredentialActive(client, tenantId, claimantKeyId) {
    const result = await client.query(
      `SELECT EXISTS (
         SELECT 1 FROM ${this.#schema}.managed_api_keys AS claimant
          WHERE claimant.key_id = $2 AND claimant.tenant_id = $1
            AND claimant.revoked_at IS NULL
            AND claimant.not_before <= clock_timestamp()
            AND claimant.expires_at > clock_timestamp()
       ) AS active`,
      [tenantId, claimantKeyId],
    );
    return result.rowCount === 1 && result.rows[0]?.active === true;
  }

  async #assertClaimantCredentialActive(client, tenantId, claimantKeyId) {
    if (!await this.#isClaimantCredentialActive(client, tenantId, claimantKeyId)) {
      throw managedError('Claimant credential is not active', 'AUTHENTICATION_FAILED', 401);
    }
  }

  async #appendAudit(client, row, eventType, occurredAt, details = {}) {
    const event = createManagedAuditEvent({
      event_ref: requireOpaqueRef(this.#eventRef(), 'event reference'),
      tenant_id: row.tenant_id,
      invocation_ref: row.invocation_ref,
      sequence: pgInteger(row.audit_event_count, 'audit_event_count') + 1,
      event_type: eventType,
      occurred_at: occurredAt,
      details,
      prior_event_hash: row.audit_head_hash,
    });
    const inserted = await client.query(
      `INSERT INTO ${this.#schema}.managed_audit_events (
         tenant_id, invocation_ref, sequence, event_ref, event_type, occurred_at,
         details_hash, prior_event_hash, event_hash, evidence_class
       )
       SELECT $1,$2,$3,$4,$5,$6,$7,$8,$9,$10
        WHERE (
          $3 = 1
          AND $8::text IS NULL
          AND NOT EXISTS (
            SELECT 1 FROM ${this.#schema}.managed_audit_events
             WHERE tenant_id = $1 AND invocation_ref = $2
          )
        ) OR EXISTS (
          SELECT 1 FROM ${this.#schema}.managed_audit_events AS prior
           WHERE prior.tenant_id = $1 AND prior.invocation_ref = $2
             AND prior.sequence = $3 - 1
             AND prior.event_hash = $8
             AND prior.occurred_at <= $6::timestamptz
        )`,
      [
        event.tenant_id,
        event.invocation_ref,
        event.sequence,
        event.event_ref,
        event.event_type,
        event.occurred_at,
        event.details_hash,
        event.prior_event_hash,
        event.event_hash,
        event.evidence_class,
      ],
    );
    if (inserted.rowCount !== 1) {
      throw managedError(
        'Managed audit append precondition failed',
        'AUDIT_APPEND_CONFLICT',
        503,
      );
    }
    const anchored = await client.query(
      `UPDATE ${this.#schema}.managed_invocations
          SET audit_head_hash = $3, audit_event_count = $4
        WHERE tenant_id = $1 AND invocation_ref = $2`,
      [row.tenant_id, row.invocation_ref, event.event_hash, event.sequence],
    );
    if (anchored.rowCount !== 1) {
      throw managedError(
        'Managed audit anchor update precondition failed',
        'AUDIT_ANCHOR_CONFLICT',
        503,
      );
    }
    row.audit_head_hash = event.event_hash;
    row.audit_event_count = event.sequence;
  }

  async resolveCredential(keyHashValue) {
    const keyHash = requireSha256(keyHashValue, 'credential key hash');
    return this.#withClient(async (client) => {
      const result = await client.query(
        `SELECT key_id, tenant_id, key_hash, scopes, not_before, expires_at, revoked_at
           FROM ${this.#schema}.managed_api_keys
          WHERE key_hash = $1
            AND revoked_at IS NULL
            AND not_before <= clock_timestamp()
            AND expires_at > clock_timestamp()`,
        [keyHash],
      );
      if (result.rowCount !== 1) return null;
      const row = result.rows[0];
      return deepFreeze({
        schema: MANAGED_API_KEY_SCHEMA,
        key_id: row.key_id,
        tenant_id: row.tenant_id,
        key_hash: row.key_hash,
        scopes: cloneJson(row.scopes, 'credential scopes'),
        not_before: pgIso(row.not_before, 'credential not_before'),
        expires_at: pgIso(row.expires_at, 'credential expires_at'),
        revoked_at: row.revoked_at == null ? null : pgIso(row.revoked_at, 'credential revoked_at'),
      });
    });
  }

  async findIdempotentInvocation(input) {
    assertPlainRecord(input, 'idempotency lookup');
    assertAllowedKeys(
      input,
      ['tenant_id', 'idempotency_hash', 'request_hash'],
      'idempotency lookup',
    );
    const tenantId = requireTenantId(input.tenant_id);
    const idempotencyHash = requireSha256(input.idempotency_hash, 'idempotency_hash');
    const requestHash = requireSha256(input.request_hash, 'request_hash');
    return this.#withClient(async (client) => {
      const result = await client.query(
        `SELECT * FROM ${this.#schema}.managed_invocations
          WHERE tenant_id = $1 AND idempotency_hash = $2`,
        [tenantId, idempotencyHash],
      );
      if (result.rowCount === 0) return null;
      const existing = result.rows[0];
      if (existing.request_hash !== requestHash) {
        throw managedError(
          'Idempotency key was already used for a different request',
          'IDEMPOTENCY_CONFLICT',
          409,
        );
      }
      return deepFreeze({ created: false, invocation: normalizeInvocationRow(existing) });
    });
  }

  async findResourceJournalReceipt(input) {
    assertPlainRecord(input, 'resource journal receipt lookup');
    assertAllowedKeys(input, [
      'tenant_id',
      'invocation_ref',
      'request_hash',
      'claimant_key_id',
      'lease_token_hash',
      'now',
    ], 'resource journal receipt lookup');
    const tenantId = requireTenantId(input.tenant_id);
    const invocationRef = requireInvocationRef(input.invocation_ref, 'invocation_ref');
    const requestHash = requireSha256(input.request_hash, 'resource journal request_hash');
    const claimantKeyId = requireOpaqueRef(input.claimant_key_id, 'claimant_key_id');
    const leaseTokenHash = requireSha256(input.lease_token_hash, 'lease_token_hash');
    return this.#withClient(async (client) => {
      await this.#databaseNow(client, input.now);
      await this.#assertClaimantCredentialActive(client, tenantId, claimantKeyId);
      return requireMatchingResourceJournalReceipt(
        await this.#selectResourceJournalReceipt(
          client,
          tenantId,
          invocationRef,
          requestHash,
        ),
        { tenantId, invocationRef, requestHash, claimantKeyId, leaseTokenHash },
      );
    });
  }

  async admitInvocation(input) {
    try {
      return await this.#withTransaction(async (client) => {
      const tenantId = requireTenantId(input.tenant_id);
      const invocationRef = requireInvocationRef(input.invocation_ref, 'invocation_ref');
      const existingResult = await client.query(
        `SELECT * FROM ${this.#schema}.managed_invocations
          WHERE tenant_id = $1 AND idempotency_hash = $2
          FOR UPDATE`,
        [tenantId, requireSha256(input.idempotency_hash, 'idempotency_hash')],
      );
      if (existingResult.rowCount === 1) {
        const existing = existingResult.rows[0];
        if (existing.request_hash !== input.request_hash) {
          throw managedError(
            'Idempotency key was already used for a different request',
            'IDEMPOTENCY_CONFLICT',
            409,
          );
        }
        return deepFreeze({ created: false, invocation: normalizeInvocationRow(existing) });
      }
      const tenantResult = await client.query(
        `SELECT * FROM ${this.#schema}.managed_tenants
          WHERE tenant_id = $1 FOR UPDATE`,
        [tenantId],
      );
      const tenant = tenantResult.rowCount === 1 ? tenantResult.rows[0] : null;
      if (!tenant || tenant.status !== 'active') {
        throw managedError('Tenant is not active', 'TENANT_NOT_ACTIVE', 403);
      }
      const now = await this.#databaseNow(client);
      const recovery = await client.query(
        `SELECT 1 FROM ${this.#schema}.managed_invocations
          WHERE tenant_id = $1 AND state = 'recovery_required' LIMIT 1`,
        [tenantId],
      );
      if (recovery.rowCount !== 0) {
        throw managedError(
          'Tenant has unresolved provider recovery work',
          'TENANT_RECOVERY_REQUIRED',
          503,
        );
      }
      const expiredExecution = await client.query(
        `SELECT 1 FROM ${this.#schema}.managed_invocations
          WHERE tenant_id = $1
            AND lease_kind = 'execution'
            AND lease_expires_at <= $2::timestamptz
          LIMIT 1`,
        [tenantId, now],
      );
      if (expiredExecution.rowCount !== 0) {
        throw managedError(
          'Tenant has an expired execution requiring reconciliation',
          'TENANT_RECONCILIATION_REQUIRED',
          503,
        );
      }
      const estimated = requireInteger(input.estimated_cost_micros, 'estimated_cost_micros', {
        min: 0,
        max: Number.MAX_SAFE_INTEGER,
      });
      const invocationCap = Math.min(
        input.limits.max_invocation_cost_micros,
        pgInteger(tenant.max_invocation_cost_micros, 'tenant max invocation cost'),
      );
      if (estimated > invocationCap) {
        throw managedError('Invocation cost cap exceeded', 'INVOCATION_BUDGET_EXCEEDED', 429);
      }
      const active = await client.query(
        `SELECT count(*)::integer AS active_count
           FROM ${this.#schema}.managed_invocations
          WHERE tenant_id = $1 AND state = ANY($2::text[])`,
        [tenantId, ACTIVE_INVOCATION_STATES],
      );
      const concurrentCap = Math.min(
        input.limits.max_concurrent_invocations,
        pgInteger(tenant.max_concurrent_invocations, 'tenant max concurrent invocations'),
      );
      if (pgInteger(active.rows[0].active_count, 'active invocation count') >= concurrentCap) {
        throw managedError('Tenant concurrency quota exceeded', 'CONCURRENCY_QUOTA_EXCEEDED', 429);
      }
      const day = utcDay(now);
      await client.query(
        `INSERT INTO ${this.#schema}.managed_usage_buckets
           (tenant_id, budget_day_utc, reserved_micros, spent_micros, updated_at)
         VALUES ($1, $2::date, 0, 0, $3)
         ON CONFLICT (tenant_id, budget_day_utc) DO NOTHING`,
        [tenantId, day, now],
      );
      const usageResult = await client.query(
        `SELECT * FROM ${this.#schema}.managed_usage_buckets
          WHERE tenant_id = $1 AND budget_day_utc = $2::date FOR UPDATE`,
        [tenantId, day],
      );
      const usage = usageResult.rows[0];
      const dailyCap = Math.min(
        input.limits.daily_budget_micros,
        pgInteger(tenant.daily_budget_micros, 'tenant daily budget'),
      );
      const projected = pgInteger(usage.reserved_micros, 'reserved budget')
        + pgInteger(usage.spent_micros, 'spent budget')
        + estimated;
      if (projected > dailyCap) {
        throw managedError('Tenant daily budget exceeded', 'DAILY_BUDGET_EXCEEDED', 429);
      }
      await client.query(
        `UPDATE ${this.#schema}.managed_usage_buckets
            SET reserved_micros = reserved_micros + $3, updated_at = $4
          WHERE tenant_id = $1 AND budget_day_utc = $2::date`,
        [tenantId, day, estimated, now],
      );
      const inserted = await client.query(
        `INSERT INTO ${this.#schema}.managed_invocations (
           tenant_id, invocation_ref, admitted_key_id, provider_id,
           provider_binding_hash, provider_adapter_digest,
           provider_qualification_receipt_hash,
           idempotency_hash, request_hash, operation_hash, operation_json,
           estimated_cost_micros, budget_day_utc, provider_recovery_key,
           state, admitted_at, updated_at
         ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11::jsonb,$12,$13::date,$14,'admitted',$15,$15)
         RETURNING *`,
        [
          tenantId,
          invocationRef,
          input.key_id,
          input.provider_id,
          input.provider_binding_hash,
          input.provider_adapter_digest,
          input.provider_qualification_receipt_hash,
          input.idempotency_hash,
          input.request_hash,
          input.operation_hash,
          JSON.stringify(input.operation),
          estimated,
          day,
          input.provider_recovery_key,
          now,
        ],
      );
      const row = inserted.rows[0];
      await this.#appendAudit(client, row, 'invocation_admitted', now, {
        request_hash: input.request_hash,
        operation_hash: input.operation_hash,
        provider_id: input.provider_id,
        provider_binding_hash: input.provider_binding_hash,
        provider_adapter_digest: input.provider_adapter_digest,
        provider_qualification_receipt_hash: input.provider_qualification_receipt_hash,
        estimated_cost_micros: estimated,
      });
        return deepFreeze({ created: true, invocation: normalizeInvocationRow(row) });
      }, input.now);
    } catch (error) {
      if (error?.code === '23505' && error?.constraint === 'managed_invocations_pkey') {
        throw managedError(
          'Generated invocation reference is already in use',
          'INVOCATION_REFERENCE_CONFLICT',
          503,
        );
      }
      throw error;
    }
  }

  async getInvocation(tenantIdValue, invocationRefValue, { includeOperation = false } = {}) {
    const tenantId = requireTenantId(tenantIdValue);
    const invocationRef = requireInvocationRef(invocationRefValue, 'invocation_ref');
    return this.#withClient(async (client) => normalizeInvocationRow(
      await this.#selectInvocation(client, tenantId, invocationRef, false),
      includeOperation,
    ));
  }

  async assertActiveLease(input) {
    assertPlainRecord(input, 'lease preflight');
    assertAllowedKeys(input, [
      'tenant_id',
      'claimant_key_id',
      'invocation_ref',
      'lease_token_hash',
      'lease_kind',
      'expected_states',
      'now',
    ], 'lease preflight');
    const tenantId = requireTenantId(input.tenant_id);
    const claimantKeyId = requireOpaqueRef(input.claimant_key_id, 'claimant_key_id');
    const invocationRef = requireInvocationRef(input.invocation_ref, 'invocation_ref');
    const tokenHash = requireSha256(input.lease_token_hash, 'lease_token_hash');
    const leaseKind = input.lease_kind;
    if (!['execution', 'cleanup', 'recovery'].includes(leaseKind)) {
      throw new TypeError('lease_kind must be execution, cleanup, or recovery');
    }
    assertDataArray(input.expected_states, 'expected lease states', { maxLength: 4 });
    if (input.expected_states.length === 0
      || input.expected_states.some((state) => !INVOCATION_STATES.includes(state))) {
      throw new TypeError('expected lease states are invalid');
    }
    const expectedStates = [...input.expected_states];
    return this.#withClient(async (client) => {
      await this.#databaseNow(client, input.now);
      const result = await client.query(
        `SELECT invocation_row.*, tenant_row.status AS tenant_status,
                clock_timestamp() AS preflight_now,
                EXISTS (
                  SELECT 1 FROM ${this.#schema}.managed_api_keys AS claimant
                   WHERE claimant.key_id = $3
                     AND claimant.tenant_id = invocation_row.tenant_id
                     AND claimant.revoked_at IS NULL
                     AND claimant.not_before <= clock_timestamp()
                     AND claimant.expires_at > clock_timestamp()
                ) AS claimant_active
           FROM ${this.#schema}.managed_invocations invocation_row
           JOIN ${this.#schema}.managed_tenants tenant_row
             ON tenant_row.tenant_id = invocation_row.tenant_id
          WHERE invocation_row.tenant_id = $1 AND invocation_row.invocation_ref = $2`,
        [tenantId, invocationRef, claimantKeyId],
      );
      if (result.rowCount !== 1) {
        throw managedError('Invocation was not found', 'INVOCATION_NOT_FOUND', 404);
      }
      const row = result.rows[0];
      if (row.lease_token_hash !== tokenHash) {
        throw managedError('Lease token is invalid', 'LEASE_TOKEN_INVALID', 403);
      }
      this.#assertLeaseOwner(row, claimantKeyId);
      if (row.claimant_active !== true) {
        throw managedError('Claimant credential is not active', 'AUTHENTICATION_FAILED', 401);
      }
      if (row.lease_kind !== leaseKind) {
        throw managedError('Lease kind is invalid', 'LEASE_PREFLIGHT_FAILED', 409);
      }
      if (!expectedStates.includes(row.state)) {
        throw managedError('Invocation state changed', 'INVOCATION_STATE_CONFLICT', 409);
      }
      const now = pgIso(row.preflight_now, 'lease preflight database clock');
      if (!row.lease_expires_at
        || Date.parse(pgIso(row.lease_expires_at, 'lease expiry')) <= Date.parse(now)) {
        throw managedError('Lease has expired', 'LEASE_EXPIRED', 409);
      }
      this.#assertExecutionAllowed(row.tenant_status, row.lease_kind);
      return normalizeInvocationRow(row);
    });
  }

  async claimLease(input) {
    return this.#withTransaction(async (client) => {
      const tenantId = requireTenantId(input.tenant_id);
      const invocationRef = requireInvocationRef(input.invocation_ref, 'invocation_ref');
      const purpose = requireEnum(
        input.purpose,
        ['execution', 'cleanup', 'recovery'],
        'lease purpose',
      );
      const claimantKeyId = requireOpaqueRef(input.claimant_key_id, 'claimant_key_id');
      const workerInstanceRef = requireOpaqueRef(input.worker_id, 'worker_id');
      const tokenHash = requireSha256(input.lease_token_hash, 'lease_token_hash');
      const tenantStatus = await this.#lockTenantStatus(client, tenantId);
      this.#assertExecutionAllowed(tenantStatus, purpose);
      const row = await this.#selectInvocation(client, tenantId, invocationRef, true);
      if (!row) throw managedError('Invocation was not found', 'INVOCATION_NOT_FOUND', 404);
      const expected = purpose === 'execution'
        ? 'admitted'
        : purpose === 'cleanup'
          ? 'cleanup_pending'
          : 'recovery_required';
      const now = await this.#databaseNow(client);
      await this.#assertClaimantCredentialActive(client, tenantId, claimantKeyId);
      const leaseMs = requireInteger(input.lease_ms, 'lease_ms', {
        min: MANAGED_SERVICE_PROTOCOL_LIMITS.min_lease_ms,
        max: MANAGED_SERVICE_PROTOCOL_LIMITS.max_lease_ms,
      });
      const activeLease = row.lease_kind !== null
        && row.lease_expires_at !== null
        && Date.parse(pgIso(row.lease_expires_at, 'lease expiry')) > Date.parse(now);
      if (activeLease) {
        const exactClaim = row.lease_owner === claimantKeyId
          && row.lease_kind === purpose
          && row.lease_token_hash === tokenHash;
        if (exactClaim) {
          const immediateClaimState = row.state === (purpose === 'execution'
            ? 'execution_leased'
            : expected);
          if (!immediateClaimState
            || row.audit_head_hash !== row.lease_claim_audit_hash) {
            throw managedError(
              'Lease claim has already progressed',
              'LEASE_CLAIM_ALREADY_PROGRESSED',
              409,
            );
          }
          if (purpose === 'execution') {
            assertExecutionWithinBudgetDay(
              pgDay(row.budget_day_utc, 'budget_day_utc'),
              now,
              pgIso(row.lease_expires_at, 'lease expiry'),
            );
          }
          return deepFreeze({
            claim_replayed: true,
            invocation: normalizeInvocationRow(row, purpose === 'execution'),
          });
        }
        throw managedError('Invocation already has an active lease', 'LEASE_ALREADY_HELD', 409);
      }
      if (row.lease_kind !== null) {
        throw managedError('Prior lease must be reaped before another claim', 'LEASE_EXPIRED', 409);
      }
      const tokenUse = await client.query(
        `SELECT 1 FROM ${this.#schema}.managed_lease_token_uses
          WHERE tenant_id = $1 AND lease_token_hash = $2`,
        [tenantId, tokenHash],
      );
      if (tokenUse.rowCount !== 0) {
        throw managedError('Lease token was already used', 'LEASE_TOKEN_REPLAYED', 409);
      }
      if (row.state !== expected) {
        throw managedError('Invocation is not claimable', 'INVOCATION_NOT_CLAIMABLE', 409);
      }
      const minLeaseMs = requireInteger(input.min_lease_ms, 'min_lease_ms', {
        min: MANAGED_SERVICE_PROTOCOL_LIMITS.min_lease_ms,
        max: MANAGED_SERVICE_PROTOCOL_LIMITS.max_lease_ms,
      });
      const maxLeaseMs = requireInteger(input.max_lease_ms, 'max_lease_ms', {
        min: MANAGED_SERVICE_PROTOCOL_LIMITS.min_lease_ms,
        max: MANAGED_SERVICE_PROTOCOL_LIMITS.max_lease_ms,
      });
      if (minLeaseMs > maxLeaseMs || leaseMs < minLeaseMs || leaseMs > maxLeaseMs) {
        throw new TypeError('lease_ms is outside the current managed-service lease policy');
      }
      let maxInvocationAge = null;
      if (purpose === 'execution') {
        maxInvocationAge = requireInteger(
          input.max_invocation_age_ms,
          'max_invocation_age_ms',
          { min: 10_000, max: 86_400_000 },
        );
        if (Date.parse(pgIso(row.admitted_at, 'admitted_at')) <= Date.parse(now) - maxInvocationAge) {
          throw managedError('Invocation admission has expired', 'INVOCATION_EXPIRED', 409);
        }
        const recovery = await client.query(
          `SELECT 1 FROM ${this.#schema}.managed_invocations
            WHERE tenant_id = $1 AND state = 'recovery_required' LIMIT 1`,
          [tenantId],
        );
        if (recovery.rowCount !== 0) {
          throw managedError(
            'Tenant has unresolved provider recovery work',
            'TENANT_RECOVERY_REQUIRED',
            503,
          );
        }
        const expiredExecution = await client.query(
          `SELECT 1 FROM ${this.#schema}.managed_invocations
            WHERE tenant_id = $1
              AND lease_kind = 'execution'
              AND lease_expires_at <= $2::timestamptz
            LIMIT 1`,
          [tenantId, now],
        );
        if (expiredExecution.rowCount !== 0) {
          throw managedError(
            'Tenant has an expired execution requiring reconciliation',
            'TENANT_RECONCILIATION_REQUIRED',
            503,
          );
        }
        assertExecutionWithinBudgetDay(
          pgDay(row.budget_day_utc, 'budget_day_utc'),
          now,
          new Date(Date.parse(now) + leaseMs).toISOString(),
        );
      }
      const insertedTokenUse = await client.query(
         `INSERT INTO ${this.#schema}.managed_lease_token_uses
            (tenant_id, invocation_ref, lease_token_hash, first_claimed_at)
          VALUES ($1, $2, $3, $4::timestamptz)
          ON CONFLICT (tenant_id, lease_token_hash) DO NOTHING`,
        [tenantId, invocationRef, tokenHash, now],
      );
      if (insertedTokenUse.rowCount !== 1) {
        throw managedError('Lease token was already used', 'LEASE_TOKEN_REPLAYED', 409);
      }
      const state = purpose === 'execution' ? 'execution_leased' : row.state;
      const updated = await client.query(
        `WITH lease_clock AS (SELECT clock_timestamp() AS now)
         UPDATE ${this.#schema}.managed_invocations AS target
            SET state = $3, lease_kind = $4, lease_owner = $5,
                lease_token_hash = $6,
                lease_expires_at = lease_clock.now + ($7::bigint * interval '1 millisecond'),
                lease_generation = lease_generation + 1, updated_at = lease_clock.now
           FROM lease_clock
          WHERE target.tenant_id = $1 AND target.invocation_ref = $2
            AND target.state = $8
            AND target.lease_kind IS NULL
            AND EXISTS (
              SELECT 1 FROM ${this.#schema}.managed_api_keys AS claimant
               WHERE claimant.key_id = $5 AND claimant.tenant_id = $1
                 AND claimant.revoked_at IS NULL
                 AND claimant.not_before <= lease_clock.now
                 AND claimant.expires_at > lease_clock.now
            )
            AND ($4 <> 'execution' OR (
              target.admitted_at > lease_clock.now - ($9::bigint * interval '1 millisecond')
              AND target.budget_day_utc = (lease_clock.now AT TIME ZONE 'UTC')::date
              AND NOT EXISTS (
                SELECT 1 FROM ${this.#schema}.managed_invocations AS blocker
                 WHERE blocker.tenant_id = $1
                   AND (blocker.state = 'recovery_required'
                     OR (blocker.lease_kind = 'execution'
                       AND blocker.lease_expires_at <= lease_clock.now))
              )
            ))
          RETURNING *`,
        [tenantId, invocationRef, state, purpose, claimantKeyId,
          tokenHash, leaseMs, expected, maxInvocationAge],
      );
      if (updated.rowCount !== 1) {
        const failureNow = await this.#databaseNow(client);
        if (row.lease_expires_at
          && Date.parse(pgIso(row.lease_expires_at, 'lease expiry')) > Date.parse(failureNow)) {
          throw managedError('Invocation already has an active lease', 'LEASE_ALREADY_HELD', 409);
        }
        if (purpose === 'execution') {
          if (Date.parse(pgIso(row.admitted_at, 'admitted_at'))
            <= Date.parse(failureNow) - maxInvocationAge) {
            throw managedError('Invocation admission has expired', 'INVOCATION_EXPIRED', 409);
          }
          assertExecutionWithinBudgetDay(
            pgDay(row.budget_day_utc, 'budget_day_utc'),
            failureNow,
            new Date(Date.parse(failureNow) + leaseMs).toISOString(),
          );
          const recovery = await client.query(
            `SELECT 1 FROM ${this.#schema}.managed_invocations
              WHERE tenant_id = $1 AND state = 'recovery_required' LIMIT 1`,
            [tenantId],
          );
          if (recovery.rowCount !== 0) {
            throw managedError(
              'Tenant has unresolved provider recovery work',
              'TENANT_RECOVERY_REQUIRED',
              503,
            );
          }
          const expiredExecution = await client.query(
            `SELECT 1 FROM ${this.#schema}.managed_invocations
              WHERE tenant_id = $1
                AND lease_kind = 'execution'
                AND lease_expires_at <= $2::timestamptz
              LIMIT 1`,
            [tenantId, failureNow],
          );
          if (expiredExecution.rowCount !== 0) {
            throw managedError(
              'Tenant has an expired execution requiring reconciliation',
              'TENANT_RECONCILIATION_REQUIRED',
              503,
            );
          }
        }
        throw managedError('Invocation is not claimable', 'INVOCATION_NOT_CLAIMABLE', 409);
      }
      const updatedRow = updated.rows[0];
      if (purpose === 'execution') {
        assertExecutionWithinBudgetDay(
          pgDay(updatedRow.budget_day_utc, 'budget_day_utc'),
          pgIso(updatedRow.updated_at, 'lease claim time'),
          pgIso(updatedRow.lease_expires_at, 'lease expiry'),
        );
      }
      await this.#appendAudit(
        client,
        updatedRow,
        `${purpose}_lease_claimed`,
        pgIso(updatedRow.updated_at, 'lease claim time'),
        {
        claimant_key_id: claimantKeyId,
        worker_instance_ref: workerInstanceRef,
        expires_at: pgIso(updatedRow.lease_expires_at, 'lease expiry'),
        lease_generation: pgInteger(updatedRow.lease_generation, 'lease generation'),
        },
      );
      const claimAnchor = requireSha256(updatedRow.audit_head_hash, 'lease claim audit hash');
      const marked = await client.query(
        `UPDATE ${this.#schema}.managed_invocations
            SET lease_claim_audit_hash = $3
          WHERE tenant_id = $1 AND invocation_ref = $2
            AND lease_owner = $4 AND lease_kind = $5
            AND lease_token_hash = $6 AND audit_head_hash = $3`,
        [tenantId, invocationRef, claimAnchor, claimantKeyId, purpose, tokenHash],
      );
      if (marked.rowCount !== 1) {
        throw managedError(
          'Lease claim replay marker update failed',
          'LEASE_CLAIM_MARKER_CONFLICT',
          503,
        );
      }
      updatedRow.lease_claim_audit_hash = claimAnchor;
      return deepFreeze({
        claim_replayed: false,
        invocation: normalizeInvocationRow(updatedRow, purpose === 'execution'),
      });
    }, input.now);
  }

  async renewLease(input) {
    return this.#withTransaction(async (client) => {
      const tenantId = requireTenantId(input.tenant_id);
      const claimantKeyId = requireOpaqueRef(input.claimant_key_id, 'claimant_key_id');
      const invocationRef = requireInvocationRef(input.invocation_ref, 'invocation_ref');
      const tokenHash = requireSha256(input.lease_token_hash, 'lease_token_hash');
      const tenantStatus = await this.#lockTenantStatus(client, tenantId);
      const row = await this.#selectInvocation(client, tenantId, invocationRef, true);
      if (!row) throw managedError('Invocation was not found', 'INVOCATION_NOT_FOUND', 404);
      if (row.lease_token_hash !== tokenHash) {
        throw managedError('Lease token is invalid', 'LEASE_TOKEN_INVALID', 403);
      }
      this.#assertLeaseOwner(row, claimantKeyId);
      await this.#assertClaimantCredentialActive(client, tenantId, claimantKeyId);
      this.#assertExecutionAllowed(tenantStatus, row.lease_kind);
      const now = await this.#databaseNow(client);
      if (!row.lease_expires_at || Date.parse(pgIso(row.lease_expires_at, 'lease expiry')) <= Date.parse(now)) {
        throw managedError('Lease has expired', 'LEASE_EXPIRED', 409);
      }
      const leaseMs = requireInteger(input.lease_ms, 'lease_ms', { min: 1_000, max: 900_000 });
      if (row.lease_kind === 'execution') {
        assertExecutionWithinBudgetDay(
          pgDay(row.budget_day_utc, 'budget_day_utc'),
          now,
          new Date(Date.parse(now) + leaseMs).toISOString(),
        );
      }
      const updated = await client.query(
        `WITH lease_clock AS (SELECT clock_timestamp() AS now)
         UPDATE ${this.#schema}.managed_invocations AS target
            SET lease_expires_at = lease_clock.now + ($3::bigint * interval '1 millisecond'),
                updated_at = lease_clock.now
           FROM lease_clock
          WHERE target.tenant_id = $1 AND target.invocation_ref = $2
            AND target.lease_expires_at > lease_clock.now
            AND target.lease_token_hash = $4
            AND target.lease_owner = $5
            AND EXISTS (
              SELECT 1 FROM ${this.#schema}.managed_api_keys AS claimant
               WHERE claimant.key_id = $5 AND claimant.tenant_id = $1
                 AND claimant.revoked_at IS NULL
                 AND claimant.not_before <= lease_clock.now
                 AND claimant.expires_at > lease_clock.now
            )
          RETURNING *`,
        [tenantId, invocationRef, leaseMs, tokenHash, claimantKeyId],
      );
      if (updated.rowCount !== 1) {
        const failureNow = await this.#databaseNow(client);
        if (Date.parse(pgIso(row.lease_expires_at, 'lease expiry')) <= Date.parse(failureNow)) {
          throw managedError('Lease has expired', 'LEASE_EXPIRED', 409);
        }
        await this.#assertClaimantCredentialActive(client, tenantId, claimantKeyId);
        throw managedError('Lease authority changed', 'LEASE_AUTHORITY_LOST', 409);
      }
      const updatedRow = updated.rows[0];
      if (row.lease_kind === 'execution') {
        assertExecutionWithinBudgetDay(
          pgDay(updatedRow.budget_day_utc, 'budget_day_utc'),
          pgIso(updatedRow.updated_at, 'lease renewal time'),
          pgIso(updatedRow.lease_expires_at, 'lease expiry'),
        );
      }
      await this.#appendAudit(client, updatedRow, `${row.lease_kind}_lease_renewed`,
        pgIso(updatedRow.updated_at, 'lease renewal time'), {
        expires_at: pgIso(updatedRow.lease_expires_at, 'lease expiry'),
        lease_generation: pgInteger(row.lease_generation, 'lease generation'),
      });
      return normalizeInvocationRow(updatedRow);
    }, input.now);
  }

  async transitionInvocation(input) {
    return this.#withTransaction(async (client) => {
      const tenantId = requireTenantId(input.tenant_id);
      const claimantKeyId = requireOpaqueRef(input.claimant_key_id, 'claimant_key_id');
      const invocationRef = requireInvocationRef(input.invocation_ref, 'invocation_ref');
      const tokenHash = requireSha256(input.lease_token_hash, 'lease_token_hash');
      const resourceJournalRequestHash = input.resource_journal_request_hash == null
        ? null
        : requireSha256(
          input.resource_journal_request_hash,
          'resource_journal_request_hash',
        );
      if (resourceJournalRequestHash !== null
        && !RESOURCE_JOURNAL_EVENT_TYPES.has(input.event_type)) {
        throw new TypeError('resource journal receipt requires a resource journal event');
      }
      const tenantStatus = await this.#lockTenantStatus(client, tenantId);
      const row = await this.#selectInvocation(client, tenantId, invocationRef, true);
      if (!row) throw managedError('Invocation was not found', 'INVOCATION_NOT_FOUND', 404);
      if (resourceJournalRequestHash !== null) {
        const priorReceipt = requireMatchingResourceJournalReceipt(
          await this.#selectResourceJournalReceipt(
            client,
            tenantId,
            invocationRef,
            resourceJournalRequestHash,
          ),
          {
            tenantId,
            invocationRef,
            requestHash: resourceJournalRequestHash,
            claimantKeyId,
            leaseTokenHash: tokenHash,
          },
        );
        if (priorReceipt !== null) {
          await this.#assertClaimantCredentialActive(client, tenantId, claimantKeyId);
          return priorReceipt.response;
        }
      }
      if (row.lease_token_hash !== tokenHash) {
        throw managedError('Lease token is invalid', 'LEASE_TOKEN_INVALID', 403);
      }
      this.#assertLeaseOwner(row, claimantKeyId);
      await this.#assertClaimantCredentialActive(client, tenantId, claimantKeyId);
      this.#assertExecutionAllowed(tenantStatus, row.lease_kind);
      const now = await this.#databaseNow(client);
      if (!row.lease_expires_at || Date.parse(pgIso(row.lease_expires_at, 'lease expiry')) <= Date.parse(now)) {
        throw managedError('Lease has expired', 'LEASE_EXPIRED', 409);
      }
      if (!input.expected_states.includes(row.state)) {
        throw managedError('Invocation state changed', 'INVOCATION_STATE_CONFLICT', 409);
      }
      if (pgInteger(row.audit_event_count, 'audit_event_count') !== requireInteger(
        input.expected_audit_event_count,
        'expected_audit_event_count',
      )) {
        throw managedError('Invocation version changed', 'INVOCATION_STATE_CONFLICT', 409);
      }
      const allowedTransitions = {
        execution_leased: ['execution_leased', 'running'],
        running: ['cleanup_pending'],
        cleanup_pending: ['completed', 'failed_closed'],
        recovery_required: ['cleanup_pending', 'failed_closed'],
      };
      if (!INVOCATION_STATES.includes(input.next_state)
        || !allowedTransitions[row.state]?.includes(input.next_state)) {
        throw managedError('Invocation transition is invalid', 'INVOCATION_TRANSITION_INVALID', 409);
      }
      const patch = input.patch ?? {};
      assertPlainRecord(patch, 'transition patch');
      const patchKeys = row.state === 'execution_leased'
        ? ['savepoint_ref', 'fork_ref', 'cleanup_requests']
        : row.state === 'recovery_required'
          ? ['savepoint_ref', 'fork_ref', 'cleanup_requests']
        : row.state === 'running'
          ? ['execution_outcome', 'execution_evidence_hash', 'result_hash']
          : [];
      assertAllowedKeys(patch, patchKeys, 'transition patch');
      const fields = {
        savepoint_ref: patch.savepoint_ref ?? row.savepoint_ref,
        fork_ref: patch.fork_ref ?? row.fork_ref,
        cleanup_requests: patch.cleanup_requests ?? row.cleanup_requests,
        execution_outcome: patch.execution_outcome ?? row.execution_outcome,
        execution_evidence_hash: patch.execution_evidence_hash ?? row.execution_evidence_hash,
        result_hash: patch.result_hash ?? row.result_hash,
      };
      const terminal = ['completed', 'failed_closed'].includes(input.next_state);
      const verificationNotAfter = terminal
        ? requireIso(input.verification_not_after, 'verification_not_after')
        : null;
      if (!terminal && input.verification_not_after != null) {
        throw new TypeError('verification_not_after is only valid for terminal transitions');
      }
      if (terminal && Date.parse(now) > Date.parse(verificationNotAfter)) {
        throw managedError(
          'Provider verification expired before the terminal transition',
          'VERIFICATION_DEADLINE_EXCEEDED',
          409,
        );
      }
      const releasesLease = terminal
        || ((row.state === 'running' || row.state === 'recovery_required')
          && input.next_state === 'cleanup_pending');
      const updated = await client.query(
        `WITH transition_clock AS (SELECT clock_timestamp() AS now)
         UPDATE ${this.#schema}.managed_invocations AS target
            SET state = $3, savepoint_ref = $4, fork_ref = $5,
                cleanup_requests = $6::jsonb, execution_outcome = $7,
                execution_evidence_hash = $8, result_hash = $9,
                updated_at = transition_clock.now,
                terminal_at = CASE WHEN $10 THEN transition_clock.now ELSE terminal_at END,
                lease_kind = CASE WHEN $11 THEN NULL ELSE lease_kind END,
                lease_owner = CASE WHEN $11 THEN NULL ELSE lease_owner END,
                lease_token_hash = CASE WHEN $11 THEN NULL ELSE lease_token_hash END,
                lease_expires_at = CASE WHEN $11 THEN NULL ELSE lease_expires_at END
           FROM transition_clock
          WHERE target.tenant_id = $1 AND target.invocation_ref = $2
            AND target.lease_expires_at > transition_clock.now
            AND ($12::timestamptz IS NULL OR transition_clock.now <= $12::timestamptz)
            AND target.lease_owner = $13
            AND target.lease_token_hash = $14
            AND EXISTS (
              SELECT 1 FROM ${this.#schema}.managed_api_keys AS claimant
               WHERE claimant.key_id = $13 AND claimant.tenant_id = $1
                 AND claimant.revoked_at IS NULL
                 AND claimant.not_before <= transition_clock.now
                 AND claimant.expires_at > transition_clock.now
            )
          RETURNING *`,
        [tenantId, invocationRef, input.next_state, fields.savepoint_ref, fields.fork_ref,
          JSON.stringify(fields.cleanup_requests), fields.execution_outcome,
          fields.execution_evidence_hash, fields.result_hash, terminal, releasesLease,
          verificationNotAfter, claimantKeyId, tokenHash],
      );
      if (updated.rowCount !== 1) {
        const failureNow = await this.#databaseNow(client);
        if (Date.parse(pgIso(row.lease_expires_at, 'lease expiry')) <= Date.parse(failureNow)) {
          throw managedError('Lease has expired', 'LEASE_EXPIRED', 409);
        }
        await this.#assertClaimantCredentialActive(client, tenantId, claimantKeyId);
        throw managedError(
          'Provider verification expired before the terminal transition',
          'VERIFICATION_DEADLINE_EXCEEDED',
          409,
        );
      }
      const updatedRow = updated.rows[0];
      await this.#appendAudit(
        client,
        updatedRow,
        input.event_type,
        pgIso(updatedRow.updated_at, 'transition time'),
        {
          from_state: row.state,
          to_state: input.next_state,
          ...cloneJson(input.event_details ?? {}, 'event details'),
        },
      );
      const response = normalizeInvocationRow(updatedRow);
      if (resourceJournalRequestHash !== null) {
        const receipt = createManagedResourceJournalReceipt({
          tenantId,
          invocationRef,
          requestHash: resourceJournalRequestHash,
          claimantKeyId,
          leaseTokenHash: tokenHash,
          response,
          createdAt: pgIso(updatedRow.updated_at, 'resource journal receipt time'),
        });
        const receiptInsert = await client.query(
          `INSERT INTO ${this.#schema}.managed_resource_journal_receipts (
             tenant_id, invocation_ref, request_hash, claimant_key_id,
             lease_token_hash, response_json, response_hash, created_at
           ) VALUES ($1,$2,$3,$4,$5,$6::jsonb,$7,$8::timestamptz)`,
          [
            receipt.tenant_id,
            receipt.invocation_ref,
            receipt.request_hash,
            receipt.claimant_key_id,
            receipt.lease_token_hash,
            JSON.stringify(receipt.response),
            receipt.response_hash,
            receipt.created_at,
          ],
        );
        if (receiptInsert.rowCount !== 1) {
          throw managedError(
            'Resource journal receipt append failed',
            'RESOURCE_JOURNAL_RECEIPT_WRITE_FAILED',
            503,
          );
        }
        return receipt.response;
      }
      return response;
    }, input.now);
  }

  async settleExecutionOutcome(input) {
    return this.#withTransaction(async (client) => {
      const tenantId = requireTenantId(input.tenant_id);
      const claimantKeyId = requireOpaqueRef(input.claimant_key_id, 'claimant_key_id');
      const invocationRef = requireInvocationRef(input.invocation_ref, 'invocation_ref');
      const tokenHash = requireSha256(input.lease_token_hash, 'lease_token_hash');
      const tenantStatus = await this.#lockTenantStatus(client, tenantId);
      const row = await this.#selectInvocation(client, tenantId, invocationRef, true);
      if (!row) throw managedError('Invocation was not found', 'INVOCATION_NOT_FOUND', 404);
      if (row.lease_token_hash !== tokenHash) {
        throw managedError('Lease token is invalid', 'LEASE_TOKEN_INVALID', 403);
      }
      this.#assertLeaseOwner(row, claimantKeyId);
      await this.#assertClaimantCredentialActive(client, tenantId, claimantKeyId);
      this.#assertExecutionAllowed(tenantStatus, row.lease_kind);
      const now = await this.#databaseNow(client);
      if (!row.lease_expires_at || Date.parse(pgIso(row.lease_expires_at, 'lease expiry')) <= Date.parse(now)) {
        throw managedError('Lease has expired', 'LEASE_EXPIRED', 409);
      }
      if (row.state !== 'running' || !Array.isArray(row.cleanup_requests) || row.cleanup_requests.length !== 2) {
        throw managedError('Provider resources are not recorded', 'RESOURCES_NOT_RECORDED', 409);
      }
      if (row.actual_cost_micros != null) {
        throw managedError('Execution outcome is already settled', 'INVOCATION_STATE_CONFLICT', 409);
      }
      const estimated = pgInteger(row.estimated_cost_micros, 'estimated cost');
      const actual = requireInteger(input.actual_cost_micros, 'actual_cost_micros', {
        min: 0,
        max: estimated,
      });
      if (input.execution_outcome !== 'succeeded' && input.execution_outcome !== 'failed') {
        throw new TypeError('execution_outcome must be succeeded or failed');
      }
      const executionEvidenceHash = requireSha256(
        input.execution_evidence_hash,
        'execution_evidence_hash',
      );
      const resultHash = requireSha256(input.result_hash, 'result_hash');
      const usage = await client.query(
        `UPDATE ${this.#schema}.managed_usage_buckets
            SET reserved_micros = reserved_micros - $3,
                spent_micros = spent_micros + $4,
                updated_at = clock_timestamp()
          WHERE tenant_id = $1 AND budget_day_utc = $2::date
            AND reserved_micros >= $3`,
        [tenantId, pgDay(row.budget_day_utc, 'budget day'), estimated, actual],
      );
      if (usage.rowCount !== 1) throw new Error('Budget reservation invariant failed');
      const updated = await client.query(
        `WITH outcome_clock AS (SELECT clock_timestamp() AS now)
         UPDATE ${this.#schema}.managed_invocations AS target
            SET actual_cost_micros = $3, state = 'cleanup_pending',
                execution_outcome = $4, execution_evidence_hash = $5,
                result_hash = $6, lease_kind = NULL, lease_owner = NULL,
                lease_token_hash = NULL, lease_expires_at = NULL,
                updated_at = outcome_clock.now
           FROM outcome_clock
          WHERE target.tenant_id = $1 AND target.invocation_ref = $2
            AND target.lease_expires_at > outcome_clock.now
            AND target.lease_owner = $7
            AND target.lease_token_hash = $8
            AND EXISTS (
              SELECT 1 FROM ${this.#schema}.managed_api_keys AS claimant
               WHERE claimant.key_id = $7 AND claimant.tenant_id = $1
                 AND claimant.revoked_at IS NULL
                 AND claimant.not_before <= outcome_clock.now
                 AND claimant.expires_at > outcome_clock.now
            )
          RETURNING *`,
        [tenantId, invocationRef, actual, input.execution_outcome,
          executionEvidenceHash, resultHash, claimantKeyId, tokenHash],
      );
      if (updated.rowCount !== 1) {
        const failureNow = await this.#databaseNow(client);
        if (Date.parse(pgIso(row.lease_expires_at, 'lease expiry')) <= Date.parse(failureNow)) {
          throw managedError('Lease has expired', 'LEASE_EXPIRED', 409);
        }
        await this.#assertClaimantCredentialActive(client, tenantId, claimantKeyId);
        throw managedError('Lease authority changed', 'LEASE_AUTHORITY_LOST', 409);
      }
      const updatedRow = updated.rows[0];
      await this.#appendAudit(
        client,
        updatedRow,
        'execution_outcome_recorded',
        pgIso(updatedRow.updated_at, 'execution outcome time'),
        {
          from_state: 'running',
          to_state: 'cleanup_pending',
          outcome: input.execution_outcome,
          actual_cost_micros: actual,
        },
      );
      return normalizeInvocationRow(updatedRow);
    }, input.now);
  }

  async listExpiredLeases(_nowValue, limitValue = 100) {
    const limit = requireInteger(limitValue, 'expired lease query limit', { min: 1, max: 1_000 });
    return this.#withClient(async (client) => {
      const result = await client.query(
        `SELECT * FROM ${this.#schema}.managed_invocations
          WHERE lease_expires_at <= clock_timestamp() AND lease_kind IS NOT NULL
          ORDER BY lease_expires_at, tenant_id, invocation_ref
          LIMIT $1`,
        [limit],
      );
      return deepFreeze(result.rows.map((row) => normalizeInvocationRow(row)));
    });
  }

  async releaseExpiredLease(input) {
    return this.#withTransaction(async (client) => {
      const tenantId = requireTenantId(input.tenant_id);
      const invocationRef = requireInvocationRef(input.invocation_ref, 'invocation_ref');
      const row = await this.#selectInvocation(client, tenantId, invocationRef, true);
      if (!row) return null;
      const now = await this.#databaseNow(client);
      if (!row.lease_expires_at || Date.parse(pgIso(row.lease_expires_at, 'lease expiry')) > Date.parse(now)) {
        return normalizeInvocationRow(row);
      }
      const expiredKind = row.lease_kind;
      let nextState = row.state;
      let outcome = row.execution_outcome;
      let actual = row.actual_cost_micros;
      if (expiredKind === 'execution') {
        const hasRecordedResources = row.state === 'running'
          && Array.isArray(row.cleanup_requests)
          && row.cleanup_requests.length === 2;
        nextState = hasRecordedResources ? 'cleanup_pending' : 'recovery_required';
        outcome = 'ambiguous';
        const estimated = pgInteger(row.estimated_cost_micros, 'estimated cost');
        if (actual == null) {
          const usage = await client.query(
            `UPDATE ${this.#schema}.managed_usage_buckets
                SET reserved_micros = reserved_micros - $3,
                    spent_micros = spent_micros + $3,
                    updated_at = $4
              WHERE tenant_id = $1 AND budget_day_utc = $2::date
                AND reserved_micros >= $3`,
            [tenantId, pgDay(row.budget_day_utc, 'budget day'), estimated, now],
          );
          if (usage.rowCount !== 1) throw new Error('Budget reservation invariant failed');
          actual = estimated;
        } else if (pgInteger(actual, 'actual cost') < estimated) {
          const priorActual = pgInteger(actual, 'actual cost');
          const usage = await client.query(
            `UPDATE ${this.#schema}.managed_usage_buckets
                SET spent_micros = spent_micros + $3,
                    updated_at = $4
              WHERE tenant_id = $1 AND budget_day_utc = $2::date`,
            [tenantId, pgDay(row.budget_day_utc, 'budget day'), estimated - priorActual, now],
          );
          if (usage.rowCount !== 1) throw new Error('Budget settlement invariant failed');
          actual = estimated;
        }
      }
      const updated = await client.query(
        `UPDATE ${this.#schema}.managed_invocations
            SET state = $3, execution_outcome = $4, actual_cost_micros = $5,
                lease_kind = NULL, lease_owner = NULL, lease_token_hash = NULL,
                lease_expires_at = NULL, updated_at = $6
          WHERE tenant_id = $1 AND invocation_ref = $2 RETURNING *`,
        [tenantId, invocationRef, nextState, outcome, actual, now],
      );
      const updatedRow = updated.rows[0];
      await this.#appendAudit(client, updatedRow, `${expiredKind}_lease_expired`, now, {
        resulting_state: nextState,
        resource_tracking: expiredKind === 'execution' && nextState === 'recovery_required'
          ? 'unavailable_or_incomplete'
          : 'recorded_or_not_applicable',
      });
      return normalizeInvocationRow(updatedRow);
    }, input.now);
  }

  async listStaleAdmissions(_nowValue, maxAgeValue, limitValue = 100) {
    const maxAge = requireInteger(maxAgeValue, 'stale admission max age', {
      min: 10_000,
      max: 86_400_000,
    });
    const limit = requireInteger(limitValue, 'stale admission query limit', { min: 1, max: 1_000 });
    return this.#withClient(async (client) => {
      const result = await client.query(
        `SELECT * FROM ${this.#schema}.managed_invocations
          WHERE state = 'admitted'
            AND admitted_at <= clock_timestamp() - ($1::bigint * interval '1 millisecond')
          ORDER BY admitted_at, tenant_id, invocation_ref
          LIMIT $2`,
        [maxAge, limit],
      );
      return deepFreeze(result.rows.map((row) => normalizeInvocationRow(row)));
    });
  }

  async releaseStaleAdmission(input) {
    return this.#withTransaction(async (client) => {
      const tenantId = requireTenantId(input.tenant_id);
      const invocationRef = requireInvocationRef(input.invocation_ref, 'invocation_ref');
      const row = await this.#selectInvocation(client, tenantId, invocationRef, true);
      if (!row) return null;
      const now = await this.#databaseNow(client);
      const maxAge = requireInteger(input.max_age_ms, 'stale admission max age', {
        min: 10_000,
        max: 86_400_000,
      });
      if (row.state !== 'admitted'
        || Date.parse(pgIso(row.admitted_at, 'admitted_at')) > Date.parse(now) - maxAge) {
        return normalizeInvocationRow(row);
      }
      const estimated = pgInteger(row.estimated_cost_micros, 'estimated cost');
      const usage = await client.query(
        `UPDATE ${this.#schema}.managed_usage_buckets
            SET reserved_micros = reserved_micros - $3, updated_at = $4
          WHERE tenant_id = $1 AND budget_day_utc = $2::date
            AND reserved_micros >= $3`,
        [tenantId, pgDay(row.budget_day_utc, 'budget day'), estimated, now],
      );
      if (usage.rowCount !== 1) throw new Error('Budget reservation invariant failed');
      const updated = await client.query(
        `UPDATE ${this.#schema}.managed_invocations
            SET state = 'failed_closed', actual_cost_micros = 0,
                updated_at = $3, terminal_at = $3
          WHERE tenant_id = $1 AND invocation_ref = $2 RETURNING *`,
        [tenantId, invocationRef, now],
      );
      const updatedRow = updated.rows[0];
      await this.#appendAudit(client, updatedRow, 'stale_admission_expired', now, {
        admitted_at: pgIso(row.admitted_at, 'admitted_at'),
        max_age_ms: maxAge,
      });
      return normalizeInvocationRow(updatedRow);
    }, input.now);
  }

  async listAuditEvents(tenantIdValue, invocationRefValue) {
    const tenantId = requireTenantId(tenantIdValue);
    const invocationRef = requireInvocationRef(invocationRefValue, 'invocation_ref');
    return this.#withClient(async (client) => {
      const result = await client.query(
        `SELECT event_ref, tenant_id, invocation_ref, sequence, event_type,
                occurred_at, details_hash, prior_event_hash, event_hash, evidence_class
           FROM ${this.#schema}.managed_audit_events
          WHERE tenant_id = $1 AND invocation_ref = $2
          ORDER BY sequence`,
        [tenantId, invocationRef],
      );
      return deepFreeze(normalizeAuditRows(result.rows));
    });
  }

  async getAuditSnapshot(tenantIdValue, invocationRefValue) {
    const tenantId = requireTenantId(tenantIdValue);
    const invocationRef = requireInvocationRef(invocationRefValue, 'invocation_ref');
    return this.#withReadSnapshot(async (client) => {
      const row = await this.#selectInvocation(client, tenantId, invocationRef, false);
      if (!row) return null;
      const result = await client.query(
        `SELECT event_ref, tenant_id, invocation_ref, sequence, event_type,
                occurred_at, details_hash, prior_event_hash, event_hash, evidence_class
           FROM ${this.#schema}.managed_audit_events
          WHERE tenant_id = $1 AND invocation_ref = $2
          ORDER BY sequence`,
        [tenantId, invocationRef],
      );
      return deepFreeze({
        invocation: normalizeInvocationRow(row),
        events: normalizeAuditRows(result.rows),
      });
    });
  }

  async providerBindingObligations(limitValue = 10_000) {
    const limit = requireInteger(limitValue, 'provider binding obligation limit', {
      min: 1,
      max: 10_000,
    });
    return this.#withClient(async (client) => {
      const result = await client.query(
        `SELECT tenant_id, provider_id, provider_binding_hash,
                bool_or(state = ANY($2::text[])) AS requires_enabled
           FROM ${this.#schema}.managed_invocations
          WHERE state <> ALL($1::text[])
          GROUP BY tenant_id, provider_id, provider_binding_hash
          ORDER BY tenant_id, provider_id, provider_binding_hash
          LIMIT $3`,
        [TERMINAL_INVOCATION_STATES, ['admitted', 'execution_leased', 'running'], limit + 1],
      );
      return deepFreeze({
        complete: result.rows.length <= limit,
        bindings: result.rows.slice(0, limit).map((row) => {
          if (typeof row.requires_enabled !== 'boolean') {
            throw new TypeError('provider binding obligation requires_enabled must be boolean');
          }
          return {
            tenant_id: requireTenantId(row.tenant_id),
            provider_id: requireProviderId(row.provider_id),
            provider_binding_hash: requireSha256(row.provider_binding_hash, 'provider_binding_hash'),
            requires_enabled: row.requires_enabled,
          };
        }),
      });
    });
  }

  async health() {
    return this.#withClient(async (client) => {
      const catalog = await client.query(
        `SELECT
           (SELECT count(*)::integer
              FROM information_schema.tables
             WHERE table_schema = $1 AND table_name = ANY($2::text[])) AS table_count,
           (SELECT count(*)::integer
              FROM pg_catalog.pg_trigger trigger_row
              JOIN pg_catalog.pg_class table_row ON table_row.oid = trigger_row.tgrelid
              JOIN pg_catalog.pg_namespace namespace_row ON namespace_row.oid = table_row.relnamespace
             WHERE namespace_row.nspname = $1
               AND table_row.relname = 'managed_audit_events'
               AND trigger_row.tgname = ANY($3::text[])
               AND NOT trigger_row.tgisinternal
               AND trigger_row.tgenabled IN ('O', 'A')) AS trigger_count,
           current_setting('fsync') AS fsync,
           current_setting('synchronous_commit') AS synchronous_commit,
           current_setting('session_replication_role') AS session_replication_role`,
        [this.#schemaName, REQUIRED_TABLES, REQUIRED_AUDIT_TRIGGERS],
      );
      const row = catalog.rows[0] ?? {};
      const catalogVerified = Number(row.table_count) === REQUIRED_TABLES.length
        && Number(row.trigger_count) === REQUIRED_AUDIT_TRIGGERS.length;
      let migrationVerified = false;
      let migrationCount = null;
      let recoveryRequiredCount = null;
      let expiredExecutionLeaseCount = null;
      if (catalogVerified) {
        const state = await client.query(
          `SELECT
             (SELECT migration_hash
                FROM ${this.#schema}.managed_schema_migrations
               WHERE version = 1) AS migration_hash,
             (SELECT count(*)::integer
                FROM ${this.#schema}.managed_schema_migrations) AS migration_count,
             (SELECT count(*)::integer
                FROM ${this.#schema}.managed_invocations
               WHERE state = 'recovery_required') AS recovery_required_count,
             (SELECT count(*)::integer
                FROM ${this.#schema}.managed_invocations
               WHERE lease_kind = 'execution'
                 AND lease_expires_at <= clock_timestamp()) AS expired_execution_lease_count`,
        );
        const stateRow = state.rows[0] ?? {};
        migrationCount = Number(stateRow.migration_count);
        migrationVerified = migrationCount === 1
          && stateRow.migration_hash === await expectedMigrationHash();
        recoveryRequiredCount = Number(stateRow.recovery_required_count);
        expiredExecutionLeaseCount = Number(stateRow.expired_execution_lease_count);
      }
      const durabilityVerified = row.fsync === 'on'
        && row.synchronous_commit === 'on'
        && row.session_replication_role === 'origin';
      const ready = catalogVerified
        && migrationVerified
        && durabilityVerified
        && recoveryRequiredCount === 0
        && expiredExecutionLeaseCount === 0;
      return deepFreeze({
        ready,
        backend: 'postgresql',
        durable: durabilityVerified,
        tls_required: this.#requireTls,
        tls_ca_validated: this.#requireTls,
        catalog_verified: catalogVerified,
        migration_verified: migrationVerified,
        migration_count: migrationCount,
        recovery_required_count: recoveryRequiredCount,
        expired_execution_lease_count: expiredExecutionLeaseCount,
      });
    });
  }

  async close() {
    if (!managedOwnedPools.has(this.#pool) || this.#closed) return false;
    this.#closed = true;
    await this.#pool.end();
    return true;
  }
}

export async function createPostgresManagedServiceStore(options = {}) {
  assertPlainRecord(options, 'managed PostgreSQL store options');
  assertAllowedKeys(options, [
    'connectionString',
    'schemaName',
    'tls',
    'maxConnections',
    'connectionTimeoutMs',
    'statementTimeoutMs',
    'maxClockSkewMs',
    'eventRef',
  ], 'managed PostgreSQL store options');
  const pool = await createPostgresAuthorityPool({
    connectionString: options.connectionString,
    requireTls: true,
    tls: options.tls,
    maxConnections: options.maxConnections,
    connectionTimeoutMs: options.connectionTimeoutMs,
    statementTimeoutMs: options.statementTimeoutMs,
    applicationName: 'agoragentic-risk-fork-managed-store',
  });
  trustedCaPinnedPools.add(pool);
  managedOwnedPools.add(pool);
  try {
    return new PostgresManagedServiceStore({
      pool,
      schemaName: options.schemaName,
      requireTls: true,
      maxClockSkewMs: options.maxClockSkewMs,
      eventRef: options.eventRef,
    });
  } catch (error) {
    await pool.end().catch(() => {});
    throw error;
  }
}
