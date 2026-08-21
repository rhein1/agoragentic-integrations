import assert from 'node:assert/strict';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  EXPECTED_POINTER_FILES,
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
