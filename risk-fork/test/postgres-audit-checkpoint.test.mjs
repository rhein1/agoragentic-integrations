import assert from 'node:assert/strict';
import test from 'node:test';

import { sha256Ref } from '../src/canonical.mjs';
import { verifyPostgresAuthorityAuditPage } from '../src/adapters/postgres-authority.mjs';

const AUTHORITY_ID = 'risk-fork-authority:test';

function auditRows(count) {
  const rows = [];
  let previousEventHash = null;
  for (let sequence = 1; sequence <= count; sequence += 1) {
    const payload = { sequence, outcome: sequence % 2 === 0 ? 'accepted' : 'observed' };
    const payloadHash = sha256Ref(payload);
    const body = {
      schema: 'agoragentic.risk-fork.distributed-authority-audit-event.v1',
      authority_id: AUTHORITY_ID,
      sequence,
      event_type: `event:${sequence}`,
      operation_ref: `operation:${sequence}`,
      parent_ref: 'parent:test',
      authorization_id: `authorization:${sequence}`,
      observed_at: `2030-01-01T00:00:${String(sequence).padStart(2, '0')}.000Z`,
      previous_event_hash: previousEventHash,
      payload_hash: payloadHash,
    };
    const eventHash = sha256Ref(body);
    rows.push({
      ...body,
      payload,
      event_hash: eventHash,
    });
    previousEventHash = eventHash;
  }
  return rows;
}

function verifyPage(rows, {
  allRows = rows,
  after = 0,
  limit = 100,
  auditSequence = allRows.length,
  auditHeadHash = allRows.length === 0 ? null : allRows[allRows.length - 1].event_hash,
  predecessorHash = after === 0 ? null : allRows[after - 1]?.event_hash,
} = {}) {
  return verifyPostgresAuthorityAuditPage({
    authority_id: AUTHORITY_ID,
    after_sequence: after,
    limit,
    audit_sequence: auditSequence,
    audit_head_hash: auditHeadHash,
    predecessor_hash: predecessorHash,
    rows,
  });
}

function restoreArrayPrototypeProperty(key, descriptor) {
  if (descriptor) Object.defineProperty(Array.prototype, key, descriptor);
  else delete Array.prototype[key];
}

function runWithPoisonedArrayPrototype(callback) {
  const iteratorDescriptor = Object.getOwnPropertyDescriptor(Array.prototype, Symbol.iterator);
  const indexDescriptor = Object.getOwnPropertyDescriptor(Array.prototype, '0');
  const atDescriptor = Object.getOwnPropertyDescriptor(Array.prototype, 'at');
  const mapDescriptor = Object.getOwnPropertyDescriptor(Array.prototype, 'map');
  const someDescriptor = Object.getOwnPropertyDescriptor(Array.prototype, 'some');
  const pushDescriptor = Object.getOwnPropertyDescriptor(Array.prototype, 'push');
  const popDescriptor = Object.getOwnPropertyDescriptor(Array.prototype, 'pop');
  const calls = {
    iterator: 0,
    numeric_setter: 0,
    at: 0,
    map: 0,
    some: 0,
    push: 0,
    pop: 0,
  };
  const poison = (name) => function poisonedArrayPrototypeHook() {
    calls[name] += 1;
    throw new Error(`Unexpected Array.prototype ${name} hook`);
  };
  let value;
  let error;
  Object.defineProperty(Array.prototype, Symbol.iterator, {
    configurable: true,
    writable: true,
    value: poison('iterator'),
  });
  Object.defineProperty(Array.prototype, '0', {
    configurable: true,
    set: poison('numeric_setter'),
  });
  Object.defineProperty(Array.prototype, 'at', {
    configurable: true,
    writable: true,
    value: poison('at'),
  });
  Object.defineProperty(Array.prototype, 'map', {
    configurable: true,
    writable: true,
    value: poison('map'),
  });
  Object.defineProperty(Array.prototype, 'some', {
    configurable: true,
    writable: true,
    value: poison('some'),
  });
  Object.defineProperty(Array.prototype, 'push', {
    configurable: true,
    writable: true,
    value: poison('push'),
  });
  Object.defineProperty(Array.prototype, 'pop', {
    configurable: true,
    writable: true,
    value: poison('pop'),
  });
  try {
    value = callback();
  } catch (caught) {
    error = caught;
  } finally {
    restoreArrayPrototypeProperty('0', indexDescriptor);
    restoreArrayPrototypeProperty(Symbol.iterator, iteratorDescriptor);
    restoreArrayPrototypeProperty('at', atDescriptor);
    restoreArrayPrototypeProperty('map', mapDescriptor);
    restoreArrayPrototypeProperty('some', someDescriptor);
    restoreArrayPrototypeProperty('push', pushDescriptor);
    restoreArrayPrototypeProperty('pop', popDescriptor);
  }
  return { calls, value, error };
}

