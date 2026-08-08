import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import {
  attachEvaluationEvidence,
  computeEvaluationEvidenceHash,
  normalizeEvaluationEvidence,
  summarizeEvaluationEvidence,
  verifyEvaluationEvidence,
} from '../src/evaluation-evidence.mjs';
import {
  buildTransactionAssuranceEnvelope,
  computeEnvelopeHash,
  normalizeAuthorityArtifact,
  sha256Ref,
} from '../src/index.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const EVIDENCE_SCHEMA = 'agoragentic.transaction-evaluation-evidence.v1';
const HASH_A = `sha256:${'a'.repeat(64)}`;
const HASH_B = `sha256:${'b'.repeat(64)}`;
const HASH_C = `sha256:${'c'.repeat(64)}`;
const OBSERVED_AT = '2026-08-06T00:02:00.000Z';

const base = {
  environment_id: 'agoragentic-transaction-assurance-v1',
  environment_version: '0.1.0',
  environment_hash: HASH_A,
  task_id: 'ambiguous-paid-timeout',
  harness: { id: 'prime-agent', version: '0.1.0' },
  trace_hash: HASH_B,
  artifact_refs: ['artifact:receipt'],
  observed_at: OBSERVED_AT,
  redaction_state: 'public_safe',
  normalization_lossless: true,
};

function deterministicEvaluator(overrides = {}) {
  return {
    id: 'duplicate-retry',
    version: '1',
    type: 'deterministic',
    result: 'pass',
    score: 1,
    rubric_hash: HASH_C,
    evidence_refs: ['artifact:receipt'],
    ...overrides,
  };
}

function evidenceInput(overrides = {}) {
  return {
    ...base,
    evaluators: [deterministicEvaluator()],
    ...overrides,
  };
}

function transactionEnvelope() {
  const normalizedAuthority = normalizeAuthorityArtifact({
    schema: 'agoragentic.agent-commerce.mandate.v1',
    owner_id: 'owner:test',
    buyer_agent_id: 'agent:test',
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
  });

  return buildTransactionAssuranceEnvelope({
    createdAt: '2026-08-06T00:01:00Z',
    updatedAt: '2026-08-06T00:01:00Z',
    now: '2026-08-06T00:01:00Z',
    normalizedAuthority,
    commercialIntent: {
      action: 'execute:research',
      taskRef: 'task:test',
      sellerRef: 'seller:test',
      capabilityRef: 'capability:test',
      category: 'research',
      quotedAmount: '0.05',
      currency: 'USDC',
    },
    payment: {
      paymentIdentifier: 'payment:test',
      rail: 'x402',
      amount: '0.05',
      currency: 'USDC',
    },
    execution: {
      idempotencyKeyHash: sha256Ref('idempotency:test'),
      inputHash: sha256Ref({ query: 'test' }),
    },
  });
}

test('normalizes lineage-complete evidence and verifies its detached hash', () => {
  const evidence = normalizeEvaluationEvidence(evidenceInput());
  assert.equal(evidence.schema, EVIDENCE_SCHEMA);
  assert.equal(evidence.evidence_hash, computeEvaluationEvidenceHash(evidence));
  assert.deepEqual(verifyEvaluationEvidence(evidence), evidence);
  assert.equal(evidence.redaction_state, 'not_verified');
  assert.equal(evidence.source_exactness.normalization_lossless, false);
  assert.equal(evidence.source_exactness.verification_status, 'not_verified');
  assert.equal(evidence.authority_flags.evaluation_grants_authority, false);
});

test('requires hashes and evaluator provenance before accepting evidence', () => {
  assert.throws(() => normalizeEvaluationEvidence({ evaluators: [] }), /at least one evaluator/);
  assert.throws(() => normalizeEvaluationEvidence(evidenceInput({ environment_hash: null })), /environment_hash is required/);
  assert.throws(() => normalizeEvaluationEvidence(evidenceInput({ harness: null })), /harness must be an object/);
  assert.throws(() => normalizeEvaluationEvidence(evidenceInput({ trace_hash: 'sha256:short' })), /trace_hash must be a sha256/);
  assert.throws(() => normalizeEvaluationEvidence(evidenceInput({
    evaluators: [deterministicEvaluator({ rubric_hash: null })],
  })), /rubric_hash is required/);
  assert.throws(() => normalizeEvaluationEvidence(evidenceInput({
    evaluators: [deterministicEvaluator({ evidence_refs: [] })],
  })), /evidence_refs requires at least one item/);
  assert.throws(() => normalizeEvaluationEvidence(evidenceInput({
    evaluators: [deterministicEvaluator({ type: 'model_judge', model_ref: null })],
  })), /model_ref is required/);
});

test('rejects unsupported evaluator types and scores outside the bounded range', () => {
  assert.throws(() => normalizeEvaluationEvidence(evidenceInput({
    evaluators: [deterministicEvaluator({ type: 'unsupported' })],
  })), /unsupported evaluator type/);
  assert.throws(() => normalizeEvaluationEvidence(evidenceInput({
    evaluators: [deterministicEvaluator({ score: 2 })],
  })), /between 0 and 1/);
});

