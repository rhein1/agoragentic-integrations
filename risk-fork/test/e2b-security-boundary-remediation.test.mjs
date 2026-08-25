import assert from 'node:assert/strict';
import test from 'node:test';

import {
  E2BRiskForkAdapter,
  E2B_RISK_FORK_PATHS,
} from '../src/adapters/e2b.mjs';
import {
  NOW,
  hash,
  makeCapsule,
  makeForkIdentity,
} from './helpers.mjs';

const SECURE_PROFILE_UNAVAILABLE = 'E2B_SECURE_SNAPSHOT_PROFILE_UNAVAILABLE';
const TRUSTED_BOOTSTRAP_HASH = hash('trusted-bootstrap-artifact-v1');
const TRUSTED_RUNNER_HASH = hash('trusted-runner-artifact-v1');
const DEFAULT_WORKSPACE_DIGEST = hash('workspace');

function isSecureProfileUnavailable(error) {
  return error?.code === SECURE_PROFILE_UNAVAILABLE;
}

async function expectSecurityRejection(action, expectedMessage, failureMessage) {
  let error = null;
  try {
    await action();
  } catch (caught) {
    error = caught;
  }
  if (!error) assert.fail(failureMessage);
  if (isSecureProfileUnavailable(error)) return 'secure-profile-unavailable';
  assert.match(String(error.message), expectedMessage);
  return 'rejected';
}

function sourceEvidence(overrides = {}) {
  const workspaceDigest = overrides.workspace_digest ?? DEFAULT_WORKSPACE_DIGEST;
  const credentialFiles = overrides.credential_files ?? [];
  return {
    workspace_digest: workspaceDigest,
    workspace_manifest_hash: overrides.workspace_manifest_hash ?? hash({
      workspace_digest: workspaceDigest,
      credential_files: credentialFiles,
    }),
    process_manifest_hash: overrides.process_manifest_hash ?? hash([]),
    environment_manifest_hash: overrides.environment_manifest_hash ?? hash([]),
    socket_listener_manifest_hash: overrides.socket_listener_manifest_hash ?? hash([]),
    mount_manifest_hash: overrides.mount_manifest_hash ?? hash([]),
    credential_file_manifest_hash: overrides.credential_file_manifest_hash ?? hash(credentialFiles),
    credential_file_count: credentialFiles.length,
    quiesce_lease_id: overrides.quiesce_lease_id ?? 'lease:source-quiesced-v1',
    quiesce_lease_active: overrides.quiesce_lease_active ?? true,
  };
}

function authorityVerifier(events, overrides = {}) {
  return async (request) => {
    events.push({ type: 'authority-verify', request });
    const response = {
      schema: 'agoragentic.risk-fork.authority-free-source-attestation.v1',
      status: 'verified',
      request_hash: request.request_hash,
      evidence_ref: 'external-attestation:opaque',
      evidence_hash: hash('external-attestation-evidence'),
      trusted_bootstrap_artifact_hash: request.trusted_bootstrap_artifact_hash,
      trusted_runner_artifact_hash: request.trusted_runner_artifact_hash,
      claims: {
        authority_free: true,
        credentials_absent: true,
        wallet_material_absent: true,
        execution_authority_absent: true,
        untrusted_processes_absent: true,
        source_network_denied: true,
        entropy_rekey_required: true,
        trusted_runtime_artifacts_verified: true,
      },
      ...overrides,
    };

    // The audited implementation has a smaller request/response vocabulary.
    // Once the secure profile asks for closed source evidence, mirror every
    // required binding so the mock can exercise drift rather than force the
    // acceptable fail-closed outcome.
    if (Object.hasOwn(request, 'workspace_digest')) {
      Object.assign(response, {
        workspace_digest: request.workspace_digest,
        workspace_manifest_hash: request.workspace_manifest_hash,
        process_manifest_hash: request.process_manifest_hash,
        environment_manifest_hash: request.environment_manifest_hash,
        socket_listener_manifest_hash: request.socket_listener_manifest_hash,
        mount_manifest_hash: request.mount_manifest_hash,
        network_policy_hash: request.network_policy_hash,
        quiesce_lease_id: request.quiesce_lease_id,
        attested_at: NOW.toISOString(),
        expires_at: new Date(NOW.getTime() + 60_000).toISOString(),
      });
      response.claims = {
        ...response.claims,
        workspace_manifest_verified: true,
        process_manifest_verified: true,
        environment_manifest_verified: true,
        socket_listener_manifest_verified: true,
        mount_manifest_verified: true,
        source_quiesced: true,
      };
    }
    return response;
  };
}

