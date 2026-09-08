import assert from 'node:assert/strict';
import test from 'node:test';

import { sha256Ref } from '../src/canonical.mjs';
import {
  RISK_FORK_MCP_PORTABLE_HANDLE_DIAGNOSTIC_CODES as CODES,
  RiskForkMcpPortableHandleError,
  createMcpPortableHandleRegistry,
  isMcpPortableHandleRegistry,
} from '../src/mcp-portable-handle-boundary.mjs';

const HANDLE = 'browser_0123456789abcdef';
const PRINCIPAL = sha256Ref('principal:alice');
const ORIGINATING_REQUEST = sha256Ref('request:origin');
const CONSUMING_REQUEST = sha256Ref('request:consume:1');

function registration(overrides = {}) {
  return {
    handle_value: HANDLE,
    principal_ref: PRINCIPAL,
    issuer: 'https://identity.example.com/',
    audience: 'https://mcp.example.com/rpc',
    mcp_server_origin: 'https://mcp.example.com',
    originating_method: 'tools/call',
    originating_request_hash: ORIGINATING_REQUEST,
    allowed_consuming_methods: ['resources/read', 'tools/call'],
    ttl_ms: 60_000,
    single_use: false,
    max_consumptions: 100,
    ...overrides,
  };
}

function authorization(binding, overrides = {}) {
  return {
    handle_value: HANDLE,
    binding,
    principal_ref: PRINCIPAL,
    issuer: 'https://identity.example.com/',
    audience: 'https://mcp.example.com/rpc',
    mcp_server_origin: 'https://mcp.example.com',
    originating_method: 'tools/call',
    originating_request_hash: ORIGINATING_REQUEST,
    consuming_method: 'tools/call',
    consuming_request_hash: CONSUMING_REQUEST,
    ...overrides,
  };
}

function assertCode(code) {
  return (error) => error instanceof RiskForkMcpPortableHandleError && error.code === code;
}

test('portable handles are bound without retaining or returning raw handle or principal values', () => {
  const registry = createMcpPortableHandleRegistry({
    clock: () => new Date('2026-09-07T12:00:00.000Z'),
  });
  assert.equal(isMcpPortableHandleRegistry(registry), true);
  assert.equal(isMcpPortableHandleRegistry({ ...registry }), false);

  const binding = registry.register(registration());
  const decision = registry.authorize(authorization(binding));
  for (const output of [binding, decision]) {
    const serialized = JSON.stringify(output);
    assert.equal(serialized.includes(HANDLE), false);
    assert.equal(serialized.includes(PRINCIPAL), false);
    assert.equal(Object.isFrozen(output), true);
  }
  assert.equal(decision.transferable, false);
  assert.equal(decision.raw_handle_exposed, false);
  assert.equal(decision.raw_principal_exposed, false);
  assert.deepEqual(Object.keys(registry), ['schema', 'register', 'authorize', 'close']);
});

test('portable handle identity is exact and rejects malformed or normalized aliases', () => {
  const registry = createMcpPortableHandleRegistry({
    clock: () => new Date('2026-09-07T12:00:00.000Z'),
  });
  const binding = registry.register(registration());

  assert.throws(
    () => registry.authorize(authorization(binding, { handle_value: ` ${HANDLE} ` })),
    assertCode(CODES.INVALID_INPUT),
  );
  assert.throws(
    () => registry.register(registration({
      handle_value: 'portable_handle_0123456789\ud800',
    })),
    assertCode(CODES.INVALID_INPUT),
  );

  const unicodeRegistry = createMcpPortableHandleRegistry({
    clock: () => new Date('2026-09-07T12:00:00.000Z'),
  });
  const composed = 'portable_handle_0123456789_\u00e9';
  const decomposed = 'portable_handle_0123456789_e\u0301';
  const unicodeBinding = unicodeRegistry.register(registration({ handle_value: composed }));
  assert.throws(
    () => unicodeRegistry.authorize(authorization(unicodeBinding, {
      handle_value: decomposed,
    })),
    assertCode(CODES.UNKNOWN_HANDLE),
  );
});

