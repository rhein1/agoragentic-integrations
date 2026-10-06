import { assertAllowedKeys, assertDataArray, assertPlainRecord, requireInteger, requireOpaqueRef, requireSha256, requireTenantId } from './validation.mjs';
import { canonicalize, sha256Ref } from '../../src/canonical.mjs';
import { lifecycleTenantHash } from './lifecycle-event.mjs';
import { MANAGED_BACKLOG_COUNT_FIELDS, normalizeManagedBacklogSnapshot } from './backlog-snapshot.mjs';
import { normalizeBacklogGauge } from './backlog-gauge.mjs';
import { createManagedDeadline } from './deadline.mjs';

const bump = (n) => Math.min(2_147_483_647,n+1);
// Checkout-only trusted host composition over the existing authorized read and
// telemetry store. No provider callback, public route or automatic startup.
export function createManagedBacklogObserver(options) {
  assertPlainRecord(options,'backlog observer options');
  assertAllowedKeys(options,['controlPlane','store','auditPrincipals','observerId','timeoutMs','intervalMs','maxTenantsPerTick'],'backlog observer options');
  const observerHash = sha256Ref({ domain: 'risk-fork-backlog-observer-v1',observer_id: requireOpaqueRef(options.observerId,'observerId') });
  const principals = assertDataArray(options.auditPrincipals,'auditPrincipals',{ maxLength: 64 }).slice(), tenants = new Set();
  if (principals.length === 0) throw new TypeError('At least one audit principal is required');
  for (const principal of principals) {
    assertPlainRecord(principal,'audit principal');
    const tenant = requireTenantId(principal.tenant_id), scopes = assertDataArray(principal.scopes,'audit scopes',{ maxLength: 64 });
    if (!Object.isFrozen(principal) || !Object.isFrozen(scopes) || !scopes.includes('audit:read') || tenants.has(tenant)) throw new TypeError('Immutable distinct-tenant audit principals are required');
    tenants.add(tenant);
  }
  const source = options.controlPlane, store = options.store;
  if (!source || typeof source.readCleanupRecoveryBacklog !== 'function' || !store
    || !['readBacklogGauge','appendBacklogSnapshot'].every((key) => typeof store[key] === 'function')) throw new TypeError('Backlog source and durable store are required');
  const sample = source.readCleanupRecoveryBacklog.bind(source), read = store.readBacklogGauge.bind(store), append = store.appendBacklogSnapshot.bind(store);
  const timeout = requireInteger(options.timeoutMs ?? 2000,'timeoutMs',{ min: 50,max: 30_000 });
  const interval = requireInteger(options.intervalMs ?? 1000,'intervalMs',{ min: 100,max: 30_000 });
  const batch = requireInteger(options.maxTenantsPerTick ?? 4,'maxTenantsPerTick',{ min: 1,max: 64 });
  const stop = new AbortController(), pending = new Map();
  let timer, current, closed = false, cursor = 0, sampled = 0, failed = 0, timedOut = 0;
  const failureCounts = { backlog_gauge_read: 0,backlog_source_read: 0,backlog_snapshot_append: 0 };
  const health = () => Object.freeze({ sampled,failed,timed_out: timedOut,failure_counts: Object.freeze({ ...failureCounts }),
    in_flight: pending.size,running: timer !== undefined,closed,production_qualified: false });
  const active = (signal) => { if (closed || signal.aborted) throw new DOMException('Backlog observer stopped','AbortError'); };
  async function step(principal) {
    const deadline = createManagedDeadline(timeout,{ signal: stop.signal }), signal = deadline.signal;
    const tenantHash = lifecycleTenantHash(principal.tenant_id);
    // Private host phase only: rejection, invalid reply and timeout all mean
    // unconfirmed at this boundary, never a diagnosed dependency/root cause.
    let boundary = 'backlog_gauge_read';
    const observeFailure = () => { failed = bump(failed); failureCounts[boundary] = bump(failureCounts[boundary]); };
    const work = Promise.resolve().then(async () => {
      active(signal);
      const expected = normalizeBacklogGauge(await read({ tenant_hash: tenantHash,signal })); active(signal);
      if (expected && expected.tenant_hash !== tenantHash) throw new TypeError('Backlog state tenant mismatch');
      // Preserve the ORIGINAL branded principal. Source reauthorizes it after
      // its own wait; this observer's deadline is not source cancellation proof.
      boundary = 'backlog_source_read';
      const snapshot = normalizeManagedBacklogSnapshot(await sample(principal),principal.tenant_id); active(signal);
      boundary = 'backlog_snapshot_append';
      const result = await append({ tenant_id: principal.tenant_id,observer_hash: observerHash,expected_state: expected,snapshot },{ signal }); active(signal);
      assertPlainRecord(result,'backlog acknowledgement'); assertAllowedKeys(result,['persisted','batch_hash','state'],'backlog acknowledgement');
      requireSha256(result.batch_hash,'batch_hash');
      const state = normalizeBacklogGauge(result.state);
      if (result.persisted !== true || !state || state.tenant_hash !== tenantHash || state.source_snapshot_hash !== snapshot.snapshot_hash
        || state.source_snapshot_at !== snapshot.snapshot_at || MANAGED_BACKLOG_COUNT_FIELDS.some((key) => state[key] !== snapshot[key])) throw new TypeError('Backlog persistence was not confirmed');
      const batchHash = sha256Ref({ domain: 'risk-fork-backlog-batch-v1',tenant_hash: tenantHash,observer_hash: observerHash,
        expected_state: expected,snapshot,settings_hash: state.settings_hash });
      if (result.batch_hash !== batchHash || (state.generation === expected?.generation ? canonicalize(state) !== canonicalize(expected)
        : state.generation !== (expected?.generation ?? 0)+1 || state.observer_hash !== observerHash || state.last_batch_hash !== batchHash)) throw new TypeError('Backlog acknowledgement binding mismatch');
      return { sampled: true };
    }).catch(() => ({ failed: true }));
    pending.set(principal.tenant_id,work);
    void work.finally(() => { if (pending.get(principal.tenant_id) === work) pending.delete(principal.tenant_id); });
    try {
      const result = await Promise.race([work,deadline.aborted]);
      // Count only the bounded wait's outcome. Late rejection/settlement and
      // intentional shutdown never add another failure or manufacture success.
      if (signal.aborted) { if (!closed) { timedOut = bump(timedOut); observeFailure(); } }
      else if (result.failed) observeFailure();
      else sampled = bump(sampled);
    } finally { deadline.dispose(); }
  }
  const api = Object.freeze({
    runOnce() {
      if (closed) return Promise.resolve(health());
      if (current) return current;
      const selected = [];
      for (let inspected = 0; inspected < principals.length && selected.length < batch; inspected += 1) {
        const principal = principals[cursor]; cursor = (cursor+1)%principals.length;
        if (!pending.has(principal.tenant_id)) selected.push(step(principal));
      }
      const work = Promise.all(selected).then(health); current = work;
      void work.finally(() => { if (current === work) current = undefined; }).catch(() => {});
      return work;
    },
    start() {
      if (closed) throw new TypeError('Backlog observer is closed');
      if (timer !== undefined) return;
      timer = setInterval(() => { void api.runOnce().catch(() => {}); },interval); timer.unref?.();
    },
    health,
    async close(options = {}) {
      assertPlainRecord(options,'backlog close options'); assertAllowedKeys(options,['timeoutMs'],'backlog close options');
      const timeoutMs = requireInteger(options.timeoutMs ?? timeout,'timeoutMs',{ min: 50,max: 30_000 });
      closed = true; stop.abort(); if (timer !== undefined) clearInterval(timer); timer = undefined;
      const deadline = createManagedDeadline(timeoutMs);
      try { if (pending.size) await Promise.race([Promise.allSettled([...pending.values()]),deadline.aborted]); }
      finally { deadline.dispose(); }
      return Object.freeze({ settled: pending.size === 0,...health() });
    },
  });
  return api;
}
