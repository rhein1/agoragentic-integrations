import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import pg from 'pg';
import {
  createDurableMcpPortableHandleRegistry,
  createMcpPortableHandlePreEffectBoundary,
  RISK_FORK_MCP_PORTABLE_HANDLE_DIAGNOSTIC_CODES as CODES,
} from '../src/mcp-portable-handle-boundary.mjs';
import {
  createPostgresMcpPortableHandleStore, migrateMcpPortableHandlesPostgres,
} from '../src/adapters/postgres-mcp-portable-handles.mjs';
import { sha256Ref } from '../src/canonical.mjs';

const url = process.env.RISK_FORK_TEST_POSTGRES_URL;
test('portable-handle PostgreSQL tests are mandatory when requested', () => {
  if (process.env.RISK_FORK_REQUIRE_POSTGRES_TESTS === '1') assert.ok(url);
});
const HANDLE = 'browser_0123456789abcdef';
const PRINCIPAL = sha256Ref('principal:alice');
const registration = (overrides = {}) => ({
  handle_value: HANDLE, principal_ref: PRINCIPAL,
  issuer: 'https://identity.example.com/', audience: 'https://mcp.example.com/rpc',
  mcp_server_origin: 'https://mcp.example.com', originating_method: 'tools/call',
  originating_request_hash: sha256Ref('origin'), allowed_consuming_methods: ['resources/read', 'tools/call'],
  ttl_ms: 60_000, single_use: false, max_consumptions: 100, ...overrides,
});
const authorization = (binding, overrides = {}) => ({
  handle_value: HANDLE, binding, principal_ref: PRINCIPAL,
  issuer: binding.issuer, audience: binding.audience, mcp_server_origin: binding.mcp_server_origin,
  originating_method: binding.originating_method, originating_request_hash: binding.originating_request_hash,
  consuming_method: 'tools/call', consuming_request_hash: sha256Ref(randomUUID()), ...overrides,
});
const code = (expected) => (error) => error.code === expected;

