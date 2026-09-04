import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import {
  InMemorySafePayLedger,
  buildActionBinding,
  buildMandateBinding,
  createAnchorSafePayHarness,
  createFixtureSafePayScreenAdapter,
  createFixtureSimulatedSend,
} from '../safe-pay-harness-adapter.js';

const FIXED_NOW = '2030-01-01T00:00:00.000Z';
const ACTION = fixture('action.json');
const MANDATE = fixture('owner-mandate.json');
const APPROVAL = fixture('owner-approval.json');
const ALLOW = fixture('safe-pay-allow.json');
const REVIEW = fixture('safe-pay-review.json');
const BLOCK = fixture('safe-pay-block.json');

test('fixture approval is bound to the exact canonical action', () => {
  const binding = buildActionBinding(ACTION);
  const mandateBinding = buildMandateBinding(MANDATE);
  assert.equal(binding.action_digest, APPROVAL.action_digest);
  assert.equal(mandateBinding.mandate_hash, APPROVAL.mandate_hash);
  assert.equal(mandateBinding.authority_assertion, 'caller_declared_unverified_fixture');
  assert.equal(binding.amount_atomic, '1000000');
  assert.match(binding.idempotency_key_hash, /^sha256:[a-f0-9]{64}$/);
  assert.equal(Object.hasOwn(binding, 'idempotency_key'), false);
});

test('the integration is default-off and invokes neither screening nor send', async () => {
  const harness = makeHarness({ enabled: false });
  const screening = countedScreen(ALLOW);
  const sending = countedSend();

  const result = await harness.governedSend({
    action: ACTION,
    mandate: MANDATE,
    approval: APPROVAL,
    screenRecipient: screening.handler,
    simulatedSend: sending.handler,
  });

  assertDecision(result, 'deny', 'integration_disabled');
  assert.equal(screening.calls(), 0);
  assert.equal(sending.calls(), 0);
});

test('Safe Pay allow plus exact caller-declared records executes the inert simulator once', async () => {
  const harness = makeHarness();
  const screening = countedScreen(ALLOW);
  const sending = countedSend();

  const result = await harness.governedSend({
    action: ACTION,
    mandate: MANDATE,
    approval: APPROVAL,
    screenRecipient: screening.handler,
    simulatedSend: sending.handler,
  });

  assertDecision(result, 'allow', 'allowed_simulated');
  assert.equal(screening.calls(), 1);
  assert.equal(sending.calls(), 1);
  const callbackAction = sending.lastBinding();
  assert.equal(callbackAction.action_digest, APPROVAL.action_digest);
  assert.equal(Object.hasOwn(callbackAction, 'idempotency_key'), false);
  assert.equal(result.owner_authority.authority_declared, true);
  assert.equal(result.owner_authority.owner_authority_verified, false);
  assert.equal(result.owner_authority.verification_scope, 'caller_declared_unverified_fixture');
  assert.equal(result.owner_authority.mandate_matched, true);
  assert.equal(result.owner_authority.grants_external_effect_authority, false);
  assert.equal(result.approval.approval_verified, false);
  assert.equal(result.approval.verification_scope, 'caller_declared_unverified_fixture');
  assert.equal(result.approval.action_matched, true);
  assert.equal(result.approval.mandate_matched, true);
  assert.equal(result.approval.grants_payment_authority, false);
  assert.equal(result.approval.grants_external_effect_authority, false);
  assert.equal(result.approval.consumed, true);
  assert.equal(result.safe_pay.recommendation, 'allow');
  assert.equal(result.safe_pay.grants_payment_authority, false);
  assert.equal(result.execution.send_callback_invoked, true);
  assert.equal(result.execution.callback_status, 'simulated');
  assert.equal(result.execution.authorized_for_external_effects, false);
  assert.equal(result.decision_scope, 'caller_declared_fixture_simulation_only');
  assert.equal(result.funds_moved, false);
  assert.equal(result.settlement_proven, false);
});

test('caller-supplied authority wording cannot promote the receipt to verified', async () => {
  const mandate = {
    ...MANDATE,
    mandate_ref: 'mandate:caller-claims-verified',
    authority_evidence: 'host_attested_cryptographically_verified',
  };
  const result = await makeHarness().governedSend({
    action: ACTION,
    mandate,
    approval: makeApproval(ACTION, { approval_ref: 'approval:caller-claims-verified' }, mandate),
    screenRecipient: countedScreen(ALLOW).handler,
    simulatedSend: createFixtureSimulatedSend(),
  });

  assertDecision(result, 'allow', 'allowed_simulated');
  assert.equal(result.owner_authority.owner_authority_verified, false);
  assert.equal(result.owner_authority.verification_scope, 'caller_declared_unverified_fixture');
  assert.equal(result.approval.approval_verified, false);
});

test('missing principal authority denies before screening', async () => {
  const harness = makeHarness();
  const screening = countedScreen(ALLOW);
  const sending = countedSend();
  const result = await harness.governedSend({
    action: ACTION,
    mandate: { ...MANDATE, authority_granted: false },
    approval: APPROVAL,
    screenRecipient: screening.handler,
    simulatedSend: sending.handler,
  });

  assertDecision(result, 'deny', 'principal_authority_missing');
  assert.equal(screening.calls(), 0);
  assert.equal(sending.calls(), 0);
});

test('caller clock callbacks are rejected without invocation', () => {
  let callerEffects = 0;
  assert.throws(
    () => createAnchorSafePayHarness({
      now: () => {
        callerEffects += 1;
        return new Date(FIXED_NOW);
      },
    }),
    error => error?.code === 'fixture_clock_callback_unsupported',
  );
  assert.equal(callerEffects, 0);
});

test('a challenge fixture clock requires primitive initial clock data', () => {
  assert.throws(
    () => createAnchorSafePayHarness({ fixtureChallengeNow: FIXED_NOW }),
    error => error?.code === 'fixture_clock_invalid',
  );
});

test('a challenge fixture clock cannot move backward', () => {
  assert.throws(
    () => createAnchorSafePayHarness({
      fixtureNow: '2030-01-01T00:05:00.000Z',
      fixtureChallengeNow: '2030-01-01T00:00:00.000Z',
    }),
    error => error?.code === 'fixture_clock_invalid',
  );
});

