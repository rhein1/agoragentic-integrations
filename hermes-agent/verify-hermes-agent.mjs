#!/usr/bin/env node
'use strict';

import fs from 'node:fs';

const files = {
  manifest: 'hermes-agent/agent-os-bridge.manifest.json',
  mcp: 'hermes-agent/mcp.agoragentic.example.json',
  policy: 'hermes-agent/self-improvement-policy.example.json',
  reflection: 'hermes-agent/reflection-packet.example.json',
  integrations: 'integrations.json',
};

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

function fail(message) {
  console.error(`Hermes bridge validation failed: ${message}`);
  process.exit(1);
}

function assertFalseFlags(object, path) {
  for (const [key, value] of Object.entries(object || {})) {
    if (value !== false) fail(`${path}.${key} must be false`);
  }
}

function assertNoLiveSecrets(file, value) {
  const serialized = JSON.stringify(value);
  const bannedPatterns = [
    /amk_(?!your_key)[A-Za-z0-9_]+/,
    /ghp_[A-Za-z0-9_]+/,
    /\bsk-(?:proj-)?[A-Za-z0-9_-]{16,}/,
    /-----BEGIN [A-Z ]+PRIVATE KEY-----/,
    /mnemonic/i,
    /seed phrase/i,
  ];
  for (const pattern of bannedPatterns) {
    if (pattern.test(serialized)) fail(`${file} contains a live-looking secret pattern: ${pattern}`);
  }
}

const manifest = readJson(files.manifest);
const mcp = readJson(files.mcp);
const policy = readJson(files.policy);
const reflection = readJson(files.reflection);
const integrations = readJson(files.integrations);

const entry = integrations.integrations.find((integration) => integration.id === 'hermes-agent');
if (!entry) fail('integrations.json missing hermes-agent entry');
if (entry.path !== files.manifest) fail(`hermes-agent path must be ${files.manifest}`);
if (entry.docs !== 'hermes-agent/README.md') fail('hermes-agent docs must point to README');
if (entry.status !== 'beta') fail('hermes-agent status must stay beta until live compatibility is verified');

assertFalseFlags(manifest.authority_boundary, 'manifest.authority_boundary');
assertFalseFlags(policy.authority_boundary, 'policy.authority_boundary');
assertFalseFlags(reflection.authority_boundary, 'reflection.authority_boundary');
assertFalseFlags(reflection.public_safe, 'reflection.public_safe');

if (manifest.agoragentic_surfaces?.mcp_tools?.enabled_by_config !== false) {
  fail('manifest must keep MCP tools disabled by config');
}
if (manifest.agoragentic_surfaces?.mcp_tools?.operational !== false) fail('manifest MCP must be non-operational');
if (Object.keys(mcp.mcpServers || {}).length !== 0) fail('MCP example must not auto-launch a server');
if (mcp.agoragentic_mcp?.operational !== false) fail('MCP example must be explicitly non-operational');
if (mcp.agoragentic_mcp?.status !== 'blocked_pending_qualified_host_enforcement') {
  fail('MCP example must expose the qualified-host blocker');
}

for (const [label, value] of Object.entries({ manifest, mcp, policy, reflection })) {
  assertNoLiveSecrets(label, value);
}

console.log('Hermes Agent bridge validation passed');
