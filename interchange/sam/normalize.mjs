#!/usr/bin/env node

import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

export const SAM_TOOL_IMPORT_SCHEMA = 'agoragentic.interchange.sam-tool-import.v1';

const MAX_SAM_DISCOVERY_BYTES = 131_072;
const MAX_SAM_DESCRIPTION_BYTES = 524_288;
const MAX_SAM_PEER_ID_LENGTH = 256;
const MAX_SAM_TOOL_NAME_LENGTH = 512;
const MAX_SAM_DESCRIPTION_LENGTH = 8_192;
const MAX_SAM_SCHEMA_BYTES = 262_144;
const PUBLIC_SAM_DESCRIPTION = 'Metadata-only SAM-discovered MCP tool. Exact provider routing and descriptive text remain private pending operator review.';

const FALSE_AUTHORITY_FLAGS = Object.freeze({
  eligible_for_execution: false,
  provider_identity_bound: false,
  commercial_terms_bound: false,
  payment_enabled: false,
  wallet_spend_enabled: false,
  trust_mutation_enabled: false,
  marketplace_publication_enabled: false,
  public_execute_enabled: false,
});

function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function cleanText(value, fallback = '') {
  if (value === undefined || value === null) return fallback;
  const normalized = String(value).trim();
  return normalized || fallback;
}

function assertJsonSize(value, maxBytes, code) {
  let serialized;
  try {
    serialized = stableStringify(value);
  } catch {
    throw new Error(`${code}_not_serializable`);
  }
  if (Buffer.byteLength(serialized, 'utf8') > maxBytes) throw new Error(code);
}

function boundedText(value, { code, maxLength, fallback = '' }) {
  const text = cleanText(value, fallback);
  if (text.length > maxLength) throw new Error(code);
  if (/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(text)) {
    throw new Error(`${code}_control_character`);
  }
  return text;
}

function validObservedAt(value) {
  const observedAt = cleanText(value);
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d+)?(?:Z|[+-](\d{2}):(\d{2}))$/.exec(observedAt);
  if (!match) {
    throw new Error('sam_observed_at_invalid');
  }
  const [, yearText, monthText, dayText, hourText, minuteText, secondText, offsetHourText, offsetMinuteText] = match;
  const year = Number(yearText);
  const month = Number(monthText);
  const day = Number(dayText);
  const hour = Number(hourText);
  const minute = Number(minuteText);
  const second = Number(secondText);
  const offsetHour = offsetHourText === undefined ? 0 : Number(offsetHourText);
  const offsetMinute = offsetMinuteText === undefined ? 0 : Number(offsetMinuteText);
  const leapYear = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  const daysInMonth = [31, leapYear ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  if (
    month < 1 || month > 12
    || day < 1 || day > daysInMonth[month - 1]
    || hour > 23 || minute > 59 || second > 59
    || offsetHour > 23 || offsetMinute > 59
  ) {
    throw new Error('sam_observed_at_invalid');
  }
  return observedAt;
}

function canonicalize(value) {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (!isRecord(value)) return value;
  const out = Object.create(null);
  for (const key of Object.keys(value).sort()) {
    const child = value[key];
    if (child !== undefined) {
      Object.defineProperty(out, key, {
        value: canonicalize(child),
        enumerable: true,
        configurable: true,
        writable: true,
      });
    }
  }
  return out;
}

export function stableStringify(value) {
  return JSON.stringify(canonicalize(value));
}

export function hashRef(value) {
  return `sha256:${createHash('sha256').update(stableStringify(value)).digest('hex')}`;
}

export function parseSamToolName(value) {
  const toolName = boundedText(value, {
    code: 'sam_tool_name_too_long',
    maxLength: MAX_SAM_TOOL_NAME_LENGTH,
  });
  if (!toolName.startsWith('mcp://')) {
    throw new Error('sam_tool_name_must_use_mcp_namespace');
  }
  const match = /^mcp:\/\/([A-Za-z0-9][A-Za-z0-9._-]{0,255})\/([A-Za-z0-9][A-Za-z0-9._/-]*)$/.exec(toolName);
  if (!match) throw new Error('sam_tool_name_must_be_service_slash_tool');
  const serviceName = `mcp://${match[1]}`;
  const bareToolName = match[2];
  if (serviceName === 'mcp://sam.catalog' || bareToolName.startsWith('_')) {
    throw new Error('sam_system_tool_not_importable');
  }
  return { serviceName, bareToolName, toolName };
}

