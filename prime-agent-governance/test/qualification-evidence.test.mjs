import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  sha256Ref,
  verifyQualificationEvidencePacket,
} from '../../integration-qualification/src/index.mjs';
import {
  buildPrimeAgentV072QualificationEvidence,
  loadPrimeAgentV072CompatibilityReceipt,
  loadPrimeAgentV072DependencyAudit,
  loadPrimeAgentV072IntegrityProfile,
  loadPrimeAgentReleaseObservationSnapshot,
} from '../evidence/build-evidence.mjs';
import { buildPrimeAgentMarketplaceQualificationRecord } from '../evidence/build-marketplace-record.mjs';
import { verifyPrimeAgentCompatibilityReceipt } from '../compatibility-runner.mjs';

const PACKAGE_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

function readJson(relativePath) {
  return JSON.parse(readFileSync(resolve(PACKAGE_ROOT, relativePath), 'utf8'));
}

test('committed provider-neutral evidence preserves runtime compatibility while blocking promotion', () => {
  const committed = readJson('evidence/prime-agent-v0.7.2-qualification.v1.json');
  assert.deepEqual(committed, buildPrimeAgentV072QualificationEvidence());
  assert.equal(verifyQualificationEvidencePacket(committed).ok, true);
  assert.equal(committed.qualification.declared_level, 'source_adapter');
  assert.equal(committed.qualification.evidence_level, 'runtime_compatibility');
  assert.equal(committed.qualification.effective_level, 'source_adapter');
  assert.equal(committed.qualification.promotion_candidate_level, null);
  assert.deepEqual(committed.qualification.promotion_candidate_levels, []);
  assert.equal(committed.qualification.promotion_blocked, true);
  assert.deepEqual(committed.qualification.promotion_blockers, ['dependency_security_audit']);
  assert.deepEqual(committed.promotion_blockers, ['dependency_security_audit']);
  assert.equal(committed.qualification.human_promotion_required, true);
  assert.equal(committed.qualification.auto_promoted, false);
  assert.equal(committed.qualification.level_results.policy_enforcement.qualified, false);
  assert.equal(committed.qualification.level_results.exact_runtime_verification.qualified, false);
  assert.equal(committed.qualification.level_results.hosted_availability.qualified, false);
  assert.equal(committed.qualification.level_results.production_activation.qualified, false);
  assert.ok(Object.values(committed.boundaries).every((value) => value === false));
  assert.equal(committed.boundaries.public_compatibility_claimed, false);
  assert.deepEqual({
    status: committed.release_observation.status,
    auto_update: committed.release_observation.auto_update,
    pin_changed: committed.release_observation.pin_changed,
    binary_executed: committed.release_observation.binary_executed,
    promotion_changed: committed.release_observation.promotion_changed,
  }, {
    status: 'update_available',
    auto_update: false,
    pin_changed: false,
    binary_executed: false,
    promotion_changed: false,
  });
  const releaseSnapshot = loadPrimeAgentReleaseObservationSnapshot();
  assert.equal(committed.release_observation.observed_at, releaseSnapshot.observed_at);
  assert.notEqual(committed.release_observation.observed_at, committed.generated_at);
  assert.ok(committed.observations.official_project_identified.evidence_refs.includes(releaseSnapshot.snapshot_hash));
  const dependencyAudit = loadPrimeAgentV072DependencyAudit();
  const compatibilityReceipt = loadPrimeAgentV072CompatibilityReceipt();
  assert.ok(Date.parse(committed.generated_at) >= Date.parse(dependencyAudit.observed_at));
  assert.ok(Date.parse(committed.generated_at) >= Date.parse(compatibilityReceipt.observed_at));
  assert.equal(dependencyAudit.advisory.id, 'GHSA-jmr9-qjv8-65gv');
  assert.equal(dependencyAudit.advisory.severity, 'high');
  assert.equal(dependencyAudit.advisory.first_patched_version, null);
  assert.equal(dependencyAudit.result.fix_available, false);
  assert.equal(dependencyAudit.result.promotion_blocking, true);
  assert.equal(
    dependencyAudit.dependency_closure.lock_digest,
    compatibilityReceipt.dependency_closure.lock_digest,
  );
  assert.ok(committed.observations.dependency_security_audit.evidence_refs.includes(dependencyAudit.audit_hash));
});

