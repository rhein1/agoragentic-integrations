import { canonicalize, sha256Ref } from '../../src/canonical.mjs';
import { assertAllowedKeys, assertPlainRecord, deepFreeze, requireInteger, requireIso, requireSha256 } from './validation.mjs';
import { MANAGED_BACKLOG_COUNT_FIELDS, normalizeManagedBacklogSnapshot } from './backlog-snapshot.mjs';
import { lifecycleTenantHash } from './lifecycle-event.mjs';

export function normalizeBacklogSettings(value) {
  assertPlainRecord(value, 'backlog settings');
  assertAllowedKeys(value, ['maxTenants'], 'backlog settings');
  return Object.freeze({ maxTenants: requireInteger(value.maxTenants, 'maxTenants', { min: 1, max: 10_000 }) });
}
export const backlogSettingsHash = (value) => sha256Ref({ domain: 'risk-fork-backlog-settings-v1', ...normalizeBacklogSettings(value) });
export const backlogGaugeHash = (value) => sha256Ref({ domain: 'risk-fork-backlog-gauge-state-v1', ...value });
export const backlogTotalsHash = (count) => sha256Ref({ domain: 'risk-fork-backlog-totals-v1', tenant_count: requireInteger(count, 'tenant_count', { max: 10_000 }) });

const FIELDS = ['schema','tenant_hash','observer_hash','generation','source_snapshot_at','source_snapshot_hash',
  ...MANAGED_BACKLOG_COUNT_FIELDS,'recorded_ms','settings_hash','last_batch_hash','coverage','evidence_class','production_qualified'];
export function normalizeBacklogGauge(value) {
  if (value === null) return null;
  assertPlainRecord(value, 'backlog gauge'); assertAllowedKeys(value, FIELDS, 'backlog gauge');
  if (FIELDS.some((key) => !Object.hasOwn(value,key)) || value.schema !== 'agoragentic.risk-fork.managed-backlog-gauge.v1'
    || value.coverage !== 'tenant_scoped_current_snapshot' || value.evidence_class !== 'control_plane_self_attested'
    || value.production_qualified !== false) throw new TypeError('Invalid backlog gauge');
  const result = { schema: value.schema, tenant_hash: requireSha256(value.tenant_hash,'tenant_hash'),
    observer_hash: requireSha256(value.observer_hash,'observer_hash'), generation: requireInteger(value.generation,'generation',{ min: 1 }),
    source_snapshot_at: requireIso(value.source_snapshot_at,'source_snapshot_at'), source_snapshot_hash: requireSha256(value.source_snapshot_hash,'source_snapshot_hash') };
  for (const key of MANAGED_BACKLOG_COUNT_FIELDS) result[key] = requireInteger(value[key],key);
  result.recorded_ms = requireInteger(value.recorded_ms,'recorded_ms');
  result.settings_hash = requireSha256(value.settings_hash,'settings_hash');
  result.last_batch_hash = requireSha256(value.last_batch_hash,'last_batch_hash');
  return deepFreeze({ ...result, coverage: value.coverage, evidence_class: value.evidence_class, production_qualified: false });
}

// A trusted-host observation, never authority or independent provider evidence.
export function backlogGaugeInput(value, settings) {
  assertPlainRecord(value,'backlog append');
  assertAllowedKeys(value,['tenant_id','observer_hash','expected_state','snapshot'],'backlog append');
  const snapshot = normalizeManagedBacklogSnapshot(value.snapshot,value.tenant_id);
  const tenantHash = lifecycleTenantHash(snapshot.tenant_id), expected = normalizeBacklogGauge(value.expected_state);
  const observerHash = requireSha256(value.observer_hash,'observer_hash'), settingsHash = backlogSettingsHash(settings);
  if (expected && (expected.tenant_hash !== tenantHash || expected.settings_hash !== settingsHash)) throw new TypeError('Backlog expected state scope mismatch');
  const batchHash = sha256Ref({ domain: 'risk-fork-backlog-batch-v1', tenant_hash: tenantHash, observer_hash: observerHash,
    expected_state: expected, snapshot, settings_hash: settingsHash });
  return Object.freeze({ snapshot, tenantHash, observerHash, expected, settingsHash, batchHash });
}
export const sameBacklogState = (a,b) => canonicalize(a) === canonicalize(b);
