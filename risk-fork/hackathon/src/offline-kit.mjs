import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  chmod,
  copyFile,
  lstat,
  mkdir,
  open,
  readFile,
  readdir,
  realpath,
  rename,
  rm,
  stat,
  writeFile,
} from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { promisify, TextDecoder } from 'node:util';

import { GENERATED_NOT_CLIENT_VERIFIED_STATUS } from './config-generator.mjs';

const execFileAsync = promisify(execFile);
const UTF8_FATAL = new TextDecoder('utf-8', { fatal: true });

export const OFFLINE_KIT_BANNER =
  'DEMO ONLY — LOCAL PROTOCOL SIMULATOR — NOT AN ISOLATION BOUNDARY — NO LIVE PROTECTION';

export const OFFLINE_KIT_TRUTH = Object.freeze({
  demo_only: true,
  local_protocol_simulator: true,
  production_ready: false,
  live_traffic_protected: false,
  authority_granted: false,
  provider_calls: 0,
  network_used: false,
  credentials_used: false,
  clean_commit_performed: false,
});

const PORTABLE_CONFIGURATION_VERIFICATION_DETAIL =
  'generated_portable_template_requires_path_regeneration_and_live_client_verification';

export const OFFLINE_KIT_LIMITS = Object.freeze({
  max_archive_bytes: 64 * 1024 * 1024,
  max_file_bytes: 8 * 1024 * 1024,
  max_files: 4096,
  max_path_bytes: 1024,
  max_segment_bytes: 255,
});

const MANIFEST_NAME = 'MANIFEST.json';
const DEPENDENCY_PROVENANCE_NAME = 'DEPENDENCY_PROVENANCE.json';
const BUILD_OWNER_NAME = '.risk-fork-offline-kit-owner.json';
const EXTRACTION_OWNER_SUFFIX = '.risk-fork-extraction-owner.json';
const ZIP_UTF8_FLAG = 0x0800;
const ZIP_STORE_METHOD = 0;
const ZIP_DOS_TIME = 0;
const ZIP_DOS_DATE = 0x0021; // 1980-01-01, the earliest ZIP date.
const ZIP_UNIX_FILE_MODE = 0o100644;
const FIXED_CREATED_AT = '1980-01-01T00:00:00.000Z';

const REQUIRED_DEPENDENCIES = Object.freeze([
  'ajv',
  'ajv-formats',
  'fast-deep-equal',
  'fast-uri',
  'json-schema-traverse',
  'require-from-string',
]);
const OFFLINE_RUNTIME_ROOT_DEPENDENCIES = Object.freeze(['ajv', 'ajv-formats']);

