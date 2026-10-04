import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

import { sha256Ref } from '../../src/canonical.mjs';
import { verifyPostgresWorkerDeliveryAttestation } from '../src/postgres-worker-delivery-attestation.mjs';
import { createPostgresWorkerDeliveryStore } from '../src/postgres-worker-delivery-store.mjs';
import { createWorkerDeliveryCatalogFixture } from './helpers/worker-delivery-catalog-fixture.mjs';

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

test('worker delivery PostgreSQL store is local_test-only and write-once', async () => {
  const fixture = await createWorkerDeliveryCatalogFixture();
  const store = await createPostgresWorkerDeliveryStore({
    pool: fixture.pool,
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

test('worker delivery attestation rejects catalog drift at initialization and later operations', async () => {
  const fixture = await createWorkerDeliveryCatalogFixture();
  fixture.mutate('relations');
  await assert.rejects(
    createPostgresWorkerDeliveryStore({ pool: fixture.pool, requireTls: false, disposableDb: true,
      controlPlane: { config: { environment: 'local_test', enabled: true } } }),
    (error) => error.code === 'WORKER_DELIVERY_POSTGRES_ATTESTATION_FAILED',
  );

  const clean = await createWorkerDeliveryCatalogFixture();
  const store = await createPostgresWorkerDeliveryStore({ pool: clean.pool, requireTls: false, disposableDb: true,
    controlPlane: { config: { environment: 'local_test', enabled: true } } });
  clean.mutate('relations');
  await assert.rejects(store.listPending(namespace, 10),
    (error) => error.code === 'WORKER_DELIVERY_POSTGRES_ATTESTATION_FAILED');
});

test('worker delivery expectedOwner rejects invalid identifiers', async () => {
  const fixture = await createWorkerDeliveryCatalogFixture();
  for (const expectedOwner of ['Not-Lowercase', '', null]) {
    await assert.rejects(
      createPostgresWorkerDeliveryStore({ pool: fixture.pool, requireTls: false, disposableDb: true,
        expectedOwner, controlPlane: { config: { environment: 'local_test', enabled: true } } }),
    );
  }
});

test('worker delivery strict expectedOwner fixture covers privilege and role drift', async () => {
  const fixture = await createWorkerDeliveryCatalogFixture();
  const client = await fixture.pool.connect();
  const options = { schemaName: 'risk_fork_worker_delivery', expectedOwner: 'worker_migrator' };
  const report = await verifyPostgresWorkerDeliveryAttestation(client, options);
  assert.equal(report.runtime_privileges_verified, true);
  for (const mutation of ['table_grant', 'column_grant', 'public_column_grant', 'select_grant',
    'default_function', 'membership', 'function_execute', 'ownership', 'grantable',
    // Object ACL probes cover both PUBLIC and named outsider grants, including
    // the SELECT/INSERT combinations that a table-level revoke can miss.
    'object_acl_public_select', 'object_acl_public_insert',
    'object_acl_outsider_select', 'object_acl_outsider_insert',
    'default_acl_public_select', 'default_acl_outsider_insert',
    'global_acl_public_execute', 'global_acl_outsider_execute']) {
    fixture.mutate(mutation);
    await assert.rejects(verifyPostgresWorkerDeliveryAttestation(client, options),
      (error) => error.code === 'WORKER_DELIVERY_POSTGRES_ATTESTATION_FAILED');
    fixture.clear(mutation);
  }
  client.release();
});

test('worker delivery attestation redacts accessor and query errors', async () => {
  const secret = 'fixture-secret-must-not-escape';
  const fixture = await createWorkerDeliveryCatalogFixture();
  const options = { schemaName: 'risk_fork_worker_delivery' };
  Object.defineProperty(options, 'expectedOwner', { enumerable: true, get() { throw new Error(secret); } });
  await assert.rejects(
    verifyPostgresWorkerDeliveryAttestation(fixture.pool, options),
    (error) => error.code === 'WORKER_DELIVERY_POSTGRES_ATTESTATION_FAILED' && !error.message.includes(secret),
  );
  const queryErrorClient = { async query() { throw new Error(secret); } };
  await assert.rejects(
    verifyPostgresWorkerDeliveryAttestation(queryErrorClient, { expectedOwner: 'worker_migrator' }),
    (error) => error.code === 'WORKER_DELIVERY_POSTGRES_ATTESTATION_FAILED' && !error.message.includes(secret),
  );
});

test('delivery migration is explicit and stores only ciphertext columns', async () => {
  const sql = await readFile(new URL('../migrations/002_worker_delivery.pg.sql', import.meta.url), 'utf8');
  assert.match(sql, /managed_worker_delivery_attempts/);
  assert.match(sql, /managed_worker_delivery_protect_record/);
  assert.match(sql, /managed_worker_delivery_no_delete/);
  assert.doesNotMatch(sql, /operation_json|lease_token|raw_input|plaintext/i);
});
