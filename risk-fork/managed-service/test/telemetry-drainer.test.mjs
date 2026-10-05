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

function dependencyFixture(phase) {
  const first = event(), second = event(), rows = [first,second];
  const calls = { claim: 0,acknowledge: 0,retry: 0,deliver: 0 };
  let entered, release, signal;
  const ready = new Promise((resolve) => { entered = resolve; });
  const gate = new Promise((resolve) => { release = resolve; });
  async function wait(method, options) {
    if (phase !== method || calls[method] !== 1) return;
    signal = options.signal; entered(); await gate;
  }
  return { calls,ready,release,signal: () => signal,
    store: {
      async claim(options) { const row = rows[calls.claim++]; await wait('claim',options); return row ? { event: row,generation: 1 } : null; },
      async acknowledge(options) { calls.acknowledge += 1; await wait('acknowledge',options); },
      async retry(options) { calls.retry += 1; await wait('retry',options); },
    },
    async deliver(value) {
      calls.deliver += 1;
      if (phase === 'retry' && value.event_ref === first.event_ref) throw new Error('SECRET-SINK-ERROR');
      return { event_ref: value.event_ref,delivered: true };
    },
  };
}

for (const phase of ['claim','acknowledge','retry']) {
  test(`store ${phase} deadline retains its slot; only actual settlement permits another event`, async () => {
    const f = dependencyFixture(phase);
    const d = createManagedTelemetryDrainer({ store: f.store,deliver: f.deliver,storeTimeoutMs: 50,deliveryTimeoutMs: 5000,maxBatch: 1 });
    try {
      const pending = d.runOnce(); await f.ready;
      assert.equal(d.runOnce(),pending); // Active store callers coalesce, not duplicate.
      const result = await pending;
      assert.equal(result.store_timed_out,1); assert.equal(result.store_in_flight,true);
      assert.equal(result.timed_out,0); assert.equal(result.shutdown_interrupted,0);
      assert.equal(result.store_shutdown_interrupted,0); assert.equal(result.delivered,0); assert.equal(result.failed,1);
      assert.equal(f.signal().aborted,true); assert.equal(result.processed,phase === 'claim' ? 0 : 1);
      const before = { ...f.calls };
      for (let attempt = 0; attempt < 3; attempt += 1) assert.equal((await d.runOnce()).processed,0);
      assert.deepEqual(f.calls,before);
      f.release(); await turn();
      assert.equal(d.health().store_in_flight,false); assert.equal(d.health().delivered,0);
      assert.equal(f.signal().aborted,true); assert.deepEqual(f.calls,before);
      const next = await d.runOnce();
      assert.equal(next.delivered,1); assert.equal(next.store_timed_out,1); assert.equal(next.failed,1);
      assert.equal(f.calls.claim,2); assert.equal(f.calls.retry,phase === 'retry' ? 1 : 0);
      assert.equal(f.calls.acknowledge,phase === 'acknowledge' ? 2 : 1);
      assert.equal(f.calls.deliver,phase === 'claim' ? 1 : 2);
      assert.equal(Object.isFrozen(next),true); assert.equal(JSON.stringify(next).includes('SECRET'),false);
    } finally { f.release(); await d.close(); }
  });

  for (const settleBeforeClose of [false,true]) {
    test(`shutdown during store ${phase} preserves unknown work${settleBeforeClose ? ' racing same-turn settlement' : ''}`, async () => {
      const f = dependencyFixture(phase);
      const d = createManagedTelemetryDrainer({ store: f.store,deliver: f.deliver,storeTimeoutMs: 5000,deliveryTimeoutMs: 5000,maxBatch: 1 });
      try {
        const pending = d.runOnce(); await f.ready;
        const before = { ...f.calls };
        if (settleBeforeClose) f.release();
        const closed = await d.close({ timeoutMs: 50 });
        const result = await pending;
        assert.equal(closed.closed,true); assert.equal(result.store_shutdown_interrupted,1);
        assert.equal(result.store_timed_out,0); assert.equal(result.timed_out,0); assert.equal(result.shutdown_interrupted,0);
        assert.equal(result.failed,0); assert.equal(result.delivered,0); assert.equal(f.signal().aborted,true);
        assert.equal(closed.settled,settleBeforeClose);
        assert.equal(closed.store_in_flight,!settleBeforeClose);
        assert.deepEqual(f.calls,before); assert.equal((await d.runOnce()).processed,0);
        f.release(); await turn();
        assert.equal(d.health().store_in_flight,false); assert.equal(d.health().delivered,0);
        assert.deepEqual(f.calls,before); assert.equal((await d.close()).settled,true);
      } finally { f.release(); await d.close(); }
    });
  }
}

