import test from 'node:test';
import assert from 'node:assert/strict';
import { sha256Ref } from '../../src/canonical.mjs';
import { lifecycleTenantHash } from '../src/lifecycle-event.mjs';
import { createManagedRiskForkWorker } from '../src/worker.mjs';
import { createManagedRiskForkLocalHost } from '../host/local-host.mjs';
import { workerDiagnosticFixture } from './helpers/worker-diagnostic-fixture.mjs';

for (const [boundary,method] of [['lease_fence','renewLease'],['resource_journal','recordResources'],['execution_outcome','recordExecutionOutcome'],
  ['cleanup_completion','completeCleanup'],['cleanup_incomplete_append','recordCleanupIncomplete']]) {
  test('worker observes only its owned '+boundary+' phase without inspecting hostile failures', async () => {
    let traps = 0;
    const hostile = new Proxy({}, { get() { traps++; throw null; },getPrototypeOf() { traps++; throw null; } });
    const f = await workerDiagnosticFixture(), control = { ...f.controlPlane,[method]: () => { throw hostile; } };
    if (boundary === 'cleanup_incomplete_append') control.completeCleanup = () => { throw null; };
    const worker = createManagedRiskForkWorker({ ...f.options,controlPlane: control });
    try {
      const promise = worker.execute(f.admitted.invocation_ref);
      await promise.then(() => assert.fail('must not import result'),() => {});
      assert.equal(worker.execute(f.admitted.invocation_ref),promise,'failed attempt remains memoized');
      await worker.flushDiagnostics(); assert.equal(traps,0);
      const health = worker.status().diagnostics; assert.equal(health.failure_counts[boundary],1);
      assert.ok(f.packets.some((event) => event.boundary === boundary));
      for (const event of f.packets) {
        assert.equal(event.tenant_hash,lifecycleTenantHash(f.principal.tenant_id));
        assert.equal(event.worker_hash,sha256Ref({ domain: 'risk-fork-worker-diagnostic-identity-v1',worker_id: f.options.workerId }));
        assert.equal(event.production_qualified,false); assert.equal(JSON.stringify(event).includes('lease_token'),false);
      }
    } finally { worker.close(); f.worker.close(); }
  });
}
for (const boundary of ['preparation_read','cost_read','broker_contract','provider_call']) {
  test('worker records '+boundary+' and does not retry the operation', async () => {
    let calls = 0;
    const f = await workerDiagnosticFixture(boundary === 'provider_call' ? { setupProvider(provider) {
      provider.createSavepoint = () => { calls++; throw Object.defineProperty({},'code',{ get() { assert.fail('must never inspect code'); } }); };
    } } : {});
    const options = { ...f.options };
    if (boundary === 'preparation_read') options.loadPrepareInput = () => { calls++; throw null; };
    if (boundary === 'cost_read') options.measureCostMicros = () => { calls++; return -1; };
    if (boundary === 'broker_contract') options.invokeProvider = () => { calls++; throw 'private broker failure'; };
    const worker = createManagedRiskForkWorker(options);
    try {
      const attempt = worker.execute(f.admitted.invocation_ref); await attempt.then(() => assert.fail(),() => {}); await worker.flushDiagnostics();
      assert.equal(worker.status().diagnostics.failure_counts[boundary],1); assert.equal(calls,1);
      assert.equal(worker.execute(f.admitted.invocation_ref),attempt); assert.equal(calls,1);
      assert.equal(f.packets.some((event) => event.boundary === boundary),true);
      if (boundary !== 'provider_call') assert.equal(worker.status().diagnostics.failure_counts.provider_call,0);
      else assert.equal(worker.status().diagnostics.failure_counts.broker_contract,0,'propagated provider rejection is not a second broker failure');
    } finally { worker.close(); f.worker.close(); }
  });
}
test('preflight denial after capability reservation is not a provider-call failure', async () => {
  const f = await workerDiagnosticFixture(); let deny = false;
  const control = { ...f.controlPlane,renewLease(...args) { if (deny) throw null; return f.controlPlane.renewLease(...args); } };
  const worker = createManagedRiskForkWorker({ ...f.options,controlPlane: control,invokeProvider: async (packet) => {
    await packet.effectFence(); deny = true; return packet.provider[packet.method](packet.input);
  } });
  try {
    await assert.rejects(worker.execute(f.admitted.invocation_ref)); await worker.flushDiagnostics();
    assert.deepEqual(f.provider.created,[]); assert.equal(worker.status().diagnostics.failure_counts.provider_call,0);
    assert.equal(worker.status().diagnostics.failure_counts.broker_contract,0,'compliant propagation of a denied second preflight is not broker misconduct');
    assert.ok(worker.status().diagnostics.failure_counts.lease_fence > 0);
    assert.equal(f.packets.some((event) => event.boundary === 'provider_call'),false);
  } finally { worker.close(); f.worker.close(); }
});
test('broker effectFence propagating a denied lease does not create a broker-contract or provider-call observation', async () => {
  const f = await workerDiagnosticFixture(); let deny = false;
  const control = { ...f.controlPlane,renewLease(...args) { if (deny) throw null; return f.controlPlane.renewLease(...args); } };
  const worker = createManagedRiskForkWorker({ ...f.options,controlPlane: control,invokeProvider: async (packet) => {
    deny = true; await packet.effectFence(); return packet.provider[packet.method](packet.input);
  } });
  try {
    await assert.rejects(worker.execute(f.admitted.invocation_ref)); await worker.flushDiagnostics();
    assert.deepEqual(f.provider.created,[]); assert.ok(worker.status().diagnostics.failure_counts.lease_fence > 0);
    assert.equal(worker.status().diagnostics.failure_counts.provider_call,0); assert.equal(worker.status().diagnostics.failure_counts.broker_contract,0);
  } finally { worker.close(); f.worker.close(); }
});
for (const mode of ['broker','provider','recorder']) {
  test('bounded local host close preserves a never-settling '+mode+' callback without fabricated outcome', { timeout: 10000 }, async () => {
    let entered;
    const ready = new Promise((resolve) => { entered = resolve; }), never = new Promise(() => {});
    const f = await workerDiagnosticFixture(mode === 'provider' ? { setupProvider(provider) {
      provider.createSavepoint = () => { entered(); return never; };
    } } : {});
    const rows = new Map(), deliveryStore = {
      async insert(record) { const key = record.namespace+':'+record.attempt_ref; if (rows.has(key)) return false;
        rows.set(key,{ record: structuredClone(record),acknowledged: false }); return true; },
      async get(namespace,ref) { return structuredClone(rows.get(namespace+':'+ref) ?? null); },
      async acknowledge(namespace,ref,hash) { const row = rows.get(namespace+':'+ref); row.acknowledged = true; row.response_hash = hash; },
      async listPending(namespace,limit) { return [...rows.values()].filter((r) => r.record.namespace === namespace && !r.acknowledged)
        .map((r) => r.record.attempt_ref).slice(0,limit); },
    };
    const workerOptions = Object.fromEntries(['leaseMs','clock','loadPrepareInput','invokeProvider','lookupResources','measureCostMicros',
      'workerDiagnosticSettings','workerDiagnosticClock','workerDiagnosticStore'].map((key) => [key,f.options[key]]));
    if (mode === 'broker') workerOptions.invokeProvider = () => { entered(); return never; };
    if (mode === 'recorder') {
      workerOptions.loadPrepareInput = () => { throw null; };
      workerOptions.workerDiagnosticStore = { appendWorkerDiagnosticObservation() { entered(); return never; } };
      workerOptions.workerDiagnosticTimeoutMs = 50;
    }
    const host = createManagedRiskForkLocalHost({ enabled: true,controlPlane: f.controlPlane,providerRegistry: f.providerRegistry,
      publicAuthenticator: f.authenticator,workerAuthenticator: f.authenticator,executionPrincipal: f.principal,
      cleanupPrincipal: f.sameTenantPrincipal,recoveryPrincipal: f.recoveryPrincipal,workerId: f.options.workerId,
      deliveryStore,deliveryEncryptionKey: Buffer.alloc(32,0x71),deliveryKeyId: 'key:diagnostic-host',deliveryNamespace: 'namespace:diagnostic-host',
      workerOptions,reaperOptions: { intervalMs: 1000 } });
    try {
      await host.start(); const attempt = host.execute(f.admitted.invocation_ref); attempt.catch(() => {}); await ready;
      if (mode === 'recorder') await assert.rejects(attempt);
      const started = performance.now(); await host.close(); assert.ok(performance.now()-started < 3000);
      const health = host.health(); assert.equal(health.closed,true); assert.equal(health.worker.termination_proven,false);
      assert.equal(health.production_qualified,false); assert.equal(health.live_traffic_protected,false);
      assert.equal(health.worker.diagnostics.recorded,0); assert.equal(health.worker.diagnostics.failure_counts.provider_call,0);
      if (mode === 'recorder') {
        assert.equal(health.telemetry_close.worker_diagnostics.settled,false); assert.equal(health.worker.diagnostics.in_flight,1);
      } else {
        assert.equal(health.worker.pending_attempts,1); assert.equal(health.worker.pending_provider_callbacks,mode === 'provider' ? 1 : 0);
        assert.equal(health.worker.diagnostics.failure_counts.broker_contract,0); assert.deepEqual(f.packets,[]);
      }
    } finally { await host.close(); f.worker.close(); }
  });
}
test('broker swallowing or rewriting a provider rejection records both owned boundaries without reading the thrown value', async () => {
  for (const returns of [true,false]) {
    let traps = 0;
    const hostile = new Proxy({}, { get() { traps++; throw null; },getPrototypeOf() { traps++; throw null; } });
    const f = await workerDiagnosticFixture({ setupProvider(provider) { provider.createSavepoint = () => { throw hostile; }; } });
    const worker = createManagedRiskForkWorker({ ...f.options,invokeProvider: async (packet) => {
      await packet.effectFence();
      try { await packet.provider[packet.method](packet.input); } catch {
        if (returns) return { fabricated: true };
        throw null;
      }
    } });
    try {
      await assert.rejects(worker.execute(f.admitted.invocation_ref)); await worker.flushDiagnostics();
      assert.equal(traps,0); assert.equal(worker.status().diagnostics.failure_counts.provider_call,1);
      assert.equal(worker.status().diagnostics.failure_counts.broker_contract,1);
      assert.equal((await f.controlPlane.getInvocation(f.principal,f.admitted.invocation_ref)).savepoint_ref,null);
    } finally { worker.close(); f.worker.close(); }
  }
});
test('equal primitive provider rejections cannot prove propagation and conservatively leave both boundaries unconfirmed', async () => {
  for (const reason of [null,undefined,'opaque',17,Symbol('opaque')]) {
    const f = await workerDiagnosticFixture({ setupProvider(provider) { provider.createSavepoint = () => { throw reason; }; } });
    const worker = createManagedRiskForkWorker({ ...f.options,invokeProvider: async (packet) => {
      await packet.effectFence(); try { await packet.provider[packet.method](packet.input); } catch { throw reason; }
    } });
    try {
      await assert.rejects(worker.execute(f.admitted.invocation_ref)); await worker.flushDiagnostics();
      assert.equal(worker.status().diagnostics.failure_counts.provider_call,1); assert.equal(worker.status().diagnostics.failure_counts.broker_contract,1);
      assert.equal((await f.controlPlane.getInvocation(f.principal,f.admitted.invocation_ref)).savepoint_ref,null);
    } finally { worker.close(); f.worker.close(); }
  }
});
test('wrong-tenant claim and renewal replies fail closed without allocating or trusting their diagnostic tenant', async () => {
  for (const method of ['claimExecution','renewLease']) {
    const f = await workerDiagnosticFixture(), control = { ...f.controlPlane,async [method](...args) {
      const result = await f.controlPlane[method](...args);
      return method === 'claimExecution' ? { ...result,invocation: { ...result.invocation,tenant_id: 'tenant_other' } } : { ...result,tenant_id: 'tenant_other' };
    } };
    const worker = createManagedRiskForkWorker({ ...f.options,controlPlane: control });
    try {
      await assert.rejects(worker.execute(f.admitted.invocation_ref)); await worker.flushDiagnostics(); assert.deepEqual(f.provider.created,[]);
      assert.ok(f.packets.every((event) => event.tenant_hash === lifecycleTenantHash('tenant_alpha')));
      if (method === 'claimExecution') assert.deepEqual(f.packets,[],'pre-claim failures are not attributed as worker phases');
    } finally { worker.close(); f.worker.close(); }
  }
});
for (const boundary of ['recovery_lookup','recovery_absence_completion']) {
  test('recovery observes '+boundary+' without creation or original operation replay', async () => {
    const f = await workerDiagnosticFixture();
    await f.controlPlane.claimExecution(f.principal,{ invocation_ref: f.admitted.invocation_ref,worker_id: 'old-worker',lease_ms: 10000,lease_token: f.nextLeaseToken() });
    f.setNow('2026-09-05T12:00:11.000Z'); await f.controlPlane.sweepExpiredLeases();
    const options = { ...f.options };
    if (boundary === 'recovery_lookup') options.lookupResources = () => { throw null; };
    else options.controlPlane = { ...f.controlPlane,completeRecoveryAbsence: () => { throw null; } };
    const worker = createManagedRiskForkWorker(options);
    try {
      await assert.rejects(worker.recover(f.admitted.invocation_ref)); await worker.flushDiagnostics();
      assert.equal(worker.status().diagnostics.failure_counts[boundary],1); assert.deepEqual(f.provider.created,[]);
      assert.equal((await f.controlPlane.getInvocation(f.principal,f.admitted.invocation_ref)).state,'recovery_required');
    } finally { worker.close(); f.worker.close(); }
  });
}
test('cancellation-read failure signals but retains actual host work and no synthetic provider outcome', async () => {
  const f = await workerDiagnosticFixture(); let release;
  const wait = new Promise((resolve) => { release = resolve; });
  const worker = createManagedRiskForkWorker({ ...f.options,cancellationPollMs: 20,
    controlPlane: { ...f.controlPlane,observeExecutionCancellation: () => { throw null; } },
    loadPrepareInput: async (invocation) => { await wait; return f.options.loadPrepareInput(invocation); } });
  try {
    const attempt = worker.execute(f.admitted.invocation_ref), rejection = attempt.catch(() => {});
    await new Promise((resolve) => setTimeout(resolve,60)); await worker.flushDiagnostics();
    assert.equal(worker.status().diagnostics.failure_counts.cancellation_read,1); assert.equal(worker.status().pending_attempts,1);
    assert.equal(worker.status().termination_proven,false); assert.deepEqual(f.provider.created,[]);
    release(); await rejection; assert.equal(worker.status().pending_attempts,0);
  } finally { release(); worker.close(); f.worker.close(); }
});
test('dropped hung provider is broker-unconfirmed, stays owned across close and never manufactures provider failure or cleanup proof', async () => {
  let release,entered,call;
  const wait = new Promise((resolve) => { release = resolve; }), ready = new Promise((resolve) => { entered = resolve; });
  const f = await workerDiagnosticFixture({ setupProvider(provider) {
    provider.createSavepoint = async () => { entered(); await wait; return { savepoint_ref: 'savepoint:test',savepoint_hash: sha256Ref('savepoint') }; };
  } });
  const worker = createManagedRiskForkWorker({ ...f.options,invokeProvider: async (packet) => {
    await packet.effectFence(); call = packet.provider[packet.method](packet.input); await ready; return { fabricated: true };
  } });
  try {
    await assert.rejects(worker.execute(f.admitted.invocation_ref)); await worker.flushDiagnostics();
    assert.equal(worker.status().diagnostics.failure_counts.broker_contract,1); assert.equal(worker.status().diagnostics.failure_counts.provider_call,0);
    assert.equal(worker.close().pending_provider_callbacks,1); release(); await call;
    assert.equal(worker.status().pending_provider_callbacks,0); assert.equal(worker.status().diagnostics.failure_counts.provider_call,0);
    assert.equal((await f.controlPlane.getInvocation(f.principal,f.admitted.invocation_ref)).savepoint_ref,null);
  } finally { release(); await call?.catch(() => {}); worker.close(); f.worker.close(); }
});
