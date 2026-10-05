import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';

import { createPostgresAuthorityPool, quotePostgresAuthorityIdentifier } from '../../src/adapters/postgres-authority-migrator.mjs';
import { sha256Ref } from '../../src/canonical.mjs';
import { migratePostgresWorkerDelivery } from '../src/postgres-worker-delivery-migrator.mjs';
import { createPostgresWorkerDeliveryStore } from '../src/postgres-worker-delivery-store.mjs';
import { createManagedWorkerDeliveryJournal } from '../src/worker-delivery.mjs';
import { createFixture, invocationRequest } from './helpers.mjs';

const connectionString = process.env.RISK_FORK_MANAGED_TEST_POSTGRES_URL;
let skip = 'An explicit disposable loopback risk_fork_managed_test database is required';
try {
  const url = new URL(connectionString);
  if (['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname)
    && url.pathname === '/risk_fork_managed_test'
    && process.env.RISK_FORK_MANAGED_TEST_CONFIRM_DISPOSABLE === 'YES_DELETE_DATA') skip = false;
} catch { /* Never select an unreviewed database. */ }
if (skip && process.env.RISK_FORK_MANAGED_REQUIRE_POSTGRES_TESTS === '1') throw new Error(skip);

function packet(namespace, suffix) {
  return {
    schema: 'agoragentic.risk-fork.worker-delivery.v1', namespace,
    attempt_ref: sha256Ref(`attempt-${suffix}`), key_id: 'key:test',
    iv: Buffer.alloc(12, 1).toString('base64url'),
    ciphertext: Buffer.from(`ciphertext-${suffix}`).toString('base64url'),
    tag: Buffer.alloc(16, 2).toString('base64url'),
  };
}

test('worker delivery survives restart, fences capacity, and protects tombstones', {
  skip,
}, async () => {
  const schemaName = `risk_fork_worker_test_${randomUUID().replaceAll('-', '').slice(0, 24)}`;
  const pool = await createPostgresAuthorityPool({
    connectionString, requireTls: false, maxConnections: 4,
    applicationName: 'agoragentic-risk-fork-worker-delivery-test',
  });
  const controlPlane = { config: { environment: 'local_test', enabled: true } };
  try {
    await migratePostgresWorkerDelivery({ pool, schemaName, requireTls: false, disposableDb: true, deploymentMode: 'local_test' });
    const first = await createPostgresWorkerDeliveryStore({ pool, schemaName, requireTls: false, disposableDb: true, controlPlane });
    const namespace = 'integration:test';
    const original = packet(namespace, 'one');
    assert.equal(await first.insert(original, 3), true);
    await first.close();

    const restarted = await createPostgresWorkerDeliveryStore({ pool, schemaName, requireTls: false, disposableDb: true, controlPlane });
    assert.equal((await restarted.get(namespace, original.attempt_ref)).acknowledged, false);
    assert.equal(await restarted.acknowledge(namespace, original.attempt_ref, sha256Ref('response')), true);

    const concurrent = await Promise.allSettled(Array.from({ length: 8 }, (_, index) => (
      restarted.insert(packet(namespace, `concurrent-${index}`), 3)
    )));
    const concurrentSuccesses = concurrent.filter((result) => result.status === 'fulfilled' && result.value === true);
    assert.ok(concurrentSuccesses.length >= 1 && concurrentSuccesses.length <= 2);
    assert.ok(concurrent.every((result) => result.status === 'fulfilled'
      || ['WORKER_TRANSACTION_CONFLICT', 'WORKER_CAPACITY'].includes(result.reason?.code)));
    await assert.rejects(
      restarted.insert(packet(namespace, 'policy-change'), 4),
      (error) => error.code === 'WORKER_CAPACITY_POLICY_MISMATCH',
    );

    const quoted = quotePostgresAuthorityIdentifier(schemaName);
    let count = (await pool.query(`SELECT count(*)::int AS n FROM ${quoted}.managed_worker_delivery_attempts`)).rows[0].n;
    while (count < 3) {
      assert.equal(await restarted.insert(packet(namespace, `sequential-${count}`), 3), true);
      count++;
    }
    await assert.rejects(restarted.insert(packet(namespace, 'over-capacity'), 3), { code: 'WORKER_CAPACITY' });
    // Real encrypted journal + real durable backend, with a lost claim response.
    const f = await createFixture();
    const { invocation } = await f.controlPlane.admitInvocation(f.principal, invocationRequest());
    let lost = true;
    const control = { ...f.controlPlane, async claimExecution(...args) {
      const result = await f.controlPlane.claimExecution(...args);
      if (lost) { lost = false; throw new Error('lost response'); } return result;
    } };
    const journalOptions = { store: restarted, encryptionKey: Buffer.alloc(32, 93),
      keyId: 'fixture:encrypted', namespace: 'fixture:encrypted', workerId: 'fixture:worker',
      controlPlane: control, executionPrincipal: f.principal,
      cleanupPrincipal: f.sameTenantPrincipal, recoveryPrincipal: f.recoveryPrincipal };
    const journal = createManagedWorkerDeliveryJournal(journalOptions);
    const token = f.nextLeaseToken('persisted_secret');
    await assert.rejects(journal.deliver('execution', 'claimExecution', {
      invocation_ref: invocation.invocation_ref, lease_token: token, worker_id: 'fixture:worker', lease_ms: 10_000,
    }), /lost response/);
    const [pending] = await journal.listPending();
    const originalCiphertext = (await restarted.get(journalOptions.namespace, pending)).record;
    journal.close();
    const rotatedOptions = { ...journalOptions, encryptionKey: Buffer.alloc(32, 94),
      keyId: 'fixture:encrypted-new',
      retiredDecryptionKeys: [{ keyId: journalOptions.keyId, encryptionKey: journalOptions.encryptionKey }] };
    const missingOldKey = createManagedWorkerDeliveryJournal({ ...rotatedOptions, retiredDecryptionKeys: [] });
    try { await assert.rejects(missingOldKey.resumeDelivery(pending), { code: 'WORKER_DELIVERY_INVALID' }); }
    finally { missingOldKey.close(); }
    const resumed = createManagedWorkerDeliveryJournal(rotatedOptions);
    assert.equal((await resumed.resumeDelivery(pending)).original_operation_resumed, false);
    assert.deepEqual((await restarted.get(journalOptions.namespace, pending)).record, originalCiphertext,
      'rotation must not rewrite immutable ciphertext');
    const { invocation: nextInvocation } = await f.controlPlane.admitInvocation(f.principal,
      invocationRequest({ idempotency_key: 'idempotency-key-pg-rotated-0002' }));
    await resumed.deliver('execution', 'claimExecution', {
      invocation_ref: nextInvocation.invocation_ref, lease_token: f.nextLeaseToken('rotated'),
      worker_id: journalOptions.workerId, lease_ms: 10_000,
    });
    const keyRows = await pool.query(`SELECT key_id FROM ${quoted}.managed_worker_delivery_attempts WHERE namespace = $1 ORDER BY created_at`,
      [journalOptions.namespace]);
    assert.deepEqual(keyRows.rows.map((row) => row.key_id), [journalOptions.keyId, rotatedOptions.keyId]);
    const stored = await pool.query(`SELECT row_to_json(d) AS data FROM ${quoted}.managed_worker_delivery_attempts d`);
    assert.equal(JSON.stringify(stored.rows).includes(token), false);
    assert.equal((await f.controlPlane.listAuditEvents(f.principal, invocation.invocation_ref))
      .filter((event) => event.event_type === 'execution_lease_claimed').length, 1);
    resumed.close();
    const columns = await pool.query(
      `SELECT column_name FROM information_schema.columns WHERE table_schema = $1 AND table_name = 'managed_worker_delivery_attempts' ORDER BY ordinal_position`,
      [schemaName],
    );
    assert.deepEqual(columns.rows.map((row) => row.column_name), [
      'namespace', 'attempt_ref', 'key_id', 'iv', 'ciphertext', 'tag',
      'acknowledged', 'response_hash', 'created_at', 'acknowledged_at',
    ]);
    await assert.rejects(
      pool.query(`UPDATE ${quoted}.managed_worker_delivery_attempts SET key_id = 'raw-input'`),
      /immutable/,
    );
    await assert.rejects(
      pool.query(`DELETE FROM ${quoted}.managed_worker_delivery_attempts`),
      /append-only/,
    );
    await assert.rejects(
      pool.query(`TRUNCATE ${quoted}.managed_worker_delivery_attempts`),
      /cannot be truncated/,
    );
    await restarted.close();
  } finally {
    const quoted = quotePostgresAuthorityIdentifier(schemaName);
    await pool.query(`DROP SCHEMA IF EXISTS ${quoted} CASCADE`);
    await pool.end();
  }
});
