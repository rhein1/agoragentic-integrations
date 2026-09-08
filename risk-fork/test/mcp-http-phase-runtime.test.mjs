import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { runRunnerJob } from '../e2b-template/bin/run.mjs';
import {
  createMcpHttpPhaseRuntime,
  dispatchMcpHttpPhase,
  isMcpHttpPhaseRuntime,
  parseBoundedMcpJson,
  resolvePublicMcpDestination,
} from '../e2b-template/lib/mcp-http-phase.mjs';
import { sha256Ref } from '../src/canonical.mjs';
import {
  createMcpDestinationPolicy,
  createMcpTransportResultSchema,
  createMcpWireHeaders,
  createMcpWireParams,
  validateMcpHttpPhaseOperation,
  validateMcpToolHeaderAnnotations,
  verifyMcpTransportResult,
} from '../src/mcp-transport-contract.mjs';

const ENDPOINT = 'https://mcp.public-example.net/rpc';
const PUBLIC_IPV4 = '104.18.6.229';
const PUBLIC_IPV6 = '2606:4700::6812:7e5';

function makeOperation(overrides = {}) {
  const phase = overrides.phase ?? 'tools/list';
  const params = overrides.params ?? (phase === 'tools/call'
    ? { name: 'read_public_data', arguments: { key: 'bounded' } }
    : phase === 'server/discover'
      ? { protocol_version: '2026-07-28', stateless_required: true }
      : {});
  const toolName = phase === 'tools/call' ? params.name : null;
  const toolDescriptor = phase === 'tools/call'
    ? overrides.tool_descriptor ?? {
        name: toolName,
        inputSchema: {
          type: 'object',
          properties: { key: { type: 'string' } },
        },
      }
    : null;
  const toolDescriptorHash = phase === 'tools/call' ? sha256Ref(toolDescriptor) : null;
  const toolInputSchema = phase === 'tools/call' ? toolDescriptor.inputSchema : null;
  const toolInputSchemaHash = phase === 'tools/call' ? sha256Ref(toolInputSchema) : null;
  const toolEffectStatus = phase === 'tools/call' ? 'explicit_read_only' : null;
  const toolSafetyBindingHash = phase === 'tools/call' ? sha256Ref({
    tool_name: toolName,
    tool_descriptor_hash: toolDescriptorHash,
    effect: toolEffectStatus,
  }) : null;
  const mcpResultSchema = phase === 'tools/list'
    ? {
        type: 'object',
        additionalProperties: false,
        required: ['tools'],
        properties: { tools: { type: 'array', maxItems: 10 } },
      }
    : { type: 'object' };
  const destinationPolicy = createMcpDestinationPolicy({
    href: ENDPOINT,
    origin: new URL(ENDPOINT).origin,
  });
  const responseSchema = createMcpTransportResultSchema(mcpResultSchema);
  const operation = {
    schema: 'agoragentic.risk-fork.mcp-child-operation.v1',
    kind: 'mcp_http_phase',
    mcp_request_hash: sha256Ref(`request:${phase}`),
    phase,
    mcp_server_ref: ENDPOINT,
    mcp_server_origin: new URL(ENDPOINT).origin,
    tool_name: toolName,
    tool_descriptor_hash: toolDescriptorHash,
    tool_input_schema: toolInputSchema,
    tool_input_schema_hash: toolInputSchemaHash,
    tool_effect_status: toolEffectStatus,
    tool_safety_binding_hash: toolSafetyBindingHash,
    params,
    protocol_version: '2026-07-28',
    destination_policy: destinationPolicy,
    redirects: 'error',
    response_mode: 'json_or_sse',
    mcp_result_schema: mcpResultSchema,
    mcp_result_schema_hash: sha256Ref(mcpResultSchema),
    response_schema: responseSchema,
    response_schema_hash: sha256Ref(responseSchema),
    max_response_bytes: 64 * 1024,
    timeout_ms: 5_000,
    operation_hash: null,
    ...overrides,
  };
  delete operation.tool_descriptor;
  operation.operation_hash = sha256Ref({ ...operation, operation_hash: null });
  return operation;
}

