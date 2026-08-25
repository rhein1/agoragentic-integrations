import { canonicalize } from './canonical.mjs';
import {
  AGORAGENTIC_GENERATED_API_KEY_PATTERN,
  BEARER_CREDENTIAL_PATTERN,
  EMBEDDED_CREDENTIAL_TOKEN_PATTERN,
  GENERIC_CREDENTIAL_TOKEN_PATTERN,
  assertAllowedKeys,
  assertPlainObject,
  deepFreeze,
  normalizeRelativePath,
  requireEnum,
} from './util.mjs';

const MAX_OPERATION_BYTES = 1024 * 1024;
const MAX_OPERATION_NODES = 20_000;
const MAX_OPERATION_DEPTH = 50;
const MAX_LOCAL_ACTIONS = 500;
const MAX_LOCAL_FILE_BYTES = 512 * 1024;

const DANGEROUS_KEYS = new Set(['__proto__', 'constructor', 'prototype']);
const AUTHORITY_OR_SECRET_KEY_PATTERN = /(?:^|_)(?:api_key|apikey|access_token|accesstoken|refresh_token|refreshtoken|id_token|idtoken|auth|authorization|authorisation|authority|bearer|credential|credentials|password|passwd|passphrase|secret|client_secret|clientsecret|private_key|privatekey|signing_key|signingkey|seed_phrase|seedphrase|mnemonic|wallet|wallet_key|walletkey|approval|permission|permissions|capability_grant|capabilitygrant|capability_token|capabilitytoken|can_spend|can_execute|can_deploy|can_publish)(?:$|_)/i;

const AUTHORITY_OR_SECRET_VALUE_PATTERNS = Object.freeze([
  /-----BEGIN (?:RSA |EC |OPENSSH |PGP |ENCRYPTED )?[A-Z ]*PRIVATE KEY-----/i,
  BEARER_CREDENTIAL_PATTERN,
  AGORAGENTIC_GENERATED_API_KEY_PATTERN,
  EMBEDDED_CREDENTIAL_TOKEN_PATTERN,
  GENERIC_CREDENTIAL_TOKEN_PATTERN,
  /\be2b_[A-Za-z0-9_-]{12,}\b/,
  /\bAKIA[0-9A-Z]{16}\b/,
  /(?:api[_-]?key|access[_-]?token|refresh[_-]?token|authorization|authorisation|credential|password|passphrase|private[_-]?key|client[_-]?secret|seed[_-]?phrase|mnemonic|wallet[_-]?(?:key|secret))\s*[=:]\s*[^&\s"']{8,}/i,
  /[?&](?:api[_-]?key|access[_-]?token|refresh[_-]?token|authorization|credential|password|client[_-]?secret)=[^&\s]{8,}/i,
]);

function normalizedKey(value) {
  return value
    .normalize('NFKC')
    .replace(/([a-z0-9])([A-Z])/g, '$1_$2')
    .replace(/[^A-Za-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .toLowerCase();
}

function scanAuthorityFreeJson(value, field) {
  let nodes = 0;

  function walk(current, path, depth) {
    nodes += 1;
    if (nodes > MAX_OPERATION_NODES) throw new TypeError(`${field} is too complex`);
    if (depth > MAX_OPERATION_DEPTH) throw new TypeError(`${field} is too deeply nested`);
    if (typeof current === 'string') {
      if (AUTHORITY_OR_SECRET_VALUE_PATTERNS.some((pattern) => pattern.test(current))) {
        throw new TypeError(`${path} contains authority or secret-shaped material`);
      }
      return;
    }
    if (current === null || typeof current !== 'object') return;
    if (Array.isArray(current)) {
      for (let index = 0; index < current.length; index += 1) {
        walk(current[index], `${path}[${index}]`, depth + 1);
      }
      return;
    }
    for (const [key, child] of Object.entries(current)) {
      const normalized = normalizedKey(key);
      if (AUTHORITY_OR_SECRET_VALUE_PATTERNS.some((pattern) => pattern.test(key))) {
        throw new TypeError(`${path}.<key> contains authority or secret-shaped material`);
      }
      if (DANGEROUS_KEYS.has(key)) {
        throw new TypeError(`${path}.<key> is a forbidden JSON key`);
      }
      if (AUTHORITY_OR_SECRET_KEY_PATTERN.test(normalized)) {
        throw new TypeError(`${path}.<key> is an authority or secret-bearing field`);
      }
      walk(child, `${path}.<value>`, depth + 1);
    }
  }

  walk(value, field, 0);
}

export function validateChildOperation(value, field = 'child operation') {
  assertPlainObject(value, field);
  const serialized = canonicalize(value);
  if (Buffer.byteLength(serialized, 'utf8') > MAX_OPERATION_BYTES) {
    throw new TypeError(`${field} exceeds ${MAX_OPERATION_BYTES} bytes`);
  }
  const canonical = JSON.parse(serialized);
  scanAuthorityFreeJson(canonical, field);
  return deepFreeze(canonical);
}

function validateLocalAction(value, index) {
  const field = `local operation.actions[${index}]`;
  assertPlainObject(value, field);
  const type = requireEnum(value.type, ['read', 'write', 'delete'], `${field}.type`);
  assertAllowedKeys(
    value,
    type === 'write' ? ['type', 'path', 'content'] : ['type', 'path'],
    field,
  );
  const path = normalizeRelativePath(value.path, `${field}.path`);
  if (type !== 'write') return { type, path };
  if (typeof value.content !== 'string') {
    throw new TypeError(`${field}.content must be text`);
  }
  const bytes = Buffer.byteLength(value.content, 'utf8');
  if (bytes > MAX_LOCAL_FILE_BYTES) {
    throw new TypeError(`${field}.content exceeds ${MAX_LOCAL_FILE_BYTES} bytes`);
  }
  return { type, path, content: value.content };
}

export function validateLocalReferenceOperation(value) {
  const operation = validateChildOperation(value, 'local operation');
  assertAllowedKeys(
    operation,
    ['kind', 'actions', 'commit_candidate'],
    'local operation',
  );
  if (operation.kind !== 'bounded_file_batch') {
    throw new TypeError('Local reference adapter only accepts bounded_file_batch operations');
  }
  if (!Array.isArray(operation.actions)) {
    throw new TypeError('local operation.actions must be an array');
  }
  if (operation.actions.length > MAX_LOCAL_ACTIONS) {
    throw new TypeError(`local operation exceeds ${MAX_LOCAL_ACTIONS} actions`);
  }
  const normalized = {
    kind: 'bounded_file_batch',
    actions: operation.actions.map(validateLocalAction),
  };
  if (Object.hasOwn(operation, 'commit_candidate')) {
    normalized.commit_candidate = operation.commit_candidate;
  }
  return deepFreeze(normalized);
}
