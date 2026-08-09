import { createHash } from 'node:crypto';

import {
  bindTrustedEnvelope,
  trustedAuthorityBinding,
  trustedEnvelopeBinding,
} from './trusted-verifier-boundary.mjs';

export const AUTHORITY_PROTOCOLS = Object.freeze([
  'agoragentic_mandate',
  'google_ap2',
  'visa_tap',
  'openai_stripe_acp',
  'x402',
  'circle_agent_wallet_policy',
  'skyfire_kyapay',
  'mastercard_verifiable_intent',
  'other',
]);

export const ASSURANCE_STATES = Object.freeze([
  'incomplete',
  'authority_ready',
  'payment_pending',
  'payment_observed',
  'execution_observed',
  'outcome_verified',
  'reconciled',
  'failed',
  'refunded',
  'disputed',
]);

const VERIFICATION_STATUSES = Object.freeze([
  'not_checked',
  'unverified',
  'verified',
  'failed',
  'unknown',
  'not_applicable',
]);
const PRINCIPAL_TYPES = Object.freeze([
  'human',
  'organization',
  'dao',
  'treasury',
  'service_principal',
  'unknown',
]);
const REVOCATION_STATUSES = Object.freeze(['not_checked', 'active', 'revoked', 'unknown']);
const TERMS_STATUSES = Object.freeze(['not_checked', 'match', 'changed', 'unknown']);
const PAYMENT_STATUSES = Object.freeze([
  'not_started',
  'required',
  'submitted',
  'observed',
  'settled',
  'failed',
  'refunded',
  'unknown',
]);
const EXECUTION_STATUSES = Object.freeze([
  'not_started',
  'pending',
  'success',
  'failed',
  'timed_out',
  'ambiguous',
  'unknown',
]);
const DELIVERY_STATUSES = Object.freeze(['not_observed', 'partial', 'delivered', 'failed', 'unknown']);
const RECONCILIATION_STATUSES = Object.freeze([
  'not_started',
  'pending',
  'complete',
  'failed',
  'refunded',
  'disputed',
  'unknown',
]);
const MONEY_PATTERN = /^(0|[1-9]\d*)(\.\d{1,6})?$/;
const TRUSTED_CALLBACK_PROTOCOLS = new Set([
  'google_ap2',
  'visa_tap',
  'openai_stripe_acp',
  'circle_agent_wallet_policy',
  'skyfire_kyapay',
]);

function isPlainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function normalizeString(value, fallback = null, maxLength = 2000) {
  if (value === undefined || value === null) return fallback;
  const normalized = String(value).trim();
  return normalized ? normalized.slice(0, maxLength) : fallback;
}

function normalizeList(value, { maxItems = 200, maxLength = 2000 } = {}) {
  if (value === undefined || value === null) return [];
  const source = Array.isArray(value) ? value : [value];
  return [...new Set(source
    .map((item) => normalizeString(item, null, maxLength))
    .filter(Boolean))]
    .slice(0, maxItems);
}

function normalizeEnum(value, allowed, fallback, field) {
  const normalized = normalizeString(value, fallback);
  if (!allowed.includes(normalized)) {
    throw new TypeError(`${field} must be one of: ${allowed.join(', ')}`);
  }
  return normalized;
}

function normalizeMoney(value, fallback = '0') {
  if (value === undefined || value === null || value === '') return fallback;
  if (typeof value !== 'string' || !MONEY_PATTERN.test(value)) {
    throw new TypeError(`Money values must be non-negative decimal strings: ${JSON.stringify(value)}`);
  }
  return value;
}

function normalizeOptionalMoney(value) {
  if (value === undefined || value === null || value === '') return null;
  return normalizeMoney(value);
}

function moneyUnits(value) {
  const normalized = normalizeMoney(value, '0');
  const [whole, fraction = ''] = normalized.split('.');
  return (BigInt(whole) * 1_000_000n) + BigInt(fraction.padEnd(6, '0'));
}

function compareMoney(left, right) {
  const leftUnits = moneyUnits(left);
  const rightUnits = moneyUnits(right);
  return leftUnits === rightUnits ? 0 : leftUnits > rightUnits ? 1 : -1;
}

function addMoney(left, right) {
  const units = moneyUnits(left) + moneyUnits(right);
  const whole = units / 1_000_000n;
  const fraction = String(units % 1_000_000n).padStart(6, '0').replace(/0+$/, '');
  return fraction ? `${whole}.${fraction}` : String(whole);
}

function normalizeDate(value) {
  if (value === undefined || value === null || value === '') return null;
  if (typeof value === 'number' && Number.isFinite(value)) {
    const milliseconds = value > 10_000_000_000 ? value : value * 1000;
    return new Date(milliseconds).toISOString();
  }
  const parsed = new Date(String(value));
  return Number.isNaN(parsed.getTime()) ? null : parsed.toISOString();
}

function requireDate(value, field) {
  const normalized = normalizeDate(value);
  if (!normalized) throw new TypeError(`${field} must be a valid date-time`);
  return normalized;
}

function getPath(object, path) {
  let cursor = object;
  for (const segment of path.split('.')) {
    if ((!isPlainObject(cursor) && !Array.isArray(cursor))
      || !Object.prototype.hasOwnProperty.call(cursor, segment)) {
      return undefined;
    }
    cursor = cursor[segment];
  }
  return cursor;
}

function firstValue(object, paths) {
  for (const path of paths) {
    const value = getPath(object, path);
    if (value !== undefined && value !== null && value !== '') return value;
  }
  return undefined;
}

