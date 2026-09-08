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
