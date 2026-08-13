import { randomBytes, randomUUID } from 'node:crypto';

import { assertCanonicalJson, canonicalize, sha256Ref } from './canonical.mjs';
import { ACTION_OPERATIONS, COMMIT_TYPES, MCP_PHASES } from './constants.mjs';
import {
  assertAllowedKeys,
  assertPlainObject,
  cloneJson,
  deepFreeze,
  optionalString,
  requireEnum,
  requireExternalEndpoint,
  requireIsoDate,
  requireMcpMethodName,
  requireOpaqueRef,
  requireSha256Ref,
  requireString,
  safeEqual,
  uniqueStrings,
} from './util.mjs';

const SNAPSHOT_MODES = Object.freeze(['none', 'filesystem']);
const VERIFICATION_STATES = Object.freeze(['not_checked', 'verified', 'failed', 'unknown']);
const MAX_CAPSULE_BYTES = 64 * 1024;

function normalizeHashRef(value, field, { required = true } = {}) {
  if (!required && (value === undefined || value === null || value === '')) return null;
  return requireSha256Ref(value, field);
}

function normalizeExternalRefs(value, field, { maxItems = 100 } = {}) {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value) || value.length > maxItems) {
    throw new TypeError(`${field} must be an array with at most ${maxItems} items`);
  }
  const normalized = value.map((item, index) => {
    assertAllowedKeys(item, ['ref', 'digest', 'kind', 'truncation_possible'], `${field}[${index}]`);
    if (item.truncation_possible !== undefined
      && typeof item.truncation_possible !== 'boolean') {
      throw new TypeError(`${field}[${index}].truncation_possible must be a boolean`);
    }
    return {
      ref: requireOpaqueRef(item.ref, `${field}[${index}].ref`),
      digest: requireSha256Ref(item.digest, `${field}[${index}].digest`),
      kind: item.kind == null
        ? null
        : requireOpaqueRef(item.kind, `${field}[${index}].kind`, { maxLength: 100 }),
      truncation_possible: item.truncation_possible === true,
    };
  }).sort((left, right) => left.ref.localeCompare(right.ref));
  for (let index = 1; index < normalized.length; index += 1) {
    if (normalized[index - 1].ref === normalized[index].ref) {
      throw new TypeError(`${field} contains duplicate reference: ${normalized[index].ref}`);
    }
  }
  return normalized;
}

function normalizeRuntimeSnapshot(value = {}) {
  assertAllowedKeys(value, [
    'mode',
    'provider_ref',
    'snapshot_ref',
    'snapshot_hash',
    'sanitization_attestation_ref',
    'sanitization_attestation_hash',
    'verification_status',
  ], 'runtime_snapshot');
  const mode = requireEnum(value.mode ?? 'none', SNAPSHOT_MODES, 'runtime_snapshot.mode');
  const verificationStatus = requireEnum(
    value.verification_status ?? 'not_checked',
    VERIFICATION_STATES,
    'runtime_snapshot.verification_status',
  );
  const normalized = {
    mode,
    provider_ref: value.provider_ref == null ? null : requireOpaqueRef(
      value.provider_ref,
      'runtime_snapshot.provider_ref',
    ),
    snapshot_ref: value.snapshot_ref == null ? null : requireOpaqueRef(
      value.snapshot_ref,
      'runtime_snapshot.snapshot_ref',
    ),
    snapshot_hash: normalizeHashRef(value.snapshot_hash, 'runtime_snapshot.snapshot_hash', { required: false }),
    sanitization_attestation_ref: value.sanitization_attestation_ref == null
      ? null
      : requireOpaqueRef(
        value.sanitization_attestation_ref,
        'runtime_snapshot.sanitization_attestation_ref',
      ),
    sanitization_attestation_hash: normalizeHashRef(
      value.sanitization_attestation_hash,
      'runtime_snapshot.sanitization_attestation_hash',
      { required: false },
    ),
    verification_status: verificationStatus,
  };
  if (mode === 'none' && Object.entries(normalized).some(([key, item]) => (
    !['mode', 'verification_status'].includes(key) && item !== null
  ))) {
    throw new TypeError('runtime_snapshot mode none cannot carry provider or snapshot evidence');
  }
  if (mode === 'none' && verificationStatus !== 'not_checked') {
    throw new TypeError('runtime_snapshot mode none must remain not_checked');
  }
  if (mode !== 'none' && (
    verificationStatus !== 'verified'
    || !normalized.provider_ref
    || !normalized.snapshot_ref
    || !normalized.snapshot_hash
    || !normalized.sanitization_attestation_ref
    || !normalized.sanitization_attestation_hash
  )) {
    throw new TypeError(
      'Runtime snapshots require a verified, hash-bound authority-sanitization attestation',
    );
  }
  return normalized;
}

