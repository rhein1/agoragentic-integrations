import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import {
  buildTransactionAssuranceEnvelope,
  computeEnvelopeHash,
  evaluateTransactionAssuranceEnvelope,
  normalizeAuthorityArtifact,
  sha256Ref,
} from '../src/index.mjs';
import {
  attachToplocEvidence,
  computeToplocAttestationHash,
  normalizeToplocEvidence,
  summarizeToplocEvidence,
  TOPLOC_ATTESTATION_SCHEMA,
  verifyToplocEvidence,
} from '../src/toploc-evidence.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const NOW = '2026-08-07T00:01:00.000Z';

function acceptedInput(overrides = {}) {
  return {
    scheme_version: 'paper-2025-01',
    model_ref: 'model:qwen:test-fixture',
    configuration_hash: sha256Ref({ model: 'qwen', configuration: 'fixture' }),
    proof_ref: 'vault://toploc/proof/1',
    proof_hash: sha256Ref({ proof: 'fixture' }),
    validator_ref: 'validator://toploc/test-fixture',
    validator_version: '0.1.0-test',
    status: 'accept',
    checked_at: '2026-08-07T00:00:00.000Z',
    evidence_refs: ['evidence:toploc:test-fixture'],
    ...overrides,
  };
}

function buildEnvelope() {
  const normalizedAuthority = normalizeAuthorityArtifact({
    schema: 'agoragentic.agent-commerce.mandate.v1',
    owner_id: 'owner:test',
    buyer_agent_id: 'agent:test',
    issued_at: '2026-08-07T00:00:00.000Z',
    expires_at: '2026-08-08T00:00:00.000Z',
    scope: {
      allowed_actions: ['execute:research'],
      allowed_sellers: ['seller:test'],
      allowed_categories: ['research'],
      allowed_payment_rails: ['x402'],
    },
    budget: {
      currency: 'USDC',
      max_per_action: '0.10',
      max_daily: '1.00',
      max_total: '5.00',
    },
  }, {
    artifactRef: 'fixture:mandate',
    verification: {
      status: 'verified',
      verifierRef: 'fixture:authority-verifier',
      evidenceRef: 'fixture:authority-proof',
      checkedAt: '2026-08-07T00:00:01.000Z',
    },
    revocation: {
      status: 'active',
      evidenceRef: 'fixture:revocation-proof',
      checkedAt: '2026-08-07T00:00:02.000Z',
    },
  });

  return buildTransactionAssuranceEnvelope({
    createdAt: NOW,
    updatedAt: NOW,
    now: NOW,
    principalRef: 'owner:test',
    principalType: 'human',
    principalIdentityVerification: 'verified',
    principalIdentityEvidenceRef: 'fixture:principal-identity',
    agentRef: 'agent:test',
    agentIdentityVerification: 'verified',
    agentIdentityEvidenceRef: 'fixture:agent-identity',
    normalizedAuthority,
    commercialIntent: {
      action: 'execute:research',
      taskRef: 'task:test',
      sellerRef: 'seller:test',
      capabilityRef: 'capability:test',
      category: 'research',
      quoteRef: 'quote:test',
      quoteHash: sha256Ref({ amount: '0.05', currency: 'USDC' }),
      quotedAmount: '0.05',
      currency: 'USDC',
      termsRef: 'terms:test',
      termsHash: sha256Ref({ delivery: 'json' }),
      termsMatchStatus: 'match',
    },
    payment: {
      paymentIdentifier: 'payment:test',
      rail: 'x402',
      amount: '0.05',
      currency: 'USDC',
      dailySpendBefore: '0',
      totalSpendBefore: '0',
      budgetUsageRef: 'fixture:budget-usage',
    },
    execution: {
      idempotencyKeyHash: sha256Ref('idempotency:test'),
      inputHash: sha256Ref({ query: 'test' }),
    },
    evidenceRefs: ['fixture:authority-chain'],
  });
}

test('normalization creates a canonical self-hashed record without trusted claims', () => {
  const evidence = normalizeToplocEvidence(acceptedInput());
  assert.equal(evidence.schema, TOPLOC_ATTESTATION_SCHEMA);
  assert.equal(evidence.scope, 'model_configuration_execution');
  assert.equal(evidence.attestation_hash, computeToplocAttestationHash(evidence));
  assert.deepEqual(verifyToplocEvidence(evidence), evidence);
  assert.equal(evidence.trust.verification_status, 'not_verified');
  assert.equal(evidence.trust.trusted_proof, false);
  assert.equal(evidence.provenance.verification_status, 'not_verified');
  assert.equal(evidence.provenance.validator_identity_verified, false);
  assert.equal(evidence.provenance.proof_binding_verified, false);
  assert.equal(evidence.privacy.verification_status, 'not_verified');
  assert.equal(evidence.privacy.public_safe_status, 'not_verified');
  assert.equal(evidence.source_exactness.verification_status, 'not_verified');
  assert.equal(evidence.source_exactness.exact_source_verified, false);
  assert.equal(evidence.non_claims.complete_transaction_verified, false);
  assert.equal(evidence.authority_flags.attestation_grants_authority, false);
});

