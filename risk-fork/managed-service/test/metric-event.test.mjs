import test from 'node:test';
import assert from 'node:assert/strict';
import { sha256Ref } from '../../src/canonical.mjs';
import { createManagedTelemetryEvent } from '../src/telemetry-event.mjs';
import { projectManagedLifecycleEvent } from '../src/lifecycle-event.mjs';
import { createManagedMetricAlert, matchingMetricRules, metricRulesHash, normalizeManagedMetricAlert, normalizeMetricSettings } from '../src/metric-event.mjs';

const limits = { maxSources: 100,maxSourcesPerTenant: 50,maxWindows: 100,maxWindowsPerTenant: 50,maxAlerts: 100,maxAlertsPerTenant: 50 };
const settings = normalizeMetricSettings({ ...limits,rules: [
  { rule_id: 'rate_denied',threshold: 2,window_ms: 60_000 },
  { rule_id: 'control_disabled',threshold: 1,window_ms: 60_000 },
  { rule_id: 'policy_timeout',threshold: 1,window_ms: 60_000 },
  { rule_id: 'lease_expiry_observed',threshold: 1,window_ms: 60_000 },
] });
const tenant = sha256Ref('tenant only'), key = sha256Ref('key only');
const policy = (event,outcome,status) => createManagedTelemetryEvent({ event,outcome,status,route_class: 'admission',duration_ms: 1,tenant_hash: tenant,key_hash: key });

test('metric settings are closed bounded host configuration, with canonical rule ordering', () => {
  assert.ok(Object.isFrozen(settings)); assert.ok(Object.isFrozen(settings.rules));
  assert.deepEqual(settings.rules.map((r) => r.rule_id),['control_disabled','lease_expiry_observed','policy_timeout','rate_denied']);
  assert.equal(metricRulesHash(settings),metricRulesHash(normalizeMetricSettings({ ...settings,rules: [...settings.rules].reverse() })));
  for (const extra of [{ ...settings,formula: 'eval' },{ ...settings,rules: [{ rule_id: 'budget_pressure',threshold: 1,window_ms: 1000 }] },
    { ...settings,rules: [settings.rules[0],settings.rules[0]] },{ ...settings,maxSourcesPerTenant: 101 },
    { ...settings,rules: [{ rule_id: 'rate_denied',threshold: 0,window_ms: 1000 }] },
    { ...settings,rules: [{ rule_id: 'rate_denied',threshold: 1,window_ms: 999 }] }]) assert.throws(() => normalizeMetricSettings(extra));
  const getter = { ...settings }; Object.defineProperty(getter,'rules',{ enumerable: true,get() { throw new Error('must not execute'); } });
  assert.throws(() => normalizeMetricSettings(getter),/enumerable data/);
});

test('rules retain exact policy semantics and never fabricate missing budget/provider/backlog evidence', () => {
  assert.deepEqual(matchingMetricRules(policy('rate_denied','rate_limited',429),'policy',settings).map((r) => r.rule_id),['rate_denied']);
  assert.deepEqual(matchingMetricRules(policy('control_denied','disabled',503),'policy',settings).map((r) => r.rule_id),['control_disabled']);
  assert.deepEqual(matchingMetricRules(policy('control_denied','failed_closed',503),'policy',settings),[]);
  assert.deepEqual(matchingMetricRules(policy('policy_error','timeout',503),'policy',settings).map((r) => r.rule_id),['policy_timeout']);
  assert.deepEqual(matchingMetricRules(policy('policy_allowed','allowed',200),'policy',settings),[]);
  const lifecycle = projectManagedLifecycleEvent({ tenant_id: 'tenant_alpha',invocation_ref: 'rfi_only',sequence: 1,event_hash: sha256Ref('event'),
    event_type: 'execution_lease_expired',occurred_at: '2026-10-05T00:00:00.000Z' });
  assert.deepEqual(matchingMetricRules(lifecycle,'lifecycle',settings).map((r) => r.rule_id),['lease_expiry_observed']);
  assert.throws(() => matchingMetricRules(lifecycle,'policy',settings));
});

test('threshold alert identity is exact tenant/rule/window/config bound, closed and authority free', () => {
  const fields = { tenant_hash: tenant,rule_id: 'rate_denied',window_start_ms: 120_000,window_ms: 60_000,threshold: 2,rules_hash: metricRulesHash(settings) };
  const alert = createManagedMetricAlert(fields);
  assert.deepEqual(normalizeManagedMetricAlert(alert),alert); assert.ok(Object.isFrozen(alert));
  assert.equal(alert.count,2); assert.equal(alert.coverage,'ingested_observations_only');
  assert.equal(alert.evidence_class,'host_policy_self_attested'); assert.equal(alert.production_qualified,false);
  assert.equal(alert.event_ref,createManagedMetricAlert(fields).event_ref);
  for (const change of [{ tenant_hash: sha256Ref('other') },{ window_start_ms: 180_000 },{ rules_hash: sha256Ref('other rule config') }])
    assert.notEqual(alert.event_ref,createManagedMetricAlert({ ...fields,...change }).event_ref);
  for (const change of [{ raw_token: 'not permitted' },{ production_qualified: true },{ coverage: 'all_traffic' },{ count: 3 },
    { event_ref: 'evt_'+'0'.repeat(48) },{ window_start_ms: 120_001 },{ source_kind: 'lifecycle' }])
    assert.throws(() => normalizeManagedMetricAlert({ ...alert,...change }));
});
