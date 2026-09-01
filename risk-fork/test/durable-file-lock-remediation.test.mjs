import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  CommitAmbiguousError,
  FileExecutionAuthorizationTransaction,
  FileParentHeadTransaction,
  commitPreparedArtifact,
  deriveParentAuthorityRef,
} from '../src/clean-commit.mjs';
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

const CLEAN_COMMIT_MODULE_URL = new URL('../src/clean-commit.mjs', import.meta.url).href;
const APPROVAL_EVIDENCE_REF = 'approval:durable-file-lock';
const APPROVAL_EVIDENCE_HASH = hash(APPROVAL_EVIDENCE_REF);

function cleanApproval(request) {
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
    evidence_ref: APPROVAL_EVIDENCE_REF,
    evidence_hash: APPROVAL_EVIDENCE_HASH,
  };
}

function verifiedAuthorization(request) {
  return {
    schema: 'agoragentic.risk-fork.execution-authorization-integrity-verification.v1',
    status: 'verified',
    request_hash: request.request_hash,
    authorization_id: request.authorization_id,
    authorization_ref: request.authorization_ref,
    authorization_hash: request.authorization_hash,
    binding_hash: request.binding_hash,
    signature_status: 'verified',
    integrity_status: 'verified',
    exact_binding_status: 'verified',
    evidence_ref: 'authorization:trusted-durable-verifier',
    evidence_hash: hash('authorization:trusted-durable-verifier'),
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
      usage_hash: hash('budget-usage:durable-file-lock'),
      available_amount: '100.00',
      currency: 'USDC',
      payment_rail: 'x402:base',
    },
    epoch: capsule.governance.epoch,
    commit_policy: commitPolicy,
    evidence_ref: 'governance:durable-file-lock',
    evidence_hash: hash('governance:durable-file-lock'),
  };
}

function destruction(forkRef) {
  return {
    status: 'verified',
    provider_ref: 'provider:1',
    fork_ref: forkRef,
    evidence_ref: 'destruction:durable-file-lock',
    evidence_hash: hash('destruction:durable-file-lock'),
  };
}

function typedFixture(label) {
  const capsule = makeCapsule({ allowed_commit_types: ['TYPED_RESULT'] });
  const identity = makeForkIdentity(capsule);
  const forkRef = `fork:${label}`;
  const artifact = validateCommitCandidate({
    candidate: {
      type: 'TYPED_RESULT',
      payload: { answer: label },
      payload_schema: closedResultSchema(),
    },
    source_fork_id: forkRef,
    policy: { typed_result_schema_hash: capsule.authorized_result_schema_hash },
    validated_at: NOW,
  });
  return {
    capsule,
    identity,
    artifact,
    lifecycle: advanceToCommitting(makePreparedLifecycle(artifact.artifact_hash)),
    destruction_evidence: destruction(forkRef),
    governance: currentGovernance(capsule, {
      typed_result_schema_hash: capsule.authorized_result_schema_hash,
      max_typed_result_bytes: 1_000,
    }),
  };
}

function proposalFixture(label) {
  const capsule = makeCapsule({
    allowed_commit_types: ['CONSEQUENTIAL_ACTION_PROPOSAL'],
    execution_authorization: {
      ref: 'authorization-ref:1',
      hash: hash('authorization-record'),
    },
  });
  const identity = makeForkIdentity(capsule);
  const binding = makeBinding({ capsule, identity });
  const forkRef = `fork:${label}`;
  const artifact = validateCommitCandidate({
    candidate: {
      type: 'CONSEQUENTIAL_ACTION_PROPOSAL',
      action: {
        operation: binding.action_operation,
        target_ref: binding.target_ref,
        provider_ref: binding.provider_ref,
        arguments: { value: 1 },
      },
    },
    source_fork_id: forkRef,
    execution_binding: binding,
    validated_at: NOW,
  });
  return {
    capsule,
    identity,
    binding,
    artifact,
    lifecycle: advanceToCommitting(makePreparedLifecycle(artifact.artifact_hash)),
    destruction_evidence: destruction(forkRef),
    governance: currentGovernance(capsule),
  };
}

