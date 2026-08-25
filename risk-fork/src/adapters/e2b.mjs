import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import { fileURLToPath } from 'node:url';

import { canonicalize, sha256Ref } from '../canonical.mjs';
import { validateChildOperation } from '../child-operation.mjs';
import {
  E2B_BIRTH_MAX_VALIDITY_MS,
  E2B_BOOT_EVIDENCE_PATH,
  E2B_BOOT_READY_PATH,
  createE2BBirthRequest,
  e2bBirthRequestPaths,
  validateBootObservationEnvelope,
  validateE2BBirthAttestation,
  validateE2BBirthRequest,
} from '../../e2b-template/lib/runtime-contract.mjs';
import {
  createE2BRuntimeSdkIntegrityVerifier,
  isE2BRuntimeSdkIntegrityVerifier,
  loadVerifiedE2BRuntimeSdk,
  validateE2BQualificationEvidence,
  verifyE2BQualificationTrust,
} from '../e2b-qualification.mjs';
import {
  assertFreshForkIdentity,
  networkPolicy,
  verifySavepointCapsule,
} from '../contracts.mjs';
import { RiskForkProvider } from '../provider.mjs';
import {
  AGORAGENTIC_GENERATED_API_KEY_PATTERN,
  BEARER_CREDENTIAL_PATTERN,
  EMBEDDED_CREDENTIAL_TOKEN_PATTERN,
  GENERIC_CREDENTIAL_TOKEN_PATTERN,
  assertAllowedKeys,
  assertPlainObject,
  boundedInteger,
  cloneJson,
  deepFreeze,
  requireOpaqueRef,
  requireSha256Ref,
  requireString,
  safeEqual,
} from '../util.mjs';
import { E2BCleanupJournal } from './e2b-cleanup-journal.mjs';
import {
  createImmutableWorkspaceExport,
  destroyImmutableWorkspaceExport,
  readImmutableWorkspaceExport,
  verifyImmutableWorkspaceExportDestroyed,
} from './e2b-workspace-export.mjs';

const IDENTITY_PATH = '/tmp/agoragentic-risk-fork-v1.identity.json';
const JOB_PATH = '/tmp/agoragentic-risk-fork-v1.job.json';
const RESULT_PATH = '/tmp/agoragentic-risk-fork-v1.result.json';
const WORKSPACE_ROOT = '/workspace/agoragentic-risk-fork-v1';
const DEFAULT_BOOTSTRAP_COMMAND =
  '/opt/agoragentic/risk-fork/bin/bootstrap --identity /tmp/agoragentic-risk-fork-v1.identity.json';
const DEFAULT_RUNNER_COMMAND = '/opt/agoragentic/risk-fork/bin/run';
const MAX_JOB_BYTES = 1024 * 1024;
const MAX_RESULT_BYTES = 4 * 1024 * 1024;
const MAX_ATTESTATION_BYTES = 128 * 1024;
const DEFAULT_BIRTH_ATTESTATION_TIMEOUT_MS = 10_000;
const MAX_RESULT_STREAM_IDLE_TIMEOUT_MS = 5_000;
const MIN_RESULT_STREAM_IDLE_TIMEOUT_MS = 50;
const MAX_JSON_NODES = 20_000;
const MAX_JSON_DEPTH = 50;
const MAX_LIST_PAGES = 100;
const EXECUTION_CLEANUP_MARGIN_MS = 5_000;
const PROFILE_METADATA_SCHEMA = 'agoragentic.risk-fork.e2b-clean-template.v1';
const EMPTY_WORKSPACE_DIGEST = sha256Ref([]);
// E2B SDK 2.39.0 defines this IPv4-shaped CIDR as its `allTraffic`
// sentinel and equates allowInternetAccess=false with denying it. Whether the
// provider also blocks every IPv6 path is deliberately not inferred from that
// SDK contract. Qualified mode additionally requires closed, exact-bound live
// evidence for both IP families and every mandatory lifecycle control.
const E2B_SDK_ALL_TRAFFIC_SENTINEL = '0.0.0.0/0';

export const E2B_SECURE_SNAPSHOT_PROFILE_UNAVAILABLE =
  'E2B_SECURE_SNAPSHOT_PROFILE_UNAVAILABLE';
export const E2B_LIVE_FORK_DISABLED_UNTRUSTED_WATCHER =
  'E2B_LIVE_FORK_DISABLED_UNTRUSTED_WATCHER';

// The captured template watcher and its outbox run under the same sandbox UID
// as child code. Until the provider supplies a separately privileged producer
// plus externally verifiable privilege separation, production allocation must
// remain impossible from source. `offlineConformance` below is a mock-only seam
// requiring an injected SandboxClass and cannot carry qualification evidence.
const E2B_LIVE_FORK_SOURCE_ENABLED = false;

function secureSnapshotProfileUnavailable(operation) {
  const error = new Error(
    'E2B secure Risk Fork snapshot profile is unavailable; the adapter is fail-closed',
  );
  error.name = 'E2BSecureSnapshotProfileUnavailableError';
  error.code = E2B_SECURE_SNAPSHOT_PROFILE_UNAVAILABLE;
  error.operation = operation;
  error.provider = 'e2b-snapshot-v1';
  error.retryable = false;
  error.production_qualified = false;
  return error;
}

function reconciliationRequired(unresolved) {
  const error = new Error('E2B cleanup reconciliation remains unresolved; allocation is blocked');
  error.name = 'E2BCleanupReconciliationRequiredError';
  error.code = 'E2B_CLEANUP_RECONCILIATION_REQUIRED';
  error.unresolved_count = unresolved.length;
  error.retryable = true;
  error.production_qualified = false;
  return error;
}

const SECRET_KEY_PATTERN = /(?:api[_-]?key|access[_-]?token|refresh[_-]?token|authorization|credential|password|private[_-]?key|seed[_-]?phrase|wallet)/i;
const SECRET_VALUE_PATTERNS = Object.freeze([
  /-----BEGIN [A-Z ]*PRIVATE KEY-----/,
  BEARER_CREDENTIAL_PATTERN,
  AGORAGENTIC_GENERATED_API_KEY_PATTERN,
  EMBEDDED_CREDENTIAL_TOKEN_PATTERN,
  GENERIC_CREDENTIAL_TOKEN_PATTERN,
  /\be2b_[A-Za-z0-9_-]{12,}/,
  /\bAKIA[0-9A-Z]{16}\b/,
  /[?&](?:api[_-]?key|access[_-]?token|authorization)=[^&\s]{8,}/i,
]);
const DANGEROUS_JSON_KEYS = new Set(['__proto__', 'constructor', 'prototype']);

async function defaultSdkLoader() {
  return import('e2b');
}

async function defaultSdkVersionLoader() {
  const entry = fileURLToPath(import.meta.resolve('e2b'));
  let directory = path.dirname(entry);
  for (let depth = 0; depth < 8; depth += 1) {
    const manifestPath = path.join(directory, 'package.json');
    try {
      const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
      if (manifest.name === 'e2b') return manifest.version;
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error;
    }
    const parent = path.dirname(directory);
    if (parent === directory) break;
    directory = parent;
  }
  throw new Error('Unable to resolve the installed e2b package manifest');
}

function normalizeSandboxClass(moduleValue) {
  const Sandbox = moduleValue?.Sandbox
    ?? moduleValue?.default?.Sandbox
    ?? moduleValue?.default;
  if (!Sandbox || typeof Sandbox !== 'function') {
    throw new TypeError('The E2B SDK must export a Sandbox class');
  }
  return Sandbox;
}

function requireFixedCommand(value, field) {
  const command = requireString(value, field, { maxLength: 1_000 });
  if (command.includes('\0') || command.includes('\n') || command.includes('\r')) {
    throw new TypeError(`${field} must be one fixed command line`);
  }
  return command;
}

function notFoundStatus(error) {
  return error?.status
    ?? error?.statusCode
    ?? error?.response?.status
    ?? error?.cause?.status;
}

function isRemoteFileNotFound(error) {
  const status = notFoundStatus(error);
  const code = String(error?.code ?? '').toUpperCase();
  const name = String(error?.name ?? '').toUpperCase();
  return status === 404
    || code === 'ENOENT'
    || code === 'NOT_FOUND'
    || name === 'FILENOTFOUNDERROR';
}

function isSandboxNotFound(error) {
  const status = notFoundStatus(error);
  const code = String(error?.code ?? '').toUpperCase();
  const name = String(error?.name ?? '').toUpperCase();
  return status === 404
    || code === 'SANDBOX_NOT_FOUND'
    || name === 'SANDBOXNOTFOUNDERROR';
}

function errorCode(error, fallback) {
  return String(error?.code ?? error?.name ?? fallback).slice(0, 200);
}

async function withControllerDeadline(promise, timeoutMs) {
  let timeoutHandle;
  const timeout = new Promise((resolve, reject) => {
    timeoutHandle = setTimeout(() => {
      const error = new Error(`E2B controller execution timeout after ${timeoutMs}ms`);
      error.code = 'E2B_CONTROLLER_EXECUTION_TIMEOUT';
      reject(error);
    }, timeoutMs);
  });
  try {
    return await Promise.race([promise, timeout]);
  } finally {
    clearTimeout(timeoutHandle);
  }
}

function resultStreamFailure(code, message, retainedBytes, maxBytes) {
  const error = new Error(message);
  error.code = code;
  error.retained_bytes = retainedBytes;
  error.max_bytes = maxBytes;
  error.retryable = false;
  error.production_qualified = false;
  return error;
}

async function withResultStreamDeadline(promise, timeoutMs, makeError) {
  let timeoutHandle;
  const timeout = new Promise((resolve, reject) => {
    timeoutHandle = setTimeout(() => reject(makeError()), Math.max(1, timeoutMs));
  });
  try {
    return await Promise.race([promise, timeout]);
  } finally {
    clearTimeout(timeoutHandle);
  }
}

async function readBoundedResultBytes(files, target, options) {
  const maxBytes = boundedInteger(options.maxBytes, 'result stream max bytes', {
    min: 1,
    max: MAX_RESULT_BYTES,
  });
  const totalTimeoutMs = boundedInteger(
    options.totalTimeoutMs,
    'result stream total timeout',
    { min: 1, max: 10 * 60 * 1_000 },
  );
  const idleTimeoutMs = boundedInteger(
    options.idleTimeoutMs,
    'result stream idle timeout',
    { min: 1, max: MAX_RESULT_STREAM_IDLE_TIMEOUT_MS },
  );
  const startedAt = performance.now();
  const controller = new AbortController();
  // A fixed backing buffer keeps provider-controlled chunk fragmentation from
  // turning a 4 MiB byte allowance into millions of retained Buffer objects.
  const retained = Buffer.alloc(maxBytes);
  let retainedBytes = 0;
  let reader;
  let failure;

  const remainingTotalMs = () => Math.floor(
    totalTimeoutMs - (performance.now() - startedAt),
  );
  const totalTimeoutError = () => resultStreamFailure(
    'E2B_RESULT_STREAM_TOTAL_TIMEOUT',
    `E2B runner result stream exceeded its ${totalTimeoutMs}ms total deadline`,
    retainedBytes,
    maxBytes,
  );
  const idleTimeoutError = () => resultStreamFailure(
    'E2B_RESULT_STREAM_IDLE_TIMEOUT',
    `E2B runner result stream stalled for ${idleTimeoutMs}ms`,
    retainedBytes,
    maxBytes,
  );

  try {
    const stream = await withResultStreamDeadline(
      files.read(target, {
        format: 'stream',
        requestTimeoutMs: totalTimeoutMs,
        streamIdleTimeoutMs: idleTimeoutMs,
        signal: controller.signal,
      }),
      totalTimeoutMs,
      totalTimeoutError,
    );
    if (!stream || typeof stream.getReader !== 'function') {
      throw resultStreamFailure(
        'E2B_RESULT_STREAM_INVALID',
        'E2B runner result did not expose the required byte stream',
        retainedBytes,
        maxBytes,
      );
    }
    reader = stream.getReader();
    if (!reader || typeof reader.read !== 'function' || typeof reader.cancel !== 'function') {
      throw resultStreamFailure(
        'E2B_RESULT_STREAM_INVALID',
        'E2B runner result stream reader is invalid',
        retainedBytes,
        maxBytes,
      );
    }

    while (true) {
      const remainingMs = remainingTotalMs();
      if (remainingMs <= 0) throw totalTimeoutError();
      const readTimeoutMs = Math.min(idleTimeoutMs, remainingMs);
      const makeTimeoutError = remainingMs <= idleTimeoutMs
        ? totalTimeoutError
        : idleTimeoutError;
      const next = await withResultStreamDeadline(
        Promise.resolve().then(() => reader.read()),
        readTimeoutMs,
        makeTimeoutError,
      );
      if (next?.done === true) break;
      const chunk = next?.value;
      if (!(chunk instanceof Uint8Array)) {
        throw resultStreamFailure(
          'E2B_RESULT_STREAM_INVALID',
          'E2B runner result stream emitted a non-byte chunk',
          retainedBytes,
          maxBytes,
        );
      }
      if (chunk.byteLength > maxBytes - retainedBytes) {
        const error = resultStreamFailure(
          'E2B_RESULT_STREAM_LIMIT_EXCEEDED',
          `E2B runner result exceeds ${maxBytes} bytes`,
          retainedBytes,
          maxBytes,
        );
        error.rejected_chunk_bytes = chunk.byteLength;
        throw error;
      }
      if (chunk.byteLength > 0) {
        // Copy only accepted bytes so a small view cannot retain an oversized
        // provider-owned backing buffer in the clean controller.
        retained.set(chunk, retainedBytes);
        retainedBytes += chunk.byteLength;
      }
    }
    return retained.subarray(0, retainedBytes);
  } catch (error) {
    failure = error;
    throw error;
  } finally {
    if (failure) {
      controller.abort(failure);
      if (reader && typeof reader.cancel === 'function') {
        const cancellation = Promise.resolve()
          .then(() => reader.cancel(failure))
          .catch(() => {});
        let cancellationTimer;
        await Promise.race([
          cancellation,
          new Promise((resolve) => {
            cancellationTimer = setTimeout(
              resolve,
              Math.min(idleTimeoutMs, 100),
            );
          }),
        ]);
        clearTimeout(cancellationTimer);
      }
    } else if (reader && typeof reader.releaseLock === 'function') {
      reader.releaseLock();
    }
  }
}

