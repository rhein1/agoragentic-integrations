import assert from 'node:assert/strict';
import test from 'node:test';

import {
  canonicalize,
  sha256Ref,
} from '../src/canonical.mjs';

test('canonical helper extraction preserves exact object ordering and hashes', () => {
  const left = {
    z: [3, { b: 2, a: 1 }],
    a: { undefined_value: undefined, nested: true },
  };
  const right = {
    a: { nested: true, undefined_value: undefined },
    z: [3, { a: 1, b: 2 }],
  };

  assert.equal(canonicalize(left), canonicalize(right));
  assert.equal(canonicalize(left), '{"a":{"nested":true},"z":[3,{"a":1,"b":2}]}');
  assert.equal(sha256Ref(left), 'sha256:a8a50ec760ef21a89fa066c3ccf897f8b48a0f887e0e1d5420245adae2c2ec84');
  assert.equal(sha256Ref(left), sha256Ref(right));
});

test('canonical helper preserves prior JSON.stringify edge semantics', () => {
  assert.equal(canonicalize({ missing: undefined }), '{}');
  assert.equal(canonicalize([undefined, Number.NaN, Number.POSITIVE_INFINITY]), '[null,null,null]');
  assert.equal(sha256Ref('literal'), 'sha256:829f8d848b44fa3098194754af5b60e2fb1517b0195956841beb6cac9bc68067');
});
