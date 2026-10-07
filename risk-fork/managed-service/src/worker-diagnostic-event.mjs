import { sha256Ref } from '../../src/canonical.mjs';
import { assertAllowedKeys, assertDataArray, assertPlainRecord, deepFreeze, requireEnum, requireInteger, requireSha256 } from './validation.mjs';
import { requireTelemetryRef } from './telemetry-event.mjs';

// Closed driver-owned phases, not provider causes or authority/effect outcomes.
export const WORKER_DIAGNOSTIC_BOUNDARIES = Object.freeze(['lease_fence','cancellation_read','provider_call','broker_contract',
  'resource_journal','cleanup_completion','cleanup_incomplete_append','recovery_lookup','recovery_absence_completion',
  'preparation_read','cost_read','execution_outcome']);
export const WORKER_DIAGNOSTIC_RULE_IDS = Object.freeze(WORKER_DIAGNOSTIC_BOUNDARIES.map((name) => 'worker_'+name+'_unconfirmed'));
function closed(value,keys,label) {
  assertPlainRecord(value,label); assertAllowedKeys(value,keys,label);
  if (keys.some((key) => !Object.hasOwn(value,key))) throw new TypeError(label+' requires own fields');
}
export function normalizeWorkerDiagnosticSettings(value) {
  closed(value,['bucket_ms','max_age_ms','max_future_ms','rules'],'worker diagnostic settings');
  const bucket_ms = requireInteger(value.bucket_ms,'bucket_ms',{ min: 1000,max: 60000 });
  const max_age_ms = requireInteger(value.max_age_ms,'max_age_ms',{ min: bucket_ms,max: 86400000 });
  const max_future_ms = requireInteger(value.max_future_ms,'max_future_ms',{ max: 30000 });
  const source = assertDataArray(value.rules,'worker diagnostic rules',{ maxLength: WORKER_DIAGNOSTIC_RULE_IDS.length }), ids = new Set();
  if (!source.length) throw new TypeError('Worker diagnostic rules must not be empty');
  const rules = source.map((rule) => {
    closed(rule,['rule_id','threshold','window_ms'],'worker diagnostic rule');
    const rule_id = requireEnum(rule.rule_id,WORKER_DIAGNOSTIC_RULE_IDS,'rule_id');
    if (ids.has(rule_id)) throw new TypeError('Duplicate worker diagnostic rule'); ids.add(rule_id);
    const window_ms = requireInteger(rule.window_ms,'window_ms',{ min: bucket_ms,max: 86400000 });
    if (window_ms % bucket_ms) throw new TypeError('Worker diagnostic window must contain whole buckets');
    return { rule_id,threshold: requireInteger(rule.threshold,'threshold',{ min: 1,max: 1000000 }),window_ms };
  }).sort((a,b) => a.rule_id < b.rule_id ? -1 : a.rule_id > b.rule_id ? 1 : 0);
  return deepFreeze({ bucket_ms,max_age_ms,max_future_ms,rules });
}
export const workerDiagnosticSettingsHash = (settings) => sha256Ref({ domain: 'risk-fork-worker-diagnostic-settings-v1',settings: normalizeWorkerDiagnosticSettings(settings) });
export const workerDiagnosticRulesHash = (settings) => sha256Ref({ domain: 'risk-fork-worker-diagnostic-rules-v1',settings: normalizeWorkerDiagnosticSettings(settings) });
const FIELDS = ['event_ref','event','tenant_hash','worker_hash','boundary','bucket_start_ms','bucket_ms','settings_hash','evidence_class','coverage','production_qualified'];
function fields(value,settings) {
  const bucket_start_ms = requireInteger(value.bucket_start_ms,'bucket_start_ms');
  if (bucket_start_ms % settings.bucket_ms) throw new TypeError('Worker diagnostic bucket is not aligned');
  requireInteger(bucket_start_ms+settings.bucket_ms,'bucket end');
  return { event: 'worker_boundary_unconfirmed',tenant_hash: requireSha256(value.tenant_hash,'tenant_hash'),
    worker_hash: requireSha256(value.worker_hash,'worker_hash'),boundary: requireEnum(value.boundary,WORKER_DIAGNOSTIC_BOUNDARIES,'boundary'),
    bucket_start_ms,bucket_ms: settings.bucket_ms,settings_hash: workerDiagnosticSettingsHash(settings),
    evidence_class: 'host_worker_self_attested',coverage: 'ingested_unconfirmed_buckets_only',production_qualified: false };
}
const ref = (value) => 'evt_'+sha256Ref({ domain: 'risk-fork-worker-diagnostic-observation-v1',value }).slice(7,55);
export function createManagedWorkerDiagnosticObservation(value,settings) {
  closed(value,['tenant_hash','worker_hash','boundary','observed_ms'],'worker diagnostic observation fields');
  const configured = normalizeWorkerDiagnosticSettings(settings), now = requireInteger(value.observed_ms,'observed_ms');
  const packet = fields({ ...value,bucket_start_ms: Math.floor(now/configured.bucket_ms)*configured.bucket_ms },configured);
  return Object.freeze({ event_ref: ref(packet),...packet });
}
export function normalizeManagedWorkerDiagnosticObservation(value,settings) {
  closed(value,FIELDS,'worker diagnostic observation');
  const packet = fields(value,normalizeWorkerDiagnosticSettings(settings));
  if (Object.entries(packet).some(([key,expected]) => value[key] !== expected) || requireTelemetryRef(value.event_ref) !== ref(packet)) {
    throw new TypeError('Worker diagnostic observation binding mismatch');
  }
  return Object.freeze({ event_ref: value.event_ref,...packet });
}
