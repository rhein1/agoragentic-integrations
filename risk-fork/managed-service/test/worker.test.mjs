import assert from 'node:assert/strict';
import test from 'node:test';
import { createManagedRiskForkWorker } from '../src/worker.mjs';
import { createManagedWorkerDeliveryJournal } from '../src/worker-delivery.mjs';
import { createCleanupVerificationEvidence } from '../../src/provider.mjs';
import { sha256Ref } from '../../src/canonical.mjs';
import { makeCapsule, closedResultSchema } from '../../test/helpers.mjs';
import { createFixture, invocationRequest, TestProvider } from './helpers.mjs';

const NOW = '2026-09-05T12:00:00.000Z';
class WorkerTestProvider extends TestProvider {
  constructor() { super(); this.created = []; this.destroyed = new Set(); this.destroyCalls = []; this.observedAt = NOW; }
  async createSavepoint() { this.created.push('savepoint'); return { savepoint_ref: 'savepoint:test', savepoint_hash: sha256Ref('savepoint') }; }
  async createFork() { this.created.push('fork'); return { fork_ref: 'fork:test', fork_hash: sha256Ref('fork') }; }
  async getForkStatus() { return { status: 'ready' }; }
  async executeInFork() { return { status: 'completed', taint_status: 'TAINTED', authority_granted: false,
    result_hash: sha256Ref('result'), commit_candidate: {
      type: 'TYPED_RESULT', payload: { answer: 'bounded' }, payload_schema: closedResultSchema(),
    } }; }
  async destroyFork(input) { this.destroyCalls.push('fork'); this.destroyed.add(input.fork_ref); }
  async destroySavepoint(input) { this.destroyCalls.push('savepoint'); this.destroyed.add(input.savepoint_ref); }
  async verifyDestroyed(input) { return this.verify(input); }
  async verifySavepointDestroyed(input) { return this.verify(input); }
  verify(input) { return createCleanupVerificationEvidence(input.cleanup_request, {
    status: this.destroyed.has(input.fork_ref ?? input.savepoint_ref) ? 'verified' : 'failed',
    outcome: this.destroyed.has(input.fork_ref ?? input.savepoint_ref) ? 'success' : 'failure',
    observed_at: this.observedAt, evidence_ref: 'fixture:absence', observation_hash: sha256Ref(input),
  }); }
}

async function fixture(overrides = {}) {
  const provider = new WorkerTestProvider();
  const current = await createFixture({ provider, verifyResourceBinding: () => true,
    verifyCleanupEvidence: () => true, ...overrides.fixture });
  const { invocation: admitted } = await current.controlPlane.admitInvocation(current.principal, invocationRequest({
    operation: { kind: 'mcp_tool_call', tool_name: 'example_tool', arguments: { value: 1 } },
  }));
  const capsule = makeCapsule({ created_at: NOW, expires_at: '2026-09-05T12:10:00.000Z',
    allowed_commit_types: ['TYPED_RESULT'] });
  const methods = [];
  const options = {
    controlPlane: current.controlPlane, providerRegistry: current.providerRegistry,
    executionPrincipal: current.principal, cleanupPrincipal: current.sameTenantPrincipal,
    recoveryPrincipal: current.sameTenantPrincipal, workerId: 'worker:test', leaseMs: 10_000,
    clock: () => new Date(provider.observedAt),
    loadPrepareInput: (invocation) => ({
      risk_input: { mcp_phase: 'tools/call', mcp_server_ref: capsule.proposed_interaction.mcp_server_ref,
        mcp_server_origin: capsule.proposed_interaction.mcp_server_origin, mcp_server_trust: 'reachable',
        tool_name: 'example_tool', capabilities: { filesystem_write: true } },
      capsule, savepoint_input: {}, operation: invocation.operation, effective_arguments: { value: 1 },
      expected_commit_type: 'TYPED_RESULT', commit_policy: { typed_result_schema_hash: capsule.authorized_result_schema_hash },
      network_policy: { mode: 'blocked' }, max_execution_ms: 1_000,
    }),
    invokeProvider: async ({ provider: bound, method, input, context }) => {
      methods.push(method);
      assert.equal(context.provider_recovery_key, admitted.provider_recovery_key);
      assert.equal(Object.hasOwn(context, 'lease_token'), false);
      assert.equal(Object.hasOwn(context, 'principal'), false);
      assert.ok(Date.parse(context.lease_expires_at) > Date.parse(NOW));
      const state = await current.controlPlane.getInvocation(current.principal, admitted.invocation_ref);
      if (method === 'createFork') assert.equal(state.savepoint_ref, 'savepoint:test');
      if (method === 'executeInFork') assert.equal(state.state, 'running');
      return bound[method](input);
    },
    lookupResources: () => ({ savepoint_ref: 'savepoint:test', fork_ref: null, absent_resource_kinds: ['fork'] }),
    measureCostMicros: () => 0,
    ...overrides.worker,
  };
  return { ...current, admitted, methods, options, worker: createManagedRiskForkWorker(options),
    setNow(value) { current.setNow(value); provider.observedAt = value; } };
}

