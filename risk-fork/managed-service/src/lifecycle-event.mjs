import { sha256Ref } from '../../src/canonical.mjs';
import { assertAllowedKeys, assertPlainRecord, requireInteger, requireIso, requireOpaqueRef, requireSha256 } from './validation.mjs';
import { requireTelemetryRef } from './telemetry-event.mjs';

const FIELDS = ['event_ref','event','tenant_hash','invocation_hash','source_sequence','source_event_hash',
  'source_event_type','occurred_at','evidence_class'];
// Actual current control-plane writers, not semantic success aliases. Unknown
// future labels stop projection until reviewed; never export arbitrary text.
export const LIFECYCLE_SOURCE_EVENT_TYPES = Object.freeze(['invocation_admitted','stale_admission_expired',
  ...['execution','cleanup','recovery'].flatMap((kind) => ['claimed','renewed','expired'].map((action) => `${kind}_lease_${action}`)),
  'provider_resource_journaled','provider_resources_recorded','provider_resources_recovered',
  'execution_outcome_recorded','execution_failure_observed','cleanup_verified','cleanup_incomplete','recovery_absence_verified','cancellation_requested']);
export const lifecycleTenantHash = (tenant) => sha256Ref({ domain: 'risk-fork-lifecycle-tenant-v1',tenant });
export const lifecycleInvocationHash = (tenantHash, ref) => sha256Ref({ domain: 'risk-fork-lifecycle-invocation-v1',tenant_hash: tenantHash,invocation_ref: ref });
function refFor(fields) { return `evt_${sha256Ref({ domain: 'risk-fork-lifecycle-event-v1',...fields }).slice(7,55)}`; }

// This is an observation of an audit label, never a success/effect/cleanup
// receipt. No details, tokens, provider identifiers or raw source references.
export function normalizeManagedLifecycleEvent(value) {
  assertPlainRecord(value,'lifecycle event'); assertAllowedKeys(value,FIELDS,'lifecycle event');
  if (FIELDS.some((field) => !Object.hasOwn(value,field)) || value.event !== 'control_plane_audit_observed'
    || value.evidence_class !== 'control_plane_self_attested' || !LIFECYCLE_SOURCE_EVENT_TYPES.includes(value.source_event_type)) throw new TypeError('Invalid lifecycle observation');
  const fields = { event: value.event,tenant_hash: requireSha256(value.tenant_hash,'tenant_hash'),
    invocation_hash: requireSha256(value.invocation_hash,'invocation_hash'),
    source_sequence: requireInteger(value.source_sequence,'source_sequence',{ min: 1,max: 2_147_483_647 }),
    source_event_hash: requireSha256(value.source_event_hash,'source_event_hash'),
    source_event_type: requireOpaqueRef(value.source_event_type,'source_event_type'),
    occurred_at: requireIso(value.occurred_at,'occurred_at'),evidence_class: value.evidence_class };
  if (requireTelemetryRef(value.event_ref) !== refFor(fields)) throw new TypeError('Lifecycle identity mismatch');
  return Object.freeze({ event_ref: value.event_ref,...fields });
}

export function projectManagedLifecycleEvent(source) {
  const tenantHash = lifecycleTenantHash(source.tenant_id);
  const fields = { event: 'control_plane_audit_observed',tenant_hash: tenantHash,
    invocation_hash: lifecycleInvocationHash(tenantHash,source.invocation_ref),source_sequence: source.sequence,
    source_event_hash: source.event_hash,source_event_type: source.event_type,occurred_at: source.occurred_at,
    evidence_class: 'control_plane_self_attested' };
  return normalizeManagedLifecycleEvent({ event_ref: refFor(fields),...fields });
}
