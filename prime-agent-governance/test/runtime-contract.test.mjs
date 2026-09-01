import assert from 'node:assert/strict';
import test from 'node:test';

import { hashValue } from '../index.mjs';
import { integritySha256 } from '../artifact-integrity.mjs';
import { sha256Ref } from '../../integration-qualification/src/index.mjs';
import { buildPrimeAgentV072QualificationEvidence } from '../evidence/build-evidence.mjs';
import {
  loadPrimeAgentV072CompatibilityReceipt,
  loadPrimeAgentV072IntegrityProfile,
} from '../evidence/build-evidence.mjs';
import { buildPrimeAgentMarketplaceQualificationRecord } from '../evidence/build-marketplace-record.mjs';
import {
  PRIME_AGENT_COMMAND_PREVIEW,
  PRIME_AGENT_HOST_CONTRACT,
  PRIME_AGENT_HOST_IDENTITY,
  buildPrimeAgentCompatibilityPacket,
  buildPrimeAgentIntegrationDescriptor,
  buildPrimeAgentRuntimePlan,
  buildPrimeAgentRuntimeRequest,
  validatePrimeAgentRuntimePlan,
} from '../runtime-contract.mjs';
import { PRIME_AGENT_SAFE_LAUNCH_REQUIREMENTS } from '../host-contract.mjs';

const QUALIFICATION_PACKET = buildPrimeAgentV072QualificationEvidence();
const QUALIFICATION_DIGEST = QUALIFICATION_PACKET.evidence_hash;
const COMPATIBILITY_RECEIPT = loadPrimeAgentV072CompatibilityReceipt();
const INTEGRITY_PROFILE = loadPrimeAgentV072IntegrityProfile();
const MARKETPLACE_RECORD = buildPrimeAgentMarketplaceQualificationRecord();

function request(overrides = {}) {
  return {
    owner_id: 'owner-prime-runtime',
    workspace_id: 'workspace-prime-runtime',
    deployment_id: 'deployment-prime-runtime',
    principal_ref: 'principal:owner-prime-runtime',
    goal: 'Run a bounded compatibility check and return public-safe evidence.',
    sandbox_profile_ref: 'sandbox:agent-os-restricted-v1',
    harness_policy_ref: 'policy:harness-prime-runtime-v1',
    qualification_evidence_ref: 'prime-agent-governance/evidence/prime-agent-v0.7.2-qualification.v1.json',
    qualification_evidence_digest: QUALIFICATION_DIGEST,
    compatibility_receipt_ref: 'prime-agent-governance/evidence/prime-agent-v0.7.2-released-compatibility.v1.json',
    compatibility_receipt_digest: COMPATIBILITY_RECEIPT.receipt_hash,
    integrity_profile_ref: 'prime-agent-governance/evidence/prime-agent-v0.7.2-integrity-profile.v1.json',
    integrity_profile_digest: INTEGRITY_PROFILE.profile_hash,
    marketplace_record_ref: 'prime-agent-governance/evidence/prime-agent-v0.7.2-agent-os-qualification.v1.json',
    marketplace_record_digest: MARKETPLACE_RECORD.record_hash,
    extension_integrity_ref: INTEGRITY_PROFILE.extension_manifest_digest,
    receipt_required: true,
    transaction_assurance_required: true,
    ...overrides,
  };
}

function qualificationPacket(overrides = {}) {
  return Object.assign(structuredClone(QUALIFICATION_PACKET), overrides);
}

function compatibilityPacket(overrides = {}) {
  return buildPrimeAgentCompatibilityPacket({
    plan: buildPrimeAgentRuntimePlan(request()),
    qualificationPacket: qualificationPacket(),
    compatibilityReceipt: structuredClone(COMPATIBILITY_RECEIPT),
    marketplaceRecord: structuredClone(MARKETPLACE_RECORD),
    integrityProfile: structuredClone(INTEGRITY_PROFILE),
    ...overrides,
  });
}

