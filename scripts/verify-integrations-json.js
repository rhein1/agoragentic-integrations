#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const root = path.resolve(__dirname, '..');
const manifestPath = path.join(root, 'integrations.json');
const machineSurfacePaths = [
  manifestPath,
  path.join(root, 'a2a', 'agent-card.json'),
  path.join(root, 'dify', 'agoragentic_provider.json'),
];

function fail(message) {
  console.error(`❌ ${message}`);
  process.exitCode = 1;
}

function topLevelDuplicateKeys(jsonText) {
  let depth = 0;
  let inString = false;
  let escaped = false;
  let key = '';
  const keys = [];

  for (let index = 0; index < jsonText.length; index += 1) {
    const char = jsonText[index];

    if (inString) {
      if (escaped) {
        escaped = false;
      } else if (char === '\\') {
        escaped = true;
      } else if (char === '"') {
        inString = false;
        let lookahead = index + 1;
        while (/\s/.test(jsonText[lookahead])) lookahead += 1;
        if (jsonText[lookahead] === ':' && depth === 1) keys.push(key);
      } else if (depth === 1) {
        key += char;
      }
      continue;
    }

    if (char === '"') {
      inString = true;
      key = '';
    } else if (char === '{') {
      depth += 1;
    } else if (char === '}') {
      depth -= 1;
    }
  }

  const seen = new Set();
  const duplicates = new Set();
  for (const item of keys) {
    if (seen.has(item)) duplicates.add(item);
    seen.add(item);
  }
  return [...duplicates];
}

function assertManifestShape(manifest) {
  if (manifest.recommended_flow?.[0] !== 'agoragentic_execute') {
    fail('recommended_flow must start with agoragentic_execute');
  }
  if (manifest.recommended_flow?.[1] !== 'agoragentic_match') {
    fail('recommended_flow must put agoragentic_match second');
  }
  if (!manifest.agent_os_smart_routing?.marketplace_routing?.entrypoint?.includes('execute(')) {
    fail('agent_os_smart_routing.marketplace_routing must prefer execute(task,input,constraints)');
  }
}

function assertMachineCopy() {
  const banned = [
    /\$0\.50/i,
    /free\s+USDC/i,
    /free\s+credits/i,
    /agent-to-agent marketplace/i,
    /Passport NFT/i,
    /on-chain NFT identity/i,
  ];

  for (const file of machineSurfacePaths) {
    const relative = path.relative(root, file);
    const text = fs.readFileSync(file, 'utf8');
    for (const pattern of banned) {
      if (pattern.test(text)) {
        fail(`${relative} contains stale machine-facing copy: ${pattern}`);
      }
    }
  }
}

function assertA2aRouterFirst() {
  const card = JSON.parse(fs.readFileSync(path.join(root, 'a2a', 'agent-card.json'), 'utf8'));
  const skillIds = (card.skills || []).map((skill) => skill.id);
  for (const required of ['router-execute', 'router-match']) {
    if (!skillIds.includes(required)) fail(`a2a/agent-card.json missing ${required} skill`);
  }
  if (!card.endpoints?.execute || !card.endpoints?.match) {
    fail('a2a/agent-card.json must expose execute and match endpoints');
  }
}

function assertDifyRouterFirst() {
  const provider = JSON.parse(fs.readFileSync(path.join(root, 'dify', 'agoragentic_provider.json'), 'utf8'));
  const toolNames = (provider.tools || []).map((tool) => tool.name);
  if (toolNames[0] !== 'agoragentic_execute') fail('Dify first tool must be agoragentic_execute');
  if (toolNames[1] !== 'agoragentic_match') fail('Dify second tool must be agoragentic_match');
}

function readJson(relativePath) {
  return JSON.parse(fs.readFileSync(path.join(root, relativePath), 'utf8'));
}

function assertFileExists(relativePath) {
  if (!fs.existsSync(path.join(root, relativePath))) {
    fail(`Missing expected file: ${relativePath}`);
  }
}

function assertAllFalse(object, fields, label) {
  for (const field of fields) {
    if (object?.[field] !== false) {
      fail(`${label}.${field} must be false`);
    }
  }
}

function assertNoSecretShapedValues(relativePaths) {
  const forbidden = [
    /(?:access[_-]?token|refresh[_-]?token|private[_-]?key|password|secret|account[_-]?number)\s*[:=]\s*["'][^"'\s]{8,}["']/i,
    /\b(?:sk|ghp|github_pat|amk)_[A-Za-z0-9_=-]{16,}\b/i,
    /\b0x[a-fA-F0-9]{64}\b/,
  ];

  for (const relativePath of relativePaths) {
    const text = fs.readFileSync(path.join(root, relativePath), 'utf8');
    for (const pattern of forbidden) {
      if (pattern.test(text)) {
        fail(`${relativePath} contains a secret-shaped value: ${pattern}`);
      }
    }
  }
}