function sortForCanonicalization(value) {
  if (Array.isArray(value)) return value.map(sortForCanonicalization);
  if (!isPlainObject(value)) return value;
  return Object.fromEntries(
    Object.keys(value)
      .sort()
      .map((key) => [key, sortForCanonicalization(value[key])]),
  );
}

export function canonicalize(value) {
  return JSON.stringify(sortForCanonicalization(value));
}

export function sha256Ref(value) {
  const input = typeof value === 'string' ? value : canonicalize(value);
  return `sha256:${createHash('sha256').update(input, 'utf8').digest('hex')}`;
}

export function computeEnvelopeHash(envelope) {
  if (!isPlainObject(envelope)) throw new TypeError('envelope must be a JSON object');
  return sha256Ref({
    ...envelope,
    evidence: {
      ...(isPlainObject(envelope.evidence) ? envelope.evidence : {}),
      envelope_hash: null,
    },
  });
}

function flattenedKeys(value, output = new Set(), depth = 0) {
  if (depth > 8 || value === undefined || value === null) return output;
  if (Array.isArray(value)) {
    for (const item of value.slice(0, 100)) flattenedKeys(item, output, depth + 1);
    return output;
  }
  if (!isPlainObject(value)) return output;
  for (const [key, child] of Object.entries(value)) {
    output.add(String(key).toLowerCase().replace(/[^a-z0-9]/g, ''));
    flattenedKeys(child, output, depth + 1);
  }
  return output;
}

function hasAny(keys, values) {
  return values.some((value) => keys.has(value));
}

function detection(protocol, confidence, reasons) {
  return Object.freeze({
    protocol,
    confidence,
    reasons: Object.freeze([...reasons]),
  });
}

export function detectAuthorityProtocol(artifact, options = {}) {
  const hint = normalizeString(options.protocolHint);
  if (hint) {
    if (!AUTHORITY_PROTOCOLS.includes(hint)) {
      throw new TypeError(`Unsupported protocolHint: ${hint}`);
    }
    return detection(hint, 'hinted', [
      'caller supplied protocolHint; recognition is not verification',
    ]);
  }
  if (!isPlainObject(artifact)) {
    return detection('other', 'low', ['artifact is not a JSON object']);
  }

  const keys = flattenedKeys(artifact);
  const schema = normalizeString(firstValue(artifact, ['$schema', 'schema', 'type']), '')?.toLowerCase() || '';
  const prefix = canonicalize(artifact).slice(0, 20_000).toLowerCase();

  if (schema.includes('agoragentic')
    || (hasAny(keys, ['ownerid', 'buyeragentid']) && keys.has('budget'))
    || hasAny(keys, ['agoragenticagentcommercemandatev1', 'mandateapprovedtransactionplan'])) {
    return detection('agoragentic_mandate', 'high', ['native Agoragentic mandate markers found']);
  }
  if (schema.includes('ap2')
    || hasAny(keys, ['intentmandate', 'cartmandate', 'paymentmandate', 'ap2mandate'])
    || prefix.includes('ap2-protocol')) {
    return detection('google_ap2', 'high', ['AP2 mandate markers found']);
  }
  if (hasAny(keys, ['agentrecognition', 'consumerrecognition', 'paymentcontainer', 'signatureinput'])
    || schema.includes('trusted-agent-protocol')
    || prefix.includes('visa tap')) {
    return detection('visa_tap', 'medium', ['Visa TAP identity or intent signature markers found']);
  }
  if (schema.includes('agentic-commerce-protocol')
    || hasAny(keys, ['agenticcheckout', 'delegatepayment', 'paymenthandler', 'checkoutsessions'])
    || prefix.includes('agentic commerce protocol')) {
    return detection('openai_stripe_acp', 'medium', ['official ACP checkout or delegated-payment markers found']);
  }
  if (hasAny(keys, [
    'x402version',
    'paymentrequired',
    'paymentpayload',
    'paymentsignature',
    'paymentidentifier',
    'signedoffer',
    'signedreceipt',
  ]) || schema.includes('x402')) {
    return detection('x402', 'high', ['x402 payment, offer, identifier, or receipt markers found']);
  }
  if (hasAny(keys, ['walletsetid', 'spendingpolicy', 'circleagentwallet', 'circlewallet'])
    || (prefix.includes('circle') && hasAny(keys, ['walletid', 'policyid', 'rules']))) {
    return detection('circle_agent_wallet_policy', 'medium', ['Circle wallet or policy markers found']);
  }
  if (hasAny(keys, ['skyfirepayid', 'kyapay', 'kyatoken', 'kya'])
    || prefix.includes('skyfire-pay-id')) {
    return detection('skyfire_kyapay', 'medium', ['Skyfire KYA or KYAPay markers found']);
  }
  if (hasAny(keys, ['verifiableintent', 'mastercardagentpay', 'agentictoken'])
    || prefix.includes('mastercard agent pay')) {
    return detection('mastercard_verifiable_intent', 'medium', ['Verifiable Intent or Mastercard Agent Pay markers found']);
  }
  return detection('other', 'low', ['no recognized authority or payment protocol markers found']);
}

function noAuthorityFlags() {
  return {
    can_spend: false,
    can_fund_wallet: false,
    can_deploy: false,
    can_publish: false,
    can_change_trust: false,
    can_expand_scope: false,
  };
}

function envelopeAuthorityFlags() {
  return {
    envelope_grants_authority: false,
    ...noAuthorityFlags(),
  };
}

function evaluationAuthorityFlags() {
  return {
    evaluation_grants_authority: false,
    ...noAuthorityFlags(),
  };
}

