import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  appendFile,
  cp,
  copyFile,
  link,
  lstat,
  mkdir,
  readFile,
  rm,
  symlink,
  unlink,
  writeFile,
} from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { promisify } from 'node:util';
import test from 'node:test';

import { GENERATED_NOT_CLIENT_VERIFIED_STATUS } from '../src/config-generator.mjs';
import {
  OFFLINE_KIT_BANNER,
  OFFLINE_KIT_TRUTH,
  assertSafeArchivePath,
  buildOfflineKit,
  createDeterministicZip,
  extractAndVerifyOfflineKit,
  validateArchiveEntryNames,
  verifyOfflineKit,
  verifyZipArchive,
} from '../src/offline-kit.mjs';

const execFileAsync = promisify(execFile);
const testRoot = path.dirname(fileURLToPath(import.meta.url));
const repositoryRoot = path.resolve(testRoot, '..', '..', '..');
const networkGuard = path.resolve(testRoot, '../scripts/network-guard.mjs');
const networkScope = path.resolve(testRoot, '../scripts/network-scope.mjs');
const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');
const SOURCE_TREES = Object.freeze([
  'risk-fork/src',
  'risk-fork/schema',
  'risk-fork/e2b-template/lib',
  'risk-fork/hackathon/bin',
  'risk-fork/hackathon/src',
  'risk-fork/hackathon/scripts',
  'risk-fork/hackathon/docs',
  'risk-fork/hackathon/recorder',
  'risk-fork/hackathon/fixtures',
]);
const SOURCE_FILES = Object.freeze([
  'risk-fork/package.json',
  'risk-fork/package-lock.json',
  'risk-fork/LICENSE',
  'risk-fork/hackathon/package.json',
  'risk-fork/hackathon/package-lock.json',
  'risk-fork/hackathon/README.md',
  'risk-fork/hackathon/demo-status.json',
]);

const STANDARD_DNS_RESOLVER_QUERY_METHODS = Object.freeze([
  'resolve',
  'resolve4',
  'resolve6',
  'resolveAny',
  'resolveCaa',
  'resolveCname',
  'resolveMx',
  'resolveNaptr',
  'resolveNs',
  'resolvePtr',
  'resolveSoa',
  'resolveSrv',
  'resolveTlsa',
  'resolveTxt',
  'reverse',
]);

async function writeFixture(root, relative, content) {
  const target = path.join(root, ...relative.split('/'));
  await mkdir(path.dirname(target), { recursive: true });
  await writeFile(target, content, { flag: 'wx' });
}

async function makeSourceRepository(parent) {
  const repository = path.join(parent, 'public-source');
  const tamperedMarker = 'TAMPERED-SOURCE-NODE-MODULES-MUST-NOT-BE-PACKAGED.txt';
  const ignoredTreeMarker = 'IGNORED-WORKTREE-BYTES-MUST-NOT-BE-PACKAGED.mjs';
  await mkdir(repository);
  for (const relative of SOURCE_TREES) {
    await cp(path.join(repositoryRoot, relative), path.join(repository, relative), {
      recursive: true,
      errorOnExist: true,
      force: false,
    });
  }
  for (const relative of SOURCE_FILES) {
    const destination = path.join(repository, relative);
    await mkdir(path.dirname(destination), { recursive: true });
    await copyFile(path.join(repositoryRoot, relative), destination, 1);
  }
  await writeFixture(
    repository,
    '.gitignore',
    `risk-fork/node_modules/\nrisk-fork/hackathon/src/${ignoredTreeMarker}\n`,
  );

  await execFileAsync('git', ['init', '--initial-branch=main'], { cwd: repository, windowsHide: true });
  await execFileAsync('git', ['config', 'user.email', 'offline-kit@example.invalid'], { cwd: repository, windowsHide: true });
  await execFileAsync('git', ['config', 'user.name', 'Offline Kit Test'], { cwd: repository, windowsHide: true });
  await execFileAsync('git', ['config', 'commit.gpgsign', 'false'], { cwd: repository, windowsHide: true });
  await execFileAsync('git', ['add', '--', '.gitignore', 'risk-fork'], { cwd: repository, windowsHide: true });
  await execFileAsync('git', ['commit', '--no-gpg-sign', '-m', 'fixture'], { cwd: repository, windowsHide: true });
  const { stdout } = await execFileAsync('git', ['rev-parse', 'HEAD'], { cwd: repository, windowsHide: true });
  await writeFixture(
    repository,
    `risk-fork/node_modules/ajv/${tamperedMarker}`,
    'untrusted ignored source dependency bytes\n',
  );
  await writeFixture(
    repository,
    `risk-fork/hackathon/src/${ignoredTreeMarker}`,
    'throw new Error("ignored worktree bytes entered the commit-pinned kit");\n',
  );
  return {
    repository,
    sourceCommit: stdout.trim(),
    tamperedMarker,
    ignoredTreeMarker,
  };
}

