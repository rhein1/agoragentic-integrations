import { spawn } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import {
  constants as fsConstants,
} from 'node:fs';
import {
  access,
  chmod,
  copyFile,
  lstat,
  mkdir,
  mkdtemp,
  open,
  readFile,
  readdir,
  realpath,
  rm,
  rmdir,
  unlink,
  writeFile,
} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { TextDecoder } from 'node:util';

import { canonicalize, sha256Ref } from '../canonical.mjs';
import { validateLocalReferenceOperation } from '../child-operation.mjs';
import {
  assertFreshForkIdentity,
  networkPolicy,
  verifySavepointCapsule,
} from '../contracts.mjs';
import {
  RiskForkProvider,
  createCleanupVerificationEvidence,
  createCleanupVerificationRequest,
  verifyCleanupVerificationRequest,
} from '../provider.mjs';
import {
  assertAllowedKeys,
  assertPlainObject,
  boundedInteger,
  cloneJson,
  deepFreeze,
  normalizeRelativePath,
  requireEnum,
  requireOpaqueRef,
  requireSha256Ref,
  requireString,
  safeEqual,
} from '../util.mjs';

const runnerPath = fileURLToPath(new URL('./local-runner.mjs', import.meta.url));
const utf8Decoder = new TextDecoder('utf-8', { fatal: true });
const MAX_LOCAL_RUNNER_STDOUT_BYTES = 2 * 1024 * 1024;
const LOCAL_SNAPSHOT_READ_CHUNK_BYTES = 64 * 1024;
const MAX_LOCAL_DIFF_CONTENT_BYTES = 16 * 1024 * 1024;
const CAPTURE_DIRECTORY_PREFIX = 'agoragentic-risk-fork-capture-';
const CAPTURE_MARKER_NAME = '.agoragentic-risk-fork-capture-v2';
const CAPTURE_MARKER_SCHEMA = 'agoragentic.risk-fork.capture-directory.v2';
const LEGACY_CAPTURE_MARKER_NAME = '.agoragentic-risk-fork-capture-v1';
const LEGACY_CAPTURE_MARKER_SCHEMA = 'agoragentic.risk-fork.capture-directory.v1';
const CAPTURE_ORPHAN_MIN_AGE_MS = 60 * 60 * 1000;
const LEGACY_CAPTURE_ORPHAN_MIN_AGE_MS = 24 * 60 * 60 * 1000;
const CAPTURE_FILE_NAME = /^\d+-[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\.bin$/u;
const PRIVATE_STATE_DIRECTORY_NAME = 'agoragentic-risk-fork';
const CAPTURE_SPOOL_DIRECTORY_NAME = 'capture-spools';
const ADAPTER_MARKER_NAME = '.adapter-owner-v1';
const ADAPTER_MARKER_SCHEMA = 'agoragentic.risk-fork.adapter-owner.v1';
// Open the path before inspecting its metadata.  On POSIX, O_NOFOLLOW and
// O_NONBLOCK prevent a replacement symlink/FIFO from being followed or
// blocking the capture.  Windows does not expose those flags; the descriptor
// is still checked against a post-open lstat before any bytes are read.
function localReadOnlyFlags() {
  if (process.platform === 'win32') return fsConstants.O_RDONLY;
  return fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW | fsConstants.O_NONBLOCK;
}
// Constructor injection is a trusted test seam, never a production provider boundary.
const testOperationRunners = new WeakMap();
const capturedContentByRecord = new WeakMap();

function isCurrentOwner(info) {
  return process.platform === 'win32'
    || (typeof process.getuid === 'function'
      && typeof info?.uid === 'bigint'
      && info.uid === BigInt(process.getuid()));
}

function isLiveProcess(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error?.code !== 'ESRCH';
  }
}

async function readProcessInstanceIdentity(pid) {
  if (process.platform === 'linux') {
    try {
      const [bootId, processStat] = await Promise.all([
        readFile('/proc/sys/kernel/random/boot_id', 'utf8'),
        readFile(`/proc/${pid}/stat`, 'utf8'),
      ]);
      const statFields = processStat.slice(processStat.lastIndexOf(')') + 2).trim().split(/\s+/u);
      const startTime = statFields[19];
      if (!startTime) return null;
      return {
        boot_id: bootId.trim(),
        start_time: startTime,
      };
    } catch {
      return null;
    }
  }
  if (process.platform === 'darwin') {
    return new Promise((resolve) => {
      const child = spawn('/bin/ps', ['-o', 'lstart=', '-p', String(pid)], {
        stdio: ['ignore', 'pipe', 'ignore'],
      });
      let output = '';
      child.stdout.setEncoding('utf8');
      child.stdout.on('data', (chunk) => {
        output += chunk;
        if (output.length > 256) child.kill();
      });
      child.once('error', () => resolve(null));
      child.once('close', (code) => {
        const startTime = output.trim();
        resolve(code === 0 && startTime.length > 0 && startTime.length <= 256
          ? { start_time: startTime }
          : null);
      });
    });
  }
  return null;
}

function sameProcessInstance(expected, actual) {
  if (!expected || !actual || typeof expected.start_time !== 'string'
    || typeof actual.start_time !== 'string') return false;
  return expected.start_time === actual.start_time
    && (process.platform !== 'linux' || expected.boot_id === actual.boot_id);
}

async function createCaptureMarkerContent() {
  return JSON.stringify({
    schema: CAPTURE_MARKER_SCHEMA,
    token: randomUUID(),
    pid: process.pid,
    process_instance: await readProcessInstanceIdentity(process.pid),
  });
}

async function createAdapterMarkerContent() {
  return JSON.stringify({
    schema: ADAPTER_MARKER_SCHEMA,
    token: randomUUID(),
    pid: process.pid,
    process_instance: await readProcessInstanceIdentity(process.pid),
  });
}

function defaultStateRoot() {
  const configured = process.platform === 'win32'
    ? process.env.LOCALAPPDATA
    : process.env.XDG_STATE_HOME;
  if (configured && !path.isAbsolute(configured)) {
    throw new Error('Risk Fork state root must be an absolute path');
  }
  return path.resolve(configured || path.join(os.homedir(), '.local', 'state'));
}

async function ensureDefaultStateRoot() {
  const configured = process.platform === 'win32'
    ? process.env.LOCALAPPDATA
    : process.env.XDG_STATE_HOME;
  if (process.platform === 'win32' || configured) {
    return ensurePrivateDirectory(defaultStateRoot(), { create: false });
  }
  const localRoot = path.dirname(defaultStateRoot());
  await ensurePrivateDirectory(localRoot, { requirePrivateMode: false });
  return ensurePrivateDirectory(defaultStateRoot());
}

async function ensurePrivateDirectory(directory, { create = true, requirePrivateMode = true } = {}) {
  const resolved = path.resolve(directory);
  let ancestor = path.dirname(resolved);
  while (ancestor && ancestor !== path.dirname(ancestor)) {
    try {
      const ancestorInfo = await lstat(ancestor, { bigint: true });
      if (!ancestorInfo.isDirectory() || ancestorInfo.isSymbolicLink()) {
        throw new Error(`Risk Fork private directory ancestor is not trusted: ${ancestor}`);
      }
      const ancestorMode = Number(ancestorInfo.mode & 0o1777n);
      const rootOwnedStickyAncestor = process.platform !== 'win32'
        && typeof ancestorInfo.uid === 'bigint'
        && ancestorInfo.uid === 0n
        && (ancestorMode & 0o1000) !== 0;
      const ancestorOwnedByProcess = typeof process.getuid === 'function'
        && typeof ancestorInfo.uid === 'bigint'
        && ancestorInfo.uid === BigInt(process.getuid());
      const ancestorRootOwned = typeof ancestorInfo.uid === 'bigint'
        && ancestorInfo.uid === 0n;
      const ancestorWritableByOtherUsers = (ancestorMode & 0o022) !== 0;
      const ancestorOwnerSafe = ancestorOwnedByProcess || ancestorRootOwned;
      const ancestorModeSafe = !ancestorWritableByOtherUsers || rootOwnedStickyAncestor;
      if (process.platform !== 'win32'
        && (typeof process.getuid !== 'function'
          || typeof ancestorInfo.uid !== 'bigint'
          || !ancestorOwnerSafe
          || !ancestorModeSafe)) {
        throw new Error(`Risk Fork private directory ancestor is unsafe: ${ancestor}`);
      }
      const parent = path.dirname(ancestor);
      if (parent === ancestor) break;
      ancestor = parent;
    } catch (error) {
      if (error?.code === 'ENOENT') {
        throw new Error(`Risk Fork private directory ancestor must already exist: ${ancestor}`);
      }
      throw error;
    }
  }
  if (create) {
    try {
      await mkdir(resolved, { recursive: false, mode: 0o700 });
    } catch (error) {
      if (error?.code !== 'EEXIST') throw error;
    }
    if (process.platform !== 'win32' && await realpath(resolved) !== resolved) {
      throw new Error(`Risk Fork private directory resolved through an unexpected path: ${resolved}`);
    }
  }
  const info = await lstat(resolved, { bigint: true });
  if (!info.isDirectory() || info.isSymbolicLink()) {
    throw new Error(`Risk Fork private directory is not a real directory: ${resolved}`);
  }
  if (process.platform !== 'win32') {
    if (typeof process.getuid !== 'function'
      || typeof info.uid !== 'bigint'
      || info.uid !== BigInt(process.getuid())
      || (requirePrivateMode && Number(info.mode & 0o777n) !== 0o700)) {
      throw new Error(`Risk Fork private directory ownership or mode is unsafe: ${resolved}`);
    }
  }
  if (create) await ensurePrivateDirectory(resolved, { create: false, requirePrivateMode });
  return resolved;
}

