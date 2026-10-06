import { sha256Ref } from '../../src/canonical.mjs';
import { assertAllowedKeys, assertDataArray, assertPlainRecord, requireInteger, requireOpaqueRef, requireTenantId } from './validation.mjs';
import { lifecycleTenantHash } from './lifecycle-event.mjs';
import { lifecycleCheckpoint, lifecycleSweep } from './lifecycle-state.mjs';
import { createManagedDeadline } from './deadline.mjs';

const branded = new WeakSet();
const bump = (n) => Math.min(2_147_483_647,n+1);
// Trusted host observation only. Reads reauthorize the ORIGINAL audit principal
// through the control plane. No worker/provider callbacks or public routes.
export function createManagedLifecycleObserver(options) {
  assertPlainRecord(options,'lifecycle observer options');
  assertAllowedKeys(options,['controlPlane','store','auditPrincipals','observerId','timeoutMs','intervalMs','maxTenantsPerTick'],'lifecycle observer options');
  const observerHash = sha256Ref({ domain: 'risk-fork-lifecycle-observer-v1',observer_id: requireOpaqueRef(options.observerId,'observerId') });
  const principals = assertDataArray(options.auditPrincipals,'auditPrincipals',{ maxLength: 64 }).slice();
  if (principals.length === 0) throw new TypeError('At least one audit principal is required');
  const tenants = new Set();
  for (const principal of principals) {
    assertPlainRecord(principal,'audit principal');
    const tenant = requireTenantId(principal.tenant_id), scopes = assertDataArray(principal.scopes,'audit scopes',{ maxLength: 64 });
    if (!Object.isFrozen(principal) || !Object.isFrozen(scopes) || !scopes.includes('audit:read') || tenants.has(tenant)) throw new TypeError('Immutable distinct-tenant audit principals are required');
    tenants.add(tenant);
  }
  const source = options.controlPlane, store = options.store;
  if (!source || !['listAuditInvocations','readAuditWindow'].every((key) => typeof source[key] === 'function')
    || !store || !['readLifecycleSweep','readLifecycleCheckpoint','appendLifecycleWindow'].every((key) => typeof store[key] === 'function')) throw new TypeError('Lifecycle source and durable store are required');
  const list = source.listAuditInvocations.bind(source), read = source.readAuditWindow.bind(source);
  const readSweep = store.readLifecycleSweep.bind(store), readPrefix = store.readLifecycleCheckpoint.bind(store), append = store.appendLifecycleWindow.bind(store);
  const timeout = requireInteger(options.timeoutMs ?? 2000,'timeoutMs',{ min: 50,max: 30_000 });
  const interval = requireInteger(options.intervalMs ?? 1000,'intervalMs',{ min: 100,max: 30_000 });
  const batch = requireInteger(options.maxTenantsPerTick ?? 4,'maxTenantsPerTick',{ min: 1,max: 64 });
  const stop = new AbortController(), pending = new Map();
  let timer, current, closed = false, cursor = 0, recorded = 0, failed = 0, timedOut = 0;
  const failureCounts = { lifecycle_sweep_read: 0,audit_invocations_read: 0,lifecycle_checkpoint_read: 0,audit_window_read: 0,lifecycle_window_append: 0 };
  const health = () => Object.freeze({ recorded,failed,timed_out: timedOut,failure_counts: Object.freeze({ ...failureCounts }),
    in_flight: pending.size,running: timer !== undefined,closed,production_qualified: false });
  const active = (signal) => { if (closed || signal.aborted) throw new DOMException('Lifecycle observer stopped','AbortError'); };
  async function step(principal) {
    const deadline = createManagedDeadline(timeout,{ signal: stop.signal }), signal = deadline.signal;
    const scope = Object.freeze({ observer_hash: observerHash,tenant_hash: lifecycleTenantHash(principal.tenant_id) });
    // Classify from our own dispatch phase, never from thrown properties.
    // The result is unconfirmed here; it says nothing about the root cause.
    let boundary = 'lifecycle_sweep_read';
    const observeFailure = () => { failed = bump(failed); failureCounts[boundary] = bump(failureCounts[boundary]); };
    const work = Promise.resolve().then(async () => {
      active(signal);
      const sweep = lifecycleSweep(await readSweep(scope,{ signal })); active(signal);
      boundary = 'audit_invocations_read';
      const page = await list(principal,{ after_ref: sweep?.after_ref ?? null,upper_ref: sweep?.upper_ref ?? null,limit: 1 }); active(signal);
      const ref = page.invocations[0]?.invocation_ref;
      let checkpoint = null, window = null;
      if (ref !== undefined) {
        boundary = 'lifecycle_checkpoint_read';
        checkpoint = lifecycleCheckpoint(await readPrefix(scope,ref,{ signal })); active(signal);
        boundary = 'audit_window_read';
        window = await read(principal,ref,{ after_sequence: checkpoint?.sequence ?? 0,prior_event_hash: checkpoint?.event_hash ?? null,limit: 64 }); active(signal);
      }
      boundary = 'lifecycle_window_append';
      const result = await append({ scope,tenant_id: principal.tenant_id,expected_sweep: sweep,expected_checkpoint: checkpoint,page,window },{ signal }); active(signal);
      assertPlainRecord(result,'lifecycle append acknowledgement');
      assertAllowedKeys(result,['batch_hash','persisted','projected','sweep'],'lifecycle append acknowledgement');
      if (result.persisted !== true) throw new TypeError('Lifecycle append was not confirmed');
      return requireInteger(result.projected,'projected',{ max: 64 });
    }).then((projected) => ({ projected }),() => ({ failed: true }));
    pending.set(principal.tenant_id,work);
    void work.finally(() => { if (pending.get(principal.tenant_id) === work) pending.delete(principal.tenant_id); });
    try {
      const result = await Promise.race([work,deadline.aborted]);
      // Only this bounded outcome counts; late settlement and shutdown do not.
      if (signal.aborted) { if (!closed) { timedOut = bump(timedOut); observeFailure(); } }
      else if (result.failed) observeFailure();
      else recorded = Math.min(2_147_483_647,recorded+result.projected);
    } finally { deadline.dispose(); }
    // The underlying slot remains occupied until actual settlement. A source
    // that ignores abort cannot append late or starve other tenants' ticks.
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
      if (closed) throw new TypeError('Lifecycle observer is closed');
      if (timer !== undefined) return;
      timer = setInterval(() => { void api.runOnce().catch(() => {}); },interval); timer.unref?.();
    },
    health,
    async close(options = {}) {
      assertPlainRecord(options,'lifecycle close options'); assertAllowedKeys(options,['timeoutMs'],'lifecycle close options');
      const timeoutMs = requireInteger(options.timeoutMs ?? timeout,'timeoutMs',{ min: 50,max: 30_000 });
      closed = true; stop.abort(); if (timer !== undefined) clearInterval(timer); timer = undefined;
      const deadline = createManagedDeadline(timeoutMs);
      try { if (pending.size) await Promise.race([Promise.allSettled([...pending.values()]),deadline.aborted]); }
      finally { deadline.dispose(); }
      return Object.freeze({ settled: pending.size === 0,...health() });
    },
  });
  branded.add(api); return api;
}
export const isManagedLifecycleObserver = (value) => branded.has(value);
