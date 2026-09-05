import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';

import {
  LocalReferenceRiskForkAdapter,
  inspectLocalWorkspace,
} from '../src/adapters/local-reference.mjs';
import { sha256Ref } from '../src/canonical.mjs';
import { createSavepointCapsule } from '../src/contracts.mjs';
import { RiskForkController } from '../src/controller.mjs';
import {
  createRiskForkHostBoundary,
  createTrustedRiskDescriptor,
  createTrustedRiskDescriptorSource,
} from '../src/host-boundary.mjs';
import {
  RISK_FORK_MCP_HOST_DIAGNOSTIC_CODES,
  RiskForkMcpHostAdapterError,
  createRiskForkMcpHostAdapter,
  createRiskForkMcpPhasePlan,
  createTrustedRiskForkMcpPhasePlanSource,
  isRiskForkMcpHostAdapter,
} from '../src/mcp-host-adapter.mjs';

const require = createRequire(import.meta.url);
const {
  connectRemoteClient,
  createMcpEnforcementBoundary,
} = require('../../mcp/mcp-server.js');

const NOW = new Date('2030-01-01T00:00:00.000Z');
const LATER = '2030-01-01T01:00:00.000Z';

function enforcementRequest({
  schema,
  phase,
  sessionBindingHash = null,
  params = {},
  toolDescriptor = null,
  toolCapabilities = null,
  toolAnnotations = null,
  toolEffectStatus = null,
  minimumLevel = 'HIGH',
}) {
  const target = new URL('https://mcp.example.test/rpc');
  const request = {
    schema,
    request_id: `mcp-enforcement:test-${Math.random().toString(16).slice(2)}`,
    phase,
    raw_method: null,
    mcp_server_ref: target.href,
    mcp_server_origin: target.origin,
    session_binding_hash: sessionBindingHash,
    tool_name: toolDescriptor?.name ?? null,
    tool_descriptor: toolDescriptor,
    tool_descriptor_hash: toolDescriptor ? sha256Ref(toolDescriptor) : null,
    tool_annotations: toolAnnotations,
    tool_capabilities: toolCapabilities,
    tool_effect_status: toolEffectStatus,
    params,
    risk_profile: {
      minimum_level: minimumLevel,
      untrusted_content: true,
      prepare_only: minimumLevel === 'IRREVERSIBLE',
    },
    transport_constraints: {
      direct_network_permitted: false,
      redirects: 'error',
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

function sessionBinding(openRequest, discovery) {
  return sha256Ref({
    open_request_hash: openRequest.request_hash,
    discovery_evidence_hash: discovery.evidence_hash,
    discovery_result_hash: sha256Ref(discovery.result),
    protocol_version: discovery.result.protocol_version,
    stateless: discovery.result.stateless,
  });
}

async function openDirect(adapter) {
  const openRequest = enforcementRequest({
    schema: 'agoragentic.mcp.enforced-session-open-request.v1',
    phase: 'server/discover',
    params: { protocol_version: '2026-07-28', stateless_required: true },
  });
  const session = await adapter.openSession(openRequest);
  return {
    openRequest,
    session,
    binding: sessionBinding(openRequest, session.discovery),
  };
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

function completeAnnotations() {
  return {
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: false,
  };
}

function ownerPolicy() {
  return {
    minimum_level: 'HIGH',
    force_risk_fork: true,
    deny_irreversible: true,
    trusted_server_refs: [],
    trusted_attestor_refs: [],
    trusted_attestation_hashes: [],
    trust_registry_version: null,
    allowed_egress: [],
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
      payload: {
        tools: [{
          name: 'local_echo',
          description: 'Returns a bounded local demonstration result.',
          inputSchema: {
            type: 'object',
            additionalProperties: false,
            properties: { message: { type: 'string' } },
          },
          annotations: { readOnlyHint: true },
        }],
      },
      schema: {
        type: 'object',
        additionalProperties: false,
        required: ['tools'],
        properties: {
          tools: {
            type: 'array',
            maxItems: 1,
            items: {
              type: 'object',
              additionalProperties: false,
              required: ['name', 'description', 'inputSchema', 'annotations'],
              properties: {
                name: { type: 'string', maxLength: 100 },
                description: { type: 'string', maxLength: 200 },
                inputSchema: {
                  type: 'object',
                  additionalProperties: false,
                  required: ['type', 'additionalProperties', 'properties'],
                  properties: {
                    type: { type: 'string', maxLength: 20 },
                    additionalProperties: { type: 'boolean' },
                    properties: {
                      type: 'object',
                      additionalProperties: false,
                      required: ['message'],
                      properties: {
                        message: {
                          type: 'object',
                          additionalProperties: false,
                          required: ['type'],
                          properties: { type: { type: 'string', maxLength: 20 } },
                        },
                      },
                    },
                  },
                },
                annotations: {
                  type: 'object',
                  additionalProperties: false,
                  required: ['readOnlyHint'],
                  properties: { readOnlyHint: { type: 'boolean' } },
                },
              },
            },
          },
        },
      },
    };
  }
  if (phase === 'tools/call') {
    return {
      payload: {
        content: [{ type: 'text', text: 'local fixture prepared' }],
        isError: false,
      },
      schema: {
        type: 'object',
        additionalProperties: false,
        required: ['content', 'isError'],
        properties: {
          content: {
            type: 'array',
            maxItems: 1,
            items: {
              type: 'object',
              additionalProperties: false,
              required: ['type', 'text'],
              properties: {
                type: { type: 'string', maxLength: 20 },
                text: { type: 'string', maxLength: 200 },
              },
            },
          },
          isError: { type: 'boolean' },
        },
      },
    };
  }
  throw new Error(`unexpected test phase: ${phase}`);
}

function makeCapsule(planRequest, workspaceDigest, resultSchema) {
  return createSavepointCapsule({
    created_at: NOW,
    expires_at: LATER,
    parent: {
      agent_id: 'agent:mcp-adapter-test',
      session_id: 'session:mcp-adapter-test',
      state_hash: sha256Ref('parent-state'),
      lineage_ref: null,
      lineage_hash: null,
    },
    agent_configuration: {
      model_version_hash: sha256Ref('model'),
      system_instruction_hash: sha256Ref('system'),
      tool_manifest_hash: sha256Ref('tools'),
    },
    checkpoint: {
      goal_ref: 'goal:mcp-adapter-test',
      goal_hash: sha256Ref('goal'),
      task_graph_ref: 'task-graph:mcp-adapter-test',
      task_graph_hash: sha256Ref('task-graph'),
    },
    memory_roots: [],
    workspace: {
      snapshot_ref: 'workspace:mcp-adapter-test',
      digest: workspaceDigest,
    },
    governance: {
      policy_ref: 'policy:mcp-adapter-test',
      policy_version: 'v1',
      policy_hash: sha256Ref('policy'),
      mandate_ref: null,
      mandate_version: null,
      mandate_hash: null,
      budget_policy_ref: null,
      budget_version: null,
      budget_hash: null,
      epoch: 'epoch:mcp-adapter-test',
    },
    receipt_chain_head: sha256Ref('receipt-chain'),
    proposed_interaction: {
      mcp_server_ref: planRequest.mcp_server_ref,
      mcp_server_origin: new URL(planRequest.mcp_server_origin).toString(),
      mcp_method: planRequest.phase,
      raw_method: null,
      tool_name: planRequest.tool_name,
      effective_arguments_hash: sha256Ref(planRequest.params),
      target_ref: `mcp-request:${planRequest.mcp_request_hash.slice(7)}`,
    },
    execution_authorization: {},
    allowed_commit_types: ['TYPED_RESULT'],
    authorized_result_schema_hash: sha256Ref(resultSchema),
    runtime_snapshot: { mode: 'none' },
  });
}

async function fixture(options = {}) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'risk-fork-mcp-host-adapter-'));
  const source = path.join(root, 'source');
  await mkdir(source);
  const inspected = await inspectLocalWorkspace({ source_workspace: source });
  const provider = new LocalReferenceRiskForkAdapter({
    baseDirectory: path.join(root, 'provider'),
    clock: () => new Date(NOW),
  });
  const controller = new RiskForkController({
    provider,
    mode: 'demonstration',
    clock: () => new Date(NOW),
  });
  let firstPrepared = null;
  const boundaryController = options.replayPrepared
    ? {
        async prepare(input) {
          if (firstPrepared) return firstPrepared;
          firstPrepared = await controller.prepare(input);
          return firstPrepared;
        },
      }
    : controller;
  const descriptorInputs = new Map();
  const phases = [];
  let releaseBlockedPhase;
  const blockedPhase = options.blockPhase
    ? new Promise((resolve) => { releaseBlockedPhase = resolve; })
    : null;
  const descriptorSource = createTrustedRiskDescriptorSource((request) => {
    const input = descriptorInputs.get(request.descriptor_ref);
    if (!input) throw new Error('descriptor was not planned by this host');
    return createTrustedRiskDescriptor(request, input);
  });
  const hostBoundary = createRiskForkHostBoundary({
    controller: boundaryController,
    trusted_descriptor_source: descriptorSource,
    clock: () => new Date(NOW),
  });
  const planSource = createTrustedRiskForkMcpPhasePlanSource((planRequest) => {
    phases.push(planRequest.phase);
    const { payload, schema } = resultForPhase(planRequest.phase);
    const descriptorRef = `descriptor:${planRequest.plan_request_id.split(':').at(-1)}`;
    descriptorInputs.set(descriptorRef, {
      mcp_phase: planRequest.phase,
      raw_method: null,
      mcp_server_ref: planRequest.mcp_server_ref,
      mcp_server_origin: planRequest.mcp_server_origin,
      mcp_server_trust: 'reachable',
      mcp_server_attestation: null,
      tool_name: planRequest.tool_name,
      tool_annotations: planRequest.tool_annotations ?? completeAnnotations(),
      capabilities: planRequest.tool_capabilities ?? completeCapabilities(),
      prompt_injection_indicators: [],
      owner_policy: ownerPolicy(),
    });
    const capsule = makeCapsule(planRequest, inspected.workspace_digest, schema);
    const plan = createRiskForkMcpPhasePlan(planRequest, {
      descriptor_ref: descriptorRef,
      operation_input: {
        capsule,
        savepoint_input: { source_workspace: source },
        operation: {
          kind: 'bounded_file_batch',
          actions: [],
          commit_candidate: {
            type: 'TYPED_RESULT',
            payload,
            payload_schema: schema,
          },
        },
        effective_arguments: planRequest.params,
        expected_commit_type: 'TYPED_RESULT',
        commit_policy: { typed_result_schema_hash: capsule.authorized_result_schema_hash },
        expected_binding: {},
        network_policy: { mode: 'blocked' },
      },
    });
    return options.blockPhase === planRequest.phase
      ? blockedPhase.then(() => plan)
      : plan;
  });
  const adapter = createRiskForkMcpHostAdapter({
    host_boundary: hostBoundary,
    trusted_phase_plan_source: planSource,
    clock: () => new Date(NOW),
    ...(options.timeouts ? { timeouts: options.timeouts } : {}),
    ...(options.maxSessions ? { max_sessions: options.maxSessions } : {}),
  });
  return {
    adapter,
    hostBoundary,
    phases,
    provider,
    releaseBlockedPhase: releaseBlockedPhase ?? (() => {}),
    root,
  };
}

