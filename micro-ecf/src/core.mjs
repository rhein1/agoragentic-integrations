import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

export const REQUIRED_SECTIONS = [
  'agent_manifest',
  'context_policy',
  'tool_policy',
  'budget_policy',
  'approval_policy',
  'memory_policy',
  'swarm_policy',
  'deployment_policy',
];

export const DEFAULT_BASE_URL = 'https://agoragentic.com';
export const DEFAULT_OUTPUT_DIR = '.micro-ecf';

const TEXT_EXTENSIONS = new Set([
  '.c',
  '.cc',
  '.conf',
  '.cpp',
  '.cs',
  '.css',
  '.csv',
  '.go',
  '.h',
  '.html',
  '.ini',
  '.java',
  '.js',
  '.json',
  '.jsx',
  '.md',
  '.mdx',
  '.mjs',
  '.py',
  '.rb',
  '.rs',
  '.sh',
  '.sql',
  '.toml',
  '.ts',
  '.tsx',
  '.txt',
  '.xml',
  '.yaml',
  '.yml',
]);

const SQLITE_EXTENSIONS = new Set(['.db', '.sqlite', '.sqlite3']);

const DEFAULT_BLOCK_DIRS = new Set([
  '.cache',
  '.git',
  '.hg',
  '.micro-ecf',
  '.next',
  '.svn',
  '.turbo',
  '.venv',
  '__pycache__',
  'build',
  'coverage',
  'dist',
  'node_modules',
  'target',
  'venv',
]);

const DEFAULT_BLOCK_BASENAMES = new Set([
  '.env',
  '.env.local',
  '.npmrc',
  '.pypirc',
  'id_dsa',
  'id_ecdsa',
  'id_ed25519',
  'id_rsa',
  'known_hosts',
]);

const DEFAULT_BLOCK_SUBSTRINGS = [
  'credential',
  'customer_private',
  'mnemonic',
  'password',
  'private-key',
  'private_key',
  'secret',
  'seed-phrase',
  'seed_phrase',
  'wallet-seed',
  'wallet_seed',
];

const DEFAULT_BLOCK_SUFFIXES = [
  '.bak',
  '.crt',
  '.der',
  '.key',
  '.p12',
  '.pem',
  '.pfx',
];

export function createDefaultPolicy(projectName = 'local-agent') {
  return {
    schema: 'agoragentic.micro-ecf.policy.v1',
    agent_manifest: {
      name: projectName,
      framework: 'local',
      primary_goal: 'Prepare a bounded local agent for Agent OS preview',
      runtime_shape: 'self_hosted_http',
    },
    context_policy: {
      allowed_sources: ['local_repo', 'local_docs', 'local_database_summaries'],
      denied_sources: ['secrets', 'private_keys', 'wallet_seeds', 'raw_credentials'],
      local_allow: ['docs/**', 'src/**', '*.md', '*.json', '*.yaml', '*.yml'],
      local_block: ['.env*', 'secrets/**', 'customer_private/**'],
      retention: 'local_only_until_export',
      redaction: 'secrets_reference_only',
    },
    tool_policy: {
      allowed_tools: ['local_search', 'local_context_read', 'agent_os_preview_export'],
      denied_tools: ['wallet_settlement', 'hosted_provisioning', 'x402_execution'],
      side_effects: 'approval_required',
    },
    budget_policy: {
      treasury_required: true,
      max_daily_spend_usdc: 0,
      approval_required_above_usdc: 0,
      recommended_start_reserve_usdc: 0,
    },
    approval_policy: {
      autonomous: ['read', 'summarize', 'draft', 'preview_export'],
      human_gated: ['publish', 'spend', 'send_external', 'raise_budget'],
    },
    memory_policy: {
      write_gate: 'local_review_before_memory_write',
      secret_storage: 'reference_only',
    },
    swarm_policy: {
      max_agents: 3,
      delegation: 'role_scoped',
    },
    deployment_policy: {
      hosting_target: 'self_hosted_http',
      exposure_mode: 'private_only',
      first_proof_required: true,
      source: {
        type: 'repository',
        ref: '',
      },
    },
    context_providers: [],
  };
}

export function readJson(filePath) {
  return JSON.parse(fs.readFileSync(path.resolve(filePath), 'utf8'));
}

