import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  AGORAGENTIC_ARD_NAMESPACE,
  ArdProfileError,
  AUTHORITY_FIELDS,
  DESCRIPTIVE_EXTENSION_FIELDS,
  DISCOVERY_AUTHORITY_FIELDS,
  EXTENSION_DEFAULT_FIELDS,
  LIMITS,
  LOCAL_PROFILE_FIELDS,
  loadPinnedContext,
  normalizeManifest,
  parseIdentifier,
  validateManifest,
} from '../src/profile.mjs';
import { buildArtifacts } from '../src/generate.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (relative) => fs.readFileSync(path.join(root, relative), 'utf8');
const json = (relative) => JSON.parse(read(relative));

function expectCode(code, action) {
  assert.throws(action, (error) => error instanceof ArdProfileError && error.code === code);
}

test('vendored ARD files are byte-exact to the pinned provenance', () => {
  const provenance = json('provenance.json');
  for (const file of provenance.upstream.files) {
    const bytes = fs.readFileSync(path.join(root, file.path));
    assert.equal(bytes.length, file.bytes);
    assert.equal(createHash('sha256').update(bytes).digest('hex'), file.sha256);
  }
});

test('local ARD extension context is byte-pinned for cross-repository parity', () => {
  const context = json('provenance.json').local_artifacts.context;
  const bytes = fs.readFileSync(path.join(root, context.path));
  assert.equal(context.uri, 'https://agoragentic.com/ns/ard/v1');
  assert.equal(context.namespace, AGORAGENTIC_ARD_NAMESPACE);
  assert.equal(bytes.length, context.bytes);
  assert.equal(createHash('sha256').update(bytes).digest('hex'), context.sha256);
});

test('identifier hardening requires a valid FQDN plus namespace and terminal name', () => {
  assert.deepEqual(parseIdentifier('urn:air:agoragentic.com:server:mcp'), {
    publisher: 'agoragentic.com',
    resourceSegments: ['server', 'mcp'],
  });
  expectCode('ard_identifier_shape', () => parseIdentifier('urn:air:agoragentic.com:onlyone'));
  expectCode('ard_identifier_publisher', () => parseIdentifier('urn:air:not_a_domain:protocol:mcp'));
  expectCode('ard_identifier_publisher', () => parseIdentifier('urn:air:Agoragentic.com:protocol:mcp'));
});

test('valid local fixture normalizes offline with no authority', () => {
  const result = normalizeManifest(read('fixtures/valid/minimal.json'));
  assert.equal(result.entries.length, 1);
  assert.deepEqual(result.authority, {
    networkFetch: false,
    execution: false,
    payment: false,
    trustPromotion: false,
    publication: false,
    routeEligibleFromDiscovery: false,
    rankingEligibleFromDiscovery: false,
    listingEligibleFromDiscovery: false,
    paymentEligibleFromDiscovery: false,
    settlementEligibleFromDiscovery: false,
    trustPromotedFromDiscovery: false,
    executionAuthorizedFromDiscovery: false,
    authenticationBypassGranted: false,
    publicationAuthorizedFromDiscovery: false,
    riskForkBypassGranted: false,
  });
  assert.equal(result.entries[0].eligible, false);
  assert.equal(result.entries[0].trustVerified, false);
});

test('optional predecessor-compatible host is bounded, validated, and preserved', () => {
  const fixture = json('fixtures/valid/with-host.json');
  const result = normalizeManifest(fixture);
  assert.deepEqual(result.host, fixture.host);

  const invalidUri = json('fixtures/valid/with-host.json');
  invalidUri.host.documentationUrl = 'not an absolute URI';
  expectCode('ard_host_uri', () => normalizeManifest(invalidUri));

  const unsupportedField = json('fixtures/valid/with-host.json');
  unsupportedField.host.endpoint = 'https://example.com/execute';
  expectCode('ard_host_property', () => normalizeManifest(unsupportedField));

  const oversizedDisplayName = json('fixtures/valid/with-host.json');
  oversizedDisplayName.host.displayName = 'x'.repeat(161);
  expectCode('ard_invalid_string', () => normalizeManifest(oversizedDisplayName));
});

