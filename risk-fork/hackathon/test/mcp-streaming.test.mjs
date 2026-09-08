import assert from 'node:assert/strict';
import { PassThrough } from 'node:stream';
import test from 'node:test';

import {
  MCP_MAX_MESSAGE_BYTES,
  MCP_MAX_PENDING_MESSAGES,
  MCP_MAX_REQUEST_ID_BYTES,
  MCP_SUPPORTED_PROTOCOL_VERSION,
  RISK_FORK_DEMO_MCP_TOOLS,
  serveStdioMcp,
} from '../src/mcp-server.mjs';
import { createDemoTruth } from '../src/security.mjs';

function streamHarness() {
  const input = new PassThrough({ highWaterMark: 1024 });
  const output = new PassThrough({ highWaterMark: 1024 });
  let text = '';
  output.setEncoding('utf8');
  output.on('data', (chunk) => { text += chunk; });
  return {
    input,
    output,
    text: () => text,
    messages: () => text.trim().split('\n').filter(Boolean).map((line) => JSON.parse(line)),
  };
}

function inertEngine(overrides = {}) {
  return {
    plan() {
      throw new Error('plan was not expected');
    },
    run() {
      throw new Error('run was not expected');
    },
    getReceipt() {
      throw new Error('receipt was not expected');
    },
    abort() {
      return createDemoTruth({
        schema: 'agoragentic.risk-fork.demo-test-abort.v1',
        exit_code: 0,
      });
    },
    ...overrides,
  };
}

test('stdio MCP parses normal fragmented UTF-8 and CRLF messages without changing tools', { timeout: 5_000 }, async (t) => {
  const streams = streamHarness();
  t.after(() => {
    streams.input.destroy();
    streams.output.destroy();
  });
  const serving = serveStdioMcp({ engine: inertEngine(), input: streams.input, output: streams.output });
  const initialize = JSON.stringify({
    jsonrpc: '2.0',
    id: 1,
    method: 'initialize',
    params: { protocolVersion: '2099-client-proposed-α' },
  });
  const toolsList = JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list' });
  const wire = Buffer.from(`${initialize}\r\n${toolsList}\n`, 'utf8');
  for (let offset = 0; offset < wire.length; offset += 3) {
    streams.input.write(wire.subarray(offset, Math.min(offset + 3, wire.length)));
  }
  streams.input.end();
  await serving;

  const messages = streams.messages();
  assert.equal(messages.length, 2);
  assert.equal(messages[0].id, 1);
  assert.equal(messages[0].result.protocolVersion, MCP_SUPPORTED_PROTOCOL_VERSION);
  assert.deepEqual(
    messages[1].result.tools.map((tool) => tool.name),
    RISK_FORK_DEMO_MCP_TOOLS.map((tool) => tool.name),
  );
});

test('stdio MCP scans the effect-bearing envelope and only echoes bounded secret-free request ids', { timeout: 5_000 }, async (t) => {
  const streams = streamHarness();
  t.after(() => {
    streams.input.destroy();
    streams.output.destroy();
  });
  const serving = serveStdioMcp({ engine: inertEngine(), input: streams.input, output: streams.output });
  const boundaryId = 'i'.repeat(MCP_MAX_REQUEST_ID_BYTES);
  const oversizedId = 'i'.repeat(MCP_MAX_REQUEST_ID_BYTES + 1);
  const syntheticSecret = `github_pat_${'E'.repeat(32)}`;
  const privateId = '/tmp/private-demo/request-id';
  const requests = [
    { jsonrpc: '2.0', id: boundaryId, method: 'ping' },
    { jsonrpc: '2.0', id: oversizedId, method: 'ping' },
    { jsonrpc: '2.0', id: syntheticSecret, method: 'ping' },
    { jsonrpc: '2.0', id: privateId, method: 'ping' },
    { jsonrpc: '2.0', id: { nested: true }, method: 'ping' },
    { jsonrpc: '2.0', id: 7, method: 'ping', params: { api_key: syntheticSecret } },
  ];
  streams.input.end(`${requests.map((request) => JSON.stringify(request)).join('\n')}\n`);
  await serving;

  const messages = streams.messages();
  assert.deepEqual(messages[0], { jsonrpc: '2.0', id: boundaryId, result: {} });
  for (const index of [1, 2, 3, 4]) {
    assert.deepEqual(messages[index], {
      jsonrpc: '2.0',
      id: null,
      error: { code: -32600, message: 'Risk Fork demo request rejected' },
    });
  }
  assert.deepEqual(messages[5], {
    jsonrpc: '2.0',
    id: 7,
    error: { code: -32600, message: 'Risk Fork demo request rejected' },
  });
  assert.doesNotMatch(streams.text(), new RegExp(syntheticSecret));
  assert.equal(streams.text().includes(privateId), false);
  assert.equal(streams.text().includes(oversizedId), false);
});

