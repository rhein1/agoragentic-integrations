import assert from 'node:assert/strict';
import test from 'node:test';
import { createManagedAuthenticator, hashManagedApiKey } from '../src/auth.mjs';
import { createManagedServiceConfig } from '../src/config.mjs';
import { MANAGED_SERVICE_PRODUCTION_QUALIFIED } from '../src/constants.mjs';
import { MemoryManagedServiceStore } from '../src/memory-store.mjs';
import { assertDataArray, cloneJson, requireIso } from '../src/validation.mjs';
import { createFixture, TEST_TOKEN } from './helpers.mjs';

test('managed service is default-off and production activation is hard blocked', () => {
  const config = createManagedServiceConfig();
  assert.equal(config.enabled, false);
  assert.equal(config.default_off, true);
  assert.equal(config.live_traffic_protected, false);
  assert.equal(MANAGED_SERVICE_PRODUCTION_QUALIFIED, false);
  assert.throws(
    () => createManagedServiceConfig({ enabled: true, environment: 'production' }),
    (error) => error.code === 'MANAGED_SERVICE_PRODUCTION_NOT_QUALIFIED',
  );
});

test('memory and PostgreSQL attribution both require globally unique API key IDs', async () => {
  const fixture = await createFixture();
  assert.throws(
    () => new MemoryManagedServiceStore({
      tenants: [fixture.tenant, fixture.otherTenant],
      credentials: [
        fixture.credentials[0],
        { ...fixture.credentials[1], key_id: fixture.credentials[0].key_id },
      ],
    }),
    /key IDs must be globally unique/,
  );
});

test('memory credential provisioning rejects proxies and accessors without executing them', async () => {
  const fixture = await createFixture();
  let effects = 0;
  const proxy = new Proxy({}, {
    ownKeys() {
      effects += 1;
      throw new Error('must not run');
    },
  });
  assert.throws(
    () => new MemoryManagedServiceStore({
      tenants: [fixture.tenant],
      credentials: [proxy],
    }),
    /must not be a Proxy|not closed JSON data/,
  );
  assert.equal(effects, 0);

  const accessor = {};
  Object.defineProperty(accessor, 'key_id', {
    enumerable: true,
    get() {
      effects += 1;
      throw new Error('must not run');
    },
  });
  assert.throws(
    () => new MemoryManagedServiceStore({
      tenants: [fixture.tenant],
      credentials: [accessor],
    }),
    /not enumerable data/,
  );
  assert.equal(effects, 0);
});

test('authenticator hashes bearer values and binds scope and tenant', async () => {
  const fixture = await createFixture();
  const authenticator = createManagedAuthenticator({
    store: fixture.store,
    clock: () => new Date('2026-09-05T12:00:00.000Z'),
  });
  const principal = await authenticator.authenticate(
    `Bearer ${TEST_TOKEN}`,
    'invocations:write',
  );
  assert.equal(principal.tenant_id, 'tenant_alpha');
  assert.equal(principal.key_id, 'key_alpha');
  assert.match(hashManagedApiKey(TEST_TOKEN), /^sha256:[a-f0-9]{64}$/);
  await assert.rejects(
    authenticator.authenticate(`Bearer rf_local_fixture_${'z'.repeat(32)}`, 'invocations:write'),
    (error) => error.code === 'AUTHENTICATION_FAILED' && error.status === 401,
  );
  await assert.rejects(
    authenticator.authenticate(`Bearer ${TEST_TOKEN}`, 'unknown:scope'),
    TypeError,
  );
});

test('disabled control plane refuses invocation admission', async () => {
  const fixture = await createFixture();
  const disabled = createManagedServiceConfig({ enabled: false, environment: 'local_test' });
  const { createManagedRiskForkControlPlane } = await import('../src/control-plane.mjs');
  const controlPlane = createManagedRiskForkControlPlane({
    config: disabled,
    store: fixture.store,
    providerRegistry: fixture.providerRegistry,
    requirePrincipal: fixture.authenticator.requirePrincipal,
  });
  await assert.rejects(
    controlPlane.admitInvocation(fixture.principal, {}),
    (error) => error.code === 'MANAGED_SERVICE_DISABLED',
  );
});

test('programmatic callers cannot forge an authenticated tenant principal', async () => {
  const fixture = await createFixture();
  await assert.rejects(
    fixture.controlPlane.getInvocation({
      key_id: 'forged_key',
      tenant_id: 'tenant_alpha',
      scopes: ['invocations:read'],
    }, 'rfi_missing'),
    (error) => error.code === 'AUTHENTICATION_REQUIRED' && error.status === 401,
  );
});

test('principals are bound to one authenticator and rechecked for expiry on every call', async () => {
  const first = await createFixture();
  const second = await createFixture();
  await assert.rejects(
    second.controlPlane.admitInvocation(first.principal, {
      idempotency_key: 'cross-authenticator-key-0001',
      provider_id: 'local-test-provider',
      operation: { kind: 'mcp_tool_call', tool_name: 'example.safe_tool', arguments: {} },
      estimated_cost_micros: 0,
    }),
    (error) => error.code === 'AUTHENTICATION_REQUIRED',
  );
  first.setNow('2026-09-07T00:00:00.000Z');
  await assert.rejects(
    first.controlPlane.getInvocation(first.principal, 'rfi_missing'),
    (error) => error.code === 'AUTHENTICATION_FAILED',
  );
});

