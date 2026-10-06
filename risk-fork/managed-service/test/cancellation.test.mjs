import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';
import { sha256Ref } from '../../src/canonical.mjs';
import { createCleanupVerificationEvidence } from '../../src/provider.mjs';
import { createManagedServiceHttpHandler, createManagedWorkerHttpHandler } from '../src/http-handler.mjs';
import { createManagedRequestPolicy } from '../src/request-policy.mjs';
import { cancellationAuditDetails, cancellationRequest, planCancellation,
  verifyCancellationObservation } from '../src/cancellation.mjs';
import { createFixture, invocationRequest, TEST_TOKEN } from './helpers.mjs';

const cancellation = (ref, overrides = {}) => ({ invocation_ref: ref,
  idempotency_key: 'cancel-request-00000001', reason_hash: sha256Ref('synthetic owner cancellation'), ...overrides });

async function runningFixture() {
  const fixture = await createFixture();
  const { invocation } = await fixture.controlPlane.admitInvocation(fixture.principal, invocationRequest());
  const execution = await fixture.controlPlane.claimExecution(fixture.principal, {
    invocation_ref: invocation.invocation_ref, worker_id: 'worker_cancel',
    lease_token: fixture.nextLeaseToken(), lease_ms: 30_000,
  });
  fixture.attestResourceBinding(invocation, { savepoint_ref: 'sp_cancel', fork_ref: 'fork_cancel' });
  const running = await fixture.controlPlane.recordResources(fixture.principal, {
    invocation_ref: invocation.invocation_ref, lease_token: execution.lease_token,
    savepoint_ref: 'sp_cancel', fork_ref: 'fork_cancel',
  });
  return { fixture, invocation: running, execution };
}

async function completeCleanup(fixture, ref, verified = true) {
  const cleanup = await fixture.controlPlane.claimCleanup(fixture.principal, {
    invocation_ref: ref, worker_id: 'cleanup_cancel',
    lease_token: fixture.nextLeaseToken(), lease_ms: 30_000,
  });
  const evidence = cleanup.invocation.cleanup_requests.map((request, index) =>
    createCleanupVerificationEvidence(request, {
      status: verified ? 'verified' : 'unknown', observed_at: '2026-09-05T12:00:00.000Z',
      evidence_ref: `cancel_absence_${index}`, observation_hash: sha256Ref({ absent: verified, index }),
    }));
  for (const item of evidence) fixture.attestCleanupEvidence(item);
  return fixture.controlPlane.completeCleanup(fixture.principal, {
    invocation_ref: ref, lease_token: cleanup.lease_token, cleanup_evidence: evidence,
  });
}

test('owner cancellation before claim is exact-replayable and prevents execution', async () => {
  const f = await createFixture({ dailyBudget: 100_000, invocationBudget: 100_000 });
  const { invocation } = await f.controlPlane.admitInvocation(f.principal, invocationRequest());
  const input = cancellation(invocation.invocation_ref);
  const closed = await f.controlPlane.requestCancellation(f.principal, input);
  assert.equal(closed.state, 'failed_closed');
  assert.equal(closed.execution_outcome, null);
  assert.equal(closed.actual_cost_micros, 0);
  assert.equal(closed.cancel_requested_by, f.principal.key_id);
  assert.deepEqual(await f.controlPlane.requestCancellation(f.principal, input), closed);
  await assert.rejects(f.controlPlane.requestCancellation(f.principal, {
    ...input, idempotency_key: 'different-cancel-request-0001',
  }), (e) => e.code === 'CANCELLATION_CONFLICT');
  await assert.rejects(f.controlPlane.claimExecution(f.principal, {
    invocation_ref: invocation.invocation_ref, worker_id: 'late_worker',
    lease_token: f.nextLeaseToken(), lease_ms: 30_000,
  }), (e) => e.code === 'INVOCATION_NOT_CLAIMABLE');
  // The original budget reservation was released, not charged to a provider.
  assert.equal((await f.controlPlane.admitInvocation(f.principal,
    invocationRequest({ idempotency_key: 'new-admission-after-cancel-0001' }))).created, true);
  const events = await f.controlPlane.listAuditEvents(f.principal, invocation.invocation_ref);
  assert.equal(events.filter((e) => e.event_type === 'cancellation_requested').length, 1);
});

