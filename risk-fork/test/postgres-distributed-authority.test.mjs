import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

import { PostgresDistributedCommitAuthority } from '../src/adapters/postgres-authority.mjs';
import { sha256Ref } from '../src/canonical.mjs';
import { buildExecutionBinding } from '../src/contracts.mjs';

const POSTGRES_URL = process.env.RISK_FORK_TEST_POSTGRES_URL;
const POSTGRES_SKIP = POSTGRES_URL
  ? false
  : 'requires RISK_FORK_TEST_POSTGRES_URL pointing to an isolated PostgreSQL test database';
const WORKER_PATH = fileURLToPath(
  new URL('./fixtures/postgres-authority-worker.mjs', import.meta.url),
);
const HASH = (value) => sha256Ref(value);

function createGovernance(tag) {
  return {
    policy: {
      ref: `policy:${tag}`,
      version: 'policy-v1',
      hash: HASH(`policy:${tag}`),
    },
    mandate: {
      ref: `mandate:${tag}`,
      version: 'mandate-v1',
      hash: HASH(`mandate:${tag}`),
    },
    budget_policy: {
      ref: `budget:${tag}`,
      version: 'budget-v1',
      hash: HASH(`budget:${tag}`),
      usage_hash: HASH(`budget-usage:${tag}`),
      available_amount: '100.00',
      currency: 'USDC',
      payment_rail: 'x402:base',
    },
    epoch: `governance-epoch:${tag}`,
    commit_policy: { max_result_bytes: 4096 },
    evidence_ref: `governance-evidence:${tag}`,
    evidence_hash: HASH(`governance-evidence:${tag}`),
  };
}

function createFixture(tag, { consequential = false } = {}) {
  const governance = createGovernance(tag);
  const governanceHash = HASH(governance);
  const parentRef = `parent:${tag}`;
  const headHash = HASH(`parent-head:${tag}`);
  const artifactHash = HASH(`artifact:${tag}`);
  const capsuleHash = HASH(`capsule:${tag}`);
  const approvalEvidenceRef = `approval:${tag}`;
  const approvalEvidenceHash = HASH(`approval:${tag}`);
  let authorization = null;
  let authorizationRegistration = null;
  if (consequential) {
    const authorizationId = `authorization:${tag}`;
    const authorizationRef = `authorization-ref:${tag}`;
    const authorizationHash = HASH(`authorization-record:${tag}`);
    const binding = buildExecutionBinding({
      principal_ref: `principal:${tag}`,
      action_operation: 'payment',
      fork_agent_id: `fork-agent:${tag}`,
      session_id: `fork-session:${tag}`,
      mcp_server_ref: `mcp-server:${tag}`,
      mcp_server_origin: 'https://mcp.example.invalid/',
      mcp_method: 'tools/call',
      tool_name: 'settle_invoice',
      effective_arguments: { invoice_ref: `invoice:${tag}` },
      provider_ref: `provider:${tag}`,
      target_ref: `target:${tag}`,
      amount: '1.25',
      currency: 'USDC',
      payment_rail: 'x402:base',
      policy_ref: governance.policy.ref,
      policy_version: governance.policy.version,
      policy_hash: governance.policy.hash,
      mandate_ref: governance.mandate.ref,
      mandate_version: governance.mandate.version,
      mandate_hash: governance.mandate.hash,
      budget_policy_ref: governance.budget_policy.ref,
      budget_version: governance.budget_policy.version,
      budget_hash: governance.budget_policy.hash,
      governance_epoch: governance.epoch,
      issued_at: '2025-01-01T00:00:00.000Z',
      not_before: '2025-01-01T00:00:00.000Z',
      expires_at: '2099-01-01T00:00:00.000Z',
      nonce: `nonce:${tag}`,
      one_use_authorization_id: authorizationId,
      audience: 'risk-fork-clean-controller',
      authorization_ref: authorizationRef,
      authorization_hash: authorizationHash,
    });
    authorization = {
      authorization_id: authorizationId,
      authorization_ref: authorizationRef,
      authorization_hash: authorizationHash,
      binding_hash: binding.binding_hash,
      binding,
      governance_evidence_ref: governance.evidence_ref,
      governance_evidence_hash: governance.evidence_hash,
    };
    authorizationRegistration = {
      authorization_id: authorizationId,
      authorization_ref: authorizationRef,
      authorization_hash: authorizationHash,
      binding_hash: binding.binding_hash,
      expires_at: binding.validity.expires_at,
      evidence_ref: `authorization-registration:${tag}`,
      evidence_hash: HASH(`authorization-registration:${tag}`),
    };
  }
  const commitType = consequential
    ? 'CONSEQUENTIAL_ACTION_PROPOSAL'
    : 'TYPED_RESULT';
  return {
    tag,
    governance,
    governanceHash,
    parentRef,
    headHash,
    approval: {
      parent_ref: parentRef,
      artifact_hash: artifactHash,
      capsule_hash: capsuleHash,
      parent_state_hash: headHash,
      commit_type: commitType,
      governance_hash: governanceHash,
      evidence_ref: approvalEvidenceRef,
      evidence_hash: approvalEvidenceHash,
    },
    authorizationRegistration,
    request: {
      parent_ref: parentRef,
      expected_parent_head_hash: headHash,
      artifact_hash: artifactHash,
      capsule_hash: capsuleHash,
      capsule_expires_at: '2099-01-01T00:00:00.000Z',
      commit_type: commitType,
      governance_hash: governanceHash,
      approval_evidence_ref: approvalEvidenceRef,
      approval_evidence_hash: approvalEvidenceHash,
      authority_request_hash: HASH({ schema: 'clean-authority-request:test', tag }),
      authorization,
    },
  };
}

