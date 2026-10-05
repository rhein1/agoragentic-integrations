import assert from 'node:assert/strict';
import test from 'node:test';
import { createManagedRiskForkWorker } from '../src/worker.mjs';
import { createManagedWorkerDeliveryJournal } from '../src/worker-delivery.mjs';
import { createManagedRequestPolicy } from '../src/request-policy.mjs';
import { createManagedRiskForkLocalHost } from '../host/local-host.mjs';
import { createCleanupVerificationEvidence } from '../../src/provider.mjs';
import { sha256Ref } from '../../src/canonical.mjs';
import { makeCapsule, closedResultSchema } from '../../test/helpers.mjs';
import { createFixture, invocationRequest, TestProvider } from './helpers.mjs';

const NOW = '2026-09-05T12:00:00.000Z';
class WorkerTestProvider extends TestProvider {
  constructor() { super(); this.created = []; this.destroyed = new Set(); this.destroyCalls = []; this.observedAt = NOW; this.savepointContext = null; }
  async createSavepoint(_input, context) { this.savepointContext = context; this.created.push('savepoint'); return { savepoint_ref: 'savepoint:test', savepoint_hash: sha256Ref('savepoint') }; }
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
    recoveryPrincipal: current.recoveryPrincipal, workerId: 'worker:test', leaseMs: 10_000,
    clock: () => new Date(provider.observedAt),
    loadPrepareInput: (invocation) => ({
      risk_input: { mcp_phase: 'tools/call', mcp_server_ref: capsule.proposed_interaction.mcp_server_ref,
        mcp_server_origin: capsule.proposed_interaction.mcp_server_origin, mcp_server_trust: 'reachable',
        tool_name: 'example_tool', capabilities: { filesystem_write: true } },
      capsule, savepoint_input: {}, operation: invocation.operation, effective_arguments: { value: 1 },
      expected_commit_type: 'TYPED_RESULT', commit_policy: { typed_result_schema_hash: capsule.authorized_result_schema_hash },
      network_policy: { mode: 'blocked' }, max_execution_ms: 1_000,
    }),
    invokeProvider: async ({ provider: bound, method, input, context, effectFence }) => {
      methods.push(method);
      assert.equal(context.provider_recovery_key, admitted.provider_recovery_key);
      assert.equal(Object.hasOwn(context, 'lease_token'), false);
      assert.equal(Object.hasOwn(context, 'principal'), false);
      assert.ok(Date.parse(context.lease_expires_at) > Date.parse(NOW));
      const state = await current.controlPlane.getInvocation(current.principal, admitted.invocation_ref);
      if (method === 'createFork') assert.equal(state.savepoint_ref, 'savepoint:test');
      if (method === 'executeInFork') assert.equal(state.state, 'running');
      const freshContext = effectFence ? await effectFence() : context;
      return bound[method](input, freshContext);
    },
    lookupResources: () => ({ savepoint_ref: 'savepoint:test', fork_ref: null, absent_resource_kinds: ['fork'] }),
    measureCostMicros: () => 0,
    ...overrides.worker,
  };
  return { ...current, admitted, methods, options, worker: createManagedRiskForkWorker(options),
    setNow(value) { current.setNow(value); provider.observedAt = value; } };
}

function policyHost(current, requestPolicy, workerOverrides = {}) {
  const rows = new Map();
  const store = {
    async insert(record) {
      if (rows.has(record.attempt_ref)) return false;
      rows.set(record.attempt_ref, { record, acknowledged: false }); return true;
    },
    async get(_namespace, ref) { return rows.get(ref); },
    async acknowledge(_namespace, ref, hash) {
      Object.assign(rows.get(ref), { acknowledged: true, response_hash: hash }); return true;
    },
    async listPending(_namespace, limit) {
      return [...rows].filter(([, row]) => !row.acknowledged).slice(0, limit).map(([ref]) => ref);
    },
  };
  const { leaseMs, clock, loadPrepareInput, invokeProvider, lookupResources, measureCostMicros } = current.options;
  return createManagedRiskForkLocalHost({
    enabled: true, controlPlane: current.controlPlane, publicAuthenticator: current.authenticator,
    workerAuthenticator: current.authenticator, providerRegistry: current.providerRegistry,
    executionPrincipal: current.principal, cleanupPrincipal: current.sameTenantPrincipal,
    recoveryPrincipal: current.recoveryPrincipal, workerId: 'worker:policy',
    deliveryStore: store, deliveryEncryptionKey: Buffer.alloc(32, 71),
    deliveryKeyId: 'key:policy', deliveryNamespace: 'namespace:policy', requestPolicy,
    deadlineMs: 1000,
    workerOptions: { leaseMs, clock, loadPrepareInput, invokeProvider, lookupResources, measureCostMicros,
      ...workerOverrides },
  });
}

