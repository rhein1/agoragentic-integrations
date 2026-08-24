import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { validateJsonSchema } from '../scripts/lib/validate-json-schema.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const schema = JSON.parse(
  fs.readFileSync(
    path.join(root, 'interchange', 'schemas', 'interchange-production-research-ledger.schema.json'),
    'utf8'
  )
);
const ledger = JSON.parse(
  fs.readFileSync(
    path.join(root, 'interchange', 'evidence', 'interchange-production-research-ledger.v1.json'),
    'utf8'
  )
);

function copyLedger() {
  return structuredClone(ledger);
}

test('accepts the committed Interchange production research ledger', () => {
  assert.equal(validateJsonSchema(copyLedger(), schema), true);
});

test('rejects missing required fields and unknown properties', () => {
  const missing = copyLedger();
  delete missing.program.name;
  assert.throws(() => validateJsonSchema(missing, schema), /\$\.program\.name is required/);

  const expanded = copyLedger();
  expanded.unreviewed_claim = true;
  assert.throws(() => validateJsonSchema(expanded, schema), /\$\.unreviewed_claim is not allowed/);
});

test('rejects invalid evidence enums, formats, and unique-item drift', () => {
  const invalidActor = copyLedger();
  invalidActor.external_experiments[0].actor_class = 'anonymous_claim';
  assert.throws(() => validateJsonSchema(invalidActor, schema), /actor_class must be one of/);

  const invalidTime = copyLedger();
  invalidTime.generated_at = 'not-a-date';
  assert.throws(() => validateJsonSchema(invalidTime, schema), /generated_at must use date-time format/);

  const duplicateLevel = copyLedger();
  duplicateLevel.evidence_levels.push(duplicateLevel.evidence_levels[0]);
  assert.throws(() => validateJsonSchema(duplicateLevel, schema), /evidence_levels must contain unique items/);
});

test('rejects malformed chain evidence and authority shapes', () => {
  const invalidHash = copyLedger();
  invalidHash.external_experiments[0].chain_evidence.tx_hash = '0x1234';
  assert.throws(() => validateJsonSchema(invalidHash, schema), /tx_hash must match/);

  const missingAuthority = copyLedger();
  delete missingAuthority.external_experiments[0].authority_after.money;
  assert.throws(() => validateJsonSchema(missingAuthority, schema), /authority_after\.money is required/);
});