function authorizationProof(request) {
  return {
    schema: 'agoragentic.risk-fork.distributed-authorization-verification.v1',
    status: 'verified',
    verification_request_hash: request.verification_request_hash,
    authorization_id: request.authorization_id,
    authorization_ref: request.authorization_ref,
    authorization_hash: request.authorization_hash,
    binding_hash: request.binding_hash,
    signature_status: 'verified',
    integrity_status: 'verified',
    exact_binding_status: 'verified',
    evidence_ref: 'postgres-test-verifier:authorization',
    evidence_hash: HASH('postgres-test-verifier:authorization'),
  };
}

function reconciliationProof(request) {
  return {
    schema: 'agoragentic.risk-fork.distributed-reconciliation-verification.v1',
    status: 'verified',
    verification_request_hash: request.verification_request_hash,
    operation_ref: request.operation_ref,
    operation_version: request.operation_version,
    effect_key: request.effect_key,
    resolution: request.resolution,
    result_hash: request.result_hash,
    evidence_ref: 'postgres-test-verifier:reconciliation',
    evidence_hash: HASH('postgres-test-verifier:reconciliation'),
  };
}

function gateProof(request) {
  return {
    schema: 'agoragentic.risk-fork.distributed-final-gate-verification.v1',
    status: 'verified',
    request_hash: request.request_hash,
    authority_request_hash: request.authority_request_hash,
    governance_hash: request.governance_hash,
  };
}

