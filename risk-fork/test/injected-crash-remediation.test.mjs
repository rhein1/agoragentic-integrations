import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { PostgresDistributedCommitAuthority } from '../src/adapters/postgres-authority.mjs';
import {
  CommitAmbiguousError,
  FileExecutionAuthorizationTransaction,
  FileParentHeadTransaction,
  deriveParentAuthorityRef,
} from '../src/clean-commit.mjs';
import { RiskForkController } from '../src/controller.mjs';
import { RiskForkProvider } from '../src/provider.mjs';
import { validateCommitCandidate } from '../src/taint-gate.mjs';
import {
  NOW,
  closedResultSchema,
  hash,
  makeBinding,
  makeCapsule,
  makeForkIdentity,
  makePreparedLifecycle,
} from './helpers.mjs';

const TEST_CA = [
  '-----BEGIN CERTIFICATE-----',
  'contract-only-ca',
  '-----END CERTIFICATE-----',
].join('\n');

class InjectedCrashProvider extends RiskForkProvider {
  constructor({ crashAt = null } = {}) {
    super({
      id: 'provider:1',
      capabilities: {
        supports_filesystem_snapshot: true,
        supports_network_policy: true,
        supports_verified_destruction: true,
        supports_hard_ttl: true,
        supports_idle_ttl: true,
        supports_max_execution_time: true,
        child_credentials_mode: 'prohibited',
        isolation_class: 'injected_crash_test_boundary',
        adapter_implementation: 'test_double',
        mock_conformance: 'passed',
        credentialed_provider_validation: 'passed',
        containment_claim: 'verified',
      },
    });
    this.crashAt = crashAt;
    this.counts = {
      createSavepoint: 0,
      createFork: 0,
      executeInFork: 0,
      destroyFork: 0,
      verifyDestroyed: 0,
      destroySavepoint: 0,
      verifySavepointDestroyed: 0,
    };
  }

  #attempt(name) {
    this.counts[name] += 1;
    if (this.crashAt === name) {
      const error = new Error(`injected crash at ${name}`);
      error.code = `INJECTED_${name.replace(/[A-Z]/g, (letter) => `_${letter}`).toUpperCase()}_CRASH`;
      throw error;
    }
  }

  async createSavepoint() {
    this.#attempt('createSavepoint');
    return {
      savepoint_ref: 'savepoint:injected-crash',
      savepoint_hash: hash('savepoint:injected-crash'),
    };
  }

  async createFork() {
    this.#attempt('createFork');
    return {
      fork_ref: 'fork:injected-crash',
      fork_hash: hash('fork:injected-crash'),
    };
  }

  async getForkStatus() {
    return { status: 'ready' };
  }

  async executeInFork() {
    this.#attempt('executeInFork');
    return {
      result_hash: hash('typed-result:injected-crash'),
      commit_candidate: {
        type: 'TYPED_RESULT',
        payload: { answer: 'prepared' },
        payload_schema: closedResultSchema(),
      },
    };
  }

  async collectEvidence() {
    return { evidence_hash: hash('evidence:injected-crash') };
  }

  async collectDiff() {
    throw new Error('collectDiff is not used by the injected-crash fixture');
  }

  async suspendFork() {
    return { status: 'suspended' };
  }

  async destroyFork() {
    this.#attempt('destroyFork');
    return { status: 'destroy_requested_observed' };
  }

  async verifyDestroyed() {
    this.#attempt('verifyDestroyed');
    return {
      status: 'verified',
      outcome: 'success',
      evidence_ref: 'fork-absence:injected-crash',
      evidence_hash: hash('fork-absence:injected-crash'),
    };
  }

  async destroySavepoint() {
    this.#attempt('destroySavepoint');
    return { status: 'destroy_requested_observed' };
  }

  async verifySavepointDestroyed() {
    this.#attempt('verifySavepointDestroyed');
    return {
      status: 'verified',
      outcome: 'success',
      evidence_ref: 'savepoint-absence:injected-crash',
      evidence_hash: hash('savepoint-absence:injected-crash'),
    };
  }
}

