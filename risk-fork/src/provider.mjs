import { sha256Ref } from './canonical.mjs';
import {
  assertAllowedKeys,
  assertPlainObject,
  deepFreeze,
  boundedInteger,
  requireEnum,
  requireIsoDate,
  requireOpaqueRef,
  requireSha256Ref,
  requireString,
  safeEqual,
} from './util.mjs';

export const CLEANUP_VERIFICATION_REQUEST_SCHEMA =
  'agoragentic.risk-fork.cleanup-verification-request.v1';
export const CLEANUP_VERIFICATION_EVIDENCE_SCHEMA =
  'agoragentic.risk-fork.cleanup-verification-evidence.v1';

const RESOURCE_METHODS = Object.freeze({
  fork: Object.freeze({ destroy: 'destroyFork', verify: 'verifyDestroyed' }),
  savepoint: Object.freeze({ destroy: 'destroySavepoint', verify: 'verifySavepointDestroyed' }),
});
const CLEANUP_EVIDENCE_KEYS = Object.freeze([
  'schema',
  'status',
  'outcome',
  'provider_id',
  'resource_kind',
  'resource_ref',
  'destroy_method',
  'verify_method',
  'cleanup_request_hash',
  'requested_at',
  'observed_at',
  'evidence_ref',
  'observation_hash',
  'evidence_hash',
]);

export function verifyCleanupVerificationRequest(value, expected = {}) {
  assertPlainObject(value, 'cleanup verification request');
  assertAllowedKeys(value, [
    'schema',
    'provider_id',
    'resource_kind',
    'resource_ref',
    'destroy_method',
    'verify_method',
    'requested_at',
    'request_nonce',
    'request_hash',
  ], 'cleanup verification request');
  if (value.schema !== CLEANUP_VERIFICATION_REQUEST_SCHEMA) {
    throw new Error('Cleanup verification request schema is invalid');
  }
  const resourceKind = requireEnum(
    value.resource_kind,
    Object.keys(RESOURCE_METHODS),
    'cleanup verification request.resource_kind',
  );
  const normalized = {
    schema: CLEANUP_VERIFICATION_REQUEST_SCHEMA,
    provider_id: requireOpaqueRef(value.provider_id, 'cleanup verification request.provider_id'),
    resource_kind: resourceKind,
    resource_ref: requireOpaqueRef(value.resource_ref, 'cleanup verification request.resource_ref'),
    destroy_method: requireEnum(
      value.destroy_method,
      [RESOURCE_METHODS[resourceKind].destroy],
      'cleanup verification request.destroy_method',
    ),
    verify_method: requireEnum(
      value.verify_method,
      [RESOURCE_METHODS[resourceKind].verify],
      'cleanup verification request.verify_method',
    ),
    requested_at: requireIsoDate(
      value.requested_at,
      'cleanup verification request.requested_at',
    ),
    request_nonce: requireOpaqueRef(
      value.request_nonce,
      'cleanup verification request.request_nonce',
    ),
    request_hash: requireSha256Ref(
      value.request_hash,
      'cleanup verification request.request_hash',
    ),
  };
  const expectedHash = sha256Ref({ ...normalized, request_hash: null });
  if (!safeEqual(normalized.request_hash, expectedHash)) {
    throw new Error('Cleanup verification request hash mismatch');
  }
  for (const [field, expectedValue] of Object.entries(expected)) {
    if (expectedValue !== undefined && normalized[field] !== expectedValue) {
      throw new Error(`Cleanup verification request binding mismatch: ${field}`);
    }
  }
  return deepFreeze(normalized);
}

export function createCleanupVerificationRequest(input = {}) {
  const resourceKind = requireEnum(
    input.resource_kind,
    Object.keys(RESOURCE_METHODS),
    'cleanup verification request.resource_kind',
  );
  const request = {
    schema: CLEANUP_VERIFICATION_REQUEST_SCHEMA,
    provider_id: requireOpaqueRef(input.provider_id, 'cleanup verification request.provider_id'),
    resource_kind: resourceKind,
    resource_ref: requireOpaqueRef(input.resource_ref, 'cleanup verification request.resource_ref'),
    destroy_method: RESOURCE_METHODS[resourceKind].destroy,
    verify_method: RESOURCE_METHODS[resourceKind].verify,
    requested_at: requireIsoDate(input.requested_at, 'cleanup verification request.requested_at'),
    request_nonce: requireOpaqueRef(input.request_nonce, 'cleanup verification request.request_nonce'),
    request_hash: null,
  };
  request.request_hash = sha256Ref(request);
  return verifyCleanupVerificationRequest(request);
}

