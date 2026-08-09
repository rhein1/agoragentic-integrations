import fs from 'node:fs';

import Ajv2020 from 'ajv/dist/2020.js';
import addFormats from 'ajv-formats';

import {
  canonicalize,
  normalizeAuthorityArtifact,
  sha256Ref,
} from './index.mjs';
import { bindTrustedAuthority } from './trusted-verifier-boundary.mjs';

export const PROTOCOL_ADAPTER_PINS = Object.freeze({
  google_ap2: Object.freeze({
    version: 'v0.2.0',
    revision: 'b4587ac1d055888a73b4b21750973cffba961793',
    source: 'https://github.com/google-agentic-commerce/AP2/tree/v0.2.0',
  }),
  visa_tap: Object.freeze({
    version: 'commit-16d59bdf',
    revision: '16d59bdf3f8a542bc538d0962edbb80ea30a02af',
    source: 'https://github.com/visa/trusted-agent-protocol/tree/16d59bdf3f8a542bc538d0962edbb80ea30a02af',
  }),
  openai_stripe_acp: Object.freeze({
    version: '2026-04-17',
    revision: '7fdd78df677a94dce04c770644b0fbbb1401272b',
    source: 'https://github.com/agentic-commerce-protocol/agentic-commerce-protocol/tree/7fdd78df677a94dce04c770644b0fbbb1401272b/spec/2026-04-17',
  }),
  x402: Object.freeze({
    version: '2.21.0',
    wire_version: 2,
    offer_receipt_version: 1,
    revision: '34cb6bd04c88f4333f56b9c778d3d35df997379c',
    source: 'https://github.com/x402-foundation/x402/tree/34cb6bd04c88f4333f56b9c778d3d35df997379c/specs/extensions',
  }),
  circle_agent_wallet_policy: Object.freeze({
    version: 'circle-skills-c7d269a2',
    revision: 'c7d269a2025e26410e0e23fb5a73c769dc07d088',
    source: 'https://github.com/circlefin/skills/tree/c7d269a2025e26410e0e23fb5a73c769dc07d088/plugins/circle/skills/agent-wallet-policy',
  }),
  skyfire_kyapay: Object.freeze({
    version: 'kyapay-869a71ae',
    revision: '869a71ae6f6b6646ad62ac78b6877c41784ef34e',
    source: 'https://github.com/skyfire-xyz/kyapay/tree/869a71ae6f6b6646ad62ac78b6877c41784ef34e',
  }),
  mastercard_verifiable_intent: Object.freeze({
    version: 'public-materials-2026-08-08',
    revision: 'public-materials-snapshot-2026-08-08',
    source: 'https://www.mastercard.com/news/press/2025/april/mastercard-unveils-agent-pay/',
  }),
});

const VERIFIER_SCHEMA = 'agoragentic.protocol-verifier-evidence.v1';
const SIGNED_ARTIFACT_VERIFIER_SCHEMA = 'agoragentic.signed-artifact-verifier-evidence.v1';
const VERIFIER_STATUSES = new Set(['unverified', 'verified', 'failed', 'unknown']);
const REVOCATION_STATUSES = new Set(['not_checked', 'active', 'revoked', 'unknown']);
const ACP_CHECKOUT_STATUSES = new Set([
  'incomplete',
  'not_ready_for_payment',
  'requires_escalation',
  'authentication_required',
  'ready_for_payment',
  'pending_approval',
  'complete_in_progress',
  'completed',
  'canceled',
  'in_progress',
  'expired',
]);
const X402_SUBMISSION_STATUSES = new Set(['not_submitted', 'submitted', 'unknown']);
const X402_OBSERVATION_STATUSES = new Set(['not_observed', 'observed', 'failed', 'unknown']);
const X402_SETTLEMENT_STATUSES = new Set([
  'not_checked',
  'pending',
  'settled',
  'failed',
  'refunded',
  'unknown',
]);
const MONEY_PATTERN = /^(0|[1-9]\d*)(\.\d{1,6})?$/;
const CIRCLE_MAINNET_CHAINS = new Set(['BASE']);
const ACP_SCHEMA = JSON.parse(fs.readFileSync(
  new URL('../vendor/acp-2026-04-17/schema.agentic_checkout.json', import.meta.url),
  'utf8',
));
const acpAjv = new Ajv2020({
  allErrors: true,
  strict: true,
  strictRequired: false,
  strictSchema: false,
});
addFormats(acpAjv);
acpAjv.addSchema(ACP_SCHEMA);
const validateAcpCompleteRequest = acpAjv.compile({
  $ref: `${ACP_SCHEMA.$id}#/$defs/CheckoutSessionCompleteRequest`,
});

function object(value, field) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new TypeError(`${field} must be an object`);
  }
  return value;
}

function text(value, field, { optional = false, max = 2000 } = {}) {
  if ((value === undefined || value === null || value === '') && optional) return null;
  if (typeof value !== 'string' || !value.trim()) throw new TypeError(`${field} is required`);
  return value.trim().slice(0, max);
}

function list(value, field, { optional = false } = {}) {
  if ((value === undefined || value === null) && optional) return [];
  if (!Array.isArray(value) || value.length === 0) throw new TypeError(`${field} must be a non-empty array`);
  const result = value.map((item) => text(item, field));
  if (new Set(result).size !== result.length) throw new TypeError(`${field} must contain unique values`);
  return result;
}

function money(value, field) {
  const normalized = text(value, field, { max: 100 });
  if (!MONEY_PATTERN.test(normalized)) throw new TypeError(`${field} must be a decimal string`);
  return normalized;
}

function decimal(value, field) {
  if (typeof value === 'number' && Number.isFinite(value)) return money(String(value), field);
  return money(value, field);
}

function requiredBoolean(value, field) {
  if (typeof value !== 'boolean') throw new TypeError(`${field} must be boolean`);
  return value;
}

function requiredInteger(value, field) {
  if (!Number.isSafeInteger(value)) throw new TypeError(`${field} must be a safe integer`);
  return value;
}

function rejectRawMaterial(value, fields, context) {
  for (const field of fields) {
    if (path(value, field) !== undefined) {
      throw new TypeError(`${context} must not contain raw credential or signature material: ${field}`);
    }
  }
}

function paymentItem(value, field) {
  const item = object(value, field);
  const amount = object(item.amount ?? item, `${field}.amount`);
  return {
    currency: text(amount.currency, `${field}.amount.currency`, { max: 30 }).toUpperCase(),
    value: decimal(amount.value, `${field}.amount.value`),
  };
}

function enumeration(value, field, allowed) {
  const normalized = text(value, field, { max: 100 });
  if (!allowed.has(normalized)) throw new TypeError(`${field} is unsupported`);
  return normalized;
}

function iso(value, field, { optional = false } = {}) {
  if ((value === undefined || value === null || value === '') && optional) return null;
  const date = typeof value === 'number' && Number.isFinite(value)
    ? new Date(value > 10_000_000_000 ? value : value * 1000)
    : new Date(value);
  if (Number.isNaN(date.getTime())) throw new TypeError(`${field} must be a date-time`);
  return date.toISOString();
}

function path(value, dotted) {
  let cursor = value;
  for (const part of dotted.split('.')) {
    if (!cursor || typeof cursor !== 'object' || !(part in cursor)) return undefined;
    cursor = cursor[part];
  }
  return cursor;
}

