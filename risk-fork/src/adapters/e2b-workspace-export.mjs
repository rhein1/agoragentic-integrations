import { constants } from 'node:fs';
import {
  chmod,
  lstat,
  mkdir,
  open,
  readFile,
  readdir,
  realpath,
  rm,
} from 'node:fs/promises';
import path from 'node:path';

import { canonicalize, sha256Ref } from '../canonical.mjs';
import {
  boundedInteger,
  cloneJson,
  deepFreeze,
  normalizeRelativePath,
  requireOpaqueRef,
  requireSha256Ref,
  requireString,
  safeEqual,
} from '../util.mjs';

const EXPORT_SCHEMA = 'agoragentic.risk-fork.immutable-workspace-export.v1';
const SECRET_PATH_PATTERN = /(?:^|\/)(?:\.env(?:\..*)?|\.aws|\.azure|\.config\/gcloud|\.docker\/config\.json|\.git-credentials|\.netrc|\.npmrc|\.pypirc|\.ssh|credentials?(?:\.[^/]*)?|id_(?:rsa|dsa|ecdsa|ed25519)(?:\.pub)?|private[_-]?key(?:\.[^/]*)?|secrets?(?:\.[^/]*)?|wallet(?:\.[^/]*)?)(?:$|\/)/i;
const SECRET_CONTENT_PATTERNS = Object.freeze([
  /-----BEGIN [A-Z ]*PRIVATE KEY-----/,
  /\bBearer\s+[A-Za-z0-9._~+/=-]{8,}/i,
  /\be2b_[A-Za-z0-9_-]{12,}/,
  /\bsk-[A-Za-z0-9_-]{16,}/,
  /\bAKIA[0-9A-Z]{16}\b/,
  /\bgh[pousr]_[A-Za-z0-9]{20,}\b/,
]);
const SECRET_ASSIGNMENT_KEY = String.raw`(?:api[_-]?key|access[_-]?token|refresh[_-]?token|authorization|credential|password|passphrase|private[_-]?key|client[_-]?secret|seed[_-]?phrase|mnemonic|wallet[_-]?(?:key|secret))`;
const SECRET_ASSIGNMENT_PATTERN = new RegExp(
  String.raw`(?:^|[^A-Za-z0-9_])(?:"${SECRET_ASSIGNMENT_KEY}"|'${SECRET_ASSIGNMENT_KEY}'|${SECRET_ASSIGNMENT_KEY})\s*[=:]\s*(?:"((?:\\[\s\S]|[^"\\])*)"|'((?:\\[\s\S]|[^'\\])*)'|([^&\s"',;}\]]+))`,
  'gi',
);
const MIN_SECRET_ASSIGNMENT_BYTES = 8;

function containsSecretAssignment(exactBytesText) {
  SECRET_ASSIGNMENT_PATTERN.lastIndex = 0;
  for (let match = SECRET_ASSIGNMENT_PATTERN.exec(exactBytesText);
    match;
    match = SECRET_ASSIGNMENT_PATTERN.exec(exactBytesText)) {
    const value = match[1] ?? match[2] ?? match[3] ?? '';
    if (value.length >= MIN_SECRET_ASSIGNMENT_BYTES) return true;
  }
  return false;
}

function requireExportId(value) {
  const exportId = requireOpaqueRef(value, 'workspace export id', { maxLength: 100 });
  if (!/^[A-Za-z0-9_-]+$/.test(exportId)) {
    throw new TypeError('workspace export id must contain only letters, numbers, underscore, or dash');
  }
  return exportId;
}

function ownedExportPath(exportRoot, exportId) {
  const root = path.resolve(requireString(exportRoot, 'workspace export root'));
  const target = path.resolve(root, requireExportId(exportId));
  if (target === root || !target.startsWith(`${root}${path.sep}`)) {
    throw new Error('workspace export path escapes its configured root');
  }
  return { root, target };
}

async function pathExists(target) {
  try {
    await lstat(target);
    return true;
  } catch (error) {
    if (error?.code === 'ENOENT') return false;
    throw error;
  }
}

