import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { RiskForkController, inspectLocalWorkspace, sha256Ref } from '../../src/index.mjs';
import {
  E2B_LIVE_CANARY_COMPOSITION,
  E2B_LIVE_CANARY_SOURCE_ENABLED,
  composeE2BLiveCanary,
  evaluateE2BLiveCanaryGate,
  evaluateE2BLiveCanaryPreIoGates,
} from '../src/e2b-live-canary-gate.mjs';
import {
  FAKE_E2B_DEMO_PROFILE,
  HackathonFakeE2BAdapter,
} from '../src/fake-e2b-profile.mjs';
import {
  FAKE_E2B_MAX_TIMEOUT_MS,
  FAKE_E2B_TEMPLATE_ID,
  createFakeE2BSdk,
} from '../src/fake-e2b-sdk.mjs';
import { createDemoEngine } from '../src/demo-engine.mjs';
import {
  DEMO_NOW,
  createScenarioCapsule,
  demoTrustedServerVerifier,
  getScenario,
  scenarioEffectiveArguments,
} from '../src/scenarios.mjs';
import {
  MALICIOUS_MCP_ATTACK_IDS,
  MALICIOUS_MCP_CALL_ARGUMENTS,
  MALICIOUS_MCP_PARENT_ENV_CANARY_KEY,
  MALICIOUS_MCP_PARENT_ENV_FIXTURE,
  MALICIOUS_MCP_SERVER_REF,
  MALICIOUS_MCP_TOOL_NAME,
  runMaliciousMcpFixture,
  runMaliciousMcpFixtureOverStdio,
} from '../fixtures/malicious-stdio-mcp.mjs';

const CLOCK = () => new Date(DEMO_NOW);

async function controllerFixture(t, fault = 'none') {
  const root = await mkdtemp(path.join(os.tmpdir(), 'risk-fork-fake-e2b-test-'));
  const source = path.join(root, 'source');
  const adapterRoot = path.join(root, 'adapter');
  await mkdir(source);
  await mkdir(adapterRoot);
  await writeFile(path.join(source, 'task.txt'), 'bounded synthetic task\n');
  const scenario = getScenario('e2b-malicious-mcp-containment');
  const workspace = await inspectLocalWorkspace({ source_workspace: source });
  const capsule = createScenarioCapsule(scenario, workspace.workspace_digest, {
    parent_state_hash: `sha256:${'a'.repeat(64)}`,
  });
  const adapter = new HackathonFakeE2BAdapter({
    baseDirectory: adapterRoot,
    clock: CLOCK,
    fault,
  });
  t.after(async () => {
    await adapter.dispose().catch(() => {});
    await rm(root, { recursive: true, force: true });
  });
  const controller = new RiskForkController({
    provider: adapter,
    mode: 'demonstration',
    clock: CLOCK,
    trustedServerVerifier: demoTrustedServerVerifier,
  });
  const input = {
    risk_input: scenario.risk_input,
    capsule,
    savepoint_input: { source_workspace: source },
    operation: scenario.operation,
    effective_arguments: scenarioEffectiveArguments(scenario),
    expected_commit_type: 'TYPED_RESULT',
    commit_policy: {
      typed_result_schema_hash: capsule.authorized_result_schema_hash,
      max_typed_result_bytes: 256 * 1024,
      max_string_bytes: 256 * 1024,
      max_nodes: 10_000,
    },
    fork_ttl_ms: FAKE_E2B_MAX_TIMEOUT_MS,
    max_execution_ms: 10_000,
    network_policy: { mode: 'blocked' },
    force_optional_fork: false,
  };
  return { adapter, capsule, controller, input };
}

