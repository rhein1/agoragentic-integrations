import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import {
  containsDirectMcpEndpoint,
  containsRegistryResolvingMcpCommand,
  containsVersionedMcpCoordinate,
} from '../deliverables/openrouter-top60-integration-pack/scripts/validate.mjs';

const root = path.resolve(import.meta.dirname, '..');
const require = createRequire(import.meta.url);
const { runCli } = require(path.join(root, 'sdk', 'node', 'agent-os.js'));

function read(relativePath) {
  return fs.readFileSync(path.join(root, relativePath), 'utf8');
}

function readJson(relativePath) {
  return JSON.parse(read(relativePath));
}

function trackedTextFiles() {
  return execFileSync('git', ['ls-files', '-z'], { cwd: root })
    .toString('utf8')
    .split('\0')
    .filter(Boolean)
    .filter((relativePath) => relativePath !== 'CHANGELOG.md')
    .filter((relativePath) => relativePath !== 'test/mcp-direct-bypass.test.mjs')
    .filter((relativePath) => fs.existsSync(path.join(root, relativePath)))
    .filter((relativePath) => {
      const bytes = fs.readFileSync(path.join(root, relativePath));
      return bytes.length <= 5 * 1024 * 1024 && !bytes.includes(0);
    });
}

function captureIo() {
  let stdout = '';
  let stderr = '';
  return {
    io: {
      stdout: { write: (value) => { stdout += String(value); } },
      stderr: { write: (value) => { stderr += String(value); } },
    },
    stdout: () => stdout,
    stderr: () => stderr,
  };
}

test('Agent OS CLI MCP status emits no runnable config or credential and --run has zero spawn side effects', async () => {
  let spawnCount = 0;
  const runtime = { spawn: () => { spawnCount += 1; throw new Error('must not spawn'); } };
  const secret = 'raw-secret-value-not-pattern';

  const statusCapture = captureIo();
  const statusCode = await runCli(['mcp'], { AGORAGENTIC_API_KEY: secret }, statusCapture.io, runtime);
  assert.equal(statusCode, 0);
  assert.equal(spawnCount, 0);
  assert.equal(statusCapture.stderr(), '');
  assert.doesNotMatch(statusCapture.stdout(), new RegExp(secret));
  const status = JSON.parse(statusCapture.stdout());
  assert.equal(status.result.operational, false);
  assert.equal(status.result.status, 'blocked_pending_qualified_host_enforcement');
  assert.equal(status.result.config, null);
  assert.equal(status.result.install, null);
  assert.deepEqual(status.result.tools, []);

  const runCapture = captureIo();
  const runCode = await runCli(['mcp', '--run'], { AGORAGENTIC_API_KEY: secret }, runCapture.io, runtime);
  assert.equal(runCode, 2);
  assert.equal(spawnCount, 0);
  assert.equal(runCapture.stdout(), '');
  assert.match(runCapture.stderr(), /MCP_RISK_FORK_ENFORCEMENT_REQUIRED/);
  assert.doesNotMatch(runCapture.stderr(), new RegExp(secret));
});

test('published SDK, ACP, and catalog metadata mark MCP non-operational without a direct endpoint', () => {
  const toolkit = readJson('sdk/node/agent-toolkit.generated.json');
  assert.equal(toolkit.package.mcp_command, null);
  assert.equal(toolkit.package.mcp_protocol_command, null);
  assert.equal(toolkit.package.mcp_transport.operational, false);
  assert.equal(toolkit.package.mcp_transport.status, 'blocked_pending_qualified_host_enforcement');
  assert.equal(toolkit.package.mcp_transport.remote_url, null);

  const acp = readJson('acp/agent.json');
  assert.equal(acp.runtime.command, null);
  assert.deepEqual(acp.runtime.args, []);
  assert.equal(acp.runtime.source_checkout.command, 'node');
  assert.deepEqual(acp.runtime.source_checkout.args, ['mcp/dist/mcp-server.cjs', '--acp']);
  assert.equal(acp.runtime.operational, false);
  assert.equal(acp.runtime.status, 'blocked_pending_qualified_host_enforcement');
  assert.deepEqual(acp.auth, []);
  assert.deepEqual(acp.recommended_tools, []);

  const catalog = readJson('docs/catalog-profile.json');
  assert.equal(catalog.mcp.npm_package, null);
  assert.equal(catalog.mcp.package_version, null);
  assert.equal(catalog.mcp.source_candidate_version, '2.0.0');
  assert.equal(catalog.mcp.distribution_status, 'unpublished_noninstallable_source_candidate');
  assert.equal(catalog.mcp.command, null);
  assert.equal(catalog.mcp.protocol_reference_command, null);
  assert.equal(catalog.mcp.operational, false);
  assert.equal(catalog.mcp.remote_endpoint, null);

  assert.equal(readJson('.cursor-plugin/plugin.json').mcpServers, undefined);
  assert.equal(readJson('gemini-extension.json').mcpServers, undefined);
  assert.equal(readJson('claude-code/plugin/.claude-plugin/plugin.json').mcpServers, undefined);
  assert.deepEqual(readJson('claude-code/plugin/.mcp.json').mcpServers, {});
  assert.deepEqual(readJson('glama.json').packages, []);
  assert.deepEqual(readJson('mcp/server.json').packages, []);
  assert.equal(readJson('zapier-mcp/agoragentic-zapier-mcp.example.json').mcpServers.agoragentic, undefined);
});

