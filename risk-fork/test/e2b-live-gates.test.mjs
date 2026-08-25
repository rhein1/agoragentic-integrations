import assert from 'node:assert/strict';
import {
  lstat,
  mkdtemp,
  readFile,
  readdir,
  rm,
  writeFile,
} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import test from 'node:test';

import { FileNotFoundError, SandboxNotFoundError } from 'e2b';

import {
  E2B_TEMPLATE_BUILD_ATTEMPT_SCHEMA,
  assertE2BTemplateBuildGate,
  persistE2BTemplateBuildAttempt,
  runE2BTemplateBuild,
} from '../scripts/e2b-build-template.mjs';
import {
  E2B_LIVE_QUALIFICATION_ATTEMPT_SCHEMA,
  assertE2BLiveQualificationGate,
  persistE2BLiveQualificationAttempt,
  runE2BLiveQualification,
} from '../scripts/e2b-live-qualification.mjs';
import { E2B_WINDOWS_EVIDENCE_DACL_UNVERIFIED } from '../scripts/e2b-evidence-platform.mjs';
import {
  E2B_BOOT_EVIDENCE_PATH,
  createBootEvidenceEnvelope,
  createE2BBirthAttestation,
  e2bBirthRequestPaths,
} from '../e2b-template/lib/runtime-contract.mjs';
import { canonicalize, sha256Ref } from '../src/canonical.mjs';
import {
  E2B_EXTERNAL_QUALIFICATION_EVIDENCE_REFS,
  E2B_QUALIFICATION_FAILURE_CLASSES,
  E2B_QUALIFICATION_FAILURE_STAGES,
} from '../src/e2b-qualification.mjs';

const contradictory = Object.freeze({
  E2B_API_KEY: 'present-but-never-inspected-by-test',
  AGORAGENTIC_ALLOW_REAL_SPEND: '1',
  AGORAGENTIC_NO_SPEND: '1',
  AGORAGENTIC_ALLOW_NETWORK_CANARIES: '1',
  RISK_FORK_E2B_TEMPLATE_BUILD: '1',
  RISK_FORK_E2B_LIVE_QUALIFICATION: '1',
  RISK_FORK_E2B_MAX_COST_USD: '0.10',
});

function validEnv(evidenceDirectory = path.resolve(os.tmpdir(), 'risk-fork-e2b-evidence')) {
  return {
    E2B_API_KEY: 'present-but-never-returned',
    AGORAGENTIC_ALLOW_REAL_SPEND: '1',
    AGORAGENTIC_NO_SPEND: '0',
    AGORAGENTIC_ALLOW_NETWORK_CANARIES: '1',
    RISK_FORK_E2B_TEMPLATE_BUILD: '1',
    RISK_FORK_E2B_LIVE_QUALIFICATION: '1',
    RISK_FORK_E2B_APPROVAL_REF: 'owner-approved-risk-fork-e2b-qualification',
    RISK_FORK_E2B_RUN_REF: 'risk-fork-e2b-canary-001',
    RISK_FORK_E2B_EVIDENCE_DIRECTORY: evidenceDirectory,
    RISK_FORK_E2B_TEMPLATE_ALIAS: 'risk-fork-clean-v1-canary',
    RISK_FORK_E2B_TEMPLATE_ID: 'risk-fork-clean-v1-canary',
    RISK_FORK_E2B_PROJECT_REF: 'isolated-canary-project',
    RISK_FORK_E2B_REGION: 'us-west',
    RISK_FORK_E2B_MAX_COST_USD: '0.10',
    RISK_FORK_E2B_HARD_TTL_MS: '60000',
    RISK_FORK_E2B_IDLE_TTL_MS: '5000',
    RISK_FORK_E2B_MAX_EXECUTION_MS: '5000',
    RISK_FORK_E2B_SDK_INTEGRITY_HASH: `sha256:${'1'.repeat(64)}`,
    RISK_FORK_E2B_TEMPLATE_EVIDENCE_HASH: `sha256:${'2'.repeat(64)}`,
    RISK_FORK_E2B_TEMPLATE_BUILD_ID_HASH: `sha256:${'3'.repeat(64)}`,
    RISK_FORK_E2B_TEMPLATE_PROVENANCE_HASH: `sha256:${'4'.repeat(64)}`,
    RISK_FORK_E2B_BOOTSTRAP_ARTIFACT_HASH: `sha256:${'5'.repeat(64)}`,
    RISK_FORK_E2B_RUNNER_ARTIFACT_HASH: `sha256:${'6'.repeat(64)}`,
    RISK_FORK_E2B_BOOT_GUARD_ARTIFACT_HASH: `sha256:${'7'.repeat(64)}`,
    RISK_FORK_E2B_SYNTHETIC_WORKSPACE: '1',
  };
}

function qualificationSandboxInfo(
  env,
  sandboxId,
  metadata,
  endAt = '2030-01-01T00:01:10.000Z',
) {
  return {
    sandboxId,
    templateId: env.RISK_FORK_E2B_TEMPLATE_ID,
    state: 'running',
    allowInternetAccess: false,
    network: {
      allowOut: [],
      denyOut: ['0.0.0.0/0'],
      allowPublicTraffic: false,
    },
    lifecycle: { onTimeout: 'kill', autoResume: false },
    volumeMounts: [],
    metadata,
    endAt,
  };
}

function liveAttemptIntent(env, claimedAt = '2030-01-01T00:00:00.000Z') {
  const gate = assertE2BLiveQualificationGate(env);
  const core = {
    schema: E2B_LIVE_QUALIFICATION_ATTEMPT_SCHEMA,
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
    claimed_at: claimedAt,
    sandbox_limit: 1,
    synthetic_workspace: true,
    credentials_included: false,
    wallet_material_included: false,
    execution_authority_included: false,
    production_activation_granted: false,
    attempt_intent_hash: null,
  };
  return { ...core, attempt_intent_hash: sha256Ref(core) };
}

function freshnessClock() {
  let elapsed = 0;
  return {
    wait: async (milliseconds) => { elapsed += milliseconds; },
    monotonicNow: () => elapsed,
  };
}

function qualificationBootEvidence(
  env,
  observedAt = '2030-01-01T00:00:10.000Z',
  bootNonce = 'default-live-canary-boot-nonce',
) {
  return createBootEvidenceEnvelope({
    observed_at: observedAt,
    expires_at: '2030-01-01T00:05:00.000Z',
    boot_nonce: bootNonce,
    boot_id_hash: sha256Ref('boot-id'),
    entropy_hash: sha256Ref('entropy'),
    bootstrap_artifact_hash: env.RISK_FORK_E2B_BOOTSTRAP_ARTIFACT_HASH,
    runner_artifact_hash: env.RISK_FORK_E2B_RUNNER_ARTIFACT_HASH,
    measurements: {
      environment_key_count: 1,
      process_count: 1,
      socket_count: 0,
      mount_count: 1,
      credential_path_count: 0,
    },
    observation_hashes: {
      environment_keys_hash: sha256Ref('environment'),
      processes_hash: sha256Ref('processes'),
      sockets_hash: sha256Ref('sockets'),
      mounts_hash: sha256Ref('mounts'),
      credential_paths_hash: sha256Ref('credentials'),
      ipv4_probe_hash: sha256Ref('ipv4'),
      ipv6_probe_hash: sha256Ref('ipv6'),
    },
    claims: {
      inherited_parent_processes_absent: true,
      unauthorized_environment_absent: true,
      credential_files_absent: true,
      wallet_signing_material_absent: true,
      inherited_authority_records_absent: true,
      persistent_mounts_absent: true,
      unauthorized_sockets_absent: true,
      first_instruction_ipv4_egress_denied: true,
      first_instruction_ipv6_egress_denied: true,
      fresh_entropy_verified: true,
      trusted_runtime_artifacts_verified: true,
    },
  });
}