test('hashes and identifiers are reproducible after all fields are final', () => {
  const first = normalizeToplocEvidence(acceptedInput());
  const second = normalizeToplocEvidence(acceptedInput());
  assert.deepEqual(second, first);
  assert.match(first.configuration_hash, /^sha256:[0-9a-f]{64}$/);
  assert.match(first.proof_hash, /^sha256:[0-9a-f]{64}$/);
  assert.match(first.attestation_hash, /^sha256:[0-9a-f]{64}$/);
  assert.equal(computeToplocAttestationHash(first), first.attestation_hash);
});

test('rejects raw payloads, malformed hashes, and incomplete final provenance', () => {
  assert.throws(
    () => normalizeToplocEvidence({ ...acceptedInput(), activations: [1, 2] }),
    /no raw proof or activations/,
  );
  assert.throws(
    () => normalizeToplocEvidence({ ...acceptedInput(), proof: 'raw' }),
    /no raw proof or activations/,
  );
  assert.throws(
    () => normalizeToplocEvidence({ ...acceptedInput(), configuration_hash: 'sha256:configuration' }),
    /64 hex characters/,
  );
  assert.throws(
    () => normalizeToplocEvidence({ ...acceptedInput(), proof_hash: 'sha256:proof' }),
    /64 hex characters/,
  );
  const { checked_at: checkedAt, ...withoutCheckedAt } = acceptedInput();
  assert.equal(checkedAt, '2026-08-07T00:00:00.000Z');
  assert.throws(() => normalizeToplocEvidence(withoutCheckedAt), /checked_at is required/);
  assert.throws(
    () => normalizeToplocEvidence({ ...acceptedInput(), validator_version: '' }),
    /validator_version is required/,
  );
});

test('a schema tag never bypasses canonical validation or hash verification', () => {
  assert.throws(
    () => summarizeToplocEvidence([{ schema: TOPLOC_ATTESTATION_SCHEMA, status: 'accept' }]),
    /attestation_hash/,
  );

  const tampered = normalizeToplocEvidence(acceptedInput());
  tampered.status = 'reject';
  assert.throws(() => verifyToplocEvidence(tampered), /attestation hash mismatch/);

  const rehashedEscalation = normalizeToplocEvidence(acceptedInput());
  rehashedEscalation.trust.trusted_proof = true;
  rehashedEscalation.attestation_hash = computeToplocAttestationHash(rehashedEscalation);
  assert.throws(() => verifyToplocEvidence(rehashedEscalation), /not the canonical v1 shape/);

  const nonJsonEscalation = normalizeToplocEvidence(acceptedInput());
  nonJsonEscalation.unserialized_claim = undefined;
  assert.throws(() => verifyToplocEvidence(nonJsonEscalation), /JSON values only/);

  const sparseRefs = acceptedInput();
  sparseRefs.evidence_refs = new Array(1);
  assert.throws(() => normalizeToplocEvidence(sparseRefs), /must contain a string/);

  const sparseEntries = new Array(1);
  assert.throws(() => summarizeToplocEvidence(sparseEntries), /must contain a TOPLOC attestation/);
});

test('caller-supplied trust, authority, privacy, and source-exactness claims fail closed', () => {
  for (const [field, value] of [
    ['trusted_proof', true],
    ['authority_granted', true],
    ['public_safe', true],
    ['source_exactness_verified', true],
  ]) {
    assert.throws(
      () => normalizeToplocEvidence({ ...acceptedInput(), [field]: value }),
      new RegExp(`unsupported TOPLOC evidence field: ${field}`),
    );
  }

  const unscanned = normalizeToplocEvidence(acceptedInput({
    evidence_refs: ['opaque:unscanned-sentinel'],
  }));
  assert.deepEqual(unscanned.evidence_refs, ['opaque:unscanned-sentinel']);
  assert.equal(unscanned.privacy.public_safe_status, 'not_verified');
  assert.equal(unscanned.source_exactness.verification_status, 'not_verified');
});