test('real local lifecycle gates synthetic discovery/list and rejects unknown-effect tool calls', async () => {
  const current = await fixture();
  try {
    assert.equal(isRiskForkMcpHostAdapter(current.adapter), true);
    assert.deepEqual(Object.keys(current.adapter).sort(), [
      'executeFallback',
      'openSession',
      'timeouts',
    ]);
    assert.equal(current.adapter.provider, undefined);
    assert.equal(current.adapter.host_boundary, undefined);
    assert.equal(current.adapter.transport, undefined);

    const enforcementBoundary = createMcpEnforcementBoundary(current.adapter);
    const session = await connectRemoteClient({
      remoteUrl: 'https://mcp.example.test/rpc',
      enforcementBoundary,
    });
    await assert.rejects(
      session.callTool({
        name: 'local_echo',
        arguments: { message: 'hello from the clean host' },
      }),
      (error) => error instanceof RiskForkMcpHostAdapterError
        && error.code === RISK_FORK_MCP_HOST_DIAGNOSTIC_CODES.ACTION_PROPOSAL_REQUIRED,
    );
    await session.close();

    assert.deepEqual(current.phases, ['server/discover', 'tools/list']);
    assert.equal(current.provider.forks.size, 2);
    assert.equal(current.provider.savepoints.size, 2);
    assert.equal([...current.provider.forks.values()].every((entry) => entry.destroyed), true);
    assert.equal([...current.provider.savepoints.values()].every((entry) => entry.destroyed), true);
  } finally {
    await current.provider.dispose();
    await rm(current.root, { recursive: true, force: true });
  }
});