function assertStrictSecretFreeJson(value, field, limits = {}) {
  const maxBytes = limits.maxBytes ?? MAX_JOB_BYTES;
  let nodes = 0;
  const active = new Set();

  function walk(current, currentPath, depth) {
    nodes += 1;
    if (nodes > MAX_JSON_NODES) throw new TypeError(`${field} is too complex`);
    if (depth > MAX_JSON_DEPTH) throw new TypeError(`${field} is too deeply nested`);
    if (current === null || typeof current === 'boolean') return;
    if (typeof current === 'string') {
      if (SECRET_VALUE_PATTERNS.some((pattern) => pattern.test(current))) {
        throw new TypeError(`${currentPath} contains secret-shaped material`);
      }
      return;
    }
    if (typeof current === 'number') {
      if (!Number.isFinite(current) || !Number.isSafeInteger(current)) {
        throw new TypeError(`${currentPath} must be a finite safe integer`);
      }
      return;
    }
    if (!current || typeof current !== 'object') {
      throw new TypeError(`${currentPath} is not strict JSON`);
    }
    if (active.has(current)) throw new TypeError(`${currentPath} contains a cycle`);
    active.add(current);
    if (Array.isArray(current)) {
      for (let index = 0; index < current.length; index += 1) {
        if (!Object.hasOwn(current, index)) throw new TypeError(`${currentPath} contains an array hole`);
        walk(current[index], `${currentPath}[${index}]`, depth + 1);
      }
    } else {
      assertPlainObject(current, currentPath);
      for (const [key, child] of Object.entries(current)) {
        if (SECRET_VALUE_PATTERNS.some((pattern) => pattern.test(key))) {
          throw new TypeError(`${currentPath}.<key> contains secret-shaped material`);
        }
        if (DANGEROUS_JSON_KEYS.has(key)) {
          throw new TypeError(`${currentPath}.<key> is a forbidden JSON key`);
        }
        if (SECRET_KEY_PATTERN.test(key)) {
          throw new TypeError(`${currentPath}.<key> is an authority or secret-bearing field`);
        }
        walk(child, `${currentPath}.<value>`, depth + 1);
      }
    }
    active.delete(current);
  }

  walk(value, field, 0);
  const serialized = JSON.stringify(value);
  if (Buffer.byteLength(serialized, 'utf8') > maxBytes) {
    throw new TypeError(`${field} exceeds ${maxBytes} bytes`);
  }
  return JSON.parse(serialized);
}

function assertCommandSucceeded(result, field) {
  assertPlainObject(result, field);
  if (result.exitCode !== 0 || result.error) throw new Error(`${field} failed`);
}

function commandMeasurements(result) {
  return {
    exit_code: Number.isSafeInteger(result?.exitCode) ? result.exitCode : null,
    stdout_bytes: typeof result?.stdout === 'string'
      ? Buffer.byteLength(result.stdout, 'utf8')
      : null,
    stderr_bytes: typeof result?.stderr === 'string'
      ? Buffer.byteLength(result.stderr, 'utf8')
      : null,
    raw_stdout_included: false,
    raw_stderr_included: false,
  };
}

function exactMetadata(record, forkIdentity, policy, trustedRuntime, templateHash) {
  const metadata = {
    'agoragentic.risk_fork.schema': 'v1',
    'agoragentic.risk_fork.profile': PROFILE_METADATA_SCHEMA,
    'agoragentic.risk_fork.cleanup_ref': record.cleanup_ref,
    'agoragentic.risk_fork.capsule_hash': record.capsule_hash,
    'agoragentic.risk_fork.workspace_manifest_hash': record.export_record.manifest_hash,
    'agoragentic.risk_fork.identity_hash': forkIdentity.identity_hash,
    'agoragentic.risk_fork.network_policy_hash': policy.policy_hash,
    'agoragentic.risk_fork.template_hash': templateHash,
    'agoragentic.risk_fork.bootstrap_artifact_hash': trustedRuntime.bootstrapArtifactHash,
    'agoragentic.risk_fork.runner_artifact_hash': trustedRuntime.runnerArtifactHash,
  };
  // Every value is generated by the clean controller and is independently
  // validated before this point. Do not run the untrusted-payload scanner here:
  // E2B credentials and our non-secret cleanup references intentionally share
  // the `e2b_` prefix. Keep the provider metadata bounded instead.
  if (Buffer.byteLength(JSON.stringify(metadata), 'utf8') > 8_192) {
    throw new TypeError('E2B metadata exceeds 8192 bytes');
  }
  return metadata;
}

function assertExactMetadata(actual, expected, field) {
  assertPlainObject(actual, `${field}.metadata`);
  const expectedKeys = Object.keys(expected).sort();
  const actualKeys = Object.keys(actual).sort();
  if (actualKeys.length !== expectedKeys.length
    || actualKeys.some((key, index) => key !== expectedKeys[index])) {
    throw new Error(`${field} metadata does not exactly match the clean-controller request`);
  }
  for (const key of expectedKeys) {
    if (actual[key] !== expected[key]) throw new Error(`${field} metadata binding mismatch`);
  }
}

export function validateE2BSandboxInfo(info, expected = {}) {
  const field = expected.field ?? 'E2B sandbox';
  assertPlainObject(info, field);
  const sandboxId = requireString(
    info.sandboxId ?? info.sandboxID,
    `${field}.sandboxId`,
    { maxLength: 500 },
  );
  if (sandboxId !== expected.sandboxId) throw new Error(`${field} sandbox identity mismatch`);
  const templateId = requireString(
    info.templateId ?? info.templateID,
    `${field}.templateId`,
    { maxLength: 500 },
  );
  if (templateId !== expected.templateId) throw new Error(`${field} clean template identity mismatch`);
  if (info.state !== 'running') throw new Error(`${field} is not running`);
  if (info.allowInternetAccess !== false) {
    throw new Error(`${field} does not prove allowInternetAccess=false`);
  }
  assertPlainObject(info.network, `${field}.network`);
  if (!Array.isArray(info.network.allowOut) || info.network.allowOut.length !== 0) {
    throw new Error(`${field} reports outbound network allowances`);
  }
  if (!Array.isArray(info.network.denyOut)
    || info.network.denyOut.length !== 1
    || info.network.denyOut[0] !== E2B_SDK_ALL_TRAFFIC_SENTINEL) {
    throw new Error(`${field} does not report the exact deny-all network rule`);
  }
  if (info.network.allowPublicTraffic !== false) {
    throw new Error(`${field} does not prove public traffic is disabled`);
  }
  assertPlainObject(info.lifecycle, `${field}.lifecycle`);
  if (info.lifecycle.onTimeout !== 'kill' || info.lifecycle.autoResume !== false) {
    throw new Error(`${field} does not prove kill-on-timeout with auto-resume disabled`);
  }
  if (!Array.isArray(info.volumeMounts) || info.volumeMounts.length !== 0) {
    throw new Error(`${field} does not prove zero persistent mounts`);
  }
  assertExactMetadata(info.metadata, expected.metadata, field);
  const parsedEndAt = info.endAt instanceof Date ? info.endAt.getTime() : Date.parse(info.endAt);
  const hardExpiresAtMs = expected.hardExpiresAtMs
    ?? expected.createdAtMs + expected.ttlMs;
  if (!Number.isFinite(parsedEndAt)
    || parsedEndAt <= expected.createdAtMs
    || parsedEndAt > hardExpiresAtMs + 5_000) {
    throw new Error(`${field} TTL deadline is outside the clean-controller bound`);
  }
  if (expected.leaseRequestedAtMs !== undefined
    && expected.leaseTimeoutMs !== undefined) {
    const expectedLeaseEnd = expected.leaseRequestedAtMs + expected.leaseTimeoutMs;
    if (parsedEndAt < expectedLeaseEnd - 5_000 || parsedEndAt > expectedLeaseEnd + 5_000) {
      throw new Error(`${field} provider lease deadline does not match the requested timeout`);
    }
  }
  const observation = {
    sandbox_id_hash: sha256Ref(sandboxId),
    template_id_hash: sha256Ref(templateId),
    metadata_hash: sha256Ref(expected.metadata),
    network_status: 'exact_sdk_ipv4_sentinel_observed_ipv6_unqualified',
    volume_mount_status: 'provider_reported_zero_observed',
    lifecycle_status: 'provider_reported_kill_no_auto_resume_observed',
    deadline: new Date(parsedEndAt).toISOString(),
  };
  return deepFreeze({ ...observation, observation_hash: sha256Ref(observation) });
}

function birthHandshakeError(code, message) {
  const error = new Error(message);
  error.code = code;
  error.retryable = false;
  error.production_qualified = false;
  return error;
}

function liveForkDisabledUntrustedWatcher(operation) {
  const error = new Error(
    'E2B live Risk Fork allocation is disabled: the captured birth watcher is not a trusted authority boundary',
  );
  error.name = 'E2BLiveForkDisabledUntrustedWatcherError';
  error.code = E2B_LIVE_FORK_DISABLED_UNTRUSTED_WATCHER;
  error.operation = operation;
  error.provider = 'e2b-clean-template-v1';
  error.retryable = false;
  error.production_qualified = false;
  return error;
}

function parseCanonicalRuntimeEnvelope(bytes, field, maxBytes) {
  if (!(bytes instanceof Uint8Array) || bytes.byteLength < 3 || bytes.byteLength > maxBytes) {
    throw birthHandshakeError(
      'E2B_BIRTH_ARTIFACT_INVALID',
      `${field} is missing or outside its byte bound`,
    );
  }
  const text = Buffer.from(bytes).toString('utf8');
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw birthHandshakeError('E2B_BIRTH_ARTIFACT_INVALID', `${field} is not valid JSON`);
  }
  if (text !== `${canonicalize(parsed)}\n`) {
    throw birthHandshakeError(
      'E2B_BIRTH_ARTIFACT_INVALID',
      `${field} bytes are not canonical`,
    );
  }
  return parsed;
}

async function assertRemoteBirthArtifactAbsent(files, target, timeoutMs) {
  try {
    await readBoundedResultBytes(files, target, {
      maxBytes: MAX_ATTESTATION_BYTES,
      totalTimeoutMs: Math.max(1, timeoutMs),
      idleTimeoutMs: Math.max(1, Math.min(250, timeoutMs)),
    });
  } catch (error) {
    if (isRemoteFileNotFound(error)) return;
    throw birthHandshakeError(
      'E2B_BIRTH_PREFLIGHT_AMBIGUOUS',
      `E2B birth preflight could not prove ${target} absent`,
    );
  }
  throw birthHandshakeError(
    'E2B_BIRTH_PREEXISTING_STATE',
    `E2B birth preflight found preexisting state at ${target}`,
  );
}

/**
 * Complete the one-use handshake with the captured template birth watcher.
 * The caller must first exact-bind Sandbox.getInfo and must not upload identity,
 * workspace data, commands, credentials, or other authority before this returns.
 */
