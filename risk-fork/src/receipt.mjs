import { assertCanonicalJson, canonicalize, sha256Ref } from './canonical.mjs';
import {
  ACTION_OPERATIONS,
  COMMIT_TYPES,
  EVIDENCE_STATUSES,
  FORK_RESOURCE_STATES,
  MCP_PHASES,
  NO_AUTHORITY_FLAGS,
  RISK_ACTIONS,
  RISK_LEVELS,
  RUN_STATES,
} from './constants.mjs';
import {
  assertFreshForkIdentity,
  verifyExecutionBinding,
  verifySavepointCapsule,
} from './contracts.mjs';
import { verifyLifecycle } from './lifecycle.mjs';
import { verifyRiskDecision } from './risk-classifier.mjs';
import { verifyCommitArtifact } from './taint-gate.mjs';
import {
  assertAllowedKeys,
  assertPlainObject,
  boundedInteger,
  deepFreeze,
  requireEnum,
  requireIsoDate,
  requireOpaqueRef,
  requireSha256Ref,
  safeEqual,
  uniqueStrings,
} from './util.mjs';

const PRIVACY_INVARIANTS = Object.freeze({
  raw_prompt_excluded: true,
  raw_conversation_excluded: true,
  raw_tool_output_excluded: true,
  credentials_excluded: true,
  provider_tokens_excluded: true,
  local_absolute_paths_excluded: true,
});

const RECEIPT_AUTHORITY_INVARIANTS = Object.freeze({
  ...NO_AUTHORITY_FLAGS,
  receipt_grants_authority: false,
});

const CLAIM_NAMES = Object.freeze([
  'savepoint',
  'fork_start',
  'execution',
  'credential_revocation',
  'destruction',
]);

const TIMESTAMP_FIELDS = Object.freeze([
  'requested_at',
  'savepoint_ready_at',
  'fork_started_at',
  'execution_started_at',
  'execution_completed_at',
  'validation_completed_at',
  'destruction_requested_at',
  'destruction_verified_at',
  'credential_revoked_at',
  'commit_started_at',
  'committed_at',
  'aborted_at',
]);

const RISK_ACTION_VALUES = Object.freeze([...Object.values(RISK_ACTIONS), 'DENY']);

function canonicalMatch(value, normalized, field) {
  if (canonicalize(value) !== canonicalize(normalized)) {
    throw new Error(`${field} does not satisfy the canonical closed contract`);
  }
}

function nullableOpaqueRef(value, field, options = {}) {
  return value == null ? null : requireOpaqueRef(value, field, options);
}

function nullableSha256Ref(value, field) {
  return value == null ? null : requireSha256Ref(value, field);
}

function nullableIsoDate(value, field) {
  return value == null ? null : requireIsoDate(value, field);
}

function normalizeClaim(value, field) {
  assertAllowedKeys(value, ['status', 'outcome', 'evidence_ref', 'evidence_hash', 'detail'], field);
  const normalized = {
    status: requireEnum(value.status, EVIDENCE_STATUSES, `${field}.status`),
    outcome: requireEnum(
      value.outcome ?? 'not_applicable',
      ['success', 'failure', 'not_applicable', 'unknown'],
      `${field}.outcome`,
    ),
    evidence_ref: nullableOpaqueRef(value.evidence_ref, `${field}.evidence_ref`),
    evidence_hash: nullableSha256Ref(value.evidence_hash, `${field}.evidence_hash`),
    detail: nullableOpaqueRef(value.detail, `${field}.detail`, { maxLength: 500 }),
  };
  if (['observed', 'verified', 'failed'].includes(normalized.status)
    && (!normalized.evidence_ref || !normalized.evidence_hash)) {
    throw new TypeError(`${field} requires an evidence ref and hash for ${normalized.status}`);
  }
  if (normalized.status === 'verified' && normalized.outcome !== 'success') {
    throw new TypeError(`${field} verified status requires success outcome`);
  }
  return normalized;
}

function normalizeMeasurements(value = {}) {
  assertAllowedKeys(value, [
    'savepoint_ms',
    'fork_start_ms',
    'execution_ms',
    'validation_ms',
    'cleanup_ms',
    'total_ms',
    'capsule_bytes',
    'diff_bytes',
    'file_count',
  ], 'measurements');
  return Object.fromEntries(Object.entries(value).map(([key, item]) => [
    key,
    boundedInteger(item, `measurements.${key}`, { min: 0, max: Number.MAX_SAFE_INTEGER }),
  ]));
}

function firstEventAt(lifecycle, states) {
  return lifecycle.events.find((event) => states.includes(event.to))?.at ?? null;
}

