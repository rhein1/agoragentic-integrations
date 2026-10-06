import test from 'node:test';
import assert from 'node:assert/strict';
import { sha256Ref } from '../../src/canonical.mjs';
import { backlogGaugeInput, backlogSettingsHash, backlogTotalsHash, normalizeBacklogGauge, normalizeBacklogSettings } from '../src/backlog-gauge.mjs';
import { createManagedBacklogSnapshot, MANAGED_BACKLOG_COUNT_FIELDS } from '../src/backlog-snapshot.mjs';
import { normalizeTelemetryOptions } from '../src/postgres-telemetry-config.mjs';
import { normalizeManagedMetricAlert } from '../src/metric-event.mjs';

const settings = { maxTenants: 2 };
const snapshot = createManagedBacklogSnapshot({ tenant_id: 'tenant_alpha',snapshot_at: '2026-10-06T00:00:00.000Z',
  ...Object.fromEntries(MANAGED_BACKLOG_COUNT_FIELDS.map((key,i) => [key,i])) });
const input = { tenant_id: snapshot.tenant_id,observer_hash: sha256Ref('observer'),expected_state: null,snapshot };
export function gaugeFor(packet, expected = null) {
  const value = backlogGaugeInput({ ...packet,expected_state: expected },settings);
  return normalizeBacklogGauge({ schema: 'agoragentic.risk-fork.managed-backlog-gauge.v1',tenant_hash: value.tenantHash,
    observer_hash: value.observerHash,generation: (expected?.generation ?? 0)+1,source_snapshot_at: packet.snapshot.snapshot_at,
    source_snapshot_hash: packet.snapshot.snapshot_hash,...Object.fromEntries(MANAGED_BACKLOG_COUNT_FIELDS.map((key) => [key,packet.snapshot[key]])),
    recorded_ms: 1,settings_hash: value.settingsHash,last_batch_hash: value.batchHash,coverage: 'tenant_scoped_current_snapshot',
    evidence_class: 'control_plane_self_attested',production_qualified: false });
}
test('v8 is explicit and backlog settings are separately closed/hash-bound', () => {
  assert.deepEqual(normalizeBacklogSettings(settings),settings);
  for (const value of [{ maxTenants: 0 },{ maxTenants: 10001 },{ maxTenants: '2' },{ maxTenants: 2,threshold: 1 },{}]) assert.throws(() => normalizeBacklogSettings(value));
  assert.throws(() => normalizeBacklogSettings({ get maxTenants() { throw new Error('getter invoked'); } }),/enumerable data/);
  assert.notEqual(backlogSettingsHash(settings),backlogSettingsHash({ maxTenants: 1 }));
  assert.notEqual(backlogTotalsHash(1),backlogTotalsHash(2));
  const options = { limits: { maxEvents: 10,maxEventsPerTenant: 10,leaseMs: 1000,retryMs: 100,retentionMs: 1000 },lifecycle: true,metrics: true,
    metricSettings: { maxSources: 10,maxSourcesPerTenant: 10,maxWindows: 10,maxWindowsPerTenant: 10,maxAlerts: 10,maxAlertsPerTenant: 10,
      rules: [{ rule_id: 'rate_denied',threshold: 1,window_ms: 1000 }] } };
  for (const metricVersion of [undefined,3,4,5,6,7]) assert.throws(() => normalizeTelemetryOptions({ ...options,metricVersion,backlogSettings: settings }));
  assert.throws(() => normalizeTelemetryOptions({ ...options,metricVersion: 8 }));
  assert.deepEqual(normalizeTelemetryOptions({ ...options,metricVersion: 8,backlogSettings: settings }).backlogSettings,settings);
  assert.throws(() => normalizeTelemetryOptions({ ...options,metricVersion: 8,backlogSettings: settings,deploymentMode: 'production' }),{ code: 'TELEMETRY_NOT_QUALIFIED' });
});
test('latest gauge has closed safe counts, redaction and current-snapshot evidence only', () => {
  const state = gaugeFor(input);
  assert.equal(Object.isFrozen(state),true); assert.equal(normalizeBacklogGauge(null),null);
  assert.throws(() => normalizeManagedMetricAlert(state));
  for (const key of Object.keys(state)) { const missing = { ...state }; delete missing[key]; assert.throws(() => normalizeBacklogGauge(missing)); }
  for (const key of MANAGED_BACKLOG_COUNT_FIELDS) for (const value of [-1,0.5,Number.MAX_SAFE_INTEGER+1,'1']) assert.throws(() => normalizeBacklogGauge({ ...state,[key]: value }));
  for (const patch of [{ tenant_id: 'tenant_alpha' },{ production_qualified: true },{ evidence_class: 'independent' },{ generation: 0 },{ recorded_ms: -1 }]) assert.throws(() => normalizeBacklogGauge({ ...state,...patch }));
  assert.equal(JSON.stringify(state).includes('tenant_alpha'),false);
  assert.equal(state.coverage,'tenant_scoped_current_snapshot');
});
test('append scope binds original snapshot, expected generation and separate settings', () => {
  const first = backlogGaugeInput(input,settings), state = gaugeFor(input);
  assert.notEqual(first.batchHash,backlogGaugeInput({ ...input,expected_state: state },settings).batchHash);
  assert.throws(() => backlogGaugeInput({ ...input,tenant_id: 'tenant_other' },settings));
  assert.throws(() => backlogGaugeInput({ ...input,expected_state: { ...state,tenant_hash: sha256Ref('other') } },settings));
  assert.throws(() => backlogGaugeInput({ ...input,expected_state: state },{ maxTenants: 1 }));
  assert.throws(() => backlogGaugeInput({ ...input,snapshot: { ...snapshot,cleanup_pending_count: 99 } },settings));
  assert.throws(() => backlogGaugeInput({ ...input,clock: 0 },settings));
});