test('pins the exact Prime Agent v0.7.2 identity and immutable release', () => {
  assert.deepEqual({
    repository: PRIME_AGENT_HOST_IDENTITY.repository,
    tag: PRIME_AGENT_HOST_IDENTITY.tag,
    version: PRIME_AGENT_HOST_IDENTITY.version,
    commit: PRIME_AGENT_HOST_IDENTITY.commit,
    release_asset: PRIME_AGENT_HOST_IDENTITY.release_asset,
    release_asset_sha256: PRIME_AGENT_HOST_IDENTITY.release_asset_sha256,
  }, {
    repository: 'PrimeIntellect-ai/prime-agent',
    tag: 'v0.7.2',
    version: '0.7.2',
    commit: '83a0f9f9566219551fcb6ffaf7f519a815749a58',
    release_asset: 'prime-agent-0.7.2.tgz',
    release_asset_sha256: 'sha256:bc5471f2a626d727b88a45eb745fff93b10c554a3c4fc5912f25d8c64b987f5e',
  });
  assert.match(PRIME_AGENT_HOST_IDENTITY.identity_hash, /^sha256:[0-9a-f]{64}$/);
  assert.match(PRIME_AGENT_HOST_CONTRACT.contract_hash, /^sha256:[0-9a-f]{64}$/);
});

test('builds a closed no-activation request bound to qualification evidence', () => {
  const result = buildPrimeAgentRuntimeRequest(request());
  assert.equal(result.qualification_evidence_digest, QUALIFICATION_DIGEST);
  assert.equal(result.compatibility_receipt_digest, COMPATIBILITY_RECEIPT.receipt_hash);
  assert.equal(result.integrity_profile_digest, INTEGRITY_PROFILE.profile_hash);
  assert.equal(result.marketplace_record_digest, MARKETPLACE_RECORD.record_hash);
  assert.equal(result.extension_integrity_ref, INTEGRITY_PROFILE.extension_manifest_digest);
  assert.equal(result.public_exposure_mode, 'private_only');
  assert.equal(result.receipt_required, true);
  assert.equal(result.transaction_assurance_required, true);
  assert.equal(result.extension_ref, 'package:@agoragentic/prime-agent@0.2.0-alpha.0');
});

test('request rejects unknown fields, raw secrets, public exposure, and disabled assurance', () => {
  assert.throws(() => buildPrimeAgentRuntimeRequest(request({ unknown: true })), /unsupported fields/);
  assert.throws(() => buildPrimeAgentRuntimeRequest(request({ goal: 'Use sk-abcdefghijklmnop' })), /credential-like/);
  assert.throws(() => buildPrimeAgentRuntimeRequest(request({ public_exposure_mode: 'public' })), /private_only/);
  assert.throws(() => buildPrimeAgentRuntimeRequest(request({ receipt_required: false })), /cannot be disabled/);
  assert.throws(() => buildPrimeAgentRuntimeRequest(request({ qualification_evidence_digest: 'sha256:nope' })), /sha256/);
  const inherited = Object.assign(Object.create({ owner_id: 'inherited-owner' }), request());
  delete inherited.owner_id;
  assert.throws(
    () => buildPrimeAgentRuntimeRequest(inherited),
    /(?:must be an object|must use a plain object)/,
  );

  const githubToken = 'github_pat_abcdefghijklmnopqrstuvwxyz012345';
  assert.throws(
    () => buildPrimeAgentRuntimeRequest(request({ goal: `Use ${githubToken}` })),
    /credential-like/,
  );
  const tokenKeyInput = request();
  tokenKeyInput[githubToken] = true;
  assert.throws(
    () => buildPrimeAgentRuntimeRequest(tokenKeyInput),
    (error) => {
      assert.match(error.message, /(?:unsupported fields|property name contains credential-like text)/);
      assert.equal(error.message.includes(githubToken), false);
      return true;
    },
  );

  let goalReads = 0;
  const accessorInput = request();
  Object.defineProperty(accessorInput, 'goal', {
    enumerable: true,
    get() {
      goalReads += 1;
      return 'Run the bounded check.';
    },
  });
  assert.throws(
    () => buildPrimeAgentRuntimeRequest(accessorInput),
    /accessor or non-enumerable property/,
  );
  assert.equal(goalReads, 0);

  let proxyReads = 0;
  const proxyInput = new Proxy(request(), {
    ownKeys(target) {
      proxyReads += 1;
      return Reflect.ownKeys(target);
    },
  });
  assert.throws(() => buildPrimeAgentRuntimeRequest(proxyInput), /must not be a Proxy/);
  assert.equal(proxyReads, 0);

  const cyclicInput = request();
  cyclicInput.unreviewed = cyclicInput;
  assert.throws(() => buildPrimeAgentRuntimeRequest(cyclicInput), /must not contain a cycle/);
});