function first(value, paths) {
  for (const candidate of paths) {
    const found = path(value, candidate);
    if (found !== undefined && found !== null && found !== '') return found;
  }
  return undefined;
}

function exactVersion(artifact, options, pin, paths = ['protocol_version', 'protocol.version']) {
  const declarations = [options.version, ...paths.map((candidate) => path(artifact, candidate))]
    .filter((value) => value !== undefined && value !== null && value !== '');
  if (declarations.length === 0) {
    throw new TypeError(`protocol version is required: expected ${pin.version}`);
  }
  if (declarations.some((value) => value !== pin.version)) {
    throw new TypeError(`unsupported or conflicting protocol version: expected ${pin.version}`);
  }
  return pin.version;
}

function requireAcpSchema(value, validator, field) {
  if (validator(value)) return;
  const details = (validator.errors || [])
    .slice(0, 8)
    .map((error) => `${error.instancePath || '/'} ${error.keyword}`)
    .join(', ');
  throw new TypeError(`${field} does not match ACP ${PROTOCOL_ADAPTER_PINS.openai_stripe_acp.version}${details ? `: ${details}` : ''}`);
}

function cleanBindings(input) {
  const value = object(input, 'bindings');
  return {
    issuer_ref: text(value.issuerRef, 'bindings.issuerRef'),
    principal_ref: text(value.principalRef, 'bindings.principalRef'),
    agent_ref: text(value.agentRef, 'bindings.agentRef'),
    audience: text(value.audience, 'bindings.audience'),
    merchant_binding: text(value.merchantRef, 'bindings.merchantRef'),
    allowed_actions: list(value.allowedActions, 'bindings.allowedActions'),
    allowed_sellers: list(value.allowedSellers ?? [value.merchantRef], 'bindings.allowedSellers'),
    allowed_categories: list(value.allowedCategories, 'bindings.allowedCategories'),
    allowed_payment_rails: list(value.allowedPaymentRails, 'bindings.allowedPaymentRails'),
    currency: text(value.currency, 'bindings.currency', { max: 30 }).toUpperCase(),
    max_per_action: money(value.maxPerAction, 'bindings.maxPerAction'),
    max_daily: money(value.maxDaily, 'bindings.maxDaily'),
    max_total: money(value.maxTotal, 'bindings.maxTotal'),
  };
}

function trustedVerifierEvidence(value, context) {
  if (value === undefined || value === null) {
    return {
      verification: { status: 'unverified' },
      revocation: { status: 'not_checked' },
      checks: [],
      trusted: false,
    };
  }
  const verifier = object(value, context.field || 'verifier');
  const verifierId = text(verifier.id, `${context.field || 'verifier'}.id`);
  if (typeof verifier.verify !== 'function') {
    throw new TypeError(`${context.field || 'verifier'}.verify must be a trusted in-process callback`);
  }
  const result = verifier.verify(Object.freeze({
    protocol: context.protocol,
    version: context.version,
    artifact_kind: context.artifactKind,
    artifact_hash: context.artifactHash,
    binding_hash: context.bindingHash,
    required_checks: Object.freeze([...context.requiredChecks]),
  }));
  if (result && typeof result.then === 'function') {
    throw new TypeError(`${context.field || 'verifier'}.verify must return synchronously`);
  }
  const evidence = object(result, `${context.field || 'verifier'}.result`);
  const expected = new Set([
    'schema',
    'protocol',
    'version',
    'artifact_hash',
    'binding_hash',
    'status',
    'verifier_ref',
    'evidence_ref',
    'checked_at',
    'revocation_status',
    'revocation_evidence_ref',
    'revocation_checked_at',
    'checks',
  ]);
  if (Object.keys(evidence).some((key) => !expected.has(key))
    || [...expected].some((key) => !(key in evidence))) {
    throw new TypeError('trusted verifier result must use the exact v1 field set');
  }
  if (evidence.schema !== VERIFIER_SCHEMA) throw new TypeError('unsupported verifier evidence schema');
  if (evidence.protocol !== context.protocol || evidence.version !== context.version) {
    throw new TypeError('verifierEvidence protocol or version mismatch');
  }
  if (evidence.artifact_hash !== context.artifactHash
    || evidence.binding_hash !== context.bindingHash) {
    throw new TypeError('verifierEvidence artifact or binding hash mismatch');
  }
  if (!VERIFIER_STATUSES.has(evidence.status)) throw new TypeError('invalid verifierEvidence status');
  if (!REVOCATION_STATUSES.has(evidence.revocation_status)) {
    throw new TypeError('invalid verifierEvidence revocation_status');
  }
  const checks = object(evidence.checks, 'verifierEvidence.checks');
  const checkKeys = Object.keys(checks).sort();
  const required = [...context.requiredChecks].sort();
  if (canonicalize(checkKeys) !== canonicalize(required)
    || Object.values(checks).some((item) => typeof item !== 'boolean')) {
    throw new TypeError(`verifierEvidence.checks must contain exactly: ${required.join(', ')}`);
  }
  if (evidence.status === 'verified' && required.some((key) => checks[key] !== true)) {
    throw new TypeError('verified evidence requires every protocol check to pass');
  }
  if (evidence.status === 'verified' && evidence.revocation_status !== 'active') {
    throw new TypeError('verified authority requires an active revocation result');
  }
  const verifierRef = text(evidence.verifier_ref, 'verifierEvidence.verifier_ref');
  if (verifierRef !== verifierId) {
    throw new TypeError('trusted verifier id does not match verifier_ref');
  }
  const evidenceRef = text(evidence.evidence_ref, 'verifierEvidence.evidence_ref');
  const checkedAt = iso(evidence.checked_at, 'verifierEvidence.checked_at');
  const revocationEvidenceRef = evidence.revocation_status === 'not_checked'
    ? text(evidence.revocation_evidence_ref, 'verifierEvidence.revocation_evidence_ref', { optional: true })
    : text(evidence.revocation_evidence_ref, 'verifierEvidence.revocation_evidence_ref');
  const revocationCheckedAt = evidence.revocation_status === 'not_checked'
    ? iso(evidence.revocation_checked_at, 'verifierEvidence.revocation_checked_at', { optional: true })
    : iso(evidence.revocation_checked_at, 'verifierEvidence.revocation_checked_at');
  return {
    verification: {
      status: evidence.status,
      verifierRef,
      evidenceRef,
      checkedAt,
    },
    revocation: {
      status: evidence.revocation_status,
      evidenceRef: revocationEvidenceRef,
      checkedAt: revocationCheckedAt,
    },
    checks: checkKeys,
    trusted: true,
  };
}

