import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { LocalReferenceRiskForkAdapter, inspectLocalWorkspace } from '../src/adapters/local-reference.mjs';
import {
  CommitAmbiguousError,
  FileAuthorizationClaimStore,
  commitPreparedArtifact,
} from '../src/clean-commit.mjs';
import { RiskForkController } from '../src/controller.mjs';
import { transitionLifecycle } from '../src/lifecycle.mjs';
import { RiskForkProvider } from '../src/provider.mjs';
import { createRiskForkReceipt, verifyRiskForkReceipt } from '../src/receipt.mjs';
import { classifyRisk } from '../src/risk-classifier.mjs';
import { validateCommitCandidate } from '../src/taint-gate.mjs';
import {
  NOW,
  advanceToCommitting,
  closedResultSchema,
  hash,
  makeBinding,
  makeCapsule,
  makeForkIdentity,
  makePreparedLifecycle,
} from './helpers.mjs';

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function exactApproval(request) {
  return {
    status: 'verified',
    artifact_hash: request.artifact_hash,
    capsule_hash: request.capsule_hash,
    parent_state_hash: request.parent_state_hash,
    evidence_ref: 'approval:evidence',
    evidence_hash: hash('approval-evidence'),
  };
}

function exactExecutionAuthorization(request) {
  return {
    status: 'verified',
    revocation_status: 'active',
    authorization_id: request.authorization_id,
    binding_hash: request.binding_hash,
    evidence_ref: 'authorization:evidence',
    evidence_hash: hash('authorization-evidence'),
  };
}

async function verifyLocalAuthorityFreeSource(request) {
  return {
    schema: 'agoragentic.risk-fork.local-authority-free-attestation.v1',
    status: 'verified',
    request_hash: request.request_hash,
    capsule_hash: request.capsule_hash,
    workspace_digest: request.workspace_digest,
    evidence_ref: 'local-source-attestation:evidence',
    evidence_hash: hash({ request_hash: request.request_hash, status: 'verified' }),
    claims: {
      authority_free: true,
      credentials_absent: true,
      wallet_material_absent: true,
      execution_authority_absent: true,
    },
  };
}

function makeProposalFixture(overrides = {}) {
  const capsule = overrides.capsule ?? makeCapsule();
  const identity = overrides.identity ?? makeForkIdentity(capsule);
  const binding = overrides.binding ?? makeBinding({
    capsule,
    identity,
    action_operation: overrides.operation ?? 'mcp_tool_call',
    provider_ref: overrides.provider_ref ?? 'provider:1',
    amount: overrides.amount,
    currency: overrides.currency,
    payment_rail: overrides.payment_rail,
  });
  const action = {
    operation: overrides.operation ?? 'mcp_tool_call',
    target_ref: binding.target_ref,
    provider_ref: binding.provider_ref,
    arguments: overrides.arguments ?? { value: 1 },
    amount: binding.commercial.amount,
    currency: binding.commercial.currency,
    payment_rail: binding.commercial.payment_rail,
  };
  const candidate = {
    type: 'CONSEQUENTIAL_ACTION_PROPOSAL',
    action,
  };
  const forkRef = overrides.fork_ref ?? 'fork:prepared-1';
  const artifact = validateCommitCandidate({
    candidate,
    source_fork_id: forkRef,
    execution_binding: binding,
    validated_at: NOW,
  });
  return { capsule, identity, binding, action, candidate, artifact, forkRef };
}

function destructionEvidence(forkRef, providerRef = 'provider:1') {
  return {
    status: 'verified',
    provider_ref: providerRef,
    fork_ref: forkRef,
    evidence_ref: 'destruction:evidence',
    evidence_hash: hash('destruction:evidence'),
  };
}

test('taint gate rejects malicious paths, secrets, and raw authority fields', async (t) => {
  await t.test('path traversal and Git control metadata', () => {
    for (const maliciousPath of ['../outside.txt', '.git/config', 'src/file.txt:stream']) {
      assert.throws(
        () => validateCommitCandidate({
          candidate: {
            type: 'WORKSPACE_DIFF',
            files: [{
              path: maliciousPath,
              operation: 'create',
              before_hash: null,
              after_content: 'safe',
            }],
          },
          source_fork_id: 'fork:tainted',
          policy: { path_allowlist: ['src', '.git'] },
          validated_at: NOW,
        }),
        /safe relative path|Git control metadata/,
      );
    }
  });

  await t.test('secret-shaped result text', () => {
    assert.throws(
      () => validateCommitCandidate({
        candidate: {
          type: 'TYPED_RESULT',
          payload: { answer: 'api_key=secret-value-that-must-not-cross' },
          payload_schema: closedResultSchema(),
        },
        source_fork_id: 'fork:tainted',
        validated_at: NOW,
      }),
      /taint scan failed: secret_pattern/,
    );
  });

  await t.test('raw authority field even when the typed schema permits it', () => {
    const authoritySchema = {
      type: 'object',
      additionalProperties: false,
      required: ['authorization'],
      properties: { authorization: { type: 'string' } },
    };
    assert.throws(
      () => validateCommitCandidate({
        candidate: {
          type: 'TYPED_RESULT',
          payload: { authorization: 'authority-record:opaque' },
          payload_schema: authoritySchema,
        },
        source_fork_id: 'fork:tainted',
        validated_at: NOW,
      }),
      /cannot carry trusted authority/,
    );
  });
});