const EXPECTED_SCENARIO_IDS = Object.freeze([
  'low-read-only',
  'elevated-owner-policy',
  'high-filesystem-write',
  'high-incomplete-metadata',
  'high-untrusted-discovery',
  'high-prompt-injection',
  'e2b-malicious-mcp-containment',
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

const REQUIRED_TREES = Object.freeze([
  ['risk-fork/src', 'risk-fork/src'],
  ['risk-fork/schema', 'risk-fork/schema'],
  ['risk-fork/e2b-template/lib', 'risk-fork/e2b-template/lib'],
  ['risk-fork/hackathon/bin', 'risk-fork/hackathon/bin'],
  ['risk-fork/hackathon/src', 'risk-fork/hackathon/src'],
  ['risk-fork/hackathon/scripts', 'risk-fork/hackathon/scripts'],
  ['risk-fork/hackathon/docs', 'risk-fork/hackathon/docs'],
  ['risk-fork/hackathon/recorder', 'risk-fork/hackathon/recorder'],
  ['risk-fork/hackathon/fixtures', 'risk-fork/hackathon/fixtures'],
]);

const REQUIRED_FILES = Object.freeze([
  ['risk-fork/package.json', 'risk-fork/package.json'],
  ['risk-fork/package-lock.json', 'risk-fork/package-lock.json'],
  ['risk-fork/LICENSE', 'risk-fork/LICENSE'],
  ['risk-fork/hackathon/package.json', 'risk-fork/hackathon/package.json'],
  ['risk-fork/hackathon/package-lock.json', 'risk-fork/hackathon/package-lock.json'],
  ['risk-fork/hackathon/README.md', 'risk-fork/hackathon/README.md'],
  ['risk-fork/hackathon/demo-status.json', 'risk-fork/hackathon/demo-status.json'],
]);

const WINDOWS_RESERVED_BASENAMES = /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\..*)?$/i;

function withTruth(value) {
  return Object.freeze({
    banner: OFFLINE_KIT_BANNER,
    ...OFFLINE_KIT_TRUTH,
    ...value,
  });
}

function sha256(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

function normalizeAbsolute(input, label) {
  if (typeof input !== 'string' || !path.isAbsolute(input)) {
    throw new TypeError(`${label} must be an absolute path`);
  }
  return path.resolve(input);
}

function comparisonPath(input) {
  const normalized = path.resolve(input).replaceAll('\\', '/').replace(/\/+$/, '');
  return process.platform === 'win32' ? normalized.toLowerCase() : normalized;
}

function isSameOrInside(parent, candidate) {
  const root = comparisonPath(parent);
  const target = comparisonPath(candidate);
  return target === root || target.startsWith(`${root}/`);
}

async function lstatOrNull(input) {
  try {
    return await lstat(input);
  } catch (error) {
    if (error?.code === 'ENOENT') return null;
    throw error;
  }
}

function rawPathCompare(left, right) {
  return Buffer.compare(Buffer.from(left, 'utf8'), Buffer.from(right, 'utf8'));
}

function stableValue(value, trail = 'value') {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return value;
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (Array.isArray(value)) return value.map((item, index) => stableValue(item, `${trail}[${index}]`));
  if (value && typeof value === 'object' && Object.getPrototypeOf(value) === Object.prototype) {
    return Object.fromEntries(
      Object.keys(value)
        .sort(rawPathCompare)
        .map((key) => [key, stableValue(value[key], `${trail}.${key}`)]),
    );
  }
  throw new TypeError(`${trail} must contain JSON-safe values only`);
}

function stableJson(value) {
  return `${JSON.stringify(stableValue(value), null, 2)}\n`;
}

function toArchivePath(input) {
  return input.split(path.sep).join('/');
}

export function assertSafeArchivePath(input) {
  if (typeof input !== 'string' || input.length === 0) {
    throw new Error('Archive entry path must be a non-empty string');
  }
  let decoded;
  try {
    const raw = Buffer.from(input, 'utf8');
    decoded = UTF8_FATAL.decode(raw);
    if (raw.length > OFFLINE_KIT_LIMITS.max_path_bytes) {
      throw new Error('Archive entry path is too long');
    }
  } catch (error) {
    throw new Error(`Archive entry path is not canonical UTF-8: ${error.message}`);
  }
  if (decoded !== input || decoded.normalize('NFC') !== decoded) {
    throw new Error('Archive entry path must use canonical NFC UTF-8');
  }
  if (decoded.includes('\\')) throw new Error('Archive entry path must not contain backslashes');
  if (decoded.includes(':')) throw new Error('Archive entry path must not contain colons');
  if (decoded.startsWith('/') || decoded.startsWith('//') || /^[a-z]:/i.test(decoded)) {
    throw new Error('Archive entry path must be relative');
  }
  if (/[\u0000-\u001f\u007f]/u.test(decoded)) {
    throw new Error('Archive entry path must not contain control characters');
  }
  const segments = decoded.split('/');
  if (segments.some((segment) => segment.length === 0 || segment === '.' || segment === '..')) {
    throw new Error('Archive entry path contains an empty or dot segment');
  }
  for (const segment of segments) {
    if (Buffer.byteLength(segment, 'utf8') > OFFLINE_KIT_LIMITS.max_segment_bytes) {
      throw new Error('Archive entry segment is too long');
    }
    if (/[ .]$/u.test(segment)) {
      throw new Error('Archive entry segment must not end in a dot or space');
    }
    if (WINDOWS_RESERVED_BASENAMES.test(segment)) {
      throw new Error(`Archive entry uses reserved filename: ${segment}`);
    }
  }
  return decoded;
}

export function validateArchiveEntryNames(names) {
  if (!Array.isArray(names)) throw new TypeError('Archive entry names must be an array');
  const exact = new Set();
  const aliases = new Map();
  for (const candidate of names) {
    const name = assertSafeArchivePath(candidate);
    if (exact.has(name)) throw new Error(`Duplicate archive entry: ${name}`);
    exact.add(name);
    const alias = name.normalize('NFC').toLocaleLowerCase('en-US');
    const previous = aliases.get(alias);
    if (previous) throw new Error(`Case or Unicode archive path collision: ${previous} and ${name}`);
    aliases.set(alias, name);
  }
  return [...exact].sort(rawPathCompare);
}

function directoriesForFiles(files) {
  const result = new Set();
  for (const file of files) {
    const segments = file.split('/');
    for (let index = 1; index < segments.length; index += 1) {
      result.add(segments.slice(0, index).join('/'));
    }
  }
  return [...result].sort(rawPathCompare);
}

function assertRegularFile(fileStat, label) {
  if (!fileStat.isFile() || fileStat.isSymbolicLink()) {
    throw new Error(`${label} must be a regular file`);
  }
  if (fileStat.nlink !== 1) throw new Error(`${label} must not be hard linked`);
  if (fileStat.size > OFFLINE_KIT_LIMITS.max_file_bytes) {
    throw new Error(`${label} exceeds the per-file size limit`);
  }
}

async function enumerateTree(root, { includeBytes = false } = {}) {
  const absoluteRoot = normalizeAbsolute(root, 'Tree root');
  const rootStat = await lstat(absoluteRoot);
  if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) {
    throw new Error('Tree root must be a real directory');
  }
  const files = [];
  const directories = [];
  const visit = async (absoluteDirectory, relativeDirectory = '') => {
    const entries = await readdir(absoluteDirectory, { withFileTypes: true });
    entries.sort((left, right) => rawPathCompare(left.name, right.name));
    for (const entry of entries) {
      const relative = relativeDirectory
        ? `${relativeDirectory}/${entry.name}`
        : entry.name;
      assertSafeArchivePath(relative);
      const absolute = path.join(absoluteDirectory, entry.name);
      const entryStat = await lstat(absolute);
      if (entryStat.isSymbolicLink()) throw new Error(`Links are forbidden in offline kits: ${relative}`);
      if (entryStat.isDirectory()) {
        directories.push(relative);
        await visit(absolute, relative);
      } else if (entryStat.isFile()) {
        assertRegularFile(entryStat, relative);
        const record = {
          path: relative,
          absolute_path: absolute,
          bytes: entryStat.size,
        };
        if (includeBytes) record.content = await readFile(absolute);
        files.push(record);
      } else {
        throw new Error(`Special filesystem entry is forbidden: ${relative}`);
      }
      if (files.length > OFFLINE_KIT_LIMITS.max_files) {
        throw new Error('Offline kit exceeds the file-count limit');
      }
    }
  };
  await visit(absoluteRoot);
  validateArchiveEntryNames(files.map((item) => item.path));
  validateArchiveEntryNames(directories);
  const totalBytes = files.reduce((sum, item) => sum + item.bytes, 0);
  if (totalBytes > OFFLINE_KIT_LIMITS.max_archive_bytes) {
    throw new Error('Offline kit exceeds the total-byte limit');
  }
  return {
    root: absoluteRoot,
    files: files.sort((left, right) => rawPathCompare(left.path, right.path)),
    directories: directories.sort(rawPathCompare),
    total_bytes: totalBytes,
  };
}

function isProbablyText(bytes) {
  if (bytes.includes(0)) return false;
  try {
    UTF8_FATAL.decode(bytes);
    return true;
  } catch {
    return false;
  }
}

function assertNoSensitiveBytes(bytes, relativePath, forbiddenPaths = []) {
  if (!isProbablyText(bytes)) return;
  const text = UTF8_FATAL.decode(bytes);
  const lower = text.toLowerCase();
  const forbidden = [
    /-----begin (?:rsa |ec |openssh )?private key-----/i,
    /\bAKIA[0-9A-Z]{16}\b/,
    /\bgh[opsu]_[A-Za-z0-9]{20,}\b/,
    /\bgithub_pat_[A-Za-z0-9_]{20,}\b/,
    /\b(?:postgres(?:ql)?|mysql):\/\/[^\s:@/]+:[^\s@/]+@/i,
    /\b(?:E2B_API_KEY|AWS_SECRET_ACCESS_KEY|DATABASE_URL)\s*=\s*['"]?(?!<|\$|example|redacted|unset)[^\s'";]{8,}/i,
    /(?:^|["'`\s])(?:[a-z]:\\Users\\|\/Users\/|\/home\/|\/root\/)[^\s"'`]*/i,
  ];
  for (const pattern of forbidden) {
    if (pattern.test(text)) throw new Error(`Sensitive or private material detected in ${relativePath}`);
  }
  for (const candidate of forbiddenPaths) {
    if (typeof candidate !== 'string' || candidate.length < 4) continue;
    const variants = [candidate, candidate.replaceAll('\\', '/'), candidate.replaceAll('/', '\\')];
    if (variants.some((value) => lower.includes(value.toLowerCase()))) {
      throw new Error(`Build-machine path detected in ${relativePath}`);
    }
  }
}

async function assertNoGitAncestor(candidate) {
  let cursor = path.resolve(candidate);
  while (!(await lstatOrNull(cursor))) {
    const parent = path.dirname(cursor);
    if (parent === cursor) break;
    cursor = parent;
  }
  while (true) {
    if (await lstatOrNull(path.join(cursor, '.git'))) {
      throw new Error('Offline-kit output must be outside a Git repository');
    }
    const parent = path.dirname(cursor);
    if (parent === cursor) break;
    cursor = parent;
  }
}

async function assertPinnedCleanRepository(repositoryRoot, sourceCommit) {
  if (!/^[0-9a-f]{40}$/.test(sourceCommit)) {
    throw new TypeError('sourceCommit must be an exact lowercase 40-character Git SHA');
  }
  const root = await realpath(normalizeAbsolute(repositoryRoot, 'repositoryRoot'));
  const { stdout: topLevel } = await execFileAsync('git', ['rev-parse', '--show-toplevel'], {
    cwd: root,
    windowsHide: true,
  });
  const resolvedTop = await realpath(topLevel.trim());
  if (comparisonPath(resolvedTop) !== comparisonPath(root)) {
    throw new Error('repositoryRoot must be the Git worktree root');
  }
  const { stdout: head } = await execFileAsync('git', ['rev-parse', 'HEAD'], {
    cwd: root,
    windowsHide: true,
  });
  if (head.trim() !== sourceCommit) {
    throw new Error(`Repository HEAD ${head.trim()} does not match sourceCommit ${sourceCommit}`);
  }
  const { stdout: statusOutput } = await execFileAsync(
    'git',
    ['status', '--porcelain=v1', '--untracked-files=all', '--', 'risk-fork'],
    { cwd: root, windowsHide: true },
  );
  if (statusOutput.trim()) {
    throw new Error('Risk Fork source tree must be clean before building a commit-pinned kit');
  }
  return root;
}

async function copyRegularFile(source, destination) {
  const sourceStat = await lstat(source);
  assertRegularFile(sourceStat, source);
  await mkdir(path.dirname(destination), { recursive: true, mode: 0o755 });
  await copyFile(source, destination, 1); // COPYFILE_EXCL
  await chmod(destination, 0o644);
  const copiedStat = await lstat(destination);
  assertRegularFile(copiedStat, destination);
  if (copiedStat.size !== sourceStat.size) throw new Error(`Copy size mismatch for ${source}`);
}

async function writeRegularBytes(destination, bytes) {
  if (!Buffer.isBuffer(bytes)) throw new TypeError('Git blob bytes must be a Buffer');
  if (bytes.length > OFFLINE_KIT_LIMITS.max_file_bytes) {
    throw new Error(`Committed source file exceeds the offline-kit file limit: ${destination}`);
  }
  await mkdir(path.dirname(destination), { recursive: true, mode: 0o755 });
  await writeFile(destination, bytes, { flag: 'wx', mode: 0o644 });
  await chmod(destination, 0o644);
  const copiedStat = await lstat(destination);
  assertRegularFile(copiedStat, destination);
  if (copiedStat.size !== bytes.length) {
    throw new Error(`Committed Git blob copy size mismatch: ${destination}`);
  }
}

async function readCommittedTreeEntries(repositoryRoot, sourceCommit, pathspec) {
  const { stdout } = await execFileAsync(
    'git',
    ['ls-tree', '-r', '-z', sourceCommit, '--', pathspec],
    {
      cwd: repositoryRoot,
      windowsHide: true,
      encoding: 'buffer',
      maxBuffer: OFFLINE_KIT_LIMITS.max_archive_bytes,
    },
  );
  const records = UTF8_FATAL.decode(stdout).split('\0').filter(Boolean);
  return records.map((record) => {
    const match = /^([0-7]{6}) (blob|commit) ([0-9a-f]{40})\t(.+)$/.exec(record);
    if (!match) throw new Error('Committed source tree contains an unsupported Git entry');
    const [, mode, type, objectId, relative] = match;
    const safeRelative = assertSafeArchivePath(relative);
    if (type !== 'blob' || !['100644', '100755'].includes(mode)) {
      throw new Error(`Committed source entry is not a regular blob: ${safeRelative}`);
    }
    return Object.freeze({ mode, object_id: objectId, path: safeRelative });
  });
}

async function copyCommittedBlob(repositoryRoot, entry, destination) {
  const { stdout } = await execFileAsync('git', ['cat-file', 'blob', entry.object_id], {
    cwd: repositoryRoot,
    windowsHide: true,
    encoding: 'buffer',
    maxBuffer: OFFLINE_KIT_LIMITS.max_file_bytes + 1,
  });
  await writeRegularBytes(destination, stdout);
}

async function copyPinnedSource({ repositoryRoot, sourceCommit, destinationRoot }) {
  const destinations = new Set();
  let copiedFiles = 0;
  for (const [sourceRelative, destinationRelative] of REQUIRED_TREES) {
    const entries = await readCommittedTreeEntries(repositoryRoot, sourceCommit, sourceRelative);
    if (entries.length === 0) {
      throw new Error(`Required committed source tree is empty or missing: ${sourceRelative}`);
    }
    for (const entry of entries) {
      const prefix = `${sourceRelative}/`;
      if (!entry.path.startsWith(prefix)) {
        throw new Error(`Committed source escaped required tree: ${entry.path}`);
      }
      const suffix = entry.path.slice(prefix.length);
      const destination = assertSafeArchivePath(`${destinationRelative}/${suffix}`);
      if (destinations.has(destination)) {
        throw new Error(`Committed source destination is duplicated: ${destination}`);
      }
      destinations.add(destination);
      await copyCommittedBlob(
        repositoryRoot,
        entry,
        path.join(destinationRoot, ...destination.split('/')),
      );
      copiedFiles += 1;
    }
  }
  for (const [sourceRelative, destinationRelative] of REQUIRED_FILES) {
    const entries = await readCommittedTreeEntries(repositoryRoot, sourceCommit, sourceRelative);
    if (entries.length !== 1 || entries[0].path !== sourceRelative) {
      throw new Error(`Required committed source file is missing or ambiguous: ${sourceRelative}`);
    }
    const destination = assertSafeArchivePath(destinationRelative);
    if (destinations.has(destination)) {
      throw new Error(`Committed source destination is duplicated: ${destination}`);
    }
    destinations.add(destination);
    await copyCommittedBlob(
      repositoryRoot,
      entries[0],
      path.join(destinationRoot, ...destination.split('/')),
    );
    copiedFiles += 1;
  }
  return Object.freeze({
    schema: 'agoragentic.risk-fork.offline-kit-committed-source-copy.v1',
    source_commit: sourceCommit,
    source_materialization: 'exact_git_blobs',
    ignored_worktree_files_included: false,
    copied_files: copiedFiles,
  });
}

async function copyCuratedTree(sourceRoot, destinationRoot) {
  const sourceStat = await lstat(sourceRoot);
  if (!sourceStat.isDirectory() || sourceStat.isSymbolicLink()) {
    throw new Error(`Required source directory is not a real directory: ${sourceRoot}`);
  }
  await mkdir(destinationRoot, { recursive: true, mode: 0o755 });
  const entries = await readdir(sourceRoot, { withFileTypes: true });
  entries.sort((left, right) => rawPathCompare(left.name, right.name));
  for (const entry of entries) {
    const source = path.join(sourceRoot, entry.name);
    const destination = path.join(destinationRoot, entry.name);
    const sourceEntryStat = await lstat(source);
    if (sourceEntryStat.isSymbolicLink()) {
      throw new Error(`Source links are forbidden: ${source}`);
    }
    if (sourceEntryStat.isDirectory()) {
      await copyCuratedTree(source, destination);
    } else if (sourceEntryStat.isFile()) {
      await copyRegularFile(source, destination);
    } else {
      throw new Error(`Source special file is forbidden: ${source}`);
    }
  }
}

function parseLockedDependencyPlan(lockBytes) {
  let lock;
  try {
    lock = JSON.parse(UTF8_FATAL.decode(lockBytes));
  } catch {
    throw new Error('Risk Fork package lock is not valid UTF-8 JSON');
  }
  if (lock?.lockfileVersion !== 3 || !lock.packages || typeof lock.packages !== 'object') {
    throw new Error('Risk Fork package lock must use the exact lockfile v3 package inventory');
  }
  const closure = new Set(OFFLINE_RUNTIME_ROOT_DEPENDENCIES);
  const pending = [...OFFLINE_RUNTIME_ROOT_DEPENDENCIES];
  while (pending.length > 0) {
    const name = pending.shift();
    const entry = lock.packages[`node_modules/${name}`];
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
      throw new Error(`Package lock does not pin required offline dependency ${name}`);
    }
    for (const dependency of Object.keys(entry.dependencies ?? {}).sort(rawPathCompare)) {
      if (!closure.has(dependency)) {
        closure.add(dependency);
        pending.push(dependency);
      }
    }
  }
  const orderedClosure = [...closure].sort(rawPathCompare);
  const expectedClosure = [...REQUIRED_DEPENDENCIES].sort(rawPathCompare);
  if (canonicalizeArray(orderedClosure) !== canonicalizeArray(expectedClosure)) {
    throw new Error('Risk Fork offline dependency closure drifted from the reviewed allowlist');
  }
  const rootDependencies = lock.packages['']?.dependencies ?? {};
  const packages = REQUIRED_DEPENDENCIES.map((name) => {
    const entry = lock.packages[`node_modules/${name}`];
    if (!entry
      || typeof entry.version !== 'string'
      || typeof entry.resolved !== 'string'
      || typeof entry.integrity !== 'string'
      || entry.link === true
      || entry.hasInstallScript === true) {
      throw new Error(`Locked dependency ${name} lacks immutable no-script provenance`);
    }
    let resolved;
    try {
      resolved = new URL(entry.resolved);
    } catch {
      throw new Error(`Locked dependency ${name} has an invalid registry URL`);
    }
    if (resolved.protocol !== 'https:' || resolved.hostname !== 'registry.npmjs.org') {
      throw new Error(`Locked dependency ${name} is not pinned to the npm registry`);
    }
    const integrityMatch = /^sha512-([A-Za-z0-9+/]+={0,2})$/.exec(entry.integrity);
    if (!integrityMatch) {
      throw new Error(`Locked dependency ${name} does not have SHA-512 integrity`);
    }
    const digest = Buffer.from(integrityMatch[1], 'base64');
    if (digest.length !== 64 || digest.toString('base64') !== integrityMatch[1]) {
      throw new Error(`Locked dependency ${name} has noncanonical SHA-512 integrity`);
    }
    if (OFFLINE_RUNTIME_ROOT_DEPENDENCIES.includes(name)
      && rootDependencies[name] !== entry.version) {
      throw new Error(`Root dependency ${name} does not exactly match its lock entry`);
    }
    return Object.freeze({
      name,
      version: entry.version,
      resolved: entry.resolved,
      integrity: entry.integrity,
    });
  });
  return Object.freeze({
    lock_sha256: sha256(lockBytes),
    packages: Object.freeze(packages),
  });
}

function canonicalizeArray(value) {
  return JSON.stringify(value);
}

async function resolveNpmCli() {
  const candidates = [
    process.env.npm_execpath,
    path.join(path.dirname(process.execPath), 'node_modules/npm/bin/npm-cli.js'),
    path.resolve(path.dirname(process.execPath), '../lib/node_modules/npm/bin/npm-cli.js'),
  ].filter((value) => typeof value === 'string' && path.isAbsolute(value));
  for (const candidate of candidates) {
    const resolved = await realpath(candidate).catch(() => null);
    if (!resolved) continue;
    const info = await lstat(resolved);
    if (info.isFile() && !info.isSymbolicLink() && info.nlink === 1) return resolved;
  }
  throw new Error('A canonical local npm CLI is required for offline dependency reification');
}

async function resolveNpmCache(explicitCache) {
  const configured = explicitCache
    ?? process.env.npm_config_cache
    ?? (process.platform === 'win32'
      ? (process.env.LOCALAPPDATA
        ? path.join(process.env.LOCALAPPDATA, 'npm-cache')
        : null)
      : (process.env.HOME ? path.join(process.env.HOME, '.npm') : null));
  if (typeof configured !== 'string' || !path.isAbsolute(configured)) {
    throw new Error('An absolute local npm cache is required for offline dependency reification');
  }
  const resolved = await realpath(configured);
  const info = await lstat(resolved);
  if (!info.isDirectory() || info.isSymbolicLink()) {
    throw new Error('The offline npm cache must be a canonical real directory');
  }
  return resolved;
}

async function dependencyTreeEvidence(packageRoot) {
  const tree = await enumerateTree(packageRoot, { includeBytes: true });
  const files = tree.files.map((entry) => ({
    path: entry.path,
    bytes: entry.bytes,
    sha256: sha256(entry.content),
  }));
  return Object.freeze({
    tree_sha256: sha256(Buffer.from(stableJson(files), 'utf8')),
    file_count: files.length,
    total_bytes: tree.total_bytes,
  });
}

async function materializeLockedDependenciesOffline({
  repositoryRoot,
  stageContainer,
  npmCacheDirectory = null,
}) {
  const lockSource = path.join(repositoryRoot, 'risk-fork/package-lock.json');
  const packageSource = path.join(repositoryRoot, 'risk-fork/package.json');
  const lockBytes = await readFile(lockSource);
  const plan = parseLockedDependencyPlan(lockBytes);
  const reificationRoot = path.join(stageContainer, '.dependency-reification');
  await mkdir(reificationRoot, { mode: 0o700 });
  await copyRegularFile(packageSource, path.join(reificationRoot, 'package.json'));
  await copyRegularFile(lockSource, path.join(reificationRoot, 'package-lock.json'));
  const emptyNpmConfig = path.join(reificationRoot, '.npmrc');
  const emptyGlobalNpmConfig = path.join(reificationRoot, '.npmrc-global');
  await writeFile(emptyNpmConfig, '', { flag: 'wx', mode: 0o600 });
  await writeFile(emptyGlobalNpmConfig, '', { flag: 'wx', mode: 0o600 });
  const npmCli = await resolveNpmCli();
  const npmCache = await resolveNpmCache(npmCacheDirectory);
  const networkGuard = path.join(
    repositoryRoot,
    'risk-fork/hackathon/scripts/network-guard.mjs',
  );
  const childEnvironment = Object.fromEntries(Object.entries({
    SystemRoot: process.env.SystemRoot,
    WINDIR: process.env.WINDIR,
    ComSpec: process.env.ComSpec,
    TEMP: process.env.TEMP,
    TMP: process.env.TMP,
    npm_config_cache: npmCache,
    npm_config_userconfig: emptyNpmConfig,
    npm_config_globalconfig: emptyGlobalNpmConfig,
    npm_config_offline: 'true',
    npm_config_ignore_scripts: 'true',
    npm_config_audit: 'false',
    npm_config_fund: 'false',
    npm_config_update_notifier: 'false',
    npm_config_loglevel: 'error',
    RISK_FORK_DEMO_ALLOW_LOOPBACK: '0',
  }).filter(([, value]) => typeof value === 'string' && value.length > 0));
  try {
    await execFileAsync(process.execPath, [
      '--import',
      pathToFileURL(networkGuard).href,
      npmCli,
      'ci',
      '--offline',
      '--ignore-scripts',
      '--no-audit',
      '--no-fund',
      '--omit=dev',
      '--omit=optional',
      '--omit=peer',
      '--install-strategy=hoisted',
      '--no-bin-links',
    ], {
      cwd: reificationRoot,
      env: childEnvironment,
      windowsHide: true,
      timeout: 120_000,
      maxBuffer: 1024 * 1024,
    });
  } catch (error) {
    const npmDetail = String(error?.stderr ?? error?.message ?? 'unknown npm failure')
      .replaceAll(reificationRoot, '<owned-reification>')
      .replaceAll(npmCache, '<local-npm-cache>')
      .trim()
      .slice(0, 2_048);
    throw new Error(`Offline npm lock-integrity reification failed closed: ${npmDetail}`);
  }
  const reifiedLockBytes = await readFile(path.join(reificationRoot, 'package-lock.json'));
  if (!lockBytes.equals(reifiedLockBytes)) {
    throw new Error('Offline dependency reification changed the committed package lock');
  }
  const dependencies = [];
  for (const locked of plan.packages) {
    const packageRoot = path.join(reificationRoot, 'node_modules', ...locked.name.split('/'));
    const packageJson = JSON.parse(await readFile(path.join(packageRoot, 'package.json'), 'utf8'));
    if (packageJson.name !== locked.name || packageJson.version !== locked.version) {
      throw new Error(`Reified dependency ${locked.name} does not match the exact package lock`);
    }
    const tree = await dependencyTreeEvidence(packageRoot);
    dependencies.push(Object.freeze({
      ...locked,
      license: typeof packageJson.license === 'string' ? packageJson.license : 'SEE_PACKAGE',
      root: packageRoot,
      ...tree,
    }));
  }
  return Object.freeze({
    reification_root: reificationRoot,
    dependencies: Object.freeze(dependencies),
    provenance: Object.freeze({
      schema: 'agoragentic.risk-fork.offline-dependency-provenance.v1',
      materialization: 'npm_ci_offline_from_lock_cache',
      lockfile: 'risk-fork/package-lock.json',
      lockfile_sha256: plan.lock_sha256,
      source_node_modules_used: false,
      network_used: false,
      install_scripts_executed: false,
      packages: Object.freeze(dependencies.map((item) => Object.freeze({
        name: item.name,
        version: item.version,
        resolved: item.resolved,
        integrity: item.integrity,
        tree_sha256: item.tree_sha256,
        file_count: item.file_count,
        total_bytes: item.total_bytes,
      }))),
    }),
  });
}

async function validateFixtureCatalog(repositoryRoot) {
  const catalogPath = path.join(repositoryRoot, 'risk-fork/hackathon/fixtures/catalog.json');
  const catalog = JSON.parse(await readFile(catalogPath, 'utf8'));
  if (
    catalog?.schema !== 'agoragentic.risk-fork.hackathon-fixture-catalog.v1'
    || catalog.banner !== OFFLINE_KIT_BANNER
    || catalog.synthetic_only !== true
    || catalog.arbitrary_input_allowed !== false
    || !Array.isArray(catalog.scenario_ids)
  ) {
    throw new Error('Hackathon fixture catalog truth boundary is invalid');
  }
  const scenariosModule = await import(pathToFileURL(
    path.join(repositoryRoot, 'risk-fork/hackathon/src/scenarios.mjs'),
  ).href);
  const exported = [...scenariosModule.SCENARIO_IDS];
  for (const [label, values] of [
    ['catalog', catalog.scenario_ids],
    ['SCENARIO_IDS', exported],
  ]) {
    if (
      values.length !== EXPECTED_SCENARIO_IDS.length
      || values.some((value, index) => value !== EXPECTED_SCENARIO_IDS[index])
    ) {
      throw new Error(`${label} drifted from the exact ordered synthetic scenario allowlist`);
    }
  }
  return catalog;
}

function portableConfigContent(client) {
  const entrypoint = '__RISK_FORK_DEMO_ABSOLUTE_ENTRYPOINT__';
  if (client === 'codex') {
    return [
      `# ${OFFLINE_KIT_BANNER}`,
      `# verification_status = "${GENERATED_NOT_CLIENT_VERIFIED_STATUS}"`,
      `# verification_detail = "${PORTABLE_CONFIGURATION_VERIFICATION_DETAIL}"`,
      '# Replace the placeholder after extraction, or run: node ./risk-fork/hackathon/bin/risk-fork-demo.mjs config --client codex',
      '[mcp_servers.risk_fork_demo]',
      'command = "node"',
      `args = ["${entrypoint}", "mcp"]`,
      'enabled = true',
      'required = false',
      'default_tools_approval_mode = "prompt"',
      '',
    ].join('\n');
  }
  return `${JSON.stringify({
    _risk_fork_demo_notice: OFFLINE_KIT_BANNER,
    _verification_status: GENERATED_NOT_CLIENT_VERIFIED_STATUS,
    _verification_detail: PORTABLE_CONFIGURATION_VERIFICATION_DETAIL,
    _after_extraction: `Replace ${entrypoint} or run the local config command`,
    mcpServers: {
      risk_fork_demo: {
        command: 'node',
        args: [entrypoint, 'mcp'],
      },
    },
  }, null, 2)}\n`;
}

async function writePortableConfigurations(kitRoot, generatedConfigurations = null) {
  const requestedClients = generatedConfigurations == null
    ? ['generic', 'codex', 'claude', 'cursor']
    : generatedConfigurations.map((configuration) => configuration?.client);
  const allowed = new Set(['generic', 'codex', 'claude', 'cursor']);
  const clients = [...new Set(requestedClients)];
  if (clients.length === 0 || clients.length > 16 || clients.some((client) => !allowed.has(client))) {
    throw new TypeError('generatedConfigurations must identify supported demo clients');
  }
  const configRoot = path.join(kitRoot, 'risk-fork/hackathon/configs');
  await mkdir(configRoot, { recursive: true, mode: 0o755 });
  const records = [];
  for (const client of clients.sort(rawPathCompare)) {
    const extension = client === 'codex' ? 'toml' : 'json';
    const filename = `${client}-risk-fork-demo.${extension}.template`;
    const content = portableConfigContent(client);
    await writeFile(path.join(configRoot, filename), content, {
      encoding: 'utf8',
      flag: 'wx',
      mode: 0o644,
    });
    records.push({
      client,
      file: `risk-fork/hackathon/configs/${filename}`,
      verification_status: GENERATED_NOT_CLIENT_VERIFIED_STATUS,
      verification_detail: PORTABLE_CONFIGURATION_VERIFICATION_DETAIL,
    });
  }
  const index = {
    schema: 'agoragentic.risk-fork.demo-portable-config-index.v1',
    banner: OFFLINE_KIT_BANNER,
    ...OFFLINE_KIT_TRUTH,
    absolute_entrypoint_placeholder: '__RISK_FORK_DEMO_ABSOLUTE_ENTRYPOINT__',
    configuration_generation_required_after_extraction: true,
    records,
  };
  await writeFile(path.join(configRoot, 'configuration-index.json'), stableJson(index), {
    encoding: 'utf8',
    flag: 'wx',
    mode: 0o644,
  });
  return records;
}

const CRC32_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let index = 0; index < 256; index += 1) {
    let value = index;
    for (let bit = 0; bit < 8; bit += 1) {
      value = (value & 1) === 1 ? (0xedb88320 ^ (value >>> 1)) : (value >>> 1);
    }
    table[index] = value >>> 0;
  }
  return table;
})();