function byteStream(value) {
  const bytes = Buffer.from(value, 'utf8');
  return new ReadableStream({
    start(controller) {
      controller.enqueue(bytes);
      controller.close();
    },
  });
}

function createBirthHandshakeFiles(env, observedAt = '2030-01-01T00:00:10.000Z') {
  const storage = new Map();
  const state = { writes: [], request: null, attestation: null, bootEvidence: null };
  return {
    state,
    files: {
      async write(target, value) {
        const text = String(value);
        state.writes.push({ target, value: text });
        storage.set(target, text);
        if (!target.endsWith('.ready')) return;
        const requestHash = text.trim();
        const paths = e2bBirthRequestPaths(requestHash);
        if (target !== paths.trigger) return;
        const request = JSON.parse(storage.get(paths.request));
        const bootEvidence = qualificationBootEvidence(
          env,
          observedAt,
          request.birth_nonce,
        );
        const attestation = createE2BBirthAttestation({
          request,
          bootEvidence,
          observed_at: observedAt,
        });
        storage.set(E2B_BOOT_EVIDENCE_PATH, `${canonicalize(bootEvidence)}\n`);
        storage.set(paths.attestation, `${canonicalize(attestation)}\n`);
        state.request = request;
        state.bootEvidence = bootEvidence;
        state.attestation = attestation;
      },
      async read(target) {
        if (!storage.has(target)) {
          throw new FileNotFoundError('not found');
        }
        return byteStream(storage.get(target));
      },
    },
  };
}

test('template build gate fails before SDK loading when authority or spend posture is absent', async () => {
  let loads = 0;
  await assert.rejects(
    runE2BTemplateBuild({
      env: contradictory,
      sdkLoader: async () => {
        loads += 1;
        throw new Error('SDK must not load');
      },
    }),
    /NO_SPEND|contradict|disabled/i,
  );
  assert.equal(loads, 0);
  assert.throws(() => assertE2BTemplateBuildGate({}), /disabled|approval|spend/i);
});

test('live qualification gate fails before SDK or provider loading by default', async () => {
  let loads = 0;
  await assert.rejects(
    runE2BLiveQualification({
      env: {},
      sdkLoader: async () => {
        loads += 1;
        throw new Error('SDK must not load');
      },
    }),
    /disabled|approval|spend|canary/i,
  );
  assert.equal(loads, 0);
  assert.throws(
    () => assertE2BLiveQualificationGate(contradictory),
    /NO_SPEND|contradict/i,
  );
});

test('gates require explicit opaque owner refs, exact hashes, synthetic scope, and a bounded cap', () => {
  const base = validEnv();
  const build = assertE2BTemplateBuildGate(base);
  assert.equal(build.maxCostUsd, '0.100000');
  assert.equal(Object.hasOwn(build, 'apiKey'), false);
  const live = assertE2BLiveQualificationGate(base);
  assert.equal(live.syntheticWorkspace, true);
  assert.equal(live.sandboxLimit, 1);
  assert.equal(Object.hasOwn(live, 'apiKey'), false);

  assert.throws(
    () => assertE2BLiveQualificationGate({ ...base, RISK_FORK_E2B_MAX_COST_USD: '1.01' }),
    /cost cap/i,
  );
  assert.throws(
    () => assertE2BLiveQualificationGate({ ...base, RISK_FORK_E2B_SYNTHETIC_WORKSPACE: '0' }),
    /synthetic/i,
  );
});

test('template build attempt intent is durable, sanitized, one-shot, and precedes provider I/O', {
  skip: process.platform === 'win32'
    ? 'Windows evidence writes fail closed until exact DACL validation exists'
    : false,
}, async (t) => {
  const evidenceDirectory = await mkdtemp(path.join(os.tmpdir(), 'risk-fork-e2b-attempt-'));
  const legacyDirectory = await mkdtemp(path.join(os.tmpdir(), 'risk-fork-e2b-legacy-'));
  t.after(() => Promise.all([
    rm(evidenceDirectory, { recursive: true, force: true }),
    rm(legacyDirectory, { recursive: true, force: true }),
  ]));
  const env = validEnv(evidenceDirectory);
  const gate = assertE2BTemplateBuildGate(env);
  const runtime = Object.fromEntries([
    'template_definition_hash',
    'boot_guard_artifact_hash',
    'birth_watcher_artifact_hash',
    'bootstrap_artifact_hash',
    'runner_artifact_hash',
    'runtime_contract_hash',
    'birth_contract_hash',
    'child_operation_hash',
    'canonical_hash',
    'transaction_assurance_canonical_hash',
    'util_hash',
  ].map((field) => [field, sha256Ref(field)]));
  const sdk = {
    package: 'e2b',
    version: '2.39.0',
    integrity_hash: env.RISK_FORK_E2B_SDK_INTEGRITY_HASH,
  };
  const provenanceHash = sha256Ref({ sdk, runtime });
  const core = {
    schema: E2B_TEMPLATE_BUILD_ATTEMPT_SCHEMA,
    status: 'attempt_claimed_provider_outcome_unknown',
    provider_outcome: 'unknown',
    sdk,
    template_alias_hash: sha256Ref(gate.templateAlias),
    template_evidence_hash: provenanceHash,
    provenance_hash: provenanceHash,
    runtime,
    approval_ref_hash: sha256Ref(gate.approvalRef),
    run_ref_hash: sha256Ref(gate.runRef),
    claimed_at: '2030-01-01T00:00:00.000Z',
    requested_cpu_count: 1,
    requested_memory_mb: 512,
    authorized_max_cost_usd: gate.maxCostUsd,
    raw_credentials_included: false,
    wallet_material_included: false,
    execution_authority_included: false,
    production_activation_granted: false,
    attempt_intent_hash: null,
  };
  const intent = Object.freeze({
    ...core,
    attempt_intent_hash: sha256Ref(core),
  });

  const results = await Promise.allSettled([
    persistE2BTemplateBuildAttempt(evidenceDirectory, intent),
    persistE2BTemplateBuildAttempt(evidenceDirectory, intent),
  ]);
  const fulfilled = results.filter(({ status }) => status === 'fulfilled');
  const rejected = results.filter(({ status }) => status === 'rejected');
  assert.equal(fulfilled.length, 1);
  assert.equal(rejected.length, 1);
  assert.equal(rejected[0].reason.code, 'E2B_TEMPLATE_BUILD_APPROVAL_ALREADY_USED');
  const digest = intent.run_ref_hash.slice(7);
  const expectedPath = path.join(
    evidenceDirectory,
    `e2b-template-build-attempt-${digest}.json`,
  );
  assert.equal(fulfilled[0].value, expectedPath);
  const serialized = await readFile(expectedPath, 'utf8');
  assert.equal(serialized, `${canonicalize(intent)}\n`);
  assert.deepEqual(JSON.parse(serialized), intent);
  const approvalPath = path.join(
    evidenceDirectory,
    `e2b-template-build-approval-${intent.approval_ref_hash.slice(7)}.json`,
  );
  assert.equal(await readFile(approvalPath, 'utf8'), serialized);
  for (const raw of [
    env.E2B_API_KEY,
    env.RISK_FORK_E2B_APPROVAL_REF,
    env.RISK_FORK_E2B_RUN_REF,
    env.RISK_FORK_E2B_TEMPLATE_ALIAS,
  ]) assert.equal(serialized.includes(raw), false);
  if (process.platform !== 'win32') {
    assert.equal((await lstat(expectedPath)).mode & 0o7777, 0o400);
    assert.equal((await lstat(approvalPath)).mode & 0o7777, 0o400);
  }

  const secondRunCore = {
    ...core,
    run_ref_hash: sha256Ref('different-run-under-the-same-approval'),
    attempt_intent_hash: null,
  };
  const secondRunIntent = {
    ...secondRunCore,
    attempt_intent_hash: sha256Ref(secondRunCore),
  };
  await assert.rejects(
    persistE2BTemplateBuildAttempt(evidenceDirectory, secondRunIntent),
    (error) => error?.code === 'E2B_TEMPLATE_BUILD_APPROVAL_ALREADY_USED',
  );
  assert.equal(
    (await readdir(evidenceDirectory)).some((name) => (
      name.includes(secondRunIntent.run_ref_hash.slice(7))
    )),
    false,
  );

  const legacyPath = path.join(
    legacyDirectory,
    `e2b-template-build-${digest.slice(0, 24)}.json`,
  );
  await writeFile(legacyPath, '{}\n');
  await assert.rejects(
    persistE2BTemplateBuildAttempt(legacyDirectory, intent),
    (error) => error?.code === 'E2B_TEMPLATE_BUILD_EVIDENCE_ALREADY_RECORDED',
  );
  assert.deepEqual(await readdir(legacyDirectory), [path.basename(legacyPath)]);

  const source = await readFile(
    new URL('../scripts/e2b-build-template.mjs', import.meta.url),
    'utf8',
  );
  const durableClaim = source.indexOf('const attemptIntentPath = await persistE2BTemplateBuildAttempt(');
  const providerCall = source.indexOf('await Template.build(');
  assert.notEqual(durableClaim, -1);
  assert.notEqual(providerCall, -1);
  assert.equal(durableClaim < providerCall, true);
  assert.doesNotMatch(source, /\bunlink\b/);
});

