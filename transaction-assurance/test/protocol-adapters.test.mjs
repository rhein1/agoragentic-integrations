import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';

import Ajv2020 from 'ajv/dist/2020.js';
import addFormats from 'ajv-formats';

import {
  bindX402OutcomeEvidence,
  buildTransactionAssuranceEnvelope,
  evaluateTransactionAssuranceEnvelope,
  normalizeAp2Authority,
  normalizeCircleWalletPolicyEvidence,
  normalizeMastercardVerifiableIntentEvidence,
  normalizeOfficialAcpEvidence,
  normalizeSkyfireKyaPayEvidence,
  normalizeVisaTapEvidence,
  normalizeX402Evidence,
  PROTOCOL_ADAPTER_PINS,
} from '../src/index.mjs';

const vectors = JSON.parse(fs.readFileSync(
  new URL('./fixtures/protocol-adapter-vectors.v1.json', import.meta.url),
  'utf8',
));
const acpSchema = JSON.parse(fs.readFileSync(
  new URL('../vendor/acp-2026-04-17/schema.agentic_checkout.json', import.meta.url),
  'utf8',
));
const normalizedAuthoritySchema = JSON.parse(fs.readFileSync(
  new URL('../schema/normalized-authority.v1.json', import.meta.url),
  'utf8',
));

const ajv = new Ajv2020({ allErrors: true, strict: true, strictSchema: false });
addFormats(ajv);
ajv.addSchema(acpSchema);
const validateAcpCheckout = ajv.compile({
  $ref: `${acpSchema.$id}#/$defs/CheckoutSession`,
});
const validateAcpCheckoutWithOrder = ajv.compile({
  $ref: `${acpSchema.$id}#/$defs/CheckoutSessionWithOrder`,
});
const validateNormalizedAuthority = ajv.compile(normalizedAuthoritySchema);

const clone = (value) => structuredClone(value);

function setPath(value, dotted, replacement) {
  const parts = dotted.split('.');
  let cursor = value;
  for (const part of parts.slice(0, -1)) {
    cursor = cursor[Number.isInteger(Number(part)) ? Number(part) : part];
  }
  const last = parts.at(-1);
  cursor[Number.isInteger(Number(last)) ? Number(last) : last] = replacement;
}

function deletePath(value, dotted) {
  const parts = dotted.split('.');
  let cursor = value;
  for (const part of parts.slice(0, -1)) cursor = cursor[part];
  delete cursor[parts.at(-1)];
}

function inputFor(descriptor) {
  const value = clone(vectors.fixtures[descriptor.fixture]);
  for (const [field, replacement] of Object.entries(descriptor.set || {})) {
    setPath(value, field, replacement);
  }
  if (descriptor.delete) deletePath(value, descriptor.delete);
  return value;
}

const bindings = Object.freeze({
  issuerRef: 'issuer:test',
  principalRef: 'principal:test',
  agentRef: 'agent:test',
  audience: 'agent:test',
  merchantRef: 'merchant:test',
  allowedActions: ['execute:checkout'],
  allowedSellers: ['merchant:test'],
  allowedCategories: ['commerce'],
  allowedPaymentRails: ['x402'],
  currency: 'USD',
  maxPerAction: '2.00',
  maxDaily: '10.00',
  maxTotal: '25.00',
});

function adapterOptions(extra = {}) {
  return {
    artifactRef: 'fixture://protocol-artifact',
    issuedAt: '2026-08-08T00:00:00Z',
    expiresAt: '2030-01-01T00:00:00Z',
    bindings: { ...bindings },
    ...extra,
  };
}

function authorityVerifier({
  status = 'verified',
  failedCheck = null,
  revocationStatus = status === 'verified' ? 'active' : 'not_checked',
} = {}) {
  return {
    id: 'verifier://trusted/test',
    verify(context) {
      const checks = Object.fromEntries(
        context.required_checks.map((name) => [name, name !== failedCheck]),
      );
      return {
        schema: 'agoragentic.protocol-verifier-evidence.v1',
        protocol: context.protocol,
        version: context.version,
        artifact_hash: context.artifact_hash,
        binding_hash: context.binding_hash,
        status,
        verifier_ref: this.id,
        evidence_ref: 'evidence://trusted/verifier-result',
        checked_at: '2026-08-08T00:01:00Z',
        revocation_status: revocationStatus,
        revocation_evidence_ref: revocationStatus === 'not_checked'
          ? null
          : 'evidence://trusted/revocation-result',
        revocation_checked_at: revocationStatus === 'not_checked'
          ? null
          : '2026-08-08T00:01:00Z',
        checks,
      };
    },
  };
}

