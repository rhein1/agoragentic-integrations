// Claude Code enforcement adapter.
//
// Maps a live Claude Code tool call (PreToolUse hook payload) to a normalized
// harness action and decides allow / ask / deny against the project policy.
// This is the live-path enforcement seam: it can BLOCK an unsafe tool call, but
// it never executes a tool, spends, settles, publishes, or grants new authority.
// "deny" is the only side effect it can cause; everything else is recorded as
// evidence for owner review.

import { promises as fs } from 'node:fs';
import path from 'node:path';
import { trapScan } from '../index.mjs';
import { authorityBoundary, sanitizeForPublicEvidence, stableId } from '../kernel/events.mjs';
import { scanSourceText } from '../vendor/guard-core.mjs';

export const CLAUDE_CODE_ADAPTER_SCHEMA = 'agoragentic.harness.claude-code-decision.v1';

const READ_ONLY_TOOLS = new Set(['Read', 'Glob', 'Grep', 'LS', 'NotebookRead', 'WebSearch', 'TodoRead', 'TodoWrite']);
const FS_WRITE_TOOLS = new Set(['Write', 'Edit', 'MultiEdit', 'NotebookEdit']);
const SHELL_TOOLS = new Set(['Bash', 'PowerShell', 'Shell', 'BashOutput', 'KillBash', 'KillShell']);
const NETWORK_TOOLS = new Set(['WebFetch']);
const AGENTIC_TOOLS = new Set(['Agent', 'Task']);

// Irreversible / publish / deploy shell commands — deny by default in local no-spend.
const HIGH_RISK_COMMAND = /\b(rm\s+-rf\s+\/(?!tmp)|git\s+push|npm\s+publish|yarn\s+publish|pnpm\s+publish|docker\s+push|terraform\s+apply|kubectl\s+apply|shutdown|reboot|mkfs|dd\s+if=)/i;
// curl/wget piped straight into a shell.
const PIPE_TO_SHELL = /\b(curl|wget|iwr|invoke-webrequest)\b[^\n|]*\|\s*(sh|bash|zsh|pwsh|powershell|iex)\b/i;
// Money / settlement / publication verbs in any capability.
const SPEND_OR_PUBLISH = /\b(wallet|x402|usdc|transfer|withdraw|payout|settle|settlement|mint|airdrop|publish[_ -]?listing|deploy[_ -]?production)\b/i;

const RANK = Object.freeze({ allow: 0, ask: 1, deny: 2 });

export function mapClaudeCodeToolCall({ tool_name, tool_input } = {}) {
  const name = String(tool_name || '');
  const input = tool_input && typeof tool_input === 'object' ? tool_input : {};

  let capability = 'unknown';
  if (name.startsWith('mcp__')) capability = 'mcp';
  else if (READ_ONLY_TOOLS.has(name)) capability = 'read';
  else if (FS_WRITE_TOOLS.has(name)) capability = 'filesystem_write';
  else if (SHELL_TOOLS.has(name)) capability = 'shell';
  else if (NETWORK_TOOLS.has(name)) capability = 'network';
  else if (AGENTIC_TOOLS.has(name)) capability = 'agentic';

  // Include a tokenized copy of the tool name so word-boundary scans match
  // keywords inside underscore/colon-delimited MCP names (mcp__wallet__transfer).
  const parts = [name, name.replace(/[_:]+/g, ' ')];
  for (const key of ['command', 'file_path', 'path', 'url', 'prompt', 'query', 'description']) {
    if (typeof input[key] === 'string') parts.push(input[key]);
  }
  for (const key of ['content', 'new_string', 'old_string']) {
    if (typeof input[key] === 'string') parts.push(input[key].slice(0, 2000));
  }

  const sideEffect = {
    read: 'none',
    filesystem_write: 'filesystem',
    shell: 'process',
    network: 'network',
    mcp: 'external',
    agentic: 'delegation',
    unknown: 'unknown',
  }[capability];

  return {
    tool_name: name,
    capability,
    side_effect_class: sideEffect,
    target: input.file_path || input.path || input.url || null,
    scannable_text: parts.filter(Boolean).join('\n'),
  };
}

