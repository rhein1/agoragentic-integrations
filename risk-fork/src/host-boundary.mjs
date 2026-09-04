import { randomUUID } from 'node:crypto';
import { types as utilTypes } from 'node:util';

import { assertCanonicalJson, canonicalize, sha256Ref } from './canonical.mjs';
import { validateChildOperation } from './child-operation.mjs';
import { containsObviousCapabilityLikeText, isForbiddenAuthorityShapeKey } from './authority-shape.mjs';
import { COMMIT_TYPES, MCP_PHASES } from './constants.mjs';
import {
  assertAllowedKeys,
  assertPlainObject,
  containsSecretShapedText,
  deepFreeze,
  normalizeRelativePath,
  requireEnum,
  requireExternalEndpoint,
  requireIsoDate,
  requireMcpMethodName,
  requireOpaqueRef,
  requireSha256Ref,
  safeEqual,
  uniqueStrings,
} from './util.mjs';

export const RISK_FORK_HOST_BOUNDARY_SCHEMA =
  'agoragentic.risk-fork.host-pre-effect-boundary.v1';
export const RISK_FORK_TRUSTED_DESCRIPTOR_REQUEST_SCHEMA =
  'agoragentic.risk-fork.trusted-descriptor-request.v1';
export const RISK_FORK_TRUSTED_DESCRIPTOR_SCHEMA =
  'agoragentic.risk-fork.trusted-descriptor.v1';
export const RISK_FORK_IMPORT_ENVELOPE_SCHEMA =
  'agoragentic.risk-fork.import-envelope.v1';