function signedVerifier({ status = 'verified', failedCheck = null } = {}) {
  return {
    id: 'verifier://trusted/signed-artifact',
    verify(context) {
      return {
        schema: 'agoragentic.signed-artifact-verifier-evidence.v1',
        protocol: context.protocol,
        version: context.version,
        artifact_hash: context.artifact_hash,
        binding_hash: context.binding_hash,
        status,
        verifier_ref: this.id,
        evidence_ref: 'evidence://trusted/signed-artifact',
        checked_at: '2026-08-08T00:01:00Z',
        checks: Object.fromEntries(
          context.required_checks.map((name) => [name, name !== failedCheck]),
        ),
      };
    },
  };
}

function x402Options(verifierStatus = 'verified') {
  return {
    sdkVersion: '2.21.0',
    artifactRef: 'fixture://x402',
    requestRef: 'request:test',
    offerRef: 'offer:test',
    offerIssuerRef: 'issuer:test',
    receiptRef: 'receipt:test',
    receiptIssuerRef: 'issuer:test',
    settlementArtifactRef: 'settlement:test',
    challengeEvidenceRef: 'evidence:challenge',
    httpMethod: 'POST',
    operationId: 'operation:test',
    offerVerifier: signedVerifier({ status: verifierStatus }),
    receiptVerifier: signedVerifier({ status: verifierStatus }),
    settlementVerifier: signedVerifier({ status: verifierStatus }),
  };
}

function x402Binding(overrides = {}) {
  return {
    paymentIdentifier: 'payment:test',
    resourceUrl: 'https://seller.test/tool',
    scheme: 'exact',
    amount: '1.00',
    asset: 'USDC',
    network: 'eip155:8453',
    payTo: '0x1111111111111111111111111111111111111111',
    httpMethod: 'POST',
    operationId: 'operation:test',
    invocationRef: 'invocation:test',
    inputHash: 'sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
    outputHash: 'sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
    deliveryEvidenceRef: 'evidence:delivery',
    evaluatedAt: '2026-08-08T00:02:00Z',
    ...overrides,
  };
}

function preExecutionEnvelope(authority) {
  return buildTransactionAssuranceEnvelope({
    createdAt: '2026-08-08T00:02:00Z',
    normalizedAuthority: authority,
    principalIdentityVerification: 'verified',
    principalIdentityEvidenceRef: 'identity:principal',
    agentIdentityVerification: 'verified',
    agentIdentityEvidenceRef: 'identity:agent',
    commercialIntent: {
      action: 'execute:checkout',
      taskRef: 'task:test',
      sellerRef: 'merchant:test',
      capabilityRef: 'capability:test',
      category: 'commerce',
      quotedAmount: '1.00',
      currency: 'USD',
      quoteRef: 'quote:test',
      quoteHash: 'sha256:cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc',
      termsRef: 'terms:test',
      termsHash: 'sha256:dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd',
      termsMatchStatus: 'match',
    },
    payment: {
      paymentIdentifier: 'payment:test',
      rail: 'x402',
      amount: '1.00',
      currency: 'USD',
      dailySpendBefore: '0',
      totalSpendBefore: '0',
      budgetUsageRef: 'ledger:test',
    },
    execution: {
      idempotencyKeyHash: 'sha256:eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee',
      inputHash: 'sha256:ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff',
    },
  });
}

test('pins and vendored ACP schema are exact and independently reproducible', () => {
  for (const source of vectors.sources) {
    const pin = PROTOCOL_ADAPTER_PINS[source.protocol];
    assert.equal(source.version, pin.version);
    assert.equal(source.revision, pin.revision);
  }
  assert.equal(PROTOCOL_ADAPTER_PINS.x402.wire_version, 2);
  assert.equal(PROTOCOL_ADAPTER_PINS.x402.offer_receipt_version, 1);
  assert.equal(
    vectors.sources.find((item) => item.protocol === 'circle_agent_wallet_policy').revision,
    'c7d269a2025e26410e0e23fb5a73c769dc07d088',
  );
  assert.equal(
    vectors.sources.find((item) => item.protocol === 'skyfire_kyapay').revision,
    '869a71ae6f6b6646ad62ac78b6877c41784ef34e',
  );
  assert.equal(validateAcpCheckout(vectors.fixtures.official_acp.checkout_session), true);
  assert.equal(
    validateAcpCheckoutWithOrder(vectors.fixtures.official_acp_completed.checkout_session),
    true,
    JSON.stringify(validateAcpCheckoutWithOrder.errors),
  );
});

