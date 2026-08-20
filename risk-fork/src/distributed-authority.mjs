import { sha256Ref } from './canonical.mjs';
import { verifyExecutionBinding } from './contracts.mjs';
import {
  assertAllowedKeys,
  assertPlainObject,
  cloneJson,
  deepFreeze,
  requireEnum,
  requireIsoDate,
  requireOpaqueRef,
  requireSha256Ref,
  safeEqual,
} from './util.mjs';

export const DISTRIBUTED_OPERATION_STATES = Object.freeze([
  'prepared',
  'effect_started',
  'committed',
  'ambiguous',
  'aborted',
]);

export const DISTRIBUTED_UNRESOLVED_STATES = Object.freeze([
  'prepared',
  'effect_started',
  'ambiguous',
]);

export const DISTRIBUTED_RECONCILIATION_RESOLUTIONS = Object.freeze([
  'effect_succeeded',
  'effect_absent',
  'effect_failed_terminal',
]);

export class DistributedAuthorityError extends Error {
  constructor(message, code, evidence = {}) {
    super(message);
    this.name = 'DistributedAuthorityError';
    this.code = code;
    this.evidence = cloneJson(evidence);
  }
}

export class DistributedAuthorityAmbiguousError extends DistributedAuthorityError {
  constructor(message, evidence = {}) {
    super(message, 'RISK_FORK_DISTRIBUTED_COMMIT_AMBIGUOUS', evidence);
    this.name = 'DistributedAuthorityAmbiguousError';
  }
}

export function distributedAuthorityError(message, code, evidence = {}) {
  return new DistributedAuthorityError(message, code, evidence);
}

function normalizeGovernanceRecord(value, label, { nullable = false, budget = false } = {}) {
  if (value == null && nullable) return null;
  assertPlainObject(value, label);
  assertAllowedKeys(value, budget
    ? ['ref', 'version', 'hash', 'usage_hash', 'available_amount', 'currency', 'payment_rail']
    : ['ref', 'version', 'hash'], label);
  const normalized = {
    ref: requireOpaqueRef(value.ref, `${label}.ref`),
    version: requireOpaqueRef(value.version, `${label}.version`),
    hash: requireSha256Ref(value.hash, `${label}.hash`),
  };
  if (budget) {
    normalized.usage_hash = requireSha256Ref(value.usage_hash, `${label}.usage_hash`);
    normalized.available_amount = value.available_amount == null
      ? null
      : requireOpaqueRef(value.available_amount, `${label}.available_amount`);
    normalized.currency = value.currency == null
      ? null
      : requireOpaqueRef(value.currency, `${label}.currency`);
    normalized.payment_rail = value.payment_rail == null
      ? null
      : requireOpaqueRef(value.payment_rail, `${label}.payment_rail`);
    const commercialNulls = [
      normalized.available_amount,
      normalized.currency,
      normalized.payment_rail,
    ].map((entry) => entry === null);
    if (new Set(commercialNulls).size !== 1) {
      throw new TypeError(`${label} availability fields must be supplied together`);
    }
    if (normalized.available_amount !== null
      && !/^(?:0|[1-9]\d*)(?:\.\d{1,18})?$/.test(normalized.available_amount)) {
      throw new TypeError(`${label}.available_amount must be a canonical decimal`);
    }
  }
  return normalized;
}

export function normalizeDistributedGovernance(value, label = 'distributed governance') {
  assertPlainObject(value, label);
  assertAllowedKeys(value, [
    'policy',
    'mandate',
    'budget_policy',
    'epoch',
    'commit_policy',
    'evidence_ref',
    'evidence_hash',
  ], label);
  assertPlainObject(value.commit_policy, `${label}.commit_policy`);
  const governance = {
    policy: normalizeGovernanceRecord(value.policy, `${label}.policy`),
    mandate: normalizeGovernanceRecord(value.mandate, `${label}.mandate`, { nullable: true }),
    budget_policy: normalizeGovernanceRecord(
      value.budget_policy,
      `${label}.budget_policy`,
      { nullable: true, budget: true },
    ),
    epoch: requireOpaqueRef(value.epoch, `${label}.epoch`),
    commit_policy: cloneJson(value.commit_policy),
    evidence_ref: requireOpaqueRef(value.evidence_ref, `${label}.evidence_ref`),
    evidence_hash: requireSha256Ref(value.evidence_hash, `${label}.evidence_hash`),
  };
  sha256Ref(governance);
  return deepFreeze(governance);
}