test('consequential proposals enforce exact provider, target, commercial, and argument binding', () => {
  const fixture = makeProposalFixture({
    operation: 'payment',
    amount: '1.25',
    currency: 'USDC',
    payment_rail: 'x402:base',
  });
  assert.equal(fixture.artifact.body.execution_binding_hash, fixture.binding.binding_hash);

  for (const [field, value, expected] of [
    ['provider_ref', 'provider:other', /provider_ref/],
    ['target_ref', 'target:other', /target_ref/],
    ['amount', '2.00', /amount/],
  ]) {
    const candidate = clone(fixture.candidate);
    candidate.action[field] = value;
    assert.throws(
      () => validateCommitCandidate({
        candidate,
        source_fork_id: fixture.forkRef,
        execution_binding: fixture.binding,
        validated_at: NOW,
      }),
      expected,
    );
  }

  const argumentDrift = clone(fixture.candidate);
  argumentDrift.action.arguments = { value: 2 };
  assert.throws(
    () => validateCommitCandidate({
      candidate: argumentDrift,
      source_fork_id: fixture.forkRef,
      execution_binding: fixture.binding,
      validated_at: NOW,
    }),
    /effective arguments hash/,
  );
});

test('consequential proposal operation is part of the exact authorized action', () => {
  const fixture = makeProposalFixture({
    operation: 'payment',
    amount: '1.25',
    currency: 'USDC',
    payment_rail: 'x402:base',
  });
  const operationDrift = clone(fixture.candidate);
  operationDrift.action.operation = 'deploy';
  assert.throws(
    () => validateCommitCandidate({
      candidate: operationDrift,
      source_fork_id: fixture.forkRef,
      execution_binding: fixture.binding,
      validated_at: NOW,
    }),
    /operation|binding mismatch/,
  );
});

