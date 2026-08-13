import { randomUUID } from 'node:crypto';
import { mkdir, open, readFile, rename, unlink } from 'node:fs/promises';
import path from 'node:path';

import { assertCanonicalJson, sha256Ref } from './canonical.mjs';
import {
  assertFreshForkIdentity,
  verifyExecutionBinding,
  verifySavepointCapsule,
} from './contracts.mjs';
import { verifyLifecycle } from './lifecycle.mjs';
import {
  revalidateCommitArtifact,
  verifyCommitArtifact,
  verifyWorkspaceRequiredTests,
} from './taint-gate.mjs';
import {
  assertAllowedKeys,
  assertPlainObject,
  cloneJson,
  deepFreeze,
  optionalString,
  requireIsoDate,
  requireOpaqueRef,
  requireSha256Ref,
  requireString,
  safeEqual,
} from './util.mjs';

export class CommitAmbiguousError extends Error {
  constructor(message, evidence) {
    super(message);
    this.name = 'CommitAmbiguousError';
    this.code = 'RISK_FORK_COMMIT_AMBIGUOUS';
    this.evidence = evidence;
  }
}

const FILE_PARENT_HEAD_TRANSACTIONS = new WeakMap();
const FILE_EXECUTION_AUTHORIZATION_TRANSACTIONS = new WeakMap();

async function atomicWriteJson(file, value) {
  const temporary = `${file}.${randomUUID()}.tmp`;
  const handle = await open(temporary, 'wx', 0o600);
  try {
    await handle.writeFile(`${JSON.stringify(value, null, 2)}\n`, 'utf8');
    await handle.sync();
  } finally {
    await handle.close();
  }
  await rename(temporary, file);
}

async function readJsonOrNull(file) {
  try {
    return JSON.parse(await readFile(file, 'utf8'));
  } catch (error) {
    if (error?.code === 'ENOENT') return null;
    throw error;
  }
}

async function tryAcquireFileLock(file) {
  let handle = null;
  try {
    handle = await open(file, 'wx', 0o600);
    await handle.writeFile(`${process.pid}\n`, 'utf8');
    await handle.sync();
    return handle;
  } catch (error) {
    if (handle) {
      await handle.close().catch(() => {});
      await unlink(file).catch(() => {});
    }
    if (error?.code === 'EEXIST') return null;
    throw error;
  }
}

async function inspectFileLock(file) {
  let value;
  try {
    value = (await readFile(file, 'utf8')).trim();
  } catch (error) {
    if (error?.code === 'ENOENT') {
      return { owner_status: 'missing', owner_pid: null };
    }
    return { owner_status: 'unknown', owner_pid: null };
  }
  if (!/^[1-9]\d*$/.test(value)) {
    return { owner_status: 'unknown', owner_pid: null };
  }
  const ownerPid = Number.parseInt(value, 10);
  if (!Number.isSafeInteger(ownerPid)) {
    return { owner_status: 'unknown', owner_pid: null };
  }
  try {
    process.kill(ownerPid, 0);
    return { owner_status: 'live', owner_pid: ownerPid };
  } catch (error) {
    if (error?.code === 'ESRCH') return { owner_status: 'dead', owner_pid: ownerPid };
    if (error?.code === 'EPERM') return { owner_status: 'live', owner_pid: ownerPid };
    return { owner_status: 'unknown', owner_pid: ownerPid };
  }
}

function codedTransactionError(message, code, evidence) {
  const error = new Error(message);
  error.code = code;
  error.evidence = cloneJson(evidence);
  return error;
}

function fileLockConflict({ kind, stateEvidence, lock }) {
  const evidence = {
    ...stateEvidence,
    lock_owner_status: lock.owner_status,
    lock_owner_pid: lock.owner_pid,
  };
  if (lock.owner_status === 'dead') {
    return codedTransactionError(
      `The ${kind} lock owner exited before releasing its durable reservation`,
      kind === 'parent-head' ? 'PARENT_HEAD_LOCK_STALE' : 'AUTHORIZATION_LOCK_STALE',
      evidence,
    );
  }
  if (lock.owner_status === 'live') {
    return codedTransactionError(
      `The ${kind} transaction is already reserved by another live process`,
      kind === 'parent-head'
        ? 'PARENT_HEAD_TRANSACTION_RESERVED'
        : 'AUTHORIZATION_TRANSACTION_RESERVED',
      evidence,
    );
  }
  return new CommitAmbiguousError(
    `The ${kind} lock exists but its owner cannot be established; automatic retry is forbidden`,
    evidence,
  );
}

async function acquireInterpretedFileLock({ file, kind, inspectPersistedState }) {
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const handle = await tryAcquireFileLock(file);
    if (handle) return handle;

    // The durable state is authoritative. Interpret it before lock-owner
    // metadata so a process crash cannot mask a committing/consuming record as
    // a generic lock collision forever.
    const stateEvidence = await inspectPersistedState();
    const lock = await inspectFileLock(file);
    if (lock.owner_status === 'missing' && attempt === 0) continue;
    throw fileLockConflict({ kind, stateEvidence, lock });
  }
  throw new CommitAmbiguousError(
    `The ${kind} lock changed while its durable state was inspected; automatic retry is forbidden`,
    { lock_owner_status: 'unknown', lock_owner_pid: null },
  );
}

async function releaseFileLock(handle, file) {
  try {
    await handle.close();
  } finally {
    await unlink(file).catch((error) => {
      if (error?.code !== 'ENOENT') throw error;
    });
  }
}

function assertParentHeadAvailable(current, { parentRef, expectedHead }) {
  if (!current) {
    throw codedTransactionError(
      'Authoritative parent head is not initialized',
      'PARENT_HEAD_UNINITIALIZED',
      { parent_ref: parentRef, parent_state_status: 'absent', pending_transaction: null },
    );
  }
  if (current.status !== 'active') {
    throw new CommitAmbiguousError('Authoritative parent head has an unresolved transaction', {
      parent_ref: parentRef,
      parent_state_status: current.status,
      pending_transaction: current.pending_transaction ?? null,
    });
  }
  if (!safeEqual(current.head_hash, expectedHead)) {
    throw codedTransactionError(
      'Authoritative parent head is stale',
      'PARENT_HEAD_STALE',
      {
        parent_ref: parentRef,
        parent_state_status: current.status,
        expected_parent_head_hash: expectedHead,
        observed_parent_head_hash: current.head_hash ?? null,
        pending_transaction: current.pending_transaction ?? null,
      },
    );
  }
  return current;
}

function assertAuthorizationActive(current, authorizationId) {
  if (!current) {
    throw codedTransactionError(
      'Execution authorization is absent',
      'AUTHORIZATION_ABSENT',
      { authorization_id: authorizationId, status: 'absent' },
    );
  }
  if (current.status === 'revoked') {
    throw codedTransactionError(
      'Execution authorization is revoked',
      'AUTHORIZATION_REVOKED',
      { authorization_id: authorizationId, status: current.status },
    );
  }
  if (current.status === 'consumed') {
    throw codedTransactionError(
      'Execution authorization is already consumed',
      'AUTHORIZATION_CONSUMED',
      { authorization_id: authorizationId, status: current.status },
    );
  }
  if (current.status !== 'active') {
    throw new CommitAmbiguousError('Execution authorization has unresolved consumption state', {
      authorization_id: authorizationId,
      status: current.status,
    });
  }
  return current;
}

function parentTransactionPaths(directory, parentRef) {
  const name = sha256Ref(requireOpaqueRef(parentRef, 'parent_ref')).slice(7);
  return {
    state: path.join(directory, `${name}.parent-head.json`),
    authority: path.join(directory, `${name}.commit-authority.json`),
    lock: path.join(directory, `${name}.parent-head.lock`),
  };
}

export function deriveParentAuthorityRef({ agent_id: agentId, session_id: sessionId } = {}) {
  return sha256Ref({
    schema: 'agoragentic.risk-fork.parent-authority-identity.v1',
    agent_id: requireOpaqueRef(agentId, 'parent agent_id'),
    session_id: requireOpaqueRef(sessionId, 'parent session_id'),
  });
}

function assertParentActiveWithoutExpectedHead(current, parentRef) {
  if (!current) {
    throw codedTransactionError('Authoritative parent head is not initialized', 'PARENT_HEAD_UNINITIALIZED', {
      parent_ref: parentRef,
      parent_state_status: 'absent',
      pending_transaction: null,
    });
  }
  if (current.status !== 'active') {
    throw new CommitAmbiguousError('Authoritative parent head has an unresolved transaction', {
      parent_ref: parentRef,
      parent_state_status: current.status,
      pending_transaction: current.pending_transaction ?? null,
    });
  }
  return current;
}

function emptyParentAuthority(parentRef, now) {
  return {
    schema: 'agoragentic.risk-fork.file-parent-commit-authority.v1',
    parent_ref: parentRef,
    current_governance: null,
    approvals: [],
    updated_at: now,
  };
}

function normalizeStoredApproval(value, label = 'stored commit approval') {
  assertPlainObject(value, label);
  assertAllowedKeys(value, [
    'status',
    'artifact_hash',
    'capsule_hash',
    'parent_state_hash',
    'commit_type',
    'governance_hash',
    'evidence_ref',
    'evidence_hash',
    'registered_at',
    'updated_at',
    'transaction_ref',
    'consumed_at',
    'revocation_evidence_ref',
    'revocation_evidence_hash',
  ], label);
  if (!['active', 'consuming', 'consumed', 'revoked', 'superseded'].includes(value.status)) {
    throw new Error(`${label}.status is invalid`);
  }
  const normalized = {
    status: value.status,
    artifact_hash: requireSha256Ref(value.artifact_hash, `${label}.artifact_hash`),
    capsule_hash: requireSha256Ref(value.capsule_hash, `${label}.capsule_hash`),
    parent_state_hash: requireSha256Ref(value.parent_state_hash, `${label}.parent_state_hash`),
    commit_type: requireOpaqueRef(value.commit_type, `${label}.commit_type`),
    governance_hash: requireSha256Ref(value.governance_hash, `${label}.governance_hash`),
    evidence_ref: requireOpaqueRef(value.evidence_ref, `${label}.evidence_ref`),
    evidence_hash: requireSha256Ref(value.evidence_hash, `${label}.evidence_hash`),
    registered_at: requireIsoDate(value.registered_at, `${label}.registered_at`),
    updated_at: requireIsoDate(value.updated_at, `${label}.updated_at`),
    transaction_ref: value.transaction_ref == null
      ? null
      : requireOpaqueRef(value.transaction_ref, `${label}.transaction_ref`),
    consumed_at: value.consumed_at == null
      ? null
      : requireIsoDate(value.consumed_at, `${label}.consumed_at`),
    revocation_evidence_ref: value.revocation_evidence_ref == null
      ? null
      : requireOpaqueRef(value.revocation_evidence_ref, `${label}.revocation_evidence_ref`),
    revocation_evidence_hash: value.revocation_evidence_hash == null
      ? null
      : requireSha256Ref(value.revocation_evidence_hash, `${label}.revocation_evidence_hash`),
  };
  const hasTransaction = normalized.transaction_ref !== null;
  const hasConsumption = normalized.consumed_at !== null;
  const hasRevocation = normalized.revocation_evidence_ref !== null
    && normalized.revocation_evidence_hash !== null;
  const partialRevocation = (normalized.revocation_evidence_ref === null)
    !== (normalized.revocation_evidence_hash === null);
  if (partialRevocation
    || (normalized.status === 'active'
      && (hasTransaction || hasConsumption || hasRevocation))
    || (normalized.status === 'consuming'
      && (!hasTransaction || hasConsumption || hasRevocation))
    || (normalized.status === 'consumed'
      && (!hasTransaction || !hasConsumption || hasRevocation))
    || (normalized.status === 'revoked'
      && (hasTransaction || hasConsumption || !hasRevocation))
    || (normalized.status === 'superseded'
      && (hasTransaction || hasConsumption || hasRevocation))) {
    throw new Error(`${label} has an impossible status transition shape`);
  }
  return normalized;
}