export function normalizeParentSeed(input) {
  assertPlainObject(input, 'distributed parent seed');
  assertAllowedKeys(input, ['parent_ref', 'head_hash'], 'distributed parent seed');
  return deepFreeze({
    parent_ref: requireOpaqueRef(input.parent_ref, 'parent_ref'),
    head_hash: requireSha256Ref(input.head_hash, 'head_hash'),
  });
}

export function normalizeGovernanceUpdate(input) {
  assertPlainObject(input, 'distributed governance update');
  assertAllowedKeys(input, ['parent_ref', 'governance'], 'distributed governance update');
  const governance = normalizeDistributedGovernance(input.governance);
  return deepFreeze({
    parent_ref: requireOpaqueRef(input.parent_ref, 'parent_ref'),
    governance: cloneJson(governance),
    governance_hash: sha256Ref(governance),
  });
}

export function normalizeCommitApprovalRegistration(input) {
  assertPlainObject(input, 'distributed commit approval registration');
  assertAllowedKeys(input, [
    'parent_ref',
    'artifact_hash',
    'capsule_hash',
    'parent_state_hash',
    'commit_type',
    'governance_hash',
    'evidence_ref',
    'evidence_hash',
  ], 'distributed commit approval registration');
  const normalized = {
    parent_ref: requireOpaqueRef(input.parent_ref, 'parent_ref'),
    artifact_hash: requireSha256Ref(input.artifact_hash, 'artifact_hash'),
    capsule_hash: requireSha256Ref(input.capsule_hash, 'capsule_hash'),
    parent_state_hash: requireSha256Ref(input.parent_state_hash, 'parent_state_hash'),
    commit_type: requireEnum(
      input.commit_type,
      ['TYPED_RESULT', 'WORKSPACE_DIFF', 'CONSEQUENTIAL_ACTION_PROPOSAL'],
      'commit_type',
    ),
    governance_hash: requireSha256Ref(input.governance_hash, 'governance_hash'),
    evidence_ref: requireOpaqueRef(input.evidence_ref, 'evidence_ref'),
    evidence_hash: requireSha256Ref(input.evidence_hash, 'evidence_hash'),
  };
  normalized.approval_key = sha256Ref({
    schema: 'agoragentic.risk-fork.distributed-approval-key.v1',
    ...normalized,
  });
  return deepFreeze(normalized);
}

export function normalizeCommitApprovalRevocation(input) {
  assertPlainObject(input, 'distributed commit approval revocation');
  assertAllowedKeys(input, [
    'parent_ref',
    'approval_evidence_ref',
    'approval_evidence_hash',
    'evidence_ref',
    'evidence_hash',
  ], 'distributed commit approval revocation');
  return deepFreeze({
    parent_ref: requireOpaqueRef(input.parent_ref, 'parent_ref'),
    approval_evidence_ref: requireOpaqueRef(
      input.approval_evidence_ref,
      'approval_evidence_ref',
    ),
    approval_evidence_hash: requireSha256Ref(
      input.approval_evidence_hash,
      'approval_evidence_hash',
    ),
    evidence_ref: requireOpaqueRef(input.evidence_ref, 'evidence_ref'),
    evidence_hash: requireSha256Ref(input.evidence_hash, 'evidence_hash'),
  });
}

export function normalizeAuthorizationRegistration(input) {
  assertPlainObject(input, 'distributed authorization registration');
  assertAllowedKeys(input, [
    'authorization_id',
    'authorization_ref',
    'authorization_hash',
    'binding_hash',
    'expires_at',
    'evidence_ref',
    'evidence_hash',
  ], 'distributed authorization registration');
  return deepFreeze({
    authorization_id: requireOpaqueRef(input.authorization_id, 'authorization_id'),
    authorization_ref: requireOpaqueRef(input.authorization_ref, 'authorization_ref'),
    authorization_hash: requireSha256Ref(input.authorization_hash, 'authorization_hash'),
    binding_hash: requireSha256Ref(input.binding_hash, 'binding_hash'),
    expires_at: requireIsoDate(input.expires_at, 'expires_at'),
    evidence_ref: requireOpaqueRef(input.evidence_ref, 'evidence_ref'),
    evidence_hash: requireSha256Ref(input.evidence_hash, 'evidence_hash'),
  });
}

