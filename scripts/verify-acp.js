#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

const root = path.resolve(__dirname, '..');
const agentPath = path.join(root, 'acp', 'agent.json');
const readmePath = path.join(root, 'acp', 'README.md');
const iconPath = path.join(root, 'acp', 'icon.svg');
const mcpServerPath = path.join(root, 'mcp', 'mcp-server.js');

function assert(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
}

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

function verifyFiles() {
  assert(fs.existsSync(agentPath), 'missing acp/agent.json');
  assert(fs.existsSync(readmePath), 'missing acp/README.md');
  assert(fs.existsSync(iconPath), 'missing acp/icon.svg');

  const agent = readJson(agentPath);
  assert(agent.id === 'agoragentic-agent-os', 'agent id must be agoragentic-agent-os');
  assert(agent.name === 'Agoragentic Agent OS', 'agent name must use Agent OS spine');
  assert(agent.runtime && agent.runtime.command === null, 'registry runtime command must be disabled');
  assert(Array.isArray(agent.runtime.args), 'runtime args must be an array');
  assert(agent.runtime.args.length === 0, 'registry runtime args must not auto-launch a package');
  assert(agent.runtime.source_checkout?.command === 'node', 'source-checkout runtime command must use node');
  assert(
    JSON.stringify(agent.runtime.source_checkout?.args) === JSON.stringify(['mcp/dist/mcp-server.cjs', '--acp']),
    'source-checkout runtime args must point to the built repository artifact',
  );
  assert(
    JSON.stringify(agent.runtime.source_checkout?.prerequisites) === JSON.stringify(['npm --prefix mcp ci', 'npm --prefix mcp run build']),
    'source-checkout prerequisites must build the local package without registry resolution',
  );
  assert(agent.runtime.operational === false, 'ACP runtime must be marked non-operational');
  assert(agent.runtime.status === 'blocked_pending_qualified_host_enforcement', 'ACP runtime must expose its enforcement blocker');
  assert(Array.isArray(agent.auth) && agent.auth.length === 0, 'ACP registry must not advertise raw credential injection');
  assert(Array.isArray(agent.recommended_tools), 'recommended_tools must be present');
  assert(agent.recommended_tools.length === 0, 'blocked ACP runtime must not recommend executable tools');
  assert(!JSON.stringify(agent).includes('agoragentic_vault'), 'registry must not recommend legacy vault tools');

  const icon = fs.readFileSync(iconPath, 'utf8');
  assert(icon.includes('viewBox="0 0 16 16"'), 'icon must be 16x16');
  assert(icon.includes('currentColor'), 'icon must use currentColor');
}

function verifyHandshake() {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [mcpServerPath, '--acp'], {
      cwd: root,
      stdio: ['pipe', 'pipe', 'pipe'],
      env: {
        ...process.env,
        AGORAGENTIC_API_KEY: '',
      },
    });

    const timer = setTimeout(() => {
      child.kill('SIGTERM');
      reject(new Error('Agent Client Protocol initialize handshake timed out'));
    }, 10000);

    let stdout = '';
    let stderr = '';
    let sessionId = '';
    const messages = [];

    child.stdout.on('data', (chunk) => {
      stdout += chunk.toString('utf8');

      while (stdout.includes('\n')) {
        const newline = stdout.indexOf('\n');
        const line = stdout.slice(0, newline).trim();
        stdout = stdout.slice(newline + 1);
        if (!line) continue;

        let response;
        try {
          response = JSON.parse(line);
        } catch (error) {
          clearTimeout(timer);
          child.kill('SIGTERM');
          reject(error);
          return;
        }

        messages.push(response);

        try {
          assert(response.jsonrpc === '2.0', 'response must be JSON-RPC 2.0');
          assert(response.id !== null, 'notifications must not emit id:null responses');

          if (response.id === 1) {
            assert(response.result, 'initialize response must contain result');
            assert(response.result.agentInfo.name === 'Agoragentic Agent OS', 'agentInfo name mismatch');
            assert(response.result.agentCapabilities.tools === true, 'tools capability must be true');
            assert(response.result.agentCapabilities.loadSession === false, 'loadSession capability must be false');
            child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'session/new', params: { cwd: root, mcpServers: [] } })}\n`);
          } else if (response.id === 2) {
            sessionId = response.result && response.result.sessionId;
            assert(/^sess_[a-f0-9]{24}$/.test(sessionId), 'session/new must return a stable sessionId');
            child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method: 'session/cancel', params: { sessionId } })}\n`);
            child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id: 3, method: 'session/prompt', params: { sessionId, content: [{ type: 'text', text: 'List Agoragentic tools' }] } })}\n`);
          } else if (response.method === 'session/update') {
            assert(response.params && response.params.sessionId === sessionId, 'session/update must include the active sessionId');
          } else if (response.id === 3) {
            assert(response.result && response.result.stopReason === 'end_turn', 'session/prompt must end cleanly');
            assert(messages.some((message) => message.method === 'session/update'), 'session/prompt must emit a session/update notification');
            child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id: 4, method: 'tools/list', params: {} })}\n`);
          } else if (response.id === 4) {
            assert(response.result && Array.isArray(response.result.tools), 'tools/list must return the compatibility inventory');
            assert(response.result.tools.length > 0, 'tools/list compatibility inventory must not be empty');
            assert(response.result.tools.every((tool) => /enforcement implementation/i.test(tool.description)), 'every advertised tool must disclose the enforcement requirement');
            child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id: 5, method: 'tools/call', params: { name: 'unadvertised_tool', arguments: {} } })}\n`);
          } else if (response.id === 5) {
            assert(response.error && response.error.code === -32602, 'unadvertised tools/call must be rejected before enforcement');
            child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id: 6, method: 'tools/call', params: { name: 'agoragentic_execute', arguments: { task: 'must not run' } } })}\n`);
          } else if (response.id === 6) {
            assert(response.error && response.error.code === -32000, 'advertised tools/call must fail closed without host enforcement');
            assert(response.error.data && response.error.data.enforcement_code === 'MCP_RISK_FORK_ENFORCEMENT_REQUIRED', 'ACP failure must expose the enforcement blocker code');
            clearTimeout(timer);
            child.kill('SIGTERM');
            resolve();
          }
        } catch (error) {
          clearTimeout(timer);
          child.kill('SIGTERM');
          reject(error);
          return;
        }
      }
    });

    child.stderr.on('data', (chunk) => {
      stderr += chunk.toString('utf8');
    });

    child.on('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });

    child.on('exit', (code) => {
      if (stdout.trim()) return;
      clearTimeout(timer);
      reject(new Error(`Agent Client Protocol process exited before response: code=${code}, stderr=${stderr.trim()}`));
    });

    child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} })}\n`);
  });
}

(async () => {
  verifyFiles();
  await verifyHandshake();
  console.log('Agent Client Protocol verification passed');
})().catch((error) => {
  console.error(`Agent Client Protocol verification failed: ${error.message}`);
  process.exit(1);
});
