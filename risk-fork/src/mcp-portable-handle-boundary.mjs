import { createHmac, randomBytes, randomUUID } from 'node:crypto';

import { canonicalize, sha256Ref } from './canonical.mjs';
import {
  assertAllowedKeys,
  assertPlainObject,
  boundedInteger,
  containsSerializedCredentialMaterial,
  deepFreeze,
  requireIsoDate,
  requireOpaqueRef,
  requireSha256Ref,
  requireString,
  safeEqual,
} from './util.mjs';

export const RISK_FORK_MCP_PORTABLE_HANDLE_REGISTRY_SCHEMA =
  'agoragentic.risk-fork.mcp-portable-handle-registry.v1';
export const RISK_FORK_MCP_PORTABLE_HANDLE_BINDING_SCHEMA =
  'agoragentic.risk-fork.mcp-portable-handle-binding.v1';
export const RISK_FORK_MCP_PORTABLE_HANDLE_AUTHORIZATION_SCHEMA =
  'agoragentic.risk-fork.mcp-portable-handle-authorization.v1';

const DEFAULT_MAX_ENTRIES = 10_000;
const DEFAULT_MAX_TTL_MS = 5 * 60 * 1000;
const HARD_MAX_TTL_MS = 5 * 60 * 1000;
const HARD_MAX_CONSUMPTIONS = 1_000;
const registryRecords = new WeakMap();

const REGISTRATION_KEYS = Object.freeze([
  'handle_value',
  'principal_ref',
  'issuer',
  'audience',
  'mcp_server_origin',
  'originating_method',
  'originating_request_hash',
  'allowed_consuming_methods',
  'ttl_ms',
  'single_use',
  'max_consumptions',
]);
const AUTHORIZATION_KEYS = Object.freeze([
  'handle_value',
  'binding',
  'principal_ref',
  'issuer',
  'audience',
  'mcp_server_origin',
  'originating_method',
  'originating_request_hash',
  'consuming_method',
  'consuming_request_hash',
]);
const BINDING_KEYS = Object.freeze([
  'schema',
  'binding_id',
  'handle_hash',
  'principal_hash',
  'issuer',
  'audience',
  'mcp_server_origin',
  'originating_method',
  'originating_request_hash',
  'allowed_consuming_methods',
  'issued_at',
  'expires_at',
  'single_use',
  'max_consumptions',
  'binding_hash',
]);

export const RISK_FORK_MCP_PORTABLE_HANDLE_DIAGNOSTIC_CODES = Object.freeze({
  INVALID_CONFIGURATION: 'RISK_FORK_MCP_PORTABLE_HANDLE_INVALID_CONFIGURATION',
  INVALID_INPUT: 'RISK_FORK_MCP_PORTABLE_HANDLE_INVALID_INPUT',
  RAW_CREDENTIAL_REJECTED: 'RISK_FORK_MCP_PORTABLE_HANDLE_RAW_CREDENTIAL_REJECTED',
  CAPACITY_EXCEEDED: 'RISK_FORK_MCP_PORTABLE_HANDLE_CAPACITY_EXCEEDED',
  ALREADY_REGISTERED: 'RISK_FORK_MCP_PORTABLE_HANDLE_ALREADY_REGISTERED',
  UNKNOWN_HANDLE: 'RISK_FORK_MCP_PORTABLE_HANDLE_UNKNOWN',
  BINDING_MISMATCH: 'RISK_FORK_MCP_PORTABLE_HANDLE_BINDING_MISMATCH',
  CONTEXT_MISMATCH: 'RISK_FORK_MCP_PORTABLE_HANDLE_CONTEXT_MISMATCH',
  EXPIRED: 'RISK_FORK_MCP_PORTABLE_HANDLE_EXPIRED',
  REPLAY: 'RISK_FORK_MCP_PORTABLE_HANDLE_REPLAY',
  USE_LIMIT: 'RISK_FORK_MCP_PORTABLE_HANDLE_USE_LIMIT',
  CLOSED: 'RISK_FORK_MCP_PORTABLE_HANDLE_REGISTRY_CLOSED',
  CLOCK_ROLLBACK: 'RISK_FORK_MCP_PORTABLE_HANDLE_CLOCK_ROLLBACK',
  REVOKED: 'RISK_FORK_MCP_PORTABLE_HANDLE_REVOKED',
  AUTHENTICATION_REQUIRED: 'RISK_FORK_MCP_PORTABLE_HANDLE_AUTHENTICATION_REQUIRED',
  CONTRACT_REQUIRED: 'RISK_FORK_MCP_PORTABLE_HANDLE_CONTRACT_REQUIRED',
});

export class RiskForkMcpPortableHandleError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'RiskForkMcpPortableHandleError';
    this.code = code;
  }
}

function handleError(code, message) {
  return new RiskForkMcpPortableHandleError(code, message);
}

