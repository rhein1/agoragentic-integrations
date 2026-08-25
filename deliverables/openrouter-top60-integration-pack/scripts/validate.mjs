#!/usr/bin/env node

import { createHash } from 'node:crypto';
import { readFile, readdir, stat } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const DEFAULT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const AUTHORITY_KEYS = ['execute', 'spend', 'publish', 'deploy', 'message', 'call', 'mutate_trust'];
const PART_PATHS = Array.from({ length: 6 }, (_, index) => `catalog/entries-${String(index + 1).padStart(2, '0')}.json`);
const ENTRY_KEYS = ['rank', 'name', 'slug', 'tokens', 'status', 'direction', 'surface', 'action', 'artifact', 'sources'];
const BLOCKED_HOST_STATUS = 'blocked_pending_qualified_host_enforcement';
const BLOCKED_HOST_DECISION_PATH = 'decisions/blocked-qualified-host-enforcement.json';
const MCP_PACKAGE_NAME = `agoragentic-${'mcp'}`;
const VERSIONED_MCP_COORDINATE = new RegExp(`\\b${MCP_PACKAGE_NAME}@[^\\s\\x60"']+`, 'i');
const REGISTRY_RESOLVING_MCP_COMMAND = new RegExp(`\\bnpx(?:\\.cmd)?(?:\\s+(?:--|-{1,2}[A-Za-z][\\w-]*(?:=[^\\s\\x60"']+)?))*\\s+(?:${MCP_PACKAGE_NAME}(?:@[^\\s\\x60"']+)?|(?:-p|--package)=${MCP_PACKAGE_NAME}(?:@[^\\s\\x60"']+)?)(?=\\s|$|[\\x60"'])`, 'i');
const DIRECT_MCP_ENDPOINT = new RegExp(`https://agoragentic\\.com/api/${'mcp'}\\b`, 'i');
const CREDENTIAL_MATERIAL = /AGORAGENTIC_API_KEY|Bearer\s+[^\s]/i;
const DECISION_COMMON_KEYS = [
  'rank',
  'name',
  'slug',
  'direction',
  'action',
  'sources',
  'runtime_verified',
  'authority_granted'
];
const DECISION_FILES = {
  covered_existing: 'decisions/covered-existing.json',
  [BLOCKED_HOST_STATUS]: BLOCKED_HOST_DECISION_PATH,
  composition_recipe: 'decisions/composition-recipes.json',
  provider_recipe: 'decisions/provider-recipes.json',
  plugin_scaffold: 'decisions/plugin-scaffolds.json',
  vendor_intake: 'decisions/vendor-intakes.json',
  blocked_no_public_surface: 'decisions/blocked.json',
  deprecated: 'decisions/deprecated.json',
  needs_verification: 'decisions/needs-verification.json'
};
const DECISION_EXTRAS = {
  covered_existing: ['existing_path'],
  [BLOCKED_HOST_STATUS]: ['required_controls'],
  composition_recipe: ['pattern', 'boundary'],
  provider_recipe: ['role', 'required_controls'],
  plugin_scaffold: ['pattern', 'boundary'],
  vendor_intake: ['required_contract'],
  blocked_no_public_surface: [],
  deprecated: [],
  needs_verification: []
};
const EXPECTED_STATUS_COUNTS = {
  covered_existing: 5,
  [BLOCKED_HOST_STATUS]: 12,
  direct_adapter: 2,
  composition_recipe: 9,
  provider_recipe: 4,
  plugin_scaffold: 4,
  vendor_intake: 8,
  blocked_no_public_surface: 10,
  deprecated: 2,
  needs_verification: 4
};
const ENTRY_STATUSES = new Set(Object.keys(EXPECTED_STATUS_COUNTS));
const ENTRY_DIRECTIONS = new Set([
  'inbound_host',
  'outbound_mcp_service',
  'proprietary_agent_platform',
  'none',
  'embedded_plugin',
  'model_gateway',
  'embedded_tool',
  'gateway_and_mcp',
  'framework_adapter',
  'crm_api_and_mcp',
  'possible_framework_fork',
  'github_workflow',
  'provider_only_client',
  'migration',
  'embedded_plugin_and_gateway',
  'unknown',
  'crm_application',
  'enterprise_voice_api',
  'outbound_mcp_and_api',
  'data_pipeline',
  'website_builder',
  'security_api',
  'marketing_connector',
  'outbound_conversation_api'
]);
const INDEX_KEYS = [
  '$schema',
  'schema',
  'snapshot_date',
  'source',
  'ranking_provenance',
  'repo_snapshot',
  'distribution_status',
  'runtime_verified',
  'catalog_inclusion_requested',
  'authority',
  'entry_count',
  'parts'
];

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function containsCredentialMaterial(value) {
  try {
    return CREDENTIAL_MATERIAL.test(JSON.stringify(value));
  } catch {
    return false;
  }
}