test('an unscoped denial cannot inherit another principal budget total', async () => {
  const harness = makeHarness();
  const first = await harness.governedSend({
    action: ACTION,
    mandate: MANDATE,
    approval: APPROVAL,
    screenRecipient: countedScreen(ALLOW).handler,
    simulatedSend: createFixtureSimulatedSend(),
  });
  assertDecision(first, 'allow', 'allowed_simulated');

  const otherAction = {
    ...ACTION,
    principal_ref: 'owner:other-fixture',
    idempotency_key: 'fixture-other-principal-denial',
  };
  const screening = countedScreen(ALLOW);
  const denied = await harness.governedSend({
    action: otherAction,
    mandate: {
      ...MANDATE,
      principal_ref: otherAction.principal_ref,
      authority_granted: false,
    },
    approval: APPROVAL,
    screenRecipient: screening.handler,
    simulatedSend: createFixtureSimulatedSend(),
  });

  assertDecision(denied, 'deny', 'principal_authority_missing');
  assert.equal(denied.budget.budget_scope_hash, null);
  assert.equal(denied.budget.cumulative_before_atomic, null);
  assert.equal(denied.budget.cumulative_after_atomic, null);
  assert.equal(screening.calls(), 0);
  assert.equal(harness.ledger.snapshot().cumulative_authorized_atomic, '1000000');
});

test('malformed mandate fields return a bounded deny receipt', async () => {
  const screening = countedScreen(ALLOW);
  const result = await makeHarness().governedSend({
    action: ACTION,
    mandate: { ...MANDATE, principal_ref: '' },
    approval: APPROVAL,
    screenRecipient: screening.handler,
    simulatedSend: createFixtureSimulatedSend(),
  });

  assertDecision(result, 'deny', 'mandate_invalid');
  assert.equal(screening.calls(), 0);
});

test('malformed approval fields return a bounded deny receipt', async () => {
  const screening = countedScreen(ALLOW);
  const result = await makeHarness().governedSend({
    action: ACTION,
    mandate: MANDATE,
    approval: { ...APPROVAL, approval_ref: '' },
    screenRecipient: screening.handler,
    simulatedSend: createFixtureSimulatedSend(),
  });

  assertDecision(result, 'deny', 'approval_invalid');
  assert.equal(screening.calls(), 0);
});

test('approval must bind the exact mandate hash before screening', async () => {
  const screening = countedScreen(ALLOW);
  const result = await makeHarness().governedSend({
    action: ACTION,
    mandate: MANDATE,
    approval: { ...APPROVAL, mandate_hash: `sha256:${'0'.repeat(64)}` },
    screenRecipient: screening.handler,
    simulatedSend: createFixtureSimulatedSend(),
  });

  assertDecision(result, 'deny', 'approval_mandate_mismatch');
  assert.equal(result.approval.mandate_matched, false);
  assert.equal(screening.calls(), 0);
});

test('approval without a mandate hash is invalid before screening', async () => {
  const { mandate_hash: _omitted, ...approval } = APPROVAL;
  const screening = countedScreen(ALLOW);
  const result = await makeHarness().governedSend({
    action: ACTION,
    mandate: MANDATE,
    approval,
    screenRecipient: screening.handler,
    simulatedSend: createFixtureSimulatedSend(),
  });

  assertDecision(result, 'deny', 'approval_invalid');
  assert.equal(screening.calls(), 0);
});

test('Safe Pay review becomes ask and never invokes send', async () => {
  const { result, sends, screens } = await oneShot({ verdict: REVIEW });
  assertDecision(result, 'ask', 'safe_pay_review');
  assert.equal(screens, 1);
  assert.equal(sends, 0);
});

test('Safe Pay block denies and never invokes send', async () => {
  const { result, sends, screens } = await oneShot({ verdict: BLOCK });
  assertDecision(result, 'deny', 'safe_pay_block');
  assert.equal(screens, 1);
  assert.equal(sends, 0);
});

test('Safe Pay unavailability fails closed', async () => {
  const { result, sends, screens } = await oneShot({ unavailable: true });
  assertDecision(result, 'deny', 'safe_pay_unavailable');
  assert.equal(screens, 1);
  assert.equal(sends, 0);
});

test('Safe Pay fixture timeout fails closed', async () => {
  const harness = makeHarness({ screenTimeoutMs: 10 });
  const screening = countedScreen(ALLOW, { fixtureDelayMs: 30 });
  const sending = countedSend();
  const result = await harness.governedSend({
    action: ACTION,
    mandate: MANDATE,
    approval: APPROVAL,
    screenRecipient: screening.handler,
    simulatedSend: sending.handler,
  });

  assertDecision(result, 'deny', 'safe_pay_unavailable');
  assert.equal(screening.calls(), 1);
  assert.equal(sending.calls(), 0);
});

test('unknown Safe Pay recommendation is normalized by upstream as unavailable', async () => {
  const verdict = { ...ALLOW, recommendation: 'pending' };
  const { result, sends } = await oneShot({ verdict });
  assertDecision(result, 'deny', 'safe_pay_unavailable');
  assert.equal(sends, 0);
});

test('a mutable fixture verdict is observed once and cannot split the upstream decision', async () => {
  let recommendationReads = 0;
  const verdict = { ...ALLOW };
  Object.defineProperty(verdict, 'recommendation', {
    enumerable: true,
    get() {
      recommendationReads += 1;
      return recommendationReads === 1 ? 'block' : 'allow';
    },
  });

  const { result, sends } = await oneShot({ verdict });
  assertDecision(result, 'deny', 'safe_pay_block');
  assert.equal(result.safe_pay.upstream_allows, false);
  assert.equal(recommendationReads, 1);
  assert.equal(sends, 0);
});

for (const wallet of ['', 'x'.repeat(513)]) {
  test(`malformed Safe Pay wallet of length ${wallet.length} returns a bounded deny receipt`, async () => {
    const { result, sends } = await oneShot({ verdict: { ...ALLOW, wallet } });
    assertDecision(result, 'deny', 'safe_pay_unknown');
    assert.equal(sends, 0);
  });
}

test('partial Safe Pay allow is held for review', async () => {
  const verdict = { ...ALLOW, partial: true };
  const { result, sends } = await oneShot({ verdict });
  assertDecision(result, 'ask', 'safe_pay_partial');
  assert.equal(sends, 0);
});

