#!/usr/bin/env node
import { randomBytes, randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import {
  lstat,
  mkdir,
  open,
  readdir,
  readFile,
} from 'node:fs/promises';
import net from 'node:net';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

import {
  canonicalize,
  createBootEvidenceEnvelope,
  sha256FileRef,
  sha256Ref,
} from '../lib/runtime-contract.mjs';

export const E2B_BOOT_EVIDENCE_PATH = '/run/agoragentic-risk-fork/boot-evidence.json';
export const E2B_BOOT_READY_PATH = '/run/agoragentic-risk-fork/ready';
const DEFAULT_BOOTSTRAP_PATH = '/opt/agoragentic/risk-fork/e2b-template/bin/bootstrap.mjs';
const DEFAULT_RUNNER_PATH = '/opt/agoragentic/risk-fork/e2b-template/bin/run.mjs';
const PROBE_TIMEOUT_MS = 1_500;
const MAX_PROCESS_ENVIRONMENT_BYTES = 1024 * 1024;
const MAX_PROCESS_ENVIRONMENTS = 4_096;
const ALLOWED_ENV_KEYS = new Set([
  'HOME',
  'LANG',
  'LC_ALL',
  'LC_CTYPE',
  'LOGNAME',
  'PATH',
  'PWD',
  'SHELL',
  'SHLVL',
  'TERM',
  'USER',
  '_',
]);
const FORBIDDEN_PROCESS_PATTERN = /(?:ssh-agent|gpg-agent|credential|wallet|codex|claude|openai|aws-vault|keychain)/i;
const FORBIDDEN_ENVIRONMENT_KEY_PATTERN = /(?:^|_)(?:E2B_API_KEY|AWS_(?:ACCESS_KEY_ID|SECRET_ACCESS_KEY|SESSION_TOKEN|WEB_IDENTITY_TOKEN_FILE)|AZURE_(?:CLIENT_ID|CLIENT_SECRET|TENANT_ID|FEDERATED_TOKEN_FILE)|GOOGLE_APPLICATION_CREDENTIALS|GCP_(?:API_KEY|ACCESS_TOKEN|CREDENTIALS)|OPENAI_API_KEY|ANTHROPIC_API_KEY|GITHUB_TOKEN|GH_TOKEN|API_KEY|ACCESS_TOKEN|REFRESH_TOKEN|AUTHORIZATION|CREDENTIALS?|PASSWORD|PASSPHRASE|PRIVATE_KEY|CLIENT_SECRET|SEED_PHRASE|MNEMONIC|WALLET_(?:KEY|SECRET))(?:$|_)/i;
const CREDENTIAL_PATHS = Object.freeze([
  '/home/user/.aws',
  '/home/user/.azure',
  '/home/user/.config/gcloud',
  '/home/user/.config/e2b',
  '/home/user/.docker/config.json',
  '/home/user/.e2b',
  '/home/user/.git-credentials',
  '/home/user/.netrc',
  '/home/user/.npmrc',
  '/home/user/.ssh',
  '/root/.aws',
  '/root/.azure',
  '/root/.config/gcloud',
  '/root/.config/e2b',
  '/root/.docker/config.json',
  '/root/.e2b',
  '/root/.git-credentials',
  '/root/.netrc',
  '/root/.npmrc',
  '/root/.ssh',
]);

export function classifyLiteralProbeOutcome(outcome) {
  if (outcome === 'connected') {
    return { status: 'connected', local_denial_observed: false };
  }
  if (outcome === 'EACCES' || outcome === 'EPERM') {
    return { status: 'denied', local_denial_observed: true };
  }
  if (outcome === 'ENETUNREACH' || outcome === 'EHOSTUNREACH') {
    return { status: 'unreachable', local_denial_observed: true };
  }
  return { status: 'unknown', local_denial_observed: false };
}

export function inspectProcessEnvironmentBytes(value) {
  const bytes = value instanceof Uint8Array ? Buffer.from(value) : Buffer.from(value ?? '');
  if (bytes.byteLength > MAX_PROCESS_ENVIRONMENT_BYTES) {
    throw new Error('process environment observation exceeded its byte bound');
  }
  const keyHashes = [];
  const forbiddenKeyHashes = [];
  let wellFormed = true;
  for (const record of bytes.toString('latin1').split('\0')) {
    if (!record) continue;
    const separator = record.indexOf('=');
    if (separator < 1) {
      wellFormed = false;
      continue;
    }
    const key = record.slice(0, separator);
    const keyHash = sha256Ref(key);
    keyHashes.push(keyHash);
    if (FORBIDDEN_ENVIRONMENT_KEY_PATTERN.test(key)) forbiddenKeyHashes.push(keyHash);
  }
  keyHashes.sort();
  forbiddenKeyHashes.sort();
  return Object.freeze({
    well_formed: wellFormed,
    key_count: keyHashes.length,
    key_hashes: Object.freeze(keyHashes),
    forbidden_key_hashes: Object.freeze(forbiddenKeyHashes),
  });
}

async function readIfPresent(target, maxBytes = 1024 * 1024) {
  try {
    const bytes = await readFile(target);
    if (bytes.byteLength > maxBytes) throw new Error('bounded boot observation exceeded');
    return bytes;
  } catch (error) {
    if (error?.code === 'ENOENT' || error?.code === 'EACCES') return null;
    throw error;
  }
}

async function probeLiteral(host, family) {
  return new Promise((resolve) => {
    const socket = new net.Socket();
    let settled = false;
    const finish = (outcome) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      const classification = classifyLiteralProbeOutcome(outcome);
      resolve({
        family,
        target_hash: sha256Ref(`${family}:${host}:443`),
        ...classification,
        outcome_hash: sha256Ref(String(outcome ?? 'unknown').slice(0, 100)),
      });
    };
    socket.setTimeout(PROBE_TIMEOUT_MS, () => finish('timeout_without_connection'));
    socket.once('error', (error) => finish(error?.code ?? 'socket_error'));
    socket.connect({ host, port: 443, family }, () => finish('connected'));
  });
}

