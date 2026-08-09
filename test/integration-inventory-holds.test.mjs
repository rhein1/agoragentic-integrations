import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const { validateInventoryHolds } = require('../scripts/integration-inventory-holds.js');
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const MANIFEST = JSON.parse(readFileSync(resolve(ROOT, 'integrations.json'), 'utf8'));
const HELD_DIRECTORIES = [
  'agent-payments-assurance-challenge',
  'prime-agent-governance',
  'transaction-assurance',
  'verifiers-transaction-assurance',
];
const REPRESENTED = (MANIFEST.integrations || [])
  .flatMap((integration) => [integration.path, integration.docs])
  .filter(Boolean)
  .map((value) => value.split('/')[0]);

function cloneManifest() {
  return JSON.parse(JSON.stringify(MANIFEST));
}

function validate(manifest, options = {}) {
  return validateInventoryHolds(manifest, {
    integrationDirectories: HELD_DIRECTORIES,
    representedDirectories: REPRESENTED,
    today: '2026-08-08',
    ...options,
  });
}

test('current central inventory hold is bounded and valid', () => {
  const result = validate(MANIFEST);
  assert.deepEqual(result.errors, []);
  assert.deepEqual([...result.heldDirectories], HELD_DIRECTORIES);
});

test('expired inventory holds fail closed', () => {
  const expired = cloneManifest();
  expired.inventory_holds[0].review_by = '2026-08-07';
  const result = validate(expired);
  assert.equal(result.heldDirectories.size, expired.inventory_holds.length - 1);
  assert.ok(result.errors.some((error) => error.includes('expired on 2026-08-07')));
});

test('inventory holds cannot delegate ownership or extend beyond 90 days', () => {
  const delegated = cloneManifest();
  delegated.inventory_holds[0].owner = 'prime-agent-governance';
  assert.ok(validate(delegated).errors.some((error) => error.includes('owner must be repository-maintainers')));

  const unbounded = cloneManifest();
  unbounded.inventory_holds[0].review_by = '2027-01-01';
  assert.ok(validate(unbounded).errors.some((error) => error.includes('exceeds the 90-day limit')));
});

test('unknown, represented, duplicate, or authority-bearing holds are rejected', () => {
  const unknown = cloneManifest();
  unknown.inventory_holds[0].directory = 'not-present';
  assert.ok(validate(unknown).errors.some((error) => error.includes('does not exist as an integration')));

  const represented = cloneManifest();
  represented.inventory_holds[0].directory = 'agent-os';
  const representedResult = validateInventoryHolds(represented, {
    integrationDirectories: ['agent-os'],
    representedDirectories: ['agent-os'],
    today: '2026-08-08',
  });
  assert.ok(representedResult.errors.some((error) => error.includes('already represented')));

  const duplicate = cloneManifest();
  duplicate.inventory_holds.push({ ...duplicate.inventory_holds[0] });
  assert.ok(validate(duplicate).errors.some((error) => error.includes('duplicated')));

  const authorityBearing = cloneManifest();
  authorityBearing.inventory_holds[0].authority_granted = true;
  assert.ok(validate(authorityBearing).errors.some((error) => error.includes('authority_granted must remain false')));
});

test('inventory verifier has no package-local exception channel', () => {
  const verifier = readFileSync(resolve(ROOT, 'scripts', 'verify-integrations-json.js'), 'utf8');
  assert.doesNotMatch(verifier, /\.agoragentic-integration\.json/);
  assert.doesNotMatch(verifier, /hasApprovedCatalogException/);
  assert.match(verifier, /validateInventoryHolds/);
});