function boundRunnerResult(job, metadata, overrides = {}) {
  const commitCandidate = {
    kind: 'TYPED_RESULT',
    result: { answer: 'bounded-result' },
  };
  return {
    schema: 'agoragentic.risk-fork.runner-result.v1',
    status: 'completed',
    job_id: job.job_id,
    job_hash: job.job_hash ?? hash(job),
    capsule_hash: job.capsule_hash,
    identity_hash: job.identity_hash,
    network_policy_hash: job.network_policy_hash,
    operation_hash: job.operation_hash ?? hash(job.operation),
    execution_mode: job.execution_mode,
    trusted_runner_artifact_hash:
      metadata?.['agoragentic.risk_fork.runner_artifact_hash'] ?? TRUSTED_RUNNER_HASH,
    expected_result_schema_hash: job.expected_result_schema_hash ?? hash('result-schema'),
    commit_candidate: commitCandidate,
    commit_candidate_hash: hash(commitCandidate),
    ...overrides,
  };
}

function bootstrapAttestation({ child, files, createOptions, claims = {} }) {
  const payload = JSON.parse(files.get(E2B_RISK_FORK_PATHS.identity));
  const normalizedClaims = {
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
    workspace_root_verified: true,
    trusted_runtime_artifacts_verified: true,
    ...claims,
  };
  const attestation = {
    schema: 'agoragentic.risk-fork.child-bootstrap-attestation.v1',
    status: Object.values(normalizedClaims).every((value) => value === true)
      ? 'verified'
      : 'failed',
    child_sandbox_id_hash: hash(child.sandboxId),
    capsule_hash: payload.capsule_hash,
    identity_hash: payload.fork_identity.identity_hash,
    network_policy_hash: payload.network_policy_hash,
    workspace_digest: DEFAULT_WORKSPACE_DIGEST,
    trusted_bootstrap_artifact_hash:
      createOptions.metadata['agoragentic.risk_fork.bootstrap_artifact_hash'],
    trusted_runner_artifact_hash:
      createOptions.metadata['agoragentic.risk_fork.runner_artifact_hash'],
    attested_at: NOW.toISOString(),
    expires_at: new Date(NOW.getTime() + 60_000).toISOString(),
    claims: normalizedClaims,
  };
  attestation.attestation_hash = hash(attestation);
  return attestation;
}

function resultPathFrom(command, jobPath, job) {
  if (typeof job?.result_path === 'string') return job.result_path;
  const match = /--result(?:=|\s+)(?:"([^"]+)"|'([^']+)'|(\S+))/.exec(command);
  if (match) return match[1] ?? match[2] ?? match[3];
  if (jobPath && jobPath !== E2B_RISK_FORK_PATHS.job) {
    return jobPath.replace(/job(?:\.json)?$/i, 'result.json');
  }
  return E2B_RISK_FORK_PATHS.result;
}