function deriveTimestamps(lifecycle, credentialRevokedAt) {
  return {
    requested_at: firstEventAt(lifecycle, ['REQUESTED']),
    savepoint_ready_at: firstEventAt(lifecycle, ['SAVEPOINT_READY']),
    fork_started_at: firstEventAt(lifecycle, ['FORK_READY']),
    execution_started_at: firstEventAt(lifecycle, ['EXECUTING']),
    execution_completed_at: firstEventAt(lifecycle, ['TAINTED', 'EXECUTION_FAILED']),
    validation_completed_at: firstEventAt(lifecycle, ['COMMIT_READY', 'VALIDATION_FAILED']),
    destruction_requested_at: firstEventAt(lifecycle, ['PRECOMMIT_DESTROYING', 'DESTROYING']),
    destruction_verified_at: firstEventAt(lifecycle, ['CLEAN_COMMIT_READY', 'DESTROYED']),
    credential_revoked_at: nullableIsoDate(credentialRevokedAt, 'credential_revoked_at'),
    commit_started_at: firstEventAt(lifecycle, ['COMMITTING']),
    committed_at: firstEventAt(lifecycle, ['COMMITTED']),
    aborted_at: firstEventAt(lifecycle, ['ABORTED']),
  };
}

function normalizeTimestamps(value) {
  assertAllowedKeys(value, TIMESTAMP_FIELDS, 'receipt.timestamps');
  return Object.fromEntries(TIMESTAMP_FIELDS.map((field) => [
    field,
    nullableIsoDate(value[field], `receipt.timestamps.${field}`),
  ]));
}

function normalizeDestructionEvidence(value) {
  assertAllowedKeys(
    value,
    ['status', 'provider_ref', 'fork_ref', 'evidence_ref', 'evidence_hash'],
    'destruction_evidence',
  );
  if (value.status !== 'verified') {
    throw new Error('Receipt destruction evidence must be verified');
  }
  return {
    status: 'verified',
    provider_ref: requireOpaqueRef(value.provider_ref, 'destruction_evidence.provider_ref'),
    fork_ref: requireOpaqueRef(value.fork_ref, 'destruction_evidence.fork_ref'),
    evidence_ref: requireOpaqueRef(value.evidence_ref, 'destruction_evidence.evidence_ref'),
    evidence_hash: requireSha256Ref(value.evidence_hash, 'destruction_evidence.evidence_hash'),
  };
}

function assertDecisionMatchesCapsule(decision, capsule) {
  verifyRiskDecision(decision);
  const observed = decision.normalized_input;
  const proposed = capsule.proposed_interaction;
  const comparisons = {
    mcp_phase: proposed.mcp_method,
    mcp_server_ref: proposed.mcp_server_ref,
    mcp_server_origin: proposed.mcp_server_origin,
    tool_name: proposed.tool_name,
  };
  for (const [field, expected] of Object.entries(comparisons)) {
    if (observed[field] !== expected) {
      throw new Error(`Risk decision and Savepoint Capsule differ at ${field}`);
    }
  }
}

function assertArtifactCoherence({ artifact, capsule, lifecycle, identity, providerRef, forkRef }) {
  if (!artifact) return null;
  verifyCommitArtifact(artifact);
  if (artifact.source_fork_id !== forkRef) {
    throw new Error('Commit artifact belongs to a different fork');
  }
  if (!capsule.allowed_commit_types.includes(artifact.commit_type)) {
    throw new Error('Commit artifact type is not authorized by the Savepoint Capsule');
  }
  const readyEvent = lifecycle.events.find((event) => event.to === 'COMMIT_READY');
  if (!readyEvent || !safeEqual(readyEvent.evidence.hash, artifact.artifact_hash)) {
    throw new Error('Receipt lifecycle is not bound to the exact commit artifact');
  }
  if (artifact.commit_type === 'TYPED_RESULT'
    && !safeEqual(artifact.body.payload_schema_hash, capsule.authorized_result_schema_hash)) {
    throw new Error('Typed result schema is not authorized by the Savepoint Capsule');
  }
  if (artifact.commit_type === 'CONSEQUENTIAL_ACTION_PROPOSAL') {
    const binding = artifact.body.execution_binding;
    verifyExecutionBinding(binding, {
      fork_agent_id: identity.fork_agent_id,
      session_id: identity.session_id,
      mcp_server_ref: capsule.proposed_interaction.mcp_server_ref,
      mcp_server_origin: capsule.proposed_interaction.mcp_server_origin,
      mcp_method: capsule.proposed_interaction.mcp_method,
      tool_name: capsule.proposed_interaction.tool_name,
      effective_arguments_hash: capsule.proposed_interaction.effective_arguments_hash,
      provider_ref: providerRef,
      target_ref: capsule.proposed_interaction.target_ref,
      ...(capsule.execution_authorization.ref
        ? {
            authorization_ref: capsule.execution_authorization.ref,
            authorization_hash: capsule.execution_authorization.hash,
          }
        : {}),
    }, { now: artifact.validated_at });
    return binding;
  }
  return null;
}

