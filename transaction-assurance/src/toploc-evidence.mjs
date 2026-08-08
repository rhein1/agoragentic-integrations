import { canonicalize, computeEnvelopeHash, sha256Ref } from './index.mjs';

export const TOPLOC_ATTESTATION_SCHEMA = 'agoragentic.toploc-inference-attestation.v1';
export const TOPLOC_SUMMARY_SCHEMA = 'agoragentic.toploc-inference-attestation-summary.v1';

const STATUSES = new Set(['accept', 'reject', 'pending', 'not_checked', 'error']);
const FINAL_STATUSES = new Set(['accept', 'reject']);
const SHA256_PATTERN = /^sha256:[0-9a-f]{64}$/;
const RAW_INPUT_FIELDS = new Set([
  'attestation_id',
  'scheme_version',
  'model_ref',
  'configuration_hash',
  'proof_ref',
  'proof_hash',
  'validator_ref',
  'validator_version',
  'status',
  'checked_at',
  'evidence_refs',
]);
const RAW_PAYLOAD_FIELDS = new Set([
  'proof',
  'raw_proof',
  'raw_proof_payload',
  'activations',
  'raw_activations',
]);

function isObject(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function assertJsonValue(value, field) {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return;
  if (typeof value === 'number' && Number.isFinite(value)) return;
  if (Array.isArray(value)) {
    for (let index = 0; index < value.length; index += 1) {
      if (!Object.hasOwn(value, index)) throw new TypeError(`${field}[${index}] must contain a JSON value`);
      assertJsonValue(value[index], `${field}[${index}]`);
    }
    return;
  }
  if (isObject(value)) {
    for (const [key, child] of Object.entries(value)) {
      assertJsonValue(child, `${field}.${key}`);
    }
    return;
  }
  throw new TypeError(`${field} must contain JSON values only`);
}

function requiredText(value, field, maxLength = 2000) {
  if (typeof value !== 'string') throw new TypeError(`${field} must be a string`);
  const normalized = value.trim();
  if (!normalized) throw new TypeError(`${field} is required`);
  if (normalized.length > maxLength) throw new TypeError(`${field} exceeds ${maxLength} characters`);
  return normalized;
}

function optionalText(value, field, maxLength = 2000) {
  if (value === undefined || value === null) return null;
  return requiredText(value, field, maxLength);
}

function requiredSha256(value, field) {
  const normalized = requiredText(value, field, 71);
  if (!SHA256_PATTERN.test(normalized)) {
    throw new TypeError(`${field} must be a lowercase sha256:<64 hex characters> reference`);
  }
  return normalized;
}

function normalizeDate(value, field, required = false) {
  if (value === undefined || value === null || value === '') {
    if (required) throw new TypeError(`${field} is required for final validator statuses`);
    return null;
  }
  if (typeof value !== 'string' && !(value instanceof Date)) {
    throw new TypeError(`${field} must be a valid date-time`);
  }
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) throw new TypeError(`${field} must be a valid date-time`);
  return parsed.toISOString();
}

function normalizeEvidenceRefs(value) {
  if (value === undefined || value === null) return [];
  const source = Array.isArray(value) ? value : [value];
  if (source.length > 100) throw new TypeError('evidence_refs must contain at most 100 entries');
  const normalized = [];
  for (let index = 0; index < source.length; index += 1) {
    if (!Object.hasOwn(source, index)) {
      throw new TypeError(`evidence_refs[${index}] must contain a string`);
    }
    normalized.push(requiredText(source[index], `evidence_refs[${index}]`, 2000));
  }
  return [...new Set(normalized)];
}

function nonClaims() {
  return {
    output_correctness_proven: false,
    task_fulfillment_proven: false,
    seller_identity_proven: false,
    payment_settlement_proven: false,
    delivery_proven: false,
    complete_transaction_verified: false,
    certification: false,
    trust_endorsement: false,
  };
}

function authorityFlags() {
  return {
    attestation_grants_authority: false,
    can_spend: false,
    can_fund_wallet: false,
    can_deploy: false,
    can_publish: false,
    can_change_trust: false,
    can_expand_scope: false,
  };
}

function assertRawInputFields(input) {
  for (const field of Object.keys(input)) {
    if (RAW_PAYLOAD_FIELDS.has(field)) {
      throw new TypeError('embed no raw proof or activations; use references and SHA-256 hashes');
    }
    if (!RAW_INPUT_FIELDS.has(field)) {
      throw new TypeError(`unsupported TOPLOC evidence field: ${field}`);
    }
  }
}

