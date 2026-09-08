import assert from 'node:assert/strict';
import test from 'node:test';
import { sha256Ref } from '../../src/canonical.mjs';
import {
  createCleanupVerificationEvidence,
  createCleanupVerificationRequest,
} from '../../src/provider.mjs';
import { verifyManagedAuditChain } from '../src/audit.mjs';
import {
  createManagedRiskForkControlPlane,
  verifyManagedCleanupPlan,
} from '../src/control-plane.mjs';
import { createManagedProviderRegistry } from '../src/provider-registry.mjs';
import { createFixture, invocationRequest, TestProvider } from './helpers.mjs';

test('full local-test lifecycle requires verified cleanup before terminal success', async () => {
  const fixture = await createFixture();
  const admitted = await fixture.controlPlane.admitInvocation(
    fixture.principal,
    invocationRequest(),
  );
  assert.equal(admitted.created, true);
  assert.equal(admitted.invocation.state, 'admitted');
  assert.equal(Object.hasOwn(admitted.invocation, 'operation'), false);
  assert.match(admitted.invocation.provider_binding_hash, /^sha256:[a-f0-9]{64}$/);
  assert.match(admitted.invocation.provider_adapter_digest, /^sha256:[a-f0-9]{64}$/);
  assert.match(
    admitted.invocation.provider_qualification_receipt_hash,
    /^sha256:[a-f0-9]{64}$/,
  );
  const mismatchedRegistry = createManagedProviderRegistry([{
    provider: new TestProvider(),
    enabled: true,
    adapter_digest: sha256Ref({ adapter: 'different_adapter_digest' }),
    qualification_class: 'local_test',
    qualification_receipt_hash: sha256Ref({ fixture: true }),
    tenant_ids: ['tenant_alpha'],
    verify_resource_binding: async () => false,
    verify_cleanup_evidence: async () => false,
    verify_recovery_absence: async () => false,
  }]);
  const mismatchedControlPlane = createManagedRiskForkControlPlane({
    config: fixture.config,
    store: fixture.store,
    providerRegistry: mismatchedRegistry,
    requirePrincipal: fixture.authenticator.requirePrincipal,
  });
  await assert.rejects(
    mismatchedControlPlane.claimExecution(fixture.principal, {
      invocation_ref: admitted.invocation.invocation_ref,
      lease_token: fixture.nextLeaseToken(),
      worker_id: 'worker_wrong_binding',
      lease_ms: 5_000,
    }),
    (error) => error.code === 'PROVIDER_NOT_ELIGIBLE',
  );

  const replay = await fixture.controlPlane.admitInvocation(
    fixture.principal,
    invocationRequest(),
  );
  assert.equal(replay.created, false);
  assert.equal(replay.invocation.invocation_ref, admitted.invocation.invocation_ref);

  const executionLease = await fixture.controlPlane.claimExecution(fixture.principal, {
    invocation_ref: admitted.invocation.invocation_ref,
    lease_token: fixture.nextLeaseToken(),
    worker_id: 'worker_alpha',
    lease_ms: 30_000,
  });
  assert.equal(executionLease.invocation.state, 'execution_leased');
  assert.equal(executionLease.invocation.operation.kind, 'mcp_tool_call');
  assert.equal(executionLease.production_authority, false);

  fixture.attestResourceBinding(admitted.invocation, {
    savepoint_ref: 'savepoint_001',
    fork_ref: 'fork_001',
  });
  const running = await fixture.controlPlane.recordResources(fixture.principal, {
    invocation_ref: admitted.invocation.invocation_ref,
    lease_token: executionLease.lease_token,
    savepoint_ref: 'savepoint_001',
    fork_ref: 'fork_001',
  });
  assert.equal(running.state, 'running');
  assert.equal(running.cleanup_requests.length, 2);

  const cleanupPending = await fixture.controlPlane.recordExecutionOutcome(fixture.principal, {
    invocation_ref: admitted.invocation.invocation_ref,
    lease_token: executionLease.lease_token,
    outcome: 'succeeded',
    actual_cost_micros: 80_000,
    execution_evidence_hash: sha256Ref({ execution: 'bounded' }),
    result_hash: sha256Ref({ result: 'candidate' }),
  });
  assert.equal(cleanupPending.state, 'cleanup_pending');
  assert.equal(cleanupPending.actual_cost_micros, 80_000);
  assert.equal(cleanupPending.lease_kind, null);

  const cleanupLease = await fixture.controlPlane.claimCleanup(fixture.principal, {
    invocation_ref: admitted.invocation.invocation_ref,
    lease_token: fixture.nextLeaseToken(),
    worker_id: 'cleanup_alpha',
    lease_ms: 30_000,
  });
  assert.equal(Object.hasOwn(cleanupLease.invocation, 'operation'), false);
  const evidence = cleanupLease.invocation.cleanup_requests.map((request, index) => (
    createCleanupVerificationEvidence(request, {
      status: 'verified',
      observed_at: '2026-09-05T12:00:00.000Z',
      evidence_ref: `cleanup_evidence_${index + 1}`,
      observation_hash: sha256Ref({ request_hash: request.request_hash, absent: true }),
    })
  ));
  for (const item of evidence) fixture.attestCleanupEvidence(item);
  const completed = await fixture.controlPlane.completeCleanup(fixture.principal, {
    invocation_ref: admitted.invocation.invocation_ref,
    lease_token: cleanupLease.lease_token,
    cleanup_evidence: evidence,
  });
  assert.equal(completed.state, 'completed');
  assert.equal(completed.terminal_at, '2026-09-05T12:00:00.000Z');

  const events = await fixture.controlPlane.listAuditEvents(
    fixture.principal,
    admitted.invocation.invocation_ref,
  );
  assert.equal(events.length, 6);
  assert.equal(verifyManagedAuditChain(events), true);
  assert.equal(events.at(-1).event_type, 'cleanup_verified');
  assert.equal(events.at(-1).evidence_class, 'control_plane_self_attested');
  assert.throws(() => verifyManagedAuditChain([]), /at least one event/);
  const rehashedExtraField = JSON.parse(JSON.stringify(events));
  rehashedExtraField[0].unexpected = 'field';
  rehashedExtraField[0].event_hash = sha256Ref({
    ...rehashedExtraField[0],
    event_hash: null,
  });
  assert.throws(
    () => verifyManagedAuditChain(rehashedExtraField),
    /unsupported field/,
  );
  let legacySplitReads = 0;
  fixture.store.getInvocation = async () => {
    legacySplitReads += 1;
    throw new Error('split invocation read must not be used');
  };
  fixture.store.listAuditEvents = async () => {
    legacySplitReads += 1;
    throw new Error('split audit read must not be used');
  };
  assert.equal((await fixture.controlPlane.listAuditEvents(
    fixture.principal,
    admitted.invocation.invocation_ref,
  )).length, 6);
  assert.equal(legacySplitReads, 0);
  const anchoredSnapshot = await fixture.store.getAuditSnapshot(
    fixture.principal.tenant_id,
    admitted.invocation.invocation_ref,
  );
  fixture.store.getAuditSnapshot = async () => ({
    invocation: anchoredSnapshot.invocation,
    events: events.slice(0, -1),
  });
  await assert.rejects(
    fixture.controlPlane.listAuditEvents(
      fixture.principal,
      admitted.invocation.invocation_ref,
    ),
    (error) => error.code === 'AUDIT_CHAIN_INCOMPLETE',
  );
});