test('adapter rejects fabricated plan capabilities and never exposes fallback transport', async () => {
  const current = await fixture();
  try {
    assert.throws(
      () => createRiskForkMcpHostAdapter({
        host_boundary: current.hostBoundary,
        trusted_phase_plan_source: {
          schema: 'agoragentic.risk-fork.trusted-mcp-phase-plan-source.v1',
          trust_mode: 'host_callback_identity',
        },
      }),
      (error) => error instanceof RiskForkMcpHostAdapterError
        && error.code === RISK_FORK_MCP_HOST_DIAGNOSTIC_CODES.PLAN_SOURCE_UNTRUSTED,
    );
    await assert.rejects(
      current.adapter.executeFallback(),
      (error) => error instanceof RiskForkMcpHostAdapterError
        && error.code === RISK_FORK_MCP_HOST_DIAGNOSTIC_CODES.FALLBACK_BLOCKED,
    );
    assert.equal(current.provider.forks.size, 0);
  } finally {
    await current.provider.dispose();
    await rm(current.root, { recursive: true, force: true });
  }
});

test('wrong session binding fails closed before another Risk Fork is allocated', async () => {
  const current = await fixture();
  try {
    const openRequest = enforcementRequest({
      schema: 'agoragentic.mcp.enforced-session-open-request.v1',
      phase: 'server/discover',
      params: { protocol_version: '2026-07-28', stateless_required: true },
    });
    const session = await current.adapter.openSession(openRequest);
    const phaseRequest = enforcementRequest({
      schema: 'agoragentic.mcp.enforced-phase-request.v1',
      phase: 'tools/list',
      sessionBindingHash: sha256Ref('wrong-session'),
    });
    await assert.rejects(
      session.request(phaseRequest),
      (error) => error instanceof RiskForkMcpHostAdapterError
        && error.code === RISK_FORK_MCP_HOST_DIAGNOSTIC_CODES.SESSION_BINDING_MISMATCH,
    );
    await assert.rejects(
      session.request({
        ...phaseRequest,
        session_binding_hash: sessionBinding(openRequest, session.discovery),
      }),
      (error) => error instanceof RiskForkMcpHostAdapterError
        && error.code === RISK_FORK_MCP_HOST_DIAGNOSTIC_CODES.SESSION_CLOSED,
    );
    assert.equal(current.provider.forks.size, 1);
    assert.equal([...current.provider.forks.values()].every((entry) => entry.destroyed), true);
  } finally {
    await current.provider.dispose();
    await rm(current.root, { recursive: true, force: true });
  }
});