export function computeToplocAttestationHash(attestation) {
  if (!isObject(attestation)) throw new TypeError('TOPLOC attestation must be an object');
  return sha256Ref({
    ...attestation,
    attestation_hash: null,
  });
}

function buildToplocEvidence(input) {
  assertRawInputFields(input);
  const status = requiredText(input.status, 'status', 32);
  if (!STATUSES.has(status)) throw new TypeError(`unsupported TOPLOC validation status: ${status}`);

  const schemeVersion = requiredText(input.scheme_version, 'scheme_version', 500);
  const modelRef = requiredText(input.model_ref, 'model_ref');
  const configurationHash = requiredSha256(input.configuration_hash, 'configuration_hash');
  const proofRef = requiredText(input.proof_ref, 'proof_ref');
  const proofHash = requiredSha256(input.proof_hash, 'proof_hash');
  const validatorRef = requiredText(input.validator_ref, 'validator_ref');
  const validatorVersion = requiredText(input.validator_version, 'validator_version', 500);
  const checkedAt = normalizeDate(input.checked_at, 'checked_at', FINAL_STATUSES.has(status));
  const evidenceRefs = normalizeEvidenceRefs(input.evidence_refs);
  const attestationId = optionalText(input.attestation_id, 'attestation_id', 500)
    || `toploc_${sha256Ref({
      scheme_version: schemeVersion,
      model_ref: modelRef,
      configuration_hash: configurationHash,
      proof_ref: proofRef,
      proof_hash: proofHash,
      validator_ref: validatorRef,
      validator_version: validatorVersion,
      status,
      checked_at: checkedAt,
    }).slice(7, 23)}`;

  const attestation = {
    schema: TOPLOC_ATTESTATION_SCHEMA,
    attestation_id: attestationId,
    scheme: 'toploc',
    scheme_version: schemeVersion,
    model_ref: modelRef,
    configuration_hash: configurationHash,
    proof_ref: proofRef,
    proof_hash: proofHash,
    validator: {
      ref: validatorRef,
      version: validatorVersion,
    },
    status,
    checked_at: checkedAt,
    evidence_refs: evidenceRefs,
    scope: 'model_configuration_execution',
    source_artifact_embedded: false,
    trust: {
      verification_status: 'not_verified',
      trusted_proof: false,
      caller_supplied: true,
    },
    provenance: {
      verification_status: 'not_verified',
      validator_identity_verified: false,
      proof_binding_verified: false,
    },
    privacy: {
      verification_status: 'not_verified',
      public_safe_status: 'not_verified',
    },
    source_exactness: {
      verification_status: 'not_verified',
      exact_source_verified: false,
    },
    non_claims: nonClaims(),
    authority_flags: authorityFlags(),
    attestation_hash: null,
  };

  attestation.attestation_hash = computeToplocAttestationHash(attestation);
  return attestation;
}

export function verifyToplocEvidence(attestation) {
  if (!isObject(attestation) || attestation.schema !== TOPLOC_ATTESTATION_SCHEMA) {
    throw new TypeError(`TOPLOC attestation must use ${TOPLOC_ATTESTATION_SCHEMA}`);
  }
  assertJsonValue(attestation, 'TOPLOC attestation');
  const suppliedHash = requiredSha256(attestation.attestation_hash, 'attestation_hash');
  const expectedHash = computeToplocAttestationHash(attestation);
  if (suppliedHash !== expectedHash) throw new TypeError('TOPLOC attestation hash mismatch');

  const normalized = buildToplocEvidence({
    attestation_id: attestation.attestation_id,
    scheme_version: attestation.scheme_version,
    model_ref: attestation.model_ref,
    configuration_hash: attestation.configuration_hash,
    proof_ref: attestation.proof_ref,
    proof_hash: attestation.proof_hash,
    validator_ref: attestation.validator?.ref,
    validator_version: attestation.validator?.version,
    status: attestation.status,
    checked_at: attestation.checked_at,
    evidence_refs: attestation.evidence_refs,
  });
  if (canonicalize(attestation) !== canonicalize(normalized)) {
    throw new TypeError('TOPLOC attestation is not the canonical v1 shape');
  }
  return normalized;
}

export function normalizeToplocEvidence(input = {}) {
  if (!isObject(input)) throw new TypeError('TOPLOC evidence must be an object');
  if (Object.hasOwn(input, 'schema')) {
    if (input.schema !== TOPLOC_ATTESTATION_SCHEMA) {
      throw new TypeError(`unsupported TOPLOC evidence schema: ${input.schema}`);
    }
    return verifyToplocEvidence(input);
  }
  return buildToplocEvidence(input);
}