async function createDefaultAdapterDirectory() {
  if (process.platform === 'win32') {
    const error = new Error(
      'Risk Fork local reference storage is unavailable on Windows until exact private ACL and reparse-point validation is implemented',
    );
    error.code = 'LOCAL_REFERENCE_WINDOWS_ACL_UNVERIFIED';
    throw error;
  }
  const parent = await ensurePrivateDirectory(
    path.join(await ensureDefaultStateRoot(), PRIVATE_STATE_DIRECTORY_NAME),
  );
  const adapter = await mkdtemp(path.join(parent, 'adapter-'));
  return ensurePrivateDirectory(adapter, { create: false });
}

let standaloneCaptureRootPromise = null;
async function standaloneCaptureRoot() {
  if (!standaloneCaptureRootPromise) {
    standaloneCaptureRootPromise = (async () => {
      const stateRoot = await ensureDefaultStateRoot();
      const privateRoot = await ensurePrivateDirectory(
        path.join(stateRoot, PRIVATE_STATE_DIRECTORY_NAME),
      );
      const standaloneRoot = await ensurePrivateDirectory(path.join(privateRoot, 'standalone'));
      return ensurePrivateDirectory(path.join(standaloneRoot, CAPTURE_SPOOL_DIRECTORY_NAME));
    })().catch((error) => {
      standaloneCaptureRootPromise = null;
      throw error;
    });
  }
  return standaloneCaptureRootPromise;
}

async function scavengeOrphanCaptureDirectories(captureRoot) {
  if (process.platform === 'win32') return 0;
  const root = await ensurePrivateDirectory(captureRoot, { create: false });
  let entries;
  try {
    entries = await readdir(root, { withFileTypes: true });
  } catch {
    return 0;
  }
  let removed = 0;
  for (const entry of entries) {
    const directory = path.join(root, entry.name);
    try {
      let topLevelDirectory = entry.isDirectory();
      if (!entry.isDirectory() && !entry.isFile() && !entry.isSymbolicLink()) {
        topLevelDirectory = (await lstat(directory, { bigint: true })).isDirectory();
      }
      if (!topLevelDirectory || !entry.name.startsWith(CAPTURE_DIRECTORY_PREFIX)) continue;
      const directoryInfo = await lstat(directory, { bigint: true });
      if (!directoryInfo.isDirectory()
        || !isCurrentOwner(directoryInfo)
        || Number(directoryInfo.mode & 0o777n) !== 0o700) continue;
      // Keep the marker read attached to the object we inspected.  The
      // no-follow/nonblocking open rejects replacement links and special files;
      // the descriptor and path identity checks reject replacement without ever
      // reading attacker-controlled bytes. Windows is explicitly gated above:
      // its open flags do not provide the POSIX no-follow/nonblocking boundary.
      let markerName = CAPTURE_MARKER_NAME;
      let legacyMarker = false;
      let markerPath = path.join(directory, markerName);
      let markerHandle;
      try {
        markerHandle = await open(markerPath, localReadOnlyFlags());
      } catch (error) {
        if (error?.code !== 'ENOENT') throw error;
        markerName = LEGACY_CAPTURE_MARKER_NAME;
        legacyMarker = true;
        markerPath = path.join(directory, markerName);
        markerHandle = await open(markerPath, localReadOnlyFlags());
      }
      let markerContent;
      try {
        const markerBefore = await markerHandle.stat({ bigint: true });
        if (!markerBefore.isFile()
          || !isCurrentOwner(markerBefore)
          || Number(markerBefore.mode & 0o777n) !== 0o600
          || Date.now() - Number(markerBefore.mtimeMs)
            < (legacyMarker ? LEGACY_CAPTURE_ORPHAN_MIN_AGE_MS : CAPTURE_ORPHAN_MIN_AGE_MS)) continue;
        const markerPathInfo = await lstat(markerPath, { bigint: true });
        if (!markerPathInfo.isFile()
          || !isCurrentOwner(markerPathInfo)
          || Number(markerPathInfo.mode & 0o777n) !== 0o600) continue;
        assertSamePathIdentity(markerPathInfo, markerBefore, markerName);
        if (markerPathInfo.mtimeNs !== markerBefore.mtimeNs) continue;
        markerContent = await markerHandle.readFile('utf8');
      } finally {
        await markerHandle.close();
      }
      const marker = JSON.parse(markerContent);
      if (marker?.schema !== (legacyMarker ? LEGACY_CAPTURE_MARKER_SCHEMA : CAPTURE_MARKER_SCHEMA)
        || typeof marker.token !== 'string'
        || !/^[0-9a-f-]{36}$/u.test(marker.token)
        || typeof marker.pid !== 'number'
        || !Number.isSafeInteger(marker.pid)
        || marker.pid < 1) continue;
      const liveProcess = isLiveProcess(marker.pid);
      const processInstance = await readProcessInstanceIdentity(marker.pid);
      if (legacyMarker) {
        // v1 has no process-instance binding. Reclaim only after a strict
        // legacy age window, a dead PID, and no currently readable instance.
        if (liveProcess || processInstance) continue;
      } else {
        if (!marker.process_instance
          || typeof marker.process_instance.start_time !== 'string'
          || (process.platform === 'linux' && typeof marker.process_instance.boot_id !== 'string')) continue;
        if (processInstance && sameProcessInstance(marker.process_instance, processInstance)) {
          // The recorded owner is still this exact process instance.
          continue;
        }
        if (liveProcess && !processInstance) {
          // A live PID whose identity cannot be read is ambiguous; fail closed.
          continue;
        }
      }
      const children = await readdir(directory, { withFileTypes: true });
      const files = [];
      let safe = true;
      for (const child of children) {
        if (child.name === CAPTURE_MARKER_NAME || child.name === LEGACY_CAPTURE_MARKER_NAME) continue;
        const childPath = path.join(directory, child.name);
        let childIsFile = child.isFile();
        if (!child.isDirectory() && !child.isFile() && !child.isSymbolicLink()) {
          childIsFile = (await lstat(childPath, { bigint: true })).isFile();
        }
        if (!childIsFile || !CAPTURE_FILE_NAME.test(child.name)) {
          safe = false;
          break;
        }
        const childInfo = await lstat(childPath, { bigint: true });
        if (!childInfo.isFile()
          || !isCurrentOwner(childInfo)
          || childInfo.nlink > 1n
          || Number(childInfo.mode & 0o777n) !== 0o600) {
          safe = false;
          break;
        }
        files.push(childPath);
      }
      if (!safe) continue;
      if (legacyMarker) {
        if (isLiveProcess(marker.pid) || await readProcessInstanceIdentity(marker.pid)) continue;
      } else {
        const currentProcessInstance = await readProcessInstanceIdentity(marker.pid);
        if ((currentProcessInstance && sameProcessInstance(marker.process_instance, currentProcessInstance))
          || (!currentProcessInstance && isLiveProcess(marker.pid))) continue;
      }
      for (const file of files) await unlink(file);
      await unlink(markerPath);
      await rmdir(directory);
      removed += 1;
    } catch (error) {
      if (!['ENOENT', 'ENOTEMPTY', 'EPERM', 'EACCES', 'EBUSY'].includes(error?.code)) continue;
    }
  }
  return removed;
}

