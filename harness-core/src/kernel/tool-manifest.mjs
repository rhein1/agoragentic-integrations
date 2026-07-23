import { promises as fs } from 'node:fs';
import path from 'node:path';
import { authorityBoundary, sanitizeForPublicEvidence } from './events.mjs';
import { harnessDir, readJsonIfExists } from './state.mjs';

export const TOOL_MANIFEST_SCHEMA = 'agoragentic.harness.tool-manifest.v1';

const TOOL_EXECUTION_POLICY = Object.freeze({
  tool_execution_allowed: false,
  framework_execution_called: false,
  router_execute_called: false,
  global_invoke_called: false,
  shell_called: false,
  wallet_spend_called: false,
  x402_called: false,
  marketplace_publication_called: false,
  hosted_memory_write_called: false,
  provider_dispatch_called: false,
});

const AUTHORITY_FLAGS = Object.freeze([
  'framework_execution',
  'router_execute',
  'global_invoke',
  'shell',
  'wallet_spend',
  'wallet_mutation',
  'x402_settlement',
  'x402_route_activation',
  'marketplace_publication',
  'hosted_runtime_provisioning',
  'provider_dispatch',
  'trust_mutation',
  'hosted_memory_write',
  'public_execute_mutation',
  'public_invoke_mutation',
]);

const DEFAULT_TOOLS = Object.freeze([
  Object.freeze({
    id: 'runtime.health',
    kind: 'http_get',
    side_effect_class: 'none',
    approval_required: false,
    blocked_in_local_no_spend: false,
    evidence_refs: [
      Object.freeze({ id: 'runtime_health_probe', ref: 'runtime probe /health metadata', kind: 'metadata_ref' }),
    ],
  }),
  Object.freeze({
    id: 'runtime.tools',
    kind: 'http_get',
    side_effect_class: 'none',
    approval_required: false,
    blocked_in_local_no_spend: false,
    evidence_refs: [
      Object.freeze({ id: 'runtime_tools_probe', ref: 'runtime probe /tools metadata', kind: 'metadata_ref' }),
    ],
  }),
  Object.freeze({
    id: 'agent_os.preview_submit',
    kind: 'agent_os_api',
    side_effect_class: 'preview_submission',
    approval_required: true,
    blocked_in_local_no_spend: true,
    authority_flags: { public_execute_mutation: false, hosted_runtime_provisioning: false },
    evidence_refs: [
      Object.freeze({ id: 'agent_os_export', ref: '.agoragentic/agent-os-harness.json', kind: 'artifact_ref' }),
      Object.freeze({ id: 'review_gate', ref: '.agoragentic/review-gates.json', kind: 'artifact_ref' }),
    ],
  }),
  Object.freeze({
    id: 'marketplace.publish_listing',
    kind: 'agent_os_api',
    side_effect_class: 'publication',
    approval_required: true,
    blocked_in_local_no_spend: true,
    authority_flags: { marketplace_publication: true },
    evidence_refs: [
      Object.freeze({ id: 'listing_readiness', ref: '.agoragentic/listing-readiness.json', kind: 'artifact_ref' }),
      Object.freeze({ id: 'review_gate', ref: '.agoragentic/review-gates.json', kind: 'artifact_ref' }),
    ],
  }),
  Object.freeze({
    id: 'x402.activate_route',
    kind: 'agent_os_api',
    side_effect_class: 'paid_edge_activation',
    approval_required: true,
    blocked_in_local_no_spend: true,
    authority_flags: { x402_route_activation: true, x402_settlement: true },
    evidence_refs: [
      Object.freeze({ id: 'paid_canary_receipt', ref: 'owner-provided paid canary receipt ref', kind: 'external_ref' }),
      Object.freeze({ id: 'review_gate', ref: '.agoragentic/review-gates.json', kind: 'artifact_ref' }),
    ],
  }),
]);

export async function initToolManifest({ dir = process.cwd() } = {}) {
  const existing = await readToolManifest(dir);
  if (existing) return { artifact: existing, path: toolManifestRelativePath(), created: false };

  const createdAt = new Date().toISOString();
  const tools = DEFAULT_TOOLS.map(normalizeToolRecord);
  const artifact = {
    schema: TOOL_MANIFEST_SCHEMA,
    created_at: createdAt,
    updated_at: createdAt,
    mode: 'local_tool_manifest_no_execution',
    tools,
    summary: summarizeTools(tools),
    execution_policy: { ...TOOL_EXECUTION_POLICY },
    action_executed: false,
    authority_boundary: toolManifestAuthorityBoundary(),
  };
  await writeToolManifest(dir, artifact);
  return { artifact, path: toolManifestRelativePath(), created: true };
}

export async function listTools(dir = process.cwd()) {
  const artifact = await readToolManifest(dir);
  if (!artifact) return toolManifestStatusFromArtifact(null);
  return toolManifestStatusFromArtifact(artifact);
}

