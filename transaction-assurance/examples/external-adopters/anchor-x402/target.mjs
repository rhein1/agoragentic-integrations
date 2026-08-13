const PROTOCOL_PINS = Object.freeze({
  google_ap2: Object.freeze({ version: 'v0.2.0', comparison: 'semver_patch' }),
  openai_stripe_acp: Object.freeze({ version: '2026-04-17', comparison: 'date' }),
  visa_tap: Object.freeze({ version: 'commit-16d59bdf', comparison: 'opaque' }),
  x402: Object.freeze({ version: '2.21.0', comparison: 'semver_major' }),
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

function parseSemver(value) {
  const match = /^v?(\d+)\.(\d+)\.(\d+)$/.exec(value || '');
  if (!match) return null;
  const parts = match.slice(1).map(Number);
  return parts.every(Number.isSafeInteger) ? parts : null;
}

function compareSemver(left, right) {
  for (let index = 0; index < left.length; index += 1) {
    if (left[index] !== right[index]) return left[index] > right[index] ? 1 : -1;
  }
  return 0;
}

function parseDateVersion(value) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value || '')) return null;
  const timestamp = Date.parse(`${value}T00:00:00.000Z`);
  if (!Number.isFinite(timestamp)) return null;
  return new Date(timestamp).toISOString().slice(0, 10) === value ? timestamp : null;
}

function isNewerCompatibleVersion(sourceVersion, pin) {
  if (pin.comparison === 'date') {
    const source = parseDateVersion(sourceVersion);
    const pinned = parseDateVersion(pin.version);
    return source !== null && pinned !== null && source > pinned;
  }
  if (pin.comparison !== 'semver_major' && pin.comparison !== 'semver_patch') return false;
  const source = parseSemver(sourceVersion);
  const pinned = parseSemver(pin.version);
  if (!source || !pinned || compareSemver(source, pinned) <= 0 || source[0] !== pinned[0]) return false;
  return pin.comparison !== 'semver_patch' || source[1] === pinned[1];
}

function evaluateProtocolVersion(adapterId, sourceVersion) {
  const pin = PROTOCOL_PINS[adapterId];
  if (!pin) return result('deny', 'unsupported_protocol_version');
  if (sourceVersion === pin.version) return null;
  if (isNewerCompatibleVersion(sourceVersion, pin)) {
    return result('review', 'newer_protocol_version_review_required');
  }
  return result('deny', 'unsupported_protocol_version');
}

// This target evaluates only the suite's bounded normalized evidence. It does
// not parse wire protocols, verify signatures, call a provider, or move funds.
export function evaluateTransactionAssuranceVector({ input } = {}) {
  if (!hasNormalizedSections(input)) return result('deny', 'malformed_normalized_input');

  const protocolVersionDecision = evaluateProtocolVersion(
    input.protocol.adapter_id,
    input.protocol.source_version,
  );
  if (protocolVersionDecision?.decision === 'deny') return protocolVersionDecision;

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
  if (input.reconciliation.status === 'refunded') {
    return protocolVersionDecision || result('pass', 'reconciled_refunded');
  }
  if (input.reconciliation.status === 'dispute_resolved') {
    return protocolVersionDecision || result('pass', 'reconciled_dispute_resolved');
  }
  if (input.reconciliation.status !== 'complete') {
    return result('review', 'reconciliation_state_unknown');
  }
  return protocolVersionDecision || result('pass', 'complete_chain_verified');
}