test('stdio MCP erases opaque request metadata before dispatch without weakening effect-bearing scans', { timeout: 5_000 }, async (t) => {
  const streams = streamHarness();
  t.after(() => {
    streams.input.destroy();
    streams.output.destroy();
  });
  const received = [];
  const callbackResults = [];
  const engine = inertEngine({
    run(scenario) {
      received.push({ scenario, argument_count: arguments.length });
      return createDemoTruth({
        schema: 'agoragentic.risk-fork.demo-test-run.v1',
        scenario_id: scenario,
        exit_code: 0,
      });
    },
  });
  const serving = serveStdioMcp({
    engine,
    input: streams.input,
    output: streams.output,
    onResult(result) { callbackResults.push(result); },
  });
  const syntheticSecret = `github_pat_${'P'.repeat(32)}`;
  const windowsPrivatePath = 'C:\\private\\agent-workspace';
  const posixPrivatePath = '/home/private/agent-workspace';
  const remoteUrl = 'https://github.com/example/private-agent.git';
  const callId = 'call_synthetic_demo';
  const threadId = '00000000-0000-4000-8000-000000000001';
  const itemId = 'item_synthetic_demo';
  const codexMetadata = {
    callId,
    threadId,
    itemId,
    progressToken: 0,
    'x-codex-turn-metadata': {
      workspaces: {
        [windowsPrivatePath]: { associated_remote_urls: { origin: remoteUrl } },
        [posixPrivatePath]: { has_changes: true },
      },
    },
    arbitrary_vendor_extension: {
      access_token: syntheticSecret,
      constructor: { prototype: { polluted: true } },
      __proto_marker__: 'must-not-propagate',
    },
  };
  const requests = [
    { jsonrpc: '2.0', id: 31, method: 'tools/list', params: { _meta: codexMetadata } },
    {
      jsonrpc: '2.0',
      id: 32,
      method: 'tools/call',
      params: {
        _meta: codexMetadata,
        name: 'risk_fork_demo_run',
        arguments: { scenario: 'low-read-only' },
      },
    },
  ];
  streams.input.end(`${requests.map((request) => JSON.stringify(request)).join('\n')}\n`);
  await serving;

  const messages = streams.messages();
  assert.deepEqual(
    messages[0].result.tools.map((tool) => tool.name),
    RISK_FORK_DEMO_MCP_TOOLS.map((tool) => tool.name),
  );
  assert.equal(messages[1].result.structuredContent.scenario_id, 'low-read-only');
  assert.deepEqual(received, [{ scenario: 'low-read-only', argument_count: 1 }]);
  assert.equal(callbackResults.length, 1);
  assert.equal(callbackResults[0].scenario_id, 'low-read-only');
  assert.doesNotMatch(streams.text(), new RegExp(syntheticSecret));
  for (const marker of [
    windowsPrivatePath, posixPrivatePath, remoteUrl, callId, threadId, itemId, '__proto_marker__',
  ]) {
    assert.equal(streams.text().includes(marker), false);
    assert.equal(JSON.stringify(received).includes(marker), false);
    assert.equal(JSON.stringify(callbackResults).includes(marker), false);
  }
  assert.equal(Object.prototype.polluted, undefined);
});

