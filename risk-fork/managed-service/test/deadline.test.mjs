import assert from 'node:assert/strict';
import { getEventListeners } from 'node:events';
import test from 'node:test';
import { createManagedDeadline } from '../src/deadline.mjs';

test('owned timeout aborts with TimeoutError and removes its parent listener', async () => {
  const parent = new AbortController();
  const d = createManagedDeadline(50, { signal: parent.signal });
  assert.equal(getEventListeners(parent.signal, 'abort').length, 1);
  assert.equal(await d.aborted, null);
  assert.equal(d.signal.aborted, true); assert.equal(d.signal.reason.name, 'TimeoutError');
  assert.equal(getEventListeners(parent.signal, 'abort').length, 0);
  d.dispose(); d.dispose();
});

test('parent cancellation preserves the exact reason and removes owned resources', async () => {
  const parent = new AbortController(), reason = new Error('owner cancellation');
  const d = createManagedDeadline(30000, { signal: parent.signal });
  parent.abort(reason);
  assert.equal(await d.aborted, null); assert.equal(d.signal.reason, reason);
  assert.equal(getEventListeners(parent.signal, 'abort').length, 0);
  d.dispose();
  const already = createManagedDeadline(30000, { signal: parent.signal });
  assert.equal(await already.aborted, null); assert.equal(already.signal.reason, reason);
  assert.equal(getEventListeners(parent.signal, 'abort').length, 0); already.dispose();
});

test('normal settlement disposes without manufacturing callback cancellation', () => {
  for (let i = 0; i < 100; i += 1) {
    const parent = new AbortController();
    const d = createManagedDeadline(30000, { signal: parent.signal });
    assert.equal(getEventListeners(parent.signal, 'abort').length, 1);
    d.dispose(); d.dispose();
    assert.equal(getEventListeners(parent.signal, 'abort').length, 0);
    parent.abort(); assert.equal(d.signal.aborted, false);
  }
});

test('deadline configuration is closed and validates without invoking accessors', () => {
  for (const timeout of [49, 30001, Infinity, '100']) assert.throws(() => createManagedDeadline(timeout));
  for (const options of [{ referenced: 1 }, { signal: {} }, { authority: true }]) assert.throws(() => createManagedDeadline(100, options));
  let calls = 0;
  assert.throws(() => createManagedDeadline(100, { get signal() { calls += 1; return undefined; } }));
  assert.equal(calls, 0);
});