function crc32(bytes) {
  let value = 0xffffffff;
  for (const byte of bytes) value = CRC32_TABLE[(value ^ byte) & 0xff] ^ (value >>> 8);
  return (value ^ 0xffffffff) >>> 0;
}

function localFileRecord(nameBytes, content, checksum) {
  const header = Buffer.alloc(30);
  header.writeUInt32LE(0x04034b50, 0);
  header.writeUInt16LE(20, 4);
  header.writeUInt16LE(ZIP_UTF8_FLAG, 6);
  header.writeUInt16LE(ZIP_STORE_METHOD, 8);
  header.writeUInt16LE(ZIP_DOS_TIME, 10);
  header.writeUInt16LE(ZIP_DOS_DATE, 12);
  header.writeUInt32LE(checksum, 14);
  header.writeUInt32LE(content.length, 18);
  header.writeUInt32LE(content.length, 22);
  header.writeUInt16LE(nameBytes.length, 26);
  header.writeUInt16LE(0, 28);
  return Buffer.concat([header, nameBytes, content]);
}

function centralDirectoryRecord(nameBytes, contentLength, checksum, localOffset) {
  const header = Buffer.alloc(46);
  header.writeUInt32LE(0x02014b50, 0);
  header.writeUInt16LE(0x0314, 4); // Unix, ZIP 2.0.
  header.writeUInt16LE(20, 6);
  header.writeUInt16LE(ZIP_UTF8_FLAG, 8);
  header.writeUInt16LE(ZIP_STORE_METHOD, 10);
  header.writeUInt16LE(ZIP_DOS_TIME, 12);
  header.writeUInt16LE(ZIP_DOS_DATE, 14);
  header.writeUInt32LE(checksum, 16);
  header.writeUInt32LE(contentLength, 20);
  header.writeUInt32LE(contentLength, 24);
  header.writeUInt16LE(nameBytes.length, 28);
  header.writeUInt16LE(0, 30);
  header.writeUInt16LE(0, 32);
  header.writeUInt16LE(0, 34);
  header.writeUInt16LE(0, 36);
  header.writeUInt32LE((ZIP_UNIX_FILE_MODE << 16) >>> 0, 38);
  header.writeUInt32LE(localOffset, 42);
  return Buffer.concat([header, nameBytes]);
}