export function createCleanupVerificationEvidence(requestValue, input = {}) {
  const request = verifyCleanupVerificationRequest(requestValue);
  const status = requireEnum(
    input.status,
    ['verified', 'failed', 'unknown'],
    'cleanup verification evidence.status',
  );
  const expectedOutcome = status === 'verified'
    ? 'success'
    : status === 'failed'
      ? 'failure'
      : 'unknown';
  const outcome = requireEnum(
    input.outcome ?? expectedOutcome,
    [expectedOutcome],
    'cleanup verification evidence.outcome',
  );
  const evidenceRef = input.evidence_ref == null
    ? null
    : requireOpaqueRef(input.evidence_ref, 'cleanup verification evidence.evidence_ref');
  if (status === 'verified' && evidenceRef === null) {
    throw new Error('Verified cleanup evidence requires evidence_ref');
  }
  const evidence = {
    schema: CLEANUP_VERIFICATION_EVIDENCE_SCHEMA,
    status,
    outcome,
    provider_id: request.provider_id,
    resource_kind: request.resource_kind,
    resource_ref: request.resource_ref,
    destroy_method: request.destroy_method,
    verify_method: request.verify_method,
    cleanup_request_hash: request.request_hash,
    requested_at: request.requested_at,
    observed_at: requireIsoDate(
      input.observed_at ?? request.requested_at,
      'cleanup verification evidence.observed_at',
    ),
    evidence_ref: evidenceRef,
    observation_hash: requireSha256Ref(
      input.observation_hash,
      'cleanup verification evidence.observation_hash',
    ),
    evidence_hash: null,
  };
  evidence.evidence_hash = sha256Ref(evidence);
  return deepFreeze(evidence);
}

export function verifyCleanupVerificationEvidence(value, requestValue, options = {}) {
  const request = verifyCleanupVerificationRequest(requestValue);
  assertPlainObject(value, 'cleanup verification evidence');
  assertAllowedKeys(value, CLEANUP_EVIDENCE_KEYS, 'cleanup verification evidence');
  if (value.schema !== CLEANUP_VERIFICATION_EVIDENCE_SCHEMA) {
    throw new Error('Cleanup verification evidence schema is invalid');
  }
  const status = requireEnum(
    value.status,
    ['verified', 'failed', 'unknown'],
    'cleanup verification evidence.status',
  );
  const expectedOutcome = status === 'verified'
    ? 'success'
    : status === 'failed'
      ? 'failure'
      : 'unknown';
  const normalized = {
    schema: CLEANUP_VERIFICATION_EVIDENCE_SCHEMA,
    status,
    outcome: requireEnum(
      value.outcome,
      [expectedOutcome],
      'cleanup verification evidence.outcome',
    ),
    provider_id: requireOpaqueRef(value.provider_id, 'cleanup verification evidence.provider_id'),
    resource_kind: requireEnum(
      value.resource_kind,
      [request.resource_kind],
      'cleanup verification evidence.resource_kind',
    ),
    resource_ref: requireOpaqueRef(value.resource_ref, 'cleanup verification evidence.resource_ref'),
    destroy_method: requireEnum(
      value.destroy_method,
      [request.destroy_method],
      'cleanup verification evidence.destroy_method',
    ),
    verify_method: requireEnum(
      value.verify_method,
      [request.verify_method],
      'cleanup verification evidence.verify_method',
    ),
    cleanup_request_hash: requireSha256Ref(
      value.cleanup_request_hash,
      'cleanup verification evidence.cleanup_request_hash',
    ),
    requested_at: requireIsoDate(value.requested_at, 'cleanup verification evidence.requested_at'),
    observed_at: requireIsoDate(value.observed_at, 'cleanup verification evidence.observed_at'),
    evidence_ref: value.evidence_ref == null
      ? null
      : requireOpaqueRef(value.evidence_ref, 'cleanup verification evidence.evidence_ref'),
    observation_hash: requireSha256Ref(
      value.observation_hash,
      'cleanup verification evidence.observation_hash',
    ),
    evidence_hash: requireSha256Ref(
      value.evidence_hash,
      'cleanup verification evidence.evidence_hash',
    ),
  };
  for (const field of ['provider_id', 'resource_kind', 'resource_ref']) {
    if (normalized[field] !== request[field]) {
      throw new Error(`Cleanup verification evidence binding mismatch: ${field}`);
    }
  }
  if (!safeEqual(normalized.cleanup_request_hash, request.request_hash)
    || normalized.requested_at !== request.requested_at) {
    throw new Error('Cleanup verification evidence request binding mismatch');
  }
  if (status === 'verified' && normalized.evidence_ref === null) {
    throw new Error('Verified cleanup evidence requires evidence_ref');
  }
  const expectedHash = sha256Ref({ ...normalized, evidence_hash: null });
  if (!safeEqual(normalized.evidence_hash, expectedHash)) {
    throw new Error('Cleanup verification evidence hash mismatch');
  }
  const requestedAt = Date.parse(request.requested_at);
  const observedAt = Date.parse(normalized.observed_at);
  const now = Date.parse(requireIsoDate(options.now ?? new Date(), 'cleanup verification now'));
  const maxAgeMs = boundedInteger(
    options.max_age_ms ?? 5 * 60 * 1_000,
    'cleanup verification max_age_ms',
    { min: 1, max: 24 * 60 * 60 * 1_000 },
  );
  if (observedAt < requestedAt || observedAt > now + 1_000 || now - observedAt > maxAgeMs) {
    throw new Error('Cleanup verification evidence is stale or outside the request window');
  }
  return deepFreeze(normalized);
}

