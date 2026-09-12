import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import Ajv2020 from 'ajv/dist/2020.js';
import { normalizeRunpayRecord, normalizeRunpayBatch } from '../src/adapters/runpay-catalog.mjs';
import { RUNPAY_PROFILE_ID, RUNPAY_PROFILE_DIGEST } from '../src/adapters/runpay-profile.mjs';

const read = (path) => JSON.parse(fs.readFileSync(new URL(path, import.meta.url), 'utf8'));
const inputSchema = read('../schema/runpay-catalog.v1.json');
const outputSchema = read('../schema/runpay-evidence.v1.json');
const batchSchema = read('../schema/runpay-evidence-batch.v1.json');
const ajv = new Ajv2020({ strict: true, allErrors: true, allowUnionTypes: true });
ajv.addSchema(inputSchema).addSchema(outputSchema).addSchema(batchSchema);
const validInput = ajv.getSchema(inputSchema.$id);
const validOutput = ajv.getSchema(outputSchema.$id);
const validBatch = ajv.getSchema(batchSchema.$id);

const services = () => JSON.parse(fs.readFileSync(new URL('../examples/runpay/2026-09-09/service-fixtures.json', import.meta.url), 'utf8')).services;
const observability = () => JSON.parse(fs.readFileSync(new URL('../examples/runpay/2026-09-09/observability-record.json', import.meta.url), 'utf8'));
const envelope = (raw, kind) => ({
  schema: 'agoragentic.runpay-catalog.v1',
  source: { provider: 'runpay', namespace: 'sandbox:runpay-issue-376', record_kind: kind, schema_revision: '2026-09-09' },
  profile_id: RUNPAY_PROFILE_ID, profile_digest: RUNPAY_PROFILE_DIGEST,
  record: { raw },
});

test('run.pay input envelope, evidence, batch, and golden fixture validate', () => {
  const input = envelope(services(), 'catalog_service');
  assert(validInput(input), ajv.errorsText(validInput.errors));
  const batch = normalizeRunpayBatch(input);
  assert(validBatch(batch), ajv.errorsText(validBatch.errors));
  for (const record of batch.records) assert(validOutput(record), ajv.errorsText(validOutput.errors));
  const obs = normalizeRunpayRecord(envelope(observability(), 'observability_record'));
  assert(validOutput(obs), ajv.errorsText(validOutput.errors));
  assert(validBatch(read('../examples/runpay/2026-09-09/synthetic-expected.json')), ajv.errorsText(validBatch.errors));
});

test('golden fixture matches a fresh import byte-for-byte', () => {
  const fresh = normalizeRunpayBatch(envelope(services(), 'catalog_service'));
  const golden = read('../examples/runpay/2026-09-09/synthetic-expected.json');
  assert.equal(JSON.stringify(fresh), JSON.stringify(golden));
});

for (const [name, kind, mutate] of [
  ['promoted chain result', 'catalog_service', (r) => { r.assessment.independent_settlement.chain_status = 'settled'; }],
  ['principal invented', 'catalog_service', (r) => { r.core.authority_refs.principal_ref = 'owner:invented'; }],
  ['unscoped raw payload', 'catalog_service', (r) => { r.raw = { arbitrary: true }; }],
  ['secret raw field', 'catalog_service', (r) => { r.core.original.apiKey = 'TEST_CANARY'; }],
  ['price converted to number', 'catalog_service', (r) => { r.core.service.price_exact = 0.015; }],
  ['service silently removed', 'catalog_service', (r) => { delete r.core.service; }],
  ['overloaded state', 'catalog_service', (r) => { r.assessment.import_disposition = 'rejected attach'; }],
  ['redacted ref marked usable', 'observability_record', (r) => { r.core.observability.settlement_usable_as_evidence = true; }],
  ['settlement kind invented', 'observability_record', (r) => { r.core.observability.settlement_ref_kind = 'confirmed'; }],
]) test(`run.pay schema rejects ${name}`, () => {
  const raw = kind === 'catalog_service' ? services()[1] : observability();
  const result = JSON.parse(JSON.stringify(normalizeRunpayRecord(envelope(raw, kind))));
  mutate(result);
  assert.equal(validOutput(result), false);
});

test('run.pay schema rejects an undeclared schema_declaration status', () => {
  const result = JSON.parse(JSON.stringify(normalizeRunpayRecord(envelope(services()[1], 'catalog_service'))));
  result.core.service.schema_declaration = { input: 'declared', output: 'maybe' };
  assert.equal(validOutput(result), false);
});
