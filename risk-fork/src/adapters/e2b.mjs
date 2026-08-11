import { randomUUID } from 'node:crypto';

import { sha256Ref } from '../canonical.mjs';
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
  requireOpaqueRef,
  requireSha256Ref,
  requireString,
  safeEqual,
} from '../util.mjs';

const IDENTITY_PATH = '/tmp/agoragentic-risk-fork-v1.identity.json';
const JOB_PATH = '/tmp/agoragentic-risk-fork-v1.job.json';
const RESULT_PATH = '/tmp/agoragentic-risk-fork-v1.result.json';
const DEFAULT_BOOTSTRAP_COMMAND =
  '/opt/agoragentic/risk-fork/bin/bootstrap --identity /tmp/agoragentic-risk-fork-v1.identity.json';
const DEFAULT_RUNNER_COMMAND =
  '/opt/agoragentic/risk-fork/bin/run --job /tmp/agoragentic-risk-fork-v1.job.json --result /tmp/agoragentic-risk-fork-v1.result.json';
const MAX_JOB_BYTES = 1024 * 1024;
const MAX_RESULT_BYTES = 4 * 1024 * 1024;
const MAX_JSON_NODES = 20_000;
const MAX_JSON_DEPTH = 50;
const MAX_SNAPSHOT_PAGES = 100;

const SECRET_KEY_PATTERN = /(?:api[_-]?key|access[_-]?token|refresh[_-]?token|authorization|credential|password|private[_-]?key|seed[_-]?phrase|wallet)/i;
const SECRET_VALUE_PATTERNS = Object.freeze([
  /-----BEGIN [A-Z ]*PRIVATE KEY-----/,
  /\bBearer\s+[A-Za-z0-9._~+/=-]{8,}/i,
  /\be2b_[A-Za-z0-9_-]{12,}/,
  /\bsk-[A-Za-z0-9_-]{16,}/,
  /\bAKIA[0-9A-Z]{16}\b/,
  /\bgh[pousr]_[A-Za-z0-9]{20,}\b/,
  /[?&](?:api[_-]?key|access[_-]?token|authorization)=[^&\s]{8,}/i,
]);
const DANGEROUS_JSON_KEYS = new Set(['__proto__', 'constructor', 'prototype']);