function minimalSpawnEnvironment(extra = {}) {
  return {
    SystemRoot: process.env.SystemRoot,
    WINDIR: process.env.WINDIR,
    ...extra,
  };
}

async function runGuardProbe(source, extraEnv = {}) {
  return execFileAsync(process.execPath, [
    '--import',
    pathToFileURL(networkGuard).href,
    '--input-type=module',
    '--eval',
    source,
  ], {
    cwd: testRoot,
    env: minimalSpawnEnvironment(extraEnv),
    windowsHide: true,
    timeout: 10_000,
  });
}

test('offline kit is commit-pinned, deterministic, extractable, and self-verifying', async (t) => {
  const temporary = await import('node:fs/promises').then(({ mkdtemp }) => mkdtemp(path.join(os.tmpdir(), 'risk-fork-kit-')));
  t.after(() => rm(temporary, { recursive: true, force: true }));
  const {
    repository,
    sourceCommit,
    tamperedMarker,
    ignoredTreeMarker,
  } = await makeSourceRepository(temporary);
  const validationSummary = {
    status: 'passed',
    representative_scenarios: ['low-read-only', 'high-filesystem-write', 'irreversible-deployment-proposal'],
    provider_calls: 0,
    network_used: false,
  };
  const first = await buildOfflineKit({
    repositoryRoot: repository,
    sourceCommit,
    outputBase: path.join(temporary, 'artifacts-one'),
    validationSummary,
  });
  const second = await buildOfflineKit({
    repositoryRoot: repository,
    sourceCommit,
    outputBase: path.join(temporary, 'artifacts-two'),
    validationSummary,
  });

  assert.equal(first.source_commit, sourceCommit);
  assert.equal(first.source_copy.source_materialization, 'exact_git_blobs');
  assert.equal(first.source_copy.ignored_worktree_files_included, false);
  assert.equal(first.zip_sha256, second.zip_sha256);
  assert.deepEqual(await readFile(first.zip_path), await readFile(second.zip_path));
  for (const [key, value] of Object.entries(OFFLINE_KIT_TRUTH)) assert.equal(first[key], value);

  const manifest = JSON.parse(await readFile(path.join(first.kit_directory, 'MANIFEST.json'), 'utf8'));
  assert.equal(manifest.banner, OFFLINE_KIT_BANNER);
  assert.equal(manifest.source_commit, sourceCommit);
  assert.equal(manifest.source_materialization, 'exact_git_blobs');
  assert.equal(manifest.ignored_worktree_files_included, false);
  assert.equal(manifest.file_count, manifest.files.length);
  assert.deepEqual(
    manifest.files.map((entry) => entry.path),
    [...manifest.files.map((entry) => entry.path)].sort((left, right) => Buffer.compare(Buffer.from(left), Buffer.from(right))),
  );
  assert.ok(manifest.files.some((entry) => entry.path === 'risk-fork/hackathon/fixtures/catalog.json'));
  assert.ok(manifest.files.some((entry) => entry.path === 'risk-fork/node_modules/ajv/package.json'));
  assert.ok(manifest.files.some((entry) => entry.path === 'DEPENDENCY_PROVENANCE.json'));
  assert.ok(!manifest.files.some((entry) => entry.path.endsWith(`/${tamperedMarker}`)));
  assert.ok(!manifest.files.some((entry) => entry.path.endsWith(`/${ignoredTreeMarker}`)));
  await assert.rejects(
    readFile(path.join(first.kit_directory, 'risk-fork/node_modules/ajv', tamperedMarker)),
    (error) => error?.code === 'ENOENT',
  );
  await assert.rejects(
    readFile(path.join(first.kit_directory, 'risk-fork/hackathon/src', ignoredTreeMarker)),
    (error) => error?.code === 'ENOENT',
  );
  const dependencyProvenance = JSON.parse(
    await readFile(path.join(first.kit_directory, 'DEPENDENCY_PROVENANCE.json'), 'utf8'),
  );
  assert.equal(
    dependencyProvenance.schema,
    'agoragentic.risk-fork.offline-dependency-provenance.v1',
  );
  assert.equal(dependencyProvenance.materialization, 'npm_ci_offline_from_lock_cache');
  assert.equal(dependencyProvenance.source_node_modules_used, false);
  assert.equal(dependencyProvenance.network_used, false);
  assert.equal(dependencyProvenance.install_scripts_executed, false);
  assert.match(dependencyProvenance.lockfile_sha256, /^[0-9a-f]{64}$/);
  assert.deepEqual(
    dependencyProvenance.packages.map((entry) => entry.name),
    [
      'ajv',
      'ajv-formats',
      'fast-deep-equal',
      'fast-uri',
      'json-schema-traverse',
      'require-from-string',
    ],
  );
  assert.ok(dependencyProvenance.packages.every((entry) => (
    /^sha512-[A-Za-z0-9+/]+={0,2}$/.test(entry.integrity)
    && /^[0-9a-f]{64}$/.test(entry.tree_sha256)
    && entry.file_count > 0
    && entry.total_bytes > 0
  )));
  assert.equal(manifest.configuration_status.templates_generated, 4);
  assert.equal(manifest.configuration_status.templates_client_verified, 0);
  assert.equal(
    manifest.configuration_status.unverified_client_status,
    GENERATED_NOT_CLIENT_VERIFIED_STATUS,
  );
  const configRoot = path.join(first.kit_directory, 'risk-fork/hackathon/configs');
  const configIndex = JSON.parse(await readFile(path.join(configRoot, 'configuration-index.json'), 'utf8'));
  assert.equal(configIndex.records.length, 4);
  assert.ok(configIndex.records.every((record) => (
    record.verification_status === GENERATED_NOT_CLIENT_VERIFIED_STATUS
    && record.verification_detail
      === 'generated_portable_template_requires_path_regeneration_and_live_client_verification'
  )));
  const portableCodex = await readFile(path.join(configRoot, 'codex-risk-fork-demo.toml.template'), 'utf8');
  assert.match(portableCodex, /verification_status = "generated_not_client_verified"/);
  assert.match(portableCodex, /verification_detail = "generated_portable_template_requires_path_regeneration_and_live_client_verification"/);
  const portableGeneric = JSON.parse(
    await readFile(path.join(configRoot, 'generic-risk-fork-demo.json.template'), 'utf8'),
  );
  assert.equal(portableGeneric._verification_status, GENERATED_NOT_CLIENT_VERIFIED_STATUS);
  assert.equal(
    portableGeneric._verification_detail,
    'generated_portable_template_requires_path_regeneration_and_live_client_verification',
  );

  const directoryVerification = await verifyOfflineKit({ kitDirectory: first.kit_directory });
  const zipVerification = await verifyZipArchive({ zipPath: first.zip_path });
  assert.equal(directoryVerification.verified, true);
  assert.equal(directoryVerification.dependency_provenance.verified, true);
  assert.equal(directoryVerification.dependency_provenance.package_count, 6);
  assert.equal(zipVerification.verified, true);
  assert.equal(zipVerification.sha256, first.zip_sha256);

  const extracted = path.join(temporary, 'fresh-extraction');
  const extraction = await extractAndVerifyOfflineKit({ zipPath: first.zip_path, destination: extracted });
  assert.equal(extraction.verification.verified, true);
  assert.equal(extraction.verification.source_commit, sourceCommit);
  assert.equal(
    await readFile(path.join(extracted, 'risk-fork/hackathon/fixtures/catalog.json'), 'utf8'),
    await readFile(path.join(first.kit_directory, 'risk-fork/hackathon/fixtures/catalog.json'), 'utf8'),
  );

  await assert.rejects(
    buildOfflineKit({
      repositoryRoot: repository,
      sourceCommit,
      outputBase: path.join(temporary, 'artifacts-one'),
      validationSummary,
    }),
    /already exists/,
  );
  await assert.rejects(
    extractAndVerifyOfflineKit({ zipPath: first.zip_path, destination: extracted }),
    /already exists/,
  );
});

