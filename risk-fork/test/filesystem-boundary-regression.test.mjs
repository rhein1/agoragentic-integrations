import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  symlink,
  unlink,
  writeFile,
} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { promisify } from 'node:util';

import {
  createImmutableWorkspaceExport,
  destroyImmutableWorkspaceExport,
} from '../src/adapters/e2b-workspace-export.mjs';
import { inspectRuntimeWorkspace } from '../e2b-template/lib/runtime-contract.mjs';
import { hashOpenedFileExact, readOpenedFileExact } from '../src/util.mjs';

const execFileAsync = promisify(execFile);
const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const exportModuleUrl = pathToFileURL(
  path.join(packageRoot, 'src/adapters/e2b-workspace-export.mjs'),
).href;
const runtimeModuleUrl = pathToFileURL(
  path.join(packageRoot, 'e2b-template/lib/runtime-contract.mjs'),
).href;

async function invokeFailureBounded(moduleUrl, exportName, input) {
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

async function removeWritable(root) {
  if (process.platform !== 'win32') {
    const visit = async (target) => {
      const info = await lstat(target).catch(() => null);
      if (!info) return;
      if (info.isDirectory() && !info.isSymbolicLink()) {
        await chmod(target, 0o700).catch(() => {});
        for (const name of await readdir(target)) await visit(path.join(target, name));
      } else {
        await chmod(target, 0o600).catch(() => {});
      }
    };
    await visit(root);
  }
  await rm(root, { recursive: true, force: true });
}

function simulatedGrowingDescriptor(content) {
  const reviewed = Buffer.from(content, 'utf8');
  let interrupted = false;
  return {
    expectedSize: BigInt(reviewed.byteLength),
    handle: {
      async read(buffer, offset, length, position) {
        if (!interrupted) {
          interrupted = true;
          const error = new Error('interrupted');
          error.code = 'EINTR';
          throw error;
        }
        if (position === reviewed.byteLength) {
          buffer[offset] = 0x21;
          return { bytesRead: 1, buffer };
        }
        const bytesRead = Math.min(3, length, reviewed.byteLength - position);
        reviewed.copy(buffer, offset, position, position + bytesRead);
        return { bytesRead, buffer };
      },
    },
  };
}

test('shared descriptor reader rejects simulated growth after partial and interrupted reads', async () => {
  const simulated = simulatedGrowingDescriptor('reviewed bytes');
  await assert.rejects(
    readOpenedFileExact(simulated.handle, {
      expectedSize: simulated.expectedSize,
      maxBytes: 1024,
      changedMessage: 'deterministic growth rejected',
    }),
    /deterministic growth rejected/,
  );
});

test('shared streaming descriptor hash rejects simulated growth after partial reads', async () => {
  const simulated = simulatedGrowingDescriptor('reviewed hash bytes');
  await assert.rejects(
    hashOpenedFileExact(simulated.handle, {
      expectedSize: simulated.expectedSize,
      changedMessage: 'deterministic hash growth rejected',
    }),
    /deterministic hash growth rejected/,
  );
});

test('workspace-export cleanup rejects manifest and payload FIFOs within a bounded subprocess', {
  skip: process.platform === 'win32' ? 'POSIX FIFO boundary' : false,
}, async (t) => {
  const temporary = await mkdtemp(path.join(os.tmpdir(), 'risk-fork-export-fifo-'));
  t.after(() => removeWritable(temporary));
  const source = path.join(temporary, 'source');
  const exportRoot = path.join(temporary, 'exports');
  const exportId = 'fifo-boundary';
  await mkdir(source);
  await writeFile(path.join(source, 'safe.txt'), 'bounded local fixture\n');
  const sourceSnapshot = await inspectRuntimeWorkspace(source);
  const exported = await createImmutableWorkspaceExport({
    source_workspace: source,
    export_root: exportRoot,
    export_id: exportId,
    expected_workspace_digest: sourceSnapshot.workspace_digest,
  });
  const manifestPath = path.join(exported.export_directory, 'manifest.json');
  const payloadDirectory = path.join(exported.export_directory, 'payload');
  const payloadPath = path.join(payloadDirectory, 'safe.txt');
  const manifestBytes = await readFile(manifestPath);
  const payloadBytes = await readFile(payloadPath);
  await chmod(exported.export_directory, 0o700);
  await chmod(payloadDirectory, 0o700);

  await unlink(manifestPath);
  await execFileAsync('mkfifo', [manifestPath]);
  assert.match(
    await invokeFailureBounded(exportModuleUrl, 'destroyImmutableWorkspaceExport', {
      export_root: exportRoot,
      export_id: exportId,
    }),
    /manifest is not a regular file/,
  );
  await unlink(manifestPath);
  await writeFile(manifestPath, manifestBytes, { mode: 0o400 });

  await unlink(payloadPath);
  await execFileAsync('mkfifo', [payloadPath]);
  assert.match(
    await invokeFailureBounded(exportModuleUrl, 'destroyImmutableWorkspaceExport', {
      export_root: exportRoot,
      export_id: exportId,
    }),
    /special filesystem entries/,
  );
  await unlink(payloadPath);
  await writeFile(payloadPath, payloadBytes, { mode: 0o400 });
  await chmod(payloadDirectory, 0o500);
  await chmod(exported.export_directory, 0o500);
  await destroyImmutableWorkspaceExport({ export_root: exportRoot, export_id: exportId });
});

test('runtime workspace rejects a FIFO within a bounded subprocess', {
  skip: process.platform === 'win32' ? 'POSIX FIFO boundary' : false,
}, async (t) => {
  const temporary = await mkdtemp(path.join(os.tmpdir(), 'risk-fork-runtime-fifo-'));
  t.after(() => rm(temporary, { recursive: true, force: true }));
  const workspace = path.join(temporary, 'workspace');
  await mkdir(workspace);
  await execFileAsync('mkfifo', [path.join(workspace, 'blocking.pipe')]);
  assert.match(
    await invokeFailureBounded(runtimeModuleUrl, 'inspectRuntimeWorkspace', workspace),
    /special file/,
  );
});

test('runtime workspace rejects linked directories without reading outside bytes', async (t) => {
  const temporary = await mkdtemp(path.join(os.tmpdir(), 'risk-fork-runtime-link-'));
  t.after(() => rm(temporary, { recursive: true, force: true }));
  const workspace = path.join(temporary, 'workspace');
  const outside = path.join(temporary, 'outside');
  await mkdir(workspace);
  await mkdir(outside);
  await writeFile(path.join(outside, 'sentinel.txt'), 'must remain outside\n');
  try {
    await symlink(outside, path.join(workspace, 'linked'), process.platform === 'win32' ? 'junction' : 'dir');
  } catch (error) {
    if (process.platform === 'win32' && ['EPERM', 'EACCES', 'UNKNOWN'].includes(error?.code)) {
      t.skip(`junction creation unavailable: ${error.code}`);
      return;
    }
    throw error;
  }
  await assert.rejects(inspectRuntimeWorkspace(workspace), /rejects a symlink/);
  assert.equal(await readFile(path.join(outside, 'sentinel.txt'), 'utf8'), 'must remain outside\n');
});