function createMockSdk(options = {}) {
  const events = [];
  const files = new Map();
  const snapshots = new Set();
  const source = { sandboxId: 'source-sandbox-security-test' };
  let sourceReads = 0;
  let childKilled = false;
  let createOptions = null;
  let currentJob = null;
  let currentJobPath = null;

  if (options.staleAnyResult) {
    files.set(E2B_RISK_FORK_PATHS.result, JSON.stringify({
      schema: 'agoragentic.risk-fork.runner-result.v1',
      status: 'completed',
      job_id: 'rfj_stale_previous_execution',
      commit_candidate: { kind: 'TYPED_RESULT', result: { answer: 'stale' } },
    }));
  }

  const child = {
    sandboxId: 'child-sandbox-security-test',
    files: {
      async write(path, content, writeOptions = {}) {
        events.push({ type: 'file-write', path, content, options: writeOptions });
        if ((writeOptions.exclusive === true || writeOptions.flag === 'wx') && files.has(path)) {
          const error = new Error('file already exists');
          error.code = 'EEXIST';
          throw error;
        }
        files.set(path, content);
        try {
          const parsed = JSON.parse(content);
          if (parsed?.schema === 'agoragentic.risk-fork.runner-job.v1') {
            currentJob = parsed;
            currentJobPath = path;
          }
        } catch {
          // The adapter owns validation; the mock only discovers job envelopes.
        }
      },
      async read(path) {
        events.push({ type: 'file-read', path });
        if (files.has(path)) return files.get(path);
        if (options.staleAnyResult && /result/i.test(path)) {
          return files.get(E2B_RISK_FORK_PATHS.result);
        }
        return undefined;
      },
      async exists(path) {
        events.push({ type: 'file-exists', path });
        return files.has(path) || (options.staleAnyResult && /result/i.test(path));
      },
      async stat(path) {
        events.push({ type: 'file-stat', path });
        if (files.has(path) || (options.staleAnyResult && /result/i.test(path))) {
          return { size: Buffer.byteLength(files.get(path) ?? '', 'utf8') };
        }
        const error = new Error('not found');
        error.code = 'ENOENT';
        throw error;
      },
      async remove(path) {
        events.push({ type: 'file-remove', path });
        files.delete(path);
      },
      async rename(from, to) {
        events.push({ type: 'file-rename', from, to });
        if (!files.has(from)) throw new Error('rename source missing');
        files.set(to, files.get(from));
        files.delete(from);
      },
    },
    commands: {
      async run(command, commandOptions) {
        events.push({ type: 'command', command, options: commandOptions });
        if (command.includes('trusted-bootstrap')) {
          const attestation = bootstrapAttestation({
            child,
            files,
            createOptions,
            claims: options.postBootClaimOverrides,
          });
          return {
            exitCode: 0,
            stdout: JSON.stringify(attestation),
            stderr: '',
            attestation,
          };
        }
        if (!options.runnerNoWrite) {
          const runnerResult = options.runnerResultFactory
            ? options.runnerResultFactory(currentJob, createOptions?.metadata)
            : boundRunnerResult(currentJob, createOptions?.metadata);
          const resultPath = resultPathFrom(command, currentJobPath, currentJob);
          files.set(resultPath, JSON.stringify(runnerResult));
        }
        return { exitCode: 0, stdout: '', stderr: '' };
      },
    },
    async kill() {
      events.push({ type: 'kill-child' });
      childKilled = true;
    },
    async pause() {
      events.push({ type: 'pause-child' });
      return true;
    },
  };

  class Sandbox {
    static async getInfo(sandboxId) {
      events.push({ type: 'get-info', sandboxId });
      if (sandboxId === source.sandboxId) {
        sourceReads += 1;
        const afterAttestation = sourceReads > 1;
        const evidence = afterAttestation
          ? sourceEvidence(options.sourceEvidenceAfterAttestation)
          : sourceEvidence(options.sourceEvidenceBeforeAttestation);
        const info = {
          sandboxId,
          state: 'running',
          allowInternetAccess: false,
          network: { allowOut: [] },
          riskForkEvidence: evidence,
        };
        if (!options.omitSourceVolumeMounts) {
          info.volumeMounts = options.sourceVolumeMounts ?? [];
        }
        return info;
      }
      if (sandboxId === child.sandboxId) {
        if (childKilled) {
          const error = new Error('not found');
          error.status = 404;
          throw error;
        }
        const info = {
          sandboxId,
          state: 'running',
          allowInternetAccess: false,
          network: { allowOut: [] },
          lifecycle: { onTimeout: 'kill', autoResume: false },
          metadata: createOptions?.metadata ?? {},
          endAt: new Date(NOW.getTime() + (createOptions?.timeoutMs ?? 60_000)),
          riskForkEvidence: {
            workspace_digest: DEFAULT_WORKSPACE_DIGEST,
            process_manifest_hash: hash([]),
            environment_manifest_hash: hash([]),
            socket_listener_manifest_hash: hash([]),
            mount_manifest_hash: hash([]),
          },
        };
        if (!options.omitChildVolumeMounts) {
          info.volumeMounts = options.childVolumeMounts ?? [];
        }
        return info;
      }
      const error = new Error('not found');
      error.status = 404;
      throw error;
    }

    static async createSnapshot(sandboxId, snapshotOptions) {
      events.push({ type: 'create-snapshot', sandboxId, options: snapshotOptions });
      snapshots.add('snapshot-security-test');
      return {
        snapshotId: 'snapshot-security-test',
        mode: snapshotOptions?.filesystemOnly === true
          ? 'filesystem'
          : 'filesystem_and_memory',
      };
    }

    static async create(snapshotId, sdkOptions) {
      events.push({ type: 'create-child', snapshotId, options: sdkOptions });
      createOptions = sdkOptions;
      return child;
    }

    static async deleteSnapshot(snapshotId) {
      events.push({ type: 'delete-snapshot', snapshotId });
      return snapshots.delete(snapshotId);
    }

    static listSnapshots() {
      let delivered = false;
      return {
        get hasNext() {
          return !delivered;
        },
        async nextItems() {
          delivered = true;
          return [...snapshots].map((snapshotId) => ({ snapshotId }));
        },
      };
    }
  }

  return {
    Sandbox,
    child,
    events,
    files,
    source,
    get createOptions() {
      return createOptions;
    },
  };
}