test('AP2 public Intent, Cart, and Payment mandate models normalize at the exact pin', () => {
  for (const fixture of ['ap2_intent', 'ap2_cart', 'ap2_payment']) {
    const normalized = normalizeAp2Authority(
      clone(vectors.fixtures[fixture]),
      adapterOptions({ verifier: authorityVerifier() }),
    );
    assert.equal(normalized.verification.status, 'verified');
    assert.equal(normalized.protocol_binding.verifier_trust_mode, 'trusted_callback');
    assert.equal(validateNormalizedAuthority(normalized), true, JSON.stringify(validateNormalizedAuthority.errors));
  }
  assert.throws(
    () => normalizeAp2Authority(
      clone(vectors.fixtures.ap2_payment),
      adapterOptions({ version: 'v0.1.0' }),
    ),
    /conflicting protocol version/,
  );
});

test('portable JSON cannot forge or preserve a trusted protocol-verifier boundary', () => {
  const normalized = normalizeAp2Authority(
    clone(vectors.fixtures.ap2_payment),
    adapterOptions({ verifier: authorityVerifier() }),
  );
  const envelope = preExecutionEnvelope(normalized);
  assert.equal(evaluateTransactionAssuranceEnvelope(envelope, {
    phase: 'pre_execution',
    now: '2026-08-08T00:03:00Z',
  }).decision, 'allow');
  assert.throws(
    () => preExecutionEnvelope(JSON.parse(JSON.stringify(normalized))),
    /trusted in-process verifier boundary/,
  );
  const clonedEnvelope = JSON.parse(JSON.stringify(envelope));
  const result = evaluateTransactionAssuranceEnvelope(clonedEnvelope, {
    phase: 'pre_execution',
    now: '2026-08-08T00:03:00Z',
  });
  assert.equal(result.decision, 'deny');
  assert.ok(result.blockers.includes('authority_verifier_boundary_not_trusted'));
  assert.throws(
    () => normalizeAp2Authority(
      clone(vectors.fixtures.ap2_payment),
      adapterOptions({ verifierEvidence: { status: 'verified' } }),
    ),
    /portable verifierEvidence JSON is not trusted/,
  );
});

test('Visa TAP requires merchant, purpose, consumer, payment-container, and signature metadata', () => {
  const evidence = normalizeVisaTapEvidence(
    clone(vectors.fixtures.visa_tap),
    adapterOptions({
      verifier: authorityVerifier(),
      artifactKind: 'detached-http-message-signature',
      taskRef: 'task:test',
      quoteRef: 'quote:test',
      paymentIdentifier: 'payment:test',
    }),
  );
  assert.equal(evidence.recognition.consumer_linkage_ref, 'consumer:test');
  assert.equal(evidence.recognition.payment_container_ref, 'container:test');
  assert.equal(evidence.normalized_authority.verification.status, 'verified');
  const missing = clone(vectors.fixtures.visa_tap);
  delete missing.request.payment_container_ref;
  assert.throws(() => normalizeVisaTapEvidence(missing, adapterOptions()), /payment_container_ref/);
});

test('official ACP schema and adapter preserve checkout, order, payment, fulfillment, and refund boundaries', () => {
  const ready = normalizeOfficialAcpEvidence(
    clone(vectors.fixtures.official_acp),
    adapterOptions({
      verifier: authorityVerifier(),
      checkoutSessionRef: 'checkout:test',
      requestId: 'request:test',
      idempotencyKeyHash: 'sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
    }),
  );
  assert.equal(ready.checkout.payment_handler_ref, 'acp-handler:handler:test');
  assert.equal(ready.checkout.payment_data_hash.startsWith('sha256:'), true);
  assert.equal(ready.outcome.complete_chain_verified, false);
  const completed = normalizeOfficialAcpEvidence(
    clone(vectors.fixtures.official_acp_completed),
    adapterOptions({
      checkoutSessionRef: 'checkout:test',
      requestId: 'request:test',
      idempotencyKeyHash: 'sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
    }),
  );
  assert.deepEqual(completed.outcome.fulfillment_refs, ['acp-fulfillment:fulfillment:test']);
  const missingOrder = clone(vectors.fixtures.official_acp_completed);
  delete missingOrder.checkout_session.order;
  assert.throws(() => normalizeOfficialAcpEvidence(
    missingOrder,
    adapterOptions({ checkoutSessionRef: 'checkout:test', requestId: 'request:test', idempotencyKeyHash: 'x' }),
  ), /requires an order/);
});