export async function performE2BSandboxBirthHandshake(options = {}) {
  const sandbox = options.sandbox;
  if (!sandbox || typeof sandbox !== 'object' || !sandbox.files) {
    throw new TypeError('E2B birth handshake requires an allocated sandbox filesystem');
  }
  const files = sandbox.files;
  if (typeof files.write !== 'function' || typeof files.read !== 'function') {
    throw new TypeError('E2B birth handshake requires file write and read operations');
  }
  const sandboxId = requireOpaqueRef(options.sandboxId, 'E2B birth sandboxId', {
    maxLength: 500,
  });
  if (sandbox.sandboxId != null && sandbox.sandboxId !== sandboxId) {
    throw new Error('E2B birth sandbox identity does not match the allocated handle');
  }
  assertPlainObject(options.metadata, 'E2B birth provider metadata');
  const templateId = requireOpaqueRef(options.templateId, 'E2B birth templateId', {
    maxLength: 500,
  });
  const templateEvidenceHash = requireSha256Ref(
    options.templateEvidenceHash,
    'E2B birth templateEvidenceHash',
  );
  const templateProvenanceHash = requireSha256Ref(
    options.templateProvenanceHash,
    'E2B birth templateProvenanceHash',
  );
  const bootstrapArtifactHash = requireSha256Ref(
    options.bootstrapArtifactHash,
    'E2B birth bootstrapArtifactHash',
  );
  const runnerArtifactHash = requireSha256Ref(
    options.runnerArtifactHash,
    'E2B birth runnerArtifactHash',
  );
  const clock = options.clock ?? (() => new Date());
  if (typeof clock !== 'function') throw new TypeError('E2B birth handshake clock is invalid');
  const allocationStartedAt = new Date(options.allocationStartedAt);
  if (!Number.isFinite(allocationStartedAt.getTime())) {
    throw new TypeError('E2B birth allocationStartedAt is invalid');
  }
  const timeoutMs = boundedInteger(
    options.timeoutMs ?? DEFAULT_BIRTH_ATTESTATION_TIMEOUT_MS,
    'E2B birth attestation timeout',
    { min: 50, max: E2B_BIRTH_MAX_VALIDITY_MS },
  );
  const wallStartedAt = performance.now();
  const remainingMs = () => Math.floor(timeoutMs - (performance.now() - wallStartedAt));
  const now = new Date(clock());
  if (!Number.isFinite(now.getTime())
    || now.getTime() < allocationStartedAt.getTime()
    || now.getTime() >= allocationStartedAt.getTime() + E2B_BIRTH_MAX_VALIDITY_MS) {
    throw birthHandshakeError(
      'E2B_BIRTH_ALLOCATION_STALE',
      'E2B birth request cannot be opened outside the post-allocation validity window',
    );
  }
  const request = createE2BBirthRequest({
    sandbox_id_hash: sha256Ref(sandboxId),
    provider_metadata_hash: sha256Ref(options.metadata),
    template_id_hash: sha256Ref(templateId),
    template_evidence_hash: templateEvidenceHash,
    template_provenance_hash: templateProvenanceHash,
    allocation_started_at: allocationStartedAt.toISOString(),
    expires_at: new Date(
      allocationStartedAt.getTime() + E2B_BIRTH_MAX_VALIDITY_MS,
    ).toISOString(),
    birth_nonce: randomUUID(),
  });
  const paths = e2bBirthRequestPaths(request.request_hash);
  for (const target of [
    E2B_BOOT_EVIDENCE_PATH,
    E2B_BOOT_READY_PATH,
    paths.request,
    paths.trigger,
    paths.consumed,
    paths.consumed_trigger,
    paths.attestation,
  ]) {
    const remaining = remainingMs();
    if (remaining <= 0) {
      throw birthHandshakeError(
        'E2B_BIRTH_ATTESTATION_TIMEOUT',
        'E2B birth preflight exceeded its controller deadline',
      );
    }
    await assertRemoteBirthArtifactAbsent(files, target, remaining);
  }

  await files.write(paths.request, `${canonicalize(request)}\n`);
  await files.write(paths.trigger, `${request.request_hash}\n`);
  let attestationBytes;
  while (remainingMs() > 0) {
    const remaining = remainingMs();
    try {
      attestationBytes = await readBoundedResultBytes(files, paths.attestation, {
        maxBytes: MAX_ATTESTATION_BYTES,
        totalTimeoutMs: Math.max(1, remaining),
        idleTimeoutMs: Math.max(1, Math.min(250, remaining)),
      });
      break;
    } catch (error) {
      if (!isRemoteFileNotFound(error)) {
        throw birthHandshakeError(
          'E2B_BIRTH_ATTESTATION_AMBIGUOUS',
          'E2B birth attestation could not be read unambiguously',
        );
      }
      await new Promise((resolve) => setTimeout(resolve, Math.min(25, remaining)));
    }
  }
  if (!attestationBytes) {
    throw birthHandshakeError(
      'E2B_BIRTH_ATTESTATION_TIMEOUT',
      'E2B birth watcher did not attest before the controller deadline',
    );
  }
  const remaining = remainingMs();
  if (remaining <= 0) {
    throw birthHandshakeError(
      'E2B_BIRTH_ATTESTATION_TIMEOUT',
      'E2B birth evidence read exceeded the controller deadline',
    );
  }
  let bootEvidenceBytes;
  try {
    bootEvidenceBytes = await readBoundedResultBytes(files, E2B_BOOT_EVIDENCE_PATH, {
      maxBytes: MAX_ATTESTATION_BYTES,
      totalTimeoutMs: Math.max(1, remaining),
      idleTimeoutMs: Math.max(1, Math.min(250, remaining)),
    });
  } catch {
    throw birthHandshakeError(
      'E2B_BIRTH_ATTESTATION_AMBIGUOUS',
      'E2B birth attestation exists without readable boot evidence',
    );
  }
  const attestationValue = parseCanonicalRuntimeEnvelope(
    attestationBytes,
    'E2B birth attestation',
    MAX_ATTESTATION_BYTES,
  );
  const bootEvidenceValue = parseCanonicalRuntimeEnvelope(
    bootEvidenceBytes,
    'E2B boot evidence',
    MAX_ATTESTATION_BYTES,
  );
  const verifiedAt = new Date(clock());
  const verifiedRequest = validateE2BBirthRequest(request, {
    sandboxIdHash: sha256Ref(sandboxId),
    providerMetadataHash: sha256Ref(options.metadata),
    templateIdHash: sha256Ref(templateId),
    templateEvidenceHash,
    templateProvenanceHash,
    allocationStartedAt: allocationStartedAt.toISOString(),
    requestHash: request.request_hash,
    now: verifiedAt,
  });
  const bootEvidence = validateBootObservationEnvelope(bootEvidenceValue, {
    now: verifiedAt,
    bootstrapArtifactHash,
    runnerArtifactHash,
  });
  const attestation = validateE2BBirthAttestation(attestationValue, {
    request: verifiedRequest,
    bootEvidence,
    bootstrapArtifactHash,
    runnerArtifactHash,
    now: verifiedAt,
  });
  return deepFreeze({
    request: verifiedRequest,
    request_path: paths.request,
    trigger_path: paths.trigger,
    attestation,
    bootEvidence,
  });
}

function validateSourceAttestation(result, request, expected = {}) {
  assertPlainObject(result, 'authority-free source attestation');
  assertAllowedKeys(result, [
    'schema',
    'status',
    'request_hash',
    'evidence_ref',
    'evidence_hash',
    'workspace_digest',
    'workspace_manifest_hash',
    'trusted_bootstrap_artifact_hash',
    'trusted_runner_artifact_hash',
    'claims',
  ], 'authority-free source attestation');
  if (result.schema !== 'agoragentic.risk-fork.authority-free-source-attestation.v1'
    || result.status !== 'verified') {
    throw new Error('An externally verified authority-free source attestation is required');
  }
  for (const [field, wanted] of [
    ['request_hash', request.request_hash],
    ['workspace_digest', request.workspace_digest],
    ['workspace_manifest_hash', request.workspace_manifest_hash],
    ['trusted_bootstrap_artifact_hash', expected.trustedBootstrapArtifactHash],
    ['trusted_runner_artifact_hash', expected.trustedRunnerArtifactHash],
  ]) {
    requireSha256Ref(result[field], `authority-free source attestation.${field}`);
    if (!safeEqual(result[field], wanted)) {
      throw new Error(`Authority-free source attestation binding mismatch: ${field}`);
    }
  }
  requireOpaqueRef(result.evidence_ref, 'authority-free source attestation.evidence_ref');
  requireSha256Ref(result.evidence_hash, 'authority-free source attestation.evidence_hash');
  assertAllowedKeys(result.claims, [
    'authority_free',
    'credentials_absent',
    'wallet_material_absent',
    'execution_authority_absent',
    'workspace_manifest_verified',
    'immutable_export_verified',
    'trusted_runtime_artifacts_verified',
  ], 'authority-free source attestation.claims');
  for (const claim of [
    'authority_free',
    'credentials_absent',
    'wallet_material_absent',
    'execution_authority_absent',
    'workspace_manifest_verified',
    'immutable_export_verified',
    'trusted_runtime_artifacts_verified',
  ]) {
    if (result.claims[claim] !== true) {
      throw new Error(`Authority-free source attestation must verify ${claim}`);
    }
  }
  const normalized = cloneJson(result);
  return deepFreeze({ ...normalized, attestation_hash: sha256Ref(normalized) });
}

const BOOTSTRAP_CLAIMS = Object.freeze([
  'inherited_parent_processes_absent',
  'unauthorized_environment_absent',
  'credential_files_absent',
  'wallet_signing_material_absent',
  'inherited_authority_records_absent',
  'persistent_mounts_absent',
  'unauthorized_sockets_absent',
  'network_policy_enforced',
  'fresh_fork_identity_verified',
  'fresh_session_nonce_verified',
  'fresh_entropy_verified',
  'workspace_manifest_verified',
  'trusted_runtime_artifacts_verified',
]);

function parseBootstrapAttestation(commandResult, expected, now) {
  assertCommandSucceeded(commandResult, 'E2B trusted bootstrap command');
  if (typeof commandResult.stdout !== 'string'
    || Buffer.byteLength(commandResult.stdout, 'utf8') > MAX_ATTESTATION_BYTES) {
    throw new Error('E2B bootstrap attestation is missing or oversized');
  }
  let result;
  try {
    result = JSON.parse(commandResult.stdout);
  } catch {
    throw new Error('E2B trusted bootstrap returned invalid JSON');
  }
  assertPlainObject(result, 'E2B child bootstrap attestation');
  assertAllowedKeys(result, [
    'schema',
    'phase',
    'status',
    'bootstrap_request_hash',
    'child_sandbox_id_hash',
    'template_id_hash',
    'template_evidence_hash',
    'capsule_hash',
    'identity_hash',
    'network_policy_hash',
    'metadata_hash',
    'workspace_digest',
    'trusted_bootstrap_artifact_hash',
    'trusted_runner_artifact_hash',
    'boot_evidence_hash',
    'attested_at',
    'expires_at',
    'claims',
  ], 'E2B child bootstrap attestation');
  if (result.schema !== 'agoragentic.risk-fork.child-bootstrap-attestation.v1'
    || result.phase !== expected.phase
    || result.status !== 'verified') {
    throw new Error(`E2B ${expected.phase} bootstrap attestation is not verified`);
  }
  for (const [field, wanted] of Object.entries({
    bootstrap_request_hash: expected.bootstrapRequestHash,
    child_sandbox_id_hash: sha256Ref(expected.sandboxId),
    template_id_hash: sha256Ref(expected.templateId),
    template_evidence_hash: expected.templateHash,
    capsule_hash: expected.capsuleHash,
    identity_hash: expected.identityHash,
    network_policy_hash: expected.networkPolicyHash,
    metadata_hash: sha256Ref(expected.metadata),
    workspace_digest: expected.workspaceDigest,
    trusted_bootstrap_artifact_hash: expected.bootstrapArtifactHash,
    trusted_runner_artifact_hash: expected.runnerArtifactHash,
  })) {
    requireSha256Ref(result[field], `child bootstrap attestation.${field}`);
    if (!safeEqual(result[field], wanted)) {
      throw new Error(`E2B child bootstrap attestation binding mismatch: ${field}`);
    }
  }
  if (result.boot_evidence_hash !== undefined) {
    requireSha256Ref(result.boot_evidence_hash, 'child bootstrap attestation.boot_evidence_hash');
    if (expected.bootEvidenceHash
      && !safeEqual(result.boot_evidence_hash, expected.bootEvidenceHash)) {
      throw new Error('E2B child bootstrap attestation binding mismatch: boot_evidence_hash');
    }
  } else if (expected.requireBootEvidence === true) {
    throw new Error('E2B child bootstrap attestation is missing boot evidence binding');
  }
  assertPlainObject(result.claims, 'E2B child bootstrap attestation.claims');
  assertAllowedKeys(result.claims, BOOTSTRAP_CLAIMS, 'E2B child bootstrap attestation.claims');
  for (const claim of BOOTSTRAP_CLAIMS) {
    if (result.claims[claim] !== true) {
      throw new Error(`E2B child bootstrap attestation must verify ${claim}`);
    }
  }
  const attestedAt = Date.parse(result.attested_at);
  const expiresAt = Date.parse(result.expires_at);
  if (!Number.isFinite(attestedAt)
    || !Number.isFinite(expiresAt)
    || attestedAt > now.getTime()
    || now.getTime() - attestedAt > 60_000
    || expiresAt <= now.getTime()
    || expiresAt > attestedAt + 5 * 60_000) {
    throw new Error('E2B child bootstrap attestation is stale or has an invalid validity window');
  }
  const normalized = cloneJson(result);
  return deepFreeze({ ...normalized, attestation_hash: sha256Ref(normalized) });
}

function parseRunnerResult(value, expected) {
  assertPlainObject(value, 'E2B runner result');
  assertAllowedKeys(value, [
    'schema',
    'status',
    'job_id',
    'job_hash',
    'capsule_hash',
    'identity_hash',
    'network_policy_hash',
    'operation_hash',
    'execution_mode',
    'trusted_runner_artifact_hash',
    'expected_result_schema_hash',
    'commit_candidate',
    'commit_candidate_hash',
  ], 'E2B runner result');
  if (value.schema !== 'agoragentic.risk-fork.runner-result.v1'
    || value.status !== 'completed') {
    throw new Error('E2B trusted runner returned an unsupported result envelope');
  }
  for (const [field, wanted] of Object.entries(expected)) {
    if (value[field] !== wanted) throw new Error(`E2B runner result binding mismatch: ${field}`);
  }
  const candidate = assertStrictSecretFreeJson(
    value.commit_candidate,
    'E2B runner commit candidate',
    { maxBytes: MAX_RESULT_BYTES },
  );
  const candidateHash = requireSha256Ref(
    value.commit_candidate_hash,
    'E2B runner commit_candidate_hash',
  );
  if (!safeEqual(candidateHash, sha256Ref(candidate))) {
    throw new Error('E2B runner commit candidate hash mismatch');
  }
  return deepFreeze({ ...cloneJson(value), commit_candidate: candidate });
}