function normalizeSavepointSummary(value) {
  assertAllowedKeys(value, [
    'capsule_id',
    'capsule_hash',
    'parent_agent_ref',
    'parent_session_ref',
    'parent_lineage_hash',
    'workspace_digest',
    'receipt_chain_head',
  ], 'receipt.savepoint');
  return {
    capsule_id: requireOpaqueRef(value.capsule_id, 'receipt.savepoint.capsule_id', {
      maxLength: 200,
    }),
    capsule_hash: requireSha256Ref(value.capsule_hash, 'receipt.savepoint.capsule_hash'),
    parent_agent_ref: requireSha256Ref(
      value.parent_agent_ref,
      'receipt.savepoint.parent_agent_ref',
    ),
    parent_session_ref: requireSha256Ref(
      value.parent_session_ref,
      'receipt.savepoint.parent_session_ref',
    ),
    parent_lineage_hash: nullableSha256Ref(
      value.parent_lineage_hash,
      'receipt.savepoint.parent_lineage_hash',
    ),
    workspace_digest: requireSha256Ref(
      value.workspace_digest,
      'receipt.savepoint.workspace_digest',
    ),
    receipt_chain_head: requireSha256Ref(
      value.receipt_chain_head,
      'receipt.savepoint.receipt_chain_head',
    ),
  };
}

function normalizeForkSummary(value) {
  assertAllowedKeys(value, [
    'fork_ref_hash',
    'fork_agent_ref',
    'session_ref',
    'identity_hash',
    'provider_ref',
    'provider_capabilities_hash',
  ], 'receipt.fork');
  return {
    fork_ref_hash: requireSha256Ref(value.fork_ref_hash, 'receipt.fork.fork_ref_hash'),
    fork_agent_ref: requireSha256Ref(value.fork_agent_ref, 'receipt.fork.fork_agent_ref'),
    session_ref: requireSha256Ref(value.session_ref, 'receipt.fork.session_ref'),
    identity_hash: requireSha256Ref(value.identity_hash, 'receipt.fork.identity_hash'),
    provider_ref: requireOpaqueRef(value.provider_ref, 'receipt.fork.provider_ref'),
    provider_capabilities_hash: requireSha256Ref(
      value.provider_capabilities_hash,
      'receipt.fork.provider_capabilities_hash',
    ),
  };
}

function normalizeInteractionSummary(value) {
  assertAllowedKeys(value, [
    'mcp_server_ref',
    'mcp_server_origin_hash',
    'mcp_method',
    'tool_name',
    'effective_arguments_hash',
    'action_operation',
  ], 'receipt.interaction');
  return {
    mcp_server_ref: requireOpaqueRef(
      value.mcp_server_ref,
      'receipt.interaction.mcp_server_ref',
    ),
    mcp_server_origin_hash: requireSha256Ref(
      value.mcp_server_origin_hash,
      'receipt.interaction.mcp_server_origin_hash',
    ),
    mcp_method: requireEnum(value.mcp_method, MCP_PHASES, 'receipt.interaction.mcp_method'),
    tool_name: nullableOpaqueRef(value.tool_name, 'receipt.interaction.tool_name'),
    effective_arguments_hash: requireSha256Ref(
      value.effective_arguments_hash,
      'receipt.interaction.effective_arguments_hash',
    ),
    action_operation: value.action_operation == null
      ? null
      : requireEnum(
        value.action_operation,
        ACTION_OPERATIONS,
        'receipt.interaction.action_operation',
      ),
  };
}

function normalizeRiskSummary(value) {
  assertAllowedKeys(
    value,
    ['level', 'action', 'decision_hash', 'policy_decision'],
    'receipt.risk',
  );
  const action = requireEnum(value.action, RISK_ACTION_VALUES, 'receipt.risk.action');
  const policyDecision = requireEnum(
    value.policy_decision,
    ['deny', 'allow_with_boundary'],
    'receipt.risk.policy_decision',
  );
  if ((action === 'DENY') !== (policyDecision === 'deny')) {
    throw new Error('Receipt risk action and policy decision disagree');
  }
  return {
    level: requireEnum(value.level, RISK_LEVELS, 'receipt.risk.level'),
    action,
    decision_hash: requireSha256Ref(value.decision_hash, 'receipt.risk.decision_hash'),
    policy_decision: policyDecision,
  };
}

