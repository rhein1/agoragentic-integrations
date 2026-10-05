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

async function fixture(fixtureOptions = {}) {
  const current = await createFixture(fixtureOptions);
  const { invocation } = await current.controlPlane.admitInvocation(current.principal, invocationRequest());
  const store = ciphertextStore();
  const encryptionKey = Buffer.alloc(32, 0x42);
  const options = { store, encryptionKey, keyId: 'fixture:key1', namespace: 'fixture:delivery', workerId: 'worker:delivery',
    controlPlane: current.controlPlane, executionPrincipal: current.principal,
    cleanupPrincipal: current.sameTenantPrincipal, recoveryPrincipal: current.recoveryPrincipal };
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

test('rotation resumes old claim ciphertext but seals new deliveries with only the active key', async () => {
  const f = await fixture();
  let calls = 0;
  const control = { ...f.controlPlane, async claimExecution(...args) {
    const result = await f.controlPlane.claimExecution(...args);
    if (++calls === 1) throw new Error('lost claim response');
    return result;
  } };
  const old = createManagedWorkerDeliveryJournal({ ...f.options, controlPlane: control });
  await assert.rejects(old.deliver('execution', 'claimExecution', f.input), /lost claim response/);
  const [ref] = await old.listPending();
  const original = structuredClone(f.store.rows.values().next().value.record);
  old.close();
  const newKey = Buffer.alloc(32, 0x43);
  const oldKey = Buffer.from(f.options.encryptionKey);
  const retired = [{ keyId: f.options.keyId, encryptionKey: oldKey }];
  const options = { ...f.options, controlPlane: control, encryptionKey: newKey,
    keyId: 'fixture:key2', retiredDecryptionKeys: retired };
  const rotated = createManagedWorkerDeliveryJournal(options);
  // The live journal must not borrow mutable host configuration or key bytes.
  newKey.fill(0); oldKey.fill(0); retired[0].keyId = 'fixture:changed'; retired.length = 0;
  try {
    const first = rotated.resumeDelivery(ref), second = rotated.resumeDelivery(ref);
    assert.equal(first, second);
    const result = await first;
    assert.equal(result.original_operation_resumed, false);
    assert.equal(result.production_qualified, false);
    assert.equal(calls, 2);
    assert.deepEqual(f.store.rows.values().next().value.record, original, 'old ciphertext is immutable');
    const { invocation } = await f.controlPlane.admitInvocation(f.principal,
      invocationRequest({ idempotency_key: 'idempotency-rotated-delivery-0002' }));
    await rotated.deliver('execution', 'claimExecution', { ...f.input,
      invocation_ref: invocation.invocation_ref, lease_token: testLeaseToken('rotated') });
    const newRecord = [...f.store.rows.values()].at(-1).record;
    assert.equal(newRecord.key_id, 'fixture:key2');
    const activeOnly = createManagedWorkerDeliveryJournal({ ...options,
      encryptionKey: Buffer.alloc(32, 0x43), retiredDecryptionKeys: [] });
    try {
      assert.equal((await activeOnly.resumeDelivery(newRecord.attempt_ref)).delivery_acknowledged, true);
      await assert.rejects(activeOnly.resumeDelivery(ref), { code: 'WORKER_DELIVERY_INVALID' });
    } finally { activeOnly.close(); }
    assert.equal((await f.controlPlane.listAuditEvents(f.principal, f.invocation.invocation_ref))
      .filter((event) => event.event_type === 'execution_lease_claimed').length, 1);
  } finally { rotated.close(); }
});

test('rotation resolves a lost resource-journal response without repeating its mutation or verifier', async () => {
  let verifierCalls = 0;
  const f = await fixture({ verifyResourceBinding: async () => { verifierCalls += 1; return true; } });
  await f.controlPlane.claimExecution(f.principal, f.input);
  const resources = { savepoint_ref: 'savepoint:rotated', fork_ref: 'fork:rotated' };
  f.attestResourceBinding(f.invocation, resources);
  let calls = 0;
  const control = { ...f.controlPlane, async recordResources(...args) {
    const result = await f.controlPlane.recordResources(...args);
    if (++calls === 1) throw new Error('lost journal response');
    return result;
  } };
  const old = createManagedWorkerDeliveryJournal({ ...f.options, controlPlane: control });
  await assert.rejects(old.deliver('execution', 'recordResources', {
    invocation_ref: f.input.invocation_ref, lease_token: f.input.lease_token, ...resources,
  }), /lost journal response/);
  const [ref] = await old.listPending();
  old.close();
  const before = await f.controlPlane.getInvocation(f.principal, f.input.invocation_ref);
  const auditBefore = await f.controlPlane.listAuditEvents(f.principal, f.input.invocation_ref);
  const rotated = createManagedWorkerDeliveryJournal({ ...f.options, controlPlane: control,
    keyId: 'fixture:key2', encryptionKey: Buffer.alloc(32, 0x43),
    retiredDecryptionKeys: [{ keyId: f.options.keyId, encryptionKey: f.options.encryptionKey }] });
  try {
    await rotated.resumeDelivery(ref);
    assert.equal(calls, 2);
    assert.equal(verifierCalls, 1, 'receipt replay precedes the read-only verifier');
    assert.deepEqual(await f.controlPlane.getInvocation(f.principal, f.input.invocation_ref), before);
    assert.deepEqual(await f.controlPlane.listAuditEvents(f.principal, f.input.invocation_ref), auditBefore);
    await rotated.resumeDelivery(ref);
    assert.equal(calls, 2, 'acknowledged tombstone does not redeliver');
  } finally { rotated.close(); }
});

test('retired keys cannot bypass key ID AAD, identity or current credential expiry', async () => {
  const f = await fixture();
  let sends = 0;
  const control = { ...f.controlPlane, async claimExecution(...args) {
    sends += 1;
    const result = await f.controlPlane.claimExecution(...args);
    throw new Error('lost response');
  } };
  const old = createManagedWorkerDeliveryJournal({ ...f.options, controlPlane: control });
  await assert.rejects(old.deliver('execution', 'claimExecution', f.input));
  const [ref] = await old.listPending(); old.close();
  const options = { ...f.options, controlPlane: control, keyId: 'fixture:key2',
    encryptionKey: Buffer.alloc(32, 0x43),
    retiredDecryptionKeys: [{ keyId: f.options.keyId, encryptionKey: f.options.encryptionKey }] };
  const rejected = async (changes) => {
    const journal = createManagedWorkerDeliveryJournal({ ...options, ...changes });
    try { await assert.rejects(journal.resumeDelivery(ref), { code: 'WORKER_DELIVERY_INVALID' }); }
    finally { journal.close(); }
    assert.equal(sends, 1, 'invalid evidence is rejected before delivery');
  };
  await rejected({ retiredDecryptionKeys: [] });
  await rejected({ retiredDecryptionKeys: [{ keyId: f.options.keyId, encryptionKey: Buffer.alloc(32, 0x44) }] });
  await rejected({ workerId: 'worker:other' });
  await rejected({ namespace: 'namespace:other' });
  // Preserve a valid separated composition while substituting the ciphertext's
  // execution identity. Reusing the cleanup identity is now rejected at build.
  await rejected({ executionPrincipal: f.sameTenantPrincipal, cleanupPrincipal: f.principal });
  const row = f.store.rows.values().next().value;
  row.record.key_id = 'fixture:key2';
  // Even equal key bytes cannot authorize an ID substitution: AAD pins the ID.
  await rejected({ encryptionKey: f.options.encryptionKey });
  row.record.key_id = 'fixture:unknown'; await rejected({});
  row.record.key_id = f.options.keyId;
  f.setNow('2026-09-06T00:00:00.000Z');
  const expired = createManagedWorkerDeliveryJournal(options);
  try { await assert.rejects(expired.resumeDelivery(ref), { code: 'AUTHENTICATION_FAILED' }); }
  finally { expired.close(); }
  assert.equal(row.acknowledged, false);
});

test('retired decryption configuration is closed, bounded, unique and owned by the host', async () => {
  const f = await fixture();
  const entry = { keyId: 'fixture:retired', encryptionKey: Buffer.alloc(32, 0x40) };
  const invalid = [null, {}, new Array(1), new Proxy([], {}),
    Array.from({ length: 9 }, (_, i) => ({ ...entry, keyId: `fixture:retired${i}` })),
    [{ ...entry, keyId: f.options.keyId }], [entry, entry],
    [{ ...entry, encryptionKey: Buffer.alloc(31) }],
    [{ ...entry, encryptionKey: new Proxy(Buffer.alloc(32), {}) }],
    [{ ...entry, active: true }],
    [Object.defineProperty({}, 'keyId', { enumerable: true, get() { throw new Error('getter ran'); } })],
  ];
  for (const retiredDecryptionKeys of invalid) {
    assert.throws(() => createManagedWorkerDeliveryJournal({ ...f.options, retiredDecryptionKeys }), TypeError);
  }
  const retired = Array.from({ length: 8 }, (_, i) => ({ ...entry, keyId: `fixture:retired${i}` }));
  const journal = createManagedWorkerDeliveryJournal({ ...f.options, retiredDecryptionKeys: retired });
  journal.close(); journal.close();
  assert.equal(entry.encryptionKey[0], 0x40);
  assert.equal(f.options.encryptionKey[0], 0x42);
  await assert.rejects(journal.deliver('execution', 'claimExecution', f.input), { code: 'WORKER_DELIVERY_INVALID' });
  assert.throws(() => journal.resumeDelivery(`sha256:${'a'.repeat(64)}`), { code: 'WORKER_DELIVERY_INVALID' });
});
