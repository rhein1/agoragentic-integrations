import test from 'node:test';
import assert from 'node:assert/strict';
import { sha256Ref } from '../../src/canonical.mjs';
import { createManagedDiagnosticObservation } from '../src/diagnostic-event.mjs';
import { createManagedWorkerDiagnosticObservation, normalizeManagedWorkerDiagnosticObservation, WORKER_DIAGNOSTIC_RULE_IDS } from '../src/worker-diagnostic-event.mjs';
import { createWorkerDiagnostic } from '../src/worker-diagnostic.mjs';
import { createManagedMetricAlert, normalizeManagedMetricAlert } from '../src/metric-event.mjs';

const settings = { bucket_ms: 1000,max_age_ms: 60000,max_future_ms: 1000,
  rules: [{ rule_id: 'worker_provider_call_unconfirmed',threshold: 1,window_ms: 60000 }] };
const input = { tenant_hash: sha256Ref('tenant'),worker_hash: sha256Ref('worker'),boundary: 'provider_call',observed_ms: 1500 };
test('worker diagnostic packet is closed, deterministic, separately namespaced and non-authoritative', () => {
  const event = createManagedWorkerDiagnosticObservation(input,settings);
  assert.deepEqual(createManagedWorkerDiagnosticObservation({ ...input,observed_ms: 1999 },settings),event);
  assert.deepEqual(normalizeManagedWorkerDiagnosticObservation(event,settings),event);
  assert.equal(event.evidence_class,'host_worker_self_attested'); assert.equal(event.production_qualified,false);
  for (const change of [{ production_qualified: true },{ tenant_id: 'raw' },{ boundary: 'audit_window_read' },{ bucket_ms: 2000 },{ worker_hash: sha256Ref('other') }]) {
    assert.throws(() => normalizeManagedWorkerDiagnosticObservation({ ...event,...change },settings));
  }
  assert.throws(() => createManagedWorkerDiagnosticObservation({ ...input,error: 'private' },settings));
  assert.throws(() => createManagedWorkerDiagnosticObservation(input,{ ...settings,rules: [{ ...settings.rules[0],rule_id: 'observer_audit_window_read_unconfirmed' }] }));
  assert.equal(WORKER_DIAGNOSTIC_RULE_IDS.length,12);
  assert.throws(() => createManagedDiagnosticObservation({ tenant_hash: input.tenant_hash,observer_hash: input.worker_hash,boundary: input.boundary,observed_ms: 1500 },settings));
  const alert = createManagedMetricAlert({ tenant_hash: input.tenant_hash,rule_id: settings.rules[0].rule_id,threshold: 1,
    window_start_ms: 0,window_ms: 60000,rules_hash: sha256Ref(settings) });
  assert.equal(alert.source_kind,'worker_diagnostic'); assert.equal(alert.evidence_class,'host_worker_self_attested');
  assert.deepEqual(normalizeManagedMetricAlert(alert),alert);
});
test('worker recorder retains per-boundary hung slots, reports loss and never accepts late acknowledgement', async () => {
  let release,entered = 0;
  const wait = new Promise((resolve) => { release = resolve; }), signal = new AbortController();
  const recorder = createWorkerDiagnostic({ workerDiagnosticSettings: settings,workerDiagnosticTimeoutMs: 50,workerDiagnosticClock: () => 1500,
    workerDiagnosticStore: { async appendWorkerDiagnosticObservation(event) { entered++; await wait; return { event_ref: event.event_ref,persisted: true }; } } },input.tenant_hash,input.worker_hash,signal.signal);
  recorder.record('provider_call'); recorder.record('provider_call'); recorder.record('resource_journal');
  let health = await recorder.flush({ timeoutMs: 100 });
  assert.equal(entered,2); assert.equal(health.in_flight,2); assert.equal(health.dropped,1); assert.equal(health.timed_out,2);
  assert.equal(health.settled,false); assert.equal(health.recorded,0); assert.equal(health.failure_counts.provider_call,2);
  release(); await recorder.flush(); health = recorder.health();
  assert.equal(health.in_flight,0); assert.equal(health.recorded,0,'late settlement cannot manufacture persistence confirmation');
  signal.abort(); recorder.record('provider_call'); assert.equal(recorder.health().failure_counts.provider_call,2);
});
test('worker recorder captures original store/settings, refuses malformed ACKs and clock rollback without raw diagnostics', async () => {
  let now = 1500,oldCalls = 0;
  const store = { async appendWorkerDiagnosticObservation() { oldCalls++; return Object.defineProperty({},'persisted',{ get() { throw new Error('private getter'); } }); } };
  const options = { workerDiagnosticSettings: settings,workerDiagnosticStore: store,workerDiagnosticClock: () => now };
  const recorder = createWorkerDiagnostic(options,input.tenant_hash,input.worker_hash,new AbortController().signal);
  options.workerDiagnosticSettings = {}; store.appendWorkerDiagnosticObservation = () => { throw new Error('replacement'); };
  recorder.record('provider_call'); await recorder.flush(); assert.equal(oldCalls,1); assert.equal(recorder.health().failed,1);
  now = 1499; recorder.record('provider_call'); await recorder.flush(); assert.equal(oldCalls,1); assert.equal(recorder.health().failed,2);
  const disabled = createWorkerDiagnostic({},input.tenant_hash,input.worker_hash,new AbortController().signal);
  disabled.record('provider_call'); assert.equal(disabled.health().enabled,false); assert.equal(disabled.health().failure_counts.provider_call,1);
  assert.throws(() => createWorkerDiagnostic({ workerDiagnosticStore: store },input.tenant_hash,input.worker_hash,new AbortController().signal));
});
