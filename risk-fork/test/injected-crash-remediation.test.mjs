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
  commitPreparedArtifact,
  deriveParentAuthorityRef,
  isCommitAmbiguousError,
} from '../src/clean-commit.mjs';
import { RiskForkCommitError, RiskForkController, RiskForkPreparationError } from '../src/controller.mjs';
import {
  DistributedAuthorityAmbiguousError,
  getDistributedAuthorityAmbiguityEvidence,
} from '../src/distributed-authority.mjs';
import {
  RiskForkProvider,
  createCleanupVerificationEvidence,
} from '../src/provider.mjs';
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

  async verifyDestroyed(input) {
    this.#attempt('verifyDestroyed');
    return createCleanupVerificationEvidence(input.cleanup_request, {
      status: 'verified',
      outcome: 'success',
      observed_at: NOW,
      evidence_ref: 'fork-absence:injected-crash',
      observation_hash: hash('fork-absence:injected-crash'),
    });
  }

  async destroySavepoint() {
    this.#attempt('destroySavepoint');
    return { status: 'destroy_requested_observed' };
  }

  async verifySavepointDestroyed(input) {
    this.#attempt('verifySavepointDestroyed');
    return createCleanupVerificationEvidence(input.cleanup_request, {
      status: 'verified',
      outcome: 'success',
      observed_at: NOW,
      evidence_ref: 'savepoint-absence:injected-crash',
      observation_hash: hash('savepoint-absence:injected-crash'),
    });
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
  assert.equal(error.evidence.cause_code, 'RISK_FORK_SAVEPOINT_STAGE_FAILED');
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
  assert.equal(error.evidence.cause_code, 'RISK_FORK_FORK_STAGE_FAILED');
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

async function expectAmbiguous(prepared, input) {
  const error = await commitPreparedArtifact({
    ...input,
    capsule: prepared.capsule,
    fork_identity: prepared.fork_identity,
    lifecycle: advanceToCommitting(prepared.lifecycle),
    artifact: prepared.artifact,
    destruction_evidence: prepared.destruction_evidence,
  }, { clock: () => new Date(NOW) }).then(
    () => null,
    (caught) => caught,
  );
  assert.equal(error?.code, 'RISK_FORK_COMMIT_AMBIGUOUS');
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
    makeController(new InjectedCrashProvider());
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

    await expectAmbiguous(prepared, input);
    assert.equal(
      (await authority.parentStateTransaction.getParentHead(authority.parentRef)).status,
      'ambiguous',
    );
    assert.equal(mutationEffects, 0);
    await expectAmbiguous(prepared, input);
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
    makeController(new InjectedCrashProvider());
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

    await expectAmbiguous(prepared, input);
    assert.equal(
      (await readAuthorizationState(authority.authorizationDirectory, prepared.binding)).status,
      'ambiguous',
    );
    assert.equal(executionEffects, 0);
    await expectAmbiguous(prepared, input);
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
    makeController(new InjectedCrashProvider());
    const input = typedCommitInput(
      prepared,
      governance,
      authority.parentStateTransaction,
      async () => {
        mutationAttempts += 1;
        throw new Error('injected typed-result mutation crash');
      },
    );

    await expectAmbiguous(prepared, input);
    assert.equal(
      (await authority.parentStateTransaction.getParentHead(authority.parentRef)).status,
      'ambiguous',
    );
    assert.equal(mutationAttempts, 1);
    await expectAmbiguous(prepared, input);
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
    makeController(new InjectedCrashProvider());
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

    await expectAmbiguous(prepared, input);
    assert.equal(
      (await readAuthorizationState(authority.authorizationDirectory, prepared.binding)).status,
      'ambiguous',
    );
    assert.equal(executionAttempts, 1);
    await expectAmbiguous(prepared, input);
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
    makeController(new InjectedCrashProvider());
    const input = typedCommitInput(
      prepared,
      governance,
      authority.parentStateTransaction,
      async () => {
        mutationAttempts += 1;
        return { accepted: true, injected_unserializable_result: 1n };
      },
    );

    await expectAmbiguous(prepared, input);
    assert.equal(
      (await authority.parentStateTransaction.getParentHead(authority.parentRef)).status,
      'ambiguous',
    );
    assert.equal(mutationAttempts, 1);
    await expectAmbiguous(prepared, input);
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
    makeController(new InjectedCrashProvider());
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

    await expectAmbiguous(prepared, input);
    assert.equal(
      (await readAuthorizationState(authority.authorizationDirectory, prepared.binding)).status,
      'consuming',
    );
    assert.equal(executionAttempts, 1);
    await expectAmbiguous(prepared, input);
    assert.equal(executionAttempts, 1);
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
});

