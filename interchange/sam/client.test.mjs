import assert from 'node:assert/strict';
import test from 'node:test';

import {
  SamClientError,
  authenticatedFetch,
  captureSamTool,
  discoverSamTools,
  resolveSamToken,
  validateSamEndpoint,
} from './client.mjs';

const PEER = '12D3KooWQJYx8zW9fYh5Qb6uN7mP4rT2sV1cA9eD8gF7hJ6kL5mN';
const TOOL = 'mcp://code-reviewer/review_code';

function text(value) {
  return { content: [{ type: 'text', text: JSON.stringify(value) }] };
}

class FakeClient {
  constructor(responses) {
    this.responses = responses;
    this.calls = [];
  }
  async callTool(request) {
    this.calls.push(request);
    const response = this.responses[request.name];
    if (typeof response === 'function') return response(request);
    if (!response) throw new Error(`Missing fake response for ${request.name}`);
    return response;
  }
}

test('endpoint policy is loopback-first and HTTPS-only for opted-in remotes', () => {
  assert.equal(validateSamEndpoint('http://127.0.0.1:8080/mcp').origin, 'http://127.0.0.1:8080');
  assert.throws(
    () => validateSamEndpoint('https://mesh.example/mcp'),
    (error) => error instanceof SamClientError && error.code === 'sam_remote_endpoint_requires_opt_in',
  );
  assert.throws(
    () => validateSamEndpoint('http://mesh.example/mcp', { allowRemote: true }),
    (error) => error instanceof SamClientError && error.code === 'sam_remote_endpoint_requires_https',
  );
  assert.equal(validateSamEndpoint('https://mesh.example/mcp', { allowRemote: true }).origin, 'https://mesh.example');
});

test('authenticated fetch injects the SAM-specific header', async () => {
  let headers;
  const wrapped = authenticatedFetch('secret-value', async (_input, init) => {
    headers = init.headers;
    return new Response('{}');
  });
  await wrapped('http://127.0.0.1:8080/mcp', { headers: { 'X-Test': 'present' } });
  assert.equal(headers.get('X-Sam-Authentication'), 'Bearer secret-value');
  assert.equal(headers.get('X-Test'), 'present');
});

test('explicit token paths override ambient tokens and ambiguous env sources fail closed', async () => {
  const token = await resolveSamToken(
    { tokenPath: '/operator/sam-token' },
    { env: { SAM_API_TOKEN: 'wrong-ambient-token' }, readFile: async () => Buffer.from('file-token\n') },
  );
  assert.equal(token, 'file-token');
  await assert.rejects(
    resolveSamToken({}, { env: { SAM_API_TOKEN: 'one', SAM_API_TOKEN_PATH: '/two' } }),
    (error) => error instanceof SamClientError && error.code === 'sam_token_source_ambiguous',
  );
});

test('read-only discovery never calls a remote provider and redacts raw topology', async () => {
  const client = new FakeClient({
    get_mesh_info: text({ connected_peers: [PEER], dht_size: 1, router_peer_id: 'router-peer' }),
    discover_remote_services: text([{ peer_id: PEER, srv_name: 'code-reviewer' }]),
    find_remote_tools: text([{ peer_id: PEER, tool_name: TOOL, description: 'Review code.' }]),
  });
  const output = await discoverSamTools({}, { client, env: {}, now: () => '2026-08-19T20:00:00.000Z' });
  assert.deepEqual(client.calls.map((call) => call.name), [
    'get_mesh_info',
    'discover_remote_services',
    'find_remote_tools',
  ]);
  assert.equal(output.tool_count, 1);
  assert.equal(output.safety.provider_invoked, false);
  assert.equal(JSON.stringify(output).includes(PEER), false);
  assert.equal(JSON.stringify(output).includes(TOOL), false);
});

test('default output hashes a remote endpoint and only private diagnostics reveal its origin', async () => {
  const responses = {
    get_mesh_info: text({ connected_peers: [] }),
    discover_remote_services: text([]),
    find_remote_tools: text([]),
  };
  const safe = await discoverSamTools(
    { endpoint: 'https://sam.private.example/mcp', allowRemote: true },
    { client: new FakeClient(responses), env: {} },
  );
  assert.match(safe.endpoint_ref, /^sha256:[a-f0-9]{64}$/);
  assert.equal(safe.endpoint_loopback, false);
  assert.equal(safe.private_endpoint_origin, undefined);
  assert.equal(JSON.stringify(safe).includes('sam.private.example'), false);

  const privateOutput = await discoverSamTools(
    { endpoint: 'https://sam.private.example/mcp', allowRemote: true, includePrivateTopology: true },
    { client: new FakeClient(responses), env: {} },
  );
  assert.equal(privateOutput.private_endpoint_origin, 'https://sam.private.example');
});

test('oversized SAM tool responses fail closed before parsing', async () => {
  const client = new FakeClient({
    get_mesh_info: { content: [{ type: 'text', text: 'x'.repeat(1_048_577) }] },
  });
  await assert.rejects(
    discoverSamTools({}, { client, env: {} }),
    (error) => error instanceof SamClientError && error.code === 'sam_tool_result_too_large',
  );
});

test('live capture requires one exact discovery match and describes before normalizing', async () => {
  const client = new FakeClient({
    find_remote_tools: text([{ peer_id: PEER, tool_name: TOOL, description: 'Review code.' }]),
    describe_remote_tool: text({
      peer_id: PEER,
      tool_name: TOOL,
      description: 'Review code.',
      input_schema: { type: 'object', required: ['code'], properties: { code: { type: 'string' } } },
    }),
  });
  const output = await captureSamTool({ peerId: PEER, toolName: TOOL }, {}, {
    client,
    env: {},
    now: () => '2026-08-19T20:00:00.000Z',
  });
  assert.deepEqual(client.calls.map((call) => call.name), ['find_remote_tools', 'describe_remote_tool']);
  assert.equal(output.packet.eligibility.eligible, false);
  assert.equal(output.capture_evidence.sam_endpoint_called, true);
  assert.deepEqual(output.capture_evidence.sam_control_calls_made, [
    'find_remote_tools',
    'describe_remote_tool',
  ]);
  assert.equal(output.capture_evidence.external_provider_called, false);
  assert.equal(output.capture_evidence.provider_invoked, false);
  assert.equal(output.capture_evidence.call_remote_tool_used, false);
  assert.equal(JSON.stringify(output).includes(PEER), false);
  assert.equal(JSON.stringify(output).includes(TOOL), false);
});

test('live capture rejects ambiguous or missing exact matches', async () => {
  const client = new FakeClient({ find_remote_tools: text([]) });
  await assert.rejects(
    captureSamTool({ peerId: PEER, toolName: TOOL }, {}, { client, env: {} }),
    (error) => error instanceof SamClientError && error.code === 'sam_exact_tool_match_required',
  );
});

test('live capture rejects malformed targets before any MCP request', async () => {
  const client = new FakeClient({});
  await assert.rejects(
    captureSamTool({ peerId: PEER, toolName: 'mcp://service/tool?leak=true' }, {}, { client, env: {} }),
    (error) => error instanceof SamClientError && error.code === 'sam_tool_name_invalid',
  );
  assert.deepEqual(client.calls, []);
});