export function normalizeAuthorizationRevocation(input) {
  assertPlainObject(input, 'distributed authorization revocation');
  assertAllowedKeys(
    input,
    ['authorization_id', 'evidence_ref', 'evidence_hash'],
    'distributed authorization revocation',
  );
  return deepFreeze({
    authorization_id: requireOpaqueRef(input.authorization_id, 'authorization_id'),
    evidence_ref: requireOpaqueRef(input.evidence_ref, 'evidence_ref'),
    evidence_hash: requireSha256Ref(input.evidence_hash, 'evidence_hash'),
  });
}

function normalizePrepareAuthorization(value) {
  if (value == null) return null;
  assertPlainObject(value, 'distributed prepare authorization');
  assertAllowedKeys(value, [
    'authorization_id',
    'authorization_ref',
    'authorization_hash',
    'binding_hash',
    'binding',
    'governance_evidence_ref',
    'governance_evidence_hash',
  ], 'distributed prepare authorization');
  const binding = cloneJson(value.binding);
  verifyExecutionBinding(binding, {
    one_use_authorization_id: value.authorization_id,
    authorization_ref: value.authorization_ref,
    authorization_hash: value.authorization_hash,
  }, { now: binding.validity.not_before });
  const bindingHash = requireSha256Ref(value.binding_hash, 'authorization.binding_hash');
  if (!safeEqual(bindingHash, binding.binding_hash)) {
    throw new TypeError('authorization.binding_hash does not match the exact execution binding');
  }
  return {
    authorization_id: requireOpaqueRef(value.authorization_id, 'authorization.authorization_id'),
    authorization_ref: requireOpaqueRef(value.authorization_ref, 'authorization.authorization_ref'),
    authorization_hash: requireSha256Ref(value.authorization_hash, 'authorization.authorization_hash'),
    binding_hash: bindingHash,
    binding,
    governance_evidence_ref: requireOpaqueRef(
      value.governance_evidence_ref,
      'authorization.governance_evidence_ref',
    ),
    governance_evidence_hash: requireSha256Ref(
      value.governance_evidence_hash,
      'authorization.governance_evidence_hash',
    ),
  };
}

export function normalizeDistributedPrepareRequest(input) {
  assertPlainObject(input, 'distributed prepare request');
  assertAllowedKeys(input, [
    'parent_ref',
    'expected_parent_head_hash',
    'artifact_hash',
    'capsule_hash',
    'capsule_expires_at',
    'commit_type',
    'governance_hash',
    'approval_evidence_ref',
    'approval_evidence_hash',
    'authority_request_hash',
    'authorization',
  ], 'distributed prepare request');
  const authorization = normalizePrepareAuthorization(input.authorization);
  const commitType = requireEnum(
    input.commit_type,
    ['TYPED_RESULT', 'WORKSPACE_DIFF', 'CONSEQUENTIAL_ACTION_PROPOSAL'],
    'commit_type',
  );
  if ((commitType === 'CONSEQUENTIAL_ACTION_PROPOSAL') !== (authorization !== null)) {
    throw new TypeError('Consequential commits require exactly one distributed authorization binding');
  }
  const requestBody = {
    schema: 'agoragentic.risk-fork.distributed-prepare-request.v1',
    parent_ref: requireOpaqueRef(input.parent_ref, 'parent_ref'),
    expected_parent_head_hash: requireSha256Ref(
      input.expected_parent_head_hash,
      'expected_parent_head_hash',
    ),
    artifact_hash: requireSha256Ref(input.artifact_hash, 'artifact_hash'),
    capsule_hash: requireSha256Ref(input.capsule_hash, 'capsule_hash'),
    capsule_expires_at: requireIsoDate(input.capsule_expires_at, 'capsule_expires_at'),
    commit_type: commitType,
    governance_hash: requireSha256Ref(input.governance_hash, 'governance_hash'),
    approval_evidence_ref: requireOpaqueRef(input.approval_evidence_ref, 'approval_evidence_ref'),
    approval_evidence_hash: requireSha256Ref(input.approval_evidence_hash, 'approval_evidence_hash'),
    authority_request_hash: requireSha256Ref(input.authority_request_hash, 'authority_request_hash'),
    authorization,
  };
  return deepFreeze({
    ...requestBody,
    request_hash: sha256Ref(requestBody),
  });
}

export function normalizeEffectStartRequest(input) {
  assertPlainObject(input, 'distributed effect-start request');
  assertAllowedKeys(input, ['operation_ref', 'expected_version', 'claimant_ref'], 'distributed effect-start request');
  if (!Number.isSafeInteger(input.expected_version) || input.expected_version < 1) {
    throw new TypeError('expected_version must be a positive safe integer');
  }
  return deepFreeze({
    operation_ref: requireOpaqueRef(input.operation_ref, 'operation_ref'),
    expected_version: input.expected_version,
    claimant_ref: requireOpaqueRef(input.claimant_ref, 'claimant_ref'),
  });
}

