import { sha256Ref } from '../../src/canonical.mjs';
import { TERMINAL_INVOCATION_STATES } from './constants.mjs';
import { assertManagedRecoveryKeyIntegrity } from './invocation-integrity.mjs';
import { assertAllowedKeys, assertPlainRecord, deepFreeze, managedError,
  requireInteger, requireInvocationRef, requireIso, requireOpaqueRef, requireSha256, requireString,
  requireTenantId } from './validation.mjs';

// Cancellation is a permanent marker on the original invocation, not a receipt
// or authority capability. At most one exact request is accepted per lifetime.
export function normalizeCancellationFields(row) {
  const fields = {
    cancel_requested_at: row.cancel_requested_at == null ? null : requireIso(row.cancel_requested_at, 'cancel_requested_at'),
    cancel_requested_by: row.cancel_requested_by == null ? null : requireOpaqueRef(row.cancel_requested_by, 'cancel_requested_by'),
    cancel_request_hash: row.cancel_request_hash == null ? null : requireSha256(row.cancel_request_hash, 'cancel_request_hash'),
    cancel_reason_hash: row.cancel_reason_hash == null ? null : requireSha256(row.cancel_reason_hash, 'cancel_reason_hash'),
  };
  if (Object.values(fields).some((value) => (value === null) !== (fields.cancel_requested_at === null))) {
    throw managedError('Stored cancellation marker is incomplete', 'CANCELLATION_INTEGRITY_FAILED', 503);
  }
  if (fields.cancel_requested_at !== null
    && (fields.cancel_requested_by !== row.admitted_key_id
      || ['admitted', 'execution_leased', 'running', 'completed'].includes(row.state))) {
    throw managedError('Stored cancellation marker contradicts invocation authority', 'CANCELLATION_INTEGRITY_FAILED', 503);
  }
  return deepFreeze(fields);
}

export function cancellationRequest(invocation, keyId, value) {
  assertManagedRecoveryKeyIntegrity(invocation);
  assertPlainRecord(value, 'cancellation request');
  assertAllowedKeys(value, ['invocation_ref', 'idempotency_key', 'reason_hash'], 'cancellation request');
  const ref = requireInvocationRef(value.invocation_ref);
  if (ref !== invocation.invocation_ref || keyId !== invocation.admitted_key_id) {
    throw managedError('Cancellation requires the original admitted credential', 'CANCELLATION_OWNER_MISMATCH', 403);
  }
  const reasonHash = requireSha256(value.reason_hash, 'cancellation reason_hash');
  const requestHash = sha256Ref({
    purpose: 'managed_invocation_cancellation', tenant_id: invocation.tenant_id, invocation_ref: ref,
    admitted_key_id: keyId, request_hash: invocation.request_hash, operation_hash: invocation.operation_hash,
    provider_binding_hash: invocation.provider_binding_hash, provider_recovery_key: invocation.provider_recovery_key,
    idempotency_key: requireString(value.idempotency_key, 'cancellation idempotency_key', { minBytes: 16, maxBytes: 256 }),
    reason_hash: reasonHash,
  });
  return deepFreeze({ tenant_id: invocation.tenant_id, invocation_ref: ref,
    claimant_key_id: keyId, cancel_request_hash: requestHash, cancel_reason_hash: reasonHash,
    expected_request_hash: invocation.request_hash, expected_operation_hash: invocation.operation_hash,
    expected_provider_binding_hash: invocation.provider_binding_hash,
    expected_provider_recovery_key: invocation.provider_recovery_key });
}

// Run only while holding the invocation and current credential mutation locks.
// The same plan is used by the finite memory test authority and PostgreSQL.
export function planCancellation(record, input, now) {
  const fields = normalizeCancellationFields(record);
  for (const field of ['request_hash', 'operation_hash', 'provider_binding_hash', 'provider_recovery_key']) {
    if (requireSha256(input[`expected_${field}`], `expected_${field}`) !== record[field]) {
      throw managedError('Cancellation invocation binding changed during its wait', 'CANCELLATION_BINDING_CHANGED', 409);
    }
  }
  if (record.admitted_key_id !== input.claimant_key_id) {
    throw managedError('Cancellation requires the original admitted credential', 'CANCELLATION_OWNER_MISMATCH', 403);
  }
  const requestHash = requireSha256(input.cancel_request_hash, 'cancel_request_hash');
  const reasonHash = requireSha256(input.cancel_reason_hash, 'cancel_reason_hash');
  if (fields.cancel_request_hash !== null) {
    if (fields.cancel_request_hash !== requestHash || fields.cancel_reason_hash !== reasonHash) {
      throw managedError('Invocation has a different permanent cancellation request', 'CANCELLATION_CONFLICT', 409);
    }
    return null;
  }
  if (TERMINAL_INVOCATION_STATES.includes(record.state)) {
    throw managedError('Terminal invocation cannot be retroactively canceled', 'INVOCATION_ALREADY_TERMINAL', 409);
  }
  if (!['admitted', 'execution_leased', 'running', 'cleanup_pending', 'recovery_required'].includes(record.state)) {
    throw managedError('Cancellation invocation state is invalid', 'CANCELLATION_INTEGRITY_FAILED', 503);
  }
  const preEffect = record.state === 'admitted';
  const executing = ['execution_leased', 'running'].includes(record.state);
  const state = preEffect ? 'failed_closed' : executing
    ? record.state === 'running' && record.cleanup_requests.length === 2 ? 'cleanup_pending' : 'recovery_required'
    : record.state;
  return deepFreeze({
    cancel_requested_at: requireIso(now, 'cancellation time'), cancel_requested_by: input.claimant_key_id,
    cancel_request_hash: requestHash, cancel_reason_hash: reasonHash,
    state, execution_outcome: executing ? 'ambiguous' : record.execution_outcome,
    actual_cost_micros: preEffect ? 0 : executing ? record.estimated_cost_micros : record.actual_cost_micros,
    release_reservation: (preEffect || executing) && record.actual_cost_micros === null,
    additional_spent_micros: preEffect ? 0 : executing
      ? record.estimated_cost_micros - (record.actual_cost_micros ?? 0) : 0,
    revoke_execution: executing,
    terminal_at: preEffect ? now : record.terminal_at,
  });
}

