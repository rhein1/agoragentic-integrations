import assert from 'node:assert/strict';
import test from 'node:test';
import { sha256Ref } from '../../src/canonical.mjs';
import { createCleanupVerificationEvidence } from '../../src/provider.mjs';
import { createManagedServiceConfig } from '../src/config.mjs';
import { createManagedRiskForkControlPlane } from '../src/control-plane.mjs';
import { createManagedProviderRegistry } from '../src/provider-registry.mjs';
import { createFixture, invocationRequest, TestProvider } from './helpers.mjs';

test('idempotency conflicts, tenant boundaries, budgets, and quotas fail closed', async () => {
  const fixture = await createFixture({ dailyBudget: 150_000, invocationBudget: 100_000, concurrency: 2 });
  const first = await fixture.controlPlane.admitInvocation(
    fixture.principal,
    invocationRequest({ estimated_cost_micros: 100_000 }),
  );
  await assert.rejects(
    fixture.controlPlane.admitInvocation(
      fixture.principal,
      invocationRequest({ estimated_cost_micros: 99_999 }),
    ),
    (error) => error.code === 'IDEMPOTENCY_CONFLICT' && error.status === 409,
  );
  await assert.rejects(
    fixture.controlPlane.admitInvocation(
      fixture.principal,
      invocationRequest({
        idempotency_key: 'idempotency-key-00000002',
        estimated_cost_micros: 60_000,
      }),
    ),
    (error) => error.code === 'DAILY_BUDGET_EXCEEDED' && error.status === 429,
  );
  await assert.rejects(
    fixture.controlPlane.getInvocation(fixture.otherPrincipal, first.invocation.invocation_ref),
    (error) => error.code === 'INVOCATION_NOT_FOUND' && error.status === 404,
  );
  await assert.rejects(
    fixture.controlPlane.admitInvocation(
      fixture.principal,
      invocationRequest({
        idempotency_key: 'idempotency-key-00000003',
        operation: { auth_token: 'this-field-is-forbidden' },
      }),
    ),
    /authority or secret-bearing field/,
  );
});

test('idempotent replay survives provider rotation and precedes current-provider admission', async () => {
  const fixture = await createFixture();
  const request = invocationRequest();
  const admitted = await fixture.controlPlane.admitInvocation(fixture.principal, request);
  const callbacks = {
    verify_resource_binding: async () => false,
    verify_cleanup_evidence: async () => false,
    verify_recovery_absence: async () => false,
  };
  const rotatedRegistry = createManagedProviderRegistry([
    {
      provider: new TestProvider(),
      enabled: false,
      adapter_digest: sha256Ref({ adapter: 'managed_service_test_fixture', version: 1 }),
      qualification_class: 'local_test',
      qualification_receipt_hash: sha256Ref({ fixture: true }),
      tenant_ids: ['tenant_alpha', 'tenant_other'],
      ...callbacks,
    },
    {
      provider: new TestProvider(),
      enabled: true,
      adapter_digest: sha256Ref({ adapter: 'managed_service_test_fixture', version: 2 }),
      qualification_class: 'local_test',
      qualification_receipt_hash: sha256Ref({ fixture: 'rotated' }),
      tenant_ids: ['tenant_alpha', 'tenant_other'],
      ...callbacks,
    },
  ]);
  let generatedRefs = 0;
  const restartedControlPlane = createManagedRiskForkControlPlane({
    config: fixture.config,
    store: fixture.store,
    providerRegistry: rotatedRegistry,
    requirePrincipal: fixture.authenticator.requirePrincipal,
    clock: () => new Date('2026-09-05T12:00:00.000Z'),
    invocationRef: () => `rfi_rotated_${++generatedRefs}`,
  });

  const replay = await restartedControlPlane.admitInvocation(fixture.principal, request);
  assert.equal(replay.created, false);
  assert.equal(replay.invocation.invocation_ref, admitted.invocation.invocation_ref);
  assert.equal(replay.invocation.provider_binding_hash, admitted.invocation.provider_binding_hash);
  assert.equal(replay.invocation.provider_recovery_key, admitted.invocation.provider_recovery_key);
  assert.equal(generatedRefs, 0);

  await assert.rejects(
    restartedControlPlane.admitInvocation(
      fixture.principal,
      invocationRequest({ estimated_cost_micros: 99_999 }),
    ),
    (error) => error.code === 'IDEMPOTENCY_CONFLICT' && error.status === 409,
  );
  assert.equal(generatedRefs, 0);

  const fresh = await restartedControlPlane.admitInvocation(
    fixture.principal,
    invocationRequest({ idempotency_key: 'idempotency-key-after-rotation-0002' }),
  );
  assert.equal(fresh.created, true);
  assert.notEqual(fresh.invocation.provider_binding_hash, admitted.invocation.provider_binding_hash);
  assert.equal(generatedRefs, 1);
});

test('idempotent replay survives a restart with tighter admission policy', async () => {
  const fixture = await createFixture();
  const request = invocationRequest({
    idempotency_key: `idempotency-restart-${'x'.repeat(64)}`,
    estimated_cost_micros: 100_000,
    operation: {
      kind: 'mcp_tool_call',
      tool_name: 'example.safe_tool',
      arguments: { value: 'x'.repeat(2_000) },
    },
  });
  const admitted = await fixture.controlPlane.admitInvocation(fixture.principal, request);
  const tighterConfig = createManagedServiceConfig({
    enabled: true,
    environment: 'local_test',
    limits: {
      max_idempotency_key_bytes: 16,
      max_request_bytes: 1_024,
      max_invocation_cost_micros: 50_000,
      daily_budget_micros: 50_000,
    },
  });
  const restarted = createManagedRiskForkControlPlane({
    config: tighterConfig,
    store: fixture.store,
    providerRegistry: fixture.providerRegistry,
    requirePrincipal: fixture.authenticator.requirePrincipal,
  });
  const replay = await restarted.admitInvocation(fixture.principal, request);
  assert.equal(replay.created, false);
  assert.equal(replay.invocation.invocation_ref, admitted.invocation.invocation_ref);
});

test('memory admission commits budget and indexes only after audit construction succeeds', async () => {
  let eventAttempts = 0;
  const fixture = await createFixture({
    dailyBudget: 100_000,
    invocationBudget: 100_000,
    eventRef: () => (++eventAttempts === 1 ? '' : `evt_fault_retry_${eventAttempts}`),
  });
  await assert.rejects(
    fixture.controlPlane.admitInvocation(fixture.principal, invocationRequest()),
    /event reference/,
  );
  const admitted = await fixture.controlPlane.admitInvocation(
    fixture.principal,
    invocationRequest(),
  );
  assert.equal(admitted.created, true);
  assert.equal(admitted.invocation.estimated_cost_micros, 100_000);
  assert.equal((await fixture.controlPlane.listAuditEvents(
    fixture.principal,
    admitted.invocation.invocation_ref,
  )).length, 1);
});

