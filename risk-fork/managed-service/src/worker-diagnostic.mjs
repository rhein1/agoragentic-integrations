import { createManagedDeadline } from './deadline.mjs';
import { createManagedWorkerDiagnosticObservation, normalizeWorkerDiagnosticSettings, WORKER_DIAGNOSTIC_BOUNDARIES } from './worker-diagnostic-event.mjs';
import { assertAllowedKeys, assertPlainRecord, requireEnum, requireInteger } from './validation.mjs';

const bump = (value) => Math.min(2147483647,value+1);
// Internal nonblocking recorder. One actual append per fixed boundary, never an
// unbounded attempt queue. Hung calls retain slots after deadlines and shutdown.
export function createWorkerDiagnostic(options,tenantHash,workerHash,signal) {
  const enabled = options.workerDiagnosticSettings !== undefined;
  if (!enabled && ['workerDiagnosticStore','workerDiagnosticClock','workerDiagnosticTimeoutMs'].some((key) => options[key] !== undefined)) {
    throw new TypeError('Worker diagnostic options require workerDiagnosticSettings');
  }
  const settings = enabled ? normalizeWorkerDiagnosticSettings(options.workerDiagnosticSettings) : undefined;
  if (enabled && typeof options.workerDiagnosticStore?.appendWorkerDiagnosticObservation !== 'function') throw new TypeError('Worker diagnostic store method is required');
  const append = enabled ? options.workerDiagnosticStore.appendWorkerDiagnosticObservation.bind(options.workerDiagnosticStore) : undefined;
  const clock = options.workerDiagnosticClock ?? Date.now;
  if (typeof clock !== 'function') throw new TypeError('Worker diagnostic clock must be a function');
  const timeout = requireInteger(options.workerDiagnosticTimeoutMs ?? 1000,'workerDiagnosticTimeoutMs',{ min: 50,max: 30000 });
  const pending = new Map(), counts = Object.fromEntries(WORKER_DIAGNOSTIC_BOUNDARIES.map((name) => [name,0]));
  let lastSeen = 0,recorded = 0,failed = 0,timedOut = 0,dropped = 0;
  const health = () => Object.freeze({ enabled,recorded,failed,timed_out: timedOut,dropped,in_flight: pending.size,
    failure_counts: Object.freeze({ ...counts }) });
  function record(boundary) {
    requireEnum(boundary,WORKER_DIAGNOSTIC_BOUNDARIES,'worker boundary');
    if (signal.aborted) return;
    counts[boundary] = bump(counts[boundary]);
    if (!enabled) return;
    if (pending.has(boundary)) { dropped = bump(dropped); return; }
    let event;
    try {
      const now = requireInteger(clock(),'worker diagnostic clock');
      if (now < lastSeen) throw new TypeError('Worker diagnostic clock regressed'); lastSeen = now;
      event = createManagedWorkerDiagnosticObservation({ tenant_hash: tenantHash,worker_hash: workerHash,boundary,observed_ms: now },settings);
    } catch { failed = bump(failed); return; }
    const deadline = createManagedDeadline(timeout,{ signal,referenced: false }), ownSignal = deadline.signal;
    const work = Promise.resolve().then(async () => {
      if (ownSignal.aborted) return false;
      const ack = await append(event,{ signal: ownSignal });
      if (ownSignal.aborted) return false;
      assertPlainRecord(ack,'worker diagnostic acknowledgement'); assertAllowedKeys(ack,['event_ref','persisted'],'worker diagnostic acknowledgement');
      return ack.persisted === true && ack.event_ref === event.event_ref;
    }).catch(() => false);
    pending.set(boundary,work);
    void work.finally(() => { if (pending.get(boundary) === work) pending.delete(boundary); });
    void (async () => {
      try {
        const result = await Promise.race([work,deadline.aborted]);
        if (signal.aborted) return;
        if (ownSignal.aborted) { timedOut = bump(timedOut); failed = bump(failed); }
        else if (result === true) recorded = bump(recorded);
        else failed = bump(failed);
      } finally { deadline.dispose(); }
    })();
  }
  async function flush(options = {}) {
    assertPlainRecord(options,'worker diagnostic flush options'); assertAllowedKeys(options,['timeoutMs'],'worker diagnostic flush options');
    const timeoutMs = requireInteger(options.timeoutMs ?? 1000,'timeoutMs',{ min: 50,max: 30000 });
    if (pending.size) {
      const deadline = createManagedDeadline(timeoutMs);
      try { await Promise.race([Promise.allSettled([...pending.values()]),deadline.aborted]); }
      finally { deadline.dispose(); }
    }
    return Object.freeze({ ...health(),settled: pending.size === 0,termination_proven: false });
  }
  return Object.freeze({ record,health,flush });
}