function prepareInput(capsule) {
  return {
    risk_input: {
      mcp_phase: capsule.proposed_interaction.mcp_method,
      mcp_server_ref: capsule.proposed_interaction.mcp_server_ref,
      mcp_server_origin: capsule.proposed_interaction.mcp_server_origin,
      mcp_server_trust: 'unknown',
      tool_name: capsule.proposed_interaction.tool_name,
      tool_annotations: { openWorldHint: false },
      capabilities: { filesystem_write: true },
    },
    capsule,
    savepoint_input: {},
    operation: { kind: 'prepare-typed-result' },
    effective_arguments: { value: 1 },
    expected_commit_type: 'TYPED_RESULT',
    commit_policy: {
      typed_result_schema_hash: capsule.authorized_result_schema_hash,
    },
    fork_ttl_ms: 60_000,
    idle_ttl_ms: 30_000,
    max_execution_ms: 30_000,
    network_policy: { mode: 'blocked' },
  };
}

function makeController(provider, overrides = {}) {
  return new RiskForkController({
    provider,
    mode: 'demonstration',
    clock: () => new Date(NOW),
    ...overrides,
  });
}

async function capturePreparationError(controller, input) {
  return controller.prepare(input).then(
    () => null,
    (error) => error,
  );
}

test('injected provider admission crash blocks before any resource allocation attempt', async () => {
  const provider = new InjectedCrashProvider();
  const capsule = makeCapsule({ allowed_commit_types: ['TYPED_RESULT'] });
  const distributedCommitAuthority = new PostgresDistributedCommitAuthority({
    connectionString: 'postgresql://runtime:secret@db.internal/risk_fork',
    deploymentMode: 'production',
    migrationMode: 'verify-only',
    tls: { ca: TEST_CA },
  });
  let profileAttempts = 0;
  const controller = makeController(provider, {
    mode: 'production',
    distributedCommitAuthority,
    distributedClaimantRef: 'claimant:provider-admission-crash',
    verifyProviderProfile: async () => {
      profileAttempts += 1;
      const error = new Error('injected provider-profile allocation crash');
      error.code = 'INJECTED_PROVIDER_ALLOCATION_CRASH';
      throw error;
    },
  });

  const error = await capturePreparationError(controller, prepareInput(capsule));

  assert.equal(error?.code, 'INJECTED_PROVIDER_ALLOCATION_CRASH');
  assert.equal(profileAttempts, 1);
  assert.deepEqual(provider.counts, {
    createSavepoint: 0,
    createFork: 0,
    executeInFork: 0,
    destroyFork: 0,
    verifyDestroyed: 0,
    destroySavepoint: 0,
    verifySavepointDestroyed: 0,
  });
});

test('injected savepoint-creation crash is terminally blocked with unknown destruction and no retry', async () => {
  const provider = new InjectedCrashProvider({ crashAt: 'createSavepoint' });
  const capsule = makeCapsule({ allowed_commit_types: ['TYPED_RESULT'] });
  const error = await capturePreparationError(
    makeController(provider),
    prepareInput(capsule),
  );

  assert.equal(error?.code, 'RISK_FORK_PREPARATION_FAILED');
  assert.equal(error.evidence.cause_code, 'INJECTED_CREATE_SAVEPOINT_CRASH');
  assert.equal(error.evidence.lifecycle.state, 'DESTRUCTION_UNKNOWN');
  assert.equal(error.evidence.lifecycle.fork_resource_state, 'DESTROY_UNKNOWN');
  assert.equal(provider.counts.createSavepoint, 1);
  assert.equal(provider.counts.createFork, 0);
  assert.equal(provider.counts.executeInFork, 0);
  assert.equal(provider.counts.destroySavepoint, 0);
});

test('injected fork-creation crash blocks with unknown fork absence and cleans the known savepoint once', async () => {
  const provider = new InjectedCrashProvider({ crashAt: 'createFork' });
  const capsule = makeCapsule({ allowed_commit_types: ['TYPED_RESULT'] });
  const error = await capturePreparationError(
    makeController(provider),
    prepareInput(capsule),
  );

  assert.equal(error?.code, 'RISK_FORK_PREPARATION_FAILED');
  assert.equal(error.evidence.cause_code, 'INJECTED_CREATE_FORK_CRASH');
  assert.equal(error.evidence.lifecycle.state, 'DESTRUCTION_UNKNOWN');
  assert.equal(error.evidence.lifecycle.fork_resource_state, 'DESTROY_UNKNOWN');
  assert.equal(provider.counts.createSavepoint, 1);
  assert.equal(provider.counts.createFork, 1);
  assert.equal(provider.counts.executeInFork, 0);
  assert.equal(provider.counts.destroyFork, 0);
  assert.equal(provider.counts.destroySavepoint, 1);
  assert.equal(provider.counts.verifySavepointDestroyed, 1);
});

