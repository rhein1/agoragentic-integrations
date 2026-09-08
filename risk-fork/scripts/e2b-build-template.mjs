#!/usr/bin/env node
import { constants } from 'node:fs';
import {
  lstat,
  mkdir,
  open,
  realpath,
} from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { createRiskForkE2BTemplate } from '../e2b-template/template.mjs';
import { canonicalize, sha256Ref } from '../src/canonical.mjs';
import {
  createE2BRuntimeSdkIntegrityVerifier,
  loadVerifiedE2BRuntimeSdk,
  sha256FileRef,
} from '../src/e2b-qualification.mjs';
import {
  requireOpaqueRef,
  requireSha256Ref,
  requireString,
} from '../src/util.mjs';
import { assertE2BEvidencePlatformSecurity } from './e2b-evidence-platform.mjs';

export const E2B_TEMPLATE_BUILD_SCHEMA =
  'agoragentic.risk-fork.e2b-template-build-evidence.v1';
export const E2B_TEMPLATE_BUILD_ATTEMPT_SCHEMA =
  'agoragentic.risk-fork.e2b-template-build-attempt-intent.v1';
export const E2B_QUALIFICATION_MAX_CANARY_COST_USD = '1.000000';

const PACKAGE_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DECIMAL = /^(?:0|[1-9][0-9]*)(?:\.[0-9]{1,6})?$/;
const TEMPLATE_ALIAS = /^[A-Za-z0-9][A-Za-z0-9._-]{2,99}$/;
const ATTEMPT_INTENT_KEYS = Object.freeze([
  'schema',
  'status',
  'provider_outcome',
  'sdk',
  'template_alias_hash',
  'template_evidence_hash',
  'provenance_hash',
  'runtime',
  'approval_ref_hash',
  'run_ref_hash',
  'claimed_at',
  'requested_cpu_count',
  'requested_memory_mb',
  'authorized_max_cost_usd',
  'raw_credentials_included',
  'wallet_material_included',
  'execution_authority_included',
  'production_activation_granted',
  'attempt_intent_hash',
]);
const SDK_BINDING_KEYS = Object.freeze(['package', 'version', 'integrity_hash']);
const RUNTIME_HASH_KEYS = Object.freeze([
  'template_definition_hash',
  'boot_guard_artifact_hash',
  'birth_watcher_artifact_hash',
  'bootstrap_artifact_hash',
  'runner_artifact_hash',
  'runtime_contract_hash',
  'birth_contract_hash',
  'mcp_http_phase_artifact_hash',
  'mcp_transport_contract_hash',
  'child_operation_hash',
  'canonical_hash',
  'transaction_assurance_canonical_hash',
  'util_hash',
]);

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

function canonicalCost(value, field) {
  if (typeof value !== 'string' || !DECIMAL.test(value)) {
    failGate(`${field} must be an explicit canonical USD cost cap`);
  }
  const [whole, fraction = ''] = value.split('.');
  return `${whole}.${fraction.padEnd(6, '0')}`;
}

function costMicros(value) {
  return BigInt(value.replace('.', ''));
}

function absoluteDirectory(value, field) {
  const raw = requireString(value, field);
  if (!path.isAbsolute(raw)) failGate(`${field} must be absolute`);
  return path.resolve(raw);
}

function assertOpaqueEnv(env, name) {
  try {
    return requireOpaqueRef(env[name], name, { maxLength: 500 });
  } catch (error) {
    failGate(error.message);
  }
}

function assertHashEnv(env, name) {
  try {
    return requireSha256Ref(env[name], name);
  } catch (error) {
    failGate(error.message);
  }
}

export function assertE2BTemplateBuildGate(env = process.env) {
  requireFlag(env, 'RISK_FORK_E2B_TEMPLATE_BUILD', '1');
  requireFlag(env, 'AGORAGENTIC_ALLOW_REAL_SPEND', '1');
  requireFlag(env, 'AGORAGENTIC_NO_SPEND', '0');
  requireCredentialPresence(env);
  const maxCostUsd = canonicalCost(
    env.RISK_FORK_E2B_MAX_COST_USD,
    'RISK_FORK_E2B_MAX_COST_USD',
  );
  if (costMicros(maxCostUsd) < 1n
    || costMicros(maxCostUsd) > costMicros(E2B_QUALIFICATION_MAX_CANARY_COST_USD)) {
    failGate(`RISK_FORK_E2B_MAX_COST_USD exceeds the code-level cost cap of ${E2B_QUALIFICATION_MAX_CANARY_COST_USD}`);
  }
  const templateAlias = assertOpaqueEnv(env, 'RISK_FORK_E2B_TEMPLATE_ALIAS');
  if (!TEMPLATE_ALIAS.test(templateAlias)) {
    failGate('RISK_FORK_E2B_TEMPLATE_ALIAS is invalid');
  }
  return Object.freeze({
    approvalRef: assertOpaqueEnv(env, 'RISK_FORK_E2B_APPROVAL_REF'),
    runRef: assertOpaqueEnv(env, 'RISK_FORK_E2B_RUN_REF'),
    evidenceDirectory: absoluteDirectory(
      env.RISK_FORK_E2B_EVIDENCE_DIRECTORY,
      'RISK_FORK_E2B_EVIDENCE_DIRECTORY',
    ),
    templateAlias,
    sdkIntegrityHash: assertHashEnv(env, 'RISK_FORK_E2B_SDK_INTEGRITY_HASH'),
    maxCostUsd,
  });
}

