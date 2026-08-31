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
const VALID_RECOMMENDATIONS = new Set(['allow', 'review', 'block']);
const SHA256_PATTERN = /^sha256:[a-f0-9]{64}$/;
const EVM_ADDRESS_PATTERN = /^0x[a-fA-F0-9]{40}$/;
const DEFAULT_VERDICT_MAX_AGE_MS = 5 * 60 * 1000;
const DEFAULT_FUTURE_SKEW_MS = 30 * 1000;
const DEFAULT_SCREEN_TIMEOUT_MS = 1000;
const DEFAULT_SEND_TIMEOUT_MS = 1000;
const MAX_UINT256 = (1n << 256n) - 1n;
const FIXTURE_SCREEN_CAPABILITY = Symbol('anchor-safe-pay-fixture-screen');
const FIXTURE_SEND_CAPABILITY = Symbol('anchor-safe-pay-fixture-send');

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

  constructor() {
    this.#recordsByIdempotency = new Map();
    this.#recordsByApproval = new Map();
    this.#recordsByReservation = new Map();
    this.#cumulativeAuthorizedByScope = new Map();
  }

  snapshot(budgetScopeHash = null) {
    const requestedScope = budgetScopeHash === null
      ? null
      : normalizeHash(budgetScopeHash, 'budget_scope_hash');
    const soleScope = requestedScope === null && this.#cumulativeAuthorizedByScope.size === 1
      ? this.#cumulativeAuthorizedByScope.keys().next().value
      : null;
    const selectedScope = requestedScope || soleScope;
    return Object.freeze({
      budget_scope_hash: selectedScope || null,
      cumulative_authorized_atomic: selectedScope
        ? this.#cumulativeForScope(selectedScope).toString()
        : null,
      budget_scope_count: this.#cumulativeAuthorizedByScope.size,
      reservation_count: this.#recordsByReservation.size,
    });
  }

  preflight(input) {
    return this.#evaluate(input);
  }

  reserve(input) {
    const evaluation = this.#evaluate(input);
    if (!evaluation.ok) return evaluation;

    const amount = parseAtomic(input.amount_atomic, 'amount_atomic');
    const budgetScopeHash = normalizeHash(input.budget_scope_hash, 'budget_scope_hash');
    const cumulativeBefore = this.#cumulativeForScope(budgetScopeHash);
    const cumulativeAfter = cumulativeBefore + amount;
    const reservationId = stableId('asp_reservation', {
      action_digest: input.action_digest,
      approval_ref: input.approval_ref,
      idempotency_key_hash: input.idempotency_key_hash,
      budget_scope_hash: budgetScopeHash,
    });
    const record = {
      reservation_id: reservationId,
      action_digest: input.action_digest,
      approval_ref: input.approval_ref,
      idempotency_key_hash: input.idempotency_key_hash,
      amount_atomic: amount.toString(),
      cumulative_before_atomic: cumulativeBefore.toString(),
      cumulative_after_atomic: cumulativeAfter.toString(),
      status: 'reserved',
      receipt: null,
    };

    this.#cumulativeAuthorizedByScope.set(budgetScopeHash, cumulativeAfter);
    this.#recordsByIdempotency.set(input.idempotency_key_hash, record);
    this.#recordsByApproval.set(input.approval_ref, record);
    this.#recordsByReservation.set(reservationId, record);

    return {
      ok: true,
      reservation_id: reservationId,
      cumulative_before_atomic: cumulativeBefore.toString(),
      cumulative_after_atomic: cumulativeAfter.toString(),
    };
  }

  finalize(reservationId, receipt) {
    const record = this.#recordsByReservation.get(reservationId);
    if (!record) throw new SafePayHarnessInputError('reservation_missing', 'The local reservation does not exist.');
    if (record.status !== 'reserved') {
      throw new SafePayHarnessInputError('reservation_finalized', 'The local reservation was already finalized.');
    }
    record.status = receipt.decision === 'allow' ? 'simulated' : 'ambiguous';
    record.receipt = receipt;
    return record;
  }

  #evaluate(input) {
    const budgetScopeHash = normalizeHash(input.budget_scope_hash, 'budget_scope_hash');
    const existingIdempotency = this.#recordsByIdempotency.get(input.idempotency_key_hash);
    if (existingIdempotency) {
      if (existingIdempotency.action_digest !== input.action_digest) {
        return {
          ok: false,
          code: 'idempotency_binding_mismatch',
          previous_receipt_id: existingIdempotency.receipt?.receipt_id || null,
        };
      }
      return {
        ok: false,
        code: 'duplicate_idempotency',
        previous_receipt_id: existingIdempotency.receipt?.receipt_id || null,
      };
    }

    const existingApproval = this.#recordsByApproval.get(input.approval_ref);
    if (existingApproval) {
      return {
        ok: false,
        code: 'approval_replay',
        previous_receipt_id: existingApproval.receipt?.receipt_id || null,
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
}

/**
 * Exercise Safe Pay's public screenAllows contract with an in-memory response.
 * The helper owns the fake fetch and exposes no endpoint or transport option,
 * so this reference cannot accidentally perform the paid production screen.
 */
export function createFixtureSafePayScreenAdapter(options = {}) {
  if (!isPlainObject(options)) {
    throw new SafePayHarnessInputError('fixture_options_invalid', 'Fixture screen options must be an object.');
  }
  if (Object.hasOwn(options, 'screenAllows')) {
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
          return cloneJson(verdict);
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
      verdict: unavailable ? upstreamDecision?.verdict : cloneJson(verdict),
    };
  };
  Object.defineProperty(fixtureScreen, FIXTURE_SCREEN_CAPABILITY, { value: true });
  Object.defineProperty(fixtureScreen, 'fixtureCallCount', { value: () => fixtureCallCount });
  return fixtureScreen;
}

