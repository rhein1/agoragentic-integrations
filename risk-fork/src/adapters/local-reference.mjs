import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import {
  access,
  copyFile,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  stat,
} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { TextDecoder } from 'node:util';

import { sha256Ref } from '../canonical.mjs';
import { validateLocalReferenceOperation } from '../child-operation.mjs';
import {
  assertFreshForkIdentity,
  networkPolicy,
  verifySavepointCapsule,
} from '../contracts.mjs';
import { RiskForkProvider } from '../provider.mjs';
import {
  assertAllowedKeys,
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

async function enumerateWorkspace(root, { maxFiles, maxBytes }) {
  const records = [];
  const seenCaseFolded = new Map();
  let totalBytes = 0;

  async function visit(directory, prefix = '') {
    const entries = await readdir(directory, { withFileTypes: true });
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
      const absolute = path.join(directory, entry.name);
      const info = await lstat(absolute);
      if (info.isSymbolicLink()) throw new Error(`Symlinks are forbidden: ${relative}`);
      if (info.isDirectory()) {
        await visit(absolute, relative);
        continue;
      }
      if (!info.isFile()) throw new Error(`Special filesystem entry is forbidden: ${relative}`);
      if (info.nlink > 1) throw new Error(`Hard-linked files are forbidden: ${relative}`);
      totalBytes += info.size;
      if (records.length + 1 > maxFiles) throw new Error(`Workspace exceeds ${maxFiles} files`);
      if (totalBytes > maxBytes) throw new Error(`Workspace exceeds ${maxBytes} bytes`);
      const content = await readFile(absolute);
      records.push({
        path: relative,
        bytes: content.byteLength,
        content_hash: sha256Ref(content.toString('base64')),
        source_path: absolute,
      });
    }
  }

  await visit(root);
  const publicRecords = records.map(({ source_path: _sourcePath, ...record }) => record);
  return {
    records,
    public_records: publicRecords,
    file_count: publicRecords.length,
    total_bytes: totalBytes,
    workspace_digest: sha256Ref(publicRecords),
  };
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
  });
  return {
    file_count: snapshot.file_count,
    total_bytes: snapshot.total_bytes,
    workspace_digest: snapshot.workspace_digest,
    files: cloneJson(snapshot.public_records),
  };
}

async function copyRecords(records, destination) {
  for (const record of records) {
    const target = path.join(destination, ...record.path.split('/'));
    await mkdir(path.dirname(target), { recursive: true });
    await copyFile(record.source_path, target);
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

async function runClosedOperation({ workspace, forkId, operation, timeoutMs }) {
  return new Promise((resolve, reject) => {
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
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      child.kill();
      settled = true;
      reject(new Error(`Local reference operation exceeded ${timeoutMs}ms`));
    }, timeoutMs);
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk) => {
      stdout += chunk;
      if (Buffer.byteLength(stdout, 'utf8') > 2 * 1024 * 1024) child.kill();
    });
    child.stderr.on('data', (chunk) => {
      stderr += chunk;
      if (Buffer.byteLength(stderr, 'utf8') > 256 * 1024) child.kill();
    });
    child.on('error', (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(error);
    });
    child.on('close', (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (code !== 0) {
        reject(new Error(`Local reference operation failed: ${stderr.trim().slice(0, 2000)}`));
        return;
      }
      try {
        resolve({ parsed: JSON.parse(stdout), stdout_bytes: Buffer.byteLength(stdout, 'utf8') });
      } catch {
        reject(new Error('Local reference runner returned invalid JSON'));
      }
    });
    child.stdin.end(JSON.stringify(operation));
  });
}

