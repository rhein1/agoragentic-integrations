import test from 'node:test';
import assert from 'node:assert/strict';
import { setTimeout as delay } from 'node:timers/promises';
import { sha256Ref } from '../../src/canonical.mjs';
import { createObserverDiagnostic } from '../src/observer-diagnostic.mjs';
import { createManagedBacklogObserver } from '../src/backlog-observer.mjs';
import { createManagedLifecycleObserver } from '../src/lifecycle-observer.mjs';
import { DIAGNOSTIC_BOUNDARIES } from '../src/diagnostic-event.mjs';
import { lifecycleTenantHash } from '../src/lifecycle-event.mjs';
import { createFixture, invocationRequest } from './helpers.mjs';

const settings = { bucket_ms: 1000,max_age_ms: 60000,max_future_ms: 1000,
  rules: [{ rule_id: 'observer_backlog_source_read_unconfirmed',threshold: 2,window_ms: 60000 }] };
const principal = (tenant_id = 'tenant_alpha') => Object.freeze({ tenant_id,scopes: Object.freeze(['audit:read']) });
const ack = (event) => ({ event_ref: event.event_ref,persisted: true });
test('all private phases emit only closed diagnostic packets and validate exact acknowledgement', async () => {
  const stop = new AbortController(), packets = []; let touches = 0, valid = true;
  const reason = new Proxy({}, { get() { touches++; throw new Error('SECRET'); } });
  const store = { async appendDiagnosticObservation(event) { packets.push(event); if (!valid) throw reason; return ack(event); } };
  const diagnostic = createObserverDiagnostic({ store,diagnosticSettings: settings,diagnosticClock: () => 1234 },sha256Ref('observer'),stop.signal);
  for (const boundary of DIAGNOSTIC_BOUNDARIES) await diagnostic.record(sha256Ref('tenant'),boundary);
  assert.deepEqual(packets.map((event) => event.boundary),DIAGNOSTIC_BOUNDARIES);
  assert.equal(diagnostic.health().recorded,8); assert.equal(touches,0);
  valid = false; await diagnostic.record(sha256Ref('tenant'),'audit_window_read');
  assert.equal(diagnostic.health().recorded,8); assert.equal(diagnostic.health().failed,1); assert.equal(touches,0);
  for (const response of [{ persisted: false },{ event_ref: 'bad',persisted: true },{ ...ack(packets[0]),extra: 'SECRET' }]) {
    const d = createObserverDiagnostic({ store: { async appendDiagnosticObservation() { return response; } },diagnosticSettings: settings,diagnosticClock: () => 1234 },sha256Ref('observer'),stop.signal);
    await d.record(sha256Ref('tenant'),'audit_window_read'); assert.equal(d.health().recorded,0); assert.equal(d.health().failed,1);
  }
});
test('recording is default-off, captures host methods/config and rejects clock regression without recursive records', async () => {
  const stop = new AbortController(), packets = [], store = { async appendDiagnosticObservation(event) { packets.push(event); return ack(event); } };
  const disabled = createObserverDiagnostic({ store },sha256Ref('observer'),stop.signal);
  await disabled.record(sha256Ref('tenant'),'backlog_source_read'); assert.equal(packets.length,0); assert.equal(disabled.health().enabled,false);
  assert.throws(() => createObserverDiagnostic({ store,diagnosticClock: Date.now },sha256Ref('observer'),stop.signal));
  let now = 1234;
  const original = { ...settings,rules: settings.rules.map((rule) => ({ ...rule })) };
  const options = { store,diagnosticSettings: original,diagnosticClock: () => now };
  const d = createObserverDiagnostic(options,sha256Ref('observer'),stop.signal);
  options.diagnosticClock = () => 999999; store.appendDiagnosticObservation = () => { throw new Error('replacement must not run'); };
  original.bucket_ms = 60000; original.rules[0].threshold = 999;
  await d.record(sha256Ref('tenant'),'backlog_source_read'); now = 1233; await d.record(sha256Ref('tenant'),'backlog_source_read');
  assert.equal(packets.length,1); assert.equal(packets[0].bucket_start_ms,1000); assert.equal(d.health().failed,1);
  stop.abort(); await d.record(sha256Ref('tenant'),'backlog_source_read'); assert.equal(packets.length,1);
});
test('both actual observers use opt-in diagnostics; original failure remains unconfirmed on recorder outage', async () => {
  for (const factory of [createManagedBacklogObserver,createManagedLifecycleObserver]) {
    let calls = 0,touches = 0;
    const reason = new Proxy({}, { get() { touches++; throw new Error('SECRET'); } });
    const store = { readBacklogGauge: async () => { throw reason; },appendBacklogSnapshot: async () => {},
      readLifecycleSweep: async () => { throw reason; },readLifecycleCheckpoint: async () => {},appendLifecycleWindow: async () => {},
      async appendDiagnosticObservation() { calls++; throw reason; } };
    const observer = factory({ store,controlPlane: { readCleanupRecoveryBacklog: async () => {},listAuditInvocations: async () => {},readAuditWindow: async () => {} },
      auditPrincipals: [principal()],observerId: 'diagnostic-observer',diagnosticSettings: settings,diagnosticClock: () => 1234 });
    try {
      const health = await observer.runOnce(); assert.equal(health.failed,1); assert.equal(health.diagnostics.failed,1);
      assert.equal(health.diagnostics.recorded,0); assert.equal(calls,1); assert.equal(touches,0);
    } finally { assert.equal((await observer.close()).settled,true); }
  }
});
test('hung diagnostic retains tenant ownership, allows another tenant and rejects late success after shutdown', async () => {
  let release,firstEvent,blockedSignal,calls = 0;
  const alpha = lifecycleTenantHash('tenant_alpha');
  const observer = createManagedBacklogObserver({ auditPrincipals: [principal(),principal('tenant_beta')],observerId: 'bounded',
    diagnosticSettings: settings,diagnosticClock: () => 1234,diagnosticTimeoutMs: 50,timeoutMs: 50,maxTenantsPerTick: 1,
    controlPlane: { async readCleanupRecoveryBacklog() {} },store: { async readBacklogGauge() { throw null; },async appendBacklogSnapshot() {},
      appendDiagnosticObservation(event,{ signal }) {
        calls++; if (event.tenant_hash !== alpha) return Promise.resolve(ack(event));
        firstEvent = event; blockedSignal = signal; return new Promise((resolve) => { release = resolve; });
      } } });
  try {
    const first = await observer.runOnce(); assert.equal(first.diagnostics.timed_out,1); assert.equal(first.diagnostics.in_flight,1); assert.equal(blockedSignal.aborted,true);
    const second = await observer.runOnce(); assert.equal(second.diagnostics.recorded,1); assert.equal(calls,2);
    await observer.runOnce(); assert.equal(calls,3,'hung alpha is skipped; beta keeps progressing');
    assert.equal((await observer.close({ timeoutMs: 50 })).settled,false);
    release(ack(firstEvent)); await delay(0); const late = observer.health();
    assert.equal(late.diagnostics.in_flight,0); assert.equal(late.diagnostics.recorded,2); assert.equal(late.diagnostics.failed,1);
    assert.equal((await observer.close()).settled,true);
  } finally { release?.(null); await observer.close(); }
});
test('shutdown during diagnostic wait never counts cancellation as a recorder failure or success', async () => {
  const stop = new AbortController(); let release;
  const d = createObserverDiagnostic({ store: { appendDiagnosticObservation() { return new Promise((resolve) => { release = resolve; }); } },
    diagnosticSettings: settings,diagnosticTimeoutMs: 50,diagnosticClock: () => 1234 },sha256Ref('observer'),stop.signal);
  const pending = d.record(sha256Ref('tenant'),'backlog_source_read'); await delay(0); stop.abort(); await pending;
  assert.equal(d.health().failed,0); assert.equal(d.health().recorded,0); assert.equal(d.health().in_flight,1);
  release({ persisted: true }); await delay(0); assert.equal(d.health().in_flight,0); assert.equal(d.health().failed,0);
});
test('every actual observer dispatch phase records its own failure, never unvisited phases or error properties', async () => {
  const methods = { backlog_gauge_read: 'readBacklogGauge',backlog_source_read: 'readCleanupRecoveryBacklog',backlog_snapshot_append: 'appendBacklogSnapshot',
    lifecycle_sweep_read: 'readLifecycleSweep',audit_invocations_read: 'listAuditInvocations',lifecycle_checkpoint_read: 'readLifecycleCheckpoint',
    audit_window_read: 'readAuditWindow',lifecycle_window_append: 'appendLifecycleWindow' };
  for (const boundary of DIAGNOSTIC_BOUNDARIES) {
    const f = await createFixture(); await f.controlPlane.admitInvocation(f.principal,invocationRequest({ estimated_cost_micros: 0 }));
    const source = { readCleanupRecoveryBacklog: (...args) => f.controlPlane.readCleanupRecoveryBacklog(...args),
      listAuditInvocations: (...args) => f.controlPlane.listAuditInvocations(...args),readAuditWindow: (...args) => f.controlPlane.readAuditWindow(...args) };
    const packets = []; let touches = 0;
    const store = { async readBacklogGauge() { return null; },async appendBacklogSnapshot() {},
      async readLifecycleSweep() { return null; },async readLifecycleCheckpoint() { return null; },async appendLifecycleWindow() {},
      async appendDiagnosticObservation(event) { packets.push(event); return ack(event); } };
    const owner = ['backlog_source_read','audit_invocations_read','audit_window_read'].includes(boundary) ? source : store;
    owner[methods[boundary]] = () => { throw new Proxy({}, { get() { touches++; throw new Error('SECRET'); } }); };
    const factory = boundary.startsWith('backlog_') ? createManagedBacklogObserver : createManagedLifecycleObserver;
    const observer = factory({ store,controlPlane: source,auditPrincipals: [f.principal],observerId: boundary,diagnosticSettings: settings,diagnosticClock: () => 1234 });
    try {
      const health = await observer.runOnce(); assert.equal(health.failed,1); assert.equal(health.diagnostics.recorded,1);
      assert.deepEqual(packets.map((event) => event.boundary),[boundary]); assert.equal(touches,0);
    } finally { await observer.close(); }
  }
});
test('malformed resolved lifecycle page/window is classified before dispatching append', async () => {
  for (const boundary of ['audit_invocations_read','audit_window_read']) {
    const f = await createFixture(); await f.controlPlane.admitInvocation(f.principal,invocationRequest({ estimated_cost_micros: 0 }));
    const packets = []; let appends = 0;
    const observer = createManagedLifecycleObserver({ auditPrincipals: [f.principal],observerId: boundary,diagnosticSettings: settings,diagnosticClock: () => 1234,
      controlPlane: { listAuditInvocations: (...args) => boundary === 'audit_invocations_read' ? { invocations: [] } : f.controlPlane.listAuditInvocations(...args),
        readAuditWindow: () => ({ events: [] }) },store: { async readLifecycleSweep() { return null; },async readLifecycleCheckpoint() { return null; },
        async appendLifecycleWindow() { appends++; throw new Error('malformed source was dispatched'); },
        async appendDiagnosticObservation(event) { packets.push(event); return ack(event); } } });
    try {
      const health = await observer.runOnce(); assert.deepEqual(packets.map((event) => event.boundary),[boundary]);
      assert.equal(health.failure_counts[boundary],1); assert.equal(appends,0);
    } finally { await observer.close(); }
  }
});