test('host policy disable after preparation wait prevents allocation without charging quota again', { timeout: 5000 }, async () => {
  const current = await fixture();
  let enabled = true; let epoch = 1; let rateCalls = 0; let entered; let release;
  const ready = new Promise((resolve) => { entered = resolve; });
  const wait = new Promise((resolve) => { release = resolve; });
  const policy = createManagedRequestPolicy({
    readControl: async () => ({ enabled, epoch }),
    consumeRateLimit: async () => { rateCalls += 1; return { allowed: true, retry_after_seconds: 0 }; },
    emitTelemetry: async () => {},
  });
  const host = policyHost(current, policy, {
    loadPrepareInput: async (invocation) => { entered(); await wait; return current.options.loadPrepareInput(invocation); },
  });
  await host.start();
  try {
    const rejected = assert.rejects(host.execute(current.admitted.invocation_ref), { code: 'WORKER_PREPARATION_FAILED' });
    await ready; enabled = false; epoch += 1; release(); await rejected;
    assert.deepEqual(current.provider.created, []);
    assert.deepEqual(current.methods, [], 'stale work must not enter the provider broker');
    assert.equal(rateCalls, 1, 'dispatch checks do not consume execution quota');
    const state = await current.controlPlane.getInvocation(current.principal, current.admitted.invocation_ref);
    assert.equal(state.savepoint_ref, null); assert.equal(state.fork_ref, null);
    assert.notEqual(state.state, 'completed', 'denied dispatch is not proof of resource absence');
  } finally { release(); await host.close(); current.worker.close(); }
});

test('disable/re-enable during lease renewal cannot revive the admitted policy epoch', { timeout: 5000 }, async () => {
  const current = await fixture(); let epoch = 1; let renewals = 0; let entered; let release;
  const ready = new Promise((resolve) => { entered = resolve; });
  const wait = new Promise((resolve) => { release = resolve; });
  const controlPlane = { ...current.controlPlane, async renewLease(...args) {
    const result = await current.controlPlane.renewLease(...args);
    if (++renewals === 2) { entered(); await wait; }
    return result;
  } };
  const policy = createManagedRequestPolicy({ readControl: async () => ({ enabled: true, epoch }),
    consumeRateLimit: async () => ({ allowed: true, retry_after_seconds: 0 }), emitTelemetry: async () => {} });
  const host = policyHost({ ...current, controlPlane }, policy);
  await host.start();
  try {
    const rejected = assert.rejects(host.execute(current.admitted.invocation_ref), { code: 'WORKER_PREPARATION_FAILED' });
    await ready; epoch += 2; release(); await rejected;
    assert.deepEqual(current.provider.created, []); assert.deepEqual(current.methods, []);
  } finally { release(); await host.close(); current.worker.close(); }
});

for (const disable of [true, false]) {
  test(`broker wait rechecks ${disable ? 'disablement' : 'epoch drift'} immediately before allocation`, { timeout: 5000 }, async () => {
    const current = await fixture(); let enabled = true; let epoch = 1; let entered; let release; let effects = 0;
    const ready = new Promise((resolve) => { entered = resolve; });
    const wait = new Promise((resolve) => { release = resolve; });
    const policy = createManagedRequestPolicy({ readControl: async () => ({ enabled, epoch }),
      consumeRateLimit: async () => ({ allowed: true, retry_after_seconds: 0 }), emitTelemetry: async () => {} });
    const host = policyHost(current, policy, { invokeProvider: async ({ provider, method, input, effectFence }) => {
      entered(); await wait; await effectFence(); effects += 1; return provider[method](input);
    } });
    await host.start();
    try {
      const rejected = assert.rejects(host.execute(current.admitted.invocation_ref), { code: 'WORKER_PREPARATION_FAILED' });
      await ready; enabled = !disable; epoch += 1; release(); await rejected;
      assert.equal(effects, 0); assert.deepEqual(current.provider.created, []);
    } finally { release(); await host.close(); current.worker.close(); }
  });
}

