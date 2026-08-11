import assert from 'node:assert/strict';
import test from 'node:test';

import { sha256Ref } from '../src/canonical.mjs';
import { createForkIdentity, createSavepointCapsule } from '../src/contracts.mjs';
import {
  E2BRiskForkAdapter,
  E2B_RISK_FORK_PATHS,
} from '../src/adapters/e2b.mjs';

const NOW = new Date('2026-08-11T12:00:00.000Z');
const LATER = '2026-08-11T13:00:00.000Z';

function hash(value) {
  return sha256Ref(value);
}

function capsule() {
  return createSavepointCapsule({
    created_at: NOW,
    expires_at: LATER,
    parent: {
      agent_id: 'parent-sensitive-agent-id',
      session_id: 'parent-sensitive-session-id',
      lineage_ref: 'lineage:opaque',
      lineage_hash: hash('lineage'),
      state_hash: hash('parent-state'),
    },
    agent_configuration: {
      model_version_hash: hash('model'),
      system_instruction_hash: hash('instructions'),
      tool_manifest_hash: hash('tools'),
    },
    checkpoint: {
      goal_ref: 'goal:opaque',
      goal_hash: hash('goal'),
      task_graph_ref: 'task-graph:opaque',
      task_graph_hash: hash('task-graph'),
    },
    memory_roots: [],
    workspace: {
      snapshot_ref: 'workspace:opaque',
      digest: hash('workspace'),
    },
    governance: {
      policy_version: 'policy-v1',
      policy_hash: hash('policy'),
      mandate_version: 'mandate-v1',
      mandate_hash: hash('mandate'),
      budget_version: 'budget-v1',
      budget_hash: hash('budget'),
    },
    receipt_chain_head: hash('receipt-chain'),
    proposed_interaction: {
      mcp_server_ref: 'mcp:opaque',
      mcp_server_origin: 'https://untrusted.example.invalid',
      mcp_method: 'tools/call',
      tool_name: 'candidate_tool',
      effective_arguments_hash: hash({ query: 'safe' }),
      target_ref: 'target:opaque',
    },
    allowed_commit_types: ['TYPED_RESULT'],
    authorized_result_schema_hash: hash('result-schema'),
    runtime_snapshot: { mode: 'none' },
  });
}