test('flagship fake-E2B run is visual, typed, parent-stable, cleaned, and provider-free', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'risk-fork-fake-e2b-engine-test-'));
  const engine = createDemoEngine({ rootDirectory: path.join(root, 'owned-root') });
  t.after(async () => {
    await engine.cleanup().catch(() => {});
    await rm(root, { recursive: true, force: true });
  });
  const result = await engine.run('e2b-malicious-mcp-containment');
  assert.equal(result.exit_code, 0);
  assert.equal(result.final_state, 'prepared_not_committed');
  assert.equal(result.execution_mode, 'fake_e2b_protocol_execution');
  assert.equal(result.isolation_boundary, false);
  assert.equal(result.provider_calls, 0);
  assert.equal(result.network_used, false);
  assert.equal(result.credentials_used, false);
  assert.equal(result.clean_commit_performed, false);
  assert.equal(result.parent_state_hash_before, result.parent_state_hash_after);
  assert.equal(result.parent_state_unchanged, true);
  assert.equal(result.provider_evidence.allocation_count, 1);
  assert.equal(result.provider_evidence.retry_count, 0);
  assert.equal(result.provider_evidence.sandbox_running, false);
  assert.equal(result.provider_evidence.timeout_ms, 180_000);
  assert.equal(result.provider_evidence.parent_environment_canary_declared, true);
  assert.equal(result.provider_evidence.parent_environment_fixture_key_count, 1);
  assert.equal(result.provider_evidence.parent_environment_fixture_value_serialized, false);
  assert.equal(result.provider_evidence.inherited_parent_environment_canary_count, 0);
  assert.equal(result.provider_evidence.child_environment_key_count >= 1, true);
  assert.match(result.provider_evidence.child_environment_key_names_hash, /^sha256:[a-f0-9]{64}$/);
  assert.equal(result.provider_evidence.child_provider_key_present, false);
  assert.equal(result.provider_evidence.persistent_mount_count, 0);
  assert.equal(result.provider_evidence.parent_only_credential_in_child, false);
  assert.deepEqual(result.provider_evidence.network_request, {
    allowOut: [],
    denyOut: ['0.0.0.0/0'],
    allowPublicTraffic: false,
  });
  assert.equal(result.provider_evidence.stdio_mcp_transport, 'local_stdio_subprocess');
  assert.deepEqual(result.provider_evidence.ttl_countdown, {
    start_seconds: 180,
    remaining_seconds: 0,
    terminal_reason: 'destroyed',
  });
  assert.equal(result.provider_evidence.cleanup_tracking.allocation_requested, true);
  assert.equal(result.provider_evidence.cleanup_tracking.sandbox_id_observed, true);
  assert.equal(result.provider_evidence.cleanup_tracking.kill_requested, true);
  assert.equal(result.provider_evidence.cleanup_tracking.kill_acknowledged, true);
  assert.equal(result.provider_evidence.cleanup_tracking.running_state_query_count, 3);
  assert.equal(result.provider_evidence.cleanup_tracking.exact_metadata_list_query_count, 1);
  assert.equal(result.provider_evidence.cleanup_tracking.exact_metadata_list_observation_count, 1);
  assert.equal(result.provider_evidence.cleanup_tracking.absence_observation_count, 2);
  assert.equal(result.provider_evidence.cleanup_tracking.cleanup_unknown, false);
  assert.equal(result.provider_evidence.cleanup_tracking.orphan_reconciliation_required, false);
  assert.equal(result.provider_evidence.raw_narrative_included, false);
  assert.match(result.provider_evidence.tainted_narrative_hash, /^sha256:[a-f0-9]{64}$/);
  assert.deepEqual(result.accepted_typed_result, {
    summary: 'One bounded synthetic result passed exact validation.',
    fixture_id: 'e2b-malicious-mcp-containment',
  });
  assert.deepEqual(
    result.attack_attempts.map((item) => item.attack),
    [...MALICIOUS_MCP_ATTACK_IDS],
  );
  assert.deepEqual(
    result.attack_attempts.map((item) => item.status),
    [
      'quarantined_hash_only',
      'rejected_by_clean_controller',
      'parent_canary_absent',
      'absent_from_child_export',
      'rejected_before_parent_effect',
      'denied_by_fake_creation_profile_not_live_verified',
      'quarantined_hash_only',
      'rejected_by_closed_schema',
    ],
  );
  assert.equal(result.cleanup.status, 'verified');
  assert.equal(result.cost.estimated_maximum_cost_usd, 0.00585);
  assert.equal(result.cost.provider_finalized_cost_usd, null);
  assert.equal(result.demo_receipt.core_receipt_verified, true);
});