for (const resource of ['savepoint_ref', 'fork_ref']) {
  test(`disable after journaling ${resource} blocks the next effect but preserves controller destruction`, async () => {
    const current = await fixture(); let enabled = true; let epoch = 1;
    const controlPlane = { ...current.controlPlane, async recordResources(...args) {
      const result = await current.controlPlane.recordResources(...args);
      if (args[1][resource]) { enabled = false; epoch += 1; }
      return result;
    } };
    const policy = createManagedRequestPolicy({ readControl: async () => ({ enabled, epoch }),
      consumeRateLimit: async () => ({ allowed: true, retry_after_seconds: 0 }), emitTelemetry: async () => {} });
    const host = policyHost({ ...current, controlPlane }, policy);
    await host.start();
    try {
      await assert.rejects(host.execute(current.admitted.invocation_ref), { code: 'WORKER_PREPARATION_FAILED' });
      assert.deepEqual(current.provider.created, resource === 'savepoint_ref' ? ['savepoint'] : ['savepoint', 'fork']);
      assert.deepEqual(current.provider.destroyCalls, resource === 'savepoint_ref' ? ['savepoint'] : ['fork', 'savepoint']);
      assert.equal(current.methods.includes('executeInFork'), false);
      const state = await current.controlPlane.getInvocation(current.principal, current.admitted.invocation_ref);
      assert.notEqual(state.state, 'completed', 'controller destruction is not managed terminal absence evidence');
    } finally { await host.close(); current.worker.close(); }
  });
}

test('disable after a provider response does not suppress journaling or successful cleanup', async () => {
  const current = await fixture(); let enabled = true; let epoch = 1;
  const policy = createManagedRequestPolicy({ readControl: async () => ({ enabled, epoch }),
    consumeRateLimit: async () => ({ allowed: true, retry_after_seconds: 0 }), emitTelemetry: async () => {} });
  const host = policyHost(current, policy, { invokeProvider: async (packet) => {
    const result = await current.options.invokeProvider(packet);
    if (packet.method === 'executeInFork') { enabled = false; epoch += 1; }
    return result;
  } });
  await host.start();
  try {
    const result = await host.execute(current.admitted.invocation_ref);
    assert.equal(result.invocation.state, 'completed');
    assert.deepEqual(current.provider.destroyCalls, ['fork', 'savepoint']);
    assert.equal(result.prepared.authority_granted, false);
  } finally { await host.close(); current.worker.close(); }
});

test('disable after unknown journal acknowledgement preserves recovery without re-execution', async () => {
  const current = await fixture(); let enabled = true; let epoch = 1; let lost = false;
  const controlPlane = { ...current.controlPlane, async recordResources(...args) {
    const result = await current.controlPlane.recordResources(...args);
    if (!lost && args[1].savepoint_ref) { lost = true; enabled = false; epoch += 1; throw new Error('unknown journal delivery'); }
    return result;
  } };
  const policy = createManagedRequestPolicy({ readControl: async () => ({ enabled, epoch }),
    consumeRateLimit: async () => ({ allowed: true, retry_after_seconds: 0 }), emitTelemetry: async () => {} });
  const host = policyHost({ ...current, controlPlane }, policy);
  await host.start();
  try {
    await assert.rejects(host.execute(current.admitted.invocation_ref), { code: 'WORKER_PREPARATION_FAILED' });
    assert.deepEqual(current.provider.created, ['savepoint']); assert.deepEqual(current.provider.destroyCalls, []);
    current.setNow('2026-09-05T12:00:11.000Z'); await current.controlPlane.sweepExpiredLeases();
    const recovered = await host.recover(current.admitted.invocation_ref);
    assert.equal(recovered.state, 'failed_closed');
    assert.deepEqual(current.provider.destroyCalls, ['savepoint']);
    assert.equal(current.methods.includes('executeInFork'), false);
  } finally { await host.close(); current.worker.close(); }
});

