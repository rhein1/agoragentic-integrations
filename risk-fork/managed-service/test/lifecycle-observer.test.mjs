import test from 'node:test';
import assert from 'node:assert/strict';
import { sha256Ref } from '../../src/canonical.mjs';
import { createManagedLifecycleObserver } from '../src/lifecycle-observer.mjs';
import { normalizeManagedLifecycleEvent, projectManagedLifecycleEvent } from '../src/lifecycle-event.mjs';
import { normalizeManagedTelemetryEvent } from '../src/telemetry-event.mjs';
import { createManagedTelemetryDrainer } from '../src/telemetry-drainer.mjs';
import { createManagedAuditEvent } from '../src/audit.mjs';
import { createFixture, invocationRequest } from './helpers.mjs';

const turn = () => new Promise((resolve) => setImmediate(resolve));
const boundaries = ['lifecycle_sweep_read','audit_invocations_read','lifecycle_checkpoint_read','audit_window_read','lifecycle_window_append'];
const countsAt = (boundary) => Object.fromEntries(boundaries.map((key) => [key,Number(key === boundary)]));
const methods = { lifecycle_sweep_read: 'readLifecycleSweep',audit_invocations_read: 'listAuditInvocations',
  lifecycle_checkpoint_read: 'readLifecycleCheckpoint',audit_window_read: 'readAuditWindow',lifecycle_window_append: 'appendLifecycleWindow' };
const isSourceBoundary = (boundary) => ['audit_invocations_read','audit_window_read'].includes(boundary);
function recordingStore() {
  const packets = [];
  return { packets,async readLifecycleSweep() { return null; },async readLifecycleCheckpoint() { return null; },
    async appendLifecycleWindow(value) { packets.push(value); return { persisted: true,projected: value.window?.events.length ?? 0 }; } };
}
async function admitted() {
  const f = await createFixture();
  await f.controlPlane.admitInvocation(f.principal,invocationRequest({ estimated_cost_micros: 0 }));
  await f.controlPlane.admitInvocation(f.otherPrincipal,invocationRequest({ estimated_cost_micros: 0 }));
  return f;
}

test('lifecycle observations preserve source labels but never manufacture success or expose source payloads', () => {
  const source = createManagedAuditEvent({ event_ref: 'source_event',tenant_id: 'tenant_alpha',invocation_ref: 'rfi_alpha',
    sequence: 1,event_type: 'execution_outcome_recorded',occurred_at: '2026-09-05T12:00:00.000Z',details: { token: 'SECRET',actual_cost: 10 } });
  const packet = projectManagedLifecycleEvent(source);
  assert.deepEqual(projectManagedLifecycleEvent(source),packet);
  assert.deepEqual(normalizeManagedLifecycleEvent(packet),packet);
  assert.equal(packet.event,'control_plane_audit_observed');
  assert.equal(packet.evidence_class,'control_plane_self_attested');
  assert.equal(Object.isFrozen(packet),true);
  assert.equal(/SECRET|rfi_alpha|tenant_alpha|actual_cost/.test(JSON.stringify(packet)),false);
  for (const changed of [{ ...packet,details: {} },{ ...packet,event: 'provider_succeeded' },{ ...packet,source_sequence: 0 },{ ...packet,event_ref: `evt_${'a'.repeat(48)}` }]) assert.throws(() => normalizeManagedLifecycleEvent(changed));
  assert.throws(() => normalizeManagedTelemetryEvent(packet));
  assert.throws(() => projectManagedLifecycleEvent({ ...source,event_type: 'unknown_provider_success' }));
});

test('original-owner cancellation projects its audit label without exporting cancellation authority or details', async () => {
  const f = await createFixture();
  const { invocation } = await f.controlPlane.admitInvocation(f.principal,invocationRequest());
  const reasonHash = sha256Ref('synthetic private cancellation reason');
  const request = { invocation_ref: invocation.invocation_ref,idempotency_key: 'observer-cancellation-regression',reason_hash: reasonHash };
  await f.controlPlane.requestCancellation(f.principal,request);
  await f.controlPlane.requestCancellation(f.principal,request);
  const window = await f.controlPlane.readAuditWindow(f.principal,invocation.invocation_ref,{ limit: 64 });
  assert.deepEqual(window.events.map((event) => event.event_type),['invocation_admitted','cancellation_requested']);
  const packets = window.events.map(projectManagedLifecycleEvent);
  const cancellation = packets[1];
  assert.deepEqual(normalizeManagedLifecycleEvent(cancellation),cancellation);
  assert.equal(cancellation.source_sequence,2);
  assert.equal(cancellation.evidence_class,'control_plane_self_attested');
  assert.equal(cancellation.source_event_type,'cancellation_requested');
  for (const privateValue of [reasonHash,request.idempotency_key,f.principal.key_id,invocation.invocation_ref,
    invocation.provider_recovery_key,'bounded input']) assert.equal(JSON.stringify(packets).includes(privateValue),false);
  assert.throws(() => projectManagedLifecycleEvent({ ...window.events[1],event_type: 'cancellation_completed' }));
  assert.throws(() => normalizeManagedLifecycleEvent({ ...cancellation,termination_proven: true }));
});