const captureScavengerPromises = new Map();
async function ensureCaptureScavenged(captureRoot) {
  const root = path.resolve(captureRoot);
  let promise = captureScavengerPromises.get(root);
  if (!promise) {
    promise = scavengeOrphanCaptureDirectories(root).catch(() => 0);
    captureScavengerPromises.set(root, promise);
    try {
      await promise;
    } finally {
      if (captureScavengerPromises.get(root) === promise) captureScavengerPromises.delete(root);
    }
    return;
  }
  await promise;
}

// Internal deterministic cleanup-test seam. It is not used by production callers.
export async function __testScavengeCaptureDirectories(captureRoot = null) {
  const root = captureRoot ? path.resolve(requireString(captureRoot, 'captureRoot'))
    : await standaloneCaptureRoot();
  captureScavengerPromises.delete(root);
  return scavengeOrphanCaptureDirectories(root);
}

async function releaseCapturedContent(records) {
  const directories = new Set();
  if (typeof records?.capture_directory === 'string') {
    directories.add(records.capture_directory);
  }
  for (const record of records) {
    const capturePath = capturedContentByRecord.get(record);
    if (typeof capturePath === 'string') {
      directories.add(path.dirname(capturePath));
      try { await unlink(capturePath); } catch (error) { if (error?.code !== 'ENOENT') throw error; }
    }
    capturedContentByRecord.delete(record);
  }
  for (const directory of directories) {
    const markerPath = path.join(directory, CAPTURE_MARKER_NAME);
    const markerContent = Buffer.from(await createCaptureMarkerContent());
    let markerRemoved = false;
    try {
      await unlink(markerPath);
      markerRemoved = true;
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error;
    }
    try {
      await rmdir(directory);
    } catch (error) {
      if (markerRemoved && error?.code !== 'ENOENT') {
        let markerHandle;
        try {
          // O_EXCL makes restoration create-only.  Write through the returned
          // descriptor so a path replacement cannot redirect the marker bytes.
          markerHandle = await open(markerPath, 'wx', 0o600);
          const markerInfo = await markerHandle.stat({ bigint: true });
          if (!markerInfo.isFile()
            || !isCurrentOwner(markerInfo)
            || Number(markerInfo.mode & 0o777n) !== 0o600) continue;
          let written = 0;
          while (written < markerContent.byteLength) {
            const result = await markerHandle.write(
              markerContent,
              written,
              markerContent.byteLength - written,
            );
            if (!result?.bytesWritten) break;
            written += result.bytesWritten;
          }
        } catch {
          // Cleanup is best-effort; an existing or ambiguous marker is left
          // untouched for the next scavenger pass.
        } finally {
          await markerHandle?.close().catch(() => {});
        }
      }
      if (!['ENOENT', 'ENOTEMPTY', 'EPERM'].includes(error?.code)) throw error;
    }
  }
}

function hasStableFileIdentity(info) {
  // Windows file serial numbers can exceed Number.MAX_SAFE_INTEGER; use the
  // bigint Stats form below so identity comparisons do not lose precision.
  return typeof info?.dev === 'bigint'
    && info.dev > 0n
    && typeof info?.ino === 'bigint'
    && info.ino > 0n;
}

function assertSamePathIdentity(expected, actual, relative) {
  if (!hasStableFileIdentity(expected)
    || !hasStableFileIdentity(actual)
    || expected.dev !== actual.dev
    || expected.ino !== actual.ino) {
    throw new Error(`Filesystem identity changed while it was being captured: ${relative}`);
  }
}

async function exists(target) {
  try {
    await access(target);
    return true;
  } catch (error) {
    if (error?.code === 'ENOENT') return false;
    throw error;
  }
}

function assertOwnedPath(root, target) {
  const resolvedRoot = path.resolve(root);
  const resolvedTarget = path.resolve(target);
  if (resolvedTarget === resolvedRoot || !resolvedTarget.startsWith(`${resolvedRoot}${path.sep}`)) {
    throw new Error('Refusing filesystem operation outside the local Risk Fork root');
  }
  return resolvedTarget;
}

function assertInsideWorkspace(workspaceRoot, target, relative) {
  const resolvedRoot = path.resolve(workspaceRoot);
  const resolvedTarget = path.resolve(target);
  if (resolvedTarget !== resolvedRoot
    && !resolvedTarget.startsWith(`${resolvedRoot}${path.sep}`)) {
    throw new Error(`Workspace path escaped the source root: ${relative}`);
  }
  return resolvedTarget;
}