test('offline dependency reification fails closed on an empty cache and leaves no artifact', async (t) => {
  const { mkdtemp } = await import('node:fs/promises');
  const temporary = await mkdtemp(path.join(os.tmpdir(), 'risk-fork-kit-cache-miss-'));
  t.after(() => rm(temporary, { recursive: true, force: true }));
  const { repository, sourceCommit } = await makeSourceRepository(temporary);
  const emptyCache = path.join(temporary, 'empty-cache');
  const outputBase = path.join(temporary, 'artifacts');
  await mkdir(emptyCache);

  await assert.rejects(
    buildOfflineKit({
      repositoryRoot: repository,
      sourceCommit,
      outputBase,
      npmCacheDirectory: emptyCache,
    }),
    /Offline npm lock-integrity reification failed closed/,
  );
  const shortCommit = sourceCommit.slice(0, 12);
  await assert.rejects(lstat(path.join(outputBase, shortCommit)), (error) => error?.code === 'ENOENT');
  await assert.rejects(
    lstat(path.join(outputBase, `.${shortCommit}.building`)),
    (error) => error?.code === 'ENOENT',
  );
});

test('offline dependency reification rejects lock integrity drift before packaging', async (t) => {
  const { mkdtemp } = await import('node:fs/promises');
  const temporary = await mkdtemp(path.join(os.tmpdir(), 'risk-fork-kit-integrity-'));
  t.after(() => rm(temporary, { recursive: true, force: true }));
  const { repository } = await makeSourceRepository(temporary);
  const lockPath = path.join(repository, 'risk-fork/package-lock.json');
  const lock = JSON.parse(await readFile(lockPath, 'utf8'));
  lock.packages['node_modules/ajv'].integrity = `sha512-${Buffer.alloc(64, 0xa5).toString('base64')}`;
  await writeFile(lockPath, `${JSON.stringify(lock, null, 2)}\n`);
  await execFileAsync('git', ['add', '--', 'risk-fork/package-lock.json'], {
    cwd: repository,
    windowsHide: true,
  });
  await execFileAsync('git', ['commit', '--no-gpg-sign', '-m', 'mutated integrity fixture'], {
    cwd: repository,
    windowsHide: true,
  });
  const { stdout } = await execFileAsync('git', ['rev-parse', 'HEAD'], {
    cwd: repository,
    windowsHide: true,
  });

  await assert.rejects(
    buildOfflineKit({
      repositoryRoot: repository,
      sourceCommit: stdout.trim(),
      outputBase: path.join(temporary, 'artifacts'),
    }),
    /Offline npm lock-integrity reification failed closed/,
  );
});