function signedArtifactVerifierEvidence(value, context) {
  if (value === undefined || value === null) {
    return {
      status: 'unverified',
      verifier_ref: null,
      evidence_ref: null,
      checked_at: null,
      checks: [],
      trusted: false,
    };
  }
  const verifier = object(value, context.field);
  const verifierId = text(verifier.id, `${context.field}.id`);
  if (typeof verifier.verify !== 'function') {
    throw new TypeError(`${context.field}.verify must be a trusted in-process callback`);
  }
  const result = verifier.verify(Object.freeze({
    protocol: context.protocol,
    version: context.version,
    artifact_kind: context.artifactKind,
    artifact_hash: context.artifactHash,
    binding_hash: context.bindingHash,
    required_checks: Object.freeze([...context.requiredChecks]),
  }));
  if (result && typeof result.then === 'function') {
    throw new TypeError(`${context.field}.verify must return synchronously`);
  }
  const evidence = object(result, `${context.field}.result`);
  const expected = new Set([
    'schema',
    'protocol',
    'version',
    'artifact_hash',
    'binding_hash',
    'status',
    'verifier_ref',
    'evidence_ref',
    'checked_at',
    'checks',
  ]);
  if (Object.keys(evidence).some((key) => !expected.has(key))
    || [...expected].some((key) => !(key in evidence))) {
    throw new TypeError(`${context.field} must use the exact signed-artifact v1 field set`);
  }
  if (evidence.schema !== SIGNED_ARTIFACT_VERIFIER_SCHEMA) {
    throw new TypeError(`unsupported ${context.field} schema`);
  }
  if (evidence.protocol !== context.protocol || evidence.version !== context.version) {
    throw new TypeError(`${context.field} protocol or version mismatch`);
  }
  if (evidence.artifact_hash !== context.artifactHash
    || evidence.binding_hash !== context.bindingHash) {
    throw new TypeError(`${context.field} artifact or binding hash mismatch`);
  }
  if (!VERIFIER_STATUSES.has(evidence.status)) {
    throw new TypeError(`invalid ${context.field} status`);
  }
  const checks = object(evidence.checks, `${context.field}.checks`);
  const checkKeys = Object.keys(checks).sort();
  const required = [...context.requiredChecks].sort();
  if (canonicalize(checkKeys) !== canonicalize(required)
    || Object.values(checks).some((item) => typeof item !== 'boolean')) {
    throw new TypeError(`${context.field}.checks must contain exactly: ${required.join(', ')}`);
  }
  if (evidence.status === 'verified' && required.some((key) => checks[key] !== true)) {
    throw new TypeError(`verified ${context.field} requires every check to pass`);
  }
  const verifierRef = text(evidence.verifier_ref, `${context.field}.verifier_ref`);
  if (verifierRef !== verifierId) {
    throw new TypeError(`${context.field}.id does not match verifier_ref`);
  }
  return {
    status: evidence.status,
    verifier_ref: verifierRef,
    evidence_ref: text(evidence.evidence_ref, `${context.field}.evidence_ref`),
    checked_at: iso(evidence.checked_at, `${context.field}.checked_at`),
    checks: checkKeys,
    trusted: true,
  };
}

function authorityFromProtocol({
  artifact,
  options,
  protocol,
  pin,
  version,
  artifactKind,
  requiredChecks,
  unsupportedFields = [],
  protocolEvidence = {},
}) {
  object(artifact, 'artifact');
  if (options.verifierEvidence !== undefined) {
    throw new TypeError(
      'portable verifierEvidence JSON is not trusted; supply a trusted in-process verifier callback',
    );
  }
  const bindings = cleanBindings(options.bindings);
  const artifactHash = sha256Ref(artifact);
  const bindingHash = sha256Ref(bindings);
  const evidence = trustedVerifierEvidence(options.verifier, {
    field: 'verifier',
    protocol,
    version,
    artifactKind,
    artifactHash,
    bindingHash,
    requiredChecks,
  });
  const normalized = normalizeAuthorityArtifact(artifact, {
    protocolHint: protocol,
    artifactRef: text(options.artifactRef, 'artifactRef'),
    verification: evidence.verification,
    revocation: evidence.revocation,
  });
  const result = {
    ...normalized,
    issuer_ref: bindings.issuer_ref,
    principal_ref: bindings.principal_ref,
    agent_ref: bindings.agent_ref,
    issued_at: iso(options.issuedAt ?? first(artifact, ['iat', 'issued_at', 'created_at']), 'issuedAt'),
    expires_at: iso(options.expiresAt ?? first(artifact, ['exp', 'expires_at']), 'expiresAt'),
    audience: bindings.audience,
    merchant_binding: bindings.merchant_binding,
    allowed_actions: bindings.allowed_actions,
    allowed_sellers: bindings.allowed_sellers,
    allowed_categories: bindings.allowed_categories,
    allowed_payment_rails: bindings.allowed_payment_rails,
    currency: bindings.currency,
    max_per_action: bindings.max_per_action,
    max_daily: bindings.max_daily,
    max_total: bindings.max_total,
    normalization_warnings: [
      ...normalized.normalization_warnings,
      `adapter pinned to ${protocol} ${version} at ${pin.revision}`,
      ...(evidence.verification.status === 'verified'
        ? []
        : ['adapter parsing did not establish verified authority']),
      ...unsupportedFields.map((field) => `unsupported source field: ${field}`),
    ],
    protocol_binding: {
      version,
      source_revision: pin.revision,
      artifact_kind: artifactKind,
      binding_hash: bindingHash,
      verifier_checks: evidence.checks,
      verifier_trust_mode: evidence.trusted ? 'trusted_callback' : 'none',
      verifier_ref: evidence.verification.verifierRef || null,
      protocol_evidence: {
        subject_ref: protocolEvidence.subject_ref || null,
        counterparty_ref: protocolEvidence.counterparty_ref || null,
        asset_ref: protocolEvidence.asset_ref || null,
        scope_ref: protocolEvidence.scope_ref || null,
        policy_state: protocolEvidence.policy_state || null,
        environment: protocolEvidence.environment || null,
      },
      unsupported_fields: [...unsupportedFields],
      raw_signature_material_embedded: false,
      raw_payment_material_embedded: false,
    },
  };
  if (evidence.verification.status === 'verified') {
    bindTrustedAuthority(result, {
      trust_mode: 'trusted_callback',
      verifier_ref: evidence.verification.verifierRef,
      binding_hash: bindingHash,
      artifact_hash: artifactHash,
    });
  }
  return result;
}

function boundedEvidenceBase(schema, protocol, pin, version, artifact, options) {
  object(artifact, 'artifact');
  const artifactHash = sha256Ref(artifact);
  return {
    schema,
    source_protocol: protocol,
    protocol_version: version,
    source_revision: pin.revision,
    source_artifact_ref: text(options.artifactRef, 'artifactRef'),
    source_artifact_hash: artifactHash,
    source_artifact_embedded: false,
    source: pin.source,
  };
}

function noAuthority() {
  return {
    evidence_grants_authority: false,
    can_spend: false,
    can_execute: false,
    can_fund_wallet: false,
    can_publish: false,
    can_deploy: false,
    can_change_trust: false,
  };
}