async function observeProcesses() {
  let entries;
  try {
    entries = await readdir('/proc', { withFileTypes: true });
  } catch {
    return { succeeded: false, count: 0, hashes: [], forbidden: [] };
  }
  const hashes = [];
  const forbidden = [];
  let succeeded = true;
  for (const entry of entries) {
    if (!entry.isDirectory() || !/^[0-9]+$/.test(entry.name)) continue;
    let cmdline;
    try {
      cmdline = await readFile(`/proc/${entry.name}/cmdline`);
      if (cmdline.byteLength > 64 * 1024) throw new Error('process observation exceeded');
    } catch {
      succeeded = false;
      hashes.push(sha256Ref({ pid_hash: sha256Ref(entry.name), readable: false }));
      continue;
    }
    const normalized = cmdline.toString('utf8').replaceAll('\0', ' ').trim().slice(0, 8_192);
    const digest = sha256Ref(normalized || `pid:${entry.name}:empty`);
    hashes.push(digest);
    if (FORBIDDEN_PROCESS_PATTERN.test(normalized)) forbidden.push(digest);
  }
  hashes.sort();
  forbidden.sort();
  return { succeeded, count: hashes.length, hashes, forbidden };
}

async function observeProcessEnvironments() {
  let entries;
  try {
    entries = await readdir('/proc', { withFileTypes: true });
  } catch {
    return { succeeded: false, keyCount: 0, records: [], forbidden: [] };
  }
  const processes = entries
    .filter((entry) => entry.isDirectory() && /^[0-9]+$/.test(entry.name))
    .sort((left, right) => Number(left.name) - Number(right.name));
  if (processes.length > MAX_PROCESS_ENVIRONMENTS) {
    return { succeeded: false, keyCount: 0, records: [], forbidden: [] };
  }
  const records = [];
  const forbidden = [];
  let keyCount = 0;
  let succeeded = true;
  for (const entry of processes) {
    let bytes;
    try {
      bytes = await readFile(`/proc/${entry.name}/environ`);
      if (bytes.byteLength > MAX_PROCESS_ENVIRONMENT_BYTES) {
        throw new Error('process environment observation exceeded its byte bound');
      }
    } catch {
      succeeded = false;
      records.push(sha256Ref({ pid_hash: sha256Ref(entry.name), readable: false }));
      continue;
    }
    const inspected = inspectProcessEnvironmentBytes(bytes);
    if (!inspected.well_formed) succeeded = false;
    keyCount += inspected.key_count;
    forbidden.push(...inspected.forbidden_key_hashes);
    records.push(sha256Ref({
      pid_hash: sha256Ref(entry.name),
      readable: true,
      well_formed: inspected.well_formed,
      key_hashes: inspected.key_hashes,
      forbidden_key_hashes: inspected.forbidden_key_hashes,
    }));
  }
  records.sort();
  forbidden.sort();
  return { succeeded, keyCount, records, forbidden };
}

