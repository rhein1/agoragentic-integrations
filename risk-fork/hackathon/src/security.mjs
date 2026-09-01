import { randomBytes } from 'node:crypto';
import {
  lstat,
  mkdir,
  readFile,
  readdir,
  realpath,
  rm,
  writeFile,
} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { canonicalize, sha256Ref } from '../../src/canonical.mjs';
import { validateChildOperation, validateLocalReferenceOperation } from '../../src/child-operation.mjs';
import {
  cloneJson,
  containsSecretShapedText,
  deepFreeze,
  isPlainObject,
  normalizeRelativePath,
  safeEqual,
} from '../../src/util.mjs';

export const RISK_FORK_DEMO_BANNER =
  'DEMO ONLY — LOCAL PROTOCOL SIMULATOR — NOT AN ISOLATION BOUNDARY — NO LIVE PROTECTION';

export const RISK_FORK_DEMO_TRUTH_FIELDS = Object.freeze({
  demo_only: true,
  local_protocol_simulator: true,
  production_ready: false,
  live_traffic_protected: false,
  authority_granted: false,
  provider_calls: 0,
  network_used: false,
  credentials_used: false,
  clean_commit_performed: false,
});

export const RISK_FORK_DEMO_LIMITS = Object.freeze({
  max_active_runs: 1,
  max_completed_runs_before_reset: 10,
  max_workspace_files: 128,
  max_workspace_bytes: 4 * 1024 * 1024,
  max_write_bytes: 256 * 1024,
  max_actions: 50,
  fork_ttl_ms: 60_000,
  execution_timeout_ms: 10_000,
  max_recorder_bytes: 4 * 1024 * 1024,
  max_root_bytes: 64 * 1024 * 1024,
});

export const RISK_FORK_DEMO_ROOT_MARKER = '.agoragentic-risk-fork-demo-root.json';