function assertNoSecretMaterial(relative, content) {
  if (SECRET_PATH_PATTERN.test(relative)) {
    throw new Error(`Workspace export rejects credential or secret-shaped path: ${relative}`);
  }
  // Latin-1 preserves a one-code-unit-to-one-byte view of the exact bounded
  // buffer read through the stable file handle. Every marker below is ASCII,
  // so invalid UTF-8 cannot erase or merge bytes around a credential marker.
  const exactBytesText = content.toString('latin1');
  if (SECRET_CONTENT_PATTERNS.some((pattern) => pattern.test(exactBytesText))
    || containsSecretAssignment(exactBytesText)) {
    throw new Error(`Workspace export rejects authority or secret-shaped material: ${relative}`);
  }
}

function stableIdentity(info) {
  return {
    dev: typeof info.dev === 'bigint' ? info.dev.toString() : String(info.dev),
    ino: typeof info.ino === 'bigint' ? info.ino.toString() : String(info.ino),
    size: typeof info.size === 'bigint' ? info.size.toString() : String(info.size),
    mtime_ms: Number(info.mtimeMs),
  };
}

function assertWithinRealRoot(rootReal, candidateReal, field) {
  const relative = path.relative(rootReal, candidateReal);
  if (relative === '') return;
  if (relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw new Error(`${field} escapes the workspace root`);
  }
}

async function readStableFile(absolute, relative, rootReal, maxReadableBytes) {
  const before = await lstat(absolute, { bigint: true });
  if (before.isSymbolicLink()) throw new Error(`Symlinks are forbidden: ${relative}`);
  if (!before.isFile()) throw new Error(`Special filesystem entry is forbidden: ${relative}`);
  if (before.nlink > 1n) throw new Error(`Hard-linked files are forbidden: ${relative}`);
  const beforeReal = await realpath(absolute);
  assertWithinRealRoot(rootReal, beforeReal, `Workspace file ${relative}`);
  const noFollow = Number.isInteger(constants.O_NOFOLLOW) ? constants.O_NOFOLLOW : 0;
  let handle;
  try {
    handle = await open(absolute, constants.O_RDONLY | noFollow);
    const opened = await handle.stat({ bigint: true });
    if (!opened.isFile() || opened.nlink > 1n) {
      throw new Error(`Workspace entry changed type while exporting: ${relative}`);
    }
    if (opened.size > BigInt(maxReadableBytes)) {
      throw new Error(`Workspace exceeds its bounded byte allowance at ${relative}`);
    }
    if (JSON.stringify(stableIdentity(before)) !== JSON.stringify(stableIdentity(opened))) {
      throw new Error(`Workspace path changed while it was opened: ${relative}`);
    }
    const content = await handle.readFile();
    const after = await handle.stat({ bigint: true });
    if (JSON.stringify(stableIdentity(opened)) !== JSON.stringify(stableIdentity(after))) {
      throw new Error(`Workspace file changed while exporting: ${relative}`);
    }
    const currentPath = await lstat(absolute, { bigint: true });
    if (JSON.stringify(stableIdentity(before)) !== JSON.stringify(stableIdentity(currentPath))) {
      throw new Error(`Workspace path changed while exporting: ${relative}`);
    }
    const currentReal = await realpath(absolute);
    assertWithinRealRoot(rootReal, currentReal, `Workspace file ${relative}`);
    if (currentReal !== beforeReal) throw new Error(`Workspace path target changed: ${relative}`);
    assertNoSecretMaterial(relative, content);
    return content;
  } finally {
    await handle?.close().catch(() => {});
  }
}