function endOfCentralDirectory(entryCount, centralSize, centralOffset) {
  const record = Buffer.alloc(22);
  record.writeUInt32LE(0x06054b50, 0);
  record.writeUInt16LE(0, 4);
  record.writeUInt16LE(0, 6);
  record.writeUInt16LE(entryCount, 8);
  record.writeUInt16LE(entryCount, 10);
  record.writeUInt32LE(centralSize, 12);
  record.writeUInt32LE(centralOffset, 16);
  record.writeUInt16LE(0, 20);
  return record;
}

export async function createDeterministicZip({ sourceDirectory, outputPath }) {
  const source = await realpath(normalizeAbsolute(sourceDirectory, 'sourceDirectory'));
  const output = normalizeAbsolute(outputPath, 'outputPath');
  if (isSameOrInside(source, output)) throw new Error('ZIP output must be outside its source directory');
  if (await lstatOrNull(output)) throw new Error('ZIP output already exists');
  const parent = await realpath(path.dirname(output));
  if (comparisonPath(parent) !== comparisonPath(path.dirname(output))) {
    throw new Error('ZIP output parent must not be reached through a link');
  }

  const tree = await enumerateTree(source, { includeBytes: true });
  if (tree.files.length === 0) throw new Error('Cannot create an empty offline-kit ZIP');
  const names = validateArchiveEntryNames(tree.files.map((entry) => entry.path));
  if (names.length > 0xffff) throw new Error('ZIP64 archives are not supported');

  const localRecords = [];
  const centralRecords = [];
  let localOffset = 0;
  for (const entry of tree.files) {
    const nameBytes = Buffer.from(entry.path, 'utf8');
    const checksum = crc32(entry.content);
    const local = localFileRecord(nameBytes, entry.content, checksum);
    localRecords.push(local);
    centralRecords.push(centralDirectoryRecord(nameBytes, entry.content.length, checksum, localOffset));
    localOffset += local.length;
  }
  const central = Buffer.concat(centralRecords);
  const archive = Buffer.concat([
    ...localRecords,
    central,
    endOfCentralDirectory(tree.files.length, central.length, localOffset),
  ]);
  if (archive.length > OFFLINE_KIT_LIMITS.max_archive_bytes) {
    throw new Error('ZIP exceeds the offline-kit byte limit');
  }
  await writeFile(output, archive, { flag: 'wx', mode: 0o644 });
  await chmod(output, 0o644);
  return withTruth({
    schema: 'agoragentic.risk-fork.demo-deterministic-zip.v1',
    zip_path: output,
    sha256: sha256(archive),
    bytes: archive.length,
    entry_count: tree.files.length,
    compression: 'store',
    deterministic_timestamp: FIXED_CREATED_AT,
    fixed_file_mode: '0100644',
  });
}