function sdkExport(module, name) {
  return module?.[name] ?? module?.default?.[name];
}

function rejectEvidenceProducingTestSeams(options) {
  for (const field of ['sdkLoader', 'sdkVersionLoader', 'clock']) {
    if (Object.hasOwn(options, field)) {
      throw new TypeError(
        `Injected E2B ${field} cannot run the evidence-producing template-build harness`,
      );
    }
  }
}

async function loadTemplateBuildSdk(gate) {
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

function requireBuildIdentifiers(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new TypeError('E2B Template.build must return immutable template and build ids');
  }
  return {
    templateId: requireOpaqueRef(
      value.templateId ?? value.templateID ?? value.template_id,
      'E2B immutable template id',
      { maxLength: 500 },
    ),
    buildId: requireOpaqueRef(
      value.buildId ?? value.buildID ?? value.build_id ?? value.id,
      'E2B template build id',
      { maxLength: 500 },
    ),
  };
}

async function runtimeHashes() {
  const files = {
    template_definition_hash: path.join(PACKAGE_ROOT, 'e2b-template', 'template.mjs'),
    boot_guard_artifact_hash: path.join(PACKAGE_ROOT, 'e2b-template', 'bin', 'boot-guard.mjs'),
    birth_watcher_artifact_hash: path.join(
      PACKAGE_ROOT,
      'e2b-template',
      'bin',
      'boot-guard.mjs',
    ),
    bootstrap_artifact_hash: path.join(PACKAGE_ROOT, 'e2b-template', 'bin', 'bootstrap.mjs'),
    runner_artifact_hash: path.join(PACKAGE_ROOT, 'e2b-template', 'bin', 'run.mjs'),
    runtime_contract_hash: path.join(PACKAGE_ROOT, 'e2b-template', 'lib', 'runtime-contract.mjs'),
    birth_contract_hash: path.join(
      PACKAGE_ROOT,
      'e2b-template',
      'lib',
      'runtime-contract.mjs',
    ),
    mcp_http_phase_artifact_hash: path.join(
      PACKAGE_ROOT,
      'e2b-template',
      'lib',
      'mcp-http-phase.mjs',
    ),
    mcp_transport_contract_hash: path.join(
      PACKAGE_ROOT,
      'src',
      'mcp-transport-contract.mjs',
    ),
    child_operation_hash: path.join(PACKAGE_ROOT, 'src', 'child-operation.mjs'),
    canonical_hash: path.join(PACKAGE_ROOT, 'src', 'canonical.mjs'),
    transaction_assurance_canonical_hash: path.join(
      PACKAGE_ROOT,
      '..',
      'transaction-assurance',
      'src',
      'canonical.mjs',
    ),
    util_hash: path.join(PACKAGE_ROOT, 'src', 'util.mjs'),
  };
  return Object.fromEntries(await Promise.all(Object.entries(files).map(async ([name, file]) => [
    name,
    await sha256FileRef(file),
  ])));
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
    throw new Error('E2B build evidence directory must be a canonical real directory');
  }
  if (typeof process.getuid !== 'function'
    || info.uid !== BigInt(process.getuid())
    || (info.mode & 0o7777n) !== 0o700n) {
    throw new Error('E2B build evidence directory ownership or mode is invalid');
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
  const error = new Error(message);
  error.code = code;
  throw error;
}

async function writeExclusiveEvidence(target, evidence, duplicateCode) {
  let handle;
  try {
    handle = await open(
      target,
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL,
      0o400,
    );
  } catch (error) {
    if (error?.code === 'EEXIST') {
      const duplicate = new Error('E2B template build run already has durable evidence');
      duplicate.code = duplicateCode;
      throw duplicate;
    }
    throw error;
  }
  try {
    await handle.writeFile(`${canonicalize(evidence)}\n`, 'utf8');
    await handle.sync();
  } finally {
    await handle.close();
  }
}

