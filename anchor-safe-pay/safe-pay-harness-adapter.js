import {
  authorityBoundary,
  sanitizeForPublicEvidence,
} from 'agoragentic-harness-core';
import {
  stableHash,
  stableId,
} from 'agoragentic-harness-core/kernel/events';
import { screenAllows as safePayScreenAllows } from 'anchor-x402-safe-pay';

export const ANCHOR_SAFE_PAY_ADAPTER_VERSION = '0.1.0-alpha.0';
export const SAFE_PAY_UPSTREAM_VERSION = '0.3.0';
export const HARNESS_CORE_VERSION = '0.4.2';
export const FIXTURE_SCREEN_MODE = 'fixture_no_network_no_spend';

const ACTION_SCHEMA = 'agoragentic.anchor-safe-pay.action-binding.v1';
const RECEIPT_SCHEMA = 'agoragentic.anchor-safe-pay.local-receipt.v1';
const CALLER_DECLARED_AUTHORITY = 'caller_declared_unverified_fixture';
const VALID_RECOMMENDATIONS = new Set(['allow', 'review', 'block']);
const SHA256_PATTERN = /^sha256:[a-f0-9]{64}$/;
const EVM_ADDRESS_PATTERN = /^0x[a-fA-F0-9]{40}$/;
const DEFAULT_VERDICT_MAX_AGE_MS = 5 * 60 * 1000;
const DEFAULT_FUTURE_SKEW_MS = 30 * 1000;
const DEFAULT_SCREEN_TIMEOUT_MS = 1000;
const DEFAULT_SEND_TIMEOUT_MS = 1000;
const MAX_UINT256 = (1n << 256n) - 1n;
const REFLECT_APPLY = Reflect.apply;
const WEAK_SET_ADD = WeakSet.prototype.add;
const WEAK_SET_HAS = WeakSet.prototype.has;
const OBJECT_GET_PROTOTYPE_OF = Object.getPrototypeOf;
const OBJECT_FREEZE = Object.freeze;
const OBJECT_HAS_OWN = Object.hasOwn;
const OBJECT_IS_FROZEN = Object.isFrozen;
const OBJECT_VALUES = Object.values;
const FIXTURE_SCREEN_ADAPTERS = new WeakSet();
const FIXTURE_SEND_ADAPTERS = new WeakSet();
const LEDGER_INSTANCES = new WeakSet();
const LEDGER_CAPABILITY = OBJECT_FREEZE({});

export class SafePayHarnessInputError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'SafePayHarnessInputError';
    this.code = code;
  }
}

/**
 * Process-local demonstration ledger. It proves the state-machine behavior in
 * one process; it is not a durable or multi-process production ledger.
 */
export class InMemorySafePayLedger {
  #recordsByIdempotency;
  #recordsByApproval;
  #recordsByReservation;
  #cumulativeAuthorizedByScope;
  #mandateHashesByRef;

  constructor() {
    this.#recordsByIdempotency = new Map();
    this.#recordsByApproval = new Map();
    this.#recordsByReservation = new Map();
    this.#cumulativeAuthorizedByScope = new Map();
    this.#mandateHashesByRef = new Map();
    REFLECT_APPLY(WEAK_SET_ADD, LEDGER_INSTANCES, [this]);
  }

  snapshot(budgetScopeHash = null) {
    const requestedScope = budgetScopeHash === null
      ? null
      : normalizeHash(budgetScopeHash, 'budget_scope_hash');
    const soleScope = requestedScope === null && this.#cumulativeAuthorizedByScope.size === 1
      ? this.#cumulativeAuthorizedByScope.keys().next().value
      : null;
    const selectedScope = requestedScope || soleScope;
    return OBJECT_FREEZE({
      budget_scope_hash: selectedScope || null,
      cumulative_authorized_atomic: selectedScope
        ? this.#cumulativeForScope(selectedScope).toString()
        : null,
      budget_scope_count: this.#cumulativeAuthorizedByScope.size,
      reservation_count: this.#recordsByReservation.size,
      mandate_binding_count: this.#mandateHashesByRef.size,
    });
  }

  preflight(input, capability) {
    this.#assertCapability(capability);
    return this.#evaluate(input);
  }

  reserve(input, capability) {
    this.#assertCapability(capability);
    const evaluation = this.#evaluate(input);
    if (!evaluation.ok) return evaluation;

    const amount = parseAtomic(input.amount_atomic, 'amount_atomic');
    const budgetScopeHash = normalizeHash(input.budget_scope_hash, 'budget_scope_hash');
    const mandateRef = requiredString(input.mandate_ref, 'mandate_ref');
    const mandateHash = normalizeHash(input.mandate_hash, 'mandate_hash');
    const cumulativeBefore = this.#cumulativeForScope(budgetScopeHash);
    const cumulativeAfter = cumulativeBefore + amount;
    const reservationId = stableId('asp_reservation', {
      action_digest: input.action_digest,
      approval_ref: input.approval_ref,
      idempotency_key_hash: input.idempotency_key_hash,
      budget_scope_hash: budgetScopeHash,
      mandate_ref: mandateRef,
      mandate_hash: mandateHash,
    });
    const record = {
      reservation_id: reservationId,
      action_digest: input.action_digest,
      approval_ref: input.approval_ref,
      idempotency_key_hash: input.idempotency_key_hash,
      mandate_ref: mandateRef,
      mandate_hash: mandateHash,
      amount_atomic: amount.toString(),
      cumulative_before_atomic: cumulativeBefore.toString(),
      cumulative_after_atomic: cumulativeAfter.toString(),
      status: 'reserved',
      receipt_id: null,
    };

    this.#cumulativeAuthorizedByScope.set(budgetScopeHash, cumulativeAfter);
    this.#recordsByIdempotency.set(input.idempotency_key_hash, record);
    this.#recordsByApproval.set(input.approval_ref, record);
    this.#recordsByReservation.set(reservationId, record);
    this.#mandateHashesByRef.set(mandateRef, mandateHash);

    return {
      ok: true,
      reservation_id: reservationId,
      cumulative_before_atomic: cumulativeBefore.toString(),
      cumulative_after_atomic: cumulativeAfter.toString(),
    };
  }

  finalize(reservationId, receiptId, decision, capability) {
    this.#assertCapability(capability);
    const record = this.#recordsByReservation.get(reservationId);
    if (!record) throw new SafePayHarnessInputError('reservation_missing', 'The local reservation does not exist.');
    if (record.status !== 'reserved') {
      throw new SafePayHarnessInputError('reservation_finalized', 'The local reservation was already finalized.');
    }
    record.status = decision === 'allow' ? 'simulated' : 'ambiguous';
    record.receipt_id = requiredString(receiptId, 'receipt_id');
    return record;
  }