function findEndOfCentralDirectory(archive) {
  const minimumOffset = Math.max(0, archive.length - 22 - 0xffff);
  for (let offset = archive.length - 22; offset >= minimumOffset; offset -= 1) {
    if (archive.readUInt32LE(offset) !== 0x06054b50) continue;
    const commentLength = archive.readUInt16LE(offset + 20);
    if (offset + 22 + commentLength !== archive.length) continue;
    if (commentLength !== 0) throw new Error('ZIP comments are forbidden');
    return offset;
  }
  throw new Error('ZIP end-of-central-directory record is missing');
}

function checkedSlice(buffer, start, length, label) {
  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(length) || start < 0 || length < 0) {
    throw new Error(`Invalid ${label} bounds`);
  }
  const end = start + length;
  if (end > buffer.length) throw new Error(`${label} exceeds archive bounds`);
  return buffer.subarray(start, end);
}

function decodeZipName(bytes) {
  try {
    return UTF8_FATAL.decode(bytes);
  } catch {
    throw new Error('ZIP entry name is not valid UTF-8');
  }
}

function parseCanonicalZip(archive) {
  if (!Buffer.isBuffer(archive)) throw new TypeError('ZIP bytes must be a Buffer');
  if (archive.length < 22 || archive.length > OFFLINE_KIT_LIMITS.max_archive_bytes) {
    throw new Error('ZIP size is outside the offline-kit bounds');
  }
  const eocdOffset = findEndOfCentralDirectory(archive);
  const diskNumber = archive.readUInt16LE(eocdOffset + 4);
  const centralDisk = archive.readUInt16LE(eocdOffset + 6);
  const diskEntries = archive.readUInt16LE(eocdOffset + 8);
  const totalEntries = archive.readUInt16LE(eocdOffset + 10);
  const centralSize = archive.readUInt32LE(eocdOffset + 12);
  const centralOffset = archive.readUInt32LE(eocdOffset + 16);
  if (diskNumber !== 0 || centralDisk !== 0 || diskEntries !== totalEntries) {
    throw new Error('Multi-disk ZIP archives are forbidden');
  }
  if (totalEntries === 0 || totalEntries > OFFLINE_KIT_LIMITS.max_files) {
    throw new Error('ZIP entry count is outside the offline-kit bounds');
  }
  if (centralOffset + centralSize !== eocdOffset) {
    throw new Error('ZIP central directory bounds are not canonical');
  }

  const entries = [];
  let cursor = centralOffset;
  for (let index = 0; index < totalEntries; index += 1) {
    if (checkedSlice(archive, cursor, 46, 'central header').readUInt32LE(0) !== 0x02014b50) {
      throw new Error('ZIP central-directory signature is invalid');
    }
    const madeBy = archive.readUInt16LE(cursor + 4);
    const needed = archive.readUInt16LE(cursor + 6);
    const flags = archive.readUInt16LE(cursor + 8);
    const method = archive.readUInt16LE(cursor + 10);
    const modTime = archive.readUInt16LE(cursor + 12);
    const modDate = archive.readUInt16LE(cursor + 14);
    const checksum = archive.readUInt32LE(cursor + 16);
    const compressedSize = archive.readUInt32LE(cursor + 20);
    const uncompressedSize = archive.readUInt32LE(cursor + 24);
    const nameLength = archive.readUInt16LE(cursor + 28);
    const extraLength = archive.readUInt16LE(cursor + 30);
    const commentLength = archive.readUInt16LE(cursor + 32);
    const diskStart = archive.readUInt16LE(cursor + 34);
    const internalAttributes = archive.readUInt16LE(cursor + 36);
    const externalAttributes = archive.readUInt32LE(cursor + 38);
    const localOffset = archive.readUInt32LE(cursor + 42);
    if (
      madeBy !== 0x0314
      || needed !== 20
      || flags !== ZIP_UTF8_FLAG
      || method !== ZIP_STORE_METHOD
      || modTime !== ZIP_DOS_TIME
      || modDate !== ZIP_DOS_DATE
      || compressedSize !== uncompressedSize
      || extraLength !== 0
      || commentLength !== 0
      || diskStart !== 0
      || internalAttributes !== 0
      || externalAttributes !== ((ZIP_UNIX_FILE_MODE << 16) >>> 0)
    ) {
      throw new Error('ZIP entry metadata is not canonical or represents a link/special entry');
    }
    if (uncompressedSize > OFFLINE_KIT_LIMITS.max_file_bytes) {
      throw new Error('ZIP entry exceeds the per-file bound');
    }
    const nameBytes = checkedSlice(archive, cursor + 46, nameLength, 'central entry name');
    const name = assertSafeArchivePath(decodeZipName(nameBytes));
    entries.push({
      name,
      name_bytes: Buffer.from(nameBytes),
      checksum,
      size: uncompressedSize,
      local_offset: localOffset,
    });
    cursor += 46 + nameLength;
  }
  if (cursor !== eocdOffset) throw new Error('ZIP central directory has trailing or missing bytes');
  validateArchiveEntryNames(entries.map((entry) => entry.name));
  const sorted = [...entries].sort((left, right) => rawPathCompare(left.name, right.name));
  if (entries.some((entry, index) => entry.name !== sorted[index].name)) {
    throw new Error('ZIP entries are not in deterministic raw-byte order');
  }

  let expectedLocalOffset = 0;
  let totalUncompressed = 0;
  for (const entry of entries) {
    if (entry.local_offset !== expectedLocalOffset) {
      throw new Error('ZIP local entries are reordered, overlapping, or contain gaps');
    }
    const local = checkedSlice(archive, entry.local_offset, 30, 'local header');
    if (local.readUInt32LE(0) !== 0x04034b50) throw new Error('ZIP local-header signature is invalid');
    const localFlags = local.readUInt16LE(6);
    const localMethod = local.readUInt16LE(8);
    const localTime = local.readUInt16LE(10);
    const localDate = local.readUInt16LE(12);
    const localChecksum = local.readUInt32LE(14);
    const localCompressed = local.readUInt32LE(18);
    const localUncompressed = local.readUInt32LE(22);
    const localNameLength = local.readUInt16LE(26);
    const localExtraLength = local.readUInt16LE(28);
    if (
      localFlags !== ZIP_UTF8_FLAG
      || localMethod !== ZIP_STORE_METHOD
      || localTime !== ZIP_DOS_TIME
      || localDate !== ZIP_DOS_DATE
      || localChecksum !== entry.checksum
      || localCompressed !== entry.size
      || localUncompressed !== entry.size
      || localNameLength !== entry.name_bytes.length
      || localExtraLength !== 0
    ) {
      throw new Error('ZIP local and central metadata disagree');
    }
    const localName = checkedSlice(
      archive,
      entry.local_offset + 30,
      localNameLength,
      'local entry name',
    );
    if (!localName.equals(entry.name_bytes)) throw new Error('ZIP local and central entry names disagree');
    const dataOffset = entry.local_offset + 30 + localNameLength;
    const content = checkedSlice(archive, dataOffset, entry.size, 'entry content');
    if (crc32(content) !== entry.checksum) throw new Error(`ZIP CRC mismatch for ${entry.name}`);
    entry.content = Buffer.from(content);
    entry.sha256 = sha256(content);
    expectedLocalOffset = dataOffset + entry.size;
    totalUncompressed += entry.size;
    if (totalUncompressed > OFFLINE_KIT_LIMITS.max_archive_bytes) {
      throw new Error('ZIP uncompressed bytes exceed the offline-kit bound');
    }
  }
  if (expectedLocalOffset !== centralOffset) {
    throw new Error('ZIP local-data region does not end at the central directory');
  }
  return { entries, total_uncompressed_bytes: totalUncompressed };
}

