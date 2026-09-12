import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

import {
  compareExactDecimals,
  normalizeRunpayReceiptFixture,
  normalizeRunpayServiceFixture,
  stableStringify,
} from './normalize.mjs';

async function fixture(name) {
  return JSON.parse(await readFile(new URL(`./fixtures/${name}`, import.meta.url), 'utf8'));
}

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

test('normalizes both services without changing exact decimal prices', async () => {
  const consensus = normalizeRunpayServiceFixture(await fixture('consensus-aggregator.json'));
  const phone = normalizeRunpayServiceFixture(await fixture('phone-validator.json'));

  assert.equal(consensus.capability_card_input.pricing.unit_price, '0.02');
  assert.equal(phone.capability_card_input.pricing.unit_price, '0.015');
  assert.equal(consensus.capability_card_input.input_schema.status, 'declared');
  assert.equal(consensus.capability_card_input.output_schema.status, 'missing');
  assert.equal(consensus.capability_card_input.output_schema.schema, null);
  assert.equal(phone.capability_card_input.input_schema.status, 'declared');
  assert.equal(phone.capability_card_input.output_schema.status, 'reconstructed');
  assert.match(phone.capability_card_input.output_schema.schema_hash, /^sha256:[0-9a-f]{64}$/);
});

test('keeps source-reported trust and runtime authority separate', async () => {
  const output = normalizeRunpayServiceFixture(await fixture('phone-validator.json'));
  assert.equal(output.source_observations.trust_score, 74);
  assert.equal(output.source_observations.trust_score_verified, false);
  assert.equal(output.source_observations.current_reachability_verified, false);
  assert.equal(output.eligibility.eligible, false);
  assert.ok(Object.values(output.authority_flags).every((value) => value === false));
  assert.equal(output.safety.external_calls_made, false);
  assert.equal(output.safety.funds_moved, false);
});

test('rejects inexact or ambiguous money inputs', async () => {
  const source = await fixture('phone-validator.json');
  for (const value of [0.015, '1e-3', ' 0.015', '0.015 ', '-0.015', '.015', '00.015', '', '1.'.padEnd(130, '0')]) {
    const candidate = clone(source);
    candidate.service.price_per_call = value;
    assert.throws(
      () => normalizeRunpayServiceFixture(candidate),
      /runpay_price_per_call_exact_decimal_string_required/,
    );
  }
});

test('preserves arbitrary precision and compares equivalent decimal strings', async () => {
  const source = await fixture('phone-validator.json');
  source.service.price_per_call = '123456789012345678901234567890.0001000';
  const output = normalizeRunpayServiceFixture(source);
  assert.equal(output.capability_card_input.pricing.unit_price, source.service.price_per_call);
  assert.equal(compareExactDecimals('0.0150', '0.015'), 0);
  assert.equal(compareExactDecimals('0.014999999999999999999', '0.015'), -1);
  assert.equal(compareExactDecimals('100000000000000000000', '99999999999999999999.999'), 1);
});

test('normalizes a redacted source payment report without promoting settlement or execution', async () => {
  const serviceFixture = await fixture('phone-validator.json');
  const receiptFixture = await fixture('phone-validator-receipt.json');
  const output = normalizeRunpayReceiptFixture({ receiptFixture, serviceFixture });

  assert.equal(output.payment.source_reported_status, 'completed');
  assert.equal(output.payment.amount, '0.015');
  assert.equal(output.payment.raw_transaction_id_retained, false);
  assert.equal(output.execution.status, 'unknown');
  assert.equal(output.execution.outcome_verified, false);
  assert.equal(output.settlement.status, 'unverified_source_report');
  assert.equal(output.settlement.confirmed, false);
  assert.equal(output.declared_intent.authorization_verified, false);
  assert.equal(output.declared_intent.price_within_declared_max, true);
  assert.ok(!stableStringify(output).includes('tx_x402_[redacted]'));
  assert.ok(Object.values(output.authority_flags).every((value) => value === false));
});

test('supports a receipt with no declared intent while retaining no authorization', async () => {
  const serviceFixture = await fixture('phone-validator.json');
  const receiptFixture = await fixture('phone-validator-receipt.json');
  delete receiptFixture.chain.declared_intent;
  const output = normalizeRunpayReceiptFixture({ receiptFixture, serviceFixture });
  assert.deepEqual(output.declared_intent, {
    status: 'absent',
    authorization_verified: false,
    price_within_declared_max: null,
    intent_ref: null,
    description: null,
    expected_category: null,
    max_expected_amount: null,
  });
});

test('rejects receipt binding and intent contradictions', async () => {
  const serviceFixture = await fixture('phone-validator.json');
  const original = await fixture('phone-validator-receipt.json');
  const cases = [
    ['runpay_receipt_service_mismatch', (value) => { value.chain.service_selected = 'Other'; }],
    ['runpay_receipt_category_mismatch', (value) => { value.chain.category = 'SEARCH'; }],
    ['runpay_receipt_price_mismatch', (value) => { value.chain.price_usd = '0.016'; }],
    ['runpay_intent_category_mismatch', (value) => { value.chain.declared_intent.expected_category = 'SEARCH'; }],
    ['runpay_price_exceeds_declared_intent_max', (value) => { value.chain.declared_intent.max_expected_amount = '0.014999'; }],
  ];
  for (const [message, mutate] of cases) {
    const candidate = clone(original);
    mutate(candidate);
    assert.throws(
      () => normalizeRunpayReceiptFixture({ receiptFixture: candidate, serviceFixture }),
      new RegExp(message),
    );
  }
});

test('stable serialization is deterministic for keys including __proto__', () => {
  const left = JSON.parse('{"z":1,"__proto__":{"polluted":true},"a":2}');
  const right = JSON.parse('{"a":2,"__proto__":{"polluted":true},"z":1}');
  assert.equal(stableStringify(left), stableStringify(right));
  assert.equal({}.polluted, undefined);
});
