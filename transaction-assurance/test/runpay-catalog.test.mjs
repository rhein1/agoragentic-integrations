import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  normalizeRunpayRecord as normalize, normalizeRunpayBatch as normalizeBatch,
  RUNPAY_PROFILE_ID, RUNPAY_PROFILE_DIGEST,
  RunpayImportError, parseRunpayJson as parse,
  validateRunpaySettlementRef, assertRunpaySettlementEvidence,
} from '../src/adapters/runpay-catalog.mjs';

const base = path.dirname(fileURLToPath(import.meta.url));
const example = path.join(base, '../examples/runpay/2026-09-09');
const services = () => JSON.parse(fs.readFileSync(path.join(example, 'service-fixtures.json'), 'utf8')).services;
const observability = () => JSON.parse(fs.readFileSync(path.join(example, 'observability-record.json'), 'utf8'));
const envelope = (raw, kind, source = {}) => ({
  schema: 'agoragentic.runpay-catalog.v1',
  source: { provider: 'runpay', namespace: 'sandbox:runpay-issue-376', record_kind: kind, schema_revision: '2026-09-09', ...source },
  profile_id: RUNPAY_PROFILE_ID, profile_digest: RUNPAY_PROFILE_DIGEST,
  record: { raw },
});
const code = (expected) => (error) => error?.code === expected;

// Negative fixtures first: parsing cannot erase ambiguous syntax before normalization.
for (const [name, input, expected] of [
  ['duplicate root keys', '{"x":1,"x":2}', 'duplicate_key'],
  ['duplicate nested keys', '{"nested":{"x":1,"x":2}}', 'duplicate_key'],
  ['escaped duplicate keys', '{"x":1,"\\u0078":2}', 'duplicate_key'],
  ['prototype keys', '{"__proto__":{}}', 'unsafe_key'],
  ['trailing tokens', '{} true', 'invalid_json'],
  ['lone surrogate', '"\\ud800"', 'invalid_unicode'],
  ['non-finite number', '1e400', 'unsafe_number'],
  ['unsafe integer', '9007199254740993', 'unsafe_number'],
  ['oversize JSON', ' '.repeat(1048577), 'input_too_large'],
  ['too deep', '['.repeat(33) + '0' + ']'.repeat(33), 'limit_exceeded'],
]) test(name, () => assert.throws(() => parse(input), code(expected)));

test('invalid UTF-8 is rejected consistently', () => {
  assert.throws(() => parse(Buffer.from([0xc3, 0x28])), code('invalid_utf8'));
});

test('envelope shape is enforced without echoing input', () => {
  const good = envelope(services()[0], 'catalog_service');
  assert.throws(() => normalize({ ...good, schema: 'agoragentic.other.v1' }), code('invalid_envelope'));
  assert.throws(() => normalize({ ...good, source: { ...good.source, provider: 'other' } }), code('invalid_envelope'));
  assert.throws(() => normalize({ ...good, source: { ...good.source, record_kind: 'invoice' } }), code('invalid_envelope'));
  assert.throws(() => normalize({ ...good, profile_digest: 'sha256:00' }), code('invalid_envelope'));
  assert.throws(() => normalize({ ...good, profile_digest: 'sha256:' + '0'.repeat(64) }), code('profile_digest_mismatch'));
  assert.throws(() => normalize(good, { profileId: 'other' }), code('profile_id_mismatch'));
});

test('service prices are preserved as exact decimals, never integer cents', () => {
  const batch = normalizeBatch(envelope(services(), 'catalog_service'));
  const [consensus, phone] = batch.records;
  assert.equal(consensus.core.service.price_exact, '0.02');
  assert.equal(phone.core.service.price_exact, '0.015');
  assert.equal(phone.core.service.price_currency, 'USD');
  assert.equal(phone.core.service.price_precision, 'arbitrary_numeric_no_rounding_rule');
  for (const record of batch.records) {
    assert.equal(typeof record.core.service.price_exact, 'string');
    assert.match(record.core.service.price_exact, /^(0|[1-9][0-9]*)(\.[0-9]+)?$/);
  }
});

test('vendor attribution is retained and stats stay vendor-reported', () => {
  const batch = normalizeBatch(envelope(services(), 'catalog_service'));
  for (const record of batch.records) {
    assert.equal(record.core.source.attribution, 'run.pay');
    assert.equal(record.core.source.provenance, 'vendor_supplied_fixture');
    assert.equal(record.core.source.fetched_live, false);
  }
  const phone = batch.records[1].core.service;
  assert.deepEqual(phone.vendor_reported, { trust_score: 74, total_calls: 612, avg_ms: 180, error_rate: 0 });
});

test('schema declaration status tracks the profile; missing output schema does not fail import', () => {
  const batch = normalizeBatch(envelope(services(), 'catalog_service'));
  const [consensus, phone] = batch.records.map((r) => r.core.service);
  assert.deepEqual(consensus.schema_declaration, { input: 'declared', output: 'undeclared' });
  assert.equal(consensus.input_schema_digest?.startsWith('sha256:'), true);
  assert.equal(consensus.output_schema_digest, null);
  assert.deepEqual(phone.schema_declaration, { input: 'declared', output: 'declared' });
  assert.equal(phone.output_schema_digest?.startsWith('sha256:'), true);
  assert(batch.records[0].assessment.warnings.includes('output_schema_undeclared'));
});