function containsRegistryResolvingMcpCommand(value) {
  if (typeof value === 'string') return REGISTRY_RESOLVING_MCP_COMMAND.test(value);
  if (!Array.isArray(value)) return false;
  const tokens = value.filter(item => typeof item === 'string').map(item => item.trim());
  const npxIndex = tokens.findIndex(token => /^npx(?:\.cmd)?$/i.test(token));
  return npxIndex >= 0 && tokens.slice(npxIndex + 1).some(token =>
    token.toLowerCase() === '-y' || token.toLowerCase() === MCP_PACKAGE_NAME || token.toLowerCase().startsWith(`${MCP_PACKAGE_NAME}@`)
  ) && tokens.slice(npxIndex + 1).some(token =>
    token.toLowerCase() === MCP_PACKAGE_NAME || token.toLowerCase().startsWith(`${MCP_PACKAGE_NAME}@`)
  );
}

function containsMcpPackageToken(value) {
  return Array.isArray(value) && value.some(item =>
    typeof item === 'string' && (
      item.trim().toLowerCase() === MCP_PACKAGE_NAME ||
      item.trim().toLowerCase().startsWith(`${MCP_PACKAGE_NAME}@`)
    )
  );
}

function validateNoRunnableMcpConfiguration(value, label, fail) {
  if (typeof value === 'string') {
    if (VERSIONED_MCP_COORDINATE.test(value)) fail(`${label} must not contain a versioned agoragentic-mcp registry coordinate`);
    if (REGISTRY_RESOLVING_MCP_COMMAND.test(value)) fail(`${label} must not contain a registry-resolving agoragentic-mcp command`);
    if (DIRECT_MCP_ENDPOINT.test(value)) fail(`${label} must not contain the direct hosted MCP endpoint`);
    return;
  }
  if (Array.isArray(value)) {
    if (containsRegistryResolvingMcpCommand(value)) fail(`${label} must not contain split npx arguments for agoragentic-mcp`);
    value.forEach((item, index) => validateNoRunnableMcpConfiguration(item, `${label}[${index}]`, fail));
    return;
  }
  if (!isPlainObject(value)) return;

  const command = value.command ?? value.cmd ?? value.executable;
  if (typeof command === 'string' && /^npx(?:\.cmd)?$/i.test(command.trim()) && containsMcpPackageToken(value.args)) {
    fail(`${label} must not contain split npx arguments for agoragentic-mcp`);
  }

  for (const [key, child] of Object.entries(value)) {
    const childLabel = `${label}.${key}`;
    if (key.toLowerCase() === 'enabled' && child === true) fail(`${childLabel} must not enable an MCP configuration`);
    if (/^(?:authorization|headers?|env|environment)$/i.test(key) && containsCredentialMaterial(child)) {
      fail(`${childLabel} must not forward MCP credentials or authorization headers`);
    }
    if (/^(?:command|cmd|executable|args)$/i.test(key) && containsRegistryResolvingMcpCommand(child)) {
      fail(`${childLabel} must not contain a registry-resolving agoragentic-mcp command`);
    }
    validateNoRunnableMcpConfiguration(child, childLabel, fail);
  }
}