test('memory lease claims remain atomic when audit construction fails', async () => {
  let eventAttempts = 0;
  const fixture = await createFixture({
    eventRef: () => (++eventAttempts === 2 ? '' : `evt_claim_retry_${eventAttempts}`),
  });
  const admitted = await fixture.controlPlane.admitInvocation(fixture.principal, invocationRequest());
  const leaseToken = fixture.nextLeaseToken('atomic_claim');
  await assert.rejects(
    fixture.controlPlane.claimExecution(fixture.principal, {
      invocation_ref: admitted.invocation.invocation_ref,
      lease_token: leaseToken,
      worker_id: 'worker_claim_fault',
      lease_ms: 5_000,
    }),
    /event reference/,
  );
  const unchanged = await fixture.controlPlane.getInvocation(
    fixture.principal,
    admitted.invocation.invocation_ref,
  );
  assert.equal(unchanged.state, 'admitted');
  assert.equal(unchanged.lease_kind, null);
  assert.equal((await fixture.controlPlane.listAuditEvents(
    fixture.principal,
    admitted.invocation.invocation_ref,
  )).length, 1);
  const claimed = await fixture.controlPlane.claimExecution(fixture.principal, {
    invocation_ref: admitted.invocation.invocation_ref,
    lease_token: leaseToken,
    worker_id: 'worker_claim_retry',
    lease_ms: 5_000,
  });
  assert.equal(claimed.invocation.state, 'execution_leased');
  assert.equal(claimed.claim_replayed, false);
});

test('caller-held execution claims replay one atomic work item without extending authority', async () => {
  const fixture = await createFixture();
  const admitted = await fixture.controlPlane.admitInvocation(fixture.principal, invocationRequest());
  const leaseToken = fixture.nextLeaseToken('lost_response');
  const originalGetInvocation = fixture.store.getInvocation.bind(fixture.store);
  let getInvocationCalls = 0;
  fixture.store.getInvocation = async (...args) => {
    getInvocationCalls += 1;
    if (getInvocationCalls > 1) {
      throw new Error('post-commit invocation reread is forbidden');
    }
    return originalGetInvocation(...args);
  };
  const request = {
    invocation_ref: admitted.invocation.invocation_ref,
    lease_token: leaseToken,
    worker_id: 'worker_lost_response',
    lease_ms: 10_000,
  };
  const first = await fixture.controlPlane.claimExecution(fixture.principal, request);
  assert.equal(first.claim_replayed, false);
  assert.equal(getInvocationCalls, 1);
  fixture.store.getInvocation = originalGetInvocation;
  const tightenedControlPlane = createManagedRiskForkControlPlane({
    config: createManagedServiceConfig({
      enabled: true,
      environment: 'local_test',
      limits: { max_lease_ms: 5_000 },
    }),
    store: fixture.store,
    providerRegistry: fixture.providerRegistry,
    requirePrincipal: fixture.authenticator.requirePrincipal,
    clock: () => new Date('2026-09-05T12:00:00.000Z'),
    invocationRef: () => 'rfi_unused_tightened_replay',
  });
  const replay = await tightenedControlPlane.claimExecution(fixture.principal, {
    ...request,
    worker_id: 'worker_retry_metadata_is_not_authority',
    lease_ms: 20_000,
  });
  assert.equal(replay.claim_replayed, true);
  assert.equal(replay.lease_token, first.lease_token);
  assert.deepEqual(replay.invocation, first.invocation);
  assert.equal(replay.invocation.lease_generation, 1);
  const events = await fixture.controlPlane.listAuditEvents(
    fixture.principal,
    admitted.invocation.invocation_ref,
  );
  assert.equal(events.filter((event) => event.event_type === 'execution_lease_claimed').length, 1);
  assert.equal(events.length, 2);

  await assert.rejects(
    fixture.controlPlane.claimExecution(fixture.principal, {
      ...request,
      lease_token: fixture.nextLeaseToken('wrong_token'),
    }),
    (error) => error.code === 'LEASE_ALREADY_HELD' && error.status === 409,
  );
  await assert.rejects(
    fixture.controlPlane.claimExecution(fixture.sameTenantPrincipal, request),
    (error) => error.code === 'LEASE_ALREADY_HELD' && error.status === 409,
  );
  await assert.rejects(
    fixture.controlPlane.claimCleanup(fixture.principal, request),
    (error) => error.code === 'LEASE_ALREADY_HELD' && error.status === 409,
  );
  await assert.rejects(
    fixture.controlPlane.claimExecution(fixture.otherPrincipal, request),
    (error) => error.code === 'INVOCATION_NOT_FOUND' && error.status === 404,
  );
  assert.equal((await fixture.controlPlane.listAuditEvents(
    fixture.principal,
    admitted.invocation.invocation_ref,
  )).length, 2);
});

test('lease tokens are tenant-wide one-attempt identities across invocation references', async () => {
  const fixture = await createFixture();
  const first = await fixture.controlPlane.admitInvocation(fixture.principal, invocationRequest());
  const second = await fixture.controlPlane.admitInvocation(fixture.principal, invocationRequest({
    idempotency_key: 'idempotency-key-token-reuse-0002',
  }));
  const sequentialToken = fixture.nextLeaseToken('tenant_wide_sequential');
  await fixture.controlPlane.claimExecution(fixture.principal, {
    invocation_ref: first.invocation.invocation_ref,
    lease_token: sequentialToken,
    worker_id: 'worker_tenant_wide_sequential',
    lease_ms: 10_000,
  });
  await assert.rejects(
    fixture.controlPlane.claimExecution(fixture.principal, {
      invocation_ref: second.invocation.invocation_ref,
      lease_token: sequentialToken,
      worker_id: 'worker_tenant_wide_sequential',
      lease_ms: 10_000,
    }),
    (error) => error.code === 'LEASE_TOKEN_REPLAYED' && error.status === 409,
  );

  const third = await fixture.controlPlane.admitInvocation(fixture.principal, invocationRequest({
    idempotency_key: 'idempotency-key-token-reuse-0003',
  }));
  const fourth = await fixture.controlPlane.admitInvocation(fixture.principal, invocationRequest({
    idempotency_key: 'idempotency-key-token-reuse-0004',
  }));
  const concurrentToken = fixture.nextLeaseToken('tenant_wide_concurrent');
  const attempts = await Promise.allSettled([third, fourth].map((admitted) => (
    fixture.controlPlane.claimExecution(fixture.principal, {
      invocation_ref: admitted.invocation.invocation_ref,
      lease_token: concurrentToken,
      worker_id: 'worker_tenant_wide_concurrent',
      lease_ms: 10_000,
    })
  )));
  assert.equal(attempts.filter((attempt) => attempt.status === 'fulfilled').length, 1);
  const [rejected] = attempts.filter((attempt) => attempt.status === 'rejected');
  assert.equal(rejected.reason.code, 'LEASE_TOKEN_REPLAYED');
  assert.equal(rejected.reason.status, 409);
  const concurrentClaimAudits = await Promise.all([third, fourth].map(async (admitted) => (
    (await fixture.controlPlane.listAuditEvents(
      fixture.principal,
      admitted.invocation.invocation_ref,
    )).filter((event) => event.event_type === 'execution_lease_claimed').length
  )));
  assert.equal(concurrentClaimAudits.reduce((sum, count) => sum + count, 0), 1);
});

