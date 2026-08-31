import { canonicalize, hashValue } from './index.mjs';
import { types } from 'node:util';
import {
  sha256Ref,
  snapshotJsonData,
  snapshotPublicSafeJson,
  verifyQualificationEvidencePacket,
} from '../integration-qualification/src/index.mjs';
import { verifyPrimeAgentCompatibilityReceipt } from './compatibility-runner.mjs';
import {
  verifyPrimeAgentIntegrityProfile,
} from './artifact-integrity.mjs';
import { buildPrimeAgentV072DependencyAudit } from './evidence/build-dependency-audit.mjs';
import { buildPrimeAgentV072QualificationEvidence } from './evidence/build-evidence.mjs';
import {
  PRIME_AGENT_COMMAND_PREVIEW,
  PRIME_AGENT_EVIDENCE_REFS,
  PRIME_AGENT_EXTENSION_VERSION,
  PRIME_AGENT_HARD_ENFORCEMENT,
  PRIME_AGENT_HOST_CONTRACT,
  PRIME_AGENT_HOST_IDENTITY,
  PRIME_AGENT_KNOWN_LIMITATIONS,
  PRIME_AGENT_REQUIRED_RPC_COMMANDS,
  PRIME_AGENT_RUNTIME_ADAPTER_ID,
  PRIME_AGENT_RUNTIME_ADAPTER_VERSION,
  PRIME_AGENT_RUNTIME_PLAN_SCHEMA,
  PRIME_AGENT_RUNTIME_REQUEST_SCHEMA,
} from './host-contract.mjs';

export {
  PRIME_AGENT_COMMAND_PREVIEW,
  PRIME_AGENT_EVIDENCE_REFS,
  PRIME_AGENT_EXTENSION_VERSION,
  PRIME_AGENT_HARD_ENFORCEMENT,
  PRIME_AGENT_HOST_CONTRACT,
  PRIME_AGENT_HOST_IDENTITY,
  PRIME_AGENT_KNOWN_LIMITATIONS,
  PRIME_AGENT_REQUIRED_RPC_COMMANDS,
  PRIME_AGENT_RUNTIME_ADAPTER_ID,
  PRIME_AGENT_RUNTIME_ADAPTER_VERSION,
  PRIME_AGENT_RUNTIME_PLAN_SCHEMA,
  PRIME_AGENT_RUNTIME_REQUEST_SCHEMA,
} from './host-contract.mjs';

const REQUEST_KEYS = new Set([
  'schema',
  'owner_id',
  'workspace_id',
  'deployment_id',
  'principal_ref',
  'goal',
  'sandbox_profile_ref',
  'harness_policy_ref',
  'qualification_evidence_ref',
  'qualification_evidence_digest',
  'compatibility_receipt_ref',
  'compatibility_receipt_digest',
  'integrity_profile_ref',
  'integrity_profile_digest',
  'marketplace_record_ref',
  'marketplace_record_digest',
  'extension_ref',
  'extension_integrity_ref',
  'receipt_required',
  'transaction_assurance_required',
  'transaction_assurance_ref',
  'public_exposure_mode',
]);
const REF_PATTERN = /^[A-Za-z0-9._:/@+-]{1,240}$/;
const ID_PATTERN = /^[A-Za-z0-9_.:-]{3,160}$/;
const SHA256_PATTERN = /^sha256:[0-9a-f]{64}$/;
const SECRET_PATTERN = /(?:\bBearer\s+[A-Za-z0-9._~+/=-]{8,}|\bamk_[A-Za-z0-9._-]{8,}|\bsk-[A-Za-z0-9._-]{8,}|-----BEGIN [A-Z ]*PRIVATE KEY-----)/i;
const FALSE_AUTHORITY_FLAGS = Object.freeze({
  adapter_grants_authority: false,
  process_spawn_allowed: false,
  network_access_allowed: false,
  filesystem_write_allowed: false,
  credential_access_allowed: false,
  payment_allowed: false,
  wallet_mutation_allowed: false,
  settlement_allowed: false,
  deployment_allowed: false,
  publication_allowed: false,
  trust_mutation_allowed: false,
  ranking_mutation_allowed: false,
});

