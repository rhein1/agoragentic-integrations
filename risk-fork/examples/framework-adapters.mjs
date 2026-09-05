import { canonicalize } from '../src/canonical.mjs';
import {
  createRiskForkFrameworkToolAdapter,
  createRiskForkFrameworkToolPlan,
  createTrustedRiskForkFrameworkExecutor,
  createTrustedRiskForkFrameworkPlanSource,
} from '../src/framework-tool-adapter.mjs';
import { createOpenAIAgentsRiskForkTool } from '../src/frameworks/openai-agents.mjs';
import { createLangChainRiskForkTool } from '../src/frameworks/langchain.mjs';
import { createLangGraphRiskForkNode } from '../src/frameworks/langgraph.mjs';
import {
  createRiskForkHostBoundary,
  createTrustedRiskDescriptor,
  createTrustedRiskDescriptorSource,
} from '../src/host-boundary.mjs';
import { classifyRisk } from '../src/risk-classifier.mjs';

const NOW = '2026-09-05T15:00:00.000Z';
const counters = {
  model_calls: 0,
  network_calls: 0,
  provider_calls: 0,
  direct_effect_calls: 0,
  clean_commit_calls: 0,
};
const retained = [];

function copyJson(value) {
  return JSON.parse(canonicalize(value));
}

function descriptorFor(request) {
  const toolName = request.descriptor_ref.slice('descriptor:'.length);
  return createTrustedRiskDescriptor(request, {
    mcp_phase: 'tools/call',
    raw_method: null,
    mcp_server_ref: 'framework:offline-demo',
    mcp_server_origin: 'https://framework-demo.example.test',
    mcp_server_trust: 'reachable',
    mcp_server_attestation: null,
    tool_name: toolName,
    tool_annotations: {
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: false,
      openWorldHint: true,
    },
    capabilities: {
      network_access: true,
      filesystem_read: false,
      filesystem_write: false,
      credential_access: false,
      wallet_or_payment: false,
      deployment: false,
      publication: false,
      communication: true,
      database_mutation: false,
      trust_or_reputation_mutation: false,
      external_side_effect: true,
      unknown_or_unclassified: false,
    },
    prompt_injection_indicators: [],
    owner_policy: {
      minimum_level: 'LOW',
      force_risk_fork: false,
      deny_irreversible: false,
      trusted_server_refs: [],
      trusted_attestor_refs: [],
      trusted_attestation_hashes: [],
      trust_registry_version: null,
      allowed_egress: [],
    },
  });
}

const descriptorSource = createTrustedRiskDescriptorSource(descriptorFor);
const classificationOnlyController = {
  async prepare(input) {
    const decision = classifyRisk(input.risk_input, { clock: () => NOW });
    return {
      mode: decision.blocked ? 'denied' : 'prepared_for_clean_commit',
      risk_decision: decision,
      authority_granted: false,
    };
  },
};
const hostBoundary = createRiskForkHostBoundary({
  controller: classificationOnlyController,
  trusted_descriptor_source: descriptorSource,
  clock: () => NOW,
});
const planSource = createTrustedRiskForkFrameworkPlanSource((request) => (
  createRiskForkFrameworkToolPlan(request, {
    operation_input: {
      operation: {
        kind: 'framework_tool_call',
        framework: request.framework,
        tool_name: request.tool_name,
        arguments: copyJson(request.arguments),
      },
      effective_arguments: copyJson(request.arguments),
      expected_commit_type: 'CONSEQUENTIAL_ACTION_PROPOSAL',
    },
  })
));
const executor = createTrustedRiskForkFrameworkExecutor({
  async execute_direct() {
    counters.direct_effect_calls += 1;
    throw new Error('Offline demo does not execute effects');
  },
  execute_prepared_action() {
    counters.clean_commit_calls += 1;
    throw new Error('Offline demo does not perform clean commit');
  },
  async retain_prepared(receipt) {
    retained.push(receipt);
  },
});

function enforcement(framework, toolName) {
  return createRiskForkFrameworkToolAdapter({
    enabled: true,
    framework,
    tool_name: toolName,
    descriptor_ref: `descriptor:${toolName}`,
    host_boundary: hostBoundary,
    trusted_plan_source: planSource,
    trusted_executor: executor,
    clock: () => NOW,
  });
}

const openaiTool = createOpenAIAgentsRiskForkTool({
  enforcement: enforcement('openai-agents', 'openai_send_email'),
});
const langchainTool = createLangChainRiskForkTool({
  enforcement: enforcement('langchain', 'langchain_send_email'),
});
const langgraphNode = createLangGraphRiskForkNode({
  enforcement: enforcement('langgraph', 'langgraph_send_email'),
  input_key: 'effect_input',
  output_key: 'effect_receipt',
});

const openai = await openaiTool.execute({ to: 'demo@example.test', subject: 'offline demo' });
const langchain = await langchainTool.handler({ to: 'demo@example.test', subject: 'offline demo' });
const langgraph = await langgraphNode.node({
  effect_input: { to: 'demo@example.test', subject: 'offline demo' },
});
const receipts = [openai, langchain, langgraph.effect_receipt];

console.log(JSON.stringify({
  schema: 'agoragentic.risk-fork.framework-adapter-demo.v1',
  status: 'passed',
  source_only: true,
  default_on: false,
  classification_only: true,
  provider_qualified: false,
  live_traffic_protected: false,
  authority_granted: false,
  needs_external_sdk_install: true,
  receipts_retained: retained.length,
  frameworks: receipts.map((receipt) => ({
    framework: receipt.framework,
    status: receipt.status,
    risk_level: receipt.risk_decision.level,
    action: receipt.risk_decision.action,
    authority_granted: receipt.authority_granted,
  })),
  ...counters,
}, null, 2));
