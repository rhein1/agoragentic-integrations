import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';
import { sha256Ref } from '../../src/canonical.mjs';
import { createFixture, invocationRequest } from './helpers.mjs';

function leaseHash(token) {
  return `sha256:${createHash('sha256')
    .update('agoragentic-risk-fork-managed-lease-v1\0').update(token).digest('hex')}`;
}

function storeClaim(invocation, token, overrides = {}) {
  const now = '2026-09-05T12:00:00.000Z';
  return {
    tenant_id: invocation.tenant_id,
    invocation_ref: invocation.invocation_ref,
    claimant_key_id: 'key_alpha',
    worker_id: 'worker_scope_test',
    purpose: 'execution',
    lease_token_hash: leaseHash(token),
    lease_ms: 30_000,
    min_lease_ms: 5_000,
    max_lease_ms: 120_000,
    max_invocation_age_ms: 900_000,
    now,
    expires_at: '2026-09-05T12:00:30.000Z',
    ...overrides,
  };
}

const authorityDenied = (error) => error.code === 'AUTHENTICATION_FAILED';

for (const scopes of [['invocations:write'], ['invocations:write', 'worker:execution:write']]) {
  test(`memory store rejects claim without execution claim scope: ${scopes.join(',')}`, async () => {
    const f = await createFixture({ credentialScopes: scopes });
    const { invocation } = await f.controlPlane.admitInvocation(f.principal, invocationRequest());
    await assert.rejects(f.store.claimLease(storeClaim(invocation, f.nextLeaseToken())), authorityDenied);
    assert.deepEqual(await f.store.getInvocation(invocation.tenant_id, invocation.invocation_ref), invocation);
    assert.equal((await f.store.listAuditEvents(invocation.tenant_id, invocation.invocation_ref)).length, 1);
  });
}

test('an execution-claim-only credential cannot preflight, renew, journal, settle, or retrieve a journal receipt', async () => {
  const f = await createFixture({ credentialScopes: ['invocations:write', 'worker:execution:claim'] });
  const { invocation } = await f.controlPlane.admitInvocation(f.principal, invocationRequest());
  const claim = storeClaim(invocation, f.nextLeaseToken());
  const acquired = await f.store.claimLease(claim);
  const replay = await f.store.claimLease(claim);
  assert.equal(replay.claim_replayed, true);
  assert.deepEqual(replay.invocation, acquired.invocation);
  const before = await f.store.getInvocation(claim.tenant_id, claim.invocation_ref);
  const base = {
    tenant_id: claim.tenant_id,
    invocation_ref: claim.invocation_ref,
    claimant_key_id: claim.claimant_key_id,
    lease_token_hash: claim.lease_token_hash,
    lease_kind: 'execution',
    now: claim.now,
  };
  for (const operation of [
    () => f.store.assertActiveLease({ ...base, lease_kind: 'execution', expected_states: ['execution_leased'] }),
    () => f.store.renewLease({ ...base, lease_ms: 30_000, expires_at: claim.expires_at }),
    () => f.store.transitionInvocation({ ...base, expected_states: ['execution_leased'], next_state: 'running' }),
    () => f.store.settleExecutionOutcome(base),
    () => f.store.findResourceJournalReceipt({ ...base, request_hash: sha256Ref({ journal: true }) }),
  ]) await assert.rejects(operation(), authorityDenied);
  assert.deepEqual(await f.store.getInvocation(claim.tenant_id, claim.invocation_ref), before);
  assert.equal((await f.store.listAuditEvents(claim.tenant_id, claim.invocation_ref)).length, 2);
});
