import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import {
  lstat,
  open,
  readdir,
  readFile,
  realpath,
} from 'node:fs/promises';
import path from 'node:path';

import { canonicalize, sha256Ref } from '../../src/canonical.mjs';

export const BOOT_EVIDENCE_SCHEMA = 'agoragentic.risk-fork.e2b-boot-evidence.v1';
export const E2B_BIRTH_REQUEST_SCHEMA =
  'agoragentic.risk-fork.e2b-birth-request.v1';
export const E2B_BIRTH_ATTESTATION_SCHEMA =
  'agoragentic.risk-fork.e2b-birth-attestation.v2';
export const E2B_BIRTH_RUNTIME_DIRECTORY = '/run/agoragentic-risk-fork';
export const E2B_TEMPLATE_BUILD_READY_PATH =
  `${E2B_BIRTH_RUNTIME_DIRECTORY}/template-build-ready`;
export const E2B_BOOT_EVIDENCE_PATH =
  `${E2B_BIRTH_RUNTIME_DIRECTORY}/boot-evidence.json`;
export const E2B_BOOT_READY_PATH = `${E2B_BIRTH_RUNTIME_DIRECTORY}/birth-ready`;
export const E2B_BIRTH_REQUEST_MAX_BYTES = 64 * 1024;
export const E2B_BIRTH_MAX_VALIDITY_MS = 30_000;
export const EMPTY_RUNTIME_WORKSPACE_DIGEST = sha256Ref([]);
export const BOOT_EVIDENCE_CLAIMS = Object.freeze([
  'inherited_parent_processes_absent',
  'unauthorized_environment_absent',
  'credential_files_absent',
  'wallet_signing_material_absent',
  'inherited_authority_records_absent',
  'persistent_mounts_absent',
  'unauthorized_sockets_absent',
  'first_instruction_ipv4_egress_denied',
  'first_instruction_ipv6_egress_denied',
  'fresh_entropy_verified',
  'trusted_runtime_artifacts_verified',
]);

const BOOT_KEYS = Object.freeze([
  'schema',
  'status',
  'observed_at',
  'expires_at',
  'boot_nonce',
  'boot_id_hash',
  'entropy_hash',
  'bootstrap_artifact_hash',
  'runner_artifact_hash',
  'measurements',
  'observation_hashes',
  'claims',
  'raw_environment_values_included',
  'raw_processes_included',
  'raw_sockets_included',
  'raw_mounts_included',
  'raw_credentials_included',
  'evidence_hash',
]);
const MEASUREMENT_KEYS = Object.freeze([
  'environment_key_count',
  'process_count',
  'socket_count',
  'mount_count',
  'credential_path_count',
]);
const OBSERVATION_HASH_KEYS = Object.freeze([
  'environment_keys_hash',
  'processes_hash',
  'sockets_hash',
  'mounts_hash',
  'credential_paths_hash',
  'ipv4_probe_hash',
  'ipv6_probe_hash',
]);
const MAX_RUNTIME_FILES = 2_000;
const MAX_RUNTIME_BYTES = 32 * 1024 * 1024;
const MAX_RUNTIME_DEPTH = 128;
const BIRTH_AUTHORITY_FLAGS = Object.freeze([
  'credentials_included',
  'wallet_material_included',
  'execution_authority_included',
  'production_activation_granted',
]);
const BIRTH_REQUEST_KEYS = Object.freeze([
  'schema',
  'sandbox_id_hash',
  'provider_metadata_hash',
  'template_id_hash',
  'template_evidence_hash',
  'template_provenance_hash',
  'allocation_started_at',
  'expires_at',
  'birth_nonce',
  'authority_flags',
  'request_hash',
]);
const BIRTH_ATTESTATION_CLAIMS = Object.freeze({
  request_canonical_observed: true,
  request_consumed_once_observed: true,
  boot_observation_hash_bound: true,
  observed_after_allocation: true,
  privileged_producer_verified: false,
});
const BIRTH_ATTESTATION_KEYS = Object.freeze([
  'schema',
  'status',
  'trust_status',
  'birth_request_hash',
  'boot_evidence_hash',
  'sandbox_id_hash',
  'provider_metadata_hash',
  'template_id_hash',
  'template_evidence_hash',
  'template_provenance_hash',
  'allocation_started_at',
  'birth_nonce_hash',
  'observed_at',
  'expires_at',
  'claims',
  'authority_flags',
  'attestation_hash',
]);

