import { canonicalize, hashValue } from './index.mjs';

export const PRIME_AGENT_PACKAGE_VERSION = '0.1.0-alpha.1';
export const PRIME_AGENT_RUNTIME_REQUEST_SCHEMA = 'agoragentic.agent-os.prime-agent-runtime-request.v1';
export const PRIME_AGENT_RUNTIME_PLAN_SCHEMA = 'agoragentic.agent-os.prime-agent-runtime-plan.v1';
export const PRIME_AGENT_RUNTIME_EVIDENCE_SCHEMA = 'agoragentic.agent-os.prime-agent-runtime-evidence.v1';
export const PRIME_AGENT_RUNTIME_ADAPTER_ID = 'prime-agent-rpc-contract';
export const PRIME_AGENT_RUNTIME_ADAPTER_VERSION = '0.2.0-alpha.0';
export const PRIME_AGENT_COMMAND_PREVIEW = Object.freeze([
  'prime-agent',
  '--mode',
  'rpc',
  '--session-dir',
  '<AGENT_OS_PRIVATE_SESSION_DIR>',
]);
export const PRIME_AGENT_REQUIRED_RPC_COMMANDS = Object.freeze(['prompt', 'abort', 'get_state', 'observe', 'unobserve']);
export const PRIME_AGENT_HARD_ENFORCEMENT = Object.freeze([
  'sandbox_process_boundary',
  'filesystem_policy',
  'network_egress_policy',
  'credential_broker',
  'payment_adapter',
  'owner_stop_and_revoke',
  'crash_recovery',
  'uncertain_side_effect_reconciliation',
  'transaction_assurance',
]);

const HOST_CONTRACT_BODY = Object.freeze({
  repository: 'PrimeIntellect-ai/prime-agent',
  tag: 'v0.7.1',
  version: '0.7.1',
  commit: '95afd319a78ae017a41241d50b013d656a0685ce',
  node_engine: '>=22.8.0',
  runtime_mode: 'rpc',
  rpc_framing: 'jsonl_lf',
  extension_manifest_key: 'pi.extensions',
  extension_discovery_keyword: 'pi-package',
});
export const PRIME_AGENT_HOST_CONTRACT = Object.freeze({
  ...HOST_CONTRACT_BODY,
  contract_hash: hashValue(HOST_CONTRACT_BODY),
});

