const PROTOCOL_PINS = Object.freeze({
  google_ap2: 'v0.2.0',
  openai_stripe_acp: '2026-04-17',
  visa_tap: 'commit-16d59bdf',
  x402: '2.21.0',
});

function result(decision, code) {
  return Object.freeze({ decision, code });
}

function hasNormalizedSections(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return false;
  return [
    'protocol',
    'authority',
    'terms',
    'limits',
    'payment',
    'settlement',
    'execution',
    'outcome',
    'reconciliation',
    'privacy',
  ].every((field) => input[field] && typeof input[field] === 'object' && !Array.isArray(input[field]));
}

// This target evaluates only the suite's bounded normalized evidence. It does
// not parse wire protocols, verify signatures, call a provider, or move funds.
export function evaluateTransactionAssuranceVector({ input } = {}) {
  if (!hasNormalizedSections(input)) return result('deny', 'malformed_normalized_input');

  const pinnedVersion = PROTOCOL_PINS[input.protocol.adapter_id];
  if (!pinnedVersion || input.protocol.source_version !== pinnedVersion) {
    return result('deny', 'unsupported_protocol_version');
  }

  if (input.authority.verification === 'unknown') {
    return result('review', 'authority_verification_unknown');
  }
  if (input.authority.verification !== 'verified') return result('review', 'authority_unverified');
  if (input.authority.revocation === 'revoked') return result('deny', 'authority_revoked');
  if (input.authority.revocation !== 'active') return result('review', 'authority_revocation_unknown');
  if (input.authority.expired) return result('deny', 'authority_expired');
  if (!input.authority.audience_match) return result('deny', 'authority_wrong_audience');
  if (!input.authority.agent_match) return result('deny', 'authority_wrong_agent');

  for (const [field, code] of [
    ['merchant_match', 'merchant_mismatch'],
    ['category_match', 'category_mismatch'],
    ['action_match', 'action_mismatch'],
    ['rail_match', 'rail_mismatch'],
    ['currency_match', 'currency_mismatch'],
    ['quote_match', 'quote_changed'],
    ['terms_match', 'terms_changed'],
  ]) {
    if (!input.terms[field]) return result('deny', code);
  }

  for (const [field, code] of [
    ['per_action_within_limit', 'per_action_limit_exceeded'],
    ['daily_within_limit', 'daily_limit_exceeded'],
    ['total_within_limit', 'total_limit_exceeded'],
  ]) {
    if (!input.limits[field]) return result('deny', code);
  }

  if (!input.payment.identifier_present) return result('deny', 'payment_identifier_missing');
  if (input.payment.identifier_reused) return result('deny', 'payment_identifier_reused');
  if (input.payment.replay_detected) return result('deny', 'paid_retry_replay_detected');
  if (!input.settlement.observed) return result('review', 'payment_not_observed');
  if (!input.settlement.verified) return result('deny', 'settlement_unverified');
  if (!input.settlement.final) return result('review', 'settlement_not_final');
  if (!input.execution.attempted) return result('review', 'execution_not_observed');
  if (!input.execution.succeeded) return result('deny', 'execution_failed_after_payment');
  if (!input.execution.delivery_observed) return result('review', 'delivery_missing_after_payment');

  if (input.outcome.validation === 'not_checked') return result('review', 'outcome_not_validated');
  if (input.outcome.validation === 'failed') return result('deny', 'outcome_validation_failed');
  if (input.outcome.validation === 'partial') return result('review', 'partial_fulfillment');

  const exposedPrivacyField = Object.entries(input.privacy).find(([, exposed]) => exposed);
  if (exposedPrivacyField) return result('deny', `privacy_${exposedPrivacyField[0]}`);

  if (input.reconciliation.status === 'refund_pending') return result('review', 'refund_pending');
  if (input.reconciliation.status === 'dispute_pending') return result('review', 'dispute_pending');
  if (input.reconciliation.status === 'none') return result('review', 'reconciliation_incomplete');
  if (input.reconciliation.status === 'refunded') return result('pass', 'reconciled_refunded');
  if (input.reconciliation.status === 'dispute_resolved') {
    return result('pass', 'reconciled_dispute_resolved');
  }
  if (input.reconciliation.status !== 'complete') {
    return result('review', 'reconciliation_state_unknown');
  }
  return result('pass', 'complete_chain_verified');
}
