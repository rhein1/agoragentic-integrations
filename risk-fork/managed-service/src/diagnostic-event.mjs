import { sha256Ref } from '../../src/canonical.mjs';
import { assertAllowedKeys, assertDataArray, assertPlainRecord, deepFreeze, requireEnum, requireInteger, requireSha256 } from './validation.mjs';
import { requireTelemetryRef } from './telemetry-event.mjs';

// Closed host dispatch phases only. No thrown properties, dependency diagnosis,
// provider self-report or execution authority. One observation per time bucket.
export const DIAGNOSTIC_BOUNDARIES = Object.freeze(['backlog_gauge_read','backlog_source_read','backlog_snapshot_append',
  'lifecycle_sweep_read','audit_invocations_read','lifecycle_checkpoint_read','audit_window_read','lifecycle_window_append']);
export const DIAGNOSTIC_RULE_IDS = Object.freeze(DIAGNOSTIC_BOUNDARIES.map((name) => 'observer_'+name+'_unconfirmed'));
function closed(value,fields,label) {
  assertPlainRecord(value,label); assertAllowedKeys(value,fields,label);
  if (fields.some((key) => !Object.hasOwn(value,key))) throw new TypeError(label+' requires own fields');
}
export function normalizeDiagnosticSettings(value) {
  closed(value,['bucket_ms','max_age_ms','max_future_ms','rules'],'diagnostic settings');
  const bucket_ms = requireInteger(value.bucket_ms,'bucket_ms',{ min: 1000,max: 60000 });
  const max_age_ms = requireInteger(value.max_age_ms,'max_age_ms',{ min: bucket_ms,max: 86400000 });
  const max_future_ms = requireInteger(value.max_future_ms,'max_future_ms',{ max: 30000 });
  const ids = new Set(), source = assertDataArray(value.rules,'diagnostic rules',{ maxLength: DIAGNOSTIC_RULE_IDS.length });
  if (!source.length) throw new TypeError('Diagnostic rules must not be empty');
  const rules = source.map((rule) => {
    closed(rule,['rule_id','threshold','window_ms'],'diagnostic rule');
    const rule_id = requireEnum(rule.rule_id,DIAGNOSTIC_RULE_IDS,'rule_id');
    if (ids.has(rule_id)) throw new TypeError('Duplicate diagnostic rule'); ids.add(rule_id);
    const window_ms = requireInteger(rule.window_ms,'window_ms',{ min: bucket_ms,max: 86400000 });
    if (window_ms % bucket_ms) throw new TypeError('Diagnostic window must contain whole buckets');
    return { rule_id,threshold: requireInteger(rule.threshold,'threshold',{ min: 1,max: 1000000 }),window_ms };
  }).sort((a,b) => a.rule_id < b.rule_id ? -1 : a.rule_id > b.rule_id ? 1 : 0);
  return deepFreeze({ bucket_ms,max_age_ms,max_future_ms,rules });
}
export const diagnosticSettingsHash = (settings) => sha256Ref({ domain: 'risk-fork-diagnostic-settings-v1',settings: normalizeDiagnosticSettings(settings) });
// Window meaning includes bucket size and admission clock bounds, not just rules.
export const diagnosticRulesHash = (settings) => sha256Ref({ domain: 'risk-fork-diagnostic-rules-v1',settings: normalizeDiagnosticSettings(settings) });
const FIELDS = ['event_ref','event','tenant_hash','observer_hash','boundary','bucket_start_ms','bucket_ms','settings_hash',
  'evidence_class','coverage','production_qualified'];
function fields(value,settings) {
  const bucket_start_ms = requireInteger(value.bucket_start_ms,'bucket_start_ms');
  if (bucket_start_ms % settings.bucket_ms) throw new TypeError('Diagnostic bucket is not aligned');
  requireInteger(bucket_start_ms+settings.bucket_ms,'bucket end');
  return { event: 'observer_boundary_unconfirmed',tenant_hash: requireSha256(value.tenant_hash,'tenant_hash'),
    observer_hash: requireSha256(value.observer_hash,'observer_hash'),boundary: requireEnum(value.boundary,DIAGNOSTIC_BOUNDARIES,'boundary'),
    bucket_start_ms,bucket_ms: settings.bucket_ms,settings_hash: diagnosticSettingsHash(settings),
    evidence_class: 'host_observer_self_attested',coverage: 'ingested_unconfirmed_buckets_only',production_qualified: false };
}
const ref = (value) => 'evt_'+sha256Ref({ domain: 'risk-fork-diagnostic-observation-v1',value }).slice(7,55);
export function createManagedDiagnosticObservation(value,settings) {
  closed(value,['tenant_hash','observer_hash','boundary','observed_ms'],'diagnostic observation fields');
  const configured = normalizeDiagnosticSettings(settings), observed = requireInteger(value.observed_ms,'observed_ms');
  const packet = fields({ ...value,bucket_start_ms: Math.floor(observed/configured.bucket_ms)*configured.bucket_ms },configured);
  return Object.freeze({ event_ref: ref(packet),...packet });
}
export function normalizeManagedDiagnosticObservation(value,settings) {
  closed(value,FIELDS,'diagnostic observation');
  const packet = fields(value,normalizeDiagnosticSettings(settings));
  if (Object.entries(packet).some(([key,expected]) => value[key] !== expected) || requireTelemetryRef(value.event_ref) !== ref(packet)) {
    throw new TypeError('Diagnostic observation binding mismatch');
  }
  return Object.freeze({ event_ref: value.event_ref,...packet });
}
