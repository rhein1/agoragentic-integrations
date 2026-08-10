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
  const patchInspection = inspectApplyPatchTargets(toolName, args);
  const normalizedArgs = normalizeOpenCodeArgs(args);
  if (patchInspection.targets.length > 0) {
    // The Harness evaluator currently accepts one target field. Preserve every
    // parsed patch target in that field so blocked-path checks cannot be
    // bypassed by placing the protected file later in a multi-file patch.
    normalizedArgs.file_path = patchInspection.targets.join('\n');
  }
  const mapped = mapClaudeCodeToolCall({
    tool_name: canonicalName,
    tool_input: normalizedArgs,
  });

  return {
    ...mapped,
    schema: OPENCODE_ACTION_SCHEMA,
    host: 'opencode',
    tool_name: toolName,
    target: patchInspection.targets.length > 0 ? patchInspection.targets.join('\n') : mapped.target,
    targets: patchInspection.targets.length > 0
      ? patchInspection.targets
      : mapped.target ? [mapped.target] : [],
    target_parse_error: patchInspection.error,
    scannable_text: [
      toolName,
      tokenizeToolName(toolName),
      mapped.scannable_text,
      patchInspection.scannable_text,
    ].filter(Boolean).join('\n'),
  };
}

export function evaluateOpenCodeAction(policy = {}, action = {}, { platform = process.platform } = {}) {
  const evaluation = evaluateClaudeCodeAction(policy, action);
  const reasons = [...evaluation.reasons];
  const blockedPatchTarget = matchingBlockedPatchTarget(policy, action, platform);
  if (action.target_parse_error) {
    reasons.push({
      code: action.target_parse_error,
      level: 'deny',
      detail: 'apply_patch target extraction failed closed',
    });
  }
  if (blockedPatchTarget && !reasons.some((reason) => reason.code === 'blocked_path')) {
    reasons.push({
      code: 'blocked_path',
      level: 'deny',
      detail: blockedPatchTarget.target,
    });
  }
  const forcedDeny = Boolean(action.target_parse_error || blockedPatchTarget);
  return {
    ...evaluation,
    schema: OPENCODE_DECISION_SCHEMA,
    host: 'opencode',
    tool_name: action.tool_name,
    decision: forcedDeny ? 'deny' : evaluation.decision,
    risk: forcedDeny ? 'high' : evaluation.risk,
    reasons,
  };
}

export function decideOpenCodeToolCall(policy, input, output, options) {
  return evaluateOpenCodeAction(policy, mapOpenCodeToolCall(input, output), options);
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

function tokenizeToolName(toolName) {
  return String(toolName || '').replace(/[_:./\\-]+/g, ' ');
}

function inspectApplyPatchTargets(toolName, args) {
  if (String(toolName || '').toLowerCase() !== 'apply_patch') {
    return { targets: [], error: null, scannable_text: null };
  }

  const patch = firstPatchText(args);
  if (!patch) {
    return {
      targets: [],
      error: 'apply_patch_targets_unparseable',
      scannable_text: null,
    };
  }

  const rawTargets = [];
  const directive = /^\*\*\*\s+(?:Add|Update|Delete) File:\s*(.+?)\s*$/gmi;
  const relocation = /^\*\*\*\s+(?:Move|Copy) to:\s*(.+?)\s*$/gmi;
  for (const match of patch.matchAll(directive)) rawTargets.push(match[1]);
  for (const match of patch.matchAll(relocation)) rawTargets.push(match[1]);

  if (rawTargets.length === 0) {
    return {
      targets: [],
      error: 'apply_patch_targets_unparseable',
      scannable_text: patch.slice(0, 2000),
    };
  }

  const targets = [];
  for (const rawTarget of rawTargets) {
    const target = normalizePatchTarget(rawTarget);
    if (!target) {
      return {
        targets: [],
        error: 'apply_patch_targets_invalid',
        scannable_text: patch.slice(0, 2000),
      };
    }
    if (!targets.includes(target)) targets.push(target);
  }

  return {
    targets,
    error: null,
    scannable_text: patch.slice(0, 2000),
  };
}

function firstPatchText(args) {
  for (const key of ['patch', 'diff', 'input']) {
    if (typeof args?.[key] === 'string' && args[key].trim()) return args[key];
  }
  return null;
}

function normalizePatchTarget(value) {
  const target = String(value || '').trim();
  if (!target || target.length > 4096 || /[\0\r\n]/.test(target)) return null;
  if (/^(?:[A-Za-z]:[\\/]|[\\/])/.test(target)) return null;
  const normalized = target.replace(/\\/g, '/').replace(/^\.\//, '');
  if (!normalized || normalized.split('/').some((part) => !part || part === '.' || part === '..')) return null;
  return normalized;
}

function matchingBlockedPatchTarget(policy, action, platform) {
  if (String(action?.tool_name || '').toLowerCase() !== 'apply_patch') return null;
  const blockedPaths = policy?.tool_policy?.blocked_paths || policy?.guard_policy?.blocked_paths || [];
  if (!Array.isArray(blockedPaths) || !Array.isArray(action?.targets)) return null;
  const windowsPaths = platform === 'win32';
  for (const target of action.targets) {
    const normalizedTarget = canonicalPatchPolicyPath(target, { windowsPaths });
    if (!normalizedTarget) continue;
    for (const blockedPath of blockedPaths) {
      const normalizedBlockedPath = canonicalPatchPolicyPath(blockedPath, { windowsPaths });
      if (normalizedBlockedPath && normalizedTarget.includes(normalizedBlockedPath)) {
        return { target, blocked_path: blockedPath };
      }
    }
  }
  return null;
}

function canonicalPatchPolicyPath(value, { windowsPaths } = {}) {
  const raw = String(value || '').trim();
  if (!raw || /[\0\r\n]/.test(raw)) return null;
  const separatorNormalized = windowsPaths ? raw.replace(/\\/g, '/') : raw;
  const normalized = separatorNormalized
    .replace(/^(?:\.\/)+/, '')
    .replace(/\/{2,}/g, '/');
  return windowsPaths ? normalized.toLocaleLowerCase('en-US') : normalized;
}