test('amount above the per-action limit denies before screening', async () => {
  const action = { ...ACTION, amount_atomic: '1500001', idempotency_key: 'fixture-over-cap' };
  const approval = makeApproval(action, { approval_ref: 'approval:fixture-over-cap' });
  const screening = countedScreen({ ...ALLOW, wallet: action.recipient });
  const sending = countedSend();
  const result = await makeHarness().governedSend({
    action,
    mandate: MANDATE,
    approval,
    screenRecipient: screening.handler,
    simulatedSend: sending.handler,
  });

  assertDecision(result, 'deny', 'per_action_limit_exceeded');
  assert.equal(screening.calls(), 0);
  assert.equal(sending.calls(), 0);
});

test('unsafe numeric action amounts are rejected before they can be rounded', () => {
  assert.throws(
    () => buildActionBinding({ ...ACTION, amount_atomic: Number.MAX_SAFE_INTEGER + 1 }),
    error => error?.code === 'amount_invalid',
  );
});

test('atomic amounts larger than uint256 are rejected before BigInt work can grow unbounded', () => {
  assert.throws(
    () => buildActionBinding({ ...ACTION, amount_atomic: '1'.repeat(79) }),
    error => error?.code === 'amount_invalid',
  );
  assert.throws(
    () => buildActionBinding({ ...ACTION, amount_atomic: (1n << 256n).toString() }),
    error => error?.code === 'amount_invalid',
  );
});

for (const field of ['per_action_limit_atomic', 'cumulative_limit_atomic']) {
  test(`unsafe numeric mandate ${field} is denied before screening`, async () => {
    const screening = countedScreen(ALLOW);
    const sending = countedSend();
    const result = await makeHarness().governedSend({
      action: ACTION,
      mandate: { ...MANDATE, [field]: Number.MAX_SAFE_INTEGER + 1 },
      approval: APPROVAL,
      screenRecipient: screening.handler,
      simulatedSend: sending.handler,
    });

    assertDecision(result, 'deny', 'mandate_invalid');
    assert.equal(screening.calls(), 0);
    assert.equal(sending.calls(), 0);
  });
}

test('cumulative budget is rechecked atomically before send', async () => {
  const harness = makeHarness();
  const firstScreen = countedScreen(ALLOW);
  const first = await harness.governedSend({
    action: ACTION,
    mandate: MANDATE,
    approval: APPROVAL,
    screenRecipient: firstScreen.handler,
    simulatedSend: createFixtureSimulatedSend(),
  });
  assertDecision(first, 'allow', 'allowed_simulated');

  const secondAction = {
    ...ACTION,
    amount_atomic: '1100000',
    idempotency_key: 'fixture-send-0002',
    proposed_at: '2029-12-31T23:59:10.000Z',
  };
  const secondApproval = makeApproval(secondAction, { approval_ref: 'approval:fixture-send-0002' });
  const secondScreen = countedScreen({ ...ALLOW, wallet: secondAction.recipient });
  const secondSending = countedSend();
  const second = await harness.governedSend({
    action: secondAction,
    mandate: MANDATE,
    approval: secondApproval,
    screenRecipient: secondScreen.handler,
    simulatedSend: secondSending.handler,
  });

  assertDecision(second, 'deny', 'cumulative_limit_exceeded');
  assert.equal(secondScreen.calls(), 0);
  assert.equal(secondSending.calls(), 0);
  assert.equal(harness.ledger.snapshot().cumulative_authorized_atomic, '1000000');
});

test('a used mandate reference cannot raise its cumulative ceiling', async () => {
  const harness = makeHarness();
  const first = await harness.governedSend({
    action: ACTION,
    mandate: MANDATE,
    approval: APPROVAL,
    screenRecipient: countedScreen(ALLOW).handler,
    simulatedSend: createFixtureSimulatedSend(),
  });
  assertDecision(first, 'allow', 'allowed_simulated');

  const secondAction = {
    ...ACTION,
    amount_atomic: '1100000',
    idempotency_key: 'fixture-raised-cap-0002',
    proposed_at: '2029-12-31T23:59:10.000Z',
  };
  const originalApproval = makeApproval(secondAction, { approval_ref: 'approval:raised-cap-0002' });
  const originalScreen = countedScreen(ALLOW);
  const underOriginalCeiling = await harness.governedSend({
    action: secondAction,
    mandate: MANDATE,
    approval: originalApproval,
    screenRecipient: originalScreen.handler,
    simulatedSend: createFixtureSimulatedSend(),
  });
  assertDecision(underOriginalCeiling, 'deny', 'cumulative_limit_exceeded');
  assert.equal(originalScreen.calls(), 0);

  const raisedMandate = { ...MANDATE, cumulative_limit_atomic: '3000000' };
  const raisedScreen = countedScreen(ALLOW);
  const raised = await harness.governedSend({
    action: secondAction,
    mandate: raisedMandate,
    approval: makeApproval(
      secondAction,
      { approval_ref: 'approval:raised-cap-0002' },
      raisedMandate,
    ),
    screenRecipient: raisedScreen.handler,
    simulatedSend: createFixtureSimulatedSend(),
  });

  assertDecision(raised, 'deny', 'mandate_definition_mismatch');
  assert.equal(raisedScreen.calls(), 0);
  assert.equal(
    harness.ledger.snapshot(first.budget.budget_scope_hash).cumulative_authorized_atomic,
    '1000000',
  );
});

for (const [label, mandatePatch] of [
  ['per-action limit', { per_action_limit_atomic: '1600000' }],
  ['recipient scope', { allowed_recipients: [...MANDATE.allowed_recipients, '0x3333333333333333333333333333333333333333'] }],
  ['asset scope', { allowed_assets: [...MANDATE.allowed_assets, 'DAI'] }],
  ['network scope', { allowed_networks: [...MANDATE.allowed_networks, 'eip155:1'] }],
]) {
  test(`a used mandate reference rejects a changed ${label}`, async () => {
    const harness = makeHarness();
    await harness.governedSend({
      action: ACTION,
      mandate: MANDATE,
      approval: APPROVAL,
      screenRecipient: countedScreen(ALLOW).handler,
      simulatedSend: createFixtureSimulatedSend(),
    });

    const action = {
      ...ACTION,
      amount_atomic: '100000',
      idempotency_key: `fixture-mandate-mutation-${label}`,
      proposed_at: '2029-12-31T23:59:10.000Z',
    };
    const changedMandate = { ...MANDATE, ...mandatePatch };
    const screening = countedScreen(ALLOW);
    const result = await harness.governedSend({
      action,
      mandate: changedMandate,
      approval: makeApproval(
        action,
        { approval_ref: `approval:mandate-mutation-${label}` },
        changedMandate,
      ),
      screenRecipient: screening.handler,
      simulatedSend: createFixtureSimulatedSend(),
    });

    assertDecision(result, 'deny', 'mandate_definition_mismatch');
    assert.equal(screening.calls(), 0);
  });
}