test('live qualification claims approval and run exactly once before provider I/O', {
  skip: process.platform === 'win32'
    ? 'Windows evidence writes fail closed until exact DACL validation exists'
    : false,
}, async (t) => {
  const evidenceDirectory = await mkdtemp(path.join(os.tmpdir(), 'risk-fork-e2b-live-attempt-'));
  t.after(() => rm(evidenceDirectory, { recursive: true, force: true }));
  const env = validEnv(evidenceDirectory);
  const intent = liveAttemptIntent(env);
  const outcomes = await Promise.allSettled([
    persistE2BLiveQualificationAttempt(evidenceDirectory, intent),
    persistE2BLiveQualificationAttempt(evidenceDirectory, intent),
  ]);
  assert.equal(outcomes.filter(({ status }) => status === 'fulfilled').length, 1);
  const rejection = outcomes.find(({ status }) => status === 'rejected');
  assert.equal(rejection.reason.code, 'E2B_LIVE_QUALIFICATION_APPROVAL_ALREADY_USED');
  const serialized = (await Promise.all((await readdir(evidenceDirectory)).map(
    (name) => readFile(path.join(evidenceDirectory, name), 'utf8'),
  ))).join('');
  assert.equal(serialized.includes(env.E2B_API_KEY), false);
  assert.equal(serialized.includes(env.RISK_FORK_E2B_APPROVAL_REF), false);
  assert.equal(serialized.includes(env.RISK_FORK_E2B_RUN_REF), false);

  const source = await readFile(
    new URL('../scripts/e2b-live-qualification.mjs', import.meta.url),
    'utf8',
  );
  const durableClaim = source.indexOf('await persistE2BLiveQualificationAttempt(');
  const sdkLoad = source.indexOf('await loadLiveQualificationSdk(');
  const providerCall = source.indexOf('await runDefaultE2BSingleSandboxCanary(');
  assert.notEqual(durableClaim, -1);
  assert.notEqual(sdkLoad, -1);
  assert.notEqual(providerCall, -1);
  assert.equal(durableClaim < sdkLoad, true);
  assert.equal(sdkLoad < providerCall, true);
  assert.doesNotMatch(source, /\bunlink\b/);
});