  #evaluate(input) {
    const budgetScopeHash = normalizeHash(input.budget_scope_hash, 'budget_scope_hash');
    const mandateRef = requiredString(input.mandate_ref, 'mandate_ref');
    const mandateHash = normalizeHash(input.mandate_hash, 'mandate_hash');
    const pinnedMandateHash = this.#mandateHashesByRef.get(mandateRef);
    if (pinnedMandateHash && pinnedMandateHash !== mandateHash) {
      return {
        ok: false,
        code: 'mandate_definition_mismatch',
        mandate_ref: mandateRef,
        expected_mandate_hash: pinnedMandateHash,
      };
    }
    const existingIdempotency = this.#recordsByIdempotency.get(input.idempotency_key_hash);
    if (existingIdempotency) {
      if (existingIdempotency.action_digest !== input.action_digest) {
        return {
          ok: false,
          code: 'idempotency_binding_mismatch',
          previous_receipt_id: existingIdempotency.receipt_id || null,
        };
      }
      return {
        ok: false,
        code: 'duplicate_idempotency',
        previous_receipt_id: existingIdempotency.receipt_id || null,
      };
    }

    const existingApproval = this.#recordsByApproval.get(input.approval_ref);
    if (existingApproval) {
      return {
        ok: false,
        code: 'approval_replay',
        previous_receipt_id: existingApproval.receipt_id || null,
      };
    }

    const amount = parseAtomic(input.amount_atomic, 'amount_atomic');
    const cumulativeLimit = parseAtomic(input.cumulative_limit_atomic, 'cumulative_limit_atomic');
    const cumulativeAuthorized = this.#cumulativeForScope(budgetScopeHash);
    if (cumulativeAuthorized + amount > cumulativeLimit) {
      return {
        ok: false,
        code: 'cumulative_limit_exceeded',
        budget_scope_hash: budgetScopeHash,
        cumulative_before_atomic: cumulativeAuthorized.toString(),
        attempted_cumulative_atomic: (cumulativeAuthorized + amount).toString(),
        cumulative_limit_atomic: cumulativeLimit.toString(),
      };
    }

    return {
      ok: true,
      budget_scope_hash: budgetScopeHash,
      cumulative_before_atomic: cumulativeAuthorized.toString(),
      cumulative_after_atomic: (cumulativeAuthorized + amount).toString(),
    };
  }

  #cumulativeForScope(budgetScopeHash) {
    return this.#cumulativeAuthorizedByScope.get(budgetScopeHash) || 0n;
  }

  #assertCapability(capability) {
    if (capability !== LEDGER_CAPABILITY) {
      throw new SafePayHarnessInputError(
        'ledger_operation_unauthorized',
        'Ledger mutation and preflight operations are private to the governed harness.',
      );
    }
  }
}

// Governed execution calls the reviewed class implementation directly. A
// caller may retain the supplied ledger, call or replace public methods, or
// replace WeakSet prototype methods after importing this module. Captured
// intrinsics plus a private capability keep those actions from becoming
// execution hooks or fabricating governed reservation/receipt evidence.
const LEDGER_SNAPSHOT = InMemorySafePayLedger.prototype.snapshot;
const LEDGER_PREFLIGHT = InMemorySafePayLedger.prototype.preflight;
const LEDGER_RESERVE = InMemorySafePayLedger.prototype.reserve;
const LEDGER_FINALIZE = InMemorySafePayLedger.prototype.finalize;

/**
 * Exercise Safe Pay's public screenAllows contract with an in-memory response.
 * The helper owns the fake fetch and exposes no endpoint or transport option,
 * so this reference cannot accidentally perform the paid production screen.
 */
export function createFixtureSafePayScreenAdapter(options = {}) {
  if (!isPlainObject(options)) {
    throw new SafePayHarnessInputError('fixture_options_invalid', 'Fixture screen options must be an object.');
  }
  if (OBJECT_HAS_OWN(options, 'screenAllows')) {
    throw new SafePayHarnessInputError(
      'screen_allows_not_injectable',
      'The fixture adapter is closed over the pinned Safe Pay export; screenAllows cannot be injected.',
    );
  }
  const { verdict = null, unavailable = false, fixtureDelayMs = 0 } = options;
  if (!Number.isSafeInteger(fixtureDelayMs) || fixtureDelayMs < 0 || fixtureDelayMs > 10_000) {
    throw new SafePayHarnessInputError(
      'fixture_delay_invalid',
      'fixtureDelayMs must be an integer between 0 and 10000.',
    );
  }
  if (!unavailable && !isPlainObject(verdict)) {
    throw new SafePayHarnessInputError('fixture_verdict_required', 'A fixture verdict object is required.');
  }
  // Observe caller-owned fixture data at construction time. The registered
  // screen function closes only over plain JSON and never reaches back into a
  // caller object (including getters) while a governed run is in flight.
  const fixtureVerdict = unavailable ? null : cloneJson(verdict);

  let fixtureCallCount = 0;
  const fixtureScreen = async ({ recipient }) => {
    fixtureCallCount += 1;
    let fixtureFetchCalls = 0;
    const fixtureFetch = async (_url, init = {}) => {
      fixtureFetchCalls += 1;
      if (fixtureDelayMs > 0) {
        await new Promise(resolve => setTimeout(resolve, fixtureDelayMs));
      }
      if (unavailable) throw new Error('fixture_screen_unavailable');
      const body = JSON.parse(String(init.body || '{}'));
      if (normalizeRecipient(body.wallet) !== normalizeRecipient(recipient)) {
        throw new Error('fixture_recipient_mismatch');
      }
      return {
        ok: true,
        status: 200,
        async json() {
          return cloneJson(fixtureVerdict);
        },
      };
    };

    const upstreamDecision = await safePayScreenAllows(recipient, {
      fetchImpl: fixtureFetch,
      blockOn: ['block', 'review'],
      onError: 'block',
    });
    if (fixtureFetchCalls !== 1) {
      throw new SafePayHarnessInputError(
        'fixture_fetch_not_used_exactly_once',
        'The pinned Safe Pay screen must use the internal fixture fetch exactly once.',
      );
    }

    return {
      mode: FIXTURE_SCREEN_MODE,
      fixture_fetch_calls: fixtureFetchCalls,
      network_calls: 0,
      paid_provider_calls: 0,
      production_endpoint_called: false,
      upstream_ok: upstreamDecision?.ok === true,
      verdict: cloneJson(upstreamDecision?.verdict),
    };
  };
  REFLECT_APPLY(WEAK_SET_ADD, FIXTURE_SCREEN_ADAPTERS, [fixtureScreen]);
  Object.defineProperty(fixtureScreen, 'fixtureCallCount', { value: () => fixtureCallCount });
  return fixtureScreen;
}

