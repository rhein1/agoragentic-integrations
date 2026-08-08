import {
  evaluateClaudeCodeAction,
  mapClaudeCodeToolCall,
} from 'agoragentic-harness-core/adapters/claude-code';

export const OPENCODE_ACTION_SCHEMA = 'agoragentic.harness.opencode-action.v1';
export const OPENCODE_DECISION_SCHEMA = 'agoragentic.harness.opencode-decision.v1';

const READ_TOOLS = new Set([
  'glob',
  'grep',
  'list',
  'ls',
  'question',
  'read',
  'skill',
  'todoread',
  'todowrite',
]);
const WRITE_TOOLS = new Set(['apply_patch', 'edit', 'multiedit', 'notebookedit', 'write']);
const SHELL_TOOLS = new Set(['bash', 'bashoutput', 'killshell', 'powershell', 'shell']);
const NETWORK_TOOLS = new Set(['fetch', 'http', 'webfetch', 'websearch']);
const AGENTIC_TOOLS = new Set(['agent', 'task']);

export function mapOpenCodeToolCall(input = {}, output = {}) {
  const toolName = String(input.tool || '');
  const args = output.args && typeof output.args === 'object' ? output.args : {};
  const canonicalName = canonicalHarnessToolName(toolName);
  const mapped = mapClaudeCodeToolCall({
    tool_name: canonicalName,
    tool_input: normalizeOpenCodeArgs(args),
  });

  return {
    ...mapped,
    schema: OPENCODE_ACTION_SCHEMA,
    host: 'opencode',
    tool_name: toolName,
    scannable_text: [toolName, mapped.scannable_text].filter(Boolean).join('\n'),
  };
}

export function evaluateOpenCodeAction(policy = {}, action = {}) {
  const evaluation = evaluateClaudeCodeAction(policy, action);
  return {
    ...evaluation,
    schema: OPENCODE_DECISION_SCHEMA,
    host: 'opencode',
    tool_name: action.tool_name,
  };
}

export function decideOpenCodeToolCall(policy, input, output) {
  return evaluateOpenCodeAction(policy, mapOpenCodeToolCall(input, output));
}

function canonicalHarnessToolName(toolName) {
  const normalized = String(toolName || '').toLowerCase();
  if (normalized.startsWith('mcp__') || normalized.startsWith('mcp_')) return 'mcp__opencode__tool';
  if (READ_TOOLS.has(normalized)) return 'Read';
  if (WRITE_TOOLS.has(normalized)) return 'Write';
  if (SHELL_TOOLS.has(normalized)) return 'Bash';
  if (NETWORK_TOOLS.has(normalized)) return 'WebFetch';
  if (AGENTIC_TOOLS.has(normalized)) return 'Task';
  return toolName;
}

function normalizeOpenCodeArgs(args) {
  return {
    ...args,
    file_path: args.file_path ?? args.filePath,
    old_string: args.old_string ?? args.oldString,
    new_string: args.new_string ?? args.newString,
  };
}
