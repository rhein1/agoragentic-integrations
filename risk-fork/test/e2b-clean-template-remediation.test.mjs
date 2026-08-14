import assert from 'node:assert/strict';
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

import { sha256Ref } from '../src/canonical.mjs';
import { E2BRiskForkAdapter, E2B_RISK_FORK_PATHS } from '../src/adapters/e2b.mjs';
import {
  destroyImmutableWorkspaceExport,
  verifyImmutableWorkspaceExportDestroyed,
  workspaceExportPath,
} from '../src/adapters/e2b-workspace-export.mjs';
import { inspectLocalWorkspace } from '../src/adapters/local-reference.mjs';
import { NOW, hash, makeCapsule, makeForkIdentity } from './helpers.mjs';

const TEMPLATE_ID = 'template-risk-fork-clean-immutable-v1';
const TEMPLATE_HASH = hash('template-risk-fork-clean-immutable-v1');
const BOOTSTRAP_HASH = hash('trusted-bootstrap-artifact-v2');
const RUNNER_HASH = hash('trusted-runner-artifact-v2');
const MAX_RESULT_BYTES = 4 * 1024 * 1024;
const SECRET_TEST_VALUE = 'abcdefghijklmnop';

function parseFlag(command, flag) {
  const match = new RegExp(`${flag}\\s+(\\S+)`).exec(command);
  return match?.[1] ?? null;
}

function createMockSdk(options = {}) {
  const events = [];
  const files = new Map();
  let createOptions = null;
  let killed = false;
  let bootstrapCount = 0;

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
          if (options.resultStreamFactory) {
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
      if (options.createError) throw options.createError;
      killed = false;
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
        endAt: new Date(NOW.getTime() + (createOptions?.timeoutMs ?? 60_000)),
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
  const adapter = new E2BRiskForkAdapter({
    SandboxClass: mock.Sandbox,
    cleanTemplateId: TEMPLATE_ID,
    cleanTemplateHash: TEMPLATE_HASH,
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
    clock: () => new Date(NOW),
  });
  t.after(async () => {
    for (const record of adapter.savepoints.values()) {
      await destroyImmutableWorkspaceExport({
        export_root: exportsDirectory,
        export_id: record.export_record.export_id,
      });
    }
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

test('child birth options are exact, authority-free, mount-free, and deny all network at birth', async (t) => {
  const { mock } = await prepareFork(t);
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
  assert.equal(adapter.capabilities.supports_network_policy, true);
  assert.equal(adapter.capabilities.supports_verified_destruction, true);
  assert.equal(adapter.capabilities.supports_hard_ttl, true);
  assert.equal(adapter.capabilities.supports_max_execution_time, true);
  assert.equal(adapter.capabilities.supports_idle_ttl, false);
  assert.equal(adapter.capabilities.child_credentials_mode, 'prohibited');
  assert.equal(adapter.capabilities.credentialed_provider_validation, 'not_run');
  assert.equal(adapter.capabilities.containment_claim, 'not_verified');
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