async function observeSockets() {
  const records = [];
  let succeeded = true;
  for (const file of ['/proc/net/tcp', '/proc/net/tcp6', '/proc/net/udp', '/proc/net/udp6']) {
    const bytes = await readIfPresent(file, 4 * 1024 * 1024);
    if (!bytes) {
      succeeded = false;
      continue;
    }
    for (const line of bytes.toString('utf8').split(/\r?\n/).slice(1)) {
      const columns = line.trim().split(/\s+/);
      if (columns.length < 4) continue;
      const remote = columns[2];
      const state = columns[3];
      if (!remote || /^(?:0{8}|0{32}):0000$/.test(remote)) continue;
      records.push(sha256Ref({ file: path.posix.basename(file), remote, state }));
    }
  }
  records.sort();
  return { succeeded, count: records.length, hashes: records };
}

async function observeMounts() {
  const bytes = await readIfPresent('/proc/self/mountinfo', 4 * 1024 * 1024);
  if (!bytes) return { succeeded: false, count: 0, hashes: [], forbidden: [] };
  const hashes = [];
  const forbidden = [];
  for (const line of bytes.toString('utf8').split(/\r?\n/).filter(Boolean)) {
    const columns = line.split(' ');
    const mountPoint = columns[4] ?? '';
    const digest = sha256Ref(line);
    hashes.push(digest);
    if (mountPoint === '/workspace/agoragentic-risk-fork-v1'
      || mountPoint.startsWith('/workspace/agoragentic-risk-fork-v1/')
      || mountPoint === '/mnt'
      || mountPoint.startsWith('/mnt/')) {
      forbidden.push(digest);
    }
  }
  hashes.sort();
  forbidden.sort();
  return { succeeded: true, count: hashes.length, hashes, forbidden };
}

async function pathContainsMaterial(target, state, depth = 0) {
  if (depth > 16 || state.entries > 10_000) throw new Error('credential scan bound exceeded');
  let info;
  try {
    info = await lstat(target);
  } catch (error) {
    if (error?.code === 'ENOENT') return false;
    throw error;
  }
  state.entries += 1;
  if (info.isSymbolicLink() || info.isFile()) return true;
  if (!info.isDirectory()) return true;
  const entries = await readdir(target, { withFileTypes: true });
  for (const entry of entries) {
    if (await pathContainsMaterial(path.join(target, entry.name), state, depth + 1)) return true;
  }
  return false;
}

async function observeCredentialPaths() {
  const present = [];
  let succeeded = true;
  for (const target of CREDENTIAL_PATHS) {
    try {
      if (await pathContainsMaterial(target, { entries: 0 })) present.push(sha256Ref(target));
    } catch {
      succeeded = false;
      present.push(sha256Ref(target));
    }
  }
  present.sort();
  return { succeeded, count: present.length, hashes: present };
}

