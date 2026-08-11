import { assertCanonicalJson, canonicalize, sha256Ref } from './canonical.mjs';
import { MCP_PHASES, RISK_ACTIONS, RISK_LEVELS } from './constants.mjs';
import {
  assertAllowedKeys,
  assertPlainObject,
  deepFreeze,
  requireEnum,
  requireExternalEndpoint,
  requireOpaqueRef,
  uniqueStrings,
} from './util.mjs';

const TRUST_STATES = Object.freeze(['verified', 'reachable', 'failed', 'unknown', 'untrusted']);

const CAPABILITY_KEYS = Object.freeze([
  'network_access',
  'filesystem_read',
  'filesystem_write',
  'credential_access',
  'wallet_or_payment',
  'deployment',
  'publication',
  'communication',
  'database_mutation',
  'trust_or_reputation_mutation',
  'external_side_effect',
  'unknown_or_unclassified',
]);

const IRREVERSIBLE_CAPABILITIES = Object.freeze([
  'wallet_or_payment',
  'deployment',
  'publication',
  'communication',
  'database_mutation',
  'trust_or_reputation_mutation',
]);

const HIGH_CAPABILITIES = Object.freeze([
  'filesystem_write',
  'credential_access',
  'external_side_effect',
  'unknown_or_unclassified',
]);

const LEVEL_RANK = Object.freeze({ LOW: 0, ELEVATED: 1, HIGH: 2, IRREVERSIBLE: 3 });

function optionalBoolean(value, field, fallback) {
  if (value === undefined) return fallback;
  if (typeof value !== 'boolean') throw new TypeError(`${field} must be a boolean`);
  return value;
}

function normalizeCapabilities(value = {}) {
  assertAllowedKeys(value, CAPABILITY_KEYS, 'capabilities');
  const incomplete = value === null
    || CAPABILITY_KEYS.some((key) => !Object.hasOwn(value, key));
  return Object.fromEntries(CAPABILITY_KEYS.map((key) => [
    key,
    key === 'unknown_or_unclassified'
      ? optionalBoolean(value[key], `capabilities.${key}`, incomplete) || incomplete
      : optionalBoolean(value[key], `capabilities.${key}`, false),
  ]));
}

function normalizeAnnotations(value = {}) {
  assertAllowedKeys(value, [
    'readOnlyHint',
    'destructiveHint',
    'idempotentHint',
    'openWorldHint',
  ], 'tool_annotations');
  return {
    read_only_hint: optionalBoolean(value.readOnlyHint, 'tool_annotations.readOnlyHint', false),
    destructive_hint: optionalBoolean(
      value.destructiveHint,
      'tool_annotations.destructiveHint',
      false,
    ),
    idempotent_hint: optionalBoolean(
      value.idempotentHint,
      'tool_annotations.idempotentHint',
      false,
    ),
    open_world_hint: optionalBoolean(value.openWorldHint, 'tool_annotations.openWorldHint', true),
  };
}

function normalizeOwnerPolicy(value = {}) {
  assertAllowedKeys(value, [
    'minimum_level',
    'force_risk_fork',
    'deny_irreversible',
    'trusted_server_refs',
    'allowed_egress',
  ], 'owner_policy');
  return {
    minimum_level: value.minimum_level === undefined
      ? 'LOW'
      : requireEnum(value.minimum_level, RISK_LEVELS, 'owner_policy.minimum_level'),
    force_risk_fork: optionalBoolean(
      value.force_risk_fork,
      'owner_policy.force_risk_fork',
      false,
    ),
    deny_irreversible: optionalBoolean(
      value.deny_irreversible,
      'owner_policy.deny_irreversible',
      false,
    ),
    trusted_server_refs: uniqueStrings(
      value.trusted_server_refs,
      'owner_policy.trusted_server_refs',
    ).map((item, index) => requireOpaqueRef(
      item,
      `owner_policy.trusted_server_refs[${index}]`,
    )).sort(),
    allowed_egress: [...new Set(uniqueStrings(
      value.allowed_egress,
      'owner_policy.allowed_egress',
    ).map((item, index) => requireExternalEndpoint(
      item,
      `owner_policy.allowed_egress[${index}]`,
    )))].sort(),
  };
}

function promote(current, candidate) {
  return LEVEL_RANK[candidate] > LEVEL_RANK[current] ? candidate : current;
}

function reason(code, level, weight, detail) {
  return { code, level, weight, detail };
}