function sameJson(left, right) {
  return JSON.stringify(left) === JSON.stringify(right);
}

function validateExactObject(value, label, requiredKeys, allowedKeys, fail) {
  if (!isPlainObject(value)) {
    fail(`${label} must be an object`);
    return false;
  }
  const allowed = new Set(allowedKeys);
  for (const key of requiredKeys) {
    if (!Object.hasOwn(value, key)) fail(`${label}.${key} is required`);
  }
  for (const key of Object.keys(value).sort()) {
    if (!allowed.has(key)) fail(`${label}.${key} is not allowed`);
  }
  return true;
}

function validateNonEmptyString(value, label, fail) {
  if (typeof value !== 'string' || value.trim() === '') {
    fail(`${label} must be a non-empty string`);
    return false;
  }
  return true;
}

function validateDateOnly(value, label, fail) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    fail(`${label} must be an ISO YYYY-MM-DD date`);
    return false;
  }
  const [year, month, day] = value.split('-').map(Number);
  const parsed = new Date(Date.UTC(year, month - 1, day));
  if (
    parsed.getUTCFullYear() !== year ||
    parsed.getUTCMonth() !== month - 1 ||
    parsed.getUTCDate() !== day
  ) {
    fail(`${label} must be a real calendar date`);
    return false;
  }
  return true;
}

function validateHttpsSources(value, label, fail, { allowEmpty = true } = {}) {
  if (!Array.isArray(value)) {
    fail(`${label} must be an array`);
    return false;
  }
  if (!allowEmpty && value.length === 0) fail(`${label} must not be empty`);
  const seen = new Set();
  value.forEach((source, index) => {
    if (typeof source !== 'string' || seen.has(source)) {
      fail(`${label}[${index}] must be a unique HTTPS URL`);
      return;
    }
    seen.add(source);
    try {
      const parsed = new URL(source);
      if (parsed.protocol !== 'https:' || parsed.username || parsed.password) {
        fail(`${label}[${index}] must be an HTTPS URL without embedded credentials`);
      }
    } catch {
      fail(`${label}[${index}] must be a valid HTTPS URL`);
    }
  });
  return true;
}

function isSafeRelativePath(value) {
  if (typeof value !== 'string' || value === '' || value.includes('\\') || path.isAbsolute(value)) return false;
  const parts = value.split('/');
  return parts.every(part => part !== '' && part !== '.' && part !== '..') && !/^[A-Za-z]:/.test(value);
}

function resolveInside(root, relativePath) {
  if (!isSafeRelativePath(relativePath)) return null;
  const target = path.resolve(root, ...relativePath.split('/'));
  const relative = path.relative(root, target);
  if (relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) return null;
  return target;
}

async function readJson(root, relativePath, fail) {
  const target = resolveInside(root, relativePath);
  if (!target) {
    fail(`${relativePath} is not a safe pack-relative path`);
    return null;
  }
  try {
    return JSON.parse(await readFile(target, 'utf8'));
  } catch (error) {
    fail(`${relativePath} could not be read as JSON: ${error.code || error.name}`);
    return null;
  }
}

async function validatePackFile(root, relativePath, label, fail) {
  const target = resolveInside(root, relativePath);
  if (!target) {
    fail(`${label} must be a safe pack-relative path`);
    return false;
  }
  try {
    const info = await stat(target);
    if (!info.isFile()) {
      fail(`${label} must reference a file`);
      return false;
    }
    return true;
  } catch {
    fail(`${label} references a missing file: ${relativePath}`);
    return false;
  }
}

async function collectPackFiles(root) {
  const files = [];
  async function walk(directory, prefix = '') {
    const entries = await readdir(directory, { withFileTypes: true });
    entries.sort((left, right) => left.name.localeCompare(right.name));
    for (const entry of entries) {
      if (entry.isDirectory() && ['.git', 'node_modules', 'coverage'].includes(entry.name)) continue;
      const relativePath = prefix ? `${prefix}/${entry.name}` : entry.name;
      if (entry.isDirectory()) await walk(path.join(directory, entry.name), relativePath);
      else files.push(relativePath);
    }
  }
  await walk(root);
  return files.sort();
}