function isAuditFailure(error) {
  return error?.code === 'DISTRIBUTED_AUDIT_CHAIN_INVALID';
}

function countingProxy(target, onTrap) {
  return new Proxy(target, {
    get(...args) {
      onTrap();
      return Reflect.get(...args);
    },
    getPrototypeOf(...args) {
      onTrap();
      return Reflect.getPrototypeOf(...args);
    },
    ownKeys(...args) {
      onTrap();
      return Reflect.ownKeys(...args);
    },
    getOwnPropertyDescriptor(...args) {
      onTrap();
      return Reflect.getOwnPropertyDescriptor(...args);
    },
  });
}

test('empty audit checkpoint verifies only at the authoritative empty head', () => {
  const page = verifyPage([], { auditSequence: 0, auditHeadHash: null, limit: 1 });
  assert.equal(page.verified, true);
  assert.equal(page.segment_verified, true);
  assert.equal(page.segment_starts_at_genesis, true);
  assert.equal(page.segment_reaches_authority_head, true);
  assert.equal(page.verified_through_sequence, 0);
  assert.deepEqual(page.authority_head, { sequence: 0, event_hash: null });
  assert.equal(page.authority_head_verified, true);
  assert.equal(page.next_sequence, null);
  assert.ok(Object.isFrozen(page));
});

test('a genesis page that reaches the durable checkpoint verifies the exact authority head', () => {
  const rows = auditRows(3);
  const page = verifyPage(rows, { allRows: rows, limit: 3 });
  assert.equal(page.events.length, 3);
  assert.equal(page.segment_starts_at_genesis, true);
  assert.equal(page.segment_reaches_authority_head, true);
  assert.equal(page.verified_through_sequence, 3);
  assert.equal(page.authority_head.event_hash, rows[2].event_hash);
  assert.equal(page.verified, true);
  assert.equal(page.authority_head_verified, true);
  assert.equal(page.next_sequence, null);
});

test('pagination keeps every nonzero-cursor page explicitly segment-scoped', () => {
  const allRows = auditRows(5);
  const first = verifyPage(allRows.slice(0, 2), { allRows, limit: 2 });
  assert.equal(first.segment_verified, true);
  assert.equal(first.segment_starts_at_genesis, true);
  assert.equal(first.segment_reaches_authority_head, false);
  assert.equal(first.verified, false);
  assert.equal(first.verified_through_sequence, 2);
  assert.equal(first.authority_head_verified, false);
  assert.equal(first.next_sequence, 2);

  const second = verifyPage(allRows.slice(2, 4), {
    allRows,
    after: first.next_sequence,
    limit: 2,
  });
  assert.equal(second.segment_starts_at_genesis, false);
  assert.equal(second.segment_reaches_authority_head, false);
  assert.equal(second.verified_through_sequence, 4);
  assert.equal(second.verified, false);
  assert.equal(second.authority_head_verified, false);
  assert.equal(second.next_sequence, 4);

  const third = verifyPage(allRows.slice(4), {
    allRows,
    after: second.next_sequence,
    limit: 2,
  });
  assert.equal(third.segment_verified, true);
  assert.equal(third.segment_starts_at_genesis, false);
  assert.equal(third.segment_reaches_authority_head, true);
  assert.equal(third.verified_through_sequence, 5);
  assert.equal(third.verified, false);
  assert.equal(third.authority_head_verified, false);
  assert.equal(third.next_sequence, null);

  const atHead = verifyPage([], { allRows, after: 5, limit: 2 });
  assert.equal(atHead.segment_reaches_authority_head, true);
  assert.equal(atHead.verified, false);
  assert.equal(atHead.authority_head_verified, false);
  assert.equal(atHead.next_sequence, null);
});

