import assert from 'node:assert/strict';
import test from 'node:test';
import { createManagedRequestPolicy } from '../src/request-policy.mjs';

const principal = { key_id: 'key_private', tenant_id: 'tenant_private', scopes: ['invocations:write'] };
function policy(recordTelemetry, overrides = {}) {
  return createManagedRequestPolicy({ readControl: async () => ({ enabled: true, epoch: 1 }),
    consumeRateLimit: async () => ({ allowed: true, retry_after_seconds: 0 }), recordTelemetry, ...overrides });
}
const ack = (event) => ({ event_ref: event.event_ref, persisted: true });
const tick = () => new Promise((resolve) => setImmediate(resolve));

test('critical allowed decisions wait for distinct durable appends without overlap loss', async () => {
  const events = []; let release; const gate = new Promise((resolve) => { release = resolve; });
  const value = policy(async (event) => { events.push(event); await gate; return ack(event); });
  let completed = 0;
  const calls = ['admission', 'execution'].map((routeClass) => value.beforeMutation({ principal, routeClass }).then(() => { completed += 1; }));
  await tick(); assert.equal(events.length, 2); assert.equal(completed, 0);
  assert.notEqual(events[0].event_ref, events[1].event_ref);
  assert.equal(events.every((event) => event.event === 'policy_candidate' && event.outcome === 'candidate'),true);
  assert.ok(events.every(Object.isFrozen));
  assert.equal(JSON.stringify(events).includes('private'), false);
  release(); await Promise.all(calls); assert.equal(completed, 2);
  assert.equal(value.telemetryHealth().recorded, 2);
});

test('uncertain, mismatched and throwing append acknowledgements fail critical routes closed', async () => {
  for (const recorder of [async () => undefined, async (event) => ({ event_ref: event.event_ref, persisted: false }),
    async () => ({ event_ref: 'evt_wrong', persisted: true }), async (event) => ({ ...ack(event), secret: 'private' }),
    async () => { throw new Error('private credential'); }]) {
    const value = policy(recorder);
    for (const routeClass of ['admission', 'execution']) await assert.rejects(value.beforeMutation({ principal, routeClass }),
      (error) => error.code === 'POLICY_TELEMETRY_UNAVAILABLE' && error.status === 503 && !error.message.includes('private'));
  }
});

test('hung append is bounded; cleanup/recovery/read do not await telemetry or inherit its outage', async () => {
  const value = policy(async () => new Promise(() => {}), { telemetryTimeoutMs: 100 });
  const keepAlive = setTimeout(() => {}, 1000);
  try { await assert.rejects(value.beforeMutation({ principal, routeClass: 'admission' }), { code: 'POLICY_TELEMETRY_UNAVAILABLE' }); }
  finally { clearTimeout(keepAlive); }
  for (const routeClass of ['cleanup', 'recovery', 'read']) await value.beforeMutation({ principal, routeClass });
  assert.equal(value.telemetryHealth().in_flight, 4);
});

test('disable/re-enable while durable append waits cannot preserve a stale execution decision', async () => {
  let epoch = 1; let entered; let release; const events = [];
  const ready = new Promise((resolve) => { entered = resolve; });
  const gate = new Promise((resolve) => { release = resolve; });
  const value = policy(async (event) => { events.push(event); entered(); await gate; return ack(event); },
    { readControl: async () => ({ enabled: true, epoch }) });
  const pending = value.beforeMutation({ principal, routeClass: 'execution' });
  const rejected = assert.rejects(pending, { code: 'POLICY_EPOCH_CHANGED' });
  await ready; epoch = 3; release(); await rejected;
  await value.flushTelemetry();
  assert.equal(events.some((event) => event.event === 'policy_allowed'),false);
  assert.equal(events[0].event,'policy_candidate');
  assert.equal(events.some((event) => event.event === 'control_denied'),true);
});

test('bounded recorder capacity rejects new critical work without blocking cleanup', async () => {
  const value = policy(async () => new Promise(() => {}));
  for (let i = 0; i < 64; i += 1) await value.beforeMutation({ principal, routeClass: 'read' });
  await assert.rejects(value.beforeMutation({ principal, routeClass: 'execution' }), { code: 'POLICY_TELEMETRY_UNAVAILABLE' });
  await value.beforeMutation({ principal, routeClass: 'cleanup' });
  assert.equal(value.telemetryHealth().in_flight, 64);
  assert.equal(value.telemetryHealth().dropped, 2);
});

test('caller abort during append denies authority even if the exact append resolves later', async () => {
  let entered; let release; const ready = new Promise((resolve) => { entered = resolve; });
  const gate = new Promise((resolve) => { release = resolve; });
  const value = policy(async (event) => { entered(); await gate; return ack(event); });
  const abort = new AbortController();
  const pending = value.beforeMutation({ principal, routeClass: 'execution', signal: abort.signal });
  const rejected = assert.rejects(pending, { code: 'REQUEST_TIMEOUT' });
  await ready; abort.abort(); await rejected; release(); await tick();
  assert.equal(value.telemetryHealth().recorded, 1);
});
