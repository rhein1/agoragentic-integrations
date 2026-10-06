import { sha256Ref } from '../../src/canonical.mjs';
import { assertAllowedKeys, assertDataArray, assertPlainRecord, deepFreeze, requireEnum, requireInteger, requireSha256 } from './validation.mjs';
import { normalizeManagedTelemetryEvent, requireTelemetryRef } from './telemetry-event.mjs';
import { normalizeManagedLifecycleEvent } from './lifecycle-event.mjs';

// These count accepted observer packets, not all traffic, actual budget, current
// cleanup backlog or independent provider outcomes. No request-supplied formula.
export const METRIC_RULE_IDS = Object.freeze(['budget_denied','cleanup_incomplete_observed','cleanup_verified','control_disabled','control_failed','execution_failure_observed','lease_expiry_observed','policy_failure','policy_timeout','rate_denied','recovery_absence_verified']);
export const metricRuleKind = (id) => ['cleanup_incomplete_observed','cleanup_verified','execution_failure_observed','lease_expiry_observed','recovery_absence_verified'].includes(requireEnum(id,METRIC_RULE_IDS,'rule_id')) ? 'lifecycle' : 'policy';
const CAP_FIELDS = ['maxSources','maxSourcesPerTenant','maxWindows','maxWindowsPerTenant','maxAlerts','maxAlertsPerTenant'];
export function normalizeMetricSettings(value) {
  assertPlainRecord(value,'metric settings'); assertAllowedKeys(value,[...CAP_FIELDS,'rules'],'metric settings');
  if ([...CAP_FIELDS,'rules'].some((key) => !Object.hasOwn(value,key))) throw new TypeError('Metric settings require own closed fields');
  const limits = {};
  for (const key of CAP_FIELDS.filter((name) => !name.endsWith('PerTenant'))) {
    limits[key] = requireInteger(value[key],key,{ min: 1,max: 1_000_000 });
    limits[key+'PerTenant'] = requireInteger(value[key+'PerTenant'],key+'PerTenant',{ min: 1,max: limits[key] });
  }
  const source = assertDataArray(value.rules,'metric rules',{ maxLength: METRIC_RULE_IDS.length });
  if (!source.length) throw new TypeError('Metric rules must not be empty');
  const ids = new Set();
  const rules = source.map((rule) => {
    assertPlainRecord(rule,'metric rule'); assertAllowedKeys(rule,['rule_id','threshold','window_ms'],'metric rule');
    if (['rule_id','threshold','window_ms'].some((key) => !Object.hasOwn(rule,key))) throw new TypeError('Metric rule requires own fields');
    const rule_id = requireEnum(rule.rule_id,METRIC_RULE_IDS,'rule_id');
    if (ids.has(rule_id)) throw new TypeError('Duplicate metric rule'); ids.add(rule_id);
    return { rule_id,threshold: requireInteger(rule.threshold,'threshold',{ min: 1,max: 1_000_000 }),
      window_ms: requireInteger(rule.window_ms,'window_ms',{ min: 1000,max: 86_400_000 }) };
  }).sort((a,b) => a.rule_id < b.rule_id ? -1 : a.rule_id > b.rule_id ? 1 : 0);
  return deepFreeze({ ...limits,rules });
}
export const metricRulesHash = (settings) => sha256Ref({ domain: 'risk-fork-metric-rules-v1',rules: normalizeMetricSettings(settings).rules });
export const metricSettingsHash = (settings) => sha256Ref({ domain: 'risk-fork-metric-settings-v1',settings: normalizeMetricSettings(settings) });
export function matchingMetricRules(value,kind,settings) {
  requireEnum(kind,['policy','lifecycle'],'metric source kind');
  const event = kind === 'policy' ? normalizeManagedTelemetryEvent(value) : normalizeManagedLifecycleEvent(value);
  const matches = kind === 'lifecycle' ? (['cleanup_verified','recovery_absence_verified'].includes(event.source_event_type) ? [event.source_event_type]
    : event.source_event_type === 'cleanup_incomplete' ? ['cleanup_incomplete_observed']
    : event.source_event_type === 'execution_failure_observed' ? ['execution_failure_observed']
      : event.source_event_type.endsWith('_lease_expired') ? ['lease_expiry_observed'] : [])
    : ['invocation_budget_denied','daily_budget_denied'].includes(event.event) ? ['budget_denied']
      : event.event === 'rate_denied' ? ['rate_denied']
      : event.event === 'control_denied' ? [event.outcome === 'disabled' ? 'control_disabled' : 'control_failed']
        : event.event === 'policy_error' ? [event.outcome === 'timeout' ? 'policy_timeout' : 'policy_failure'] : [];
  return Object.freeze(normalizeMetricSettings(settings).rules.filter((rule) => matches.includes(rule.rule_id)));
}
const ALERT_FIELDS = ['event_ref','event','tenant_hash','rule_id','source_kind','window_start_ms','window_ms','count','threshold',
  'rules_hash','evidence_class','coverage','production_qualified'];
function alertRef(fields) {
  return 'evt_'+sha256Ref({ domain: 'risk-fork-metric-alert-v1',tenant_hash: fields.tenant_hash,rule_id: fields.rule_id,
    window_start_ms: fields.window_start_ms,rules_hash: fields.rules_hash }).slice(7,55);
}
function alertFields(value) {
  const rule_id = requireEnum(value.rule_id,METRIC_RULE_IDS,'rule_id'), source_kind = metricRuleKind(rule_id);
  const window_ms = requireInteger(value.window_ms,'window_ms',{ min: 1000,max: 86_400_000 });
  const window_start_ms = requireInteger(value.window_start_ms,'window_start_ms');
  requireInteger(window_start_ms+window_ms,'window end');
  if (window_start_ms % window_ms !== 0) throw new TypeError('Metric window is not aligned');
  const threshold = requireInteger(value.threshold,'threshold',{ min: 1,max: 1_000_000 });
  return { event: 'metric_threshold_observed',tenant_hash: requireSha256(value.tenant_hash,'tenant_hash'),rule_id,source_kind,
    window_start_ms,window_ms,count: threshold,threshold,rules_hash: requireSha256(value.rules_hash,'rules_hash'),
    evidence_class: source_kind === 'lifecycle' ? 'control_plane_self_attested' : 'host_policy_self_attested',
    coverage: 'ingested_observations_only',production_qualified: false };
}
export function createManagedMetricAlert(value) {
  assertPlainRecord(value,'metric alert fields');
  assertAllowedKeys(value,['tenant_hash','rule_id','window_start_ms','window_ms','threshold','rules_hash'],'metric alert fields');
  const fields = alertFields(value); return Object.freeze({ event_ref: alertRef(fields),...fields });
}
export function normalizeManagedMetricAlert(value) {
  assertPlainRecord(value,'metric alert'); assertAllowedKeys(value,ALERT_FIELDS,'metric alert');
  if (ALERT_FIELDS.some((key) => !Object.hasOwn(value,key))) throw new TypeError('Metric alert requires own closed fields');
  const fields = alertFields(value);
  for (const [key,expected] of Object.entries(fields)) if (value[key] !== expected) throw new TypeError('Metric alert fields disagree');
  if (requireTelemetryRef(value.event_ref) !== alertRef(fields)) throw new TypeError('Metric alert identity mismatch');
  return Object.freeze({ event_ref: value.event_ref,...fields });
}
