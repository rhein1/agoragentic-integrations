import { sha256Ref } from '../../src/canonical.mjs';
import { assertAllowedKeys, assertDataArray, assertPlainRecord, deepFreeze, requireEnum, requireInteger, requireIso, requireSha256 } from './validation.mjs';
import { MANAGED_BACKLOG_COUNT_FIELDS } from './backlog-snapshot.mjs';
import { backlogGaugeHash, normalizeBacklogGauge } from './backlog-gauge.mjs';
import { requireTelemetryRef } from './telemetry-event.mjs';

function closed(value, fields, label) {
  assertPlainRecord(value,label); assertAllowedKeys(value,fields,label);
  if (fields.some((key) => !Object.hasOwn(value,key))) throw new TypeError(`${label} requires own closed fields`);
}
export function normalizeBacklogAlertSettings(value) {
  closed(value,['maxAlerts','maxAlertsPerTenant','rules'],'backlog alert settings');
  const maxAlerts = requireInteger(value.maxAlerts,'maxAlerts',{ min: 1,max: 1_000_000 });
  const maxAlertsPerTenant = requireInteger(value.maxAlertsPerTenant,'maxAlertsPerTenant',{ min: 1,max: Math.min(maxAlerts,10_000) });
  const source = assertDataArray(value.rules,'backlog alert rules',{ maxLength: MANAGED_BACKLOG_COUNT_FIELDS.length });
  if (!source.length) throw new TypeError('Backlog alert rules must not be empty');
  const ids = new Set(), rules = source.map((rule) => {
    closed(rule,['rule_id','threshold'],'backlog alert rule');
    const rule_id = requireEnum(rule.rule_id,MANAGED_BACKLOG_COUNT_FIELDS,'rule_id');
    if (ids.has(rule_id)) throw new TypeError('Duplicate backlog alert rule'); ids.add(rule_id);
    return { rule_id,threshold: requireInteger(rule.threshold,'threshold',{ min: 1 }) };
  }).sort((a,b) => a.rule_id < b.rule_id ? -1 : a.rule_id > b.rule_id ? 1 : 0);
  return deepFreeze({ maxAlerts,maxAlertsPerTenant,rules });
}
export const backlogAlertSettingsHash = (settings) => sha256Ref({ domain: 'risk-fork-backlog-alert-settings-v1',settings: normalizeBacklogAlertSettings(settings) });
export const backlogAlertStateHash = (state) => sha256Ref({ domain: 'risk-fork-backlog-alert-state-v1',state });
export const backlogAlertTotalsHash = (count) => sha256Ref({ domain: 'risk-fork-backlog-alert-totals-v1',alert_count: requireInteger(count,'alert_count',{ max: 1_000_000 }) });
const MAX_EPISODE = Math.floor(Number.MAX_SAFE_INTEGER/2);
const ALERT_FIELDS = ['schema','event','tenant_hash','rule_id','threshold','value','episode','transition','condition','gauge_generation',
  'source_snapshot_at','source_snapshot_hash','recorded_ms','settings_hash','previous_alert_hash','coverage','evidence_class','production_qualified'];