function validateStringArray(value, label, fail, { exact = null, minItems = 0 } = {}) {
  if (!Array.isArray(value)) {
    fail(`${label} must be an array`);
    return false;
  }
  if (value.length < minItems) fail(`${label} must contain at least ${minItems} items`);
  value.forEach((item, index) => validateNonEmptyString(item, `${label}[${index}]`, fail));
  if (exact && !sameJson(value, exact)) fail(`${label} must equal ${JSON.stringify(exact)}`);
  return true;
}

function validateDeniedAuthority(value, label, fail) {
  if (!validateExactObject(value, label, AUTHORITY_KEYS, AUTHORITY_KEYS, fail)) return;
  for (const key of AUTHORITY_KEYS) {
    if (value[key] !== false) fail(`${label}.${key} must be false`);
  }
}

function compareFields(left, right, fields, label, fail) {
  for (const field of fields) {
    if (!sameJson(left[field], right[field])) fail(`${label}.${field} does not match catalog`);
  }
}

function validateDecisionItem(item, group, label, fail) {
  const extras = DECISION_EXTRAS[group];
  const keys = [...DECISION_COMMON_KEYS, ...extras];
  if (!validateExactObject(item, label, keys, keys, fail)) return;
  if (!Number.isInteger(item.rank) || item.rank < 1 || item.rank > 60) fail(`${label}.rank must be an integer from 1 through 60`);
  validateNonEmptyString(item.name, `${label}.name`, fail);
  if (typeof item.slug !== 'string' || !/^[a-z0-9][a-z0-9-]*$/.test(item.slug)) fail(`${label}.slug is invalid`);
  validateNonEmptyString(item.direction, `${label}.direction`, fail);
  validateNonEmptyString(item.action, `${label}.action`, fail);
  validateHttpsSources(item.sources, `${label}.sources`, fail);
  if (item.runtime_verified !== false) fail(`${label}.runtime_verified must be false`);
  if (item.authority_granted !== false) fail(`${label}.authority_granted must be false`);
  for (const extra of extras) {
    if (['required_controls', 'required_contract'].includes(extra)) {
      validateStringArray(item[extra], `${label}.${extra}`, fail, { minItems: 1 });
    } else {
      validateNonEmptyString(item[extra], `${label}.${extra}`, fail);
      if (extra === 'existing_path' && !isSafeRelativePath(item[extra])) fail(`${label}.existing_path must be repository-relative`);
    }
  }
  validateNoRunnableMcpConfiguration(item, label, fail);
}

