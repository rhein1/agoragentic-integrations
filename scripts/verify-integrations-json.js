#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');

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

const rawManifest = fs.readFileSync(manifestPath, 'utf8');
const duplicates = topLevelDuplicateKeys(rawManifest);
if (duplicates.length) fail(`integrations.json has duplicate top-level keys: ${duplicates.join(', ')}`);

const manifest = JSON.parse(rawManifest);
assertManifestShape(manifest);
assertMachineCopy();
assertA2aRouterFirst();
assertDifyRouterFirst();

if (process.exitCode) process.exit(process.exitCode);
console.log('✅ integrations machine-surface verification passed');
