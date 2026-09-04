import assert from 'node:assert/strict';
import { mkdirSync } from 'node:fs';
import { chmod, link, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { sha256Ref, verifyRiskForkReceipt } from '../../src/index.mjs';
import {
  RISK_FORK_DEMO_BANNER,
  RISK_FORK_DEMO_LIMITS,
  RISK_FORK_DEMO_MINIMUM_NODE_MAJOR,
  RISK_FORK_DEMO_SUPPORTED_NODE_RANGE,
  RISK_FORK_DEMO_TAINT_EVIDENCE_HASH_BYTES,
  RISK_FORK_DEMO_TAINT_EVIDENCE_MAX_REFERENCE_BYTES,
  assertDemoResultReceiptBinding,
  createDemoEngine,
  evaluateDemoNodeRuntime,
  verifyDemoEnvelope,
} from '../src/demo-engine.mjs';
import { demoTrustedServerVerifier } from '../src/scenarios.mjs';
import {
  assertDemoTruth,
  initializeOwnedDemoRoot,
  removeOwnedDemoEntry,
  resolveOwnedDemoPath,
} from '../src/security.mjs';

async function temporaryRoot(t, prefix = 'risk-fork-demo-engine-test-') {
  const parent = await mkdtemp(path.join(os.tmpdir(), prefix));
  t.after(async () => { await rm(parent, { recursive: true, force: true }); });
  return path.join(parent, 'owned-root');
}

const ACTIVE_LOCK_SCHEMA = 'agoragentic.risk-fork.hackathon-active-lock.v1';

function activeLockRecord(handle, {
  runId = `run_${'a'.repeat(24)}`,
  lockId = `lock_${'b'.repeat(32)}`,
  rootId = handle.root_id,
  pid = 424_242,
  createdAt = '2035-01-01T00:00:00.000Z',
} = {}) {
  const base = {
    schema: ACTIVE_LOCK_SCHEMA,
    root_id: rootId,
    lock_id: lockId,
    run_id: runId,
    pid,
    created_at: createdAt,
    lock_hash: null,
  };
  return { ...base, lock_hash: sha256Ref(base) };
}

async function writeActiveLock(handle, record) {
  const lock = await resolveOwnedDemoPath(handle, '.active-run.lock');
  await writeFile(lock.absolute_path, `${JSON.stringify(record)}\n`, {
    encoding: 'utf8',
    flag: 'wx',
    mode: 0o600,
  });
  return lock;
}

async function makeCrashResidue(handle, runId) {
  for (const relative of [
    `runs/${runId}/source`,
    `runs/${runId}/adapter/forks/fork-residue`,
    `runs/${runId}/adapter/savepoints/savepoint-residue`,
    'records',
    'configs',
  ]) {
    const resolved = await resolveOwnedDemoPath(handle, relative);
    await mkdir(resolved.absolute_path, { recursive: true, mode: 0o700 });
  }
  const forkFile = await resolveOwnedDemoPath(
    handle,
    `runs/${runId}/adapter/forks/fork-residue/output.txt`,
  );
  await writeFile(forkFile.absolute_path, 'synthetic crash residue\n', { mode: 0o600 });
  const savepointFile = await resolveOwnedDemoPath(
    handle,
    `runs/${runId}/adapter/savepoints/savepoint-residue/input.txt`,
  );
  await writeFile(savepointFile.absolute_path, 'synthetic crash residue\n', { mode: 0o600 });
  const record = await resolveOwnedDemoPath(handle, `records/${runId}.json`);
  await writeFile(record.absolute_path, '{}\n', { mode: 0o600 });
  const config = await resolveOwnedDemoPath(handle, 'configs/generic-risk-fork-demo.json');
  await writeFile(config.absolute_path, '{}\n', { mode: 0o600 });
  const state = await resolveOwnedDemoPath(handle, 'state.json');
  await writeFile(state.absolute_path, '{}\n', { mode: 0o600 });
}

async function createQuarantine(handle) {
  const quarantine = await resolveOwnedDemoPath(handle, '.recovery-quarantine');
  await mkdir(quarantine.absolute_path, { mode: 0o700 });
  return quarantine;
}

async function assertQuarantineAdmissionBlocked({
  result,
  expectedCodes,
  root,
  forbiddenValues = [],
}) {
  assertTruth(result);
  assert.equal(result.final_state, 'blocked');
  assert.equal(result.exit_code, 2);
  assert.equal(result.validation_status, 'admission_blocked');
  assert.ok(expectedCodes.includes(result.failure.code));
  assert.equal(result.local_adapter_calls, 0);
  assert.equal(result.observer_records.length, 0);
  assert.equal(result.execution_mode, 'not_executed');
  assert.equal(result.savepoint_status, 'not_allocated');
  assert.equal(result.cleanup.status, 'unknown');
  assert.equal(result.cleanup.absence, 'unknown');
  assert.equal(result.demo_receipt.cleanup_status, 'unknown');
  assert.deepEqual(result.owned_run_cleanup, { status: 'not_applicable', removed: false });
  const serialized = JSON.stringify(result);
  assert.equal(serialized.includes(root), false);
  for (const value of forbiddenValues) assert.equal(serialized.includes(value), false);
}

function assertTruth(result) {
  assert.equal(assertDemoTruth(result), true);
  assert.equal(result.banner, RISK_FORK_DEMO_BANNER);
  assert.equal(result.demo_only, true);
  assert.equal(result.local_protocol_simulator, true);
  assert.equal(result.production_ready, false);
  assert.equal(result.live_traffic_protected, false);
  assert.equal(result.authority_granted, false);
  assert.equal(result.provider_calls, 0);
  assert.equal(result.network_used, false);
  assert.equal(result.credentials_used, false);
  assert.equal(result.clean_commit_performed, false);
  if (result.demo_receipt) assert.equal(assertDemoResultReceiptBinding(result), true);
}

test('shared Node runtime gate accepts >=20 and deterministically rejects a simulated unsupported version', () => {
  const supported = evaluateDemoNodeRuntime('20.0.0');
  assert.deepEqual(supported, {
    observed_major: 20,
    minimum_major: RISK_FORK_DEMO_MINIMUM_NODE_MAJOR,
    supported_range: RISK_FORK_DEMO_SUPPORTED_NODE_RANGE,
    supported: true,
  });
  assert.equal(Object.isFrozen(supported), true);

  const unsupported = evaluateDemoNodeRuntime('19.99.0');
  assert.equal(unsupported.observed_major, 19);
  assert.equal(unsupported.supported_range, '>=20');
  assert.equal(unsupported.supported, false);

  const malformed = evaluateDemoNodeRuntime('not-a-node-version');
  assert.equal(malformed.observed_major, null);
  assert.equal(malformed.supported, false);
  assert.equal(evaluateDemoNodeRuntime().supported, true);
});

test('construction, status, plan, and missing-root cleanup perform no filesystem writes', async (t) => {
  const root = await temporaryRoot(t);
  const engine = createDemoEngine({ rootDirectory: root });
  const status = engine.status();
  assert.equal(status.root_initialized_by_status, false);
  assert.equal(status.owned_root.absolute_path_redacted, true);
  assert.equal(status.owned_root.initialized_by_status, false);
  assert.match(status.owned_root.path_hash, /^sha256:[a-f0-9]{64}$/);
  assert.equal(engine.plan('low-read-only').decision.level, 'LOW');
  await assert.rejects(import('node:fs/promises').then(({ lstat }) => lstat(root)), {
    code: 'ENOENT',
  });
  const cleanup = await engine.cleanup();
  assertTruth(cleanup);
  assert.equal(cleanup.cleanup.status, 'verified');
  await assert.rejects(import('node:fs/promises').then(({ lstat }) => lstat(root)), {
    code: 'ENOENT',
  });
});

test('real classifier plans preserve deterministic LOW, ELEVATED, HIGH, and DENY decisions', () => {
  const engine = createDemoEngine();
  const expected = [
    ['low-read-only', 'LOW', 'ALLOW_DIRECT'],
    ['elevated-owner-policy', 'ELEVATED', 'OWNER_POLICY_DECIDES_FORK'],
    ['high-incomplete-metadata', 'HIGH', 'BLOCK_DIRECT_ROUTE_TO_RISK_FORK'],
    ['high-untrusted-discovery', 'HIGH', 'BLOCK_DIRECT_ROUTE_TO_RISK_FORK'],
    ['high-prompt-injection', 'HIGH', 'BLOCK_DIRECT_ROUTE_TO_RISK_FORK'],
    ['deny-owner-policy', 'IRREVERSIBLE', 'DENY'],
  ];
  for (const [scenario, level, directive] of expected) {
    const plan = engine.plan(scenario);
    assertTruth(plan);
    assert.equal(plan.decision.level, level);
    assert.equal(plan.decision.directive, directive);
    assert.equal(plan.decision.classifier_version, 'v1');
    assert.equal(plan.writes_performed, false);
  }
});

test('LOW, ELEVATED, and owner DENY perform zero local adapter execution', async (t) => {
  const root = await temporaryRoot(t);
  const engine = createDemoEngine({ rootDirectory: root });
  const cases = [
    ['low-read-only', 'direct_permitted', 'LOW'],
    ['elevated-owner-policy', 'fork_optional', 'ELEVATED'],
    ['deny-owner-policy', 'denied', 'IRREVERSIBLE'],
  ];
  for (const [scenario, state, level] of cases) {
    const result = await engine.run(scenario);
    assertTruth(result);
    assert.equal(result.final_state, state);
    assert.equal(result.decision.level, level);
    assert.equal(result.local_adapter_calls, 0);
    assert.equal(result.execution_mode, 'not_executed');
    assert.equal(result.exit_code, 0);
    assert.equal(verifyDemoEnvelope(result.demo_receipt), true);
  }
});

test('HIGH variants use the real local adapter and end prepared_not_committed', async (t) => {
  const root = await temporaryRoot(t);
  const engine = createDemoEngine({ rootDirectory: root });
  for (const scenario of [
    'high-filesystem-write',
    'high-incomplete-metadata',
    'high-untrusted-discovery',
    'high-prompt-injection',
  ]) {
    const result = await engine.run(scenario);
    assertTruth(result);
    assert.equal(result.decision.level, 'HIGH');
    assert.equal(result.final_state, 'prepared_not_committed');
    assert.equal(result.exit_code, 0);
    assert.equal(result.execution_mode, 'local_reference_protocol_execution');
    assert.equal(result.isolation_boundary, false);
    const executionRecord = result.observer_records.find((record) => (
      record.stage === 'execution_requested'
    ));
    assert.equal(executionRecord.execution_mode, 'local_reference_protocol_execution');
    assert.equal(executionRecord.isolation_boundary, false);
    assert.equal(result.lifecycle.verified, true);
    assert.equal(result.lifecycle.states.at(-1), 'CLEAN_COMMIT_READY');
    assert.equal(result.cleanup.status, 'verified');
    assert.equal(result.owned_run_cleanup.status, 'verified_absent');
    assert.ok(result.local_adapter_calls > 0);
    assert.equal(result.decision.classifier_version, 'v1');
    assert.deepEqual(result.limits, RISK_FORK_DEMO_LIMITS);
    assert.equal(result.tainted_output_evidence.status, 'sanitized_hash_only');
    assert.match(result.tainted_output_evidence.evidence_ref, /^demo-tainted-output:[a-f0-9]{24}$/);
    assert.match(result.tainted_output_evidence.evidence_hash, /^sha256:[a-f0-9]{64}$/);
    assert.equal(result.tainted_output_evidence.sanitized, true);
    assert.equal(result.tainted_output_evidence.raw_output_included, false);
    assert.ok(result.tainted_output_evidence.reference_bytes
      <= RISK_FORK_DEMO_TAINT_EVIDENCE_MAX_REFERENCE_BYTES);
    assert.equal(
      result.tainted_output_evidence.hash_bytes,
      RISK_FORK_DEMO_TAINT_EVIDENCE_HASH_BYTES,
    );
    assert.equal(Object.isFrozen(result.observer_records), true);
    assert.equal(Object.isFrozen(result.observer_records[0]), true);
    assert.equal(result.core_receipt_verified, true);
    assert.equal(verifyRiskForkReceipt(result.core_receipt, {
      risk_decision: result.risk_decision,
      trusted_server_verifier: demoTrustedServerVerifier,
    }), true);
    assert.equal(verifyDemoEnvelope(result.demo_receipt), true);
  }
});

test('IRREVERSIBLE work is prepare-only and never gains clean-commit authority', async (t) => {
  const root = await temporaryRoot(t);
  const result = await createDemoEngine({ rootDirectory: root })
    .run('irreversible-deployment-proposal');
  assertTruth(result);
  assert.equal(result.decision.level, 'IRREVERSIBLE');
  assert.equal(result.final_state, 'prepared_not_committed');
  assert.equal(result.execution_mode, 'prepare_only');
  assert.equal(result.prepared_artifact.type, 'CONSEQUENTIAL_ACTION_PROPOSAL');
  assert.equal(result.prepared_artifact.clean_commit_required, true);
  assert.equal(result.core_receipt_verified, true);
  assert.equal(result.exit_code, 0);
});

test('cleanup unknown, stale binding, and malformed hashes fail closed', async (t) => {
  const root = await temporaryRoot(t);
  const engine = createDemoEngine({ rootDirectory: root });
  const cleanupUnknown = await engine.run('cleanup-unknown');
  assertTruth(cleanupUnknown);
  assert.equal(cleanupUnknown.final_state, 'blocked');
  assert.equal(cleanupUnknown.cleanup.status, 'unknown');
  assert.equal(cleanupUnknown.cleanup.absence, 'verified');
  assert.equal(cleanupUnknown.exit_code, 2);
  assert.equal(cleanupUnknown.core_receipt, null);

  const stale = await engine.run('stale-governance-binding');
  assert.equal(stale.final_state, 'blocked');
  assert.equal(stale.validation_status, 'stale_binding_rejected');
  assert.equal(stale.cleanup.status, 'verified');
  assert.equal(stale.exit_code, 2);

  const tamper = await engine.run('malformed-lifecycle-receipt');
  assert.equal(tamper.final_state, 'blocked');
  assert.equal(tamper.exit_code, 2);
  assert.deepEqual(tamper.tamper_checks, {
    lifecycle_hash_rejected: true,
    receipt_hash_rejected: true,
  });
  const alteredDemoReceipt = structuredClone(tamper.demo_receipt);
  alteredDemoReceipt.final_state = 'prepared_not_committed';
  assert.throws(() => verifyDemoEnvelope(alteredDemoReceipt), /hash mismatch/);
});

test('receipt lookup returns exact truth-bearing found and not-found envelopes', async (t) => {
  const root = await temporaryRoot(t);
  const engine = createDemoEngine({ rootDirectory: root });
  const result = await engine.run('high-filesystem-write');
  const found = engine.getReceipt(result.run_id);
  assertTruth(found);
  assert.equal(found.found, true);
  assert.equal(found.receipt.demo_receipt_hash, result.demo_receipt.demo_receipt_hash);
  const missing = engine.getReceipt('run_missing_1234');
  assertTruth(missing);
  assert.equal(missing.found, false);
  assert.equal(missing.exit_code, 2);
});

test('all closed attack fixtures reject, exit nonzero, and remove their owned run', async (t) => {
  const root = await temporaryRoot(t);
  const engine = createDemoEngine({ rootDirectory: root });
  for (const scenario of [
    'attack-traversal',
    'attack-link',
    'attack-secret',
    'attack-oversized-write',
    'attack-timeout',
    'attack-concurrency',
  ]) {
    const result = await engine.run(scenario);
    assertTruth(result);
    assert.equal(result.final_state, 'blocked');
    assert.equal(result.exit_code, 2);
    assert.equal(result.attack_evidence.rejected, true);
    assert.equal(result.owned_run_cleanup.status, 'verified_absent');
    assert.equal(result.isolation_boundary, false);
    if (scenario === 'attack-timeout') {
      assert.equal(result.execution_mode, 'local_reference_protocol_execution');
      assert.equal(JSON.stringify(result).includes('isolated_execution'), false);
    }
  }
});

test('secret-shaped attack evidence never echoes the synthetic secret', async (t) => {
  const root = await temporaryRoot(t);
  const result = await createDemoEngine({ rootDirectory: root }).run('attack-secret');
  const serialized = JSON.stringify(result);
  const syntheticSecretPattern = new RegExp(['synthetic', 'secret', 'material'].join('_'), 'i');
  const secretFieldPattern = new RegExp(['api', 'key'].join('_'), 'i');
  assert.doesNotMatch(serialized, syntheticSecretPattern);
  assert.doesNotMatch(serialized, secretFieldPattern);
  assert.equal(result.failure.code, 'DEMO_ATTACK_INPUT_REJECTED');
});

test('completed-run count rejects the eleventh run and cleanup resets the allowance', async (t) => {
  const root = await temporaryRoot(t);
  const engine = createDemoEngine({ rootDirectory: root });
  for (let index = 1; index <= RISK_FORK_DEMO_LIMITS.max_completed_runs_before_reset; index += 1) {
    const result = await engine.run('low-read-only');
    assert.equal(result.exit_code, 0);
    assert.equal(result.completed_runs_after, index);
  }
  const blocked = await engine.run('low-read-only');
  assert.equal(blocked.exit_code, 2);
  assert.equal(blocked.failure.code, 'DEMO_COMPLETED_RUN_LIMIT');
  assert.equal(blocked.completed_runs_after, 10);
  assert.equal((await engine.cleanup()).cleanup.status, 'verified');
  const afterReset = await engine.run('low-read-only');
  assert.equal(afterReset.exit_code, 0);
  assert.equal(afterReset.completed_runs_after, 1);
});

test('post-lock state and workspace setup failures return blocked truth and release exact ownership', async (t) => {
  await t.test('invalid state is preserved while the exact run and active lock are verified absent', async (st) => {
    const root = await temporaryRoot(st, 'risk-fork-post-lock-state-failure-');
    const handle = await initializeOwnedDemoRoot(root);
    const state = await resolveOwnedDemoPath(handle, 'state.json');
    await writeFile(state.absolute_path, '{invalid-state\n', { flag: 'wx', mode: 0o600 });

    const result = await createDemoEngine({ rootDirectory: root }).run('high-filesystem-write');
    assertTruth(result);
    assert.equal(result.final_state, 'blocked');
    assert.equal(result.exit_code, 2);
    assert.equal(result.validation_status, 'setup_blocked');
    assert.equal(result.failure.code, 'DEMO_STATE_INVALID');
    assert.equal(result.completed_runs_after, null);
    assert.equal(result.cleanup.status, 'verified');
    assert.equal(result.cleanup.absence, 'verified');
    assert.equal(result.demo_receipt.cleanup_status, 'verified');
    assert.equal(result.owned_run_cleanup.status, 'verified_absent');
    assert.equal((await resolveOwnedDemoPath(handle, '.active-run.lock')).exists, false);
    assert.equal((await resolveOwnedDemoPath(handle, 'runs')).exists, false);
    assert.equal(await readFile(state.absolute_path, 'utf8'), '{invalid-state\n');
  });

  await t.test('runs-file collision is preserved and does not leak a lock or increment state', async (st) => {
    const root = await temporaryRoot(st, 'risk-fork-post-lock-workspace-failure-');
    const handle = await initializeOwnedDemoRoot(root);
    const runs = await resolveOwnedDemoPath(handle, 'runs');
    const collisionEvidence = 'synthetic-runs-type-collision\n';
    await writeFile(runs.absolute_path, collisionEvidence, { flag: 'wx', mode: 0o600 });
    const engine = createDemoEngine({ rootDirectory: root });

    const result = await engine.run('high-filesystem-write');
    assertTruth(result);
    assert.equal(result.final_state, 'blocked');
    assert.equal(result.exit_code, 2);
    assert.equal(result.validation_status, 'setup_blocked');
    assert.equal(result.failure.code, 'DEMO_PATH_TYPE_MISMATCH');
    assert.equal(result.completed_runs_after, 0);
    assert.equal(result.cleanup.status, 'verified');
    assert.equal(result.cleanup.absence, 'verified');
    assert.equal(result.demo_receipt.cleanup_status, 'verified');
    assert.equal(result.owned_run_cleanup.status, 'verified_absent');
    assert.equal(result.local_adapter_calls, 0);
    assert.equal(await readFile(runs.absolute_path, 'utf8'), collisionEvidence);
    assert.equal((await resolveOwnedDemoPath(handle, '.active-run.lock')).exists, false);
    assert.equal((await resolveOwnedDemoPath(handle, 'state.json')).exists, false);

    await removeOwnedDemoEntry(handle, 'runs');
    const retry = await engine.run('low-read-only');
    assert.equal(retry.exit_code, 0);
    assert.equal(retry.completed_runs_after, 1);
  });
});

test('cleanup removes generated configs only beneath the marker-bound root', async (t) => {
  const root = await temporaryRoot(t);
  const handle = await initializeOwnedDemoRoot(root);
  const configs = await resolveOwnedDemoPath(handle, 'configs');
  await mkdir(configs.absolute_path, { recursive: false, mode: 0o700 });
  const generated = await resolveOwnedDemoPath(handle, 'configs/synthetic-client.json');
  await writeFile(generated.absolute_path, '{}\n', {
    encoding: 'utf8',
    flag: 'wx',
    mode: 0o600,
  });
  const cleanup = await createDemoEngine({ rootDirectory: root }).cleanup();
  assert.equal(cleanup.cleanup.status, 'verified');
  assert.equal((await resolveOwnedDemoPath(handle, 'configs')).exists, false);
});

test('cleanup recovers one exact dead and aged crash lock without deleting outside the owned root', async (t) => {
  const root = await temporaryRoot(t, 'risk-fork-stale-lock-success-');
  const handle = await initializeOwnedDemoRoot(root);
  const runId = `run_${'1'.repeat(24)}`;
  await makeCrashResidue(handle, runId);
  await writeActiveLock(handle, activeLockRecord(handle, {
    runId,
    createdAt: '2034-12-31T23:59:00.000Z',
  }));
  const outside = path.join(path.dirname(root), 'outside-sentinel.txt');
  await writeFile(outside, 'must survive\n', { mode: 0o600 });

  const cleanup = await createDemoEngine({
    rootDirectory: root,
    clock: () => new Date('2035-01-01T00:00:00.000Z'),
    ownerLiveness: () => 'dead',
    staleLockGraceMs: 30_000,
  }).cleanup();

  assert.equal(cleanup.exit_code, 0);
  assert.equal(cleanup.cleanup.status, 'verified');
  assert.equal(cleanup.cleanup.stale_lock_recovered, true);
  assert.equal(cleanup.cleanup.recovered_run_id, runId);
  for (const status of Object.values(cleanup.cleanup.verification)) {
    assert.equal(status, 'verified_absent');
  }
  assert.equal(await readFile(outside, 'utf8'), 'must survive\n');
  assert.equal((await resolveOwnedDemoPath(handle, '.active-run.lock')).exists, false);
  assert.equal((await resolveOwnedDemoPath(handle, '.cleanup-recovery.lock')).exists, false);
  assert.equal((await resolveOwnedDemoPath(handle, `runs/${runId}`)).exists, false);
});

test('cleanup refuses live, young, malformed, mismatched, and raced locks; a dead young lock succeeds after grace', async (t) => {
  await t.test('live owner', async (st) => {
    const root = await temporaryRoot(st, 'risk-fork-stale-lock-live-');
    const handle = await initializeOwnedDemoRoot(root);
    await writeActiveLock(handle, activeLockRecord(handle, {
      createdAt: '2034-12-31T23:00:00.000Z',
    }));
    const result = await createDemoEngine({
      rootDirectory: root,
      clock: () => new Date('2035-01-01T00:00:00.000Z'),
      ownerLiveness: () => 'live',
    }).cleanup();
    assert.equal(result.exit_code, 2);
    assert.equal(result.failure.code, 'DEMO_ACTIVE_LOCK_LIVE');
    assert.equal((await resolveOwnedDemoPath(handle, '.active-run.lock')).exists, true);
  });

  await t.test('indeterminate owner', async (st) => {
    const root = await temporaryRoot(st, 'risk-fork-stale-lock-indeterminate-');
    const handle = await initializeOwnedDemoRoot(root);
    await writeActiveLock(handle, activeLockRecord(handle, {
      createdAt: '2034-12-31T23:00:00.000Z',
    }));
    const result = await createDemoEngine({
      rootDirectory: root,
      clock: () => new Date('2035-01-01T00:00:00.000Z'),
      ownerLiveness: () => 'indeterminate',
    }).cleanup();
    assert.equal(result.exit_code, 2);
    assert.equal(result.failure.code, 'DEMO_ACTIVE_LOCK_LIVENESS_UNKNOWN');
    assert.equal((await resolveOwnedDemoPath(handle, '.active-run.lock')).exists, true);
  });

  await t.test('young then retry after grace', async (st) => {
    const root = await temporaryRoot(st, 'risk-fork-stale-lock-young-');
    const handle = await initializeOwnedDemoRoot(root);
    let now = Date.parse('2035-01-01T00:00:00.000Z');
    await writeActiveLock(handle, activeLockRecord(handle, {
      runId: `run_${'2'.repeat(24)}`,
      createdAt: '2034-12-31T23:59:59.000Z',
    }));
    const engine = createDemoEngine({
      rootDirectory: root,
      clock: () => new Date(now),
      ownerLiveness: () => 'dead',
      staleLockGraceMs: 30_000,
    });
    const first = await engine.cleanup();
    assert.equal(first.exit_code, 2);
    assert.equal(first.failure.code, 'DEMO_ACTIVE_LOCK_YOUNG');
    now += 31_000;
    const retried = await engine.cleanup();
    assert.equal(retried.exit_code, 0);
    assert.equal(retried.cleanup.stale_lock_recovered, true);
  });

  await t.test('malformed lock', async (st) => {
    const root = await temporaryRoot(st, 'risk-fork-stale-lock-malformed-');
    const handle = await initializeOwnedDemoRoot(root);
    const lock = await resolveOwnedDemoPath(handle, '.active-run.lock');
    await writeFile(lock.absolute_path, '{malformed\n', { flag: 'wx', mode: 0o600 });
    const result = await createDemoEngine({ rootDirectory: root }).cleanup();
    assert.equal(result.exit_code, 2);
    assert.equal(result.failure.code, 'DEMO_ACTIVE_LOCK_INVALID');
    assert.equal((await resolveOwnedDemoPath(handle, '.active-run.lock')).exists, true);
  });

  await t.test('mismatched root binding', async (st) => {
    const root = await temporaryRoot(st, 'risk-fork-stale-lock-mismatch-');
    const handle = await initializeOwnedDemoRoot(root);
    await writeActiveLock(handle, activeLockRecord(handle, {
      rootId: `demo-root-${'f'.repeat(32)}`,
    }));
    const result = await createDemoEngine({ rootDirectory: root }).cleanup();
    assert.equal(result.exit_code, 2);
    assert.equal(result.failure.code, 'DEMO_ACTIVE_LOCK_INVALID');
    assert.equal((await resolveOwnedDemoPath(handle, '.active-run.lock')).exists, true);
  });

  await t.test('lock changes during recovery', async (st) => {
    const root = await temporaryRoot(st, 'risk-fork-stale-lock-race-');
    const handle = await initializeOwnedDemoRoot(root);
    const runId = `run_${'3'.repeat(24)}`;
    const lock = await writeActiveLock(handle, activeLockRecord(handle, {
      runId,
      createdAt: '2034-12-31T23:00:00.000Z',
    }));
    let changed = false;
    const result = await createDemoEngine({
      rootDirectory: root,
      clock: () => new Date('2035-01-01T00:00:00.000Z'),
      ownerLiveness: async () => {
        if (!changed) {
          changed = true;
          const replacement = activeLockRecord(handle, {
            runId,
            lockId: `lock_${'c'.repeat(32)}`,
            createdAt: '2034-12-31T23:00:00.000Z',
          });
          await writeFile(lock.absolute_path, `${JSON.stringify(replacement)}\n`, { mode: 0o600 });
        }
        return 'dead';
      },
    }).cleanup();
    assert.equal(result.exit_code, 2);
    assert.equal(result.failure.code, 'DEMO_ACTIVE_LOCK_RACE');
    assert.equal((await resolveOwnedDemoPath(handle, '.active-run.lock')).exists, true);
    assert.equal((await resolveOwnedDemoPath(handle, '.recovery-quarantine')).exists, false);
  });
});

test('quarantine admission fails closed before allocation and preserves unresolved evidence', async (t) => {
  await t.test('nonempty quarantine blocks HIGH and IRREVERSIBLE until exact reconciliation', async (st) => {
    const root = await temporaryRoot(st, 'risk-fork-quarantine-nonempty-');
    const handle = await initializeOwnedDemoRoot(root);
    await createQuarantine(handle);
    const marker = 'synthetic-unresolved-quarantine-evidence';
    const evidence = await resolveOwnedDemoPath(handle, '.recovery-quarantine/unresolved.json');
    await writeFile(evidence.absolute_path, `${marker}\n`, { mode: 0o600 });
    const outside = path.join(path.dirname(root), 'outside-nonempty.txt');
    await writeFile(outside, 'outside must survive\n', { mode: 0o600 });
    const engine = createDemoEngine({ rootDirectory: root });

    for (const scenario of ['high-filesystem-write', 'irreversible-deployment-proposal']) {
      const result = await engine.run(scenario);
      await assertQuarantineAdmissionBlocked({
        result,
        expectedCodes: ['DEMO_RECOVERY_QUARANTINE_NOT_EMPTY'],
        root,
        forbiddenValues: [marker],
      });
    }
    assert.equal(await readFile(evidence.absolute_path, 'utf8'), `${marker}\n`);
    assert.equal(await readFile(outside, 'utf8'), 'outside must survive\n');
    assert.equal((await resolveOwnedDemoPath(handle, 'runs')).exists, false);
    assert.equal((await resolveOwnedDemoPath(handle, '.active-run.lock')).exists, false);
    assert.equal((await resolveOwnedDemoPath(handle, '.cleanup-recovery.lock')).exists, false);

    const blockedCleanup = await engine.cleanup();
    assert.equal(blockedCleanup.exit_code, 2);
    assert.equal(blockedCleanup.cleanup.status, 'unknown');
    assert.equal(blockedCleanup.failure.code, 'DEMO_RECOVERY_QUARANTINE_NOT_EMPTY');
    assert.equal(await readFile(evidence.absolute_path, 'utf8'), `${marker}\n`);
    await rm(evidence.absolute_path, { force: false });
    const reconciled = await engine.cleanup();
    assert.equal(reconciled.exit_code, 0);
    assert.equal(reconciled.cleanup.status, 'verified');
    assert.equal(await readFile(outside, 'utf8'), 'outside must survive\n');
  });

  await t.test('unreadable unresolved quarantine evidence remains blocked and preserved', async (st) => {
    const root = await temporaryRoot(st, 'risk-fork-quarantine-unreadable-');
    const handle = await initializeOwnedDemoRoot(root);
    await createQuarantine(handle);
    const sealed = await resolveOwnedDemoPath(handle, '.recovery-quarantine/sealed-evidence');
    await mkdir(sealed.absolute_path, { mode: 0o700 });
    await chmod(sealed.absolute_path, 0o000);
    const outside = path.join(path.dirname(root), 'outside-unreadable.txt');
    await writeFile(outside, 'outside must survive\n', { mode: 0o600 });

    const result = await createDemoEngine({ rootDirectory: root }).run('high-filesystem-write');
    await assertQuarantineAdmissionBlocked({
      result,
      expectedCodes: [
        'DEMO_RECOVERY_QUARANTINE_NOT_EMPTY',
        'DEMO_RECOVERY_QUARANTINE_UNKNOWN',
      ],
      root,
    });
    assert.equal(await readFile(outside, 'utf8'), 'outside must survive\n');
    const blockedCleanup = await createDemoEngine({ rootDirectory: root }).cleanup();
    assert.equal(blockedCleanup.exit_code, 2);
    assert.equal(blockedCleanup.cleanup.status, 'unknown');
    await chmod(sealed.absolute_path, 0o700);
    await rm(sealed.absolute_path, { recursive: true, force: false });
    const reconciled = await createDemoEngine({ rootDirectory: root }).cleanup();
    assert.equal(reconciled.exit_code, 0);
    assert.equal(await readFile(outside, 'utf8'), 'outside must survive\n');
  });

  await t.test('malformed quarantine type fails closed without deleting it', async (st) => {
    const root = await temporaryRoot(st, 'risk-fork-quarantine-malformed-');
    const handle = await initializeOwnedDemoRoot(root);
    const quarantine = await resolveOwnedDemoPath(handle, '.recovery-quarantine');
    const marker = 'synthetic-malformed-quarantine-evidence';
    await writeFile(quarantine.absolute_path, `${marker}\n`, { mode: 0o600 });
    const outside = path.join(path.dirname(root), 'outside-malformed.txt');
    await writeFile(outside, 'outside must survive\n', { mode: 0o600 });

    const result = await createDemoEngine({ rootDirectory: root }).run('high-filesystem-write');
    await assertQuarantineAdmissionBlocked({
      result,
      expectedCodes: ['DEMO_RECOVERY_QUARANTINE_UNKNOWN'],
      root,
      forbiddenValues: [marker],
    });
    assert.equal(await readFile(quarantine.absolute_path, 'utf8'), `${marker}\n`);
    const blockedCleanup = await createDemoEngine({ rootDirectory: root }).cleanup();
    assert.equal(blockedCleanup.exit_code, 2);
    assert.equal(blockedCleanup.cleanup.status, 'unknown');
    assert.equal(await readFile(quarantine.absolute_path, 'utf8'), `${marker}\n`);
    await rm(quarantine.absolute_path, { force: false });
    const reconciled = await createDemoEngine({ rootDirectory: root }).cleanup();
    assert.equal(reconciled.exit_code, 0);
    assert.equal(await readFile(outside, 'utf8'), 'outside must survive\n');
  });

  await t.test('hard-linked quarantine evidence fails closed and preserves the outside inode', async (st) => {
    const root = await temporaryRoot(st, 'risk-fork-quarantine-linked-');
    const handle = await initializeOwnedDemoRoot(root);
    await createQuarantine(handle);
    const outside = path.join(path.dirname(root), 'outside-linked.txt');
    const marker = 'synthetic-linked-quarantine-evidence';
    await writeFile(outside, `${marker}\n`, { mode: 0o600 });
    const linked = await resolveOwnedDemoPath(handle, '.recovery-quarantine/linked-evidence.txt');
    await link(outside, linked.absolute_path);

    const result = await createDemoEngine({ rootDirectory: root }).run('high-filesystem-write');
    await assertQuarantineAdmissionBlocked({
      result,
      expectedCodes: ['DEMO_RECOVERY_QUARANTINE_NOT_EMPTY'],
      root,
      forbiddenValues: [marker, outside],
    });
    assert.equal(await readFile(outside, 'utf8'), `${marker}\n`);
    assert.equal(await readFile(linked.absolute_path, 'utf8'), `${marker}\n`);
    const blockedCleanup = await createDemoEngine({ rootDirectory: root }).cleanup();
    assert.equal(blockedCleanup.exit_code, 2);
    assert.equal(blockedCleanup.cleanup.status, 'unknown');
    await rm(linked.absolute_path, { force: false });
    const reconciled = await createDemoEngine({ rootDirectory: root }).cleanup();
    assert.equal(reconciled.exit_code, 0);
    assert.equal(await readFile(outside, 'utf8'), `${marker}\n`);
  });

  await t.test('quarantine creation between locked snapshots is detected before allocation', async (st) => {
    const root = await temporaryRoot(st, 'risk-fork-quarantine-race-');
    const handle = await initializeOwnedDemoRoot(root);
    const quarantine = await resolveOwnedDemoPath(handle, '.recovery-quarantine');
    const outside = path.join(path.dirname(root), 'outside-race.txt');
    await writeFile(outside, 'outside must survive\n', { mode: 0o600 });
    let clockCalls = 0;
    const clock = () => {
      clockCalls += 1;
      if (clockCalls === 2) mkdirSync(quarantine.absolute_path, { mode: 0o700 });
      return new Date('2035-01-01T00:00:00.000Z');
    };

    const result = await createDemoEngine({ rootDirectory: root, clock })
      .run('high-filesystem-write');
    await assertQuarantineAdmissionBlocked({
      result,
      expectedCodes: ['DEMO_RECOVERY_QUARANTINE_CHANGED'],
      root,
    });
    assert.equal(clockCalls, 2);
    assert.equal((await resolveOwnedDemoPath(handle, '.recovery-quarantine')).exists, true);
    assert.equal((await resolveOwnedDemoPath(handle, '.active-run.lock')).exists, false);
    assert.equal((await resolveOwnedDemoPath(handle, '.cleanup-recovery.lock')).exists, false);
    assert.equal((await resolveOwnedDemoPath(handle, 'runs')).exists, false);
    assert.equal(await readFile(outside, 'utf8'), 'outside must survive\n');
    const cleanup = await createDemoEngine({ rootDirectory: root }).cleanup();
    assert.equal(cleanup.exit_code, 0);
    assert.equal(cleanup.cleanup.status, 'verified');
    assert.equal(await readFile(outside, 'utf8'), 'outside must survive\n');
  });
});

test('a marker-bound foreign lock blocks admission without being removed', async (t) => {
  const root = await temporaryRoot(t);
  const handle = await initializeOwnedDemoRoot(root);
  const lock = await resolveOwnedDemoPath(handle, '.active-run.lock');
  await writeFile(lock.absolute_path, 'synthetic-foreign-run\n', {
    encoding: 'utf8',
    flag: 'wx',
    mode: 0o600,
  });
  const blocked = await createDemoEngine({ rootDirectory: root }).run('high-filesystem-write');
  assert.equal(blocked.exit_code, 2);
  assert.equal(blocked.failure.code, 'DEMO_CONCURRENCY_LIMIT');
  assert.equal((await resolveOwnedDemoPath(handle, '.active-run.lock')).exists, true);
  await removeOwnedDemoEntry(handle, '.active-run.lock');
});

test('abort closes admissions and shares verified active-run cleanup', async (t) => {
  const root = await temporaryRoot(t);
  const engine = createDemoEngine({ rootDirectory: root });
  const running = engine.run('attack-timeout');
  const deadline = Date.now() + 2_000;
  while (!engine.status().active_in_this_process && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  assert.equal(engine.status().active_in_this_process, true);
  const firstAbort = engine.abort();
  const secondAbort = engine.abort();
  assert.equal(firstAbort, secondAbort);
  const [result, abortResult] = await Promise.all([running, firstAbort]);
  assertTruth(result);
  assertTruth(abortResult);
  assert.equal(abortResult.cleanup.status, 'verified');
  assert.equal(engine.status().admissions_closed, true);
  const blocked = await engine.run('low-read-only');
  assert.equal(blocked.failure.code, 'DEMO_ADMISSIONS_CLOSED');
});
