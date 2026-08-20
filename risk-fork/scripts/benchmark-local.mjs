import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { performance } from 'node:perf_hooks';

import { canonicalize, sha256Ref } from '../src/canonical.mjs';
import {
  createForkIdentity,
  createSavepointCapsule,
  networkPolicy,
} from '../src/contracts.mjs';
import {
  inspectLocalWorkspace,
  LocalReferenceRiskForkAdapter,
} from '../src/adapters/local-reference.mjs';

const SAMPLE_COUNT = 5;

function elapsed(startedAt) {
  return Number((performance.now() - startedAt).toFixed(3));
}

function summarize(samples) {
  const ordered = [...samples].sort((left, right) => left - right);
  const percentile = (fraction) => ordered[Math.min(
    ordered.length - 1,
    Math.max(0, Math.ceil(ordered.length * fraction) - 1),
  )];
  return {
    samples: ordered.length,
    min_ms: ordered[0],
    p50_ms: percentile(0.5),
    p95_ms: percentile(0.95),
    max_ms: ordered.at(-1),
  };
}

const root = await mkdtemp(path.join(os.tmpdir(), 'risk-fork-local-benchmark-'));
const sourceWorkspace = path.join(root, 'source');
const providerState = path.join(root, 'provider-state');
await mkdir(sourceWorkspace, { recursive: false });

const metrics = {
  savepoint_creation_ms: [],
  fork_startup_ms: [],
  closed_operation_execution_ms: [],
  diff_collection_ms: [],
  fork_destroy_and_verify_ms: [],
};

let adapter;
try {
  const inspection = await inspectLocalWorkspace({ source_workspace: sourceWorkspace });
  const resultSchema = {
    type: 'object',
    additionalProperties: false,
    required: ['iteration'],
    properties: { iteration: { type: 'integer', minimum: 0 } },
  };
  const createdAt = new Date();
  const capsule = createSavepointCapsule({
    created_at: createdAt,
    expires_at: new Date(createdAt.getTime() + 10 * 60_000),
    parent: {
      agent_id: 'local_benchmark_parent_agent',
      session_id: 'local_benchmark_parent_session',
      state_hash: sha256Ref('local-benchmark-parent-state'),
      lineage_ref: 'local_benchmark_lineage',
      lineage_hash: sha256Ref('local-benchmark-lineage'),
    },
    agent_configuration: {
      model_version_hash: sha256Ref('local-benchmark-model'),
      system_instruction_hash: sha256Ref('local-benchmark-instructions'),
      tool_manifest_hash: sha256Ref('local-benchmark-tools'),
    },
    checkpoint: {
      goal_ref: 'local_benchmark_goal',
      goal_hash: sha256Ref('local-benchmark-goal'),
      task_graph_ref: 'local_benchmark_task_graph',
      task_graph_hash: sha256Ref('local-benchmark-task-graph'),
    },
    memory_roots: [],
    workspace: {
      snapshot_ref: 'local_benchmark_workspace',
      digest: inspection.workspace_digest,
    },
    governance: {
      policy_version: 'local-benchmark-policy-v1',
      policy_hash: sha256Ref('local-benchmark-policy'),
    },
    receipt_chain_head: sha256Ref('local-benchmark-receipt-head'),
    proposed_interaction: {
      mcp_server_ref: 'local_benchmark_server',
      mcp_server_origin: 'https://local-benchmark.invalid/',
      mcp_method: 'tools/call',
      tool_name: 'benchmark_local_reference',
      effective_arguments_hash: sha256Ref({ benchmark: true }),
      target_ref: 'local_benchmark_target',
    },
    execution_authorization: { ref: null, hash: null },
    allowed_commit_types: ['TYPED_RESULT'],
    authorized_result_schema_hash: sha256Ref(resultSchema),
    runtime_snapshot: { mode: 'none' },
  });

  adapter = new LocalReferenceRiskForkAdapter({ baseDirectory: providerState });
  await adapter.initialize();
  let startedAt = performance.now();
  const savepoint = await adapter.createSavepoint({
    capsule,
    source_workspace: sourceWorkspace,
  });
  metrics.savepoint_creation_ms.push(elapsed(startedAt));

  let lastDiffBytes = 0;
  for (let iteration = 0; iteration < SAMPLE_COUNT; iteration += 1) {
    const identity = createForkIdentity({
      parent_agent_id: capsule.parent.agent_id,
      parent_session_id: capsule.parent.session_id,
    });
    startedAt = performance.now();
    const fork = await adapter.createFork({
      savepoint_ref: savepoint.savepoint_ref,
      fork_identity: identity,
      network_policy: networkPolicy({ mode: 'blocked' }),
      ttl_ms: 60_000,
    });
    metrics.fork_startup_ms.push(elapsed(startedAt));

    startedAt = performance.now();
    await adapter.executeInFork({
      fork_ref: fork.fork_ref,
      execution_mode: 'isolated_execution',
      timeout_ms: 5_000,
      operation: {
        kind: 'bounded_file_batch',
        actions: [{
          type: 'write',
          path: `benchmark-${iteration}.txt`,
          content: `iteration ${iteration}\n`,
        }],
        commit_candidate: {
          type: 'TYPED_RESULT',
          payload: { iteration },
          payload_schema: resultSchema,
        },
      },
    });
    metrics.closed_operation_execution_ms.push(elapsed(startedAt));

    startedAt = performance.now();
    const diff = await adapter.collectDiff({ fork_ref: fork.fork_ref });
    metrics.diff_collection_ms.push(elapsed(startedAt));
    lastDiffBytes = Buffer.byteLength(canonicalize(diff), 'utf8');

    startedAt = performance.now();
    await adapter.destroyFork({ fork_ref: fork.fork_ref, reason: 'benchmark_iteration_complete' });
    const destruction = await adapter.verifyDestroyed({ fork_ref: fork.fork_ref });
    metrics.fork_destroy_and_verify_ms.push(elapsed(startedAt));
    if (destruction.status !== 'verified') {
      throw new Error('Local benchmark could not verify fork absence');
    }
  }

  const savepointDestroyStartedAt = performance.now();
  await adapter.destroySavepoint({ savepoint_ref: savepoint.savepoint_ref });
  const savepointDestruction = await adapter.verifySavepointDestroyed({
    savepoint_ref: savepoint.savepoint_ref,
  });
  if (savepointDestruction.status !== 'verified') {
    throw new Error('Local benchmark could not verify savepoint absence');
  }

  process.stdout.write(`${JSON.stringify({
    schema: 'agoragentic.risk-fork.local-benchmark.v1',
    measured_at: new Date().toISOString(),
    environment: {
      node: process.version,
      platform: process.platform,
      architecture: process.arch,
    },
    scope: 'local_reference_protocol_only',
    sample_count: SAMPLE_COUNT,
    measurements: Object.fromEntries(
      Object.entries(metrics).map(([name, samples]) => [name, summarize(samples)]),
    ),
    capsule_bytes: Buffer.byteLength(canonicalize(capsule), 'utf8'),
    last_workspace_diff_bytes: lastDiffBytes,
    savepoint_destroy_and_verify_ms: elapsed(savepointDestroyStartedAt),
    unmeasured: [
      'additional_live_mcp_latency',
      'cloud_provider_startup_and_destruction',
      'cloud_containment',
      'provider_cost',
    ],
    claims: {
      isolation_verified: false,
      network_containment_verified: false,
      cloud_provider_qualified: false,
      performance_slo_established: false,
    },
  }, null, 2)}\n`);
} finally {
  try {
    if (adapter) await adapter.dispose();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}