test('negative service fixtures are rejected without echoing values', () => {
  const [svc] = services();
  assert.throws(() => normalize(envelope({ ...svc, price_per_call: '0.015' }, 'catalog_service')), code('invalid_price'));
  assert.throws(() => normalize(envelope({ ...svc, price_per_call: -1 }, 'catalog_service')), code('invalid_price'));
  assert.throws(() => normalize(envelope({ ...svc, price_per_call: 1e-7 }, 'catalog_service')), code('invalid_price'));
  const noId = { ...svc }; delete noId.id;
  assert.throws(() => normalize(envelope(noId, 'catalog_service')), code('invalid_record'));
  assert.throws(() => normalize(envelope({ ...svc, id: ' ' }, 'catalog_service')), code('invalid_record'));
  assert.throws(() => normalize(envelope({ ...svc, vendor_name: 'sk_live_CANARY' }, 'catalog_service')), code('secret_in_evidence_field'));
});

test('unknown fields are dropped before hashing and listed in output', () => {
  const [svc] = services();
  const withExtra = { ...svc, calls_7d: 62, mystery: { nested: true } };
  const record = normalize(envelope(withExtra, 'catalog_service'));
  assert.deepEqual(record.assessment.dropped_fields, ['calls_7d', 'mystery']);
  assert(record.assessment.warnings.includes('source_fields_omitted'));
  const clean = normalize(envelope(svc, 'catalog_service'));
  assert.equal(record.core.source.redacted_source_hash, clean.core.source.redacted_source_hash);
  assert.equal(record.core.source.source_core_digest, clean.core.source.source_core_digest);
});

test('observability record keeps intent, payment status, and execution separate', () => {
  const record = normalize(envelope(observability(), 'observability_record'));
  const o = record.core.observability;
  assert.equal(o.service_selected, 'Phone Validator');
  assert.equal(o.price_exact, '0.015');
  assert.equal(o.declared_intent.intent_id, '[redacted-uuid]');
  assert.equal(o.declared_intent.max_expected_amount_exact, '0.02');
  assert.equal(o.payment_status, 'completed');
  assert.equal(o.execution_status, null);
  assert(record.assessment.warnings.includes('execution_evidence_absent'));
  assert.equal(record.assessment.overall_evidence_status, 'unresolved');
});

test('declared intent is opt-in: absent intent imports with a warning', () => {
  const raw = observability();
  delete raw.chain.declared_intent;
  const record = normalize(envelope(raw, 'observability_record'));
  assert.equal(record.core.observability.declared_intent, null);
  assert(record.assessment.warnings.includes('declared_intent_absent'));
  assert.equal(record.assessment.parse_status, 'accepted');
});

test('redacted and abbreviated settlement references are never settlement evidence', () => {
  const record = normalize(envelope(observability(), 'observability_record'));
  const o = record.core.observability;
  assert.equal(o.settlement_ref_kind, 'redacted');
  assert.equal(o.settlement_usable_as_evidence, false);
  assert(record.assessment.warnings.includes('settlement_reference_unavailable'));
  assert.throws(() => assertRunpaySettlementEvidence(record), code('invalid_settlement_evidence'));

  const raw = observability();
  raw.chain.transaction_id = '0xabc…';
  const abbreviated = normalize(envelope(raw, 'observability_record'));
  assert.equal(abbreviated.core.observability.settlement_ref_kind, 'abbreviated');
  assert.throws(() => assertRunpaySettlementEvidence(abbreviated), code('invalid_settlement_evidence'));

  assert.deepEqual(validateRunpaySettlementRef(null), { value: null, kind: 'absent' });
  assert.deepEqual(validateRunpaySettlementRef('tx_x402_[redacted]'), { value: 'tx_x402_[redacted]', kind: 'redacted' });
  assert.deepEqual(
    validateRunpaySettlementRef('0x' + 'ab'.repeat(32)),
    { value: '0x' + 'ab'.repeat(32), kind: 'evm_tx_hash' },
  );
});

test('a full settlement reference passes the settlement evidence gate', () => {
  const raw = observability();
  raw.chain.transaction_id = '0x' + 'ab'.repeat(32);
  const record = normalize(envelope(raw, 'observability_record'));
  assert.equal(record.core.observability.settlement_ref_kind, 'evm_tx_hash');
  assert.equal(assertRunpaySettlementEvidence(record), '0x' + 'ab'.repeat(32));
});

test('independent checks are never promoted by the importer', () => {
  const batch = normalizeBatch(envelope(services(), 'catalog_service'));
  for (const record of batch.records) {
    const a = record.assessment;
    assert.equal(a.independent_settlement.chain_status, 'not_checked');
    assert.equal(a.independent_settlement.matching_status, 'not_checked');
    assert.equal(a.authority, 'not_checked');
    assert.equal(a.outcome, 'not_checked');
    assert.equal(a.commercial_price, 'not_checked');
    assert.deepEqual(record.core.authority_refs, { mandate_ref: null, principal_ref: null, agent_ref: null });
  }
});

test('conflicting re-imports of the same service are flagged, never silently merged', () => {
  const [svc] = services();
  const changed = { ...svc, price_per_call: 0.03 };
  const record = normalize(envelope(changed, 'catalog_service'), { history: [envelope(svc, 'catalog_service')] });
  assert.equal(record.assessment.import_disposition, 'conflict');
  assert.equal(record.assessment.overall_evidence_status, 'contradicted');
  assert(record.assessment.conflicts.includes('price_exact'));
  const identical = normalize(envelope(svc, 'catalog_service'), { history: [envelope(svc, 'catalog_service')] });
  assert.equal(identical.assessment.import_disposition, 'duplicate');
});

test('unsupported profiles import as unsupported, never as verified', () => {
  const good = envelope(services()[0], 'catalog_service');
  good.profile_id = 'other.profile';
  good.source.schema_revision = 'unknown';
  const record = normalize(good);
  assert.equal(record.assessment.overall_evidence_status, 'unsupported');
  assert(record.assessment.warnings.includes('unsupported_profile'));
  assert.equal(record.core.service.service_id, null);
});
