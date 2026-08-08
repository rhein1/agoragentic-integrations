'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  findProhibitedClaims,
  findUnsupportedHarnessBrandClaims,
  hasAffirmativeReceiptEquivalence,
} = require('../scripts/verify-ecosystem-profile.js');

const explicitNonEquivalenceFixtures = [
  'A local receipt is not a settlement receipt.',
  'Local receipts are never settlement receipts.',
  'A local receipt is not equivalent to a settlement receipt.',
  'A local receipt is not the same as a settlement receipt.',
  'Do not treat a local receipt as a settlement receipt.',
  'Local receipts should never be treated as settlement receipts.',
  'A local receipt records configuration proof; settlement receipts are separate.',
];

const affirmativeEquivalenceFixtures = [
  'A local receipt is a settlement receipt.',
  'Local receipts are settlement receipts.',
  'Local receipt = settlement receipt.',
  'A local receipt is equivalent to a settlement receipt.',
  'A local receipt is the same as a settlement receipt.',
  'A local receipt counts as a settlement receipt.',
  'Local receipts can be treated as settlement receipts.',
  'Local receipts and settlement receipts are interchangeable.',
];

test('explicit receipt non-equivalence statements remain allowed', () => {
  for (const fixture of explicitNonEquivalenceFixtures) {
    assert.equal(hasAffirmativeReceiptEquivalence(fixture), false, fixture);
    assert.deepEqual(findProhibitedClaims({ boundaries: [fixture] }), [], fixture);
  }
});

test('affirmative local-to-settlement receipt equivalence is rejected', () => {
  for (const fixture of affirmativeEquivalenceFixtures) {
    assert.equal(hasAffirmativeReceiptEquivalence(fixture), true, fixture);
    assert.ok(
      findProhibitedClaims({ boundaries: [fixture] })
        .some((claim) => claim.includes('equates a local receipt with a settlement receipt')),
      fixture,
    );
  }
});

test('unsupported Harness Core execution and receipt claims are rejected', () => {
  assert.deepEqual(
    findUnsupportedHarnessBrandClaims(
      'intent → policy → approval → host boundary → local receipt; inspectable, schema-checkable local receipt',
    ),
    [],
  );

  assert.ok(
    findUnsupportedHarnessBrandClaims('Give any agent a verifiable local receipt.')
      .some((claim) => claim.includes('without naming a verification mechanism')),
  );
  assert.ok(
    findUnsupportedHarnessBrandClaims('intent → policy → approval → tool → receipt')
      .some((claim) => claim.includes('stopping at the host boundary')),
  );
});
