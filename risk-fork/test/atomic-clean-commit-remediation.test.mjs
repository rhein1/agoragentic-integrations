import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import Ajv2020 from 'ajv/dist/2020.js';
import addFormats from 'ajv-formats';

import {
  CommitAmbiguousError,
  FileExecutionAuthorizationTransaction,
  FileParentHeadTransaction,
  commitPreparedArtifact as commitPreparedArtifactImpl,
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

function commitPreparedArtifact(input, options = {}) {
  return commitPreparedArtifactImpl(input, { clock: () => NOW, ...options });
}

function destruction(forkRef, providerRef = 'provider:1') {
  return {
    status: 'verified',
    provider_ref: providerRef,
    fork_ref: forkRef,
    evidence_ref: 'destruction:atomic-remediation',
    evidence_hash: hash('destruction:atomic-remediation'),
  };
}

function typedFixture({
  capsule = makeCapsule({ allowed_commit_types: ['TYPED_RESULT'] }),
  answer,
  forkRef,
}) {
  const schema = closedResultSchema();
  const identity = makeForkIdentity(capsule);
  const artifact = validateCommitCandidate({
    candidate: {
      type: 'TYPED_RESULT',
      payload: { answer },
      payload_schema: schema,
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
  };
}

function proposalFixture({ capsuleExpiresAt, bindingExpiresAt } = {}) {
  const capsule = makeCapsule({
    allowed_commit_types: ['CONSEQUENTIAL_ACTION_PROPOSAL'],
    ...(capsuleExpiresAt === undefined ? {} : { expires_at: capsuleExpiresAt }),
    execution_authorization: {
      ref: 'authorization-ref:1',
      hash: hash('authorization-record'),
    },
  });
  const identity = makeForkIdentity(capsule);
  const binding = makeBinding({
    capsule,
    identity,
    action_operation: 'payment',
    amount: '1.25',
    currency: 'USDC',
    payment_rail: 'x402:base',
    ...(bindingExpiresAt === undefined ? {} : { expires_at: bindingExpiresAt }),
  });
  const forkRef = 'fork:atomic-proposal';
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
    capsule,
    identity,
    binding,
    artifact,
    lifecycle: advanceToCommitting(makePreparedLifecycle(artifact.artifact_hash)),
    destruction_evidence: destruction(forkRef),
  };
}

function workspaceFixture({
  files,
  testEvidence = [],
  validationPolicy = { path_allowlist: ['src'] },
  forkRef = 'fork:atomic-workspace',
} = {}) {
  const capsule = makeCapsule({ allowed_commit_types: ['WORKSPACE_DIFF'] });
  const identity = makeForkIdentity(capsule);
  const artifact = validateCommitCandidate({
    candidate: {
      type: 'WORKSPACE_DIFF',
      files: files ?? [{
        path: 'src/result.txt',
        operation: 'create',
        before_hash: null,
        after_content: 'verified clean-side',
      }],
      test_evidence: testEvidence,
    },
    source_fork_id: forkRef,
    policy: validationPolicy,
    validated_at: NOW,
  });
  return {
    capsule,
    identity,
    artifact,
    lifecycle: advanceToCommitting(makePreparedLifecycle(artifact.artifact_hash)),
    destruction_evidence: destruction(forkRef),
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
      usage_hash: hash('budget-usage:current'),
      available_amount: '100.00',
      currency: 'USDC',
      payment_rail: 'x402:base',
    },
    epoch: capsule.governance.epoch,
    commit_policy: commitPolicy,
    evidence_ref: 'governance:current-evidence',
    evidence_hash: hash('governance:current-evidence'),
  };
}

function defaultCommitPolicy(fixture) {
  if (fixture.artifact.commit_type === 'TYPED_RESULT') {
    return {
      typed_result_schema_hash: fixture.capsule.authorized_result_schema_hash,
      max_typed_result_bytes: 1_000,
    };
  }
  return {};
}

function approvalEvidenceFor(fixture, tag = 'primary') {
  const evidenceRef = `approval:${tag}:${fixture.artifact.artifact_hash.slice(7, 23)}`;
  return {
    evidence_ref: evidenceRef,
    evidence_hash: hash({
      evidence_ref: evidenceRef,
      artifact_hash: fixture.artifact.artifact_hash,
    }),
  };
}

function approval(request, evidence) {
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
    evidence_ref: evidence.evidence_ref,
    evidence_hash: evidence.evidence_hash,
  };
}

function baseInput(fixture, options = {}) {
  const {
    approvalEvidence = approvalEvidenceFor(fixture),
    ...overrides
  } = options;
  return {
    capsule: fixture.capsule,
    fork_identity: fixture.identity,
    lifecycle: fixture.lifecycle,
    artifact: fixture.artifact,
    destruction_evidence: fixture.destruction_evidence,
    expected_parent_state_hash: fixture.capsule.parent.state_hash,
    verifyCommitApproval: async (request) => approval(request, approvalEvidence),
    ...overrides,
  };
}

async function temporaryDirectory(t, label) {
  const directory = await mkdtemp(path.join(os.tmpdir(), `risk-fork-${label}-`));
  t.after(() => rm(directory, { recursive: true, force: true }));
  return directory;
}