test('malicious stdio fixture emits eight requests and the boundary accepts one closed typed result', async () => {
  const direct = await runMaliciousMcpFixture();
  assert.equal(Object.hasOwn(
    MALICIOUS_MCP_PARENT_ENV_FIXTURE,
    MALICIOUS_MCP_PARENT_ENV_CANARY_KEY,
  ), true);
  const result = await runMaliciousMcpFixtureOverStdio({
    parentEnvironment: MALICIOUS_MCP_PARENT_ENV_FIXTURE,
  });
  assert.equal(result.transport, 'local_stdio_subprocess');
  assert.deepEqual(
    result.attack_requests.map((item) => item.attack),
    [...MALICIOUS_MCP_ATTACK_IDS],
  );
  assert.deepEqual(result.call_binding, {
    mcp_phase: 'tools/call',
    mcp_server_ref: MALICIOUS_MCP_SERVER_REF,
    tool_name: MALICIOUS_MCP_TOOL_NAME,
    effective_arguments_hash: sha256Ref(MALICIOUS_MCP_CALL_ARGUMENTS),
  });
  assert.equal(result.child_environment_observation.parent_canary_present, false);
  assert.equal(result.child_environment_observation.provider_key_present, false);
  assert.equal(result.parent_environment_observation.canary_declared, true);
  assert.equal(result.parent_environment_observation.key_count, 1);
  assert.equal(result.parent_environment_observation.value_serialized, false);
  assert.equal(
    JSON.stringify(result).includes(
      MALICIOUS_MCP_PARENT_ENV_FIXTURE[MALICIOUS_MCP_PARENT_ENV_CANARY_KEY],
    ),
    false,
  );
  assert.equal(result.child_environment_observation.key_count >= 1, true);
  assert.deepEqual(result.typed_result, {
    summary: 'One bounded synthetic result passed exact validation.',
    fixture_id: 'e2b-malicious-mcp-containment',
  });
  assert.equal(Object.hasOwn(result.typed_result, 'authority_granted'), false);
  assert.deepEqual(result.attack_requests, direct.attack_requests);
  assert.deepEqual(result.raw_child_output, direct.raw_child_output);
  assert.equal(result.raw_child_output.authority_shaped_fields.authority_granted, true);
});

test('fake SDK enforces one allocation, exact denial profile, no retry, and no fallback', async () => {
  const sdk = createFakeE2BSdk();
  const options = {
    timeoutMs: 180_000,
    secure: true,
    allowInternetAccess: false,
    network: { allowOut: [], denyOut: ['0.0.0.0/0'], allowPublicTraffic: false },
    lifecycle: { onTimeout: 'kill', autoResume: false },
    metadata: {},
    envs: {},
    iam: { tokens: {} },
    volumeMounts: {},
  };
  const child = await sdk.Sandbox.create(FAKE_E2B_TEMPLATE_ID, options);
  await assert.rejects(sdk.Sandbox.create(FAKE_E2B_TEMPLATE_ID, options), /exactly one/i);
  await child.kill();
  const evidence = sdk.evidence();
  assert.equal(evidence.allocation_count, 1);
  assert.equal(evidence.retry_count, 0);
  assert.equal(evidence.rejected_repeat_attempt_count, 1);
  assert.equal(evidence.fallback_provider, null);
  assert.equal(evidence.inherited_parent_environment_canary_count, null);
  assert.equal(evidence.persistent_mount_count, 0);
  assert.equal(evidence.public_ingress_enabled, false);

  const failedSdk = createFakeE2BSdk({ fault: 'create_failure' });
  await assert.rejects(
    failedSdk.Sandbox.create(FAKE_E2B_TEMPLATE_ID, options),
    /create failure/i,
  );
  const failedEvidence = failedSdk.evidence();
  assert.equal(failedEvidence.allocation_attempt_count, 1);
  assert.equal(failedEvidence.allocation_count, 0);
  assert.equal(failedEvidence.retry_count, 0);
  assert.equal(failedEvidence.fallback_provider, null);

  const authoritySdk = createFakeE2BSdk();
  await assert.rejects(
    authoritySdk.Sandbox.create(FAKE_E2B_TEMPLATE_ID, {
      ...options,
      envs: { SYNTHETIC_PARENT_AUTHORITY: 'synthetic-canary' },
    }),
    /forbids inherited env/i,
  );
  await assert.rejects(authoritySdk.Sandbox.createSnapshot(), /snapshots are prohibited/i);
  await assert.rejects(authoritySdk.Sandbox.fork(), /forks are prohibited/i);
});

test('stale, cross-job, wrong parent/provider/capsule/schema results all fail closed', async (t) => {
  for (const fault of [
    'stale_result',
    'wrong_job',
    'wrong_parent',
    'wrong_provider',
    'wrong_capsule',
    'wrong_schema',
  ]) {
    await t.test(fault, async (subtest) => {
      const value = await controllerFixture(subtest, fault);
      await assert.rejects(value.controller.prepare(value.input), /failed closed/i);
      const evidence = value.adapter.providerEvidence();
      assert.equal(evidence.allocation_count, 1);
      assert.equal(evidence.retry_count, 0);
      assert.equal(evidence.sandbox_running, false);
    });
  }
});