test('hung tenant retains its slot; another tenant progresses and late read cannot append', async () => {
  const f = await admitted(), store = recordingStore(); let release, alphaReads = 0;
  const source = { ...f.controlPlane,async listAuditInvocations(principal,request) {
    if (principal === f.principal) { alphaReads += 1; await new Promise((resolve) => { release = resolve; }); }
    return f.controlPlane.listAuditInvocations(principal,request);
  } };
  const observer = createManagedLifecycleObserver({ controlPlane: source,store,auditPrincipals: [f.principal,f.otherPrincipal],
    observerId: 'stable_observer',timeoutMs: 50,maxTenantsPerTick: 1 });
  try {
    assert.equal((await observer.runOnce()).timed_out,1);
    assert.equal(observer.health().in_flight,1);
    assert.equal((await observer.runOnce()).recorded,1);
    assert.equal(alphaReads,1); assert.equal(store.packets.length,1);
    assert.equal(store.packets[0].tenant_id,'tenant_other');
    assert.equal((await observer.close({ timeoutMs: 50 })).settled,false);
    release(); await turn(); assert.equal(observer.health().in_flight,0);
    assert.equal(store.packets.length,1); assert.equal((await observer.close()).settled,true);
  } finally { release?.(); await observer.close(); }
});

test('revocation between page and window reauthorizes the original principal before recording', async () => {
  const f = await admitted(), store = recordingStore();
  const source = { ...f.controlPlane,async listAuditInvocations(principal,request) {
    const page = await f.controlPlane.listAuditInvocations(principal,request);
    f.setNow('2026-09-06T00:00:00.000Z'); return page;
  } };
  const observer = createManagedLifecycleObserver({ controlPlane: source,store,auditPrincipals: [f.principal],observerId: 'stable_observer' });
  try { assert.equal((await observer.runOnce()).failed,1); assert.equal(store.packets.length,0); }
  finally { await observer.close(); }
});

test('hung append retains its tenant slot and abort while healthy tenants progress; late settlement is not success', async () => {
  const f = await admitted(), store = recordingStore();
  let release, alphaSignal, alphaAppends = 0, alphaReads = 0;
  const source = { ...f.controlPlane,async listAuditInvocations(principal,request) {
    if (principal === f.principal) alphaReads += 1;
    return f.controlPlane.listAuditInvocations(principal,request);
  } };
  const target = { ...store,async appendLifecycleWindow(value,{ signal }) {
    if (value.tenant_id === f.principal.tenant_id) {
      alphaAppends += 1; alphaSignal = signal;
      await new Promise((resolve) => { release = resolve; });
      if (signal.aborted) throw new DOMException('Cancelled append','AbortError');
    }
    return store.appendLifecycleWindow(value);
  } };
  const observer = createManagedLifecycleObserver({ controlPlane: source,store: target,
    auditPrincipals: [f.principal,f.otherPrincipal],observerId: 'stable_observer',timeoutMs: 50,maxTenantsPerTick: 1 });
  try {
    const first = await observer.runOnce();
    assert.equal(first.timed_out,1); assert.equal(first.in_flight,1);
    assert.equal(alphaAppends,1); assert.equal(alphaSignal.aborted,true);
    assert.equal(store.packets.length,0);
    assert.equal((await observer.runOnce()).recorded,1);
    assert.equal(alphaReads,1); assert.equal(alphaAppends,1);
    assert.equal(store.packets.length,1); assert.equal(store.packets[0].tenant_id,'tenant_other');
    assert.equal((await observer.close({ timeoutMs: 50 })).settled,false);
    release(); await turn();
    assert.equal(observer.health().in_flight,0); assert.equal(observer.health().recorded,1);
    assert.equal(alphaReads,1); assert.equal(alphaAppends,1); assert.equal(store.packets.length,1);
    assert.equal((await observer.close()).settled,true);
  } finally { release?.(); await observer.close(); }
});

test('observer construction rejects descriptor tricks, mutable/duplicate scopes and providers before source I/O', async () => {
  const f = await admitted(), store = recordingStore();
  const base = { controlPlane: f.controlPlane,store,auditPrincipals: [f.principal],observerId: 'stable_observer' };
  for (const changed of [{ ...base,provider: {} },{ ...base,auditPrincipals: [f.principal,f.principal] },
    { ...base,auditPrincipals: [{ ...f.principal }] },{ ...base,auditPrincipals: new Proxy([f.principal],{}) },{ ...base,maxTenantsPerTick: 65 }]) assert.throws(() => createManagedLifecycleObserver(changed));
});