async function createHarness(t, fixture) {
  const suffix = randomBytes(6).toString('hex');
  const schemaName = `risk_fork_test_${process.pid}_${suffix}`;
  const authorityId = `authority:test:${suffix}`;
  const authorities = [];
  const { Pool } = await import('pg');
  const inspection = new Pool({
    connectionString: POSTGRES_URL,
    max: 2,
    application_name: 'agoragentic-risk-fork-test-inspection',
  });
  const authorityOptions = {
    connectionString: POSTGRES_URL,
    authorityId,
    schemaName,
    verifyAuthorizationIntegrity: async (request) => authorizationProof(request),
    verifyReconciliation: async (request) => reconciliationProof(request),
  };
  const createAuthority = async () => {
    const authority = new PostgresDistributedCommitAuthority(authorityOptions);
    await authority.initialize();
    authorities.push(authority);
    return authority;
  };
  const authority = await createAuthority();
  t.after(async () => {
    await Promise.all(authorities.map((entry) => entry.close().catch(() => {})));
    await inspection.query(`DROP SCHEMA IF EXISTS "${schemaName}" CASCADE`);
    await inspection.end();
  });
  await authority.seedParentHead({ parent_ref: fixture.parentRef, head_hash: fixture.headHash });
  await authority.setCurrentGovernance({
    parent_ref: fixture.parentRef,
    governance: fixture.governance,
  });
  await authority.registerCommitApproval(fixture.approval);
  if (fixture.authorizationRegistration) {
    await authority.registerExecutionAuthorization(fixture.authorizationRegistration);
  }
  return {
    authority,
    authorityId,
    authorityOptions,
    createAuthority,
    inspection,
    schemaName,
  };
}

function startWorker(harness, fixture, mode = 'normal') {
  const child = spawn(process.execPath, [WORKER_PATH], {
    stdio: ['pipe', 'pipe', 'pipe'],
    windowsHide: true,
  });
  let stdoutBuffer = '';
  let stderr = '';
  const events = [];
  let resolveInitialized;
  let rejectInitialized;
  const initialized = mode === 'wait_after_initialize'
    ? new Promise((resolve, reject) => {
        resolveInitialized = resolve;
        rejectInitialized = reject;
      })
    : Promise.resolve();
  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  child.stdout.on('data', (chunk) => {
    stdoutBuffer += chunk;
    const lines = stdoutBuffer.split(/\r?\n/);
    stdoutBuffer = lines.pop() ?? '';
    for (const line of lines.filter(Boolean)) {
      const event = JSON.parse(line);
      events.push(event);
      if (event.type === 'initialized') resolveInitialized?.();
    }
  });
  child.stderr.on('data', (chunk) => { stderr += chunk; });
  child.stdin.write(`${JSON.stringify({
    connection_string: POSTGRES_URL,
    authority_id: harness.authorityId,
    schema_name: harness.schemaName,
    claimant_ref: `worker:${randomBytes(4).toString('hex')}`,
    mode,
    request: fixture.request,
  })}\n`);
  if (mode !== 'wait_after_initialize') child.stdin.end();
  const done = new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('exit', (code, signal) => {
      if (stdoutBuffer.trim()) events.push(JSON.parse(stdoutBuffer));
      if (mode === 'wait_after_initialize'
        && !events.some((event) => event.type === 'initialized')) {
        rejectInitialized(new Error('PostgreSQL authority worker exited before initialization'));
      }
      resolve({ code, signal, events, stderr });
    });
  });
  const continueRun = () => {
    if (mode !== 'wait_after_initialize') {
      throw new Error('Only a waiting PostgreSQL authority worker can be continued');
    }
    child.stdin.end(`${JSON.stringify({ command: 'continue' })}\n`);
  };
  return { child, done, initialized, continueRun };
}

async function waitForOperation(inspection, schemaName, status, timeoutMs = 10_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const result = await inspection.query(
      `SELECT operation_ref, status, version FROM "${schemaName}".operations WHERE status = $1`,
      [status],
    );
    if (result.rowCount > 0) return result.rows[0];
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`timed out waiting for PostgreSQL operation status ${status}`);
}

