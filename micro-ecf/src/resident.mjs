import fs from 'node:fs';
import path from 'node:path';

import {
  DEFAULT_OUTPUT_DIR,
  doctorProject,
  readJson,
  writeJson,
} from './core.mjs';

export const RESIDENT_STATUS_FILE = 'resident-status.json';
export const CONTEXT_PACK_FILE = 'context-pack.json';

function portablePath(filePath) {
  return filePath.replace(/\\/g, '/');
}

function relativePortable(from, to) {
  const relative = path.relative(from, to) || '.';
  return portablePath(relative);
}

function resolveWorkspace({ targetDir = process.cwd(), outputDir = null } = {}) {
  const root = path.resolve(targetDir);
  const resolvedOutput = path.resolve(outputDir || path.join(root, DEFAULT_OUTPUT_DIR));
  return { root, outputDir: resolvedOutput };
}

function readJsonIfPresent(filePath) {
  if (!fs.existsSync(filePath)) return null;
  try {
    return readJson(filePath);
  } catch (error) {
    return {
      parse_error: error.message,
    };
  }
}

function artifactStatus(root, outputDir, fileName) {
  const filePath = path.join(outputDir, fileName);
  const exists = fs.existsSync(filePath);
  let parsed = null;
  if (exists) parsed = readJsonIfPresent(filePath);
  return {
    name: fileName,
    exists,
    path: relativePortable(root, filePath),
    schema: parsed?.schema || parsed?.schema_version || null,
    parse_error: parsed?.parse_error || null,
  };
}

function standardArtifacts(root, outputDir) {
  return [
    artifactStatus(root, outputDir, 'policy.json'),
    artifactStatus(root, outputDir, 'source-map.json'),
    artifactStatus(root, outputDir, 'context-packet.json'),
    artifactStatus(root, outputDir, 'policy-summary.json'),
    artifactStatus(root, outputDir, 'deployment-preview.json'),
    artifactStatus(root, outputDir, 'harness-export.json'),
  ];
}

function authorityBoundary() {
  return {
    local_only: true,
    no_cloud_call: true,
    no_deploy: true,
    no_spend: true,
    no_wallet_mutation: true,
    no_x402_settlement: true,
    no_marketplace_publication: true,
    no_provider_ranking: true,
    full_ecf_private_internals_included: false,
    raw_secret_content_included: false,
  };
}

function sourceCounts(sourceMap) {
  const sources = Array.isArray(sourceMap?.sources) ? sourceMap.sources : [];
  const blocked = Array.isArray(sourceMap?.blocked) ? sourceMap.blocked : [];
  return {
    included_sources: sourceMap?.stats?.included_sources ?? sources.length,
    blocked_paths: sourceMap?.stats?.blocked_paths ?? blocked.length,
    allowed_roots: sourceMap?.policy?.allowed_roots || [],
  };
}

function policySummary(policySummaryArtifact) {
  if (!policySummaryArtifact || policySummaryArtifact.parse_error) return null;
  return {
    agent: policySummaryArtifact.agent?.name || policySummaryArtifact.agent_name || null,
    primary_goal: policySummaryArtifact.agent?.primary_goal || policySummaryArtifact.primary_goal || null,
    allowed_tools: policySummaryArtifact.allowed_tools || [],
    blocked_tools: policySummaryArtifact.blocked_tools || [],
    public_api_enabled: policySummaryArtifact.api_policy?.public_api_enabled === true,
    marketplace_can_buy: policySummaryArtifact.marketplace_policy?.can_buy === true,
    marketplace_can_sell: policySummaryArtifact.marketplace_policy?.can_sell === true,
  };
}

