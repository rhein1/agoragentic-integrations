import { sha256Ref } from '../../src/canonical.mjs';
import {
  assertAllowedKeys, assertPlainRecord, deepFreeze, requireInteger, requireIso,
  requireOpaqueRef, requireSha256, requireTenantId,
} from './validation.mjs';

export const MANAGED_BACKLOG_SNAPSHOT_SCHEMA = 'agoragentic.risk-fork.managed-backlog-snapshot.v1';
export const MANAGED_BACKLOG_COUNT_FIELDS = Object.freeze([
  'cleanup_pending_count', 'recovery_required_count', 'expired_execution_lease_count',
  'expired_cleanup_lease_count', 'expired_recovery_lease_count',
]);
const FIELDS = ['schema', 'tenant_id', 'snapshot_at', ...MANAGED_BACKLOG_COUNT_FIELDS,
  'evidence_class', 'production_qualified', 'snapshot_hash'];

export function normalizeBacklogRead(value) {
  assertPlainRecord(value, 'backlog read');
  assertAllowedKeys(value, ['tenant_id', 'claimant_key_id'], 'backlog read');
  return Object.freeze({ tenant_id: requireTenantId(value.tenant_id),
    claimant_key_id: requireOpaqueRef(value.claimant_key_id, 'claimant_key_id') });
}

function normalizeFields(value) {
  if (FIELDS.some((field) => !Object.hasOwn(value, field))
    || value.schema !== MANAGED_BACKLOG_SNAPSHOT_SCHEMA
    || value.evidence_class !== 'control_plane_self_attested'
    || value.production_qualified !== false) throw new TypeError('Invalid backlog snapshot envelope');
  const fields = { schema: value.schema, tenant_id: requireTenantId(value.tenant_id),
    snapshot_at: requireIso(value.snapshot_at, 'backlog snapshot_at') };
  for (const field of MANAGED_BACKLOG_COUNT_FIELDS) fields[field] = requireInteger(value[field], field);
  fields.evidence_class = value.evidence_class;
  fields.production_qualified = false;
  return fields;
}

const hashFor = (fields) => sha256Ref({ domain: 'risk-fork-managed-backlog-snapshot-v1', ...fields });

// A hash binds a single self-attested source snapshot. It is not a signature,
// receipt, durable telemetry commit, cross-read snapshot token or authority.
export function normalizeManagedBacklogSnapshot(value, tenantIdValue) {
  assertPlainRecord(value, 'backlog snapshot');
  assertAllowedKeys(value, FIELDS, 'backlog snapshot');
  const fields = normalizeFields(value);
  if (fields.tenant_id !== requireTenantId(tenantIdValue)) throw new TypeError('Backlog snapshot tenant mismatch');
  if (requireSha256(value.snapshot_hash, 'snapshot_hash') !== hashFor(fields)) throw new TypeError('Backlog snapshot hash mismatch');
  return deepFreeze({ ...fields, snapshot_hash: value.snapshot_hash });
}

export function createManagedBacklogSnapshot(value) {
  assertPlainRecord(value, 'backlog snapshot fields');
  assertAllowedKeys(value, ['tenant_id', 'snapshot_at', ...MANAGED_BACKLOG_COUNT_FIELDS], 'backlog snapshot fields');
  const fields = normalizeFields({ ...value, schema: MANAGED_BACKLOG_SNAPSHOT_SCHEMA,
    evidence_class: 'control_plane_self_attested', production_qualified: false, snapshot_hash: null });
  return normalizeManagedBacklogSnapshot({ ...fields, snapshot_hash: hashFor(fields) }, fields.tenant_id);
}