export function writeJson(filePath, value) {
  const resolved = path.resolve(filePath);
  fs.mkdirSync(path.dirname(resolved), { recursive: true });
  fs.writeFileSync(resolved, `${JSON.stringify(value, null, 2)}\n`);
  return resolved;
}

export function readPolicy(policyPath) {
  const resolved = path.resolve(policyPath);
  const policy = readJson(resolved);
  validatePolicy(policy);
  return { policy, resolved };
}

export function validatePolicy(policy) {
  for (const section of REQUIRED_SECTIONS) {
    if (!policy[section] || typeof policy[section] !== 'object' || Array.isArray(policy[section])) {
      throw new Error(`Missing required object section: ${section}`);
    }
  }
  if (!policy.agent_manifest.name) throw new Error('agent_manifest.name is required');
  if (!policy.agent_manifest.primary_goal) throw new Error('agent_manifest.primary_goal is required');
}

export function initProject({ targetDir = process.cwd(), force = false } = {}) {
  const root = path.resolve(targetDir);
  const outputDir = path.join(root, DEFAULT_OUTPUT_DIR);
  fs.mkdirSync(outputDir, { recursive: true });

  const policyPath = path.join(outputDir, 'policy.json');
  const agentsPath = path.join(root, 'AGENTS.md');
  const bootstrapPath = path.join(root, 'MICRO_ECF_LLM_BOOTSTRAP.md');
  const projectName = path.basename(root) || 'local-agent';

  writeIfAllowed(policyPath, createDefaultPolicy(projectName), force);
  writeTextIfAllowed(agentsPath, buildAgentsMd(projectName), force);
  writeTextIfAllowed(bootstrapPath, buildLlmBootstrapMd(projectName), force);

  return {
    ok: true,
    output_dir: relativePortable(process.cwd(), outputDir),
    policy: relativePortable(process.cwd(), policyPath),
    agents_md: relativePortable(process.cwd(), agentsPath),
    llm_bootstrap: relativePortable(process.cwd(), bootstrapPath),
    next_steps: [
      `micro-ecf index ${portablePath(root)}`,
      'micro-ecf build-packet',
      'micro-ecf export --agent-os',
    ],
  };
}

export function buildExplanation() {
  return {
    name: 'Micro ECF',
    summary: 'Micro ECF is a lightweight local context layer for builders who want safer agents.',
    what_it_does: [
      'Indexes small repos, docs, local files, and database exports locally.',
      'Builds citation-ready context packets and source maps without exporting raw source content.',
      'Applies local policy boundaries for allowed context, blocked sources, tools, budgets, approvals, memory, and swarms.',
      'Exports an Agent OS Harness file for no-spend deployment preview.',
    ],
    why_it_helps: [
      'Your IDE LLM gets a stable map of what it can safely know and cite.',
      'Secret-looking files, private keys, wallet seeds, credentials, node_modules, and .git internals are blocked by default.',
      'Agent OS receives a structured preview packet instead of an informal prompt or screenshot.',
      'You keep local control until you explicitly choose to preview or deploy through Agent OS.',
    ],
    boundary: {
      micro_ecf: 'local context wedge',
      agent_os: 'deployment product',
      full_ecf: 'private enterprise runtime engine',
      local_only: true,
      cloud_required: false,
      no_spend: true,
      no_hosted_deploy: true,
      no_marketplace_publish: true,
      no_full_ecf_internals: true,
      no_router_ranking: true,
      no_wallet_or_x402_settlement: true,
    },
  };
}

