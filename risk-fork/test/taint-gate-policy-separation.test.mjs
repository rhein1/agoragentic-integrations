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

function typedArtifact(
  payload,
  payloadSchema,
  sourceForkId = 'fork:taint-policy-separation',
) {
  return taintGate.validateCommitCandidate({
    candidate: {
      type: 'TYPED_RESULT',
      payload,
      payload_schema: payloadSchema,
    },
    source_fork_id: sourceForkId,
    validated_at: NOW,
  });
}

function closedStringPayloadSchema(keys) {
  return {
    type: 'object',
    additionalProperties: false,
    required: keys,
    properties: Object.fromEntries(keys.map((key) => [key, { type: 'string' }])),
  };
}

test('exact generated amk_ material is rejected even when embedded', () => {
  const syntheticKey = `amk_${'a'.repeat(64)}`;

  assert.throws(
    () => typedArtifact(
      { note: `opaque child output x${syntheticKey}y` },
      closedStringPayloadSchema(['note']),
    ),
    /taint scan failed: secret_pattern/i,
  );
  assert.throws(
    () => workspaceArtifact({
      files: [{
        path: 'src/child-output.txt',
        operation: 'create',
        before_hash: null,
        after_content: `opaque child output _${syntheticKey}-`,
      }],
    }),
    /workspace diff taint scan failed/i,
  );
});

test('documented amk_ placeholders remain non-authority text', () => {
  for (const placeholder of [
    'amk_your_key',
    'amk_your_key_here',
    'amk_your_api_key_here',
  ]) {
    const artifact = typedArtifact(
      { note: `documentation example: ${placeholder}` },
      closedStringPayloadSchema(['note']),
    );
    assert.equal(artifact.body.payload.note, `documentation example: ${placeholder}`);
  }
});

test('generic credential prefixes accept underscore or dash separators', () => {
  for (const token of [
    `sk_${'s'.repeat(20)}`,
    `sk-${'s'.repeat(20)}`,
    `ghp_${'g'.repeat(20)}`,
    `gho_${'g'.repeat(20)}`,
    `ghu_${'g'.repeat(20)}`,
    `ghs_${'g'.repeat(20)}`,
    `ghr_${'g'.repeat(20)}`,
    `github_pat_${'g'.repeat(20)}`,
    `xoxb_${'x'.repeat(20)}`,
    `xoxb-${'x'.repeat(20)}`,
  ]) {
    assert.throws(
      () => typedArtifact(
        { note: `opaque child output ${token}` },
        closedStringPayloadSchema(['note']),
      ),
      /taint scan failed: secret_pattern/i,
      token.slice(0, token.indexOf(token.includes('_') ? '_' : '-') + 1),
    );
  }
});

test('secret-shaped object keys, schema metadata, and workspace paths are rejected without echo', () => {
  const syntheticKey = `amk_${'b'.repeat(64)}`;
  const embedded = `x${syntheticKey}y`;

  for (const invoke of [
    () => typedArtifact(
      { [embedded]: 'opaque-child-value' },
      closedStringPayloadSchema([embedded]),
    ),
    () => typedArtifact(
      { note: 'opaque-child-value' },
      {
        ...closedStringPayloadSchema(['note']),
        description: `schema metadata ${embedded}`,
      },
    ),
    () => workspaceArtifact({
      files: [{
        path: `src/${embedded}.txt`,
        operation: 'create',
        before_hash: null,
        after_content: 'opaque-child-value',
      }],
    }),
  ]) {
    assert.throws(invoke, (error) => {
      assert.match(error.message, /taint scan failed/i);
      assert.equal(error.message.includes(syntheticKey), false);
      return true;
    });
  }
});

test('unsupported envelope and file keys are rejected without echoing credentials', () => {
  const syntheticKey = `amk_${'d'.repeat(64)}`;
  const embedded = `x${syntheticKey}y`;
  for (const invoke of [
    () => taintGate.validateCommitCandidate({
      candidate: {
        type: 'TYPED_RESULT',
        payload: { note: 'opaque-child-value' },
        payload_schema: closedStringPayloadSchema(['note']),
        [embedded]: 'unexpected',
      },
      source_fork_id: 'fork:taint-policy-separation',
      validated_at: NOW,
    }),
    () => workspaceArtifact({
      files: [{
        path: 'src/opaque.txt',
        operation: 'create',
        before_hash: null,
        after_content: 'opaque-child-value',
        [embedded]: 'unexpected',
      }],
    }),
  ]) {
    assert.throws(invoke, (error) => {
      assert.match(error.message, /unsupported secret-shaped field/i);
      assert.equal(error.message.includes(syntheticKey), false);
      return true;
    });
  }
});

test('authority and memory field names reject camelCase and separator variants', () => {
  const forbiddenKeys = [
    'authorizationGrant',
    'authorization-grant',
    'authorization.grant',
    'authorization grant',
    'authorization\uFF0Egrant',
    'privateKey',
    'private-key',
    'parentMemory',
    'parent\u00A0memory',
    'memoryUpdate',
    'AuThOrIzAtIoN',
    'mEsSaGeS',
    'walletPRIVATEKey',
    'rawCHILDConversation',
  ];

  for (const key of forbiddenKeys) {
    assert.throws(
      () => typedArtifact(
        { [key]: 'opaque-child-value' },
        closedStringPayloadSchema([key]),
      ),
      /cannot carry trusted authority or memory field/i,
      key,
    );
  }
});

test('source fork IDs share the schema secret-filtered opaque-reference boundary', () => {
  const syntheticKey = `amk_${'b'.repeat(64)}`;
  const payload = { note: 'opaque-child-value' };
  const payloadSchema = closedStringPayloadSchema(['note']);

  assert.throws(
    () => typedArtifact(payload, payloadSchema, `fork:${syntheticKey}`),
    /source_fork_id appears to contain secret material/i,
  );

  const forged = structuredClone(typedArtifact(payload, payloadSchema));
  forged.source_fork_id = `fork:${syntheticKey}`;
  forged.artifact_hash = hash({ ...forged, artifact_hash: null });
  assert.throws(
    () => taintGate.verifyCommitArtifact(forged),
    /commit artifact\.source_fork_id appears to contain secret material/i,
  );
});

test('authority-field normalization does not reject bounded absence metadata', () => {
  const payload = {
    authorizationGrantStatus: 'absent',
    privateKeyScanStatus: 'passed',
    parentMemoryRedactionStatus: 'passed',
    memoryUpdatePolicy: 'deny',
  };
  const artifact = typedArtifact(payload, closedStringPayloadSchema(Object.keys(payload)));

  assert.deepEqual(artifact.body.payload, payload);
});

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