test('worker journals before execution and returns original prepared authority only after managed cleanup', async () => {
  const current = await fixture();
  const a = current.worker.execute(current.admitted.invocation_ref);
  const b = current.worker.execute(current.admitted.invocation_ref);
  assert.equal(a, b, 'one invocation must converge on one logical attempt');
  const result = await a;
  assert.equal(result.invocation.state, 'completed');
  assert.equal(result.production_qualified, false);
  assert.deepEqual(current.provider.created, ['savepoint', 'fork']);
  assert.equal(current.methods.filter((method) => method === 'executeInFork').length, 1);
  assert.equal(result.prepared.mode, 'prepared_for_clean_commit');
  assert.equal(result.prepared.authority_granted, false);
  await assert.rejects(result.controller.commit(JSON.parse(JSON.stringify(result.prepared))),
    (error) => error.code === 'RISK_FORK_PREPARED_PROVENANCE_INVALID');
  assert.equal(current.provider.destroyed.size, 2);
  assert.deepEqual(current.provider.destroyCalls, ['fork', 'savepoint'], 'managed settlement must not destroy twice');
  await current.controlPlane.listAuditEvents(current.principal, current.admitted.invocation_ref);
  current.worker.close();
  assert.throws(() => current.worker.execute(current.admitted.invocation_ref), /closed/);
});

test('unknown journal acknowledgement never repeats creation; restart recovers partial resources without executing', async () => {
  const current = await fixture();
  const lost = Object.freeze({ ...current.controlPlane,
    async recordResources(principal, input) {
      await current.controlPlane.recordResources(principal, input);
      throw new Error('acknowledgement lost after commit');
    },
  });
  const worker = createManagedRiskForkWorker({ ...current.options, controlPlane: lost });
  const attempt = worker.execute(current.admitted.invocation_ref);
  await assert.rejects(attempt, (error) => error.code === 'WORKER_PREPARATION_FAILED');
  assert.equal(worker.execute(current.admitted.invocation_ref), attempt);
  assert.deepEqual(current.provider.created, ['savepoint']);
  assert.equal(current.methods.includes('createFork'), false);
  current.setNow('2026-09-05T12:00:11.000Z');
  await current.controlPlane.sweepExpiredLeases();
  const recovered = await current.worker.recover(current.admitted.invocation_ref);
  assert.equal(recovered.state, 'failed_closed');
  assert.equal(current.methods.includes('executeInFork'), false);
  assert.deepEqual(current.provider.created, ['savepoint']);
});

test('worker rejects changed admitted bytes before provider creation', async () => {
  const current = await fixture({ worker: { loadPrepareInput: () => ({ operation: { kind: 'prepare-typed-result' } }) } });
  await assert.rejects(current.worker.execute(current.admitted.invocation_ref),
    (error) => error.code === 'WORKER_OPERATION_MISMATCH');
  assert.equal(current.methods.length, 0);
});