test('only the current admitted key can cancel; scope, tenant and caller refs fail closed', async () => {
  const f = await createFixture();
  const { invocation } = await f.controlPlane.admitInvocation(f.principal, invocationRequest());
  const input = cancellation(invocation.invocation_ref);
  await assert.rejects(f.controlPlane.requestCancellation(f.sameTenantPrincipal, input),
    (e) => e.code === 'CANCELLATION_OWNER_MISMATCH');
  await assert.rejects(f.controlPlane.requestCancellation(f.otherPrincipal, input),
    (e) => e.code === 'INVOCATION_NOT_FOUND');
  await assert.rejects(f.controlPlane.requestCancellation(f.recoveryPrincipal, input),
    (e) => e.code === 'AUTHORIZATION_DENIED');
  for (const field of ['fork_ref', 'provider_recovery_key', 'provider_binding_hash']) {
    await assert.rejects(f.controlPlane.requestCancellation(f.principal, { ...input, [field]: 'forged' }), TypeError);
  }
  assert.equal((await f.controlPlane.getInvocation(f.principal, invocation.invocation_ref)).state, 'admitted');
});

test('unknown in-flight resources keep recovery and conservative cost; stale writes are rejected', async () => {
  const f = await createFixture();
  const { invocation } = await f.controlPlane.admitInvocation(f.principal, invocationRequest());
  const claim = await f.controlPlane.claimExecution(f.principal, {
    invocation_ref: invocation.invocation_ref, worker_id: 'unknown_cancel',
    lease_token: f.nextLeaseToken(), lease_ms: 30_000,
  });
  const canceled = await f.controlPlane.requestCancellation(f.principal, cancellation(invocation.invocation_ref));
  assert.equal(canceled.state, 'recovery_required');
  assert.equal(canceled.execution_outcome, 'ambiguous');
  assert.equal(canceled.actual_cost_micros, invocation.estimated_cost_micros);
  assert.equal(canceled.provider_recovery_key, invocation.provider_recovery_key);
  assert.equal(canceled.lease_kind, null);
  await assert.rejects(f.controlPlane.renewLease(f.principal, {
    invocation_ref: invocation.invocation_ref, lease_token: claim.lease_token, lease_ms: 30_000,
  }));
  await assert.rejects(f.controlPlane.recordResources(f.principal, {
    invocation_ref: invocation.invocation_ref, lease_token: claim.lease_token, savepoint_ref: 'late_savepoint',
  }));
  await assert.rejects(f.controlPlane.admitInvocation(f.principal,
    invocationRequest({ idempotency_key: 'blocked-by-cancellation-recovery' })),
  (e) => e.code === 'TENANT_RECOVERY_REQUIRED');
  assert.equal((await f.controlPlane.claimRecovery(f.recoveryPrincipal, {
    invocation_ref: invocation.invocation_ref, worker_id: 'cancel_recovery',
    lease_token: f.nextLeaseToken(), lease_ms: 30_000,
  })).invocation.state, 'recovery_required');
});

test('known in-flight cancellation requires verified exact cleanup, not a cancel acknowledgement', async () => {
  const { fixture: f, invocation, execution } = await runningFixture();
  const canceled = await f.controlPlane.requestCancellation(f.principal, cancellation(invocation.invocation_ref));
  assert.equal(canceled.state, 'cleanup_pending');
  assert.equal(canceled.execution_outcome, 'ambiguous');
  assert.deepEqual(canceled.cleanup_requests, invocation.cleanup_requests);
  await assert.rejects(f.controlPlane.recordExecutionOutcome(f.principal, {
    invocation_ref: invocation.invocation_ref, lease_token: execution.lease_token,
    outcome: 'succeeded', actual_cost_micros: 0,
    execution_evidence_hash: sha256Ref('late'), result_hash: sha256Ref('late result'),
  }));
  const terminal = await completeCleanup(f, invocation.invocation_ref);
  assert.equal(terminal.state, 'failed_closed');
  assert.equal(terminal.execution_outcome, 'ambiguous');
  assert.equal(terminal.cancel_request_hash, canceled.cancel_request_hash);
  assert.equal((await f.controlPlane.listAuditEvents(f.principal, invocation.invocation_ref)).at(-1).event_type,
    'cleanup_verified');
});

test('cancellation after settled execution preserves truth but prevents completed result import', async () => {
  const { fixture: f, invocation, execution } = await runningFixture();
  await f.controlPlane.recordExecutionOutcome(f.principal, {
    invocation_ref: invocation.invocation_ref, lease_token: execution.lease_token,
    outcome: 'succeeded', actual_cost_micros: 12,
    execution_evidence_hash: sha256Ref('actual execution'), result_hash: sha256Ref('actual result'),
  });
  const canceled = await f.controlPlane.requestCancellation(f.principal, cancellation(invocation.invocation_ref));
  assert.equal(canceled.execution_outcome, 'succeeded');
  assert.equal(canceled.actual_cost_micros, 12);
  const terminal = await completeCleanup(f, invocation.invocation_ref);
  assert.equal(terminal.state, 'failed_closed');
  assert.equal(terminal.execution_outcome, 'succeeded');
});

