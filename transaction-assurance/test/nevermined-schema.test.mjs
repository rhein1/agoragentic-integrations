import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import Ajv2020 from 'ajv/dist/2020.js';
import { normalizeNeverminedLedger, normalizeNeverminedExport } from '../src/adapters/nevermined-ledger.mjs';
const read = (path) => JSON.parse(fs.readFileSync(new URL(path, import.meta.url), 'utf8'));
const inputSchema = read('../schema/nevermined-import.v1.json');
const outputSchema = read('../schema/nevermined-evidence.v1.json');
const batchSchema = read('../schema/nevermined-evidence-batch.v1.json');
const ajv = new Ajv2020({ strict: true, allErrors: true, allowUnionTypes: true });
ajv.addSchema(inputSchema).addSchema(outputSchema).addSchema(batchSchema);
const validInput = ajv.getSchema(inputSchema.$id);
const validOutput = ajv.getSchema(outputSchema.$id);
const validBatch = ajv.getSchema(batchSchema.$id);
const fixture = () => read('../examples/nevermined/7c3e0c1/synthetic-import.json');

test('Nevermined input, output, batch and immutable golden fixture validate', () => {
  const input = fixture();
  assert(validInput(input), ajv.errorsText(validInput.errors));
  assert(validOutput(normalizeNeverminedLedger(input)), ajv.errorsText(validOutput.errors));
  assert(validBatch(normalizeNeverminedExport(input)), ajv.errorsText(validBatch.errors));
  assert(validOutput(read('../examples/nevermined/7c3e0c1/synthetic-expected.json')), ajv.errorsText(validOutput.errors));
});
test('documentation example, unsupported profile and conflicting outputs validate', () => {
  const input = fixture(); input.record.raw = read('../examples/nevermined/7c3e0c1/vendor-docs-example.json')[0];
  assert(validOutput(normalizeNeverminedLedger(input)), ajv.errorsText(validOutput.errors));
  input.source.schema_revision = 'unknown';
  assert(validOutput(normalizeNeverminedLedger(input)), ajv.errorsText(validOutput.errors));
  const changed = fixture(); changed.record.raw.amount = '999';
  assert(validOutput(normalizeNeverminedLedger(changed, { history: [fixture()] })), ajv.errorsText(validOutput.errors));
});
for (const [name, mutate] of [
  ['promoted chain result', (r) => { r.assessment.independent_settlement.chain_status = 'settled'; }],
  ['complete outcome', (r) => { r.assessment.overall_evidence_status = 'evidence_complete'; }],
  ['principal invented', (r) => { r.core.authority_refs.principal_ref = 'owner:invented'; }],
  ['unscoped raw payload', (r) => { r.raw = { arbitrary: true }; }],
  ['secret raw field', (r) => { r.core.original.apiKey = 'TEST_CANARY'; }],
  ['amount converted to number', (r) => { r.core.merchant_payment.amount_atomic = 10000; }],
  ['fee silently removed', (r) => { delete r.core.fee_legs; }],
  ['overloaded state', (r) => { r.assessment.import_disposition = 'rejected attach'; }],
]) test(`Nevermined schema rejects ${name}`, () => {
  const result = JSON.parse(JSON.stringify(normalizeNeverminedLedger(fixture())));
  mutate(result); assert.equal(validOutput(result), false);
});
