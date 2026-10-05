import { createHash } from 'node:crypto';
import {
  assertAllowedKeys, assertPlainRecord, managedError, requireEnum,
  assertDataArray, requireOpaqueRef, requireTenantId,
} from './validation.mjs';
import { MANAGED_SCOPES } from './constants.mjs';

const ROUTES = Object.freeze(['admission', 'execution', 'cleanup', 'recovery', 'read']);
const EVENTS = Object.freeze(['control_denied', 'rate_denied', 'policy_error', 'policy_allowed']);
const OUTCOMES = Object.freeze(['allowed', 'disabled', 'rate_limited', 'failed_closed', 'timeout']);

function hashRef(domain, value) {
  return `sha256:${createHash('sha256').update(`agoragentic-risk-fork-policy-v1:${domain}\0`, 'utf8').update(value, 'utf8').digest('hex')}`;
}

function checkSignal(signal) {
  if (signal !== undefined && (!(signal instanceof AbortSignal) || signal.aborted)) {
    throw managedError('Request deadline expired', 'REQUEST_TIMEOUT', 408);
  }
}

async function awaitWithSignal(value, signal) {
  if (signal === undefined) return value;
  let onAbort;
  const aborted = new Promise((_, reject) => {
    onAbort = () => reject(managedError('Request deadline expired', 'REQUEST_TIMEOUT', 408));
    signal.addEventListener('abort', onAbort, { once: true });
  });
  if (signal.aborted) onAbort();
  try { return await Promise.race([Promise.resolve(value), aborted]); }
  finally { signal.removeEventListener('abort', onAbort); }
}

function principal(value) {
  assertPlainRecord(value, 'principal');
  if (typeof value.key_id !== 'string' || typeof value.tenant_id !== 'string') {
    throw managedError('Authenticated principal is required', 'AUTHENTICATION_REQUIRED', 401);
  }
  requireOpaqueRef(value.key_id, 'principal.key_id'); requireTenantId(value.tenant_id, 'principal.tenant_id');
  if (!Array.isArray(value.scopes)) {
    throw managedError('Authenticated principal is required', 'AUTHENTICATION_REQUIRED', 401);
  }
  assertDataArray(value.scopes, 'principal.scopes', { maxLength: MANAGED_SCOPES.length });
  if (value.scopes.length === 0 || value.scopes.some((scope) => !MANAGED_SCOPES.includes(scope))) {
    throw managedError('Authenticated principal is required', 'AUTHENTICATION_REQUIRED', 401);
  }
  return Object.freeze({ key_id: value.key_id, tenant_id: value.tenant_id });
}

function closedControl(value) {
  assertPlainRecord(value, 'policy control result');
  assertAllowedKeys(value, ['enabled', 'epoch'], 'policy control result');
  if (typeof value.enabled !== 'boolean' || !Number.isSafeInteger(value.epoch) || value.epoch < 0) {
    throw new TypeError('policy control result is invalid');
  }
  return Object.freeze({ enabled: value.enabled, epoch: value.epoch });
}

function closedRate(value) {
  assertPlainRecord(value, 'rate result');
  assertAllowedKeys(value, ['allowed', 'retry_after_seconds'], 'rate result');
  if (typeof value.allowed !== 'boolean' || !Number.isInteger(value.retry_after_seconds)
    || value.retry_after_seconds < 0 || value.retry_after_seconds > 3600) throw new TypeError('rate result is invalid');
  return Object.freeze({ allowed: value.allowed, retry_after_seconds: value.retry_after_seconds });
}

