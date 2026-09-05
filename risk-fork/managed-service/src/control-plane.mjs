import { createHash, randomUUID } from 'node:crypto';
import { sha256Ref } from '../../src/canonical.mjs';
import { validateChildOperation } from '../../src/child-operation.mjs';
import {
  createCleanupVerificationRequest,
  verifyCleanupVerificationEvidence,
  verifyCleanupVerificationRequest,
} from '../../src/provider.mjs';
import { verifyManagedAuditChain } from './audit.mjs';
import { assertManagedPrincipalVerifier } from './auth.mjs';
import {
  assertManagedServiceConfig,
  assertManagedServiceEnabled,
  createManagedServiceConfig,
} from './config.mjs';
import {
  MANAGED_SERVICE_PROTOCOL_LIMITS,
} from './constants.mjs';
import {
  assertAllowedKeys,
  assertDataArray,
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
  requireString,
  requireTenantId,
} from './validation.mjs';
import {
  assertManagedRecoveryKeyIntegrity,
  managedClientRequestHash,
  managedProviderRecoveryKey,
  managedResourceJournalRequestHash,
  normalizeManagedResourceJournalReceipt,
} from './invocation-integrity.mjs';

const REQUIRED_STORE_METHODS = Object.freeze([
  'resolveCredential',
  'findIdempotentInvocation',
  'findResourceJournalReceipt',
  'admitInvocation',
  'getInvocation',
  'assertActiveLease',
  'claimLease',
  'renewLease',
  'transitionInvocation',
  'settleExecutionOutcome',
  'listExpiredLeases',
  'releaseExpiredLease',
  'listStaleAdmissions',
  'releaseStaleAdmission',
  'getAuditSnapshot',
  'listAuditEvents',
  'providerBindingObligations',
  'health',
]);

function hashOpaque(domain, value) {
  return `sha256:${createHash('sha256')
    .update(domain, 'utf8')
    .update('\0', 'utf8')
    .update(value, 'utf8')
    .digest('hex')}`;
}

async function normalizePrincipal(value, requiredScope, requirePrincipal) {
  await requirePrincipal(value, requiredScope);
  return {
    key_id: requireOpaqueRef(value.key_id, 'principal.key_id'),
    tenant_id: requireTenantId(value.tenant_id, 'principal.tenant_id'),
    scopes: [...value.scopes],
  };
}

function assertStore(store) {
  if (!store || typeof store !== 'object') throw new TypeError('managed service store is required');
  for (const method of REQUIRED_STORE_METHODS) {
    if (typeof store[method] !== 'function') {
      throw new TypeError(`managed service store.${method} must be a function`);
    }
  }
  return store;
}

function calculateLeaseWindow(now, leaseMs) {
  const duration = requireInteger(leaseMs, 'lease_ms', {
    min: MANAGED_SERVICE_PROTOCOL_LIMITS.min_lease_ms,
    max: MANAGED_SERVICE_PROTOCOL_LIMITS.max_lease_ms,
  });
  return new Date(Date.parse(now) + duration).toISOString();
}

const LEASE_TOKEN_PATTERN = /^[A-Za-z0-9._~-]{32,512}$/;

function requireLeaseToken(value) {
  const token = requireString(value, 'lease_token', { minBytes: 32, maxBytes: 512 });
  if (!LEASE_TOKEN_PATTERN.test(token)) {
    throw new TypeError('lease_token must be a strongly generated URL-safe token');
  }
  return token;
}

function requireInvocationOwner(principal, invocation) {
  if (!invocation || invocation.tenant_id !== principal.tenant_id) {
    throw managedError('Invocation was not found', 'INVOCATION_NOT_FOUND', 404);
  }
  return invocation;
}

function requireResourceJournalResponse(principal, invocationValue) {
  const invocation = assertManagedRecoveryKeyIntegrity(
    requireInvocationOwner(principal, invocationValue),
  );
  if (Object.hasOwn(invocation, 'operation')
    || Object.hasOwn(invocation, 'lease_token_hash')
    || Object.hasOwn(invocation, 'lease_claim_audit_hash')) {
    throw managedError(
      'Resource journal response exposed internal invocation data',
      'RESOURCE_JOURNAL_RECEIPT_INTEGRITY_FAILED',
      503,
    );
  }
  return deepFreeze(cloneJson(invocation, 'resource journal response'));
}

function requireResourceJournalReceipt(principal, value, expected) {
  const receipt = normalizeManagedResourceJournalReceipt(value);
  if (receipt.tenant_id !== principal.tenant_id
    || receipt.invocation_ref !== expected.invocation_ref
    || receipt.request_hash !== expected.request_hash
    || receipt.claimant_key_id !== principal.key_id
    || receipt.lease_token_hash !== expected.lease_token_hash) {
    throw managedError(
      'Resource journal receipt metadata is inconsistent',
      'RESOURCE_JOURNAL_RECEIPT_INTEGRITY_FAILED',
      503,
    );
  }
  return requireResourceJournalResponse(principal, receipt.response);
}

