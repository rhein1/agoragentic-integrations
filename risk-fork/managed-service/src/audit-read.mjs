import {
  assertAllowedKeys, assertDataArray, assertPlainRecord, cloneJson, deepFreeze,
  requireInteger, requireInvocationRef, requireSha256, requireTenantId,
} from './validation.mjs';

export const MAX_MANAGED_AUDIT_READ = 64;

export function normalizeAuditPageRequest(value = {}) {
  assertPlainRecord(value, 'audit page request');
  assertAllowedKeys(value, ['after_ref', 'upper_ref', 'limit'], 'audit page request');
  const after = value.after_ref == null ? null : requireInvocationRef(value.after_ref, 'after_ref');
  const upper = value.upper_ref == null ? null : requireInvocationRef(value.upper_ref, 'upper_ref');
  if (after === null && upper !== null) {
    throw new TypeError('initial audit page must pin its upper_ref from the store');
  }
  if (after !== null && (upper === null || after > upper)) {
    throw new TypeError('audit page continuation requires its pinned upper_ref');
  }
  return deepFreeze({ after_ref: after, upper_ref: upper,
    limit: requireInteger(Object.hasOwn(value, 'limit') ? value.limit : MAX_MANAGED_AUDIT_READ,
      'audit page limit', { min: 1, max: MAX_MANAGED_AUDIT_READ }) });
}

export function normalizeAuditWindowRequest(value = {}) {
  assertPlainRecord(value, 'audit window request');
  assertAllowedKeys(value, ['after_sequence', 'prior_event_hash', 'limit'], 'audit window request');
  const sequence = requireInteger(Object.hasOwn(value, 'after_sequence') ? value.after_sequence : 0,
    'after_sequence', { max: Number.MAX_SAFE_INTEGER - MAX_MANAGED_AUDIT_READ });
  const prior = value.prior_event_hash == null ? null
    : requireSha256(value.prior_event_hash, 'prior_event_hash');
  if ((sequence === 0) !== (prior === null)) {
    throw new TypeError('audit window requires the exact checkpoint hash, or null at sequence zero');
  }
  return deepFreeze({ after_sequence: sequence, prior_event_hash: prior,
    limit: requireInteger(Object.hasOwn(value, 'limit') ? value.limit : MAX_MANAGED_AUDIT_READ,
      'audit window limit', { min: 1, max: MAX_MANAGED_AUDIT_READ }) });
}

export function verifyAuditInvocationPage(value, tenantIdValue, requestValue = {}) {
  const tenantId = requireTenantId(tenantIdValue);
  const request = normalizeAuditPageRequest(requestValue);
  assertPlainRecord(value, 'audit invocation page');
  assertAllowedKeys(value, ['tenant_id', 'upper_ref', 'invocations', 'complete', 'next_after_ref'],
    'audit invocation page');
  assertDataArray(value.invocations, 'audit invocation page.invocations', { maxLength: request.limit });
  const page = cloneJson(value, 'audit invocation page');
  if (page.tenant_id !== tenantId || typeof page.complete !== 'boolean') {
    throw new Error('Managed audit invocation page scope or completion is invalid');
  }
  const upper = page.upper_ref === null ? null : requireInvocationRef(page.upper_ref, 'page.upper_ref');
  if (request.upper_ref !== null && upper !== request.upper_ref) {
    throw new Error('Managed audit invocation sweep upper bound changed');
  }
  let prior = request.after_ref;
  for (const row of page.invocations) {
    assertPlainRecord(row, 'audit invocation page row');
    assertAllowedKeys(row, ['invocation_ref', 'audit_event_count', 'audit_head_hash'], 'audit invocation page row');
    const ref = requireInvocationRef(row.invocation_ref, 'page.invocation_ref');
    requireInteger(row.audit_event_count, 'page.audit_event_count', { min: 1 });
    requireSha256(row.audit_head_hash, 'page.audit_head_hash');
    if (upper === null || ref > upper || (prior !== null && ref <= prior)) {
      throw new Error('Managed audit invocation page ordering or bounds are invalid');
    }
    prior = ref;
  }
  if (page.next_after_ref !== prior
    || (upper === null && (prior !== null || page.invocations.length !== 0 || !page.complete))
    || (upper !== null && page.complete && prior !== upper)
    || (!page.complete && (page.invocations.length !== request.limit || prior === upper))) {
    throw new Error('Managed audit invocation page is incomplete or has an invalid continuation');
  }
  return deepFreeze(page);
}
