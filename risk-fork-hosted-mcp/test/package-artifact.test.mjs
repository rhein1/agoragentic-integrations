import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import {
  cp,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rename,
  rm,
  stat,
  symlink,
  unlink,
  writeFile,
} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import test from 'node:test';
import { TextDecoder } from 'node:util';
import {
  extractCompleteReadmeLicense,
  selectStandaloneLicenseEntry,
} from '../scripts/license-notices.mjs';

const packageRoot = path.resolve(fileURLToPath(new URL('..', import.meta.url)));
const repositoryRoot = path.resolve(packageRoot, '..');
const REVIEWED_SOURCE_ATTESTATION_SCHEMA = 'agoragentic.risk-fork-hosted-mcp.reviewed-sources.v2';
const REVIEWED_SOURCE_NORMALIZATION = 'utf8_crlf_to_lf_lone_cr_preserved';
const HOSTED_FIXTURE_COPIES = Object.freeze([
  ['mcp/mcp-server.js', 'mcp/mcp-server.js'],
  ['mcp/package.json', 'mcp/package.json'],
  ['risk-fork/LICENSE', 'risk-fork/LICENSE'],
  ['risk-fork/NOTICE', 'risk-fork/NOTICE'],
  ['risk-fork/e2b-template', 'risk-fork/e2b-template'],
  ['risk-fork/migrations/001_distributed_authority.pg.sql', 'risk-fork/migrations/001_distributed_authority.pg.sql'],
  ['risk-fork/ops/postgres', 'risk-fork/ops/postgres'],
  ['risk-fork/package.json', 'risk-fork/package.json'],
  ['risk-fork/schema/e2b-qualification-evidence.v1.json', 'risk-fork/schema/e2b-qualification-evidence.v1.json'],
  ['risk-fork/src', 'risk-fork/src'],
  ['transaction-assurance/src', 'transaction-assurance/src'],
  ['risk-fork-hosted-mcp/integrity-manifest.json', 'risk-fork-hosted-mcp/integrity-manifest.json'],
  ['risk-fork-hosted-mcp/node_modules', 'risk-fork-hosted-mcp/node_modules'],
  ['risk-fork-hosted-mcp/package.json', 'risk-fork-hosted-mcp/package.json'],
  ['risk-fork-hosted-mcp/scripts', 'risk-fork-hosted-mcp/scripts'],
  ['risk-fork-hosted-mcp/src', 'risk-fork-hosted-mcp/src'],
]);
const GENERATED_HOSTED_ROOTS = Object.freeze([
  'dist/runtime',
  'e2b-context',
  'migrations',
  'ops/postgres',
  'schema',
]);
const GENERATED_HOSTED_OUTPUT_PATHS = Object.freeze([
  'LICENSE',
  'NOTICE',
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
  'schema/e2b-qualification-evidence.v1.json',
]);

function compareOrdinal(left, right) {
  return left < right ? -1 : left > right ? 1 : 0;
}

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

function canonicalReviewedSourceBytes(bytes) {
  new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  const output = [];
  for (let index = 0; index < bytes.byteLength; index += 1) {
    if (bytes[index] === 0x0d && bytes[index + 1] === 0x0a) {
      output.push(0x0a);
      index += 1;
    } else {
      output.push(bytes[index]);
    }
  }
  return Buffer.from(output);
}

function reviewedSourceAttestation(records) {
  return sha256(Buffer.from(
    `${REVIEWED_SOURCE_ATTESTATION_SCHEMA}\n${REVIEWED_SOURCE_NORMALIZATION}\n${JSON.stringify(records)}\n`,
    'utf8',
  ));
}

async function createHostedFixture(prefix) {
  const temporary = await mkdtemp(path.join(os.tmpdir(), prefix));
  for (const [source, target] of HOSTED_FIXTURE_COPIES) {
    const targetPath = path.join(temporary, ...target.split('/'));
    await mkdir(path.dirname(targetPath), { recursive: true });
    await cp(path.join(repositoryRoot, ...source.split('/')), targetPath, { recursive: true });
  }
  return {
    packageRoot: path.join(temporary, 'risk-fork-hosted-mcp'),
    repositoryRoot: temporary,
    temporary,
  };
}

async function cleanupTemporary(temporary) {
  const resolved = path.resolve(temporary);
  assert.ok(resolved.startsWith(`${path.resolve(os.tmpdir())}${path.sep}`));
  await rm(resolved, { recursive: true, force: true });
}

function normalizeManifestOrdering(manifest) {
  manifest.reviewed_sources.sort((left, right) => compareOrdinal(left.path, right.path));
  manifest.source_attestation.files = manifest.reviewed_sources.length;
  manifest.source_attestation.sha256 = reviewedSourceAttestation(manifest.reviewed_sources);
  manifest.build.external_imports = [...new Set(manifest.build.external_imports)].sort(compareOrdinal);
  manifest.inputs = [...new Map(manifest.inputs.map((record) => [record.path, record])).values()]
    .sort((left, right) => compareOrdinal(left.path, right.path));
  manifest.third_party_notices.sources.sort(
    (left, right) => compareOrdinal(left.package, right.package),
  );
  manifest.packaged_assets.sort((left, right) => compareOrdinal(left.path, right.path));
  return manifest;
}

function run(command, args, options = {}) {
  const result = runResult(command, args, options);
  assert.equal(
    result.status,
    0,
    `${command} ${args.join(' ')} failed\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`,
  );
  return result.stdout;
}

function runResult(command, args, options = {}) {
  return spawnSync(command, args, {
    cwd: options.cwd ?? packageRoot,
    encoding: 'utf8',
    env: { ...process.env, ...options.env, NO_COLOR: '1' },
    maxBuffer: 32 * 1024 * 1024,
    shell: options.shell === true,
  });
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
  return files.sort(compareOrdinal);
}

async function snapshotGeneratedHostedOutputs(root) {
  const actualPaths = [
    'LICENSE',
    'NOTICE',
    'THIRD_PARTY_NOTICES.txt',
    'integrity-manifest.json',
  ];
  for (const relativeRoot of GENERATED_HOSTED_ROOTS) {
    const rootFiles = await listFiles(path.join(root, ...relativeRoot.split('/')));
    actualPaths.push(...rootFiles.map((relativePath) => (
      path.posix.join(relativeRoot, relativePath)
    )));
  }
  actualPaths.sort(compareOrdinal);
  assert.deepEqual(actualPaths, GENERATED_HOSTED_OUTPUT_PATHS);
  return Promise.all(actualPaths.map(async (relativePath) => ({
    bytes: await readFile(path.join(root, ...relativePath.split('/'))),
    path: relativePath,
  })));
}

async function assertGeneratedHostedOutputsUnchanged(expectedSnapshot) {
  const actualSnapshot = await snapshotGeneratedHostedOutputs(packageRoot);
  assert.deepEqual(
    actualSnapshot.map((record) => record.path),
    expectedSnapshot.map((record) => record.path),
  );
  for (let index = 0; index < expectedSnapshot.length; index += 1) {
    assert.equal(
      actualSnapshot[index].bytes.equals(expectedSnapshot[index].bytes),
      true,
      `first build changed committed generated bytes: ${expectedSnapshot[index].path}`,
    );
  }
}

const committedGeneratedOutputSnapshot = await snapshotGeneratedHostedOutputs(packageRoot);