test('cumulative counters are isolated by asset and network budget scope', async () => {
  const harness = makeHarness();
  const first = await harness.governedSend({
    action: ACTION,
    mandate: MANDATE,
    approval: APPROVAL,
    screenRecipient: countedScreen(ALLOW).handler,
    simulatedSend: createFixtureSimulatedSend(),
  });

  const secondAction = {
    ...ACTION,
    asset: 'EURC',
    amount_atomic: '1100000',
    idempotency_key: 'fixture-eurc-send-0001',
    proposed_at: '2029-12-31T23:59:10.000Z',
  };
  const second = await harness.governedSend({
    action: secondAction,
    mandate: MANDATE,
    approval: makeApproval(secondAction, { approval_ref: 'approval:fixture-eurc-send-0001' }),
    screenRecipient: countedScreen({ ...ALLOW, wallet: secondAction.recipient }).handler,
    simulatedSend: createFixtureSimulatedSend(),
  });

  assertDecision(first, 'allow', 'allowed_simulated');
  assertDecision(second, 'allow', 'allowed_simulated');
  assert.notEqual(first.budget.budget_scope_hash, second.budget.budget_scope_hash);
  assert.equal(
    harness.ledger.snapshot(first.budget.budget_scope_hash).cumulative_authorized_atomic,
    '1000000',
  );
  assert.equal(
    harness.ledger.snapshot(second.budget.budget_scope_hash).cumulative_authorized_atomic,
    '1100000',
  );
  assert.equal(harness.ledger.snapshot().budget_scope_count, 2);
  assert.equal(harness.ledger.snapshot().cumulative_authorized_atomic, null);
});

for (const [name, patch] of [
  ['recipient', { recipient: '0x2222222222222222222222222222222222222222' }],
  ['amount', { amount_atomic: '1100000' }],
  ['network', { network: 'eip155:84532' }],
  ['asset', { asset: 'EURC' }],
]) {
  test(`${name} changed after approval invalidates the exact action`, async () => {
    const action = { ...ACTION, ...patch };
    const screening = countedScreen({ ...ALLOW, wallet: action.recipient });
    const sending = countedSend();
    const result = await makeHarness().governedSend({
      action,
      mandate: MANDATE,
      approval: APPROVAL,
      screenRecipient: screening.handler,
      simulatedSend: sending.handler,
    });

    assertDecision(result, 'deny', 'approval_action_mismatch');
    assert.equal(screening.calls(), 0);
    assert.equal(sending.calls(), 0);
  });
}

test('expired approval denies before screening', async () => {
  const screening = countedScreen(ALLOW);
  const sending = countedSend();
  const result = await makeHarness().governedSend({
    action: ACTION,
    mandate: MANDATE,
    approval: { ...APPROVAL, expires_at: FIXED_NOW },
    screenRecipient: screening.handler,
    simulatedSend: sending.handler,
  });

  assertDecision(result, 'deny', 'approval_expired');
  assert.equal(screening.calls(), 0);
  assert.equal(sending.calls(), 0);
});

test('approval must come from the exact owner principal', async () => {
  const screening = countedScreen(ALLOW);
  const result = await makeHarness().governedSend({
    action: ACTION,
    mandate: MANDATE,
    approval: { ...APPROVAL, approved_by: 'owner:other' },
    screenRecipient: screening.handler,
    simulatedSend: createFixtureSimulatedSend(),
  });

  assertDecision(result, 'deny', 'approval_principal_mismatch');
  assert.equal(screening.calls(), 0);
});

test('approval expiring during screening is denied before reservation or send', async () => {
  const screening = countedScreen(ALLOW);
  const harness = makeHarness({
    fixtureChallengeNow: '2030-01-01T00:20:00.000Z',
  });
  const sending = countedSend();

  const result = await harness.governedSend({
    action: ACTION,
    mandate: MANDATE,
    approval: APPROVAL,
    screenRecipient: screening.handler,
    simulatedSend: sending.handler,
  });

  assertDecision(result, 'deny', 'approval_expired');
  assert.equal(result.generated_at, '2030-01-01T00:20:00.000Z');
  assert.equal(screening.calls(), 1);
  assert.equal(sending.calls(), 0);
  assert.equal(harness.ledger.snapshot().reservation_count, 0);
});

test('mandate expiring during screening is denied before reservation or send', async () => {
  const screening = countedScreen(ALLOW);
  const harness = makeHarness({
    fixtureChallengeNow: '2030-01-03T00:00:00.000Z',
  });
  const sending = countedSend();

  const result = await harness.governedSend({
    action: ACTION,
    mandate: MANDATE,
    approval: APPROVAL,
    screenRecipient: screening.handler,
    simulatedSend: sending.handler,
  });

  assertDecision(result, 'deny', 'mandate_expired');
  assert.equal(screening.calls(), 1);
  assert.equal(sending.calls(), 0);
  assert.equal(harness.ledger.snapshot().reservation_count, 0);
});

test('mandate and approval inputs are snapshotted before asynchronous screening', async () => {
  const mandate = { ...MANDATE, allowed_recipients: [...MANDATE.allowed_recipients] };
  const approval = { ...APPROVAL };
  const originalMandateHash = buildMandateBinding(mandate).mandate_hash;
  const originalApprovalRef = approval.approval_ref;
  const resultPromise = makeHarness().governedSend({
    action: ACTION,
    mandate,
    approval,
    screenRecipient: countedScreen(ALLOW, { fixtureDelayMs: 1 }).handler,
    simulatedSend: createFixtureSimulatedSend(),
  });
  mandate.cumulative_limit_atomic = '3000000';
  approval.mandate_hash = buildMandateBinding(mandate).mandate_hash;
  approval.approval_ref = 'approval:mutated-during-screen';
  const result = await resultPromise;

  assertDecision(result, 'allow', 'allowed_simulated');
  assert.equal(result.owner_authority.mandate_hash, originalMandateHash);
  assert.equal(result.approval.approval_ref, originalApprovalRef);
  assert.equal(result.budget.cumulative_limit_atomic, MANDATE.cumulative_limit_atomic);
});