function assertPlainObject(value, field) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new TypeError(`${field} must be an object`);
  }
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    throw new TypeError(`${field} must be a plain object`);
  }
  return value;
}

function assertAllowedKeys(value, allowed, field) {
  assertPlainObject(value, field);
  const unexpected = Object.keys(value).filter((key) => !allowed.includes(key));
  if (unexpected.length > 0) {
    throw new TypeError(`${field} contains unsupported fields: ${unexpected.sort().join(', ')}`);
  }
}

export function requireSha256Ref(value, field) {
  if (typeof value !== 'string' || !/^sha256:[a-f0-9]{64}$/.test(value)) {
    throw new TypeError(`${field} must be a SHA-256 reference`);
  }
  return value;
}

function requireIso(value, field) {
  if (typeof value !== 'string' || !Number.isFinite(Date.parse(value))) {
    throw new TypeError(`${field} must be an ISO date-time`);
  }
  const normalized = new Date(Date.parse(value)).toISOString();
  if (normalized !== value) throw new TypeError(`${field} must be canonical ISO 8601`);
  return normalized;
}

function boundedCount(value, field, max = 1_000_000) {
  if (!Number.isSafeInteger(value) || value < 0 || value > max) {
    throw new TypeError(`${field} must be a bounded non-negative integer`);
  }
  return value;
}

function requireBirthNonce(value, field) {
  if (typeof value !== 'string'
    || value.length < 16
    || value.length > 200
    || /\s|[\u0000-\u001f\u007f]/.test(value)) {
    throw new TypeError(`${field} must be a bounded opaque nonce`);
  }
  return value;
}

function normalizeAuthorityFlags(value, field) {
  assertAllowedKeys(value, BIRTH_AUTHORITY_FLAGS, field);
  const normalized = Object.fromEntries(BIRTH_AUTHORITY_FLAGS.map((key) => {
    if (value[key] !== false) throw new Error(`${field}.${key} must remain false`);
    return [key, false];
  }));
  return normalized;
}

function birthAuthorityFlags() {
  return Object.fromEntries(BIRTH_AUTHORITY_FLAGS.map((key) => [key, false]));
}

export function e2bBirthRequestPaths(requestHash) {
  const digest = requireSha256Ref(requestHash, 'E2B birth request hash').slice(7);
  return Object.freeze({
    request: `${E2B_BIRTH_RUNTIME_DIRECTORY}/birth-request.${digest}.json`,
    trigger: `${E2B_BIRTH_RUNTIME_DIRECTORY}/birth-request.${digest}.ready`,
    consumed: `${E2B_BIRTH_RUNTIME_DIRECTORY}/birth-consumed.${digest}.json`,
    consumed_trigger: `${E2B_BIRTH_RUNTIME_DIRECTORY}/birth-consumed.${digest}.ready`,
    attestation: `${E2B_BIRTH_RUNTIME_DIRECTORY}/birth-attestation.${digest}.json`,
  });
}