function normalizeExecutionAuthorization(value = {}) {
  assertAllowedKeys(value, ['ref', 'hash'], 'execution_authorization');
  const normalized = {
    ref: value.ref == null
      ? null
      : requireOpaqueRef(value.ref, 'execution_authorization.ref'),
    hash: value.hash == null
      ? null
      : requireSha256Ref(value.hash, 'execution_authorization.hash'),
  };
  if ((normalized.ref === null) !== (normalized.hash === null)) {
    throw new TypeError('execution_authorization ref and hash must be supplied together');
  }
  return normalized;
}

function normalizeMcpMethod(methodValue, rawMethodValue, field) {
  const method = requireEnum(methodValue, MCP_PHASES, `${field}.method`);
  const rawMethod = rawMethodValue == null
    ? null
    : requireMcpMethodName(rawMethodValue, `${field}.raw_method`);
  if (method === 'UNKNOWN' && rawMethod === null) {
    throw new TypeError(`${field}.raw_method is required when method is UNKNOWN`);
  }
  if (method !== 'UNKNOWN' && rawMethod !== null) {
    throw new TypeError(`${field}.raw_method is permitted only when method is UNKNOWN`);
  }
  return { method, raw_method: rawMethod };
}

function defaultGovernanceRef(kind, hash) {
  return `${kind}:${requireSha256Ref(hash, `${kind} hash`).slice(7, 31)}`;
}

function normalizeGovernance(value = {}) {
  assertAllowedKeys(value, [
    'policy_ref',
    'policy_version',
    'policy_hash',
    'mandate_ref',
    'mandate_version',
    'mandate_hash',
    'budget_policy_ref',
    'budget_version',
    'budget_hash',
    'epoch',
  ], 'governance');
  const policyHash = requireSha256Ref(value.policy_hash, 'governance.policy_hash');
  const mandateHash = normalizeHashRef(
    value.mandate_hash,
    'governance.mandate_hash',
    { required: false },
  );
  const budgetHash = normalizeHashRef(
    value.budget_hash,
    'governance.budget_hash',
    { required: false },
  );
  const normalized = {
    policy_ref: value.policy_ref == null
      ? defaultGovernanceRef('policy', policyHash)
      : requireOpaqueRef(value.policy_ref, 'governance.policy_ref'),
    policy_version: requireOpaqueRef(value.policy_version, 'governance.policy_version'),
    policy_hash: policyHash,
    mandate_ref: value.mandate_ref == null
      ? (mandateHash == null ? null : defaultGovernanceRef('mandate', mandateHash))
      : requireOpaqueRef(value.mandate_ref, 'governance.mandate_ref'),
    mandate_version: value.mandate_version == null
      ? null
      : requireOpaqueRef(value.mandate_version, 'governance.mandate_version'),
    mandate_hash: mandateHash,
    budget_policy_ref: value.budget_policy_ref == null
      ? (budgetHash == null ? null : defaultGovernanceRef('budget-policy', budgetHash))
      : requireOpaqueRef(value.budget_policy_ref, 'governance.budget_policy_ref'),
    budget_version: value.budget_version == null
      ? null
      : requireOpaqueRef(value.budget_version, 'governance.budget_version'),
    budget_hash: budgetHash,
    epoch: value.epoch == null
      ? `governance:${sha256Ref({
        policy_hash: policyHash,
        mandate_hash: mandateHash,
        budget_hash: budgetHash,
      }).slice(7, 31)}`
      : requireOpaqueRef(value.epoch, 'governance.epoch'),
  };
  for (const [label, refValue, versionValue, hashValue] of [
    ['governance mandate', normalized.mandate_ref, normalized.mandate_version, normalized.mandate_hash],
    ['governance budget policy', normalized.budget_policy_ref, normalized.budget_version, normalized.budget_hash],
  ]) {
    const present = [refValue, versionValue, hashValue].map((item) => item !== null);
    if (!present.every((item) => item === present[0])) {
      throw new TypeError(`${label} reference, version, and hash must be supplied together`);
    }
  }
  return normalized;
}