test('duplicate idempotency key never screens or sends twice', async () => {
  const harness = makeHarness();
  for (const property of [
    'recordsByIdempotency',
    'recordsByApproval',
    'recordsByReservation',
    'cumulativeAuthorizedByScope',
    'mandateHashesByRef',
  ]) {
    assert.equal(harness.ledger[property], undefined);
    harness.ledger[property] = new Map();
  }
  const screening = countedScreen(ALLOW);
  const sending = countedSend();
  const input = {
    action: ACTION,
    mandate: MANDATE,
    approval: APPROVAL,
    screenRecipient: screening.handler,
    simulatedSend: sending.handler,
  };

  const first = await harness.governedSend(input);
  const second = await harness.governedSend(input);
  assertDecision(first, 'allow', 'allowed_simulated');
  assertDecision(second, 'deny', 'duplicate_idempotency');
  assert.equal(second.execution.duplicate_of_receipt_id, first.receipt_id);
  assert.equal(screening.calls(), 1);
  assert.equal(sending.calls(), 1);
});

test('instance ledger method overrides cannot execute or forge reservation evidence', async () => {
  const ledger = new InMemorySafePayLedger();
  const canonicalSnapshot = InMemorySafePayLedger.prototype.snapshot;
  let callerCodeRuns = 0;
  const override = () => {
    callerCodeRuns += 1;
    return {
      ok: true,
      reservation_id: 'caller-controlled-reservation',
      cumulative_before_atomic: '0',
      cumulative_after_atomic: ACTION.amount_atomic,
    };
  };

  ledger.preflight = override;
  ledger.reserve = override;
  const harness = makeHarness({ ledger });
  ledger.finalize = override;
  ledger.snapshot = override;

  const result = await harness.governedSend({
    action: ACTION,
    mandate: MANDATE,
    approval: APPROVAL,
    screenRecipient: countedScreen(ALLOW).handler,
    simulatedSend: createFixtureSimulatedSend(),
  });

  assertDecision(result, 'allow', 'allowed_simulated');
  assert.equal(callerCodeRuns, 0);
  assert.notEqual(result.budget.reservation_id, 'caller-controlled-reservation');
  assert.equal(result.approval.consumed, true);
  assert.equal(canonicalSnapshot.call(ledger).reservation_count, 1);
});

test('prototype ledger method overrides cannot execute or forge reservation evidence', async () => {
  const prototype = InMemorySafePayLedger.prototype;
  const canonical = {
    snapshot: prototype.snapshot,
    preflight: prototype.preflight,
    reserve: prototype.reserve,
    finalize: prototype.finalize,
  };
  let callerCodeRuns = 0;
  const override = () => {
    callerCodeRuns += 1;
    return {
      ok: true,
      reservation_id: 'caller-controlled-reservation',
      cumulative_before_atomic: '0',
      cumulative_after_atomic: ACTION.amount_atomic,
    };
  };

  try {
    prototype.snapshot = override;
    prototype.preflight = override;
    prototype.reserve = override;
    prototype.finalize = override;
    const ledger = new InMemorySafePayLedger();
    const harness = makeHarness({ ledger });
    const result = await harness.governedSend({
      action: ACTION,
      mandate: MANDATE,
      approval: APPROVAL,
      screenRecipient: countedScreen(ALLOW).handler,
      simulatedSend: createFixtureSimulatedSend(),
    });

    assertDecision(result, 'allow', 'allowed_simulated');
    assert.equal(callerCodeRuns, 0);
    assert.notEqual(result.budget.reservation_id, 'caller-controlled-reservation');
    assert.equal(canonical.snapshot.call(ledger).reservation_count, 1);
  } finally {
    prototype.snapshot = canonical.snapshot;
    prototype.preflight = canonical.preflight;
    prototype.reserve = canonical.reserve;
    prototype.finalize = canonical.finalize;
  }
});

test('ledger subclasses are rejected before governed execution', () => {
  let callerCodeRuns = 0;
  class CallerLedger extends InMemorySafePayLedger {
    reserve() {
      callerCodeRuns += 1;
      return { ok: true, reservation_id: 'caller-controlled-reservation' };
    }
  }

  assert.throws(
    () => createAnchorSafePayHarness({ ledger: new CallerLedger() }),
    error => error?.code === 'ledger_invalid',
  );
  assert.equal(callerCodeRuns, 0);
});

test('public ledger operations cannot fabricate governed reservations or receipts', async () => {
  const ledger = new InMemorySafePayLedger();
  const binding = buildActionBinding(ACTION);
  const directInput = {
    action_digest: binding.action_digest,
    approval_ref: APPROVAL.approval_ref,
    idempotency_key_hash: binding.idempotency_key_hash,
    budget_scope_hash: `sha256:${'1'.repeat(64)}`,
    mandate_ref: MANDATE.mandate_ref,
    mandate_hash: buildMandateBinding(MANDATE).mandate_hash,
    amount_atomic: ACTION.amount_atomic,
    cumulative_limit_atomic: MANDATE.cumulative_limit_atomic,
  };

  for (const operation of [
    () => ledger.preflight(directInput),
    () => ledger.reserve(directInput),
    () => ledger.finalize('caller-controlled-reservation', {
      decision: 'allow',
      receipt_id: 'caller-fabricated-receipt',
    }),
  ]) {
    assert.throws(operation, error => error?.code === 'ledger_operation_unauthorized');
  }
  assert.equal(ledger.snapshot().reservation_count, 0);
  assert.equal(ledger.snapshot().cumulative_authorized_atomic, null);

  const result = await makeHarness({ ledger }).governedSend({
    action: ACTION,
    mandate: MANDATE,
    approval: APPROVAL,
    screenRecipient: countedScreen(ALLOW).handler,
    simulatedSend: createFixtureSimulatedSend(),
  });
  assertDecision(result, 'allow', 'allowed_simulated');
  assert.notEqual(result.execution.duplicate_of_receipt_id, 'caller-fabricated-receipt');
  assert.equal(ledger.snapshot().reservation_count, 1);
});