async function enumerateWorkspace(root, {
  maxFiles,
  maxBytes,
  testAfterRead = null,
  captureRoot = null,
}) {
  const workspaceRoot = await realpath(root);
  const resolvedCaptureRoot = captureRoot
    ? await ensurePrivateDirectory(captureRoot, { create: false })
    : await standaloneCaptureRoot();
  await ensureCaptureScavenged(resolvedCaptureRoot);
  const captureDirectory = await mkdtemp(path.join(resolvedCaptureRoot, CAPTURE_DIRECTORY_PREFIX));
  try {
    await writeFile(
      path.join(captureDirectory, CAPTURE_MARKER_NAME),
      await createCaptureMarkerContent(),
      { flag: 'wx', mode: 0o600 },
    );
  } catch (error) {
    await rm(captureDirectory, { recursive: true, force: true }).catch(() => {});
    throw error;
  }
  const records = [];
  Object.defineProperty(records, 'capture_directory', {
    value: captureDirectory,
    enumerable: false,
    configurable: false,
  });
  const seenCaseFolded = new Map();
  let totalBytes = 0;

  async function visit(directory, prefix = '', expectedIdentity = null) {
    const directoryBefore = await lstat(directory, { bigint: true });
    if (!directoryBefore.isDirectory()) {
      throw new Error(`Workspace directory changed while it was being captured: ${prefix || '.'}`);
    }
    if (expectedIdentity) assertSamePathIdentity(expectedIdentity, directoryBefore, prefix || '.');
    const directoryRealPath = assertInsideWorkspace(
      workspaceRoot,
      await realpath(directory),
      prefix || '.',
    );
    const entries = await readdir(directoryRealPath, { withFileTypes: true });
    const directoryAfter = await lstat(directoryRealPath, { bigint: true });
    assertSamePathIdentity(directoryBefore, directoryAfter, prefix || '.');
    assertInsideWorkspace(workspaceRoot, await realpath(directoryRealPath), prefix || '.');
    const entryInfoByName = new Map();
    for (const entry of entries) {
      if (entry.isDirectory() || entry.isFile() || entry.isSymbolicLink()) continue;
      const childPath = path.join(directoryRealPath, entry.name);
      entryInfoByName.set(entry.name, await lstat(childPath, { bigint: true }));
    }
    const childDirectoryIdentities = new Map();
    for (const entry of entries) {
      const entryInfo = entryInfoByName.get(entry.name);
      if (!entry.isDirectory() && !entryInfo?.isDirectory()) continue;
      const childPath = path.join(directoryRealPath, entry.name);
      const childIdentity = entryInfo ?? await lstat(childPath, { bigint: true });
      if (!childIdentity.isDirectory()) {
        throw new Error(`Workspace directory changed while it was being captured: ${entry.name}`);
      }
      childDirectoryIdentities.set(entry.name, childIdentity);
    }
    if (testAfterRead) await testAfterRead({ directory: directoryRealPath, prefix, entries });
    entries.sort((left, right) => left.name.localeCompare(right.name));
    for (const entry of entries) {
      const relative = normalizeRelativePath(
        prefix ? `${prefix}/${entry.name}` : entry.name,
        'workspace path',
      );
      if (relative === '.git' || relative.startsWith('.git/')) {
        throw new Error('Local reference snapshots exclude .git metadata');
      }
      const folded = relative.normalize('NFC').toLocaleLowerCase('en-US');
      const collision = seenCaseFolded.get(folded);
      if (collision && collision !== relative) {
        throw new Error(`Case or Unicode path collision: ${collision} and ${relative}`);
      }
      seenCaseFolded.set(folded, relative);
      const absolute = path.join(directoryRealPath, entry.name);
      const entryInfo = entryInfoByName.get(entry.name);
      const isSymbolicLink = entry.isSymbolicLink() || entryInfo?.isSymbolicLink();
      const isDirectory = entry.isDirectory() || entryInfo?.isDirectory();
      const isFile = entry.isFile() || entryInfo?.isFile();
      if (isSymbolicLink) throw new Error(`Symlinks are forbidden: ${relative}`);
      if (isDirectory) {
        assertInsideWorkspace(workspaceRoot, absolute, relative);
        await visit(absolute, relative, childDirectoryIdentities.get(entry.name));
        continue;
      }
      if (!isFile) throw new Error(`Special filesystem entry is forbidden: ${relative}`);
      if (records.length + 1 > maxFiles) throw new Error(`Workspace exceeds ${maxFiles} files`);
      const handle = await open(absolute, localReadOnlyFlags());
      let capturePath;
      let contentHash;
      let bytesRead = 0;
      let mode;
      let captureCommitted = false;
      try {
        const before = await handle.stat({ bigint: true });
        if (!before.isFile()) throw new Error(`Special filesystem entry is forbidden: ${relative}`);
        assertInsideWorkspace(workspaceRoot, await realpath(absolute), relative);
        const pathAfterOpen = await lstat(absolute, { bigint: true });
        if (pathAfterOpen.isSymbolicLink()) throw new Error(`Symlinks are forbidden: ${relative}`);
        assertSamePathIdentity(pathAfterOpen, before, relative);
        if (!hasStableFileIdentity(before)) {
          throw new Error(`File identity could not be verified: ${relative}`);
        }
        if (before.nlink > 1n) throw new Error(`Hard-linked files are forbidden: ${relative}`);
        const remainingBytes = maxBytes - totalBytes;
        if (before.size > BigInt(remainingBytes)) throw new Error(`Workspace exceeds ${maxBytes} bytes`);

        capturePath = path.join(captureDirectory, `${records.length}-${randomUUID()}.bin`);
        const captureHandle = await open(capturePath, 'wx', 0o600);
        contentHash = createHash('sha256').update('"', 'utf8');
        let base64Remainder = Buffer.alloc(0);
        try {
          while (bytesRead <= remainingBytes) {
            const chunkLength = Math.min(
              LOCAL_SNAPSHOT_READ_CHUNK_BYTES,
              remainingBytes - bytesRead + 1,
            );
            const chunk = Buffer.allocUnsafe(chunkLength);
            const result = await handle.read(chunk, 0, chunkLength, null);
            if (result.bytesRead === 0) break;
            const bytes = chunk.subarray(0, result.bytesRead);
            bytesRead += result.bytesRead;
            let written = 0;
            while (written < bytes.byteLength) {
              const writeResult = await captureHandle.write(
                bytes,
                written,
                bytes.byteLength - written,
              );
              if (!writeResult?.bytesWritten) throw new Error(`Failed to spool captured bytes for ${relative}`);
              written += writeResult.bytesWritten;
            }
            const base64Input = base64Remainder.length > 0
              ? Buffer.concat([base64Remainder, bytes])
              : bytes;
            const completeLength = base64Input.length - (base64Input.length % 3);
            if (completeLength > 0) {
              contentHash.update(base64Input.subarray(0, completeLength).toString('base64'), 'utf8');
            }
            base64Remainder = completeLength === base64Input.length
              ? Buffer.alloc(0)
              : Buffer.from(base64Input.subarray(completeLength));
            if (bytesRead > remainingBytes) throw new Error(`Workspace exceeds ${maxBytes} bytes`);
          }
          if (base64Remainder.length > 0) contentHash.update(base64Remainder.toString('base64'), 'utf8');
          contentHash.update('"', 'utf8');
        } catch (error) {
          await captureHandle.close().catch(() => {});
          try { await unlink(capturePath); } catch (unlinkError) { if (unlinkError?.code !== 'ENOENT') throw unlinkError; }
          throw error;
        }
        await captureHandle.close();

        const after = await handle.stat({ bigint: true });
        assertSamePathIdentity(before, after, relative);
        if (!after.isFile()
          || after.nlink > 1n
          || after.size !== before.size
          || BigInt(bytesRead) !== before.size
          || after.mtimeMs !== before.mtimeMs
          || after.ctimeMs !== before.ctimeMs) {
          throw new Error(`File changed while it was being captured: ${relative}`);
        }
        mode = Number(before.mode & 0o777n);
        captureCommitted = true;
      } finally {
        await handle.close();
        if (!captureCommitted && capturePath) {
          try { await unlink(capturePath); } catch (error) { if (error?.code !== 'ENOENT') throw error; }
        }
      }
      totalBytes += bytesRead;
      const record = {
        path: relative,
        bytes: bytesRead,
        content_hash: `sha256:${contentHash.digest('hex')}`,
        mode,
      };
      capturedContentByRecord.set(record, capturePath);
      records.push(record);
    }
  }

  try {
    await visit(workspaceRoot);
  } catch (error) {
    await releaseCapturedContent(records);
    throw error;
  }
  const publicRecords = records.map(({ path: recordPath, bytes, content_hash: contentHash }) => ({
    path: recordPath,
    bytes,
    content_hash: contentHash,
  }));
  return {
    records,
    capture_directory: records.capture_directory,
    public_records: publicRecords,
    file_count: publicRecords.length,
    total_bytes: totalBytes,
    workspace_digest: sha256Ref(publicRecords),
  };
}

// Internal deterministic race-test seam. It is not used by production callers.
export async function __testEnumerateWorkspace(root, options = {}) {
  const snapshot = await enumerateWorkspace(path.resolve(requireString(root, 'root')), {
    maxFiles: options.maxFiles ?? 2_000,
    maxBytes: options.maxBytes ?? 32 * 1024 * 1024,
    testAfterRead: options.afterRead,
    captureRoot: options.captureRoot,
  });
  if (!options.retain) await releaseCapturedContent(snapshot.records);
  return snapshot;
}

// Internal deterministic cleanup-test seam. It is not used by production callers.
export async function __testReleaseCapturedContent(records) {
  await releaseCapturedContent(records);
}

export async function inspectLocalWorkspace(input = {}) {
  const sourceWorkspace = path.resolve(requireString(input.source_workspace, 'source_workspace'));
  const info = await lstat(sourceWorkspace);
  if (info.isSymbolicLink() || !info.isDirectory()) {
    throw new TypeError('source_workspace must be a real directory, not a symlink');
  }
  const snapshot = await enumerateWorkspace(sourceWorkspace, {
    maxFiles: boundedInteger(input.max_files ?? 2_000, 'max_files', { min: 1, max: 100_000 }),
    maxBytes: boundedInteger(
      input.max_bytes ?? 32 * 1024 * 1024,
      'max_bytes',
      { min: 1, max: 1024 * 1024 * 1024 },
    ),
    captureRoot: await standaloneCaptureRoot(),
  });
  try {
    return {
      file_count: snapshot.file_count,
      total_bytes: snapshot.total_bytes,
      workspace_digest: snapshot.workspace_digest,
      files: cloneJson(snapshot.public_records),
    };
  } finally {
    await releaseCapturedContent(snapshot.records);
  }
}

async function copyRecords(records, destination) {
  for (const record of records) {
    const target = path.join(destination, ...record.path.split('/'));
    await mkdir(path.dirname(target), { recursive: true });
    const capturePath = capturedContentByRecord.get(record);
    if (typeof capturePath !== 'string') throw new Error(`Missing captured bytes for ${record.path}`);
    await copyFile(capturePath, target, fsConstants.COPYFILE_EXCL);
    await chmod(target, record.mode);
  }
}

