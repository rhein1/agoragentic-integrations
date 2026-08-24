import assert from 'node:assert/strict';
import {
  chmod,
  link,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  rename,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { canonicalize, sha256Ref } from '../src/canonical.mjs';
import {
  EMPTY_RUNTIME_WORKSPACE_DIGEST,
  E2B_BIRTH_RUNTIME_DIRECTORY,
  E2B_BOOT_EVIDENCE_PATH,
  E2B_BOOT_READY_PATH,
  E2B_TEMPLATE_BUILD_READY_PATH,
  createBootEvidenceEnvelope,
  createE2BBirthRequest,
  e2bBirthRequestPaths,
  inspectRuntimeWorkspace,
  sha256FileRef,
  validateE2BBirthAttestation,
} from '../e2b-template/lib/runtime-contract.mjs';
import { runBootstrap } from '../e2b-template/bin/bootstrap.mjs';
import {
  classifyLiteralProbeOutcome,
  inspectProcessEnvironmentBytes,
  runBirthWatcher,
} from '../e2b-template/bin/boot-guard.mjs';
import {
  parseRunnerTransportPaths,
  runRunnerJob,
} from '../e2b-template/bin/run.mjs';
import { createRiskForkE2BTemplate } from '../e2b-template/template.mjs';
import { makeCapsule, makeForkIdentity } from './helpers.mjs';

function fakeTemplateSdk() {
  const calls = [];
  const builder = new Proxy({}, {
    get(_target, property) {
      return (...args) => {
        calls.push([String(property), ...args]);
        return builder;
      };
    },
  });
  return {
    calls,
    Template(options) {
      calls.push(['Template', options]);
      return builder;
    },
    waitForFile(file) {
      calls.push(['waitForFile', file]);
      return { ready: file };
    },
  };
}

test('template definition is pure, Node 24, root-owned, non-root at runtime, and creates no captured birth state', () => {
  const sdk = fakeTemplateSdk();
  const template = createRiskForkE2BTemplate({
    Template: sdk.Template,
    waitForFile: sdk.waitForFile,
    contextRoot: 'C:/reviewed/context',
  });
  assert.ok(template);
  assert.deepEqual(sdk.calls.find(([name]) => name === 'fromNodeImage'), ['fromNodeImage', '24']);
  assert.ok(sdk.calls.some(([name, value]) => name === 'setUser' && value === 'root'));
  assert.deepEqual(sdk.calls.filter(([name]) => name === 'setUser').at(-1), ['setUser', 'user']);
  const makeDir = sdk.calls.find(([name]) => name === 'makeDir');
  assert.equal(
    makeDir[1].includes(E2B_BIRTH_RUNTIME_DIRECTORY),
    false,
    'ephemeral birth state must not be captured in the image',
  );
  const rootRun = sdk.calls.find(([name]) => name === 'runCmd');
  assert.equal(rootRun[2].user, 'root');
  assert.deepEqual(rootRun[1].slice(-2), [
    'chown user:user /workspace/agoragentic-risk-fork-v1',
    'chmod 0700 /workspace/agoragentic-risk-fork-v1',
  ]);
  assert.equal(
    rootRun[1].some((command) => command.includes(E2B_BIRTH_RUNTIME_DIRECTORY)),
    false,
    'the one-use birth directory must be created only by the runtime watcher',
  );
  const start = sdk.calls.find(([name]) => name === 'setStartCmd');
  assert.equal(
    start[1],
    '/usr/bin/env -i HOME=/home/user USER=user LOGNAME=user SHELL=/bin/sh PATH=/usr/local/bin:/usr/bin:/bin node /opt/agoragentic/risk-fork/e2b-template/bin/boot-guard.mjs',
    'the Node image executable must resolve from the sanitized PATH before boot-guard',
  );
  assert.doesNotMatch(
    start[1],
    /(?:^|\s)\/\S*\/node(?:\s|$)/,
    'an image-specific hard-coded Node executable can be absent even when node is on PATH',
  );
  assert.equal(start[2].ready, E2B_TEMPLATE_BUILD_READY_PATH);
  assert.equal(sdk.calls.some(([name]) => name === 'build'), false, 'definition must not build on import');
});

test('every birth handshake path uses the fixed one-use runtime root and source has no legacy /run literal', async () => {
  assert.equal(E2B_BIRTH_RUNTIME_DIRECTORY, '/tmp/agoragentic-risk-fork-v1.birth');
  const requestPaths = e2bBirthRequestPaths(sha256Ref('fixed-runtime-root'));
  for (const target of [
    E2B_TEMPLATE_BUILD_READY_PATH,
    E2B_BOOT_EVIDENCE_PATH,
    E2B_BOOT_READY_PATH,
    ...Object.values(requestPaths),
  ]) {
    assert.equal(path.posix.dirname(target), E2B_BIRTH_RUNTIME_DIRECTORY);
  }
  const sources = await Promise.all([
    '../e2b-template/template.mjs',
    '../e2b-template/bin/boot-guard.mjs',
    '../e2b-template/bin/bootstrap.mjs',
    '../e2b-template/lib/runtime-contract.mjs',
  ].map((relative) => readFile(new URL(relative, import.meta.url), 'utf8')));
  assert.doesNotMatch(sources.join('\n'), /\/run\/agoragentic-risk-fork/);
});

async function waitForPath(target) {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    try {
      return await readFile(target);
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error;
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
  }
  throw new Error(`timed out waiting for ${target}`);
}

function birthRequest(overrides = {}) {
  return createE2BBirthRequest({
    sandbox_id_hash: sha256Ref('sandbox-birth-1'),
    provider_metadata_hash: sha256Ref({ profile: 'clean' }),
    template_id_hash: sha256Ref('template-birth-1'),
    template_evidence_hash: sha256Ref('template-evidence-birth-1'),
    template_provenance_hash: sha256Ref('template-provenance-birth-1'),
    allocation_started_at: '2030-01-01T00:00:00.000Z',
    expires_at: '2030-01-01T00:00:20.000Z',
    birth_nonce: 'birth-nonce-1234567890',
    ...overrides,
  });
}

function bootEvidenceForRequest(request, observedAt = '2030-01-01T00:00:01.000Z') {
  return createBootEvidenceEnvelope({
    observed_at: observedAt,
    expires_at: '2030-01-01T00:05:00.000Z',
    boot_nonce: request.birth_nonce,
    boot_id_hash: sha256Ref('birth-boot-id'),
    entropy_hash: sha256Ref('birth-entropy'),
    bootstrap_artifact_hash: sha256Ref('birth-bootstrap'),
    runner_artifact_hash: sha256Ref('birth-runner'),
    measurements: {
      environment_key_count: 4,
      process_count: 2,
      socket_count: 0,
      mount_count: 12,
      credential_path_count: 0,
    },
    observation_hashes: {
      environment_keys_hash: sha256Ref(['HOME', 'PATH', 'USER', '_']),
      processes_hash: sha256Ref(['watcher']),
      sockets_hash: sha256Ref([]),
      mounts_hash: sha256Ref(['mounts']),
      credential_paths_hash: sha256Ref([]),
      ipv4_probe_hash: sha256Ref('ipv4-locally-denied'),
      ipv6_probe_hash: sha256Ref('ipv6-locally-denied'),
    },
    claims: {
      inherited_parent_processes_absent: false,
      unauthorized_environment_absent: false,
      credential_files_absent: false,
      wallet_signing_material_absent: false,
      inherited_authority_records_absent: false,
      persistent_mounts_absent: false,
      unauthorized_sockets_absent: false,
      first_instruction_ipv4_egress_denied: false,
      first_instruction_ipv6_egress_denied: false,
      fresh_entropy_verified: false,
      trusted_runtime_artifacts_verified: false,
    },
  });
}

test('captured birth watcher stays network-silent until one canonical post-allocation request', async (t) => {
  const runtimeRoot = await mkdtemp(path.join(os.tmpdir(), 'risk-fork-e2b-birth-'));
  const runtimeDirectory = path.join(runtimeRoot, 'fresh-birth');
  t.after(() => rm(runtimeRoot, { recursive: true, force: true }));
  const request = birthRequest();
  let collectCalls = 0;
  const watcher = runBirthWatcher({
    runtimeDirectory,
    clock: () => new Date('2030-01-01T00:00:01.000Z'),
    collectEvidence: async ({ bootNonce }) => {
      collectCalls += 1;
      assert.equal(bootNonce, request.birth_nonce);
      return bootEvidenceForRequest(request);
    },
    requestWaitTimeoutMs: 1_000,
  });
  const buildReady = await waitForPath(path.join(runtimeDirectory, 'template-build-ready'));
  const runtimeInfo = await lstat(runtimeDirectory);
  assert.equal(runtimeInfo.isDirectory(), true);
  if (process.platform !== 'win32') {
    assert.equal(runtimeInfo.uid, process.getuid());
    assert.equal(runtimeInfo.gid, process.getgid());
    assert.equal(runtimeInfo.mode & 0o7777, 0o700);
  }
  assert.equal(collectCalls, 0, 'build finalization must not collect boot or network evidence');
  assert.deepEqual(JSON.parse(buildReady.toString('utf8')), {
    build_only: true,
    evidence_trust: 'untrusted_same_uid_self_assertion',
    network_observation_performed: false,
    production_authority_included: false,
    schema: 'agoragentic.risk-fork.e2b-template-build-ready.v1',
    status: 'captured_watcher_waiting',
  });
  const remotePaths = e2bBirthRequestPaths(request.request_hash);
  const requestPath = path.join(runtimeDirectory, path.posix.basename(remotePaths.request));
  const triggerPath = path.join(runtimeDirectory, path.posix.basename(remotePaths.trigger));
  await writeFile(requestPath, `${canonicalize(request)}\n`);
  assert.equal(collectCalls, 0, 'an incomplete request cannot trigger evidence collection');
  await writeFile(triggerPath, `${request.request_hash}\n`);
  const result = await watcher;
  assert.equal(collectCalls, 1);
  assert.equal(result.bootEvidence.boot_nonce, request.birth_nonce);
  assert.equal(result.attestation.birth_request_hash, request.request_hash);
  assert.equal(result.attestation.status, 'untrusted_observation');
  assert.equal(result.attestation.trust_status, 'untrusted_same_uid_self_assertion');
  assert.equal(result.attestation.claims.privileged_producer_verified, false);
  assert.equal(
    result.attestation.boot_evidence_hash,
    result.bootEvidence.evidence_hash,
  );
  assert.equal(
    Date.parse(result.attestation.observed_at) >= Date.parse(request.allocation_started_at),
    true,
  );
  assert.equal(
    (await readFile(path.join(runtimeDirectory, 'birth-ready'), 'utf8')).trim(),
    result.attestation.attestation_hash,
  );
  assert.deepEqual(
    validateE2BBirthAttestation(result.attestation, {
      request,
      bootEvidence: result.bootEvidence,
      bootstrapArtifactHash: sha256Ref('birth-bootstrap'),
      runnerArtifactHash: sha256Ref('birth-runner'),
      now: '2030-01-01T00:00:01.000Z',
    }),
    result.attestation,
  );
});

test('birth watcher fails closed on expired, preexisting, and replayed state', async (t) => {
  const expiredRoot = await mkdtemp(path.join(os.tmpdir(), 'risk-fork-e2b-expired-'));
  const expiredDirectory = path.join(expiredRoot, 'fresh-birth');
  const preexistingDirectory = await mkdtemp(path.join(os.tmpdir(), 'risk-fork-e2b-preexisting-'));
  t.after(() => Promise.all([
    rm(expiredRoot, { recursive: true, force: true }),
    rm(preexistingDirectory, { recursive: true, force: true }),
  ]));

  const expired = birthRequest({ expires_at: '2030-01-01T00:00:01.000Z' });
  const expiredWatcher = runBirthWatcher({
    runtimeDirectory: expiredDirectory,
    clock: () => new Date('2030-01-01T00:00:02.000Z'),
    collectEvidence: async () => {
      throw new Error('expired request must not collect evidence');
    },
    requestWaitTimeoutMs: 1_000,
  });
  await waitForPath(path.join(expiredDirectory, 'template-build-ready'));
  const expiredPaths = e2bBirthRequestPaths(expired.request_hash);
  await writeFile(
    path.join(expiredDirectory, path.posix.basename(expiredPaths.request)),
    `${canonicalize(expired)}\n`,
  );
  await writeFile(
    path.join(expiredDirectory, path.posix.basename(expiredPaths.trigger)),
    `${expired.request_hash}\n`,
  );
  await assert.rejects(expiredWatcher, /expired|validity|outside/i);

  await assert.rejects(
    runBirthWatcher({ runtimeDirectory: preexistingDirectory, requestWaitTimeoutMs: 10 }),
    /preexisting runtime state/i,
    'an empty preexisting runtime directory is never reused',
  );
  await writeFile(path.join(preexistingDirectory, 'birth-request.preexisting.json'), '{}\n');
  await assert.rejects(
    runBirthWatcher({ runtimeDirectory: preexistingDirectory, requestWaitTimeoutMs: 10 }),
    /preexisting runtime state/i,
    'nonempty preexisting runtime state is never reused',
  );
  await assert.rejects(
    runBirthWatcher({ runtimeDirectory: expiredDirectory, requestWaitTimeoutMs: 10 }),
    /preexisting runtime state/i,
    'a consumed or failed request cannot be replayed through a restarted watcher',
  );
});

test('birth watcher rejects file, symlink, and symlink-parent runtime targets', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'risk-fork-e2b-runtime-target-'));
  t.after(() => rm(root, { recursive: true, force: true }));

  const fileTarget = path.join(root, 'file-target');
  await writeFile(fileTarget, 'occupied\n');
  await assert.rejects(
    runBirthWatcher({ runtimeDirectory: fileTarget, requestWaitTimeoutMs: 10 }),
    /preexisting runtime state/i,
  );

  const realTarget = path.join(root, 'real-target');
  const linkedTarget = path.join(root, 'linked-target');
  const realParent = path.join(root, 'real-parent');
  const linkedParent = path.join(root, 'linked-parent');
  await mkdir(realTarget);
  await mkdir(realParent);
  try {
    await symlink(realTarget, linkedTarget, process.platform === 'win32' ? 'junction' : 'dir');
    await symlink(realParent, linkedParent, process.platform === 'win32' ? 'junction' : 'dir');
  } catch (error) {
    if (error?.code === 'EPERM') {
      t.diagnostic('directory symlinks are unavailable on this Windows host');
      return;
    }
    throw error;
  }
  await assert.rejects(
    runBirthWatcher({ runtimeDirectory: linkedTarget, requestWaitTimeoutMs: 10 }),
    /preexisting runtime state/i,
  );
  await assert.rejects(
    runBirthWatcher({
      runtimeDirectory: path.join(linkedParent, 'fresh-birth'),
      requestWaitTimeoutMs: 10,
    }),
    /parent.*real directory|parent.*canonical/i,
  );
});