function exactCanonicalInput(value, keys, field) {
  let clone;
  try {
    clone = JSON.parse(canonicalize(value));
    assertPlainObject(clone, field);
    assertAllowedKeys(clone, keys, field);
    if (keys.some((key) => !Object.hasOwn(clone, key))) {
      throw new TypeError(`${field} is missing required fields`);
    }
    return clone;
  } catch (error) {
    if (error instanceof RiskForkMcpPortableHandleError) throw error;
    throw handleError(
      RISK_FORK_MCP_PORTABLE_HANDLE_DIAGNOSTIC_CODES.INVALID_INPUT,
      `${field} is invalid`,
    );
  }
}

function canonicalHttpsUrl(value, field, { originOnly = false } = {}) {
  if (typeof value === 'string' && containsSerializedCredentialMaterial(value)) {
    throw handleError(
      RISK_FORK_MCP_PORTABLE_HANDLE_DIAGNOSTIC_CODES.RAW_CREDENTIAL_REJECTED,
      `${field} must not contain serialized credential material`,
    );
  }
  const exact = requireString(value, field, { maxLength: 4096 });
  if (exact !== value || exact !== exact.normalize('NFC')) {
    throw new TypeError(`${field} must already be canonical`);
  }
  let parsed;
  try {
    parsed = new URL(exact);
  } catch {
    throw new TypeError(`${field} must be an absolute HTTPS URL`);
  }
  let decodedPathname;
  try {
    decodedPathname = decodeURIComponent(parsed.pathname);
  } catch {
    throw new TypeError(`${field} contains invalid percent encoding`);
  }
  if (containsSerializedCredentialMaterial(decodedPathname)) {
    throw handleError(
      RISK_FORK_MCP_PORTABLE_HANDLE_DIAGNOSTIC_CODES.RAW_CREDENTIAL_REJECTED,
      `${field} must not contain percent-encoded credential material`,
    );
  }
  if (/%[a-f0-9]{2}/i.test(decodedPathname)) {
    throw new TypeError(`${field} contains ambiguous nested percent encoding`);
  }
  if (parsed.protocol !== 'https:'
    || parsed.username
    || parsed.password
    || parsed.search
    || parsed.hash
    || (originOnly ? parsed.origin !== exact : parsed.href !== exact)) {
    throw new TypeError(`${field} must be an exact credential-free HTTPS ${originOnly ? 'origin' : 'URL'}`);
  }
  return exact;
}

function normalizeMethod(value, field) {
  const method = requireString(value, field, {
    maxLength: 300,
    pattern: /^[A-Za-z0-9][A-Za-z0-9._/-]{0,299}$/,
  });
  if (containsSerializedCredentialMaterial(method)) {
    throw handleError(
      RISK_FORK_MCP_PORTABLE_HANDLE_DIAGNOSTIC_CODES.RAW_CREDENTIAL_REJECTED,
      `${field} must not contain serialized credential material`,
    );
  }
  return method;
}

function normalizeHandleValue(value) {
  if (typeof value === 'string' && containsSerializedCredentialMaterial(value)) {
    throw handleError(
      RISK_FORK_MCP_PORTABLE_HANDLE_DIAGNOSTIC_CODES.RAW_CREDENTIAL_REJECTED,
      'Portable handle_value must not contain serialized credential material',
    );
  }
  const handle = requireOpaqueRef(value, 'portable handle_value', { maxLength: 4096 });
  if (handle !== value || !handle.isWellFormed()) {
    throw new TypeError(
      'Portable handle_value must be an exact, unpadded, well-formed Unicode string',
    );
  }
  if (handle.length < 16) {
    throw handleError(
      RISK_FORK_MCP_PORTABLE_HANDLE_DIAGNOSTIC_CODES.RAW_CREDENTIAL_REJECTED,
      'Portable handles must be opaque non-credential values of at least 16 characters',
    );
  }
  return handle;
}

function normalizeBindingContext(value, field) {
  const principalRef = requireSha256Ref(value.principal_ref, `${field}.principal_ref`);
  const issuer = canonicalHttpsUrl(value.issuer, `${field}.issuer`);
  const audience = canonicalHttpsUrl(value.audience, `${field}.audience`);
  const mcpServerOrigin = canonicalHttpsUrl(
    value.mcp_server_origin,
    `${field}.mcp_server_origin`,
    { originOnly: true },
  );
  if (new URL(audience).origin !== mcpServerOrigin) {
    throw new TypeError(`${field}.audience must belong to the exact MCP server origin`);
  }
  return Object.freeze({
    principalRef,
    issuer,
    audience,
    mcpServerOrigin,
    originatingMethod: normalizeMethod(value.originating_method, `${field}.originating_method`),
    originatingRequestHash: requireSha256Ref(
      value.originating_request_hash,
      `${field}.originating_request_hash`,
    ),
  });
}

function normalizeAllowedConsumingMethods(value, field) {
  if (!Array.isArray(value) || value.length < 1 || value.length > 32) {
    throw new TypeError(`${field} must be a nonempty array of at most 32 methods`);
  }
  const normalized = value.map((method, index) => normalizeMethod(method, `${field}[${index}]`));
  const canonical = [...new Set(normalized)].sort();
  if (canonical.length !== normalized.length || canonicalize(canonical) !== canonicalize(normalized)) {
    throw new TypeError(`${field} must be unique and canonically sorted`);
  }
  return Object.freeze(canonical);
}

