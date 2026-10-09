import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import childProcess from 'node:child_process';
import fs from 'node:fs';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import {
  PRIME_AGENT_RELEASE,
  validatePrimeAgentPackageMetadata,
  verifyPrimeAgentReleaseArtifact,
} from '../release-verifier.mjs';

function exactMetadata(overrides = {}) {
  return {
    name: 'prime-agent',
    version: '0.7.2',
    type: 'module',
    piConfig: { name: 'prime-agent', configDir: '.prime/agent' },
    bin: { 'prime-agent': 'dist/bundle/cli.js' },
    main: './dist/index.js',
    exports: {
      '.': { import: './dist/index.js' },
      './hooks': { import: './dist/core/hooks/index.js' },
    },
    engines: { node: '>=22.8.0' },
    dependencies: {
      '@earendil-works/pi-agent-core': 'https://pub-728493de92a943e2a9b2d17b4719f318.r2.dev/releases/v0.7.2/prime-agent-core-0.7.2.tgz',
      '@earendil-works/pi-ai': 'https://pub-728493de92a943e2a9b2d17b4719f318.r2.dev/releases/v0.7.2/prime-agent-ai-0.7.2.tgz',
      '@earendil-works/pi-tui': 'https://pub-728493de92a943e2a9b2d17b4719f318.r2.dev/releases/v0.7.2/prime-agent-tui-0.7.2.tgz',
    },
    ...overrides,
  };
}

test('release contract pins immutable public bytes', () => {
  assert.deepEqual(PRIME_AGENT_RELEASE, {
    repository: 'PrimeIntellect-ai/prime-agent',
    tag: 'v0.7.2',
    version: '0.7.2',
    commit: '83a0f9f9566219551fcb6ffaf7f519a815749a58',
    asset_name: 'prime-agent-0.7.2.tgz',
    asset_url: 'https://github.com/PrimeIntellect-ai/prime-agent/releases/download/v0.7.2/prime-agent-0.7.2.tgz',
    asset_size_bytes: 9387295,
    asset_sha256: 'bc5471f2a626d727b88a45eb745fff93b10c554a3c4fc5912f25d8c64b987f5e',
  });
});

test('exact released package metadata passes and host/extension identity stays distinct', () => {
  assert.deepEqual(validatePrimeAgentPackageMetadata(exactMetadata()), { valid: true, blockers: [] });
  const stale = validatePrimeAgentPackageMetadata(exactMetadata({ version: '0.7.1' }));
  assert.equal(stale.valid, false);
  assert.ok(stale.blockers.includes('package_version_mismatch'));
  const fakeExtensionManifest = validatePrimeAgentPackageMetadata(exactMetadata({ pi: { extensions: ['./index.mjs'] } }));
  assert.equal(fakeExtensionManifest.valid, false);
  assert.ok(fakeExtensionManifest.blockers.includes('host_package_must_not_claim_extension_manifest'));
});

