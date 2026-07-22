const ADAPTERS = Object.freeze([
  adapter('langgraph', 'LangGraph', 'Wrap graph runs with local policy, first-proof, and Agent OS preview export.', ['graph_definition', 'entrypoint', 'tool_policy']),
  adapter('crewai', 'CrewAI', 'Map crews/tasks/tools into Harness policy sections before hosted preview.', ['crew_config', 'task_list', 'tool_policy']),
  adapter('n8n', 'n8n', 'Convert workflow metadata into a no-spend preview packet and listing-readiness proposal.', ['workflow_json', 'credentials_boundary', 'trigger_policy']),
  adapter('claude_code', 'Claude Code', 'Enforce live PreToolUse decisions (allow/ask/deny) for Claude Code tool calls and record ledger evidence; never executes tools, spends, or grants authority.', ['repo_path', 'blocked_paths', 'approval_policy'], { status: 'enforcement', authority: 'local_no_spend_enforcement_decision_only', entrypoint: 'agoragentic-harness hook pretooluse' }),
  adapter('codex', 'Codex', 'Capture coding-agent tasks, test command expectations, and no-secret boundaries.', ['repo_path', 'test_command', 'blocked_paths']),
  adapter('mcp', 'MCP', 'Describe MCP resources/tools as allowed data/tool sources without granting live authority.', ['server_manifest', 'resource_policy', 'tool_policy']),
  adapter('hermes', 'Hermes', 'Import Hermes reflection packets and review receipts as refs-only local evidence for Agent OS preview.', ['reflection_packet', 'review_receipt', 'memory_policy']),
  adapter('rust_reference_runtime', 'Rust reference runtime', 'Treat the Rust runtime as a self-hosted reference implementation wrapped by Harness proof/export checks, not as the product runtime.', ['agent_card', 'openapi_profile', 'harness_export']),
  adapter('openfang', 'OpenFang', 'Map local Hands, memory, channel adapters, and audit trails into Agent OS Harness preview.', ['hand_manifest', 'memory_policy', 'channel_policy']),
]);

export function adapterCatalog() {
  return ADAPTERS.map((entry) => ({ ...entry, required_inputs: [...entry.required_inputs] }));
}

function adapter(id, name, summary, requiredInputs, overrides = {}) {
  return Object.freeze({
    id,
    name,
    status: 'stub',
    authority: 'local_no_spend_mapping_only',
    summary,
    required_inputs: Object.freeze(requiredInputs),
    ...overrides,
  });
}
