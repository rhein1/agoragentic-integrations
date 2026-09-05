import { isProxy } from 'node:util/types';

const MAX_TEXT_BYTES = 8_192;
const MAX_JSON_DEPTH = 64;
const MAX_JSON_NODES = 100_000;
const OPAQUE_REF_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:@/-]{0,199}$/;
const INVOCATION_REF_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:@-]{0,199}$/;
const TENANT_PATTERN = /^[a-z0-9][a-z0-9_-]{2,62}$/;
const PROVIDER_PATTERN = /^[a-z0-9][a-z0-9._-]{1,99}$/;

export function managedError(message, code, status = 400, details = {}) {
  const error = new Error(message);
  error.code = code;
  error.status = status;
  error.details = Object.freeze({ ...details });
  return error;
}

export function assertPlainRecord(value, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new TypeError(`${label} must be a plain object`);
  }
  if (isProxy(value)) throw new TypeError(`${label} must not be a Proxy`);
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    throw new TypeError(`${label} must be a plain object`);
  }
  if (Object.getOwnPropertySymbols(value).length !== 0) {
    throw new TypeError(`${label} must not contain symbol keys`);
  }
  const descriptors = Object.getOwnPropertyDescriptors(value);
  for (const [key, descriptor] of Object.entries(descriptors)) {
    if (!descriptor.enumerable || descriptor.get || descriptor.set) {
      throw new TypeError(`${label}.${key} must be enumerable data`);
    }
  }
  return value;
}

export function assertAllowedKeys(value, keys, label) {
  const allowed = new Set(keys);
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) throw new TypeError(`${label} contains an unsupported field`);
  }
}

export function assertDataArray(value, label, { maxLength = 100_000 } = {}) {
  if (!Array.isArray(value) || isProxy(value)) {
    throw new TypeError(`${label} must be an array and must not be a Proxy`);
  }
  if (Object.getPrototypeOf(value) !== Array.prototype) {
    throw new TypeError(`${label} must be a plain array`);
  }
  if (Object.getOwnPropertySymbols(value).length !== 0) {
    throw new TypeError(`${label} must not contain symbol keys`);
  }
  if (value.length > maxLength) throw new TypeError(`${label} is too large`);
  const descriptors = Object.getOwnPropertyDescriptors(value);
  const dataKeys = Object.keys(descriptors).filter((key) => key !== 'length');
  if (dataKeys.length !== value.length) throw new TypeError(`${label} must be a dense data array`);
  for (let index = 0; index < value.length; index += 1) {
    const descriptor = descriptors[String(index)];
    if (!descriptor || !descriptor.enumerable || descriptor.get || descriptor.set) {
      throw new TypeError(`${label}[${index}] must be enumerable data`);
    }
  }
  return value;
}

export function requireString(value, label, options = {}) {
  if (typeof value !== 'string') throw new TypeError(`${label} must be a string`);
  const bytes = Buffer.byteLength(value, 'utf8');
  const minBytes = options.minBytes ?? 1;
  const maxBytes = options.maxBytes ?? MAX_TEXT_BYTES;
  if (bytes < minBytes || bytes > maxBytes) {
    throw new TypeError(`${label} must be between ${minBytes} and ${maxBytes} bytes`);
  }
  if (value.trim() !== value || /[\u0000-\u001f\u007f]/.test(value)) {
    throw new TypeError(`${label} contains forbidden whitespace or control characters`);
  }
  return value;
}

export function requireTenantId(value, label = 'tenant_id') {
  const normalized = requireString(value, label, { maxBytes: 63 });
  if (!TENANT_PATTERN.test(normalized)) {
    throw new TypeError(`${label} must be a lowercase tenant identifier`);
  }
  return normalized;
}

export function requireProviderId(value, label = 'provider_id') {
  const normalized = requireString(value, label, { maxBytes: 100 });
  if (!PROVIDER_PATTERN.test(normalized)) {
    throw new TypeError(`${label} must be a lowercase provider identifier`);
  }
  return normalized;
}

export function requireOpaqueRef(value, label) {
  const normalized = requireString(value, label, { maxBytes: 200 });
  if (!OPAQUE_REF_PATTERN.test(normalized) || normalized.includes('..')) {
    throw new TypeError(`${label} is not a safe opaque reference`);
  }
  return normalized;
}

export function requireInvocationRef(value, label = 'invocation_ref') {
  const normalized = requireString(value, label, { maxBytes: 200 });
  if (!INVOCATION_REF_PATTERN.test(normalized) || normalized.includes('..')) {
    throw new TypeError(`${label} is not a URL-segment-safe invocation reference`);
  }
  return normalized;
}

export function requireInteger(value, label, { min = 0, max = Number.MAX_SAFE_INTEGER } = {}) {
  if (!Number.isSafeInteger(value) || value < min || value > max) {
    throw new TypeError(`${label} must be an integer between ${min} and ${max}`);
  }
  return value;
}

export function requireIso(value, label) {
  if (value && typeof value === 'object' && isProxy(value)) {
    throw new TypeError(`${label} must not be a Proxy`);
  }
  let normalized;
  if (value instanceof Date) {
    if (Object.getPrototypeOf(value) !== Date.prototype) {
      throw new TypeError(`${label} must be an exact Date or canonical ISO timestamp`);
    }
    normalized = Date.prototype.toISOString.call(value);
  } else {
    normalized = requireString(value, label);
  }
  const millis = Date.parse(normalized);
  if (!Number.isFinite(millis) || new Date(millis).toISOString() !== normalized) {
    throw new TypeError(`${label} must be a canonical ISO timestamp`);
  }
  return normalized;
}

