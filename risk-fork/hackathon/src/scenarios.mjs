import {
  createSavepointCapsule,
  createTrustedMcpServerVerifier,
  sha256Ref,
} from '../../src/index.mjs';
import {
  MALICIOUS_MCP_CALL_ARGUMENTS,
  MALICIOUS_MCP_TOOL_NAME,
} from '../fixtures/malicious-stdio-mcp.mjs';

export const DEMO_NOW = '2030-01-01T00:10:00.000Z';
export const DEMO_EXPIRES_AT = '2030-01-01T00:20:00.000Z';
export const DEMO_ORIGIN = 'https://synthetic-risk-fork.invalid/';
export const DEMO_SERVER_REF = 'server:risk-fork-synthetic-demo';

export const TYPED_RESULT_SCHEMA = Object.freeze({
  $schema: 'http://json-schema.org/draft-07/schema#',
  type: 'object',
  additionalProperties: false,
  required: ['summary', 'fixture_id'],
  properties: {
    summary: { type: 'string', maxLength: 200 },
    fixture_id: { type: 'string', pattern: '^[a-z0-9-]+$' },
  },
});

const NO_CAPABILITIES = Object.freeze({
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
});

const BASE_ANNOTATIONS = Object.freeze({
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: false,
});

const BASE_OWNER_POLICY = Object.freeze({
  minimum_level: 'LOW',
  force_risk_fork: false,
  deny_irreversible: false,
  trusted_server_refs: [DEMO_SERVER_REF],
  trusted_attestor_refs: ['attestor:risk-fork-demo'],
  trusted_attestation_hashes: [],
  trust_registry_version: 'risk-fork-demo-trust-v1',
  allowed_egress: [],
});

function serverAttestation() {
  const statement = {
    schema: 'agoragentic.risk-fork.mcp-server-attestation.v1',
    status: 'verified',
    server_ref: DEMO_SERVER_REF,
    server_origin: DEMO_ORIGIN,
    attestor_ref: 'attestor:risk-fork-demo',
    evidence_hash: sha256Ref('synthetic-risk-fork-demo-trust-evidence'),
    issued_at: '2030-01-01T00:00:00.000Z',
    expires_at: '2030-01-01T01:00:00.000Z',
    trust_registry_version: 'risk-fork-demo-trust-v1',
    signature_ref: 'signature:risk-fork-demo',
    signature_hash: sha256Ref('synthetic-risk-fork-demo-signature'),
  };
  return Object.freeze({ ...statement, attestation_hash: sha256Ref(statement) });
}

export const demoTrustedServerVerifier = createTrustedMcpServerVerifier((request) => ({
  schema: 'agoragentic.risk-fork.trusted-mcp-server-verification.v1',
  status: 'verified',
  request_hash: sha256Ref(request),
  evidence_ref: 'trusted-boundary:risk-fork-demo',
  evidence_hash: sha256Ref({ request, verifier: 'synthetic-risk-fork-demo' }),
}));

function ownerPolicy(overrides = {}, trust = 'verified') {
  const attestation = serverAttestation();
  return {
    ...BASE_OWNER_POLICY,
    trusted_server_refs: trust === 'verified' ? [DEMO_SERVER_REF] : [],
    trusted_attestor_refs: trust === 'verified' ? ['attestor:risk-fork-demo'] : [],
    trusted_attestation_hashes: trust === 'verified' ? [attestation.attestation_hash] : [],
    trust_registry_version: trust === 'verified' ? 'risk-fork-demo-trust-v1' : null,
    ...overrides,
  };
}

function riskInput({
  id,
  phase = 'tools/call',
  trust = 'verified',
  capabilities = NO_CAPABILITIES,
  annotations = BASE_ANNOTATIONS,
  injection = [],
  policy = {},
  toolName = null,
}) {
  return {
    request_id: `request:${id}`,
    mcp_phase: phase,
    mcp_server_ref: DEMO_SERVER_REF,
    mcp_server_origin: DEMO_ORIGIN,
    mcp_server_trust: trust,
    ...(trust === 'verified' ? { mcp_server_attestation: serverAttestation() } : {}),
    ...(phase === 'tools/call'
      ? { tool_name: toolName ?? `synthetic_${id.replaceAll('-', '_')}` }
      : {}),
    tool_annotations: { ...annotations },
    capabilities: { ...capabilities },
    prompt_injection_indicators: [...injection],
    owner_policy: ownerPolicy(policy, trust),
  };
}