const SAFE_REF_PATTERN = /^[A-Za-z0-9._:/@+-]{1,240}$/;
const IDENTIFIER_PATTERN = /^[A-Za-z0-9_.:-]{3,160}$/;
const SHA256_REF_PATTERN = /^sha256:[0-9a-f]{64}$/;
const SECRET_VALUE_PATTERNS = Object.freeze([
  /\bBearer\s+[A-Za-z0-9._~+/=-]{8,}/i,
  /\bamk_[A-Za-z0-9._-]{8,}/i,
  /\bsk-[A-Za-z0-9._-]{8,}/i,
  /\bgh[pousr]_[A-Za-z0-9_]{8,}/i,
  /\bxox[baprs]-[A-Za-z0-9-]{8,}/i,
  /-----BEGIN [A-Z ]*PRIVATE KEY-----/i,
]);
const REQUEST_KEYS = Object.freeze(new Set([
  'schema',
  'owner_id',
  'workspace_id',
  'deployment_id',
  'principal_ref',
  'goal',
  'sandbox_profile_ref',
  'harness_policy_ref',
  'authority_ref',
  'model_ref',
  'provider_ref',
  'credential_profile_ref',
  'runtime_image_ref',
  'runtime_image_digest',
  'extension_ref',
  'extension_integrity_ref',
  'mcp_profile_ref',
  'limits',
  'autonomous',
  'scheduling',
  'receipt_required',
  'transaction_assurance_required',
  'transaction_assurance_ref',
  'public_exposure_mode',
]));
const LIMIT_KEYS = Object.freeze(new Set([
  'max_turns',
  'max_tokens',
  'max_wall_clock_seconds',
  'max_child_agents',
]));
const AUTONOMOUS_KEYS = Object.freeze(new Set(['enabled', 'quality_gate_ref']));
const SCHEDULING_KEYS = Object.freeze(new Set(['heartbeats_enabled', 'schedules_enabled']));
const AUTHORITY_FLAG_KEYS = Object.freeze([
  'adapter_grants_authority',
  'process_spawn_allowed',
  'network_access_allowed',
  'filesystem_write_allowed',
  'credential_access_allowed',
  'payment_allowed',
  'wallet_mutation_allowed',
  'deployment_allowed',
  'publication_allowed',
  'trust_mutation_allowed',
]);
const PLAN_KEYS = Object.freeze(new Set([
  'schema',
  'adapter_id',
  'adapter_version',
  'runtime_provider',
  'runtime_mode',
  'runtime_status',
  'host_contract',
  'request',
  'command_preview',
  'rpc_contract',
  'hard_enforcement_required',
  'integration_refs',
  'decision',
  'review_reasons',
  'launch_allowed',
  'no_spawn',
  'no_network',
  'no_spend',
  'authority_flags',
  'plan_hash',
]));
const RPC_CONTRACT_KEYS = Object.freeze(new Set([
  'framing',
  'stdin_stdout_only',
  'diagnostics_on_stderr',
  'shell',
  'process_spawned',
  'session_dir_is_private_mount',
  'required_commands',
]));
const INTEGRATION_REF_KEYS = Object.freeze(new Set([
  'governance_extension',
  'governance_extension_integrity',
  'mcp_profile',
  'harness_policy',
  'authority',
  'credential_profile',
  'runtime_image',
  'runtime_image_digest',
  'transaction_assurance',
]));
const EVIDENCE_KEYS = Object.freeze(new Set([
  'schema',
  'adapter_id',
  'adapter_version',
  'host_contract_hash',
  'plan_hash',
  'evaluation_hash',
  'decision',
  'blocker_count',
  'review_reason_count',
  'command_hash',
  'policy_ref_hash',
  'sandbox_profile_ref_hash',
  'runtime_image_digest',
  'governance_extension_integrity',
  'runtime_executed',
  'process_spawned',
  'network_used',
  'spend_occurred',
  'authority_granted',
  'public_safe',
  'evidence_hash',
]));

function isObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function assertAllowedKeys(value, allowed, field) {
  if (!isObject(value)) throw new TypeError(`${field} must be an object`);
  const unknown = Object.keys(value).filter((key) => !allowed.has(key));
  if (unknown.length > 0) {
    throw new TypeError(`${field} contains unsupported fields: ${unknown.sort().join(', ')}`);
  }
}

function assertNoSecretValues(value, path = '$', depth = 0) {
  if (depth > 8) throw new TypeError(`runtime request nesting exceeds the supported depth at ${path}`);
  if (value === null || value === undefined || typeof value === 'boolean' || typeof value === 'number') return;
  if (typeof value === 'string') {
    if (SECRET_VALUE_PATTERNS.some((pattern) => pattern.test(value))) {
      throw new TypeError(`raw secret-like value is not allowed at ${path}`);
    }
    return;
  }
  if (Array.isArray(value)) {
    if (value.length > 64) throw new TypeError(`runtime request array is too large at ${path}`);
    value.forEach((entry, index) => assertNoSecretValues(entry, `${path}[${index}]`, depth + 1));
    return;
  }
  if (!isObject(value)) throw new TypeError(`unsupported runtime request value at ${path}`);
  for (const [key, child] of Object.entries(value)) {
    assertNoSecretValues(child, `${path}.${key}`, depth + 1);
  }
}

function boundedText(value, field, maximum, { pattern = null, allowNewlines = false } = {}) {
  const text = value === undefined || value === null ? '' : String(value).trim();
  if (!text) throw new TypeError(`${field} is required`);
  if (text.length > maximum) throw new TypeError(`${field} exceeds the ${maximum} character limit`);
  if (/\u0000/.test(text)) throw new TypeError(`${field} contains a null byte`);
  if (!allowNewlines && /[\r\n]/.test(text)) throw new TypeError(`${field} must be one line`);
  if (pattern && !pattern.test(text)) throw new TypeError(`${field} contains unsupported characters`);
  return text;
}

function requiredIdentifier(value, field) {
  return boundedText(value, field, 160, { pattern: IDENTIFIER_PATTERN });
}