export function buildInstallPlan({ targetDir = process.cwd(), outputDir = null, force = false } = {}) {
  const root = path.resolve(targetDir);
  const resolvedOutput = path.resolve(outputDir || path.join(root, DEFAULT_OUTPUT_DIR));
  const rel = (value) => relativePortable(process.cwd(), value);

  return {
    ok: true,
    approval_required: true,
    no_writes_performed: true,
    explanation: buildExplanation(),
    target: {
      project_root: rel(root),
      output_dir: rel(resolvedOutput),
    },
    proposed_local_actions: [
      'Create or reuse .micro-ecf/policy.json with local-only context/tool/budget/approval/memory/swarm boundaries.',
      'Create or reuse AGENTS.md with Micro ECF local safety rules for IDE agents that auto-load repo instructions.',
      'Create or reuse MICRO_ECF_LLM_BOOTSTRAP.md as the drag/paste handoff for any new LLM chat that does not auto-load repo instructions.',
      'Index allowed local text/code/docs/database-summary files into .micro-ecf/source-map.json.',
      'Block .env, credentials, private keys, wallet seeds, secret-looking paths, node_modules, .git internals, large binaries, and unsupported files.',
      'Generate .micro-ecf/context-packet.json, .micro-ecf/policy-summary.json, and .micro-ecf/deployment-preview.json.',
      'Export .micro-ecf/harness-export.json for Agent OS preview.',
    ],
    files_that_may_be_created_or_updated: [
      rel(path.join(root, 'AGENTS.md')),
      rel(path.join(root, 'MICRO_ECF_LLM_BOOTSTRAP.md')),
      rel(path.join(resolvedOutput, 'policy.json')),
      rel(path.join(resolvedOutput, 'source-map.json')),
      rel(path.join(resolvedOutput, 'context-packet.json')),
      rel(path.join(resolvedOutput, 'policy-summary.json')),
      rel(path.join(resolvedOutput, 'deployment-preview.json')),
      rel(path.join(resolvedOutput, 'harness-export.json')),
    ],
    will_not_do: [
      'No cloud deployment.',
      'No hosted billing.',
      'No marketplace publication.',
      'No wallet or x402 settlement.',
      'No provider ranking.',
      'No trust/fraud scoring internals.',
      'No Full ECF private runtime or enterprise governance internals.',
      'No raw secret export.',
    ],
    approval_command: `micro-ecf install --dir ${quoteForShell(root)} --yes${force ? ' --force' : ''}`,
  };
}

export function installProject({
  targetDir = process.cwd(),
  outputDir = null,
  force = false,
  approved = false,
  maxFiles,
  maxFileBytes,
  baseUrl = DEFAULT_BASE_URL,
} = {}) {
  const plan = buildInstallPlan({ targetDir, outputDir, force });
  if (!approved) {
    return {
      ok: false,
      requires_approval: true,
      message: 'Micro ECF did not install because approval is required. Review the plan, then rerun with --yes if you approve these local writes.',
      plan,
    };
  }

  const root = path.resolve(targetDir);
  const resolvedOutput = path.resolve(outputDir || path.join(root, DEFAULT_OUTPUT_DIR));
  initProject({ targetDir: root, force });

  const policyPath = path.join(resolvedOutput, 'policy.json');
  const sourceMap = indexSources(root, { policyPath, maxFiles, maxFileBytes });
  const sourceMapPath = writeJson(path.join(resolvedOutput, 'source-map.json'), sourceMap);
  const built = buildArtifacts({
    policyPath,
    sourceMapPath,
    outputDir: resolvedOutput,
  });
  const harnessOutput = path.join(resolvedOutput, 'harness-export.json');
  exportAgentOsHarness({
    policyPath,
    outputPath: harnessOutput,
    baseUrl,
    artifactRefs: {
      context_packet: `${DEFAULT_OUTPUT_DIR}/context-packet.json`,
      policy_summary: `${DEFAULT_OUTPUT_DIR}/policy-summary.json`,
      source_map: `${DEFAULT_OUTPUT_DIR}/source-map.json`,
      deployment_preview: `${DEFAULT_OUTPUT_DIR}/deployment-preview.json`,
    },
  });

  return {
    ok: true,
    approved: true,
    plan,
    outputs: {
      ...built.outputs,
      harness_export: relativePortable(process.cwd(), harnessOutput),
    },
    stats: {
      sources: sourceMap.sources.length,
      blocked: sourceMap.blocked.length,
    },
    next_step: `npx agoragentic-os preview ${relativePortable(process.cwd(), harnessOutput)}`,
  };
}

function writeIfAllowed(filePath, value, force) {
  if (fs.existsSync(filePath) && !force) {
    return;
  }
  writeJson(filePath, value);
}

function writeTextIfAllowed(filePath, value, force) {
  if (fs.existsSync(filePath) && !force) {
    return;
  }
  fs.writeFileSync(filePath, value);
}