test('worker rechecks expiry after a provider response and never continues the original effect', async () => {
  const current = await fixture();
  const worker = createManagedRiskForkWorker({ ...current.options,
    invokeProvider: async ({ provider, method, input }) => {
      const result = await provider[method](input);
      if (method === 'createSavepoint') current.setNow('2026-09-05T12:00:11.000Z');
      return result;
    },
  });
  await assert.rejects(worker.execute(current.admitted.invocation_ref),
    (error) => error.code === 'WORKER_PREPARATION_FAILED');
  assert.deepEqual(current.provider.created, ['savepoint']);
  const state = await current.controlPlane.getInvocation(current.principal, current.admitted.invocation_ref);
  assert.equal(state.savepoint_ref, null, 'unknown creation must be reconciled through provider recovery');
});

test('worker shutdown aborts the broker signal and rejects a delayed creation response', async () => {
  const current = await fixture();
  let started;
  let release;
  const ready = new Promise((resolve) => { started = resolve; });
  const delay = new Promise((resolve) => { release = resolve; });
  let signal;
  const worker = createManagedRiskForkWorker({ ...current.options,
    invokeProvider: async ({ provider, method, input, signal: brokerSignal }) => {
      signal = brokerSignal; started(); await delay; return provider[method](input);
    },
  });
  const attempt = worker.execute(current.admitted.invocation_ref);
  const rejected = assert.rejects(attempt, (error) => error.code === 'WORKER_PREPARATION_FAILED');
  await ready;
  worker.close(); assert.equal(signal.aborted, true); release();
  await rejected;
  assert.deepEqual(current.provider.created, ['savepoint']);
  assert.equal(current.provider.destroyCalls.length, 0, 'unknown late creation is recovery-owned');
});

test('shutdown during lease renewal cannot dispatch a new provider operation', { timeout: 5000 }, async () => {
  const current = await fixture();
  let entered;
  let release;
  const ready = new Promise((resolve) => { entered = resolve; });
  const delay = new Promise((resolve) => { release = resolve; });
  let renewals = 0;
  const control = { ...current.controlPlane, async renewLease(...args) {
    const result = await current.controlPlane.renewLease(...args);
    // The first renewal constructs the controller; the second is the actual
    // createSavepoint dispatch fence. Hold that database response across close.
    if (++renewals === 2) { entered(); await delay; }
    return result;
  } };
  const worker = createManagedRiskForkWorker({ ...current.options, controlPlane: control });
  const attempt = worker.execute(current.admitted.invocation_ref);
  const rejected = assert.rejects(attempt, { code: 'WORKER_PREPARATION_FAILED' });
  try {
    await ready;
    worker.close();
    release();
    await rejected;
    assert.deepEqual(current.methods, [], 'closed worker must not enter the broker callback');
    assert.deepEqual(current.provider.created, [], 'no allocation after shutdown');
    const state = await current.controlPlane.getInvocation(current.principal, current.admitted.invocation_ref);
    assert.notEqual(state.state, 'completed');
    assert.equal(state.savepoint_ref, null);
    assert.equal(state.fork_ref, null);
    assert.throws(() => worker.execute(current.admitted.invocation_ref), { code: 'WORKER_CLOSED' });
  } finally { release(); worker.close(); current.worker.close(); }
});

