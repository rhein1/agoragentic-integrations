import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

import { PostgresDistributedCommitAuthority, isPostgresDistributedCommitAuthority } from '../src/adapters/postgres-authority.mjs';
import { sha256Ref } from '../src/canonical.mjs';
import {
  buildReconciliationVerificationRequest,
  normalizeDistributedPrepareRequest,
  verifyReconciliationVerification,
} from '../src/distributed-authority.mjs';

const HASH = (value) => sha256Ref(value);

test('the PostgreSQL authority is an exact frozen capability without raw effect primitives', () => {
  const authority = new PostgresDistributedCommitAuthority({
    connectionString: 'postgresql://127.0.0.1/risk_fork_contract_only',
    authorityId: 'authority:contract-only',
  });

  assert.equal(Object.isFrozen(authority), true);
  assert.equal(Object.isFrozen(PostgresDistributedCommitAuthority), true);
  assert.equal(Object.isFrozen(PostgresDistributedCommitAuthority.prototype), true);
  assert.equal(isPostgresDistributedCommitAuthority(authority), true);
  assert.equal(isPostgresDistributedCommitAuthority(new Proxy(authority, {})), false);
  for (const forbidden of ['prepareOperation', 'startEffect', 'finalizeEffect', 'markAmbiguous']) {
    assert.equal(forbidden in authority, false, `${forbidden} must remain module-private`);
  }
  class RejectedSubclass extends PostgresDistributedCommitAuthority {}
  assert.throws(
    () => new RejectedSubclass({ connectionString: 'postgresql://127.0.0.1/forged' }),
    /cannot be subclassed/,
  );
});

test('distributed prepare derives its own exact request hash and rejects authority-shape drift', () => {
  const input = {
    parent_ref: 'parent:contract',
    expected_parent_head_hash: HASH('head'),
    artifact_hash: HASH('artifact'),
    capsule_hash: HASH('capsule'),
    capsule_expires_at: '2099-01-01T00:00:00.000Z',
    commit_type: 'TYPED_RESULT',
    governance_hash: HASH('governance'),
    approval_evidence_ref: 'approval:contract',
    approval_evidence_hash: HASH('approval'),
    authority_request_hash: HASH('clean-authority-request'),
    authorization: null,
  };
  const normalized = normalizeDistributedPrepareRequest(input);

  assert.equal(normalized.request_hash, HASH({
    schema: 'agoragentic.risk-fork.distributed-prepare-request.v1',
    ...input,
  }));
  assert.equal(Object.isFrozen(normalized), true);
  assert.throws(
    () => normalizeDistributedPrepareRequest({ ...input, request_hash: HASH('caller-chosen') }),
    /unsupported field/,
  );
  assert.throws(
    () => normalizeDistributedPrepareRequest({
      ...input,
      commit_type: 'CONSEQUENTIAL_ACTION_PROPOSAL',
    }),
    /require exactly one distributed authorization binding/,
  );
});

test('trusted reconciliation proof must bind operation version, effect key, result, and evidence request', () => {
  const input = {
    operation_ref: 'operation:contract',
    expected_version: 2,
    resolution: 'effect_succeeded',
    requested_by: 'operator:contract',
    outcome_evidence_ref: 'outcome:contract',
    outcome_evidence_hash: HASH('outcome'),
    result: { accepted: true },
    result_hash: HASH({ accepted: true }),
  };
  const request = buildReconciliationVerificationRequest({
    operation_ref: input.operation_ref,
    version: input.expected_version,
    request_hash: HASH('request'),
    effect_key: 'risk-fork-effect:contract',
  }, input, '2030-01-01T00:00:00.000Z');
  const proof = {
    schema: 'agoragentic.risk-fork.distributed-reconciliation-verification.v1',
    status: 'verified',
    verification_request_hash: request.verification_request_hash,
    operation_ref: request.operation_ref,
    operation_version: request.operation_version,
    effect_key: request.effect_key,
    resolution: request.resolution,
    result_hash: request.result_hash,
    evidence_ref: 'reconciliation-proof:contract',
    evidence_hash: HASH('reconciliation-proof'),
  };

  assert.deepEqual(verifyReconciliationVerification(proof, request), {
    evidence_ref: proof.evidence_ref,
    evidence_hash: proof.evidence_hash,
  });
  assert.throws(
    () => verifyReconciliationVerification({ ...proof, operation_version: 3 }, request),
    (error) => error.code === 'DISTRIBUTED_RECONCILIATION_NOT_VERIFIED',
  );
  assert.throws(
    () => verifyReconciliationVerification({ ...proof, effect_key: 'risk-fork-effect:other' }, request),
    (error) => error.code === 'DISTRIBUTED_RECONCILIATION_NOT_VERIFIED',
  );
});

test('migration encodes shared row state, uniqueness, and append-only audit controls', async () => {
  const sql = await readFile(
    new URL('../migrations/001_distributed_authority.pg.sql', import.meta.url),
    'utf8',
  );

  assert.match(sql, /CREATE TABLE IF NOT EXISTS .*\.parent_heads/);
  assert.match(sql, /CREATE TABLE IF NOT EXISTS .*\.execution_authorizations/);
  assert.match(sql, /UNIQUE \(authority_id, request_hash\)/);
  assert.match(sql, /UNIQUE \(authority_id, effect_key\)/);
  assert.match(sql, /audit_events_no_update/);
  assert.match(sql, /audit_events_no_delete/);
  assert.match(sql, /clock_timestamp\(\)/);
});