export function createSavepointCapsule(input = {}) {
  assertAllowedKeys(input, [
    'capsule_id',
    'created_at',
    'expires_at',
    'parent',
    'agent_configuration',
    'checkpoint',
    'memory_roots',
    'workspace',
    'governance',
    'receipt_chain_head',
    'proposed_interaction',
    'execution_authorization',
    'allowed_commit_types',
    'authorized_result_schema_hash',
    'runtime_snapshot',
  ], 'savepoint capsule input');

  assertAllowedKeys(input.parent, [
    'agent_id',
    'session_id',
    'state_hash',
    'lineage_ref',
    'lineage_hash',
  ], 'parent');
  assertAllowedKeys(input.agent_configuration, [
    'model_version_hash',
    'system_instruction_hash',
    'tool_manifest_hash',
  ], 'agent_configuration');
  assertAllowedKeys(input.checkpoint, [
    'goal_ref',
    'goal_hash',
    'task_graph_ref',
    'task_graph_hash',
  ], 'checkpoint');
  assertAllowedKeys(input.workspace, ['snapshot_ref', 'digest'], 'workspace');
  assertAllowedKeys(input.proposed_interaction, [
    'mcp_server_ref',
    'mcp_server_origin',
    'mcp_method',
    'raw_method',
    'tool_name',
    'effective_arguments_hash',
    'target_ref',
  ], 'proposed_interaction');

  const proposedMcpMethod = normalizeMcpMethod(
    input.proposed_interaction.mcp_method,
    input.proposed_interaction.raw_method,
    'proposed_interaction',
  );

  const createdAt = requireIsoDate(input.created_at ?? new Date(), 'created_at');
  const expiresAt = requireIsoDate(input.expires_at, 'expires_at');
  if (Date.parse(expiresAt) <= Date.parse(createdAt)) {
    throw new TypeError('expires_at must be after created_at');
  }

  const capsule = {
    schema: 'agoragentic.risk-fork.savepoint-capsule.v1',
    capsule_id: input.capsule_id == null
      ? null
      : requireOpaqueRef(input.capsule_id, 'capsule_id', { maxLength: 200 }),
    created_at: createdAt,
    expires_at: expiresAt,
    parent: {
      agent_id: requireOpaqueRef(input.parent.agent_id, 'parent.agent_id'),
      session_id: requireOpaqueRef(input.parent.session_id, 'parent.session_id'),
      state_hash: requireSha256Ref(input.parent.state_hash, 'parent.state_hash'),
      lineage_ref: input.parent.lineage_ref == null
        ? null
        : requireOpaqueRef(input.parent.lineage_ref, 'parent.lineage_ref'),
      lineage_hash: normalizeHashRef(input.parent.lineage_hash, 'parent.lineage_hash', { required: false }),
    },
    agent_configuration: {
      model_version_hash: requireSha256Ref(
        input.agent_configuration.model_version_hash,
        'agent_configuration.model_version_hash',
      ),
      system_instruction_hash: requireSha256Ref(
        input.agent_configuration.system_instruction_hash,
        'agent_configuration.system_instruction_hash',
      ),
      tool_manifest_hash: requireSha256Ref(
        input.agent_configuration.tool_manifest_hash,
        'agent_configuration.tool_manifest_hash',
      ),
    },
    checkpoint: {
      goal_ref: requireOpaqueRef(input.checkpoint.goal_ref, 'checkpoint.goal_ref'),
      goal_hash: requireSha256Ref(input.checkpoint.goal_hash, 'checkpoint.goal_hash'),
      task_graph_ref: requireOpaqueRef(input.checkpoint.task_graph_ref, 'checkpoint.task_graph_ref'),
      task_graph_hash: requireSha256Ref(
        input.checkpoint.task_graph_hash,
        'checkpoint.task_graph_hash',
      ),
    },
    memory_roots: normalizeExternalRefs(input.memory_roots, 'memory_roots'),
    workspace: {
      snapshot_ref: requireOpaqueRef(input.workspace.snapshot_ref, 'workspace.snapshot_ref'),
      digest: requireSha256Ref(input.workspace.digest, 'workspace.digest'),
    },
    governance: normalizeGovernance(input.governance),
    receipt_chain_head: requireSha256Ref(input.receipt_chain_head, 'receipt_chain_head'),
    proposed_interaction: {
      mcp_server_ref: requireOpaqueRef(
        input.proposed_interaction.mcp_server_ref,
        'proposed_interaction.mcp_server_ref',
      ),
      mcp_server_origin: requireExternalEndpoint(
        input.proposed_interaction.mcp_server_origin,
        'proposed_interaction.mcp_server_origin',
      ),
      mcp_method: proposedMcpMethod.method,
      raw_method: proposedMcpMethod.raw_method,
      tool_name: input.proposed_interaction.tool_name == null
        ? null
        : requireOpaqueRef(input.proposed_interaction.tool_name, 'proposed_interaction.tool_name'),
      effective_arguments_hash: requireSha256Ref(
        input.proposed_interaction.effective_arguments_hash,
        'proposed_interaction.effective_arguments_hash',
      ),
      target_ref: input.proposed_interaction.target_ref == null
        ? null
        : requireOpaqueRef(input.proposed_interaction.target_ref, 'proposed_interaction.target_ref'),
    },
    execution_authorization: normalizeExecutionAuthorization(input.execution_authorization),
    allowed_commit_types: uniqueStrings(
      input.allowed_commit_types,
      'allowed_commit_types',
      { maxItems: COMMIT_TYPES.length, maxLength: 100 },
    ).map((value, index) => requireEnum(
      value,
      COMMIT_TYPES,
      `allowed_commit_types[${index}]`,
    )).sort(),
    authorized_result_schema_hash: requireSha256Ref(
      input.authorized_result_schema_hash,
      'authorized_result_schema_hash',
    ),
    runtime_snapshot: normalizeRuntimeSnapshot(input.runtime_snapshot),
    content_boundaries: {
      raw_prompt_included: false,
      raw_conversation_included: false,
      raw_memory_included: false,
      workspace_content_included: false,
      credentials_included: false,
      wallet_material_included: false,
      execution_authority_included: false,
    },
    capsule_hash: null,
  };
  if (capsule.allowed_commit_types.length === 0) {
    throw new TypeError('Savepoint Capsule requires at least one allowed commit type');
  }
  for (const [label, refValue, hashValue] of [
    ['parent lineage', capsule.parent.lineage_ref, capsule.parent.lineage_hash],
  ]) {
    if ((refValue === null) !== (hashValue === null)) {
      throw new TypeError(`${label} reference and hash must be supplied together`);
    }
  }
  if (!capsule.capsule_id) {
    const identitySeed = sha256Ref({ ...capsule, capsule_hash: null });
    capsule.capsule_id = `rfc_${identitySeed.slice(7, 23)}`;
  }
  capsule.capsule_hash = sha256Ref({ ...capsule, capsule_hash: null });
  const capsuleBytes = Buffer.byteLength(canonicalize(capsule), 'utf8');
  if (capsuleBytes > MAX_CAPSULE_BYTES) {
    throw new TypeError(`Savepoint Capsule exceeds ${MAX_CAPSULE_BYTES} bytes`);
  }
  return deepFreeze(capsule);
}

