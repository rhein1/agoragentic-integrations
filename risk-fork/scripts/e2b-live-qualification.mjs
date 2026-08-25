#!/usr/bin/env node
import { constants } from 'node:fs';
import {
  lstat,
  mkdir,
  open,
  realpath,
} from 'node:fs/promises';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import { setTimeout as pause } from 'node:timers/promises';
import { pathToFileURL } from 'node:url';

import {
  E2B_EXTERNAL_QUALIFICATION_EVIDENCE_REFS,
  E2B_QUALIFICATION_CONTROLS,
  E2B_QUALIFICATION_FAILURE_CLASSES,
  E2B_QUALIFICATION_FAILURE_STAGES,
  createE2BRuntimeSdkIntegrityVerifier,
  createE2BQualificationEvidence,
  loadVerifiedE2BRuntimeSdk,
} from '../src/e2b-qualification.mjs';
import {
  performE2BSandboxBirthHandshake,
  validateE2BSandboxInfo,
} from '../src/adapters/e2b.mjs';
import { canonicalize, sha256Ref } from '../src/canonical.mjs';
import {
  boundedInteger,
  requireOpaqueRef,
  requireSha256Ref,
  requireString,
} from '../src/util.mjs';
import { E2B_QUALIFICATION_MAX_CANARY_COST_USD } from './e2b-build-template.mjs';
import { assertE2BEvidencePlatformSecurity } from './e2b-evidence-platform.mjs';

const ALL_TRAFFIC = '0.0.0.0/0';
const DECIMAL = /^(?:0|[1-9][0-9]*)(?:\.[0-9]{1,6})?$/;
const PROFILE = 'agoragentic.risk-fork.e2b-live-qualification.v1';
const LIVE_ATTEMPT_SCHEMA =
  'agoragentic.risk-fork.e2b-live-qualification-attempt-intent.v1';
const PROVIDER_CALL_TIMEOUT_MS = 10_000;
const ABSENCE_OBSERVATION_COUNT = 3;
const ABSENCE_OBSERVATION_INTERVAL_MS = 250;
const CLEANUP_DISCOVERY_ROUNDS = 3;
const CLEANUP_RECONCILIATION_ROUNDS = 3;
const PROVIDER_INFO_FETCH_FAILURE_STAGES = new Set([
  'initial_provider_info_fetch',
  'execution_lease_info_fetch',
  'idle_lease_info_fetch',
]);
const PROVIDER_TIMEOUT_ERRORS = new WeakSet();
const LIVE_ATTEMPT_KEYS = Object.freeze([
  'schema',
  'status',
  'provider_outcome',
  'approval_ref_hash',
  'run_ref_hash',
  'project_ref_hash',
  'template_id_hash',
  'template_build_id_hash',
  'template_evidence_hash',
  'template_provenance_hash',
  'sdk_integrity_hash',
  'bootstrap_artifact_hash',
  'runner_artifact_hash',
  'boot_guard_artifact_hash',
  'limits_hash',
  'claimed_at',
  'sandbox_limit',
  'synthetic_workspace',
  'credentials_included',
  'wallet_material_included',
  'execution_authority_included',
  'production_activation_granted',
  'attempt_intent_hash',
]);

export const E2B_LIVE_QUALIFICATION_ATTEMPT_SCHEMA = LIVE_ATTEMPT_SCHEMA;

function failGate(message) {
  const error = new Error(message);
  error.code = 'E2B_OWNER_GATE_CLOSED';
  throw error;
}

function requireFlag(env, name, expected) {
  if (env[name] !== expected) failGate(`${name} is disabled or contradictory`);
}

function requireCredentialPresence(env) {
  if (!Object.hasOwn(env, 'E2B_API_KEY')
    || typeof env.E2B_API_KEY !== 'string'
    || env.E2B_API_KEY.length < 1) {
    failGate('E2B_API_KEY presence is required after owner authorization');
  }
}

function opaqueEnv(env, name) {
  try {
    return requireOpaqueRef(env[name], name, { maxLength: 500 });
  } catch (error) {
    failGate(error.message);
  }
}

function hashEnv(env, name) {
  try {
    return requireSha256Ref(env[name], name);
  } catch (error) {
    failGate(error.message);
  }
}

function integerEnv(env, name, bounds) {
  if (typeof env[name] !== 'string' || !/^[0-9]+$/.test(env[name])) {
    failGate(`${name} must be an explicit bounded integer`);
  }
  try {
    return boundedInteger(Number(env[name]), name, bounds);
  } catch (error) {
    failGate(error.message);
  }
}

function costEnv(env) {
  const value = env.RISK_FORK_E2B_MAX_COST_USD;
  if (typeof value !== 'string' || !DECIMAL.test(value)) {
    failGate('RISK_FORK_E2B_MAX_COST_USD must be an explicit canonical USD cost cap');
  }
  const [whole, fraction = ''] = value.split('.');
  const normalized = `${whole}.${fraction.padEnd(6, '0')}`;
  const micros = BigInt(normalized.replace('.', ''));
  const absoluteLimit = BigInt(E2B_QUALIFICATION_MAX_CANARY_COST_USD.replace('.', ''));
  if (micros < 1n || micros > absoluteLimit) {
    failGate(`RISK_FORK_E2B_MAX_COST_USD exceeds the code-level cost cap of ${E2B_QUALIFICATION_MAX_CANARY_COST_USD}`);
  }
  return normalized;
}

function absoluteDirectory(env, name) {
  const raw = requireString(env[name], name);
  if (!path.isAbsolute(raw)) failGate(`${name} must be absolute`);
  return path.resolve(raw);
}