test('public cancellation URL binds the target and is absent from the worker surface', async () => {
  const f = await createFixture();
  const { invocation } = await f.controlPlane.admitInvocation(f.principal, invocationRequest());
  const publicHandler = createManagedServiceHttpHandler({ controlPlane: f.controlPlane, authenticator: f.authenticator });
  const workerHandler = createManagedWorkerHttpHandler({ controlPlane: f.controlPlane, workerAuthenticator: f.authenticator });
  const { invocation_ref: ref, ...body } = cancellation(invocation.invocation_ref);
  const request = { method: 'POST', path: `/v1/invocations/${ref}/cancel`,
    headers: { authorization: `Bearer ${TEST_TOKEN}`, 'content-type': 'application/json' },
    body: JSON.stringify(body) };
  assert.equal((await workerHandler(request)).status, 404);
  assert.equal((await publicHandler({ ...request, body: JSON.stringify({ ...body, invocation_ref: 'other' }) })).status, 400);
  const response = await publicHandler(request);
  assert.equal(response.status, 200);
  assert.equal(response.body.state, 'failed_closed');
});

test('disabled execution policy still permits authenticated bounded owner cancellation through recovery quota', async () => {
  const f = await createFixture();
  const { invocation } = await f.controlPlane.admitInvocation(f.principal, invocationRequest());
  const routes = [];
  const requestPolicy = createManagedRequestPolicy({
    readControl: async () => ({ enabled: false, epoch: 1 }),
    consumeRateLimit: async ({ route_class: route }) => {
      routes.push(route); return { allowed: true, retry_after_seconds: 0 };
    }, emitTelemetry: async () => {},
  });
  const handler = createManagedServiceHttpHandler({ controlPlane: f.controlPlane, authenticator: f.authenticator, requestPolicy });
  const { invocation_ref: ref, ...body } = cancellation(invocation.invocation_ref);
  const request = { method: 'POST', path: `/v1/invocations/${ref}/cancel`,
    headers: { authorization: `Bearer ${TEST_TOKEN}`, 'content-type': 'application/json' }, body: JSON.stringify(body) };
  assert.equal((await handler({ ...request, headers: { 'content-type': 'application/json' } })).status, 401);
  assert.deepEqual(routes, [], 'unauthenticated requests do not consume recovery quota');
  const response = await handler(request);
  assert.equal(response.status, 200);
  assert.equal(response.body.state, 'failed_closed');
  assert.deepEqual(routes, ['recovery']);
});

test('cancellation observation binds the original execution principal, token and generation', async () => {
  const f = await createFixture();
  const { invocation } = await f.controlPlane.admitInvocation(f.principal, invocationRequest());
  const claim = await f.controlPlane.claimExecution(f.sameTenantPrincipal, {
    invocation_ref: invocation.invocation_ref, worker_id: 'separate_cancel_worker',
    lease_token: f.nextLeaseToken(), lease_ms: 30_000,
  });
  const observation = { invocation_ref: invocation.invocation_ref,
    lease_token: claim.lease_token, lease_generation: claim.invocation.lease_generation };
  assert.equal((await f.controlPlane.observeExecutionCancellation(f.sameTenantPrincipal, observation)).cancel_requested, false);
  await assert.rejects(f.controlPlane.observeExecutionCancellation(f.principal, observation));
  await assert.rejects(f.controlPlane.observeExecutionCancellation(f.sameTenantPrincipal,
    { ...observation, lease_token: f.nextLeaseToken('wrong_observer') }));
  await assert.rejects(f.controlPlane.observeExecutionCancellation(f.sameTenantPrincipal,
    { ...observation, lease_generation: observation.lease_generation + 1 }));
  await f.controlPlane.requestCancellation(f.principal, cancellation(invocation.invocation_ref));
  const observed = await f.controlPlane.observeExecutionCancellation(f.sameTenantPrincipal, observation);
  assert.equal(observed.cancel_requested, true);
  assert.equal(observed.lease_generation, observation.lease_generation);
  assert.equal(Object.hasOwn(observed, 'lease_token'), false);
  assert.equal(Object.hasOwn(observed, 'operation'), false);
  await assert.rejects(f.controlPlane.observeExecutionCancellation(f.principal, observation));
  await assert.rejects(f.controlPlane.observeExecutionCancellation(f.sameTenantPrincipal,
    { ...observation, lease_token: f.nextLeaseToken('wrong_canceled_observer') }));
  await f.controlPlane.claimRecovery(f.recoveryPrincipal, {
    invocation_ref: invocation.invocation_ref, worker_id: 'new_generation_recovery',
    lease_token: f.nextLeaseToken(), lease_ms: 30_000,
  });
  await assert.rejects(f.controlPlane.observeExecutionCancellation(f.sameTenantPrincipal, observation),
    (e) => e.code === 'CANCELLATION_OBSERVATION_STALE');
});