async function enumerateWorkspace(root, { maxFiles, maxBytes, includeContent }) {
  const rootReal = await realpath(root);
  const records = [];
  const seenCaseFolded = new Map();
  let totalBytes = 0;

  async function visit(directory, prefix = '', rawPrefix = '') {
    const directoryBefore = await lstat(directory, { bigint: true });
    if (directoryBefore.isSymbolicLink() || !directoryBefore.isDirectory()) {
      throw new Error(`Workspace directory changed type: ${prefix || '.'}`);
    }
    const directoryReal = await realpath(directory);
    assertWithinRealRoot(rootReal, directoryReal, `Workspace directory ${prefix || '.'}`);
    const entries = await readdir(directory, { withFileTypes: true });
    entries.sort((left, right) => left.name.localeCompare(right.name));
    for (const entry of entries) {
      const rawRelative = rawPrefix ? `${rawPrefix}/${entry.name}` : entry.name;
      const relative = normalizeRelativePath(
        rawRelative,
        'workspace export path',
      );
      if (relative === '.git' || relative.startsWith('.git/')) {
        throw new Error('Workspace exports exclude .git metadata');
      }
      const folded = relative.normalize('NFC').toLocaleLowerCase('en-US');
      const collision = seenCaseFolded.get(folded);
      if (collision && collision.raw_relative !== rawRelative) {
        throw new Error(
          `Case or Unicode path collision: ${collision.raw_relative} and ${rawRelative}`,
        );
      }
      seenCaseFolded.set(folded, { raw_relative: rawRelative, normalized_relative: relative });
      const absolute = path.join(directory, entry.name);
      const info = await lstat(absolute, { bigint: true });
      if (info.isSymbolicLink()) throw new Error(`Symlinks are forbidden: ${relative}`);
      if (info.isDirectory()) {
        await visit(absolute, relative, rawRelative);
        continue;
      }
      if (!info.isFile()) throw new Error(`Special filesystem entry is forbidden: ${relative}`);
      if (info.nlink > 1n) throw new Error(`Hard-linked files are forbidden: ${relative}`);
      if (records.length + 1 > maxFiles) throw new Error(`Workspace exceeds ${maxFiles} files`);
      if (info.size > BigInt(maxBytes - totalBytes)) {
        throw new Error(`Workspace exceeds ${maxBytes} bytes`);
      }
      const content = await readStableFile(
        absolute,
        relative,
        rootReal,
        maxBytes - totalBytes,
      );
      totalBytes += content.byteLength;
      if (totalBytes > maxBytes) throw new Error(`Workspace exceeds ${maxBytes} bytes`);
      records.push({
        path: relative,
        bytes: content.byteLength,
        content_hash: sha256Ref(content.toString('base64')),
        ...(includeContent ? { content } : {}),
      });
    }
    const directoryAfter = await lstat(directory, { bigint: true });
    if (JSON.stringify(stableIdentity(directoryBefore))
      !== JSON.stringify(stableIdentity(directoryAfter))) {
      throw new Error(`Workspace directory changed while exporting: ${prefix || '.'}`);
    }
    const directoryRealAfter = await realpath(directory);
    assertWithinRealRoot(rootReal, directoryRealAfter, `Workspace directory ${prefix || '.'}`);
    if (directoryRealAfter !== directoryReal) {
      throw new Error(`Workspace directory target changed: ${prefix || '.'}`);
    }
  }

  await visit(root);
  const publicRecords = records.map(({ content: _content, ...record }) => record);
  return {
    records,
    public_records: publicRecords,
    file_count: publicRecords.length,
    total_bytes: totalBytes,
    workspace_digest: sha256Ref(publicRecords),
  };
}

async function writeExclusive(target, content, mode = 0o400) {
  const handle = await open(target, 'wx', mode);
  try {
    await handle.writeFile(content);
    await handle.sync();
  } finally {
    await handle.close();
  }
}

async function makeTreeReadOnly(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  for (const entry of entries) {
    const target = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      await makeTreeReadOnly(target);
      await chmod(target, 0o500);
    } else {
      await chmod(target, 0o400);
    }
  }
  await chmod(directory, 0o500);
}