async function readCanonicalZip(zipPath) {
  const absolute = normalizeAbsolute(zipPath, 'zipPath');
  const zipStat = await lstat(absolute);
  assertRegularFile(zipStat, 'Offline-kit ZIP');
  if (zipStat.size > OFFLINE_KIT_LIMITS.max_archive_bytes) {
    throw new Error('ZIP exceeds the offline-kit byte limit');
  }
  const bytes = await readFile(absolute);
  return { absolute, bytes, ...parseCanonicalZip(bytes) };
}

export async function verifyZipArchive({ zipPath }) {
  const parsed = await readCanonicalZip(zipPath);
  return withTruth({
    schema: 'agoragentic.risk-fork.demo-zip-verification.v1',
    verified: true,
    zip_path: parsed.absolute,
    sha256: sha256(parsed.bytes),
    bytes: parsed.bytes.length,
    entry_count: parsed.entries.length,
    uncompressed_bytes: parsed.total_uncompressed_bytes,
    entries: parsed.entries.map((entry) => Object.freeze({
      path: entry.name,
      bytes: entry.size,
      sha256: entry.sha256,
    })),
  });
}

function assertManifestTruth(manifest) {
  if (!manifest || typeof manifest !== 'object' || Array.isArray(manifest)) {
    throw new Error('Offline-kit manifest must be an object');
  }
  if (manifest.schema !== 'agoragentic.risk-fork.offline-kit-manifest.v1') {
    throw new Error('Offline-kit manifest schema is unsupported');
  }
  if (manifest.banner !== OFFLINE_KIT_BANNER) throw new Error('Offline-kit banner is missing or changed');
  for (const [key, expected] of Object.entries(OFFLINE_KIT_TRUTH)) {
    if (manifest[key] !== expected) throw new Error(`Offline-kit truth field ${key} is invalid`);
  }
  if (!/^[0-9a-f]{40}$/.test(manifest.source_commit)) {
    throw new Error('Offline-kit source commit is not an exact Git SHA');
  }
  if (manifest.source_commits?.public_integrations !== manifest.source_commit) {
    throw new Error('Offline-kit source commit metadata is inconsistent');
  }
  if (manifest.source_materialization !== 'exact_git_blobs') {
    throw new Error('Offline-kit source materialization is not exact-commit Git blobs');
  }
  if (manifest.provider !== 'e2b'
    || manifest.provider_status !== 'not_live_qualified'
    || manifest.production_qualified !== false
    || manifest.live_agoragentic_traffic_protected !== false
    || manifest.hosted_execution_enabled !== false) {
    throw new Error('Offline-kit provider qualification boundary is invalid');
  }
  if (manifest.supported_node !== '>=20') throw new Error('Offline-kit Node support metadata is invalid');
  if (
    manifest.configuration_status?.templates_client_verified !== 0
    || manifest.configuration_status?.unverified_client_status
      !== GENERATED_NOT_CLIENT_VERIFIED_STATUS
  ) {
    throw new Error('Offline-kit client verification status is invalid');
  }
  if (manifest.deterministic_created_at !== FIXED_CREATED_AT) {
    throw new Error('Offline-kit deterministic timestamp is invalid');
  }
}

function validateManifestEntries(manifest) {
  if (!Array.isArray(manifest.files) || !Array.isArray(manifest.directories)) {
    throw new Error('Offline-kit manifest entries are missing');
  }
  const names = validateArchiveEntryNames(manifest.files.map((entry) => entry?.path));
  if (names.includes(MANIFEST_NAME)) throw new Error('Manifest must not recursively hash itself');
  if (manifest.files.length !== names.length) throw new Error('Manifest file entries are duplicated');
  if (manifest.files.some((entry, index) => entry.path !== names[index])) {
    throw new Error('Manifest file entries are not in raw-byte order');
  }
  const directories = validateArchiveEntryNames(manifest.directories);
  if (directories.some((entry, index) => entry !== manifest.directories[index])) {
    throw new Error('Manifest directory entries are not in raw-byte order');
  }
  for (const entry of manifest.files) {
    if (
      !entry
      || typeof entry.path !== 'string'
      || !Number.isSafeInteger(entry.bytes)
      || entry.bytes < 0
      || entry.bytes > OFFLINE_KIT_LIMITS.max_file_bytes
      || !/^[0-9a-f]{64}$/.test(entry.sha256)
    ) {
      throw new Error(`Manifest file entry is invalid: ${entry?.path ?? '<unknown>'}`);
    }
  }
  const expectedDirectories = directoriesForFiles(names);
  if (
    expectedDirectories.length !== directories.length
    || expectedDirectories.some((entry, index) => entry !== directories[index])
  ) {
    throw new Error('Manifest directory inventory is not derived from its files');
  }
  const total = manifest.files.reduce((sum, entry) => sum + entry.bytes, 0);
  if (manifest.file_count !== manifest.files.length || manifest.total_bytes !== total) {
    throw new Error('Manifest file count or byte total is inconsistent');
  }
  return { names, directories, total };
}

async function verifyDependencyProvenance(root) {
  const provenancePath = path.join(root, DEPENDENCY_PROVENANCE_NAME);
  const provenanceBytes = await readFile(provenancePath);
  let provenance;
  try {
    provenance = JSON.parse(UTF8_FATAL.decode(provenanceBytes));
  } catch {
    throw new Error('Offline dependency provenance is not valid UTF-8 JSON');
  }
  if (provenance?.schema !== 'agoragentic.risk-fork.offline-dependency-provenance.v1'
    || provenance.materialization !== 'npm_ci_offline_from_lock_cache'
    || provenance.lockfile !== 'risk-fork/package-lock.json'
    || provenance.source_node_modules_used !== false
    || provenance.network_used !== false
    || provenance.install_scripts_executed !== false
    || !Array.isArray(provenance.packages)) {
    throw new Error('Offline dependency provenance boundary is invalid');
  }
  const lockBytes = await readFile(path.join(root, 'risk-fork/package-lock.json'));
  const plan = parseLockedDependencyPlan(lockBytes);
  if (provenance.lockfile_sha256 !== plan.lock_sha256
    || provenance.packages.length !== plan.packages.length) {
    throw new Error('Offline dependency provenance does not bind the included package lock');
  }
  for (let index = 0; index < plan.packages.length; index += 1) {
    const locked = plan.packages[index];
    const observed = provenance.packages[index];
    if (!observed
      || observed.name !== locked.name
      || observed.version !== locked.version
      || observed.resolved !== locked.resolved
      || observed.integrity !== locked.integrity
      || !/^[0-9a-f]{64}$/.test(observed.tree_sha256)
      || !Number.isSafeInteger(observed.file_count)
      || observed.file_count < 1
      || !Number.isSafeInteger(observed.total_bytes)
      || observed.total_bytes < 1) {
      throw new Error(`Offline dependency provenance is invalid for ${locked.name}`);
    }
    const packageRoot = path.join(root, 'risk-fork/node_modules', ...locked.name.split('/'));
    const actual = await dependencyTreeEvidence(packageRoot);
    if (actual.tree_sha256 !== observed.tree_sha256
      || actual.file_count !== observed.file_count
      || actual.total_bytes !== observed.total_bytes) {
      throw new Error(`Offline dependency tree provenance mismatch: ${locked.name}`);
    }
  }
  return Object.freeze({
    verified: true,
    materialization: provenance.materialization,
    lockfile_sha256: provenance.lockfile_sha256,
    package_count: provenance.packages.length,
  });
}

export async function verifyOfflineKit({ kitDirectory }) {
  const root = await realpath(normalizeAbsolute(kitDirectory, 'kitDirectory'));
  const rootStat = await lstat(root);
  if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) {
    throw new Error('Offline kit must be a real directory');
  }
  const manifestPath = path.join(root, MANIFEST_NAME);
  const manifestStat = await lstat(manifestPath);
  assertRegularFile(manifestStat, MANIFEST_NAME);
  if (manifestStat.size > 4 * 1024 * 1024) throw new Error('Offline-kit manifest is too large');
  const manifestBytes = await readFile(manifestPath);
  let manifest;
  try {
    manifest = JSON.parse(UTF8_FATAL.decode(manifestBytes));
  } catch (error) {
    throw new Error(`Offline-kit manifest is not valid UTF-8 JSON: ${error.message}`);
  }
  assertManifestTruth(manifest);
  const expected = validateManifestEntries(manifest);

  const tree = await enumerateTree(root, { includeBytes: true });
  const actualFiles = tree.files.map((entry) => entry.path);
  const expectedFilesIncludingManifest = [...expected.names, MANIFEST_NAME].sort(rawPathCompare);
  if (
    actualFiles.length !== expectedFilesIncludingManifest.length
    || actualFiles.some((entry, index) => entry !== expectedFilesIncludingManifest[index])
  ) {
    throw new Error('Offline kit has extra or missing files');
  }
  if (
    tree.directories.length !== expected.directories.length
    || tree.directories.some((entry, index) => entry !== expected.directories[index])
  ) {
    throw new Error('Offline kit has extra or missing directories');
  }

  const actualByName = new Map(tree.files.map((entry) => [entry.path, entry]));
  for (const expectedEntry of manifest.files) {
    const actual = actualByName.get(expectedEntry.path);
    if (!actual || actual.bytes !== expectedEntry.bytes || sha256(actual.content) !== expectedEntry.sha256) {
      throw new Error(`Offline-kit integrity mismatch: ${expectedEntry.path}`);
    }
    assertNoSensitiveBytes(actual.content, expectedEntry.path);
  }
  const dependencyProvenance = await verifyDependencyProvenance(root);
  assertNoSensitiveBytes(manifestBytes, MANIFEST_NAME);
  return withTruth({
    schema: 'agoragentic.risk-fork.offline-kit-verification.v1',
    verified: true,
    kit_directory_ref: 'local:verified-manifest-root',
    source_commit: manifest.source_commit,
    manifest_sha256: sha256(manifestBytes),
    manifest_bytes: manifestBytes.length,
    file_count: manifest.file_count,
    total_bytes: manifest.total_bytes,
    configuration_status: manifest.configuration_status,
    validation_summary: manifest.validation_summary,
    dependency_provenance: dependencyProvenance,
  });
}

