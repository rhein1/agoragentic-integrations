import { promises as fs } from 'node:fs';
import path from 'node:path';
import { authorityBoundary, sanitizeForPublicEvidence } from '../kernel/events.mjs';
import { harnessDir, readJsonIfExists } from '../kernel/state.mjs';

export const RETRY_POLICY_SCHEMA = 'agoragentic.harness.retry-policy.v1';

const SAFE_RUNTIME_TOOLS = Object.freeze([
  'runtime.health',
  'runtime.agent_card',
  'runtime.tools',
  'runtime.openapi',
  'runtime.schema',
]);

const HIGH_AUTHORITY_TOOL_IDS = Object.freeze([
  'agent_os.preview_submit',
  'marketplace.publish_listing',
  'x402.activate_route',
]);

const RETRY_ON = Object.freeze(['timeout', 'connection_reset', 'http_502', 'http_503', 'http_504']);

export async function initRetryPolicy({ dir = process.cwd() } = {}) {
  const existing = await readRetryPolicy(dir);
  if (existing) return { artifact: existing, path: retryPolicyRelativePath(), created: false };
  const createdAt = new Date().toISOString();
  const artifact = {
    schema: RETRY_POLICY_SCHEMA,
    created_at: createdAt,
    updated_at: createdAt,
    mode: 'local_no_spend_read_only_retries',
    applies_to: ['runtime_probe'],
    safe_read_only_retry_only: true,
    high_authority_actions_retried: false,
    tools: defaultToolPolicies(),
    blocked_tool_ids: [...HIGH_AUTHORITY_TOOL_IDS],
    last_evaluation: null,
    authority_boundary: retryAuthorityBoundary(),
  };
  await writeRetryPolicy(dir, artifact);
  return { artifact, path: retryPolicyRelativePath(), created: true };
}

export async function readRetryPolicy(dir = process.cwd()) {
  return readJsonIfExists(retryPolicyPath(dir));
}

export async function evaluateAndRecordRetryPolicy({ dir = process.cwd(), reason = 'local_check' } = {}) {
  const { artifact } = await initRetryPolicy({ dir });
  const evaluation = evaluateRetryPolicy(artifact);
  const updated = {
    ...artifact,
    updated_at: new Date().toISOString(),
    last_evaluation: {
      checked_at: new Date().toISOString(),
      reason,
      violations: evaluation.violations,
      status: evaluation.ok ? 'passed' : 'blocked',
    },
  };
  await writeRetryPolicy(dir, updated);
  return { policy: updated, evaluation };
}

export function evaluateRetryPolicy(policy = {}) {
  const tools = policy.tools || {};
  const violations = [];
  for (const toolId of HIGH_AUTHORITY_TOOL_IDS) {
    const entry = tools[toolId];
    if (!entry) continue;
    if (Number(entry.max_retries || 0) > 0 || entry.safe_read_only === true) {
      violations.push({
        code: 'high_authority_retry_policy_forbidden',
        tool_id: toolId,
        max_retries: Number(entry.max_retries || 0),
      });
    }
  }
  for (const [toolId, entry] of Object.entries(tools)) {
    if (!SAFE_RUNTIME_TOOLS.includes(toolId) && Number(entry.max_retries || 0) > 0) {
      violations.push({
        code: 'retry_policy_non_readonly_tool_forbidden',
        tool_id: toolId,
        max_retries: Number(entry.max_retries || 0),
      });
    }
  }
  return {
    ok: violations.length === 0,
    violations,
  };
}

export async function retryPolicyStatus(dir = process.cwd()) {
  const artifact = await readRetryPolicy(dir);
  if (!artifact) {
    return {
      present: false,
      path: null,
      violations: [],
      authority_boundary: retryAuthorityBoundary(),
    };
  }
  const evaluation = evaluateRetryPolicy(artifact);
  return {
    present: true,
    path: retryPolicyRelativePath(),
    schema: artifact.schema,
    mode: artifact.mode,
    safe_read_only_retry_only: artifact.safe_read_only_retry_only === true,
    high_authority_actions_retried: artifact.high_authority_actions_retried === true,
    tools: artifact.tools || {},
    blocked_tool_ids: artifact.blocked_tool_ids || [],
    last_evaluation: artifact.last_evaluation || null,
    violations: [
      ...(artifact.last_evaluation?.violations || []),
      ...evaluation.violations,
    ],
    authority_boundary: retryAuthorityBoundary(),
  };
}

