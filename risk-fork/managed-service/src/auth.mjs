import { createHash } from 'node:crypto';
import { MANAGED_API_KEY_SCHEMA, MANAGED_SCOPES } from './constants.mjs';
import {
  assertAllowedKeys,
  assertDataArray,
  assertPlainRecord,
  deepFreeze,
  managedError,
  requireIso,
  requireOpaqueRef,
  requireString,
  requireTenantId,
} from './validation.mjs';

const TOKEN_PATTERN = /^[A-Za-z0-9._~-]{32,512}$/;
const managedPrincipalVerifiers = new WeakMap();

export function hashManagedApiKey(token) {
  const normalized = requireString(token, 'API key', { minBytes: 32, maxBytes: 512 });
  if (!TOKEN_PATTERN.test(normalized)) throw new TypeError('API key format is invalid');
  return `sha256:${createHash('sha256')
    .update('agoragentic-risk-fork-managed-api-key-v1\0', 'utf8')
    .update(normalized, 'utf8')
    .digest('hex')}`;
}

export function parseBearerAuthorization(value) {
  const header = requireString(value, 'Authorization header', {
    minBytes: 39,
    maxBytes: 520,
  });
  const match = /^Bearer ([A-Za-z0-9._~-]{32,512})$/.exec(header);
  if (!match) {
    throw managedError('Bearer authentication is required', 'AUTHENTICATION_REQUIRED', 401);
  }
  return match[1];
}

function normalizeScopes(scopes) {
  assertDataArray(scopes, 'API key scopes', { maxLength: MANAGED_SCOPES.length });
  if (scopes.length === 0) {
    throw new TypeError('API key scopes must be a non-empty bounded array');
  }
  const unique = [...new Set(scopes)];
  if (unique.length !== scopes.length || unique.some((scope) => !MANAGED_SCOPES.includes(scope))) {
    throw new TypeError('API key scopes contain an unknown or duplicate scope');
  }
  return unique.sort();
}

export function normalizeApiKeyRecord(value) {
  assertPlainRecord(value, 'API key record');
  assertAllowedKeys(value, [
    'schema',
    'key_id',
    'tenant_id',
    'key_hash',
    'scopes',
    'not_before',
    'expires_at',
    'revoked_at',
  ], 'API key record');
  if (value.schema !== MANAGED_API_KEY_SCHEMA) {
    throw new TypeError('API key record schema is invalid');
  }
  const keyHash = requireString(value.key_hash, 'API key record.key_hash', { maxBytes: 71 });
  if (!/^sha256:[a-f0-9]{64}$/.test(keyHash)) {
    throw new TypeError('API key record.key_hash must be a sha256 reference');
  }
  return deepFreeze({
    schema: MANAGED_API_KEY_SCHEMA,
    key_id: requireOpaqueRef(value.key_id, 'API key record.key_id'),
    tenant_id: requireTenantId(value.tenant_id, 'API key record.tenant_id'),
    key_hash: keyHash,
    scopes: normalizeScopes(value.scopes),
    not_before: requireIso(value.not_before, 'API key record.not_before'),
    expires_at: requireIso(value.expires_at, 'API key record.expires_at'),
    revoked_at: value.revoked_at == null
      ? null
      : requireIso(value.revoked_at, 'API key record.revoked_at'),
  });
}

export function createManagedAuthenticator({ store, clock = () => new Date() } = {}) {
  if (!store || typeof store.resolveCredential !== 'function') {
    throw new TypeError('Managed authenticator requires a credential store');
  }
  if (typeof clock !== 'function') throw new TypeError('clock must be a function');
  const issuedPrincipals = new WeakMap();

  async function requireCurrentRecord(value, requiredScope) {
    if (!value || typeof value !== 'object' || !issuedPrincipals.has(value)) {
      throw managedError('Authenticated principal is required', 'AUTHENTICATION_REQUIRED', 401);
    }
    if (!MANAGED_SCOPES.includes(requiredScope)) throw new TypeError('requiredScope is unknown');
    const keyHash = issuedPrincipals.get(value);
    const recordValue = await store.resolveCredential(keyHash);
    if (!recordValue) {
      throw managedError('Authentication failed', 'AUTHENTICATION_FAILED', 401);
    }
    const record = normalizeApiKeyRecord(recordValue);
    if (record.key_hash !== keyHash) {
      throw managedError('Authentication failed', 'AUTHENTICATION_FAILED', 401);
    }
    const now = Date.parse(requireIso(clock(), 'clock result'));
    if (record.revoked_at !== null
      || now < Date.parse(record.not_before)
      || now >= Date.parse(record.expires_at)
      || record.key_id !== value.key_id
      || record.tenant_id !== value.tenant_id) {
      throw managedError('Authentication failed', 'AUTHENTICATION_FAILED', 401);
    }
    if (!record.scopes.includes(requiredScope)) {
      throw managedError('API key scope is insufficient', 'AUTHORIZATION_DENIED', 403);
    }
    return value;
  }

  managedPrincipalVerifiers.set(requireCurrentRecord, store);
  return Object.freeze({
    async authenticate(authorization, requiredScope) {
      if (!MANAGED_SCOPES.includes(requiredScope)) {
        throw new TypeError('requiredScope is unknown');
      }
      const token = parseBearerAuthorization(authorization);
      const keyHash = hashManagedApiKey(token);
      const recordValue = await store.resolveCredential(keyHash);
      if (!recordValue) {
        throw managedError('Authentication failed', 'AUTHENTICATION_FAILED', 401);
      }
      const record = normalizeApiKeyRecord(recordValue);
      if (record.key_hash !== keyHash) {
        throw managedError('Authentication failed', 'AUTHENTICATION_FAILED', 401);
      }
      const now = Date.parse(requireIso(clock(), 'clock result'));
      if (record.revoked_at !== null
        || now < Date.parse(record.not_before)
        || now >= Date.parse(record.expires_at)) {
        throw managedError('Authentication failed', 'AUTHENTICATION_FAILED', 401);
      }
      if (!record.scopes.includes(requiredScope)) {
        throw managedError('API key scope is insufficient', 'AUTHORIZATION_DENIED', 403);
      }
      const principal = deepFreeze({
        key_id: record.key_id,
        tenant_id: record.tenant_id,
        scopes: [...record.scopes],
      });
      issuedPrincipals.set(principal, keyHash);
      return principal;
    },
    requirePrincipal: requireCurrentRecord,
  });
}

export function assertManagedPrincipalVerifier(value, expectedStore) {
  if (typeof value !== 'function' || managedPrincipalVerifiers.get(value) !== expectedStore) {
    throw new TypeError(
      'requirePrincipal must come from createManagedAuthenticator for the same store',
    );
  }
  return value;
}