test('durable portable handles survive restart and serialize exact-context consumption',
  { skip: !url && 'requires an isolated RISK_FORK_TEST_POSTGRES_URL' }, async (t) => {
    const parsed = new URL(url);
    assert.ok(['localhost', '127.0.0.1', '[::1]'].includes(parsed.hostname), 'test DB must be loopback');
    assert.match(parsed.pathname, /test/i, 'test DB must have a test-specific name');
    const schemaName = `mcp_handles_test_${randomUUID().replaceAll('-', '')}`;
    const pool = new pg.Pool({ connectionString: url, max: 8 });
    t.after(async () => { await pool.query(`DROP SCHEMA "${schemaName}" CASCADE`); await pool.end(); });
    const options = { pool, schemaName, requireTls: false, statementTimeoutMs: 10_000 };
    await assert.rejects(createPostgresMcpPortableHandleStore(options)); // runtime does not migrate
    const migration = await migrateMcpPortableHandlesPostgres(options);
    assert.equal(migration.production_qualified, false);
    assert.deepEqual(await migrateMcpPortableHandlesPostgres(options), migration);
    const store1 = await createPostgresMcpPortableHandleStore(options);
    const store2 = await createPostgresMcpPortableHandleStore(options);
    const key = Buffer.alloc(32, 71); // synthetic test key, never an operational credential
    const registry = (store, overrides = {}) => createDurableMcpPortableHandleRegistry({
      store, tenant_ref: 'tenant:test', key_id: 'key:test-v1', hash_key: key, ...overrides,
    });
    const first = registry(store1);
    const second = registry(store2);
    const binding = await first.register(registration());
    first.close();
    assert.equal(key[0], 71, 'registry close must not zero caller-owned key');
    await second.authorize(authorization(binding));
    const identity = {
      tenant_ref: 'tenant:test', principal_ref: PRINCIPAL, issuer: binding.issuer,
      audience: binding.audience, mcp_server_origin: binding.mcp_server_origin,
      expires_at: new Date(Date.now() + 60_000).toISOString(),
    };
    const descriptor = sha256Ref('bound tool descriptor');
    const request = { phase: 'tools/call', tool_name: 'use_handle', tool_descriptor_hash: descriptor,
      mcp_server_origin: identity.mcp_server_origin, request_hash: sha256Ref('bound request'),
      params: { arguments: { handle: HANDLE, binding } } };
    const contract = { phase: request.phase, tool_name: request.tool_name,
      tool_descriptor_hash: descriptor, mcp_server_origin: identity.mcp_server_origin,
      handle_path: ['arguments', 'handle'], binding_path: ['arguments', 'binding'] };
    const boundary = createMcpPortableHandlePreEffectBoundary({
      authenticate: () => identity, registry_for_context: () => second, contracts: [contract],
    });
    const receipt = await boundary.authorize(request, {});
    assert.equal(receipt.consuming_request_hash, request.request_hash);
    await assert.rejects(boundary.authorize(request, {}), code(CODES.REPLAY));
    const wrongPrincipal = createMcpPortableHandlePreEffectBoundary({
      authenticate: () => ({ ...identity, principal_ref: sha256Ref('other principal') }),
      registry_for_context: () => second, contracts: [contract],
    });
    await assert.rejects(wrongPrincipal.authorize({ ...request, request_hash: sha256Ref('new request') }, {}),
      code(CODES.CONTEXT_MISMATCH));
    await assert.rejects(boundary.authorize({ ...request, params: { handle: HANDLE, binding } }, {}),
      code(CODES.CONTRACT_REQUIRED));
    const badKey = registry(store2, { hash_key: Buffer.alloc(32, 72) });
    await assert.rejects(badKey.authorize(authorization(binding)), code(CODES.INVALID_CONFIGURATION));
    for (const mismatch of [
      { principal_ref: sha256Ref('bob') }, { issuer: 'https://other.example.com/' },
      { audience: 'https://mcp.example.com/other' },
      { mcp_server_origin: 'https://other.example.com', audience: 'https://other.example.com/rpc' },
      { originating_method: 'resources/read' }, { originating_request_hash: sha256Ref('other') },
      { consuming_method: 'prompts/get' },
    ]) await assert.rejects(second.authorize(authorization(binding, mismatch)), code(CODES.CONTEXT_MISMATCH));
    const tampered = { ...binding, expires_at: '2099-01-01T00:00:00.000Z', binding_hash: null };
    tampered.binding_hash = sha256Ref(tampered);
    await assert.rejects(second.authorize(authorization(tampered)), code(CODES.BINDING_MISMATCH));

    const onceHandle = 'once_0123456789abcdef';
    const once = await second.register(registration({ handle_value: onceHandle, single_use: true, max_consumptions: 1 }));
    const third = registry(store1);
    const raced = await Promise.allSettled(Array.from({ length: 8 }, (_, i) =>
      (i % 2 ? second : third).authorize(authorization(once, { handle_value: onceHandle }))));
    assert.equal(raced.filter((result) => result.status === 'fulfilled').length, 1);
    for (const result of raced.filter((item) => item.status === 'rejected')) assert.equal(result.reason.code, CODES.REPLAY);
    const reusableHandle = 'limited_0123456789abcdef';
    const reusable = await second.register(registration({ handle_value: reusableHandle, max_consumptions: 2 }));
    const requestHash = sha256Ref('same-request');
    await third.authorize(authorization(reusable, { handle_value: reusableHandle, consuming_request_hash: requestHash }));
    await assert.rejects(second.authorize(authorization(reusable, {
      handle_value: reusableHandle, consuming_request_hash: requestHash,
    })), code(CODES.REPLAY));
    await second.authorize(authorization(reusable, { handle_value: reusableHandle }));
    await assert.rejects(third.authorize(authorization(reusable, { handle_value: reusableHandle })), code(CODES.USE_LIMIT));
    await third.revoke({ handle_value: HANDLE });
    await assert.rejects(second.authorize(authorization(binding)), code(CODES.REVOKED));
    await assert.rejects(second.register(registration()), code(CODES.ALREADY_REGISTERED));

    const expiredHandle = 'expiry_0123456789abcdef';
    const expiry = await second.register(registration({ handle_value: expiredHandle, ttl_ms: 1_000 }));
    const lock = await pool.connect();
    await lock.query('BEGIN');
    await lock.query(`SELECT 1 FROM "${schemaName}".portable_handles WHERE handle_hash=$1 FOR UPDATE`, [expiry.handle_hash]);
    const waiting = second.authorize(authorization(expiry, { handle_value: expiredHandle }));
    // Observe rejection immediately to avoid an unhandled rejection while the lock is held.
    const rejected = assert.rejects(waiting, code(CODES.EXPIRED));
    await lock.query('SELECT pg_sleep(1.1)');
    await lock.query('COMMIT');
    lock.release();
    await rejected;

    const small = registry(store1, { tenant_ref: 'tenant:capacity', max_entries: 1 });
    const capacityRace = await Promise.allSettled([small.register(registration()),
      small.register(registration({ handle_value: 'other_0123456789abcdef' }))]);
    assert.equal(capacityRace.filter((item) => item.status === 'fulfilled').length, 1);
    assert.equal(capacityRace.find((item) => item.status === 'rejected').reason.code, CODES.CAPACITY_EXCEEDED);
    const widened = registry(store2, { tenant_ref: 'tenant:capacity', max_entries: 2 });
    await assert.rejects(widened.register(registration({ handle_value: 'wide_0123456789abcdef' })), code(CODES.INVALID_CONFIGURATION));
    const allRows = await pool.query(`SELECT row_to_json(h) AS data FROM "${schemaName}".portable_handles h
      UNION ALL SELECT row_to_json(c) FROM "${schemaName}".handle_consumptions c`);
    const persisted = JSON.stringify(allRows.rows);
    assert.equal(persisted.includes(HANDLE), false);
    assert.equal(persisted.includes(PRINCIPAL), false);
    await assert.rejects(pool.query(`UPDATE "${schemaName}".handle_consumptions SET consumed_at=now()`));
    await assert.rejects(pool.query(`TRUNCATE "${schemaName}".handle_consumptions`));
    await assert.rejects(pool.query(`UPDATE "${schemaName}".portable_handles SET max_consumptions=1000`));
    await assert.rejects(pool.query(`DELETE FROM "${schemaName}".portable_handles`));
    await assert.rejects(pool.query(`UPDATE "${schemaName}".handle_schema_migrations SET migration_hash=$1`, [sha256Ref('wrong')]));
    // Only the test schema owner can remove a trigger. Runtime initialization detects that drift.
    await pool.query(`DROP TRIGGER handle_consumptions_immutable ON "${schemaName}".handle_consumptions`);
    await assert.rejects(createPostgresMcpPortableHandleStore(options), code(CODES.INVALID_CONFIGURATION));
    await store1.close(); await store2.close();
  });