function isObject(value) {
  if (!value
    || typeof value !== 'object'
    || Array.isArray(value)
    || types.isProxy(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function assertClosedDataGraph(value, field) {
  snapshotJsonData(value, field);
}

function closedObject(value, allowed, field) {
  const snapshot = snapshotPublicSafeJson(value, field);
  if (!isObject(snapshot)) throw new TypeError(`${field} must be an object`);
  const unknown = Reflect.ownKeys(snapshot).filter(
    (key) => typeof key !== 'string' || !allowed.has(key),
  );
  if (unknown.length) throw new TypeError(`${field} contains unsupported fields`);
  return snapshot;
}

function text(value, field, maximum, pattern = null, allowNewlines = false) {
  const result = value === undefined || value === null ? '' : String(value).trim();
  if (!result) throw new TypeError(`${field} is required`);
  if (result.length > maximum) throw new TypeError(`${field} exceeds ${maximum} characters`);
  if (result.includes('\0')) throw new TypeError(`${field} contains a null byte`);
  if (!allowNewlines && /[\r\n]/.test(result)) throw new TypeError(`${field} must be one line`);
  if (pattern && !pattern.test(result)) throw new TypeError(`${field} contains unsupported characters`);
  if (SECRET_PATTERN.test(result)) throw new TypeError(`${field} contains a secret-like value`);
  return result;
}

function identifier(value, field) {
  return text(value, field, 160, ID_PATTERN);
}

function reference(value, field) {
  return text(value, field, 240, REF_PATTERN);
}

function sha256Reference(value, field) {
  const result = text(value, field, 71);
  if (!SHA256_PATTERN.test(result)) throw new TypeError(`${field} must be a sha256 reference`);
  return result;
}

export function buildPrimeAgentRuntimeRequest(input = {}) {
  input = closedObject(input, REQUEST_KEYS, 'runtime request');
  if (input.schema !== undefined && input.schema !== PRIME_AGENT_RUNTIME_REQUEST_SCHEMA) {
    throw new TypeError(`runtime request schema must be ${PRIME_AGENT_RUNTIME_REQUEST_SCHEMA}`);
  }
  if ((input.public_exposure_mode ?? 'private_only') !== 'private_only') {
    throw new TypeError('public_exposure_mode must remain private_only');
  }
  if (input.receipt_required === false || input.transaction_assurance_required === false) {
    throw new TypeError('receipt and Transaction Assurance requirements cannot be disabled');
  }
  return Object.freeze({
    schema: PRIME_AGENT_RUNTIME_REQUEST_SCHEMA,
    owner_id: identifier(input.owner_id, 'owner_id'),
    workspace_id: identifier(input.workspace_id, 'workspace_id'),
    deployment_id: identifier(input.deployment_id, 'deployment_id'),
    principal_ref: reference(input.principal_ref, 'principal_ref'),
    goal: text(input.goal, 'goal', 4000, null, true),
    sandbox_profile_ref: reference(input.sandbox_profile_ref, 'sandbox_profile_ref'),
    harness_policy_ref: reference(input.harness_policy_ref, 'harness_policy_ref'),
    qualification_evidence_ref: reference(input.qualification_evidence_ref, 'qualification_evidence_ref'),
    qualification_evidence_digest: sha256Reference(
      input.qualification_evidence_digest,
      'qualification_evidence_digest',
    ),
    compatibility_receipt_ref: reference(input.compatibility_receipt_ref, 'compatibility_receipt_ref'),
    compatibility_receipt_digest: sha256Reference(
      input.compatibility_receipt_digest,
      'compatibility_receipt_digest',
    ),
    integrity_profile_ref: reference(input.integrity_profile_ref, 'integrity_profile_ref'),
    integrity_profile_digest: sha256Reference(
      input.integrity_profile_digest,
      'integrity_profile_digest',
    ),
    marketplace_record_ref: reference(input.marketplace_record_ref, 'marketplace_record_ref'),
    marketplace_record_digest: sha256Reference(
      input.marketplace_record_digest,
      'marketplace_record_digest',
    ),
    extension_ref: reference(
      input.extension_ref || `package:@agoragentic/prime-agent@${PRIME_AGENT_EXTENSION_VERSION}`,
      'extension_ref',
    ),
    extension_integrity_ref: sha256Reference(input.extension_integrity_ref, 'extension_integrity_ref'),
    receipt_required: true,
    transaction_assurance_required: true,
    transaction_assurance_ref: reference(
      input.transaction_assurance_ref || 'schema:agoragentic.transaction-assurance-envelope.v1',
      'transaction_assurance_ref',
    ),
    public_exposure_mode: 'private_only',
  });
}

export function buildPrimeAgentRuntimePlan(input = {}) {
  const request = buildPrimeAgentRuntimeRequest(input);
  const body = {
    schema: PRIME_AGENT_RUNTIME_PLAN_SCHEMA,
    adapter_id: PRIME_AGENT_RUNTIME_ADAPTER_ID,
    adapter_version: PRIME_AGENT_RUNTIME_ADAPTER_VERSION,
    runtime_provider: 'prime-agent',
    runtime_mode: 'rpc',
    runtime_status: 'runtime_compatibility_evidence_promotion_blocked',
    declared_level: 'source_adapter',
    evidence_level: 'runtime_compatibility',
    effective_level: 'source_adapter',
    promotion_candidate_level: null,
    promotion_blocked: true,
    promotion_blockers: ['dependency_security_audit'],
    human_promotion_required: true,
    human_promotion_approved: false,
    auto_promoted: false,
    host_contract: PRIME_AGENT_HOST_CONTRACT,
    request,
    command_preview: PRIME_AGENT_COMMAND_PREVIEW,
    rpc_contract: {
      framing: 'jsonl_lf',
      stdin_stdout_only: true,
      diagnostics_on_stderr: true,
      shell: false,
      required_compatibility_cases: PRIME_AGENT_REQUIRED_RPC_COMMANDS,
    },
    hard_enforcement_required: PRIME_AGENT_HARD_ENFORCEMENT,
    decision: 'restricted_runtime_review_required',
    review_reasons: [
      'dependency_security_audit_failed',
      'human_promotion_required_after_blocker_resolution',
      'restricted_exact_runtime_not_verified',
      'hosted_availability_not_verified',
      'production_activation_not_authorized',
    ],
    launch_allowed: false,
    runtime_executed: false,
    exact_runtime_verified: false,
    hosted_available: false,
    production_activated: false,
    no_network: true,
    no_spend: true,
    authority_granted: false,
    authority_flags: FALSE_AUTHORITY_FLAGS,
  };
  return Object.freeze({ ...body, plan_hash: hashValue(body) });
}

export function validatePrimeAgentRuntimePlan(plan) {
  const blockers = [];
  let expected = null;
  let snapshot = null;
  try {
    snapshot = snapshotPublicSafeJson(plan, 'runtime plan');
    if (!isObject(snapshot)) throw new TypeError('runtime plan must be an object');
    expected = buildPrimeAgentRuntimePlan(snapshot.request);
  } catch (error) {
    blockers.push(`runtime_plan_invalid:${error.message}`);
  }
  if (expected && canonicalize(snapshot) !== canonicalize(expected)) blockers.push('runtime_plan_contract_mismatch');
  return Object.freeze({
    schema: 'agoragentic.prime-agent.runtime-plan-validation.v1',
    valid: blockers.length === 0,
    blockers: Object.freeze(blockers),
    plan_hash: snapshot?.plan_hash || null,
    expected_plan_hash: expected?.plan_hash || null,
    host_identity_hash: PRIME_AGENT_HOST_IDENTITY.identity_hash,
    host_contract_hash: PRIME_AGENT_HOST_CONTRACT.contract_hash,
    declared_level: blockers.length === 0 ? 'source_adapter' : 'blocked',
    evidence_level: blockers.length === 0 ? 'runtime_compatibility' : 'blocked',
    effective_level: blockers.length === 0 ? 'source_adapter' : 'blocked',
    promotion_candidate_level: null,
    promotion_blocked: blockers.length === 0,
    promotion_blockers: blockers.length === 0 ? Object.freeze(['dependency_security_audit']) : Object.freeze([]),
    human_promotion_required: blockers.length === 0,
    runtime_verified: false,
    runtime_executed: false,
    exact_runtime_verified: false,
    hosted_available: false,
    production_activated: false,
    authority_granted: false,
  });
}

const MARKETPLACE_RECORD_KEYS = Object.freeze([
  'schema',
  'integration_id',
  'upstream',
  'declared_level',
  'evidence_level',
  'effective_level',
  'promotion_candidate_level',
  'promotion_blocked',
  'promotion_blockers',
  'human_promotion_required',
  'human_promotion_approved',
  'auto_promoted',
  'evidence_ref',
  'evidence_digest',
  'compatibility_receipt_ref',
  'compatibility_receipt_digest',
  'integrity_profile_ref',
  'integrity_profile_digest',
  'dependency_audit_ref',
  'dependency_audit_digest',
  'generated_at',
  'checks',
  'artifacts',
  'authority',
  'known_limitations',
  'record_hash',
]);

function exactOwnKeys(value, expectedKeys) {
  if (!isObject(value)) return false;
  const observedKeys = Reflect.ownKeys(value);
  return observedKeys.length === expectedKeys.length
    && expectedKeys.every((key) => Object.hasOwn(value, key));
}

function includesEvery(value, expected) {
  return Array.isArray(value) && expected.every((entry) => value.includes(entry));
}

function verifyPrimeAgentMarketplaceRecord(record, evidence, receipt, integrityProfile) {
  const errors = [];
  try {
    assertClosedDataGraph(record, 'marketplace record');
  } catch (error) {
    errors.push(error.message);
  }
  if (!exactOwnKeys(record, MARKETPLACE_RECORD_KEYS)) {
    errors.push('marketplace record must be a schema-closed plain object');
    return Object.freeze({ ok: false, errors: Object.freeze(errors) });
  }
  const exactNestedKeys = [
    [record.upstream, ['repository', 'tag', 'version', 'commit', 'release_url', 'artifact', 'artifact_url', 'artifact_sha256'], 'upstream'],
    [record.checks, ['immutable_release_pinned', 'source_adapter_present', 'policy_enforcement_passed', 'release_artifact_verified', 'extension_loaded', 'compatibility_matrix_passed', 'dependency_security_audit_passed', 'exact_runtime_verified', 'hosted_available', 'production_activated'], 'checks'],
    [record.artifacts, ['source_adapter_digest', 'extension_package_digest', 'materialized_host_tree_digest', 'dependency_lock_digest', 'dependency_tree_digest', 'compatibility_matrix_digest', 'case_results_digest'], 'artifacts'],
    [record.authority, ['credentials_used', 'provider_calls_made', 'network_authority_granted', 'spend_occurred', 'wallet_activity', 'settlement_activity', 'deployment_changed', 'publication_changed', 'public_compatibility_claimed', 'trust_or_ranking_mutated'], 'authority'],
  ];
  for (const [value, keys, field] of exactNestedKeys) {
    if (!exactOwnKeys(value, keys)) errors.push(`marketplace record ${field} must be schema closed`);
  }
  const { record_hash: observedHash, ...body } = record;
  if (observedHash !== sha256Ref(body)) errors.push('marketplace record hash mismatch');
  if (record.schema !== 'agoragentic.agent-os.integration-qualification-record.v1') errors.push('marketplace record schema mismatch');
  if (record.integration_id !== 'prime-agent-governance') errors.push('marketplace record integration mismatch');
  if (
    record.upstream?.repository !== PRIME_AGENT_HOST_IDENTITY.repository
    || record.upstream?.tag !== PRIME_AGENT_HOST_IDENTITY.tag
    || record.upstream?.version !== PRIME_AGENT_HOST_IDENTITY.version
    || record.upstream?.commit !== PRIME_AGENT_HOST_IDENTITY.commit
    || record.upstream?.artifact !== PRIME_AGENT_HOST_IDENTITY.release_asset
    || record.upstream?.artifact_sha256 !== PRIME_AGENT_HOST_IDENTITY.release_asset_sha256
    || record.upstream?.release_url !== 'https://github.com/PrimeIntellect-ai/prime-agent/releases/tag/v0.7.2'
    || record.upstream?.artifact_url !== 'https://github.com/PrimeIntellect-ai/prime-agent/releases/download/v0.7.2/prime-agent-0.7.2.tgz'
  ) errors.push('marketplace record upstream mismatch');
  if (
    record.declared_level !== evidence?.qualification?.declared_level
    || record.evidence_level !== evidence?.qualification?.evidence_level
    || record.effective_level !== evidence?.qualification?.effective_level
    || record.promotion_candidate_level !== evidence?.qualification?.promotion_candidate_level
    || record.promotion_blocked !== evidence?.qualification?.promotion_blocked
    || canonicalize(record.promotion_blockers) !== canonicalize(evidence?.qualification?.promotion_blockers)
    || record.human_promotion_required !== true
    || record.human_promotion_approved !== false
    || record.auto_promoted !== false
  ) errors.push('marketplace record promotion state mismatch');
  const dependencyAudit = buildPrimeAgentV072DependencyAudit();
  if (
    record.evidence_digest !== evidence?.evidence_hash
    || record.compatibility_receipt_digest !== receipt?.receipt_hash
    || record.integrity_profile_digest !== integrityProfile?.profile_hash
    || record.evidence_ref !== PRIME_AGENT_EVIDENCE_REFS.qualification_evidence
    || record.compatibility_receipt_ref !== PRIME_AGENT_EVIDENCE_REFS.compatibility_receipt
    || record.integrity_profile_ref !== PRIME_AGENT_EVIDENCE_REFS.integrity_profile
    || record.dependency_audit_ref !== PRIME_AGENT_EVIDENCE_REFS.dependency_audit
    || record.dependency_audit_digest !== dependencyAudit.audit_hash
    || record.generated_at !== evidence?.generated_at
  ) errors.push('marketplace record evidence chain mismatch');
  const expectedChecks = {
    immutable_release_pinned: true,
    source_adapter_present: true,
    policy_enforcement_passed: false,
    release_artifact_verified: true,
    extension_loaded: true,
    compatibility_matrix_passed: true,
    dependency_security_audit_passed: false,
    exact_runtime_verified: false,
    hosted_available: false,
    production_activated: false,
  };
  if (canonicalize(record.checks) !== canonicalize(expectedChecks)) errors.push('marketplace record checks mismatch');
  const expectedCaseResultsDigest = sha256Ref({
    source_adapter_test: PRIME_AGENT_HOST_CONTRACT.source_adapter_test_sha256,
    qualification_evidence: evidence?.evidence_hash,
    compatibility_receipt: receipt?.receipt_hash,
    integrity_profile: integrityProfile?.profile_hash,
    source_policy_tests_passed: true,
    real_host_policy_interception_observed: false,
  });
  if (
    record.artifacts?.source_adapter_digest !== PRIME_AGENT_HOST_CONTRACT.source_adapter_sha256
    || record.artifacts?.extension_package_digest !== receipt?.extension?.manifest_digest
    || record.artifacts?.materialized_host_tree_digest !== receipt?.artifact?.first_party_tree_digest
    || record.artifacts?.dependency_lock_digest !== receipt?.dependency_closure?.lock_digest
    || record.artifacts?.dependency_tree_digest !== receipt?.dependency_closure?.dependency_tree_digest
    || record.artifacts?.compatibility_matrix_digest !== receipt?.compatibility?.matrix_digest
    || record.artifacts?.case_results_digest !== expectedCaseResultsDigest
  ) errors.push('marketplace record artifact chain mismatch');
  if (!isObject(record.authority) || Object.values(record.authority).some((value) => value !== false)) {
    errors.push('marketplace record authority boundary broken');
  }
  if (canonicalize(record.known_limitations) !== canonicalize(PRIME_AGENT_KNOWN_LIMITATIONS)) {
    errors.push('marketplace record known limitations mismatch');
  }
  return Object.freeze({ ok: errors.length === 0, errors: Object.freeze(errors) });
}

export function buildPrimeAgentCompatibilityPacket({
  plan,
  qualificationPacket,
  compatibilityReceipt,
  marketplaceRecord,
  integrityProfile,
} = {}) {
  const inputShapeBlockers = [];
  const snapshotInput = (value, field, blocker) => {
    try {
      return snapshotPublicSafeJson(value, field);
    } catch {
      inputShapeBlockers.push(blocker);
      return null;
    }
  };
  plan = snapshotInput(plan, 'runtime plan', 'runtime_plan_data_shape_invalid');
  qualificationPacket = snapshotInput(
    qualificationPacket,
    'qualification packet',
    'qualification_evidence_data_shape_invalid',
  );
  compatibilityReceipt = snapshotInput(
    compatibilityReceipt,
    'compatibility receipt',
    'compatibility_receipt_data_shape_invalid',
  );
  marketplaceRecord = snapshotInput(
    marketplaceRecord,
    'marketplace record',
    'marketplace_record_data_shape_invalid',
  );
  integrityProfile = snapshotInput(
    integrityProfile,
    'integrity profile',
    'integrity_profile_data_shape_invalid',
  );
  const planValidation = validatePrimeAgentRuntimePlan(plan);
  const qualificationDigest = qualificationPacket?.evidence_hash || qualificationPacket?.record_hash || null;
  const receiptDigest = compatibilityReceipt?.receipt_hash || null;
  const marketplaceRecordDigest = marketplaceRecord?.record_hash || null;
  const integrityProfileDigest = integrityProfile?.profile_hash || null;
  const blockers = [...inputShapeBlockers, ...planValidation.blockers];
  const qualificationVerification = verifyQualificationEvidencePacket(qualificationPacket);
  if (!qualificationVerification.ok) blockers.push('qualification_evidence_invalid');
  try {
    const canonicalQualificationPacket = buildPrimeAgentV072QualificationEvidence();
    if (canonicalize(qualificationPacket) !== canonicalize(canonicalQualificationPacket)) {
      blockers.push('qualification_evidence_canonical_mismatch');
    }
  } catch {
    blockers.push('qualification_evidence_canonical_unavailable');
  }
  const receiptVerification = verifyPrimeAgentCompatibilityReceipt(compatibilityReceipt);
  if (!receiptVerification.ok) blockers.push('compatibility_receipt_invalid');
  const integrityProfileVerification = verifyPrimeAgentIntegrityProfile(integrityProfile);
  if (!integrityProfileVerification.ok) blockers.push('integrity_profile_invalid');
  const marketplaceRecordVerification = verifyPrimeAgentMarketplaceRecord(
    marketplaceRecord,
    qualificationPacket,
    compatibilityReceipt,
    integrityProfile,
  );
  if (!marketplaceRecordVerification.ok) blockers.push('marketplace_record_invalid');
  if (qualificationDigest !== plan?.request?.qualification_evidence_digest) {
    blockers.push('qualification_evidence_digest_mismatch');
  }
  if (receiptDigest !== plan?.request?.compatibility_receipt_digest) {
    blockers.push('compatibility_receipt_digest_mismatch');
  }
  if (integrityProfileDigest !== plan?.request?.integrity_profile_digest) {
    blockers.push('integrity_profile_digest_mismatch');
  }
  if (marketplaceRecordDigest !== plan?.request?.marketplace_record_digest) {
    blockers.push('marketplace_record_digest_mismatch');
  }
  if (plan?.request?.extension_integrity_ref !== integrityProfile?.extension_manifest_digest) {
    blockers.push('extension_integrity_ref_mismatch');
  }
  if (
    compatibilityReceipt?.integrity_profile_hash !== integrityProfileDigest
    || compatibilityReceipt?.extension?.manifest_digest !== integrityProfile?.extension_manifest_digest
  ) blockers.push('receipt_integrity_profile_mismatch');
  if (
    qualificationPacket?.integration_id !== 'prime-agent-governance'
    || qualificationPacket?.subject?.project !== 'Prime Agent'
    || qualificationPacket?.subject?.repository !== 'https://github.com/PrimeIntellect-ai/prime-agent'
    || qualificationPacket?.release?.tag !== PRIME_AGENT_HOST_IDENTITY.tag
    || qualificationPacket?.release?.commit !== PRIME_AGENT_HOST_IDENTITY.commit
    || qualificationPacket?.release?.asset_name !== PRIME_AGENT_HOST_IDENTITY.release_asset
    || qualificationPacket?.release?.asset_url !== PRIME_AGENT_HOST_CONTRACT.release_asset_url
    || `sha256:${qualificationPacket?.release?.asset_sha256 || ''}` !== PRIME_AGENT_HOST_IDENTITY.release_asset_sha256
  ) {
    blockers.push('qualification_release_identity_mismatch');
  }
  if (
    qualificationPacket?.qualification?.declared_level !== 'source_adapter'
    || qualificationPacket?.qualification?.evidence_level !== 'runtime_compatibility'
    || qualificationPacket?.qualification?.effective_level !== 'source_adapter'
    || qualificationPacket?.qualification?.promotion_candidate_level !== null
    || qualificationPacket?.qualification?.promotion_blocked !== true
    || canonicalize(qualificationPacket?.qualification?.promotion_blockers) !== canonicalize(['dependency_security_audit'])
    || canonicalize(qualificationPacket?.promotion_blockers) !== canonicalize(['dependency_security_audit'])
    || qualificationPacket?.qualification?.human_promotion_required !== true
    || qualificationPacket?.qualification?.auto_promoted !== false
  ) {
    blockers.push('qualification_promotion_state_mismatch');
  }
  if (
    !qualificationPacket?.boundaries
    || Object.values(qualificationPacket.boundaries).some((value) => value !== false)
  ) {
    blockers.push('qualification_hard_stop_boundary_broken');
  }
  const exactHostRefs = qualificationPacket?.observations?.exact_host_artifact_loaded?.evidence_refs;
  const compatibilityRefs = qualificationPacket?.observations?.compatibility_matrix_passed?.evidence_refs;
  const immutableReleaseRefs = qualificationPacket?.observations?.immutable_release_pin_verified?.evidence_refs;
  const dependencySecurityRefs = qualificationPacket?.observations?.dependency_security_audit?.evidence_refs;
  if (!includesEvery(exactHostRefs, [
    receiptDigest,
    integrityProfileDigest,
    compatibilityReceipt?.artifact?.first_party_tree_digest,
    compatibilityReceipt?.dependency_closure?.lock_digest,
    compatibilityReceipt?.dependency_closure?.dependency_tree_digest,
    compatibilityReceipt?.extension?.manifest_digest,
  ])) blockers.push('qualification_exact_host_receipt_binding_mismatch');
  if (!includesEvery(compatibilityRefs, [
    receiptDigest,
    compatibilityReceipt?.compatibility?.matrix_digest,
  ])) blockers.push('qualification_matrix_receipt_binding_mismatch');
  if (!includesEvery(immutableReleaseRefs, [
    receiptDigest,
    compatibilityReceipt?.artifact?.asset_sha256,
  ])) blockers.push('qualification_release_receipt_binding_mismatch');
  const expectedDependencyAudit = buildPrimeAgentV072DependencyAudit();
  if (
    qualificationPacket?.observations?.dependency_security_audit?.status !== 'failed'
    || qualificationPacket?.observations?.dependency_security_audit?.proof_class !== 'official_metadata'
    || !includesEvery(dependencySecurityRefs, [
      expectedDependencyAudit.audit_hash,
      expectedDependencyAudit.advisory.url,
      compatibilityReceipt?.dependency_closure?.lock_digest,
    ])
  ) blockers.push('qualification_dependency_security_blocker_mismatch');
  if (
    Date.parse(qualificationPacket?.generated_at || '') < Date.parse(compatibilityReceipt?.observed_at || '')
    || qualificationPacket?.release?.asset_name !== compatibilityReceipt?.artifact?.asset_name
    || `sha256:${qualificationPacket?.release?.asset_sha256 || ''}` !== compatibilityReceipt?.artifact?.asset_sha256
  ) blockers.push('qualification_receipt_observation_mismatch');
  if (
    marketplaceRecord?.evidence_ref !== plan?.request?.qualification_evidence_ref
    || marketplaceRecord?.compatibility_receipt_ref !== plan?.request?.compatibility_receipt_ref
    || marketplaceRecord?.integrity_profile_ref !== plan?.request?.integrity_profile_ref
  ) blockers.push('marketplace_record_ref_mismatch');
  const contractValid = blockers.length === 0;
  const evidencePromotionBlocked = contractValid
    && qualificationPacket?.qualification?.promotion_blocked === true;
  const body = {
    schema: 'agoragentic.prime-agent.compatibility-packet.v1',
    status: !contractValid
      ? 'blocked'
      : (evidencePromotionBlocked ? 'promotion_blocked' : 'promotion_candidate'),
    declared_level: contractValid ? 'source_adapter' : 'blocked',
    evidence_level: contractValid ? 'runtime_compatibility' : 'blocked',
    effective_level: contractValid ? 'source_adapter' : 'blocked',
    promotion_candidate_level: null,
    promotion_blocked: evidencePromotionBlocked,
    promotion_blockers: evidencePromotionBlocked ? ['dependency_security_audit'] : [],
    human_promotion_required: contractValid,
    human_promotion_approved: false,
    auto_promoted: false,
    host_identity: PRIME_AGENT_HOST_IDENTITY,
    host_contract_hash: PRIME_AGENT_HOST_CONTRACT.contract_hash,
    plan_hash: plan?.plan_hash || null,
    qualification_evidence_ref: plan?.request?.qualification_evidence_ref || null,
    qualification_evidence_digest: qualificationDigest,
    compatibility_receipt_ref: plan?.request?.compatibility_receipt_ref || null,
    compatibility_receipt_digest: receiptDigest,
    integrity_profile_ref: plan?.request?.integrity_profile_ref || null,
    integrity_profile_digest: integrityProfileDigest,
    extension_integrity_ref: plan?.request?.extension_integrity_ref || null,
    marketplace_record_ref: plan?.request?.marketplace_record_ref || null,
    marketplace_record_digest: marketplaceRecordDigest,
    blockers,
    runtime_verified: false,
    runtime_executed: false,
    exact_runtime_verified: false,
    hosted_available: false,
    production_activated: false,
    authority_granted: false,
    partnership_claimed: false,
    package_published: false,
    deployment_authorized: false,
    publication_authorized: false,
    spend_authorized: false,
  };
  return Object.freeze({ ...body, packet_hash: hashValue(body) });
}

export function buildPrimeAgentIntegrationDescriptor() {
  return Object.freeze({
    schema: 'agoragentic.prime-agent.integration-descriptor.v1',
    package_name: '@agoragentic/prime-agent',
    package_version: PRIME_AGENT_EXTENSION_VERSION,
    distribution_status: 'source_only',
    extension_entry: './index.mjs',
    runtime_contract_entry: './runtime-contract.mjs',
    release_verifier_entry: './release-verifier.mjs',
    compatibility_runner_entry: './compatibility-runner.mjs',
    prime_agent_host_identity: PRIME_AGENT_HOST_IDENTITY,
    highest_evidenced_level: 'runtime_compatibility',
    highest_eligible_level: null,
    promotion_blocked: true,
    promotion_blockers: Object.freeze(['dependency_security_audit']),
    authority_granted: false,
    package_published: false,
    production_activated: false,
  });
}