function typedOperation(id, actions = [], payload = null) {
  return {
    kind: 'bounded_file_batch',
    actions,
    commit_candidate: {
      type: 'TYPED_RESULT',
      payload: payload ?? {
        summary: `Synthetic fixture ${id} completed inside the local protocol simulator.`,
        fixture_id: id,
      },
      payload_schema: TYPED_RESULT_SCHEMA,
    },
  };
}

function irreversibleOperation(id) {
  const argumentsValue = { fixture_id: id, release_ref: 'release:synthetic-preview' };
  return {
    arguments: argumentsValue,
    operation: {
      kind: 'bounded_file_batch',
      actions: [],
      commit_candidate: {
        type: 'CONSEQUENTIAL_ACTION_PROPOSAL',
        action: {
          operation: 'deployment',
          target_ref: 'target:synthetic-preview',
          provider_ref: 'local-reference-v1',
          arguments: argumentsValue,
          amount: null,
          currency: null,
          payment_rail: null,
        },
      },
    },
  };
}

const SCENARIOS = Object.freeze([
  {
    id: 'low-read-only',
    title: 'Fully enumerated LOW read-only action',
    kind: 'standard',
    expected_level: 'LOW',
    risk_input: riskInput({ id: 'low-read-only' }),
    operation: typedOperation('low-read-only'),
    expected_commit_type: 'TYPED_RESULT',
  },
  {
    id: 'elevated-owner-policy',
    title: 'Owner policy raises a read-only action to ELEVATED',
    kind: 'standard',
    expected_level: 'ELEVATED',
    risk_input: riskInput({
      id: 'elevated-owner-policy',
      policy: { minimum_level: 'ELEVATED' },
    }),
    operation: typedOperation('elevated-owner-policy'),
    expected_commit_type: 'TYPED_RESULT',
  },
  {
    id: 'high-filesystem-write',
    title: 'HIGH filesystem write routed through a disposable local copy',
    kind: 'standard',
    expected_level: 'HIGH',
    risk_input: riskInput({
      id: 'high-filesystem-write',
      annotations: { ...BASE_ANNOTATIONS, readOnlyHint: false },
      capabilities: { ...NO_CAPABILITIES, filesystem_write: true },
    }),
    operation: typedOperation('high-filesystem-write', [
      { type: 'write', path: 'synthetic-output.txt', content: 'bounded synthetic output\n' },
    ]),
    expected_commit_type: 'TYPED_RESULT',
  },
  {
    id: 'high-incomplete-metadata',
    title: 'Incomplete capability metadata promoted to HIGH',
    kind: 'standard',
    expected_level: 'HIGH',
    risk_input: riskInput({
      id: 'high-incomplete-metadata',
      capabilities: Object.fromEntries(
        Object.entries(NO_CAPABILITIES).filter(([key]) => key !== 'publication'),
      ),
    }),
    operation: typedOperation('high-incomplete-metadata'),
    expected_commit_type: 'TYPED_RESULT',
  },
  {
    id: 'high-untrusted-discovery',
    title: 'Untrusted MCP discovery promoted to HIGH before connection',
    kind: 'standard',
    expected_level: 'HIGH',
    risk_input: riskInput({
      id: 'high-untrusted-discovery',
      phase: 'initialize',
      trust: 'untrusted',
    }),
    operation: typedOperation('high-untrusted-discovery'),
    expected_commit_type: 'TYPED_RESULT',
  },
  {
    id: 'high-prompt-injection',
    title: 'Prompt-injection indicator promoted to HIGH',
    kind: 'standard',
    expected_level: 'HIGH',
    risk_input: riskInput({
      id: 'high-prompt-injection',
      injection: ['synthetic_untrusted_instruction_boundary_crossing'],
    }),
    operation: typedOperation('high-prompt-injection'),
    expected_commit_type: 'TYPED_RESULT',
  },
  {
    id: 'e2b-malicious-mcp-containment',
    title: 'Malicious stdio MCP exercised against the fake E2B contract',
    kind: 'e2b_mock',
    provider_profile: 'fake-e2b',
    expected_level: 'HIGH',
    risk_input: riskInput({
      id: 'e2b-malicious-mcp-containment',
      phase: 'tools/call',
      trust: 'untrusted',
      toolName: MALICIOUS_MCP_TOOL_NAME,
      annotations: { ...BASE_ANNOTATIONS, openWorldHint: true },
      capabilities: {
        ...NO_CAPABILITIES,
        network_access: true,
        filesystem_read: true,
        filesystem_write: true,
        credential_access: true,
        unknown_or_unclassified: true,
      },
      injection: ['synthetic_hostile_tools_list_instruction'],
    }),
    arguments: MALICIOUS_MCP_CALL_ARGUMENTS,
    operation: typedOperation('e2b-malicious-mcp-containment', [], {
      summary: 'One bounded synthetic result passed exact validation.',
      fixture_id: 'e2b-malicious-mcp-containment',
    }),
    expected_commit_type: 'TYPED_RESULT',
  },
  {
    id: 'irreversible-deployment-proposal',
    title: 'IRREVERSIBLE deployment remains a prepare-only proposal',
    kind: 'irreversible',
    expected_level: 'IRREVERSIBLE',
    risk_input: riskInput({
      id: 'irreversible-deployment-proposal',
      annotations: { ...BASE_ANNOTATIONS, readOnlyHint: false, destructiveHint: true },
      capabilities: { ...NO_CAPABILITIES, deployment: true, external_side_effect: true },
    }),
    ...irreversibleOperation('irreversible-deployment-proposal'),
    expected_commit_type: 'CONSEQUENTIAL_ACTION_PROPOSAL',
  },
  {
    id: 'deny-owner-policy',
    title: 'Owner policy DENY performs zero execution',
    kind: 'standard',
    expected_level: 'IRREVERSIBLE',
    expected_action: 'DENY',
    risk_input: riskInput({
      id: 'deny-owner-policy',
      capabilities: { ...NO_CAPABILITIES, communication: true, external_side_effect: true },
      policy: { deny_irreversible: true },
    }),
    operation: typedOperation('deny-owner-policy'),
    expected_commit_type: 'TYPED_RESULT',
  },
  {
    id: 'cleanup-unknown',
    title: 'Unknown cleanup evidence blocks readiness',
    kind: 'cleanup_unknown',
    expected_level: 'HIGH',
    expected_failure: true,
    risk_input: riskInput({
      id: 'cleanup-unknown',
      capabilities: { ...NO_CAPABILITIES, filesystem_write: true },
    }),
    operation: typedOperation('cleanup-unknown'),
    expected_commit_type: 'TYPED_RESULT',
  },
  {
    id: 'stale-governance-binding',
    title: 'Stale governance binding is rejected',
    kind: 'stale_binding',
    expected_level: 'IRREVERSIBLE',
    expected_failure: true,
    risk_input: riskInput({
      id: 'stale-governance-binding',
      capabilities: { ...NO_CAPABILITIES, deployment: true, external_side_effect: true },
    }),
    ...irreversibleOperation('stale-governance-binding'),
    expected_commit_type: 'CONSEQUENTIAL_ACTION_PROPOSAL',
  },
  {
    id: 'malformed-lifecycle-receipt',
    title: 'Malformed lifecycle and receipt hashes are rejected',
    kind: 'tamper',
    expected_level: 'HIGH',
    risk_input: riskInput({
      id: 'malformed-lifecycle-receipt',
      capabilities: { ...NO_CAPABILITIES, filesystem_write: true },
    }),
    operation: typedOperation('malformed-lifecycle-receipt'),
    expected_commit_type: 'TYPED_RESULT',
  },
  ...[
    ['attack-traversal', 'Traversal path is rejected', 'traversal'],
    ['attack-link', 'Link entry is rejected', 'link'],
    ['attack-secret', 'Secret-shaped input is rejected without echo', 'secret'],
    ['attack-oversized-write', 'Oversized synthetic write is rejected', 'oversized'],
    ['attack-timeout', 'Bounded execution timeout is reported', 'timeout'],
    ['attack-concurrency', 'Second active run is rejected', 'concurrency'],
  ].map(([id, title, attack]) => ({
    id,
    title,
    kind: 'attack',
    attack,
    expected_level: 'HIGH',
    expected_failure: true,
    risk_input: riskInput({
      id,
      capabilities: { ...NO_CAPABILITIES, filesystem_write: true },
    }),
    operation: typedOperation(id),
    expected_commit_type: 'TYPED_RESULT',
  })),
]);