function keyedRef(key, domain, value) {
  return `sha256:${createHmac('sha256', key)
    .update(domain, 'utf8')
    .update('\0', 'utf8')
    .update(canonicalize(value), 'utf8')
    .digest('hex')}`;
}

function currentTime(record) {
  let iso;
  try {
    iso = requireIsoDate(record.clock(), 'portable-handle registry clock');
  } catch {
    throw handleError(
      RISK_FORK_MCP_PORTABLE_HANDLE_DIAGNOSTIC_CODES.INVALID_CONFIGURATION,
      'Portable-handle registry clock did not return a valid time',
    );
  }
  const milliseconds = Date.parse(iso);
  if (record.lastObservedTime !== null && milliseconds < record.lastObservedTime) {
    throw handleError(
      RISK_FORK_MCP_PORTABLE_HANDLE_DIAGNOSTIC_CODES.CLOCK_ROLLBACK,
      'Portable-handle registry clock moved backwards',
    );
  }
  record.lastObservedTime = milliseconds;
  return Object.freeze({ iso, milliseconds });
}

function normalizePresentedBinding(value) {
  const binding = exactCanonicalInput(value, BINDING_KEYS, 'portable-handle binding');
  if (binding.schema !== RISK_FORK_MCP_PORTABLE_HANDLE_BINDING_SCHEMA) {
    throw handleError(
      RISK_FORK_MCP_PORTABLE_HANDLE_DIAGNOSTIC_CODES.BINDING_MISMATCH,
      'Portable-handle binding schema is invalid',
    );
  }
  requireOpaqueRef(binding.binding_id, 'portable-handle binding.binding_id', { maxLength: 256 });
  requireSha256Ref(binding.handle_hash, 'portable-handle binding.handle_hash');
  requireSha256Ref(binding.principal_hash, 'portable-handle binding.principal_hash');
  canonicalHttpsUrl(binding.issuer, 'portable-handle binding.issuer');
  const audience = canonicalHttpsUrl(binding.audience, 'portable-handle binding.audience');
  const origin = canonicalHttpsUrl(
    binding.mcp_server_origin,
    'portable-handle binding.mcp_server_origin',
    { originOnly: true },
  );
  if (new URL(audience).origin !== origin) {
    throw handleError(
      RISK_FORK_MCP_PORTABLE_HANDLE_DIAGNOSTIC_CODES.BINDING_MISMATCH,
      'Portable-handle binding audience and origin disagree',
    );
  }
  normalizeMethod(binding.originating_method, 'portable-handle binding.originating_method');
  requireSha256Ref(
    binding.originating_request_hash,
    'portable-handle binding.originating_request_hash',
  );
  normalizeAllowedConsumingMethods(
    binding.allowed_consuming_methods,
    'portable-handle binding.allowed_consuming_methods',
  );
  const issuedAt = requireIsoDate(binding.issued_at, 'portable-handle binding.issued_at');
  const expiresAt = requireIsoDate(binding.expires_at, 'portable-handle binding.expires_at');
  if (issuedAt !== binding.issued_at
    || expiresAt !== binding.expires_at
    || Date.parse(expiresAt) <= Date.parse(issuedAt)
    || Date.parse(expiresAt) - Date.parse(issuedAt) > HARD_MAX_TTL_MS
    || typeof binding.single_use !== 'boolean'
    || !Number.isSafeInteger(binding.max_consumptions)
    || binding.max_consumptions < 1
    || binding.max_consumptions > HARD_MAX_CONSUMPTIONS
    || binding.single_use !== (binding.max_consumptions === 1)) {
    throw handleError(
      RISK_FORK_MCP_PORTABLE_HANDLE_DIAGNOSTIC_CODES.BINDING_MISMATCH,
      'Portable-handle binding lifetime or use policy is invalid',
    );
  }
  requireSha256Ref(binding.binding_hash, 'portable-handle binding.binding_hash');
  if (!safeEqual(
    binding.binding_hash,
    sha256Ref({ ...binding, binding_hash: null }),
  )) {
    throw handleError(
      RISK_FORK_MCP_PORTABLE_HANDLE_DIAGNOSTIC_CODES.BINDING_MISMATCH,
      'Portable-handle binding hash mismatch',
    );
  }
  return deepFreeze(binding);
}

function assertRegistryOpen(record) {
  if (record.closed) {
    throw handleError(
      RISK_FORK_MCP_PORTABLE_HANDLE_DIAGNOSTIC_CODES.CLOSED,
      'Portable-handle registry is closed',
    );
  }
}