function normalizedArtifactAuthorityFlags() {
  return {
    normalized_artifact_grants_authority: false,
    ...noAuthorityFlags(),
  };
}

function declaredRevocationStatus(artifact) {
  const value = firstValue(artifact, [
    'revocation_status',
    'revocation.status',
    'status.revocation',
    'revoked',
  ]);
  if (value === true) return 'revoked';
  if (value === false) return 'active';
  const normalized = normalizeString(value, null)?.toLowerCase();
  return REVOCATION_STATUSES.includes(normalized) ? normalized : null;
}

export function normalizeAuthorityArtifact(artifact, options = {}) {
  if (!isPlainObject(artifact)) throw new TypeError('artifact must be a JSON object');

  const detected = detectAuthorityProtocol(artifact, options);
  const verification = {
    status: normalizeEnum(
      options.verification?.status,
      VERIFICATION_STATUSES,
      'unverified',
      'verification.status',
    ),
    verifier_ref: normalizeString(options.verification?.verifierRef),
    evidence_ref: normalizeString(options.verification?.evidenceRef),
    checked_at: normalizeDate(options.verification?.checkedAt),
  };
  if (verification.status === 'verified'
    && (!verification.verifier_ref || !verification.evidence_ref || !verification.checked_at)) {
    throw new TypeError('verified authority requires verifierRef, evidenceRef, and checkedAt');
  }
  const revocationCheck = {
    status: normalizeEnum(
      options.revocation?.status ?? options.revocationStatus,
      REVOCATION_STATUSES,
      'not_checked',
      'revocation.status',
    ),
    evidence_ref: normalizeString(
      options.revocation?.evidenceRef ?? options.revocationEvidenceRef,
    ),
    checked_at: normalizeDate(
      options.revocation?.checkedAt ?? options.revocationCheckedAt,
    ),
  };
  if (['active', 'revoked'].includes(revocationCheck.status)
    && (!revocationCheck.evidence_ref || !revocationCheck.checked_at)) {
    throw new TypeError('active or revoked authority requires revocation evidenceRef and checkedAt');
  }
  const revocationStatus = normalizeEnum(
    revocationCheck.status,
    REVOCATION_STATUSES,
    'not_checked',
    'revocationStatus',
  );

  const budget = firstValue(artifact, ['budget', 'scope.budget', 'mandate.budget', 'policy.budget']) || {};
  const scope = firstValue(artifact, ['scope', 'constraints', 'mandate.scope', 'policy']) || {};
  const principalRef = normalizeString(firstValue(artifact, [
    'owner_id',
    'principal_id',
    'principal.ref',
    'principal.id',
    'consumer_id',
    'user_id',
    'mandate.principal_id',
  ]));
  const agentRef = normalizeString(firstValue(artifact, [
    'buyer_agent_id',
    'agent_id',
    'agent.id',
    'subject.agent_id',
    'mandate.agent_id',
    'sub',
  ]));
  const warnings = [];
  if (verification.status !== 'verified') {
    warnings.push('artifact was normalized but not cryptographically or institutionally verified');
  }
  if (!principalRef) warnings.push('principal reference was not found');
  if (!agentRef) warnings.push('agent reference was not found');
  if (revocationStatus === 'not_checked') warnings.push('revocation state was not checked');
  if (detected.protocol === 'other') warnings.push('protocol is unknown; use a versioned adapter or protocolHint');

  return {
    schema: 'agoragentic.normalized-authority.v1',
    source_protocol: detected.protocol,
    detection: {
      protocol: detected.protocol,
      confidence: detected.confidence,
      reasons: [...detected.reasons],
    },
    source_artifact_ref: normalizeString(options.artifactRef, `inline:${sha256Ref(artifact)}`),
    source_artifact_hash: sha256Ref(artifact),
    source_artifact_embedded: false,
    issuer_ref: normalizeString(firstValue(artifact, [
      'issuer_ref',
      'issuer.id',
      'issuer',
      'iss',
      'provider.id',
      'provider.name',
    ])),
    principal_ref: principalRef,
    agent_ref: agentRef,
    issued_at: normalizeDate(firstValue(artifact, ['issued_at', 'iat', 'created_at', 'mandate.issued_at'])),
    expires_at: normalizeDate(firstValue(artifact, ['expires_at', 'exp', 'valid_until', 'mandate.expires_at'])),
    audience: normalizeString(firstValue(artifact, ['audience', 'aud', 'merchant.audience', 'mandate.audience'])),
    merchant_binding: normalizeString(firstValue(artifact, [
      'merchant_binding',
      'merchant.id',
      'seller_id',
      'provider.id',
      'constraints.merchant_id',
    ])),
    allowed_actions: normalizeList(firstValue(scope, ['allowed_actions', 'actions', 'permissions'])),
    allowed_sellers: normalizeList(firstValue(scope, ['allowed_sellers', 'sellers', 'merchants'])),
    allowed_categories: normalizeList(firstValue(scope, ['allowed_categories', 'categories', 'merchant_categories'])),
    allowed_payment_rails: normalizeList(firstValue(scope, ['allowed_payment_rails', 'payment_rails', 'rails'])),
    currency: normalizeString(
      firstValue(budget, ['currency']) ?? firstValue(artifact, ['currency', 'payment.currency']),
      'USD',
      30,
    ),
    max_per_action: normalizeMoney(firstValue(budget, [
      'max_per_action',
      'max_per_transaction',
      'per_transaction',
      'transaction_limit',
    ]), '0'),
    max_daily: normalizeMoney(firstValue(budget, ['max_daily', 'daily', 'daily_limit']), '0'),
    max_total: normalizeMoney(firstValue(budget, ['max_total', 'total', 'total_limit']), '0'),
    verification,
    revocation_status: revocationStatus,
    revocation_check: revocationCheck,
    declared_revocation_status: declaredRevocationStatus(artifact),
    normalization_warnings: warnings,
    authority_flags: normalizedArtifactAuthorityFlags(),
  };
}