test('default provider paths bind the exact inspected SDK tree before SDK or provider I/O', async () => {
  for (const relative of [
    '../scripts/e2b-build-template.mjs',
    '../scripts/e2b-live-qualification.mjs',
  ]) {
    const source = await readFile(new URL(relative, import.meta.url), 'utf8');
    assert.match(source, /createE2BRuntimeSdkIntegrityVerifier/);
    assert.match(source, /loadVerifiedE2BRuntimeSdk/);
    assert.doesNotMatch(source, /async function defaultSdkLoader/);
    assert.doesNotMatch(source, /import\(['"]e2b['"]\)/);
    const runStart = source.indexOf(relative.includes('build-template')
      ? 'export async function runE2BTemplateBuild('
      : 'export async function runE2BLiveQualification(');
    const runSource = source.slice(runStart);
    const verifiedLoad = runSource.indexOf(relative.includes('build-template')
      ? 'await loadTemplateBuildSdk('
      : 'await loadLiveQualificationSdk(');
    const platformGate = runSource.indexOf('assertE2BEvidencePlatformSecurity();');
    const firstProviderOperation = relative.includes('build-template')
      ? runSource.indexOf('await Template.build(')
      : runSource.indexOf('await runDefaultE2BSingleSandboxCanary(');
    assert.notEqual(runStart, -1);
    assert.notEqual(platformGate, -1);
    assert.notEqual(verifiedLoad, -1);
    assert.notEqual(firstProviderOperation, -1);
    assert.equal(platformGate < verifiedLoad, true);
    assert.equal(verifiedLoad < firstProviderOperation, true);
  }
});

test('Windows evidence-producing E2B paths fail closed before claims, SDK, or provider I/O', {
  skip: process.platform !== 'win32' ? 'Windows-specific DACL boundary' : false,
}, async (t) => {
  const evidenceDirectory = await mkdtemp(path.join(os.tmpdir(), 'risk-fork-e2b-win32-closed-'));
  t.after(() => rm(evidenceDirectory, { recursive: true, force: true }));
  const env = validEnv(evidenceDirectory);
  const rejectsForDacl = (operation) => assert.rejects(
    operation,
    (error) => error?.code === E2B_WINDOWS_EVIDENCE_DACL_UNVERIFIED,
  );

  await rejectsForDacl(runE2BTemplateBuild({ env }));
  await rejectsForDacl(runE2BLiveQualification({ env }));
  await rejectsForDacl(persistE2BTemplateBuildAttempt(evidenceDirectory, {}));
  await rejectsForDacl(persistE2BLiveQualificationAttempt(evidenceDirectory, {}));
  assert.deepEqual(await readdir(evidenceDirectory), []);
});

test('the shipped live module does not export its ungated provider runner', async () => {
  const liveModule = await import('../scripts/e2b-live-qualification.mjs');
  assert.equal(Object.hasOwn(liveModule, 'runDefaultE2BSingleSandboxCanary'), false);
});

test('default harnesses fail closed on an unmatched SDK tree and live authority stays consumed', {
  skip: process.platform === 'win32'
    ? 'Windows evidence writes stop before SDK integrity validation'
    : false,
}, async (t) => {
  const evidenceDirectory = await mkdtemp(path.join(os.tmpdir(), 'risk-fork-e2b-sdk-binding-'));
  t.after(() => rm(evidenceDirectory, { recursive: true, force: true }));
  const env = {
    ...validEnv(evidenceDirectory),
    RISK_FORK_E2B_SDK_INTEGRITY_HASH: `sha256:${'0'.repeat(64)}`,
  };

  await assert.rejects(
    runE2BTemplateBuild({ env }),
    /e2b|sdk|integrity|package|module/i,
  );
  await assert.rejects(
    runE2BLiveQualification({ env }),
    /e2b|sdk|integrity|package|module/i,
  );
  const names = await readdir(evidenceDirectory);
  assert.equal(names.length, 2);
  assert.equal(names.some((name) => name.startsWith('e2b-live-qualification-approval-')), true);
  assert.equal(names.some((name) => name.startsWith('e2b-live-qualification-attempt-')), true);
  await assert.rejects(
    runE2BLiveQualification({ env }),
    (error) => error?.code === 'E2B_LIVE_QUALIFICATION_APPROVAL_ALREADY_USED',
  );
  assert.deepEqual(await readdir(evidenceDirectory), names);
});

test('injected harness seams fail before SDK/provider I/O and cannot write evidence', async (t) => {
  const evidenceDirectory = await mkdtemp(path.join(os.tmpdir(), 'risk-fork-e2b-injected-gate-'));
  t.after(() => rm(evidenceDirectory, { recursive: true, force: true }));
  let sdkLoads = 0;
  let providerCalls = 0;
  function Template() { providerCalls += 1; }
  Template.build = async () => {
    providerCalls += 1;
    return { templateId: 'injected-template', buildId: 'injected-build' };
  };
  class Sandbox {
    static async create() { providerCalls += 1; }
    static async getInfo() { providerCalls += 1; }
    static list() { providerCalls += 1; }
    static async kill() { providerCalls += 1; }
  }
  const env = validEnv(evidenceDirectory);

  await assert.rejects(
    runE2BTemplateBuild({
      env,
      sdkLoader: async () => {
        sdkLoads += 1;
        return { Template, waitForFile: () => ({}) };
      },
      sdkVersionLoader: async () => '2.39.0',
    }),
    /Injected.*evidence-producing.*template-build/i,
  );
  await assert.rejects(
    runE2BLiveQualification({
      env,
      sdkLoader: async () => {
        sdkLoads += 1;
        return { Sandbox };
      },
      sdkVersionLoader: async () => '2.39.0',
      canaryRunner: async () => {
        providerCalls += 1;
        return {};
      },
    }),
    /Injected.*evidence-producing.*live-qualification/i,
  );
  assert.equal(sdkLoads, 0);
  assert.equal(providerCalls, 0);
  assert.deepEqual(await readdir(evidenceDirectory), []);
});

test('USD cap is a software admission/evidence gate and is not sent as a provider option', async () => {
  const buildSource = await readFile(
    new URL('../scripts/e2b-build-template.mjs', import.meta.url),
    'utf8',
  );
  const liveSource = await readFile(
    new URL('../scripts/e2b-live-qualification.mjs', import.meta.url),
    'utf8',
  );
  const buildCall = buildSource.slice(
    buildSource.indexOf('await Template.build('),
    buildSource.indexOf('const completedAt', buildSource.indexOf('await Template.build(')),
  );
  const createCall = liveSource.slice(
    liveSource.indexOf('(request) => Sandbox.create('),
    liveSource.indexOf('createdAt =', liveSource.indexOf('(request) => Sandbox.create(')),
  );
  assert.notEqual(liveSource.indexOf('(request) => Sandbox.create('), -1);
  assert.notEqual(liveSource.indexOf('createdAt =', liveSource.indexOf('(request) => Sandbox.create(')), -1);
  assert.match(buildCall, /cpuCount:\s*1/);
  assert.match(buildCall, /memoryMB:\s*512/);
  assert.doesNotMatch(buildCall, /cost|usd|spend/i);
  assert.doesNotMatch(createCall, /cost|usd|spend/i);
  assert.match(buildSource, /observed_cost_usd:\s*null/);
  assert.match(buildSource, /cost_within_cap:\s*'unknown'/);
  assert.match(liveSource, /observed_cost_usd:\s*null/);
  assert.match(liveSource, /external_observation_receipt:\s*null/);
  assert.doesNotMatch(liveSource, /timer\.unref/);
});

let instrumentedLiveQualificationPromise;

async function loadInstrumentedLiveQualification() {
  if (!instrumentedLiveQualificationPromise) {
    instrumentedLiveQualificationPromise = (async () => {
      const scriptUrl = new URL('../scripts/e2b-live-qualification.mjs', import.meta.url);
      const source = await readFile(scriptUrl, 'utf8');
      const instrumented = source
        .replace(
          'async function runDefaultE2BSingleSandboxCanary(',
          'export async function runDefaultE2BSingleSandboxCanary(',
        )
        .replace(/from '(\.{1,2}\/[^']+)'/g, (_match, relative) => (
          `from '${new URL(relative, scriptUrl).href}'`
        ));
      if (instrumented === source
        || !instrumented.includes('export async function runDefaultE2BSingleSandboxCanary(')) {
        throw new Error('Unable to instrument the private live qualification canary');
      }
      return import(`data:text/javascript;base64,${Buffer.from(instrumented).toString('base64')}`);
    })();
  }
  return instrumentedLiveQualificationPromise;
}

async function runDefaultE2BSingleSandboxCanary(options) {
  const instrumented = await loadInstrumentedLiveQualification();
  return instrumented.runDefaultE2BSingleSandboxCanary({
    SandboxNotFoundError,
    ...options,
  });
}

