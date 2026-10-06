import test from 'node:test';
import assert from 'node:assert/strict';
import { sha256Ref } from '../../src/canonical.mjs';
import { normalizeBacklogGauge, backlogSettingsHash } from '../src/backlog-gauge.mjs';
import { MANAGED_BACKLOG_COUNT_FIELDS } from '../src/backlog-snapshot.mjs';
import { advanceBacklogAlertState, baselineBacklogAlertState, normalizeBacklogAlertSettings,
  normalizeBacklogAlertState, normalizeManagedBacklogAlert } from '../src/backlog-alert.mjs';
import { createManagedTelemetryDrainer } from '../src/telemetry-drainer.mjs';

const settings = { maxAlerts: 100,maxAlertsPerTenant: 20,rules: [{ rule_id: 'cleanup_pending_count',threshold: 2 }] };
const gauge = (generation, count = 0) => normalizeBacklogGauge({ schema: 'agoragentic.risk-fork.managed-backlog-gauge.v1',
  tenant_hash: sha256Ref('tenant'),observer_hash: sha256Ref('observer'),generation,
  source_snapshot_at: new Date(1760000000000+generation).toISOString(),source_snapshot_hash: sha256Ref({ generation,count }),
  ...Object.fromEntries(MANAGED_BACKLOG_COUNT_FIELDS.map((key) => [key,key === 'cleanup_pending_count' ? count : 0])),
  recorded_ms: 1760000000000+generation,settings_hash: backlogSettingsHash({ maxTenants: 2 }),last_batch_hash: sha256Ref({ batch: generation }),
  coverage: 'tenant_scoped_current_snapshot',evidence_class: 'control_plane_self_attested',production_qualified: false });

