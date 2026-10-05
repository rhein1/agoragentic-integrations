import { createHash } from 'node:crypto';
import {
  assertAllowedKeys, assertPlainRecord, managedError, requireEnum,
  assertDataArray, requireOpaqueRef, requireTenantId, requireInvocationRef, requireInteger,
} from './validation.mjs';
import { MANAGED_SCOPES } from './constants.mjs';
import { assertManagedTelemetryAppend, createManagedTelemetryEvent } from './telemetry-event.mjs';
import { createManagedDeadline } from './deadline.mjs';

const ROUTES = Object.freeze(['admission', 'execution', 'cleanup', 'recovery', 'read']);
const EVENTS = Object.freeze(['control_denied', 'rate_denied', 'policy_error', 'policy_allowed', 'policy_candidate']);
const OUTCOMES = Object.freeze(['allowed', 'disabled', 'rate_limited', 'failed_closed', 'timeout', 'candidate']);
const POLICIES = new WeakSet();

// Clean-host capability identity only. Serialized decisions and lookalike
// callbacks must never supply worker dispatch authority.
export function assertManagedRequestPolicy(value) {
  if (!POLICIES.has(value)) throw new TypeError('An original managed request policy is required');
  return value;
}

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
  assertAllowedKeys(options, ['readControl', 'consumeRateLimit', 'emitTelemetry', 'recordTelemetry', 'telemetryTimeoutMs', 'clock'], 'request policy options');
  const { readControl, consumeRateLimit, emitTelemetry, recordTelemetry, clock = () => Date.now() } = options;
  if (typeof readControl !== 'function' || typeof consumeRateLimit !== 'function'
    || (typeof emitTelemetry !== 'function' && typeof recordTelemetry !== 'function')) {
    throw new TypeError('host-owned policy callbacks are required');
  }
  if (emitTelemetry !== undefined && recordTelemetry !== undefined) throw new TypeError('Choose best-effort emission or durable recording, not both');
  const telemetryTimeoutMs = requireInteger(options.telemetryTimeoutMs ?? 1000, 'telemetryTimeoutMs', { min: 100, max: 5000 });
  if (typeof clock !== 'function') throw new TypeError('clock must be a function');
  const pending = new Set();
  const queue = [];
  let emitting = false;
  let recorded = 0; let failed = 0; let dropped = 0;
  const increment = (value) => Math.min(2_147_483_647, value + 1);
  const decisions = new WeakMap();
  const readClock = () => {
    const value = Number(clock());
    if (!Number.isSafeInteger(value) || value < 0) throw new TypeError('clock must return a non-negative integer');
    return value;
  };
  const drain = () => {
    if (emitting || queue.length === 0) return;
    emitting = true;
    const event = queue.shift();
    const work = Promise.resolve().then(() => emitTelemetry(event)).then(
      () => { recorded = increment(recorded); }, () => { failed = increment(failed); },
    ).finally(() => { pending.delete(work); emitting = false; drain(); });
    pending.add(work);
  };
  const unavailable = () => managedError('Durable policy telemetry unavailable', 'POLICY_TELEMETRY_UNAVAILABLE', 503);
  const telemetry = async (event, p, routeClass, status, outcome, started, signal, required = false) => {
    if (!EVENTS.includes(event) || !OUTCOMES.includes(outcome)) return false;
    let data;
    try {
      const durationMs = Math.max(0, Math.min(2_147_483_647, readClock() - started));
      data = createManagedTelemetryEvent({ event, route_class: routeClass, status, outcome, duration_ms: durationMs,
        tenant_hash: hashRef('tenant', p.tenant_id), key_hash: hashRef('key', p.key_id) });
    }
    catch { failed = increment(failed); if (required) throw unavailable(); return false; }
    if (pending.size + queue.length >= 64) {
      dropped = increment(dropped); if (required) throw unavailable(); return false;
    }
    if (!recordTelemetry) { queue.push(data); drain(); return false; }
    // Keep actual callback work bounded even if it ignores cancellation. Never
    // free a slot merely because the caller stopped waiting for its commit.
    const deadline = createManagedDeadline(telemetryTimeoutMs, { signal, referenced: required });
    const boundedSignal = deadline.signal;
    const work = Promise.resolve().then(() => recordTelemetry(data, Object.freeze({ signal: boundedSignal }))).then((result) => {
      assertManagedTelemetryAppend(result, data); recorded = increment(recorded); return true;
    }).catch(() => { failed = increment(failed); return false; }).finally(() => { deadline.dispose(); pending.delete(work); });
    pending.add(work);
    if (!required) return false; // Cleanup, recovery and denials never await telemetry.
    try {
      if (!await awaitWithSignal(work, boundedSignal)) throw unavailable();
      checkSignal(signal); return true;
    } catch {
      checkSignal(signal); throw unavailable();
    } finally { deadline.dispose(); }
  };
  const policy = Object.freeze({
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
      const durableRequired = recordTelemetry !== undefined && ['admission', 'execution'].includes(routeClass);
      await telemetry(durableRequired ? 'policy_candidate' : 'policy_allowed', p, routeClass, 200,
        durableRequired ? 'candidate' : 'allowed', started, signal, durableRequired);
      if (durableRequired) {
        // Durable append introduced a new wait. It records the policy candidate,
        // not authority, so disable/epoch state must be checked again afterward.
        let final;
        try { final = closedControl(await awaitWithSignal(readControl(signal), signal)); checkSignal(signal); }
        catch (error) {
          telemetry('policy_error', p, routeClass, 503, error?.code === 'REQUEST_TIMEOUT' ? 'timeout' : 'failed_closed', started);
          if (error?.code === 'REQUEST_TIMEOUT' || signal?.aborted) throw managedError('Request deadline expired', 'REQUEST_TIMEOUT', 408);
          throw managedError('Policy control unavailable', 'POLICY_UNAVAILABLE', 503);
        }
        if (final.epoch !== current.epoch || !final.enabled) {
          telemetry('control_denied', p, routeClass, 503, final.enabled ? 'failed_closed' : 'disabled', started);
          throw managedError('Policy control changed during telemetry append', final.enabled ? 'POLICY_EPOCH_CHANGED' : 'MANAGED_SERVICE_DISABLED', 503);
        }
        current = final;
      }
      const decision = Object.freeze({ tenant_id: p.tenant_id, key_id: p.key_id, epoch: current.epoch, route_class: routeClass });
      decisions.set(decision, p);
      return decision;
    },
    telemetryHealth() {
      return Object.freeze({ mode: recordTelemetry ? 'durable_append' : 'best_effort', recorded, failed, dropped,
        in_flight: pending.size, queued: queue.length, production_qualified: false });
    },
    async flushTelemetry(options = {}) {
      assertPlainRecord(options, 'telemetry flush options'); assertAllowedKeys(options, ['timeoutMs'], 'telemetry flush options');
      const timeoutMs = requireInteger(options.timeoutMs ?? telemetryTimeoutMs, 'timeoutMs', { min: 100, max: 30_000 });
      const deadline = createManagedDeadline(timeoutMs);
      const signal = deadline.signal;
      try { while (pending.size || queue.length) await awaitWithSignal(Promise.all([...pending]), signal); }
      catch { /* A bounded flush is not proof that callbacks stopped or rows committed. */ }
      finally { deadline.dispose(); }
      return Object.freeze({ settled: pending.size === 0 && queue.length === 0, pending: pending.size + queue.length });
    },
    createDispatchFence(decision, options = {}) {
      assertPlainRecord(options, 'dispatch fence options');
      assertAllowedKeys(options, ['principal', 'invocationRef', 'timeoutMs'], 'dispatch fence options');
      const p = principal(options.principal);
      const admitted = decisions.get(decision);
      const invocationRef = requireInvocationRef(options.invocationRef, 'invocationRef');
      const timeoutMs = requireInteger(options.timeoutMs ?? 30_000, 'timeoutMs', { min: 100, max: 30_000 });
      if (!admitted || decision.route_class !== 'execution'
        || admitted.tenant_id !== p.tenant_id || admitted.key_id !== p.key_id) {
        throw managedError('An original execution policy decision is required', 'POLICY_DECISION_INVALID', 403);
      }
      // One rate decision binds one host-owned invocation attempt. Reusing a
      // ticket for another invocation/worker is not a free quota bypass.
      decisions.delete(decision);
      return async ({ invocationRef: suppliedRef, signal } = {}) => {
        if (suppliedRef !== invocationRef) {
          throw managedError('Dispatch invocation binding changed', 'POLICY_DECISION_INVALID', 403);
        }
        checkSignal(signal);
        const deadline = createManagedDeadline(timeoutMs, { signal });
        const boundedSignal = deadline.signal;
        let current;
        try {
          current = closedControl(await awaitWithSignal(readControl(boundedSignal), boundedSignal));
          checkSignal(boundedSignal);
        } catch (error) {
          if (error?.code === 'REQUEST_TIMEOUT' || boundedSignal.aborted) {
            throw managedError('Request deadline expired', 'REQUEST_TIMEOUT', 408);
          }
          throw managedError('Policy control unavailable', 'POLICY_UNAVAILABLE', 503);
        } finally { deadline.dispose(); }
        if (!current.enabled) throw managedError('Managed service is disabled', 'MANAGED_SERVICE_DISABLED', 503);
        if (current.epoch !== decision.epoch) {
          throw managedError('Policy control changed before dispatch', 'POLICY_EPOCH_CHANGED', 503);
        }
      };
    },
  });
  POLICIES.add(policy);
  return policy;
}