async function verifyLocalAuthorityFreeSnapshot({
  verifier,
  capsule,
  snapshot,
  snapshotDirectory,
}) {
  if (snapshot.file_count === 0) {
    const evidenceHash = sha256Ref({
      capsule_hash: capsule.capsule_hash,
      workspace_digest: snapshot.workspace_digest,
      file_count: 0,
      authority_free_basis: 'empty_filesystem_snapshot',
    });
    return {
      status: 'verified',
      evidence_ref: `local-empty-snapshot:${evidenceHash.slice(7, 23)}`,
      evidence_hash: evidenceHash,
      verification_basis: 'empty_filesystem_snapshot',
    };
  }
  if (typeof verifier !== 'function') {
    throw new Error(
      'Non-empty local snapshots require an external clean-side authority-free verifier',
    );
  }
  const request = {
    schema: 'agoragentic.risk-fork.local-authority-free-request.v1',
    capsule_hash: capsule.capsule_hash,
    workspace_digest: snapshot.workspace_digest,
    file_count: snapshot.file_count,
    total_bytes: snapshot.total_bytes,
    files: cloneJson(snapshot.public_records),
    request_hash: null,
  };
  request.request_hash = sha256Ref({ ...request, request_hash: null });
  const result = await verifier(deepFreeze(cloneJson(request)), {
    snapshot_directory: snapshotDirectory,
  });
  assertAllowedKeys(result, [
    'schema',
    'status',
    'request_hash',
    'capsule_hash',
    'workspace_digest',
    'evidence_ref',
    'evidence_hash',
    'claims',
  ], 'local authority-free attestation');
  if (result.schema !== 'agoragentic.risk-fork.local-authority-free-attestation.v1'
    || result.status !== 'verified'
    || !safeEqual(result.request_hash, request.request_hash)
    || !safeEqual(result.capsule_hash, capsule.capsule_hash)
    || !safeEqual(result.workspace_digest, snapshot.workspace_digest)) {
    throw new Error('Local authority-free attestation is not verified for this exact snapshot');
  }
  assertAllowedKeys(result.claims, [
    'authority_free',
    'credentials_absent',
    'wallet_material_absent',
    'execution_authority_absent',
  ], 'local authority-free attestation.claims');
  for (const claim of [
    'authority_free',
    'credentials_absent',
    'wallet_material_absent',
    'execution_authority_absent',
  ]) {
    if (result.claims[claim] !== true) {
      throw new Error(`Local authority-free attestation must verify ${claim}`);
    }
  }
  return {
    status: 'verified',
    evidence_ref: requireOpaqueRef(
      result.evidence_ref,
      'local authority-free attestation.evidence_ref',
    ),
    evidence_hash: requireSha256Ref(
      result.evidence_hash,
      'local authority-free attestation.evidence_hash',
    ),
    verification_basis: 'external_clean_side_attestation',
  };
}