test('a consumed phase request cannot be replayed', async () => {
  const current = await fixture();
  try {
    const openRequest = enforcementRequest({
      schema: 'agoragentic.mcp.enforced-session-open-request.v1',
      phase: 'server/discover',
      params: { protocol_version: '2026-07-28', stateless_required: true },
    });
    const session = await current.adapter.openSession(openRequest);
    const phaseRequest = enforcementRequest({
      schema: 'agoragentic.mcp.enforced-phase-request.v1',
      phase: 'tools/list',
      sessionBindingHash: sessionBinding(openRequest, session.discovery),
    });
    const first = await session.request(phaseRequest);
    assert.deepEqual(first.result.tools.map((tool) => tool.name), ['local_echo']);
    await assert.rejects(
      session.request(phaseRequest),
      (error) => error instanceof RiskForkMcpHostAdapterError
        && error.code === RISK_FORK_MCP_HOST_DIAGNOSTIC_CODES.REQUEST_REPLAY,
    );
    assert.equal(current.provider.forks.size, 2);
    assert.equal([...current.provider.forks.values()].every((entry) => entry.destroyed), true);
  } finally {
    await current.provider.dispose();
    await rm(current.root, { recursive: true, force: true });
  }
});

test('an exact read-only tool binding can traverse the real local controller path', async () => {
  const current = await fixture();
  try {
    const opened = await openDirect(current.adapter);
    const capabilities = completeCapabilities();
    const annotations = completeAnnotations();
    const descriptor = {
      name: 'local_echo',
      description: 'Exact clean-host fixture binding.',
      inputSchema: {
        type: 'object',
        additionalProperties: false,
        properties: { message: { type: 'string' } },
      },
      annotations,
      capabilities,
    };
    const result = await opened.session.request(enforcementRequest({
      schema: 'agoragentic.mcp.enforced-phase-request.v1',
      phase: 'tools/call',
      sessionBindingHash: opened.binding,
      params: { name: 'local_echo', arguments: { message: 'bounded' } },
      toolDescriptor: descriptor,
      toolCapabilities: capabilities,
      toolAnnotations: annotations,
      toolEffectStatus: 'explicit_read_only',
    }));
    assert.deepEqual(result.result, {
      content: [{ type: 'text', text: 'local fixture prepared' }],
      isError: false,
    });
    await opened.session.close();
    assert.deepEqual(current.phases, ['server/discover', 'tools/call']);
    assert.equal(current.provider.forks.size, 2);
    assert.equal([...current.provider.forks.values()].every((entry) => entry.destroyed), true);
  } finally {
    await current.provider.dispose();
    await rm(current.root, { recursive: true, force: true });
  }
});