function thrownFixture(kind) {
  let touches = 0;
  const touch = () => { touches += 1; throw new Error('fixture trap reached'); };
  let value;
  if (kind === 'revoked-proxy') {
    const revocable = Proxy.revocable({}, {});
    value = revocable.proxy;
    revocable.revoke();
  } else if (kind === 'proxy') {
    value = new Proxy({}, {
      get: touch, getPrototypeOf: touch, getOwnPropertyDescriptor: touch, ownKeys: touch,
    });
  } else if (kind === 'getters') {
    value = new Error('fixture-private-error-text');
    for (const key of ['code', 'name', 'message', 'toString', Symbol.toPrimitive]) {
      Object.defineProperty(value, key, { get: touch });
    }
  } else if (kind === 'coercion') {
    value = { code: { [Symbol.toPrimitive]: touch }, name: 'fixture-private-error-text' };
  } else if (kind === 'abort') {
    value = new DOMException('fixture-private-error-text', 'AbortError');
  } else if (kind === 'ambiguous-error') {
    value = new CommitAmbiguousError('fixture-private-error-text', { status: 'consuming' });
    Object.defineProperty(value, 'evidence', { get: touch });
  } else if (kind === 'preparation-error') {
    value = new RiskForkPreparationError('fixture-private-error-text', {});
  } else if (kind === 'primitive') {
    value = 'fixture-private-error-text';
  } else {
    value = Object.assign(new Error('fixture-private-error-text'), {
      code: 'fixture-private-error-text',
    });
  }
  return { value, touches: () => touches };
}

const THROWN_KINDS = ['proxy', 'revoked-proxy', 'getters', 'coercion', 'abort', 'ambiguous-error', 'preparation-error', 'primitive', 'error'];

