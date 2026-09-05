import { randomUUID } from 'node:crypto';
import { createManagedAuditEvent } from './audit.mjs';
import { sha256Ref } from '../../src/canonical.mjs';
import { validateChildOperation } from '../../src/child-operation.mjs';
import {
  ACTIVE_INVOCATION_STATES,
  INVOCATION_STATES,
  MANAGED_API_KEY_SCHEMA,
  MANAGED_INVOCATION_SCHEMA,
  MANAGED_SERVICE_PROTOCOL_LIMITS,
  TERMINAL_INVOCATION_STATES,
} from './constants.mjs';
import { normalizeApiKeyRecord } from './auth.mjs';
import {
  assertManagedRecoveryKeyIntegrity,
  createManagedResourceJournalReceipt,
  managedClientRequestHash,
  normalizeManagedResourceJournalReceipt,
} from './invocation-integrity.mjs';
import {
  assertAllowedKeys,
  assertDataArray,
  assertExecutionWithinBudgetDay,
  assertPlainRecord,
  cloneJson,
  deepFreeze,
  managedError,
  requireInteger,
  requireInvocationRef,
  requireIso,
  requireOpaqueRef,
  requireProviderId,
  requireSha256,
  requireTenantId,
  utcDay,
} from './validation.mjs';

function invocationKey(tenantId, invocationRef) {
  return `${tenantId}\u0000${invocationRef}`;
}

function idempotencyKey(tenantId, idempotencyHash) {
  return `${tenantId}\u0000${idempotencyHash}`;
}

function usageKey(tenantId, day) {
  return `${tenantId}\u0000${day}`;
}

function leaseTokenUseKey(tenantId, tokenHash) {
  return `${tenantId}\u0000${tokenHash}`;
}

function resourceJournalReceiptKey(tenantId, invocationRef, requestHash) {
  return `${tenantId}\u0000${invocationRef}\u0000${requestHash}`;
}

const RESOURCE_JOURNAL_EVENT_TYPES = new Set([
  'provider_resource_journaled',
  'provider_resources_recorded',
  'provider_resources_recovered',
]);

function normalizeTenant(value) {
  assertPlainRecord(value, 'tenant');
  assertAllowedKeys(value, [
    'tenant_id',
    'status',
    'daily_budget_micros',
    'max_invocation_cost_micros',
    'max_concurrent_invocations',
  ], 'tenant');
  if (value.status !== 'active' && value.status !== 'suspended') {
    throw new TypeError('tenant.status must be active or suspended');
  }
  return deepFreeze({
    tenant_id: requireTenantId(value.tenant_id),
    status: value.status,
    daily_budget_micros: requireInteger(
      value.daily_budget_micros,
      'tenant.daily_budget_micros',
      { min: 0, max: 10_000_000_000 },
    ),
    max_invocation_cost_micros: requireInteger(
      value.max_invocation_cost_micros,
      'tenant.max_invocation_cost_micros',
      { min: 0, max: 1_000_000_000 },
    ),
    max_concurrent_invocations: requireInteger(
      value.max_concurrent_invocations,
      'tenant.max_concurrent_invocations',
      { min: 1, max: 1_000 },
    ),
  });
}

function publicInvocation(record) {
  assertManagedRecoveryKeyIntegrity(record);
  const copy = cloneJson(record, 'invocation');
  delete copy.operation;
  delete copy.lease_claim_audit_hash;
  delete copy.lease_token_hash;
  return deepFreeze(copy);
}

function executionInvocation(record) {
  assertManagedRecoveryKeyIntegrity(record);
  const operation = validateChildOperation(cloneJson(record.operation, 'stored operation'));
  if (sha256Ref(operation) !== requireSha256(record.operation_hash, 'operation_hash')) {
    throw managedError('Stored operation integrity check failed', 'OPERATION_INTEGRITY_FAILED', 503);
  }
  const expectedRequestHash = managedClientRequestHash({
    providerId: record.provider_id,
    operation,
    estimatedCostMicros: record.estimated_cost_micros,
  });
  if (expectedRequestHash !== requireSha256(record.request_hash, 'request_hash')) {
    throw managedError('Stored request integrity check failed', 'REQUEST_INTEGRITY_FAILED', 503);
  }
  const copy = cloneJson(record, 'invocation');
  copy.operation = operation;
  delete copy.lease_claim_audit_hash;
  delete copy.lease_token_hash;
  return deepFreeze(copy);
}

export class MemoryManagedServiceStore {
  #tenants = new Map();
  #credentials = new Map();
  #invocations = new Map();
  #idempotency = new Map();
  #usage = new Map();
  #audit = new Map();
  #leaseTokenUses = new Set();
  #resourceJournalReceipts = new Map();
  #tail = Promise.resolve();
  #eventRef;

  constructor({ tenants = [], credentials = [], eventRef = () => `evt_${randomUUID()}` } = {}) {
    assertDataArray(tenants, 'tenants', { maxLength: 10_000 });
    assertDataArray(credentials, 'credentials', { maxLength: 100_000 });
    if (typeof eventRef !== 'function') throw new TypeError('eventRef must be a function');
    this.#eventRef = eventRef;
    for (const value of tenants) {
      const tenant = normalizeTenant(value);
      if (this.#tenants.has(tenant.tenant_id)) throw new TypeError('tenant IDs must be unique');
      this.#tenants.set(tenant.tenant_id, tenant);
    }
    const keyIds = new Set();
    for (const value of credentials) {
      const credentialInput = cloneJson(value, 'credential');
      const credential = normalizeApiKeyRecord({
        schema: MANAGED_API_KEY_SCHEMA,
        ...credentialInput,
      });
      if (!this.#tenants.has(credential.tenant_id)) {
        throw new TypeError('credential tenant is not provisioned');
      }
      if (this.#credentials.has(credential.key_hash)) {
        throw new TypeError('credential hashes must be unique');
      }
      if (keyIds.has(credential.key_id)) {
        throw new TypeError('credential key IDs must be globally unique');
      }
      this.#credentials.set(credential.key_hash, credential);
      keyIds.add(credential.key_id);
    }
  }

  async #exclusive(callback) {
    const prior = this.#tail;
    let release;
    this.#tail = new Promise((resolve) => { release = resolve; });
    await prior;
    try {
      return await callback();
    } finally {
      release();
    }
  }