function assertClockNotBeforePersisted(now, persistedAt, label, evidence = {}) {
  if (Date.parse(now) < Date.parse(requireIsoDate(persistedAt, `${label} persisted time`))) {
    throw codedTransactionError(
      `${label} clock moved backward relative to durable state`,
      'AUTHORITY_CLOCK_ROLLBACK',
      { ...evidence, observed_at: now, persisted_at: persistedAt },
    );
  }
}

function normalizeParentAuthority(value, parentRef, now) {
  if (value == null) return emptyParentAuthority(parentRef, now);
  assertPlainObject(value, 'file parent commit authority');
  assertAllowedKeys(value, [
    'schema',
    'parent_ref',
    'current_governance',
    'approvals',
    'updated_at',
  ], 'file parent commit authority');
  if (value.schema !== 'agoragentic.risk-fork.file-parent-commit-authority.v1'
    || value.parent_ref !== parentRef
    || !Array.isArray(value.approvals)) {
    throw new Error('File parent commit authority record is invalid');
  }
  return {
    schema: value.schema,
    parent_ref: parentRef,
    current_governance: value.current_governance == null
      ? null
      : normalizeCurrentGovernance(value.current_governance),
    approvals: value.approvals.map((approval, index) => normalizeStoredApproval(
      approval,
      `file parent commit authority.approvals[${index}]`,
    )),
    updated_at: requireIsoDate(value.updated_at, 'file parent commit authority.updated_at'),
  };
}

async function acquireParentAuthorityLock(directory, parentRef, expectedHead) {
  const files = parentTransactionPaths(directory, parentRef);
  const lock = await acquireInterpretedFileLock({
    file: files.lock,
    kind: 'parent-head',
    inspectPersistedState: async () => {
      const persisted = await readJsonOrNull(files.state);
      const current = expectedHead === undefined
        ? assertParentActiveWithoutExpectedHead(persisted, parentRef)
        : assertParentHeadAvailable(persisted, { parentRef, expectedHead });
      return {
        parent_ref: parentRef,
        parent_state_status: current.status,
        pending_transaction: current.pending_transaction ?? null,
      };
    },
  });
  return { files, lock };
}

function selectExactActiveApproval(authority, request, transactionRef, now) {
  const matches = authority.approvals.filter((approval) => approval.status === 'active'
    && safeEqual(approval.artifact_hash, request.artifact_hash)
    && safeEqual(approval.capsule_hash, request.capsule_hash)
    && safeEqual(approval.parent_state_hash, request.parent_state_hash)
    && safeEqual(approval.commit_type, request.commit_type)
    && safeEqual(approval.governance_hash, request.candidate_governance_hash)
    && safeEqual(approval.evidence_ref, request.preflight_approval.evidence_ref)
    && safeEqual(approval.evidence_hash, request.preflight_approval.evidence_hash));
  if (matches.length !== 1) {
    throw codedTransactionError(
      'Exactly one active clean-host approval is required for the final commit binding',
      'FINAL_COMMIT_APPROVAL_NOT_ACTIVE',
      {
        artifact_hash: request.artifact_hash,
        capsule_hash: request.capsule_hash,
        parent_state_hash: request.parent_state_hash,
        governance_hash: request.candidate_governance_hash,
        matching_active_approvals: matches.length,
      },
    );
  }
  const selected = matches[0];
  const index = authority.approvals.indexOf(selected);
  const consuming = {
    ...selected,
    status: 'consuming',
    transaction_ref: transactionRef,
    updated_at: now,
  };
  return { selected, consuming, index };
}

function buildInternalFinalCommitAuthorityProof({
  authorityRequest,
  governance,
  approval,
  transactionRef,
  linearizedAt,
}) {
  const governanceHash = sha256Ref(governance);
  const evidenceRef = `file-parent-authority:${transactionRef}`;
  const evidenceHash = sha256Ref({
    schema: 'agoragentic.risk-fork.file-parent-commit-authority-evidence.v1',
    request_hash: authorityRequest.request_hash,
    transaction_ref: transactionRef,
    governance_hash: governanceHash,
    approval_evidence_ref: approval.evidence_ref,
    approval_evidence_hash: approval.evidence_hash,
    linearized_at: linearizedAt,
  });
  const linearizationRef = `file-parent-linearization:${transactionRef}`;
  const linearizationHash = sha256Ref({
    request_hash: authorityRequest.request_hash,
    linearized_at: linearizedAt,
    linearization_ref: linearizationRef,
    governance_hash: governanceHash,
    approval_evidence_ref: approval.evidence_ref,
    approval_evidence_hash: approval.evidence_hash,
    authority_evidence_ref: evidenceRef,
    authority_evidence_hash: evidenceHash,
  });
  return deepFreeze({
    schema: 'agoragentic.risk-fork.final-commit-authority-verification.v1',
    status: 'verified',
    atomicity_status: 'verified',
    request_hash: authorityRequest.request_hash,
    linearized_at: linearizedAt,
    linearization_ref: linearizationRef,
    linearization_hash: linearizationHash,
    governance: cloneJson(governance),
    governance_hash: governanceHash,
    approval: {
      schema: 'agoragentic.risk-fork.final-commit-approval.v1',
      status: 'verified',
      authority_request_hash: authorityRequest.request_hash,
      artifact_hash: authorityRequest.artifact_hash,
      capsule_hash: authorityRequest.capsule_hash,
      parent_state_hash: authorityRequest.parent_state_hash,
      governance_hash: governanceHash,
      evidence_ref: approval.evidence_ref,
      evidence_hash: approval.evidence_hash,
    },
    authorization_binding_hash: authorityRequest.authorization_binding_hash,
    evidence_ref: evidenceRef,
    evidence_hash: evidenceHash,
  });
}

async function restoreParentReservation(files, current, authority, evidence) {
  try {
    await atomicWriteJson(files.authority, authority);
    await atomicWriteJson(files.state, current);
  } catch (restoreError) {
    throw new CommitAmbiguousError(
      'A pre-effect parent reservation failure could not be durably restored',
      {
        ...evidence,
        cause: String(restoreError?.message ?? restoreError).slice(0, 1000),
      },
    );
  }
}