function alertFields(value) {
  const threshold = requireInteger(value.threshold,'threshold',{ min: 1 });
  const condition = requireEnum(value.condition,['condition_observed','threshold_crossed','threshold_cleared'],'condition');
  const observed = requireInteger(value.value,'value'), episode = requireInteger(value.episode,'episode',{ min: 1,max: MAX_EPISODE });
  const transition = requireInteger(value.transition,'transition',{ min: 1 });
  if (transition !== 2*episode-(condition === 'threshold_cleared' ? 0 : 1)
    || (condition === 'threshold_cleared' ? observed >= threshold : observed < threshold)
    || (condition === 'condition_observed' && transition !== 1)
    || (transition === 1) !== (value.previous_alert_hash === null)) throw new TypeError('Backlog alert transition mismatch');
  return { schema: 'agoragentic.risk-fork.managed-backlog-alert.v1',event: 'backlog_threshold_observed',
    tenant_hash: requireSha256(value.tenant_hash,'tenant_hash'),rule_id: requireEnum(value.rule_id,MANAGED_BACKLOG_COUNT_FIELDS,'rule_id'),
    threshold,value: observed,episode,transition,condition,
    gauge_generation: requireInteger(value.gauge_generation,'gauge_generation',{ min: 1 }),
    source_snapshot_at: requireIso(value.source_snapshot_at,'source_snapshot_at'),source_snapshot_hash: requireSha256(value.source_snapshot_hash,'source_snapshot_hash'),
    recorded_ms: requireInteger(value.recorded_ms,'recorded_ms'),settings_hash: requireSha256(value.settings_hash,'settings_hash'),
    previous_alert_hash: value.previous_alert_hash === null ? null : requireSha256(value.previous_alert_hash,'previous_alert_hash'),
    coverage: 'sampled_threshold_conditions_only',evidence_class: 'control_plane_self_attested',production_qualified: false };
}
const alertRef = (fields) => 'evt_'+sha256Ref({ domain: 'risk-fork-backlog-alert-v1',...fields }).slice(7,55);
export function createManagedBacklogAlert(value) {
  closed(value,ALERT_FIELDS.filter((key) => !['schema','event','coverage','evidence_class','production_qualified'].includes(key)),'backlog alert fields');
  const fields = alertFields(value); return deepFreeze({ event_ref: alertRef(fields),...fields });
}
export function normalizeManagedBacklogAlert(value) {
  closed(value,['event_ref',...ALERT_FIELDS],'backlog alert');
  const fields = alertFields(value);
  if (Object.entries(fields).some(([key,expected]) => value[key] !== expected)
    || requireTelemetryRef(value.event_ref) !== alertRef(fields)) throw new TypeError('Backlog alert binding mismatch');
  return deepFreeze({ event_ref: value.event_ref,...fields });
}
const RULE_FIELDS = ['rule_id','threshold','active','episode','transition','emitted_hash','pruned_through','pruned_generation','pruned_hash','ack_checkpoint_hash'];
export function normalizeBacklogAlertState(value, settingsValue) {
  const settings = normalizeBacklogAlertSettings(settingsValue);
  closed(value,['schema','tenant_hash','gauge_generation','gauge_hash','settings_hash','rules'],'backlog alert state');
  if (value.schema !== 'agoragentic.risk-fork.managed-backlog-alert-state.v1'
    || value.settings_hash !== backlogAlertSettingsHash(settings)) throw new TypeError('Backlog alert state settings mismatch');
  const source = assertDataArray(value.rules,'backlog threshold state',{ maxLength: settings.rules.length });
  if (source.length !== settings.rules.length) throw new TypeError('Missing backlog threshold state');
  const rules = source.map((rule,index) => {
    closed(rule,RULE_FIELDS,'backlog threshold state');
    const configured = settings.rules[index];
    if (rule.rule_id !== configured.rule_id || rule.threshold !== configured.threshold
      || (rule.active !== null && typeof rule.active !== 'boolean')) throw new TypeError('Backlog threshold state mismatch');
    const episode = requireInteger(rule.episode,'episode',{ max: MAX_EPISODE }), transition = requireInteger(rule.transition,'transition');
    const pruned_through = requireInteger(rule.pruned_through,'pruned_through',{ max: transition });
    const pruned_generation = requireInteger(rule.pruned_generation,'pruned_generation',{ max: value.gauge_generation });
    const emitted_hash = rule.emitted_hash === null ? null : requireSha256(rule.emitted_hash,'emitted_hash');
    const pruned_hash = rule.pruned_hash === null ? null : requireSha256(rule.pruned_hash,'pruned_hash');
    const ack_checkpoint_hash = rule.ack_checkpoint_hash === null ? null : requireSha256(rule.ack_checkpoint_hash,'ack_checkpoint_hash');
    if ((transition === 0) !== (emitted_hash === null) || (pruned_through === 0) !== (pruned_hash === null)
      || (pruned_through === 0) !== (ack_checkpoint_hash === null) || (pruned_through === 0) !== (pruned_generation === 0)
      || (pruned_through === transition && pruned_hash !== emitted_hash)
      || (rule.active === null && (episode !== 0 || transition !== 0))
      || (rule.active === true && (episode === 0 || transition !== 2*episode-1))
      || (rule.active === false && transition !== 2*episode)) throw new TypeError('Backlog episode custody mismatch');
    return { ...configured,active: rule.active,episode,transition,emitted_hash,pruned_through,pruned_generation,pruned_hash,ack_checkpoint_hash };
  });
  return deepFreeze({ schema: value.schema,tenant_hash: requireSha256(value.tenant_hash,'tenant_hash'),
    gauge_generation: requireInteger(value.gauge_generation,'gauge_generation',{ min: 1 }),gauge_hash: requireSha256(value.gauge_hash,'gauge_hash'),
    settings_hash: value.settings_hash,rules });
}
export function baselineBacklogAlertState(gaugeValue, settings) {
  const gauge = normalizeBacklogGauge(gaugeValue);
  if (!gauge) throw new TypeError('Backlog alert baseline requires a gauge');
  return normalizeBacklogAlertState({ schema: 'agoragentic.risk-fork.managed-backlog-alert-state.v1',tenant_hash: gauge.tenant_hash,
    gauge_generation: gauge.generation,gauge_hash: backlogGaugeHash(gauge),settings_hash: backlogAlertSettingsHash(settings),
    rules: normalizeBacklogAlertSettings(settings).rules.map((rule) => ({ ...rule,active: null,episode: 0,transition: 0,emitted_hash: null,
      pruned_through: 0,pruned_generation: 0,pruned_hash: null,ack_checkpoint_hash: null })) },settings);
}
// A successful observed transition only. Missing/stale/failed source reads never
// call this function and cannot silently clear a condition or emit an alert.
export function advanceBacklogAlertState(previousValue, gaugeValue, settings) {
  const gauge = normalizeBacklogGauge(gaugeValue);
  if (!gauge) throw new TypeError('Backlog alert transition requires a gauge');
  const previous = previousValue === null ? null : normalizeBacklogAlertState(previousValue,settings);
  const hash = backlogGaugeHash(gauge);
  if (previous && previous.tenant_hash !== gauge.tenant_hash) throw new TypeError('Backlog alert tenant mismatch');
  if (previous?.gauge_generation === gauge.generation && previous.gauge_hash === hash) return deepFreeze({ state: previous,alerts: [] });
  if (gauge.generation !== (previous?.gauge_generation ?? 0)+1) throw new TypeError('Backlog alert gauge advancement mismatch');
  const baseline = previous ?? baselineBacklogAlertState(gauge,settings), alerts = [];
  const rules = baseline.rules.map((rule) => {
    const active = gauge[rule.rule_id] >= rule.threshold;
    if (active === rule.active || (!active && rule.active === null)) return { ...rule,active };
    const episode = requireInteger(rule.episode+(active ? 1 : 0),'episode',{ min: 1,max: MAX_EPISODE });
    const transition = requireInteger(rule.transition+1,'transition',{ min: 1 });
    const event = createManagedBacklogAlert({ tenant_hash: gauge.tenant_hash,rule_id: rule.rule_id,threshold: rule.threshold,
      value: gauge[rule.rule_id],episode,transition,
      condition: !active ? 'threshold_cleared' : rule.active === false ? 'threshold_crossed' : 'condition_observed',
      gauge_generation: gauge.generation,source_snapshot_at: gauge.source_snapshot_at,source_snapshot_hash: gauge.source_snapshot_hash,
      recorded_ms: gauge.recorded_ms,settings_hash: baseline.settings_hash,previous_alert_hash: rule.emitted_hash });
    alerts.push(event); return { ...rule,active,episode,transition,emitted_hash: sha256Ref(event) };
  });
  return deepFreeze({ state: normalizeBacklogAlertState({ ...baseline,gauge_generation: gauge.generation,gauge_hash: hash,rules },settings),alerts });
}