async function createParentAuthority(directory, fixtures, options = {}) {
  const fixtureList = Array.isArray(fixtures) ? fixtures : [fixtures];
  const first = fixtureList[0];
  const governance = options.governance
    ?? currentGovernance(first.capsule, defaultCommitPolicy(first));
  const parentRef = deriveParentAuthorityRef({
    agent_id: first.capsule.parent.agent_id,
    session_id: first.capsule.parent.session_id,
  });
  const transaction = await new FileParentHeadTransaction({
    directory,
    clock: options.clock ?? (() => NOW),
  }).initialize();
  await transaction.seedParentHead({
    parentRef,
    headHash: options.headHash ?? first.capsule.parent.state_hash,
  });
  await transaction.setCurrentGovernance({
    parent_ref: parentRef,
    governance,
  });
  const evidenceByArtifact = new Map();
  for (const fixture of options.approvals ?? fixtureList) {
    const evidence = options.approvalEvidenceFor?.(fixture) ?? approvalEvidenceFor(fixture);
    evidenceByArtifact.set(fixture.artifact.artifact_hash, evidence);
    await transaction.registerCommitApproval({
      parent_ref: parentRef,
      artifact_hash: fixture.artifact.artifact_hash,
      capsule_hash: fixture.capsule.capsule_hash,
      parent_state_hash: fixture.capsule.parent.state_hash,
      commit_type: fixture.artifact.commit_type,
      governance_hash: hash(governance),
      evidence_ref: evidence.evidence_ref,
      evidence_hash: evidence.evidence_hash,
    });
  }
  return { transaction, parentRef, governance, evidenceByArtifact };
}

function inputWithAuthority(fixture, authority, overrides = {}) {
  return baseInput(fixture, {
    approvalEvidence: authority.evidenceByArtifact.get(fixture.artifact.artifact_hash)
      ?? approvalEvidenceFor(fixture),
    parentStateTransaction: authority.transaction,
    resolveCurrentGovernance: async () => structuredClone(authority.governance),
    ...overrides,
  });
}

function verifiedAuthorization(request, evidence = 'authorization:trusted-verifier') {
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
    evidence_ref: evidence,
    evidence_hash: hash(evidence),
  };
}

async function createExecutionAuthority(directory, fixture, options = {}) {
  const transaction = await new FileExecutionAuthorizationTransaction({
    directory,
    clock: options.clock ?? (() => NOW),
    ...(options.verifyAuthorizationIntegrity === null
      ? {}
      : {
        verifyAuthorizationIntegrity: options.verifyAuthorizationIntegrity
          ?? (async (request) => verifiedAuthorization(request)),
      }),
  }).initialize();
  if (options.register !== false) {
    await transaction.registerExecutionAuthorization({
      authorization_id: fixture.binding.one_use_authorization_id,
      authorization_ref: fixture.binding.authorization_ref,
      authorization_hash: fixture.binding.authorization_hash,
      binding_hash: fixture.binding.binding_hash,
      expires_at: fixture.binding.validity.expires_at,
      evidence_ref: options.evidence_ref ?? 'authorization:atomic-registration',
      evidence_hash: options.evidence_hash ?? hash('authorization:atomic-registration'),
    });
  }
  return { transaction, directory };
}

async function readAuthorizationState(directory, authorizationId) {
  const file = path.join(
    directory,
    `${hash(authorizationId).slice(7)}.execution-authorization.json`,
  );
  return JSON.parse(await readFile(file, 'utf8'));
}

function cleanTestAttestation(request, evidence = 'clean:test-unit') {
  return {
    schema: 'agoragentic.risk-fork.required-test-attestation.v1',
    status: 'verified',
    request_hash: request.request_hash,
    test_name: request.test_name,
    artifact_hash: request.artifact_hash,
    diff_hash: request.diff_hash,
    policy_hash: request.policy_hash,
    method: 'clean_reexecution',
    evidence_ref: evidence,
    evidence_hash: hash(evidence),
  };
}

