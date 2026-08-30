import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, resolve } from 'node:path';
import { readFileSync, writeFileSync } from 'node:fs';

import {
  createQualificationEvidencePacket,
  observeReleaseDrift,
  stableStringify,
} from '../../integration-qualification/src/index.mjs';
import {
  buildPrimeAgentExtensionIntegrity,
  integritySha256,
  loadPrimeAgentIntegrityProfile,
  sha256File,
} from '../artifact-integrity.mjs';
import { verifyPrimeAgentCompatibilityReceipt } from '../compatibility-runner.mjs';
import { buildPrimeAgentV072DependencyAudit } from './build-dependency-audit.mjs';

const EVIDENCE_ROOT = dirname(fileURLToPath(import.meta.url));
const PACKAGE_ROOT = resolve(EVIDENCE_ROOT, '..');
const OUTPUT_PATH = resolve(
  EVIDENCE_ROOT,
  'prime-agent-v0.7.2-qualification.v1.json',
);
const RECEIPT_PATH = resolve(EVIDENCE_ROOT, 'prime-agent-v0.7.2-released-compatibility.v1.json');
const DEPENDENCY_LOCK_PATH = resolve(EVIDENCE_ROOT, 'prime-agent-v0.7.2-package-lock.json');
const DEPENDENCY_AUDIT_PATH = resolve(EVIDENCE_ROOT, 'prime-agent-v0.7.2-dependency-audit.v1.json');
const INTEGRITY_PROFILE_PATH = resolve(EVIDENCE_ROOT, 'prime-agent-v0.7.2-integrity-profile.v1.json');
const RELEASE_OBSERVATION_PATH = resolve(EVIDENCE_ROOT, 'prime-agent-v0.8.1-release-observation.v1.json');
const RELEASE_OBSERVATION_KEYS = Object.freeze([
  'schema',
  'source_url',
  'capture_method',
  'observed_at',
  'tag',
  'commit',
  'html_url',
  'published_at',
  'draft',
  'prerelease',
  'pin_changed',
  'promotion_changed',
  'snapshot_hash',
]);

function observation(status, proofClass, evidenceRefs, summary) {
  return { status, proof_class: proofClass, evidence_refs: evidenceRefs, summary };
}

export function loadPrimeAgentV072CompatibilityReceipt() {
  const receipt = JSON.parse(readFileSync(RECEIPT_PATH, 'utf8'));
  const verification = verifyPrimeAgentCompatibilityReceipt(receipt);
  if (!verification.ok) {
    throw new TypeError(`committed compatibility receipt is invalid: ${verification.errors.join('; ')}`);
  }
  const integrityProfile = loadPrimeAgentV072IntegrityProfile();
  const extensionIntegrity = buildPrimeAgentExtensionIntegrity(PACKAGE_ROOT, {
    expectedManifestDigest: integrityProfile.extension_manifest_digest,
  });
  if (!extensionIntegrity.valid || extensionIntegrity.manifest_digest !== receipt.extension.manifest_digest) {
    throw new TypeError('committed compatibility receipt does not bind the current extension manifest');
  }
  if (sha256File(DEPENDENCY_LOCK_PATH) !== receipt.dependency_closure.lock_digest) {
    throw new TypeError('committed compatibility receipt does not bind the pinned dependency lock');
  }
  return receipt;
}

export function loadPrimeAgentV072IntegrityProfile() {
  const result = loadPrimeAgentIntegrityProfile(INTEGRITY_PROFILE_PATH);
  if (!result.valid) {
    throw new TypeError(`committed integrity profile is invalid: ${result.blockers.join('; ')}`);
  }
  return result.profile;
}

export function loadPrimeAgentV072DependencyAudit() {
  const observed = JSON.parse(readFileSync(DEPENDENCY_AUDIT_PATH, 'utf8'));
  const expected = buildPrimeAgentV072DependencyAudit();
  if (stableStringify(observed) !== stableStringify(expected)) {
    throw new TypeError('committed dependency audit does not match the pinned lock and captured advisory result');
  }
  return Object.freeze(observed);
}