test('birth watcher rejects hard-linked request state before collecting evidence', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'risk-fork-e2b-hardlink-'));
  const runtimeDirectory = path.join(root, 'fresh-birth');
  t.after(() => rm(root, { recursive: true, force: true }));
  const request = birthRequest();
  let collectCalls = 0;
  const watcher = runBirthWatcher({
    runtimeDirectory,
    clock: () => new Date('2030-01-01T00:00:01.000Z'),
    collectEvidence: async () => {
      collectCalls += 1;
      return bootEvidenceForRequest(request);
    },
    requestWaitTimeoutMs: 1_000,
  });
  await waitForPath(path.join(runtimeDirectory, 'template-build-ready'));
  const remotePaths = e2bBirthRequestPaths(request.request_hash);
  const sourcePath = path.join(root, 'request-source.json');
  const requestPath = path.join(runtimeDirectory, path.posix.basename(remotePaths.request));
  const triggerPath = path.join(runtimeDirectory, path.posix.basename(remotePaths.trigger));
  await writeFile(sourcePath, `${canonicalize(request)}\n`);
  await link(sourcePath, requestPath);
  await writeFile(triggerPath, `${request.request_hash}\n`);
  await assert.rejects(watcher, /bounded regular file|hard link/i);
  assert.equal(collectCalls, 0);
});

