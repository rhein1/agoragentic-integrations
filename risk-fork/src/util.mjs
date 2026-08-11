import { timingSafeEqual } from 'node:crypto';
import path from 'node:path';

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
  const unexpected = Object.keys(value).filter((key) => !allowed.includes(key));
  if (unexpected.length > 0) {
    throw new TypeError(`${field} contains unsupported fields: ${unexpected.sort().join(', ')}`);
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

const SECRET_SHAPED_TEXT = Object.freeze([
  /-----BEGIN (?:RSA |EC |OPENSSH |PGP )?PRIVATE KEY-----/i,
  /\bBearer\s+[A-Za-z0-9._~+/=-]{12,}/i,
  /\b(?:sk|amk|ghp|github_pat|xox[baprs])-[_a-zA-Z0-9-]{12,}\b/,
  /\bAKIA[A-Z0-9]{16}\b/,
  /(?:api[_-]?key|access[_-]?token|refresh[_-]?token|private[_-]?key|mnemonic)\s*[=:]\s*[^&\s]{8,}/i,
]);

export function assertNoSecretShapedText(value, field) {
  const normalized = requireString(value, field);
  if (SECRET_SHAPED_TEXT.some((pattern) => pattern.test(normalized))) {
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
