import assert from 'node:assert/strict';
import test from 'node:test';
import {
  attachToplocEvidence,
  normalizeToplocEvidence,
  summarizeToplocEvidence,
} from '../src/toploc-evidence.mjs';

const accepted = {
  scheme_version: 'paper-2025-01',
  model_ref: 'model:qwen',
  configuration_hash: 'sha256:configuration',
  proof_ref: 'vault://toploc/proof/1',
  proof_hash: 'sha256:proof',
  validator_ref: 'validator://toploc/1',
  validator_version: '0.1.0',
  status: 'accept',
  checked_at: '2026-08-07T00:00:00.000Z',
};

test('normalizes scoped TOPLOC evidence without overclaiming correctness', () => {
  const evidence = normalizeToplocEvidence(accepted);
  assert.equal(evidence.scheme, 'toploc');
  assert.equal(evidence.scope, 'model_configuration_execution');
  assert.equal(evidence.non_claims.output_correctness_proven, false);
  assert.equal(evidence.non_claims.complete_transaction_verified, false);
  assert.equal(evidence.authority_flags.attestation_grants_authority, false);
  assert.match(evidence.attestation_hash, /^sha256:/);
});

test('rejects embedded raw activations and proof payloads', () => {
  assert.throws(() => normalizeToplocEvidence({ ...accepted, activations: [1, 2] }), /no raw proof or activations/);
  assert.throws(() => normalizeToplocEvidence({ ...accepted, proof: 'raw' }), /no raw proof or activations/);
});

test('requires checked_at for final statuses', () => {
  const { checked_at, ...input } = accepted;
  assert.throws(() => normalizeToplocEvidence(input), /checked_at is required/);
});

test('accepted attestations remain scoped and do not prove delivery', () => {
  const summary = summarizeToplocEvidence([accepted]);
  assert.equal(summary.status, 'accepted');
  assert.equal(summary.delivery_proven, false);
  assert.equal(summary.payment_settlement_proven, false);
});

test('any rejection produces a rejected scoped summary', () => {
  const summary = summarizeToplocEvidence([
    accepted,
    { ...accepted, proof_ref: 'vault://toploc/proof/2', proof_hash: 'sha256:proof2', status: 'reject' },
  ]);
  assert.equal(summary.status, 'rejected');
  assert.equal(summary.rejected_count, 1);
});

test('attaches attestations while clearing complete-chain verification', () => {
  const envelope = {
    schema: 'agoragentic.transaction-assurance-envelope.v1',
    envelope_id: 'tae_1',
    evidence: { complete_chain_verified: true, envelope_hash: 'sha256:old' },
  };
  const attached = attachToplocEvidence(envelope, accepted);
  assert.equal(attached.inference_attestations.length, 1);
  assert.equal(attached.inference_attestation_summary.status, 'accepted');
  assert.equal(attached.evidence.complete_chain_verified, false);
  assert.notEqual(attached.evidence.envelope_hash, 'sha256:old');
});