test('injected cleanup-verification crash blocks commit and does not silently retry cleanup', async () => {
  const provider = new InjectedCrashProvider({ crashAt: 'verifyDestroyed' });
  const capsule = makeCapsule({ allowed_commit_types: ['TYPED_RESULT'] });
  const error = await capturePreparationError(
    makeController(provider),
    prepareInput(capsule),
  );

  assert.equal(error?.code, 'RISK_FORK_PREPARATION_FAILED');
  assert.equal(error.evidence.lifecycle.state, 'DESTRUCTION_UNKNOWN');
  assert.equal(error.evidence.lifecycle.fork_resource_state, 'DESTROY_UNKNOWN');
  assert.equal(provider.counts.executeInFork, 1);
  assert.equal(provider.counts.destroyFork, 1);
  assert.equal(provider.counts.verifyDestroyed, 1);
  assert.equal(provider.counts.destroySavepoint, 1);
  assert.equal(provider.counts.verifySavepointDestroyed, 1);
});

function exactApproval(request) {
  return {
    schema: 'agoragentic.risk-fork.clean-commit-approval-verification.v1',
    status: 'verified',
    request_hash: request.request_hash,
    artifact_hash: request.artifact_hash,
    capsule_hash: request.capsule_hash,
    parent_state_hash: request.parent_state_hash,
    governance_hash: request.governance_hash,
    governance_evidence_ref: request.governance_evidence_ref,
    governance_evidence_hash: request.governance_evidence_hash,
    evidence_ref: 'approval:injected-crash',
    evidence_hash: hash('approval:injected-crash'),
  };
}

function destructionEvidence(forkRef) {
  return {
    status: 'verified',
    provider_ref: 'provider:1',
    fork_ref: forkRef,
    evidence_ref: 'destruction:injected-crash',
    evidence_hash: hash('destruction:injected-crash'),
  };
}

function currentGovernance(capsule, commitPolicy = {}) {
  return {
    policy: {
      ref: capsule.governance.policy_ref,
      version: capsule.governance.policy_version,
      hash: capsule.governance.policy_hash,
    },
    mandate: {
      ref: capsule.governance.mandate_ref,
      version: capsule.governance.mandate_version,
      hash: capsule.governance.mandate_hash,
    },
    budget_policy: {
      ref: capsule.governance.budget_policy_ref,
      version: capsule.governance.budget_version,
      hash: capsule.governance.budget_hash,
      usage_hash: hash('budget-usage:injected-crash'),
      available_amount: '100.00',
      currency: 'USDC',
      payment_rail: 'x402:base',
    },
    epoch: capsule.governance.epoch,
    commit_policy: commitPolicy,
    evidence_ref: 'governance:injected-crash',
    evidence_hash: hash('governance:injected-crash'),
  };
}

function typedPrepared() {
  const schema = closedResultSchema();
  const capsule = makeCapsule({
    result_schema: schema,
    allowed_commit_types: ['TYPED_RESULT'],
  });
  const identity = makeForkIdentity(capsule);
  const forkRef = 'fork:typed-injected-crash';
  const artifact = validateCommitCandidate({
    candidate: {
      type: 'TYPED_RESULT',
      payload: { answer: 'prepared' },
      payload_schema: schema,
    },
    source_fork_id: forkRef,
    policy: { typed_result_schema_hash: capsule.authorized_result_schema_hash },
    validated_at: NOW,
  });
  return {
    mode: 'prepared_for_clean_commit',
    capsule,
    fork_identity: identity,
    artifact,
    lifecycle: makePreparedLifecycle(artifact.artifact_hash),
    destruction_evidence: destructionEvidence(forkRef),
  };
}