test('x402 parses real v2 extension shapes and binds the complete retry fingerprint', () => {
  const source = clone(vectors.fixtures.x402);
  const evidence = normalizeX402Evidence(source, x402Options());
  assert.equal(evidence.protocol_version, '2.21.0');
  assert.equal(evidence.payment_identifier, 'payment:test');
  assert.equal(evidence.fingerprint.scheme, 'exact');
  assert.equal(evidence.fingerprint.pay_to, '0x1111111111111111111111111111111111111111');
  assert.equal(evidence.settlement.verification.status, 'verified');
  const output = JSON.stringify(evidence);
  assert.equal(output.includes('synthetic-non-usable-signature'), false);
  const exact = bindX402OutcomeEvidence(evidence, x402Binding());
  assert.deepEqual(exact.mismatches, []);
  assert.equal(exact.delivery_verified, false);
  assert.equal(exact.complete_chain_verified, false);
  assert.deepEqual(exact.external_verification, {
    status: 'not_checked',
    verifier_ref: null,
    evidence_ref: null,
    checked_at: null,
    proves_delivery: false,
  });
  for (const [field, replacement, code] of [
    ['payTo', '0x3333333333333333333333333333333333333333', 'pay_to'],
    ['httpMethod', 'GET', 'http_method'],
    ['operationId', 'operation:other', 'operation_id'],
    ['scheme', 'upto', 'scheme'],
  ]) {
    const result = bindX402OutcomeEvidence(evidence, x402Binding({ [field]: replacement }));
    assert.ok(result.mismatches.includes(code));
    assert.equal(result.safe_to_reuse_payment_identifier, false);
  }
});

test('Circle and Skyfire extract bounded policy and identity/payment claims without raw credentials', () => {
  const circle = normalizeCircleWalletPolicyEvidence(
    clone(vectors.fixtures.circle),
    adapterOptions({
      bindings: { ...bindings, currency: 'USDC' },
      verifier: authorityVerifier(),
    }),
  );
  assert.equal(circle.protocol_binding.protocol_evidence.policy_state, 'active');
  assert.equal(circle.protocol_binding.protocol_evidence.asset_ref, 'USDC');
  const unsafeCircle = clone(vectors.fixtures.circle);
  unsafeCircle.private_key = 'not-allowed';
  assert.throws(() => normalizeCircleWalletPolicyEvidence(unsafeCircle, adapterOptions()), /raw credential/);

  const skyfire = normalizeSkyfireKyaPayEvidence(
    clone(vectors.fixtures.skyfire),
    adapterOptions({
      bindings: { ...bindings, audience: 'merchant:test', currency: 'USD' },
      verifier: authorityVerifier(),
    }),
  );
  assert.equal(skyfire.protocol_binding.artifact_kind, 'kya-pay+jwt');
  assert.equal(skyfire.protocol_binding.protocol_evidence.counterparty_ref, 'merchant:test');
  assert.equal(JSON.stringify(skyfire).includes('synthetic-non-usable-signature'), false);
  const unsafeSkyfire = clone(vectors.fixtures.skyfire);
  unsafeSkyfire.raw_token = 'header.payload.signature';
  assert.throws(() => normalizeSkyfireKyaPayEvidence(unsafeSkyfire, adapterOptions()), /raw credential/);
});

test('Mastercard remains reference-only without a public immutable schema', () => {
  const normalized = normalizeMastercardVerifiableIntentEvidence(
    clone(vectors.fixtures.mastercard),
    adapterOptions({ version: PROTOCOL_ADAPTER_PINS.mastercard_verifiable_intent.version }),
  );
  assert.equal(normalized.verification.status, 'unverified');
  assert.ok(normalized.protocol_binding.unsupported_fields.includes('cryptographic_verification'));
  assert.throws(() => normalizeMastercardVerifiableIntentEvidence(
    clone(vectors.fixtures.mastercard),
    adapterOptions({ verifier: authorityVerifier() }),
  ), /unsupported without a public immutable schema/);
});