test('cancellation acknowledgement and unknown absence do not complete cleanup', async () => {
  const { fixture: f, invocation } = await runningFixture();
  await f.controlPlane.requestCancellation(f.principal, cancellation(invocation.invocation_ref));
  await assert.rejects(completeCleanup(f, invocation.invocation_ref, false),
    (e) => e.code === 'CLEANUP_NOT_VERIFIED');
  assert.equal((await f.controlPlane.getInvocation(f.principal, invocation.invocation_ref)).state, 'cleanup_pending');
});

test('cancellation preserves an already-authorized cleanup lease and settled execution truth', async () => {
  const { fixture: f, invocation, execution } = await runningFixture();
  await f.controlPlane.recordExecutionOutcome(f.principal, {
    invocation_ref: invocation.invocation_ref, lease_token: execution.lease_token,
    outcome: 'succeeded', actual_cost_micros: 12,
    execution_evidence_hash: sha256Ref('settled before cleanup cancellation'), result_hash: sha256Ref('settled result'),
  });
  const cleanup = await f.controlPlane.claimCleanup(f.sameTenantPrincipal, {
    invocation_ref: invocation.invocation_ref, worker_id: 'already_cleanup',
    lease_token: f.nextLeaseToken(), lease_ms: 30_000,
  });
  const canceled = await f.controlPlane.requestCancellation(f.principal, cancellation(invocation.invocation_ref));
  assert.equal(canceled.lease_kind, 'cleanup');
  assert.equal(canceled.lease_generation, cleanup.invocation.lease_generation);
  assert.equal(canceled.lease_owner, f.sameTenantPrincipal.key_id);
  const evidence = cleanup.invocation.cleanup_requests.map((request) => createCleanupVerificationEvidence(request, {
    status: 'verified', observed_at: '2026-09-05T12:00:00.000Z',
    evidence_ref: `already_cleanup_${request.resource_kind}`, observation_hash: sha256Ref(request),
  }));
  for (const item of evidence) f.attestCleanupEvidence(item);
  const terminal = await f.controlPlane.completeCleanup(f.sameTenantPrincipal, {
    invocation_ref: invocation.invocation_ref, lease_token: cleanup.lease_token, cleanup_evidence: evidence,
  });
  assert.equal(terminal.state, 'failed_closed');
  assert.equal(terminal.execution_outcome, 'succeeded');
  assert.equal(terminal.actual_cost_micros, 12);
  assert.equal(terminal.cancel_request_hash, canceled.cancel_request_hash);
});

test('interrupted running work with incomplete resource custody still observes its exact cancellation', async () => {
  const { fixture: f, invocation, execution } = await runningFixture();
  const tokenHash = `sha256:${createHash('sha256').update('agoragentic-risk-fork-managed-lease-v1\0')
    .update(execution.lease_token).digest('hex')}`;
  const original = { ...invocation, fork_ref: null, cleanup_requests: invocation.cleanup_requests.slice(1),
    lease_token_hash: tokenHash, tenant_status: 'active' };
  const plan = planCancellation(original,
    cancellationRequest(original, f.principal.key_id, cancellation(invocation.invocation_ref)),
    '2026-09-05T12:00:00.000Z');
  assert.equal(plan.state, 'recovery_required');
  const record = { ...original, ...plan, lease_kind: null, lease_owner: null, lease_token_hash: null };
  const observed = verifyCancellationObservation(record, {
    tenant_id: f.principal.tenant_id, claimant_key_id: f.principal.key_id,
    invocation_ref: invocation.invocation_ref, lease_token_hash: tokenHash,
    lease_generation: invocation.lease_generation,
  }, '2026-09-05T12:00:00.000Z', { count: 1, details_hash: sha256Ref(cancellationAuditDetails(original, plan)) });
  assert.equal(observed.cancel_requested, true);
  assert.equal(observed.state, 'recovery_required');
});
