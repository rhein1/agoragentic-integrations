import { mkdir, open, readFile, rename, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

import { sha256Ref } from './canonical.mjs';
import {
  assertFreshForkIdentity,
  verifyExecutionBinding,
  verifySavepointCapsule,
} from './contracts.mjs';
import { verifyLifecycle } from './lifecycle.mjs';
import { verifyCommitArtifact } from './taint-gate.mjs';
import {
  assertAllowedKeys,
  assertPlainObject,
  cloneJson,
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

export class FileAuthorizationClaimStore {
  constructor({ directory, clock = () => new Date() }) {
    this.directory = path.resolve(requireString(directory, 'claim store directory'));
    this.clock = clock;
  }

  async initialize() {
    await mkdir(this.directory, { recursive: true });
    return this;
  }

  #claimPath(authorizationId) {
    const name = sha256Ref(requireString(authorizationId, 'authorization id')).slice(7);
    return path.join(this.directory, `${name}.json`);
  }

  async claim({ authorizationId, bindingHash }) {
    const claimPath = this.#claimPath(authorizationId);
    const claimToken = `claim_${randomUUID()}`;
    const record = {
      schema: 'agoragentic.risk-fork.authorization-claim.v1',
      authorization_id_hash: sha256Ref(authorizationId),
      binding_hash: requireSha256Ref(bindingHash, 'bindingHash'),
      claim_token_hash: sha256Ref(claimToken),
      status: 'claimed',
      claimed_at: requireIsoDate(this.clock(), 'clock result'),
      completed_at: null,
      result_hash: null,
    };
    try {
      const handle = await open(claimPath, 'wx', 0o600);
      try {
        await handle.writeFile(`${JSON.stringify(record, null, 2)}\n`, 'utf8');
      } finally {
        await handle.close();
      }
      return { status: 'claimed', claim_token: claimToken, record: cloneJson(record) };
    } catch (error) {
      if (error?.code !== 'EEXIST') throw error;
      const existing = JSON.parse(await readFile(claimPath, 'utf8'));
      return { status: existing.status === 'completed' ? 'consumed' : 'already_claimed', record: existing };
    }
  }

  async complete({ authorizationId, bindingHash, claimToken, resultHash }) {
    const claimPath = this.#claimPath(authorizationId);
    const record = JSON.parse(await readFile(claimPath, 'utf8'));
    if (record.status !== 'claimed') throw new Error('Authorization claim is not pending completion');
    if (!safeEqual(record.binding_hash, requireSha256Ref(bindingHash, 'bindingHash'))) {
      throw new Error('Authorization claim binding mismatch');
    }
    if (!safeEqual(record.claim_token_hash, sha256Ref(requireString(claimToken, 'claimToken')))) {
      throw new Error('Authorization claim token mismatch');
    }
    const completed = {
      ...record,
      status: 'completed',
      completed_at: requireIsoDate(this.clock(), 'clock result'),
      result_hash: requireSha256Ref(resultHash, 'resultHash'),
    };
    const temporary = `${claimPath}.${randomUUID()}.tmp`;
    await writeFile(temporary, `${JSON.stringify(completed, null, 2)}\n`, {
      encoding: 'utf8',
      mode: 0o600,
      flag: 'wx',
    });
    await rename(temporary, claimPath);
    return cloneJson(completed);
  }

  async get(authorizationId) {
    const claimPath = this.#claimPath(authorizationId);
    try {
      await stat(claimPath);
      return JSON.parse(await readFile(claimPath, 'utf8'));
    } catch (error) {
      if (error?.code === 'ENOENT') return null;
      throw error;
    }
  }
}

function verifyDestructionEvidence(value) {
  assertAllowedKeys(value, ['status', 'provider_ref', 'fork_ref', 'evidence_ref', 'evidence_hash'], 'destruction evidence');
  if (value.status !== 'verified') {
    throw new Error('Clean commit requires verified fork destruction evidence');
  }
  return {
    status: 'verified',
    provider_ref: requireOpaqueRef(value.provider_ref, 'destruction evidence.provider_ref'),
    fork_ref: requireOpaqueRef(value.fork_ref, 'destruction evidence.fork_ref'),
    evidence_ref: requireOpaqueRef(value.evidence_ref, 'destruction evidence.evidence_ref'),
    evidence_hash: requireSha256Ref(value.evidence_hash, 'destruction evidence.evidence_hash'),
  };
}

async function verifyCleanApproval({ artifact, capsule, parentStateHash, verifyCommitApproval, now }) {
  if (typeof verifyCommitApproval !== 'function') {
    throw new Error('A trusted clean commit approval verifier is required');
  }
  const result = await verifyCommitApproval({
    artifact_hash: artifact.artifact_hash,
    commit_type: artifact.commit_type,
    source_fork_id: artifact.source_fork_id,
    capsule_hash: capsule.capsule_hash,
    parent_state_hash: parentStateHash,
    now,
  });
  assertPlainObject(result, 'commit approval result');
  assertAllowedKeys(result, [
    'status',
    'artifact_hash',
    'capsule_hash',
    'parent_state_hash',
    'evidence_ref',
    'evidence_hash',
  ], 'commit approval result');
  if (result.status !== 'verified'
    || result.artifact_hash !== artifact.artifact_hash
    || result.capsule_hash !== capsule.capsule_hash
    || result.parent_state_hash !== parentStateHash
    || !result.evidence_ref
    || !result.evidence_hash) {
    throw new Error('Clean commit approval was not verified for the exact artifact');
  }
  return {
    status: 'verified',
    evidence_ref: requireOpaqueRef(result.evidence_ref, 'commit approval evidence_ref'),
    evidence_hash: requireSha256Ref(result.evidence_hash, 'commit approval evidence_hash'),
  };
}

async function claimArtifactCommit({ store, artifact, capsule, parentStateHash }) {
  if (!store || typeof store.claim !== 'function' || typeof store.complete !== 'function') {
    throw new Error('An atomic artifact commit claim store is required');
  }
  const claimId = `artifact-commit:${artifact.artifact_hash.slice(7)}`;
  const bindingHash = sha256Ref({
    artifact_hash: artifact.artifact_hash,
    capsule_hash: capsule.capsule_hash,
    parent_state_hash: parentStateHash,
    commit_type: artifact.commit_type,
  });
  const claim = await store.claim({ authorizationId: claimId, bindingHash });
  if (claim.status !== 'claimed') throw new Error(`Artifact commit is ${claim.status}`);
  return { claimId, bindingHash, claim };
}

async function completeArtifactCommit({ store, claimed, resultHash }) {
  await store.complete({
    authorizationId: claimed.claimId,
    bindingHash: claimed.bindingHash,
    claimToken: claimed.claim.claim_token,
    resultHash,
  });
  return {
    status: 'consumed',
    claim_id_hash: sha256Ref(claimed.claimId),
    binding_hash: claimed.bindingHash,
  };
}

function verifyConsequentialCommitBinding(input, context) {
  assertPlainObject(input.expected_binding, 'expected_binding');
  for (const field of ['policy_version', 'mandate_version']) {
    if (!Object.hasOwn(input.expected_binding, field)) {
      throw new Error(`Clean consequential commit requires current trusted ${field}`);
    }
    if (input.expected_binding[field] !== context.capsule.governance[field]) {
      throw new Error(`Current trusted ${field} differs from the Savepoint Capsule`);
    }
  }
  const expectedBinding = cloneJson(input.expected_binding);
  const binding = context.artifact.body.execution_binding;
  verifyExecutionBinding(binding, expectedBinding, { now: context.now });
  if (binding.fork_agent_id !== context.forkIdentity.fork_agent_id
    || binding.session_id !== context.forkIdentity.session_id
    || binding.mcp.server_ref !== context.capsule.proposed_interaction.mcp_server_ref
    || binding.mcp.server_origin !== context.capsule.proposed_interaction.mcp_server_origin
    || binding.mcp.method !== context.capsule.proposed_interaction.mcp_method
    || binding.mcp.tool_name !== context.capsule.proposed_interaction.tool_name
    || binding.mcp.effective_arguments_hash
      !== context.capsule.proposed_interaction.effective_arguments_hash
    || binding.target_ref !== context.capsule.proposed_interaction.target_ref
    || binding.provider_ref !== context.destruction.provider_ref
    || binding.governance.policy_version !== context.capsule.governance.policy_version
    || binding.governance.mandate_version !== context.capsule.governance.mandate_version
    || (context.capsule.execution_authorization.ref !== null
      && (binding.authorization_ref !== context.capsule.execution_authorization.ref
        || binding.authorization_hash !== context.capsule.execution_authorization.hash))) {
    throw new Error('Consequential action binding drifted from the capsule, fork, or provider');
  }
  return expectedBinding;
}

async function commitConsequentialAction(input, context) {
  const binding = context.artifact.body.execution_binding;
  verifyExecutionBinding(binding, context.expectedBinding, { now: context.now });
  if (typeof input.verifyExecutionAuthorization !== 'function') {
    throw new Error('A trusted execution authorization verifier is required');
  }
  if (!input.authorizationClaimStore || typeof input.authorizationClaimStore.claim !== 'function') {
    throw new Error('An atomic execution authorization claim store is required');
  }
  if (typeof input.executeAction !== 'function') {
    throw new Error('A clean action executor is required');
  }
  const verification = await input.verifyExecutionAuthorization({
    authorization_ref: binding.authorization_ref,
    authorization_hash: binding.authorization_hash,
    authorization_id: binding.one_use_authorization_id,
    binding_hash: binding.binding_hash,
    binding: cloneJson(binding),
    now: context.now,
  });
  assertPlainObject(verification, 'execution authorization verification');
  assertAllowedKeys(verification, [
    'status',
    'revocation_status',
    'authorization_id',
    'binding_hash',
    'evidence_ref',
    'evidence_hash',
  ], 'execution authorization verification');
  if (verification.status !== 'verified'
    || verification.revocation_status !== 'active'
    || verification.authorization_id !== binding.one_use_authorization_id
    || verification.binding_hash !== binding.binding_hash
    || !verification.evidence_ref
    || !verification.evidence_hash) {
    throw new Error('Execution authorization is absent, stale, revoked, or bound to a different action');
  }
  const claim = await input.authorizationClaimStore.claim({
    authorizationId: binding.one_use_authorization_id,
    bindingHash: binding.binding_hash,
  });
  if (claim.status !== 'claimed') throw new Error(`Execution authorization is ${claim.status}`);

  try {
    const result = await input.executeAction(cloneJson(context.artifact.body.action), {
      binding: cloneJson(binding),
      authorization_evidence_ref: verification.evidence_ref,
    });
    const resultHash = sha256Ref(result ?? null);
    await input.authorizationClaimStore.complete({
      authorizationId: binding.one_use_authorization_id,
      bindingHash: binding.binding_hash,
      claimToken: claim.claim_token,
      resultHash,
    });
    return {
      result,
      result_hash: resultHash,
      execution_authorization: {
        status: 'verified_and_consumed',
        authorization_id: binding.one_use_authorization_id,
        binding_hash: binding.binding_hash,
        evidence_ref: requireOpaqueRef(verification.evidence_ref, 'authorization evidence_ref'),
        evidence_hash: requireSha256Ref(verification.evidence_hash, 'authorization evidence_hash'),
      },
    };
  } catch (error) {
    throw new CommitAmbiguousError(
      'The authorization was claimed before the clean executor failed; automatic retry is forbidden',
      {
        authorization_id: binding.one_use_authorization_id,
        binding_hash: binding.binding_hash,
        claim_status: 'claimed_execution_ambiguous',
        cause: optionalString(error?.message, 'executor error message', { maxLength: 1000 }),
      },
    );
  }
}

export async function commitPreparedArtifact(input = {}) {
  assertAllowedKeys(input, [
    'capsule',
    'fork_identity',
    'lifecycle',
    'artifact',
    'destruction_evidence',
    'expected_parent_state_hash',
    'current_parent_state_hash',
    'verifyCommitApproval',
    'verifyExecutionAuthorization',
    'authorizationClaimStore',
    'commitClaimStore',
    'expected_binding',
    'acceptTypedResult',
    'applyWorkspaceDiff',
    'executeAction',
    'now',
  ], 'clean commit input');
  const now = requireIsoDate(input.now ?? new Date(), 'now');
  verifySavepointCapsule(input.capsule, { now });
  assertFreshForkIdentity(input.fork_identity);
  verifyLifecycle(input.lifecycle);
  verifyCommitArtifact(input.artifact);
  const capsule = input.capsule;
  const artifact = input.artifact;
  if (!capsule.allowed_commit_types.includes(artifact.commit_type)) {
    throw new Error('Commit artifact type is not authorized by the Savepoint Capsule');
  }
  if (input.lifecycle.state !== 'COMMITTING'
    || input.lifecycle.fork_resource_state !== 'DESTROYED') {
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
    input.expected_parent_state_hash,
    'expected_parent_state_hash',
  );
  const currentParentStateHash = requireSha256Ref(
    input.current_parent_state_hash,
    'current_parent_state_hash',
  );
  if (!safeEqual(expectedParentStateHash, currentParentStateHash)) {
    throw new Error('Parent state changed after savepoint; clean commit is stale');
  }
  if (!safeEqual(expectedParentStateHash, capsule.parent.state_hash)) {
    throw new Error('Expected parent state is not bound to the Savepoint Capsule');
  }
  const destruction = verifyDestructionEvidence(input.destruction_evidence);
  if (destruction.fork_ref !== artifact.source_fork_id) {
    throw new Error('Destruction evidence is for a different fork');
  }
  const consequentialExpectedBinding = artifact.commit_type === 'CONSEQUENTIAL_ACTION_PROPOSAL'
    ? verifyConsequentialCommitBinding(input, {
        artifact,
        capsule,
        forkIdentity: input.fork_identity,
        destruction,
        now,
      })
    : null;
  const approval = await verifyCleanApproval({
    artifact,
    capsule,
    parentStateHash: currentParentStateHash,
    verifyCommitApproval: input.verifyCommitApproval,
    now,
  });

  let committed;
  if (artifact.commit_type === 'TYPED_RESULT') {
    if (!safeEqual(artifact.body.payload_schema_hash, capsule.authorized_result_schema_hash)) {
      throw new Error('Typed result schema is not authorized by the Savepoint Capsule');
    }
    if (typeof input.acceptTypedResult !== 'function') {
      throw new Error('A clean typed-result acceptor is required');
    }
    const claimed = await claimArtifactCommit({
      store: input.commitClaimStore,
      artifact,
      capsule,
      parentStateHash: currentParentStateHash,
    });
    try {
      const result = await input.acceptTypedResult(cloneJson(artifact.body.payload));
      const resultHash = sha256Ref(result ?? null);
      committed = {
        result,
        result_hash: resultHash,
        commit_claim: await completeArtifactCommit({
          store: input.commitClaimStore,
          claimed,
          resultHash,
        }),
        execution_authorization: null,
      };
    } catch (error) {
      throw new CommitAmbiguousError(
        'The clean typed-result acceptor failed after commit began; automatic retry is forbidden',
        { artifact_hash: artifact.artifact_hash, cause: String(error?.message ?? error).slice(0, 1000) },
      );
    }
  } else if (artifact.commit_type === 'WORKSPACE_DIFF') {
    if (typeof input.applyWorkspaceDiff !== 'function') {
      throw new Error('A clean workspace-diff applicator is required');
    }
    const claimed = await claimArtifactCommit({
      store: input.commitClaimStore,
      artifact,
      capsule,
      parentStateHash: currentParentStateHash,
    });
    try {
      const result = await input.applyWorkspaceDiff(cloneJson(artifact.body.files));
      const resultHash = sha256Ref(result ?? null);
      committed = {
        result,
        result_hash: resultHash,
        commit_claim: await completeArtifactCommit({
          store: input.commitClaimStore,
          claimed,
          resultHash,
        }),
        execution_authorization: null,
      };
    } catch (error) {
      throw new CommitAmbiguousError(
        'The clean workspace applicator failed after commit began; automatic retry is forbidden',
        { artifact_hash: artifact.artifact_hash, cause: String(error?.message ?? error).slice(0, 1000) },
      );
    }
  } else {
    committed = await commitConsequentialAction(input, {
      artifact,
      expectedBinding: consequentialExpectedBinding,
      now,
    });
    committed.commit_claim = null;
  }

  const resultHash = committed.result_hash ?? sha256Ref(committed.result ?? null);
  return {
    schema: 'agoragentic.risk-fork.clean-commit-result.v1',
    status: 'committed',
    committed_at: now,
    commit_type: artifact.commit_type,
    artifact_hash: artifact.artifact_hash,
    parent_state_hash: currentParentStateHash,
    result_hash: resultHash,
    result: committed.result ?? null,
    commit_claim: committed.commit_claim,
    clean_approval: approval,
    execution_authorization: committed.execution_authorization,
    destruction,
    authority_flags: {
      result_grants_authority: false,
      automatic_retry_allowed: false,
    },
  };
}
