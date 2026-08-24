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

export const E2B_TEMPLATE_BUILD_SCHEMA =
  'agoragentic.risk-fork.e2b-template-build-evidence.v1';
export const E2B_QUALIFICATION_MAX_CANARY_COST_USD = '1.000000';

const PACKAGE_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DECIMAL = /^(?:0|[1-9][0-9]*)(?:\.[0-9]{1,6})?$/;
const TEMPLATE_ALIAS = /^[A-Za-z0-9][A-Za-z0-9._-]{2,99}$/;

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

async function persistExclusive(directory, evidence) {
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const info = await lstat(directory);
  if (info.isSymbolicLink() || !info.isDirectory() || await realpath(directory) !== directory) {
    throw new Error('E2B build evidence directory must be a canonical real directory');
  }
  const target = path.join(
    directory,
    `e2b-template-build-${evidence.run_ref_hash.slice(7, 31)}.json`,
  );
  const handle = await open(
    target,
    constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL,
    0o400,
  );
  try {
    await handle.writeFile(`${canonicalize(evidence)}\n`, 'utf8');
    await handle.sync();
  } finally {
    await handle.close();
  }
  return target;
}

export async function runE2BTemplateBuild(options = {}) {
  const gate = assertE2BTemplateBuildGate(options.env ?? process.env);
  rejectEvidenceProducingTestSeams(options);
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
  return Object.freeze({ evidence, evidencePath, templateId });
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
