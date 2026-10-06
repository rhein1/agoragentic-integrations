import test from 'node:test';
import assert from 'node:assert/strict';
import { sha256Ref } from '../../src/canonical.mjs';
import { createCleanupVerificationEvidence } from '../../src/provider.mjs';
import { verifyManagedAuditChain } from '../src/audit.mjs';
import { createManagedRiskForkWorker } from '../src/worker.mjs';
import { createManagedServiceHttpHandler, createManagedWorkerHttpHandler } from '../src/http-handler.mjs';
import { projectManagedLifecycleEvent } from '../src/lifecycle-event.mjs';
import { matchingMetricRules } from '../src/metric-event.mjs';
import { createFixture, invocationRequest, TestProvider, TEST_TOKEN } from './helpers.mjs';

async function pending(fixture) {
  const admitted = (await fixture.controlPlane.admitInvocation(fixture.principal, invocationRequest())).invocation;
  const execution = await fixture.controlPlane.claimExecution(fixture.principal, {
    invocation_ref: admitted.invocation_ref, lease_token: fixture.nextLeaseToken(), worker_id: 'incomplete_execution', lease_ms: 30_000,
  });
  fixture.attestResourceBinding(admitted, { savepoint_ref: 'incomplete_savepoint', fork_ref: 'incomplete_fork' });
  await fixture.controlPlane.recordResources(fixture.principal, { invocation_ref: admitted.invocation_ref,
    lease_token: execution.lease_token, savepoint_ref: 'incomplete_savepoint', fork_ref: 'incomplete_fork' });
  await fixture.controlPlane.recordExecutionOutcome(fixture.principal, { invocation_ref: admitted.invocation_ref,
    lease_token: execution.lease_token, outcome: 'succeeded', actual_cost_micros: 0,
    execution_evidence_hash: sha256Ref('incomplete_execution'), result_hash: sha256Ref('incomplete_result') });
  return admitted.invocation_ref;
}

async function claimed(fixture) {
  const ref = await pending(fixture);
  const cleanup = await fixture.controlPlane.claimCleanup(fixture.principal, { invocation_ref: ref,
    lease_token: fixture.nextLeaseToken(), worker_id: 'incomplete_cleanup', lease_ms: 5_000 });
  return { ref, cleanup, input: { invocation_ref: ref, lease_token: cleanup.lease_token, lease_generation: cleanup.invocation.lease_generation } };
}

const observations = async (fixture, ref) => (await fixture.store.listAuditEvents(fixture.tenant.tenant_id, ref))
  .filter((event) => event.event_type === 'cleanup_incomplete');

test('cleanup incompletion is one exact audit event per active generation, including concurrent/lost-response replay', async () => {
  const fixture = await createFixture(); const { ref, input } = await claimed(fixture);
  const before = await fixture.controlPlane.getInvocation(fixture.principal, ref);
  const [a, b] = await Promise.all([fixture.controlPlane.recordCleanupIncomplete(fixture.principal, input),
    fixture.controlPlane.recordCleanupIncomplete(fixture.principal, input)]);
  assert.deepEqual(a, b); assert.equal((await observations(fixture, ref)).length, 1);
  const loseAcknowledgement = async () => { await fixture.controlPlane.recordCleanupIncomplete(fixture.principal, input); throw new Error('lost observation response'); };
  await assert.rejects(loseAcknowledgement());
  assert.deepEqual(await fixture.controlPlane.recordCleanupIncomplete(fixture.principal, input), a);
  const after = await fixture.controlPlane.getInvocation(fixture.principal, ref);
  assert.deepEqual({ ...after, audit_event_count: before.audit_event_count, audit_head_hash: before.audit_head_hash }, before);
  assert.equal(after.audit_event_count, before.audit_event_count + 1);
  fixture.setNow('2026-09-05T12:00:01.000Z');
  await fixture.controlPlane.renewLease(fixture.principal, { invocation_ref: ref, lease_token: input.lease_token, lease_ms: 5_000 });
  assert.deepEqual(await fixture.controlPlane.recordCleanupIncomplete(fixture.principal, input), a);
  const events = await fixture.controlPlane.listAuditEvents(fixture.principal, ref);
  assert.equal(verifyManagedAuditChain(events), true);
  for (const secret of [input.lease_token, TEST_TOKEN, 'incomplete_fork', 'incomplete_savepoint']) {
    assert.equal(JSON.stringify(a).includes(secret), false);
  }
  const projected = projectManagedLifecycleEvent(a);
  assert.equal(projected.source_event_type, 'cleanup_incomplete');
  assert.deepEqual(matchingMetricRules(projected, 'lifecycle', {
    maxSources: 100, maxSourcesPerTenant: 100, maxWindows: 100, maxWindowsPerTenant: 100,
    maxAlerts: 100, maxAlertsPerTenant: 100, rules: [
    { rule_id: 'cleanup_verified', threshold: 1, window_ms: 60_000 },
    { rule_id: 'execution_failure_observed', threshold: 1, window_ms: 60_000 },
  ] }), []);
});

