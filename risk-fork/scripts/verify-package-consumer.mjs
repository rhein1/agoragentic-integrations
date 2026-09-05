import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const packageRoot = fileURLToPath(new URL('../', import.meta.url));
const npmCli = process.env.npm_execpath;
if (!npmCli || !path.isAbsolute(npmCli)) {
  throw new Error('Run npm --prefix risk-fork run test:package so the local npm CLI is explicit');
}
const tempRoot = await mkdtemp(path.join(tmpdir(), 'risk-fork-packed-consumer-'));
const consumerRoot = path.join(tempRoot, 'consumer');
const environment = { ...process.env, NODE_OPTIONS: '', NODE_PATH: '' };
const explicitCache = process.env.RISK_FORK_NPM_CACHE;
if (explicitCache !== undefined && !path.isAbsolute(explicitCache)) {
  throw new Error('RISK_FORK_NPM_CACHE must be an absolute path');
}

function run(label, executable, args, cwd) {
  let commandArgs = args;
  if (explicitCache && executable === process.execPath && args[0] === npmCli) {
    const separator = args.indexOf('--');
    commandArgs = separator === -1
      ? [...args, '--cache', explicitCache]
      : [...args.slice(0, separator), '--cache', explicitCache, ...args.slice(separator)];
  }
  const result = spawnSync(executable, commandArgs, {
    cwd, env: environment, encoding: 'utf8', timeout: 120_000, maxBuffer: 4 * 1024 * 1024,
    windowsHide: true,
  });
  if (result.error || result.status !== 0) {
    // npm's raw output can contain local configuration. Keep failure reporting bounded.
    const npmCode = result.stderr?.match(/npm (?:error|ERR!) code ([A-Z][A-Z0-9_]{1,30})\b/)?.[1];
    throw new Error(`${label} failed (exit ${result.status ?? 'unknown'}; ${result.error?.code ?? npmCode ?? 'process_error'})`);
  }
  return result.stdout;
}

