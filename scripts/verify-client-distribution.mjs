#!/usr/bin/env node

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runInNewContext } from 'node:vm';

import { verifyClientBanner } from './generate-client-banner.mjs';

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
const skillPack = readJson('skills/skill-pack.v2.json');

const skillGeneration = spawnSync(
  process.execPath,
  ['scripts/generate-skill-pack.mjs', '--check'],
  { cwd: root, encoding: 'utf8' },
);
assert.equal(skillGeneration.status, 0, skillGeneration.stderr);
assert.equal(skillPack.schema, 'agoragentic.skill-pack.v2');
assert.ok(Object.values(skillPack.authority).every((value) => value === false));

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
  'submitted_pending_review',
  'support_escalated',
]);
for (const channel of profile.channels) {
  assert.ok(channelStatuses.has(channel.status), `unknown channel status: ${channel.status}`);
}
assert.equal(
  profile.channels.find((channel) => channel.id === 'openai-plugin-directory')?.status,
  'blocked_policy',
  'the commerce MCP surface must not be presented as OpenAI-directory eligible',
);

const contextHubChannel = profile.channels.find((channel) => channel.id === 'context-hub');
assert.equal(contextHubChannel?.status, 'ready_for_submission');
assert.equal(
  contextHubChannel?.artifact,
  'distribution/context-hub/content/agoragentic/docs/agent-os-api/javascript/DOC.md',
);

const paymentsStackChannel = profile.channels.find(
  (channel) => channel.id === 'agent-payments-stack',
);
assert.equal(paymentsStackChannel?.status, 'active_needs_metadata_refresh');
assert.equal(
  paymentsStackChannel?.artifact,
  'distribution/agent-payments-stack/correction.json',
);

const contextHubDoc = readText(contextHubChannel.artifact);
assert.match(contextHubDoc, /^---\r?\nname: agent-os-api\r?\n/m);
assert.match(contextHubDoc, /languages: "javascript"/);
assert.match(contextHubDoc, /versions: "2\.1\.0"/);
for (const route of [
  '/api/index.json',
  '/api/stats',
  '/api/discovery/check',
  '/api/capabilities',
  '/api/execute/match',
]) {
  assert.match(contextHubDoc, new RegExp(route.replaceAll('/', '\\/')));
}
assert.match(contextHubDoc, /platform_custody_frozen/);
assert.match(contextHubDoc, /verified.*reachable.*failed/is);
assert.match(contextHubDoc, /explicit.*approval.*cost ceiling/is);
assert.doesNotMatch(contextHubDoc, /amk_[a-z0-9]{8,}/i);
assert.doesNotMatch(contextHubDoc, /\b\d{2,}\+? (verified )?listings\b/i);
assert.doesNotMatch(contextHubDoc, /Full ECF/i);