export function assertE2BLiveQualificationGate(env = process.env) {
  requireFlag(env, 'RISK_FORK_E2B_LIVE_QUALIFICATION', '1');
  requireFlag(env, 'AGORAGENTIC_ALLOW_NETWORK_CANARIES', '1');
  requireFlag(env, 'AGORAGENTIC_ALLOW_REAL_SPEND', '1');
  requireFlag(env, 'AGORAGENTIC_NO_SPEND', '0');
  requireFlag(env, 'RISK_FORK_E2B_SYNTHETIC_WORKSPACE', '1');
  requireCredentialPresence(env);
  const hardTtlMs = integerEnv(env, 'RISK_FORK_E2B_HARD_TTL_MS', {
    min: 1_000,
    max: 24 * 60 * 60 * 1_000,
  });
  const idleTtlMs = integerEnv(env, 'RISK_FORK_E2B_IDLE_TTL_MS', {
    min: 1_000,
    max: hardTtlMs,
  });
  const maxExecutionMs = integerEnv(env, 'RISK_FORK_E2B_MAX_EXECUTION_MS', {
    min: 100,
    max: Math.min(hardTtlMs, 10 * 60 * 1_000),
  });
  return Object.freeze({
    approvalRef: opaqueEnv(env, 'RISK_FORK_E2B_APPROVAL_REF'),
    runRef: opaqueEnv(env, 'RISK_FORK_E2B_RUN_REF'),
    evidenceDirectory: absoluteDirectory(env, 'RISK_FORK_E2B_EVIDENCE_DIRECTORY'),
    projectRef: opaqueEnv(env, 'RISK_FORK_E2B_PROJECT_REF'),
    region: opaqueEnv(env, 'RISK_FORK_E2B_REGION'),
    templateId: opaqueEnv(env, 'RISK_FORK_E2B_TEMPLATE_ID'),
    templateEvidenceHash: hashEnv(env, 'RISK_FORK_E2B_TEMPLATE_EVIDENCE_HASH'),
    templateBuildIdHash: hashEnv(env, 'RISK_FORK_E2B_TEMPLATE_BUILD_ID_HASH'),
    templateProvenanceHash: hashEnv(env, 'RISK_FORK_E2B_TEMPLATE_PROVENANCE_HASH'),
    sdkIntegrityHash: hashEnv(env, 'RISK_FORK_E2B_SDK_INTEGRITY_HASH'),
    bootstrapArtifactHash: hashEnv(env, 'RISK_FORK_E2B_BOOTSTRAP_ARTIFACT_HASH'),
    runnerArtifactHash: hashEnv(env, 'RISK_FORK_E2B_RUNNER_ARTIFACT_HASH'),
    bootGuardArtifactHash: hashEnv(env, 'RISK_FORK_E2B_BOOT_GUARD_ARTIFACT_HASH'),
    hardTtlMs,
    idleTtlMs,
    maxExecutionMs,
    maxCostUsd: costEnv(env),
    sandboxLimit: 1,
    syntheticWorkspace: true,
  });
}

function sdkExport(module, name) {
  return module?.[name] ?? module?.default?.[name];
}

function rejectEvidenceProducingTestSeams(options) {
  for (const field of ['sdkLoader', 'sdkVersionLoader', 'canaryRunner', 'clock']) {
    if (Object.hasOwn(options, field)) {
      throw new TypeError(
        `Injected E2B ${field} cannot run the evidence-producing live-qualification harness`,
      );
    }
  }
}

function sameResolvedPath(left, right) {
  return path.relative(left, right) === '' && path.relative(right, left) === '';
}

function assertExactObjectKeys(value, expectedKeys, field) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new TypeError(`${field} must be an object`);
  }
  const actual = Object.keys(value).sort();
  const expected = [...expectedKeys].sort();
  if (actual.length !== expected.length
    || actual.some((key, index) => key !== expected[index])) {
    throw new TypeError(`${field} contains unsupported or missing fields`);
  }
}

async function prepareEvidenceDirectory(directory) {
  assertE2BEvidencePlatformSecurity();
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const info = await lstat(directory, { bigint: true });
  if (info.isSymbolicLink()
    || !info.isDirectory()
    || !sameResolvedPath(await realpath(directory), directory)) {
    throw new Error('E2B qualification evidence directory must be a canonical real directory');
  }
  if (typeof process.getuid !== 'function'
    || info.uid !== BigInt(process.getuid())
    || (info.mode & 0o7777n) !== 0o700n) {
    throw new Error('E2B qualification evidence directory ownership or mode is invalid');
  }
}

async function syncDirectory(directory) {
  let handle;
  try {
    handle = await open(directory, 'r');
    await handle.sync();
  } catch (error) {
    if (!['EINVAL', 'EISDIR', 'EPERM', 'ENOTSUP'].includes(error?.code)) throw error;
  } finally {
    await handle?.close().catch(() => {});
  }
}

async function assertAbsent(target, code, message) {
  try {
    await lstat(target);
  } catch (error) {
    if (error?.code === 'ENOENT') return;
    throw error;
  }
  const duplicate = new Error(message);
  duplicate.code = code;
  throw duplicate;
}

async function writeExclusiveEvidence(target, value, duplicateCode) {
  let handle;
  try {
    handle = await open(
      target,
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL,
      0o400,
    );
  } catch (error) {
    if (error?.code === 'EEXIST') {
      const duplicate = new Error('E2B qualification authority has already been consumed');
      duplicate.code = duplicateCode;
      throw duplicate;
    }
    throw error;
  }
  try {
    await handle.writeFile(`${canonicalize(value)}\n`, 'utf8');
    await handle.sync();
  } finally {
    await handle.close();
  }
}

