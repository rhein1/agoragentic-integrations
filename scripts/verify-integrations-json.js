#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');
const { isDeepStrictEqual } = require('node:util');

const { validateInventoryHolds } = require('./integration-inventory-holds.js');
const { verifyEcosystemProfile } = require('./verify-ecosystem-profile.js');

const ecosystemResult = verifyEcosystemProfile();
if (!ecosystemResult.ok) process.exitCode = 1;

const root = path.resolve(__dirname, '..');
const manifestPath = path.join(root, 'integrations.json');
const machineSurfacePaths = [
  manifestPath,
  path.join(root, 'a2a', 'agent-card.json'),
  path.join(root, 'ard', 'generated', 'ard.json'),
  path.join(root, 'ard', 'generated', 'ai-catalog.json'),
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
  const microPackage = manifest.packages?.micro_ecf;
  const microIntegration = (manifest.integrations || []).find((entry) => entry.id === 'micro-ecf');
  for (const [label, entry] of [['packages.micro_ecf', microPackage], ['integrations.micro-ecf', microIntegration]]) {
    if (entry?.install !== 'npx agoragentic-micro-ecf@latest plan --dir .') {
      fail(`${label}.install must stop after the Micro ECF plan step`);
    }
    if (entry?.install_after_explicit_approval !== 'npx agoragentic-micro-ecf@latest install --dir . --yes') {
      fail(`${label}.install_after_explicit_approval must preserve explicit approval before install --yes`);
    }
  }
}

