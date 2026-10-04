import { requireInteger, managedError } from './validation.mjs';

// Host scheduler capability, not a public route or provider cleanup operation.
// Atomic store fences remain decisive if different processes reap concurrently.
export function createManagedRiskForkReaper({ controlPlane, batchSize = 100,
  intervalMs = 5000, schedule = setTimeout, cancel = clearTimeout } = {}) {
  if (controlPlane?.config?.environment !== 'local_test' || controlPlane.config.enabled !== true
    || typeof controlPlane.sweepExpiredLeases !== 'function') throw new TypeError('Enabled local_test control plane is required');
  requireInteger(batchSize, 'batchSize', { min: 1, max: 1000 });
  requireInteger(intervalMs, 'intervalMs', { min: 100, max: 60_000 });
  if (typeof schedule !== 'function' || typeof cancel !== 'function') throw new TypeError('Scheduler callbacks are required');
  let inFlight = null, timer = null, active = false, failure = false;
  function runOnce() {
    if (inFlight) return inFlight;
    const attempt = Promise.resolve().then(() => controlPlane.sweepExpiredLeases({ limit: batchSize }))
      .then((outcomes) => { failure = false; return Object.freeze({ reaped_count: outcomes.length,
        provider_cleanup_performed: false, production_qualified: false }); }, () => {
        failure = true; throw managedError('Reaper sweep failed', 'REAPER_FAILED', 503);
      });
    inFlight = attempt;
    attempt.then(() => { inFlight = null; }, () => { inFlight = null; });
    return attempt;
  }
  function tick() {
    if (!active) return;
    timer = schedule(async () => {
      timer = null;
      try { await runOnce(); } catch { /* health retains failure; no raw errors */ }
      tick();
    }, intervalMs);
    timer?.unref?.();
  }
  return Object.freeze({ runOnce,
    start() { if (!active) { active = true; tick(); } },
    stop() { active = false; if (timer !== null) cancel(timer); timer = null; },
    health() { return Object.freeze({ healthy: !failure, scheduled: active, running: inFlight !== null,
      production_qualified: false, live_traffic_protected: false }); },
  });
}
