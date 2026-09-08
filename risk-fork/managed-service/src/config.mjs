import {
  DEFAULT_LIMITS,
  MANAGED_SERVICE_PRODUCTION_QUALIFIED,
  MANAGED_SERVICE_PROTOCOL_LIMITS,
  MANAGED_SERVICE_SCHEMA,
} from './constants.mjs';
import {
  assertAllowedKeys,
  assertPlainRecord,
  deepFreeze,
  managedError,
  requireEnum,
  requireInteger,
} from './validation.mjs';

const LIMIT_RANGES = Object.freeze({
  max_request_bytes: [1_024, MANAGED_SERVICE_PROTOCOL_LIMITS.max_request_bytes],
  max_invocation_cost_micros: [0, MANAGED_SERVICE_PROTOCOL_LIMITS.max_invocation_cost_micros],
  daily_budget_micros: [0, 10_000_000_000],
  max_concurrent_invocations: [1, 1_000],
  min_lease_ms: [1_000, 60_000],
  max_lease_ms: [5_000, 900_000],
  max_invocation_age_ms: [10_000, 86_400_000],
  max_idempotency_key_bytes: [16, MANAGED_SERVICE_PROTOCOL_LIMITS.max_idempotency_key_bytes],
});
const issuedConfigs = new WeakSet();

function normalizeLimits(value = {}) {
  assertPlainRecord(value, 'managed service limits');
  assertAllowedKeys(value, Object.keys(LIMIT_RANGES), 'managed service limits');
  const limits = {};
  for (const [name, [min, max]] of Object.entries(LIMIT_RANGES)) {
    limits[name] = requireInteger(
      value[name] ?? DEFAULT_LIMITS[name],
      `managed service limits.${name}`,
      { min, max },
    );
  }
  if (limits.min_lease_ms > limits.max_lease_ms) {
    throw new TypeError('managed service min_lease_ms must not exceed max_lease_ms');
  }
  if (limits.max_invocation_cost_micros > limits.daily_budget_micros) {
    throw new TypeError('managed service invocation cost cap must not exceed daily budget');
  }
  return limits;
}

export function createManagedServiceConfig(input = {}) {
  assertPlainRecord(input, 'managed service config');
  assertAllowedKeys(input, ['enabled', 'environment', 'limits'], 'managed service config');
  const enabled = input.enabled === true;
  if (input.enabled != null && typeof input.enabled !== 'boolean') {
    throw new TypeError('managed service config.enabled must be a boolean');
  }
  const environment = requireEnum(
    input.environment ?? 'local_test',
    ['local_test', 'production'],
    'managed service config.environment',
  );
  if (enabled && environment === 'production' && !MANAGED_SERVICE_PRODUCTION_QUALIFIED) {
    throw managedError(
      'This source tranche is not qualified for production activation',
      'MANAGED_SERVICE_PRODUCTION_NOT_QUALIFIED',
      503,
    );
  }
  const config = deepFreeze({
    schema: MANAGED_SERVICE_SCHEMA,
    enabled,
    environment,
    default_off: true,
    production_qualified: MANAGED_SERVICE_PRODUCTION_QUALIFIED,
    live_traffic_protected: false,
    limits: normalizeLimits(input.limits ?? {}),
  });
  issuedConfigs.add(config);
  return config;
}

export function assertManagedServiceConfig(config) {
  if (!config || typeof config !== 'object' || !issuedConfigs.has(config)) {
    throw new TypeError('managed service config must be created by createManagedServiceConfig');
  }
  return config;
}

export function assertManagedServiceEnabled(config) {
  assertManagedServiceConfig(config);
  if (!config?.enabled) {
    throw managedError(
      'Managed Risk Fork is disabled',
      'MANAGED_SERVICE_DISABLED',
      503,
    );
  }
  if (config.environment !== 'local_test') {
    throw managedError(
      'Managed Risk Fork production activation is not qualified',
      'MANAGED_SERVICE_PRODUCTION_NOT_QUALIFIED',
      503,
    );
  }
}