function requiredRef(value, field) {
  return boundedText(value, field, 240, { pattern: SAFE_REF_PATTERN });
}

function optionalRef(value, field) {
  if (value === undefined || value === null || value === '') return null;
  return requiredRef(value, field);
}

function optionalSha256(value, field) {
  if (value === undefined || value === null || value === '') return null;
  const text = boundedText(value, field, 71);
  if (!SHA256_REF_PATTERN.test(text)) throw new TypeError(`${field} must be a sha256 reference`);
  return text;
}

function positiveInteger(value, fallback, field, maximum) {
  const number = value === undefined || value === null ? fallback : Number(value);
  if (!Number.isInteger(number) || number <= 0 || number > maximum) {
    throw new TypeError(`${field} must be an integer between 1 and ${maximum}`);
  }
  return number;
}

function requestReviewReasons(request) {
  const reasons = [];
  if (request.autonomous.enabled) reasons.push('bounded_autonomous_mode_requested');
  if (request.scheduling.heartbeats_enabled) reasons.push('resident_heartbeats_requested');
  if (request.scheduling.schedules_enabled) reasons.push('resident_schedules_requested');
  if (!request.authority_ref) reasons.push('principal_authority_reference_missing');
  if (!request.model_ref || !request.provider_ref) reasons.push('model_or_provider_reference_missing');
  if (!request.credential_profile_ref) reasons.push('credential_profile_reference_missing');
  if (!request.runtime_image_ref || !request.runtime_image_digest) reasons.push('runtime_image_pin_missing');
  if (!request.extension_integrity_ref) reasons.push('governance_extension_integrity_missing');
  return reasons;
}

export function buildPrimeAgentRuntimeRequest(input = {}) {
  if (!isObject(input)) throw new TypeError('runtime request must be an object');
  if (input.payment_policy?.paid_actions_enabled === true || input.spend_enabled === true) {
    throw new TypeError('paid actions are not enabled by the Prime Agent source integration');
  }
  assertAllowedKeys(input, REQUEST_KEYS, 'runtime request');
  if (input.schema !== undefined && input.schema !== PRIME_AGENT_RUNTIME_REQUEST_SCHEMA) {
    throw new TypeError(`runtime request schema must be ${PRIME_AGENT_RUNTIME_REQUEST_SCHEMA}`);
  }
  const limits = input.limits ?? {};
  const autonomous = input.autonomous ?? {};
  const scheduling = input.scheduling ?? {};
  assertAllowedKeys(limits, LIMIT_KEYS, 'limits');
  assertAllowedKeys(autonomous, AUTONOMOUS_KEYS, 'autonomous');
  assertAllowedKeys(scheduling, SCHEDULING_KEYS, 'scheduling');
  assertNoSecretValues(input);

  if ((input.public_exposure_mode ?? 'private_only') !== 'private_only') {
    throw new TypeError('public_exposure_mode must be private_only for the source integration');
  }

  return Object.freeze({
    schema: PRIME_AGENT_RUNTIME_REQUEST_SCHEMA,
    owner_id: requiredIdentifier(input.owner_id, 'owner_id'),
    workspace_id: requiredIdentifier(input.workspace_id, 'workspace_id'),
    deployment_id: requiredIdentifier(input.deployment_id, 'deployment_id'),
    principal_ref: requiredRef(input.principal_ref, 'principal_ref'),
    goal: boundedText(input.goal, 'goal', 4000, { allowNewlines: true }),
    sandbox_profile_ref: requiredRef(input.sandbox_profile_ref, 'sandbox_profile_ref'),
    harness_policy_ref: requiredRef(input.harness_policy_ref, 'harness_policy_ref'),
    authority_ref: optionalRef(input.authority_ref, 'authority_ref'),
    model_ref: optionalRef(input.model_ref, 'model_ref'),
    provider_ref: optionalRef(input.provider_ref, 'provider_ref'),
    credential_profile_ref: optionalRef(input.credential_profile_ref, 'credential_profile_ref'),
    runtime_image_ref: optionalRef(input.runtime_image_ref, 'runtime_image_ref'),
    runtime_image_digest: optionalSha256(input.runtime_image_digest, 'runtime_image_digest'),
    extension_ref: optionalRef(input.extension_ref, 'extension_ref')
      || `package:@agoragentic/prime-agent@${PRIME_AGENT_PACKAGE_VERSION}`,
    extension_integrity_ref: optionalSha256(input.extension_integrity_ref, 'extension_integrity_ref'),
    mcp_profile_ref: optionalRef(input.mcp_profile_ref, 'mcp_profile_ref')
      || 'mcp-profile:agoragentic-private-v1',
    limits: Object.freeze({
      max_turns: positiveInteger(limits.max_turns, 20, 'limits.max_turns', 500),
      max_tokens: positiveInteger(limits.max_tokens, 200000, 'limits.max_tokens', 10000000),
      max_wall_clock_seconds: positiveInteger(
        limits.max_wall_clock_seconds,
        3600,
        'limits.max_wall_clock_seconds',
        86400,
      ),
      max_child_agents: positiveInteger(limits.max_child_agents, 4, 'limits.max_child_agents', 64),
    }),
    autonomous: Object.freeze({
      enabled: autonomous.enabled === true,
      quality_gate_ref: optionalRef(autonomous.quality_gate_ref, 'autonomous.quality_gate_ref'),
    }),
    scheduling: Object.freeze({
      heartbeats_enabled: scheduling.heartbeats_enabled === true,
      schedules_enabled: scheduling.schedules_enabled === true,
    }),
    receipt_required: input.receipt_required !== false,
    transaction_assurance_required: input.transaction_assurance_required !== false,
    transaction_assurance_ref: optionalRef(
      input.transaction_assurance_ref,
      'transaction_assurance_ref',
    ) || 'schema:agoragentic.transaction-assurance-envelope.v1',
    public_exposure_mode: 'private_only',
  });
}

