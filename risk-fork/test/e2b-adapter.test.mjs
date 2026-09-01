import assert from 'node:assert/strict';
import test from 'node:test';

import {
  E2BRiskForkAdapter,
  E2B_RISK_FORK_PATHS,
  E2B_SECURE_SNAPSHOT_PROFILE_UNAVAILABLE,
} from '../src/adapters/e2b.mjs';
import { hash } from './helpers.mjs';

function createFixture(options = {}) {
  const counters = {
    authorityVerifier: 0,
    sdkLoader: 0,
    provider: 0,
  };

  class Sandbox {
    static async create() {
      counters.provider += 1;
      throw new Error('unexpected E2B Sandbox.create call');
    }

    static async getInfo() {
      counters.provider += 1;
      throw new Error('unexpected E2B Sandbox.getInfo call');
    }

    static async createSnapshot() {
      counters.provider += 1;
      throw new Error('unexpected E2B Sandbox.createSnapshot call');
    }

    static async deleteSnapshot() {
      counters.provider += 1;
      throw new Error('unexpected E2B Sandbox.deleteSnapshot call');
    }

    static listSnapshots() {
      counters.provider += 1;
      throw new Error('unexpected E2B Sandbox.listSnapshots call');
    }
  }

  const adapter = new E2BRiskForkAdapter({
    SandboxClass: Sandbox,
    offlineConformance: true,
    ...(options.useSdkLoader ? {
      sdkLoader: async () => {
        counters.sdkLoader += 1;
        return { Sandbox };
      },
    } : {}),
    verifyAuthorityFreeSource: async () => {
      counters.authorityVerifier += 1;
      throw new Error('unexpected authority verifier call');
    },
    bootstrapCommand: 'trusted-bootstrap',
    runnerCommand: 'trusted-runner',
    trustedBootstrapArtifactHash: hash('trusted-bootstrap-artifact-v1'),
    trustedRunnerArtifactHash: hash('trusted-runner-artifact-v1'),
  });

  return { adapter, counters };
}

function assertSecureProfileUnavailable(error, operation) {
  assert.equal(error?.code, E2B_SECURE_SNAPSHOT_PROFILE_UNAVAILABLE);
  assert.equal(error?.name, 'E2BSecureSnapshotProfileUnavailableError');
  assert.equal(error?.operation, operation);
  assert.equal(error?.provider, 'e2b-snapshot-v1');
  assert.equal(error?.retryable, false);
  assert.equal(error?.production_qualified, false);
  assert.match(error?.message, /secure Risk Fork snapshot profile is unavailable/i);
  return true;
}

test('E2B capabilities honestly declare the secure snapshot profile unavailable', () => {
  const { adapter } = createFixture();
  assert.deepEqual(adapter.capabilities, {
    supports_memory_snapshot: false,
    supports_filesystem_snapshot: false,
    supports_live_fork: false,
    supports_network_policy: false,
    supports_egress_allowlist: false,
    supports_runtime_attestation: false,
    supports_suspend_resume: false,
    supports_verified_destruction: false,
    supports_hard_ttl: false,
    supports_idle_ttl: false,
    supports_max_execution_time: false,
    supports_automatic_credential_expiry: false,
    child_credentials_mode: 'unknown',
    isolation_class: 'secure_snapshot_profile_unavailable',
    adapter_implementation: 'blocked_secure_profile_unavailable',
    mock_conformance: 'fail_closed_only',
    credentialed_provider_validation: 'not_run',
    containment_claim: 'not_verified',
  });
});

test('every E2B create or execute entrypoint fails closed before verifier, SDK, or provider I/O', async (t) => {
  const cases = [
    ['createSavepoint', (adapter) => adapter.createSavepoint({})],
    ['createFork', (adapter) => adapter.createFork({})],
    [
      'executeInFork',
      (adapter) => adapter.executeInFork({
        fork_ref: 'unavailable-fork:benign-operation',
        execution_mode: 'isolated_execution',
        operation: { kind: 'analyze', subject_ref: 'opaque:123' },
      }),
    ],
  ];

  for (const [operation, invoke] of cases) {
    await t.test(operation, async () => {
      const { adapter, counters } = createFixture();
      await assert.rejects(
        invoke(adapter),
        (error) => assertSecureProfileUnavailable(error, operation),
      );
      assert.deepEqual(counters, {
        authorityVerifier: 0,
        sdkLoader: 0,
        provider: 0,
      });
    });
  }
});

test('the shared child-operation authority validator runs before the E2B unavailable error', async () => {
  const { adapter, counters } = createFixture();
  for (const operation of [
    { kind: 'analyze', controls: { can_spend: true } },
    { kind: 'analyze', authorization: 'grant:must-not-cross' },
    { kind: 'analyze', metadata: { executionAuthority: 'grant:must-not-cross' } },
  ]) {
    await assert.rejects(
      adapter.executeInFork({
        fork_ref: 'unavailable-fork:authority-operation',
        execution_mode: 'isolated_execution',
        operation,
      }),
      (error) => {
        assert.notEqual(error?.code, E2B_SECURE_SNAPSHOT_PROFILE_UNAVAILABLE);
        assert.match(
          error?.message,
          /authority or secret-bearing field|authority or secret-shaped material/i,
        );
        return true;
      },
    );
  }
  assert.deepEqual(counters, {
    authorityVerifier: 0,
    sdkLoader: 0,
    provider: 0,
  });
});

test('the fail-closed entrypoints never lazy-load the optional E2B SDK', async () => {
  const { adapter, counters } = createFixture({ useSdkLoader: true });
  await assert.rejects(
    adapter.createSavepoint({}),
    (error) => assertSecureProfileUnavailable(error, 'createSavepoint'),
  );
  await assert.rejects(
    adapter.createFork({}),
    (error) => assertSecureProfileUnavailable(error, 'createFork'),
  );
  await assert.rejects(
    adapter.executeInFork({ operation: { kind: 'analyze' } }),
    (error) => assertSecureProfileUnavailable(error, 'executeInFork'),
  );
  assert.equal(counters.sdkLoader, 0);
  assert.equal(counters.provider, 0);
  assert.equal(counters.authorityVerifier, 0);
});

test('reference transport paths remain non-authoritative constants', () => {
  assert.deepEqual(E2B_RISK_FORK_PATHS, {
    identity: '/tmp/agoragentic-risk-fork-v1.identity.json',
    job: '/tmp/agoragentic-risk-fork-v1.job.json',
    result: '/tmp/agoragentic-risk-fork-v1.result.json',
  });
  assert.equal(Object.isFrozen(E2B_RISK_FORK_PATHS), true);
});
