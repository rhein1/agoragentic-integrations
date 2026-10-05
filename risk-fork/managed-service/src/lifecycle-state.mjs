import { sha256Ref } from '../../src/canonical.mjs';
import { assertAllowedKeys, assertPlainRecord, requireInteger, requireInvocationRef, requireSha256 } from './validation.mjs';

export function lifecycleScope(value) {
  assertPlainRecord(value,'lifecycle scope'); assertAllowedKeys(value,['observer_hash','tenant_hash'],'lifecycle scope');
  return Object.freeze({ observer_hash: requireSha256(value.observer_hash,'observer_hash'),tenant_hash: requireSha256(value.tenant_hash,'tenant_hash') });
}
export function lifecycleCheckpoint(value) {
  if (value === null) return null;
  assertPlainRecord(value,'lifecycle checkpoint');
  assertAllowedKeys(value,['sequence','event_hash'],'lifecycle checkpoint');
  return Object.freeze({ sequence: requireInteger(value.sequence,'checkpoint sequence',{ min: 1,max: 2_147_483_647 }),
    event_hash: requireSha256(value.event_hash,'checkpoint event_hash') });
}
export function lifecycleSweep(value) {
  if (value === null) return null;
  assertPlainRecord(value,'lifecycle sweep');
  assertAllowedKeys(value,['version','cycle','after_ref','upper_ref','prefix_count','last_batch_hash'],'lifecycle sweep');
  const after = value.after_ref === null ? null : requireInvocationRef(value.after_ref);
  const upper = value.upper_ref === null ? null : requireInvocationRef(value.upper_ref);
  if ((after === null) !== (upper === null) || (after !== null && after > upper)) throw new TypeError('Lifecycle sweep bounds disagree');
  return Object.freeze({ version: requireInteger(value.version,'sweep version',{ min: 1 }),
    cycle: requireInteger(value.cycle,'sweep cycle'),after_ref: after,upper_ref: upper,
    prefix_count: requireInteger(value.prefix_count,'prefix_count',{ max: 1_000_000 }),
    last_batch_hash: requireSha256(value.last_batch_hash,'last_batch_hash') });
}
export const lifecycleStateHash = (scope, value) => sha256Ref({ domain: 'risk-fork-lifecycle-custody-v1',...lifecycleScope(scope),value });