test('cleanup cannot complete with partial, failed, or duplicated evidence', async () => {
  const fixture = await createFixture();
  const admitted = await fixture.controlPlane.admitInvocation(fixture.principal, invocationRequest());
  const execution = await fixture.controlPlane.claimExecution(fixture.principal, {
    invocation_ref: admitted.invocation.invocation_ref,
    lease_token: fixture.nextLeaseToken(),
    worker_id: 'worker_alpha',
    lease_ms: 30_000,
  });
  fixture.attestResourceBinding(admitted.invocation, {
    savepoint_ref: 'savepoint_001',
    fork_ref: 'fork_001',
  });
  await fixture.controlPlane.recordResources(fixture.principal, {
    invocation_ref: admitted.invocation.invocation_ref,
    lease_token: execution.lease_token,
    savepoint_ref: 'savepoint_001',
    fork_ref: 'fork_001',
  });
  await fixture.controlPlane.recordExecutionOutcome(fixture.principal, {
    invocation_ref: admitted.invocation.invocation_ref,
    lease_token: execution.lease_token,
    outcome: 'failed',
    actual_cost_micros: 0,
    execution_evidence_hash: sha256Ref({ failed: true }),
    result_hash: sha256Ref({ result: null }),
  });
  const cleanup = await fixture.controlPlane.claimCleanup(fixture.principal, {
    invocation_ref: admitted.invocation.invocation_ref,
    lease_token: fixture.nextLeaseToken(),
    worker_id: 'cleanup_alpha',
    lease_ms: 30_000,
  });
  const request = cleanup.invocation.cleanup_requests[0];
  let descriptorInvocations = 0;
  const hostileEvidence = new Proxy({}, {
    get() {
      descriptorInvocations += 1;
      throw new Error('must not run');
    },
  });
  await assert.rejects(
    fixture.controlPlane.completeCleanup(fixture.principal, {
      invocation_ref: admitted.invocation.invocation_ref,
      lease_token: cleanup.lease_token,
      cleanup_evidence: [hostileEvidence, hostileEvidence],
    }),
    /must not be a Proxy/,
  );
  assert.equal(descriptorInvocations, 0);
  const oneEvidence = createCleanupVerificationEvidence(request, {
    status: 'verified',
    observed_at: '2026-09-05T12:00:00.000Z',
    evidence_ref: 'cleanup_evidence_1',
    observation_hash: sha256Ref({ absent: true }),
  });
  await assert.rejects(
    fixture.controlPlane.completeCleanup(fixture.principal, {
      invocation_ref: admitted.invocation.invocation_ref,
      lease_token: cleanup.lease_token,
      cleanup_evidence: [oneEvidence],
    }),
    (error) => error.code === 'CLEANUP_EVIDENCE_INCOMPLETE',
  );
  const fabricatedCompleteEvidence = cleanup.invocation.cleanup_requests.map((cleanupRequest, index) => (
    createCleanupVerificationEvidence(cleanupRequest, {
      status: 'verified',
      observed_at: '2026-09-05T12:00:00.000Z',
      evidence_ref: `fabricated_cleanup_evidence_${index + 1}`,
      observation_hash: sha256Ref({ cleanup_request_hash: cleanupRequest.request_hash }),
    })
  ));
  await assert.rejects(
    fixture.controlPlane.completeCleanup(fixture.principal, {
      invocation_ref: admitted.invocation.invocation_ref,
      lease_token: cleanup.lease_token,
      cleanup_evidence: fabricatedCompleteEvidence,
    }),
    (error) => error.code === 'CLEANUP_PROVIDER_ATTESTATION_FAILED',
  );
});