test('control planes reject hand-built config objects', async () => {
  const fixture = await createFixture();
  const { createManagedRiskForkControlPlane } = await import('../src/control-plane.mjs');
  assert.throws(
    () => createManagedRiskForkControlPlane({
      config: { enabled: true, environment: 'local_test', limits: {} },
      store: fixture.store,
      providerRegistry: fixture.providerRegistry,
      requirePrincipal: fixture.authenticator.requirePrincipal,
    }),
    /must be created by createManagedServiceConfig/,
  );
  assert.throws(
    () => createManagedRiskForkControlPlane({
      config: fixture.config,
      store: fixture.store,
      providerRegistry: fixture.providerRegistry,
      requirePrincipal: async () => {},
    }),
    /must come from createManagedAuthenticator/,
  );
  const other = await createFixture();
  assert.throws(
    () => createManagedRiskForkControlPlane({
      config: other.config,
      store: other.store,
      providerRegistry: other.providerRegistry,
      requirePrincipal: fixture.authenticator.requirePrincipal,
    }),
    /for the same store/,
  );
});

test('closed JSON snapshots reject proxies and accessors without invoking child code', () => {
  let invoked = 0;
  const proxy = new Proxy({}, {
    getOwnPropertyDescriptor() {
      invoked += 1;
      throw new Error('must not run');
    },
  });
  assert.throws(() => cloneJson(proxy), /must not be|not closed JSON/);
  assert.equal(invoked, 0);

  const accessor = {};
  Object.defineProperty(accessor, 'value', {
    enumerable: true,
    get() {
      invoked += 1;
      throw new Error('must not run');
    },
  });
  assert.throws(() => cloneJson(accessor), /not enumerable data/);
  assert.equal(invoked, 0);

  const array = [];
  const hostileArrayPrototype = Object.create(Array.prototype);
  Object.defineProperties(hostileArrayPrototype, {
    toJSON: {
      value() {
        invoked += 1;
        return ['attacker-controlled'];
      },
    },
    [Symbol.iterator]: {
      value() {
        invoked += 1;
        return [][Symbol.iterator]();
      },
    },
  });
  Object.setPrototypeOf(array, hostileArrayPrototype);
  assert.throws(() => assertDataArray(array, 'hostile array'), /plain array/);
  assert.throws(() => cloneJson(array), /plain array/);
  assert.equal(invoked, 0);

  const ownIteratorArray = [];
  Object.defineProperty(ownIteratorArray, Symbol.iterator, {
    value() {
      invoked += 1;
      return [][Symbol.iterator]();
    },
  });
  assert.throws(
    () => assertDataArray(ownIteratorArray, 'own iterator array'),
    /symbol keys/,
  );
  assert.equal(invoked, 0);
});

test('ISO timestamps reject proxy and subclass hooks without executing caller code', () => {
  let effects = 0;
  const proxiedDate = new Proxy(new Date('2026-09-05T12:00:00.000Z'), {
    getPrototypeOf() {
      effects += 1;
      throw new Error('must not run');
    },
  });
  assert.throws(() => requireIso(proxiedDate, 'timestamp'), /must not be a Proxy/);
  assert.equal(effects, 0);

  class HostileDate extends Date {
    toISOString() {
      effects += 1;
      return '2026-09-05T12:00:00.000Z';
    }
  }
  assert.throws(
    () => requireIso(new HostileDate('2026-09-05T12:00:00.000Z'), 'timestamp'),
    /exact Date/,
  );
  assert.equal(effects, 0);
});

test('invocation admission rejects nested proxies and accessors without invoking them', async () => {
  const fixture = await createFixture();
  let effects = 0;
  const nestedProxy = new Proxy({}, {
    getPrototypeOf() {
      effects += 1;
      throw new Error('must not run');
    },
    ownKeys() {
      effects += 1;
      throw new Error('must not run');
    },
  });
  await assert.rejects(
    fixture.controlPlane.admitInvocation(fixture.principal, {
      idempotency_key: 'top-level-proxy-operation-0001',
      provider_id: 'local-test-provider',
      operation: nestedProxy,
      estimated_cost_micros: 0,
    }),
    /not closed JSON data/,
  );
  assert.equal(effects, 0);
  await assert.rejects(
    fixture.controlPlane.admitInvocation(fixture.principal, {
      idempotency_key: 'nested-proxy-operation-0002',
      provider_id: 'local-test-provider',
      operation: {
        kind: 'mcp_tool_call',
        tool_name: 'example.safe_tool',
        arguments: { nested: nestedProxy },
      },
      estimated_cost_micros: 0,
    }),
    /not closed JSON data/,
  );
  assert.equal(effects, 0);

  const accessorArguments = {};
  Object.defineProperty(accessorArguments, 'value', {
    enumerable: true,
    get() {
      effects += 1;
      throw new Error('must not run');
    },
  });
  await assert.rejects(
    fixture.controlPlane.admitInvocation(fixture.principal, {
      idempotency_key: 'accessor-operation-admission-0003',
      provider_id: 'local-test-provider',
      operation: {
        kind: 'mcp_tool_call',
        tool_name: 'example.safe_tool',
        arguments: accessorArguments,
      },
      estimated_cost_micros: 0,
    }),
    /not enumerable data/,
  );
  assert.equal(effects, 0);
});

test('invocation references are constrained to HTTP-addressable path segments', async () => {
  const fixture = await createFixture({ invocationRef: () => 'rfi/not-addressable' });
  await assert.rejects(
    fixture.controlPlane.admitInvocation(fixture.principal, {
      idempotency_key: 'invalid-generated-invocation-ref-0001',
      provider_id: 'local-test-provider',
      operation: { kind: 'mcp_tool_call', tool_name: 'example.safe_tool', arguments: {} },
      estimated_cost_micros: 0,
    }),
    /URL-segment-safe invocation reference/,
  );
});