function normalizeLifecycleSummary(value) {
  assertAllowedKeys(
    value,
    ['state', 'fork_resource_state', 'chain_head', 'event_count'],
    'receipt.lifecycle',
  );
  return {
    state: requireEnum(value.state, RUN_STATES, 'receipt.lifecycle.state'),
    fork_resource_state: requireEnum(
      value.fork_resource_state,
      FORK_RESOURCE_STATES,
      'receipt.lifecycle.fork_resource_state',
    ),
    chain_head: requireSha256Ref(value.chain_head, 'receipt.lifecycle.chain_head'),
    event_count: boundedInteger(value.event_count, 'receipt.lifecycle.event_count', {
      min: 1,
      max: 10_000,
    }),
  };
}

function normalizeCommitSummary(value) {
  if (value === null) return null;
  assertAllowedKeys(
    value,
    ['type', 'proposed_digest', 'accepted_digest', 'validation_evidence_refs'],
    'receipt.commit',
  );
  return {
    type: requireEnum(value.type, COMMIT_TYPES, 'receipt.commit.type'),
    proposed_digest: requireSha256Ref(
      value.proposed_digest,
      'receipt.commit.proposed_digest',
    ),
    accepted_digest: nullableSha256Ref(
      value.accepted_digest,
      'receipt.commit.accepted_digest',
    ),
    validation_evidence_refs: uniqueStrings(
      value.validation_evidence_refs,
      'receipt.commit.validation_evidence_refs',
    ).map((item, index) => requireOpaqueRef(
      item,
      `receipt.commit.validation_evidence_refs[${index}]`,
    )).sort(),
  };
}

function normalizeExecutionAuthorization(value) {
  assertAllowedKeys(value, [
    'ref',
    'hash',
    'grant_embedded',
    'signature_claimed_verified',
    'one_use_claimed_consumed',
  ], 'receipt.execution_authorization');
  const normalized = {
    ref: nullableOpaqueRef(value.ref, 'receipt.execution_authorization.ref'),
    hash: nullableSha256Ref(value.hash, 'receipt.execution_authorization.hash'),
    grant_embedded: value.grant_embedded,
    signature_claimed_verified: value.signature_claimed_verified,
    one_use_claimed_consumed: value.one_use_claimed_consumed,
  };
  if ((normalized.ref === null) !== (normalized.hash === null)) {
    throw new Error('Receipt execution authorization ref and hash must be supplied together');
  }
  if (normalized.grant_embedded !== false
    || normalized.signature_claimed_verified !== false
    || normalized.one_use_claimed_consumed !== false) {
    throw new Error('Risk Fork receipt execution-authorization invariants are invalid');
  }
  return normalized;
}

function normalizeTransactionAssurance(value) {
  assertAllowedKeys(
    value,
    ['evidence_refs', 'settlement_receipt', 'certification'],
    'receipt.transaction_assurance',
  );
  if (value.settlement_receipt !== false || value.certification !== false) {
    throw new Error('Risk Fork receipt Transaction Assurance invariants are invalid');
  }
  return {
    evidence_refs: uniqueStrings(
      value.evidence_refs,
      'receipt.transaction_assurance.evidence_refs',
    ).map((item, index) => requireOpaqueRef(
      item,
      `receipt.transaction_assurance.evidence_refs[${index}]`,
    )).sort(),
    settlement_receipt: false,
    certification: false,
  };
}

function normalizeStaticFlags(value, expected, field) {
  assertAllowedKeys(value, Object.keys(expected), field);
  for (const [key, expectedValue] of Object.entries(expected)) {
    if (value[key] !== expectedValue) {
      throw new Error(`${field} invariant is invalid: ${key}`);
    }
  }
  return { ...expected };
}