function normalizeEntries(entries) {
  if (entries.length > 100) throw new TypeError('entries must contain at most 100 TOPLOC attestations');
  const normalized = [];
  const attestationIds = new Set();
  for (let index = 0; index < entries.length; index += 1) {
    if (!Object.hasOwn(entries, index)) {
      throw new TypeError(`entries[${index}] must contain a TOPLOC attestation`);
    }
    const attestation = normalizeToplocEvidence(entries[index]);
    if (attestationIds.has(attestation.attestation_id)) {
      throw new TypeError(`duplicate TOPLOC attestation_id: ${attestation.attestation_id}`);
    }
    attestationIds.add(attestation.attestation_id);
    normalized.push(attestation);
  }
  return normalized;
}

export function summarizeToplocEvidence(entries = []) {
  if (!Array.isArray(entries)) throw new TypeError('entries must be an array');
  const normalized = normalizeEntries(entries);
  const declaredAcceptCount = normalized.filter((entry) => entry.status === 'accept').length;
  const declaredRejectCount = normalized.filter((entry) => entry.status === 'reject').length;
  const declaredReviewCount = normalized.length - declaredAcceptCount - declaredRejectCount;
  const declaredValidationResult = declaredRejectCount > 0
    ? 'rejected'
    : declaredAcceptCount === normalized.length && normalized.length > 0
      ? 'accepted'
      : 'review';

  return {
    schema: TOPLOC_SUMMARY_SCHEMA,
    status: declaredRejectCount > 0 ? 'rejected' : 'review',
    declared_validation_result: declaredValidationResult,
    attestation_count: normalized.length,
    declared_accept_count: declaredAcceptCount,
    declared_reject_count: declaredRejectCount,
    declared_review_count: declaredReviewCount,
    scope: 'model_configuration_execution',
    verification_status: 'not_verified',
    provenance_verification_status: 'not_verified',
    source_exactness_verification_status: 'not_verified',
    privacy_verification_status: 'not_verified',
    public_safe_verification_status: 'not_verified',
    trusted_proof: false,
    ...nonClaims(),
    authority_granted: false,
  };
}

function verifyEnvelopeHash(envelope) {
  if (!isObject(envelope.evidence)) throw new TypeError('envelope.evidence must be an object');
  const suppliedHash = requiredSha256(envelope.evidence.envelope_hash, 'envelope.evidence.envelope_hash');
  if (suppliedHash !== computeEnvelopeHash(envelope)) {
    throw new TypeError('transaction assurance envelope hash mismatch');
  }
}

export function attachToplocEvidence(envelope, entries, options = {}) {
  if (!isObject(envelope) || envelope.schema !== 'agoragentic.transaction-assurance-envelope.v1') {
    throw new TypeError('envelope must use agoragentic.transaction-assurance-envelope.v1');
  }
  assertJsonValue(envelope, 'envelope');
  if (!isObject(options)) throw new TypeError('options must be an object');
  for (const field of Object.keys(options)) {
    if (field !== 'updatedAt') throw new TypeError(`unsupported attach option: ${field}`);
  }
  verifyEnvelopeHash(envelope);

  if (envelope.inference_attestations !== undefined
    && !Array.isArray(envelope.inference_attestations)) {
    throw new TypeError('envelope.inference_attestations must be an array');
  }
  const existing = normalizeEntries(envelope.inference_attestations || []);
  const expectedExistingSummary = summarizeToplocEvidence(existing);
  if (envelope.inference_attestation_summary !== undefined
    && canonicalize(envelope.inference_attestation_summary) !== canonicalize(expectedExistingSummary)) {
    throw new TypeError('existing TOPLOC attestation summary mismatch');
  }

  const source = Array.isArray(entries) ? entries : [entries];
  if (source.length === 0) throw new TypeError('at least one TOPLOC attestation is required');
  const normalized = normalizeEntries(source);
  const updatedAt = normalizeDate(options.updatedAt ?? new Date(), 'updatedAt', true);
  const attached = structuredClone(envelope);
  attached.inference_attestations = [...existing, ...normalized];
  attached.inference_attestation_summary = summarizeToplocEvidence(attached.inference_attestations);
  attached.evidence.complete_chain_verified = false;
  attached.updated_at = updatedAt;
  attached.evidence.envelope_hash = null;
  attached.evidence.envelope_hash = computeEnvelopeHash(attached);
  return attached;
}