function buildAgentsMd(projectName) {
  return `# ${projectName} Agent Boundary

This project uses Micro ECF as a local context and policy boundary before Agent OS preview.

## New Conversation Rule

At the start of any non-trivial IDE-agent conversation, check whether .micro-ecf artifacts exist.
If they exist, read .micro-ecf/policy-summary.json, .micro-ecf/context-packet.json, and .micro-ecf/source-map.json before broad codebase exploration.
Tell the developer whether you are using Micro ECF artifacts, direct repo reads, or both.
If this assistant cannot auto-load repo instructions, ask the developer to paste or attach MICRO_ECF_LLM_BOOTSTRAP.md.

## Local Rules

- Do not read or export .env files, private keys, wallet seeds, raw credentials, or customer-private folders.
- Use .micro-ecf/context-packet.json for citation-ready local context summaries.
- Use .micro-ecf/policy-summary.json for allowed tools, blocked sources, approvals, and budget limits.
- Use .micro-ecf/harness-export.json only for Agent OS preview; it does not deploy, spend, publish, or provision anything.

## Product Boundary

Micro ECF is local-first and open-source. Agent OS handles hosted runtime, wallet budgets, receipts, marketplace access, and governed deployment. Full ECF remains the private enterprise runtime and is not included here.
`;
}

function buildLlmBootstrapMd(projectName) {
  return `# Micro ECF LLM Bootstrap - ${projectName}

Use this file at the start of any new LLM conversation when the assistant does not automatically read repo-level instructions.

## What Micro ECF Is

Micro ECF is a local-first context and policy layer for safer agents. It indexes allowed local repo/docs/database-summary sources, blocks secret-like paths by default, builds citation-ready context packets, and exports Agent OS Harness files for deployment preview.

Micro ECF is not Full ECF. It does not include private enterprise runtime internals, tenant isolation runtime, hosted provisioning, router ranking, wallet settlement, x402 settlement, trust/fraud internals, private connectors, or operator prompts.

## New Chat Startup Checklist

1. Check whether .micro-ecf/ exists.
2. If present, read .micro-ecf/policy-summary.json first to understand allowed tools, blocked sources, budget limits, approvals, memory, and swarm rules.
3. Read .micro-ecf/context-packet.json for citation-ready context summaries and source IDs.
4. Read .micro-ecf/source-map.json before using broad search so source paths, blocked paths, hashes, and provenance are visible.
5. Use direct repo/file reads as the source of truth when implementing code. Micro ECF guides what to inspect; it does not replace source verification.
6. Tell the developer exactly whether you are using Micro ECF artifacts, direct repo reads, a configured Micro ECF MCP server, or none of them.

## If Micro ECF Is Missing Or Stale

Do not silently install or refresh it. First run a read-only plan and show it to the developer:

\`\`\`bash
micro-ecf plan --dir .
\`\`\`

Only after explicit approval, run:

\`\`\`bash
micro-ecf install --dir . --yes
\`\`\`

If artifacts already exist but need refresh, ask before running index/build/export commands.

## Expected Assistant Disclosure

When asked "are you using Micro ECF?", answer in one of these forms:

- Yes: I read .micro-ecf/policy-summary.json, .micro-ecf/context-packet.json, and .micro-ecf/source-map.json in this conversation.
- Partially: I can see the Micro ECF files, but I am also using direct repo reads for source-of-truth verification.
- No: I have not read the Micro ECF artifacts or used a Micro ECF MCP server in this conversation.

## Useful Files

- AGENTS.md: persistent repo instructions for IDE agents that auto-load repo guidance.
- MICRO_ECF_LLM_BOOTSTRAP.md: paste or attach this file into any new chat that does not auto-load repo guidance.
- .micro-ecf/policy.json: editable local policy source.
- .micro-ecf/policy-summary.json: readable policy summary for LLMs.
- .micro-ecf/context-packet.json: citation-ready local context packet.
- .micro-ecf/source-map.json: source inventory, hashes, blocked paths, and provenance.
- .micro-ecf/harness-export.json: no-spend Agent OS preview packet.

## Hard Limits

- Do not read or export .env files, private keys, wallet seeds, raw credentials, or customer-private folders.
- Do not claim live ECF/RAG/runtime usage unless a Micro ECF MCP server or ECF/RAG endpoint is actually configured and used in this conversation.
- Do not deploy, spend, publish, provision, settle x402, or call hosted providers from Micro ECF.
`;
}