test('birth watcher rejects replacement of its one-use runtime directory', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'risk-fork-e2b-replaced-runtime-'));
  const runtimeDirectory = path.join(root, 'fresh-birth');
  const movedDirectory = path.join(root, 'moved-birth');
  t.after(() => rm(root, { recursive: true, force: true }));
  let resumePoll;
  const watcher = runBirthWatcher({
    runtimeDirectory,
    requestWaitTimeoutMs: 1_000,
    delay: () => new Promise((resolve) => {
      resumePoll = resolve;
    }),
  });
  await waitForPath(path.join(runtimeDirectory, 'template-build-ready'));
  for (let attempt = 0; attempt < 100 && !resumePoll; attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  assert.equal(typeof resumePoll, 'function');
  await rename(runtimeDirectory, movedDirectory);
  await mkdir(runtimeDirectory, { mode: 0o700 });
  resumePoll();
  await assert.rejects(watcher, /runtime directory identity changed/i);
});

test('birth watcher rejects runtime directory mode drift', {
  skip: process.platform === 'win32' ? 'POSIX mode bits are unavailable on Windows' : false,
}, async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'risk-fork-e2b-runtime-mode-'));
  const runtimeDirectory = path.join(root, 'fresh-birth');
  t.after(() => rm(root, { recursive: true, force: true }));
  let resumePoll;
  const watcher = runBirthWatcher({
    runtimeDirectory,
    requestWaitTimeoutMs: 1_000,
    delay: () => new Promise((resolve) => {
      resumePoll = resolve;
    }),
  });
  await waitForPath(path.join(runtimeDirectory, 'template-build-ready'));
  for (let attempt = 0; attempt < 100 && !resumePoll; attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  assert.equal(typeof resumePoll, 'function');
  await chmod(runtimeDirectory, 0o755);
  resumePoll();
  await assert.rejects(watcher, /runtime directory mode is invalid/i);
});