/**
 * Create an adapter-owned inert simulator. It never invokes caller code, a
 * wallet, a provider, or a transport. Bounded fixture outcomes exist only to
 * exercise local timeout and ambiguity branches in hermetic tests.
 */
export function createFixtureSimulatedSend(outcome = 'simulated', fixtureDelayMs = 0) {
  if (typeof outcome !== 'string') {
    throw new SafePayHarnessInputError(
      'simulated_send_options_invalid',
      'The inert simulator accepts only a primitive outcome string and delay number.',
    );
  }
  if (!Number.isSafeInteger(fixtureDelayMs) || fixtureDelayMs < 0 || fixtureDelayMs > 10_000) {
    throw new SafePayHarnessInputError(
      'fixture_delay_invalid',
      'fixtureDelayMs must be an integer between 0 and 10000.',
    );
  }
  if (!['simulated', 'throw', 'invalid'].includes(outcome)) {
    throw new SafePayHarnessInputError(
      'fixture_outcome_invalid',
      'outcome must be simulated, throw, or invalid.',
    );
  }

  let fixtureCallCount = 0;
  let lastBinding = null;
  const fixtureSend = async binding => {
    fixtureCallCount += 1;
    lastBinding = cloneJson(binding);
    if (fixtureDelayMs > 0) {
      await new Promise(resolve => setTimeout(resolve, fixtureDelayMs));
    }
    if (outcome === 'throw') throw new Error('fixture_send_ambiguous');
    if (outcome === 'invalid') {
      return { status: 'invalid', funds_moved: false, settlement_proven: false };
    }
    return { status: 'simulated', funds_moved: false, settlement_proven: false };
  };
  REFLECT_APPLY(WEAK_SET_ADD, FIXTURE_SEND_ADAPTERS, [fixtureSend]);
  Object.defineProperty(fixtureSend, 'fixtureCallCount', { value: () => fixtureCallCount });
  Object.defineProperty(fixtureSend, 'lastBinding', {
    value: () => (lastBinding === null ? null : cloneJson(lastBinding)),
  });
  return fixtureSend;
}

export function buildActionBinding(action = {}) {
  const proposedAt = normalizeTimestamp(action.proposed_at, 'proposed_at');
  const normalized = {
    schema: ACTION_SCHEMA,
    action: requiredExact(action.action, 'x402_payment_send', 'action'),
    principal_ref: requiredString(action.principal_ref, 'principal_ref'),
    agent_ref: requiredString(action.agent_ref, 'agent_ref'),
    recipient: normalizeRecipient(requiredString(action.recipient, 'recipient')),
    amount_atomic: parseAtomic(action.amount_atomic, 'amount_atomic').toString(),
    asset: requiredString(action.asset, 'asset').toUpperCase(),
    network: requiredString(action.network, 'network').toLowerCase(),
    task_hash: normalizeHash(action.task_hash, 'task_hash'),
    quote_hash: normalizeHash(action.quote_hash, 'quote_hash'),
    idempotency_key_hash: stableHash({
      schema: 'agoragentic.anchor-safe-pay.idempotency-key.v1',
      value: requiredString(action.idempotency_key, 'idempotency_key'),
    }),
    proposed_at: proposedAt,
  };

  return OBJECT_FREEZE({
    ...normalized,
    action_digest: stableHash(normalized),
  });
}

/**
 * Canonicalize a caller-declared fixture mandate and bind all of its policy
 * content. This computes integrity metadata only; it does not authenticate the
 * caller, verify an owner signature, or promote the declaration to authority.
 */
export function buildMandateBinding(mandate = {}) {
  if (!isPlainObject(mandate) || mandate.authority_granted !== true) {
    throw new SafePayHarnessInputError(
      'principal_authority_missing',
      'The fixture mandate must contain an explicit caller authority declaration.',
    );
  }

  const perActionLimit = parseAtomic(mandate.per_action_limit_atomic, 'per_action_limit_atomic');
  const cumulativeLimit = parseAtomic(mandate.cumulative_limit_atomic, 'cumulative_limit_atomic');
  const normalized = {
    schema: 'agoragentic.anchor-safe-pay.owner-mandate-binding.v1',
    mandate_ref: requiredString(mandate.mandate_ref, 'mandate_ref'),
    principal_ref: requiredString(mandate.principal_ref, 'mandate.principal_ref'),
    agent_ref: requiredString(mandate.agent_ref, 'mandate.agent_ref'),
    authority_granted: true,
    authority_assertion: CALLER_DECLARED_AUTHORITY,
    authority_evidence: requiredString(mandate.authority_evidence, 'mandate.authority_evidence'),
    allowed_actions: normalizeStringSet(mandate.allowed_actions, value => value),
    allowed_recipients: normalizeStringSet(mandate.allowed_recipients, normalizeRecipient),
    allowed_assets: normalizeStringSet(mandate.allowed_assets, value => value.toUpperCase()),
    allowed_networks: normalizeStringSet(mandate.allowed_networks, value => value.toLowerCase()),
    per_action_limit_atomic: perActionLimit.toString(),
    cumulative_limit_atomic: cumulativeLimit.toString(),
    approval_required: mandate.approval_required === true,
    issued_at: normalizeTimestamp(mandate.issued_at, 'mandate.issued_at'),
    expires_at: normalizeTimestamp(mandate.expires_at, 'mandate.expires_at'),
  };

  return OBJECT_FREEZE({
    ...normalized,
    mandate_hash: stableHash(normalized),
  });
}