export function verifySavepointCapsule(capsule, options = {}) {
  assertCanonicalJson(capsule);
  assertPlainObject(capsule, 'capsule');
  assertAllowedKeys(capsule, [
    'schema',
    'capsule_id',
    'created_at',
    'expires_at',
    'parent',
    'agent_configuration',
    'checkpoint',
    'memory_roots',
    'workspace',
    'governance',
    'receipt_chain_head',
    'proposed_interaction',
    'execution_authorization',
    'allowed_commit_types',
    'authorized_result_schema_hash',
    'runtime_snapshot',
    'content_boundaries',
    'capsule_hash',
  ], 'capsule');
  if (capsule.schema !== 'agoragentic.risk-fork.savepoint-capsule.v1') {
    throw new TypeError('capsule must use agoragentic.risk-fork.savepoint-capsule.v1');
  }
  const directHash = sha256Ref({ ...cloneJson(capsule), capsule_hash: null });
  if (!safeEqual(directHash, capsule.capsule_hash)) {
    throw new Error('Savepoint Capsule hash mismatch');
  }
  const rebuilt = createSavepointCapsule({
    capsule_id: capsule.capsule_id,
    created_at: capsule.created_at,
    expires_at: capsule.expires_at,
    parent: cloneJson(capsule.parent),
    agent_configuration: cloneJson(capsule.agent_configuration),
    checkpoint: cloneJson(capsule.checkpoint),
    memory_roots: cloneJson(capsule.memory_roots),
    workspace: cloneJson(capsule.workspace),
    governance: cloneJson(capsule.governance),
    receipt_chain_head: capsule.receipt_chain_head,
    proposed_interaction: cloneJson(capsule.proposed_interaction),
    execution_authorization: cloneJson(capsule.execution_authorization),
    allowed_commit_types: cloneJson(capsule.allowed_commit_types),
    authorized_result_schema_hash: capsule.authorized_result_schema_hash,
    runtime_snapshot: cloneJson(capsule.runtime_snapshot),
  });
  if (!safeEqual(rebuilt.capsule_hash, capsule.capsule_hash)) {
    throw new Error('Savepoint Capsule content does not satisfy the canonical contract');
  }
  const now = Date.parse(requireIsoDate(options.now ?? new Date(), 'now'));
  if (Date.parse(capsule.created_at) > now) throw new Error('Savepoint Capsule is not yet valid');
  if (options.allowExpired !== true && Date.parse(capsule.expires_at) <= now) {
    throw new Error('Savepoint Capsule is stale');
  }
  if (options.expectedParentAgentId
    && capsule.parent.agent_id !== options.expectedParentAgentId) {
    throw new Error('Savepoint Capsule parent agent mismatch');
  }
  if (options.expectedParentSessionId
    && capsule.parent.session_id !== options.expectedParentSessionId) {
    throw new Error('Savepoint Capsule parent session mismatch');
  }
  if (options.expectedParentStateHash
    && capsule.parent.state_hash !== options.expectedParentStateHash) {
    throw new Error('Savepoint Capsule parent state mismatch');
  }
  if (options.expectedLineageHash
    && capsule.parent.lineage_hash !== options.expectedLineageHash) {
    throw new Error('Savepoint Capsule lineage mismatch');
  }
  return true;
}