test('returned receipts are deeply immutable and ledger replay retains only the original ID', async () => {
  const harness = makeHarness();
  const input = {
    action: ACTION,
    mandate: MANDATE,
    approval: APPROVAL,
    screenRecipient: countedScreen(ALLOW).handler,
    simulatedSend: createFixtureSimulatedSend(),
  };
  const first = await harness.governedSend(input);
  const originalReceiptId = first.receipt_id;
  let getterRuns = 0;

  assertDecision(first, 'allow', 'allowed_simulated');
  assert.equal(Object.isFrozen(first), true);
  assert.equal(Object.isFrozen(first.owner_authority), true);
  assert.equal(Object.isFrozen(first.approval), true);
  assert.equal(Object.isFrozen(first.safe_pay), true);
  assert.throws(
    () => Object.defineProperty(first, 'receipt_id', {
      get() {
        getterRuns += 1;
        return 'caller-fabricated-receipt';
      },
    }),
    TypeError,
  );
  assert.throws(
    () => {
      first.owner_authority.owner_authority_verified = true;
    },
    TypeError,
  );

  const replay = await harness.governedSend(input);
  assertDecision(replay, 'deny', 'duplicate_idempotency');
  assert.equal(getterRuns, 0);
  assert.equal(replay.execution.duplicate_of_receipt_id, originalReceiptId);
  assert.equal(first.owner_authority.owner_authority_verified, false);
});

test('fixture brands ignore WeakSet prototype replacement', async () => {
  const genuineScreen = createFixtureSafePayScreenAdapter({ verdict: ALLOW });
  const genuineSend = createFixtureSimulatedSend();
  const originalHas = WeakSet.prototype.has;
  let forgedScreenCalls = 0;
  let forgedSendCalls = 0;
  try {
    WeakSet.prototype.has = () => true;
    const forgedScreen = async () => {
      forgedScreenCalls += 1;
      return {};
    };
    const forgedSend = async () => {
      forgedSendCalls += 1;
      return simulatedResult();
    };

    const screenDenied = await makeHarness().governedSend({
      action: ACTION,
      mandate: MANDATE,
      approval: APPROVAL,
      screenRecipient: forgedScreen,
      simulatedSend: genuineSend,
    });
    assertDecision(screenDenied, 'deny', 'unsafe_screen_adapter');

    const sendDenied = await makeHarness().governedSend({
      action: ACTION,
      mandate: MANDATE,
      approval: APPROVAL,
      screenRecipient: genuineScreen,
      simulatedSend: forgedSend,
    });
    assertDecision(sendDenied, 'deny', 'unsafe_simulated_send_adapter');
  } finally {
    WeakSet.prototype.has = originalHas;
  }
  assert.equal(forgedScreenCalls, 0);
  assert.equal(forgedSendCalls, 0);
  assert.equal(genuineScreen.fixtureCallCount(), 0);
  assert.equal(genuineSend.fixtureCallCount(), 0);
});

test('fixture brand registration ignores WeakSet add replacement', async () => {
  const originalAdd = WeakSet.prototype.add;
  let screen;
  let send;
  let ledger;
  try {
    WeakSet.prototype.add = () => {
      throw new Error('caller_replaced_weakset_add');
    };
    screen = createFixtureSafePayScreenAdapter({ verdict: ALLOW });
    send = createFixtureSimulatedSend();
    ledger = new InMemorySafePayLedger();
  } finally {
    WeakSet.prototype.add = originalAdd;
  }

  const result = await makeHarness({ ledger }).governedSend({
    action: ACTION,
    mandate: MANDATE,
    approval: APPROVAL,
    screenRecipient: screen,
    simulatedSend: send,
  });
  assertDecision(result, 'allow', 'allowed_simulated');
  assert.equal(screen.fixtureCallCount(), 1);
  assert.equal(send.fixtureCallCount(), 1);
});

test('same idempotency key with a changed action is denied as a binding mismatch', async () => {
  const harness = makeHarness();
  await harness.governedSend({
    action: ACTION,
    mandate: MANDATE,
    approval: APPROVAL,
    screenRecipient: countedScreen(ALLOW).handler,
    simulatedSend: createFixtureSimulatedSend(),
  });

  const changed = { ...ACTION, amount_atomic: '1100000' };
  const changedApproval = makeApproval(changed, { approval_ref: 'approval:changed-same-key' });
  const screen = countedScreen({ ...ALLOW, wallet: changed.recipient });
  const result = await harness.governedSend({
    action: changed,
    mandate: MANDATE,
    approval: changedApproval,
    screenRecipient: screen.handler,
    simulatedSend: createFixtureSimulatedSend(),
  });

  assertDecision(result, 'deny', 'idempotency_binding_mismatch');
  assert.equal(screen.calls(), 0);
});

test('one approval reference cannot authorize a second idempotency key', async () => {
  const harness = makeHarness();
  await harness.governedSend({
    action: ACTION,
    mandate: MANDATE,
    approval: APPROVAL,
    screenRecipient: countedScreen(ALLOW).handler,
    simulatedSend: createFixtureSimulatedSend(),
  });

  const secondAction = { ...ACTION, idempotency_key: 'fixture-approval-replay-0002' };
  const secondScreen = countedScreen(ALLOW);
  const secondSending = countedSend();
  const replay = await harness.governedSend({
    action: secondAction,
    mandate: MANDATE,
    approval: makeApproval(secondAction, { approval_ref: APPROVAL.approval_ref }),
    screenRecipient: secondScreen.handler,
    simulatedSend: secondSending.handler,
  });

  assertDecision(replay, 'deny', 'approval_replay');
  assert.equal(secondScreen.calls(), 0);
  assert.equal(secondSending.calls(), 0);
});

test('stale Safe Pay verdict denies', async () => {
  const stale = { ...ALLOW, checked_at: 1893455000 };
  const { result, sends } = await oneShot({ verdict: stale });
  assertDecision(result, 'deny', 'safe_pay_verdict_stale');
  assert.equal(sends, 0);
});

test('future-dated Safe Pay verdict denies', async () => {
  const future = { ...ALLOW, checked_at: 1893456060 };
  const { result, sends } = await oneShot({ verdict: future });
  assertDecision(result, 'deny', 'safe_pay_verdict_future');
  assert.equal(sends, 0);
});

test('a mismatched Safe Pay wallet denies even when recommendation is allow', async () => {
  const mismatch = { ...ALLOW, wallet: '0x3333333333333333333333333333333333333333' };
  const { result, sends } = await oneShot({ verdict: mismatch });
  assertDecision(result, 'deny', 'safe_pay_recipient_mismatch');
  assert.equal(sends, 0);
});