export async function validatePack(rootOverride = DEFAULT_ROOT) {
  const root = path.resolve(rootOverride);
  const errors = [];
  const fail = message => errors.push(message);
  const summary = { entries: 0, decisions: 0, files: 0 };

  const declaredSchema = await readJson(root, 'catalog/schema.json', fail);
  if (isPlainObject(declaredSchema)) {
    if (declaredSchema.$schema !== 'https://json-schema.org/draft/2020-12/schema') fail('catalog/schema.json.$schema must use draft 2020-12');
    if (declaredSchema.$id !== 'https://agoragentic.com/schemas/openrouter-top60-review-index.v1.json') fail('catalog/schema.json.$id is invalid');
    if (declaredSchema.additionalProperties !== false) fail('catalog/schema.json must reject additional index properties');
  }

  const index = await readJson(root, 'catalog/index.json', fail);
  if (validateExactObject(index, 'catalog/index.json', INDEX_KEYS, INDEX_KEYS, fail)) {
    if (index.$schema !== './schema.json') fail('catalog/index.json.$schema must be ./schema.json');
    if (index.schema !== 'agoragentic.openrouter-top60-review-index.v1') fail('catalog/index.json.schema is invalid');
    validateDateOnly(index.snapshot_date, 'catalog/index.json.snapshot_date', fail);
    validateNonEmptyString(index.source, 'catalog/index.json.source', fail);
    if (index.ranking_provenance !== 'catalog/source-evidence.json') fail('catalog/index.json.ranking_provenance is invalid');
    if (index.distribution_status !== 'review_only') fail('catalog/index.json.distribution_status must be review_only');
    if (index.runtime_verified !== false) fail('catalog/index.json.runtime_verified must be false');
    if (index.catalog_inclusion_requested !== false) fail('catalog/index.json.catalog_inclusion_requested must be false');
    if (index.entry_count !== 60) fail('catalog/index.json.entry_count must be 60');
    validateDeniedAuthority(index.authority, 'catalog/index.json.authority', fail);
    const repoKeys = ['repository', 'branch', 'commit', 'manifest_version', 'manifest_count'];
    if (validateExactObject(index.repo_snapshot, 'catalog/index.json.repo_snapshot', repoKeys, repoKeys, fail)) {
      if (typeof index.repo_snapshot.repository !== 'string' || !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(index.repo_snapshot.repository)) fail('catalog/index.json.repo_snapshot.repository is invalid');
      validateNonEmptyString(index.repo_snapshot.branch, 'catalog/index.json.repo_snapshot.branch', fail);
      if (typeof index.repo_snapshot.commit !== 'string' || !/^[0-9a-f]{40}$/.test(index.repo_snapshot.commit)) fail('catalog/index.json.repo_snapshot.commit must be a lowercase 40-character Git SHA');
      if (typeof index.repo_snapshot.manifest_version !== 'string' || !/^\d+\.\d+\.\d+$/.test(index.repo_snapshot.manifest_version)) fail('catalog/index.json.repo_snapshot.manifest_version must be semantic version text');
      if (!Number.isInteger(index.repo_snapshot.manifest_count) || index.repo_snapshot.manifest_count < 0) fail('catalog/index.json.repo_snapshot.manifest_count must be a non-negative integer');
    }
  }

  const catalogDirectory = resolveInside(root, 'catalog');
  if (catalogDirectory) {
    try {
      const inventory = (await readdir(catalogDirectory)).filter(name => /^entries-\d{2}\.json$/.test(name)).map(name => `catalog/${name}`).sort();
      if (!sameJson(inventory, PART_PATHS)) fail(`catalog part inventory must equal ${JSON.stringify(PART_PATHS)}`);
    } catch (error) {
      fail(`catalog part inventory could not be read: ${error.code || error.name}`);
    }
  }

  const entries = [];
  const rankSet = new Set();
  const slugSet = new Set();
  const statusCounts = Object.fromEntries(Object.keys(EXPECTED_STATUS_COUNTS).map(status => [status, 0]));
  if (!Array.isArray(index?.parts) || index.parts.length !== 6) {
    fail('catalog/index.json.parts must contain exactly six parts');
  }
  for (let partIndex = 0; partIndex < PART_PATHS.length; partIndex += 1) {
    const expectedPath = PART_PATHS[partIndex];
    const expectedPart = {
      path: expectedPath,
      first_rank: partIndex * 10 + 1,
      last_rank: (partIndex + 1) * 10,
      count: 10
    };
    const part = index?.parts?.[partIndex];
    const partLabel = `catalog/index.json.parts[${partIndex}]`;
    const partKeys = ['path', 'first_rank', 'last_rank', 'count'];
    if (validateExactObject(part, partLabel, partKeys, partKeys, fail)) {
      for (const key of partKeys) {
        if (part[key] !== expectedPart[key]) fail(`${partLabel}.${key} must be ${JSON.stringify(expectedPart[key])}`);
      }
    }
    const chunk = await readJson(root, expectedPath, fail);
    if (!Array.isArray(chunk)) {
      fail(`${expectedPath} must contain an array`);
      continue;
    }
    if (chunk.length !== 10) fail(`${expectedPath} must contain exactly 10 entries`);
    for (let entryIndex = 0; entryIndex < chunk.length; entryIndex += 1) {
      const entry = chunk[entryIndex];
      const label = `${expectedPath}[${entryIndex}]`;
      if (!validateExactObject(entry, label, ENTRY_KEYS, ENTRY_KEYS, fail)) continue;
      const expectedRank = partIndex * 10 + entryIndex + 1;
      if (entry.rank !== expectedRank) fail(`${label}.rank must be ${expectedRank}`);
      if (!Number.isInteger(entry.rank) || entry.rank < 1 || entry.rank > 60 || rankSet.has(entry.rank)) fail(`${label}.rank is invalid or duplicated`);
      else rankSet.add(entry.rank);
      validateNonEmptyString(entry.name, `${label}.name`, fail);
      if (typeof entry.slug !== 'string' || !/^[a-z0-9][a-z0-9-]*$/.test(entry.slug) || slugSet.has(entry.slug)) fail(`${label}.slug is invalid or duplicated`);
      else slugSet.add(entry.slug);
      if (typeof entry.tokens !== 'string' || !/^\d+(?:\.\d+)?[BT]$/.test(entry.tokens)) fail(`${label}.tokens is invalid`);
      if (entry.status === 'ready_config') fail(`${label}.status ready_config is forbidden pending qualified host enforcement`);
      if (!ENTRY_STATUSES.has(entry.status)) fail(`${label}.status is invalid`);
      else statusCounts[entry.status] += 1;
      if (!ENTRY_DIRECTIONS.has(entry.direction)) fail(`${label}.direction is invalid`);
      validateNonEmptyString(entry.surface, `${label}.surface`, fail);
      validateNonEmptyString(entry.action, `${label}.action`, fail);
      validateHttpsSources(entry.sources, `${label}.sources`, fail);
      if (entry.artifact === 'host-configs.json') fail(`${label}.artifact must not reference host-configs.json`);
      await validatePackFile(root, entry.artifact, `${label}.artifact`, fail);
      validateNoRunnableMcpConfiguration(entry, label, fail);
      entries.push(entry);
    }
  }
  summary.entries = entries.length;
  if (entries.length !== 60) fail(`catalog must contain exactly 60 entries, found ${entries.length}`);
  for (const [status, expected] of Object.entries(EXPECTED_STATUS_COUNTS)) {
    if (statusCounts[status] !== expected) fail(`catalog status ${status} must contain ${expected} entries, found ${statusCounts[status]}`);
  }

  const provenance = await readJson(root, 'catalog/source-evidence.json', fail);
  const provenanceKeys = [
    'schema',
    'snapshot_date',
    'source_kind',
    'source_description',
    'original_artifacts_preserved',
    'original_artifact_paths',
    'original_artifact_sha256',
    'independently_reproducible',
    'transcription'
  ];
  if (validateExactObject(provenance, 'catalog/source-evidence.json', provenanceKeys, provenanceKeys, fail)) {
    if (provenance.schema !== 'agoragentic.openrouter-top60-ranking-provenance.v1') fail('catalog/source-evidence.json.schema is invalid');
    validateDateOnly(provenance.snapshot_date, 'catalog/source-evidence.json.snapshot_date', fail);
    if (provenance.snapshot_date !== index?.snapshot_date) fail('catalog/source-evidence.json.snapshot_date must match catalog/index.json');
    if (provenance.source_kind !== 'user_supplied_screenshots') fail('catalog/source-evidence.json.source_kind is invalid');
    validateNonEmptyString(provenance.source_description, 'catalog/source-evidence.json.source_description', fail);
    if (provenance.original_artifacts_preserved !== false) fail('catalog/source-evidence.json.original_artifacts_preserved must be false');
    if (!sameJson(provenance.original_artifact_paths, [])) fail('catalog/source-evidence.json.original_artifact_paths must be empty');
    if (!sameJson(provenance.original_artifact_sha256, [])) fail('catalog/source-evidence.json.original_artifact_sha256 must be empty');
    if (provenance.independently_reproducible !== false) fail('catalog/source-evidence.json.independently_reproducible must be false');
    const transcriptionKeys = [
      'catalog_parts',
      'entry_count',
      'projected_fields',
      'canonicalization',
      'catalog_projection_sha256',
      'cross_checked_against_preserved_source',
      'limitations'
    ];
    if (validateExactObject(provenance.transcription, 'catalog/source-evidence.json.transcription', transcriptionKeys, transcriptionKeys, fail)) {
      validateStringArray(provenance.transcription.catalog_parts, 'catalog/source-evidence.json.transcription.catalog_parts', fail, { exact: PART_PATHS });
      if (provenance.transcription.entry_count !== 60) fail('catalog/source-evidence.json.transcription.entry_count must be 60');
      validateStringArray(provenance.transcription.projected_fields, 'catalog/source-evidence.json.transcription.projected_fields', fail, { exact: ['rank', 'name', 'tokens'] });
      if (provenance.transcription.canonicalization !== 'UTF-8 JSON.stringify of the rank-ordered array with object keys rank, name, tokens') fail('catalog/source-evidence.json.transcription.canonicalization is invalid');
      if (provenance.transcription.cross_checked_against_preserved_source !== false) fail('catalog/source-evidence.json.transcription.cross_checked_against_preserved_source must be false');
      validateNonEmptyString(provenance.transcription.limitations, 'catalog/source-evidence.json.transcription.limitations', fail);
      const projection = entries.map(({ rank, name, tokens }) => ({ rank, name, tokens }));
      const digest = createHash('sha256').update(JSON.stringify(projection), 'utf8').digest('hex');
      if (provenance.transcription.catalog_projection_sha256 !== digest) fail('catalog/source-evidence.json.transcription.catalog_projection_sha256 does not match the catalog projection');
    }
  }

  const decisionMap = new Map();
  for (const [group, relativePath] of Object.entries(DECISION_FILES)) {
    const packet = await readJson(root, relativePath, fail);
    const packetKeys = ['schema', 'group', 'runtime_verified', 'authority_granted', 'items'];
    if (!validateExactObject(packet, relativePath, packetKeys, packetKeys, fail)) continue;
    if (packet.schema !== 'agoragentic.openrouter-top60-decision-group.v1') fail(`${relativePath}.schema is invalid`);
    if (packet.group !== group) fail(`${relativePath}.group must be ${group}`);
    if (packet.runtime_verified !== false) fail(`${relativePath}.runtime_verified must be false`);
    if (packet.authority_granted !== false) fail(`${relativePath}.authority_granted must be false`);
    const expectedCount = EXPECTED_STATUS_COUNTS[group];
    if (!Array.isArray(packet.items) || packet.items.length !== expectedCount) fail(`${relativePath}.items must contain exactly ${expectedCount} entries`);
    for (const [itemIndex, item] of (packet.items || []).entries()) {
      const label = `${relativePath}.items[${itemIndex}]`;
      validateDecisionItem(item, group, label, fail);
      if (isPlainObject(item) && typeof item.slug === 'string') {
        if (decisionMap.has(item.slug)) fail(`${label}.slug duplicates another decision record`);
        else decisionMap.set(item.slug, { group, relativePath, item });
      }
    }
  }
  summary.decisions = decisionMap.size;

  for (const entry of entries) {
    const label = `catalog entry ${entry.slug}`;
    if (entry.status === 'direct_adapter') {
      if (!/^adapters\/[a-z0-9-]+\.(?:mjs|ts)$/.test(entry.artifact)) fail(`${label}.artifact must be a bounded adapter source file`);
      continue;
    }
    const expectedDecisionPath = DECISION_FILES[entry.status];
    if (!expectedDecisionPath) {
      fail(`${label}.status has no decision mapping`);
      continue;
    }
    if (entry.artifact !== expectedDecisionPath) fail(`${label}.artifact must be ${expectedDecisionPath}`);
    const decision = decisionMap.get(entry.slug);
    if (!decision) fail(`${label} has no matching decision record`);
    else {
      if (decision.group !== entry.status) fail(`decision ${entry.slug}.group does not match catalog status`);
      compareFields(entry, decision.item, ['rank', 'name', 'slug', 'direction', 'action', 'sources'], `decision ${entry.slug}`, fail);
    }
  }
  for (const [slug, decision] of decisionMap) {
    if (!entries.some(entry => entry.slug === slug && entry.status === decision.group)) fail(`decision ${slug} has no matching catalog entry`);
  }

  const manifest = await readJson(root, 'pack-manifest.json', fail);
  const manifestKeys = [
    'schema',
    'base_commit',
    'file_count',
    'catalog_entries',
    'active_manifest_entries_added',
    'runtime_verified',
    'authority_granted',
    'files'
  ];
  if (validateExactObject(manifest, 'pack-manifest.json', manifestKeys, manifestKeys, fail)) {
    if (manifest.schema !== 'agoragentic.openrouter-top60-review-pack.v2') fail('pack-manifest.json.schema is invalid');
    if (typeof manifest.base_commit !== 'string' || !/^[0-9a-f]{40}$/.test(manifest.base_commit)) fail('pack-manifest.json.base_commit must be a lowercase 40-character Git SHA');
    if (manifest.base_commit !== index?.repo_snapshot?.commit) fail('pack-manifest.json.base_commit must match catalog repo_snapshot.commit');
    if (!Number.isInteger(manifest.file_count) || manifest.file_count < 1) fail('pack-manifest.json.file_count must be a positive integer');
    if (manifest.catalog_entries !== index?.entry_count) fail('pack-manifest.json.catalog_entries must match catalog entry_count');
    if (manifest.active_manifest_entries_added !== 0) fail('pack-manifest.json.active_manifest_entries_added must be 0');
    if (manifest.runtime_verified !== false) fail('pack-manifest.json.runtime_verified must be false');
    if (manifest.authority_granted !== false) fail('pack-manifest.json.authority_granted must be false');
    if (!Array.isArray(manifest.files)) fail('pack-manifest.json.files must be an array');
    else {
      const duplicates = manifest.files.filter((item, index) => manifest.files.indexOf(item) !== index);
      if (duplicates.length) fail(`pack-manifest.json.files contains duplicates: ${[...new Set(duplicates)].sort().join(', ')}`);
      for (const [fileIndex, file] of manifest.files.entries()) {
        if (!isSafeRelativePath(file)) fail(`pack-manifest.json.files[${fileIndex}] must be a safe pack-relative path`);
      }
      if (manifest.file_count !== manifest.files.length) fail('pack-manifest.json.file_count must equal files.length');
      try {
        const actualFiles = await collectPackFiles(root);
        summary.files = actualFiles.length;
        if (actualFiles.includes('host-configs.json')) fail('host-configs.json is forbidden pending qualified host enforcement');
        const declaredFiles = [...manifest.files].sort();
        const missing = actualFiles.filter(file => !declaredFiles.includes(file));
        const stale = declaredFiles.filter(file => !actualFiles.includes(file));
        if (missing.length) fail(`pack-manifest.json.files is missing: ${missing.join(', ')}`);
        if (stale.length) fail(`pack-manifest.json.files references absent files: ${stale.join(', ')}`);
      } catch (error) {
        fail(`pack file inventory could not be read: ${error.code || error.name}`);
      }
    }
  }

  const uniqueErrors = [...new Set(errors)].sort();
  return { ok: uniqueErrors.length === 0, errors: uniqueErrors, summary };
}

const invokedAsScript = process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url;
if (invokedAsScript) {
  const result = await validatePack();
  if (!result.ok) {
    for (const error of result.errors) console.error(`❌ ${error}`);
    process.exitCode = 1;
  } else {
    console.log(`✅ OpenRouter top-60 review pack validated: ${result.summary.entries} catalog entries, ${result.summary.decisions} decision records, ${result.summary.files} files`);
  }
}