test('concrete file authorities cannot be replaced by unbranded, subclassed, or monkeypatched objects', async (t) => {
  const directory = await temporaryDirectory(t, 'concrete-authority-type');
  const fixture = typedFixture({
    answer: 'must-use-concrete-authority',
    forkRef: 'fork:concrete-authority-type',
  });

  for (const [name, candidate] of [
    ['plain lookalike', { commitAgainstParentHead() {} }],
    ['prototype lookalike', Object.create(FileParentHeadTransaction.prototype)],
  ]) {
    await t.test(name, async () => {
      await assert.rejects(
        commitPreparedArtifact(baseInput(fixture, { parentStateTransaction: candidate })),
        (error) => error?.code === 'FILE_PARENT_AUTHORITY_REQUIRED',
      );
    });
  }

  class ParentSubclass extends FileParentHeadTransaction {}
  class AuthorizationSubclass extends FileExecutionAuthorizationTransaction {}
  assert.throws(
    () => new ParentSubclass({ directory: path.join(directory, 'parent-subclass') }),
    /cannot be subclassed/i,
  );
  assert.throws(
    () => new AuthorizationSubclass({ directory: path.join(directory, 'auth-subclass') }),
    /cannot be subclassed/i,
  );

  const parent = new FileParentHeadTransaction({ directory: path.join(directory, 'parent') });
  const authorization = new FileExecutionAuthorizationTransaction({
    directory: path.join(directory, 'authorization'),
  });
  assert.equal(Object.isFrozen(parent), true);
  assert.equal(Object.isFrozen(FileParentHeadTransaction.prototype), true);
  assert.equal(Object.isFrozen(authorization), true);
  assert.equal(Object.isFrozen(FileExecutionAuthorizationTransaction.prototype), true);
  assert.throws(() => { parent.seedParentHead = () => {}; }, TypeError);
  assert.throws(() => { authorization.registerExecutionAuthorization = () => {}; }, TypeError);
  assert.equal(parent.commitAgainstParentHead, undefined);
  assert.equal(parent.runWithFinalCommitAuthority, undefined);
  assert.equal(authorization.consumeExecutionAuthorizationForBinding, undefined);

  await assert.rejects(
    commitPreparedArtifact({
      ...baseInput(fixture, { parentStateTransaction: parent }),
      finalCommitAuthorityTransaction: {},
    }),
    /unsupported fields: finalCommitAuthorityTransaction/,
  );
});

test('typed result commits through persisted parent governance and approval authority', async (t) => {
  const directory = await temporaryDirectory(t, 'concrete-typed-success');
  const fixture = typedFixture({ answer: 'accepted', forkRef: 'fork:concrete-typed-success' });
  const authority = await createParentAuthority(directory, fixture);
  let mutations = 0;

  const result = await commitPreparedArtifact(inputWithAuthority(fixture, authority, {
    acceptTypedResult: async (payload) => {
      mutations += 1;
      return { accepted: payload.answer };
    },
  }));

  const parent = await authority.transaction.getParentHead(authority.parentRef);
  const commitAuthority = await authority.transaction.getCommitAuthority(authority.parentRef);
  assert.equal(result.status, 'committed');
  assert.equal(result.final_commit_authority.status, 'verified');
  assert.equal(result.final_commit_authority.atomicity_status, 'verified');
  assert.equal(result.final_commit_authority.linearized_at, NOW.toISOString());
  assert.equal(result.final_commit_authority.observed_at, NOW.toISOString());
  assert.equal(result.clean_approval.status, 'verified');
  assert.equal(mutations, 1);
  assert.equal(parent.status, 'active');
  assert.equal(parent.head_hash, result.parent_state_hash);
  assert.equal(commitAuthority.approvals[0].status, 'consumed');
});

test('two distinct artifacts from one concrete parent head produce exactly one mutation', async (t) => {
  const directory = await temporaryDirectory(t, 'parent-race');
  const capsule = makeCapsule({ allowed_commit_types: ['TYPED_RESULT'] });
  const first = typedFixture({ capsule, answer: 'first', forkRef: 'fork:parent-race:first' });
  const second = typedFixture({ capsule, answer: 'second', forkRef: 'fork:parent-race:second' });
  const authority = await createParentAuthority(directory, [first, second]);
  let acceptorCalls = 0;

  const commits = await Promise.allSettled([first, second].map((fixture) =>
    commitPreparedArtifact(inputWithAuthority(fixture, authority, {
      acceptTypedResult: async (payload) => {
        acceptorCalls += 1;
        await new Promise((resolve) => setImmediate(resolve));
        return { accepted: payload.answer };
      },
    }))));

  const parent = await authority.transaction.getParentHead(authority.parentRef);
  assert.equal(commits.filter((entry) => entry.status === 'fulfilled').length, 1);
  assert.equal(commits.filter((entry) => entry.status === 'rejected').length, 1);
  assert.equal(acceptorCalls, 1);
  assert.equal(parent.status, 'active');
  assert.notEqual(parent.head_hash, capsule.parent.state_hash);
});

test('a completed parent mutation makes a second capsule-bound artifact authoritatively stale', async (t) => {
  const directory = await temporaryDirectory(t, 'parent-stale');
  const capsule = makeCapsule({ allowed_commit_types: ['TYPED_RESULT'] });
  const first = typedFixture({ capsule, answer: 'first', forkRef: 'fork:parent-stale:first' });
  const stale = typedFixture({ capsule, answer: 'stale', forkRef: 'fork:parent-stale:second' });
  const authority = await createParentAuthority(directory, [first, stale]);
  let staleMutations = 0;

  await commitPreparedArtifact(inputWithAuthority(first, authority, {
    acceptTypedResult: async () => ({ accepted: true }),
  }));
  await assert.rejects(
    commitPreparedArtifact(inputWithAuthority(stale, authority, {
      acceptTypedResult: async () => { staleMutations += 1; },
    })),
    (error) => error?.code === 'PARENT_HEAD_STALE',
  );
  assert.equal(staleMutations, 0);
});