test('concurrent claim retries issue once and replay closes after any progress', async () => {
  const fixture = await createFixture();
  const admitted = await fixture.controlPlane.admitInvocation(fixture.principal, invocationRequest());
  const leaseToken = fixture.nextLeaseToken('concurrent_claim');
  const request = {
    invocation_ref: admitted.invocation.invocation_ref,
    lease_token: leaseToken,
    worker_id: 'worker_concurrent_claim',
    lease_ms: 10_000,
  };
  const claims = await Promise.all([
    fixture.controlPlane.claimExecution(fixture.principal, request),
    fixture.controlPlane.claimExecution(fixture.principal, request),
  ]);
  assert.deepEqual(claims.map((claim) => claim.claim_replayed).sort(), [false, true]);
  assert.deepEqual(claims[0].invocation, claims[1].invocation);
  assert.equal((await fixture.controlPlane.listAuditEvents(
    fixture.principal,
    admitted.invocation.invocation_ref,
  )).filter((event) => event.event_type === 'execution_lease_claimed').length, 1);

  await fixture.controlPlane.renewLease(fixture.principal, {
    invocation_ref: admitted.invocation.invocation_ref,
    lease_token: leaseToken,
    lease_ms: 10_000,
  });
  await assert.rejects(
    fixture.controlPlane.claimExecution(fixture.principal, request),
    (error) => error.code === 'LEASE_CLAIM_ALREADY_PROGRESSED' && error.status === 409,
  );

  const journaledAdmission = await fixture.controlPlane.admitInvocation(
    fixture.principal,
    invocationRequest({ idempotency_key: 'idempotency-key-claim-journal-0002' }),
  );
  const journaledToken = fixture.nextLeaseToken('journaled_claim');
  const journaledRequest = {
    invocation_ref: journaledAdmission.invocation.invocation_ref,
    lease_token: journaledToken,
    worker_id: 'worker_journaled_claim',
    lease_ms: 10_000,
  };
  await fixture.controlPlane.claimExecution(fixture.principal, journaledRequest);
  fixture.attestResourceBinding(journaledAdmission.invocation, {
    savepoint_ref: 'savepoint_claim_progress',
  });
  const journaled = await fixture.controlPlane.recordResources(fixture.principal, {
    invocation_ref: journaledAdmission.invocation.invocation_ref,
    lease_token: journaledToken,
    savepoint_ref: 'savepoint_claim_progress',
  });
  assert.equal(journaled.state, 'execution_leased');
  await assert.rejects(
    fixture.controlPlane.claimExecution(fixture.principal, journaledRequest),
    (error) => error.code === 'LEASE_CLAIM_ALREADY_PROGRESSED' && error.status === 409,
  );
});

test('resource journal receipts converge sequential, concurrent, partial, and complete retries', async () => {
  let verifierCalls = 0;
  const fixture = await createFixture({
    verifyResourceBinding: async () => {
      verifierCalls += 1;
      return true;
    },
  });
  const admitted = await fixture.controlPlane.admitInvocation(fixture.principal, invocationRequest());
  const execution = await fixture.controlPlane.claimExecution(fixture.principal, {
    invocation_ref: admitted.invocation.invocation_ref,
    lease_token: fixture.nextLeaseToken('journal_receipt'),
    worker_id: 'worker_journal_receipt',
    lease_ms: 30_000,
  });
  const partialRequest = {
    invocation_ref: admitted.invocation.invocation_ref,
    lease_token: execution.lease_token,
    savepoint_ref: 'savepoint_journal_receipt',
  };
  const partial = await Promise.all([
    fixture.controlPlane.recordResources(fixture.principal, partialRequest),
    fixture.controlPlane.recordResources(fixture.principal, partialRequest),
  ]);
  assert.deepEqual(partial[0], partial[1]);
  assert.equal(partial[0].state, 'execution_leased');
  assert.equal(partial[0].savepoint_ref, 'savepoint_journal_receipt');
  const verifierCallsAfterConcurrent = verifierCalls;
  assert.ok(verifierCallsAfterConcurrent >= 1 && verifierCallsAfterConcurrent <= 2);
  const partialReplay = await fixture.controlPlane.recordResources(
    fixture.principal,
    partialRequest,
  );
  assert.deepEqual(partialReplay, partial[0]);
  assert.equal(verifierCalls, verifierCallsAfterConcurrent);
  let events = await fixture.controlPlane.listAuditEvents(
    fixture.principal,
    admitted.invocation.invocation_ref,
  );
  assert.equal(events.filter((event) => event.event_type === 'provider_resource_journaled').length, 1);

  const completeRequest = {
    ...partialRequest,
    fork_ref: 'fork_journal_receipt',
  };
  const complete = await fixture.controlPlane.recordResources(fixture.principal, completeRequest);
  assert.equal(complete.state, 'running');
  const verifierCallsAfterComplete = verifierCalls;
  const completeReplay = await fixture.controlPlane.recordResources(
    fixture.principal,
    completeRequest,
  );
  assert.deepEqual(completeReplay, complete);
  assert.equal(verifierCalls, verifierCallsAfterComplete);
  events = await fixture.controlPlane.listAuditEvents(
    fixture.principal,
    admitted.invocation.invocation_ref,
  );
  assert.equal(events.filter((event) => event.event_type === 'provider_resources_recorded').length, 1);
  assert.equal(events.length, 4);
  fixture.setNow('2026-09-06T00:00:00.000Z');
  await assert.rejects(
    fixture.controlPlane.recordResources(fixture.principal, completeRequest),
    (error) => error.code === 'AUTHENTICATION_FAILED' && error.status === 401,
  );
  assert.equal(verifierCalls, verifierCallsAfterComplete);
});

test('expired and reaped claims reject delayed packets through token tombstones', async () => {
  const fixture = await createFixture();
  const admitted = await fixture.controlPlane.admitInvocation(fixture.principal, invocationRequest());
  const executionToken = fixture.nextLeaseToken('historical_execution');
  const request = {
    invocation_ref: admitted.invocation.invocation_ref,
    lease_token: executionToken,
    worker_id: 'worker_historical_execution',
    lease_ms: 5_000,
  };
  await fixture.controlPlane.claimExecution(fixture.principal, request);
  fixture.setNow('2026-09-05T12:00:05.000Z');
  await assert.rejects(
    fixture.controlPlane.claimExecution(fixture.principal, request),
    (error) => error.code === 'LEASE_EXPIRED' && error.status === 409,
  );
  const [reaped] = await fixture.controlPlane.sweepExpiredLeases();
  assert.equal(reaped.state, 'recovery_required');
  await assert.rejects(
    fixture.controlPlane.claimRecovery(fixture.principal, {
      ...request,
      worker_id: 'worker_delayed_packet',
    }),
    (error) => error.code === 'LEASE_TOKEN_REPLAYED' && error.status === 409,
  );
  const recoveryToken = fixture.nextLeaseToken('recovery_retry');
  const recoveryRequest = {
    invocation_ref: admitted.invocation.invocation_ref,
    lease_token: recoveryToken,
    worker_id: 'worker_recovery_retry',
    lease_ms: 5_000,
  };
  const recovery = await fixture.controlPlane.claimRecovery(fixture.principal, recoveryRequest);
  const recoveryReplay = await fixture.controlPlane.claimRecovery(
    fixture.principal,
    recoveryRequest,
  );
  assert.equal(recovery.claim_replayed, false);
  assert.equal(recoveryReplay.claim_replayed, true);
  assert.deepEqual(recoveryReplay.invocation, recovery.invocation);
  assert.equal(Object.hasOwn(recovery.invocation, 'operation'), false);
});