function normalizeRelative(value, field) {
  if (typeof value !== 'string' || value.length < 1 || value.length > 1024) {
    throw new TypeError(`${field} is invalid`);
  }
  const normalized = value.replaceAll('\\', '/').normalize('NFC');
  if (normalized.startsWith('/')
    || /^[A-Za-z]:\//.test(normalized)
    || normalized.includes(':')
    || normalized.includes('\0')
    || normalized.split('/').includes('..')) {
    throw new TypeError(`${field} must be a safe relative path`);
  }
  const clean = path.posix.normalize(normalized).replace(/^\.\//, '');
  if (!clean || clean === '.' || clean.startsWith('../')) {
    throw new TypeError(`${field} must identify a file below the workspace`);
  }
  return clean;
}

export function sha256BytesRef(value) {
  const bytes = value instanceof Uint8Array ? value : Buffer.from(value);
  return `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
}

export async function sha256FileRef(file) {
  return sha256BytesRef(await readFile(file));
}

function stableIdentity(info) {
  return JSON.stringify({
    dev: String(info.dev),
    ino: String(info.ino),
    size: String(info.size),
    mtime_ms: Number(info.mtimeMs),
  });
}

function assertWithin(root, candidate, field) {
  const relative = path.relative(root, candidate);
  if (relative === '') return;
  if (relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw new Error(`${field} escapes the runtime workspace`);
  }
}

async function readStableRuntimeFile(absolute, relative, rootReal, remainingBytes) {
  const before = await lstat(absolute, { bigint: true });
  if (before.isSymbolicLink() || !before.isFile()) {
    throw new Error(`Runtime workspace rejects a non-regular file: ${relative}`);
  }
  if (before.nlink > 1n) throw new Error(`Runtime workspace rejects a hard link: ${relative}`);
  if (before.size > BigInt(remainingBytes)) throw new Error('Runtime workspace exceeds byte limit');
  const noFollow = Number.isInteger(constants.O_NOFOLLOW) ? constants.O_NOFOLLOW : 0;
  const handle = await open(absolute, constants.O_RDONLY | noFollow);
  try {
    const opened = await handle.stat({ bigint: true });
    if (!opened.isFile() || opened.nlink > 1n || stableIdentity(opened) !== stableIdentity(before)) {
      throw new Error(`Runtime workspace file changed while opening: ${relative}`);
    }
    const resolved = await realpath(absolute);
    assertWithin(rootReal, resolved, `Runtime workspace file ${relative}`);
    const content = await handle.readFile();
    const after = await handle.stat({ bigint: true });
    if (stableIdentity(after) !== stableIdentity(opened)) {
      throw new Error(`Runtime workspace file changed while reading: ${relative}`);
    }
    return content;
  } finally {
    await handle.close();
  }
}

export async function inspectRuntimeWorkspace(workspaceRoot, options = {}) {
  const root = path.resolve(String(workspaceRoot));
  let rootInfo;
  try {
    rootInfo = await lstat(root, { bigint: true });
  } catch (error) {
    if (error?.code === 'ENOENT' && options.allowMissing === true) {
      return Object.freeze({
        files: Object.freeze([]),
        file_count: 0,
        total_bytes: 0,
        workspace_digest: EMPTY_RUNTIME_WORKSPACE_DIGEST,
      });
    }
    throw error;
  }
  if (rootInfo.isSymbolicLink() || !rootInfo.isDirectory()) {
    throw new TypeError('Runtime workspace must be a real directory');
  }
  const rootReal = await realpath(root);
  const maxFiles = options.maxFiles ?? MAX_RUNTIME_FILES;
  const maxBytes = options.maxBytes ?? MAX_RUNTIME_BYTES;
  const records = [];
  const foldedPaths = new Set();
  let totalBytes = 0;

  async function visit(directory, prefix = '', depth = 0) {
    if (depth > MAX_RUNTIME_DEPTH) throw new Error('Runtime workspace exceeds depth limit');
    const directoryInfo = await lstat(directory, { bigint: true });
    if (directoryInfo.isSymbolicLink() || !directoryInfo.isDirectory()) {
      throw new Error('Runtime workspace directory changed type');
    }
    const entries = await readdir(directory, { withFileTypes: true });
    entries.sort((left, right) => left.name.localeCompare(right.name));
    for (const entry of entries) {
      const relative = normalizeRelative(prefix ? `${prefix}/${entry.name}` : entry.name, 'path');
      if (relative === '.git' || relative.startsWith('.git/')) {
        throw new Error('Runtime workspace excludes .git metadata');
      }
      const folded = relative.normalize('NFC').toLocaleLowerCase('en-US');
      if (foldedPaths.has(folded)) throw new Error('Runtime workspace path collision');
      foldedPaths.add(folded);
      const absolute = path.join(directory, entry.name);
      const info = await lstat(absolute, { bigint: true });
      if (info.isSymbolicLink()) throw new Error(`Runtime workspace rejects a symlink: ${relative}`);
      if (info.isDirectory()) {
        await visit(absolute, relative, depth + 1);
        continue;
      }
      if (!info.isFile()) throw new Error(`Runtime workspace rejects a special file: ${relative}`);
      if (records.length >= maxFiles) throw new Error('Runtime workspace exceeds file limit');
      const content = await readStableRuntimeFile(
        absolute,
        relative,
        rootReal,
        maxBytes - totalBytes,
      );
      totalBytes += content.byteLength;
      if (totalBytes > maxBytes) throw new Error('Runtime workspace exceeds byte limit');
      records.push({
        path: relative,
        bytes: content.byteLength,
        content_hash: sha256Ref(content.toString('base64')),
      });
    }
  }

  await visit(root);
  return Object.freeze({
    files: Object.freeze(records.map((entry) => Object.freeze(entry))),
    file_count: records.length,
    total_bytes: totalBytes,
    workspace_digest: sha256Ref(records),
  });
}

function normalizeBootEvidence(value, includeComputed) {
  assertPlainObject(value, 'E2B boot evidence');
  assertAllowedKeys(
    value,
    includeComputed ? BOOT_KEYS : BOOT_KEYS.filter(
      (key) => !['schema', 'status', 'raw_environment_values_included', 'raw_processes_included', 'raw_sockets_included', 'raw_mounts_included', 'raw_credentials_included', 'evidence_hash'].includes(key),
    ),
    'E2B boot evidence',
  );
  const observedAt = requireIso(value.observed_at, 'E2B boot evidence.observed_at');
  const expiresAt = requireIso(value.expires_at, 'E2B boot evidence.expires_at');
  if (Date.parse(expiresAt) <= Date.parse(observedAt)
    || Date.parse(expiresAt) > Date.parse(observedAt) + 5 * 60_000) {
    throw new Error('E2B boot evidence validity window is invalid');
  }
  if (typeof value.boot_nonce !== 'string'
    || value.boot_nonce.length < 16
    || value.boot_nonce.length > 200
    || /\s|[\u0000-\u001f\u007f]/.test(value.boot_nonce)) {
    throw new TypeError('E2B boot evidence boot_nonce is invalid');
  }
  assertPlainObject(value.measurements, 'E2B boot evidence.measurements');
  assertAllowedKeys(value.measurements, MEASUREMENT_KEYS, 'E2B boot evidence.measurements');
  const measurements = Object.fromEntries(MEASUREMENT_KEYS.map((key) => [
    key,
    boundedCount(value.measurements[key], `E2B boot evidence.measurements.${key}`),
  ]));
  assertPlainObject(value.observation_hashes, 'E2B boot evidence.observation_hashes');
  assertAllowedKeys(
    value.observation_hashes,
    OBSERVATION_HASH_KEYS,
    'E2B boot evidence.observation_hashes',
  );
  const observationHashes = Object.fromEntries(OBSERVATION_HASH_KEYS.map((key) => [
    key,
    requireSha256Ref(value.observation_hashes[key], `E2B boot evidence.${key}`),
  ]));
  assertPlainObject(value.claims, 'E2B boot evidence.claims');
  assertAllowedKeys(value.claims, BOOT_EVIDENCE_CLAIMS, 'E2B boot evidence.claims');
  const claims = Object.fromEntries(BOOT_EVIDENCE_CLAIMS.map((key) => {
    if (typeof value.claims[key] !== 'boolean') {
      throw new TypeError(`E2B boot evidence.claims.${key} must be boolean`);
    }
    return [key, value.claims[key]];
  }));
  const status = Object.values(claims).every((claim) => claim === true) ? 'verified' : 'failed';
  const rawFlags = {
    raw_environment_values_included: false,
    raw_processes_included: false,
    raw_sockets_included: false,
    raw_mounts_included: false,
    raw_credentials_included: false,
  };
  if (includeComputed) {
    if (value.schema !== BOOT_EVIDENCE_SCHEMA || value.status !== status) {
      throw new Error('E2B boot evidence schema or status is inconsistent');
    }
    for (const key of Object.keys(rawFlags)) {
      if (value[key] !== false) throw new Error(`E2B boot evidence cannot include ${key}`);
    }
  }
  return {
    schema: BOOT_EVIDENCE_SCHEMA,
    status,
    observed_at: observedAt,
    expires_at: expiresAt,
    boot_nonce: value.boot_nonce,
    boot_id_hash: requireSha256Ref(value.boot_id_hash, 'E2B boot evidence.boot_id_hash'),
    entropy_hash: requireSha256Ref(value.entropy_hash, 'E2B boot evidence.entropy_hash'),
    bootstrap_artifact_hash: requireSha256Ref(
      value.bootstrap_artifact_hash,
      'E2B boot evidence.bootstrap_artifact_hash',
    ),
    runner_artifact_hash: requireSha256Ref(
      value.runner_artifact_hash,
      'E2B boot evidence.runner_artifact_hash',
    ),
    measurements,
    observation_hashes: observationHashes,
    claims,
    ...rawFlags,
    evidence_hash: includeComputed
      ? requireSha256Ref(value.evidence_hash, 'E2B boot evidence.evidence_hash')
      : null,
  };
}

export function createBootEvidenceEnvelope(input = {}) {
  const normalized = normalizeBootEvidence(input, false);
  normalized.evidence_hash = sha256Ref({ ...normalized, evidence_hash: null });
  return Object.freeze(normalized);
}

export function validateBootEvidenceEnvelope(value, options = {}) {
  const normalized = validateBootObservationEnvelope(value, options);
  if (normalized.status !== 'verified') throw new Error('E2B boot evidence claims are not verified');
  return normalized;
}

export function validateBootObservationEnvelope(value, options = {}) {
  const normalized = normalizeBootEvidence(value, true);
  const expectedHash = sha256Ref({ ...normalized, evidence_hash: null });
  if (normalized.evidence_hash !== expectedHash) throw new Error('E2B boot evidence hash mismatch');
  if (canonicalize(normalized) !== canonicalize(value)) {
    throw new Error('E2B boot evidence is not canonical and closed');
  }
  const now = options.now instanceof Date ? options.now.getTime() : Date.parse(options.now ?? new Date());
  if (!Number.isFinite(now)
    || now < Date.parse(normalized.observed_at)
    || now >= Date.parse(normalized.expires_at)) {
    throw new Error('E2B boot evidence is stale or outside its validity window');
  }
  for (const [field, wanted] of [
    ['bootstrap_artifact_hash', options.bootstrapArtifactHash],
    ['runner_artifact_hash', options.runnerArtifactHash],
    ['evidence_hash', options.evidenceHash],
  ]) {
    if (wanted != null && normalized[field] !== wanted) {
      throw new Error(`E2B boot evidence binding mismatch: ${field}`);
    }
  }
  return Object.freeze(normalized);
}

function normalizeBirthRequest(value, includeComputed) {
  assertPlainObject(value, 'E2B birth request');
  assertAllowedKeys(
    value,
    includeComputed
      ? BIRTH_REQUEST_KEYS
      : BIRTH_REQUEST_KEYS.filter((key) => !['schema', 'request_hash'].includes(key)),
    'E2B birth request',
  );
  const allocationStartedAt = requireIso(
    value.allocation_started_at,
    'E2B birth request.allocation_started_at',
  );
  const expiresAt = requireIso(value.expires_at, 'E2B birth request.expires_at');
  if (Date.parse(expiresAt) <= Date.parse(allocationStartedAt)
    || Date.parse(expiresAt) > Date.parse(allocationStartedAt) + E2B_BIRTH_MAX_VALIDITY_MS) {
    throw new Error('E2B birth request validity window is invalid');
  }
  const normalized = {
    schema: E2B_BIRTH_REQUEST_SCHEMA,
    sandbox_id_hash: requireSha256Ref(
      value.sandbox_id_hash,
      'E2B birth request.sandbox_id_hash',
    ),
    provider_metadata_hash: requireSha256Ref(
      value.provider_metadata_hash,
      'E2B birth request.provider_metadata_hash',
    ),
    template_id_hash: requireSha256Ref(
      value.template_id_hash,
      'E2B birth request.template_id_hash',
    ),
    template_evidence_hash: requireSha256Ref(
      value.template_evidence_hash,
      'E2B birth request.template_evidence_hash',
    ),
    template_provenance_hash: requireSha256Ref(
      value.template_provenance_hash,
      'E2B birth request.template_provenance_hash',
    ),
    allocation_started_at: allocationStartedAt,
    expires_at: expiresAt,
    birth_nonce: requireBirthNonce(value.birth_nonce, 'E2B birth request.birth_nonce'),
    authority_flags: normalizeAuthorityFlags(
      value.authority_flags,
      'E2B birth request.authority_flags',
    ),
    request_hash: includeComputed
      ? requireSha256Ref(value.request_hash, 'E2B birth request.request_hash')
      : null,
  };
  if (includeComputed && value.schema !== E2B_BIRTH_REQUEST_SCHEMA) {
    throw new Error('E2B birth request schema is invalid');
  }
  return normalized;
}

export function createE2BBirthRequest(input = {}) {
  const normalized = normalizeBirthRequest({
    ...input,
    authority_flags: input.authority_flags ?? birthAuthorityFlags(),
  }, false);
  normalized.request_hash = sha256Ref({ ...normalized, request_hash: null });
  return Object.freeze({
    ...normalized,
    authority_flags: Object.freeze(normalized.authority_flags),
  });
}

export function validateE2BBirthRequest(value, options = {}) {
  const normalized = normalizeBirthRequest(value, true);
  const expectedHash = sha256Ref({ ...normalized, request_hash: null });
  if (normalized.request_hash !== expectedHash) throw new Error('E2B birth request hash mismatch');
  if (canonicalize(normalized) !== canonicalize(value)) {
    throw new Error('E2B birth request is not canonical and closed');
  }
  for (const [field, wanted] of [
    ['sandbox_id_hash', options.sandboxIdHash],
    ['provider_metadata_hash', options.providerMetadataHash],
    ['template_id_hash', options.templateIdHash],
    ['template_evidence_hash', options.templateEvidenceHash],
    ['template_provenance_hash', options.templateProvenanceHash],
    ['allocation_started_at', options.allocationStartedAt],
    ['request_hash', options.requestHash],
  ]) {
    if (wanted != null && normalized[field] !== wanted) {
      throw new Error(`E2B birth request binding mismatch: ${field}`);
    }
  }
  if (options.birthNonce != null && normalized.birth_nonce !== options.birthNonce) {
    throw new Error('E2B birth request binding mismatch: birth_nonce');
  }
  if (options.now != null) {
    const now = options.now instanceof Date ? options.now.getTime() : Date.parse(options.now);
    if (!Number.isFinite(now)
      || now < Date.parse(normalized.allocation_started_at)
      || now >= Date.parse(normalized.expires_at)) {
      throw new Error('E2B birth request is pre-allocation, expired, or outside its validity window');
    }
  }
  return Object.freeze({
    ...normalized,
    authority_flags: Object.freeze(normalized.authority_flags),
  });
}

function normalizeBirthAttestation(value, includeComputed) {
  assertPlainObject(value, 'E2B birth attestation');
  assertAllowedKeys(
    value,
    includeComputed
      ? BIRTH_ATTESTATION_KEYS
      : BIRTH_ATTESTATION_KEYS.filter(
          (key) => !['schema', 'status', 'attestation_hash'].includes(key),
        ),
    'E2B birth attestation',
  );
  const allocationStartedAt = requireIso(
    value.allocation_started_at,
    'E2B birth attestation.allocation_started_at',
  );
  const observedAt = requireIso(value.observed_at, 'E2B birth attestation.observed_at');
  const expiresAt = requireIso(value.expires_at, 'E2B birth attestation.expires_at');
  if (Date.parse(observedAt) < Date.parse(allocationStartedAt)
    || Date.parse(expiresAt) <= Date.parse(observedAt)
    || Date.parse(expiresAt) > Date.parse(allocationStartedAt) + E2B_BIRTH_MAX_VALIDITY_MS) {
    throw new Error('E2B birth attestation timing is invalid');
  }
  const claimKeys = Object.keys(BIRTH_ATTESTATION_CLAIMS);
  assertAllowedKeys(value.claims, claimKeys, 'E2B birth attestation.claims');
  const claims = Object.fromEntries(claimKeys.map((key) => {
    if (value.claims[key] !== BIRTH_ATTESTATION_CLAIMS[key]) {
      throw new Error(
        `E2B birth attestation.claims.${key} must remain ${BIRTH_ATTESTATION_CLAIMS[key]}`,
      );
    }
    return [key, BIRTH_ATTESTATION_CLAIMS[key]];
  }));
  const normalized = {
    schema: E2B_BIRTH_ATTESTATION_SCHEMA,
    status: 'untrusted_observation',
    trust_status: 'untrusted_same_uid_self_assertion',
    birth_request_hash: requireSha256Ref(
      value.birth_request_hash,
      'E2B birth attestation.birth_request_hash',
    ),
    boot_evidence_hash: requireSha256Ref(
      value.boot_evidence_hash,
      'E2B birth attestation.boot_evidence_hash',
    ),
    sandbox_id_hash: requireSha256Ref(
      value.sandbox_id_hash,
      'E2B birth attestation.sandbox_id_hash',
    ),
    provider_metadata_hash: requireSha256Ref(
      value.provider_metadata_hash,
      'E2B birth attestation.provider_metadata_hash',
    ),
    template_id_hash: requireSha256Ref(
      value.template_id_hash,
      'E2B birth attestation.template_id_hash',
    ),
    template_evidence_hash: requireSha256Ref(
      value.template_evidence_hash,
      'E2B birth attestation.template_evidence_hash',
    ),
    template_provenance_hash: requireSha256Ref(
      value.template_provenance_hash,
      'E2B birth attestation.template_provenance_hash',
    ),
    allocation_started_at: allocationStartedAt,
    birth_nonce_hash: requireSha256Ref(
      value.birth_nonce_hash,
      'E2B birth attestation.birth_nonce_hash',
    ),
    observed_at: observedAt,
    expires_at: expiresAt,
    claims,
    authority_flags: normalizeAuthorityFlags(
      value.authority_flags,
      'E2B birth attestation.authority_flags',
    ),
    attestation_hash: includeComputed
      ? requireSha256Ref(value.attestation_hash, 'E2B birth attestation.attestation_hash')
      : null,
  };
  if (includeComputed
    && (value.schema !== E2B_BIRTH_ATTESTATION_SCHEMA
      || value.status !== 'untrusted_observation'
      || value.trust_status !== 'untrusted_same_uid_self_assertion')) {
    throw new Error('E2B birth attestation schema, status, or trust status is invalid');
  }
  return normalized;
}

export function createE2BBirthAttestation(input = {}) {
  const observedAt = requireIso(
    input.observed_at ?? new Date().toISOString(),
    'E2B birth attestation observed_at',
  );
  const request = validateE2BBirthRequest(input.request, { now: observedAt });
  const bootEvidence = validateBootObservationEnvelope(input.bootEvidence, { now: observedAt });
  if (bootEvidence.boot_nonce !== request.birth_nonce) {
    throw new Error('E2B boot evidence nonce is not bound to the birth request');
  }
  if (Date.parse(bootEvidence.observed_at) < Date.parse(request.allocation_started_at)
    || Date.parse(observedAt) < Date.parse(bootEvidence.observed_at)) {
    throw new Error('E2B boot evidence predates allocation or birth attestation');
  }
  const expiresAt = new Date(Math.min(
    Date.parse(request.expires_at),
    Date.parse(bootEvidence.expires_at),
  )).toISOString();
  const normalized = normalizeBirthAttestation({
    birth_request_hash: request.request_hash,
    boot_evidence_hash: bootEvidence.evidence_hash,
    sandbox_id_hash: request.sandbox_id_hash,
    provider_metadata_hash: request.provider_metadata_hash,
    template_id_hash: request.template_id_hash,
    template_evidence_hash: request.template_evidence_hash,
    template_provenance_hash: request.template_provenance_hash,
    allocation_started_at: request.allocation_started_at,
    birth_nonce_hash: sha256Ref(request.birth_nonce),
    observed_at: observedAt,
    expires_at: expiresAt,
    claims: {
      request_canonical_observed: true,
      request_consumed_once_observed: true,
      boot_observation_hash_bound: true,
      observed_after_allocation: true,
      privileged_producer_verified: false,
    },
    authority_flags: birthAuthorityFlags(),
  }, false);
  normalized.attestation_hash = sha256Ref({ ...normalized, attestation_hash: null });
  return Object.freeze({
    ...normalized,
    claims: Object.freeze(normalized.claims),
    authority_flags: Object.freeze(normalized.authority_flags),
  });
}

export function validateE2BBirthAttestation(value, options = {}) {
  const normalized = normalizeBirthAttestation(value, true);
  const expectedHash = sha256Ref({ ...normalized, attestation_hash: null });
  if (normalized.attestation_hash !== expectedHash) {
    throw new Error('E2B birth attestation hash mismatch');
  }
  if (canonicalize(normalized) !== canonicalize(value)) {
    throw new Error('E2B birth attestation is not canonical and closed');
  }
  const request = validateE2BBirthRequest(options.request, {
    now: options.now ?? normalized.observed_at,
  });
  const bootEvidence = validateBootObservationEnvelope(options.bootEvidence, {
    now: options.now ?? normalized.observed_at,
    bootstrapArtifactHash: options.bootstrapArtifactHash,
    runnerArtifactHash: options.runnerArtifactHash,
  });
  const expectedExpiresAt = new Date(Math.min(
    Date.parse(request.expires_at),
    Date.parse(bootEvidence.expires_at),
  )).toISOString();
  if (normalized.expires_at !== expectedExpiresAt) {
    throw new Error('E2B birth attestation expiry is not exact-bound to its evidence');
  }
  for (const [field, wanted] of Object.entries({
    birth_request_hash: request.request_hash,
    boot_evidence_hash: bootEvidence.evidence_hash,
    sandbox_id_hash: request.sandbox_id_hash,
    provider_metadata_hash: request.provider_metadata_hash,
    template_id_hash: request.template_id_hash,
    template_evidence_hash: request.template_evidence_hash,
    template_provenance_hash: request.template_provenance_hash,
    allocation_started_at: request.allocation_started_at,
    birth_nonce_hash: sha256Ref(request.birth_nonce),
  })) {
    if (normalized[field] !== wanted) {
      throw new Error(`E2B birth attestation binding mismatch: ${field}`);
    }
  }
  if (bootEvidence.boot_nonce !== request.birth_nonce
    || Date.parse(bootEvidence.observed_at) < Date.parse(request.allocation_started_at)
    || Date.parse(normalized.observed_at) < Date.parse(bootEvidence.observed_at)) {
    throw new Error('E2B birth attestation does not prove fresh post-allocation boot evidence');
  }
  if (options.now != null) {
    const now = options.now instanceof Date ? options.now.getTime() : Date.parse(options.now);
    if (!Number.isFinite(now)
      || now < Date.parse(normalized.observed_at)
      || now >= Date.parse(normalized.expires_at)) {
      throw new Error('E2B birth attestation is stale or outside its validity window');
    }
  }
  return Object.freeze({
    ...normalized,
    claims: Object.freeze(normalized.claims),
    authority_flags: Object.freeze(normalized.authority_flags),
  });
}

export { canonicalize, sha256Ref };
