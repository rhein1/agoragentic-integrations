import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import test from 'node:test';

import { LocalReferenceRiskForkAdapter } from '../src/adapters/local-reference.mjs';
import { PostgresDistributedCommitAuthority } from '../src/adapters/postgres-authority.mjs';
import { deriveParentAuthorityRef } from '../src/clean-commit.mjs';
import { RiskForkController } from '../src/controller.mjs';
import { validateCommitCandidate } from '../src/taint-gate.mjs';
import {
  NOW,
  closedResultSchema,
  hash,
  makeCapsule,
  makeForkIdentity,
  makePreparedLifecycle,
} from './helpers.mjs';

const POSTGRES_URL = process.env.RISK_FORK_TEST_POSTGRES_URL;
if (process.env.RISK_FORK_REQUIRE_POSTGRES_TESTS === '1' && !POSTGRES_URL) {
  throw new Error('RISK_FORK_TEST_POSTGRES_URL is required for the mandatory PostgreSQL suite');
}
const POSTGRES_SKIP = POSTGRES_URL
  ? false
  : 'requires RISK_FORK_TEST_POSTGRES_URL pointing to an isolated PostgreSQL test database';

function currentGovernance(capsule) {
  return {
    policy: {
      ref: capsule.governance.policy_ref,
      version: capsule.governance.policy_version,
      hash: capsule.governance.policy_hash,
    },
    mandate: {
      ref: capsule.governance.mandate_ref,
      version: capsule.governance.mandate_version,
      hash: capsule.governance.mandate_hash,
    },
    budget_policy: {
      ref: capsule.governance.budget_policy_ref,
      version: capsule.governance.budget_version,
      hash: capsule.governance.budget_hash,
      usage_hash: hash('postgres-clean-budget-usage'),
      available_amount: '100.00',
      currency: 'USDC',
      payment_rail: 'x402:base',
    },
    epoch: capsule.governance.epoch,
    commit_policy: { typed_result_schema_hash: capsule.authorized_result_schema_hash },
    evidence_ref: 'governance:postgres-clean-commit',
    evidence_hash: hash('governance:postgres-clean-commit'),
  };
}

function typedFixture(tag) {
  const schema = closedResultSchema();
  const capsule = makeCapsule({
    created_at: '2025-01-01T00:00:00.000Z',
    expires_at: '2099-01-01T00:00:00.000Z',
    parent: {
      agent_id: `parent-agent-${tag}`,
      session_id: `parent-session-${tag}`,
      state_hash: hash(`parent-state-${tag}`),
    },
  });
  const forkIdentity = makeForkIdentity(capsule);
  const artifact = validateCommitCandidate({
    candidate: {
      type: 'TYPED_RESULT',
      payload: { answer: `postgres-${tag}` },
      payload_schema: schema,
    },
    source_fork_id: `fork:postgres-clean-${tag}`,
    policy: { typed_result_schema_hash: hash(schema) },
    validated_at: '2025-01-01T00:01:00.000Z',
  });
  const governance = currentGovernance(capsule);
  const approval = {
    evidence_ref: `approval:postgres-clean-${tag}`,
    evidence_hash: hash(`approval:postgres-clean-${tag}`),
  };
  return {
    capsule,
    forkIdentity,
    artifact,
    governance,
    approval,
    prepared: {
      mode: 'prepared_for_clean_commit',
      capsule,
      fork_identity: forkIdentity,
      artifact,
      lifecycle: makePreparedLifecycle(artifact.artifact_hash),
      destruction_evidence: {
        status: 'verified',
        provider_ref: 'provider:1',
        fork_ref: artifact.source_fork_id,
        evidence_ref: 'cleanup:verified',
        evidence_hash: hash('cleanup'),
      },
    },
  };
}