test('cleanup plans must exactly match every recorded provider resource', async () => {
  const fixture = await createFixture();
  const admitted = await fixture.controlPlane.admitInvocation(fixture.principal, invocationRequest());
  const execution = await fixture.controlPlane.claimExecution(fixture.principal, {
    invocation_ref: admitted.invocation.invocation_ref,
    lease_token: fixture.nextLeaseToken(),
    worker_id: 'worker_cleanup_integrity',
    lease_ms: 30_000,
  });
  fixture.attestResourceBinding(admitted.invocation, {
    savepoint_ref: 'savepoint_cleanup_integrity',
    fork_ref: 'fork_cleanup_integrity',
  });
  const running = await fixture.controlPlane.recordResources(fixture.principal, {
    invocation_ref: admitted.invocation.invocation_ref,
    lease_token: execution.lease_token,
    savepoint_ref: 'savepoint_cleanup_integrity',
    fork_ref: 'fork_cleanup_integrity',
  });
  assert.equal(verifyManagedCleanupPlan(running).length, 2);
  const fakeForkRequest = createCleanupVerificationRequest({
    provider_id: running.provider_id,
    resource_kind: 'fork',
    resource_ref: 'fork_not_the_recorded_resource',
    requested_at: running.updated_at,
    request_nonce: 'nonce_fake_fork',
  });
  assert.throws(
    () => verifyManagedCleanupPlan({
      ...running,
      cleanup_requests: running.cleanup_requests.map((request) => (
        request.resource_kind === 'fork' ? fakeForkRequest : request
      )),
    }),
    (error) => error.code === 'CLEANUP_PLAN_INTEGRITY_FAILED',
  );
  assert.throws(
    () => verifyManagedCleanupPlan({
      ...running,
      cleanup_requests: running.cleanup_requests.slice(0, 1),
    }),
    (error) => error.code === 'CLEANUP_PLAN_INTEGRITY_FAILED',
  );
  assert.throws(
    () => verifyManagedCleanupPlan({
      ...running,
      cleanup_requests: [...running.cleanup_requests, running.cleanup_requests[0]],
    }),
    /too large/,
  );
});

test('corrupt cleanup plans fail before provider resource attestation', async () => {
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
    lease_token: fixture.nextLeaseToken(),
    worker_id: 'worker_corrupt_cleanup_plan',
    lease_ms: 30_000,
  });
  const originalAssertActiveLease = fixture.store.assertActiveLease.bind(fixture.store);
  fixture.store.assertActiveLease = async (input) => ({
    ...(await originalAssertActiveLease(input)),
    cleanup_requests: [createCleanupVerificationRequest({
      provider_id: 'local-test-provider',
      resource_kind: 'fork',
      resource_ref: 'unrecorded_fork',
      requested_at: '2026-09-05T12:00:00.000Z',
      request_nonce: 'nonce_corrupt_cleanup_plan',
    })],
  });
  await assert.rejects(
    fixture.controlPlane.recordResources(fixture.principal, {
      invocation_ref: admitted.invocation.invocation_ref,
      lease_token: execution.lease_token,
      savepoint_ref: 'savepoint_after_corruption',
    }),
    (error) => error.code === 'CLEANUP_PLAN_INTEGRITY_FAILED',
  );
  assert.equal(verifierCalls, 0);
});

test('provider bindings are canonical, versioned, and retain cleanup-only rotations', () => {
  const callbackSet = {
    verify_resource_binding: async () => false,
    verify_cleanup_evidence: async () => false,
    verify_recovery_absence: async () => false,
  };
  const oldRegistration = {
    provider: new TestProvider(),
    enabled: true,
    adapter_digest: sha256Ref({ adapter: 'old' }),
    qualification_class: 'local_test',
    qualification_receipt_hash: sha256Ref({ qualification: 'old' }),
    tenant_ids: ['tenant_other', 'tenant_alpha'],
    ...callbackSet,
  };
  const reordered = createManagedProviderRegistry([{
    ...oldRegistration,
    tenant_ids: ['tenant_alpha', 'tenant_other'],
  }]).admissionBinding('local-test-provider', 'tenant_alpha');
  const oldRegistry = createManagedProviderRegistry([oldRegistration]);
  const oldBinding = oldRegistry.admissionBinding('local-test-provider', 'tenant_alpha');
  assert.equal(reordered.provider_binding_hash, oldBinding.provider_binding_hash);

  const rotated = createManagedProviderRegistry([
    { ...oldRegistration, enabled: false },
    {
      ...oldRegistration,
      adapter_digest: sha256Ref({ adapter: 'new' }),
      qualification_receipt_hash: sha256Ref({ qualification: 'new' }),
      tenant_ids: ['tenant_other'],
    },
  ]);
  assert.equal(
    rotated.requireBound(
      'local-test-provider',
      'tenant_alpha',
      oldBinding.provider_binding_hash,
      { allowDisabled: true },
    ).id,
    'local-test-provider',
  );
  assert.throws(
    () => rotated.requireBound(
      'local-test-provider',
      'tenant_alpha',
      oldBinding.provider_binding_hash,
    ),
    (error) => error.code === 'PROVIDER_NOT_ELIGIBLE',
  );
  assert.throws(
    () => createManagedProviderRegistry([
      oldRegistration,
      {
        ...oldRegistration,
        adapter_digest: sha256Ref({ adapter: 'simultaneously-enabled' }),
      },
    ]),
    /multiple enabled bindings/,
  );
});