export function classifyRisk(input = {}) {
  assertAllowedKeys(input, [
    'request_id',
    'mcp_phase',
    'mcp_server_ref',
    'mcp_server_origin',
    'mcp_server_trust',
    'tool_name',
    'tool_annotations',
    'capabilities',
    'prompt_injection_indicators',
    'owner_policy',
  ], 'risk input');

  const normalized = {
    request_id: input.request_id == null
      ? null
      : requireOpaqueRef(input.request_id, 'request_id', { maxLength: 200 }),
    mcp_phase: input.mcp_phase === undefined
      ? null
      : requireEnum(input.mcp_phase, MCP_PHASES, 'mcp_phase'),
    mcp_server_ref: input.mcp_server_ref == null
      ? null
      : requireOpaqueRef(input.mcp_server_ref, 'mcp_server_ref'),
    mcp_server_origin: input.mcp_server_origin == null
      ? null
      : requireExternalEndpoint(input.mcp_server_origin, 'mcp_server_origin'),
    mcp_server_trust: requireEnum(
      input.mcp_server_trust ?? 'unknown',
      TRUST_STATES,
      'mcp_server_trust',
    ),
    tool_name: input.tool_name === undefined
      ? null
      : requireOpaqueRef(input.tool_name, 'tool_name', { maxLength: 300 }),
    tool_annotations: normalizeAnnotations(input.tool_annotations),
    capabilities: normalizeCapabilities(input.capabilities),
    prompt_injection_indicators: uniqueStrings(
      input.prompt_injection_indicators,
      'prompt_injection_indicators',
      { maxItems: 50, maxLength: 500 },
    ).map((item, index) => requireOpaqueRef(
      item,
      `prompt_injection_indicators[${index}]`,
      { maxLength: 500 },
    )).sort(),
    owner_policy: normalizeOwnerPolicy(input.owner_policy),
  };

  let level = 'LOW';
  const reasons = [];

  if (['failed', 'unknown', 'untrusted'].includes(normalized.mcp_server_trust)) {
    level = promote(level, 'HIGH');
    reasons.push(reason(
      'mcp_server_not_trusted',
      'HIGH',
      40,
      `MCP trust state is ${normalized.mcp_server_trust}`,
    ));
  } else if (normalized.mcp_server_trust === 'reachable') {
    level = promote(level, 'ELEVATED');
    reasons.push(reason(
      'mcp_server_reachable_not_verified',
      'ELEVATED',
      15,
      'Reachability is not a trust verification',
    ));
  }

  if (normalized.mcp_phase && normalized.mcp_phase !== 'tools/call') {
    if (normalized.mcp_server_trust !== 'verified') {
      level = promote(level, 'HIGH');
      reasons.push(reason(
        'instruction_bearing_pre_call_content',
        'HIGH',
        35,
        `${normalized.mcp_phase} can return instruction-bearing content before a tool call`,
      ));
    } else {
      level = promote(level, 'ELEVATED');
      reasons.push(reason(
        'mcp_pre_call_content',
        'ELEVATED',
        10,
        `${normalized.mcp_phase} crosses an external content boundary`,
      ));
    }
  }

  for (const capability of IRREVERSIBLE_CAPABILITIES) {
    if (!normalized.capabilities[capability]) continue;
    level = 'IRREVERSIBLE';
    reasons.push(reason(
      `capability_${capability}`,
      'IRREVERSIBLE',
      100,
      `${capability} can create an external or difficult-to-reverse effect`,
    ));
  }

  if (normalized.tool_annotations.destructive_hint) {
    level = 'IRREVERSIBLE';
    reasons.push(reason(
      'tool_destructive_hint',
      'IRREVERSIBLE',
      100,
      'The tool declares a destructive effect',
    ));
  }

  for (const capability of HIGH_CAPABILITIES) {
    if (!normalized.capabilities[capability]) continue;
    level = promote(level, 'HIGH');
    reasons.push(reason(
      `capability_${capability}`,
      'HIGH',
      40,
      `${capability} requires isolation or fail-closed review`,
    ));
  }

  if (normalized.capabilities.network_access) {
    level = promote(level, 'ELEVATED');
    reasons.push(reason(
      'capability_network_access',
      'ELEVATED',
      15,
      'Outbound network access expands the interaction boundary',
    ));
  }

  if (normalized.capabilities.filesystem_read) {
    level = promote(level, 'ELEVATED');
    reasons.push(reason(
      'capability_filesystem_read',
      'ELEVATED',
      10,
      'Filesystem reads can expose private parent state',
    ));
  }

  if (normalized.tool_annotations.open_world_hint && normalized.mcp_phase === 'tools/call') {
    level = promote(level, 'ELEVATED');
    reasons.push(reason(
      'tool_open_world_hint',
      'ELEVATED',
      10,
      'The tool may interact with an open-world target',
    ));
  }

  if (normalized.prompt_injection_indicators.length > 0) {
    level = promote(level, 'HIGH');
    reasons.push(reason(
      'prompt_injection_indicators',
      'HIGH',
      50,
      `${normalized.prompt_injection_indicators.length} prompt-injection indicator(s) were supplied`,
    ));
  }

  level = promote(level, normalized.owner_policy.minimum_level);
  if (normalized.owner_policy.minimum_level !== 'LOW') {
    reasons.push(reason(
      'owner_policy_minimum_level',
      normalized.owner_policy.minimum_level,
      0,
      `Owner policy sets a minimum level of ${normalized.owner_policy.minimum_level}`,
    ));
  }
  if (normalized.owner_policy.force_risk_fork) {
    level = promote(level, 'HIGH');
    reasons.push(reason(
      'owner_policy_force_risk_fork',
      'HIGH',
      0,
      'Owner policy requires a Risk Fork',
    ));
  }

  reasons.sort((left, right) => (
    LEVEL_RANK[right.level] - LEVEL_RANK[left.level]
      || right.weight - left.weight
      || left.code.localeCompare(right.code)
  ));

  const blocked = level === 'IRREVERSIBLE' && normalized.owner_policy.deny_irreversible;
  const score = Math.min(100, reasons.reduce((total, item) => total + item.weight, 0));
  const inputHash = sha256Ref(normalized);
  const decision = {
    schema: 'agoragentic.risk-fork.risk-decision.v1',
    level,
    action: blocked ? 'DENY' : RISK_ACTIONS[level],
    blocked,
    score,
    isolation_boundary: level === 'LOW'
      ? 'none'
      : normalized.mcp_phase && normalized.mcp_phase !== 'tools/call'
        ? 'before_remote_connect'
        : 'before_execution',
    reasons,
    input_hash: inputHash,
    normalized_input: normalized,
    decision_hash: null,
    classifier: {
      name: 'agoragentic-risk-fork-deterministic-v1',
      llm_boundary: 'none',
    },
  };
  decision.decision_hash = sha256Ref({ ...decision, decision_hash: null });
  return deepFreeze(decision);
}