test('memory transitions and budget settlement remain atomic on audit failure', async () => {
  let eventAttempts = 0;
  const fixture = await createFixture({
    eventRef: () => (++eventAttempts === 3 || eventAttempts === 5
      ? ''
      : `evt_transition_retry_${eventAttempts}`),
    verifyResourceBinding: async () => true,
  });
  const admitted = await fixture.controlPlane.admitInvocation(fixture.principal, invocationRequest());
  const execution = await fixture.controlPlane.claimExecution(fixture.principal, {
    invocation_ref: admitted.invocation.invocation_ref,
    lease_token: fixture.nextLeaseToken(),
    worker_id: 'worker_transition_fault',
    lease_ms: 30_000,
  });
  const resources = {
    invocation_ref: admitted.invocation.invocation_ref,
    lease_token: execution.lease_token,
    savepoint_ref: 'savepoint_transition_fault',
    fork_ref: 'fork_transition_fault',
  };
  await assert.rejects(
    fixture.controlPlane.recordResources(fixture.principal, resources),
    /event reference/,
  );
  assert.equal((await fixture.controlPlane.getInvocation(
    fixture.principal,
    admitted.invocation.invocation_ref,
  )).state, 'execution_leased');
  await fixture.controlPlane.recordResources(fixture.principal, resources);
  const outcome = {
    invocation_ref: admitted.invocation.invocation_ref,
    lease_token: execution.lease_token,
    outcome: 'succeeded',
    actual_cost_micros: 75_000,
    execution_evidence_hash: sha256Ref({ atomic_settlement_execution: true }),
    result_hash: sha256Ref({ atomic_settlement_result: true }),
  };
  await assert.rejects(
    fixture.controlPlane.recordExecutionOutcome(fixture.principal, outcome),
    /event reference/,
  );
  const stillRunning = await fixture.controlPlane.getInvocation(
    fixture.principal,
    admitted.invocation.invocation_ref,
  );
  assert.equal(stillRunning.state, 'running');
  assert.equal(stillRunning.actual_cost_micros, null);
  assert.equal((await fixture.controlPlane.listAuditEvents(
    fixture.principal,
    admitted.invocation.invocation_ref,
  )).length, 3);
  const settled = await fixture.controlPlane.recordExecutionOutcome(fixture.principal, outcome);
  assert.equal(settled.state, 'cleanup_pending');
  assert.equal(settled.actual_cost_micros, 75_000);
});

test('memory lease reaping remains atomic on audit failure', async () => {
  let eventAttempts = 0;
  const fixture = await createFixture({
    eventRef: () => (++eventAttempts === 3 ? '' : `evt_reaper_retry_${eventAttempts}`),
  });
  const admitted = await fixture.controlPlane.admitInvocation(fixture.principal, invocationRequest());
  await fixture.controlPlane.claimExecution(fixture.principal, {
    invocation_ref: admitted.invocation.invocation_ref,
    lease_token: fixture.nextLeaseToken(),
    worker_id: 'worker_reaper_fault',
    lease_ms: 5_000,
  });
  fixture.setNow('2026-09-05T12:00:06.000Z');
  await assert.rejects(fixture.controlPlane.sweepExpiredLeases(), /event reference/);
  const unchanged = await fixture.controlPlane.getInvocation(
    fixture.principal,
    admitted.invocation.invocation_ref,
  );
  assert.equal(unchanged.state, 'execution_leased');
  assert.equal(unchanged.actual_cost_micros, null);
  assert.equal((await fixture.controlPlane.health()).storage.expired_execution_lease_count, 1);
  const [reaped] = await fixture.controlPlane.sweepExpiredLeases();
  assert.equal(reaped.state, 'recovery_required');
  assert.equal(reaped.actual_cost_micros, 100_000);
});

test('memory admission rejects generated invocation collisions without reserving twice', async () => {
  let generatedRef = 'rfi_memory_collision';
  const fixture = await createFixture({
    dailyBudget: 200_000,
    invocationBudget: 100_000,
    invocationRef: () => generatedRef,
  });
  const firstRequest = invocationRequest();
  const first = await fixture.controlPlane.admitInvocation(fixture.principal, firstRequest);
  await assert.rejects(
    fixture.controlPlane.admitInvocation(fixture.principal, invocationRequest({
      idempotency_key: 'idempotency-key-memory-collision-0002',
    })),
    (error) => error.code === 'INVOCATION_REFERENCE_CONFLICT' && error.status === 503,
  );
  const replay = await fixture.controlPlane.admitInvocation(fixture.principal, firstRequest);
  assert.equal(replay.created, false);
  assert.equal(replay.invocation.invocation_ref, first.invocation.invocation_ref);
  assert.equal((await fixture.controlPlane.listAuditEvents(
    fixture.principal,
    first.invocation.invocation_ref,
  )).length, 1);

  generatedRef = 'rfi_memory_after_collision';
  const second = await fixture.controlPlane.admitInvocation(fixture.principal, invocationRequest({
    idempotency_key: 'idempotency-key-memory-collision-0002',
  }));
  assert.equal(second.created, true);
});

test('lease ownership is the authenticated key while worker_id remains caller metadata', async () => {
  const fixture = await createFixture();
  const admitted = await fixture.controlPlane.admitInvocation(fixture.principal, invocationRequest());
  const claimed = await fixture.controlPlane.claimExecution(fixture.principal, {
    invocation_ref: admitted.invocation.invocation_ref,
    lease_token: fixture.nextLeaseToken(),
    worker_id: 'key_other',
    lease_ms: 5_000,
  });
  assert.equal(claimed.invocation.lease_owner, fixture.principal.key_id);
  assert.notEqual(claimed.invocation.lease_owner, 'key_other');
  const events = await fixture.controlPlane.listAuditEvents(
    fixture.principal,
    admitted.invocation.invocation_ref,
  );
  assert.equal(events.at(-1).details_hash, sha256Ref({
    claimant_key_id: fixture.principal.key_id,
    worker_instance_ref: 'key_other',
    expires_at: '2026-09-05T12:00:05.000Z',
    lease_generation: 1,
  }));
});