test('provider registry exposes an immutable snapshot and fails closed on adapter drift', () => {
  const provider = new TestProvider();
  const registry = createManagedProviderRegistry([{
    provider,
    enabled: true,
    adapter_digest: sha256Ref({ adapter: 'capability-drift' }),
    qualification_class: 'local_test',
    qualification_receipt_hash: sha256Ref({ qualification: 'capability-drift' }),
    tenant_ids: ['tenant_alpha'],
    verify_resource_binding: async () => true,
    verify_cleanup_evidence: async () => true,
    verify_recovery_absence: async () => true,
  }]);
  const binding = registry.admissionBinding('local-test-provider', 'tenant_alpha');
  const exposed = registry.requireBound(
    'local-test-provider',
    'tenant_alpha',
    binding.provider_binding_hash,
  );
  assert.notEqual(exposed, provider);
  assert.equal(Object.isFrozen(exposed), true);
  assert.equal(Object.isFrozen(exposed.capabilities), true);
  provider.capabilities = {
    ...provider.capabilities,
    supports_verified_destruction: false,
  };
  assert.equal(registry.hasBound(
    'local-test-provider',
    'tenant_alpha',
    binding.provider_binding_hash,
  ), false);
  assert.throws(
    () => registry.requireBound(
      'local-test-provider',
      'tenant_alpha',
      binding.provider_binding_hash,
    ),
    (error) => error.code === 'PROVIDER_BINDING_DRIFT' && error.status === 503,
  );
  assert.deepEqual(registry.summary(), {
    provider_count: 0,
    registered_provider_count: 1,
    provider_binding_integrity: false,
    qualification_class: 'none',
    production_provider_count: 0,
  });
});

test('provider facade rejects synchronous and asynchronous self-mutation before returning', async () => {
  const callbacks = {
    verify_resource_binding: async () => true,
    verify_cleanup_evidence: async () => true,
    verify_recovery_absence: async () => true,
  };
  function registryFor(provider, suffix) {
    return createManagedProviderRegistry([{
      provider,
      enabled: true,
      adapter_digest: sha256Ref({ adapter: `self-mutation-${suffix}` }),
      qualification_class: 'local_test',
      qualification_receipt_hash: sha256Ref({ qualification: `self-mutation-${suffix}` }),
      tenant_ids: ['tenant_alpha'],
      ...callbacks,
    }]);
  }

  const synchronous = new TestProvider('sync-mutating-provider');
  synchronous.collectDiff = function collectDiff() {
    this.capabilities = { ...this.capabilities, supports_verified_destruction: false };
    return { should_not_escape: true };
  };
  const syncRegistry = registryFor(synchronous, 'sync');
  const syncBinding = syncRegistry.admissionBinding(synchronous.id, 'tenant_alpha');
  const syncFacade = syncRegistry.requireBound(
    synchronous.id,
    'tenant_alpha',
    syncBinding.provider_binding_hash,
  );
  await assert.rejects(
    syncFacade.collectDiff(),
    (error) => error.code === 'PROVIDER_BINDING_DRIFT' && error.status === 503,
  );

  const asynchronous = new TestProvider('async-mutating-provider');
  asynchronous.executeInFork = async function executeInFork() {
    await Promise.resolve();
    this.capabilities = { ...this.capabilities, supports_hard_ttl: false };
    return { should_not_escape: true };
  };
  const asyncRegistry = registryFor(asynchronous, 'async');
  const asyncBinding = asyncRegistry.admissionBinding(asynchronous.id, 'tenant_alpha');
  const asyncFacade = asyncRegistry.requireBound(
    asynchronous.id,
    'tenant_alpha',
    asyncBinding.provider_binding_hash,
  );
  await assert.rejects(
    asyncFacade.executeInFork(),
    (error) => error.code === 'PROVIDER_BINDING_DRIFT' && error.status === 503,
  );
});

test('provider registry rejects Proxy and accessor capability surfaces without executing them', () => {
  const callbacks = {
    verify_resource_binding: async () => false,
    verify_cleanup_evidence: async () => false,
    verify_recovery_absence: async () => false,
  };
  let proxyTouches = 0;
  const proxied = new Proxy(new TestProvider('proxy-provider'), {
    get(target, key, receiver) {
      proxyTouches += 1;
      return Reflect.get(target, key, receiver);
    },
  });
  assert.throws(() => createManagedProviderRegistry([{
    provider: proxied,
    enabled: true,
    adapter_digest: sha256Ref({ adapter: 'proxy-provider' }),
    qualification_class: 'local_test',
    qualification_receipt_hash: sha256Ref({ qualification: 'proxy-provider' }),
    tenant_ids: ['tenant_alpha'],
    ...callbacks,
  }]), /non-Proxy object/);
  assert.equal(proxyTouches, 0);

  let getterTouches = 0;
  const accessorProvider = new TestProvider('accessor-provider');
  const originalCapabilities = accessorProvider.capabilities;
  Object.defineProperty(accessorProvider, 'capabilities', {
    enumerable: true,
    configurable: true,
    get() {
      getterTouches += 1;
      return originalCapabilities;
    },
  });
  assert.throws(() => createManagedProviderRegistry([{
    provider: accessorProvider,
    enabled: true,
    adapter_digest: sha256Ref({ adapter: 'accessor-provider' }),
    qualification_class: 'local_test',
    qualification_receipt_hash: sha256Ref({ qualification: 'accessor-provider' }),
    tenant_ids: ['tenant_alpha'],
    ...callbacks,
  }]), /capabilities must be an own data property/);
  assert.equal(getterTouches, 0);
});