export function createForkIdentity(input = {}) {
  assertAllowedKeys(input, ['parent_agent_id', 'parent_session_id', 'issued_at'], 'fork identity input');
  const parentAgentId = requireOpaqueRef(input.parent_agent_id, 'parent_agent_id');
  const parentSessionId = requireOpaqueRef(input.parent_session_id, 'parent_session_id');
  const identity = {
    schema: 'agoragentic.risk-fork.identity.v1',
    parent_agent_id: parentAgentId,
    parent_session_id: parentSessionId,
    fork_agent_id: `fork_agent_${randomUUID()}`,
    session_id: `fork_session_${randomUUID()}`,
    runtime_identity: `fork_runtime_${randomUUID()}`,
    nonce_namespace: `fork_nonce_${randomBytes(24).toString('hex')}`,
    entropy_state_ref: sha256Ref(randomBytes(64).toString('hex')),
    issued_at: requireIsoDate(input.issued_at ?? new Date(), 'issued_at'),
    identity_hash: null,
  };
  identity.identity_hash = sha256Ref({ ...identity, identity_hash: null });
  return deepFreeze(identity);
}

export function assertFreshForkIdentity(identity) {
  assertCanonicalJson(identity);
  assertPlainObject(identity, 'fork identity');
  assertAllowedKeys(identity, [
    'schema',
    'parent_agent_id',
    'parent_session_id',
    'fork_agent_id',
    'session_id',
    'runtime_identity',
    'nonce_namespace',
    'entropy_state_ref',
    'issued_at',
    'identity_hash',
  ], 'fork identity');
  if (identity.schema !== 'agoragentic.risk-fork.identity.v1') {
    throw new TypeError('fork identity schema is invalid');
  }
  for (const field of [
    'parent_agent_id',
    'parent_session_id',
    'fork_agent_id',
    'session_id',
    'runtime_identity',
    'nonce_namespace',
  ]) requireOpaqueRef(identity[field], `fork identity.${field}`);
  requireSha256Ref(identity.entropy_state_ref, 'fork identity.entropy_state_ref');
  requireIsoDate(identity.issued_at, 'fork identity.issued_at');
  if (identity.fork_agent_id === identity.parent_agent_id
    || identity.session_id === identity.parent_session_id) {
    throw new Error('A fork must not inherit parent agent or session identity');
  }
  const expected = sha256Ref({ ...identity, identity_hash: null });
  if (!safeEqual(identity.identity_hash, expected)) throw new Error('Fork identity hash mismatch');
  return true;
}