test('policy-enabled broker cannot return an importable result without awaiting its effect fence', async () => {
  const current = await fixture();
  const policy = createManagedRequestPolicy({ readControl: async () => ({ enabled: true, epoch: 1 }),
    consumeRateLimit: async () => ({ allowed: true, retry_after_seconds: 0 }), emitTelemetry: async () => {} });
  const host = policyHost(current, policy, { invokeProvider: ({ provider, method, input }) => provider[method](input) });
  await host.start();
  try {
    await assert.rejects(host.execute(current.admitted.invocation_ref), { code: 'WORKER_PREPARATION_FAILED' });
    assert.deepEqual(current.provider.created, ['savepoint']);
    const state = await current.controlPlane.getInvocation(current.principal, current.admitted.invocation_ref);
    assert.equal(state.savepoint_ref, null, 'unfenced broker response requires resource recovery, not trusted journaling');
    assert.notEqual(state.state, 'completed');
  } finally { await host.close(); current.worker.close(); }
});

test('broker passes the renewed effect-time context after its queue wait', { timeout: 5000 }, async () => {
  const current = await fixture(); let entered; let release; let originalContext; let freshContext;
  const ready = new Promise((resolve) => { entered = resolve; });
  const wait = new Promise((resolve) => { release = resolve; });
  const policy = createManagedRequestPolicy({ readControl: async () => ({ enabled: true, epoch: 1 }),
    consumeRateLimit: async () => ({ allowed: true, retry_after_seconds: 0 }), emitTelemetry: async () => {} });
  const host = policyHost(current, policy, { invokeProvider: async (packet) => {
    if (packet.method !== 'createSavepoint') return current.options.invokeProvider(packet);
    originalContext = packet.context; entered(); await wait;
    freshContext = await packet.effectFence();
    await assert.rejects(packet.effectFence(), { code: 'WORKER_BROKER_FENCE_INVALID' });
    return packet.provider[packet.method](packet.input, freshContext);
  } });
  await host.start();
  try {
    const pending = host.execute(current.admitted.invocation_ref);
    await ready; current.setNow('2026-09-05T12:00:01.000Z'); release();
    const result = await pending;
    assert.equal(result.invocation.state, 'completed');
    assert.notEqual(freshContext.lease_expires_at, originalContext.lease_expires_at);
    assert.equal(freshContext.invocation_ref, originalContext.invocation_ref);
    assert.equal(freshContext.provider_binding_hash, originalContext.provider_binding_hash);
    assert.equal(freshContext.provider_recovery_key, originalContext.provider_recovery_key);
    assert.equal(current.provider.savepointContext, freshContext);
    assert.ok(Object.isFrozen(freshContext));
    assert.equal('lease_token' in freshContext, false); assert.equal('principal' in freshContext, false);
  } finally { release(); await host.close(); current.worker.close(); }
});

test('a retained broker fence is unusable after the callback returns', async () => {
  const current = await fixture(); let retained;
  const policy = createManagedRequestPolicy({ readControl: async () => ({ enabled: true, epoch: 1 }),
    consumeRateLimit: async () => ({ allowed: true, retry_after_seconds: 0 }), emitTelemetry: async () => {} });
  const host = policyHost(current, policy, { invokeProvider: async ({ effectFence }) => {
    retained = effectFence; return { savepoint_ref: 'unverified', savepoint_hash: sha256Ref('unverified') };
  } });
  await host.start();
  try {
    await assert.rejects(host.execute(current.admitted.invocation_ref), { code: 'WORKER_PREPARATION_FAILED' });
    const before = await current.controlPlane.listAuditEvents(current.principal, current.admitted.invocation_ref);
    await assert.rejects(retained(), { code: 'WORKER_BROKER_FENCE_INVALID' });
    assert.deepEqual(await current.controlPlane.listAuditEvents(current.principal, current.admitted.invocation_ref), before);
    assert.deepEqual(current.provider.created, []);
  } finally { await host.close(); current.worker.close(); }
});

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

async function cleanupPendingFixture() {
  let acceptEvidence = false;
  const current = await fixture({ fixture: { verifyCleanupEvidence: () => acceptEvidence } });
  await assert.rejects(current.worker.execute(current.admitted.invocation_ref));
  assert.equal((await current.controlPlane.getInvocation(current.principal,
    current.admitted.invocation_ref)).state, 'cleanup_pending');
  current.worker.close();
  acceptEvidence = true;
  current.setNow('2026-09-05T12:00:11.000Z');
  await current.controlPlane.sweepExpiredLeases();
  // Controller destruction already happened; managed absence attestation did
  // not. Fresh cleanup must reconcile the same already-absent resources safely.
  current.provider.destroyCalls.length = 0;
  current.methods.length = 0;
  return current;
}