test('url and data are an exclusive choice', () => {
  expectCode('ard_url_data_xor', () => normalizeManifest(read('fixtures/adversarial/url-and-data.json')));
  const missing = json('fixtures/valid/minimal.json');
  delete missing.entries[0].data;
  expectCode('ard_url_data_xor', () => normalizeManifest(missing));

  const profileSchema = json('schema/agoragentic-ard-profile.v0.91.schema.json');
  assert.equal(profileSchema.$defs.entry.properties.url.pattern, '^https://');
  for (const url of ['https:example.com/card', 'https:/example.com/card']) {
    const nonLiteralHttps = json('fixtures/valid/minimal.json');
    delete nonLiteralHttps.entries[0].data;
    nonLiteralHttps.entries[0].url = url;
    expectCode('ard_url_scheme', () => normalizeManifest(nonLiteralHttps));
  }
});

test('representative query guidance produces warnings rather than promotion', () => {
  const profileSchema = json('schema/agoragentic-ard-profile.v0.91.schema.json');
  assert.equal(profileSchema.$defs.entry.required.includes('representativeQueries'), false);
  assert.equal(profileSchema.$defs.entry.properties.representativeQueries.type, 'array');
  assert.equal(profileSchema.$defs.entry.properties.representativeQueries.uniqueItems, true);

  const fixture = json('fixtures/valid/minimal.json');
  delete fixture.entries[0].representativeQueries;
  assert.deepEqual(validateManifest(fixture).warnings.map((item) => item.code), ['ard_representative_queries_missing']);
  fixture.entries[0].representativeQueries = ['one'];
  assert.deepEqual(validateManifest(fixture).warnings.map((item) => item.code), ['ard_representative_queries_count']);
  fixture.entries[0].representativeQueries = ['one', 'two', 'three', 'four', 'five', 'six'];
  assert.deepEqual(validateManifest(fixture).warnings.map((item) => item.code), ['ard_representative_queries_count']);
  fixture.entries[0].representativeQueries = ['duplicate', 'duplicate'];
  expectCode('ard_array_duplicate', () => normalizeManifest(fixture));
});

test('only pinned contexts resolve and no remote dereference is attempted', () => {
  let fetchCalls = 0;
  const previousFetch = globalThis.fetch;
  globalThis.fetch = async () => {
    fetchCalls += 1;
    throw new Error('network must not be reached');
  };
  try {
    assert.equal(loadPinnedContext('https://agenticresourcediscovery.org/context/v1')['@context']['@version'], 1.1);
    expectCode('ard_context_not_allowlisted', () => normalizeManifest(read('fixtures/adversarial/unknown-context.json')));
    const missingExtension = json('fixtures/valid/minimal.json');
    missingExtension.entries[0]['@context'] = ['https://agenticresourcediscovery.org/context/v1'];
    expectCode('ard_context_profile', () => normalizeManifest(missingExtension));
    const reversed = json('fixtures/valid/minimal.json');
    reversed.entries[0]['@context'].reverse();
    expectCode('ard_context_profile', () => normalizeManifest(reversed));
    assert.equal(fetchCalls, 0);
  } finally {
    globalThis.fetch = previousFetch;
  }
  const source = read('src/profile.mjs');
  assert.equal(source.includes('node:http'), false);
  assert.equal(source.includes('node:https'), false);
});

