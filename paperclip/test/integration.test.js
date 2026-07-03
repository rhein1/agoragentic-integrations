/**
 * Tests for Agoragentic Paperclip Integration
 *
 * Covers:
 *  1. Client: execute, match, invoke, retry, error handling
 *  2. Plugin: tool registration, cost recording, trust propagation
 *  3. Budget constraint propagation
 *  4. Failed provider / retry-safe behavior
 */

const assert = require('assert');
const { AgoragenticClient, AgoragenticError, TRUST_LEVELS } = require('../src/client');
const { createAgoragenticPlugin } = require('../src/plugin');

let testsPassed = 0;
let testsFailed = 0;

function test(name, fn) {
  try {
    fn();
    testsPassed++;
    console.log(`  ✓ ${name}`);
  } catch (err) {
    testsFailed++;
    console.error(`  ✗ ${name}: ${err.message}`);
  }
}

async function asyncTest(name, fn) {
  try {
    await fn();
    testsPassed++;
    console.log(`  ✓ ${name}`);
  } catch (err) {
    testsFailed++;
    console.error(`  ✗ ${name}: ${err.message}`);
  }
}

// ─── Mock Fetch ─────────────────────────────────────────

let mockResponses = [];

function mockFetch(url, opts) {
  const handler = mockResponses.shift();
  if (!handler) return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve({}) });
  const response = handler(url, opts);
  return Promise.resolve({
    ok: response.status >= 200 && response.status < 300,
    status: response.status || 200,
    json: () => Promise.resolve(response.body || {}),
  });
}

// Inject mock
global.fetch = mockFetch;

// ─── Client Tests ───────────────────────────────────────