export const RISK_FORK_HOST_DIAGNOSTIC_CODES = Object.freeze({
  INVALID_BOUNDARY_INPUT: 'RISK_FORK_HOST_BOUNDARY_INVALID_INPUT',
  CALLER_RISK_LABEL_REJECTED: 'RISK_FORK_CALLER_RISK_LABEL_REJECTED',
  OPERATION_TOO_LARGE: 'RISK_FORK_HOST_OPERATION_TOO_LARGE',
  DESCRIPTOR_SOURCE_UNTRUSTED: 'RISK_FORK_HOST_DESCRIPTOR_SOURCE_UNTRUSTED',
  DESCRIPTOR_RESOLUTION_FAILED: 'RISK_FORK_HOST_DESCRIPTOR_RESOLUTION_FAILED',
  DESCRIPTOR_INVALID: 'RISK_FORK_HOST_DESCRIPTOR_INVALID',
  DESCRIPTOR_REQUEST_MISMATCH: 'RISK_FORK_HOST_DESCRIPTOR_REQUEST_MISMATCH',
  DESCRIPTOR_HASH_MISMATCH: 'RISK_FORK_HOST_DESCRIPTOR_HASH_MISMATCH',
  UNKNOWN_METADATA: 'RISK_FORK_HOST_METADATA_UNKNOWN',
  PRE_EFFECT_REJECTED: 'RISK_FORK_HOST_PRE_EFFECT_REJECTED',
  IMPORT_INVALID: 'RISK_FORK_IMPORT_ENVELOPE_INVALID',
  IMPORT_TOO_LARGE: 'RISK_FORK_IMPORT_ENVELOPE_TOO_LARGE',
  IMPORT_DLP_REJECTED: 'RISK_FORK_IMPORT_ENVELOPE_DLP_REJECTED',
  IMPORT_TYPE_MISMATCH: 'RISK_FORK_IMPORT_ENVELOPE_TYPE_MISMATCH',
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
const ANNOTATION_KEYS = Object.freeze([
  'readOnlyHint',
  'destructiveHint',
  'idempotentHint',
  'openWorldHint',
]);
const OWNER_POLICY_KEYS = Object.freeze([
  'minimum_level',
  'force_risk_fork',
  'deny_irreversible',
  'trusted_server_refs',
  'trusted_attestor_refs',
  'trusted_attestation_hashes',
  'trust_registry_version',
  'allowed_egress',
]);
const PREPARE_INPUT_KEYS = Object.freeze([
  'capsule',
  'savepoint_input',
  'operation',
  'effective_arguments',
  'expected_commit_type',
  'commit_policy',
  'expected_binding',
  'network_policy',
]);
const PROVIDER_RESULT_KEYS = Object.freeze([
  'status',
  'taint_status',
  'commit_candidate',
  'result_hash',
  'measurements',
  'authority_granted',
]);
const MAX_OPERATION_BYTES = 2 * 1024 * 1024;
const MAX_IMPORT_BYTES = 1024 * 1024;
const MAX_IMPORT_NODES = 20_000;
const MAX_IMPORT_DEPTH = 32;
const MAX_IMPORT_STRING_BYTES = 256 * 1024;
const MAX_IMPORT_FILES = 500;
const MAX_IMPORT_TEST_EVIDENCE = 100;
const TEST_EVIDENCE_KEYS = Object.freeze([
  'name',
  'status',
  'evidence_ref',
  'evidence_hash',
  'duration_ms',
]);

const trustedDescriptorSourceCallbacks = new WeakMap();
const hostBoundaryRecords = new WeakMap();
const hostPreparedRecords = new WeakMap();

const DANGEROUS_KEY_FINGERPRINTS = new Set(['proto', 'constructor', 'prototype']);
const FORBIDDEN_IMPORT_KEY_FINGERPRINTS = new Set([
  'prompt',
  'rawprompt',
  'systemprompt',
  'developerprompt',
  'developermessage',
  'rawconversation',
  'conversation',
  'messages',
  'chathistory',
  'chattranscript',
  'transcript',
  'tooloutput',
  'tooloutputs',
  'rawtooloutput',
  'toolresult',
  'toolresults',
  'commandoutput',
  'processoutput',
  'stdout',
  'stderr',
  'logs',
  'rawlogs',
  'filesystemstate',
  'rawfilesystem',
  'workspacestate',
  'workspacesnapshot',
  'directorytree',
  'filetree',
  'memory',
  'memories',
  'memorystate',
  'env',
  'environment',
  'environmentstate',
  'rawenvironment',
  'processenv',
  'environmentvariables',
  'providerhandle',
  'executionhandle',
  'authorityhandle',
  'runtimehandle',
]);
const CALLER_RISK_LABEL_FINGERPRINTS = new Set([
  'risk',
  'risklabel',
  'risklevel',
  'riskscore',
  'riskdecision',
  'classification',
  'safetyclass',
  'directive',
  'requiresfork',
  'forceoptionalfork',
]);
const SENSITIVE_IMPORT_KEY_PATTERN = /(?:^|_)(?:api_?key|access_?token|refresh_?token|id_?token|session_?token|token|auth|authorization|authorisation|bearer|credential|credentials|password|passwd|passphrase|secret|client_?secret|private_?key|signing_?key|seed_?phrase|mnemonic|wallet_?(?:key|secret)|capability_?(?:grant|token))(?:$|_)/i;
const SENSITIVE_IMPORT_VALUE_PATTERNS = Object.freeze([
  /-----BEGIN (?:RSA |EC |OPENSSH |PGP |ENCRYPTED )?[A-Z ]*PRIVATE KEY-----/i,
  /(?:api[_-]?key|access[_-]?token|refresh[_-]?token|authorization|credential|password|passphrase|private[_-]?key|client[_-]?secret|seed[_-]?phrase|mnemonic|wallet[_-]?(?:key|secret))\s*[=:]\s*[^&\s"']{8,}/i,
  /[?&](?:api[_-]?key|access[_-]?token|refresh[_-]?token|authorization|credential|password|client[_-]?secret)=[^&\s]{8,}/i,
]);

export class RiskForkHostBoundaryError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'RiskForkHostBoundaryError';
    this.code = code;
  }
}

function boundaryError(code, message) {
  return new RiskForkHostBoundaryError(code, message);
}

function normalizedKey(value) {
  return value
    .normalize('NFKC')
    .replace(/([a-z0-9])([A-Z])/g, '$1_$2')
    .replace(/[^A-Za-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .toLowerCase();
}

function keyFingerprint(value) {
  return normalizedKey(value).replaceAll('_', '');
}

function assertNoCallerRiskLabels(value, field = 'operation') {
  function walk(current) {
    if (!current || typeof current !== 'object') return;
    if (utilTypes.isProxy(current)) {
      throw boundaryError(
        RISK_FORK_HOST_DIAGNOSTIC_CODES.INVALID_BOUNDARY_INPUT,
        `${field} must be ordinary JSON`,
      );
    }
    for (const [key, child] of Object.entries(current)) {
      const fingerprint = keyFingerprint(key);
      if (CALLER_RISK_LABEL_FINGERPRINTS.has(fingerprint)
        || fingerprint.startsWith('risk')) {
        throw boundaryError(
          RISK_FORK_HOST_DIAGNOSTIC_CODES.CALLER_RISK_LABEL_REJECTED,
          'Caller/model risk labels are not accepted by the host boundary',
        );
      }
      walk(child);
    }
  }
  walk(value);
}

function assertBoundedCanonicalJson(value, {
  field,
  maxBytes,
  maxNodes = 50_000,
  maxDepth = 50,
  maxStringBytes = 512 * 1024,
  dlp = false,
}) {
  const state = { nodes: 0, seen: new WeakSet() };
  function rejectDlp() {
    throw boundaryError(
      RISK_FORK_HOST_DIAGNOSTIC_CODES.IMPORT_DLP_REJECTED,
      'Risk Fork import envelope failed privacy/DLP validation',
    );
  }
  function walk(current, depth) {
    state.nodes += 1;
    if (state.nodes > maxNodes || depth > maxDepth) {
      throw boundaryError(
        dlp
          ? RISK_FORK_HOST_DIAGNOSTIC_CODES.IMPORT_TOO_LARGE
          : RISK_FORK_HOST_DIAGNOSTIC_CODES.OPERATION_TOO_LARGE,
        `${field} exceeds the bounded JSON complexity limit`,
      );
    }
    if (current === null || typeof current === 'boolean') return;
    if (typeof current === 'string') {
      if (Buffer.byteLength(current, 'utf8') > maxStringBytes) {
        throw boundaryError(
          dlp
            ? RISK_FORK_HOST_DIAGNOSTIC_CODES.IMPORT_TOO_LARGE
            : RISK_FORK_HOST_DIAGNOSTIC_CODES.OPERATION_TOO_LARGE,
          `${field} contains an oversized string`,
        );
      }
      if (dlp && (containsSecretShapedText(current)
        || containsObviousCapabilityLikeText(current)
        || SENSITIVE_IMPORT_VALUE_PATTERNS.some((pattern) => pattern.test(current)))) {
        rejectDlp();
      }
      return;
    }
    if (typeof current === 'number') {
      if (!Number.isFinite(current) || Object.is(current, -0)
        || (Number.isInteger(current) && !Number.isSafeInteger(current))) {
        throw boundaryError(
          dlp
            ? RISK_FORK_HOST_DIAGNOSTIC_CODES.IMPORT_INVALID
            : RISK_FORK_HOST_DIAGNOSTIC_CODES.INVALID_BOUNDARY_INPUT,
          `${field} contains a non-canonical number`,
        );
      }
      return;
    }
    if (typeof current !== 'object' || utilTypes.isProxy(current)) {
      throw boundaryError(
        dlp
          ? RISK_FORK_HOST_DIAGNOSTIC_CODES.IMPORT_INVALID
          : RISK_FORK_HOST_DIAGNOSTIC_CODES.INVALID_BOUNDARY_INPUT,
        `${field} must contain only ordinary JSON values`,
      );
    }
    if (state.seen.has(current)) {
      throw boundaryError(
        dlp
          ? RISK_FORK_HOST_DIAGNOSTIC_CODES.IMPORT_INVALID
          : RISK_FORK_HOST_DIAGNOSTIC_CODES.INVALID_BOUNDARY_INPUT,
        `${field} contains a cycle or shared object identity`,
      );
    }
    state.seen.add(current);
    const prototype = Object.getPrototypeOf(current);
    if (!Array.isArray(current) && prototype !== Object.prototype && prototype !== null) {
      throw boundaryError(
        dlp
          ? RISK_FORK_HOST_DIAGNOSTIC_CODES.IMPORT_INVALID
          : RISK_FORK_HOST_DIAGNOSTIC_CODES.INVALID_BOUNDARY_INPUT,
        `${field} contains a non-plain object`,
      );
    }
    if (Object.getOwnPropertySymbols(current).length > 0) {
      throw boundaryError(
        dlp
          ? RISK_FORK_HOST_DIAGNOSTIC_CODES.IMPORT_INVALID
          : RISK_FORK_HOST_DIAGNOSTIC_CODES.INVALID_BOUNDARY_INPUT,
        `${field} contains a symbol key`,
      );
    }
    const descriptors = Object.getOwnPropertyDescriptors(current);
    for (const [key, descriptor] of Object.entries(descriptors)) {
      if (Array.isArray(current) && key === 'length') continue;
      if (!descriptor.enumerable || descriptor.get || descriptor.set) {
        throw boundaryError(
          dlp
            ? RISK_FORK_HOST_DIAGNOSTIC_CODES.IMPORT_INVALID
            : RISK_FORK_HOST_DIAGNOSTIC_CODES.INVALID_BOUNDARY_INPUT,
          `${field} contains a hidden or accessor-backed field`,
        );
      }
    }
    if (Array.isArray(current)) {
      if (Object.keys(current).length !== current.length) {
        throw boundaryError(
          dlp
            ? RISK_FORK_HOST_DIAGNOSTIC_CODES.IMPORT_INVALID
            : RISK_FORK_HOST_DIAGNOSTIC_CODES.INVALID_BOUNDARY_INPUT,
          `${field} contains a sparse or extended array`,
        );
      }
      for (let index = 0; index < current.length; index += 1) {
        if (!Object.hasOwn(current, index)) {
          throw boundaryError(
            dlp
              ? RISK_FORK_HOST_DIAGNOSTIC_CODES.IMPORT_INVALID
              : RISK_FORK_HOST_DIAGNOSTIC_CODES.INVALID_BOUNDARY_INPUT,
            `${field} contains a sparse array`,
          );
        }
        walk(current[index], depth + 1);
      }
      return;
    }
    for (const [key, child] of Object.entries(current)) {
      const normalized = normalizedKey(key);
      const fingerprint = keyFingerprint(key);
      if (DANGEROUS_KEY_FINGERPRINTS.has(fingerprint)) {
        throw boundaryError(
          dlp
            ? RISK_FORK_HOST_DIAGNOSTIC_CODES.IMPORT_INVALID
            : RISK_FORK_HOST_DIAGNOSTIC_CODES.INVALID_BOUNDARY_INPUT,
          `${field} contains a forbidden JSON key`,
        );
      }
      if (dlp && (FORBIDDEN_IMPORT_KEY_FINGERPRINTS.has(fingerprint)
        || SENSITIVE_IMPORT_KEY_PATTERN.test(normalized)
        || isForbiddenAuthorityShapeKey(key)
        || containsSecretShapedText(key))) {
        rejectDlp();
      }
      walk(child, depth + 1);
    }
  }
  try {
    walk(value, 0);
    assertCanonicalJson(value);
    const serialized = canonicalize(value);
    if (Buffer.byteLength(serialized, 'utf8') > maxBytes) {
      throw boundaryError(
        dlp
          ? RISK_FORK_HOST_DIAGNOSTIC_CODES.IMPORT_TOO_LARGE
          : RISK_FORK_HOST_DIAGNOSTIC_CODES.OPERATION_TOO_LARGE,
        `${field} exceeds ${maxBytes} bytes`,
      );
    }
    return JSON.parse(serialized);
  } catch (error) {
    if (error instanceof RiskForkHostBoundaryError) throw error;
    throw boundaryError(
      dlp
        ? RISK_FORK_HOST_DIAGNOSTIC_CODES.IMPORT_INVALID
        : RISK_FORK_HOST_DIAGNOSTIC_CODES.INVALID_BOUNDARY_INPUT,
      `${field} is not bounded canonical JSON`,
    );
  }
}

function normalizeImportCandidate(candidate, expectedType) {
  assertPlainObject(candidate, 'Risk Fork import candidate');
  const type = requireEnum(candidate.type, COMMIT_TYPES, 'Risk Fork import candidate.type');
  if (expectedType && type !== expectedType) {
    throw boundaryError(
      RISK_FORK_HOST_DIAGNOSTIC_CODES.IMPORT_TYPE_MISMATCH,
      'Risk Fork import candidate type does not match the requested import type',
    );
  }
  if (type === 'TYPED_RESULT') {
    assertAllowedKeys(candidate, ['type', 'payload', 'payload_schema'], 'typed-result import candidate');
    assertPlainObject(candidate.payload_schema, 'typed-result import candidate.payload_schema');
  } else if (type === 'WORKSPACE_DIFF') {
    assertAllowedKeys(candidate, ['type', 'files', 'test_evidence'], 'workspace-diff import candidate');
    if (!Array.isArray(candidate.files) || candidate.files.length > MAX_IMPORT_FILES) {
      throw boundaryError(
        RISK_FORK_HOST_DIAGNOSTIC_CODES.IMPORT_TOO_LARGE,
        `Risk Fork workspace-diff import exceeds ${MAX_IMPORT_FILES} files`,
      );
    }
    candidate.files.forEach((file, index) => {
      const field = `workspace-diff import candidate.files[${index}]`;
      assertAllowedKeys(
        file,
        ['path', 'operation', 'before_hash', 'after_hash', 'after_content'],
        field,
      );
      normalizeRelativePath(file.path, `${field}.path`);
      requireEnum(file.operation, ['create', 'modify', 'delete'], `${field}.operation`);
      if (file.before_hash != null) requireSha256Ref(file.before_hash, `${field}.before_hash`);
      if (file.after_hash != null) requireSha256Ref(file.after_hash, `${field}.after_hash`);
      if (file.after_content != null && typeof file.after_content !== 'string') {
        throw new TypeError(`${field}.after_content must be text or null`);
      }
    });
    if (candidate.test_evidence !== undefined
      && (!Array.isArray(candidate.test_evidence)
        || candidate.test_evidence.length > MAX_IMPORT_TEST_EVIDENCE)) {
      throw boundaryError(
        RISK_FORK_HOST_DIAGNOSTIC_CODES.IMPORT_TOO_LARGE,
        `Risk Fork import exceeds ${MAX_IMPORT_TEST_EVIDENCE} test evidence records`,
      );
    }
    candidate.test_evidence?.forEach((evidence, index) => {
      const field = `workspace-diff import candidate.test_evidence[${index}]`;
      assertAllowedKeys(evidence, TEST_EVIDENCE_KEYS, field);
      for (const key of TEST_EVIDENCE_KEYS) {
        if (!Object.hasOwn(evidence, key)) {
          throw boundaryError(
            RISK_FORK_HOST_DIAGNOSTIC_CODES.IMPORT_INVALID,
            'Risk Fork test evidence is incomplete',
          );
        }
      }
      requireOpaqueRef(evidence.name, `${field}.name`, { maxLength: 200 });
      requireEnum(evidence.status, ['passed', 'failed'], `${field}.status`);
      requireOpaqueRef(evidence.evidence_ref, `${field}.evidence_ref`);
      requireSha256Ref(evidence.evidence_hash, `${field}.evidence_hash`);
      if (!Number.isSafeInteger(evidence.duration_ms)
        || evidence.duration_ms < 0
        || evidence.duration_ms > 86_400_000) {
        throw boundaryError(
          RISK_FORK_HOST_DIAGNOSTIC_CODES.IMPORT_INVALID,
          'Risk Fork test evidence duration is invalid',
        );
      }
    });
  } else {
    assertAllowedKeys(candidate, ['type', 'action'], 'action-proposal import candidate');
    assertAllowedKeys(candidate.action, [
      'operation',
      'target_ref',
      'provider_ref',
      'arguments',
      'amount',
      'currency',
      'payment_rail',
    ], 'action-proposal import candidate.action');
    assertPlainObject(candidate.action.arguments ?? {}, 'action-proposal import arguments');
  }
  return candidate;
}

function normalizeImportEnvelope(value, options = {}) {
  assertAllowedKeys(options, [
    'expected_type',
    'expected_source_fork_ref',
    'expected_result_hash',
  ], 'Risk Fork import verification options');
  const clone = assertBoundedCanonicalJson(value, {
    field: 'Risk Fork import envelope',
    maxBytes: MAX_IMPORT_BYTES,
    maxNodes: MAX_IMPORT_NODES,
    maxDepth: MAX_IMPORT_DEPTH,
    maxStringBytes: MAX_IMPORT_STRING_BYTES,
    dlp: true,
  });
  assertAllowedKeys(clone, [
    'schema',
    'import_type',
    'source_fork_ref',
    'result_hash',
    'candidate',
    'envelope_hash',
  ], 'Risk Fork import envelope');
  if (clone.schema !== RISK_FORK_IMPORT_ENVELOPE_SCHEMA) {
    throw new TypeError('Risk Fork import envelope schema is invalid');
  }
  const importType = requireEnum(clone.import_type, COMMIT_TYPES, 'Risk Fork import_type');
  normalizeImportCandidate(clone.candidate, importType);
  const normalized = {
    schema: RISK_FORK_IMPORT_ENVELOPE_SCHEMA,
    import_type: importType,
    source_fork_ref: requireOpaqueRef(
      clone.source_fork_ref,
      'Risk Fork import source_fork_ref',
      { maxLength: 4096 },
    ),
    result_hash: requireSha256Ref(clone.result_hash, 'Risk Fork import result_hash'),
    candidate: clone.candidate,
    envelope_hash: requireSha256Ref(clone.envelope_hash, 'Risk Fork import envelope_hash'),
  };
  if (options.expected_type && normalized.import_type !== options.expected_type) {
    throw boundaryError(
      RISK_FORK_HOST_DIAGNOSTIC_CODES.IMPORT_TYPE_MISMATCH,
      'Risk Fork import type does not match the host request',
    );
  }
  if (options.expected_source_fork_ref
    && normalized.source_fork_ref !== options.expected_source_fork_ref) {
    throw new Error('Risk Fork import source fork binding mismatch');
  }
  if (options.expected_result_hash
    && !safeEqual(normalized.result_hash, options.expected_result_hash)) {
    throw new Error('Risk Fork import result hash binding mismatch');
  }
  const expectedHash = sha256Ref({ ...normalized, envelope_hash: null });
  if (!safeEqual(normalized.envelope_hash, expectedHash)) {
    throw new Error('Risk Fork import envelope hash mismatch');
  }
  return deepFreeze(normalized);
}

export function createRiskForkImportEnvelope(input = {}) {
  try {
    assertAllowedKeys(
      input,
      ['source_fork_ref', 'result_hash', 'candidate'],
      'Risk Fork import envelope input',
    );
    const candidate = assertBoundedCanonicalJson(input.candidate, {
      field: 'Risk Fork import candidate',
      maxBytes: MAX_IMPORT_BYTES,
      maxNodes: MAX_IMPORT_NODES,
      maxDepth: MAX_IMPORT_DEPTH,
      maxStringBytes: MAX_IMPORT_STRING_BYTES,
      dlp: true,
    });
    const importType = requireEnum(candidate.type, COMMIT_TYPES, 'Risk Fork import candidate.type');
    normalizeImportCandidate(candidate, importType);
    const envelope = {
      schema: RISK_FORK_IMPORT_ENVELOPE_SCHEMA,
      import_type: importType,
      source_fork_ref: requireOpaqueRef(
        input.source_fork_ref,
        'Risk Fork import source_fork_ref',
        { maxLength: 4096 },
      ),
      result_hash: requireSha256Ref(input.result_hash, 'Risk Fork import result_hash'),
      candidate,
      envelope_hash: null,
    };
    envelope.envelope_hash = sha256Ref(envelope);
    return normalizeImportEnvelope(envelope);
  } catch (error) {
    if (error instanceof RiskForkHostBoundaryError) throw error;
    throw boundaryError(
      RISK_FORK_HOST_DIAGNOSTIC_CODES.IMPORT_INVALID,
      'Risk Fork import envelope is invalid',
    );
  }
}

export function verifyRiskForkImportEnvelope(value, options = {}) {
  try {
    return normalizeImportEnvelope(value, options);
  } catch (error) {
    if (error instanceof RiskForkHostBoundaryError) throw error;
    throw boundaryError(
      RISK_FORK_HOST_DIAGNOSTIC_CODES.IMPORT_INVALID,
      'Risk Fork import envelope is invalid',
    );
  }
}

export function importRiskForkProviderResult(value, input = {}) {
  try {
    assertAllowedKeys(
      input,
      ['source_fork_ref', 'expected_type', 'candidate'],
      'Risk Fork provider import input',
    );
    const result = assertBoundedCanonicalJson(value, {
      field: 'Risk Fork provider result',
      maxBytes: MAX_IMPORT_BYTES,
      maxNodes: MAX_IMPORT_NODES,
      maxDepth: MAX_IMPORT_DEPTH,
      maxStringBytes: MAX_IMPORT_STRING_BYTES,
      dlp: false,
    });
    const { authority_granted: declaredAuthority, ...dlpResult } = result;
    assertBoundedCanonicalJson(dlpResult, {
      field: 'Risk Fork provider result',
      maxBytes: MAX_IMPORT_BYTES,
      maxNodes: MAX_IMPORT_NODES,
      maxDepth: MAX_IMPORT_DEPTH,
      maxStringBytes: MAX_IMPORT_STRING_BYTES,
      dlp: true,
    });
    assertAllowedKeys(result, PROVIDER_RESULT_KEYS, 'Risk Fork provider result');
    if (result.status !== undefined && result.status !== 'completed') {
      throw new Error('Risk Fork provider result status is not completed');
    }
    if (result.taint_status !== undefined && result.taint_status !== 'TAINTED') {
      throw new Error('Risk Fork provider result taint status is invalid');
    }
    if (declaredAuthority !== undefined && declaredAuthority !== false) {
      throw new Error('Risk Fork provider result cannot grant authority');
    }
    const expectedType = requireEnum(
      input.expected_type,
      COMMIT_TYPES,
      'Risk Fork provider import expected_type',
    );
    const candidate = input.candidate ?? result.commit_candidate;
    if (!candidate) throw new Error('Risk Fork provider result has no import candidate');
    const envelope = createRiskForkImportEnvelope({
      source_fork_ref: input.source_fork_ref,
      result_hash: result.result_hash,
      candidate,
    });
    return verifyRiskForkImportEnvelope(envelope, {
      expected_type: expectedType,
      expected_source_fork_ref: input.source_fork_ref,
      expected_result_hash: result.result_hash,
    });
  } catch (error) {
    if (error instanceof RiskForkHostBoundaryError) throw error;
    throw boundaryError(
      RISK_FORK_HOST_DIAGNOSTIC_CODES.IMPORT_INVALID,
      'Risk Fork provider result import is invalid',
    );
  }
}

function verifyDescriptorRequest(value) {
  assertPlainObject(value, 'trusted descriptor request');
  assertAllowedKeys(value, [
    'schema',
    'request_id',
    'descriptor_ref',
    'operation_hash',
    'requested_at',
    'request_hash',
  ], 'trusted descriptor request');
  if (value.schema !== RISK_FORK_TRUSTED_DESCRIPTOR_REQUEST_SCHEMA) {
    throw new TypeError('Trusted descriptor request schema is invalid');
  }
  const normalized = {
    schema: RISK_FORK_TRUSTED_DESCRIPTOR_REQUEST_SCHEMA,
    request_id: requireOpaqueRef(value.request_id, 'trusted descriptor request.request_id'),
    descriptor_ref: requireOpaqueRef(
      value.descriptor_ref,
      'trusted descriptor request.descriptor_ref',
    ),
    operation_hash: requireSha256Ref(
      value.operation_hash,
      'trusted descriptor request.operation_hash',
    ),
    requested_at: requireIsoDate(
      value.requested_at,
      'trusted descriptor request.requested_at',
    ),
    request_hash: requireSha256Ref(value.request_hash, 'trusted descriptor request.request_hash'),
  };
  const expectedHash = sha256Ref({ ...normalized, request_hash: null });
  if (!safeEqual(normalized.request_hash, expectedHash)) {
    throw new Error('Trusted descriptor request hash mismatch');
  }
  return deepFreeze(normalized);
}

function normalizeCompleteBooleanRecord(value, keys, field) {
  try {
    assertAllowedKeys(value, keys, field);
  } catch {
    throw boundaryError(
      RISK_FORK_HOST_DIAGNOSTIC_CODES.UNKNOWN_METADATA,
      `${field} is absent, incomplete, or malformed`,
    );
  }
  for (const key of keys) {
    if (!Object.hasOwn(value, key) || typeof value[key] !== 'boolean') {
      throw boundaryError(
        RISK_FORK_HOST_DIAGNOSTIC_CODES.UNKNOWN_METADATA,
        `${field} is incomplete or non-boolean`,
      );
    }
  }
  return Object.fromEntries(keys.map((key) => [key, value[key]]));
}

function normalizeTrustedDescriptor(value, request) {
  const clone = assertBoundedCanonicalJson(value, {
    field: 'trusted descriptor',
    maxBytes: MAX_OPERATION_BYTES,
  });
  assertAllowedKeys(clone, [
    'schema',
    'request_hash',
    'descriptor_ref',
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
    'descriptor_hash',
  ], 'trusted descriptor');
  if (clone.schema !== RISK_FORK_TRUSTED_DESCRIPTOR_SCHEMA) {
    throw new TypeError('Trusted descriptor schema is invalid');
  }
  if (!safeEqual(clone.request_hash, request.request_hash)
    || clone.descriptor_ref !== request.descriptor_ref) {
    throw boundaryError(
      RISK_FORK_HOST_DIAGNOSTIC_CODES.DESCRIPTOR_REQUEST_MISMATCH,
      'Trusted descriptor does not bind the exact host request',
    );
  }
  const phase = requireEnum(clone.mcp_phase, MCP_PHASES, 'trusted descriptor.mcp_phase');
  if (phase === 'UNKNOWN') {
    throw boundaryError(
      RISK_FORK_HOST_DIAGNOSTIC_CODES.UNKNOWN_METADATA,
      'Unknown MCP methods cannot pass the host pre-effect boundary',
    );
  }
  const rawMethod = clone.raw_method == null
    ? null
    : requireMcpMethodName(clone.raw_method, 'trusted descriptor.raw_method');
  if (rawMethod !== null) {
    throw new TypeError('trusted descriptor.raw_method is permitted only for UNKNOWN methods');
  }
  const capabilities = normalizeCompleteBooleanRecord(
    clone.capabilities,
    CAPABILITY_KEYS,
    'trusted descriptor.capabilities',
  );
  if (capabilities.unknown_or_unclassified) {
    throw boundaryError(
      RISK_FORK_HOST_DIAGNOSTIC_CODES.UNKNOWN_METADATA,
      'Unknown or unclassified effect metadata cannot pass the host boundary',
    );
  }
  const annotations = normalizeCompleteBooleanRecord(
    clone.tool_annotations,
    ANNOTATION_KEYS,
    'trusted descriptor.tool_annotations',
  );
  const trust = requireEnum(
    clone.mcp_server_trust,
    ['verified', 'reachable', 'failed', 'untrusted'],
    'trusted descriptor.mcp_server_trust',
  );
  const toolName = clone.tool_name == null
    ? null
    : requireOpaqueRef(clone.tool_name, 'trusted descriptor.tool_name', { maxLength: 300 });
  if (phase === 'tools/call' && !toolName) {
    throw boundaryError(
      RISK_FORK_HOST_DIAGNOSTIC_CODES.UNKNOWN_METADATA,
      'A tools/call descriptor requires an exact tool name',
    );
  }
  assertAllowedKeys(clone.owner_policy, OWNER_POLICY_KEYS, 'trusted descriptor.owner_policy');
  for (const key of OWNER_POLICY_KEYS) {
    if (!Object.hasOwn(clone.owner_policy, key)) {
      throw boundaryError(
        RISK_FORK_HOST_DIAGNOSTIC_CODES.UNKNOWN_METADATA,
        'Trusted owner policy metadata is incomplete',
      );
    }
  }
  const normalized = {
    schema: RISK_FORK_TRUSTED_DESCRIPTOR_SCHEMA,
    request_hash: request.request_hash,
    descriptor_ref: requireOpaqueRef(clone.descriptor_ref, 'trusted descriptor.descriptor_ref'),
    mcp_phase: phase,
    raw_method: null,
    mcp_server_ref: requireOpaqueRef(
      clone.mcp_server_ref,
      'trusted descriptor.mcp_server_ref',
    ),
    mcp_server_origin: requireExternalEndpoint(
      clone.mcp_server_origin,
      'trusted descriptor.mcp_server_origin',
    ),
    mcp_server_trust: trust,
    mcp_server_attestation: clone.mcp_server_attestation ?? null,
    tool_name: toolName,
    tool_annotations: annotations,
    capabilities,
    prompt_injection_indicators: uniqueStrings(
      clone.prompt_injection_indicators,
      'trusted descriptor.prompt_injection_indicators',
      { maxItems: 50, maxLength: 500 },
    ),
    owner_policy: clone.owner_policy,
    descriptor_hash: requireSha256Ref(clone.descriptor_hash, 'trusted descriptor.descriptor_hash'),
  };
  if (normalized.mcp_server_attestation !== null) {
    assertPlainObject(normalized.mcp_server_attestation, 'trusted descriptor.mcp_server_attestation');
  }
  const expectedHash = sha256Ref({ ...normalized, descriptor_hash: null });
  if (!safeEqual(normalized.descriptor_hash, expectedHash)) {
    throw boundaryError(
      RISK_FORK_HOST_DIAGNOSTIC_CODES.DESCRIPTOR_HASH_MISMATCH,
      'Trusted descriptor hash mismatch',
    );
  }
  return deepFreeze(JSON.parse(canonicalize(normalized)));
}

export function createTrustedRiskDescriptor(requestValue, input = {}) {
  const request = verifyDescriptorRequest(requestValue);
  try {
    assertAllowedKeys(input, [
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
    ], 'trusted descriptor input');
    const phase = requireEnum(input.mcp_phase, MCP_PHASES, 'trusted descriptor.mcp_phase');
    if (phase === 'UNKNOWN') {
      throw boundaryError(
        RISK_FORK_HOST_DIAGNOSTIC_CODES.UNKNOWN_METADATA,
        'Unknown MCP methods cannot pass the host pre-effect boundary',
      );
    }
    if (input.raw_method != null) {
      throw new TypeError('trusted descriptor.raw_method is permitted only for UNKNOWN methods');
    }
    const annotations = normalizeCompleteBooleanRecord(
      input.tool_annotations,
      ANNOTATION_KEYS,
      'trusted descriptor.tool_annotations',
    );
    const capabilities = normalizeCompleteBooleanRecord(
      input.capabilities,
      CAPABILITY_KEYS,
      'trusted descriptor.capabilities',
    );
    if (capabilities.unknown_or_unclassified) {
      throw boundaryError(
        RISK_FORK_HOST_DIAGNOSTIC_CODES.UNKNOWN_METADATA,
        'Unknown or unclassified effect metadata cannot pass the host boundary',
      );
    }
    const toolName = input.tool_name == null
      ? null
      : requireOpaqueRef(input.tool_name, 'trusted descriptor.tool_name', { maxLength: 300 });
    if (phase === 'tools/call' && !toolName) {
      throw boundaryError(
        RISK_FORK_HOST_DIAGNOSTIC_CODES.UNKNOWN_METADATA,
        'A tools/call descriptor requires an exact tool name',
      );
    }
    assertAllowedKeys(input.owner_policy, OWNER_POLICY_KEYS, 'trusted descriptor.owner_policy');
    for (const key of OWNER_POLICY_KEYS) {
      if (!Object.hasOwn(input.owner_policy, key)) {
        throw boundaryError(
          RISK_FORK_HOST_DIAGNOSTIC_CODES.UNKNOWN_METADATA,
          'Trusted owner policy metadata is incomplete',
        );
      }
    }
    const ownerPolicy = assertBoundedCanonicalJson(input.owner_policy, {
      field: 'trusted descriptor.owner_policy',
      maxBytes: MAX_OPERATION_BYTES,
    });
    const attestation = input.mcp_server_attestation == null
      ? null
      : assertBoundedCanonicalJson(input.mcp_server_attestation, {
        field: 'trusted descriptor.mcp_server_attestation',
        maxBytes: MAX_OPERATION_BYTES,
      });
    if (attestation !== null) {
      assertPlainObject(attestation, 'trusted descriptor.mcp_server_attestation');
    }
    const descriptor = {
      schema: RISK_FORK_TRUSTED_DESCRIPTOR_SCHEMA,
      request_hash: request.request_hash,
      descriptor_ref: request.descriptor_ref,
      mcp_phase: phase,
      raw_method: null,
      mcp_server_ref: requireOpaqueRef(
        input.mcp_server_ref,
        'trusted descriptor.mcp_server_ref',
      ),
      mcp_server_origin: requireExternalEndpoint(
        input.mcp_server_origin,
        'trusted descriptor.mcp_server_origin',
      ),
      mcp_server_trust: requireEnum(
        input.mcp_server_trust,
        ['verified', 'reachable', 'failed', 'untrusted'],
        'trusted descriptor.mcp_server_trust',
      ),
      mcp_server_attestation: attestation,
      tool_name: toolName,
      tool_annotations: annotations,
      capabilities,
      prompt_injection_indicators: uniqueStrings(
        input.prompt_injection_indicators,
        'trusted descriptor.prompt_injection_indicators',
        { maxItems: 50, maxLength: 500 },
      ),
      owner_policy: ownerPolicy,
      descriptor_hash: null,
    };
    descriptor.descriptor_hash = sha256Ref(descriptor);
    return normalizeTrustedDescriptor(descriptor, request);
  } catch (error) {
    if (error instanceof RiskForkHostBoundaryError) throw error;
    throw boundaryError(
      RISK_FORK_HOST_DIAGNOSTIC_CODES.DESCRIPTOR_INVALID,
      'Trusted descriptor is invalid',
    );
  }
}

export function createTrustedRiskDescriptorSource(resolveDescriptor) {
  if (typeof resolveDescriptor !== 'function') {
    throw new TypeError('Trusted Risk Fork descriptor source requires a host callback');
  }
  const source = Object.freeze({
    schema: 'agoragentic.risk-fork.trusted-descriptor-source.v1',
    trust_mode: 'host_callback_identity',
  });
  trustedDescriptorSourceCallbacks.set(source, resolveDescriptor);
  return source;
}

function normalizePrepareInput(value) {
  const clone = assertBoundedCanonicalJson(value, {
    field: 'Risk Fork host operation input',
    maxBytes: MAX_OPERATION_BYTES,
  });
  assertAllowedKeys(clone, PREPARE_INPUT_KEYS, 'Risk Fork host operation input');
  assertNoCallerRiskLabels(clone.operation, 'Risk Fork child operation');
  clone.operation = validateChildOperation(clone.operation, 'Risk Fork child operation');
  clone.expected_commit_type = requireEnum(
    clone.expected_commit_type,
    COMMIT_TYPES,
    'Risk Fork host expected_commit_type',
  );
  return deepFreeze(clone);
}

function riskInputFromDescriptor(descriptor, requestId) {
  return deepFreeze({
    request_id: requestId,
    mcp_phase: descriptor.mcp_phase,
    ...(descriptor.raw_method === null ? {} : { raw_method: descriptor.raw_method }),
    mcp_server_ref: descriptor.mcp_server_ref,
    mcp_server_origin: descriptor.mcp_server_origin,
    mcp_server_trust: descriptor.mcp_server_trust,
    ...(descriptor.mcp_server_attestation === null
      ? {}
      : { mcp_server_attestation: descriptor.mcp_server_attestation }),
    ...(descriptor.tool_name === null ? {} : { tool_name: descriptor.tool_name }),
    tool_annotations: descriptor.tool_annotations,
    capabilities: descriptor.capabilities,
    prompt_injection_indicators: descriptor.prompt_injection_indicators,
    owner_policy: descriptor.owner_policy,
  });
}

export function createRiskForkHostBoundary(input = {}) {
  assertAllowedKeys(input, [
    'controller',
    'trusted_descriptor_source',
    'create_execution_binding',
    'fork_elevated',
    'trusted_limits',
    'clock',
  ], 'Risk Fork host boundary factory input');
  if (!input.controller || typeof input.controller.prepare !== 'function') {
    throw new TypeError('Risk Fork host boundary requires a controller prepare method');
  }
  const resolveDescriptor = trustedDescriptorSourceCallbacks.get(input.trusted_descriptor_source);
  if (!resolveDescriptor) {
    throw boundaryError(
      RISK_FORK_HOST_DIAGNOSTIC_CODES.DESCRIPTOR_SOURCE_UNTRUSTED,
      'Risk Fork host boundary requires the exact host-owned descriptor source capability',
    );
  }
  if (input.create_execution_binding !== undefined
    && typeof input.create_execution_binding !== 'function') {
    throw new TypeError('create_execution_binding must be a clean host callback');
  }
  if (input.fork_elevated !== undefined && typeof input.fork_elevated !== 'boolean') {
    throw new TypeError('fork_elevated must be a boolean');
  }
  const clock = input.clock ?? (() => new Date());
  if (typeof clock !== 'function') throw new TypeError('Risk Fork host boundary clock is invalid');
  const controllerPrepare = input.controller.prepare.bind(input.controller);
  const controllerCommit = typeof input.controller.commit === 'function'
    ? input.controller.commit.bind(input.controller)
    : null;
  const trustedLimits = input.trusted_limits ?? {
    fork_ttl_ms: 5 * 60 * 1000,
    idle_ttl_ms: 60_000,
    max_execution_ms: 60_000,
  };
  assertAllowedKeys(trustedLimits, [
    'fork_ttl_ms',
    'idle_ttl_ms',
    'max_execution_ms',
  ], 'Risk Fork trusted host limits');
  for (const [key, value] of Object.entries(trustedLimits)) {
    if (!Number.isSafeInteger(value) || value < 100 || value > 24 * 60 * 60 * 1000) {
      throw new TypeError(`Risk Fork trusted host limit ${key} is invalid`);
    }
  }
  const boundary = Object.freeze({
    schema: RISK_FORK_HOST_BOUNDARY_SCHEMA,
    mode: 'host_owned_pre_effect',
    preEffect: async (request) => {
      const record = hostBoundaryRecords.get(boundary);
      try {
        assertCanonicalJson(request);
        assertAllowedKeys(
          request,
          ['descriptor_ref', 'operation_input'],
          'Risk Fork host preEffect request',
        );
        const descriptorRef = requireOpaqueRef(
          request.descriptor_ref,
          'Risk Fork host descriptor_ref',
        );
        const operationInput = normalizePrepareInput(request.operation_input);
        const requestedAt = requireIsoDate(record.clock(), 'Risk Fork host boundary clock result');
        const descriptorRequest = {
          schema: RISK_FORK_TRUSTED_DESCRIPTOR_REQUEST_SCHEMA,
          request_id: `risk-fork-host:${randomUUID()}`,
          descriptor_ref: descriptorRef,
          operation_hash: sha256Ref(operationInput),
          requested_at: requestedAt,
          request_hash: null,
        };
        descriptorRequest.request_hash = sha256Ref(descriptorRequest);
        const frozenRequest = verifyDescriptorRequest(descriptorRequest);
        let resolved;
        try {
          resolved = await record.resolveDescriptor(frozenRequest);
        } catch (error) {
          if (error instanceof RiskForkHostBoundaryError) throw error;
          throw boundaryError(
            RISK_FORK_HOST_DIAGNOSTIC_CODES.DESCRIPTOR_RESOLUTION_FAILED,
            'Trusted descriptor source did not resolve the host request',
          );
        }
        let descriptor;
        try {
          descriptor = normalizeTrustedDescriptor(resolved, frozenRequest);
        } catch (error) {
          if (error instanceof RiskForkHostBoundaryError) throw error;
          throw boundaryError(
            RISK_FORK_HOST_DIAGNOSTIC_CODES.DESCRIPTOR_INVALID,
            'Trusted descriptor source returned an invalid descriptor',
          );
        }
        const riskInput = riskInputFromDescriptor(descriptor, frozenRequest.request_id);
        let prepared;
        try {
          prepared = await record.controllerPrepare({
            ...operationInput,
            ...record.trustedLimits,
            risk_input: riskInput,
            force_optional_fork: record.forkElevated,
            ...(operationInput.expected_commit_type === 'CONSEQUENTIAL_ACTION_PROPOSAL'
              && record.createExecutionBinding
              ? { createExecutionBinding: record.createExecutionBinding }
              : {}),
          });
        } catch {
          throw boundaryError(
            RISK_FORK_HOST_DIAGNOSTIC_CODES.PRE_EFFECT_REJECTED,
            'Risk Fork controller rejected the host-owned pre-effect request',
          );
        }
        assertBoundedCanonicalJson(prepared, {
          field: 'Risk Fork prepared result',
          maxBytes: MAX_OPERATION_BYTES,
        });
        const result = deepFreeze({
          schema: 'agoragentic.risk-fork.host-pre-effect-result.v1',
          descriptor_ref: descriptor.descriptor_ref,
          descriptor_hash: descriptor.descriptor_hash,
          operation_hash: frozenRequest.operation_hash,
          prepared,
          authority_granted: false,
          provider_handle_exposed: false,
        });
        hostPreparedRecords.set(result, Object.freeze({ prepared, boundary }));
        return result;
      } catch (error) {
        if (error instanceof RiskForkHostBoundaryError) throw error;
        throw boundaryError(
          RISK_FORK_HOST_DIAGNOSTIC_CODES.INVALID_BOUNDARY_INPUT,
          'Risk Fork host pre-effect request is invalid',
        );
      }
    },
    commitPrepared: async (preEffectResult, cleanCommitInput = {}) => {
      const provenance = hostPreparedRecords.get(preEffectResult);
      if (!provenance || provenance.boundary !== boundary || !controllerCommit) {
        throw boundaryError(
          RISK_FORK_HOST_DIAGNOSTIC_CODES.PRE_EFFECT_REJECTED,
          'Risk Fork prepared result is not commit-capable for this host boundary',
        );
      }
      return controllerCommit(provenance.prepared, cleanCommitInput);
    },
    validateImport: (envelope, options = {}) => verifyRiskForkImportEnvelope(envelope, options),
  });
  hostBoundaryRecords.set(boundary, Object.freeze({
    controllerPrepare,
    controllerCommit,
    resolveDescriptor,
    createExecutionBinding: input.create_execution_binding ?? null,
    forkElevated: input.fork_elevated !== false,
    clock,
    trustedLimits: deepFreeze({ ...trustedLimits }),
  }));
  return boundary;
}

export function isRiskForkHostBoundary(value) {
  return hostBoundaryRecords.has(value);
}