export function buildExecutionBinding(input = {}) {
  assertAllowedKeys(input, [
    'principal_ref',
    'action_operation',
    'fork_agent_id',
    'session_id',
    'mcp_server_ref',
    'mcp_server_origin',
    'mcp_method',
    'raw_method',
    'tool_name',
    'effective_arguments',
    'effective_arguments_hash',
    'provider_ref',
    'target_ref',
    'amount',
    'currency',
    'payment_rail',
    'policy_ref',
    'policy_version',
    'policy_hash',
    'mandate_ref',
    'mandate_version',
    'mandate_hash',
    'budget_policy_ref',
    'budget_version',
    'budget_hash',
    'governance_epoch',
    'issued_at',
    'not_before',
    'expires_at',
    'nonce',
    'one_use_authorization_id',
    'audience',
    'authorization_ref',
    'authorization_hash',
  ], 'execution binding input');
  if (input.effective_arguments !== undefined && input.effective_arguments_hash !== undefined) {
    const calculated = sha256Ref(input.effective_arguments);
    if (!safeEqual(calculated, input.effective_arguments_hash)) {
      throw new Error('effective_arguments_hash does not match effective_arguments');
    }
  }
  const issuedAt = requireIsoDate(input.issued_at, 'issued_at');
  const notBefore = requireIsoDate(input.not_before, 'not_before');
  const expiresAt = requireIsoDate(input.expires_at, 'expires_at');
  if (Date.parse(notBefore) < Date.parse(issuedAt) || Date.parse(expiresAt) <= Date.parse(notBefore)) {
    throw new TypeError('Execution binding validity window is invalid');
  }
  const bindingMcpMethod = normalizeMcpMethod(
    input.mcp_method,
    input.raw_method,
    'execution binding.mcp',
  );
  const binding = {
    schema: 'agoragentic.risk-fork.execution-binding.v1',
    principal_ref: requireOpaqueRef(input.principal_ref, 'principal_ref'),
    action_operation: requireEnum(
      input.action_operation,
      ACTION_OPERATIONS,
      'action_operation',
    ),
    fork_agent_id: requireOpaqueRef(input.fork_agent_id, 'fork_agent_id'),
    session_id: requireOpaqueRef(input.session_id, 'session_id'),
    mcp: {
      server_ref: requireOpaqueRef(input.mcp_server_ref, 'mcp_server_ref'),
      server_origin: requireExternalEndpoint(input.mcp_server_origin, 'mcp_server_origin'),
      method: bindingMcpMethod.method,
      raw_method: bindingMcpMethod.raw_method,
      tool_name: input.tool_name == null ? null : requireOpaqueRef(input.tool_name, 'tool_name'),
      effective_arguments_hash: input.effective_arguments_hash
        ? requireSha256Ref(input.effective_arguments_hash, 'effective_arguments_hash')
        : sha256Ref(input.effective_arguments ?? {}),
    },
    provider_ref: requireOpaqueRef(input.provider_ref, 'provider_ref'),
    target_ref: input.target_ref == null ? null : requireOpaqueRef(input.target_ref, 'target_ref'),
    commercial: {
      amount: optionalString(input.amount, 'amount', { maxLength: 100 }),
      currency: optionalString(input.currency, 'currency', { maxLength: 30 }),
      payment_rail: input.payment_rail == null
        ? null
        : requireOpaqueRef(input.payment_rail, 'payment_rail', { maxLength: 100 }),
    },
    governance: normalizeGovernance({
      policy_ref: input.policy_ref,
      policy_version: input.policy_version,
      policy_hash: input.policy_hash,
      mandate_ref: input.mandate_ref,
      mandate_version: input.mandate_version,
      mandate_hash: input.mandate_hash,
      budget_policy_ref: input.budget_policy_ref,
      budget_version: input.budget_version,
      budget_hash: input.budget_hash,
      epoch: input.governance_epoch,
    }),
    validity: {
      issued_at: issuedAt,
      not_before: notBefore,
      expires_at: expiresAt,
    },
    nonce: requireOpaqueRef(input.nonce, 'nonce', { maxLength: 500 }),
    one_use_authorization_id: requireOpaqueRef(
      input.one_use_authorization_id,
      'one_use_authorization_id',
    ),
    audience: requireOpaqueRef(input.audience, 'audience'),
    authorization_ref: requireOpaqueRef(input.authorization_ref, 'authorization_ref'),
    authorization_hash: requireSha256Ref(input.authorization_hash, 'authorization_hash'),
    binding_hash: null,
    authority_flags: {
      binding_grants_authority: false,
      signature_verified: false,
      one_use_consumed: false,
    },
  };
  const commercialValues = [binding.commercial.amount, binding.commercial.currency, binding.commercial.payment_rail];
  if (commercialValues.some((value) => value !== null)
    && commercialValues.some((value) => value === null)) {
    throw new TypeError('Commercial bindings require amount, currency, and payment_rail together');
  }
  if (binding.commercial.amount && !/^(?:0|[1-9]\d*)(?:\.\d{1,18})?$/.test(binding.commercial.amount)) {
    throw new TypeError('amount must be a canonical non-negative decimal string');
  }
  if (binding.commercial.currency && !/^[A-Z][A-Z0-9]{1,11}$/.test(binding.commercial.currency)) {
    throw new TypeError('currency must be an uppercase currency or asset code');
  }
  binding.binding_hash = sha256Ref({ ...binding, binding_hash: null });
  return deepFreeze(binding);
}