for (const kind of THROWN_KINDS) {
  test(`cleanup catches ${kind} without inspecting it, skipping verification, or duplicating destruction`, async () => {
    for (const failingMethod of ['destroyFork', 'verifyDestroyed', 'destroySavepoint', 'verifySavepointDestroyed']) {
      const fixture = thrownFixture(kind);
      const provider = new InjectedCrashProvider();
      for (const verifyMethod of ['verifyDestroyed', 'verifySavepointDestroyed']) {
        provider[verifyMethod] = async (input) => {
          provider.counts[verifyMethod] += 1;
          return createCleanupVerificationEvidence(input.cleanup_request, {
            status: 'unknown', observed_at: NOW, observation_hash: hash('unconfirmed-absence'),
          });
        };
      }
      provider[failingMethod] = async () => {
        provider.counts[failingMethod] += 1;
        throw fixture.value;
      };
      const capsule = makeCapsule({ allowed_commit_types: ['TYPED_RESULT'] });
      const error = await capturePreparationError(makeController(provider), prepareInput(capsule));
      assert.equal(fixture.touches(), 0, failingMethod);
      assert.equal(error?.code, 'RISK_FORK_PREPARATION_FAILED', failingMethod);
      assert.equal(error.evidence.lifecycle.state, 'DESTRUCTION_UNKNOWN');
      for (const method of ['destroyFork', 'verifyDestroyed', 'destroySavepoint', 'verifySavepointDestroyed']) {
        assert.equal(provider.counts[method], 1, `${failingMethod}: ${method}`);
      }
      assert.equal(JSON.stringify(error).includes('fixture-private-error-text'), false);
    }
  });

  test(`execution throwing ${kind} cannot bypass resource cleanup or export exception content`, async () => {
    const fixture = thrownFixture(kind);
    const provider = new InjectedCrashProvider();
    provider.executeInFork = async () => {
      provider.counts.executeInFork += 1;
      throw fixture.value;
    };
    const capsule = makeCapsule({ allowed_commit_types: ['TYPED_RESULT'] });
    const error = await capturePreparationError(makeController(provider), prepareInput(capsule));
    assert.equal(fixture.touches(), 0);
    assert.equal(error?.code, 'RISK_FORK_PREPARATION_FAILED');
    assert.equal(error.evidence.cause_code, 'RISK_FORK_EXECUTION_STAGE_FAILED');
    assert.equal(error.evidence.lifecycle.state, 'DESTROYED');
    for (const method of ['destroyFork', 'verifyDestroyed', 'destroySavepoint', 'verifySavepointDestroyed']) {
      assert.equal(provider.counts[method], 1, method);
    }
    assert.equal(JSON.stringify(error).includes('fixture-private-error-text'), false);
  });

  for (const action of [false, true]) {
    test(`${action ? 'action' : 'typed result'} throwing ${kind} persists redacted ambiguity and cannot replay`, async () => {
      const temporary = await mkdtemp(path.join(os.tmpdir(), 'risk-fork-hostile-throw-'));
      try {
        const fixture = thrownFixture(kind);
        const prepared = action ? actionPrepared() : typedPrepared();
        const governance = currentGovernance(prepared.capsule, action ? {} : {
          typed_result_schema_hash: prepared.capsule.authorized_result_schema_hash,
        });
        const authority = await provisionCommitAuthorities({
          directory: temporary, prepared, governance, binding: action ? prepared.binding : null,
        });
        let effects = 0;
        const effect = async () => { effects += 1; throw fixture.value; };
        const input = action
          ? actionCommitInput(prepared, governance, authority.parentStateTransaction,
            authority.executionAuthorizationTransaction, effect)
          : typedCommitInput(prepared, governance, authority.parentStateTransaction, effect);
        const error = await expectAmbiguous(prepared, input);
        if (kind === 'ambiguous-error') assert.equal(Object.hasOwn(error.evidence, 'status'), false);
        assert.equal(fixture.touches(), 0);
        const parent = await authority.parentStateTransaction.getParentHead(authority.parentRef);
        assert.equal(parent.status, 'ambiguous');
        assert.equal(parent.pending_transaction.failure, 'parent_effect_unconfirmed');
        if (action) {
          const authorization = await readAuthorizationState(authority.authorizationDirectory, prepared.binding);
          assert.equal(authorization.status, 'ambiguous');
          assert.equal(authorization.failure, 'authorized_effect_unconfirmed');
          assert.equal(JSON.stringify(authorization).includes('fixture-private-error-text'), false);
        }
        assert.equal(JSON.stringify(parent).includes('fixture-private-error-text'), false);
        assert.equal(JSON.stringify(error).includes('fixture-private-error-text'), false);
        await expectAmbiguous(prepared, input);
        assert.equal(effects, 1);
        assert.equal(fixture.touches(), 0);
      } finally {
        await rm(temporary, { recursive: true, force: true });
      }
    });
  }
}