test('tool effect metadata cannot understate risk and stricter host profiles fail closed', async () => {
  const capabilities = completeCapabilities();
  const annotations = completeAnnotations();
  const descriptor = {
    name: 'local_echo',
    annotations,
    capabilities,
  };

  const mismatched = await fixture();
  try {
    const opened = await openDirect(mismatched.adapter);
    await assert.rejects(
      opened.session.request(enforcementRequest({
        schema: 'agoragentic.mcp.enforced-phase-request.v1',
        phase: 'tools/call',
        sessionBindingHash: opened.binding,
        params: { name: 'local_echo', arguments: {} },
        toolDescriptor: descriptor,
        toolCapabilities: capabilities,
        toolAnnotations: annotations,
        toolEffectStatus: 'unknown_effectfulness',
        minimumLevel: 'HIGH',
      })),
      (error) => error instanceof RiskForkMcpHostAdapterError
        && error.code === RISK_FORK_MCP_HOST_DIAGNOSTIC_CODES.INVALID_REQUEST,
    );
    assert.equal(mismatched.provider.forks.size, 1);
  } finally {
    await mismatched.provider.dispose();
    await rm(mismatched.root, { recursive: true, force: true });
  }

  const escalated = await fixture();
  try {
    const opened = await openDirect(escalated.adapter);
    await assert.rejects(
      opened.session.request(enforcementRequest({
        schema: 'agoragentic.mcp.enforced-phase-request.v1',
        phase: 'tools/call',
        sessionBindingHash: opened.binding,
        params: { name: 'local_echo', arguments: {} },
        toolDescriptor: descriptor,
        toolCapabilities: capabilities,
        toolAnnotations: annotations,
        toolEffectStatus: 'explicit_read_only',
        minimumLevel: 'IRREVERSIBLE',
      })),
      (error) => error instanceof RiskForkMcpHostAdapterError
        && error.code === RISK_FORK_MCP_HOST_DIAGNOSTIC_CODES.ACTION_PROPOSAL_REQUIRED,
    );
    assert.equal(escalated.provider.forks.size, 1);
  } finally {
    await escalated.provider.dispose();
    await rm(escalated.root, { recursive: true, force: true });
  }
});

test('null-bearing capability metadata cannot claim that its effect is classified', async () => {
  const current = await fixture();
  try {
    const opened = await openDirect(current.adapter);
    const capabilities = {
      ...completeCapabilities(),
      network_access: null,
      unknown_or_unclassified: false,
    };
    const annotations = completeAnnotations();
    const descriptor = { name: 'local_echo', annotations };
    await assert.rejects(
      opened.session.request(enforcementRequest({
        schema: 'agoragentic.mcp.enforced-phase-request.v1',
        phase: 'tools/call',
        sessionBindingHash: opened.binding,
        params: { name: 'local_echo', arguments: {} },
        toolDescriptor: descriptor,
        toolCapabilities: capabilities,
        toolAnnotations: annotations,
        toolEffectStatus: 'explicit_read_only',
      })),
      (error) => error instanceof RiskForkMcpHostAdapterError
        && error.code === RISK_FORK_MCP_HOST_DIAGNOSTIC_CODES.INVALID_REQUEST,
    );
    assert.equal(current.provider.forks.size, 1);
  } finally {
    await current.provider.dispose();
    await rm(current.root, { recursive: true, force: true });
  }
});

test('a timed-out phase retains session capacity until trusted work becomes terminal', async () => {
  const current = await fixture({
    blockPhase: 'tools/list',
    maxSessions: 1,
    timeouts: { request_ms: 20 },
  });
  try {
    const opened = await openDirect(current.adapter);
    const blockedRequest = enforcementRequest({
      schema: 'agoragentic.mcp.enforced-phase-request.v1',
      phase: 'tools/list',
      sessionBindingHash: opened.binding,
    });
    await assert.rejects(
      opened.session.request(blockedRequest),
      (error) => error instanceof RiskForkMcpHostAdapterError
        && error.code === RISK_FORK_MCP_HOST_DIAGNOSTIC_CODES.DEADLINE_EXCEEDED,
    );
    await assert.rejects(
      openDirect(current.adapter),
      (error) => error instanceof RiskForkMcpHostAdapterError
        && error.code === RISK_FORK_MCP_HOST_DIAGNOSTIC_CODES.SESSION_LIMIT,
    );
    current.releaseBlockedPhase();
    await opened.session.close();
    assert.equal([...current.provider.forks.values()].every((entry) => entry.destroyed), true);
  } finally {
    current.releaseBlockedPhase();
    await current.provider.dispose();
    await rm(current.root, { recursive: true, force: true });
  }
});