function createAdapter(mock, verifier = authorityVerifier(mock.events)) {
  return new E2BRiskForkAdapter({
    SandboxClass: mock.Sandbox,
    offlineConformance: true,
    verifyAuthorityFreeSource: verifier,
    bootstrapCommand: 'trusted-bootstrap',
    runnerCommand: 'trusted-runner',
    trustedBootstrapArtifactHash: TRUSTED_BOOTSTRAP_HASH,
    trustedRunnerArtifactHash: TRUSTED_RUNNER_HASH,
    clock: () => new Date(NOW),
  });
}

async function createSavepointOrUnavailable(mock, capsule = makeCapsule()) {
  const adapter = createAdapter(mock);
  try {
    const savepoint = await adapter.createSavepoint({
      capsule,
      source_sandbox_id: mock.source.sandboxId,
    });
    return { adapter, capsule, savepoint, unavailable: false };
  } catch (error) {
    if (!isSecureProfileUnavailable(error)) throw error;
    return { adapter, capsule, error, unavailable: true };
  }
}

async function prepareForkOrUnavailable(mock, capsule = makeCapsule()) {
  const prepared = await createSavepointOrUnavailable(mock, capsule);
  if (prepared.unavailable) return prepared;
  const identity = makeForkIdentity(capsule);
  try {
    const fork = await prepared.adapter.createFork({
      savepoint_ref: prepared.savepoint.savepoint_ref,
      fork_identity: identity,
      network_policy: { mode: 'blocked', allowlist: [] },
      ttl_ms: 60_000,
    });
    return { ...prepared, fork, identity };
  } catch (error) {
    if (!isSecureProfileUnavailable(error)) throw error;
    return { ...prepared, error, unavailable: true };
  }
}

test('secure E2B profile rejects full filesystem-and-memory snapshots or fails closed explicitly', async () => {
  const mock = createMockSdk();
  const prepared = await createSavepointOrUnavailable(mock);
  if (prepared.unavailable) {
    assert.equal(prepared.error.code, SECURE_PROFILE_UNAVAILABLE);
    return;
  }

  assert.notEqual(
    prepared.savepoint.runtime_snapshot.mode,
    'filesystem_and_memory',
    'the Risk Fork secure profile must never restore source memory or processes',
  );
  const snapshotEvent = mock.events.find((event) => event.type === 'create-snapshot');
  if (snapshotEvent) {
    assert.equal(
      snapshotEvent.options?.filesystemOnly,
      true,
      'a provider snapshot used by the secure profile must be explicitly filesystem-only',
    );
  }
});

test('source observation requires explicit zero-volume evidence', async (t) => {
  await t.test('missing volumeMounts fails closed', async () => {
    const mock = createMockSdk({ omitSourceVolumeMounts: true });
    const adapter = createAdapter(mock);
    await expectSecurityRejection(
      () => adapter.createSavepoint({ capsule: makeCapsule(), source_sandbox_id: mock.source.sandboxId }),
      /volumeMounts|mount evidence|zero (?:persistent )?mounts/i,
      'a source without mount evidence was snapshotted',
    );
    assert.equal(mock.events.some((event) => event.type === 'create-snapshot'), false);
  });

  await t.test('a persistent source mount fails closed', async () => {
    const mock = createMockSdk({
      sourceVolumeMounts: [{ name: 'parent-authority-volume', mountPoint: '/mnt/authority' }],
    });
    const adapter = createAdapter(mock);
    await expectSecurityRejection(
      () => adapter.createSavepoint({ capsule: makeCapsule(), source_sandbox_id: mock.source.sandboxId }),
      /volumeMounts|persistent mount|zero mounts/i,
      'a persistently mounted source was snapshotted',
    );
    assert.equal(mock.events.some((event) => event.type === 'create-snapshot'), false);
  });
});