export function createMcpPortableHandleRegistry(options = {}) {
  assertAllowedKeys(options, ['clock', 'max_entries', 'max_ttl_ms'], 'portable-handle registry options');
  const clock = options.clock ?? (() => new Date());
  if (typeof clock !== 'function') {
    throw handleError(
      RISK_FORK_MCP_PORTABLE_HANDLE_DIAGNOSTIC_CODES.INVALID_CONFIGURATION,
      'Portable-handle registry clock must be a function',
    );
  }
  const maxEntries = boundedInteger(
    options.max_entries ?? DEFAULT_MAX_ENTRIES,
    'portable-handle registry max_entries',
    { min: 1, max: 100_000 },
  );
  const maxTtlMs = boundedInteger(
    options.max_ttl_ms ?? DEFAULT_MAX_TTL_MS,
    'portable-handle registry max_ttl_ms',
    { min: 1_000, max: HARD_MAX_TTL_MS },
  );
  const record = {
    clock,
    maxEntries,
    maxTtlMs,
    key: randomBytes(32),
    bindings: new Map(),
    closed: false,
    lastObservedTime: null,
  };

  function register(input) {
    assertRegistryOpen(record);
    let normalized;
    let handleValue;
    let context;
    let allowedConsumingMethods;
    let ttlMs;
    let maxConsumptions;
    try {
      normalized = exactCanonicalInput(input, REGISTRATION_KEYS, 'portable-handle registration');
      handleValue = normalizeHandleValue(normalized.handle_value);
      context = normalizeBindingContext(normalized, 'portable-handle registration');
      allowedConsumingMethods = normalizeAllowedConsumingMethods(
        normalized.allowed_consuming_methods,
        'portable-handle registration.allowed_consuming_methods',
      );
      ttlMs = boundedInteger(normalized.ttl_ms, 'portable-handle registration.ttl_ms', {
        min: 1_000,
        max: record.maxTtlMs,
      });
      if (typeof normalized.single_use !== 'boolean') {
        throw new TypeError('portable-handle registration.single_use must be boolean');
      }
      maxConsumptions = boundedInteger(
        normalized.max_consumptions,
        'portable-handle registration.max_consumptions',
        { min: 1, max: HARD_MAX_CONSUMPTIONS },
      );
      if (normalized.single_use !== (maxConsumptions === 1)) {
        throw new TypeError(
          'portable-handle registration single_use and max_consumptions disagree',
        );
      }
    } catch (error) {
      if (error instanceof RiskForkMcpPortableHandleError) throw error;
      throw handleError(
        RISK_FORK_MCP_PORTABLE_HANDLE_DIAGNOSTIC_CODES.INVALID_INPUT,
        'Portable-handle registration is invalid',
      );
    }
    const now = currentTime(record);
    assertRegistryOpen(record);
    for (const [handleHash, entry] of record.bindings) {
      if (Date.parse(entry.binding.expires_at) <= now.milliseconds) {
        record.bindings.delete(handleHash);
      }
    }
    const handleHash = keyedRef(record.key, 'portable-handle', handleValue);
    if (record.bindings.has(handleHash)) {
      throw handleError(
        RISK_FORK_MCP_PORTABLE_HANDLE_DIAGNOSTIC_CODES.ALREADY_REGISTERED,
        'Portable handle is already registered',
      );
    }
    if (record.bindings.size >= record.maxEntries) {
      throw handleError(
        RISK_FORK_MCP_PORTABLE_HANDLE_DIAGNOSTIC_CODES.CAPACITY_EXCEEDED,
        'Portable-handle registry capacity is exhausted',
      );
    }
    const expiresAt = new Date(now.milliseconds + ttlMs).toISOString();
    const binding = {
      schema: RISK_FORK_MCP_PORTABLE_HANDLE_BINDING_SCHEMA,
      binding_id: `mcp-portable-handle:${randomUUID()}`,
      handle_hash: handleHash,
      principal_hash: keyedRef(record.key, 'principal-ref', context.principalRef),
      issuer: context.issuer,
      audience: context.audience,
      mcp_server_origin: context.mcpServerOrigin,
      originating_method: context.originatingMethod,
      originating_request_hash: context.originatingRequestHash,
      allowed_consuming_methods: allowedConsumingMethods,
      issued_at: now.iso,
      expires_at: expiresAt,
      single_use: normalized.single_use,
      max_consumptions: maxConsumptions,
      binding_hash: null,
    };
    binding.binding_hash = sha256Ref(binding);
    const frozenBinding = deepFreeze(binding);
    record.bindings.set(handleHash, {
      binding: frozenBinding,
      consumed: false,
      consumingRequestHashes: new Set(),
    });
    return frozenBinding;
  }

  function authorize(input) {
    assertRegistryOpen(record);
    let normalized;
    let handleValue;
    let context;
    let consumingMethod;
    let consumingRequestHash;
    let presentedBinding;
    try {
      normalized = exactCanonicalInput(input, AUTHORIZATION_KEYS, 'portable-handle authorization');
      handleValue = normalizeHandleValue(normalized.handle_value);
      context = normalizeBindingContext(normalized, 'portable-handle authorization');
      consumingMethod = normalizeMethod(
        normalized.consuming_method,
        'portable-handle authorization.consuming_method',
      );
      consumingRequestHash = requireSha256Ref(
        normalized.consuming_request_hash,
        'portable-handle authorization.consuming_request_hash',
      );
      presentedBinding = normalizePresentedBinding(normalized.binding);
    } catch (error) {
      if (error instanceof RiskForkMcpPortableHandleError) throw error;
      throw handleError(
        RISK_FORK_MCP_PORTABLE_HANDLE_DIAGNOSTIC_CODES.INVALID_INPUT,
        'Portable-handle authorization is invalid',
      );
    }
    const handleHash = keyedRef(record.key, 'portable-handle', handleValue);
    const entry = record.bindings.get(handleHash);
    if (!entry) {
      throw handleError(
        RISK_FORK_MCP_PORTABLE_HANDLE_DIAGNOSTIC_CODES.UNKNOWN_HANDLE,
        'Portable handle is not registered in this host registry',
      );
    }
    if (!safeEqual(entry.binding.binding_hash, presentedBinding.binding_hash)) {
      throw handleError(
        RISK_FORK_MCP_PORTABLE_HANDLE_DIAGNOSTIC_CODES.BINDING_MISMATCH,
        'Portable-handle binding does not match the host registry',
      );
    }
    const principalHash = keyedRef(record.key, 'principal-ref', context.principalRef);
    const expectedContext = {
      handle_hash: handleHash,
      principal_hash: principalHash,
      issuer: context.issuer,
      audience: context.audience,
      mcp_server_origin: context.mcpServerOrigin,
      originating_method: context.originatingMethod,
      originating_request_hash: context.originatingRequestHash,
    };
    if (Object.entries(expectedContext).some(([key, expected]) => (
      key.endsWith('_hash')
        ? !safeEqual(entry.binding[key], expected)
        : entry.binding[key] !== expected
    ))) {
      throw handleError(
        RISK_FORK_MCP_PORTABLE_HANDLE_DIAGNOSTIC_CODES.CONTEXT_MISMATCH,
        'Portable handle is not bound to this principal, issuer, audience, origin, or originating request',
      );
    }
    const now = currentTime(record);
    assertRegistryOpen(record);
    if (now.milliseconds >= Date.parse(entry.binding.expires_at)) {
      throw handleError(
        RISK_FORK_MCP_PORTABLE_HANDLE_DIAGNOSTIC_CODES.EXPIRED,
        'Portable-handle binding has expired',
      );
    }
    if (!entry.binding.allowed_consuming_methods.includes(consumingMethod)) {
      throw handleError(
        RISK_FORK_MCP_PORTABLE_HANDLE_DIAGNOSTIC_CODES.CONTEXT_MISMATCH,
        'Portable handle is not authorized for this consuming method',
      );
    }
    if (entry.consumingRequestHashes.has(consumingRequestHash)
      || (entry.binding.single_use && entry.consumed)) {
      throw handleError(
        RISK_FORK_MCP_PORTABLE_HANDLE_DIAGNOSTIC_CODES.REPLAY,
        'Portable-handle consumption was already used',
      );
    }
    if (entry.consumingRequestHashes.size >= entry.binding.max_consumptions) {
      throw handleError(
        RISK_FORK_MCP_PORTABLE_HANDLE_DIAGNOSTIC_CODES.USE_LIMIT,
        'Portable-handle consumption limit is exhausted',
      );
    }
    entry.consumingRequestHashes.add(consumingRequestHash);
    if (entry.binding.single_use) entry.consumed = true;
    const authorization = {
      schema: RISK_FORK_MCP_PORTABLE_HANDLE_AUTHORIZATION_SCHEMA,
      binding_hash: entry.binding.binding_hash,
      handle_hash: handleHash,
      principal_hash: principalHash,
      issuer: context.issuer,
      audience: context.audience,
      mcp_server_origin: context.mcpServerOrigin,
      originating_method: context.originatingMethod,
      originating_request_hash: context.originatingRequestHash,
      allowed_consuming_methods: entry.binding.allowed_consuming_methods,
      consuming_method: consumingMethod,
      consuming_request_hash: consumingRequestHash,
      authorized_at: now.iso,
      expires_at: entry.binding.expires_at,
      single_use: entry.binding.single_use,
      max_consumptions: entry.binding.max_consumptions,
      transferable: false,
      raw_handle_exposed: false,
      raw_principal_exposed: false,
      authorization_hash: null,
    };
    authorization.authorization_hash = sha256Ref(authorization);
    return deepFreeze(authorization);
  }

  function close() {
    if (record.closed) return;
    record.closed = true;
    record.bindings.clear();
    record.key.fill(0);
  }

  const registry = Object.freeze({
    schema: RISK_FORK_MCP_PORTABLE_HANDLE_REGISTRY_SCHEMA,
    register,
    authorize,
    close,
  });
  registryRecords.set(registry, record);
  return registry;
}