export function verifyManagedCleanupPlan(invocationValue) {
  assertPlainRecord(invocationValue, 'managed invocation');
  const providerId = requireProviderId(invocationValue.provider_id, 'invocation.provider_id');
  const expected = new Map();
  if (invocationValue.fork_ref !== null) {
    expected.set('fork', requireOpaqueRef(invocationValue.fork_ref, 'invocation.fork_ref'));
  }
  if (invocationValue.savepoint_ref !== null) {
    expected.set(
      'savepoint',
      requireOpaqueRef(invocationValue.savepoint_ref, 'invocation.savepoint_ref'),
    );
  }
  assertDataArray(invocationValue.cleanup_requests, 'invocation.cleanup_requests', { maxLength: 2 });
  if (invocationValue.cleanup_requests.length !== expected.size) {
    throw managedError('Stored cleanup plan is incomplete', 'CLEANUP_PLAN_INTEGRITY_FAILED', 503);
  }
  const requests = [];
  const seen = new Set();
  for (const requestValue of invocationValue.cleanup_requests) {
    const request = verifyCleanupVerificationRequest(requestValue);
    if (request.provider_id !== providerId
      || seen.has(request.resource_kind)
      || expected.get(request.resource_kind) !== request.resource_ref) {
      throw managedError('Stored cleanup plan is inconsistent', 'CLEANUP_PLAN_INTEGRITY_FAILED', 503);
    }
    seen.add(request.resource_kind);
    requests.push(request);
  }
  if ([...expected.keys()].some((kind) => !seen.has(kind))) {
    throw managedError('Stored cleanup plan is incomplete', 'CLEANUP_PLAN_INTEGRITY_FAILED', 503);
  }
  return deepFreeze(requests);
}

