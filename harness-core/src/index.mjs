import { promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { adapterCatalog } from './adapters/index.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const packageRoot = path.resolve(__dirname, '..');

const SCHEMA = {
  agent: 'agoragentic.harness.agent.v1',
  policy: 'agoragentic.harness.policy.v1',
  proof: 'agoragentic.harness.local-proof.v1',
  receipt: 'agoragentic.harness.local-receipt.v1',
  readiness: 'agoragentic.harness.listing-readiness.v1',
  export: 'agoragentic.agent-os.harness.v1',
};

const DEFAULT_AGENT_OS_EXPORT = {
  catalog_endpoint: 'GET /api/hosting/agent-os/catalog',
  preview_endpoint: 'POST /api/hosting/agent-os/preview',
  deployment_endpoint: 'POST /api/hosting/agent-os/deployments',
  treasury_endpoint: 'GET /api/hosting/agent-os/deployments/{deployment_id}/treasury',
  workspace_surface: '/agent-os/workspaces/',
  marketplace_router: 'POST /api/execute',
  x402_edge: 'POST https://x402.agoragentic.com/v1/{slug}',
};

const TRAP_PATTERNS = [
  { id: 'ignore_previous_instructions', pattern: /\bignore (all )?(previous|prior) instructions\b/i },
  { id: 'system_prompt_exfiltration', pattern: /\b(system prompt|developer message|hidden instructions)\b/i },
  { id: 'secret_exfiltration', pattern: /\b(api[_ -]?key|private[_ -]?key|seed phrase|wallet secret|database_url|admin_secret)\b/i },
  { id: 'policy_override', pattern: /\b(bypass|disable|override).{0,40}\b(policy|approval|guardrail|budget|safety)\b/i },
  { id: 'unauthorized_spend', pattern: /\b(spend|pay|transfer|withdraw).{0,40}\b(without approval|automatically|silently)\b/i },
];

export {
  SCHEMA,
  adapterCatalog,
};

export async function initProject({ dir = process.cwd(), template = 'codebase_maintenance', force = false } = {}) {
  const target = path.resolve(dir);
  const templateDir = path.join(packageRoot, 'templates', template);
  await assertDirectoryExists(templateDir, `Unknown template: ${template}`);

  const outputs = [];
  for (const file of ['agent.yaml', 'policy.yaml']) {
    const source = path.join(templateDir, file);
    const destination = path.join(target, file);
    const exists = await pathExists(destination);
    if (exists && !force) {
      throw new Error(`${file} already exists. Re-run with --force to overwrite.`);
    }
    await fs.mkdir(path.dirname(destination), { recursive: true });
    await fs.copyFile(source, destination);
    outputs.push(path.relative(target, destination).replace(/\\/g, '/'));
  }

  await fs.mkdir(path.join(target, '.agoragentic'), { recursive: true });
  return {
    ok: true,
    template,
    boundary: 'local_no_spend',
    files: outputs,
    next: [
      'agoragentic-harness validate',
      'agoragentic-harness proof',
      'agoragentic-harness export --to agent-os',
      'agoragentic-harness listing check',
    ],
  };
}

export async function loadProject(dir = process.cwd()) {
  const target = path.resolve(dir);
  const agentPath = path.join(target, 'agent.yaml');
  const policyPath = path.join(target, 'policy.yaml');
  const agent = parseSimpleYaml(await fs.readFile(agentPath, 'utf8'));
  const policy = parseSimpleYaml(await fs.readFile(policyPath, 'utf8'));
  return {
    dir: target,
    agent_path: agentPath,
    policy_path: policyPath,
    agent,
    policy,
  };
}

export function runValidation(project) {
  const issues = [];
  const { agent, policy } = project;

  requireValue(issues, agent.schema === SCHEMA.agent, 'agent_schema_invalid', `agent.yaml schema must be ${SCHEMA.agent}`);
  requireValue(issues, policy.schema === SCHEMA.policy, 'policy_schema_invalid', `policy.yaml schema must be ${SCHEMA.policy}`);
  requireValue(issues, agent.name, 'agent_name_required', 'agent.yaml requires name');
  requireValue(issues, agent.primary_goal, 'agent_goal_required', 'agent.yaml requires primary_goal');
  requireValue(issues, agent.framework, 'agent_framework_required', 'agent.yaml requires framework');
  requireValue(issues, policy.context_policy?.allowed_sources?.length, 'context_allowed_sources_required', 'policy.yaml requires context_policy.allowed_sources');
  requireValue(issues, policy.context_policy?.denied_sources, 'context_denied_sources_required', 'policy.yaml requires context_policy.denied_sources');
  requireValue(issues, policy.tool_policy?.allowed_tools, 'tool_allowed_tools_required', 'policy.yaml requires tool_policy.allowed_tools');
  requireValue(issues, policy.tool_policy?.denied_tools, 'tool_denied_tools_required', 'policy.yaml requires tool_policy.denied_tools');
  requireValue(issues, Number.isFinite(policy.budget_policy?.max_daily_spend_usdc), 'budget_max_daily_required', 'policy.yaml requires budget_policy.max_daily_spend_usdc');
  requireValue(issues, policy.approval_policy?.human_gated?.length, 'approval_human_gate_required', 'policy.yaml requires at least one approval_policy.human_gated action');
  requireValue(issues, policy.deployment_policy?.first_proof_required === true, 'first_proof_required', 'deployment_policy.first_proof_required must be true for Harness Core exports');

  const scan = trapScan([agent.primary_goal, agent.description, ...(policy.tool_policy?.allowed_tools || [])].join('\n'));
  if (scan.blocked) {
    issues.push({
      code: 'trap_scan_blocked',
      message: 'Trap-scanned blocked content cannot enter agent instructions.',
      matches: scan.matches.map((entry) => entry.id),
    });
  }

  return {
    ok: issues.length === 0,
    schema: 'agoragentic.harness.validation.v1',
    authority: {
      no_spend: true,
      no_deploy: true,
      no_marketplace_publish: true,
      no_x402_enable: true,
    },
    priority_order: ['owner_policy', 'approval_policy', 'budget_policy', 'tool_policy', 'model_preference'],
    issues,
  };
}

export function createLocalProof(project, options = {}) {
  const validation = runValidation(project);
  const createdAt = options.created_at || new Date().toISOString();
  const proofId = stableId('proof', `${project.agent.name}:${project.agent.primary_goal}:${createdAt}`);
  const trap = trapScan([project.agent.primary_goal, project.agent.description].join('\n'));
  const blocked = !validation.ok || trap.blocked;

  return {
    schema: SCHEMA.proof,
    proof_id: proofId,
    created_at: createdAt,
    mode: 'local_no_spend',
    status: blocked ? 'blocked' : 'passed',
    agent: {
      name: project.agent.name,
      framework: project.agent.framework,
      primary_goal: project.agent.primary_goal,
      runtime_shape: project.agent.runtime_shape || 'self_hosted_http',
    },
    plan_preview: blocked ? [] : [
      'Load owner-approved context and policy only.',
      'Prepare one bounded first-proof task without external side effects.',
      'Stop for owner review before funding, publishing, x402, or marketplace exposure.',
    ],
    checks: {
      validation_ok: validation.ok,
      trap_scan_clear: !trap.blocked,
      no_spend: true,
      no_network_required: true,
      owner_approval_required_for_side_effects: true,
    },
    trap_scan_results: trap,
    blocked_reasons: validation.issues.map((issue) => issue.code),
    authority_boundary: noAuthorityBoundary(),
  };
}

export function createLocalReceipt(project, proof, options = {}) {
  const createdAt = options.created_at || new Date().toISOString();
  return {
    schema: SCHEMA.receipt,
    receipt_id: stableId('local_receipt', `${proof.proof_id}:${createdAt}`),
    proof_id: proof.proof_id,
    created_at: createdAt,
    mode: 'local_no_spend_receipt',
    status: proof.status === 'passed' ? 'recorded' : 'blocked',
    spend: {
      amount_usdc: 0,
      settlement_network: 'none',
      settlement_status: 'not_applicable',
    },
    evidence: {
      agent_name: project.agent.name,
      primary_goal: project.agent.primary_goal,
      proof_status: proof.status,
      local_artifacts: ['agent.yaml', 'policy.yaml', '.agoragentic/local-proof.json'],
    },
    receipt_boundary: {
      router_invocation_created: false,
      x402_payment_attempted: false,
      marketplace_published: false,
      hosted_runtime_provisioned: false,
      memory_written: false,
    },
  };
}

export function buildAgentOsExport(project, options = {}) {
  const generatedAt = options.generated_at || new Date().toISOString();
  const policy = project.policy;
  const agent = project.agent;
  const previewRequest = {
    name: agent.name,
    hosting_target: policy.deployment_policy.hosting_target || 'self_hosted_http',
    template_id: policy.deployment_policy.template_id || 'self_hosted_router_advocate',
    runtime_lane: policy.deployment_policy.runtime_lane || 'customer_managed_http_runtime',
    exposure_mode: policy.deployment_policy.exposure_mode || 'private_only',
    source: policy.deployment_policy.source || { type: 'local_harness_core', ref: 'agent.yaml' },
    goals: {
      primary_goal: agent.primary_goal,
      budget: {
        max_daily_usdc: policy.budget_policy.max_daily_spend_usdc,
        approval_required_above_usdc: policy.budget_policy.approval_required_above_usdc,
        recommended_start_reserve_usdc: policy.budget_policy.recommended_start_reserve_usdc || 0,
      },
    },
    safety_policy: {
      first_proof_required: true,
      context_policy: policy.context_policy,
      tool_policy: policy.tool_policy,
      approval_policy: policy.approval_policy,
      memory_policy: policy.memory_policy,
      swarm_policy: policy.swarm_policy,
    },
    deployment_packet: {
      schema: 'agoragentic.micro-ecf.export.v1',
      source: 'harness_core_local',
      harness_schema: SCHEMA.export,
      local_artifacts: {
        agent: 'agent.yaml',
        policy: 'policy.yaml',
        proof: '.agoragentic/local-proof.json',
        receipt: '.agoragentic/local-receipt.json',
      },
    },
  };

  return {
    schema: SCHEMA.export,
    generated_at: generatedAt,
    generated_from: {
      source: 'agoragentic-harness-core',
      package_version: '0.1.0',
      local_only: true,
    },
    schema_artifacts: {
      agent_os_harness: 'https://agoragentic.com/schema/agent-os-harness.v1.json',
      micro_ecf_policy: 'https://agoragentic.com/schema/micro-ecf-policy.v1.json',
    },
    agent_manifest: {
      name: agent.name,
      framework: agent.framework,
      primary_goal: agent.primary_goal,
      runtime_shape: agent.runtime_shape || 'self_hosted_http',
    },
    context_policy: policy.context_policy,
    tool_policy: policy.tool_policy,
    budget_policy: policy.budget_policy,
    approval_policy: policy.approval_policy,
    memory_policy: policy.memory_policy,
    swarm_policy: policy.swarm_policy,
    deployment_policy: policy.deployment_policy,
    public_boundary: publicBoundary(),
    learning_memory_boundary: {
      mode: 'review_guidance_only',
      review_statuses: ['blocked', 'manual_review', 'proposal_ready'],
      side_effect_authority: {
        authorize_spend: false,
        deploy_runtime: false,
        publish_listing: false,
        mutate_trust: false,
      },
      full_ecf_internals_excluded: true,
    },
    agent_os_export: DEFAULT_AGENT_OS_EXPORT,
    agent_os_preview_request: previewRequest,
  };
}

export async function checkListingReadiness(project, dir = project.dir) {
  const artifactsDir = path.join(path.resolve(dir), '.agoragentic');
  const proof = await maybeReadJson(path.join(artifactsDir, 'local-proof.json'));
  const receipt = await maybeReadJson(path.join(artifactsDir, 'local-receipt.json'));
  const packet = await maybeReadJson(path.join(artifactsDir, 'agent-os-harness.json'));
  const blockers = [];

  if (!proof || proof.status !== 'passed') blockers.push(blocker('local_proof_missing_or_blocked', 'Run agoragentic-harness proof before listing readiness.'));
  if (!receipt || receipt.status !== 'recorded') blockers.push(blocker('local_receipt_missing', 'A local no-spend receipt must exist before listing readiness.'));
  if (!packet || packet.schema !== SCHEMA.export) blockers.push(blocker('agent_os_export_missing', 'Run agoragentic-harness export --to agent-os before listing readiness.'));
  if (project.policy.deployment_policy.exposure_mode === 'x402_paid_edge' && !project.policy.deployment_policy.paid_canary_required) {
    blockers.push(blocker('x402_paid_canary_required', 'x402 exposure requires paid canary evidence before public readiness.'));
  }

  return {
    schema: SCHEMA.readiness,
    generated_at: new Date().toISOString(),
    status: blockers.length ? 'blocked' : 'proposal_ready',
    listing_candidate: {
      name: project.agent.name,
      primary_goal: project.agent.primary_goal,
      exposure_mode: project.policy.deployment_policy.exposure_mode,
      router_entrypoint: 'POST /api/execute',
    },
    checks: {
      local_proof_passed: proof?.status === 'passed',
      local_receipt_recorded: receipt?.status === 'recorded',
      agent_os_export_ready: packet?.schema === SCHEMA.export,
      no_spend_boundary_preserved: true,
      owner_review_required: true,
    },
    blockers,
    next_actions: blockers.length
      ? ['Fix blockers and re-run listing check.']
      : ['Submit packet to Agent OS preview.', 'Fund treasury only after owner approval.', 'Run hosted first proof before public marketplace/x402 exposure.'],
  };
}

export async function writeJsonArtifact(dir, fileName, payload) {
  const artifactsDir = path.join(path.resolve(dir), '.agoragentic');
  await fs.mkdir(artifactsDir, { recursive: true });
  const filePath = path.join(artifactsDir, fileName);
  await fs.writeFile(filePath, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
  return filePath;
}

export function trapScan(input) {
  const text = String(input || '');
  const matches = TRAP_PATTERNS
    .filter((entry) => entry.pattern.test(text))
    .map((entry) => ({ id: entry.id, severity: 'blocked' }));
  return {
    schema: 'agoragentic.harness.trap-scan.v1',
    blocked: matches.length > 0,
    matches,
    instruction_injection_allowed: false,
  };
}

export function publicBoundary() {
  return {
    no_spend_export: true,
    hosted_billing: false,
    cloud_provisioning: false,
    marketplace_publication: false,
    hosted_runtime_secrets: false,
  };
}

function noAuthorityBoundary() {
  return {
    spend_usdc: false,
    call_router_execute: false,
    publish_marketplace_listing: false,
    enable_x402: false,
    provision_hosted_runtime: false,
    mutate_trust: false,
    write_memory: false,
  };
}

function blocker(code, message) {
  return { code, message };
}

function requireValue(issues, condition, code, message) {
  if (!condition) issues.push({ code, message });
}

async function maybeReadJson(filePath) {
  try {
    return JSON.parse(await fs.readFile(filePath, 'utf8'));
  } catch {
    return null;
  }
}

async function assertDirectoryExists(dir, message) {
  try {
    const stat = await fs.stat(dir);
    if (!stat.isDirectory()) throw new Error(message);
  } catch {
    throw new Error(message);
  }
}

async function pathExists(filePath) {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

function stableId(prefix, seed) {
  let hash = 2166136261;
  for (const char of String(seed)) {
    hash ^= char.charCodeAt(0);
    hash = Math.imul(hash, 16777619);
  }
  return `${prefix}_${(hash >>> 0).toString(16).padStart(8, '0')}`;
}

export function parseSimpleYaml(source) {
  const root = {};
  const stack = [{ indent: -1, value: root }];
  const lines = String(source).split(/\r?\n/);

  for (let index = 0; index < lines.length; index += 1) {
    const raw = lines[index];
    const withoutComment = raw.replace(/\s+#.*$/, '');
    if (!withoutComment.trim()) continue;
    const indent = withoutComment.match(/^ */)[0].length;
    const trimmed = withoutComment.trim();

    while (stack.length > 1 && indent <= stack[stack.length - 1].indent) stack.pop();
    const parent = stack[stack.length - 1].value;

    if (trimmed.startsWith('- ')) {
      if (!Array.isArray(parent)) throw new Error(`Invalid YAML list item without array parent: ${trimmed}`);
      parent.push(parseScalar(trimmed.slice(2)));
      continue;
    }

    const splitIndex = trimmed.indexOf(':');
    if (splitIndex === -1) throw new Error(`Invalid YAML line: ${trimmed}`);
    const key = trimmed.slice(0, splitIndex).trim();
    const valueText = trimmed.slice(splitIndex + 1).trim();
    if (!valueText) {
      const nextMeaningful = lines.slice(index + 1).find((line) => line.trim());
      const value = nextMeaningful && nextMeaningful.trim().startsWith('- ') ? [] : {};
      parent[key] = value;
      stack.push({ indent, value });
    } else {
      parent[key] = parseScalar(valueText);
    }
  }

  return root;
}

function parseScalar(value) {
  if (value === 'true') return true;
  if (value === 'false') return false;
  if (value === 'null') return null;
  if (/^-?\d+(\.\d+)?$/.test(value)) return Number(value);
  if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
    return value.slice(1, -1);
  }
  return value;
}