function createFileParentHeadInternals(directory, clock) {
  const initialize = async () => {
    await mkdir(directory, { recursive: true });
  };
  const seedParentHead = async ({ parentRef, headHash }) => {
    const parent = requireOpaqueRef(parentRef, 'parentRef');
    const files = parentTransactionPaths(directory, parent);
    const normalizedHead = requireSha256Ref(headHash, 'headHash');
    try {
      const handle = await open(files.state, 'wx', 0o600);
      try {
        await handle.writeFile(`${JSON.stringify({
          schema: 'agoragentic.risk-fork.parent-head.v1',
          parent_ref: parent,
          status: 'active',
          head_hash: normalizedHead,
          updated_at: requireIsoDate(clock(), 'clock result'),
          pending_transaction: null,
          last_transaction: null,
        }, null, 2)}\n`, 'utf8');
        await handle.sync();
      } finally {
        await handle.close();
      }
    } catch (error) {
      if (error?.code !== 'EEXIST') throw error;
      const existing = await readJsonOrNull(files.state);
      if (existing?.status !== 'active' || !safeEqual(existing.head_hash, normalizedHead)) {
        throw new Error('Parent head was already initialized with different or ambiguous state');
      }
    }
  };
  const getParentHead = async (parentRef) => {
    const record = await readJsonOrNull(parentTransactionPaths(directory, parentRef).state);
    return record == null ? null : cloneJson(record);
  };
  const getCommitAuthority = async (parentRef) => {
    const parent = requireOpaqueRef(parentRef, 'parent_ref');
    const files = parentTransactionPaths(directory, parent);
    const value = await readJsonOrNull(files.authority);
    return value == null ? null : cloneJson(value);
  };
  const setCurrentGovernance = async (input) => {
    assertPlainObject(input, 'current governance authority update');
    assertAllowedKeys(input, ['parent_ref', 'governance'], 'current governance authority update');
    const parentRef = requireOpaqueRef(input.parent_ref, 'parent_ref');
    const governance = normalizeCurrentGovernance(input.governance);
    const { files, lock } = await acquireParentAuthorityLock(directory, parentRef);
    try {
      const parent = assertParentActiveWithoutExpectedHead(
        await readJsonOrNull(files.state),
        parentRef,
      );
      const now = requireIsoDate(clock(), 'parent authority clock result');
      const current = normalizeParentAuthority(await readJsonOrNull(files.authority), parentRef, now);
      assertClockNotBeforePersisted(now, parent.updated_at, 'Parent governance update', { parent_ref: parentRef });
      assertClockNotBeforePersisted(now, current.updated_at, 'Parent governance update', { parent_ref: parentRef });
      const governanceChanged = current.current_governance == null
        || !safeEqual(sha256Ref(current.current_governance), sha256Ref(governance));
      const next = {
        ...current,
        current_governance: governance,
        approvals: governanceChanged
          ? current.approvals.map((approval) => approval.status === 'active'
            ? { ...approval, status: 'superseded', updated_at: now }
            : approval)
          : current.approvals,
        updated_at: now,
      };
      await atomicWriteJson(files.authority, next);
      return cloneJson(next);
    } finally {
      await releaseFileLock(lock, files.lock);
    }
  };
  const registerCommitApproval = async (input) => {
    assertPlainObject(input, 'commit approval registration');
    assertAllowedKeys(input, [
      'parent_ref',
      'artifact_hash',
      'capsule_hash',
      'parent_state_hash',
      'commit_type',
      'governance_hash',
      'evidence_ref',
      'evidence_hash',
    ], 'commit approval registration');
    const parentRef = requireOpaqueRef(input.parent_ref, 'parent_ref');
    const parentStateHash = requireSha256Ref(input.parent_state_hash, 'parent_state_hash');
    const { files, lock } = await acquireParentAuthorityLock(directory, parentRef, parentStateHash);
    try {
      const parent = assertParentHeadAvailable(await readJsonOrNull(files.state), {
        parentRef,
        expectedHead: parentStateHash,
      });
      const now = requireIsoDate(clock(), 'parent authority clock result');
      const current = normalizeParentAuthority(await readJsonOrNull(files.authority), parentRef, now);
      assertClockNotBeforePersisted(now, parent.updated_at, 'Commit approval registration', { parent_ref: parentRef });
      assertClockNotBeforePersisted(now, current.updated_at, 'Commit approval registration', { parent_ref: parentRef });
      if (current.current_governance == null) {
        throw codedTransactionError(
          'Current governance must be installed before registering a commit approval',
          'CURRENT_GOVERNANCE_REQUIRED',
          { parent_ref: parentRef },
        );
      }
      const governanceHash = requireSha256Ref(input.governance_hash, 'governance_hash');
      if (!safeEqual(governanceHash, sha256Ref(current.current_governance))) {
        throw codedTransactionError(
          'Commit approval governance hash does not match current clean-host governance',
          'COMMIT_APPROVAL_GOVERNANCE_MISMATCH',
          { parent_ref: parentRef, governance_hash: governanceHash },
        );
      }
      const evidenceRef = requireOpaqueRef(input.evidence_ref, 'evidence_ref');
      const evidenceHash = requireSha256Ref(input.evidence_hash, 'evidence_hash');
      if (current.approvals.some((approval) => approval.evidence_ref === evidenceRef)) {
        throw new Error('Commit approval evidence_ref is already registered');
      }
      const record = {
        status: 'active',
        artifact_hash: requireSha256Ref(input.artifact_hash, 'artifact_hash'),
        capsule_hash: requireSha256Ref(input.capsule_hash, 'capsule_hash'),
        parent_state_hash: parentStateHash,
        commit_type: requireOpaqueRef(input.commit_type, 'commit_type'),
        governance_hash: governanceHash,
        evidence_ref: evidenceRef,
        evidence_hash: evidenceHash,
        registered_at: now,
        updated_at: now,
        transaction_ref: null,
        consumed_at: null,
        revocation_evidence_ref: null,
        revocation_evidence_hash: null,
      };
      const next = { ...current, approvals: [...current.approvals, record], updated_at: now };
      await atomicWriteJson(files.authority, next);
      return cloneJson(record);
    } finally {
      await releaseFileLock(lock, files.lock);
    }
  };
  const revokeCommitApproval = async (input) => {
    assertPlainObject(input, 'commit approval revocation');
    assertAllowedKeys(input, [
      'parent_ref',
      'approval_evidence_ref',
      'approval_evidence_hash',
      'evidence_ref',
      'evidence_hash',
    ], 'commit approval revocation');
    const parentRef = requireOpaqueRef(input.parent_ref, 'parent_ref');
    const approvalEvidenceRef = requireOpaqueRef(
      input.approval_evidence_ref,
      'approval_evidence_ref',
    );
    const approvalEvidenceHash = requireSha256Ref(
      input.approval_evidence_hash,
      'approval_evidence_hash',
    );
    const { files, lock } = await acquireParentAuthorityLock(directory, parentRef);
    try {
      const parent = assertParentActiveWithoutExpectedHead(
        await readJsonOrNull(files.state),
        parentRef,
      );
      const now = requireIsoDate(clock(), 'parent authority clock result');
      const current = normalizeParentAuthority(await readJsonOrNull(files.authority), parentRef, now);
      assertClockNotBeforePersisted(now, parent.updated_at, 'Commit approval revocation', { parent_ref: parentRef });
      assertClockNotBeforePersisted(now, current.updated_at, 'Commit approval revocation', { parent_ref: parentRef });
      const index = current.approvals.findIndex((approval) => approval.status === 'active'
        && safeEqual(approval.evidence_ref, approvalEvidenceRef)
        && safeEqual(approval.evidence_hash, approvalEvidenceHash));
      if (index < 0) {
        throw codedTransactionError(
          'The exact active commit approval is not available for revocation',
          'COMMIT_APPROVAL_NOT_ACTIVE',
          { parent_ref: parentRef, approval_evidence_ref: approvalEvidenceRef },
        );
      }
      const revoked = {
        ...current.approvals[index],
        status: 'revoked',
        updated_at: now,
        revocation_evidence_ref: requireOpaqueRef(input.evidence_ref, 'evidence_ref'),
        revocation_evidence_hash: requireSha256Ref(input.evidence_hash, 'evidence_hash'),
      };
      const approvals = [...current.approvals];
      approvals[index] = revoked;
      await atomicWriteJson(files.authority, { ...current, approvals, updated_at: now });
      return cloneJson(revoked);
    } finally {
      await releaseFileLock(lock, files.lock);
    }
  };
  const runCommit = async (request, prepareUnderReservation, performCommitEffect) => {
    assertPlainObject(request, 'parent head transaction request');
    assertAllowedKeys(request, [
      'parent_ref',
      'expected_parent_head_hash',
      'artifact_hash',
      'capsule_hash',
      'commit_type',
    ], 'parent head transaction request');
    if (typeof prepareUnderReservation !== 'function'
      || typeof performCommitEffect !== 'function') {
      throw new TypeError('Internal parent authority callbacks are required');
    }
    const parentRef = requireOpaqueRef(request.parent_ref, 'parent_ref');
    const expectedHead = requireSha256Ref(
      request.expected_parent_head_hash,
      'expected_parent_head_hash',
    );
    const artifactHash = requireSha256Ref(request.artifact_hash, 'artifact_hash');
    const capsuleHash = requireSha256Ref(request.capsule_hash, 'capsule_hash');
    const commitType = requireOpaqueRef(request.commit_type, 'commit_type');
    const { files, lock } = await acquireParentAuthorityLock(directory, parentRef, expectedHead);
    let externalEffectStarted = false;
    let externalEffectCalls = 0;
    let current;
    let authorityBefore;
    let intent;
    let selectedApproval;
    try {
      current = assertParentHeadAvailable(await readJsonOrNull(files.state), {
        parentRef,
        expectedHead,
      });
      const startedAt = requireIsoDate(clock(), 'parent transaction clock result');
      authorityBefore = normalizeParentAuthority(
        await readJsonOrNull(files.authority),
        parentRef,
        startedAt,
      );
      assertClockNotBeforePersisted(startedAt, current.updated_at, 'Parent commit', { parent_ref: parentRef });
      assertClockNotBeforePersisted(startedAt, authorityBefore.updated_at, 'Parent commit', { parent_ref: parentRef });
      if (authorityBefore.current_governance == null) {
        throw codedTransactionError(
          'The concrete parent transaction has no current governance authority',
          'CURRENT_GOVERNANCE_REQUIRED',
          { parent_ref: parentRef },
        );
      }
      const transactionRef = `parent-transaction:${randomUUID()}`;
      intent = {
        transaction_ref: transactionRef,
        previous_head_hash: expectedHead,
        artifact_hash: artifactHash,
        capsule_hash: capsuleHash,
        commit_type: commitType,
        governance_hash: sha256Ref(authorityBefore.current_governance),
        governance_evidence_hash: authorityBefore.current_governance.evidence_hash,
        started_at: startedAt,
      };
      await atomicWriteJson(files.state, {
        ...current,
        status: 'committing',
        updated_at: startedAt,
        pending_transaction: intent,
      });

      let authorityRequest;
      let authorityReserved = authorityBefore;
      let proof;
      try {
        authorityRequest = await prepareUnderReservation(
          deepFreeze(cloneJson(authorityBefore.current_governance)),
          startedAt,
        );
        assertCanonicalJson(authorityRequest);
        if (!safeEqual(authorityRequest.artifact_hash, artifactHash)
          || !safeEqual(authorityRequest.capsule_hash, capsuleHash)
          || !safeEqual(authorityRequest.parent_state_hash, expectedHead)
          || !safeEqual(authorityRequest.commit_type, commitType)
          || !safeEqual(
            authorityRequest.candidate_governance_hash,
            sha256Ref(authorityBefore.current_governance),
          )) {
          throw codedTransactionError(
            'Final commit-authority request does not match the reserved parent authority',
            'FINAL_COMMIT_AUTHORITY_BINDING_MISMATCH',
            { parent_ref: parentRef, transaction_ref: transactionRef },
          );
        }
        const selected = selectExactActiveApproval(
          authorityBefore,
          authorityRequest,
          transactionRef,
          startedAt,
        );
        selectedApproval = selected.consuming;
        const approvals = [...authorityBefore.approvals];
        approvals[selected.index] = selectedApproval;
        authorityReserved = { ...authorityBefore, approvals, updated_at: startedAt };
        await atomicWriteJson(files.authority, authorityReserved);
        await atomicWriteJson(files.state, {
          ...current,
          status: 'committing',
          updated_at: startedAt,
          pending_transaction: {
            ...intent,
            authority_request_hash: authorityRequest.request_hash,
            approval_evidence_ref: selectedApproval.evidence_ref,
            approval_evidence_hash: selectedApproval.evidence_hash,
          },
        });
        const linearizedAt = requireIsoDate(clock(), 'parent authority final clock result');
        if (Date.parse(linearizedAt) < Date.parse(startedAt)
          || Date.parse(linearizedAt) < Date.parse(authorityRequest.requested_at)) {
          throw codedTransactionError(
            'Parent authority clock moved backward before final commit linearization',
            'FINAL_COMMIT_AUTHORITY_CLOCK_ROLLBACK',
            {
              parent_ref: parentRef,
              started_at: startedAt,
              requested_at: authorityRequest.requested_at,
              linearized_at: linearizedAt,
            },
          );
        }
        proof = buildInternalFinalCommitAuthorityProof({
          authorityRequest,
          governance: authorityBefore.current_governance,
          approval: selectedApproval,
          transactionRef,
          linearizedAt,
        });
      } catch (error) {
        await restoreParentReservation(files, current, authorityBefore, {
          parent_ref: parentRef,
          transaction_ref: intent.transaction_ref,
        });
        throw error;
      }

      const invokeExternalEffect = (operation) => {
        externalEffectCalls += 1;
        if (externalEffectCalls !== 1) {
          throw new Error('Internal clean commit attempted more than one external effect');
        }
        if (typeof operation !== 'function') {
          throw new TypeError('Internal clean commit external effect operation is required');
        }
        externalEffectStarted = true;
        return operation();
      };
      let result;
      try {
        const effectPromise = performCommitEffect(
          proof,
          invokeExternalEffect,
          () => requireIsoDate(clock(), 'parent authority execution clock result'),
        );
        const outcome = await effectPromise;
        if (!externalEffectStarted || externalEffectCalls !== 1) {
          throw new Error('Internal clean commit returned without exactly one external effect');
        }
        assertPlainObject(outcome, 'internal clean commit effect outcome');
        assertAllowedKeys(outcome, ['result', 'observed_at'], 'internal clean commit effect outcome');
        const observedAt = requireIsoDate(outcome.observed_at, 'internal clean commit observed_at');
        if (Date.parse(observedAt) < Date.parse(proof.linearized_at)) {
          throw codedTransactionError(
            'Final commit effect observation predates its parent authority linearization',
            'FINAL_COMMIT_AUTHORITY_CLOCK_ROLLBACK',
            {
              linearized_at: proof.linearized_at,
              observed_at: observedAt,
            },
          );
        }
        result = cloneJson(outcome.result ?? null);
        proof = deepFreeze({ ...cloneJson(proof), observed_at: observedAt });
      } catch (error) {
        if (!externalEffectStarted && !(error instanceof CommitAmbiguousError)) {
          await restoreParentReservation(files, current, authorityBefore, {
            parent_ref: parentRef,
            transaction_ref: intent.transaction_ref,
          });
          throw error;
        }
        const failure = optionalString(error?.message, 'mutation error', { maxLength: 1000 });
        await atomicWriteJson(files.state, {
          ...current,
          status: 'ambiguous',
          updated_at: requireIsoDate(clock(), 'clock result'),
          pending_transaction: { ...intent, failure },
        });
        if (error instanceof CommitAmbiguousError) throw error;
        throw new CommitAmbiguousError(
          'Parent commit effect began or nested authority became ambiguous; automatic retry is forbidden',
          { parent_ref: parentRef, transaction_ref: intent.transaction_ref, cause: failure },
        );
      }

      const completedAt = proof.observed_at;
      const resultHash = sha256Ref(result ?? null);
      const nextHead = sha256Ref({
        previous_head_hash: expectedHead,
        artifact_hash: artifactHash,
        result_hash: resultHash,
        governance_evidence_hash: authorityBefore.current_governance.evidence_hash,
      });
      const transactionHash = sha256Ref({
        ...intent,
        authority_request_hash: proof.request_hash,
        final_authority_hash: proof.linearization_hash,
        next_head_hash: nextHead,
        result_hash: resultHash,
      });
      const approvalIndex = authorityBefore.approvals.findIndex((approval) =>
        safeEqual(approval.evidence_ref, selectedApproval.evidence_ref));
      const approvals = [...authorityBefore.approvals];
      approvals[approvalIndex] = {
        ...selectedApproval,
        status: 'consumed',
        updated_at: completedAt,
        consumed_at: completedAt,
      };
      try {
        await atomicWriteJson(files.authority, {
          ...authorityBefore,
          approvals,
          updated_at: completedAt,
        });
        await atomicWriteJson(files.state, {
          schema: 'agoragentic.risk-fork.parent-head.v1',
          parent_ref: parentRef,
          status: 'active',
          head_hash: nextHead,
          updated_at: completedAt,
          pending_transaction: null,
          last_transaction: {
            ...intent,
            authority_request_hash: proof.request_hash,
            final_authority_hash: proof.linearization_hash,
            next_head_hash: nextHead,
            result_hash: resultHash,
            transaction_hash: transactionHash,
          },
        });
      } catch (error) {
        throw new CommitAmbiguousError(
          'Parent commit effect completed but durable authority finalization failed',
          {
            parent_ref: parentRef,
            transaction_ref: intent.transaction_ref,
            cause: String(error?.message ?? error).slice(0, 1000),
          },
        );
      }
      return {
        status: 'committed',
        previous_head_hash: expectedHead,
        next_head_hash: nextHead,
        result: cloneJson(result ?? null),
        result_hash: resultHash,
        transaction_ref: intent.transaction_ref,
        transaction_hash: transactionHash,
      };
    } finally {
      await releaseFileLock(lock, files.lock);
    }
  };
  return Object.freeze({
    initialize,
    seedParentHead,
    getParentHead,
    getCommitAuthority,
    setCurrentGovernance,
    registerCommitApproval,
    revokeCommitApproval,
    runCommit,
  });
}