test('ambiguous allocation is terminal until list reconciliation proves absence', async (t) => {
  const value = await controllerFixture(t, 'ambiguous_allocation');
  await assert.rejects(value.controller.prepare(value.input), /failed closed/i);
  const before = value.adapter.providerEvidence();
  assert.equal(before.allocation_count, 1);
  assert.equal(before.retry_count, 0);
  assert.equal(before.sandbox_running, true);
  assert.equal(before.cleanup_tracking.orphan_reconciliation_required, true);
  const reconciliation = await value.adapter.reconcilePendingCleanup();
  assert.equal(reconciliation.unresolved.length, 0);
  assert.equal(value.adapter.providerEvidence().allocation_count, 1);
  assert.equal(value.adapter.providerEvidence().sandbox_running, false);
  assert.equal(
    value.adapter.providerEvidence().cleanup_tracking.orphan_reconciliation_required,
    false,
  );
});

test('command timeout and cleanup failure stay blocked without retry or deletion-success claims', async (t) => {
  await t.test('command timeout', async (subtest) => {
    const value = await controllerFixture(subtest, 'command_timeout');
    value.input.max_execution_ms = 100;
    await assert.rejects(value.controller.prepare(value.input), /failed closed/i);
    const evidence = value.adapter.providerEvidence();
    assert.equal(evidence.retry_count, 0);
    assert.equal(evidence.sandbox_running, false);
  });
  await t.test('cleanup failure', async (subtest) => {
    const value = await controllerFixture(subtest, 'cleanup_failure');
    await assert.rejects(value.controller.prepare(value.input), /cleanup|failed closed/i);
    const evidence = value.adapter.providerEvidence();
    assert.equal(evidence.retry_count, 0);
    assert.equal(evidence.sandbox_running, true);
    assert.equal(evidence.cleanup_tracking.cleanup_unknown, true);
    assert.equal(evidence.cleanup_tracking.orphan_reconciliation_required, true);
    assert.equal(
      evidence.events.some((event) => event.type === 'kill_outcome_unknown'),
      true,
    );
  });
  await t.test('absence query failure', async (subtest) => {
    const value = await controllerFixture(subtest, 'absence_query_failure');
    await assert.rejects(value.controller.prepare(value.input), /cleanup|failed closed/i);
    const evidence = value.adapter.providerEvidence();
    assert.equal(evidence.retry_count, 0);
    assert.equal(evidence.cleanup_tracking.kill_acknowledged, true);
    assert.equal(evidence.cleanup_tracking.absence_observation_count, 0);
    assert.equal(evidence.cleanup_tracking.cleanup_unknown, true);
    assert.equal(evidence.cleanup_tracking.orphan_reconciliation_required, true);
    assert.equal(evidence.ttl_countdown.terminal_reason, 'cleanup_unknown');
    assert.equal(
      evidence.events.some((event) => event.type === 'running_state_query_unknown'),
      true,
    );
  });
});

test('live canary composition is source-disabled before secrets, approval, or provider I/O', async () => {
  assert.equal(E2B_LIVE_CANARY_SOURCE_ENABLED, false);
  assert.equal(E2B_LIVE_CANARY_COMPOSITION.sdk, 'e2b@2.39.0');
  assert.equal(E2B_LIVE_CANARY_COMPOSITION.source_gate_enabled, false);
  assert.equal(E2B_LIVE_CANARY_COMPOSITION.provider_io_allowed, false);
  const inaccessibleInput = new Proxy({}, {
    get() {
      throw new Error('source-disabled gate must not inspect caller data');
    },
    ownKeys() {
      throw new Error('source-disabled gate must not enumerate caller data');
    },
  });
  const result = evaluateE2BLiveCanaryGate(inaccessibleInput);
  assert.equal(result.code, 'E2B_LIVE_SOURCE_DISABLED');
  assert.equal(result.provider_calls, 0);
  assert.equal(result.credentials_inspected, false);
  assert.equal(result.credentials_serialized, false);
  assert.equal(result.run_claim_attempted, false);
  assert.equal(result.run_consumed, false);
  const composition = await composeE2BLiveCanary(inaccessibleInput);
  assert.equal(composition.status, 'blocked');
  assert.equal(composition.adapter, null);
  assert.equal(composition.sdk_loaded, false);
  assert.equal(composition.provider_calls, 0);
  assert.equal(FAKE_E2B_DEMO_PROFILE.maximum_allocations_per_run, 1);
});