export async function persistE2BTemplateBuildAttempt(directory, intent) {
  assertE2BEvidencePlatformSecurity();
  assertExactObjectKeys(intent, ATTEMPT_INTENT_KEYS, 'E2B template build attempt intent');
  assertExactObjectKeys(intent.sdk, SDK_BINDING_KEYS, 'E2B template build attempt SDK');
  assertExactObjectKeys(intent.runtime, RUNTIME_HASH_KEYS, 'E2B template build attempt runtime');
  if (intent.schema !== E2B_TEMPLATE_BUILD_ATTEMPT_SCHEMA
    || intent.status !== 'attempt_claimed_provider_outcome_unknown') {
    throw new TypeError('E2B template build attempt intent is invalid');
  }
  if (intent.provider_outcome !== 'unknown'
    || intent.sdk.package !== 'e2b'
    || intent.sdk.version !== '2.39.0'
    || intent.requested_cpu_count !== 1
    || intent.requested_memory_mb !== 512
    || intent.raw_credentials_included !== false
    || intent.wallet_material_included !== false
    || intent.execution_authority_included !== false
    || intent.production_activation_granted !== false) {
    throw new TypeError('E2B template build attempt intent weakens the one-shot boundary');
  }
  requireSha256Ref(intent.sdk.integrity_hash, 'attempt intent SDK integrity_hash');
  for (const field of [
    'template_alias_hash',
    'template_evidence_hash',
    'provenance_hash',
    'approval_ref_hash',
  ]) requireSha256Ref(intent[field], `attempt intent ${field}`);
  for (const field of RUNTIME_HASH_KEYS) {
    requireSha256Ref(intent.runtime[field], `attempt intent runtime.${field}`);
  }
  if (intent.template_evidence_hash !== intent.provenance_hash) {
    throw new Error('E2B template build attempt provenance binding mismatch');
  }
  const claimedAt = new Date(intent.claimed_at);
  if (!Number.isFinite(claimedAt.getTime()) || claimedAt.toISOString() !== intent.claimed_at) {
    throw new TypeError('E2B template build attempt claimed_at is invalid');
  }
  if (canonicalCost(intent.authorized_max_cost_usd, 'attempt intent authorized_max_cost_usd')
    !== intent.authorized_max_cost_usd
    || costMicros(intent.authorized_max_cost_usd) < 1n
    || costMicros(intent.authorized_max_cost_usd)
      > costMicros(E2B_QUALIFICATION_MAX_CANARY_COST_USD)) {
    throw new Error('E2B template build attempt cost cap is invalid');
  }
  const runRefHash = requireSha256Ref(intent.run_ref_hash, 'attempt intent run_ref_hash');
  const attemptHash = requireSha256Ref(
    intent.attempt_intent_hash,
    'attempt intent attempt_intent_hash',
  );
  if (sha256Ref({ ...intent, attempt_intent_hash: null }) !== attemptHash) {
    throw new Error('E2B template build attempt intent hash mismatch');
  }
  const evidenceDirectory = absoluteDirectory(directory, 'E2B template build evidence directory');
  await prepareEvidenceDirectory(evidenceDirectory);
  const digest = runRefHash.slice(7);
  const approvalDigest = intent.approval_ref_hash.slice(7);
  const legacyEvidence = path.join(
    evidenceDirectory,
    `e2b-template-build-${digest.slice(0, 24)}.json`,
  );
  await assertAbsent(
    legacyEvidence,
    'E2B_TEMPLATE_BUILD_EVIDENCE_ALREADY_RECORDED',
    'E2B template build evidence already exists for this run',
  );
  const approvalClaim = path.join(
    evidenceDirectory,
    `e2b-template-build-approval-${approvalDigest}.json`,
  );
  await writeExclusiveEvidence(
    approvalClaim,
    intent,
    'E2B_TEMPLATE_BUILD_APPROVAL_ALREADY_USED',
  );
  await syncDirectory(evidenceDirectory);
  const target = path.join(evidenceDirectory, `e2b-template-build-attempt-${digest}.json`);
  await writeExclusiveEvidence(
    target,
    intent,
    'E2B_TEMPLATE_BUILD_ATTEMPT_ALREADY_RECORDED',
  );
  await syncDirectory(evidenceDirectory);
  await assertAbsent(
    legacyEvidence,
    'E2B_TEMPLATE_BUILD_EVIDENCE_ALREADY_RECORDED',
    'E2B template build evidence already exists for this run',
  );
  return target;
}

async function persistExclusive(directory, evidence) {
  await prepareEvidenceDirectory(directory);
  const target = path.join(
    directory,
    `e2b-template-build-${evidence.run_ref_hash.slice(7, 31)}.json`,
  );
  await writeExclusiveEvidence(target, evidence, 'E2B_TEMPLATE_BUILD_EVIDENCE_ALREADY_RECORDED');
  await syncDirectory(directory);
  if (!sameResolvedPath(await realpath(directory), directory)) {
    throw new Error('E2B build evidence directory identity changed');
  }
  return target;
}