function authorizationRegistration(binding) {
  return {
    authorization_id: binding.one_use_authorization_id,
    authorization_ref: binding.authorization_ref,
    authorization_hash: binding.authorization_hash,
    binding_hash: binding.binding_hash,
    expires_at: binding.validity.expires_at,
    evidence_ref: 'authorization:durable-file-lock',
    evidence_hash: hash('authorization:durable-file-lock'),
  };
}

async function setupParentAuthority({ directory, fixture, clock = () => NOW }) {
  const parentRef = deriveParentAuthorityRef({
    agent_id: fixture.capsule.parent.agent_id,
    session_id: fixture.capsule.parent.session_id,
  });
  const transaction = await new FileParentHeadTransaction({ directory, clock }).initialize();
  await transaction.seedParentHead({
    parentRef,
    headHash: fixture.capsule.parent.state_hash,
  });
  await transaction.setCurrentGovernance({
    parent_ref: parentRef,
    governance: fixture.governance,
  });
  await transaction.registerCommitApproval({
    parent_ref: parentRef,
    artifact_hash: fixture.artifact.artifact_hash,
    capsule_hash: fixture.capsule.capsule_hash,
    parent_state_hash: fixture.capsule.parent.state_hash,
    commit_type: fixture.artifact.commit_type,
    governance_hash: hash(fixture.governance),
    evidence_ref: APPROVAL_EVIDENCE_REF,
    evidence_hash: APPROVAL_EVIDENCE_HASH,
  });
  return { parentRef, transaction };
}

async function setupAuthorizationAuthority({
  directory,
  fixture,
  clock = () => NOW,
  verifyAuthorizationIntegrity = verifiedAuthorization,
}) {
  const transaction = await new FileExecutionAuthorizationTransaction({
    directory,
    clock,
    verifyAuthorizationIntegrity,
  }).initialize();
  await transaction.registerExecutionAuthorization(authorizationRegistration(fixture.binding));
  return transaction;
}

function commitInput(fixture, parentStateTransaction, overrides = {}) {
  return {
    capsule: fixture.capsule,
    fork_identity: fixture.identity,
    lifecycle: fixture.lifecycle,
    artifact: fixture.artifact,
    destruction_evidence: fixture.destruction_evidence,
    expected_parent_state_hash: fixture.capsule.parent.state_hash,
    verifyCommitApproval: async (request) => cleanApproval(request),
    parentStateTransaction,
    resolveCurrentGovernance: async () => fixture.governance,
    ...overrides,
  };
}

function serializableCommitInput(fixture) {
  return {
    capsule: fixture.capsule,
    fork_identity: fixture.identity,
    lifecycle: fixture.lifecycle,
    artifact: fixture.artifact,
    destruction_evidence: fixture.destruction_evidence,
    expected_parent_state_hash: fixture.capsule.parent.state_hash,
  };
}

async function runChild(directory, name, payload, source, expectedExitCode) {
  const payloadPath = path.join(directory, `${name}.json`);
  await writeFile(payloadPath, `${JSON.stringify(payload)}\n`, 'utf8');
  const child = spawn(process.execPath, [
    '--input-type=module',
    '--eval',
    source,
    payloadPath,
  ], {
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  });
  let stdout = '';
  let stderr = '';
  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  child.stdout.on('data', (chunk) => { stdout += chunk; });
  child.stderr.on('data', (chunk) => { stderr += chunk; });
  const [exitCode, signal] = await once(child, 'exit');
  assert.equal(signal, null, stderr);
  assert.equal(exitCode, expectedExitCode, stderr);
  return { stdout, stderr };
}

