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

function run(label, executable, args, cwd) {
  const result = spawnSync(executable, args, {
    cwd, env: environment, encoding: 'utf8', timeout: 120_000, maxBuffer: 4 * 1024 * 1024,
    windowsHide: true,
  });
  if (result.error || result.status !== 0) {
    // npm's raw output can contain local configuration. Keep failure reporting bounded.
    throw new Error(`${label} failed (exit ${result.status ?? 'unknown'}; ${result.error?.code ?? 'process_error'})`);
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
    'assets/risk-fork-social-preview.svg', 'src/host-boundary.mjs',
    'src/mcp-host-adapter.mjs', 'examples/mcp-host-adapter.mjs',
    'examples/local-reference.mjs',
  ]) assert.ok(included.has(expected), `Packed file missing: ${expected}`);
  for (const file of included) {
    assert.ok(!/(?:^|\/)(?:node_modules|\.git|\.env|test|hackathon)(?:\/|$)/.test(file), `Unexpected package path: ${file}`);
    assert.ok(!file.endsWith('.tgz') && !file.endsWith('.zip'), 'Nested release artifact');
  }
  for (const document of ['README.md', 'GETTING_STARTED.md', 'AUTHORS.md', 'MCP_HOST_ADAPTER.md']) {
    const markdown = await readFile(path.join(packageRoot, document), 'utf8');
    for (const match of markdown.matchAll(/\]\((\.\.?\/[^)#]+)(?:#[^)]*)?\)/g)) {
      const target = path.posix.normalize(path.posix.join(path.posix.dirname(document), match[1]));
      assert.ok(included.has(target), `Packed documentation link is missing: ${document} -> ${target}`);
    }
  }
  await writeFile(path.join(consumerRoot, 'package.json'), JSON.stringify({
    name: 'risk-fork-clean-package-consumer', private: true, version: '1.0.0', type: 'module',
  }));
  run('offline consumer install (run npm ci first to warm the npm cache)', process.execPath, [
    npmCli, 'install', '--offline', '--ignore-scripts', '--no-audit', '--no-fund',
    '--omit=optional', '--save-exact', tarball,
  ], consumerRoot);
  const installedRoot = path.join(consumerRoot, 'node_modules/@agoragentic/risk-fork');
  const manifest = JSON.parse(await readFile(path.join(installedRoot, 'package.json'), 'utf8'));
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

  run('installed package exports', process.execPath, ['--input-type=module', '--eval', `
    import assert from 'node:assert/strict';
    import * as core from '@agoragentic/risk-fork';
    import * as host from '@agoragentic/risk-fork/host-boundary';
    import * as mcp from '@agoragentic/risk-fork/mcp-host-adapter';
    assert.equal(typeof core.RiskForkController, 'function');
    assert.equal(typeof core.LocalReferenceRiskForkAdapter, 'function');
    assert.equal(typeof host.createRiskForkHostBoundary, 'function');
    assert.equal(typeof mcp.createRiskForkMcpHostAdapter, 'function');
    assert.equal(typeof mcp.createTrustedRiskForkMcpPhasePlanSource, 'function');
    assert.equal(core.createRiskForkMcpHostAdapter, mcp.createRiskForkMcpHostAdapter);
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
  process.stdout.write(`${JSON.stringify({
    schema: 'agoragentic.risk-fork.packed-consumer-check.v1',
    status: 'passed', package: manifest.name, version: manifest.version,
    tarball_sha256: createHash('sha256').update(await readFile(tarball)).digest('hex'),
    packed_files: included.size, packed_bytes: entry.size,
    offline_install: true, installed_exports: true, local_lifecycle: 'verified',
    mcp_host_example: 'passed', registry_publication_verified: false,
    live_traffic_protected: false, provider_calls: 0,
  }, null, 2)}\n`);
} finally {
  // Only the unique test directory allocated above can be removed.
  await rm(tempRoot, { recursive: true, force: true });
}
