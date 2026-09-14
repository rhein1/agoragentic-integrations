import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

import Ajv2020 from 'ajv/dist/2020.js';
import addFormats from 'ajv-formats';

import {
  buildReadonlyCatalogEvidence,
  RUNPAY_AUTHORIZATION_REF,
  RUNPAY_ISSUE_395,
} from './readonly-catalog-evidence.mjs';
import { hashRef } from './normalize.mjs';

const endpoint = 'https://runpay-backend-visibility-production.up.railway.app/api/services/catalog';
const consensusId = 'da3ddf15-34fa-4d1e-a5cb-a7d50a08f0fc';
const phoneId = 'd5ff985c-e50a-431a-84f1-b339ae0700b8';

function response({ offset = 0, ids = [phoneId, consensusId], prices = ['0.015', '0.02'], categories = ['DATA'] } = {}) {
  const services = ids.map((id, index) => ({
    id,
    name: `Sensitive service ${offset + index}`,
    description: 'Not retained in the evidence packet',
    category: 'DATA',
    price_per_call: prices[index],
    vendor_name: `Sensitive vendor ${offset + index}`,
    trust_score: 70,
    total_calls: 10,
    avg_ms: 20,
    error_rate: 0,
    x402_endpoint: `https://vendor.invalid/private/${offset + index}`,
  }));
  return Buffer.from(`{"services":${JSON.stringify(services).replace(/"price_per_call":"([^"]+)"/g, '"price_per_call":$1')},"total":210,"categories":${JSON.stringify(categories)},"has_more":true}`);
}

function manifest(buffers) {
  return {
    issue: RUNPAY_ISSUE_395,
    authorization: RUNPAY_AUTHORIZATION_REF,
    request_count: buffers.length,
    transport: {
      method: 'GET',
      authentication: 'none',
      credentials_supplied: false,
      redirect_followed: false,
      max_response_bytes: 262144,
      user_agent: 'test',
    },
    captures: buffers.map((buffer, index) => ({
      request: index + 1,
      started_at: `2026-09-14T16:5${index}:00Z`,
      completed_at: `2026-09-14T16:5${index}:01Z`,
      url: `${endpoint}?limit=10&offset=${index === 2 ? 10 : 0}`,
      http_status: 200,
      content_type: 'application/json; charset=utf-8',
      bytes: buffer.length,
      sha256: createHash('sha256').update(buffer).digest('hex'),
    })),
  };
}

function sample() {
  const first = response();
  return [first, Buffer.from(first), response({
    offset: 10,
    ids: ['6e7457ed-a9bc-48be-953e-54aefa787312'],
    prices: ['0.0050000000000000001'],
    categories: ['TOOLS'],
  })];
}

test('builds deterministic redacted evidence with exact decimal source tokens', () => {
  const captureBuffers = sample();
  const input = { manifest: manifest(captureBuffers), captureBuffers };
  const first = buildReadonlyCatalogEvidence(input);
  const second = buildReadonlyCatalogEvidence(input);
  assert.deepEqual(first, second);
  assert.equal(first.observations.reported_service_total, 210);
  assert.equal(first.observations.unique_service_count, 3);
  assert.equal(first.observations.repeated_first_page_byte_identical, true);
  assert.equal(
    first.observations.pages[0].redacted_projection_sha256,
    first.observations.pages[1].redacted_projection_sha256,
  );
  assert.equal(first.observations.first_and_next_page_overlap_count, 0);
  assert.equal(first.observations.categories_consistent_across_pages, false);
  assert.equal(first.observations.pages[0].services[0].price_exact, '0.015');
  assert.equal(first.observations.pages[2].services[0].price_exact, '0.0050000000000000001');
  const { evidence_sha256: digest, ...body } = first;
  assert.equal(digest, hashRef(body));

  const serialized = JSON.stringify(first);
  assert.doesNotMatch(serialized, /Sensitive service|Sensitive vendor|vendor\.invalid/);
  assert.equal(Object.values(first.authority).some(Boolean), false);
});