function actionPrepared() {
  const capsule = makeCapsule({
    allowed_commit_types: ['CONSEQUENTIAL_ACTION_PROPOSAL'],
  });
  const identity = makeForkIdentity(capsule);
  const binding = makeBinding({
    capsule,
    identity,
    action_operation: 'payment',
    provider_ref: 'provider:1',
    amount: '1.25',
    currency: 'USDC',
    payment_rail: 'x402:base',
  });
  const forkRef = 'fork:action-injected-crash';
  const artifact = validateCommitCandidate({
    candidate: {
      type: 'CONSEQUENTIAL_ACTION_PROPOSAL',
      action: {
        operation: 'payment',
        target_ref: binding.target_ref,
        provider_ref: binding.provider_ref,
        arguments: { value: 1 },
        amount: binding.commercial.amount,
        currency: binding.commercial.currency,
        payment_rail: binding.commercial.payment_rail,
      },
    },
    source_fork_id: forkRef,
    execution_binding: binding,
    validated_at: NOW,
  });
  return {
    mode: 'prepared_for_clean_commit',
    capsule,
    fork_identity: identity,
    binding,
    artifact,
    lifecycle: makePreparedLifecycle(artifact.artifact_hash),
    destruction_evidence: destructionEvidence(forkRef),
  };
}

function exactExecutionAuthorization(request) {
  return {
    schema: 'agoragentic.risk-fork.execution-authorization-integrity-verification.v1',
    status: 'verified',
    request_hash: request.request_hash,
    authorization_ref: request.authorization_ref,
    authorization_hash: request.authorization_hash,
    authorization_id: request.authorization_id,
    binding_hash: request.binding_hash,
    signature_status: 'verified',
    integrity_status: 'verified',
    exact_binding_status: 'verified',
    evidence_ref: 'authorization:injected-crash',
    evidence_hash: hash('authorization:injected-crash'),
  };
}

async function provisionCommitAuthorities({
  directory,
  prepared,
  governance,
  binding = null,
}) {
  const parentRef = deriveParentAuthorityRef({
    agent_id: prepared.capsule.parent.agent_id,
    session_id: prepared.capsule.parent.session_id,
  });
  const parentStateTransaction = await new FileParentHeadTransaction({
    directory: path.join(directory, 'parent-authority'),
    clock: () => new Date(NOW),
  }).initialize();
  await parentStateTransaction.seedParentHead({
    parentRef,
    headHash: prepared.capsule.parent.state_hash,
  });
  await parentStateTransaction.setCurrentGovernance({
    parent_ref: parentRef,
    governance,
  });
  await parentStateTransaction.registerCommitApproval({
    parent_ref: parentRef,
    artifact_hash: prepared.artifact.artifact_hash,
    capsule_hash: prepared.capsule.capsule_hash,
    parent_state_hash: prepared.capsule.parent.state_hash,
    commit_type: prepared.artifact.commit_type,
    governance_hash: hash(governance),
    evidence_ref: 'approval:injected-crash',
    evidence_hash: hash('approval:injected-crash'),
  });

  let executionAuthorizationTransaction = null;
  let authorizationDirectory = null;
  if (binding) {
    authorizationDirectory = path.join(directory, 'execution-authority');
    executionAuthorizationTransaction = await new FileExecutionAuthorizationTransaction({
      directory: authorizationDirectory,
      clock: () => new Date(NOW),
      verifyAuthorizationIntegrity: exactExecutionAuthorization,
    }).initialize();
    await executionAuthorizationTransaction.registerExecutionAuthorization({
      authorization_id: binding.one_use_authorization_id,
      authorization_ref: binding.authorization_ref,
      authorization_hash: binding.authorization_hash,
      binding_hash: binding.binding_hash,
      expires_at: binding.validity.expires_at,
      evidence_ref: 'authorization:injected-crash',
      evidence_hash: hash('authorization:injected-crash'),
    });
  }
  return {
    parentRef,
    parentStateTransaction,
    executionAuthorizationTransaction,
    authorizationDirectory,
  };
}

async function readAuthorizationState(directory, binding) {
  const file = path.join(
    directory,
    `${hash(binding.one_use_authorization_id).slice(7)}.execution-authorization.json`,
  );
  return JSON.parse(await readFile(file, 'utf8'));
}

function typedCommitInput(prepared, governance, parentStateTransaction, acceptTypedResult) {
  return {
    expected_parent_state_hash: prepared.capsule.parent.state_hash,
    parentStateTransaction,
    resolveCurrentGovernance: async () => governance,
    verifyCommitApproval: async (request) => exactApproval(request),
    acceptTypedResult,
  };
}

