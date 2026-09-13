import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const canonicalRoot = new URL('../../transaction-assurance/examples/runpay/2026-09-09/', import.meta.url);

async function readJson(url) {
  return JSON.parse(await readFile(url, 'utf8'));
}

async function sha256(url) {
  const bytes = await readFile(url);
  return `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
}

function withExactMoneyStrings(value) {
  if (Array.isArray(value)) return value.map(withExactMoneyStrings);
  if (value === null || typeof value !== 'object') return value;
  return Object.fromEntries(Object.entries(value).map(([key, child]) => [
    key,
    ['price_per_call', 'price_usd', 'max_expected_amount'].includes(key)
      ? String(child)
      : withExactMoneyStrings(child),
  ]));
}

test('Interchange fixtures are a hash-pinned exact-decimal projection of canonical source bytes', async () => {
  const provenance = await readJson(new URL('./provenance.json', import.meta.url));
  const contract = provenance.source.canonical_fixture_contract;
  const serviceUrl = new URL('service-fixtures.json', canonicalRoot);
  const observationUrl = new URL('observability-record.json', canonicalRoot);

  assert.equal(await sha256(serviceUrl), contract.service_fixture_sha256);
  assert.equal(await sha256(observationUrl), contract.observability_fixture_sha256);
  assert.equal(contract.relationship, 'exact_decimal_string_projection');

  const canonicalServices = withExactMoneyStrings((await readJson(serviceUrl)).services)
    .map((service) => ({ ...service, schema_output: service.schema_output ?? null }));
  const localServices = await Promise.all([
    readJson(new URL('./fixtures/consensus-aggregator.json', import.meta.url)),
    readJson(new URL('./fixtures/phone-validator.json', import.meta.url)),
  ]);
  assert.deepEqual(localServices.map((fixture) => fixture.service), canonicalServices);

  const canonicalObservation = withExactMoneyStrings(await readJson(observationUrl));
  const localReceipt = await readJson(new URL('./fixtures/phone-validator-receipt.json', import.meta.url));
  assert.deepEqual(localReceipt.chain, canonicalObservation.chain);
});