test('directory verifier rejects tampered, extra, missing, hard-linked, and linked entries', async (t) => {
  const { mkdtemp } = await import('node:fs/promises');
  const temporary = await mkdtemp(path.join(os.tmpdir(), 'risk-fork-kit-attacks-'));
  t.after(() => rm(temporary, { recursive: true, force: true }));
  const { repository, sourceCommit } = await makeSourceRepository(temporary);
  const build = await buildOfflineKit({
    repositoryRoot: repository,
    sourceCommit,
    outputBase: path.join(temporary, 'artifacts'),
  });

  const tampered = path.join(temporary, 'tampered');
  await extractAndVerifyOfflineKit({ zipPath: build.zip_path, destination: tampered });
  await appendFile(path.join(tampered, 'README.md'), 'tampered\n');
  await assert.rejects(verifyOfflineKit({ kitDirectory: tampered }), /integrity mismatch/);

  const extra = path.join(temporary, 'extra');
  await extractAndVerifyOfflineKit({ zipPath: build.zip_path, destination: extra });
  await writeFile(path.join(extra, 'unexpected.txt'), 'unexpected\n');
  await assert.rejects(verifyOfflineKit({ kitDirectory: extra }), /extra or missing files/);

  const missing = path.join(temporary, 'missing');
  await extractAndVerifyOfflineKit({ zipPath: build.zip_path, destination: missing });
  await unlink(path.join(missing, 'README.md'));
  await assert.rejects(verifyOfflineKit({ kitDirectory: missing }), /extra or missing files/);

  const hardLinked = path.join(temporary, 'hard-linked');
  await extractAndVerifyOfflineKit({ zipPath: build.zip_path, destination: hardLinked });
  const original = path.join(hardLinked, 'README.md');
  const preserved = path.join(temporary, 'preserved-readme');
  await copyFile(original, preserved);
  await unlink(original);
  await link(preserved, original);
  await assert.rejects(verifyOfflineKit({ kitDirectory: hardLinked }), /hard linked/);

  const linked = path.join(temporary, 'linked');
  await extractAndVerifyOfflineKit({ zipPath: build.zip_path, destination: linked });
  try {
    await symlink(path.join(linked, 'risk-fork'), path.join(linked, 'linked-risk-fork'), 'junction');
  } catch (error) {
    if (['EPERM', 'EACCES', 'UNKNOWN'].includes(error?.code)) {
      t.diagnostic(`junction test unavailable: ${error.code}`);
      return;
    }
    throw error;
  }
  await assert.rejects(verifyOfflineKit({ kitDirectory: linked }), /Links are forbidden/);
});

test('archive path validation rejects platform aliases and collisions', () => {
  const rejected = [
    '/absolute/file',
    'C:/drive/file',
    '//server/share/file',
    '..\\escape',
    '../escape',
    './dot',
    'a//empty',
    'dir/file ',
    'dir/file.',
    'CON',
    'dir/LPT1.txt',
    'dir/name:stream',
    `decomposed/e\u0301.txt`,
  ];
  for (const candidate of rejected) {
    assert.throws(() => assertSafeArchivePath(candidate), Error, candidate);
  }
  assert.throws(
    () => validateArchiveEntryNames(['safe/File.txt', 'safe/file.txt']),
    /collision/,
  );
  assert.throws(
    () => validateArchiveEntryNames(['café.txt', `cafe\u0301.txt`]),
    /canonical NFC|collision/,
  );
  assert.equal(assertSafeArchivePath('safe/path/file.json'), 'safe/path/file.json');
});