test('a same-tenant credential cannot continue another credential lease with its token', async () => {
  let resourceVerificationCalls = 0;
  const fixture = await createFixture({
    verifyResourceBinding: async () => {
      resourceVerificationCalls += 1;
      return true;
    },
  });
  const admitted = await fixture.controlPlane.admitInvocation(fixture.principal, invocationRequest());
  const claimed = await fixture.controlPlane.claimExecution(fixture.principal, {
    invocation_ref: admitted.invocation.invocation_ref,
    lease_token: fixture.nextLeaseToken(),
    worker_id: 'worker_primary',
    lease_ms: 5_000,
  });
  const before = await fixture.controlPlane.getInvocation(
    fixture.principal,
    admitted.invocation.invocation_ref,
  );

  await assert.rejects(
    fixture.controlPlane.renewLease(fixture.sameTenantPrincipal, {
      invocation_ref: admitted.invocation.invocation_ref,
      lease_token: claimed.lease_token,
      lease_ms: 6_000,
    }),
    (error) => error.code === 'LEASE_OWNER_MISMATCH' && error.status === 403,
  );
  await assert.rejects(
    fixture.controlPlane.recordResources(fixture.sameTenantPrincipal, {
      invocation_ref: admitted.invocation.invocation_ref,
      lease_token: claimed.lease_token,
      savepoint_ref: 'savepoint_same_tenant_denied',
      fork_ref: 'fork_same_tenant_denied',
    }),
    (error) => error.code === 'LEASE_OWNER_MISMATCH' && error.status === 403,
  );
  assert.equal(resourceVerificationCalls, 0);
  assert.deepEqual(await fixture.controlPlane.getInvocation(
    fixture.principal,
    admitted.invocation.invocation_ref,
  ), before);

  const savepointRef = 'savepoint_owned_by_primary';
  const forkRef = 'fork_owned_by_primary';
  await fixture.controlPlane.recordResources(fixture.principal, {
    invocation_ref: admitted.invocation.invocation_ref,
    lease_token: claimed.lease_token,
    savepoint_ref: savepointRef,
    fork_ref: forkRef,
  });
  await assert.rejects(
    fixture.controlPlane.recordExecutionOutcome(fixture.sameTenantPrincipal, {
      invocation_ref: admitted.invocation.invocation_ref,
      lease_token: claimed.lease_token,
      outcome: 'succeeded',
      actual_cost_micros: 50_000,
      execution_evidence_hash: sha256Ref({ execution: 'same-tenant-denied' }),
      result_hash: sha256Ref({ result: 'same-tenant-denied' }),
    }),
    (error) => error.code === 'LEASE_OWNER_MISMATCH' && error.status === 403,
  );
  assert.equal((await fixture.controlPlane.getInvocation(
    fixture.principal,
    admitted.invocation.invocation_ref,
  )).state, 'running');
});

test('memory audit monotonicity rejects a backward clock before lease mutation', async () => {
  const fixture = await createFixture();
  const admitted = await fixture.controlPlane.admitInvocation(fixture.principal, invocationRequest());
  const before = await fixture.controlPlane.getInvocation(
    fixture.principal,
    admitted.invocation.invocation_ref,
  );
  const beforeEvents = await fixture.controlPlane.listAuditEvents(
    fixture.principal,
    admitted.invocation.invocation_ref,
  );
  fixture.setNow('2026-09-05T11:59:59.000Z');
  await assert.rejects(
    fixture.controlPlane.claimExecution(fixture.principal, {
      invocation_ref: admitted.invocation.invocation_ref,
      lease_token: fixture.nextLeaseToken(),
      worker_id: 'worker_backward_clock',
      lease_ms: 5_000,
    }),
    (error) => error.code === 'AUDIT_TIME_REGRESSION' && error.status === 503,
  );
  assert.deepEqual(await fixture.controlPlane.getInvocation(
    fixture.principal,
    admitted.invocation.invocation_ref,
  ), before);
  assert.deepEqual(await fixture.controlPlane.listAuditEvents(
    fixture.principal,
    admitted.invocation.invocation_ref,
  ), beforeEvents);
});

test('lease renewal snapshots its invocation target before an awaited provider gate', async () => {
  const fixture = await createFixture({ concurrency: 2 });
  const first = await fixture.controlPlane.admitInvocation(fixture.principal, invocationRequest());
  const second = await fixture.controlPlane.admitInvocation(fixture.principal, invocationRequest({
    idempotency_key: 'idempotency-key-renewal-target-0002',
  }));
  const secondLease = await fixture.controlPlane.claimExecution(fixture.principal, {
    invocation_ref: second.invocation.invocation_ref,
    lease_token: fixture.nextLeaseToken(),
    worker_id: 'worker_second_lease',
    lease_ms: 5_000,
  });
  const originalGetInvocation = fixture.store.getInvocation.bind(fixture.store);
  let releaseLookup;
  let signalLookup;
  const lookupEntered = new Promise((resolve) => { signalLookup = resolve; });
  const lookupRelease = new Promise((resolve) => { releaseLookup = resolve; });
  fixture.store.getInvocation = async (...args) => {
    signalLookup();
    await lookupRelease;
    return originalGetInvocation(...args);
  };
  const originalRenewLease = fixture.store.renewLease.bind(fixture.store);
  let renewedInvocationRef = null;
  fixture.store.renewLease = async (value) => {
    renewedInvocationRef = value.invocation_ref;
    return originalRenewLease(value);
  };
  const request = {
    invocation_ref: first.invocation.invocation_ref,
    lease_token: secondLease.lease_token,
    lease_ms: 5_000,
  };
  const renewal = fixture.controlPlane.renewLease(fixture.principal, request);
  await lookupEntered;
  request.invocation_ref = second.invocation.invocation_ref;
  releaseLookup();
  await assert.rejects(
    renewal,
    (error) => error.code === 'LEASE_TOKEN_INVALID' && error.status === 403,
  );
  assert.equal(renewedInvocationRef, first.invocation.invocation_ref);
});