test('local JSON-LD vocabulary uses the shared ARD namespace and covers the bounded contract', () => {
  const context = loadPinnedContext('https://agoragentic.com/ns/ard/v1')['@context'];
  assert.equal(context.ag, AGORAGENTIC_ARD_NAMESPACE);
  const terms = [
    'trustState',
    'riskLevel',
    'executionAuthorizationRequired',
    'riskForkAvailable',
    'riskForkRequired',
    'transactionAssuranceAvailable',
    'paymentRails',
    'priceModel',
    'receiptVerifier',
    'providerQualification',
    'executionAuthorityGranted',
    'paymentAuthorityGranted',
    'trustPromotionAuthorized',
    'publicationAuthorityGranted',
    'networkDereferenceAllowed',
    'liveExecutionAvailable',
    'routeEligibleFromDiscovery',
    'rankingEligibleFromDiscovery',
    'listingEligibleFromDiscovery',
    'paymentEligibleFromDiscovery',
    'settlementEligibleFromDiscovery',
    'trustPromotedFromDiscovery',
    'executionAuthorizedFromDiscovery',
    'authenticationBypassGranted',
    'publicationAuthorizedFromDiscovery',
    'riskForkBypassGranted',
    'sourceOnly',
    'defaultOff',
  ];
  for (const term of terms) {
    const mapping = typeof context[term] === 'string' ? context[term] : context[term]?.['@id'];
    assert.equal(mapping, `ag:${term}`, term);
  }
  assert.equal(JSON.stringify(context).includes('https://agoragentic.com/ns#'), false);
});

test('all fixed authority aliases normalize to canonical safe keys and conflicts fail closed', () => {
  const policies = [
    ...Object.entries(AUTHORITY_FIELDS).map(([canonical, expected]) => ({ canonical, expected, errorCode: 'ard_authority_not_fail_closed' })),
    ...Object.entries(DISCOVERY_AUTHORITY_FIELDS).map(([canonical, expected]) => ({ canonical, expected, errorCode: 'ard_discovery_authority_not_fail_closed' })),
  ];
  for (const { canonical, expected, errorCode } of policies) {
    const term = canonical.slice(3);
    const expanded = `${AGORAGENTIC_ARD_NAMESPACE}${term}`;
    const safe = json('fixtures/valid/minimal.json');
    safe.entries[0][term] = expected;
    safe.entries[0][expanded] = expected;
    const expectedSourceHash = createHash('sha256').update(JSON.stringify(safe)).digest('hex');
    const result = normalizeManifest(safe);
    const normalized = result.entries[0].entry;
    assert.equal(result.sourceSha256, expectedSourceHash);
    assert.equal(normalized[canonical], expected, canonical);
    assert.equal(Object.hasOwn(normalized, term), false, term);
    assert.equal(Object.hasOwn(normalized, expanded), false, expanded);

    const aliasConflict = json('fixtures/valid/minimal.json');
    aliasConflict.entries[0][term] = !expected;
    expectCode('ard_authority_alias_conflict', () => normalizeManifest(aliasConflict));

    const expandedConflict = json('fixtures/valid/minimal.json');
    expandedConflict.entries[0][expanded] = !expected;
    expectCode('ard_authority_alias_conflict', () => normalizeManifest(expandedConflict));

    const canonicalMismatch = json('fixtures/valid/minimal.json');
    canonicalMismatch.entries[0][canonical] = !expected;
    expectCode(errorCode, () => normalizeManifest(canonicalMismatch));
  }
});