test('ZIP verifier rejects tampering and forged link metadata before extraction', async (t) => {
  const { mkdtemp } = await import('node:fs/promises');
  const temporary = await mkdtemp(path.join(os.tmpdir(), 'risk-fork-zip-attacks-'));
  t.after(() => rm(temporary, { recursive: true, force: true }));
  const { repository, sourceCommit } = await makeSourceRepository(temporary);
  const build = await buildOfflineKit({
    repositoryRoot: repository,
    sourceCommit,
    outputBase: path.join(temporary, 'artifacts'),
  });
  const bytes = await readFile(build.zip_path);

  const corrupted = Buffer.from(bytes);
  const firstLocalNameLength = corrupted.readUInt16LE(26);
  const firstDataOffset = 30 + firstLocalNameLength;
  corrupted[firstDataOffset] ^= 0xff;
  const corruptedPath = path.join(temporary, 'corrupted.zip');
  await writeFile(corruptedPath, corrupted);
  await assert.rejects(verifyZipArchive({ zipPath: corruptedPath }), /CRC mismatch/);

  const forgedLink = Buffer.from(bytes);
  const centralSignature = Buffer.from([0x50, 0x4b, 0x01, 0x02]);
  const centralOffset = forgedLink.indexOf(centralSignature);
  assert.ok(centralOffset > 0);
  forgedLink.writeUInt32LE((0o120777 << 16) >>> 0, centralOffset + 38);
  const forgedPath = path.join(temporary, 'forged-link.zip');
  await writeFile(forgedPath, forgedLink);
  await assert.rejects(verifyZipArchive({ zipPath: forgedPath }), /link\/special entry/);
  await assert.rejects(
    extractAndVerifyOfflineKit({ zipPath: forgedPath, destination: path.join(temporary, 'must-not-extract') }),
    /link\/special entry/,
  );
});

test('failed semantic extraction removes the exact owned stage and leaves no destination', async (t) => {
  const { mkdtemp } = await import('node:fs/promises');
  const temporary = await mkdtemp(path.join(os.tmpdir(), 'risk-fork-extraction-rollback-'));
  t.after(() => rm(temporary, { recursive: true, force: true }));
  const { repository, sourceCommit } = await makeSourceRepository(temporary);
  const build = await buildOfflineKit({
    repositoryRoot: repository,
    sourceCommit,
    outputBase: path.join(temporary, 'artifacts'),
  });
  const forgedSource = path.join(temporary, 'forged-source');
  await extractAndVerifyOfflineKit({ zipPath: build.zip_path, destination: forgedSource });

  const provenancePath = path.join(forgedSource, 'DEPENDENCY_PROVENANCE.json');
  const provenance = JSON.parse(await readFile(provenancePath, 'utf8'));
  provenance.materialization = 'forged_unverified_materialization';
  const provenanceBytes = Buffer.from(`${JSON.stringify(provenance, null, 2)}\n`, 'utf8');
  await writeFile(provenancePath, provenanceBytes);

  const manifestPath = path.join(forgedSource, 'MANIFEST.json');
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
  const provenanceEntry = manifest.files.find((entry) => entry.path === 'DEPENDENCY_PROVENANCE.json');
  assert.ok(provenanceEntry);
  manifest.total_bytes += provenanceBytes.length - provenanceEntry.bytes;
  provenanceEntry.bytes = provenanceBytes.length;
  provenanceEntry.sha256 = sha256(provenanceBytes);
  await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);

  const forgedZip = path.join(temporary, 'forged-semantic.zip');
  await createDeterministicZip({ sourceDirectory: forgedSource, outputPath: forgedZip });
  const destination = path.join(temporary, 'must-remain-absent');
  const stage = path.join(temporary, '.must-remain-absent.risk-fork-extracting');
  const owner = `${stage}.risk-fork-extraction-owner.json`;
  await assert.rejects(
    extractAndVerifyOfflineKit({ zipPath: forgedZip, destination }),
    /dependency provenance boundary is invalid/i,
  );
  for (const absent of [destination, stage, owner]) {
    await assert.rejects(lstat(absent), (error) => error?.code === 'ENOENT');
  }
});

