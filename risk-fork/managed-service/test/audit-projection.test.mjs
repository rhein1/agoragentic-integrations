import assert from 'node:assert/strict';
import test from 'node:test';
import { sha256Ref } from '../../src/canonical.mjs';
import * as audit from '../src/audit.mjs';
import { normalizeAuditWindowRequest } from '../src/audit-read.mjs';
import { createFixture, invocationRequest } from './helpers.mjs';

async function admit(fixture, index, principal = fixture.principal) {
  return fixture.controlPlane.admitInvocation(principal, invocationRequest({
    idempotency_key: `audit-projection-idempotency-${index}`,
    estimated_cost_micros: 0,
  }));
}

function chain(count = 4) {
  const events = [];
  for (let index = 0; index < count; index += 1) {
    events.push(audit.createManagedAuditEvent({
      event_ref: `audit_projection_event_${index}`,
      tenant_id: 'tenant_alpha', invocation_ref: 'rfi_projection',
      sequence: index + 1, event_type: 'execution_lease_renewed',
      occurred_at: `2026-09-05T12:00:0${index}.000Z`,
      details: { lease_token: 'never exported' },
      prior_event_hash: events.at(-1)?.event_hash ?? null,
    }));
  }
  return events;
}

function window(events, after = 0, limit = 2) {
  return {
    tenant_id: 'tenant_alpha', invocation_ref: 'rfi_projection',
    audit_event_count: events.length, audit_head_hash: events.at(-1).event_hash,
    prior_event: events[after - 1] ?? null, events: events.slice(after, after + limit),
  };
}

function verify(value, options = {}) {
  return audit.verifyManagedAuditWindow(value, {
    tenant_id: 'tenant_alpha', invocation_ref: 'rfi_projection',
    after_sequence: 0, prior_event_hash: null, limit: 2, ...options,
  });
}

test('audit invocation discovery pins a finite ASCII sweep and rediscovers behind-cursor commits', async () => {
  const refs = ['rfi_Z', 'rfi_a', 'rfi_z', 'rfi_A', 'rfi_zz'];
  const fixture = await createFixture({ concurrency: 16, invocationRef: () => refs.shift() });
  await admit(fixture, 1);
  await admit(fixture, 2);
  const first = await fixture.controlPlane.listAuditInvocations(fixture.principal, { limit: 1 });
  assert.equal(first.upper_ref, 'rfi_a');
  assert.deepEqual(first.invocations.map((row) => row.invocation_ref), ['rfi_Z']);
  assert.equal(first.complete, false);
  await admit(fixture, 3); // above the pinned upper bound
  await admit(fixture, 4); // below the cursor
  await admit(fixture, 5); // another above-bound admission cannot extend this sweep
  const second = await fixture.controlPlane.listAuditInvocations(fixture.principal, {
    after_ref: first.next_after_ref, upper_ref: first.upper_ref, limit: 1,
  });
  assert.deepEqual(second.invocations.map((row) => row.invocation_ref), ['rfi_a']);
  assert.equal(second.complete, true);
  const reset = await fixture.controlPlane.listAuditInvocations(fixture.principal);
  assert.deepEqual(reset.invocations.map((row) => row.invocation_ref),
    ['rfi_A', 'rfi_Z', 'rfi_a', 'rfi_z', 'rfi_zz']);
  assert.deepEqual(Object.keys(reset.invocations[0]).sort(),
    ['audit_event_count', 'audit_head_hash', 'invocation_ref']);
  assert.equal(Object.isFrozen(reset.invocations[0]), true);
  assert.equal(JSON.stringify(reset).includes('bounded input'), false);
});

