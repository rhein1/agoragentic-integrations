import assert from 'node:assert/strict';
import test from 'node:test';
import { createManagedWorkerDeliveryJournal } from '../src/worker-delivery.mjs';
import { createFixture, invocationRequest, testLeaseToken } from './helpers.mjs';

function ciphertextStore() {
  const rows = new Map();
  return { rows,
    async insert(record, limit) {
      const key = `${record.namespace}:${record.attempt_ref}`;
      if (rows.has(key)) return false;
      if ([...rows.values()].filter((row) => row.record.namespace === record.namespace).length >= limit) throw new Error('capacity');
      rows.set(key, { record: structuredClone(record), acknowledged: false }); return true;
    },
    async get(namespace, ref) { return structuredClone(rows.get(`${namespace}:${ref}`) ?? null); },
    async acknowledge(namespace, ref, hash) {
      const row = rows.get(`${namespace}:${ref}`);
      if (!row || (row.response_hash && row.response_hash !== hash)) throw new Error('ack mismatch');
      row.acknowledged = true; row.response_hash = hash;
    },
    async listPending(namespace, limit) { return [...rows.values()].filter((r) => r.record.namespace === namespace && !r.acknowledged).map((r) => r.record.attempt_ref).slice(0, limit); },
  };
}

async function fixture() {
  const current = await createFixture();
  const { invocation } = await current.controlPlane.admitInvocation(current.principal, invocationRequest());
  const store = ciphertextStore();
  const encryptionKey = Buffer.alloc(32, 0x42);
  const options = { store, encryptionKey, keyId: 'fixture:key1', namespace: 'fixture:delivery', workerId: 'worker:delivery',
    controlPlane: current.controlPlane, executionPrincipal: current.principal,
    cleanupPrincipal: current.sameTenantPrincipal, recoveryPrincipal: current.sameTenantPrincipal };
  const input = { invocation_ref: invocation.invocation_ref, worker_id: options.workerId,
    lease_ms: 10_000, lease_token: testLeaseToken('encrypted') };
  return { ...current, invocation, store, options, input };
}

test('restart redelivers an unknown claim acknowledgement without another state transition or provider effect', async () => {
  const f = await fixture();
  let calls = 0;
  const lostControl = Object.freeze({ ...f.controlPlane, async claimExecution(principal, input) {
    const response = await f.controlPlane.claimExecution(principal, input);
    if (++calls === 1) throw new Error('lost acknowledgement'); return response;
  } });
  const options = { ...f.options, controlPlane: lostControl };
  const journal = createManagedWorkerDeliveryJournal(options);
  await assert.rejects(journal.deliver('execution', 'claimExecution', f.input), /lost acknowledgement/);
  assert.equal(JSON.stringify([...f.store.rows.values()]).includes(f.input.lease_token), false);
  const [ref] = await journal.listPending();
  journal.close(); assert.equal(f.options.encryptionKey[0], 0x42, 'caller key must not be zeroed');
  const restarted = createManagedWorkerDeliveryJournal(options);
  const a = restarted.resumeDelivery(ref), b = restarted.resumeDelivery(ref);
  assert.equal(a, b);
  assert.equal((await a).original_operation_resumed, false);
  assert.equal(calls, 2);
  assert.deepEqual(await restarted.listPending(), []);
  const audit = await f.controlPlane.listAuditEvents(f.principal, f.invocation.invocation_ref);
  assert.equal(audit.filter((event) => event.event_type === 'execution_lease_claimed').length, 1);
  await assert.rejects(restarted.deliver('execution', 'claimExecution', f.input), { code: 'WORKER_DELIVERY_ALREADY_RECORDED' });
});

test('encrypted attempts reject altered ciphertext, wrong keys and identity swaps', async () => {
  const f = await fixture();
  const lostStore = { ...f.store, acknowledge() { throw new Error('ack write failed'); } };
  const options = { ...f.options, store: lostStore };
  const journal = createManagedWorkerDeliveryJournal(options);
  await assert.rejects(journal.deliver('execution', 'claimExecution', f.input));
  const [ref] = await journal.listPending();
  const wrongKey = createManagedWorkerDeliveryJournal({ ...options, encryptionKey: Buffer.alloc(32, 0x43) });
  await assert.rejects(wrongKey.resumeDelivery(ref), { code: 'WORKER_DELIVERY_INVALID' });
  const wrongWorker = createManagedWorkerDeliveryJournal({ ...options, workerId: 'worker:other' });
  await assert.rejects(wrongWorker.resumeDelivery(ref), { code: 'WORKER_DELIVERY_INVALID' });
  const row = f.store.rows.values().next().value;
  row.record.tag = 'A'.repeat(22);
  await assert.rejects(createManagedWorkerDeliveryJournal(options).resumeDelivery(ref), { code: 'WORKER_DELIVERY_INVALID' });
});

test('restart delivery cannot retain revoked or expired worker authority', async () => {
  const f = await fixture();
  const options = { ...f.options, store: { ...f.store, acknowledge() { throw new Error('lost ack'); } } };
  const journal = createManagedWorkerDeliveryJournal(options);
  await assert.rejects(journal.deliver('execution', 'claimExecution', f.input));
  const [ref] = await journal.listPending();
  f.setNow('2026-09-06T00:00:00.000Z');
  await assert.rejects(createManagedWorkerDeliveryJournal(options).resumeDelivery(ref), { code: 'AUTHENTICATION_FAILED' });
  assert.equal(f.store.rows.values().next().value.acknowledged, false);
});

test('only claim/resource delivery methods are resumable and retained rows bound capacity', async () => {
  const f = await fixture();
  const journal = createManagedWorkerDeliveryJournal({ ...f.options, maxAttempts: 1 });
  for (const method of ['executeInFork', 'destroyFork', 'createFork', 'recordExecutionOutcome']) {
    await assert.rejects(journal.deliver('execution', method, f.input), { code: 'WORKER_DELIVERY_INVALID' });
  }
  await journal.deliver('execution', 'claimExecution', f.input);
  await assert.rejects(journal.deliver('cleanup', 'claimCleanup', f.input), /capacity/);
  assert.equal(f.store.rows.size, 1);
  journal.close(); assert.throws(() => journal.resumeDelivery('sha256:' + 'a'.repeat(64)), { code: 'WORKER_DELIVERY_INVALID' });
});

test('explicit delivery recovery can retry a failed transport and releases in-flight capacity', async () => {
  const f = await fixture();
  let unavailable = true;
  const control = Object.freeze({ ...f.controlPlane,
    claimExecution(...args) {
      if (unavailable) throw new Error('unavailable');
      return f.controlPlane.claimExecution(...args);
    },
  });
  const journal = createManagedWorkerDeliveryJournal({ ...f.options, controlPlane: control, maxAttempts: 1 });
  await assert.rejects(journal.deliver('execution', 'claimExecution', f.input), /unavailable/);
  const [ref] = await journal.listPending();
  await assert.rejects(journal.resumeDelivery(ref), /unavailable/);
  unavailable = false;
  await journal.resumeDelivery(ref);
  for (let i = 0; i < 3; ++i) assert.equal((await journal.resumeDelivery(ref)).delivery_acknowledged, true);
  assert.equal((await f.controlPlane.listAuditEvents(f.principal, f.invocation.invocation_ref))
    .filter((event) => event.event_type === 'execution_lease_claimed').length, 1);
  journal.close();
});