test('network guard blocks outbound socket, HTTP, fetch, and DNS without attempting external I/O', async () => {
  const source = `
    import net from 'node:net';
    import http from 'node:http';
    import dns, { Resolver as DnsResolver, resolve4 as namedResolve4 } from 'node:dns';
    import {
      Resolver as PromiseDnsResolver,
      resolve4 as namedPromiseResolve4,
    } from 'node:dns/promises';
    const resolver = new DnsResolver();
    const promiseResolver = new PromiseDnsResolver();
    const results = [];
    for (const [name, operation] of [
      ['net', () => net.connect({ host: '203.0.113.1', port: 9 })],
      ['http', () => http.get('http://example.invalid/')],
      ['dns', () => dns.resolve4('example.invalid')],
      ['fetch', () => fetch('http://example.invalid/')],
    ]) {
      try { await operation(); results.push([name, 'unexpected']); }
      catch (error) { results.push([name, error.code]); }
    }
    for (const [name, guardedFunction, operation] of [
      ['dns.named.resolve4', namedResolve4, () => namedResolve4('example.invalid')],
      ['dns.Resolver.resolve4', resolver.resolve4, () => resolver.resolve4('example.invalid')],
      ['dns.promises.named.resolve4', namedPromiseResolve4, () => namedPromiseResolve4('example.invalid')],
      [
        'dns.promises.Resolver.resolve4',
        promiseResolver.resolve4,
        () => promiseResolver.resolve4('example.invalid'),
      ],
    ]) {
      if (guardedFunction.name !== 'blockedNetworkOperation') {
        results.push([name, 'unguarded']);
        continue;
      }
      try { await operation(); results.push([name, 'unexpected']); }
      catch (error) { results.push([name, error.code]); }
    }
    const status = globalThis[Symbol.for('agoragentic.risk-fork.demo.network-guard.v1')];
    process.stdout.write(JSON.stringify({ results, status }));
  `;
  const { stdout } = await runGuardProbe(source);
  const { results, status } = JSON.parse(stdout);
  assert.deepEqual(results, [
    ['net', 'RISK_FORK_DEMO_NETWORK_BLOCKED'],
    ['http', 'RISK_FORK_DEMO_NETWORK_BLOCKED'],
    ['dns', 'RISK_FORK_DEMO_NETWORK_BLOCKED'],
    ['fetch', 'RISK_FORK_DEMO_NETWORK_BLOCKED'],
    ['dns.named.resolve4', 'RISK_FORK_DEMO_NETWORK_BLOCKED'],
    ['dns.Resolver.resolve4', 'RISK_FORK_DEMO_NETWORK_BLOCKED'],
    ['dns.promises.named.resolve4', 'RISK_FORK_DEMO_NETWORK_BLOCKED'],
    ['dns.promises.Resolver.resolve4', 'RISK_FORK_DEMO_NETWORK_BLOCKED'],
  ]);
  for (const surface of [
    'node:dns.resolve4',
    'node:dns.promises.resolve4',
    'node:dns.Resolver.resolve4',
    'node:dns.promises.Resolver.resolve4',
  ]) {
    assert.ok(status.guarded_surfaces.includes(surface), surface);
  }
});

