import assert from 'node:assert/strict';
import test from 'node:test';

import { RiskForkController } from '../src/controller.mjs';
import {
  REQUIRED_PROVIDER_METHODS,
  RiskForkProvider,
  createCleanupVerificationEvidence,
} from '../src/provider.mjs';
import {
  NOW,
  closedResultSchema,
  hash,
  makeCapsule,
} from './helpers.mjs';

function controllerProvider(resultSchema, executionOverrides = {}) {
  const provider = new RiskForkProvider({
    id: 'activation-contract-provider',
    capabilities: {
      supports_filesystem_snapshot: true,
      supports_network_policy: true,
      supports_verified_destruction: true,
      child_credentials_mode: 'prohibited',
      isolation_class: 'test_isolated',
      adapter_implementation: 'activation_test',
    },
  });
  provider.calls = [];
  for (const method of REQUIRED_PROVIDER_METHODS) {
    provider[method] = async (input) => {
      provider.calls.push({ method, input });
      throw new Error(`unexpected provider call: ${method}`);
    };
  }
  provider.createSavepoint = async (input) => {
    provider.calls.push({ method: 'createSavepoint', input });
    return { savepoint_ref: 'savepoint:activation', savepoint_hash: hash('savepoint') };
  };
  provider.createFork = async (input) => {
    provider.calls.push({ method: 'createFork', input });
    return { fork_ref: 'fork:activation', fork_hash: hash('fork') };
  };
  provider.executeInFork = async (input) => {
    provider.calls.push({ method: 'executeInFork', input });
    return {
      result_hash: hash('execution'),
      commit_candidate: {
        type: 'TYPED_RESULT',
        payload: { answer: 'prepared' },
        payload_schema: resultSchema,
      },
      ...executionOverrides,
    };
  };
  provider.destroyFork = async (input) => {
    provider.calls.push({ method: 'destroyFork', input });
    return { status: 'destroy_requested' };
  };
  provider.verifyDestroyed = async (input) => {
    provider.calls.push({ method: 'verifyDestroyed', input });
    return createCleanupVerificationEvidence(input.cleanup_request, {
      status: 'verified',
      outcome: 'success',
      observed_at: NOW,
      evidence_ref: 'absence:fork-activation',
      observation_hash: hash('fork-absence'),
    });
  };
  provider.destroySavepoint = async (input) => {
    provider.calls.push({ method: 'destroySavepoint', input });
    return { status: 'destroy_requested' };
  };
  provider.verifySavepointDestroyed = async (input) => {
    provider.calls.push({ method: 'verifySavepointDestroyed', input });
    return createCleanupVerificationEvidence(input.cleanup_request, {
      status: 'verified',
      outcome: 'success',
      observed_at: NOW,
      evidence_ref: 'absence:savepoint-activation',
      observation_hash: hash('savepoint-absence'),
    });
  };
  return provider;
}

function prepareInput(capsule, commitPolicy) {
  return {
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
    operation: { kind: 'analyze', subject_ref: 'opaque:activation' },
    effective_arguments: { value: 1 },
    expected_commit_type: 'TYPED_RESULT',
    ...(commitPolicy === undefined ? {} : { commit_policy: commitPolicy }),
    network_policy: { mode: 'blocked' },
  };
}

test('typed-result policy omission and mismatch fail before provider work', async () => {
  const resultSchema = closedResultSchema();
  const capsule = makeCapsule({
    result_schema: resultSchema,
    allowed_commit_types: ['TYPED_RESULT'],
  });

  for (const commitPolicy of [undefined, { typed_result_schema_hash: hash('wrong-schema') }]) {
    const provider = controllerProvider(resultSchema);
    const controller = new RiskForkController({
      provider,
      mode: 'demonstration',
      clock: () => new Date(NOW),
    });
    const input = prepareInput(capsule, commitPolicy);
    await assert.rejects(
      controller.prepare(input),
      /capsule-authorized schema hash|does not match the Savepoint Capsule/,
    );
    assert.equal(provider.calls.length, 0);
  }
});

test('prepared authority is controller-local, non-serializable, and one-use', async () => {
  const resultSchema = closedResultSchema();
  const capsule = makeCapsule({
    result_schema: resultSchema,
    allowed_commit_types: ['TYPED_RESULT'],
  });
  const provider = controllerProvider(resultSchema);
  const controller = new RiskForkController({
    provider,
    mode: 'demonstration',
    clock: () => new Date(NOW),
  });
  const input = prepareInput(capsule, {
    typed_result_schema_hash: capsule.authorized_result_schema_hash,
  });
  const prepared = await controller.prepare(input);
  const clone = JSON.parse(JSON.stringify(prepared));
  const otherController = new RiskForkController({
    provider,
    mode: 'demonstration',
    clock: () => new Date(NOW),
  });

  for (const [candidateController, candidate] of [
    [controller, clone],
    [controller, { ...prepared }],
    [controller, { mode: 'prepared_for_clean_commit' }],
    [otherController, prepared],
  ]) {
    await assert.rejects(
      candidateController.commit(candidate, {}),
      (error) => error?.code === 'RISK_FORK_PREPARED_PROVENANCE_INVALID',
    );
  }

  await assert.rejects(
    controller.commit(prepared, {}),
    (error) => error?.code === 'RISK_FORK_COMMIT_FAILED',
  );
  await assert.rejects(
    controller.commit(prepared, {}),
    (error) => error?.code === 'RISK_FORK_PREPARED_ALREADY_CONSUMED',
  );
});

test('controller rejects raw provider output at the mandatory import boundary and cleans up', async () => {
  const resultSchema = closedResultSchema();
  const capsule = makeCapsule({
    result_schema: resultSchema,
    allowed_commit_types: ['TYPED_RESULT'],
  });
  const provider = controllerProvider(resultSchema, {
    raw_tool_output: 'private child transcript',
  });
  const controller = new RiskForkController({
    provider,
    mode: 'demonstration',
    clock: () => new Date(NOW),
  });

  await assert.rejects(
    controller.prepare(prepareInput(capsule, {
      typed_result_schema_hash: capsule.authorized_result_schema_hash,
    })),
    (error) => error?.code === 'RISK_FORK_PREPARATION_FAILED'
      && error.evidence?.cause_code === 'RISK_FORK_IMPORT_ENVELOPE_DLP_REJECTED',
  );
  assert.equal(provider.calls.some(({ method }) => method === 'destroyFork'), true);
  assert.equal(provider.calls.some(({ method }) => method === 'verifyDestroyed'), true);
  assert.equal(provider.calls.some(({ method }) => method === 'destroySavepoint'), true);
  assert.equal(provider.calls.some(({ method }) => method === 'verifySavepointDestroyed'), true);
});