test('all descriptive extension aliases canonicalize safely and conflicting equivalents fail closed', () => {
  const profileSchema = json('schema/agoragentic-ard-profile.v0.91.schema.json');
  const context = loadPinnedContext('https://agoragentic.com/ns/ard/v1')['@context'];
  const contextFields = Object.keys(context)
    .filter((term) => term !== '@version' && term !== 'ag')
    .map((term) => `ag:${term}`);
  assert.equal(LOCAL_PROFILE_FIELDS.length, 28);
  assert.deepEqual(new Set(LOCAL_PROFILE_FIELDS), new Set(contextFields));

  const nonCanonicalNameGuards = profileSchema.$defs.entry.propertyNames.not.anyOf
    .map(({ pattern }) => new RegExp(pattern));
  const conflictingValues = {
    'ag:trustState': 'verified',
    'ag:riskLevel': 'low',
    'ag:executionAuthorizationRequired': false,
    'ag:riskForkAvailable': false,
    'ag:riskForkRequired': true,
    'ag:transactionAssuranceAvailable': false,
    'ag:paymentRails': [],
    'ag:priceModel': 'none',
    'ag:receiptVerifier': null,
    'ag:providerQualification': 'source_only_not_live_qualified',
  };
  assert.deepEqual(new Set(Object.keys(conflictingValues)), new Set(DESCRIPTIVE_EXTENSION_FIELDS));

  for (const canonical of DESCRIPTIVE_EXTENSION_FIELDS) {
    const term = canonical.slice(3);
    const expanded = `${AGORAGENTIC_ARD_NAMESPACE}${term}`;
    assert.ok(nonCanonicalNameGuards.some((guard) => guard.test(term)), term);
    assert.ok(nonCanonicalNameGuards.some((guard) => guard.test(expanded)), expanded);

    const safe = json('fixtures/valid/minimal.json');
    safe.entries[0][term] = structuredClone(safe.entries[0][canonical]);
    safe.entries[0][expanded] = structuredClone(safe.entries[0][canonical]);
    const normalized = normalizeManifest(safe).entries[0].entry;
    assert.deepEqual(normalized[canonical], safe.entries[0][canonical], canonical);
    assert.equal(Object.hasOwn(normalized, term), false, term);
    assert.equal(Object.hasOwn(normalized, expanded), false, expanded);

    const compactConflict = json('fixtures/valid/minimal.json');
    compactConflict.entries[0][term] = conflictingValues[canonical];
    expectCode('ard_extension_alias_conflict', () => normalizeManifest(compactConflict));

    const expandedConflict = json('fixtures/valid/minimal.json');
    expandedConflict.entries[0][expanded] = conflictingValues[canonical];
    expectCode('ard_extension_alias_conflict', () => normalizeManifest(expandedConflict));
  }

  for (const canonical of [...Object.keys(AUTHORITY_FIELDS), ...Object.keys(DISCOVERY_AUTHORITY_FIELDS)]) {
    const term = canonical.slice(3);
    const expanded = `${AGORAGENTIC_ARD_NAMESPACE}${term}`;
    assert.ok(nonCanonicalNameGuards.some((guard) => guard.test(term)), term);
    assert.ok(nonCanonicalNameGuards.some((guard) => guard.test(expanded)), expanded);
  }
});

test('malformed and oversized inputs fail closed', () => {
  expectCode('ard_malformed_json', () => normalizeManifest(read('fixtures/adversarial/malformed.json')));
  expectCode('ard_malformed_object', () => normalizeManifest({ toJSON() { return undefined; } }));
  expectCode('ard_manifest_shape', () => normalizeManifest('null'));
  expectCode('ard_manifest_shape', () => normalizeManifest('[]'));
  const oversize = JSON.stringify({ entries: [], padding: 'x'.repeat(LIMITS.manifestBytes) });
  expectCode('ard_manifest_oversize', () => normalizeManifest(oversize));
});

test('manifest roots match the closed local profile', () => {
  const missingVersion = json('fixtures/valid/minimal.json');
  delete missingVersion.specVersion;
  expectCode('ard_spec_version', () => normalizeManifest(missingVersion));

  const extraRoot = json('fixtures/valid/minimal.json');
  extraRoot.extra = 'not allowed by the local profile';
  expectCode('ard_manifest_root_property', () => normalizeManifest(extraRoot));
});