export function createAnchorSafePayHarness({
  enabled = false,
  ledger = new InMemorySafePayLedger(),
  now = undefined,
  fixtureNow = null,
  fixtureChallengeNow = null,
  verdictMaxAgeMs = DEFAULT_VERDICT_MAX_AGE_MS,
  maxFutureSkewMs = DEFAULT_FUTURE_SKEW_MS,
  screenTimeoutMs = DEFAULT_SCREEN_TIMEOUT_MS,
  sendTimeoutMs = DEFAULT_SEND_TIMEOUT_MS,
} = {}) {
  if (
    !REFLECT_APPLY(WEAK_SET_HAS, LEDGER_INSTANCES, [ledger])
    || OBJECT_GET_PROTOTYPE_OF(ledger) !== InMemorySafePayLedger.prototype
  ) {
    throw new SafePayHarnessInputError(
      'ledger_invalid',
      'ledger must be a direct, module-branded InMemorySafePayLedger instance.',
    );
  }
  if (now !== undefined) {
    throw new SafePayHarnessInputError(
      'fixture_clock_callback_unsupported',
      'Caller clock callbacks are not accepted; use primitive fixtureNow data.',
    );
  }
  assertPositiveInteger(verdictMaxAgeMs, 'verdictMaxAgeMs');
  assertPositiveInteger(maxFutureSkewMs, 'maxFutureSkewMs');
  assertPositiveInteger(screenTimeoutMs, 'screenTimeoutMs');
  assertPositiveInteger(sendTimeoutMs, 'sendTimeoutMs');
  const fixtureInitialTime = fixtureNow === null
    ? null
    : normalizeTimestamp(fixtureNow, 'fixtureNow');
  if (fixtureChallengeNow !== null && fixtureInitialTime === null) {
    throw new SafePayHarnessInputError(
      'fixture_clock_invalid',
      'fixtureChallengeNow requires fixtureNow.',
    );
  }
  const fixtureChallengeTime = fixtureChallengeNow === null
    ? fixtureInitialTime
    : normalizeTimestamp(fixtureChallengeNow, 'fixtureChallengeNow');
  if (
    fixtureInitialTime !== null
    && Date.parse(fixtureChallengeTime) < Date.parse(fixtureInitialTime)
  ) {
    throw new SafePayHarnessInputError(
      'fixture_clock_invalid',
      'fixtureChallengeNow must not be earlier than fixtureNow.',
    );
  }

  async function governedSend({
    action,
    mandate,
    approval,
    screenRecipient,
    simulatedSend,
  } = {}) {
    const generatedAt = currentTime(fixtureInitialTime);
    const binding = buildActionBinding(action);
    const base = {
      generatedAt,
      binding,
      ledger,
      mandateEvidence: null,
      approvalEvidence: null,
      safePayEvidence: noSafePayEvidence(binding),
      callbackInvoked: false,
      callbackStatus: 'not_invoked',
      approvalConsumed: false,
      reservation: null,
    };

    if (enabled !== true) return receipt(base, 'deny', 'integration_disabled');
    if (typeof screenRecipient !== 'function') {
      return receipt(base, 'deny', 'safe_pay_screen_missing');
    }
    if (!REFLECT_APPLY(WEAK_SET_HAS, FIXTURE_SCREEN_ADAPTERS, [screenRecipient])) {
      return receipt(base, 'deny', 'unsafe_screen_adapter');
    }
    if (typeof simulatedSend !== 'function') {
      return receipt(base, 'deny', 'simulated_send_missing');
    }
    if (!REFLECT_APPLY(WEAK_SET_HAS, FIXTURE_SEND_ADAPTERS, [simulatedSend])) {
      return receipt(base, 'deny', 'unsafe_simulated_send_adapter');
    }
    if (Date.parse(binding.proposed_at) > generatedAt.ms + maxFutureSkewMs) {
      return receipt(base, 'deny', 'action_not_yet_valid');
    }

    let mandateResult = evaluateMandate(mandate, binding, generatedAt.ms, maxFutureSkewMs);
    base.mandateEvidence = mandateResult.evidence;
    if (!mandateResult.ok) return receipt(base, 'deny', mandateResult.code);

    let approvalResult = evaluateApproval(
      approval,
      binding,
      mandateResult.evidence,
      generatedAt.ms,
      maxFutureSkewMs,
    );
    base.approvalEvidence = approvalResult.evidence;
    if (!approvalResult.ok) return receipt(base, 'deny', approvalResult.code);
    const mandateSnapshot = mandateResult.normalizedMandate;
    const approvalSnapshot = approvalResult.normalizedApproval;

    const amount = parseAtomic(binding.amount_atomic, 'amount_atomic');
    if (amount > mandateResult.perActionLimit) {
      return receipt(base, 'deny', 'per_action_limit_exceeded');
    }

    let reservationInput = {
      action_digest: binding.action_digest,
      approval_ref: approvalResult.evidence.approval_ref,
      idempotency_key_hash: binding.idempotency_key_hash,
      budget_scope_hash: mandateResult.evidence.budget_scope_hash,
      mandate_ref: mandateResult.evidence.mandate_ref,
      mandate_hash: mandateResult.evidence.mandate_hash,
      amount_atomic: binding.amount_atomic,
      cumulative_limit_atomic: mandateResult.cumulativeLimit.toString(),
    };
    const preflight = REFLECT_APPLY(LEDGER_PREFLIGHT, ledger, [reservationInput, LEDGER_CAPABILITY]);
    if (!preflight.ok) {
      return receipt({ ...base, duplicateOfReceiptId: preflight.previous_receipt_id || null }, 'deny', preflight.code);
    }

    let envelope;
    try {
      envelope = await withTimeout(
        Promise.resolve().then(() => screenRecipient({
          recipient: binding.recipient,
          amount_atomic: binding.amount_atomic,
          asset: binding.asset,
          network: binding.network,
          action_digest: binding.action_digest,
        })),
        screenTimeoutMs,
      );
    } catch {
      base.safePayEvidence = unavailableSafePayEvidence(binding);
      return receipt(base, 'deny', 'safe_pay_unavailable');
    }

    if (!isFixtureEnvelope(envelope)) {
      base.safePayEvidence = unsafeTransportEvidence(binding);
      return receipt(base, 'deny', 'unsafe_screen_transport');
    }

    const verdictResult = normalizeSafePayVerdict(
      envelope.verdict,
      binding,
      envelope.upstream_ok,
    );
    base.safePayEvidence = verdictResult.evidence;
    if (!verdictResult.ok) return receipt(base, 'deny', verdictResult.code);

    // Screening is asynchronous. Re-sample the clock and re-evaluate every
    // expiring authority immediately before the atomic reservation/callback.
    // The final receipt timestamp reflects this challenge-time decision.
    const challengeTime = currentTime(fixtureChallengeTime);
    if (challengeTime.ms < generatedAt.ms) {
      return receipt(base, 'deny', 'clock_moved_backward');
    }
    base.generatedAt = challengeTime;
    mandateResult = evaluateMandate(
      mandateSnapshot,
      binding,
      challengeTime.ms,
      maxFutureSkewMs,
    );
    base.mandateEvidence = mandateResult.evidence;
    if (!mandateResult.ok) return receipt(base, 'deny', mandateResult.code);
    approvalResult = evaluateApproval(
      approvalSnapshot,
      binding,
      mandateResult.evidence,
      challengeTime.ms,
      maxFutureSkewMs,
    );
    base.approvalEvidence = approvalResult.evidence;
    if (!approvalResult.ok) return receipt(base, 'deny', approvalResult.code);
    if (amount > mandateResult.perActionLimit) {
      return receipt(base, 'deny', 'per_action_limit_exceeded');
    }
    reservationInput = {
      ...reservationInput,
      approval_ref: approvalResult.evidence.approval_ref,
      budget_scope_hash: mandateResult.evidence.budget_scope_hash,
      mandate_ref: mandateResult.evidence.mandate_ref,
      mandate_hash: mandateResult.evidence.mandate_hash,
      cumulative_limit_atomic: mandateResult.cumulativeLimit.toString(),
    };

    const checkedAtMs = parseSafePayCheckedAt(verdictResult.verdict.checked_at);
    if (checkedAtMs === null) return receipt(base, 'deny', 'safe_pay_unknown');
    base.safePayEvidence.checked_at = new Date(checkedAtMs).toISOString();
    if (checkedAtMs > challengeTime.ms + maxFutureSkewMs) {
      return receipt(base, 'deny', 'safe_pay_verdict_future');
    }
    if (challengeTime.ms - checkedAtMs > verdictMaxAgeMs) {
      return receipt(base, 'deny', 'safe_pay_verdict_stale');
    }

    if (verdictResult.verdict.recommendation === 'block') {
      return receipt(base, 'deny', 'safe_pay_block');
    }
    if (verdictResult.verdict.recommendation === 'review') {
      return receipt(base, 'ask', 'safe_pay_review');
    }
    if (verdictResult.verdict.partial === true) {
      return receipt(base, 'ask', 'safe_pay_partial');
    }

    const reservation = REFLECT_APPLY(LEDGER_RESERVE, ledger, [reservationInput, LEDGER_CAPABILITY]);
    if (!reservation.ok) {
      return receipt({ ...base, duplicateOfReceiptId: reservation.previous_receipt_id || null }, 'deny', reservation.code);
    }
    base.reservation = reservation;
    base.approvalConsumed = true;
    base.callbackInvoked = true;

    let callbackResult;
    try {
      callbackResult = await withTimeout(
        Promise.resolve(simulatedSend(OBJECT_FREEZE({ ...binding }))),
        sendTimeoutMs,
      );
    } catch {
      base.callbackStatus = 'ambiguous';
      const ambiguousReceipt = receipt(base, 'ask', 'send_ambiguous');
      REFLECT_APPLY(LEDGER_FINALIZE, ledger, [
        reservation.reservation_id,
        ambiguousReceipt.receipt_id,
        ambiguousReceipt.decision,
        LEDGER_CAPABILITY,
      ]);
      return ambiguousReceipt;
    }

    if (!isValidSimulationResult(callbackResult)) {
      base.callbackStatus = 'ambiguous';
      const ambiguousReceipt = receipt(base, 'ask', 'send_ambiguous');
      REFLECT_APPLY(LEDGER_FINALIZE, ledger, [
        reservation.reservation_id,
        ambiguousReceipt.receipt_id,
        ambiguousReceipt.decision,
        LEDGER_CAPABILITY,
      ]);
      return ambiguousReceipt;
    }

    base.callbackStatus = 'simulated';
    const allowedReceipt = receipt(base, 'allow', 'allowed_simulated');
    REFLECT_APPLY(LEDGER_FINALIZE, ledger, [
      reservation.reservation_id,
      allowedReceipt.receipt_id,
      allowedReceipt.decision,
      LEDGER_CAPABILITY,
    ]);
    return allowedReceipt;
  }

  return OBJECT_FREEZE({
    enabled: enabled === true,
    ledger,
    governedSend,
  });
}

