import assert from 'node:assert/strict';
import test from 'node:test';
import { createManagedRequestPolicy } from '../src/request-policy.mjs';

const p = { key_id: 'key_1', tenant_id: 'tenant_1', scopes: ['invocations:write'] };
function policy(overrides = {}) {
  let epoch = 1;
  const events = [];
  const value = createManagedRequestPolicy({
    readControl: async () => ({ enabled: true, epoch }),
    consumeRateLimit: async () => ({ allowed: true, retry_after_seconds: 0 }),
    emitTelemetry: async (event) => events.push(event),
    ...overrides,
  });
  return { value, events, setEpoch: (next) => { epoch = next; } };
}

test('allows normal requests and emits only hashed identity fields', async () => {
  const f = policy(); const result = await f.value.beforeMutation({ principal: p, routeClass: 'admission' });
  assert.equal(result.epoch, 1); assert.equal(f.events.at(-1).outcome, 'allowed');
  assert.match(f.events.at(-1).tenant_hash, /^sha256:/); assert.equal('tenant_id' in f.events.at(-1), false);
});

test('disabled control blocks admission/execution but permits cleanup/recovery/read', async () => {
  const f = policy({ readControl: async () => ({ enabled: false, epoch: 1 }) });
  for (const routeClass of ['admission', 'execution']) await assert.rejects(f.value.beforeMutation({ principal: p, routeClass }), { code: 'MANAGED_SERVICE_DISABLED' });
  for (const routeClass of ['cleanup', 'recovery', 'read']) await f.value.beforeMutation({ principal: p, routeClass });
});

test('current control disable at the second read also blocks admission', async () => {
  let reads = 0;
  const f = policy({ readControl: async () => ({ enabled: ++reads === 1, epoch: 1 }) });
  await assert.rejects(f.value.beforeMutation({ principal: p, routeClass: 'admission' }), { code: 'MANAGED_SERVICE_DISABLED' });
});

test('rechecks epoch after rate await and fails closed', async () => {
  let enter; let release; const entered = new Promise((resolve) => { enter = resolve; }); const wait = new Promise((resolve) => { release = resolve; });
  const f = policy({ consumeRateLimit: async () => { enter(); await wait; return { allowed: true, retry_after_seconds: 0 }; } });
  const pending = f.value.beforeMutation({ principal: p, routeClass: 'admission' });
  const assertion = assert.rejects(pending, { code: 'POLICY_EPOCH_CHANGED' });
  await entered; f.setEpoch(2); release(); await assertion;
});

test('rate exhaustion returns bounded retry and callback errors fail closed', async () => {
  const limited = policy({ consumeRateLimit: async () => ({ allowed: false, retry_after_seconds: 7 }) });
  await assert.rejects(limited.value.beforeMutation({ principal: p, routeClass: 'admission' }), (e) => e.code === 'RATE_LIMITED' && e.retry_after_seconds === 7);
  const broken = policy({ consumeRateLimit: async () => { throw new Error('secret bearer'); } });
  await assert.rejects(broken.value.beforeMutation({ principal: p, routeClass: 'admission' }), { code: 'RATE_LIMIT_UNAVAILABLE' });
  const forgedTimeout = policy({ consumeRateLimit: async () => { const error = new Error('secret timeout'); error.code = 'REQUEST_TIMEOUT'; throw error; } });
  await assert.rejects(forgedTimeout.value.beforeMutation({ principal: p, routeClass: 'admission' }), (error) => error.code === 'REQUEST_TIMEOUT' && error.message === 'Request deadline expired');
});

test('invalid callback results and deadlines fail closed', async () => {
  await assert.rejects(policy({ readControl: async () => ({ enabled: true, epoch: -1 }) }).value.beforeMutation({ principal: p, routeClass: 'read' }), { code: 'POLICY_UNAVAILABLE' });
  const abort = new AbortController(); abort.abort();
  await assert.rejects(policy().value.beforeMutation({ principal: p, routeClass: 'read', signal: abort.signal }), { code: 'REQUEST_TIMEOUT' });
});

test('overlapping best-effort events queue behind one sink; rejection does not lose the next event', async () => {
  let calls = 0; let release;
  const pending = new Promise((resolve) => { release = resolve; });
  const f = policy({ emitTelemetry: async () => { calls += 1; await pending; throw new Error('observer secret'); } });
  await f.value.beforeMutation({ principal: p, routeClass: 'read' });
  await f.value.beforeMutation({ principal: p, routeClass: 'read' });
  assert.equal(calls, 1); assert.equal(f.value.telemetryHealth().queued, 1); release();
  assert.equal((await f.value.flushTelemetry()).settled, true); assert.equal(calls, 2);
  const throwing = policy({ emitTelemetry: async () => { throw new Error('observer secret'); } });
  await throwing.value.beforeMutation({ principal: p, routeClass: 'read' });
});

test('abort races hung host callbacks and passes the signal without retaining listeners', async () => {
  let observedSignal;
  const pending = new Promise(() => {});
  const f = policy({
    readControl: async (signal) => { observedSignal = signal; return pending; },
  });
  const abort = new AbortController();
  const assertion = assert.rejects(f.value.beforeMutation({ principal: p, routeClass: 'read', signal: abort.signal }), { code: 'REQUEST_TIMEOUT' });
  await Promise.resolve(); abort.abort(); await assertion; assert.equal(observedSignal, abort.signal);
  const rate = policy({ consumeRateLimit: async ({ signal }) => { observedSignal = signal; return pending; } });
  const second = new AbortController();
  const secondAssertion = assert.rejects(rate.value.beforeMutation({ principal: p, routeClass: 'read', signal: second.signal }), { code: 'REQUEST_TIMEOUT' });
  for (let i = 0; i < 10 && observedSignal !== second.signal; i += 1) await new Promise((resolve) => setImmediate(resolve));
  assert.equal(observedSignal, second.signal); second.abort(); await secondAssertion;
});