test('audit windows expose only a bounded verified prefix and rediscover later transitions', async () => {
  const fixture = await createFixture();
  const admitted = await admit(fixture, 1);
  const ref = admitted.invocation.invocation_ref;
  const first = await fixture.controlPlane.readAuditWindow(fixture.principal, ref, { limit: 1 });
  assert.equal(first.complete, true);
  assert.equal(first.next_after_sequence, 1);
  await fixture.controlPlane.claimExecution(fixture.principal, {
    invocation_ref: ref, lease_token: fixture.nextLeaseToken(), worker_id: 'audit_worker', lease_ms: 5_000,
  });
  const second = await fixture.controlPlane.readAuditWindow(fixture.principal, ref, {
    after_sequence: first.next_after_sequence,
    prior_event_hash: first.next_prior_event_hash, limit: 1,
  });
  assert.equal(second.events.length, 1);
  assert.equal(second.events[0].event_type, 'execution_lease_claimed');
  assert.equal(second.complete, true);
  assert.deepEqual(await fixture.controlPlane.readAuditWindow(fixture.principal, ref, {
    after_sequence: first.next_after_sequence,
    prior_event_hash: first.next_prior_event_hash, limit: 1,
  }), second);
  const empty = await fixture.controlPlane.readAuditWindow(fixture.principal, ref, {
    after_sequence: second.next_after_sequence, prior_event_hash: second.next_prior_event_hash,
  });
  assert.deepEqual(empty.events, []);
  assert.equal(empty.complete, true);
  assert.equal(empty.next_prior_event_hash, second.next_prior_event_hash);
});

test('audit cursor range matches PostgreSQL int4 and rejects overflow before a store read', async () => {
  const maximum = 2_147_483_647;
  const prior = sha256Ref('known prefix');
  assert.equal(normalizeAuditWindowRequest({ after_sequence: maximum,
    prior_event_hash: prior }).after_sequence, maximum);
  assert.throws(() => normalizeAuditWindowRequest({ after_sequence: maximum + 1,
    prior_event_hash: prior }), TypeError);
  const fixture = await createFixture();
  let reads = 0;
  fixture.store.getAuditWindow = async () => { reads += 1; throw new Error('must not read'); };
  await assert.rejects(fixture.controlPlane.readAuditWindow(fixture.principal, 'rfi_any', {
    after_sequence: maximum + 1, prior_event_hash: prior,
  }), TypeError);
  assert.equal(reads, 0);
});

test('caller-altered page bounds never establish completion of the original sweep', async () => {
  const refs = ['rfi_a', 'rfi_b', 'rfi_z'];
  const fixture = await createFixture({ concurrency: 16, invocationRef: () => refs.shift() });
  for (let index = 1; index <= 3; index += 1) await admit(fixture, index);
  const first = await fixture.controlPlane.listAuditInvocations(fixture.principal, { limit: 1 });
  const altered = await fixture.controlPlane.listAuditInvocations(fixture.principal, {
    after_ref: first.next_after_ref, upper_ref: 'rfi_b', limit: 1,
  });
  assert.equal(first.upper_ref, 'rfi_z');
  assert.equal(altered.complete, true); // Only the supplied interval is complete.
  assert.notEqual(altered.upper_ref, first.upper_ref);
  assert.equal(Object.hasOwn(altered, 'original_sweep_complete'), false);
  assert.equal(Object.hasOwn(altered, 'checkpoint_advanced'), false);
  const retained = await fixture.controlPlane.listAuditInvocations(fixture.principal, {
    after_ref: first.next_after_ref, upper_ref: first.upper_ref, limit: 1,
  });
  assert.equal(retained.complete, false);
  assert.deepEqual(retained.invocations.map((row) => row.invocation_ref), ['rfi_b']);
});

