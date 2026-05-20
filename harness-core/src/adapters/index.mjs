const ADAPTERS = Object.freeze([
  adapter('langgraph', 'LangGraph', 'Wrap graph runs with local policy, first-proof, and Agent OS preview export.', ['graph_definition', 'entrypoint', 'tool_policy']),
  adapter('crewai', 'CrewAI', 'Map crews/tasks/tools into Harness policy sections before hosted preview.', ['crew_config', 'task_list', 'tool_policy']),
  adapter('n8n', 'n8n', 'Convert workflow metadata into a no-spend preview packet and listing-readiness proposal.', ['workflow_json', 'credentials_boundary', 'trigger_policy']),
  adapter('claude_code', 'Claude Code', 'Capture repo maintenance goals and code-change approval gates for local proof.', ['repo_path', 'blocked_paths', 'approval_policy']),
  adapter('codex', 'Codex', 'Capture coding-agent tasks, test command expectations, and no-secret boundaries.', ['repo_path', 'test_command', 'blocked_paths']),
  adapter('mcp', 'MCP', 'Describe MCP resources/tools as allowed data/tool sources without granting live authority.', ['server_manifest', 'resource_policy', 'tool_policy']),
  adapter('openfang', 'OpenFang', 'Map local Hands, memory, channel adapters, and audit trails into Agent OS Harness preview.', ['hand_manifest', 'memory_policy', 'channel_policy']),
]);

export function adapterCatalog() {
  return ADAPTERS.map((entry) => ({ ...entry, required_inputs: [...entry.required_inputs] }));
}

function adapter(id, name, summary, requiredInputs) {
  return Object.freeze({
    id,
    name,
    status: 'stub',
    authority: 'local_no_spend_mapping_only',
    summary,
    required_inputs: Object.freeze(requiredInputs),
  });
}