const ROOT_MARKER_SCHEMA = 'agoragentic.risk-fork.hackathon-owned-root.v1';
const ROOT_HANDLE_SCHEMA = 'agoragentic.risk-fork.hackathon-owned-root-handle.v1';
const ROOT_MARKER_KEYS = Object.freeze([
  'schema',
  'root_id',
  'root_path_hash',
  'created_at',
  'marker_hash',
]);
const ROOT_HANDLE_KEYS = Object.freeze([
  'schema',
  'root_path',
  'root_real_path',
  'root_id',
  'marker_hash',
]);
const TRUTH_KEYS = new Set(['banner', ...Object.keys(RISK_FORK_DEMO_TRUTH_FIELDS)]);
const DANGEROUS_KEYS = new Set(['__proto__', 'constructor', 'prototype']);
const SECRET_FIELD_NAMES = new Set([
  'token',
  'api_key',
  'apikey',
  'access_token',
  'accesstoken',
  'refresh_token',
  'refreshtoken',
  'id_token',
  'idtoken',
  'bearer',
  'credential',
  'credentials',
  'password',
  'passwd',
  'passphrase',
  'secret',
  'client_secret',
  'clientsecret',
  'private_key',
  'privatekey',
  'signing_key',
  'signingkey',
  'seed_phrase',
  'seedphrase',
  'mnemonic',
  'wallet_key',
  'walletkey',
]);
const SAFE_AUTHORITY_METADATA_FIELDS = new Set([
  'authority_absent',
  'authority_flags',
  'authority_free',
  'authority_granted',
  'authorization_hash',
  'authorization_id',
  'authorization_ref',
  'authorization_required',
  'authorization_status',
  'authorized_result_schema_hash',
  'execution_authority_absent',
  'execution_authorization',
  'one_use_authorization_id',
]);
const SECRET_FIELD_PATTERNS = Object.freeze([
  /(?:^|_)(?:api_?key|access_?token|refresh_?token|id_?token|session_?token|auth_?token|bearer_?token)$/,
  /(?:^|_)(?:token|authorization|authorization_header|auth|auth_header|bearer|cookie|cookies|set_cookie)$/,
  /(?:^|_)(?:credential|credentials|password|passwd|passphrase|secret|client_secret)$/,
  /(?:^|_)(?:private_key|signing_key|signing_secret|wallet_key|wallet_secret|wallet_seed|wallet_mnemonic)$/,
  /(?:^|_)(?:seed|seed_phrase|recovery_phrase|mnemonic)$/,
]);
const SECRET_CREDENTIAL_COMPONENT = /(?:^|_)(?:api_?key|access_?token|refresh_?token|id_?token|session_?token|auth_?token|bearer_?token|token|credential|credentials|password|passwd|passphrase|secret|client_secret|private_key|signing_key|signing_secret|wallet_key|wallet_secret|wallet_seed|wallet_mnemonic|seed|seed_phrase|recovery_phrase|mnemonic)(?:_|$)/;
const SAFE_AUTHORITY_METADATA_SUFFIX = /(?:^|_)(?:authority|authorization)_(?:absent|flags|free|granted|hash|id|ref|required|status)$/;
const PRIVATE_PATH_REDACTION = '[REDACTED_PRIVATE_PATH]';
const PRIVATE_PATH_PATTERNS = Object.freeze([
  /(^|[\s"'`(=,:])(file:\/\/[^\r\n\s"'`<>]*)/giu,
  /(^|[\s"'`(=,:])(\\\\+[^\s\\/"'`<>|]+[\\/]+[^\r\n"'`<>|]*)/gu,
  /(^|[\s"'`(=,:])([A-Za-z]:[\\/]+[^\r\n"'`<>|]*)/gu,
]);
const POSIX_PRIVATE_PATH_PATTERN = /(^|[^\p{L}\p{N}\p{M}._~-])(\/{1,2}(?!\/)[^\r\n\s"'`<>]*)/gu;
const POSIX_TRAILING_PUNCTUATION_PATTERN = /([,.;:)\]}|]+)$/u;
const MAX_ALLOWED_ABSOLUTE_PATHS = 4;
const MAX_ALLOWED_ABSOLUTE_PATH_BYTES = 4 * 1024;
const ALLOWED_ABSOLUTE_PATH_PLACEHOLDER = 'risk-fork-approved-absolute-path';
const WINDOWS_RESERVED_BASENAME = /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])$/i;

export class DemoSecurityError extends Error {
  constructor(code, message, details = undefined) {
    super(message);
    this.name = 'DemoSecurityError';
    this.code = code;
    if (details !== undefined) this.details = deepFreeze(cloneJson(details));
  }
}

function fail(code, message, details) {
  throw new DemoSecurityError(code, message, details);
}

function exactKeys(value, keys) {
  return isPlainObject(value)
    && JSON.stringify(Object.keys(value).sort()) === JSON.stringify([...keys].sort());
}

function samePath(left, right) {
  const a = path.normalize(path.resolve(left));
  const b = path.normalize(path.resolve(right));
  return process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b;
}

function inside(root, candidate, { allowEqual = false } = {}) {
  const relative = path.relative(root, candidate);
  if (relative === '') return allowEqual;
  return relative !== '..'
    && !relative.startsWith(`..${path.sep}`)
    && !path.isAbsolute(relative);
}

function requireInteger(value, field, minimum, maximum) {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    fail('DEMO_LIMIT_INVALID', `${field} must be an integer between ${minimum} and ${maximum}`);
  }
  return value;
}

function normalizeFieldName(value) {
  return value
    .normalize('NFKC')
    .replace(/([A-Z]+)([A-Z][a-z])/g, '$1_$2')
    .replace(/([a-z0-9])([A-Z])/g, '$1_$2')
    .replace(/[^A-Za-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .toLowerCase();
}

function safeAuthorityMetadataKey(normalized) {
  return SAFE_AUTHORITY_METADATA_FIELDS.has(normalized);
}

function credentialComponentBeforeAuthorityMetadata(normalized) {
  const suffix = SAFE_AUTHORITY_METADATA_SUFFIX.exec(normalized);
  if (!suffix) return false;
  return SECRET_CREDENTIAL_COMPONENT.test(normalized.slice(0, suffix.index));
}

function secretBearingKey(value) {
  if (typeof value !== 'string') return false;
  const normalized = normalizeFieldName(value);
  if (credentialComponentBeforeAuthorityMetadata(normalized)) return true;
  if (safeAuthorityMetadataKey(normalized)) return false;
  return containsSecretShapedText(value)
    || SECRET_FIELD_NAMES.has(normalized)
    || SECRET_FIELD_PATTERNS.some((pattern) => pattern.test(normalized));
}

function failAllowedAbsolutePath() {
  fail(
    'DEMO_ALLOWED_ABSOLUTE_PATH_INVALID',
    'allowedAbsolutePaths must contain only bounded canonical absolute paths',
  );
}

function canonicalAllowedAbsolutePath(value) {
  if (
    typeof value !== 'string'
    || value === ''
    || value !== value.trim()
    || Buffer.byteLength(value, 'utf8') > MAX_ALLOWED_ABSOLUTE_PATH_BYTES
    || /[\u0000-\u001f\u007f]/.test(value)
    || /^file:/i.test(value)
    || /^(?:\\\\|\/\/)[?.](?:\\|\/)/.test(value)
  ) {
    failAllowedAbsolutePath();
  }
  const segments = value.split(/[\\/]/u);
  if (segments.some((segment) => segment === '.' || segment === '..')) {
    failAllowedAbsolutePath();
  }
  const canonicalPosix = value.startsWith('/')
    && !value.startsWith('//')
    && !value.includes('\\')
    && path.posix.isAbsolute(value)
    && path.posix.normalize(value) === value;
  const canonicalWindows = (
    /^[A-Za-z]:\\/u.test(value)
    || /^\\\\[^\\/]+\\[^\\/]+/u.test(value)
  )
    && path.win32.isAbsolute(value)
    && path.win32.normalize(value) === value;
  if (!canonicalPosix && !canonicalWindows) failAllowedAbsolutePath();
  return value;
}

function allowedAbsolutePathsOption(value) {
  if (value === undefined) return Object.freeze([]);
  if (!Array.isArray(value) || value.length > MAX_ALLOWED_ABSOLUTE_PATHS) {
    failAllowedAbsolutePath();
  }
  const descriptors = Object.getOwnPropertyDescriptors(value);
  const allowed = [];
  for (let index = 0; index < value.length; index += 1) {
    const descriptor = descriptors[String(index)];
    if (!descriptor || !Object.hasOwn(descriptor, 'value')) failAllowedAbsolutePath();
    const candidate = canonicalAllowedAbsolutePath(descriptor.value);
    if (allowed.includes(candidate)) failAllowedAbsolutePath();
    allowed.push(candidate);
  }
  return Object.freeze(allowed);
}

function maskAllowedAbsolutePaths(value, allowedAbsolutePaths) {
  if (allowedAbsolutePaths.length === 0) return value;
  if (allowedAbsolutePaths.includes(value)) return ALLOWED_ABSOLUTE_PATH_PLACEHOLDER;
  let masked = value;
  for (const allowedPath of allowedAbsolutePaths) {
    const quoted = JSON.stringify(allowedPath);
    const replacement = JSON.stringify(ALLOWED_ABSOLUTE_PATH_PLACEHOLDER);
    let cursor = 0;
    let transformed = '';
    while (cursor < masked.length) {
      const tokenIndex = masked.indexOf(quoted, cursor);
      if (tokenIndex === -1) break;
      const afterToken = tokenIndex + quoted.length;
      let delimiterIndex = afterToken;
      while (
        delimiterIndex < masked.length
        && /[\t\n\r ]/u.test(masked[delimiterIndex])
      ) {
        delimiterIndex += 1;
      }
      const keyPosition = [':', '='].includes(masked[delimiterIndex]);
      transformed += masked.slice(cursor, tokenIndex);
      transformed += keyPosition ? quoted : replacement;
      cursor = afterToken;
    }
    masked = `${transformed}${masked.slice(cursor)}`;
  }
  return masked;
}

function isHttpUrlCandidate(source, candidateStart, candidate) {
  if (!candidate.startsWith('//')) return false;
  return /(?:^|[^A-Za-z0-9+.-])https?:$/i.test(source.slice(0, candidateStart));
}

function splitPosixTrailingPunctuation(candidate) {
  const match = POSIX_TRAILING_PUNCTUATION_PATTERN.exec(candidate);
  if (!match) return { pathValue: candidate, trailing: '' };
  return {
    pathValue: candidate.slice(0, -match[1].length),
    trailing: match[1],
  };
}

function transformPrivateAbsolutePaths(value, { redact = false } = {}) {
  let findings = 0;
  let transformed = value;
  for (const pattern of PRIVATE_PATH_PATTERNS) {
    transformed = transformed.replace(pattern, (match, prefix, candidate) => {
      findings += 1;
      return `${prefix}${redact ? PRIVATE_PATH_REDACTION : candidate}`;
    });
  }
  transformed = transformed.replace(
    POSIX_PRIVATE_PATH_PATTERN,
    (match, prefix, candidate, offset, source) => {
      const candidateStart = offset + prefix.length;
      if (isHttpUrlCandidate(source, candidateStart, candidate)) return match;
      findings += 1;
      if (!redact) return match;
      const { trailing } = splitPosixTrailingPunctuation(candidate);
      return `${prefix}${PRIVATE_PATH_REDACTION}${trailing}`;
    },
  );
  return { findings, value: transformed };
}

function privateAbsolutePathKey(value) {
  return typeof value === 'string'
    && transformPrivateAbsolutePaths(value, { redact: true }).findings > 0;
}

function safeFindingPath(parent, key) {
  if (secretBearingKey(key)
    || privateAbsolutePathKey(key)
    || /[\u0000-\u001f\u007f]/.test(key)) {
    return `${parent}.<redacted-key>`;
  }
  const safe = key.replace(/[^A-Za-z0-9_.-]+/g, '_').slice(0, 80);
  return `${parent}.${safe || '<key>'}`;
}

export function scanDemoSecrets(value, options = {}) {
  const maxDepth = requireInteger(options.maxDepth ?? 50, 'maxDepth', 1, 100);
  const maxNodes = requireInteger(options.maxNodes ?? 20_000, 'maxNodes', 1, 100_000);
  const maxStringBytes = requireInteger(
    options.maxStringBytes ?? 1024 * 1024,
    'maxStringBytes',
    1,
    16 * 1024 * 1024,
  );
  const maxFindings = requireInteger(options.maxFindings ?? 100, 'maxFindings', 1, 1_000);
  const allowedAbsolutePaths = allowedAbsolutePathsOption(options.allowedAbsolutePaths);
  const findings = [];
  const seen = new WeakSet();
  let nodes = 0;

  function record(code, location) {
    if (findings.length < maxFindings) findings.push({ code, path: location });
  }

  function walk(current, location, depth) {
    nodes += 1;
    if (nodes > maxNodes) {
      record('value_too_complex', location);
      return;
    }
    if (depth > maxDepth) {
      record('value_too_deep', location);
      return;
    }
    if (typeof current === 'string') {
      if (Buffer.byteLength(current, 'utf8') > maxStringBytes) record('string_too_large', location);
      if (containsSecretShapedText(current)) record('secret_pattern', location);
      const pathScanValue = maskAllowedAbsolutePaths(current, allowedAbsolutePaths);
      if (transformPrivateAbsolutePaths(pathScanValue).findings > 0) {
        record('private_absolute_path', location);
      }
      return;
    }
    if (current === null || ['boolean', 'number'].includes(typeof current)) return;
    if (typeof current !== 'object') {
      record('non_json_value', location);
      return;
    }
    if (seen.has(current)) {
      record('cyclic_value', location);
      return;
    }
    seen.add(current);
    try {
      if (!Array.isArray(current) && !isPlainObject(current)) {
        record('non_plain_object', location);
        return;
      }
      const descriptors = Object.getOwnPropertyDescriptors(current);
      for (const [key, descriptor] of Object.entries(descriptors)) {
        if (Array.isArray(current) && key === 'length') continue;
        const childPath = Array.isArray(current) ? `${location}[${key}]` : safeFindingPath(location, key);
        if (DANGEROUS_KEYS.has(key)) record('dangerous_key', childPath);
        if (secretBearingKey(key)) record('secret_field', childPath);
        if (privateAbsolutePathKey(key)) record('private_absolute_path', childPath);
        if (!Object.hasOwn(descriptor, 'value')) {
          record('accessor_value', childPath);
          continue;
        }
        walk(descriptor.value, childPath, depth + 1);
      }
    } finally {
      seen.delete(current);
    }
  }

  walk(value, '$', 0);
  return deepFreeze({ safe: findings.length === 0, findings });
}

export function assertDemoSecretFree(value, field = 'value', options = {}) {
  const scan = scanDemoSecrets(value, options);
  if (!scan.safe) {
    fail('DEMO_SECRET_SHAPED_INPUT', `${field} was rejected by the deterministic secret scan`, {
      finding_codes: [...new Set(scan.findings.map((finding) => finding.code))].sort(),
      finding_count: scan.findings.length,
    });
  }
  return true;
}

export function redactDemoValue(value, options = {}) {
  const maxDepth = requireInteger(options.maxDepth ?? 25, 'maxDepth', 1, 100);
  const maxStringBytes = requireInteger(options.maxStringBytes ?? 64 * 1024, 'maxStringBytes', 1, 1024 * 1024);
  const seen = new WeakSet();

  function visit(current, depth) {
    if (depth > maxDepth) return '[REDACTED_DEPTH]';
    if (typeof current === 'string') {
      if (containsSecretShapedText(current)) return '[REDACTED_SECRET]';
      if (Buffer.byteLength(current, 'utf8') > maxStringBytes) return '[REDACTED_OVERSIZE_TEXT]';
      return transformPrivateAbsolutePaths(current, { redact: true }).value;
    }
    if (current === null || ['boolean', 'number'].includes(typeof current)) return current;
    if (typeof current !== 'object') return '[REDACTED_NON_JSON]';
    if (seen.has(current)) return '[REDACTED_CYCLE]';
    if (!Array.isArray(current) && !isPlainObject(current)) return '[REDACTED_NON_PLAIN_OBJECT]';
    seen.add(current);
    try {
      const descriptors = Object.getOwnPropertyDescriptors(current);
      if (Array.isArray(current)) {
        const output = [];
        for (let index = 0; index < current.length; index += 1) {
          const descriptor = descriptors[String(index)];
          output.push(descriptor && Object.hasOwn(descriptor, 'value')
            ? visit(descriptor.value, depth + 1)
            : '[REDACTED_ACCESSOR_OR_HOLE]');
        }
        return output;
      }
      const output = {};
      const reservedKeys = new Set(Object.keys(descriptors).filter((key) => (
        !secretBearingKey(key)
        && !privateAbsolutePathKey(key)
        && !DANGEROUS_KEYS.has(key)
      )));
      let redactedKey = 0;
      for (const [key, descriptor] of Object.entries(descriptors)) {
        const sensitiveField = secretBearingKey(key)
          || privateAbsolutePathKey(key)
          || DANGEROUS_KEYS.has(key);
        let targetKey = key;
        if (sensitiveField) {
          do {
            targetKey = `[REDACTED_FIELD_${redactedKey += 1}]`;
          } while (reservedKeys.has(targetKey) || Object.hasOwn(output, targetKey));
        }
        output[targetKey] = sensitiveField
          ? '[REDACTED_SECRET]'
          : Object.hasOwn(descriptor, 'value')
            ? visit(descriptor.value, depth + 1)
            : '[REDACTED_ACCESSOR]';
      }
      return output;
    } finally {
      seen.delete(current);
    }
  }

  return deepFreeze(visit(value, 0));
}

export function sanitizeDemoError(error, { code = 'DEMO_OPERATION_FAILED' } = {}) {
  const safeCode = typeof code === 'string' && /^[A-Z][A-Z0-9_]{0,79}$/.test(code)
    ? code
    : 'DEMO_OPERATION_FAILED';
  const rawMessage = typeof error?.message === 'string' ? error.message : '';
  let message = 'Demo operation failed';
  if (rawMessage && !containsSecretShapedText(rawMessage)) {
    message = transformPrivateAbsolutePaths(rawMessage, { redact: true }).value
      .replace(/[\u0000-\u001f\u007f]+/g, ' ')
      .trim()
      .slice(0, 500) || message;
  }
  return deepFreeze({ status: 'failed', code: safeCode, message });
}

export function createDemoTruth(extra = {}) {
  if (!isPlainObject(extra)) fail('DEMO_TRUTH_INVALID', 'Demo truth extras must be a JSON object');
  for (const key of Object.keys(extra)) {
    if (TRUTH_KEYS.has(key)) fail('DEMO_TRUTH_OVERRIDE', 'Demo truth fields cannot be overridden');
  }
  assertDemoSecretFree(extra, 'Demo truth extras');
  const result = {
    banner: RISK_FORK_DEMO_BANNER,
    ...RISK_FORK_DEMO_TRUTH_FIELDS,
    ...cloneJson(extra),
  };
  return deepFreeze(result);
}

export function assertDemoTruth(value) {
  if (!isPlainObject(value) || !safeEqual(value.banner, RISK_FORK_DEMO_BANNER)) {
    fail('DEMO_TRUTH_INVALID', 'Demo result is missing the exact safety banner');
  }
  for (const [key, expected] of Object.entries(RISK_FORK_DEMO_TRUTH_FIELDS)) {
    if (!Object.hasOwn(value, key) || value[key] !== expected) {
      fail('DEMO_TRUTH_INVALID', `Demo result has an invalid ${key} truth field`);
    }
  }
  assertDemoSecretFree(value, 'Demo result');
  return true;
}

export function normalizeDemoRelativePath(value, field = 'path') {
  if (typeof value !== 'string' || value === '' || value !== value.trim()) {
    fail('DEMO_PATH_INVALID', `${field} must be a non-empty canonical relative path`);
  }
  if (value.includes('\\') || value !== value.normalize('NFC')) {
    fail('DEMO_PATH_INVALID', `${field} must use forward slashes and NFC normalization`);
  }
  let normalized;
  try {
    normalized = normalizeRelativePath(value, field);
  } catch {
    fail('DEMO_PATH_INVALID', `${field} must be a safe canonical relative path`);
  }
  if (normalized !== value || path.posix.normalize(value) !== value) {
    fail('DEMO_PATH_INVALID', `${field} is not canonical`);
  }
  for (const segment of normalized.split('/')) {
    const stem = segment.split('.')[0];
    if (segment === '.git' || WINDOWS_RESERVED_BASENAME.test(stem)) {
      fail('DEMO_PATH_INVALID', `${field} contains a reserved path segment`);
    }
    if (/[\u0000-\u001f\u007f]/.test(segment)) {
      fail('DEMO_PATH_INVALID', `${field} contains a control character`);
    }
  }
  return normalized;
}

function normalizeRootPath(rootPath) {
  if (typeof rootPath !== 'string' || rootPath.trim() === '') {
    fail('DEMO_ROOT_INVALID', 'Demo root path must be a non-empty string');
  }
  const resolved = path.resolve(rootPath);
  if (samePath(resolved, path.parse(resolved).root)
    || samePath(resolved, os.homedir())
    || samePath(resolved, process.cwd())) {
    fail('DEMO_ROOT_TOO_BROAD', 'Refusing to use a broad directory as the demo root');
  }
  return resolved;
}

async function statOrNull(target) {
  try {
    return await lstat(target);
  } catch (error) {
    if (error?.code === 'ENOENT') return null;
    throw error;
  }
}

async function assertRealDirectory(target, label) {
  const info = await statOrNull(target);
  if (!info || !info.isDirectory() || info.isSymbolicLink()) {
    fail('DEMO_PATH_UNSAFE', `${label} must be a real directory`);
  }
  const actual = await realpath(target);
  if (!samePath(actual, target)) fail('DEMO_PATH_UNSAFE', `${label} traverses a symlink or reparse point`);
  return actual;
}

function markerHash(marker) {
  return sha256Ref({ ...marker, marker_hash: null });
}

async function readAndVerifyMarker(rootPath, rootRealPath) {
  const markerPath = path.join(rootPath, RISK_FORK_DEMO_ROOT_MARKER);
  const info = await statOrNull(markerPath);
  if (!info || !info.isFile() || info.isSymbolicLink() || info.nlink > 1 || info.size > 16 * 1024) {
    fail('DEMO_ROOT_MARKER_INVALID', 'Demo root marker is missing or unsafe');
  }
  const markerRealPath = await realpath(markerPath);
  if (!samePath(markerRealPath, markerPath) || !inside(rootRealPath, markerRealPath)) {
    fail('DEMO_ROOT_MARKER_INVALID', 'Demo root marker escapes its root');
  }
  let marker;
  try {
    marker = JSON.parse(await readFile(markerPath, 'utf8'));
  } catch {
    fail('DEMO_ROOT_MARKER_INVALID', 'Demo root marker is not valid JSON');
  }
  if (!exactKeys(marker, ROOT_MARKER_KEYS)
    || marker.schema !== ROOT_MARKER_SCHEMA
    || typeof marker.root_id !== 'string'
    || !/^demo-root-[a-f0-9]{32}$/.test(marker.root_id)
    || marker.root_path_hash !== sha256Ref(rootRealPath)
    || typeof marker.created_at !== 'string'
    || new Date(marker.created_at).toISOString() !== marker.created_at
    || !safeEqual(marker.marker_hash, markerHash(marker))) {
    fail('DEMO_ROOT_MARKER_INVALID', 'Demo root marker failed its exact binding contract');
  }
  return marker;
}

function makeHandle(rootPath, rootRealPath, marker) {
  return deepFreeze({
    schema: ROOT_HANDLE_SCHEMA,
    root_path: rootPath,
    root_real_path: rootRealPath,
    root_id: marker.root_id,
    marker_hash: marker.marker_hash,
  });
}

export async function openOwnedDemoRoot(rootPath) {
  const root = normalizeRootPath(rootPath);
  const rootRealPath = await assertRealDirectory(root, 'Demo root');
  const marker = await readAndVerifyMarker(root, rootRealPath);
  return makeHandle(root, rootRealPath, marker);
}

export async function initializeOwnedDemoRoot(rootPath, options = {}) {
  const root = normalizeRootPath(rootPath);
  const clock = options.clock ?? (() => new Date());
  const randomBytesFn = options.randomBytesFn ?? randomBytes;
  if (typeof clock !== 'function' || typeof randomBytesFn !== 'function') {
    fail('DEMO_ROOT_INVALID', 'Demo root clock and entropy provider must be functions');
  }
  const existing = await statOrNull(root);
  if (!existing) {
    await assertRealDirectory(path.dirname(root), 'Demo root parent');
    await mkdir(root, { recursive: false, mode: 0o700 });
  } else {
    await assertRealDirectory(root, 'Demo root');
  }
  const rootRealPath = await assertRealDirectory(root, 'Demo root');
  const entries = await readdir(root);
  if (entries.includes(RISK_FORK_DEMO_ROOT_MARKER)) return openOwnedDemoRoot(root);
  if (entries.length !== 0) fail('DEMO_ROOT_NOT_OWNED', 'Refusing to adopt an unmarked non-empty demo root');
  const entropy = randomBytesFn(16);
  if (!Buffer.isBuffer(entropy) || entropy.byteLength !== 16) {
    fail('DEMO_ROOT_INVALID', 'Demo root entropy provider must return exactly 16 bytes');
  }
  const createdAtValue = clock();
  const createdAt = createdAtValue instanceof Date
    ? createdAtValue.toISOString()
    : new Date(createdAtValue).toISOString();
  const base = {
    schema: ROOT_MARKER_SCHEMA,
    root_id: `demo-root-${entropy.toString('hex')}`,
    root_path_hash: sha256Ref(rootRealPath),
    created_at: createdAt,
    marker_hash: null,
  };
  const marker = { ...base, marker_hash: markerHash(base) };
  await writeFile(
    path.join(root, RISK_FORK_DEMO_ROOT_MARKER),
    `${canonicalize(marker)}\n`,
    { encoding: 'utf8', flag: 'wx', mode: 0o600 },
  );
  return openOwnedDemoRoot(root);
}

async function reopenRoot(rootOrHandle) {
  if (typeof rootOrHandle === 'string') return openOwnedDemoRoot(rootOrHandle);
  if (!exactKeys(rootOrHandle, ROOT_HANDLE_KEYS) || rootOrHandle.schema !== ROOT_HANDLE_SCHEMA) {
    fail('DEMO_ROOT_HANDLE_INVALID', 'Owned demo root handle is invalid');
  }
  const opened = await openOwnedDemoRoot(rootOrHandle.root_path);
  for (const key of ['root_real_path', 'root_id', 'marker_hash']) {
    if (!safeEqual(opened[key], rootOrHandle[key])) {
      fail('DEMO_ROOT_HANDLE_INVALID', 'Owned demo root handle no longer matches its marker');
    }
  }
  return opened;
}

export async function resolveOwnedDemoPath(
  rootOrHandle,
  relativePath,
  { mustExist = false, expectedType = 'any' } = {},
) {
  if (!['any', 'file', 'directory'].includes(expectedType)) {
    fail('DEMO_PATH_INVALID', 'expectedType must be any, file, or directory');
  }
  const root = await reopenRoot(rootOrHandle);
  const relative = normalizeDemoRelativePath(relativePath, 'Demo child path');
  if (relative === RISK_FORK_DEMO_ROOT_MARKER || relative.startsWith(`${RISK_FORK_DEMO_ROOT_MARKER}/`)) {
    fail('DEMO_PATH_INVALID', 'The owned-root marker is not an addressable demo child');
  }
  const absolute = path.resolve(root.root_path, ...relative.split('/'));
  if (!inside(root.root_path, absolute)) fail('DEMO_PATH_ESCAPE', 'Demo child path escapes its owned root');
  const segments = relative.split('/');
  let current = root.root_path;
  let exists = true;
  let finalInfo = null;
  for (let index = 0; index < segments.length; index += 1) {
    current = path.join(current, segments[index]);
    const info = await statOrNull(current);
    if (!info) {
      exists = false;
      break;
    }
    if (info.isSymbolicLink()) fail('DEMO_PATH_UNSAFE', 'Demo child traverses a symlink or junction');
    const currentReal = await realpath(current);
    const expectedReal = path.join(root.root_real_path, ...segments.slice(0, index + 1));
    if (!inside(root.root_real_path, currentReal) || !samePath(currentReal, expectedReal)) {
      fail('DEMO_PATH_UNSAFE', 'Demo child traverses a reparse point or escapes its root');
    }
    const final = index === segments.length - 1;
    if (!final && !info.isDirectory()) fail('DEMO_PATH_UNSAFE', 'Demo child has a non-directory ancestor');
    if (info.isFile() && info.nlink > 1) fail('DEMO_PATH_UNSAFE', 'Hard-linked demo files are forbidden');
    if (!info.isFile() && !info.isDirectory()) fail('DEMO_PATH_UNSAFE', 'Special demo filesystem entries are forbidden');
    if (final) finalInfo = info;
  }
  if (mustExist && !exists) fail('DEMO_PATH_MISSING', 'Required owned demo child does not exist');
  if (exists && expectedType === 'file' && !finalInfo?.isFile()) {
    fail('DEMO_PATH_TYPE_MISMATCH', 'Owned demo child is not a regular file');
  }
  if (exists && expectedType === 'directory' && !finalInfo?.isDirectory()) {
    fail('DEMO_PATH_TYPE_MISMATCH', 'Owned demo child is not a real directory');
  }
  return deepFreeze({
    root,
    relative_path: relative,
    absolute_path: absolute,
    exists,
    type: !exists ? 'absent' : finalInfo.isDirectory() ? 'directory' : 'file',
  });
}

export async function inspectOwnedDemoTree(rootOrHandle, options = {}) {
  const root = await reopenRoot(rootOrHandle);
  const maxFiles = requireInteger(options.maxFiles ?? 10_000, 'maxFiles', 1, 100_000);
  const maxBytes = requireInteger(
    options.maxBytes ?? RISK_FORK_DEMO_LIMITS.max_root_bytes,
    'maxBytes',
    1,
    1024 * 1024 * 1024,
  );
  const includeMarker = options.includeMarker === true;
  let startPath = root.root_path;
  let startRelative = '';
  if (options.subpath !== undefined && options.subpath !== null) {
    const resolved = await resolveOwnedDemoPath(root, options.subpath, {
      mustExist: true,
      expectedType: 'directory',
    });
    startPath = resolved.absolute_path;
    startRelative = resolved.relative_path;
  }
  const entries = [];
  const folded = new Map();
  let fileCount = 0;
  let directoryCount = 0;
  let totalBytes = 0;

  async function walk(directory, prefix) {
    const children = await readdir(directory, { withFileTypes: true });
    children.sort((left, right) => left.name < right.name ? -1 : left.name > right.name ? 1 : 0);
    for (const child of children) {
      const relative = prefix ? `${prefix}/${child.name}` : child.name;
      if (!startRelative && relative === RISK_FORK_DEMO_ROOT_MARKER) {
        if (includeMarker) {
          const markerInfo = await lstat(path.join(directory, child.name));
          entries.push({ path: relative, type: 'file', bytes: markerInfo.size });
        }
        continue;
      }
      const canonical = normalizeDemoRelativePath(relative, 'Owned demo inventory path');
      const key = canonical.normalize('NFC').toLocaleLowerCase('en-US');
      const previous = folded.get(key);
      if (previous && previous !== canonical) {
        fail('DEMO_PATH_COLLISION', 'Owned demo tree contains a case or Unicode path collision');
      }
      folded.set(key, canonical);
      const resolved = await resolveOwnedDemoPath(root, canonical, { mustExist: true });
      if (resolved.type === 'directory') {
        directoryCount += 1;
        entries.push({ path: canonical, type: 'directory', bytes: 0 });
        await walk(resolved.absolute_path, canonical);
      } else {
        const info = await lstat(resolved.absolute_path);
        fileCount += 1;
        totalBytes += info.size;
        if (fileCount > maxFiles) fail('DEMO_FILE_LIMIT', `Owned demo tree exceeds ${maxFiles} files`);
        if (totalBytes > maxBytes) fail('DEMO_BYTE_LIMIT', `Owned demo tree exceeds ${maxBytes} bytes`);
        entries.push({ path: canonical, type: 'file', bytes: info.size });
      }
    }
  }

  await walk(startPath, startRelative);
  entries.sort((left, right) => left.path < right.path ? -1 : left.path > right.path ? 1 : 0);
  return deepFreeze({
    file_count: fileCount,
    directory_count: directoryCount,
    total_bytes: totalBytes,
    entries,
  });
}

export async function removeOwnedDemoEntry(rootOrHandle, relativePath, options = {}) {
  const root = await reopenRoot(rootOrHandle);
  const resolved = await resolveOwnedDemoPath(root, relativePath, { mustExist: false });
  if (!resolved.exists) {
    return deepFreeze({ status: 'verified_absent', relative_path: resolved.relative_path, removed: false });
  }
  if (resolved.type === 'directory') {
    await inspectOwnedDemoTree(root, {
      subpath: resolved.relative_path,
      maxFiles: 100_000,
      maxBytes: RISK_FORK_DEMO_LIMITS.max_root_bytes,
    });
  }
  const maxRetries = requireInteger(options.maxRetries ?? 5, 'maxRetries', 0, 20);
  const retryDelay = requireInteger(options.retryDelay ?? 25, 'retryDelay', 0, 1_000);
  await reopenRoot(root);
  await resolveOwnedDemoPath(root, resolved.relative_path, { mustExist: true });
  await rm(resolved.absolute_path, {
    recursive: resolved.type === 'directory',
    force: false,
    maxRetries,
    retryDelay,
  });
  if (await statOrNull(resolved.absolute_path)) {
    fail('DEMO_CLEANUP_UNKNOWN', 'Owned demo child absence could not be verified');
  }
  await reopenRoot(root);
  return deepFreeze({ status: 'verified_absent', relative_path: resolved.relative_path, removed: true });
}

export function validateDemoOperation(value) {
  const authorityFree = validateChildOperation(value, 'hackathon demo operation');
  assertDemoSecretFree(authorityFree, 'Hackathon demo operation');
  if (!Array.isArray(authorityFree.actions)) {
    fail('DEMO_OPERATION_INVALID', 'Hackathon demo operation actions must be an array');
  }
  if (authorityFree.actions.length > RISK_FORK_DEMO_LIMITS.max_actions) {
    fail('DEMO_ACTION_LIMIT', `Hackathon demo operation exceeds ${RISK_FORK_DEMO_LIMITS.max_actions} actions`);
  }
  const paths = new Map();
  for (const [index, action] of authorityFree.actions.entries()) {
    if (!isPlainObject(action)) fail('DEMO_OPERATION_INVALID', `actions[${index}] must be an object`);
    const relative = normalizeDemoRelativePath(action.path, `actions[${index}].path`);
    const key = relative.normalize('NFC').toLocaleLowerCase('en-US');
    if (paths.has(key)) fail('DEMO_PATH_COLLISION', 'Hackathon demo operation contains duplicate or aliased paths');
    paths.set(key, relative);
    if (action.type === 'write') {
      const bytes = Buffer.byteLength(action.content ?? '', 'utf8');
      if (bytes > RISK_FORK_DEMO_LIMITS.max_write_bytes) {
        fail('DEMO_WRITE_LIMIT', `actions[${index}].content exceeds ${RISK_FORK_DEMO_LIMITS.max_write_bytes} bytes`);
      }
    }
  }
  const normalized = validateLocalReferenceOperation(authorityFree);
  return deepFreeze(cloneJson(normalized));
}