export async function inspectTool({ dir = process.cwd(), tool_id } = {}) {
  if (!tool_id) throw new Error('tools inspect requires a tool_id');
  const artifact = await readToolManifest(dir);
  if (!artifact) throw new Error('tool manifest is not initialized');
  const tool = (artifact.tools || []).find((entry) => entry.id === tool_id);
  if (!tool) throw new Error(`tool not found: ${tool_id}`);
  return {
    present: true,
    path: toolManifestRelativePath(),
    tool,
    blocked_high_authority: isBlockedHighAuthorityTool(tool),
    execution_policy: artifact.execution_policy || { ...TOOL_EXECUTION_POLICY },
    action_executed: false,
    authority_boundary: toolManifestAuthorityBoundary(),
  };
}

export async function toolManifestStatus(dir = process.cwd()) {
  return toolManifestStatusFromArtifact(await readToolManifest(dir));
}

export async function readToolManifest(dir = process.cwd()) {
  return readJsonIfExists(toolManifestPath(dir));
}

function toolManifestStatusFromArtifact(artifact) {
  if (!artifact) {
    return {
      present: false,
      path: null,
      tools: [],
      blocked_high_authority_tools: [],
      execution_policy: { ...TOOL_EXECUTION_POLICY },
      action_executed: false,
      authority_boundary: toolManifestAuthorityBoundary(),
    };
  }
  const tools = artifact.tools || [];
  return {
    present: true,
    path: toolManifestRelativePath(),
    schema: artifact.schema,
    tool_count: tools.length,
    tools,
    blocked_high_authority_tools: tools.filter(isBlockedHighAuthorityTool).map(summarizeTool),
    execution_policy: artifact.execution_policy || { ...TOOL_EXECUTION_POLICY },
    action_executed: false,
    authority_boundary: toolManifestAuthorityBoundary(),
  };
}

function normalizeToolRecord(tool) {
  const authorityFlags = normalizeAuthorityFlags(tool.authority_flags || {});
  const record = {
    schema: 'agoragentic.harness.tool-record.v1',
    id: tool.id,
    kind: tool.kind,
    side_effect_class: tool.side_effect_class,
    approval_required: Boolean(tool.approval_required),
    blocked_in_local_no_spend: Boolean(tool.blocked_in_local_no_spend),
    authority_flags: authorityFlags,
    evidence_refs: (tool.evidence_refs || []).map((entry) => ({
      id: entry.id,
      ref: sanitizeForPublicEvidence(entry.ref, { maxStringLength: 160 }),
      kind: entry.kind || 'artifact_ref',
      raw_content_inlined: false,
    })),
    execution: {
      called: false,
      framework_executed: false,
      router_execute_called: false,
      global_invoke_called: false,
      shell_called: false,
      wallet_spend_called: false,
      x402_called: false,
      marketplace_publication_called: false,
      hosted_memory_write_called: false,
      provider_dispatch_called: false,
      result_embedded: false,
    },
    authority_boundary: toolManifestAuthorityBoundary(),
  };
  record.high_authority = isHighAuthorityTool(record);
  return record;
}

function summarizeTools(tools) {
  const blockedHighAuthority = tools.filter(isBlockedHighAuthorityTool);
  return {
    tool_count: tools.length,
    blocked_high_authority_tool_count: blockedHighAuthority.length,
    blocked_high_authority_tool_ids: blockedHighAuthority.map((tool) => tool.id),
    action_executed: false,
  };
}

function summarizeTool(tool) {
  return {
    id: tool.id,
    kind: tool.kind,
    side_effect_class: tool.side_effect_class,
    approval_required: Boolean(tool.approval_required),
    blocked_in_local_no_spend: Boolean(tool.blocked_in_local_no_spend),
    authority_flags: tool.authority_flags || normalizeAuthorityFlags(),
    action_executed: false,
  };
}

function isBlockedHighAuthorityTool(tool) {
  return Boolean(tool?.blocked_in_local_no_spend && isHighAuthorityTool(tool));
}

function isHighAuthorityTool(tool) {
  if (!tool) return false;
  const flags = tool.authority_flags || {};
  return Boolean(
    tool.approval_required
    || tool.side_effect_class !== 'none'
    || Object.values(flags).some(Boolean)
  );
}

async function writeToolManifest(dir, artifact) {
  await fs.mkdir(harnessDir(dir), { recursive: true });
  await fs.writeFile(toolManifestPath(dir), `${JSON.stringify(artifact, null, 2)}\n`, 'utf8');
}

function toolManifestPath(dir) {
  return path.join(harnessDir(dir), 'tool-manifest.json');
}

function toolManifestRelativePath() {
  return '.agoragentic/tool-manifest.json';
}

function normalizeAuthorityFlags(input = {}) {
  return Object.fromEntries(AUTHORITY_FLAGS.map((key) => [key, Boolean(input[key])]));
}

function toolManifestAuthorityBoundary() {
  return authorityBoundary({
    framework_execution: false,
    router_execute: false,
    global_invoke: false,
    shell: false,
    hosted_memory_write: false,
  });
}
