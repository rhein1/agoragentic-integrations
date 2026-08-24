#!/usr/bin/env node
import { constants } from 'node:fs';
import {
  lstat,
  mkdir,
  open,
  realpath,
} from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

import {
  E2B_EXTERNAL_QUALIFICATION_EVIDENCE_REFS,
  E2B_QUALIFICATION_CONTROLS,
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

const ALL_TRAFFIC = '0.0.0.0/0';
const DECIMAL = /^(?:0|[1-9][0-9]*)(?:\.[0-9]{1,6})?$/;
const PROFILE = 'agoragentic.risk-fork.e2b-live-qualification.v1';

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

function isSandboxNotFound(error) {
  const code = String(error?.code ?? '').toUpperCase();
  const name = String(error?.name ?? '').toUpperCase();
  return error?.status === 404
    || error?.statusCode === 404
    || error?.response?.status === 404
    || code === 'SANDBOX_NOT_FOUND'
    || name === 'SANDBOXNOTFOUNDERROR';
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

async function listByMetadata(Sandbox, metadata, templateId) {
  const paginator = Sandbox.list({
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
    const items = await paginator.nextItems();
    if (!Array.isArray(items)) throw new TypeError('E2B qualification list page is invalid');
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
}

function sandboxStillPresent(stage) {
  const error = new Error(`E2B qualification sandbox is still present during ${stage}`);
  error.code = 'E2B_QUALIFICATION_SANDBOX_STILL_PRESENT';
  return error;
}

async function requireSandboxNotFound(Sandbox, id, stage) {
  let notFound = false;
  try {
    await Sandbox.getInfo(id);
  } catch (error) {
    if (!isSandboxNotFound(error)) throw error;
    notFound = true;
  }
  if (!notFound) throw sandboxStillPresent(stage);
}

async function verifyStableSandboxAbsence(Sandbox, id, metadata, templateId) {
  await requireSandboxNotFound(Sandbox, id, 'first provider lookup');
  const remaining = await listByMetadata(Sandbox, metadata, templateId);
  if (remaining.length !== 0) throw sandboxStillPresent('exact-bound listing');
  await requireSandboxNotFound(Sandbox, id, 'second provider lookup');
}

async function runDefaultE2BSingleSandboxCanary({ Sandbox, gate, clock }) {
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
  const startedAt = new Date(clock());
  let createdAt = null;
  let cleanupStartedAt = null;
  let completedAt = null;
  try {
    sandbox = await Sandbox.create(gate.templateId, {
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
    });
    createdAt = new Date(clock());
    id = sandboxId(sandbox);
    if (typeof sandbox?.kill !== 'function'
      || typeof sandbox?.setTimeout !== 'function'
      || typeof sandbox?.files?.read !== 'function'
      || typeof sandbox?.files?.write !== 'function') {
      throw new TypeError('E2B qualification sandbox is missing lifecycle or file APIs');
    }
    const info = await Sandbox.getInfo(id);
    validateE2BSandboxInfo(info, {
      sandboxId: id,
      templateId: gate.templateId,
      metadata,
      createdAtMs: startedAt.getTime(),
      hardExpiresAtMs: startedAt.getTime() + gate.hardTtlMs,
      field: 'E2B qualification canary',
    });
    providerTemplateBindingHash = sha256Ref({
      sandbox_id_hash: sha256Ref(id),
      metadata_hash: sha256Ref(metadata),
      template_id_hash: sha256Ref(gate.templateId),
      template_build_id_hash: gate.templateBuildIdHash,
      template_evidence_hash: gate.templateEvidenceHash,
      template_provenance_hash: gate.templateProvenanceHash,
      sdk_integrity_hash: gate.sdkIntegrityHash,
    });
    const birth = await performE2BSandboxBirthHandshake({
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
    });
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
    await sandbox.setTimeout(Math.min(
      gate.maxExecutionMs + 5_000,
      gate.hardTtlMs,
    ));
    await Sandbox.getInfo(id);
    await sandbox.setTimeout(gate.idleTtlMs);
    await Sandbox.getInfo(id);
    controls.latency_observed = 'verified';
  } catch (error) {
    providerErrorHash = sha256Ref(String(error?.code ?? error?.name ?? 'provider_error'));
  } finally {
    cleanupStartedAt = new Date(clock());
    try {
      if (!sandbox && !id) {
        const matches = await listByMetadata(Sandbox, metadata, gate.templateId);
        if (matches.length > 1) throw new Error('E2B qualification exceeded one sandbox');
        if (matches.length === 1) id = matches[0];
      }
      if (sandbox) await sandbox.kill();
      else if (id) await Sandbox.kill(id);
      cleanup.kill_requested = id ? 'verified' : 'unknown';
    } catch {
      cleanup.kill_requested = 'unknown';
    }
    if (id) {
      try {
        await verifyStableSandboxAbsence(Sandbox, id, metadata, gate.templateId);
        cleanup.absence_verified = 'verified';
        cleanup.orphan_reconciliation = 'verified';
      } catch (error) {
        const stillPresent = error?.code === 'E2B_QUALIFICATION_SANDBOX_STILL_PRESENT';
        cleanup.absence_verified = stillPresent ? 'failed' : 'unknown';
        cleanup.orphan_reconciliation = stillPresent ? 'failed' : 'unknown';
      }
    } else {
      try {
        const remaining = await listByMetadata(Sandbox, metadata, gate.templateId);
        cleanup.orphan_reconciliation = remaining.length === 0 ? 'verified' : 'failed';
      } catch {
        cleanup.orphan_reconciliation = 'unknown';
      }
    }
    completedAt = new Date(clock());
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
    provider_error_hash: providerErrorHash,
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
  return {
    startedAt: startedAt.toISOString(),
    completedAt: completedAt.toISOString(),
    sandboxCount: 1,
    observations: {
      fork_start_ms: createdAt
        ? Math.max(0, createdAt.getTime() - startedAt.getTime())
        : 0,
      execution_ms: 0,
      cleanup_ms: Math.max(0, completedAt.getTime() - cleanupStartedAt.getTime()),
      observed_cost_usd: null,
    },
    controls,
    cleanup,
    evidenceRefs,
  };
}

async function persistExclusive(directory, evidence) {
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const info = await lstat(directory);
  if (info.isSymbolicLink() || !info.isDirectory() || await realpath(directory) !== directory) {
    throw new Error('E2B qualification evidence directory must be a canonical real directory');
  }
  const target = path.join(
    directory,
    `e2b-qualification-${evidence.run.run_ref_hash.slice(7, 31)}.json`,
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

export async function runE2BLiveQualification(options = {}) {
  const gate = assertE2BLiveQualificationGate(options.env ?? process.env);
  rejectEvidenceProducingTestSeams(options);
  const sdkRuntime = await loadLiveQualificationSdk(gate);
  const Sandbox = sdkExport(sdkRuntime.module, 'Sandbox');
  if (typeof Sandbox?.create !== 'function'
    || typeof Sandbox?.getInfo !== 'function'
    || typeof Sandbox?.list !== 'function'
    || typeof Sandbox?.kill !== 'function') {
    throw new TypeError('Installed e2b@2.39.0 lacks the required Sandbox APIs');
  }
  const clock = () => new Date();
  const canary = await runDefaultE2BSingleSandboxCanary({
    Sandbox,
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
  return Object.freeze({ evidence, evidencePath });
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
