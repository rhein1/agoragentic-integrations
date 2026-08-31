import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { cp, mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import test from 'node:test';

import { buildOfflineKit, extractAndVerifyOfflineKit } from '../src/offline-kit.mjs';

const execFileAsync = promisify(execFile);
const testRoot = path.dirname(fileURLToPath(import.meta.url));
const repositoryRoot = path.resolve(testRoot, '..', '..', '..');
const REQUIRED_TREES = Object.freeze([
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
const REQUIRED_FILES = Object.freeze([
  'risk-fork/package.json',
  'risk-fork/package-lock.json',
  'risk-fork/LICENSE',
  'risk-fork/hackathon/package.json',
  'risk-fork/hackathon/package-lock.json',
  'risk-fork/hackathon/README.md',
  'risk-fork/hackathon/demo-status.json',
]);
function minimalEnvironment(extra = {}) {
  return {
    SystemRoot: process.env.SystemRoot,
    WINDIR: process.env.WINDIR,
    TEMP: process.env.TEMP,
    TMP: process.env.TMP,
    ...extra,
  };
}

async function createCommittedRuntimeSource(temporary) {
  const repository = path.join(temporary, 'source');
  await mkdir(repository);
  for (const relative of REQUIRED_TREES) {
    await cp(path.join(repositoryRoot, relative), path.join(repository, relative), {
      recursive: true,
      errorOnExist: true,
      force: false,
    });
  }
  for (const relative of REQUIRED_FILES) {
    const destination = path.join(repository, relative);
    await mkdir(path.dirname(destination), { recursive: true });
    await cp(path.join(repositoryRoot, relative), destination, {
      errorOnExist: true,
      force: false,
    });
  }
  await execFileAsync('git', ['init', '--initial-branch=main'], { cwd: repository, windowsHide: true });
  await execFileAsync('git', ['config', 'user.email', 'offline-runtime@example.invalid'], {
    cwd: repository,
    windowsHide: true,
  });
  await execFileAsync('git', ['config', 'user.name', 'Offline Runtime Test'], {
    cwd: repository,
    windowsHide: true,
  });
  await execFileAsync('git', ['config', 'commit.gpgsign', 'false'], { cwd: repository, windowsHide: true });
  await execFileAsync('git', ['add', '--', 'risk-fork'], { cwd: repository, windowsHide: true });
  await execFileAsync('git', ['commit', '--no-gpg-sign', '-m', 'fresh extraction fixture'], {
    cwd: repository,
    windowsHide: true,
  });
  const { stdout } = await execFileAsync('git', ['rev-parse', 'HEAD'], {
    cwd: repository,
    windowsHide: true,
  });
  return { repository, sourceCommit: stdout.trim() };
}

test('fresh deterministic kit extraction verifies offline with only command-scoped loopback', async (t) => {
  const temporary = await mkdtemp(path.join(os.tmpdir(), 'risk-fork-fresh-cli-'));
  t.after(() => rm(temporary, { recursive: true, force: true }));
  const { repository, sourceCommit } = await createCommittedRuntimeSource(temporary);
  const build = await buildOfflineKit({
    repositoryRoot: repository,
    sourceCommit,
    outputBase: path.join(temporary, 'artifacts'),
    validationSummary: {
      status: 'test_only_fresh_extraction',
      provider_calls: 0,
      network_used: false,
    },
  });
  const extractionRoot = path.join(temporary, 'fresh-extraction');
  const extraction = await extractAndVerifyOfflineKit({
    zipPath: build.zip_path,
    destination: extractionRoot,
  });
  assert.equal(extraction.verification.verified, true);

  const entrypoint = path.join(
    extractionRoot,
    'risk-fork',
    'hackathon',
    'bin',
    'risk-fork-demo.mjs',
  );
  const { stdout, stderr } = await execFileAsync(process.execPath, [entrypoint, 'verify-offline-kit'], {
    cwd: extractionRoot,
    env: minimalEnvironment({ RISK_FORK_DEMO_ALLOW_LOOPBACK: '0' }),
    windowsHide: true,
    timeout: 30_000,
    maxBuffer: 4 * 1024 * 1024,
  });
  assert.equal(stderr, '');
  const result = JSON.parse(stdout);
  assert.equal(result.verified, true);
  assert.equal(result.runtime.verified, true);
  assert.equal(result.runtime.recorder.loopback_transport_used, true);
  assert.equal(result.runtime.recorder.external_network_used, false);
  assert.equal(result.provider_calls, 0);
  assert.equal(result.network_used, false);
  assert.equal(result.runtime.provider_calls, 0);
  assert.equal(result.runtime.network_used, false);
  assert.equal(result.source_commit, sourceCommit);

  const manifest = JSON.parse(await readFile(path.join(extractionRoot, 'MANIFEST.json'), 'utf8'));
  assert.equal(manifest.source_commit, sourceCommit);
  assert.equal(manifest.provider_calls, 0);
  assert.equal(manifest.network_used, false);
});