function monotonicClock() {
  let current = 0;
  return () => {
    current += 1;
    return current;
  };
}

function publicResolvers(overrides = {}) {
  return {
    resolve4: async () => [PUBLIC_IPV4],
    resolve6: async () => [PUBLIC_IPV6],
    resolveCname: async () => [],
    ...overrides,
  };
}

function createHttpsHarness(config = {}) {
  const state = { bodies: [], calls: [], lookups: [] };
  function httpsRequest(options, onResponse) {
    state.calls.push(options);
    const request = new EventEmitter();
    request.destroy = (error) => queueMicrotask(() => request.emit('error', error));
    request.end = (body) => {
      const requestBytes = Buffer.from(body);
      state.bodies.push(requestBytes);
      options.lookup(options.hostname, { family: options.family }, (lookupError, address, family) => {
        state.lookups.push({ hostname: options.hostname, address, family, lookupError });
        if (lookupError) {
          queueMicrotask(() => request.emit('error', lookupError));
          return;
        }
        const socket = new EventEmitter();
        socket.authorized = config.tlsAuthorized ?? true;
        socket.authorizationError = socket.authorized ? null : 'certificate rejected';
        socket.remoteAddress = config.remoteAddress ?? address;
        socket.servername = config.servername ?? options.servername;
        socket.getProtocol = () => config.tlsProtocol ?? 'TLSv1.3';
        socket.setNoDelay = () => {};
        queueMicrotask(() => {
          request.emit('socket', socket);
          queueMicrotask(() => {
            socket.emit('secureConnect');
            const requestEnvelope = JSON.parse(requestBytes.toString('utf8'));
            const defaultBody = JSON.stringify({
              jsonrpc: '2.0',
              id: requestEnvelope.id,
              result: config.result ?? { resultType: 'complete', tools: [] },
            });
            const configuredBody = typeof config.body === 'function'
              ? config.body(requestEnvelope)
              : config.body ?? defaultBody;
            const configuredChunks = typeof config.responseChunks === 'function'
              ? config.responseChunks(requestEnvelope)
              : config.responseChunks;
            const responseChunks = configuredChunks
              ? configuredChunks.map((chunk) => Buffer.from(chunk, 'utf8'))
              : [Buffer.from(configuredBody, 'utf8')];
            const responseBody = Buffer.concat(responseChunks);
            const response = new EventEmitter();
            response.statusCode = config.statusCode ?? 200;
            response.complete = true;
            response.trailers = {};
            response.rawTrailers = [];
            response.headers = {
              'content-type': 'application/json; charset=utf-8',
              'content-length': String(responseBody.byteLength),
              ...(config.headers ?? {}),
            };
            response.resume = () => {};
            response.destroy = () => {};
            onResponse(response);
            queueMicrotask(() => {
              for (const chunk of responseChunks) response.emit('data', chunk);
              response.emit('end');
            });
          });
        });
      });
    };
    return request;
  }
  return { httpsRequest, state };
}

function makeRuntime(harness, resolverOverrides = {}) {
  return createMcpHttpPhaseRuntime({
    ...publicResolvers(resolverOverrides),
    httpsRequest: harness.httpsRequest,
    monotonicNow: monotonicClock(),
  });
}

test('package subpaths expose the shared contract and the same opaque runtime brand', async () => {
  const runtimeSubpath = await import(
    '@agoragentic/risk-fork/e2b-template/mcp-http-phase'
  );
  const contractSubpath = await import('@agoragentic/risk-fork/mcp-transport-contract');
  assert.equal(runtimeSubpath.createMcpHttpPhaseRuntime, createMcpHttpPhaseRuntime);
  assert.equal(runtimeSubpath.isMcpHttpPhaseRuntime, isMcpHttpPhaseRuntime);
  assert.equal(contractSubpath.validateMcpHttpPhaseOperation, validateMcpHttpPhaseOperation);
  const branded = runtimeSubpath.createMcpHttpPhaseRuntime({
    ...publicResolvers(),
    httpsRequest: createHttpsHarness().httpsRequest,
    monotonicNow: monotonicClock(),
  });
  assert.equal(runtimeSubpath.isMcpHttpPhaseRuntime(branded), true);
});