test('backlog alerts deliver observed open/clear/reopen transitions without summing polls', () => {
  const a = advanceBacklogAlertState(null,gauge(1,2),settings);
  assert.equal(a.alerts[0].condition,'condition_observed'); assert.equal(a.alerts[0].transition,1);
  const b = advanceBacklogAlertState(a.state,gauge(2,9),settings); assert.deepEqual(b.alerts,[]);
  const c = advanceBacklogAlertState(b.state,gauge(3,1),settings);
  assert.equal(c.alerts[0].condition,'threshold_cleared'); assert.equal(c.alerts[0].episode,1); assert.equal(c.alerts[0].transition,2);
  const d = advanceBacklogAlertState(c.state,gauge(4,2),settings);
  assert.equal(d.alerts[0].condition,'threshold_crossed'); assert.equal(d.alerts[0].episode,2); assert.equal(d.alerts[0].transition,3);
  assert.equal(c.alerts[0].previous_alert_hash,sha256Ref(a.alerts[0]));
  assert.equal(d.alerts[0].previous_alert_hash,sha256Ref(c.alerts[0]));
  assert.deepEqual(advanceBacklogAlertState(d.state,gauge(4,2),settings),{ state: d.state,alerts: [] });
  assert.equal(d.alerts[0].production_qualified,false); assert.equal(d.alerts[0].coverage,'sampled_threshold_conditions_only');
});
test('backlog alert baseline is unknown; no historical clear or invented crossing', () => {
  const legacy = baselineBacklogAlertState(gauge(10,20),settings);
  assert.equal(legacy.rules[0].active,null); assert.equal(legacy.rules[0].transition,0);
  assert.deepEqual(advanceBacklogAlertState(legacy,gauge(10,20),settings).alerts,[]);
  const high = advanceBacklogAlertState(legacy,gauge(11,20),settings);
  assert.equal(high.alerts[0].condition,'condition_observed');
  const low = advanceBacklogAlertState(legacy,gauge(11,0),settings);
  assert.deepEqual(low.alerts,[]); assert.equal(low.state.rules[0].active,false);
  assert.equal(advanceBacklogAlertState(low.state,gauge(12,2),settings).alerts[0].condition,'threshold_crossed');
  assert.throws(() => advanceBacklogAlertState(low.state,gauge(10,2),settings));
  assert.throws(() => advanceBacklogAlertState(low.state,null,settings));
});
test('backlog alert closed values bind condition/value/parity/hash and forbid authority additions', () => {
  const event = advanceBacklogAlertState(null,gauge(1,2),settings).alerts[0];
  assert.deepEqual(normalizeManagedBacklogAlert(event),event);
  for (const mutation of [{ value: 1 },{ condition: 'threshold_cleared' },{ transition: 2 },{ episode: 2 },
    { event_ref: 'evt_'+'0'.repeat(48) },{ previous_alert_hash: sha256Ref('bad') },{ production_qualified: true },{ approval: true }]) {
    assert.throws(() => normalizeManagedBacklogAlert({ ...event,...mutation }));
  }
  const state = advanceBacklogAlertState(null,gauge(1,2),settings).state;
  for (const mutation of [{ active: false },{ transition: 2 },{ episode: 0 },{ pruned_through: 1 },{ pruned_generation: 2 }]) {
    assert.throws(() => normalizeBacklogAlertState({ ...state,rules: [{ ...state.rules[0],...mutation }] },settings));
  }
  const evil = { ...event }; Object.defineProperty(evil,'value',{ get() { throw new Error('must not invoke'); } });
  assert.throws(() => normalizeManagedBacklogAlert(evil));
  assert.throws(() => normalizeManagedBacklogAlert({ ...event,'аuthority': true }));
});
test('backlog alert settings are closed, ordered, fixed-name and practically bounded', () => {
  const both = { ...settings,rules: [{ rule_id: 'recovery_required_count',threshold: 3 },...settings.rules] };
  assert.equal(normalizeBacklogAlertSettings(both).rules[0].rule_id,'cleanup_pending_count');
  for (const mutation of [{ maxAlertsPerTenant: 10001,maxAlerts: 1000000 },{ rules: [] },{ rules: [...settings.rules,...settings.rules] },
    { rules: [{ rule_id: 'arbitrary_metric',threshold: 1 }] },{ rules: [{ rule_id: 'cleanup_pending_count',threshold: 0 }] },{ allowed: true }]) {
    assert.throws(() => normalizeBacklogAlertSettings({ ...settings,...mutation }));
  }
  const sparse = []; sparse.length = 1; assert.throws(() => normalizeBacklogAlertSettings({ ...settings,rules: sparse }));
});
test('backlog alert state keeps prune generation and transition checkpoints fixed', () => {
  const opened = advanceBacklogAlertState(null,gauge(1,2),settings);
  const closed = advanceBacklogAlertState(opened.state,gauge(2,0),settings);
  const rule = closed.state.rules[0];
  const state = normalizeBacklogAlertState({ ...closed.state,rules: [{ ...rule,pruned_through: 2,pruned_generation: 2,
    pruned_hash: rule.emitted_hash,ack_checkpoint_hash: sha256Ref('ack') }] },settings);
  assert.equal(state.rules[0].pruned_generation,2);
  assert.equal(advanceBacklogAlertState(state,gauge(3,2),settings).alerts[0].transition,3);
  assert.throws(() => normalizeBacklogAlertState({ ...state,rules: [{ ...state.rules[0],pruned_generation: 0 }] },settings));
});
test('shared telemetry drainer accepts closed backlog alerts without alternate delivery machinery', async () => {
  const a = advanceBacklogAlertState(null,gauge(1,2),settings), b = advanceBacklogAlertState(a.state,gauge(2,0),settings);
  const queue = [...a.alerts,...b.alerts], delivered = [], acknowledged = [];
  const drainer = createManagedTelemetryDrainer({ eventKind: 'backlog_alert',store: {
    async claim() { return queue.length ? { event: queue.shift(),generation: 1 } : null; },
    async acknowledge(request) { acknowledged.push(request.acknowledgement.event_ref); },
    async retry() { throw new Error('unexpected retry'); },
  },deliver: async (event) => { delivered.push(event.condition); return { event_ref: event.event_ref,delivered: true }; } });
  try { assert.equal((await drainer.runOnce()).delivered,2); assert.deepEqual(delivered,['condition_observed','threshold_cleared']); assert.equal(acknowledged.length,2); }
  finally { assert.equal((await drainer.close()).settled,true); }
});
