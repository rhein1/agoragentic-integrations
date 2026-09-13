import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
const testRoot = path.dirname(fileURLToPath(import.meta.url));
const offlineKitModuleUrl = pathToFileURL(path.resolve(testRoot, '../src/offline-kit.mjs')).href;
const releaseArtifactsModuleUrl = pathToFileURL(
  path.resolve(testRoot, '../scripts/release-artifacts.mjs'),
).href;

async function invokeFailureBounded(exportName, input, moduleUrl = offlineKitModuleUrl) {
  const script = `
    import * as boundary from ${JSON.stringify(moduleUrl)};
    try {
      await boundary[${JSON.stringify(exportName)}](${JSON.stringify(input)});
      process.exitCode = 2;
    } catch (error) {
      process.stdout.write(String(error?.message ?? error));
    }
  `;
  const { stdout } = await execFileAsync(process.execPath, ['--input-type=module', '--eval', script], {
    timeout: 2_000,
    windowsHide: true,
  });
  return stdout;
}

test('offline-kit ZIP, manifest, and tree FIFO opens fail within a hard bound', {
  skip: process.platform === 'win32' ? 'POSIX FIFO boundary' : false,
}, async (t) => {
  const temporary = await mkdtemp(path.join(os.tmpdir(), 'risk-fork-offline-fifo-'));
  t.after(() => rm(temporary, { recursive: true, force: true }));

  const fifoZip = path.join(temporary, 'blocking.zip');
  await execFileAsync('mkfifo', [fifoZip]);
  assert.match(
    await invokeFailureBounded('verifyZipArchive', { zipPath: fifoZip }),
    /regular file/,
  );

  const fifoManifestKit = path.join(temporary, 'fifo-manifest');
  await mkdir(fifoManifestKit);
  await execFileAsync('mkfifo', [path.join(fifoManifestKit, 'MANIFEST.json')]);
  assert.match(
    await invokeFailureBounded('verifyOfflineKit', { kitDirectory: fifoManifestKit }),
    /regular file/,
  );

  const fifoTree = path.join(temporary, 'fifo-tree');
  await mkdir(fifoTree);
  await execFileAsync('mkfifo', [path.join(fifoTree, 'blocking.pipe')]);
  assert.match(
    await invokeFailureBounded('createDeterministicZip', {
      sourceDirectory: fifoTree,
      outputPath: path.join(temporary, 'must-not-exist.zip'),
    }),
    /regular file/,
  );
});

test('release build manifest FIFO is rejected within a hard bound', {
  skip: process.platform === 'win32' ? 'POSIX FIFO boundary' : false,
}, async (t) => {
  const temporary = await mkdtemp(path.join(os.tmpdir(), 'risk-fork-release-fifo-'));
  t.after(() => rm(temporary, { recursive: true, force: true }));
  await execFileAsync('mkfifo', [path.join(temporary, 'blocking.build.json')]);
  assert.match(
    await invokeFailureBounded(
      'verifyReleaseArtifactSet',
      { artifactDirectory: temporary },
      releaseArtifactsModuleUrl,
    ),
    /bounded regular file/,
  );
});