test('portable handles fail closed across principal, issuer, audience, origin, and originating request', () => {
  const cases = [
    ['principal', { principal_ref: sha256Ref('principal:bob') }],
    ['issuer', { issuer: 'https://other-identity.example.com/' }],
    ['audience', { audience: 'https://mcp.example.com/other' }],
    [
      'origin',
      {
        audience: 'https://other-mcp.example.com/rpc',
        mcp_server_origin: 'https://other-mcp.example.com',
      },
    ],
    ['originating method', { originating_method: 'resources/read' }],
    ['originating request', { originating_request_hash: sha256Ref('request:other') }],
  ];
  for (const [label, overrides] of cases) {
    const registry = createMcpPortableHandleRegistry({
      clock: () => new Date('2026-09-07T12:00:00.000Z'),
    });
    const binding = registry.register(registration());
    assert.throws(
      () => registry.authorize(authorization(binding, overrides)),
      assertCode(CODES.CONTEXT_MISMATCH),
      label,
    );
  }
});

test('portable handles enforce explicit consuming methods and unique consuming request hashes', () => {
  const registry = createMcpPortableHandleRegistry({
    clock: () => new Date('2026-09-07T12:00:00.000Z'),
  });
  const binding = registry.register(registration());
  assert.throws(
    () => registry.authorize(authorization(binding, { consuming_method: 'prompts/get' })),
    assertCode(CODES.CONTEXT_MISMATCH),
  );
  registry.authorize(authorization(binding));
  assert.throws(
    () => registry.authorize(authorization(binding)),
    assertCode(CODES.REPLAY),
  );
  const second = registry.authorize(authorization(binding, {
    consuming_request_hash: sha256Ref('request:consume:2'),
  }));
  assert.equal(second.consuming_method, 'tools/call');
});

test('single-use bindings reject a second distinct consumption', () => {
  const registry = createMcpPortableHandleRegistry({
    clock: () => new Date('2026-09-07T12:00:00.000Z'),
  });
  const binding = registry.register(registration({
    single_use: true,
    max_consumptions: 1,
  }));
  registry.authorize(authorization(binding));
  assert.throws(
    () => registry.authorize(authorization(binding, {
      consuming_request_hash: sha256Ref('request:consume:2'),
    })),
    assertCode(CODES.REPLAY),
  );
});

test('expired, unknown, duplicate, and closed handle state fails closed', () => {
  let now = new Date('2026-09-07T12:00:00.000Z');
  const registry = createMcpPortableHandleRegistry({ clock: () => now });
  const binding = registry.register(registration({ ttl_ms: 1_000 }));
  assert.throws(
    () => registry.register(registration()),
    assertCode(CODES.ALREADY_REGISTERED),
  );
  now = new Date('2026-09-07T12:00:01.000Z');
  assert.throws(
    () => registry.authorize(authorization(binding)),
    assertCode(CODES.EXPIRED),
  );
  assert.throws(
    () => registry.authorize(authorization(binding, {
      handle_value: 'unknown_0123456789abcdef',
    })),
    assertCode(CODES.UNKNOWN_HANDLE),
  );
  registry.close();
  assert.throws(
    () => registry.register(registration()),
    assertCode(CODES.CLOSED),
  );
});

test('tampered or independently rehashed binding receipts are not registry authority', () => {
  const registry = createMcpPortableHandleRegistry({
    clock: () => new Date('2026-09-07T12:00:00.000Z'),
  });
  const binding = registry.register(registration());
  assert.throws(
    () => registry.authorize(authorization({ ...binding, expires_at: '2026-09-07T12:02:00.000Z' })),
    assertCode(CODES.BINDING_MISMATCH),
  );
  const forged = {
    ...binding,
    audience: 'https://mcp.example.com/forged',
    binding_hash: null,
  };
  forged.binding_hash = sha256Ref(forged);
  assert.throws(
    () => registry.authorize(authorization(forged, {
      audience: 'https://mcp.example.com/forged',
    })),
    assertCode(CODES.BINDING_MISMATCH),
  );
  const otherRegistry = createMcpPortableHandleRegistry({
    clock: () => new Date('2026-09-07T12:00:00.000Z'),
  });
  assert.throws(
    () => otherRegistry.authorize(authorization(binding)),
    assertCode(CODES.UNKNOWN_HANDLE),
  );
});