test('readiness fails when a nonterminal invocation loses its exact provider binding', async () => {
  const fixture = await createFixture();
  await fixture.controlPlane.admitInvocation(fixture.principal, invocationRequest());
  const replacementRegistry = createManagedProviderRegistry([{
    provider: new TestProvider(),
    enabled: true,
    adapter_digest: sha256Ref({ adapter: 'replacement-only' }),
    qualification_class: 'local_test',
    qualification_receipt_hash: sha256Ref({ qualification: 'replacement-only' }),
    tenant_ids: ['tenant_alpha'],
    verify_resource_binding: async () => false,
    verify_cleanup_evidence: async () => false,
    verify_recovery_absence: async () => false,
  }]);
  const replacementControlPlane = createManagedRiskForkControlPlane({
    config: fixture.config,
    store: fixture.store,
    providerRegistry: replacementRegistry,
    requirePrincipal: fixture.authenticator.requirePrincipal,
  });
  const health = await replacementControlPlane.health();
  assert.equal(health.ready, false);
  assert.equal(health.provider_binding_obligation_count, 1);
  assert.equal(health.provider_binding_obligations_complete, true);
  assert.equal(health.unavailable_provider_binding_count, 1);
});

test('readiness requires enabled bindings only while execution authority can still advance', async () => {
  const fixture = await createFixture();
  const admitted = await fixture.controlPlane.admitInvocation(fixture.principal, invocationRequest());
  const historicalRegistration = {
    provider: new TestProvider(),
    enabled: false,
    adapter_digest: sha256Ref({ adapter: 'managed_service_test_fixture', version: 1 }),
    qualification_class: 'local_test',
    qualification_receipt_hash: sha256Ref({ fixture: true }),
    tenant_ids: ['tenant_alpha', 'tenant_other'],
    verify_resource_binding: async () => true,
    verify_cleanup_evidence: async () => true,
    verify_recovery_absence: async () => true,
  };
  const replacementRegistry = createManagedProviderRegistry([
    historicalRegistration,
    {
      ...historicalRegistration,
      provider: new TestProvider('unrelated-provider'),
      enabled: true,
      adapter_digest: sha256Ref({ adapter: 'unrelated-enabled-provider' }),
      qualification_receipt_hash: sha256Ref({ qualification: 'unrelated-enabled-provider' }),
      tenant_ids: ['tenant_alpha'],
    },
  ]);
  const replacementControlPlane = createManagedRiskForkControlPlane({
    config: fixture.config,
    store: fixture.store,
    providerRegistry: replacementRegistry,
    requirePrincipal: fixture.authenticator.requirePrincipal,
  });
  const admittedHealth = await replacementControlPlane.health();
  assert.equal(admittedHealth.providers.provider_count, 1);
  assert.equal(admittedHealth.ready, false);
  assert.equal(admittedHealth.unavailable_provider_binding_count, 1);

  const execution = await fixture.controlPlane.claimExecution(fixture.principal, {
    invocation_ref: admitted.invocation.invocation_ref,
    lease_token: fixture.nextLeaseToken(),
    worker_id: 'worker_binding_obligation',
    lease_ms: 30_000,
  });
  fixture.attestResourceBinding(admitted.invocation, {
    savepoint_ref: 'savepoint_binding_obligation',
    fork_ref: 'fork_binding_obligation',
  });
  await fixture.controlPlane.recordResources(fixture.principal, {
    invocation_ref: admitted.invocation.invocation_ref,
    lease_token: execution.lease_token,
    savepoint_ref: 'savepoint_binding_obligation',
    fork_ref: 'fork_binding_obligation',
  });
  await fixture.controlPlane.recordExecutionOutcome(fixture.principal, {
    invocation_ref: admitted.invocation.invocation_ref,
    lease_token: execution.lease_token,
    outcome: 'failed',
    actual_cost_micros: 0,
    execution_evidence_hash: sha256Ref({ binding_obligation_execution: true }),
    result_hash: sha256Ref({ binding_obligation_result: true }),
  });
  const cleanupHealth = await replacementControlPlane.health();
  assert.equal(cleanupHealth.ready, true);
  assert.equal(cleanupHealth.unavailable_provider_binding_count, 0);
});

test('resource attestations bind tenant, recovery mode, and absent resource kinds', async () => {
  let observedTenant = null;
  const registry = createManagedProviderRegistry([{
    provider: new TestProvider(),
    enabled: true,
    adapter_digest: sha256Ref({ adapter: 'attestation-binding' }),
    qualification_class: 'local_test',
    qualification_receipt_hash: sha256Ref({ qualification: 'attestation-binding' }),
    tenant_ids: ['tenant_alpha'],
    verify_resource_binding: async ({ tenant_id: tenantId }) => {
      observedTenant = tenantId;
      return true;
    },
    verify_cleanup_evidence: async () => false,
    verify_recovery_absence: async () => false,
  }]);
  const binding = registry.admissionBinding('local-test-provider', 'tenant_alpha');
  const common = {
    provider_id: 'local-test-provider',
    tenant_id: 'tenant_alpha',
    provider_binding_hash: binding.provider_binding_hash,
  };
  const presentHash = await registry.verifyResourceBinding({
    ...common,
    resources: {
      provider_recovery_key: sha256Ref({ recovery: 'attestation-binding' }),
      savepoint_ref: 'savepoint_binding',
      fork_ref: null,
      absent_resource_kinds: [],
    },
    context: {
      invocation_ref: 'rfi_attestation_binding',
      recovery_mode: false,
      now: '2026-09-05T12:00:00.000Z',
    },
  });
  const recoveredHash = await registry.verifyResourceBinding({
    ...common,
    resources: {
      provider_recovery_key: sha256Ref({ recovery: 'attestation-binding' }),
      savepoint_ref: 'savepoint_binding',
      fork_ref: null,
      absent_resource_kinds: ['fork'],
    },
    context: {
      invocation_ref: 'rfi_attestation_binding',
      recovery_mode: true,
      now: '2026-09-05T12:00:01.000Z',
    },
  });
  assert.equal(observedTenant, 'tenant_alpha');
  assert.notEqual(presentHash, recoveredHash);
});