export function loadPrimeAgentReleaseObservationSnapshot() {
  const snapshot = JSON.parse(readFileSync(RELEASE_OBSERVATION_PATH, 'utf8'));
  const keys = Reflect.ownKeys(snapshot);
  if (
    Object.getPrototypeOf(snapshot) !== Object.prototype
    || keys.length !== RELEASE_OBSERVATION_KEYS.length
    || RELEASE_OBSERVATION_KEYS.some((key) => !Object.hasOwn(snapshot, key))
  ) throw new TypeError('committed release observation snapshot is not schema closed');
  const { snapshot_hash: observedHash, ...body } = snapshot;
  if (
    snapshot.schema !== 'agoragentic.prime-agent.release-observation-snapshot.v1'
    || snapshot.source_url !== 'https://api.github.com/repos/PrimeIntellect-ai/prime-agent/releases/latest'
    || snapshot.capture_method !== 'authoritative_github_api_read_only'
    || snapshot.tag !== 'v0.8.1'
    || snapshot.commit !== '514633727bf26d74f39f3119c2b0e31a5ceb2a9d'
    || snapshot.html_url !== 'https://github.com/PrimeIntellect-ai/prime-agent/releases/tag/v0.8.1'
    || snapshot.draft !== false
    || snapshot.prerelease !== false
    || snapshot.pin_changed !== false
    || snapshot.promotion_changed !== false
    || observedHash !== integritySha256(body)
  ) throw new TypeError('committed release observation snapshot is invalid');
  return Object.freeze(snapshot);
}