test('a timed-out open retains pending capacity until its underlying plan becomes terminal', async () => {
  const current = await fixture({
    blockPhase: 'server/discover',
    maxSessions: 1,
    timeouts: { open_session_ms: 500 },
  });
  try {
    const timedOpenRequest = enforcementRequest({
      schema: 'agoragentic.mcp.enforced-session-open-request.v1',
      phase: 'server/discover',
      params: { protocol_version: '2026-07-28', stateless_required: true },
    });
    await assert.rejects(
      current.adapter.openSession(timedOpenRequest, { timeout_ms: 20 }),
      (error) => error instanceof RiskForkMcpHostAdapterError
        && error.code === RISK_FORK_MCP_HOST_DIAGNOSTIC_CODES.DEADLINE_EXCEEDED,
    );
    await assert.rejects(
      openDirect(current.adapter),
      (error) => error instanceof RiskForkMcpHostAdapterError
        && error.code === RISK_FORK_MCP_HOST_DIAGNOSTIC_CODES.SESSION_LIMIT,
    );
    current.releaseBlockedPhase();
    let replacement = null;
    for (let attempt = 0; attempt < 50 && replacement === null; attempt += 1) {
      try {
        replacement = await openDirect(current.adapter);
      } catch (error) {
        if (!(error instanceof RiskForkMcpHostAdapterError)
          || error.code !== RISK_FORK_MCP_HOST_DIAGNOSTIC_CODES.SESSION_LIMIT) throw error;
        await delay(5);
      }
    }
    assert.ok(replacement, 'replacement session should open after terminal reconciliation');
    await replacement.session.close();
    assert.equal([...current.provider.forks.values()].every((entry) => entry.destroyed), true);
  } finally {
    current.releaseBlockedPhase();
    await current.provider.dispose();
    await rm(current.root, { recursive: true, force: true });
  }
});

test('a genuine prepared result cannot be replayed and relabeled for another MCP request', async () => {
  const current = await fixture({ replayPrepared: true });
  try {
    const opened = await openDirect(current.adapter);
    const listRequest = enforcementRequest({
      schema: 'agoragentic.mcp.enforced-phase-request.v1',
      phase: 'tools/list',
      sessionBindingHash: opened.binding,
    });
    await assert.rejects(
      opened.session.request(listRequest),
      (error) => error instanceof RiskForkMcpHostAdapterError
        && error.code === RISK_FORK_MCP_HOST_DIAGNOSTIC_CODES.PREPARED_RESULT_INVALID,
    );
    assert.equal(current.provider.forks.size, 1);
    assert.equal([...current.provider.forks.values()].every((entry) => entry.destroyed), true);
  } finally {
    await current.provider.dispose();
    await rm(current.root, { recursive: true, force: true });
  }
});

test('pending open capacity is atomically promoted to an active session', async () => {
  const current = await fixture({ blockPhase: 'server/discover', maxSessions: 1 });
  try {
    const firstOpen = openDirect(current.adapter);
    for (let attempt = 0; attempt < 50 && current.phases.length === 0; attempt += 1) {
      await delay(2);
    }
    await assert.rejects(
      openDirect(current.adapter),
      (error) => error instanceof RiskForkMcpHostAdapterError
        && error.code === RISK_FORK_MCP_HOST_DIAGNOSTIC_CODES.SESSION_LIMIT,
    );
    current.releaseBlockedPhase();
    const opened = await firstOpen;
    await assert.rejects(
      openDirect(current.adapter),
      (error) => error instanceof RiskForkMcpHostAdapterError
        && error.code === RISK_FORK_MCP_HOST_DIAGNOSTIC_CODES.SESSION_LIMIT,
    );
    await opened.session.close();
  } finally {
    current.releaseBlockedPhase();
    await current.provider.dispose();
    await rm(current.root, { recursive: true, force: true });
  }
});