function createTemplateBuildAttemptIntent({ gate, sdk, hashes, provenanceHash, claimedAt }) {
  const core = {
    schema: E2B_TEMPLATE_BUILD_ATTEMPT_SCHEMA,
    status: 'attempt_claimed_provider_outcome_unknown',
    provider_outcome: 'unknown',
    sdk,
    template_alias_hash: sha256Ref(gate.templateAlias),
    template_evidence_hash: provenanceHash,
    provenance_hash: provenanceHash,
    runtime: hashes,
    approval_ref_hash: sha256Ref(gate.approvalRef),
    run_ref_hash: sha256Ref(gate.runRef),
    claimed_at: claimedAt.toISOString(),
    requested_cpu_count: 1,
    requested_memory_mb: 512,
    authorized_max_cost_usd: gate.maxCostUsd,
    raw_credentials_included: false,
    wallet_material_included: false,
    execution_authority_included: false,
    production_activation_granted: false,
    attempt_intent_hash: null,
  };
  return Object.freeze({
    ...core,
    attempt_intent_hash: sha256Ref(core),
  });
}

export async function runE2BTemplateBuild(options = {}) {
  const gate = assertE2BTemplateBuildGate(options.env ?? process.env);
  rejectEvidenceProducingTestSeams(options);
  assertE2BEvidencePlatformSecurity();
  const sdkRuntime = await loadTemplateBuildSdk(gate);
  const Template = sdkExport(sdkRuntime.module, 'Template');
  const waitForFile = sdkExport(sdkRuntime.module, 'waitForFile');
  if (typeof Template !== 'function'
    || typeof Template.build !== 'function'
    || typeof waitForFile !== 'function') {
    throw new TypeError('Installed e2b@2.39.0 does not expose Template.build and waitForFile');
  }
  const hashes = await runtimeHashes();
  const provenanceHash = sha256Ref({
    sdk: sdkRuntime.binding,
    runtime: hashes,
  });
  const template = createRiskForkE2BTemplate({
    Template,
    waitForFile,
    contextRoot: path.resolve(PACKAGE_ROOT, '..'),
  });
  const startedAt = new Date();
  const attemptIntent = createTemplateBuildAttemptIntent({
    gate,
    sdk: sdkRuntime.binding,
    hashes,
    provenanceHash,
    claimedAt: startedAt,
  });
  const attemptIntentPath = await persistE2BTemplateBuildAttempt(
    gate.evidenceDirectory,
    attemptIntent,
  );
  const buildResult = await Template.build(template, gate.templateAlias, {
    cpuCount: 1,
    memoryMB: 512,
  });
  const completedAt = new Date();
  const { templateId, buildId } = requireBuildIdentifiers(buildResult);
  const core = {
    schema: E2B_TEMPLATE_BUILD_SCHEMA,
    status: 'build_observed_not_live_qualified',
    sdk: sdkRuntime.binding,
    template_id_hash: sha256Ref(templateId),
    build_id_hash: sha256Ref(buildId),
    template_evidence_hash: provenanceHash,
    provenance_hash: provenanceHash,
    runtime: hashes,
    approval_ref_hash: sha256Ref(gate.approvalRef),
    run_ref_hash: sha256Ref(gate.runRef),
    attempt_intent_hash: attemptIntent.attempt_intent_hash,
    started_at: startedAt.toISOString(),
    completed_at: completedAt.toISOString(),
    authorized_max_cost_usd: gate.maxCostUsd,
    observed_cost_usd: null,
    cost_within_cap: 'unknown',
    credentials_included: false,
    wallet_material_included: false,
    execution_authority_included: false,
    production_activation_granted: false,
    evidence_hash: null,
  };
  const evidence = Object.freeze({
    ...core,
    evidence_hash: sha256Ref(core),
  });
  const evidencePath = await persistExclusive(gate.evidenceDirectory, evidence);
  return Object.freeze({
    attemptIntent,
    attemptIntentPath,
    evidence,
    evidencePath,
    templateId,
  });
}

async function main() {
  const { evidence } = await runE2BTemplateBuild();
  process.stdout.write(`${JSON.stringify({
    status: evidence.status,
    evidence_hash: evidence.evidence_hash,
    template_id_hash: evidence.template_id_hash,
    build_id_hash: evidence.build_id_hash,
  })}\n`);
}

const isMain = process.argv[1]
  && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url;
if (isMain) {
  main().catch((error) => {
    process.stderr.write(`${JSON.stringify({
      status: 'failed',
      code: error?.code ?? 'E2B_TEMPLATE_BUILD_FAILED',
    })}\n`);
    process.exitCode = 1;
  });
}