test('cleanup claim delivery retries are idempotent and historical tokens stay retired', async () => {
  const fixture = await createFixture();
  const admitted = await fixture.controlPlane.admitInvocation(fixture.principal, invocationRequest());
  const execution = await fixture.controlPlane.claimExecution(fixture.principal, {
    invocation_ref: admitted.invocation.invocation_ref,
    lease_token: fixture.nextLeaseToken('cleanup_replay_execution'),
    worker_id: 'worker_cleanup_replay_execution',
    lease_ms: 30_000,
  });
  fixture.attestResourceBinding(admitted.invocation, {
    savepoint_ref: 'savepoint_cleanup_replay',
    fork_ref: 'fork_cleanup_replay',
  });
  await fixture.controlPlane.recordResources(fixture.principal, {
    invocation_ref: admitted.invocation.invocation_ref,
    lease_token: execution.lease_token,
    savepoint_ref: 'savepoint_cleanup_replay',
    fork_ref: 'fork_cleanup_replay',
  });
  await fixture.controlPlane.recordExecutionOutcome(fixture.principal, {
    invocation_ref: admitted.invocation.invocation_ref,
    lease_token: execution.lease_token,
    outcome: 'failed',
    actual_cost_micros: 0,
    execution_evidence_hash: sha256Ref({ cleanup_replay_execution: true }),
    result_hash: sha256Ref({ cleanup_replay_result: true }),
  });
  const cleanupToken = fixture.nextLeaseToken('cleanup_replay');
  const cleanupRequest = {
    invocation_ref: admitted.invocation.invocation_ref,
    lease_token: cleanupToken,
    worker_id: 'worker_cleanup_replay',
    lease_ms: 5_000,
  };
  const first = await fixture.controlPlane.claimCleanup(fixture.principal, cleanupRequest);
  const replay = await fixture.controlPlane.claimCleanup(fixture.principal, cleanupRequest);
  assert.equal(first.claim_replayed, false);
  assert.equal(replay.claim_replayed, true);
  assert.deepEqual(replay.invocation, first.invocation);
  assert.equal(Object.hasOwn(first.invocation, 'operation'), false);
  const events = await fixture.controlPlane.listAuditEvents(
    fixture.principal,
    admitted.invocation.invocation_ref,
  );
  assert.equal(events.filter((event) => event.event_type === 'cleanup_lease_claimed').length, 1);

  fixture.setNow('2026-09-05T12:00:05.000Z');
  await assert.rejects(
    fixture.controlPlane.claimCleanup(fixture.principal, cleanupRequest),
    (error) => error.code === 'LEASE_EXPIRED' && error.status === 409,
  );
  const [reaped] = await fixture.controlPlane.sweepExpiredLeases();
  assert.equal(reaped.state, 'cleanup_pending');
  await assert.rejects(
    fixture.controlPlane.claimCleanup(fixture.principal, cleanupRequest),
    (error) => error.code === 'LEASE_TOKEN_REPLAYED' && error.status === 409,
  );
  const reclaimed = await fixture.controlPlane.claimCleanup(fixture.principal, {
    ...cleanupRequest,
    lease_token: fixture.nextLeaseToken('cleanup_reclaimed'),
  });
  assert.equal(reclaimed.claim_replayed, false);
});

test('wrong or expired cleanup leases trigger zero cleanup verifier calls', async () => {
  let cleanupVerifierCalls = 0;
  const fixture = await createFixture({
    verifyResourceBinding: async () => true,
    verifyCleanupEvidence: async () => {
      cleanupVerifierCalls += 1;
      return true;
    },
  });
  const admitted = await fixture.controlPlane.admitInvocation(fixture.principal, invocationRequest());
  const execution = await fixture.controlPlane.claimExecution(fixture.principal, {
    invocation_ref: admitted.invocation.invocation_ref,
    lease_token: fixture.nextLeaseToken(),
    worker_id: 'worker_preflight_cleanup',
    lease_ms: 30_000,
  });
  await fixture.controlPlane.recordResources(fixture.principal, {
    invocation_ref: admitted.invocation.invocation_ref,
    lease_token: execution.lease_token,
    savepoint_ref: 'savepoint_preflight_cleanup',
    fork_ref: 'fork_preflight_cleanup',
  });
  await fixture.controlPlane.recordExecutionOutcome(fixture.principal, {
    invocation_ref: admitted.invocation.invocation_ref,
    lease_token: execution.lease_token,
    outcome: 'failed',
    actual_cost_micros: 0,
    execution_evidence_hash: sha256Ref({ cleanup_preflight_execution: true }),
    result_hash: sha256Ref({ cleanup_preflight_result: true }),
  });
  const cleanup = await fixture.controlPlane.claimCleanup(fixture.principal, {
    invocation_ref: admitted.invocation.invocation_ref,
    lease_token: fixture.nextLeaseToken(),
    worker_id: 'cleanup_preflight',
    lease_ms: 5_000,
  });
  const evidence = cleanup.invocation.cleanup_requests.map((request, index) => (
    createCleanupVerificationEvidence(request, {
      status: 'verified',
      observed_at: '2026-09-05T12:00:00.000Z',
      evidence_ref: `cleanup_preflight_evidence_${index}`,
      observation_hash: sha256Ref({ cleanup_preflight: index }),
    })
  ));
  await assert.rejects(
    fixture.controlPlane.completeCleanup(fixture.principal, {
      invocation_ref: admitted.invocation.invocation_ref,
      lease_token: 'wrong_cleanup_token_000000000000000000000',
      cleanup_evidence: evidence,
    }),
    (error) => error.code === 'LEASE_TOKEN_INVALID',
  );
  assert.equal(cleanupVerifierCalls, 0);
  fixture.setNow('2026-09-05T12:00:06.000Z');
  await assert.rejects(
    fixture.controlPlane.completeCleanup(fixture.principal, {
      invocation_ref: admitted.invocation.invocation_ref,
      lease_token: cleanup.lease_token,
      cleanup_evidence: evidence,
    }),
    (error) => error.code === 'LEASE_EXPIRED',
  );
  assert.equal(cleanupVerifierCalls, 0);
});

