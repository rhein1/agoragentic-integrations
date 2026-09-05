import { timingSafeEqual } from 'node:crypto';
import path from 'node:path';

function detachArray(value) {
  Object.setPrototypeOf(value, null);
  return value;
}

function createDetachedArray(length = 0) {
  return detachArray(new Array(length));
}

function defineArrayIndex(value, index, child) {
  Object.defineProperty(value, String(index), {
    value: child,
    writable: true,
    enumerable: true,
    configurable: true,
  });
}

function arrayContains(value, expected) {
  for (let index = 0; index < value.length; index += 1) {
    if (value[index] === expected) return true;
  }
  return false;
}

function sortStrings(value) {
  for (let index = 1; index < value.length; index += 1) {
    const candidate = value[index];
    let cursor = index - 1;
    while (cursor >= 0 && value[cursor] > candidate) {
      value[cursor + 1] = value[cursor];
      cursor -= 1;
    }
    value[cursor + 1] = candidate;
  }
  return value;
}

function joinStrings(value, separator) {
  let joined = '';
  for (let index = 0; index < value.length; index += 1) {
    if (index > 0) joined += separator;
    joined += value[index];
  }
  return joined;
}

export function isPlainObject(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

export function assertPlainObject(value, field) {
  if (!isPlainObject(value)) throw new TypeError(`${field} must be a JSON object`);
  return value;
}

export function assertAllowedKeys(value, allowed, field) {
  assertPlainObject(value, field);
  const keys = detachArray(Object.keys(value));
  const unexpected = createDetachedArray();
  let unexpectedCount = 0;
  for (let index = 0; index < keys.length; index += 1) {
    const key = keys[index];
    if (!arrayContains(allowed, key)) {
      defineArrayIndex(unexpected, unexpectedCount, key);
      unexpectedCount += 1;
    }
  }
  if (unexpected.length > 0) {
    for (let index = 0; index < unexpected.length; index += 1) {
      if (containsSecretShapedText(unexpected[index])) {
        throw new TypeError(`${field} contains an unsupported secret-shaped field`);
      }
    }
    throw new TypeError(
      `${field} contains unsupported fields: ${joinStrings(sortStrings(unexpected), ', ')}`,
    );
  }
}

export function requireString(value, field, { maxLength = 4096, pattern = null } = {}) {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new TypeError(`${field} must be a non-empty string`);
  }
  const normalized = value.trim();
  if (normalized.length > maxLength) throw new TypeError(`${field} exceeds ${maxLength} characters`);
  if (pattern && !pattern.test(normalized)) throw new TypeError(`${field} has an invalid format`);
  return normalized;
}

export function optionalString(value, field, options = {}) {
  return value === undefined || value === null || value === ''
    ? null
    : requireString(value, field, options);
}

export function requireIsoDate(value, field) {
  const normalized = value instanceof Date ? value.toISOString() : requireString(value, field);
  const parsed = Date.parse(normalized);
  if (!Number.isFinite(parsed)) throw new TypeError(`${field} must be an ISO 8601 date-time`);
  return new Date(parsed).toISOString();
}

export function requireSha256Ref(value, field) {
  return requireString(value, field, { pattern: /^sha256:[a-f0-9]{64}$/ });
}

// Production Agoragentic API keys are generated as `amk_` plus 64 lowercase
// hexadecimal characters. Match that exact generated form without word
// boundaries so embedding the complete key inside another string cannot hide
// it. Deliberately do not classify documentation placeholders such as
// `amk_your_api_key_here` as credentials.
export const AGORAGENTIC_GENERATED_API_KEY_PATTERN = /amk_[a-f0-9]{64}/;
export const AGORAGENTIC_API_KEY_PATTERN = AGORAGENTIC_GENERATED_API_KEY_PATTERN;

// These provider prefixes are distinctive enough to detect without a leading
// word boundary. That closes recoverable prefix wrapping while avoiding the
// false positives that an unbounded generic `sk_` matcher would create in
// ordinary identifiers such as `risk_fork_*`.
export const EMBEDDED_CREDENTIAL_TOKEN_PATTERN =
  /(?:(?:gh[pousr]|github_pat|xox[baprs])[-_][A-Za-z0-9_-]{12,}|AKIA[A-Z0-9]{16}|sk-(?:(?:proj|svcacct|ant)-[A-Za-z0-9_-]{12,}|[A-Za-z0-9]{32,}))/;

export const BEARER_CREDENTIAL_PATTERN = /Bearer\s+[A-Za-z0-9._~+/=-]{8,}/i;

export const GENERIC_CREDENTIAL_TOKEN_PATTERN =
  /\b(?:sk|gh[pousr]|github_pat|xox[baprs])[-_][A-Za-z0-9_-]{12,}\b/;

