import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import {
  InMemorySafePayLedger,
  buildActionBinding,
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
  assert.equal(binding.action_digest, APPROVAL.action_digest);
  assert.equal(binding.amount_atomic, '1000000');
  assert.match(binding.idempotency_key_hash, /^sha256:[a-f0-9]{64}$/);
  assert.equal(Object.hasOwn(binding, 'idempotency_key'), false);
});

test('the integration is default-off and invokes neither screening nor send', async () => {
  const harness = makeHarness({ enabled: false });
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

  assertDecision(result, 'deny', 'integration_disabled');
  assert.equal(screening.calls(), 0);
  assert.equal(sends, 0);
});

test('Safe Pay allow plus exact authority and approval executes once', async () => {
  const harness = makeHarness();
  const screening = countedScreen(ALLOW);
  let sends = 0;
  let callbackAction;

  const result = await harness.governedSend({
    action: ACTION,
    mandate: MANDATE,
    approval: APPROVAL,
    screenRecipient: screening.handler,
    simulatedSend: async (binding) => {
      sends += 1;
      callbackAction = binding;
      return simulatedResult();
    },
  });

  assertDecision(result, 'allow', 'allowed_simulated');
  assert.equal(screening.calls(), 1);
  assert.equal(sends, 1);
  assert.equal(callbackAction.action_digest, APPROVAL.action_digest);
  assert.equal(Object.hasOwn(callbackAction, 'idempotency_key'), false);
  assert.equal(result.owner_authority.owner_authority_verified, true);
  assert.equal(result.owner_authority.mandate_matched, true);
  assert.equal(result.approval.action_matched, true);
  assert.equal(result.approval.consumed, true);
  assert.equal(result.safe_pay.recommendation, 'allow');
  assert.equal(result.safe_pay.grants_payment_authority, false);
  assert.equal(result.execution.send_callback_invoked, true);
  assert.equal(result.execution.callback_status, 'simulated');
  assert.equal(result.funds_moved, false);
  assert.equal(result.settlement_proven, false);
});

test('missing principal authority denies before screening', async () => {
  const harness = makeHarness();
  const screening = countedScreen(ALLOW);
  let sends = 0;
  const result = await harness.governedSend({
    action: ACTION,
    mandate: { ...MANDATE, authority_granted: false },
    approval: APPROVAL,
    screenRecipient: screening.handler,
    simulatedSend: async () => {
      sends += 1;
      return simulatedResult();
    },
  });

  assertDecision(result, 'deny', 'principal_authority_missing');
  assert.equal(screening.calls(), 0);
  assert.equal(sends, 0);
});

