import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

import { runMcpClientConformance } from '../scripts/mcp-client-conformance.mjs';

const testRoot = path.dirname(fileURLToPath(import.meta.url));

test('real stdio MCP client completes initialize, discovery, plan, run, and receipt', async () => {
  const result = await runMcpClientConformance({
    entrypoint: path.resolve(testRoot, '..', 'bin', 'risk-fork-demo.mjs'),
  });
  assert.equal(result.verified, true);
  assert.equal(result.protocol_version, '2025-06-18');
  assert.equal(result.transport, 'stdio_json_rpc');
  assert.equal(result.tools.length, 4);
  assert.equal(result.final_state, 'prepared_not_committed');
  assert.equal(result.core_receipt_verified, true);
  assert.equal(result.receipt_verified, true);
  assert.equal(result.cleanup.status, 'verified');
  assert.equal(result.provider_calls, 0);
  assert.equal(result.network_used, false);
  assert.equal(result.live_traffic_protected, false);
  assert.equal(result.gui_client_status, 'unknown_not_tested');
});
