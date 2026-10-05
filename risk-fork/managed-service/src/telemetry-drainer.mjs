import { randomBytes } from 'node:crypto';
import { assertAllowedKeys, assertPlainRecord, requireInteger } from './validation.mjs';
import { normalizeManagedTelemetryEvent } from './telemetry-event.mjs';
import { createManagedDeadline } from './deadline.mjs';

const branded = new WeakSet();
const MAX_COUNTER = 2_147_483_647;
const bump = (value) => Math.min(MAX_COUNTER,value + 1);
function acknowledge(value, ref) {
  assertPlainRecord(value,'telemetry sink acknowledgement');
  assertAllowedKeys(value,['event_ref','delivered'],'telemetry sink acknowledgement');
  if (!Object.hasOwn(value,'event_ref') || !Object.hasOwn(value,'delivered') || value.event_ref !== ref || value.delivered !== true) throw new TypeError('Invalid telemetry sink acknowledgement');
  return Object.freeze({ event_ref: ref, delivered: true });
}
// Explicit local observer composition only. No provider/network SDK, endpoint,
// credential provisioning, automatic startup or production qualification.
// A sink must deduplicate event_ref. A callback timeout is not termination proof.
export function createManagedTelemetryDrainer(options) {
  assertPlainRecord(options,'telemetry drainer options');
  assertAllowedKeys(options,['store','deliver','deliveryTimeoutMs','intervalMs','maxBatch'],'telemetry drainer options');
  const store = options.store;
  if (!store || !['claim','acknowledge','retry'].every((method) => typeof store[method] === 'function') || typeof options.deliver !== 'function') throw new TypeError('Telemetry drainer requires trusted store and sink');
  const deliver = options.deliver;
  const timeout = requireInteger(options.deliveryTimeoutMs ?? 1000,'deliveryTimeoutMs',{ min: 50, max: 5000 });
  const interval = requireInteger(options.intervalMs ?? 1000,'intervalMs',{ min: 100, max: 30_000 });
  const batch = requireInteger(options.maxBatch ?? 16,'maxBatch',{ min: 1, max: 64 });
  let closed = false, timer, current, deliveryPending, stopController = new AbortController();
  let delivered = 0, failed = 0, timedOut = 0, shutdownInterrupted = 0;
  const health = () => Object.freeze({ delivered,failed,timed_out: timedOut,shutdown_interrupted: shutdownInterrupted,in_flight: deliveryPending !== undefined,
    running: timer !== undefined,closed,production_qualified: false });
  async function run() {
    let processed = 0;
    while (!closed && !stopController.signal.aborted && !deliveryPending && processed < batch) {
      const claimToken = randomBytes(32).toString('base64url');
      let claimed;
      try { claimed = await store.claim({ claimToken,signal: stopController.signal }); }
      catch { failed = bump(failed); break; }
      if (claimed == null || closed || stopController.signal.aborted) break;
      let event;
      try { event = normalizeManagedTelemetryEvent(claimed.event); requireInteger(claimed.generation,'generation',{ min: 1 }); }
      catch { failed = bump(failed); break; }
      const deadline = createManagedDeadline(timeout,{ signal: stopController.signal });
      const signal = deadline.signal;
      let errorCode = 'SINK_UNAVAILABLE';
      const work = Promise.resolve().then(() => {
        if (signal.aborted) return null;
        return deliver(event,{ signal });
      }).then((result) => {
        try { return acknowledge(result,event.event_ref); }
        catch { errorCode = 'INVALID_ACK'; return null; }
      }).catch(() => null);
      deliveryPending = work;
      void work.finally(() => { if (deliveryPending === work) deliveryPending = undefined; });
      let result;
      try { result = await Promise.race([work,deadline.aborted]); }
      finally { deadline.dispose(); }
      if (signal.aborted) {
        if (stopController.signal.aborted) shutdownInterrupted = bump(shutdownInterrupted);
        else { timedOut = bump(timedOut); failed = bump(failed); }
        // Preserve the claim until expiry. An interrupted sink may still be doing
        // work; no immediate lease release, acknowledgement or retry loop.
        break;
      }
      processed += 1;
      try {
        if (result) {
          await store.acknowledge({ event_ref: event.event_ref,generation: claimed.generation,claimToken,
            acknowledgement: result,signal: stopController.signal });
          delivered = bump(delivered);
        } else {
          await store.retry({ event_ref: event.event_ref,generation: claimed.generation,claimToken,errorCode,
            signal: stopController.signal }); failed = bump(failed);
          break; // Backoff is durable, not a busy-loop retry.
        }
      } catch { failed = bump(failed); break; } // Lost ack remains recoverable.
    }
    return Object.freeze({ processed,...health() });
  }
  const api = Object.freeze({
    runOnce() {
      if (closed || deliveryPending) return Promise.resolve(Object.freeze({ processed: 0,...health() }));
      if (current) return current;
      const work = run(); current = work;
      void work.finally(() => { if (current === work) current = undefined; }).catch(() => {});
      return work;
    },
    start() {
      if (closed) throw new TypeError('Telemetry drainer is closed');
      if (timer !== undefined) return;
      timer = setInterval(() => { void api.runOnce().catch(() => {}); },interval); timer.unref?.();
    },
    health,
    async close(options = {}) {
      assertPlainRecord(options,'telemetry close options'); assertAllowedKeys(options,['timeoutMs'],'telemetry close options');
      const timeoutMs = requireInteger(options.timeoutMs ?? timeout,'timeoutMs',{ min: 50, max: 30_000 });
      closed = true; if (timer !== undefined) clearInterval(timer); timer = undefined; stopController.abort();
      const deadline = createManagedDeadline(timeoutMs);
      const pending = [current,deliveryPending].filter(Boolean);
      try { if (pending.length) await Promise.race([Promise.allSettled(pending),deadline.aborted]); }
      finally { deadline.dispose(); }
      return Object.freeze({ settled: current === undefined && deliveryPending === undefined,...health() });
    },
  });
  branded.add(api); return api;
}

export const isManagedTelemetryDrainer = (value) => branded.has(value);