function makeCapabilities(configured, qualificationEvidencePresent = false) {
  if (!configured) {
    return {
      supports_memory_snapshot: false,
      supports_filesystem_snapshot: false,
      supports_live_fork: false,
      supports_network_policy: false,
      supports_egress_allowlist: false,
      supports_runtime_attestation: false,
      supports_suspend_resume: false,
      supports_verified_destruction: false,
      supports_hard_ttl: false,
      supports_idle_ttl: false,
      supports_max_execution_time: false,
      supports_automatic_credential_expiry: false,
      child_credentials_mode: 'unknown',
      isolation_class: 'secure_snapshot_profile_unavailable',
      adapter_implementation: 'blocked_secure_profile_unavailable',
      mock_conformance: 'fail_closed_only',
      credentialed_provider_validation: 'not_run',
      containment_claim: 'not_verified',
    };
  }
  return {
    supports_memory_snapshot: false,
    supports_filesystem_snapshot: true,
    supports_live_fork: false,
    supports_network_policy: false,
    supports_egress_allowlist: false,
    supports_runtime_attestation: false,
    supports_suspend_resume: false,
    supports_verified_destruction: false,
    supports_hard_ttl: false,
    supports_idle_ttl: false,
    supports_max_execution_time: false,
    supports_automatic_credential_expiry: false,
    child_credentials_mode: 'prohibited',
    isolation_class: 'e2b_live_fork_blocked_untrusted_same_uid_watcher',
    adapter_implementation: 'source_wired_default_off',
    mock_conformance: 'handshake_mechanics_only_untrusted',
    credentialed_provider_validation: qualificationEvidencePresent
      ? 'evidence_present_activation_blocked'
      : 'not_run',
    containment_claim: 'not_verified',
  };
}

export class E2BRiskForkAdapter extends RiskForkProvider {
  #offlineConformance;

  #SandboxClass;

  #sdkLoader;

  #sdkVersion;

  #sdkVersionLoader;

  #sdkVersionVerified;

  #sdkIntegrityVerifier;

  #sdkIntegrityVerified;

  constructor(options = {}) {
    const templateProvenanceCandidate = options.cleanTemplateProvenanceHash
      ?? options.qualificationEvidence?.template?.provenance_hash;
    const profileValues = [
      options.cleanTemplateId,
      options.cleanTemplateHash,
      templateProvenanceCandidate,
      options.workspaceExportDirectory,
      options.cleanupJournalDirectory,
    ];
    const configured = profileValues.every((value) => value !== undefined && value !== null);
    if (!configured && profileValues.some((value) => value !== undefined && value !== null)) {
      throw new TypeError(
        'cleanTemplateId, cleanTemplateHash, cleanTemplateProvenanceHash, workspaceExportDirectory, and cleanupJournalDirectory are required together',
      );
    }
    if (!configured && options.qualificationEvidence != null) {
      throw new TypeError('E2B qualification evidence requires the complete clean-template profile');
    }
    const qualificationEvidence = options.qualificationEvidence == null
      ? null
      : validateE2BQualificationEvidence(options.qualificationEvidence, {
          templateId: options.cleanTemplateId,
          templateHash: options.cleanTemplateHash,
          bootstrapArtifactHash: options.trustedBootstrapArtifactHash,
          runnerArtifactHash: options.trustedRunnerArtifactHash,
        }, options.externalQualificationObservationVerifier ?? null);
    const hasQualificationTrust = options.qualificationTrust != null;
    const hasQualificationVerifier = options.qualificationTrustVerifier != null;
    if (!qualificationEvidence && (hasQualificationTrust || hasQualificationVerifier)) {
      throw new TypeError('E2B qualification trust requires qualification evidence');
    }
    if (!qualificationEvidence && options.externalQualificationObservationVerifier != null) {
      throw new TypeError(
        'E2B external qualification observation verifier requires qualification evidence',
      );
    }
    if (hasQualificationTrust !== hasQualificationVerifier) {
      throw new TypeError('E2B qualification trust and its verifier are required together');
    }
    const qualificationTrust = hasQualificationTrust
      ? verifyE2BQualificationTrust(
          qualificationEvidence,
          options.qualificationTrust,
          options.qualificationTrustVerifier,
          {
            templateId: options.cleanTemplateId,
            templateHash: options.cleanTemplateHash,
            bootstrapArtifactHash: options.trustedBootstrapArtifactHash,
            runnerArtifactHash: options.trustedRunnerArtifactHash,
          },
          options.externalQualificationObservationVerifier ?? null,
        )
      : null;
    const qualificationEligible = qualificationEvidence?.status === 'verified'
      && qualificationTrust !== null;
    if (qualificationEvidence
      && templateProvenanceCandidate !== qualificationEvidence.template.provenance_hash) {
      throw new TypeError('cleanTemplateProvenanceHash does not match qualification evidence');
    }
    super({
      id: configured ? 'e2b-clean-template-v1' : 'e2b-snapshot-v1',
      capabilities: makeCapabilities(configured, qualificationEligible),
    });
    if (typeof options.verifyAuthorityFreeSource !== 'function') {
      throw new TypeError('verifyAuthorityFreeSource must be an external clean-controller verifier');
    }
    if (options.SandboxClass !== undefined && typeof options.SandboxClass !== 'function') {
      throw new TypeError('SandboxClass must be a class');
    }
    if (options.offlineConformance !== undefined
      && typeof options.offlineConformance !== 'boolean') {
      throw new TypeError('offlineConformance must be boolean');
    }
    const offlineConformance = options.offlineConformance === true;
    if (offlineConformance && typeof options.SandboxClass !== 'function') {
      throw new TypeError('offlineConformance requires an injected SandboxClass');
    }
    if (offlineConformance && qualificationEvidence) {
      throw new TypeError('offlineConformance cannot carry E2B qualification evidence or trust');
    }
    if (options.sdkLoader !== undefined && typeof options.sdkLoader !== 'function') {
      throw new TypeError('sdkLoader must be a function');
    }
    if (options.sdkVersionLoader !== undefined && typeof options.sdkVersionLoader !== 'function') {
      throw new TypeError('sdkVersionLoader must be a function');
    }
    if (options.sdkVersion !== undefined && typeof options.sdkVersion !== 'string') {
      throw new TypeError('sdkVersion must be a string');
    }
    if (options.sdkIntegrityVerifier !== undefined
      && !isE2BRuntimeSdkIntegrityVerifier(options.sdkIntegrityVerifier)) {
      throw new TypeError(
        'sdkIntegrityVerifier must be created by createE2BRuntimeSdkIntegrityVerifier',
      );
    }
    if (!qualificationEligible && options.sdkIntegrityVerifier !== undefined) {
      throw new TypeError('sdkIntegrityVerifier is only valid with signed qualified evidence');
    }
    if (qualificationEligible && [
      options.SandboxClass,
      options.sdkLoader,
      options.sdkVersion,
      options.sdkVersionLoader,
    ].some((value) => value !== undefined)) {
      throw new TypeError(
        'Qualified E2B SDK loading cannot be injected; the runtime integrity verifier must load the exact signed package tree',
      );
    }
    if (!offlineConformance && [
      options.SandboxClass,
      options.sdkLoader,
      options.sdkVersion,
      options.sdkVersionLoader,
    ].some((value) => value !== undefined)) {
      throw new TypeError(
        'Injected E2B provider paths require offlineConformance=true',
      );
    }
    this.configured = configured;
    this.qualificationEvidence = qualificationEvidence;
    this.externalQualificationObservationVerifier =
      options.externalQualificationObservationVerifier ?? null;
    this.qualificationTrust = qualificationTrust;
    this.qualificationTrustVerifier = options.qualificationTrustVerifier ?? null;
    this.qualificationExpectedBindings = configured
      ? Object.freeze({
          templateId: options.cleanTemplateId,
          templateHash: options.cleanTemplateHash,
          bootstrapArtifactHash: options.trustedBootstrapArtifactHash,
          runnerArtifactHash: options.trustedRunnerArtifactHash,
        })
      : Object.freeze({});
    this.qualificationEligible = qualificationEligible;
    this.qualified = E2B_LIVE_FORK_SOURCE_ENABLED && qualificationEligible;
    this.#offlineConformance = offlineConformance;
    this.verifyAuthorityFreeSource = options.verifyAuthorityFreeSource;
    this.#SandboxClass = options.SandboxClass ?? null;
    this.#sdkLoader = options.sdkLoader ?? defaultSdkLoader;
    this.#sdkVersion = options.sdkVersion ?? null;
    this.#sdkVersionLoader = options.sdkVersionLoader ?? defaultSdkVersionLoader;
    this.#sdkVersionVerified = false;
    this.#sdkIntegrityVerifier = qualificationEligible
      ? options.sdkIntegrityVerifier ?? createE2BRuntimeSdkIntegrityVerifier()
      : null;
    this.#sdkIntegrityVerified = false;
    this.clock = options.clock ?? (() => new Date());
    if (typeof this.clock !== 'function') throw new TypeError('clock must be a function');
    this.bootstrapCommand = requireFixedCommand(
      options.bootstrapCommand ?? DEFAULT_BOOTSTRAP_COMMAND,
      'bootstrapCommand',
    );
    this.runnerCommand = requireFixedCommand(
      options.runnerCommand ?? DEFAULT_RUNNER_COMMAND,
      'runnerCommand',
    );
    this.trustedBootstrapCommandHash = sha256Ref(this.bootstrapCommand);
    this.trustedRunnerCommandHash = sha256Ref(this.runnerCommand);
    this.trustedBootstrapArtifactHash = requireSha256Ref(
      options.trustedBootstrapArtifactHash,
      'trustedBootstrapArtifactHash',
    );
    this.trustedRunnerArtifactHash = requireSha256Ref(
      options.trustedRunnerArtifactHash,
      'trustedRunnerArtifactHash',
    );
    this.cleanTemplateId = configured
      ? requireOpaqueRef(options.cleanTemplateId, 'cleanTemplateId', { maxLength: 500 })
      : null;
    this.cleanTemplateHash = configured
      ? requireSha256Ref(options.cleanTemplateHash, 'cleanTemplateHash')
      : null;
    this.cleanTemplateProvenanceHash = configured
      ? requireSha256Ref(templateProvenanceCandidate, 'cleanTemplateProvenanceHash')
      : null;
    this.birthAttestationTimeoutMs = boundedInteger(
      options.birthAttestationTimeoutMs ?? DEFAULT_BIRTH_ATTESTATION_TIMEOUT_MS,
      'birthAttestationTimeoutMs',
      { min: 50, max: E2B_BIRTH_MAX_VALIDITY_MS },
    );
    this.workspaceExportDirectory = configured
      ? path.resolve(requireString(options.workspaceExportDirectory, 'workspaceExportDirectory'))
      : null;
    this.maxFiles = boundedInteger(options.maxFiles ?? 2_000, 'maxFiles', {
      min: 1,
      max: 100_000,
    });
    this.maxBytes = boundedInteger(options.maxBytes ?? 32 * 1024 * 1024, 'maxBytes', {
      min: 1,
      max: 1024 * 1024 * 1024,
    });
    this.cleanupJournal = configured
      ? new E2BCleanupJournal({
          directory: options.cleanupJournalDirectory,
          clock: this.clock,
        })
      : null;
    this.savepoints = new Map();
    this.forks = new Map();
    this.ownedRecordIds = new Set();
    this.reconciliationEligibleRecordIds = new Set();
    this.initialization = null;
    this.initialized = false;
  }