test('current source, docs, manifests, generated files, scripts, examples, and CI expose no registry-resolving MCP command', () => {
  const banned = [
    {
      label: 'npm latest-version badge',
      pattern: new RegExp(`img\\.shields\\.io/npm/v/agoragentic-${'mcp'}`, 'i'),
    },
    {
      label: 'false claim that the public or standalone registry package is fail-closed',
      pattern: /(?:public|standalone) (?:MCP )?package[^.\r\n]*(?:fail[- ]closed|owns no upstream network)/i,
    },
  ];

  for (const relativePath of trackedTextFiles()) {
    const text = read(relativePath);
    assert.equal(containsRegistryResolvingMcpCommand(text), false, `${relativePath} contains a registry-resolving MCP command`);
    assert.equal(containsVersionedMcpCoordinate(text), false, `${relativePath} contains a versioned MCP package coordinate`);
    for (const { label, pattern } of banned) {
      assert.doesNotMatch(text, pattern, `${relativePath} contains a ${label}`);
    }
  }

  const packageJson = readJson('mcp/package.json');
  assert.equal(packageJson.version, '2.0.0');
  assert.match(packageJson.description, /unpublished.*non-installable/i);
  assert.match(read('mcp/README.md'), /2\.0\.0.*unpublished.*non-installable/is);
});

test('Risk Fork hackathon onboarding is pinned-local and preserves the demo truth boundary', () => {
  const entrypoint = 'risk-fork/hackathon/bin/risk-fork-demo.mjs';
  const banner = 'DEMO ONLY — LOCAL PROTOCOL SIMULATOR — NOT AN ISOLATION BOUNDARY — NO LIVE PROTECTION';
  const onboardingSurfaces = [
    'README.md',
    'llms.txt',
    'llms-full.txt',
    'risk-fork/hackathon/README.md',
    'risk-fork/hackathon/docs/QUICKSTART.md',
    'risk-fork/hackathon/docs/CLEANUP_TROUBLESHOOTING.md',
    'risk-fork/discovery/skill.md',
  ];

  for (const relativePath of onboardingSurfaces) {
    const text = read(relativePath);
    assert.match(text, new RegExp(entrypoint.replaceAll('/', '\\/')), `${relativePath} must name the local demo entrypoint`);
    assert.equal(containsRegistryResolvingMcpCommand(text), false, `${relativePath} contains a registry-resolving MCP command`);
    assert.doesNotMatch(text, /npx\s+(?:--yes\s+)?agoragentic-mcp/i, `${relativePath} contains stale Risk Fork MCP onboarding`);
  }

  for (const relativePath of [
    'risk-fork/hackathon/README.md',
    'risk-fork/hackathon/docs/QUICKSTART.md',
    'risk-fork/hackathon/docs/CLEANUP_TROUBLESHOOTING.md',
    'risk-fork/discovery/skill.md',
  ]) {
    assert.match(read(relativePath), new RegExp(banner), `${relativePath} must display the exact demo banner`);
  }

  const expectedTruth = {
    source_available: true,
    demo_available: true,
    demo_only: true,
    local_protocol_simulator: true,
    production_ready: false,
    live_traffic_protected: false,
    authority_granted: false,
    provider_calls: 0,
    network_used: false,
    credentials_used: false,
    clean_commit_performed: false,
    npm_published: false,
    hosted_enabled: false,
  };
  const status = readJson('risk-fork/hackathon/demo-status.json');
  const capability = readJson('risk-fork/discovery/risk-fork-capability.json');
  assert.equal(status.entrypoint, entrypoint);
  assert.equal(capability.entrypoint, entrypoint);
  assert.equal(status.banner, banner);
  assert.equal(capability.banner, banner);
  assert.deepEqual(status.truth, expectedTruth);
  assert.deepEqual(capability.truth, expectedTruth);
  for (const surface of [status, capability]) {
    assert.equal(surface.provider, 'e2b');
    assert.equal(surface.provider_status, 'not_live_qualified');
    assert.equal(surface.production_qualified, false);
    assert.equal(surface.live_agoragentic_traffic_protected, false);
    assert.equal(surface.hosted_execution_enabled, false);
    assert.equal(surface.provider_qualification.e2b, 'not_live_qualified');
  }
  assert.equal(status.supported_node, '>=20');
  assert.equal(capability.supported_node, '>=20');
  assert.equal(capability.allowed_scenario_ids.length, 17);
  assert.equal(capability.limits.active_runs, 1);
  assert.equal(capability.limits.completed_runs_before_cleanup_reset, 10);
  assert.equal(capability.limits.daily_limit, null);
  assert.equal(status.configuration.command, 'node');
  assert.equal(capability.configuration.command, 'node');
  assert.equal(status.configuration.registry_resolution_allowed, false);
  assert.equal(status.configuration.write_requires_yes, true);
  assert.equal(status.configuration.client_configuration_modified, false);
  assert.equal(capability.configuration.client_configuration_modified, false);

  const manifest = readJson('integrations.json');
  assert.equal(manifest.discovery.risk_fork_hackathon_demo, 'risk-fork/hackathon/README.md');
  assert.equal(manifest.discovery.risk_fork_hackathon_status, 'risk-fork/hackathon/demo-status.json');
  assert.equal(manifest.discovery.risk_fork_capability_card, 'risk-fork/discovery/risk-fork-capability.json');
  assert.equal(manifest.discovery.risk_fork_agent_skill, 'risk-fork/discovery/skill.md');
});