export class FileParentHeadTransaction {
  constructor({ directory, clock = () => new Date() }) {
    if (new.target !== FileParentHeadTransaction) {
      throw new TypeError('FileParentHeadTransaction cannot be subclassed');
    }
    if (typeof clock !== 'function') throw new TypeError('parent transaction clock must be a function');
    const resolvedDirectory = path.resolve(requireString(directory, 'parent transaction directory'));
    FILE_PARENT_HEAD_TRANSACTIONS.set(
      this,
      createFileParentHeadInternals(resolvedDirectory, clock),
    );
    Object.freeze(this);
  }

  async initialize() {
    await FILE_PARENT_HEAD_TRANSACTIONS.get(this).initialize();
    return this;
  }

  async seedParentHead(input) {
    await FILE_PARENT_HEAD_TRANSACTIONS.get(this).seedParentHead(input);
    return this;
  }

  getParentHead(parentRef) {
    return FILE_PARENT_HEAD_TRANSACTIONS.get(this).getParentHead(parentRef);
  }

  getCommitAuthority(parentRef) {
    return FILE_PARENT_HEAD_TRANSACTIONS.get(this).getCommitAuthority(parentRef);
  }

  setCurrentGovernance(input) {
    return FILE_PARENT_HEAD_TRANSACTIONS.get(this).setCurrentGovernance(input);
  }

  registerCommitApproval(input) {
    return FILE_PARENT_HEAD_TRANSACTIONS.get(this).registerCommitApproval(input);
  }

  revokeCommitApproval(input) {
    return FILE_PARENT_HEAD_TRANSACTIONS.get(this).revokeCommitApproval(input);
  }
}

Object.freeze(FileParentHeadTransaction.prototype);
Object.freeze(FileParentHeadTransaction);

async function verifyExecutionAuthorizationIntegrity(
  verifyAuthorizationIntegrity,
  current,
  request,
  now,
) {
  if (typeof verifyAuthorizationIntegrity !== 'function') {
    throw codedTransactionError(
      'Execution authorization consumption requires a trusted signature, integrity, and exact-binding verifier',
      'AUTHORIZATION_VERIFIER_REQUIRED',
      { authorization_id: current.authorization_id, status: current.status },
    );
  }
  const verifierRequest = {
    schema: 'agoragentic.risk-fork.execution-authorization-verification-request.v1',
    authorization_id: current.authorization_id,
    authorization_ref: current.authorization_ref,
    authorization_hash: current.authorization_hash,
    binding_hash: current.binding_hash,
    expires_at: current.expires_at,
    registration_evidence_ref: current.evidence_ref,
    registration_evidence_hash: current.evidence_hash,
    binding: cloneJson(request.binding),
    governance_evidence_ref: requireOpaqueRef(
      request.governance_evidence_ref,
      'governance_evidence_ref',
    ),
    governance_evidence_hash: requireSha256Ref(
      request.governance_evidence_hash,
      'governance_evidence_hash',
    ),
    requested_at: now,
    authority_flags: {
      persisted_registration_is_authority: false,
      trusted_integrity_verifier_required: true,
      local_file_state_is_revocation_authority: true,
    },
    request_hash: null,
  };
  verifierRequest.request_hash = sha256Ref({ ...verifierRequest, request_hash: null });
  const verification = await verifyAuthorizationIntegrity(
    deepFreeze(cloneJson(verifierRequest)),
  );
  assertCanonicalJson(verification);
  assertPlainObject(verification, 'execution authorization verification');
  assertAllowedKeys(verification, [
    'schema',
    'status',
    'request_hash',
    'authorization_id',
    'authorization_ref',
    'authorization_hash',
    'binding_hash',
    'signature_status',
    'integrity_status',
    'exact_binding_status',
    'evidence_ref',
    'evidence_hash',
  ], 'execution authorization verification');
  const exactBindings = [
    ['request_hash', verification.request_hash, verifierRequest.request_hash],
    ['authorization_id', verification.authorization_id, current.authorization_id],
    ['authorization_ref', verification.authorization_ref, current.authorization_ref],
    ['authorization_hash', verification.authorization_hash, current.authorization_hash],
    ['binding_hash', verification.binding_hash, current.binding_hash],
  ];
  if (verification.schema !== 'agoragentic.risk-fork.execution-authorization-integrity-verification.v1'
    || verification.status !== 'verified'
    || verification.signature_status !== 'verified'
    || verification.integrity_status !== 'verified'
    || verification.exact_binding_status !== 'verified'
    || exactBindings.some(([, observed, expected]) => !safeEqual(observed, expected))) {
    throw codedTransactionError(
      'Trusted execution authorization verification did not prove the exact active binding',
      'AUTHORIZATION_VERIFICATION_FAILED',
      {
        authorization_id: current.authorization_id,
        binding_hash: current.binding_hash,
        request_hash: verifierRequest.request_hash,
      },
    );
  }
  return {
    evidence_ref: requireOpaqueRef(
      verification.evidence_ref,
      'execution authorization verification.evidence_ref',
    ),
    evidence_hash: requireSha256Ref(
      verification.evidence_hash,
      'execution authorization verification.evidence_hash',
    ),
  };
}

function verifyCurrentExecutionAuthorizationBinding(current, request, now) {
  if (!safeEqual(request.binding.binding_hash, request.binding_hash)
    || !safeEqual(current.expires_at, request.binding.validity.expires_at)
    || JSON.stringify(request.binding.mcp) !== JSON.stringify(request.mcp)
    || JSON.stringify(request.binding.commercial) !== JSON.stringify(request.commercial)
    || JSON.stringify(request.binding.governance) !== JSON.stringify(request.governance)
    || JSON.stringify(request.binding.validity) !== JSON.stringify(request.validity)) {
    const error = new Error('Execution authorization request fields do not reproduce the exact binding');
    error.code = 'AUTHORIZATION_BINDING_MISMATCH';
    throw error;
  }
  if (Date.parse(current.expires_at) <= Date.parse(now)) {
    const error = new Error('Execution authorization is expired');
    error.code = 'AUTHORIZATION_EXPIRED';
    throw error;
  }
  verifyExecutionBinding(request.binding, {
    principal_ref: request.principal_ref,
    action_operation: request.action_operation,
    provider_ref: request.provider_ref,
    target_ref: request.target_ref,
    authorization_ref: request.authorization_ref,
    authorization_hash: request.authorization_hash,
    one_use_authorization_id: request.authorization_id,
  }, { now });
}

function executionAuthorizationPaths(directory, authorizationId) {
  const name = sha256Ref(requireOpaqueRef(authorizationId, 'authorization id')).slice(7);
  return {
    state: path.join(directory, `${name}.execution-authorization.json`),
    lock: path.join(directory, `${name}.execution-authorization.lock`),
  };
}

