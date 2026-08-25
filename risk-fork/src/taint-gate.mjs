import Ajv from 'ajv';
import addFormats from 'ajv-formats';

import { assertCanonicalJson, canonicalize, sha256Ref } from './canonical.mjs';
import { ACTION_OPERATIONS, COMMIT_TYPES } from './constants.mjs';
import { verifyExecutionBinding } from './contracts.mjs';
import {
  AGORAGENTIC_GENERATED_API_KEY_PATTERN,
  BEARER_CREDENTIAL_PATTERN,
  EMBEDDED_CREDENTIAL_TOKEN_PATTERN,
  GENERIC_CREDENTIAL_TOKEN_PATTERN,
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
  BEARER_CREDENTIAL_PATTERN,
  AGORAGENTIC_GENERATED_API_KEY_PATTERN,
  EMBEDDED_CREDENTIAL_TOKEN_PATTERN,
  GENERIC_CREDENTIAL_TOKEN_PATTERN,
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

const FORBIDDEN_CHILD_KEY_FINGERPRINTS = new Set([
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
].map((key) => key.replace(/[^a-z0-9]+/g, '')));

function normalizeChildKey(value) {
  return value
    .normalize('NFKC')
    .replace(/[^A-Za-z0-9]+/g, '')
    .toLowerCase();
}

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
    if (Buffer.byteLength(key, 'utf8') > limits.max_string_bytes) {
      throw new TypeError(`Artifact key exceeds ${limits.max_string_bytes} bytes at ${path}.<key>`);
    }
    visitor(key, `${path}.<key>`);
    if (FORBIDDEN_CHILD_KEY_FINGERPRINTS.has(normalizeChildKey(key))) {
      throw new Error(`Child artifact cannot carry trusted authority or memory field at ${path}.<key>`);
    }
    walkStrings(child, visitor, limits, state, `${path}.<value>`, depth + 1);
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
    source_fork_id: requireOpaqueRef(sourceForkId, 'source_fork_id', { maxLength: 4096 }),
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
  const schemaFindings = scanText(candidate.payload_schema, context.policy);
  if (schemaFindings.length > 0) {
    throw new Error(`Typed result schema taint scan failed: ${schemaFindings[0].code}`);
  }
  const payloadFindings = scanText(candidate.payload, context.policy);
  if (payloadFindings.length > 0) {
    throw new Error(`Typed result taint scan failed: ${payloadFindings[0].code}`);
  }
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

function normalizeTestEvidence(value, field = 'test_evidence') {
  if (value !== undefined && !Array.isArray(value)) {
    throw new TypeError(`${field} must be an array`);
  }
  if ((value?.length ?? 0) > 100) {
    throw new TypeError(`${field} exceeds 100 items`);
  }
  return (value ?? []).map((item, index) => {
    const itemField = `${field}[${index}]`;
    assertAllowedKeys(
      item,
      ['name', 'status', 'evidence_ref', 'evidence_hash', 'duration_ms'],
      itemField,
    );
    return {
      name: requireOpaqueRef(item.name, `${itemField}.name`, { maxLength: 200 }),
      status: requireEnum(item.status, ['passed', 'failed'], `${itemField}.status`),
      evidence_ref: requireOpaqueRef(item.evidence_ref, `${itemField}.evidence_ref`),
      evidence_hash: requireSha256Ref(item.evidence_hash, `${itemField}.evidence_hash`),
      duration_ms: boundedInteger(
        item.duration_ms,
        `${itemField}.duration_ms`,
        { min: 0, max: 24 * 60 * 60 * 1000 },
      ),
    };
  });
}

function validateWorkspaceDiff(candidate, context) {
  assertAllowedKeys(candidate, ['type', 'files', 'test_evidence'], 'workspace diff candidate');
  if (!Array.isArray(candidate.files) || candidate.files.length > context.policy.max_files) {
    throw new Error(`Workspace diff exceeds ${context.policy.max_files} files`);
  }
  if (!context.structuralOnly && context.policy.path_allowlist.length === 0) {
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
    const pathFindings = scanText(relativePath, context.policy);
    if (pathFindings.length > 0) {
      throw new Error(`Workspace diff path taint scan failed: ${pathFindings[0].code}`);
    }
    if (relativePath === '.git' || relativePath.startsWith('.git/')) {
      throw new Error('Workspace diff cannot modify Git control metadata');
    }
    const foldedPath = relativePath.normalize('NFC').toLocaleLowerCase('en-US');
    const collision = seenPaths.get(foldedPath);
    if (collision) {
      throw new Error(`Workspace diff contains duplicate or case-colliding paths: ${collision} and ${relativePath}`);
    }
    seenPaths.set(foldedPath, relativePath);
    if (!context.structuralOnly && !isPathAllowed(relativePath, context.policy.path_allowlist)) {
      throw new Error(`Workspace diff path is not allowlisted: ${relativePath}`);
    }
    const operation = requireEnum(
      file.operation,
      ['create', 'modify', 'delete'],
      `workspace diff files[${index}].operation`,
    );
    if (!context.structuralOnly && operation === 'delete' && !context.policy.allow_delete) {
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
  const testEvidence = normalizeTestEvidence(candidate.test_evidence);
  const observedTests = new Set(testEvidence
    .filter((item) => item && item.status === 'passed' && typeof item.name === 'string')
    .map((item) => item.name));
  if (!context.structuralOnly) {
    for (const required of context.policy.required_tests) {
      if (!observedTests.has(required)) throw new Error(`Required test evidence is missing: ${required}`);
    }
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
    sourceForkId: requireOpaqueRef(input.source_fork_id, 'source_fork_id', { maxLength: 4096 }),
    policy: normalizePolicy(input.policy),
    expectedBinding: input.expected_binding ?? {},
    executionBinding: input.execution_binding ?? null,
    validatedAt: requireIsoDate(input.validated_at ?? new Date(), 'validated_at'),
    structuralOnly: false,
  };
  if (type === 'TYPED_RESULT') return validateTypedResult(input.candidate, context);
  if (type === 'WORKSPACE_DIFF') return validateWorkspaceDiff(input.candidate, context);
  return validateProposal(input.candidate, context);
}

function candidateFromArtifact(artifact) {
  if (artifact.commit_type === 'TYPED_RESULT') {
    return {
      candidate: {
        type: 'TYPED_RESULT',
        payload: cloneJson(artifact.body?.payload),
        payload_schema: cloneJson(artifact.body?.payload_schema),
      },
      executionBinding: null,
    };
  }
  if (artifact.commit_type === 'WORKSPACE_DIFF') {
    return {
      candidate: {
        type: 'WORKSPACE_DIFF',
        files: Array.isArray(artifact.body?.files)
          ? artifact.body.files.map((file) => ({
              path: file.path,
              operation: file.operation,
              before_hash: file.before_hash,
              after_hash: file.after_hash,
              after_content: file.after_content,
            }))
          : artifact.body?.files,
        test_evidence: cloneJson(artifact.body?.test_evidence),
      },
      executionBinding: null,
    };
  }
  return {
    candidate: {
      type: 'CONSEQUENTIAL_ACTION_PROPOSAL',
      action: cloneJson(artifact.body?.action),
    },
    executionBinding: cloneJson(artifact.body?.execution_binding),
  };
}

function assertSameCanonicalJson(actual, expected, message) {
  if (canonicalize(actual) !== canonicalize(expected)) throw new Error(message);
}

function rebuildCommitArtifactStructure(artifact) {
  const reconstructed = candidateFromArtifact(artifact);
  const context = {
    sourceForkId: artifact.source_fork_id,
    policy: normalizePolicy({
      max_diff_bytes: 16 * 1024 * 1024,
      max_files: 10_000,
      allow_prompt_injection_text: true,
      max_typed_result_bytes: 16 * 1024 * 1024,
      max_string_bytes: 4 * 1024 * 1024,
      max_depth: 64,
      max_nodes: 100_000,
    }),
    expectedBinding: {},
    executionBinding: reconstructed.executionBinding,
    validatedAt: artifact.validated_at,
    structuralOnly: true,
  };
  if (artifact.commit_type === 'TYPED_RESULT') {
    return validateTypedResult(reconstructed.candidate, context);
  }
  if (artifact.commit_type === 'WORKSPACE_DIFF') {
    return validateWorkspaceDiff(reconstructed.candidate, context);
  }
  return validateProposal(reconstructed.candidate, context);
}

const REQUIRED_TEST_METHODS = Object.freeze([
  'clean_reexecution',
  'trusted_external_attestation',
]);
const CLEAN_REQUIRED_TEST_PROOFS = new WeakSet();

function normalizedPolicyHash(policy) {
  return sha256Ref(policy);
}

function verifyRequiredTestProof(proof, artifact, policy, options = {}) {
  assertCanonicalJson(proof);
  assertAllowedKeys(proof, [
    'schema',
    'status',
    'artifact_hash',
    'diff_hash',
    'policy_hash',
    'verified_at',
    'tests',
    'verification_hash',
  ], 'required-test verification');
  if (proof.schema !== 'agoragentic.risk-fork.required-test-verification.v1'
    || proof.status !== 'verified') {
    throw new Error('Required-test verification status is invalid');
  }
  if (!safeEqual(proof.artifact_hash, artifact.artifact_hash)) {
    throw new Error('Required-test verification is bound to a different artifact');
  }
  if (!safeEqual(proof.diff_hash, artifact.body.diff_hash)) {
    throw new Error('Required-test verification is bound to a different workspace diff');
  }
  const policyHash = normalizedPolicyHash(policy);
  if (!safeEqual(proof.policy_hash, policyHash)) {
    throw new Error('Required-test verification is bound to a different current policy');
  }
  const verifiedAt = requireIsoDate(proof.verified_at, 'required-test verification.verified_at');
  const now = requireIsoDate(options.now ?? new Date(), 'required-test verification current time');
  if (Date.parse(verifiedAt) > Date.parse(now)) {
    throw new Error('Required-test verification is from the future');
  }
  if (!Array.isArray(proof.tests) || proof.tests.length > 100) {
    throw new TypeError('Required-test verification.tests must be a bounded array');
  }
  const tests = proof.tests.map((entry, index) => {
    const field = `required-test verification.tests[${index}]`;
    assertAllowedKeys(entry, [
      'name',
      'method',
      'request_hash',
      'evidence_ref',
      'evidence_hash',
    ], field);
    return {
      name: requireOpaqueRef(entry.name, `${field}.name`, { maxLength: 200 }),
      method: requireEnum(entry.method, REQUIRED_TEST_METHODS, `${field}.method`),
      request_hash: requireSha256Ref(entry.request_hash, `${field}.request_hash`),
      evidence_ref: requireOpaqueRef(entry.evidence_ref, `${field}.evidence_ref`),
      evidence_hash: requireSha256Ref(entry.evidence_hash, `${field}.evidence_hash`),
    };
  });
  assertSameCanonicalJson(
    proof.tests,
    tests,
    'Required-test verification entries are not canonical',
  );
  const requiredTests = policy.required_tests;
  assertSameCanonicalJson(
    tests.map((entry) => entry.name),
    requiredTests,
    'Required-test verification does not cover the exact current policy',
  );
  const expectedHash = sha256Ref({ ...proof, verification_hash: null });
  if (!safeEqual(
    requireSha256Ref(proof.verification_hash, 'required-test verification.verification_hash'),
    expectedHash,
  )) {
    throw new Error('Required-test verification hash mismatch');
  }
  return true;
}

export async function verifyWorkspaceRequiredTests(artifact, input = {}) {
  verifyCommitArtifact(artifact);
  if (artifact.commit_type !== 'WORKSPACE_DIFF') {
    throw new Error('Required workspace tests can only verify a WORKSPACE_DIFF artifact');
  }
  assertAllowedKeys(input, ['policy', 'verifyTestEvidence', 'now'], 'required-test verifier input');
  const policy = normalizePolicy(input.policy ?? {});
  const policyHash = sha256Ref(policy);
  const now = requireIsoDate(input.now ?? new Date(), 'required-test verifier now');
  if (policy.required_tests.length > 0 && typeof input.verifyTestEvidence !== 'function') {
    throw new Error('A trusted clean-side required-test evidence verifier is required');
  }
  const tests = [];
  for (const testName of policy.required_tests) {
    const childClaims = artifact.body.test_evidence
      .filter((item) => item.name === testName)
      .map((item) => cloneJson(item));
    const request = {
      schema: 'agoragentic.risk-fork.required-test-verification-request.v1',
      test_name: testName,
      artifact_hash: artifact.artifact_hash,
      source_fork_id: artifact.source_fork_id,
      diff_hash: artifact.body.diff_hash,
      policy_hash: policyHash,
      workspace_diff: cloneJson(artifact.body.files),
      child_evidence_claims: childClaims,
      requested_at: now,
      authority_flags: {
        child_evidence_is_authority: false,
        clean_verification_required: true,
      },
      request_hash: null,
    };
    request.request_hash = sha256Ref({ ...request, request_hash: null });
    const attestation = await input.verifyTestEvidence(deepFreeze(cloneJson(request)));
    assertCanonicalJson(attestation);
    const field = `clean required-test attestation for ${testName}`;
    assertAllowedKeys(attestation, [
      'schema',
      'status',
      'request_hash',
      'test_name',
      'artifact_hash',
      'diff_hash',
      'policy_hash',
      'method',
      'evidence_ref',
      'evidence_hash',
    ], field);
    if (attestation.schema !== 'agoragentic.risk-fork.required-test-attestation.v1'
      || attestation.status !== 'verified') {
      throw new Error(`${field} is not verified`);
    }
    const exactBindings = {
      request_hash: request.request_hash,
      test_name: testName,
      artifact_hash: artifact.artifact_hash,
      diff_hash: artifact.body.diff_hash,
      policy_hash: policyHash,
    };
    for (const [binding, expected] of Object.entries(exactBindings)) {
      if (attestation[binding] !== expected) {
        throw new Error(`${field} binding mismatch: ${binding}`);
      }
    }
    tests.push({
      name: testName,
      method: requireEnum(attestation.method, REQUIRED_TEST_METHODS, `${field}.method`),
      request_hash: requireSha256Ref(attestation.request_hash, `${field}.request_hash`),
      evidence_ref: requireOpaqueRef(attestation.evidence_ref, `${field}.evidence_ref`),
      evidence_hash: requireSha256Ref(attestation.evidence_hash, `${field}.evidence_hash`),
    });
  }
  const proof = {
    schema: 'agoragentic.risk-fork.required-test-verification.v1',
    status: 'verified',
    artifact_hash: artifact.artifact_hash,
    diff_hash: artifact.body.diff_hash,
    policy_hash: policyHash,
    verified_at: now,
    tests,
    verification_hash: null,
  };
  proof.verification_hash = sha256Ref({ ...proof, verification_hash: null });
  verifyRequiredTestProof(proof, artifact, policy, { now });
  const trustedProof = deepFreeze(proof);
  CLEAN_REQUIRED_TEST_PROOFS.add(trustedProof);
  return trustedProof;
}

export function revalidateCommitArtifact(artifact, input = {}) {
  verifyCommitArtifact(artifact);
  assertAllowedKeys(input, [
    'policy',
    'expected_binding',
    'required_test_verification',
    'now',
  ], 'commit artifact revalidation');
  const currentPolicy = normalizePolicy(input.policy ?? {});
  if (artifact.commit_type === 'WORKSPACE_DIFF') {
    if (currentPolicy.required_tests.length > 0 && !input.required_test_verification) {
      throw new Error('Current commit policy requires clean-side required-test verification');
    }
    if (input.required_test_verification) {
      if (!CLEAN_REQUIRED_TEST_PROOFS.has(input.required_test_verification)) {
        throw new Error('Required-test verification must originate from the clean-side verifier');
      }
      verifyRequiredTestProof(
        input.required_test_verification,
        artifact,
        currentPolicy,
        { now: input.now ?? new Date() },
      );
    }
  } else {
    if (currentPolicy.required_tests.length > 0) {
      throw new Error('Current commit policy applies required tests to a non-workspace artifact');
    }
    if (input.required_test_verification !== undefined
      && input.required_test_verification !== null) {
      throw new Error('Required-test verification is only valid for WORKSPACE_DIFF artifacts');
    }
  }
  const reconstructed = candidateFromArtifact(artifact);
  const policyWithoutChildTestAuthority = {
    ...cloneJson(input.policy ?? {}),
    required_tests: [],
  };
  const rebuilt = validateCommitCandidate({
    candidate: reconstructed.candidate,
    source_fork_id: artifact.source_fork_id,
    policy: policyWithoutChildTestAuthority,
    expected_binding: input.expected_binding ?? {},
    execution_binding: reconstructed.executionBinding,
    validated_at: artifact.validated_at,
  });
  if (canonicalize(rebuilt) !== canonicalize(artifact)) {
    throw new Error('Commit artifact is not authorized by the current commit policy');
  }
  if (reconstructed.executionBinding) {
    verifyExecutionBinding(reconstructed.executionBinding, input.expected_binding ?? {}, {
      now: input.now ?? new Date(),
    });
  }
  return true;
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
  requireOpaqueRef(
    artifact.source_fork_id,
    'commit artifact.source_fork_id',
    { maxLength: 4096 },
  );
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
  requireSha256Ref(artifact.artifact_hash, 'commit artifact.artifact_hash');
  const rebuilt = rebuildCommitArtifactStructure(artifact);
  if (canonicalize(rebuilt) !== canonicalize(artifact)) {
    throw new Error('Commit artifact does not satisfy the canonical closed contract');
  }
  const expected = sha256Ref({ ...artifact, artifact_hash: null });
  if (!safeEqual(artifact.artifact_hash, expected)) throw new Error('Commit artifact hash mismatch');
  return true;
}

export function scanTaintedValue(value, policy = {}) {
  return scanText(value, normalizePolicy(policy));
}