test('package contract is private, exact-version, and has no mandatory runtime dependencies', async () => {
  assert.equal((await stat(npmCli)).isFile(), true);
  const pkg = JSON.parse(await readFile(path.join(packageRoot, 'package.json'), 'utf8'));
  assert.equal(pkg.name, '@agoragentic/risk-fork-hosted-mcp');
  assert.equal(pkg.version, '0.1.0-alpha.0');
  assert.equal(pkg.private, true);
  assert.equal(pkg.type, 'module');
  assert.equal(pkg.license, 'Apache-2.0');
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
    'NOTICE',
  ]);
});

test('build is deterministic and records exact source and artifact integrity', async () => {
  run(process.execPath, ['scripts/build.mjs']);
  await assertGeneratedHostedOutputsUnchanged(committedGeneratedOutputSnapshot);
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
  assert.deepEqual(Object.keys(manifest), [
    'schema',
    'package',
    'source_attestation',
    'reviewed_sources',
    'sources',
    'build',
    'runtime_dependencies',
    'optional_peer_dependencies',
    'exports',
    'inputs',
    'third_party_notices',
    'artifact',
    'packaged_assets',
  ]);
  assert.equal(manifest.schema, 'agoragentic.risk-fork-hosted-mcp.integrity.v2');
  assert.equal(manifest.package.name, '@agoragentic/risk-fork-hosted-mcp');
  assert.equal(manifest.package.version, '0.1.0-alpha.0');
  assert.equal(manifest.sources.mcp.version, '2.0.0');
  assert.equal(manifest.sources.risk_fork.version, '0.1.0-alpha.1');
  assert.equal(manifest.source_commit, undefined);
  assert.ok(manifest.reviewed_sources.length > 20);
  assert.deepEqual(
    manifest.reviewed_sources,
    [...manifest.reviewed_sources].sort((left, right) => compareOrdinal(left.path, right.path)),
  );
  assert.equal(
    new Set(manifest.reviewed_sources.map((record) => record.path)).size,
    manifest.reviewed_sources.length,
  );
  for (const source of manifest.reviewed_sources) {
    assert.deepEqual(Object.keys(source), ['path', 'bytes', 'sha256']);
    assert.match(source.path, /^(?:mcp|risk-fork|transaction-assurance)\//);
    assert.ok(Number.isSafeInteger(source.bytes) && source.bytes > 0);
    assert.match(source.sha256, /^sha256:[a-f0-9]{64}$/);
  }
  assert.deepEqual(manifest.source_attestation, {
    schema: REVIEWED_SOURCE_ATTESTATION_SCHEMA,
    normalization: REVIEWED_SOURCE_NORMALIZATION,
    files: manifest.reviewed_sources.length,
    sha256: reviewedSourceAttestation(manifest.reviewed_sources),
  });
  assert.deepEqual(manifest.runtime_dependencies, []);
  assert.deepEqual(manifest.optional_peer_dependencies, [
    { name: 'e2b', version: '2.39.0', optional: true },
  ]);
  assert.ok(manifest.build.external_imports.includes('e2b'));
  assert.deepEqual(
    manifest.build.external_imports,
    [...new Set(manifest.build.external_imports)].sort(compareOrdinal),
  );
  assert.equal(manifest.artifact.path, 'dist/runtime/index.mjs');
  assert.equal(manifest.artifact.sha256, sha256(secondBundle));
  assert.equal(manifest.artifact.bytes, secondBundle.byteLength);
  const apacheLicenseBytes = await readFile(path.join(packageRoot, 'LICENSE'));
  const riskForkLicenseBytes = canonicalReviewedSourceBytes(
    await readFile(path.join(repositoryRoot, 'risk-fork', 'LICENSE')),
  );
  assert.deepEqual(apacheLicenseBytes, riskForkLicenseBytes);
  assert.match(apacheLicenseBytes.toString('utf8'), /^Apache License\r?\n/);
  assert.match(apacheLicenseBytes.toString('utf8'), /Version 2\.0, January 2004/);
  const riskForkNoticeBytes = canonicalReviewedSourceBytes(
    await readFile(path.join(repositoryRoot, 'risk-fork', 'NOTICE')),
  );
  const packagedNoticeBytes = await readFile(path.join(packageRoot, 'NOTICE'));
  assert.deepEqual(packagedNoticeBytes, riskForkNoticeBytes);
  assert.match(packagedNoticeBytes.toString('utf8'), /^Risk Fork\r?\nCopyright 2026 Agoragentic\r?\n/);
  for (const expected of [
    {
      path: 'LICENSE',
      source_path: 'risk-fork/LICENSE',
      bytes: riskForkLicenseBytes,
    },
    {
      path: 'NOTICE',
      source_path: 'risk-fork/NOTICE',
      bytes: riskForkNoticeBytes,
    },
  ]) {
    const asset = manifest.packaged_assets.find((entry) => entry.path === expected.path);
    assert.deepEqual(asset, {
      path: expected.path,
      source_path: expected.source_path,
      bytes: expected.bytes.byteLength,
      sha256: sha256(expected.bytes),
    });
    const input = manifest.inputs.find((entry) => entry.path === expected.source_path);
    assert.equal(input.source, 'reviewed_source');
    assert.equal(input.bytes, expected.bytes.byteLength);
    assert.equal(input.sha256, sha256(expected.bytes));
  }
  assert.equal(manifest.third_party_notices.path, 'THIRD_PARTY_NOTICES.txt');
  const noticesBytes = await readFile(path.join(packageRoot, 'THIRD_PARTY_NOTICES.txt'));
  const noticesText = noticesBytes.toString('utf8');
  assert.equal(manifest.third_party_notices.bytes, noticesBytes.byteLength);
  assert.equal(manifest.third_party_notices.sha256, sha256(noticesBytes));
  assert.deepEqual(
    manifest.third_party_notices.sources,
    [...manifest.third_party_notices.sources]
      .sort((left, right) => compareOrdinal(left.package, right.package)),
  );
  const mitNoticeSources = manifest.third_party_notices.sources.filter(
    (source) => source.declared_license === 'MIT',
  );
  assert.ok(mitNoticeSources.length > 0);
  assert.match(noticesText, /@modelcontextprotocol\/sdk@1\.30\.0\nDeclared license: MIT/);
  assert.match(noticesText, /Permission is hereby granted, free of charge/);
  const readmeFallbacks = [
    {
      package: 'pg-types',
      version: '2.2.0',
      source_bytes: 3831,
      source_sha256: 'sha256:ecda9bca71d3f0cee4e600d1dd2bef336213f39ef2e8fca6a1a1c1c8723f643a',
    },
    {
      package: 'pgpass',
      version: '1.0.5',
      source_bytes: 3294,
      source_sha256: 'sha256:62549909404b5a0dcb2b4b74c9a930baf8095dbcfa1543c4ffc79378acd22b57',
    },
  ];
  for (const expected of readmeFallbacks) {
    const source = manifest.third_party_notices.sources.find(
      (entry) => entry.package === expected.package && entry.version === expected.version,
    );
    assert.ok(source, `missing ${expected.package}@${expected.version} notice source`);
    assert.equal(source.declared_license, 'MIT');
    assert.equal(source.method, 'markdown_license_section');
    assert.match(source.path, new RegExp(
      `^risk-fork-hosted-mcp/node_modules/${expected.package}/README\\.md$`,
    ));
    assert.equal(source.source_bytes, expected.source_bytes);
    assert.equal(source.source_sha256, expected.source_sha256);
    const readmeBytes = await readFile(path.join(
      packageRoot,
      'node_modules',
      expected.package,
      'README.md',
    ));
    const extracted = extractCompleteReadmeLicense({
      bytes: readmeBytes,
      packageName: expected.package,
      version: expected.version,
      declaredLicense: 'MIT',
    });
    const extractedBytes = Buffer.from(extracted.text, 'utf8');
    assert.equal(source.notice_bytes, extractedBytes.byteLength);
    assert.equal(source.notice_sha256, sha256(extractedBytes));
    assert.ok(noticesText.includes(extracted.text));
  }
  for (const source of manifest.third_party_notices.sources.filter(
    (entry) => entry.method === 'standalone_license_file',
  )) {
    const absoluteSource = path.join(repositoryRoot, ...source.path.split('/'));
    const actualName = selectStandaloneLicenseEntry(
      await readdir(path.dirname(absoluteSource), { withFileTypes: true }),
      source.package,
      source.version,
    );
    assert.equal(path.basename(source.path), actualName);
  }
  assert.doesNotMatch(
    noticesText,
    /No standalone license file was present in the installed build dependency/,
  );
  assert.ok(manifest.inputs.length > 20);
  assert.deepEqual(
    manifest.inputs,
    [...manifest.inputs].sort((left, right) => compareOrdinal(left.path, right.path)),
  );
  assert.equal(
    new Set(manifest.inputs.map((input) => input.path.toLowerCase())).size,
    manifest.inputs.length,
  );
  for (const input of manifest.inputs) {
    assert.deepEqual(Object.keys(input), ['path', 'source', 'bytes', 'sha256']);
    assert.match(input.path, /^(?:mcp|risk-fork|risk-fork-hosted-mcp|transaction-assurance)\//);
    assert.match(input.sha256, /^sha256:[a-f0-9]{64}$/);
    assert.match(input.source, /^(?:reviewed_source|package_source|workspace_dependency)$/);
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
    [...manifest.packaged_assets].sort((left, right) => compareOrdinal(left.path, right.path)),
  );
  assert.equal(
    new Set(manifest.packaged_assets.map((asset) => asset.path.toLowerCase())).size,
    manifest.packaged_assets.length,
  );
  for (const asset of manifest.packaged_assets.filter((entry) => entry.source_path)) {
    const source = manifest.inputs.find((entry) => entry.path === asset.source_path);
    assert.ok(source, `missing reviewed asset source ${asset.source_path}`);
    assert.equal(source.source, 'reviewed_source');
    assert.equal(source.bytes, asset.bytes);
    assert.equal(source.sha256, asset.sha256);
  }
  assert.doesNotMatch(secondBundle.toString('utf8'), /\.\.\/mcp|\.\.\/risk-fork/);
  assert.doesNotMatch(secondBundle.toString('utf8'), /C:\\projects\\|C:\/projects\//i);
  run(process.execPath, ['scripts/verify-integrity.mjs', '--source']);
});

test('standalone license discovery preserves actual casing and fails closed on ambiguity or non-files', async () => {
  const entry = (name, type = 'file') => ({
    name,
    isFile: () => type === 'file',
  });
  assert.equal(
    selectStandaloneLicenseEntry([entry('license')], 'postgres-array', '2.0.0'),
    'license',
  );
  assert.equal(
    selectStandaloneLicenseEntry([entry('LICENSE.md')], 'example', '1.0.0'),
    'LICENSE.md',
  );
  assert.equal(
    selectStandaloneLicenseEntry([entry('README.md')], 'example', '1.0.0'),
    null,
  );
  assert.throws(
    () => selectStandaloneLicenseEntry([
      entry('LICENSE'),
      entry('license'),
    ], 'example', '1.0.0'),
    /ambiguous standalone license files: LICENSE, license/,
  );
  assert.throws(
    () => selectStandaloneLicenseEntry([entry('COPYING', 'symlink')], 'example', '1.0.0'),
    /not a regular file/,
  );

  const temporaryPackage = await mkdtemp(path.join(os.tmpdir(), 'risk-fork-license-case-'));
  try {
    await writeFile(path.join(temporaryPackage, 'license'), 'example license\n', 'utf8');
    assert.equal(
      selectStandaloneLicenseEntry(
        await readdir(temporaryPackage, { withFileTypes: true }),
        'postgres-array',
        '2.0.0',
      ),
      'license',
    );
  } finally {
    const resolvedTemporaryPackage = path.resolve(temporaryPackage);
    assert.ok(resolvedTemporaryPackage.startsWith(`${path.resolve(os.tmpdir())}${path.sep}`));
    await rm(resolvedTemporaryPackage, { recursive: true, force: true });
  }
});

test('reviewed README license fallback fails closed on absent, ambiguous, or incomplete notice text', async () => {
  const valid = await readFile(path.join(packageRoot, 'node_modules', 'pg-types', 'README.md'));
  assert.match(extractCompleteReadmeLicense({
    bytes: valid,
    packageName: 'pg-types',
    version: '2.2.0',
    declaredLicense: 'MIT',
  }).text, /Copyright \(c\) 2014 Brian M\. Carlson/);
  assert.throws(
    () => extractCompleteReadmeLicense({
      bytes: Buffer.from('# package\n\nNo license section.\n'),
      packageName: 'pg-types',
      version: '2.2.0',
      declaredLicense: 'MIT',
    }),
    /exactly one license heading/,
  );
  assert.throws(
    () => extractCompleteReadmeLicense({
      bytes: Buffer.concat([valid, Buffer.from('\n## License\nDuplicate.\n')]),
      packageName: 'pg-types',
      version: '2.2.0',
      declaredLicense: 'MIT',
    }),
    /exactly one license heading/,
  );
  assert.throws(
    () => extractCompleteReadmeLicense({
      bytes: Buffer.from('## License\nCopyright (c) Example\nPermission is hereby granted, free of charge, to any person obtaining a copy.\n'),
      packageName: 'pg-types',
      version: '2.2.0',
      declaredLicense: 'MIT',
    }),
    /incomplete/,
  );
  const truncatedPrefixNotice = Buffer.from([
    '## License',
    'Copyright (c) Example',
    'Permission is hereby granted, free of charge, to any person obtaining a copy',
    'The above copyright notice and this permission notice shall be included in',
    'THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND',
    'IN NO EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM',
    '',
  ].join('\n'));
  assert.throws(
    () => extractCompleteReadmeLicense({
      bytes: truncatedPrefixNotice,
      packageName: 'pg-types',
      version: '2.2.0',
      declaredLicense: 'MIT',
    }),
    /source bytes or SHA-256 do not match/,
  );
  assert.throws(
    () => extractCompleteReadmeLicense({
      bytes: valid,
      packageName: 'pg-types',
      version: '2.2.1',
      declaredLicense: 'MIT',
    }),
    /no reviewed README license fallback/,
  );
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

test('build and source verification do not require a Git object database', () => {
  const inaccessibleGitDir = path.join(packageRoot, '.build', 'intentionally-missing.git');
  run(process.execPath, ['scripts/build.mjs'], {
    env: {
      GIT_DIR: inaccessibleGitDir,
      GIT_WORK_TREE: packageRoot,
    },
  });
  run(process.execPath, ['scripts/verify-integrity.mjs', '--source'], {
    env: {
      GIT_DIR: inaccessibleGitDir,
      GIT_WORK_TREE: packageRoot,
    },
  });
});

test('build and verifier CLIs reject unknown and duplicate flags before work begins', () => {
  const rejectedCommands = [
    ['scripts/build.mjs', '--unknown'],
    ['scripts/build.mjs', '--refresh-reviewed-sources', '--refresh-reviewed-sources'],
    ['scripts/verify-integrity.mjs', '--unknown'],
    ['scripts/verify-integrity.mjs', '--source', '--source'],
    ['scripts/verify-integrity.mjs', '--quiet', '--quiet'],
  ];
  for (const args of rejectedCommands) {
    const rejected = runResult(process.execPath, args);
    assert.notEqual(rejected.status, 0, args.join(' '));
    assert.match(
      `${rejected.stdout}\n${rejected.stderr}`,
      /Unsupported hosted MCP (?:build|integrity) arguments/,
      args.join(' '),
    );
  }
});

test('source verification independently rejects extra unused and omitted bundled dependency inputs', async () => {
  const fixture = await createHostedFixture('risk-fork-independent-input-closure-');
  try {
    run(process.execPath, ['scripts/build.mjs', '--refresh-reviewed-sources'], {
      cwd: fixture.packageRoot,
    });
    const manifestPath = path.join(fixture.packageRoot, 'integrity-manifest.json');
    const baseline = normalizeManifestOrdering(
      JSON.parse(await readFile(manifestPath, 'utf8')),
    );

    const unusedInputPath = 'risk-fork-hosted-mcp/node_modules/.package-lock.json';
    assert.equal(baseline.inputs.some((input) => input.path === unusedInputPath), false);
    const unusedBytes = await readFile(path.join(
      fixture.repositoryRoot,
      ...unusedInputPath.split('/'),
    ));
    const extraInputManifest = structuredClone(baseline);
    extraInputManifest.inputs.push({
      path: unusedInputPath,
      source: 'workspace_dependency',
      bytes: unusedBytes.byteLength,
      sha256: sha256(unusedBytes),
    });
    normalizeManifestOrdering(extraInputManifest);
    await writeFile(manifestPath, `${JSON.stringify(extraInputManifest, null, 2)}\n`, 'utf8');
    run(process.execPath, ['scripts/verify-integrity.mjs', '--quiet'], {
      cwd: fixture.packageRoot,
    });
    const extraRejected = runResult(
      process.execPath,
      ['scripts/verify-integrity.mjs', '--source'],
      { cwd: fixture.packageRoot },
    );
    assert.notEqual(extraRejected.status, 0);
    assert.match(
      `${extraRejected.stdout}\n${extraRejected.stderr}`,
      /Manifest build inputs do not exactly match the independently derived esbuild dependency closure; omitted_count: 0; unexpected_count: 1/,
    );

    const bundledInputPath = 'risk-fork-hosted-mcp/node_modules/@modelcontextprotocol/sdk/dist/cjs/experimental/tasks/helpers.js';
    assert.equal(baseline.inputs.some((input) => input.path === bundledInputPath), true);
    const omittedInputManifest = structuredClone(baseline);
    omittedInputManifest.inputs = omittedInputManifest.inputs.filter(
      (input) => input.path !== bundledInputPath,
    );
    normalizeManifestOrdering(omittedInputManifest);
    await writeFile(manifestPath, `${JSON.stringify(omittedInputManifest, null, 2)}\n`, 'utf8');
    run(process.execPath, ['scripts/verify-integrity.mjs', '--quiet'], {
      cwd: fixture.packageRoot,
    });
    const omittedRejected = runResult(
      process.execPath,
      ['scripts/verify-integrity.mjs', '--source'],
      { cwd: fixture.packageRoot },
    );
    assert.notEqual(omittedRejected.status, 0);
    assert.match(
      `${omittedRejected.stdout}\n${omittedRejected.stderr}`,
      /Manifest build inputs do not exactly match the independently derived esbuild dependency closure; omitted_count: 1; unexpected_count: 0/,
    );

    const extraExternalManifest = structuredClone(baseline);
    assert.equal(extraExternalManifest.build.external_imports.includes('node:cluster'), false);
    extraExternalManifest.build.external_imports.push('node:cluster');
    normalizeManifestOrdering(extraExternalManifest);
    await writeFile(manifestPath, `${JSON.stringify(extraExternalManifest, null, 2)}\n`, 'utf8');
    run(process.execPath, ['scripts/verify-integrity.mjs', '--quiet'], {
      cwd: fixture.packageRoot,
    });
    const externalRejected = runResult(
      process.execPath,
      ['scripts/verify-integrity.mjs', '--source'],
      { cwd: fixture.packageRoot },
    );
    assert.notEqual(externalRejected.status, 0);
    assert.match(
      `${externalRejected.stdout}\n${externalRejected.stderr}`,
      /Manifest external imports do not exactly match the independently derived esbuild output closure; omitted_count: 0; unexpected_count: 1/,
    );
  } finally {
    await cleanupTemporary(fixture.temporary);
  }
});

test('artifact verification rejects physical tree drift and source mode binds rebuilt artifact bytes', async () => {
  const fixture = await createHostedFixture('risk-fork-packaged-physical-inventory-');
  try {
    run(process.execPath, ['scripts/build.mjs', '--refresh-reviewed-sources'], {
      cwd: fixture.packageRoot,
    });
    const manifestPath = path.join(fixture.packageRoot, 'integrity-manifest.json');
    const baseline = JSON.parse(await readFile(manifestPath, 'utf8'));
    const noticePath = path.join(fixture.packageRoot, 'THIRD_PARTY_NOTICES.txt');
    const baselineNotices = await readFile(noticePath);

    const extraPath = path.join(
      fixture.packageRoot,
      'e2b-context',
      'risk-fork',
      'unmanifested-extra.mjs',
    );
    await writeFile(extraPath, 'export const unmanifested = true;\n', 'utf8');
    const extraRejected = runResult(
      process.execPath,
      ['scripts/verify-integrity.mjs', '--quiet'],
      { cwd: fixture.packageRoot },
    );
    assert.notEqual(extraRejected.status, 0);
    assert.match(
      `${extraRejected.stdout}\n${extraRejected.stderr}`,
      /Packaged physical file inventory does not match the exact contract; missing_count: 0; unexpected_count: 1/,
    );
    assert.doesNotMatch(`${extraRejected.stdout}\n${extraRejected.stderr}`, /unmanifested-extra/);
    await unlink(extraPath);
    run(process.execPath, ['scripts/verify-integrity.mjs', '--quiet'], {
      cwd: fixture.packageRoot,
    });

    const linkPath = path.join(fixture.packageRoot, 'e2b-context', 'risk-fork', 'linked-extra');
    await symlink(
      path.join(fixture.repositoryRoot, 'risk-fork', 'src'),
      linkPath,
      process.platform === 'win32' ? 'junction' : 'dir',
    );
    const linkRejected = runResult(
      process.execPath,
      ['scripts/verify-integrity.mjs', '--quiet'],
      { cwd: fixture.packageRoot },
    );
    assert.notEqual(linkRejected.status, 0);
    assert.match(
      `${linkRejected.stdout}\n${linkRejected.stderr}`,
      /Packaged physical inventory contains a symlink or reparse point/,
    );
    assert.doesNotMatch(`${linkRejected.stdout}\n${linkRejected.stderr}`, /linked-extra/);
    await unlink(linkPath);
    run(process.execPath, ['scripts/verify-integrity.mjs', '--quiet'], {
      cwd: fixture.packageRoot,
    });

    const tamperedNotices = Buffer.concat([
      Buffer.from('UNREVIEWED SELF-CONSISTENT PREAMBLE\n', 'utf8'),
      baselineNotices,
    ]);
    await writeFile(noticePath, tamperedNotices);
    const tamperedNoticeManifest = structuredClone(baseline);
    tamperedNoticeManifest.third_party_notices.bytes = tamperedNotices.byteLength;
    tamperedNoticeManifest.third_party_notices.sha256 = sha256(tamperedNotices);
    const tamperedNoticeAsset = tamperedNoticeManifest.packaged_assets.find(
      (asset) => asset.path === 'THIRD_PARTY_NOTICES.txt',
    );
    tamperedNoticeAsset.bytes = tamperedNotices.byteLength;
    tamperedNoticeAsset.sha256 = sha256(tamperedNotices);
    await writeFile(
      manifestPath,
      `${JSON.stringify(tamperedNoticeManifest, null, 2)}\n`,
      'utf8',
    );
    run(process.execPath, ['scripts/verify-integrity.mjs', '--quiet'], {
      cwd: fixture.packageRoot,
    });
    const noticeSourceRejected = runResult(
      process.execPath,
      ['scripts/verify-integrity.mjs', '--source'],
      { cwd: fixture.packageRoot },
    );
    assert.notEqual(noticeSourceRejected.status, 0);
    assert.match(
      `${noticeSourceRejected.stdout}\n${noticeSourceRejected.stderr}`,
      /Packaged third-party notices do not match the independently reconstructed notice artifact; manifest_sha256: sha256:[a-f0-9]{64}; independent_sha256: sha256:[a-f0-9]{64}/,
    );
    assert.doesNotMatch(
      `${noticeSourceRejected.stdout}\n${noticeSourceRejected.stderr}`,
      /UNREVIEWED SELF-CONSISTENT PREAMBLE/,
    );
    await writeFile(noticePath, baselineNotices);
    await writeFile(manifestPath, `${JSON.stringify(baseline, null, 2)}\n`, 'utf8');
    run(process.execPath, ['scripts/verify-integrity.mjs', '--source', '--quiet'], {
      cwd: fixture.packageRoot,
    });

    const artifactPath = path.join(fixture.packageRoot, 'dist', 'runtime', 'index.mjs');
    const tamperedArtifact = Buffer.concat([
      await readFile(artifactPath),
      Buffer.from('\n// isolated independently-rebuilt artifact regression\n', 'utf8'),
    ]);
    await writeFile(artifactPath, tamperedArtifact);
    const tamperedManifest = structuredClone(baseline);
    tamperedManifest.artifact.bytes = tamperedArtifact.byteLength;
    tamperedManifest.artifact.sha256 = sha256(tamperedArtifact);
    await writeFile(manifestPath, `${JSON.stringify(tamperedManifest, null, 2)}\n`, 'utf8');
    run(process.execPath, ['scripts/verify-integrity.mjs', '--quiet'], {
      cwd: fixture.packageRoot,
    });
    const sourceRejected = runResult(
      process.execPath,
      ['scripts/verify-integrity.mjs', '--source'],
      { cwd: fixture.packageRoot },
    );
    assert.notEqual(sourceRejected.status, 0);
    assert.match(
      `${sourceRejected.stdout}\n${sourceRejected.stderr}`,
      /Manifest artifact does not match the independently rebuilt source artifact; manifest_sha256: sha256:[a-f0-9]{64}; independent_sha256: sha256:[a-f0-9]{64}/,
    );
  } finally {
    await cleanupTemporary(fixture.temporary);
  }
});

test('CRLF and LF reviewed sources are portable while content changes require an explicit digest refresh', async () => {
  const fixture = await createHostedFixture('risk-fork-reviewed-source-refresh-');
  const temporary = fixture.temporary;
  const fixturePackageRoot = fixture.packageRoot;
  try {
    const tamperedPath = path.join(temporary, 'mcp', 'mcp-server.js');
    const original = canonicalReviewedSourceBytes(await readFile(tamperedPath));
    const crlf = Buffer.from(original.toString('utf8').replace(/\n/g, '\r\n'), 'utf8');
    assert.ok(crlf.byteLength > original.byteLength);
    await writeFile(tamperedPath, crlf);

    run(process.execPath, ['scripts/build.mjs', '--refresh-reviewed-sources'], {
      cwd: fixturePackageRoot,
    });
    const crlfManifest = JSON.parse(await readFile(
      path.join(fixturePackageRoot, 'integrity-manifest.json'),
      'utf8',
    ));
    const crlfRecord = crlfManifest.reviewed_sources.find(
      (record) => record.path === 'mcp/mcp-server.js',
    );
    assert.equal(crlfManifest.source_attestation.normalization, REVIEWED_SOURCE_NORMALIZATION);
    assert.equal(crlfRecord.bytes, original.byteLength);
    assert.equal(crlfRecord.sha256, sha256(original));

    await writeFile(tamperedPath, original);
    run(process.execPath, ['scripts/build.mjs'], { cwd: fixturePackageRoot });
    const artifactOnlyOutput = run(process.execPath, ['scripts/verify-integrity.mjs'], {
      cwd: fixturePackageRoot,
    });
    const sourceOutput = run(process.execPath, ['scripts/verify-integrity.mjs', '--source'], {
      cwd: fixturePackageRoot,
    });
    assert.match(artifactOnlyOutput, /^RISK_FORK_HOSTED_MCP_ARTIFACT_INTEGRITY_OK sha256:[a-f0-9]{64}\n$/);
    assert.match(sourceOutput, /^RISK_FORK_HOSTED_MCP_SOURCE_INTEGRITY_OK sha256:[a-f0-9]{64}\n$/);
    assert.equal(run(process.execPath, ['scripts/verify-integrity.mjs', '--quiet'], {
      cwd: fixturePackageRoot,
    }), '');
    assert.equal(run(process.execPath, ['scripts/verify-integrity.mjs', '--source', '--quiet'], {
      cwd: fixturePackageRoot,
    }), '');
    const lfManifest = JSON.parse(await readFile(
      path.join(fixturePackageRoot, 'integrity-manifest.json'),
      'utf8',
    ));
    assert.deepEqual(lfManifest, crlfManifest);

    const loneCrChanged = Buffer.from(original);
    const firstLf = loneCrChanged.indexOf(0x0a);
    assert.ok(firstLf >= 0);
    loneCrChanged[firstLf] = 0x0d;
    await writeFile(tamperedPath, loneCrChanged);
    const loneCrRejected = runResult(process.execPath, ['scripts/build.mjs'], {
      cwd: fixturePackageRoot,
    });
    assert.notEqual(loneCrRejected.status, 0);
    assert.match(
      `${loneCrRejected.stdout}\n${loneCrRejected.stderr}`,
      /Reviewed source bytes changed; --refresh-reviewed-sources is required/,
    );

    const changed = Buffer.concat([original, Buffer.from('\n// isolated digest-tamper fixture\n')]);
    await writeFile(tamperedPath, changed);

    const rejected = runResult(process.execPath, ['scripts/build.mjs'], {
      cwd: fixturePackageRoot,
    });
    assert.notEqual(rejected.status, 0);
    assert.match(
      `${rejected.stdout}\n${rejected.stderr}`,
      /Reviewed source bytes changed; --refresh-reviewed-sources is required/,
    );

    run(process.execPath, ['scripts/build.mjs', '--refresh-reviewed-sources'], {
      cwd: fixturePackageRoot,
    });
    run(process.execPath, ['scripts/build.mjs'], { cwd: fixturePackageRoot });
    run(process.execPath, ['scripts/verify-integrity.mjs', '--source'], {
      cwd: fixturePackageRoot,
    });
    const refreshed = JSON.parse(await readFile(
      path.join(fixturePackageRoot, 'integrity-manifest.json'),
      'utf8',
    ));
    const refreshedMcp = refreshed.reviewed_sources.find(
      (record) => record.path === 'mcp/mcp-server.js',
    );
    assert.equal(refreshedMcp.bytes, changed.byteLength);
    assert.equal(refreshedMcp.sha256, sha256(changed));
  } finally {
    await cleanupTemporary(temporary);
  }
});

test('integrity verification rejects traversal and out-of-scope reviewed source paths', async () => {
  for (const maliciousPath of [
    '../outside-source.mjs',
    'risk-fork/src/../outside-source.mjs',
    'risk-fork/src\\..\\outside-source.mjs',
    'risk-fork/src/alternate:data.mjs',
    'risk-fork/src/canonical.mjs.',
    'risk-fork/src/CON.mjs',
    'risk-fork/src//canonical.mjs',
    'risk-fork/src/canonic\u00e1l.mjs',
    'risk-fork/test/unreviewed-source.mjs',
  ]) {
    const temporary = await mkdtemp(path.join(os.tmpdir(), 'risk-fork-source-path-'));
    try {
      const fixturePackageRoot = path.join(temporary, 'risk-fork-hosted-mcp');
      await mkdir(path.join(fixturePackageRoot, 'scripts'), { recursive: true });
      await cp(
        path.join(packageRoot, 'scripts', 'verify-integrity.mjs'),
        path.join(fixturePackageRoot, 'scripts', 'verify-integrity.mjs'),
      );
      await cp(path.join(packageRoot, 'package.json'), path.join(fixturePackageRoot, 'package.json'));
      const manifest = JSON.parse(await readFile(path.join(packageRoot, 'integrity-manifest.json'), 'utf8'));
      manifest.reviewed_sources[0].path = maliciousPath;
      await writeFile(
        path.join(fixturePackageRoot, 'integrity-manifest.json'),
        `${JSON.stringify(manifest, null, 2)}\n`,
        'utf8',
      );
      const rejected = runResult(process.execPath, ['scripts/verify-integrity.mjs'], {
        cwd: fixturePackageRoot,
      });
      assert.notEqual(rejected.status, 0, maliciousPath);
      assert.match(`${rejected.stdout}\n${rejected.stderr}`, /Reviewed source digest record 0 is invalid/);
    } finally {
      const resolved = path.resolve(temporary);
      assert.ok(resolved.startsWith(`${path.resolve(os.tmpdir())}${path.sep}`));
      await rm(resolved, { recursive: true, force: true });
    }
  }
});

test('integrity verification rejects manifest, package, mapping, ordering, and alias contract drift', async () => {
  const temporary = await mkdtemp(path.join(os.tmpdir(), 'risk-fork-integrity-contract-'));
  const fixturePackageRoot = path.join(temporary, 'risk-fork-hosted-mcp');
  try {
    await mkdir(path.join(fixturePackageRoot, 'scripts'), { recursive: true });
    await cp(
      path.join(packageRoot, 'scripts', 'verify-integrity.mjs'),
      path.join(fixturePackageRoot, 'scripts', 'verify-integrity.mjs'),
    );
    const basePackage = JSON.parse(await readFile(path.join(packageRoot, 'package.json'), 'utf8'));
    const baseManifest = normalizeManifestOrdering(
      JSON.parse(await readFile(path.join(packageRoot, 'integrity-manifest.json'), 'utf8')),
    );
    const cases = [
      {
        name: 'extra manifest key',
        mutateManifest(manifest) { manifest.unreviewed = false; },
        expected: /Hosted MCP integrity manifest must use the exact reviewed key contract/,
      },
      {
        name: 'source contract drift',
        mutateManifest(manifest) { manifest.sources.mcp.version = '2.0.1'; },
        expected: /Hosted MCP integrity manifest contract is invalid/,
      },
      {
        name: 'export reordering',
        mutateManifest(manifest) {
          [manifest.exports[0], manifest.exports[1]] = [manifest.exports[1], manifest.exports[0]];
        },
        expected: /Hosted MCP integrity manifest contract is invalid/,
      },
      {
        name: 'artifact trailing-dot alias',
        mutateManifest(manifest) { manifest.artifact.path = 'dist/runtime/index.mjs.'; },
        expected: /Hosted MCP integrity manifest contract is invalid/,
      },
      {
        name: 'swapped reviewed asset source',
        mutateManifest(manifest) {
          const assets = manifest.packaged_assets.filter((asset) => asset.source_path);
          assets[0].source_path = assets[1].source_path;
        },
        expected: /Manifest packaged asset mapping is invalid/,
      },
      {
        name: 'extra reviewed asset key',
        mutateManifest(manifest) {
          manifest.packaged_assets.find((asset) => asset.source_path).unreviewed = false;
        },
        expected: /Manifest packaged asset \d+ must use the exact reviewed key contract/,
      },
      {
        name: 'duplicate reviewed asset',
        mutateManifest(manifest) {
          manifest.packaged_assets.push({ ...manifest.packaged_assets[0] });
          manifest.packaged_assets.sort((left, right) => compareOrdinal(left.path, right.path));
        },
        expected: /Manifest packaged assets must be strictly ordinal-sorted and unique/,
      },
      {
        name: 'case-fold reviewed source alias',
        mutateManifest(manifest) {
          const canonical = manifest.reviewed_sources.find(
            (record) => record.path === 'risk-fork/src/canonical.mjs',
          );
          manifest.reviewed_sources.push({ ...canonical, path: 'risk-fork/src/Canonical.mjs' });
          manifest.reviewed_sources.sort((left, right) => compareOrdinal(left.path, right.path));
          manifest.source_attestation.files = manifest.reviewed_sources.length;
          manifest.source_attestation.sha256 = reviewedSourceAttestation(manifest.reviewed_sources);
        },
        expected: /Reviewed source digest inventory contains a case-fold alias/,
      },
      {
        name: 'duplicate input',
        mutateManifest(manifest) {
          manifest.inputs.push({ ...manifest.inputs[0] });
          manifest.inputs.sort((left, right) => compareOrdinal(left.path, right.path));
        },
        expected: /Manifest inputs must be strictly ordinal-sorted and unique/,
      },
      {
        name: 'wrong input classification',
        mutateManifest(manifest) {
          manifest.inputs.find(
            (input) => input.path === 'risk-fork-hosted-mcp/src/index.mjs',
          ).source = 'workspace_dependency';
        },
        expected: /Hosted MCP integrity input contract is invalid/,
      },
      {
        name: 'input ADS alias',
        mutateManifest(manifest) { manifest.inputs[0].path = `${manifest.inputs[0].path}:stream`; },
        expected: /Hosted MCP integrity input contract is invalid/,
      },
      {
        name: 'extra package key',
        mutatePackage(pkg) { pkg.unreviewed = false; },
        expected: /package\.json does not match the exact reviewed package contract/,
      },
    ];

    for (const fixtureCase of cases) {
      const manifest = structuredClone(baseManifest);
      const pkg = structuredClone(basePackage);
      fixtureCase.mutateManifest?.(manifest);
      fixtureCase.mutatePackage?.(pkg);
      await writeFile(
        path.join(fixturePackageRoot, 'integrity-manifest.json'),
        `${JSON.stringify(manifest, null, 2)}\n`,
        'utf8',
      );
      await writeFile(
        path.join(fixturePackageRoot, 'package.json'),
        `${JSON.stringify(pkg, null, 2)}\n`,
        'utf8',
      );
      const rejected = runResult(process.execPath, ['scripts/verify-integrity.mjs'], {
        cwd: fixturePackageRoot,
      });
      assert.notEqual(rejected.status, 0, fixtureCase.name);
      assert.match(
        `${rejected.stdout}\n${rejected.stderr}`,
        fixtureCase.expected,
        fixtureCase.name,
      );
    }
  } finally {
    await cleanupTemporary(temporary);
  }
});

test('build and source verification reject reviewed-source root and ancestor links', async () => {
  const fixture = await createHostedFixture('risk-fork-reviewed-source-links-');
  const externalTemporary = await mkdtemp(path.join(os.tmpdir(), 'risk-fork-reviewed-source-external-'));
  try {
    run(process.execPath, ['scripts/build.mjs', '--refresh-reviewed-sources'], {
      cwd: fixture.packageRoot,
    });
    run(process.execPath, ['scripts/verify-integrity.mjs', '--source', '--quiet'], {
      cwd: fixture.packageRoot,
    });

    async function assertLinkRejected(relativePath, externalName) {
      const target = path.join(fixture.repositoryRoot, ...relativePath.split('/'));
      const external = path.join(externalTemporary, externalName);
      await rename(target, external);
      await symlink(external, target, process.platform === 'win32' ? 'junction' : 'dir');
      try {
        for (const args of [
          ['scripts/build.mjs', '--refresh-reviewed-sources'],
          ['scripts/verify-integrity.mjs', '--source'],
        ]) {
          const rejected = runResult(process.execPath, args, { cwd: fixture.packageRoot });
          assert.notEqual(rejected.status, 0, `${relativePath}: ${args.join(' ')}`);
          assert.match(
            `${rejected.stdout}\n${rejected.stderr}`,
            /symlink or reparse point/,
            `${relativePath}: ${args.join(' ')}`,
          );
        }
      } finally {
        await unlink(target);
        await rename(external, target);
      }
    }

    await assertLinkRejected('risk-fork/src', 'reviewed-root');
    await assertLinkRejected('risk-fork', 'reviewed-ancestor');
  } finally {
    await cleanupTemporary(fixture.temporary);
    await cleanupTemporary(externalTemporary);
  }
});

test('bundle exposes the reviewed relay and Risk Fork controller boundaries', async () => {
  const api = await import(`${pathToFileURL(path.join(packageRoot, 'dist', 'runtime', 'index.mjs')).href}?api`);
  for (const name of [
    'MCP_ENFORCEMENT_SCHEMAS',
    'MCP_V2_PROTOCOL_VERSION',
    'computeMcpCleanImportEvidenceHash',
    'connectRemoteClient',
    'createMcpEnforcementBoundary',
    'createCleanupVerificationRequest',
    'createRiskForkHostBoundary',
    'createRiskForkImportEnvelope',
    'createTrustedRiskDescriptor',
    'createTrustedRiskDescriptorSource',
    'runAcpAdapter',
    'runMcpRelay',
    'RiskForkController',
    'RiskForkMcpBoundary',
    'RiskForkProvider',
    'E2BRiskForkAdapter',
    'E2B_EXTERNAL_BIRTH_CONTROLS',
    'E2B_EXTERNAL_QUALIFICATION_EVIDENCE_REFS',
    'E2B_EXTERNAL_QUALIFICATION_OBSERVATION_SCHEMA',
    'E2B_EXTERNAL_PROVIDER_CONTROLS',
    'E2B_INDEPENDENT_SOURCE_ATTESTATION_SCHEMA',
    'E2B_QUALIFICATION_SCHEMA',
    'E2B_QUALIFICATION_TRUST_SCHEMA',
    'E2B_RISK_FORK_PATHS',
    'E2B_RUNTIME_SDK_INTEGRITY_SCHEMA',
    'createE2BAuthorityFreeSourceVerifier',
    'createE2BExternalQualificationObservationVerifier',
    'createE2BQualificationEvidence',
    'createE2BQualificationTrustVerifier',
    'createE2BRuntimeSdkIntegrityVerifier',
    'isE2BQualificationEvidenceCanonical',
    'isE2BRuntimeSdkIntegrityVerifier',
    'loadVerifiedE2BRuntimeSdk',
    'scanE2BStagedBytesAuthorityFree',
    'applyE2BExternalQualificationObservation',
    'validateE2BQualificationEvidence',
    'verifyE2BExternalQualificationObservation',
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
    'verifyCleanupVerificationEvidence',
    'verifyRiskForkImportEnvelope',
  ]) {
    assert.ok(Object.hasOwn(api, name), `missing export ${name}`);
  }
  assert.equal(typeof api.PostgresDistributedCommitAuthority.prototype.getAuthorityStatus, 'function');
  assert.equal(api.isProductionPostgresDistributedCommitAuthority({}), false);
  const manifest = JSON.parse(await readFile(path.join(packageRoot, 'integrity-manifest.json'), 'utf8'));
  assert.equal(
    api.HOSTED_MCP_BUNDLE_METADATA.reviewed_source_integrity,
    manifest.source_attestation.sha256,
  );
  assert.equal(api.HOSTED_MCP_BUNDLE_METADATA.optional_e2b_peer_version, '2.39.0');
  assert.equal(api.HOSTED_MCP_BUNDLE_METADATA.risk_fork_source_version, '0.1.0-alpha.1');
  assert.equal(api.HOSTED_MCP_BUNDLE_METADATA.outbound_mcp_transport_qualified, false);
  assert.equal(api.HOSTED_MCP_BUNDLE_METADATA.managed_postgres_qualified, false);
  assert.equal(api.HOSTED_MCP_BUNDLE_METADATA.e2b_live_qualified, false);

  let injectedLoaderCalls = 0;
  const disabledAdapter = new api.E2BRiskForkAdapter({
    cleanTemplateId: 'template-risk-fork-clean-immutable-v1',
    cleanTemplateHash: sha256(Buffer.from('clean-template')),
    cleanTemplateProvenanceHash: sha256(Buffer.from('clean-template-provenance')),
    workspaceExportDirectory: path.join(packageRoot, '.test-unused-exports'),
    cleanupJournalDirectory: path.join(packageRoot, '.test-unused-journal'),
    verifyAuthorityFreeSource: async () => {
      throw new Error('source verifier must not run while live E2B is source-disabled');
    },
    trustedBootstrapArtifactHash: sha256(Buffer.from('trusted-bootstrap')),
    trustedRunnerArtifactHash: sha256(Buffer.from('trusted-runner')),
  });
  disabledAdapter.offlineConformance = true;
  disabledAdapter.sdkLoader = async () => {
    injectedLoaderCalls += 1;
    throw new Error('provider loader must not run');
  };
  await assert.rejects(
    disabledAdapter.reconcilePendingCleanup(),
    (error) => error?.code === 'E2B_LIVE_FORK_DISABLED_UNTRUSTED_WATCHER'
      && error?.operation === 'reconcilePendingCleanup',
  );
  assert.equal(injectedLoaderCalls, 0);

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
      "import { applyE2BExternalQualificationObservation, createCleanupVerificationRequest, createE2BExternalQualificationObservationVerifier, createMcpEnforcementBoundary, createMcpInterceptionPlan, createRiskForkHostBoundary, createRiskForkImportEnvelope, createTrustedRiskDescriptor, createTrustedRiskDescriptorSource, E2BRiskForkAdapter, E2B_EXTERNAL_BIRTH_CONTROLS, E2B_EXTERNAL_QUALIFICATION_EVIDENCE_REFS, E2B_EXTERNAL_QUALIFICATION_OBSERVATION_SCHEMA, E2B_EXTERNAL_PROVIDER_CONTROLS, verifyCleanupVerificationEvidence, verifyE2BExternalQualificationObservation, verifyPostgresDistributedAuthoritySchema } from '@agoragentic/risk-fork-hosted-mcp';",
      "import { createRiskForkE2BTemplate } from '@agoragentic/risk-fork-hosted-mcp/e2b-context/risk-fork/e2b-template/template.mjs';",
      "assert.equal(typeof createMcpEnforcementBoundary, 'function');",
      "assert.equal(typeof createMcpInterceptionPlan, 'function');",
      "assert.equal(typeof createRiskForkHostBoundary, 'function');",
      "assert.equal(typeof createRiskForkImportEnvelope, 'function');",
      "assert.equal(typeof verifyCleanupVerificationEvidence, 'function');",
      "const descriptorSource = createTrustedRiskDescriptorSource((request) => createTrustedRiskDescriptor(request, { mcp_phase: 'tools/call', raw_method: null, mcp_server_ref: 'server:packed', mcp_server_origin: 'https://mcp.example.test', mcp_server_trust: 'reachable', mcp_server_attestation: null, tool_name: 'workspace_apply_patch', tool_annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false }, capabilities: { network_access: false, filesystem_read: false, filesystem_write: true, credential_access: false, wallet_or_payment: false, deployment: false, publication: false, communication: false, database_mutation: false, trust_or_reputation_mutation: false, external_side_effect: false, unknown_or_unclassified: false }, prompt_injection_indicators: [], owner_policy: { minimum_level: 'LOW', force_risk_fork: false, deny_irreversible: false, trusted_server_refs: [], trusted_attestor_refs: [], trusted_attestation_hashes: [], trust_registry_version: null, allowed_egress: [] } }));",
      "const hostBoundary = createRiskForkHostBoundary({ controller: { async prepare() { return { mode: 'denied', authority_granted: false }; } }, trusted_descriptor_source: descriptorSource, clock: () => '2026-08-29T00:00:00.000Z' });",
      "const hostResult = await hostBoundary.preEffect({ descriptor_ref: 'descriptor:packed', operation_input: { operation: { kind: 'bounded_file_batch', actions: [] }, expected_commit_type: 'TYPED_RESULT' } });",
      "assert.equal(hostResult.authority_granted, false);",
      "const imported = createRiskForkImportEnvelope({ source_fork_ref: 'fork:test', result_hash: `sha256:${'a'.repeat(64)}`, candidate: { type: 'TYPED_RESULT', payload: { ok: true }, payload_schema: { type: 'object', additionalProperties: false, required: ['ok'], properties: { ok: { type: 'boolean' } } } } });",
      "assert.equal(imported.import_type, 'TYPED_RESULT');",
      "const cleanupRequest = createCleanupVerificationRequest({ provider_id: 'provider:test', resource_kind: 'fork', resource_ref: 'fork:test', requested_at: '2026-08-29T00:00:00.000Z', request_nonce: 'nonce:test' });",
      "assert.equal(cleanupRequest.provider_id, 'provider:test');",
      "assert.equal(typeof E2BRiskForkAdapter, 'function');",
      "assert.equal(typeof applyE2BExternalQualificationObservation, 'function');",
      "assert.equal(typeof createE2BExternalQualificationObservationVerifier, 'function');",
      "assert.equal(typeof verifyE2BExternalQualificationObservation, 'function');",
      "assert.equal(Array.isArray(E2B_EXTERNAL_BIRTH_CONTROLS), true);",
      "assert.equal(typeof E2B_EXTERNAL_QUALIFICATION_EVIDENCE_REFS, 'object');",
      "assert.equal(Array.isArray(E2B_EXTERNAL_QUALIFICATION_EVIDENCE_REFS), false);",
      "assert.equal(Object.isFrozen(E2B_EXTERNAL_QUALIFICATION_EVIDENCE_REFS), true);",
      "assert.equal(typeof E2B_EXTERNAL_QUALIFICATION_OBSERVATION_SCHEMA, 'string');",
      "assert.equal(Array.isArray(E2B_EXTERNAL_PROVIDER_CONTROLS), true);",
      "assert.equal(typeof verifyPostgresDistributedAuthoritySchema, 'function');",
      "assert.equal(typeof createRiskForkE2BTemplate, 'function');",
      "let providerLoads = 0;",
      "const hash = 'sha256:' + 'a'.repeat(64);",
      "const adapter = new E2BRiskForkAdapter({ cleanTemplateId: 'template-risk-fork-clean-immutable-v1', cleanTemplateHash: hash, cleanTemplateProvenanceHash: hash, workspaceExportDirectory: process.cwd() + '/unused-exports', cleanupJournalDirectory: process.cwd() + '/unused-journal', verifyAuthorityFreeSource: async () => { throw new Error('not called'); }, trustedBootstrapArtifactHash: hash, trustedRunnerArtifactHash: hash });",
      "adapter.offlineConformance = true;",
      "adapter.sdkLoader = async () => { providerLoads += 1; throw new Error('not called'); };",
      "await assert.rejects(adapter.reconcilePendingCleanup(), (error) => error?.code === 'E2B_LIVE_FORK_DISABLED_UNTRUSTED_WATCHER');",
      "assert.equal(providerLoads, 0);",
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
      'NOTICE',
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
    assert.deepEqual(
      await readFile(path.join(installed, 'LICENSE')),
      canonicalReviewedSourceBytes(
        await readFile(path.join(repositoryRoot, 'risk-fork', 'LICENSE')),
      ),
    );
    assert.deepEqual(
      await readFile(path.join(installed, 'NOTICE')),
      canonicalReviewedSourceBytes(
        await readFile(path.join(repositoryRoot, 'risk-fork', 'NOTICE')),
      ),
    );
    const installedVerifyOutput = run(
      process.execPath,
      [path.join(installed, 'scripts', 'verify-integrity.mjs')],
      { cwd: installed },
    );
    assert.match(
      installedVerifyOutput,
      /^RISK_FORK_HOSTED_MCP_ARTIFACT_INTEGRITY_OK sha256:[a-f0-9]{64}\n$/,
    );
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