test('drainer captures original store methods with private-field receiver and mutable option references', async () => {
  const first = event(), second = event(), calls = { claim: 0,acknowledge: 0,retry: 0 };
  class Store {
    #rows = [first,second];
    #tokens = new Map();
    claim(options) {
      const row = this.#rows.shift(); calls.claim += 1;
      if (!row) return null;
      this.#tokens.set(row.event_ref,options.claimToken);
      return { event: row,generation: 1 };
    }
    acknowledge(options) { assert.equal(this.#tokens.get(options.event_ref),options.claimToken); calls.acknowledge += 1; }
    retry(options) { assert.equal(this.#tokens.get(options.event_ref),options.claimToken); calls.retry += 1; }
  }
  const store = new Store();
  const options = { store,maxBatch: 1,storeTimeoutMs: 5000,deliver: async (value) => {
    if (value.event_ref === first.event_ref) throw new Error('SECRET-FIRST-SINK');
    return { event_ref: value.event_ref,delivered: true };
  } };
  const d = createManagedTelemetryDrainer(options);
  const forbidden = () => { throw new Error('must not reread mutable methods/options'); };
  for (const method of ['claim','acknowledge','retry']) store[method] = forbidden;
  options.store = { claim: forbidden,acknowledge: forbidden,retry: forbidden }; options.deliver = forbidden; options.storeTimeoutMs = 0;
  try {
    assert.equal((await d.runOnce()).failed,1); assert.equal((await d.runOnce()).delivered,1);
    assert.deepEqual(calls,{ claim: 2,acknowledge: 1,retry: 1 });
    assert.equal(d.health().store_in_flight,false); assert.equal(d.health().store_timed_out,0);
  } finally { assert.equal((await d.close()).settled,true); }
});

test('synchronous store failures are redacted, free settled slots and never cause compensating retries', async () => {
  for (const phase of ['claim','acknowledge','retry']) {
    const value = event(), calls = { claim: 0,acknowledge: 0,retry: 0,deliver: 0 };
    const store = {
      claim() { calls.claim += 1; if (phase === 'claim') throw new Error('SECRET-CLAIM-DSN'); return { event: value,generation: 1 }; },
      acknowledge() { calls.acknowledge += 1; if (phase === 'acknowledge') throw new Error('SECRET-ACK-DSN'); },
      retry() { calls.retry += 1; if (phase === 'retry') throw new Error('SECRET-RETRY-DSN'); },
    };
    const d = createManagedTelemetryDrainer({ store,maxBatch: 1,deliver: (packet) => {
      calls.deliver += 1; if (phase === 'retry') throw new Error('SECRET-SINK');
      return { event_ref: packet.event_ref,delivered: true };
    } });
    try {
      const result = await d.runOnce();
      assert.equal(result.failed,1); assert.equal(result.delivered,0); assert.equal(result.store_in_flight,false);
      assert.equal(result.store_timed_out,0); assert.equal(result.store_shutdown_interrupted,0);
      assert.equal(calls.claim,1); assert.equal(calls.retry,phase === 'retry' ? 1 : 0);
      assert.equal(calls.acknowledge,phase === 'acknowledge' ? 1 : 0);
      assert.equal(calls.deliver,phase === 'claim' ? 0 : 1); assert.equal(JSON.stringify(result).includes('SECRET'),false);
    } finally { assert.equal((await d.close()).settled,true); }
  }
});

test('trusted store deadlines are finite bounded integers independent of sink deadlines', () => {
  for (const storeTimeoutMs of [0,49,5001,1.5,Infinity,NaN,'50']) {
    assert.throws(() => createManagedTelemetryDrainer({ store: fixture().store,deliver: async () => {},storeTimeoutMs }),TypeError);
  }
  for (const storeTimeoutMs of [50,5000]) {
    const d = createManagedTelemetryDrainer({ store: fixture().store,deliver: async () => {},storeTimeoutMs });
    assert.equal(d.health().production_qualified,false);
  }
});