test('shutdown during recovery lease renewal never starts resource lookup', { timeout: 5000 }, async () => {
  const current = await fixture({ worker: {
    invokeProvider: () => { throw new Error('synthetic unknown creation'); },
  } });
  await assert.rejects(current.worker.execute(current.admitted.invocation_ref));
  current.setNow('2026-09-05T12:00:11.000Z');
  await current.controlPlane.sweepExpiredLeases();
  let entered;
  let release;
  const ready = new Promise((resolve) => { entered = resolve; });
  const delay = new Promise((resolve) => { release = resolve; });
  const control = { ...current.controlPlane, async renewLease(...args) {
    const result = await current.controlPlane.renewLease(...args);
    entered(); await delay; return result;
  } };
  let lookups = 0;
  const worker = createManagedRiskForkWorker({ ...current.options, controlPlane: control,
    lookupResources: () => { lookups += 1; return {}; },
  });
  const rejected = assert.rejects(worker.recover(current.admitted.invocation_ref), { code: 'WORKER_FENCE_FAILED' });
  try {
    await ready;
    worker.close(); release();
    await rejected;
    assert.equal(lookups, 0, 'closed worker must not start observational provider I/O');
    assert.deepEqual(current.provider.created, []);
    const state = await current.controlPlane.getInvocation(current.principal, current.admitted.invocation_ref);
    assert.notEqual(state.state, 'completed', 'shutdown does not prove absence or settle recovery');
  } finally { release(); worker.close(); current.worker.close(); }
});

test('shutdown between a successful fence and dispatch never enters the broker', async () => {
  const current = await fixture();
  let worker;
  let bindings = 0;
  const registry = { ...current.providerRegistry, requireBound(...args) {
    const provider = current.providerRegistry.requireBound(...args);
    if (++bindings === 2) queueMicrotask(() => worker.close());
    return provider;
  } };
  worker = createManagedRiskForkWorker({ ...current.options, providerRegistry: registry });
  try {
    await assert.rejects(worker.execute(current.admitted.invocation_ref), { code: 'WORKER_PREPARATION_FAILED' });
    assert.equal(bindings, 2, 'shutdown is queued by the successful dispatch fence');
    assert.deepEqual(current.methods, [], 'no callback after the awaited fence continuation closes');
    assert.deepEqual(current.provider.created, []);
  } finally { worker.close(); current.worker.close(); }
});

test('worker rechecks current scopes after host cost measurement', async () => {
  const current = await fixture();
  const resolve = current.store.resolveCredential.bind(current.store);
  let withdrawn = false;
  current.store.resolveCredential = async (keyHash) => {
    const credential = await resolve(keyHash);
    return withdrawn && credential?.key_id === 'key_alpha'
      ? { ...credential, scopes: credential.scopes.filter((scope) => scope !== 'worker:execution:write') }
      : credential;
  };
  const worker = createManagedRiskForkWorker({ ...current.options,
    measureCostMicros: async () => {
      withdrawn = true;
      return 0;
    },
  });
  await assert.rejects(worker.execute(current.admitted.invocation_ref),
    (error) => error.code === 'WORKER_FENCE_FAILED');
  const state = await current.controlPlane.getInvocation(current.sameTenantPrincipal, current.admitted.invocation_ref);
  assert.notEqual(state.state, 'completed');
  assert.equal(state.result_hash, null);
});

test('worker closes total attested absence without creating or re-executing anything', async () => {
  const current = await fixture({ fixture: { verifyRecoveryAbsence: () => true }, worker: {
    lookupResources: ({ invocation }) => ({ savepoint_ref: null, fork_ref: null,
      absent_resource_kinds: ['savepoint', 'fork'], absence_evidence: {
        schema: 'agoragentic.risk-fork.recovery-absence-evidence.v1',
        provider_recovery_key: invocation.provider_recovery_key,
        observed_at: '2026-09-05T12:00:11.000Z', evidence_ref: 'fixture:total-absence',
        observation_hash: sha256Ref('both absent'),
      } }),
  } });
  const worker = createManagedRiskForkWorker({ ...current.options,
    invokeProvider: () => { throw new Error('unknown create delivery, no fixture resource'); },
  });
  await assert.rejects(worker.execute(current.admitted.invocation_ref));
  current.setNow('2026-09-05T12:00:11.000Z');
  await current.controlPlane.sweepExpiredLeases();
  const terminal = await current.worker.recover(current.admitted.invocation_ref);
  assert.equal(terminal.state, 'failed_closed');
  assert.equal(current.provider.created.length, 0);
  assert.equal(current.methods.length, 0);
});

