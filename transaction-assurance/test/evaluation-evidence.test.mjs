import assert from 'node:assert/strict';
import test from 'node:test';
import {
  attachEvaluationEvidence,
  normalizeEvaluationEvidence,
  summarizeEvaluationEvidence,
} from '../src/evaluation-evidence.mjs';

const base = {
  environment_id: 'agoragentic-transaction-assurance-v1',
  environment_version: '0.1.0',
  environment_hash: 'sha256:environment',
  task_id: 'ambiguous-paid-timeout',
  harness: { id: 'prime-agent', version: '0.1.0' },
  trace_hash: 'sha256:trace',
  artifact_refs: ['artifact:receipt'],
  redaction_state: 'public_safe',
};

test('normalizes deterministic evaluator evidence without granting authority', () => {
  const evidence = normalizeEvaluationEvidence({
    ...base,
    evaluators: [{ id: 'duplicate-retry', version: '1', type: 'deterministic', result: 'pass', score: 1 }],
  });
  assert.equal(evidence.schema, 'agoragentic.transaction-evaluation-evidence.v1');
  assert.match(evidence.evidence_hash, /^sha256:/);
  assert.equal(evidence.authority_flags.evaluation_grants_authority, false);
  assert.equal(evidence.source_exactness.original_trace_embedded, false);
});

test('requires exact environment and evaluator lineage', () => {
  assert.throws(() => normalizeEvaluationEvidence({ evaluators: [] }), /at least one evaluator/);
  assert.throws(() => normalizeEvaluationEvidence({
    ...base,
    evaluators: [{ id: 'judge', version: '1', type: 'unsupported', result: 'pass' }],
  }), /unsupported evaluator type/);
});

test('rejects scores outside the bounded range', () => {
  assert.throws(() => normalizeEvaluationEvidence({
    ...base,
    evaluators: [{ id: 'judge', version: '1', type: 'model_judge', result: 'pass', score: 2 }],
  }), /between 0 and 1/);
});

test('deterministic passing evidence can produce a passed evaluation summary', () => {
  const summary = summarizeEvaluationEvidence([{ ...base, evaluators: [
    { id: 'delivery', version: '1', type: 'deterministic', result: 'pass', score: 1 },
  ] }]);
  assert.equal(summary.status, 'passed');
  assert.equal(summary.complete_transaction_verified, false);
  assert.equal(summary.certification, false);
});

test('model-judge-only evidence remains review', () => {
  const summary = summarizeEvaluationEvidence([{ ...base, evaluators: [
    { id: 'semantic', version: '1', type: 'model_judge', result: 'pass', score: 0.9, model: 'model:1' },
  ] }]);
  assert.equal(summary.status, 'review');
  assert.equal(summary.mean_score, 0.9);
});

test('any failed evaluator fails the scoped evaluation summary', () => {
  const summary = summarizeEvaluationEvidence([{ ...base, evaluators: [
    { id: 'delivery', version: '1', type: 'deterministic', result: 'fail', score: 0 },
  ] }]);
  assert.equal(summary.status, 'failed');
  assert.deepEqual(summary.failed_evaluator_ids, ['delivery']);
});

test('attaches evaluation evidence without claiming the whole transaction is verified', () => {
  const envelope = {
    schema: 'agoragentic.transaction-assurance-envelope.v1',
    envelope_id: 'tae_1',
    evidence: { complete_chain_verified: true, envelope_hash: 'sha256:old' },
    authority_flags: { envelope_grants_authority: false },
  };
  const attached = attachEvaluationEvidence(envelope, {
    ...base,
    evaluators: [{ id: 'delivery', version: '1', type: 'deterministic', result: 'pass', score: 1 }],
  });
  assert.equal(attached.evaluation_evidence.length, 1);
  assert.equal(attached.evaluation_summary.status, 'passed');
  assert.equal(attached.evidence.complete_chain_verified, false);
  assert.notEqual(attached.evidence.envelope_hash, 'sha256:old');
  assert.equal(envelope.evaluation_evidence, undefined);
});
