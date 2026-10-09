import assert from 'node:assert/strict';
import test from 'node:test';

test('the locked MCP client supports SAM construction and cleanup without connecting', async () => {
  const { Client, StreamableHTTPClientTransport } = await import('@modelcontextprotocol/client');
  let fetchCalls = 0;
  const client = new Client({ name: 'sam-offline-dependency-check', version: '1.0.0' });
  const transport = new StreamableHTTPClientTransport(new URL('http://127.0.0.1:1/mcp'), {
    fetch: async () => {
      fetchCalls += 1;
      throw new Error('Network access is disabled in this contract test.');
    },
  });
  assert.equal(typeof client.callTool, 'function');
  assert.equal(typeof client.connect, 'function');
  await transport.close();
  await client.close();
  assert.equal(fetchCalls, 0);
});