test('preserved optional upstream entry fields retain their declared types', () => {
  const invalidDescription = json('fixtures/valid/minimal.json');
  invalidDescription.entries[0].description = { bad: true };
  expectCode('ard_invalid_string', () => normalizeManifest(invalidDescription));

  const invalidVersion = json('fixtures/valid/minimal.json');
  invalidVersion.entries[0].version = 1;
  expectCode('ard_invalid_string', () => normalizeManifest(invalidVersion));

  const invalidUpdatedAt = json('fixtures/valid/minimal.json');
  invalidUpdatedAt.entries[0].updatedAt = 'not-a-date';
  expectCode('ard_updated_at', () => normalizeManifest(invalidUpdatedAt));
});

test('draft identifier and context adversarial fixtures fail closed', () => {
  expectCode('ard_identifier_shape', () => normalizeManifest(read('fixtures/adversarial/invalid-identifier.json')));
  expectCode('ard_authority_not_fail_closed', () => normalizeManifest(read('fixtures/adversarial/authority-true.json')));
  for (const name of ['authority-alias-conflict.json', 'authority-expanded-iri-conflict.json']) {
    const vector = json(`fixtures/adversarial/${name}`);
    const fixture = json('fixtures/valid/minimal.json');
    Object.assign(fixture.entries[0], vector.entryPatch);
    expectCode(vector.expectedError, () => normalizeManifest(fixture));
  }
});

test('discovery-derived authority fails closed independently', () => {
  expectCode('ard_discovery_authority_not_fail_closed', () => normalizeManifest(read('fixtures/adversarial/discovery-authority-true.json')));
  for (const field of Object.keys(DISCOVERY_AUTHORITY_FIELDS)) {
    const fixture = json('fixtures/valid/minimal.json');
    fixture.entries[0][field] = true;
    expectCode('ard_discovery_authority_not_fail_closed', () => normalizeManifest(fixture));
  }
});

test('extension metadata is required and internally consistent', () => {
  const profileSchema = json('schema/agoragentic-ard-profile.v0.91.schema.json');
  assert.equal(profileSchema.$defs.entry.properties['ag:riskForkAvailable'].const, true);

  const missing = json('fixtures/valid/minimal.json');
  delete missing.entries[0]['ag:trustState'];
  expectCode('ard_extension_contract', () => normalizeManifest(missing));

  const inconsistent = json('fixtures/valid/minimal.json');
  inconsistent.entries[0]['ag:transactionAssuranceAvailable'] = false;
  expectCode('ard_extension_contract', () => normalizeManifest(inconsistent));

  const unavailableRiskFork = json('fixtures/valid/minimal.json');
  unavailableRiskFork.entries[0]['ag:riskForkAvailable'] = false;
  expectCode('ard_extension_contract', () => normalizeManifest(unavailableRiskFork));
});

test('portable Marketplace capability-card mapping satisfies the source-only profile', () => {
  const result = normalizeManifest(read('fixtures/valid/marketplace-capability-card-mapped.json'));
  const entry = result.entries[0].entry;
  assert.equal(entry.type, 'application/vnd.agoragentic.capability-card+json');
  assert.equal(entry.data.raw_payload_included, false);
  assert.equal(Object.hasOwn(entry.data, 'source_ref'), false);
  assert.equal(entry['ag:transactionAssuranceAvailable'], false);
  assert.deepEqual(entry['ag:paymentRails'], []);
  assert.equal(entry['ag:priceModel'], 'none');
  assert.equal(entry['ag:receiptVerifier'], null);
  assert.equal(entry['ag:providerQualification'], 'snapshot_unverified');
  assert.equal(result.entries[0].eligible, false);
  assert.equal(result.entries[0].trustVerified, false);
});

