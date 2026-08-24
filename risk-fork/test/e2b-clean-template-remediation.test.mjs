import assert from 'node:assert/strict';
import { generateKeyPairSync, sign } from 'node:crypto';
import {
  chmod,
  link,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { canonicalize, sha256Ref } from '../src/canonical.mjs';
import { E2BRiskForkAdapter, E2B_RISK_FORK_PATHS } from '../src/adapters/e2b.mjs';
import {
  E2B_BOOT_EVIDENCE_PATH,
  createBootEvidenceEnvelope,
  createE2BBirthAttestation,
  e2bBirthRequestPaths,
} from '../e2b-template/lib/runtime-contract.mjs';
import {
  destroyImmutableWorkspaceExport,
  verifyImmutableWorkspaceExportDestroyed,
  workspaceExportPath,
} from '../src/adapters/e2b-workspace-export.mjs';
import { inspectLocalWorkspace } from '../src/adapters/local-reference.mjs';
import {
  E2B_EXTERNAL_PROVIDER_CONTROLS,
  E2B_EXTERNAL_QUALIFICATION_EVIDENCE_REFS,
  E2B_QUALIFICATION_CONTROLS,
  applyE2BExternalQualificationObservation,
  createE2BExternalQualificationObservationVerifier,
  createE2BQualificationEvidence,
  createE2BQualificationTrustVerifier,
  createE2BRuntimeSdkIntegrityVerifier,
  sha256BytesRef,
} from '../src/e2b-qualification.mjs';
import { NOW, hash, makeCapsule, makeForkIdentity } from './helpers.mjs';

const TEMPLATE_ID = 'template-risk-fork-clean-immutable-v1';
const TEMPLATE_HASH = hash('template-risk-fork-clean-immutable-v1');
const TEMPLATE_PROVENANCE_HASH = hash('template-risk-fork-clean-provenance-v1');
const BOOTSTRAP_HASH = hash('trusted-bootstrap-artifact-v2');
const RUNNER_HASH = hash('trusted-runner-artifact-v2');
const MAX_RESULT_BYTES = 4 * 1024 * 1024;
const SECRET_TEST_VALUE = 'abcdefghijklmnop';

function createQualificationTrust(evidence, externalObservationVerifier) {
  const { privateKey, publicKey } = generateKeyPairSync('ed25519');
  const verifier = createE2BQualificationTrustVerifier({
    publicKey,
    publicKeyHash: sha256BytesRef(publicKey.export({ type: 'spki', format: 'der' })),
  });
  const payload = verifier.createPayload(evidence, {}, externalObservationVerifier);
  return {
    qualificationTrustVerifier: verifier,
    qualificationTrust: Object.freeze({
      ...payload,
      signature: sign(
        null,
        Buffer.from(canonicalize(payload), 'utf8'),
        privateKey,
      ).toString('base64url'),
    }),
  };
}

function createQualificationEvidenceForSdk(integrityHash) {
  const externallyObserved = new Set([
    'first_instruction_ipv4_egress_denied',
    'first_instruction_ipv6_egress_denied',
    'cost_within_cap',
    ...E2B_EXTERNAL_PROVIDER_CONTROLS,
  ]);
  const provisional = createE2BQualificationEvidence({
    provider: {
      name: 'e2b',
      project_ref_hash: hash('qualified-project'),
      region: 'test-region',
    },
    sdk: {
      package: 'e2b',
      version: '2.39.0',
      integrity_hash: integrityHash,
    },
    template: {
      template_id_hash: hash(TEMPLATE_ID),
      build_id_hash: hash('qualified-build'),
      template_evidence_hash: TEMPLATE_HASH,
      provenance_hash: TEMPLATE_PROVENANCE_HASH,
    },
    runtime: {
      bootstrap_artifact_hash: BOOTSTRAP_HASH,
      runner_artifact_hash: RUNNER_HASH,
      boot_guard_artifact_hash: hash('qualified-boot-guard'),
    },
    run: {
      approval_ref_hash: hash('qualified-approval'),
      run_ref_hash: hash('qualified-run'),
      started_at: NOW.toISOString(),
      completed_at: new Date(NOW.getTime() + 30_000).toISOString(),
      sandbox_count: 1,
      synthetic_workspace: true,
    },
    limits: {
      hard_ttl_ms: 60_000,
      idle_ttl_ms: 5_000,
      max_execution_ms: 2_000,
      max_cost_usd: '0.10',
    },
    observations: {
      fork_start_ms: 100,
      execution_ms: 100,
      cleanup_ms: 100,
      observed_cost_usd: null,
    },
    controls: Object.fromEntries(
      E2B_QUALIFICATION_CONTROLS.map((name) => [
        name,
        externallyObserved.has(name) ? 'unknown' : 'verified',
      ]),
    ),
    cleanup: {
      kill_requested: 'verified',
      absence_verified: 'verified',
      orphan_reconciliation: 'verified',
    },
    evidence_refs: Object.entries(E2B_EXTERNAL_QUALIFICATION_EVIDENCE_REFS)
      .map(([field, ref]) => ({ ref, hash: hash(`qualified-${field}`) })),
  });
  const { privateKey, publicKey } = generateKeyPairSync('ed25519');
  const externalQualificationObservationVerifier =
    createE2BExternalQualificationObservationVerifier({
      publicKey,
      publicKeyHash: sha256BytesRef(publicKey.export({ type: 'spki', format: 'der' })),
      clock: () => new Date(NOW.getTime() + 70_000),
      maxReceiptAgeMs: 5 * 60_000,
      audience: {
        profile: 'agoragentic.risk-fork.e2b-qualification',
        project_ref_hash: provisional.provider.project_ref_hash,
        run_ref_hash: provisional.run.run_ref_hash,
        template_id_hash: provisional.template.template_id_hash,
        template_build_id_hash: provisional.template.build_id_hash,
      },
    });
  const payload = externalQualificationObservationVerifier.createPayload(provisional, {
    observed_at: new Date(NOW.getTime() + 60_000).toISOString(),
    issued_at: new Date(NOW.getTime() + 65_000).toISOString(),
    expires_at: new Date(NOW.getTime() + 2 * 60_000).toISOString(),
    first_instruction_ipv4_egress_denied: true,
    first_instruction_ipv6_egress_denied: true,
    ipv6_provider_denial: {
      status: 'verified',
      evidence_hash: hash('synthetic-provider-ipv6-denial'),
    },
    provider_controls: Object.fromEntries(E2B_EXTERNAL_PROVIDER_CONTROLS.map((control) => [
      control,
      { status: 'verified', evidence_hash: hash(`synthetic-${control}`) },
    ])),
    cost: {
      provider_cap: {
        amount_usd: '0.10',
        evidence_hash: hash('synthetic-provider-cap'),
      },
      derived_estimate: {
        amount_usd: '0.01',
        evidence_hash: hash('synthetic-derived-estimate'),
      },
      aggregate_console_delta: {
        amount_usd: '0.01',
        evidence_hash: hash('synthetic-console-delta'),
      },
      actual_sandbox: {
        status: 'finalized',
        amount_usd: '0.01',
        evidence_hash: hash('synthetic-finalized-sandbox-cost'),
      },
    },
  });
  const observation = Object.freeze({
    ...payload,
    signature: sign(
      null,
      Buffer.from(canonicalize(payload), 'utf8'),
      privateKey,
    ).toString('base64url'),
  });
  return {
    evidence: applyE2BExternalQualificationObservation(
      provisional,
      observation,
      externalQualificationObservationVerifier,
    ),
    externalQualificationObservationVerifier,
  };
}

function parseFlag(command, flag) {
  const match = new RegExp(`${flag}\\s+(\\S+)`).exec(command);
  return match?.[1] ?? null;
}

function createMockSdk(options = {}) {
  const events = [];
  const files = new Map();
  let createOptions = null;
  let leaseTimeoutMs = null;
  let killed = false;
  let bootstrapCount = 0;
  let birthBootEvidence = null;

  function attestBirthRequest(request) {
    birthBootEvidence = createBootEvidenceEnvelope({
      observed_at: NOW.toISOString(),
      expires_at: new Date(NOW.getTime() + 5 * 60_000).toISOString(),
      boot_nonce: request.birth_nonce,
      boot_id_hash: hash('mock-birth-boot-id'),
      entropy_hash: hash('mock-birth-entropy'),
      bootstrap_artifact_hash: BOOTSTRAP_HASH,
      runner_artifact_hash: RUNNER_HASH,
      measurements: {
        environment_key_count: 4,
        process_count: 2,
        socket_count: 0,
        mount_count: 12,
        credential_path_count: 0,
      },
      observation_hashes: {
        environment_keys_hash: hash('mock-birth-environment'),
        processes_hash: hash('mock-birth-processes'),
        sockets_hash: hash('mock-birth-sockets'),
        mounts_hash: hash('mock-birth-mounts'),
        credential_paths_hash: hash('mock-birth-credentials'),
        ipv4_probe_hash: hash('mock-birth-ipv4-denied'),
        ipv6_probe_hash: hash('mock-birth-ipv6-denied'),
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
    const birthAttestation = {
      ...createE2BBirthAttestation({
        request,
        bootEvidence: birthBootEvidence,
        observed_at: NOW.toISOString(),
      }),
      ...(options.birthAttestationOverrides ?? {}),
    };
    const paths = e2bBirthRequestPaths(request.request_hash);
    files.set(E2B_BOOT_EVIDENCE_PATH, Buffer.from(`${canonicalize(birthBootEvidence)}\n`));
    files.set(paths.attestation, Buffer.from(`${canonicalize(birthAttestation)}\n`));
    files.set(paths.consumed, files.get(paths.request));
    files.set(paths.consumed_trigger, files.get(paths.trigger));
    files.delete(paths.request);
    files.delete(paths.trigger);
    events.push({ type: 'birth-attestation', request, attestation: birthAttestation });
  }

  const child = {
    sandboxId: 'sandbox-clean-template-child-v1',
    files: {
      async write(target, data) {
        const entries = Array.isArray(target) ? target : [{ path: target, data }];
        for (const entry of entries) {
          events.push({ type: 'file-write', path: entry.path });
          files.set(entry.path, Buffer.isBuffer(entry.data)
            ? Buffer.from(entry.data)
            : Buffer.from(entry.data));
          if (entry.path.endsWith('.ready')
            && entry.path.includes('/birth-request.')
            && options.birthNeverAttests !== true) {
            const requestHash = Buffer.from(entry.data).toString('utf8').trim();
            const requestPaths = e2bBirthRequestPaths(requestHash);
            const request = JSON.parse(files.get(requestPaths.request).toString('utf8'));
            attestBirthRequest(request);
          }
        }
      },
      async read(target, readOptions = {}) {
        events.push({ type: 'file-read', path: target, options: readOptions });
        if (!files.has(target)) {
          const error = new Error('not found');
          error.code = 'ENOENT';
          throw error;
        }
        if (readOptions.format === 'stream') {
          if (options.resultStreamFactory && target.includes('.result.')) {
            return options.resultStreamFactory({ target, readOptions, files, events });
          }
          const content = Buffer.from(files.get(target));
          return new ReadableStream({
            start(controller) {
              controller.enqueue(content);
              controller.close();
            },
          });
        }
        return files.get(target);
      },
      async remove(target) {
        events.push({ type: 'file-remove', path: target });
        files.delete(target);
      },
    },
    commands: {
      async run(command, commandOptions) {
        events.push({ type: 'command', command, options: commandOptions });
        if (command === 'trusted-bootstrap') {
          bootstrapCount += 1;
          const request = JSON.parse(files.get(E2B_RISK_FORK_PATHS.identity).toString('utf8'));
          const claims = {
            inherited_parent_processes_absent: true,
            unauthorized_environment_absent: true,
            credential_files_absent: true,
            wallet_signing_material_absent: true,
            inherited_authority_records_absent: true,
            persistent_mounts_absent: true,
            unauthorized_sockets_absent: true,
            network_policy_enforced: true,
            fresh_fork_identity_verified: true,
            fresh_session_nonce_verified: true,
            fresh_entropy_verified: true,
            workspace_manifest_verified: true,
            trusted_runtime_artifacts_verified: true,
            ...(options.postBootClaimOverrides?.[request.phase] ?? {}),
          };
          const statement = {
            schema: 'agoragentic.risk-fork.child-bootstrap-attestation.v1',
            phase: request.phase,
            status: Object.values(claims).every((value) => value === true) ? 'verified' : 'failed',
            bootstrap_request_hash: request.request_hash,
            child_sandbox_id_hash: hash(child.sandboxId),
            template_id_hash: hash(TEMPLATE_ID),
            template_evidence_hash: TEMPLATE_HASH,
            capsule_hash: request.capsule_hash,
            identity_hash: request.fork_identity.identity_hash,
            network_policy_hash: request.network_policy_hash,
            metadata_hash: hash(createOptions.metadata),
            workspace_digest: request.expected_workspace_digest,
            trusted_bootstrap_artifact_hash: BOOTSTRAP_HASH,
            trusted_runner_artifact_hash: RUNNER_HASH,
            ...(birthBootEvidence
              ? { boot_evidence_hash: birthBootEvidence.evidence_hash }
              : {}),
            attested_at: NOW.toISOString(),
            expires_at: new Date(NOW.getTime() + 60_000).toISOString(),
            claims,
            ...(options.bootstrapOverrides?.[request.phase] ?? {}),
          };
          return { exitCode: 0, stdout: JSON.stringify(statement), stderr: '' };
        }
        if (options.runnerNeverResolves) return new Promise(() => {});
        if (options.runnerError) throw options.runnerError;
        const jobPath = parseFlag(command, '--job');
        const resultPath = parseFlag(command, '--result');
        const job = JSON.parse(files.get(jobPath).toString('utf8'));
        const commitCandidate = {
          type: 'TYPED_RESULT',
          result: { answer: 'bounded-result' },
          result_schema_hash: job.expected_result_schema_hash,
        };
        const result = {
          schema: 'agoragentic.risk-fork.runner-result.v1',
          status: 'completed',
          job_id: job.job_id,
          job_hash: job.job_hash,
          capsule_hash: job.capsule_hash,
          identity_hash: job.identity_hash,
          network_policy_hash: job.network_policy_hash,
          operation_hash: job.operation_hash,
          execution_mode: job.execution_mode,
          trusted_runner_artifact_hash: RUNNER_HASH,
          expected_result_schema_hash: job.expected_result_schema_hash,
          commit_candidate: commitCandidate,
          commit_candidate_hash: hash(commitCandidate),
          ...(options.resultOverrides ?? {}),
        };
        files.set(resultPath, Buffer.from(JSON.stringify(result)));
        return { exitCode: 0, stdout: '', stderr: '' };
      },
    },
    async setTimeout(timeoutMs) {
      events.push({ type: 'set-timeout', timeoutMs });
      leaseTimeoutMs = timeoutMs;
      return true;
    },
    async kill() {
      events.push({ type: 'kill-instance' });
      if (options.killError) throw options.killError;
      if (options.killDoesNotRemove) return true;
      killed = true;
      return true;
    },
  };

  class Sandbox {
    static async create(templateId, sdkOptions) {
      await options.onCreate?.({ templateId, sdkOptions });
      events.push({ type: 'create', templateId, options: sdkOptions });
      createOptions = sdkOptions;
      leaseTimeoutMs = sdkOptions.timeoutMs;
      if (options.createError) throw options.createError;
      killed = false;
      files.clear();
      birthBootEvidence = null;
      if (options.preexistingBirthState) {
        files.set(E2B_BOOT_EVIDENCE_PATH, Buffer.from('{}\n'));
      }
      return child;
    }

    static async getInfo(sandboxId) {
      events.push({ type: 'get-info', sandboxId });
      if (options.getInfoError) throw options.getInfoError;
      if (killed) {
        const error = new Error('not found');
        error.status = 404;
        throw error;
      }
      const orphan = options.orphanInfos?.find((item) => item.sandboxId === sandboxId);
      if (orphan) return orphan;
      return {
        sandboxId,
        templateId: TEMPLATE_ID,
        state: 'running',
        allowInternetAccess: false,
        network: {
          allowOut: [],
          denyOut: ['0.0.0.0/0'],
          allowPublicTraffic: false,
        },
        lifecycle: { onTimeout: 'kill', autoResume: false },
        volumeMounts: [],
        metadata: createOptions?.metadata ?? {},
        endAt: new Date(NOW.getTime() + (leaseTimeoutMs ?? createOptions?.timeoutMs ?? 60_000)),
      };
    }

    static list(listOptions) {
      events.push({ type: 'list', options: listOptions });
      let delivered = false;
      return {
        get hasNext() { return !delivered; },
        async nextItems() {
          delivered = true;
          if (killed) return [];
          if (Array.isArray(options.orphanInfos)) return options.orphanInfos;
          return !createOptions ? [] : [await Sandbox.getInfo(child.sandboxId)];
        },
      };
    }

    static async kill(sandboxId) {
      events.push({ type: 'kill-static', sandboxId });
      if (options.killError) throw options.killError;
      if (options.killDoesNotRemove) return true;
      killed = true;
      return true;
    }

    static async createSnapshot() { throw new Error('snapshot API must never be called'); }
    static async fork() { throw new Error('fork API must never be called'); }
    static async connect() { throw new Error('connect API must never be called'); }
    static async pause() { throw new Error('pause API must never be called'); }
  }

  return {
    Sandbox,
    child,
    events,
    files,
    get createOptions() { return createOptions; },
    get bootstrapCount() { return bootstrapCount; },
    get birthBootEvidence() { return birthBootEvidence; },
    get killed() { return killed; },
  };
}

async function fixture(t, mockOptions = {}) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'risk-fork-e2b-clean-template-test-'));
  const source = path.join(root, 'source');
  const exportsDirectory = path.join(root, 'exports');
  const journalDirectory = path.join(root, 'journal');
  await import('node:fs/promises').then(({ mkdir }) => mkdir(source, { recursive: true }));
  await writeFile(path.join(source, 'input.txt'), 'bounded workspace input\n');
  const inspected = await inspectLocalWorkspace({ source_workspace: source });
  const capsule = makeCapsule({ workspace: { digest: inspected.workspace_digest } });
  const mock = createMockSdk(mockOptions);
  let qualificationEvidence = null;
  let externalQualificationObservationVerifier = null;
  let sdkIntegrityVerifier = null;
  let mockSdkGlobal = null;
  if (mockOptions.qualified) {
    const sdkDirectory = path.join(root, 'e2b-sdk');
    await mkdir(path.join(sdkDirectory, 'dist'), { recursive: true });
    mockSdkGlobal = `__riskForkE2BSdk_${path.basename(root).replace(/[^A-Za-z0-9_]/g, '_')}`;
    globalThis[mockSdkGlobal] = mock.Sandbox;
    await writeFile(path.join(sdkDirectory, 'package.json'), JSON.stringify({
      name: 'e2b',
      version: '2.39.0',
      main: 'dist/index.js',
    }));
    await writeFile(
      path.join(sdkDirectory, 'dist', 'index.js'),
      `module.exports = { Sandbox: globalThis[${JSON.stringify(mockSdkGlobal)}] };\n`,
    );
    sdkIntegrityVerifier = createE2BRuntimeSdkIntegrityVerifier({
      packageDirectory: sdkDirectory,
    });
    const qualification = createQualificationEvidenceForSdk(
      (await sdkIntegrityVerifier.inspect()).integrity_hash,
    );
    qualificationEvidence = qualification.evidence;
    externalQualificationObservationVerifier =
      qualification.externalQualificationObservationVerifier;
    if (mockOptions.tamperSdkAfterQualification === 'version') {
      await writeFile(path.join(sdkDirectory, 'package.json'), JSON.stringify({
        name: 'e2b',
        version: '2.40.0',
        main: 'dist/index.js',
      }));
    } else if (mockOptions.tamperSdkAfterQualification === 'bytes') {
      await writeFile(
        path.join(sdkDirectory, 'dist', 'index.js'),
        'module.exports = { Sandbox: class TamperedSandbox {} };\n',
      );
    }
  }
  const qualificationTrust = qualificationEvidence
    ? createQualificationTrust(
        qualificationEvidence,
        externalQualificationObservationVerifier,
      )
    : {};
  const adapter = new E2BRiskForkAdapter({
    ...(qualificationEvidence
      ? { sdkIntegrityVerifier }
      : { SandboxClass: mock.Sandbox, offlineConformance: true }),
    cleanTemplateId: TEMPLATE_ID,
    cleanTemplateHash: TEMPLATE_HASH,
    cleanTemplateProvenanceHash: TEMPLATE_PROVENANCE_HASH,
    workspaceExportDirectory: exportsDirectory,
    cleanupJournalDirectory: journalDirectory,
    verifyAuthorityFreeSource: async (request) => ({
      ...(await mockOptions.onSourceVerify?.(request, { source, exportsDirectory }) ?? {}),
      schema: 'agoragentic.risk-fork.authority-free-source-attestation.v1',
      status: 'verified',
      request_hash: request.request_hash,
      evidence_ref: 'attestation:clean-workspace-v1',
      evidence_hash: hash('attestation:clean-workspace-v1'),
      workspace_digest: request.workspace_digest,
      workspace_manifest_hash: request.workspace_manifest_hash,
      trusted_bootstrap_artifact_hash: BOOTSTRAP_HASH,
      trusted_runner_artifact_hash: RUNNER_HASH,
      claims: {
        authority_free: true,
        credentials_absent: true,
        wallet_material_absent: true,
        execution_authority_absent: true,
        workspace_manifest_verified: true,
        immutable_export_verified: true,
        trusted_runtime_artifacts_verified: true,
      },
    }),
    bootstrapCommand: 'trusted-bootstrap',
    runnerCommand: 'trusted-runner',
    trustedBootstrapArtifactHash: BOOTSTRAP_HASH,
    trustedRunnerArtifactHash: RUNNER_HASH,
    birthAttestationTimeoutMs: mockOptions.birthAttestationTimeoutMs ?? 1_000,
    ...(qualificationEvidence
      ? {
          qualificationEvidence,
          externalQualificationObservationVerifier,
          ...qualificationTrust,
        }
      : {}),
    clock: () => new Date(NOW),
  });
  t.after(async () => {
    for (const record of adapter.savepoints.values()) {
      await destroyImmutableWorkspaceExport({
        export_root: exportsDirectory,
        export_id: record.export_record.export_id,
      });
    }
    if (mockSdkGlobal) delete globalThis[mockSdkGlobal];
    await rm(root, { recursive: true, force: true });
  });
  return { root, source, exportsDirectory, journalDirectory, capsule, mock, adapter };
}

async function prepareFork(t, mockOptions = {}) {
  const value = await fixture(t, mockOptions);
  const savepoint = await value.adapter.createSavepoint({
    capsule: value.capsule,
    source_workspace: value.source,
  });
  const identity = makeForkIdentity(value.capsule);
  const fork = await value.adapter.createFork({
    savepoint_ref: savepoint.savepoint_ref,
    fork_identity: identity,
    network_policy: { mode: 'blocked', allowlist: [] },
    ttl_ms: 60_000,
  });
  return { ...value, savepoint, identity, fork };
}

async function capsuleForCurrentWorkspace(source) {
  const inspected = await inspectLocalWorkspace({ source_workspace: source });
  return makeCapsule({ workspace: { digest: inspected.workspace_digest } });
}

async function assertSanitizedExportRejectsContent(t, content, filename = 'config.txt') {
  const value = await fixture(t);
  await writeFile(path.join(value.source, filename), content);
  const capsule = await capsuleForCurrentWorkspace(value.source);
  await assert.rejects(
    value.adapter.createSavepoint({ capsule, source_workspace: value.source }),
    (error) => {
      assert.match(error?.message ?? '', /authority or secret-shaped material/i);
      assert.equal(
        error?.message?.includes(SECRET_TEST_VALUE),
        false,
        'error must not log secret bytes',
      );
      return true;
    },
  );
  assert.equal(value.mock.events.some((event) => event.type === 'create'), false);
}

async function assertSanitizedExportAllowsContent(t, content, filename = 'config.txt') {
  const value = await fixture(t);
  await writeFile(path.join(value.source, filename), content);
  const capsule = await capsuleForCurrentWorkspace(value.source);
  const savepoint = await value.adapter.createSavepoint({
    capsule,
    source_workspace: value.source,
  });
  assert.match(savepoint.savepoint_ref, /^e2b-workspace-export:/);
  assert.equal(savepoint.workspace_digest, capsule.workspace.digest);
  assert.equal(value.mock.events.some((event) => event.type === 'create'), false);
}

test('strict clean-template profile exports locally and never snapshots or forks a live source', async (t) => {
  const prepared = await prepareFork(t);
  assert.equal(prepared.savepoint.runtime_snapshot.mode, 'filesystem');
  assert.equal(prepared.savepoint.runtime_snapshot.memory_included, false);
  assert.equal(prepared.mock.events.some((event) => ['create-snapshot', 'fork', 'pause', 'connect'].includes(event.type)), false);
  assert.equal(prepared.mock.events.filter((event) => event.type === 'create').length, 1);
  assert.equal(prepared.mock.bootstrapCount, 2, 'pre-upload and post-import attestations are both required');
});

test('child birth options are exact and authority-free while IPv6 remains unqualified', async (t) => {
  const { mock, fork } = await prepareFork(t);
  assert.equal(mock.events.find((event) => event.type === 'create').templateId, TEMPLATE_ID);
  assert.deepEqual(mock.createOptions.envs, {});
  assert.deepEqual(mock.createOptions.iam, { tokens: {} });
  assert.deepEqual(mock.createOptions.volumeMounts, {});
  assert.equal(mock.createOptions.secure, true);
  assert.equal(mock.createOptions.allowInternetAccess, false);
  assert.deepEqual(mock.createOptions.network, {
    allowOut: [],
    denyOut: ['0.0.0.0/0'],
    allowPublicTraffic: false,
  });
  assert.deepEqual(mock.createOptions.lifecycle, { onTimeout: 'kill', autoResume: false });
  assert.equal(mock.createOptions.timeoutMs, 60_000);
  assert.equal(fork.network_status, 'offline_conformance_observation_only_ipv4_ipv6_unqualified');
});

test('birth request is exact-bound after getInfo and attested before identity, commands, or upload', async (t) => {
  const prepared = await prepareFork(t);
  const events = prepared.mock.events;
  const getInfoIndex = events.findIndex((event) => event.type === 'get-info');
  const requestWriteIndex = events.findIndex((event) => event.type === 'file-write'
    && /\/birth-request\.[0-9a-f]{64}\.json$/.test(event.path));
  const triggerWriteIndex = events.findIndex((event) => event.type === 'file-write'
    && /\/birth-request\.[0-9a-f]{64}\.ready$/.test(event.path));
  const birthIndex = events.findIndex((event) => event.type === 'birth-attestation');
  const identityIndex = events.findIndex((event) => event.type === 'file-write'
    && event.path === E2B_RISK_FORK_PATHS.identity);
  const commandIndex = events.findIndex((event) => event.type === 'command');
  const workspaceIndex = events.findIndex((event) => event.type === 'file-write'
    && event.path.startsWith('/workspace/'));
  assert.equal(getInfoIndex >= 0 && getInfoIndex < requestWriteIndex, true);
  assert.equal(requestWriteIndex < triggerWriteIndex && triggerWriteIndex < birthIndex, true);
  assert.equal(birthIndex < identityIndex && birthIndex < commandIndex && birthIndex < workspaceIndex, true);
  assert.equal(events.slice(0, birthIndex).some((event) => event.type === 'command'), false);
  const { request, attestation } = events[birthIndex];
  assert.equal(request.sandbox_id_hash, hash(prepared.mock.child.sandboxId));
  assert.equal(request.provider_metadata_hash, hash(prepared.mock.createOptions.metadata));
  assert.equal(request.template_id_hash, hash(TEMPLATE_ID));
  assert.equal(request.template_evidence_hash, TEMPLATE_HASH);
  assert.equal(request.template_provenance_hash, TEMPLATE_PROVENANCE_HASH);
  assert.equal(attestation.birth_request_hash, request.request_hash);
  assert.equal(attestation.boot_evidence_hash, prepared.mock.birthBootEvidence.evidence_hash);
  assert.equal(Date.parse(attestation.observed_at) >= Date.parse(request.allocation_started_at), true);
  assert.deepEqual(Object.values(request.authority_flags), [false, false, false, false]);
  const evidence = await prepared.adapter.collectEvidence({ fork_ref: prepared.fork.fork_ref });
  assert.equal(evidence.birth_request_hash, request.request_hash);
  assert.equal(evidence.birth_attestation_hash, attestation.attestation_hash);
});

test('birth timeout, malformed attestation, and preexisting state kill and reconcile before bootstrap', async (t) => {
  for (const [name, mockOptions, pattern] of [
    [
      'timeout',
      { birthNeverAttests: true, birthAttestationTimeoutMs: 50 },
      /birth watcher did not attest|controller deadline/i,
    ],
    [
      'malformed',
      { birthAttestationOverrides: { sandbox_id_hash: hash('substituted-sandbox') } },
      /birth attestation|hash mismatch|binding mismatch/i,
    ],
    [
      'preexisting',
      { preexistingBirthState: true },
      /birth preflight found preexisting state/i,
    ],
  ]) {
    await t.test(name, async (t2) => {
      const value = await fixture(t2, mockOptions);
      const savepoint = await value.adapter.createSavepoint({
        capsule: value.capsule,
        source_workspace: value.source,
      });
      await assert.rejects(
        value.adapter.createFork({
          savepoint_ref: savepoint.savepoint_ref,
          fork_identity: makeForkIdentity(value.capsule),
          network_policy: { mode: 'blocked', allowlist: [] },
          ttl_ms: 60_000,
        }),
        pattern,
      );
      assert.equal(value.mock.killed, true);
      assert.equal(value.mock.events.some((event) => event.type === 'command'), false);
      assert.equal(value.mock.events.some((event) => event.type === 'file-write'
        && event.path === E2B_RISK_FORK_PATHS.identity), false);
    });
  }
});

test('allocation intent with the exact provider metadata is durable before Sandbox.create', async (t) => {
  const mockOptions = {};
  const value = await fixture(t, mockOptions);
  const savepoint = await value.adapter.createSavepoint({
    capsule: value.capsule,
    source_workspace: value.source,
  });
  mockOptions.onCreate = async ({ sdkOptions }) => {
    const [journalName] = (await readdir(value.journalDirectory))
      .filter((name) => name.endsWith('.json'));
    const journal = JSON.parse(await readFile(path.join(value.journalDirectory, journalName), 'utf8'));
    assert.equal(journal.sandbox_state, 'allocation_requested');
    assert.equal(journal.metadata_hash, hash(sdkOptions.metadata));
  };
  await value.adapter.createFork({
    savepoint_ref: savepoint.savepoint_ref,
    fork_identity: makeForkIdentity(value.capsule),
    network_policy: { mode: 'blocked', allowlist: [] },
    ttl_ms: 60_000,
  });
});

test('an allocation with unknown provider outcome permanently poisons the one-use Savepoint', async (t) => {
  const createError = new Error('provider response lost after allocation');
  createError.code = 'PROVIDER_RESPONSE_LOST';
  const mockOptions = { createError };
  const value = await fixture(t, mockOptions);
  mockOptions.onCreate = async ({ sdkOptions }) => {
    mockOptions.orphanInfos = [{
      sandboxId: 'sandbox-created-before-response-loss',
      templateId: TEMPLATE_ID,
      metadata: sdkOptions.metadata,
    }];
  };
  const savepoint = await value.adapter.createSavepoint({
    capsule: value.capsule,
    source_workspace: value.source,
  });
  const request = {
    savepoint_ref: savepoint.savepoint_ref,
    fork_identity: makeForkIdentity(value.capsule),
    network_policy: { mode: 'blocked', allowlist: [] },
    ttl_ms: 60_000,
  };
  await assert.rejects(value.adapter.createFork(request), /provider response lost/i);
  assert.equal(value.mock.events.filter((event) => event.type === 'create').length, 1);
  await assert.rejects(value.adapter.createFork(request), /one-use|poison|already attempted/i);
  assert.equal(
    value.mock.events.filter((event) => event.type === 'create').length,
    1,
    'retry must not issue a second provider allocation',
  );
  const [journalName] = (await readdir(value.journalDirectory))
    .filter((name) => name.endsWith('.json'));
  const journal = JSON.parse(await readFile(path.join(value.journalDirectory, journalName), 'utf8'));
  assert.equal(journal.sandbox_state, 'unknown');
  assert.equal(journal.sandbox_absence_verified, false);
  const reconciliation = await value.adapter.reconcilePendingCleanup();
  assert.deepEqual(reconciliation.unresolved, []);
  assert.deepEqual(reconciliation.reconciled.length, 1);
  assert.equal(value.mock.killed, true);
  await assert.rejects(value.adapter.createFork(request), /one-use|poison|already attempted/i);
  assert.equal(value.mock.events.filter((event) => event.type === 'create').length, 1);
});

test('concurrent createFork calls cross the one-use allocation boundary exactly once', async (t) => {
  const value = await fixture(t);
  const savepoint = await value.adapter.createSavepoint({
    capsule: value.capsule,
    source_workspace: value.source,
  });
  const request = {
    savepoint_ref: savepoint.savepoint_ref,
    fork_identity: makeForkIdentity(value.capsule),
    network_policy: { mode: 'blocked', allowlist: [] },
    ttl_ms: 60_000,
  };
  const outcomes = await Promise.allSettled([
    value.adapter.createFork(request),
    value.adapter.createFork(request),
  ]);
  assert.equal(outcomes.filter((outcome) => outcome.status === 'fulfilled').length, 1);
  assert.equal(outcomes.filter((outcome) => outcome.status === 'rejected').length, 1);
  assert.match(outcomes.find((outcome) => outcome.status === 'rejected').reason.message, /one-use|already attempted/i);
  assert.equal(value.mock.events.filter((event) => event.type === 'create').length, 1);
});

test('source mutation after external verification cannot change the staged bytes uploaded', async (t) => {
  const mockOptions = {};
  const value = await fixture(t, mockOptions);
  mockOptions.onSourceVerify = async () => {
    await writeFile(path.join(value.source, 'input.txt'), 'mutated after staging\n');
  };
  const savepoint = await value.adapter.createSavepoint({
    capsule: value.capsule,
    source_workspace: value.source,
  });
  await value.adapter.createFork({
    savepoint_ref: savepoint.savepoint_ref,
    fork_identity: makeForkIdentity(value.capsule),
    network_policy: { mode: 'blocked', allowlist: [] },
    ttl_ms: 60_000,
  });
  assert.equal(
    value.mock.files.get('/workspace/agoragentic-risk-fork-v1/input.txt').toString('utf8'),
    'bounded workspace input\n',
  );
});

test('configured capabilities remain production-ineligible until live containment qualification', async (t) => {
  const { adapter } = await fixture(t);
  assert.equal(adapter.capabilities.supports_filesystem_snapshot, true);
  assert.equal(adapter.capabilities.supports_live_fork, false);
  assert.equal(adapter.capabilities.supports_network_policy, false);
  assert.equal(adapter.capabilities.supports_runtime_attestation, false);
  assert.equal(adapter.capabilities.supports_verified_destruction, false);
  assert.equal(adapter.capabilities.supports_hard_ttl, false);
  assert.equal(adapter.capabilities.supports_max_execution_time, false);
  assert.equal(adapter.capabilities.supports_idle_ttl, false);
  assert.equal(adapter.capabilities.child_credentials_mode, 'prohibited');
  assert.equal(adapter.capabilities.credentialed_provider_validation, 'not_run');
  assert.equal(adapter.capabilities.containment_claim, 'not_verified');
});

test('signed qualification cannot bypass the source-wired untrusted-watcher allocation gate', async (t) => {
  const prepared = await fixture(t, {
    qualified: true,
    bootEvidenceHash: hash('qualified-boot-evidence'),
  });
  const savepoint = await prepared.adapter.createSavepoint({
    capsule: prepared.capsule,
    source_workspace: prepared.source,
  });
  await assert.rejects(
    prepared.adapter.createFork({
      savepoint_ref: savepoint.savepoint_ref,
      fork_identity: makeForkIdentity(prepared.capsule),
      network_policy: { mode: 'blocked', allowlist: [] },
      ttl_ms: 60_000,
      idle_ttl_ms: 5_000,
    }),
    (error) => error?.code === 'E2B_LIVE_FORK_DISABLED_UNTRUSTED_WATCHER'
      && error?.production_qualified === false,
  );
  assert.equal(
    prepared.mock.events.some((event) => event.type === 'create'),
    false,
    'signed evidence must not reach SDK loading or provider allocation',
  );
  assert.equal(prepared.adapter.capabilities.supports_idle_ttl, false);
  assert.equal(prepared.adapter.capabilities.containment_claim, 'not_verified');
});

test('post-boot attestation fails closed before execution for every inherited-state claim', async (t) => {
  for (const claim of [
    'inherited_parent_processes_absent',
    'unauthorized_environment_absent',
    'credential_files_absent',
    'persistent_mounts_absent',
    'unauthorized_sockets_absent',
    'fresh_entropy_verified',
  ]) {
    await t.test(claim, async (t2) => {
      const value = await fixture(t2, { postBootClaimOverrides: { pre_upload: { [claim]: false } } });
      const savepoint = await value.adapter.createSavepoint({
        capsule: value.capsule,
        source_workspace: value.source,
      });
      await assert.rejects(
        value.adapter.createFork({
          savepoint_ref: savepoint.savepoint_ref,
          fork_identity: makeForkIdentity(value.capsule),
          network_policy: { mode: 'blocked', allowlist: [] },
          ttl_ms: 60_000,
        }),
        /bootstrap|attestation|inherited|environment|credential|mount|socket|entropy/i,
      );
      assert.equal(value.mock.killed, true);
    });
  }
});

test('post-boot attestation is exact-bound to the fresh bootstrap request', async (t) => {
  const value = await fixture(t, {
    bootstrapOverrides: { pre_upload: { bootstrap_request_hash: hash('stale-request') } },
  });
  const savepoint = await value.adapter.createSavepoint({
    capsule: value.capsule,
    source_workspace: value.source,
  });
  await assert.rejects(
    value.adapter.createFork({
      savepoint_ref: savepoint.savepoint_ref,
      fork_identity: makeForkIdentity(value.capsule),
      network_policy: { mode: 'blocked', allowlist: [] },
      ttl_ms: 60_000,
    }),
    /bootstrap request|attestation binding|mismatch/i,
  );
  assert.equal(value.mock.killed, true);
});

test('runner result is exact-bound to a unique job and stale or substituted evidence is rejected', async (t) => {
  const prepared = await prepareFork(t, { resultOverrides: { operation_hash: hash('wrong-operation') } });
  await assert.rejects(
    prepared.adapter.executeInFork({
      fork_ref: prepared.fork.fork_ref,
      execution_mode: 'isolated_execution',
      operation: { kind: 'analyze', subject_ref: 'opaque:test' },
      timeout_ms: 5_000,
    }),
    /operation|result binding|mismatch/i,
  );
  assert.equal(prepared.mock.killed, true);
  const jobWrites = prepared.mock.events.filter((event) => event.type === 'file-write'
    && event.path.startsWith(`${E2B_RISK_FORK_PATHS.job}.`));
  assert.equal(jobWrites.length, 1);
});

test('execution timeout destroys the whole sandbox and independently verifies absence', async (t) => {
  const timeout = new Error('command deadline exceeded');
  timeout.code = 'TIMEOUT';
  const prepared = await prepareFork(t, { runnerError: timeout });
  await assert.rejects(
    prepared.adapter.executeInFork({
      fork_ref: prepared.fork.fork_ref,
      execution_mode: 'isolated_execution',
      operation: { kind: 'analyze', subject_ref: 'opaque:timeout' },
      timeout_ms: 500,
    }),
    /timeout|execution|destroy/i,
  );
  assert.equal(prepared.mock.killed, true);
  assert.ok(prepared.mock.events.some((event) => event.type === 'get-info' && prepared.mock.killed));
});

test('unknown execution cleanup blocks every later allocation until exact reconciliation verifies absence', async (t) => {
  const runnerError = new Error('runner failed before a bound result existed');
  runnerError.code = 'RUNNER_FAILED';
  const killError = new Error('provider unavailable while killing failed execution');
  killError.code = 'PROVIDER_UNAVAILABLE';
  const mockOptions = { runnerError, killError };
  const prepared = await prepareFork(t, mockOptions);

  await assert.rejects(
    prepared.adapter.executeInFork({
      fork_ref: prepared.fork.fork_ref,
      execution_mode: 'isolated_execution',
      operation: { kind: 'analyze', subject_ref: 'opaque:cleanup-unknown' },
      timeout_ms: 500,
    }),
    /absence was not verified|cleanup is unknown/i,
  );

  const nextSavepoint = await prepared.adapter.createSavepoint({
    capsule: prepared.capsule,
    source_workspace: prepared.source,
  });
  const nextForkRequest = {
    savepoint_ref: nextSavepoint.savepoint_ref,
    fork_identity: makeForkIdentity(prepared.capsule),
    network_policy: { mode: 'blocked', allowlist: [] },
    ttl_ms: 60_000,
  };
  await assert.rejects(
    prepared.adapter.createFork(nextForkRequest),
    (error) => error?.code === 'E2B_CLEANUP_RECONCILIATION_REQUIRED',
  );
  assert.equal(prepared.mock.events.filter((event) => event.type === 'create').length, 1);

  mockOptions.killError = null;
  const reconciliation = await prepared.adapter.reconcilePendingCleanup();
  assert.deepEqual(reconciliation.unresolved, []);
  assert.equal(reconciliation.reconciled.length, 1);

  const nextFork = await prepared.adapter.createFork(nextForkRequest);
  assert.equal(nextFork.status, 'ready');
  assert.equal(prepared.mock.events.filter((event) => event.type === 'create').length, 2);
});

test('destroyFork unknown poisons allocation until sandbox and export absence are both verified', async (t) => {
  const mockOptions = {};
  const prepared = await prepareFork(t, mockOptions);
  const killError = new Error('provider kill outcome unknown');
  killError.code = 'PROVIDER_UNAVAILABLE';
  mockOptions.killError = killError;

  const destruction = await prepared.adapter.destroyFork({ fork_ref: prepared.fork.fork_ref });
  assert.equal(destruction.status, 'unknown');
  const nextSavepoint = await prepared.adapter.createSavepoint({
    capsule: prepared.capsule,
    source_workspace: prepared.source,
  });
  const nextForkRequest = {
    savepoint_ref: nextSavepoint.savepoint_ref,
    fork_identity: makeForkIdentity(prepared.capsule),
    network_policy: { mode: 'blocked', allowlist: [] },
    ttl_ms: 60_000,
  };
  await assert.rejects(
    prepared.adapter.createFork(nextForkRequest),
    (error) => error?.code === 'E2B_CLEANUP_RECONCILIATION_REQUIRED',
  );

  mockOptions.killError = null;
  assert.deepEqual((await prepared.adapter.reconcilePendingCleanup()).unresolved, []);
  assert.equal((await prepared.adapter.createFork(nextForkRequest)).status, 'ready');
});

test('verifyDestroyed unknown poisons allocation until reconciliation kills the exact sandbox', async (t) => {
  const mockOptions = {};
  const prepared = await prepareFork(t, mockOptions);
  const getInfoError = new Error('provider absence query unavailable');
  getInfoError.code = 'PROVIDER_UNAVAILABLE';
  mockOptions.getInfoError = getInfoError;

  const verification = await prepared.adapter.verifyDestroyed({ fork_ref: prepared.fork.fork_ref });
  assert.equal(verification.status, 'unknown');
  const nextSavepoint = await prepared.adapter.createSavepoint({
    capsule: prepared.capsule,
    source_workspace: prepared.source,
  });
  const nextForkRequest = {
    savepoint_ref: nextSavepoint.savepoint_ref,
    fork_identity: makeForkIdentity(prepared.capsule),
    network_policy: { mode: 'blocked', allowlist: [] },
    ttl_ms: 60_000,
  };
  await assert.rejects(
    prepared.adapter.createFork(nextForkRequest),
    (error) => error?.code === 'E2B_CLEANUP_RECONCILIATION_REQUIRED',
  );

  mockOptions.getInfoError = null;
  assert.deepEqual((await prepared.adapter.reconcilePendingCleanup()).unresolved, []);
  assert.equal((await prepared.adapter.createFork(nextForkRequest)).status, 'ready');
});

test('unknown export cleanup durably blocks allocation until reconciliation verifies both resources absent', async (t) => {
  const value = await fixture(t);
  const savepoint = await value.adapter.createSavepoint({
    capsule: value.capsule,
    source_workspace: value.source,
  });
  const originalMarkCleanupRequested = value.adapter.cleanupJournal.markExportCleanupRequested
    .bind(value.adapter.cleanupJournal);
  value.adapter.cleanupJournal.markExportCleanupRequested = async () => {
    const error = new Error('cleanup journal write unavailable');
    error.code = 'JOURNAL_UNAVAILABLE';
    throw error;
  };
  const destruction = await value.adapter.destroySavepoint({
    savepoint_ref: savepoint.savepoint_ref,
  });
  assert.equal(destruction.status, 'unknown');
  value.adapter.cleanupJournal.markExportCleanupRequested = originalMarkCleanupRequested;

  const nextSavepoint = await value.adapter.createSavepoint({
    capsule: value.capsule,
    source_workspace: value.source,
  });
  const nextForkRequest = {
    savepoint_ref: nextSavepoint.savepoint_ref,
    fork_identity: makeForkIdentity(value.capsule),
    network_policy: { mode: 'blocked', allowlist: [] },
    ttl_ms: 60_000,
  };
  await assert.rejects(
    value.adapter.createFork(nextForkRequest),
    (error) => error?.code === 'E2B_CLEANUP_RECONCILIATION_REQUIRED',
  );
  assert.equal(value.mock.events.some((event) => event.type === 'create'), false);

  const reconciliation = await value.adapter.reconcilePendingCleanup();
  assert.deepEqual(reconciliation.unresolved, []);
  assert.equal((await value.adapter.createFork(nextForkRequest)).status, 'ready');
});

test('controller deadline kills a runner even when the SDK command promise never settles', async (t) => {
  const prepared = await prepareFork(t, { runnerNeverResolves: true });
  await assert.rejects(
    prepared.adapter.executeInFork({
      fork_ref: prepared.fork.fork_ref,
      execution_mode: 'isolated_execution',
      operation: { kind: 'analyze', subject_ref: 'opaque:hung-runner' },
      timeout_ms: 100,
    }),
    /execution|timeout|destroy/i,
  );
  assert.equal(prepared.mock.killed, true);
  assert.ok(prepared.mock.events.some((event) => event.type === 'get-info'));
});

test('oversized chunked runner result is never retained beyond the byte cap or accepted', async (t) => {
  const streamState = { cancelled: false, pulls: 0 };
  const chunks = [
    Buffer.alloc(MAX_RESULT_BYTES / 2, 0x20),
    Buffer.alloc(MAX_RESULT_BYTES / 2, 0x20),
    Buffer.from([0x20]),
  ];
  const prepared = await prepareFork(t, {
    resultStreamFactory: () => ({
      getReader() {
        return {
          async read() {
            const chunk = chunks[streamState.pulls];
            streamState.pulls += 1;
            return chunk ? { done: false, value: chunk } : { done: true };
          },
          async cancel() { streamState.cancelled = true; },
          releaseLock() {},
        };
      },
    }),
  });

  await assert.rejects(
    prepared.adapter.executeInFork({
      fork_ref: prepared.fork.fork_ref,
      execution_mode: 'isolated_execution',
      operation: { kind: 'analyze', subject_ref: 'opaque:oversized-stream' },
      timeout_ms: 1_000,
    }),
    (error) => {
      assert.equal(error?.code, 'E2B_EXECUTION_FAILED_CHILD_VERIFIED_ABSENT');
      assert.equal(error?.cause?.code, 'E2B_RESULT_STREAM_LIMIT_EXCEEDED');
      assert.equal(error?.cause?.retained_bytes, MAX_RESULT_BYTES);
      assert.equal(error?.cause?.max_bytes, MAX_RESULT_BYTES);
      return true;
    },
  );
  assert.equal(streamState.cancelled, true);
  assert.equal(prepared.mock.killed, true);
  const readEvent = prepared.mock.events.find((event) => event.type === 'file-read'
    && event.path.startsWith(`${E2B_RISK_FORK_PATHS.result}.`));
  assert.equal(readEvent.options.format, 'stream');
  assert.equal(typeof readEvent.options.streamIdleTimeoutMs, 'number');
  assert.equal(readEvent.options.signal.aborted, true);
  const evidence = await prepared.adapter.collectEvidence({ fork_ref: prepared.fork.fork_ref });
  assert.equal(evidence.runner_status, 'not_run');
  assert.equal(evidence.last_execution, null);
});

test('stalled runner result stream is cancelled before the whole child is killed and verified absent', async (t) => {
  const streamState = { cancelled: false };
  const prepared = await prepareFork(t, {
    resultStreamFactory: () => ({
      getReader() {
        return {
          read: () => new Promise(() => {}),
          async cancel() { streamState.cancelled = true; },
          releaseLock() {},
        };
      },
    }),
  });

  await assert.rejects(
    prepared.adapter.executeInFork({
      fork_ref: prepared.fork.fork_ref,
      execution_mode: 'isolated_execution',
      operation: { kind: 'analyze', subject_ref: 'opaque:stalled-stream' },
      timeout_ms: 100,
    }),
    (error) => {
      assert.equal(error?.code, 'E2B_EXECUTION_FAILED_CHILD_VERIFIED_ABSENT');
      assert.ok([
        'E2B_RESULT_STREAM_IDLE_TIMEOUT',
        'E2B_RESULT_STREAM_TOTAL_TIMEOUT',
      ].includes(error?.cause?.code));
      assert.equal(error?.cause?.retained_bytes, 0);
      return true;
    },
  );
  assert.equal(streamState.cancelled, true);
  assert.equal(prepared.mock.killed, true);
  assert.ok(prepared.mock.events.some((event) => event.type === 'get-info'));
});

test('sanitized export rejects credential-shaped workspace material before provider allocation', async (t) => {
  const value = await fixture(t);
  await writeFile(path.join(value.source, '.env'), 'API_KEY=abcdefghijklmnop\n');
  await assert.rejects(
    value.adapter.createSavepoint({ capsule: value.capsule, source_workspace: value.source }),
    /credential|secret|authority|workspace digest/i,
  );
  assert.equal(value.mock.events.some((event) => event.type === 'create'), false);
});

test('sanitized export rejects a quoted JSON credential key and value', async (t) => {
  await assertSanitizedExportRejectsContent(
    t,
    `{"API_KEY":"${SECRET_TEST_VALUE}"}\n`,
    'config.json',
  );
});

test('sanitized export rejects a nested JSON credential key and value', async (t) => {
  await assertSanitizedExportRejectsContent(
    t,
    `{"outer":{"Client_Secret":"${SECRET_TEST_VALUE}"}}\n`,
    'nested.json',
  );
});

test('sanitized export rejects a double-quoted shell credential assignment', async (t) => {
  await assertSanitizedExportRejectsContent(t, `API_KEY="${SECRET_TEST_VALUE}"\n`, 'settings.sh');
});

test('sanitized export rejects a single-quoted shell credential assignment', async (t) => {
  await assertSanitizedExportRejectsContent(t, `api_key='${SECRET_TEST_VALUE}'\n`, 'settings.sh');
});

test('sanitized export rejects whitespace-padded mixed-case credential assignments', async (t) => {
  await assertSanitizedExportRejectsContent(
    t,
    `  ApI_KeY \t = \t "${SECRET_TEST_VALUE}"\n`,
    'settings.conf',
  );
});

test('sanitized export scans exact bytes even when surrounding bytes are invalid UTF-8', async (t) => {
  await assertSanitizedExportRejectsContent(
    t,
    Buffer.concat([
      Buffer.from([0xff, 0xfe, 0x0a]),
      Buffer.from(`API_KEY="${SECRET_TEST_VALUE}"\n`, 'ascii'),
    ]),
    'binary-input.dat',
  );
});

test('sanitized export does not reject prose, longer metadata keys, or short examples', async (t) => {
  await t.test('prose without an assignment', async (t2) => {
    await assertSanitizedExportAllowsContent(
      t2,
      'Set API_KEY through the parent authorization boundary.\n',
      'README.txt',
    );
  });
  await t.test('longer non-secret metadata keys', async (t2) => {
    await assertSanitizedExportAllowsContent(
      t2,
      '{"api_key_required":true,"client_secret_source":"host-only"}\n',
      'metadata.json',
    );
  });
  await t.test('short example value', async (t2) => {
    await assertSanitizedExportAllowsContent(t2, 'API_KEY="example"\n', 'example.conf');
  });
});

test('sanitized export rejects hard-linked workspace files before provider allocation', async (t) => {
  const value = await fixture(t);
  await link(path.join(value.source, 'input.txt'), path.join(value.source, 'duplicate.txt'));
  await assert.rejects(
    value.adapter.createSavepoint({ capsule: value.capsule, source_workspace: value.source }),
    /hard-linked|workspace digest/i,
  );
  assert.equal(value.mock.events.some((event) => event.type === 'create'), false);
});

test('sanitized export rejects symlinks before provider allocation', async (t) => {
  const value = await fixture(t);
  const outside = path.join(value.root, 'outside');
  await mkdir(outside);
  await writeFile(path.join(outside, 'outside.txt'), 'must not cross the export boundary\n');
  await symlink(
    outside,
    path.join(value.source, 'linked-directory'),
    process.platform === 'win32' ? 'junction' : 'dir',
  );
  await assert.rejects(
    value.adapter.createSavepoint({ capsule: value.capsule, source_workspace: value.source }),
    /symlink/i,
  );
  assert.equal(value.mock.events.some((event) => event.type === 'create'), false);
});

test('sanitized export rejects Unicode-normalization path collisions before provider allocation', async (t) => {
  const value = await fixture(t);
  const composed = path.join(value.source, '\u00e9');
  const decomposed = path.join(value.source, 'e\u0301');
  await mkdir(composed);
  await mkdir(decomposed);
  await writeFile(path.join(composed, 'left.txt'), 'left\n');
  await writeFile(path.join(decomposed, 'right.txt'), 'right\n');
  await assert.rejects(
    value.adapter.createSavepoint({ capsule: value.capsule, source_workspace: value.source }),
    /Unicode|collision/i,
  );
  assert.equal(value.mock.events.some((event) => event.type === 'create'), false);
});

test('sanitized export rejects case-folding path collisions before provider allocation', {
  skip: process.platform === 'win32',
}, async (t) => {
  const value = await fixture(t);
  await writeFile(path.join(value.source, 'CaseName.txt'), 'upper\n');
  await writeFile(path.join(value.source, 'casename.txt'), 'lower\n');
  await assert.rejects(
    value.adapter.createSavepoint({ capsule: value.capsule, source_workspace: value.source }),
    /case|collision/i,
  );
  assert.equal(value.mock.events.some((event) => event.type === 'create'), false);
});

test('sanitized export rejects special filesystem entries before provider allocation', {
  skip: process.platform === 'win32',
}, async (t) => {
  const value = await fixture(t);
  const socketPath = path.join(value.source, 'provider.sock');
  const server = net.createServer();
  try {
    await new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen(socketPath, resolve);
    });
    await assert.rejects(
      value.adapter.createSavepoint({ capsule: value.capsule, source_workspace: value.source }),
      /special filesystem entry/i,
    );
    assert.equal(value.mock.events.some((event) => event.type === 'create'), false);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

test('exact managed cleanup removes an immutable nested export without weakening it early', async (t) => {
  const value = await fixture(t);
  const savepoint = await value.adapter.createSavepoint({
    capsule: value.capsule,
    source_workspace: value.source,
  });
  const record = value.adapter.savepoints.get(savepoint.savepoint_ref);
  const exportId = record.export_record.export_id;
  const exportDirectory = workspaceExportPath(value.exportsDirectory, exportId);
  const payloadDirectory = path.join(exportDirectory, 'payload');
  const manifestPath = path.join(exportDirectory, 'manifest.json');

  if (process.platform !== 'win32') {
    assert.equal(Number((await lstat(exportDirectory)).mode) & 0o777, 0o500);
    assert.equal(Number((await lstat(payloadDirectory)).mode) & 0o777, 0o500);
    assert.equal(Number((await lstat(manifestPath)).mode) & 0o777, 0o400);
  }

  await destroyImmutableWorkspaceExport({
    export_root: value.exportsDirectory,
    export_id: exportId,
  });
  assert.equal(await verifyImmutableWorkspaceExportDestroyed({
    export_root: value.exportsDirectory,
    export_id: exportId,
  }), true);
  assert.deepEqual(await readdir(value.exportsDirectory), []);
});

test('managed cleanup refuses in-tree symlinks and preserves the outside sentinel', async (t) => {
  const value = await fixture(t);
  const savepoint = await value.adapter.createSavepoint({
    capsule: value.capsule,
    source_workspace: value.source,
  });
  const record = value.adapter.savepoints.get(savepoint.savepoint_ref);
  const exportId = record.export_record.export_id;
  const exportDirectory = workspaceExportPath(value.exportsDirectory, exportId);
  const payloadDirectory = path.join(exportDirectory, 'payload');
  const outside = path.join(value.root, 'outside-cleanup-sentinel');
  const sentinel = path.join(outside, 'sentinel.txt');
  const substitutedEntry = path.join(payloadDirectory, 'substituted-directory');
  await mkdir(outside);
  await writeFile(sentinel, 'must survive cleanup refusal\n');
  await chmod(exportDirectory, 0o700);
  await chmod(payloadDirectory, 0o700);
  await symlink(outside, substitutedEntry, process.platform === 'win32' ? 'junction' : 'dir');
  await chmod(payloadDirectory, 0o500);
  await chmod(exportDirectory, 0o500);

  await assert.rejects(
    destroyImmutableWorkspaceExport({
      export_root: value.exportsDirectory,
      export_id: exportId,
    }),
    /refuses symlinks/i,
  );
  assert.equal(await readFile(sentinel, 'utf8'), 'must survive cleanup refusal\n');
  if (process.platform !== 'win32') {
    assert.equal(Number((await lstat(exportDirectory)).mode) & 0o777, 0o500);
    assert.equal(Number((await lstat(payloadDirectory)).mode) & 0o777, 0o500);
  }

  await chmod(exportDirectory, 0o700);
  await chmod(payloadDirectory, 0o700);
  await rm(substitutedEntry, { force: true });
  await destroyImmutableWorkspaceExport({
    export_root: value.exportsDirectory,
    export_id: exportId,
  });
});

test('managed cleanup refuses hard links without changing the outside inode', async (t) => {
  const value = await fixture(t);
  const savepoint = await value.adapter.createSavepoint({
    capsule: value.capsule,
    source_workspace: value.source,
  });
  const record = value.adapter.savepoints.get(savepoint.savepoint_ref);
  const exportId = record.export_record.export_id;
  const exportDirectory = workspaceExportPath(value.exportsDirectory, exportId);
  const payloadDirectory = path.join(exportDirectory, 'payload');
  const outside = path.join(value.root, 'outside-hard-link-sentinel.txt');
  const injectedLink = path.join(payloadDirectory, 'injected-hard-link.txt');
  await writeFile(outside, 'outside hard-link inode remains unchanged\n');
  const outsideBefore = await lstat(outside);
  await chmod(exportDirectory, 0o700);
  await chmod(payloadDirectory, 0o700);
  await link(outside, injectedLink);
  await chmod(payloadDirectory, 0o500);
  await chmod(exportDirectory, 0o500);

  await assert.rejects(
    destroyImmutableWorkspaceExport({
      export_root: value.exportsDirectory,
      export_id: exportId,
    }),
    /refuses hard-linked files/i,
  );
  const outsideAfter = await lstat(outside);
  assert.equal(await readFile(outside, 'utf8'), 'outside hard-link inode remains unchanged\n');
  if (process.platform !== 'win32') {
    assert.equal(Number(outsideAfter.mode) & 0o777, Number(outsideBefore.mode) & 0o777);
    assert.equal(Number((await lstat(exportDirectory)).mode) & 0o777, 0o500);
    assert.equal(Number((await lstat(payloadDirectory)).mode) & 0o777, 0o500);
  }

  await chmod(exportDirectory, 0o700);
  await chmod(payloadDirectory, 0o700);
  await rm(injectedLink, { force: true });
  await destroyImmutableWorkspaceExport({
    export_root: value.exportsDirectory,
    export_id: exportId,
  });
});

test('managed cleanup refuses substituted targets, roots, and escaping export ids', async (t) => {
  const value = await fixture(t);
  const savepoint = await value.adapter.createSavepoint({
    capsule: value.capsule,
    source_workspace: value.source,
  });
  const record = value.adapter.savepoints.get(savepoint.savepoint_ref);
  const exportId = record.export_record.export_id;
  const exportDirectory = workspaceExportPath(value.exportsDirectory, exportId);
  const outside = path.join(value.root, 'outside-cleanup-target');
  const sentinel = path.join(outside, 'sentinel.txt');
  await mkdir(outside);
  await writeFile(sentinel, 'outside target remains intact\n');

  await destroyImmutableWorkspaceExport({
    export_root: value.exportsDirectory,
    export_id: exportId,
  });
  await symlink(outside, exportDirectory, process.platform === 'win32' ? 'junction' : 'dir');
  await assert.rejects(
    destroyImmutableWorkspaceExport({
      export_root: value.exportsDirectory,
      export_id: exportId,
    }),
    /substituted target/i,
  );
  await assert.rejects(
    verifyImmutableWorkspaceExportDestroyed({
      export_root: value.exportsDirectory,
      export_id: exportId,
    }),
    /substituted target/i,
  );
  assert.equal(await readFile(sentinel, 'utf8'), 'outside target remains intact\n');
  await rm(exportDirectory, { force: true });

  await rm(value.exportsDirectory, { recursive: true, force: true });
  await symlink(outside, value.exportsDirectory, process.platform === 'win32' ? 'junction' : 'dir');
  await assert.rejects(
    destroyImmutableWorkspaceExport({
      export_root: value.exportsDirectory,
      export_id: exportId,
    }),
    /cleanup root is not a real directory/i,
  );
  await assert.rejects(
    verifyImmutableWorkspaceExportDestroyed({
      export_root: value.exportsDirectory,
      export_id: exportId,
    }),
    /absence check root is not a real directory/i,
  );
  assert.equal(await readFile(sentinel, 'utf8'), 'outside target remains intact\n');
  await rm(value.exportsDirectory, { force: true });
  await mkdir(value.exportsDirectory);

  await assert.rejects(
    destroyImmutableWorkspaceExport({
      export_root: value.exportsDirectory,
      export_id: '../outside-cleanup-target',
    }),
    /letters, numbers, underscore, or dash/i,
  );
});
