import test from 'node:test';
import assert from 'node:assert/strict';
import { createManagedLifecycleObserver } from '../src/lifecycle-observer.mjs';
import { normalizeManagedLifecycleEvent, projectManagedLifecycleEvent } from '../src/lifecycle-event.mjs';
import { normalizeManagedTelemetryEvent } from '../src/telemetry-event.mjs';
import { createManagedTelemetryDrainer } from '../src/telemetry-drainer.mjs';
import { createManagedAuditEvent } from '../src/audit.mjs';
import { createFixture, invocationRequest } from './helpers.mjs';

const turn = () => new Promise((resolve) => setImmediate(resolve));
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