async function harness(t, fixture) {
  const suffix = randomBytes(6).toString('hex');
  const schemaName = `risk_fork_clean_${process.pid}_${suffix}`;
  const { Pool } = await import('pg');
  const inspection = new Pool({ connectionString: POSTGRES_URL, max: 1 });
  const authority = await new PostgresDistributedCommitAuthority({
    connectionString: POSTGRES_URL,
    authorityId: `authority:clean-integration:${suffix}`,
    schemaName,
  }).initialize();
  t.after(async () => {
    await authority.close().catch(() => {});
    await inspection.query(`DROP SCHEMA IF EXISTS "${schemaName}" CASCADE`);
    await inspection.end();
  });
  const parentRef = deriveParentAuthorityRef({
    agent_id: fixture.capsule.parent.agent_id,
    session_id: fixture.capsule.parent.session_id,
  });
  await authority.seedParentHead({
    parent_ref: parentRef,
    head_hash: fixture.capsule.parent.state_hash,
  });
  await authority.setCurrentGovernance({ parent_ref: parentRef, governance: fixture.governance });
  await authority.registerCommitApproval({
    parent_ref: parentRef,
    artifact_hash: fixture.artifact.artifact_hash,
    capsule_hash: fixture.capsule.capsule_hash,
    parent_state_hash: fixture.capsule.parent.state_hash,
    commit_type: fixture.artifact.commit_type,
    governance_hash: hash(fixture.governance),
    evidence_ref: fixture.approval.evidence_ref,
    evidence_hash: fixture.approval.evidence_hash,
  });
  return authority;
}

function commitInput(fixture, acceptTypedResult) {
  return {
    expected_parent_state_hash: fixture.capsule.parent.state_hash,
    resolveCurrentGovernance: async () => fixture.governance,
    verifyCommitApproval: async (request) => ({
      schema: 'agoragentic.risk-fork.clean-commit-approval-verification.v1',
      status: 'verified',
      request_hash: request.request_hash,
      artifact_hash: request.artifact_hash,
      capsule_hash: request.capsule_hash,
      parent_state_hash: request.parent_state_hash,
      governance_hash: request.governance_hash,
      governance_evidence_ref: request.governance_evidence_ref,
      governance_evidence_hash: request.governance_evidence_hash,
      evidence_ref: fixture.approval.evidence_ref,
      evidence_hash: fixture.approval.evidence_hash,
    }),
    acceptTypedResult,
  };
}

test('production controller uses PostgreSQL clean authority and exact replay invokes once', {
  skip: POSTGRES_SKIP,
}, async (t) => {
  const fixture = typedFixture('success');
  const authority = await harness(t, fixture);
  const controller = new RiskForkController({
    provider: new LocalReferenceRiskForkAdapter(),
    mode: 'production',
    clock: () => new Date(NOW),
    distributedCommitAuthority: authority,
    distributedClaimantRef: 'claimant:postgres-clean-success',
  });
  const effects = [];
  const input = commitInput(fixture, async (payload, context) => {
    effects.push({ payload, context });
    return { accepted: payload.answer };
  });

  const first = await controller.commit(fixture.prepared, input);
  const replay = await controller.commit(fixture.prepared, input);

  assert.equal(first.lifecycle.state, 'COMMITTED');
  assert.equal(first.authority_backend, 'postgres_distributed');
  assert.equal(first.result.accepted, 'postgres-success');
  assert.equal(replay.result_hash, first.result_hash);
  assert.equal(replay.parent_transaction.transaction_ref, first.parent_transaction.transaction_ref);
  assert.equal(effects.length, 1);
  assert.match(effects[0].context.effect_key, /^risk-fork-effect:/);
  assert.equal(effects[0].context.effect_key, effects[0].context.idempotency_key);
  assert.equal(effects[0].context.automatic_retry_allowed, false);
});

test('a failed PostgreSQL effect maps to COMMIT_AMBIGUOUS and is never retried', {
  skip: POSTGRES_SKIP,
}, async (t) => {
  const fixture = typedFixture('ambiguous');
  const authority = await harness(t, fixture);
  const controller = new RiskForkController({
    provider: new LocalReferenceRiskForkAdapter(),
    mode: 'production',
    clock: () => new Date(NOW),
    distributedCommitAuthority: authority,
    distributedClaimantRef: 'claimant:postgres-clean-ambiguous',
  });
  let effects = 0;
  const input = commitInput(fixture, async () => {
    effects += 1;
    throw new Error('injected effect failure');
  });

  const first = await controller.commit(fixture.prepared, input).then(
    () => null,
    (error) => error,
  );
  const second = await controller.commit(fixture.prepared, input).then(
    () => null,
    (error) => error,
  );

  assert.equal(first?.code, 'RISK_FORK_COMMIT_AMBIGUOUS');
  assert.equal(first?.lifecycle.state, 'COMMIT_AMBIGUOUS');
  assert.equal(second?.code, 'RISK_FORK_COMMIT_AMBIGUOUS');
  assert.equal(second?.lifecycle.state, 'COMMIT_AMBIGUOUS');
  assert.equal(effects, 1);
  const unresolved = await authority.listUnresolved();
  assert.equal(unresolved.operations.length, 1);
  assert.equal(unresolved.operations[0].status, 'ambiguous');
});
