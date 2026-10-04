import assert from 'node:assert/strict';
import test from 'node:test';
import { createManagedRiskForkReaper } from '../src/reaper.mjs';
import { createFixture, invocationRequest } from './helpers.mjs';

test('bounded sweeps expire admissions once, coalesce overlap, and survive restart without provider cleanup', async () => {
  const f = await createFixture({ maxInvocationAgeMs: 10000 });
  for (let i = 0; i < 3; i++) await f.controlPlane.admitInvocation(f.principal, invocationRequest({ idempotency_key: `reaper-test-key-${i}` }));
  f.setNow('2026-09-05T12:00:11.000Z');
  const reaper = createManagedRiskForkReaper({ controlPlane: f.controlPlane, batchSize: 1 });
  const a = reaper.runOnce(), b = reaper.runOnce(); assert.equal(a, b);
  assert.equal((await a).reaped_count, 1);
  const restarted = createManagedRiskForkReaper({ controlPlane: f.controlPlane, batchSize: 2 });
  const result = await restarted.runOnce(); assert.equal(result.reaped_count, 2);
  assert.equal(result.provider_cleanup_performed, false);
  assert.equal((await restarted.runOnce()).reaped_count, 0);
});

test('reaper retains failure health and stop cancels scheduling without starting provider work', async () => {
  let callback, cancelled = false, calls = 0;
  const reaper = createManagedRiskForkReaper({
    controlPlane: { config: { environment: 'local_test', enabled: true }, sweepExpiredLeases() { calls++; throw new Error('private diagnostic'); } },
    schedule(fn) { callback = fn; return 1; }, cancel() { cancelled = true; },
  });
  reaper.start(); await callback();
  assert.equal(reaper.health().healthy, false); assert.equal(calls, 1);
  reaper.stop(); assert.equal(cancelled, true); assert.equal(reaper.health().scheduled, false);
  assert.throws(() => createManagedRiskForkReaper({ controlPlane: {}, batchSize: 1001 }));
});