test('caller-supplied current parent state cannot override the concrete authority head', async (t) => {
  const directory = await temporaryDirectory(t, 'caller-parent-state-lie');
  const fixture = typedFixture({
    answer: 'must-ignore-caller-parent-state',
    forkRef: 'fork:caller-parent-state-lie',
  });
  const authority = await createParentAuthority(directory, fixture);
  let mutations = 0;

  await assert.rejects(
    commitPreparedArtifact({
      ...inputWithAuthority(fixture, authority, {
        acceptTypedResult: async () => { mutations += 1; },
      }),
      current_parent_state_hash: hash('caller-controlled-current-parent'),
    }),
    /unsupported fields: current_parent_state_hash/,
  );
  const parent = await authority.transaction.getParentHead(authority.parentRef);
  assert.equal(mutations, 0);
  assert.equal(parent.status, 'active');
  assert.equal(parent.head_hash, fixture.capsule.parent.state_hash);
});

test('current policy, mandate, or budget drift blocks before mutation', async (t) => {
  for (const field of ['policy', 'mandate', 'budget_policy']) {
    await t.test(field, async (st) => {
      const directory = await temporaryDirectory(st, `governance-drift-${field}`);
      const fixture = field === 'policy'
        ? typedFixture({ answer: field, forkRef: `fork:drift:${field}` })
        : proposalFixture();
      const governance = currentGovernance(fixture.capsule, defaultCommitPolicy(fixture));
      governance[field] = { ...governance[field], hash: hash(`${field}:changed`) };
      const authority = await createParentAuthority(directory, fixture, { governance });
      let mutations = 0;

      await assert.rejects(
        commitPreparedArtifact(inputWithAuthority(fixture, authority, {
          ...(fixture.artifact.commit_type === 'TYPED_RESULT'
            ? { acceptTypedResult: async () => { mutations += 1; } }
            : {
              executionAuthorizationTransaction: {},
              executeAction: async () => { mutations += 1; },
            }),
        })),
        /Current (?:policy|mandate|budget policy)|new savepoint/i,
      );
      assert.equal(mutations, 0);
    });
  }
});

test('revoked deletion permission blocks a previously prepared workspace deletion', async (t) => {
  const directory = await temporaryDirectory(t, 'delete-policy-drift');
  const fixture = workspaceFixture({
    files: [{
      path: 'src/obsolete.txt',
      operation: 'delete',
      before_hash: hash('old-content'),
      after_content: null,
    }],
    validationPolicy: { path_allowlist: ['src'], allow_delete: true },
    forkRef: 'fork:delete-policy-drift',
  });
  const governance = currentGovernance(fixture.capsule, {
    path_allowlist: ['src'],
    allow_delete: false,
    max_files: 10,
    max_diff_bytes: 10_000,
    required_tests: [],
  });
  const authority = await createParentAuthority(directory, fixture, { governance });
  let mutations = 0;

  await assert.rejects(
    commitPreparedArtifact(inputWithAuthority(fixture, authority, {
      applyWorkspaceDiff: async () => { mutations += 1; },
    })),
    /deletion.*not allowed|current workspace policy|new savepoint/i,
  );
  assert.equal(mutations, 0);
});

test('required workspace tests are independently verified under the concrete parent reservation', async (t) => {
  const directory = await temporaryDirectory(t, 'required-tests');
  const fixture = workspaceFixture({
    testEvidence: [{
      name: 'test:unit',
      status: 'passed',
      evidence_ref: 'child:test-claim',
      evidence_hash: hash('child:test-claim'),
      duration_ms: 1,
    }],
    forkRef: 'fork:required-tests',
  });
  const governance = currentGovernance(fixture.capsule, {
    path_allowlist: ['src'],
    required_tests: ['test:unit'],
  });
  const authority = await createParentAuthority(directory, fixture, { governance });
  let verifierCalls = 0;
  let mutations = 0;

  const result = await commitPreparedArtifact(inputWithAuthority(fixture, authority, {
    verifyTestEvidence: async (request) => {
      verifierCalls += 1;
      return cleanTestAttestation(request);
    },
    applyWorkspaceDiff: async () => {
      mutations += 1;
      return { applied: true };
    },
  }));

  assert.equal(result.status, 'committed');
  assert.equal(verifierCalls, 1);
  assert.equal(mutations, 1);
});

test('stale advisory governance evidence is rejected against persisted parent authority', async (t) => {
  const directory = await temporaryDirectory(t, 'governance-evidence-stale');
  const fixture = typedFixture({
    answer: 'must-not-commit-stale-evidence',
    forkRef: 'fork:governance-evidence-stale',
  });
  const authority = await createParentAuthority(directory, fixture);
  const staleGovernance = {
    ...structuredClone(authority.governance),
    evidence_ref: 'governance:stale-advisory',
    evidence_hash: hash('governance:stale-advisory'),
  };
  let mutations = 0;

  await assert.rejects(
    commitPreparedArtifact(inputWithAuthority(fixture, authority, {
      resolveCurrentGovernance: async () => staleGovernance,
      acceptTypedResult: async () => { mutations += 1; },
    })),
    (error) => error?.code === 'GOVERNANCE_EVIDENCE_STALE',
  );
  const parent = await authority.transaction.getParentHead(authority.parentRef);
  assert.equal(mutations, 0);
  assert.equal(parent.status, 'active');
  assert.equal(parent.head_hash, fixture.capsule.parent.state_hash);
});