function actionCommitInput(
  prepared,
  governance,
  parentStateTransaction,
  executionAuthorizationTransaction,
  executeAction,
) {
  return {
    expected_parent_state_hash: prepared.capsule.parent.state_hash,
    parentStateTransaction,
    executionAuthorizationTransaction,
    resolveCurrentGovernance: async () => governance,
    verifyCommitApproval: async (request) => exactApproval(request),
    executeAction,
  };
}

async function expectAmbiguous(controller, prepared, input) {
  const error = await controller.commit(prepared, input).then(
    () => null,
    (caught) => caught,
  );
  assert.equal(error?.code, 'RISK_FORK_COMMIT_AMBIGUOUS');
  assert.equal(error.lifecycle.state, 'COMMIT_AMBIGUOUS');
  assert.equal(error.lifecycle.events.at(-1).evidence.status, 'unknown');
  return error;
}

test('injected parent-head reservation crash is COMMIT_AMBIGUOUS and cannot enter mutation on retry', async () => {
  const temporary = await mkdtemp(path.join(os.tmpdir(), 'risk-fork-parent-reservation-crash-'));
  try {
    const prepared = typedPrepared();
    const governance = currentGovernance(prepared.capsule, {
      typed_result_schema_hash: prepared.capsule.authorized_result_schema_hash,
      max_typed_result_bytes: 1_000,
    });
    const authority = await provisionCommitAuthorities({
      directory: temporary,
      prepared,
      governance,
    });
    let mutationEffects = 0;
    let injectCrash = true;
    const controller = makeController(new InjectedCrashProvider());
    const input = typedCommitInput(
      prepared,
      governance,
      authority.parentStateTransaction,
      async () => {
        if (injectCrash) {
          injectCrash = false;
          throw new CommitAmbiguousError('injected crash at the reserved parent effect boundary', {
            artifact_hash: prepared.artifact.artifact_hash,
          });
        }
        mutationEffects += 1;
        return { accepted: true };
      },
    );

    await expectAmbiguous(controller, prepared, input);
    assert.equal(
      (await authority.parentStateTransaction.getParentHead(authority.parentRef)).status,
      'ambiguous',
    );
    assert.equal(mutationEffects, 0);
    await expectAmbiguous(controller, prepared, input);
    assert.equal(mutationEffects, 0);
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
});

test('injected authorization-consumption crash is COMMIT_AMBIGUOUS and never executes on retry', async () => {
  const temporary = await mkdtemp(path.join(os.tmpdir(), 'risk-fork-auth-reservation-crash-'));
  try {
    const prepared = actionPrepared();
    const governance = currentGovernance(prepared.capsule);
    const authority = await provisionCommitAuthorities({
      directory: temporary,
      prepared,
      governance,
      binding: prepared.binding,
    });
    let executionEffects = 0;
    let injectCrash = true;
    const controller = makeController(new InjectedCrashProvider());
    const input = actionCommitInput(
      prepared,
      governance,
      authority.parentStateTransaction,
      authority.executionAuthorizationTransaction,
      async () => {
        if (injectCrash) {
          injectCrash = false;
          throw new CommitAmbiguousError('injected crash at authorization execution admission', {
            authorization_id: prepared.binding.one_use_authorization_id,
          });
        }
        executionEffects += 1;
        return { accepted: true };
      },
    );

    await expectAmbiguous(controller, prepared, input);
    assert.equal(
      (await readAuthorizationState(authority.authorizationDirectory, prepared.binding)).status,
      'ambiguous',
    );
    assert.equal(executionEffects, 0);
    await expectAmbiguous(controller, prepared, input);
    assert.equal(executionEffects, 0);
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
});

test('injected parent mutation crash is COMMIT_AMBIGUOUS and mutation is attempted exactly once', async () => {
  const temporary = await mkdtemp(path.join(os.tmpdir(), 'risk-fork-parent-mutation-crash-'));
  try {
    const prepared = typedPrepared();
    const governance = currentGovernance(prepared.capsule, {
      typed_result_schema_hash: prepared.capsule.authorized_result_schema_hash,
      max_typed_result_bytes: 1_000,
    });
    const authority = await provisionCommitAuthorities({
      directory: temporary,
      prepared,
      governance,
    });
    let mutationAttempts = 0;
    const controller = makeController(new InjectedCrashProvider());
    const input = typedCommitInput(
      prepared,
      governance,
      authority.parentStateTransaction,
      async () => {
        mutationAttempts += 1;
        throw new Error('injected typed-result mutation crash');
      },
    );

    await expectAmbiguous(controller, prepared, input);
    assert.equal(
      (await authority.parentStateTransaction.getParentHead(authority.parentRef)).status,
      'ambiguous',
    );
    assert.equal(mutationAttempts, 1);
    await expectAmbiguous(controller, prepared, input);
    assert.equal(mutationAttempts, 1);
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
});

test('injected external-action crash is COMMIT_AMBIGUOUS and execution is attempted exactly once', async () => {
  const temporary = await mkdtemp(path.join(os.tmpdir(), 'risk-fork-action-execution-crash-'));
  try {
    const prepared = actionPrepared();
    const governance = currentGovernance(prepared.capsule);
    const authority = await provisionCommitAuthorities({
      directory: temporary,
      prepared,
      governance,
      binding: prepared.binding,
    });
    let executionAttempts = 0;
    const controller = makeController(new InjectedCrashProvider());
    const input = actionCommitInput(
      prepared,
      governance,
      authority.parentStateTransaction,
      authority.executionAuthorizationTransaction,
      async () => {
        executionAttempts += 1;
        throw new Error('injected external execution crash');
      },
    );

    await expectAmbiguous(controller, prepared, input);
    assert.equal(
      (await readAuthorizationState(authority.authorizationDirectory, prepared.binding)).status,
      'ambiguous',
    );
    assert.equal(executionAttempts, 1);
    await expectAmbiguous(controller, prepared, input);
    assert.equal(executionAttempts, 1);
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
});

test('injected parent finalization crash is COMMIT_AMBIGUOUS after one completed mutation and forbids replay', async () => {
  const temporary = await mkdtemp(path.join(os.tmpdir(), 'risk-fork-parent-finalization-crash-'));
  try {
    const prepared = typedPrepared();
    const governance = currentGovernance(prepared.capsule, {
      typed_result_schema_hash: prepared.capsule.authorized_result_schema_hash,
      max_typed_result_bytes: 1_000,
    });
    const authority = await provisionCommitAuthorities({
      directory: temporary,
      prepared,
      governance,
    });
    let mutationAttempts = 0;
    const controller = makeController(new InjectedCrashProvider());
    const input = typedCommitInput(
      prepared,
      governance,
      authority.parentStateTransaction,
      async () => {
        mutationAttempts += 1;
        return { accepted: true, injected_unserializable_result: 1n };
      },
    );

    await expectAmbiguous(controller, prepared, input);
    assert.equal(
      (await authority.parentStateTransaction.getParentHead(authority.parentRef)).status,
      'ambiguous',
    );
    assert.equal(mutationAttempts, 1);
    await expectAmbiguous(controller, prepared, input);
    assert.equal(mutationAttempts, 1);
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
});

test('injected authorization finalization crash is COMMIT_AMBIGUOUS after one execution and forbids replay', async () => {
  const temporary = await mkdtemp(path.join(os.tmpdir(), 'risk-fork-auth-finalization-crash-'));
  try {
    const prepared = actionPrepared();
    const governance = currentGovernance(prepared.capsule);
    const authority = await provisionCommitAuthorities({
      directory: temporary,
      prepared,
      governance,
      binding: prepared.binding,
    });
    let executionAttempts = 0;
    const controller = makeController(new InjectedCrashProvider());
    const input = actionCommitInput(
      prepared,
      governance,
      authority.parentStateTransaction,
      authority.executionAuthorizationTransaction,
      async () => {
        executionAttempts += 1;
        return { accepted: true, injected_unserializable_result: 1n };
      },
    );

    await expectAmbiguous(controller, prepared, input);
    assert.equal(
      (await readAuthorizationState(authority.authorizationDirectory, prepared.binding)).status,
      'consuming',
    );
    assert.equal(executionAttempts, 1);
    await expectAmbiguous(controller, prepared, input);
    assert.equal(executionAttempts, 1);
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
});