test('audit projection requires current audit scope and exact tenant before reading', async () => {
  const fixture = await createFixture();
  const admitted = await admit(fixture, 1);
  assert.deepEqual((await fixture.controlPlane.listAuditInvocations(fixture.otherPrincipal)).invocations, []);
  await assert.rejects(fixture.controlPlane.readAuditWindow(fixture.otherPrincipal,
    admitted.invocation.invocation_ref), (error) => error.code === 'INVOCATION_NOT_FOUND');
  let reads = 0;
  fixture.store.listAuditInvocations = async () => { reads += 1; throw new Error('must not read'); };
  fixture.store.getAuditWindow = async () => { reads += 1; throw new Error('must not read'); };
  await assert.rejects(fixture.controlPlane.listAuditInvocations(fixture.recoveryPrincipal),
    (error) => error.code === 'AUTHORIZATION_DENIED' && error.status === 403);
  await assert.rejects(fixture.controlPlane.readAuditWindow(fixture.recoveryPrincipal,
    admitted.invocation.invocation_ref), (error) => error.code === 'AUTHORIZATION_DENIED' && error.status === 403);
  assert.equal(reads, 0);
});

test('audit projection bounds and descriptor screens requests before store reads', async () => {
  const fixture = await createFixture();
  for (const options of [{ limit: 0 }, { limit: 65 }, { limit: 1.5 }, { after_ref: 'rfi_a' },
    { upper_ref: 'rfi_A' },
    { after_ref: 'rfi_z', upper_ref: 'rfi_a' }, { upper_ref: "rfi_'" }, { tenant_id: 'tenant_other' },
    new Proxy({}, {}), { get limit() { throw new Error('accessor executed'); } }]) {
    await assert.rejects(fixture.controlPlane.listAuditInvocations(fixture.principal, options), TypeError);
  }
  for (const options of [{ limit: 65 }, { after_sequence: -1 }, { after_sequence: 1.5 },
    { after_sequence: 1 }, { prior_event_hash: sha256Ref('wrong genesis') },
    { after_sequence: Number.MAX_SAFE_INTEGER }, { tenant_id: 'tenant_other' }]) {
    await assert.rejects(fixture.controlPlane.readAuditWindow(fixture.principal, 'rfi_any', options), TypeError);
  }
});

test('bounded audit verification preserves the v1 chain and exact continuation', () => {
  const events = chain();
  assert.equal(audit.verifyManagedAuditChain(events), true);
  const first = verify(window(events));
  assert.equal(first.complete, false);
  assert.equal(first.next_after_sequence, 2);
  const second = verify(window(events, 2), {
    after_sequence: first.next_after_sequence, prior_event_hash: first.next_prior_event_hash,
  });
  assert.equal(second.complete, true);
  assert.equal(second.next_after_sequence, 4);
  assert.equal(second.next_prior_event_hash, events[3].event_hash);
  assert.equal(Object.isFrozen(second.events[0]), true);
  assert.equal(JSON.stringify(second).includes('never exported'), false);
});

test('audit projection rejects a malformed store response and never falls back to full history', async () => {
  const fixture = await createFixture();
  const admitted = await admit(fixture, 1);
  const ref = admitted.invocation.invocation_ref;
  const valid = await fixture.controlPlane.listAuditInvocations(fixture.principal, { limit: 1 });
  for (const mutate of [
    (page) => { page.tenant_id = 'tenant_other'; },
    (page) => { page.upper_ref = 'rfi_other'; },
    (page) => { page.invocations[0].operation = { kind: 'secret' }; },
    (page) => { page.next_after_ref = null; },
    (page) => { page.invocations.push(page.invocations[0]); },
  ]) {
    const page = structuredClone(valid);
    mutate(page);
    fixture.store.listAuditInvocations = async () => page;
    await assert.rejects(fixture.controlPlane.listAuditInvocations(fixture.principal,
      { limit: 1 }));
  }
  let unboundedReads = 0;
  fixture.store.getAuditSnapshot = async () => { unboundedReads += 1; throw new Error('no fallback'); };
  fixture.store.listAuditInvocations = null;
  fixture.store.getAuditWindow = null;
  await assert.rejects(fixture.controlPlane.listAuditInvocations(fixture.principal),
    (error) => error.code === 'AUDIT_PROJECTION_UNSUPPORTED');
  await assert.rejects(fixture.controlPlane.readAuditWindow(fixture.principal, ref),
    (error) => error.code === 'AUDIT_PROJECTION_UNSUPPORTED');
  assert.equal(unboundedReads, 0);
});