test('independent processes share one exact request fence and one effect invocation', {
  skip: POSTGRES_SKIP,
}, async (t) => {
  const fixture = createFixture('process-race');
  const harness = await createHarness(t, fixture);
  const workers = [startWorker(harness, fixture), startWorker(harness, fixture)];
  const results = await Promise.all(workers.map((worker) => worker.done));

  for (const result of results) {
    assert.equal(result.code, 0, result.stderr);
  }
  const events = results.flatMap((result) => result.events);
  assert.equal(events.filter((event) => event.type === 'effect_invoked').length, 1);
  assert.ok(events.some((event) => event.type === 'finished' && event.ok));

  let replayInvocations = 0;
  const replay = await harness.authority.runCommit(fixture.request, {
    claimant_ref: 'worker:replay',
    verifyUnderReservation: async (request) => gateProof(request),
    performEffect: () => {
      replayInvocations += 1;
      return { forbidden: true };
    },
  });
  assert.equal(replay.status, 'committed');
  assert.equal(replay.idempotent, true);
  assert.equal(replayInvocations, 0);

  const audit = await harness.authority.getAuditTrail();
  assert.equal(audit.verified, true);
  assert.deepEqual(
    audit.events.map((event) => event.sequence),
    audit.events.map((_, index) => index + 1),
  );
  assert.equal(audit.events.filter((event) => event.event_type === 'effect_started').length, 1);
  assert.equal(audit.events.filter((event) => event.event_type === 'commit_finalized').length, 1);
});

test('a process crash after the durable effect claim never auto-invokes again and requires reconciliation', {
  skip: POSTGRES_SKIP,
}, async (t) => {
  const fixture = createFixture('effect-crash', { consequential: true });
  const harness = await createHarness(t, fixture);
  const crashed = await startWorker(harness, fixture, 'crash_after_effect_claim').done;

  assert.equal(crashed.code, 72, crashed.stderr);
  assert.equal(crashed.events.filter((event) => event.type === 'effect_invoked').length, 1);
  const unresolved = await harness.authority.listUnresolved();
  assert.equal(unresolved.operations.length, 1);
  assert.equal(unresolved.operations[0].status, 'effect_started');

  let retryInvocations = 0;
  await assert.rejects(
    harness.authority.runCommit(fixture.request, {
      claimant_ref: 'worker:forbidden-retry',
      verifyUnderReservation: async (request) => gateProof(request),
      performEffect: () => { retryInvocations += 1; },
    }),
    (error) => error.code === 'RISK_FORK_DISTRIBUTED_COMMIT_AMBIGUOUS',
  );
  assert.equal(retryInvocations, 0);

  const reconciled = await harness.authority.reconcileOperation({
    operation_ref: unresolved.operations[0].operation_ref,
    expected_version: unresolved.operations[0].version,
    resolution: 'effect_absent',
    requested_by: 'operator:effect-crash-test',
    outcome_evidence_ref: 'provider-outcome:effect-absent',
    outcome_evidence_hash: HASH('provider-outcome:effect-absent'),
  });
  assert.equal(reconciled.operation.status, 'ambiguous');
  assert.equal(
    reconciled.operation.failure_code,
    'RECONCILIATION_EFFECT_ABSENT_UNSAFE_TO_RELEASE',
  );
  const failedReconciliation = await harness.authority.reconcileOperation({
    operation_ref: reconciled.operation.operation_ref,
    expected_version: reconciled.operation.version,
    resolution: 'effect_failed_terminal',
    requested_by: 'operator:effect-crash-terminal-test',
    outcome_evidence_ref: 'provider-outcome:effect-failed-terminal',
    outcome_evidence_hash: HASH('provider-outcome:effect-failed-terminal'),
    result: { failure: 'terminal' },
  });
  assert.equal(failedReconciliation.operation.status, 'ambiguous');
  assert.equal(
    failedReconciliation.operation.failure_code,
    'RECONCILIATION_EFFECT_FAILED_UNSAFE_TO_RELEASE',
  );

  const rows = await harness.inspection.query(
    `SELECT
       (SELECT status FROM "${harness.schemaName}".parent_heads LIMIT 1) AS parent_status,
       (SELECT status FROM "${harness.schemaName}".commit_approvals LIMIT 1) AS approval_status,
       (SELECT status FROM "${harness.schemaName}".execution_authorizations LIMIT 1) AS authorization_status`,
  );
  assert.deepEqual(rows.rows[0], {
    parent_status: 'ambiguous',
    approval_status: 'reserved',
    authorization_status: 'ambiguous',
  });
  const audit = await harness.authority.getAuditTrail();
  assert.equal(
    audit.events.filter((event) => event.event_type === 'reconciliation_kept_ambiguous').length,
    2,
  );
});

