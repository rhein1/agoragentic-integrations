import { createManagedDeadline } from './deadline.mjs';
import { createManagedDiagnosticObservation, normalizeDiagnosticSettings } from './diagnostic-event.mjs';
import { assertAllowedKeys, assertPlainRecord, requireInteger } from './validation.mjs';

const bump = (n) => Math.min(2147483647,n+1);
// Internal optional composition, not another loop/queue/delivery runner. The
// owner observer supplies only its private phase and tenant hash. At most one
// actual recorder call per configured tenant remains owned until settlement.
export function createObserverDiagnostic(options,observerHash,signal) {
  const enabled = options.diagnosticSettings !== undefined;
  if (!enabled && (options.diagnosticClock !== undefined || options.diagnosticTimeoutMs !== undefined)) throw new TypeError('Diagnostic options require diagnosticSettings');
  const settings = enabled ? normalizeDiagnosticSettings(options.diagnosticSettings) : undefined;
  if (enabled && typeof options.store.appendDiagnosticObservation !== 'function') throw new TypeError('Diagnostic store method is required');
  const append = enabled ? options.store.appendDiagnosticObservation.bind(options.store) : undefined;
  const clock = options.diagnosticClock ?? Date.now;
  if (typeof clock !== 'function') throw new TypeError('Diagnostic clock must be a function');
  const timeout = requireInteger(options.diagnosticTimeoutMs ?? 1000,'diagnosticTimeoutMs',{ min: 50,max: 30000 });
  const pending = new Map();
  let recorded = 0,failed = 0,timedOut = 0,lastSeen = 0;
  const health = () => Object.freeze({ enabled,recorded,failed,timed_out: timedOut,in_flight: pending.size });
  async function record(tenantHash,boundary) {
    if (!enabled || signal.aborted || pending.has(tenantHash)) return;
    let event;
    try {
      const now = requireInteger(clock(),'diagnostic clock');
      if (now < lastSeen) throw new TypeError('Diagnostic clock regressed');
      lastSeen = now;
      event = createManagedDiagnosticObservation({ tenant_hash: tenantHash,observer_hash: observerHash,boundary,observed_ms: now },settings);
    } catch { failed = bump(failed); return; }
    const deadline = createManagedDeadline(timeout,{ signal }), ownSignal = deadline.signal;
    const work = Promise.resolve().then(async () => {
      if (ownSignal.aborted) return false;
      const ack = await append(event,{ signal: ownSignal });
      if (ownSignal.aborted) return false;
      assertPlainRecord(ack,'diagnostic acknowledgement'); assertAllowedKeys(ack,['event_ref','persisted'],'diagnostic acknowledgement');
      return ack.persisted === true && ack.event_ref === event.event_ref;
    }).catch(() => false);
    pending.set(tenantHash,work);
    void work.finally(() => { if (pending.get(tenantHash) === work) pending.delete(tenantHash); });
    try {
      const result = await Promise.race([work,deadline.aborted]);
      if (signal.aborted) return;
      if (ownSignal.aborted) { timedOut = bump(timedOut); failed = bump(failed); }
      else if (result === true) recorded = bump(recorded);
      else failed = bump(failed);
    } finally { deadline.dispose(); }
  }
  return Object.freeze({ record,health,has: (tenantHash) => pending.has(tenantHash),
    pending: () => [...pending.values()] });
}
