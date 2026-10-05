import { sha256Ref } from '../../src/canonical.mjs';
import { MANAGED_AUDIT_EVENT_SCHEMA } from './constants.mjs';
import { normalizeAuditWindowRequest } from './audit-read.mjs';
import {
  assertAllowedKeys,
  assertDataArray,
  assertPlainRecord,
  cloneJson,
  deepFreeze,
  requireInteger,
  requireInvocationRef,
  requireIso,
  requireOpaqueRef,
  requireSha256,
  requireTenantId,
} from './validation.mjs';

export function createManagedAuditEvent(input = {}) {
  assertPlainRecord(input, 'audit event input');
  assertAllowedKeys(input, [
    'event_ref',
    'tenant_id',
    'invocation_ref',
    'sequence',
    'event_type',
    'occurred_at',
    'details',
    'prior_event_hash',
  ], 'audit event input');
  const details = cloneJson(input.details ?? {}, 'audit event details');
  const event = {
    schema: MANAGED_AUDIT_EVENT_SCHEMA,
    event_ref: requireOpaqueRef(input.event_ref, 'audit event.event_ref'),
    tenant_id: requireTenantId(input.tenant_id, 'audit event.tenant_id'),
    invocation_ref: requireInvocationRef(
      input.invocation_ref,
      'audit event.invocation_ref',
    ),
    sequence: requireInteger(input.sequence, 'audit event.sequence', { min: 1 }),
    event_type: requireOpaqueRef(input.event_type, 'audit event.event_type'),
    occurred_at: requireIso(input.occurred_at, 'audit event.occurred_at'),
    details_hash: sha256Ref(details),
    prior_event_hash: input.prior_event_hash == null
      ? null
      : requireSha256(input.prior_event_hash, 'audit event.prior_event_hash'),
    evidence_class: 'control_plane_self_attested',
    event_hash: null,
  };
  event.event_hash = sha256Ref(event);
  return deepFreeze(event);
}

export function verifyManagedAuditChain(events) {
  assertDataArray(events, 'audit events');
  const snapshot = cloneJson(events, 'audit events');
  if (snapshot.length === 0) {
    throw new Error('Managed audit chain must contain at least one event');
  }
  verifyAuditEvents(snapshot);
  return true;
}

function verifyAuditEvents(snapshot, {
  prior = null, tenantId = null, invocationRef = null, occurredAt = null, sequence = 0,
} = {}) {
  for (let index = 0; index < snapshot.length; index += 1) {
    const event = snapshot[index];
    assertPlainRecord(event, `audit events[${index}]`);
    assertAllowedKeys(event, [
      'schema',
      'event_ref',
      'tenant_id',
      'invocation_ref',
      'sequence',
      'event_type',
      'occurred_at',
      'details_hash',
      'prior_event_hash',
      'evidence_class',
      'event_hash',
    ], `audit events[${index}]`);
    if (event.schema !== MANAGED_AUDIT_EVENT_SCHEMA
      || event.evidence_class !== 'control_plane_self_attested') {
      throw new Error('Managed audit event schema or evidence class is invalid');
    }
    requireOpaqueRef(event.event_ref, `audit events[${index}].event_ref`);
    requireOpaqueRef(event.event_type, `audit events[${index}].event_type`);
    requireSha256(event.details_hash, `audit events[${index}].details_hash`);
    requireSha256(event.event_hash, `audit events[${index}].event_hash`);
    if (event.prior_event_hash !== null) {
      requireSha256(event.prior_event_hash, `audit events[${index}].prior_event_hash`);
    }
    const currentTenant = requireTenantId(event.tenant_id, `audit events[${index}].tenant_id`);
    const currentInvocation = requireInvocationRef(
      event.invocation_ref,
      `audit events[${index}].invocation_ref`,
    );
    tenantId ??= currentTenant;
    invocationRef ??= currentInvocation;
    if (currentTenant !== tenantId || currentInvocation !== invocationRef) {
      throw new Error('Managed audit chain crosses a tenant or invocation boundary');
    }
    const currentOccurredAt = requireIso(event.occurred_at, `audit events[${index}].occurred_at`);
    if (occurredAt !== null && currentOccurredAt < occurredAt) {
      throw new Error('Managed audit event time moves backward');
    }
    if (event.sequence !== sequence + index + 1 || event.prior_event_hash !== prior) {
      throw new Error('Managed audit chain sequence or predecessor mismatch');
    }
    const expected = sha256Ref({ ...event, event_hash: null });
    if (event.event_hash !== expected) {
      throw new Error('Managed audit event hash mismatch');
    }
    prior = event.event_hash;
    occurredAt = currentOccurredAt;
  }
  return { prior, occurredAt };
}