test('committed released-host receipt is hash-bound to exact host, closure, extension, and matrix evidence', () => {
  const receipt = loadPrimeAgentV072CompatibilityReceipt();
  assert.equal(verifyPrimeAgentCompatibilityReceipt(receipt).ok, true);
  assert.equal(receipt.artifact.asset_sha256, 'sha256:bc5471f2a626d727b88a45eb745fff93b10c554a3c4fc5912f25d8c64b987f5e');
  assert.match(receipt.artifact.first_party_tree_digest, /^sha256:[0-9a-f]{64}$/);
  assert.match(receipt.dependency_closure.lock_digest, /^sha256:[0-9a-f]{64}$/);
  assert.match(receipt.dependency_closure.dependency_tree_digest, /^sha256:[0-9a-f]{64}$/);
  assert.match(receipt.extension.manifest_digest, /^sha256:[0-9a-f]{64}$/);
  const profile = loadPrimeAgentV072IntegrityProfile();
  assert.equal(receipt.integrity_profile_hash, profile.profile_hash);
  assert.equal(profile.dependency_closures.find((entry) => entry.platform === 'win32').dependency_tree_digest, receipt.dependency_closure.dependency_tree_digest);
  assert.equal(profile.dependency_closures.find((entry) => entry.platform === 'linux').dependency_tree_digest, 'sha256:cfdbb4f400241fc9683b2ac95f5c9aa29ac65419cfca9c4d25d3f191beff2f97');
  assert.equal(receipt.compatibility.process_executed, true);
  assert.equal(receipt.compatibility.matrix_passed, true);
  assert.ok(receipt.compatibility.matrix.every((entry) => entry.status === 'passed'));
  assert.ok(Object.values(receipt.boundaries).every((value) => value === false));
});

test('committed Marketplace companion record is reproducible, source-only, and boundary preserving', () => {
  const committed = readJson('evidence/prime-agent-v0.7.2-agent-os-qualification.v1.json');
  const expected = buildPrimeAgentMarketplaceQualificationRecord();
  assert.deepEqual(committed, expected);
  const { record_hash: suppliedHash, ...body } = committed;
  assert.equal(suppliedHash, sha256Ref(body));
  assert.equal(committed.declared_level, 'source_adapter');
  assert.equal(committed.evidence_level, 'runtime_compatibility');
  assert.equal(committed.effective_level, 'source_adapter');
  assert.equal(committed.promotion_candidate_level, null);
  assert.equal(committed.promotion_blocked, true);
  assert.deepEqual(committed.promotion_blockers, ['dependency_security_audit']);
  assert.equal(committed.human_promotion_required, true);
  assert.equal(committed.human_promotion_approved, false);
  assert.equal(committed.auto_promoted, false);
  assert.equal(committed.checks.policy_enforcement_passed, false);
  assert.equal(committed.checks.dependency_security_audit_passed, false);
  assert.equal(committed.checks.exact_runtime_verified, false);
  assert.equal(committed.checks.hosted_available, false);
  assert.equal(committed.checks.production_activated, false);
  assert.equal(committed.authority.public_compatibility_claimed, false);
  assert.ok(Object.values(committed.authority).every((value) => value === false));
  assert.equal(committed.compatibility_receipt_digest, loadPrimeAgentV072CompatibilityReceipt().receipt_hash);
  assert.equal(committed.integrity_profile_digest, loadPrimeAgentV072IntegrityProfile().profile_hash);
  assert.equal(committed.dependency_audit_digest, loadPrimeAgentV072DependencyAudit().audit_hash);
  assert.equal(committed.artifacts.extension_package_digest, loadPrimeAgentV072CompatibilityReceipt().extension.manifest_digest);
  assert.equal(committed.artifacts.dependency_lock_digest, loadPrimeAgentV072CompatibilityReceipt().dependency_closure.lock_digest);
  assert.ok(committed.known_limitations.some((entry) => entry.includes('did not exercise real tool-call interception')));
  assert.ok(committed.known_limitations.some((entry) => entry.includes('source-only extension package is unpublished')));
  assert.ok(committed.known_limitations.some((entry) => entry.includes('GHSA-jmr9-qjv8-65gv')));
});