function createLiveQualificationAttemptIntent(gate, claimedAt) {
  const core = {
    schema: LIVE_ATTEMPT_SCHEMA,
    status: 'attempt_claimed_provider_outcome_unknown',
    provider_outcome: 'unknown',
    approval_ref_hash: sha256Ref(gate.approvalRef),
    run_ref_hash: sha256Ref(gate.runRef),
    project_ref_hash: sha256Ref(gate.projectRef),
    template_id_hash: sha256Ref(gate.templateId),
    template_build_id_hash: gate.templateBuildIdHash,
    template_evidence_hash: gate.templateEvidenceHash,
    template_provenance_hash: gate.templateProvenanceHash,
    sdk_integrity_hash: gate.sdkIntegrityHash,
    bootstrap_artifact_hash: gate.bootstrapArtifactHash,
    runner_artifact_hash: gate.runnerArtifactHash,
    boot_guard_artifact_hash: gate.bootGuardArtifactHash,
    limits_hash: sha256Ref({
      hard_ttl_ms: gate.hardTtlMs,
      idle_ttl_ms: gate.idleTtlMs,
      max_execution_ms: gate.maxExecutionMs,
      max_cost_usd: gate.maxCostUsd,
    }),
    claimed_at: claimedAt.toISOString(),
    sandbox_limit: 1,
    synthetic_workspace: true,
    credentials_included: false,
    wallet_material_included: false,
    execution_authority_included: false,
    production_activation_granted: false,
    attempt_intent_hash: null,
  };
  return Object.freeze({ ...core, attempt_intent_hash: sha256Ref(core) });
}

export async function persistE2BLiveQualificationAttempt(directory, intent) {
  assertE2BEvidencePlatformSecurity();
  assertExactObjectKeys(intent, LIVE_ATTEMPT_KEYS, 'E2B live qualification attempt intent');
  if (intent.schema !== LIVE_ATTEMPT_SCHEMA
    || intent.status !== 'attempt_claimed_provider_outcome_unknown'
    || intent.provider_outcome !== 'unknown'
    || intent.sandbox_limit !== 1
    || intent.synthetic_workspace !== true
    || intent.credentials_included !== false
    || intent.wallet_material_included !== false
    || intent.execution_authority_included !== false
    || intent.production_activation_granted !== false) {
    throw new TypeError('E2B live qualification attempt intent weakens the one-shot boundary');
  }
  for (const field of LIVE_ATTEMPT_KEYS.filter((name) => name.endsWith('_hash'))) {
    requireSha256Ref(intent[field], `E2B live qualification attempt ${field}`);
  }
  const claimedAt = new Date(intent.claimed_at);
  if (!Number.isFinite(claimedAt.getTime()) || claimedAt.toISOString() !== intent.claimed_at) {
    throw new TypeError('E2B live qualification attempt claimed_at is invalid');
  }
  if (sha256Ref({ ...intent, attempt_intent_hash: null }) !== intent.attempt_intent_hash) {
    throw new Error('E2B live qualification attempt intent hash mismatch');
  }
  const requestedDirectory = requireString(
    directory,
    'E2B live qualification evidence directory',
  );
  if (!path.isAbsolute(requestedDirectory)) {
    throw new TypeError('E2B live qualification evidence directory must be absolute');
  }
  const evidenceDirectory = path.resolve(requestedDirectory);
  await prepareEvidenceDirectory(evidenceDirectory);
  const approvalDigest = intent.approval_ref_hash.slice(7);
  const runDigest = intent.run_ref_hash.slice(7);
  const finalEvidence = path.join(
    evidenceDirectory,
    `e2b-qualification-${runDigest.slice(0, 24)}.json`,
  );
  await assertAbsent(
    finalEvidence,
    'E2B_LIVE_QUALIFICATION_EVIDENCE_ALREADY_RECORDED',
    'E2B live qualification evidence already exists for this run',
  );
  const approvalClaim = path.join(
    evidenceDirectory,
    `e2b-live-qualification-approval-${approvalDigest}.json`,
  );
  await writeExclusiveEvidence(
    approvalClaim,
    intent,
    'E2B_LIVE_QUALIFICATION_APPROVAL_ALREADY_USED',
  );
  await syncDirectory(evidenceDirectory);
  const runClaim = path.join(
    evidenceDirectory,
    `e2b-live-qualification-attempt-${runDigest}.json`,
  );
  await writeExclusiveEvidence(
    runClaim,
    intent,
    'E2B_LIVE_QUALIFICATION_ATTEMPT_ALREADY_RECORDED',
  );
  await syncDirectory(evidenceDirectory);
  await assertAbsent(
    finalEvidence,
    'E2B_LIVE_QUALIFICATION_EVIDENCE_ALREADY_RECORDED',
    'E2B live qualification evidence already exists for this run',
  );
  return runClaim;
}

async function loadLiveQualificationSdk(gate) {
  const verifier = createE2BRuntimeSdkIntegrityVerifier();
  const loaded = await loadVerifiedE2BRuntimeSdk({
    package: 'e2b',
    version: '2.39.0',
    integrity_hash: gate.sdkIntegrityHash,
  }, verifier);
  return Object.freeze({
    module: loaded.module,
    binding: Object.freeze({
      package: loaded.package,
      version: loaded.version,
      integrity_hash: loaded.integrity_hash,
    }),
  });
}

function isSandboxNotFound(error, SandboxNotFoundError) {
  return typeof SandboxNotFoundError === 'function'
    && error instanceof SandboxNotFoundError;
}

function providerTimeout(label) {
  const error = new Error(`E2B provider operation timed out: ${label}`);
  error.code = 'E2B_PROVIDER_OPERATION_TIMEOUT';
  PROVIDER_TIMEOUT_ERRORS.add(error);
  return error;
}

