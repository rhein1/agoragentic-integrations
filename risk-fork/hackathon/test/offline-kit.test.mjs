import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import {
  appendFile,
  copyFile,
  link,
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
  extractAndVerifyOfflineKit,
  validateArchiveEntryNames,
  verifyOfflineKit,
  verifyZipArchive,
} from '../src/offline-kit.mjs';

const execFileAsync = promisify(execFile);
const testRoot = path.dirname(fileURLToPath(import.meta.url));
const networkGuard = path.resolve(testRoot, '../scripts/network-guard.mjs');

const SCENARIO_IDS = Object.freeze([
  'low-read-only',
  'elevated-owner-policy',
  'high-filesystem-write',
  'high-incomplete-metadata',
  'high-untrusted-discovery',
  'high-prompt-injection',
  'irreversible-deployment-proposal',
  'deny-owner-policy',
  'cleanup-unknown',
  'stale-governance-binding',
  'malformed-lifecycle-receipt',
  'attack-traversal',
  'attack-link',
  'attack-secret',
  'attack-oversized-write',
  'attack-timeout',
  'attack-concurrency',
]);

const DEPENDENCIES = Object.freeze([
  ['ajv', '8.20.0'],
  ['ajv-formats', '3.0.1'],
  ['fast-deep-equal', '3.1.3'],
  ['fast-uri', '3.1.0'],
  ['json-schema-traverse', '1.0.0'],
  ['require-from-string', '2.0.2'],
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
  await mkdir(repository);
  const packageLock = {
    name: '@agoragentic/risk-fork',
    version: '0.1.0-alpha.0',
    lockfileVersion: 3,
    packages: Object.fromEntries([
      ['', { name: '@agoragentic/risk-fork', version: '0.1.0-alpha.0' }],
      ...DEPENDENCIES.map(([name, version]) => [`node_modules/${name}`, { version }]),
    ]),
  };
  const catalog = {
    schema: 'agoragentic.risk-fork.hackathon-fixture-catalog.v1',
    banner: OFFLINE_KIT_BANNER,
    synthetic_only: true,
    arbitrary_input_allowed: false,
    scenario_ids: SCENARIO_IDS,
  };
  await writeFixture(repository, 'risk-fork/package.json', `${JSON.stringify({
    name: '@agoragentic/risk-fork',
    version: '0.1.0-alpha.0',
    private: true,
    type: 'module',
  }, null, 2)}\n`);
  await writeFixture(repository, 'risk-fork/package-lock.json', `${JSON.stringify(packageLock, null, 2)}\n`);
  await writeFixture(repository, 'risk-fork/LICENSE', 'MIT License\n');
  await writeFixture(repository, 'risk-fork/src/index.mjs', 'export const fixture = true;\n');
  await writeFixture(repository, 'risk-fork/schema/receipt.v1.json', '{"type":"object"}\n');
  await writeFixture(repository, 'risk-fork/e2b-template/lib/runtime-contract.mjs', 'export const providerCalls = 0;\n');
  await writeFixture(repository, 'risk-fork/hackathon/package.json', `${JSON.stringify({
    name: '@agoragentic/risk-fork-hackathon-demo',
    version: '0.0.0-hackathon.1',
    private: true,
    type: 'module',
  }, null, 2)}\n`);
  await writeFixture(repository, 'risk-fork/hackathon/package-lock.json', `${JSON.stringify({
    name: '@agoragentic/risk-fork-hackathon-demo',
    version: '0.0.0-hackathon.1',
    lockfileVersion: 3,
    packages: { '': { private: true } },
  }, null, 2)}\n`);
  await writeFixture(repository, 'risk-fork/hackathon/README.md', `# Demo\n\n${OFFLINE_KIT_BANNER}\n`);
  await writeFixture(repository, 'risk-fork/hackathon/demo-status.json', `${JSON.stringify({
    banner: OFFLINE_KIT_BANNER,
    ...OFFLINE_KIT_TRUTH,
  }, null, 2)}\n`);
  await writeFixture(
    repository,
    'risk-fork/hackathon/src/scenarios.mjs',
    `export const SCENARIO_IDS = Object.freeze(${JSON.stringify(SCENARIO_IDS, null, 2)});\n`,
  );
  await writeFixture(repository, 'risk-fork/hackathon/src/connector.mjs', 'export const arbitraryInput = false;\n');
  await writeFixture(repository, 'risk-fork/hackathon/bin/risk-fork-demo.mjs', '#!/usr/bin/env node\n');
  await writeFixture(repository, 'risk-fork/hackathon/scripts/network-guard.mjs', 'globalThis.fetch = () => { throw new Error("blocked"); };\n');
  await writeFixture(repository, 'risk-fork/hackathon/docs/QUICKSTART.md', `${OFFLINE_KIT_BANNER}\n`);
  await writeFixture(repository, 'risk-fork/hackathon/recorder/index.html', '<!doctype html><title>REPLAY</title>\n');
  await writeFixture(repository, 'risk-fork/hackathon/fixtures/catalog.json', `${JSON.stringify(catalog, null, 2)}\n`);
  for (const [name, version] of DEPENDENCIES) {
    await writeFixture(
      repository,
      `risk-fork/node_modules/${name}/package.json`,
      `${JSON.stringify({ name, version, license: 'MIT', type: 'module' }, null, 2)}\n`,
    );
    await writeFixture(repository, `risk-fork/node_modules/${name}/index.js`, 'export default {};\n');
  }

  await execFileAsync('git', ['init', '--initial-branch=main'], { cwd: repository, windowsHide: true });
  await execFileAsync('git', ['config', 'user.email', 'offline-kit@example.invalid'], { cwd: repository, windowsHide: true });
  await execFileAsync('git', ['config', 'user.name', 'Offline Kit Test'], { cwd: repository, windowsHide: true });
  await execFileAsync('git', ['config', 'commit.gpgsign', 'false'], { cwd: repository, windowsHide: true });
  await execFileAsync('git', ['add', '--', 'risk-fork'], { cwd: repository, windowsHide: true });
  await execFileAsync('git', ['commit', '--no-gpg-sign', '-m', 'fixture'], { cwd: repository, windowsHide: true });
  const { stdout } = await execFileAsync('git', ['rev-parse', 'HEAD'], { cwd: repository, windowsHide: true });
  return { repository, sourceCommit: stdout.trim() };
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
  const { repository, sourceCommit } = await makeSourceRepository(temporary);
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
  assert.equal(first.zip_sha256, second.zip_sha256);
  assert.deepEqual(await readFile(first.zip_path), await readFile(second.zip_path));
  for (const [key, value] of Object.entries(OFFLINE_KIT_TRUTH)) assert.equal(first[key], value);

  const manifest = JSON.parse(await readFile(path.join(first.kit_directory, 'MANIFEST.json'), 'utf8'));
  assert.equal(manifest.banner, OFFLINE_KIT_BANNER);
  assert.equal(manifest.source_commit, sourceCommit);
  assert.equal(manifest.file_count, manifest.files.length);
  assert.deepEqual(
    manifest.files.map((entry) => entry.path),
    [...manifest.files.map((entry) => entry.path)].sort((left, right) => Buffer.compare(Buffer.from(left), Buffer.from(right))),
  );
  assert.ok(manifest.files.some((entry) => entry.path === 'risk-fork/hackathon/fixtures/catalog.json'));
  assert.ok(manifest.files.some((entry) => entry.path === 'risk-fork/node_modules/ajv/package.json'));
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
  assert.equal(resultByName['global.WebSocket'], 'RISK_FORK_DEMO_NETWORK_BLOCKED');
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
  assert.ok(status.guarded_surfaces.includes('globalThis.WebSocket'));
  assert.ok(status.guarded_surfaces.includes('undici.request'));
  assert.ok(status.guarded_surfaces.includes('undici.EventSource'));
});

test('network guard allows an explicit literal-loopback recorder smoke only when enabled', async () => {
  const source = `
    import http from 'node:http';
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
    await new Promise((resolve) => server.close(resolve));
    process.stdout.write(JSON.stringify({ value, fetchValue, redirectStatus: redirect.status }));
  `;
  const { stdout } = await runGuardProbe(source, { RISK_FORK_DEMO_ALLOW_LOOPBACK: '1' });
  assert.deepEqual(JSON.parse(stdout), {
    value: 'REPLAY',
    fetchValue: 'REPLAY',
    redirectStatus: 302,
  });

  const blocked = `
    import http from 'node:http';
    try { http.get({ host: '127.0.0.1', port: 9, path: '/' }); }
    catch (error) { process.stdout.write(error.code); }
  `;
  const result = await runGuardProbe(blocked);
  assert.equal(result.stdout, 'RISK_FORK_DEMO_NETWORK_BLOCKED');
});