test('child observation requires explicit zero-volume evidence', async (t) => {
  for (const scenario of [
    { name: 'missing volumeMounts', options: { omitChildVolumeMounts: true } },
    {
      name: 'persistent child mount',
      options: { childVolumeMounts: [{ name: 'shared-state', mountPoint: '/mnt/shared' }] },
    },
  ]) {
    await t.test(scenario.name, async () => {
      const mock = createMockSdk(scenario.options);
      const prepared = await createSavepointOrUnavailable(mock);
      if (prepared.unavailable) {
        assert.equal(prepared.error.code, SECURE_PROFILE_UNAVAILABLE);
        return;
      }
      await expectSecurityRejection(
        () => prepared.adapter.createFork({
          savepoint_ref: prepared.savepoint.savepoint_ref,
          fork_identity: makeForkIdentity(prepared.capsule),
          network_policy: { mode: 'blocked', allowlist: [] },
          ttl_ms: 60_000,
        }),
        /volumeMounts|persistent mount|zero mounts/i,
        `a child with ${scenario.name} reached bootstrap`,
      );
      assert.equal(
        mock.events.some((event) => event.type === 'command' && event.command.includes('trusted-bootstrap')),
        false,
      );
    });
  }
});

test('child creation explicitly requests zero persistent mounts', async () => {
  const mock = createMockSdk();
  const prepared = await prepareForkOrUnavailable(mock);
  if (prepared.unavailable) {
    assert.equal(prepared.error.code, SECURE_PROFILE_UNAVAILABLE);
    return;
  }
  assert.ok(
    Object.hasOwn(mock.createOptions, 'volumeMounts'),
    'the child birth request must not rely on a provider default for persistent mounts',
  );
  assert.deepEqual(mock.createOptions.volumeMounts, []);
});

test('source attestation binds the capsule workspace digest and immutable source manifests', async () => {
  const capsule = makeCapsule();
  const mock = createMockSdk();
  const prepared = await createSavepointOrUnavailable(mock, capsule);
  if (prepared.unavailable) {
    assert.equal(prepared.error.code, SECURE_PROFILE_UNAVAILABLE);
    return;
  }
  const request = mock.events.find((event) => event.type === 'authority-verify')?.request;
  assert.ok(request, 'the source verifier was not called');
  assert.equal(request.workspace_digest, capsule.workspace.digest);
  for (const field of [
    'workspace_manifest_hash',
    'process_manifest_hash',
    'environment_manifest_hash',
    'socket_listener_manifest_hash',
    'mount_manifest_hash',
  ]) {
    assert.match(request[field], /^sha256:[a-f0-9]{64}$/, `${field} must be hash-bound`);
  }
  assert.equal(typeof request.quiesce_lease_id, 'string');
  assert.ok(request.quiesce_lease_id.length > 0);
});

test('workspace digest drift after attestation rejects snapshot/export', async () => {
  const capsule = makeCapsule();
  const mock = createMockSdk({
    sourceEvidenceBeforeAttestation: { workspace_digest: capsule.workspace.digest },
    sourceEvidenceAfterAttestation: { workspace_digest: hash('mutated-workspace') },
  });
  const adapter = createAdapter(mock);
  await expectSecurityRejection(
    () => adapter.createSavepoint({ capsule, source_sandbox_id: mock.source.sandboxId }),
    /workspace|manifest|drift|changed|immutable|quiesce lease/i,
    'workspace drift after attestation was captured in the savepoint',
  );
  assert.equal(mock.events.some((event) => event.type === 'create-snapshot'), false);
});

test('a credential file introduced after attestation rejects snapshot/export', async () => {
  const mock = createMockSdk({
    sourceEvidenceBeforeAttestation: { credential_files: [] },
    sourceEvidenceAfterAttestation: { credential_files: ['.config/provider/credential.json'] },
  });
  const adapter = createAdapter(mock);
  await expectSecurityRejection(
    () => adapter.createSavepoint({ capsule: makeCapsule(), source_sandbox_id: mock.source.sandboxId }),
    /credential|workspace|manifest|drift|changed|quiesce lease/i,
    'a credential-bearing mutation after attestation was captured in the savepoint',
  );
  assert.equal(mock.events.some((event) => event.type === 'create-snapshot'), false);
});