test('pre-effect boundary requires per-request identity and explicit descriptor-bound handle contracts', async () => {
  const now = new Date('2026-10-02T12:00:00.000Z');
  const identity = {
    tenant_ref: 'tenant:test', principal_ref: PRINCIPAL,
    issuer: 'https://identity.example.com/', audience: 'https://mcp.example.com/rpc',
    mcp_server_origin: 'https://mcp.example.com', expires_at: '2026-10-02T12:01:00.000Z',
  };
  const descriptor = sha256Ref('tool');
  const request = { phase: 'tools/call', tool_name: 'get_data', tool_descriptor_hash: descriptor,
    mcp_server_origin: identity.mcp_server_origin, request_hash: sha256Ref('request'), params: {} };
  const contract = { phase: request.phase, tool_name: request.tool_name,
    tool_descriptor_hash: descriptor, mcp_server_origin: identity.mcp_server_origin,
    handle_path: null, binding_path: null };
  let calls = 0;
  const authentication = Object.freeze({ opaque: true });
  const boundary = createMcpPortableHandlePreEffectBoundary({
    authenticate: async (_request, context) => { calls += 1; assert.equal(context.authentication, authentication); return identity; },
    registry_for_context: () => { throw new Error('no handle contract must not consult registry'); },
    contracts: [contract], clock: () => now,
  });
  assert.equal(await boundary.authorize(request, { authentication }), null);
  assert.equal(calls, 2, 'recheck authentication immediately after admission');
  await boundary.authorize({ ...request, phase: 'tools/list' }, { authentication });
  assert.equal(calls, 3, 'discovery also requires current authentication');
  await assert.rejects(boundary.authorize({ ...request, tool_descriptor_hash: sha256Ref('changed') }, { authentication }),
    code(CODES.CONTRACT_REQUIRED));
  let expired = false;
  const changing = createMcpPortableHandlePreEffectBoundary({
    authenticate: () => { const result = expired ? { ...identity, expires_at: now.toISOString() } : identity; expired = true; return result; },
    registry_for_context: () => null, contracts: [contract], clock: () => now,
  });
  await assert.rejects(changing.authorize(request, {}), code(CODES.AUTHENTICATION_REQUIRED));
  const missing = createMcpPortableHandlePreEffectBoundary({
    authenticate: () => identity, registry_for_context: () => null, contracts: [], clock: () => now,
  });
  await assert.rejects(missing.authorize(request, {}), code(CODES.CONTRACT_REQUIRED));
  assert.throws(() => createMcpPortableHandlePreEffectBoundary({
    authenticate: () => identity, registry_for_context: () => null,
    contracts: [{ ...contract, handle_path: ['__proto__'], binding_path: ['binding'] }],
  }));
});

test('durable registry captures storage callbacks and returns only its exact closed receipt', async () => {
  const now = '2026-10-02T12:00:00.000Z';
  let stored;
  let mutate = (value) => value;
  const store = {
    async register(_scope, _input, build) { stored = build(now); return stored; },
    async consume(_scope, _input, validate) { return mutate(validate(stored, now)); },
    async revoke() {},
  };
  const registry = createDurableMcpPortableHandleRegistry({ store,
    tenant_ref: 'tenant:test', key_id: 'key:test', hash_key: Buffer.alloc(32, 73) });
  const binding = await registry.register(registration());
  store.consume = () => { throw new Error('mutated storage callback must not run'); };
  const receipt = await registry.authorize(authorization(binding));
  assert.equal(receipt.transferable, false);
  for (const changes of [
    { private_note: 'extra material' }, { expires_at: '2099-01-01T00:00:00.000Z' },
    { allowed_consuming_methods: ['prompts/get'] }, { schema: 'wrong' },
    { single_use: true }, { max_consumptions: 1000 }, { transferable: true },
  ]) {
    mutate = (value) => { const changed = { ...value, ...changes, authorization_hash: null };
      changed.authorization_hash = sha256Ref(changed); return changed; };
    await assert.rejects(registry.authorize(authorization(binding)), code(CODES.BINDING_MISMATCH));
  }
  registry.close();
});