function receipt(input, decision, reasonCode) {
  const generatedAt = input.generatedAt.iso;
  const budgetScopeHash = input.mandateEvidence?.budget_scope_hash || null;
  // Receipts without a validated budget scope must not inherit the ledger's
  // sole-scope convenience view. Doing so would misattribute another
  // principal's cumulative total to this unscoped decision.
  const ledgerSnapshot = budgetScopeHash === null
    ? null
    : REFLECT_APPLY(LEDGER_SNAPSHOT, input.ledger, [budgetScopeHash]);
  const cumulativeBefore = input.reservation?.cumulative_before_atomic
    ?? ledgerSnapshot?.cumulative_authorized_atomic
    ?? null;
  const cumulativeAfter = input.reservation?.cumulative_after_atomic
    ?? ledgerSnapshot?.cumulative_authorized_atomic
    ?? null;
  const receiptBindingHash = stableHash({
    schema: 'agoragentic.anchor-safe-pay.receipt-binding.v1',
    action_digest: input.binding.action_digest,
    mandate_ref: input.mandateEvidence?.mandate_ref || null,
    mandate_hash: input.mandateEvidence?.mandate_hash || null,
    owner_authority_verified: input.mandateEvidence?.authority_verified === true,
    approval_ref: input.approvalEvidence?.approval_ref || null,
    approval_hash: input.approvalEvidence?.approval_hash || null,
    approval_verified: input.approvalEvidence?.approval_verified === true,
    approval_mandate_hash: input.approvalEvidence?.mandate_hash || null,
    approval_mandate_matched: input.approvalEvidence?.mandate_matched === true,
    safe_pay_evidence_hash: input.safePayEvidence.evidence_hash,
    safe_pay_checked_at: input.safePayEvidence.checked_at,
    safe_pay_screen_context_hash: input.safePayEvidence.screen_context_hash,
    budget_scope_hash: budgetScopeHash,
    per_action_limit_atomic: input.mandateEvidence?.per_action_limit_atomic || null,
    cumulative_limit_atomic: input.mandateEvidence?.cumulative_limit_atomic || null,
    cumulative_before_atomic: cumulativeBefore,
    cumulative_after_atomic: cumulativeAfter,
    decision,
    decision_scope: 'caller_declared_fixture_simulation_only',
    reason_code: reasonCode,
    generated_at: generatedAt,
    reservation_id: input.reservation?.reservation_id || null,
    duplicate_of_receipt_id: input.duplicateOfReceiptId || null,
    approval_consumed: input.approvalConsumed === true,
    callback_invoked: input.callbackInvoked === true,
    callback_status: input.callbackStatus,
    funds_moved: false,
    settlement_proven: false,
    outcome_verified: false,
  });
  const receiptId = stableId('asp_receipt', { receipt_binding_hash: receiptBindingHash });

  return deepFreeze({
    schema: RECEIPT_SCHEMA,
    receipt_id: receiptId,
    receipt_binding_hash: receiptBindingHash,
    generated_at: generatedAt,
    mode: 'local_fixture_simulation_no_spend',
    status: decision === 'allow' ? 'recorded' : decision === 'ask' ? 'review' : 'blocked',
    decision,
    decision_scope: 'caller_declared_fixture_simulation_only',
    reason_code: reasonCode,
    adapter: {
      name: '@agoragentic/anchor-safe-pay-reference',
      version: ANCHOR_SAFE_PAY_ADAPTER_VERSION,
      default_off: true,
      production_capable: false,
    },
    action: {
      action: input.binding.action,
      principal_ref: safeReference(input.binding.principal_ref),
      agent_ref: safeReference(input.binding.agent_ref),
      recipient: input.binding.recipient,
      amount_atomic: input.binding.amount_atomic,
      asset: input.binding.asset,
      network: input.binding.network,
      task_hash: input.binding.task_hash,
      quote_hash: input.binding.quote_hash,
      idempotency_key_hash: input.binding.idempotency_key_hash,
      proposed_at: input.binding.proposed_at,
      action_digest: input.binding.action_digest,
    },
    owner_authority: {
      authority_declared: input.mandateEvidence?.authority_declared === true,
      owner_authority_verified: input.mandateEvidence?.authority_verified === true,
      verification_scope: input.mandateEvidence?.verification_scope || 'not_verified',
      mandate_matched: input.mandateEvidence?.mandate_matched === true,
      mandate_ref: safeReference(input.mandateEvidence?.mandate_ref || null),
      mandate_hash: input.mandateEvidence?.mandate_hash || null,
      mandate_issued_at: input.mandateEvidence?.issued_at || null,
      mandate_expires_at: input.mandateEvidence?.expires_at || null,
      grants_external_effect_authority: false,
    },
    approval: {
      required: true,
      approval_verified: input.approvalEvidence?.approval_verified === true,
      verification_scope: input.approvalEvidence?.verification_scope || 'not_verified',
      approval_ref: safeReference(input.approvalEvidence?.approval_ref || null),
      approval_hash: input.approvalEvidence?.approval_hash || null,
      status: input.approvalEvidence?.status || 'missing',
      action_matched: input.approvalEvidence?.action_matched === true,
      mandate_hash: input.approvalEvidence?.mandate_hash || null,
      mandate_matched: input.approvalEvidence?.mandate_matched === true,
      approver_matched: input.approvalEvidence?.approver_matched === true,
      approved_at: input.approvalEvidence?.approved_at || null,
      expires_at: input.approvalEvidence?.expires_at || null,
      consumed: input.approvalConsumed === true,
      grants_payment_authority: false,
      grants_settlement_authority: false,
      grants_external_effect_authority: false,
    },
    budget: {
      budget_scope_hash: budgetScopeHash,
      budget_scope: 'mandate+principal+agent+asset+network',
      per_action_limit_atomic: input.mandateEvidence?.per_action_limit_atomic || null,
      cumulative_limit_atomic: input.mandateEvidence?.cumulative_limit_atomic || null,
      cumulative_before_atomic: cumulativeBefore,
      cumulative_after_atomic: cumulativeAfter,
      reservation_retained: input.reservation !== null,
    },
    safe_pay: input.safePayEvidence,
    execution: {
      send_callback_invoked: input.callbackInvoked === true,
      callback_status: input.callbackStatus,
      duplicate_of_receipt_id: input.duplicateOfReceiptId || null,
      funds_moved: false,
      funds_moved_scope: 'adapter_and_fixture_contract_only',
      payment_settlement_proven: false,
      authorized_for_external_effects: false,
      outcome_verified: false,
      automatic_retry_allowed: false,
    },
    funds_moved: false,
    settlement_proven: false,
    authority_boundary: authorityBoundary({
      safe_pay_grants_payment_authority: false,
      safe_pay_grants_settlement_authority: false,
      safe_pay_replaces_owner_approval: false,
      owner_authority_verified: false,
      approval_verified: false,
      caller_declared_authority_only: true,
      production_payment_callback: false,
      paid_screening_call: false,
    }),
  });
}