export function isMcpPortableHandleRegistry(value) {
  return registryRecords.has(value);
}

// Storage is a trusted host construction dependency. Its operations must hold
// an exclusive binding lock through validation and consumption, use database
// time after lock acquisition, and commit before returning. The PostgreSQL
// adapter implements this contract; an arbitrary callback is not durable proof.
export function createDurableMcpPortableHandleRegistry(options = {}) {
  assertAllowedKeys(options, [
    'store', 'tenant_ref', 'key_id', 'hash_key', 'max_entries', 'max_ttl_ms',
  ], 'durable portable-handle registry options');
  const tenantRef = requireOpaqueRef(options.tenant_ref, 'portable-handle tenant_ref');
  const keyId = requireOpaqueRef(options.key_id, 'portable-handle key_id');
  if (containsSerializedCredentialMaterial(tenantRef)
    || containsSerializedCredentialMaterial(keyId)
    || !Buffer.isBuffer(options.hash_key) || options.hash_key.length !== 32) {
    throw handleError(RISK_FORK_MCP_PORTABLE_HANDLE_DIAGNOSTIC_CODES.INVALID_CONFIGURATION,
      'Durable registry requires a credential-free namespace and a host-owned 32-byte key');
  }
  const store = options.store;
  if (!store || !['register', 'consume', 'revoke'].every((name) => typeof store[name] === 'function')) {
    throw new TypeError('Durable registry requires transactional register/consume/revoke storage');
  }
  const storage = Object.freeze(Object.fromEntries(['register', 'consume', 'revoke']
    .map((name) => [name, store[name].bind(store)])));
  const record = {
    key: Buffer.from(options.hash_key), closed: false,
    maxEntries: boundedInteger(options.max_entries ?? DEFAULT_MAX_ENTRIES, 'max_entries',
      { min: 1, max: 100_000 }),
    maxTtlMs: boundedInteger(options.max_ttl_ms ?? DEFAULT_MAX_TTL_MS, 'max_ttl_ms',
      { min: 1_000, max: HARD_MAX_TTL_MS }),
  };
  const scopedRef = (domain, value) => keyedRef(record.key, domain, { tenantRef, keyId, value });
  const scope = Object.freeze({
    tenant_ref: tenantRef, key_id: keyId,
    key_fingerprint: scopedRef('portable-handle-key-namespace', null),
  });

  async function register(input) {
    assertRegistryOpen(record);
    const normalized = exactCanonicalInput(input, REGISTRATION_KEYS, 'portable-handle registration');
    const handleValue = normalizeHandleValue(normalized.handle_value);
    const context = normalizeBindingContext(normalized, 'portable-handle registration');
    const methods = normalizeAllowedConsumingMethods(normalized.allowed_consuming_methods,
      'portable-handle registration.allowed_consuming_methods');
    const ttlMs = boundedInteger(normalized.ttl_ms, 'ttl_ms', { min: 1_000, max: record.maxTtlMs });
    const maxConsumptions = boundedInteger(normalized.max_consumptions, 'max_consumptions',
      { min: 1, max: HARD_MAX_CONSUMPTIONS });
    if (typeof normalized.single_use !== 'boolean'
      || normalized.single_use !== (maxConsumptions === 1)) {
      throw handleError(RISK_FORK_MCP_PORTABLE_HANDLE_DIAGNOSTIC_CODES.INVALID_INPUT,
        'Portable-handle registration use policy is invalid');
    }
    const handleHash = scopedRef('portable-handle', handleValue);
    const principalHash = scopedRef('principal-ref', context.principalRef);
    let expectedBinding;
    const result = await storage.register(scope, {
      handle_hash: handleHash, max_entries: record.maxEntries, ttl_ms: ttlMs,
    }, (nowValue) => {
      assertRegistryOpen(record);
      const now = requireIsoDate(nowValue, 'portable-handle database time');
      const binding = {
        schema: RISK_FORK_MCP_PORTABLE_HANDLE_BINDING_SCHEMA,
        binding_id: `mcp-portable-handle:${randomUUID()}`,
        handle_hash: handleHash, principal_hash: principalHash,
        issuer: context.issuer, audience: context.audience,
        mcp_server_origin: context.mcpServerOrigin,
        originating_method: context.originatingMethod,
        originating_request_hash: context.originatingRequestHash,
        allowed_consuming_methods: methods,
        issued_at: now, expires_at: new Date(Date.parse(now) + ttlMs).toISOString(),
        single_use: normalized.single_use, max_consumptions: maxConsumptions,
        binding_hash: null,
      };
      binding.binding_hash = sha256Ref(binding);
      expectedBinding = normalizePresentedBinding(binding);
      return expectedBinding;
    });
    assertRegistryOpen(record);
    const binding = normalizePresentedBinding(result);
    if (!expectedBinding || canonicalize(binding) !== canonicalize(expectedBinding)) {
      throw handleError(RISK_FORK_MCP_PORTABLE_HANDLE_DIAGNOSTIC_CODES.BINDING_MISMATCH,
        'Storage returned a different portable-handle binding');
    }
    return binding;
  }

  async function authorize(input) {
    assertRegistryOpen(record);
    const normalized = exactCanonicalInput(input, AUTHORIZATION_KEYS, 'portable-handle authorization');
    const handleValue = normalizeHandleValue(normalized.handle_value);
    const context = normalizeBindingContext(normalized, 'portable-handle authorization');
    const presented = normalizePresentedBinding(normalized.binding);
    const method = normalizeMethod(normalized.consuming_method, 'consuming_method');
    const requestHash = requireSha256Ref(normalized.consuming_request_hash, 'consuming_request_hash');
    const handleHash = scopedRef('portable-handle', handleValue);
    const principalHash = scopedRef('principal-ref', context.principalRef);
    const expected = {
      handle_hash: handleHash, principal_hash: principalHash,
      issuer: context.issuer, audience: context.audience,
      mcp_server_origin: context.mcpServerOrigin,
      originating_method: context.originatingMethod,
      originating_request_hash: context.originatingRequestHash,
    };
    let expectedReceipt;
    const result = await storage.consume(scope, {
      handle_hash: handleHash, consuming_request_hash: requestHash,
    }, (storedValue, nowValue) => {
      assertRegistryOpen(record);
      const stored = normalizePresentedBinding(storedValue);
      const now = requireIsoDate(nowValue, 'portable-handle database time');
      if (!safeEqual(stored.binding_hash, presented.binding_hash)) {
        throw handleError(RISK_FORK_MCP_PORTABLE_HANDLE_DIAGNOSTIC_CODES.BINDING_MISMATCH,
          'Portable-handle binding differs from durable storage');
      }
      if (Object.entries(expected).some(([key, value]) => stored[key] !== value)
        || !stored.allowed_consuming_methods.includes(method)) {
        throw handleError(RISK_FORK_MCP_PORTABLE_HANDLE_DIAGNOSTIC_CODES.CONTEXT_MISMATCH,
          'Portable handle does not belong to this authenticated context or method');
      }
      if (Date.parse(now) < Date.parse(stored.issued_at)
        || Date.parse(now) >= Date.parse(stored.expires_at)) {
        throw handleError(RISK_FORK_MCP_PORTABLE_HANDLE_DIAGNOSTIC_CODES.EXPIRED,
          'Portable-handle binding is outside its validity window');
      }
      const receipt = {
        schema: RISK_FORK_MCP_PORTABLE_HANDLE_AUTHORIZATION_SCHEMA,
        binding_hash: stored.binding_hash, ...expected,
        allowed_consuming_methods: stored.allowed_consuming_methods,
        consuming_method: method, consuming_request_hash: requestHash,
        authorized_at: now, expires_at: stored.expires_at,
        single_use: stored.single_use, max_consumptions: stored.max_consumptions,
        transferable: false, raw_handle_exposed: false, raw_principal_exposed: false,
        authorization_hash: null,
      };
      receipt.authorization_hash = sha256Ref(receipt);
      expectedReceipt = deepFreeze(receipt);
      return expectedReceipt;
    });
    assertRegistryOpen(record);
    if (!expectedReceipt || canonicalize(result) !== canonicalize(expectedReceipt)) {
      throw handleError(RISK_FORK_MCP_PORTABLE_HANDLE_DIAGNOSTIC_CODES.BINDING_MISMATCH,
        'Storage returned an invalid portable-handle consumption receipt');
    }
    return expectedReceipt;
  }

  async function revoke(input) {
    assertRegistryOpen(record);
    const normalized = exactCanonicalInput(input, ['handle_value'], 'portable-handle revocation');
    const handleHash = scopedRef('portable-handle', normalizeHandleValue(normalized.handle_value));
    await storage.revoke(scope, { handle_hash: handleHash });
    assertRegistryOpen(record);
  }
  function close() { record.closed = true; record.key.fill(0); }
  const registry = Object.freeze({
    schema: RISK_FORK_MCP_PORTABLE_HANDLE_REGISTRY_SCHEMA,
    durability: 'transactional', tenant_ref: tenantRef, register, authorize, revoke, close,
  });
  registryRecords.set(registry, record);
  return registry;
}

