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

import { canonicalize, sha256Ref } from '../canonical.mjs';
import { validateLocalReferenceOperation } from '../child-operation.mjs';
import {
  assertFreshForkIdentity,
  networkPolicy,
  verifySavepointCapsule,
} from '../contracts.mjs';
import { RiskForkProvider } from '../provider.mjs';
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
// Constructor injection is a trusted test seam, never a production provider boundary.
const testOperationRunners = new WeakMap();

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
    this.verifyAuthorityFreeSource = options.verifyAuthorityFreeSource ?? null;
    testOperationRunners.set(this, options.operationRunner ?? startClosedOperation);
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
    const hardDeadlineMs = performance.now() + ttlMs;
    const record = {
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
      ttl_timer: null,
    };
    this.forks.set(ref, record);
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
    const record = this.#forkRecord(requireString(input.fork_ref, 'fork_ref'));
    if (!record.destroy_promise) {
      const attempt = this.#destroyForkRecord(record);
      record.destroy_promise = attempt;
      try {
        return await attempt;
      } catch (error) {
        if (record.destroy_promise === attempt) record.destroy_promise = null;
        throw error;
      }
    }
    return record.destroy_promise;
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