function normalizeReceiptRecord(receipt) {
  assertCanonicalJson(receipt);
  assertPlainObject(receipt, 'receipt');
  assertAllowedKeys(receipt, [
    'schema',
    'receipt_id',
    'created_at',
    'savepoint',
    'fork',
    'interaction',
    'risk',
    'lifecycle',
    'claims',
    'taint',
    'commit',
    'execution_authorization',
    'abort_reason',
    'transaction_assurance',
    'timestamps',
    'measurements',
    'privacy',
    'authority_flags',
    'receipt_hash',
  ], 'receipt');
  if (receipt.schema !== 'agoragentic.risk-fork.receipt.v1') {
    throw new TypeError('receipt schema is invalid');
  }
  assertAllowedKeys(receipt.claims, CLAIM_NAMES, 'receipt.claims');
  assertAllowedKeys(
    receipt.taint,
    ['fork_output_tainted', 'raw_child_context_imported', 'memory_merge_supported', 'result_digest'],
    'receipt.taint',
  );
  if (receipt.taint.fork_output_tainted !== true
    || receipt.taint.raw_child_context_imported !== false
    || receipt.taint.memory_merge_supported !== false) {
    throw new Error('Risk Fork receipt taint invariants are invalid');
  }
  const normalized = {
    schema: 'agoragentic.risk-fork.receipt.v1',
    receipt_id: requireOpaqueRef(receipt.receipt_id, 'receipt.receipt_id', { maxLength: 200 }),
    created_at: requireIsoDate(receipt.created_at, 'receipt.created_at'),
    savepoint: normalizeSavepointSummary(receipt.savepoint),
    fork: normalizeForkSummary(receipt.fork),
    interaction: normalizeInteractionSummary(receipt.interaction),
    risk: normalizeRiskSummary(receipt.risk),
    lifecycle: normalizeLifecycleSummary(receipt.lifecycle),
    claims: Object.fromEntries(CLAIM_NAMES.map((name) => [
      name,
      normalizeClaim(receipt.claims[name], `receipt.claims.${name}`),
    ])),
    taint: {
      fork_output_tainted: true,
      raw_child_context_imported: false,
      memory_merge_supported: false,
      result_digest: nullableSha256Ref(
        receipt.taint.result_digest,
        'receipt.taint.result_digest',
      ),
    },
    commit: normalizeCommitSummary(receipt.commit),
    execution_authorization: normalizeExecutionAuthorization(receipt.execution_authorization),
    abort_reason: nullableOpaqueRef(receipt.abort_reason, 'receipt.abort_reason', {
      maxLength: 200,
    }),
    transaction_assurance: normalizeTransactionAssurance(receipt.transaction_assurance),
    timestamps: normalizeTimestamps(receipt.timestamps),
    measurements: normalizeMeasurements(receipt.measurements),
    privacy: normalizeStaticFlags(receipt.privacy, PRIVACY_INVARIANTS, 'receipt.privacy'),
    authority_flags: normalizeStaticFlags(
      receipt.authority_flags,
      RECEIPT_AUTHORITY_INVARIANTS,
      'receipt.authority_flags',
    ),
    receipt_hash: requireSha256Ref(receipt.receipt_hash, 'receipt.receipt_hash'),
  };
  canonicalMatch(receipt, normalized, 'Risk Fork receipt');

  if ((normalized.commit?.type === 'CONSEQUENTIAL_ACTION_PROPOSAL')
    !== (normalized.interaction.action_operation !== null)) {
    throw new Error('Receipt action operation does not match its commit type');
  }
  if (normalized.commit?.type === 'CONSEQUENTIAL_ACTION_PROPOSAL'
    && normalized.execution_authorization.ref === null) {
    throw new Error('Consequential-action receipt lacks its authorization reference and hash');
  }
  if (['observed', 'verified'].includes(normalized.claims.savepoint.status)
    && normalized.claims.savepoint.outcome === 'success'
    && normalized.timestamps.savepoint_ready_at === null) {
    throw new Error('Successful savepoint claim lacks its lifecycle timestamp');
  }
  if (['observed', 'verified'].includes(normalized.claims.fork_start.status)
    && normalized.claims.fork_start.outcome === 'success'
    && normalized.timestamps.fork_started_at === null) {
    throw new Error('Successful fork-start claim lacks its lifecycle timestamp');
  }
  const executionSucceeded = ['observed', 'verified'].includes(
    normalized.claims.execution.status,
  ) && normalized.claims.execution.outcome === 'success';
  const executionFailed = ['observed', 'failed'].includes(
    normalized.claims.execution.status,
  ) && normalized.claims.execution.outcome === 'failure';
  const executionNeutral = ['requested', 'unknown', 'not_applicable'].includes(
    normalized.claims.execution.status,
  ) && ['unknown', 'not_applicable'].includes(normalized.claims.execution.outcome);
  const hasExecutionStartedAt = normalized.timestamps.execution_started_at !== null;
  const hasExecutionCompletedAt = normalized.timestamps.execution_completed_at !== null;
  if (hasExecutionStartedAt !== hasExecutionCompletedAt) {
    throw new Error('Receipt execution timestamps must be supplied together');
  }
  if (executionSucceeded
    && (!hasExecutionStartedAt || normalized.taint.result_digest === null)) {
    throw new Error('Successful execution claim lacks timestamps or its result digest');
  }
  if (executionFailed
    && (!hasExecutionStartedAt || normalized.taint.result_digest !== null)) {
    throw new Error('Failed execution claim requires timestamps and no result digest');
  }
  if (!executionSucceeded && !executionFailed && !executionNeutral) {
    throw new Error('Receipt execution claim has an invalid status and outcome combination');
  }
  if (executionNeutral
    && (hasExecutionStartedAt || normalized.taint.result_digest !== null)) {
    throw new Error('Receipt execution evidence lacks a matching success or failure claim');
  }
  if (normalized.claims.destruction.status === 'verified') {
    if (normalized.lifecycle.fork_resource_state !== 'DESTROYED'
      || normalized.timestamps.destruction_requested_at === null
      || normalized.timestamps.destruction_verified_at === null) {
      throw new Error('Verified destruction claim lacks a destroyed lifecycle and timestamps');
    }
  }
  if (normalized.claims.credential_revocation.status === 'verified'
    && normalized.timestamps.credential_revoked_at === null) {
    throw new Error('Verified credential revocation claim lacks its timestamp');
  }
  if (normalized.lifecycle.state === 'COMMITTED'
    && (normalized.timestamps.committed_at === null
      || normalized.commit?.accepted_digest === null)) {
    throw new Error('Committed receipt lacks its commit timestamp or accepted digest');
  }
  const requestedAt = Date.parse(normalized.timestamps.requested_at);
  if (!Number.isFinite(requestedAt)) throw new Error('Receipt lacks its request timestamp');
  const createdAt = Date.parse(normalized.created_at);
  for (const field of TIMESTAMP_FIELDS) {
    const value = normalized.timestamps[field];
    if (value !== null && Date.parse(value) < requestedAt) {
      throw new Error(`Receipt timestamp precedes the request: ${field}`);
    }
    if (value !== null && Date.parse(value) > createdAt) {
      throw new Error(`Receipt timestamp follows receipt creation: ${field}`);
    }
  }
  const expected = sha256Ref({ ...normalized, receipt_hash: null });
  if (!safeEqual(normalized.receipt_hash, expected)) {
    throw new Error('Risk Fork receipt hash mismatch');
  }
  return normalized;
}

