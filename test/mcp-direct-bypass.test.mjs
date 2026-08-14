import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';

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
      label: 'registry-resolving npx command',
      pattern: new RegExp(String.raw`\bnpx(?:\s+-y)?\s+agoragentic-${'mcp'}(?:@[^\s\x60"']+)?`, 'i'),
    },
    {
      label: 'legacy or fictitious MCP package coordinate',
      pattern: new RegExp(`agoragentic-${'mcp'}@(?:latest|1\\.3\\.6|2\\.0\\.0)`, 'i'),
    },
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
    for (const { label, pattern } of banned) {
      assert.doesNotMatch(text, pattern, `${relativePath} contains a ${label}`);
    }
  }

  const packageJson = readJson('mcp/package.json');
  assert.equal(packageJson.version, '2.0.0');
  assert.match(packageJson.description, /unpublished.*non-installable/i);
  assert.match(read('mcp/README.md'), /2\.0\.0.*unpublished.*non-installable/is);
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
    assert.doesNotMatch(read(relativePath), /https:\/\/agoragentic\.com\/api\/mcp/i, `${relativePath} must not advertise the direct MCP endpoint`);
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
