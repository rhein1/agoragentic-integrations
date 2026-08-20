import { assertCanonicalJson, canonicalize, sha256Ref } from './canonical.mjs';
import { MCP_PHASES, RISK_ACTIONS, RISK_LEVELS } from './constants.mjs';
import {
  assertAllowedKeys,
  assertPlainObject,
  deepFreeze,
  requireEnum,
  requireExternalEndpoint,
  requireIsoDate,
  requireMcpMethodName,
  requireOpaqueRef,
  requireSha256Ref,
  safeEqual,
  uniqueStrings,
} from './util.mjs';

const TRUST_STATES = Object.freeze(['verified', 'reachable', 'failed', 'unknown', 'untrusted']);
const trustedServerVerifierCallbacks = new WeakMap();
const INTERNAL_EVALUATION_MODES = Object.freeze({
  AUTHORITATIVE_CLOCK: 'authoritative_clock',
  VERIFIED_DECISION_REPLAY: 'verified_decision_replay',
});

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

function authoritativeClockTime(clock) {
  const readClock = clock ?? (() => new Date());
  if (typeof readClock !== 'function') {
    throw new TypeError('risk classifier clock must be a synchronous function');
  }
  const value = readClock();
  if (value && typeof value.then === 'function') {
    throw new TypeError('risk classifier clock must be synchronous');
  }
  return requireIsoDate(value, 'risk classifier clock result');
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

function normalizeServerAttestation(value) {
  if (value === undefined || value === null) return null;
  assertAllowedKeys(value, [
    'schema',
    'status',
    'server_ref',
    'server_origin',
    'attestor_ref',
    'evidence_hash',
    'issued_at',
    'expires_at',
    'trust_registry_version',
    'signature_ref',
    'signature_hash',
    'attestation_hash',
  ], 'mcp_server_attestation');
  if (value.schema !== 'agoragentic.risk-fork.mcp-server-attestation.v1') {
    throw new TypeError('mcp_server_attestation.schema is invalid');
  }
  return {
    schema: value.schema,
    status: requireEnum(
      value.status,
      ['verified'],
      'mcp_server_attestation.status',
    ),
    server_ref: requireOpaqueRef(
      value.server_ref,
      'mcp_server_attestation.server_ref',
    ),
    server_origin: requireExternalEndpoint(
      value.server_origin,
      'mcp_server_attestation.server_origin',
    ),
    attestor_ref: requireOpaqueRef(
      value.attestor_ref,
      'mcp_server_attestation.attestor_ref',
    ),
    evidence_hash: requireSha256Ref(
      value.evidence_hash,
      'mcp_server_attestation.evidence_hash',
    ),
    issued_at: requireIsoDate(value.issued_at, 'mcp_server_attestation.issued_at'),
    expires_at: requireIsoDate(value.expires_at, 'mcp_server_attestation.expires_at'),
    trust_registry_version: requireOpaqueRef(
      value.trust_registry_version,
      'mcp_server_attestation.trust_registry_version',
    ),
    signature_ref: requireOpaqueRef(
      value.signature_ref,
      'mcp_server_attestation.signature_ref',
    ),
    signature_hash: requireSha256Ref(
      value.signature_hash,
      'mcp_server_attestation.signature_hash',
    ),
    attestation_hash: requireSha256Ref(
      value.attestation_hash,
      'mcp_server_attestation.attestation_hash',
    ),
  };
}

function normalizeOwnerPolicy(value = {}) {
  assertAllowedKeys(value, [
    'minimum_level',
    'force_risk_fork',
    'deny_irreversible',
    'trusted_server_refs',
    'trusted_attestor_refs',
    'trusted_attestation_hashes',
    'trust_registry_version',
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
    trusted_attestor_refs: uniqueStrings(
      value.trusted_attestor_refs,
      'owner_policy.trusted_attestor_refs',
    ).map((item, index) => requireOpaqueRef(
      item,
      `owner_policy.trusted_attestor_refs[${index}]`,
    )).sort(),
    trusted_attestation_hashes: uniqueStrings(
      value.trusted_attestation_hashes,
      'owner_policy.trusted_attestation_hashes',
    ).map((item, index) => requireSha256Ref(
      item,
      `owner_policy.trusted_attestation_hashes[${index}]`,
    )).sort(),
    trust_registry_version: value.trust_registry_version == null
      ? null
      : requireOpaqueRef(
        value.trust_registry_version,
        'owner_policy.trust_registry_version',
      ),
    allowed_egress: [...new Set(uniqueStrings(
      value.allowed_egress,
      'owner_policy.allowed_egress',
    ).map((item, index) => requireExternalEndpoint(
      item,
      `owner_policy.allowed_egress[${index}]`,
    )))].sort(),
  };
}

export function createTrustedMcpServerVerifier(verifyServerTrust) {
  if (typeof verifyServerTrust !== 'function') {
    throw new TypeError('verifyServerTrust must be a trusted synchronous callback');
  }
  const boundary = Object.freeze({
    schema: 'agoragentic.risk-fork.trusted-mcp-server-verifier.v1',
    trust_mode: 'trusted_callback',
  });
  trustedServerVerifierCallbacks.set(boundary, verifyServerTrust);
  return boundary;
}

function normalizeTrustedServerVerification(value, request) {
  assertPlainObject(value, 'trusted MCP server verification');
  assertAllowedKeys(value, [
    'schema',
    'status',
    'request_hash',
    'evidence_ref',
    'evidence_hash',
  ], 'trusted MCP server verification');
  if (value.schema !== 'agoragentic.risk-fork.trusted-mcp-server-verification.v1'
    || value.status !== 'verified'
    || !safeEqual(value.request_hash, sha256Ref(request))) {
    throw new Error('Trusted MCP server verifier did not bind the exact verification request');
  }
  return {
    schema: value.schema,
    status: 'verified',
    request_hash: value.request_hash,
    evidence_ref: requireOpaqueRef(value.evidence_ref, 'trusted verification.evidence_ref'),
    evidence_hash: requireSha256Ref(value.evidence_hash, 'trusted verification.evidence_hash'),
  };
}

function assessTrustedServer(normalized, { trustedServerVerifier = null } = {}) {
  const attestation = normalized.mcp_server_attestation;
  if (!attestation) {
    return {
      trusted: false,
      code: 'mcp_server_attestation_missing',
      detail: 'A raw MCP trust label is not a trusted server attestation',
    };
  }
  const attestationStatement = { ...attestation };
  delete attestationStatement.attestation_hash;
  if (!safeEqual(attestation.attestation_hash, sha256Ref(attestationStatement))) {
    return {
      trusted: false,
      code: 'mcp_server_attestation_integrity_failed',
      detail: 'The MCP server attestation hash does not bind its exact statement',
    };
  }
  if (!normalized.mcp_server_ref
    || attestation.server_ref !== normalized.mcp_server_ref) {
    return {
      trusted: false,
      code: 'mcp_server_attestation_ref_mismatch',
      detail: 'The MCP server attestation is for a different server reference',
    };
  }
  if (!normalized.mcp_server_origin
    || attestation.server_origin !== normalized.mcp_server_origin) {
    return {
      trusted: false,
      code: 'mcp_server_attestation_origin_mismatch',
      detail: 'The MCP server attestation is for a different normalized origin',
    };
  }
  if (!normalized.owner_policy.trusted_server_refs.includes(attestation.server_ref)) {
    return {
      trusted: false,
      code: 'mcp_server_not_owner_trusted',
      detail: 'The MCP server reference is outside owner_policy.trusted_server_refs',
    };
  }
  if (!normalized.owner_policy.trusted_attestor_refs.includes(attestation.attestor_ref)) {
    return {
      trusted: false,
      code: 'mcp_server_attestor_not_owner_trusted',
      detail: 'The MCP server attestor is not trusted by owner policy',
    };
  }
  if (!normalized.owner_policy.trusted_attestation_hashes.includes(
    attestation.attestation_hash,
  )) {
    return {
      trusted: false,
      code: 'mcp_server_attestation_not_policy_admitted',
      detail: 'Owner policy has not admitted the exact externally verified attestation hash',
    };
  }
  if (!normalized.owner_policy.trust_registry_version
    || normalized.owner_policy.trust_registry_version !== attestation.trust_registry_version) {
    return {
      trusted: false,
      code: 'mcp_server_trust_registry_mismatch',
      detail: 'The MCP server attestation uses a different trust-registry version',
    };
  }
  if (!normalized.evaluated_at) {
    return {
      trusted: false,
      code: 'mcp_server_attestation_time_unbound',
      detail: 'A deterministic evaluation time is required for attestation freshness',
    };
  }
  const evaluatedAt = Date.parse(normalized.evaluated_at);
  const issuedAt = Date.parse(attestation.issued_at);
  const expiresAt = Date.parse(attestation.expires_at);
  if (expiresAt <= issuedAt || evaluatedAt < issuedAt || evaluatedAt >= expiresAt) {
    return {
      trusted: false,
      code: 'mcp_server_attestation_not_fresh',
      detail: 'The MCP server attestation is not valid at the deterministic evaluation time',
    };
  }
  const verificationRequest = deepFreeze({
    schema: 'agoragentic.risk-fork.trusted-mcp-server-verification-request.v1',
    server_ref: attestation.server_ref,
    server_origin: attestation.server_origin,
    attestation_hash: attestation.attestation_hash,
    owner_policy_hash: sha256Ref(normalized.owner_policy),
    trust_registry_version: attestation.trust_registry_version,
    evaluated_at: normalized.evaluated_at,
  });
  let trustedVerification;
  try {
    const verifyServerTrust = trustedServerVerifierCallbacks.get(trustedServerVerifier);
    if (!verifyServerTrust) {
      return {
        trusted: false,
        code: 'mcp_server_trust_provenance_missing',
        detail: 'Trust-lowering owner policy and attestation require a clean host verifier',
        verification: null,
      };
    }
    const result = verifyServerTrust(verificationRequest);
    if (result && typeof result.then === 'function') {
      throw new TypeError('Trusted MCP server verifier must be synchronous');
    }
    trustedVerification = normalizeTrustedServerVerification(result, verificationRequest);
  } catch {
    return {
      trusted: false,
      code: 'mcp_server_trusted_verifier_rejected',
      detail: 'The clean host verifier did not verify the exact server trust request',
      verification: null,
    };
  }
  return {
    trusted: true,
    code: 'mcp_server_attestation_verified',
    detail: 'Exact server, origin, attestor, policy, integrity, and freshness bindings passed',
    verification: trustedVerification,
  };
}

function promote(current, candidate) {
  return LEVEL_RANK[candidate] > LEVEL_RANK[current] ? candidate : current;
}

function reason(code, level, weight, detail) {
  return { code, level, weight, detail };
}

function classifyRiskInternal(input = {}, options = {}) {
  if (!Object.values(INTERNAL_EVALUATION_MODES).includes(options.evaluationMode)) {
    throw new TypeError('internal risk evaluation mode is invalid');
  }
  const evaluatedAt = requireIsoDate(
    options.evaluatedAt,
    options.evaluationMode === INTERNAL_EVALUATION_MODES.AUTHORITATIVE_CLOCK
      ? 'risk classifier clock result'
      : 'recorded risk decision evaluation time',
  );
  assertAllowedKeys(input, [
    'request_id',
    'mcp_phase',
    'raw_method',
    'mcp_server_ref',
    'mcp_server_origin',
    'mcp_server_trust',
    'mcp_server_attestation',
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
    evaluated_at: evaluatedAt,
    mcp_phase: input.mcp_phase === undefined
      ? null
      : requireEnum(input.mcp_phase, MCP_PHASES, 'mcp_phase'),
    raw_method: input.raw_method == null
      ? null
      : requireMcpMethodName(input.raw_method, 'raw_method'),
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
    mcp_server_attestation: normalizeServerAttestation(input.mcp_server_attestation),
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

  if (normalized.mcp_phase === 'UNKNOWN' && normalized.raw_method === null) {
    throw new TypeError('raw_method is required when mcp_phase is UNKNOWN');
  }
  if (normalized.mcp_phase !== 'UNKNOWN' && normalized.raw_method !== null) {
    throw new TypeError('raw_method is permitted only when mcp_phase is UNKNOWN');
  }

  let level = 'LOW';
  const reasons = [];

  const trustedServer = assessTrustedServer(normalized, options);
  if (!trustedServer.trusted) {
    level = promote(level, 'HIGH');
    reasons.push(reason(
      trustedServer.code,
      'HIGH',
      40,
      trustedServer.detail,
    ));
  } else if (['failed', 'untrusted'].includes(normalized.mcp_server_trust)) {
    level = promote(level, 'HIGH');
    reasons.push(reason(
      'mcp_server_negative_observation',
      'HIGH',
      40,
      `MCP trust state is ${normalized.mcp_server_trust} despite bound attestation evidence`,
    ));
  }

  if (normalized.mcp_phase && normalized.mcp_phase !== 'tools/call') {
    const method = normalized.mcp_phase === 'UNKNOWN'
      ? normalized.raw_method
      : normalized.mcp_phase;
    if (!trustedServer.trusted
      || ['failed', 'untrusted'].includes(normalized.mcp_server_trust)
      || normalized.mcp_phase === 'UNKNOWN') {
      level = promote(level, 'HIGH');
      reasons.push(reason(
        'instruction_bearing_pre_call_content',
        'HIGH',
        35,
        `${method} can return instruction-bearing content before a tool call`,
      ));
    } else {
      level = promote(level, 'ELEVATED');
      reasons.push(reason(
        'mcp_pre_call_content',
        'ELEVATED',
        10,
        `${method} crosses an external content boundary`,
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
      trusted_server_verification: trustedServer.verification ?? null,
    },
  };
  decision.decision_hash = sha256Ref({ ...decision, decision_hash: null });
  return deepFreeze(decision);
}

export function classifyRisk(input = {}, options = {}) {
  assertAllowedKeys(options, ['trusted_server_verifier', 'clock'], 'risk classifier options');
  return classifyRiskInternal(input, {
    trustedServerVerifier: options.trusted_server_verifier ?? null,
    evaluatedAt: authoritativeClockTime(options.clock),
    evaluationMode: INTERNAL_EVALUATION_MODES.AUTHORITATIVE_CLOCK,
  });
}

export function riskDecisionCanonicalBytes(decision) {
  assertPlainObject(decision, 'decision');
  return canonicalize({ ...decision, decision_hash: null });
}

export function verifyRiskDecision(decision, options = {}) {
  assertAllowedKeys(options, ['trusted_server_verifier'], 'risk decision verifier options');
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
    ...(normalized.raw_method === null ? {} : { raw_method: normalized.raw_method }),
    ...(normalized.mcp_server_ref === null
      ? {}
      : { mcp_server_ref: normalized.mcp_server_ref }),
    ...(normalized.mcp_server_origin === null
      ? {}
      : { mcp_server_origin: normalized.mcp_server_origin }),
    mcp_server_trust: normalized.mcp_server_trust,
    ...(normalized.mcp_server_attestation === null
      ? {}
      : { mcp_server_attestation: normalized.mcp_server_attestation }),
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
  const rebuilt = classifyRiskInternal(input, {
    trustedServerVerifier: options.trusted_server_verifier ?? null,
    evaluatedAt: normalized.evaluated_at,
    evaluationMode: INTERNAL_EVALUATION_MODES.VERIFIED_DECISION_REPLAY,
  });
  if (canonicalize(rebuilt) !== canonicalize(decision)) {
    throw new Error('Risk decision does not satisfy the deterministic closed contract');
  }
  return true;
}