test('point-in-time absence cannot release a one-use authorization while its effect callback is pending', {
  skip: POSTGRES_SKIP,
}, async (t) => {
  const fixture = createFixture('pending-reconciliation-race', { consequential: true });
  const harness = await createHarness(t, fixture);
  const secondApproval = {
    ...fixture.approval,
    artifact_hash: HASH('artifact:pending-reconciliation-race-second'),
    capsule_hash: HASH('capsule:pending-reconciliation-race-second'),
    evidence_ref: 'approval:pending-reconciliation-race-second',
    evidence_hash: HASH('approval:pending-reconciliation-race-second'),
  };
  await harness.authority.registerCommitApproval(secondApproval);
  const secondRequest = {
    ...fixture.request,
    artifact_hash: secondApproval.artifact_hash,
    capsule_hash: secondApproval.capsule_hash,
    approval_evidence_ref: secondApproval.evidence_ref,
    approval_evidence_hash: secondApproval.evidence_hash,
    authority_request_hash: HASH('clean-authority-request:pending-reconciliation-race-second'),
  };

  let signalEffectEntered;
  let releaseEffect;
  const effectEntered = new Promise((resolve) => { signalEffectEntered = resolve; });
  const effectRelease = new Promise((resolve) => { releaseEffect = resolve; });
  t.after(() => releaseEffect());
  let firstEffectInvocations = 0;
  const firstCommit = harness.authority.runCommit(fixture.request, {
    claimant_ref: 'worker:pending-reconciliation-race-first',
    verifyUnderReservation: async (request) => gateProof(request),
    performEffect: async () => {
      signalEffectEntered();
      await effectRelease;
      firstEffectInvocations += 1;
      return { outcome: 'first-effect-returned' };
    },
  });
  await effectEntered;

  const unresolved = (await harness.authority.listUnresolved()).operations[0];
  assert.equal(unresolved.status, 'effect_started');
  const reconciliation = await harness.authority.reconcileOperation({
    operation_ref: unresolved.operation_ref,
    expected_version: unresolved.version,
    resolution: 'effect_absent',
    requested_by: 'operator:pending-reconciliation-race',
    outcome_evidence_ref: 'provider-outcome:point-in-time-absent',
    outcome_evidence_hash: HASH('provider-outcome:point-in-time-absent'),
  });
  assert.equal(reconciliation.operation.status, 'ambiguous');

  let secondEffectInvocations = 0;
  await assert.rejects(
    harness.authority.runCommit(secondRequest, {
      claimant_ref: 'worker:pending-reconciliation-race-second',
      verifyUnderReservation: async (request) => gateProof(request),
      performEffect: () => {
        secondEffectInvocations += 1;
        return { forbidden: true };
      },
    }),
    (error) => error.code === 'RISK_FORK_DISTRIBUTED_COMMIT_AMBIGUOUS',
  );
  assert.equal(secondEffectInvocations, 0);

  const reserved = await harness.inspection.query(
    `SELECT
       (SELECT status FROM "${harness.schemaName}".parent_heads LIMIT 1) AS parent_status,
       (SELECT status FROM "${harness.schemaName}".commit_approvals
         WHERE approval_key = $1) AS first_approval_status,
       (SELECT status FROM "${harness.schemaName}".commit_approvals
         WHERE approval_key = $2) AS second_approval_status,
       (SELECT status FROM "${harness.schemaName}".execution_authorizations LIMIT 1)
         AS authorization_status`,
    [
      fixture.approval.approval_key ?? HASH({
        schema: 'agoragentic.risk-fork.distributed-approval-key.v1',
        ...fixture.approval,
      }),
      secondApproval.approval_key ?? HASH({
        schema: 'agoragentic.risk-fork.distributed-approval-key.v1',
        ...secondApproval,
      }),
    ],
  );
  assert.deepEqual(reserved.rows[0], {
    parent_status: 'ambiguous',
    first_approval_status: 'reserved',
    second_approval_status: 'active',
    authorization_status: 'ambiguous',
  });

  releaseEffect();
  await assert.rejects(
    firstCommit,
    (error) => error.code === 'RISK_FORK_DISTRIBUTED_COMMIT_AMBIGUOUS',
  );
  assert.equal(firstEffectInvocations, 1);
  assert.equal(secondEffectInvocations, 0);
});