test('all canonical examples keep authority false and default-off true', () => {
  const source = json('source/manifest.source.json');
  assert.equal(source.entries.length, 4);
  for (const entry of source.entries) {
    for (const [field, expected] of Object.entries(AUTHORITY_FIELDS)) assert.equal(entry[field], expected, `${entry.identifier} ${field}`);
    for (const [field, expected] of Object.entries(DISCOVERY_AUTHORITY_FIELDS)) assert.equal(entry[field], expected, `${entry.identifier} ${field}`);
    for (const [field, expected] of Object.entries(EXTENSION_DEFAULT_FIELDS)) assert.equal(entry[field], expected, `${entry.identifier} ${field}`);
  }
  const normalized = normalizeManifest({ specVersion: source.specVersion, entries: source.entries });
  assert.ok(normalized.entries.every((item) => item.eligible === false && item.trustVerified === false));
});

test('canonical examples match the Marketplace descriptive-contract matrix', () => {
  const source = json('source/manifest.source.json');
  const verifier = 'https://agoragentic.com/api/commerce/interchange/receipts/verify';
  const expected = {
    'urn:air:agoragentic.com:registry:interchange': {
      assurance: true,
      rails: ['internal_usdc_wallet', 'x402'],
      priceModel: 'separate_execution_contract',
      receiptVerifier: verifier,
      providerQualification: 'snapshot_unverified',
    },
    'urn:air:agoragentic.com:server:mcp': {
      assurance: true,
      rails: ['x402', 'internal_usdc_wallet'],
      priceModel: 'tool_specific',
      receiptVerifier: verifier,
      providerQualification: 'snapshot_unverified',
    },
    'urn:air:agoragentic.com:agent:a2a': {
      assurance: true,
      rails: ['x402', 'internal_usdc_wallet'],
      priceModel: 'capability_specific',
      receiptVerifier: verifier,
      providerQualification: 'snapshot_unverified',
    },
    'urn:air:agoragentic.com:skill:risk-fork': {
      assurance: false,
      rails: [],
      priceModel: 'none',
      receiptVerifier: null,
      providerQualification: 'source_only_not_live_qualified',
    },
  };
  for (const entry of source.entries) {
    const contract = expected[entry.identifier];
    assert.ok(contract, entry.identifier);
    assert.equal(entry['ag:transactionAssuranceAvailable'], contract.assurance);
    assert.deepEqual(entry['ag:paymentRails'], contract.rails);
    assert.equal(entry['ag:priceModel'], contract.priceModel);
    assert.equal(entry['ag:receiptVerifier'], contract.receiptVerifier);
    assert.equal(entry['ag:providerQualification'], contract.providerQualification);
  }
});

test('lower-case trustManifest is bound to the URN publisher but never verified', () => {
  const profileSchema = json('schema/agoragentic-ard-profile.v0.91.schema.json');
  assert.equal(profileSchema.$defs.entry.properties.trustManifest.properties.identity.maxLength, LIMITS.string);

  const fixture = json('fixtures/valid/minimal.json');
  fixture.entries[0].trustManifest = { identity: 'https://example.com/workload' };
  assert.equal(normalizeManifest(fixture).entries[0].trustVerified, false);
  fixture.entries[0].trustManifest.identity = 'https://other.example/workload';
  expectCode('ard_trust_domain_mismatch', () => normalizeManifest(fixture));
  fixture.entries[0].trustManifest.identity = `https://example.com/${'x'.repeat(LIMITS.string)}`;
  expectCode('ard_invalid_string', () => normalizeManifest(fixture));
  delete fixture.entries[0].trustManifest;
  fixture.entries[0].TrustManifest = { identity: 'https://example.com/workload' };
  expectCode('ard_trust_manifest_capitalization', () => normalizeManifest(fixture));
});

test('canonical and predecessor outputs are byte-identical compatibility aliases', () => {
  const artifacts = buildArtifacts();
  assert.equal(read('generated/ard.json'), artifacts.body);
  assert.equal(read('generated/ai-catalog.json'), artifacts.body);
  assert.equal(read('generated/ard.json'), read('generated/ai-catalog.json'));
  const manifest = JSON.parse(artifacts.body);
  assert.equal(manifest.specVersion, '1.0');
  assert.equal(manifest.entries.length, 4);
});
