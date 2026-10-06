import { randomBytes } from 'node:crypto';
import { sha256Ref } from '../../src/canonical.mjs';
import { assertAllowedKeys, assertPlainRecord, requireEnum, requireInteger, requireSha256 } from './validation.mjs';

export const TELEMETRY_ROUTES = Object.freeze(['admission', 'execution', 'cleanup', 'recovery', 'read']);
const EVENTS = Object.freeze(['control_denied', 'rate_denied', 'policy_error', 'policy_allowed', 'policy_candidate',
  'invocation_budget_denied', 'daily_budget_denied']);
const OUTCOMES = Object.freeze(['allowed', 'disabled', 'rate_limited', 'failed_closed', 'timeout', 'candidate', 'budget_limited']);
const FIELDS = Object.freeze(['event_ref', 'event', 'route_class', 'status', 'outcome', 'duration_ms', 'tenant_hash', 'key_hash']);

export function requireTelemetryRef(value) {
  if (typeof value !== 'string' || !/^evt_[a-f0-9]{48}$/.test(value)) throw new TypeError('Invalid telemetry event reference');
  return value;
}

// Observer data only: never a receipt, authentication principal, or authority.
export function normalizeManagedTelemetryEvent(value) {
  assertPlainRecord(value, 'telemetry event'); assertAllowedKeys(value, FIELDS, 'telemetry event');
  if (FIELDS.some((field) => !Object.hasOwn(value, field))) throw new TypeError('Telemetry requires own closed fields');
  const event = requireEnum(value.event, EVENTS, 'event');
  const outcome = requireEnum(value.outcome, OUTCOMES, 'outcome');
  const status = requireInteger(value.status, 'status', { min: 200, max: 503 });
  if (!((event === 'policy_allowed' && outcome === 'allowed' && status === 200)
    || (event === 'policy_candidate' && outcome === 'candidate' && status === 200)
    || (event === 'rate_denied' && outcome === 'rate_limited' && status === 429)
    || (['invocation_budget_denied', 'daily_budget_denied'].includes(event) && outcome === 'budget_limited'
      && status === 429 && value.route_class === 'admission')
    || (event === 'control_denied' && ['disabled', 'failed_closed'].includes(outcome) && status === 503)
    || (event === 'policy_error' && ['failed_closed', 'timeout'].includes(outcome) && status === 503))) {
    throw new TypeError('Telemetry labels disagree');
  }
  return Object.freeze({ event_ref: requireTelemetryRef(value.event_ref), event,
    route_class: requireEnum(value.route_class, TELEMETRY_ROUTES, 'route_class'), status, outcome,
    duration_ms: requireInteger(value.duration_ms, 'duration_ms', { max: 2_147_483_647 }),
    tenant_hash: requireSha256(value.tenant_hash, 'tenant_hash'), key_hash: requireSha256(value.key_hash, 'key_hash') });
}

export function createManagedTelemetryEvent(fields) {
  assertPlainRecord(fields, 'telemetry fields'); assertAllowedKeys(fields, FIELDS.filter((field) => field !== 'event_ref'), 'telemetry fields');
  return normalizeManagedTelemetryEvent({ ...fields, event_ref: `evt_${randomBytes(24).toString('hex')}` });
}

export const managedTelemetryEventHash = (event) => sha256Ref(normalizeManagedTelemetryEvent(event));

export function assertManagedTelemetryAppend(result, event) {
  assertPlainRecord(result, 'telemetry append acknowledgement');
  assertAllowedKeys(result, ['event_ref', 'persisted'], 'telemetry append acknowledgement');
  if (!Object.hasOwn(result, 'event_ref') || !Object.hasOwn(result, 'persisted')
    || result.event_ref !== event.event_ref || result.persisted !== true) throw new TypeError('Telemetry append not confirmed');
  return result;
}