test('a governance update supersedes every approval bound to the previous snapshot', async (t) => {
  const directory = await temporaryDirectory(t, 'governance-supersedes-approval');
  const fixture = typedFixture({
    answer: 'must-not-commit-superseded-approval',
    forkRef: 'fork:governance-supersedes-approval',
  });
  const authority = await createParentAuthority(directory, fixture);
  const nextGovernance = {
    ...structuredClone(authority.governance),
    evidence_ref: 'governance:next-evidence',
    evidence_hash: hash('governance:next-evidence'),
  };
  await authority.transaction.setCurrentGovernance({
    parent_ref: authority.parentRef,
    governance: nextGovernance,
  });
  let mutations = 0;

  await assert.rejects(
    commitPreparedArtifact(inputWithAuthority(fixture, authority, {
      resolveCurrentGovernance: async () => structuredClone(nextGovernance),
      acceptTypedResult: async () => { mutations += 1; },
    })),
    (error) => error?.code === 'FINAL_COMMIT_APPROVAL_NOT_ACTIVE',
  );
  const record = await authority.transaction.getCommitAuthority(authority.parentRef);
  assert.equal(mutations, 0);
  assert.equal(record.approvals[0].status, 'superseded');
});

test('approval revocation committed before the parent reservation blocks mutation', async (t) => {
  const directory = await temporaryDirectory(t, 'approval-revoked');
  const fixture = typedFixture({
    answer: 'must-not-commit-revoked-approval',
    forkRef: 'fork:approval-revoked',
  });
  const authority = await createParentAuthority(directory, fixture);
  const evidence = authority.evidenceByArtifact.get(fixture.artifact.artifact_hash);
  await authority.transaction.revokeCommitApproval({
    parent_ref: authority.parentRef,
    approval_evidence_ref: evidence.evidence_ref,
    approval_evidence_hash: evidence.evidence_hash,
    evidence_ref: 'approval-revocation:before-commit',
    evidence_hash: hash('approval-revocation:before-commit'),
  });
  let mutations = 0;

  await assert.rejects(
    commitPreparedArtifact(inputWithAuthority(fixture, authority, {
      acceptTypedResult: async () => { mutations += 1; },
    })),
    (error) => error?.code === 'FINAL_COMMIT_APPROVAL_NOT_ACTIVE',
  );
  assert.equal(mutations, 0);
});

test('changed approval evidence cannot substitute for the registered exact approval', async (t) => {
  const directory = await temporaryDirectory(t, 'approval-evidence-changed');
  const fixture = typedFixture({
    answer: 'must-not-commit-changed-approval',
    forkRef: 'fork:approval-evidence-changed',
  });
  const authority = await createParentAuthority(directory, fixture);
  const changedEvidence = approvalEvidenceFor(fixture, 'changed');
  let mutations = 0;

  await assert.rejects(
    commitPreparedArtifact(inputWithAuthority(fixture, authority, {
      verifyCommitApproval: async (request) => approval(request, changedEvidence),
      acceptTypedResult: async () => { mutations += 1; },
    })),
    (error) => error?.code === 'FINAL_COMMIT_APPROVAL_NOT_ACTIVE',
  );
  assert.equal(mutations, 0);
});

test('approval verifier evidence must bind the exact current governance', async (t) => {
  const directory = await temporaryDirectory(t, 'approval-governance-mismatch');
  const fixture = typedFixture({
    answer: 'must-not-commit-governance-mismatch',
    forkRef: 'fork:approval-governance-mismatch',
  });
  const authority = await createParentAuthority(directory, fixture);
  const evidence = authority.evidenceByArtifact.get(fixture.artifact.artifact_hash);
  let mutations = 0;

  await assert.rejects(
    commitPreparedArtifact(inputWithAuthority(fixture, authority, {
      verifyCommitApproval: async (request) => ({
        ...approval(request, evidence),
        governance_evidence_hash: hash('different-governance-evidence'),
      }),
      acceptTypedResult: async () => { mutations += 1; },
    })),
    (error) => error?.code === 'CLEAN_APPROVAL_NOT_VERIFIED',
  );
  assert.equal(mutations, 0);
});