export function normalizeAp2Authority(artifact, options = {}) {
  const pin = PROTOCOL_ADAPTER_PINS.google_ap2;
  const version = exactVersion(artifact, options, pin, [
    'protocol_version',
    'protocol.version',
    'ap2.version',
  ]);
  const kinds = new Map([
    ['mandate.checkout.open.1', { family: 'open_checkout', kind: 'open_checkout_mandate' }],
    ['mandate.checkout.1', { family: 'checkout', kind: 'checkout_mandate' }],
    ['mandate.payment.open.1', { family: 'open_payment', kind: 'open_payment_mandate' }],
    ['mandate.payment.1', { family: 'payment', kind: 'payment_mandate' }],
  ]);
  const declaredKind = options.artifactKind ?? first(artifact, [
    'artifact_kind',
    'kind',
    'type',
  ]);
  const vct = first(artifact, ['vct', 'claims.vct']);
  const mappedKind = vct ? kinds.get(vct) : null;
  const artifactKind = mappedKind?.kind ?? declaredKind;
  const family = mappedKind?.family ?? ({
    IntentMandate: 'legacy_intent',
    CartMandate: 'legacy_cart',
    PaymentMandate: 'legacy_payment',
  })[artifactKind];
  let expiresAt = options.expiresAt;
  if (family === 'legacy_intent') {
    requiredBoolean(
      artifact.user_cart_confirmation_required,
      'artifact.user_cart_confirmation_required',
    );
    text(artifact.natural_language_description, 'artifact.natural_language_description');
    expiresAt = expiresAt ?? iso(artifact.intent_expiry, 'artifact.intent_expiry');
  } else if (family === 'legacy_cart') {
    const contents = object(artifact.contents, 'artifact.contents');
    text(contents.id, 'artifact.contents.id');
    requiredBoolean(
      contents.user_cart_confirmation_required,
      'artifact.contents.user_cart_confirmation_required',
    );
    const paymentRequest = object(contents.payment_request, 'artifact.contents.payment_request');
    paymentItem(paymentRequest.details?.total, 'artifact.contents.payment_request.details.total');
    text(contents.merchant_name, 'artifact.contents.merchant_name');
    expiresAt = expiresAt ?? iso(contents.cart_expiry, 'artifact.contents.cart_expiry');
  } else if (family === 'legacy_payment') {
    const contents = object(
      artifact.payment_mandate_contents ?? artifact.claims ?? artifact,
      'artifact.payment_mandate_contents',
    );
    text(contents.payment_mandate_id ?? artifact.transaction_id, 'payment_mandate_id');
    text(contents.payment_details_id ?? artifact.transaction_id, 'payment_details_id');
    paymentItem(
      contents.payment_details_total ?? artifact.payment_amount,
      'payment_details_total',
    );
    object(contents.payment_response ?? artifact.payment_instrument, 'payment_response');
    object(contents.merchant_agent ?? artifact.payee, 'merchant_agent');
    iso(contents.timestamp ?? options.issuedAt, 'payment_mandate_contents.timestamp');
  } else if (family === 'open_checkout') {
    if (!Array.isArray(artifact.constraints) || artifact.constraints.length === 0) {
      throw new TypeError('open checkout mandate constraints must be a non-empty array');
    }
    object(artifact.cnf, 'artifact.cnf');
    if (!artifact.constraints.some((constraint) => constraint?.type === 'checkout.line_items')) {
      throw new TypeError('open checkout mandate requires checkout.line_items constraints');
    }
  } else if (family === 'checkout') {
    text(artifact.checkout_jwt, 'artifact.checkout_jwt');
    text(artifact.checkout_hash, 'artifact.checkout_hash');
  } else if (family === 'open_payment') {
    if (!Array.isArray(artifact.constraints) || artifact.constraints.length === 0) {
      throw new TypeError('open payment mandate constraints must be a non-empty array');
    }
    object(artifact.cnf, 'artifact.cnf');
    if (!artifact.constraints.some((constraint) => constraint?.type === 'payment.reference')) {
      throw new TypeError('open payment mandate requires a payment.reference constraint');
    }
  } else if (family === 'payment') {
    text(artifact.transaction_id, 'artifact.transaction_id');
    const payee = object(artifact.payee, 'artifact.payee');
    text(payee.id, 'artifact.payee.id');
    text(payee.name, 'artifact.payee.name');
    const amount = object(artifact.payment_amount, 'artifact.payment_amount');
    requiredInteger(amount.amount, 'artifact.payment_amount.amount');
    text(amount.currency, 'artifact.payment_amount.currency', { max: 30 });
    const instrument = object(artifact.payment_instrument, 'artifact.payment_instrument');
    text(instrument.id, 'artifact.payment_instrument.id');
    text(instrument.type, 'artifact.payment_instrument.type');
  } else {
    throw new TypeError(`unsupported AP2 mandate type: ${artifactKind || vct || 'missing'}`);
  }
  return authorityFromProtocol({
    artifact,
    options: { ...options, expiresAt },
    protocol: 'google_ap2',
    pin,
    version,
    artifactKind,
    requiredChecks: [
      'action',
      'amount',
      'audience',
      'merchant',
      'revocation',
      'signature',
      'terms',
    ],
    unsupportedFields: options.unsupportedFields ?? [],
  });
}

export function normalizeVisaTapEvidence(artifact, options = {}) {
  const pin = PROTOCOL_ADAPTER_PINS.visa_tap;
  const version = exactVersion(artifact, options, pin, ['protocol_version', 'protocol.version']);
  const signatureInput = object(artifact.signature_input, 'artifact.signature_input');
  const coveredComponents = list(
    signatureInput.covered_components,
    'artifact.signature_input.covered_components',
  );
  if (!coveredComponents.includes('@method') || !coveredComponents.includes('@path')) {
    throw new TypeError('Visa TAP signature_input must cover @method and @path');
  }
  text(signatureInput.nonce, 'artifact.signature_input.nonce');
  const createdAt = iso(signatureInput.created, 'artifact.signature_input.created');
  const expiresAt = iso(signatureInput.expires, 'artifact.signature_input.expires');
  if (Date.parse(expiresAt) <= Date.parse(createdAt)) {
    throw new TypeError('Visa TAP signature expiry must follow creation');
  }
  text(signatureInput.keyid, 'artifact.signature_input.keyid');
  text(signatureInput.tag, 'artifact.signature_input.tag');
  text(artifact.signature_agent, 'artifact.signature_agent');
  text(artifact.signature, 'artifact.signature');
  const request = object(artifact.request, 'artifact.request');
  text(request.method, 'artifact.request.method');
  text(request.path, 'artifact.request.path');
  const merchantRef = text(request.merchant_ref, 'artifact.request.merchant_ref');
  const purpose = text(request.purpose, 'artifact.request.purpose');
  const consumerRef = text(request.consumer_ref, 'artifact.request.consumer_ref');
  const paymentContainerRef = text(
    request.payment_container_ref,
    'artifact.request.payment_container_ref',
  );
  if (options.bindings?.merchantRef !== merchantRef) {
    throw new TypeError('Visa TAP merchant binding does not match the signed request');
  }
  if (!options.bindings?.allowedActions?.includes(purpose)) {
    throw new TypeError('Visa TAP purpose is outside the normalized action binding');
  }
  const authority = authorityFromProtocol({
    artifact,
    options: { ...options, issuedAt: options.issuedAt ?? createdAt, expiresAt },
    protocol: 'visa_tap',
    pin,
    version,
    artifactKind: text(options.artifactKind ?? artifact.kind, 'artifactKind'),
    requiredChecks: [
      'audience',
      'consumer_linkage',
      'expiry',
      'merchant',
      'payment_container_linkage',
      'purpose',
      'replay',
      'signature',
    ],
    unsupportedFields: options.unsupportedFields ?? [],
  });
  return {
    ...boundedEvidenceBase(
      'agoragentic.visa-tap-evidence.v1',
      'visa_tap',
      pin,
      version,
      artifact,
      options,
    ),
    normalized_authority: authority,
    binding: {
      agent_ref: authority.agent_ref,
      seller_ref: authority.merchant_binding,
      task_ref: text(options.taskRef, 'taskRef'),
      quote_ref: text(options.quoteRef, 'quoteRef'),
      payment_identifier: text(options.paymentIdentifier, 'paymentIdentifier'),
    },
    recognition: {
      agent_recognition_ref: text(artifact.agent_recognition_ref, 'artifact.agent_recognition_ref'),
      consumer_linkage_ref: consumerRef,
      payment_container_ref: paymentContainerRef,
      signed_request_hash: sha256Ref(request),
      payment_container_data_embedded: false,
    },
    authority_flags: noAuthority(),
  };
}