function removeHash(value, field) {
  if (!isObject(value)) return null;
  const copy = { ...value };
  delete copy[field];
  return copy;
}

function exactFalseAuthorityFlags(value) {
  if (!isObject(value)) return false;
  const keys = Object.keys(value).sort();
  const expected = [...AUTHORITY_FLAG_KEYS].sort();
  return canonicalize(keys) === canonicalize(expected)
    && expected.every((key) => value[key] === false);
}

export function validatePrimeAgentRuntimePlan(plan) {
  const blockers = [];
  if (!isObject(plan) || plan.schema !== PRIME_AGENT_RUNTIME_PLAN_SCHEMA) {
    blockers.push('plan_schema_invalid');
  }
  if (isObject(plan)) {
    try {
      assertAllowedKeys(plan, PLAN_KEYS, 'runtime plan');
      assertAllowedKeys(plan.rpc_contract, RPC_CONTRACT_KEYS, 'runtime plan rpc_contract');
      assertAllowedKeys(plan.integration_refs, INTEGRATION_REF_KEYS, 'runtime plan integration_refs');
      assertNoSecretValues(plan);
    } catch {
      blockers.push('plan_contract_not_closed');
    }
  }
  const expectedPlanHash = isObject(plan) ? hashValue(removeHash(plan, 'plan_hash')) : null;
  if (!isObject(plan) || !SHA256_REF_PATTERN.test(String(plan.plan_hash || '')) || plan.plan_hash !== expectedPlanHash) {
    blockers.push('plan_hash_mismatch');
  }
  if (
    plan?.adapter_id !== PRIME_AGENT_RUNTIME_ADAPTER_ID
    || plan?.adapter_version !== PRIME_AGENT_RUNTIME_ADAPTER_VERSION
  ) {
    blockers.push('adapter_contract_mismatch');
  }
  if (canonicalize(plan?.host_contract) !== canonicalize(PRIME_AGENT_HOST_CONTRACT)) {
    blockers.push('prime_agent_host_contract_mismatch');
  }
  if (canonicalize(plan?.command_preview) !== canonicalize(PRIME_AGENT_COMMAND_PREVIEW)) {
    blockers.push('command_preview_mismatch');
  }
  if (
    plan?.rpc_contract?.framing !== 'jsonl_lf'
    || plan?.rpc_contract?.stdin_stdout_only !== true
    || plan?.rpc_contract?.diagnostics_on_stderr !== true
    || plan?.rpc_contract?.shell !== false
    || plan?.rpc_contract?.process_spawned !== false
    || plan?.rpc_contract?.session_dir_is_private_mount !== true
    || canonicalize(plan?.rpc_contract?.required_commands) !== canonicalize(PRIME_AGENT_REQUIRED_RPC_COMMANDS)
  ) {
    blockers.push('rpc_contract_mismatch');
  }
  if (canonicalize(plan?.hard_enforcement_required) !== canonicalize(PRIME_AGENT_HARD_ENFORCEMENT)) {
    blockers.push('hard_enforcement_contract_mismatch');
  }
  if (
    plan?.runtime_provider !== 'prime-agent'
    || plan?.runtime_mode !== 'rpc'
    || plan?.runtime_status !== 'contract_only'
  ) {
    blockers.push('runtime_contract_mismatch');
  }
  if (
    plan?.launch_allowed !== false
    || plan?.no_spawn !== true
    || plan?.no_network !== true
    || plan?.no_spend !== true
  ) {
    blockers.push('execution_boundary_broken');
  }
  if (!exactFalseAuthorityFlags(plan?.authority_flags)) blockers.push('authority_boundary_broken');

  let request = null;
  try {
    request = buildPrimeAgentRuntimeRequest(plan?.request);
    if (canonicalize(request) !== canonicalize(plan.request)) blockers.push('request_contract_not_normalized');
  } catch {
    blockers.push('request_contract_invalid');
  }
  if (request) {
    const expectedReasons = requestReviewReasons(request);
    const expectedDecision = expectedReasons.length ? 'review_required' : 'preview_ready';
    if (canonicalize(plan.review_reasons) !== canonicalize(expectedReasons)) blockers.push('review_reasons_mismatch');
    if (plan.decision !== expectedDecision) blockers.push('plan_decision_mismatch');
    if (request.receipt_required !== true) blockers.push('receipt_requirement_missing');
    if (request.transaction_assurance_required !== true) blockers.push('transaction_assurance_requirement_missing');
    const expectedRefs = {
      governance_extension: request.extension_ref,
      governance_extension_integrity: request.extension_integrity_ref,
      mcp_profile: request.mcp_profile_ref,
      harness_policy: request.harness_policy_ref,
      authority: request.authority_ref,
      credential_profile: request.credential_profile_ref,
      runtime_image: request.runtime_image_ref,
      runtime_image_digest: request.runtime_image_digest,
      transaction_assurance: request.transaction_assurance_required ? request.transaction_assurance_ref : null,
    };
    if (canonicalize(plan.integration_refs) !== canonicalize(expectedRefs)) {
      blockers.push('integration_reference_mismatch');
    }
  }

  return Object.freeze({
    schema: 'agoragentic.prime-agent.runtime-plan-validation.v1',
    valid: blockers.length === 0,
    blockers: Object.freeze(blockers),
    plan_hash: plan?.plan_hash || null,
    expected_plan_hash: expectedPlanHash,
    host_contract_hash: PRIME_AGENT_HOST_CONTRACT.contract_hash,
    runtime_verified: false,
    runtime_executed: false,
    authority_granted: false,
  });
}