test('governance and approval mutations cannot interleave with the concrete final gate', async (t) => {
  const directory = await temporaryDirectory(t, 'authority-ordering');
  const fixture = workspaceFixture({
    testEvidence: [{
      name: 'test:unit',
      status: 'passed',
      evidence_ref: 'child:ordering-test',
      evidence_hash: hash('child:ordering-test'),
      duration_ms: 1,
    }],
    forkRef: 'fork:authority-ordering',
  });
  const governance = currentGovernance(fixture.capsule, {
    path_allowlist: ['src'],
    required_tests: ['test:unit'],
  });
  const authority = await createParentAuthority(directory, fixture, { governance });
  const evidence = authority.evidenceByArtifact.get(fixture.artifact.artifact_hash);
  const nextGovernance = {
    ...structuredClone(governance),
    evidence_ref: 'governance:ordered-after-commit',
    evidence_hash: hash('governance:ordered-after-commit'),
  };
  const conflictingErrors = [];
  let mutations = 0;

  const result = await commitPreparedArtifact(inputWithAuthority(fixture, authority, {
    verifyTestEvidence: async (request) => {
      const attempts = await Promise.all([
        authority.transaction.revokeCommitApproval({
          parent_ref: authority.parentRef,
          approval_evidence_ref: evidence.evidence_ref,
          approval_evidence_hash: evidence.evidence_hash,
          evidence_ref: 'approval-revocation:during-reservation',
          evidence_hash: hash('approval-revocation:during-reservation'),
        }).then(() => null, (error) => error),
        authority.transaction.setCurrentGovernance({
          parent_ref: authority.parentRef,
          governance: nextGovernance,
        }).then(() => null, (error) => error),
      ]);
      conflictingErrors.push(...attempts);
      return cleanTestAttestation(request, 'clean:ordering-test');
    },
    applyWorkspaceDiff: async () => {
      mutations += 1;
      return { applied: true };
    },
  }));

  assert.equal(result.status, 'committed');
  assert.equal(mutations, 1);
  assert.equal(conflictingErrors.length, 2);
  assert.ok(conflictingErrors.every((error) => error instanceof Error));
  assert.ok(conflictingErrors.every((error) => [
    'RISK_FORK_COMMIT_AMBIGUOUS',
    'PARENT_HEAD_TRANSACTION_RESERVED',
  ].includes(error.code)));
  await assert.rejects(
    authority.transaction.revokeCommitApproval({
      parent_ref: authority.parentRef,
      approval_evidence_ref: evidence.evidence_ref,
      approval_evidence_hash: evidence.evidence_hash,
      evidence_ref: 'approval-revocation:after-consumption',
      evidence_hash: hash('approval-revocation:after-consumption'),
    }),
    (error) => error?.code === 'COMMIT_APPROVAL_NOT_ACTIVE',
  );
  const updated = await authority.transaction.setCurrentGovernance({
    parent_ref: authority.parentRef,
    governance: nextGovernance,
  });
  assert.equal(updated.current_governance.evidence_ref, nextGovernance.evidence_ref);
});

test('capsule expiry between preflight and concrete parent linearization blocks mutation', async (t) => {
  const directory = await temporaryDirectory(t, 'capsule-expiry-parent');
  const fixture = typedFixture({
    capsule: makeCapsule({
      allowed_commit_types: ['TYPED_RESULT'],
      expires_at: '2030-01-01T00:10:00.000Z',
    }),
    answer: 'must-not-commit-after-expiry',
    forkRef: 'fork:capsule-expiry-parent',
  });
  let trustedNow = NOW;
  const authority = await createParentAuthority(directory, fixture, {
    clock: () => trustedNow,
  });
  const evidence = authority.evidenceByArtifact.get(fixture.artifact.artifact_hash);
  let mutations = 0;

  await assert.rejects(
    commitPreparedArtifact(inputWithAuthority(fixture, authority, {
      verifyCommitApproval: async (request) => {
        const verified = approval(request, evidence);
        trustedNow = new Date('2030-01-01T00:20:00.000Z');
        return verified;
      },
      acceptTypedResult: async () => { mutations += 1; },
    }), { clock: () => NOW }),
    /expired|stale|validity/i,
  );
  const parent = await authority.transaction.getParentHead(authority.parentRef);
  assert.equal(mutations, 0);
  assert.equal(parent.status, 'active');
  assert.equal(parent.head_hash, fixture.capsule.parent.state_hash);
});

test('a backward concrete authority clock fails closed before mutation', async (t) => {
  const directory = await temporaryDirectory(t, 'authority-clock-rollback');
  const fixture = typedFixture({
    answer: 'must-not-commit-clock-rollback',
    forkRef: 'fork:authority-clock-rollback',
  });
  let trustedNow = NOW;
  const authority = await createParentAuthority(directory, fixture, {
    clock: () => trustedNow,
  });
  const evidence = authority.evidenceByArtifact.get(fixture.artifact.artifact_hash);
  let mutations = 0;

  await assert.rejects(
    commitPreparedArtifact(inputWithAuthority(fixture, authority, {
      verifyCommitApproval: async (request) => {
        const verified = approval(request, evidence);
        trustedNow = new Date('2029-12-31T23:59:59.000Z');
        return verified;
      },
      acceptTypedResult: async () => { mutations += 1; },
    })),
    (error) => error?.code === 'AUTHORITY_CLOCK_ROLLBACK',
  );
  const parent = await authority.transaction.getParentHead(authority.parentRef);
  assert.equal(mutations, 0);
  assert.equal(parent.status, 'active');
});

test('clean commit validity uses an out-of-band clock and rejects serialized backdating', async (t) => {
  const directory = await temporaryDirectory(t, 'clean-commit-backdate');
  const fixture = typedFixture({ answer: 'backdated', forkRef: 'fork:clean-commit-backdate' });
  const authority = await createParentAuthority(directory, fixture);
  let mutations = 0;
  const input = inputWithAuthority(fixture, authority, {
    acceptTypedResult: async () => { mutations += 1; },
    now: NOW,
  });

  await assert.rejects(
    commitPreparedArtifact(input, {
      clock: () => new Date('2030-01-01T02:00:00.000Z'),
    }),
    /unsupported fields: now/,
  );
  delete input.now;
  await assert.rejects(
    commitPreparedArtifact(input, {
      clock: () => new Date('2030-01-01T02:00:00.000Z'),
    }),
    /expired|stale|validity/i,
  );
  assert.equal(mutations, 0);
});