test('shared MCP policy matcher rejects command and endpoint spelling variants', () => {
  const packageName = `agoragentic-${'mcp'}`;
  for (const command of [
    `npx "${packageName}" --stdio`,
    `npx "agoragentic"-mcp --stdio`,
    `npx ${packageName}&& echo unsafe`,
    `npx.cmd --yes ${packageName}`,
    `npx --package=${packageName} harmless`,
    `npx --package=alias@npm:${packageName} alias`,
    `npx -p ${packageName} harmless`,
    `npx.ps1 ${packageName}`,
    `npm exec ${packageName}`,
    `npm --prefix ./tmp exec ${packageName}`,
    `pnpm dlx ${packageName}`,
    `pnpm --dir ./tmp dlx ${packageName}`,
    `yarn dlx ${packageName}`,
    `bunx ${packageName}`,
    `pnpx ${packageName}`,
    `bun x ${packageName}`,
    `sh -c 'npx ${packageName}'`,
    `bash -lc "npx ${packageName}"`,
    `cmd /c "npx ${packageName}"`,
    `powershell -Command "npx ${packageName}"`,
  ]) {
    assert.equal(containsRegistryResolvingMcpCommand(command), true, command);
  }
  for (const endpoint of [
    `https://agoragentic.com/api/${'mcp'}`,
    `https://agoragentic.com:443/api/${'mcp'}`,
    `https://agoragentic.com/api/%6dcp`,
    `https://agoragentic.com/API/${'MCP'}`,
    `https://www.agoragentic.com/api/${'mcp'}`,
    String.raw`https:\agoragentic.com\api\mcp`,
  ]) {
    assert.equal(containsDirectMcpEndpoint(endpoint), true, endpoint);
  }
});

test('OpenRouter review-pack MCP host records are blocker-only and non-runnable', () => {
  const packPrefix = 'deliverables/openrouter-top60-integration-pack';
  assert.equal(fs.existsSync(path.join(root, packPrefix, 'host-configs.json')), false);

  const packet = readJson(`${packPrefix}/decisions/blocked-qualified-host-enforcement.json`);
  assert.equal(packet.group, 'blocked_pending_qualified_host_enforcement');
  assert.equal(packet.runtime_verified, false);
  assert.equal(packet.authority_granted, false);
  assert.equal(packet.items.length, 12);

  function assertBlocked(value, label) {
    if (typeof value === 'string') {
      assert.equal(containsVersionedMcpCoordinate(value), false, `${label} contains a versioned registry coordinate`);
      assert.equal(containsRegistryResolvingMcpCommand(value), false, `${label} contains a registry-resolving command`);
      assert.equal(containsDirectMcpEndpoint(value), false, `${label} contains the direct hosted MCP endpoint`);
      return;
    }
    if (Array.isArray(value)) {
      assert.equal(containsRegistryResolvingMcpCommand(value), false, `${label} contains split registry-runner arguments`);
      value.forEach((item, index) => assertBlocked(item, `${label}[${index}]`));
      return;
    }
    if (!value || typeof value !== 'object') return;
    for (const [key, child] of Object.entries(value)) {
      assert.doesNotMatch(
        key,
        /^(?:command|cmd|executable|args|configuration|url|headers?|authorization|enabled)$/i,
        `${label}.${key} is a runnable MCP configuration field`,
      );
      assertBlocked(child, `${label}.${key}`);
    }
  }

  for (const [index, item] of packet.items.entries()) {
    assert.equal(item.runtime_verified, false);
    assert.equal(item.authority_granted, false);
    assert.ok(Array.isArray(item.required_controls) && item.required_controls.length > 0);
    assertBlocked(item, `blocked host decision ${index}`);
  }
});