function assertRobinhoodGuard(manifest) {
  const integrationId = 'robinhood-agentic-trading-guard';
  const guardRoot = 'robinhood-agentic-trading-guard';
  const requiredPaths = [
    `${guardRoot}/README.md`,
    `${guardRoot}/policy.example.json`,
    `${guardRoot}/capability-manifest.json`,
    `${guardRoot}/mcp-probe.example.json`,
    `${guardRoot}/receipt.example.json`,
    `${guardRoot}/guard-policy-preview.mjs`,
    `${guardRoot}/prompts/codex-robinhood-agentic-guard-build.md`,
  ];

  const entry = (manifest.integrations || []).find((integration) => integration.id === integrationId);
  if (!entry) fail(`integrations.json missing ${integrationId}`);
  if (entry?.status !== 'experimental') fail(`${integrationId} must remain experimental`);
  if (entry?.language !== 'javascript') fail(`${integrationId} language must be javascript`);
  if (entry?.path !== `${guardRoot}/guard-policy-preview.mjs`) fail(`${integrationId} path must point to guard-policy-preview.mjs`);
  if (entry?.docs !== `${guardRoot}/README.md`) fail(`${integrationId} docs must point to README.md`);

  for (const relativePath of requiredPaths) assertFileExists(relativePath);

  const requiredDiscovery = {
    robinhood_agentic_trading_guard: `${guardRoot}/README.md`,
    robinhood_agentic_trading_guard_policy: `${guardRoot}/policy.example.json`,
    robinhood_agentic_trading_guard_manifest: `${guardRoot}/capability-manifest.json`,
    robinhood_agentic_trading_guard_probe: `${guardRoot}/mcp-probe.example.json`,
    robinhood_agentic_trading_guard_receipt: `${guardRoot}/receipt.example.json`,
    robinhood_agentic_trading_guard_verifier: `${guardRoot}/guard-policy-preview.mjs`,
  };
  for (const [key, expectedPath] of Object.entries(requiredDiscovery)) {
    if (manifest.discovery?.[key] !== expectedPath) {
      fail(`integrations.json discovery.${key} must be ${expectedPath}`);
    }
  }

  const policy = readJson(`${guardRoot}/policy.example.json`);
  if (policy.default_mode !== 'dry_run_proposal_only') fail('Robinhood guard policy default_mode must be dry_run_proposal_only');
  if (policy.mcp_metadata?.metadata_only !== true) fail('Robinhood guard MCP metadata must be metadata_only');
  if (policy.mcp_metadata?.owner_authenticated_schema_verified !== false) fail('Robinhood guard must not claim owner-authenticated schema verification');
  if (policy.rules?.live_mode_enabled !== false) fail('Robinhood guard live mode must be disabled by default');
  if (policy.rules?.owner_approval_required_for_live_mode !== true) fail('Robinhood guard live mode must require owner approval');
  for (const decision of ['allow_read_only', 'require_owner_review', 'blocked']) {
    if (!policy.decision_values?.includes(decision)) fail(`Robinhood guard policy missing decision ${decision}`);
  }
  if (!policy.blocked_asset_classes?.includes('options')) fail('Robinhood guard must block options by default');
  if (!policy.blocked_tools?.includes('place_options_order')) fail('Robinhood guard must block place_options_order by default');
  assertAllFalse(policy.authority_boundary, [
    'brokerage_execution_enabled',
    'live_order_dispatch_enabled',
    'credential_storage_enabled',
    'private_account_data_storage_enabled',
    'unofficial_api_usage_allowed',
    'trading_bot_behavior_allowed',
  ], 'Robinhood guard policy authority_boundary');

  const capability = readJson(`${guardRoot}/capability-manifest.json`);
  if (capability.default_mode !== 'dry_run_proposal_only') fail('Robinhood guard capability default_mode must be dry_run_proposal_only');
  if (capability.transport?.network_required !== false) fail('Robinhood guard capability must not require network');
  if (capability.transport?.brokerage_execution !== false) fail('Robinhood guard capability must not enable brokerage execution');
  if (capability.official_mcp_metadata?.metadata_only !== true) fail('Robinhood guard capability MCP metadata must be metadata_only');
  if (capability.official_mcp_metadata?.owner_verified !== false) fail('Robinhood guard capability must not claim owner verification');
  assertAllFalse(capability.authority_boundary, [
    'places_orders',
    'uses_unofficial_robinhood_api',
    'stores_robinhood_credentials',
    'stores_account_numbers',
    'stores_balances_or_raw_portfolio_data',
    'live_mode_enabled_by_default',
    'options_enabled_by_default',
  ], 'Robinhood guard capability authority_boundary');

  const probe = readJson(`${guardRoot}/mcp-probe.example.json`);
  if (probe.probe_type !== 'metadata_only') fail('Robinhood guard MCP probe must be metadata_only');
  if (probe.evidence?.robinhood_mcp_called !== false) fail('Robinhood guard MCP probe must not call Robinhood MCP');
  if (probe.evidence?.unofficial_api_used !== false) fail('Robinhood guard MCP probe must not use unofficial APIs');
  if (probe.evidence?.live_order_attempted !== false) fail('Robinhood guard MCP probe must not attempt live orders');

  const receipt = readJson(`${guardRoot}/receipt.example.json`);
  if (receipt.policy_decision?.decision !== 'blocked') fail('Robinhood guard receipt example must show a blocked decision');
  if (receipt.evidence?.no_live_order_confirmation !== true) fail('Robinhood guard receipt must confirm no live order');
  if (receipt.evidence?.robinhood_mcp_called !== false) fail('Robinhood guard receipt must confirm no Robinhood MCP call');
  if (receipt.governance_boundary?.live_mode_enabled !== false) fail('Robinhood guard receipt must keep live mode disabled');

  assertNoSecretShapedValues(requiredPaths);
  execFileSync(process.execPath, [path.join(root, `${guardRoot}/guard-policy-preview.mjs`), '--assert'], { stdio: 'pipe' });
}

const rawManifest = fs.readFileSync(manifestPath, 'utf8');
const duplicates = topLevelDuplicateKeys(rawManifest);
if (duplicates.length) fail(`integrations.json has duplicate top-level keys: ${duplicates.join(', ')}`);

const manifest = JSON.parse(rawManifest);
assertManifestShape(manifest);
assertMachineCopy();
assertA2aRouterFirst();
assertDifyRouterFirst();
assertRobinhoodGuard(manifest);

if (process.exitCode) process.exit(process.exitCode);
console.log('✅ integrations machine-surface verification passed');
