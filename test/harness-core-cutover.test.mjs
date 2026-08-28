import assert from 'node:assert/strict';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  EXPECTED_POINTER_FILES,
  validateAllFalseAuthority,
  validateHarnessPointerFiles,
  verifyHarnessCoreCutover,
} from '../scripts/verify-harness-core-cutover.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

test('the live repository satisfies the standalone Harness Core cutover contract', () => {
  assert.deepEqual(verifyHarnessCoreCutover({ root }), { ok: true, errors: [] });
});

test('a duplicate package implementation fails the pointer-only contract', () => {
  assert.deepEqual(validateHarnessPointerFiles(EXPECTED_POINTER_FILES), []);
  assert.match(
    validateHarnessPointerFiles([...EXPECTED_POINTER_FILES, 'src/index.mjs'])[0],
    /must contain only/,
  );
});

test('missing or non-false authority evidence fails closed', () => {
  const expectedKeys = ['read', 'spend'];
  assert.match(validateAllFalseAuthority(undefined, expectedKeys, 'fixture')[0], /keys must equal/);
  assert.match(validateAllFalseAuthority({ read: false, spend: true }, expectedKeys, 'fixture')[0], /spend/);
  assert.match(validateAllFalseAuthority({ placeholder: false, spend: false }, expectedKeys, 'fixture')[0], /keys must equal/);
  assert.deepEqual(validateAllFalseAuthority({ read: false, spend: false }, expectedKeys, 'fixture'), []);
});