export function normalizeOfficialAcpEvidence(artifact, options = {}) {
  const pin = PROTOCOL_ADAPTER_PINS.openai_stripe_acp;
  const version = exactVersion(artifact, options, pin, [
    'protocol_version',
    'protocol.version',
    'checkout_session.protocol.version',
    'checkout.protocol.version',
  ]);
  const checkout = object(artifact.checkout_session ?? artifact.checkout, 'artifact.checkout_session');
  for (const field of [
    'id',
    'status',
    'currency',
    'line_items',
    'totals',
    'fulfillment_options',
    'messages',
    'links',
    'capabilities',
  ]) {
    if (!Object.prototype.hasOwnProperty.call(checkout, field)) {
      throw new TypeError(`checkout_session.${field} is required by ACP 2026-04-17`);
    }
  }
  for (const field of [
    'line_items',
    'totals',
    'fulfillment_options',
    'messages',
    'links',
  ]) {
    if (!Array.isArray(checkout[field])) {
      throw new TypeError(`checkout_session.${field} must be an array`);
    }
  }
  object(checkout.capabilities, 'checkout_session.capabilities');
  const checkoutId = text(checkout.id, 'checkout_session.id');
  const status = enumeration(checkout.status, 'checkout_session.status', ACP_CHECKOUT_STATUSES);
  const order = checkout.order ?? artifact.order ?? null;
  if (status === 'completed' && !order) {
    throw new TypeError('completed ACP checkout requires an order');
  }
  if (order) {
    const orderValue = object(order, 'checkout_session.order');
    text(orderValue.id, 'checkout_session.order.id');
    if (text(orderValue.checkout_session_id, 'checkout_session.order.checkout_session_id') !== checkoutId) {
      throw new TypeError('ACP order checkout_session_id mismatch');
    }
    text(orderValue.permalink_url, 'checkout_session.order.permalink_url');
  }
  const completeRequest = artifact.complete_request
    ? object(artifact.complete_request, 'artifact.complete_request')
    : null;
  if (completeRequest) {
    requireAcpSchema(
      completeRequest,
      validateAcpCompleteRequest,
      'artifact.complete_request',
    );
  }
  const paymentData = completeRequest
    ? object(completeRequest.payment_data, 'artifact.complete_request.payment_data')
    : null;
  if (paymentData
    && !(paymentData.purchase_order_number
      || (paymentData.handler_id && paymentData.instrument))) {
    throw new TypeError(
      'ACP payment_data requires purchase_order_number or handler_id with instrument',
    );
  }
  const paymentHandlers = checkout.capabilities?.payment?.handlers ?? [];
  if (!Array.isArray(paymentHandlers)) {
    throw new TypeError('checkout_session.capabilities.payment.handlers must be an array');
  }
  const selectedHandler = paymentData?.handler_id
    ? paymentHandlers.find((item) => item?.id === paymentData.handler_id)
    : null;
  if (paymentData?.handler_id && !selectedHandler) {
    throw new TypeError('ACP payment_data handler_id must match a seller-advertised payment handler');
  }
  if (selectedHandler) {
    for (const field of [
      'id',
      'name',
      'version',
      'spec',
      'requires_delegate_payment',
      'requires_pci_compliance',
      'psp',
      'config_schema',
      'instrument_schemas',
      'config',
    ]) {
      if (!Object.prototype.hasOwnProperty.call(selectedHandler, field)) {
        throw new TypeError(`ACP payment handler ${field} is required`);
      }
    }
  }
  const authority = authorityFromProtocol({
    artifact,
    options,
    protocol: 'openai_stripe_acp',
    pin,
    version,
    artifactKind: 'checkout_and_delegated_payment',
    requiredChecks: ['amount', 'cart', 'delegated_payment', 'expiry', 'schema', 'seller'],
    unsupportedFields: options.unsupportedFields ?? [],
  });
  return {
    ...boundedEvidenceBase(
      'agoragentic.official-acp-evidence.v1',
      'openai_stripe_acp',
      pin,
      version,
      artifact,
      options,
    ),
    normalized_authority: authority,
    checkout: {
      checkout_session_ref: text(options.checkoutSessionRef, 'checkoutSessionRef'),
      checkout_session_hash: sha256Ref(checkout),
      checkout_session_id: checkoutId,
      seller_ref: authority.merchant_binding,
      status,
      currency: authority.currency,
      cart_hash: sha256Ref({
        currency: checkout.currency,
        line_items: checkout.line_items,
        totals: checkout.totals,
      }),
      request_id: text(options.requestId, 'requestId'),
      idempotency_key_hash: text(options.idempotencyKeyHash, 'idempotencyKeyHash'),
      duplicate_detected: options.duplicateDetected === true,
      order_ref: order ? `acp-order:${order.id}` : null,
      order_hash: order ? sha256Ref(order) : null,
      payment_data_ref: paymentData ? `acp-payment:${paymentData.handler_id || 'purchase-order'}` : null,
      payment_data_hash: paymentData ? sha256Ref(paymentData) : null,
      payment_handler_ref: selectedHandler ? `acp-handler:${selectedHandler.id}` : null,
      payment_handler_hash: selectedHandler ? sha256Ref(selectedHandler) : null,
      delegated_payment_payload_embedded: false,
    },
    outcome: {
      fulfillment_refs: Array.isArray(order?.fulfillments)
        ? order.fulfillments.map((item) => `acp-fulfillment:${text(item.id, 'order.fulfillments.id')}`)
        : [],
      fulfillment_hash: Array.isArray(order?.fulfillments) ? sha256Ref(order.fulfillments) : null,
      adjustment_refs: Array.isArray(order?.adjustments)
        ? order.adjustments.map((item) => `acp-adjustment:${text(item.id, 'order.adjustments.id')}`)
        : [],
      adjustment_hash: Array.isArray(order?.adjustments) ? sha256Ref(order.adjustments) : null,
      merchant_declared_only: true,
      independently_verified: false,
      complete_chain_verified: false,
    },
    protocol_states: {
      checkout: status,
      payment: paymentData
        ? 'merchant_declared_submitted'
        : (status === 'completed' ? 'merchant_declared_completed' : 'not_verified'),
      delivery: order?.fulfillments?.length ? 'merchant_declared' : 'unknown',
      refund: order?.adjustments?.some((item) => item.type === 'refund')
        ? 'merchant_declared'
        : 'unknown',
      reconciliation: 'not_verified',
    },
    authority_flags: noAuthority(),
  };
}