function normalizeLabels(labels) {
  if (!isRecord(labels)) return {};
  const out = {};
  for (const key of Object.keys(labels).sort().slice(0, 32)) {
    const normalizedKey = cleanText(key).slice(0, 128);
    const normalizedValue = cleanText(labels[key]).slice(0, 256);
    if (normalizedKey && normalizedValue) {
      Object.defineProperty(out, normalizedKey, {
        configurable: true,
        enumerable: true,
        value: normalizedValue,
        writable: true,
      });
    }
  }
  return out;
}

function publicDisplayName(toolRef) {
  return `SAM MCP tool ${toolRef.slice(7, 19)}`;
}

/**
 * Turn caller-supplied SAM find_remote_tools + describe_remote_tool results into
 * a metadata-only Interchange import packet.
 *
 * This function performs no network call and therefore does not independently
 * attest authorization, identity, reachability, pricing, or execution.
 */
export function normalizeSamTool({
  discovery,
  description,
  observedAt = new Date().toISOString(),
  includePrivateTarget = false,
} = {}) {
  if (!isRecord(discovery)) throw new Error('sam_discovery_row_required');
  if (!isRecord(description)) throw new Error('sam_description_required');
  assertJsonSize(discovery, MAX_SAM_DISCOVERY_BYTES, 'sam_discovery_row_too_large');
  assertJsonSize(description, MAX_SAM_DESCRIPTION_BYTES, 'sam_description_too_large');
  if (cleanText(discovery.error)) throw new Error('sam_discovery_row_contains_error');
  if (cleanText(description.error)) throw new Error('sam_description_contains_error');

  const peerId = boundedText(discovery.peer_id, {
    code: 'sam_peer_id_too_long',
    maxLength: MAX_SAM_PEER_ID_LENGTH,
  });
  if (!peerId) throw new Error('sam_peer_id_required');
  if (/\s/.test(peerId)) throw new Error('sam_peer_id_invalid');

  const parsed = parseSamToolName(discovery.tool_name);
  const describedPeerId = cleanText(description.peer_id);
  const describedToolName = cleanText(description.tool_name);
  if (describedPeerId !== peerId) throw new Error('sam_description_peer_mismatch');
  if (describedToolName !== parsed.toolName) throw new Error('sam_description_tool_mismatch');

  if (!Object.prototype.hasOwnProperty.call(description, 'input_schema') || !isRecord(description.input_schema)) {
    throw new Error('sam_description_input_schema_required');
  }
  const inputSchema = description.input_schema;
  const hasOutputSchema = Object.prototype.hasOwnProperty.call(description, 'output_schema');
  if (hasOutputSchema && description.output_schema !== null && !isRecord(description.output_schema)) {
    throw new Error('sam_description_output_schema_invalid');
  }
  const outputSchema = hasOutputSchema ? description.output_schema : null;
  assertJsonSize({ input_schema: inputSchema, output_schema: outputSchema }, MAX_SAM_SCHEMA_BYTES, 'sam_tool_schema_too_large');
  const labels = normalizeLabels(discovery.labels);
  const peerRef = hashRef({ peer_id: peerId });
  const serviceRef = hashRef({ service_name: parsed.serviceName });
  const toolRef = hashRef({ tool_name: parsed.toolName });
  const schemaHash = hashRef({ input_schema: inputSchema, output_schema: outputSchema });
  const labelsHash = hashRef({ labels });
  const manifestHash = hashRef({ discovery, description });
  boundedText(description.description || discovery.description, {
    code: 'sam_tool_description_too_long',
    maxLength: MAX_SAM_DESCRIPTION_LENGTH,
  });

  const packet = {
    schema: SAM_TOOL_IMPORT_SCHEMA,
    generated_at: validObservedAt(observedAt),
    source_kind: 'sam_mesh_tool',
    lifecycle_status: 'normalized',
    manifest_hash: manifestHash,
    capability_card_input: {
      name: publicDisplayName(toolRef),
      description: PUBLIC_SAM_DESCRIPTION,
      category: 'developer-tools',
      tags: ['sam', 'mcp', 'sovereign-agent-mesh'],
      interface_kind: 'sam_mesh_tool',
      pricing: {
        pricing_model: 'quote_required',
        currency: 'USDC',
        unit_price: '0',
      },
      risk_level: 'network_discovered_unbound_provider',
      source: {
        source_type: 'sam_mesh_tool_observation',
        source_ref: `sam:${peerRef.slice(7, 23)}:${toolRef.slice(7, 23)}`,
      },
    },
    transport_evidence: {
      transport: 'sam',
      observation_type: 'caller_supplied_find_and_describe_results',
      peer_ref: peerRef,
      service_ref: serviceRef,
      tool_ref: toolRef,
      schema_hash: schemaHash,
      labels_hash: labelsHash,
      authorization_verified_by_normalizer: false,
      reachability_verified_by_normalizer: false,
      provider_account_bound: false,
      point_in_time_only: true,
    },
    eligibility: {
      eligible: false,
      blockers: [
        'sam_provider_account_binding_required',
        'commercial_terms_required',
        'live_authorization_canary_required',
        'outcome_validator_required',
      ],
    },
    authority_flags: { ...FALSE_AUTHORITY_FLAGS },
    safety: {
      metadata_only: true,
      external_calls_made: false,
      provider_invoked: false,
      funds_moved: false,
      raw_peer_id_public: false,
      raw_tool_target_public: false,
    },
  };

  if (includePrivateTarget === true) {
    packet.private_transport_target = {
      peer_id: peerId,
      service_name: parsed.serviceName,
      tool_name: parsed.toolName,
      observed_labels: labels,
      note: 'Local handoff only. Never publish this object or commit credentials with it.',
    };
  }

  return packet;
}