async function defaultSdkLoader() {
  return import('e2b');
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

function isNotFound(error) {
  const status = error?.status
    ?? error?.statusCode
    ?? error?.response?.status
    ?? error?.cause?.status;
  const code = String(error?.code ?? error?.name ?? '').toUpperCase();
  return status === 404 || code === 'NOT_FOUND' || code === 'SANDBOX_NOT_FOUND';
}

function assertStrictSecretFreeJson(value, field, limits = {}) {
  const maxBytes = limits.maxBytes ?? MAX_JOB_BYTES;
  let nodes = 0;
  const active = new Set();

  function walk(current, path, depth) {
    nodes += 1;
    if (nodes > MAX_JSON_NODES) throw new TypeError(`${field} is too complex`);
    if (depth > MAX_JSON_DEPTH) throw new TypeError(`${field} is too deeply nested`);
    if (current === null || typeof current === 'boolean') return;
    if (typeof current === 'string') {
      if (SECRET_VALUE_PATTERNS.some((pattern) => pattern.test(current))) {
        throw new TypeError(`${path} contains secret-shaped material`);
      }
      return;
    }
    if (typeof current === 'number') {
      if (!Number.isFinite(current) || !Number.isSafeInteger(current)) {
        throw new TypeError(`${path} must be a finite safe integer`);
      }
      return;
    }
    if (!current || typeof current !== 'object') {
      throw new TypeError(`${path} is not strict JSON`);
    }
    if (active.has(current)) throw new TypeError(`${path} contains a cycle`);
    active.add(current);
    if (Array.isArray(current)) {
      for (let index = 0; index < current.length; index += 1) {
        if (!Object.hasOwn(current, index)) throw new TypeError(`${path} contains an array hole`);
        walk(current[index], `${path}[${index}]`, depth + 1);
      }
    } else {
      assertPlainObject(current, path);
      for (const [key, child] of Object.entries(current)) {
        if (DANGEROUS_JSON_KEYS.has(key)) {
          throw new TypeError(`${path}.${key} is a forbidden JSON key`);
        }
        if (SECRET_KEY_PATTERN.test(key)) {
          throw new TypeError(`${path}.${key} is an authority or secret-bearing field`);
        }
        walk(child, `${path}.${key}`, depth + 1);
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

function safeProviderObservation(info, expectedSandboxId, field, options = {}) {
  const requireLifecycle = options.requireLifecycle === true;
  assertPlainObject(info, field);
  const sandboxId = requireString(
    info.sandboxId ?? info.sandboxID,
    `${field}.sandboxId`,
    { maxLength: 500 },
  );
  if (sandboxId !== expectedSandboxId) throw new Error(`${field} sandbox identity mismatch`);
  if (info.allowInternetAccess !== false) {
    throw new Error(`${field} does not prove allowInternetAccess=false`);
  }
  if (info.network !== undefined && info.network !== null) {
    assertPlainObject(info.network, `${field}.network`);
    const allowOut = info.network.allowOut ?? [];
    if (!Array.isArray(allowOut)) throw new TypeError(`${field}.network.allowOut must be an array`);
    if (allowOut.length > 0) throw new Error(`${field} reports outbound network allowances`);
  }
  if (requireLifecycle) {
    assertPlainObject(info.lifecycle, `${field}.lifecycle`);
    if (info.lifecycle.onTimeout !== 'kill' || info.lifecycle.autoResume !== false) {
      throw new Error(`${field} does not prove kill-on-timeout with auto-resume disabled`);
    }
  }
  let metadataHash = null;
  if (options.expectedMetadata) {
    assertPlainObject(info.metadata, `${field}.metadata`);
    const expectedKeys = Object.keys(options.expectedMetadata).sort();
    const actualKeys = Object.keys(info.metadata).sort();
    if (actualKeys.length !== expectedKeys.length
      || actualKeys.some((key, index) => key !== expectedKeys[index])) {
      throw new Error(`${field} metadata does not exactly match the clean-controller request`);
    }
    for (const key of expectedKeys) {
      if (info.metadata[key] !== options.expectedMetadata[key]) {
        throw new Error(`${field} metadata binding mismatch`);
      }
    }
    metadataHash = sha256Ref(options.expectedMetadata);
  }
  let deadline = null;
  if (options.maxEndAtMs !== undefined) {
    const parsedEndAt = info.endAt instanceof Date
      ? info.endAt.getTime()
      : Date.parse(info.endAt);
    if (!Number.isFinite(parsedEndAt)) throw new Error(`${field} does not report a valid TTL deadline`);
    if (parsedEndAt > options.maxEndAtMs) {
      throw new Error(`${field} TTL deadline exceeds the clean-controller bound`);
    }
    deadline = new Date(parsedEndAt).toISOString();
  }
  return deepFreeze({
    sandbox_id_hash: sha256Ref(sandboxId),
    state: typeof info.state === 'string' ? info.state : 'unknown',
    internet_access: 'verified_blocked',
    lifecycle: requireLifecycle ? 'verified_kill_no_auto_resume' : 'not_evaluated',
    metadata_hash: metadataHash,
    deadline,
    observation_hash: sha256Ref({
      sandbox_id_hash: sha256Ref(sandboxId),
      state: typeof info.state === 'string' ? info.state : 'unknown',
      allow_internet_access: false,
      allow_out: [],
      lifecycle: requireLifecycle
        ? { on_timeout: 'kill', auto_resume: false }
        : null,
      metadata_hash: metadataHash,
      deadline,
    }),
  });
}

function validateAttestation(result, request, expected = {}) {
  assertAllowedKeys(result, [
    'schema',
    'status',
    'request_hash',
    'evidence_ref',
    'evidence_hash',
    'claims',
    'trusted_bootstrap_artifact_hash',
    'trusted_runner_artifact_hash',
  ], 'authority-free source attestation');
  if (result.schema !== 'agoragentic.risk-fork.authority-free-source-attestation.v1') {
    throw new TypeError('Authority-free source attestation schema is invalid');
  }
  if (result.status !== 'verified') {
    throw new Error('An externally verified authority-free source attestation is required');
  }
  if (!safeEqual(result.request_hash, request.request_hash)) {
    throw new Error('Authority-free source attestation is not bound to this request');
  }
  requireOpaqueRef(result.evidence_ref, 'authority-free source attestation.evidence_ref');
  requireSha256Ref(result.evidence_hash, 'authority-free source attestation.evidence_hash');
  requireSha256Ref(
    result.trusted_bootstrap_artifact_hash,
    'authority-free source attestation.trusted_bootstrap_artifact_hash',
  );
  requireSha256Ref(
    result.trusted_runner_artifact_hash,
    'authority-free source attestation.trusted_runner_artifact_hash',
  );
  if (!safeEqual(
    result.trusted_bootstrap_artifact_hash,
    expected.trustedBootstrapArtifactHash,
  ) || !safeEqual(
    result.trusted_runner_artifact_hash,
    expected.trustedRunnerArtifactHash,
  )) {
    throw new Error('Authority-free source attestation does not bind the trusted runtime commands');
  }
  assertAllowedKeys(result.claims, [
    'authority_free',
    'credentials_absent',
    'wallet_material_absent',
    'execution_authority_absent',
    'untrusted_processes_absent',
    'source_network_denied',
    'entropy_rekey_required',
    'trusted_runtime_artifacts_verified',
  ], 'authority-free source attestation.claims');
  for (const claim of [
    'authority_free',
    'credentials_absent',
    'wallet_material_absent',
    'execution_authority_absent',
    'untrusted_processes_absent',
    'source_network_denied',
    'entropy_rekey_required',
    'trusted_runtime_artifacts_verified',
  ]) {
    if (result.claims[claim] !== true) {
      throw new Error(`Authority-free source attestation must verify ${claim}`);
    }
  }
  const normalized = cloneJson(result);
  return deepFreeze({
    ...normalized,
    attestation_hash: sha256Ref(normalized),
  });
}

function assertCommandSucceeded(result, field) {
  assertPlainObject(result, field);
  if (result.exitCode !== 0 || result.error) {
    throw new Error(`${field} failed`);
  }
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

function fixedMetadata(savepoint, forkIdentity, policy, trustedRuntime) {
  const metadata = {
    'agoragentic.risk_fork.schema': 'v1',
    'agoragentic.risk_fork.capsule_hash': savepoint.capsule_hash,
    'agoragentic.risk_fork.identity_hash': forkIdentity.identity_hash,
    'agoragentic.risk_fork.network_policy_hash': policy.policy_hash,
    'agoragentic.risk_fork.bootstrap_artifact_hash': trustedRuntime.bootstrapArtifactHash,
    'agoragentic.risk_fork.runner_artifact_hash': trustedRuntime.runnerArtifactHash,
  };
  assertStrictSecretFreeJson(metadata, 'E2B metadata', { maxBytes: 4_096 });
  return metadata;
}

export class E2BRiskForkAdapter extends RiskForkProvider {
  constructor(options = {}) {
    super({
      id: 'e2b-snapshot-v1',
      capabilities: {
        supports_memory_snapshot: true,
        supports_filesystem_snapshot: true,
        supports_live_fork: true,
        supports_network_policy: true,
        supports_egress_allowlist: false,
        supports_runtime_attestation: false,
        supports_suspend_resume: true,
        supports_verified_destruction: true,
        supports_hard_ttl: true,
        supports_idle_ttl: false,
        supports_max_execution_time: true,
        supports_automatic_credential_expiry: false,
        child_credentials_mode: 'prohibited',
        isolation_class: 'e2b_provider_isolation_claim_live_validation_pending',
        adapter_implementation: 'complete',
        mock_conformance: 'passed',
        credentialed_provider_validation: 'blocked',
        containment_claim: 'not_verified',
      },
    });
    if (typeof options.verifyAuthorityFreeSource !== 'function') {
      throw new TypeError('verifyAuthorityFreeSource must be an external clean-controller verifier');
    }
    if (options.SandboxClass !== undefined && typeof options.SandboxClass !== 'function') {
      throw new TypeError('SandboxClass must be a class');
    }
    if (options.sdkLoader !== undefined && typeof options.sdkLoader !== 'function') {
      throw new TypeError('sdkLoader must be a function');
    }
    this.verifyAuthorityFreeSource = options.verifyAuthorityFreeSource;
    this.SandboxClass = options.SandboxClass ?? null;
    this.sdkLoader = options.sdkLoader ?? defaultSdkLoader;
    this.clock = options.clock ?? (() => new Date());
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
    this.savepoints = new Map();
    this.forks = new Map();
  }

  async #sandboxClass() {
    if (!this.SandboxClass) {
      this.SandboxClass = normalizeSandboxClass(await this.sdkLoader());
    }
    for (const method of [
      'create',
      'getInfo',
      'createSnapshot',
      'deleteSnapshot',
      'listSnapshots',
    ]) {
      if (typeof this.SandboxClass[method] !== 'function') {
        throw new TypeError(`E2B Sandbox.${method} is required`);
      }
    }
    return this.SandboxClass;
  }

  #savepointRecord(ref) {
    const record = this.savepoints.get(ref);
    if (!record) throw new Error(`Unknown E2B savepoint: ${ref}`);
    return record;
  }

  #forkRecord(ref) {
    const record = this.forks.get(ref);
    if (!record) throw new Error(`Unknown E2B fork: ${ref}`);
    return record;
  }

  async #cleanupFailedFork(Sandbox, sandbox) {
    const sandboxId = typeof sandbox?.sandboxId === 'string' ? sandbox.sandboxId : null;
    if (!sandboxId || typeof sandbox?.kill !== 'function') {
      return { status: 'failed', reason: 'missing_cleanup_handle', fork_ref: null };
    }
    try {
      await sandbox.kill();
    } catch {
      return {
        status: 'failed',
        reason: 'kill_failed',
        fork_ref: `e2b-sandbox:${sandboxId}`,
      };
    }
    try {
      await Sandbox.getInfo(sandboxId);
      return {
        status: 'failed',
        reason: 'resource_still_present',
        fork_ref: `e2b-sandbox:${sandboxId}`,
      };
    } catch (error) {
      if (isNotFound(error)) return { status: 'verified', reason: 'not_found', fork_ref: null };
      return {
        status: 'unknown',
        reason: 'absence_check_failed',
        fork_ref: `e2b-sandbox:${sandboxId}`,
      };
    }
  }

  async createSavepoint(input = {}) {
    assertAllowedKeys(input, ['capsule', 'source_sandbox_id'], 'E2B createSavepoint input');
    verifySavepointCapsule(input.capsule, { now: this.clock() });
    const sourceSandboxId = requireString(
      input.source_sandbox_id,
      'source_sandbox_id',
      { maxLength: 500 },
    );
    const Sandbox = await this.#sandboxClass();

    // Check the provider control plane before snapshotting. The adapter never
    // calls connect(), because connect can resume a paused source.
    const sourceInfo = await Sandbox.getInfo(sourceSandboxId);
    const sourceObservation = safeProviderObservation(
      sourceInfo,
      sourceSandboxId,
      'E2B source sandbox',
    );
    if (sourceObservation.state !== 'running') {
      throw new Error('E2B source sandbox must already be running; this adapter will not auto-resume it');
    }

    const attestationRequest = {
      schema: 'agoragentic.risk-fork.authority-free-source-request.v1',
      provider: this.id,
      source_sandbox_id: sourceSandboxId,
      source_sandbox_id_hash: sha256Ref(sourceSandboxId),
      capsule_hash: input.capsule.capsule_hash,
      source_observation_hash: sourceObservation.observation_hash,
      trusted_bootstrap_command_hash: this.trustedBootstrapCommandHash,
      trusted_runner_command_hash: this.trustedRunnerCommandHash,
      trusted_bootstrap_artifact_hash: this.trustedBootstrapArtifactHash,
      trusted_runner_artifact_hash: this.trustedRunnerArtifactHash,
    };
    attestationRequest.request_hash = sha256Ref(attestationRequest);
    const attestation = validateAttestation(
      await this.verifyAuthorityFreeSource(deepFreeze(cloneJson(attestationRequest))),
      attestationRequest,
      {
        trustedBootstrapArtifactHash: this.trustedBootstrapArtifactHash,
        trustedRunnerArtifactHash: this.trustedRunnerArtifactHash,
      },
    );

    // The external check may take time or itself inspect the source. Recheck
    // provider state immediately before connecting and snapshotting so a
    // changed egress posture fails closed.
    const preSnapshotInfo = await Sandbox.getInfo(sourceSandboxId);
    const preSnapshotObservation = safeProviderObservation(
      preSnapshotInfo,
      sourceSandboxId,
      'E2B pre-snapshot source sandbox',
    );
    if (preSnapshotObservation.state !== 'running') {
      throw new Error('E2B source sandbox changed state before snapshot');
    }

    // Use the static control-plane operation. Sandbox.connect() auto-resumes a
    // paused source and is intentionally excluded from this adapter boundary.
    const snapshot = await Sandbox.createSnapshot(sourceSandboxId);
    const snapshotId = requireString(
      snapshot?.snapshotId ?? snapshot?.snapshotID ?? snapshot?.id,
      'E2B snapshot id',
      { maxLength: 500 },
    );
    const ref = `e2b-snapshot:${snapshotId}`;
    const snapshotHash = sha256Ref({
      snapshot_id_hash: sha256Ref(snapshotId),
      capsule_hash: input.capsule.capsule_hash,
      authority_sanitization_attestation_hash: attestation.attestation_hash,
    });
    const record = {
      ref,
      snapshot_id: snapshotId,
      source_sandbox_id_hash: sha256Ref(sourceSandboxId),
      capsule_hash: input.capsule.capsule_hash,
      snapshot_hash: snapshotHash,
      source_observation: sourceObservation,
      attestation,
      created_at: this.clock().toISOString(),
      destroyed: false,
      delete_status: 'not_requested',
    };
    this.savepoints.set(ref, record);
    return deepFreeze({
      savepoint_ref: ref,
      savepoint_hash: snapshotHash,
      runtime_snapshot: {
        mode: 'filesystem_and_memory',
        provider_ref: this.id,
        snapshot_ref: ref,
        snapshot_hash: snapshotHash,
        sanitization_attestation_ref: attestation.evidence_ref,
        sanitization_attestation_hash: attestation.attestation_hash,
        verification_status: 'verified',
      },
      source_network_status: 'verified_blocked',
      source_authority_status: 'verified_external_attestation',
      snapshot_integrity_status: 'unknown',
      evidence_status: 'observed',
    });
  }

  async createFork(input = {}) {
    assertAllowedKeys(
      input,
      ['savepoint_ref', 'fork_identity', 'network_policy', 'ttl_ms'],
      'E2B createFork input',
    );
    const savepoint = this.#savepointRecord(requireString(input.savepoint_ref, 'savepoint_ref'));
    if (savepoint.destroyed) throw new Error('Cannot fork a destroyed E2B snapshot');
    assertFreshForkIdentity(input.fork_identity);
    const policy = networkPolicy(input.network_policy);
    if (policy.mode !== 'blocked') {
      throw new Error('E2B Risk Fork v1 only admits a fully blocked egress policy');
    }
    const ttlMs = boundedInteger(
      input.ttl_ms ?? 5 * 60 * 1000,
      'ttl_ms',
      { min: 1_000, max: 24 * 60 * 60 * 1000 },
    );
    const Sandbox = await this.#sandboxClass();
    const metadata = fixedMetadata(savepoint, input.fork_identity, policy, {
      bootstrapArtifactHash: this.trustedBootstrapArtifactHash,
      runnerArtifactHash: this.trustedRunnerArtifactHash,
    });
    const createOptions = {
      timeoutMs: ttlMs,
      secure: true,
      allowInternetAccess: false,
      lifecycle: {
        onTimeout: 'kill',
        autoResume: false,
      },
      metadata,
    };

    let sandbox;
    try {
      const createStartedAt = this.clock();
      sandbox = await Sandbox.create(savepoint.snapshot_id, createOptions);
      const sandboxId = requireString(sandbox?.sandboxId, 'E2B fork sandbox id', { maxLength: 500 });
      if (safeEqual(sha256Ref(sandboxId), savepoint.source_sandbox_id_hash)) {
        throw new Error('E2B fork must have a distinct sandbox identity');
      }
      const childInfo = await Sandbox.getInfo(sandboxId);
      const childObservation = safeProviderObservation(
        childInfo,
        sandboxId,
        'E2B fork sandbox',
        {
          requireLifecycle: true,
          expectedMetadata: metadata,
          maxEndAtMs: createStartedAt.getTime() + ttlMs + 5_000,
        },
      );
      if (childObservation.state !== 'running') throw new Error('E2B fork did not start running');
      if (!sandbox.files || typeof sandbox.files.write !== 'function') {
        throw new TypeError('E2B fork must expose files.write');
      }
      if (!sandbox.commands || typeof sandbox.commands.run !== 'function') {
        throw new TypeError('E2B fork must expose commands.run');
      }
      const bootstrapPayload = assertStrictSecretFreeJson({
        schema: 'agoragentic.risk-fork.clean-bootstrap.v1',
        fork_identity: {
          fork_agent_id: input.fork_identity.fork_agent_id,
          session_id: input.fork_identity.session_id,
          runtime_identity: input.fork_identity.runtime_identity,
          nonce_namespace: input.fork_identity.nonce_namespace,
          entropy_state_ref: input.fork_identity.entropy_state_ref,
          issued_at: input.fork_identity.issued_at,
          identity_hash: input.fork_identity.identity_hash,
          parent_agent_ref: sha256Ref(input.fork_identity.parent_agent_id),
          parent_session_ref: sha256Ref(input.fork_identity.parent_session_id),
        },
        capsule_hash: savepoint.capsule_hash,
        network_policy_hash: policy.policy_hash,
        bootstrap_nonce: randomUUID(),
        inherited_authority_accepted: false,
        rekey_required: true,
      }, 'clean bootstrap payload', { maxBytes: 64 * 1024 });
      await sandbox.files.write(IDENTITY_PATH, JSON.stringify(bootstrapPayload));
      const bootstrapResult = await sandbox.commands.run(this.bootstrapCommand, {
        timeoutMs: Math.min(ttlMs, 60_000),
      });
      assertCommandSucceeded(bootstrapResult, 'E2B trusted bootstrap command');

      const now = this.clock();
      const ref = `e2b-sandbox:${sandboxId}`;
      const record = {
        ref,
        sandbox_id: sandboxId,
        sandbox,
        savepoint_ref: savepoint.ref,
        capsule_hash: savepoint.capsule_hash,
        identity_hash: input.fork_identity.identity_hash,
        network_policy_hash: policy.policy_hash,
        child_observation: childObservation,
        child_metadata: metadata,
        bootstrap_measurements: commandMeasurements(bootstrapResult),
        created_at: now.toISOString(),
        expires_at: new Date(now.getTime() + ttlMs).toISOString(),
        status: 'ready',
        last_execution: null,
        last_result: null,
        destroy_status: 'not_requested',
        destroyed_verified: false,
      };
      this.forks.set(ref, record);
      return deepFreeze({
        fork_ref: ref,
        fork_hash: sha256Ref({
          sandbox_id_hash: sha256Ref(sandboxId),
          savepoint_hash: savepoint.snapshot_hash,
          identity_hash: record.identity_hash,
          network_policy_hash: record.network_policy_hash,
        }),
        status: 'ready',
        expires_at: record.expires_at,
        isolation_class: this.capabilities.isolation_class,
        network_status: 'verified_blocked',
        lifecycle_status: 'verified_kill_no_auto_resume',
        ttl_status: 'verified_bounded',
        secure_create_request_status: 'observed',
        bootstrap_status: 'observed',
        inherited_authority_accepted: false,
      });
    } catch (error) {
      if (sandbox) {
        const cleanup = await this.#cleanupFailedFork(Sandbox, sandbox);
        if (cleanup.status !== 'verified') {
          const cleanupError = new Error(`E2B failed-fork cleanup is ${cleanup.status}: ${cleanup.reason}`);
          cleanupError.code = 'E2B_FAILED_FORK_CLEANUP_NOT_VERIFIED';
          cleanupError.fork_ref = cleanup.fork_ref;
          throw new AggregateError(
            [error, cleanupError],
            'E2B fork creation failed and cleanup absence was not verified',
          );
        }
      }
      throw error;
    }
  }

  async getForkStatus(input = {}) {
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
      const observation = safeProviderObservation(
        info,
        record.sandbox_id,
        'E2B fork status',
        {
          requireLifecycle: true,
          expectedMetadata: record.child_metadata,
        },
      );
      return deepFreeze({
        fork_ref: record.ref,
        status: record.status,
        provider_state: observation.state,
        expires_at: record.expires_at,
        evidence_status: 'verified_present',
      });
    } catch (error) {
      if (isNotFound(error)) {
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
    assertAllowedKeys(
      input,
      ['fork_ref', 'operation', 'execution_mode', 'timeout_ms', 'scoped_credentials'],
      'E2B executeInFork input',
    );
    const record = this.#forkRecord(requireString(input.fork_ref, 'fork_ref'));
    if (record.destroyed_verified || record.destroy_status !== 'not_requested') {
      throw new Error('Cannot execute in an E2B fork after destruction begins');
    }
    if (record.status === 'suspended') throw new Error('Cannot execute in a suspended E2B fork');
    if (input.scoped_credentials !== undefined && input.scoped_credentials !== null) {
      assertPlainObject(input.scoped_credentials, 'scoped_credentials');
      if (Object.keys(input.scoped_credentials).length > 0) {
        throw new Error('Risk Fork children must not receive credentials or execution authority');
      }
    }
    assertPlainObject(input.operation, 'operation');
    const executionMode = input.execution_mode === 'prepare_only'
      ? 'prepare_only'
      : input.execution_mode === 'isolated_execution'
        ? 'isolated_execution'
        : null;
    if (!executionMode) throw new TypeError('execution_mode is invalid');
    const operation = assertStrictSecretFreeJson(input.operation, 'operation');
    const timeoutMs = boundedInteger(
      input.timeout_ms ?? 60_000,
      'timeout_ms',
      { min: 100, max: 10 * 60 * 1000 },
    );
    const job = {
      schema: 'agoragentic.risk-fork.runner-job.v1',
      job_id: `rfj_${randomUUID()}`,
      capsule_hash: record.capsule_hash,
      identity_hash: record.identity_hash,
      network_policy_hash: record.network_policy_hash,
      execution_mode: executionMode,
      operation,
      authority_flags: {
        credentials_included: false,
        wallet_material_included: false,
        execution_authority_included: false,
      },
    };
    const started = this.clock();
    record.status = 'executing';
    try {
      await record.sandbox.files.write(JOB_PATH, JSON.stringify(job));
      const commandResult = await record.sandbox.commands.run(this.runnerCommand, { timeoutMs });
      assertCommandSucceeded(commandResult, 'E2B trusted runner command');
      const rawResult = await record.sandbox.files.read(RESULT_PATH);
      const resultText = typeof rawResult === 'string'
        ? rawResult
        : Buffer.from(rawResult).toString('utf8');
      if (Buffer.byteLength(resultText, 'utf8') > MAX_RESULT_BYTES) {
        throw new Error(`E2B runner result exceeds ${MAX_RESULT_BYTES} bytes`);
      }
      let parsed;
      try {
        parsed = JSON.parse(resultText);
      } catch {
        throw new Error('E2B trusted runner returned invalid JSON');
      }
      parsed = assertStrictSecretFreeJson(
        parsed,
        'E2B runner result',
        { maxBytes: MAX_RESULT_BYTES },
      );
      assertPlainObject(parsed, 'E2B runner result');
      if (parsed.schema !== 'agoragentic.risk-fork.runner-result.v1'
        || parsed.status !== 'completed') {
        throw new Error('E2B trusted runner returned an unsupported result envelope');
      }
      const completed = this.clock();
      record.status = 'tainted';
      record.last_result = cloneJson(parsed);
      record.last_execution = {
        started_at: started.toISOString(),
        completed_at: completed.toISOString(),
        duration_ms: Math.max(0, completed.getTime() - started.getTime()),
        result_hash: sha256Ref(parsed),
        command: commandMeasurements(commandResult),
      };
      return deepFreeze({
        status: 'completed',
        taint_status: 'TAINTED',
        commit_candidate: cloneJson(parsed.commit_candidate ?? null),
        result_hash: record.last_execution.result_hash,
        measurements: cloneJson(record.last_execution),
        authority_granted: false,
      });
    } catch (error) {
      record.status = 'failed';
      throw error;
    }
  }

  async collectEvidence(input = {}) {
    assertAllowedKeys(input, ['fork_ref'], 'E2B collectEvidence input');
    const record = this.#forkRecord(requireString(input.fork_ref, 'fork_ref'));
    const savepoint = this.#savepointRecord(record.savepoint_ref);
    const evidence = {
      fork_ref_hash: sha256Ref(record.ref),
      status: record.status,
      identity_hash: record.identity_hash,
      network_policy_hash: record.network_policy_hash,
      source_authority_status: 'verified_external_attestation',
      source_network_status: 'verified_blocked',
      fork_network_status: 'verified_blocked',
      snapshot_integrity_status: 'unknown',
      bootstrap_status: 'observed',
      runner_status: record.last_execution ? 'observed' : 'not_run',
      destruction_status: record.destroyed_verified ? 'verified' : record.destroy_status,
      sanitization_attestation_ref: savepoint.attestation.evidence_ref,
      sanitization_attestation_hash: savepoint.attestation.attestation_hash,
      last_execution: cloneJson(record.last_execution),
      raw_stdout_included: false,
      raw_stderr_included: false,
      credentials_included: false,
      wallet_material_included: false,
      execution_authority_included: false,
    };
    return deepFreeze({ ...evidence, evidence_hash: sha256Ref(evidence) });
  }

  async collectDiff(input = {}) {
    assertAllowedKeys(input, ['fork_ref'], 'E2B collectDiff input');
    const record = this.#forkRecord(requireString(input.fork_ref, 'fork_ref'));
    const diff = record.last_result?.workspace_diff;
    if (!diff) throw new Error('E2B runner did not produce a workspace diff candidate');
    assertPlainObject(diff, 'E2B runner workspace_diff');
    if (diff.type !== 'WORKSPACE_DIFF') {
      throw new Error('E2B runner workspace_diff must use WORKSPACE_DIFF');
    }
    return cloneJson(diff);
  }

  async suspendFork(input = {}) {
    assertAllowedKeys(input, ['fork_ref'], 'E2B suspendFork input');
    const record = this.#forkRecord(requireString(input.fork_ref, 'fork_ref'));
    if (record.destroyed_verified || record.destroy_status !== 'not_requested') {
      throw new Error('Cannot suspend an E2B fork after destruction begins');
    }
    if (typeof record.sandbox.pause !== 'function') {
      return deepFreeze({
        fork_ref: record.ref,
        status: 'unknown',
        evidence_status: 'unknown',
      });
    }
    await record.sandbox.pause();
    const Sandbox = await this.#sandboxClass();
    try {
      const info = await Sandbox.getInfo(record.sandbox_id);
      const observation = safeProviderObservation(
        info,
        record.sandbox_id,
        'E2B paused fork sandbox',
        { requireLifecycle: true },
      );
      if (observation.state !== 'paused') {
        return deepFreeze({
          fork_ref: record.ref,
          status: 'failed',
          evidence_status: 'failed',
        });
      }
      record.status = 'suspended';
      return deepFreeze({
        fork_ref: record.ref,
        status: 'suspended',
        evidence_status: 'verified',
      });
    } catch {
      return deepFreeze({
        fork_ref: record.ref,
        status: 'unknown',
        evidence_status: 'unknown',
      });
    }
  }

  async destroyFork(input = {}) {
    assertAllowedKeys(input, ['fork_ref', 'reason'], 'E2B destroyFork input');
    const record = this.#forkRecord(requireString(input.fork_ref, 'fork_ref'));
    if (record.destroyed_verified) {
      return deepFreeze({
        fork_ref: record.ref,
        status: 'already_destroyed_verified',
        evidence_status: 'verified',
      });
    }
    record.destroy_status = 'destroy_requested';
    record.status = 'destroy_requested';
    try {
      await record.sandbox.kill();
      record.destroy_status = 'kill_observed';
      return deepFreeze({
        fork_ref: record.ref,
        status: 'destroy_requested_observed',
        evidence_status: 'observed',
        evidence_hash: sha256Ref({
          fork_ref_hash: sha256Ref(record.ref),
          request: 'kill',
          provider_result: 'returned_without_error',
        }),
      });
    } catch {
      record.destroy_status = 'kill_failed';
      record.status = 'destroy_failed';
      return deepFreeze({
        fork_ref: record.ref,
        status: 'failed',
        evidence_status: 'failed',
        error_code: 'E2B_KILL_FAILED',
      });
    }
  }

  async verifyDestroyed(input = {}) {
    assertAllowedKeys(input, ['fork_ref'], 'E2B verifyDestroyed input');
    const record = this.#forkRecord(requireString(input.fork_ref, 'fork_ref'));
    const Sandbox = await this.#sandboxClass();
    try {
      await Sandbox.getInfo(record.sandbox_id);
      return deepFreeze({
        fork_ref: record.ref,
        status: 'failed',
        outcome: 'failure',
        evidence_status: 'verified_present',
        evidence_hash: sha256Ref({
          sandbox_id_hash: sha256Ref(record.sandbox_id),
          absent: false,
        }),
      });
    } catch (error) {
      if (!isNotFound(error)) {
        return deepFreeze({
          fork_ref: record.ref,
          status: 'unknown',
          outcome: 'unknown',
          evidence_status: 'unknown',
        });
      }
      record.destroyed_verified = true;
      record.destroy_status = 'verified_destroyed';
      record.status = 'destroyed';
      return deepFreeze({
        fork_ref: record.ref,
        status: 'verified',
        outcome: 'success',
        evidence_status: 'verified',
        evidence_ref: `e2b-absence:${sha256Ref(record.sandbox_id).slice(7, 23)}`,
        evidence_hash: sha256Ref({
          sandbox_id_hash: sha256Ref(record.sandbox_id),
          absent: true,
          source: 'Sandbox.getInfo.not_found',
        }),
      });
    }
  }

  async destroySavepoint(input = {}) {
    assertAllowedKeys(input, ['savepoint_ref'], 'E2B destroySavepoint input');
    const record = this.#savepointRecord(requireString(input.savepoint_ref, 'savepoint_ref'));
    const Sandbox = await this.#sandboxClass();
    if (typeof Sandbox.deleteSnapshot !== 'function') {
      record.delete_status = 'unsupported';
      return deepFreeze({
        savepoint_ref: record.ref,
        status: 'unknown',
        evidence_status: 'unknown',
      });
    }
    try {
      const deleted = await Sandbox.deleteSnapshot(record.snapshot_id);
      record.delete_status = deleted === true ? 'delete_observed' : 'not_found_observed';
      return deepFreeze({
        savepoint_ref: record.ref,
        status: 'destroy_requested_observed',
        evidence_status: 'observed',
        provider_delete_result: deleted === true ? 'deleted_observed' : 'not_found_observed',
        evidence_hash: sha256Ref({
          snapshot_id_hash: sha256Ref(record.snapshot_id),
          delete_result: deleted === true,
        }),
      });
    } catch {
      record.delete_status = 'delete_failed';
      return deepFreeze({
        savepoint_ref: record.ref,
        status: 'failed',
        evidence_status: 'failed',
        error_code: 'E2B_SNAPSHOT_DELETE_FAILED',
      });
    }
  }

  async verifySavepointDestroyed(input = {}) {
    assertAllowedKeys(input, ['savepoint_ref'], 'E2B verifySavepointDestroyed input');
    const record = this.#savepointRecord(requireString(input.savepoint_ref, 'savepoint_ref'));
    const Sandbox = await this.#sandboxClass();
    if (typeof Sandbox.listSnapshots !== 'function') {
      return deepFreeze({
        savepoint_ref: record.ref,
        status: 'unknown',
        outcome: 'unknown',
        evidence_status: 'unknown',
      });
    }
    try {
      const paginator = Sandbox.listSnapshots();
      if (!paginator || typeof paginator.nextItems !== 'function') {
        throw new TypeError('E2B listSnapshots did not return a paginator');
      }
      if (typeof paginator.hasNext !== 'boolean') {
        throw new TypeError('E2B snapshot paginator must report hasNext');
      }
      let pages = 0;
      while (paginator.hasNext === true) {
        pages += 1;
        if (pages > MAX_SNAPSHOT_PAGES) throw new Error('E2B snapshot listing exceeded the page bound');
        const items = await paginator.nextItems();
        if (!Array.isArray(items)) throw new TypeError('E2B snapshot page must be an array');
        for (const [index, item] of items.entries()) {
          const snapshotId = requireString(
            item?.snapshotId ?? item?.snapshotID ?? item?.id,
            `E2B snapshot page item ${index} id`,
            { maxLength: 500 },
          );
          if (snapshotId === record.snapshot_id) {
            return deepFreeze({
              savepoint_ref: record.ref,
              status: 'failed',
              outcome: 'failure',
              evidence_status: 'verified_present',
              evidence_hash: sha256Ref({
                snapshot_id_hash: sha256Ref(record.snapshot_id),
                absent: false,
              }),
            });
          }
        }
        if (typeof paginator.hasNext !== 'boolean') {
          throw new TypeError('E2B snapshot paginator stopped reporting hasNext');
        }
      }
      record.destroyed = true;
      record.delete_status = 'verified_destroyed';
      return deepFreeze({
        savepoint_ref: record.ref,
        status: 'verified',
        outcome: 'success',
        evidence_status: 'verified',
        evidence_ref: `e2b-snapshot-absence:${sha256Ref(record.snapshot_id).slice(7, 23)}`,
        evidence_hash: sha256Ref({
          snapshot_id_hash: sha256Ref(record.snapshot_id),
          absent: true,
          pages_examined: pages,
        }),
      });
    } catch {
      return deepFreeze({
        savepoint_ref: record.ref,
        status: 'unknown',
        outcome: 'unknown',
        evidence_status: 'unknown',
      });
    }
  }
}

export const E2B_RISK_FORK_PATHS = Object.freeze({
  identity: IDENTITY_PATH,
  job: JOB_PATH,
  result: RESULT_PATH,
});