export function indexSources(inputPath, options = {}) {
  const root = path.resolve(inputPath || process.cwd());
  const policy = options.policyPath && fs.existsSync(options.policyPath)
    ? readPolicy(options.policyPath).policy
    : null;
  const maxFiles = Number(options.maxFiles || 500);
  const maxFileBytes = Number(options.maxFileBytes || 200_000);
  const now = new Date().toISOString();
  const sources = [];
  const blocked = [];

  walk(root, (filePath) => {
    const rel = relativePortable(root, filePath);
    const blockReason = getBlockReason(rel, policy);
    if (blockReason) {
      blocked.push({ path: rel, reason: blockReason });
      return;
    }

    const ext = path.extname(filePath).toLowerCase();
    if (!TEXT_EXTENSIONS.has(ext) && !SQLITE_EXTENSIONS.has(ext)) {
      blocked.push({ path: rel, reason: 'unsupported_or_binary_file' });
      return;
    }

    if (sources.length >= maxFiles) {
      blocked.push({ path: rel, reason: 'max_files_limit_reached' });
      return;
    }

    const stat = fs.statSync(filePath);
    if (stat.size > maxFileBytes && !SQLITE_EXTENSIONS.has(ext)) {
      blocked.push({ path: rel, reason: 'max_file_bytes_exceeded' });
      return;
    }

    const buffer = fs.readFileSync(filePath);
    const sha = sha256(buffer);
    sources.push({
      id: `src_${sha.slice(0, 12)}`,
      path: rel,
      type: classifySource(filePath),
      bytes: stat.size,
      hash: `sha256:${sha}`,
      summary: SQLITE_EXTENSIONS.has(ext)
        ? 'Local database file detected. Micro ECF records file provenance only; export schema/data summaries separately before Agent OS preview.'
        : summarizeText(buffer.toString('utf8'), ext),
      citation_id: `cite_${sources.length + 1}`,
      provenance: {
        local_only: true,
        raw_content_exported: false,
        indexed_at: now,
      },
    });
  });

  const sourceMap = {
    schema: 'agoragentic.micro-ecf.source-map.v1',
    generated_at: now,
    root: {
      label: path.basename(root),
      path: '.',
    },
    limits: {
      max_files: maxFiles,
      max_file_bytes: maxFileBytes,
      raw_content_exported: false,
    },
    sources,
    blocked,
    stats: {
      included_sources: sources.length,
      blocked_paths: blocked.length,
    },
  };

  return sourceMap;
}

function walk(root, visit) {
  if (!fs.existsSync(root)) {
    throw new Error(`Path does not exist: ${root}`);
  }
  const stat = fs.statSync(root);
  if (stat.isFile()) {
    visit(root);
    return;
  }
  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    const fullPath = path.join(root, entry.name);
    if (entry.isDirectory()) {
      if (DEFAULT_BLOCK_DIRS.has(entry.name)) {
        continue;
      }
      walk(fullPath, visit);
    } else if (entry.isFile()) {
      visit(fullPath);
    }
  }
}

function getBlockReason(relPath, policy) {
  const normalized = relPath.replace(/\\/g, '/');
  const lower = normalized.toLowerCase();
  const base = path.posix.basename(lower);
  const segments = lower.split('/');

  if (segments.some((segment) => DEFAULT_BLOCK_DIRS.has(segment))) return 'default_blocked_directory';
  if (DEFAULT_BLOCK_BASENAMES.has(base)) return 'default_blocked_secret_file';
  if (DEFAULT_BLOCK_SUFFIXES.some((suffix) => lower.endsWith(suffix))) return 'default_blocked_sensitive_suffix';
  if (DEFAULT_BLOCK_SUBSTRINGS.some((term) => lower.includes(term))) return 'default_blocked_sensitive_name';

  const localBlock = asList(policy?.context_policy?.local_block || policy?.context_policy?.block);
  if (localBlock.some((pattern) => matchesPattern(normalized, pattern))) return 'policy_blocked_path';

  const localAllow = asList(policy?.context_policy?.local_allow || policy?.context_policy?.allow);
  if (localAllow.length > 0 && !localAllow.some((pattern) => matchesPattern(normalized, pattern))) {
    return 'not_in_policy_allowlist';
  }

  return null;
}