export function requireSha256(value, label) {
  const normalized = requireString(value, label, { maxBytes: 71 });
  if (!/^sha256:[a-f0-9]{64}$/.test(normalized)) {
    throw new TypeError(`${label} must be a sha256 reference`);
  }
  return normalized;
}

export function requireEnum(value, allowed, label) {
  if (!allowed.includes(value)) {
    throw new TypeError(`${label} must be one of ${allowed.join(', ')}`);
  }
  return value;
}

export function cloneJson(value, label = 'value') {
  const state = { ancestors: new WeakSet(), nodes: 0 };
  function visit(current, path, depth) {
    state.nodes += 1;
    if (state.nodes > MAX_JSON_NODES) throw new TypeError(`${label} is too complex`);
    if (depth > MAX_JSON_DEPTH) throw new TypeError(`${label} is too deeply nested`);
    if (current === null || ['string', 'boolean'].includes(typeof current)) return current;
    if (typeof current === 'number') {
      if (!Number.isFinite(current) || Object.is(current, -0)) {
        throw new TypeError(`${path} is not an unambiguous JSON number`);
      }
      if (Number.isInteger(current) && !Number.isSafeInteger(current)) {
        throw new TypeError(`${path} is outside the safe integer range`);
      }
      return current;
    }
    if (typeof current !== 'object' || isProxy(current)) {
      throw new TypeError(`${path} is not closed JSON data`);
    }
    if (state.ancestors.has(current)) throw new TypeError(`${path} contains a cycle`);
    state.ancestors.add(current);
    try {
      const descriptors = Object.getOwnPropertyDescriptors(current);
      if (Object.getOwnPropertySymbols(current).length !== 0) {
        throw new TypeError(`${path} contains a symbol key`);
      }
      const keys = Object.keys(descriptors);
      if (Array.isArray(current)) {
        if (Object.getPrototypeOf(current) !== Array.prototype) {
          throw new TypeError(`${path} must be a plain array`);
        }
        const dataKeys = keys.filter((key) => key !== 'length');
        if (dataKeys.length !== current.length) throw new TypeError(`${path} is a sparse array`);
        const copy = [];
        for (let index = 0; index < current.length; index += 1) {
          const descriptor = descriptors[String(index)];
          if (!descriptor || !descriptor.enumerable || descriptor.get || descriptor.set) {
            throw new TypeError(`${path}[${index}] is not enumerable data`);
          }
          Object.defineProperty(copy, String(index), {
            configurable: true,
            enumerable: true,
            value: visit(descriptor.value, `${path}[${index}]`, depth + 1),
            writable: true,
          });
        }
        return copy;
      }
      const prototype = Object.getPrototypeOf(current);
      if (prototype !== Object.prototype && prototype !== null) {
        throw new TypeError(`${path} is not a plain JSON object`);
      }
      const copy = {};
      for (const key of keys) {
        const descriptor = descriptors[key];
        if (!descriptor.enumerable || descriptor.get || descriptor.set) {
          throw new TypeError(`${path}.${key} is not enumerable data`);
        }
        Object.defineProperty(copy, key, {
          configurable: true,
          enumerable: true,
          value: visit(descriptor.value, `${path}.${key}`, depth + 1),
          writable: true,
        });
      }
      return copy;
    } finally {
      state.ancestors.delete(current);
    }
  }
  return visit(value, label, 0);
}

export function utcDay(value) {
  return requireIso(value, 'clock result').slice(0, 10);
}

export function assertExecutionWithinBudgetDay(budgetDayValue, nowValue, expiresAtValue) {
  const budgetDay = requireString(budgetDayValue, 'budget_day_utc', {
    minBytes: 10,
    maxBytes: 10,
  });
  const midnight = `${budgetDay}T00:00:00.000Z`;
  const midnightMillis = Date.parse(midnight);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(budgetDay)
    || !Number.isFinite(midnightMillis)
    || new Date(midnightMillis).toISOString() !== midnight) {
    throw new TypeError('budget_day_utc must be a valid UTC date');
  }
  const now = requireIso(nowValue, 'lease.now');
  const expiresAt = requireIso(expiresAtValue, 'lease.expires_at');
  if (utcDay(now) !== budgetDay) {
    throw managedError(
      'Invocation admission belongs to an expired UTC budget day',
      'INVOCATION_BUDGET_DAY_EXPIRED',
      409,
    );
  }
  const nextMidnight = midnightMillis + 86_400_000;
  if (Date.parse(expiresAt) > nextMidnight) {
    throw managedError(
      'Execution lease cannot cross its UTC budget-day boundary',
      'LEASE_CROSSES_BUDGET_DAY',
      409,
    );
  }
  return Object.freeze({ budget_day_utc: budgetDay, now, expires_at: expiresAt });
}

export function deepFreeze(value, seen = new WeakSet()) {
  if (!value || typeof value !== 'object' || seen.has(value)) return value;
  seen.add(value);
  for (const descriptor of Object.values(Object.getOwnPropertyDescriptors(value))) {
    if (Object.hasOwn(descriptor, 'value')) deepFreeze(descriptor.value, seen);
  }
  return Object.freeze(value);
}