function authorityVerifier(events, overrides = {}) {
  return async (request) => {
    events.push({ type: 'authority-verify', request });
    return {
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
  };
}

function notFound() {
  const error = new Error('not found');
  error.status = 404;
  return error;
}

function createMockSdk(options = {}) {
  const events = [];
  const files = new Map();
  const snapshots = new Set();
  let childKilled = false;
  let childState = 'running';
  let createOptions = null;
  let sourceInfoReads = 0;

  const source = { sandboxId: 'source-sensitive-sandbox-id' };

  const child = {
    sandboxId: 'child-sandbox-1',
    files: {
      async write(path, content) {
        events.push({ type: 'file-write', path, content });
        files.set(path, content);
      },
      async read(path) {
        events.push({ type: 'file-read', path });
        return files.get(path);
      },
    },
    commands: {
      async run(command, commandOptions) {
        events.push({ type: 'command', command, options: commandOptions });
        if (command === 'trusted-runner') {
          files.set(E2B_RISK_FORK_PATHS.result, JSON.stringify(
            options.runnerResult ?? {
              schema: 'agoragentic.risk-fork.runner-result.v1',
              status: 'completed',
              commit_candidate: { kind: 'WORKSPACE_DIFF' },
              workspace_diff: {
                type: 'WORKSPACE_DIFF',
                files: [],
                test_evidence: [],
              },
            },
          ));
        }
        return { exitCode: 0, stdout: 'provider output excluded', stderr: '' };
      },
    },
    async kill() {
      events.push({ type: 'kill-child' });
      if (options.killThrows) throw new Error('kill failed');
      childKilled = true;
    },
    async pause() {
      events.push({ type: 'pause-child' });
      childState = 'paused';
      return true;
    },
  };

  class Sandbox {
    static async getInfo(sandboxId) {
      events.push({ type: 'get-info', sandboxId });
      if (sandboxId === source.sandboxId) {
        sourceInfoReads += 1;
        return {
          sandboxId,
          state: 'running',
          allowInternetAccess: sourceInfoReads > 1
            ? (options.sourceAllowInternetAfterAttestation ?? options.sourceAllowInternet ?? false)
            : (options.sourceAllowInternet ?? false),
          network: { allowOut: options.sourceAllowOut ?? [] },
          envdAccessToken: 'provider-returned-secret-must-not-be-copied',
        };
      }
      if (sandboxId === child.sandboxId) {
        if (childKilled && options.childAbsentAfterKill) throw notFound();
        return {
          sandboxId,
          state: childState,
          allowInternetAccess: options.childAllowInternet ?? false,
          network: { allowOut: options.childAllowOut ?? [] },
          lifecycle: options.childLifecycle ?? {
            onTimeout: 'kill',
            autoResume: false,
          },
          metadata: options.childMetadataExtra
            ? { ...(createOptions?.metadata ?? {}), ...options.childMetadataExtra }
            : (createOptions?.metadata ?? {}),
          endAt: options.childEndAt
            ?? new Date(NOW.getTime() + (createOptions?.timeoutMs ?? 60_000)),
          envdAccessToken: 'provider-returned-secret-must-not-be-copied',
        };
      }
      throw notFound();
    }

    static async createSnapshot(sandboxId) {
      events.push({ type: 'create-snapshot', sandboxId });
      assert.equal(sandboxId, source.sandboxId);
      snapshots.add('snapshot-1');
      return { snapshotId: 'snapshot-1' };
    }

    static async create(snapshotId, sdkOptions) {
      events.push({ type: 'create-child', snapshotId, options: sdkOptions });
      createOptions = sdkOptions;
      return child;
    }

    static async deleteSnapshot(snapshotId) {
      events.push({ type: 'delete-snapshot', snapshotId });
      if (options.deleteSnapshotThrows) throw new Error('delete failed');
      return snapshots.delete(snapshotId);
    }

    static listSnapshots() {
      events.push({ type: 'list-snapshots' });
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
    events,
    files,
    source,
    child,
    get createOptions() { return createOptions; },
  };
}

function createAdapter(mock, verifier = authorityVerifier(mock.events)) {
  return new E2BRiskForkAdapter({
    SandboxClass: mock.Sandbox,
    verifyAuthorityFreeSource: verifier,
    bootstrapCommand: 'trusted-bootstrap',
    runnerCommand: 'trusted-runner',
    trustedBootstrapArtifactHash: hash('trusted-bootstrap-artifact-v1'),
    trustedRunnerArtifactHash: hash('trusted-runner-artifact-v1'),
    clock: () => new Date(NOW),
  });
}

async function prepareFork(mock, verifier) {
  const adapter = createAdapter(mock, verifier);
  const savepoint = await adapter.createSavepoint({
    capsule: capsule(),
    source_sandbox_id: mock.source.sandboxId,
  });
  const forkIdentity = createForkIdentity({
    parent_agent_id: 'parent-sensitive-agent-id',
    parent_session_id: 'parent-sensitive-session-id',
    issued_at: NOW,
  });
  const fork = await adapter.createFork({
    savepoint_ref: savepoint.savepoint_ref,
    fork_identity: forkIdentity,
    network_policy: { mode: 'blocked', allowlist: [] },
    ttl_ms: 60_000,
  });
  return { adapter, savepoint, fork, forkIdentity };
}

test('E2B adapter snapshots only after source safety proof and locks down child birth', async () => {
  const mock = createMockSdk();
  const { adapter, fork } = await prepareFork(mock);

  const order = mock.events.map((event) => event.type);
  assert.deepEqual(order.slice(0, 8), [
    'get-info',
    'authority-verify',
    'get-info',
    'create-snapshot',
    'create-child',
    'get-info',
    'file-write',
    'command',
  ]);
  assert.equal(mock.events[0].sandboxId, mock.source.sandboxId);
  assert.equal(mock.events[6].path, E2B_RISK_FORK_PATHS.identity);
  assert.equal(mock.events[7].command, 'trusted-bootstrap');
  assert.doesNotMatch(mock.events[6].content, /parent-sensitive/);

  assert.deepEqual(mock.createOptions.lifecycle, {
    onTimeout: 'kill',
    autoResume: false,
  });
  assert.equal(mock.createOptions.secure, true);
  assert.equal(mock.createOptions.allowInternetAccess, false);
  assert.equal(mock.createOptions.timeoutMs, 60_000);
  assert.equal(Object.hasOwn(mock.createOptions, 'envs'), false);
  const serializedMetadata = JSON.stringify(mock.createOptions.metadata);
  assert.doesNotMatch(serializedMetadata, /parent-sensitive|source-sensitive|provider-returned-secret/);
  assert.deepEqual(Object.keys(mock.createOptions.metadata).sort(), [
    'agoragentic.risk_fork.bootstrap_artifact_hash',
    'agoragentic.risk_fork.capsule_hash',
    'agoragentic.risk_fork.identity_hash',
    'agoragentic.risk_fork.network_policy_hash',
    'agoragentic.risk_fork.runner_artifact_hash',
    'agoragentic.risk_fork.schema',
  ]);

  const execution = await adapter.executeInFork({
    fork_ref: fork.fork_ref,
    execution_mode: 'isolated_execution',
    operation: { kind: 'analyze', subject_ref: 'opaque:123' },
  });
  assert.equal(execution.taint_status, 'TAINTED');
  assert.equal(execution.authority_granted, false);
  const runnerWrite = mock.events.find((event) => (
    event.type === 'file-write' && event.path === E2B_RISK_FORK_PATHS.job
  ));
  assert.ok(runnerWrite);
  const runnerCommand = mock.events.find((event) => (
    event.type === 'command' && event.command === 'trusted-runner'
  ));
  assert.ok(runnerCommand);
  const evidence = await adapter.collectEvidence({ fork_ref: fork.fork_ref });
  assert.equal(evidence.snapshot_integrity_status, 'unknown');
  assert.equal(evidence.bootstrap_status, 'observed');
  assert.equal(evidence.credentials_included, false);
  assert.equal(evidence.raw_stdout_included, false);
});

test('E2B adapter fails closed before snapshot without source egress and authority proof', async (t) => {
  await t.test('source network access is enabled', async () => {
    const mock = createMockSdk({ sourceAllowInternet: true });
    const adapter = createAdapter(mock);
    await assert.rejects(
      adapter.createSavepoint({ capsule: capsule(), source_sandbox_id: mock.source.sandboxId }),
      /does not prove allowInternetAccess=false/,
    );
    assert.equal(mock.events.some((event) => event.type === 'authority-verify'), false);
    assert.equal(mock.events.some((event) => event.type === 'create-snapshot'), false);
  });

  await t.test('external authority verifier refuses the source', async () => {
    const mock = createMockSdk();
    const verifier = authorityVerifier(mock.events, { status: 'failed' });
    const adapter = createAdapter(mock, verifier);
    await assert.rejects(
      adapter.createSavepoint({ capsule: capsule(), source_sandbox_id: mock.source.sandboxId }),
      /externally verified authority-free source attestation is required/,
    );
    assert.equal(mock.events.some((event) => event.type === 'create-snapshot'), false);
  });

  await t.test('source egress changes after attestation', async () => {
    const mock = createMockSdk({ sourceAllowInternetAfterAttestation: true });
    const adapter = createAdapter(mock);
    await assert.rejects(
      adapter.createSavepoint({ capsule: capsule(), source_sandbox_id: mock.source.sandboxId }),
      /does not prove allowInternetAccess=false/,
    );
    assert.equal(mock.events.some((event) => event.type === 'authority-verify'), true);
    assert.equal(mock.events.some((event) => event.type === 'create-snapshot'), false);
  });
});

test('E2B adapter rejects an egress-capable child and verifies cleanup before bootstrap', async () => {
  const mock = createMockSdk({ childAllowInternet: true, childAbsentAfterKill: true });
  const adapter = createAdapter(mock);
  const savepoint = await adapter.createSavepoint({
    capsule: capsule(),
    source_sandbox_id: mock.source.sandboxId,
  });
  const forkIdentity = createForkIdentity({
    parent_agent_id: 'parent-agent',
    parent_session_id: 'parent-session',
    issued_at: NOW,
  });
  await assert.rejects(
    adapter.createFork({
      savepoint_ref: savepoint.savepoint_ref,
      fork_identity: forkIdentity,
      network_policy: { mode: 'blocked' },
      ttl_ms: 60_000,
    }),
    /does not prove allowInternetAccess=false/,
  );
  assert.equal(mock.events.some((event) => event.type === 'kill-child'), true);
  assert.equal(mock.events.some((event) => event.type === 'file-write'), false);
  assert.equal(mock.createOptions.allowInternetAccess, false);
});

test('failed-fork cleanup remains an explicit blocker when kill fails', async () => {
  const mock = createMockSdk({ childAllowInternet: true, killThrows: true });
  const adapter = createAdapter(mock);
  const savepoint = await adapter.createSavepoint({
    capsule: capsule(),
    source_sandbox_id: mock.source.sandboxId,
  });
  const forkIdentity = createForkIdentity({
    parent_agent_id: 'parent-agent',
    parent_session_id: 'parent-session',
    issued_at: NOW,
  });
  await assert.rejects(
    adapter.createFork({
      savepoint_ref: savepoint.savepoint_ref,
      fork_identity: forkIdentity,
      network_policy: { mode: 'blocked' },
      ttl_ms: 60_000,
    }),
    /cleanup absence was not verified/,
  );
  assert.equal(mock.events.some((event) => event.type === 'kill-child'), true);
  assert.equal(mock.events.some((event) => event.type === 'file-write'), false);
});

test('E2B adapter verifies child metadata binding and TTL instead of trusting create options', async (t) => {
  await t.test('provider metadata drift', async () => {
    const mock = createMockSdk({
      childMetadataExtra: { unexpected: 'provider-drift' },
      childAbsentAfterKill: true,
    });
    const adapter = createAdapter(mock);
    const savepoint = await adapter.createSavepoint({
      capsule: capsule(),
      source_sandbox_id: mock.source.sandboxId,
    });
    await assert.rejects(
      adapter.createFork({
        savepoint_ref: savepoint.savepoint_ref,
        fork_identity: createForkIdentity({
          parent_agent_id: 'parent-agent',
          parent_session_id: 'parent-session',
          issued_at: NOW,
        }),
        network_policy: { mode: 'blocked' },
        ttl_ms: 60_000,
      }),
      /metadata does not exactly match/,
    );
  });

  await t.test('provider deadline exceeds requested TTL', async () => {
    const mock = createMockSdk({
      childEndAt: new Date(NOW.getTime() + 10 * 60_000),
      childAbsentAfterKill: true,
    });
    const adapter = createAdapter(mock);
    const savepoint = await adapter.createSavepoint({
      capsule: capsule(),
      source_sandbox_id: mock.source.sandboxId,
    });
    await assert.rejects(
      adapter.createFork({
        savepoint_ref: savepoint.savepoint_ref,
        fork_identity: createForkIdentity({
          parent_agent_id: 'parent-agent',
          parent_session_id: 'parent-session',
          issued_at: NOW,
        }),
        network_policy: { mode: 'blocked' },
        ttl_ms: 60_000,
      }),
      /TTL deadline exceeds/,
    );
  });
});

test('a successful E2B kill request is not destruction proof', async () => {
  const mock = createMockSdk({ childAbsentAfterKill: false });
  const { adapter, fork } = await prepareFork(mock);
  const requested = await adapter.destroyFork({
    fork_ref: fork.fork_ref,
    reason: 'test_cleanup',
  });
  assert.equal(requested.evidence_status, 'observed');
  assert.notEqual(requested.status, 'verified');

  const verified = await adapter.verifyDestroyed({ fork_ref: fork.fork_ref });
  assert.equal(verified.status, 'failed');
  assert.equal(verified.outcome, 'failure');
  assert.equal(verified.evidence_status, 'verified_present');
});

test('fork and snapshot destruction become verified only after authoritative absence', async () => {
  const mock = createMockSdk({ childAbsentAfterKill: true });
  const { adapter, fork, savepoint } = await prepareFork(mock);

  const forkRequest = await adapter.destroyFork({ fork_ref: fork.fork_ref });
  assert.equal(forkRequest.evidence_status, 'observed');
  const forkAbsence = await adapter.verifyDestroyed({ fork_ref: fork.fork_ref });
  assert.equal(forkAbsence.status, 'verified');
  assert.equal(forkAbsence.outcome, 'success');
  assert.equal(forkAbsence.evidence_status, 'verified');

  const snapshotRequest = await adapter.destroySavepoint({
    savepoint_ref: savepoint.savepoint_ref,
  });
  assert.equal(snapshotRequest.evidence_status, 'observed');
  const snapshotAbsence = await adapter.verifySavepointDestroyed({
    savepoint_ref: savepoint.savepoint_ref,
  });
  assert.equal(snapshotAbsence.status, 'verified');
  assert.equal(snapshotAbsence.outcome, 'success');
  assert.equal(snapshotAbsence.evidence_status, 'verified');
  assert.ok(mock.events.find((event) => event.type === 'list-snapshots'));
});

test('snapshot cleanup failures remain explicit and never become verified absence', async () => {
  const mock = createMockSdk({ deleteSnapshotThrows: true });
  const { adapter, savepoint } = await prepareFork(mock);
  const requested = await adapter.destroySavepoint({ savepoint_ref: savepoint.savepoint_ref });
  assert.equal(requested.status, 'failed');
  assert.equal(requested.evidence_status, 'failed');
  assert.equal(requested.error_code, 'E2B_SNAPSHOT_DELETE_FAILED');

  const verified = await adapter.verifySavepointDestroyed({
    savepoint_ref: savepoint.savepoint_ref,
  });
  assert.equal(verified.status, 'failed');
  assert.equal(verified.outcome, 'failure');
  assert.equal(verified.evidence_status, 'verified_present');
});

test('jobs containing credential-shaped authority are rejected before upload', async () => {
  const mock = createMockSdk();
  const { adapter, fork } = await prepareFork(mock);
  const writesBefore = mock.events.filter((event) => event.type === 'file-write').length;
  await assert.rejects(
    adapter.executeInFork({
      fork_ref: fork.fork_ref,
      execution_mode: 'isolated_execution',
      operation: { api_key: 'e2b_this_must_never_cross_the_boundary' },
    }),
    /authority or secret-bearing field/,
  );
  const writesAfter = mock.events.filter((event) => event.type === 'file-write').length;
  assert.equal(writesAfter, writesBefore);
});
