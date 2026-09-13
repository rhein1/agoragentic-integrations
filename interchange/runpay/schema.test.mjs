import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

import Ajv2020 from 'ajv/dist/2020.js';
import addFormats from 'ajv-formats';

import { normalizeRunpayReceiptFixture, normalizeRunpayServiceFixture } from './normalize.mjs';

async function json(relativePath) {
  return JSON.parse(await readFile(new URL(relativePath, import.meta.url), 'utf8'));
}

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function compile(schema) {
  const ajv = new Ajv2020({ allErrors: true, strict: true });
  addFormats(ajv);
  return ajv.compile(schema);
}

test('service outputs satisfy the strict public schema', async () => {
  const schema = await json('./runpay-service-import.schema.json');
  const validate = compile(schema);
  for (const name of ['consensus-aggregator.json', 'phone-validator.json']) {
    const output = normalizeRunpayServiceFixture(await json(`./fixtures/${name}`));
    assert.equal(validate(output), true, JSON.stringify(validate.errors));
  }
});

test('receipt output satisfies the strict public schema', async () => {
  const schema = await json('./runpay-receipt-observation.schema.json');
  const validate = compile(schema);
  const output = normalizeRunpayReceiptFixture({
    serviceFixture: await json('./fixtures/phone-validator.json'),
    receiptFixture: await json('./fixtures/phone-validator-receipt.json'),
  });
  assert.equal(validate(output), true, JSON.stringify(validate.errors));
});

test('schemas reject authority escalation and malformed schema provenance', async () => {
  const serviceSchema = await json('./runpay-service-import.schema.json');
  const receiptSchema = await json('./runpay-receipt-observation.schema.json');
  const validateService = compile(serviceSchema);
  const validateReceipt = compile(receiptSchema);
  const service = normalizeRunpayServiceFixture(await json('./fixtures/phone-validator.json'));
  const receipt = normalizeRunpayReceiptFixture({
    serviceFixture: await json('./fixtures/phone-validator.json'),
    receiptFixture: await json('./fixtures/phone-validator-receipt.json'),
  });

  const promotedService = clone(service);
  promotedService.authority_flags.eligible_for_execution = true;
  assert.equal(validateService(promotedService), false);
  const malformedMissing = normalizeRunpayServiceFixture(await json('./fixtures/consensus-aggregator.json'));
  malformedMissing.capability_card_input.output_schema.schema = {};
  assert.equal(validateService(malformedMissing), false);
  const promotedReceipt = clone(receipt);
  promotedReceipt.settlement.confirmed = true;
  assert.equal(validateReceipt(promotedReceipt), false);
});