export function normalizeX402Evidence(artifact, options = {}) {
  const pin = PROTOCOL_ADAPTER_PINS.x402;
  const sdkDeclarations = [options.sdkVersion, options.version, artifact.sdk_version]
    .filter((value) => value !== undefined && value !== null && value !== '');
  if (sdkDeclarations.length === 0) {
    throw new TypeError(`x402 SDK version is required: expected ${pin.version}`);
  }
  if (sdkDeclarations.some((value) => value !== pin.version)) {
    throw new TypeError(`unsupported or conflicting x402 SDK version: expected ${pin.version}`);
  }
  const paymentRequired = object(artifact.paymentRequired, 'artifact.paymentRequired');
  if (paymentRequired.x402Version !== pin.wire_version) {
    throw new TypeError(`x402Version must be ${pin.wire_version}`);
  }
  const resource = object(paymentRequired.resource, 'paymentRequired.resource');
  const resourceUrl = text(resource.url, 'paymentRequired.resource.url');
  if (!Array.isArray(paymentRequired.accepts) || paymentRequired.accepts.length === 0) {
    throw new TypeError('paymentRequired.accepts must be a non-empty array');
  }
  const acceptIndex = options.acceptIndex ?? 0;
  if (!Number.isSafeInteger(acceptIndex) || !paymentRequired.accepts[acceptIndex]) {
    throw new TypeError('acceptIndex must select a paymentRequired.accepts entry');
  }
  const accepted = object(paymentRequired.accepts[acceptIndex], 'paymentRequired.accepts entry');
  const scheme = text(accepted.scheme, 'accepted.scheme');
  const network = text(accepted.network, 'accepted.network');
  const asset = text(accepted.asset, 'accepted.asset');
  const amount = decimal(accepted.amount, 'accepted.amount');
  const payTo = text(accepted.payTo, 'accepted.payTo');
  const paymentIdentifier = text(
    paymentRequired.extensions?.['payment-identifier']?.info?.id,
    'paymentRequired.extensions.payment-identifier.info.id',
  );
  const paymentPayload = artifact.paymentPayload
    ? object(artifact.paymentPayload, 'artifact.paymentPayload')
    : null;
  if (paymentPayload) {
    if (paymentPayload.x402Version !== pin.wire_version) {
      throw new TypeError(`paymentPayload.x402Version must be ${pin.wire_version}`);
    }
    const payloadIdentifier = text(
      paymentPayload.extensions?.['payment-identifier']?.info?.id,
      'paymentPayload.extensions.payment-identifier.info.id',
    );
    if (payloadIdentifier !== paymentIdentifier) {
      throw new TypeError('x402 Payment Identifier mismatch between challenge and payload');
    }
    if (canonicalize(paymentPayload.accepted) !== canonicalize(accepted)) {
      throw new TypeError('paymentPayload.accepted does not match the selected requirement');
    }
  }
  const offers = paymentRequired.extensions?.['offer-receipt']?.info?.offers;
  if (!Array.isArray(offers) || offers.length === 0) {
    throw new TypeError('x402 offer-receipt extension must contain an offer');
  }
  const offer = object(offers[acceptIndex], 'offer-receipt offer');
  if (offer.version !== pin.offer_receipt_version) {
    throw new TypeError(`x402 offer version must be ${pin.offer_receipt_version}`);
  }
  const expiresAt = iso(offer.validUntil, 'offer.validUntil');
  const offerFields = {
    scheme: text(offer.scheme, 'offer.scheme'),
    network: text(offer.network, 'offer.network'),
    asset: text(offer.asset, 'offer.asset'),
    amount: decimal(offer.amount, 'offer.amount'),
    pay_to: text(offer.payTo, 'offer.payTo'),
    resource_url: text(offer.resourceUrl, 'offer.resourceUrl'),
  };
  for (const [field, expected] of Object.entries({
    scheme,
    network,
    asset,
    amount,
    pay_to: payTo,
    resource_url: resourceUrl,
  })) {
    if (offerFields[field] !== expected) {
      throw new TypeError(`x402 signed offer ${field} does not match the payment requirement`);
    }
  }
  const httpMethod = text(options.httpMethod, 'httpMethod', { max: 20 }).toUpperCase();
  const operationId = text(options.operationId, 'operationId');
  const fingerprint = {
    payment_identifier: paymentIdentifier,
    scheme,
    network,
    asset,
    amount,
    pay_to: payTo,
    resource_url: resourceUrl,
    http_method: httpMethod,
    operation_id: operationId,
  };
  const offerRef = text(options.offerRef, 'offerRef');
  const offerIssuerRef = text(options.offerIssuerRef, 'offerIssuerRef');
  const offerVerifier = signedArtifactVerifierEvidence(options.offerVerifier, {
    field: 'offerVerifier',
    protocol: 'x402',
    version: pin.version,
    artifactKind: 'offer-receipt.offer.v1',
    artifactHash: sha256Ref(offer),
    bindingHash: sha256Ref({ ...fingerprint, offer_ref: offerRef, issuer_ref: offerIssuerRef }),
    requiredChecks: ['amount', 'asset', 'expiry', 'issuer', 'network', 'pay_to', 'resource', 'scheme', 'signature'],
  });
  const receipts = first(artifact, [
    'responseExtensions.offer-receipt.info.receipts',
    'settleResponse.extensions.offer-receipt.info.receipts',
  ]);
  const receipt = Array.isArray(receipts) && receipts.length > 0
    ? object(receipts[0], 'offer-receipt receipt')
    : null;
  if (receipt && receipt.version !== pin.offer_receipt_version) {
    throw new TypeError(`x402 receipt version must be ${pin.offer_receipt_version}`);
  }
  const receiptRef = receipt ? text(options.receiptRef, 'receiptRef') : null;
  const receiptIssuerRef = receipt ? text(options.receiptIssuerRef, 'receiptIssuerRef') : null;
  const receiptVerifier = receipt ? signedArtifactVerifierEvidence(options.receiptVerifier, {
    field: 'receiptVerifier',
    protocol: 'x402',
    version: pin.version,
    artifactKind: 'offer-receipt.receipt.v1',
    artifactHash: sha256Ref(receipt),
    bindingHash: sha256Ref({ ...fingerprint, receipt_ref: receiptRef, issuer_ref: receiptIssuerRef }),
    requiredChecks: ['issuer', 'payment_identifier', 'signature', 'version'],
  }) : null;
  const lifecycle = artifact.lifecycle ?? {};
  const submissionStatus = enumeration(
    lifecycle.submission_status ?? 'not_submitted',
    'artifact.lifecycle.submission_status',
    X402_SUBMISSION_STATUSES,
  );
  const observationStatus = enumeration(
    lifecycle.observation_status ?? 'not_observed',
    'artifact.lifecycle.observation_status',
    X402_OBSERVATION_STATUSES,
  );
  const settlementArtifact = artifact.settlement
    ? object(artifact.settlement, 'artifact.settlement')
    : null;
  const settlementStatus = enumeration(
    settlementArtifact?.status ?? 'not_checked',
    'artifact.settlement.status',
    X402_SETTLEMENT_STATUSES,
  );
  const settlementVerifier = settlementArtifact
    ? signedArtifactVerifierEvidence(options.settlementVerifier, {
        field: 'settlementVerifier',
        protocol: 'x402',
        version: pin.version,
        artifactKind: 'x402.settlement',
        artifactHash: sha256Ref(settlementArtifact),
        bindingHash: sha256Ref({ ...fingerprint, status: settlementStatus }),
        requiredChecks: ['amount', 'asset', 'finality', 'network', 'payment_identifier', 'status'],
      })
    : {
        status: 'unverified', verifier_ref: null, evidence_ref: null, checked_at: null, checks: [], trusted: false,
      };
  const settlementFinal = settlementArtifact?.final === true;
  if (settlementFinal && settlementStatus !== 'settled') {
    throw new TypeError('settlement finality requires status=settled');
  }
  if (settlementFinal && settlementVerifier.status !== 'verified') {
    throw new TypeError('settlement finality requires a trusted verified settlement callback');
  }
  return {
    ...boundedEvidenceBase(
      'agoragentic.x402-evidence.v1',
      'x402',
      pin,
      pin.version,
      artifact,
      options,
    ),
    payment_identifier: paymentIdentifier,
    fingerprint,
    resource_ref: resourceUrl,
    request_ref: text(options.requestRef, 'requestRef'),
    retry_ref: text(options.retryRef, 'retryRef', { optional: true }),
    payment_lifecycle: {
      challenge: {
        status: 'observed',
        evidence_ref: text(options.challengeEvidenceRef, 'challengeEvidenceRef'),
      },
      submission: {
        status: submissionStatus,
        evidence_ref: text(lifecycle.submission_evidence_ref, 'lifecycle.submission_evidence_ref', {
          optional: submissionStatus !== 'submitted',
        }),
      },
      observation: {
        status: observationStatus,
        evidence_ref: text(lifecycle.observation_evidence_ref, 'lifecycle.observation_evidence_ref', {
          optional: !['observed', 'failed'].includes(observationStatus),
        }),
      },
    },
    offer: {
      ref: offerRef,
      hash: sha256Ref(offer),
      issuer_ref: offerIssuerRef,
      verification: offerVerifier,
      amount,
      asset,
      network,
      scheme,
      pay_to: payTo,
      resource_url: resourceUrl,
      expires_at: expiresAt,
      signature_material_embedded: false,
    },
    receipt: receipt ? {
      ref: receiptRef,
      hash: sha256Ref(receipt),
      issuer_ref: receiptIssuerRef,
      verification: receiptVerifier,
      signature_material_embedded: false,
    } : null,
    settlement: {
      status: settlementStatus,
      artifact_ref: settlementArtifact
        ? text(options.settlementArtifactRef, 'settlementArtifactRef')
        : null,
      artifact_hash: settlementArtifact ? sha256Ref(settlementArtifact) : null,
      verification: settlementVerifier,
      final: settlementFinal,
    },
    payment_material_embedded: false,
    authority_flags: noAuthority(),
  };
}