test('registration rejects raw credentials, unhashed principals, unsafe lifetimes, and ambiguous method sets', () => {
  const registry = createMcpPortableHandleRegistry({
    clock: () => new Date('2026-09-07T12:00:00.000Z'),
  });
  assert.throws(
    () => registry.register(registration({ handle_value: 'Bearer secret-token-value-12345' })),
    assertCode(CODES.RAW_CREDENTIAL_REJECTED),
  );
  const generatedApiKey = `amk_${'a'.repeat(64)}`;
  const percentEncodedApiKey = `%61mk_${'a'.repeat(64)}`;
  for (const urls of [
    { issuer: `https://identity.example.com/${generatedApiKey}` },
    { audience: `https://mcp.example.com/${generatedApiKey}` },
    { issuer: `https://identity.example.com/${percentEncodedApiKey}` },
    { audience: `https://mcp.example.com/${percentEncodedApiKey}` },
  ]) {
    assert.throws(
      () => registry.register(registration(urls)),
      assertCode(CODES.RAW_CREDENTIAL_REJECTED),
    );
  }
  for (const methods of [
    { originating_method: generatedApiKey },
    { allowed_consuming_methods: [generatedApiKey] },
  ]) {
    assert.throws(
      () => registry.register(registration(methods)),
      assertCode(CODES.RAW_CREDENTIAL_REJECTED),
    );
  }
  assert.throws(
    () => registry.register(registration({ principal_ref: 'principal:alice' })),
    assertCode(CODES.INVALID_INPUT),
  );
  assert.throws(
    () => registry.register(registration({ ttl_ms: 300_001 })),
    assertCode(CODES.INVALID_INPUT),
  );
  for (const methods of [[], ['tools/call', 'tools/call'], ['tools/call', 'resources/read']]) {
    assert.throws(
      () => registry.register(registration({ allowed_consuming_methods: methods })),
      assertCode(CODES.INVALID_INPUT),
    );
  }
  assert.throws(
    () => registry.register(registration({ single_use: true, max_consumptions: 2 })),
    assertCode(CODES.INVALID_INPUT),
  );
});

test('reusable handles have a hard bounded consumption count', () => {
  const registry = createMcpPortableHandleRegistry({
    clock: () => new Date('2026-09-07T12:00:00.000Z'),
  });
  const binding = registry.register(registration({ max_consumptions: 2 }));
  registry.authorize(authorization(binding));
  registry.authorize(authorization(binding, {
    consuming_request_hash: sha256Ref('request:consume:2'),
  }));
  assert.throws(
    () => registry.authorize(authorization(binding, {
      consuming_request_hash: sha256Ref('request:consume:3'),
    })),
    assertCode(CODES.USE_LIMIT),
  );
});

test('clock rollback fails closed without authorizing a handle', () => {
  let now = new Date('2026-09-07T12:00:00.000Z');
  const registry = createMcpPortableHandleRegistry({ clock: () => now });
  const binding = registry.register(registration());
  now = new Date('2026-09-07T11:59:59.999Z');
  assert.throws(
    () => registry.authorize(authorization(binding)),
    assertCode(CODES.CLOCK_ROLLBACK),
  );
});

test('closing from the registry clock revokes in-progress registration and authorization', () => {
  let registrationRegistry;
  let closeDuringRegistration = false;
  registrationRegistry = createMcpPortableHandleRegistry({
    clock: () => {
      if (closeDuringRegistration) registrationRegistry.close();
      return new Date('2026-09-07T12:00:00.000Z');
    },
  });
  closeDuringRegistration = true;
  assert.throws(
    () => registrationRegistry.register(registration()),
    assertCode(CODES.CLOSED),
  );

  let authorizationRegistry;
  let closeDuringAuthorization = false;
  authorizationRegistry = createMcpPortableHandleRegistry({
    clock: () => {
      if (closeDuringAuthorization) authorizationRegistry.close();
      return new Date('2026-09-07T12:00:00.000Z');
    },
  });
  const binding = authorizationRegistry.register(registration());
  closeDuringAuthorization = true;
  assert.throws(
    () => authorizationRegistry.authorize(authorization(binding)),
    assertCode(CODES.CLOSED),
  );
});