export const REQUIRED_PROVIDER_METHODS = Object.freeze([
  'createSavepoint',
  'createFork',
  'getForkStatus',
  'executeInFork',
  'collectEvidence',
  'collectDiff',
  'suspendFork',
  'destroyFork',
  'verifyDestroyed',
  'destroySavepoint',
  'verifySavepointDestroyed',
]);

export class RiskForkProvider {
  constructor({ id, capabilities }) {
    this.id = requireString(id, 'provider id', { maxLength: 200 });
    this.capabilities = deepFreeze({
      supports_memory_snapshot: capabilities?.supports_memory_snapshot === true,
      supports_filesystem_snapshot: capabilities?.supports_filesystem_snapshot === true,
      supports_live_fork: capabilities?.supports_live_fork === true,
      supports_network_policy: capabilities?.supports_network_policy === true,
      supports_egress_allowlist: capabilities?.supports_egress_allowlist === true,
      supports_runtime_attestation: capabilities?.supports_runtime_attestation === true,
      supports_suspend_resume: capabilities?.supports_suspend_resume === true,
      supports_verified_destruction: capabilities?.supports_verified_destruction === true,
      supports_hard_ttl: capabilities?.supports_hard_ttl === true,
      supports_idle_ttl: capabilities?.supports_idle_ttl === true,
      supports_max_execution_time: capabilities?.supports_max_execution_time === true,
      supports_automatic_credential_expiry:
        capabilities?.supports_automatic_credential_expiry === true,
      child_credentials_mode: requireEnum(
        capabilities?.child_credentials_mode ?? 'unknown',
        ['prohibited', 'scoped_expiring', 'unknown'],
        'capabilities.child_credentials_mode',
      ),
      isolation_class: requireString(
        capabilities?.isolation_class ?? 'unknown',
        'capabilities.isolation_class',
        { maxLength: 100 },
      ),
      adapter_implementation: requireString(
        capabilities?.adapter_implementation ?? 'unknown',
        'capabilities.adapter_implementation',
        { maxLength: 100 },
      ),
      mock_conformance: requireString(
        capabilities?.mock_conformance ?? 'unknown',
        'capabilities.mock_conformance',
        { maxLength: 100 },
      ),
      credentialed_provider_validation: requireString(
        capabilities?.credentialed_provider_validation ?? 'not_run',
        'capabilities.credentialed_provider_validation',
        { maxLength: 100 },
      ),
      containment_claim: requireString(
        capabilities?.containment_claim ?? 'not_verified',
        'capabilities.containment_claim',
        { maxLength: 100 },
      ),
    });
  }

  async createSavepoint() { throw new Error(`${this.id}.createSavepoint is not implemented`); }

  async createFork() { throw new Error(`${this.id}.createFork is not implemented`); }

  async getForkStatus() { throw new Error(`${this.id}.getForkStatus is not implemented`); }

  async executeInFork() { throw new Error(`${this.id}.executeInFork is not implemented`); }

  async collectEvidence() { throw new Error(`${this.id}.collectEvidence is not implemented`); }

  async collectDiff() { throw new Error(`${this.id}.collectDiff is not implemented`); }

  async suspendFork() { throw new Error(`${this.id}.suspendFork is not implemented`); }

  async destroyFork() { throw new Error(`${this.id}.destroyFork is not implemented`); }

  async verifyDestroyed() { throw new Error(`${this.id}.verifyDestroyed is not implemented`); }

  async destroySavepoint() { throw new Error(`${this.id}.destroySavepoint is not implemented`); }

  async verifySavepointDestroyed() {
    throw new Error(`${this.id}.verifySavepointDestroyed is not implemented`);
  }
}

export function assertRiskForkProvider(provider) {
  if (!provider || typeof provider !== 'object') throw new TypeError('provider must be an object');
  requireString(provider.id, 'provider.id');
  if (!provider.capabilities || typeof provider.capabilities !== 'object') {
    throw new TypeError('provider.capabilities is required');
  }
  for (const method of REQUIRED_PROVIDER_METHODS) {
    if (typeof provider[method] !== 'function') {
      throw new TypeError(`provider.${method} must be a function`);
    }
  }
  return provider;
}

export function requireProviderCapability(provider, capability) {
  assertRiskForkProvider(provider);
  if (provider.capabilities[capability] !== true) {
    throw new Error(`Provider ${provider.id} does not support ${capability}`);
  }
}