test('expired execution and recovery backlog block admission and queued execution claims', async () => {
  const fixture = await createFixture({ concurrency: 2 });
  const admitted = await fixture.controlPlane.admitInvocation(
    fixture.principal,
    invocationRequest({ estimated_cost_micros: 100_000 }),
  );
  const queued = await fixture.controlPlane.admitInvocation(
    fixture.principal,
    invocationRequest({ idempotency_key: 'idempotency-key-queued-before-recovery-0002' }),
  );
  await fixture.controlPlane.claimExecution(fixture.principal, {
    invocation_ref: admitted.invocation.invocation_ref,
    lease_token: fixture.nextLeaseToken(),
    worker_id: 'worker_alpha',
    lease_ms: 5_000,
  });
  fixture.setNow('2026-09-05T12:00:06.000Z');
  const expiredHealth = await fixture.controlPlane.health();
  assert.equal(expiredHealth.ready, false);
  assert.equal(expiredHealth.storage.expired_execution_lease_count, 1);
  assert.equal(expiredHealth.storage.recovery_required_count, 0);
  await assert.rejects(
    fixture.controlPlane.admitInvocation(fixture.principal, invocationRequest({
      idempotency_key: 'idempotency-key-before-expiry-sweep-0003',
    })),
    (error) => error.code === 'TENANT_RECONCILIATION_REQUIRED' && error.status === 503,
  );
  const swept = await fixture.controlPlane.sweepExpiredLeases();
  assert.equal(swept.length, 1);
  assert.equal(swept[0].state, 'recovery_required');
  assert.equal(swept[0].execution_outcome, 'ambiguous');
  assert.equal(swept[0].actual_cost_micros, 100_000);
  assert.equal(swept[0].lease_kind, null);
  const recoveryHealth = await fixture.controlPlane.health();
  assert.equal(recoveryHealth.ready, false);
  assert.equal(recoveryHealth.storage.expired_execution_lease_count, 0);
  assert.equal(recoveryHealth.storage.recovery_required_count, 1);
  await assert.rejects(
    fixture.controlPlane.claimExecution(fixture.principal, {
      invocation_ref: queued.invocation.invocation_ref,
      lease_token: fixture.nextLeaseToken(),
      worker_id: 'worker_queued_during_recovery',
      lease_ms: 5_000,
    }),
    (error) => error.code === 'TENANT_RECOVERY_REQUIRED' && error.status === 503,
  );
  await assert.rejects(
    fixture.controlPlane.admitInvocation(fixture.principal, invocationRequest({
      idempotency_key: 'idempotency-key-00000002',
    })),
    (error) => error.code === 'TENANT_RECOVERY_REQUIRED' && error.status === 503,
  );
  assert.equal((await fixture.controlPlane.health()).ready, false);
});

test('execution authority cannot cross its admission UTC budget day', async () => {
  const fixture = await createFixture({
    now: '2026-09-05T23:59:50.000Z',
    credentialExpiresAt: '2026-09-07T00:00:00.000Z',
    dailyBudget: 100_000,
    invocationBudget: 100_000,
    concurrency: 2,
  });
  const admitted = await fixture.controlPlane.admitInvocation(
    fixture.principal,
    invocationRequest({ estimated_cost_micros: 100_000 }),
  );
  const lease = await fixture.controlPlane.claimExecution(fixture.principal, {
    invocation_ref: admitted.invocation.invocation_ref,
    lease_token: fixture.nextLeaseToken(),
    worker_id: 'worker_before_midnight',
    lease_ms: 5_000,
  });
  fixture.setNow('2026-09-05T23:59:54.000Z');
  await assert.rejects(
    fixture.controlPlane.renewLease(fixture.principal, {
      invocation_ref: admitted.invocation.invocation_ref,
      lease_token: lease.lease_token,
      lease_ms: 10_000,
    }),
    (error) => error.code === 'LEASE_CROSSES_BUDGET_DAY' && error.status === 409,
  );

  const nextFixture = await createFixture({
    now: '2026-09-05T23:59:50.000Z',
    credentialExpiresAt: '2026-09-07T00:00:00.000Z',
    dailyBudget: 100_000,
    invocationBudget: 100_000,
    concurrency: 2,
  });
  const queued = await nextFixture.controlPlane.admitInvocation(
    nextFixture.principal,
    invocationRequest({
      idempotency_key: 'idempotency-key-before-midnight-0002',
      estimated_cost_micros: 100_000,
    }),
  );
  nextFixture.setNow('2026-09-06T00:00:01.000Z');
  await assert.rejects(
    nextFixture.controlPlane.claimExecution(nextFixture.principal, {
      invocation_ref: queued.invocation.invocation_ref,
      lease_token: nextFixture.nextLeaseToken(),
      worker_id: 'worker_after_midnight',
      lease_ms: 5_000,
    }),
    (error) => error.code === 'INVOCATION_BUDGET_DAY_EXPIRED' && error.status === 409,
  );
  const nextDay = await nextFixture.controlPlane.admitInvocation(
    nextFixture.principal,
    invocationRequest({
      idempotency_key: 'idempotency-key-after-midnight-0003',
      estimated_cost_micros: 100_000,
    }),
  );
  assert.equal(nextDay.created, true);
  assert.equal(nextDay.invocation.budget_day_utc, '2026-09-06');
});

test('an execution claim whose first lease crosses UTC midnight is rejected', async () => {
  const fixture = await createFixture({
    now: '2026-09-05T23:59:58.000Z',
    credentialExpiresAt: '2026-09-07T00:00:00.000Z',
  });
  const admitted = await fixture.controlPlane.admitInvocation(fixture.principal, invocationRequest());
  await assert.rejects(
    fixture.controlPlane.claimExecution(fixture.principal, {
      invocation_ref: admitted.invocation.invocation_ref,
      lease_token: fixture.nextLeaseToken(),
      worker_id: 'worker_cross_midnight',
      lease_ms: 5_000,
    }),
    (error) => error.code === 'LEASE_CROSSES_BUDGET_DAY' && error.status === 409,
  );
  assert.equal((await fixture.controlPlane.getInvocation(
    fixture.principal,
    admitted.invocation.invocation_ref,
  )).state, 'admitted');
});

test('an admission cannot acquire execution authority after its maximum age', async () => {
  const fixture = await createFixture({ maxInvocationAgeMs: 10_000 });
  const admitted = await fixture.controlPlane.admitInvocation(
    fixture.principal,
    invocationRequest(),
  );
  fixture.setNow('2026-09-05T12:00:10.000Z');
  await assert.rejects(
    fixture.controlPlane.claimExecution(fixture.principal, {
      invocation_ref: admitted.invocation.invocation_ref,
      lease_token: fixture.nextLeaseToken(),
      worker_id: 'worker_stale_admission',
      lease_ms: 5_000,
    }),
    (error) => error.code === 'INVOCATION_EXPIRED' && error.status === 409,
  );
  const [expired] = await fixture.controlPlane.sweepExpiredLeases();
  assert.equal(expired.state, 'failed_closed');
  assert.equal(expired.actual_cost_micros, 0);
});

test('recovery workers can bind provider refs using the immutable recovery key', async () => {
  const fixture = await createFixture();
  const admitted = await fixture.controlPlane.admitInvocation(fixture.principal, invocationRequest());
  await fixture.controlPlane.claimExecution(fixture.principal, {
    invocation_ref: admitted.invocation.invocation_ref,
    lease_token: fixture.nextLeaseToken(),
    worker_id: 'worker_alpha',
    lease_ms: 5_000,
  });
  fixture.setNow('2026-09-05T12:00:06.000Z');
  await fixture.controlPlane.sweepExpiredLeases();
  const recovery = await fixture.controlPlane.claimRecovery(fixture.principal, {
    invocation_ref: admitted.invocation.invocation_ref,
    lease_token: fixture.nextLeaseToken(),
    worker_id: 'recovery_alpha',
    lease_ms: 5_000,
  });
  assert.equal(recovery.invocation.state, 'recovery_required');
  assert.equal(Object.hasOwn(recovery.invocation, 'operation'), false);
  assert.match(recovery.invocation.provider_recovery_key, /^sha256:[a-f0-9]{64}$/);
  fixture.attestResourceBinding(admitted.invocation, {
    savepoint_ref: 'savepoint_recovered',
    fork_ref: 'fork_recovered',
  });
  const recovered = await fixture.controlPlane.recordResources(fixture.principal, {
    invocation_ref: admitted.invocation.invocation_ref,
    lease_token: recovery.lease_token,
    savepoint_ref: 'savepoint_recovered',
    fork_ref: 'fork_recovered',
  });
  assert.equal(recovered.state, 'cleanup_pending');
  assert.equal(recovered.cleanup_requests.length, 2);
  assert.equal(recovered.lease_kind, null);
});