  #requireConfigured(operation) {
    if (!this.configured) throw secureSnapshotProfileUnavailable(operation);
  }

  #requireForkRuntimeEnabled(operation) {
    if (!E2B_LIVE_FORK_SOURCE_ENABLED && !this.#offlineConformance) {
      throw liveForkDisabledUntrustedWatcher(operation);
    }
  }

  #revalidateQualificationTrust() {
    if (!this.qualificationEvidence) return null;
    const evidence = validateE2BQualificationEvidence(
      this.qualificationEvidence,
      this.qualificationExpectedBindings,
      this.externalQualificationObservationVerifier,
    );
    const trust = verifyE2BQualificationTrust(
      evidence,
      this.qualificationTrust,
      this.qualificationTrustVerifier,
      this.qualificationExpectedBindings,
      this.externalQualificationObservationVerifier,
    );
    if (evidence.status !== 'verified' || !trust) {
      throw new Error('E2B qualification evidence and trust are no longer valid');
    }
    this.qualificationEvidence = evidence;
    this.qualificationTrust = trust;
    return Object.freeze({ evidence, trust });
  }

  async #sandboxClass(operation = 'providerIo') {
    // This is the last-line fence for every SDK/provider path, including
    // restart reconciliation reached indirectly from createSavepoint(). An
    // injected class is reachable only through the explicit mock-only seam.
    this.#requireForkRuntimeEnabled(operation);
    if (this.qualificationEligible && !this.#sdkIntegrityVerified) {
      const verified = await loadVerifiedE2BRuntimeSdk(
        this.qualificationEvidence.sdk,
        this.#sdkIntegrityVerifier,
      );
      this.#SandboxClass = normalizeSandboxClass(verified.module);
      this.#sdkVersion = verified.version;
      this.#sdkVersionVerified = true;
      this.#sdkIntegrityVerified = true;
    }
    if (!this.#sdkVersionVerified && (!this.#SandboxClass || this.qualificationEligible)) {
      const version = this.#sdkVersion ?? await this.#sdkVersionLoader();
      if (version !== '2.39.0') {
        throw new Error(`E2B clean-template profile requires exact e2b@2.39.0; observed ${String(version)}`);
      }
      this.#sdkVersionVerified = true;
    }
    if (!this.#SandboxClass) {
      this.#SandboxClass = normalizeSandboxClass(await this.#sdkLoader());
    }
    for (const method of ['create', 'getInfo', 'list', 'kill']) {
      if (typeof this.#SandboxClass[method] !== 'function') {
        throw new TypeError(`E2B Sandbox.${method} is required by the clean-template profile`);
      }
    }
    return this.#SandboxClass;
  }

  async #initialize() {
    if (this.initialized) return;
    if (this.initialization) return this.initialization;
    this.initialization = (async () => {
      await this.cleanupJournal.initialize();
      const result = await this.#reconcilePendingCleanup({ excludeOwned: true });
      if (result.unresolved.length > 0) throw reconciliationRequired(result.unresolved);
      this.initialized = true;
    })();
    try {
      await this.initialization;
    } finally {
      this.initialization = null;
    }
  }

  #savepointRecord(ref) {
    const record = this.savepoints.get(ref);
    if (!record) throw new Error(`Unknown E2B clean-template savepoint: ${ref}`);
    return record;
  }

  #forkRecord(ref) {
    const record = this.forks.get(ref);
    if (!record) throw new Error(`Unknown E2B clean-template fork: ${ref}`);
    return record;
  }

  async #armForkLease(record, requestedTimeoutMs, reason) {
    if (!this.qualified) return null;
    this.#revalidateQualificationTrust();
    if (typeof record.sandbox?.setTimeout !== 'function') {
      throw new TypeError('Qualified E2B child must expose provider-enforced setTimeout');
    }
    const requestedAt = this.clock();
    const hardExpiresAtMs = Date.parse(record.expires_at);
    const hardRemainingMs = hardExpiresAtMs - requestedAt.getTime();
    if (hardRemainingMs <= 0) throw new Error('Cannot renew an expired E2B child lease');
    const timeoutMs = Math.min(
      boundedInteger(requestedTimeoutMs, 'E2B lease timeout', {
        min: 1,
        max: 24 * 60 * 60 * 1_000,
      }),
      hardRemainingMs,
    );
    try {
      await record.sandbox.setTimeout(timeoutMs);
      const Sandbox = await this.#sandboxClass();
      const info = await Sandbox.getInfo(record.sandbox_id);
      const observation = validateE2BSandboxInfo(info, {
        sandboxId: record.sandbox_id,
        templateId: this.cleanTemplateId,
        metadata: record.metadata,
        createdAtMs: Date.parse(record.created_at),
        hardExpiresAtMs,
        leaseRequestedAtMs: requestedAt.getTime(),
        leaseTimeoutMs: timeoutMs,
        field: `E2B ${reason} lease`,
      });
      record.lease_expires_at = observation.deadline;
      record.last_lease = {
        reason,
        requested_at: requestedAt.toISOString(),
        timeout_ms: timeoutMs,
        deadline: observation.deadline,
        observation_hash: observation.observation_hash,
      };
      return deepFreeze(cloneJson(record.last_lease));
    } catch (error) {
      this.#poisonAllocationUntilReconciled(record.record_id);
      await this.cleanupJournal.markSandboxUnknown(
        record.record_id,
        errorCode(error, 'E2B_LEASE_OUTCOME_UNKNOWN'),
        record.sandbox_id,
      ).catch(() => {});
      throw error;
    }
  }

  #poisonAllocationUntilReconciled(recordId) {
    this.reconciliationEligibleRecordIds.add(recordId);
  }

  async #clearAllocationPoisonIfFullyAbsent(recordId) {
    try {
      const current = await this.cleanupJournal.get(recordId);
      if (current.export_absence_verified && current.sandbox_absence_verified) {
        this.reconciliationEligibleRecordIds.delete(recordId);
        return true;
      }
    } catch {
      // A missing, corrupt, or unreadable cleanup record cannot prove that both
      // resources are absent. Keep the in-process allocation poison in place.
    }
    return false;
  }

  async #listByCleanupRef(Sandbox, record) {
    const query = {
      state: ['running', 'paused'],
      metadata: {
        'agoragentic.risk_fork.profile': PROFILE_METADATA_SCHEMA,
        'agoragentic.risk_fork.cleanup_ref': record.cleanup_ref,
      },
    };
    const paginator = Sandbox.list({ query });
    if (!paginator || typeof paginator.nextItems !== 'function'
      || typeof paginator.hasNext !== 'boolean') {
      throw new TypeError('E2B Sandbox.list must return a bounded paginator');
    }
    const matches = [];
    let pages = 0;
    while (paginator.hasNext === true) {
      pages += 1;
      if (pages > MAX_LIST_PAGES) throw new Error('E2B sandbox listing exceeded the page bound');
      const items = await paginator.nextItems();
      if (!Array.isArray(items)) throw new TypeError('E2B sandbox list page must be an array');
      for (const item of items) {
        const metadata = item?.metadata;
        const templateId = item?.templateId ?? item?.templateID;
        if (metadata?.['agoragentic.risk_fork.profile'] !== PROFILE_METADATA_SCHEMA
          || metadata?.['agoragentic.risk_fork.cleanup_ref'] !== record.cleanup_ref
          || !safeEqual(sha256Ref(metadata), record.metadata_hash)
          || templateId !== this.cleanTemplateId) {
          throw new Error('E2B cleanup listing returned an item outside the exact metadata binding');
        }
        matches.push(requireString(
          item.sandboxId ?? item.sandboxID,
          'reconciled E2B sandbox id',
          { maxLength: 500 },
        ));
      }
      if (typeof paginator.hasNext !== 'boolean') {
        throw new TypeError('E2B sandbox paginator stopped reporting hasNext');
      }
    }
    const sandboxIds = [...new Set(matches)].sort();
    const observation = {
      query_hash: sha256Ref(query),
      metadata_hash: record.metadata_hash,
      template_id_hash: sha256Ref(this.cleanTemplateId),
      page_count: pages,
      sandbox_id_hashes: sandboxIds.map((sandboxId) => sha256Ref(sandboxId)),
    };
    return deepFreeze({
      sandbox_ids: sandboxIds,
      observation_hash: sha256Ref(observation),
    });
  }

  async #verifySandboxAbsent(Sandbox, recordId, sandboxId) {
    let record;
    try {
      record = await this.cleanupJournal.get(recordId);
    } catch {
      this.#poisonAllocationUntilReconciled(recordId);
      return { status: 'unknown', outcome: 'unknown', sandbox_id: sandboxId };
    }
    try {
      await Sandbox.getInfo(sandboxId);
      this.#poisonAllocationUntilReconciled(recordId);
      await this.cleanupJournal.markSandboxUnknown(
        recordId,
        'RESOURCE_STILL_PRESENT',
        sandboxId,
      ).catch(() => {});
      return { status: 'failed', outcome: 'failure', sandbox_id: sandboxId };
    } catch (error) {
      if (!isSandboxNotFound(error)) {
        this.#poisonAllocationUntilReconciled(recordId);
        await this.cleanupJournal.markSandboxUnknown(
          recordId,
          errorCode(error, 'ABSENCE_CHECK_FAILED'),
          sandboxId,
        ).catch(() => {});
        return { status: 'unknown', outcome: 'unknown', sandbox_id: sandboxId };
      }
      let listing;
      try {
        listing = await this.#listByCleanupRef(Sandbox, record);
      } catch (listError) {
        this.#poisonAllocationUntilReconciled(recordId);
        await this.cleanupJournal.markSandboxUnknown(
          recordId,
          errorCode(listError, 'ABSENCE_LIST_BINDING_FAILED'),
          sandboxId,
        ).catch(() => {});
        return { status: 'unknown', outcome: 'unknown', sandbox_id: sandboxId };
      }
      if (listing.sandbox_ids.length !== 0) {
        this.#poisonAllocationUntilReconciled(recordId);
        await this.cleanupJournal.markSandboxUnknown(
          recordId,
          'RESOURCE_STILL_LISTED',
          sandboxId,
        ).catch(() => {});
        return { status: 'failed', outcome: 'failure', sandbox_id: sandboxId };
      }
      try {
        await Sandbox.getInfo(sandboxId);
        this.#poisonAllocationUntilReconciled(recordId);
        await this.cleanupJournal.markSandboxUnknown(
          recordId,
          'RESOURCE_REAPPEARED_DURING_ABSENCE_CHECK',
          sandboxId,
        ).catch(() => {});
        return { status: 'failed', outcome: 'failure', sandbox_id: sandboxId };
      } catch (secondError) {
        if (!isSandboxNotFound(secondError)) {
          this.#poisonAllocationUntilReconciled(recordId);
          await this.cleanupJournal.markSandboxUnknown(
            recordId,
            errorCode(secondError, 'SECOND_ABSENCE_CHECK_FAILED'),
            sandboxId,
          ).catch(() => {});
          return { status: 'unknown', outcome: 'unknown', sandbox_id: sandboxId };
        }
      }
      try {
        await this.cleanupJournal.markSandboxVerifiedAbsent(recordId, sandboxId);
      } catch {
        this.#poisonAllocationUntilReconciled(recordId);
        return { status: 'unknown', outcome: 'unknown', sandbox_id: sandboxId };
      }
      await this.#clearAllocationPoisonIfFullyAbsent(recordId);
      const evidence = {
        sandbox_id_hash: sha256Ref(sandboxId),
        absent: true,
        source: 'Sandbox.getInfo.not_found.list.empty.Sandbox.getInfo.not_found',
        cleanup_list_observation_hash: listing.observation_hash,
      };
      return {
        status: 'verified',
        outcome: 'success',
        sandbox_id: sandboxId,
        evidence_ref: `e2b-absence:${evidence.sandbox_id_hash.slice(7, 23)}`,
        evidence_hash: sha256Ref(evidence),
      };
    }
  }

  async #destroyAndVerifySandbox({ Sandbox, recordId, sandboxId, sandbox = null }) {
    this.#poisonAllocationUntilReconciled(recordId);
    await this.cleanupJournal.markSandboxCleanupRequested(recordId, sandboxId).catch(() => {});
    try {
      if (sandbox && typeof sandbox.kill === 'function') await sandbox.kill();
      else await Sandbox.kill(sandboxId);
    } catch (error) {
      this.#poisonAllocationUntilReconciled(recordId);
      await this.cleanupJournal.markSandboxUnknown(
        recordId,
        errorCode(error, 'E2B_KILL_FAILED'),
        sandboxId,
      ).catch(() => {});
      return { status: 'unknown', outcome: 'unknown', sandbox_id: sandboxId };
    }
    return this.#verifySandboxAbsent(Sandbox, recordId, sandboxId);
  }

  async #cleanupExportRecord(record) {
    this.#poisonAllocationUntilReconciled(record.record_id);
    try {
      await this.cleanupJournal.markExportCleanupRequested(record.record_id);
      await destroyImmutableWorkspaceExport({
        export_root: this.workspaceExportDirectory,
        export_id: record.export_id,
      });
      const absent = await verifyImmutableWorkspaceExportDestroyed({
        export_root: this.workspaceExportDirectory,
        export_id: record.export_id,
      });
      if (!absent) {
        this.#poisonAllocationUntilReconciled(record.record_id);
        await this.cleanupJournal.markExportUnknown(record.record_id, 'EXPORT_STILL_PRESENT');
        return false;
      }
      await this.cleanupJournal.markExportVerifiedAbsent(record.record_id);
      await this.#clearAllocationPoisonIfFullyAbsent(record.record_id);
      return true;
    } catch (error) {
      this.#poisonAllocationUntilReconciled(record.record_id);
      await this.cleanupJournal.markExportUnknown(
        record.record_id,
        errorCode(error, 'EXPORT_CLEANUP_FAILED'),
      ).catch(() => {});
      return false;
    }
  }

  async #reconcilePendingCleanup({ excludeOwned, includeEligibleOwned = false }) {
    for (const recordId of [...this.reconciliationEligibleRecordIds]) {
      await this.#clearAllocationPoisonIfFullyAbsent(recordId);
    }
    const pending = (await this.cleanupJournal.listPending()).filter((record) => (
      !excludeOwned
      || !this.ownedRecordIds.has(record.record_id)
      || (includeEligibleOwned && this.reconciliationEligibleRecordIds.has(record.record_id))
    ));
    if (pending.length === 0) return { reconciled: [], unresolved: [] };
    const Sandbox = await this.#sandboxClass();
    const reconciled = [];
    const unresolved = [];
    for (const initial of pending) {
      let exportOk = initial.export_absence_verified;
      if (!exportOk) exportOk = await this.#cleanupExportRecord(initial);
      let sandboxOk = initial.sandbox_absence_verified;
      if (!sandboxOk) {
        try {
          let sandboxIds = initial.sandbox_id ? [initial.sandbox_id] : [];
          if (sandboxIds.length === 0 && initial.sandbox_state === 'not_requested') {
            await this.cleanupJournal.markSandboxVerifiedAbsent(initial.record_id);
            sandboxOk = true;
          } else {
            if (sandboxIds.length === 0) {
              const listing = await this.#listByCleanupRef(Sandbox, initial);
              sandboxIds = listing.sandbox_ids;
            }
            if (sandboxIds.length === 0) {
              await this.cleanupJournal.markSandboxUnknown(
                initial.record_id,
                'ALLOCATION_OUTCOME_UNOBSERVED',
              );
              sandboxOk = false;
            } else {
              const outcomes = [];
              for (const sandboxId of sandboxIds) {
                outcomes.push(await this.#destroyAndVerifySandbox({
                  Sandbox,
                  recordId: initial.record_id,
                  sandboxId,
                }));
              }
              sandboxOk = outcomes.every((outcome) => outcome.status === 'verified');
              if (sandboxOk && sandboxIds.length > 1) {
                await this.cleanupJournal.markSandboxVerifiedAbsent(
                  initial.record_id,
                  sandboxIds[0],
                );
              } else if (!sandboxOk) {
                const unresolvedOutcome = outcomes.find((outcome) => outcome.status !== 'verified');
                await this.cleanupJournal.markSandboxUnknown(
                  initial.record_id,
                  'ORPHAN_CLEANUP_INCOMPLETE',
                  unresolvedOutcome?.sandbox_id,
                );
              }
            }
          }
        } catch (error) {
          await this.cleanupJournal.markSandboxUnknown(
            initial.record_id,
            errorCode(error, 'RECONCILIATION_FAILED'),
            initial.sandbox_id ?? undefined,
          ).catch(() => {});
          sandboxOk = false;
        }
      }
      if (exportOk && sandboxOk) {
        reconciled.push(initial.record_id);
        await this.#clearAllocationPoisonIfFullyAbsent(initial.record_id);
      } else {
        this.#poisonAllocationUntilReconciled(initial.record_id);
        unresolved.push(initial.record_id);
      }
    }
    return deepFreeze({ reconciled, unresolved });
  }

  async reconcilePendingCleanup() {
    this.#requireConfigured('reconcilePendingCleanup');
    this.#requireForkRuntimeEnabled('reconcilePendingCleanup');
    this.#revalidateQualificationTrust();
    await this.cleanupJournal.initialize();
    return this.#reconcilePendingCleanup({
      excludeOwned: true,
      includeEligibleOwned: true,
    });
  }

  async createSavepoint(input = {}) {
    this.#requireConfigured('createSavepoint');
    this.#revalidateQualificationTrust();
    assertAllowedKeys(input, ['capsule', 'source_workspace'], 'E2B createSavepoint input');
    verifySavepointCapsule(input.capsule, { now: this.clock() });
    await this.#initialize();
    const recordId = `e2b_cleanup_${randomUUID()}`;
    const cleanupRef = `e2b_cleanup_ref_${randomUUID()}`;
    const exportId = `e2b_export_${randomUUID()}`;
    const metadataCoreHash = sha256Ref({
      profile: PROFILE_METADATA_SCHEMA,
      cleanup_ref: cleanupRef,
      capsule_hash: input.capsule.capsule_hash,
      template_hash: this.cleanTemplateHash,
    });
    await this.cleanupJournal.createIntent({
      record_id: recordId,
      cleanup_ref: cleanupRef,
      provider_id: this.id,
      template_id_hash: sha256Ref(this.cleanTemplateId),
      metadata_hash: metadataCoreHash,
      export_id: exportId,
    });
    this.ownedRecordIds.add(recordId);
    let exportRecord;
    try {
      exportRecord = await createImmutableWorkspaceExport({
        source_workspace: input.source_workspace,
        export_root: this.workspaceExportDirectory,
        export_id: exportId,
        expected_workspace_digest: input.capsule.workspace.digest,
        max_files: this.maxFiles,
        max_bytes: this.maxBytes,
      });
      await this.cleanupJournal.markExportActive(recordId, {
        manifest_hash: exportRecord.manifest_hash,
        workspace_digest: exportRecord.workspace_digest,
      });
      const request = {
        schema: 'agoragentic.risk-fork.authority-free-source-request.v1',
        provider: this.id,
        cleanup_ref: cleanupRef,
        capsule_hash: input.capsule.capsule_hash,
        workspace_digest: exportRecord.workspace_digest,
        workspace_manifest_hash: exportRecord.manifest_hash,
        file_count: exportRecord.file_count,
        total_bytes: exportRecord.total_bytes,
        files: cloneJson(exportRecord.files),
        clean_template_id_hash: sha256Ref(this.cleanTemplateId),
        clean_template_evidence_hash: this.cleanTemplateHash,
        trusted_bootstrap_command_hash: this.trustedBootstrapCommandHash,
        trusted_runner_command_hash: this.trustedRunnerCommandHash,
        trusted_bootstrap_artifact_hash: this.trustedBootstrapArtifactHash,
        trusted_runner_artifact_hash: this.trustedRunnerArtifactHash,
        request_hash: null,
      };
      request.request_hash = sha256Ref({ ...request, request_hash: null });
      const attestation = validateSourceAttestation(
        await this.verifyAuthorityFreeSource(deepFreeze(cloneJson(request)), {
          export_directory: exportRecord.export_directory,
        }),
        request,
        {
          trustedBootstrapArtifactHash: this.trustedBootstrapArtifactHash,
          trustedRunnerArtifactHash: this.trustedRunnerArtifactHash,
        },
      );
      const ref = exportRecord.export_ref;
      const record = {
        ref,
        record_id: recordId,
        cleanup_ref: cleanupRef,
        capsule_hash: input.capsule.capsule_hash,
        authorized_result_schema_hash: input.capsule.authorized_result_schema_hash,
        export_record: exportRecord,
        attestation,
        created_at: this.clock().toISOString(),
        destroyed: false,
        fork_ref: null,
        allocation_attempted: false,
      };
      this.savepoints.set(ref, record);
      const savepointHash = sha256Ref({
        export_ref: ref,
        capsule_hash: record.capsule_hash,
        workspace_digest: exportRecord.workspace_digest,
        workspace_manifest_hash: exportRecord.manifest_hash,
        authority_attestation_hash: attestation.attestation_hash,
      });
      return deepFreeze({
        savepoint_ref: ref,
        savepoint_hash: savepointHash,
        workspace_digest: exportRecord.workspace_digest,
        runtime_snapshot: {
          mode: 'filesystem',
          memory_included: false,
          process_state_included: false,
          authority_included: false,
          provider_snapshot_created: false,
        },
        source_authority_status: 'verified_external_attestation',
        snapshot_integrity_status: 'verified_immutable_local_export',
        evidence_status: 'verified_offline_profile',
      });
    } catch (error) {
      await this.#cleanupExportRecord({ record_id: recordId, export_id: exportId });
      await this.cleanupJournal.markSandboxVerifiedAbsent(recordId).catch(() => {});
      await this.#clearAllocationPoisonIfFullyAbsent(recordId);
      throw error;
    }
  }

  async createFork(input = {}) {
    this.#requireConfigured('createFork');
    this.#requireForkRuntimeEnabled('createFork');
    this.#revalidateQualificationTrust();
    assertAllowedKeys(
      input,
      ['savepoint_ref', 'fork_identity', 'network_policy', 'ttl_ms', 'idle_ttl_ms'],
      'E2B createFork input',
    );
    await this.#initialize();
    const savepoint = this.#savepointRecord(requireString(input.savepoint_ref, 'savepoint_ref'));
    if (savepoint.destroyed) throw new Error('Cannot fork a destroyed E2B workspace export');
    if (savepoint.fork_ref) throw new Error('An E2B workspace export is one-use for child allocation');
    if (savepoint.allocation_attempted) {
      const error = new Error(
        'E2B allocation was already attempted; the one-use Savepoint is poisoned and cannot be retried',
      );
      error.code = 'E2B_ONE_USE_SAVEPOINT_ALLOCATION_ALREADY_ATTEMPTED';
      throw error;
    }
    if (this.reconciliationEligibleRecordIds.size > 0) {
      throw reconciliationRequired([...this.reconciliationEligibleRecordIds].sort());
    }
    assertFreshForkIdentity(input.fork_identity);
    const policy = networkPolicy(input.network_policy);
    if (policy.mode !== 'blocked') {
      throw new Error('E2B clean-template profile only admits a fully blocked egress policy');
    }
    const ttlMs = boundedInteger(input.ttl_ms ?? 5 * 60 * 1000, 'ttl_ms', {
      min: 1_000,
      max: 24 * 60 * 60 * 1000,
    });
    if (!this.qualified && input.idle_ttl_ms !== undefined) {
      throw new Error('E2B clean-template profile has no qualified provider-enforced idle TTL');
    }
    const idleTtlMs = this.qualified
      ? boundedInteger(
          input.idle_ttl_ms ?? Math.min(ttlMs, 60_000),
          'idle_ttl_ms',
          { min: 1_000, max: ttlMs },
        )
      : null;
    const metadata = exactMetadata(savepoint, input.fork_identity, policy, {
      bootstrapArtifactHash: this.trustedBootstrapArtifactHash,
      runnerArtifactHash: this.trustedRunnerArtifactHash,
    }, this.cleanTemplateHash);
    const createTimeoutMs = this.qualified ? Math.min(idleTtlMs, ttlMs) : ttlMs;
    const createOptions = {
      timeoutMs: createTimeoutMs,
      secure: true,
      allowInternetAccess: false,
      network: {
        allowOut: [],
        denyOut: [E2B_SDK_ALL_TRAFFIC_SENTINEL],
        allowPublicTraffic: false,
      },
      lifecycle: { onTimeout: 'kill', autoResume: false },
      metadata,
      envs: {},
      iam: { tokens: {} },
      volumeMounts: {},
    };
    // This synchronous flip is the in-process one-use CAS. It precedes the
    // first await that could let a concurrent caller pass the admission check.
    // Any later failure is conservatively terminal for this Savepoint.
    savepoint.allocation_attempted = true;
    const Sandbox = await this.#sandboxClass();
    const createStartedAt = this.clock();
    await this.cleanupJournal.markAllocationRequested(savepoint.record_id, sha256Ref(metadata));
    if (this.reconciliationEligibleRecordIds.size > 0) {
      await this.cleanupJournal.markSandboxVerifiedAbsent(savepoint.record_id).catch(() => {});
      throw reconciliationRequired([...this.reconciliationEligibleRecordIds].sort());
    }
    let sandbox;
    let sandboxId = null;
    try {
      this.#revalidateQualificationTrust();
      sandbox = await Sandbox.create(this.cleanTemplateId, createOptions);
      sandboxId = requireString(sandbox?.sandboxId, 'E2B child sandbox id', { maxLength: 500 });
      await this.cleanupJournal.markSandboxAllocated(savepoint.record_id, sandboxId);
      if (!sandbox.files
        || typeof sandbox.files.write !== 'function'
        || typeof sandbox.files.read !== 'function'
        || typeof sandbox.files.remove !== 'function') {
        throw new TypeError('E2B child must expose bounded file write/read/remove operations');
      }
      if (!sandbox.commands || typeof sandbox.commands.run !== 'function') {
        throw new TypeError('E2B child must expose commands.run');
      }
      if (typeof sandbox.kill !== 'function') throw new TypeError('E2B child must expose kill');
      if (this.qualified && typeof sandbox.setTimeout !== 'function') {
        throw new TypeError('Qualified E2B child must expose provider-enforced setTimeout');
      }
      const hardExpiresAtMs = createStartedAt.getTime() + ttlMs;
      const info = await Sandbox.getInfo(sandboxId);
      const childObservation = validateE2BSandboxInfo(info, {
        sandboxId,
        templateId: this.cleanTemplateId,
        metadata,
        createdAtMs: createStartedAt.getTime(),
        hardExpiresAtMs,
        ...(this.qualified ? {
          leaseRequestedAtMs: createStartedAt.getTime(),
          leaseTimeoutMs: createTimeoutMs,
        } : {}),
        field: 'E2B clean-template child',
      });
      const leaseRecord = {
        record_id: savepoint.record_id,
        sandbox_id: sandboxId,
        sandbox,
        metadata,
        created_at: createStartedAt.toISOString(),
        expires_at: new Date(hardExpiresAtMs).toISOString(),
        lease_expires_at: this.qualified ? childObservation.deadline : null,
        last_lease: null,
      };
      if (this.qualified) {
        const remaining = hardExpiresAtMs - this.clock().getTime();
        await this.#armForkLease(
          leaseRecord,
          Math.min(Math.max(idleTtlMs, 60_000), remaining),
          'birth_attestation',
        );
      }
      const birth = await performE2BSandboxBirthHandshake({
        sandbox,
        sandboxId,
        metadata,
        templateId: this.cleanTemplateId,
        templateEvidenceHash: this.cleanTemplateHash,
        templateProvenanceHash: this.cleanTemplateProvenanceHash,
        allocationStartedAt: createStartedAt,
        bootstrapArtifactHash: this.trustedBootstrapArtifactHash,
        runnerArtifactHash: this.trustedRunnerArtifactHash,
        timeoutMs: this.birthAttestationTimeoutMs,
        clock: this.clock,
      });
      const commonBootstrap = {
        schema: 'agoragentic.risk-fork.clean-bootstrap-request.v1',
        fork_identity: cloneJson(input.fork_identity),
        capsule_hash: savepoint.capsule_hash,
        network_policy_hash: policy.policy_hash,
        clean_template_id_hash: sha256Ref(this.cleanTemplateId),
        clean_template_evidence_hash: this.cleanTemplateHash,
        metadata_hash: sha256Ref(metadata),
        expected_child_sandbox_id_hash: sha256Ref(sandboxId),
        trusted_bootstrap_artifact_hash: this.trustedBootstrapArtifactHash,
        trusted_runner_artifact_hash: this.trustedRunnerArtifactHash,
        inherited_authority_accepted: false,
        rekey_required: true,
      };
      const attest = async (phase, workspaceDigest, expectedBootEvidenceHash = null) => {
        if (this.qualified) {
          const remaining = hardExpiresAtMs - this.clock().getTime();
          await this.#armForkLease(
            leaseRecord,
            Math.min(Math.max(idleTtlMs, 60_000), remaining),
            `${phase}_bootstrap`,
          );
        }
        const payload = {
          ...commonBootstrap,
          phase,
          expected_workspace_digest: workspaceDigest,
          bootstrap_nonce: randomUUID(),
          request_hash: null,
        };
        payload.request_hash = sha256Ref({ ...payload, request_hash: null });
        await sandbox.files.write(IDENTITY_PATH, JSON.stringify(payload));
        // e2b@2.39.0 CommandHandle concatenates stdout and stderr internally
        // even when streaming callbacks are supplied, so those callbacks are
        // not a clean-controller memory bound. The bootstrap is therefore a
        // pinned, reviewed trusted artifact whose bounded-output behavior
        // remains a live-provider qualification assumption. The post-return
        // size check below is defense in depth, not proof of bounded retention.
        const result = await sandbox.commands.run(this.bootstrapCommand, {
          timeoutMs: Math.min(ttlMs, 60_000),
        });
        return parseBootstrapAttestation(result, {
          phase,
          bootstrapRequestHash: payload.request_hash,
          sandboxId,
          templateId: this.cleanTemplateId,
          templateHash: this.cleanTemplateHash,
          capsuleHash: savepoint.capsule_hash,
          identityHash: input.fork_identity.identity_hash,
          networkPolicyHash: policy.policy_hash,
          metadata,
          workspaceDigest,
          bootstrapArtifactHash: this.trustedBootstrapArtifactHash,
          runnerArtifactHash: this.trustedRunnerArtifactHash,
          bootEvidenceHash: expectedBootEvidenceHash,
          requireBootEvidence: true,
        }, this.clock());
      };
      const preUploadAttestation = await attest(
        'pre_upload',
        EMPTY_WORKSPACE_DIGEST,
        birth.bootEvidence.evidence_hash,
      );
      if (this.qualified) {
        const remaining = hardExpiresAtMs - this.clock().getTime();
        await this.#armForkLease(
          leaseRecord,
          Math.min(Math.max(idleTtlMs, 60_000), remaining),
          'workspace_import',
        );
      }
      const workspace = await readImmutableWorkspaceExport({
        export_root: this.workspaceExportDirectory,
        export_id: savepoint.export_record.export_id,
        manifest_hash: savepoint.export_record.manifest_hash,
        workspace_digest: savepoint.export_record.workspace_digest,
      });
      for (const file of workspace.files) {
        const target = `${WORKSPACE_ROOT}/${file.path.split('/').join('/')}`;
        await sandbox.files.write(target, Buffer.from(file.data_base64, 'base64'));
      }
      const postImportAttestation = await attest(
        'post_import',
        savepoint.export_record.workspace_digest,
        preUploadAttestation.boot_evidence_hash ?? null,
      );
      if (this.qualified) {
        await this.#armForkLease(leaseRecord, idleTtlMs, 'ready_idle');
      }
      const ref = `e2b-sandbox:${sandboxId}`;
      const record = {
        ref,
        record_id: savepoint.record_id,
        cleanup_ref: savepoint.cleanup_ref,
        sandbox_id: sandboxId,
        sandbox,
        savepoint_ref: savepoint.ref,
        capsule_hash: savepoint.capsule_hash,
        authorized_result_schema_hash: savepoint.authorized_result_schema_hash,
        identity_hash: input.fork_identity.identity_hash,
        network_policy_hash: policy.policy_hash,
        metadata,
        child_observation: childObservation,
        birth_request: birth.request,
        birth_attestation: birth.attestation,
        pre_upload_attestation: preUploadAttestation,
        post_import_attestation: postImportAttestation,
        created_at: createStartedAt.toISOString(),
        expires_at: new Date(hardExpiresAtMs).toISOString(),
        idle_ttl_ms: idleTtlMs,
        lease_expires_at: leaseRecord.lease_expires_at,
        last_lease: leaseRecord.last_lease,
        boot_evidence_hash: birth.bootEvidence.evidence_hash,
        status: 'ready',
        last_execution: null,
        last_result: null,
        destruction_status: 'not_requested',
        destroyed_verified: false,
      };
      this.forks.set(ref, record);
      savepoint.fork_ref = ref;
      return deepFreeze({
        fork_ref: ref,
        fork_hash: sha256Ref({
          sandbox_id_hash: sha256Ref(sandboxId),
          workspace_manifest_hash: savepoint.export_record.manifest_hash,
          identity_hash: record.identity_hash,
          network_policy_hash: record.network_policy_hash,
          birth_request_hash: birth.request.request_hash,
          birth_attestation_hash: birth.attestation.attestation_hash,
          post_import_attestation_hash: postImportAttestation.attestation_hash,
          boot_evidence_hash: record.boot_evidence_hash,
        }),
        status: 'ready',
        expires_at: record.expires_at,
        isolation_class: this.capabilities.isolation_class,
        network_status: 'offline_conformance_observation_only_ipv4_ipv6_unqualified',
        lifecycle_status: 'offline_conformance_requested_not_provider_qualified',
        ttl_status: 'offline_conformance_requested_not_provider_qualified',
        idle_ttl_status: this.qualified
          ? 'provider_lease_armed_with_hard_deadline_cap'
          : 'not_qualified',
        idle_expires_at: record.lease_expires_at,
        bootstrap_status: 'untrusted_same_uid_observation_only',
        inherited_authority_accepted: false,
      });
    } catch (error) {
      if (sandboxId) {
        this.#poisonAllocationUntilReconciled(savepoint.record_id);
        const cleanup = await this.#destroyAndVerifySandbox({
          Sandbox,
          recordId: savepoint.record_id,
          sandboxId,
          sandbox,
        });
        if (cleanup.status !== 'verified') {
          const cleanupError = new Error(`E2B failed-child cleanup is ${cleanup.status}`);
          cleanupError.code = 'E2B_FAILED_CHILD_CLEANUP_NOT_VERIFIED';
          throw new AggregateError(
            [error, cleanupError],
            'E2B child creation failed and cleanup absence was not verified',
          );
        }
      } else {
        this.#poisonAllocationUntilReconciled(savepoint.record_id);
        await this.cleanupJournal.markSandboxUnknown(
          savepoint.record_id,
          errorCode(error, 'ALLOCATION_OUTCOME_UNKNOWN'),
        );
      }
      throw error;
    }
  }

  async getForkStatus(input = {}) {
    this.#requireConfigured('getForkStatus');
    this.#requireForkRuntimeEnabled('getForkStatus');
    this.#revalidateQualificationTrust();
    assertAllowedKeys(input, ['fork_ref'], 'E2B getForkStatus input');
    const record = this.#forkRecord(requireString(input.fork_ref, 'fork_ref'));
    if (record.destroyed_verified) {
      return deepFreeze({
        fork_ref: record.ref,
        status: 'destroyed',
        provider_state: 'absent',
        expires_at: record.expires_at,
        evidence_status: 'verified',
      });
    }
    const Sandbox = await this.#sandboxClass();
    try {
      const info = await Sandbox.getInfo(record.sandbox_id);
      validateE2BSandboxInfo(info, {
        sandboxId: record.sandbox_id,
        templateId: this.cleanTemplateId,
        metadata: record.metadata,
        createdAtMs: Date.parse(record.created_at),
        hardExpiresAtMs: Date.parse(record.expires_at),
        ...(this.qualified && record.last_lease ? {
          leaseRequestedAtMs: Date.parse(record.last_lease.requested_at),
          leaseTimeoutMs: record.last_lease.timeout_ms,
        } : {}),
        field: 'E2B child status',
      });
      return deepFreeze({
        fork_ref: record.ref,
        status: record.status,
        provider_state: info.state,
        expires_at: record.expires_at,
        idle_expires_at: record.lease_expires_at,
        evidence_status: 'verified_present',
      });
    } catch (error) {
      if (isSandboxNotFound(error)) {
        const absence = await this.#verifySandboxAbsent(
          Sandbox,
          record.record_id,
          record.sandbox_id,
        );
        if (absence.status !== 'verified') {
          return deepFreeze({
            fork_ref: record.ref,
            status: 'unknown',
            provider_state: 'unknown',
            expires_at: record.expires_at,
            evidence_status: 'unknown',
          });
        }
        record.destroyed_verified = true;
        record.destruction_status = 'verified_absent_stable_observation';
        record.status = 'destroyed';
        return deepFreeze({
          fork_ref: record.ref,
          status: 'absent',
          provider_state: 'absent',
          expires_at: record.expires_at,
          evidence_status: 'verified_absent',
        });
      }
      return deepFreeze({
        fork_ref: record.ref,
        status: 'unknown',
        provider_state: 'unknown',
        expires_at: record.expires_at,
        evidence_status: 'unknown',
      });
    }
  }

  async executeInFork(input = {}) {
    if (input && typeof input === 'object' && Object.hasOwn(input, 'operation')) {
      validateChildOperation(input.operation, 'operation');
    }
    this.#requireConfigured('executeInFork');
    this.#requireForkRuntimeEnabled('executeInFork');
    this.#revalidateQualificationTrust();
    assertAllowedKeys(
      input,
      ['fork_ref', 'operation', 'execution_mode', 'timeout_ms', 'scoped_credentials'],
      'E2B executeInFork input',
    );
    const record = this.#forkRecord(requireString(input.fork_ref, 'fork_ref'));
    if (record.destroyed_verified || record.destruction_status !== 'not_requested') {
      throw new Error('Cannot execute after E2B child destruction begins');
    }
    if (record.status !== 'ready' && record.status !== 'tainted') {
      throw new Error(`Cannot execute while E2B child status is ${record.status}`);
    }
    if (this.clock().getTime() >= Date.parse(record.expires_at)) {
      throw new Error('Cannot execute in an expired E2B child');
    }
    if (input.scoped_credentials !== undefined && input.scoped_credentials !== null) {
      assertPlainObject(input.scoped_credentials, 'scoped_credentials');
      if (Object.keys(input.scoped_credentials).length > 0) {
        throw new Error('Risk Fork children must not receive credentials or execution authority');
      }
    }
    const executionMode = input.execution_mode === 'prepare_only'
      ? 'prepare_only'
      : input.execution_mode === 'isolated_execution'
        ? 'isolated_execution'
        : null;
    if (!executionMode) throw new TypeError('execution_mode is invalid');
    const operation = assertStrictSecretFreeJson(input.operation, 'operation');
    const timeoutMs = boundedInteger(input.timeout_ms ?? 60_000, 'timeout_ms', {
      min: 100,
      max: 10 * 60 * 1000,
    });
    const remainingMs = Date.parse(record.expires_at) - this.clock().getTime();
    if (timeoutMs > remainingMs) throw new Error('Execution timeout exceeds the child hard deadline');
    const jobId = `rfj_${randomUUID().replaceAll('-', '')}`;
    const jobPath = `${JOB_PATH}.${jobId}.json`;
    const resultPath = `${RESULT_PATH}.${jobId}.json`;
    const job = {
      schema: 'agoragentic.risk-fork.runner-job.v1',
      job_id: jobId,
      capsule_hash: record.capsule_hash,
      identity_hash: record.identity_hash,
      network_policy_hash: record.network_policy_hash,
      operation_hash: sha256Ref(operation),
      execution_mode: executionMode,
      expected_result_schema_hash: record.authorized_result_schema_hash,
      operation,
      result_path: resultPath,
      job_hash: null,
    };
    job.job_hash = sha256Ref({ ...job, job_hash: null });
    assertStrictSecretFreeJson(job, 'E2B runner job');
    const started = this.clock();
    const controllerDeadlineAt = performance.now() + timeoutMs;
    record.status = 'executing';
    try {
      if (this.qualified) {
        const executionLeaseMs = Math.min(
          timeoutMs + EXECUTION_CLEANUP_MARGIN_MS,
          Date.parse(record.expires_at) - this.clock().getTime(),
        );
        await this.#armForkLease(record, executionLeaseMs, 'execution_window');
      }
      await record.sandbox.files.remove(resultPath).catch((error) => {
        if (!isRemoteFileNotFound(error)) throw error;
      });
      await record.sandbox.files.write(jobPath, JSON.stringify(job));
      const command = `${this.runnerCommand} --job ${jobPath} --result ${resultPath}`;
      const commandBudgetMs = Math.floor(controllerDeadlineAt - performance.now());
      if (commandBudgetMs <= 0) {
        const error = new Error(`E2B controller execution timeout after ${timeoutMs}ms`);
        error.code = 'E2B_CONTROLLER_EXECUTION_TIMEOUT';
        throw error;
      }
      const commandResult = await withControllerDeadline(
        record.sandbox.commands.run(command, { timeoutMs }),
        commandBudgetMs,
      );
      assertCommandSucceeded(commandResult, 'E2B trusted runner command');
      const resultBudgetMs = Math.floor(controllerDeadlineAt - performance.now());
      if (resultBudgetMs <= 0) {
        const error = new Error(`E2B controller execution timeout after ${timeoutMs}ms`);
        error.code = 'E2B_CONTROLLER_EXECUTION_TIMEOUT';
        throw error;
      }
      const raw = await readBoundedResultBytes(record.sandbox.files, resultPath, {
        maxBytes: MAX_RESULT_BYTES,
        totalTimeoutMs: resultBudgetMs,
        idleTimeoutMs: Math.min(
          MAX_RESULT_STREAM_IDLE_TIMEOUT_MS,
          Math.max(
            MIN_RESULT_STREAM_IDLE_TIMEOUT_MS,
            Math.floor(resultBudgetMs / 4),
          ),
        ),
      });
      const text = raw.toString('utf8');
      let parsed;
      try {
        parsed = JSON.parse(text);
      } catch {
        throw new Error('E2B trusted runner returned invalid JSON');
      }
      parsed = parseRunnerResult(parsed, {
        job_id: job.job_id,
        job_hash: job.job_hash,
        capsule_hash: job.capsule_hash,
        identity_hash: job.identity_hash,
        network_policy_hash: job.network_policy_hash,
        operation_hash: job.operation_hash,
        execution_mode: job.execution_mode,
        trusted_runner_artifact_hash: this.trustedRunnerArtifactHash,
        expected_result_schema_hash: job.expected_result_schema_hash,
      });
      const completed = this.clock();
      const executionRecord = {
        started_at: started.toISOString(),
        completed_at: completed.toISOString(),
        duration_ms: Math.max(0, completed.getTime() - started.getTime()),
        result_hash: sha256Ref(parsed),
        command: commandMeasurements(commandResult),
      };
      if (this.qualified) {
        await this.#armForkLease(record, record.idle_ttl_ms, 'post_execution_idle');
      }
      record.status = 'tainted';
      record.last_result = cloneJson(parsed);
      record.last_execution = executionRecord;
      return deepFreeze({
        status: 'completed',
        taint_status: 'TAINTED',
        commit_candidate: cloneJson(parsed.commit_candidate),
        result_hash: executionRecord.result_hash,
        measurements: cloneJson(executionRecord),
        authority_granted: false,
      });
    } catch (error) {
      record.status = 'failed';
      this.#poisonAllocationUntilReconciled(record.record_id);
      const Sandbox = await this.#sandboxClass();
      const cleanup = await this.#destroyAndVerifySandbox({
        Sandbox,
        recordId: record.record_id,
        sandboxId: record.sandbox_id,
        sandbox: record.sandbox,
      });
      if (cleanup.status === 'verified') {
        record.destroyed_verified = true;
        record.destruction_status = 'verified_destroyed_after_execution_failure';
        const executionError = new Error(
          'E2B execution or result binding failed; child destruction and absence were independently verified',
          { cause: error },
        );
        executionError.code = 'E2B_EXECUTION_FAILED_CHILD_VERIFIED_ABSENT';
        throw executionError;
      }
      const cleanupError = new Error(`E2B execution failed and child cleanup is ${cleanup.status}`);
      cleanupError.code = 'E2B_EXECUTION_FAILURE_CLEANUP_NOT_VERIFIED';
      throw new AggregateError(
        [error, cleanupError],
        'E2B execution failed and child absence was not verified',
      );
    } finally {
      await record.sandbox.files.remove(jobPath).catch(() => {});
      await record.sandbox.files.remove(resultPath).catch(() => {});
    }
  }

  async collectEvidence(input = {}) {
    this.#requireConfigured('collectEvidence');
    this.#requireForkRuntimeEnabled('collectEvidence');
    this.#revalidateQualificationTrust();
    assertAllowedKeys(input, ['fork_ref'], 'E2B collectEvidence input');
    const record = this.#forkRecord(requireString(input.fork_ref, 'fork_ref'));
    const evidence = {
      fork_ref_hash: sha256Ref(record.ref),
      status: record.status,
      identity_hash: record.identity_hash,
      network_policy_hash: record.network_policy_hash,
      child_observation_hash: record.child_observation.observation_hash,
      birth_request_hash: record.birth_request.request_hash,
      birth_attestation_hash: record.birth_attestation.attestation_hash,
      pre_upload_attestation_hash: record.pre_upload_attestation.attestation_hash,
      post_import_attestation_hash: record.post_import_attestation.attestation_hash,
      runner_status: record.last_execution ? 'observed' : 'not_run',
      destruction_status: record.destruction_status,
      last_execution: cloneJson(record.last_execution),
      raw_stdout_included: false,
      raw_stderr_included: false,
      credentials_included: false,
      wallet_material_included: false,
      execution_authority_included: false,
      qualification_evidence_hash: this.qualificationEvidence?.evidence_hash ?? null,
      qualification_status: this.qualified ? 'verified' : 'not_run',
      boot_evidence_hash: record.boot_evidence_hash,
      idle_ttl_ms: record.idle_ttl_ms,
      lease_expires_at: record.lease_expires_at,
      lease_observation_hash: record.last_lease?.observation_hash ?? null,
      provider_live_qualification: this.qualified ? 'verified' : 'not_run',
      containment_claim: this.qualified ? 'verified' : 'not_verified',
    };
    return deepFreeze({ ...evidence, evidence_hash: sha256Ref(evidence) });
  }

  async collectDiff(input = {}) {
    this.#requireConfigured('collectDiff');
    this.#requireForkRuntimeEnabled('collectDiff');
    this.#revalidateQualificationTrust();
    assertAllowedKeys(input, ['fork_ref'], 'E2B collectDiff input');
    const record = this.#forkRecord(requireString(input.fork_ref, 'fork_ref'));
    const diff = record.last_result?.commit_candidate;
    if (!diff || diff.type !== 'WORKSPACE_DIFF') {
      throw new Error('E2B runner did not produce a WORKSPACE_DIFF candidate');
    }
    return cloneJson(diff);
  }

  async suspendFork() {
    this.#requireConfigured('suspendFork');
    this.#requireForkRuntimeEnabled('suspendFork');
    this.#revalidateQualificationTrust();
    throw new Error('E2B clean-template Risk Fork forbids pause, resume, and persistent suspension');
  }

  async destroyFork(input = {}) {
    this.#requireConfigured('destroyFork');
    this.#requireForkRuntimeEnabled('destroyFork');
    this.#revalidateQualificationTrust();
    assertAllowedKeys(input, ['fork_ref', 'reason'], 'E2B destroyFork input');
    const record = this.#forkRecord(requireString(input.fork_ref, 'fork_ref'));
    if (record.destroyed_verified) {
      return deepFreeze({
        fork_ref: record.ref,
        status: 'already_destroyed_verified',
        evidence_status: 'verified',
      });
    }
    record.destruction_status = 'destroy_requested';
    this.#poisonAllocationUntilReconciled(record.record_id);
    const Sandbox = await this.#sandboxClass();
    try {
      await this.cleanupJournal.markSandboxCleanupRequested(record.record_id, record.sandbox_id);
      await record.sandbox.kill();
      record.destruction_status = 'kill_observed';
      return deepFreeze({
        fork_ref: record.ref,
        status: 'destroy_requested_observed',
        evidence_status: 'observed',
        evidence_hash: sha256Ref({
          sandbox_id_hash: sha256Ref(record.sandbox_id),
          request: 'kill',
          provider_result: 'returned_without_error',
        }),
      });
    } catch (error) {
      record.destruction_status = 'kill_unknown';
      this.#poisonAllocationUntilReconciled(record.record_id);
      await this.cleanupJournal.markSandboxUnknown(
        record.record_id,
        errorCode(error, 'E2B_KILL_FAILED'),
        record.sandbox_id,
      );
      return deepFreeze({
        fork_ref: record.ref,
        status: 'unknown',
        evidence_status: 'unknown',
        error_code: 'E2B_KILL_OUTCOME_UNKNOWN',
      });
    }
  }

  async verifyDestroyed(input = {}) {
    this.#requireConfigured('verifyDestroyed');
    this.#requireForkRuntimeEnabled('verifyDestroyed');
    this.#revalidateQualificationTrust();
    assertAllowedKeys(input, ['fork_ref'], 'E2B verifyDestroyed input');
    const record = this.#forkRecord(requireString(input.fork_ref, 'fork_ref'));
    this.#poisonAllocationUntilReconciled(record.record_id);
    const Sandbox = await this.#sandboxClass();
    const result = await this.#verifySandboxAbsent(Sandbox, record.record_id, record.sandbox_id);
    if (result.status === 'verified') {
      record.destroyed_verified = true;
      record.destruction_status = 'verified_destroyed';
      record.status = 'destroyed';
    }
    return deepFreeze({
      fork_ref: record.ref,
      status: result.status,
      outcome: result.outcome,
      evidence_status: result.status === 'verified'
        ? 'verified'
        : result.status === 'failed'
          ? 'verified_present'
          : 'unknown',
      ...(result.evidence_ref ? { evidence_ref: result.evidence_ref } : {}),
      ...(result.evidence_hash ? { evidence_hash: result.evidence_hash } : {}),
    });
  }

  async destroySavepoint(input = {}) {
    this.#requireConfigured('destroySavepoint');
    this.#revalidateQualificationTrust();
    assertAllowedKeys(input, ['savepoint_ref'], 'E2B destroySavepoint input');
    const record = this.#savepointRecord(requireString(input.savepoint_ref, 'savepoint_ref'));
    if (record.destroyed) {
      return deepFreeze({
        savepoint_ref: record.ref,
        status: 'already_destroyed_verified',
        evidence_status: 'verified',
      });
    }
    this.#poisonAllocationUntilReconciled(record.record_id);
    try {
      await this.cleanupJournal.markExportCleanupRequested(record.record_id);
      await destroyImmutableWorkspaceExport({
        export_root: this.workspaceExportDirectory,
        export_id: record.export_record.export_id,
      });
      return deepFreeze({
        savepoint_ref: record.ref,
        status: 'destroy_requested_observed',
        evidence_status: 'observed',
        evidence_hash: sha256Ref({
          export_ref_hash: sha256Ref(record.ref),
          request: 'destroy_local_export',
        }),
      });
    } catch (error) {
      this.#poisonAllocationUntilReconciled(record.record_id);
      await this.cleanupJournal.markExportUnknown(
        record.record_id,
        errorCode(error, 'EXPORT_DELETE_FAILED'),
      ).catch(() => {});
      return deepFreeze({
        savepoint_ref: record.ref,
        status: 'unknown',
        evidence_status: 'unknown',
        error_code: 'E2B_LOCAL_EXPORT_DELETE_UNKNOWN',
      });
    }
  }

  async verifySavepointDestroyed(input = {}) {
    this.#requireConfigured('verifySavepointDestroyed');
    this.#revalidateQualificationTrust();
    assertAllowedKeys(input, ['savepoint_ref'], 'E2B verifySavepointDestroyed input');
    const record = this.#savepointRecord(requireString(input.savepoint_ref, 'savepoint_ref'));
    this.#poisonAllocationUntilReconciled(record.record_id);
    let absent;
    try {
      absent = await verifyImmutableWorkspaceExportDestroyed({
        export_root: this.workspaceExportDirectory,
        export_id: record.export_record.export_id,
      });
    } catch (error) {
      this.#poisonAllocationUntilReconciled(record.record_id);
      await this.cleanupJournal.markExportUnknown(
        record.record_id,
        errorCode(error, 'EXPORT_ABSENCE_CHECK_FAILED'),
      ).catch(() => {});
      return deepFreeze({
        savepoint_ref: record.ref,
        status: 'unknown',
        outcome: 'unknown',
        evidence_status: 'unknown',
        error_code: 'E2B_LOCAL_EXPORT_ABSENCE_UNKNOWN',
      });
    }
    if (!absent) {
      this.#poisonAllocationUntilReconciled(record.record_id);
      await this.cleanupJournal.markExportUnknown(record.record_id, 'EXPORT_STILL_PRESENT');
      return deepFreeze({
        savepoint_ref: record.ref,
        status: 'failed',
        outcome: 'failure',
        evidence_status: 'verified_present',
      });
    }
    record.destroyed = true;
    await this.cleanupJournal.markExportVerifiedAbsent(record.record_id);
    await this.#clearAllocationPoisonIfFullyAbsent(record.record_id);
    const evidence = {
      export_ref_hash: sha256Ref(record.ref),
      absent: true,
      provider_snapshot_created: false,
    };
    return deepFreeze({
      savepoint_ref: record.ref,
      status: 'verified',
      outcome: 'success',
      evidence_status: 'verified',
      evidence_ref: `e2b-export-absence:${evidence.export_ref_hash.slice(7, 23)}`,
      evidence_hash: sha256Ref(evidence),
    });
  }
}

export const E2B_RISK_FORK_PATHS = Object.freeze({
  identity: IDENTITY_PATH,
  job: JOB_PATH,
  result: RESULT_PATH,
});