export function buildAuthorityRequest(input = {}) {
  const createdAt = requireDate(input.createdAt || new Date(), 'createdAt');
  const expiresAt = requireDate(
    input.expiresAt || new Date(Date.parse(createdAt) + 60 * 60 * 1000),
    'expiresAt',
  );
  const principalRef = normalizeString(input.principalRef);
  const agentId = normalizeString(input.agentId);
  const purpose = normalizeString(input.purpose);
  const allowedActions = normalizeList(input.allowedActions);
  if (!principalRef) throw new TypeError('principalRef is required');
  if (!agentId) throw new TypeError('agentId is required');
  if (!purpose) throw new TypeError('purpose is required');
  if (allowedActions.length === 0) throw new TypeError('at least one allowed action must be requested');

  const requestId = normalizeString(
    input.requestId,
    `aar_${sha256Ref({ principalRef, agentId, purpose, createdAt }).slice(7, 23)}`,
  );
  return {
    schema: 'agoragentic.agent-authority-request.v1',
    request_id: requestId,
    created_at: createdAt,
    expires_at: expiresAt,
    principal_ref: principalRef,
    agent: {
      agent_id: agentId,
      agent_uri: normalizeString(input.agentUri),
      public_key_ref: normalizeString(input.publicKeyRef),
    },
    requested_authority: {
      purpose,
      allowed_actions: allowedActions,
      allowed_sellers: normalizeList(input.allowedSellers),
      allowed_categories: normalizeList(input.allowedCategories),
      allowed_payment_rails: normalizeList(input.allowedPaymentRails),
      currency: normalizeString(input.currency, 'USD', 30),
      max_per_action: normalizeMoney(input.maxPerAction, '0'),
      max_daily: normalizeMoney(input.maxDaily, '0'),
      max_total: normalizeMoney(input.maxTotal, '0'),
    },
    controls: {
      idempotency_required: true,
      receipt_required: true,
      outcome_verification_required: input.outcomeVerificationRequired !== false,
      reconciliation_required: true,
      human_review_above: normalizeMoney(input.humanReviewAbove ?? input.maxPerAction, '0'),
    },
    status: 'pending_principal_approval',
    approval: null,
    request_grants_authority: false,
    authority_flags: noAuthorityFlags(),
    public_safe_summary: normalizeString(
      input.publicSafeSummary,
      `Agent ${agentId} requests bounded authority for: ${purpose}. This request grants no authority.`,
      2000,
    ),
  };
}

function authorityForEnvelope(normalizedAuthority) {
  if (!isPlainObject(normalizedAuthority)
    || normalizedAuthority.schema !== 'agoragentic.normalized-authority.v1') {
    throw new TypeError('normalizedAuthority must be produced by normalizeAuthorityArtifact');
  }
  const verificationStatus = normalizeEnum(
    normalizedAuthority.verification?.status,
    VERIFICATION_STATUSES,
    'unverified',
    'authority.verification_status',
  );
  const trustedBinding = trustedAuthorityBinding(normalizedAuthority);
  if (verificationStatus === 'verified'
    && TRUSTED_CALLBACK_PROTOCOLS.has(normalizedAuthority.source_protocol)
    && !trustedBinding) {
    throw new TypeError(
      'verified protocol authority must remain inside its trusted in-process verifier boundary',
    );
  }
  return {
    source_protocol: normalizedAuthority.source_protocol,
    source_artifact_ref: normalizedAuthority.source_artifact_ref,
    source_artifact_hash: normalizedAuthority.source_artifact_hash,
    issuer_ref: normalizedAuthority.issuer_ref,
    principal_ref: normalizeString(normalizedAuthority.principal_ref),
    agent_ref: normalizeString(normalizedAuthority.agent_ref),
    verification_status: verificationStatus,
    verification_verifier_ref: normalizeString(normalizedAuthority.verification?.verifier_ref),
    verification_evidence_ref: normalizeString(normalizedAuthority.verification?.evidence_ref),
    verification_checked_at: normalizeDate(normalizedAuthority.verification?.checked_at),
    verification_trust_mode: trustedBinding?.trust_mode || 'none',
    verification_binding_hash: trustedBinding?.binding_hash || null,
    issued_at: normalizedAuthority.issued_at,
    expires_at: normalizedAuthority.expires_at,
    revocation_status: normalizeEnum(
      normalizedAuthority.revocation_status,
      REVOCATION_STATUSES,
      'not_checked',
      'authority.revocation_status',
    ),
    revocation_evidence_ref: normalizeString(normalizedAuthority.revocation_check?.evidence_ref),
    revocation_checked_at: normalizeDate(normalizedAuthority.revocation_check?.checked_at),
    audience: normalizedAuthority.audience,
    merchant_binding: normalizedAuthority.merchant_binding,
    allowed_actions: normalizeList(normalizedAuthority.allowed_actions),
    allowed_sellers: normalizeList(normalizedAuthority.allowed_sellers),
    allowed_categories: normalizeList(normalizedAuthority.allowed_categories),
    allowed_payment_rails: normalizeList(normalizedAuthority.allowed_payment_rails),
    currency: normalizeString(normalizedAuthority.currency, 'USD', 30),
    max_per_action: normalizeMoney(normalizedAuthority.max_per_action, '0'),
    max_daily: normalizeMoney(normalizedAuthority.max_daily, '0'),
    max_total: normalizeMoney(normalizedAuthority.max_total, '0'),
  };
}

