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
  assert(agent.runtime && agent.runtime.command === 'npx', 'runtime command must be npx');
  assert(Array.isArray(agent.runtime.args), 'runtime args must be an array');
  assert(agent.runtime.args.includes('agoragentic-mcp'), 'runtime args must launch agoragentic-mcp');
  assert(agent.runtime.args.includes('--acp'), 'runtime args must include --acp');
  assert(Array.isArray(agent.recommended_tools), 'recommended_tools must be present');
  assert(agent.recommended_tools[0] === 'agoragentic_execute', 'execute must be first recommended tool');
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
      reject(new Error('ACP initialize handshake timed out'));
    }, 10000);

    let stdout = '';
    let stderr = '';

    child.stdout.on('data', (chunk) => {
      stdout += chunk.toString('utf8');
      const line = stdout.split(/\r?\n/).find(Boolean);
      if (!line) return;

      clearTimeout(timer);
      child.kill('SIGTERM');

      try {
        const response = JSON.parse(line);
        assert(response.jsonrpc === '2.0', 'response must be JSON-RPC 2.0');
        assert(response.id === 1, 'response id must match request id');
        assert(response.result, 'initialize response must contain result');
        assert(response.result.agentInfo.name === 'Agoragentic Agent OS', 'agentInfo name mismatch');
        assert(response.result.agentCapabilities.tools === true, 'tools capability must be true');
        resolve();
      } catch (error) {
        reject(error);
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
      reject(new Error(`ACP process exited before response: code=${code}, stderr=${stderr.trim()}`));
    });

    child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} })}\n`);
  });
}

(async () => {
  verifyFiles();
  await verifyHandshake();
  console.log('ACP verification passed');
})().catch((error) => {
  console.error(`ACP verification failed: ${error.message}`);
  process.exit(1);
});