test('default live harness attempts exactly one sandbox and never treats boot-local egress or missing cost as qualified', async (t) => {
  const evidenceDirectory = await mkdtemp(path.join(os.tmpdir(), 'risk-fork-e2b-live-default-'));
  t.after(() => rm(evidenceDirectory, { recursive: true, force: true }));
  const env = validEnv(evidenceDirectory);
  const birthRuntime = createBirthHandshakeFiles(env);
  const pinnedFileAbsence = new FileNotFoundError('not found');
  assert.equal(pinnedFileAbsence.name, 'FileNotFoundError');
  assert.equal(pinnedFileAbsence.code, undefined);
  assert.equal(pinnedFileAbsence.status, undefined);
  let creates = 0;
  let killed = false;
  let postKillGetInfoCalls = 0;
  let listCalls = 0;
  let listPageRequests = 0;
  let metadata;
  let createOptions;
  let endAt = '2030-01-01T00:01:10.000Z';
  const freshness = freshnessClock();
  const child = {
    sandboxId: 'sandbox-default-live-canary',
    files: birthRuntime.files,
    async setTimeout(timeoutMs) {
      endAt = new Date(Date.parse('2030-01-01T00:00:10.000Z') + timeoutMs).toISOString();
    },
    async kill() { killed = true; return true; },
  };
  class Sandbox {
    static async create(_templateId, options) {
      creates += 1;
      metadata = options.metadata;
      createOptions = options;
      return child;
    }
    static async getInfo() {
      if (killed) {
        postKillGetInfoCalls += 1;
        throw new SandboxNotFoundError('not found');
      }
      return qualificationSandboxInfo(env, child.sandboxId, metadata, endAt);
    }
    static list() {
      listCalls += 1;
      let delivered = false;
      return {
        get hasNext() { return !delivered; },
        async nextItems(request) {
          assert.equal(request.signal instanceof AbortSignal, true);
          assert.equal(request.requestTimeoutMs, 10_000);
          listPageRequests += 1;
          delivered = true;
          return killed ? [] : [{ ...await Sandbox.getInfo(), metadata }];
        },
      };
    }
    static async kill() { killed = true; }
  }
  const canary = await runDefaultE2BSingleSandboxCanary({
    Sandbox,
    gate: assertE2BLiveQualificationGate(env),
    clock: () => new Date('2030-01-01T00:00:10.000Z'),
    ...freshness,
  });
  assert.equal(creates, 1);
  assert.equal(killed, true);
  assert.equal(postKillGetInfoCalls, 3);
  assert.equal(listCalls, 7);
  assert.equal(listPageRequests, 7);
  assert.ok(birthRuntime.state.request);
  assert.ok(birthRuntime.state.attestation);
  assert.ok(birthRuntime.state.bootEvidence);
  assert.deepEqual(createOptions.envs, {});
  assert.deepEqual(createOptions.iam, { tokens: {} });
  assert.deepEqual(createOptions.volumeMounts, {});
  assert.deepEqual(createOptions.lifecycle, { onTimeout: 'kill', autoResume: false });
  assert.deepEqual(createOptions.network, {
    allowOut: [],
    denyOut: ['0.0.0.0/0'],
    allowPublicTraffic: false,
  });
  assert.equal(canary.controls.inherited_environment_absent, 'verified');
  assert.equal(canary.controls.first_instruction_ipv4_egress_denied, 'unknown');
  assert.equal(canary.controls.first_instruction_ipv6_egress_denied, 'unknown');
  assert.equal(canary.controls.cost_within_cap, 'unknown');
  assert.equal(canary.observations.observed_cost_usd, null);
  assert.equal(canary.observations.failure_stage, 'none');
  assert.equal(canary.observations.failure_class, 'none');
  assert.equal(canary.cleanup.absence_verified, 'verified');
  assert.equal(canary.cleanup.orphan_reconciliation, 'verified');
  assert.ok(canary.evidenceRefs.some(
    ({ ref }) => ref === 'evidence:e2b-controller-lifecycle-observations',
  ));
  assert.ok(canary.evidenceRefs.some(
    ({ ref }) => ref === 'evidence:e2b-provider-kill-acknowledgement',
  ));
  assert.ok(canary.evidenceRefs.some(
    ({ ref }) => ref === 'evidence:e2b-fresh-terminal-absence-observations',
  ));
  const refs = Object.fromEntries(canary.evidenceRefs.map(({ ref, hash }) => [ref, hash]));
  assert.equal(
    refs[E2B_EXTERNAL_QUALIFICATION_EVIDENCE_REFS.sandbox_id_hash],
    sha256Ref(child.sandboxId),
  );
  assert.equal(
    refs[E2B_EXTERNAL_QUALIFICATION_EVIDENCE_REFS.metadata_hash],
    sha256Ref(metadata),
  );
  assert.equal(
    refs[E2B_EXTERNAL_QUALIFICATION_EVIDENCE_REFS.provider_template_binding_hash],
    sha256Ref({
      sandbox_id_hash: sha256Ref(child.sandboxId),
      metadata_hash: sha256Ref(metadata),
      template_id_hash: sha256Ref(env.RISK_FORK_E2B_TEMPLATE_ID),
      template_build_id_hash: env.RISK_FORK_E2B_TEMPLATE_BUILD_ID_HASH,
      template_evidence_hash: env.RISK_FORK_E2B_TEMPLATE_EVIDENCE_HASH,
      template_provenance_hash: env.RISK_FORK_E2B_TEMPLATE_PROVENANCE_HASH,
      sdk_integrity_hash: env.RISK_FORK_E2B_SDK_INTEGRITY_HASH,
    }),
  );
  assert.equal(
    refs[E2B_EXTERNAL_QUALIFICATION_EVIDENCE_REFS.boot_evidence_hash],
    birthRuntime.state.bootEvidence.evidence_hash,
  );
  assert.equal(
    refs[E2B_EXTERNAL_QUALIFICATION_EVIDENCE_REFS.ipv4_probe_hash],
    birthRuntime.state.bootEvidence.observation_hashes.ipv4_probe_hash,
  );
  assert.equal(
    refs[E2B_EXTERNAL_QUALIFICATION_EVIDENCE_REFS.ipv6_probe_hash],
    birthRuntime.state.bootEvidence.observation_hashes.ipv6_probe_hash,
  );
  assert.equal(
    refs[E2B_EXTERNAL_QUALIFICATION_EVIDENCE_REFS.birth_request_hash],
    birthRuntime.state.request.request_hash,
  );
  assert.equal(
    refs[E2B_EXTERNAL_QUALIFICATION_EVIDENCE_REFS.birth_attestation_hash],
    birthRuntime.state.attestation.attestation_hash,
  );
  assert.equal(
    refs[E2B_EXTERNAL_QUALIFICATION_EVIDENCE_REFS.sandbox_birth_binding_hash],
    sha256Ref({
      sandbox_id_hash: sha256Ref(child.sandboxId),
      metadata_hash: sha256Ref(metadata),
      template_id_hash: sha256Ref(env.RISK_FORK_E2B_TEMPLATE_ID),
      template_evidence_hash: env.RISK_FORK_E2B_TEMPLATE_EVIDENCE_HASH,
      template_provenance_hash: env.RISK_FORK_E2B_TEMPLATE_PROVENANCE_HASH,
      birth_request_hash: birthRuntime.state.request.request_hash,
      birth_attestation_hash: birthRuntime.state.attestation.attestation_hash,
      boot_evidence_hash: birthRuntime.state.bootEvidence.evidence_hash,
      boot_observed_at: birthRuntime.state.bootEvidence.observed_at,
      allocation_started_at: '2030-01-01T00:00:10.000Z',
    }),
  );
});

