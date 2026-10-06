import { sha256Ref } from '../../src/canonical.mjs';
import { createManagedAuditEvent } from './audit.mjs';
import {
  assertAllowedKeys, assertPlainRecord, cloneJson, deepFreeze, managedError,
  requireInteger, requireInvocationRef, requireIso, requireOpaqueRef, requireSha256, requireTenantId,
} from './validation.mjs';

// This is an idempotent use of the existing invocation audit, not a new receipt
// family. Its only assertion is that this cleanup lease observed incompletion.
export function normalizeCleanupIncompleteInput(input) {
  assertPlainRecord(input, 'cleanup incomplete observation');
  assertAllowedKeys(input, ['tenant_id', 'claimant_key_id', 'invocation_ref',
    'lease_token_hash', 'lease_generation', 'now'], 'cleanup incomplete observation');
  return deepFreeze({
    tenant_id: requireTenantId(input.tenant_id),
    claimant_key_id: requireOpaqueRef(input.claimant_key_id, 'claimant_key_id'),
    invocation_ref: requireInvocationRef(input.invocation_ref),
    lease_token_hash: requireSha256(input.lease_token_hash, 'lease_token_hash'),
    lease_generation: requireInteger(input.lease_generation, 'lease_generation', { min: 1, max: 2_147_483_647 }),
    now: requireIso(input.now, 'cleanup incomplete time'),
  });
}

export function assertCleanupIncompleteLease(record, input, nowValue) {
  if (record.tenant_id !== input.tenant_id || record.invocation_ref !== input.invocation_ref
    || record.state !== 'cleanup_pending' || record.lease_kind !== 'cleanup') {
    throw managedError('Cleanup lease is required', 'CLEANUP_LEASE_REQUIRED', 409);
  }
  if (record.lease_owner !== input.claimant_key_id) {
    throw managedError('Lease belongs to a different credential', 'LEASE_OWNER_MISMATCH', 403);
  }
  if (record.lease_token_hash !== input.lease_token_hash
    || record.lease_generation !== input.lease_generation) {
    throw managedError('Cleanup lease authority changed', 'LEASE_AUTHORITY_LOST', 409);
  }
  if (record.lease_expires_at == null
    || Date.parse(requireIso(record.lease_expires_at, 'cleanup lease expiry')) <= Date.parse(requireIso(nowValue))) {
    throw managedError('Lease has expired', 'LEASE_EXPIRED', 409);
  }
}

export function cleanupIncompleteAuditBinding(input) {
  const attemptHash = sha256Ref({ domain: 'agoragentic-risk-fork-cleanup-incomplete-v1',
    tenant_id: input.tenant_id, invocation_ref: input.invocation_ref,
    claimant_key_id: input.claimant_key_id, lease_token_hash: input.lease_token_hash,
    lease_generation: input.lease_generation });
  return deepFreeze({ event_ref: `evt_cleanup_incomplete_${attemptHash.slice(7)}`,
    details: { cleanup_attempt_hash: attemptHash, failure_class: 'cleanup_incomplete' } });
}

export function verifyCleanupIncompleteReplay(value, input, invocation) {
  const event = cloneJson(value, 'cleanup incomplete audit event');
  const binding = cleanupIncompleteAuditBinding(input);
  const expected = createManagedAuditEvent({ event_ref: binding.event_ref,
    tenant_id: input.tenant_id, invocation_ref: input.invocation_ref,
    sequence: event.sequence, event_type: 'cleanup_incomplete', occurred_at: event.occurred_at,
    details: binding.details, prior_event_hash: event.prior_event_hash });
  if (sha256Ref(event) !== sha256Ref(expected)
    || event.sequence > requireInteger(invocation.audit_event_count, 'audit_event_count', { min: 1 })
    || (event.sequence === invocation.audit_event_count && event.event_hash !== invocation.audit_head_hash)) {
    throw managedError('Cleanup observation audit is inconsistent', 'AUDIT_APPEND_CONFLICT', 503);
  }
  return expected;
}
