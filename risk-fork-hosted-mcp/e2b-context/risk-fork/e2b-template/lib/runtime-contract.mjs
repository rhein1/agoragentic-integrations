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
  if (normalized.status !== 'verified') throw new Error('E2B boot evidence claims are not verified');
  return Object.freeze(normalized);
}

export { canonicalize, sha256Ref };
