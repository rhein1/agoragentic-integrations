import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import test from 'node:test';

const drainerModule = new URL('../src/telemetry-drainer.mjs', import.meta.url).href;
const policyModule = new URL('../src/request-policy.mjs', import.meta.url).href;
const eventModule = new URL('../src/telemetry-event.mjs', import.meta.url).href;
const hostModule = new URL('../host/local-host.mjs', import.meta.url).href;
const fixtureModule = new URL('./helpers.mjs', import.meta.url).href;
const setup = `
import assert from 'node:assert/strict';
import { createManagedTelemetryDrainer } from ${JSON.stringify(drainerModule)};
import { createManagedRequestPolicy } from ${JSON.stringify(policyModule)};
import { createManagedTelemetryEvent } from ${JSON.stringify(eventModule)};
const principal = { key_id: 'key_local', tenant_id: 'tenant_local', scopes: ['invocations:write'] };
const policy = (overrides) => createManagedRequestPolicy({
  readControl: async () => ({ enabled: true, epoch: 1 }),
  consumeRateLimit: async () => ({ allowed: true, retry_after_seconds: 0 }),
  ...overrides,
});
const event = createManagedTelemetryEvent({ event: 'rate_denied', route_class: 'admission', status: 429,
  outcome: 'rate_limited', duration_ms: 0, tenant_hash: 'sha256:' + 'a'.repeat(64), key_hash: 'sha256:' + 'b'.repeat(64) });
const tick = () => new Promise((resolve) => setImmediate(resolve));
`;

// Parent test-runner handles cannot rescue the child. Each program deliberately
// has no server, keep-alive timer, IPC channel or unresolved I/O to retain Node.
function standalone(program, timeout = 4000) {
  const result = spawnSync(process.execPath, ['--input-type=module', '--eval', setup + program], {
    encoding: 'utf8', windowsHide: true, timeout,
  });
  assert.equal(result.error, undefined, result.error?.message);
  assert.equal(result.signal, null, result.stderr);
  assert.equal(result.status, 0, result.stderr || 'Standalone bounded wait did not settle');
  assert.equal(result.stdout.trim(), 'completed');
}

test('standalone drainer delivery timeout retains the claim and never late-acknowledges', () => {
  standalone(`
let release, claimed = false, acknowledgements = 0, retries = 0;
const d = createManagedTelemetryDrainer({ deliveryTimeoutMs: 50, store: {
  async claim() { if (claimed) return null; claimed = true; return { event, generation: 1 }; },
  async acknowledge() { acknowledgements += 1; }, async retry() { retries += 1; },
}, deliver: async () => {
  await new Promise((resolve) => { release = resolve; });
  return { event_ref: event.event_ref, delivered: true };
} });
const result = await d.runOnce();
assert.equal(result.timed_out, 1); assert.equal(result.in_flight, true);
assert.equal((await d.close({ timeoutMs: 50 })).settled, false);
assert.equal(acknowledgements, 0); assert.equal(retries, 0);
release(); await tick();
assert.equal((await d.close()).settled, true);
assert.equal(acknowledgements, 0); assert.equal(retries, 0);
console.log('completed');
`);
});

test('standalone drainer close is bounded while a store claim ignores abort', () => {
  standalone(`
let entered, release, deliveries = 0;
const ready = new Promise((resolve) => { entered = resolve; });
const d = createManagedTelemetryDrainer({ store: {
  async claim() { entered(); await new Promise((resolve) => { release = resolve; }); return { event, generation: 1 }; },
  async acknowledge() { throw new Error('late acknowledgement'); }, async retry() { throw new Error('late retry'); },
}, deliver: async () => { deliveries += 1; } });
const pending = d.runOnce(); await ready;
assert.equal((await d.close({ timeoutMs: 50 })).settled, false);
release(); await pending;
assert.equal(deliveries, 0); assert.equal((await d.close()).settled, true);
console.log('completed');
`);
});

for (const phase of ['claim', 'acknowledge', 'retry']) {
  test(`standalone drainer bounds a hung store ${phase} without late follow-up`, () => {
    standalone(`
const phase = ${JSON.stringify(phase)};
let release, operationSignal;
const calls = { claim: 0, acknowledge: 0, retry: 0, deliver: 0 };
async function gate(options) {
  operationSignal = options.signal;
  await new Promise((resolve) => { release = resolve; });
}
const d = createManagedTelemetryDrainer({ deliveryTimeoutMs: 50, maxBatch: 1, store: {
  async claim(options) { calls.claim += 1; if (phase === 'claim') await gate(options); return { event, generation: 1 }; },
  async acknowledge(options) { calls.acknowledge += 1; if (phase === 'acknowledge') await gate(options); },
  async retry(options) { calls.retry += 1; if (phase === 'retry') await gate(options); },
}, deliver: async (packet) => {
  calls.deliver += 1;
  if (phase === 'retry') throw new Error('SECRET-SINK-ERROR');
  return { event_ref: packet.event_ref, delivered: true };
} });
const result = await d.runOnce();
assert.equal(result.store_timed_out, 1); assert.equal(result.store_in_flight, true);
assert.equal(result.timed_out, 0); assert.equal(result.delivered, 0); assert.equal(result.failed, 1);
assert.equal(operationSignal.aborted, true);
assert.equal(result.processed, phase === 'claim' ? 0 : 1);
const before = { ...calls };
assert.equal((await d.runOnce()).processed, 0); assert.deepEqual(calls, before);
assert.equal((await d.close({ timeoutMs: 50 })).settled, false);
release(); await tick();
assert.equal(d.health().store_in_flight, false); assert.equal(d.health().delivered, 0);
assert.deepEqual(calls, before); assert.equal(JSON.stringify(d.health()).includes('SECRET'), false);
assert.equal((await d.close()).settled, true);
console.log('completed');
`);
  });
}