test('a detached tail matching its supplied checkpoint cannot claim genesis-to-head proof', () => {
  const detached = auditRows(5).map((row) => ({ ...row }));
  detached[0].payload = { sequence: 1, outcome: 'different-prefix' };
  detached[0].payload_hash = sha256Ref(detached[0].payload);
  detached[0].event_hash = sha256Ref({
    schema: detached[0].schema,
    authority_id: detached[0].authority_id,
    sequence: detached[0].sequence,
    event_type: detached[0].event_type,
    operation_ref: detached[0].operation_ref,
    parent_ref: detached[0].parent_ref,
    authorization_id: detached[0].authorization_id,
    observed_at: detached[0].observed_at,
    previous_event_hash: detached[0].previous_event_hash,
    payload_hash: detached[0].payload_hash,
  });
  for (let index = 1; index < detached.length; index += 1) {
    detached[index].previous_event_hash = detached[index - 1].event_hash;
    detached[index].event_hash = sha256Ref({
      schema: detached[index].schema,
      authority_id: detached[index].authority_id,
      sequence: detached[index].sequence,
      event_type: detached[index].event_type,
      operation_ref: detached[index].operation_ref,
      parent_ref: detached[index].parent_ref,
      authorization_id: detached[index].authorization_id,
      observed_at: detached[index].observed_at,
      previous_event_hash: detached[index].previous_event_hash,
      payload_hash: detached[index].payload_hash,
    });
  }

  const tail = verifyPage(detached.slice(2), {
    allRows: detached,
    after: 2,
    limit: 3,
  });
  assert.equal(tail.segment_verified, true);
  assert.equal(tail.segment_starts_at_genesis, false);
  assert.equal(tail.segment_reaches_authority_head, true);
  assert.equal(tail.verified, false);
  assert.equal(tail.authority_head_verified, false);
});

test('verification rejects a missing tail below the durable checkpoint', () => {
  const allRows = auditRows(5);
  assert.throws(
    () => verifyPage(allRows.slice(0, 4), { allRows, limit: 5 }),
    isAuditFailure,
  );
  assert.throws(
    () => verifyPage([], { allRows, after: 4, limit: 2 }),
    isAuditFailure,
  );
});

test('verification rejects pages that do not bind to the durable head', () => {
  const allRows = auditRows(4);
  assert.throws(
    () => verifyPage(allRows, {
      allRows,
      limit: 4,
      auditHeadHash: sha256Ref('different-authority-head'),
    }),
    isAuditFailure,
  );
  assert.throws(
    () => verifyPage([], {
      allRows,
      after: 4,
      predecessorHash: sha256Ref('different-predecessor'),
    }),
    isAuditFailure,
  );
  assert.throws(
    () => verifyPage([], { allRows, after: 5 }),
    isAuditFailure,
  );
});

test('verification rejects broken sequence, payload, and predecessor links', () => {
  const allRows = auditRows(4);
  const gap = allRows.slice(0, 2).map((row) => ({ ...row }));
  gap[1].sequence = 3;
  assert.throws(() => verifyPage(gap, { allRows, limit: 2 }), isAuditFailure);

  const changedPayload = allRows.map((row) => ({ ...row }));
  changedPayload[2].payload = { sequence: 3, outcome: 'tampered' };
  assert.throws(
    () => verifyPage(changedPayload, { allRows, limit: 4 }),
    isAuditFailure,
  );

  assert.throws(
    () => verifyPage(allRows.slice(2), {
      allRows,
      after: 2,
      limit: 2,
      predecessorHash: sha256Ref('wrong-page-predecessor'),
    }),
    isAuditFailure,
  );
});