async function ensureExtractionParent(destination) {
  const parentInput = path.dirname(destination);
  const parent = await realpath(parentInput);
  if (comparisonPath(parent) !== comparisonPath(parentInput)) {
    throw new Error('Extraction parent must not be reached through a filesystem link');
  }
  const parentStat = await lstat(parent);
  if (!parentStat.isDirectory() || parentStat.isSymbolicLink()) {
    throw new Error('Extraction parent must be a real directory');
  }
}

async function createSafeExtractionDirectory(root, relativeDirectory) {
  let cursor = root;
  if (!relativeDirectory) return;
  for (const segment of relativeDirectory.split('/')) {
    cursor = path.join(cursor, segment);
    const existing = await lstatOrNull(cursor);
    if (!existing) {
      await mkdir(cursor, { mode: 0o755 });
      const created = await lstat(cursor);
      if (!created.isDirectory() || created.isSymbolicLink()) {
        throw new Error(`Unsafe extraction directory: ${relativeDirectory}`);
      }
    } else if (!existing.isDirectory() || existing.isSymbolicLink()) {
      throw new Error(`Extraction directory collision: ${relativeDirectory}`);
    }
  }
}

async function writeExtractionOwner(ownerPath, stage, target) {
  await writeFile(ownerPath, stableJson({
    schema: 'agoragentic.risk-fork.offline-kit-extraction-owner.v1',
    owned_stage: true,
    stage_hash: sha256(Buffer.from(stage, 'utf8')),
    destination_hash: sha256(Buffer.from(target, 'utf8')),
  }), { encoding: 'utf8', flag: 'wx', mode: 0o600 });
}

async function removeOwnedExtractionStage({ ownerPath, stage, target }) {
  const parent = path.dirname(target);
  if (!isSameOrInside(parent, stage)
    || comparisonPath(parent) === comparisonPath(stage)
    || comparisonPath(target) === comparisonPath(stage)) {
    throw new Error('Refusing to clean an extraction stage outside its exact parent');
  }
  const owner = JSON.parse(await readFile(ownerPath, 'utf8'));
  if (owner?.schema !== 'agoragentic.risk-fork.offline-kit-extraction-owner.v1'
    || owner.owned_stage !== true
    || owner.stage_hash !== sha256(Buffer.from(stage, 'utf8'))
    || owner.destination_hash !== sha256(Buffer.from(target, 'utf8'))) {
    throw new Error('Refusing to clean an unowned extraction stage');
  }
  if (await lstatOrNull(stage)) {
    await rm(stage, { recursive: true, force: false, maxRetries: 0 });
  }
  await rm(ownerPath, { force: false, maxRetries: 0 });
}

export async function extractAndVerifyOfflineKit({ zipPath, destination }) {
  const parsed = await readCanonicalZip(zipPath);
  const target = normalizeAbsolute(destination, 'destination');
  if (await lstatOrNull(target)) throw new Error('Extraction destination already exists');
  await ensureExtractionParent(target);
  const extractionParent = path.dirname(target);
  const stage = path.join(extractionParent, `.${path.basename(target)}.risk-fork-extracting`);
  const ownerPath = `${stage}${EXTRACTION_OWNER_SUFFIX}`;
  if (await lstatOrNull(stage) || await lstatOrNull(ownerPath)) {
    throw new Error('Offline-kit extraction stage already exists');
  }
  await mkdir(stage, { mode: 0o700 });
  let ownerWritten = false;
  let finalized = false;
  try {
    await writeExtractionOwner(ownerPath, stage, target);
    ownerWritten = true;
    const stageReal = await realpath(stage);
    if (comparisonPath(stageReal) !== comparisonPath(stage)) {
      throw new Error('Extraction stage resolved unexpectedly');
    }
    for (const entry of parsed.entries) {
      const parent = path.posix.dirname(entry.name);
      await createSafeExtractionDirectory(stage, parent === '.' ? '' : parent);
      const output = path.join(stage, ...entry.name.split('/'));
      if (!isSameOrInside(stage, output) || comparisonPath(output) === comparisonPath(stage)) {
        throw new Error(`Archive entry escapes extraction stage: ${entry.name}`);
      }
      const handle = await open(output, 'wx', 0o644);
      try {
        await handle.writeFile(entry.content);
        await handle.sync();
      } finally {
        await handle.close();
      }
      await chmod(output, 0o644);
      const outputStat = await lstat(output);
      assertRegularFile(outputStat, entry.name);
    }
    const verification = await verifyOfflineKit({ kitDirectory: stage });
    await rename(stage, target);
    finalized = true;
    await rm(ownerPath, { force: false, maxRetries: 0 });
    return withTruth({
      schema: 'agoragentic.risk-fork.offline-kit-extraction.v1',
      extracted: true,
      destination: target,
      zip_sha256: sha256(parsed.bytes),
      zip_bytes: parsed.bytes.length,
      entry_count: parsed.entries.length,
      verification,
    });
  } catch (error) {
    if (!finalized) {
      if (ownerWritten) {
        await removeOwnedExtractionStage({ ownerPath, stage, target });
      } else if (await lstatOrNull(stage)) {
        // The directory was exclusively created by this call, and no caller data
        // was written before the ownership-marker attempt failed.
        await rm(stage, { recursive: true, force: false, maxRetries: 0 });
      }
    }
    throw error;
  }
}

export const verifyExtractedOfflineKit = verifyOfflineKit;

function rootReadme(sourceCommit) {
  return [
    '# Risk Fork Hackathon Offline Kit',
    '',
    `> ${OFFLINE_KIT_BANNER}`,
    '',
    `Source commit: \`${sourceCommit}\``,
    '',
    'This is an offline demonstration of the Risk Fork protocol. It is not a sandbox,',
    'does not protect live traffic, grants no authority, and must not receive credentials.',
    '',
    'Requires Node.js 20 or newer. Do not run npm install and do not provide API keys.',
    '',
    'From this extracted directory:',
    '',
    '```text',
    'node ./risk-fork/hackathon/bin/risk-fork-demo.mjs doctor',
    'node ./risk-fork/hackathon/bin/risk-fork-demo.mjs run --scenario e2b-malicious-mcp-containment',
    'node ./risk-fork/hackathon/bin/risk-fork-demo.mjs serve',
    '```',
    '',
    'The files under `risk-fork/hackathon/configs/` are generated portable templates,',
    'not verified client installations. Generate a path-specific configuration only after',
    'extraction with the local `config --client <client>` command.',
    '',
    'See `risk-fork/hackathon/docs/QUICKSTART.md` and',
    '`risk-fork/hackathon/docs/CLEANUP_TROUBLESHOOTING.md`.',
    '',
  ].join('\n');
}

function claimBoundary() {
  return [
    '# Claim boundary',
    '',
    `> ${OFFLINE_KIT_BANNER}`,
    '',
    '- Local protocol simulation only.',
    '- No isolation boundary or production readiness.',
    '- No live traffic protection or authority grant.',
    '- No provider, database, Marketplace, registry, cloud, or other external network call.',
    '- No credentials, wallet, paid API, spend, clean commit, publication, deployment, or activation.',
    '- E2B is named only as the selected future provider; it is not contacted or qualified here.',
    '',
  ].join('\n');
}

