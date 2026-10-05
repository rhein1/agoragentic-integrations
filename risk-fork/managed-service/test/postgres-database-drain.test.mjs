import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import pg from 'pg';
import test from 'node:test';
import { waitForDisposableDatabaseDrain } from './disposable-database-drain.mjs';

const database = 'risk_fork_control_role_0123456789abcdefab';
const sql = 'SELECT count(*)::integer AS count FROM pg_stat_activity WHERE datname=$1';

test('pool shutdown resolves before socket close; cleanup observes absence without terminating it', async () => {
  let connected, finishClose;
  class DelayedCloseClient extends EventEmitter {
    connect(callback) { connected = this; callback(); }
    end(callback) { finishClose = callback; }
  }
  const pool = new pg.Pool({ Client: DelayedCloseClient });
  const errors = [];
  pool.on('error', (error) => errors.push(error));
  const client = await pool.connect();
  client.release();
  let closed = false;
  pool.on('remove', () => { closed = true; });
  await pool.end();
  assert.equal(closed, false, 'pool end is not server-side absence evidence');
  assert.equal(connected, client);
  let reads = 0;
  try {
    await waitForDisposableDatabaseDrain({ query: async (statement, values) => {
      assert.equal(statement, sql); assert.deepEqual(values, [database]);
      reads += 1;
      if (reads === 1) return { rows: [{ count: 1 }] };
      finishClose();
      return { rows: [{ count: 0 }] };
    } }, database);
    assert.equal(reads, 2); assert.equal(closed, true); assert.deepEqual(errors, []);
  } finally { if (!closed) finishClose(); }
});

test('drain rejects broad or forged database targets before querying', async () => {
  let calls = 0;
  const root = { query: async () => { calls += 1; } };
  for (const name of ['risk_fork_managed_test', 'postgres', database + "'", database.slice(0, -1), null]) {
    await assert.rejects(waitForDisposableDatabaseDrain(root, name), /exact disposable/);
  }
  assert.equal(calls, 0);
});

test('drain rejects missing or invalid session evidence and propagates database errors', async () => {
  for (const result of [{ rows: [] }, { rows: [{ count: -1 }] }, { rows: [{ count: '0' }] }]) {
    await assert.rejects(waitForDisposableDatabaseDrain({ query: async () => result }, database), /invalid session evidence/);
  }
  const unavailable = new Error('synthetic connection failure');
  await assert.rejects(waitForDisposableDatabaseDrain({ query: async () => { throw unavailable; } }, database),
    (error) => error === unavailable);
});

test('drain fails closed after a bounded wait rather than killing a remaining session', { timeout: 10_000 }, async () => {
  let calls = 0;
  await assert.rejects(waitForDisposableDatabaseDrain({ query: async (statement, values) => {
    assert.equal(statement, sql); assert.deepEqual(values, [database]);
    calls += 1; return { rows: [{ count: 1 }] };
  } }, database), /did not drain within the bounded wait/);
  assert.equal(calls, 100);
});