export async function collectBootEvidence(options = {}) {
  const clock = options.clock ?? (() => new Date());
  const observedAt = new Date(clock());
  if (!Number.isFinite(observedAt.getTime())) throw new TypeError('boot clock is invalid');
  const bootstrapPath = options.bootstrapArtifactPath ?? DEFAULT_BOOTSTRAP_PATH;
  const runnerPath = options.runnerArtifactPath ?? DEFAULT_RUNNER_PATH;
  const [bootstrapArtifactHash, runnerArtifactHash] = await Promise.all([
    sha256FileRef(bootstrapPath),
    sha256FileRef(runnerPath),
  ]);
  const environmentKeys = Object.keys(process.env).sort();
  const unexpectedEnvironmentKeys = environmentKeys
    .filter((key) => !ALLOWED_ENV_KEYS.has(key) && !key.startsWith('LC_'))
    .map((key) => sha256Ref(key));
  const [processes, processEnvironments, sockets, mounts, credentials, ipv4, ipv6] = await Promise.all([
    observeProcesses(),
    observeProcessEnvironments(),
    observeSockets(),
    observeMounts(),
    observeCredentialPaths(),
    probeLiteral('1.1.1.1', 4),
    probeLiteral('2606:4700:4700::1111', 6),
  ]);
  const bootId = (await readIfPresent('/proc/sys/kernel/random/boot_id', 1024))
    ?.toString('utf8').trim() ?? randomUUID();
  const entropy = randomBytes(64);
  return createBootEvidenceEnvelope({
    observed_at: observedAt.toISOString(),
    expires_at: new Date(observedAt.getTime() + 5 * 60_000).toISOString(),
    boot_nonce: randomUUID(),
    boot_id_hash: sha256Ref(bootId),
    entropy_hash: sha256Ref(entropy.toString('hex')),
    bootstrap_artifact_hash: bootstrapArtifactHash,
    runner_artifact_hash: runnerArtifactHash,
    measurements: {
      environment_key_count: environmentKeys.length + processEnvironments.keyCount,
      process_count: processes.count,
      socket_count: sockets.count,
      mount_count: mounts.count,
      credential_path_count: credentials.count,
    },
    observation_hashes: {
      environment_keys_hash: sha256Ref({
        boot_guard_key_hashes: environmentKeys.map((key) => sha256Ref(key)),
        process_environment_records: processEnvironments.records,
      }),
      processes_hash: sha256Ref(processes.hashes),
      sockets_hash: sha256Ref(sockets.hashes),
      mounts_hash: sha256Ref(mounts.hashes),
      credential_paths_hash: sha256Ref(credentials.hashes),
      ipv4_probe_hash: sha256Ref(ipv4),
      ipv6_probe_hash: sha256Ref(ipv6),
    },
    claims: {
      inherited_parent_processes_absent: processes.succeeded && processes.forbidden.length === 0,
      unauthorized_environment_absent: unexpectedEnvironmentKeys.length === 0
        && processEnvironments.succeeded
        && processEnvironments.forbidden.length === 0,
      credential_files_absent: credentials.succeeded && credentials.count === 0,
      wallet_signing_material_absent: credentials.succeeded && credentials.count === 0,
      inherited_authority_records_absent: credentials.succeeded && credentials.count === 0,
      persistent_mounts_absent: mounts.succeeded && mounts.forbidden.length === 0,
      unauthorized_sockets_absent: sockets.succeeded && sockets.count === 0,
      first_instruction_ipv4_egress_denied: ipv4.local_denial_observed === true,
      first_instruction_ipv6_egress_denied: ipv6.local_denial_observed === true,
      fresh_entropy_verified: entropy.some((byte) => byte !== 0),
      trusted_runtime_artifacts_verified: true,
    },
  });
}

async function writeExclusive(target, bytes, mode) {
  const handle = await open(
    target,
    constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL,
    mode,
  );
  try {
    await handle.writeFile(bytes);
    await handle.sync();
  } finally {
    await handle.close();
  }
}

export async function writeBootEvidence(evidence, options = {}) {
  const evidencePath = options.evidencePath ?? E2B_BOOT_EVIDENCE_PATH;
  const readyPath = options.readyPath ?? E2B_BOOT_READY_PATH;
  if (evidence.status !== 'verified') throw new Error('boot evidence is not verified');
  await mkdir(path.dirname(evidencePath), { recursive: true, mode: 0o700 });
  await writeExclusive(evidencePath, Buffer.from(`${canonicalize(evidence)}\n`), 0o400);
  await writeExclusive(readyPath, Buffer.from(`${evidence.evidence_hash}\n`), 0o400);
}

async function main() {
  const evidence = await collectBootEvidence();
  await writeBootEvidence(evidence);
  await new Promise((resolve) => {
    process.once('SIGTERM', resolve);
    process.once('SIGINT', resolve);
  });
}

const isMain = process.argv[1]
  && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url;
if (isMain) {
  main().catch(() => {
    process.stderr.write('{"status":"failed","code":"E2B_BOOT_GUARD_FAILED"}\n');
    process.exitCode = 1;
  });
}