function createFileExecutionAuthorizationInternals(directory, clock, verifyAuthorizationIntegrity) {
  const initialize = async () => {
    await mkdir(directory, { recursive: true });
  };
  const register = async (input) => {
    assertPlainObject(input, 'execution authorization registration');
    assertAllowedKeys(input, [
      'authorization_id',
      'authorization_ref',
      'authorization_hash',
      'binding_hash',
      'expires_at',
      'evidence_ref',
      'evidence_hash',
    ], 'execution authorization registration');
    const authorizationId = requireOpaqueRef(input.authorization_id, 'authorization_id');
    const files = executionAuthorizationPaths(directory, authorizationId);
    const lock = await acquireInterpretedFileLock({
      file: files.lock,
      kind: 'execution-authorization',
      inspectPersistedState: async () => {
        const existing = await readJsonOrNull(files.state);
        return { authorization_id: authorizationId, status: existing?.status ?? 'absent' };
      },
    });
    try {
      if (await readJsonOrNull(files.state)) {
        throw new Error('Execution authorization is already registered');
      }
      const record = {
        schema: 'agoragentic.risk-fork.execution-authorization-state.v1',
        status: 'active',
        authorization_id: authorizationId,
        authorization_ref: requireOpaqueRef(input.authorization_ref, 'authorization_ref'),
        authorization_hash: requireSha256Ref(input.authorization_hash, 'authorization_hash'),
        binding_hash: requireSha256Ref(input.binding_hash, 'binding_hash'),
        expires_at: requireIsoDate(input.expires_at, 'expires_at'),
        evidence_ref: requireOpaqueRef(input.evidence_ref, 'evidence_ref'),
        evidence_hash: requireSha256Ref(input.evidence_hash, 'evidence_hash'),
        updated_at: requireIsoDate(clock(), 'clock result'),
        result_hash: null,
        failure: null,
      };
      await atomicWriteJson(files.state, record);
      return cloneJson(record);
    } finally {
      await releaseFileLock(lock, files.lock);
    }
  };
  const revoke = async ({ authorization_id: authorizationId, evidence_ref: evidenceRef, evidence_hash: evidenceHash }) => {
    const normalizedAuthorizationId = requireOpaqueRef(authorizationId, 'authorization_id');
    const files = executionAuthorizationPaths(directory, normalizedAuthorizationId);
    const lock = await acquireInterpretedFileLock({
      file: files.lock,
      kind: 'execution-authorization',
      inspectPersistedState: async () => {
        const current = assertAuthorizationActive(
          await readJsonOrNull(files.state),
          normalizedAuthorizationId,
        );
        return { authorization_id: normalizedAuthorizationId, status: current.status };
      },
    });
    try {
      const current = assertAuthorizationActive(
        await readJsonOrNull(files.state),
        normalizedAuthorizationId,
      );
      const now = requireIsoDate(clock(), 'authorization revocation clock result');
      assertClockNotBeforePersisted(now, current.updated_at, 'Authorization revocation', {
        authorization_id: normalizedAuthorizationId,
      });
      const revoked = {
        ...current,
        status: 'revoked',
        updated_at: now,
        evidence_ref: requireOpaqueRef(evidenceRef, 'evidence_ref'),
        evidence_hash: requireSha256Ref(evidenceHash, 'evidence_hash'),
      };
      await atomicWriteJson(files.state, revoked);
      return cloneJson(revoked);
    } finally {
      await releaseFileLock(lock, files.lock);
    }
  };
  const runConsumption = async (
    request,
    sampleParentAuthorityClock,
    prepareAndExecute,
  ) => {
    assertPlainObject(request, 'execution authorization transaction request');
    assertAllowedKeys(request, [
      'authorization_id',
      'authorization_ref',
      'authorization_hash',
      'binding_hash',
      'binding',
      'principal_ref',
      'action_operation',
      'provider_ref',
      'target_ref',
      'mcp',
      'commercial',
      'governance',
      'validity',
      'governance_evidence_ref',
      'governance_evidence_hash',
    ], 'execution authorization transaction request');
    if (typeof sampleParentAuthorityClock !== 'function'
      || typeof prepareAndExecute !== 'function') {
      throw new TypeError('Internal authorization transaction callbacks are required');
    }
    const authorizationId = requireOpaqueRef(request.authorization_id, 'authorization_id');
    const files = executionAuthorizationPaths(directory, authorizationId);
    const lock = await acquireInterpretedFileLock({
      file: files.lock,
      kind: 'execution-authorization',
      inspectPersistedState: async () => {
        const current = assertAuthorizationActive(await readJsonOrNull(files.state), authorizationId);
        return { authorization_id: authorizationId, status: current.status };
      },
    });
    let executionStarted = false;
    let executionNow = null;
    try {
      const current = assertAuthorizationActive(await readJsonOrNull(files.state), authorizationId);
      for (const [field, observed] of [
        ['authorization_ref', request.authorization_ref],
        ['authorization_hash', request.authorization_hash],
        ['binding_hash', request.binding_hash],
      ]) {
        if (!safeEqual(current[field], observed)) {
          throw codedTransactionError(
            `Execution authorization does not match ${field}`,
            'AUTHORIZATION_BINDING_MISMATCH',
            { authorization_id: authorizationId, field },
          );
        }
      }
      const initialNow = requireIsoDate(clock(), 'authorization transaction clock result');
      assertClockNotBeforePersisted(initialNow, current.updated_at, 'Authorization consumption', {
        authorization_id: authorizationId,
      });
      verifyCurrentExecutionAuthorizationBinding(current, request, initialNow);
      const authorizationVerification = await verifyExecutionAuthorizationIntegrity(
        verifyAuthorizationIntegrity,
        current,
        request,
        initialNow,
      );
      await atomicWriteJson(files.state, {
        ...current,
        status: 'consuming',
        updated_at: initialNow,
      });
      let result;
      try {
        executionNow = requireIsoDate(
          sampleParentAuthorityClock(),
          'parent authority final execution clock result',
        );
        if (Date.parse(executionNow) < Date.parse(initialNow)) {
          throw codedTransactionError(
            'Execution authorization clock moved backward during atomic consumption',
            'AUTHORIZATION_CLOCK_ROLLBACK',
            {
              authorization_id: authorizationId,
              initial_observed_at: initialNow,
              final_observed_at: executionNow,
            },
          );
        }
        verifyCurrentExecutionAuthorizationBinding(current, request, executionNow);
        let executionCalls = 0;
        const invokeAuthorizedExecution = (operation) => {
          executionCalls += 1;
          if (executionCalls !== 1) {
            throw new Error('Internal authorization transaction attempted execution more than once');
          }
          if (typeof operation !== 'function') {
            throw new TypeError('Internal authorized execution operation is required');
          }
          executionStarted = true;
          return operation();
        };
        const executionPromise = prepareAndExecute(
          executionNow,
          invokeAuthorizedExecution,
        );
        result = await executionPromise;
        if (!executionStarted || executionCalls !== 1) {
          throw new Error('Internal authorization transaction returned without exactly one execution');
        }
      } catch (error) {
        if (!executionStarted && !(error instanceof CommitAmbiguousError)) {
          try {
            await atomicWriteJson(files.state, current);
          } catch (restoreError) {
            throw new CommitAmbiguousError(
              'Authorization failed before execution but active state could not be restored',
              {
                authorization_id: authorizationId,
                binding_hash: current.binding_hash,
                cause: String(restoreError?.message ?? restoreError).slice(0, 1000),
              },
            );
          }
          throw error;
        }
        const failure = optionalString(error?.message, 'executor error', { maxLength: 1000 });
        await atomicWriteJson(files.state, {
          ...current,
          status: 'ambiguous',
          updated_at: executionNow ?? initialNow,
          failure,
        });
        if (error instanceof CommitAmbiguousError) throw error;
        throw new CommitAmbiguousError(
          'Authorized execution began; automatic retry is forbidden',
          { authorization_id: authorizationId, binding_hash: current.binding_hash, cause: failure },
        );
      }
      const resultHash = sha256Ref(result ?? null);
      await atomicWriteJson(files.state, {
        ...current,
        status: 'consumed',
        updated_at: executionNow,
        result_hash: resultHash,
        failure: null,
      });
      return {
        status: 'consumed',
        authorization_id: authorizationId,
        authorization_ref: current.authorization_ref,
        authorization_hash: current.authorization_hash,
        binding_hash: current.binding_hash,
        result: cloneJson(result ?? null),
        result_hash: resultHash,
        evidence_ref: authorizationVerification.evidence_ref,
        evidence_hash: authorizationVerification.evidence_hash,
        observed_at: executionNow,
      };
    } finally {
      await releaseFileLock(lock, files.lock);
    }
  };
  return Object.freeze({ initialize, register, revoke, runConsumption });
}

export class FileExecutionAuthorizationTransaction {
  constructor({ directory, clock = () => new Date(), verifyAuthorizationIntegrity } = {}) {
    if (new.target !== FileExecutionAuthorizationTransaction) {
      throw new TypeError('FileExecutionAuthorizationTransaction cannot be subclassed');
    }
    if (typeof clock !== 'function') throw new TypeError('authorization transaction clock must be a function');
    if (verifyAuthorizationIntegrity !== undefined
      && typeof verifyAuthorizationIntegrity !== 'function') {
      throw new TypeError('verifyAuthorizationIntegrity must be a function when supplied');
    }
    const resolvedDirectory = path.resolve(requireString(
      directory,
      'authorization transaction directory',
    ));
    FILE_EXECUTION_AUTHORIZATION_TRANSACTIONS.set(
      this,
      createFileExecutionAuthorizationInternals(
        resolvedDirectory,
        clock,
        verifyAuthorizationIntegrity,
      ),
    );
    Object.freeze(this);
  }

  async initialize() {
    await FILE_EXECUTION_AUTHORIZATION_TRANSACTIONS.get(this).initialize();
    return this;
  }

  registerExecutionAuthorization(input) {
    return FILE_EXECUTION_AUTHORIZATION_TRANSACTIONS.get(this).register(input);
  }

  revokeExecutionAuthorization(input) {
    return FILE_EXECUTION_AUTHORIZATION_TRANSACTIONS.get(this).revoke(input);
  }
}

Object.freeze(FileExecutionAuthorizationTransaction.prototype);
Object.freeze(FileExecutionAuthorizationTransaction);

function verifyDestructionEvidence(value) {
  assertPlainObject(value, 'destruction evidence');
  assertAllowedKeys(value, ['status', 'provider_ref', 'fork_ref', 'evidence_ref', 'evidence_hash'], 'destruction evidence');
  if (value.status !== 'verified') throw new Error('Clean commit requires verified fork destruction evidence');
  return {
    status: 'verified',
    provider_ref: requireOpaqueRef(value.provider_ref, 'destruction evidence.provider_ref'),
    fork_ref: requireOpaqueRef(value.fork_ref, 'destruction evidence.fork_ref'),
    evidence_ref: requireOpaqueRef(value.evidence_ref, 'destruction evidence.evidence_ref'),
    evidence_hash: requireSha256Ref(value.evidence_hash, 'destruction evidence.evidence_hash'),
  };
}

function normalizeGovernanceRecord(value, label, { nullable = false, budget = false } = {}) {
  if (value == null && nullable) return null;
  assertPlainObject(value, label);
  assertAllowedKeys(value, budget
    ? ['ref', 'version', 'hash', 'usage_hash', 'available_amount', 'currency', 'payment_rail']
    : ['ref', 'version', 'hash'], label);
  const normalized = {
    ref: requireOpaqueRef(value.ref, `${label}.ref`),
    version: requireOpaqueRef(value.version, `${label}.version`),
    hash: requireSha256Ref(value.hash, `${label}.hash`),
  };
  if (budget) {
    normalized.usage_hash = requireSha256Ref(value.usage_hash, `${label}.usage_hash`);
    normalized.available_amount = value.available_amount == null
      ? null
      : requireString(value.available_amount, `${label}.available_amount`, { maxLength: 100 });
    normalized.currency = value.currency == null
      ? null
      : requireString(value.currency, `${label}.currency`, { maxLength: 30 });
    normalized.payment_rail = value.payment_rail == null
      ? null
      : requireOpaqueRef(value.payment_rail, `${label}.payment_rail`);
    if (new Set([
      normalized.available_amount === null,
      normalized.currency === null,
      normalized.payment_rail === null,
    ]).size !== 1) {
      throw new Error('Current budget availability requires amount, currency, and payment rail together');
    }
    if (normalized.available_amount !== null
      && !/^(?:0|[1-9]\d*)(?:\.\d{1,18})?$/.test(normalized.available_amount)) {
      throw new Error('Current budget available_amount is not canonical');
    }
  }
  return normalized;
}

function normalizeCurrentGovernance(value) {
  assertCanonicalJson(value);
  assertPlainObject(value, 'current governance result');
  assertAllowedKeys(value, [
    'policy',
    'mandate',
    'budget_policy',
    'epoch',
    'commit_policy',
    'evidence_ref',
    'evidence_hash',
  ], 'current governance result');
  assertPlainObject(value.commit_policy, 'current governance commit_policy');
  return {
    policy: normalizeGovernanceRecord(value.policy, 'current governance.policy'),
    mandate: normalizeGovernanceRecord(value.mandate, 'current governance.mandate', { nullable: true }),
    budget_policy: normalizeGovernanceRecord(
      value.budget_policy,
      'current governance.budget_policy',
      { nullable: true, budget: true },
    ),
    epoch: requireOpaqueRef(value.epoch, 'current governance.epoch'),
    commit_policy: cloneJson(value.commit_policy),
    evidence_ref: requireOpaqueRef(value.evidence_ref, 'current governance.evidence_ref'),
    evidence_hash: requireSha256Ref(value.evidence_hash, 'current governance.evidence_hash'),
  };
}