test('audit windows bound large histories and reject non-data verification options', () => {
  // This exceeds the full clone's node budget. Bounded windows still validate
  // the unchanged v1 events without cloning the full source history.
  const events = [];
  for (let sequence = 1; sequence <= 9_000; sequence += 1) {
    events.push(audit.createManagedAuditEvent({ event_ref: `evt_large_${sequence}`,
      tenant_id: 'tenant_alpha', invocation_ref: 'rfi_projection', sequence,
      event_type: 'execution_lease_renewed', occurred_at: '2026-09-05T12:00:00.000Z',
      prior_event_hash: events.at(-1)?.event_hash ?? null }));
  }
  assert.throws(() => audit.verifyManagedAuditChain(events), /too complex/);
  const after = 8_998;
  const result = verify(window(events, after), {
    after_sequence: after, prior_event_hash: events[after - 1].event_hash,
  });
  assert.equal(result.events.length, 2);
  assert.equal(result.complete, true);
  assert.throws(() => verify(window(chain()), { after_sequence: null }), TypeError);
  const value = window(chain());
  value.events = new Proxy(value.events, {});
  assert.throws(() => verify(value), TypeError);
});

test('a valid later source hash proves a prefix extension, never historical telemetry delivery', () => {
  const events = chain();
  // The caller can select a real later source anchor without having delivered
  // its prefix. Checkpoint custody/delivery is a future observer obligation.
  const result = verify(window(events, 2), {
    after_sequence: 2, prior_event_hash: events[1].event_hash,
  });
  assert.equal(result.next_after_sequence, 4);
  assert.equal(result.events[0].evidence_class, 'control_plane_self_attested');
  assert.equal(Object.hasOwn(result, 'delivered'), false);
  assert.equal(Object.hasOwn(result, 'projected'), false);
});

test('bounded audit verification rejects corruption, crossing, truncation and false anchors', () => {
  assert.equal(typeof audit.verifyManagedAuditWindow, 'function');
  const events = chain();
  const mutations = [
    (value) => { value.events.pop(); },
    (value) => { value.events[1].sequence = 3; },
    (value) => { value.events[0].tenant_id = 'tenant_other'; },
    (value) => { value.events[0].invocation_ref = 'rfi_other'; },
    (value) => { value.events[0].event_hash = sha256Ref('forged'); },
    (value) => { value.events[1].prior_event_hash = sha256Ref('wrong predecessor'); },
    (value) => { value.events[1].occurred_at = '2026-09-05T11:59:59.000Z'; },
    (value) => { value.audit_event_count = 1; },
    (value) => { value.prior_event = value.events[0]; },
  ];
  for (const mutate of mutations) {
    const value = structuredClone(window(events));
    mutate(value);
    assert.throws(() => verify(value));
  }
  assert.throws(() => verify(window(events, 2), {
    after_sequence: 2, prior_event_hash: sha256Ref('wrong checkpoint'),
  }));
  assert.throws(() => verify(window(events, 4), {
    after_sequence: 5, prior_event_hash: events[3].event_hash,
  }));
  const wrongHead = structuredClone(window(events, 2));
  wrongHead.audit_head_hash = sha256Ref('wrong source tail');
  assert.throws(() => verify(wrongHead, { after_sequence: 2, prior_event_hash: events[1].event_hash }));
  const emptyWrongHead = structuredClone(window(events, 4));
  emptyWrongHead.audit_head_hash = sha256Ref('wrong empty source tail');
  assert.throws(() => verify(emptyWrongHead, { after_sequence: 4, prior_event_hash: events[3].event_hash }));
});