export function buildMicroEcfResidentStatus(options = {}) {
  const { root, outputDir } = resolveWorkspace(options);
  const doctor = doctorProject({ targetDir: root, outputDir });
  const artifacts = standardArtifacts(root, outputDir);
  const missing = artifacts.filter((artifact) => !artifact.exists).map((artifact) => artifact.name);
  const ready = doctor.ok === true;

  return {
    schema: 'agoragentic.micro-ecf.resident-status.v1',
    ok: ready,
    resident_state: ready ? 'ready' : 'attention_required',
    generated_at: new Date().toISOString(),
    workspace_root: relativePortable(process.cwd(), root),
    output_dir: relativePortable(process.cwd(), outputDir),
    checks: doctor.checks,
    missing_artifacts: missing,
    artifacts,
    codex_context: {
      repo_instructions_present: fs.existsSync(path.join(root, 'AGENTS.md')),
      ecf_md_present: fs.existsSync(path.join(root, 'ECF.md')),
      llm_bootstrap_present: fs.existsSync(path.join(root, 'MICRO_ECF_LLM_BOOTSTRAP.md')),
      disclosure_required: true,
    },
    mcp: {
      available: true,
      command: `micro-ecf serve-mcp --root ${relativePortable(root, outputDir)}`,
      tools: [
        'micro_ecf.search_context',
        'micro_ecf.get_source',
        'micro_ecf.get_policy',
        'micro_ecf.build_packet',
        'micro_ecf.context_pack',
        'micro_ecf.status',
      ],
    },
    context_pack: {
      available: missing.includes('context-packet.json') === false
        && missing.includes('policy-summary.json') === false
        && missing.includes('source-map.json') === false,
      command: `micro-ecf context-pack --dir ${relativePortable(process.cwd(), root)} --write`,
    },
    authority_boundary: authorityBoundary(),
    next_steps: doctor.next_steps,
  };
}

export function writeMicroEcfResidentStatus(options = {}) {
  const { outputDir } = resolveWorkspace(options);
  const status = buildMicroEcfResidentStatus(options);
  const outputPath = writeJson(path.join(outputDir, RESIDENT_STATUS_FILE), status);
  return {
    ...status,
    status_path: relativePortable(process.cwd(), outputPath),
  };
}

export function buildMicroEcfContextPack(options = {}) {
  const { root, outputDir } = resolveWorkspace(options);
  const task = String(options.task || '').trim() || 'current_codex_session';
  const status = buildMicroEcfResidentStatus({ targetDir: root, outputDir });
  const sourceMap = readJsonIfPresent(path.join(outputDir, 'source-map.json'));
  const contextPacket = readJsonIfPresent(path.join(outputDir, 'context-packet.json'));
  const policySummaryArtifact = readJsonIfPresent(path.join(outputDir, 'policy-summary.json'));
  const deploymentPreview = readJsonIfPresent(path.join(outputDir, 'deployment-preview.json'));

  return {
    schema: 'agoragentic.micro-ecf.context-pack.v1',
    ok: status.ok,
    task,
    generated_at: new Date().toISOString(),
    workspace_root: relativePortable(process.cwd(), root),
    output_dir: relativePortable(process.cwd(), outputDir),
    status_ref: relativePortable(root, path.join(outputDir, RESIDENT_STATUS_FILE)),
    artifacts: {
      source_map: relativePortable(root, path.join(outputDir, 'source-map.json')),
      context_packet: relativePortable(root, path.join(outputDir, 'context-packet.json')),
      policy_summary: relativePortable(root, path.join(outputDir, 'policy-summary.json')),
      deployment_preview: relativePortable(root, path.join(outputDir, 'deployment-preview.json')),
      harness_export: relativePortable(root, path.join(outputDir, 'harness-export.json')),
    },
    summary: {
      source_counts: sourceCounts(sourceMap),
      citation_count: Array.isArray(contextPacket?.citations) ? contextPacket.citations.length : 0,
      policy: policySummary(policySummaryArtifact),
      deployment_preview_state: deploymentPreview?.readiness?.status || deploymentPreview?.status || null,
      missing_artifacts: status.missing_artifacts,
    },
    assistant_bootstrap: {
      read_order: [
        'AGENTS.md',
        'ECF.md',
        'MICRO_ECF_LLM_BOOTSTRAP.md',
        '.micro-ecf/context-packet.json',
        '.micro-ecf/policy-summary.json',
      ],
      disclosure: 'Micro ECF resident context is local-only and must be refreshed from local artifacts; it is not hidden global memory.',
      refresh_commands: [
        'micro-ecf doctor --dir .',
        'micro-ecf build-packet --output-dir .micro-ecf',
        'micro-ecf status --dir . --write',
        'micro-ecf context-pack --dir . --write',
      ],
    },
    authority_boundary: authorityBoundary(),
  };
}

export function writeMicroEcfContextPack(options = {}) {
  const { outputDir } = resolveWorkspace(options);
  const pack = buildMicroEcfContextPack(options);
  const outputPath = writeJson(path.join(outputDir, CONTEXT_PACK_FILE), pack);
  return {
    ...pack,
    context_pack_path: relativePortable(process.cwd(), outputPath),
  };
}