export function createRiskForkReceipt(input = {}) {
  assertAllowedKeys(input, [
    'receipt_id',
    'created_at',
    'capsule',
    'risk_decision',
    'lifecycle',
    'fork_identity',
    'fork_ref',
    'provider_ref',
    'provider_capabilities_hash',
    'savepoint_claim',
    'fork_start_claim',
    'execution_claim',
    'result_digest',
    'commit_artifact',
    'accepted_commit_digest',
    'validation_evidence_refs',
    'execution_authorization_ref',
    'execution_authorization_hash',
    'credential_revocation_claim',
    'credential_revoked_at',
    'destruction_claim',
    'destruction_evidence',
    'abort_reason',
    'transaction_assurance_evidence_refs',
    'measurements',
  ], 'Risk Fork receipt input');
  const createdAt = requireIsoDate(input.created_at ?? new Date(), 'created_at');
  verifySavepointCapsule(input.capsule, { now: createdAt, allowExpired: true });
  verifyLifecycle(input.lifecycle);
  assertFreshForkIdentity(input.fork_identity);
  assertDecisionMatchesCapsule(input.risk_decision, input.capsule);
  if (input.fork_identity.parent_agent_id !== input.capsule.parent.agent_id
    || input.fork_identity.parent_session_id !== input.capsule.parent.session_id) {
    throw new Error('Receipt fork identity does not descend from the Savepoint Capsule parent');
  }
  const providerRef = requireOpaqueRef(input.provider_ref, 'provider_ref');
  const forkRef = requireOpaqueRef(
    input.fork_ref ?? input.commit_artifact?.source_fork_id,
    'fork_ref',
  );
  const binding = assertArtifactCoherence({
    artifact: input.commit_artifact,
    capsule: input.capsule,
    lifecycle: input.lifecycle,
    identity: input.fork_identity,
    providerRef,
    forkRef,
  });
  const executionClaim = normalizeClaim(input.execution_claim, 'execution_claim');
  const successfulExecutionEvent = input.lifecycle.events.find((event) => event.to === 'TAINTED');
  const failedExecutionEvent = input.lifecycle.events.find((event) => (
    event.to === 'EXECUTION_FAILED'
  ));
  const executionSucceeded = ['observed', 'verified'].includes(executionClaim.status)
    && executionClaim.outcome === 'success';
  const executionFailed = ['observed', 'failed'].includes(executionClaim.status)
    && executionClaim.outcome === 'failure';
  const executionNeutral = ['requested', 'unknown', 'not_applicable'].includes(
    executionClaim.status,
  ) && ['unknown', 'not_applicable'].includes(executionClaim.outcome);
  let resultDigest = nullableSha256Ref(input.result_digest, 'result_digest');
  if (executionSucceeded) {
    if (!successfulExecutionEvent?.evidence?.hash || failedExecutionEvent) {
      throw new Error('Successful execution claim is not bound to a TAINTED lifecycle result');
    }
    if (resultDigest !== null
      && !safeEqual(resultDigest, successfulExecutionEvent.evidence.hash)) {
      throw new Error('Receipt result digest differs from the lifecycle execution result');
    }
    resultDigest = successfulExecutionEvent.evidence.hash;
  } else if (executionFailed) {
    if (!failedExecutionEvent || successfulExecutionEvent) {
      throw new Error('Failed execution claim is not bound to an EXECUTION_FAILED lifecycle event');
    }
    if (resultDigest !== null) {
      throw new Error('Failed execution cannot claim a successful result digest');
    }
  } else if (executionNeutral) {
    if (successfulExecutionEvent || failedExecutionEvent) {
      throw new Error('Lifecycle execution outcome lacks a matching receipt claim');
    }
    if (resultDigest !== null) {
      throw new Error('Result digest requires a successful execution claim');
    }
  } else {
    throw new Error('Execution claim has an invalid status and outcome combination');
  }
  const committedEvent = input.lifecycle.events.find((event) => event.to === 'COMMITTED');
  let acceptedCommitDigest = nullableSha256Ref(
    input.accepted_commit_digest,
    'accepted_commit_digest',
  );
  if (committedEvent) {
    if (!input.commit_artifact || !committedEvent.evidence?.hash) {
      throw new Error('Committed lifecycle lacks its artifact or result evidence');
    }
    if (acceptedCommitDigest !== null
      && !safeEqual(acceptedCommitDigest, committedEvent.evidence.hash)) {
      throw new Error('Accepted commit digest differs from the lifecycle commit result');
    }
    acceptedCommitDigest = committedEvent.evidence.hash;
  } else if (acceptedCommitDigest !== null) {
    throw new Error('Accepted commit digest requires a COMMITTED lifecycle event');
  }
  const destructionClaim = normalizeClaim(input.destruction_claim, 'destruction_claim');
  let destructionEvidence = null;
  if (input.lifecycle.fork_resource_state === 'DESTROYED'
    || destructionClaim.status === 'verified') {
    destructionEvidence = normalizeDestructionEvidence(input.destruction_evidence);
    if (destructionEvidence.provider_ref !== providerRef
      || destructionEvidence.fork_ref !== forkRef
      || destructionClaim.status !== 'verified'
      || destructionClaim.outcome !== 'success'
      || destructionClaim.evidence_ref !== destructionEvidence.evidence_ref
      || destructionClaim.evidence_hash !== destructionEvidence.evidence_hash) {
      throw new Error('Receipt destruction claim is not bound to the exact fork and provider');
    }
    const destructionEvent = input.lifecycle.events.find((event) => (
      ['CLEAN_COMMIT_READY', 'DESTROYED'].includes(event.to)
      && event.evidence.status === 'verified'
    ));
    if (!destructionEvent) {
      throw new Error('Receipt lifecycle has no verified destruction event');
    }
  }
  const derivedAuthorization = binding
    ? { ref: binding.authorization_ref, hash: binding.authorization_hash }
    : input.capsule.execution_authorization;
  const suppliedAuthorization = {
    ref: input.execution_authorization_ref ?? null,
    hash: input.execution_authorization_hash ?? null,
  };
  if ((suppliedAuthorization.ref !== null || suppliedAuthorization.hash !== null)
    && (suppliedAuthorization.ref !== derivedAuthorization.ref
      || suppliedAuthorization.hash !== derivedAuthorization.hash)) {
    throw new Error('Receipt execution authorization differs from the bound authorization');
  }
  if (input.capsule.execution_authorization.ref !== null
    && (derivedAuthorization.ref !== input.capsule.execution_authorization.ref
      || derivedAuthorization.hash !== input.capsule.execution_authorization.hash)) {
    throw new Error('Receipt execution authorization differs from the Savepoint Capsule');
  }

  const receipt = {
    schema: 'agoragentic.risk-fork.receipt.v1',
    receipt_id: input.receipt_id == null
      ? null
      : requireOpaqueRef(input.receipt_id, 'receipt_id', { maxLength: 200 }),
    created_at: createdAt,
    savepoint: {
      capsule_id: input.capsule.capsule_id,
      capsule_hash: input.capsule.capsule_hash,
      parent_agent_ref: sha256Ref(input.capsule.parent.agent_id),
      parent_session_ref: sha256Ref(input.capsule.parent.session_id),
      parent_lineage_hash: input.capsule.parent.lineage_hash,
      workspace_digest: input.capsule.workspace.digest,
      receipt_chain_head: input.capsule.receipt_chain_head,
    },
    fork: {
      fork_ref_hash: sha256Ref(forkRef),
      fork_agent_ref: sha256Ref(input.fork_identity.fork_agent_id),
      session_ref: sha256Ref(input.fork_identity.session_id),
      identity_hash: input.fork_identity.identity_hash,
      provider_ref: providerRef,
      provider_capabilities_hash: requireSha256Ref(
        input.provider_capabilities_hash,
        'provider_capabilities_hash',
      ),
    },
    interaction: {
      mcp_server_ref: input.capsule.proposed_interaction.mcp_server_ref,
      mcp_server_origin_hash: sha256Ref(input.capsule.proposed_interaction.mcp_server_origin),
      mcp_method: input.capsule.proposed_interaction.mcp_method,
      tool_name: input.capsule.proposed_interaction.tool_name,
      effective_arguments_hash: input.capsule.proposed_interaction.effective_arguments_hash,
      action_operation: binding?.action_operation ?? null,
    },
    risk: {
      level: input.risk_decision.level,
      action: input.risk_decision.action,
      decision_hash: input.risk_decision.decision_hash,
      policy_decision: input.risk_decision.blocked ? 'deny' : 'allow_with_boundary',
    },
    lifecycle: {
      state: input.lifecycle.state,
      fork_resource_state: input.lifecycle.fork_resource_state,
      chain_head: input.lifecycle.chain_head,
      event_count: input.lifecycle.events.length,
    },
    claims: {
      savepoint: normalizeClaim(input.savepoint_claim, 'savepoint_claim'),
      fork_start: normalizeClaim(input.fork_start_claim, 'fork_start_claim'),
      execution: executionClaim,
      credential_revocation: normalizeClaim(
        input.credential_revocation_claim,
        'credential_revocation_claim',
      ),
      destruction: destructionClaim,
    },
    taint: {
      fork_output_tainted: true,
      raw_child_context_imported: false,
      memory_merge_supported: false,
      result_digest: resultDigest,
    },
    commit: input.commit_artifact ? {
      type: input.commit_artifact.commit_type,
      proposed_digest: input.commit_artifact.artifact_hash,
      accepted_digest: acceptedCommitDigest,
      validation_evidence_refs: uniqueStrings(
        input.validation_evidence_refs,
        'validation_evidence_refs',
      ).map((value, index) => requireOpaqueRef(
        value,
        `validation_evidence_refs[${index}]`,
      )).sort(),
    } : null,
    execution_authorization: {
      ref: derivedAuthorization.ref,
      hash: derivedAuthorization.hash,
      grant_embedded: false,
      signature_claimed_verified: false,
      one_use_claimed_consumed: false,
    },
    abort_reason: nullableOpaqueRef(input.abort_reason, 'abort_reason', { maxLength: 200 }),
    transaction_assurance: {
      evidence_refs: uniqueStrings(
        input.transaction_assurance_evidence_refs,
        'transaction_assurance_evidence_refs',
      ).map((value, index) => requireOpaqueRef(
        value,
        `transaction_assurance_evidence_refs[${index}]`,
      )).sort(),
      settlement_receipt: false,
      certification: false,
    },
    timestamps: deriveTimestamps(input.lifecycle, input.credential_revoked_at),
    measurements: normalizeMeasurements(input.measurements),
    privacy: { ...PRIVACY_INVARIANTS },
    authority_flags: { ...RECEIPT_AUTHORITY_INVARIANTS },
    receipt_hash: null,
  };
  if (destructionEvidence === null && destructionClaim.status === 'verified') {
    throw new Error('Verified destruction cannot be recorded without bound evidence');
  }
  if (!receipt.receipt_id) {
    const identitySeed = sha256Ref({ ...receipt, receipt_hash: null });
    receipt.receipt_id = `rfr_${identitySeed.slice(7, 23)}`;
  }
  receipt.receipt_hash = sha256Ref({ ...receipt, receipt_hash: null });
  verifyRiskForkReceipt(receipt);
  return deepFreeze(receipt);
}

export function verifyRiskForkReceipt(receipt) {
  normalizeReceiptRecord(receipt);
  return true;
}