export function normalizeFinalizationRequest(input) {
  assertPlainObject(input, 'distributed finalization request');
  assertAllowedKeys(input, [
    'operation_ref',
    'expected_version',
    'effect_token',
    'result',
  ], 'distributed finalization request');
  if (!Number.isSafeInteger(input.expected_version) || input.expected_version < 1) {
    throw new TypeError('expected_version must be a positive safe integer');
  }
  const result = cloneJson(input.result ?? null);
  return deepFreeze({
    operation_ref: requireOpaqueRef(input.operation_ref, 'operation_ref'),
    expected_version: input.expected_version,
    effect_token: requireOpaqueRef(input.effect_token, 'effect_token'),
    result,
    result_hash: sha256Ref(result),
  });
}

export function normalizeAmbiguityRequest(input) {
  assertPlainObject(input, 'distributed ambiguity request');
  assertAllowedKeys(input, [
    'operation_ref',
    'expected_version',
    'effect_token',
    'failure_code',
    'failure_message',
  ], 'distributed ambiguity request');
  if (!Number.isSafeInteger(input.expected_version) || input.expected_version < 1) {
    throw new TypeError('expected_version must be a positive safe integer');
  }
  return deepFreeze({
    operation_ref: requireOpaqueRef(input.operation_ref, 'operation_ref'),
    expected_version: input.expected_version,
    effect_token: requireOpaqueRef(input.effect_token, 'effect_token'),
    failure_code: requireOpaqueRef(input.failure_code, 'failure_code', { maxLength: 200 }),
    failure_message: requireOpaqueRef(input.failure_message, 'failure_message', { maxLength: 1000 }),
  });
}

export function normalizePreparedRecoveryRequest(input) {
  assertPlainObject(input, 'distributed prepared recovery request');
  assertAllowedKeys(input, [
    'operation_ref',
    'expected_version',
    'recovery_evidence_ref',
    'recovery_evidence_hash',
  ], 'distributed prepared recovery request');
  if (!Number.isSafeInteger(input.expected_version) || input.expected_version < 1) {
    throw new TypeError('expected_version must be a positive safe integer');
  }
  return deepFreeze({
    operation_ref: requireOpaqueRef(input.operation_ref, 'operation_ref'),
    expected_version: input.expected_version,
    recovery_evidence_ref: requireOpaqueRef(input.recovery_evidence_ref, 'recovery_evidence_ref'),
    recovery_evidence_hash: requireSha256Ref(input.recovery_evidence_hash, 'recovery_evidence_hash'),
  });
}

export function normalizeReconciliationInput(input) {
  assertPlainObject(input, 'distributed reconciliation input');
  assertAllowedKeys(input, [
    'operation_ref',
    'expected_version',
    'resolution',
    'requested_by',
    'outcome_evidence_ref',
    'outcome_evidence_hash',
    'result',
  ], 'distributed reconciliation input');
  if (!Number.isSafeInteger(input.expected_version) || input.expected_version < 1) {
    throw new TypeError('expected_version must be a positive safe integer');
  }
  const resolution = requireEnum(
    input.resolution,
    DISTRIBUTED_RECONCILIATION_RESOLUTIONS,
    'resolution',
  );
  if (resolution === 'effect_succeeded' && !Object.hasOwn(input, 'result')) {
    throw new TypeError('effect_succeeded reconciliation requires the exact result');
  }
  const result = cloneJson(input.result ?? null);
  return deepFreeze({
    operation_ref: requireOpaqueRef(input.operation_ref, 'operation_ref'),
    expected_version: input.expected_version,
    resolution,
    requested_by: requireOpaqueRef(input.requested_by, 'requested_by'),
    outcome_evidence_ref: requireOpaqueRef(input.outcome_evidence_ref, 'outcome_evidence_ref'),
    outcome_evidence_hash: requireSha256Ref(input.outcome_evidence_hash, 'outcome_evidence_hash'),
    result,
    result_hash: sha256Ref(result),
  });
}

