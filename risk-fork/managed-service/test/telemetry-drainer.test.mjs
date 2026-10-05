import test from 'node:test';
import assert from 'node:assert/strict';
import { createManagedTelemetryDrainer } from '../src/telemetry-drainer.mjs';
import { createManagedTelemetryEvent, normalizeManagedTelemetryEvent } from '../src/telemetry-event.mjs';

const event = () => createManagedTelemetryEvent({ event: 'rate_denied',route_class: 'admission',status: 429,outcome: 'rate_limited',
  duration_ms: 12,tenant_hash: `sha256:${'a'.repeat(64)}`,key_hash: `sha256:${'b'.repeat(64)}` });
const turn = () => new Promise((resolve) => setImmediate(resolve));
function fixture(value = event()) {
  let state = 'pending', token; const calls = { claim: 0,ack: 0,retry: 0 }; const packets = [];
  return { value,calls,packets,
    store: {
      async claim(options) { calls.claim += 1; if (state !== 'pending') return null; state = 'claimed'; token = options.claimToken; return { event: value,generation: 1 }; },
      async acknowledge(options) { assert.equal(options.claimToken,token); assert.equal(options.event_ref,value.event_ref); calls.ack += 1; packets.push(options.acknowledgement); state = 'acked'; },
      async retry(options) { assert.equal(options.claimToken,token); calls.retry += 1; packets.push(options.errorCode); state = 'backoff'; },
    },
  };
}

test('event packets are closed, bounded, redacted, immutable and reusable by exact reference', () => {
  const a = event(), b = event(); assert.notEqual(a.event_ref,b.event_ref); assert.equal(Object.isFrozen(a),true);
  assert.deepEqual(normalizeManagedTelemetryEvent(a),a);
  for (const changed of [{ ...a,secret: 'bearer' },{ ...a,event: 'policy_candidate',outcome: 'allowed' },{ ...a,duration_ms: -1 },{ ...a,status: 500 }]) assert.throws(() => normalizeManagedTelemetryEvent(changed));
  let getterCalls = 0;
  const getter = { ...a }; Object.defineProperty(getter,'status',{ get() { getterCalls += 1; throw new Error('must not execute'); },enumerable: true });
  assert.throws(() => normalizeManagedTelemetryEvent(getter),/must be enumerable data/);
  assert.equal(getterCalls,0);
});

test('one drainer coalesces overlap and durably acknowledges one closed sink response', async () => {
  const f = fixture(); let release; let sent = 0;
  const d = createManagedTelemetryDrainer({ store: f.store,deliver: async (value) => { sent += 1; assert.equal(Object.isFrozen(value),true); await new Promise((resolve) => { release = resolve; }); return { event_ref: value.event_ref,delivered: true }; } });
  const first = d.runOnce(); await turn(); const overlap = await d.runOnce(); assert.equal(overlap.processed,0); assert.equal(sent,1);
  release(); const result = await first; assert.equal(result.delivered,1); assert.equal(f.calls.ack,1); assert.equal(f.calls.retry,0);
  assert.equal((await d.close()).settled,true); assert.equal((await d.runOnce()).processed,0);
});

test('invalid and throwing sink replies persist one redacted retry and do not spin', async () => {
  for (const sink of [async () => { throw new Error('SECRET-DSN'); },async (e) => ({ event_ref: e.event_ref,delivered: true,secret: 'SECRET-TOKEN' })]) {
    const f = fixture(); const d = createManagedTelemetryDrainer({ store: f.store,deliver: sink });
    assert.equal((await d.runOnce()).failed,1); assert.equal(f.calls.retry,1); assert.equal(f.calls.ack,0);
    await d.runOnce(); assert.equal(f.calls.retry,1); assert.equal(JSON.stringify([...f.packets,d.health()]).includes('SECRET'),false);
    await d.close();
  }
});

test('hung sink and bounded close preserve claim; late completion never acknowledges', async () => {
  const f = fixture(); let release;
  const d = createManagedTelemetryDrainer({ store: f.store,deliveryTimeoutMs: 50,deliver: async (e) => {
    await new Promise((resolve) => { release = resolve; }); return { event_ref: e.event_ref,delivered: true };
  } });
  try {
    const result = await d.runOnce(); assert.equal(result.timed_out,1); assert.equal(result.in_flight,true);
    assert.equal((await d.runOnce()).processed,0); assert.equal(f.calls.claim,1);
    assert.equal((await d.close({ timeoutMs: 50 })).settled,false); assert.equal(f.calls.ack,0); assert.equal(f.calls.retry,0);
    release(); await turn(); assert.equal(d.health().in_flight,false); assert.equal(f.calls.ack,0); assert.equal(f.calls.retry,0);
  } finally { release?.(); }
});

test('lost acknowledgement is retained, never translated into immediate retry', async () => {
  const f = fixture(); f.store.acknowledge = async () => { throw new Error('unknown committed ack'); };
  const d = createManagedTelemetryDrainer({ store: f.store,deliver: async (e) => ({ event_ref: e.event_ref,delivered: true }) });
  assert.equal((await d.runOnce()).failed,1); assert.equal(f.calls.retry,0); assert.equal(f.packets.length,0);
  await d.close();
});

test('shutdown before the delivery deadline preserves unfinished work without claiming a timeout', async () => {
  const f = fixture(); let release;
  const d = createManagedTelemetryDrainer({ store: f.store,deliveryTimeoutMs: 5000,deliver: async (e) => {
    await new Promise((resolve) => { release = resolve; }); return { event_ref: e.event_ref,delivered: true };
  } });
  try {
    const pending = d.runOnce(); await turn(); assert.equal(typeof release,'function');
    const result = await d.close({ timeoutMs: 50 }); await pending;
    assert.equal(result.settled,false); assert.equal(result.closed,true); assert.equal(result.in_flight,true);
    assert.equal(result.timed_out,0); assert.equal(result.shutdown_interrupted,1); assert.equal(result.failed,0);
    assert.equal(f.calls.ack,0); assert.equal(f.calls.retry,0);
    release(); await turn();
    assert.equal(d.health().in_flight,false); assert.equal(d.health().timed_out,0);
    assert.equal(f.calls.ack,0); assert.equal(f.calls.retry,0); assert.equal((await d.close()).settled,true);
  } finally { release?.(); }
});

test('actual late sink settlement restores the slot for another event without acknowledging the timed-out event', async () => {
  const first = event(), second = event(), rows = [first, second], acknowledged = [];
  let release, claims = 0, sends = 0;
  const d = createManagedTelemetryDrainer({ deliveryTimeoutMs: 50, maxBatch: 1, store: {
    async claim() { const value = rows[claims++]; return value ? { event: value, generation: 1 } : null; },
    async acknowledge(value) { acknowledged.push(value.event_ref); },
    async retry() { throw new Error('must not retry a timed-out callback'); },
  }, deliver: async (value) => {
    sends += 1;
    if (value.event_ref === first.event_ref) await new Promise((resolve) => { release = resolve; });
    return { event_ref: value.event_ref, delivered: true };
  } });
  try {
    assert.equal((await d.runOnce()).timed_out, 1);
    assert.equal((await d.runOnce()).processed, 0); assert.equal(claims, 1);
    release(); await turn(); assert.equal(d.health().in_flight, false);
    assert.equal((await d.runOnce()).delivered, 1);
    assert.deepEqual(acknowledged, [second.event_ref]); assert.equal(sends, 2);
  } finally { release?.(); await d.close(); }
});