function matchesPattern(relPath, pattern) {
  const normalizedPattern = String(pattern || '').replace(/\\/g, '/');
  if (!normalizedPattern) return false;
  if (normalizedPattern.endsWith('/**')) {
    const prefix = normalizedPattern.slice(0, -3);
    return relPath === prefix || relPath.startsWith(`${prefix}/`);
  }
  if (!normalizedPattern.includes('*')) {
    return relPath === normalizedPattern || relPath.endsWith(`/${normalizedPattern}`);
  }
  const escaped = normalizedPattern
    .replace(/[.+^${}()|[\]\\]/g, '\\$&')
    .replace(/\*\*/g, '<<DOUBLE_STAR>>')
    .replace(/\*/g, '[^/]*');
  return new RegExp(`^${escaped.replace(/<<DOUBLE_STAR>>/g, '.*')}$`).test(relPath);
}

function classifySource(filePath) {
  const ext = path.extname(filePath).toLowerCase();
  if (['.md', '.mdx'].includes(ext)) return 'markdown';
  if (['.json'].includes(ext)) return 'json';
  if (['.yaml', '.yml'].includes(ext)) return 'yaml';
  if (['.sql'].includes(ext)) return 'sql';
  if (SQLITE_EXTENSIONS.has(ext)) return 'sqlite';
  if (['.txt', '.csv'].includes(ext)) return 'text';
  return 'code';
}

function summarizeText(text, ext) {
  const clean = text
    .replace(/\r\n/g, '\n')
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .slice(0, 12)
    .join(' ')
    .replace(/\s+/g, ' ')
    .slice(0, 420);

  if (ext === '.json') {
    try {
      const parsed = JSON.parse(text);
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        return `JSON object with keys: ${Object.keys(parsed).slice(0, 12).join(', ')}`;
      }
    } catch {
      return clean || 'JSON-like text could not be parsed deterministically.';
    }
  }

  return clean || 'Text source with no non-empty preview lines.';
}

export function buildPolicySummary(policy) {
  validatePolicy(policy);
  return {
    schema: 'agoragentic.micro-ecf.policy-summary.v1',
    generated_at: new Date().toISOString(),
    product_boundary: {
      micro_ecf: 'local_context_wedge',
      agent_os: 'deployment_product',
      full_ecf: 'private_enterprise_runtime_engine',
      local_only: true,
      no_spend: true,
      no_hosted_provisioning: true,
      no_marketplace_publication: true,
    },
    agent: {
      name: policy.agent_manifest.name,
      primary_goal: policy.agent_manifest.primary_goal,
      runtime_shape: policy.agent_manifest.runtime_shape || 'self_hosted_http',
    },
    allowed_context: asList(policy.context_policy.allowed_sources),
    blocked_context: [
      ...asList(policy.context_policy.denied_sources),
      '.env',
      'private_keys',
      'wallet_seeds',
      'raw_credentials',
      'node_modules',
      '.git internals',
    ],
    allowed_tools: asList(policy.tool_policy.allowed_tools),
    denied_tools: asList(policy.tool_policy.denied_tools),
    budget: {
      max_daily_spend_usdc: Number(policy.budget_policy.max_daily_spend_usdc || 0),
      approval_required_above_usdc: Number(policy.budget_policy.approval_required_above_usdc || 0),
      recommended_start_reserve_usdc: Number(policy.budget_policy.recommended_start_reserve_usdc || 0),
      treasury_required: policy.budget_policy.treasury_required === true,
    },
    approvals: policy.approval_policy,
    memory: policy.memory_policy,
    swarm: policy.swarm_policy,
  };
}

export function buildContextPacket(policy, sourceMap) {
  validatePolicy(policy);
  const sources = asList(sourceMap.sources);
  const seed = `${policy.agent_manifest.name}:${sources.map((source) => source.hash).join('|')}`;
  return {
    schema: 'agoragentic.micro-ecf.context-packet.v1',
    packet_id: `ctx_${sha256(seed).slice(0, 16)}`,
    created_at: new Date().toISOString(),
    scope: 'local_project',
    agent: {
      name: policy.agent_manifest.name,
      primary_goal: policy.agent_manifest.primary_goal,
    },
    sources: sources.map((source) => ({
      id: source.id,
      path: source.path,
      type: source.type,
      hash: source.hash,
      summary: source.summary,
      citation_id: source.citation_id,
      provenance: source.provenance,
    })),
    allowed_context: asList(policy.context_policy.allowed_sources),
    blocked_context: asList(policy.context_policy.denied_sources),
    citations: sources.map((source) => ({
      citation_id: source.citation_id,
      source_id: source.id,
      path: source.path,
      hash: source.hash,
      heading: null,
      section_path: [source.path],
      provenance: source.provenance,
    })),
    export_boundary: {
      raw_content_exported: false,
      local_first: true,
      agent_os_preview_only: true,
    },
  };
}

