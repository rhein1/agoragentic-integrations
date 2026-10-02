import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { buildOpenShellPlan } from './scaffold.mjs';
import { reconcileOpenShellLifecycle, invokeOpenShell, openShellHostReadiness } from './host-adapter.mjs';

const fixture = JSON.parse(readFileSync(new URL('./fixture.json', import.meta.url), 'utf8'));
const plan = buildOpenShellPlan(fixture);
const id = 'original-id';
const e = (type, extra = {}) => ({ type, ...extra });
const created = [e('create_requested'), e('created', { sandboxId: id })];
const configured = [...created, e('ready', { sandboxId: id }), e('config_observed', {
  sandboxId: id, image: plan.request.image, policyDigest: plan.policyDigest,
})];
const running = [...configured, e('exec_started', { sandboxId: id })];
const terminal = [...running, e('exec_terminal', { sandboxId: id, exitCode: 0 })];
const journal = (events) => ({ schema: 'agoragentic.openshell.lifecycle-journal.v1', planDigest: plan.planDigest,
  events: events.map((event, index) => ({ seq: index + 1, ...event })) });
const replay = (events) => reconcileOpenShellLifecycle(plan, JSON.stringify(journal(events)));

test('complete observed lifecycle binds identity and plan but never creates verified evidence', () => {
  const events = [...terminal, e('delete_requested', { sandboxId: id }),
    e('deletion_observed', { sandboxId: id, outcome: 'accepted' }),
    e('deletion_observed', { sandboxId: id, outcome: 'completed' })];
  const result = replay(events);
  assert.equal(result.cleanup, 'reported_completed');
  assert.equal(result.execution, 'reported_success');
  assert.equal(result.reconciliationRequired, false);
  for (const field of ['terminationVerified', 'cleanupVerified', 'executionAuthority', 'providerCalls', 'runtimeContainmentVerified']) {
    assert.equal(result[field], false);
  }
  assert.equal(result.evidenceClass, 'caller_reported_unverified');
  assert.equal(result.sandboxId, id);
  assert.equal(result.planDigest, plan.planDigest);
  assert.deepEqual(result, replay(events));
  assert.ok(Object.isFrozen(result.interruptions));
  assert.ok(Object.isFrozen(result.terminal));
});

test('empty journal invents no successful execution or cleanup', () => {
  const result = replay([]);
  assert.equal(result.sandboxId, null);
  assert.equal(result.execution, 'not_started');
  assert.equal(result.terminal, null);
  assert.equal(result.cleanup, 'not_requested');
});

test('ambiguous create prevents retry and late identity remains available for cleanup', () => {
  const uncertain = [e('create_requested'), e('create_unknown')];
  assert.equal(replay(uncertain).reconciliationRequired, true);
  assert.equal(replay(uncertain).repeatCreateAllowed, false);
  assert.throws(() => replay([...uncertain, e('create_requested')]), { code: 'invalid_lifecycle_sequence' });
  assert.throws(() => replay([...uncertain, e('created', { sandboxId: id }), e('ready', { sandboxId: id })]), { code: 'invalid_lifecycle_sequence' });
  const late = replay([...uncertain, e('cancelled'), e('created', { sandboxId: id }), e('delete_requested', { sandboxId: id })]);
  assert.equal(late.sandboxId, id);
  assert.equal(late.cleanup, 'requested');
  assert.equal(late.reconciliationRequired, true);
});

for (const type of ['cancelled', 'timed_out', 'revoked', 'exec_unknown']) {
  test(`${type} cannot imply worker termination or authorize another exec`, () => {
    const stop = e(type, type === 'exec_unknown' ? { sandboxId: id } : {});
    const result = replay([...running, stop]);
    assert.equal(result.execution, 'unknown');
    assert.equal(result.terminationVerified, false);
    assert.equal(result.reconciliationRequired, true);
    assert.throws(() => replay([...running, stop, e('exec_started', { sandboxId: id })]), { code: 'invalid_lifecycle_sequence' });
    assert.equal(replay([...running, stop, e('exec_terminal', { sandboxId: id, exitCode: 137 })]).execution, 'reported_failure');
  });
}