test('a savepoint journaled before a crash can be partially recovered and cleaned', async () => {
  const fixture = await createFixture();
  const admitted = await fixture.controlPlane.admitInvocation(fixture.principal, invocationRequest());
  const execution = await fixture.controlPlane.claimExecution(fixture.principal, {
    invocation_ref: admitted.invocation.invocation_ref,
    lease_token: fixture.nextLeaseToken(),
    worker_id: 'worker_partial',
    lease_ms: 5_000,
  });
  fixture.attestResourceBinding(admitted.invocation, {
    savepoint_ref: 'savepoint_partial',
  });
  const journaled = await fixture.controlPlane.recordResources(fixture.principal, {
    invocation_ref: admitted.invocation.invocation_ref,
    lease_token: execution.lease_token,
    savepoint_ref: 'savepoint_partial',
  });
  assert.equal(journaled.state, 'execution_leased');
  assert.equal(journaled.savepoint_ref, 'savepoint_partial');
  assert.equal(journaled.fork_ref, null);
  assert.equal(journaled.cleanup_requests.length, 1);

  fixture.setNow('2026-09-05T12:00:06.000Z');
  const [recoveryRequired] = await fixture.controlPlane.sweepExpiredLeases();
  assert.equal(recoveryRequired.state, 'recovery_required');
  assert.equal(recoveryRequired.savepoint_ref, 'savepoint_partial');
  const recovery = await fixture.controlPlane.claimRecovery(fixture.principal, {
    invocation_ref: admitted.invocation.invocation_ref,
    lease_token: fixture.nextLeaseToken(),
    worker_id: 'recovery_partial',
    lease_ms: 30_000,
  });
  fixture.attestResourceBinding(admitted.invocation, {
    savepoint_ref: 'savepoint_partial',
    absent_resource_kinds: ['fork'],
  });
  const cleanupPending = await fixture.controlPlane.recordResources(fixture.principal, {
    invocation_ref: admitted.invocation.invocation_ref,
    lease_token: recovery.lease_token,
    absent_resource_kinds: ['fork'],
  });
  assert.equal(cleanupPending.state, 'cleanup_pending');
  assert.equal(cleanupPending.cleanup_requests.length, 1);
  const recoveryAuditCount = (await fixture.controlPlane.listAuditEvents(
    fixture.principal,
    admitted.invocation.invocation_ref,
  )).length;
  const recoveryReplay = await fixture.controlPlane.recordResources(fixture.principal, {
    invocation_ref: admitted.invocation.invocation_ref,
    lease_token: recovery.lease_token,
    absent_resource_kinds: ['fork'],
  });
  assert.deepEqual(recoveryReplay, cleanupPending);
  assert.equal((await fixture.controlPlane.listAuditEvents(
    fixture.principal,
    admitted.invocation.invocation_ref,
  )).length, recoveryAuditCount);
  const cleanup = await fixture.controlPlane.claimCleanup(fixture.principal, {
    invocation_ref: admitted.invocation.invocation_ref,
    lease_token: fixture.nextLeaseToken(),
    worker_id: 'cleanup_partial',
    lease_ms: 30_000,
  });
  const evidence = createCleanupVerificationEvidence(cleanup.invocation.cleanup_requests[0], {
    status: 'verified',
    observed_at: '2026-09-05T12:00:06.000Z',
    evidence_ref: 'cleanup_partial_evidence',
    observation_hash: sha256Ref({ absent: true, savepoint: 'savepoint_partial' }),
  });
  fixture.attestCleanupEvidence(evidence);
  const terminal = await fixture.controlPlane.completeCleanup(fixture.principal, {
    invocation_ref: admitted.invocation.invocation_ref,
    lease_token: cleanup.lease_token,
    cleanup_evidence: [evidence],
  });
  assert.equal(terminal.state, 'failed_closed');
  assert.equal(terminal.cleanup_requests.length, 1);
});

test('provider-attested recovery absence closes orphan risk and unblocks admissions', async () => {
  const fixture = await createFixture();
  const admitted = await fixture.controlPlane.admitInvocation(fixture.principal, invocationRequest());
  await fixture.controlPlane.claimExecution(fixture.principal, {
    invocation_ref: admitted.invocation.invocation_ref,
    lease_token: fixture.nextLeaseToken(),
    worker_id: 'worker_alpha',
    lease_ms: 5_000,
  });
  fixture.setNow('2026-09-05T12:00:06.000Z');
  await fixture.controlPlane.sweepExpiredLeases();
  const recovery = await fixture.controlPlane.claimRecovery(fixture.principal, {
    invocation_ref: admitted.invocation.invocation_ref,
    lease_token: fixture.nextLeaseToken(),
    worker_id: 'recovery_alpha',
    lease_ms: 5_000,
  });
  const evidence = {
    schema: 'agoragentic.risk-fork.recovery-absence-evidence.v1',
    provider_recovery_key: recovery.invocation.provider_recovery_key,
    observed_at: '2026-09-05T12:00:06.000Z',
    evidence_ref: 'recovery_absence_001',
    observation_hash: sha256Ref({ no_resources: true }),
  };
  await assert.rejects(
    fixture.controlPlane.completeRecoveryAbsence(fixture.principal, {
      invocation_ref: admitted.invocation.invocation_ref,
      lease_token: recovery.lease_token,
      recovery_evidence: evidence,
    }),
    (error) => error.code === 'RECOVERY_ABSENCE_ATTESTATION_FAILED',
  );
  fixture.attestRecoveryAbsence(evidence);
  const closed = await fixture.controlPlane.completeRecoveryAbsence(fixture.principal, {
    invocation_ref: admitted.invocation.invocation_ref,
    lease_token: recovery.lease_token,
    recovery_evidence: evidence,
  });
  assert.equal(closed.state, 'failed_closed');
  assert.equal((await fixture.controlPlane.health()).ready, true);
  const next = await fixture.controlPlane.admitInvocation(fixture.principal, invocationRequest({
    idempotency_key: 'idempotency-key-00000002',
  }));
  assert.equal(next.created, true);
});