export function buildDeploymentPreview(policy, artifactRefs = {}) {
  validatePolicy(policy);
  const deploymentPolicy = policy.deployment_policy || {};
  const budgetPolicy = policy.budget_policy || {};
  return {
    schema: 'agoragentic.micro-ecf.deployment-preview.v1',
    generated_at: new Date().toISOString(),
    agent_name: policy.agent_manifest.name,
    target: {
      agent_os_preview_endpoint: 'POST /api/hosting/agent-os/preview',
      runtime_lane: 'preview',
      hosting_target: deploymentPolicy.hosting_target || 'self_hosted_http',
      exposure_mode: deploymentPolicy.exposure_mode || 'private_only',
    },
    marketplace_policy: {
      can_buy: false,
      can_sell: false,
      x402_enabled: false,
      reason: 'Micro ECF export is no-spend and non-provisioning until Agent OS preview and owner approval.',
    },
    api_policy: {
      public_api_enabled: false,
      internal_api_enabled: false,
    },
    budget_policy: {
      max_daily_spend_usdc: Number(budgetPolicy.max_daily_spend_usdc || 0),
      approval_required_above_usdc: Number(budgetPolicy.approval_required_above_usdc || 0),
    },
    artifacts: artifactRefs,
  };
}

export function buildArtifacts({ policyPath, sourceMapPath, outputDir = DEFAULT_OUTPUT_DIR } = {}) {
  const resolvedOutput = path.resolve(outputDir);
  const resolvedPolicy = path.resolve(policyPath || path.join(resolvedOutput, 'policy.json'));
  const { policy } = readPolicy(resolvedPolicy);
  const resolvedSourceMap = path.resolve(sourceMapPath || path.join(resolvedOutput, 'source-map.json'));
  const sourceMap = fs.existsSync(resolvedSourceMap)
    ? readJson(resolvedSourceMap)
    : indexSources(defaultIndexRoot(resolvedOutput), { policyPath: resolvedPolicy });

  fs.mkdirSync(resolvedOutput, { recursive: true });
  writeJson(resolvedSourceMap, sourceMap);

  const artifactRefs = {
    context_packet: `${DEFAULT_OUTPUT_DIR}/context-packet.json`,
    policy_summary: `${DEFAULT_OUTPUT_DIR}/policy-summary.json`,
    source_map: `${DEFAULT_OUTPUT_DIR}/source-map.json`,
    deployment_preview: `${DEFAULT_OUTPUT_DIR}/deployment-preview.json`,
  };

  const contextPacket = buildContextPacket(policy, sourceMap);
  const policySummary = buildPolicySummary(policy);
  const deploymentPreview = buildDeploymentPreview(policy, artifactRefs);

  const outputs = {
    context_packet: writeJson(path.join(resolvedOutput, 'context-packet.json'), contextPacket),
    policy_summary: writeJson(path.join(resolvedOutput, 'policy-summary.json'), policySummary),
    source_map: resolvedSourceMap,
    deployment_preview: writeJson(path.join(resolvedOutput, 'deployment-preview.json'), deploymentPreview),
  };

  return {
    ok: true,
    outputs: portableOutputMap(outputs),
    stats: {
      sources: sourceMap.sources.length,
      blocked: sourceMap.blocked.length,
    },
  };
}

function defaultIndexRoot(outputDir) {
  return path.basename(outputDir) === DEFAULT_OUTPUT_DIR
    ? path.dirname(outputDir)
    : process.cwd();
}

