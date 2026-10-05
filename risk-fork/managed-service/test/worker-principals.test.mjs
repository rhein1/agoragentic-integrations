import assert from 'node:assert/strict';
import test from 'node:test';
import { assertManagedWorkerPrincipals } from '../src/validation.mjs';
import { createManagedRiskForkWorker } from '../src/worker.mjs';
import { createManagedWorkerDeliveryJournal } from '../src/worker-delivery.mjs';
import { createManagedRiskForkLocalHost } from '../host/local-host.mjs';
import { createManagedRequestPolicy } from '../src/request-policy.mjs';
import { createFixture, invocationRequest, TEST_TOKEN } from './helpers.mjs';

function roles(fixture) {
  return { execution: fixture.principal, cleanup: fixture.sameTenantPrincipal,
    recovery: fixture.recoveryPrincipal };
}

function dependencies(fixture, principals = roles(fixture)) {
  let effects = 0;
  const common = { controlPlane: fixture.controlPlane, workerId: 'worker:principal-test',
    executionPrincipal: principals.execution, cleanupPrincipal: principals.cleanup,
    recoveryPrincipal: principals.recovery };
  const store = { async insert() { return true; }, async get() { return null; },
    async acknowledge() { return true; }, async listPending() { return []; } };
  const callbacks = { loadPrepareInput: async () => ({}),
    invokeProvider: async () => { effects += 1; }, lookupResources: async () => { effects += 1; return {}; },
    measureCostMicros: async () => 0 };
  return {
    worker: { ...common, providerRegistry: fixture.providerRegistry, ...callbacks },
    delivery: { ...common, store, encryptionKey: Buffer.alloc(32, 1),
      keyId: 'fixture:principal-test', namespace: 'fixture:principal-test' },
    host: { ...common, providerRegistry: fixture.providerRegistry, enabled: true,
      publicAuthenticator: fixture.authenticator, workerAuthenticator: fixture.authenticator,
      deliveryStore: store, deliveryEncryptionKey: Buffer.alloc(32, 1),
      deliveryKeyId: 'fixture:principal-test', deliveryNamespace: 'fixture:principal-test',
      workerOptions: callbacks },
    effects: () => effects,
  };
}

test('principal composition preserves original immutable branded identities', async () => {
  const fixture = await createFixture();
  const original = roles(fixture);
  const validated = assertManagedWorkerPrincipals(original);
  assert.ok(Object.isFrozen(validated));
  for (const purpose of ['execution', 'cleanup', 'recovery']) {
    assert.equal(validated[purpose], original[purpose], 'never clone away the authentication brand');
  }
  const options = dependencies(fixture);
  const worker = createManagedRiskForkWorker(options.worker);
  const journal = createManagedWorkerDeliveryJournal(options.delivery);
  const host = createManagedRiskForkLocalHost(options.host);
  worker.close(); journal.close(); await host.close();
  assert.equal(options.effects(), 0);
});

for (const factoryName of ['worker', 'delivery', 'host']) {
  test(`${factoryName} rejects reused objects and separately authenticated instances of the same key`, async () => {
    const fixture = await createFixture();
    const authenticatedAgain = await fixture.authenticator.authenticate(`Bearer ${TEST_TOKEN}`, 'worker:cleanup:claim');
    assert.notEqual(authenticatedAgain, fixture.principal);
    assert.equal(authenticatedAgain.key_id, fixture.principal.key_id);
    const create = { worker: createManagedRiskForkWorker,
      delivery: createManagedWorkerDeliveryJournal, host: createManagedRiskForkLocalHost }[factoryName];
    for (const cleanup of [fixture.principal, authenticatedAgain]) {
      const options = dependencies(fixture, { ...roles(fixture), cleanup });
      assert.throws(() => create(options[factoryName]), /distinct key_id/);
      assert.equal(options.effects(), 0);
    }
    const options = dependencies(fixture, { ...roles(fixture), recovery: fixture.sameTenantPrincipal });
    assert.throws(() => create(options[factoryName]), /distinct key_id/);
    assert.equal(options.effects(), 0);
  });

  test(`${factoryName} rejects mixed tenants and missing purpose scopes`, async () => {
    const fixture = await createFixture();
    const create = { worker: createManagedRiskForkWorker,
      delivery: createManagedWorkerDeliveryJournal, host: createManagedRiskForkLocalHost }[factoryName];
    const mixed = dependencies(fixture, { ...roles(fixture), cleanup: fixture.otherPrincipal });
    assert.throws(() => create(mixed[factoryName]), /same tenant/);
    const wrongPurpose = dependencies(fixture, { ...roles(fixture), execution: fixture.recoveryPrincipal });
    assert.throws(() => create(wrongPurpose[factoryName]), /claim and write scopes/);
    assert.equal(mixed.effects(), 0); assert.equal(wrongPurpose.effects(), 0);
  });
}