export function verifyExecutionBinding(binding, expected = {}, options = {}) {
  assertCanonicalJson(binding);
  assertPlainObject(binding, 'execution binding');
  assertAllowedKeys(binding, [
    'schema',
    'principal_ref',
    'action_operation',
    'fork_agent_id',
    'session_id',
    'mcp',
    'provider_ref',
    'target_ref',
    'commercial',
    'governance',
    'validity',
    'nonce',
    'one_use_authorization_id',
    'audience',
    'authorization_ref',
    'authorization_hash',
    'binding_hash',
    'authority_flags',
  ], 'execution binding');
  if (binding.schema !== 'agoragentic.risk-fork.execution-binding.v1') {
    throw new TypeError('execution binding schema is invalid');
  }
  assertAllowedKeys(binding.mcp, [
    'server_ref',
    'server_origin',
    'method',
    'raw_method',
    'tool_name',
    'effective_arguments_hash',
  ], 'execution binding.mcp');
  assertAllowedKeys(
    binding.commercial,
    ['amount', 'currency', 'payment_rail'],
    'execution binding.commercial',
  );
  assertAllowedKeys(
    binding.governance,
    [
      'policy_ref',
      'policy_version',
      'policy_hash',
      'mandate_ref',
      'mandate_version',
      'mandate_hash',
      'budget_policy_ref',
      'budget_version',
      'budget_hash',
      'epoch',
    ],
    'execution binding.governance',
  );
  assertAllowedKeys(
    binding.validity,
    ['issued_at', 'not_before', 'expires_at'],
    'execution binding.validity',
  );
  assertAllowedKeys(binding.authority_flags, [
    'binding_grants_authority',
    'signature_verified',
    'one_use_consumed',
  ], 'execution binding.authority_flags');
  const expectedHash = sha256Ref({ ...binding, binding_hash: null });
  if (!safeEqual(binding.binding_hash, expectedHash)) throw new Error('Execution binding hash mismatch');
  const rebuilt = buildExecutionBinding({
    principal_ref: binding.principal_ref,
    action_operation: binding.action_operation,
    fork_agent_id: binding.fork_agent_id,
    session_id: binding.session_id,
    mcp_server_ref: binding.mcp.server_ref,
    mcp_server_origin: binding.mcp.server_origin,
    mcp_method: binding.mcp.method,
    raw_method: binding.mcp.raw_method,
    tool_name: binding.mcp.tool_name,
    effective_arguments_hash: binding.mcp.effective_arguments_hash,
    provider_ref: binding.provider_ref,
    target_ref: binding.target_ref,
    amount: binding.commercial.amount,
    currency: binding.commercial.currency,
    payment_rail: binding.commercial.payment_rail,
    policy_ref: binding.governance.policy_ref,
    policy_version: binding.governance.policy_version,
    policy_hash: binding.governance.policy_hash,
    mandate_ref: binding.governance.mandate_ref,
    mandate_version: binding.governance.mandate_version,
    mandate_hash: binding.governance.mandate_hash,
    budget_policy_ref: binding.governance.budget_policy_ref,
    budget_version: binding.governance.budget_version,
    budget_hash: binding.governance.budget_hash,
    governance_epoch: binding.governance.epoch,
    issued_at: binding.validity.issued_at,
    not_before: binding.validity.not_before,
    expires_at: binding.validity.expires_at,
    nonce: binding.nonce,
    one_use_authorization_id: binding.one_use_authorization_id,
    audience: binding.audience,
    authorization_ref: binding.authorization_ref,
    authorization_hash: binding.authorization_hash,
  });
  if (canonicalize(rebuilt) !== canonicalize(binding)) {
    throw new Error('Execution binding does not satisfy the canonical closed contract');
  }
  const now = Date.parse(requireIsoDate(options.now ?? new Date(), 'now'));
  if (Date.parse(binding.validity.not_before) > now) throw new Error('Execution authorization is not yet valid');
  if (Date.parse(binding.validity.expires_at) <= now) throw new Error('Execution authorization is expired');
  const comparisons = {
    principal_ref: binding.principal_ref,
    action_operation: binding.action_operation,
    fork_agent_id: binding.fork_agent_id,
    session_id: binding.session_id,
    mcp_server_ref: binding.mcp.server_ref,
    mcp_server_origin: binding.mcp.server_origin,
    mcp_method: binding.mcp.method,
    raw_method: binding.mcp.raw_method,
    tool_name: binding.mcp.tool_name,
    effective_arguments_hash: binding.mcp.effective_arguments_hash,
    provider_ref: binding.provider_ref,
    target_ref: binding.target_ref,
    amount: binding.commercial.amount,
    currency: binding.commercial.currency,
    payment_rail: binding.commercial.payment_rail,
    policy_ref: binding.governance.policy_ref,
    policy_version: binding.governance.policy_version,
    policy_hash: binding.governance.policy_hash,
    mandate_ref: binding.governance.mandate_ref,
    mandate_version: binding.governance.mandate_version,
    mandate_hash: binding.governance.mandate_hash,
    budget_policy_ref: binding.governance.budget_policy_ref,
    budget_version: binding.governance.budget_version,
    budget_hash: binding.governance.budget_hash,
    governance_epoch: binding.governance.epoch,
    audience: binding.audience,
    one_use_authorization_id: binding.one_use_authorization_id,
    authorization_ref: binding.authorization_ref,
    authorization_hash: binding.authorization_hash,
  };
  for (const [field, value] of Object.entries(expected)) {
    if (!Object.hasOwn(comparisons, field)) throw new TypeError(`Unsupported binding comparison: ${field}`);
    if (comparisons[field] !== value) throw new Error(`Execution binding mismatch: ${field}`);
  }
  return true;
}

