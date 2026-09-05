import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import {
  LocalReferenceRiskForkAdapter,
  RiskForkController,
  createRiskForkHostBoundary,
  createRiskForkMcpHostAdapter,
  createRiskForkMcpPhasePlan,
  createSavepointCapsule,
  createTrustedRiskDescriptor,
  createTrustedRiskDescriptorSource,
  createTrustedRiskForkMcpPhasePlanSource,
  inspectLocalWorkspace,
  sha256Ref,
} from '../src/index.mjs';

const clock = () => new Date();

function enforcementRequest({ schema, phase, sessionBindingHash = null, params = {} }) {
  const target = new URL('https://mcp.agoragentic.com/demo-source-only');
  const request = {
    schema,
    request_id: `mcp-enforcement:local-${randomUUID()}`,
    phase,
    raw_method: null,
    mcp_server_ref: target.href,
    mcp_server_origin: target.origin,
    session_binding_hash: sessionBindingHash,
    tool_name: null,
    tool_descriptor: null,
    tool_descriptor_hash: null,
    tool_annotations: null,
    tool_capabilities: null,
    tool_effect_status: null,
    params,
    risk_profile: {
      minimum_level: 'HIGH',
      untrusted_content: true,
      prepare_only: false,
    },
    transport_constraints: {
      direct_network_permitted: false,
      https_required: true,
      address_scope: 'public_unicast_only',
      dns_resolution: 'child_before_each_connection_attempt',
      address_pinning_required: true,
      proxy_environment_allowed: false,
      redirects: 'error',
      max_redirects: 0,
      transport_evidence_required: true,
      response_acceptance: 'clean_import_only',
      fallback_on_protocol_error: false,
      credential_material_in_child: false,
    },
    fallback_http: null,
    request_hash: null,
  };
  request.request_hash = sha256Ref(request);
  return request;
}

function completeCapabilities() {
  return {
    network_access: false,
    filesystem_read: false,
    filesystem_write: false,
    credential_access: false,
    wallet_or_payment: false,
    deployment: false,
    publication: false,
    communication: false,
    database_mutation: false,
    trust_or_reputation_mutation: false,
    external_side_effect: false,
    unknown_or_unclassified: false,
  };
}

function resultForPhase(phase) {
  if (phase === 'server/discover') {
    return {
      payload: { protocol_version: '2026-07-28', stateless: true },
      schema: {
        type: 'object',
        additionalProperties: false,
        required: ['protocol_version', 'stateless'],
        properties: {
          protocol_version: { type: 'string', maxLength: 20 },
          stateless: { type: 'boolean' },
        },
      },
    };
  }
  if (phase === 'tools/list') {
    return {
      payload: { tools: [] },
      schema: {
        type: 'object',
        additionalProperties: false,
        required: ['tools'],
        properties: { tools: { type: 'array', maxItems: 0 } },
      },
    };
  }
  throw new Error('This source-only example plans only discovery and tools/list');
}

function capsuleFor(planRequest, workspaceDigest, resultSchema) {
  const createdAt = clock();
  const expiresAt = new Date(createdAt.getTime() + 10 * 60 * 1000);
  return createSavepointCapsule({
    created_at: createdAt,
    expires_at: expiresAt,
    parent: {
      agent_id: 'agent:local-mcp-example',
      session_id: 'session:local-mcp-example',
      state_hash: sha256Ref('local-parent-state'),
      lineage_ref: null,
      lineage_hash: null,
    },
    agent_configuration: {
      model_version_hash: sha256Ref('local-model'),
      system_instruction_hash: sha256Ref('local-system'),
      tool_manifest_hash: sha256Ref('local-tools'),
    },
    checkpoint: {
      goal_ref: 'goal:local-mcp-example',
      goal_hash: sha256Ref('local-goal'),
      task_graph_ref: 'task-graph:local-mcp-example',
      task_graph_hash: sha256Ref('local-task-graph'),
    },
    memory_roots: [],
    workspace: {
      snapshot_ref: 'workspace:local-mcp-example',
      digest: workspaceDigest,
    },
    governance: {
      policy_ref: 'policy:local-mcp-example',
      policy_version: 'v1',
      policy_hash: sha256Ref('local-policy'),
      mandate_ref: null,
      mandate_version: null,
      mandate_hash: null,
      budget_policy_ref: null,
      budget_version: null,
      budget_hash: null,
      epoch: 'epoch:local-mcp-example',
    },
    receipt_chain_head: sha256Ref('local-receipt-chain'),
    proposed_interaction: {
      mcp_server_ref: planRequest.mcp_server_ref,
      mcp_server_origin: new URL(planRequest.mcp_server_origin).toString(),
      mcp_method: planRequest.phase,
      raw_method: null,
      tool_name: null,
      effective_arguments_hash: sha256Ref(planRequest.params),
      target_ref: `mcp-request:${planRequest.mcp_request_hash.slice(7)}`,
    },
    execution_authorization: {},
    allowed_commit_types: ['TYPED_RESULT'],
    authorized_result_schema_hash: sha256Ref(resultSchema),
    runtime_snapshot: { mode: 'none' },
  });
}