test('builds a runtime-compatibility promotion-blocked plan that cannot launch or grant authority', () => {
  const plan = buildPrimeAgentRuntimePlan(request());
  const validation = validatePrimeAgentRuntimePlan(plan);
  assert.equal(validation.valid, true);
  assert.equal(validation.declared_level, 'source_adapter');
  assert.equal(validation.evidence_level, 'runtime_compatibility');
  assert.equal(validation.effective_level, 'source_adapter');
  assert.equal(validation.promotion_candidate_level, null);
  assert.equal(validation.promotion_blocked, true);
  assert.deepEqual(validation.promotion_blockers, ['dependency_security_audit']);
  assert.equal(validation.human_promotion_required, true);
  assert.deepEqual(plan.command_preview, PRIME_AGENT_COMMAND_PREVIEW);
  assert.deepEqual(
    PRIME_AGENT_COMMAND_PREVIEW.slice(5, 7),
    ['--daemon-socket', '<ISOLATED_TEST_SOCKET>'],
  );
  assert.equal(PRIME_AGENT_SAFE_LAUNCH_REQUIREMENTS.daemon_socket_unique_per_run, true);
  assert.equal(PRIME_AGENT_SAFE_LAUNCH_REQUIREMENTS.ambient_home_or_profile_lookup, false);
  assert.equal(
    PRIME_AGENT_SAFE_LAUNCH_REQUIREMENTS.required_environment.HOME,
    '<ISOLATED_TEST_HOME>',
  );
  assert.equal(
    PRIME_AGENT_SAFE_LAUNCH_REQUIREMENTS.required_environment.USERPROFILE,
    '<ISOLATED_TEST_HOME>',
  );
  assert.equal(PRIME_AGENT_SAFE_LAUNCH_REQUIREMENTS.global_daemon_reuse, false);
  assert.equal(PRIME_AGENT_SAFE_LAUNCH_REQUIREMENTS.bounded_shutdown_wait_required, true);
  assert.equal(
    PRIME_AGENT_SAFE_LAUNCH_REQUIREMENTS.shutdown_wait_condition,
    'daemon_endpoint_disappeared',
  );
  assert.equal(plan.launch_allowed, false);
  assert.equal(plan.runtime_executed, false);
  assert.equal(plan.exact_runtime_verified, false);
  assert.equal(plan.hosted_available, false);
  assert.equal(plan.production_activated, false);
  assert.equal(plan.authority_granted, false);
  assert.ok(Object.values(plan.authority_flags).every((value) => value === false));
});

test('rehashed plan drift cannot change execution or host boundaries', () => {
  const plan = buildPrimeAgentRuntimePlan(request());
  const body = {
    ...plan,
    host_contract: { ...plan.host_contract, tag: 'v0.8.1' },
    launch_allowed: true,
    runtime_executed: true,
  };
  delete body.plan_hash;
  const tampered = { ...body, plan_hash: hashValue(body) };
  const validation = validatePrimeAgentRuntimePlan(tampered);
  assert.equal(validation.valid, false);
  assert.ok(validation.blockers.includes('runtime_plan_contract_mismatch'));

  const arrayPropertyPlan = structuredClone(plan);
  arrayPropertyPlan.command_preview.unreviewed = true;
  assert.equal(validatePrimeAgentRuntimePlan(arrayPropertyPlan).valid, false);
});