async function makeTreeWritable(directory) {
  if (!(await pathExists(directory))) return;
  await chmod(directory, 0o700).catch(() => {});
  const entries = await readdir(directory, { withFileTypes: true }).catch(() => []);
  for (const entry of entries) {
    const target = path.join(directory, entry.name);
    if (entry.isDirectory()) await makeTreeWritable(target);
    else await chmod(target, 0o600).catch(() => {});
  }
}

function buildManifest(exportId, snapshot) {
  const manifest = {
    schema: EXPORT_SCHEMA,
    export_id: exportId,
    workspace_digest: snapshot.workspace_digest,
    file_count: snapshot.file_count,
    total_bytes: snapshot.total_bytes,
    files: cloneJson(snapshot.public_records),
    manifest_hash: null,
  };
  manifest.manifest_hash = sha256Ref({ ...manifest, manifest_hash: null });
  return manifest;
}

function validateManifest(manifest, expected = {}) {
  if (!manifest || manifest.schema !== EXPORT_SCHEMA) {
    throw new TypeError('Immutable workspace export manifest schema is invalid');
  }
  const exportId = requireExportId(manifest.export_id);
  const workspaceDigest = requireSha256Ref(manifest.workspace_digest, 'workspace export digest');
  const manifestHash = requireSha256Ref(manifest.manifest_hash, 'workspace export manifest hash');
  if (!Number.isSafeInteger(manifest.file_count) || manifest.file_count < 0) {
    throw new TypeError('workspace export file_count is invalid');
  }
  if (!Number.isSafeInteger(manifest.total_bytes) || manifest.total_bytes < 0) {
    throw new TypeError('workspace export total_bytes is invalid');
  }
  if (!Array.isArray(manifest.files) || manifest.files.length !== manifest.file_count) {
    throw new TypeError('workspace export manifest file list is invalid');
  }
  const expectedHash = sha256Ref({ ...cloneJson(manifest), manifest_hash: null });
  if (!safeEqual(expectedHash, manifestHash)) throw new Error('workspace export manifest hash mismatch');
  if (expected.exportId && exportId !== expected.exportId) {
    throw new Error('workspace export id mismatch');
  }
  if (expected.manifestHash && !safeEqual(manifestHash, expected.manifestHash)) {
    throw new Error('workspace export expected manifest hash mismatch');
  }
  if (expected.workspaceDigest && !safeEqual(workspaceDigest, expected.workspaceDigest)) {
    throw new Error('workspace export expected digest mismatch');
  }
  return manifest;
}

export function workspaceExportPath(exportRoot, exportId) {
  return ownedExportPath(exportRoot, exportId).target;
}