function evaluateMandate(mandate, binding, nowMs, maxFutureSkewMs) {
  try {
    return evaluateMandateUnchecked(mandate, binding, nowMs, maxFutureSkewMs);
  } catch {
    return { ok: false, code: 'mandate_invalid', evidence: null };
  }
}

function evaluateMandateUnchecked(mandate, binding, nowMs, maxFutureSkewMs) {
  if (!isPlainObject(mandate) || mandate.authority_granted !== true) {
    return { ok: false, code: 'principal_authority_missing', evidence: null };
  }

  let normalizedMandate;
  let perActionLimit;
  let cumulativeLimit;
  try {
    normalizedMandate = buildMandateBinding(mandate);
    perActionLimit = parseAtomic(normalizedMandate.per_action_limit_atomic, 'per_action_limit_atomic');
    cumulativeLimit = parseAtomic(normalizedMandate.cumulative_limit_atomic, 'cumulative_limit_atomic');
  } catch {
    return { ok: false, code: 'mandate_invalid', evidence: null };
  }

  const issuedAt = normalizedMandate.issued_at;
  const expiresAt = normalizedMandate.expires_at;
  const evidence = {
    authority_declared: true,
    authority_verified: false,
    verification_scope: CALLER_DECLARED_AUTHORITY,
    mandate_matched: false,
    mandate_ref: normalizedMandate.mandate_ref,
    mandate_hash: normalizedMandate.mandate_hash,
    budget_scope_hash: stableHash({
      schema: 'agoragentic.anchor-safe-pay.budget-scope.v1',
      mandate_ref: normalizedMandate.mandate_ref,
      principal_ref: normalizedMandate.principal_ref,
      agent_ref: normalizedMandate.agent_ref,
      asset: binding.asset,
      network: binding.network,
    }),
    issued_at: issuedAt,
    expires_at: expiresAt,
    per_action_limit_atomic: perActionLimit.toString(),
    cumulative_limit_atomic: cumulativeLimit.toString(),
  };

  if (Date.parse(issuedAt) > nowMs + maxFutureSkewMs) {
    return { ok: false, code: 'mandate_not_yet_valid', evidence };
  }
  if (Date.parse(expiresAt) <= Date.parse(issuedAt)) {
    return { ok: false, code: 'mandate_invalid', evidence };
  }
  if (Date.parse(expiresAt) <= nowMs) {
    return { ok: false, code: 'mandate_expired', evidence };
  }
  if (normalizedMandate.approval_required !== true) {
    return { ok: false, code: 'approval_policy_invalid', evidence };
  }

  const matches = normalizedMandate.principal_ref === binding.principal_ref
    && normalizedMandate.agent_ref === binding.agent_ref
    && normalizedMandate.allowed_actions.includes(binding.action)
    && normalizedMandate.allowed_recipients.includes(binding.recipient)
    && normalizedMandate.allowed_assets.includes(binding.asset)
    && normalizedMandate.allowed_networks.includes(binding.network);
  evidence.mandate_matched = matches;
  if (!matches) return { ok: false, code: 'mandate_scope_mismatch', evidence };

  return { ok: true, evidence, perActionLimit, cumulativeLimit, normalizedMandate };
}