function expired(expiresAt, now) {
  if (!expiresAt) return false;
  const time = Date.parse(expiresAt);
  return Number.isFinite(time) && time <= now.getTime();
}

function deriveState(envelope, now) {
  if (envelope.reconciliation.status === 'refunded') return 'refunded';
  if (envelope.reconciliation.status === 'disputed') return 'disputed';
  if (envelope.reconciliation.status === 'failed' || envelope.execution.status === 'failed') return 'failed';
  if (envelope.reconciliation.status === 'complete'
    && envelope.outcome.verification_status === 'verified'
    && envelope.payment.settlement_verification === 'verified'
    && envelope.payment.settlement_final) return 'reconciled';
  if (envelope.outcome.verification_status === 'verified') return 'outcome_verified';
  if (envelope.execution.status === 'success') return 'execution_observed';
  if (['observed', 'settled'].includes(envelope.payment.status)) return 'payment_observed';
  if (['required', 'submitted'].includes(envelope.payment.status)) return 'payment_pending';
  if (envelope.authority.verification_status === 'verified'
    && envelope.authority.revocation_status === 'active'
    && !expired(envelope.authority.expires_at, now)
    && envelope.commercial_intent.terms_match_status === 'match') return 'authority_ready';
  return 'incomplete';
}

export function buildTransactionAssuranceEnvelope(input = {}) {
  const createdAt = requireDate(input.createdAt || new Date(), 'createdAt');
  const updatedAt = requireDate(input.updatedAt || createdAt, 'updatedAt');
  const authority = authorityForEnvelope(input.normalizedAuthority);
  const authorityPrincipalRef = normalizeString(input.normalizedAuthority?.principal_ref);
  const authorityAgentRef = normalizeString(input.normalizedAuthority?.agent_ref);
  const requestedPrincipalRef = normalizeString(input.principalRef);
  const requestedAgentRef = normalizeString(input.agentRef);
  if (!authorityPrincipalRef || !authorityAgentRef) {
    throw new TypeError('normalizedAuthority must bind principal_ref and agent_ref');
  }
  if (requestedPrincipalRef && requestedPrincipalRef !== authorityPrincipalRef) {
    throw new TypeError('principalRef must match normalizedAuthority.principal_ref');
  }
  if (requestedAgentRef && requestedAgentRef !== authorityAgentRef) {
    throw new TypeError('agentRef must match normalizedAuthority.agent_ref');
  }
  const principalRef = authorityPrincipalRef;
  const agentRef = authorityAgentRef;
  const intentInput = input.commercialIntent || {};
  const action = normalizeString(intentInput.action);
  const taskRef = normalizeString(intentInput.taskRef);
  const sellerRef = normalizeString(intentInput.sellerRef);
  const capabilityRef = normalizeString(intentInput.capabilityRef);
  if (!principalRef) throw new TypeError('principalRef is required');
  if (!agentRef) throw new TypeError('agentRef is required');
  if (!action || !taskRef || !sellerRef || !capabilityRef) {
    throw new TypeError('commercialIntent.action, taskRef, sellerRef, and capabilityRef are required');
  }

  const envelope = {
    schema: 'agoragentic.transaction-assurance-envelope.v1',
    envelope_id: normalizeString(
      input.envelopeId,
      `tae_${sha256Ref({ principalRef, agentRef, taskRef, createdAt }).slice(7, 23)}`,
    ),
    created_at: createdAt,
    updated_at: updatedAt,
    state: 'incomplete',
    principal: {
      principal_ref: principalRef,
      principal_type: normalizeEnum(
        input.principalType,
        PRINCIPAL_TYPES,
        'unknown',
        'principalType',
      ),
      identity_verification: normalizeEnum(
        input.principalIdentityVerification,
        VERIFICATION_STATUSES,
        'not_checked',
        'principalIdentityVerification',
      ),
      identity_evidence_ref: normalizeString(input.principalIdentityEvidenceRef),
    },
    agent: {
      agent_ref: agentRef,
      agent_uri: normalizeString(input.agentUri),
      operator_ref: normalizeString(input.operatorRef),
      identity_verification: normalizeEnum(
        input.agentIdentityVerification,
        VERIFICATION_STATUSES,
        'not_checked',
        'agentIdentityVerification',
      ),
      identity_evidence_ref: normalizeString(input.agentIdentityEvidenceRef),
    },
    authority,
    commercial_intent: {
      action,
      task_ref: taskRef,
      task_contract_hash: normalizeString(
        intentInput.taskContractHash,
        sha256Ref({ taskRef, action }),
      ),
      seller_ref: sellerRef,
      capability_ref: capabilityRef,
      category: normalizeString(intentInput.category),
      quote_ref: normalizeString(intentInput.quoteRef),
      quote_hash: normalizeString(intentInput.quoteHash),
      quoted_amount: normalizeMoney(intentInput.quotedAmount, '0'),
      currency: normalizeString(intentInput.currency || authority.currency, 'USD', 30),
      terms_ref: normalizeString(intentInput.termsRef),
      terms_hash: normalizeString(intentInput.termsHash),
      terms_match_status: normalizeEnum(
        intentInput.termsMatchStatus,
        TERMS_STATUSES,
        'not_checked',
        'commercialIntent.termsMatchStatus',
      ),
    },
    payment: {
      payment_identifier: normalizeString(input.payment?.paymentIdentifier),
      rail: normalizeString(input.payment?.rail),
      status: normalizeEnum(
        input.payment?.status,
        PAYMENT_STATUSES,
        'not_started',
        'payment.status',
      ),
      amount: normalizeMoney(input.payment?.amount ?? intentInput.quotedAmount, '0'),
      currency: normalizeString(
        input.payment?.currency || intentInput.currency || authority.currency,
        'USD',
        30,
      ),
      offer_ref: normalizeString(input.payment?.offerRef),
      offer_hash: normalizeString(input.payment?.offerHash),
      receipt_ref: normalizeString(input.payment?.receiptRef),
      receipt_hash: normalizeString(input.payment?.receiptHash),
      settlement_ref: normalizeString(input.payment?.settlementRef),
      settlement_verification: normalizeEnum(
        input.payment?.settlementVerification,
        VERIFICATION_STATUSES,
        'not_checked',
        'payment.settlementVerification',
      ),
      settlement_final: input.payment?.settlementFinal === true,
      daily_spend_before: normalizeOptionalMoney(input.payment?.dailySpendBefore),
      total_spend_before: normalizeOptionalMoney(input.payment?.totalSpendBefore),
      budget_usage_ref: normalizeString(input.payment?.budgetUsageRef),
    },
    execution: {
      idempotency_key_hash: normalizeString(input.execution?.idempotencyKeyHash),
      invocation_ref: normalizeString(input.execution?.invocationRef),
      status: normalizeEnum(
        input.execution?.status,
        EXECUTION_STATUSES,
        'not_started',
        'execution.status',
      ),
      attempt_count: Number.isInteger(input.execution?.attemptCount)
        ? input.execution.attemptCount
        : 0,
      duplicate_detected: input.execution?.duplicateDetected === true,
      input_hash: normalizeString(input.execution?.inputHash),
      output_hash: normalizeString(input.execution?.outputHash),
      started_at: normalizeDate(input.execution?.startedAt),
      completed_at: normalizeDate(input.execution?.completedAt),
    },
    outcome: {
      delivery_status: normalizeEnum(
        input.outcome?.deliveryStatus,
        DELIVERY_STATUSES,
        'not_observed',
        'outcome.deliveryStatus',
      ),
      artifact_refs: normalizeList(input.outcome?.artifactRefs),
      seller_attestation_ref: normalizeString(input.outcome?.sellerAttestationRef),
      validation_refs: normalizeList(input.outcome?.validationRefs),
      verification_status: normalizeEnum(
        input.outcome?.verificationStatus,
        VERIFICATION_STATUSES,
        'not_checked',
        'outcome.verificationStatus',
      ),
      verification_scope: normalizeString(
        input.outcome?.verificationScope,
        'No outcome verification has been supplied.',
        3000,
      ),
      unknowns: normalizeList(input.outcome?.unknowns),
    },
    reconciliation: {
      status: normalizeEnum(
        input.reconciliation?.status,
        RECONCILIATION_STATUSES,
        'not_started',
        'reconciliation.status',
      ),
      result: normalizeString(
        input.reconciliation?.result,
        'No reconciliation has been completed.',
        3000,
      ),
      refund_ref: normalizeString(input.reconciliation?.refundRef),
      dispute_ref: normalizeString(input.reconciliation?.disputeRef),
      next_safe_action: normalizeString(
        input.reconciliation?.nextSafeAction,
        'Verify missing authority, payment, execution, outcome, and finality evidence before changing state.',
        3000,
      ),
    },
    evidence: {
      refs: normalizeList(input.evidenceRefs),
      envelope_hash: null,
      complete_chain_verified: false,
    },
    redaction: {
      verification_status: 'not_verified',
      raw_prompt_excluded: false,
      raw_tool_output_excluded: false,
      raw_payment_credentials_excluded: false,
      raw_wallet_private_data_excluded: false,
      private_owner_data_excluded: false,
      secrets_excluded: false,
    },
    authority_flags: envelopeAuthorityFlags(),
    public_safe_summary: normalizeString(
      input.publicSafeSummary,
      `Transaction assurance envelope for ${action}; no authority is granted by this envelope.`,
      3000,
    ),
  };

  const now = input.now ? new Date(input.now) : new Date(createdAt);
  if (Number.isNaN(now.getTime())) throw new TypeError('now must be a valid date-time');
  const derivedState = deriveState(envelope, now);
  if (input.state !== undefined
    && normalizeEnum(input.state, ASSURANCE_STATES, 'incomplete', 'state') !== derivedState) {
    throw new TypeError(`state must match derived transaction state: ${derivedState}`);
  }
  envelope.state = derivedState;
  envelope.evidence.envelope_hash = computeEnvelopeHash(envelope);
  if (authority.verification_trust_mode === 'trusted_callback') {
    bindTrustedEnvelope(envelope, {
      trust_mode: authority.verification_trust_mode,
      verifier_ref: authority.verification_verifier_ref,
      binding_hash: authority.verification_binding_hash,
    });
  }
  return envelope;
}

