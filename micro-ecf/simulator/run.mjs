#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_POLICY = path.join(__dirname, '..', 'policy.example.json');
const DEFAULT_TASK = path.join(__dirname, 'task.example.json');

const REQUIRED_SECTIONS = [
  'agent_manifest',
  'context_policy',
  'tool_policy',
  'budget_policy',
  'approval_policy',
  'memory_policy',
  'swarm_policy',
  'deployment_policy',
];

function parseArgs(argv) {
  const args = {
    policy: DEFAULT_POLICY,
    task: DEFAULT_TASK,
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--policy') args.policy = argv[++i];
    else if (arg === '--task') args.task = argv[++i];
    else if (arg === '--help' || arg === '-h') {
      printHelp();
      process.exit(0);
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }

  return args;
}

function printHelp() {
  console.log(`Usage:
  node micro-ecf/simulator/run.mjs --policy micro-ecf/policy.example.json --task micro-ecf/simulator/task.example.json

The simulator is local and no-spend. It validates a Micro ECF policy against one proposed task and prints pass/warn/fail checks.
`);
}

function readJson(filePath) {
  const resolved = path.resolve(filePath);
  return {
    resolved,
    value: JSON.parse(fs.readFileSync(resolved, 'utf8')),
  };
}

function asList(value) {
  return Array.isArray(value) ? value : [];
}

function add(checks, level, check, message, details = undefined) {
  checks.push({ level, check, message, ...(details === undefined ? {} : { details }) });
}

function simulate(policy, task) {
  const checks = [];
  const toolPolicy = policy.tool_policy || {};
  const budgetPolicy = policy.budget_policy || {};
  const approvalPolicy = policy.approval_policy || {};
  const deploymentPolicy = policy.deployment_policy || {};

  for (const section of REQUIRED_SECTIONS) {
    if (policy[section] && typeof policy[section] === 'object' && !Array.isArray(policy[section])) {
      add(checks, 'pass', `section.${section}`, `${section} is present`);
    } else {
      add(checks, 'fail', `section.${section}`, `${section} must be an object`);
    }
  }

  const requestedTools = asList(task.requested_tools);
  const allowedTools = asList(toolPolicy.allowed_tools);
  const deniedTools = new Set(asList(toolPolicy.denied_tools));
  const deniedRequestedTools = requestedTools.filter((tool) => deniedTools.has(tool));
  const unknownRequestedTools = requestedTools.filter((tool) => !allowedTools.includes(tool) && !deniedTools.has(tool));

  if (deniedRequestedTools.length > 0) {
    add(checks, 'fail', 'tools.denied_requested', 'Task requests tools explicitly denied by policy', deniedRequestedTools);
  } else {
    add(checks, 'pass', 'tools.denied_requested', 'Task does not request denied tools');
  }

  if (unknownRequestedTools.length > 0) {
    add(checks, 'warn', 'tools.unknown_requested', 'Task requests tools not listed in allowed_tools', unknownRequestedTools);
  } else {
    add(checks, 'pass', 'tools.unknown_requested', 'Requested tools are covered by allowed_tools or denied_tools');
  }

  const estimatedCost = Number(task.estimated_cost_usdc || 0);
  const maxDailySpend = Number(budgetPolicy.max_daily_spend_usdc || 0);
  const approvalAbove = Number(budgetPolicy.approval_required_above_usdc || 0);

  if (budgetPolicy.treasury_required !== true) {
    add(checks, 'fail', 'budget.treasury_required', 'treasury_required must be true before Agent OS autonomous spend');
  } else {
    add(checks, 'pass', 'budget.treasury_required', 'Treasury funding is required before autonomous spend');
  }

  if (estimatedCost > maxDailySpend) {
    add(checks, 'fail', 'budget.estimated_cost', 'Estimated task cost exceeds max_daily_spend_usdc', { estimatedCost, maxDailySpend });
  } else {
    add(checks, 'pass', 'budget.estimated_cost', 'Estimated task cost is inside the daily budget', { estimatedCost, maxDailySpend });
  }

  if (approvalAbove > 0 && estimatedCost > approvalAbove) {
    add(checks, 'warn', 'approval.threshold', 'Task exceeds approval_required_above_usdc and should stop for owner approval', { estimatedCost, approvalAbove });
  } else {
    add(checks, 'pass', 'approval.threshold', 'Task does not exceed the approval threshold', { estimatedCost, approvalAbove });
  }

  const sideEffects = String(task.side_effects || 'none');
  const humanGated = new Set(asList(approvalPolicy.human_gated));
  if (sideEffects !== 'none' && toolPolicy.side_effects !== 'approval_required') {
    add(checks, 'fail', 'approval.side_effects', 'Side-effecting tasks must require approval');
  } else if (sideEffects !== 'none' && !humanGated.has(sideEffects)) {
    add(checks, 'warn', 'approval.side_effects', 'Side effect is not listed in approval_policy.human_gated', sideEffects);
  } else {
    add(checks, 'pass', 'approval.side_effects', 'Side-effect policy is explicit for this task');
  }

  if (deploymentPolicy.first_proof_required === false) {
    add(checks, 'fail', 'deployment.first_proof', 'first_proof_required should stay true for Agent OS handoff');
  } else {
    add(checks, 'pass', 'deployment.first_proof', 'First proof is required before public exposure');
  }

  const failCount = checks.filter((entry) => entry.level === 'fail').length;
  const warnCount = checks.filter((entry) => entry.level === 'warn').length;

  return {
    ok: failCount === 0,
    schema: 'agoragentic.micro-ecf.simulation.v1',
    summary: {
      pass: checks.filter((entry) => entry.level === 'pass').length,
      warn: warnCount,
      fail: failCount,
      no_spend: true,
    },
    next_step: failCount === 0
      ? 'Export an Agent OS Harness packet with micro-ecf/export-agent-os-harness.mjs'
      : 'Fix failed policy checks before exporting the Agent OS Harness packet',
    checks,
  };
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const policy = readJson(args.policy);
  const task = readJson(args.task);
  const report = simulate(policy.value, task.value);
  report.generated_from = {
    source: 'micro-ecf/simulator/run.mjs',
    policy_path: path.relative(process.cwd(), policy.resolved).replace(/\\/g, '/'),
    task_path: path.relative(process.cwd(), task.resolved).replace(/\\/g, '/'),
  };
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  process.exit(report.ok ? 0 : 1);
}

try {
  main();
} catch (err) {
  console.error(JSON.stringify({ ok: false, error: err.message }, null, 2));
  process.exit(1);
}