for (const failedMethod of ['destroyFork', 'verifyDestroyed']) {
  for (const deceptiveCode of ['WORKER_FENCE_FAILED', 'WORKER_BROKER_FENCE_INVALID']) {
    test(`cleanup independently attempts the second resource after ${failedMethod} throws ${deceptiveCode}`, async () => {
      const current = await cleanupPendingFixture();
      const calls = [];
      let failure;
      let completionCalls = 0;
      const controlPlane = { ...current.controlPlane, completeCleanup(...args) {
        completionCalls += 1; return current.controlPlane.completeCleanup(...args);
      } };
      const worker = createManagedRiskForkWorker({ ...current.options, controlPlane,
        invokeProvider: async (packet) => {
          calls.push(packet.method);
          if (packet.method === failedMethod) {
            await packet.effectFence();
            throw Object.assign(new Error('synthetic-provider-private-detail'), { code: deceptiveCode });
          }
          return current.options.invokeProvider(packet);
        },
      });
      try {
        await assert.rejects(worker.cleanup(current.admitted.invocation_ref), (error) => {
          failure = error; return true;
        });
        assert.ok(calls.includes('destroySavepoint'), 'independent known resource must still be attempted');
        assert.ok(calls.includes('verifySavepointDestroyed'), 'second resource must obtain fresh absence evidence');
        assert.equal(completionCalls, 0, 'partial cleanup cannot authorize terminal completion');
        assert.equal(failure.code, 'WORKER_CLEANUP_FAILED');
        assert.doesNotMatch(failure.message, /synthetic-provider-private-detail/);
        assert.equal((await current.controlPlane.getInvocation(current.principal,
          current.admitted.invocation_ref)).state, 'cleanup_pending');
        assert.equal(current.methods.includes('executeInFork'), false);
        assert.deepEqual(current.provider.created, ['savepoint', 'fork']);
        assert.equal((await current.controlPlane.listAuditEvents(current.principal,
          current.admitted.invocation_ref)).filter((event) => event.event_type === 'cleanup_verified').length, 0);
        worker.close();
        current.setNow('2026-09-05T12:00:22.000Z');
        await current.controlPlane.sweepExpiredLeases();
        const retryCalls = [];
        const retry = createManagedRiskForkWorker({ ...current.options,
          invokeProvider: async (packet) => { retryCalls.push(packet.method); return current.options.invokeProvider(packet); },
        });
        try {
          const terminal = await retry.cleanup(current.admitted.invocation_ref);
          assert.equal(terminal.state, 'completed');
          assert.deepEqual(retryCalls, ['destroyFork', 'verifyDestroyed', 'destroySavepoint', 'verifySavepointDestroyed']);
          assert.equal((await current.controlPlane.listAuditEvents(current.principal,
            current.admitted.invocation_ref)).filter((event) => event.event_type === 'cleanup_verified').length, 1);
        } finally { retry.close(); }
      } finally { worker.close(); }
    });
  }
}

for (const loss of ['scope', 'expiry', 'binding', 'shutdown', 'takeover']) {
  test(`cleanup stops before the second resource after ${loss} during a failed callback`, async () => {
    const current = await cleanupPendingFixture();
    const calls = [];
    let unavailable = false;
    let revoked = false;
    const resolve = current.store.resolveCredential.bind(current.store);
    current.store.resolveCredential = async (hash) => {
      const credential = await resolve(hash);
      return revoked && credential?.key_id === current.sameTenantPrincipal.key_id
        ? { ...credential, scopes: credential.scopes.filter((scope) => scope !== 'worker:cleanup:write') }
        : credential;
    };
    const registry = { ...current.providerRegistry, requireBound(...args) {
      if (unavailable) throw new Error('synthetic-private-binding-detail');
      return current.providerRegistry.requireBound(...args);
    } };
    let worker;
    worker = createManagedRiskForkWorker({ ...current.options, providerRegistry: registry,
      invokeProvider: async (packet) => {
        calls.push(packet.method);
        await packet.effectFence();
        if (loss === 'scope') revoked = true;
        if (loss === 'expiry') current.setNow('2026-09-05T12:00:22.000Z');
        if (loss === 'binding') unavailable = true;
        if (loss === 'shutdown') worker.close();
        if (loss === 'takeover') {
          current.setNow('2026-09-05T12:00:22.000Z');
          await current.controlPlane.sweepExpiredLeases();
          await current.controlPlane.claimCleanup(current.sameTenantPrincipal, {
            invocation_ref: current.admitted.invocation_ref, worker_id: 'worker:takeover',
            lease_ms: 10_000, lease_token: current.nextLeaseToken('takeover'),
          });
        }
        throw new Error('synthetic-provider-private-detail');
      },
    });
    try {
      const pending = worker.cleanup(current.admitted.invocation_ref);
      await assert.rejects(pending, (error) => {
        assert.equal(error.code, loss === 'shutdown' ? 'WORKER_CLOSED' : 'WORKER_CLEANUP_FAILED');
        assert.doesNotMatch(error.message, /synthetic-.*-detail/); return true;
      });
      assert.deepEqual(calls, ['destroyFork'], 'lost current authority forbids every later callback');
      assert.equal((await current.controlPlane.getInvocation(current.principal,
        current.admitted.invocation_ref)).state, 'cleanup_pending');
      if (loss !== 'shutdown') assert.equal(worker.cleanup(current.admitted.invocation_ref), pending);
    } finally { worker.close(); }
  });
}