test('wrong or expired recovery leases trigger zero recovery verifier calls', async () => {
  let recoveryVerifierCalls = 0;
  const fixture = await createFixture({
    verifyRecoveryAbsence: async () => {
      recoveryVerifierCalls += 1;
      return true;
    },
  });
  const admitted = await fixture.controlPlane.admitInvocation(fixture.principal, invocationRequest());
  await fixture.controlPlane.claimExecution(fixture.principal, {
    invocation_ref: admitted.invocation.invocation_ref,
    lease_token: fixture.nextLeaseToken(),
    worker_id: 'worker_preflight_recovery',
    lease_ms: 5_000,
  });
  fixture.setNow('2026-09-05T12:00:06.000Z');
  await fixture.controlPlane.sweepExpiredLeases();
  const recovery = await fixture.controlPlane.claimRecovery(fixture.principal, {
    invocation_ref: admitted.invocation.invocation_ref,
    lease_token: fixture.nextLeaseToken(),
    worker_id: 'recovery_preflight',
    lease_ms: 5_000,
  });
  const evidence = {
    schema: 'agoragentic.risk-fork.recovery-absence-evidence.v1',
    provider_recovery_key: admitted.invocation.provider_recovery_key,
    observed_at: '2026-09-05T12:00:06.000Z',
    evidence_ref: 'recovery_preflight_evidence',
    observation_hash: sha256Ref({ recovery_preflight: true }),
  };
  await assert.rejects(
    fixture.controlPlane.completeRecoveryAbsence(fixture.principal, {
      invocation_ref: admitted.invocation.invocation_ref,
      lease_token: 'wrong_recovery_token_00000000000000000000',
      recovery_evidence: evidence,
    }),
    (error) => error.code === 'LEASE_TOKEN_INVALID',
  );
  assert.equal(recoveryVerifierCalls, 0);
  fixture.setNow('2026-09-05T12:00:12.000Z');
  await assert.rejects(
    fixture.controlPlane.completeRecoveryAbsence(fixture.principal, {
      invocation_ref: admitted.invocation.invocation_ref,
      lease_token: recovery.lease_token,
      recovery_evidence: evidence,
    }),
    (error) => error.code === 'LEASE_EXPIRED',
  );
  assert.equal(recoveryVerifierCalls, 0);
});

test('cleanup evidence is rechecked for freshness after provider verification', async () => {
  let fixture;
  let verifierCalls = 0;
  fixture = await createFixture({
    maxInvocationAgeMs: 10_000,
    verifyResourceBinding: async () => true,
    verifyCleanupEvidence: async () => {
      verifierCalls += 1;
      fixture.setNow('2026-09-05T12:00:11.000Z');
      return true;
    },
  });
  const admitted = await fixture.controlPlane.admitInvocation(fixture.principal, invocationRequest());
  const execution = await fixture.controlPlane.claimExecution(fixture.principal, {
    invocation_ref: admitted.invocation.invocation_ref,
    lease_token: fixture.nextLeaseToken(),
    worker_id: 'worker_slow_cleanup',
    lease_ms: 30_000,
  });
  await fixture.controlPlane.recordResources(fixture.principal, {
    invocation_ref: admitted.invocation.invocation_ref,
    lease_token: execution.lease_token,
    savepoint_ref: 'savepoint_slow_cleanup',
    fork_ref: 'fork_slow_cleanup',
  });
  await fixture.controlPlane.recordExecutionOutcome(fixture.principal, {
    invocation_ref: admitted.invocation.invocation_ref,
    lease_token: execution.lease_token,
    outcome: 'succeeded',
    actual_cost_micros: 0,
    execution_evidence_hash: sha256Ref({ slow_cleanup_execution: true }),
    result_hash: sha256Ref({ slow_cleanup_result: true }),
  });
  const cleanup = await fixture.controlPlane.claimCleanup(fixture.principal, {
    invocation_ref: admitted.invocation.invocation_ref,
    lease_token: fixture.nextLeaseToken(),
    worker_id: 'cleanup_slow',
    lease_ms: 30_000,
  });
  const evidence = cleanup.invocation.cleanup_requests.map((request, index) => (
    createCleanupVerificationEvidence(request, {
      status: 'verified',
      observed_at: '2026-09-05T12:00:00.000Z',
      evidence_ref: `cleanup_slow_evidence_${index}`,
      observation_hash: sha256Ref({ cleanup_slow: index }),
    })
  ));
  await assert.rejects(
    fixture.controlPlane.completeCleanup(fixture.principal, {
      invocation_ref: admitted.invocation.invocation_ref,
      lease_token: cleanup.lease_token,
      cleanup_evidence: evidence,
    }),
    /stale/i,
  );
  assert.equal(verifierCalls, 2);
  assert.equal((await fixture.controlPlane.getInvocation(
    fixture.principal,
    admitted.invocation.invocation_ref,
  )).state, 'cleanup_pending');
});

