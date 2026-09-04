import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

import { createMcpMessageHandler } from '../src/mcp-server.mjs';

test('capability discovery advertises exactly the four actually served demo tools', async () => {
  const card = JSON.parse(await readFile(new URL('../../discovery/risk-fork-capability.json', import.meta.url), 'utf8'));
  const handler = createMcpMessageHandler({
    engine: {
      plan() { throw new Error('Listing must not execute a scenario'); },
      run() { throw new Error('Listing must not execute a scenario'); },
    },
  });
  const response = await handler(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }));
  assert.deepEqual(card.served_demo_tools, response.result.tools.map(tool => tool.name));
  assert.equal(card.served_demo_tool_status, 'local_stdio_closed_synthetic_fixtures_only');
  assert.equal(card.intercepts_live_traffic, false);
  assert.equal(card.truth.npm_published, false);
  assert.equal(card.truth.hosted_enabled, false);
  assert.equal(card.truth.live_traffic_protected, false);
  for (const proposed of card.read_only_discovery_tools) {
    assert.ok(!card.served_demo_tools.includes(proposed));
  }
});