async function writeGeneratedKitMetadata({
  kitRoot,
  sourceCommit,
  dependencies,
  dependencyProvenance,
  validationSummary,
  generatedConfigurations,
}) {
  const write = (name, content) => writeFile(path.join(kitRoot, name), content, {
    encoding: 'utf8',
    flag: 'wx',
    mode: 0o644,
  });
  await write('README.md', rootReadme(sourceCommit));
  await write('CLAIM_BOUNDARY.md', claimBoundary());
  await write('SUPPORTED_NODE.txt', `>=20\n`);
  await write('LICENSE', await readFile(path.join(kitRoot, 'risk-fork/LICENSE'), 'utf8'));
  await write('SOURCE_COMMITS.json', stableJson({
    schema: 'agoragentic.risk-fork.demo-source-commits.v1',
    banner: OFFLINE_KIT_BANNER,
    ...OFFLINE_KIT_TRUTH,
    public_integrations: sourceCommit,
    source_materialization: 'exact_git_blobs',
    ignored_worktree_files_included: false,
    provider: 'e2b',
    provider_status: 'not_live_qualified',
    production_qualified: false,
    live_agoragentic_traffic_protected: false,
    hosted_execution_enabled: false,
    dependency_provenance: DEPENDENCY_PROVENANCE_NAME,
  }));
  await write(DEPENDENCY_PROVENANCE_NAME, stableJson(dependencyProvenance));
  const notices = [
    '# Third-party notices',
    '',
    `> ${OFFLINE_KIT_BANNER}`,
    '',
    'The offline demo includes the following exact runtime dependency closure:',
    '',
    ...dependencies.map((item) => (
      `- ${item.name} ${item.version} — ${item.license} — lock SHA-512 verified offline`
    )),
    '',
    'See each copied package directory for its package metadata and license notices.',
    '',
  ].join('\n');
  await write('THIRD_PARTY_NOTICES.md', notices);
  await write('VALIDATION_SUMMARY.json', stableJson({
    schema: 'agoragentic.risk-fork.demo-validation-summary.v1',
    banner: OFFLINE_KIT_BANNER,
    ...OFFLINE_KIT_TRUTH,
    summary: validationSummary ?? {
      status: 'pending_external_cli_orchestration',
      note: 'The deterministic builder and integrity verifier ran; scenario and UI evidence must be supplied by the caller.',
    },
  }));
  return writePortableConfigurations(kitRoot, generatedConfigurations);
}

async function createManifest({
  kitRoot,
  sourceCommit,
  validationSummary,
  configurationRecords,
  forbiddenPaths = [],
}) {
  const tree = await enumerateTree(kitRoot, { includeBytes: true });
  if (tree.files.some((entry) => entry.path === MANIFEST_NAME)) {
    throw new Error('Manifest already exists; offline-kit builds never overwrite artifacts');
  }
  for (const entry of tree.files) {
    assertNoSensitiveBytes(entry.content, entry.path, forbiddenPaths);
  }
  const files = tree.files.map((entry) => ({
    path: entry.path,
    bytes: entry.bytes,
    sha256: sha256(entry.content),
  }));
  const manifest = {
    schema: 'agoragentic.risk-fork.offline-kit-manifest.v1',
    banner: OFFLINE_KIT_BANNER,
    ...OFFLINE_KIT_TRUTH,
    source_commit: sourceCommit,
    source_commits: { public_integrations: sourceCommit },
    source_materialization: 'exact_git_blobs',
    ignored_worktree_files_included: false,
    deterministic_created_at: FIXED_CREATED_AT,
    supported_node: '>=20',
    package_mode: 'private_unpublished_offline_directory',
    provider: 'e2b',
    provider_status: 'not_live_qualified',
    production_qualified: false,
    live_agoragentic_traffic_protected: false,
    npm_published: false,
    hosted_execution_enabled: false,
    external_network_required: false,
    claim_boundary: 'See CLAIM_BOUNDARY.md. This kit is not an isolation boundary and provides no live protection.',
    manifest_excludes: [MANIFEST_NAME],
    configuration_status: {
      templates_generated: configurationRecords.length,
      templates_client_verified: 0,
      unverified_client_status: GENERATED_NOT_CLIENT_VERIFIED_STATUS,
      regeneration_required_after_extraction: true,
    },
    validation_summary: validationSummary ?? {
      status: 'pending_external_cli_orchestration',
      builder_and_integrity_verifier: 'required_before_release',
    },
    file_count: files.length,
    total_bytes: files.reduce((sum, entry) => sum + entry.bytes, 0),
    directories: directoriesForFiles(files.map((entry) => entry.path)),
    files,
  };
  const bytes = Buffer.from(stableJson(manifest), 'utf8');
  assertNoSensitiveBytes(bytes, MANIFEST_NAME, forbiddenPaths);
  await writeFile(path.join(kitRoot, MANIFEST_NAME), bytes, { flag: 'wx', mode: 0o644 });
  return { manifest, bytes };
}

async function writeBuildOwner(stageRoot, sourceCommit) {
  const owner = {
    schema: 'agoragentic.risk-fork.offline-kit-build-owner.v1',
    source_commit: sourceCommit,
    owned_stage: true,
  };
  await writeFile(path.join(stageRoot, BUILD_OWNER_NAME), stableJson(owner), {
    encoding: 'utf8',
    flag: 'wx',
    mode: 0o600,
  });
}

async function removeOwnedBuildStage(stageRoot, outputBase, sourceCommit) {
  if (!isSameOrInside(outputBase, stageRoot) || comparisonPath(stageRoot) === comparisonPath(outputBase)) {
    throw new Error('Refusing to clean a build stage outside the exact output base');
  }
  const marker = JSON.parse(await readFile(path.join(stageRoot, BUILD_OWNER_NAME), 'utf8'));
  if (
    marker?.schema !== 'agoragentic.risk-fork.offline-kit-build-owner.v1'
    || marker.source_commit !== sourceCommit
    || marker.owned_stage !== true
  ) {
    throw new Error('Refusing to clean an unowned build stage');
  }
  await rm(stageRoot, { recursive: true, force: false, maxRetries: 0 });
}

export async function buildOfflineKit({
  repositoryRoot,
  sourceCommit,
  outputBase,
  npmCacheDirectory = null,
  validationSummary = null,
  generatedConfigurations = null,
}) {
  const repo = await assertPinnedCleanRepository(repositoryRoot, sourceCommit);
  const outputInput = normalizeAbsolute(outputBase, 'outputBase');
  if (isSameOrInside(repo, outputInput)) {
    throw new Error('Offline-kit output must be outside the public repository');
  }
  await assertNoGitAncestor(outputInput);
  await mkdir(outputInput, { recursive: true, mode: 0o755 });
  const output = await realpath(outputInput);
  if (comparisonPath(output) !== comparisonPath(outputInput)) {
    throw new Error('outputBase must not be reached through a filesystem link');
  }

  const shortCommit = sourceCommit.slice(0, 12);
  const artifactContainer = path.join(output, shortCommit);
  const stageContainer = path.join(output, `.${shortCommit}.building`);
  if (await lstatOrNull(artifactContainer)) throw new Error('Commit-pinned artifact container already exists');
  if (await lstatOrNull(stageContainer)) throw new Error('Offline-kit build stage already exists');
  await mkdir(stageContainer, { mode: 0o700 });
  await writeBuildOwner(stageContainer, sourceCommit);

  const kitName = 'risk-fork-hackathon-demo';
  const kitStage = path.join(stageContainer, kitName);
  const zipName = `${kitName}-${shortCommit}.zip`;
  const zipStage = path.join(stageContainer, zipName);
  try {
    await mkdir(kitStage, { mode: 0o755 });
    const sourceCopy = await copyPinnedSource({
      repositoryRoot: repo,
      sourceCommit,
      destinationRoot: kitStage,
    });

    const materialized = await materializeLockedDependenciesOffline({
      repositoryRoot: kitStage,
      stageContainer,
      npmCacheDirectory,
    });
    const dependencies = materialized.dependencies;
    for (const dependency of dependencies) {
      await copyCuratedTree(
        dependency.root,
        path.join(kitStage, 'risk-fork/node_modules', ...dependency.name.split('/')),
      );
    }
    await validateFixtureCatalog(kitStage);
    if (!isSameOrInside(stageContainer, materialized.reification_root)
      || comparisonPath(stageContainer) === comparisonPath(materialized.reification_root)) {
      throw new Error('Refusing to remove dependency reification outside the owned build stage');
    }
    await rm(materialized.reification_root, { recursive: true, force: false, maxRetries: 0 });
    if (await lstatOrNull(materialized.reification_root)) {
      throw new Error('Owned dependency reification was not removed before artifact finalization');
    }
    const configurationRecords = await writeGeneratedKitMetadata({
      kitRoot: kitStage,
      sourceCommit,
      dependencies,
      dependencyProvenance: materialized.provenance,
      validationSummary,
      generatedConfigurations,
    });
    const manifest = await createManifest({
      kitRoot: kitStage,
      sourceCommit,
      validationSummary,
      configurationRecords,
      forbiddenPaths: [repo, output, stageContainer],
    });
    const directoryVerification = await verifyOfflineKit({ kitDirectory: kitStage });
    const zip = await createDeterministicZip({ sourceDirectory: kitStage, outputPath: zipStage });
    const zipVerification = await verifyZipArchive({ zipPath: zipStage });

    await rename(stageContainer, artifactContainer);
    const finalKit = path.join(artifactContainer, kitName);
    const finalZip = path.join(artifactContainer, zipName);
    return withTruth({
      schema: 'agoragentic.risk-fork.offline-kit-build.v1',
      built: true,
      source_commit: sourceCommit,
      artifact_container: artifactContainer,
      kit_directory: finalKit,
      zip_path: finalZip,
      zip_sha256: zip.sha256,
      zip_bytes: zip.bytes,
      manifest_sha256: sha256(manifest.bytes),
      manifest_bytes: manifest.bytes.length,
      file_count: manifest.manifest.file_count,
      payload_bytes: manifest.manifest.total_bytes,
      directory_verification: {
        verified: directoryVerification.verified,
        file_count: directoryVerification.file_count,
      },
      zip_verification: {
        verified: zipVerification.verified,
        entry_count: zipVerification.entry_count,
      },
      source_copy: sourceCopy,
      scenario_orchestration: 'caller_must_run_cli_suite_from_fresh_extraction',
    });
  } catch (error) {
    try {
      if (await lstatOrNull(stageContainer)) {
        await removeOwnedBuildStage(stageContainer, output, sourceCommit);
      }
    } catch (cleanupError) {
      throw new AggregateError(
        [error, cleanupError],
        'Offline-kit build failed and its exact owned stage could not be cleaned',
      );
    }
    throw error;
  }
}