test('post-boot attestation rejects inherited process, environment, socket, and credential evidence', async (t) => {
  const cases = [
    ['inherited parent process', { inherited_parent_processes_absent: false }],
    ['environment authority', { unauthorized_environment_absent: false }],
    ['inherited listener or socket', { unauthorized_sockets_absent: false }],
    ['credential-shaped file', { credential_files_absent: false }],
  ];
  for (const [name, postBootClaimOverrides] of cases) {
    await t.test(name, async () => {
      const mock = createMockSdk({ postBootClaimOverrides });
      const prepared = await createSavepointOrUnavailable(mock);
      if (prepared.unavailable) {
        assert.equal(prepared.error.code, SECURE_PROFILE_UNAVAILABLE);
        return;
      }
      await expectSecurityRejection(
        () => prepared.adapter.createFork({
          savepoint_ref: prepared.savepoint.savepoint_ref,
          fork_identity: makeForkIdentity(prepared.capsule),
          network_policy: { mode: 'blocked', allowlist: [] },
          ttl_ms: 60_000,
        }),
        /post-boot|bootstrap|inherited|environment|credential|socket|listener|authority/i,
        `${name} survived the trusted bootstrap boundary`,
      );
    });
  }
});

test('direct E2B adapter applies the shared child-operation authority gate before upload', async () => {
  const mock = createMockSdk();
  const adapter = createAdapter(mock);
  const jobWritesBefore = mock.events.filter((event) => {
    if (event.type !== 'file-write') return false;
    try {
      return JSON.parse(event.content)?.schema === 'agoragentic.risk-fork.runner-job.v1';
    } catch {
      return false;
    }
  }).length;

  await expectSecurityRejection(
    () => adapter.executeInFork({
      fork_ref: 'unavailable-fork:authority-boundary-test',
      execution_mode: 'isolated_execution',
      operation: {
        kind: 'analyze',
        controls: { can_spend: true },
      },
    }),
    /authority or secret-bearing field/i,
    'a can_spend authority flag crossed the public E2B adapter boundary',
  );

  const jobWritesAfter = mock.events.filter((event) => {
    if (event.type !== 'file-write') return false;
    try {
      return JSON.parse(event.content)?.schema === 'agoragentic.risk-fork.runner-job.v1';
    } catch {
      return false;
    }
  }).length;
  assert.equal(jobWritesAfter, jobWritesBefore, 'authority-bearing input was uploaded before rejection');
});

test('a stale preseeded result cannot satisfy a new E2B job', async () => {
  const mock = createMockSdk({ staleAnyResult: true, runnerNoWrite: true });
  const prepared = await prepareForkOrUnavailable(mock);
  if (prepared.unavailable) {
    assert.equal(prepared.error.code, SECURE_PROFILE_UNAVAILABLE);
    return;
  }
  await expectSecurityRejection(
    () => prepared.adapter.executeInFork({
      fork_ref: prepared.fork.fork_ref,
      execution_mode: 'isolated_execution',
      operation: { kind: 'analyze', subject_ref: 'opaque:stale-result-test' },
    }),
    /stale|preseed|result.*exist|job.*mismatch|result.*binding/i,
    'a stale result file satisfied a new execution',
  );
});

test('E2B result transport rejects every wrong exact-job binding', async (t) => {
  const wrongBindings = [
    ['job id', { job_id: 'rfj_wrong_job' }],
    ['job hash', { job_hash: hash('wrong-job-hash') }],
    ['capsule hash', { capsule_hash: hash('wrong-capsule') }],
    ['fork identity hash', { identity_hash: hash('wrong-identity') }],
    ['network policy hash', { network_policy_hash: hash('wrong-network-policy') }],
    ['operation hash', { operation_hash: hash('wrong-operation') }],
    ['runner artifact hash', { trusted_runner_artifact_hash: hash('wrong-runner') }],
  ];

  for (const [name, overrides] of wrongBindings) {
    await t.test(name, async () => {
      const mock = createMockSdk({
        runnerResultFactory(job, metadata) {
          return boundRunnerResult(job, metadata, overrides);
        },
      });
      const prepared = await prepareForkOrUnavailable(mock);
      if (prepared.unavailable) {
        assert.equal(prepared.error.code, SECURE_PROFILE_UNAVAILABLE);
        return;
      }
      await expectSecurityRejection(
        () => prepared.adapter.executeInFork({
          fork_ref: prepared.fork.fork_ref,
          execution_mode: 'isolated_execution',
          operation: { kind: 'analyze', subject_ref: `opaque:${name.replaceAll(' ', '-')}` },
        }),
        /job|capsule|identity|network|operation|runner|binding|mismatch/i,
        `a result with the wrong ${name} was accepted`,
      );
    });
  }
});