const availabilitySnippet = contextHubDoc.match(
  /```javascript\r?\n(function assertPaidExecutionAvailable[\s\S]*?\r?\n})\r?\n\r?\nassertPaidExecutionAvailable/,
);
assert.ok(availabilitySnippet, 'Context Hub doc must include an executable availability helper');
const availabilityContext = {};
runInNewContext(
  `${availabilitySnippet[1]}\nglobalThis.assertPaidExecutionAvailable = assertPaidExecutionAvailable;`,
  availabilityContext,
);
const mixedAvailabilityIndex = {
  availability: { paid_execution: 'available' },
  payment: {
    status: 'available',
    rails: [
      { network: 'base', asset: 'USDC', execution_ready: true, status: 'available' },
      {
        network: 'solana',
        asset: 'USDC',
        execution_ready: false,
        status: 'temporarily_unavailable',
      },
    ],
  },
};
assert.doesNotThrow(() =>
  availabilityContext.assertPaidExecutionAvailable(mixedAvailabilityIndex, {
    network: 'base',
    asset: 'USDC',
  }),
);
assert.throws(
  () =>
    availabilityContext.assertPaidExecutionAvailable(mixedAvailabilityIndex, {
      network: 'solana',
      asset: 'USDC',
    }),
  /Payment rail unavailable \(solana\/USDC\): temporarily_unavailable/,
);
assert.throws(
  () =>
    availabilityContext.assertPaidExecutionAvailable(mixedAvailabilityIndex, {
      network: 'base',
      asset: 'ETH',
    }),
  /Payment rail unavailable \(base\/ETH\): payment_rail_unavailable/,
);

const paymentsCorrection = readJson(paymentsStackChannel.artifact);
assert.equal(paymentsCorrection.schema, 'agoragentic.external-directory-correction.v1');
assert.equal(paymentsCorrection.directory.id, 'agent-payments-stack');
assert.equal(paymentsCorrection.submission.status, 'prepared_not_submitted');
assert.equal(paymentsCorrection.submission.external_write_authorized, false);
assert.equal(paymentsCorrection.proposed_record.layer, 'L5');
assert.equal(paymentsCorrection.proposed_record.status, 'live');
assert.equal(paymentsCorrection.authority.availability, 'https://agoragentic.com/api/index.json');
assert.equal(paymentsCorrection.authority.metrics, 'https://agoragentic.com/api/stats');
assert.equal(
  paymentsCorrection.authority.discovery_proof,
  'https://agoragentic.com/api/discovery/check',
);
const paymentsCorrectionText = JSON.stringify(paymentsCorrection);
assert.doesNotMatch(paymentsCorrectionText, /170\+/i);
assert.doesNotMatch(paymentsCorrectionText, /USDC escrow/i);
assert.doesNotMatch(paymentsCorrection.proposed_record.description, /\b\d+\+? (verified )?listings\b/i);
assert.match(paymentsCorrection.proposed_record.description, /live availability document/i);
assert.doesNotMatch(paymentsCorrectionText, /amk_[a-z0-9]{8,}/i);

const cursor = readJson('.cursor-plugin/plugin.json');
assert.equal(cursor.name, 'agoragentic');
assert.equal(cursor.version, skillPack.version);
assert.equal(cursor.skills, './skills/');
assertMcpCommand(cursor.mcpServers.agoragentic, 'Cursor plugin', packageVersion);

const gemini = readJson('gemini-extension.json');
assert.equal(gemini.name, 'agoragentic');
assert.equal(gemini.version, skillPack.version);
assert.equal(gemini.contextFileName, 'GEMINI.md');
assertMcpCommand(gemini.mcpServers.agoragentic, 'Gemini extension', packageVersion);

const claudeMarketplace = readJson('.claude-plugin/marketplace.json');
assert.equal(claudeMarketplace.name, 'agoragentic-integrations');
assert.equal(claudeMarketplace.plugins.length, 1);
assert.equal(claudeMarketplace.plugins[0].source, './claude-code/plugin');
const claudePlugin = readJson('claude-code/plugin/.claude-plugin/plugin.json');
assert.equal(claudePlugin.name, 'agoragentic');
assert.equal(claudePlugin.version, skillPack.version);
assert.equal(claudeMarketplace.version, skillPack.version);
assert.equal(claudeMarketplace.plugins[0].version, skillPack.version);
assert.equal(claudePlugin.mcpServers, './.mcp.json');
const claudeMcp = readJson('claude-code/plugin/.mcp.json');
assertMcpCommand(claudeMcp.mcpServers.agoragentic, 'Claude Code plugin', packageVersion);

const requiredNoSpendDocs = [
  'GEMINI.md',
  'cursor/README.md',
  'gemini-cli/README.md',
  'claude-code/README.md',
  'claude-code/plugin/skills/agoragentic/SKILL.md',
  '.github/copilot-instructions.md',
  '.agents/skills/agoragentic/SKILL.md',
  '.opencode/skills/agoragentic/SKILL.md',
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

verifyClientBanner(root);

console.log('client-native distribution surfaces verified');