test('an unbranded execution authority is rejected even with a concrete parent authority', async (t) => {
  const directory = await temporaryDirectory(t, 'unbranded-auth');
  const fixture = proposalFixture();
  const parent = await createParentAuthority(path.join(directory, 'parent'), fixture);
  let executions = 0;

  await assert.rejects(
    commitPreparedArtifact(inputWithAuthority(fixture, parent, {
      executionAuthorizationTransaction: Object.create(
        FileExecutionAuthorizationTransaction.prototype,
      ),
      executeAction: async () => { executions += 1; },
    })),
    (error) => error?.code === 'FILE_EXECUTION_AUTHORITY_REQUIRED',
  );
  assert.equal(executions, 0);
});

test('two concrete parents racing for one authorization produce exactly one execution', async (t) => {
  const directory = await temporaryDirectory(t, 'authorization-race');
  const fixture = proposalFixture();
  const firstParent = await createParentAuthority(path.join(directory, 'parent-a'), fixture);
  const secondParent = await createParentAuthority(path.join(directory, 'parent-b'), fixture);
  const authorization = await createExecutionAuthority(
    path.join(directory, 'authorizations'),
    fixture,
  );
  let executions = 0;
  const makeInput = (parent) => inputWithAuthority(fixture, parent, {
    executionAuthorizationTransaction: authorization.transaction,
    executeAction: async () => {
      executions += 1;
      await new Promise((resolve) => setImmediate(resolve));
      return { accepted: true };
    },
  });

  const results = await Promise.allSettled([
    commitPreparedArtifact(makeInput(firstParent)),
    commitPreparedArtifact(makeInput(secondParent)),
  ]);
  const committed = results.find((entry) => entry.status === 'fulfilled').value;
  const cleanCommitSchema = JSON.parse(await readFile(
    new URL('../schema/clean-commit-result.v1.json', import.meta.url),
    'utf8',
  ));
  const ajv = new Ajv2020({ allErrors: true, strict: true });
  addFormats(ajv);
  const validateCleanCommit = ajv.compile(cleanCommitSchema);
  const authorizationState = await readAuthorizationState(
    authorization.directory,
    fixture.binding.one_use_authorization_id,
  );
  assert.equal(results.filter((entry) => entry.status === 'fulfilled').length, 1);
  assert.equal(results.filter((entry) => entry.status === 'rejected').length, 1);
  assert.equal(committed.execution_authorization.observed_at, NOW.toISOString());
  assert.equal(
    validateCleanCommit(committed),
    true,
    JSON.stringify(validateCleanCommit.errors),
  );
  const invalidObservedAt = structuredClone(committed);
  invalidObservedAt.execution_authorization.observed_at = 'not-a-date';
  assert.equal(validateCleanCommit(invalidObservedAt), false);
  assert.equal(executions, 1);
  assert.equal(authorizationState.status, 'consumed');
});

test('authorization revocation committed before clean commit prevents execution', async (t) => {
  const directory = await temporaryDirectory(t, 'authorization-revoked');
  const fixture = proposalFixture();
  const parent = await createParentAuthority(path.join(directory, 'parent'), fixture);
  const authorization = await createExecutionAuthority(
    path.join(directory, 'authorizations'),
    fixture,
  );
  await authorization.transaction.revokeExecutionAuthorization({
    authorization_id: fixture.binding.one_use_authorization_id,
    evidence_ref: 'authorization:revoked-before-clean-commit',
    evidence_hash: hash('authorization:revoked-before-clean-commit'),
  });
  let executions = 0;

  await assert.rejects(
    commitPreparedArtifact(inputWithAuthority(fixture, parent, {
      executionAuthorizationTransaction: authorization.transaction,
      executeAction: async () => { executions += 1; },
    })),
    (error) => error?.code === 'AUTHORIZATION_REVOKED',
  );
  const parentState = await parent.transaction.getParentHead(parent.parentRef);
  assert.equal(executions, 0);
  assert.equal(parentState.status, 'active');
  assert.equal(parentState.head_hash, fixture.capsule.parent.state_hash);
});

test('expired authorization uses the concrete store clock and cannot be backdated', async (t) => {
  const directory = await temporaryDirectory(t, 'authorization-expired');
  const fixture = proposalFixture({ bindingExpiresAt: '2030-01-01T00:10:00.000Z' });
  const parent = await createParentAuthority(path.join(directory, 'parent'), fixture);
  const authorization = await createExecutionAuthority(
    path.join(directory, 'authorizations'),
    fixture,
    { clock: () => new Date('2030-01-01T00:20:00.000Z') },
  );
  let executions = 0;

  await assert.rejects(
    commitPreparedArtifact(inputWithAuthority(fixture, parent, {
      executionAuthorizationTransaction: authorization.transaction,
      executeAction: async () => { executions += 1; },
    })),
    (error) => error?.code === 'AUTHORIZATION_EXPIRED',
  );
  assert.equal(executions, 0);
  assert.equal(authorization.transaction.consumeExecutionAuthorizationForBinding, undefined);
});