function parseArgs(argv) {
  const out = { includePrivateTarget: false };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--include-private-target') {
      out.includePrivateTarget = true;
    } else if (arg === '--discovery') {
      out.discoveryPath = argv[++index];
    } else if (arg === '--description') {
      out.descriptionPath = argv[++index];
    } else if (arg === '--observed-at') {
      out.observedAt = argv[++index];
    } else if (arg === '--demo') {
      out.demo = true;
    } else if (arg === '--help' || arg === '-h') {
      out.help = true;
    } else {
      throw new Error(`unknown_argument:${arg}`);
    }
  }
  return out;
}

function helpText() {
  return `Usage:
  node interchange/sam/normalize.mjs --discovery <find-row.json> --description <describe.json>
  node interchange/sam/normalize.mjs --demo

Options:
  --include-private-target  Include raw peer/tool routing data in local output.
  --observed-at <ISO>       Override the observation timestamp.

The default output is public-safe and metadata-only. No network calls, tool
invocations, wallet actions, trust mutations, or marketplace publication occur.`;
}

async function readJson(filePath) {
  return JSON.parse(await readFile(filePath, 'utf8'));
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    console.log(helpText());
    return;
  }

  let discoveryPath = args.discoveryPath;
  let descriptionPath = args.descriptionPath;
  if (args.demo) {
    const here = path.dirname(fileURLToPath(import.meta.url));
    discoveryPath = path.join(here, 'fixtures', 'find-remote-tool.json');
    descriptionPath = path.join(here, 'fixtures', 'describe-remote-tool.json');
  }
  if (!discoveryPath || !descriptionPath) throw new Error('discovery_and_description_paths_required');

  const [discovery, description] = await Promise.all([
    readJson(discoveryPath),
    readJson(descriptionPath),
  ]);
  const packet = normalizeSamTool({
    discovery,
    description,
    observedAt: args.observedAt,
    includePrivateTarget: args.includePrivateTarget,
  });
  process.stdout.write(`${JSON.stringify(packet, null, 2)}\n`);
}

const isEntrypoint = process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1]);
if (isEntrypoint) {
  main().catch((error) => {
    console.error(JSON.stringify({ error: error.message }));
    process.exitCode = 1;
  });
}
