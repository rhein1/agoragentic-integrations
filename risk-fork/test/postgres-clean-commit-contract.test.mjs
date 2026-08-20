import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { LocalReferenceRiskForkAdapter } from '../src/adapters/local-reference.mjs';
import {
  PostgresDistributedCommitAuthority,
  isProductionPostgresDistributedCommitAuthority,
} from '../src/adapters/postgres-authority.mjs';
import {
  FileParentHeadTransaction,
  commitPreparedArtifact,
  deriveParentAuthorityRef,
} from '../src/clean-commit.mjs';
import { RiskForkController } from '../src/controller.mjs';
import { validateCommitCandidate } from '../src/taint-gate.mjs';
import {
  NOW,
  advanceToCommitting,
  closedResultSchema,
  hash,
  makeCapsule,
  makeForkIdentity,
  makePreparedLifecycle,
} from './helpers.mjs';

const TEST_CA = [
  '-----BEGIN CERTIFICATE-----',
  'contract-only-ca',
  '-----END CERTIFICATE-----',
].join('\n');

function governance(capsule) {
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
      usage_hash: hash('distributed-contract-budget-usage'),
      available_amount: '100.00',
      currency: 'USDC',
      payment_rail: 'x402:base',
    },
    epoch: capsule.governance.epoch,
    commit_policy: { typed_result_schema_hash: capsule.authorized_result_schema_hash },
    evidence_ref: 'governance:distributed-contract',
    evidence_hash: hash('governance:distributed-contract'),
  };
}

function fixture() {
  const capsule = makeCapsule({ expires_at: '2099-01-01T00:00:00.000Z' });
  const forkIdentity = makeForkIdentity(capsule);
  const schema = closedResultSchema();
  const artifact = validateCommitCandidate({
    candidate: {
      type: 'TYPED_RESULT',
      payload: { answer: 'distributed-contract' },
      payload_schema: schema,
    },
    source_fork_id: 'fork:distributed-contract',
    policy: { typed_result_schema_hash: hash(schema) },
    validated_at: NOW,
  });
  const currentGovernance = governance(capsule);
  return {
    capsule,
    forkIdentity,
    artifact,
    currentGovernance,
    input: {
      capsule,
      fork_identity: forkIdentity,
      lifecycle: advanceToCommitting(makePreparedLifecycle(artifact.artifact_hash)),
      artifact,
      destruction_evidence: {
        status: 'verified',
        provider_ref: 'provider:1',
        fork_ref: artifact.source_fork_id,
        evidence_ref: 'cleanup:verified',
        evidence_hash: hash('cleanup'),
      },
      expected_parent_state_hash: capsule.parent.state_hash,
      resolveCurrentGovernance: async () => currentGovernance,
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
        evidence_ref: 'approval:distributed-contract',
        evidence_hash: hash('approval:distributed-contract'),
      }),
      acceptTypedResult: async (payload) => ({ accepted: payload.answer }),
    },
  };
}

async function fileAuthority(t, value) {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'risk-fork-distributed-contract-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const authority = await new FileParentHeadTransaction({
    directory,
    clock: () => new Date(NOW),
  }).initialize();
  const parentRef = deriveParentAuthorityRef({
    agent_id: value.capsule.parent.agent_id,
    session_id: value.capsule.parent.session_id,
  });
  await authority.seedParentHead({ parentRef, headHash: value.capsule.parent.state_hash });
  await authority.setCurrentGovernance({
    parent_ref: parentRef,
    governance: value.currentGovernance,
  });
  await authority.registerCommitApproval({
    parent_ref: parentRef,
    artifact_hash: value.artifact.artifact_hash,
    capsule_hash: value.capsule.capsule_hash,
    parent_state_hash: value.capsule.parent.state_hash,
    commit_type: value.artifact.commit_type,
    governance_hash: hash(value.currentGovernance),
    evidence_ref: 'approval:distributed-contract',
    evidence_hash: hash('approval:distributed-contract'),
  });
  return authority;
}