function evaluateApproval(approval, binding, mandateEvidence, nowMs, maxFutureSkewMs) {
  try {
    return evaluateApprovalUnchecked(
      approval,
      binding,
      mandateEvidence,
      nowMs,
      maxFutureSkewMs,
    );
  } catch {
    return { ok: false, code: 'approval_invalid', evidence: null };
  }
}

function evaluateApprovalUnchecked(approval, binding, mandateEvidence, nowMs, maxFutureSkewMs) {
  if (!isPlainObject(approval)) {
    return { ok: false, code: 'approval_required', evidence: null };
  }

  let approvedAt;
  let expiresAt;
  try {
    approvedAt = normalizeTimestamp(approval.approved_at, 'approval.approved_at');
    expiresAt = normalizeTimestamp(approval.expires_at, 'approval.expires_at');
  } catch {
    return { ok: false, code: 'approval_invalid', evidence: null };
  }
  const normalizedApproval = {
    schema: 'agoragentic.anchor-safe-pay.owner-approval-binding.v1',
    approval_ref: requiredString(approval.approval_ref, 'approval_ref'),
    status: requiredString(approval.status, 'approval.status'),
    action_digest: normalizeHash(approval.action_digest, 'approval.action_digest'),
    mandate_hash: normalizeHash(approval.mandate_hash, 'approval.mandate_hash'),
    approved_at: approvedAt,
    expires_at: expiresAt,
    approved_by: requiredString(approval.approved_by, 'approval.approved_by'),
  };
  const evidence = {
    approval_verified: false,
    verification_scope: CALLER_DECLARED_AUTHORITY,
    approval_ref: normalizedApproval.approval_ref,
    approval_hash: stableHash(normalizedApproval),
    status: normalizedApproval.status,
    action_matched: normalizedApproval.action_digest === binding.action_digest,
    mandate_hash: normalizedApproval.mandate_hash,
    mandate_matched: normalizedApproval.mandate_hash === mandateEvidence?.mandate_hash,
    approver_matched: normalizedApproval.approved_by === binding.principal_ref,
    approved_at: approvedAt,
    expires_at: expiresAt,
  };

  if (normalizedApproval.status !== 'approved') {
    return { ok: false, code: 'approval_required', evidence };
  }
  if (Date.parse(expiresAt) <= Date.parse(approvedAt)) {
    return { ok: false, code: 'approval_invalid', evidence };
  }
  if (Date.parse(approvedAt) > nowMs + maxFutureSkewMs) {
    return { ok: false, code: 'approval_not_yet_valid', evidence };
  }
  if (Date.parse(approvedAt) < Date.parse(binding.proposed_at)) {
    return { ok: false, code: 'approval_predates_action', evidence };
  }
  if (Date.parse(expiresAt) <= nowMs) {
    return { ok: false, code: 'approval_expired', evidence };
  }
  if (!evidence.mandate_matched) {
    return { ok: false, code: 'approval_mandate_mismatch', evidence };
  }
  if (!evidence.action_matched) {
    return { ok: false, code: 'approval_action_mismatch', evidence };
  }
  if (!evidence.approver_matched) {
    return { ok: false, code: 'approval_principal_mismatch', evidence };
  }
  return { ok: true, evidence, normalizedApproval: OBJECT_FREEZE(normalizedApproval) };
}

function normalizeSafePayVerdict(verdict, binding, upstreamOk) {
  if (!isPlainObject(verdict)) {
    return { ok: false, code: 'safe_pay_unknown', evidence: unknownSafePayEvidence(binding) };
  }
  try {
    if (verdict.recommendation === 'error') {
      return { ok: false, code: 'safe_pay_unavailable', evidence: unavailableSafePayEvidence(binding) };
    }
    if (!VALID_RECOMMENDATIONS.has(verdict.recommendation)) {
      return { ok: false, code: 'safe_pay_unknown', evidence: unknownSafePayEvidence(binding) };
    }
    if (typeof verdict.wallet !== 'string' || typeof verdict.partial !== 'boolean') {
      return { ok: false, code: 'safe_pay_unknown', evidence: unknownSafePayEvidence(binding) };
    }

    const normalized = {
      schema: 'agoragentic.anchor-safe-pay.normalized-verdict.v1',
      wallet: normalizeRecipient(verdict.wallet),
      recommendation: verdict.recommendation,
      risk_score: Number.isFinite(verdict.risk_score) ? Number(verdict.risk_score) : null,
      sanctions_match: verdict.sanctions_match === true,
      sanctioned_lists: boundedStringList(verdict.sanctioned_lists),
      address_type: boundedString(verdict.address_type),
      signals: boundedSignals(verdict.signals),
      corpus_version: boundedString(verdict.corpus_version),
      partial: verdict.partial,
      checked_at: verdict.checked_at,
    };
    const evidence = {
      provider: 'anchor-x402-safe-pay',
      provider_version: SAFE_PAY_UPSTREAM_VERSION,
      status: 'observed_fixture',
      screen_callback_invoked: true,
      fixture_only: true,
      network_calls: 0,
      paid_provider_calls: 0,
      production_endpoint_called: false,
      recommendation: normalized.recommendation,
      upstream_allows: upstreamOk === true,
      partial: normalized.partial,
      recipient_matched: normalized.wallet === binding.recipient,
      checked_at: null,
      evidence_hash: stableHash(normalized),
      hash_scope: 'bounded_normalized_fixture_verdict',
      screen_context_hash: screenContextHash(binding),
      grants_payment_authority: false,
      grants_settlement_authority: false,
      replaces_owner_approval: false,
    };

    if (!evidence.recipient_matched) {
      return { ok: false, code: 'safe_pay_recipient_mismatch', evidence };
    }
    if ((normalized.recommendation === 'allow') !== evidence.upstream_allows) {
      return { ok: false, code: 'safe_pay_upstream_decision_mismatch', evidence };
    }
    return { ok: true, verdict: normalized, evidence };
  } catch {
    return { ok: false, code: 'safe_pay_unknown', evidence: unknownSafePayEvidence(binding) };
  }
}