test('lifecycle delivery uses the existing bounded fenced drainer without widening policy packets', async () => {
  const source = createManagedAuditEvent({ event_ref: 'source_event',tenant_id: 'tenant_alpha',invocation_ref: 'rfi_alpha',
    sequence: 1,event_type: 'cleanup_verified',occurred_at: '2026-09-05T12:00:00.000Z' });
  const packet = projectManagedLifecycleEvent(source); let claimed = false, acknowledged = 0, delivered = 0;
  const store = { async claim() { if (claimed) return null; claimed = true; return { event: packet,generation: 1 }; },
    async acknowledge() { acknowledged += 1; },async retry() { throw new Error('must not retry'); } };
  const policy = createManagedTelemetryDrainer({ store,deliver: async () => { throw new Error('must not emit lifecycle through policy'); } });
  try { assert.equal((await policy.runOnce()).failed,1); assert.equal(acknowledged,0); } finally { await policy.close(); }
  claimed = false;
  const lifecycle = createManagedTelemetryDrainer({ eventKind: 'lifecycle',store,deliver: async (event) => {
    assert.deepEqual(event,packet); delivered += 1; return { event_ref: event.event_ref,delivered: true };
  } });
  try { assert.equal((await lifecycle.runOnce()).delivered,1); assert.equal(delivered,1); assert.equal(acknowledged,1); }
  finally { await lifecycle.close(); }
});

test('lifecycle failure health names only the unconfirmed boundary without inspecting thrown reasons', async () => {
  for (const boundary of boundaries) {
    const f = await admitted(), store = recordingStore(); let touches = 0, fail = true;
    const source = { ...f.controlPlane }, owner = isSourceBoundary(boundary) ? source : store;
    const original = owner[methods[boundary]].bind(owner);
    const reason = new Proxy({},Object.fromEntries(['get','getOwnPropertyDescriptor','ownKeys','getPrototypeOf'].map((key) => [key,() => { touches += 1; throw new Error('private error accessed'); }])));
    owner[methods[boundary]] = (...args) => { if (fail) throw reason; return original(...args); };
    const observer = createManagedLifecycleObserver({ controlPlane: source,store,auditPrincipals: [f.principal],observerId: boundary });
    try {
      const initial = observer.health(), first = await observer.runOnce();
      assert.deepEqual(first.failure_counts,countsAt(boundary)); assert.equal(first.failed,1); assert.equal(first.recorded,0);
      assert.equal(touches,0); assert.equal(Object.isFrozen(first.failure_counts),true);
      assert.deepEqual(initial.failure_counts,countsAt(null));
      assert.throws(() => { first.failure_counts[boundary] = 0; });
      fail = false; const recovered = await observer.runOnce();
      assert.equal(recovered.recorded,1); assert.deepEqual(recovered.failure_counts,countsAt(boundary));
      assert.equal(recovered.failed,1); assert.equal(touches,0);
    } finally { await observer.close(); }
  }
});

test('malformed lifecycle replies stay at the unconfirmed boundary and never record success', async () => {
  // Validate resolved source replies at their read boundary before append;
  // the trusted store still independently validates its final input.
  for (const boundary of boundaries) {
    const f = await admitted(), store = recordingStore(), source = { ...f.controlPlane };
    const owner = isSourceBoundary(boundary) ? source : store;
    owner[methods[boundary]] = () => ({ invalid: true });
    const observer = createManagedLifecycleObserver({ controlPlane: source,store,auditPrincipals: [f.principal],observerId: boundary });
    try {
      const health = await observer.runOnce();
      assert.deepEqual(health.failure_counts,countsAt(boundary));
      assert.equal(health.failed,1); assert.equal(health.recorded,0); assert.equal(store.packets.length,0);
    } finally { await observer.close(); }
  }
});

test('each lifecycle boundary timeout counts once; late rejection and shutdown are not new failures', async () => {
  for (const boundary of boundaries) {
    for (const shutdown of [false,true]) {
      const f = await admitted(), store = recordingStore(), source = { ...f.controlPlane }; let reject, touches = 0;
      const owner = isSourceBoundary(boundary) ? source : store;
      owner[methods[boundary]] = () => new Promise((resolve,rejectPromise) => { reject = rejectPromise; });
      const observer = createManagedLifecycleObserver({ controlPlane: source,store,auditPrincipals: [f.principal],observerId: boundary,timeoutMs: 50 });
      try {
        const pending = observer.runOnce(); await turn(); assert.equal(typeof reject,'function');
        if (shutdown) assert.equal((await observer.close({ timeoutMs: 50 })).settled,false);
        const first = await pending;
        assert.deepEqual(first.failure_counts,countsAt(shutdown ? null : boundary));
        assert.equal(first.failed,shutdown ? 0 : 1); assert.equal(first.timed_out,shutdown ? 0 : 1); assert.equal(first.in_flight,1);
        reject(new Proxy({}, { get() { touches += 1; throw new Error('private reason accessed'); } }));
        await turn(); await turn(); const late = observer.health();
        assert.deepEqual(late.failure_counts,first.failure_counts); assert.equal(late.failed,first.failed); assert.equal(late.timed_out,first.timed_out);
        assert.equal(late.recorded,0); assert.equal(late.in_flight,0); assert.equal(store.packets.length,0); assert.equal(touches,0);
      } finally { reject?.(null); await observer.close(); }
    }
  }
});