test('network guard covers every runtime DNS resolver query surface including optional TLSA', async () => {
  const source = `
    import dns, * as dnsNamespace from 'node:dns';
    import dnsPromises, * as dnsPromisesNamespace from 'node:dns/promises';
    const expectedNames = ${JSON.stringify(STANDARD_DNS_RESOLVER_QUERY_METHODS)};
    const observedNames = [...new Set([
      ...Object.keys(dns),
      ...Object.keys(dnsPromises),
      ...Object.getOwnPropertyNames(dns.Resolver.prototype),
      ...Object.getOwnPropertyNames(dnsPromises.Resolver.prototype),
    ].filter((name) => name === 'reverse' || name.startsWith('resolve')))].sort();
    const unexpectedNames = observedNames.filter((name) => !expectedNames.includes(name));
    const unguardedSurfaces = [];
    const missingEvidence = [];
    const status = globalThis[Symbol.for('agoragentic.risk-fork.demo.network-guard.v1')];
    for (const name of observedNames) {
      const surfaces = [
        ['dns.default', dns[name]],
        ['dns.named', dnsNamespace[name]],
        ['dns.promises.default', dnsPromises[name]],
        ['dns.promises.named', dnsPromisesNamespace[name]],
        ['dns.Resolver.prototype', dns.Resolver.prototype[name]],
        ['dns.promises.Resolver.prototype', dnsPromises.Resolver.prototype[name]],
      ];
      for (const [surface, guardedFunction] of surfaces) {
        if (typeof guardedFunction === 'function' && guardedFunction.name !== 'blockedNetworkOperation') {
          unguardedSurfaces.push(surface + '.' + name);
        }
      }
      for (const [available, evidence] of [
        [typeof dns[name] === 'function', 'node:dns.' + name],
        [typeof dnsPromises[name] === 'function', 'node:dns.promises.' + name],
        [typeof dns.Resolver.prototype[name] === 'function', 'node:dns.Resolver.' + name],
        [typeof dnsPromises.Resolver.prototype[name] === 'function', 'node:dns.promises.Resolver.' + name],
      ]) {
        if (available && !status.guarded_surfaces.includes(evidence)) missingEvidence.push(evidence);
      }
    }

    const tlsaResults = [];
    if (observedNames.includes('resolveTlsa')) {
      const resolver = new dns.Resolver();
      const promiseResolver = new dnsPromises.Resolver();
      for (const [surface, guardedFunction, operation] of [
        ['dns.default.resolveTlsa', dns.resolveTlsa, () => dns.resolveTlsa('example.invalid')],
        ['dns.named.resolveTlsa', dnsNamespace.resolveTlsa, () => dnsNamespace.resolveTlsa('example.invalid')],
        ['dns.promises.default.resolveTlsa', dnsPromises.resolveTlsa, () => dnsPromises.resolveTlsa('example.invalid')],
        ['dns.promises.named.resolveTlsa', dnsPromisesNamespace.resolveTlsa, () => dnsPromisesNamespace.resolveTlsa('example.invalid')],
        ['dns.Resolver.resolveTlsa', resolver.resolveTlsa, () => resolver.resolveTlsa('example.invalid')],
        ['dns.promises.Resolver.resolveTlsa', promiseResolver.resolveTlsa, () => promiseResolver.resolveTlsa('example.invalid')],
      ]) {
        if (typeof guardedFunction !== 'function') {
          tlsaResults.push([surface, 'missing']);
        } else if (guardedFunction.name !== 'blockedNetworkOperation') {
          tlsaResults.push([surface, 'unguarded']);
        } else {
          try { await operation(); tlsaResults.push([surface, 'unexpected']); }
          catch (error) { tlsaResults.push([surface, error.code]); }
        }
      }
    }
    process.stdout.write(JSON.stringify({
      nodeMajor: Number(process.versions.node.split('.')[0]),
      observedNames,
      unexpectedNames,
      unguardedSurfaces,
      missingEvidence,
      tlsaResults,
    }));
  `;
  const { stdout } = await runGuardProbe(source);
  const result = JSON.parse(stdout);
  assert.deepEqual(result.unexpectedNames, []);
  assert.deepEqual(result.unguardedSurfaces, []);
  assert.deepEqual(result.missingEvidence, []);
  if (result.nodeMajor >= 24) {
    assert.ok(result.observedNames.includes('resolveTlsa'));
    assert.equal(result.tlsaResults.length, 6);
    assert.ok(result.tlsaResults.every(([, code]) => code === 'RISK_FORK_DEMO_NETWORK_BLOCKED'));
  } else if (result.observedNames.includes('resolveTlsa')) {
    assert.equal(result.tlsaResults.length, 6);
    assert.ok(result.tlsaResults.every(([, code]) => code === 'RISK_FORK_DEMO_NETWORK_BLOCKED'));
  } else {
    assert.deepEqual(result.tlsaResults, []);
  }
});