test('stdio MCP rejects malformed metadata and metadata aliases without echo', { timeout: 5_000 }, async (t) => {
  const streams = streamHarness();
  t.after(() => {
    streams.input.destroy();
    streams.output.destroy();
  });
  const serving = serveStdioMcp({ engine: inertEngine(), input: streams.input, output: streams.output });
  const syntheticSecret = `github_pat_${'Q'.repeat(32)}`;
  const requests = [
    { jsonrpc: '2.0', id: 41, method: 'tools/list', params: { _meta: null } },
    { jsonrpc: '2.0', id: 42, method: 'tools/list', params: { _meta: 'metadata' } },
    { jsonrpc: '2.0', id: 43, method: 'tools/list', params: { _meta: [] } },
    { jsonrpc: '2.0', id: 44, method: 'tools/list', params: { progressToken: 1 } },
    { jsonrpc: '2.0', id: 45, method: 'tools/list', _meta: { access_token: syntheticSecret } },
    { jsonrpc: '2.0', id: 46, method: 'tools/list', params: { metadata: { access_token: syntheticSecret } } },
    {
      jsonrpc: '2.0',
      id: 47,
      method: 'tools/call',
      params: {
        _meta: { benign_vendor_data: true },
        name: 'risk_fork_demo_plan',
        arguments: { scenario: 'low-read-only', access_token: syntheticSecret },
      },
    },
  ];
  streams.input.end(`${requests.map((request) => JSON.stringify(request)).join('\n')}\n`);
  await serving;

  const messages = streams.messages();
  assert.equal(messages.length, requests.length);
  for (let index = 0; index < messages.length; index += 1) {
    assert.deepEqual(messages[index], {
      jsonrpc: '2.0',
      id: 41 + index,
      error: { code: -32600, message: 'Risk Fork demo request rejected' },
    });
  }
  assert.doesNotMatch(streams.text(), new RegExp(syntheticSecret));
});

test('stdio MCP rejects and closes exactly when a no-newline message reaches 64 KiB plus one', { timeout: 5_000 }, async (t) => {
  const streams = streamHarness();
  t.after(() => streams.output.destroy());
  let abortCalls = 0;
  const engine = inertEngine({
    abort() {
      abortCalls += 1;
      return createDemoTruth({
        schema: 'agoragentic.risk-fork.demo-test-abort.v1',
        exit_code: 0,
      });
    },
  });
  const serving = serveStdioMcp({ engine, input: streams.input, output: streams.output });
  const syntheticSecret = `sk-proj-${'A'.repeat(40)}`;
  const prefix = Buffer.from(syntheticSecret, 'utf8');
  streams.input.write(prefix);
  let remaining = MCP_MAX_MESSAGE_BYTES - prefix.length;
  while (remaining > 0) {
    const length = Math.min(4096, remaining);
    streams.input.write(Buffer.alloc(length, 0x78));
    remaining -= length;
  }
  assert.equal(streams.text(), '');
  streams.input.write(Buffer.from('!'));
  await serving;

  assert.equal(streams.input.destroyed, true);
  assert.equal(abortCalls, 1);
  assert.deepEqual(streams.messages(), [{
    jsonrpc: '2.0',
    id: null,
    error: { code: -32600, message: 'Invalid request' },
  }]);
  assert.doesNotMatch(streams.text(), new RegExp(syntheticSecret));
  assert.ok(Buffer.byteLength(streams.text(), 'utf8') < 1024);
});

