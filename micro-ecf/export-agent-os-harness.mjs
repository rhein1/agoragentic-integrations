#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_POLICY = path.join(__dirname, 'policy.example.json');
const DEFAULT_BASE_URL = 'https://agoragentic.com';

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
    output: null,
    baseUrl: DEFAULT_BASE_URL,
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--policy') args.policy = argv[++i];
    else if (arg === '--output') args.output = argv[++i];
    else if (arg === '--base-url') args.baseUrl = argv[++i];
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
  node micro-ecf/export-agent-os-harness.mjs --policy micro-ecf/policy.example.json --output ./agent-os-harness.packet.json

Options:
  --policy <path>    Micro ECF policy JSON. Defaults to micro-ecf/policy.example.json.
  --output <path>    Write packet to a file. Defaults to stdout.
  --base-url <url>   Agoragentic base URL. Defaults to https://agoragentic.com.
`);
}

function readPolicy(policyPath) {
  const resolved = path.resolve(policyPath);
  const policy = JSON.parse(fs.readFileSync(resolved, 'utf8'));
  validatePolicy(policy);
  return { policy, resolved };
}

function validatePolicy(policy) {
  for (const section of REQUIRED_SECTIONS) {
    if (!policy[section] || typeof policy[section] !== 'object' || Array.isArray(policy[section])) {
      throw new Error(`Missing required object section: ${section}`);
    }
  }
  if (!policy.agent_manifest.name) throw new Error('agent_manifest.name is required');
  if (!policy.agent_manifest.primary_goal) throw new Error('agent_manifest.primary_goal is required');
}

function buildHarnessPacket(policy, { baseUrl, policyPath }) {
  const deploymentPolicy = policy.deployment_policy || {};
  const budgetPolicy = policy.budget_policy || {};
  const agent = policy.agent_manifest || {};
  const source = deploymentPolicy.source || {};
  const hostingTarget = deploymentPolicy.hosting_target || 'self_hosted_http';

  const packet = {
    schema: 'agoragentic.agent-os.harness.v1',
    generated_at: new Date().toISOString(),
    generated_from: {
      source: 'micro-ecf/export-agent-os-harness.mjs',
      policy_path: policyPath,
      canonical_contract: `${baseUrl.replace(/\/$/, '')}/agent-os-harness.json`,
    },
    agent_manifest: agent,
    context_policy: policy.context_policy,
    tool_policy: policy.tool_policy,
    budget_policy: budgetPolicy,
    approval_policy: policy.approval_policy,
    memory_policy: policy.memory_policy,
    swarm_policy: policy.swarm_policy,
    deployment_policy: deploymentPolicy,
    public_boundary: {
      no_spend_export: true,
      hosted_billing: false,
      cloud_provisioning: false,
      marketplace_publication: false,
      hosted_runtime_secrets: false,
      requires_agent_os_preview_before_deployment: true,
      requires_treasury_funding_before_autonomous_spend: true,
    },
    agent_os_export: {
      catalog_endpoint: 'GET /api/hosting/agent-os/catalog',
      preview_endpoint: 'POST /api/hosting/agent-os/preview',
      deployment_endpoint: 'POST /api/hosting/agent-os/deployments',
      treasury_endpoint: 'GET /api/hosting/agent-os/deployments/{deployment_id}/treasury',
      workspace_surface: '/agent-os/workspaces/',
      marketplace_router: 'POST /api/execute',
      x402_edge: 'POST https://x402.agoragentic.com/v1/{slug}',
    },
    agent_os_preview_request: {
      name: agent.name,
      hosting_target: hostingTarget,
      template_id: hostingTarget === 'platform_hosted_syrin' ? 'syrin_creator_demo' : 'self_hosted_router_advocate',
      runtime_lane: hostingTarget === 'platform_hosted_syrin' ? 'shared_platform_runtime' : 'customer_managed_http_runtime',
      exposure_mode: deploymentPolicy.exposure_mode || 'private_only',
      source: {
        type: source.type || 'repository',
        ref: source.ref || '',
      },
      goals: {
        primary_goal: agent.primary_goal,
        budget: {
          max_daily_usdc: budgetPolicy.max_daily_spend_usdc || 0,
          approval_required_above_usdc: budgetPolicy.approval_required_above_usdc || 0,
          recommended_start_reserve_usdc: budgetPolicy.recommended_start_reserve_usdc || 0,
        },
      },
      safety_policy: {
        first_proof_required: deploymentPolicy.first_proof_required !== false,
        context_policy: policy.context_policy,
        tool_policy: policy.tool_policy,
        approval_policy: policy.approval_policy,
        memory_policy: policy.memory_policy,
        swarm_policy: policy.swarm_policy,
      },
      deployment_packet: {
        schema: 'agoragentic.micro-ecf.export.v1',
        source: 'public_micro_ecf',
        harness_schema: 'agoragentic.agent-os.harness.v1',
      },
    },
  };

  return packet;
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const { policy, resolved } = readPolicy(args.policy);
  const packet = buildHarnessPacket(policy, {
    baseUrl: args.baseUrl,
    policyPath: path.relative(process.cwd(), resolved).replace(/\\/g, '/'),
  });
  const json = `${JSON.stringify(packet, null, 2)}\n`;

  if (args.output) {
    const outputPath = path.resolve(args.output);
    fs.mkdirSync(path.dirname(outputPath), { recursive: true });
    fs.writeFileSync(outputPath, json);
    console.log(JSON.stringify({ ok: true, output: outputPath }, null, 2));
  } else {
    process.stdout.write(json);
  }
}

try {
  main();
} catch (err) {
  console.error(JSON.stringify({ ok: false, error: err.message }, null, 2));
  process.exit(1);
}