test('ambiguous send consumes the key and is never automatically retried', async () => {
  const harness = makeHarness();
  const screening = countedScreen(ALLOW);
  const sending = countedSend({ outcome: 'throw' });
  const input = {
    action: ACTION,
    mandate: MANDATE,
    approval: APPROVAL,
    screenRecipient: screening.handler,
    simulatedSend: sending.handler,
  };

  const ambiguous = await harness.governedSend(input);
  const replay = await harness.governedSend(input);
  assertDecision(ambiguous, 'ask', 'send_ambiguous');
  assert.equal(ambiguous.execution.callback_status, 'ambiguous');
  assert.equal(ambiguous.execution.automatic_retry_allowed, false);
  assertDecision(replay, 'deny', 'duplicate_idempotency');
  assert.equal(screening.calls(), 1);
  assert.equal(sending.calls(), 1);
  assert.equal(harness.ledger.snapshot().cumulative_authorized_atomic, '1000000');
});

test('timed-out inert simulator is ambiguous and keeps its reservation', async () => {
  const harness = makeHarness({ sendTimeoutMs: 10 });
  const sending = countedSend({ fixtureDelayMs: 30 });
  const result = await harness.governedSend({
    action: ACTION,
    mandate: MANDATE,
    approval: APPROVAL,
    screenRecipient: countedScreen(ALLOW).handler,
    simulatedSend: sending.handler,
  });

  assertDecision(result, 'ask', 'send_ambiguous');
  assert.equal(result.execution.callback_status, 'ambiguous');
  assert.equal(result.budget.reservation_retained, true);
});

test('non-simulation simulator result is ambiguous and keeps its reservation', async () => {
  const result = await makeHarness().governedSend({
    action: ACTION,
    mandate: MANDATE,
    approval: APPROVAL,
    screenRecipient: countedScreen(ALLOW).handler,
    simulatedSend: createFixtureSimulatedSend('invalid'),
  });

  assertDecision(result, 'ask', 'send_ambiguous');
  assert.equal(result.execution.callback_status, 'ambiguous');
  assert.equal(result.budget.reservation_retained, true);
});

test('two concurrent attempts cannot consume one approval twice', async () => {
  const harness = makeHarness();
  const screening = countedScreen(ALLOW);
  const sending = countedSend({ fixtureDelayMs: 30 });
  const input = {
    action: ACTION,
    mandate: MANDATE,
    approval: APPROVAL,
    screenRecipient: screening.handler,
    simulatedSend: sending.handler,
  };

  const firstPromise = harness.governedSend(input);
  await new Promise(resolve => setImmediate(resolve));
  const second = await harness.governedSend(input);
  const first = await firstPromise;

  assertDecision(first, 'allow', 'allowed_simulated');
  assertDecision(second, 'deny', 'duplicate_idempotency');
  assert.equal(sending.calls(), 1);
});

test('two distinct concurrent actions cannot oversubscribe one cumulative scope', async () => {
  const harness = makeHarness();
  const actions = ['a', 'b'].map((suffix, index) => ({
    ...ACTION,
    amount_atomic: '1100000',
    idempotency_key: `fixture-concurrent-budget-${suffix}`,
    proposed_at: `2029-12-31T23:59:${10 + index}.000Z`,
  }));
  const senders = actions.map(() => countedSend({ fixtureDelayMs: 1 }));
  const attempts = actions.map((action, index) => harness.governedSend({
    action,
    mandate: MANDATE,
    approval: makeApproval(action, { approval_ref: `approval:concurrent-budget-${index}` }),
    screenRecipient: countedScreen(ALLOW).handler,
    simulatedSend: senders[index].handler,
  }));

  const results = await Promise.all(attempts);
  assert.deepEqual(
    results.map(result => `${result.decision}:${result.reason_code}`).sort(),
    ['allow:allowed_simulated', 'deny:cumulative_limit_exceeded'],
  );
  assert.equal(senders.reduce((total, sending) => total + sending.calls(), 0), 1);
  const allowed = results.find(result => result.decision === 'allow');
  assert.equal(
    harness.ledger.snapshot(allowed.budget.budget_scope_hash).cumulative_authorized_atomic,
    '1100000',
  );
});

test('non-fixture transport evidence is rejected before send', async () => {
  const harness = makeHarness();
  let screens = 0;
  const sending = countedSend();
  const result = await harness.governedSend({
    action: ACTION,
    mandate: MANDATE,
    approval: APPROVAL,
    screenRecipient: async () => {
      screens += 1;
      return {
        mode: 'production',
        network_calls: 1,
        paid_provider_calls: 1,
        production_endpoint_called: true,
        verdict: ALLOW,
      };
    },
    simulatedSend: sending.handler,
  });

  assertDecision(result, 'deny', 'unsafe_screen_adapter');
  assert.equal(screens, 0);
  assert.equal(sending.calls(), 0);
});

test('the fixture helper rejects an injectable screening function', () => {
  let alternateCalls = 0;
  assert.throws(
    () => createFixtureSafePayScreenAdapter({
      screenAllows: async () => {
        alternateCalls += 1;
        return { ok: true, verdict: ALLOW };
      },
      verdict: ALLOW,
    }),
    error => error?.code === 'screen_allows_not_injectable',
  );
  assert.equal(alternateCalls, 0);
});

test('the inert simulator rejects caller callbacks before they can cause effects', () => {
  let externalEffects = 0;
  for (const callback of [
    async () => {
      externalEffects += 1;
      return simulatedResult();
    },
    async () => {
      externalEffects += 1;
      throw new Error('mutated then failed');
    },
  ]) {
    assert.throws(
      () => createFixtureSimulatedSend(callback),
      error => error?.code === 'simulated_send_options_invalid',
    );
  }
  assert.equal(externalEffects, 0);
});

test('a reflected fixture-screen marker cannot authorize an arbitrary function', async () => {
  const genuine = createFixtureSafePayScreenAdapter({ verdict: ALLOW });
  let forgedCalls = 0;
  const forged = async () => {
    forgedCalls += 1;
    return {
      mode: 'fixture_no_network_no_spend',
      fixture_fetch_calls: 1,
      network_calls: 0,
      paid_provider_calls: 0,
      production_endpoint_called: false,
      upstream_ok: true,
      verdict: ALLOW,
    };
  };
  for (const marker of Object.getOwnPropertySymbols(genuine)) {
    Object.defineProperty(forged, marker, { value: genuine[marker] });
  }

  const result = await makeHarness().governedSend({
    action: ACTION,
    mandate: MANDATE,
    approval: APPROVAL,
    screenRecipient: forged,
    simulatedSend: createFixtureSimulatedSend(),
  });

  assertDecision(result, 'deny', 'unsafe_screen_adapter');
  assert.equal(genuine.fixtureCallCount(), 0);
  assert.equal(forgedCalls, 0);
});

