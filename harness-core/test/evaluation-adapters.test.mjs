import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import Ajv from 'ajv';
import addFormats from 'ajv-formats';
import {
  SUPPORTED_IMPECCABLE_REVISION,
  attachEvaluationEvidenceToReceipt,
  computeHarnessEvaluationHash,
  normalizeImpeccableFindings,
  normalizeSarifReport,
  verifyHarnessEvaluation,
} from '../src/evaluations/index.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const fixtures = path.join(root, 'test', 'fixtures', 'evaluations');
const analyzedRevision = '0123456789abcdef0123456789abcdef01234567';

async function fixture(name) {
  return JSON.parse(await readFile(path.join(fixtures, name), 'utf8'));
}

function impeccableOptions(overrides = {}) {
  return {
    producer_version: '3.5.0',
    source_revision: SUPPORTED_IMPECCABLE_REVISION,
    analyzed_revision: analyzedRevision,
    source_ref: 'reports/impeccable.json',
    ...overrides,
  };
}

function receipt() {
  return {
    schema: 'agoragentic.harness.local-receipt.v1',
    receipt_id: 'local_receipt_fixture',
    proof_id: 'proof_fixture',
    created_at: '2026-08-08T00:00:00.000Z',
    mode: 'local_no_spend_receipt',
    status: 'recorded',
    spend: { amount_usdc: 0, settlement_network: 'none', settlement_status: 'not_applicable' },
    evidence: {
      agent_name: 'fixture-agent',
      primary_goal: 'test evaluation evidence',
      proof_status: 'passed',
      local_artifacts: ['agent.yaml'],
    },
    receipt_boundary: {
      router_invocation_created: false,
      x402_payment_attempted: false,
      marketplace_published: false,
      hosted_runtime_provisioned: false,
      memory_written: false,
    },
  };
}

test('Impeccable advisory-only input deterministically passes without retaining raw details', async () => {
  const input = await fixture('impeccable-pass.json');
  const first = normalizeImpeccableFindings(input, impeccableOptions());
  const second = normalizeImpeccableFindings(input, impeccableOptions());
  assert.deepEqual(first, second);
  assert.equal(first.result, 'pass');
  assert.equal(first.summary.advisory, 1);
  assert.equal(first.evidence_hash, computeHarnessEvaluationHash(first));
  assert.deepEqual(verifyHarnessEvaluation(first), first);
  const serialized = JSON.stringify(first);
  assert.doesNotMatch(serialized, /private design excerpt/);
  assert.doesNotMatch(serialized, /src\/page\.css/);
});

test('configured Impeccable failure blocks the receipt while retaining suppressed evidence', async () => {
  const input = await fixture('impeccable-fail.json');
  const evaluation = normalizeImpeccableFindings(input, impeccableOptions());
  assert.equal(evaluation.result, 'fail');
  assert.equal(evaluation.summary.active, 1);
  assert.equal(evaluation.summary.suppressed, 1);
  assert.equal(evaluation.findings[1].status, 'suppressed');
  const attached = attachEvaluationEvidenceToReceipt(receipt(), evaluation);
  assert.equal(attached.status, 'blocked');
  assert.equal(attached.evaluation_summary.blocks_listing_readiness, true);
  assert.equal(attached.spend.amount_usdc, 0);
  assert.equal(attached.evaluations[0].authority_boundary.spend, false);
  const serialized = JSON.stringify(attached);
  assert.doesNotMatch(serialized, /API_KEY=must-not-escape/);
  assert.doesNotMatch(serialized, /C:\/private\/project/);
  assert.doesNotMatch(serialized, /private suppressed excerpt/);
});

test('SARIF warning produces review and preserves scanner identity plus suppression state', async () => {
  const input = await fixture('sarif-review.json');
  const evaluation = normalizeSarifReport(input, {
    analyzed_revision: analyzedRevision,
    source_ref: 'reports/security.sarif',
  });
  assert.equal(evaluation.result, 'review');
  assert.equal(evaluation.source_tools[0].name, 'example-sarif-scanner');
  assert.equal(evaluation.source_tools[0].version, '1.2.3');
  assert.equal(evaluation.summary.active, 1);
  assert.equal(evaluation.summary.suppressed, 1);
  assert.equal(evaluation.findings[1].status, 'suppressed');
  const serialized = JSON.stringify(evaluation);
  assert.doesNotMatch(serialized, /private implementation detail/);
  assert.doesNotMatch(serialized, /src\/example\.js/);
});

test('unsupported versions and tampered evidence fail closed', async () => {
  const input = await fixture('impeccable-pass.json');
  assert.throws(
    () => normalizeImpeccableFindings(input, impeccableOptions({ producer_version: '4.0.0' })),
    /Unsupported Impeccable version/,
  );
  const sarif = await fixture('sarif-review.json');
  sarif.version = '2.2.0';
  assert.throws(() => normalizeSarifReport(sarif, {
    analyzed_revision: analyzedRevision,
    source_ref: 'reports/security.sarif',
  }), /Unsupported SARIF version/);
  const evaluation = normalizeImpeccableFindings(input, impeccableOptions());
  evaluation.result = 'fail';
  assert.throws(() => verifyHarnessEvaluation(evaluation), /hash mismatch/);

  const rehashed = normalizeImpeccableFindings(input, impeccableOptions());
  rehashed.source_tools[0].version = '3.5.1';
  rehashed.evidence_hash = computeHarnessEvaluationHash(rehashed);
  assert.throws(() => verifyHarnessEvaluation(rehashed), /evaluation_id is not canonical/);

  const invalidProducer = normalizeImpeccableFindings(input, impeccableOptions());
  invalidProducer.findings[0].producer_index = 1;
  invalidProducer.evidence_hash = computeHarnessEvaluationHash(invalidProducer);
  assert.throws(() => verifyHarnessEvaluation(invalidProducer), /producer_index exceeds source_tools/);
});

test('evaluation and extended receipt schemas accept canonical evidence', async () => {
  const ajv = new Ajv({ allErrors: true, strict: false });
  addFormats(ajv);
  const evaluationSchema = JSON.parse(await readFile(path.join(root, 'schema', 'harness-evaluation.v1.json'), 'utf8'));
  const receiptSchema = JSON.parse(await readFile(path.join(root, 'schema', 'local-receipt.v1.json'), 'utf8'));
  const evaluation = normalizeImpeccableFindings(await fixture('impeccable-pass.json'), impeccableOptions());
  const attached = attachEvaluationEvidenceToReceipt(receipt(), evaluation);
  ajv.addSchema(evaluationSchema);
  assert.equal(ajv.getSchema(evaluationSchema.$id)(evaluation), true);
  assert.equal(ajv.compile(receiptSchema)(attached), true);
});

test('package exports the adapter and schema surfaces', async () => {
  const pkg = JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8'));
  assert.equal(pkg.exports['./evaluations'], './src/evaluations/index.mjs');
  assert.equal(pkg.exports['./schema/harness-evaluation.v1.json'], './schema/harness-evaluation.v1.json');
  assert.ok(pkg.files.includes('EVALUATION_ADAPTERS.md'));
  assert.match(pkg.scripts.test, /evaluation-adapters\.test\.mjs/);
});