export function validatePrimeAgentRuntimeEvidence(evidence, plan) {
  const blockers = [];
  const planValidation = validatePrimeAgentRuntimePlan(plan);
  if (!planValidation.valid) blockers.push('runtime_plan_invalid');
  if (!isObject(evidence) || evidence.schema !== PRIME_AGENT_RUNTIME_EVIDENCE_SCHEMA) {
    blockers.push('evidence_schema_invalid');
  }
  if (isObject(evidence)) {
    try {
      assertAllowedKeys(evidence, EVIDENCE_KEYS, 'runtime evidence');
      assertNoSecretValues(evidence);
    } catch {
      blockers.push('evidence_contract_not_closed');
    }
  }
  const expectedEvidenceHash = isObject(evidence) ? hashValue(removeHash(evidence, 'evidence_hash')) : null;
  if (
    !isObject(evidence)
    || !SHA256_REF_PATTERN.test(String(evidence.evidence_hash || ''))
    || evidence.evidence_hash !== expectedEvidenceHash
  ) {
    blockers.push('evidence_hash_mismatch');
  }
  if (evidence?.plan_hash !== plan?.plan_hash) blockers.push('evidence_plan_hash_mismatch');
  if (
    evidence?.adapter_id !== PRIME_AGENT_RUNTIME_ADAPTER_ID
    || evidence?.adapter_version !== PRIME_AGENT_RUNTIME_ADAPTER_VERSION
  ) {
    blockers.push('evidence_adapter_contract_mismatch');
  }
  if (evidence?.host_contract_hash !== PRIME_AGENT_HOST_CONTRACT.contract_hash) {
    blockers.push('evidence_host_contract_mismatch');
  }
  if (!SHA256_REF_PATTERN.test(String(evidence?.evaluation_hash || ''))) {
    blockers.push('evidence_evaluation_hash_invalid');
  }
  if (evidence?.decision !== plan?.decision) blockers.push('evidence_decision_mismatch');
  if (
    evidence?.blocker_count !== 0
    || evidence?.review_reason_count !== (Array.isArray(plan?.review_reasons) ? plan.review_reasons.length : -1)
  ) {
    blockers.push('evidence_counts_mismatch');
  }
  if (evidence?.command_hash !== hashValue(plan?.command_preview)) blockers.push('evidence_command_hash_mismatch');
  if (evidence?.policy_ref_hash !== hashValue(plan?.request?.harness_policy_ref)) {
    blockers.push('evidence_policy_hash_mismatch');
  }
  if (evidence?.sandbox_profile_ref_hash !== hashValue(plan?.request?.sandbox_profile_ref)) {
    blockers.push('evidence_sandbox_hash_mismatch');
  }
  if (evidence?.runtime_image_digest !== plan?.request?.runtime_image_digest) {
    blockers.push('evidence_runtime_image_mismatch');
  }
  if (evidence?.governance_extension_integrity !== plan?.request?.extension_integrity_ref) {
    blockers.push('evidence_governance_extension_mismatch');
  }
  if (
    evidence?.runtime_executed !== false
    || evidence?.process_spawned !== false
    || evidence?.network_used !== false
    || evidence?.spend_occurred !== false
    || evidence?.authority_granted !== false
    || evidence?.public_safe !== true
  ) {
    blockers.push('evidence_boundary_broken');
  }
  return Object.freeze({
    schema: 'agoragentic.prime-agent.runtime-evidence-validation.v1',
    valid: blockers.length === 0,
    blockers: Object.freeze(blockers),
    plan_hash: plan?.plan_hash || null,
    evidence_hash: evidence?.evidence_hash || null,
    runtime_verified: false,
    runtime_executed: false,
    authority_granted: false,
  });
}

