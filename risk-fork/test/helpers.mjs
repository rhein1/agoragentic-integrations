import { sha256Ref } from '../src/canonical.mjs';
import {
  buildExecutionBinding,
  createForkIdentity,
  createSavepointCapsule,
} from '../src/contracts.mjs';
import { createLifecycle, transitionLifecycle } from '../src/lifecycle.mjs';

export const NOW = new Date('2030-01-01T00:00:00.000Z');
export const LATER = '2030-01-01T01:00:00.000Z';

export function hash(value) {
  return sha256Ref(value);
}

export function closedResultSchema() {
  return {
    type: 'object',
    additionalProperties: false,
    required: ['answer'],
    properties: {
      answer: { type: 'string', maxLength: 100 },
    },
  };
}

export function makeCapsule(overrides = {}) {
  const schema = overrides.result_schema ?? closedResultSchema();
  return createSavepointCapsule({
    created_at: overrides.created_at ?? NOW,
    expires_at: overrides.expires_at ?? LATER,
    parent: {
      agent_id: 'parent-agent',
      session_id: 'parent-session',
      state_hash: hash('parent-state'),
      lineage_ref: 'lineage:1',
      lineage_hash: hash('lineage'),
      ...overrides.parent,
    },
    agent_configuration: {
      model_version_hash: hash('model'),
      system_instruction_hash: hash('system'),
      tool_manifest_hash: hash('tools'),
      ...overrides.agent_configuration,
    },
    checkpoint: {
      goal_ref: 'goal:1',
      goal_hash: hash('goal'),
      task_graph_ref: 'task-graph:1',
      task_graph_hash: hash('task-graph'),
      ...overrides.checkpoint,
    },
    memory_roots: overrides.memory_roots ?? [],
    workspace: {
      snapshot_ref: 'workspace:1',
      digest: hash('workspace'),
      ...overrides.workspace,
    },
    governance: {
      policy_ref: 'policy:1',
      policy_version: 'policy-v1',
      policy_hash: hash('policy'),
      mandate_ref: 'mandate:1',
      mandate_version: 'mandate-v1',
      mandate_hash: hash('mandate'),
      budget_policy_ref: 'budget-policy:1',
      budget_version: 'budget-v1',
      budget_hash: hash('budget'),
      epoch: 'governance-epoch:1',
      ...overrides.governance,
    },
    receipt_chain_head: overrides.receipt_chain_head ?? hash('receipt-chain'),
    proposed_interaction: {
      mcp_server_ref: 'mcp-server:1',
      mcp_server_origin: 'https://mcp.example.invalid/',
      mcp_method: 'tools/call',
      tool_name: 'example_tool',
      effective_arguments_hash: hash({ value: 1 }),
      target_ref: 'target:1',
      ...overrides.proposed_interaction,
    },
    execution_authorization: overrides.execution_authorization ?? {
      ref: 'authorization-ref:1',
      hash: hash('authorization-record'),
    },
    allowed_commit_types: overrides.allowed_commit_types ?? [
      'TYPED_RESULT',
      'WORKSPACE_DIFF',
      'CONSEQUENTIAL_ACTION_PROPOSAL',
    ],
    authorized_result_schema_hash: overrides.authorized_result_schema_hash ?? hash(schema),
    runtime_snapshot: overrides.runtime_snapshot ?? { mode: 'none' },
  });
}

export function makeForkIdentity(capsule = makeCapsule()) {
  return createForkIdentity({
    parent_agent_id: capsule.parent.agent_id,
    parent_session_id: capsule.parent.session_id,
    issued_at: NOW,
  });
}

export function makeBinding({ capsule = makeCapsule(), identity = makeForkIdentity(capsule), ...overrides } = {}) {
  const argumentsValue = overrides.effective_arguments ?? { value: 1 };
  return buildExecutionBinding({
    principal_ref: 'principal:1',
    action_operation: overrides.action_operation
      ?? (overrides.amount == null ? 'mcp_tool_call' : 'payment'),
    fork_agent_id: identity.fork_agent_id,
    session_id: identity.session_id,
    mcp_server_ref: capsule.proposed_interaction.mcp_server_ref,
    mcp_server_origin: capsule.proposed_interaction.mcp_server_origin,
    mcp_method: capsule.proposed_interaction.mcp_method,
    raw_method: capsule.proposed_interaction.raw_method,
    tool_name: capsule.proposed_interaction.tool_name,
    effective_arguments: argumentsValue,
    provider_ref: 'provider:1',
    target_ref: capsule.proposed_interaction.target_ref,
    amount: overrides.amount,
    currency: overrides.currency,
    payment_rail: overrides.payment_rail,
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
    issued_at: NOW,
    not_before: NOW,
    expires_at: LATER,
    nonce: 'nonce:1',
    one_use_authorization_id: 'authorization:1',
    audience: 'risk-fork-clean-controller',
    authorization_ref: 'authorization-ref:1',
    authorization_hash: hash('authorization-record'),
    ...overrides,
    effective_arguments: argumentsValue,
  });
}

function next(lifecycle, to, options = {}) {
  return transitionLifecycle(lifecycle, {
    actor: 'clean_controller',
    expected_version: lifecycle.version,
    expected_chain_head: lifecycle.chain_head,
    to,
    at: NOW,
    reason: to.toLowerCase(),
    evidence: options.evidence ?? {
      status: 'observed',
      ref: `event:${to.toLowerCase()}`,
      hash: hash(to),
      detail: to.toLowerCase(),
    },
    ...(options.resource ? { fork_resource_state: options.resource } : {}),
  });
}

export function makePreparedLifecycle(artifactHash) {
  let lifecycle = createLifecycle({
    run_id: 'run:1',
    requested_at: NOW,
    actor: 'clean_controller',
    reason: 'requested',
    evidence: { status: 'observed', ref: 'event:requested', hash: hash('requested') },
  });
  lifecycle = next(lifecycle, 'SAVEPOINTING');
  lifecycle = next(lifecycle, 'SAVEPOINT_READY');
  lifecycle = next(lifecycle, 'FORK_STARTING');
  lifecycle = next(lifecycle, 'FORK_READY', { resource: 'ACTIVE' });
  lifecycle = next(lifecycle, 'EXECUTING');
  lifecycle = next(lifecycle, 'TAINTED');
  lifecycle = next(lifecycle, 'VALIDATING');
  lifecycle = next(lifecycle, 'COMMIT_READY', {
    evidence: {
      status: 'verified',
      ref: 'artifact:validated',
      hash: artifactHash,
      detail: 'tainted_artifact_validated',
    },
  });
  lifecycle = next(lifecycle, 'PRECOMMIT_DESTROYING', { resource: 'DESTROY_REQUESTED' });
  lifecycle = next(lifecycle, 'CLEAN_COMMIT_READY', {
    resource: 'DESTROYED',
    evidence: {
      status: 'verified',
      ref: 'cleanup:verified',
      hash: hash('cleanup'),
      detail: 'fork_and_savepoint_absence_verified',
    },
  });
  return lifecycle;
}

export function advanceToCommitting(lifecycle) {
  return next(lifecycle, 'COMMITTING');
}