function assertGovernanceCurrent(capsule, current) {
  const checks = [
    ['policy ref', current.policy.ref, capsule.governance.policy_ref],
    ['policy version', current.policy.version, capsule.governance.policy_version],
    ['policy hash', current.policy.hash, capsule.governance.policy_hash],
    ['mandate ref', current.mandate?.ref ?? null, capsule.governance.mandate_ref],
    ['mandate version', current.mandate?.version ?? null, capsule.governance.mandate_version],
    ['mandate hash', current.mandate?.hash ?? null, capsule.governance.mandate_hash],
    ['budget policy ref', current.budget_policy?.ref ?? null, capsule.governance.budget_policy_ref],
    ['budget policy version', current.budget_policy?.version ?? null, capsule.governance.budget_version],
    ['budget policy hash', current.budget_policy?.hash ?? null, capsule.governance.budget_hash],
    ['governance epoch', current.epoch, capsule.governance.epoch],
  ];
  for (const [label, observed, expected] of checks) {
    if (observed !== expected) {
      throw new Error(`Current ${label} differs from the Savepoint Capsule; a new savepoint is required`);
    }
  }
}

function expectedBindingFromCapsule(capsule) {
  return {
    policy_ref: capsule.governance.policy_ref,
    policy_version: capsule.governance.policy_version,
    policy_hash: capsule.governance.policy_hash,
    mandate_ref: capsule.governance.mandate_ref,
    mandate_version: capsule.governance.mandate_version,
    mandate_hash: capsule.governance.mandate_hash,
    budget_policy_ref: capsule.governance.budget_policy_ref,
    budget_version: capsule.governance.budget_version,
    budget_hash: capsule.governance.budget_hash,
    governance_epoch: capsule.governance.epoch,
  };
}

async function resolveGovernance(input, capsule, artifact, now) {
  if (typeof input.resolveCurrentGovernance !== 'function') {
    throw new Error('A trusted current governance resolver is required');
  }
  const current = normalizeCurrentGovernance(await input.resolveCurrentGovernance({
    parent_agent_id: capsule.parent.agent_id,
    parent_session_id: capsule.parent.session_id,
    capsule_hash: capsule.capsule_hash,
    artifact_hash: artifact.artifact_hash,
    commit_type: artifact.commit_type,
    governance: cloneJson(capsule.governance),
    now,
  }));
  assertGovernanceCurrent(capsule, current);
  return current;
}

async function verifyCleanApproval({ artifact, capsule, parentStateHash, governance, verifyCommitApproval, now }) {
  if (typeof verifyCommitApproval !== 'function') throw new Error('A trusted clean commit approval verifier is required');
  const requestBody = {
    schema: 'agoragentic.risk-fork.clean-commit-approval-verification-request.v1',
    artifact_hash: artifact.artifact_hash,
    commit_type: artifact.commit_type,
    source_fork_id: artifact.source_fork_id,
    capsule_hash: capsule.capsule_hash,
    parent_state_hash: parentStateHash,
    governance: cloneJson(governance),
    governance_hash: sha256Ref(governance),
    governance_evidence_ref: governance.evidence_ref,
    governance_evidence_hash: governance.evidence_hash,
    requested_at: now,
  };
  const request = {
    ...requestBody,
    request_hash: sha256Ref(requestBody),
  };
  const result = await verifyCommitApproval(cloneJson(request));
  assertCanonicalJson(result);
  assertPlainObject(result, 'commit approval result');
  assertAllowedKeys(result, [
    'schema',
    'status',
    'request_hash',
    'artifact_hash',
    'capsule_hash',
    'parent_state_hash',
    'governance_hash',
    'governance_evidence_ref',
    'governance_evidence_hash',
    'evidence_ref',
    'evidence_hash',
  ], 'commit approval result');
  if (result.schema !== 'agoragentic.risk-fork.clean-commit-approval-verification.v1'
    || result.status !== 'verified'
    || !safeEqual(result.request_hash, request.request_hash)
    || result.artifact_hash !== artifact.artifact_hash
    || result.capsule_hash !== capsule.capsule_hash
    || result.parent_state_hash !== parentStateHash
    || !safeEqual(result.governance_hash, request.governance_hash)
    || result.governance_evidence_ref !== governance.evidence_ref
    || !safeEqual(result.governance_evidence_hash, governance.evidence_hash)) {
    throw codedTransactionError(
      'Clean commit approval was not verified for the exact artifact, capsule, parent, and governance binding',
      'CLEAN_APPROVAL_NOT_VERIFIED',
      {
        artifact_hash: artifact.artifact_hash,
        capsule_hash: capsule.capsule_hash,
        parent_state_hash: parentStateHash,
        governance_hash: request.governance_hash,
        governance_evidence_ref: governance.evidence_ref,
        governance_evidence_hash: governance.evidence_hash,
      },
    );
  }
  return {
    status: 'verified',
    evidence_ref: requireOpaqueRef(result.evidence_ref, 'commit approval evidence_ref'),
    evidence_hash: requireSha256Ref(result.evidence_hash, 'commit approval evidence_hash'),
  };
}

function createFinalCommitAuthorityRequest({
  artifact,
  capsule,
  parentStateHash,
  candidateGovernance,
  preflightApproval,
  requiredTestVerification,
  requestedAt,
}) {
  const normalizedRequestedAt = requireIsoDate(
    requestedAt,
    'final commit-authority requested_at',
  );
  const authorizationBinding = artifact.commit_type === 'CONSEQUENTIAL_ACTION_PROPOSAL'
    ? {
      authorization_id: artifact.body.execution_binding.one_use_authorization_id,
      authorization_ref: artifact.body.execution_binding.authorization_ref,
      authorization_hash: artifact.body.execution_binding.authorization_hash,
      binding_hash: artifact.body.execution_binding.binding_hash,
    }
    : null;
  const requestBody = {
    schema: 'agoragentic.risk-fork.final-commit-authority-request.v1',
    artifact_hash: artifact.artifact_hash,
    commit_type: artifact.commit_type,
    source_fork_id: artifact.source_fork_id,
    capsule_hash: capsule.capsule_hash,
    parent_state_hash: parentStateHash,
    capsule_governance: cloneJson(capsule.governance),
    candidate_governance: cloneJson(candidateGovernance),
    candidate_governance_hash: sha256Ref(candidateGovernance),
    preflight_approval: cloneJson(preflightApproval),
    required_test_verification_hash: requiredTestVerification == null
      ? null
      : sha256Ref(requiredTestVerification),
    authorization_binding: authorizationBinding,
    authorization_binding_hash: authorizationBinding == null ? null : sha256Ref(authorizationBinding),
    requested_at: normalizedRequestedAt,
  };
  return deepFreeze({
    ...requestBody,
    request_hash: sha256Ref(requestBody),
  });
}

function verifyAtomicFinalCommitAuthority({
  result,
  request,
  artifact,
  capsule,
  parentStateHash,
  observedAt,
}) {
  assertCanonicalJson(result);
  assertPlainObject(result, 'final commit-authority result');
  assertAllowedKeys(result, [
    'schema',
    'status',
    'atomicity_status',
    'request_hash',
    'linearized_at',
    'linearization_ref',
    'linearization_hash',
    'governance',
    'governance_hash',
    'approval',
    'authorization_binding_hash',
    'evidence_ref',
    'evidence_hash',
  ], 'final commit-authority result');
  if (result.schema !== 'agoragentic.risk-fork.final-commit-authority-verification.v1'
    || result.status !== 'verified'
    || result.atomicity_status !== 'verified'
    || !safeEqual(result.request_hash, request.request_hash)
    || (request.authorization_binding_hash === null
      ? result.authorization_binding_hash !== null
      : !safeEqual(result.authorization_binding_hash, request.authorization_binding_hash))) {
    throw codedTransactionError(
      'Final commit authority did not verify an atomic snapshot for the exact request',
      'FINAL_COMMIT_AUTHORITY_NOT_VERIFIED',
      {
        artifact_hash: artifact.artifact_hash,
        request_hash: request.request_hash,
        observed_status: result.status ?? null,
        observed_atomicity_status: result.atomicity_status ?? null,
      },
    );
  }
  const governance = normalizeCurrentGovernance(result.governance);
  assertGovernanceCurrent(capsule, governance);
  const governanceHash = sha256Ref(governance);
  if (!safeEqual(result.governance_hash, governanceHash)
    || !safeEqual(governanceHash, request.candidate_governance_hash)) {
    throw codedTransactionError(
      'Final commit authority governance hash does not match its full governance snapshot',
      'FINAL_COMMIT_AUTHORITY_BINDING_MISMATCH',
      { request_hash: request.request_hash, expected_governance_hash: governanceHash },
    );
  }
  assertPlainObject(result.approval, 'final commit-authority approval');
  assertAllowedKeys(result.approval, [
    'schema',
    'status',
    'authority_request_hash',
    'artifact_hash',
    'capsule_hash',
    'parent_state_hash',
    'governance_hash',
    'evidence_ref',
    'evidence_hash',
  ], 'final commit-authority approval');
  const approvalEvidenceRef = requireOpaqueRef(
    result.approval.evidence_ref,
    'final commit-authority approval.evidence_ref',
  );
  const approvalEvidenceHash = requireSha256Ref(
    result.approval.evidence_hash,
    'final commit-authority approval.evidence_hash',
  );
  const approvalBindings = [
    ['authority_request_hash', result.approval.authority_request_hash, request.request_hash],
    ['artifact_hash', result.approval.artifact_hash, artifact.artifact_hash],
    ['capsule_hash', result.approval.capsule_hash, capsule.capsule_hash],
    ['parent_state_hash', result.approval.parent_state_hash, parentStateHash],
    ['governance_hash', result.approval.governance_hash, governanceHash],
  ];
  if (result.approval.schema !== 'agoragentic.risk-fork.final-commit-approval.v1'
    || result.approval.status !== 'verified'
    || approvalBindings.some(([, observed, expected]) => !safeEqual(observed, expected))) {
    throw codedTransactionError(
      'Final commit authority approval does not verify the exact request and governance snapshot',
      'FINAL_COMMIT_APPROVAL_NOT_VERIFIED',
      { artifact_hash: artifact.artifact_hash, request_hash: request.request_hash },
    );
  }
  const linearizedAt = requireIsoDate(
    result.linearized_at,
    'final commit-authority linearized_at',
  );
  const normalizedObservedAt = requireIsoDate(
    observedAt,
    'final commit-authority observed_at',
  );
  if (Date.parse(linearizedAt) < Date.parse(request.requested_at)
    || Date.parse(linearizedAt) > Date.parse(normalizedObservedAt)) {
    throw codedTransactionError(
      'Final commit authority linearization time is outside the trusted verification interval',
      'FINAL_COMMIT_AUTHORITY_TIME_INVALID',
      {
        requested_at: request.requested_at,
        linearized_at: linearizedAt,
        observed_at: normalizedObservedAt,
      },
    );
  }
  const linearizationRef = requireOpaqueRef(
    result.linearization_ref,
    'final commit-authority linearization_ref',
  );
  const authorityEvidenceRef = requireOpaqueRef(
    result.evidence_ref,
    'final commit-authority evidence_ref',
  );
  const authorityEvidenceHash = requireSha256Ref(
    result.evidence_hash,
    'final commit-authority evidence_hash',
  );
  const expectedLinearizationHash = sha256Ref({
    request_hash: request.request_hash,
    linearized_at: linearizedAt,
    linearization_ref: linearizationRef,
    governance_hash: governanceHash,
    approval_evidence_ref: approvalEvidenceRef,
    approval_evidence_hash: approvalEvidenceHash,
    authority_evidence_ref: authorityEvidenceRef,
    authority_evidence_hash: authorityEvidenceHash,
  });
  if (!safeEqual(result.linearization_hash, expectedLinearizationHash)) {
    throw codedTransactionError(
      'Final commit authority linearization proof is not bound to the exact snapshot',
      'FINAL_COMMIT_AUTHORITY_BINDING_MISMATCH',
      { request_hash: request.request_hash, expected_linearization_hash: expectedLinearizationHash },
    );
  }
  if (!safeEqual(approvalEvidenceRef, request.preflight_approval.evidence_ref)
    || !safeEqual(approvalEvidenceHash, request.preflight_approval.evidence_hash)) {
    throw codedTransactionError(
      'Final commit authority approval differs from the preflight approval; a new approval is required',
      'FINAL_COMMIT_APPROVAL_CHANGED',
      { request_hash: request.request_hash },
    );
  }
  return {
    status: 'verified',
    atomicity_status: 'verified',
    request_hash: request.request_hash,
    governance,
    approval: {
      status: 'verified',
      evidence_ref: approvalEvidenceRef,
      evidence_hash: approvalEvidenceHash,
    },
    linearized_at: linearizedAt,
    observed_at: normalizedObservedAt,
    linearization_ref: linearizationRef,
    linearization_hash: result.linearization_hash,
    evidence_ref: authorityEvidenceRef,
    evidence_hash: authorityEvidenceHash,
  };
}