export function buildPrimeAgentIntegrationDescriptor() {
  return Object.freeze({
    schema: 'agoragentic.prime-agent.integration-descriptor.v1',
    package_name: '@agoragentic/prime-agent',
    package_version: PRIME_AGENT_PACKAGE_VERSION,
    distribution_status: 'source_only',
    extension_entry: './index.mjs',
    runtime_contract_entry: './runtime-contract.mjs',
    prime_agent_host_contract: PRIME_AGENT_HOST_CONTRACT,
    authority_boundary: Object.freeze({
      grants_authority: false,
      executes_runtime: false,
      injects_credentials: false,
      enables_network: false,
      enables_payments: false,
      publishes_marketplace_listing: false,
    }),
  });
}

export function buildPrimeAgentCompatibilityPacket({ plan, evidence } = {}) {
  const planValidation = validatePrimeAgentRuntimePlan(plan);
  const evidenceValidation = validatePrimeAgentRuntimeEvidence(evidence, plan);
  const body = {
    schema: 'agoragentic.prime-agent.compatibility-packet.v1',
    status: planValidation.valid && evidenceValidation.valid ? 'contract_compatible' : 'blocked',
    package: buildPrimeAgentIntegrationDescriptor(),
    plan_validation: planValidation,
    evidence_validation: evidenceValidation,
    plan_hash: plan?.plan_hash || null,
    evidence_hash: evidence?.evidence_hash || null,
    runtime_verified: false,
    runtime_executed: false,
    authority_granted: false,
    partnership_claimed: false,
  };
  return Object.freeze({ ...body, packet_hash: hashValue(body) });
}
