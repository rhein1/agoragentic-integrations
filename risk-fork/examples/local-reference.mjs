import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { sha256Ref } from '../src/canonical.mjs';
import {
  createForkIdentity,
  createSavepointCapsule,
  networkPolicy,
} from '../src/contracts.mjs';
import { validateCommitCandidate } from '../src/taint-gate.mjs';
import {
  inspectLocalWorkspace,
  LocalReferenceRiskForkAdapter,
} from '../src/adapters/local-reference.mjs';

// This example is intentionally an authority-free protocol demonstration.
// No provider, network, credential, payment, or commit is used.
const demoRoot = await mkdtemp(path.join(os.tmpdir(), 'risk-fork-local-example-'));
const sourceWorkspace = path.join(demoRoot, 'source');
const providerState = path.join(demoRoot, 'provider-state');
await mkdir(sourceWorkspace, { recursive: false });

let adapter = null;
try {
  const workspaceInspection = await inspectLocalWorkspace({
    source_workspace: sourceWorkspace,
  });
  const typedResultSchema = {
    type: 'object',
    additionalProperties: false,
    required: ['summary'],
    properties: {
      summary: { type: 'string', maxLength: 200 },
    },
  };

  const createdAt = new Date();
  const capsule = createSavepointCapsule({
    created_at: createdAt,
    expires_at: new Date(createdAt.getTime() + 10 * 60_000),
    parent: {
      agent_id: 'local_demo_parent_agent',
      session_id: 'local_demo_parent_session',
      state_hash: sha256Ref('local-demo-parent-state'),
      lineage_ref: 'local_demo_lineage_ref',
      lineage_hash: sha256Ref('local-demo-lineage'),
    },
    agent_configuration: {
      model_version_hash: sha256Ref('local-demo-model'),
      system_instruction_hash: sha256Ref('local-demo-system-instructions'),
      tool_manifest_hash: sha256Ref('local-demo-tool-manifest'),
    },
    checkpoint: {
      goal_ref: 'local_demo_goal_ref',
      goal_hash: sha256Ref('local-demo-goal'),
      task_graph_ref: 'local_demo_task_graph_ref',
      task_graph_hash: sha256Ref('local-demo-task-graph'),
    },
    memory_roots: [],
    workspace: {
      snapshot_ref: 'local_demo_empty_workspace',
      digest: workspaceInspection.workspace_digest,
    },
    governance: {
      policy_version: 'local-demo-policy-v1',
      policy_hash: sha256Ref('local-demo-policy'),
    },
    receipt_chain_head: sha256Ref('local-demo-receipt-chain-head'),
    proposed_interaction: {
      mcp_server_ref: 'local_reference_server',
      mcp_server_origin: 'https://local-reference.invalid/',
      mcp_method: 'tools/call',
      tool_name: 'prepare_typed_result',
      effective_arguments_hash: sha256Ref({ request: 'prepare-local-demo' }),
      target_ref: 'local_demo_target',
    },
    execution_authorization: { ref: null, hash: null },
    allowed_commit_types: ['TYPED_RESULT'],
    authorized_result_schema_hash: sha256Ref(typedResultSchema),
    runtime_snapshot: { mode: 'none' },
  });

  const forkIdentity = createForkIdentity({
    parent_agent_id: capsule.parent.agent_id,
    parent_session_id: capsule.parent.session_id,
  });

  adapter = new LocalReferenceRiskForkAdapter({ baseDirectory: providerState });
  await adapter.initialize();
  const savepoint = await adapter.createSavepoint({
    capsule,
    source_workspace: sourceWorkspace,
  });
  const fork = await adapter.createFork({
    savepoint_ref: savepoint.savepoint_ref,
    fork_identity: forkIdentity,
    network_policy: networkPolicy({ mode: 'blocked' }),
    ttl_ms: 60_000,
  });
  const execution = await adapter.executeInFork({
    fork_ref: fork.fork_ref,
    execution_mode: 'isolated_execution',
    timeout_ms: 5_000,
    operation: {
      kind: 'bounded_file_batch',
      actions: [],
      commit_candidate: {
        type: 'TYPED_RESULT',
        payload: { summary: 'Prepared inside the local reference child.' },
        payload_schema: typedResultSchema,
      },
    },
  });
  const artifact = validateCommitCandidate({
    candidate: execution.commit_candidate,
    source_fork_id: fork.fork_ref,
    policy: { typed_result_schema_hash: sha256Ref(typedResultSchema) },
  });

  await adapter.destroyFork({ fork_ref: fork.fork_ref, reason: 'example_complete' });
  const forkDestruction = await adapter.verifyDestroyed({ fork_ref: fork.fork_ref });
  await adapter.destroySavepoint({ savepoint_ref: savepoint.savepoint_ref });
  const savepointDestruction = await adapter.verifySavepointDestroyed({
    savepoint_ref: savepoint.savepoint_ref,
  });

  if (forkDestruction.status !== 'verified' || savepointDestruction.status !== 'verified') {
    throw new Error('The local reference copies were not independently verified absent');
  }

  process.stdout.write(`${JSON.stringify({
    schema: 'agoragentic.risk-fork.local-example-result.v1',
    status: 'prepared_not_committed',
    adapter: adapter.id,
    isolation_claim: 'none_local_protocol_reference_only',
    capsule_hash: capsule.capsule_hash,
    fork_identity_hash: forkIdentity.identity_hash,
    artifact_hash: artifact.artifact_hash,
    fork_destruction_status: forkDestruction.status,
    savepoint_destruction_status: savepointDestruction.status,
    clean_commit_performed: false,
    credentials_used: false,
    network_used: false,
  }, null, 2)}\n`);
} finally {
  try {
    if (adapter) await adapter.dispose();
  } finally {
    await rm(demoRoot, { recursive: true, force: true });
  }
}