export function buildReconciliationVerificationRequest(operation, input, observedAt) {
  const body = {
    schema: 'agoragentic.risk-fork.distributed-reconciliation-verification-request.v1',
    operation_ref: requireOpaqueRef(operation.operation_ref, 'operation.operation_ref'),
    operation_version: operation.version,
    request_hash: requireSha256Ref(operation.request_hash, 'operation.request_hash'),
    effect_key: requireOpaqueRef(operation.effect_key, 'operation.effect_key'),
    resolution: input.resolution,
    requested_by: input.requested_by,
    outcome_evidence_ref: input.outcome_evidence_ref,
    outcome_evidence_hash: input.outcome_evidence_hash,
    result_hash: input.result_hash,
    observed_at: requireIsoDate(observedAt, 'reconciliation observed_at'),
  };
  return deepFreeze({ ...body, verification_request_hash: sha256Ref(body) });
}

export function verifyReconciliationVerification(value, request) {
  assertPlainObject(value, 'distributed reconciliation verification');
  assertAllowedKeys(value, [
    'schema',
    'status',
    'verification_request_hash',
    'operation_ref',
    'operation_version',
    'effect_key',
    'resolution',
    'result_hash',
    'evidence_ref',
    'evidence_hash',
  ], 'distributed reconciliation verification');
  if (value.schema !== 'agoragentic.risk-fork.distributed-reconciliation-verification.v1'
    || value.status !== 'verified'
    || !safeEqual(value.verification_request_hash, request.verification_request_hash)
    || value.operation_ref !== request.operation_ref
    || value.operation_version !== request.operation_version
    || value.effect_key !== request.effect_key
    || value.resolution !== request.resolution
    || !safeEqual(value.result_hash, request.result_hash)) {
    throw distributedAuthorityError(
      'Trusted reconciliation verification did not bind the exact unresolved operation',
      'DISTRIBUTED_RECONCILIATION_NOT_VERIFIED',
      { operation_ref: request.operation_ref, operation_version: request.operation_version },
    );
  }
  return deepFreeze({
    evidence_ref: requireOpaqueRef(value.evidence_ref, 'reconciliation verification.evidence_ref'),
    evidence_hash: requireSha256Ref(value.evidence_hash, 'reconciliation verification.evidence_hash'),
  });
}

export function buildAuthorizationVerificationRequest(current, authorization, observedAt) {
  const body = {
    schema: 'agoragentic.risk-fork.distributed-authorization-verification-request.v1',
    authorization_id: current.authorization_id,
    authorization_ref: current.authorization_ref,
    authorization_hash: current.authorization_hash,
    binding_hash: current.binding_hash,
    expires_at: requireIsoDate(current.expires_at, 'authorization expires_at'),
    registration_evidence_ref: current.evidence_ref,
    registration_evidence_hash: current.evidence_hash,
    binding: cloneJson(authorization.binding),
    governance_evidence_ref: authorization.governance_evidence_ref,
    governance_evidence_hash: authorization.governance_evidence_hash,
    observed_at: requireIsoDate(observedAt, 'authorization observed_at'),
  };
  return deepFreeze({ ...body, verification_request_hash: sha256Ref(body) });
}

export function verifyAuthorizationVerification(value, request) {
  assertPlainObject(value, 'distributed authorization verification');
  assertAllowedKeys(value, [
    'schema',
    'status',
    'verification_request_hash',
    'authorization_id',
    'authorization_ref',
    'authorization_hash',
    'binding_hash',
    'signature_status',
    'integrity_status',
    'exact_binding_status',
    'evidence_ref',
    'evidence_hash',
  ], 'distributed authorization verification');
  if (value.schema !== 'agoragentic.risk-fork.distributed-authorization-verification.v1'
    || value.status !== 'verified'
    || value.signature_status !== 'verified'
    || value.integrity_status !== 'verified'
    || value.exact_binding_status !== 'verified'
    || !safeEqual(value.verification_request_hash, request.verification_request_hash)
    || value.authorization_id !== request.authorization_id
    || value.authorization_ref !== request.authorization_ref
    || !safeEqual(value.authorization_hash, request.authorization_hash)
    || !safeEqual(value.binding_hash, request.binding_hash)) {
    throw distributedAuthorityError(
      'Trusted authorization verification did not bind the exact active authorization',
      'DISTRIBUTED_AUTHORIZATION_NOT_VERIFIED',
      { authorization_id: request.authorization_id, binding_hash: request.binding_hash },
    );
  }
  return deepFreeze({
    evidence_ref: requireOpaqueRef(value.evidence_ref, 'authorization verification.evidence_ref'),
    evidence_hash: requireSha256Ref(value.evidence_hash, 'authorization verification.evidence_hash'),
  });
}