try {
  await mkdir(consumerRoot);
  const packed = JSON.parse(run('npm pack', process.execPath, [
    npmCli, 'pack', '--ignore-scripts', '--json', '--pack-destination', tempRoot,
  ], packageRoot));
  assert.equal(packed.length, 1);
  const entry = packed[0];
  assert.match(entry.filename, /^agoragentic-risk-fork-\d+\.\d+\.\d+-alpha\.\d+\.tgz$/);
  const tarball = path.join(tempRoot, entry.filename);
  const included = new Set(entry.files.map(file => file.path));
  for (const expected of [
    'LICENSE', 'NOTICE', 'CITATION.cff', 'AUTHORS.md', 'GETTING_STARTED.md',
    'CLIENT_ADOPTION.md', 'clients/one-tool-stdio-gate.mjs',
    'assets/risk-fork-social-preview.svg', 'src/host-boundary.mjs',
    'src/mcp-host-adapter.mjs', 'src/mcp-transport-contract.mjs',
    'e2b-template/lib/mcp-http-phase.mjs', 'examples/mcp-host-adapter.mjs',
    'src/framework-tool-adapter.mjs', 'src/frameworks/openai-agents.mjs',
    'src/frameworks/langchain.mjs', 'src/frameworks/langgraph.mjs',
    'examples/local-reference.mjs', 'examples/framework-adapters.mjs',
    'FRAMEWORK_ADAPTERS.md', 'src/client-adoption.mjs',
  ]) assert.ok(included.has(expected), `Packed file missing: ${expected}`);
  for (const file of included) {
    assert.ok(!/(?:^|\/)(?:node_modules|\.git|\.env|test|hackathon)(?:\/|$)/.test(file), `Unexpected package path: ${file}`);
    assert.ok(!file.endsWith('.tgz') && !file.endsWith('.zip'), 'Nested release artifact');
  }
  for (const document of [
    'README.md',
    'GETTING_STARTED.md',
    'AUTHORS.md',
    'MCP_HOST_ADAPTER.md',
    'FRAMEWORK_ADAPTERS.md',
    'CLIENT_ADOPTION.md',
  ]) {
    const markdown = await readFile(path.join(packageRoot, document), 'utf8');
    for (const match of markdown.matchAll(/\]\((\.\.?\/[^)#]+)(?:#[^)]*)?\)/g)) {
      const target = path.posix.normalize(path.posix.join(path.posix.dirname(document), match[1]));
      assert.ok(included.has(target), `Packed documentation link is missing: ${document} -> ${target}`);
    }
  }
  const sourceManifest = JSON.parse(await readFile(path.join(packageRoot, 'package.json'), 'utf8'));
  const sourceLock = JSON.parse(await readFile(path.join(packageRoot, 'package-lock.json'), 'utf8'));
  assert.equal(sourceLock.lockfileVersion, 3);
  assert.equal(sourceLock.packages[''].version, entry.version);
  assert.deepEqual(sourceLock.packages[''].dependencies, sourceManifest.dependencies);
  const localTarballRef = `file:../${entry.filename}`;
  const consumerManifest = {
    name: 'risk-fork-clean-package-consumer', private: true, version: '1.0.0', type: 'module',
    dependencies: { [entry.name]: localTarballRef },
  };
  const dependencyEntries = Object.fromEntries(Object.entries(sourceLock.packages)
    .filter(([location, dependency]) => location !== '' && dependency.dev !== true));
  const packageLocation = `node_modules/${entry.name}`;
  assert.equal(dependencyEntries[packageLocation], undefined);
  const installedPackageLock = {
    version: entry.version, resolved: localTarballRef, integrity: entry.integrity,
  };
  for (const key of ['license', 'dependencies', 'engines', 'peerDependencies', 'peerDependenciesMeta']) {
    if (sourceManifest[key] !== undefined) installedPackageLock[key] = sourceManifest[key];
  }
  // npm ci warms exact tarball content, not registry packuments. A fresh unlocked
  // npm install can still require uncached metadata. Preserve the reviewed graph
  // while installing the actual packed artifact, never a copied source directory.
  await writeFile(path.join(consumerRoot, 'package.json'), JSON.stringify(consumerManifest));
  await writeFile(path.join(consumerRoot, 'package-lock.json'), JSON.stringify({
    name: consumerManifest.name, version: consumerManifest.version, lockfileVersion: 3, requires: true,
    packages: {
      '': consumerManifest,
      [packageLocation]: installedPackageLock,
      ...dependencyEntries,
    },
  }));
  run('offline consumer install (run npm ci first to warm the npm cache)', process.execPath, [
    npmCli, 'ci', '--offline', '--ignore-scripts', '--no-audit', '--no-fund',
    '--omit=dev', '--omit=optional',
  ], consumerRoot);
  let verifiedDependencyCount = 0;
  for (const [location, dependency] of Object.entries(dependencyEntries)) {
    if (dependency.optional === true) continue;
    assert.match(location, /^node_modules\/(?:@[^/]+\/)?[^/]+(?:\/node_modules\/(?:@[^/]+\/)?[^/]+)*$/);
    const installedDependency = JSON.parse(await readFile(path.join(consumerRoot, location, 'package.json'), 'utf8'));
    assert.equal(installedDependency.version, dependency.version, `Installed dependency version drift: ${location}`);
    verifiedDependencyCount += 1;
  }
  const installedRoot = path.join(consumerRoot, 'node_modules/@agoragentic/risk-fork');
  const manifest = JSON.parse(await readFile(path.join(installedRoot, 'package.json'), 'utf8'));
  for (const key of ['name', 'version', 'dependencies', 'peerDependencies', 'peerDependenciesMeta', 'engines']) {
    assert.deepEqual(manifest[key], sourceManifest[key], `Packed manifest drift: ${key}`);
  }
  assert.equal(manifest.version, entry.version);
  assert.equal(manifest.license, 'Apache-2.0');
  assert.equal(manifest.private, false);
  assert.equal(manifest.publishConfig.tag, 'alpha');
  assert.equal(manifest.publishConfig.provenance, true);
  assert.deepEqual(manifest.author, { name: 'Jeremy Borden', url: 'https://agoragentic.com' });
  assert.equal(
    await readFile(path.join(installedRoot, 'NOTICE'), 'utf8'),
    await readFile(path.join(packageRoot, 'NOTICE'), 'utf8'),
  );
  const externalGateway = path.join(tempRoot, 'risk-forkd.js');
  await writeFile(externalGateway, "'use strict';\nprocess.exitCode = 78;\n", 'utf8');
  const installedClientPlan = JSON.parse(run(
    'installed client adoption plan',
    process.execPath,
    [
      npmCli,
      'run',
      '--silent',
      'client:plan',
      '--',
      '--gateway',
      externalGateway,
    ],
    installedRoot,
  ));
  assert.equal(installedClientPlan.status, 'source_only_default_off');
  assert.equal(installedClientPlan.gateway.gateway_entrypoint, externalGateway);
  assert.equal(installedClientPlan.gateway.runtime_closure_bound, false);
  assert.equal(installedClientPlan.controls.client_enabled, false);
  assert.equal(installedClientPlan.controls.provider_calls, 0);
  assert.equal(installedClientPlan.controls.live_traffic_protected, false);

  run('installed package exports', process.execPath, ['--input-type=module', '--eval', `
    import assert from 'node:assert/strict';
    import * as core from '@agoragentic/risk-fork';
    import * as host from '@agoragentic/risk-fork/host-boundary';
    import * as mcp from '@agoragentic/risk-fork/mcp-host-adapter';
    import * as mcpTransport from '@agoragentic/risk-fork/mcp-transport-contract';
    import * as mcpRuntime from '@agoragentic/risk-fork/e2b-template/mcp-http-phase';
    import * as framework from '@agoragentic/risk-fork/framework-tool-adapter';
    import * as openai from '@agoragentic/risk-fork/frameworks/openai-agents';
    import * as langchain from '@agoragentic/risk-fork/frameworks/langchain';
    import * as langgraph from '@agoragentic/risk-fork/frameworks/langgraph';
    import * as clients from '@agoragentic/risk-fork/client-adoption';
    assert.equal(typeof core.RiskForkController, 'function');
    assert.equal(typeof core.LocalReferenceRiskForkAdapter, 'function');
    assert.equal(typeof core.verifyPostgresAuthorityAuditPage, 'function');
    assert.equal(typeof host.createRiskForkHostBoundary, 'function');
    assert.equal(typeof mcp.createRiskForkMcpHostAdapter, 'function');
    assert.equal(typeof mcp.createTrustedRiskForkMcpPhasePlanSource, 'function');
    assert.equal(typeof mcpTransport.validateMcpHttpPhaseOperation, 'function');
    assert.equal(typeof mcpRuntime.createMcpHttpPhaseRuntime, 'function');
    assert.equal(mcpRuntime.isMcpHttpPhaseRuntime(mcpRuntime.executeMcpHttpPhase), true);
    assert.equal(core.createRiskForkMcpHostAdapter, mcp.createRiskForkMcpHostAdapter);
    assert.equal(typeof framework.createRiskForkFrameworkToolAdapter, 'function');
    assert.equal(typeof framework.createTrustedRiskForkFrameworkExecutor, 'function');
    assert.equal(typeof openai.createOpenAIAgentsRiskForkTool, 'function');
    assert.equal(typeof langchain.createLangChainRiskForkTool, 'function');
    assert.equal(typeof langgraph.createLangGraphRiskForkNode, 'function');
    assert.equal(clients.RISK_FORK_GATEWAY_TOOL, 'risk_fork_protect');
    assert.deepEqual(clients.RISK_FORK_CLIENTS, ['claude-code', 'codex', 'cursor']);
    assert.equal(core.createRiskForkClientAdoptionPacket, clients.createRiskForkClientAdoptionPacket);
    assert.equal(typeof clients.verifyRiskForkClientAdoptionPacket, 'function');
    assert.equal(
      core.verifyRiskForkClientAdoptionPacket,
      clients.verifyRiskForkClientAdoptionPacket,
    );
    assert.equal(
      clients.verifyRiskForkClientAdoptionPacket(${JSON.stringify(installedClientPlan)}),
      true,
    );
  `], consumerRoot);
  const lifecycle = JSON.parse(run('installed local lifecycle', process.execPath, [
    path.join(installedRoot, 'examples/local-reference.mjs'),
  ], consumerRoot));
  assert.equal(lifecycle.status, 'prepared_not_committed');
  assert.equal(lifecycle.fork_destruction_status, 'verified');
  assert.equal(lifecycle.savepoint_destruction_status, 'verified');
  assert.equal(lifecycle.network_used, false);
  assert.equal(lifecycle.credentials_used, false);
  assert.equal(lifecycle.clean_commit_performed, false);
  const mcpExample = JSON.parse(run('installed MCP host example', process.execPath, [
    path.join(installedRoot, 'examples/mcp-host-adapter.mjs'),
  ], consumerRoot));
  assert.equal(mcpExample.status, 'passed');
  assert.equal(mcpExample.demo_only, true);
  assert.equal(mcpExample.isolation_boundary, false);
  assert.equal(mcpExample.live_protection, false);
  assert.equal(mcpExample.direct_transport_exposed, false);
  assert.equal(mcpExample.fallback_execution_permitted, false);
  assert.equal(mcpExample.authority_granted, false);
  assert.equal(mcpExample.cleanup_verified, true);
  assert.deepEqual(mcpExample.observed_phases, ['server/discover', 'tools/list']);
  assert.ok(mcpExample.fork_count >= 2 && mcpExample.savepoint_count >= 2);
  const frameworkExample = JSON.parse(run('installed framework adapter example', process.execPath, [
    path.join(installedRoot, 'examples/framework-adapters.mjs'),
  ], consumerRoot));
  assert.equal(frameworkExample.status, 'passed');
  assert.equal(frameworkExample.source_only, true);
  assert.equal(frameworkExample.default_on, false);
  assert.equal(frameworkExample.classification_only, true);
  assert.equal(frameworkExample.provider_qualified, false);
  assert.equal(frameworkExample.live_traffic_protected, false);
  assert.equal(frameworkExample.model_calls, 0);
  assert.equal(frameworkExample.network_calls, 0);
  assert.equal(frameworkExample.provider_calls, 0);
  assert.equal(frameworkExample.direct_effect_calls, 0);
  assert.equal(frameworkExample.clean_commit_calls, 0);
  assert.equal(frameworkExample.receipts_retained, 3);
  assert.deepEqual(
    frameworkExample.frameworks.map(entry => entry.framework),
    ['openai-agents', 'langchain', 'langgraph'],
  );
  process.stdout.write(`${JSON.stringify({
    schema: 'agoragentic.risk-fork.packed-consumer-check.v1',
    status: 'passed', package: manifest.name, version: manifest.version,
    tarball_sha256: createHash('sha256').update(await readFile(tarball)).digest('hex'),
    packed_files: included.size, packed_bytes: entry.size,
    offline_install: true, dependency_resolution: 'exact_source_lock',
    verified_dependency_count: verifiedDependencyCount,
    installed_exports: true, mcp_http_phase_exports: 'verified', local_lifecycle: 'verified',
    mcp_host_example: 'passed', framework_adapter_example: 'passed',
    installed_client_plan: 'passed',
    registry_publication_verified: false,
    live_traffic_protected: false, provider_calls: 0,
  }, null, 2)}\n`);
} finally {
  // Only the unique test directory allocated above can be removed.
  await rm(tempRoot, { recursive: true, force: true });
}