test('summaries preserve declared results but never promote accept to trusted proof', () => {
  const acceptedSummary = summarizeToplocEvidence([acceptedInput()]);
  assert.equal(acceptedSummary.status, 'review');
  assert.equal(acceptedSummary.declared_validation_result, 'accepted');
  assert.equal(acceptedSummary.declared_accept_count, 1);
  assert.equal(acceptedSummary.verification_status, 'not_verified');
  assert.equal(acceptedSummary.provenance_verification_status, 'not_verified');
  assert.equal(acceptedSummary.public_safe_verification_status, 'not_verified');
  assert.equal(acceptedSummary.trusted_proof, false);
  assert.equal(acceptedSummary.complete_transaction_verified, false);
  assert.equal(acceptedSummary.authority_granted, false);

  const rejectedSummary = summarizeToplocEvidence([
    acceptedInput(),
    acceptedInput({
      proof_ref: 'vault://toploc/proof/2',
      proof_hash: sha256Ref({ proof: 'fixture-2' }),
      status: 'reject',
    }),
  ]);
  assert.equal(rejectedSummary.status, 'rejected');
  assert.equal(rejectedSummary.declared_validation_result, 'rejected');
  assert.equal(rejectedSummary.declared_reject_count, 1);
});

test('attachment verifies parent and child integrity, clears completion, and hashes last', () => {
  const envelope = buildEnvelope();
  const original = structuredClone(envelope);
  const attached = attachToplocEvidence(envelope, acceptedInput(), {
    updatedAt: '2026-08-07T00:02:00.000Z',
  });

  assert.deepEqual(envelope, original);
  assert.equal(attached.updated_at, '2026-08-07T00:02:00.000Z');
  assert.equal(attached.inference_attestations.length, 1);
  assert.equal(attached.inference_attestation_summary.status, 'review');
  assert.equal(attached.evidence.complete_chain_verified, false);
  assert.equal(attached.evidence.envelope_hash, computeEnvelopeHash(attached));

  const evaluation = evaluateTransactionAssuranceEnvelope(attached, {
    phase: 'pre_execution',
    now: '2026-08-07T00:03:00.000Z',
  });
  assert.equal(evaluation.decision, 'allow');
  assert.equal(evaluation.blockers.includes('envelope_hash_mismatch'), false);
  assert.equal(evaluation.complete_chain_verified, false);
});

test('attachment rejects stale parent hashes and tampered existing attestations', () => {
  const staleEnvelope = buildEnvelope();
  staleEnvelope.payment.amount = '0.06';
  assert.throws(
    () => attachToplocEvidence(staleEnvelope, acceptedInput(), { updatedAt: NOW }),
    /envelope hash mismatch/,
  );

  const attached = attachToplocEvidence(buildEnvelope(), acceptedInput(), { updatedAt: NOW });
  attached.inference_attestations[0].status = 'reject';
  attached.evidence.envelope_hash = computeEnvelopeHash(attached);
  assert.throws(
    () => attachToplocEvidence(attached, acceptedInput(), { updatedAt: NOW }),
    /attestation hash mismatch/,
  );
});

test('attachment rejects a forged existing summary even when the outer hash was recomputed', () => {
  const attached = attachToplocEvidence(buildEnvelope(), acceptedInput(), { updatedAt: NOW });
  attached.inference_attestation_summary.trusted_proof = true;
  attached.evidence.envelope_hash = computeEnvelopeHash(attached);
  assert.throws(
    () => attachToplocEvidence(attached, acceptedInput(), { updatedAt: NOW }),
    /summary mismatch/,
  );
});

test('schema and package subpath remain parseable and exported', async () => {
  const schema = JSON.parse(fs.readFileSync(
    path.join(root, 'schema', 'toploc-inference-attestation.v1.json'),
    'utf8',
  ));
  assert.equal(schema.properties.configuration_hash.$ref, '#/$defs/sha256');
  assert.ok(schema.properties.non_claims.required.includes('complete_transaction_verified'));
  assert.ok(schema.properties.authority_flags.required.includes('can_expand_scope'));
  assert.equal(schema.properties.trust.properties.trusted_proof.const, false);
  assert.equal(schema.properties.provenance.properties.proof_binding_verified.const, false);
  assert.equal(schema.properties.privacy.properties.public_safe_status.const, 'not_verified');

  const selfImport = await import('@agoragentic/transaction-assurance/toploc-evidence');
  assert.equal(selfImport.TOPLOC_ATTESTATION_SCHEMA, TOPLOC_ATTESTATION_SCHEMA);
  assert.equal(typeof selfImport.verifyToplocEvidence, 'function');
});

test('attestation collections are bounded and reject duplicate identities', () => {
  const duplicate = normalizeToplocEvidence(acceptedInput());
  assert.throws(
    () => summarizeToplocEvidence([duplicate, duplicate]),
    /duplicate TOPLOC attestation_id/,
  );

  const oversized = Array.from({ length: 101 }, (_, index) => acceptedInput({
    attestation_id: `toploc_bounded_${index}`,
  }));
  assert.throws(
    () => summarizeToplocEvidence(oversized),
    /at most 100 TOPLOC attestations/,
  );
});
