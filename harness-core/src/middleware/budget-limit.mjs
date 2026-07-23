import { promises as fs } from 'node:fs';
import path from 'node:path';
import { authorityBoundary, sanitizeForPublicEvidence } from '../kernel/events.mjs';
import { harnessDir, readJsonIfExists } from '../kernel/state.mjs';

export const BUDGET_POLICY_SCHEMA = 'agoragentic.harness.budget-policy.v1';

export const DEFAULT_BUDGET_LIMITS = Object.freeze({
  model_calls: 0,
  paid_tool_calls: 0,
  wallet_spend_usdc: 0,
  network_calls: 10,
  runtime_probe_timeout_ms: 2500,
});

export async function initBudgetPolicy({ dir = process.cwd() } = {}) {
  const existing = await readBudgetPolicy(dir);
  if (existing) return { artifact: existing, path: budgetPolicyRelativePath(), created: false };
  const createdAt = new Date().toISOString();
  const artifact = {
    schema: BUDGET_POLICY_SCHEMA,
    created_at: createdAt,
    updated_at: createdAt,
    mode: 'local_no_spend',
    limits: { ...DEFAULT_BUDGET_LIMITS },
    hard_stop_on_violation: true,
    applies_to: ['runtime_probe', 'tool_lifecycle_checks'],
    current_usage: zeroUsage(),
    last_evaluation: null,
    authority_boundary: budgetAuthorityBoundary(),
  };
  await writeBudgetPolicy(dir, artifact);
  return { artifact, path: budgetPolicyRelativePath(), created: true };
}

export async function readBudgetPolicy(dir = process.cwd()) {
  return readJsonIfExists(budgetPolicyPath(dir));
}

export async function evaluateAndRecordBudgetUsage({ dir = process.cwd(), usage = {}, reason = 'local_check' } = {}) {
  const { artifact } = await initBudgetPolicy({ dir });
  const evaluation = evaluateBudgetUsage(artifact, usage);
  const updated = {
    ...artifact,
    updated_at: new Date().toISOString(),
    current_usage: sanitizeForPublicEvidence(normalizeUsage(usage)),
    last_evaluation: {
      checked_at: new Date().toISOString(),
      reason,
      usage: sanitizeForPublicEvidence(normalizeUsage(usage)),
      violations: evaluation.violations,
      status: evaluation.ok ? 'passed' : 'blocked',
      hard_stop_on_violation: artifact.hard_stop_on_violation !== false,
    },
  };
  await writeBudgetPolicy(dir, updated);
  return { policy: updated, evaluation };
}

export function evaluateBudgetUsage(policy = {}, usage = {}) {
  const limits = { ...DEFAULT_BUDGET_LIMITS, ...(policy.limits || {}) };
  const normalized = normalizeUsage(usage);
  const violations = [];
  for (const [key, value] of Object.entries(normalized)) {
    if (!Object.hasOwn(limits, key)) continue;
    if (Number(value) > Number(limits[key])) {
      violations.push({
        code: `budget_${key}_exceeded`,
        field: key,
        limit: Number(limits[key]),
        actual: Number(value),
      });
    }
  }
  return {
    ok: violations.length === 0,
    violations,
    limits,
    usage: normalized,
  };
}

export async function budgetPolicyStatus(dir = process.cwd()) {
  const artifact = await readBudgetPolicy(dir);
  if (!artifact) {
    return {
      present: false,
      path: null,
      violations: [],
      authority_boundary: budgetAuthorityBoundary(),
    };
  }
  return {
    present: true,
    path: budgetPolicyRelativePath(),
    schema: artifact.schema,
    mode: artifact.mode,
    limits: artifact.limits || {},
    current_usage: artifact.current_usage || zeroUsage(),
    last_evaluation: artifact.last_evaluation || null,
    violations: artifact.last_evaluation?.violations || [],
    authority_boundary: budgetAuthorityBoundary(),
  };
}

export function createBudgetLimitMiddleware() {
  return {
    id: 'budget-limit',
    description: 'Loads local no-spend budget limits and blocks policy violations before tool lifecycle checks.',
    authority: 'local_no_spend',
    async before_tool(context) {
      const usage = context.options?.budget_usage || zeroUsage();
      const { evaluation } = await evaluateAndRecordBudgetUsage({
        dir: context.dir,
        usage,
        reason: 'middleware_before_tool',
      });
      await context.emit({
        type: evaluation.ok ? 'guard_decision' : 'run_blocked',
        severity: evaluation.ok ? 'info' : 'blocked',
        summary: evaluation.ok ? 'Budget policy check passed.' : 'Budget policy violation blocked the run.',
        data: {
          policy_path: budgetPolicyRelativePath(),
          usage: evaluation.usage,
          violations: evaluation.violations,
        },
      });
      if (!evaluation.ok) {
        context.blocked = true;
        context.block_reason = 'budget_policy_violation';
        return { blocked: true, reason: context.block_reason };
      }
      return null;
    },
  };
}

export function plannedRuntimeProbeUsage({ endpoint_count = 0, max_retries_by_endpoint = [] } = {}) {
  const retryBudget = max_retries_by_endpoint.reduce((sum, value) => sum + Math.max(0, Number(value || 0)), 0);
  return {
    ...zeroUsage(),
    network_calls: Number(endpoint_count || 0) + retryBudget,
  };
}

function zeroUsage() {
  return {
    model_calls: 0,
    paid_tool_calls: 0,
    wallet_spend_usdc: 0,
    network_calls: 0,
    runtime_probe_timeout_ms: 0,
  };
}

function normalizeUsage(usage = {}) {
  return {
    model_calls: Number(usage.model_calls || 0),
    paid_tool_calls: Number(usage.paid_tool_calls || 0),
    wallet_spend_usdc: Number(usage.wallet_spend_usdc || 0),
    network_calls: Number(usage.network_calls || 0),
    runtime_probe_timeout_ms: Number(usage.runtime_probe_timeout_ms || 0),
  };
}

async function writeBudgetPolicy(dir, artifact) {
  await fs.mkdir(harnessDir(dir), { recursive: true });
  await fs.writeFile(budgetPolicyPath(dir), `${JSON.stringify(artifact, null, 2)}\n`, 'utf8');
}

function budgetPolicyPath(dir) {
  return path.join(harnessDir(dir), 'budget-policy.json');
}

function budgetPolicyRelativePath() {
  return '.agoragentic/budget-policy.json';
}

function budgetAuthorityBoundary() {
  return authorityBoundary({
    hosted_memory_write: false,
    model_calls_allowed: false,
    paid_tool_calls_allowed: false,
    wallet_spend_allowed: false,
  });
}