test('shared DNS contract follows bounded CNAMEs and rejects every non-public answer', async () => {
  const calls = [];
  const resolution = await resolvePublicMcpDestination('mcp.public-example.net', {
    resolve4: async (name) => {
      calls.push(['A', name]);
      return name === 'edge.public-example.net' ? [PUBLIC_IPV4] : [];
    },
    resolve6: async (name) => {
      calls.push(['AAAA', name]);
      return name === 'edge.public-example.net' ? [PUBLIC_IPV6] : [];
    },
    resolveCname: async (name) => {
      calls.push(['CNAME', name]);
      return name === 'mcp.public-example.net' ? ['edge.public-example.net.'] : [];
    },
  });
  assert.deepEqual(resolution, {
    dns_name: 'mcp.public-example.net',
    cname_chain: ['mcp.public-example.net', 'edge.public-example.net'],
    resolved_addresses: [PUBLIC_IPV4, PUBLIC_IPV6],
    selected_address: PUBLIC_IPV4,
    dns_query_count: 6,
  });
  assert.equal(calls.length, 6);

  for (const unsafeAddress of [
    '127.0.0.1',
    '169.254.169.254',
    '10.0.0.1',
    '::1',
    '::ffff:127.0.0.1',
    'fc00::1',
    'fe80::1',
    '2001:db8::1',
  ]) {
    await assert.rejects(
      resolvePublicMcpDestination('mcp.public-example.net', publicResolvers({
        resolve4: async () => isNaN(Number(unsafeAddress.split('.')[0]))
          ? [PUBLIC_IPV4]
          : [PUBLIC_IPV4, unsafeAddress],
        resolve6: async () => unsafeAddress.includes(':')
          ? [PUBLIC_IPV6, unsafeAddress]
          : [PUBLIC_IPV6],
      })),
      /public unicast/i,
      unsafeAddress,
    );
  }
});