async function exitedChildPid() {
  const child = spawn(process.execPath, [
    '--eval',
    'process.stdout.write(String(process.pid))',
  ], {
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  });
  let stdout = '';
  let stderr = '';
  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  child.stdout.on('data', (chunk) => { stdout += chunk; });
  child.stderr.on('data', (chunk) => { stderr += chunk; });
  const [exitCode, signal] = await once(child, 'exit');
  assert.equal(signal, null, stderr);
  assert.equal(exitCode, 0, stderr);
  const pid = Number.parseInt(stdout, 10);
  assert.ok(Number.isSafeInteger(pid) && pid > 0);
  return pid;
}

test('parent-head retry interprets a crash-persisted committing state before the leftover lock', async () => {
  const temporary = await mkdtemp(path.join(os.tmpdir(), 'risk-fork-parent-crash-lock-'));
  try {
    const fixture = typedFixture('parent-crash-lock');
    const { transaction } = await setupParentAuthority({ directory: temporary, fixture });
    await runChild(temporary, 'parent-crash-input', {
      module_url: CLEAN_COMMIT_MODULE_URL,
      directory: temporary,
      input: serializableCommitInput(fixture),
      governance: fixture.governance,
      approval_evidence_ref: APPROVAL_EVIDENCE_REF,
      approval_evidence_hash: APPROVAL_EVIDENCE_HASH,
      now: NOW.toISOString(),
    }, `
      import { readFile } from 'node:fs/promises';
      const payload = JSON.parse(await readFile(process.argv.at(-1), 'utf8'));
      const { FileParentHeadTransaction, commitPreparedArtifact } = await import(payload.module_url);
      const parentStateTransaction = await new FileParentHeadTransaction({
        directory: payload.directory,
        clock: () => new Date(payload.now),
      }).initialize();
      await commitPreparedArtifact({
        ...payload.input,
        parentStateTransaction,
        resolveCurrentGovernance: async () => payload.governance,
        verifyCommitApproval: async (request) => ({
          schema: 'agoragentic.risk-fork.clean-commit-approval-verification.v1',
          status: 'verified',
          request_hash: request.request_hash,
          artifact_hash: request.artifact_hash,
          capsule_hash: request.capsule_hash,
          parent_state_hash: request.parent_state_hash,
          governance_hash: request.governance_hash,
          governance_evidence_ref: request.governance_evidence_ref,
          governance_evidence_hash: request.governance_evidence_hash,
          evidence_ref: payload.approval_evidence_ref,
          evidence_hash: payload.approval_evidence_hash,
        }),
        acceptTypedResult: () => process.exit(91),
      }, { clock: () => new Date(payload.now) });
    `, 91);

    let mutations = 0;
    const error = await commitPreparedArtifact(commitInput(fixture, transaction, {
      acceptTypedResult: () => {
        mutations += 1;
        return { duplicate: true };
      },
    }), { clock: () => NOW }).then(() => null, (caught) => caught);
    assert.ok(error instanceof CommitAmbiguousError);
    assert.equal(error.code, 'RISK_FORK_COMMIT_AMBIGUOUS');
    assert.equal(error.evidence.parent_state_status, 'committing');
    assert.ok(error.evidence.pending_transaction?.transaction_ref);
    assert.equal(mutations, 0);
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
});

test('authorization retry interprets a crash-persisted consuming state before the leftover lock', async () => {
  const temporary = await mkdtemp(path.join(os.tmpdir(), 'risk-fork-auth-crash-lock-'));
  try {
    const fixture = proposalFixture('authorization-crash-lock');
    const childParentDirectory = path.join(temporary, 'child-parent');
    const retryParentDirectory = path.join(temporary, 'retry-parent');
    const authorizationDirectory = path.join(temporary, 'authorization');
    await setupParentAuthority({ directory: childParentDirectory, fixture });
    const executionAuthorizationTransaction = await setupAuthorizationAuthority({
      directory: authorizationDirectory,
      fixture,
    });
    await runChild(temporary, 'authorization-crash-input', {
      module_url: CLEAN_COMMIT_MODULE_URL,
      parent_directory: childParentDirectory,
      authorization_directory: authorizationDirectory,
      input: serializableCommitInput(fixture),
      governance: fixture.governance,
      approval_evidence_ref: APPROVAL_EVIDENCE_REF,
      approval_evidence_hash: APPROVAL_EVIDENCE_HASH,
      verifier_evidence_ref: 'authorization:trusted-durable-verifier',
      verifier_evidence_hash: hash('authorization:trusted-durable-verifier'),
      now: NOW.toISOString(),
    }, `
      import { readFile } from 'node:fs/promises';
      const payload = JSON.parse(await readFile(process.argv.at(-1), 'utf8'));
      const {
        FileExecutionAuthorizationTransaction,
        FileParentHeadTransaction,
        commitPreparedArtifact,
      } = await import(payload.module_url);
      const parentStateTransaction = await new FileParentHeadTransaction({
        directory: payload.parent_directory,
        clock: () => new Date(payload.now),
      }).initialize();
      const executionAuthorizationTransaction = await new FileExecutionAuthorizationTransaction({
        directory: payload.authorization_directory,
        clock: () => new Date(payload.now),
        verifyAuthorizationIntegrity: async (request) => ({
          schema: 'agoragentic.risk-fork.execution-authorization-integrity-verification.v1',
          status: 'verified',
          request_hash: request.request_hash,
          authorization_id: request.authorization_id,
          authorization_ref: request.authorization_ref,
          authorization_hash: request.authorization_hash,
          binding_hash: request.binding_hash,
          signature_status: 'verified',
          integrity_status: 'verified',
          exact_binding_status: 'verified',
          evidence_ref: payload.verifier_evidence_ref,
          evidence_hash: payload.verifier_evidence_hash,
        }),
      }).initialize();
      await commitPreparedArtifact({
        ...payload.input,
        parentStateTransaction,
        executionAuthorizationTransaction,
        resolveCurrentGovernance: async () => payload.governance,
        verifyCommitApproval: async (request) => ({
          schema: 'agoragentic.risk-fork.clean-commit-approval-verification.v1',
          status: 'verified',
          request_hash: request.request_hash,
          artifact_hash: request.artifact_hash,
          capsule_hash: request.capsule_hash,
          parent_state_hash: request.parent_state_hash,
          governance_hash: request.governance_hash,
          governance_evidence_ref: request.governance_evidence_ref,
          governance_evidence_hash: request.governance_evidence_hash,
          evidence_ref: payload.approval_evidence_ref,
          evidence_hash: payload.approval_evidence_hash,
        }),
        executeAction: () => process.exit(92),
      }, { clock: () => new Date(payload.now) });
    `, 92);

    const { transaction: retryParent } = await setupParentAuthority({
      directory: retryParentDirectory,
      fixture,
    });
    let executions = 0;
    const error = await commitPreparedArtifact(commitInput(fixture, retryParent, {
      executionAuthorizationTransaction,
      executeAction: () => {
        executions += 1;
        return { duplicate: true };
      },
    }), { clock: () => NOW }).then(() => null, (caught) => caught);
    assert.ok(error instanceof CommitAmbiguousError);
    assert.equal(error.code, 'RISK_FORK_COMMIT_AMBIGUOUS');
    assert.equal(error.evidence.status, 'consuming');
    assert.equal(executions, 0);
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
});

test('a live parent-head concurrency loser receives the persisted ambiguous reservation without mutation', async () => {
  const temporary = await mkdtemp(path.join(os.tmpdir(), 'risk-fork-parent-live-lock-'));
  try {
    const fixture = typedFixture('parent-live-lock');
    const { transaction } = await setupParentAuthority({ directory: temporary, fixture });
    let releaseWinner;
    let markWinnerEntered;
    const winnerGate = new Promise((resolve) => { releaseWinner = resolve; });
    const winnerEntered = new Promise((resolve) => { markWinnerEntered = resolve; });
    let winnerMutations = 0;
    let loserMutations = 0;
    const winner = commitPreparedArtifact(commitInput(fixture, transaction, {
      acceptTypedResult: async () => {
        winnerMutations += 1;
        markWinnerEntered();
        await winnerGate;
        return { accepted: true };
      },
    }), { clock: () => NOW });
    await winnerEntered;

    const loserError = await commitPreparedArtifact(commitInput(fixture, transaction, {
      acceptTypedResult: () => {
        loserMutations += 1;
        return { duplicate: true };
      },
    }), { clock: () => NOW }).then(() => null, (caught) => caught);
    releaseWinner();
    const winnerResult = await winner;
    assert.ok(loserError instanceof CommitAmbiguousError);
    assert.equal(loserError.evidence.parent_state_status, 'committing');
    assert.ok(loserError.evidence.pending_transaction?.transaction_ref);
    assert.equal(loserMutations, 0);
    assert.equal(winnerResult.status, 'committed');
    assert.equal(winnerMutations, 1);
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
});

test('a live authorization concurrency loser receives ambiguous consumption without duplicate execution', async () => {
  const temporary = await mkdtemp(path.join(os.tmpdir(), 'risk-fork-auth-live-lock-'));
  try {
    const fixture = proposalFixture('authorization-live-lock');
    const { transaction: winnerParent } = await setupParentAuthority({
      directory: path.join(temporary, 'winner-parent'),
      fixture,
    });
    const { transaction: loserParent } = await setupParentAuthority({
      directory: path.join(temporary, 'loser-parent'),
      fixture,
    });
    const executionAuthorizationTransaction = await setupAuthorizationAuthority({
      directory: path.join(temporary, 'authorization'),
      fixture,
    });
    let releaseWinner;
    let markWinnerEntered;
    const winnerGate = new Promise((resolve) => { releaseWinner = resolve; });
    const winnerEntered = new Promise((resolve) => { markWinnerEntered = resolve; });
    let winnerExecutions = 0;
    let loserExecutions = 0;
    const winner = commitPreparedArtifact(commitInput(fixture, winnerParent, {
      executionAuthorizationTransaction,
      executeAction: async () => {
        winnerExecutions += 1;
        markWinnerEntered();
        await winnerGate;
        return { accepted: true };
      },
    }), { clock: () => NOW });
    await winnerEntered;

    const loserError = await commitPreparedArtifact(commitInput(fixture, loserParent, {
      executionAuthorizationTransaction,
      executeAction: () => {
        loserExecutions += 1;
        return { duplicate: true };
      },
    }), { clock: () => NOW }).then(() => null, (caught) => caught);
    releaseWinner();
    const winnerResult = await winner;
    assert.ok(loserError instanceof CommitAmbiguousError);
    assert.equal(loserError.evidence.status, 'consuming');
    assert.equal(loserExecutions, 0);
    assert.equal(winnerResult.status, 'committed');
    assert.equal(winnerExecutions, 1);
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
});

test('a dead-owner parent lock returns a deterministic stale-lock contract without mutation', async () => {
  const temporary = await mkdtemp(path.join(os.tmpdir(), 'risk-fork-parent-stale-lock-'));
  try {
    const fixture = typedFixture('parent-stale-lock');
    const { parentRef, transaction } = await setupParentAuthority({ directory: temporary, fixture });
    const deadPid = await exitedChildPid();
    const lockPath = path.join(temporary, `${hash(parentRef).slice(7)}.parent-head.lock`);
    await writeFile(lockPath, `${deadPid}\n`, 'utf8');

    let mutations = 0;
    const error = await commitPreparedArtifact(commitInput(fixture, transaction, {
      acceptTypedResult: () => { mutations += 1; },
    }), { clock: () => NOW }).then(() => null, (caught) => caught);
    assert.equal(error?.code, 'PARENT_HEAD_LOCK_STALE');
    assert.equal(error.evidence.lock_owner_pid, deadPid);
    assert.equal(error.evidence.parent_state_status, 'active');
    assert.equal(mutations, 0);
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
});

test('a dead-owner authorization lock returns a deterministic stale-lock contract without execution', async () => {
  const temporary = await mkdtemp(path.join(os.tmpdir(), 'risk-fork-auth-stale-lock-'));
  try {
    const fixture = proposalFixture('authorization-stale-lock');
    const { transaction: parentStateTransaction } = await setupParentAuthority({
      directory: path.join(temporary, 'parent'),
      fixture,
    });
    const authorizationDirectory = path.join(temporary, 'authorization');
    const executionAuthorizationTransaction = await setupAuthorizationAuthority({
      directory: authorizationDirectory,
      fixture,
    });
    const deadPid = await exitedChildPid();
    const lockPath = path.join(
      authorizationDirectory,
      `${hash(fixture.binding.one_use_authorization_id).slice(7)}.execution-authorization.lock`,
    );
    await writeFile(lockPath, `${deadPid}\n`, 'utf8');

    let executions = 0;
    const error = await commitPreparedArtifact(commitInput(fixture, parentStateTransaction, {
      executionAuthorizationTransaction,
      executeAction: () => { executions += 1; },
    }), { clock: () => NOW }).then(() => null, (caught) => caught);
    assert.equal(error?.code, 'AUTHORIZATION_LOCK_STALE');
    assert.equal(error.evidence.lock_owner_pid, deadPid);
    assert.equal(error.evidence.status, 'active');
    assert.equal(executions, 0);
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
});

test('parent mutation is invoked synchronously after final authority linearization', async () => {
  const temporary = await mkdtemp(path.join(os.tmpdir(), 'risk-fork-parent-final-gate-'));
  try {
    const fixture = typedFixture('parent-final-authority-gate');
    let parentClockCalls = 0;
    let authorityWindowAdvanced = false;
    const parentClock = () => {
      parentClockCalls += 1;
      if (parentClockCalls === 5) {
        setTimeout(() => { authorityWindowAdvanced = true; }, 0);
      }
      return NOW;
    };
    const { transaction } = await setupParentAuthority({
      directory: temporary,
      fixture,
      clock: parentClock,
    });
    let mutationCalls = 0;
    const result = await commitPreparedArtifact(commitInput(fixture, transaction, {
      acceptTypedResult: () => {
        mutationCalls += 1;
        assert.equal(authorityWindowAdvanced, false, 'event loop advanced after final authority linearization');
        return { accepted: true };
      },
    }), { clock: () => NOW });
    assert.equal(result.status, 'committed');
    assert.equal(mutationCalls, 1);
    assert.equal(parentClockCalls, 5);
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
});

test('authorization execution is invoked synchronously after its final authority sample', async () => {
  const temporary = await mkdtemp(path.join(os.tmpdir(), 'risk-fork-auth-final-gate-'));
  try {
    const fixture = proposalFixture('authorization-final-authority-gate');
    let parentClockCalls = 0;
    let authorityWindowAdvanced = false;
    const parentClock = () => {
      parentClockCalls += 1;
      if (parentClockCalls === 6) {
        setTimeout(() => { authorityWindowAdvanced = true; }, 0);
      }
      return NOW;
    };
    const { transaction: parentStateTransaction } = await setupParentAuthority({
      directory: path.join(temporary, 'parent'),
      fixture,
      clock: parentClock,
    });
    const executionAuthorizationTransaction = await setupAuthorizationAuthority({
      directory: path.join(temporary, 'authorization'),
      fixture,
    });
    let executionCalls = 0;
    const result = await commitPreparedArtifact(commitInput(fixture, parentStateTransaction, {
      executionAuthorizationTransaction,
      executeAction: () => {
        executionCalls += 1;
        assert.equal(authorityWindowAdvanced, false, 'event loop advanced after final authorization sample');
        return { accepted: true };
      },
    }), { clock: () => NOW });
    assert.equal(result.status, 'committed');
    assert.equal(executionCalls, 1);
    assert.equal(parentClockCalls, 6);
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
});

test('authorization expiry at the final authority sample blocks execution and restores active state', async () => {
  const temporary = await mkdtemp(path.join(os.tmpdir(), 'risk-fork-auth-expiry-final-gate-'));
  try {
    const fixture = proposalFixture('authorization-expiry-final-authority-gate');
    let parentClockCalls = 0;
    const parentClock = () => {
      parentClockCalls += 1;
      return parentClockCalls >= 6 ? new Date('2030-01-01T02:00:00.000Z') : NOW;
    };
    const { parentRef, transaction: parentStateTransaction } = await setupParentAuthority({
      directory: path.join(temporary, 'parent'),
      fixture,
      clock: parentClock,
    });
    const authorizationDirectory = path.join(temporary, 'authorization');
    const executionAuthorizationTransaction = await setupAuthorizationAuthority({
      directory: authorizationDirectory,
      fixture,
    });
    let executionCalls = 0;

    await assert.rejects(
      commitPreparedArtifact(commitInput(fixture, parentStateTransaction, {
        executionAuthorizationTransaction,
        executeAction: () => {
          executionCalls += 1;
          return { must_not_execute: true };
        },
      }), { clock: () => NOW }),
      (error) => error?.code === 'AUTHORIZATION_EXPIRED' && /expired/i.test(error.message),
    );
    const statePath = path.join(
      authorizationDirectory,
      `${hash(fixture.binding.one_use_authorization_id).slice(7)}.execution-authorization.json`,
    );
    const persisted = JSON.parse(await readFile(statePath, 'utf8'));
    const parent = await parentStateTransaction.getParentHead(parentRef);
    assert.equal(executionCalls, 0);
    assert.equal(persisted.status, 'active');
    assert.equal(persisted.result_hash, null);
    assert.equal(persisted.failure, null);
    assert.equal(parent.status, 'active');
    assert.equal(parent.head_hash, fixture.capsule.parent.state_hash);
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
});

test('the file authorization transaction is the sole revocation and one-use ordering authority', async (t) => {
  await t.test('revocation that commits first prevents consumption', async () => {
    const temporary = await mkdtemp(path.join(os.tmpdir(), 'risk-fork-auth-real-revoke-first-'));
    try {
      const fixture = proposalFixture('authorization-revoke-first');
      const { transaction: parentStateTransaction } = await setupParentAuthority({
        directory: path.join(temporary, 'parent'),
        fixture,
      });
      const executionAuthorizationTransaction = await setupAuthorizationAuthority({
        directory: path.join(temporary, 'authorization'),
        fixture,
      });
      const revoked = await executionAuthorizationTransaction.revokeExecutionAuthorization({
        authorization_id: fixture.binding.one_use_authorization_id,
        evidence_ref: 'authorization:real-revocation',
        evidence_hash: hash('authorization:real-revocation'),
      });
      let executions = 0;
      await assert.rejects(
        commitPreparedArtifact(commitInput(fixture, parentStateTransaction, {
          executionAuthorizationTransaction,
          executeAction: () => { executions += 1; },
        }), { clock: () => NOW }),
        (error) => error?.code === 'AUTHORIZATION_REVOKED',
      );
      assert.equal(revoked.status, 'revoked');
      assert.equal(executions, 0);
    } finally {
      await rm(temporary, { recursive: true, force: true });
    }
  });

  await t.test('consumption reservation prevents a concurrent revocation from committing', async () => {
    const temporary = await mkdtemp(path.join(os.tmpdir(), 'risk-fork-auth-real-consume-first-'));
    try {
      const fixture = proposalFixture('authorization-consume-first');
      let releaseIntegrityVerifier;
      let markIntegrityVerifierEntered;
      const integrityVerifierGate = new Promise((resolve) => { releaseIntegrityVerifier = resolve; });
      const integrityVerifierEntered = new Promise((resolve) => { markIntegrityVerifierEntered = resolve; });
      const { transaction: parentStateTransaction } = await setupParentAuthority({
        directory: path.join(temporary, 'parent'),
        fixture,
      });
      const executionAuthorizationTransaction = await setupAuthorizationAuthority({
        directory: path.join(temporary, 'authorization'),
        fixture,
        verifyAuthorizationIntegrity: async (request) => {
          markIntegrityVerifierEntered();
          await integrityVerifierGate;
          return verifiedAuthorization(request);
        },
      });
      let executions = 0;
      const consumption = commitPreparedArtifact(commitInput(fixture, parentStateTransaction, {
        executionAuthorizationTransaction,
        executeAction: () => {
          executions += 1;
          return { accepted: true };
        },
      }), { clock: () => NOW });
      await integrityVerifierEntered;

      const concurrentRevocationError = await executionAuthorizationTransaction
        .revokeExecutionAuthorization({
          authorization_id: fixture.binding.one_use_authorization_id,
          evidence_ref: 'authorization:late-revocation',
          evidence_hash: hash('authorization:late-revocation'),
        }).then(() => null, (error) => error);
      assert.equal(concurrentRevocationError?.code, 'AUTHORIZATION_TRANSACTION_RESERVED');

      releaseIntegrityVerifier();
      const consumed = await consumption;
      assert.equal(consumed.status, 'committed');
      assert.equal(consumed.execution_authorization.status, 'verified_and_consumed');
      assert.equal(executions, 1);
      await assert.rejects(
        executionAuthorizationTransaction.revokeExecutionAuthorization({
          authorization_id: fixture.binding.one_use_authorization_id,
          evidence_ref: 'authorization:late-revocation-retry',
          evidence_hash: hash('authorization:late-revocation-retry'),
        }),
        (error) => error?.code === 'AUTHORIZATION_CONSUMED',
      );
    } finally {
      await rm(temporary, { recursive: true, force: true });
    }
  });
});

test('authorization consumption fails closed when the authoritative clock moves backward', async () => {
  const temporary = await mkdtemp(path.join(os.tmpdir(), 'risk-fork-auth-clock-rollback-'));
  try {
    const fixture = proposalFixture('authorization-clock-rollback');
    const parentClockValues = [
      NOW,
      NOW,
      NOW,
      NOW,
      NOW,
      new Date('2030-01-01T00:40:00.000Z'),
    ];
    let parentClockCalls = 0;
    const parentClock = () => parentClockValues[
      Math.min(parentClockCalls++, parentClockValues.length - 1)
    ];
    const { parentRef, transaction: parentStateTransaction } = await setupParentAuthority({
      directory: path.join(temporary, 'parent'),
      fixture,
      clock: parentClock,
    });
    const authorizationDirectory = path.join(temporary, 'authorization');
    const authorizationClockValues = [NOW, new Date('2030-01-01T00:50:00.000Z')];
    let authorizationClockCalls = 0;
    const executionAuthorizationTransaction = await setupAuthorizationAuthority({
      directory: authorizationDirectory,
      fixture,
      clock: () => authorizationClockValues[
        Math.min(authorizationClockCalls++, authorizationClockValues.length - 1)
      ],
    });
    let executionCalls = 0;
    await assert.rejects(
      commitPreparedArtifact(commitInput(fixture, parentStateTransaction, {
        executionAuthorizationTransaction,
        executeAction: () => {
          executionCalls += 1;
          return { must_not_execute: true };
        },
      }), { clock: () => NOW }),
      (error) => error?.code === 'AUTHORIZATION_CLOCK_ROLLBACK' && /moved backward/i.test(error.message),
    );
    const statePath = path.join(
      authorizationDirectory,
      `${hash(fixture.binding.one_use_authorization_id).slice(7)}.execution-authorization.json`,
    );
    const persisted = JSON.parse(await readFile(statePath, 'utf8'));
    const parent = await parentStateTransaction.getParentHead(parentRef);
    assert.equal(executionCalls, 0);
    assert.equal(persisted.status, 'active');
    assert.equal(persisted.result_hash, null);
    assert.equal(persisted.failure, null);
    assert.equal(parent.status, 'active');
    assert.equal(parent.head_hash, fixture.capsule.parent.state_hash);
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
});
