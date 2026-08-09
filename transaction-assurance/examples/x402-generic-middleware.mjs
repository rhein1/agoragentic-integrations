import {
  bindX402OutcomeEvidence,
  normalizeX402Evidence,
} from '../src/index.mjs';

export function assessX402MiddlewareExchange({ artifact, normalization, binding }) {
  const evidence = normalizeX402Evidence(artifact, normalization);
  const outcome = bindX402OutcomeEvidence(evidence, binding);

  let decision = 'review';
  if (outcome.mismatches.length > 0) decision = 'deny';
  else if (outcome.settlement_verified && outcome.receipt_verified) decision = 'await_delivery_verification';

  return {
    schema: 'agoragentic.x402-middleware-assessment.v1',
    decision,
    evidence,
    outcome,
    next_safe_actions: decision === 'deny'
      ? ['do_not_reauthorize_payment', 'reconcile_payment_identifier']
      : ['verify_delivered_outcome_before_completion'],
    authority_flags: {
      can_send_payment: false,
      can_retry_payment: false,
      can_execute_provider: false,
      can_mark_delivery_verified: false,
    },
  };
}
