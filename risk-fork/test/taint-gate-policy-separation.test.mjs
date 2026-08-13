import assert from 'node:assert/strict';
import test from 'node:test';

import * as taintGate from '../src/taint-gate.mjs';
import { NOW, hash } from './helpers.mjs';

const WORKSPACE_POLICY = Object.freeze({
  path_allowlist: ['src'],
  allow_delete: false,
  required_tests: [],
  max_files: 10,
  max_diff_bytes: 10_000,
});

function workspaceArtifact({ files = [], testEvidence = [], policy = WORKSPACE_POLICY } = {}) {
  return taintGate.validateCommitCandidate({
    candidate: {
      type: 'WORKSPACE_DIFF',
      files,
      test_evidence: testEvidence,
    },
    source_fork_id: 'fork:taint-policy-separation',
    policy,
    validated_at: NOW,
  });
}

test('public artifact verification does not invent an allowlist from child paths', () => {
  const artifact = workspaceArtifact({ files: [] });

  assert.equal(taintGate.verifyCommitArtifact(artifact), true);
});

test('public verification is structural while current deletion policy remains clean-side', () => {
  const artifact = workspaceArtifact({
    files: [{
      path: 'src/obsolete.txt',
      operation: 'delete',
      before_hash: hash('obsolete-content'),
      after_content: null,
    }],
    policy: { ...WORKSPACE_POLICY, allow_delete: true },
  });

  assert.equal(taintGate.verifyCommitArtifact(artifact), true);
  assert.throws(
    () => taintGate.revalidateCommitArtifact(artifact, { policy: WORKSPACE_POLICY }),
    /deletion.*not allowed|current commit policy/i,
  );
});

test('child-asserted passing evidence cannot satisfy a current required-test policy', () => {
  const testEvidence = [{
    name: 'unit:test',
    status: 'passed',
    evidence_ref: 'child-test:unit',
    evidence_hash: hash('child-test-unit'),
    duration_ms: 25,
  }];
  const policy = { ...WORKSPACE_POLICY, required_tests: ['unit:test'] };
  const artifact = workspaceArtifact({ testEvidence, policy });

  assert.throws(
    () => taintGate.revalidateCommitArtifact(artifact, { policy }),
    /clean-side required-test verification/i,
  );
});

test('clean-side required-test verification is exact-bound before policy revalidation', async () => {
  const testEvidence = [{
    name: 'unit:test',
    status: 'passed',
    evidence_ref: 'child-test:unit',
    evidence_hash: hash('child-test-unit'),
    duration_ms: 25,
  }];
  const policy = { ...WORKSPACE_POLICY, required_tests: ['unit:test'] };
  const artifact = workspaceArtifact({ testEvidence, policy });
  let requests = 0;

  assert.equal(typeof taintGate.verifyWorkspaceRequiredTests, 'function');
  await assert.rejects(
    taintGate.verifyWorkspaceRequiredTests(artifact, { policy, now: NOW }),
    /trusted clean-side required-test evidence verifier/i,
  );
  await assert.rejects(
    taintGate.verifyWorkspaceRequiredTests(artifact, {
      policy,
      now: NOW,
      verifyTestEvidence: async (request) => ({
        schema: 'agoragentic.risk-fork.required-test-attestation.v1',
        status: 'verified',
        request_hash: request.request_hash,
        test_name: request.test_name,
        artifact_hash: hash('wrong-artifact'),
        diff_hash: request.diff_hash,
        policy_hash: request.policy_hash,
        method: 'clean_reexecution',
        evidence_ref: 'clean-test:wrong-binding',
        evidence_hash: hash('clean-test-wrong-binding'),
      }),
    }),
    /binding mismatch: artifact_hash/,
  );
  const proof = await taintGate.verifyWorkspaceRequiredTests(artifact, {
    policy,
    now: NOW,
    verifyTestEvidence: async (request) => {
      requests += 1;
      assert.equal(request.authority_flags.child_evidence_is_authority, false);
      assert.equal(request.artifact_hash, artifact.artifact_hash);
      assert.equal(request.diff_hash, artifact.body.diff_hash);
      assert.equal(request.test_name, 'unit:test');
      assert.deepEqual(request.child_evidence_claims, testEvidence);
      return {
        schema: 'agoragentic.risk-fork.required-test-attestation.v1',
        status: 'verified',
        request_hash: request.request_hash,
        test_name: request.test_name,
        artifact_hash: request.artifact_hash,
        diff_hash: request.diff_hash,
        policy_hash: request.policy_hash,
        method: 'clean_reexecution',
        evidence_ref: 'clean-test:unit',
        evidence_hash: hash({ request_hash: request.request_hash, passed: true }),
      };
    },
  });

  assert.equal(requests, 1);
  assert.equal(proof.status, 'verified');
  assert.equal(
    taintGate.revalidateCommitArtifact(artifact, {
      policy,
      required_test_verification: proof,
      now: NOW,
    }),
    true,
  );

  const untrustedClone = structuredClone(proof);
  assert.throws(
    () => taintGate.revalidateCommitArtifact(artifact, {
      policy,
      required_test_verification: untrustedClone,
      now: NOW,
    }),
    /must originate from the clean-side verifier/i,
  );
});
