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
  const updatedAt = manifest.updated_at;
  if (typeof updatedAt !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(updatedAt)) {
    fail(`integrations.json updated_at must be an ISO date (YYYY-MM-DD); got ${JSON.stringify(updatedAt)}`);
  } else {
    const parsed = new Date(`${updatedAt}T00:00:00Z`);
    if (Number.isNaN(parsed.getTime())) {
      fail(`integrations.json updated_at is not a valid date: ${updatedAt}`);
    } else if (parsed.getTime() > Date.now()) {
      fail(`integrations.json updated_at is in the future: ${updatedAt}`);
    }
  }
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

function assertInventoryCoverage(manifest) {
  const ids = new Set();
  const representedDirectories = new Set();

  for (const integration of manifest.integrations || []) {
    if (ids.has(integration.id)) fail(`integrations.json has duplicate integration id: ${integration.id}`);
    ids.add(integration.id);

    for (const field of ['path', 'docs']) {
      if (!integration[field]) continue;
      const target = path.join(root, integration[field]);
      if (!fs.existsSync(target)) fail(`${integration.id}.${field} does not exist: ${integration[field]}`);
      representedDirectories.add(integration[field].split('/')[0]);
    }
  }

  const nonIntegrationDirectories = new Set([
    '.github',
    'assets',
    'deliverables',
    'dist',
    'docs',
    'examples',
    'sdk',
    'skills',
    'specs',
    'src',
    'templates',
    'test',
  ]);

  const integrationDirectories = fs.readdirSync(root, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .filter((entry) => !nonIntegrationDirectories.has(entry.name))
    .filter((entry) => fs.existsSync(path.join(root, entry.name, 'README.md')))
    .map((entry) => entry.name);

  for (const directory of integrationDirectories) {
    if (!representedDirectories.has(directory)) {
      fail(`top-level integration directory is missing from integrations.json: ${directory}`);
    }
  }

  const expectedExperimentalDocs = ['langflow', 'browser-use', 'dspy', 'agentscope', 'voltagent', 'genkit'];
  for (const id of expectedExperimentalDocs) {
    const integration = (manifest.integrations || []).find((entry) => entry.id === id);
    if (!integration) fail(`integrations.json missing researched framework entry: ${id}`);
    if (integration?.status !== 'experimental') fail(`${id} must remain experimental until executable framework tests exist`);
  }
}

function assertDiscoveryParity(manifest) {
  const readme = fs.readFileSync(path.join(root, 'README.md'), 'utf8');
  const llms = fs.readFileSync(path.join(root, 'llms.txt'), 'utf8');
  const nestedSkill = fs.readFileSync(path.join(root, 'skills', 'agoragentic', 'SKILL.md'), 'utf8');

  if (readme.includes('50+ agent-framework adapters')) {
    fail('README.md contains the stale and untyped "50+ agent-framework adapters" claim');
  }
  if (!readme.includes('Featured Integration Paths')) {
    fail('README.md must label its hand-curated table as Featured Integration Paths');
  }
  if (!readme.includes(`contains **${manifest.integrations.length}** surfaces`)) {
    fail(`README.md must state the canonical manifest count (${manifest.integrations.length})`);
  }
  if (!llms.includes(`(${manifest.integrations.length} indexed surfaces`)) {
    fail(`llms.txt must state the canonical manifest count (${manifest.integrations.length})`);
  }
  if (/npm publication pending/i.test(llms)) {
    fail('llms.txt must not claim Harness Core npm publication is pending');
  }
  if (!nestedSkill.includes('https://agoragentic.com/skill.md')
    || !nestedSkill.includes('https://github.com/rhein1/agoragentic-integrations')) {
    fail('nested distributable skill must point to canonical live and repository discovery surfaces');
  }
  if (nestedSkill.includes('../../SKILL.md')) {
    fail('nested distributable skill must not depend on a relative file outside its install directory');
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

function assertRegistryMetadata() {
  const glama = JSON.parse(fs.readFileSync(path.join(root, 'glama.json'), 'utf8'));
  const server = JSON.parse(fs.readFileSync(path.join(root, 'mcp', 'server.json'), 'utf8'));
  const mcpPackage = JSON.parse(fs.readFileSync(path.join(root, 'mcp', 'package.json'), 'utf8'));
  const packageVersion = mcpPackage.version;
  if (!glama.version || glama.version !== glama.packages?.[0]?.version) {
    fail('glama.json top-level and npm package versions must match');
  }
  if (glama.version !== packageVersion) {
    fail(`glama.json version must match mcp/package.json (${packageVersion})`);
  }
  if (server.packages?.[0]?.version !== packageVersion) {
    fail(`mcp/server.json npm package version must match mcp/package.json (${packageVersion})`);
  }
  if (typeof server.version !== 'string' || !/^\d+\.\d+\.\d+$/.test(server.version)) {
    fail('mcp/server.json registry version must be a semantic version');
  }
  if (mcpPackage.mcpName !== server.name || server.name !== glama.name) {
    fail('MCP package and registry names must match');
  }
  if (/execute paid work/i.test(glama.description || '')) {
    fail('glama.json must not present paid execution as unconditionally available');
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
assertInventoryCoverage(manifest);
assertDiscoveryParity(manifest);
assertMachineCopy();
assertRegistryMetadata();
assertA2aRouterFirst();
assertDifyRouterFirst();

if (process.exitCode) process.exit(process.exitCode);
console.log('✅ integrations machine-surface verification passed');
