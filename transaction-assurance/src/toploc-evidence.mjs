import { sha256Ref } from './index.mjs';

const STATUSES = new Set(['accept', 'reject', 'pending', 'not_checked', 'error']);

function isObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function text(value, field, required = false) {
  const normalized = value === undefined || value === null ? '' : String(value).trim();
  if (required && !normalized) throw new TypeError(`${field} is required`);
  return normalized || null;
}

function list(value) {
  if (value === undefined || value === null) return [];
  const source = Array.isArray(value) ? value : [value];
  return [...new Set(source.map((item) => String(item).trim()).filter(Boolean))].slice(0, 100);
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
  };
}

export function normalizeToplocEvidence(input = {}) {
  if (!isObject(input)) throw new TypeError('TOPLOC evidence must be an object');
  if (input.proof !== undefined || input.activations !== undefined || input.raw_activations !== undefined) {
    throw new TypeError('embed no raw proof or activations; use references and hashes');
  }
  const status = text(input.status, 'status', true);
  if (!STATUSES.has(status)) throw new TypeError(`unsupported TOPLOC validation status: ${status}`);
  const evidence = {
    schema: 'agoragentic.toploc-inference-attestation.v1',
    attestation_id: text(input.attestation_id) || `toploc_${sha256Ref({
      model: input.model_ref,
      configuration: input.configuration_hash,
      proof: input.proof_hash,
      validator: input.validator_ref,
      status,
    }).slice(7, 23)}`,
    scheme: 'toploc',
    scheme_version: text(input.scheme_version, 'scheme_version', true),
    model_ref: text(input.model_ref, 'model_ref', true),
    configuration_hash: text(input.configuration_hash, 'configuration_hash', true),
    proof_ref: text(input.proof_ref, 'proof_ref', true),
    proof_hash: text(input.proof_hash, 'proof_hash', true),
    validator: {
      ref: text(input.validator_ref, 'validator_ref', true),
      version: text(input.validator_version, 'validator_version', true),
    },
    status,
    checked_at: input.checked_at ? new Date(input.checked_at).toISOString() : null,
    evidence_refs: list(input.evidence_refs),
    scope: 'model_configuration_execution',
    source_artifact_embedded: false,
    non_claims: nonClaims(),
    authority_flags: authorityFlags(),
  };
  if ((status === 'accept' || status === 'reject') && !evidence.checked_at) {
    throw new TypeError('checked_at is required for final validator statuses');
  }
  evidence.attestation_hash = sha256Ref(evidence);
  return evidence;
}

export function summarizeToplocEvidence(entries = []) {
  if (!Array.isArray(entries)) throw new TypeError('entries must be an array');
  const normalized = entries.map((entry) => (
    entry?.schema === 'agoragentic.toploc-inference-attestation.v1'
      ? entry
      : normalizeToplocEvidence(entry)
  ));
  const rejected = normalized.filter((entry) => entry.status === 'reject');
  const accepted = normalized.filter((entry) => entry.status === 'accept');
  const status = rejected.length > 0
    ? 'rejected'
    : accepted.length === normalized.length && normalized.length > 0
      ? 'accepted'
      : 'review';
  return {
    schema: 'agoragentic.toploc-inference-attestation-summary.v1',
    status,
    attestation_count: normalized.length,
    accepted_count: accepted.length,
    rejected_count: rejected.length,
    scope: 'model_configuration_execution',
    ...nonClaims(),
    authority_granted: false,
  };
}

export function attachToplocEvidence(envelope, entries) {
  if (!isObject(envelope) || envelope.schema !== 'agoragentic.transaction-assurance-envelope.v1') {
    throw new TypeError('envelope must use agoragentic.transaction-assurance-envelope.v1');
  }
  const source = Array.isArray(entries) ? entries : [entries];
  const normalized = source.map((entry) => normalizeToplocEvidence(entry));
  const attached = structuredClone(envelope);
  attached.inference_attestations = [
    ...(Array.isArray(attached.inference_attestations) ? attached.inference_attestations : []),
    ...normalized,
  ];
  attached.inference_attestation_summary = summarizeToplocEvidence(attached.inference_attestations);
  if (!isObject(attached.evidence)) attached.evidence = {};
  attached.evidence.complete_chain_verified = false;
  delete attached.evidence.envelope_hash;
  attached.evidence.envelope_hash = sha256Ref(attached);
  attached.updated_at = new Date().toISOString();
  return attached;
}