test('reports current profile drift without updating the offline fixture contract', () => {
  const captureBuffers = sample();
  const evidence = buildReadonlyCatalogEvidence({ manifest: manifest(captureBuffers), captureBuffers });
  assert.deepEqual(evidence.contract_drift.findings.map((finding) => finding.code), [
    'catalog_total_changed',
    'top_level_field_added',
    'fixture_schema_fields_absent',
    'categories_page_dependent',
    'service_fields_outside_offline_profile',
  ]);
  assert.equal(evidence.contract_drift.automatic_profile_update_allowed, false);
  assert.equal(evidence.contract_drift.automatic_listing_import_allowed, false);
  assert.equal(evidence.observations.known_fixture_schema_presence.phone_validator.input_schema_present, false);
  assert.equal(evidence.observations.known_fixture_schema_presence.consensus_aggregator.output_schema_present, false);
});

test('rejects tampered bytes, excess requests, unauthorized URLs, timestamps, and noncanonical prices', () => {
  const captureBuffers = sample();

  const tampered = manifest(captureBuffers);
  tampered.captures[0].sha256 = '0'.repeat(64);
  assert.throws(
    () => buildReadonlyCatalogEvidence({ manifest: tampered, captureBuffers }),
    /runpay_capture_digest_mismatch/,
  );

  const excessiveBuffers = [...captureBuffers, response({ offset: 20 })];
  assert.throws(
    () => buildReadonlyCatalogEvidence({ manifest: manifest(excessiveBuffers), captureBuffers: excessiveBuffers }),
    /runpay_capture_request_count_invalid/,
  );

  const unauthorized = manifest(captureBuffers);
  unauthorized.captures[0].url = 'https://runpay-backend-visibility-production.up.railway.app/api/services/other?limit=10&offset=0';
  assert.throws(
    () => buildReadonlyCatalogEvidence({ manifest: unauthorized, captureBuffers }),
    /runpay_capture_url_not_authorized/,
  );

  const invalidDate = manifest(captureBuffers);
  invalidDate.captures[0].started_at = '2026-09-31T16:50:00Z';
  assert.throws(
    () => buildReadonlyCatalogEvidence({ manifest: invalidDate, captureBuffers }),
    /runpay_capture_timestamp_invalid/,
  );

  const outOfOrder = manifest(captureBuffers);
  outOfOrder.captures[1].started_at = '2026-09-14T16:49:59Z';
  outOfOrder.captures[1].completed_at = '2026-09-14T16:50:00Z';
  assert.throws(
    () => buildReadonlyCatalogEvidence({ manifest: outOfOrder, captureBuffers }),
    /runpay_capture_timestamp_out_of_order/,
  );

  const exponent = Buffer.from('{"services":[{"id":"d5ff985c-e50a-431a-84f1-b339ae0700b8","category":"DATA","price_per_call":1e-3,"vendor_name":"vendor"}],"total":206,"categories":["DATA"],"has_more":false}');
  assert.throws(
    () => buildReadonlyCatalogEvidence({ manifest: manifest([exponent]), captureBuffers: [exponent] }),
    /runpay_capture_price_invalid/,
  );
});

test('committed capture evidence satisfies the strict schema and self-hash', async () => {
  const schema = JSON.parse(await readFile(new URL('./readonly-catalog-evidence.schema.json', import.meta.url), 'utf8'));
  const evidence = JSON.parse(await readFile(new URL('./evidence/readonly-catalog-2026-09-14.json', import.meta.url), 'utf8'));
  const ajv = new Ajv2020({ allErrors: true, strict: true });
  addFormats(ajv);
  const validate = ajv.compile(schema);
  assert.equal(validate(evidence), true, JSON.stringify(validate.errors));
  const { evidence_sha256: digest, ...body } = evidence;
  assert.equal(digest, hashRef(body));
  assert.equal(evidence.trial.request_count, 3);
  assert.equal(evidence.observations.reported_service_total, 210);
  assert.equal(evidence.observations.unique_service_count, 20);
  assert.equal(evidence.observations.first_and_next_page_overlap_count, 0);
  assert.equal(evidence.contract_drift.detected, true);
  assert.equal(Object.values(evidence.authority).some(Boolean), false);
});