const SECRET_SHAPED_TEXT = Object.freeze(detachArray([
  /-----BEGIN (?:RSA |EC |OPENSSH |PGP )?PRIVATE KEY-----/i,
  BEARER_CREDENTIAL_PATTERN,
  AGORAGENTIC_API_KEY_PATTERN,
  EMBEDDED_CREDENTIAL_TOKEN_PATTERN,
  GENERIC_CREDENTIAL_TOKEN_PATTERN,
  /\bAKIA[A-Z0-9]{16}\b/,
  /(?:api[_-]?key|access[_-]?token|refresh[_-]?token|private[_-]?key|mnemonic)\s*[=:]\s*[^&\s]{8,}/i,
]));

const AUTHORIZATION_VALUE_PATTERN =
  /\b(?:proxy-)?authorization\s*:\s*[A-Za-z][A-Za-z0-9_-]*(?:\s+[A-Za-z0-9._~+/=-]+)?/i;
const URL_USERINFO_PATTERN =
  /(?:^|[^A-Za-z0-9+.-])[A-Za-z][A-Za-z0-9+.-]*:\/\/[^/?#\s@]+@/;
const PATH_USERINFO_PATTERN =
  /(?:^|[\\/])[^\\/?#\s:@]+:[^\\/?#\s@]+@[^\\/?#\s]+(?=$|[\\/])/;

export function containsSecretShapedText(value) {
  if (typeof value !== 'string') return false;
  for (let index = 0; index < SECRET_SHAPED_TEXT.length; index += 1) {
    if (SECRET_SHAPED_TEXT[index].test(value)) return true;
  }
  return false;
}

function isWhitespaceCharacter(value) {
  return /\s/u.test(value);
}

function isBasicBoundary(value, index) {
  if (index === 0) return true;
  const previous = value.charCodeAt(index - 1);
  const embeddedIdentifier = (previous >= 0x30 && previous <= 0x39)
    || (previous >= 0x41 && previous <= 0x5a)
    || (previous >= 0x61 && previous <= 0x7a)
    || previous === 0x2d
    || previous === 0x2e
    || previous === 0x5f;
  return !embeddedIdentifier;
}

function hasCaseInsensitiveBasicAt(value, index) {
  if (index + 5 > value.length) return false;
  return (value.charCodeAt(index) | 0x20) === 0x62
    && (value.charCodeAt(index + 1) | 0x20) === 0x61
    && (value.charCodeAt(index + 2) | 0x20) === 0x73
    && (value.charCodeAt(index + 3) | 0x20) === 0x69
    && (value.charCodeAt(index + 4) | 0x20) === 0x63;
}

function isToken68CharacterCode(code) {
  return (code >= 0x30 && code <= 0x39)
    || (code >= 0x41 && code <= 0x5a)
    || (code >= 0x61 && code <= 0x7a)
    || code === 0x2b
    || code === 0x2d
    || code === 0x2e
    || code === 0x2f
    || code === 0x3d
    || code === 0x5f
    || code === 0x7e;
}

function basicTokenStartAt(value, index) {
  if (!hasCaseInsensitiveBasicAt(value, index) || !isBasicBoundary(value, index)) return -1;
  let cursor = index + 5;
  if (cursor >= value.length || !isWhitespaceCharacter(value[cursor])) return -1;
  while (cursor < value.length && isWhitespaceCharacter(value[cursor])) cursor += 1;
  return cursor < value.length && isToken68CharacterCode(value.charCodeAt(cursor))
    ? cursor
    : -1;
}

function decodedBasicCandidateContainsColon(value, start, end) {
  if (start >= end) return false;
  const encoded = value.slice(start, end).replace(/[\t ]/g, '');
  return encoded.length > 0 && Buffer.from(encoded, 'base64').includes(0x3a);
}

function containsBasicAuthorization(value) {
  let search = 0;
  while (search < value.length) {
    let tokenStart = -1;
    while (search < value.length) {
      tokenStart = basicTokenStartAt(value, search);
      if (tokenStart !== -1) break;
      search += 1;
    }
    if (tokenStart === -1) return false;

    let candidateStart = tokenStart;
    let cursor = tokenStart;
    while (cursor < value.length) {
      const nestedTokenStart = basicTokenStartAt(value, cursor);
      if (nestedTokenStart !== -1) {
        if (decodedBasicCandidateContainsColon(value, candidateStart, cursor)) return true;
        candidateStart = nestedTokenStart;
        cursor = nestedTokenStart;
        continue;
      }
      const code = value.charCodeAt(cursor);
      if (isToken68CharacterCode(code) || code === 0x09 || code === 0x20) {
        cursor += 1;
        continue;
      }
      break;
    }
    if (decodedBasicCandidateContainsColon(value, candidateStart, cursor)) return true;
    search = cursor + 1;
  }
  return false;
}

export function containsSerializedCredentialMaterial(value) {
  if (typeof value !== 'string') return false;
  return containsSecretShapedText(value)
    || containsBasicAuthorization(value)
    || AUTHORIZATION_VALUE_PATTERN.test(value)
    || URL_USERINFO_PATTERN.test(value)
    || PATH_USERINFO_PATTERN.test(value);
}

export function assertNoSecretShapedText(value, field) {
  const normalized = requireString(value, field);
  if (containsSecretShapedText(normalized)) {
    throw new TypeError(`${field} appears to contain secret material`);
  }
  return normalized;
}

export function requireOpaqueRef(value, field, { maxLength = 1024 } = {}) {
  const normalized = assertNoSecretShapedText(
    requireString(value, field, { maxLength }),
    field,
  );
  if (/^[a-zA-Z]:[\\/]/.test(normalized)
    || /^[/\\]/.test(normalized)
    || /^~[\\/]/.test(normalized)
    || /^file:/i.test(normalized)
    || /[\u0000-\u001f\u007f]/.test(normalized)
    || /\s/.test(normalized)) {
    throw new TypeError(`${field} must be an opaque reference, not a local path or raw value`);
  }
  return normalized;
}

export function requireExternalEndpoint(value, field) {
  const normalized = assertNoSecretShapedText(value, field);
  let parsed;
  try {
    parsed = new URL(normalized);
  } catch {
    throw new TypeError(`${field} must be an absolute HTTP(S) endpoint`);
  }
  if (!['https:', 'http:'].includes(parsed.protocol)
    || parsed.username
    || parsed.password
    || parsed.search
    || parsed.hash) {
    throw new TypeError(`${field} must not contain credentials, query parameters, or a fragment`);
  }
  return parsed.toString();
}

export function requireEnum(value, allowed, field) {
  if (!allowed.includes(value)) throw new TypeError(`${field} must be one of: ${allowed.join(', ')}`);
  return value;
}

export function requireMcpMethodName(value, field = 'MCP method') {
  if (typeof value !== 'string' || value.length === 0) {
    throw new TypeError(`${field} must be a non-empty string`);
  }
  if (value.length > 300) throw new TypeError(`${field} exceeds 300 characters`);
  if (/[\u0000-\u001f\u007f]/.test(value)) {
    throw new TypeError(`${field} contains a forbidden control character`);
  }
  return value;
}

export function uniqueStrings(value, field, { maxItems = 100, maxLength = 4096 } = {}) {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) throw new TypeError(`${field} must be an array`);
  if (value.length > maxItems) throw new TypeError(`${field} exceeds ${maxItems} items`);
  return [...new Set(value.map((item, index) => requireString(
    item,
    `${field}[${index}]`,
    { maxLength },
  )))].sort();
}

export function deepFreeze(value) {
  if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value;
  for (const child of Object.values(value)) deepFreeze(child);
  return Object.freeze(value);
}

export function cloneJson(value) {
  return value === undefined ? undefined : JSON.parse(JSON.stringify(value));
}

export function safeEqual(left, right) {
  if (typeof left !== 'string' || typeof right !== 'string') return false;
  const a = Buffer.from(left, 'utf8');
  const b = Buffer.from(right, 'utf8');
  return a.length === b.length && timingSafeEqual(a, b);
}

export function normalizeRelativePath(value, field = 'path') {
  const normalized = requireString(value, field, { maxLength: 1024 })
    .replaceAll('\\', '/')
    .normalize('NFC');
  if (normalized.includes('\0')
    || normalized.startsWith('/')
    || /^[a-zA-Z]:\//.test(normalized)
    || normalized.includes(':')
    || normalized.split('/').includes('..')) {
    throw new TypeError(`${field} must be a safe relative path`);
  }
  const clean = path.posix.normalize(normalized).replace(/^\.\//, '');
  if (!clean || clean === '.' || clean.startsWith('../')) {
    throw new TypeError(`${field} must identify a file below the workspace root`);
  }
  for (const segment of clean.split('/')) {
    if (!segment || segment === '.' || /[. ]$/.test(segment)) {
      throw new TypeError(`${field} contains an ambiguous path segment`);
    }
    const stem = segment.split('.')[0].toUpperCase();
    if (/^(?:CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])$/.test(stem)) {
      throw new TypeError(`${field} contains a reserved device name`);
    }
  }
  return clean;
}

export function isPathAllowed(relativePath, allowlist) {
  if (!Array.isArray(allowlist) || allowlist.length === 0) return false;
  return allowlist.some((entry) => {
    const allowed = normalizeRelativePath(entry, 'path_allowlist entry').replace(/\/$/, '');
    return relativePath === allowed || relativePath.startsWith(`${allowed}/`);
  });
}

export function boundedInteger(value, field, { min = 0, max = Number.MAX_SAFE_INTEGER } = {}) {
  if (!Number.isInteger(value) || value < min || value > max) {
    throw new TypeError(`${field} must be an integer between ${min} and ${max}`);
  }
  return value;
}

export function nowIso(clock = () => new Date()) {
  return requireIsoDate(clock(), 'clock result');
}