test('audit verification rejects accessor-backed rows and payloads without invoking them', () => {
  const allRows = auditRows(1);
  let accessorCalls = 0;
  const accessorRow = { ...allRows[0] };
  Object.defineProperty(accessorRow, 'event_type', {
    enumerable: true,
    get() {
      accessorCalls += 1;
      return 'event:1';
    },
  });
  assert.throws(
    () => verifyPage([accessorRow], { allRows, limit: 1 }),
    isAuditFailure,
  );
  assert.equal(accessorCalls, 0);

  const accessorPayload = {};
  Object.defineProperty(accessorPayload, 'sequence', {
    enumerable: true,
    get() {
      accessorCalls += 1;
      return 1;
    },
  });
  const payloadRow = { ...allRows[0], payload: accessorPayload };
  assert.throws(
    () => verifyPage([payloadRow], { allRows, limit: 1 }),
    isAuditFailure,
  );
  assert.equal(accessorCalls, 0);
});

test('audit verification rejects coercible count and timestamp objects without invoking them', () => {
  let coercionCalls = 0;
  const coercible = {
    toString() {
      coercionCalls += 1;
      return '0';
    },
    valueOf() {
      coercionCalls += 1;
      return 0;
    },
  };
  assert.throws(
    () => verifyPage([], {
      auditSequence: coercible,
      auditHeadHash: null,
      limit: 1,
    }),
    isAuditFailure,
  );

  const allRows = auditRows(1);
  assert.throws(
    () => verifyPage([{ ...allRows[0], sequence: coercible }], {
      allRows,
      limit: 1,
    }),
    isAuditFailure,
  );
  assert.throws(
    () => verifyPage([{ ...allRows[0], observed_at: coercible }], {
      allRows,
      limit: 1,
    }),
    isAuditFailure,
  );
  assert.equal(coercionCalls, 0);
});

test('audit verification rejects negative zero rather than emitting noncanonical proof', () => {
  assert.throws(
    () => verifyPage([], {
      auditSequence: -0,
      auditHeadHash: null,
      limit: 1,
    }),
    isAuditFailure,
  );
  assert.throws(
    () => verifyPostgresAuthorityAuditPage({
      authority_id: AUTHORITY_ID,
      after_sequence: -0,
      limit: 1,
      audit_sequence: 0,
      audit_head_hash: null,
      predecessor_hash: null,
      rows: [],
    }),
    /bounds are invalid/,
  );
});

test('audit verification snapshots dense row arrays without invoking custom iteration', () => {
  const allRows = auditRows(1);
  let iteratorCalls = 0;
  const rows = [...allRows];
  Object.defineProperty(rows, Symbol.iterator, {
    configurable: true,
    value() {
      iteratorCalls += 1;
      return [][Symbol.iterator]();
    },
  });
  assert.throws(
    () => verifyPage(rows, { allRows, limit: 1 }),
    /symbol key/,
  );
  assert.equal(iteratorCalls, 0);
});

