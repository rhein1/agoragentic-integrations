import assert from 'node:assert/strict';
import {
  mkdir,
  mkdtemp,
  readFile,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { sha256Ref } from '../src/canonical.mjs';
import {
  EMPTY_RUNTIME_WORKSPACE_DIGEST,
  createBootEvidenceEnvelope,
  inspectRuntimeWorkspace,
  sha256FileRef,
} from '../e2b-template/lib/runtime-contract.mjs';
import { runBootstrap } from '../e2b-template/bin/bootstrap.mjs';
import {
  classifyLiteralProbeOutcome,
  inspectProcessEnvironmentBytes,
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

test('template definition is pure, Node 24, root-owned, non-root at runtime, and boot-guard first', () => {
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
  const start = sdk.calls.find(([name]) => name === 'setStartCmd');
  assert.match(start[1], /env -i/);
  assert.match(start[1], /boot-guard\.mjs/);
  assert.equal(start[2].ready, '/run/agoragentic-risk-fork/ready');
  assert.equal(sdk.calls.some(([name]) => name === 'build'), false, 'definition must not build on import');
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
    local_denial_observed: true,
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
