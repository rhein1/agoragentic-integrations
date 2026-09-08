import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import Ajv from 'ajv';
import addFormats from 'ajv-formats';
import { composeHarnessEvidence } from './harness-evidence.mjs';

test('installed Harness composes fixture evidence satisfying its exported schemas', async () => {
  const run = spawnSync(process.env.ADAPTER_CONFORMANCE_PYTHON || 'python',
    [fileURLToPath(new URL('./demo.py', import.meta.url))], { encoding: 'utf8', timeout: 10000 });
  assert.equal(run.status, 0, run.stderr);
  const evidence = JSON.parse(run.stdout);
  const before = structuredClone(evidence);
  const { proof, receipt, policyDecision } = await composeHarnessEvidence(evidence);
  const ajv = new Ajv({ allErrors: true });
  addFormats(ajv);
  const schema = name => JSON.parse(readFileSync(fileURLToPath(import.meta.resolve(
    `agoragentic-harness-core/schema/${name}.v1.json`)), 'utf8'));
  ajv.addSchema(schema('harness-evaluation'));
  for (const [name, value] of [['local-proof', proof], ['local-receipt', receipt]]) {
    const validate = ajv.compile(schema(name));
    assert.equal(validate(value), true, JSON.stringify(validate.errors));
  }
  assert.deepEqual(evidence, before);
  assert.equal(receipt.spend.amount_usdc, 0);
  assert.equal(receipt.settlement_status, 'not_settlement_receipt');
  assert.equal(receipt.evidence.recorded_fixture_effects, 1);
  assert.equal(receipt.evidence.independent_verification, false);
  assert.deepEqual(receipt.evidence.local_artifacts, []);
  for (const value of Object.values(receipt.receipt_boundary)) assert.equal(value, false);
  assert.ok(policyDecision);
});