for (const change of ['generation', 'token', 'owner', 'tenant', 'purpose', 'forged', 'raw_details']) {
  test(`cleanup observation rejects ${change} substitution without mutation`, async () => {
    const fixture = await createFixture(); const { ref, input } = await claimed(fixture);
    const before = await fixture.store.getAuditSnapshot(fixture.tenant.tenant_id, ref);
    let principal = fixture.principal; let altered = { ...input };
    if (change === 'generation') altered.lease_generation += 1;
    if (change === 'token') altered.lease_token = fixture.nextLeaseToken();
    if (change === 'owner') principal = fixture.sameTenantPrincipal;
    if (change === 'tenant') principal = fixture.otherPrincipal;
    if (change === 'purpose') altered.expected_lease_kind = 'execution';
    if (change === 'forged') principal = { ...principal };
    if (change === 'raw_details') altered.error = { code: 'provider_claim', message: 'PRIVATE' };
    await assert.rejects(fixture.controlPlane.recordCleanupIncomplete(principal, altered));
    assert.deepEqual(await fixture.store.getAuditSnapshot(fixture.tenant.tenant_id, ref), before);
  });
}

for (const withdrawal of ['revoked', 'scope', 'expired_credential', 'expired_lease', 'takeover']) {
  test(`same-attempt replay rechecks ${withdrawal} and grants no new authority`, async () => {
    const fixture = await createFixture(withdrawal === 'expired_credential'
      ? { credentialExpiresAt: '2026-09-05T12:00:01.000Z' } : {});
    const { ref, input } = await claimed(fixture);
    await fixture.controlPlane.recordCleanupIncomplete(fixture.principal, input);
    if (withdrawal === 'revoked' || withdrawal === 'scope') {
      // Memory has no administrator mutation API. This exercises fresh control-
      // plane reauthentication; real-PG tests also exercise persisted write races.
      const resolve = fixture.store.resolveCredential.bind(fixture.store);
      fixture.store.resolveCredential = async (hash) => {
        const credential = await resolve(hash);
        return credential?.key_id !== fixture.principal.key_id ? credential : { ...credential,
          ...(withdrawal === 'revoked' ? { revoked_at: '2026-09-05T12:00:00.000Z' }
            : { scopes: ['invocations:read', 'audit:read'] }) };
      };
    }
    if (withdrawal === 'expired_credential') fixture.setNow('2026-09-05T12:00:01.000Z');
    if (withdrawal === 'expired_lease' || withdrawal === 'takeover') fixture.setNow('2026-09-05T12:00:06.000Z');
    if (withdrawal === 'takeover') {
      await fixture.controlPlane.sweepExpiredLeases();
      await fixture.controlPlane.claimCleanup(fixture.sameTenantPrincipal, { invocation_ref: ref,
        lease_token: fixture.nextLeaseToken(), worker_id: 'replacement_cleanup', lease_ms: 5_000 });
    }
    const before = await fixture.store.getAuditSnapshot(fixture.tenant.tenant_id, ref);
    await assert.rejects(fixture.controlPlane.recordCleanupIncomplete(fixture.principal, input));
    assert.deepEqual(await fixture.store.getAuditSnapshot(fixture.tenant.tenant_id, ref), before);
  });
}

test('a fresh cleanup generation can observe a distinct incomplete attempt after reaping', async () => {
  const fixture = await createFixture(); const { ref, input } = await claimed(fixture);
  const first = await fixture.controlPlane.recordCleanupIncomplete(fixture.principal, input);
  fixture.setNow('2026-09-05T12:00:06.000Z'); await fixture.controlPlane.sweepExpiredLeases();
  const fresh = await fixture.controlPlane.claimCleanup(fixture.principal, { invocation_ref: ref,
    lease_token: fixture.nextLeaseToken(), worker_id: 'fresh_cleanup', lease_ms: 5_000 });
  const second = await fixture.controlPlane.recordCleanupIncomplete(fixture.principal, { invocation_ref: ref,
    lease_token: fresh.lease_token, lease_generation: fresh.invocation.lease_generation });
  assert.notEqual(first.event_ref, second.event_ref); assert.equal((await observations(fixture, ref)).length, 2);
});