test('boot guard treats timeout as unknown and hashes provider credential keys without values', () => {
  assert.deepEqual(classifyLiteralProbeOutcome('timeout_without_connection'), {
    status: 'unknown',
    local_denial_observed: false,
  });
  assert.deepEqual(classifyLiteralProbeOutcome('EACCES'), {
    status: 'denied',
    local_denial_observed: true,
  });
  assert.deepEqual(classifyLiteralProbeOutcome('ENETUNREACH'), {
    status: 'unreachable',
    local_denial_observed: false,
  });
  const inspected = inspectProcessEnvironmentBytes(Buffer.from(
    'PATH=/usr/bin\0E2B_API_KEY=must-never-appear\0AWS_SESSION_TOKEN=also-secret\0',
    'utf8',
  ));
  assert.equal(inspected.key_count, 3);
  assert.equal(inspected.forbidden_key_hashes.length, 2);
  const serialized = JSON.stringify(inspected);
  assert.equal(serialized.includes('must-never-appear'), false);
  assert.equal(serialized.includes('also-secret'), false);
  assert.equal(serialized.includes('E2B_API_KEY'), false);
  assert.equal(
    inspectProcessEnvironmentBytes(Buffer.from('MALFORMED_WITHOUT_EQUALS\0')).well_formed,
    false,
  );
});