test('live diagnostics distinguish initial provider absence, transport failure, and contract contradiction without raw errors', async (t) => {
  const scenarios = [{
    name: 'typed provider absence',
    mode: 'absence',
    failureStage: 'initial_provider_info_fetch',
    failureClass: 'provider_absence',
  }, {
    name: 'generic provider transport failure',
    mode: 'transport',
    failureStage: 'initial_provider_info_fetch',
    failureClass: 'provider_call_failure',
  }, {
    name: 'provider info contract contradiction',
    mode: 'contradiction',
    failureStage: 'initial_provider_info_validation',
    failureClass: 'provider_contract_contradiction',
  }];

  for (const scenario of scenarios) {
    await t.test(scenario.name, async () => {
      const env = validEnv();
      const sensitiveDetail = 'api_key=top-secret-provider-detail';
      let killed = false;
      let metadata;
      const child = {
        sandboxId: `sandbox-initial-diagnostic-${scenario.mode}`,
        files: {
          async read() { return ''; },
          async write() {},
        },
        async setTimeout() {},
        async kill() { killed = true; return true; },
      };
      class Sandbox {
        static async create(_templateId, options) {
          metadata = options.metadata;
          return child;
        }
        static async getInfo() {
          if (killed) throw new SandboxNotFoundError('cleanup absence');
          if (scenario.mode === 'absence') {
            throw new SandboxNotFoundError(sensitiveDetail);
          }
          if (scenario.mode === 'transport') {
            const error = new Error(sensitiveDetail);
            error.code = 'SENSITIVE_PROVIDER_CODE';
            throw error;
          }
          return {
            ...qualificationSandboxInfo(env, child.sandboxId, metadata),
            allowInternetAccess: true,
          };
        }
        static list() {
          let delivered = false;
          return {
            get hasNext() { return !delivered; },
            async nextItems() { delivered = true; return []; },
          };
        }
      }

      const canary = await runDefaultE2BSingleSandboxCanary({
        Sandbox,
        gate: assertE2BLiveQualificationGate(env),
        clock: () => new Date('2030-01-01T00:00:10.000Z'),
        ...freshnessClock(),
      });
      assert.equal(canary.observations.failure_stage, scenario.failureStage);
      assert.equal(canary.observations.failure_class, scenario.failureClass);
      assert.equal(E2B_QUALIFICATION_FAILURE_STAGES.includes(scenario.failureStage), true);
      assert.equal(E2B_QUALIFICATION_FAILURE_CLASSES.includes(scenario.failureClass), true);
      assert.equal(canary.cleanup.absence_verified, 'verified');
      assert.doesNotMatch(
        canonicalize(canary),
        /api_key|top-secret-provider-detail|SENSITIVE_PROVIDER_CODE/,
      );
    });
  }
});

test('live cleanup requires three freshness-spaced not-found and exact-bound empty observations', async (t) => {
  const cases = [{
    name: 'sandbox reappears after a transient not-found',
    mode: 'reappears',
    expectedAbsence: 'failed',
    expectedOrphans: 'failed',
    expectedGetInfoCalls: 2,
    expectedListCalls: 5,
  }, {
    name: 'listing returns a mismatched sandbox',
    mode: 'mismatched-listing',
    expectedAbsence: 'unknown',
    expectedOrphans: 'unknown',
    expectedGetInfoCalls: 1,
    expectedListCalls: 3,
  }, {
    name: 'filesystem-shaped ENOENT is not provider absence',
    mode: 'enoent',
    expectedAbsence: 'unknown',
    expectedOrphans: 'unknown',
    expectedGetInfoCalls: 1,
    expectedListCalls: 4,
  }, {
    name: 'untyped HTTP 404 is not provider absence',
    mode: 'raw-404',
    expectedAbsence: 'unknown',
    expectedOrphans: 'unknown',
    expectedGetInfoCalls: 1,
    expectedListCalls: 4,
  }];

  for (const scenario of cases) {
    await t.test(scenario.name, async (st) => {
      const evidenceDirectory = await mkdtemp(
        path.join(os.tmpdir(), 'risk-fork-e2b-stable-cleanup-'),
      );
      st.after(() => rm(evidenceDirectory, { recursive: true, force: true }));
      const env = validEnv(evidenceDirectory);
      const birthRuntime = createBirthHandshakeFiles(env);
      let killed = false;
      let metadata;
      let postKillGetInfoCalls = 0;
      let listCalls = 0;
      const freshness = freshnessClock();
      const child = {
        sandboxId: `sandbox-cleanup-${scenario.mode}`,
        files: birthRuntime.files,
        async setTimeout() {},
        async kill() { killed = true; return true; },
      };
      class Sandbox {
        static async create(_templateId, options) {
          metadata = options.metadata;
          return child;
        }
        static async getInfo() {
          if (!killed) return qualificationSandboxInfo(env, child.sandboxId, metadata);
          postKillGetInfoCalls += 1;
          if (scenario.mode === 'reappears' && postKillGetInfoCalls === 2) {
            return qualificationSandboxInfo(env, child.sandboxId, metadata);
          }
          if (scenario.mode === 'enoent') {
            const error = new Error('not found');
            error.code = 'ENOENT';
            throw error;
          }
          if (scenario.mode === 'raw-404') {
            const error = new Error('untyped response');
            error.status = 404;
            throw error;
          }
          throw new SandboxNotFoundError('not found');
        }
        static list() {
          listCalls += 1;
          let delivered = false;
          return {
            get hasNext() { return !delivered; },
            async nextItems() {
              delivered = true;
              if (scenario.mode !== 'mismatched-listing') return [];
              return [{
                sandboxId: child.sandboxId,
                templateId: 'different-template',
                metadata: { ...metadata, substituted: 'unbound' },
              }];
            },
          };
        }
      }

      const canary = await runDefaultE2BSingleSandboxCanary({
        Sandbox,
        gate: assertE2BLiveQualificationGate(env),
        clock: () => new Date('2030-01-01T00:00:10.000Z'),
        ...freshness,
      });
      assert.equal(canary.cleanup.kill_requested, 'verified');
      assert.equal(canary.cleanup.absence_verified, scenario.expectedAbsence);
      assert.equal(canary.cleanup.orphan_reconciliation, scenario.expectedOrphans);
      assert.equal(canary.controls.destruction_semantics_verified, 'unknown');
      assert.equal(postKillGetInfoCalls, scenario.expectedGetInfoCalls);
      assert.equal(listCalls, scenario.expectedListCalls);
    });
  }
});

test('ambiguous create with no bound sandbox never upgrades an empty list to reconciliation', async (t) => {
  const evidenceDirectory = await mkdtemp(path.join(os.tmpdir(), 'risk-fork-e2b-ambiguous-'));
  t.after(() => rm(evidenceDirectory, { recursive: true, force: true }));
  const env = validEnv(evidenceDirectory);
  let listCalls = 0;
  class Sandbox {
    static async create() {
      const error = new Error('provider response lost after request');
      error.code = 'ETIMEDOUT';
      throw error;
    }
    static list() {
      listCalls += 1;
      let delivered = false;
      return {
        get hasNext() { return !delivered; },
        async nextItems() { delivered = true; return []; },
      };
    }
  }
  const canary = await runDefaultE2BSingleSandboxCanary({
    Sandbox,
    gate: assertE2BLiveQualificationGate(env),
    clock: () => new Date('2030-01-01T00:00:10.000Z'),
    ...freshnessClock(),
  });
  assert.equal(canary.sandboxCount, 0);
  assert.equal(canary.cleanup.kill_requested, 'unknown');
  assert.equal(canary.cleanup.absence_verified, 'unknown');
  assert.equal(canary.cleanup.orphan_reconciliation, 'unknown');
  assert.equal(canary.controls.orphan_reconciliation_verified, 'unknown');
  assert.equal(canary.observations.failure_stage, 'sandbox_create');
  assert.equal(canary.observations.failure_class, 'provider_call_failure');
  assert.equal(listCalls, 4);
});