function noSafePayEvidence(binding) {
  return {
    provider: 'anchor-x402-safe-pay',
    provider_version: SAFE_PAY_UPSTREAM_VERSION,
    status: 'not_observed',
    screen_callback_invoked: false,
    fixture_only: true,
    network_calls: 0,
    paid_provider_calls: 0,
    production_endpoint_called: false,
    recommendation: null,
    upstream_allows: false,
    partial: null,
    recipient_matched: false,
    checked_at: null,
    evidence_hash: null,
    hash_scope: 'none',
    screen_context_hash: screenContextHash(binding),
    grants_payment_authority: false,
    grants_settlement_authority: false,
    replaces_owner_approval: false,
  };
}

function unavailableSafePayEvidence(binding) {
  return {
    ...noSafePayEvidence(binding),
    status: 'unavailable',
    screen_callback_invoked: true,
    recommendation: 'error',
  };
}

function unknownSafePayEvidence(binding) {
  return {
    ...noSafePayEvidence(binding),
    status: 'unknown',
    screen_callback_invoked: true,
  };
}

function unsafeTransportEvidence(binding) {
  return {
    ...noSafePayEvidence(binding),
    status: 'unsafe_transport_rejected',
    screen_callback_invoked: true,
  };
}

function screenContextHash(binding) {
  return stableHash({
    schema: 'agoragentic.anchor-safe-pay.screen-context.v1',
    recipient: binding.recipient,
    amount_atomic: binding.amount_atomic,
    asset: binding.asset,
    network: binding.network,
    action_digest: binding.action_digest,
  });
}

function isFixtureEnvelope(value) {
  return isPlainObject(value)
    && value.mode === FIXTURE_SCREEN_MODE
    && value.fixture_fetch_calls === 1
    && value.network_calls === 0
    && value.paid_provider_calls === 0
    && value.production_endpoint_called === false
    && typeof value.upstream_ok === 'boolean';
}

function isValidSimulationResult(value) {
  return isPlainObject(value)
    && value.status === 'simulated'
    && value.funds_moved === false
    && value.settlement_proven === false;
}

async function withTimeout(promise, timeoutMs) {
  let timer;
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error('simulated_send_timeout')), timeoutMs);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

function currentTime(fixtureTimestamp = null) {
  const date = fixtureTimestamp === null ? new Date() : new Date(fixtureTimestamp);
  if (Number.isNaN(date.getTime())) {
    throw new SafePayHarnessInputError('clock_invalid', 'The current fixture clock must be valid.');
  }
  return { ms: date.getTime(), iso: date.toISOString() };
}

function normalizeTimestamp(value, name) {
  if (typeof value !== 'string' || !value.trim()) {
    throw new SafePayHarnessInputError('timestamp_invalid', `${name} must be an ISO timestamp.`);
  }
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) {
    throw new SafePayHarnessInputError('timestamp_invalid', `${name} must be an ISO timestamp.`);
  }
  return parsed.toISOString();
}

function parseSafePayCheckedAt(value) {
  let parsed = null;
  if (typeof value === 'number' && Number.isFinite(value)) parsed = Math.trunc(value * 1000);
  if (typeof value === 'string' && /^\d+(?:\.\d+)?$/.test(value)) parsed = Math.trunc(Number(value) * 1000);
  if (typeof value === 'string') {
    const isoParsed = Date.parse(value);
    if (!Number.isNaN(isoParsed)) parsed = isoParsed;
  }
  if (!Number.isFinite(parsed) || Number.isNaN(new Date(parsed).getTime())) return null;
  return parsed;
}

function requiredString(value, name) {
  if (typeof value !== 'string' || !value.trim() || value.length > 512) {
    throw new SafePayHarnessInputError('string_invalid', `${name} must be a non-empty string of at most 512 characters.`);
  }
  return value.trim();
}

function requiredExact(value, expected, name) {
  const normalized = requiredString(value, name);
  if (normalized !== expected) {
    throw new SafePayHarnessInputError('action_invalid', `${name} must be ${expected}.`);
  }
  return normalized;
}

function normalizeHash(value, name) {
  const normalized = requiredString(value, name).toLowerCase();
  if (!SHA256_PATTERN.test(normalized)) {
    throw new SafePayHarnessInputError('hash_invalid', `${name} must be a sha256: value.`);
  }
  return normalized;
}

function normalizeRecipient(value) {
  const normalized = requiredString(value, 'recipient');
  return EVM_ADDRESS_PATTERN.test(normalized) ? normalized.toLowerCase() : normalized;
}

function parseAtomic(value, name) {
  if (typeof value !== 'string' && typeof value !== 'number' && typeof value !== 'bigint') {
    throw new SafePayHarnessInputError('amount_invalid', `${name} must be a positive integer in atomic units.`);
  }
  if (typeof value === 'number' && !Number.isSafeInteger(value)) {
    throw new SafePayHarnessInputError('amount_invalid', `${name} numeric input must be a safe integer; use a decimal string for larger values.`);
  }
  const text = String(value);
  if (!/^\d+$/.test(text) || text.length > 78) {
    throw new SafePayHarnessInputError('amount_invalid', `${name} must be a positive integer in atomic units.`);
  }
  const parsed = BigInt(text);
  if (parsed <= 0n || parsed > MAX_UINT256) {
    throw new SafePayHarnessInputError('amount_invalid', `${name} must be between 1 and uint256 max.`);
  }
  return parsed;
}

function normalizeStringSet(value, transform) {
  if (!Array.isArray(value) || value.length === 0 || value.length > 64) {
    throw new SafePayHarnessInputError('scope_invalid', 'Mandate scope arrays must contain between 1 and 64 entries.');
  }
  return [...new Set(value.map(entry => transform(requiredString(entry, 'mandate scope entry'))))].sort();
}

function boundedString(value) {
  if (typeof value !== 'string') return null;
  return value.slice(0, 128);
}

function safeReference(value) {
  if (value === null || value === undefined) return null;
  return sanitizeForPublicEvidence(String(value), { maxStringLength: 240 });
}

function boundedStringList(value) {
  if (!Array.isArray(value)) return [];
  return value.slice(0, 32).map(boundedString).filter(Boolean);
}

function boundedSignals(value) {
  if (!Array.isArray(value)) return [];
  return value.slice(0, 32).filter(isPlainObject).map(signal => ({
    code: boundedString(signal.code),
    severity: boundedString(signal.severity),
    source: boundedString(signal.source),
  }));
}

function assertPositiveInteger(value, name) {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new SafePayHarnessInputError('option_invalid', `${name} must be a positive safe integer.`);
  }
}

function cloneJson(value) {
  return JSON.parse(JSON.stringify(value));
}

function deepFreeze(value) {
  if (value === null || typeof value !== 'object' || OBJECT_IS_FROZEN(value)) {
    return value;
  }
  for (const nested of OBJECT_VALUES(value)) deepFreeze(nested);
  return OBJECT_FREEZE(value);
}

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
