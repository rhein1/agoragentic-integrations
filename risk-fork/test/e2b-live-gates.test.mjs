import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { FileNotFoundError } from 'e2b';

import {
  assertE2BTemplateBuildGate,
  runE2BTemplateBuild,
} from '../scripts/e2b-build-template.mjs';
import {
  assertE2BLiveQualificationGate,
  runE2BLiveQualification,
} from '../scripts/e2b-live-qualification.mjs';
import {
  E2B_BOOT_EVIDENCE_PATH,
  createBootEvidenceEnvelope,
  createE2BBirthAttestation,
  e2bBirthRequestPaths,
} from '../e2b-template/lib/runtime-contract.mjs';
import { canonicalize, sha256Ref } from '../src/canonical.mjs';
import { E2B_EXTERNAL_QUALIFICATION_EVIDENCE_REFS } from '../src/e2b-qualification.mjs';

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

function qualificationSandboxInfo(env, sandboxId, metadata) {
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
    endAt: '2030-01-01T00:01:10.000Z',
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
    const verifiedLoad = source.indexOf('await loadVerifiedE2BRuntimeSdk(');
    const firstProviderOperation = relative.includes('build-template')
      ? source.indexOf('await Template.build(')
      : source.indexOf('await runDefaultE2BSingleSandboxCanary(');
    assert.notEqual(verifiedLoad, -1);
    assert.notEqual(firstProviderOperation, -1);
    assert.equal(verifiedLoad < firstProviderOperation, true);
  }
});

test('the shipped live module does not export its ungated provider runner', async () => {
  const liveModule = await import('../scripts/e2b-live-qualification.mjs');
  assert.equal(Object.hasOwn(liveModule, 'runDefaultE2BSingleSandboxCanary'), false);
});

test('default harnesses fail closed on an unmatched SDK tree without writing evidence', async (t) => {
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
  assert.deepEqual(await readdir(evidenceDirectory), []);
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
    liveSource.indexOf('sandbox = await Sandbox.create('),
    liveSource.indexOf('createdAt =', liveSource.indexOf('sandbox = await Sandbox.create(')),
  );
  assert.match(buildCall, /cpuCount:\s*1/);
  assert.match(buildCall, /memoryMB:\s*512/);
  assert.doesNotMatch(buildCall, /cost|usd|spend/i);
  assert.doesNotMatch(createCall, /cost|usd|spend/i);
  assert.match(buildSource, /observed_cost_usd:\s*null/);
  assert.match(buildSource, /cost_within_cap:\s*'unknown'/);
  assert.match(liveSource, /observed_cost_usd:\s*null/);
  assert.match(liveSource, /external_observation_receipt:\s*null/);
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
  return instrumented.runDefaultE2BSingleSandboxCanary(options);
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
  let metadata;
  let createOptions;
  const child = {
    sandboxId: 'sandbox-default-live-canary',
    files: birthRuntime.files,
    async setTimeout() {},
    async kill() { killed = true; },
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
        const error = new Error('not found');
        error.status = 404;
        throw error;
      }
      return qualificationSandboxInfo(env, child.sandboxId, metadata);
    }
    static list() {
      listCalls += 1;
      let delivered = false;
      return {
        get hasNext() { return !delivered; },
        async nextItems() {
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
  });
  assert.equal(creates, 1);
  assert.equal(killed, true);
  assert.equal(postKillGetInfoCalls, 2);
  assert.equal(listCalls, 1);
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
  assert.equal(canary.cleanup.absence_verified, 'verified');
  assert.equal(canary.cleanup.orphan_reconciliation, 'verified');
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

test('live cleanup requires two provider not-found observations and an exact-bound empty list', async (t) => {
  const cases = [{
    name: 'sandbox reappears after a transient not-found',
    mode: 'reappears',
    expectedAbsence: 'failed',
    expectedOrphans: 'failed',
    expectedGetInfoCalls: 2,
    expectedListCalls: 1,
  }, {
    name: 'listing returns a mismatched sandbox',
    mode: 'mismatched-listing',
    expectedAbsence: 'unknown',
    expectedOrphans: 'unknown',
    expectedGetInfoCalls: 1,
    expectedListCalls: 1,
  }, {
    name: 'filesystem-shaped ENOENT is not provider absence',
    mode: 'enoent',
    expectedAbsence: 'unknown',
    expectedOrphans: 'unknown',
    expectedGetInfoCalls: 1,
    expectedListCalls: 0,
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
      const child = {
        sandboxId: `sandbox-cleanup-${scenario.mode}`,
        files: birthRuntime.files,
        async setTimeout() {},
        async kill() { killed = true; },
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
          const error = new Error('not found');
          if (scenario.mode === 'enoent') error.code = 'ENOENT';
          else error.status = 404;
          throw error;
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

test('default live harness rejects template-build boot evidence during the birth handshake', async (t) => {
  const evidenceDirectory = await mkdtemp(path.join(os.tmpdir(), 'risk-fork-e2b-stale-boot-'));
  t.after(() => rm(evidenceDirectory, { recursive: true, force: true }));
  const env = validEnv(evidenceDirectory);
  const birthRuntime = createBirthHandshakeFiles(env, '2030-01-01T00:00:00.000Z');
  let killed = false;
  let metadata;
  const child = {
    sandboxId: 'sandbox-with-captured-build-evidence',
    files: birthRuntime.files,
    async setTimeout() {},
    async kill() { killed = true; },
  };
  class Sandbox {
    static async create(_templateId, options) {
      metadata = options.metadata;
      return child;
    }
    static async getInfo() {
      if (killed) {
        const error = new Error('not found');
        error.status = 404;
        throw error;
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