async function runtimeFixture(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'risk-fork-e2b-runtime-'));
  const workspace = path.join(root, 'workspace');
  await import('node:fs/promises').then(({ mkdir }) => mkdir(workspace, { recursive: true }));
  const bootstrapPath = new URL('../e2b-template/bin/bootstrap.mjs', import.meta.url);
  const runnerPath = new URL('../e2b-template/bin/run.mjs', import.meta.url);
  const bootstrapHash = await sha256FileRef(bootstrapPath);
  const runnerHash = await sha256FileRef(runnerPath);
  const bootEvidence = createBootEvidenceEnvelope({
    observed_at: '2030-01-01T00:00:00.000Z',
    expires_at: '2030-01-01T00:05:00.000Z',
    boot_nonce: 'boot-nonce-1234567890',
    boot_id_hash: sha256Ref('boot-id'),
    entropy_hash: sha256Ref('entropy'),
    bootstrap_artifact_hash: bootstrapHash,
    runner_artifact_hash: runnerHash,
    measurements: {
      environment_key_count: 4,
      process_count: 2,
      socket_count: 0,
      mount_count: 12,
      credential_path_count: 0,
    },
    observation_hashes: {
      environment_keys_hash: sha256Ref(['HOME', 'PATH', 'USER', '_']),
      processes_hash: sha256Ref(['process:1', 'process:2']),
      sockets_hash: sha256Ref([]),
      mounts_hash: sha256Ref(['mounts']),
      credential_paths_hash: sha256Ref([]),
      ipv4_probe_hash: sha256Ref('ipv4-blocked'),
      ipv6_probe_hash: sha256Ref('ipv6-blocked'),
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
  const bootEvidencePath = path.join(root, 'boot-evidence.json');
  await writeFile(bootEvidencePath, JSON.stringify(bootEvidence));
  t.after(() => rm(root, { recursive: true, force: true }));
  return {
    root,
    workspace,
    bootstrapPath,
    runnerPath,
    bootstrapHash,
    runnerHash,
    bootEvidencePath,
    bootEvidence,
  };
}

function bootstrapRequest(value, phase, workspaceDigest) {
  const capsule = makeCapsule();
  const identity = makeForkIdentity(capsule);
  const request = {
    schema: 'agoragentic.risk-fork.clean-bootstrap-request.v1',
    fork_identity: identity,
    capsule_hash: capsule.capsule_hash,
    network_policy_hash: sha256Ref('blocked-policy'),
    clean_template_id_hash: sha256Ref('template-id'),
    clean_template_evidence_hash: sha256Ref('template-evidence'),
    metadata_hash: sha256Ref('metadata'),
    expected_child_sandbox_id_hash: sha256Ref('sandbox-id'),
    trusted_bootstrap_artifact_hash: value.bootstrapHash,
    trusted_runner_artifact_hash: value.runnerHash,
    inherited_authority_accepted: false,
    rekey_required: true,
    phase,
    expected_workspace_digest: workspaceDigest,
    bootstrap_nonce: 'bootstrap-nonce-1234567890',
    request_hash: null,
  };
  request.request_hash = sha256Ref({ ...request, request_hash: null });
  return request;
}

test('bootstrap exact-binds fresh boot evidence, runtime artifacts, request, and pre/post workspace', async (t) => {
  const value = await runtimeFixture(t);
  const pre = await runBootstrap({
    request: bootstrapRequest(value, 'pre_upload', EMPTY_RUNTIME_WORKSPACE_DIGEST),
    bootEvidencePath: value.bootEvidencePath,
    workspaceRoot: value.workspace,
    bootstrapArtifactPath: value.bootstrapPath,
    runnerArtifactPath: value.runnerPath,
    clock: () => new Date('2030-01-01T00:00:10.000Z'),
  });
  assert.equal(pre.status, 'verified');
  assert.equal(pre.phase, 'pre_upload');
  assert.equal(pre.boot_evidence_hash, value.bootEvidence.evidence_hash);

  await writeFile(path.join(value.workspace, 'input.txt'), 'bounded input\n');
  const workspace = await inspectRuntimeWorkspace(value.workspace);
  const post = await runBootstrap({
    request: bootstrapRequest(value, 'post_import', workspace.workspace_digest),
    bootEvidencePath: value.bootEvidencePath,
    workspaceRoot: value.workspace,
    bootstrapArtifactPath: value.bootstrapPath,
    runnerArtifactPath: value.runnerPath,
    clock: () => new Date('2030-01-01T00:00:20.000Z'),
    expectedBootEvidenceHash: pre.boot_evidence_hash,
  });
  assert.equal(post.workspace_digest, workspace.workspace_digest);
  assert.equal(post.boot_evidence_hash, pre.boot_evidence_hash);

  await assert.rejects(
    runBootstrap({
      request: bootstrapRequest(value, 'pre_upload', EMPTY_RUNTIME_WORKSPACE_DIGEST),
      bootEvidencePath: value.bootEvidencePath,
      workspaceRoot: value.workspace,
      bootstrapArtifactPath: value.bootstrapPath,
      runnerArtifactPath: value.runnerPath,
      clock: () => new Date('2030-01-01T00:06:00.000Z'),
    }),
    /stale|validity/i,
  );
});

test('runner accepts only the closed bounded operation and writes one exact atomic result', async (t) => {
  const value = await runtimeFixture(t);
  const resultPath = path.join(value.root, 'result.json');
  const job = {
    schema: 'agoragentic.risk-fork.runner-job.v1',
    job_id: 'rfj_1234567890abcdef',
    capsule_hash: sha256Ref('capsule'),
    identity_hash: sha256Ref('identity'),
    network_policy_hash: sha256Ref('network'),
    operation_hash: null,
    execution_mode: 'prepare_only',
    expected_result_schema_hash: sha256Ref('schema'),
    operation: {
      kind: 'bounded_file_batch',
      actions: [{ type: 'write', path: 'output.txt', content: 'bounded output\n' }],
      commit_candidate: {
        type: 'TYPED_RESULT',
        result: { answer: 'bounded' },
        result_schema_hash: sha256Ref('schema'),
      },
    },
    result_path: resultPath,
    job_hash: null,
  };
  job.operation_hash = sha256Ref(job.operation);
  job.job_hash = sha256Ref({ ...job, job_hash: null });
  const result = await runRunnerJob({
    job,
    resultPath,
    workspaceRoot: value.workspace,
    runnerArtifactPath: value.runnerPath,
  });
  assert.equal(result.job_hash, job.job_hash);
  assert.equal(result.trusted_runner_artifact_hash, value.runnerHash);
  assert.equal(await readFile(path.join(value.workspace, 'output.txt'), 'utf8'), 'bounded output\n');
  assert.deepEqual(JSON.parse(await readFile(resultPath, 'utf8')), result);

  await assert.rejects(
    runRunnerJob({
      job,
      resultPath,
      workspaceRoot: value.workspace,
      runnerArtifactPath: value.runnerPath,
    }),
    /already exists|one-use/i,
  );
  const escaped = structuredClone(job);
  escaped.result_path = path.join(value.root, 'escaped-result.json');
  escaped.operation.actions[0].path = '../escape.txt';
  escaped.operation_hash = sha256Ref(escaped.operation);
  escaped.job_hash = sha256Ref({ ...escaped, job_hash: null });
  await assert.rejects(
    runRunnerJob({
      job: escaped,
      resultPath: escaped.result_path,
      workspaceRoot: value.workspace,
      runnerArtifactPath: value.runnerPath,
    }),
    /safe relative path|below the workspace|invalid/i,
  );
});

test('runner CLI transport paths are exact, separator-free, and job/result-pair bound', () => {
  const jobId = 'rfj_1234567890abcdef';
  assert.deepEqual(parseRunnerTransportPaths([
    'node',
    'run.mjs',
    '--job',
    `/tmp/agoragentic-risk-fork-v1.job.${jobId}.json`,
    '--result',
    `/tmp/agoragentic-risk-fork-v1.result.${jobId}.json`,
  ]), {
    jobId,
    jobPath: `/tmp/agoragentic-risk-fork-v1.job.${jobId}.json`,
    resultPath: `/tmp/agoragentic-risk-fork-v1.result.${jobId}.json`,
  });
  for (const [jobPath, resultPath] of [
    [
      `/tmp/agoragentic-risk-fork-v1.job.${jobId}/../../outside.json`,
      `/tmp/agoragentic-risk-fork-v1.result.${jobId}.json`,
    ],
    [
      `/tmp/agoragentic-risk-fork-v1.job.${jobId}.json`,
      `/tmp/agoragentic-risk-fork-v1.result.rfj_fedcba0987654321.json`,
    ],
    [
      `/tmp/agoragentic-risk-fork-v1.job.${jobId}.json/../outside.json`,
      `/tmp/agoragentic-risk-fork-v1.result.${jobId}.json`,
    ],
  ]) {
    assert.throws(
      () => parseRunnerTransportPaths([
        'node', 'run.mjs', '--job', jobPath, '--result', resultPath,
      ]),
      /fixed|transport|pair|namespace/i,
    );
  }
});

test('runner refuses a symlinked result parent before applying the operation', async (t) => {
  const value = await runtimeFixture(t);
  const realParent = path.join(value.root, 'real-results');
  const linkedParent = path.join(value.root, 'linked-results');
  await mkdir(realParent);
  try {
    await symlink(realParent, linkedParent, process.platform === 'win32' ? 'junction' : 'dir');
  } catch (error) {
    if (error?.code === 'EPERM') {
      t.skip('directory symlinks are unavailable on this Windows host');
      return;
    }
    throw error;
  }
  const resultPath = path.join(linkedParent, 'result.json');
  const job = {
    schema: 'agoragentic.risk-fork.runner-job.v1',
    job_id: 'rfj_1234567890abcdef',
    capsule_hash: sha256Ref('capsule'),
    identity_hash: sha256Ref('identity'),
    network_policy_hash: sha256Ref('network'),
    operation_hash: null,
    execution_mode: 'prepare_only',
    expected_result_schema_hash: sha256Ref('schema'),
    operation: {
      kind: 'bounded_file_batch',
      actions: [{ type: 'write', path: 'must-not-be-created.txt', content: 'no side effect\n' }],
      commit_candidate: {
        type: 'TYPED_RESULT',
        result: { answer: 'bounded' },
        result_schema_hash: sha256Ref('schema'),
      },
    },
    result_path: resultPath,
    job_hash: null,
  };
  job.operation_hash = sha256Ref(job.operation);
  job.job_hash = sha256Ref({ ...job, job_hash: null });
  await assert.rejects(
    runRunnerJob({
      job,
      resultPath,
      workspaceRoot: value.workspace,
      runnerArtifactPath: value.runnerPath,
    }),
    /result parent|real directory|canonical/i,
  );
  await assert.rejects(readFile(path.join(value.workspace, 'must-not-be-created.txt')), /ENOENT/);
});