test('principal validation rejects proxies/accessors and mutable identity or scopes without invoking getters', async () => {
  const fixture = await createFixture(); let getters = 0;
  const accessor = Object.freeze(Object.defineProperty({ ...fixture.principal }, 'key_id', {
    enumerable: true, get() { getters += 1; return fixture.principal.key_id; },
  }));
  const accessorScopes = [];
  Object.defineProperty(accessorScopes, '0', { enumerable: true,
    get() { getters += 1; return 'worker:execution:claim'; } });
  Object.defineProperty(accessorScopes, '1', { enumerable: true, value: 'worker:execution:write' });
  Object.freeze(accessorScopes);
  for (const execution of [
    new Proxy(fixture.principal, {}), accessor,
    { ...fixture.principal },
    Object.freeze({ ...fixture.principal, scopes: [...fixture.principal.scopes] }),
    Object.freeze({ ...fixture.principal, scopes: accessorScopes }),
    null,
  ]) {
    assert.throws(() => assertManagedWorkerPrincipals({ ...roles(fixture), execution }), TypeError);
  }
  assert.equal(getters, 0);
  for (const input of [new Proxy(roles(fixture), {}), { ...roles(fixture), other: fixture.principal },
    { execution: fixture.principal, cleanup: fixture.sameTenantPrincipal }]) {
    assert.throws(() => assertManagedWorkerPrincipals(input), TypeError);
  }
});

test('principal composition never substitutes inherited roles or identity fields', async () => {
  const fixture = await createFixture();
  const inherited = (field, value, operation) => {
    const previous = Object.getOwnPropertyDescriptor(Object.prototype, field);
    Object.defineProperty(Object.prototype, field, { configurable: true, value });
    try { operation(); }
    finally {
      if (previous) Object.defineProperty(Object.prototype, field, previous);
      else delete Object.prototype[field];
    }
  };
  for (const field of ['key_id', 'tenant_id', 'scopes']) {
    const execution = { ...fixture.principal };
    delete execution[field]; Object.freeze(execution);
    inherited(field, fixture.principal[field], () => {
      assert.throws(() => assertManagedWorkerPrincipals({ ...roles(fixture), execution }), /must contain own/);
    });
  }
  inherited('execution', fixture.principal, () => {
    assert.throws(() => assertManagedWorkerPrincipals({ cleanup: fixture.sameTenantPrincipal,
      recovery: fixture.recoveryPrincipal }), /every purpose as own data/);
  });
});

test('composition validation does not authenticate a frozen clone or authorize provider effects', async () => {
  const fixture = await createFixture();
  const { invocation } = await fixture.controlPlane.admitInvocation(fixture.principal, invocationRequest());
  const clone = Object.freeze({ ...fixture.principal });
  const options = dependencies(fixture, { ...roles(fixture), execution: clone });
  const worker = createManagedRiskForkWorker(options.worker);
  try {
    await assert.rejects(worker.execute(invocation.invocation_ref), { code: 'AUTHENTICATION_REQUIRED' });
    assert.equal(options.effects(), 0);
    assert.equal((await fixture.controlPlane.getInvocation(fixture.principal, invocation.invocation_ref)).state, 'admitted');
  } finally { worker.close(); }
});

test('invalid local host principal composition fails before delivery-store access or key retention', async () => {
  const fixture = await createFixture(); let storeAccesses = 0;
  const options = dependencies(fixture, { ...roles(fixture), cleanup: fixture.principal }).host;
  const store = {};
  for (const method of ['insert', 'get', 'acknowledge', 'listPending']) {
    Object.defineProperty(store, method, { get() { storeAccesses += 1; throw new Error('store touched'); } });
  }
  assert.throws(() => createManagedRiskForkLocalHost({ ...options, deliveryStore: store }), /distinct key_id/);
  assert.equal(storeAccesses, 0);
  assert.equal(options.deliveryEncryptionKey[0], 1, 'caller key remains untouched');
});

test('local host policy uses the captured role assignments after its caller mutates options', async () => {
  const fixture = await createFixture(); const observed = [];
  const policy = createManagedRequestPolicy({ readControl: async () => ({ enabled: true, epoch: 1 }),
    consumeRateLimit: async (input) => { observed.push([input.route_class, input.key_id]); return { allowed: true, retry_after_seconds: 0 }; },
    emitTelemetry: async () => {} });
  const options = { ...dependencies(fixture).host, requestPolicy: policy };
  const host = createManagedRiskForkLocalHost(options);
  options.executionPrincipal = fixture.otherPrincipal;
  options.cleanupPrincipal = fixture.principal;
  options.recoveryPrincipal = fixture.principal;
  await host.start();
  try {
    await assert.rejects(host.execute('missing'));
    await assert.rejects(host.cleanup('missing'));
    await assert.rejects(host.recover('missing'));
    assert.deepEqual(observed, [['execution', fixture.principal.key_id],
      ['cleanup', fixture.sameTenantPrincipal.key_id], ['recovery', fixture.recoveryPrincipal.key_id]]);
  } finally { await host.close(); }
});