test('unqualified MCP 2.0.0 source candidate is mechanically non-publishable', () => {
  const packageJson = readJson('mcp/package.json');
  assert.equal(packageJson.private, true);
  assert.match(packageJson.scripts.prepublishOnly, /MCP_PUBLISH_DISABLED_UNQUALIFIED_SOURCE_CANDIDATE/);

  const publishWorkflow = read('.github/workflows/publish-mcp.yml');
  assert.match(publishWorkflow, /publication remains disabled/i);
  assert.doesNotMatch(publishWorkflow, /^\s*release:/m);
  assert.doesNotMatch(publishWorkflow, /npm\s+publish/i);
  assert.doesNotMatch(publishWorkflow, /id-token:\s*write/i);
});

test('DeepAgents MCP compatibility path is hard-disabled before optional imports or transport I/O', () => {
  const adapter = read('langchain/deepagents_adapter.py');
  assert.match(adapter, /MCP_ENFORCEMENT_REQUIRED\s*=/);
  assert.match(adapter, /async def load_agoragentic_mcp_tools[\s\S]*?raise RuntimeError\(MCP_ENFORCEMENT_REQUIRED\)/);
  assert.doesNotMatch(adapter, /langchain_mcp_adapters|build_mcp_client|mcp_tools_to_langchain|mcp-server-agoragentic|\.connect\(/);

  const readme = read('deepagents/README.md');
  assert.match(readme, /MCP.*blocked.*qualified host enforcement/is);
  assert.doesNotMatch(readme, /MCPToolkit|\.well-known\/mcp\/server-card\.json/);
});

test('community runtime cohort excludes MCP and external direct-relay listings require correction or withdrawal', () => {
  const communityTesting = read('docs/COMMUNITY_TESTING.md');
  assert.doesNotMatch(communityTesting, /^\| MCP \|/m);
  assert.match(communityTesting, /MCP.*excluded.*runtime/is);

  const profile = readJson('docs/catalog-profile.json');
  const legacyMcpChannels = new Set([
    'npm',
    'official-mcp-registry',
    'smithery',
    'glama',
    'pulsemcp',
    'mcp-so',
    'cline-marketplace',
    'docker-mcp-catalog',
  ]);
  for (const channel of profile.channels.filter(({ id }) => legacyMcpChannels.has(id))) {
    assert.match(channel.status, /^legacy_direct_relay_(?:correction|withdrawal)_required$/);
    assert.match(channel.note, /legacy|withdraw|correct/i);
  }
  assert.equal(
    profile.channels.filter(({ id }) => legacyMcpChannels.has(id)).length,
    legacyMcpChannels.size,
  );
});

test('assigned client surfaces contain no direct hosted MCP transport or raw credential forwarding', () => {
  const directTransportSurfaces = [
    'haystack/agoragentic_haystack.py',
    'sdk/node/agent-os.js',
    'sdk/node/agent-toolkit.generated.json',
    'sdk/python/examples/openai_agents_mcp_buyer.py',
    'acp/agent.json',
    'docs/catalog-profile.json',
    'distribution/context-hub/content/agoragentic/docs/agent-os-api/javascript/DOC.md',
    'glama.json',
    'zapier-mcp/agoragentic-zapier-mcp.example.json',
  ];
  for (const relativePath of directTransportSurfaces) {
    assert.equal(containsDirectMcpEndpoint(read(relativePath)), false, `${relativePath} must not advertise the direct MCP endpoint`);
  }

  const haystack = read('haystack/agoragentic_haystack.py');
  assert.match(haystack, /raise RuntimeError\(MCP_ENFORCEMENT_REQUIRED\)/);
  assert.doesNotMatch(haystack, /MCPToolset|StreamableHttpServerInfo/);

  const pythonExample = read('sdk/python/examples/openai_agents_mcp_buyer.py');
  assert.match(pythonExample, /raise RuntimeError\(MCP_ENFORCEMENT_REQUIRED\)/);
  assert.doesNotMatch(pythonExample, /MCPServerStdio|AGORAGENTIC_API_KEY|agoragentic-mcp/);
});

test('legacy PR submission helper cannot publish stale MCP or credential-bearing configuration', () => {
  const submissionHelper = read('submit-prs.mjs');
  assert.match(submissionHelper, /EXTERNAL_SUBMISSION_DISABLED/);
  assert.doesNotMatch(submissionHelper, /https\.request|GITHUB_TOKEN|\/pulls|AGORAGENTIC_API_KEY/);
});