test('caller mutation cannot refresh cleanup evidence after provider attestation', async () => {
  let fixture;
  let submittedEvidence;
  let cleanupRequests;
  let verifierCalls = 0;
  fixture = await createFixture({
    maxInvocationAgeMs: 10_000,
    verifyResourceBinding: async () => true,
    verifyCleanupEvidence: async () => {
      verifierCalls += 1;
      if (verifierCalls === 2) {
        for (let index = 0; index < submittedEvidence.length; index += 1) {
          const refreshed = createCleanupVerificationEvidence(
            cleanupRequests[index],
            {
              status: 'verified',
              observed_at: '2026-09-05T12:00:11.000Z',
              evidence_ref: `cleanup_mutated_evidence_${index}`,
              observation_hash: sha256Ref({ cleanup_mutated: index }),
            },
          );
          Object.assign(submittedEvidence[index], JSON.parse(JSON.stringify(refreshed)));
        }
        fixture.setNow('2026-09-05T12:00:11.000Z');
      }
      return true;
    },
  });
  const admitted = await fixture.controlPlane.admitInvocation(fixture.principal, invocationRequest());
  const execution = await fixture.controlPlane.claimExecution(fixture.principal, {
    invocation_ref: admitted.invocation.invocation_ref,
    lease_token: fixture.nextLeaseToken(),
    worker_id: 'worker_mutated_cleanup',
    lease_ms: 30_000,
  });
  await fixture.controlPlane.recordResources(fixture.principal, {
    invocation_ref: admitted.invocation.invocation_ref,
    lease_token: execution.lease_token,
    savepoint_ref: 'savepoint_mutated_cleanup',
    fork_ref: 'fork_mutated_cleanup',
  });
  await fixture.controlPlane.recordExecutionOutcome(fixture.principal, {
    invocation_ref: admitted.invocation.invocation_ref,
    lease_token: execution.lease_token,
    outcome: 'succeeded',
    actual_cost_micros: 0,
    execution_evidence_hash: sha256Ref({ mutated_cleanup_execution: true }),
    result_hash: sha256Ref({ mutated_cleanup_result: true }),
  });
  const cleanup = await fixture.controlPlane.claimCleanup(fixture.principal, {
    invocation_ref: admitted.invocation.invocation_ref,
    lease_token: fixture.nextLeaseToken(),
    worker_id: 'cleanup_mutation_attempt',
    lease_ms: 30_000,
  });
  cleanupRequests = cleanup.invocation.cleanup_requests;
  submittedEvidence = cleanupRequests.map((request, index) => (
    JSON.parse(JSON.stringify(createCleanupVerificationEvidence(request, {
      status: 'verified',
      observed_at: '2026-09-05T12:00:00.000Z',
      evidence_ref: `cleanup_original_evidence_${index}`,
      observation_hash: sha256Ref({ cleanup_original: index }),
    })))
  ));
  await assert.rejects(
    fixture.controlPlane.completeCleanup(fixture.principal, {
      invocation_ref: admitted.invocation.invocation_ref,
      lease_token: cleanup.lease_token,
      cleanup_evidence: submittedEvidence,
    }),
    /stale/i,
  );
  assert.equal(verifierCalls, 2);
  assert.equal((await fixture.controlPlane.getInvocation(
    fixture.principal,
    admitted.invocation.invocation_ref,
  )).state, 'cleanup_pending');
});

test('recovery absence evidence is rechecked for freshness after provider verification', async () => {
  let fixture;
  let verifierCalls = 0;
  fixture = await createFixture({
    maxInvocationAgeMs: 10_000,
    verifyRecoveryAbsence: async () => {
      verifierCalls += 1;
      fixture.setNow('2026-09-05T12:00:17.000Z');
      return true;
    },
  });
  const admitted = await fixture.controlPlane.admitInvocation(fixture.principal, invocationRequest());
  await fixture.controlPlane.claimExecution(fixture.principal, {
    invocation_ref: admitted.invocation.invocation_ref,
    lease_token: fixture.nextLeaseToken(),
    worker_id: 'worker_slow_recovery',
    lease_ms: 5_000,
  });
  fixture.setNow('2026-09-05T12:00:06.000Z');
  await fixture.controlPlane.sweepExpiredLeases();
  const recovery = await fixture.controlPlane.claimRecovery(fixture.principal, {
    invocation_ref: admitted.invocation.invocation_ref,
    lease_token: fixture.nextLeaseToken(),
    worker_id: 'recovery_slow',
    lease_ms: 30_000,
  });
  const evidence = {
    schema: 'agoragentic.risk-fork.recovery-absence-evidence.v1',
    provider_recovery_key: admitted.invocation.provider_recovery_key,
    observed_at: '2026-09-05T12:00:06.000Z',
    evidence_ref: 'recovery_slow_evidence',
    observation_hash: sha256Ref({ recovery_slow: true }),
  };
  await assert.rejects(
    fixture.controlPlane.completeRecoveryAbsence(fixture.principal, {
      invocation_ref: admitted.invocation.invocation_ref,
      lease_token: recovery.lease_token,
      recovery_evidence: evidence,
    }),
    (error) => error.code === 'RECOVERY_EVIDENCE_STALE',
  );
  assert.equal(verifierCalls, 1);
  assert.equal((await fixture.controlPlane.getInvocation(
    fixture.principal,
    admitted.invocation.invocation_ref,
  )).state, 'recovery_required');
});