function runVector(vector) {
  const artifact = inputFor(vector.input);
  const verifierConfig = vector.verifier;
  const verifier = verifierConfig
    ? authorityVerifier({
        status: verifierConfig.status,
        failedCheck: verifierConfig.failed_check,
        revocationStatus: verifierConfig.revocation_status
          ?? (verifierConfig.status === 'verified' ? 'active' : 'not_checked'),
      })
    : undefined;
  const options = adapterOptions({ ...vector.options, verifier });
  if (vector.adapter === 'google_ap2') return normalizeAp2Authority(artifact, options);
  if (vector.adapter === 'visa_tap') {
    return normalizeVisaTapEvidence(artifact, {
      ...options,
      artifactKind: 'detached-http-message-signature',
      taskRef: 'task:test',
      quoteRef: 'quote:test',
      paymentIdentifier: 'payment:test',
    });
  }
  if (vector.adapter === 'openai_stripe_acp') {
    return normalizeOfficialAcpEvidence(artifact, {
      ...options,
      checkoutSessionRef: 'checkout:test',
      requestId: 'request:test',
      idempotencyKeyHash: 'sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
    });
  }
  if (vector.adapter === 'x402') {
    const verifierStatus = verifierConfig?.status ?? 'verified';
    const evidence = normalizeX402Evidence(artifact, x402Options(verifierStatus));
    return {
      evidence,
      binding: bindX402OutcomeEvidence(evidence, x402Binding(vector.binding)),
    };
  }
  if (vector.adapter === 'circle_agent_wallet_policy') {
    return normalizeCircleWalletPolicyEvidence(artifact, {
      ...options,
      bindings: { ...bindings, currency: 'USDC' },
    });
  }
  if (vector.adapter === 'skyfire_kyapay') {
    return normalizeSkyfireKyaPayEvidence(artifact, {
      ...options,
      bindings: { ...bindings, audience: 'merchant:test', currency: 'USD' },
    });
  }
  if (vector.adapter === 'mastercard_verifiable_intent') {
    return normalizeMastercardVerifiableIntentEvidence(artifact, options);
  }
  throw new Error(`unknown adapter: ${vector.adapter}`);
}

function assertVector(vector, result) {
  const outcome = vector.expected.outcome;
  const authority = result?.normalized_authority ?? result?.evidence?.normalized_authority ?? result;
  if (outcome === 'verified') assert.equal(authority.verification.status, 'verified');
  else if (outcome === 'failed') assert.equal(authority.verification.status, 'failed');
  else if (outcome === 'unverified') assert.equal(authority.verification.status, 'unverified');
  else if (outcome === 'duplicate') assert.equal(result.checkout.duplicate_detected, true);
  else if (outcome === 'merchant_declared') assert.equal(result.outcome.merchant_declared_only, true);
  else if (outcome === 'refund_declared') assert.equal(result.protocol_states.refund, 'merchant_declared');
  else if (outcome === 'bound') assert.deepEqual(result.binding.mismatches, []);
  else if (outcome === 'expired') assert.equal(result.binding.offer_expired, true);
  else if (outcome === 'settlement_unverified') assert.notEqual(result.evidence.settlement.verification.status, 'verified');
  else if (outcome === 'delivery_unverified') assert.equal(result.binding.delivery_verified, false);
  else if (outcome === 'settlement_verified_not_delivery') {
    assert.equal(result.binding.settlement_verified, true);
    assert.equal(result.binding.complete_chain_verified, false);
  } else if (outcome.startsWith('mismatch:')) {
    assert.ok(result.binding.mismatches.includes(outcome.slice('mismatch:'.length)));
  } else throw new Error(`unhandled vector outcome: ${outcome}`);
}

test('every advertised protocol vector executes and asserts an outcome or rejection', () => {
  assert.ok(vectors.vectors.length >= 40);
  const ids = new Set();
  for (const vector of vectors.vectors) {
    assert.equal(ids.has(vector.id), false, `duplicate vector ${vector.id}`);
    ids.add(vector.id);
    assert.ok(vector.input?.fixture, `${vector.id} has executable input`);
    assert.ok(vector.expected?.outcome, `${vector.id} has an expected outcome`);
    if (vector.expected.outcome === 'reject') {
      assert.throws(() => runVector(vector), undefined, vector.id);
    } else {
      assertVector(vector, runVector(vector));
    }
  }
});
