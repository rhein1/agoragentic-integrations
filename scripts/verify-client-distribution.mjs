#!/usr/bin/env node

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function readText(relativePath) {
  return fs.readFileSync(path.join(root, relativePath), 'utf8');
}

function readJson(relativePath) {
  return JSON.parse(readText(relativePath));
}

function assertMcpCommand(config, label, packageVersion) {
  assert.equal(config.command, 'npx', `${label} must launch npx`);
  assert.deepEqual(
    config.args,
    ['-y', `agoragentic-mcp@${packageVersion}`],
    `${label} must pin the published MCP package`,
  );
  assert.equal(config.env, undefined, `${label} must not inject credentials`);
}

function pngDimensions(relativePath) {
  const bytes = fs.readFileSync(path.join(root, relativePath));
  assert.equal(bytes.toString('ascii', 1, 4), 'PNG', `${relativePath} must be a PNG`);
  return {
    width: bytes.readUInt32BE(16),
    height: bytes.readUInt32BE(20),
  };
}

const mcpPackage = readJson('mcp/package.json');
const packageVersion = mcpPackage.version;
const manifest = readJson('integrations.json');
const profile = readJson('docs/catalog-profile.json');

assert.equal(profile.mcp.package_version, packageVersion);
assert.equal(profile.mcp.static_tool_count_allowed, false);
assert.equal(profile.mcp.tool_inventory, 'dynamic_and_auth_dependent');
assert.ok(Object.values(profile.authority_boundary).every((value) => value === false));

const channelStatuses = new Set([
  'active',
  'active_needs_metadata_refresh',
  'blocked_policy',
  'install_ready',
  'needs_owner_claim',
  'ready_after_merge',
  'ready_for_submission',
]);
for (const channel of profile.channels) {
  assert.ok(channelStatuses.has(channel.status), `unknown channel status: ${channel.status}`);
}
assert.equal(
  profile.channels.find((channel) => channel.id === 'openai-plugin-directory')?.status,
  'blocked_policy',
  'the commerce MCP surface must not be presented as OpenAI-directory eligible',
);

const cursor = readJson('.cursor-plugin/plugin.json');
assert.equal(cursor.name, 'agoragentic');
assert.equal(cursor.skills, './skills/');
assertMcpCommand(cursor.mcpServers.agoragentic, 'Cursor plugin', packageVersion);

const gemini = readJson('gemini-extension.json');
assert.equal(gemini.name, 'agoragentic');
assert.equal(gemini.contextFileName, 'GEMINI.md');
assertMcpCommand(gemini.mcpServers.agoragentic, 'Gemini extension', packageVersion);

const claudeMarketplace = readJson('.claude-plugin/marketplace.json');
assert.equal(claudeMarketplace.name, 'agoragentic-integrations');
assert.equal(claudeMarketplace.plugins.length, 1);
assert.equal(claudeMarketplace.plugins[0].source, './claude-code/plugin');
const claudePlugin = readJson('claude-code/plugin/.claude-plugin/plugin.json');
assert.equal(claudePlugin.name, 'agoragentic');
assert.equal(claudePlugin.mcpServers, './.mcp.json');
const claudeMcp = readJson('claude-code/plugin/.mcp.json');
assertMcpCommand(claudeMcp.mcpServers.agoragentic, 'Claude Code plugin', packageVersion);

const requiredNoSpendDocs = [
  'GEMINI.md',
  'cursor/README.md',
  'gemini-cli/README.md',
  'claude-code/README.md',
  'claude-code/plugin/skills/agoragentic/SKILL.md',
  'cline/README.md',
  'llms-install.md',
  'docs/DISTRIBUTION.md',
];
for (const relativePath of requiredNoSpendDocs) {
  const text = readText(relativePath);
  assert.match(text, /do not|without embedding|no-spend|omits `AGORAGENTIC_API_KEY`/i);
  assert.doesNotMatch(text, /amk_[a-z0-9]{8,}/i, `${relativePath} must not contain a real-looking key`);
}

const icon = pngDimensions('assets/agoragentic-plugin-icon.png');
assert.deepEqual(icon, { width: 400, height: 400 });

const expectedClientIds = [
  'cursor-plugin',
  'gemini-cli-extension',
  'claude-code-plugin',
  'cline-mcp',
];
for (const id of expectedClientIds) {
  assert.ok(manifest.integrations.some((entry) => entry.id === id), `missing integration: ${id}`);
}

const bannerSource = readText('assets/agoragentic-agent-commerce-banner.svg');
assert.match(
  bannerSource,
  new RegExp(`${manifest.integrations.length} public surfaces`),
  'social banner source must match the canonical integration count',
);

console.log('client-native distribution surfaces verified');