test('standalone durable admission timeout grants no decision and retains actual recording work', () => {
  standalone(`
let release;
const p = policy({ telemetryTimeoutMs: 100, recordTelemetry: async (packet) => {
  await new Promise((resolve) => { release = resolve; }); return { event_ref: packet.event_ref, persisted: true };
} });
await assert.rejects(p.beforeMutation({ principal, routeClass: 'admission' }), { code: 'POLICY_TELEMETRY_UNAVAILABLE' });
assert.equal(p.telemetryHealth().in_flight, 1);
assert.equal((await p.flushTelemetry({ timeoutMs: 100 })).settled, false);
release(); await tick();
assert.equal((await p.flushTelemetry()).settled, true);
assert.equal(p.telemetryHealth().recorded, 1);
console.log('completed');
`);
});

test('standalone best-effort flush is bounded without terminating the emitter', () => {
  standalone(`
let release;
const p = policy({ emitTelemetry: async () => new Promise((resolve) => { release = resolve; }) });
await p.beforeMutation({ principal, routeClass: 'read' });
assert.equal((await p.flushTelemetry({ timeoutMs: 100 })).settled, false);
assert.equal(p.telemetryHealth().in_flight, 1);
release(); await tick(); assert.equal((await p.flushTelemetry()).settled, true);
console.log('completed');
`);
});

test('standalone dispatch fence times out rather than granting a stale decision', () => {
  standalone(`
let reads = 0;
const p = policy({ emitTelemetry: async () => {},
  readControl: async () => ++reads <= 2 ? { enabled: true, epoch: 1 } : new Promise(() => {}) });
const decision = await p.beforeMutation({ principal, routeClass: 'execution' });
const fence = p.createDispatchFence(decision, { principal, invocationRef: 'invocation_1', timeoutMs: 100 });
await assert.rejects(fence({ invocationRef: 'invocation_1' }), { code: 'REQUEST_TIMEOUT' });
console.log('completed');
`);
});

test('noncritical recording and idle polling do not keep a standalone process alive', () => {
  standalone(`
const p = policy({ telemetryTimeoutMs: 5000, recordTelemetry: async () => new Promise(() => {}) });
await p.beforeMutation({ principal, routeClass: 'cleanup' });
const d = createManagedTelemetryDrainer({ store: { async claim() { return null; }, async acknowledge() {}, async retry() {} }, deliver: async () => {} });
d.start();
console.log('completed');
`, 3000);
});

test('settled operations dispose long deadlines rather than delaying process exit', () => {
  standalone(`
const p = policy({ emitTelemetry: async () => {} });
const decision = await p.beforeMutation({ principal, routeClass: 'execution' });
await p.createDispatchFence(decision, { principal, invocationRef: 'invocation_1', timeoutMs: 30000 })({ invocationRef: 'invocation_1' });
assert.equal((await p.flushTelemetry({ timeoutMs: 30000 })).settled, true);
const d = createManagedTelemetryDrainer({ deliveryTimeoutMs: 5000, maxBatch: 1, store: {
  async claim() { return { event, generation: 1 }; }, async acknowledge() {}, async retry() {},
}, deliver: async (packet) => ({ event_ref: packet.event_ref, delivered: true }) });
assert.equal((await d.runOnce()).delivered, 1);
assert.equal((await d.close({ timeoutMs: 30000 })).settled, true);
console.log('completed');
`, 3000);
});

test('closed local host bounds hung policy reads and fences late successful policy continuations', () => {
  for (const timeout of [true, false]) standalone(`
const { createManagedRiskForkLocalHost } = await import(${JSON.stringify(hostModule)});
const { createFixture } = await import(${JSON.stringify(fixtureModule)});
const fixture = await createFixture();
let entered, release, providerCalls = 0;
const ready = new Promise((resolve) => { entered = resolve; });
const gate = new Promise((resolve) => { release = resolve; });
const p = policy({ readControl: async () => { entered(); await gate; return { enabled: true, epoch: 1 }; }, emitTelemetry: async () => {} });
const host = createManagedRiskForkLocalHost({
  enabled: true, controlPlane: fixture.controlPlane, publicAuthenticator: fixture.authenticator,
  workerAuthenticator: fixture.authenticator, providerRegistry: fixture.providerRegistry,
  executionPrincipal: fixture.principal, cleanupPrincipal: fixture.sameTenantPrincipal,
  recoveryPrincipal: fixture.recoveryPrincipal, workerId: 'worker:deadline-test',
  deliveryStore: { async insert() {}, async get() {}, async acknowledge() {}, async listPending() { return []; } },
  deliveryEncryptionKey: Buffer.alloc(32, 0x61), deliveryKeyId: 'key:deadline-test', deliveryNamespace: 'ns:deadline-test',
  deadlineMs: 100, requestPolicy: p, workerOptions: {
    loadPrepareInput: async () => ({ operation: {} }), invokeProvider: async () => { providerCalls += 1; },
    lookupResources: async () => ({ savepoint_ref: null, fork_ref: null, absent_resource_kinds: [] }), measureCostMicros: async () => 0,
  },
});
await host.start();
const rejected = assert.rejects(host.execute('missing'), { code: ${JSON.stringify(timeout ? 'REQUEST_TIMEOUT' : 'HOST_DISABLED')} });
await ready; await host.close();
if (!${timeout}) release();
await rejected;
assert.equal(providerCalls, 0); assert.equal(host.health().closed, true);
console.log('completed');
`);
});