export function buildPrimeAgentV072QualificationEvidence() {
  const integrityProfile = loadPrimeAgentV072IntegrityProfile();
  const receipt = loadPrimeAgentV072CompatibilityReceipt();
  const dependencyAudit = loadPrimeAgentV072DependencyAudit();
  const releaseObservation = loadPrimeAgentReleaseObservationSnapshot();
  return createQualificationEvidencePacket({
    integration_id: 'prime-agent-governance',
    declared_level: 'source_adapter',
    generated_at: receipt.observed_at,
    subject: {
      project: 'Prime Agent',
      repository: 'https://github.com/PrimeIntellect-ai/prime-agent',
    },
    release: {
      tag: 'v0.7.2',
      commit: '83a0f9f9566219551fcb6ffaf7f519a815749a58',
      asset_name: 'prime-agent-0.7.2.tgz',
      asset_sha256: 'bc5471f2a626d727b88a45eb745fff93b10c554a3c4fc5912f25d8c64b987f5e',
      asset_size_bytes: 9387295,
      asset_url: 'https://github.com/PrimeIntellect-ai/prime-agent/releases/download/v0.7.2/prime-agent-0.7.2.tgz',
    },
    release_observation: observeReleaseDrift({
      pinned: {
        tag: 'v0.7.2',
        commit: '83a0f9f9566219551fcb6ffaf7f519a815749a58',
      },
      observedLatest: {
        tag: releaseObservation.tag,
        commit: releaseObservation.commit,
        observed_at: releaseObservation.observed_at,
      },
    }),
    observations: {
      official_project_identified: observation(
        'passed',
        'official_metadata',
        [
          'https://github.com/PrimeIntellect-ai/prime-agent/releases/tag/v0.7.2',
          releaseObservation.source_url,
          releaseObservation.snapshot_hash,
        ],
        'Official repository, official tag, release asset, and commit were identified.',
      ),
      metadata_mapping_tested: observation(
        'passed',
        'local_test',
        ['prime-agent-governance/test/release-verifier.test.mjs'],
        'Released package name, version, Node floor, CLI entry, exports, and piConfig are checked exactly.',
      ),
      source_adapter_tested: observation(
        'passed',
        'local_test',
        [
          'prime-agent-governance/test/extension.test.mjs',
          receipt.extension.manifest_digest,
        ],
        'The source extension policy and evidence adapter passes deterministic unit and adversarial tests.',
      ),
      policy_boundary_observed: observation(
        'unknown',
        'local_test',
        ['prime-agent-governance/test/extension.test.mjs'],
        'Policy behavior is unit-tested, but a real host tool-call interception was not exercised without a provider action.',
      ),
      immutable_release_pin_verified: observation(
        'passed',
        'artifact_digest',
        [
          'prime-agent-governance/evidence/prime-agent-v0.7.2-released-compatibility.v1.json',
          receipt.receipt_hash,
          receipt.artifact.asset_sha256,
        ],
        'The observed 9,387,295-byte release artifact recomputed to the pinned SHA-256 and exact package metadata.',
      ),
      exact_host_artifact_loaded: observation(
        'passed',
        'host_runtime',
        [
          receipt.receipt_hash,
          integrityProfile.profile_hash,
          receipt.artifact.first_party_tree_digest,
          receipt.dependency_closure.lock_digest,
          receipt.dependency_closure.dependency_tree_digest,
          receipt.extension.manifest_digest,
        ],
        'The Windows x64 v0.7.2 first-party tree, pinned dependency closure, and exact source extension were integrity-checked before the released CLI loaded the extension in offline RPC mode; the profile separately records the independently reproduced Linux x64 closure.',
      ),
      compatibility_matrix_passed: observation(
        'passed',
        'host_runtime',
        [receipt.receipt_hash, receipt.compatibility.matrix_digest],
        'Provider-free JSONL, state, discovery, extension command, idle abort, observe, malformed input, unknown command, and EOF cases passed.',
      ),
      dependency_security_audit: observation(
        'failed',
        'official_metadata',
        [
          'prime-agent-governance/evidence/prime-agent-v0.7.2-dependency-audit.v1.json',
          dependencyAudit.audit_hash,
          dependencyAudit.advisory.url,
          dependencyAudit.dependency_closure.lock_digest,
        ],
        'The exact production dependency closure includes direct extract-zip 2.0.1, which the observed GitHub/npm advisory classifies as high severity with no patched version; promotion is blocked without changing the compatibility result.',
      ),
      restricted_exact_runtime_observed: observation(
        'unknown',
        'restricted_runtime',
        ['prime-agent-governance/RUNTIME_INTEGRATION.md'],
        'No restricted Linux canary, active cancellation, stale-worker recovery, or external policy chokepoint proof exists.',
      ),
      hosted_endpoint_observed: observation(
        'unknown',
        'hosted_observation',
        ['prime-agent-governance/RUNTIME_INTEGRATION.md'],
        'No hosted Prime runtime endpoint was observed.',
      ),
      production_activation_observed: observation(
        'unknown',
        'production_observation',
        ['prime-agent-governance/RUNTIME_INTEGRATION.md'],
        'No production deployment or activation occurred.',
      ),
      owner_promotion_approved: observation(
        'unknown',
        'human_decision',
        ['https://github.com/rhein1/agoragentic-integrations/issues/323'],
        'Human promotion remains pending and cannot be inferred from this packet.',
      ),
    },
    promotion_blockers: ['dependency_security_audit'],
    boundaries: {
      credentials_used: false,
      paid_provider_calls: false,
      production_deployed: false,
      package_published: false,
      outreach_performed: false,
      public_compatibility_claimed: false,
      wallet_mutated: false,
      settlement_mutated: false,
      trust_mutated: false,
      ranking_mutated: false,
    },
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const rendered = `${JSON.stringify(buildPrimeAgentV072QualificationEvidence(), null, 2)}\n`;
  if (process.argv.includes('--write')) {
    writeFileSync(OUTPUT_PATH, rendered, 'utf8');
  } else {
    process.stdout.write(rendered);
  }
}