test('injectable live pre-I/O model independently enforces every exact one-shot gate', async () => {
  const request = {
    profile_id: FAKE_E2B_DEMO_PROFILE.id,
    run_id: `e2b_demo_canary_${'a'.repeat(16)}`,
    maximum_provider_allocations: 1,
    maximum_runtime_seconds: 180,
    maximum_cost_usd: 0.00585,
    synthetic_only: true,
  };
  const approvalArtifact = Object.freeze({ opaque_ref: 'synthetic-owner-artifact' });
  let approvalCalls = 0;
  let claimCalls = 0;
  const approvalAuthority = {
    async verifyApproval({ request: exactRequest }) {
      approvalCalls += 1;
      return {
        authenticated: true,
        profile_id: exactRequest.profile_id,
        run_id: exactRequest.run_id,
        maximum_provider_allocations: exactRequest.maximum_provider_allocations,
        maximum_runtime_seconds: exactRequest.maximum_runtime_seconds,
        maximum_cost_usd: exactRequest.maximum_cost_usd,
        synthetic_only: exactRequest.synthetic_only,
        approval_ref: 'owner:synthetic-test-authority',
        expires_at: '2030-01-01T00:40:00.000Z',
      };
    },
  };
  const runClaimStore = {
    async claimOnce({ run_id: runId }) {
      claimCalls += 1;
      return { status: 'claimed', run_id: runId, durable: true, atomic: true };
    },
  };
  const base = {
    sourceEnabled: true,
    environment: {
      RISK_FORK_DEMO_E2B_ENABLED: 'true',
      E2B_API_KEY: 'synthetic-presence-only-never-serialized',
    },
    request,
    approvalArtifact,
    approvalAuthority,
    runClaimStore,
    now: DEMO_NOW,
  };

  assert.equal((await evaluateE2BLiveCanaryPreIoGates()).code, 'E2B_LIVE_SOURCE_DISABLED');
  assert.equal((await evaluateE2BLiveCanaryPreIoGates({
    ...base,
    environment: {},
  })).code, 'E2B_DEMO_ENABLE_REQUIRED');
  assert.equal((await evaluateE2BLiveCanaryPreIoGates({
    ...base,
    request: { ...request, maximum_cost_usd: 0.00586 },
  })).code, 'E2B_CANARY_EXACT_REQUEST_REQUIRED');
  assert.equal((await evaluateE2BLiveCanaryPreIoGates({
    ...base,
    approvalArtifact: null,
  })).code, 'E2B_OWNER_APPROVAL_REQUIRED');
  const rejectedApproval = await evaluateE2BLiveCanaryPreIoGates({
    ...base,
    approvalAuthority: { async verifyApproval() { return { authenticated: false }; } },
  });
  assert.equal(rejectedApproval.code, 'E2B_OWNER_APPROVAL_REQUIRED');
  const missingKey = await evaluateE2BLiveCanaryPreIoGates({
    ...base,
    environment: { RISK_FORK_DEMO_E2B_ENABLED: 'true' },
  });
  assert.equal(missingKey.code, 'E2B_API_KEY_PRESENCE_REQUIRED');
  assert.equal(missingKey.approval_authenticated, true);
  const missingClaimStore = await evaluateE2BLiveCanaryPreIoGates({
    ...base,
    runClaimStore: null,
  });
  assert.equal(missingClaimStore.code, 'E2B_DURABLE_RUN_CLAIM_REQUIRED');
  const consumed = await evaluateE2BLiveCanaryPreIoGates({
    ...base,
    runClaimStore: {
      async claimOnce() {
        return { status: 'already_claimed', durable: true, atomic: true };
      },
    },
  });
  assert.equal(consumed.code, 'E2B_CANARY_RUN_ALREADY_CONSUMED');

  const eligible = await evaluateE2BLiveCanaryPreIoGates(base);
  assert.equal(eligible.status, 'eligible_pre_io');
  assert.equal(eligible.provider_io_allowed, true);
  assert.equal(eligible.provider_calls, 0);
  assert.equal(eligible.approval_authenticated, true);
  assert.equal(eligible.run_consumed, true);
  assert.equal(JSON.stringify(eligible).includes(base.environment.E2B_API_KEY), false);
  assert.equal(approvalCalls >= 3, true);
  assert.equal(claimCalls, 1);
});