test('cleanup kills every duplicate exact-bound sandbox before rejecting the run', async (t) => {
  const evidenceDirectory = await mkdtemp(path.join(os.tmpdir(), 'risk-fork-e2b-duplicates-'));
  t.after(() => rm(evidenceDirectory, { recursive: true, force: true }));
  const env = validEnv(evidenceDirectory);
  const ids = ['sandbox-duplicate-a', 'sandbox-duplicate-b'];
  const killed = [];
  let metadata;
  let listCalls = 0;
  class Sandbox {
    static async create(_templateId, options) {
      metadata = options.metadata;
      const error = new Error('provider response lost after duplicate allocation');
      error.code = 'ETIMEDOUT';
      throw error;
    }
    static async kill(id) { killed.push(id); return true; }
    static async getInfo(id) {
      if (killed.includes(id)) throw new SandboxNotFoundError('not found');
      return qualificationSandboxInfo(env, id, metadata);
    }
    static list() {
      listCalls += 1;
      const items = listCalls === 1
        ? ids.map((sandboxIdValue) => ({
          sandboxId: sandboxIdValue,
          templateId: env.RISK_FORK_E2B_TEMPLATE_ID,
          metadata,
        }))
        : [];
      let delivered = false;
      return {
        get hasNext() { return !delivered; },
        async nextItems() { delivered = true; return items; },
      };
    }
  }
  await assert.rejects(
    runDefaultE2BSingleSandboxCanary({
      Sandbox,
      gate: assertE2BLiveQualificationGate(env),
      clock: () => new Date('2030-01-01T00:00:10.000Z'),
      ...freshnessClock(),
    }),
    (error) => error?.code === 'E2B_QUALIFICATION_SANDBOX_LIMIT_EXCEEDED',
  );
  assert.deepEqual(killed.sort(), ids);
  assert.equal(new Set(killed).size, 2);
});

test('cleanup recovers and kills an exact ID from a truthy id-less create handle', async (t) => {
  const evidenceDirectory = await mkdtemp(path.join(os.tmpdir(), 'risk-fork-e2b-idless-'));
  t.after(() => rm(evidenceDirectory, { recursive: true, force: true }));
  const env = validEnv(evidenceDirectory);
  const recoveredId = 'sandbox-recovered-from-idless-handle';
  let killed = false;
  let metadata;
  let staticKillCalls = 0;
  class Sandbox {
    static async create(_templateId, options) {
      metadata = options.metadata;
      return { files: {}, async setTimeout() {} };
    }
    static async kill(id) {
      assert.equal(id, recoveredId);
      staticKillCalls += 1;
      killed = true;
      return true;
    }
    static async getInfo() {
      if (killed) throw new SandboxNotFoundError('not found');
      return qualificationSandboxInfo(env, recoveredId, metadata);
    }
    static list() {
      let delivered = false;
      return {
        get hasNext() { return !delivered; },
        async nextItems() {
          delivered = true;
          return killed ? [] : [{
            sandboxId: recoveredId,
            templateId: env.RISK_FORK_E2B_TEMPLATE_ID,
            metadata,
          }];
        },
      };
    }
  }
  const canary = await runDefaultE2BSingleSandboxCanary({
    Sandbox,
    gate: assertE2BLiveQualificationGate(env),
    clock: () => new Date('2030-01-01T00:00:10.000Z'),
    ...freshnessClock(),
  });
  assert.equal(staticKillCalls, 1);
  assert.equal(canary.sandboxCount, 1);
  assert.equal(canary.cleanup.kill_requested, 'verified');
  assert.equal(canary.cleanup.absence_verified, 'verified');
});

test('cleanup kills a second exact-bound sandbox discovered after the primary kill', async (t) => {
  const evidenceDirectory = await mkdtemp(path.join(os.tmpdir(), 'risk-fork-e2b-late-duplicate-'));
  t.after(() => rm(evidenceDirectory, { recursive: true, force: true }));
  const env = validEnv(evidenceDirectory);
  const primaryId = 'sandbox-primary-cleanup';
  const lateId = 'sandbox-late-cleanup';
  const killed = [];
  let metadata;
  let listCalls = 0;
  const child = { sandboxId: primaryId, files: {}, async setTimeout() {} };
  class Sandbox {
    static async create(_templateId, options) { metadata = options.metadata; return child; }
    static async kill(id) { killed.push(id); return true; }
    static async getInfo(id) {
      if (killed.includes(id)) throw new SandboxNotFoundError('not found');
      return qualificationSandboxInfo(env, id, metadata);
    }
    static list() {
      listCalls += 1;
      const visibleIds = listCalls === 1 ? [primaryId] : listCalls === 2 ? [lateId] : [];
      let delivered = false;
      return {
        get hasNext() { return !delivered; },
        async nextItems() {
          delivered = true;
          return visibleIds.map((sandboxIdValue) => ({
            sandboxId: sandboxIdValue,
            templateId: env.RISK_FORK_E2B_TEMPLATE_ID,
            metadata,
          }));
        },
      };
    }
  }
  await assert.rejects(
    runDefaultE2BSingleSandboxCanary({
      Sandbox,
      gate: assertE2BLiveQualificationGate(env),
      clock: () => new Date('2030-01-01T00:00:10.000Z'),
      ...freshnessClock(),
    }),
    (error) => error?.code === 'E2B_QUALIFICATION_SANDBOX_LIMIT_EXCEEDED',
  );
  assert.deepEqual(killed, [primaryId, lateId]);
  assert.equal(new Set(killed).size, 2);
});

test('controller timeout aborts a hung provider create and leaves allocation terminal-unknown', async (t) => {
  const evidenceDirectory = await mkdtemp(path.join(os.tmpdir(), 'risk-fork-e2b-provider-timeout-'));
  t.after(() => rm(evidenceDirectory, { recursive: true, force: true }));
  const env = {
    ...validEnv(evidenceDirectory),
    RISK_FORK_E2B_HARD_TTL_MS: '1000',
    RISK_FORK_E2B_IDLE_TTL_MS: '1000',
    RISK_FORK_E2B_MAX_EXECUTION_MS: '100',
  };
  let createAborted = false;
  class Sandbox {
    static async create(_templateId, options) {
      return new Promise((resolve, reject) => {
        options.signal.addEventListener('abort', () => {
          createAborted = true;
          reject(options.signal.reason);
        }, { once: true });
      });
    }
    static list() {
      let delivered = false;
      return {
        get hasNext() { return !delivered; },
        async nextItems() { delivered = true; return []; },
      };
    }
  }
  const started = performance.now();
  const canary = await runDefaultE2BSingleSandboxCanary({
    Sandbox,
    gate: assertE2BLiveQualificationGate(env),
    clock: () => new Date('2030-01-01T00:00:10.000Z'),
    ...freshnessClock(),
  });
  assert.equal(performance.now() - started < 2_500, true);
  assert.equal(createAborted, true);
  assert.equal(canary.sandboxCount, 0);
  assert.equal(canary.cleanup.orphan_reconciliation, 'unknown');
  assert.equal(canary.observations.failure_stage, 'sandbox_create');
  assert.equal(canary.observations.failure_class, 'provider_timeout');
});