test('deterministic passing evidence can produce only a scoped passed summary', () => {
  const normalized = normalizeEvaluationEvidence(evidenceInput());
  const summary = summarizeEvaluationEvidence([normalized]);
  assert.equal(summary.status, 'passed');
  assert.equal(summary.complete_transaction_verified, false);
  assert.equal(summary.certification, false);
  assert.equal(summary.authority_granted, false);
});

test('model-judge-only evidence remains review even with complete model lineage', () => {
  const summary = summarizeEvaluationEvidence([evidenceInput({
    evaluators: [deterministicEvaluator({
      id: 'semantic',
      type: 'model_judge',
      model_ref: 'model:1',
      score: 0.9,
    })],
  })]);
  assert.equal(summary.status, 'review');
  assert.equal(summary.mean_score, 0.9);
});

test('any failed evaluator fails the scoped evaluation summary', () => {
  const summary = summarizeEvaluationEvidence([evidenceInput({
    evaluators: [deterministicEvaluator({ id: 'delivery', result: 'fail', score: 0 })],
  })]);
  assert.equal(summary.status, 'failed');
  assert.deepEqual(summary.failed_evaluator_ids, ['delivery']);
});

test('a matching schema tag cannot bypass required fields or hash verification', () => {
  assert.throws(() => summarizeEvaluationEvidence([{
    schema: EVIDENCE_SCHEMA,
    evaluators: [deterministicEvaluator()],
  }]), /evidence_hash is required/);

  const evidence = normalizeEvaluationEvidence(evidenceInput());
  const tampered = structuredClone(evidence);
  tampered.evaluators[0].result = 'fail';
  assert.throws(() => summarizeEvaluationEvidence([tampered]), /hash mismatch/);
});

test('rehashed caller privacy claims remain non-canonical and are rejected', () => {
  const evidence = normalizeEvaluationEvidence(evidenceInput());
  const rehashedClaim = {
    ...evidence,
    redaction_state: 'public_safe',
  };
  rehashedClaim.evidence_hash = computeEvaluationEvidenceHash(rehashedClaim);
  assert.throws(() => verifyEvaluationEvidence(rehashedClaim), /unverified claims/);
});

test('arbitrary text remains explicitly unreviewed instead of being labeled public-safe', () => {
  const sentinel = 'NOT_A_REAL_SECRET_SENTINEL_123456';
  const evidence = normalizeEvaluationEvidence(evidenceInput({
    evaluators: [deterministicEvaluator({ notes: sentinel })],
    redaction_state: 'public_safe',
  }));
  assert.equal(evidence.evaluators[0].notes, sentinel);
  assert.equal(evidence.redaction_state, 'not_verified');
  assert.equal(evidence.source_exactness.verification_status, 'not_verified');
});

test('attaches verified evidence and recomputes the parent envelope hash last', () => {
  const envelope = transactionEnvelope();
  const attached = attachEvaluationEvidence(envelope, evidenceInput());
  assert.equal(attached.evaluation_evidence.length, 1);
  assert.equal(attached.evaluation_summary.status, 'passed');
  assert.equal(attached.evidence.complete_chain_verified, false);
  assert.equal(attached.evidence.envelope_hash, computeEnvelopeHash(attached));
  assert.deepEqual(verifyEvaluationEvidence(attached.evaluation_evidence[0]), attached.evaluation_evidence[0]);
  assert.equal(envelope.evaluation_evidence, undefined);
});

test('rejects a stale envelope hash and tampered previously attached evidence', () => {
  const staleEnvelope = transactionEnvelope();
  staleEnvelope.payment.amount = '0.06';
  assert.throws(() => attachEvaluationEvidence(staleEnvelope, evidenceInput()), /envelope hash mismatch/);

  const attached = attachEvaluationEvidence(transactionEnvelope(), evidenceInput());
  attached.evaluation_evidence[0].evaluators[0].result = 'fail';
  attached.evidence.envelope_hash = computeEnvelopeHash(attached);
  assert.throws(() => attachEvaluationEvidence(attached, evidenceInput({
    task_id: 'second-evaluation',
  })), /evaluation evidence hash mismatch/);
});

test('schema and package metadata preserve the integrity and export contracts', () => {
  const schema = JSON.parse(fs.readFileSync(
    path.join(root, 'schema', 'transaction-evaluation-evidence.v1.json'),
    'utf8',
  ));
  for (const field of ['environment_hash', 'harness', 'trace_hash', 'artifact_refs', 'evidence_hash']) {
    assert.ok(schema.required.includes(field), `${field} must remain required`);
  }
  assert.equal(schema.properties.redaction_state.const, 'not_verified');
  assert.equal(schema.properties.source_exactness.properties.normalization_lossless.const, false);
  assert.equal(schema.properties.source_exactness.properties.verification_status.const, 'not_verified');

  const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
  assert.equal(pkg.exports['./evaluation-evidence'], './src/evaluation-evidence.mjs');
  assert.ok(pkg.files.includes('EVALUATION_EVIDENCE.md'));
  assert.match(pkg.scripts.check, /src\/evaluation-evidence\.mjs/);
});