function compareCanonicalDecimal(left, right) {
  const normalize = (value) => {
    const [whole, fractional = ''] = value.split('.');
    return { digits: `${whole}${fractional}`, scale: fractional.length };
  };
  const a = normalize(left);
  const b = normalize(right);
  const scale = Math.max(a.scale, b.scale);
  const aValue = BigInt(a.digits.padEnd(a.digits.length + scale - a.scale, '0'));
  const bValue = BigInt(b.digits.padEnd(b.digits.length + scale - b.scale, '0'));
  return aValue < bValue ? -1 : aValue > bValue ? 1 : 0;
}

function verifyConsequentialBinding({ artifact, capsule, forkIdentity, destruction, governance, now }) {
  const binding = artifact.body.execution_binding;
  const expectedGovernance = expectedBindingFromCapsule(capsule);
  verifyExecutionBinding(binding, expectedGovernance, { now });
  const comparisons = [
    ['fork agent', binding.fork_agent_id, forkIdentity.fork_agent_id],
    ['fork session', binding.session_id, forkIdentity.session_id],
    ['MCP server', binding.mcp.server_ref, capsule.proposed_interaction.mcp_server_ref],
    ['MCP origin', binding.mcp.server_origin, capsule.proposed_interaction.mcp_server_origin],
    ['MCP method', binding.mcp.method, capsule.proposed_interaction.mcp_method],
    ['MCP raw method', binding.mcp.raw_method, capsule.proposed_interaction.raw_method],
    ['MCP tool', binding.mcp.tool_name, capsule.proposed_interaction.tool_name],
    ['effective arguments', binding.mcp.effective_arguments_hash, capsule.proposed_interaction.effective_arguments_hash],
    ['target', binding.target_ref, capsule.proposed_interaction.target_ref],
    ['provider', binding.provider_ref, destruction.provider_ref],
  ];
  for (const [field, observed, expected] of comparisons) {
    if (observed !== expected) throw new Error(`Consequential action ${field} drifted from the Savepoint Capsule`);
  }
  if (capsule.execution_authorization.ref === null
    || binding.authorization_ref !== capsule.execution_authorization.ref
    || binding.authorization_hash !== capsule.execution_authorization.hash) {
    throw new Error('Consequential action authorization drifted from the Savepoint Capsule');
  }
  if (binding.commercial.amount !== null) {
    if (!governance.budget_policy
      || governance.budget_policy.available_amount === null
      || governance.budget_policy.currency !== binding.commercial.currency
      || governance.budget_policy.payment_rail !== binding.commercial.payment_rail) {
      throw new Error('Current budget policy does not authorize the exact commercial currency and payment rail');
    }
    if (compareCanonicalDecimal(binding.commercial.amount, governance.budget_policy.available_amount) > 0) {
      throw new Error('Current budget availability is below the exact bound action amount');
    }
  }
  return expectedGovernance;
}

function normalizeAuthorizationConsumption(value, binding, expectedResult) {
  assertPlainObject(value, 'execution authorization transaction result');
  assertAllowedKeys(value, [
    'status',
    'authorization_id',
    'authorization_ref',
    'authorization_hash',
    'binding_hash',
    'result',
    'result_hash',
    'evidence_ref',
    'evidence_hash',
    'observed_at',
  ], 'execution authorization transaction result');
  const resultHash = requireSha256Ref(value.result_hash, 'authorization result_hash');
  if (value.status !== 'consumed'
    || value.authorization_id !== binding.one_use_authorization_id
    || value.authorization_ref !== binding.authorization_ref
    || value.authorization_hash !== binding.authorization_hash
    || value.binding_hash !== binding.binding_hash
    || !safeEqual(resultHash, sha256Ref(expectedResult ?? null))
    || !safeEqual(resultHash, sha256Ref(value.result ?? null))) {
    throw new Error('Execution authorization transaction did not consume the exact binding and result');
  }
  return {
    status: 'verified_and_consumed',
    authorization_id: binding.one_use_authorization_id,
    binding_hash: binding.binding_hash,
    evidence_ref: requireOpaqueRef(value.evidence_ref, 'authorization evidence_ref'),
    evidence_hash: requireSha256Ref(value.evidence_hash, 'authorization evidence_hash'),
    observed_at: requireIsoDate(value.observed_at, 'authorization observed_at'),
  };
}

async function consumeAuthorizationAndExecute(input, context) {
  const transaction = FILE_EXECUTION_AUTHORIZATION_TRANSACTIONS.get(
    input.executionAuthorizationTransaction,
  );
  if (!transaction) throw new Error('An exact concrete file execution-authorization transaction is required');
  if (typeof input.executeAction !== 'function') {
    throw new Error('A clean action executor is required');
  }
  const binding = context.artifact.body.execution_binding;
  let result;
  const transactionResult = await transaction.runConsumption({
    authorization_id: binding.one_use_authorization_id,
    authorization_ref: binding.authorization_ref,
    authorization_hash: binding.authorization_hash,
    binding_hash: binding.binding_hash,
    binding: cloneJson(binding),
    principal_ref: binding.principal_ref,
    action_operation: binding.action_operation,
    provider_ref: binding.provider_ref,
    target_ref: binding.target_ref,
    mcp: cloneJson(binding.mcp),
    commercial: cloneJson(binding.commercial),
    governance: cloneJson(binding.governance),
    validity: cloneJson(binding.validity),
    governance_evidence_ref: context.governance.evidence_ref,
    governance_evidence_hash: context.governance.evidence_hash,
  }, context.sampleParentAuthorityClock, (executionNow, invokeAuthorizedExecution) => {
    context.verifyFinalAuthority(executionNow);
    verifySavepointCapsule(context.capsule, { now: executionNow });
    verifyConsequentialBinding({
      artifact: context.artifact,
      capsule: context.capsule,
      forkIdentity: context.forkIdentity,
      destruction: context.destruction,
      governance: context.governance,
      now: executionNow,
    });
    revalidateCommitArtifact(context.artifact, {
      policy: context.governance.commit_policy,
      expected_binding: expectedBindingFromCapsule(context.capsule),
      now: executionNow,
    });
    return invokeAuthorizedExecution(() => context.invokeParentEffect(() => {
      result = input.executeAction(cloneJson(context.artifact.body.action), {
        binding: cloneJson(binding),
        governance_evidence_ref: context.governance.evidence_ref,
      });
      return result;
    }));
  });
  result = transactionResult.result;
  try {
    const normalized = normalizeAuthorizationConsumption(transactionResult, binding, result);
    return {
      result,
      authorization: normalized,
      observed_at: normalized.observed_at,
    };
  } catch (error) {
    throw new CommitAmbiguousError(
      'Authorized execution completed but its atomic consumption receipt was invalid; automatic retry is forbidden',
      {
        authorization_id: binding.one_use_authorization_id,
        binding_hash: binding.binding_hash,
        cause: String(error?.message ?? error).slice(0, 1000),
      },
    );
  }
}

function normalizeParentTransaction(value, expectedHead, expectedResult) {
  assertPlainObject(value, 'parent head transaction result');
  assertAllowedKeys(value, [
    'status',
    'previous_head_hash',
    'next_head_hash',
    'result',
    'result_hash',
    'transaction_ref',
    'transaction_hash',
  ], 'parent head transaction result');
  const resultHash = requireSha256Ref(value.result_hash, 'parent transaction result_hash');
  if (value.status !== 'committed'
    || !safeEqual(value.previous_head_hash, expectedHead)
    || !safeEqual(resultHash, sha256Ref(expectedResult ?? null))
    || !safeEqual(resultHash, sha256Ref(value.result ?? null))) {
    throw new Error('Parent transaction did not atomically commit against the expected authoritative head');
  }
  return {
    previous_head_hash: requireSha256Ref(value.previous_head_hash, 'previous_head_hash'),
    next_head_hash: requireSha256Ref(value.next_head_hash, 'next_head_hash'),
    result: cloneJson(value.result ?? null),
    result_hash: resultHash,
    transaction_ref: requireOpaqueRef(value.transaction_ref, 'transaction_ref'),
    transaction_hash: requireSha256Ref(value.transaction_hash, 'transaction_hash'),
  };
}