export function bindX402OutcomeEvidence(evidence, binding = {}) {
  object(evidence, 'evidence');
  if (evidence.schema !== 'agoragentic.x402-evidence.v1') {
    throw new TypeError('evidence must be produced by normalizeX402Evidence');
  }
  const expected = {
    payment_identifier: text(binding.paymentIdentifier, 'binding.paymentIdentifier'),
    resource_url: text(binding.resourceUrl ?? binding.resourceRef, 'binding.resourceUrl'),
    scheme: text(binding.scheme, 'binding.scheme'),
    amount: money(binding.amount, 'binding.amount'),
    asset: text(binding.asset, 'binding.asset'),
    network: text(binding.network, 'binding.network'),
    pay_to: text(binding.payTo, 'binding.payTo'),
    http_method: text(binding.httpMethod, 'binding.httpMethod', { max: 20 }).toUpperCase(),
    operation_id: text(binding.operationId, 'binding.operationId'),
    invocation_ref: text(binding.invocationRef, 'binding.invocationRef'),
    input_hash: text(binding.inputHash, 'binding.inputHash'),
    output_hash: text(binding.outputHash, 'binding.outputHash'),
    delivery_evidence_ref: text(binding.deliveryEvidenceRef, 'binding.deliveryEvidenceRef'),
    evaluated_at: iso(binding.evaluatedAt, 'binding.evaluatedAt'),
  };
  const mismatches = [];
  if (evidence.payment_identifier !== expected.payment_identifier) mismatches.push('payment_identifier');
  if (evidence.fingerprint.resource_url !== expected.resource_url) mismatches.push('resource');
  if (evidence.fingerprint.scheme !== expected.scheme) mismatches.push('scheme');
  if (evidence.offer.amount !== expected.amount) mismatches.push('amount');
  if (evidence.offer.asset !== expected.asset) mismatches.push('asset');
  if (evidence.offer.network !== expected.network) mismatches.push('network');
  if (evidence.fingerprint.pay_to !== expected.pay_to) mismatches.push('pay_to');
  if (evidence.fingerprint.http_method !== expected.http_method) mismatches.push('http_method');
  if (evidence.fingerprint.operation_id !== expected.operation_id) mismatches.push('operation_id');
  const offerExpired = Date.parse(evidence.offer.expires_at) <= Date.parse(expected.evaluated_at);
  if (offerExpired) mismatches.push('offer_expired');
  const settlementVerified = evidence.settlement.status === 'settled'
    && evidence.settlement.verification.status === 'verified'
    && evidence.settlement.final
    && Boolean(evidence.settlement.verification.evidence_ref);
  const receiptVerified = evidence.receipt?.verification.status === 'verified'
    && Boolean(evidence.receipt.verification.evidence_ref);
  return {
    schema: 'agoragentic.x402-outcome-binding.v1',
    x402_evidence_hash: sha256Ref(evidence),
    binding_hash: sha256Ref(expected),
    payment_identifier_match: !mismatches.includes('payment_identifier'),
    mismatches,
    settlement_verified: settlementVerified,
    receipt_verified: receiptVerified,
    external_verification: {
      status: 'not_checked',
      verifier_ref: null,
      evidence_ref: null,
      checked_at: null,
      proves_delivery: false,
    },
    offer_expired: offerExpired,
    delivery_verified: false,
    complete_chain_verified: false,
    safe_to_reuse_payment_identifier: mismatches.length === 0
      && evidence.payment_lifecycle.submission.status === 'submitted'
      && ['not_observed', 'unknown'].includes(evidence.payment_lifecycle.observation.status),
    refs: {
      invocation_ref: expected.invocation_ref,
      input_hash: expected.input_hash,
      output_hash: expected.output_hash,
      delivery_evidence_ref: expected.delivery_evidence_ref,
    },
    authority_flags: noAuthority(),
  };
}

function normalizePolicyEvidence(protocol, artifact, options, requiredChecks, artifactKind) {
  const pin = PROTOCOL_ADAPTER_PINS[protocol];
  const version = exactVersion(artifact, options, pin);
  return authorityFromProtocol({
    artifact,
    options,
    protocol,
    pin,
    version,
    artifactKind,
    requiredChecks,
    unsupportedFields: options.unsupportedFields ?? [],
  });
}