class CleanupProvider extends TestProvider {
  constructor(mode, rejectMethod = 'destroyFork') { super(); this.mode = mode; this.rejectMethod = rejectMethod; this.calls = []; }
  async destroyFork() { await this.onDestroy?.(); this.effect('destroyFork'); }
  async destroySavepoint() { this.effect('destroySavepoint'); }
  async verifyDestroyed(input) { this.effect('verifyDestroyed'); return this.evidence(input); }
  async verifySavepointDestroyed(input) { this.effect('verifySavepointDestroyed'); return this.evidence(input); }
  effect(method) { this.calls.push(method); if (this.mode === 'reject' && method === this.rejectMethod) throw Object.assign(new Error('PRIVATE provider failure'), { code: 'LEASE_EXPIRED' }); }
  evidence(input) { this.calls.push('verify'); return createCleanupVerificationEvidence(input.cleanup_request, {
    status: this.mode === 'unknown' ? 'unknown' : 'verified', observed_at: '2026-09-05T12:00:00.000Z',
    evidence_ref: 'incomplete_provider_fixture', observation_hash: sha256Ref('fixture') }); }
}

function worker(fixture, overrides = {}) {
  return createManagedRiskForkWorker({ controlPlane: fixture.controlPlane, providerRegistry: fixture.providerRegistry,
    executionPrincipal: fixture.principal, cleanupPrincipal: fixture.sameTenantPrincipal, recoveryPrincipal: fixture.recoveryPrincipal,
    workerId: 'incomplete_worker', leaseMs: 5_000, clock: () => new Date('2026-09-05T12:00:00.000Z'),
    loadPrepareInput: async () => { throw new Error('unused execution'); }, lookupResources: async () => { throw new Error('unused recovery'); },
    measureCostMicros: () => 0,
    invokeProvider: async ({ provider, method, input, effectFence }) => { await effectFence(); return provider[method](input); }, ...overrides });
}

for (const mode of ['reject', 'unknown', 'unattested']) test(`worker records generic ${mode} incompletion and retains the cleanup obligation`, async () => {
  const provider = new CleanupProvider(mode); const fixture = await createFixture({ provider });
  const ref = await pending(fixture); const driver = worker(fixture);
  try {
    driver.stopExecution(); // Execution-only stop does not disable cleanup observation.
    await assert.rejects(driver.cleanup(ref), { code: mode === 'reject' ? 'WORKER_CLEANUP_FAILED'
      : mode === 'unknown' ? 'CLEANUP_NOT_VERIFIED' : 'CLEANUP_PROVIDER_ATTESTATION_FAILED' });
    await assert.rejects(driver.cleanup(ref)); // Memoized failure does not invoke the provider again.
    assert.equal((await observations(fixture, ref)).length, 1);
    const state = await fixture.controlPlane.getInvocation(fixture.principal, ref);
    assert.equal(state.state, 'cleanup_pending'); assert.equal(state.cleanup_requests.length, 2);
    assert.equal((await fixture.controlPlane.listAuditEvents(fixture.principal, ref)).some((event) => event.event_type === 'cleanup_verified'), false);
    if (mode === 'reject') assert.deepEqual(provider.calls, ['destroyFork']);
    for (const raw of ['PRIVATE provider failure', 'LEASE_EXPIRED']) assert.equal(JSON.stringify(await observations(fixture, ref)).includes(raw), false);
  } finally { await driver.close(); }
});

for (const method of ['verifyDestroyed', 'destroySavepoint', 'verifySavepointDestroyed']) {
  test(`raw ${method} rejection stops subsequent callbacks and records only generic incompletion`, async () => {
    const provider = new CleanupProvider('reject', method); const fixture = await createFixture({ provider });
    const ref = await pending(fixture); const driver = worker(fixture);
    try {
      await assert.rejects(driver.cleanup(ref), { code: 'WORKER_CLEANUP_FAILED' });
      assert.equal(provider.calls.at(-1), method); assert.equal((await observations(fixture, ref)).length, 1);
      assert.equal((await fixture.controlPlane.getInvocation(fixture.principal, ref)).state, 'cleanup_pending');
    } finally { await driver.close(); }
  });
}

test('fresh-worker cleanup after expiry/reaping appends a distinct attempt and never replays execution', async () => {
  const provider = new CleanupProvider('reject'); const fixture = await createFixture({ provider }); const ref = await pending(fixture);
  const first = worker(fixture); await assert.rejects(first.cleanup(ref)); await first.close();
  fixture.setNow('2026-09-05T12:00:06.000Z'); await fixture.controlPlane.sweepExpiredLeases();
  const fresh = worker(fixture, { clock: () => new Date('2026-09-05T12:00:06.000Z') });
  try { await assert.rejects(fresh.cleanup(ref)); assert.equal((await observations(fixture, ref)).length, 2);
    assert.deepEqual(provider.calls, ['destroyFork', 'destroyFork']); }
  finally { await fresh.close(); }
});