function assertInventoryCoverage(manifest) {
  const ids = new Set();
  const representedDirectories = new Set();
  const integrationPaths = [];

  for (const integration of manifest.integrations || []) {
    if (ids.has(integration.id)) fail(`integrations.json has duplicate integration id: ${integration.id}`);
    ids.add(integration.id);

    for (const field of ['path', 'docs']) {
      if (!integration[field]) continue;
      const target = path.join(root, integration[field]);
      if (!fs.existsSync(target)) fail(`${integration.id}.${field} does not exist: ${integration[field]}`);
      representedDirectories.add(integration[field].split('/')[0]);
      integrationPaths.push(integration[field].replace(/\\/g, '/'));
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

  const holdValidation = validateInventoryHolds(manifest, {
    integrationDirectories,
    representedDirectories,
  });
  for (const error of holdValidation.errors) fail(error);

  for (const directory of integrationDirectories) {
    if (!representedDirectories.has(directory) && !holdValidation.heldDirectories.has(directory)) {
      fail(`top-level integration directory is missing from integrations.json: ${directory}`);
    }
  }

  const examplesRoot = path.join(root, 'examples');
  const packageExamples = fs.readdirSync(examplesRoot, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .filter((entry) => fs.existsSync(path.join(examplesRoot, entry.name, 'package.json')));
  for (const entry of packageExamples) {
    const source = `examples/${entry.name}`;
    const prefix = `${source}/`;
    const packagePath = path.join(examplesRoot, entry.name, 'package.json');
    const packageJson = JSON.parse(fs.readFileSync(packagePath, 'utf8'));
    if (!integrationPaths.some((candidate) => candidate.startsWith(prefix))) {
      fail(`package-bearing example is missing from integrations.json.integrations: ${source}`);
    }
    const packageEntry = Object.values(manifest.packages || {})
      .find((candidate) => candidate?.source === source);
    if (!packageEntry) {
      fail(`package-bearing example is missing from integrations.json.packages: ${source}`);
    } else {
      if (packageEntry.name !== packageJson.name) {
        fail(`canonical package name does not match ${source}/package.json`);
      }
      if (!['published', 'source_only'].includes(packageEntry.distribution_status)) {
        fail(`canonical package entry must declare distribution_status for ${source}`);
      }
      if (packageEntry.distribution_status === 'source_only' && packageJson.private !== true) {
        fail(`${source}/package.json must remain private while canonical distribution_status is source_only`);
      }
      if (source === 'examples/anydoc-document-evidence') {
        const lockPath = path.join(examplesRoot, entry.name, 'package-lock.json');
        if (!fs.existsSync(lockPath)) {
          fail(`${source} is missing its canonical package-lock.json`);
        } else {
          const lock = JSON.parse(fs.readFileSync(lockPath, 'utf8'));
          if (lock.packages?.['']?.version !== packageJson.version) {
            fail(`${source}/package-lock.json root version must match package.json`);
          }
        }
      }
    }
  }

  const expectedExperimentalDocs = ['langflow', 'browser-use', 'dspy', 'agentscope', 'voltagent', 'genkit'];
  for (const id of expectedExperimentalDocs) {
    const integration = (manifest.integrations || []).find((entry) => entry.id === id);
    if (!integration) fail(`integrations.json missing researched framework entry: ${id}`);
    if (integration?.status !== 'experimental') fail(`${id} must remain experimental until executable framework tests exist`);
  }
}

function assertCapabilityRecords(manifest) {
  const requiredIds = [
    'agent-os',
    'claude-code-plugin',
    'codex-harness-mapping',
    'crewai',
    'harness-core',
    'langgraph',
    'mcp',
    'n8n',
    'openai-agents',
    'opencode-harness-plugin',
  ];
  const integrations = new Map((manifest.integrations || []).map((entry) => [entry.id, entry]));

  for (const id of requiredIds) {
    if (!integrations.get(id)?.capability_record) {
      fail(`integrations.json ${id} must include a capability_record`);
    }
  }

  for (const integration of manifest.integrations || []) {
    const record = integration.capability_record;
    if (!record) continue;
    const { capabilities, evidence, requirements } = record;
    if (evidence.evidence_ref) {
      const evidencePath = path.resolve(root, evidence.evidence_ref);
      const relative = path.relative(root, evidencePath);
      if (relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
        fail(`${integration.id}.capability_record.evidence_ref escapes the repository`);
      } else if (!fs.existsSync(evidencePath)) {
        fail(`${integration.id}.capability_record.evidence_ref does not exist: ${evidence.evidence_ref}`);
      }
    }
    if (evidence.last_verified_at && new Date(evidence.last_verified_at).getTime() > Date.now()) {
      fail(`${integration.id}.capability_record.evidence.last_verified_at is in the future`);
    }
    const tested = [
      capabilities.router_client,
      capabilities.manifest_mapping,
      capabilities.pre_action_enforcement,
      capabilities.agent_os_export,
    ].includes('tested');
    if (tested && (evidence.proof_class === 'static' || !evidence.evidence_ref || !evidence.last_verified_at)) {
      fail(`${integration.id} tested capabilities require non-static dated evidence`);
    }
    if (capabilities.pre_action_enforcement === 'none'
      && ['host_enforced', 'hosted_enforced'].includes(capabilities.approval_support)) {
      fail(`${integration.id} cannot claim enforced approvals without pre-action enforcement`);
    }
    if (capabilities.receipt_support === 'settlement'
      && (evidence.proof_class !== 'settlement' || requirements.spend_capable !== true)) {
      fail(`${integration.id} settlement receipt support requires settlement proof and a spend-capable path`);
    }
  }
}

function assertDiscoveryParity(manifest) {
  const readme = fs.readFileSync(path.join(root, 'README.md'), 'utf8');
  const llms = fs.readFileSync(path.join(root, 'llms.txt'), 'utf8');
  const llmsFull = fs.readFileSync(path.join(root, 'llms-full.txt'), 'utf8');
  const nestedSkill = fs.readFileSync(path.join(root, 'skills', 'agoragentic', 'SKILL.md'), 'utf8');
  if (manifest.discovery?.ecosystem_profile !== 'ecosystem.json') {
    fail('integrations.json discovery.ecosystem_profile must point to ecosystem.json');
  }
  if (manifest.discovery?.ecosystem_profile_schema !== 'ecosystem.schema.json') {
    fail('integrations.json discovery.ecosystem_profile_schema must point to ecosystem.schema.json');
  }

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
  if (!llmsFull.includes(`contains ${manifest.integrations.length} integration surfaces`)) {
    fail(`llms-full.txt must state the canonical manifest count (${manifest.integrations.length})`);
  }
  if (manifest.discovery?.anydoc_document_evidence !== 'examples/anydoc-document-evidence/README.md'
    || manifest.discovery?.anydoc_document_evidence_adapter !== 'examples/anydoc-document-evidence/agoragentic-anydoc.mjs'
    || manifest.discovery?.anydoc_semantic_conformance !== 'examples/anydoc-document-evidence/conformance/README.md') {
    fail('discovery must expose the AnyDoc package documentation, adapter, and semantic conformance contract');
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

function assertProtocolNamespaces(manifest) {
  const clientAdapter = (manifest.integrations || []).find((entry) => entry.id === 'agent-client-protocol');
  if (clientAdapter?.name !== 'Agent Client Protocol') {
    fail('agent-client-protocol integration must keep the explicit Agent Client Protocol name');
  }

  const commerceDraft = (manifest.specs || []).find((entry) => entry.id === 'acp');
  if (commerceDraft?.name !== 'Agoragentic Commerce Draft (legacy Agent Commerce Protocol)') {
    fail('legacy acp spec id must be labeled as the Agoragentic Commerce Draft');
  }
  if (manifest.discovery?.agoragentic_commerce_draft !== 'specs/ACP-SPEC.md'
    || manifest.discovery?.acp_spec !== 'specs/ACP-SPEC.md') {
    fail('discovery must expose the canonical commerce-draft key and preserve acp_spec as its alias');
  }

  const readme = fs.readFileSync(path.join(root, 'README.md'), 'utf8');
  const draft = fs.readFileSync(path.join(root, 'specs', 'ACP-SPEC.md'), 'utf8');
  const registry = fs.readFileSync(path.join(root, 'ACP_REGISTRY.md'), 'utf8');
  const adapterReadme = fs.readFileSync(path.join(root, 'acp', 'README.md'), 'utf8');
  const mcpServer = fs.readFileSync(path.join(root, 'mcp', 'mcp-server.js'), 'utf8');
  if (!readme.includes('## Protocol Names')) fail('README.md must explain the ACP namespace collision');
  if (!draft.includes('not a production wire protocol')) fail('commerce draft must disclaim production wire conformance');
  if (!draft.includes('[Agent Commerce Interchange](https://agoragentic.com/interchange/)')) {
    fail('commerce draft must link to the public Interchange system of record');
  }
  if (draft.includes('github.com/rhein1/agent-marketplace/blob/main/docs')) {
    fail('public commerce draft must not link to private marketplace documentation');
  }
  if (!registry.startsWith('# Agent Client Protocol (ACP) Registry Positioning')) {
    fail('ACP_REGISTRY.md must identify Agent Client Protocol explicitly');
  }
  if (!adapterReadme.includes('Agent Client Protocol (ACP) clients')) {
    fail('acp/README.md must expand Agent Client Protocol on first use');
  }
  if (!mcpServer.includes('Agent Client Protocol adapter')) {
    fail('runtime adapter messages must identify Agent Client Protocol explicitly');
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
  if (glama.version !== packageVersion) {
    fail(`glama.json source-candidate version must match mcp/package.json (${packageVersion})`);
  }
  if (!Array.isArray(glama.packages) || glama.packages.length !== 0) {
    fail('glama.json must not advertise a registry package coordinate while the safe build is unpublished');
  }
  if (!Array.isArray(server.packages) || server.packages.length !== 0) {
    fail('mcp/server.json must not advertise a registry package coordinate while the safe build is unpublished');
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
  if (!/legacy direct-relay.*correction or withdrawal.*unpublished.*non-installable/i.test(glama.description || '')) {
    fail('glama.json must identify the legacy listing and unpublished, non-installable source candidate');
  }
}

function assertDifyRouterFirst() {
  const provider = JSON.parse(fs.readFileSync(path.join(root, 'dify', 'agoragentic_provider.json'), 'utf8'));
  const toolNames = (provider.tools || []).map((tool) => tool.name);
  if (toolNames[0] !== 'agoragentic_execute') fail('Dify first tool must be agoragentic_execute');
  if (toolNames[1] !== 'agoragentic_match') fail('Dify second tool must be agoragentic_match');
}

function assertArdSourceOnly(manifest) {
  const integration = (manifest.integrations || []).find((entry) => entry.id === 'ard-profile');
  if (integration?.status !== 'experimental' || integration?.capability_record?.requirements?.network_required !== false
    || integration?.capability_record?.requirements?.spend_capable !== false) {
    fail('ard-profile must remain experimental, offline, and no-spend');
  }
  const required = {
    ard_profile: 'ard/README.md',
    ard_manifest_candidate: 'ard/generated/ard.json',
    ard_compatibility_manifest_candidate: 'ard/generated/ai-catalog.json',
    ard_upstream_provenance: 'ard/provenance.json',
  };
  for (const [key, value] of Object.entries(required)) {
    if (manifest.discovery?.[key] !== value) fail(`discovery.${key} must point to ${value}`);
  }
  const canonical = fs.readFileSync(path.join(root, 'ard', 'generated', 'ard.json'), 'utf8');
  const compatibility = fs.readFileSync(path.join(root, 'ard', 'generated', 'ai-catalog.json'), 'utf8');
  if (canonical !== compatibility) fail('ARD canonical and predecessor candidate artifacts must remain byte-identical');
}

function assertRiskForkClientAdoption(manifest) {
  const expected = {
    status: 'source_only_default_off',
    package_subpath: './client-adoption',
    package_import: '@agoragentic/risk-fork/client-adoption',
    module: 'risk-fork/src/client-adoption.mjs',
    cli: 'risk-fork/scripts/client-adoption.mjs',
    docs: 'risk-fork/CLIENT_ADOPTION.md',
    schema: 'risk-fork/schema/client-adoption-packet.v1.json',
    stdio_gate: 'risk-fork/clients/one-tool-stdio-gate.mjs',
    expected_tool: 'risk_fork_protect',
    supported_clients: ['claude-code', 'codex', 'cursor'],
    client_enabled: false,
    activation_supported: false,
    executor_bound: false,
    provider_authority_granted: false,
    hosted_authority_granted: false,
    production_authority_granted: false,
    live_traffic_protected: false,
  };
  const entries = [
    ['packages.risk_fork', manifest.packages?.risk_fork],
    ['integrations.risk-fork', (manifest.integrations || []).find((entry) => entry.id === 'risk-fork')],
  ];
  for (const [label, entry] of entries) {
    if (!isDeepStrictEqual(entry?.client_adoption, expected)) {
      fail(`${label}.client_adoption must expose the exact source-only/default-off adoption boundary`);
    }
    const scope = entry?.compatibility_scope || '';
    for (const required of [
      expected.package_import,
      'risk_fork_protect',
      'source-only/default-off',
      'clients remain disabled',
      'live traffic protection false',
    ]) {
      if (!scope.includes(required)) fail(`${label}.compatibility_scope must include ${required}`);
    }
  }

  const discovery = {
    risk_fork_client_adoption: expected.docs,
    risk_fork_client_adoption_module: expected.module,
    risk_fork_client_adoption_cli: expected.cli,
    risk_fork_client_adoption_schema: expected.schema,
    risk_fork_client_stdio_gate: expected.stdio_gate,
  };
  for (const [key, value] of Object.entries(discovery)) {
    if (manifest.discovery?.[key] !== value) fail(`discovery.${key} must point to ${value}`);
    if (!fs.existsSync(path.join(root, value))) fail(`discovery.${key} does not exist: ${value}`);
  }

  const packageJson = JSON.parse(fs.readFileSync(path.join(root, 'risk-fork', 'package.json'), 'utf8'));
  if (packageJson.exports?.[expected.package_subpath] !== './src/client-adoption.mjs') {
    fail('Risk Fork package must expose ./client-adoption from ./src/client-adoption.mjs');
  }
  if (packageJson.scripts?.['client:plan'] !== 'node scripts/client-adoption.mjs plan --client all') {
    fail('Risk Fork package must expose the default-off client:plan workflow');
  }
}

const rawManifest = fs.readFileSync(manifestPath, 'utf8');
const duplicates = topLevelDuplicateKeys(rawManifest);
if (duplicates.length) fail(`integrations.json has duplicate top-level keys: ${duplicates.join(', ')}`);

const manifest = JSON.parse(rawManifest);
assertManifestShape(manifest);
assertInventoryCoverage(manifest);
assertCapabilityRecords(manifest);
assertDiscoveryParity(manifest);
assertMachineCopy();
assertProtocolNamespaces(manifest);
assertRegistryMetadata();
assertA2aRouterFirst();
assertDifyRouterFirst();
assertArdSourceOnly(manifest);
assertRiskForkClientAdoption(manifest);
if (process.exitCode) process.exit(process.exitCode);
console.log('✅ integrations machine-surface verification passed');