export async function commitPreparedArtifact(input = {}, options = {}) {
  assertAllowedKeys(options, ['clock'], 'clean commit options');
  if (options.clock !== undefined && typeof options.clock !== 'function') {
    throw new TypeError('clean commit clock must be a function when supplied');
  }
  assertAllowedKeys(input, [
    'capsule',
    'fork_identity',
    'lifecycle',
    'artifact',
    'destruction_evidence',
    'expected_parent_state_hash',
    'verifyCommitApproval',
    'parentStateTransaction',
    'executionAuthorizationTransaction',
    'resolveCurrentGovernance',
    'verifyTestEvidence',
    'acceptTypedResult',
    'applyWorkspaceDiff',
    'executeAction',
  ], 'clean commit input');
  const clock = options.clock ?? (() => new Date());
  const now = requireIsoDate(clock(), 'clean commit clock result');
  verifySavepointCapsule(input.capsule, { now });
  assertFreshForkIdentity(input.fork_identity);
  verifyLifecycle(input.lifecycle);
  verifyCommitArtifact(input.artifact);
  const capsule = input.capsule;
  const artifact = input.artifact;
  if (!capsule.allowed_commit_types.includes(artifact.commit_type)) {
    throw new Error('Commit artifact type is not authorized by the Savepoint Capsule');
  }
  if (input.lifecycle.state !== 'COMMITTING' || input.lifecycle.fork_resource_state !== 'DESTROYED') {
    throw new Error('Clean commit requires COMMITTING after the verified clean boundary');
  }
  const cleanBoundaryEvent = [...input.lifecycle.events]
    .reverse()
    .find((event) => event.to === 'CLEAN_COMMIT_READY');
  if (!cleanBoundaryEvent || cleanBoundaryEvent.evidence.status !== 'verified') {
    throw new Error('Clean commit lifecycle has no verified destruction boundary');
  }
  const artifactReadyEvent = [...input.lifecycle.events]
    .reverse()
    .find((event) => event.to === 'COMMIT_READY');
  if (!artifactReadyEvent || !safeEqual(artifactReadyEvent.evidence.hash, artifact.artifact_hash)) {
    throw new Error('Lifecycle is not bound to the exact validated commit artifact');
  }
  if (input.fork_identity.parent_agent_id !== capsule.parent.agent_id
    || input.fork_identity.parent_session_id !== capsule.parent.session_id) {
    throw new Error('Fork identity does not descend from the Savepoint Capsule parent');
  }
  const expectedParentStateHash = requireSha256Ref(
    input.expected_parent_state_hash ?? capsule.parent.state_hash,
    'expected_parent_state_hash',
  );
  if (!safeEqual(expectedParentStateHash, capsule.parent.state_hash)) {
    throw new Error('Expected parent state is not bound to the Savepoint Capsule');
  }
  const parentTransaction = FILE_PARENT_HEAD_TRANSACTIONS.get(input.parentStateTransaction);
  if (!parentTransaction) {
    throw codedTransactionError(
      'An exact concrete file parent-head and commit-authority transaction is required',
      'FILE_PARENT_AUTHORITY_REQUIRED',
      { capsule_hash: input.capsule?.capsule_hash ?? null },
    );
  }
  const destruction = verifyDestructionEvidence(input.destruction_evidence);
  if (destruction.fork_ref !== artifact.source_fork_id) {
    throw new Error('Destruction evidence is for a different fork');
  }
  const governance = await resolveGovernance(input, capsule, artifact, now);
  const expectedBinding = expectedBindingFromCapsule(capsule);
  if (artifact.commit_type === 'CONSEQUENTIAL_ACTION_PROPOSAL') {
    verifyConsequentialBinding({
      artifact,
      capsule,
      forkIdentity: input.fork_identity,
      destruction,
      governance,
      now,
    });
  }
  if (artifact.commit_type === 'TYPED_RESULT'
    && !safeEqual(artifact.body.payload_schema_hash, capsule.authorized_result_schema_hash)) {
    throw new Error('Typed result schema is not authorized by the Savepoint Capsule');
  }
  const approval = await verifyCleanApproval({
    artifact,
    capsule,
    parentStateHash: expectedParentStateHash,
    governance,
    verifyCommitApproval: input.verifyCommitApproval,
    now,
  });
  if (artifact.commit_type === 'TYPED_RESULT' && typeof input.acceptTypedResult !== 'function') {
    throw new Error('A clean typed-result acceptor is required');
  }
  if (artifact.commit_type === 'WORKSPACE_DIFF' && typeof input.applyWorkspaceDiff !== 'function') {
    throw new Error('A clean workspace-diff applicator is required');
  }
  if (artifact.commit_type === 'CONSEQUENTIAL_ACTION_PROPOSAL'
    && typeof input.executeAction !== 'function') {
    throw new Error('A clean action executor is required');
  }
  if (artifact.commit_type === 'CONSEQUENTIAL_ACTION_PROPOSAL'
    && !FILE_EXECUTION_AUTHORIZATION_TRANSACTIONS.has(
      input.executionAuthorizationTransaction,
    )) {
    throw codedTransactionError(
      'An exact concrete file execution-authorization transaction is required',
      'FILE_EXECUTION_AUTHORITY_REQUIRED',
      { artifact_hash: artifact.artifact_hash },
    );
  }

  let requiredTestVerification;
  let mutationGovernance = null;
  let mutationApproval = null;
  let finalCommitAuthority = null;
  let mutationNow = null;
  let mutationResult = null;
  let authorization = null;
  const parentRef = deriveParentAuthorityRef({
    agent_id: capsule.parent.agent_id,
    session_id: capsule.parent.session_id,
  });
  let authorityRequest;
  const finalizeAuthority = (proof, observedAt) => {
    const finalAuthority = verifyAtomicFinalCommitAuthority({
      result: proof,
      request: authorityRequest,
      artifact,
      capsule,
      parentStateHash: expectedParentStateHash,
      observedAt,
    });
    const mutationGateNow = finalAuthority.observed_at;
    verifySavepointCapsule(capsule, { now: mutationGateNow });
    if (artifact.commit_type === 'CONSEQUENTIAL_ACTION_PROPOSAL') {
      verifyConsequentialBinding({
        artifact,
        capsule,
        forkIdentity: input.fork_identity,
        destruction,
        governance: finalAuthority.governance,
        now: mutationGateNow,
      });
    }
    revalidateCommitArtifact(artifact, {
      policy: finalAuthority.governance.commit_policy,
      expected_binding: expectedBinding,
      required_test_verification: requiredTestVerification,
      now: mutationGateNow,
    });
    if (artifact.commit_type === 'TYPED_RESULT'
      && !safeEqual(artifact.body.payload_schema_hash, capsule.authorized_result_schema_hash)) {
      throw new Error('Typed result schema is not authorized by the Savepoint Capsule');
    }
    mutationGovernance = finalAuthority.governance;
    mutationApproval = finalAuthority.approval;
    finalCommitAuthority = {
      status: finalAuthority.status,
      atomicity_status: finalAuthority.atomicity_status,
      request_hash: finalAuthority.request_hash,
      linearized_at: finalAuthority.linearized_at,
      observed_at: finalAuthority.observed_at,
      linearization_ref: finalAuthority.linearization_ref,
      linearization_hash: finalAuthority.linearization_hash,
      evidence_ref: finalAuthority.evidence_ref,
      evidence_hash: finalAuthority.evidence_hash,
    };
    mutationNow = mutationGateNow;
    return finalAuthority;
  };

  const parentResult = await parentTransaction.runCommit({
    parent_ref: parentRef,
    expected_parent_head_hash: expectedParentStateHash,
    artifact_hash: artifact.artifact_hash,
    capsule_hash: capsule.capsule_hash,
    commit_type: artifact.commit_type,
  }, async (authoritativeGovernance, reservationStartedAt) => {
    assertGovernanceCurrent(capsule, authoritativeGovernance);
    if (!safeEqual(authoritativeGovernance.evidence_ref, governance.evidence_ref)
      || !safeEqual(authoritativeGovernance.evidence_hash, governance.evidence_hash)) {
      throw codedTransactionError(
        'Advisory governance evidence differs from the reserved clean-host authority',
        'GOVERNANCE_EVIDENCE_STALE',
        {
          expected_governance_evidence_ref: governance.evidence_ref,
          expected_governance_evidence_hash: governance.evidence_hash,
          observed_governance_evidence_ref: authoritativeGovernance.evidence_ref,
          observed_governance_evidence_hash: authoritativeGovernance.evidence_hash,
        },
      );
    }
    verifySavepointCapsule(capsule, { now: reservationStartedAt });
    if (artifact.commit_type === 'CONSEQUENTIAL_ACTION_PROPOSAL') {
      verifyConsequentialBinding({
        artifact,
        capsule,
        forkIdentity: input.fork_identity,
        destruction,
        governance: authoritativeGovernance,
        now: reservationStartedAt,
      });
    }
    if (artifact.commit_type === 'WORKSPACE_DIFF'
      && Array.isArray(authoritativeGovernance.commit_policy.required_tests)
      && authoritativeGovernance.commit_policy.required_tests.length > 0) {
      requiredTestVerification = await verifyWorkspaceRequiredTests(artifact, {
        policy: authoritativeGovernance.commit_policy,
        verifyTestEvidence: input.verifyTestEvidence,
        now: reservationStartedAt,
      });
    }
    revalidateCommitArtifact(artifact, {
      policy: authoritativeGovernance.commit_policy,
      expected_binding: expectedBinding,
      required_test_verification: requiredTestVerification,
      now: reservationStartedAt,
    });
    authorityRequest = createFinalCommitAuthorityRequest({
      artifact,
      capsule,
      parentStateHash: expectedParentStateHash,
      candidateGovernance: authoritativeGovernance,
      preflightApproval: approval,
      requiredTestVerification,
      requestedAt: reservationStartedAt,
    });
    return authorityRequest;
  }, (proof, invokeParentEffect, sampleParentAuthorityClock) => {
    if (artifact.commit_type === 'CONSEQUENTIAL_ACTION_PROPOSAL') {
      return consumeAuthorizationAndExecute(input, {
        artifact,
        capsule,
        forkIdentity: input.fork_identity,
        destruction,
        governance: proof.governance,
        sampleParentAuthorityClock,
        invokeParentEffect,
        verifyFinalAuthority: (observedAt) => finalizeAuthority(proof, observedAt),
      }).then((executed) => {
        authorization = executed.authorization;
        mutationResult = executed.result;
        return { result: mutationResult ?? null, observed_at: executed.observed_at };
      });
    }
    finalizeAuthority(proof, proof.linearized_at);
    const operation = artifact.commit_type === 'TYPED_RESULT'
      ? () => input.acceptTypedResult(cloneJson(artifact.body.payload))
      : () => input.applyWorkspaceDiff(cloneJson(artifact.body.files));
    const effectPromise = invokeParentEffect(operation);
    return Promise.resolve(effectPromise).then((value) => {
      mutationResult = value;
      return { result: mutationResult ?? null, observed_at: proof.linearized_at };
    });
  });
  let parent;
  try {
    parent = normalizeParentTransaction(parentResult, expectedParentStateHash, mutationResult);
  } catch (error) {
    throw new CommitAmbiguousError(
      'Parent mutation completed but its authoritative transaction receipt was invalid; automatic retry is forbidden',
      { artifact_hash: artifact.artifact_hash, cause: String(error?.message ?? error).slice(0, 1000) },
    );
  }
  return {
    schema: 'agoragentic.risk-fork.clean-commit-result.v1',
    status: 'committed',
    committed_at: mutationNow,
    commit_type: artifact.commit_type,
    artifact_hash: artifact.artifact_hash,
    previous_parent_state_hash: parent.previous_head_hash,
    parent_state_hash: parent.next_head_hash,
    result_hash: parent.result_hash,
    result: parent.result,
    parent_transaction: {
      status: 'committed',
      transaction_ref: parent.transaction_ref,
      transaction_hash: parent.transaction_hash,
    },
    current_governance: {
      status: 'verified',
      epoch: mutationGovernance.epoch,
      evidence_ref: mutationGovernance.evidence_ref,
      evidence_hash: mutationGovernance.evidence_hash,
    },
    final_commit_authority: finalCommitAuthority,
    clean_approval: mutationApproval,
    execution_authorization: authorization,
    destruction,
    authority_flags: {
      result_grants_authority: false,
      automatic_retry_allowed: false,
    },
  };
}