test('an unmarked callback is rejected before screening or invocation', async () => {
  const harness = createAnchorSafePayHarness({
    enabled: true,
    fixtureNow: FIXED_NOW,
  });
  const screening = countedScreen(ALLOW);
  let sends = 0;
  const result = await harness.governedSend({
    action: ACTION,
    mandate: MANDATE,
    approval: APPROVAL,
    screenRecipient: screening.handler,
    simulatedSend: async () => {
      sends += 1;
      return simulatedResult();
    },
  });

  assertDecision(result, 'deny', 'unsafe_simulated_send_adapter');
  assert.equal(screening.calls(), 0);
  assert.equal(sends, 0);
});

test('a reflected fixture-send marker cannot authorize an arbitrary callback', async () => {
  const genuine = createFixtureSimulatedSend();
  let forgedCalls = 0;
  const forged = async () => {
    forgedCalls += 1;
    return simulatedResult();
  };
  for (const marker of Object.getOwnPropertySymbols(genuine)) {
    Object.defineProperty(forged, marker, { value: genuine[marker] });
  }
  const screening = countedScreen(ALLOW);

  const result = await createAnchorSafePayHarness({
    enabled: true,
    fixtureNow: FIXED_NOW,
  }).governedSend({
    action: ACTION,
    mandate: MANDATE,
    approval: APPROVAL,
    screenRecipient: screening.handler,
    simulatedSend: forged,
  });

  assertDecision(result, 'deny', 'unsafe_simulated_send_adapter');
  assert.equal(screening.calls(), 0);
  assert.equal(forgedCalls, 0);
});

test('receipt retains bounded hashes but not raw idempotency or Safe Pay notes', async () => {
  const secretNote = 'fixture-private-note-that-must-not-be-retained';
  const { result } = await oneShot({ verdict: { ...ALLOW, notes: secretNote } });
  const serialized = JSON.stringify(result);
  assertDecision(result, 'allow', 'allowed_simulated');
  assert.equal(serialized.includes(ACTION.idempotency_key), false);
  assert.equal(serialized.includes(secretNote), false);
  assert.match(result.safe_pay.evidence_hash, /^sha256:[a-f0-9]{64}$/);
  assert.match(result.action.idempotency_key_hash, /^sha256:[a-f0-9]{64}$/);
  assert.match(result.receipt_binding_hash, /^sha256:[a-f0-9]{64}$/);
});

test('composite receipt binding changes when Safe Pay evidence changes', async () => {
  const first = await oneShot({ verdict: ALLOW });
  const second = await oneShot({ verdict: { ...ALLOW, risk_score: Number(ALLOW.risk_score) + 1 } });

  assertDecision(first.result, 'allow', 'allowed_simulated');
  assertDecision(second.result, 'allow', 'allowed_simulated');
  assert.notEqual(first.result.safe_pay.evidence_hash, second.result.safe_pay.evidence_hash);
  assert.notEqual(first.result.receipt_binding_hash, second.result.receipt_binding_hash);
  assert.notEqual(first.result.receipt_id, second.result.receipt_id);
});

test('published dependency pins match the reviewed source contracts', () => {
  const safePayPackage = JSON.parse(readFileSync(new URL('../node_modules/anchor-x402-safe-pay/package.json', import.meta.url), 'utf8'));
  const harnessPackage = JSON.parse(readFileSync(new URL('../node_modules/agoragentic-harness-core/package.json', import.meta.url), 'utf8'));
  assert.equal(safePayPackage.version, '0.3.0');
  assert.equal(harnessPackage.version, '0.4.2');
});

async function oneShot({ verdict = ALLOW, unavailable = false } = {}) {
  const harness = makeHarness();
  const screening = countedScreen(verdict, { unavailable });
  const sending = countedSend();
  const result = await harness.governedSend({
    action: ACTION,
    mandate: MANDATE,
    approval: APPROVAL,
    screenRecipient: screening.handler,
    simulatedSend: sending.handler,
  });
  return { result, sends: sending.calls(), screens: screening.calls() };
}

function makeHarness(options = {}) {
  const harness = createAnchorSafePayHarness({
    enabled: true,
    ledger: new InMemorySafePayLedger(),
    fixtureNow: FIXED_NOW,
    sendTimeoutMs: 100,
    ...options,
  });
  return Object.freeze({
    ...harness,
    governedSend(input = {}) {
      return harness.governedSend({ ...input });
    },
  });
}

function countedScreen(verdict, { unavailable = false, fixtureDelayMs = 0 } = {}) {
  const screen = createFixtureSafePayScreenAdapter({ verdict, unavailable, fixtureDelayMs });
  return {
    handler: screen,
    calls() {
      return screen.fixtureCallCount();
    },
  };
}

function countedSend(options = {}) {
  const send = createFixtureSimulatedSend(
    options.outcome ?? 'simulated',
    options.fixtureDelayMs ?? 0,
  );
  return {
    handler: send,
    calls() {
      return send.fixtureCallCount();
    },
    lastBinding() {
      return send.lastBinding();
    },
  };
}

function makeApproval(action, overrides = {}, mandate = MANDATE) {
  const next = { ...APPROVAL, ...overrides };
  if (!Object.hasOwn(overrides, 'action_digest')) {
    next.action_digest = buildActionBinding(action).action_digest;
  }
  if (!Object.hasOwn(overrides, 'mandate_hash')) {
    next.mandate_hash = buildMandateBinding(mandate).mandate_hash;
  }
  return next;
}

function simulatedResult() {
  return {
    status: 'simulated',
    funds_moved: false,
    settlement_proven: false,
  };
}

function assertDecision(receipt, decision, reasonCode) {
  assert.equal(receipt.decision, decision);
  assert.equal(receipt.reason_code, reasonCode);
  assert.equal(receipt.funds_moved, false);
  assert.equal(receipt.settlement_proven, false);
}

function fixture(name) {
  return JSON.parse(readFileSync(new URL(`../fixtures/${name}`, import.meta.url), 'utf8'));
}