const preEffectBoundaries = new WeakSet();
const HANDLE_PHASES = ['tools/call', 'resources/read', 'prompts/get'];

function fieldPath(value, label) {
  if (value === null) return null;
  if (!Array.isArray(value) || value.length < 1 || value.length > 16
    || value.some((key) => typeof key !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(key)
      || ['__proto__', 'constructor', 'prototype'].includes(key))) {
    throw new TypeError(`${label} must be an explicit bounded own-property path`);
  }
  return Object.freeze([...value]);
}

function ownPath(value, path) {
  let current = value;
  for (const key of path) {
    const descriptor = current && typeof current === 'object'
      ? Object.getOwnPropertyDescriptor(current, key) : null;
    if (!descriptor || !Object.hasOwn(descriptor, 'value')) {
      throw handleError(RISK_FORK_MCP_PORTABLE_HANDLE_DIAGNOSTIC_CODES.CONTRACT_REQUIRED,
        'The configured portable-handle field is missing');
    }
    current = descriptor.value;
  }
  return current;
}

// authenticate is a clean host callback: it must reverify the ingress credential
// on every call, including revocation, issuer and exact audience. Neither this
// callback capability nor context.authentication is sent to the child.
export function createMcpPortableHandlePreEffectBoundary(options = {}) {
  assertAllowedKeys(options, ['authenticate', 'registry_for_context', 'contracts', 'clock'],
    'portable-handle pre-effect boundary options');
  if (typeof options.authenticate !== 'function' || typeof options.registry_for_context !== 'function') {
    throw new TypeError('Portable-handle boundary requires clean host authentication and registry resolvers');
  }
  const authenticate = options.authenticate;
  const registryForContext = options.registry_for_context;
  const clock = options.clock ?? (() => new Date());
  if (typeof clock !== 'function') throw new TypeError('Portable-handle boundary clock must be a function');
  const raw = JSON.parse(canonicalize(options.contracts));
  if (!Array.isArray(raw) || raw.length > 1000) throw new TypeError('Portable-handle contracts must be a bounded array');
  const contracts = raw.map((value) => {
    const contract = exactCanonicalInput(value, [
      'phase', 'tool_name', 'tool_descriptor_hash', 'mcp_server_origin', 'handle_path', 'binding_path',
    ], 'portable-handle field contract');
    if (!HANDLE_PHASES.includes(contract.phase)
      || (contract.phase === 'tools/call' ? typeof contract.tool_name !== 'string'
        : contract.tool_name !== null || contract.tool_descriptor_hash !== null)) {
      throw new TypeError('Portable-handle contract phase/tool is invalid');
    }
    if (contract.phase === 'tools/call') {
      normalizeMethod(contract.tool_name, 'contract.tool_name');
      requireSha256Ref(contract.tool_descriptor_hash, 'contract.tool_descriptor_hash');
    }
    canonicalHttpsUrl(contract.mcp_server_origin, 'contract.mcp_server_origin', { originOnly: true });
    contract.handle_path = fieldPath(contract.handle_path, 'handle_path');
    contract.binding_path = fieldPath(contract.binding_path, 'binding_path');
    if ((contract.handle_path === null) !== (contract.binding_path === null)) {
      throw new TypeError('A portable-handle contract requires both field paths or neither');
    }
    return deepFreeze(contract);
  });
  const contractKey = (item) => canonicalize([item.phase, item.tool_name, item.mcp_server_origin]);
  if (new Set(contracts.map(contractKey)).size !== contracts.length) {
    throw new TypeError('Portable-handle contracts must not overlap');
  }

  async function currentIdentity(request, context) {
    let identity;
    try {
      identity = exactCanonicalInput(await authenticate(request, context), [
        'tenant_ref', 'principal_ref', 'issuer', 'audience', 'mcp_server_origin', 'expires_at',
      ], 'authenticated MCP identity');
      requireOpaqueRef(identity.tenant_ref, 'authenticated tenant_ref');
      const normalized = normalizeBindingContext({ ...identity,
        originating_method: request.phase, originating_request_hash: request.request_hash },
      'authenticated MCP identity');
      const expires = requireIsoDate(identity.expires_at, 'authenticated expires_at');
      const now = requireIsoDate(clock(), 'authenticated host clock');
      if (Date.parse(now) >= Date.parse(expires)
        || normalized.mcpServerOrigin !== request.mcp_server_origin
        || context?.signal?.aborted) throw new Error('Expired or mismatched identity');
    } catch {
      throw handleError(RISK_FORK_MCP_PORTABLE_HANDLE_DIAGNOSTIC_CODES.AUTHENTICATION_REQUIRED,
        'Current MCP request authentication is unavailable, expired or mismatched');
    }
    return deepFreeze(identity);
  }
  async function authorize(request, context) {
    const identity = await currentIdentity(request, context);
    if (!HANDLE_PHASES.includes(request.phase)) return null;
    const contract = contracts.find((item) => contractKey(item) === contractKey(request));
    if (!contract || contract.tool_descriptor_hash !== request.tool_descriptor_hash) {
      throw handleError(RISK_FORK_MCP_PORTABLE_HANDLE_DIAGNOSTIC_CODES.CONTRACT_REQUIRED,
        'This MCP operation has no exact host-owned portable-handle field contract');
    }
    let receipt = null;
    if (contract.handle_path !== null) {
      const registry = await registryForContext(identity);
      if (!isMcpPortableHandleRegistry(registry) || registry.durability !== 'transactional'
        || registry.tenant_ref !== identity.tenant_ref) {
        throw handleError(RISK_FORK_MCP_PORTABLE_HANDLE_DIAGNOSTIC_CODES.INVALID_CONFIGURATION,
          'Authenticated MCP tenant has no durable portable-handle registry');
      }
      const binding = normalizePresentedBinding(ownPath(request.params, contract.binding_path));
      receipt = await registry.authorize({
        handle_value: ownPath(request.params, contract.handle_path), binding,
        principal_ref: identity.principal_ref, issuer: identity.issuer, audience: identity.audience,
        mcp_server_origin: identity.mcp_server_origin,
        originating_method: binding.originating_method,
        originating_request_hash: binding.originating_request_hash,
        consuming_method: request.phase, consuming_request_hash: request.request_hash,
      });
    }
    // Revocation/expiry during the storage wait burns the handle use but never
    // grants an effect. It cannot be retried as fresh authority.
    if (canonicalize(await currentIdentity(request, context)) !== canonicalize(identity)) {
      throw handleError(RISK_FORK_MCP_PORTABLE_HANDLE_DIAGNOSTIC_CODES.AUTHENTICATION_REQUIRED,
        'Authenticated MCP identity changed during authorization');
    }
    return receipt;
  }
  const boundary = Object.freeze({ authorize });
  preEffectBoundaries.add(boundary);
  return boundary;
}

export function isMcpPortableHandlePreEffectBoundary(value) { return preEffectBoundaries.has(value); }