for (const outcome of ['accepted', 'already_absent', 'unspecified', 'unknown']) {
  test(`deletion ${outcome} remains unresolved`, () => {
    const result = replay([...terminal, e('delete_requested', { sandboxId: id }), e('deletion_observed', { sandboxId: id, outcome })]);
    assert.equal(result.reconciliationRequired, true);
    assert.equal(result.cleanupVerified, false);
    assert.notEqual(result.cleanup, 'reported_completed');
  });
}

test('same-name replacement identity cannot be used for cleanup or terminal status', () => {
  assert.throws(() => replay([...terminal, e('delete_requested', { sandboxId: 'replacement' })]), { code: 'sandbox_identity_mismatch' });
  assert.throws(() => replay([...running, e('exec_terminal', { sandboxId: 'replacement', exitCode: 0 })]), { code: 'sandbox_identity_mismatch' });
});

test('policy or image mismatch blocks subsequent execution but permits original-ID cleanup', () => {
  for (const key of ['image', 'policyDigest']) {
    const events = structuredClone(configured);
    events.at(-1)[key] = 'different';
    assert.equal(replay(events).config, 'reported_mismatch');
    assert.throws(() => replay([...events, e('exec_started', { sandboxId: id })]), { code: 'invalid_lifecycle_sequence' });
    assert.equal(replay([...events, e('delete_requested', { sandboxId: id })]).cleanup, 'requested');
  }
});

test('out-of-order, duplicate and post-cleanup operations are rejected', () => {
  const invalid = [
    [e('ready', { sandboxId: id })],
    [...created, e('exec_started', { sandboxId: id })],
    [...configured, e('exec_terminal', { sandboxId: id, exitCode: 0 })],
    [...created, e('created', { sandboxId: id })],
    [...terminal, e('exec_terminal', { sandboxId: id, exitCode: 0 })],
    [...created, e('deletion_observed', { sandboxId: id, outcome: 'completed' })],
    [...created, e('delete_requested', { sandboxId: id }), e('delete_requested', { sandboxId: id })],
    [...created, e('delete_requested', { sandboxId: id }), e('deletion_observed', { sandboxId: id, outcome: 'completed' }), e('ready', { sandboxId: id })],
    [e('create_requested'), e('create_rejected'), e('create_requested')],
  ];
  for (const events of invalid) assert.throws(() => replay(events), { code: 'invalid_lifecycle_sequence' });
});

test('missing, boolean, negative and nonterminal exit codes cannot count as success', () => {
  for (const exitCode of [null, true, -1, 256, '0']) {
    assert.throws(() => replay([...running, e('exec_terminal', { sandboxId: id, exitCode })]), { code: 'terminal_exit_code_required' });
  }
  assert.throws(() => replay([...running, e('exec_terminal', { sandboxId: id })]), { code: 'invalid_journal_fields' });
});

test('journal schema, lineage, count and sequence are strict', () => {
  const data = journal(created);
  for (const mutation of [
    { ...data, approved: true }, { ...data, schema: 'other' }, { ...data, planDigest: 'wrong' },
    { ...data, events: [{ ...data.events[0], seq: 2 }] },
    { ...data, events: [{ ...data.events[0], method: 'create' }] },
    { ...data, events: Array(129).fill(data.events[0]) },
  ]) assert.throws(() => reconcileOpenShellLifecycle(plan, JSON.stringify(mutation)));
  assert.throws(() => reconcileOpenShellLifecycle(plan, 'x'.repeat(65537)), { code: 'bounded_journal_json_required' });
  assert.throws(() => reconcileOpenShellLifecycle(plan, '{'), { code: 'invalid_journal_json' });
  let invoked = false;
  assert.throws(() => reconcileOpenShellLifecycle(plan, { get events() { invoked = true; return []; } }), { code: 'bounded_journal_json_required' });
  assert.equal(invoked, false);
});

test('live invocation refuses even with caller-provided approval or fake client', async () => {
  await assert.rejects(invokeOpenShell({ approved: true, client: { create() { throw Error('called'); } } }), { code: 'openshell_live_adapter_not_implemented' });
  assert.equal(openShellHostReadiness().activationSupported, false);
  assert.equal(openShellHostReadiness().providerCalls, false);
});
