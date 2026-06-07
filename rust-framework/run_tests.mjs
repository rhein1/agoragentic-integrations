#!/usr/bin/env node
/**
 * Test runner for the Agoragentic Rust Framework public integrations.
 * Starts the mock runtime, executes the Node.js and Python callers,
 * and performs direct contract validation tests.
 */

import assert from 'node:assert';
import { spawn } from 'node:child_process';
import { createMockServer } from './mock_runtime.mjs';

function runProcess(command, args, env) {
  return new Promise((resolve, reject) => {
    const proc = spawn(command, args, { env: { ...process.env, ...env } });
    let stdout = '';
    let stderr = '';

    proc.stdout.on('data', (data) => {
      stdout += data;
    });

    proc.stderr.on('data', (data) => {
      stderr += data;
    });

    proc.on('close', (code) => {
      if (code !== 0) {
        reject(new Error(`${command} failed with exit code ${code}. Stderr: ${stderr}`));
      } else {
        resolve(stdout);
      }
    });
  });
}

async function runContractTests(baseUrl) {
  console.log('[Contract Test] Verifying schema and A2A invoke envelopes...');

  // 1. Test GET /schema/agoragentic-rust-framework.json
  const schemaRes = await fetch(`${baseUrl}/schema/agoragentic-rust-framework.json`);
  assert.strictEqual(schemaRes.status, 200, 'Schema endpoint failed');
  const schemaData = await schemaRes.json();
  assert.strictEqual(schemaData.title, 'AgoragenticRustFrameworkEnvelope', 'Schema title mismatch');
  assert.ok(schemaData.properties.request_id, 'Schema missing request_id');

  // 2. Test POST /a2a/invoke (JSON-RPC 2.0 contract)
  const a2aRes = await fetch(`${baseUrl}/a2a/invoke`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      jsonrpc: '2.0',
      method: 'execute_task',
      params: { task: 'test' },
      id: 42,
    }),
  });
  assert.strictEqual(a2aRes.status, 200, 'A2A endpoint failed');
  const a2aData = await a2aRes.json();
  assert.strictEqual(a2aData.jsonrpc, '2.0', 'A2A response jsonrpc version mismatch');
  assert.strictEqual(a2aData.id, 42, 'A2A response ID mismatch');
  assert.strictEqual(a2aData.result.status, 'completed', 'A2A result status mismatch');

  console.log('✅ Contract tests passed!');
}

async function main() {
  const server = createMockServer();

  // Start server on an ephemeral port
  const port = await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      resolve(port);
    });
  });

  const baseUrl = `http://127.0.0.1:${port}`;
  console.log(`[Test Runner] Started mock runtime at ${baseUrl}`);

  try {
    // 1. Run Node.js typescript-call-rust-agent.mjs against it
    console.log('[Test Runner] Running Node.js TypeScript caller example...');
    const nodeOutput = await runProcess('node', ['rust-framework/typescript-call-rust-agent.mjs'], {
      AGORAGENTIC_RUST_AGENT_URL: baseUrl,
    });
    const nodeJson = JSON.parse(nodeOutput);
    assert.strictEqual(nodeJson.runtime.framework, 'agoragentic-rust');
    assert.strictEqual(nodeJson.typed_invoke.status, 'completed');
    console.log('✅ Node.js caller executed successfully.');

    // 2. Run Python python_call_rust_agent.py against it
    console.log('[Test Runner] Running Python caller example...');
    const pythonOutput = await runProcess('python', ['rust-framework/python_call_rust_agent.py'], {
      AGORAGENTIC_RUST_AGENT_URL: baseUrl,
    });
    const pythonJson = JSON.parse(pythonOutput);
    assert.strictEqual(pythonJson.runtime.framework, 'agoragentic-rust');
    assert.strictEqual(pythonJson.typed_invoke.status, 'completed');
    console.log('✅ Python caller executed successfully.');

    // 3. Direct Contract Tests
    await runContractTests(baseUrl);

    console.log('\n🎉 All Rust Framework integration tests passed successfully!');
    process.exitCode = 0;
  } catch (error) {
    console.error('\n❌ Test run failed:', error.message);
    process.exitCode = 1;
  } finally {
    await new Promise((resolve) => server.close(resolve));
    console.log('[Test Runner] Mock runtime stopped.');
  }
}

main();