  #draftAudit(record, eventType, occurredAt, details = {}) {
    const key = invocationKey(record.tenant_id, record.invocation_ref);
    const events = this.#audit.get(key) ?? [];
    const normalizedOccurredAt = requireIso(occurredAt, 'audit event occurred_at');
    const priorOccurredAt = events.at(-1)?.occurred_at ?? null;
    if (priorOccurredAt !== null && normalizedOccurredAt < priorOccurredAt) {
      throw managedError(
        'Managed audit event time moved backward',
        'AUDIT_TIME_REGRESSION',
        503,
      );
    }
    const event = createManagedAuditEvent({
      event_ref: requireOpaqueRef(this.#eventRef(), 'event reference'),
      tenant_id: record.tenant_id,
      invocation_ref: record.invocation_ref,
      sequence: events.length + 1,
      event_type: eventType,
      occurred_at: normalizedOccurredAt,
      details,
      prior_event_hash: events.at(-1)?.event_hash ?? null,
    });
    return { key, events: [...events, event], event };
  }

  #prepareAuditedRecord(record, eventType, occurredAt, details = {}) {
    const draft = this.#draftAudit(record, eventType, occurredAt, details);
    const { event } = draft;
    record.audit_head_hash = event.event_hash;
    record.audit_event_count = draft.events.length;
    return {
      ...draft,
      record,
      public_record: publicInvocation(record),
    };
  }

  #commitAuditedRecord(prepared) {
    this.#audit.set(prepared.key, prepared.events);
    this.#invocations.set(prepared.key, prepared.record);
    return prepared.public_record;
  }

  async resolveCredential(keyHashValue) {
    const keyHash = requireSha256(keyHashValue, 'credential key hash');
    return this.#credentials.get(keyHash) ?? null;
  }

  async findIdempotentInvocation(input) {
    return this.#exclusive(async () => {
      assertPlainRecord(input, 'idempotency lookup');
      assertAllowedKeys(
        input,
        ['tenant_id', 'idempotency_hash', 'request_hash'],
        'idempotency lookup',
      );
      const tenantId = requireTenantId(input.tenant_id);
      const idempotencyHash = requireSha256(input.idempotency_hash, 'idempotency_hash');
      const requestHash = requireSha256(input.request_hash, 'request_hash');
      const existingRef = this.#idempotency.get(idempotencyKey(tenantId, idempotencyHash));
      if (!existingRef) return null;
      const existing = this.#invocations.get(invocationKey(tenantId, existingRef));
      if (!existing || existing.request_hash !== requestHash) {
        throw managedError(
          'Idempotency key was already used for a different request',
          'IDEMPOTENCY_CONFLICT',
          409,
        );
      }
      return deepFreeze({ created: false, invocation: publicInvocation(existing) });
    });
  }

  async findResourceJournalReceipt(input) {
    return this.#exclusive(async () => {
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
      const claimantKeyId = requireOpaqueRef(input.claimant_key_id, 'claimant_key_id');
      const now = requireIso(input.now, 'resource journal receipt lookup time');
      this.#requireActiveClaimant(tenantId, claimantKeyId, now);
      return this.#matchingResourceJournalReceipt({
        tenantId,
        invocationRef: requireInvocationRef(input.invocation_ref, 'invocation_ref'),
        requestHash: requireSha256(input.request_hash, 'resource journal request_hash'),
        claimantKeyId,
        leaseTokenHash: requireSha256(input.lease_token_hash, 'lease_token_hash'),
      });
    });
  }

  async admitInvocation(input) {
    return this.#exclusive(async () => {
      assertPlainRecord(input, 'admission');
      const tenantId = requireTenantId(input.tenant_id);
      const invocationRef = requireInvocationRef(input.invocation_ref, 'invocation_ref');
      const requestHash = requireSha256(input.request_hash, 'request_hash');
      const idempotencyHash = requireSha256(input.idempotency_hash, 'idempotency_hash');
      const existingRef = this.#idempotency.get(idempotencyKey(tenantId, idempotencyHash));
      if (existingRef) {
        const existing = this.#invocations.get(invocationKey(tenantId, existingRef));
        if (existing.request_hash !== requestHash) {
          throw managedError(
            'Idempotency key was already used for a different request',
            'IDEMPOTENCY_CONFLICT',
            409,
          );
        }
        return deepFreeze({ created: false, invocation: publicInvocation(existing) });
      }
      if (this.#invocations.has(invocationKey(tenantId, invocationRef))) {
        throw managedError(
          'Generated invocation reference is already in use',
          'INVOCATION_REFERENCE_CONFLICT',
          503,
        );
      }
      const now = requireIso(input.now, 'admission.now');
      const tenant = this.#tenants.get(tenantId);
      if (!tenant || tenant.status !== 'active') {
        throw managedError('Tenant is not active', 'TENANT_NOT_ACTIVE', 403);
      }
      const hasRecoveryBacklog = [...this.#invocations.values()].some(
        (item) => item.tenant_id === tenantId && item.state === 'recovery_required',
      );
      if (hasRecoveryBacklog) {
        throw managedError(
          'Tenant has unresolved provider recovery work',
          'TENANT_RECOVERY_REQUIRED',
          503,
        );
      }
      const hasExpiredExecutionLease = [...this.#invocations.values()].some(
        (item) => item.tenant_id === tenantId
          && item.lease_kind === 'execution'
          && item.lease_expires_at !== null
          && Date.parse(item.lease_expires_at) <= Date.parse(now),
      );
      if (hasExpiredExecutionLease) {
        throw managedError(
          'Tenant has an expired execution requiring reconciliation',
          'TENANT_RECONCILIATION_REQUIRED',
          503,
        );
      }
      const estimatedCostMicros = requireInteger(
        input.estimated_cost_micros,
        'estimated_cost_micros',
        { min: 0, max: Number.MAX_SAFE_INTEGER },
      );
      const invocationCap = Math.min(
        input.limits.max_invocation_cost_micros,
        tenant.max_invocation_cost_micros,
      );
      if (estimatedCostMicros > invocationCap) {
        throw managedError('Invocation cost cap exceeded', 'INVOCATION_BUDGET_EXCEEDED', 429);
      }
      const concurrentCap = Math.min(
        input.limits.max_concurrent_invocations,
        tenant.max_concurrent_invocations,
      );
      const activeCount = [...this.#invocations.values()].filter(
        (item) => item.tenant_id === tenantId && ACTIVE_INVOCATION_STATES.includes(item.state),
      ).length;
      if (activeCount >= concurrentCap) {
        throw managedError('Tenant concurrency quota exceeded', 'CONCURRENCY_QUOTA_EXCEEDED', 429);
      }
      const day = utcDay(now);
      const key = usageKey(tenantId, day);
      const usage = this.#usage.get(key) ?? { reserved_micros: 0, spent_micros: 0 };
      const dailyCap = Math.min(input.limits.daily_budget_micros, tenant.daily_budget_micros);
      if (usage.reserved_micros + usage.spent_micros + estimatedCostMicros > dailyCap) {
        throw managedError('Tenant daily budget exceeded', 'DAILY_BUDGET_EXCEEDED', 429);
      }
      const record = {
        schema: MANAGED_INVOCATION_SCHEMA,
        invocation_ref: invocationRef,
        tenant_id: tenantId,
        admitted_key_id: requireOpaqueRef(input.key_id, 'admission.key_id'),
        provider_id: requireProviderId(input.provider_id),
        provider_binding_hash: requireSha256(input.provider_binding_hash, 'provider_binding_hash'),
        provider_adapter_digest: requireSha256(
          input.provider_adapter_digest,
          'provider_adapter_digest',
        ),
        provider_qualification_receipt_hash: requireSha256(
          input.provider_qualification_receipt_hash,
          'provider_qualification_receipt_hash',
        ),
        idempotency_hash: idempotencyHash,
        request_hash: requestHash,
        operation_hash: requireSha256(input.operation_hash, 'operation_hash'),
        operation: cloneJson(input.operation, 'operation'),
        estimated_cost_micros: estimatedCostMicros,
        actual_cost_micros: null,
        budget_day_utc: day,
        state: 'admitted',
        lease_kind: null,
        lease_owner: null,
        lease_token_hash: null,
        lease_expires_at: null,
        lease_generation: 0,
        savepoint_ref: null,
        fork_ref: null,
        cleanup_requests: [],
        provider_recovery_key: requireSha256(
          input.provider_recovery_key,
          'provider_recovery_key',
        ),
        execution_outcome: null,
        execution_evidence_hash: null,
        result_hash: null,
        admitted_at: now,
        updated_at: now,
        terminal_at: null,
        audit_head_hash: null,
        audit_event_count: 0,
        lease_claim_audit_hash: null,
      };
      assertManagedRecoveryKeyIntegrity(record);
      const auditDraft = this.#draftAudit(record, 'invocation_admitted', now, {
        request_hash: requestHash,
        operation_hash: record.operation_hash,
        provider_id: record.provider_id,
        provider_binding_hash: record.provider_binding_hash,
        provider_adapter_digest: record.provider_adapter_digest,
        provider_qualification_receipt_hash: record.provider_qualification_receipt_hash,
        estimated_cost_micros: estimatedCostMicros,
      });
      record.audit_head_hash = auditDraft.event.event_hash;
      record.audit_event_count = auditDraft.events.length;
      const result = deepFreeze({ created: true, invocation: publicInvocation(record) });
      this.#usage.set(key, {
        reserved_micros: usage.reserved_micros + estimatedCostMicros,
        spent_micros: usage.spent_micros,
      });
      this.#audit.set(auditDraft.key, auditDraft.events);
      this.#invocations.set(invocationKey(tenantId, invocationRef), record);
      this.#idempotency.set(idempotencyKey(tenantId, idempotencyHash), invocationRef);
      return result;
    });
  }

  async getInvocation(tenantIdValue, invocationRefValue, { includeOperation = false } = {}) {
    const tenantId = requireTenantId(tenantIdValue);
    const invocationRef = requireInvocationRef(invocationRefValue, 'invocation_ref');
    const record = this.#invocations.get(invocationKey(tenantId, invocationRef));
    if (!record) return null;
    if (includeOperation) return executionInvocation(record);
    return publicInvocation(record);
  }

  async assertActiveLease(input) {
    return this.#exclusive(async () => {
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
      const invocationRef = requireInvocationRef(input.invocation_ref, 'invocation_ref');
      const record = this.#invocations.get(invocationKey(tenantId, invocationRef));
      if (!record) throw managedError('Invocation was not found', 'INVOCATION_NOT_FOUND', 404);
      if (record.lease_token_hash !== requireSha256(input.lease_token_hash, 'lease_token_hash')) {
        throw managedError('Lease token is invalid', 'LEASE_TOKEN_INVALID', 403);
      }
      if (!['execution', 'cleanup', 'recovery'].includes(input.lease_kind)
        || record.lease_kind !== input.lease_kind) {
        throw managedError('Lease kind is invalid', 'LEASE_PREFLIGHT_FAILED', 409);
      }
      assertDataArray(input.expected_states, 'expected lease states', { maxLength: 4 });
      if (input.expected_states.length === 0
        || input.expected_states.some((state) => !INVOCATION_STATES.includes(state))
        || !input.expected_states.includes(record.state)) {
        throw managedError('Invocation state changed', 'INVOCATION_STATE_CONFLICT', 409);
      }
      const now = requireIso(input.now, 'lease preflight time');
      this.#assertLeaseClaimant(record, input.claimant_key_id, now);
      if (!record.lease_expires_at || Date.parse(record.lease_expires_at) <= Date.parse(now)) {
        throw managedError('Lease has expired', 'LEASE_EXPIRED', 409);
      }
      if (record.lease_kind === 'execution') {
        const tenant = this.#tenants.get(tenantId);
        if (!tenant || tenant.status !== 'active') {
          throw managedError('Tenant suspended execution authority', 'TENANT_NOT_ACTIVE', 403);
        }
      }
      return publicInvocation(record);
    });
  }

  async claimLease(input) {
    return this.#exclusive(async () => {
      const tenantId = requireTenantId(input.tenant_id);
      const invocationRef = requireInvocationRef(input.invocation_ref, 'invocation_ref');
      const key = invocationKey(tenantId, invocationRef);
      const record = this.#invocations.get(key);
      if (!record) throw managedError('Invocation was not found', 'INVOCATION_NOT_FOUND', 404);
      const purpose = input.purpose;
      const expectedState = purpose === 'execution'
        ? 'admitted'
        : purpose === 'cleanup'
          ? 'cleanup_pending'
          : 'recovery_required';
      if (!['execution', 'cleanup', 'recovery'].includes(purpose)) {
        throw new TypeError('lease purpose must be execution, cleanup, or recovery');
      }
      const now = requireIso(input.now, 'lease.now');
      const leaseMs = requireInteger(input.lease_ms, 'lease_ms', { min: 1_000, max: 900_000 });
      const expiresAt = requireIso(input.expires_at, 'lease.expires_at');
      if (Date.parse(expiresAt) !== Date.parse(now) + leaseMs) {
        throw new TypeError('lease.expires_at must equal lease.now plus lease_ms');
      }
      const claimantKeyId = this.#requireActiveClaimant(
        tenantId,
        input.claimant_key_id,
        now,
      );
      const workerInstanceRef = requireOpaqueRef(input.worker_id, 'worker_id');
      const tokenHash = requireSha256(input.lease_token_hash, 'lease_token_hash');
      if (purpose === 'execution') {
        const tenant = this.#tenants.get(tenantId);
        if (!tenant || tenant.status !== 'active') {
          throw managedError('Tenant suspended execution authority', 'TENANT_NOT_ACTIVE', 403);
        }
      }
      const activeLease = record.lease_kind !== null
        && record.lease_expires_at !== null
        && Date.parse(record.lease_expires_at) > Date.parse(now);
      if (activeLease) {
        const exactClaim = record.lease_owner === claimantKeyId
          && record.lease_kind === purpose
          && record.lease_token_hash === tokenHash;
        if (exactClaim) {
          const immediateClaimState = record.state === (purpose === 'execution'
            ? 'execution_leased'
            : expectedState);
          if (!immediateClaimState
            || record.audit_head_hash !== record.lease_claim_audit_hash) {
            throw managedError(
              'Lease claim has already progressed',
              'LEASE_CLAIM_ALREADY_PROGRESSED',
              409,
            );
          }
          if (purpose === 'execution') {
            assertExecutionWithinBudgetDay(
              record.budget_day_utc,
              now,
              record.lease_expires_at,
            );
          }
          return deepFreeze({
            claim_replayed: true,
            invocation: purpose === 'execution'
              ? executionInvocation(record)
              : publicInvocation(record),
          });
        }
        throw managedError('Invocation already has an active lease', 'LEASE_ALREADY_HELD', 409);
      }
      if (record.lease_kind !== null) {
        throw managedError('Prior lease must be reaped before another claim', 'LEASE_EXPIRED', 409);
      }
      if (this.#leaseTokenUses.has(leaseTokenUseKey(tenantId, tokenHash))) {
        throw managedError('Lease token was already used', 'LEASE_TOKEN_REPLAYED', 409);
      }
      if (record.state !== expectedState) {
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
      if (purpose === 'execution') {
        const maxInvocationAge = requireInteger(
          input.max_invocation_age_ms,
          'max_invocation_age_ms',
          { min: 10_000, max: 86_400_000 },
        );
        if (Date.parse(record.admitted_at) <= Date.parse(now) - maxInvocationAge) {
          throw managedError('Invocation admission has expired', 'INVOCATION_EXPIRED', 409);
        }
        const hasRecoveryBacklog = [...this.#invocations.values()].some(
          (item) => item.tenant_id === tenantId && item.state === 'recovery_required',
        );
        if (hasRecoveryBacklog) {
          throw managedError(
            'Tenant has unresolved provider recovery work',
            'TENANT_RECOVERY_REQUIRED',
            503,
          );
        }
        const hasExpiredExecutionLease = [...this.#invocations.values()].some(
          (item) => item.tenant_id === tenantId
            && item.lease_kind === 'execution'
            && item.lease_expires_at !== null
            && Date.parse(item.lease_expires_at) <= Date.parse(now),
        );
        if (hasExpiredExecutionLease) {
          throw managedError(
            'Tenant has an expired execution requiring reconciliation',
            'TENANT_RECONCILIATION_REQUIRED',
            503,
          );
        }
        assertExecutionWithinBudgetDay(record.budget_day_utc, now, expiresAt);
      }
      const next = cloneJson(record, 'lease claim record');
      next.lease_kind = purpose;
      next.lease_owner = claimantKeyId;
      next.lease_token_hash = tokenHash;
      next.lease_expires_at = expiresAt;
      next.lease_generation += 1;
      next.updated_at = now;
      if (purpose === 'execution') next.state = 'execution_leased';
      const prepared = this.#prepareAuditedRecord(next, `${purpose}_lease_claimed`, now, {
        claimant_key_id: claimantKeyId,
        worker_instance_ref: workerInstanceRef,
        expires_at: next.lease_expires_at,
        lease_generation: next.lease_generation,
      });
      next.lease_claim_audit_hash = prepared.event.event_hash;
      const workItem = purpose === 'execution'
        ? executionInvocation(next)
        : prepared.public_record;
      this.#leaseTokenUses.add(leaseTokenUseKey(tenantId, tokenHash));
      this.#commitAuditedRecord(prepared);
      return deepFreeze({ claim_replayed: false, invocation: workItem });
    });
  }

  async renewLease(input) {
    return this.#exclusive(async () => {
      const record = this.#requireLeasedRecord(input);
      this.#assertExecutionAllowed(record);
      const now = requireIso(input.now, 'lease.now');
      if (Date.parse(record.lease_expires_at) <= Date.parse(now)) {
        throw managedError('Lease has expired', 'LEASE_EXPIRED', 409);
      }
      const leaseMs = requireInteger(input.lease_ms, 'lease_ms', { min: 1_000, max: 900_000 });
      const expiresAt = requireIso(input.expires_at, 'lease.expires_at');
      if (Date.parse(expiresAt) !== Date.parse(now) + leaseMs) {
        throw new TypeError('lease.expires_at must equal lease.now plus lease_ms');
      }
      if (record.lease_kind === 'execution') {
        assertExecutionWithinBudgetDay(record.budget_day_utc, now, expiresAt);
      }
      const next = cloneJson(record, 'lease renewal record');
      next.lease_expires_at = expiresAt;
      next.updated_at = now;
      const prepared = this.#prepareAuditedRecord(next, `${next.lease_kind}_lease_renewed`, now, {
        expires_at: next.lease_expires_at,
        lease_generation: next.lease_generation,
      });
      return this.#commitAuditedRecord(prepared);
    });
  }

  #requireLeasedRecord(input) {
    const tenantId = requireTenantId(input.tenant_id);
    const invocationRef = requireInvocationRef(input.invocation_ref, 'invocation_ref');
    const record = this.#invocations.get(invocationKey(tenantId, invocationRef));
    if (!record) throw managedError('Invocation was not found', 'INVOCATION_NOT_FOUND', 404);
    const tokenHash = requireSha256(input.lease_token_hash, 'lease_token_hash');
    if (record.lease_token_hash !== tokenHash) {
      throw managedError('Lease token is invalid', 'LEASE_TOKEN_INVALID', 403);
    }
    this.#assertLeaseClaimant(record, input.claimant_key_id, input.now);
    return record;
  }

  #requireActiveClaimant(tenantIdValue, claimantKeyIdValue, nowValue) {
    const tenantId = requireTenantId(tenantIdValue);
    const claimantKeyId = requireOpaqueRef(claimantKeyIdValue, 'claimant_key_id');
    const now = requireIso(nowValue, 'claimant credential time');
    const claimantCredential = [...this.#credentials.values()].find(
      (credential) => credential.key_id === claimantKeyId,
    );
    if (!claimantCredential
      || claimantCredential.tenant_id !== tenantId
      || claimantCredential.revoked_at !== null
      || Date.parse(claimantCredential.not_before) > Date.parse(now)
      || Date.parse(claimantCredential.expires_at) <= Date.parse(now)) {
      throw managedError('Claimant credential is not active', 'AUTHENTICATION_FAILED', 401);
    }
    return claimantKeyId;
  }

  #assertLeaseClaimant(record, claimantKeyIdValue, nowValue) {
    const claimantKeyId = requireOpaqueRef(claimantKeyIdValue, 'claimant_key_id');
    if (record.lease_owner !== claimantKeyId) {
      throw managedError('Lease belongs to a different credential', 'LEASE_OWNER_MISMATCH', 403);
    }
    this.#requireActiveClaimant(record.tenant_id, claimantKeyId, nowValue);
  }

  #matchingResourceJournalReceipt({
    tenantId,
    invocationRef,
    requestHash,
    claimantKeyId,
    leaseTokenHash,
  }) {
    const stored = this.#resourceJournalReceipts.get(
      resourceJournalReceiptKey(tenantId, invocationRef, requestHash),
    );
    if (!stored) return null;
    const receipt = normalizeManagedResourceJournalReceipt(stored);
    if (receipt.tenant_id !== tenantId
      || receipt.invocation_ref !== invocationRef
      || receipt.request_hash !== requestHash
      || receipt.claimant_key_id !== claimantKeyId
      || receipt.lease_token_hash !== leaseTokenHash) {
      throw managedError(
        'Resource journal receipt metadata is inconsistent',
        'RESOURCE_JOURNAL_RECEIPT_INTEGRITY_FAILED',
        503,
      );
    }
    return receipt;
  }

  #assertExecutionAllowed(record) {
    if (record.lease_kind !== 'execution') return;
    const tenant = this.#tenants.get(record.tenant_id);
    if (!tenant || tenant.status !== 'active') {
      throw managedError('Tenant suspended execution authority', 'TENANT_NOT_ACTIVE', 403);
    }
  }

  async transitionInvocation(input) {
    return this.#exclusive(async () => {
      const resourceJournalRequestHash = input.resource_journal_request_hash == null
        ? null
        : requireSha256(
          input.resource_journal_request_hash,
          'resource_journal_request_hash',
        );
      if (resourceJournalRequestHash !== null) {
        if (!RESOURCE_JOURNAL_EVENT_TYPES.has(input.event_type)) {
          throw new TypeError('resource journal receipt requires a resource journal event');
        }
        const tenantId = requireTenantId(input.tenant_id);
        const invocationRef = requireInvocationRef(input.invocation_ref, 'invocation_ref');
        const claimantKeyId = requireOpaqueRef(input.claimant_key_id, 'claimant_key_id');
        const leaseTokenHash = requireSha256(input.lease_token_hash, 'lease_token_hash');
        const receiptNow = requireIso(input.now, 'resource journal receipt time');
        this.#requireActiveClaimant(tenantId, claimantKeyId, receiptNow);
        const priorReceipt = this.#matchingResourceJournalReceipt({
          tenantId,
          invocationRef,
          requestHash: resourceJournalRequestHash,
          claimantKeyId,
          leaseTokenHash,
        });
        if (priorReceipt !== null) return priorReceipt.response;
      }
      const record = this.#requireLeasedRecord(input);
      this.#assertExecutionAllowed(record);
      const now = requireIso(input.now, 'transition.now');
      if (Date.parse(record.lease_expires_at) <= Date.parse(now)) {
        throw managedError('Lease has expired', 'LEASE_EXPIRED', 409);
      }
      if (!input.expected_states.includes(record.state)) {
        throw managedError('Invocation state changed', 'INVOCATION_STATE_CONFLICT', 409);
      }
      if (record.audit_event_count !== requireInteger(
        input.expected_audit_event_count,
        'expected_audit_event_count',
      )) {
        throw managedError('Invocation version changed', 'INVOCATION_STATE_CONFLICT', 409);
      }
      const previousState = record.state;
      const allowedTransitions = {
        execution_leased: ['execution_leased', 'running'],
        running: ['cleanup_pending'],
        cleanup_pending: ['completed', 'failed_closed'],
        recovery_required: ['cleanup_pending', 'failed_closed'],
      };
      if (!INVOCATION_STATES.includes(input.next_state)
        || !allowedTransitions[previousState]?.includes(input.next_state)) {
        throw managedError('Invocation transition is invalid', 'INVOCATION_TRANSITION_INVALID', 409);
      }
      const terminal = TERMINAL_INVOCATION_STATES.includes(input.next_state);
      if (terminal) {
        const verificationNotAfter = requireIso(
          input.verification_not_after,
          'verification_not_after',
        );
        if (Date.parse(now) > Date.parse(verificationNotAfter)) {
          throw managedError(
            'Provider verification expired before the terminal transition',
            'VERIFICATION_DEADLINE_EXCEEDED',
            409,
          );
        }
      } else if (input.verification_not_after != null) {
        throw new TypeError('verification_not_after is only valid for terminal transitions');
      }
      const patch = cloneJson(input.patch ?? {}, 'transition patch');
      assertPlainRecord(patch, 'transition patch');
      const patchKeys = previousState === 'execution_leased'
        ? ['savepoint_ref', 'fork_ref', 'cleanup_requests']
        : previousState === 'recovery_required'
          ? ['savepoint_ref', 'fork_ref', 'cleanup_requests']
        : previousState === 'running'
          ? ['execution_outcome', 'execution_evidence_hash', 'result_hash']
          : [];
      assertAllowedKeys(patch, patchKeys, 'transition patch');
      const eventDetails = cloneJson(input.event_details ?? {}, 'transition event details');
      const next = cloneJson(record, 'transition record');
      Object.assign(next, patch);
      next.state = input.next_state;
      next.updated_at = now;
      const releasesLease = terminal
        || ((previousState === 'running' || previousState === 'recovery_required')
          && next.state === 'cleanup_pending');
      if (terminal) next.terminal_at = now;
      if (releasesLease) {
        next.lease_kind = null;
        next.lease_owner = null;
        next.lease_token_hash = null;
        next.lease_expires_at = null;
      }
      const prepared = this.#prepareAuditedRecord(next, input.event_type, now, {
        from_state: previousState,
        to_state: next.state,
        ...eventDetails,
      });
      if (resourceJournalRequestHash !== null) {
        const receipt = createManagedResourceJournalReceipt({
          tenantId: record.tenant_id,
          invocationRef: record.invocation_ref,
          requestHash: resourceJournalRequestHash,
          claimantKeyId: input.claimant_key_id,
          leaseTokenHash: input.lease_token_hash,
          response: prepared.public_record,
          createdAt: now,
        });
        this.#resourceJournalReceipts.set(
          resourceJournalReceiptKey(
            receipt.tenant_id,
            receipt.invocation_ref,
            receipt.request_hash,
          ),
          receipt,
        );
        this.#commitAuditedRecord(prepared);
        return receipt.response;
      }
      return this.#commitAuditedRecord(prepared);
    });
  }

  async settleExecutionOutcome(input) {
    return this.#exclusive(async () => {
      const record = this.#requireLeasedRecord(input);
      this.#assertExecutionAllowed(record);
      const now = requireIso(input.now, 'execution outcome time');
      if (Date.parse(record.lease_expires_at) <= Date.parse(now)) {
        throw managedError('Lease has expired', 'LEASE_EXPIRED', 409);
      }
      if (record.state !== 'running' || record.cleanup_requests.length !== 2) {
        throw managedError('Provider resources are not recorded', 'RESOURCES_NOT_RECORDED', 409);
      }
      if (record.actual_cost_micros !== null) {
        throw managedError('Execution outcome is already settled', 'INVOCATION_STATE_CONFLICT', 409);
      }
      const actual = requireInteger(input.actual_cost_micros, 'actual_cost_micros', {
        min: 0,
        max: record.estimated_cost_micros,
      });
      if (input.execution_outcome !== 'succeeded' && input.execution_outcome !== 'failed') {
        throw new TypeError('execution_outcome must be succeeded or failed');
      }
      const executionEvidenceHash = requireSha256(
        input.execution_evidence_hash,
        'execution_evidence_hash',
      );
      const resultHash = requireSha256(input.result_hash, 'result_hash');
      const usage = this.#usage.get(usageKey(record.tenant_id, record.budget_day_utc));
      if (!usage || usage.reserved_micros < record.estimated_cost_micros) {
        throw new Error('Budget reservation invariant failed');
      }
      const nextUsage = {
        reserved_micros: usage.reserved_micros - record.estimated_cost_micros,
        spent_micros: usage.spent_micros + actual,
      };
      const next = cloneJson(record, 'execution outcome record');
      next.actual_cost_micros = actual;
      next.state = 'cleanup_pending';
      next.execution_outcome = input.execution_outcome;
      next.execution_evidence_hash = executionEvidenceHash;
      next.result_hash = resultHash;
      next.lease_kind = null;
      next.lease_owner = null;
      next.lease_token_hash = null;
      next.lease_expires_at = null;
      next.updated_at = now;
      const prepared = this.#prepareAuditedRecord(next, 'execution_outcome_recorded', now, {
        from_state: 'running',
        to_state: 'cleanup_pending',
        outcome: input.execution_outcome,
        actual_cost_micros: actual,
      });
      this.#usage.set(usageKey(record.tenant_id, record.budget_day_utc), nextUsage);
      return this.#commitAuditedRecord(prepared);
    });
  }

  async listExpiredLeases(nowValue, limitValue = 100) {
    const now = requireIso(nowValue, 'expired lease query time');
    const limit = requireInteger(limitValue, 'expired lease query limit', { min: 1, max: 1_000 });
    return [...this.#invocations.values()]
      .filter((record) => record.lease_expires_at !== null
        && Date.parse(record.lease_expires_at) <= Date.parse(now)
        && record.lease_kind !== null)
      .sort((left, right) => left.lease_expires_at.localeCompare(right.lease_expires_at))
      .slice(0, limit)
      .map(publicInvocation);
  }

  async releaseExpiredLease(input) {
    return this.#exclusive(async () => {
      const tenantId = requireTenantId(input.tenant_id);
      const invocationRef = requireInvocationRef(input.invocation_ref, 'invocation_ref');
      const record = this.#invocations.get(invocationKey(tenantId, invocationRef));
      if (!record) return null;
      const now = requireIso(input.now, 'expired lease release time');
      if (record.lease_expires_at === null || Date.parse(record.lease_expires_at) > Date.parse(now)) {
        return publicInvocation(record);
      }
      const expiredKind = record.lease_kind;
      const next = cloneJson(record, 'expired lease record');
      let nextUsage = null;
      if (expiredKind === 'execution') {
        if (record.actual_cost_micros === null) {
          const usage = this.#usage.get(usageKey(record.tenant_id, record.budget_day_utc));
          if (!usage || usage.reserved_micros < record.estimated_cost_micros) {
            throw new Error('Budget reservation invariant failed');
          }
          nextUsage = {
            reserved_micros: usage.reserved_micros - record.estimated_cost_micros,
            spent_micros: usage.spent_micros + record.estimated_cost_micros,
          };
          next.actual_cost_micros = record.estimated_cost_micros;
        } else if (record.actual_cost_micros < record.estimated_cost_micros) {
          const usage = this.#usage.get(usageKey(record.tenant_id, record.budget_day_utc));
          if (!usage) throw new Error('Budget reservation invariant failed');
          nextUsage = {
            reserved_micros: usage.reserved_micros,
            spent_micros:
              usage.spent_micros + record.estimated_cost_micros - record.actual_cost_micros,
          };
          next.actual_cost_micros = record.estimated_cost_micros;
        }
        const hasRecordedResources = record.state === 'running'
          && record.cleanup_requests.length === 2;
        next.state = hasRecordedResources ? 'cleanup_pending' : 'recovery_required';
        next.execution_outcome = 'ambiguous';
      }
      next.lease_kind = null;
      next.lease_owner = null;
      next.lease_token_hash = null;
      next.lease_expires_at = null;
      next.updated_at = now;
      const prepared = this.#prepareAuditedRecord(next, `${expiredKind}_lease_expired`, now, {
        resulting_state: next.state,
        resource_tracking: expiredKind === 'execution' && next.state === 'recovery_required'
          ? 'unavailable_or_incomplete'
          : 'recorded_or_not_applicable',
      });
      if (nextUsage !== null) {
        this.#usage.set(usageKey(record.tenant_id, record.budget_day_utc), nextUsage);
      }
      return this.#commitAuditedRecord(prepared);
    });
  }

  async listStaleAdmissions(nowValue, maxAgeValue, limitValue = 100) {
    const now = requireIso(nowValue, 'stale admission query time');
    const maxAge = requireInteger(maxAgeValue, 'stale admission max age', {
      min: 10_000,
      max: 86_400_000,
    });
    const limit = requireInteger(limitValue, 'stale admission query limit', { min: 1, max: 1_000 });
    const cutoff = Date.parse(now) - maxAge;
    return [...this.#invocations.values()]
      .filter((record) => record.state === 'admitted' && Date.parse(record.admitted_at) <= cutoff)
      .sort((left, right) => left.admitted_at.localeCompare(right.admitted_at))
      .slice(0, limit)
      .map(publicInvocation);
  }

  async releaseStaleAdmission(input) {
    return this.#exclusive(async () => {
      const tenantId = requireTenantId(input.tenant_id);
      const invocationRef = requireInvocationRef(input.invocation_ref, 'invocation_ref');
      const record = this.#invocations.get(invocationKey(tenantId, invocationRef));
      if (!record) return null;
      const now = requireIso(input.now, 'stale admission release time');
      const maxAge = requireInteger(input.max_age_ms, 'stale admission max age', {
        min: 10_000,
        max: 86_400_000,
      });
      if (record.state !== 'admitted'
        || Date.parse(record.admitted_at) > Date.parse(now) - maxAge) {
        return publicInvocation(record);
      }
      const usage = this.#usage.get(usageKey(record.tenant_id, record.budget_day_utc));
      if (!usage || usage.reserved_micros < record.estimated_cost_micros) {
        throw new Error('Budget reservation invariant failed');
      }
      const nextUsage = {
        reserved_micros: usage.reserved_micros - record.estimated_cost_micros,
        spent_micros: usage.spent_micros,
      };
      const next = cloneJson(record, 'stale admission record');
      next.actual_cost_micros = 0;
      next.state = 'failed_closed';
      next.terminal_at = now;
      next.updated_at = now;
      const prepared = this.#prepareAuditedRecord(next, 'stale_admission_expired', now, {
        admitted_at: next.admitted_at,
        max_age_ms: maxAge,
      });
      this.#usage.set(usageKey(record.tenant_id, record.budget_day_utc), nextUsage);
      return this.#commitAuditedRecord(prepared);
    });
  }

  async listAuditEvents(tenantIdValue, invocationRefValue) {
    const tenantId = requireTenantId(tenantIdValue);
    const invocationRef = requireInvocationRef(invocationRefValue, 'invocation_ref');
    return deepFreeze(cloneJson(
      this.#audit.get(invocationKey(tenantId, invocationRef)) ?? [],
      'audit events',
    ));
  }

  async getAuditSnapshot(tenantIdValue, invocationRefValue) {
    const tenantId = requireTenantId(tenantIdValue);
    const invocationRef = requireInvocationRef(invocationRefValue, 'invocation_ref');
    return this.#exclusive(async () => {
      const key = invocationKey(tenantId, invocationRef);
      const record = this.#invocations.get(key);
      if (!record) return null;
      return deepFreeze({
        invocation: publicInvocation(record),
        events: cloneJson(this.#audit.get(key) ?? [], 'audit events'),
      });
    });
  }

  async providerBindingObligations(limitValue = 10_000) {
    const limit = requireInteger(limitValue, 'provider binding obligation limit', {
      min: 1,
      max: 10_000,
    });
    const bindings = new Map();
    for (const record of this.#invocations.values()) {
      if (TERMINAL_INVOCATION_STATES.includes(record.state)) continue;
      const key = `${record.tenant_id}\u0000${record.provider_id}\u0000${record.provider_binding_hash}`;
      const requiresEnabled = ['admitted', 'execution_leased', 'running'].includes(record.state);
      if (!bindings.has(key)) {
        bindings.set(key, {
          tenant_id: record.tenant_id,
          provider_id: record.provider_id,
          provider_binding_hash: record.provider_binding_hash,
          requires_enabled: requiresEnabled,
        });
      } else if (requiresEnabled) {
        bindings.get(key).requires_enabled = true;
      }
    }
    const values = [...bindings.values()].sort((left, right) => (
      `${left.tenant_id}\u0000${left.provider_id}\u0000${left.provider_binding_hash}`
        .localeCompare(`${right.tenant_id}\u0000${right.provider_id}\u0000${right.provider_binding_hash}`)
    ));
    return deepFreeze({
      complete: values.length <= limit,
      bindings: values.slice(0, limit),
    });
  }

  async health(nowValue = new Date()) {
    const now = requireIso(nowValue, 'health.now');
    const recoveryRequiredCount = [...this.#invocations.values()].filter(
      (record) => record.state === 'recovery_required',
    ).length;
    const expiredExecutionLeaseCount = [...this.#invocations.values()].filter(
      (record) => record.lease_kind === 'execution'
        && record.lease_expires_at !== null
        && Date.parse(record.lease_expires_at) <= Date.parse(now),
    ).length;
    return deepFreeze({
      ready: recoveryRequiredCount === 0 && expiredExecutionLeaseCount === 0,
      backend: 'memory_local_test',
      durable: false,
      tenant_count: this.#tenants.size,
      recovery_required_count: recoveryRequiredCount,
      expired_execution_lease_count: expiredExecutionLeaseCount,
    });
  }
}