function classifyPrimaryCanaryFailure(
  stage,
  defaultFailureClass,
  error,
  SandboxNotFoundError,
) {
  if (!E2B_QUALIFICATION_FAILURE_STAGES.includes(stage) || stage === 'none') {
    throw new TypeError('E2B primary canary failure stage is invalid');
  }
  if (!E2B_QUALIFICATION_FAILURE_CLASSES.includes(defaultFailureClass)
    || defaultFailureClass === 'none') {
    throw new TypeError('E2B primary canary failure class is invalid');
  }
  let failureClass = defaultFailureClass;
  if (PROVIDER_INFO_FETCH_FAILURE_STAGES.has(stage)
    && isSandboxNotFound(error, SandboxNotFoundError)) {
    failureClass = 'provider_absence';
  } else if (PROVIDER_TIMEOUT_ERRORS.has(error)) {
    failureClass = 'provider_timeout';
  }
  return Object.freeze({ failureStage: stage, failureClass });
}

async function withProviderCall(label, timeoutMs, operation) {
  const boundedTimeoutMs = boundedInteger(timeoutMs, `${label} timeout`, {
    min: 100,
    max: PROVIDER_CALL_TIMEOUT_MS,
  });
  const controller = new AbortController();
  let timer;
  try {
    const timeout = new Promise((_, reject) => {
      timer = setTimeout(() => {
        controller.abort(providerTimeout(label));
        reject(providerTimeout(label));
      }, boundedTimeoutMs);
    });
    return await Promise.race([
      Promise.resolve().then(() => operation({
        signal: controller.signal,
        requestTimeoutMs: boundedTimeoutMs,
      })),
      timeout,
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function sandboxId(value) {
  return requireString(
    value?.sandboxId ?? value?.sandboxID ?? value?.id,
    'E2B qualification sandbox id',
    { maxLength: 500 },
  );
}

function emptyControls() {
  return Object.fromEntries(E2B_QUALIFICATION_CONTROLS.map((name) => [name, 'unknown']));
}

async function listByMetadata(Sandbox, metadata, templateId, timeoutMs) {
  return withProviderCall(
    'Sandbox.list exact-bound pagination',
    timeoutMs,
    async (request) => {
      const paginator = Sandbox.list({
        ...request,
        query: { state: ['running', 'paused'], metadata },
      });
      if (!paginator || typeof paginator.nextItems !== 'function'
        || typeof paginator.hasNext !== 'boolean') {
        throw new TypeError('E2B Sandbox.list must return a bounded paginator');
      }
      const ids = [];
      let pages = 0;
      while (paginator.hasNext === true) {
        pages += 1;
        if (pages > 10) throw new Error('E2B qualification listing exceeded 10 pages');
        const items = await paginator.nextItems(request);
        if (!Array.isArray(items)) {
          throw new TypeError('E2B qualification list page is invalid');
        }
        for (const item of items) {
          const itemTemplateId = item?.templateId ?? item?.templateID;
          if (canonicalize(item?.metadata) !== canonicalize(metadata)
            || itemTemplateId !== templateId) {
            throw new Error(
              'E2B qualification listing returned an item outside the exact metadata/template binding',
            );
          }
          ids.push(sandboxId(item));
        }
        if (typeof paginator.hasNext !== 'boolean') {
          throw new TypeError('E2B qualification paginator stopped reporting hasNext');
        }
      }
      return [...new Set(ids)].sort();
    },
  );
}

function sandboxStillPresent(stage, sandboxIds = []) {
  const error = new Error(`E2B qualification sandbox is still present during ${stage}`);
  error.code = 'E2B_QUALIFICATION_SANDBOX_STILL_PRESENT';
  error.sandboxIds = [...new Set(sandboxIds)].sort();
  return error;
}

async function requireSandboxNotFound(
  Sandbox,
  SandboxNotFoundError,
  id,
  stage,
  timeoutMs,
) {
  let notFound = false;
  try {
    await withProviderCall(
      `Sandbox.getInfo:${stage}`,
      timeoutMs,
      (request) => Sandbox.getInfo(id, request),
    );
  } catch (error) {
    if (!isSandboxNotFound(error, SandboxNotFoundError)) throw error;
    notFound = true;
  }
  if (!notFound) throw sandboxStillPresent(stage, [id]);
}

async function verifyStableSandboxAbsence(
  Sandbox,
  SandboxNotFoundError,
  sandboxIds,
  metadata,
  templateId,
  {
    timeoutMs,
    wait = pause,
    monotonicNow = () => performance.now(),
  },
) {
  const startedAt = monotonicNow();
  const exactSandboxIds = [...new Set(sandboxIds)].sort();
  if (exactSandboxIds.length === 0) {
    throw new TypeError('E2B qualification absence verification requires a sandbox identity');
  }
  const observations = [];
  for (let index = 0; index < ABSENCE_OBSERVATION_COUNT; index += 1) {
    if (index > 0) await wait(ABSENCE_OBSERVATION_INTERVAL_MS);
    for (const id of exactSandboxIds) {
      await requireSandboxNotFound(
        Sandbox,
        SandboxNotFoundError,
        id,
        `provider absence observation ${index + 1}`,
        timeoutMs,
      );
    }
    const remaining = await listByMetadata(Sandbox, metadata, templateId, timeoutMs);
    if (remaining.length !== 0) {
      throw sandboxStillPresent(`exact-bound listing ${index + 1}`, remaining);
    }
    observations.push({
      ordinal: index + 1,
      elapsed_ms: Math.max(0, Math.floor(monotonicNow() - startedAt)),
      sandbox_count: exactSandboxIds.length,
      provider_not_found: true,
      exact_bound_listing_empty: true,
    });
  }
  const finalElapsedMs = observations.at(-1)?.elapsed_ms ?? 0;
  if (finalElapsedMs < ABSENCE_OBSERVATION_INTERVAL_MS * (ABSENCE_OBSERVATION_COUNT - 1)) {
    throw new Error('E2B qualification absence observations are not freshness-spaced');
  }
  return Object.freeze({
    count: observations.length,
    minimum_interval_ms: ABSENCE_OBSERVATION_INTERVAL_MS,
    elapsed_ms: finalElapsedMs,
    observations,
    evidence_hash: sha256Ref(observations),
  });
}

async function runDefaultE2BSingleSandboxCanary({
  Sandbox,
  SandboxNotFoundError,
  gate,
  clock,
  wait = pause,
  monotonicNow = () => performance.now(),
}) {
  if (typeof SandboxNotFoundError !== 'function') {
    throw new TypeError('Installed e2b@2.39.0 lacks SandboxNotFoundError');
  }
  const controls = emptyControls();
  const cleanup = {
    kill_requested: 'unknown',
    absence_verified: 'unknown',
    orphan_reconciliation: 'unknown',
  };
  const runHash = sha256Ref(gate.runRef);
  const metadata = {
    'agoragentic.risk_fork.profile': PROFILE,
    'agoragentic.risk_fork.run_hash': runHash,
  };
  let sandbox = null;
  let id = null;
  let bootEvidence = null;
  let providerTemplateBindingHash = null;
  let birthRequestHash = null;
  let birthAttestationHash = null;
  let sandboxBirthBindingHash = null;
  let providerErrorHash = null;
  let failureStage = 'none';
  let failureClass = 'none';
  let activeFailureStage = 'sandbox_create';
  let activeFailureClass = 'provider_call_failure';
  let killRequestHash = null;
  let absenceEvidence = null;
  let sandboxLimitExceeded = false;
  const knownSandboxIds = new Set();
  const killAttemptedIds = new Set();
  const killAcknowledgements = new Map();
  const lifecycleObservations = [];
  const providerCallTimeoutMs = Math.min(PROVIDER_CALL_TIMEOUT_MS, gate.hardTtlMs);
  const startedAt = new Date(clock());
  let createdAt = null;
  let cleanupStartedAt = null;
  let completedAt = null;
  const rememberSandboxIds = (candidates) => {
    for (const candidate of candidates) knownSandboxIds.add(candidate);
    if (!id && knownSandboxIds.size === 1) id = [...knownSandboxIds][0];
    if (knownSandboxIds.size > 1) sandboxLimitExceeded = true;
  };
  const discoverExactSandboxIds = async () => {
    const matches = await listByMetadata(
      Sandbox,
      metadata,
      gate.templateId,
      providerCallTimeoutMs,
    );
    rememberSandboxIds(matches);
    return matches;
  };
  const recordKillAcknowledgement = (sandboxIdValue, requestedAt) => {
    killAcknowledgements.set(sandboxIdValue, sha256Ref({
      sandbox_id_hash: sha256Ref(sandboxIdValue),
      requested_at: requestedAt,
      provider_acknowledged: true,
    }));
  };
  const killKnownSandboxes = async () => {
    for (const candidate of [...knownSandboxIds].sort()) {
      if (killAttemptedIds.has(candidate)) continue;
      killAttemptedIds.add(candidate);
      const requestedAt = new Date(clock()).toISOString();
      try {
        const result = await withProviderCall(
          'Sandbox.kill:reconciliation',
          providerCallTimeoutMs,
          (request) => Sandbox.kill(candidate, request),
        );
        if (result === true) recordKillAcknowledgement(candidate, requestedAt);
      } catch {
        // Each exact sandbox identity receives at most one kill attempt. A
        // timeout or error stays unknown and is never retry authority.
      }
    }
  };
  try {
    sandbox = await withProviderCall(
      'Sandbox.create',
      providerCallTimeoutMs,
      (request) => Sandbox.create(gate.templateId, {
        ...request,
        timeoutMs: gate.idleTtlMs,
        secure: true,
        allowInternetAccess: false,
        network: {
          allowOut: [],
          denyOut: [ALL_TRAFFIC],
          allowPublicTraffic: false,
        },
        lifecycle: { onTimeout: 'kill', autoResume: false },
        envs: {},
        iam: { tokens: {} },
        volumeMounts: {},
        metadata,
      }),
    );
    createdAt = new Date(clock());
    activeFailureStage = 'sandbox_handle_validation';
    activeFailureClass = 'canary_contract_failure';
    id = sandboxId(sandbox);
    knownSandboxIds.add(id);
    if (typeof sandbox?.kill !== 'function'
      || typeof sandbox?.setTimeout !== 'function'
      || typeof sandbox?.files?.read !== 'function'
      || typeof sandbox?.files?.write !== 'function') {
      throw new TypeError('E2B qualification sandbox is missing lifecycle or file APIs');
    }
    activeFailureStage = 'initial_provider_info_fetch';
    activeFailureClass = 'provider_call_failure';
    const info = await withProviderCall(
      'Sandbox.getInfo:initial',
      providerCallTimeoutMs,
      (request) => Sandbox.getInfo(id, request),
    );
    activeFailureStage = 'initial_provider_info_validation';
    activeFailureClass = 'provider_contract_contradiction';
    lifecycleObservations.push(validateE2BSandboxInfo(info, {
      sandboxId: id,
      templateId: gate.templateId,
      metadata,
      createdAtMs: startedAt.getTime(),
      hardExpiresAtMs: startedAt.getTime() + gate.hardTtlMs,
      field: 'E2B qualification canary',
    }));
    activeFailureStage = 'birth_handshake';
    activeFailureClass = 'canary_contract_failure';
    providerTemplateBindingHash = sha256Ref({
      sandbox_id_hash: sha256Ref(id),
      metadata_hash: sha256Ref(metadata),
      template_id_hash: sha256Ref(gate.templateId),
      template_build_id_hash: gate.templateBuildIdHash,
      template_evidence_hash: gate.templateEvidenceHash,
      template_provenance_hash: gate.templateProvenanceHash,
      sdk_integrity_hash: gate.sdkIntegrityHash,
    });
    const birth = await withProviderCall(
      'sandbox birth handshake',
      Math.min(providerCallTimeoutMs, gate.maxExecutionMs),
      () => performE2BSandboxBirthHandshake({
        sandbox,
        sandboxId: id,
        metadata,
        templateId: gate.templateId,
        templateEvidenceHash: gate.templateEvidenceHash,
        templateProvenanceHash: gate.templateProvenanceHash,
        allocationStartedAt: startedAt,
        bootstrapArtifactHash: gate.bootstrapArtifactHash,
        runnerArtifactHash: gate.runnerArtifactHash,
        timeoutMs: gate.maxExecutionMs,
        clock,
      }),
    );
    birthRequestHash = birth.request.request_hash;
    birthAttestationHash = birth.attestation.attestation_hash;
    bootEvidence = birth.bootEvidence;
    sandboxBirthBindingHash = sha256Ref({
      sandbox_id_hash: sha256Ref(id),
      metadata_hash: sha256Ref(metadata),
      template_id_hash: sha256Ref(gate.templateId),
      template_evidence_hash: gate.templateEvidenceHash,
      template_provenance_hash: gate.templateProvenanceHash,
      birth_request_hash: birthRequestHash,
      birth_attestation_hash: birthAttestationHash,
      boot_evidence_hash: bootEvidence.evidence_hash,
      boot_observed_at: bootEvidence.observed_at,
      allocation_started_at: startedAt.toISOString(),
    });
    const bootMappings = {
      inherited_environment_absent: 'unauthorized_environment_absent',
      inherited_processes_absent: 'inherited_parent_processes_absent',
      credential_files_absent: 'credential_files_absent',
      wallet_material_absent: 'wallet_signing_material_absent',
      persistent_mounts_absent: 'persistent_mounts_absent',
      unauthorized_sockets_absent: 'unauthorized_sockets_absent',
      fresh_entropy_verified: 'fresh_entropy_verified',
    };
    for (const [control, claim] of Object.entries(bootMappings)) {
      controls[control] = bootEvidence.claims[claim] === true ? 'verified' : 'failed';
    }
    // Boot-local socket outcomes are deliberately insufficient for these two
    // controls. A reviewed external controlled-canary observer must supply the
    // missing evidence before either can become verified.
    controls.first_instruction_ipv4_egress_denied = 'unknown';
    controls.first_instruction_ipv6_egress_denied = 'unknown';
    const executionLeaseMs = Math.min(
      gate.maxExecutionMs + 5_000,
      gate.hardTtlMs,
    );
    const executionLeaseRequestedAt = new Date(clock());
    activeFailureStage = 'execution_lease_set';
    activeFailureClass = 'provider_call_failure';
    await withProviderCall(
      'sandbox.setTimeout:execution',
      providerCallTimeoutMs,
      (request) => sandbox.setTimeout(executionLeaseMs, request),
    );
    activeFailureStage = 'execution_lease_info_fetch';
    activeFailureClass = 'provider_call_failure';
    const executionInfo = await withProviderCall(
      'Sandbox.getInfo:execution-lease',
      providerCallTimeoutMs,
      (request) => Sandbox.getInfo(id, request),
    );
    activeFailureStage = 'execution_lease_info_validation';
    activeFailureClass = 'provider_contract_contradiction';
    lifecycleObservations.push(validateE2BSandboxInfo(executionInfo, {
      sandboxId: id,
      templateId: gate.templateId,
      metadata,
      createdAtMs: startedAt.getTime(),
      hardExpiresAtMs: startedAt.getTime() + gate.hardTtlMs,
      leaseRequestedAtMs: executionLeaseRequestedAt.getTime(),
      leaseTimeoutMs: executionLeaseMs,
      field: 'E2B qualification execution lease',
    }));
    const idleLeaseRequestedAt = new Date(clock());
    activeFailureStage = 'idle_lease_set';
    activeFailureClass = 'provider_call_failure';
    await withProviderCall(
      'sandbox.setTimeout:idle',
      providerCallTimeoutMs,
      (request) => sandbox.setTimeout(gate.idleTtlMs, request),
    );
    activeFailureStage = 'idle_lease_info_fetch';
    activeFailureClass = 'provider_call_failure';
    const idleInfo = await withProviderCall(
      'Sandbox.getInfo:idle-lease',
      providerCallTimeoutMs,
      (request) => Sandbox.getInfo(id, request),
    );
    activeFailureStage = 'idle_lease_info_validation';
    activeFailureClass = 'provider_contract_contradiction';
    lifecycleObservations.push(validateE2BSandboxInfo(idleInfo, {
      sandboxId: id,
      templateId: gate.templateId,
      metadata,
      createdAtMs: startedAt.getTime(),
      hardExpiresAtMs: startedAt.getTime() + gate.hardTtlMs,
      leaseRequestedAtMs: idleLeaseRequestedAt.getTime(),
      leaseTimeoutMs: gate.idleTtlMs,
      field: 'E2B qualification idle lease',
    }));
    activeFailureStage = 'none';
    activeFailureClass = 'none';
    controls.latency_observed = 'verified';
  } catch (error) {
    ({ failureStage, failureClass } = classifyPrimaryCanaryFailure(
      activeFailureStage,
      activeFailureClass,
      error,
      SandboxNotFoundError,
    ));
    providerErrorHash = sha256Ref(String(error?.code ?? error?.name ?? 'provider_error'));
  } finally {
    cleanupStartedAt = new Date(clock());
    try {
      await discoverExactSandboxIds();
    } catch {
      cleanup.orphan_reconciliation = 'unknown';
    }
    if (typeof sandbox?.kill === 'function') {
      const instanceKillId = id;
      if (instanceKillId) killAttemptedIds.add(instanceKillId);
      const killRequestedAt = new Date(clock()).toISOString();
      try {
        const killResult = await withProviderCall(
          'sandbox.kill',
          providerCallTimeoutMs,
          (request) => sandbox.kill(request),
        );
        if (instanceKillId && killResult === true) {
          recordKillAcknowledgement(instanceKillId, killRequestedAt);
        }
      } catch {
        // The instance kill is a single attempt. Static cleanup does not
        // replay the same exact identity after an ambiguous result.
      }
    }
    await killKnownSandboxes();
    for (let round = 0; round < CLEANUP_DISCOVERY_ROUNDS; round += 1) {
      if (round > 0) await wait(ABSENCE_OBSERVATION_INTERVAL_MS);
      try {
        await discoverExactSandboxIds();
        await killKnownSandboxes();
      } catch {
        cleanup.orphan_reconciliation = 'unknown';
        break;
      }
    }
    if (knownSandboxIds.size > 0) {
      for (let round = 0; round < CLEANUP_RECONCILIATION_ROUNDS; round += 1) {
        const knownBefore = knownSandboxIds.size;
        try {
          absenceEvidence = await verifyStableSandboxAbsence(
            Sandbox,
            SandboxNotFoundError,
            [...knownSandboxIds],
            metadata,
            gate.templateId,
            {
              timeoutMs: providerCallTimeoutMs,
              wait,
              monotonicNow,
            },
          );
          cleanup.absence_verified = 'verified';
          cleanup.orphan_reconciliation = 'verified';
          break;
        } catch (error) {
          if (Array.isArray(error?.sandboxIds)) rememberSandboxIds(error.sandboxIds);
          if (knownSandboxIds.size > knownBefore) {
            await killKnownSandboxes();
            continue;
          }
          const stillPresent = error?.code === 'E2B_QUALIFICATION_SANDBOX_STILL_PRESENT';
          cleanup.absence_verified = stillPresent ? 'failed' : 'unknown';
          cleanup.orphan_reconciliation = stillPresent ? 'failed' : 'unknown';
          break;
        }
      }
    } else {
      cleanup.orphan_reconciliation = 'unknown';
    }
    if (knownSandboxIds.size > 0
      && [...knownSandboxIds].every((candidate) => killAcknowledgements.has(candidate))) {
      cleanup.kill_requested = 'verified';
    }
    if (knownSandboxIds.size === 1) {
      killRequestHash = killAcknowledgements.get([...knownSandboxIds][0]) ?? null;
    }
    completedAt = new Date(clock());
  }
  if (sandboxLimitExceeded) {
    const error = new Error('E2B qualification exceeded one exact-bound sandbox');
    error.code = 'E2B_QUALIFICATION_SANDBOX_LIMIT_EXCEEDED';
    throw error;
  }
  controls.destruction_semantics_verified = cleanup.kill_requested === 'verified'
    && cleanup.absence_verified === 'verified' ? 'verified' : 'unknown';
  controls.orphan_reconciliation_verified = cleanup.orphan_reconciliation;
  const observation = {
    sandbox_id_hash: id ? sha256Ref(id) : null,
    template_id_hash: sha256Ref(gate.templateId),
    metadata_hash: sha256Ref(metadata),
    provider_template_binding_hash: providerTemplateBindingHash,
    birth_request_hash: birthRequestHash,
    birth_attestation_hash: birthAttestationHash,
    boot_evidence_hash: bootEvidence?.evidence_hash ?? null,
    sandbox_birth_binding_hash: sandboxBirthBindingHash,
    ipv4_probe_hash: bootEvidence?.observation_hashes.ipv4_probe_hash ?? null,
    ipv6_probe_hash: bootEvidence?.observation_hashes.ipv6_probe_hash ?? null,
    lifecycle_observations_hash: lifecycleObservations.length > 0
      ? sha256Ref(lifecycleObservations)
      : null,
    kill_request_hash: killRequestHash,
    terminal_absence_evidence_hash: absenceEvidence?.evidence_hash ?? null,
    provider_error_hash: providerErrorHash,
    failure_stage: failureStage,
    failure_class: failureClass,
    controls,
    cleanup,
  };
  const evidenceRefs = [{
    ref: E2B_EXTERNAL_QUALIFICATION_EVIDENCE_REFS.canary_evidence_hash,
    hash: sha256Ref(observation),
  }, {
    ref: E2B_EXTERNAL_QUALIFICATION_EVIDENCE_REFS.metadata_hash,
    hash: observation.metadata_hash,
  }];
  if (id) {
    evidenceRefs.push({
      ref: E2B_EXTERNAL_QUALIFICATION_EVIDENCE_REFS.sandbox_id_hash,
      hash: observation.sandbox_id_hash,
    });
  }
  if (providerTemplateBindingHash) {
    evidenceRefs.push({
      ref: E2B_EXTERNAL_QUALIFICATION_EVIDENCE_REFS.provider_template_binding_hash,
      hash: providerTemplateBindingHash,
    });
  }
  if (birthRequestHash) {
    evidenceRefs.push({
      ref: E2B_EXTERNAL_QUALIFICATION_EVIDENCE_REFS.birth_request_hash,
      hash: birthRequestHash,
    });
  }
  if (birthAttestationHash) {
    evidenceRefs.push({
      ref: E2B_EXTERNAL_QUALIFICATION_EVIDENCE_REFS.birth_attestation_hash,
      hash: birthAttestationHash,
    });
  }
  if (bootEvidence) {
    evidenceRefs.push(
      {
        ref: E2B_EXTERNAL_QUALIFICATION_EVIDENCE_REFS.boot_evidence_hash,
        hash: bootEvidence.evidence_hash,
      },
      {
        ref: E2B_EXTERNAL_QUALIFICATION_EVIDENCE_REFS.ipv4_probe_hash,
        hash: bootEvidence.observation_hashes.ipv4_probe_hash,
      },
      {
        ref: E2B_EXTERNAL_QUALIFICATION_EVIDENCE_REFS.ipv6_probe_hash,
        hash: bootEvidence.observation_hashes.ipv6_probe_hash,
      },
    );
  }
  if (sandboxBirthBindingHash) {
    evidenceRefs.push({
      ref: E2B_EXTERNAL_QUALIFICATION_EVIDENCE_REFS.sandbox_birth_binding_hash,
      hash: sandboxBirthBindingHash,
    });
  }
  if (lifecycleObservations.length > 0) {
    evidenceRefs.push({
      ref: 'evidence:e2b-controller-lifecycle-observations',
      hash: observation.lifecycle_observations_hash,
    });
  }
  if (killRequestHash) {
    evidenceRefs.push({
      ref: 'evidence:e2b-provider-kill-acknowledgement',
      hash: killRequestHash,
    });
  }
  if (absenceEvidence) {
    evidenceRefs.push({
      ref: 'evidence:e2b-fresh-terminal-absence-observations',
      hash: absenceEvidence.evidence_hash,
    });
  }
  return {
    startedAt: startedAt.toISOString(),
    completedAt: completedAt.toISOString(),
    sandboxCount: id || sandbox ? 1 : 0,
    observations: {
      fork_start_ms: createdAt
        ? Math.max(0, createdAt.getTime() - startedAt.getTime())
        : 0,
      execution_ms: 0,
      cleanup_ms: Math.max(0, completedAt.getTime() - cleanupStartedAt.getTime()),
      observed_cost_usd: null,
      failure_stage: failureStage,
      failure_class: failureClass,
    },
    controls,
    cleanup,
    evidenceRefs,
  };
}

async function persistExclusive(directory, evidence) {
  await prepareEvidenceDirectory(directory);
  const target = path.join(
    directory,
    `e2b-qualification-${evidence.run.run_ref_hash.slice(7, 31)}.json`,
  );
  await writeExclusiveEvidence(
    target,
    evidence,
    'E2B_LIVE_QUALIFICATION_EVIDENCE_ALREADY_RECORDED',
  );
  await syncDirectory(directory);
  if (!sameResolvedPath(await realpath(directory), directory)) {
    throw new Error('E2B qualification evidence directory identity changed');
  }
  return target;
}

export async function runE2BLiveQualification(options = {}) {
  const gate = assertE2BLiveQualificationGate(options.env ?? process.env);
  rejectEvidenceProducingTestSeams(options);
  assertE2BEvidencePlatformSecurity();
  const attemptIntent = createLiveQualificationAttemptIntent(gate, new Date());
  const attemptIntentPath = await persistE2BLiveQualificationAttempt(
    gate.evidenceDirectory,
    attemptIntent,
  );
  const sdkRuntime = await loadLiveQualificationSdk(gate);
  const Sandbox = sdkExport(sdkRuntime.module, 'Sandbox');
  const SandboxNotFoundError = sdkExport(sdkRuntime.module, 'SandboxNotFoundError');
  if (typeof Sandbox?.create !== 'function'
    || typeof Sandbox?.getInfo !== 'function'
    || typeof Sandbox?.list !== 'function'
    || typeof Sandbox?.kill !== 'function'
    || typeof SandboxNotFoundError !== 'function') {
    throw new TypeError('Installed e2b@2.39.0 lacks the required Sandbox APIs');
  }
  const clock = () => new Date();
  const canary = await runDefaultE2BSingleSandboxCanary({
    Sandbox,
    SandboxNotFoundError,
    gate,
    clock,
  });
  const evidence = createE2BQualificationEvidence({
    provider: {
      name: 'e2b',
      project_ref_hash: sha256Ref(gate.projectRef),
      region: gate.region,
    },
    sdk: sdkRuntime.binding,
    template: {
      template_id_hash: sha256Ref(gate.templateId),
      build_id_hash: gate.templateBuildIdHash,
      template_evidence_hash: gate.templateEvidenceHash,
      provenance_hash: gate.templateProvenanceHash,
    },
    runtime: {
      bootstrap_artifact_hash: gate.bootstrapArtifactHash,
      runner_artifact_hash: gate.runnerArtifactHash,
      boot_guard_artifact_hash: gate.bootGuardArtifactHash,
    },
    run: {
      approval_ref_hash: sha256Ref(gate.approvalRef),
      run_ref_hash: sha256Ref(gate.runRef),
      started_at: canary.startedAt,
      completed_at: canary.completedAt,
      sandbox_count: canary.sandboxCount,
      synthetic_workspace: true,
    },
    limits: {
      hard_ttl_ms: gate.hardTtlMs,
      idle_ttl_ms: gate.idleTtlMs,
      max_execution_ms: gate.maxExecutionMs,
      max_cost_usd: gate.maxCostUsd,
    },
    observations: canary.observations,
    controls: canary.controls,
    cleanup: canary.cleanup,
    evidence_refs: canary.evidenceRefs,
    external_observation_receipt: null,
  });
  const evidencePath = await persistExclusive(gate.evidenceDirectory, evidence);
  return Object.freeze({
    attemptIntent,
    attemptIntentPath,
    evidence,
    evidencePath,
  });
}

async function main() {
  const { evidence } = await runE2BLiveQualification();
  process.stdout.write(`${JSON.stringify({
    status: evidence.status,
    evidence_hash: evidence.evidence_hash,
    production_activation_granted: false,
  })}\n`);
}

const isMain = process.argv[1]
  && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url;
if (isMain) {
  main().catch((error) => {
    process.stderr.write(`${JSON.stringify({
      status: 'failed',
      code: error?.code ?? 'E2B_LIVE_QUALIFICATION_FAILED',
    })}\n`);
    process.exitCode = 1;
  });
}