test('compatibility packet preserves valid evidence while reporting the dependency promotion blocker', () => {
  const plan = buildPrimeAgentRuntimePlan(request());
  const packet = compatibilityPacket({ plan });
  assert.equal(packet.status, 'promotion_blocked');
  assert.equal(packet.declared_level, 'source_adapter');
  assert.equal(packet.evidence_level, 'runtime_compatibility');
  assert.equal(packet.effective_level, 'source_adapter');
  assert.equal(packet.promotion_candidate_level, null);
  assert.equal(packet.promotion_blocked, true);
  assert.deepEqual(packet.promotion_blockers, ['dependency_security_audit']);
  assert.equal(packet.human_promotion_required, true);
  assert.equal(packet.human_promotion_approved, false);
  assert.equal(packet.runtime_verified, false);
  assert.equal(packet.runtime_executed, false);
  assert.equal(packet.production_activated, false);

  const wrongDigest = buildPrimeAgentCompatibilityPacket({
    plan,
    qualificationPacket: qualificationPacket({ evidence_hash: `sha256:${'9'.repeat(64)}` }),
    compatibilityReceipt: structuredClone(COMPATIBILITY_RECEIPT),
    marketplaceRecord: structuredClone(MARKETPLACE_RECORD),
    integrityProfile: structuredClone(INTEGRITY_PROFILE),
  });
  assert.equal(wrongDigest.status, 'blocked');
  assert.ok(wrongDigest.blockers.includes('qualification_evidence_digest_mismatch'));

  const fabricated = buildPrimeAgentCompatibilityPacket({
    plan,
    qualificationPacket: {
      evidence_hash: QUALIFICATION_DIGEST,
      qualification: { effective_level: 'runtime_compatibility' },
    },
    compatibilityReceipt: structuredClone(COMPATIBILITY_RECEIPT),
    marketplaceRecord: structuredClone(MARKETPLACE_RECORD),
    integrityProfile: structuredClone(INTEGRITY_PROFILE),
  });
  assert.equal(fabricated.status, 'blocked');
  assert.ok(fabricated.blockers.includes('qualification_evidence_invalid'));

  const overclaimPacket = qualificationPacket();
  overclaimPacket.boundaries.public_compatibility_claimed = true;
  delete overclaimPacket.evidence_hash;
  overclaimPacket.evidence_hash = sha256Ref(overclaimPacket);
  const overclaim = buildPrimeAgentCompatibilityPacket({
    plan,
    qualificationPacket: overclaimPacket,
    compatibilityReceipt: structuredClone(COMPATIBILITY_RECEIPT),
    marketplaceRecord: structuredClone(MARKETPLACE_RECORD),
    integrityProfile: structuredClone(INTEGRITY_PROFILE),
  });
  assert.equal(overclaim.status, 'blocked');
  assert.ok(overclaim.blockers.includes('qualification_hard_stop_boundary_broken'));

  const wrongAssetUrlPacket = qualificationPacket();
  wrongAssetUrlPacket.release.asset_url = 'https://github.com/PrimeIntellect-ai/prime-agent/releases/download/v0.8.1/prime-agent-0.8.1.tgz';
  delete wrongAssetUrlPacket.evidence_hash;
  wrongAssetUrlPacket.evidence_hash = sha256Ref(wrongAssetUrlPacket);
  const wrongAssetUrlRecord = structuredClone(MARKETPLACE_RECORD);
  wrongAssetUrlRecord.evidence_digest = wrongAssetUrlPacket.evidence_hash;
  wrongAssetUrlRecord.artifacts.case_results_digest = sha256Ref({
    source_adapter_test: PRIME_AGENT_HOST_CONTRACT.source_adapter_test_sha256,
    qualification_evidence: wrongAssetUrlPacket.evidence_hash,
    compatibility_receipt: COMPATIBILITY_RECEIPT.receipt_hash,
    integrity_profile: INTEGRITY_PROFILE.profile_hash,
    source_policy_tests_passed: true,
    real_host_policy_interception_observed: false,
  });
  delete wrongAssetUrlRecord.record_hash;
  wrongAssetUrlRecord.record_hash = sha256Ref(wrongAssetUrlRecord);
  const wrongAssetUrlPlan = buildPrimeAgentRuntimePlan(request({
    qualification_evidence_digest: wrongAssetUrlPacket.evidence_hash,
    marketplace_record_digest: wrongAssetUrlRecord.record_hash,
  }));
  const wrongAssetUrl = compatibilityPacket({
    plan: wrongAssetUrlPlan,
    qualificationPacket: wrongAssetUrlPacket,
    marketplaceRecord: wrongAssetUrlRecord,
  });
  assert.equal(wrongAssetUrl.status, 'blocked');
  assert.ok(wrongAssetUrl.blockers.includes('qualification_release_identity_mismatch'));

  const summaryOverclaimPacket = qualificationPacket();
  summaryOverclaimPacket.observations.compatibility_matrix_passed.summary = 'Production is activated, public compatibility is verified, and authority is granted.';
  delete summaryOverclaimPacket.evidence_hash;
  summaryOverclaimPacket.evidence_hash = sha256Ref(summaryOverclaimPacket);
  const summaryOverclaimRecord = structuredClone(MARKETPLACE_RECORD);
  summaryOverclaimRecord.evidence_digest = summaryOverclaimPacket.evidence_hash;
  summaryOverclaimRecord.artifacts.case_results_digest = sha256Ref({
    source_adapter_test: PRIME_AGENT_HOST_CONTRACT.source_adapter_test_sha256,
    qualification_evidence: summaryOverclaimPacket.evidence_hash,
    compatibility_receipt: COMPATIBILITY_RECEIPT.receipt_hash,
    integrity_profile: INTEGRITY_PROFILE.profile_hash,
    source_policy_tests_passed: true,
    real_host_policy_interception_observed: false,
  });
  delete summaryOverclaimRecord.record_hash;
  summaryOverclaimRecord.record_hash = sha256Ref(summaryOverclaimRecord);
  const summaryOverclaimPlan = buildPrimeAgentRuntimePlan(request({
    qualification_evidence_digest: summaryOverclaimPacket.evidence_hash,
    marketplace_record_digest: summaryOverclaimRecord.record_hash,
  }));
  const summaryOverclaim = compatibilityPacket({
    plan: summaryOverclaimPlan,
    qualificationPacket: summaryOverclaimPacket,
    marketplaceRecord: summaryOverclaimRecord,
  });
  assert.equal(summaryOverclaim.status, 'blocked');
  assert.ok(summaryOverclaim.blockers.includes('qualification_evidence_canonical_mismatch'));

  const wrongExtensionPlan = buildPrimeAgentRuntimePlan(request({
    extension_integrity_ref: `sha256:${'0'.repeat(64)}`,
  }));
  const wrongExtension = compatibilityPacket({ plan: wrongExtensionPlan });
  assert.equal(wrongExtension.status, 'blocked');
  assert.ok(wrongExtension.blockers.includes('extension_integrity_ref_mismatch'));

  const forgedReceipt = structuredClone(COMPATIBILITY_RECEIPT);
  forgedReceipt.dependency_closure.dependency_tree_digest = `sha256:${'0'.repeat(64)}`;
  delete forgedReceipt.receipt_hash;
  forgedReceipt.receipt_hash = integritySha256(forgedReceipt);
  const receiptPlan = buildPrimeAgentRuntimePlan(request({
    compatibility_receipt_digest: forgedReceipt.receipt_hash,
  }));
  const receiptForgery = compatibilityPacket({
    plan: receiptPlan,
    compatibilityReceipt: forgedReceipt,
  });
  assert.equal(receiptForgery.status, 'blocked');
  assert.ok(receiptForgery.blockers.includes('compatibility_receipt_invalid'));

  const forgedRecord = structuredClone(MARKETPLACE_RECORD);
  forgedRecord.artifacts.extension_package_digest = `sha256:${'0'.repeat(64)}`;
  delete forgedRecord.record_hash;
  forgedRecord.record_hash = sha256Ref(forgedRecord);
  const recordPlan = buildPrimeAgentRuntimePlan(request({
    marketplace_record_digest: forgedRecord.record_hash,
  }));
  const recordForgery = compatibilityPacket({
    plan: recordPlan,
    marketplaceRecord: forgedRecord,
  });
  assert.equal(recordForgery.status, 'blocked');
  assert.ok(recordForgery.blockers.includes('marketplace_record_invalid'));

  for (const mutate of [
    (record) => { record.upstream.release_url = 'https://github.com/PrimeIntellect-ai/prime-agent/releases/tag/v0.8.1'; },
    (record) => { record.upstream.artifact_url = 'https://github.com/PrimeIntellect-ai/prime-agent/releases/download/v0.8.1/prime-agent-0.8.1.tgz'; },
    (record) => { record.evidence_ref = 'lookalike/prime-agent-v0.7.2-qualification.v1.json'; },
    (record) => { record.compatibility_receipt_ref = 'lookalike/prime-agent-v0.7.2-released-compatibility.v1.json'; },
    (record) => { record.integrity_profile_ref = 'lookalike/prime-agent-v0.7.2-integrity-profile.v1.json'; },
    (record) => { record.dependency_audit_ref = 'lookalike/prime-agent-v0.7.2-dependency-audit.v1.json'; },
    (record) => { record.artifacts.source_adapter_digest = `sha256:${'1'.repeat(64)}`; },
    (record) => { record.artifacts.case_results_digest = `sha256:${'2'.repeat(64)}`; },
    (record) => { record.known_limitations = ['Production compatibility and authority are verified.']; },
  ]) {
    const rehashedLookalike = structuredClone(MARKETPLACE_RECORD);
    mutate(rehashedLookalike);
    delete rehashedLookalike.record_hash;
    rehashedLookalike.record_hash = sha256Ref(rehashedLookalike);
    const lookalikePlan = buildPrimeAgentRuntimePlan(request({
      marketplace_record_digest: rehashedLookalike.record_hash,
    }));
    const lookalikeResult = compatibilityPacket({
      plan: lookalikePlan,
      marketplaceRecord: rehashedLookalike,
    });
    assert.equal(lookalikeResult.status, 'blocked');
    assert.ok(lookalikeResult.blockers.includes('marketplace_record_invalid'));
  }

  let recordReads = 0;
  const accessorRecord = structuredClone(MARKETPLACE_RECORD);
  Object.defineProperty(accessorRecord, 'integration_id', {
    enumerable: true,
    get() {
      recordReads += 1;
      return 'prime-agent-governance';
    },
  });
  const passiveForgery = buildPrimeAgentCompatibilityPacket({
    plan,
    qualificationPacket: qualificationPacket(),
    compatibilityReceipt: structuredClone(COMPATIBILITY_RECEIPT),
    marketplaceRecord: accessorRecord,
    integrityProfile: structuredClone(INTEGRITY_PROFILE),
  });
  assert.equal(passiveForgery.status, 'blocked');
  assert.ok(passiveForgery.blockers.includes('marketplace_record_data_shape_invalid'));
  assert.equal(recordReads, 0);
});

test('descriptor remains source-only with a runtime-compatibility ceiling', () => {
  const descriptor = buildPrimeAgentIntegrationDescriptor();
  assert.equal(descriptor.distribution_status, 'source_only');
  assert.equal(descriptor.highest_evidenced_level, 'runtime_compatibility');
  assert.equal(descriptor.highest_eligible_level, null);
  assert.equal(descriptor.promotion_blocked, true);
  assert.deepEqual(descriptor.promotion_blockers, ['dependency_security_audit']);
  assert.equal(descriptor.authority_granted, false);
  assert.equal(descriptor.package_published, false);
  assert.equal(descriptor.production_activated, false);
});