// A later window is anchored to a previously verified prefix. It does not
// re-verify historical rows before that checkpoint or independently attest
// provider effects. The terminal window must match the atomic source anchor.
export function verifyManagedAuditWindow(value, options) {
  assertPlainRecord(options, 'audit window verification options');
  assertAllowedKeys(options, ['tenant_id', 'invocation_ref', 'after_sequence', 'prior_event_hash', 'limit'],
    'audit window verification options');
  const tenantId = requireTenantId(options.tenant_id);
  const invocationRef = requireInvocationRef(options.invocation_ref, 'invocation_ref');
  const request = normalizeAuditWindowRequest({
    after_sequence: Object.hasOwn(options, 'after_sequence') ? options.after_sequence : 0,
    prior_event_hash: options.prior_event_hash ?? null,
    ...(Object.hasOwn(options, 'limit') ? { limit: options.limit } : {}),
  });
  assertPlainRecord(value, 'audit window');
  assertAllowedKeys(value, ['tenant_id', 'invocation_ref', 'audit_event_count', 'audit_head_hash',
    'prior_event', 'events'], 'audit window');
  assertDataArray(value.events, 'audit window.events', { maxLength: request.limit });
  const snapshot = cloneJson(value, 'audit window');
  if (snapshot.tenant_id !== tenantId || snapshot.invocation_ref !== invocationRef) {
    throw new Error('Managed audit window crosses a tenant or invocation boundary');
  }
  const count = requireInteger(snapshot.audit_event_count, 'audit window.audit_event_count', { min: 1 });
  const head = requireSha256(snapshot.audit_head_hash, 'audit window.audit_head_hash');
  if (request.after_sequence > count
    || snapshot.events.length !== Math.min(request.limit, count - request.after_sequence)) {
    throw new Error('Managed audit window is truncated or its checkpoint is ahead of the source');
  }
  let occurredAt = null;
  if (request.after_sequence === 0) {
    if (snapshot.prior_event !== null) throw new Error('Managed audit genesis has a predecessor');
  } else {
    assertPlainRecord(snapshot.prior_event, 'audit window.prior_event');
    const anchor = snapshot.prior_event;
    if (anchor.event_hash !== request.prior_event_hash
      || (request.after_sequence === 1) !== (anchor.prior_event_hash === null)) {
      throw new Error('Managed audit checkpoint hash or predecessor is inconsistent');
    }
    ({ occurredAt } = verifyAuditEvents([anchor], {
      tenantId, invocationRef, sequence: request.after_sequence - 1, prior: anchor.prior_event_hash,
    }));
  }
  const verified = verifyAuditEvents(snapshot.events, {
    tenantId, invocationRef, sequence: request.after_sequence, prior: request.prior_event_hash, occurredAt,
  });
  const next = request.after_sequence + snapshot.events.length;
  const complete = next === count;
  if (complete && verified.prior !== head) throw new Error('Managed audit window source tail is inconsistent');
  return deepFreeze({
    ...snapshot, complete, next_after_sequence: next, next_prior_event_hash: verified.prior,
  });
}
