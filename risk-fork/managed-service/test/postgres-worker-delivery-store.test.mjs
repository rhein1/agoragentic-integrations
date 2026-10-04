import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

import { sha256Ref } from '../../src/canonical.mjs';
import { createPostgresWorkerDeliveryStore } from '../src/postgres-worker-delivery-store.mjs';

const namespace = 'worker:test';
const attemptRef = sha256Ref('attempt-1');
const responseHash = sha256Ref('response-1');
const record = Object.freeze({
  schema: 'agoragentic.risk-fork.worker-delivery.v1',
  namespace,
  attempt_ref: attemptRef,
  key_id: 'key:test',
  iv: Buffer.alloc(12, 1).toString('base64url'),
  ciphertext: Buffer.from('ciphertext-only').toString('base64url'),
  tag: Buffer.alloc(16, 2).toString('base64url'),
});

function mockPool() {
  const rows = new Map();
  const client = {
    async query(sql, params = []) {
      if (sql.includes('pg_stat_ssl')) return { rowCount: 1, rows: [{ ssl: true, version: 'TLS', cipher: 'mock', fsync: 'on', synchronous_commit: 'on', session_replication_role: 'origin' }] };
      if (/^(BEGIN|COMMIT|ROLLBACK|SET LOCAL|SELECT pg_advisory)/.test(sql)) return { rowCount: 0, rows: [] };
      if (sql.includes('SELECT version, migration_hash')) return { rowCount: 1, rows: [{ version: 1, migration_hash: await migrationHash() }] };
      if (sql.includes('pg_trigger')) return { rowCount: 6, rows: [
        { tgname: 'managed_worker_delivery_namespace_no_delete', tgenabled: 'O' },
        { tgname: 'managed_worker_delivery_namespace_no_truncate', tgenabled: 'O' },
        { tgname: 'managed_worker_delivery_no_delete', tgenabled: 'O' },
        { tgname: 'managed_worker_delivery_no_truncate', tgenabled: 'O' },
        { tgname: 'managed_worker_delivery_protect_namespace', tgenabled: 'O' },
        { tgname: 'managed_worker_delivery_protect_record', tgenabled: 'O' },
      ] };
      if (sql.includes('pg_catalog.pg_attribute')) return { rowCount: 16, rows: [
        ['managed_worker_delivery_attempts', 'namespace', 'text', true],
        ['managed_worker_delivery_attempts', 'attempt_ref', 'text', true],
        ['managed_worker_delivery_attempts', 'key_id', 'text', true],
        ['managed_worker_delivery_attempts', 'iv', 'text', true],
        ['managed_worker_delivery_attempts', 'ciphertext', 'text', true],
        ['managed_worker_delivery_attempts', 'tag', 'text', true],
        ['managed_worker_delivery_attempts', 'acknowledged', 'boolean', true],
        ['managed_worker_delivery_attempts', 'response_hash', 'text', false],
        ['managed_worker_delivery_attempts', 'created_at', 'timestamp with time zone', true],
        ['managed_worker_delivery_attempts', 'acknowledged_at', 'timestamp with time zone', false],
        ['managed_worker_delivery_namespaces', 'namespace', 'text', true],
        ['managed_worker_delivery_namespaces', 'max_attempts', 'integer', true],
        ['managed_worker_delivery_namespaces', 'created_at', 'timestamp with time zone', true],
        ['managed_worker_delivery_schema_migrations', 'version', 'integer', true],
        ['managed_worker_delivery_schema_migrations', 'migration_hash', 'text', true],
        ['managed_worker_delivery_schema_migrations', 'applied_at', 'timestamp with time zone', true],
      ].map(([relation, name, type_name, not_null]) => ({ relation, name, type_name, not_null })) };
      if (sql.includes('pg_class')) return { rowCount: 3, rows: [
        { relkind: 'r', relpersistence: 'p' },
        { relkind: 'r', relpersistence: 'p' },
        { relkind: 'r', relpersistence: 'p' },
      ] };
      if (sql.includes('SELECT count(*)::integer')) return { rowCount: 1, rows: [{ count: rows.size }] };
      if (sql.includes('INSERT INTO') && sql.includes('managed_worker_delivery_namespaces')) return { rowCount: 1, rows: [{ max_attempts: params[1] }] };
      if (sql.includes('INSERT INTO')) {
        const key = `${params[0]}:${params[1]}`;
        if (rows.has(key)) return { rowCount: 0, rows: [] };
        rows.set(key, { namespace: params[0], attempt_ref: params[1], key_id: params[2], iv: params[3], ciphertext: params[4], tag: params[5], acknowledged: false, response_hash: null });
        return { rowCount: 1, rows: [] };
      }
      if (sql.includes('SELECT 1 FROM')) {
        return rows.has(`${params[0]}:${params[1]}`) ? { rowCount: 1, rows: [{ '?column?': 1 }] } : { rowCount: 0, rows: [] };
      }
      if (sql.includes('UPDATE') && sql.includes('SET acknowledged')) {
        const key = `${params[0]}:${params[1]}`;
        const row = rows.get(key);
        if (row?.acknowledged === false) { row.acknowledged = true; row.response_hash = params[2]; return { rowCount: 1, rows: [{ attempt_ref: params[1] }] }; }
        return { rowCount: 0, rows: [] };
      }
      if (sql.includes('SELECT acknowledged, response_hash')) {
        const row = rows.get(`${params[0]}:${params[1]}`);
        return row ? { rowCount: 1, rows: [row] } : { rowCount: 0, rows: [] };
      }
      if (sql.includes('SELECT namespace, attempt_ref')) {
        const row = rows.get(`${params[0]}:${params[1]}`);
        return row ? { rowCount: 1, rows: [row] } : { rowCount: 0, rows: [] };
      }
      if (sql.includes('SELECT attempt_ref')) return { rowCount: 0, rows: [] };
      throw new Error(`unexpected mock SQL: ${sql}`);
    },
    release() {},
  };
  return { async connect() { return client; }, async end() {} };
}