test('pre-effect proxy rejection is wrapped safely without entering a parent effect', async () => {
  const fixture = thrownFixture('proxy');
  const provider = new InjectedCrashProvider();
  const capsule = makeCapsule({ allowed_commit_types: ['TYPED_RESULT'] });
  const controller = makeController(provider);
  const prepared = await controller.prepare(prepareInput(capsule));
  const temporary = await mkdtemp(path.join(os.tmpdir(), 'risk-fork-pre-effect-throw-'));
  try {
    const governance = currentGovernance(capsule, {
      typed_result_schema_hash: capsule.authorized_result_schema_hash,
    });
    const authority = await provisionCommitAuthorities({ directory: temporary, prepared, governance });
    let effects = 0;
    const error = await controller.commit(prepared, {
      ...typedCommitInput(prepared, governance, authority.parentStateTransaction, async () => {
        effects += 1; return { accepted: true };
      }),
      resolveCurrentGovernance: async () => { throw fixture.value; },
    }).catch((caught) => caught);
    assert.equal(fixture.touches(), 0);
    assert.equal(error.code, 'RISK_FORK_COMMIT_FAILED');
    assert.equal(error.cause_code, 'RISK_FORK_CLEAN_COMMIT_FAILED');
    assert.equal(error.lifecycle.state, 'COMMIT_FAILED');
    assert.equal((await authority.parentStateTransaction.getParentHead(authority.parentRef)).status, 'active');
    assert.equal(effects, 0);
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
});

test('hostile savepoint/fork creation throws preserve ambiguous custody and clean known resources', async () => {
  for (const method of ['createSavepoint', 'createFork']) {
    const fixture = thrownFixture('proxy');
    const provider = new InjectedCrashProvider();
    provider[method] = async () => { provider.counts[method] += 1; throw fixture.value; };
    const capsule = makeCapsule({ allowed_commit_types: ['TYPED_RESULT'] });
    const error = await capturePreparationError(makeController(provider), prepareInput(capsule));
    assert.equal(fixture.touches(), 0);
    assert.equal(error.code, 'RISK_FORK_PREPARATION_FAILED');
    assert.equal(error.evidence.lifecycle.state, 'DESTRUCTION_UNKNOWN');
    assert.equal(error.evidence.cause_code, method === 'createSavepoint'
      ? 'RISK_FORK_SAVEPOINT_STAGE_FAILED' : 'RISK_FORK_FORK_STAGE_FAILED');
    assert.equal(provider.counts.executeInFork, 0);
    assert.equal(provider.counts.destroyFork, 0);
    assert.equal(provider.counts.destroySavepoint, method === 'createFork' ? 1 : 0);
    assert.equal(provider.counts.verifySavepointDestroyed, method === 'createFork' ? 1 : 0);
  }
});

test('private ambiguity identities reject prototypes/proxies and do not read mutable error fields', () => {
  const fixture = thrownFixture('proxy');
  for (const value of [fixture.value, Object.create(CommitAmbiguousError.prototype), null, 'error']) {
    assert.equal(isCommitAmbiguousError(value), false);
    assert.equal(new RiskForkCommitError('closed wrapper', { lifecycle: null, cause: value }).code,
      'RISK_FORK_COMMIT_FAILED');
  }
  const genuine = new CommitAmbiguousError('fixture-private-error-text', {});
  Object.setPrototypeOf(genuine, fixture.value);
  assert.equal(isCommitAmbiguousError(genuine), true);
  const wrapped = new RiskForkCommitError('closed wrapper', { lifecycle: null, cause: genuine });
  assert.equal(wrapped.code, 'RISK_FORK_COMMIT_AMBIGUOUS');
  assert.equal(wrapped.cause_code, 'RISK_FORK_COMMIT_AMBIGUOUS');
  assert.equal(JSON.stringify(wrapped).includes('fixture-private-error-text'), false);
  const distributed = new DistributedAuthorityAmbiguousError('closed message', {
    operation_ref: 'operation:fixture',
  });
  Object.defineProperty(distributed, 'evidence', { get() { throw fixture.value; } });
  assert.deepEqual(getDistributedAuthorityAmbiguityEvidence(distributed), {
    operation_ref: 'operation:fixture',
  });
  assert.equal(Object.isFrozen(getDistributedAuthorityAmbiguityEvidence(distributed)), true);
  assert.equal(getDistributedAuthorityAmbiguityEvidence(fixture.value), null);
  assert.equal(getDistributedAuthorityAmbiguityEvidence(Object.create(DistributedAuthorityAmbiguousError.prototype)), null);
  assert.equal(fixture.touches(), 0);
});

test('hostile serialization after a completed effect remains ambiguous and redacted', async () => {
  const fixture = thrownFixture('proxy');
  const temporary = await mkdtemp(path.join(os.tmpdir(), 'risk-fork-return-throw-'));
  try {
    const prepared = typedPrepared();
    const governance = currentGovernance(prepared.capsule, {
      typed_result_schema_hash: prepared.capsule.authorized_result_schema_hash,
    });
    const authority = await provisionCommitAuthorities({ directory: temporary, prepared, governance });
    let effects = 0;
    const input = typedCommitInput(prepared, governance, authority.parentStateTransaction, async () => {
      effects += 1;
      return { get toJSON() { throw fixture.value; } };
    });
    await expectAmbiguous(prepared, input);
    const parent = await authority.parentStateTransaction.getParentHead(authority.parentRef);
    assert.equal(parent.status, 'ambiguous');
    assert.equal(parent.pending_transaction.failure, 'parent_effect_unconfirmed');
    assert.equal(fixture.touches(), 0);
    await expectAmbiguous(prepared, input);
    assert.equal(effects, 1);
    assert.equal(fixture.touches(), 0);
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
});

test('execution rejection with unconfirmed cleanup cannot claim absence or clean-commit readiness', async () => {
  const fixture = thrownFixture('proxy');
  const provider = new InjectedCrashProvider();
  provider.executeInFork = async () => { provider.counts.executeInFork += 1; throw fixture.value; };
  for (const method of ['verifyDestroyed', 'verifySavepointDestroyed']) {
    provider[method] = async (input) => {
      provider.counts[method] += 1;
      return createCleanupVerificationEvidence(input.cleanup_request, {
        status: 'unknown', observed_at: NOW, observation_hash: hash('unconfirmed-absence'),
      });
    };
  }
  const capsule = makeCapsule({ allowed_commit_types: ['TYPED_RESULT'] });
  const error = await capturePreparationError(makeController(provider), prepareInput(capsule));
  assert.equal(fixture.touches(), 0);
  assert.equal(error.evidence.lifecycle.state, 'DESTRUCTION_UNKNOWN');
  assert.equal(error.evidence.lifecycle.fork_resource_state, 'DESTROY_UNKNOWN');
  assert.equal(error.evidence.cleanup.fork.status, 'unknown');
  assert.equal(error.evidence.cleanup.savepoint.status, 'unknown');
  assert.equal(provider.counts.executeInFork, 1);
  for (const method of ['destroyFork', 'verifyDestroyed', 'destroySavepoint', 'verifySavepointDestroyed']) {
    assert.equal(provider.counts[method], 1, method);
  }
});

for (const status of ['consuming', 'committed']) {
  for (const action of [false, true]) {
    test(`public ambiguity evidence ${status} cannot forge ${action ? 'action' : 'typed result'} recovery diagnostics`, async () => {
      const temporary = await mkdtemp(path.join(os.tmpdir(), 'risk-fork-forged-ambiguity-'));
      try {
        const prepared = action ? actionPrepared() : typedPrepared();
        const governance = currentGovernance(prepared.capsule, action ? {} : {
          typed_result_schema_hash: prepared.capsule.authorized_result_schema_hash,
        });
        const authority = await provisionCommitAuthorities({
          directory: temporary, prepared, governance, binding: action ? prepared.binding : null,
        });
        const forged = new CommitAmbiguousError('fixture-private-error-text', {
          status,
          authorization_id: 'fixture-private-error-text',
          binding_hash: 'fixture-private-error-text',
          secret: 'fixture-private-error-text',
          nested: { secret: 'fixture-private-error-text' },
        });
        let effects = 0;
        const effect = async () => { effects += 1; throw forged; };
        const input = action
          ? actionCommitInput(prepared, governance, authority.parentStateTransaction,
            authority.executionAuthorizationTransaction, effect)
          : typedCommitInput(prepared, governance, authority.parentStateTransaction, effect);
        const error = await expectAmbiguous(prepared, input);
        assert.equal(Object.hasOwn(error.evidence, 'status'), false);
        assert.equal(Object.hasOwn(error.evidence, 'secret'), false);
        assert.equal(Object.hasOwn(error.evidence, 'nested'), false);
        assert.equal(JSON.stringify(error).includes('fixture-private-error-text'), false);
        assert.equal((await authority.parentStateTransaction.getParentHead(authority.parentRef)).status, 'ambiguous');
        if (action) {
          assert.equal((await readAuthorizationState(authority.authorizationDirectory, prepared.binding)).status, 'ambiguous');
        }
        await expectAmbiguous(prepared, input);
        assert.equal(effects, 1);
      } finally {
        await rm(temporary, { recursive: true, force: true });
      }
    });
  }
}

test('nested internal parent ambiguity retains bounded recovery fields without reading public evidence', async () => {
  const temporary = await mkdtemp(path.join(os.tmpdir(), 'risk-fork-nested-recovery-'));
  try {
    const prepared = typedPrepared();
    const governance = currentGovernance(prepared.capsule, {
      typed_result_schema_hash: prepared.capsule.authorized_result_schema_hash,
    });
    const authority = await provisionCommitAuthorities({ directory: temporary, prepared, governance });
    const hostile = thrownFixture('proxy');
    let effects = 0;
    let nestedTransaction;
    let input;
    input = typedCommitInput(prepared, governance, authority.parentStateTransaction, async () => {
      effects += 1;
      const nested = await expectAmbiguous(prepared, input);
      assert.equal(isCommitAmbiguousError(nested), true);
      assert.equal(nested.evidence.parent_state_status, 'committing');
      nestedTransaction = nested.evidence.pending_transaction.transaction_ref;
      Object.defineProperty(nested, 'evidence', { get() { throw hostile.value; } });
      throw nested;
    });
    const error = await expectAmbiguous(prepared, input);
    assert.equal(error.evidence.parent_state_status, 'committing');
    assert.equal(error.evidence.pending_transaction.transaction_ref, nestedTransaction);
    assert.equal(hostile.touches(), 0);
    await expectAmbiguous(prepared, input);
    assert.equal(effects, 1);
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
});