test('trusted authorization verification rejects forged, mismatched, and missing authority', async (t) => {
  const scenarios = [
    {
      name: 'invalid signature',
      expectedCode: 'AUTHORIZATION_SIGNATURE_INVALID',
      verifier: async () => {
        const error = new Error('trusted signature verifier rejected authorization');
        error.code = 'AUTHORIZATION_SIGNATURE_INVALID';
        throw error;
      },
    },
    {
      name: 'mismatched request',
      expectedCode: 'AUTHORIZATION_VERIFICATION_FAILED',
      verifier: async (request) => ({
        ...verifiedAuthorization(request),
        request_hash: hash('mismatched:request'),
      }),
    },
    {
      name: 'mismatched binding',
      expectedCode: 'AUTHORIZATION_VERIFICATION_FAILED',
      verifier: async (request) => ({
        ...verifiedAuthorization(request),
        binding_hash: hash('mismatched:binding'),
      }),
    },
    {
      name: 'missing verifier',
      expectedCode: 'AUTHORIZATION_VERIFIER_REQUIRED',
      verifier: null,
    },
  ];

  for (const scenario of scenarios) {
    await t.test(scenario.name, async (st) => {
      const directory = await temporaryDirectory(st, `authorization-${scenario.name.replaceAll(' ', '-')}`);
      const fixture = proposalFixture();
      const parent = await createParentAuthority(path.join(directory, 'parent'), fixture);
      const authorization = await createExecutionAuthority(
        path.join(directory, 'authorizations'),
        fixture,
        { verifyAuthorizationIntegrity: scenario.verifier },
      );
      let executions = 0;

      await assert.rejects(
        commitPreparedArtifact(inputWithAuthority(fixture, parent, {
          executionAuthorizationTransaction: authorization.transaction,
          executeAction: async () => { executions += 1; },
        })),
        (error) => error?.code === scenario.expectedCode,
      );
      const parentState = await parent.transaction.getParentHead(parent.parentRef);
      const authorizationState = await readAuthorizationState(
        authorization.directory,
        fixture.binding.one_use_authorization_id,
      );
      assert.equal(executions, 0);
      assert.equal(parentState.status, 'active');
      assert.equal(authorizationState.status, 'active');
    });
  }
});

test('capsule expiry during authorization verification restores both concrete reservations', async (t) => {
  const directory = await temporaryDirectory(t, 'capsule-expiry-authorization');
  const fixture = proposalFixture({
    capsuleExpiresAt: '2030-01-01T00:10:00.000Z',
    bindingExpiresAt: '2030-01-01T01:00:00.000Z',
  });
  let trustedNow = NOW;
  const parent = await createParentAuthority(path.join(directory, 'parent'), fixture, {
    clock: () => trustedNow,
  });
  const authorization = await createExecutionAuthority(
    path.join(directory, 'authorizations'),
    fixture,
    {
      clock: () => trustedNow,
      verifyAuthorizationIntegrity: async (request) => {
        const verified = verifiedAuthorization(request);
        trustedNow = new Date('2030-01-01T00:20:00.000Z');
        return verified;
      },
    },
  );
  let executions = 0;

  await assert.rejects(
    commitPreparedArtifact(inputWithAuthority(fixture, parent, {
      executionAuthorizationTransaction: authorization.transaction,
      executeAction: async () => { executions += 1; },
    }), { clock: () => NOW }),
    /expired|stale|validity/i,
  );
  const parentState = await parent.transaction.getParentHead(parent.parentRef);
  const authorizationState = await readAuthorizationState(
    authorization.directory,
    fixture.binding.one_use_authorization_id,
  );
  assert.equal(executions, 0);
  assert.equal(parentState.status, 'active');
  assert.equal(parentState.head_hash, fixture.capsule.parent.state_hash);
  assert.equal(authorizationState.status, 'active');
  assert.equal(authorizationState.result_hash, null);
});

test('a synchronous consequential executor failure leaves authorization and parent ambiguous', async (t) => {
  const directory = await temporaryDirectory(t, 'sync-executor-failure');
  const fixture = proposalFixture();
  const parent = await createParentAuthority(path.join(directory, 'parent'), fixture);
  const authorization = await createExecutionAuthority(
    path.join(directory, 'authorizations'),
    fixture,
  );
  let executorCalls = 0;

  const error = await commitPreparedArtifact(inputWithAuthority(fixture, parent, {
    executionAuthorizationTransaction: authorization.transaction,
    executeAction() {
      executorCalls += 1;
      throw new Error('synchronous executor failure after invocation');
    },
  })).then(() => null, (caught) => caught);
  const parentState = await parent.transaction.getParentHead(parent.parentRef);
  const authorizationState = await readAuthorizationState(
    authorization.directory,
    fixture.binding.one_use_authorization_id,
  );
  assert.ok(error instanceof CommitAmbiguousError);
  assert.equal(error.code, 'RISK_FORK_COMMIT_AMBIGUOUS');
  assert.equal(executorCalls, 1);
  assert.equal(authorizationState.status, 'ambiguous');
  assert.equal(parentState.status, 'ambiguous');
  assert.ok(parentState.pending_transaction?.transaction_ref);
});