test('expired recovery leases are reaped and can be reclaimed', async () => {
  const fixture = await createFixture();
  const admitted = await fixture.controlPlane.admitInvocation(fixture.principal, invocationRequest());
  await fixture.controlPlane.claimExecution(fixture.principal, {
    invocation_ref: admitted.invocation.invocation_ref,
    lease_token: fixture.nextLeaseToken(),
    worker_id: 'worker_alpha',
    lease_ms: 5_000,
  });
  fixture.setNow('2026-09-05T12:00:06.000Z');
  await fixture.controlPlane.sweepExpiredLeases();
  await fixture.controlPlane.claimRecovery(fixture.principal, {
    invocation_ref: admitted.invocation.invocation_ref,
    lease_token: fixture.nextLeaseToken(),
    worker_id: 'recovery_alpha',
    lease_ms: 5_000,
  });
  fixture.setNow('2026-09-05T12:00:12.000Z');
  const reaped = await fixture.controlPlane.sweepExpiredLeases();
  assert.equal(reaped[0].state, 'recovery_required');
  assert.equal(reaped[0].lease_kind, null);
  const reclaimed = await fixture.controlPlane.claimRecovery(fixture.principal, {
    invocation_ref: admitted.invocation.invocation_ref,
    lease_token: fixture.nextLeaseToken(),
    worker_id: 'recovery_beta',
    lease_ms: 5_000,
  });
  assert.equal(reclaimed.invocation.lease_kind, 'recovery');
});

test('an expired running lease keeps recorded resources in cleanup at worst-case cost', async () => {
  const fixture = await createFixture();
  const admitted = await fixture.controlPlane.admitInvocation(
    fixture.principal,
    invocationRequest({ estimated_cost_micros: 100_000 }),
  );
  const lease = await fixture.controlPlane.claimExecution(fixture.principal, {
    invocation_ref: admitted.invocation.invocation_ref,
    lease_token: fixture.nextLeaseToken(),
    worker_id: 'worker_alpha',
    lease_ms: 5_000,
  });
  fixture.attestResourceBinding(admitted.invocation, {
    savepoint_ref: 'savepoint_expiry',
    fork_ref: 'fork_expiry',
  });
  await fixture.controlPlane.recordResources(fixture.principal, {
    invocation_ref: admitted.invocation.invocation_ref,
    lease_token: lease.lease_token,
    savepoint_ref: 'savepoint_expiry',
    fork_ref: 'fork_expiry',
  });
  fixture.setNow('2026-09-05T12:00:06.000Z');
  const swept = await fixture.controlPlane.sweepExpiredLeases();
  assert.equal(swept.length, 1);
  assert.equal(swept[0].state, 'cleanup_pending');
  assert.equal(swept[0].execution_outcome, 'ambiguous');
  assert.equal(swept[0].actual_cost_micros, 100_000);
  assert.equal(swept[0].cleanup_requests.length, 2);
});

test('invalid outcome evidence cannot partially settle budget before lease recovery', async () => {
  const fixture = await createFixture();
  const admitted = await fixture.controlPlane.admitInvocation(fixture.principal, invocationRequest());
  const lease = await fixture.controlPlane.claimExecution(fixture.principal, {
    invocation_ref: admitted.invocation.invocation_ref,
    lease_token: fixture.nextLeaseToken(),
    worker_id: 'worker_alpha',
    lease_ms: 5_000,
  });
  fixture.attestResourceBinding(admitted.invocation, {
    savepoint_ref: 'savepoint_atomic',
    fork_ref: 'fork_atomic',
  });
  await fixture.controlPlane.recordResources(fixture.principal, {
    invocation_ref: admitted.invocation.invocation_ref,
    lease_token: lease.lease_token,
    savepoint_ref: 'savepoint_atomic',
    fork_ref: 'fork_atomic',
  });
  await assert.rejects(
    fixture.controlPlane.recordExecutionOutcome(fixture.principal, {
      invocation_ref: admitted.invocation.invocation_ref,
      lease_token: lease.lease_token,
      outcome: 'succeeded',
      actual_cost_micros: 0,
      execution_evidence_hash: 'invalid',
      result_hash: sha256Ref({ result: 'candidate' }),
    }),
    /execution_evidence_hash/,
  );
  const unchanged = await fixture.controlPlane.getInvocation(
    fixture.principal,
    admitted.invocation.invocation_ref,
  );
  assert.equal(unchanged.state, 'running');
  assert.equal(unchanged.actual_cost_micros, null);
  fixture.setNow('2026-09-05T12:00:06.000Z');
  const swept = await fixture.controlPlane.sweepExpiredLeases();
  assert.equal(swept[0].state, 'cleanup_pending');
  assert.equal(swept[0].actual_cost_micros, 100_000);
});

test('wrong and expired lease tokens cannot mutate invocation state', async () => {
  let resourceVerifierCalls = 0;
  const fixture = await createFixture({
    verifyResourceBinding: async () => {
      resourceVerifierCalls += 1;
      return true;
    },
  });
  const admitted = await fixture.controlPlane.admitInvocation(fixture.principal, invocationRequest());
  const lease = await fixture.controlPlane.claimExecution(fixture.principal, {
    invocation_ref: admitted.invocation.invocation_ref,
    lease_token: fixture.nextLeaseToken(),
    worker_id: 'worker_alpha',
    lease_ms: 5_000,
  });
  await assert.rejects(
    fixture.controlPlane.recordResources(fixture.principal, {
      invocation_ref: admitted.invocation.invocation_ref,
      lease_token: 'wrong_lease_token_000000000000000000000000',
      savepoint_ref: 'savepoint_001',
      fork_ref: 'fork_001',
    }),
    (error) => error.code === 'LEASE_TOKEN_INVALID',
  );
  assert.equal(resourceVerifierCalls, 0);
  fixture.setNow('2026-09-05T12:00:06.000Z');
  await assert.rejects(
    fixture.controlPlane.recordResources(fixture.principal, {
      invocation_ref: admitted.invocation.invocation_ref,
      lease_token: lease.lease_token,
      savepoint_ref: 'savepoint_001',
    }),
    (error) => error.code === 'LEASE_EXPIRED',
  );
  assert.equal(resourceVerifierCalls, 0);
  await assert.rejects(
    fixture.controlPlane.renewLease(fixture.principal, {
      invocation_ref: admitted.invocation.invocation_ref,
      lease_token: lease.lease_token,
      lease_ms: 5_000,
    }),
    (error) => error.code === 'LEASE_EXPIRED',
  );
});

test('unclaimed admissions expire closed and release their reservation', async () => {
  const fixture = await createFixture({ dailyBudget: 100_000, invocationBudget: 100_000 });
  const admitted = await fixture.controlPlane.admitInvocation(
    fixture.principal,
    invocationRequest({ estimated_cost_micros: 100_000 }),
  );
  fixture.setNow('2026-09-05T12:16:00.000Z');
  const swept = await fixture.controlPlane.sweepExpiredLeases();
  assert.equal(swept.length, 1);
  assert.equal(swept[0].invocation_ref, admitted.invocation.invocation_ref);
  assert.equal(swept[0].state, 'failed_closed');
  assert.equal(swept[0].actual_cost_micros, 0);

  const next = await fixture.controlPlane.admitInvocation(
    fixture.principal,
    invocationRequest({ idempotency_key: 'idempotency-key-00000002' }),
  );
  assert.equal(next.created, true);
});