export class LocalReferenceRiskForkAdapter extends RiskForkProvider {
  constructor(options = {}) {
    super({
      id: 'local-reference-v1',
      capabilities: {
        supports_memory_snapshot: false,
        supports_filesystem_snapshot: true,
        supports_live_fork: false,
        supports_network_policy: false,
        supports_egress_allowlist: false,
        supports_runtime_attestation: false,
        supports_suspend_resume: true,
        supports_verified_destruction: true,
        supports_hard_ttl: true,
        supports_idle_ttl: false,
        supports_max_execution_time: true,
        supports_automatic_credential_expiry: false,
        child_credentials_mode: 'prohibited',
        isolation_class: 'local_reference_protocol_simulator',
        adapter_implementation: 'complete',
        mock_conformance: 'passed',
        credentialed_provider_validation: 'not_applicable',
        containment_claim: 'not_isolation',
      },
    });
    this.baseDirectory = options.baseDirectory
      ? path.resolve(options.baseDirectory)
      : null;
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
    this.verifyAuthorityFreeSource = options.verifyAuthorityFreeSource ?? null;
    this.savepoints = new Map();
    this.forks = new Map();
    this.initialized = false;
  }

  async initialize() {
    if (this.initialized) return this;
    if (!this.baseDirectory) {
      this.baseDirectory = await mkdtemp(path.join(os.tmpdir(), 'agoragentic-risk-fork-'));
    } else {
      await mkdir(this.baseDirectory, { recursive: true });
    }
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
    });
    if (!safeEqual(snapshot.workspace_digest, input.capsule.workspace.digest)) {
      throw new Error('Source workspace digest does not match the Savepoint Capsule');
    }
    const authorityAttestation = await verifyLocalAuthorityFreeSnapshot({
      verifier: this.verifyAuthorityFreeSource,
      capsule: input.capsule,
      snapshot,
      snapshotDirectory: sourceWorkspace,
    });
    const id = randomUUID();
    const ref = `local-savepoint:${id}`;
    const directory = assertOwnedPath(
      this.baseDirectory,
      path.join(this.baseDirectory, 'savepoints', id),
    );
    await mkdir(directory, { recursive: false });
    try {
      await copyRecords(snapshot.records, directory);
      const copiedSnapshot = await enumerateWorkspace(directory, {
        maxFiles: this.maxFiles,
        maxBytes: this.maxBytes,
      });
      if (!safeEqual(copiedSnapshot.workspace_digest, snapshot.workspace_digest)) {
        throw new Error('Local savepoint changed while it was being copied');
      }
      const record = {
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
      await rm(directory, { recursive: true, force: true });
      throw error;
    }
  }

  async createFork(input = {}) {
    if (!this.initialized) await this.initialize();
    const savepoint = this.#savepointRecord(requireString(input.savepoint_ref, 'savepoint_ref'));
    if (savepoint.destroyed) throw new Error('Cannot fork a destroyed savepoint');
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
    });
    try {
      await copyRecords(source.records, directory);
    } catch (error) {
      await rm(directory, { recursive: true, force: true });
      throw error;
    }
    const createdAt = this.clock();
    const record = {
      ref,
      directory,
      savepoint_ref: savepoint.ref,
      baseline_digest: source.workspace_digest,
      identity_hash: input.fork_identity.identity_hash,
      network_policy_hash: policy.policy_hash,
      created_at: createdAt.toISOString(),
      expires_at: new Date(createdAt.getTime() + ttlMs).toISOString(),
      status: 'ready',
      last_execution: null,
      destroyed: false,
      ttl_timer: null,
    };
    this.forks.set(ref, record);
    record.ttl_timer = setTimeout(() => {
      this.destroyFork({ fork_ref: ref, reason: 'provider_ttl_expired' }).catch(() => {
        record.status = 'destroy_failed';
      });
    }, ttlMs);
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
  }

  async getForkStatus(input = {}) {
    const record = this.#forkRecord(requireString(input.fork_ref, 'fork_ref'));
    if (!record.destroyed && Date.parse(record.expires_at) <= this.clock().getTime()) {
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
    if (record.destroyed) throw new Error('Cannot execute in a destroyed fork');
    if (record.status === 'suspended') throw new Error('Cannot execute in a suspended fork');
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
    record.status = 'executing';
    const started = this.clock();
    try {
      const execution = await runClosedOperation({
        workspace: record.directory,
        forkId: record.ref,
        operation: cloneJson(operation),
        timeoutMs,
      });
      const completed = this.clock();
      record.status = 'tainted';
      record.last_execution = {
        started_at: started.toISOString(),
        completed_at: completed.toISOString(),
        duration_ms: Math.max(0, completed.getTime() - started.getTime()),
        result_hash: sha256Ref(execution.parsed),
        stdout_bytes: execution.stdout_bytes,
        execution_mode: executionMode,
      };
      return {
        status: 'completed',
        taint_status: 'TAINTED',
        commit_candidate: execution.parsed.commit_candidate,
        result_hash: record.last_execution.result_hash,
        measurements: cloneJson(record.last_execution),
      };
    } catch (error) {
      record.status = 'failed';
      throw error;
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
    });
    const after = await enumerateWorkspace(record.directory, {
      maxFiles: this.maxFiles,
      maxBytes: this.maxBytes,
    });
    const beforeMap = new Map(before.records.map((item) => [item.path, item]));
    const afterMap = new Map(after.records.map((item) => [item.path, item]));
    const paths = [...new Set([...beforeMap.keys(), ...afterMap.keys()])].sort();
    const files = [];
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
      const content = await readFile(newFile.source_path);
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
      baseline_digest: before.workspace_digest,
      fork_workspace_digest: after.workspace_digest,
      diff_hash: sha256Ref(files),
    };
  }

  async suspendFork(input = {}) {
    const record = this.#forkRecord(requireString(input.fork_ref, 'fork_ref'));
    if (record.destroyed) throw new Error('Cannot suspend a destroyed fork');
    record.status = 'suspended';
    return { fork_ref: record.ref, status: 'suspended', evidence_status: 'observed' };
  }

  async destroyFork(input = {}) {
    const record = this.#forkRecord(requireString(input.fork_ref, 'fork_ref'));
    if (!record.destroyed) {
      if (record.ttl_timer) clearTimeout(record.ttl_timer);
      const target = assertOwnedPath(this.baseDirectory, record.directory);
      await rm(target, { recursive: true, force: true });
      record.destroyed = true;
      record.status = 'destroyed';
    }
    return {
      fork_ref: record.ref,
      status: 'destroy_requested_observed',
      evidence_hash: sha256Ref({ fork_ref: record.ref, request: 'destroy' }),
    };
  }

  async verifyDestroyed(input = {}) {
    const record = this.#forkRecord(requireString(input.fork_ref, 'fork_ref'));
    const absent = !(await exists(assertOwnedPath(this.baseDirectory, record.directory)));
    return {
      fork_ref: record.ref,
      status: absent ? 'verified' : 'failed',
      outcome: absent ? 'success' : 'failure',
      evidence_ref: `local-absence:${sha256Ref(record.ref).slice(7, 23)}`,
      evidence_hash: sha256Ref({ fork_ref: record.ref, absent }),
    };
  }

  async destroySavepoint(input = {}) {
    const record = this.#savepointRecord(requireString(input.savepoint_ref, 'savepoint_ref'));
    if (!record.destroyed) {
      await rm(assertOwnedPath(this.baseDirectory, record.directory), { recursive: true, force: true });
      record.destroyed = true;
    }
    return {
      savepoint_ref: record.ref,
      status: 'destroy_requested_observed',
      evidence_hash: sha256Ref({ savepoint_ref: record.ref, request: 'destroy' }),
    };
  }

  async verifySavepointDestroyed(input = {}) {
    const record = this.#savepointRecord(requireString(input.savepoint_ref, 'savepoint_ref'));
    const absent = !(await exists(assertOwnedPath(this.baseDirectory, record.directory)));
    return {
      savepoint_ref: record.ref,
      status: absent ? 'verified' : 'failed',
      outcome: absent ? 'success' : 'failure',
      evidence_ref: `local-savepoint-absence:${sha256Ref(record.ref).slice(7, 23)}`,
      evidence_hash: sha256Ref({ savepoint_ref: record.ref, absent }),
    };
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