export function networkPolicy(input = {}) {
  assertAllowedKeys(input, ['schema', 'mode', 'allowlist', 'policy_hash'], 'network policy');
  const hasEnvelope = input.schema !== undefined || input.policy_hash !== undefined;
  if (hasEnvelope && input.schema !== 'agoragentic.risk-fork.network-policy.v1') {
    throw new TypeError('network policy schema is invalid');
  }
  const mode = requireEnum(input.mode ?? 'blocked', ['blocked', 'allowlist'], 'network policy.mode');
  const allowlist = [...new Set(uniqueStrings(input.allowlist, 'network policy.allowlist', {
    maxItems: 100,
    maxLength: 500,
  }).map((entry, index) => requireExternalEndpoint(
    entry,
    `network policy.allowlist[${index}]`,
  )))].sort();
  if (mode === 'blocked' && allowlist.length > 0) {
    throw new TypeError('A blocked network policy cannot contain an allowlist');
  }
  if (mode === 'allowlist' && allowlist.length === 0) {
    throw new TypeError('An allowlist network policy requires at least one entry');
  }
  const policyHash = sha256Ref({ mode, allowlist });
  if (hasEnvelope && !safeEqual(
    requireSha256Ref(input.policy_hash, 'network policy.policy_hash'),
    policyHash,
  )) {
    throw new Error('Network policy hash mismatch');
  }
  return deepFreeze({
    schema: 'agoragentic.risk-fork.network-policy.v1',
    mode,
    allowlist,
    policy_hash: policyHash,
  });
}