export function evaluateClaudeCodeAction(policy = {}, action = {}) {
  const reasons = [];
  let decision = 'allow';
  const escalate = (level, code, detail) => {
    if (RANK[level] > RANK[decision]) decision = level;
    reasons.push({ code, level, detail });
  };

  const text = action.scannable_text || '';
  const lowerText = text.toLowerCase();
  const lowerName = String(action.tool_name || '').toLowerCase();

  // 1. Injection / secret-exfil / policy-override / unauthorized-spend phrasing.
  const trap = trapScan(text);
  if (trap.blocked) escalate('deny', 'trap_injection_blocked', trap.matches.map((m) => m.id).join(','));

  // 2. Encoded-payload smuggling (morse/base64/hex/zero-width/unicode-tags).
  const encoded = scanSourceText(text);
  const criticalEncoded = (encoded.findings || []).filter((f) => f.severity === 'critical');
  if (criticalEncoded.length) escalate('deny', 'encoded_payload_blocked', criticalEncoded.map((f) => f.code || f.type || 'finding').join(','));
  else if ((encoded.findings || []).length) escalate('ask', 'suspicious_encoding', 'non-critical encoding finding');

  // 3. Explicit policy denials.
  const deniedTools = (policy?.tool_policy?.denied_tools || []).map((t) => String(t).toLowerCase());
  const deniedHit = deniedTools.find((d) => d && (lowerText.includes(d) || lowerName.includes(d)));
  if (deniedHit) escalate('deny', 'denied_tool', deniedHit);

  const blockedPaths = policy?.tool_policy?.blocked_paths || policy?.guard_policy?.blocked_paths || [];
  if (action.target && blockedPaths.some((p) => p && String(action.target).includes(p))) {
    escalate('deny', 'blocked_path', String(action.target));
  }

  // 4. Money / publish verbs are denied in local no-spend regardless of tool.
  if (action.capability !== 'read' && SPEND_OR_PUBLISH.test(text)) {
    escalate('deny', 'spend_or_publish_action', 'wallet/x402/publish/deploy verb present');
  }

  // 5. Capability defaults — safe by default: only reads auto-allow.
  switch (action.capability) {
    case 'read':
      break;
    case 'filesystem_write':
      escalate('ask', 'write_requires_review', 'file mutation needs owner review');
      break;
    case 'network':
      escalate('ask', 'network_requires_review', 'outbound fetch needs owner review');
      break;
    case 'agentic':
      escalate('ask', 'delegation_requires_review', 'spawns a sub-agent');
      break;
    case 'shell':
      if (PIPE_TO_SHELL.test(text)) escalate('deny', 'pipe_to_shell', 'remote-script piped into a shell');
      else if (HIGH_RISK_COMMAND.test(text)) escalate('deny', 'high_risk_command', 'irreversible/publish/deploy command');
      else escalate('ask', 'shell_requires_review', 'shell command needs owner review');
      break;
    case 'mcp':
      escalate('ask', 'mcp_requires_review', 'external MCP tool needs owner review');
      break;
    default:
      escalate('ask', 'unknown_capability', 'unclassified tool needs owner review');
  }

  return {
    schema: CLAUDE_CODE_ADAPTER_SCHEMA,
    decision,
    risk: decision === 'deny' ? 'high' : decision === 'ask' ? 'medium' : 'low',
    capability: action.capability,
    side_effect_class: action.side_effect_class,
    tool_name: action.tool_name,
    reasons,
    enforcement_boundary: {
      can_block: true,
      executes_tool: false,
      spends: false,
      settles_x402: false,
      publishes: false,
      grants_authority: false,
    },
  };
}

// Convenience: map + evaluate a raw PreToolUse payload in one call.
export function decideClaudeCodeToolCall(policy, payload) {
  return evaluateClaudeCodeAction(policy, mapClaudeCodeToolCall(payload));
}

export const HOOK_DECISION_SCHEMA = 'agoragentic.harness.claude-code-hook-decision.v1';

// Appends a redacted, append-only evidence line for each live hook decision.
// This is the receipt trail that makes enforcement auditable. Logging failures
// must never break the host agent, so callers should treat this as best-effort.
export async function recordHookDecision({ dir = process.cwd(), payload = {}, evaluation } = {}) {
  const createdAt = new Date().toISOString();
  const record = {
    schema: HOOK_DECISION_SCHEMA,
    decision_id: stableId('hookdec', `${payload.session_id || ''}:${payload.tool_name || ''}:${createdAt}`),
    created_at: createdAt,
    session_id: sanitizeForPublicEvidence(payload.session_id || null),
    hook_event_name: payload.hook_event_name || 'PreToolUse',
    tool_name: sanitizeForPublicEvidence(payload.tool_name || null),
    capability: evaluation.capability,
    side_effect_class: evaluation.side_effect_class,
    decision: evaluation.decision,
    risk: evaluation.risk,
    reasons: evaluation.reasons,
    enforcement_boundary: evaluation.enforcement_boundary,
    authority_boundary: authorityBoundary(),
  };
  const root = path.join(path.resolve(dir), '.agoragentic');
  await fs.mkdir(root, { recursive: true });
  await fs.appendFile(path.join(root, 'claude-code-hook-decisions.jsonl'), `${JSON.stringify(record)}\n`, 'utf8');
  return record;
}