export async function createImmutableWorkspaceExport(input = {}) {
  const sourceWorkspace = path.resolve(requireString(input.source_workspace, 'source_workspace'));
  const sourceInfo = await lstat(sourceWorkspace);
  if (sourceInfo.isSymbolicLink() || !sourceInfo.isDirectory()) {
    throw new TypeError('source_workspace must be a real directory, not a symlink');
  }
  const sourceReal = await realpath(sourceWorkspace);
  const exportId = requireExportId(input.export_id);
  const { root, target } = ownedExportPath(input.export_root, exportId);
  await mkdir(root, { recursive: true, mode: 0o700 });
  const rootReal = await realpath(root);
  if (rootReal === sourceReal
    || rootReal.startsWith(`${sourceReal}${path.sep}`)
    || sourceReal.startsWith(`${rootReal}${path.sep}`)) {
    throw new Error('workspace source and export root must be disjoint');
  }
  if (await pathExists(target)) throw new Error(`Workspace export already exists: ${exportId}`);
  const maxFiles = boundedInteger(input.max_files ?? 2_000, 'max_files', {
    min: 1,
    max: 100_000,
  });
  const maxBytes = boundedInteger(input.max_bytes ?? 32 * 1024 * 1024, 'max_bytes', {
    min: 1,
    max: 1024 * 1024 * 1024,
  });
  const expectedWorkspaceDigest = requireSha256Ref(
    input.expected_workspace_digest,
    'expected_workspace_digest',
  );

  const source = await enumerateWorkspace(sourceWorkspace, {
    maxFiles,
    maxBytes,
    includeContent: true,
  });
  if (!safeEqual(source.workspace_digest, expectedWorkspaceDigest)) {
    throw new Error('Source workspace digest does not match the Savepoint Capsule');
  }

  const payloadDirectory = path.join(target, 'payload');
  let targetCreated = false;
  try {
    await mkdir(target, { mode: 0o700 });
    targetCreated = true;
    const targetReal = await realpath(target);
    assertWithinRealRoot(rootReal, targetReal, 'Workspace export target');
    await mkdir(payloadDirectory, { mode: 0o700 });
    for (const record of source.records) {
      const destination = path.join(payloadDirectory, ...record.path.split('/'));
      await mkdir(path.dirname(destination), { recursive: true, mode: 0o700 });
      await writeExclusive(destination, record.content);
    }
    const copied = await enumerateWorkspace(payloadDirectory, {
      maxFiles,
      maxBytes,
      includeContent: false,
    });
    if (!safeEqual(copied.workspace_digest, source.workspace_digest)
      || canonicalize(copied.public_records) !== canonicalize(source.public_records)) {
      throw new Error('Immutable workspace export changed while it was copied');
    }
    // `source.records` contains the bounded bytes read through stable file
    // handles. From this point onward, neither verification nor upload reopens
    // mutable source paths; both operate on this exact staged copy.
    const manifest = buildManifest(exportId, copied);
    await writeExclusive(path.join(target, 'manifest.json'), `${canonicalize(manifest)}\n`);
    await makeTreeReadOnly(target);
    return deepFreeze({
      export_id: exportId,
      export_ref: `e2b-workspace-export:${exportId}`,
      export_directory: target,
      payload_directory: payloadDirectory,
      workspace_digest: manifest.workspace_digest,
      manifest_hash: manifest.manifest_hash,
      file_count: manifest.file_count,
      total_bytes: manifest.total_bytes,
      files: cloneJson(manifest.files),
    });
  } catch (error) {
    if (targetCreated) {
      await makeTreeWritable(target).catch(() => {});
      await rm(target, { recursive: true, force: true }).catch(() => {});
    }
    throw error;
  }
}

export async function readImmutableWorkspaceExport(input = {}) {
  const exportId = requireExportId(input.export_id);
  const { target } = ownedExportPath(input.export_root, exportId);
  const manifest = validateManifest(
    JSON.parse(await readFile(path.join(target, 'manifest.json'), 'utf8')),
    {
      exportId,
      manifestHash: input.manifest_hash,
      workspaceDigest: input.workspace_digest,
    },
  );
  const payloadDirectory = path.join(target, 'payload');
  const current = await enumerateWorkspace(payloadDirectory, {
    maxFiles: Math.max(1, manifest.file_count),
    maxBytes: Math.max(1, manifest.total_bytes),
    includeContent: true,
  });
  if (!safeEqual(current.workspace_digest, manifest.workspace_digest)
    || canonicalize(current.public_records) !== canonicalize(manifest.files)) {
    throw new Error('Immutable workspace export no longer matches its manifest');
  }
  return deepFreeze({
    manifest: cloneJson(manifest),
    files: current.records.map((record) => ({
      path: record.path,
      bytes: record.bytes,
      content_hash: record.content_hash,
      data_base64: record.content.toString('base64'),
    })),
  });
}

export async function destroyImmutableWorkspaceExport(input = {}) {
  const { target } = ownedExportPath(input.export_root, input.export_id);
  await makeTreeWritable(target);
  await rm(target, { recursive: true, force: true });
  return { status: 'destroy_requested_observed' };
}

export async function verifyImmutableWorkspaceExportDestroyed(input = {}) {
  const { target } = ownedExportPath(input.export_root, input.export_id);
  return !(await pathExists(target));
}

export const E2B_IMMUTABLE_WORKSPACE_EXPORT_SCHEMA = EXPORT_SCHEMA;