let migrationHashPromise;
function migrationHash() {
  migrationHashPromise ??= readFile(new URL('../migrations/002_worker_delivery.pg.sql', import.meta.url), 'utf8')
    .then((source) => sha256Ref(source.replace(/\r\n?/g, '\n')));
  return migrationHashPromise;
}

test('worker delivery PostgreSQL store is local_test-only and write-once', async () => {
  const store = await createPostgresWorkerDeliveryStore({
    pool: mockPool(),
    requireTls: false, disposableDb: true,
    controlPlane: { config: { environment: 'local_test', enabled: true } },
  });
  assert.equal(await store.insert(record, 2), true);
  assert.equal(await store.insert(record, 2), false);
  assert.deepEqual((await store.get(namespace, attemptRef)).record, record);
  assert.equal((await store.get(namespace, attemptRef)).acknowledged, false);
  assert.equal(await store.acknowledge(namespace, attemptRef, responseHash), true);
  assert.equal(await store.acknowledge(namespace, attemptRef, responseHash), false);
  await assert.rejects(
    store.acknowledge(namespace, attemptRef, sha256Ref('different-response')),
    (error) => error.code === 'WORKER_DELIVERY_ACK_REPLAY_MISMATCH',
  );
  assert.deepEqual(await store.listPending(namespace, 10), []);
});

test('delivery migration is explicit and stores only ciphertext columns', async () => {
  const sql = await readFile(new URL('../migrations/002_worker_delivery.pg.sql', import.meta.url), 'utf8');
  assert.match(sql, /managed_worker_delivery_attempts/);
  assert.match(sql, /managed_worker_delivery_protect_record/);
  assert.match(sql, /managed_worker_delivery_no_delete/);
  assert.doesNotMatch(sql, /operation_json|lease_token|raw_input|plaintext/i);
});