async function main() {

console.log('\n1. CLIENT CONSTRUCTION\n');

test('requires apiKey', () => {
  assert.throws(() => new AgoragenticClient(), /apiKey is required/);
});

test('accepts minimal config', () => {
  const c = new AgoragenticClient({ apiKey: 'test-key' });
  assert.strictEqual(c.baseUrl, 'https://agoragentic.com');
  assert.strictEqual(c.timeoutMs, 30000);
  assert.strictEqual(c.maxRetries, 2);
});

test('custom baseUrl strips trailing slash', () => {
  const c = new AgoragenticClient({ apiKey: 'k', baseUrl: 'https://custom.example/' });
  assert.strictEqual(c.baseUrl, 'https://custom.example');
});

test('custom baseUrl strips repeated trailing slashes', () => {
  const c = new AgoragenticClient({ apiKey: 'k', baseUrl: 'https://custom.example///' });
  assert.strictEqual(c.baseUrl, 'https://custom.example');
});

console.log('\n2. EXECUTE PATH (router-first)\n');

await asyncTest('executeCapability sends correct request', async () => {
  mockResponses = [(url, opts) => {
    assert(url.includes('/api/execute'));
    const body = JSON.parse(opts.body);
    assert.strictEqual(body.task, 'summarize');
    assert.strictEqual(body.input, 'test input');
    assert.strictEqual(body.constraints.max_cost, 0.50);
    return {
      status: 200,
      body: {
        execution_id: 'exec-1',
        output: 'summary result',
        status: 'success',
        cost: 0.25,
        provider: { id: 'p1', name: 'TestProvider', trust_status: 'verified' },
        candidates_considered: 3,
      },
    };
  }];

  const c = new AgoragenticClient({ apiKey: 'test-key', maxRetries: 0 });
  const result = await c.executeCapability({
    task: 'summarize',
    input: 'test input',
    constraints: { max_cost: 0.50 },
  });

  assert.strictEqual(result.execution_id, 'exec-1');
  assert.strictEqual(result.output, 'summary result');
  assert.strictEqual(result.cost, 0.25);
  assert.strictEqual(result.provider.trust_status, 'verified');
  assert.strictEqual(result.candidates_considered, 3);
});

await asyncTest('budget constraint is propagated', async () => {
  mockResponses = [(url, opts) => {
    const body = JSON.parse(opts.body);
    assert.strictEqual(body.constraints.max_cost, 1.00);
    return { status: 200, body: { execution_id: 'e2', output: 'ok', cost: 0.10 } };
  }];

  const c = new AgoragenticClient({ apiKey: 'k', maxRetries: 0 });
  const r = await c.executeCapability({ task: 't', input: 'i', constraints: { max_cost: 1.00 } });
  assert.strictEqual(r.cost, 0.10);
});

console.log('\n3. MATCH PATH (approval-gated)\n');

await asyncTest('matchCapabilities returns normalized candidates', async () => {
  mockResponses = [(url) => {
    assert(url.includes('/api/execute/match'));
    assert(url.includes('task=translate'));
    return {
      status: 200,
      body: {
        candidates: [
          { id: 'c1', name: 'TranslatorA', price: 0.10, trust_status: 'verified', seller_name: 'Seller1', score: 0.95 },
          { id: 'c2', name: 'TranslatorB', price: 0.20, trust_status: 'reachable', seller_name: 'Seller2', score: 0.80 },
          { id: 'c3', name: 'TranslatorC', price: 0.05, trust_status: 'failed', seller_name: 'Seller3', score: 0.60 },
        ],
      },
    };
  }];

  const c = new AgoragenticClient({ apiKey: 'k', maxRetries: 0 });
  const result = await c.matchCapabilities({ task: 'translate' });

  assert.strictEqual(result.candidates.length, 3);
  assert.strictEqual(result.candidates[0].trust_status, 'verified');
  assert.strictEqual(result.candidates[1].trust_status, 'reachable');
  assert.strictEqual(result.candidates[2].trust_status, 'failed');
});

console.log('\n4. INVOKE PATH (direct commerce)\n');

await asyncTest('invokeCapability sends idempotency key', async () => {
  mockResponses = [(url, opts) => {
    assert(url.includes('/api/invoke/cap-123'));
    assert.strictEqual(opts.headers['Idempotency-Key'], 'idem-abc');
    return {
      status: 200,
      body: {
        invocation_id: 'inv-1',
        output: 'translated text',
        cost: 0.15,
        provider: { id: 'p2', name: 'TranslatorA', trust_status: 'verified' },
      },
    };
  }];

  const c = new AgoragenticClient({ apiKey: 'k', maxRetries: 0 });
  const result = await c.invokeCapability({
    capabilityId: 'cap-123',
    input: 'hello world',
    idempotencyKey: 'idem-abc',
  });

  assert.strictEqual(result.invocation_id, 'inv-1');
  assert.strictEqual(result.provider.trust_status, 'verified');
});

console.log('\n5. TRUST METADATA PROPAGATION\n');

test('TRUST_LEVELS has exact vocabulary', () => {
  assert.deepStrictEqual(TRUST_LEVELS, ['verified', 'reachable', 'failed']);
});

await asyncTest('trust status is preserved through execute', async () => {
  for (const trustLevel of TRUST_LEVELS) {
    mockResponses = [() => ({
      status: 200,
      body: { output: 'ok', provider: { id: 'p', name: 'P', trust_status: trustLevel } },
    })];
    const c = new AgoragenticClient({ apiKey: 'k', maxRetries: 0 });
    const r = await c.executeCapability({ task: 't', input: 'i' });
    assert.strictEqual(r.provider.trust_status, trustLevel,
      `Expected trust_status '${trustLevel}' but got '${r.provider.trust_status}'`);
  }
});

console.log('\n6. ERROR HANDLING & RETRY\n');

await asyncTest('4xx errors are not retried', async () => {
  let callCount = 0;
  mockResponses = [() => { callCount++; return { status: 422, body: { error: 'validation_failed' } }; }];

  const c = new AgoragenticClient({ apiKey: 'k', maxRetries: 2 });
  try {
    await c.executeCapability({ task: 't', input: 'i' });
    assert.fail('Should have thrown');
  } catch (err) {
    assert(err instanceof AgoragenticError);
    assert.strictEqual(err.statusCode, 422);
    assert.strictEqual(err.retryable, false);
    assert.strictEqual(callCount, 1); // No retries
  }
});

await asyncTest('5xx errors are retried', async () => {
  let callCount = 0;
  mockResponses = [
    () => { callCount++; return { status: 500, body: { error: 'server_error' } }; },
    () => { callCount++; return { status: 500, body: { error: 'server_error' } }; },
    () => { callCount++; return { status: 200, body: { output: 'recovered' } }; },
  ];

  const c = new AgoragenticClient({ apiKey: 'k', maxRetries: 2, retryDelayMs: 10 });
  const r = await c.executeCapability({ task: 't', input: 'i' });
  assert.strictEqual(r.output, 'recovered');
  assert.strictEqual(callCount, 3);
});

await asyncTest('401 throws immediately with correct error', async () => {
  mockResponses = [() => ({ status: 401, body: { error: 'unauthorized' } })];

  const c = new AgoragenticClient({ apiKey: 'bad-key', maxRetries: 2 });
  try {
    await c.executeCapability({ task: 't', input: 'i' });
    assert.fail('Should have thrown');
  } catch (err) {
    assert(err instanceof AgoragenticError);
    assert.strictEqual(err.statusCode, 401);
    assert.strictEqual(err.retryable, false);
  }
});

console.log('\n7. PLUGIN CONSTRUCTION\n');

test('createAgoragenticPlugin returns plugin shape', () => {
  const plugin = createAgoragenticPlugin();
  assert.strictEqual(typeof plugin.setup, 'function');
  assert.strictEqual(typeof plugin.onHealth, 'function');
});

await asyncTest('plugin health returns degraded without API key', async () => {
  const plugin = createAgoragenticPlugin();
  // No setup = no client
  const health = await plugin.onHealth();
  assert.strictEqual(health.status, 'degraded');
});

await asyncTest('plugin setup registers with API key', async () => {
  const registered = { tools: {}, jobs: {}, data: {}, events: {} };
  const mockCtx = {
    config: { get: () => ({ agoragentic_api_key: 'test-key' }) },
    secrets: null,
    logger: { info: () => {}, warn: () => {}, error: () => {} },
    tools: { register: (name, def) => { registered.tools[name] = def; } },
    jobs: { register: (name, fn) => { registered.jobs[name] = fn; } },
    data: { register: (name, fn) => { registered.data[name] = fn; } },
    events: { on: (name, fn) => { registered.events[name] = fn; } },
    activity: null,
    state: { get: () => null, set: () => {} },
  };

  const plugin = createAgoragenticPlugin();
  await plugin.setup(mockCtx);

  assert(registered.tools['agoragentic_execute'], 'execute tool registered');
  assert(registered.tools['agoragentic_match'], 'match tool registered');
  assert(registered.tools['agoragentic_invoke'], 'invoke tool registered');
  assert(registered.jobs['agoragentic-sync'], 'sync job registered');
  assert(registered.data['agoragentic-status'], 'status data handler registered');
  assert(registered.events['issue.created'], 'issue.created listener registered');
});

// ─── Summary ────────────────────────────────────────────

console.log('\n============================================================');
console.log(`PAPERCLIP INTEGRATION: ${testsPassed} PASS, ${testsFailed} FAIL`);
console.log('============================================================');
process.exit(testsFailed > 0 ? 1 : 0);

} // end main

main().catch(err => { console.error('Fatal:', err); process.exit(1); });
