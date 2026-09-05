import { sha256Ref } from '../../src/canonical.mjs';
import {
  MANAGED_INVOCATION_SCHEMA,
  MANAGED_RESOURCE_JOURNAL_RECEIPT_SCHEMA,
} from './constants.mjs';
import {
  assertAllowedKeys,
  assertDataArray,
  assertPlainRecord,
  cloneJson,
  deepFreeze,
  managedError,
  requireEnum,
  requireInvocationRef,
  requireIso,
  requireOpaqueRef,
  requireSha256,
  requireTenantId,
} from './validation.mjs';

export function managedClientRequestHash({ providerId, operation, estimatedCostMicros }) {
  return sha256Ref({
    schema: 'agoragentic.risk-fork.managed-client-request.v1',
    provider_id: providerId,
    operation,
    estimated_cost_micros: estimatedCostMicros,
  });
}

export function managedProviderRecoveryKey({
  tenantId,
  idempotencyHash,
  providerBindingHash,
}) {
  return sha256Ref({
    schema: 'agoragentic.risk-fork.provider-recovery-key.v1',
    tenant_id: tenantId,
    idempotency_hash: idempotencyHash,
    provider_binding_hash: providerBindingHash,
  });
}

export function managedResourceJournalRequestHash({
  tenantId,
  invocationRef,
  claimantKeyId,
  leaseTokenHash,
  savepointRef = null,
  forkRef = null,
  absentResourceKinds = [],
}) {
  assertDataArray(absentResourceKinds, 'absent_resource_kinds', { maxLength: 2 });
  const normalizedAbsentKinds = absentResourceKinds.map((kind) => (
    requireEnum(kind, ['savepoint', 'fork'], 'absent resource kind')
  ));
  if (new Set(normalizedAbsentKinds).size !== normalizedAbsentKinds.length
    || normalizedAbsentKinds.some((kind, index) => (
      index > 0 && normalizedAbsentKinds[index - 1] > kind
    ))) {
    throw new TypeError('absent_resource_kinds must be unique and sorted');
  }
  return sha256Ref({
    schema: 'agoragentic.risk-fork.managed-resource-journal-request.v1',
    tenant_id: requireTenantId(tenantId),
    invocation_ref: requireInvocationRef(invocationRef, 'invocation_ref'),
    claimant_key_id: requireOpaqueRef(claimantKeyId, 'claimant_key_id'),
    lease_token_hash: requireSha256(leaseTokenHash, 'lease_token_hash'),
    savepoint_ref: savepointRef == null
      ? null
      : requireOpaqueRef(savepointRef, 'savepoint_ref'),
    fork_ref: forkRef == null ? null : requireOpaqueRef(forkRef, 'fork_ref'),
    absent_resource_kinds: normalizedAbsentKinds,
  });
}

export function normalizeManagedResourceJournalReceipt(value) {
  assertPlainRecord(value, 'resource journal receipt');
  assertAllowedKeys(value, [
    'schema',
    'tenant_id',
    'invocation_ref',
    'request_hash',
    'claimant_key_id',
    'lease_token_hash',
    'response',
    'response_hash',
    'created_at',
  ], 'resource journal receipt');
  if (value.schema !== MANAGED_RESOURCE_JOURNAL_RECEIPT_SCHEMA) {
    throw new TypeError('resource journal receipt schema is invalid');
  }
  const tenantId = requireTenantId(value.tenant_id);
  const invocationRef = requireInvocationRef(value.invocation_ref, 'invocation_ref');
  const response = cloneJson(value.response, 'resource journal receipt response');
  assertPlainRecord(response, 'resource journal receipt response');
  if (response.schema !== MANAGED_INVOCATION_SCHEMA
    || response.tenant_id !== tenantId
    || response.invocation_ref !== invocationRef
    || Object.hasOwn(response, 'operation')
    || Object.hasOwn(response, 'lease_token_hash')
    || Object.hasOwn(response, 'lease_claim_audit_hash')) {
    throw managedError(
      'Resource journal receipt response is inconsistent',
      'RESOURCE_JOURNAL_RECEIPT_INTEGRITY_FAILED',
      503,
    );
  }
  assertManagedRecoveryKeyIntegrity(response);
  const responseHash = requireSha256(value.response_hash, 'resource journal response_hash');
  if (sha256Ref(response) !== responseHash) {
    throw managedError(
      'Resource journal receipt response hash is invalid',
      'RESOURCE_JOURNAL_RECEIPT_INTEGRITY_FAILED',
      503,
    );
  }
  return deepFreeze({
    schema: MANAGED_RESOURCE_JOURNAL_RECEIPT_SCHEMA,
    tenant_id: tenantId,
    invocation_ref: invocationRef,
    request_hash: requireSha256(value.request_hash, 'resource journal request_hash'),
    claimant_key_id: requireOpaqueRef(value.claimant_key_id, 'resource journal claimant_key_id'),
    lease_token_hash: requireSha256(value.lease_token_hash, 'resource journal lease_token_hash'),
    response,
    response_hash: responseHash,
    created_at: requireIso(value.created_at, 'resource journal receipt created_at'),
  });
}

export function createManagedResourceJournalReceipt({
  tenantId,
  invocationRef,
  requestHash,
  claimantKeyId,
  leaseTokenHash,
  response,
  createdAt,
}) {
  const normalizedResponse = cloneJson(response, 'resource journal receipt response');
  return normalizeManagedResourceJournalReceipt({
    schema: MANAGED_RESOURCE_JOURNAL_RECEIPT_SCHEMA,
    tenant_id: tenantId,
    invocation_ref: invocationRef,
    request_hash: requestHash,
    claimant_key_id: claimantKeyId,
    lease_token_hash: leaseTokenHash,
    response: normalizedResponse,
    response_hash: sha256Ref(normalizedResponse),
    created_at: createdAt,
  });
}

export function assertManagedRecoveryKeyIntegrity(invocation) {
  assertPlainRecord(invocation, 'managed invocation');
  const expected = managedProviderRecoveryKey({
    tenantId: requireTenantId(invocation.tenant_id, 'invocation.tenant_id'),
    idempotencyHash: requireSha256(invocation.idempotency_hash, 'invocation.idempotency_hash'),
    providerBindingHash: requireSha256(
      invocation.provider_binding_hash,
      'invocation.provider_binding_hash',
    ),
  });
  if (expected !== requireSha256(
    invocation.provider_recovery_key,
    'invocation.provider_recovery_key',
  )) {
    throw managedError(
      'Stored recovery key integrity check failed',
      'RECOVERY_KEY_INTEGRITY_FAILED',
      503,
    );
  }
  return invocation;
}