const SCENARIO_MAP = new Map(SCENARIOS.map((scenario) => [scenario.id, scenario]));

export const SCENARIO_IDS = Object.freeze([...SCENARIO_MAP.keys()]);

export function listScenarios() {
  return SCENARIOS.map(({
    id,
    title,
    expected_level,
    expected_action,
    expected_failure,
    provider_profile,
  }) => ({
    id,
    title,
    expected_level,
    expected_action: expected_action ?? null,
    expected_failure: expected_failure === true,
    provider_profile: provider_profile ?? 'local-reference',
  }));
}

export function getScenario(id) {
  if (typeof id !== 'string' || !SCENARIO_MAP.has(id)) {
    throw new TypeError(`Unknown synthetic scenario. Allowed: ${SCENARIO_IDS.join(', ')}`);
  }
  return structuredClone(SCENARIO_MAP.get(id));
}

export function createScenarioCapsule(scenario, workspaceDigest, options = {}) {
  const effectiveArguments = scenario.arguments ?? { fixture_id: scenario.id };
  const expectedCommitType = scenario.expected_commit_type;
  const executionAuthorization = expectedCommitType === 'CONSEQUENTIAL_ACTION_PROPOSAL'
    ? {
        ref: `authorization:synthetic-${scenario.id}`,
        hash: sha256Ref({ scenario_id: scenario.id, authority_granted: false }),
      }
    : {};
  return createSavepointCapsule({
    created_at: DEMO_NOW,
    expires_at: DEMO_EXPIRES_AT,
    parent: {
      agent_id: 'agent:risk-fork-demo-parent',
      session_id: 'session:risk-fork-demo-parent',
      state_hash: options.parent_state_hash
        ?? sha256Ref({ scenario_id: scenario.id, state: 'clean-parent' }),
      lineage_ref: 'lineage:risk-fork-demo',
      lineage_hash: sha256Ref('risk-fork-demo-lineage'),
    },
    agent_configuration: {
      model_version_hash: sha256Ref('no-model-local-deterministic-demo'),
      system_instruction_hash: sha256Ref('risk-fork-demo-system-boundary'),
      tool_manifest_hash: sha256Ref(SCENARIO_IDS),
    },
    checkpoint: {
      goal_ref: `goal:${scenario.id}`,
      goal_hash: sha256Ref({ scenario_id: scenario.id, goal: 'synthetic-demonstration' }),
      task_graph_ref: `task-graph:${scenario.id}`,
      task_graph_hash: sha256Ref({ scenario_id: scenario.id, tasks: ['classify', 'prepare', 'destroy'] }),
    },
    memory_roots: [],
    workspace: {
      snapshot_ref: `workspace:synthetic-${scenario.id}`,
      digest: workspaceDigest,
    },
    governance: {
      policy_ref: 'policy:risk-fork-demo-v1',
      policy_version: '1',
      policy_hash: sha256Ref('risk-fork-demo-policy-v1'),
      mandate_ref: 'mandate:risk-fork-demo-synthetic-only',
      mandate_version: '1',
      mandate_hash: sha256Ref('risk-fork-demo-synthetic-only'),
      budget_policy_ref: 'budget:risk-fork-demo-zero-spend',
      budget_version: '1',
      budget_hash: sha256Ref('risk-fork-demo-zero-spend'),
      epoch: 'governance:risk-fork-demo-v1',
    },
    receipt_chain_head: sha256Ref('risk-fork-demo-receipt-genesis'),
    proposed_interaction: {
      mcp_server_ref: scenario.risk_input.mcp_server_ref,
      mcp_server_origin: scenario.risk_input.mcp_server_origin,
      mcp_method: scenario.risk_input.mcp_phase,
      raw_method: scenario.risk_input.raw_method ?? null,
      tool_name: scenario.risk_input.tool_name ?? null,
      effective_arguments_hash: sha256Ref(effectiveArguments),
      target_ref: expectedCommitType === 'CONSEQUENTIAL_ACTION_PROPOSAL'
        ? 'target:synthetic-preview'
        : null,
    },
    execution_authorization: executionAuthorization,
    allowed_commit_types: [expectedCommitType],
    authorized_result_schema_hash: sha256Ref(TYPED_RESULT_SCHEMA),
    runtime_snapshot: { mode: 'none', verification_status: 'not_checked' },
  });
}

export function scenarioEffectiveArguments(scenario) {
  return structuredClone(scenario.arguments ?? { fixture_id: scenario.id });
}