test('file authorization claims are atomic under concurrency and cannot be replayed', async () => {
  const temporary = await mkdtemp(path.join(os.tmpdir(), 'risk-fork-claims-test-'));
  try {
    const store = await new FileAuthorizationClaimStore({
      directory: path.join(temporary, 'claims'),
      clock: () => new Date(NOW),
    }).initialize();
    const request = {
      authorizationId: 'authorization:concurrent-1',
      bindingHash: hash('binding:concurrent-1'),
    };
    const claims = await Promise.all([store.claim(request), store.claim(request)]);
    assert.deepEqual(
      claims.map((claim) => claim.status).sort(),
      ['already_claimed', 'claimed'],
    );
    const winner = claims.find((claim) => claim.status === 'claimed');
    await store.complete({
      ...request,
      claimToken: winner.claim_token,
      resultHash: hash('result:concurrent-1'),
    });
    assert.equal((await store.claim(request)).status, 'consumed');
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
});

test('an executor failure after one-use claim is ambiguous and cannot be retried', async () => {
  const temporary = await mkdtemp(path.join(os.tmpdir(), 'risk-fork-ambiguous-test-'));
  try {
    const fixture = makeProposalFixture({
      operation: 'payment',
      amount: '1.25',
      currency: 'USDC',
      payment_rail: 'x402:base',
    });
    const lifecycle = advanceToCommitting(makePreparedLifecycle(fixture.artifact.artifact_hash));
    const store = await new FileAuthorizationClaimStore({
      directory: path.join(temporary, 'claims'),
      clock: () => new Date(NOW),
    }).initialize();
    let executions = 0;
    const input = {
      capsule: fixture.capsule,
      fork_identity: fixture.identity,
      lifecycle,
      artifact: fixture.artifact,
      destruction_evidence: destructionEvidence(fixture.forkRef),
      expected_parent_state_hash: fixture.capsule.parent.state_hash,
      current_parent_state_hash: fixture.capsule.parent.state_hash,
      verifyCommitApproval: async (request) => exactApproval(request),
      verifyExecutionAuthorization: async (request) => exactExecutionAuthorization(request),
      authorizationClaimStore: store,
      expected_binding: {
        policy_version: fixture.capsule.governance.policy_version,
        mandate_version: fixture.capsule.governance.mandate_version,
      },
      executeAction: async () => {
        executions += 1;
        throw new Error('provider response was lost');
      },
      now: NOW,
    };

    await assert.rejects(
      commitPreparedArtifact(input),
      (error) => error instanceof CommitAmbiguousError
        && error.code === 'RISK_FORK_COMMIT_AMBIGUOUS',
    );
    await assert.rejects(commitPreparedArtifact(input), /already_claimed/);
    assert.equal(executions, 1);
    const record = await store.get(fixture.binding.one_use_authorization_id);
    assert.equal(record.status, 'claimed');
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
});

test('governance drift blocks consequential commit before approval or authority mutation', async (t) => {
  for (const field of ['policy_version', 'mandate_version']) {
    for (const driftSource of ['binding', 'current trusted input']) {
      await t.test(`${field} in ${driftSource}`, async () => {
        const capsule = makeCapsule();
        const identity = makeForkIdentity(capsule);
        const binding = makeBinding({
          capsule,
          identity,
          ...(driftSource === 'binding' ? { [field]: `${field}:drifted` } : {}),
        });
        const fixture = makeProposalFixture({ capsule, identity, binding });
        const lifecycle = advanceToCommitting(makePreparedLifecycle(fixture.artifact.artifact_hash));
        const expectedBinding = {
          policy_version: capsule.governance.policy_version,
          mandate_version: capsule.governance.mandate_version,
        };
        if (driftSource === 'current trusted input') {
          expectedBinding[field] = `${field}:drifted`;
        }
        let approvals = 0;
        let authorizationVerifications = 0;
        let claims = 0;
        let executions = 0;

        await assert.rejects(
          commitPreparedArtifact({
            capsule,
            fork_identity: identity,
            lifecycle,
            artifact: fixture.artifact,
            destruction_evidence: destructionEvidence(fixture.forkRef),
            expected_parent_state_hash: capsule.parent.state_hash,
            current_parent_state_hash: capsule.parent.state_hash,
            expected_binding: expectedBinding,
            verifyCommitApproval: async (request) => {
              approvals += 1;
              return exactApproval(request);
            },
            verifyExecutionAuthorization: async (request) => {
              authorizationVerifications += 1;
              return exactExecutionAuthorization(request);
            },
            authorizationClaimStore: {
              async claim() {
                claims += 1;
                return { status: 'claimed', claim_token: 'must-not-be-used' };
              },
              async complete() {
                throw new Error('must not complete a drifted authorization');
              },
            },
            executeAction: async () => {
              executions += 1;
              return { accepted: true };
            },
            now: NOW,
          }),
          driftSource === 'binding'
            ? new RegExp(`Execution binding mismatch: ${field}`)
            : new RegExp(`Current trusted ${field} differs from the Savepoint Capsule`),
        );
        assert.equal(approvals, 0);
        assert.equal(authorizationVerifications, 0);
        assert.equal(claims, 0);
        assert.equal(executions, 0);
      });
    }
  }
});

test('parent state drift blocks clean commit before approval or mutation', async () => {
  const schema = closedResultSchema();
  const capsule = makeCapsule({ result_schema: schema });
  const identity = makeForkIdentity(capsule);
  const forkRef = 'fork:typed-result-1';
  const artifact = validateCommitCandidate({
    candidate: {
      type: 'TYPED_RESULT',
      payload: { answer: 'safe' },
      payload_schema: schema,
    },
    source_fork_id: forkRef,
    policy: { typed_result_schema_hash: capsule.authorized_result_schema_hash },
    validated_at: NOW,
  });
  const lifecycle = advanceToCommitting(makePreparedLifecycle(artifact.artifact_hash));
  let approvals = 0;
  let acceptances = 0;
  await assert.rejects(
    commitPreparedArtifact({
      capsule,
      fork_identity: identity,
      lifecycle,
      artifact,
      destruction_evidence: destructionEvidence(forkRef),
      expected_parent_state_hash: capsule.parent.state_hash,
      current_parent_state_hash: hash('parent-state-drifted'),
      verifyCommitApproval: async (request) => {
        approvals += 1;
        return exactApproval(request);
      },
      acceptTypedResult: async () => {
        acceptances += 1;
      },
      now: NOW,
    }),
    /Parent state changed after savepoint/,
  );
  assert.equal(approvals, 0);
  assert.equal(acceptances, 0);
});

test('typed-result commit claims allow exactly one concurrent acceptor call', async () => {
  const temporary = await mkdtemp(path.join(os.tmpdir(), 'risk-fork-typed-claim-test-'));
  try {
    const schema = closedResultSchema();
    const capsule = makeCapsule({
      result_schema: schema,
      allowed_commit_types: ['TYPED_RESULT'],
    });
    const identity = makeForkIdentity(capsule);
    const forkRef = 'fork:typed-concurrent';
    const artifact = validateCommitCandidate({
      candidate: {
        type: 'TYPED_RESULT',
        payload: { answer: 'accepted-once' },
        payload_schema: schema,
      },
      source_fork_id: forkRef,
      policy: { typed_result_schema_hash: capsule.authorized_result_schema_hash },
      validated_at: NOW,
    });
    const lifecycle = advanceToCommitting(makePreparedLifecycle(artifact.artifact_hash));
    const store = await new FileAuthorizationClaimStore({
      directory: path.join(temporary, 'claims'),
      clock: () => new Date(NOW),
    }).initialize();
    let acceptorCalls = 0;
    let releaseAcceptor;
    let markAcceptorEntered;
    const acceptorGate = new Promise((resolve) => { releaseAcceptor = resolve; });
    const acceptorEntered = new Promise((resolve) => { markAcceptorEntered = resolve; });
    const input = {
      capsule,
      fork_identity: identity,
      lifecycle,
      artifact,
      destruction_evidence: destructionEvidence(forkRef),
      expected_parent_state_hash: capsule.parent.state_hash,
      current_parent_state_hash: capsule.parent.state_hash,
      verifyCommitApproval: async (request) => exactApproval(request),
      commitClaimStore: store,
      acceptTypedResult: async (payload) => {
        acceptorCalls += 1;
        markAcceptorEntered();
        await acceptorGate;
        return { accepted: payload.answer };
      },
      now: NOW,
    };

    const winner = commitPreparedArtifact(input);
    await acceptorEntered;
    const duplicate = commitPreparedArtifact(input);
    let duplicateError;
    try {
      duplicateError = await duplicate.then(() => null, (error) => error);
      assert.match(duplicateError?.message ?? '', /Artifact commit is (?:already_claimed|consumed)/);
      assert.equal(acceptorCalls, 1);
    } finally {
      releaseAcceptor();
    }
    const committed = await winner;
    assert.equal(committed.status, 'committed');
    assert.equal(committed.commit_claim.status, 'consumed');
    assert.equal(acceptorCalls, 1);
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
});

test('local reference adapter is an explicitly non-isolating disposable-copy simulator', async () => {
  const temporary = await mkdtemp(path.join(os.tmpdir(), 'risk-fork-local-test-'));
  const source = path.join(temporary, 'source');
  await mkdir(source);
  await writeFile(path.join(source, 'safe.txt'), 'parent-original', 'utf8');
  const adapter = new LocalReferenceRiskForkAdapter({
    baseDirectory: path.join(temporary, 'adapter'),
    clock: () => new Date(NOW),
    verifyAuthorityFreeSource: verifyLocalAuthorityFreeSource,
  });
  try {
    assert.equal(adapter.capabilities.isolation_class, 'local_reference_protocol_simulator');
    assert.equal(adapter.capabilities.containment_claim, 'not_isolation');
    assert.equal(adapter.capabilities.credentialed_provider_validation, 'not_applicable');
    await adapter.initialize();
    const inspected = await inspectLocalWorkspace({ source_workspace: source });
    const capsule = makeCapsule({
      workspace: { snapshot_ref: 'workspace:local', digest: inspected.workspace_digest },
    });
    const savepoint = await adapter.createSavepoint({ capsule, source_workspace: source });
    const fork = await adapter.createFork({
      savepoint_ref: savepoint.savepoint_ref,
      fork_identity: makeForkIdentity(capsule),
      network_policy: { mode: 'blocked' },
      ttl_ms: 60_000,
    });
    const execution = await adapter.executeInFork({
      fork_ref: fork.fork_ref,
      execution_mode: 'isolated_execution',
      operation: {
        kind: 'bounded_file_batch',
        actions: [{ type: 'write', path: 'safe.txt', content: 'fork-only-change' }],
        commit_candidate: {
          type: 'TYPED_RESULT',
          payload: { answer: 'prepared' },
          payload_schema: closedResultSchema(),
        },
      },
    });
    assert.equal(execution.taint_status, 'TAINTED');
    assert.equal(await readFile(path.join(source, 'safe.txt'), 'utf8'), 'parent-original');
    const diff = await adapter.collectDiff({ fork_ref: fork.fork_ref });
    assert.equal(diff.files.length, 1);
    assert.equal(diff.files[0].after_content, 'fork-only-change');
    await adapter.destroyFork({ fork_ref: fork.fork_ref });
    assert.equal((await adapter.verifyDestroyed({ fork_ref: fork.fork_ref })).status, 'verified');
    await adapter.destroySavepoint({ savepoint_ref: savepoint.savepoint_ref });
    assert.equal(
      (await adapter.verifySavepointDestroyed({ savepoint_ref: savepoint.savepoint_ref })).status,
      'verified',
    );
  } finally {
    await adapter.dispose();
    await rm(temporary, { recursive: true, force: true });
  }
});

test('local reference adapter lazily initializes an explicit base directory', async () => {
  const temporary = await mkdtemp(path.join(os.tmpdir(), 'risk-fork-local-lazy-test-'));
  const source = path.join(temporary, 'source');
  await mkdir(source);
  await writeFile(path.join(source, 'safe.txt'), 'parent-original', 'utf8');
  const adapter = new LocalReferenceRiskForkAdapter({
    baseDirectory: path.join(temporary, 'adapter'),
    clock: () => new Date(NOW),
    verifyAuthorityFreeSource: verifyLocalAuthorityFreeSource,
  });
  try {
    const inspected = await inspectLocalWorkspace({ source_workspace: source });
    const capsule = makeCapsule({
      workspace: { snapshot_ref: 'workspace:local', digest: inspected.workspace_digest },
    });
    const savepoint = await adapter.createSavepoint({ capsule, source_workspace: source });
    assert.match(savepoint.savepoint_ref, /^local-savepoint:/);
  } finally {
    await adapter.dispose();
    await rm(temporary, { recursive: true, force: true });
  }
});

class RecordingProvider extends RiskForkProvider {
  constructor() {
    super({
      id: 'provider:1',
      capabilities: {
        supports_filesystem_snapshot: true,
        supports_network_policy: true,
        supports_verified_destruction: true,
        isolation_class: 'recording_test_boundary',
        adapter_implementation: 'test_double',
        mock_conformance: 'passed',
        credentialed_provider_validation: 'not_run',
        containment_claim: 'not_verified',
      },
    });
    this.events = [];
    this.capsule = null;
    this.identity = null;
  }

  async createSavepoint({ capsule }) {
    this.events.push('create-savepoint');
    this.capsule = capsule;
    return { savepoint_ref: 'savepoint:1', savepoint_hash: hash('savepoint:1') };
  }

  async createFork({ fork_identity: forkIdentity }) {
    this.events.push('create-fork');
    this.identity = forkIdentity;
    return { fork_ref: 'fork:controller-1', fork_hash: hash('fork:controller-1') };
  }

  async getForkStatus() {
    return { status: 'ready' };
  }

  async executeInFork({ execution_mode: executionMode }) {
    this.events.push(`execute:${executionMode}`);
    return {
      result_hash: hash('prepared-action'),
      commit_candidate: {
        type: 'CONSEQUENTIAL_ACTION_PROPOSAL',
        action: {
          operation: 'payment',
          target_ref: this.capsule.proposed_interaction.target_ref,
          provider_ref: this.id,
          arguments: { value: 1 },
          amount: '1.25',
          currency: 'USDC',
          payment_rail: 'x402:base',
        },
      },
    };
  }

  async collectEvidence() {
    return { evidence_hash: hash('evidence') };
  }

  async collectDiff() {
    throw new Error('not used');
  }

  async suspendFork() {
    return { status: 'suspended' };
  }

  async destroyFork() {
    this.events.push('destroy-fork');
    return { status: 'destroy_requested_observed' };
  }

  async verifyDestroyed() {
    this.events.push('verify-fork-destroyed');
    return {
      status: 'verified',
      outcome: 'success',
      evidence_ref: 'fork-absence:evidence',
      evidence_hash: hash('fork-absence'),
    };
  }

  async destroySavepoint() {
    this.events.push('destroy-savepoint');
    return { status: 'destroy_requested_observed' };
  }

  async verifySavepointDestroyed() {
    this.events.push('verify-savepoint-destroyed');
    return {
      status: 'verified',
      outcome: 'success',
      evidence_ref: 'savepoint-absence:evidence',
      evidence_hash: hash('savepoint-absence'),
    };
  }
}

class ExecutionFailureProvider extends RecordingProvider {
  async executeInFork({ execution_mode: executionMode }) {
    this.events.push(`execute:${executionMode}`);
    throw new Error('synthetic fork execution failure');
  }
}

class AllocateThenThrowProvider extends RecordingProvider {
  async createFork({ fork_identity: forkIdentity }) {
    this.events.push('create-fork');
    this.identity = forkIdentity;
    const error = new Error('provider allocated a fork but lost the response');
    error.code = 'FORK_ALLOCATION_RESPONSE_LOST';
    throw error;
  }
}

function highRiskPrepareInput(capsule, overrides = {}) {
  const input = {
    risk_input: {
      mcp_phase: capsule.proposed_interaction.mcp_method,
      mcp_server_ref: capsule.proposed_interaction.mcp_server_ref,
      mcp_server_origin: capsule.proposed_interaction.mcp_server_origin,
      mcp_server_trust: 'verified',
      tool_name: capsule.proposed_interaction.tool_name,
      tool_annotations: { openWorldHint: false },
      capabilities: { filesystem_write: true },
    },
    capsule,
    savepoint_input: {},
    operation: { kind: 'prepare-typed-result' },
    effective_arguments: { value: 1 },
    expected_commit_type: 'TYPED_RESULT',
    commit_policy: { typed_result_schema_hash: capsule.authorized_result_schema_hash },
    fork_ttl_ms: 60_000,
    network_policy: { mode: 'blocked' },
  };
  return {
    ...input,
    ...overrides,
    risk_input: { ...input.risk_input, ...(overrides.risk_input ?? {}) },
  };
}

test('controller preparation failures persist terminal cleanup states', async (t) => {
  await t.test('verified cleanup ends DESTROYED', async () => {
    const provider = new ExecutionFailureProvider();
    const capsule = makeCapsule({ allowed_commit_types: ['TYPED_RESULT'] });
    const controller = new RiskForkController({
      provider,
      mode: 'demonstration',
      clock: () => new Date(NOW),
    });
    const error = await controller.prepare(highRiskPrepareInput(capsule))
      .then(() => null, (caught) => caught);
    assert.equal(error?.code, 'RISK_FORK_PREPARATION_FAILED');
    assert.equal(error.evidence.lifecycle.state, 'DESTROYED');
    assert.equal(error.evidence.lifecycle.fork_resource_state, 'DESTROYED');
    assert.equal(error.evidence.lifecycle.events.at(-1).evidence.status, 'verified');
    assert.deepEqual(provider.events, [
      'create-savepoint',
      'create-fork',
      'execute:isolated_execution',
      'destroy-fork',
      'verify-fork-destroyed',
      'destroy-savepoint',
      'verify-savepoint-destroyed',
    ]);
  });

  await t.test('allocate-then-throw without a fork ref ends DESTRUCTION_UNKNOWN', async () => {
    const provider = new AllocateThenThrowProvider();
    const capsule = makeCapsule({ allowed_commit_types: ['TYPED_RESULT'] });
    const controller = new RiskForkController({
      provider,
      mode: 'demonstration',
      clock: () => new Date(NOW),
    });
    const error = await controller.prepare(highRiskPrepareInput(capsule))
      .then(() => null, (caught) => caught);
    assert.equal(error?.code, 'RISK_FORK_PREPARATION_FAILED');
    assert.equal(error.evidence.lifecycle.state, 'DESTRUCTION_UNKNOWN');
    assert.equal(error.evidence.lifecycle.fork_resource_state, 'DESTROY_UNKNOWN');
    assert.equal(error.evidence.cleanup.fork_request, null);
    assert.equal(error.evidence.cleanup.fork_verification, null);
    assert.deepEqual(provider.events, [
      'create-savepoint',
      'create-fork',
      'destroy-savepoint',
      'verify-savepoint-destroyed',
    ]);
  });
});

test('owner egress and capsule commit policy fail before provider creation', async (t) => {
  await t.test('owner egress allowlist mismatch', async () => {
    const provider = new RecordingProvider();
    const capsule = makeCapsule({ allowed_commit_types: ['TYPED_RESULT'] });
    const controller = new RiskForkController({
      provider,
      mode: 'demonstration',
      clock: () => new Date(NOW),
    });
    await assert.rejects(
      controller.prepare(highRiskPrepareInput(capsule, {
        risk_input: {
          owner_policy: { allowed_egress: ['https://approved.example/'] },
        },
        network_policy: {
          mode: 'allowlist',
          allowlist: ['https://unapproved.example/'],
        },
      })),
      /outside the owner-approved allowlist/,
    );
    assert.deepEqual(provider.events, []);
  });

  await t.test('requested commit type is not allowed by the capsule', async () => {
    const provider = new RecordingProvider();
    const capsule = makeCapsule({ allowed_commit_types: ['TYPED_RESULT'] });
    const controller = new RiskForkController({
      provider,
      mode: 'demonstration',
      clock: () => new Date(NOW),
    });
    await assert.rejects(
      controller.prepare(highRiskPrepareInput(capsule, {
        expected_commit_type: 'WORKSPACE_DIFF',
      })),
      /commit type is not authorized by the Savepoint Capsule/,
    );
    assert.deepEqual(provider.events, []);
  });
});

test('controller rejects governance-drifted factory bindings before fork execution', async (t) => {
  for (const field of ['policy_version', 'mandate_version']) {
    await t.test(field, async () => {
      const provider = new RecordingProvider();
      const capsule = makeCapsule();
      const controller = new RiskForkController({
        provider,
        mode: 'demonstration',
        clock: () => new Date(NOW),
      });
      const error = await controller.prepare({
        risk_input: {
          mcp_phase: capsule.proposed_interaction.mcp_method,
          mcp_server_ref: capsule.proposed_interaction.mcp_server_ref,
          mcp_server_origin: capsule.proposed_interaction.mcp_server_origin,
          mcp_server_trust: 'verified',
          tool_name: capsule.proposed_interaction.tool_name,
          tool_annotations: { openWorldHint: false },
          capabilities: { wallet_or_payment: true },
        },
        capsule,
        savepoint_input: {},
        operation: { kind: 'prepare-payment' },
        effective_arguments: { value: 1 },
        expected_commit_type: 'CONSEQUENTIAL_ACTION_PROPOSAL',
        fork_ttl_ms: 60_000,
        network_policy: { mode: 'blocked' },
        createExecutionBinding: async ({
          capsule: cleanCapsule,
          fork_identity: identity,
        }) => makeBinding({
          capsule: cleanCapsule,
          identity,
          provider_ref: provider.id,
          [field]: `${field}:drifted`,
        }),
      }).then(() => null, (caught) => caught);

      assert.equal(error?.code, 'RISK_FORK_PREPARATION_FAILED');
      assert.equal(error.evidence.lifecycle.state, 'DESTROYED');
      assert.deepEqual(provider.events, [
        'create-savepoint',
        'create-fork',
        'destroy-fork',
        'verify-fork-destroyed',
        'destroy-savepoint',
        'verify-savepoint-destroyed',
      ]);
    });
  }
});

test('controller prepares irreversible work only, destroys the fork, then clean-commits', async () => {
  const temporary = await mkdtemp(path.join(os.tmpdir(), 'risk-fork-controller-test-'));
  try {
    const provider = new RecordingProvider();
    const capsule = makeCapsule();
    const controller = new RiskForkController({
      provider,
      mode: 'demonstration',
      clock: () => new Date(NOW),
    });
    const prepared = await controller.prepare({
      risk_input: {
        mcp_phase: capsule.proposed_interaction.mcp_method,
        mcp_server_ref: capsule.proposed_interaction.mcp_server_ref,
        mcp_server_origin: capsule.proposed_interaction.mcp_server_origin,
        mcp_server_trust: 'verified',
        tool_name: capsule.proposed_interaction.tool_name,
        tool_annotations: { openWorldHint: false },
        capabilities: { wallet_or_payment: true },
      },
      capsule,
      savepoint_input: {},
      operation: { kind: 'prepare-payment' },
      effective_arguments: { value: 1 },
      expected_commit_type: 'CONSEQUENTIAL_ACTION_PROPOSAL',
      fork_ttl_ms: 60_000,
      network_policy: { mode: 'blocked' },
      createExecutionBinding: async ({ capsule: cleanCapsule, fork_identity: identity }) => (
        makeBinding({
          capsule: cleanCapsule,
          identity,
          provider_ref: provider.id,
          action_operation: 'payment',
          amount: '1.25',
          currency: 'USDC',
          payment_rail: 'x402:base',
        })
      ),
    });
    assert.equal(prepared.risk_decision.level, 'IRREVERSIBLE');
    assert.equal(prepared.mode, 'prepared_for_clean_commit');
    assert.equal(prepared.lifecycle.state, 'CLEAN_COMMIT_READY');
    assert.equal(prepared.lifecycle.fork_resource_state, 'DESTROYED');
    assert.deepEqual(provider.events, [
      'create-savepoint',
      'create-fork',
      'execute:prepare_only',
      'destroy-fork',
      'verify-fork-destroyed',
      'destroy-savepoint',
      'verify-savepoint-destroyed',
    ]);

    const store = await new FileAuthorizationClaimStore({
      directory: path.join(temporary, 'claims'),
      clock: () => new Date(NOW),
    }).initialize();
    let cleanExecutions = 0;
    const committed = await controller.commit(prepared, {
      expected_parent_state_hash: capsule.parent.state_hash,
      current_parent_state_hash: capsule.parent.state_hash,
      verifyCommitApproval: async (request) => exactApproval(request),
      verifyExecutionAuthorization: async (request) => exactExecutionAuthorization(request),
      authorizationClaimStore: store,
      expected_binding: {
        policy_version: capsule.governance.policy_version,
        mandate_version: capsule.governance.mandate_version,
      },
      executeAction: async () => {
        provider.events.push('clean-execute-action');
        cleanExecutions += 1;
        return { settlement_ref: 'settlement:1' };
      },
    });
    assert.equal(cleanExecutions, 1);
    assert.equal(committed.status, 'committed');
    assert.equal(committed.lifecycle.state, 'COMMITTED');
    assert.ok(
      provider.events.indexOf('clean-execute-action')
        > provider.events.indexOf('verify-savepoint-destroyed'),
    );
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
});

function receiptClaim(status, outcome, name) {
  if (status === 'not_applicable') return { status, outcome };
  return {
    status,
    outcome,
    evidence_ref: `${name}:evidence`,
    evidence_hash: hash(`${name}:evidence`),
  };
}

function makeTypedReceiptFixture(forkRef) {
  const schema = closedResultSchema();
  const capsule = makeCapsule({ result_schema: schema });
  const identity = makeForkIdentity(capsule);
  const artifact = validateCommitCandidate({
    candidate: {
      type: 'TYPED_RESULT',
      payload: { answer: 'safe' },
      payload_schema: schema,
    },
    source_fork_id: forkRef,
    policy: { typed_result_schema_hash: capsule.authorized_result_schema_hash },
    validated_at: NOW,
  });
  const lifecycle = makePreparedLifecycle(artifact.artifact_hash);
  const taintedEvent = lifecycle.events.find((event) => event.to === 'TAINTED');
  assert.ok(taintedEvent?.evidence.hash);
  return {
    capsule,
    lifecycle,
    input: {
      created_at: NOW,
      capsule,
      risk_decision: classifyRisk({
        mcp_phase: capsule.proposed_interaction.mcp_method,
        mcp_server_ref: capsule.proposed_interaction.mcp_server_ref,
        mcp_server_origin: capsule.proposed_interaction.mcp_server_origin,
        mcp_server_trust: 'unknown',
        tool_name: capsule.proposed_interaction.tool_name,
        tool_annotations: { openWorldHint: true },
        capabilities: { filesystem_write: true },
      }),
      lifecycle,
      fork_identity: identity,
      fork_ref: artifact.source_fork_id,
      provider_ref: 'provider:1',
      provider_capabilities_hash: hash('provider-capabilities'),
      savepoint_claim: receiptClaim('verified', 'success', 'savepoint'),
      fork_start_claim: receiptClaim('observed', 'success', 'fork-start'),
      execution_claim: receiptClaim('observed', 'success', 'execution'),
      result_digest: taintedEvent.evidence.hash,
      commit_artifact: artifact,
      accepted_commit_digest: null,
      validation_evidence_refs: ['validation:evidence'],
      credential_revocation_claim: receiptClaim(
        'not_applicable',
        'not_applicable',
        'revocation',
      ),
      destruction_claim: receiptClaim('verified', 'success', 'destruction'),
      destruction_evidence: destructionEvidence(artifact.source_fork_id),
      transaction_assurance_evidence_refs: ['ta:evidence'],
      measurements: { total_ms: 10, file_count: 0 },
    },
  };
}

test('receipts exclude raw private context and detect ordinary tampering', () => {
  const { capsule, input } = makeTypedReceiptFixture('fork:receipt-1');
  const receipt = createRiskForkReceipt(input);
  assert.equal(verifyRiskForkReceipt(receipt), true);
  const serialized = JSON.stringify(receipt);
  assert.doesNotMatch(serialized, new RegExp(capsule.parent.agent_id));
  assert.doesNotMatch(serialized, new RegExp(capsule.parent.session_id));
  assert.doesNotMatch(serialized, new RegExp(capsule.proposed_interaction.mcp_server_origin));
  assert.equal(receipt.privacy.raw_prompt_excluded, true);
  assert.equal(receipt.authority_flags.can_spend, false);

  const tampered = clone(receipt);
  tampered.measurements.total_ms += 1;
  assert.throws(() => verifyRiskForkReceipt(tampered), /receipt hash mismatch/);
});

test('receipt creation cross-binds execution and accepted commit digests', () => {
  const fixture = makeTypedReceiptFixture('fork:receipt-digests');
  assert.throws(
    () => createRiskForkReceipt({
      ...fixture.input,
      result_digest: hash('mismatched-execution-result'),
    }),
    /Receipt result digest differs from the lifecycle execution result/,
  );

  let committedLifecycle = advanceToCommitting(fixture.lifecycle);
  const acceptedDigest = hash('accepted-clean-commit-result');
  committedLifecycle = transitionLifecycle(committedLifecycle, {
    actor: 'clean_controller',
    expected_version: committedLifecycle.version,
    expected_chain_head: committedLifecycle.chain_head,
    to: 'COMMITTED',
    at: NOW,
    reason: 'clean_commit_succeeded',
    evidence: {
      status: 'verified',
      ref: 'commit:accepted-result',
      hash: acceptedDigest,
      detail: 'accepted_commit_result',
    },
  });
  const committedInput = {
    ...fixture.input,
    lifecycle: committedLifecycle,
    accepted_commit_digest: acceptedDigest,
  };
  const receipt = createRiskForkReceipt(committedInput);
  assert.equal(receipt.commit.accepted_digest, acceptedDigest);
  assert.throws(
    () => createRiskForkReceipt({
      ...committedInput,
      accepted_commit_digest: hash('mismatched-accepted-result'),
    }),
    /Accepted commit digest differs from the lifecycle commit result/,
  );
});

test('receipt verification reasserts every privacy and no-authority invariant', async (t) => {
  const { input } = makeTypedReceiptFixture('fork:receipt-invariants');
  const receipt = createRiskForkReceipt(input);

  await t.test('privacy flags', () => {
    const invalid = clone(receipt);
    invalid.privacy.raw_prompt_excluded = false;
    invalid.receipt_hash = hash({ ...invalid, receipt_hash: null });
    assert.throws(
      () => verifyRiskForkReceipt(invalid),
      /security invariants|privacy|authority/,
    );
  });
  await t.test('no-authority flags', () => {
    const invalid = clone(receipt);
    invalid.authority_flags.can_spend = true;
    invalid.receipt_hash = hash({ ...invalid, receipt_hash: null });
    assert.throws(
      () => verifyRiskForkReceipt(invalid),
      /security invariants|privacy|authority/,
    );
  });
});
