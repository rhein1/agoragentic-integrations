import assert from 'node:assert/strict';
import test from 'node:test';

import { createAgoragenticCodebuffTools } from '../adapters/codebuff-tools.ts';
import { OrationClient } from '../adapters/oration-client.mjs';
import { AgoragenticClient } from '../openrouter-agent-sdk/src/agoragentic-client.mjs';
import { createAgoragenticOpenRouterTools } from '../openrouter-agent-sdk/src/agoragentic-tools.mjs';

function jsonResponse(payload = { ok: true }, status = 200) {
  const encoded = JSON.stringify(payload);
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => payload,
    text: async () => encoded,
  };
}

function recordingFetch(calls, payload = { ok: true }) {
  return async (url, init = {}) => {
    calls.push({ url: new URL(url), init });
    return jsonResponse(payload);
  };
}

async function withEnvironment(overrides, callback) {
  const previous = new Map(Object.keys(overrides).map((key) => [key, process.env[key]]));
  for (const [key, value] of Object.entries(overrides)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  try {
    return await callback();
  } finally {
    for (const [key, value] of previous) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

test('OpenRouter client uses the live match and receipt routes with exact no-spend constraints', async () => {
  const calls = [];
  const client = new AgoragenticClient({
    baseUrl: 'https://agoragentic.example/',
    apiKey: 'test-key',
    fetchImpl: recordingFetch(calls),
  });
  const constraints = {
    category: 'research',
    max_cost: 0,
    max_latency_ms: 750,
    payment_network: 'base',
    unsupported: 'must-not-leak',
  };

  await client.match({ task: 'find a provider', constraints });
  await client.quote({ task: 'quote a task', constraints });
  await client.receipt({ invocationId: 'inv/a' });

  assert.equal(calls.length, 3);
  for (const call of calls.slice(0, 2)) {
    assert.equal(call.url.pathname, '/api/execute/match');
    assert.equal(call.init.method, 'GET');
    assert.equal(call.url.searchParams.get('category'), 'research');
    assert.equal(call.url.searchParams.get('max_cost'), '0');
    assert.equal(call.url.searchParams.get('max_latency_ms'), '750');
    assert.equal(call.url.searchParams.get('payment_network'), 'base');
    assert.equal(call.url.searchParams.has('unsupported'), false);
    assert.equal(call.init.body, undefined);
    assert.equal(call.init.headers.Authorization, 'Bearer test-key');
  }
  assert.equal(calls[0].url.searchParams.get('task'), 'find a provider');
  assert.equal(calls[1].url.searchParams.get('task'), 'quote a task');
  assert.equal(calls[2].url.pathname, '/api/commerce/receipts/inv%2Fa');
});

test('OpenRouter execute rejects missing or invalid bounds before any fetch', () => {
  let fetchCount = 0;
  const client = new AgoragenticClient({
    baseUrl: 'https://agoragentic.example/',
    apiKey: 'test-key',
    fetchImpl: async () => {
      fetchCount += 1;
      return jsonResponse();
    },
  });

  const invalid = [
    [{ task: 'unbounded' }, 'missing_execution_bound'],
    [{ task: 'empty', constraints: {} }, 'missing_execution_bound'],
    [{ task: 'nan', constraints: { max_cost: Number.NaN } }, 'invalid_input'],
    [{ task: 'infinity', constraints: { max_cost: Number.POSITIVE_INFINITY } }, 'invalid_input'],
    [{ task: 'negative', constraints: { max_cost: -0.01 } }, 'invalid_input'],
    [{ task: 'blank quote', constraints: { quote_id: '   ' } }, 'invalid_input'],
    [{ task: 'array input', input: [], constraints: { max_cost: 0 } }, 'invalid_input'],
    [{ task: 'date input', input: new Date(0), constraints: { max_cost: 0 } }, 'invalid_input'],
  ];
  for (const [args, code] of invalid) {
    assert.throws(
      () => client.execute(args),
      (error) => error?.code === code && error?.status === 400,
    );
  }
  assert.equal(fetchCount, 0);
});

test('OpenRouter execute preserves a zero ceiling and promotes quote_id to the wire top level', async () => {
  const calls = [];
  const client = new AgoragenticClient({
    baseUrl: 'https://agoragentic.example/',
    apiKey: 'test-key',
    fetchImpl: recordingFetch(calls),
  });

  await client.execute({ task: 'zero ceiling', constraints: { max_cost: 0 } });
  await client.execute({ task: 'quoted', constraints: { quote_id: ' quote-123 ', category: 'research' } });

  const zeroBody = JSON.parse(calls[0].init.body);
  assert.equal(calls[0].url.pathname, '/api/execute');
  assert.equal(calls[0].init.method, 'POST');
  assert.equal(zeroBody.constraints.max_cost, 0);

  const quoteBody = JSON.parse(calls[1].init.body);
  assert.equal(quoteBody.quote_id, 'quote-123');
  assert.equal(Object.hasOwn(quoteBody.constraints, 'quote_id'), false);
  assert.equal(quoteBody.constraints.category, 'research');
});

test('pinned OpenRouter agent tools keep approval and enforce bounds behaviorally', async () => {
  const calls = [];
  const client = new AgoragenticClient({
    baseUrl: 'https://agoragentic.example/',
    apiKey: 'test-key',
    fetchImpl: recordingFetch(calls),
  });
  const tools = createAgoragenticOpenRouterTools({ client });
  const execute = tools.execute.function;

  assert.equal(execute.requireApproval, true);
  assert.equal(execute.inputSchema.safeParse({ task: 'missing', constraints: {} }).success, false);
  assert.equal(execute.inputSchema.safeParse({ task: 'nan', constraints: { max_cost: Number.NaN } }).success, false);
  assert.equal(execute.inputSchema.safeParse({ task: 'infinity', constraints: { max_cost: Number.POSITIVE_INFINITY } }).success, false);
  assert.equal(tools.match.function.inputSchema.safeParse({ task: 'strict', constraints: { unsupported: true } }).success, false);

  const parsed = execute.inputSchema.parse({ task: 'bounded', constraints: { max_cost: 0 } });
  await execute.execute(parsed);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url.pathname, '/api/execute');
  assert.equal(JSON.parse(calls[0].init.body).constraints.max_cost, 0);
});

test('pinned Codebuff tools remain read-only and use the live methods and paths', async () => {
  const calls = [];
  const tools = createAgoragenticCodebuffTools({
    baseUrl: 'https://agoragentic.example/',
    apiKey: 'test-key',
    fetchImpl: recordingFetch(calls),
  });

  await tools.match.execute({ task: 'match', constraints: { max_cost: 0, max_latency_ms: 50 } });
  await tools.quote.execute({ task: 'quote', constraints: { category: 'research', payment_network: 'base' } });
  await tools.status.execute({ invocationId: 'inv/a' });
  await tools.receipt.execute({ invocationId: 'inv/a' });

  assert.deepEqual(tools.all.map((tool) => tool.toolName), [
    'agoragentic_match',
    'agoragentic_quote',
    'agoragentic_status',
    'agoragentic_receipt',
  ]);
  assert.equal(Object.hasOwn(tools, 'execute'), false);
  assert.equal(calls[0].url.pathname, '/api/execute/match');
  assert.equal(calls[0].url.searchParams.get('max_cost'), '0');
  assert.equal(calls[0].url.searchParams.get('max_latency_ms'), '50');
  assert.equal(calls[1].url.pathname, '/api/execute/match');
  assert.equal(calls[1].url.searchParams.get('category'), 'research');
  assert.equal(calls[1].url.searchParams.get('payment_network'), 'base');
  assert.equal(calls[2].url.pathname, '/api/execute/status/inv%2Fa');
  assert.equal(calls[3].url.pathname, '/api/commerce/receipts/inv%2Fa');
  for (const call of calls) {
    assert.equal(call.init.method ?? 'GET', 'GET');
    assert.equal(call.init.body, undefined);
  }
});

test('Oration normalizes base URLs and auto-selects each supported credential scheme', async () => {
  const apiKeyCalls = [];
  const bearerCalls = [];
  const noSlash = new OrationClient({
    baseUrl: 'https://oration.example/api/v2',
    apiKey: 'api-key',
    workspaceId: 'workspace-id',
    token: 'also-present',
    fetchImpl: recordingFetch(apiKeyCalls),
  });
  const withSlash = new OrationClient({
    baseUrl: 'https://oration.example/api/v2/',
    token: 'bearer-token',
    fetchImpl: recordingFetch(bearerCalls),
  });

  await noSlash.getConversation('conversation-a');
  await withSlash.getConversation('conversation-b');

  assert.equal(apiKeyCalls[0].url.pathname, '/api/v2/conversations/conversation-a');
  assert.equal(apiKeyCalls[0].init.headers['x-api-key'], 'api-key');
  assert.equal(apiKeyCalls[0].init.headers['x-workspace-id'], 'workspace-id');
  assert.equal(apiKeyCalls[0].init.headers.Authorization, undefined);
  assert.equal(bearerCalls[0].url.pathname, '/api/v2/conversations/conversation-b');
  assert.equal(bearerCalls[0].init.headers.Authorization, 'Bearer bearer-token');
});

test('Oration validates conversation types and authority gates before network use', { concurrency: false }, async () => {
  await withEnvironment({
    ORATION_ENABLE_CREATE: 'true',
    ORATION_ENABLE_TELEPHONY: undefined,
    ORATION_ALLOW_IGNORE_DND: undefined,
  }, async () => {
    const calls = [];
    const client = new OrationClient({
      baseUrl: 'https://oration.example/api/v2',
      apiKey: 'api-key',
      workspaceId: 'workspace-id',
      fetchImpl: recordingFetch(calls, { created: true }),
    });

    assert.throws(
      () => client.createConversations({ conversations: [{}], ownerApproved: true }),
      (error) => error?.code === 'invalid_conversation_type',
    );
    assert.throws(
      () => client.createConversations({ conversations: [{ conversationType: 'email' }], ownerApproved: true }),
      (error) => error?.code === 'invalid_conversation_type',
    );
    assert.throws(
      () => client.createConversations({ conversations: [{ conversationType: 'telephony' }], ownerApproved: true }),
      (error) => error?.code === 'telephony_not_authorized',
    );
    assert.throws(
      () => client.createConversations({ conversations: [{ conversationType: 'chat', ignoreDND: true }], ownerApproved: true }),
      (error) => error?.code === 'ignore_dnd_not_authorized',
    );
    assert.equal(calls.length, 0);

    await client.createConversations({ conversations: [{ conversationType: 'chat' }], ownerApproved: true });
    assert.equal(calls.length, 1);
    assert.equal(calls[0].url.pathname, '/api/v2/conversations');
    assert.equal(calls[0].init.method, 'POST');
    assert.deepEqual(JSON.parse(calls[0].init.body), { conversations: [{ conversationType: 'chat' }] });
  });
});

test('Oration preserves outcome-unknown semantics for conversation creation network failures', { concurrency: false }, async () => {
  await withEnvironment({ ORATION_ENABLE_CREATE: 'true' }, async () => {
    const client = new OrationClient({
      baseUrl: 'https://oration.example/api/v2',
      token: 'bearer-token',
      fetchImpl: async () => { throw new Error('network failed'); },
    });

    await assert.rejects(
      client.createConversations({ conversations: [{ conversationType: 'web' }], ownerApproved: true }),
      (error) => error?.code === 'conversation_creation_outcome_unknown'
        && error?.retryable === false
        && error?.outcomeUnknown === true
        && error?.reconciliationRequired === true,
    );
  });
});