test('close during a provider callback suppresses incomplete classification and preserves recovery', async () => {
  const provider = new CleanupProvider('reject'); const fixture = await createFixture({ provider }); const ref = await pending(fixture);
  const driver = worker(fixture); provider.onDestroy = () => { driver.close(); };
  await assert.rejects(driver.cleanup(ref), { code: 'WORKER_CLOSED' });
  assert.equal((await observations(fixture, ref)).length, 0);
  assert.equal((await fixture.controlPlane.getInvocation(fixture.principal, ref)).state, 'cleanup_pending');
});

test('provider binding loss after a successful cleanup claim does not conceal the audit-only observation', async () => {
  const fixture = await createFixture({ provider: new CleanupProvider('verified') }); const ref = await pending(fixture);
  const control = { ...fixture.controlPlane, claimCleanup: async (...args) => {
    const claim = await fixture.controlPlane.claimCleanup(...args);
    fixture.provider.destroyFork = async () => { throw new Error('must not dispatch drifted adapter'); };
    return claim;
  } };
  const driver = worker(fixture, { controlPlane: control });
  try {
    await assert.rejects(driver.cleanup(ref), { code: 'WORKER_CLEANUP_FAILED' });
    assert.equal((await observations(fixture, ref)).length, 1); assert.deepEqual(fixture.provider.calls, []);
  } finally { await driver.close(); }
});

test('observation persistence failure preserves the original asynchronous completion error', async () => {
  const fixture = await createFixture({ provider: new CleanupProvider('unknown') }); const ref = await pending(fixture);
  const broken = { ...fixture.controlPlane, recordCleanupIncomplete: async () => { throw new Error('PRIVATE database error'); } };
  const driver = worker(fixture, { controlPlane: broken });
  try {
    await assert.rejects(driver.cleanup(ref), { code: 'CLEANUP_NOT_VERIFIED' });
    assert.equal((await observations(fixture, ref)).length, 0);
    assert.equal((await fixture.controlPlane.getInvocation(fixture.principal, ref)).state, 'cleanup_pending');
  } finally { await driver.close(); }
});

test('lost terminal completion acknowledgement emits no false incomplete observation', async () => {
  const fixture = await createFixture({ provider: new CleanupProvider('verified'), verifyCleanupEvidence: async () => true });
  const ref = await pending(fixture); const lost = new Error('lost completion');
  const control = { ...fixture.controlPlane, completeCleanup: async (...args) => { await fixture.controlPlane.completeCleanup(...args); throw lost; } };
  const driver = worker(fixture, { controlPlane: control });
  try {
    await assert.rejects(driver.cleanup(ref), (error) => error === lost);
    assert.equal((await observations(fixture, ref)).length, 0);
    assert.equal((await fixture.controlPlane.getInvocation(fixture.principal, ref)).state, 'completed');
  } finally { await driver.close(); }
});

test('closed worker/failed claim append no cleanup observation', async () => {
  const fixture = await createFixture(); const ref = await pending(fixture);
  const claimedElsewhere = await fixture.controlPlane.claimCleanup(fixture.principal, { invocation_ref: ref,
    lease_token: fixture.nextLeaseToken(), worker_id: 'other_worker', lease_ms: 5_000 });
  const driver = worker(fixture);
  await assert.rejects(driver.cleanup(ref)); await driver.close();
  assert.throws(() => driver.cleanup(ref), { code: 'WORKER_CLOSED' }); assert.equal((await observations(fixture, ref)).length, 0);
  assert.equal(claimedElsewhere.invocation.state, 'cleanup_pending');
});

test('only the internal cleanup-write route accepts closed observation input; the URL owns the target', async () => {
  const fixture = await createFixture(); const { ref, input } = await claimed(fixture);
  const options = { controlPlane: fixture.controlPlane, authenticator: fixture.authenticator, workerAuthenticator: fixture.authenticator };
  const publicHandler = createManagedServiceHttpHandler({ controlPlane: options.controlPlane, authenticator: options.authenticator });
  const internal = createManagedWorkerHttpHandler({ controlPlane: options.controlPlane, workerAuthenticator: options.workerAuthenticator });
  const request = { method: 'POST', path: `/internal/v1/invocations/${ref}/cleanup-incomplete`,
    headers: { authorization: `Bearer ${TEST_TOKEN}`, 'content-type': 'application/json' },
    body: JSON.stringify({ lease_token: input.lease_token, lease_generation: input.lease_generation }) };
  assert.equal((await publicHandler(request)).status, 404);
  assert.equal((await internal({ ...request, body: JSON.stringify(input) })).status, 400);
  assert.equal((await internal({ ...request, body: JSON.stringify({ ...input, error: 'PRIVATE' }) })).status, 400);
  const response = await internal(request); assert.equal(response.status, 200);
  assert.equal(response.body.event_type, 'cleanup_incomplete'); assert.equal((await observations(fixture, ref)).length, 1);
});