test('stdio MCP bounds pending requests during an active tool call and aborts on overflow', { timeout: 5_000 }, async (t) => {
  const streams = streamHarness();
  t.after(() => streams.output.destroy());
  let releaseRun;
  let runStarted;
  const started = new Promise((resolve) => { runStarted = resolve; });
  let abortCalls = 0;
  const engine = inertEngine({
    run() {
      runStarted();
      return new Promise((resolve) => { releaseRun = resolve; });
    },
    abort() {
      abortCalls += 1;
      releaseRun(createDemoTruth({
        schema: 'agoragentic.risk-fork.demo-test-run.v1',
        run_id: 'run_streaming_test',
        exit_code: 2,
      }));
      return createDemoTruth({
        schema: 'agoragentic.risk-fork.demo-test-abort.v1',
        exit_code: 0,
      });
    },
  });
  const serving = serveStdioMcp({ engine, input: streams.input, output: streams.output });
  streams.input.write(`${JSON.stringify({
    jsonrpc: '2.0',
    id: 1,
    method: 'tools/call',
    params: {
      name: 'risk_fork_demo_run',
      arguments: { scenario: 'high-filesystem-write' },
    },
  })}\n`);
  await started;

  const queued = [];
  for (let index = 0; index <= MCP_MAX_PENDING_MESSAGES; index += 1) {
    queued.push(JSON.stringify({ jsonrpc: '2.0', id: 10 + index, method: 'ping' }));
  }
  streams.input.write(`${queued.join('\n')}\n`);
  await serving;

  assert.equal(streams.input.destroyed, true);
  assert.equal(abortCalls, 1);
  assert.deepEqual(streams.messages(), [{
    jsonrpc: '2.0',
    id: null,
    error: { code: -32600, message: 'Invalid request' },
  }]);
});

test('stdio MCP input errors abort active work, reject constantly, and suppress late output', { timeout: 5_000 }, async (t) => {
  const streams = streamHarness();
  t.after(() => streams.output.destroy());
  let releaseRun;
  let runStarted;
  const started = new Promise((resolve) => { runStarted = resolve; });
  let abortCalls = 0;
  const engine = inertEngine({
    run() {
      runStarted();
      return new Promise((resolve) => { releaseRun = resolve; });
    },
    abort() {
      abortCalls += 1;
      releaseRun(createDemoTruth({
        schema: 'agoragentic.risk-fork.demo-test-run.v1',
        run_id: 'run_stream_error_test',
        exit_code: 2,
      }));
      return createDemoTruth({
        schema: 'agoragentic.risk-fork.demo-test-abort.v1',
        exit_code: 0,
      });
    },
  });
  const serving = serveStdioMcp({ engine, input: streams.input, output: streams.output });
  streams.input.write(`${JSON.stringify({
    jsonrpc: '2.0',
    id: 21,
    method: 'tools/call',
    params: {
      name: 'risk_fork_demo_run',
      arguments: { scenario: 'high-filesystem-write' },
    },
  })}\n`);
  await started;

  const syntheticSecret = `sk-proj-${'C'.repeat(40)}`;
  streams.input.destroy(new Error(`synthetic stream failure ${syntheticSecret}`));
  await assert.rejects(serving, (error) => (
    error?.code === 'MCP_INPUT_STREAM_FAILED'
    && error.message === 'MCP input stream failed'
    && !error.message.includes(syntheticSecret)
  ));
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(streams.input.destroyed, true);
  assert.equal(abortCalls, 1);
  assert.equal(streams.text(), '');
  assert.doesNotMatch(streams.text(), new RegExp(syntheticSecret));
});