test('controller deadline reaches cleanup when a birth-handshake write never settles', async (t) => {
  const evidenceDirectory = await mkdtemp(path.join(os.tmpdir(), 'risk-fork-e2b-birth-timeout-'));
  t.after(() => rm(evidenceDirectory, { recursive: true, force: true }));
  const env = {
    ...validEnv(evidenceDirectory),
    RISK_FORK_E2B_HARD_TTL_MS: '1000',
    RISK_FORK_E2B_IDLE_TTL_MS: '1000',
    RISK_FORK_E2B_MAX_EXECUTION_MS: '100',
  };
  let killed = false;
  let metadata;
  let writes = 0;
  const child = {
    sandboxId: 'sandbox-birth-write-timeout',
    files: {
      async read() { throw new FileNotFoundError('not found'); },
      async write() {
        writes += 1;
        return new Promise(() => {});
      },
    },
    async setTimeout() {},
    async kill() { killed = true; return true; },
  };
  class Sandbox {
    static async create(_templateId, options) { metadata = options.metadata; return child; }
    static async getInfo() {
      if (killed) throw new SandboxNotFoundError('not found');
      return qualificationSandboxInfo(
        env,
        child.sandboxId,
        metadata,
        '2030-01-01T00:00:11.000Z',
      );
    }
    static list() {
      let delivered = false;
      return {
        get hasNext() { return !delivered; },
        async nextItems() { delivered = true; return []; },
      };
    }
  }
  const started = performance.now();
  const canary = await runDefaultE2BSingleSandboxCanary({
    Sandbox,
    gate: assertE2BLiveQualificationGate(env),
    clock: () => new Date('2030-01-01T00:00:10.000Z'),
    ...freshnessClock(),
  });
  assert.equal(performance.now() - started < 2_500, true);
  assert.equal(writes, 1);
  assert.equal(killed, true);
  assert.equal(canary.cleanup.kill_requested, 'verified');
  assert.equal(canary.cleanup.absence_verified, 'verified');
  assert.equal(canary.observations.failure_stage, 'birth_handshake');
  assert.equal(canary.observations.failure_class, 'provider_timeout');
});

test('provider kill acknowledgement must be explicit before destruction can verify', async (t) => {
  const evidenceDirectory = await mkdtemp(path.join(os.tmpdir(), 'risk-fork-e2b-kill-ack-'));
  t.after(() => rm(evidenceDirectory, { recursive: true, force: true }));
  const env = validEnv(evidenceDirectory);
  const birthRuntime = createBirthHandshakeFiles(env);
  let killed = false;
  let metadata;
  const child = {
    sandboxId: 'sandbox-kill-ack-unknown',
    files: birthRuntime.files,
    async setTimeout() {},
    async kill() { killed = true; return false; },
  };
  class Sandbox {
    static async create(_templateId, options) { metadata = options.metadata; return child; }
    static async getInfo() {
      if (!killed) return qualificationSandboxInfo(env, child.sandboxId, metadata);
      throw new SandboxNotFoundError('not found');
    }
    static list() {
      let delivered = false;
      return {
        get hasNext() { return !delivered; },
        async nextItems() { delivered = true; return []; },
      };
    }
  }
  const canary = await runDefaultE2BSingleSandboxCanary({
    Sandbox,
    gate: assertE2BLiveQualificationGate(env),
    clock: () => new Date('2030-01-01T00:00:10.000Z'),
    ...freshnessClock(),
  });
  assert.equal(canary.cleanup.kill_requested, 'unknown');
  assert.equal(canary.cleanup.absence_verified, 'verified');
  assert.equal(canary.controls.destruction_semantics_verified, 'unknown');
  assert.equal(canary.evidenceRefs.some(
    ({ ref }) => ref === 'evidence:e2b-provider-kill-acknowledgement',
  ), false);
});

test('static provider kill reconciles a created sandbox missing the instance kill API', async (t) => {
  const evidenceDirectory = await mkdtemp(path.join(os.tmpdir(), 'risk-fork-e2b-static-kill-'));
  t.after(() => rm(evidenceDirectory, { recursive: true, force: true }));
  const env = validEnv(evidenceDirectory);
  let killed = false;
  let staticKillCalls = 0;
  let metadata;
  const child = {
    sandboxId: 'sandbox-static-kill-fallback',
    files: {},
    async setTimeout() {},
  };
  class Sandbox {
    static async create(_templateId, options) { metadata = options.metadata; return child; }
    static async kill(id) {
      assert.equal(id, child.sandboxId);
      staticKillCalls += 1;
      killed = true;
      return true;
    }
    static async getInfo() {
      if (!killed) return qualificationSandboxInfo(env, child.sandboxId, metadata);
      throw new SandboxNotFoundError('not found');
    }
    static list() {
      let delivered = false;
      return {
        get hasNext() { return !delivered; },
        async nextItems() { delivered = true; return []; },
      };
    }
  }
  const canary = await runDefaultE2BSingleSandboxCanary({
    Sandbox,
    gate: assertE2BLiveQualificationGate(env),
    clock: () => new Date('2030-01-01T00:00:10.000Z'),
    ...freshnessClock(),
  });
  assert.equal(staticKillCalls, 1);
  assert.equal(canary.cleanup.kill_requested, 'verified');
  assert.equal(canary.cleanup.absence_verified, 'verified');
  assert.equal(canary.controls.destruction_semantics_verified, 'verified');
});

test('default live harness rejects template-build boot evidence during the birth handshake', async (t) => {
  const evidenceDirectory = await mkdtemp(path.join(os.tmpdir(), 'risk-fork-e2b-stale-boot-'));
  t.after(() => rm(evidenceDirectory, { recursive: true, force: true }));
  const env = validEnv(evidenceDirectory);
  const birthRuntime = createBirthHandshakeFiles(env, '2030-01-01T00:00:00.000Z');
  const freshness = freshnessClock();
  let killed = false;
  let metadata;
  const child = {
    sandboxId: 'sandbox-with-captured-build-evidence',
    files: birthRuntime.files,
    async setTimeout() {},
    async kill() { killed = true; return true; },
  };
  class Sandbox {
    static async create(_templateId, options) {
      metadata = options.metadata;
      return child;
    }
    static async getInfo() {
      if (killed) {
        throw new SandboxNotFoundError('not found');
      }
      return qualificationSandboxInfo(env, child.sandboxId, metadata);
    }
    static list() {
      let delivered = false;
      return {
        get hasNext() { return !delivered; },
        async nextItems() {
          delivered = true;
          return killed ? [] : [{ ...await Sandbox.getInfo(), metadata }];
        },
      };
    }
  }

  const canary = await runDefaultE2BSingleSandboxCanary({
    Sandbox,
    gate: assertE2BLiveQualificationGate(env),
    clock: () => new Date('2030-01-01T00:00:10.000Z'),
    ...freshness,
  });
  const refs = new Map(canary.evidenceRefs.map(({ ref, hash }) => [ref, hash]));
  assert.equal(canary.controls.inherited_environment_absent, 'unknown');
  assert.equal(canary.controls.template_provenance_verified, 'unknown');
  assert.equal(canary.controls.bootstrap_binding_verified, 'unknown');
  assert.equal(canary.controls.runner_binding_verified, 'unknown');
  assert.equal(
    refs.has(E2B_EXTERNAL_QUALIFICATION_EVIDENCE_REFS.provider_template_binding_hash),
    true,
  );
  assert.equal(
    refs.has(E2B_EXTERNAL_QUALIFICATION_EVIDENCE_REFS.birth_request_hash),
    false,
  );
  assert.equal(
    refs.has(E2B_EXTERNAL_QUALIFICATION_EVIDENCE_REFS.birth_attestation_hash),
    false,
  );
  assert.equal(
    refs.has(E2B_EXTERNAL_QUALIFICATION_EVIDENCE_REFS.boot_evidence_hash),
    false,
  );
  assert.equal(
    refs.has(E2B_EXTERNAL_QUALIFICATION_EVIDENCE_REFS.sandbox_birth_binding_hash),
    false,
  );
  assert.equal(canary.cleanup.absence_verified, 'verified');
  assert.equal(canary.cleanup.orphan_reconciliation, 'verified');
});
