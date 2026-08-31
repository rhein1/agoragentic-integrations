import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { sha256Ref } from '../../integration-qualification/src/index.mjs';
import {
  PRIME_AGENT_EVIDENCE_REFS,
  PRIME_AGENT_HOST_CONTRACT,
  PRIME_AGENT_HOST_IDENTITY,
  PRIME_AGENT_KNOWN_LIMITATIONS,
} from '../host-contract.mjs';
import {
  buildPrimeAgentV072QualificationEvidence,
  loadPrimeAgentV072CompatibilityReceipt,
  loadPrimeAgentV072DependencyAudit,
  loadPrimeAgentV072IntegrityProfile,
} from './build-evidence.mjs';

const PACKAGE_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
function sha256File(relativePath) {
  const bytes = readFileSync(resolve(PACKAGE_ROOT, relativePath));
  return `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
}

export function buildPrimeAgentMarketplaceQualificationRecord() {
  const evidence = buildPrimeAgentV072QualificationEvidence();
  const receipt = loadPrimeAgentV072CompatibilityReceipt();
  const dependencyAudit = loadPrimeAgentV072DependencyAudit();
  const integrityProfile = loadPrimeAgentV072IntegrityProfile();
  if (sha256File('index.mjs') !== PRIME_AGENT_HOST_CONTRACT.source_adapter_sha256
    || sha256File('test/extension.test.mjs') !== PRIME_AGENT_HOST_CONTRACT.source_adapter_test_sha256) {
    throw new TypeError('source adapter or its deterministic test no longer matches the host contract');
  }
  const body = {
    schema: 'agoragentic.agent-os.integration-qualification-record.v1',
    integration_id: 'prime-agent-governance',
    upstream: {
      repository: PRIME_AGENT_HOST_IDENTITY.repository,
      tag: PRIME_AGENT_HOST_IDENTITY.tag,
      version: PRIME_AGENT_HOST_IDENTITY.version,
      commit: PRIME_AGENT_HOST_IDENTITY.commit,
      release_url: 'https://github.com/PrimeIntellect-ai/prime-agent/releases/tag/v0.7.2',
      artifact: PRIME_AGENT_HOST_IDENTITY.release_asset,
      artifact_url: 'https://github.com/PrimeIntellect-ai/prime-agent/releases/download/v0.7.2/prime-agent-0.7.2.tgz',
      artifact_sha256: PRIME_AGENT_HOST_IDENTITY.release_asset_sha256,
    },
    declared_level: evidence.qualification.declared_level,
    evidence_level: evidence.qualification.evidence_level,
    effective_level: evidence.qualification.effective_level,
    promotion_candidate_level: evidence.qualification.promotion_candidate_level,
    promotion_blocked: evidence.qualification.promotion_blocked,
    promotion_blockers: evidence.qualification.promotion_blockers,
    human_promotion_required: evidence.qualification.human_promotion_required,
    human_promotion_approved: false,
    auto_promoted: false,
    evidence_ref: PRIME_AGENT_EVIDENCE_REFS.qualification_evidence,
    evidence_digest: evidence.evidence_hash,
    compatibility_receipt_ref: PRIME_AGENT_EVIDENCE_REFS.compatibility_receipt,
    compatibility_receipt_digest: receipt.receipt_hash,
    integrity_profile_ref: PRIME_AGENT_EVIDENCE_REFS.integrity_profile,
    integrity_profile_digest: integrityProfile.profile_hash,
    dependency_audit_ref: PRIME_AGENT_EVIDENCE_REFS.dependency_audit,
    dependency_audit_digest: dependencyAudit.audit_hash,
    generated_at: evidence.generated_at,
    checks: {
      immutable_release_pinned: receipt.artifact.asset_sha256 === PRIME_AGENT_HOST_IDENTITY.release_asset_sha256,
      source_adapter_present: true,
      policy_enforcement_passed: false,
      release_artifact_verified: receipt.artifact.first_party_file_count > 0,
      extension_loaded: receipt.compatibility.matrix.some((entry) => entry.id === 'extension_command_load' && entry.status === 'passed'),
      compatibility_matrix_passed: receipt.compatibility.matrix_passed,
      dependency_security_audit_passed: false,
      exact_runtime_verified: false,
      hosted_available: false,
      production_activated: false,
    },
    artifacts: {
      source_adapter_digest: PRIME_AGENT_HOST_CONTRACT.source_adapter_sha256,
      extension_package_digest: receipt.extension.manifest_digest,
      materialized_host_tree_digest: receipt.artifact.first_party_tree_digest,
      dependency_lock_digest: receipt.dependency_closure.lock_digest,
      dependency_tree_digest: receipt.dependency_closure.dependency_tree_digest,
      compatibility_matrix_digest: receipt.compatibility.matrix_digest,
      case_results_digest: sha256Ref({
        source_adapter_test: PRIME_AGENT_HOST_CONTRACT.source_adapter_test_sha256,
        qualification_evidence: evidence.evidence_hash,
        compatibility_receipt: receipt.receipt_hash,
        integrity_profile: integrityProfile.profile_hash,
        source_policy_tests_passed: true,
        real_host_policy_interception_observed: false,
      }),
    },
    authority: {
      credentials_used: false,
      provider_calls_made: false,
      network_authority_granted: false,
      spend_occurred: false,
      wallet_activity: false,
      settlement_activity: false,
      deployment_changed: false,
      publication_changed: false,
      public_compatibility_claimed: false,
      trust_or_ranking_mutated: false,
    },
    known_limitations: [...PRIME_AGENT_KNOWN_LIMITATIONS],
  };
  return Object.freeze({ ...body, record_hash: sha256Ref(body) });
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const rendered = `${JSON.stringify(buildPrimeAgentMarketplaceQualificationRecord(), null, 2)}\n`;
  if (process.argv.includes('--write')) {
    writeFileSync(
      resolve(PACKAGE_ROOT, 'evidence', 'prime-agent-v0.7.2-agent-os-qualification.v1.json'),
      rendered,
      'utf8',
    );
  } else {
    process.stdout.write(rendered);
  }
}