test('exact proven effect success may finalize an unresolved durable claim', {
  skip: POSTGRES_SKIP,
}, async (t) => {
  const fixture = createFixture('reconciled-success', { consequential: true });
  const harness = await createHarness(t, fixture);
  const crashed = await startWorker(harness, fixture, 'crash_after_effect_claim').done;
  assert.equal(crashed.code, 72, crashed.stderr);
  const unresolved = (await harness.authority.listUnresolved()).operations[0];
  const result = { outcome: 'externally-proven-success' };
  const reconciled = await harness.authority.reconcileOperation({
    operation_ref: unresolved.operation_ref,
    expected_version: unresolved.version,
    resolution: 'effect_succeeded',
    requested_by: 'operator:reconciled-success',
    outcome_evidence_ref: 'provider-outcome:effect-succeeded',
    outcome_evidence_hash: HASH('provider-outcome:effect-succeeded'),
    result,
  });

  assert.equal(reconciled.operation.status, 'committed');
  assert.deepEqual(reconciled.operation.result, result);
  const rows = await harness.inspection.query(
    `SELECT
       (SELECT status FROM "${harness.schemaName}".parent_heads LIMIT 1) AS parent_status,
       (SELECT status FROM "${harness.schemaName}".commit_approvals LIMIT 1) AS approval_status,
       (SELECT status FROM "${harness.schemaName}".execution_authorizations LIMIT 1)
         AS authorization_status`,
  );
  assert.deepEqual(rows.rows[0], {
    parent_status: 'active',
    approval_status: 'consumed',
    authorization_status: 'consumed',
  });
});

test('an injected connection abort inside effect claim leaves only prepared state recoverable', {
  skip: POSTGRES_SKIP,
}, async (t) => {
  const fixture = createFixture('prepared-crash', { consequential: true });
  const harness = await createHarness(t, fixture);
  const worker = startWorker(harness, fixture, 'wait_after_initialize');
  await worker.initialized;
  await harness.inspection.query(`
    CREATE FUNCTION "${harness.schemaName}".abort_effect_claim()
    RETURNS trigger LANGUAGE plpgsql AS $body$
    BEGIN
      IF OLD.status = 'prepared' AND NEW.status = 'effect_started' THEN
        RAISE EXCEPTION 'injected effect-claim connection abort' USING ERRCODE = '57P01';
      END IF;
      RETURN NEW;
    END;
    $body$;
    CREATE TRIGGER abort_effect_claim
      BEFORE UPDATE ON "${harness.schemaName}".operations
      FOR EACH ROW EXECUTE FUNCTION "${harness.schemaName}".abort_effect_claim();
  `);
  worker.continueRun();
  const prepared = await waitForOperation(
    harness.inspection,
    harness.schemaName,
    'prepared',
  );
  const workerResult = await worker.done;
  assert.equal(workerResult.code, 0, workerResult.stderr);
  assert.equal(workerResult.events.some((event) => event.type === 'effect_invoked'), false);
  assert.ok(workerResult.events.some((event) => (
    event.type === 'finished' && event.ok === false && event.code === '57P01'
  )));
  await harness.inspection.query(`
    DROP TRIGGER abort_effect_claim ON "${harness.schemaName}".operations;
    DROP FUNCTION "${harness.schemaName}".abort_effect_claim();
  `);

  const unresolved = await harness.authority.getOperation(prepared.operation_ref);
  assert.equal(unresolved.status, 'prepared');
  const recovered = await harness.authority.recoverPreparedOperation({
    operation_ref: unresolved.operation_ref,
    expected_version: unresolved.version,
    recovery_evidence_ref: 'operator-recovery:prepared-crash',
    recovery_evidence_hash: HASH('operator-recovery:prepared-crash'),
  });
  assert.equal(recovered.status, 'aborted');
  const graph = await harness.inspection.query(
    `SELECT
       (SELECT status FROM "${harness.schemaName}".parent_heads LIMIT 1) AS parent_status,
       (SELECT status FROM "${harness.schemaName}".commit_approvals LIMIT 1) AS approval_status,
       (SELECT status FROM "${harness.schemaName}".execution_authorizations LIMIT 1) AS authorization_status`,
  );
  assert.deepEqual(graph.rows[0], {
    parent_status: 'active',
    approval_status: 'active',
    authorization_status: 'active',
  });
});