test('cleanup shutdown during awaited renewal dispatches no provider callback', { timeout: 5000 }, async () => {
  const current = await cleanupPendingFixture();
  let entered; let release;
  const ready = new Promise((resolve) => { entered = resolve; });
  const wait = new Promise((resolve) => { release = resolve; });
  const controlPlane = { ...current.controlPlane, async renewLease(...args) {
    const result = await current.controlPlane.renewLease(...args); entered(); await wait; return result;
  } };
  let callbacks = 0;
  const worker = createManagedRiskForkWorker({ ...current.options, controlPlane,
    invokeProvider: () => { callbacks += 1; },
  });
  const rejected = assert.rejects(worker.cleanup(current.admitted.invocation_ref), { code: 'WORKER_CLOSED' });
  try {
    await ready; worker.close(); release(); await rejected;
    assert.equal(callbacks, 0);
    assert.equal((await current.controlPlane.getInvocation(current.principal,
      current.admitted.invocation_ref)).state, 'cleanup_pending');
  } finally { release(); worker.close(); }
});

for (const protocol of ['missing', 'caught-failed', 'propagated-duplicate', 'caught-duplicate']) {
  test(`cleanup ${protocol} broker fence cannot be classified by provider error codes`, async () => {
    const current = await cleanupPendingFixture();
    const calls = [];
    let renewals = 0;
    const controlPlane = { ...current.controlPlane, renewLease(...args) {
      if (protocol === 'caught-failed' && ++renewals === 2) throw new Error('synthetic-private-lease-detail');
      return current.controlPlane.renewLease(...args);
    } };
    const requestPolicy = createManagedRequestPolicy({ readControl: async () => ({ enabled: true, epoch: 1 }),
      consumeRateLimit: async () => ({ allowed: true, retry_after_seconds: 0 }), emitTelemetry: async () => {} });
    const worker = createManagedRiskForkWorker({ ...current.options, controlPlane, requestPolicy,
      invokeProvider: async (packet) => {
        calls.push(packet.method);
        if (protocol === 'missing') return undefined;
        if (protocol === 'caught-failed') {
          await assert.rejects(packet.effectFence(), { code: 'WORKER_FENCE_FAILED' });
          return undefined;
        }
        const context = await packet.effectFence();
        if (protocol === 'propagated-duplicate') await packet.effectFence();
        else await assert.rejects(packet.effectFence(), { code: 'WORKER_BROKER_FENCE_INVALID' });
        return packet.provider[packet.method](packet.input, context);
      },
    });
    try {
      if (protocol === 'caught-duplicate') {
        const terminal = await worker.cleanup(current.admitted.invocation_ref);
        assert.equal(terminal.state, 'completed');
        assert.deepEqual(calls, ['destroyFork', 'verifyDestroyed', 'destroySavepoint', 'verifySavepointDestroyed']);
      } else {
        await assert.rejects(worker.cleanup(current.admitted.invocation_ref), { code: 'WORKER_CLEANUP_FAILED' });
        assert.deepEqual(calls, ['destroyFork']);
        assert.equal((await current.controlPlane.getInvocation(current.principal,
          current.admitted.invocation_ref)).state, 'cleanup_pending');
      }
    } finally { worker.close(); }
  });
}