export function normalizeCircleWalletPolicyEvidence(artifact, options = {}) {
  const protocol = 'circle_agent_wallet_policy';
  const pin = PROTOCOL_ADAPTER_PINS[protocol];
  const version = exactVersion(artifact, options, pin, ['protocol_version', 'protocol.version']);
  rejectRawMaterial(artifact, [
    'private_key',
    'mnemonic',
    'otp',
    'wallet.private_key',
    'wallet.mnemonic',
  ], 'Circle wallet-policy evidence');
  const wallet = object(artifact.wallet, 'artifact.wallet');
  const policy = object(artifact.policy, 'artifact.policy');
  const limits = object(policy.limits, 'artifact.policy.limits');
  const walletRef = text(wallet.id, 'artifact.wallet.id');
  const accountRef = text(wallet.address, 'artifact.wallet.address');
  const agentRef = text(wallet.agent_ref, 'artifact.wallet.agent_ref');
  const chain = text(wallet.chain, 'artifact.wallet.chain').toUpperCase();
  if (!CIRCLE_MAINNET_CHAINS.has(chain) || policy.network !== 'mainnet') {
    throw new TypeError('Circle wallet-policy evidence must be mainnet-only');
  }
  const policyStatus = enumeration(
    policy.status,
    'artifact.policy.status',
    new Set(['active', 'disabled', 'draft']),
  );
  if (policyStatus !== 'active') {
    throw new TypeError('Circle wallet-policy evidence requires an active live policy');
  }
  const asset = text(policy.asset, 'artifact.policy.asset', { max: 30 }).toUpperCase();
  for (const field of ['per_transaction', 'daily', 'weekly', 'monthly']) {
    decimal(limits[field], `artifact.policy.limits.${field}`);
  }
  if (options.bindings?.agentRef !== agentRef) {
    throw new TypeError('Circle wallet agent_ref does not match the authority binding');
  }
  if (options.bindings?.currency?.toUpperCase() !== asset) {
    throw new TypeError('Circle wallet policy asset does not match the authority currency');
  }
  return authorityFromProtocol({
    artifact,
    options,
    protocol,
    pin,
    version,
    artifactKind: 'agent_wallet_spending_policy',
    requiredChecks: ['agent', 'audience', 'expiry', 'issuer', 'live_policy', 'revocation', 'scope'],
    unsupportedFields: options.unsupportedFields ?? [],
    protocolEvidence: {
      subject_ref: agentRef,
      counterparty_ref: accountRef,
      asset_ref: asset,
      scope_ref: sha256Ref({ wallet_ref: walletRef, policy }),
      policy_state: policyStatus,
      environment: chain,
    },
  });
}

export function normalizeSkyfireKyaPayEvidence(artifact, options = {}) {
  const protocol = 'skyfire_kyapay';
  const pin = PROTOCOL_ADAPTER_PINS[protocol];
  const version = exactVersion(artifact, options, pin, ['protocol_version', 'protocol.version']);
  rejectRawMaterial(artifact, [
    'raw_token',
    'token',
    'signature',
    'private_key',
  ], 'Skyfire KYA/KYAPay evidence');
  const header = object(artifact.decoded_header, 'artifact.decoded_header');
  const claims = object(artifact.decoded_claims, 'artifact.decoded_claims');
  if (header.alg !== 'ES256') throw new TypeError('Skyfire token alg must be ES256');
  const tokenType = enumeration(
    header.typ,
    'artifact.decoded_header.typ',
    new Set(['kya+jwt', 'pay+jwt', 'kya-pay+jwt']),
  );
  text(header.kid, 'artifact.decoded_header.kid');
  const issuer = text(claims.iss, 'artifact.decoded_claims.iss');
  const subject = text(claims.sub, 'artifact.decoded_claims.sub');
  const audience = text(claims.aud, 'artifact.decoded_claims.aud');
  const environment = text(claims.env, 'artifact.decoded_claims.env');
  requiredInteger(claims.iat, 'artifact.decoded_claims.iat');
  requiredInteger(claims.exp, 'artifact.decoded_claims.exp');
  const jti = text(claims.jti, 'artifact.decoded_claims.jti');
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(jti)) {
    throw new TypeError('Skyfire jti must be a UUID');
  }
  text(claims.ssi, 'artifact.decoded_claims.ssi');
  text(claims.btg, 'artifact.decoded_claims.btg');
  const identity = claims.identity ? object(claims.identity, 'artifact.decoded_claims.identity') : {};
  const agentRef = text(identity.aid ?? subject, 'artifact.decoded_claims.identity.aid');
  const payment = claims.payment ? object(claims.payment, 'artifact.decoded_claims.payment') : null;
  if (tokenType !== 'kya+jwt' && !payment) {
    throw new TypeError('Skyfire payment token requires payment claims');
  }
  const currency = payment
    ? text(payment.amount?.cur, 'artifact.decoded_claims.payment.amount.cur', { max: 30 }).toUpperCase()
    : options.bindings?.currency?.toUpperCase();
  if (payment) {
    decimal(payment.amount?.value, 'artifact.decoded_claims.payment.amount.value');
    text(payment.spr, 'artifact.decoded_claims.payment.spr');
    text(payment.sps, 'artifact.decoded_claims.payment.sps');
  }
  if (options.bindings?.agentRef !== agentRef || options.bindings?.audience !== audience) {
    throw new TypeError('Skyfire subject or audience does not match the authority binding');
  }
  if (options.bindings?.currency?.toUpperCase() !== currency) {
    throw new TypeError('Skyfire payment currency does not match the authority binding');
  }
  return authorityFromProtocol({
    artifact,
    options: {
      ...options,
      issuedAt: options.issuedAt ?? claims.iat,
      expiresAt: options.expiresAt ?? claims.exp,
    },
    protocol,
    pin,
    version,
    artifactKind: tokenType,
    requiredChecks: ['agent_identity', 'audience', 'expiry', 'payment_scope', 'revocation', 'token_signature'],
    unsupportedFields: options.unsupportedFields ?? [],
    protocolEvidence: {
      subject_ref: agentRef,
      counterparty_ref: payment?.sps ?? audience,
      asset_ref: currency,
      scope_ref: sha256Ref({ jti, identity, payment }),
      policy_state: payment ? 'payment_claims_present' : 'identity_only',
      environment,
    },
  });
}

export function normalizeMastercardVerifiableIntentEvidence(artifact, options = {}) {
  if (options.verifier !== undefined && options.verifier !== null) {
    throw new TypeError(
      'Mastercard Verifiable Intent verification is unsupported without a public immutable schema',
    );
  }
  const normalized = normalizePolicyEvidence(
    'mastercard_verifiable_intent',
    artifact,
    { ...options, verifier: undefined },
    ['agent', 'audience', 'expiry', 'issuer', 'merchant', 'revocation', 'scope', 'signature'],
    'public_verifiable_intent_evidence',
  );
  return {
    ...normalized,
    normalization_warnings: [
      ...normalized.normalization_warnings,
      'public materials expose no immutable Verifiable Intent schema; verification is unsupported',
      'public materials do not establish compatibility with private Mastercard network internals',
    ],
    protocol_binding: {
      ...normalized.protocol_binding,
      unsupported_fields: [
        ...normalized.protocol_binding.unsupported_fields,
        'cryptographic_verification',
        'private_network_compatibility',
      ],
    },
  };
}