test('tampered or wrong-sized release artifacts fail before extraction', () => {
  const root = mkdtempSync(join(tmpdir(), 'agoragentic-prime-release-test-'));
  try {
    const artifact = join(root, PRIME_AGENT_RELEASE.asset_name);
    writeFileSync(artifact, 'not the pinned Prime Agent release', 'utf8');
    const result = verifyPrimeAgentReleaseArtifact(artifact);
    assert.equal(result.valid, false);
    assert.ok(result.blockers.includes('release_artifact_size_mismatch'));
    assert.ok(result.blockers.includes('release_artifact_sha256_mismatch'));
    assert.equal(result.immutable_release_pin_verified, false);
    assert.equal(result.exact_host_artifact_loaded, false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('artifact replacement after open cannot change the verified snapshot, and its descriptor closes', (t) => {
  const root = mkdtempSync(join(tmpdir(), 'agoragentic-prime-release-race-test-'));
  const artifact = join(root, PRIME_AGENT_RELEASE.asset_name);
  const original = Buffer.from('original opened bytes');
  writeFileSync(artifact, original);
  const originalRead = fs.readFileSync;
  const originalClose = fs.closeSync;
  let openedFd = null;
  let closed = false;
  t.mock.method(fs, 'readFileSync', (fd, ...args) => {
    assert.equal(typeof fd, 'number', 'a checked pathname must never be reopened');
    openedFd = fd;
    fs.renameSync(artifact, join(root, 'original.tgz'));
    writeFileSync(artifact, 'replacement pathname bytes');
    return originalRead(fd, ...args);
  });
  t.mock.method(fs, 'closeSync', (fd) => {
    assert.equal(fd, openedFd);
    closed = true;
    return originalClose(fd);
  });
  syncBuiltinESMExports();
  try {
    const result = verifyPrimeAgentReleaseArtifact(artifact);
    assert.equal(result.valid, false);
    assert.equal(result.observed.asset_size_bytes, original.length);
    assert.equal(result.observed.asset_sha256, createHash('sha256').update(original).digest('hex'));
    assert.equal(closed, true);
    assert.throws(() => fs.fstatSync(openedFd), { code: 'EBADF' });
  } finally {
    t.mock.restoreAll();
    syncBuiltinESMExports();
    rmSync(root, { recursive: true, force: true });
  }
});

test('non-regular release input fails closed before hashing or extraction', () => {
  const root = mkdtempSync(join(tmpdir(), 'agoragentic-prime-release-directory-test-'));
  try {
    const result = verifyPrimeAgentReleaseArtifact(root);
    assert.equal(result.valid, false);
    assert.equal(result.observed.asset_sha256, null);
    assert.ok(result.blockers.some((item) => ['release_artifact_not_regular_file', 'release_artifact_unreadable'].includes(item)));
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('no-follow release open rejects a symbolic link', { skip: !fs.constants.O_NOFOLLOW }, () => {
  const root = mkdtempSync(join(tmpdir(), 'agoragentic-prime-release-symlink-test-'));
  try {
    const target = join(root, 'target.tgz');
    const link = join(root, PRIME_AGENT_RELEASE.asset_name);
    writeFileSync(target, 'not the pinned release');
    fs.symlinkSync(target, link);
    const result = verifyPrimeAgentReleaseArtifact(link);
    assert.equal(result.valid, false);
    assert.equal(result.observed.asset_sha256, null);
    assert.ok(result.blockers.includes('release_artifact_unreadable'));
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('tar consumes the verified byte snapshot and failed extraction removes its private directory', {
  skip: !process.env.PRIME_AGENT_V072_TGZ,
}, (t) => {
  const root = mkdtempSync(join(tmpdir(), 'agoragentic-prime-release-extraction-test-'));
  const artifact = join(root, PRIME_AGENT_RELEASE.asset_name);
  fs.copyFileSync(process.env.PRIME_AGENT_V072_TGZ, artifact);
  const originalRead = fs.readFileSync;
  let extractionRoot = null;
  let tarCalls = 0;
  t.mock.method(fs, 'readFileSync', (fd, ...args) => {
    assert.equal(typeof fd, 'number');
    const captured = originalRead(fd, ...args);
    fs.renameSync(artifact, join(root, 'captured.tgz'));
    writeFileSync(artifact, 'unverified replacement archive');
    return captured;
  });
  t.mock.method(childProcess, 'execFileSync', (command, args, options) => {
    tarCalls += 1;
    assert.equal(command, 'tar');
    assert.deepEqual(args.slice(0, 3), ['-xzf', '-', '-C']);
    assert.equal(createHash('sha256').update(options.input).digest('hex'), PRIME_AGENT_RELEASE.asset_sha256);
    assert.equal(options.input.length, PRIME_AGENT_RELEASE.asset_size_bytes);
    extractionRoot = args[3];
    writeFileSync(join(extractionRoot, 'partial-extraction'), 'fixture');
    throw Object.assign(new Error('injected tar failure'), { code: 'FIXTURE_TAR_FAILED' });
  });
  syncBuiltinESMExports();
  try {
    const result = verifyPrimeAgentReleaseArtifact(artifact);
    assert.equal(tarCalls, 1);
    assert.equal(result.valid, false);
    assert.ok(result.blockers.includes('release_archive_invalid:FIXTURE_TAR_FAILED'));
    assert.equal(fs.existsSync(extractionRoot), false);
  } finally {
    t.mock.restoreAll(); syncBuiltinESMExports();
    rmSync(root, { recursive: true, force: true });
  }
});

test('missing extracted metadata retains the package-path blocker and cleans the directory', {
  skip: !process.env.PRIME_AGENT_V072_TGZ,
}, (t) => {
  let extractionRoot = null;
  t.mock.method(childProcess, 'execFileSync', (_command, args) => {
    extractionRoot = args[3];
    fs.mkdirSync(join(extractionRoot, 'package'));
  });
  syncBuiltinESMExports();
  try {
    const result = verifyPrimeAgentReleaseArtifact(process.env.PRIME_AGENT_V072_TGZ);
    assert.equal(result.valid, false);
    assert.deepEqual(result.blockers, ['release_package_path_invalid']);
    assert.equal(fs.existsSync(extractionRoot), false);
  } finally { t.mock.restoreAll(); syncBuiltinESMExports(); }
});

test('real released v0.7.2 artifact verifies exact bytes, metadata, and required files', {
  skip: !process.env.PRIME_AGENT_V072_TGZ,
}, () => {
  const result = verifyPrimeAgentReleaseArtifact(process.env.PRIME_AGENT_V072_TGZ);
  assert.equal(result.valid, true, result.blockers.join(', '));
  assert.equal(result.observed.asset_size_bytes, PRIME_AGENT_RELEASE.asset_size_bytes);
  assert.equal(result.observed.asset_sha256, PRIME_AGENT_RELEASE.asset_sha256);
  assert.equal(result.observed.package_name, 'prime-agent');
  assert.equal(result.observed.package_version, '0.7.2');
  assert.equal(result.observed.package_files_verified, true);
  assert.ok(result.observed.first_party_file_count > 1000);
  assert.match(result.observed.first_party_tree_digest, /^sha256:[0-9a-f]{64}$/);
  assert.equal(result.observed.hooks_export_target_present, false);
  assert.ok(result.warnings.includes('published_hooks_export_target_missing'));
  assert.equal(result.runtime_verified, false);
  assert.equal(result.authority_granted, false);
});