for (const withPolicy of [true, false]) {
  test(`cleanup rejects an unfinished broker fence with policy ${withPolicy}`, { timeout: 5000 }, async () => {
    const current = await cleanupPendingFixture();
    let release; let pendingFence;
    const wait = new Promise((resolve) => { release = resolve; });
    let renewals = 0;
    const controlPlane = { ...current.controlPlane, async renewLease(...args) {
      const result = await current.controlPlane.renewLease(...args);
      if (++renewals === 2) await wait;
      return result;
    } };
    let callbacks = 0;
    const requestPolicy = withPolicy ? createManagedRequestPolicy({ readControl: async () => ({ enabled: true, epoch: 1 }),
      consumeRateLimit: async () => ({ allowed: true, retry_after_seconds: 0 }), emitTelemetry: async () => {} }) : undefined;
    const worker = createManagedRiskForkWorker({ ...current.options, controlPlane, requestPolicy,
      invokeProvider: (packet) => {
        callbacks += 1; pendingFence = packet.effectFence();
        pendingFence.catch(() => {}); // Deliberately unfinished broker operation, observed below.
        return undefined;
      },
    });
    try {
      await assert.rejects(worker.cleanup(current.admitted.invocation_ref), { code: 'WORKER_CLEANUP_FAILED' });
      assert.equal(callbacks, 1, 'no second resource may inherit an unfinished fence');
      release();
      await assert.rejects(pendingFence, { code: 'WORKER_BROKER_FENCE_INVALID' });
      assert.equal((await current.controlPlane.getInvocation(current.principal,
        current.admitted.invocation_ref)).state, 'cleanup_pending');
    } finally { release(); worker.close(); }
  });
}

for (const withPolicy of [true, false]) {
  test(`cleanup pre-fence callback failure preserves the policy ${withPolicy} boundary`, async () => {
    const current = await cleanupPendingFixture();
    const calls = [];
    const requestPolicy = withPolicy ? createManagedRequestPolicy({ readControl: async () => ({ enabled: true, epoch: 1 }),
      consumeRateLimit: async () => ({ allowed: true, retry_after_seconds: 0 }), emitTelemetry: async () => {} }) : undefined;
    const worker = createManagedRiskForkWorker({ ...current.options, requestPolicy, invokeProvider: (packet) => {
      calls.push(packet.method);
      if (packet.method === 'destroyFork') throw new Error('synthetic-private-preflight-detail');
      return current.options.invokeProvider(packet);
    } });
    try {
      await assert.rejects(worker.cleanup(current.admitted.invocation_ref), (error) => {
        assert.equal(error.code, 'WORKER_CLEANUP_FAILED');
        assert.doesNotMatch(error.message, /synthetic-private-preflight-detail/); return true;
      });
      assert.deepEqual(calls, withPolicy ? ['destroyFork']
        : ['destroyFork', 'destroySavepoint', 'verifySavepointDestroyed']);
      assert.equal((await current.controlPlane.getInvocation(current.principal,
        current.admitted.invocation_ref)).state, 'cleanup_pending');
    } finally { worker.close(); }
  });
}

test('verify-only cleanup still checks the second resource but never imports a partially verified result', async () => {
  const current = await fixture();
  const calls = [];
  const worker = createManagedRiskForkWorker({ ...current.options, invokeProvider: async (packet) => {
    if (packet.context.lease_kind === 'cleanup') {
      calls.push(packet.method);
      if (packet.method === 'verifyDestroyed') {
        await packet.effectFence(); throw new Error('synthetic-private-observation-detail');
      }
    }
    return current.options.invokeProvider(packet);
  } });
  try {
    await assert.rejects(worker.execute(current.admitted.invocation_ref), { code: 'WORKER_CLEANUP_FAILED' });
    assert.deepEqual(calls, ['verifyDestroyed', 'verifySavepointDestroyed']);
    assert.deepEqual(current.provider.destroyCalls, ['fork', 'savepoint'], 'verify-only settlement never destroys twice');
    assert.equal((await current.controlPlane.getInvocation(current.principal,
      current.admitted.invocation_ref)).state, 'cleanup_pending');
  } finally { worker.close(); current.worker.close(); }
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
    recoveryPrincipal: current.recoveryPrincipal };
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