function interruptedAttemptHash(record) {
  return sha256Ref({ purpose: 'managed_execution_interruption',
    tenant_id: requireTenantId(record.tenant_id), invocation_ref: requireInvocationRef(record.invocation_ref),
    provider_binding_hash: requireSha256(record.provider_binding_hash),
    provider_recovery_key: requireSha256(record.provider_recovery_key),
    claimant_key_id: requireOpaqueRef(record.lease_owner, 'interrupted lease owner'),
    lease_token_hash: requireSha256(record.lease_token_hash, 'interrupted lease token hash'),
    lease_generation: requireInteger(record.lease_generation, 'interrupted lease generation', { min: 1, max: 2_147_483_647 }),
  });
}

// Keep the interruption binding inside the original append-only audit digest.
// No raw token, new authority receipt, or independent-host proof is introduced.
export function cancellationAuditDetails(record, plan) {
  return { requester_key_id: plan.cancel_requested_by, cancel_request_hash: plan.cancel_request_hash,
    reason_hash: plan.cancel_reason_hash, from_state: record.state, to_state: plan.state,
    provider_binding_hash: record.provider_binding_hash, provider_recovery_key: record.provider_recovery_key,
    termination_proven: false,
    interrupted_attempt_hash: plan.revoke_execution ? interruptedAttemptHash(record) : null };
}

export function verifyCancellationObservation(record, input, now, audit) {
  assertAllowedKeys(input, ['tenant_id', 'claimant_key_id', 'invocation_ref', 'lease_token_hash',
    'lease_generation', 'now'], 'cancellation observation');
  const generation = requireInteger(input.lease_generation, 'lease_generation', { min: 1, max: 2_147_483_647 });
  const claimant = requireOpaqueRef(input.claimant_key_id, 'claimant_key_id');
  const tokenHash = requireSha256(input.lease_token_hash, 'lease_token_hash');
  if (record.tenant_id !== requireTenantId(input.tenant_id)
    || record.invocation_ref !== requireInvocationRef(input.invocation_ref)) {
    throw managedError('Invocation was not found', 'INVOCATION_NOT_FOUND', 404);
  }
  if (record.lease_generation !== generation) {
    throw managedError('Cancellation observation belongs to a retired lease generation', 'CANCELLATION_OBSERVATION_STALE', 409);
  }
  const fields = normalizeCancellationFields(record);
  const count = requireInteger(audit.count, 'cancellation audit count', { min: 0, max: 2_147_483_647 });
  if (fields.cancel_request_hash === null) {
    if (count !== 0 || record.lease_kind !== 'execution'
      || !['execution_leased', 'running'].includes(record.state)
      || record.lease_owner !== claimant || record.lease_token_hash !== tokenHash) {
      throw managedError('Cancellation observation does not own this execution lease', 'CANCELLATION_OBSERVATION_INVALID', 403);
    }
    if (record.tenant_status !== 'active') throw managedError('Tenant suspended execution authority', 'TENANT_NOT_ACTIVE', 403);
    if (record.lease_expires_at == null || Date.parse(requireIso(record.lease_expires_at)) <= Date.parse(requireIso(now))) {
      throw managedError('Execution observation lease has expired', 'LEASE_EXPIRED', 409);
    }
  } else {
    // Cancellation cleared the live token. Reconstruct its exact prior attempt
    // digest from authenticated server identity and the supplied token. Only
    // the original executing generation can match the stored cancellation
    // event; historical token possession or a same-tenant key is insufficient.
    const fromStates = record.state === 'cleanup_pending' ? ['running']
      : record.state === 'recovery_required' ? ['execution_leased', 'running'] : [];
    const matches = fromStates.filter((state) => audit.details_hash === sha256Ref(cancellationAuditDetails({
      ...record, state, lease_owner: claimant, lease_token_hash: tokenHash,
    }, { ...fields, state: record.state, revoke_execution: true })));
    if (count !== 1 || matches.length !== 1) {
      throw managedError('Cancellation observation does not bind the interrupted attempt', 'CANCELLATION_OBSERVATION_INVALID', 403);
    }
  }
  return deepFreeze({ tenant_id: record.tenant_id, invocation_ref: record.invocation_ref,
    provider_binding_hash: record.provider_binding_hash, provider_recovery_key: record.provider_recovery_key,
    lease_generation: generation, cancel_requested: fields.cancel_request_hash !== null, state: record.state });
}
