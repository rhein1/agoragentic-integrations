import assert from 'node:assert/strict';
import test from 'node:test';
import { parseProcStat, parseCgroup, parsePids, parseEvents, cleanupStatus, workloadStatus, assertKeylessImageEnvironment } from '../scripts/verify-e2b-sdk-tree-observer.mjs';

test('outside observer independently rejects inherited credentials and missing or duplicate image environment names', () => {
  const clean = ['PATH=/usr/bin:/bin', 'NODE_VERSION=24.20.0', 'YARN_VERSION=1.22.22'];
  assertKeylessImageEnvironment(clean);
  for (const entries of [[], undefined, [...clean, 'E2B_API_KEY=synthetic-not-a-key'],
    ['E2B_API_KEY=synthetic-not-a-key', ...clean.slice(1)], [...clean.slice(1), clean[1]],
    [...clean.slice(1), 'AWS_TOKEN=synthetic'], [...clean.slice(1), 'PATH=/bin\n']]) {
    assert.throws(() => assertKeylessImageEnvironment(entries));
  }
});

test('host observer stat parser preserves kernel PID incarnation and session despite parentheses in comm', () => {
  const fields = ['S', '100', '200', '300', ...Array(15).fill('0'), '987654', '0'];
  assert.deepEqual(parseProcStat(`123 (strange ) name) ${fields.join(' ')}`), { state: 'S', parent: 100, session: 300, start: '987654' });
  for (const value of ['', '123 name S', '123 (x) S 1']) assert.throws(() => parseProcStat(value));
});

test('host observer rejects broad, mixed, traversing and malformed cgroup observations', () => {
  assert.equal(parseCgroup('0::/system.slice/docker-example.scope\n'), '/system.slice/docker-example.scope');
  for (const value of ['0::/\n', '1:cpu:/x\n', '0::/x\n1:cpu:/x\n', '0::/x/../y', '0::/x\0y', '0::/x//y']) {
    assert.throws(() => parseCgroup(value));
  }
});

test('host observer reads bounded exact process membership, never treats malformed data as empty', () => {
  assert.deepEqual(parsePids(''), []);
  assert.deepEqual(parsePids('123\n124\n123\n'), [123, 124]);
  for (const value of ['0', '1', '-2', 'x', '123 124', '9007199254740992', Array(129).fill('123').join('\n')]) {
    assert.throws(() => parsePids(value));
  }
});

test('host observer requires one valid populated field; stopped JSON alone is never evidence', () => {
  assert.equal(parseEvents('populated 1\nfrozen 0\n'), true);
  assert.equal(parseEvents('populated 0\nfrozen 0\n'), false);
  for (const value of ['', 'frozen 0', 'populated 0\npopulated 0', 'populated -1', 'populated 0 extra', 'populated 2']) {
    assert.throws(() => parseEvents(value));
  }
});

test('cleanup verification requires kernel binding, empty-scope proof, removal, absence and no uncertainty', () => {
  const proof = { bound: true, readonly: true, killed: true, empty: true, removed: true, absent: true, uncertain: false };
  assert.equal(cleanupStatus(proof), 'verified');
  for (const field of ['bound', 'readonly', 'killed', 'empty', 'removed', 'absent']) assert.equal(cleanupStatus({ ...proof, [field]: false }), 'unknown');
  assert.equal(cleanupStatus({ ...proof, uncertain: true }), 'unknown');
  assert.equal(cleanupStatus({ ...proof, uncertain: undefined }), 'unknown');
  assert.equal(cleanupStatus({ ...proof, bound: 'verified' }), 'unknown');
  assert.equal(cleanupStatus({}), 'unknown');
});

test('completed workload is not a passed custody run while cleanup is unknown', () => {
  assert.deepEqual(workloadStatus({ completed: true, uncertain: false, cleanup: 'unknown' }), {
    workload_completed: true, workload_passed: false,
  });
  assert.deepEqual(workloadStatus({ completed: true, uncertain: false, cleanup: 'verified' }), {
    workload_completed: true, workload_passed: true,
  });
  for (const completed of [false, undefined, 'true']) {
    assert.deepEqual(workloadStatus({ completed, uncertain: false, cleanup: 'verified' }), {
      workload_completed: false, workload_passed: false,
    });
  }
  for (const uncertain of [true, undefined, 'false']) {
    assert.deepEqual(workloadStatus({ completed: true, uncertain, cleanup: 'verified' }), {
      workload_completed: true, workload_passed: false,
    });
  }
  for (const cleanup of [undefined, true, 'observed', 'not_run']) {
    assert.equal(workloadStatus({ completed: true, uncertain: false, cleanup }).workload_passed, false);
  }
});
