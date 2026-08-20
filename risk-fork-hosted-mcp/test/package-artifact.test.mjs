import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import {
  mkdtemp,
  readFile,
  readdir,
  rm,
  stat,
  writeFile,
} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import test from 'node:test';

const packageRoot = path.resolve(fileURLToPath(new URL('..', import.meta.url)));
const repositoryRoot = path.resolve(packageRoot, '..');

function resolveNpmCli() {
  const configured = process.env.npm_execpath;
  const candidates = [
    configured?.startsWith('file:') ? fileURLToPath(configured) : configured,
    path.join(path.dirname(process.execPath), 'node_modules', 'npm', 'bin', 'npm-cli.js'),
    path.resolve(path.dirname(process.execPath), '..', 'lib', 'node_modules', 'npm', 'bin', 'npm-cli.js'),
  ].filter((candidate) => typeof candidate === 'string' && path.isAbsolute(candidate));
  const resolved = candidates.find((candidate) => existsSync(candidate));
  if (!resolved) {
    throw new Error('A validated npm CLI path is required for packed-consumer tests');
  }
  return resolved;
}

const npmCli = resolveNpmCli();

function sha256(bytes) {
  return `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
}

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: options.cwd ?? packageRoot,
    encoding: 'utf8',
    env: { ...process.env, NO_COLOR: '1' },
    maxBuffer: 32 * 1024 * 1024,
    shell: options.shell === true,
  });
  assert.equal(
    result.status,
    0,
    `${command} ${args.join(' ')} failed\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`,
  );
  return result.stdout;
}

function runAsync(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: options.cwd ?? packageRoot,
      env: { ...process.env, NO_COLOR: '1' },
      shell: options.shell === true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.once('error', reject);
    child.once('close', (code) => {
      if (code === 0) resolve(stdout);
      else reject(new Error(
        `${command} ${args.join(' ')} failed with ${String(code)}\nstdout:\n${stdout}\nstderr:\n${stderr}`,
      ));
    });
  });
}

async function listFiles(directory, prefix = '') {
  const files = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const relative = path.posix.join(prefix, entry.name);
    if (entry.isDirectory()) files.push(...await listFiles(path.join(directory, entry.name), relative));
    else files.push(relative);
  }
  return files.sort();
}

test('package contract is private, exact-version, and has no mandatory runtime dependencies', async () => {
  assert.equal((await stat(npmCli)).isFile(), true);
  const pkg = JSON.parse(await readFile(path.join(packageRoot, 'package.json'), 'utf8'));
  assert.equal(pkg.name, '@agoragentic/risk-fork-hosted-mcp');
  assert.equal(pkg.version, '0.1.0-alpha.0');
  assert.equal(pkg.private, true);
  assert.equal(pkg.type, 'module');
  assert.deepEqual(pkg.exports, {
    '.': './dist/runtime/index.mjs',
    './e2b-context/*': './e2b-context/*',
    './migrations/*': './migrations/*',
    './ops/postgres/*': './ops/postgres/*',
    './schema/*': './schema/*',
  });
  assert.equal(pkg.dependencies, undefined);
  assert.equal(pkg.optionalDependencies, undefined);
  assert.deepEqual(pkg.peerDependencies, { e2b: '2.39.0' });
  assert.deepEqual(pkg.peerDependenciesMeta, { e2b: { optional: true } });
  assert.match(pkg.scripts.prepublishOnly, /PUBLISH_DISABLED/);
  assert.deepEqual(pkg.files, [
    'dist/runtime/index.mjs',
    'e2b-context/',
    'integrity-manifest.json',
    'migrations/001_distributed_authority.pg.sql',
    'ops/postgres/',
    'schema/e2b-qualification-evidence.v1.json',
    'scripts/verify-integrity.mjs',
    'THIRD_PARTY_NOTICES.txt',
    'README.md',
    'LICENSE',
  ]);
});

test('build is deterministic and records exact source and artifact integrity', async () => {
  run(process.execPath, ['scripts/build.mjs']);
  const bundlePath = path.join(packageRoot, 'dist', 'runtime', 'index.mjs');
  const manifestPath = path.join(packageRoot, 'integrity-manifest.json');
  const firstBundle = await readFile(bundlePath);
  const firstManifest = await readFile(manifestPath);

  run(process.execPath, ['scripts/build.mjs']);
  const secondBundle = await readFile(bundlePath);
  const secondManifest = await readFile(manifestPath);
  assert.deepEqual(secondBundle, firstBundle);
  assert.deepEqual(secondManifest, firstManifest);

  const manifest = JSON.parse(secondManifest.toString('utf8'));
  assert.equal(manifest.schema, 'agoragentic.risk-fork-hosted-mcp.integrity.v1');
  assert.equal(manifest.package.name, '@agoragentic/risk-fork-hosted-mcp');
  assert.equal(manifest.package.version, '0.1.0-alpha.0');
  assert.equal(manifest.sources.mcp.version, '2.0.0');
  assert.equal(manifest.sources.risk_fork.version, '0.1.0-alpha.0');
  assert.equal(manifest.source_commit, '9efb61782883dd40409744710818994190439415');
  assert.deepEqual(manifest.runtime_dependencies, []);
  assert.deepEqual(manifest.optional_peer_dependencies, [
    { name: 'e2b', version: '2.39.0', optional: true },
  ]);
  assert.ok(manifest.build.external_imports.includes('e2b'));
  assert.equal(manifest.artifact.path, 'dist/runtime/index.mjs');
  assert.equal(manifest.artifact.sha256, sha256(secondBundle));
  assert.equal(manifest.artifact.bytes, secondBundle.byteLength);
  assert.ok(manifest.inputs.length > 20);
  assert.deepEqual(manifest.inputs, [...manifest.inputs].sort((a, b) => a.path.localeCompare(b.path)));
  for (const input of manifest.inputs) {
    assert.match(input.path, /^(?:mcp|risk-fork|risk-fork-hosted-mcp|transaction-assurance)\//);
    assert.match(input.sha256, /^sha256:[a-f0-9]{64}$/);
    assert.match(input.source, /^(?:git_blob|package_source|workspace_dependency)$/);
    assert.ok(Number.isSafeInteger(input.bytes) && input.bytes > 0);
  }
  for (const required of [
    'mcp/mcp-server.js',
    'risk-fork/e2b-template/template.mjs',
    'risk-fork/ops/postgres/owner-bootstrap.sql.template',
    'risk-fork/schema/e2b-qualification-evidence.v1.json',
    'risk-fork/src/adapters/e2b-source-verifier.mjs',
    'risk-fork/src/adapters/e2b.mjs',
    'risk-fork/src/adapters/postgres-authority-migrator.mjs',
    'risk-fork/src/adapters/postgres-authority.mjs',
    'risk-fork/src/controller.mjs',
    'risk-fork/src/e2b-qualification.mjs',
    'risk-fork/src/interception.mjs',
    'risk-fork/src/risk-classifier.mjs',
    'transaction-assurance/src/canonical.mjs',
  ]) {
    assert.ok(manifest.inputs.some((entry) => entry.path === required), `missing ${required}`);
  }
  assert.deepEqual(
    manifest.packaged_assets,
    [...manifest.packaged_assets].sort((left, right) => left.path.localeCompare(right.path)),
  );
  for (const asset of manifest.packaged_assets.filter((entry) => entry.source_path)) {
    const source = manifest.inputs.find((entry) => entry.path === asset.source_path);
    assert.ok(source, `missing reviewed asset source ${asset.source_path}`);
    assert.equal(source.source, 'git_blob');
    assert.equal(source.bytes, asset.bytes);
    assert.equal(source.sha256, asset.sha256);
  }
  assert.doesNotMatch(secondBundle.toString('utf8'), /\.\.\/mcp|\.\.\/risk-fork/);
  assert.doesNotMatch(secondBundle.toString('utf8'), /C:\\projects\\|C:\/projects\//i);
  run(process.execPath, ['scripts/verify-integrity.mjs', '--source']);
});

test('concurrent builds serialize reviewed snapshots and publish one deterministic artifact', async () => {
  run(process.execPath, ['scripts/build.mjs']);
  const bundlePath = path.join(packageRoot, 'dist', 'runtime', 'index.mjs');
  const manifestPath = path.join(packageRoot, 'integrity-manifest.json');
  const expectedBundle = await readFile(bundlePath);
  const expectedManifest = await readFile(manifestPath);

  await Promise.all([
    runAsync(process.execPath, ['scripts/build.mjs']),
    runAsync(process.execPath, ['scripts/build.mjs']),
  ]);

  assert.deepEqual(await readFile(bundlePath), expectedBundle);
  assert.deepEqual(await readFile(manifestPath), expectedManifest);
  assert.equal(await stat(path.join(packageRoot, '.build', 'upstream')).then(
    () => true,
    () => false,
  ), false);
  assert.equal(await stat(path.join(packageRoot, '.build', 'build.lock')).then(
    () => true,
    () => false,
  ), false);
  run(process.execPath, ['scripts/verify-integrity.mjs', '--source']);
});

test('bundle exposes the reviewed relay and Risk Fork controller boundaries', async () => {
  const api = await import(`${pathToFileURL(path.join(packageRoot, 'dist', 'runtime', 'index.mjs')).href}?api`);
  for (const name of [
    'MCP_ENFORCEMENT_SCHEMAS',
    'MCP_V2_PROTOCOL_VERSION',
    'computeMcpCleanImportEvidenceHash',
    'connectRemoteClient',
    'createMcpEnforcementBoundary',
    'runAcpAdapter',
    'runMcpRelay',
    'RiskForkController',
    'RiskForkMcpBoundary',
    'RiskForkProvider',
    'E2BRiskForkAdapter',
    'E2B_INDEPENDENT_SOURCE_ATTESTATION_SCHEMA',
    'E2B_QUALIFICATION_SCHEMA',
    'E2B_QUALIFICATION_TRUST_SCHEMA',
    'E2B_RISK_FORK_PATHS',
    'E2B_RUNTIME_SDK_INTEGRITY_SCHEMA',
    'createE2BAuthorityFreeSourceVerifier',
    'createE2BQualificationEvidence',
    'createE2BQualificationTrustVerifier',
    'createE2BRuntimeSdkIntegrityVerifier',
    'isE2BQualificationEvidenceCanonical',
    'isE2BRuntimeSdkIntegrityVerifier',
    'loadVerifiedE2BRuntimeSdk',
    'scanE2BStagedBytesAuthorityFree',
    'validateE2BQualificationEvidence',
    'verifyE2BQualificationTrust',
    'PostgresDistributedCommitAuthority',
    'acquirePostgresAuthorityClient',
    'buildPostgresAuthorityPoolConfig',
    'createPostgresAuthorityPool',
    'isProductionPostgresDistributedCommitAuthority',
    'migratePostgresDistributedAuthority',
    'verifyPostgresAuthorityClientTransport',
    'verifyPostgresDistributedAuthoritySchema',
    'assertHostCanEnforce',
    'assertRiskForkProvider',
    'classifyRisk',
    'createMcpInterceptionPlan',
    'createTrustedMcpServerVerifier',
    'verifyRiskDecision',
  ]) {
    assert.ok(Object.hasOwn(api, name), `missing export ${name}`);
  }
  assert.equal(typeof api.PostgresDistributedCommitAuthority.prototype.getAuthorityStatus, 'function');
  assert.equal(api.isProductionPostgresDistributedCommitAuthority({}), false);
  assert.equal(
    api.HOSTED_MCP_BUNDLE_METADATA.reviewed_source_commit,
    '9efb61782883dd40409744710818994190439415',
  );
  assert.equal(api.HOSTED_MCP_BUNDLE_METADATA.optional_e2b_peer_version, '2.39.0');
  assert.equal(api.HOSTED_MCP_BUNDLE_METADATA.outbound_mcp_transport_qualified, false);
  assert.equal(api.HOSTED_MCP_BUNDLE_METADATA.managed_postgres_qualified, false);
  assert.equal(api.HOSTED_MCP_BUNDLE_METADATA.e2b_live_qualified, false);

  const boundary = api.createMcpEnforcementBoundary({
    async openSession() { throw new Error('not called'); },
    async executeFallback() { throw new Error('not called'); },
  });
  assert.equal(boundary.schema, 'agoragentic.mcp.host-enforcement-capability.v1');
  assert.equal(boundary.mode, 'host_owns_network_and_clean_import');
  assert.equal(Object.isFrozen(boundary), true);
  assert.throws(
    () => api.createMcpEnforcementBoundary({
      async openSession() {},
      async executeFallback() {},
      bypass: true,
    }),
    /not allowed/i,
  );

  const riskInput = {
    request_id: 'packed-boundary-test',
    mcp_phase: 'server/discover',
    mcp_server_ref: 'mcp-server:test',
    mcp_server_origin: 'https://mcp.invalid/',
    mcp_server_trust: 'unknown',
    capabilities: {},
    owner_policy: {},
  };
  const clock = () => new Date('2026-08-20T12:00:00.000Z');
  const plan = api.createMcpInterceptionPlan({ risk_input: riskInput }, { clock });
  assert.equal(plan.directive, 'BLOCK_DIRECT_ROUTE_TO_RISK_FORK');
  assert.equal(plan.enforcement_point, 'before_remote_connect');
  assert.equal(plan.authority_flags.plan_grants_authority, false);

  let prepared = 0;
  const riskBoundary = new api.RiskForkMcpBoundary({
    controller: {
      async prepare(input) {
        prepared += 1;
        return { prepared: true, request_id: input.risk_input.request_id };
      },
    },
    hostCapabilities: {
      can_block_before_remote_connect: true,
      can_route_complete_remote_session: true,
    },
    clock,
  });
  const routed = await riskBoundary.route({ risk_input: riskInput, prepare_input: {} });
  assert.equal(routed.routed, true);
  assert.equal(routed.authority_granted, false);
  assert.equal(prepared, 1);
});

test('npm-packed artifact installs and runs with no repository or registry dependencies', async () => {
  const temporary = await mkdtemp(path.join(os.tmpdir(), 'risk-fork-hosted-mcp-test-'));
  try {
    const packOutput = run(process.execPath, [npmCli,
      'pack',
      '--silent',
      '--json',
      '--pack-destination',
      temporary,
    ]);
    const packed = JSON.parse(packOutput);
    assert.equal(packed.length, 1);
    const tarball = path.join(temporary, packed[0].filename);
    assert.ok((await stat(tarball)).size > 0);

    const consumer = path.join(temporary, 'consumer');
    await writeFile(path.join(temporary, 'package.json'), '{"private":true}\n', 'utf8');
    await writeFile(path.join(temporary, 'consumer-check.mjs'), [
      "import assert from 'node:assert/strict';",
      "import { createMcpEnforcementBoundary, createMcpInterceptionPlan, E2BRiskForkAdapter, verifyPostgresDistributedAuthoritySchema } from '@agoragentic/risk-fork-hosted-mcp';",
      "import { createRiskForkE2BTemplate } from '@agoragentic/risk-fork-hosted-mcp/e2b-context/risk-fork/e2b-template/template.mjs';",
      "assert.equal(typeof createMcpEnforcementBoundary, 'function');",
      "assert.equal(typeof createMcpInterceptionPlan, 'function');",
      "assert.equal(typeof E2BRiskForkAdapter, 'function');",
      "assert.equal(typeof verifyPostgresDistributedAuthoritySchema, 'function');",
      "assert.equal(typeof createRiskForkE2BTemplate, 'function');",
      "process.stdout.write('PACKED_CONSUMER_OK\\n');",
      '',
    ].join('\n'), 'utf8');
    run(process.execPath, [npmCli,
      'install',
      '--ignore-scripts',
      '--no-audit',
      '--no-fund',
      tarball,
    ], { cwd: temporary });
    const consumerOutput = run(process.execPath, ['consumer-check.mjs'], { cwd: temporary });
    assert.match(consumerOutput, /PACKED_CONSUMER_OK/);

    const installed = path.join(
      temporary,
      'node_modules',
      '@agoragentic',
      'risk-fork-hosted-mcp',
    );
    const installedFiles = await listFiles(installed);
    assert.deepEqual(installedFiles, [
      'LICENSE',
      'README.md',
      'THIRD_PARTY_NOTICES.txt',
      'dist/runtime/index.mjs',
      'e2b-context/risk-fork/e2b-template/bin/boot-guard.mjs',
      'e2b-context/risk-fork/e2b-template/bin/bootstrap.mjs',
      'e2b-context/risk-fork/e2b-template/bin/run.mjs',
      'e2b-context/risk-fork/e2b-template/lib/runtime-contract.mjs',
      'e2b-context/risk-fork/e2b-template/template.mjs',
      'e2b-context/risk-fork/src/canonical.mjs',
      'e2b-context/risk-fork/src/child-operation.mjs',
      'e2b-context/risk-fork/src/util.mjs',
      'e2b-context/transaction-assurance/src/canonical.mjs',
      'integrity-manifest.json',
      'migrations/001_distributed_authority.pg.sql',
      'ops/postgres/owner-bootstrap.sql.template',
      'ops/postgres/roles.sql.template',
      'package.json',
      'schema/e2b-qualification-evidence.v1.json',
      'scripts/verify-integrity.mjs',
    ]);
    assert.equal(await stat(path.join(temporary, 'node_modules', '@agoragentic')).then(
      () => true,
      () => false,
    ), true);
    assert.equal(await stat(path.join(temporary, 'node_modules', '@modelcontextprotocol')).then(
      () => true,
      () => false,
    ), false);
    assert.equal(await stat(path.join(temporary, 'node_modules', 'ajv')).then(
      () => true,
      () => false,
    ), false);
    assert.equal(await stat(path.join(temporary, 'node_modules', 'e2b')).then(
      () => true,
      () => false,
    ), false);
    assert.equal(await stat(path.join(consumer, 'not-used')).then(() => true, () => false), false);
  } finally {
    const resolved = path.resolve(temporary);
    assert.ok(resolved.startsWith(path.resolve(os.tmpdir()) + path.sep));
    await rm(resolved, { recursive: true, force: true });
  }
});
