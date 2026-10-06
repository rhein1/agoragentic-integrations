import test from 'node:test';
import assert from 'node:assert/strict';
import { sha256Ref } from '../../src/canonical.mjs';
import { createManagedDiagnosticObservation, diagnosticRulesHash, diagnosticSettingsHash,
  normalizeDiagnosticSettings, normalizeManagedDiagnosticObservation } from '../src/diagnostic-event.mjs';

const settings = { bucket_ms: 1000,max_age_ms: 60000,max_future_ms: 1000,
  rules: [{ rule_id: 'observer_backlog_source_read_unconfirmed',threshold: 2,window_ms: 60000 }] };
const input = { tenant_hash: sha256Ref('tenant'),observer_hash: sha256Ref('observer'),boundary: 'backlog_source_read',observed_ms: 1234 };
test('diagnostic packets have exact bucket identity and closed redacted self-attested meaning', () => {
  const event = createManagedDiagnosticObservation(input,settings);
  assert.deepEqual(createManagedDiagnosticObservation({ ...input,observed_ms: 1999 },settings),event);
  assert.notEqual(createManagedDiagnosticObservation({ ...input,observed_ms: 2000 },settings).event_ref,event.event_ref);
  for (const field of ['tenant_hash','observer_hash']) assert.notEqual(createManagedDiagnosticObservation({ ...input,[field]: sha256Ref('other') },settings).event_ref,event.event_ref);
  assert.notEqual(createManagedDiagnosticObservation({ ...input,boundary: 'audit_window_read' },settings).event_ref,event.event_ref);
  assert.equal(event.bucket_start_ms,1000);
  assert.equal(event.evidence_class,'host_observer_self_attested');
  assert.equal(event.coverage,'ingested_unconfirmed_buckets_only');
  assert.equal(event.production_qualified,false);
  assert.deepEqual(normalizeManagedDiagnosticObservation(event,settings),event);
  for (const key of ['message','error','provider_ref','credential','code','healthy']) {
    assert.throws(() => createManagedDiagnosticObservation({ ...input,[key]: 'SECRET' },settings));
    assert.throws(() => normalizeManagedDiagnosticObservation({ ...event,[key]: 'SECRET' },settings));
  }
  assert.throws(() => normalizeManagedDiagnosticObservation({ ...event,bucket_start_ms: 1001 },settings));
  assert.throws(() => normalizeManagedDiagnosticObservation({ ...event,boundary: 'provider_failed' },settings));
  assert.throws(() => normalizeManagedDiagnosticObservation({ ...event,event_ref: 'evt_'+'0'.repeat(48) },settings));
  assert.throws(() => createManagedDiagnosticObservation({ ...input,observed_ms: Number.MAX_SAFE_INTEGER },settings));
});
test('diagnostic settings are independently immutable, closed and hash-bound', () => {
  const normalized = normalizeDiagnosticSettings(settings);
  assert.ok(Object.isFrozen(normalized) && Object.isFrozen(normalized.rules[0]));
  assert.notEqual(diagnosticSettingsHash(settings),diagnosticSettingsHash({ ...settings,max_age_ms: 61000 }));
  assert.notEqual(diagnosticRulesHash(settings),diagnosticRulesHash({ ...settings,bucket_ms: 2000 }));
  for (const invalid of [{ ...settings,extra: true },{ ...settings,bucket_ms: 0 },{ ...settings,max_age_ms: 999 },
    { ...settings,rules: [] },{ ...settings,rules: [...settings.rules,...settings.rules] },
    { ...settings,rules: [{ rule_id: 'policy_failure',threshold: 1,window_ms: 60000 }] },
    { ...settings,rules: [{ ...settings.rules[0],window_ms: 1001 }] }]) assert.throws(() => normalizeDiagnosticSettings(invalid));
});