function startClosedOperation({ workspace, forkId, operation }) {
  const minimalEnv = {
    RISK_FORK_NETWORK: 'blocked',
    RISK_FORK_ID: forkId,
  };
  for (const key of ['SystemRoot', 'WINDIR']) {
    if (typeof process.env[key] === 'string') minimalEnv[key] = process.env[key];
  }
  const child = spawn(process.execPath, [runnerPath, workspace], {
    cwd: workspace,
    env: minimalEnv,
    windowsHide: true,
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  let stdout = '';
  let stderr = '';
  let spawnError = null;
  let terminationError = null;
  let closed = false;
  let resolveClosed;
  const closedPromise = new Promise((resolve) => { resolveClosed = resolve; });

  function requestTermination(error) {
    terminationError ??= error;
    if (closed) return;
    try {
      child.kill();
    } catch (killError) {
      spawnError ??= killError;
    }
  }

  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  child.stdout.on('data', (chunk) => {
    if (terminationError) return;
    stdout += chunk;
    if (Buffer.byteLength(stdout, 'utf8') > 2 * 1024 * 1024) {
      stdout = '';
      requestTermination(new Error('Local reference runner stdout exceeded 2097152 bytes'));
    }
  });
  child.stderr.on('data', (chunk) => {
    if (terminationError) return;
    stderr += chunk;
    if (Buffer.byteLength(stderr, 'utf8') > 256 * 1024) {
      stderr = '';
      requestTermination(new Error('Local reference runner stderr exceeded 262144 bytes'));
    }
  });
  child.once('error', (error) => { spawnError = error; });
  child.once('close', (code) => {
    closed = true;
    resolveClosed(code);
  });
  child.stdin.once('error', (error) => requestTermination(error));
  child.stdin.end(JSON.stringify(operation));

  const result = closedPromise.then((code) => {
    if (terminationError) throw terminationError;
    if (spawnError) throw spawnError;
    if (code !== 0) {
      throw new Error(`Local reference operation failed: ${stderr.trim().slice(0, 2000)}`);
    }
    try {
      return { parsed: JSON.parse(stdout), stdout_bytes: Buffer.byteLength(stdout, 'utf8') };
    } catch {
      throw new Error('Local reference runner returned invalid JSON');
    }
  });

  return {
    result,
    async terminate(reason) {
      requestTermination(
        reason instanceof Error ? reason : new Error('Local reference runner terminated'),
      );
      await closedPromise;
    },
  };
}

function normalizeOperationHandle(value) {
  if (!value || typeof value !== 'object'
    || typeof value.result?.then !== 'function'
    || typeof value.terminate !== 'function') {
    throw new TypeError('Local reference operation runner must return a cancellable handle');
  }
  const result = Promise.resolve(value.result).then((rawResult) => {
    const normalized = JSON.parse(canonicalize(rawResult));
    assertAllowedKeys(
      normalized,
      ['parsed', 'stdout_bytes'],
      'Local reference operation runner result',
    );
    const parsed = assertPlainObject(
      normalized.parsed,
      'Local reference operation runner result.parsed',
    );
    assertAllowedKeys(parsed, [
      'schema',
      'status',
      'network_contract',
      'observations',
      'commit_candidate',
    ], 'Local reference operation runner result.parsed');
    if (parsed.schema !== 'agoragentic.risk-fork.local-runner-result.v1'
      || parsed.status !== 'completed'
      || parsed.network_contract !== 'blocked_by_closed_operation_set_not_kernel_firewall'
      || !Array.isArray(parsed.observations)
      || (parsed.commit_candidate !== null
        && (!parsed.commit_candidate
          || typeof parsed.commit_candidate !== 'object'
          || Array.isArray(parsed.commit_candidate)))) {
      throw new TypeError('Local reference operation runner returned an invalid result envelope');
    }
    normalized.stdout_bytes = boundedInteger(
      normalized.stdout_bytes,
      'Local reference operation runner result.stdout_bytes',
      { min: 0, max: MAX_LOCAL_RUNNER_STDOUT_BYTES },
    );
    return deepFreeze(normalized);
  });
  let terminationPromise = null;
  return {
    result,
    terminate(reason) {
      if (!terminationPromise) {
        const attempt = (async () => {
          let terminationFailure = null;
          try {
            await value.terminate(reason);
          } catch (error) {
            terminationFailure = error;
          }
          await result.catch(() => {});
          if (terminationFailure) throw terminationFailure;
        })();
        terminationPromise = attempt;
        attempt.catch(() => {
          if (terminationPromise === attempt) terminationPromise = null;
        });
      }
      return terminationPromise;
    },
  };
}

function executionTimeoutError(timeoutMs) {
  const error = new Error(`Local reference operation exceeded ${timeoutMs}ms`);
  error.code = 'LOCAL_REFERENCE_EXECUTION_TIMEOUT';
  return error;
}

function forkExpiredError() {
  const error = new Error('Cannot execute in an expired local reference fork');
  error.code = 'LOCAL_REFERENCE_FORK_EXPIRED';
  return error;
}

async function waitForOperation(handle, timeoutMs, executionDeadlineMs, forkDeadlineMs) {
  let timer;
  const outcome = handle.result.then(
    (value) => ({ status: 'completed', value }),
    (error) => ({ status: 'failed', error }),
  );
  const forkDeadlineFirst = forkDeadlineMs <= executionDeadlineMs;
  const nearestDeadlineMs = Math.min(executionDeadlineMs, forkDeadlineMs);
  const timeout = new Promise((resolve) => {
    timer = setTimeout(
      () => resolve({ status: 'timeout' }),
      Math.max(0, Math.ceil(nearestDeadlineMs - performance.now())),
    );
  });
  const selected = await Promise.race([outcome, timeout]);
  clearTimeout(timer);
  const observedAtMs = performance.now();
  if ((selected.status === 'timeout' && forkDeadlineFirst)
    || observedAtMs >= forkDeadlineMs) {
    const error = forkExpiredError();
    try {
      await handle.terminate(error);
    } catch (terminationError) {
      error.cause = terminationError;
    }
    throw error;
  }
  if (selected.status === 'timeout' || observedAtMs >= executionDeadlineMs) {
    const error = executionTimeoutError(timeoutMs);
    await handle.terminate(error);
    throw error;
  }
  if (selected.status === 'completed') return selected.value;
  if (selected.status === 'failed') throw selected.error;
  throw new Error('Local reference operation returned an impossible wait outcome');
}

function assertForkExecutionReady(record) {
  const state = record.destroyed ? 'destroyed' : record.status;
  if (state !== 'ready') throw new Error(`Cannot execute from fork state ${state}`);
}

function isForkExpired(record, now) {
  return performance.now() >= record.hard_deadline_ms
    || Date.parse(record.expires_at) <= now.getTime();
}

function claimForkExecution(record, clock) {
  assertForkExecutionReady(record);
  if (isForkExpired(record, clock())) throw forkExpiredError();
  record.execution_generation += 1;
  record.status = 'executing';
  return record.execution_generation;
}

function publishForkExecution(record, lease, generation, lastExecution, clock) {
  const publicationTime = clock();
  if (record.active_execution !== lease
    || record.execution_generation !== generation
    || record.status !== 'executing') {
    const error = new Error('Local reference execution lease was cancelled');
    error.code = 'LOCAL_REFERENCE_EXECUTION_CANCELLED';
    throw error;
  }
  if (isForkExpired(record, publicationTime)) throw forkExpiredError();
  record.last_execution = lastExecution;
  record.status = 'tainted';
  return lastExecution;
}

export class LocalReferenceRiskForkAdapter extends RiskForkProvider {
  constructor(options = {}) {
    const hasTestOperationRunner = options.operationRunner !== undefined;
    super({
      id: 'local-reference-v1',
      capabilities: {
        supports_memory_snapshot: false,
        supports_filesystem_snapshot: true,
        supports_live_fork: false,
        supports_network_policy: false,
        supports_egress_allowlist: false,
        supports_runtime_attestation: false,
        supports_suspend_resume: false,
        supports_verified_destruction: !hasTestOperationRunner,
        supports_hard_ttl: !hasTestOperationRunner,
        supports_idle_ttl: false,
        supports_max_execution_time: !hasTestOperationRunner,
        supports_automatic_credential_expiry: false,
        child_credentials_mode: 'prohibited',
        isolation_class: 'local_reference_protocol_simulator',
        adapter_implementation: hasTestOperationRunner ? 'test_only_injected_runner' : 'complete',
        mock_conformance: hasTestOperationRunner ? 'test_only' : 'passed',
        credentialed_provider_validation: 'not_applicable',
        containment_claim: 'not_isolation',
      },
    });
    this.baseDirectory = options.baseDirectory
      ? path.resolve(options.baseDirectory)
      : null;
    if (process.platform === 'win32' && this.baseDirectory) {
      throw new Error(
        'Explicit baseDirectory is unavailable on Windows until private ACL ownership can be proven; omit baseDirectory to use the private default root',
      );
    }
    this.captureRoot = null;
    this.maxFiles = boundedInteger(options.maxFiles ?? 2_000, 'maxFiles', { min: 1, max: 100_000 });
    this.maxBytes = boundedInteger(
      options.maxBytes ?? 32 * 1024 * 1024,
      'maxBytes',
      { min: 1, max: 1024 * 1024 * 1024 },
    );
    this.clock = options.clock ?? (() => new Date());
    if (options.verifyAuthorityFreeSource !== undefined
      && typeof options.verifyAuthorityFreeSource !== 'function') {
      throw new TypeError('verifyAuthorityFreeSource must be a function');
    }
    if (options.operationRunner !== undefined && typeof options.operationRunner !== 'function') {
      throw new TypeError('operationRunner trusted test seam must be a function');
    }
    if (options.removeDirectory !== undefined && typeof options.removeDirectory !== 'function') {
      throw new TypeError('removeDirectory trusted test seam must be a function');
    }
    this.verifyAuthorityFreeSource = options.verifyAuthorityFreeSource ?? null;
    this.removeDirectory = options.removeDirectory ?? ((target) => rm(target, {
      recursive: true,
      force: true,
    }));
    testOperationRunners.set(this, options.operationRunner ?? startClosedOperation);
    this.savepoints = new Map();
    this.forks = new Map();
    this.initialized = false;
  }

  async initialize() {
    if (this.initialized) return this;
    if (!this.baseDirectory) {
      this.baseDirectory = await createDefaultAdapterDirectory();
    } else {
      await ensurePrivateDirectory(this.baseDirectory, { create: false });
    }
    this.captureRoot = await ensurePrivateDirectory(
      path.join(this.baseDirectory, CAPTURE_SPOOL_DIRECTORY_NAME),
    );
    await writeFile(
      path.join(this.baseDirectory, ADAPTER_MARKER_NAME),
      await createAdapterMarkerContent(),
      { flag: 'wx', mode: 0o600 },
    );
    await mkdir(path.join(this.baseDirectory, 'savepoints'), { recursive: true });
    await mkdir(path.join(this.baseDirectory, 'forks'), { recursive: true });
    this.initialized = true;
    return this;
  }

  #savepointRecord(ref) {
    const record = this.savepoints.get(ref);
    if (!record) throw new Error(`Unknown local savepoint: ${ref}`);
    return record;
  }

  #forkRecord(ref) {
    const record = this.forks.get(ref);
    if (!record) throw new Error(`Unknown local fork: ${ref}`);
    return record;
  }

  async createSavepoint(input = {}) {
    if (!this.initialized) await this.initialize();
    verifySavepointCapsule(input.capsule, { now: this.clock() });
    const sourceWorkspace = path.resolve(requireString(input.source_workspace, 'source_workspace'));
    const info = await lstat(sourceWorkspace);
    if (info.isSymbolicLink() || !info.isDirectory()) {
      throw new TypeError('source_workspace must be a real directory, not a symlink');
    }
    const snapshot = await enumerateWorkspace(sourceWorkspace, {
      maxFiles: this.maxFiles,
      maxBytes: this.maxBytes,
      captureRoot: this.captureRoot,
    });
    if (!safeEqual(snapshot.workspace_digest, input.capsule.workspace.digest)) {
      await releaseCapturedContent(snapshot.records);
      throw new Error('Source workspace digest does not match the Savepoint Capsule');
    }
    let authorityAttestation;
    try {
      authorityAttestation = await verifyLocalAuthorityFreeSnapshot({
        verifier: this.verifyAuthorityFreeSource,
        capsule: input.capsule,
        snapshot,
        // The verifier must inspect the immutable descriptor-backed capture,
        // not the mutable caller workspace that was used to create it.
        snapshotDirectory: snapshot.capture_directory,
      });
    } catch (error) {
      await releaseCapturedContent(snapshot.records);
      throw error;
    }
    const id = randomUUID();
    const ref = `local-savepoint:${id}`;
    const directory = assertOwnedPath(
      this.baseDirectory,
      path.join(this.baseDirectory, 'savepoints', id),
    );
    try {
      await mkdir(directory, { recursive: false });
    } catch (error) {
      await releaseCapturedContent(snapshot.records);
      throw error;
    }
    let record = null;
    let primaryError = null;
    try {
      await copyRecords(snapshot.records, directory);
      const copiedSnapshot = await enumerateWorkspace(directory, {
        maxFiles: this.maxFiles,
        maxBytes: this.maxBytes,
        captureRoot: this.captureRoot,
      });
      try {
        if (!safeEqual(copiedSnapshot.workspace_digest, snapshot.workspace_digest)) {
          throw new Error('Local savepoint changed while it was being copied');
        }
      } finally {
        await releaseCapturedContent(copiedSnapshot.records);
      }
      record = {
        ref,
        directory,
        capsule_hash: input.capsule.capsule_hash,
        workspace_digest: snapshot.workspace_digest,
        authority_attestation: authorityAttestation,
        created_at: this.clock().toISOString(),
        destroyed: false,
      };
      this.savepoints.set(ref, record);
      return {
        savepoint_ref: ref,
        savepoint_hash: sha256Ref({
          ref,
          capsule_hash: record.capsule_hash,
          workspace_digest: record.workspace_digest,
          authority_attestation_hash: authorityAttestation.evidence_hash,
        }),
        workspace_digest: record.workspace_digest,
        runtime_snapshot: {
          mode: 'filesystem',
          memory_included: false,
          authority_included: false,
        },
        authority_attestation: cloneJson(authorityAttestation),
        evidence_status: 'verified',
      };
    } catch (error) {
      primaryError = error;
      if (record) this.savepoints.delete(ref);
      // Cleanup is best-effort here; never replace the operation's primary
      // failure with a secondary filesystem cleanup error.
      await this.removeDirectory(directory).catch(() => {});
      throw error;
    } finally {
      try {
        await releaseCapturedContent(snapshot.records);
      } catch (error) {
        // A final spool-cleanup failure must not leave an apparently usable
        // savepoint whose captured source state could not be released.
        if (record) {
          try {
            await this.removeDirectory(directory);
            this.savepoints.delete(ref);
          } catch {
            // Retain the owned record for an explicit cleanup retry. It is
            // marked unusable so no fork can consume an unresolved directory.
            record.cleanup_pending = true;
          }
        } else {
          await this.removeDirectory(directory).catch(() => {});
        }
        if (!primaryError) throw error;
      }
    }
  }

  async createFork(input = {}) {
    if (!this.initialized) await this.initialize();
    const savepoint = this.#savepointRecord(requireString(input.savepoint_ref, 'savepoint_ref'));
    if (savepoint.destroyed) throw new Error('Cannot fork a destroyed savepoint');
    if (savepoint.cleanup_pending) {
      throw new Error('Cannot fork a savepoint with unresolved cleanup');
    }
    assertFreshForkIdentity(input.fork_identity);
    const policy = networkPolicy(input.network_policy);
    if (policy.mode !== 'blocked') {
      throw new Error('Local reference adapter cannot enforce an egress allowlist');
    }
    const ttlMs = boundedInteger(input.ttl_ms ?? 60_000, 'ttl_ms', { min: 1_000, max: 60 * 60 * 1000 });
    const id = randomUUID();
    const ref = `local-fork:${id}`;
    const directory = assertOwnedPath(this.baseDirectory, path.join(this.baseDirectory, 'forks', id));
    await mkdir(directory, { recursive: false });
    const source = await enumerateWorkspace(savepoint.directory, {
      maxFiles: this.maxFiles,
      maxBytes: this.maxBytes,
      captureRoot: this.captureRoot,
    });
    let record = null;
    try {
      await copyRecords(source.records, directory);
      const createdAt = this.clock();
      const hardDeadlineMs = performance.now() + ttlMs;
      record = {
        ref,
        directory,
        savepoint_ref: savepoint.ref,
        baseline_digest: source.workspace_digest,
        identity_hash: input.fork_identity.identity_hash,
        network_policy_hash: policy.policy_hash,
        created_at: createdAt.toISOString(),
        expires_at: new Date(createdAt.getTime() + ttlMs).toISOString(),
        hard_deadline_ms: hardDeadlineMs,
        status: 'ready',
        last_execution: null,
        destroyed: false,
        execution_generation: 0,
        active_execution: null,
        destroy_promise: null,
        destroy_reason: null,
        ttl_timer: null,
      };
      this.forks.set(ref, record);
      // The copied fork is now tracked before spool release, so a cleanup
      // failure cannot strand an unowned directory.
      await releaseCapturedContent(source.records);
      record.ttl_timer = setTimeout(() => {
        record.ttl_timer = null;
        this.destroyFork({ fork_ref: ref, reason: 'provider_ttl_expired' }).catch(() => {});
      }, Math.max(0, Math.ceil(hardDeadlineMs - performance.now())));
      record.ttl_timer.unref?.();
      return {
        fork_ref: ref,
        fork_hash: sha256Ref({
          ref,
          savepoint_ref: savepoint.ref,
          identity_hash: record.identity_hash,
          network_policy_hash: record.network_policy_hash,
        }),
        status: 'ready',
        expires_at: record.expires_at,
        isolation_class: this.capabilities.isolation_class,
        network_contract: 'blocked_by_closed_operation_set_not_kernel_firewall',
      };
    } catch (error) {
      if (record) {
        if (record.ttl_timer) clearTimeout(record.ttl_timer);
        try {
          await this.removeDirectory(directory);
          this.forks.delete(ref);
        } catch {
          record.cleanup_pending = true;
          record.status = 'destroy_failed';
        }
      } else {
        await releaseCapturedContent(source.records).catch(() => {});
        await this.removeDirectory(directory).catch(() => {});
      }
      throw error;
    }
  }

  async getForkStatus(input = {}) {
    const record = this.#forkRecord(requireString(input.fork_ref, 'fork_ref'));
    if (!record.destroyed && isForkExpired(record, this.clock())) {
      await this.destroyFork({ fork_ref: record.ref, reason: 'provider_ttl_expired' });
    }
    return {
      fork_ref: record.ref,
      status: record.destroyed ? 'destroyed' : record.status,
      expires_at: record.expires_at,
    };
  }

  async executeInFork(input = {}) {
    assertAllowedKeys(
      input,
      ['fork_ref', 'operation', 'execution_mode', 'timeout_ms', 'scoped_credentials'],
      'local executeInFork input',
    );
    const record = this.#forkRecord(requireString(input.fork_ref, 'fork_ref'));
    if (!record.destroyed && isForkExpired(record, this.clock())) {
      await this.destroyFork({ fork_ref: record.ref, reason: 'provider_ttl_expired' });
      throw forkExpiredError();
    }
    assertForkExecutionReady(record);
    if (input.scoped_credentials && Object.keys(input.scoped_credentials).length > 0) {
      throw new Error('Local reference adapter does not accept credentials');
    }
    const executionMode = requireEnum(
      input.execution_mode,
      ['prepare_only', 'isolated_execution'],
      'execution_mode',
    );
    const timeoutMs = boundedInteger(
      input.timeout_ms ?? 30_000,
      'timeout_ms',
      { min: 100, max: 10 * 60 * 1000 },
    );
    const operation = validateLocalReferenceOperation(input.operation);
    let generation;
    try {
      generation = claimForkExecution(record, () => this.clock());
    } catch (error) {
      if (error?.code === 'LOCAL_REFERENCE_FORK_EXPIRED') {
        await this.destroyFork({ fork_ref: record.ref, reason: 'provider_ttl_expired' });
      }
      throw error;
    }
    const executionDeadlineMs = performance.now() + timeoutMs;
    const started = this.clock();
    let finishExecution;
    const lease = {
      generation,
      handle: null,
      finished: new Promise((resolve) => { finishExecution = resolve; }),
    };
    record.active_execution = lease;
    try {
      lease.handle = normalizeOperationHandle(testOperationRunners.get(this)({
        workspace: record.directory,
        forkId: record.ref,
        operation: cloneJson(operation),
      }));
      const execution = await waitForOperation(
        lease.handle,
        timeoutMs,
        executionDeadlineMs,
        record.hard_deadline_ms,
      );
      const completed = this.clock();
      const lastExecution = {
        started_at: started.toISOString(),
        completed_at: completed.toISOString(),
        duration_ms: Math.max(0, completed.getTime() - started.getTime()),
        result_hash: sha256Ref(execution.parsed),
        stdout_bytes: execution.stdout_bytes,
        execution_mode: executionMode,
      };
      publishForkExecution(
        record,
        lease,
        generation,
        lastExecution,
        () => this.clock(),
      );
      return {
        status: 'completed',
        taint_status: 'TAINTED',
        commit_candidate: execution.parsed.commit_candidate,
        result_hash: lastExecution.result_hash,
        measurements: cloneJson(lastExecution),
      };
    } catch (error) {
      if (error?.code === 'LOCAL_REFERENCE_EXECUTION_CANCELLED'
        && record.status === 'destroying'
        && record.destroy_reason === 'provider_ttl_expired') {
        error = forkExpiredError();
      }
      if (error?.code === 'LOCAL_REFERENCE_FORK_EXPIRED') {
        finishExecution();
        await this.destroyFork({ fork_ref: record.ref, reason: 'provider_ttl_expired' });
      } else if (record.active_execution === lease
        && record.execution_generation === generation
        && record.status === 'executing') {
        record.status = 'failed';
      }
      throw error;
    } finally {
      if (record.active_execution === lease
        && !['destroying', 'destroy_failed'].includes(record.status)) {
        record.active_execution = null;
      }
      finishExecution();
    }
  }

  async collectEvidence(input = {}) {
    const record = this.#forkRecord(requireString(input.fork_ref, 'fork_ref'));
    return {
      fork_ref: record.ref,
      status: record.status,
      identity_hash: record.identity_hash,
      network_policy_hash: record.network_policy_hash,
      last_execution: cloneJson(record.last_execution),
      raw_stdout_included: false,
      raw_stderr_included: false,
      credentials_included: false,
      evidence_hash: sha256Ref({
        fork_ref: record.ref,
        status: record.status,
        identity_hash: record.identity_hash,
        network_policy_hash: record.network_policy_hash,
        last_execution: record.last_execution,
      }),
    };
  }

  async collectDiff(input = {}) {
    const record = this.#forkRecord(requireString(input.fork_ref, 'fork_ref'));
    const savepoint = this.#savepointRecord(record.savepoint_ref);
    const before = await enumerateWorkspace(savepoint.directory, {
      maxFiles: this.maxFiles,
      maxBytes: this.maxBytes,
      captureRoot: this.captureRoot,
    });
    let after;
    try {
      after = await enumerateWorkspace(record.directory, {
        maxFiles: this.maxFiles,
        maxBytes: this.maxBytes,
        captureRoot: this.captureRoot,
      });
    } catch (error) {
      await releaseCapturedContent(before.records);
      throw error;
    }
    try {
      const beforeMap = new Map(before.records.map((item) => [item.path, item]));
      const afterMap = new Map(after.records.map((item) => [item.path, item]));
      const paths = [...new Set([...beforeMap.keys(), ...afterMap.keys()])].sort();
      const files = [];
      let materializedDiffBytes = 0;
      for (const relative of paths) {
        const oldFile = beforeMap.get(relative);
        const newFile = afterMap.get(relative);
        if (oldFile && newFile && oldFile.content_hash === newFile.content_hash) continue;
        if (!newFile) {
          files.push({
            path: relative,
            operation: 'delete',
            before_hash: oldFile.content_hash,
            after_hash: null,
            after_content: null,
          });
          continue;
        }
        const capturePath = capturedContentByRecord.get(newFile);
        if (typeof capturePath !== 'string') throw new Error(`Missing captured bytes for ${relative}`);
        if (newFile.bytes > MAX_LOCAL_DIFF_CONTENT_BYTES) {
          throw new Error(`Local reference diff content exceeds ${MAX_LOCAL_DIFF_CONTENT_BYTES} bytes: ${relative}`);
        }
        if (materializedDiffBytes + newFile.bytes > MAX_LOCAL_DIFF_CONTENT_BYTES) {
          throw new Error(
            `Local reference diff materialization exceeds ${MAX_LOCAL_DIFF_CONTENT_BYTES} bytes`,
          );
        }
        materializedDiffBytes += newFile.bytes;
        const content = await readFile(capturePath);
        let text;
        try {
          text = utf8Decoder.decode(content);
        } catch {
          throw new Error(`Local reference diff cannot import binary file: ${relative}`);
        }
        files.push({
          path: relative,
          operation: oldFile ? 'modify' : 'create',
          before_hash: oldFile?.content_hash ?? null,
          after_hash: sha256Ref(text),
          after_content: text,
        });
      }
      return {
        type: 'WORKSPACE_DIFF',
        files,
        test_evidence: [],
      };
    } finally {
      await releaseCapturedContent(before.records);
      await releaseCapturedContent(after.records);
    }
  }

  async suspendFork(input = {}) {
    const record = this.#forkRecord(requireString(input.fork_ref, 'fork_ref'));
    throw new Error(
      `Local reference adapter does not support suspend/resume; fork remains ${record.status}`,
    );
  }

  async #destroyForkRecord(record) {
    record.execution_generation += 1;
    record.status = 'destroying';
    if (record.ttl_timer) {
      clearTimeout(record.ttl_timer);
      record.ttl_timer = null;
    }
    try {
      const activeExecution = record.active_execution;
      if (activeExecution) {
        const cancellation = new Error('Local reference execution cancelled for fork destruction');
        cancellation.code = 'LOCAL_REFERENCE_EXECUTION_CANCELLED';
        await activeExecution.handle.terminate(cancellation);
        await activeExecution.finished;
        if (record.active_execution === activeExecution) record.active_execution = null;
      }
      const target = assertOwnedPath(this.baseDirectory, record.directory);
      await rm(target, {
        recursive: true,
        force: true,
        maxRetries: 5,
        retryDelay: 25,
      });
      record.destroyed = true;
      record.status = 'destroyed';
      return {
        fork_ref: record.ref,
        status: 'destroy_requested_observed',
        evidence_hash: sha256Ref({ fork_ref: record.ref, request: 'destroy' }),
      };
    } catch (error) {
      record.status = 'destroy_failed';
      throw error;
    }
  }

  async destroyFork(input = {}) {
    assertAllowedKeys(
      input,
      ['fork_ref', 'reason', 'cleanup_request'],
      'local destroyFork input',
    );
    const record = this.#forkRecord(requireString(input.fork_ref, 'fork_ref'));
    if (input.cleanup_request) {
      verifyCleanupVerificationRequest(input.cleanup_request, {
        provider_id: this.id,
        resource_kind: 'fork',
        resource_ref: record.ref,
      });
    }
    if (!record.destroy_promise) {
      record.destroy_reason = input.reason ?? 'unspecified';
      record.destroy_promise = this.#destroyForkRecord(record);
      try {
        return await record.destroy_promise;
      } catch (error) {
        record.destroy_promise = null;
        throw error;
      }
    }
    return record.destroy_promise;
  }

  async verifyDestroyed(input = {}) {
    assertAllowedKeys(
      input,
      ['fork_ref', 'cleanup_request'],
      'local verifyDestroyed input',
    );
    const record = this.#forkRecord(requireString(input.fork_ref, 'fork_ref'));
    const cleanupRequest = input.cleanup_request
      ? verifyCleanupVerificationRequest(input.cleanup_request, {
          provider_id: this.id,
          resource_kind: 'fork',
          resource_ref: record.ref,
        })
      : createCleanupVerificationRequest({
          provider_id: this.id,
          resource_kind: 'fork',
          resource_ref: record.ref,
          requested_at: this.clock(),
          request_nonce: randomUUID(),
        });
    const absent = !(await exists(assertOwnedPath(this.baseDirectory, record.directory)));
    const observationHash = sha256Ref({
      provider_id: this.id,
      fork_ref: record.ref,
      absent,
      inspected_path_hash: sha256Ref(record.directory),
    });
    return createCleanupVerificationEvidence(cleanupRequest, {
      status: absent ? 'verified' : 'failed',
      outcome: absent ? 'success' : 'failure',
      evidence_ref: `local-absence:${sha256Ref(record.ref).slice(7, 23)}`,
      observation_hash: observationHash,
      observed_at: this.clock(),
    });
  }

  async destroySavepoint(input = {}) {
    assertAllowedKeys(
      input,
      ['savepoint_ref', 'cleanup_request'],
      'local destroySavepoint input',
    );
    const record = this.#savepointRecord(requireString(input.savepoint_ref, 'savepoint_ref'));
    if (input.cleanup_request) {
      verifyCleanupVerificationRequest(input.cleanup_request, {
        provider_id: this.id,
        resource_kind: 'savepoint',
        resource_ref: record.ref,
      });
    }
    if (!record.destroyed) {
      try {
        await this.removeDirectory(assertOwnedPath(this.baseDirectory, record.directory));
      } catch (error) {
        record.cleanup_pending = true;
        throw error;
      }
      record.cleanup_pending = false;
      record.destroyed = true;
    }
    return {
      savepoint_ref: record.ref,
      status: 'destroy_requested_observed',
      evidence_hash: sha256Ref({ savepoint_ref: record.ref, request: 'destroy' }),
    };
  }

  async verifySavepointDestroyed(input = {}) {
    assertAllowedKeys(
      input,
      ['savepoint_ref', 'cleanup_request'],
      'local verifySavepointDestroyed input',
    );
    const record = this.#savepointRecord(requireString(input.savepoint_ref, 'savepoint_ref'));
    const cleanupRequest = input.cleanup_request
      ? verifyCleanupVerificationRequest(input.cleanup_request, {
          provider_id: this.id,
          resource_kind: 'savepoint',
          resource_ref: record.ref,
        })
      : createCleanupVerificationRequest({
          provider_id: this.id,
          resource_kind: 'savepoint',
          resource_ref: record.ref,
          requested_at: this.clock(),
          request_nonce: randomUUID(),
        });
    const absent = !(await exists(assertOwnedPath(this.baseDirectory, record.directory)));
    const observationHash = sha256Ref({
      provider_id: this.id,
      savepoint_ref: record.ref,
      absent,
      inspected_path_hash: sha256Ref(record.directory),
    });
    return createCleanupVerificationEvidence(cleanupRequest, {
      status: absent ? 'verified' : 'failed',
      outcome: absent ? 'success' : 'failure',
      evidence_ref: `local-savepoint-absence:${sha256Ref(record.ref).slice(7, 23)}`,
      observation_hash: observationHash,
      observed_at: this.clock(),
    });
  }

  async dispose() {
    if (!this.baseDirectory) return;
    for (const record of this.forks.values()) {
      if (!record.destroyed) await this.destroyFork({ fork_ref: record.ref, reason: 'adapter_dispose' });
    }
    for (const record of this.savepoints.values()) {
      if (!record.destroyed) await this.destroySavepoint({ savepoint_ref: record.ref });
    }
  }
}