test('clean commit rejects mixed file and exact PostgreSQL authority backends', async (t) => {
  const value = fixture();
  const parentStateTransaction = await fileAuthority(t, value);
  const distributedCommitAuthority = new PostgresDistributedCommitAuthority({
    connectionString: 'postgresql://unused.invalid/risk_fork',
  });
  await assert.rejects(
    commitPreparedArtifact({
      ...value.input,
      parentStateTransaction,
      distributedCommitAuthority,
      distributedClaimantRef: 'claimant:contract-test',
    }, { clock: () => NOW }),
    (error) => error?.code === 'COMMIT_AUTHORITY_MUTUALLY_EXCLUSIVE',
  );
});

test('production clean commit rejects the file reference authority', async (t) => {
  const value = fixture();
  const parentStateTransaction = await fileAuthority(t, value);
  await assert.rejects(
    commitPreparedArtifact({ ...value.input, parentStateTransaction }, {
      clock: () => NOW,
      mode: 'production',
    }),
    (error) => error?.code === 'PRODUCTION_DISTRIBUTED_AUTHORITY_REQUIRED',
  );
});

test('production clean commit rejects a development PostgreSQL authority', async () => {
  const value = fixture();
  const distributedCommitAuthority = new PostgresDistributedCommitAuthority({
    connectionString: 'postgresql://unused.invalid/risk_fork',
  });
  await assert.rejects(
    commitPreparedArtifact({
      ...value.input,
      distributedCommitAuthority,
      distributedClaimantRef: 'claimant:contract-test',
    }, {
      clock: () => NOW,
      mode: 'production',
    }),
    (error) => error?.code === 'PRODUCTION_POSTGRES_AUTHORITY_CONFIGURATION_REQUIRED',
  );
});

test('production controller rejects development authority and requires exact strict configuration', () => {
  const provider = new LocalReferenceRiskForkAdapter();
  const developmentAuthority = new PostgresDistributedCommitAuthority({
    connectionString: 'postgresql://unused.invalid/risk_fork',
  });
  assert.equal(isProductionPostgresDistributedCommitAuthority(developmentAuthority), false);
  assert.throws(
    () => new RiskForkController({
      provider,
      mode: 'production',
      distributedCommitAuthority: developmentAuthority,
      distributedClaimantRef: 'claimant:contract-test',
    }),
    (error) => error?.code === 'PRODUCTION_POSTGRES_AUTHORITY_CONFIGURATION_REQUIRED',
  );
  assert.throws(
    () => new RiskForkController({ provider, mode: 'production' }),
    (error) => error?.code === 'PRODUCTION_POSTGRES_AUTHORITY_CONFIGURATION_REQUIRED',
  );

  const productionAuthority = new PostgresDistributedCommitAuthority({
    connectionString: 'postgresql://runtime:secret@db.internal/risk_fork',
    deploymentMode: 'production',
    migrationMode: 'verify-only',
    tls: { ca: TEST_CA },
  });
  assert.equal(isProductionPostgresDistributedCommitAuthority(productionAuthority), true);
  assert.equal(isProductionPostgresDistributedCommitAuthority({
    deploymentMode: 'production',
    migrationMode: 'verify-only',
    requireTls: true,
  }), false);
  assert.ok(new RiskForkController({
    provider,
    mode: 'production',
    distributedCommitAuthority: productionAuthority,
    distributedClaimantRef: 'claimant:contract-test',
  }));
});

test('controller accepts only the concrete PostgreSQL authority as trusted construction state', () => {
  const provider = new LocalReferenceRiskForkAdapter();
  assert.throws(
    () => new RiskForkController({
      provider,
      distributedCommitAuthority: { runCommit() {} },
      distributedClaimantRef: 'claimant:contract-test',
    }),
    /exact concrete PostgresDistributedCommitAuthority/,
  );
  const distributedCommitAuthority = new PostgresDistributedCommitAuthority({
    connectionString: 'postgresql://unused.invalid/risk_fork',
  });
  const controller = new RiskForkController({
    provider,
    distributedCommitAuthority,
    distributedClaimantRef: 'claimant:contract-test',
  });
  assert.equal(Object.isFrozen(distributedCommitAuthority), true);
  assert.ok(controller);
});