test('authorization revocation cannot cross an exact reserved clean gate or committed consumption', {
  skip: POSTGRES_SKIP,
}, async (t) => {
  const fixture = createFixture('revoke-race', { consequential: true });
  const harness = await createHarness(t, fixture);
  const peer = await harness.createAuthority();
  await assert.rejects(
    harness.authority.runCommit({
      ...fixture.request,
      authorization: {
        ...fixture.request.authorization,
        governance_evidence_ref: 'governance-evidence:substituted',
        governance_evidence_hash: HASH('governance-evidence:substituted'),
      },
    }, {
      claimant_ref: 'worker:governance-substitution',
      verifyUnderReservation: async (request) => gateProof(request),
      performEffect: () => ({ forbidden: true }),
    }),
    (error) => error.code === 'DISTRIBUTED_AUTHORIZATION_GOVERNANCE_MISMATCH',
  );
  let enterGate;
  let releaseGate;
  const gateEntered = new Promise((resolve) => { enterGate = resolve; });
  const gateRelease = new Promise((resolve) => { releaseGate = resolve; });
  let effectInvocations = 0;
  const commit = harness.authority.runCommit(fixture.request, {
    claimant_ref: 'worker:revoke-race',
    verifyUnderReservation: async (request) => {
      enterGate();
      await gateRelease;
      return gateProof(request);
    },
    performEffect: ({ effect_key: effectKey }) => {
      effectInvocations += 1;
      return { outcome: 'committed', effect_key: effectKey };
    },
  });
  await gateEntered;

  let revocationSettled = false;
  const revocation = peer.revokeExecutionAuthorization({
    authorization_id: fixture.authorizationRegistration.authorization_id,
    evidence_ref: 'revocation:race',
    evidence_hash: HASH('revocation:race'),
  }).then(
    (value) => ({ ok: true, value }),
    (error) => ({ ok: false, error }),
  ).finally(() => { revocationSettled = true; });
  await new Promise((resolve) => setTimeout(resolve, 100));
  assert.equal(revocationSettled, false, 'revocation must wait on the reserved authorization row');
  releaseGate();

  const committed = await commit;
  assert.equal(committed.status, 'committed');
  assert.equal(effectInvocations, 1);
  const revocationOutcome = await revocation;
  assert.equal(revocationOutcome.ok, false);
  assert.ok(
    [
      'RISK_FORK_DISTRIBUTED_COMMIT_AMBIGUOUS',
      'DISTRIBUTED_AUTHORIZATION_CONSUMED',
    ].includes(revocationOutcome.error.code),
  );
  const authorization = await harness.inspection.query(
    `SELECT status, revocation_evidence_ref, consumed_at
       FROM "${harness.schemaName}".execution_authorizations
      WHERE authorization_id = $1`,
    [fixture.authorizationRegistration.authorization_id],
  );
  assert.equal(authorization.rows[0].status, 'consumed');
  assert.equal(authorization.rows[0].revocation_evidence_ref, null);
  assert.ok(authorization.rows[0].consumed_at instanceof Date);
});
