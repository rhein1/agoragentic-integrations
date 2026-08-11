import Ajv from 'ajv';
import addFormats from 'ajv-formats';

import { assertCanonicalJson, canonicalize, sha256Ref } from './canonical.mjs';
import { ACTION_OPERATIONS, COMMIT_TYPES } from './constants.mjs';
import { verifyExecutionBinding } from './contracts.mjs';
import {
  assertAllowedKeys,
  assertPlainObject,
  boundedInteger,
  cloneJson,
  deepFreeze,
  isPathAllowed,
  normalizeRelativePath,
  requireEnum,
  requireIsoDate,
  requireOpaqueRef,
  requireSha256Ref,
  requireString,
  safeEqual,
  uniqueStrings,
} from './util.mjs';

const SECRET_PATTERNS = Object.freeze([
  /-----BEGIN (?:RSA |EC |OPENSSH |PGP )?PRIVATE KEY-----/i,
  /\b(?:sk|amk|ghp|github_pat|xox[baprs])-[_a-zA-Z0-9-]{12,}\b/,
  /\b(?:api[_-]?key|access[_-]?token|refresh[_-]?token|private[_-]?key|mnemonic)\s*[:=]\s*['\"]?[^\s'\"]{8,}/i,
  /\b(?:seed phrase|wallet phrase)\s*[:=]/i,
]);

const PROMPT_INJECTION_PATTERNS = Object.freeze([
  /ignore (?:all |any )?(?:previous|prior|system) (?:instructions|messages|prompt)/i,
  /reveal (?:the )?(?:system prompt|hidden instructions|developer message)/i,
  /exfiltrat(?:e|ion)/i,
  /bypass (?:policy|approval|authorization|guardrail)/i,
  /you are now (?:the )?(?:system|developer|administrator)/i,
]);

const FORBIDDEN_CHILD_KEYS = new Set([
  'approval',
  'approved',
  'authorization',
  'authorization_grant',
  'grant',
  'signature',
  'private_key',
  'wallet_private_key',
  'seed_phrase',
  'mnemonic',
  'raw_child_conversation',
  'conversation',
  'messages',
  'parent_memory',
  'memory_update',
]);

function makeAjv() {
  const ajv = new Ajv({
    allErrors: true,
    strict: true,
    allowUnionTypes: false,
  });
  addFormats(ajv);
  return ajv;
}

function walkStrings(value, visitor, limits, state = { nodes: 0 }, path = '$', depth = 0) {
  if (depth > limits.max_depth) {
    throw new TypeError(`Artifact nesting exceeds ${limits.max_depth} levels at ${path}`);
  }
  state.nodes += 1;
  if (state.nodes > limits.max_nodes) {
    throw new TypeError(`Artifact exceeds ${limits.max_nodes} values`);
  }
  if (typeof value === 'string') {
    if (Buffer.byteLength(value, 'utf8') > limits.max_string_bytes) {
      throw new TypeError(`Artifact string exceeds ${limits.max_string_bytes} bytes at ${path}`);
    }
    visitor(value, path);
    return;
  }
  if (Array.isArray(value)) {
    for (const [index, item] of value.entries()) {
      walkStrings(item, visitor, limits, state, `${path}[${index}]`, depth + 1);
    }
    return;
  }
  if (!value || typeof value !== 'object') return;
  for (const [key, child] of Object.entries(value)) {
    if (FORBIDDEN_CHILD_KEYS.has(key.toLowerCase())) {
      throw new Error(`Child artifact cannot carry trusted authority or memory field: ${path}.${key}`);
    }
    walkStrings(child, visitor, limits, state, `${path}.${key}`, depth + 1);
  }
}

function scanText(value, policy) {
  const findings = [];
  walkStrings(value, (text, path) => {
    for (const pattern of SECRET_PATTERNS) {
      if (pattern.test(text)) findings.push({ code: 'secret_pattern', path });
    }
    if (!policy.allow_prompt_injection_text) {
      for (const pattern of PROMPT_INJECTION_PATTERNS) {
        if (pattern.test(text)) findings.push({ code: 'prompt_injection_pattern', path });
      }
    }
  }, policy);
  return findings;
}

function assertClosedLocalSchema(schema) {
  const seen = new WeakSet();
  function visit(value, path = '$') {
    if (!value || typeof value !== 'object') return;
    if (seen.has(value)) throw new TypeError(`Typed result schema contains a cycle at ${path}`);
    seen.add(value);
    try {
      if (Array.isArray(value)) {
        value.forEach((item, index) => visit(item, `${path}[${index}]`));
        return;
      }
      for (const keyword of ['$ref', '$dynamicRef']) {
        if (Object.hasOwn(value, keyword)
          && (typeof value[keyword] !== 'string' || !value[keyword].startsWith('#'))) {
          throw new TypeError(`Typed result schema forbids remote ${keyword} at ${path}`);
        }
      }
      if (value.type === 'object' && value.additionalProperties !== false) {
        throw new TypeError(`Typed result object schema must set additionalProperties:false at ${path}`);
      }
      for (const [key, child] of Object.entries(value)) visit(child, `${path}.${key}`);
    } finally {
      seen.delete(value);
    }
  }
  if (schema.type !== 'object' || schema.additionalProperties !== false) {
    throw new TypeError('Typed result schema must be a closed top-level object schema');
  }
  visit(schema);
}

function normalizePolicy(value = {}) {
  assertAllowedKeys(value, [
    'path_allowlist',
    'max_diff_bytes',
    'max_files',
    'allow_delete',
    'allow_prompt_injection_text',
    'typed_result_schema_hash',
    'required_tests',
    'max_typed_result_bytes',
    'max_string_bytes',
    'max_depth',
    'max_nodes',
  ], 'commit policy');
  return {
    path_allowlist: uniqueStrings(value.path_allowlist, 'commit policy.path_allowlist'),
    max_diff_bytes: boundedInteger(
      value.max_diff_bytes ?? 256 * 1024,
      'commit policy.max_diff_bytes',
      { min: 1, max: 16 * 1024 * 1024 },
    ),
    max_files: boundedInteger(value.max_files ?? 100, 'commit policy.max_files', { min: 1, max: 10_000 }),
    allow_delete: value.allow_delete === true,
    allow_prompt_injection_text: value.allow_prompt_injection_text === true,
    typed_result_schema_hash: value.typed_result_schema_hash === undefined
      ? null
      : requireSha256Ref(value.typed_result_schema_hash, 'commit policy.typed_result_schema_hash'),
    required_tests: uniqueStrings(value.required_tests, 'commit policy.required_tests'),
    max_typed_result_bytes: boundedInteger(
      value.max_typed_result_bytes ?? 256 * 1024,
      'commit policy.max_typed_result_bytes',
      { min: 1, max: 16 * 1024 * 1024 },
    ),
    max_string_bytes: boundedInteger(
      value.max_string_bytes ?? 64 * 1024,
      'commit policy.max_string_bytes',
      { min: 1, max: 4 * 1024 * 1024 },
    ),
    max_depth: boundedInteger(value.max_depth ?? 20, 'commit policy.max_depth', { min: 1, max: 64 }),
    max_nodes: boundedInteger(
      value.max_nodes ?? 10_000,
      'commit policy.max_nodes',
      { min: 1, max: 100_000 },
    ),
  };
}

function buildArtifact({ commitType, sourceForkId, validatedAt, body, validation }) {
  const artifact = {
    schema: 'agoragentic.risk-fork.commit-artifact.v1',
    commit_type: commitType,
    source_fork_id: requireString(sourceForkId, 'source_fork_id'),
    taint_status: 'TAINTED_SOURCE_VALIDATED',
    validated_at: validatedAt,
    body,
    validation,
    artifact_hash: null,
    authority_flags: {
      artifact_grants_authority: false,
      child_can_commit: false,
      clean_commit_required: true,
    },
  };
  artifact.artifact_hash = sha256Ref({ ...artifact, artifact_hash: null });
  return deepFreeze(artifact);
}

function validateTypedResult(candidate, context) {
  assertAllowedKeys(candidate, ['type', 'payload', 'payload_schema'], 'typed result candidate');
  assertPlainObject(candidate.payload_schema, 'typed result payload_schema');
  assertClosedLocalSchema(candidate.payload_schema);
  const schemaHash = sha256Ref(candidate.payload_schema);
  if (context.policy.typed_result_schema_hash
    && !safeEqual(schemaHash, context.policy.typed_result_schema_hash)) {
    throw new Error('Typed result schema does not match the authorized schema hash');
  }
  const validate = makeAjv().compile(candidate.payload_schema);
  if (!validate(candidate.payload)) {
    const detail = validate.errors
      .map((error) => `${error.instancePath || '/'} ${error.message}`)
      .join('; ');
    throw new Error(`Typed result does not satisfy its schema: ${detail}`);
  }
  const payloadBytes = Buffer.byteLength(canonicalize(candidate.payload), 'utf8');
  if (payloadBytes > context.policy.max_typed_result_bytes) {
    throw new Error(`Typed result exceeds ${context.policy.max_typed_result_bytes} bytes`);
  }
  const findings = scanText(candidate.payload, context.policy);
  if (findings.length > 0) throw new Error(`Typed result taint scan failed: ${findings[0].code}`);
  return buildArtifact({
    commitType: 'TYPED_RESULT',
    sourceForkId: context.sourceForkId,
    validatedAt: context.validatedAt,
    body: {
      payload: cloneJson(candidate.payload),
      payload_hash: sha256Ref(candidate.payload),
      payload_schema: cloneJson(candidate.payload_schema),
      payload_schema_hash: schemaHash,
      payload_bytes: payloadBytes,
    },
    validation: {
      schema_valid: true,
      secret_scan: 'passed',
      prompt_injection_scan: 'passed',
      path_scan: 'not_applicable',
      tests: [],
    },
  });
}

function validateWorkspaceDiff(candidate, context) {
  assertAllowedKeys(candidate, ['type', 'files', 'test_evidence'], 'workspace diff candidate');
  if (!Array.isArray(candidate.files) || candidate.files.length > context.policy.max_files) {
    throw new Error(`Workspace diff exceeds ${context.policy.max_files} files`);
  }
  if (context.policy.path_allowlist.length === 0) {
    throw new Error('Workspace diff requires a non-empty path allowlist');
  }
  const seenPaths = new Map();
  const files = candidate.files.map((file, index) => {
    assertAllowedKeys(file, [
      'path',
      'operation',
      'before_hash',
      'after_hash',
      'after_content',
    ], `workspace diff files[${index}]`);
    const relativePath = normalizeRelativePath(file.path, `workspace diff files[${index}].path`);
    if (relativePath === '.git' || relativePath.startsWith('.git/')) {
      throw new Error('Workspace diff cannot modify Git control metadata');
    }
    const foldedPath = relativePath.normalize('NFC').toLocaleLowerCase('en-US');
    const collision = seenPaths.get(foldedPath);
    if (collision) {
      throw new Error(`Workspace diff contains duplicate or case-colliding paths: ${collision} and ${relativePath}`);
    }
    seenPaths.set(foldedPath, relativePath);
    if (!isPathAllowed(relativePath, context.policy.path_allowlist)) {
      throw new Error(`Workspace diff path is not allowlisted: ${relativePath}`);
    }
    const operation = requireEnum(
      file.operation,
      ['create', 'modify', 'delete'],
      `workspace diff files[${index}].operation`,
    );
    if (operation === 'delete' && !context.policy.allow_delete) {
      throw new Error(`Workspace diff deletion is not allowed: ${relativePath}`);
    }
    const beforeHash = file.before_hash === null || file.before_hash === undefined
      ? null
      : requireSha256Ref(file.before_hash, `workspace diff files[${index}].before_hash`);
    if (operation === 'create' && beforeHash !== null) {
      throw new Error(`Created file must not carry before_hash: ${relativePath}`);
    }
    if (operation !== 'create' && beforeHash === null) {
      throw new Error(`${operation} requires before_hash: ${relativePath}`);
    }
    if (operation === 'delete') {
      if (file.after_content !== null && file.after_content !== undefined) {
        throw new Error(`Deleted file must not contain after_content: ${relativePath}`);
      }
      return {
        path: relativePath,
        operation,
        before_hash: beforeHash,
        after_hash: null,
        after_content: null,
        after_bytes: 0,
      };
    }
    if (typeof file.after_content !== 'string') {
      throw new TypeError(`after_content is required for ${operation}: ${relativePath}`);
    }
    const afterHash = sha256Ref(file.after_content);
    if (file.after_hash && !safeEqual(afterHash, file.after_hash)) {
      throw new Error(`Workspace diff after_hash mismatch: ${relativePath}`);
    }
    const findings = scanText(file.after_content, context.policy);
    if (findings.length > 0) throw new Error(`Workspace diff taint scan failed: ${relativePath}`);
    return {
      path: relativePath,
      operation,
      before_hash: beforeHash,
      after_hash: afterHash,
      after_content: file.after_content,
      after_bytes: Buffer.byteLength(file.after_content, 'utf8'),
    };
  }).sort((left, right) => left.path.localeCompare(right.path));
  const totalBytes = files.reduce((sum, file) => sum + file.after_bytes, 0);
  if (totalBytes > context.policy.max_diff_bytes) {
    throw new Error(`Workspace diff exceeds ${context.policy.max_diff_bytes} bytes`);
  }
  if (candidate.test_evidence !== undefined && !Array.isArray(candidate.test_evidence)) {
    throw new TypeError('test_evidence must be an array');
  }
  if ((candidate.test_evidence?.length ?? 0) > 100) {
    throw new TypeError('test_evidence exceeds 100 items');
  }
  const testEvidence = (candidate.test_evidence ?? [])
    .map((item, index) => {
      assertAllowedKeys(
        item,
        ['name', 'status', 'evidence_ref', 'evidence_hash', 'duration_ms'],
        `test_evidence[${index}]`,
      );
      return {
        name: requireOpaqueRef(item.name, `test_evidence[${index}].name`, { maxLength: 200 }),
        status: requireEnum(item.status, ['passed', 'failed'], `test_evidence[${index}].status`),
        evidence_ref: requireOpaqueRef(
          item.evidence_ref,
          `test_evidence[${index}].evidence_ref`,
        ),
        evidence_hash: requireSha256Ref(
          item.evidence_hash,
          `test_evidence[${index}].evidence_hash`,
        ),
        duration_ms: boundedInteger(
          item.duration_ms,
          `test_evidence[${index}].duration_ms`,
          { min: 0, max: 24 * 60 * 60 * 1000 },
        ),
      };
    });
  const observedTests = new Set(testEvidence
    .filter((item) => item && item.status === 'passed' && typeof item.name === 'string')
    .map((item) => item.name));
  for (const required of context.policy.required_tests) {
    if (!observedTests.has(required)) throw new Error(`Required test evidence is missing: ${required}`);
  }
  return buildArtifact({
    commitType: 'WORKSPACE_DIFF',
    sourceForkId: context.sourceForkId,
    validatedAt: context.validatedAt,
    body: {
      files,
      file_count: files.length,
      total_after_bytes: totalBytes,
      diff_hash: sha256Ref(files),
      test_evidence: cloneJson(testEvidence),
    },
    validation: {
      schema_valid: true,
      secret_scan: 'passed',
      prompt_injection_scan: 'passed',
      path_scan: 'passed',
      tests: [...observedTests].sort(),
    },
  });
}

function validateProposal(candidate, context) {
  assertAllowedKeys(candidate, ['type', 'action'], 'action proposal candidate');
  assertPlainObject(candidate.action, 'action proposal action');
  assertAllowedKeys(candidate.action, [
    'operation',
    'target_ref',
    'provider_ref',
    'arguments',
    'amount',
    'currency',
    'payment_rail',
  ], 'action proposal action');
  assertPlainObject(context.executionBinding, 'clean execution binding');
  verifyExecutionBinding(context.executionBinding, context.expectedBinding, {
    now: context.validatedAt,
  });
  const binding = context.executionBinding;
  const rawArguments = candidate.action.arguments ?? {};
  sha256Ref(rawArguments);
  const normalizedAction = {
    operation: requireEnum(candidate.action.operation, ACTION_OPERATIONS, 'action.operation'),
    target_ref: candidate.action.target_ref == null
      ? null
      : requireOpaqueRef(candidate.action.target_ref, 'action.target_ref'),
    provider_ref: requireOpaqueRef(candidate.action.provider_ref, 'action.provider_ref'),
    arguments: cloneJson(rawArguments),
    amount: candidate.action.amount == null
      ? null
      : requireString(candidate.action.amount, 'action.amount', { maxLength: 100 }),
    currency: candidate.action.currency == null
      ? null
      : requireString(candidate.action.currency, 'action.currency', { maxLength: 30 }),
    payment_rail: candidate.action.payment_rail == null
      ? null
      : requireOpaqueRef(candidate.action.payment_rail, 'action.payment_rail'),
  };
  assertPlainObject(normalizedAction.arguments, 'action.arguments');
  const actionComparisons = {
    operation: [normalizedAction.operation, binding.action_operation],
    provider_ref: [normalizedAction.provider_ref, binding.provider_ref],
    target_ref: [normalizedAction.target_ref, binding.target_ref],
    amount: [normalizedAction.amount, binding.commercial.amount],
    currency: [normalizedAction.currency, binding.commercial.currency],
    payment_rail: [normalizedAction.payment_rail, binding.commercial.payment_rail],
  };
  for (const [field, [observed, expected]] of Object.entries(actionComparisons)) {
    if (observed !== expected) throw new Error(`Action proposal binding mismatch: ${field}`);
  }
  const findings = scanText(normalizedAction, context.policy);
  if (findings.length > 0) throw new Error(`Action proposal taint scan failed: ${findings[0].code}`);
  const argumentsHash = sha256Ref(normalizedAction.arguments);
  if (!safeEqual(argumentsHash, binding.mcp.effective_arguments_hash)) {
    throw new Error('Action proposal does not match the authorized effective arguments hash');
  }
  const actionHash = sha256Ref(normalizedAction);
  return buildArtifact({
    commitType: 'CONSEQUENTIAL_ACTION_PROPOSAL',
    sourceForkId: context.sourceForkId,
    validatedAt: context.validatedAt,
    body: {
      action: normalizedAction,
      action_hash: actionHash,
      effective_arguments_hash: argumentsHash,
      execution_binding: cloneJson(binding),
      execution_binding_hash: binding.binding_hash,
    },
    validation: {
      schema_valid: true,
      secret_scan: 'passed',
      prompt_injection_scan: 'passed',
      path_scan: 'not_applicable',
      tests: [],
    },
  });
}

export function validateCommitCandidate(input = {}) {
  assertAllowedKeys(input, [
    'candidate',
    'source_fork_id',
    'policy',
    'expected_binding',
    'execution_binding',
    'validated_at',
  ], 'taint gate input');
  assertCanonicalJson(input.candidate);
  assertPlainObject(input.candidate, 'candidate');
  const type = requireEnum(input.candidate.type, COMMIT_TYPES, 'candidate.type');
  const context = {
    sourceForkId: requireString(input.source_fork_id, 'source_fork_id'),
    policy: normalizePolicy(input.policy),
    expectedBinding: input.expected_binding ?? {},
    executionBinding: input.execution_binding ?? null,
    validatedAt: requireIsoDate(input.validated_at ?? new Date(), 'validated_at'),
  };
  if (type === 'TYPED_RESULT') return validateTypedResult(input.candidate, context);
  if (type === 'WORKSPACE_DIFF') return validateWorkspaceDiff(input.candidate, context);
  return validateProposal(input.candidate, context);
}

export function verifyCommitArtifact(artifact) {
  assertCanonicalJson(artifact);
  assertPlainObject(artifact, 'commit artifact');
  assertAllowedKeys(artifact, [
    'schema',
    'commit_type',
    'source_fork_id',
    'taint_status',
    'validated_at',
    'body',
    'validation',
    'artifact_hash',
    'authority_flags',
  ], 'commit artifact');
  if (artifact.schema !== 'agoragentic.risk-fork.commit-artifact.v1') {
    throw new TypeError('commit artifact schema is invalid');
  }
  requireEnum(artifact.commit_type, COMMIT_TYPES, 'commit artifact.commit_type');
  requireString(artifact.source_fork_id, 'commit artifact.source_fork_id');
  requireIsoDate(artifact.validated_at, 'commit artifact.validated_at');
  if (artifact.taint_status !== 'TAINTED_SOURCE_VALIDATED') {
    throw new Error('Commit artifact must preserve its tainted-source provenance');
  }
  assertAllowedKeys(artifact.authority_flags, [
    'artifact_grants_authority',
    'child_can_commit',
    'clean_commit_required',
  ], 'commit artifact.authority_flags');
  if (artifact.authority_flags.artifact_grants_authority !== false
    || artifact.authority_flags.child_can_commit !== false
    || artifact.authority_flags.clean_commit_required !== true) {
    throw new Error('Commit artifact authority invariants are invalid');
  }
  const expected = sha256Ref({ ...artifact, artifact_hash: null });
  if (!safeEqual(artifact.artifact_hash, expected)) throw new Error('Commit artifact hash mismatch');
  let candidate;
  let policy = {};
  let executionBinding;
  if (artifact.commit_type === 'TYPED_RESULT') {
    candidate = {
      type: 'TYPED_RESULT',
      payload: cloneJson(artifact.body?.payload),
      payload_schema: cloneJson(artifact.body?.payload_schema),
    };
    policy = {
      typed_result_schema_hash: artifact.body?.payload_schema_hash,
      max_typed_result_bytes: 16 * 1024 * 1024,
      max_string_bytes: 4 * 1024 * 1024,
      max_depth: 64,
      max_nodes: 100_000,
    };
  } else if (artifact.commit_type === 'WORKSPACE_DIFF') {
    const files = Array.isArray(artifact.body?.files)
      ? artifact.body.files.map((file) => ({
        path: file.path,
        operation: file.operation,
        before_hash: file.before_hash,
        after_hash: file.after_hash,
        after_content: file.after_content,
      }))
      : artifact.body?.files;
    candidate = {
      type: 'WORKSPACE_DIFF',
      files,
      test_evidence: cloneJson(artifact.body?.test_evidence),
    };
    policy = {
      path_allowlist: Array.isArray(files) ? files.map((file) => file.path) : [],
      max_diff_bytes: 16 * 1024 * 1024,
      max_files: 10_000,
      allow_delete: true,
      required_tests: cloneJson(artifact.validation?.tests ?? []),
      max_string_bytes: 4 * 1024 * 1024,
      max_depth: 64,
      max_nodes: 100_000,
    };
  } else {
    candidate = {
      type: 'CONSEQUENTIAL_ACTION_PROPOSAL',
      action: cloneJson(artifact.body?.action),
    };
    executionBinding = cloneJson(artifact.body?.execution_binding);
  }
  const rebuilt = validateCommitCandidate({
    candidate,
    source_fork_id: artifact.source_fork_id,
    policy,
    execution_binding: executionBinding,
    validated_at: artifact.validated_at,
  });
  if (canonicalize(rebuilt) !== canonicalize(artifact)) {
    throw new Error('Commit artifact does not satisfy the canonical closed contract');
  }
  return true;
}

export function scanTaintedValue(value, policy = {}) {
  return scanText(value, normalizePolicy(policy));
}