export function buildHarnessPacket(policy, {
  baseUrl = DEFAULT_BASE_URL,
  policyPath = '',
  artifactRefs = {},
} = {}) {
  validatePolicy(policy);
  const deploymentPolicy = policy.deployment_policy || {};
  const budgetPolicy = policy.budget_policy || {};
  const agent = policy.agent_manifest || {};
  const source = deploymentPolicy.source || {};
  const hostingTarget = deploymentPolicy.hosting_target || 'self_hosted_http';
  const normalizedBaseUrl = baseUrl.replace(/\/$/, '');

  return {
    schema: 'agoragentic.agent-os.harness.v1',
    generated_at: new Date().toISOString(),
    generated_from: {
      source: 'micro-ecf',
      policy_path: policyPath,
      canonical_contract: `${normalizedBaseUrl}/agent-os-harness.json`,
    },
    schema_artifacts: {
      agent_os_harness: `${normalizedBaseUrl}/schema/agent-os-harness.v1.json`,
      micro_ecf_policy: `${normalizedBaseUrl}/schema/micro-ecf-policy.v1.json`,
      local_agent_os_harness: 'micro-ecf/schema/agent-os-harness.v1.json',
      local_micro_ecf_policy: 'micro-ecf/schema/micro-ecf-policy.v1.json',
      local_context_packet: 'micro-ecf/schema/context-packet.schema.json',
      local_policy_summary: 'micro-ecf/schema/policy-summary.schema.json',
      local_source_map: 'micro-ecf/schema/source-map.schema.json',
      local_deployment_preview: 'micro-ecf/schema/deployment-preview.schema.json',
    },
    agent_manifest: agent,
    context_policy: policy.context_policy,
    tool_policy: policy.tool_policy,
    budget_policy: budgetPolicy,
    approval_policy: policy.approval_policy,
    memory_policy: policy.memory_policy,
    swarm_policy: policy.swarm_policy,
    deployment_policy: deploymentPolicy,
    micro_ecf_artifacts: {
      context_packet: artifactRefs.context_packet || `${DEFAULT_OUTPUT_DIR}/context-packet.json`,
      policy_summary: artifactRefs.policy_summary || `${DEFAULT_OUTPUT_DIR}/policy-summary.json`,
      source_map: artifactRefs.source_map || `${DEFAULT_OUTPUT_DIR}/source-map.json`,
      deployment_preview: artifactRefs.deployment_preview || `${DEFAULT_OUTPUT_DIR}/deployment-preview.json`,
    },
    public_boundary: {
      micro_ecf_role: 'local_context_wedge',
      agent_os_role: 'deployment_product',
      full_ecf_role: 'private_enterprise_runtime_engine',
      no_spend_export: true,
      hosted_billing: false,
      cloud_provisioning: false,
      marketplace_publication: false,
      hosted_runtime_secrets: false,
      full_ecf_runtime_included: false,
      router_ranking_included: false,
      settlement_internals_included: false,
      enterprise_governance_internals_included: false,
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
        artifact_refs: {
          context_packet: artifactRefs.context_packet || `${DEFAULT_OUTPUT_DIR}/context-packet.json`,
          policy_summary: artifactRefs.policy_summary || `${DEFAULT_OUTPUT_DIR}/policy-summary.json`,
          source_map: artifactRefs.source_map || `${DEFAULT_OUTPUT_DIR}/source-map.json`,
          deployment_preview: artifactRefs.deployment_preview || `${DEFAULT_OUTPUT_DIR}/deployment-preview.json`,
        },
      },
    },
  };
}

export function exportAgentOsHarness({
  policyPath,
  outputPath,
  baseUrl = DEFAULT_BASE_URL,
  artifactRefs = {},
} = {}) {
  const { policy, resolved } = readPolicy(policyPath);
  const packet = buildHarnessPacket(policy, {
    baseUrl,
    policyPath: relativePortable(process.cwd(), resolved),
    artifactRefs,
  });
  const resolvedOutput = outputPath ? writeJson(outputPath, packet) : null;
  return { packet, output: resolvedOutput };
}

export function searchSourceMap(sourceMap, query, limit = 10) {
  const q = String(query || '').toLowerCase().trim();
  const results = asList(sourceMap.sources)
    .map((source) => {
      const haystack = `${source.path} ${source.type} ${source.summary}`.toLowerCase();
      const score = q && haystack.includes(q) ? 1 : 0;
      return { ...source, score };
    })
    .filter((source) => !q || source.score > 0)
    .slice(0, limit);
  return { query: q, results };
}

function asList(value) {
  return Array.isArray(value) ? value : [];
}

function sha256(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function portablePath(value) {
  return path.resolve(value).replace(/\\/g, '/');
}

function relativePortable(from, to) {
  return path.relative(from, to).replace(/\\/g, '/') || '.';
}

function quoteForShell(value) {
  const portable = portablePath(value);
  return portable.includes(' ') ? `"${portable}"` : portable;
}

function portableOutputMap(outputs) {
  return Object.fromEntries(
    Object.entries(outputs).map(([key, value]) => [key, relativePortable(process.cwd(), value)]),
  );
}