export function riskDecisionCanonicalBytes(decision) {
  assertPlainObject(decision, 'decision');
  return canonicalize({ ...decision, decision_hash: null });
}

export function verifyRiskDecision(decision) {
  assertCanonicalJson(decision);
  assertPlainObject(decision, 'risk decision');
  assertAllowedKeys(decision, [
    'schema',
    'level',
    'action',
    'blocked',
    'score',
    'isolation_boundary',
    'reasons',
    'input_hash',
    'normalized_input',
    'decision_hash',
    'classifier',
  ], 'risk decision');
  if (decision.schema !== 'agoragentic.risk-fork.risk-decision.v1') {
    throw new TypeError('risk decision schema is invalid');
  }
  assertPlainObject(decision.normalized_input, 'risk decision.normalized_input');
  const normalized = decision.normalized_input;
  const input = {
    ...(normalized.request_id === null ? {} : { request_id: normalized.request_id }),
    ...(normalized.mcp_phase === null ? {} : { mcp_phase: normalized.mcp_phase }),
    ...(normalized.mcp_server_ref === null
      ? {}
      : { mcp_server_ref: normalized.mcp_server_ref }),
    ...(normalized.mcp_server_origin === null
      ? {}
      : { mcp_server_origin: normalized.mcp_server_origin }),
    mcp_server_trust: normalized.mcp_server_trust,
    ...(normalized.tool_name === null ? {} : { tool_name: normalized.tool_name }),
    tool_annotations: {
      readOnlyHint: normalized.tool_annotations?.read_only_hint,
      destructiveHint: normalized.tool_annotations?.destructive_hint,
      idempotentHint: normalized.tool_annotations?.idempotent_hint,
      openWorldHint: normalized.tool_annotations?.open_world_hint,
    },
    capabilities: normalized.capabilities,
    prompt_injection_indicators: normalized.prompt_injection_indicators,
    owner_policy: normalized.owner_policy,
  };
  const rebuilt = classifyRisk(input);
  if (canonicalize(rebuilt) !== canonicalize(decision)) {
    throw new Error('Risk decision does not satisfy the deterministic closed contract');
  }
  return true;
}