test('malformed mandate fields return a bounded deny receipt', async () => {
  const screening = countedScreen(ALLOW);
  const result = await makeHarness().governedSend({
    action: ACTION,
    mandate: { ...MANDATE, principal_ref: '' },
    approval: APPROVAL,
    screenRecipient: screening.handler,
    simulatedSend: async () => simulatedResult(),
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
    simulatedSend: async () => simulatedResult(),
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

  assertDecision(result, 'deny', 'safe_pay_unavailable');
  assert.equal(screening.calls(), 1);
  assert.equal(sends, 0);
});

test('unknown Safe Pay recommendation fails closed', async () => {
  const verdict = { ...ALLOW, recommendation: 'pending' };
  const { result, sends } = await oneShot({ verdict });
  assertDecision(result, 'deny', 'safe_pay_unknown');
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
  let sends = 0;
  const result = await makeHarness().governedSend({
    action,
    mandate: MANDATE,
    approval,
    screenRecipient: screening.handler,
    simulatedSend: async () => {
      sends += 1;
      return simulatedResult();
    },
  });

  assertDecision(result, 'deny', 'per_action_limit_exceeded');
  assert.equal(screening.calls(), 0);
  assert.equal(sends, 0);
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
    let sends = 0;
    const result = await makeHarness().governedSend({
      action: ACTION,
      mandate: { ...MANDATE, [field]: Number.MAX_SAFE_INTEGER + 1 },
      approval: APPROVAL,
      screenRecipient: screening.handler,
      simulatedSend: async () => {
        sends += 1;
        return simulatedResult();
      },
    });

    assertDecision(result, 'deny', 'mandate_invalid');
    assert.equal(screening.calls(), 0);
    assert.equal(sends, 0);
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
    simulatedSend: async () => simulatedResult(),
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
  let secondSends = 0;
  const second = await harness.governedSend({
    action: secondAction,
    mandate: MANDATE,
    approval: secondApproval,
    screenRecipient: secondScreen.handler,
    simulatedSend: async () => {
      secondSends += 1;
      return simulatedResult();
    },
  });

  assertDecision(second, 'deny', 'cumulative_limit_exceeded');
  assert.equal(secondScreen.calls(), 0);
  assert.equal(secondSends, 0);
  assert.equal(harness.ledger.snapshot().cumulative_authorized_atomic, '1000000');
});

test('cumulative counters are isolated by asset and network budget scope', async () => {
  const harness = makeHarness();
  const first = await harness.governedSend({
    action: ACTION,
    mandate: MANDATE,
    approval: APPROVAL,
    screenRecipient: countedScreen(ALLOW).handler,
    simulatedSend: async () => simulatedResult(),
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
    simulatedSend: async () => simulatedResult(),
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
    let sends = 0;
    const result = await makeHarness().governedSend({
      action,
      mandate: MANDATE,
      approval: APPROVAL,
      screenRecipient: screening.handler,
      simulatedSend: async () => {
        sends += 1;
        return simulatedResult();
      },
    });

    assertDecision(result, 'deny', 'approval_action_mismatch');
    assert.equal(screening.calls(), 0);
    assert.equal(sends, 0);
  });
}

test('expired approval denies before screening', async () => {
  const screening = countedScreen(ALLOW);
  let sends = 0;
  const result = await makeHarness().governedSend({
    action: ACTION,
    mandate: MANDATE,
    approval: { ...APPROVAL, expires_at: FIXED_NOW },
    screenRecipient: screening.handler,
    simulatedSend: async () => {
      sends += 1;
      return simulatedResult();
    },
  });

  assertDecision(result, 'deny', 'approval_expired');
  assert.equal(screening.calls(), 0);
  assert.equal(sends, 0);
});

test('approval must come from the exact owner principal', async () => {
  const screening = countedScreen(ALLOW);
  const result = await makeHarness().governedSend({
    action: ACTION,
    mandate: MANDATE,
    approval: { ...APPROVAL, approved_by: 'owner:other' },
    screenRecipient: screening.handler,
    simulatedSend: async () => simulatedResult(),
  });

  assertDecision(result, 'deny', 'approval_principal_mismatch');
  assert.equal(screening.calls(), 0);
});

test('approval expiring during screening is denied before reservation or send', async () => {
  let clock = FIXED_NOW;
  const advancingVerdict = { ...ALLOW };
  Object.defineProperty(advancingVerdict, 'recommendation', {
    enumerable: true,
    get() {
      clock = '2030-01-01T00:20:00.000Z';
      return ALLOW.recommendation;
    },
  });
  const screening = countedScreen(advancingVerdict);
  const harness = makeHarness({ now: () => new Date(clock) });
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

  assertDecision(result, 'deny', 'approval_expired');
  assert.equal(result.generated_at, '2030-01-01T00:20:00.000Z');
  assert.equal(screening.calls(), 1);
  assert.equal(sends, 0);
  assert.equal(harness.ledger.snapshot().reservation_count, 0);
});

test('mandate expiring during screening is denied before reservation or send', async () => {
  let clock = FIXED_NOW;
  const advancingVerdict = { ...ALLOW };
  Object.defineProperty(advancingVerdict, 'recommendation', {
    enumerable: true,
    get() {
      clock = '2030-01-03T00:00:00.000Z';
      return ALLOW.recommendation;
    },
  });
  const screening = countedScreen(advancingVerdict);
  const harness = makeHarness({ now: () => new Date(clock) });
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

  assertDecision(result, 'deny', 'mandate_expired');
  assert.equal(screening.calls(), 1);
  assert.equal(sends, 0);
  assert.equal(harness.ledger.snapshot().reservation_count, 0);
});

test('duplicate idempotency key never screens or sends twice', async () => {
  const harness = makeHarness();
  for (const property of [
    'recordsByIdempotency',
    'recordsByApproval',
    'recordsByReservation',
    'cumulativeAuthorizedByScope',
  ]) {
    assert.equal(harness.ledger[property], undefined);
    harness.ledger[property] = new Map();
  }
  const screening = countedScreen(ALLOW);
  let sends = 0;
  const input = {
    action: ACTION,
    mandate: MANDATE,
    approval: APPROVAL,
    screenRecipient: screening.handler,
    simulatedSend: async () => {
      sends += 1;
      return simulatedResult();
    },
  };

  const first = await harness.governedSend(input);
  const second = await harness.governedSend(input);
  assertDecision(first, 'allow', 'allowed_simulated');
  assertDecision(second, 'deny', 'duplicate_idempotency');
  assert.equal(second.execution.duplicate_of_receipt_id, first.receipt_id);
  assert.equal(screening.calls(), 1);
  assert.equal(sends, 1);
});

test('same idempotency key with a changed action is denied as a binding mismatch', async () => {
  const harness = makeHarness();
  await harness.governedSend({
    action: ACTION,
    mandate: MANDATE,
    approval: APPROVAL,
    screenRecipient: countedScreen(ALLOW).handler,
    simulatedSend: async () => simulatedResult(),
  });

  const changed = { ...ACTION, amount_atomic: '1100000' };
  const changedApproval = makeApproval(changed, { approval_ref: 'approval:changed-same-key' });
  const screen = countedScreen({ ...ALLOW, wallet: changed.recipient });
  const result = await harness.governedSend({
    action: changed,
    mandate: MANDATE,
    approval: changedApproval,
    screenRecipient: screen.handler,
    simulatedSend: async () => simulatedResult(),
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
    simulatedSend: async () => simulatedResult(),
  });

  const secondAction = { ...ACTION, idempotency_key: 'fixture-approval-replay-0002' };
  const secondScreen = countedScreen(ALLOW);
  let sends = 0;
  const replay = await harness.governedSend({
    action: secondAction,
    mandate: MANDATE,
    approval: makeApproval(secondAction, { approval_ref: APPROVAL.approval_ref }),
    screenRecipient: secondScreen.handler,
    simulatedSend: async () => {
      sends += 1;
      return simulatedResult();
    },
  });

  assertDecision(replay, 'deny', 'approval_replay');
  assert.equal(secondScreen.calls(), 0);
  assert.equal(sends, 0);
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
  let sends = 0;
  const input = {
    action: ACTION,
    mandate: MANDATE,
    approval: APPROVAL,
    screenRecipient: screening.handler,
    simulatedSend: async () => {
      sends += 1;
      throw new Error('fixture ambiguity');
    },
  };

  const ambiguous = await harness.governedSend(input);
  const replay = await harness.governedSend(input);
  assertDecision(ambiguous, 'ask', 'send_ambiguous');
  assert.equal(ambiguous.execution.callback_status, 'ambiguous');
  assert.equal(ambiguous.execution.automatic_retry_allowed, false);
  assertDecision(replay, 'deny', 'duplicate_idempotency');
  assert.equal(screening.calls(), 1);
  assert.equal(sends, 1);
  assert.equal(harness.ledger.snapshot().cumulative_authorized_atomic, '1000000');
});

test('timed-out simulated callback is ambiguous and keeps its reservation', async () => {
  const harness = makeHarness({ sendTimeoutMs: 10 });
  const result = await harness.governedSend({
    action: ACTION,
    mandate: MANDATE,
    approval: APPROVAL,
    screenRecipient: countedScreen(ALLOW).handler,
    simulatedSend: async () => {
      await new Promise(resolve => setTimeout(resolve, 30));
      return simulatedResult();
    },
  });

  assertDecision(result, 'ask', 'send_ambiguous');
  assert.equal(result.execution.callback_status, 'ambiguous');
  assert.equal(result.budget.reservation_retained, true);
});

test('non-simulation callback result is ambiguous and keeps its reservation', async () => {
  const result = await makeHarness().governedSend({
    action: ACTION,
    mandate: MANDATE,
    approval: APPROVAL,
    screenRecipient: countedScreen(ALLOW).handler,
    simulatedSend: async () => ({ status: 'sent', funds_moved: true }),
  });

  assertDecision(result, 'ask', 'send_ambiguous');
  assert.equal(result.execution.callback_status, 'ambiguous');
  assert.equal(result.budget.reservation_retained, true);
});

test('two concurrent attempts cannot consume one approval twice', async () => {
  const harness = makeHarness();
  const screening = countedScreen(ALLOW);
  let sends = 0;
  let releaseFirst;
  const firstSend = new Promise(resolve => {
    releaseFirst = resolve;
  });
  const input = {
    action: ACTION,
    mandate: MANDATE,
    approval: APPROVAL,
    screenRecipient: screening.handler,
    simulatedSend: async () => {
      sends += 1;
      await firstSend;
      return simulatedResult();
    },
  };

  const firstPromise = harness.governedSend(input);
  await new Promise(resolve => setImmediate(resolve));
  const second = await harness.governedSend(input);
  releaseFirst();
  const first = await firstPromise;

  assertDecision(first, 'allow', 'allowed_simulated');
  assertDecision(second, 'deny', 'duplicate_idempotency');
  assert.equal(sends, 1);
});

test('two distinct concurrent actions cannot oversubscribe one cumulative scope', async () => {
  const harness = makeHarness();
  let sends = 0;
  const actions = ['a', 'b'].map((suffix, index) => ({
    ...ACTION,
    amount_atomic: '1100000',
    idempotency_key: `fixture-concurrent-budget-${suffix}`,
    proposed_at: `2029-12-31T23:59:${10 + index}.000Z`,
  }));
  const attempts = actions.map((action, index) => harness.governedSend({
    action,
    mandate: MANDATE,
    approval: makeApproval(action, { approval_ref: `approval:concurrent-budget-${index}` }),
    screenRecipient: countedScreen(ALLOW).handler,
    simulatedSend: async () => {
      sends += 1;
      await new Promise(resolve => setImmediate(resolve));
      return simulatedResult();
    },
  }));

  const results = await Promise.all(attempts);
  assert.deepEqual(
    results.map(result => `${result.decision}:${result.reason_code}`).sort(),
    ['allow:allowed_simulated', 'deny:cumulative_limit_exceeded'],
  );
  assert.equal(sends, 1);
  const allowed = results.find(result => result.decision === 'allow');
  assert.equal(
    harness.ledger.snapshot(allowed.budget.budget_scope_hash).cumulative_authorized_atomic,
    '1100000',
  );
});

test('non-fixture transport evidence is rejected before send', async () => {
  const harness = makeHarness();
  let screens = 0;
  let sends = 0;
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
    simulatedSend: async () => {
      sends += 1;
      return simulatedResult();
    },
  });

  assertDecision(result, 'deny', 'unsafe_screen_adapter');
  assert.equal(screens, 0);
  assert.equal(sends, 0);
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

test('an unmarked callback is rejected before screening or invocation', async () => {
  const harness = createAnchorSafePayHarness({
    enabled: true,
    now: () => new Date(FIXED_NOW),
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
  return { result, sends, screens: screening.calls() };
}

function makeHarness(options = {}) {
  const harness = createAnchorSafePayHarness({
    enabled: true,
    ledger: new InMemorySafePayLedger(),
    now: () => new Date(FIXED_NOW),
    sendTimeoutMs: 100,
    ...options,
  });
  return Object.freeze({
    ...harness,
    governedSend(input = {}) {
      const simulatedSend = typeof input.simulatedSend === 'function'
        ? createFixtureSimulatedSend(input.simulatedSend)
        : input.simulatedSend;
      return harness.governedSend({ ...input, simulatedSend });
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

function makeApproval(action, overrides = {}) {
  const next = { ...APPROVAL, ...overrides };
  if (!Object.hasOwn(overrides, 'action_digest')) {
    next.action_digest = buildActionBinding(action).action_digest;
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