test('stdio MCP unexpected close aborts exactly once, rejects, and suppresses late output without hanging', { timeout: 5_000 }, async (t) => {
  const streams = streamHarness();
  t.after(() => streams.output.destroy());
  let releaseRun;
  let runStarted;
  const started = new Promise((resolve) => { runStarted = resolve; });
  let abortCalls = 0;
  const engine = inertEngine({
    run() {
      runStarted();
      return new Promise((resolve) => { releaseRun = resolve; });
    },
    abort() {
      abortCalls += 1;
      return createDemoTruth({
        schema: 'agoragentic.risk-fork.demo-test-abort.v1',
        exit_code: 0,
      });
    },
  });
  const serving = serveStdioMcp({ engine, input: streams.input, output: streams.output });
  streams.input.write(`${JSON.stringify({
    jsonrpc: '2.0',
    id: 23,
    method: 'tools/call',
    params: {
      name: 'risk_fork_demo_run',
      arguments: { scenario: 'high-filesystem-write' },
    },
  })}\n`);
  await started;

  streams.input.destroy();
  await assert.rejects(serving, (error) => (
    error?.code === 'MCP_INPUT_STREAM_CLOSED'
    && error.message === 'MCP input stream closed unexpectedly'
  ));
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(abortCalls, 1);
  assert.equal(streams.text(), '');

  releaseRun(createDemoTruth({
    schema: 'agoragentic.risk-fork.demo-test-run.v1',
    run_id: 'run_late_close_test',
    exit_code: 2,
  }));
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(streams.text(), '');
});

test('stdio MCP non-byte chunks abort active work with one bounded no-echo response', { timeout: 5_000 }, async (t) => {
  const streams = streamHarness();
  t.after(() => streams.output.destroy());
  let releaseRun;
  let runStarted;
  const started = new Promise((resolve) => { runStarted = resolve; });
  let abortCalls = 0;
  const engine = inertEngine({
    run() {
      runStarted();
      return new Promise((resolve) => { releaseRun = resolve; });
    },
    abort() {
      abortCalls += 1;
      releaseRun(createDemoTruth({
        schema: 'agoragentic.risk-fork.demo-test-run.v1',
        run_id: 'run_non_byte_test',
        exit_code: 2,
      }));
      return createDemoTruth({
        schema: 'agoragentic.risk-fork.demo-test-abort.v1',
        exit_code: 0,
      });
    },
  });
  const serving = serveStdioMcp({ engine, input: streams.input, output: streams.output });
  streams.input.write(`${JSON.stringify({
    jsonrpc: '2.0',
    id: 22,
    method: 'tools/call',
    params: {
      name: 'risk_fork_demo_run',
      arguments: { scenario: 'high-filesystem-write' },
    },
  })}\n`);
  await started;

  const syntheticSecret = `github_pat_${'D'.repeat(32)}`;
  streams.input.emit('data', { api_key: syntheticSecret });
  await serving;

  assert.equal(streams.input.destroyed, true);
  assert.equal(abortCalls, 1);
  assert.deepEqual(streams.messages(), [{
    jsonrpc: '2.0',
    id: null,
    error: { code: -32600, message: 'Invalid request' },
  }]);
  assert.doesNotMatch(streams.text(), new RegExp(syntheticSecret));
  assert.ok(Buffer.byteLength(streams.text(), 'utf8') < 1024);
});

test('stdio MCP rejection never echoes secret-shaped arguments', { timeout: 5_000 }, async (t) => {
  const streams = streamHarness();
  t.after(() => {
    streams.input.destroy();
    streams.output.destroy();
  });
  const serving = serveStdioMcp({ engine: inertEngine(), input: streams.input, output: streams.output });
  const syntheticSecret = `github_pat_${'B'.repeat(32)}`;
  streams.input.end(`${JSON.stringify({
    jsonrpc: '2.0',
    id: 9,
    method: 'tools/call',
    params: {
      name: 'risk_fork_demo_plan',
      arguments: {
        scenario: 'high-filesystem-write',
        api_key: syntheticSecret,
      },
    },
  })}\n`);
  await serving;

  assert.deepEqual(streams.messages(), [{
    jsonrpc: '2.0',
    id: 9,
    error: { code: -32600, message: 'Risk Fork demo request rejected' },
  }]);
  assert.doesNotMatch(streams.text(), new RegExp(syntheticSecret));
});