test('audit verification is deterministic under inherited Array prototype pollution', () => {
  const nestedPayload = {
    sequence: 1,
    outcome: 'observed',
    nested: ['alpha', { values: [1, 2] }],
  };
  const original = auditRows(1)[0];
  const payloadHash = sha256Ref(nestedPayload);
  const body = {
    schema: original.schema,
    authority_id: original.authority_id,
    sequence: original.sequence,
    event_type: original.event_type,
    operation_ref: original.operation_ref,
    parent_ref: original.parent_ref,
    authorization_id: original.authorization_id,
    observed_at: original.observed_at,
    previous_event_hash: original.previous_event_hash,
    payload_hash: payloadHash,
  };
  const row = {
    ...body,
    payload: nestedPayload,
    event_hash: sha256Ref(body),
  };
  const validInput = {
    authority_id: AUTHORITY_ID,
    after_sequence: 0,
    limit: 1,
    audit_sequence: 1,
    audit_head_hash: row.event_hash,
    predecessor_hash: null,
    rows: [row],
  };
  const expected = verifyPostgresAuthorityAuditPage(validInput);
  const valid = runWithPoisonedArrayPrototype(
    () => verifyPostgresAuthorityAuditPage(validInput),
  );
  assert.equal(valid.error, undefined);
  assert.deepEqual(valid.calls, {
    iterator: 0,
    numeric_setter: 0,
    at: 0,
    map: 0,
    some: 0,
    push: 0,
    pop: 0,
  });
  assert.deepEqual(valid.value, expected);
  assert.equal(valid.value.events instanceof Array, true);
  assert.equal(Object.getPrototypeOf(valid.value.events), Array.prototype);
  assert.deepEqual([...valid.value.events], [valid.value.events[0]]);
  assert.deepEqual(valid.value.events.map((event) => event.sequence), [1]);
  assert.deepEqual(valid.value.events.filter((event) => event.sequence === 1), [
    valid.value.events[0],
  ]);
  assert.equal(valid.value.events.includes(valid.value.events[0]), true);
  const nested = valid.value.events[0].payload.nested;
  assert.equal(nested instanceof Array, true);
  assert.equal(Object.getPrototypeOf(nested), Array.prototype);
  assert.deepEqual([...nested], ['alpha', nested[1]]);
  assert.deepEqual(nested.map((value) => typeof value), ['string', 'object']);
  assert.deepEqual(nested.filter((value) => typeof value === 'string'), ['alpha']);
  assert.equal(nested.includes('alpha'), true);
  assert.equal(nested[1].values instanceof Array, true);
  assert.deepEqual([...nested[1].values], [1, 2]);
  assert.equal(Object.isFrozen(valid.value.events), true);
  assert.equal(Object.isFrozen(nested), true);

  const invalidInput = {
    ...validInput,
    rows: [{ ...row, payload_hash: sha256Ref('tampered-payload-hash') }],
  };
  let expectedError;
  try {
    verifyPostgresAuthorityAuditPage(invalidInput);
  } catch (error) {
    expectedError = error;
  }
  const invalid = runWithPoisonedArrayPrototype(
    () => verifyPostgresAuthorityAuditPage(invalidInput),
  );
  assert.deepEqual(invalid.calls, {
    iterator: 0,
    numeric_setter: 0,
    at: 0,
    map: 0,
    some: 0,
    push: 0,
    pop: 0,
  });
  assert.ok(expectedError);
  assert.ok(invalid.error);
  assert.deepEqual(
    {
      name: invalid.error.name,
      message: invalid.error.message,
      code: invalid.error.code,
      evidence: invalid.error.evidence,
    },
    {
      name: expectedError.name,
      message: expectedError.message,
      code: expectedError.code,
      evidence: expectedError.evidence,
    },
  );
});

test('audit verification rejects inherited row getters without invoking them', () => {
  const allRows = auditRows(1);
  let getterCalls = 0;
  const inherited = { ...allRows[0] };
  delete inherited.sequence;
  Object.setPrototypeOf(inherited, {
    get sequence() {
      getterCalls += 1;
      return 1;
    },
  });
  assert.throws(
    () => verifyPage([inherited], { allRows, limit: 1 }),
    isAuditFailure,
  );
  assert.equal(getterCalls, 0);
});

test('audit verification rejects Proxy pages, arrays, rows, and payloads before traps run', () => {
  let trapCalls = 0;
  const onTrap = () => {
    trapCalls += 1;
  };
  const emptyPage = {
    authority_id: AUTHORITY_ID,
    after_sequence: 0,
    limit: 1,
    audit_sequence: 0,
    audit_head_hash: null,
    predecessor_hash: null,
    rows: [],
  };
  assert.throws(
    () => verifyPostgresAuthorityAuditPage(countingProxy(emptyPage, onTrap)),
    /must not be a Proxy/,
  );

  const allRows = auditRows(1);
  assert.throws(
    () => verifyPostgresAuthorityAuditPage({
      ...emptyPage,
      audit_sequence: 1,
      audit_head_hash: allRows[0].event_hash,
      rows: countingProxy([...allRows], onTrap),
    }),
    /must not be a Proxy/,
  );
  assert.throws(
    () => verifyPage([countingProxy({ ...allRows[0] }, onTrap)], {
      allRows,
      limit: 1,
    }),
    isAuditFailure,
  );
  assert.throws(
    () => verifyPage([{
      ...allRows[0],
      payload: {
        nested: countingProxy({ value: 'untrusted' }, onTrap),
      },
    }], {
      allRows,
      limit: 1,
    }),
    isAuditFailure,
  );
  assert.equal(trapCalls, 0);
});