test('worker recovers both found resources after an ambiguous fork journal without executing', async () => {
  const current = await fixture({ worker: { lookupResources: () => ({
    savepoint_ref: 'savepoint:test', fork_ref: 'fork:test', absent_resource_kinds: [],
  }) } });
  const control = Object.freeze({ ...current.controlPlane,
    recordResources(principal, input) {
      if (input.fork_ref) throw new Error('unknown delivery before fixture journal');
      return current.controlPlane.recordResources(principal, input);
    },
  });
  const worker = createManagedRiskForkWorker({ ...current.options, controlPlane: control });
  await assert.rejects(worker.execute(current.admitted.invocation_ref));
  assert.deepEqual(current.provider.created, ['savepoint', 'fork']);
  current.setNow('2026-09-05T12:00:11.000Z');
  await current.controlPlane.sweepExpiredLeases();
  const terminal = await current.worker.recover(current.admitted.invocation_ref);
  assert.equal(terminal.state, 'failed_closed');
  assert.equal(current.methods.includes('executeInFork'), false);
  assert.deepEqual(current.provider.destroyCalls, ['fork', 'savepoint']);
});

test('worker never returns prepared authority when managed cleanup attestation fails', async () => {
  const current = await fixture({ fixture: { verifyCleanupEvidence: () => false } });
  const attempt = current.worker.execute(current.admitted.invocation_ref);
  await assert.rejects(attempt);
  assert.equal(current.worker.execute(current.admitted.invocation_ref), attempt);
  const state = await current.controlPlane.getInvocation(current.principal, current.admitted.invocation_ref);
  assert.equal(state.state, 'cleanup_pending');
  assert.deepEqual(current.provider.destroyCalls, ['fork', 'savepoint']);
});

test('worker delivery journal persists ciphertext and restart replays no original operation', async () => {
  const current = await fixture();
  const records = new Map();
  const store = {
    async insert(record, max) {
      if (records.has(record.attempt_ref)) return false;
      assert.ok(records.size < max);
      records.set(record.attempt_ref, { record, acknowledged: false }); return true;
    },
    async get(_namespace, ref) { return records.get(ref); },
    async acknowledge(_namespace, ref, hash) {
      Object.assign(records.get(ref), { acknowledged: true, response_hash: hash }); return true;
    },
    async listPending(_namespace, limit) {
      return [...records].filter(([, row]) => !row.acknowledged).slice(0, limit).map(([ref]) => ref);
    },
  };
  const options = { store, encryptionKey: Buffer.alloc(32, 91), keyId: 'fixture:encryption',
    namespace: 'fixture:deliveries', workerId: current.options.workerId, controlPlane: current.controlPlane,
    executionPrincipal: current.principal, cleanupPrincipal: current.sameTenantPrincipal,
    recoveryPrincipal: current.sameTenantPrincipal };
  const journal = createManagedWorkerDeliveryJournal(options);
  const worker = createManagedRiskForkWorker({ ...current.options, deliveryJournal: journal });
  const result = await worker.execute(current.admitted.invocation_ref);
  assert.equal(result.invocation.state, 'completed');
  assert.equal(records.size, 4, 'two claims and two resource packets');
  assert.deepEqual(await journal.listPending(), []);
  assert.doesNotMatch(JSON.stringify([...records.values()]), /lease_token|lease_fixture|rf_local_fixture/);
  const before = await current.controlPlane.listAuditEvents(current.principal, current.admitted.invocation_ref);
  const methods = [...current.methods];
  journal.close(); worker.close();
  const restarted = createManagedWorkerDeliveryJournal(options);
  for (const ref of records.keys()) {
    const recovered = await restarted.resumeDelivery(ref);
    assert.equal(recovered.original_operation_resumed, false);
  }
  assert.deepEqual(current.methods, methods);
  assert.deepEqual(await current.controlPlane.listAuditEvents(current.principal, current.admitted.invocation_ref), before);
  restarted.close();
});