test('synchronous abort plus callback rejection is observed for control and rate callbacks', async () => {
  const unhandled = [];
  const onUnhandled = (reason) => unhandled.push(reason);
  process.on('unhandledRejection', onUnhandled);
  try {
    const controlAbort = new AbortController();
    const controlPolicy = policy({ readControl: async () => { controlAbort.abort(); return Promise.reject(new Error('private control')); } });
    await assert.rejects(controlPolicy.value.beforeMutation({ principal: p, routeClass: 'read', signal: controlAbort.signal }), { code: 'REQUEST_TIMEOUT' });
    const rateAbort = new AbortController();
    const ratePolicy = policy({ consumeRateLimit: async () => { rateAbort.abort(); return Promise.reject(new Error('private rate')); } });
    await assert.rejects(ratePolicy.value.beforeMutation({ principal: p, routeClass: 'read', signal: rateAbort.signal }), { code: 'REQUEST_TIMEOUT' });
    await new Promise((resolve) => setTimeout(resolve, 25));
    assert.deepEqual(unhandled, []);
  } finally { process.off('unhandledRejection', onUnhandled); }
});

test('dispatch decisions are original, instance/principal/route bound and single-use', async () => {
  const f = policy();
  const options = { principal: p, invocationRef: 'invocation_1' };
  const ticket = await f.value.beforeMutation({ principal: p, routeClass: 'execution' });
  for (const forged of [{ ...ticket }, JSON.parse(JSON.stringify(ticket)), undefined]) {
    assert.throws(() => f.value.createDispatchFence(forged, options), { code: 'POLICY_DECISION_INVALID' });
  }
  assert.throws(() => policy().value.createDispatchFence(ticket, options), { code: 'POLICY_DECISION_INVALID' });
  for (const other of [{ ...p, key_id: 'key_2' }, { ...p, tenant_id: 'tenant_2' }]) {
    assert.throws(() => f.value.createDispatchFence(ticket, { ...options, principal: other }), { code: 'POLICY_DECISION_INVALID' });
  }
  const read = await f.value.beforeMutation({ principal: p, routeClass: 'read' });
  assert.throws(() => f.value.createDispatchFence(read, options), { code: 'POLICY_DECISION_INVALID' });
  const fence = f.value.createDispatchFence(ticket, options);
  assert.throws(() => f.value.createDispatchFence(ticket, { ...options, invocationRef: 'invocation_2' }), { code: 'POLICY_DECISION_INVALID' });
  await assert.rejects(fence({ invocationRef: 'invocation_2' }), { code: 'POLICY_DECISION_INVALID' });
  await fence({ invocationRef: 'invocation_1' });
});

test('dispatch fences detect disable/re-enable epoch drift and do not charge quota', async () => {
  let enabled = true; let epoch = 1; let rateCalls = 0;
  const f = policy({ readControl: async () => ({ enabled, epoch }),
    consumeRateLimit: async () => { rateCalls += 1; return { allowed: true, retry_after_seconds: 0 }; } });
  const ticket = await f.value.beforeMutation({ principal: p, routeClass: 'execution' });
  const fence = f.value.createDispatchFence(ticket, { principal: p, invocationRef: 'invocation_1' });
  await fence({ invocationRef: 'invocation_1' });
  enabled = false; epoch = 2;
  await assert.rejects(fence({ invocationRef: 'invocation_1' }), { code: 'MANAGED_SERVICE_DISABLED' });
  enabled = true; epoch = 3;
  await assert.rejects(fence({ invocationRef: 'invocation_1' }), { code: 'POLICY_EPOCH_CHANGED' });
  assert.equal(rateCalls, 1);
});

test('dispatch policy failures and hanging reads are bounded and redacted', async () => {
  let fail = false;
  const f = policy({ readControl: async () => { if (fail) throw new Error('private policy detail'); return { enabled: true, epoch: 1 }; } });
  const fence = f.value.createDispatchFence(await f.value.beforeMutation({ principal: p, routeClass: 'execution' }),
    { principal: p, invocationRef: 'invocation_1', timeoutMs: 100 });
  fail = true;
  await assert.rejects(fence({ invocationRef: 'invocation_1' }), (error) => error.code === 'POLICY_UNAVAILABLE' && !error.message.includes('private'));
  let reads = 0;
  const hung = policy({ readControl: async () => ++reads <= 2 ? { enabled: true, epoch: 1 } : new Promise(() => {}) });
  const bounded = hung.value.createDispatchFence(await hung.value.beforeMutation({ principal: p, routeClass: 'execution' }),
    { principal: p, invocationRef: 'invocation_1', timeoutMs: 100 });
  // AbortSignal.timeout is unref'ed: retain a test-only timer while observing it.
  const keepAlive = setTimeout(() => {}, 1000);
  try { await assert.rejects(bounded({ invocationRef: 'invocation_1' }), { code: 'REQUEST_TIMEOUT' }); }
  finally { clearTimeout(keepAlive); }
});