function greaterThan(left, right) {
  return compareMoney(left, right) > 0;
}

function addUnique(list, value) {
  if (value && !list.includes(value)) list.push(value);
}

export function evaluateTransactionAssuranceEnvelope(envelope, options = {}) {
  if (!isPlainObject(envelope)
    || envelope.schema !== 'agoragentic.transaction-assurance-envelope.v1') {
    throw new TypeError('envelope must use agoragentic.transaction-assurance-envelope.v1');
  }
  const phase = normalizeEnum(
    options.phase,
    ['pre_execution', 'post_execution'],
    'pre_execution',
    'phase',
  );
  const now = options.now ? new Date(options.now) : new Date();
  if (Number.isNaN(now.getTime())) throw new TypeError('options.now must be a valid date');

  const blockers = [];
  const warnings = [];
  const authority = envelope.authority || {};
  const intent = envelope.commercial_intent || {};
  const payment = envelope.payment || {};
  const execution = envelope.execution || {};
  const outcome = envelope.outcome || {};
  const reconciliation = envelope.reconciliation || {};
  const trustedEnvelope = trustedEnvelopeBinding(envelope);

  if (authority.verification_status !== 'verified') addUnique(blockers, 'authority_not_verified');
  if (authority.verification_status === 'verified'
    && TRUSTED_CALLBACK_PROTOCOLS.has(authority.source_protocol)
    && (!trustedEnvelope
      || trustedEnvelope.trust_mode !== 'trusted_callback'
      || trustedEnvelope.verifier_ref !== authority.verification_verifier_ref
      || trustedEnvelope.binding_hash !== authority.verification_binding_hash)) {
    addUnique(blockers, 'authority_verifier_boundary_not_trusted');
  }
  if (!authority.verification_verifier_ref
    || !authority.verification_evidence_ref
    || !authority.verification_checked_at) addUnique(blockers, 'authority_verification_evidence_missing');
  if (authority.revocation_status === 'revoked') addUnique(blockers, 'authority_revoked');
  else if (authority.revocation_status !== 'active') addUnique(blockers, 'authority_revocation_not_verified_active');
  if (!authority.revocation_evidence_ref || !authority.revocation_checked_at) {
    addUnique(blockers, 'authority_revocation_evidence_missing');
  }
  if (expired(authority.expires_at, now)) addUnique(blockers, 'authority_expired');
  if (authority.issued_at && Date.parse(authority.issued_at) > now.getTime()) addUnique(blockers, 'authority_not_yet_valid');
  if (authority.verification_checked_at
    && Date.parse(authority.verification_checked_at) > now.getTime()) addUnique(blockers, 'authority_verification_from_future');
  if (authority.revocation_checked_at
    && Date.parse(authority.revocation_checked_at) > now.getTime()) addUnique(blockers, 'authority_revocation_check_from_future');
  if (authority.principal_ref !== envelope.principal?.principal_ref) addUnique(blockers, 'authority_principal_mismatch');
  if (authority.agent_ref !== envelope.agent?.agent_ref) addUnique(blockers, 'authority_agent_mismatch');
  if (envelope.principal?.identity_verification !== 'verified'
    || !envelope.principal?.identity_evidence_ref) addUnique(blockers, 'principal_identity_not_verified');
  if (envelope.agent?.identity_verification !== 'verified'
    || !envelope.agent?.identity_evidence_ref) addUnique(blockers, 'agent_identity_not_verified');
  if (authority.audience && authority.audience !== envelope.agent?.agent_ref) addUnique(blockers, 'authority_audience_mismatch');
  if (authority.merchant_binding && authority.merchant_binding !== intent.seller_ref) addUnique(blockers, 'merchant_binding_mismatch');
  if (!Array.isArray(authority.allowed_actions) || authority.allowed_actions.length === 0) addUnique(blockers, 'authority_actions_missing');
  else if (!authority.allowed_actions.includes(intent.action)) addUnique(blockers, 'action_out_of_scope');
  if (!Array.isArray(authority.allowed_sellers) || authority.allowed_sellers.length === 0) addUnique(blockers, 'authority_sellers_missing');
  else if (!authority.allowed_sellers.includes(intent.seller_ref)) addUnique(blockers, 'seller_out_of_scope');
  if (!Array.isArray(authority.allowed_categories) || authority.allowed_categories.length === 0) addUnique(blockers, 'authority_categories_missing');
  else if (!authority.allowed_categories.includes(intent.category)) addUnique(blockers, 'category_out_of_scope');
  if (!Array.isArray(authority.allowed_payment_rails) || authority.allowed_payment_rails.length === 0) addUnique(blockers, 'authority_payment_rails_missing');
  else if (!authority.allowed_payment_rails.includes(payment.rail)) addUnique(blockers, 'payment_rail_out_of_scope');
  if (authority.currency !== intent.currency || authority.currency !== payment.currency) addUnique(blockers, 'currency_mismatch');
  if (greaterThan(intent.quoted_amount, authority.max_per_action)) addUnique(blockers, 'quoted_amount_exceeds_per_action_limit');
  if (greaterThan(payment.amount, authority.max_per_action)) addUnique(blockers, 'payment_amount_exceeds_per_action_limit');
  if (greaterThan(payment.amount, intent.quoted_amount)) addUnique(blockers, 'payment_amount_exceeds_quote');
  if (payment.daily_spend_before === null || payment.daily_spend_before === undefined
    || payment.total_spend_before === null || payment.total_spend_before === undefined
    || !payment.budget_usage_ref) addUnique(blockers, 'budget_usage_evidence_missing');
  else {
    if (greaterThan(addMoney(payment.daily_spend_before, payment.amount), authority.max_daily)) {
      addUnique(blockers, 'payment_amount_exceeds_daily_limit');
    }
    if (greaterThan(addMoney(payment.total_spend_before, payment.amount), authority.max_total)) {
      addUnique(blockers, 'payment_amount_exceeds_total_limit');
    }
  }
  if (!payment.payment_identifier) addUnique(blockers, 'payment_identifier_missing');
  if (!intent.quote_ref || !intent.quote_hash) addUnique(blockers, 'quote_evidence_missing');
  if (!intent.terms_ref || !intent.terms_hash) addUnique(blockers, 'terms_evidence_missing');
  if (intent.terms_match_status === 'changed') addUnique(blockers, 'terms_changed');
  else if (intent.terms_match_status !== 'match') addUnique(blockers, 'terms_not_verified');
  if (!execution.idempotency_key_hash) addUnique(blockers, 'idempotency_key_missing');
  if (execution.duplicate_detected) addUnique(blockers, 'duplicate_attempt_detected');
  if (!execution.input_hash) addUnique(warnings, 'input_hash_missing');
  const expectedEnvelopeHash = computeEnvelopeHash(envelope);
  if (envelope.evidence?.envelope_hash !== expectedEnvelopeHash) addUnique(blockers, 'envelope_hash_mismatch');

  if (phase === 'post_execution') {
    if (!['observed', 'settled', 'refunded'].includes(payment.status)) addUnique(blockers, 'payment_not_observed');
    if (payment.settlement_verification !== 'verified') addUnique(blockers, 'settlement_not_verified');
    if (!payment.settlement_final && payment.status !== 'refunded') addUnique(blockers, 'settlement_not_final');
    if (!payment.receipt_ref || !payment.receipt_hash) addUnique(blockers, 'payment_receipt_evidence_missing');
    if (!payment.settlement_ref) addUnique(blockers, 'settlement_reference_missing');
    if (execution.status !== 'success') addUnique(blockers, 'execution_not_successful');
    if (!execution.invocation_ref) addUnique(blockers, 'invocation_reference_missing');
    if (!execution.output_hash) addUnique(blockers, 'output_hash_missing');
    if (outcome.delivery_status !== 'delivered') addUnique(blockers, 'delivery_not_confirmed');
    if (!Array.isArray(outcome.artifact_refs) || outcome.artifact_refs.length === 0) addUnique(blockers, 'outcome_artifact_evidence_missing');
    if (!outcome.seller_attestation_ref) addUnique(blockers, 'seller_attestation_missing');
    if (!Array.isArray(outcome.validation_refs) || outcome.validation_refs.length === 0) addUnique(blockers, 'outcome_validation_evidence_missing');
    if (outcome.verification_status !== 'verified') addUnique(blockers, 'outcome_not_verified');
    if (!['complete', 'refunded'].includes(reconciliation.status)) addUnique(blockers, 'reconciliation_not_complete');
    if (!Array.isArray(envelope.evidence?.refs) || envelope.evidence.refs.length === 0) addUnique(blockers, 'evidence_chain_refs_missing');
  }

  const hardDenyCodes = new Set([
    'authority_not_verified',
    'authority_verifier_boundary_not_trusted',
    'authority_verification_evidence_missing',
    'authority_revoked',
    'authority_expired',
    'authority_not_yet_valid',
    'authority_verification_from_future',
    'authority_revocation_check_from_future',
    'authority_principal_mismatch',
    'authority_agent_mismatch',
    'principal_identity_not_verified',
    'agent_identity_not_verified',
    'authority_audience_mismatch',
    'merchant_binding_mismatch',
    'authority_actions_missing',
    'authority_sellers_missing',
    'authority_categories_missing',
    'authority_payment_rails_missing',
    'action_out_of_scope',
    'seller_out_of_scope',
    'category_out_of_scope',
    'payment_rail_out_of_scope',
    'currency_mismatch',
    'quoted_amount_exceeds_per_action_limit',
    'payment_amount_exceeds_per_action_limit',
    'payment_amount_exceeds_quote',
    'payment_amount_exceeds_daily_limit',
    'payment_amount_exceeds_total_limit',
    'payment_identifier_missing',
    'terms_changed',
    'duplicate_attempt_detected',
    'envelope_hash_mismatch',
  ]);
  const hardDeny = blockers.some((blocker) => hardDenyCodes.has(blocker));
  const completeChainVerified = phase === 'post_execution' && blockers.length === 0;
  const decision = hardDeny
    ? 'deny'
    : blockers.length > 0
      ? 'review'
      : phase === 'pre_execution'
        ? 'allow'
        : 'complete';

  let nextSafeAction = 'No further action is required.';
  if (decision === 'deny') {
    nextSafeAction = 'Stop. Obtain corrected principal authority or corrected commercial terms before proceeding.';
  } else if (decision === 'review') {
    nextSafeAction = 'Do not guess or blindly retry. Collect missing evidence and re-evaluate the same payment and idempotency identifiers.';
  } else if (decision === 'allow') {
    nextSafeAction = 'Re-check live rail availability, execute once with the approved identifiers, and preserve all returned evidence.';
  }

  return {
    schema: 'agoragentic.transaction-assurance-evaluation.v1',
    phase,
    decision,
    complete_chain_verified: completeChainVerified,
    blockers,
    warnings,
    next_safe_action: nextSafeAction,
    evaluated_at: now.toISOString(),
    evidence: {
      envelope_id: envelope.envelope_id || null,
      envelope_hash: expectedEnvelopeHash,
    },
    authority_flags: evaluationAuthorityFlags(),
  };
}

export {
  PROTOCOL_ADAPTER_PINS,
  bindX402OutcomeEvidence,
  normalizeAp2Authority,
  normalizeCircleWalletPolicyEvidence,
  normalizeMastercardVerifiableIntentEvidence,
  normalizeOfficialAcpEvidence,
  normalizeSkyfireKyaPayEvidence,
  normalizeVisaTapEvidence,
  normalizeX402Evidence,
} from './protocol-adapters.mjs';