export function createManagedRequestPolicy(options = {}) {
  assertPlainRecord(options, 'request policy options');
  assertAllowedKeys(options, ['readControl', 'consumeRateLimit', 'emitTelemetry', 'clock'], 'request policy options');
  const { readControl, consumeRateLimit, emitTelemetry, clock = () => Date.now() } = options;
  if (typeof readControl !== 'function' || typeof consumeRateLimit !== 'function' || typeof emitTelemetry !== 'function') {
    throw new TypeError('host-owned policy callbacks are required');
  }
  if (typeof clock !== 'function') throw new TypeError('clock must be a function');
  let telemetryPending = false;
  const readClock = () => {
    const value = Number(clock());
    if (!Number.isSafeInteger(value) || value < 0) throw new TypeError('clock must return a non-negative integer');
    return value;
  };
  const telemetry = (event, p, routeClass, status, outcome, started) => {
    if (!EVENTS.includes(event) || !OUTCOMES.includes(outcome)) return;
    if (telemetryPending) return;
    telemetryPending = true;
    let durationMs;
    try { durationMs = Math.max(0, Math.min(2_147_483_647, readClock() - started)); }
    catch { telemetryPending = false; return; }
    Promise.resolve().then(() => emitTelemetry(Object.freeze({ event, route_class: routeClass, status, outcome, duration_ms: durationMs,
      tenant_hash: hashRef('tenant', p.tenant_id), key_hash: hashRef('key', p.key_id) }))).catch(() => {}).finally(() => { telemetryPending = false; });
  };
  return Object.freeze({
    async beforeMutation({ principal: supplied, routeClass, signal } = {}) {
      const started = readClock();
      requireEnum(routeClass, ROUTES, 'routeClass');
      const p = principal(supplied); checkSignal(signal);
      let control;
      try { control = closedControl(await awaitWithSignal(readControl(signal), signal)); checkSignal(signal); }
      catch (error) {
        telemetry('policy_error', p, routeClass, 503, error?.code === 'REQUEST_TIMEOUT' ? 'timeout' : 'failed_closed', started);
        if (error?.code === 'REQUEST_TIMEOUT' || signal?.aborted) throw managedError('Request deadline expired', 'REQUEST_TIMEOUT', 408);
        throw managedError('Policy control unavailable', 'POLICY_UNAVAILABLE', 503);
      }
      if (!control.enabled && (routeClass === 'admission' || routeClass === 'execution')) {
        telemetry('control_denied', p, routeClass, 503, 'disabled', started);
        throw managedError('Managed service is disabled', 'MANAGED_SERVICE_DISABLED', 503);
      }
      let rate;
      try {
        rate = closedRate(await awaitWithSignal(consumeRateLimit(Object.freeze({ tenant_id: p.tenant_id, key_id: p.key_id, route_class: routeClass, signal })), signal));
        checkSignal(signal);
      } catch (error) {
        telemetry('policy_error', p, routeClass, 503, error?.code === 'REQUEST_TIMEOUT' ? 'timeout' : 'failed_closed', started);
        if (error?.code === 'REQUEST_TIMEOUT' || signal?.aborted) throw managedError('Request deadline expired', 'REQUEST_TIMEOUT', 408);
        throw managedError('Rate policy unavailable', 'RATE_LIMIT_UNAVAILABLE', 503);
      }
      if (!rate.allowed) {
        telemetry('rate_denied', p, routeClass, 429, 'rate_limited', started);
        const error = managedError('Request rate limit exceeded', 'RATE_LIMITED', 429);
        error.retry_after_seconds = rate.retry_after_seconds;
        throw error;
      }
      let current;
      try { current = closedControl(await awaitWithSignal(readControl(signal), signal)); checkSignal(signal); }
      catch (error) {
        telemetry('policy_error', p, routeClass, 503, error?.code === 'REQUEST_TIMEOUT' ? 'timeout' : 'failed_closed', started);
        if (error?.code === 'REQUEST_TIMEOUT' || signal?.aborted) throw managedError('Request deadline expired', 'REQUEST_TIMEOUT', 408);
        throw managedError('Policy control unavailable', 'POLICY_UNAVAILABLE', 503);
      }
      if (current.epoch !== control.epoch) {
        telemetry('control_denied', p, routeClass, 503, 'failed_closed', started);
        throw managedError('Policy control changed during request', 'POLICY_EPOCH_CHANGED', 503);
      }
      if (!current.enabled && (routeClass === 'admission' || routeClass === 'execution')) {
        telemetry('control_denied', p, routeClass, 503, 'disabled', started);
        throw managedError('Managed service is disabled', 'MANAGED_SERVICE_DISABLED', 503);
      }
      telemetry('policy_allowed', p, routeClass, 200, 'allowed', started);
      return Object.freeze({ tenant_id: p.tenant_id, key_id: p.key_id, epoch: current.epoch, route_class: routeClass });
    },
  });
}