const temporaryRoot = await mkdtemp(path.join(os.tmpdir(), 'risk-fork-mcp-example-'));
const sourceWorkspace = path.join(temporaryRoot, 'source');
await mkdir(sourceWorkspace);
const inspected = await inspectLocalWorkspace({ source_workspace: sourceWorkspace });
const provider = new LocalReferenceRiskForkAdapter({
  baseDirectory: path.join(temporaryRoot, 'provider'),
  clock,
});

try {
  const controller = new RiskForkController({ provider, mode: 'demonstration', clock });
  const descriptorInputs = new Map();
  const descriptorSource = createTrustedRiskDescriptorSource((request) => {
    const input = descriptorInputs.get(request.descriptor_ref);
    if (!input) throw new Error('Descriptor was not created by this clean host');
    return createTrustedRiskDescriptor(request, input);
  });
  const hostBoundary = createRiskForkHostBoundary({
    controller,
    trusted_descriptor_source: descriptorSource,
    clock,
  });
  const observedPhases = [];
  const planSource = createTrustedRiskForkMcpPhasePlanSource((planRequest) => {
    observedPhases.push(planRequest.phase);
    const result = resultForPhase(planRequest.phase);
    const descriptorRef = `descriptor:${planRequest.plan_request_id.split(':').at(-1)}`;
    descriptorInputs.set(descriptorRef, {
      mcp_phase: planRequest.phase,
      raw_method: null,
      mcp_server_ref: planRequest.mcp_server_ref,
      mcp_server_origin: planRequest.mcp_server_origin,
      mcp_server_trust: 'reachable',
      mcp_server_attestation: null,
      tool_name: null,
      tool_annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
      capabilities: completeCapabilities(),
      prompt_injection_indicators: [],
      owner_policy: {
        minimum_level: 'HIGH',
        force_risk_fork: true,
        deny_irreversible: true,
        trusted_server_refs: [],
        trusted_attestor_refs: [],
        trusted_attestation_hashes: [],
        trust_registry_version: null,
        allowed_egress: [],
      },
    });
    const capsule = capsuleFor(planRequest, inspected.workspace_digest, result.schema);
    return createRiskForkMcpPhasePlan(planRequest, {
      descriptor_ref: descriptorRef,
      operation_input: {
        capsule,
        savepoint_input: { source_workspace: sourceWorkspace },
        operation: {
          kind: 'bounded_file_batch',
          actions: [],
          commit_candidate: {
            type: 'TYPED_RESULT',
            payload: result.payload,
            payload_schema: result.schema,
          },
        },
        effective_arguments: planRequest.params,
        expected_commit_type: 'TYPED_RESULT',
        commit_policy: { typed_result_schema_hash: capsule.authorized_result_schema_hash },
        expected_binding: {},
        network_policy: { mode: 'blocked' },
      },
    });
  });
  const adapter = createRiskForkMcpHostAdapter({
    host_boundary: hostBoundary,
    trusted_phase_plan_source: planSource,
    synthetic_demo_mode: true,
    clock,
  });

  const openRequest = enforcementRequest({
    schema: 'agoragentic.mcp.enforced-session-open-request.v1',
    phase: 'server/discover',
    params: { protocol_version: '2026-07-28', stateless_required: true },
  });
  const session = await adapter.openSession(openRequest);
  const binding = sha256Ref({
    open_request_hash: openRequest.request_hash,
    discovery_evidence_hash: session.discovery.evidence_hash,
    discovery_result_hash: sha256Ref(session.discovery.result),
    protocol_version: session.discovery.result.protocol_version,
    stateless: session.discovery.result.stateless,
  });
  const listResult = await session.request(enforcementRequest({
    schema: 'agoragentic.mcp.enforced-phase-request.v1',
    phase: 'tools/list',
    sessionBindingHash: binding,
  }));
  await session.close();

  process.stdout.write(`${JSON.stringify({
    schema: 'agoragentic.risk-fork.mcp-host-adapter-example-result.v1',
    status: 'passed',
    demo_only: true,
    synthetic_mcp_payloads: true,
    isolation_boundary: false,
    live_protection: false,
    remote_mcp_contacted: false,
    direct_transport_exposed: false,
    fallback_execution_permitted: false,
    authority_granted: false,
    observed_phases: observedPhases,
    listed_tool_count: listResult.result.tools.length,
    fork_count: provider.forks.size,
    savepoint_count: provider.savepoints.size,
    cleanup_verified: [...provider.forks.values(), ...provider.savepoints.values()]
      .every((entry) => entry.destroyed),
  }, null, 2)}\n`);
} finally {
  await provider.dispose();
  await rm(temporaryRoot, { recursive: true, force: true });
}