export function retryPlanForTool(policy = {}, toolId) {
  const entry = policy.tools?.[toolId] || {};
  if (!SAFE_RUNTIME_TOOLS.includes(toolId)) return noRetryPlan(toolId, 'non_readonly_tool');
  if (entry.safe_read_only !== true) return noRetryPlan(toolId, 'not_marked_safe_read_only');
  return {
    tool_id: toolId,
    safe_read_only: true,
    max_retries: clampInt(entry.max_retries, 0, 3),
    initial_delay_ms: clampInt(entry.initial_delay_ms, 0, 1000),
    backoff_factor: Math.max(1, Number(entry.backoff_factor || 1)),
    max_delay_ms: clampInt(entry.max_delay_ms, 0, 5000),
    retry_on: Array.isArray(entry.retry_on) ? entry.retry_on.filter((item) => RETRY_ON.includes(item)) : [],
  };
}

export async function runWithRetry({ policy, toolId, operation, sleep = defaultSleep } = {}) {
  const plan = retryPlanForTool(policy, toolId);
  let attempt = 0;
  let lastResult = null;
  const attempts = [];
  while (attempt <= plan.max_retries) {
    lastResult = await operation({ attempt });
    const reason = retryReason(lastResult);
    attempts.push({
      attempt,
      ok: Boolean(lastResult?.ok),
      retry_reason: reason,
    });
    if (!reason || !plan.retry_on.includes(reason) || attempt >= plan.max_retries) {
      return {
        ...lastResult,
        retry: {
          tool_id: toolId,
          attempts,
          retried: attempts.length > 1,
          safe_read_only: plan.safe_read_only,
          high_authority_action_retried: false,
        },
      };
    }
    const delay = Math.min(plan.max_delay_ms, Math.round(plan.initial_delay_ms * (plan.backoff_factor ** attempt)));
    if (delay > 0) await sleep(delay);
    attempt += 1;
  }
  return lastResult;
}

export function createRetryPolicyMiddleware() {
  return {
    id: 'retry-policy',
    description: 'Loads local retry policy and blocks unsafe retries for high-authority actions.',
    authority: 'local_no_spend',
    async before_tool(context) {
      const { evaluation } = await evaluateAndRecordRetryPolicy({
        dir: context.dir,
        reason: 'middleware_before_tool',
      });
      await context.emit({
        type: evaluation.ok ? 'guard_decision' : 'run_blocked',
        severity: evaluation.ok ? 'info' : 'blocked',
        summary: evaluation.ok ? 'Retry policy check passed.' : 'Retry policy violation blocked the run.',
        data: {
          policy_path: retryPolicyRelativePath(),
          violations: evaluation.violations,
        },
      });
      if (!evaluation.ok) {
        context.blocked = true;
        context.block_reason = 'retry_policy_violation';
        return { blocked: true, reason: context.block_reason };
      }
      return null;
    },
  };
}

function defaultToolPolicies() {
  return Object.fromEntries([
    ...SAFE_RUNTIME_TOOLS.map((toolId) => [
      toolId,
      {
        safe_read_only: true,
        max_retries: 1,
        initial_delay_ms: 25,
        backoff_factor: 2,
        max_delay_ms: 100,
        retry_on: [...RETRY_ON],
      },
    ]),
    ...HIGH_AUTHORITY_TOOL_IDS.map((toolId) => [
      toolId,
      {
        safe_read_only: false,
        max_retries: 0,
        retry_on: [],
        blocked_in_local_no_spend: true,
      },
    ]),
  ]);
}

async function writeRetryPolicy(dir, artifact) {
  await fs.mkdir(harnessDir(dir), { recursive: true });
  await fs.writeFile(retryPolicyPath(dir), `${JSON.stringify(sanitizeForPublicEvidence(artifact), null, 2)}\n`, 'utf8');
}

function retryReason(result = {}) {
  if (result.ok) return null;
  if (result.error_class === 'timeout') return 'timeout';
  if (result.error_class === 'connection_reset') return 'connection_reset';
  if ([502, 503, 504].includes(Number(result.http_status))) return `http_${result.http_status}`;
  return null;
}

function noRetryPlan(toolId, reason) {
  return {
    tool_id: toolId,
    safe_read_only: false,
    max_retries: 0,
    initial_delay_ms: 0,
    backoff_factor: 1,
    max_delay_ms: 0,
    retry_on: [],
    reason,
  };
}

function clampInt(value, min, max) {
  const number = Number.isFinite(Number(value)) ? Math.round(Number(value)) : min;
  return Math.max(min, Math.min(max, number));
}

function retryPolicyPath(dir) {
  return path.join(harnessDir(dir), 'retry-policy.json');
}

function retryPolicyRelativePath() {
  return '.agoragentic/retry-policy.json';
}

function retryAuthorityBoundary() {
  return authorityBoundary({
    hosted_memory_write: false,
    high_authority_actions_retried: false,
    paid_calls_retried: false,
    provider_dispatch_retried: false,
  });
}

function defaultSleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