test('one phase performs one pinned direct Node HTTPS request and returns typed evidence', async (t) => {
  const harness = createHttpsHarness();
  const runtime = makeRuntime(harness);
  assert.equal(isMcpHttpPhaseRuntime(runtime), true);
  assert.equal(isMcpHttpPhaseRuntime(async () => {}), false);
  assert.throws(
    () => dispatchMcpHttpPhase(async () => {}, makeOperation()),
    /opaque runtime capability/i,
  );

  const operation = validateMcpHttpPhaseOperation(makeOperation());
  const payload = await dispatchMcpHttpPhase(runtime, operation);
  assert.equal(harness.state.calls.length, 1);
  assert.equal(harness.state.lookups.length, 1);
  assert.deepEqual(harness.state.lookups[0], {
    hostname: 'mcp.public-example.net',
    address: PUBLIC_IPV4,
    family: 4,
    lookupError: null,
  });
  const options = harness.state.calls[0];
  assert.equal(options.protocol, 'https:');
  assert.equal(options.hostname, 'mcp.public-example.net');
  assert.equal(options.path, '/rpc');
  assert.equal(options.method, 'POST');
  assert.equal(options.agent, false);
  assert.equal(options.autoSelectFamily, false);
  assert.equal(options.rejectUnauthorized, true);
  assert.equal(options.servername, 'mcp.public-example.net');
  assert.equal(options.headers.Host, 'mcp.public-example.net');
  assert.equal(options.headers.Accept, 'application/json, text/event-stream');
  assert.equal(options.headers['MCP-Protocol-Version'], '2026-07-28');
  assert.equal(options.headers['Mcp-Method'], 'tools/list');
  assert.equal(Object.hasOwn(options.headers, 'Mcp-Name'), false);
  assert.equal(options.headers.Connection, 'close');
  const loweredHeaders = Object.keys(options.headers).map((name) => name.toLowerCase());
  assert.equal(loweredHeaders.includes('authorization'), false);
  assert.equal(loweredHeaders.includes('proxy-authorization'), false);
  assert.equal(loweredHeaders.includes('cookie'), false);
  assert.equal(loweredHeaders.includes('mcp-session-id'), false);
  assert.equal(loweredHeaders.includes('accept-encoding'), false);
  assert.deepEqual(JSON.parse(harness.state.bodies[0].toString('utf8')), {
    jsonrpc: '2.0',
    id: operation.mcp_request_hash,
    method: 'tools/list',
    params: {
      _meta: {
        'io.modelcontextprotocol/clientCapabilities': {},
        'io.modelcontextprotocol/clientInfo': {
          name: '@agoragentic/risk-fork',
          version: '0.1.0-alpha.1',
        },
        'io.modelcontextprotocol/protocolVersion': '2026-07-28',
      },
    },
  });
  assert.deepEqual(verifyMcpTransportResult(payload, operation), { tools: [] });
  assert.equal(payload.transport_evidence.selected_address, PUBLIC_IPV4);
  assert.equal(payload.transport_evidence.tls_server_name, 'mcp.public-example.net');
  assert.equal(payload.transport_evidence.http_host, 'mcp.public-example.net');
  assert.deepEqual(payload.transport_evidence.measurements, {
    dns_query_count: 3,
    connection_attempt_count: 1,
    http_request_count: 1,
    retry_count: 0,
    request_body_bytes: harness.state.bodies[0].byteLength,
    response_body_bytes: payload.transport_evidence.measurements.response_body_bytes,
    elapsed_ms: 4,
    http_status_code: 200,
    tls_protocol: 'TLSv1.3',
    response_content_type: 'application/json',
    response_content_encoding: null,
    decompression_used: false,
    sse_used: false,
    sse_event_count: 0,
    sse_notification_count: 0,
    protocol_metadata_sent: true,
    method_header_sent: true,
    name_header_sent: false,
    parameter_header_count: 0,
    access_header_sent: false,
    cookie_header_sent: false,
    state_header_sent: false,
    response_cookie_received: false,
    response_state_created: false,
    access_challenge_received: false,
  });

  const source = await readFile(
    new URL('../e2b-template/lib/mcp-http-phase.mjs', import.meta.url),
    'utf8',
  );
  assert.match(source, /from 'node:https'/);
  assert.match(source, /agent:\s*false/);
  assert.doesNotMatch(source, /\bfetch\s*\(/);
  assert.doesNotMatch(source, /\bundici\b/i);
  assert.doesNotMatch(source, /HTTPS?_PROXY|ALL_PROXY/i);
  assert.doesNotMatch(source, /\.unref\s*\(/);
  assert.ok(payload.transport_evidence.measurements.response_body_bytes > 0);
});

test('all bounded methods carry self-describing 2026 headers and host-owned metadata', async () => {
  const cases = [
    ['server/discover', { protocol_version: '2026-07-28', stateless_required: true }, null,
      { resultType: 'complete', supportedVersions: ['2026-07-28'], capabilities: {} }],
    ['tools/list', {}, null, { resultType: 'complete', tools: [] }],
    ['tools/call', {
      name: 'read_public_data',
      arguments: { greeting: 'Hello, 世界', options: { count: 42 } },
    }, 'read_public_data', { resultType: 'complete', content: [], isError: false }],
    ['resources/list', {}, null, { resultType: 'complete', resources: [] }],
    ['resources/read', { uri: 'https://public-example.net/readme' },
      'https://public-example.net/readme', { resultType: 'complete', contents: [] }],
    ['prompts/list', {}, null, { resultType: 'complete', prompts: [] }],
    ['prompts/get', { name: 'bounded_prompt', arguments: {} }, 'bounded_prompt',
      { resultType: 'complete', messages: [] }],
  ];
  for (const [phase, params, expectedName, result] of cases) {
    const toolDescriptor = phase === 'tools/call'
      ? {
          name: params.name,
          inputSchema: {
            type: 'object',
            properties: {
              greeting: { type: 'string', 'x-mcp-header': 'Greeting' },
              options: {
                type: 'object',
                properties: {
                  count: { type: 'integer', 'x-mcp-header': 'Count' },
                },
              },
            },
          },
        }
      : null;
    const operation = makeOperation({ phase, params, tool_descriptor: toolDescriptor });
    const harness = createHttpsHarness({ result });
    const payload = await makeRuntime(harness)(operation);
    const options = harness.state.calls[0];
    const envelope = JSON.parse(harness.state.bodies[0].toString('utf8'));
    assert.equal(options.headers.Accept, 'application/json, text/event-stream', phase);
    assert.equal(options.headers['MCP-Protocol-Version'], '2026-07-28', phase);
    assert.equal(options.headers['Mcp-Method'], phase, phase);
    assert.equal(
      options.headers['Mcp-Name'] ?? null,
      expectedName,
      phase,
    );
    assert.deepEqual(envelope.params._meta, {
      'io.modelcontextprotocol/clientCapabilities': {},
      'io.modelcontextprotocol/clientInfo': {
        name: '@agoragentic/risk-fork',
        version: '0.1.0-alpha.1',
      },
      'io.modelcontextprotocol/protocolVersion': '2026-07-28',
    }, phase);
    if (phase === 'server/discover') {
      assert.deepEqual(Object.keys(envelope.params), ['_meta']);
      assert.deepEqual(payload.mcp_result, {
        protocol_version: '2026-07-28',
        stateless: true,
      });
    }
    if (phase === 'tools/call') {
      assert.equal(
        options.headers['Mcp-Param-Greeting'],
        `=?base64?${Buffer.from('Hello, 世界').toString('base64')}?=`,
      );
      assert.equal(options.headers['Mcp-Param-Count'], '42');
      assert.equal(payload.transport_evidence.measurements.parameter_header_count, 2);
    }
  }
});

test('Mcp-Name uses the required Base64 sentinel encoding and rejects unsafe header schemas', () => {
  const encodedName = makeOperation({
    phase: 'prompts/get',
    params: { name: ' padded ', arguments: {} },
  });
  assert.equal(
    createMcpWireHeaders(encodedName)['Mcp-Name'],
    `=?base64?${Buffer.from(' padded ').toString('base64')}?=`,
  );
  assert.equal(
    createMcpWireParams(encodedName)._meta['io.modelcontextprotocol/protocolVersion'],
    '2026-07-28',
  );

  const invalidDescriptor = {
    name: 'read_public_data',
    inputSchema: {
      type: 'object',
      oneOf: [{
        type: 'object',
        properties: { region: { type: 'string', 'x-mcp-header': 'Region' } },
      }],
    },
  };
  assert.throws(
    () => createMcpWireHeaders(makeOperation({
      phase: 'tools/call',
      tool_descriptor: invalidDescriptor,
    })),
    /statically reachable/i,
  );
  assert.throws(
    () => validateMcpToolHeaderAnnotations(invalidDescriptor.inputSchema),
    /statically reachable/i,
  );
});

test('tools/list excludes every invalid x-mcp-header tool and retains valid siblings', async () => {
  const validTool = {
    name: 'valid_tool',
    inputSchema: {
      type: 'object',
      properties: {
        region: { type: 'string', 'x-mcp-header': 'Region' },
      },
    },
  };
  const invalidTools = [
    {
      name: 'unreachable_annotation',
      inputSchema: {
        type: 'object',
        oneOf: [{
          type: 'object',
          properties: {
            region: { type: 'string', 'x-mcp-header': 'Region' },
          },
        }],
      },
    },
    {
      name: 'duplicate_annotation',
      inputSchema: {
        type: 'object',
        properties: {
          region: { type: 'string', 'x-mcp-header': 'Tenant' },
          tenant: { type: 'string', 'x-mcp-header': 'tenant' },
        },
      },
    },
    {
      name: 'invalid_header_token',
      inputSchema: {
        type: 'object',
        properties: {
          region: { type: 'string', 'x-mcp-header': 'bad header' },
        },
      },
    },
    {
      name: 'nonprimitive_annotation',
      inputSchema: {
        type: 'object',
        properties: {
          region: { type: 'object', 'x-mcp-header': 'Region' },
        },
      },
    },
  ];
  const harness = createHttpsHarness({
    result: { resultType: 'complete', tools: [validTool, ...invalidTools] },
  });
  const payload = await makeRuntime(harness)(makeOperation());
  assert.deepEqual(payload.mcp_result, { tools: [validTool] });
  assert.notEqual(
    payload.transport_evidence.wire_result_hash,
    sha256Ref({ resultType: 'complete', tools: [validTool] }),
  );
});

test('bounded fragmented SSE accepts comments and exactly one final response', async () => {
  const harness = createHttpsHarness({
    headers: { 'content-type': 'text/event-stream; charset=utf-8' },
    responseChunks: (request) => {
      const body = [
        ': keepalive\r\n\r\n',
        `data: ${JSON.stringify({
          jsonrpc: '2.0',
          id: request.id,
          result: { resultType: 'complete', tools: [] },
        })}\r\n\r\n`,
      ].join('');
      return [body.slice(0, 7), body.slice(7, 43), body.slice(43)];
    },
  });
  const operation = makeOperation();
  const payload = await makeRuntime(harness)(operation);
  assert.deepEqual(payload.mcp_result, { tools: [] });
  assert.equal(payload.transport_evidence.measurements.response_content_type, 'text/event-stream');
  assert.equal(payload.transport_evidence.measurements.sse_used, true);
  assert.equal(payload.transport_evidence.measurements.sse_event_count, 1);
  assert.equal(payload.transport_evidence.measurements.sse_notification_count, 0);
  assert.match(payload.transport_evidence.response_body_hash, /^sha256:[a-f0-9]{64}$/);
  assert.match(payload.transport_evidence.wire_result_hash, /^sha256:[a-f0-9]{64}$/);
});

test('modern resultType and SSE failures stop without retry', async (t) => {
  for (const [name, config, pattern] of [
    ['missing resultType', { result: { tools: [] } }, /resultType complete/i],
    ['input required', { result: { resultType: 'input_required', inputRequests: {} } },
      /no-retry protection profile/i],
    ['task result', { result: { resultType: 'task', task: {} } }, /resultType complete/i],
    ['SSE without a response', {
      headers: { 'content-type': 'text/event-stream' },
      body: ': keepalive\n\n',
    }, /no messages/i],
    ['SSE mismatched final', {
      headers: { 'content-type': 'text/event-stream' },
      body: 'data: {"jsonrpc":"2.0","id":"wrong","result":{"resultType":"complete","tools":[]}}\n\n',
    }, /exact request/i],
    ['SSE retry state', {
      headers: { 'content-type': 'text/event-stream' },
      body: 'retry: 1000\ndata: {}\n\n',
    }, /retry state/i],
    ['unsolicited progress notification', {
      headers: { 'content-type': 'text/event-stream' },
      body: (request) => [
        'data: {"jsonrpc":"2.0","method":"notifications/progress","params":{"progressToken":"unsolicited","progress":1}}\n\n',
        `data: ${JSON.stringify({
          jsonrpc: '2.0',
          id: request.id,
          result: { resultType: 'complete', tools: [] },
        })}\n\n`,
      ].join(''),
    }, /unsolicited notification/i],
    ['unsolicited logging notification', {
      headers: { 'content-type': 'text/event-stream' },
      body: (request) => [
        'data: {"jsonrpc":"2.0","method":"notifications/message","params":{"level":"info","data":"unrequested"}}\n\n',
        `data: ${JSON.stringify({
          jsonrpc: '2.0',
          id: request.id,
          result: { resultType: 'complete', tools: [] },
        })}\n\n`,
      ].join(''),
    }, /unsolicited notification/i],
  ]) {
    await t.test(name, async () => {
      const harness = createHttpsHarness(config);
      await assert.rejects(makeRuntime(harness)(makeOperation()), pattern);
      assert.equal(harness.state.calls.length, 1);
    });
  }
});

test('DNS is resolved immediately for each phase and a changed unsafe answer stops before HTTP', async () => {
  const harness = createHttpsHarness();
  let resolution = 0;
  const runtime = makeRuntime(harness, {
    resolve4: async () => {
      resolution += 1;
      return resolution === 1 ? [PUBLIC_IPV4] : ['127.0.0.1'];
    },
    resolve6: async () => [],
  });
  await runtime(makeOperation());
  await assert.rejects(runtime(makeOperation()), /public unicast/i);
  assert.equal(resolution, 2);
  assert.equal(harness.state.calls.length, 1);
});

test('socket pin, SNI, TLS, and response byte mismatches fail closed after one request', async (t) => {
  for (const [name, config, pattern] of [
    ['remote address', { remoteAddress: '104.18.7.229' }, /pin or TLS identity/i],
    ['SNI', { servername: 'other.public-example.net' }, /pin or TLS identity/i],
    ['TLS protocol', { tlsProtocol: 'TLSv1.1' }, /unsupported TLS protocol/i],
    ['response bound', {
      body: (request) => JSON.stringify({
        jsonrpc: '2.0',
        id: request.id,
        result: { value: 'x'.repeat(2_048) },
      }),
    }, /length exceeds its byte bound/i],
  ]) {
    await t.test(name, async () => {
      const harness = createHttpsHarness(config);
      const runtime = makeRuntime(harness);
      const operation = makeOperation({ max_response_bytes: 1_024 });
      await assert.rejects(runtime(operation), pattern);
      assert.equal(harness.state.calls.length, 1);
      assert.equal(harness.state.bodies.length, 1);
    });
  }
});

test('redirect, decompression, access, cookie, and session responses never retry', async (t) => {
  const cases = [
    ['redirect', { statusCode: 302, headers: { location: 'https://other.public-example.net/rpc' } }],
    ['decompression', { headers: { 'content-encoding': 'gzip' } }],
    ['cookie', { headers: { 'set-cookie': 'sid=opaque' } }],
    ['session', { headers: { 'mcp-session-id': 'opaque' } }],
    ['trailer state', { headers: { trailer: 'mcp-session-id' } }],
    ['access challenge', { statusCode: 401, headers: { 'www-authenticate': 'Basic' } }],
    ['duplicate key', {
      body: (request) => (
        `{"jsonrpc":"2.0","id":${JSON.stringify(request.id)},"result":{},"res\\u0075lt":{}}`
      ),
    }],
  ];
  for (const [name, config] of cases) {
    await t.test(name, async () => {
      const harness = createHttpsHarness(config);
      const runtime = makeRuntime(harness);
      await assert.rejects(runtime(makeOperation()));
      assert.equal(harness.state.calls.length, 1);
      assert.equal(harness.state.bodies.length, 1);
    });
  }
});

test('bounded parser rejects decoded duplicate keys, hostile keys, depth, and non-canonical numbers', () => {
  assert.throws(
    () => parseBoundedMcpJson(Buffer.from('{"name":1,"n\\u0061me":2}')),
    /duplicate object key/i,
  );
  assert.throws(
    () => parseBoundedMcpJson(Buffer.from('{"__proto__":true}')),
    /forbidden object key/i,
  );
  assert.throws(
    () => parseBoundedMcpJson(Buffer.from(`${'['.repeat(34)}0${']'.repeat(34)}`)),
    /depth bound/i,
  );
  assert.throws(
    () => parseBoundedMcpJson(Buffer.from(JSON.stringify('x'.repeat((256 * 1024) + 1)))),
    /string above its byte bound/i,
  );
  assert.throws(
    () => parseBoundedMcpJson(Buffer.from(`[${'0,'.repeat(20_000)}0]`)),
    /node bound/i,
  );
  assert.throws(() => parseBoundedMcpJson(Buffer.from('9007199254740992')), /canonical number/i);
  assert.throws(() => parseBoundedMcpJson(Buffer.from('\ufeff{}')), /byte-order mark/i);
});

test('tools/call remains exact-bound read-only and runner emits its typed measured candidate', async (t) => {
  const unsafe = makeOperation({ phase: 'tools/call' });
  unsafe.tool_effect_status = 'irreversible';
  unsafe.operation_hash = sha256Ref({ ...unsafe, operation_hash: null });
  assert.throws(() => validateMcpHttpPhaseOperation(unsafe), /read-only/i);

  const root = await mkdtemp(path.join(os.tmpdir(), 'risk-fork-mcp-http-runner-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const resultPath = path.join(root, 'result.json');
  const operation = makeOperation();
  const job = {
    schema: 'agoragentic.risk-fork.runner-job.v1',
    job_id: 'rfj_1234567890abcdef',
    parent_state_hash: sha256Ref('parent'),
    capsule_hash: sha256Ref('capsule'),
    identity_hash: sha256Ref('identity'),
    provider_ref: 'provider:source-only-test',
    template_id_hash: sha256Ref('template'),
    mcp_phase: operation.phase,
    mcp_server_ref: operation.mcp_server_ref,
    tool_name: operation.tool_name,
    effective_arguments_hash: sha256Ref(operation.params),
    network_policy_hash: sha256Ref({ mode: 'allowlist', allowlist: [ENDPOINT] }),
    operation_hash: sha256Ref(operation),
    execution_mode: 'isolated_execution',
    expected_result_schema_hash: operation.response_schema_hash,
    operation,
    result_path: resultPath,
    job_hash: null,
  };
  job.job_hash = sha256Ref({ ...job, job_hash: null });
  const harness = createHttpsHarness();
  const runtime = makeRuntime(harness);
  const result = await runRunnerJob({
    job,
    resultPath,
    runnerArtifactPath: new URL('../e2b-template/bin/run.mjs', import.meta.url),
    mcpHttpPhase: runtime,
  });
  assert.equal(harness.state.calls.length, 1);
  assert.equal(result.commit_candidate.type, 'TYPED_RESULT');
  assert.deepEqual(result.commit_candidate.payload_schema, operation.response_schema);
  assert.equal(result.commit_candidate.payload.transport_evidence.measurements.http_request_count, 1);
  assert.equal(result.commit_candidate_hash, sha256Ref(result.commit_candidate));
  assert.deepEqual(JSON.parse(await readFile(resultPath, 'utf8')), result);

  const rejectedPath = path.join(root, 'unbranded-result.json');
  const rejectedJob = {
    ...job,
    job_id: 'rfj_fedcba0987654321',
    result_path: rejectedPath,
    job_hash: null,
  };
  rejectedJob.job_hash = sha256Ref({ ...rejectedJob, job_hash: null });
  await assert.rejects(
    runRunnerJob({
      job: rejectedJob,
      resultPath: rejectedPath,
      runnerArtifactPath: new URL('../e2b-template/bin/run.mjs', import.meta.url),
      mcpHttpPhase: async () => ({}),
    }),
    /opaque runtime capability/i,
  );
});