export function createManagedRiskForkControlPlane(options = {}) {
  assertPlainRecord(options, 'control plane options');
  assertAllowedKeys(options, [
    'config',
    'store',
    'providerRegistry',
    'clock',
    'invocationRef',
    'requestNonce',
    'requirePrincipal',
  ], 'control plane options');
  const config = options.config ?? createManagedServiceConfig();
  assertManagedServiceConfig(config);
  const store = assertStore(options.store);
  const providerRegistry = options.providerRegistry;
  if (!providerRegistry
    || typeof providerRegistry.requireEligible !== 'function'
    || typeof providerRegistry.admissionBinding !== 'function'
    || typeof providerRegistry.requireBound !== 'function'
    || typeof providerRegistry.hasBound !== 'function'
    || typeof providerRegistry.verifyResourceBinding !== 'function'
    || typeof providerRegistry.verifyCleanupEvidence !== 'function'
    || typeof providerRegistry.verifyRecoveryAbsence !== 'function'
    || typeof providerRegistry.summary !== 'function') {
    throw new TypeError('providerRegistry must implement the managed registry contract');
  }
  const clock = options.clock ?? (() => new Date());
  const invocationRef = options.invocationRef ?? (() => `rfi_${randomUUID()}`);
  const requestNonce = options.requestNonce ?? (() => `nonce_${randomUUID()}`);
  const requirePrincipal = assertManagedPrincipalVerifier(options.requirePrincipal, store);
  for (const [label, callback] of Object.entries({ clock, invocationRef, requestNonce })) {
    if (typeof callback !== 'function') throw new TypeError(`${label} must be a function`);
  }

  function enabled() {
    assertManagedServiceEnabled(config);
  }

  async function ownedInvocation(principal, invocationRefValue, includeOperation = false) {
    const ref = requireInvocationRef(invocationRefValue, 'invocation_ref');
    return assertManagedRecoveryKeyIntegrity(requireInvocationOwner(
      principal,
      await store.getInvocation(principal.tenant_id, ref, { includeOperation }),
    ));
  }

  async function claim(principalValue, input, purpose) {
    enabled();
    const principal = await normalizePrincipal(principalValue, 'worker:claim', requirePrincipal);
    assertPlainRecord(input, `${purpose} lease request`);
    assertAllowedKeys(
      input,
      ['invocation_ref', 'worker_id', 'lease_ms', 'lease_token'],
      `${purpose} lease request`,
    );
    const includeOperation = purpose === 'execution';
    const existing = await ownedInvocation(principal, input.invocation_ref, includeOperation);
    providerRegistry.requireBound(
      existing.provider_id,
      principal.tenant_id,
      existing.provider_binding_hash,
      { allowDisabled: purpose !== 'execution' },
    );
    const now = requireIso(clock(), 'clock result');
    const token = requireLeaseToken(input.lease_token);
    const tokenHash = hashOpaque('agoragentic-risk-fork-managed-lease-v1', token);
    const expiresAt = calculateLeaseWindow(now, input.lease_ms);
    const claimResult = await store.claimLease({
      tenant_id: principal.tenant_id,
      invocation_ref: existing.invocation_ref,
      worker_id: requireOpaqueRef(input.worker_id, 'worker_id'),
      claimant_key_id: requireOpaqueRef(principal.key_id, 'principal key_id'),
      purpose,
      lease_token_hash: tokenHash,
      lease_ms: Date.parse(expiresAt) - Date.parse(now),
      min_lease_ms: config.limits.min_lease_ms,
      max_lease_ms: config.limits.max_lease_ms,
      max_invocation_age_ms: config.limits.max_invocation_age_ms,
      now,
      expires_at: expiresAt,
    });
    assertPlainRecord(claimResult, 'lease claim result');
    assertAllowedKeys(claimResult, ['claim_replayed', 'invocation'], 'lease claim result');
    if (typeof claimResult.claim_replayed !== 'boolean') {
      throw new TypeError('lease claim result.claim_replayed must be a boolean');
    }
    const workItem = assertManagedRecoveryKeyIntegrity(
      requireInvocationOwner(principal, claimResult.invocation),
    );
    if (includeOperation && !Object.hasOwn(workItem, 'operation')) {
      throw managedError(
        'Execution claim did not return its exact operation',
        'OPERATION_INTEGRITY_FAILED',
        503,
      );
    }
    if (!includeOperation && Object.hasOwn(workItem, 'operation')) {
      throw managedError(
        'Non-execution claim exposed operation data',
        'OPERATION_DISCLOSURE_BLOCKED',
        503,
      );
    }
    return deepFreeze({
      lease_token: token,
      claim_replayed: claimResult.claim_replayed,
      invocation: workItem,
      production_authority: false,
      live_traffic_authority: false,
    });
  }

  return Object.freeze({
    config,

    async admitInvocation(principalValue, input = {}) {
      enabled();
      const principal = await normalizePrincipal(principalValue, 'invocations:write', requirePrincipal);
      assertPlainRecord(input, 'invocation request');
      assertAllowedKeys(input, [
        'idempotency_key',
        'provider_id',
        'operation',
        'estimated_cost_micros',
      ], 'invocation request');
      const idempotency = requireString(input.idempotency_key, 'idempotency_key', {
        minBytes: 16,
        maxBytes: MANAGED_SERVICE_PROTOCOL_LIMITS.max_idempotency_key_bytes,
      });
      const providerId = requireProviderId(input.provider_id);
      const operation = validateChildOperation(
        cloneJson(input.operation, 'invocation operation'),
        'invocation operation',
      );
      const estimatedCostMicros = requireInteger(
        input.estimated_cost_micros,
        'estimated_cost_micros',
        { min: 0, max: MANAGED_SERVICE_PROTOCOL_LIMITS.max_invocation_cost_micros },
      );
      const idempotencyHash = sha256Ref({
        tenant_id: principal.tenant_id,
        idempotency_key: idempotency,
      });
      const clientRequest = {
        provider_id: providerId,
        operation,
        estimated_cost_micros: estimatedCostMicros,
      };
      const requestBytes = Buffer.byteLength(JSON.stringify(clientRequest), 'utf8');
      if (requestBytes > MANAGED_SERVICE_PROTOCOL_LIMITS.max_request_bytes) {
        throw managedError('Invocation request is too large', 'REQUEST_TOO_LARGE', 413);
      }
      const requestHash = managedClientRequestHash({
        providerId,
        operation,
        estimatedCostMicros,
      });
      const replay = await store.findIdempotentInvocation({
        tenant_id: principal.tenant_id,
        idempotency_hash: idempotencyHash,
        request_hash: requestHash,
      });
      if (replay !== null) return replay;

      if (Buffer.byteLength(idempotency, 'utf8') > config.limits.max_idempotency_key_bytes) {
        throw new TypeError(
          `idempotency_key must be between 16 and ${config.limits.max_idempotency_key_bytes} bytes`,
        );
      }
      requireInteger(estimatedCostMicros, 'estimated_cost_micros', {
        min: 0,
        max: config.limits.max_invocation_cost_micros,
      });
      if (requestBytes > config.limits.max_request_bytes) {
        throw managedError('Invocation request is too large', 'REQUEST_TOO_LARGE', 413);
      }

      const providerBinding = providerRegistry.admissionBinding(providerId, principal.tenant_id);
      const invocationReference = requireInvocationRef(invocationRef(), 'invocation reference');
      const providerRecoveryKey = managedProviderRecoveryKey({
        tenantId: principal.tenant_id,
        idempotencyHash,
        providerBindingHash: providerBinding.provider_binding_hash,
      });
      const now = requireIso(clock(), 'clock result');
      return store.admitInvocation({
        tenant_id: principal.tenant_id,
        key_id: principal.key_id,
        invocation_ref: invocationReference,
        idempotency_hash: idempotencyHash,
        request_hash: requestHash,
        operation_hash: sha256Ref(operation),
        operation,
        provider_id: providerId,
        provider_binding_hash: providerBinding.provider_binding_hash,
        provider_adapter_digest: providerBinding.provider_adapter_digest,
        provider_qualification_receipt_hash:
          providerBinding.provider_qualification_receipt_hash,
        provider_recovery_key: providerRecoveryKey,
        estimated_cost_micros: estimatedCostMicros,
        now,
        limits: config.limits,
      });
    },

    async getInvocation(principalValue, invocationRefValue) {
      enabled();
      const principal = await normalizePrincipal(principalValue, 'invocations:read', requirePrincipal);
      return ownedInvocation(principal, invocationRefValue, false);
    },

    async claimExecution(principal, input) {
      return claim(principal, input, 'execution');
    },

    async claimCleanup(principal, input) {
      return claim(principal, input, 'cleanup');
    },

    async claimRecovery(principal, input) {
      return claim(principal, input, 'recovery');
    },

    async renewLease(principalValue, input = {}) {
      enabled();
      const principal = await normalizePrincipal(principalValue, 'worker:write', requirePrincipal);
      assertPlainRecord(input, 'lease renewal');
      assertAllowedKeys(input, ['invocation_ref', 'lease_token', 'lease_ms'], 'lease renewal');
      const requestedInvocationRef = requireInvocationRef(input.invocation_ref, 'invocation_ref');
      const token = requireLeaseToken(input.lease_token);
      const requestedLeaseMs = requireInteger(input.lease_ms, 'lease_ms', {
        min: config.limits.min_lease_ms,
        max: config.limits.max_lease_ms,
      });
      const invocation = await ownedInvocation(principal, requestedInvocationRef, false);
      providerRegistry.requireBound(
        invocation.provider_id,
        principal.tenant_id,
        invocation.provider_binding_hash,
        { allowDisabled: invocation.lease_kind !== 'execution' },
      );
      const now = requireIso(clock(), 'clock result');
      const expiresAt = calculateLeaseWindow(now, requestedLeaseMs);
      return store.renewLease({
        tenant_id: principal.tenant_id,
        claimant_key_id: principal.key_id,
        invocation_ref: invocation.invocation_ref,
        lease_token_hash: hashOpaque('agoragentic-risk-fork-managed-lease-v1', token),
        lease_ms: Date.parse(expiresAt) - Date.parse(now),
        now,
        expires_at: expiresAt,
      });
    },

    async recordResources(principalValue, input = {}) {
      enabled();
      const principal = await normalizePrincipal(principalValue, 'worker:write', requirePrincipal);
      assertPlainRecord(input, 'resource record');
      assertAllowedKeys(input, [
        'invocation_ref',
        'lease_token',
        'savepoint_ref',
        'fork_ref',
        'absent_resource_kinds',
      ], 'resource record');
      const invocationRefValue = requireInvocationRef(input.invocation_ref, 'invocation_ref');
      const suppliedSavepointRef = input.savepoint_ref == null
        ? null
        : requireOpaqueRef(input.savepoint_ref, 'savepoint_ref');
      const suppliedForkRef = input.fork_ref == null
        ? null
        : requireOpaqueRef(input.fork_ref, 'fork_ref');
      const absentResourceKinds = input.absent_resource_kinds ?? [];
      assertDataArray(absentResourceKinds, 'absent_resource_kinds', { maxLength: 2 });
      const normalizedAbsentKinds = [...new Set(absentResourceKinds.map((kind) => (
        requireEnum(kind, ['savepoint', 'fork'], 'absent resource kind')
      )))].sort();
      if (normalizedAbsentKinds.length !== absentResourceKinds.length) {
        throw new TypeError('absent_resource_kinds must be unique');
      }
      if (suppliedSavepointRef === null && suppliedForkRef === null
        && normalizedAbsentKinds.length === 0) {
        throw new TypeError('resource record must report a resource or provider-attested absence');
      }
      const token = requireLeaseToken(input.lease_token);
      const tokenHash = hashOpaque('agoragentic-risk-fork-managed-lease-v1', token);
      const requestHash = managedResourceJournalRequestHash({
        tenantId: principal.tenant_id,
        invocationRef: invocationRefValue,
        claimantKeyId: principal.key_id,
        leaseTokenHash: tokenHash,
        savepointRef: suppliedSavepointRef,
        forkRef: suppliedForkRef,
        absentResourceKinds: normalizedAbsentKinds,
      });
      const receiptLookup = {
        tenant_id: principal.tenant_id,
        invocation_ref: invocationRefValue,
        claimant_key_id: principal.key_id,
        lease_token_hash: tokenHash,
        request_hash: requestHash,
        now: requireIso(clock(), 'clock result'),
      };
      const priorReceipt = await store.findResourceJournalReceipt(receiptLookup);
      if (priorReceipt !== null) {
        return requireResourceJournalReceipt(principal, priorReceipt, {
          invocation_ref: invocationRefValue,
          request_hash: requestHash,
          lease_token_hash: tokenHash,
        });
      }
      let invocation = await ownedInvocation(principal, invocationRefValue, false);
      const recovery = invocation.state === 'recovery_required' && invocation.lease_kind === 'recovery';
      if (!recovery
        && (invocation.state !== 'execution_leased' || invocation.lease_kind !== 'execution')) {
        throw managedError('Execution or recovery lease is required', 'RESOURCE_LEASE_REQUIRED', 409);
      }
      if (!recovery && normalizedAbsentKinds.length !== 0) {
        throw new TypeError('resource absence can only be reported during recovery');
      }
      providerRegistry.requireBound(
        invocation.provider_id,
        principal.tenant_id,
        invocation.provider_binding_hash,
        { allowDisabled: recovery },
      );
      const preflightNow = requireIso(clock(), 'clock result');
      invocation = await store.assertActiveLease({
        tenant_id: principal.tenant_id,
        claimant_key_id: principal.key_id,
        invocation_ref: invocation.invocation_ref,
        lease_token_hash: tokenHash,
        lease_kind: recovery ? 'recovery' : 'execution',
        expected_states: [recovery ? 'recovery_required' : 'execution_leased'],
        now: preflightNow,
      });
      if (invocation.savepoint_ref !== null && suppliedSavepointRef !== null
        && invocation.savepoint_ref !== suppliedSavepointRef) {
        throw managedError('Savepoint reference cannot be replaced', 'RESOURCE_REFERENCE_CONFLICT', 409);
      }
      if (invocation.fork_ref !== null && suppliedForkRef !== null
        && invocation.fork_ref !== suppliedForkRef) {
        throw managedError('Fork reference cannot be replaced', 'RESOURCE_REFERENCE_CONFLICT', 409);
      }
      const savepointRef = invocation.savepoint_ref ?? suppliedSavepointRef;
      const forkRef = invocation.fork_ref ?? suppliedForkRef;
      if ((savepointRef !== null && normalizedAbsentKinds.includes('savepoint'))
        || (forkRef !== null && normalizedAbsentKinds.includes('fork'))) {
        throw managedError(
          'A resource cannot be both present and absent',
          'RESOURCE_PRESENCE_CONFLICT',
          409,
        );
      }
      if (recovery) {
        const missingKinds = [
          ...(savepointRef === null ? ['savepoint'] : []),
          ...(forkRef === null ? ['fork'] : []),
        ];
        if (missingKinds.some((kind) => !normalizedAbsentKinds.includes(kind))) {
          throw managedError(
            'Recovery must attest every missing resource kind',
            'RECOVERY_RESOURCE_COVERAGE_INCOMPLETE',
            409,
          );
        }
        if (savepointRef === null && forkRef === null) {
          throw managedError(
            'Use recovery absence completion when no provider resources exist',
            'RECOVERY_RESOURCES_ABSENT',
            409,
          );
        }
      }
      const cleanupByKind = new Map(
        verifyManagedCleanupPlan(invocation).map((request) => [request.resource_kind, request]),
      );
      for (const [resourceKind, resourceRef] of [
        ['fork', forkRef],
        ['savepoint', savepointRef],
      ]) {
        const existingRequest = cleanupByKind.get(resourceKind);
        if (existingRequest && existingRequest.resource_ref !== resourceRef) {
          throw managedError(
            'Stored cleanup plan is inconsistent',
            'CLEANUP_PLAN_INTEGRITY_FAILED',
            503,
          );
        }
      }
      const verificationNow = requireIso(clock(), 'clock result');
      const resourceAttestationHash = await providerRegistry.verifyResourceBinding({
        provider_id: invocation.provider_id,
        tenant_id: principal.tenant_id,
        provider_binding_hash: invocation.provider_binding_hash,
        resources: deepFreeze({
          provider_recovery_key: invocation.provider_recovery_key,
          savepoint_ref: savepointRef,
          fork_ref: forkRef,
          absent_resource_kinds: normalizedAbsentKinds,
        }),
        context: deepFreeze({
          invocation_ref: invocation.invocation_ref,
          recovery_mode: recovery,
          now: verificationNow,
        }),
        allow_disabled: recovery,
      });
      const transitionNow = requireIso(clock(), 'clock result');
      for (const [resourceKind, resourceRef] of [
        ['fork', forkRef],
        ['savepoint', savepointRef],
      ]) {
        const existingRequest = cleanupByKind.get(resourceKind);
        if (resourceRef !== null && !existingRequest) {
          cleanupByKind.set(resourceKind, createCleanupVerificationRequest({
            provider_id: invocation.provider_id,
            resource_kind: resourceKind,
            resource_ref: resourceRef,
            requested_at: transitionNow,
            request_nonce: requireOpaqueRef(requestNonce(), 'request nonce'),
          }));
        }
      }
      const cleanupRequests = ['fork', 'savepoint']
        .map((kind) => cleanupByKind.get(kind))
        .filter(Boolean);
      const nextState = recovery
        ? 'cleanup_pending'
        : savepointRef !== null && forkRef !== null
          ? 'running'
          : 'execution_leased';
      const transitioned = await store.transitionInvocation({
        tenant_id: principal.tenant_id,
        claimant_key_id: principal.key_id,
        invocation_ref: invocation.invocation_ref,
        lease_token_hash: tokenHash,
        resource_journal_request_hash: requestHash,
        expected_states: [recovery ? 'recovery_required' : 'execution_leased'],
        expected_audit_event_count: invocation.audit_event_count,
        next_state: nextState,
        patch: {
          savepoint_ref: savepointRef,
          fork_ref: forkRef,
          cleanup_requests: cleanupRequests,
        },
        event_type: recovery
          ? 'provider_resources_recovered'
          : nextState === 'running'
            ? 'provider_resources_recorded'
            : 'provider_resource_journaled',
        event_details: {
          savepoint_cleanup_request_hash:
            cleanupByKind.get('savepoint')?.request_hash ?? null,
          fork_cleanup_request_hash: cleanupByKind.get('fork')?.request_hash ?? null,
          absent_resource_kinds: normalizedAbsentKinds,
          resource_binding_attestation_hash: resourceAttestationHash,
        },
        now: transitionNow,
      });
      return requireResourceJournalResponse(principal, transitioned);
    },

    async recordExecutionOutcome(principalValue, input = {}) {
      enabled();
      const principal = await normalizePrincipal(principalValue, 'worker:write', requirePrincipal);
      assertPlainRecord(input, 'execution outcome');
      assertAllowedKeys(input, [
        'invocation_ref',
        'lease_token',
        'outcome',
        'actual_cost_micros',
        'execution_evidence_hash',
        'result_hash',
      ], 'execution outcome');
      const invocation = await ownedInvocation(principal, input.invocation_ref, false);
      providerRegistry.requireBound(
        invocation.provider_id,
        principal.tenant_id,
        invocation.provider_binding_hash,
      );
      const cleanupPlan = verifyManagedCleanupPlan(invocation);
      if (invocation.state !== 'running'
        || invocation.savepoint_ref === null
        || invocation.fork_ref === null
        || cleanupPlan.length !== 2) {
        throw managedError('Provider resources are not recorded', 'RESOURCES_NOT_RECORDED', 409);
      }
      const outcome = requireEnum(input.outcome, ['succeeded', 'failed'], 'execution outcome.outcome');
      const token = requireLeaseToken(input.lease_token);
      const tokenHash = hashOpaque('agoragentic-risk-fork-managed-lease-v1', token);
      const now = requireIso(clock(), 'clock result');
      const actualCost = requireInteger(input.actual_cost_micros, 'actual_cost_micros', {
        min: 0,
        max: invocation.estimated_cost_micros,
      });
      const executionEvidenceHash = requireSha256(
        input.execution_evidence_hash,
        'execution_evidence_hash',
      );
      const resultHash = requireSha256(input.result_hash, 'result_hash');
      return store.settleExecutionOutcome({
        tenant_id: principal.tenant_id,
        claimant_key_id: principal.key_id,
        invocation_ref: invocation.invocation_ref,
        lease_token_hash: tokenHash,
        actual_cost_micros: actualCost,
        execution_outcome: outcome,
        execution_evidence_hash: executionEvidenceHash,
        result_hash: resultHash,
        now,
      });
    },

    async completeCleanup(principalValue, input = {}) {
      enabled();
      const principal = await normalizePrincipal(principalValue, 'worker:write', requirePrincipal);
      assertPlainRecord(input, 'cleanup completion');
      assertAllowedKeys(input, [
        'invocation_ref',
        'lease_token',
        'cleanup_evidence',
      ], 'cleanup completion');
      let invocation = await ownedInvocation(principal, input.invocation_ref, false);
      providerRegistry.requireBound(
        invocation.provider_id,
        principal.tenant_id,
        invocation.provider_binding_hash,
        { allowDisabled: true },
      );
      if (invocation.state !== 'cleanup_pending' || invocation.lease_kind !== 'cleanup') {
        throw managedError('Cleanup lease is required', 'CLEANUP_LEASE_REQUIRED', 409);
      }
      const token = requireLeaseToken(input.lease_token);
      const tokenHash = hashOpaque('agoragentic-risk-fork-managed-lease-v1', token);
      const preflightNow = requireIso(clock(), 'clock result');
      invocation = await store.assertActiveLease({
        tenant_id: principal.tenant_id,
        claimant_key_id: principal.key_id,
        invocation_ref: invocation.invocation_ref,
        lease_token_hash: tokenHash,
        lease_kind: 'cleanup',
        expected_states: ['cleanup_pending'],
        now: preflightNow,
      });
      const cleanupPlan = verifyManagedCleanupPlan(invocation);
      assertDataArray(input.cleanup_evidence, 'cleanup_evidence', { maxLength: 2 });
      if (input.cleanup_evidence.length !== cleanupPlan.length
        || cleanupPlan.length < 1) {
        throw managedError('Complete cleanup evidence is required', 'CLEANUP_EVIDENCE_INCOMPLETE', 409);
      }
      const evidenceByRequest = new Map();
      for (const value of input.cleanup_evidence) {
        assertPlainRecord(value, 'cleanup evidence item');
        const requestHash = requireSha256(value?.cleanup_request_hash, 'cleanup_request_hash');
        if (evidenceByRequest.has(requestHash)) {
          throw managedError('Cleanup evidence is duplicated', 'CLEANUP_EVIDENCE_DUPLICATE', 409);
        }
        evidenceByRequest.set(requestHash, value);
      }
      const verificationNow = requireIso(clock(), 'clock result');
      const verifiedHashes = [];
      const providerAttestationHashes = [];
      const verifiedPairs = [];
      for (const request of cleanupPlan) {
        const evidence = evidenceByRequest.get(request.request_hash);
        if (!evidence) {
          throw managedError('Cleanup evidence is incomplete', 'CLEANUP_EVIDENCE_INCOMPLETE', 409);
        }
        const verified = verifyCleanupVerificationEvidence(evidence, request, {
          now: verificationNow,
          max_age_ms: config.limits.max_invocation_age_ms,
        });
        if (verified.status !== 'verified') {
          throw managedError('Cleanup is not verified', 'CLEANUP_NOT_VERIFIED', 409);
        }
        verifiedHashes.push(verified.evidence_hash);
        verifiedPairs.push({ evidence: verified, request });
        providerAttestationHashes.push(await providerRegistry.verifyCleanupEvidence({
          provider_id: invocation.provider_id,
          tenant_id: principal.tenant_id,
          provider_binding_hash: invocation.provider_binding_hash,
          evidence: verified,
          request,
          context: deepFreeze({
            invocation_ref: invocation.invocation_ref,
            provider_recovery_key: invocation.provider_recovery_key,
            savepoint_ref: invocation.savepoint_ref,
            fork_ref: invocation.fork_ref,
            now: verificationNow,
          }),
        }));
      }
      const successful = invocation.execution_outcome === 'succeeded';
      const transitionNow = requireIso(clock(), 'clock result');
      for (const pair of verifiedPairs) {
        verifyCleanupVerificationEvidence(pair.evidence, pair.request, {
          now: transitionNow,
          max_age_ms: config.limits.max_invocation_age_ms,
        });
      }
      const verificationNotAfter = new Date(Math.min(...verifiedPairs.map(
        ({ evidence }) => Date.parse(evidence.observed_at) + config.limits.max_invocation_age_ms,
      ))).toISOString();
      return store.transitionInvocation({
        tenant_id: principal.tenant_id,
        claimant_key_id: principal.key_id,
        invocation_ref: invocation.invocation_ref,
        lease_token_hash: tokenHash,
        expected_states: ['cleanup_pending'],
        expected_audit_event_count: invocation.audit_event_count,
        next_state: successful ? 'completed' : 'failed_closed',
        patch: {},
        event_type: 'cleanup_verified',
        event_details: {
          evidence_hashes: verifiedHashes.sort(),
          provider_attestation_hashes: providerAttestationHashes.sort(),
          execution_outcome: invocation.execution_outcome,
        },
        now: transitionNow,
        verification_not_after: verificationNotAfter,
      });
    },

    async completeRecoveryAbsence(principalValue, input = {}) {
      enabled();
      const principal = await normalizePrincipal(principalValue, 'worker:write', requirePrincipal);
      assertPlainRecord(input, 'recovery absence completion');
      assertAllowedKeys(input, [
        'invocation_ref',
        'lease_token',
        'recovery_evidence',
      ], 'recovery absence completion');
      let invocation = await ownedInvocation(principal, input.invocation_ref, false);
      if (invocation.state !== 'recovery_required' || invocation.lease_kind !== 'recovery') {
        throw managedError('Recovery lease is required', 'RECOVERY_LEASE_REQUIRED', 409);
      }
      providerRegistry.requireBound(
        invocation.provider_id,
        principal.tenant_id,
        invocation.provider_binding_hash,
        { allowDisabled: true },
      );
      const token = requireLeaseToken(input.lease_token);
      const tokenHash = hashOpaque('agoragentic-risk-fork-managed-lease-v1', token);
      const preflightNow = requireIso(clock(), 'clock result');
      invocation = await store.assertActiveLease({
        tenant_id: principal.tenant_id,
        claimant_key_id: principal.key_id,
        invocation_ref: invocation.invocation_ref,
        lease_token_hash: tokenHash,
        lease_kind: 'recovery',
        expected_states: ['recovery_required'],
        now: preflightNow,
      });
      if (invocation.savepoint_ref !== null
        || invocation.fork_ref !== null
        || invocation.cleanup_requests.length !== 0) {
        throw managedError(
          'Known provider resources require the partial recovery cleanup path',
          'RECOVERY_RESOURCES_ALREADY_RECORDED',
          409,
        );
      }
      assertPlainRecord(input.recovery_evidence, 'recovery_evidence');
      assertAllowedKeys(input.recovery_evidence, [
        'schema',
        'provider_recovery_key',
        'observed_at',
        'evidence_ref',
        'observation_hash',
      ], 'recovery_evidence');
      if (input.recovery_evidence.schema
        !== 'agoragentic.risk-fork.recovery-absence-evidence.v1') {
        throw new TypeError('recovery_evidence.schema is invalid');
      }
      const verificationNow = requireIso(clock(), 'clock result');
      const evidence = deepFreeze({
        schema: input.recovery_evidence.schema,
        provider_recovery_key: requireSha256(
          input.recovery_evidence.provider_recovery_key,
          'recovery_evidence.provider_recovery_key',
        ),
        observed_at: requireIso(input.recovery_evidence.observed_at, 'recovery_evidence.observed_at'),
        evidence_ref: requireOpaqueRef(
          input.recovery_evidence.evidence_ref,
          'recovery_evidence.evidence_ref',
        ),
        observation_hash: requireSha256(
          input.recovery_evidence.observation_hash,
          'recovery_evidence.observation_hash',
        ),
      });
      if (evidence.provider_recovery_key !== invocation.provider_recovery_key) {
        throw managedError('Recovery evidence is bound to another invocation', 'RECOVERY_EVIDENCE_MISMATCH', 409);
      }
      const evidenceAge = Date.parse(verificationNow) - Date.parse(evidence.observed_at);
      if (evidenceAge < 0 || evidenceAge > config.limits.max_invocation_age_ms) {
        throw managedError('Recovery evidence is not fresh', 'RECOVERY_EVIDENCE_STALE', 409);
      }
      const attestationHash = await providerRegistry.verifyRecoveryAbsence({
        provider_id: invocation.provider_id,
        tenant_id: principal.tenant_id,
        provider_binding_hash: invocation.provider_binding_hash,
        evidence,
        context: deepFreeze({
          invocation_ref: invocation.invocation_ref,
          provider_recovery_key: invocation.provider_recovery_key,
          savepoint_ref: null,
          fork_ref: null,
          now: verificationNow,
        }),
      });
      const transitionNow = requireIso(clock(), 'clock result');
      const transitionEvidenceAge = Date.parse(transitionNow) - Date.parse(evidence.observed_at);
      if (transitionEvidenceAge < 0
        || transitionEvidenceAge > config.limits.max_invocation_age_ms) {
        throw managedError('Recovery evidence is not fresh', 'RECOVERY_EVIDENCE_STALE', 409);
      }
      const verificationNotAfter = new Date(
        Date.parse(evidence.observed_at) + config.limits.max_invocation_age_ms,
      ).toISOString();
      return store.transitionInvocation({
        tenant_id: principal.tenant_id,
        claimant_key_id: principal.key_id,
        invocation_ref: invocation.invocation_ref,
        lease_token_hash: tokenHash,
        expected_states: ['recovery_required'],
        expected_audit_event_count: invocation.audit_event_count,
        next_state: 'failed_closed',
        patch: {},
        event_type: 'recovery_absence_verified',
        event_details: {
          provider_attestation_hash: attestationHash,
          recovery_evidence_hash: sha256Ref(evidence),
        },
        now: transitionNow,
        verification_not_after: verificationNotAfter,
      });
    },

    async listAuditEvents(principalValue, invocationRefValue) {
      enabled();
      const principal = await normalizePrincipal(principalValue, 'audit:read', requirePrincipal);
      const invocationRefValueNormalized = requireInvocationRef(invocationRefValue, 'invocation_ref');
      const snapshot = await store.getAuditSnapshot(
        principal.tenant_id,
        invocationRefValueNormalized,
      );
      const invocation = requireInvocationOwner(principal, snapshot?.invocation);
      const events = snapshot.events;
      verifyManagedAuditChain(events);
      if (events.length !== invocation.audit_event_count
        || events.at(-1)?.event_hash !== invocation.audit_head_hash) {
        throw managedError(
          'Managed audit history is incomplete',
          'AUDIT_CHAIN_INCOMPLETE',
          503,
        );
      }
      return events;
    },

    async sweepExpiredLeases({ limit = 100 } = {}) {
      enabled();
      const listNow = requireIso(clock(), 'clock result');
      const expired = await store.listExpiredLeases(listNow, limit);
      const outcomes = [];
      for (const invocation of expired) {
        outcomes.push(await store.releaseExpiredLease({
          tenant_id: invocation.tenant_id,
          invocation_ref: invocation.invocation_ref,
          now: requireIso(clock(), 'clock result'),
        }));
      }
      const remaining = Math.max(0, limit - outcomes.length);
      if (remaining > 0) {
        const stale = await store.listStaleAdmissions(
          requireIso(clock(), 'clock result'),
          config.limits.max_invocation_age_ms,
          remaining,
        );
        for (const invocation of stale) {
          outcomes.push(await store.releaseStaleAdmission({
            tenant_id: invocation.tenant_id,
            invocation_ref: invocation.invocation_ref,
            now: requireIso(clock(), 'clock result'),
            max_age_ms: config.limits.max_invocation_age_ms,
          }));
        }
      }
      return deepFreeze(outcomes.filter(Boolean));
    },

    async health() {
      const healthNow = requireIso(clock(), 'clock result');
      const storage = await store.health(healthNow).catch((error) => ({
        ready: false,
        error_code: String(error?.code ?? 'STORE_HEALTH_FAILED'),
      }));
      const bindingObligations = await store.providerBindingObligations(10_000).catch((error) => ({
        complete: false,
        bindings: [],
        error_code: String(error?.code ?? 'PROVIDER_BINDING_OBLIGATIONS_FAILED'),
      }));
      const providers = providerRegistry.summary();
      const unavailableBindings = bindingObligations.bindings.filter((binding) => (
        !providerRegistry.hasBound(
          binding.provider_id,
          binding.tenant_id,
          binding.provider_binding_hash,
          { allowDisabled: binding.requires_enabled === false },
        )
      ));
      const localReady = config.enabled
        && config.environment === 'local_test'
        && storage.ready === true
        && providers.provider_count > 0
        && providers.provider_binding_integrity === true
        && bindingObligations.complete === true
        && unavailableBindings.length === 0;
      return deepFreeze({
        schema: config.schema,
        alive: true,
        ready: localReady,
        readiness_scope: localReady ? 'local_test_only' : 'not_ready',
        default_off: true,
        production_qualified: false,
        deployed: false,
        live_traffic_protected: false,
        storage: cloneJson(storage, 'storage health'),
        providers,
        provider_binding_obligation_count: bindingObligations.bindings.length,
        provider_binding_obligations_complete: bindingObligations.complete === true,
        unavailable_provider_binding_count: unavailableBindings.length,
      });
    },
  });
}