test('network guard blocks HTTP/2, WebSocket, EventSource, and direct Undici APIs before connection', async () => {
  const source = `
    import { connect as http2Connect } from 'node:http2';
    import { createRequire } from 'node:module';
    const require = createRequire(${JSON.stringify(pathToFileURL(networkGuard).href)});
    let undici = null;
    try { undici = require('undici'); }
    catch (error) { if (error.code !== 'MODULE_NOT_FOUND') throw error; }

    const operations = [
      ['http2.connect', () => http2Connect('http://127.0.0.1:9')],
      ['global.WebSocket', () => typeof WebSocket === 'function'
        ? new WebSocket('ws://127.0.0.1:9')
        : 'unavailable'],
      ['global.EventSource', () => typeof EventSource === 'function'
        ? new EventSource('http://127.0.0.1:9')
        : 'unavailable'],
      ['undici.request', () => undici ? undici.request('http://127.0.0.1:9') : 'unavailable'],
      ['undici.fetch', () => undici ? undici.fetch('http://127.0.0.1:9') : 'unavailable'],
      ['undici.Client', () => undici ? new undici.Client('http://127.0.0.1:9') : 'unavailable'],
      ['undici.WebSocket', () => undici?.WebSocket
        ? new undici.WebSocket('ws://127.0.0.1:9')
        : 'unavailable'],
      ['undici.EventSource', () => undici?.EventSource
        ? new undici.EventSource('http://127.0.0.1:9')
        : 'unavailable'],
    ];
    const results = [];
    for (const [name, operation] of operations) {
      try {
        const value = await operation();
        if (value !== 'unavailable') {
          value?.on?.('error', () => {});
          value?.close?.();
          value?.destroy?.();
        }
        results.push([name, value === 'unavailable' ? 'unavailable' : 'unexpected']);
      } catch (error) {
        results.push([name, error.code]);
      }
    }
    const status = globalThis[Symbol.for('agoragentic.risk-fork.demo.network-guard.v1')];
    process.stdout.write(JSON.stringify({ results, status }));
  `;
  const { stdout } = await runGuardProbe(source);
  const { results, status } = JSON.parse(stdout);
  const resultByName = Object.fromEntries(results);

  assert.equal(resultByName['http2.connect'], 'RISK_FORK_DEMO_NETWORK_BLOCKED');
  assert.ok(
    ['RISK_FORK_DEMO_NETWORK_BLOCKED', 'unavailable'].includes(resultByName['global.WebSocket']),
    'global.WebSocket was not blocked or unavailable',
  );
  assert.ok(
    ['RISK_FORK_DEMO_NETWORK_BLOCKED', 'unavailable'].includes(resultByName['global.EventSource']),
  );
  for (const name of [
    'undici.request',
    'undici.fetch',
    'undici.Client',
    'undici.WebSocket',
    'undici.EventSource',
  ]) {
    assert.ok(
      ['RISK_FORK_DEMO_NETWORK_BLOCKED', 'unavailable'].includes(resultByName[name]),
      `${name} was not blocked or unavailable`,
    );
  }
  assert.equal(status.enforcement_scope, 'best_effort_in_process_api_guard');
  assert.equal(status.os_egress_enforced, false);
  assert.equal(status.network_used, false);
  assert.equal(status.network_used_scope, 'observed_demo_execution_only');
  assert.ok(status.guarded_surfaces.includes('node:http2.connect'));
  assert.equal(
    status.guarded_surfaces.includes('globalThis.WebSocket'),
    resultByName['global.WebSocket'] === 'RISK_FORK_DEMO_NETWORK_BLOCKED',
  );
  assert.ok(status.guarded_surfaces.includes('undici.request'));
  assert.ok(status.guarded_surfaces.includes('undici.EventSource'));
});

test('network guard allows literal loopback only inside its explicit async command scope', async () => {
  const source = `
    import http from 'node:http';
    const { runWithRiskForkDemoLoopback } = await import(${JSON.stringify(pathToFileURL(networkScope).href)});
    const result = await runWithRiskForkDemoLoopback(async () => {
      const server = http.createServer((request, response) => {
        if (request.url === '/redirect') {
          response.writeHead(302, { location: 'http://example.invalid/must-not-follow' });
          response.end();
          return;
        }
        response.writeHead(200, { 'content-type': 'text/plain' });
        response.end('REPLAY');
      });
      await new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(0, '127.0.0.1', resolve);
      });
      const { port } = server.address();
      const value = await new Promise((resolve, reject) => {
        http.get({ host: '127.0.0.1', port, path: '/' }, (response) => {
          let body = '';
          response.setEncoding('utf8');
          response.on('data', (chunk) => { body += chunk; });
          response.on('end', () => resolve(body));
        }).once('error', reject);
      });
      const fetchValue = await (await fetch('http://127.0.0.1:' + port + '/')).text();
      const redirect = await fetch('http://127.0.0.1:' + port + '/redirect');
      let externalCode = null;
      try { http.get('http://example.invalid/'); }
      catch (error) { externalCode = error.code; }
      await new Promise((resolve) => server.close(resolve));
      return { value, fetchValue, redirectStatus: redirect.status, externalCode };
    });
    process.stdout.write(JSON.stringify(result));
  `;
  const { stdout } = await runGuardProbe(source);
  assert.deepEqual(JSON.parse(stdout), {
    value: 'REPLAY',
    fetchValue: 'REPLAY',
    redirectStatus: 302,
    externalCode: 'RISK_FORK_DEMO_NETWORK_BLOCKED',
  });

  const blocked = `
    import http from 'node:http';
    try { http.get({ host: '127.0.0.1', port: 9, path: '/' }); }
    catch (error) { process.stdout.write(error.code); }
  `;
  const result = await runGuardProbe(blocked, { RISK_FORK_DEMO_ALLOW_LOOPBACK: '1' });
  assert.equal(result.stdout, 'RISK_FORK_DEMO_NETWORK_BLOCKED');
});