/**
 * Mark one caller-owned callback as an explicit simulation. This is a local
 * declaration, not a sandbox; the callback remains the caller's trust boundary.
 */
export function createFixtureSimulatedSend(callback) {
  if (typeof callback !== 'function') {
    throw new SafePayHarnessInputError('simulated_send_required', 'A simulated callback function is required.');
  }
  const fixtureSend = async binding => callback(binding);
  Object.defineProperty(fixtureSend, FIXTURE_SEND_CAPABILITY, { value: true });
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

  return Object.freeze({
    ...normalized,
    action_digest: stableHash(normalized),
  });
}

export function createAnchorSafePayHarness({
  enabled = false,
  ledger = new InMemorySafePayLedger(),
  now = () => new Date(),
  verdictMaxAgeMs = DEFAULT_VERDICT_MAX_AGE_MS,
  maxFutureSkewMs = DEFAULT_FUTURE_SKEW_MS,
  screenTimeoutMs = DEFAULT_SCREEN_TIMEOUT_MS,
  sendTimeoutMs = DEFAULT_SEND_TIMEOUT_MS,
} = {}) {
  if (!(ledger instanceof InMemorySafePayLedger)) {
    throw new SafePayHarnessInputError('ledger_invalid', 'ledger must be an InMemorySafePayLedger.');
  }
  assertPositiveInteger(verdictMaxAgeMs, 'verdictMaxAgeMs');
  assertPositiveInteger(maxFutureSkewMs, 'maxFutureSkewMs');
  assertPositiveInteger(screenTimeoutMs, 'screenTimeoutMs');
  assertPositiveInteger(sendTimeoutMs, 'sendTimeoutMs');

  async function governedSend({
    action,
    mandate,
    approval,
    screenRecipient,
    simulatedSend,
  } = {}) {
    const generatedAt = currentTime(now);
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
    if (screenRecipient[FIXTURE_SCREEN_CAPABILITY] !== true) {
      return receipt(base, 'deny', 'unsafe_screen_adapter');
    }
    if (typeof simulatedSend !== 'function') {
      return receipt(base, 'deny', 'simulated_send_missing');
    }
    if (simulatedSend[FIXTURE_SEND_CAPABILITY] !== true) {
      return receipt(base, 'deny', 'unsafe_simulated_send_adapter');
    }
    if (Date.parse(binding.proposed_at) > generatedAt.ms + maxFutureSkewMs) {
      return receipt(base, 'deny', 'action_not_yet_valid');
    }

    let mandateResult = evaluateMandate(mandate, binding, generatedAt.ms, maxFutureSkewMs);
    base.mandateEvidence = mandateResult.evidence;
    if (!mandateResult.ok) return receipt(base, 'deny', mandateResult.code);

    let approvalResult = evaluateApproval(approval, binding, generatedAt.ms, maxFutureSkewMs);
    base.approvalEvidence = approvalResult.evidence;
    if (!approvalResult.ok) return receipt(base, 'deny', approvalResult.code);

    const amount = parseAtomic(binding.amount_atomic, 'amount_atomic');
    if (amount > mandateResult.perActionLimit) {
      return receipt(base, 'deny', 'per_action_limit_exceeded');
    }

    let reservationInput = {
      action_digest: binding.action_digest,
      approval_ref: approvalResult.evidence.approval_ref,
      idempotency_key_hash: binding.idempotency_key_hash,
      budget_scope_hash: mandateResult.evidence.budget_scope_hash,
      amount_atomic: binding.amount_atomic,
      cumulative_limit_atomic: mandateResult.cumulativeLimit.toString(),
    };
    const preflight = ledger.preflight(reservationInput);
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

    const verdictResult = normalizeSafePayVerdict(envelope.verdict, binding);
    base.safePayEvidence = verdictResult.evidence;
    if (!verdictResult.ok) return receipt(base, 'deny', verdictResult.code);

    // Screening is asynchronous. Re-sample the clock and re-evaluate every
    // expiring authority immediately before the atomic reservation/callback.
    // The final receipt timestamp reflects this challenge-time decision.
    const challengeTime = currentTime(now);
    base.generatedAt = challengeTime;
    mandateResult = evaluateMandate(mandate, binding, challengeTime.ms, maxFutureSkewMs);
    base.mandateEvidence = mandateResult.evidence;
    if (!mandateResult.ok) return receipt(base, 'deny', mandateResult.code);
    approvalResult = evaluateApproval(approval, binding, challengeTime.ms, maxFutureSkewMs);
    base.approvalEvidence = approvalResult.evidence;
    if (!approvalResult.ok) return receipt(base, 'deny', approvalResult.code);
    if (amount > mandateResult.perActionLimit) {
      return receipt(base, 'deny', 'per_action_limit_exceeded');
    }
    reservationInput = {
      ...reservationInput,
      approval_ref: approvalResult.evidence.approval_ref,
      budget_scope_hash: mandateResult.evidence.budget_scope_hash,
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

    const reservation = ledger.reserve(reservationInput);
    if (!reservation.ok) {
      return receipt({ ...base, duplicateOfReceiptId: reservation.previous_receipt_id || null }, 'deny', reservation.code);
    }
    base.reservation = reservation;
    base.approvalConsumed = true;
    base.callbackInvoked = true;

    let callbackResult;
    try {
      callbackResult = await withTimeout(
        Promise.resolve(simulatedSend(Object.freeze({ ...binding }))),
        sendTimeoutMs,
      );
    } catch {
      base.callbackStatus = 'ambiguous';
      const ambiguousReceipt = receipt(base, 'ask', 'send_ambiguous');
      ledger.finalize(reservation.reservation_id, ambiguousReceipt);
      return ambiguousReceipt;
    }

    if (!isValidSimulationResult(callbackResult)) {
      base.callbackStatus = 'ambiguous';
      const ambiguousReceipt = receipt(base, 'ask', 'send_ambiguous');
      ledger.finalize(reservation.reservation_id, ambiguousReceipt);
      return ambiguousReceipt;
    }

    base.callbackStatus = 'simulated';
    const allowedReceipt = receipt(base, 'allow', 'allowed_simulated');
    ledger.finalize(reservation.reservation_id, allowedReceipt);
    return allowedReceipt;
  }

  return Object.freeze({
    enabled: enabled === true,
    ledger,
    governedSend,
  });
}

function receipt(input, decision, reasonCode) {
  const generatedAt = input.generatedAt.iso;
  const budgetScopeHash = input.mandateEvidence?.budget_scope_hash || null;
  const ledgerSnapshot = input.ledger.snapshot(budgetScopeHash);
  const cumulativeBefore = input.reservation?.cumulative_before_atomic
    ?? ledgerSnapshot.cumulative_authorized_atomic;
  const cumulativeAfter = input.reservation?.cumulative_after_atomic
    ?? ledgerSnapshot.cumulative_authorized_atomic;
  const receiptBindingHash = stableHash({
    schema: 'agoragentic.anchor-safe-pay.receipt-binding.v1',
    action_digest: input.binding.action_digest,
    mandate_ref: input.mandateEvidence?.mandate_ref || null,
    mandate_hash: input.mandateEvidence?.mandate_hash || null,
    approval_ref: input.approvalEvidence?.approval_ref || null,
    approval_hash: input.approvalEvidence?.approval_hash || null,
    safe_pay_evidence_hash: input.safePayEvidence.evidence_hash,
    safe_pay_checked_at: input.safePayEvidence.checked_at,
    safe_pay_screen_context_hash: input.safePayEvidence.screen_context_hash,
    budget_scope_hash: budgetScopeHash,
    per_action_limit_atomic: input.mandateEvidence?.per_action_limit_atomic || null,
    cumulative_limit_atomic: input.mandateEvidence?.cumulative_limit_atomic || null,
    cumulative_before_atomic: cumulativeBefore,
    cumulative_after_atomic: cumulativeAfter,
    decision,
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

  return {
    schema: RECEIPT_SCHEMA,
    receipt_id: receiptId,
    receipt_binding_hash: receiptBindingHash,
    generated_at: generatedAt,
    mode: 'local_fixture_simulation_no_spend',
    status: decision === 'allow' ? 'recorded' : decision === 'ask' ? 'review' : 'blocked',
    decision,
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
      owner_authority_verified: input.mandateEvidence?.authority_verified === true,
      verification_scope: safeReference(input.mandateEvidence?.verification_scope || 'not_verified'),
      mandate_matched: input.mandateEvidence?.mandate_matched === true,
      mandate_ref: safeReference(input.mandateEvidence?.mandate_ref || null),
      mandate_hash: input.mandateEvidence?.mandate_hash || null,
      mandate_issued_at: input.mandateEvidence?.issued_at || null,
      mandate_expires_at: input.mandateEvidence?.expires_at || null,
    },
    approval: {
      required: true,
      approval_ref: safeReference(input.approvalEvidence?.approval_ref || null),
      approval_hash: input.approvalEvidence?.approval_hash || null,
      status: input.approvalEvidence?.status || 'missing',
      action_matched: input.approvalEvidence?.action_matched === true,
      approver_matched: input.approvalEvidence?.approver_matched === true,
      approved_at: input.approvalEvidence?.approved_at || null,
      expires_at: input.approvalEvidence?.expires_at || null,
      consumed: input.approvalConsumed === true,
      grants_settlement_authority: false,
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
      outcome_verified: false,
      automatic_retry_allowed: false,
    },
    funds_moved: false,
    settlement_proven: false,
    authority_boundary: authorityBoundary({
      safe_pay_grants_payment_authority: false,
      safe_pay_grants_settlement_authority: false,
      safe_pay_replaces_owner_approval: false,
      production_payment_callback: false,
      paid_screening_call: false,
    }),
  };
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

  let issuedAt;
  let expiresAt;
  let perActionLimit;
  let cumulativeLimit;
  try {
    issuedAt = normalizeTimestamp(mandate.issued_at, 'mandate.issued_at');
    expiresAt = normalizeTimestamp(mandate.expires_at, 'mandate.expires_at');
    perActionLimit = parseAtomic(mandate.per_action_limit_atomic, 'per_action_limit_atomic');
    cumulativeLimit = parseAtomic(mandate.cumulative_limit_atomic, 'cumulative_limit_atomic');
  } catch {
    return { ok: false, code: 'mandate_invalid', evidence: null };
  }

  const normalizedMandate = {
    schema: 'agoragentic.anchor-safe-pay.owner-mandate-binding.v1',
    mandate_ref: requiredString(mandate.mandate_ref, 'mandate_ref'),
    principal_ref: requiredString(mandate.principal_ref, 'mandate.principal_ref'),
    agent_ref: requiredString(mandate.agent_ref, 'mandate.agent_ref'),
    authority_granted: true,
    authority_evidence: requiredString(mandate.authority_evidence, 'mandate.authority_evidence'),
    allowed_actions: normalizeStringSet(mandate.allowed_actions, value => value),
    allowed_recipients: normalizeStringSet(mandate.allowed_recipients, normalizeRecipient),
    allowed_assets: normalizeStringSet(mandate.allowed_assets, value => value.toUpperCase()),
    allowed_networks: normalizeStringSet(mandate.allowed_networks, value => value.toLowerCase()),
    per_action_limit_atomic: perActionLimit.toString(),
    cumulative_limit_atomic: cumulativeLimit.toString(),
    approval_required: mandate.approval_required === true,
    issued_at: issuedAt,
    expires_at: expiresAt,
  };
  const evidence = {
    authority_verified: true,
    verification_scope: normalizedMandate.authority_evidence,
    mandate_matched: false,
    mandate_ref: normalizedMandate.mandate_ref,
    mandate_hash: stableHash(normalizedMandate),
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

  return { ok: true, evidence, perActionLimit, cumulativeLimit };
}

function evaluateApproval(approval, binding, nowMs, maxFutureSkewMs) {
  try {
    return evaluateApprovalUnchecked(approval, binding, nowMs, maxFutureSkewMs);
  } catch {
    return { ok: false, code: 'approval_invalid', evidence: null };
  }
}

function evaluateApprovalUnchecked(approval, binding, nowMs, maxFutureSkewMs) {
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
    approved_at: approvedAt,
    expires_at: expiresAt,
    approved_by: requiredString(approval.approved_by, 'approval.approved_by'),
  };
  const evidence = {
    approval_ref: normalizedApproval.approval_ref,
    approval_hash: stableHash(normalizedApproval),
    status: normalizedApproval.status,
    action_matched: normalizedApproval.action_digest === binding.action_digest,
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
  if (!evidence.action_matched) {
    return { ok: false, code: 'approval_action_mismatch', evidence };
  }
  if (!evidence.approver_matched) {
    return { ok: false, code: 'approval_principal_mismatch', evidence };
  }
  return { ok: true, evidence };
}

function normalizeSafePayVerdict(verdict, binding) {
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
    && value.production_endpoint_called === false;
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

function currentTime(now) {
  const value = now();
  const date = value instanceof Date ? new Date(value.getTime()) : new Date(value);
  if (Number.isNaN(date.getTime())) {
    throw new SafePayHarnessInputError('clock_invalid', 'now() must return a valid date.');
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

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
