import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

import { buildRunpayReplay } from './replay.mjs';

test('offline replay is deterministic and preserves the proof boundary', async () => {
  const first = await buildRunpayReplay();
  const second = await buildRunpayReplay();
  assert.deepEqual(first, second);
  assert.match(first.replay_hash, /^sha256:[0-9a-f]{64}$/);
  assert.equal(first.assertions.service_count, 2);
  assert.equal(first.assertions.source_service_count_claim, 206);
  assert.equal(first.assertions.services_with_declared_input_schema, 2);
  assert.equal(first.assertions.services_with_nonmissing_output_schema, 1);
  assert.equal(first.assertions.all_services_ineligible, true);
  assert.equal(first.assertions.settlement_confirmed, false);
  assert.ok(Object.values(first.safety).every((value) => value === true || value === false));
  assert.equal(first.safety.offline, true);
  assert.equal(first.safety.network_used, false);
  assert.equal(first.safety.payment_attempted, false);
  assert.equal(first.safety.funds_moved, false);
});

test('adapter implementation contains no network client', async () => {
  const source = `${await readFile(new URL('./normalize.mjs', import.meta.url), 'utf8')}\n${await readFile(new URL('./replay.mjs', import.meta.url), 'utf8')}`;
  assert.doesNotMatch(source, /\bfetch\s*\(/);
  assert.doesNotMatch(source, /node:https?/);
  assert.doesNotMatch(source, /XMLHttpRequest|WebSocket/);
});
