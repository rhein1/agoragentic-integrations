import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import {
  buildAuthorityRequest,
  buildTransactionAssuranceEnvelope,
  canonicalize,
  detectAuthorityProtocol,
  evaluateTransactionAssuranceEnvelope,
  normalizeAuthorityArtifact,
  sha256Ref,
} from '../src/index.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const cli = path.join(root, 'bin', 'agora-assure.mjs');

const NOW = '2026-08-06T00:01:00Z';

function nativeArtifact(overrides = {}) {
  return {
    schema: 'agoragentic.agent-commerce.mandate.v1',
    owner_id: 'owner:test',
    buyer_agent_id: 'agent:test',
    issued_at: '2026-08-06T00:00:00Z',
    expires_at: '2026-08-07T00:00:00Z',
    scope: {
      allowed_actions: ['execute:research'],
      allowed_sellers: ['seller:test'],
      allowed_categories: ['research'],
      allowed_payment_rails: ['x402'],
    },
    budget: {
      currency: 'USDC',
      max_per_action: '0.10',
      max_daily: '1.00',
      max_total: '5.00',
    },
    ...overrides,
  };
}

function verifiedAuthority(overrides = {}) {
  return normalizeAuthorityArtifact(nativeArtifact(), {
    artifactRef: 'fixture:mandate',
    verification: {
      status: 'verified',
      verifierRef: 'fixture:verifier',
      evidenceRef: 'fixture:signature-proof',
      checkedAt: '2026-08-06T00:00:01Z',
    },
    revocationStatus: 'active',
    ...overrides,
  });
}

function envelopeInput(overrides = {}) {
  return {
    createdAt: NOW,
    updatedAt: NOW,
    now: NOW,
    principalRef: 'owner:test',
    principalType: 'human',
    principalIdentityVerification: 'verified',
    agentRef: 'agent:test',
    agentUri: 'agent://test',
    agentIdentityVerification: 'verified',
    normalizedAuthority: verifiedAuthority(),
    commercialIntent: {
      action: 'execute:research',
      taskRef: 'task:test',
      sellerRef: 'seller:test',
      capabilityRef: 'capability:test',
      category: 'research',
      quoteRef: 'quote:test',
      quoteHash: sha256Ref({ amount: '0.05', currency: 'USDC' }),
      quotedAmount: '0.05',
      currency: 'USDC',
      termsRef: 'terms:test',
      termsHash: sha256Ref({ delivery: 'json' }),
      termsMatchStatus: 'match',
    },
    payment: {
      paymentIdentifier: 'payment:test',
      rail: 'x402',
      status: 'not_started',
      amount: '0.05',
      currency: 'USDC',
    },
    execution: {
      idempotencyKeyHash: sha256Ref('idempotency:test'),
      inputHash: sha256Ref({ query: 'test' }),
    },
    outcome: {
      verificationScope: 'Verify JSON shape and cited source references.',
      unknowns: ['No execution has occurred.'],
    },
    ...overrides,
  };
}

function assertNoAuthority(flags) {
  for (const [key, value] of Object.entries(flags)) {
    assert.equal(value, false, `${key} must remain false`);
  }
}

function collectObjectKeys(value, output = []) {
  if (Array.isArray(value)) {
    value.forEach((item) => collectObjectKeys(item, output));
  } else if (value && typeof value === 'object') {
    for (const [key, child] of Object.entries(value)) {
      output.push(key);
      collectObjectKeys(child, output);
    }
  }
  return output;
}

test('canonicalization and hashes are deterministic across object key order', () => {
  const left = { z: 1, a: { y: 2, b: [3, { d: 4, c: 5 }] } };
  const right = { a: { b: [3, { c: 5, d: 4 }], y: 2 }, z: 1 };
  assert.equal(canonicalize(left), canonicalize(right));
  assert.equal(sha256Ref(left), sha256Ref(right));
  assert.match(sha256Ref(left), /^sha256:[a-f0-9]{64}$/);
});

test('protocol detection recognizes the supported evidence families without claiming verification', () => {
  const cases = [
    [nativeArtifact(), 'agoragentic_mandate'],
    [{ intentMandate: { id: 'm1' }, ap2: '0.2' }, 'google_ap2'],
    [{ agentRecognition: {}, paymentContainer: {}, signatureInput: 'sig1' }, 'visa_tap'],
    [{ schema: 'https://agentic-commerce-protocol.org/schema', agenticCheckout: {} }, 'openai_stripe_acp'],
    [{ x402Version: 2, paymentIdentifier: 'p1', signedReceipt: {} }, 'x402'],
    [{ circleAgentWallet: true, spendingPolicy: { daily: '1.00' } }, 'circle_agent_wallet_policy'],
    [{ kyaPay: true, 'skyfire-pay-id': 'token-ref' }, 'skyfire_kyapay'],
    [{ verifiableIntent: { id: 'vi1' }, mastercardAgentPay: true }, 'mastercard_verifiable_intent'],
    [{ arbitrary: true }, 'other'],
  ];

  for (const [artifact, expected] of cases) {
    const detection = detectAuthorityProtocol(artifact);
    assert.equal(detection.protocol, expected);
    assert.notEqual(detection.confidence, 'verified');
    assert.ok(detection.reasons.length > 0);
  }
});

test('normalization preserves artifact identity but defaults to unverified and no authority', () => {
  const normalized = normalizeAuthorityArtifact(nativeArtifact(), {
    artifactRef: 'fixture:native',
  });

  assert.equal(normalized.source_protocol, 'agoragentic_mandate');
  assert.equal(normalized.source_artifact_ref, 'fixture:native');
  assert.match(normalized.source_artifact_hash, /^sha256:[a-f0-9]{64}$/);
  assert.equal(normalized.source_artifact_embedded, false);
  assert.equal(normalized.verification.status, 'unverified');
  assert.equal(normalized.revocation_status, 'not_checked');
  assert.equal(normalized.principal_ref, 'owner:test');
  assert.equal(normalized.agent_ref, 'agent:test');
  assert.deepEqual(normalized.allowed_payment_rails, ['x402']);
  assertNoAuthority(normalized.authority_flags);
  assert.ok(normalized.normalization_warnings.some((warning) => /not cryptographically/.test(warning)));
});

test('a protocol hint changes recognition only and does not verify the artifact', () => {
  const normalized = normalizeAuthorityArtifact({ opaque: true }, {
    protocolHint: 'google_ap2',
  });
  assert.equal(normalized.source_protocol, 'google_ap2');
  assert.equal(normalized.detection.confidence, 'hinted');
  assert.equal(normalized.verification.status, 'unverified');
});

test('authority requests are proposal-only and use decimal strings', () => {
  const request = buildAuthorityRequest({
    requestId: 'aar_test',
    createdAt: '2026-08-06T00:00:00Z',
    expiresAt: '2026-08-06T01:00:00Z',
    principalRef: 'owner:test',
    agentId: 'agent:test',
    purpose: 'Purchase bounded research calls',
    allowedActions: ['execute:research'],
    allowedCategories: ['research'],
    allowedPaymentRails: ['x402'],
    currency: 'USDC',
    maxPerAction: 0.1,
    maxDaily: 1,
    maxTotal: 5,
  });

  assert.equal(request.status, 'pending_principal_approval');
  assert.equal(request.approval, null);
  assert.equal(request.request_grants_authority, false);
  assert.deepEqual(Object.keys(request.authority_flags).sort(), [
    'can_change_trust',
    'can_deploy',
    'can_expand_scope',
    'can_fund_wallet',
    'can_publish',
    'can_spend',
  ]);
  assertNoAuthority(request.authority_flags);
  assert.equal(request.requested_authority.max_per_action, '0.1');
  assert.equal(request.requested_authority.max_daily, '1');
  assert.equal(request.requested_authority.max_total, '5');
  assert.throws(() => buildAuthorityRequest({
    principalRef: 'owner:test',
    agentId: 'agent:test',
    purpose: 'No action',
  }), /allowed action/);
});

test('verified scoped authority produces an authority-ready pre-execution envelope', () => {
  const envelope = buildTransactionAssuranceEnvelope(envelopeInput());
  assert.equal(envelope.state, 'authority_ready');
  assert.equal(envelope.authority.verification_status, 'verified');
  assert.equal(envelope.authority.revocation_status, 'active');
  assert.equal(envelope.commercial_intent.action, 'execute:research');
  assert.equal(envelope.payment.status, 'not_started');
  assert.equal(envelope.execution.status, 'not_started');
  assert.equal(envelope.evidence.complete_chain_verified, false);
  assert.match(envelope.evidence.envelope_hash, /^sha256:[a-f0-9]{64}$/);
  assertNoAuthority(envelope.authority_flags);
  for (const value of Object.values(envelope.redaction)) assert.equal(value, true);

  const evaluation = evaluateTransactionAssuranceEnvelope(envelope, {
    phase: 'pre_execution',
    now: NOW,
  });
  assert.equal(evaluation.decision, 'allow');
  assert.deepEqual(evaluation.blockers, []);
  assert.equal(evaluation.complete_chain_verified, false);
  assertNoAuthority(evaluation.authority_flags);
});

test('unverified, revoked, expired, mismatched, or changed authority fails closed', () => {
  const scenarios = [
    {
      name: 'unverified',
      mutate(input) {
        input.normalizedAuthority = normalizeAuthorityArtifact(nativeArtifact(), {
          verification: { status: 'unverified' },
          revocationStatus: 'active',
        });
      },
      blocker: 'authority_not_verified',
    },
    {
      name: 'revoked',
      mutate(input) { input.normalizedAuthority = verifiedAuthority({ revocationStatus: 'revoked' }); },
      blocker: 'authority_revoked',
    },
    {
      name: 'expired',
      mutate(input) {
        input.normalizedAuthority = normalizeAuthorityArtifact(nativeArtifact({ expires_at: '2026-08-05T00:00:00Z' }), {
          verification: { status: 'verified' },
          revocationStatus: 'active',
        });
      },
      blocker: 'authority_expired',
    },
    {
      name: 'seller mismatch',
      mutate(input) { input.commercialIntent = { ...input.commercialIntent, sellerRef: 'seller:other' }; },
      blocker: 'seller_out_of_scope',
    },
    {
      name: 'changed terms',
      mutate(input) { input.commercialIntent = { ...input.commercialIntent, termsMatchStatus: 'changed' }; },
      blocker: 'terms_changed',
    },
    {
      name: 'over budget',
      mutate(input) {
        input.commercialIntent = { ...input.commercialIntent, quotedAmount: '0.50' };
        input.payment = { ...input.payment, amount: '0.50' };
      },
      blocker: 'quoted_amount_exceeds_per_action_limit',
    },
  ];

  for (const scenario of scenarios) {
    const input = envelopeInput();
    scenario.mutate(input);
    const envelope = buildTransactionAssuranceEnvelope(input);
    const evaluation = evaluateTransactionAssuranceEnvelope(envelope, {
      phase: 'pre_execution',
      now: NOW,
    });
    assert.equal(evaluation.decision, 'deny', scenario.name);
    assert.ok(evaluation.blockers.includes(scenario.blocker), `${scenario.name}: ${evaluation.blockers.join(', ')}`);
  }
});

test('missing revocation, terms, or idempotency evidence requires review instead of guessing', () => {
  const normalizedAuthority = verifiedAuthority({ revocationStatus: 'not_checked' });
  const input = envelopeInput({ normalizedAuthority });
  input.commercialIntent = { ...input.commercialIntent, termsMatchStatus: 'not_checked' };
  input.execution = { ...input.execution, idempotencyKeyHash: null };
  const envelope = buildTransactionAssuranceEnvelope(input);
  const evaluation = evaluateTransactionAssuranceEnvelope(envelope, {
    phase: 'pre_execution',
    now: NOW,
  });
  assert.equal(evaluation.decision, 'review');
  assert.ok(evaluation.blockers.includes('authority_revocation_not_verified_active'));
  assert.ok(evaluation.blockers.includes('terms_not_verified'));
  assert.ok(evaluation.blockers.includes('idempotency_key_missing'));
});

test('duplicate attempts are denied before payment', () => {
  const input = envelopeInput();
  input.execution = { ...input.execution, duplicateDetected: true };
  const evaluation = evaluateTransactionAssuranceEnvelope(
    buildTransactionAssuranceEnvelope(input),
    { phase: 'pre_execution', now: NOW },
  );
  assert.equal(evaluation.decision, 'deny');
  assert.ok(evaluation.blockers.includes('duplicate_attempt_detected'));
});

test('payment without delivery remains incomplete and reviewable', () => {
  const input = envelopeInput();
  input.payment = {
    ...input.payment,
    status: 'settled',
    receiptRef: 'receipt:test',
    receiptHash: sha256Ref({ receipt: 'test' }),
    settlementRef: 'settlement:test',
    settlementVerification: 'verified',
    settlementFinal: true,
  };
  input.execution = {
    ...input.execution,
    status: 'failed',
    invocationRef: 'invocation:test',
    attemptCount: 1,
    outputHash: null,
  };
  input.outcome = {
    ...input.outcome,
    deliveryStatus: 'failed',
    verificationStatus: 'failed',
  };
  input.reconciliation = {
    status: 'pending',
    result: 'Payment settled but delivery failed.',
    nextSafeAction: 'Request seller evidence or prepare a refund/dispute packet.',
  };

  const envelope = buildTransactionAssuranceEnvelope(input);
  assert.equal(envelope.state, 'failed');
  const evaluation = evaluateTransactionAssuranceEnvelope(envelope, {
    phase: 'post_execution',
    now: NOW,
  });
  assert.equal(evaluation.decision, 'review');
  assert.ok(evaluation.blockers.includes('execution_not_successful'));
  assert.ok(evaluation.blockers.includes('delivery_not_confirmed'));
  assert.ok(evaluation.blockers.includes('outcome_not_verified'));
  assert.ok(evaluation.blockers.includes('reconciliation_not_complete'));
  assert.equal(evaluation.complete_chain_verified, false);
});

test('delivery without verified final settlement remains incomplete', () => {
  const input = envelopeInput();
  input.payment = {
    ...input.payment,
    status: 'observed',
    settlementVerification: 'unverified',
    settlementFinal: false,
  };
  input.execution = {
    ...input.execution,
    status: 'success',
    attemptCount: 1,
    outputHash: sha256Ref({ answer: 'delivered' }),
  };
  input.outcome = {
    ...input.outcome,
    deliveryStatus: 'delivered',
    verificationStatus: 'verified',
    validationRefs: ['validator:test'],
  };
  input.reconciliation = {
    status: 'pending',
    result: 'Delivery verified; settlement not final.',
    nextSafeAction: 'Wait for finality or follow the configured recovery path.',
  };

  const evaluation = evaluateTransactionAssuranceEnvelope(
    buildTransactionAssuranceEnvelope(input),
    { phase: 'post_execution', now: NOW },
  );
  assert.equal(evaluation.decision, 'review');
  assert.ok(evaluation.blockers.includes('settlement_not_verified'));
  assert.ok(evaluation.blockers.includes('settlement_not_final'));
  assert.equal(evaluation.complete_chain_verified, false);
});

test('a complete post-execution chain can be marked complete without granting authority', () => {
  const input = envelopeInput();
  input.payment = {
    ...input.payment,
    status: 'settled',
    offerRef: 'offer:test',
    offerHash: sha256Ref({ offer: 'test' }),
    receiptRef: 'receipt:test',
    receiptHash: sha256Ref({ receipt: 'test' }),
    settlementRef: 'settlement:test',
    settlementVerification: 'verified',
    settlementFinal: true,
  };
  input.execution = {
    ...input.execution,
    status: 'success',
    invocationRef: 'invocation:test',
    attemptCount: 1,
    outputHash: sha256Ref({ answer: 'verified' }),
    startedAt: '2026-08-06T00:01:05Z',
    completedAt: '2026-08-06T00:01:06Z',
  };
  input.outcome = {
    ...input.outcome,
    deliveryStatus: 'delivered',
    artifactRefs: ['artifact:test'],
    sellerAttestationRef: 'seller-attestation:test',
    validationRefs: ['validator:test'],
    verificationStatus: 'verified',
    unknowns: [],
  };
  input.reconciliation = {
    status: 'complete',
    result: 'Authority, terms, payment, execution, delivery, validation, and finality match.',
    nextSafeAction: 'No further transaction action is required.',
  };

  const envelope = buildTransactionAssuranceEnvelope(input);
  assert.equal(envelope.state, 'reconciled');
  const evaluation = evaluateTransactionAssuranceEnvelope(envelope, {
    phase: 'post_execution',
    now: NOW,
  });
  assert.equal(evaluation.decision, 'complete');
  assert.deepEqual(evaluation.blockers, []);
  assert.equal(evaluation.complete_chain_verified, true);
  assertNoAuthority(evaluation.authority_flags);
});

test('public objects exclude raw secret values and forbidden private payload fields', () => {
  const normalized = verifiedAuthority();
  const envelope = buildTransactionAssuranceEnvelope(envelopeInput());
  const keys = collectObjectKeys({ normalized, envelope });
  const forbiddenPayloadKeys = new Set([
    'private_key',
    'privateKey',
    'seed_phrase',
    'seedPhrase',
    'mnemonic',
    'raw_prompt',
    'rawPrompt',
    'raw_tool_output',
    'rawToolOutput',
    'payment_credential',
    'paymentCredential',
    'wallet_private_data',
    'walletPrivateData',
  ]);
  assert.deepEqual(keys.filter((key) => forbiddenPayloadKeys.has(key)), []);

  const serialized = JSON.stringify({ normalized, envelope });
  assert.doesNotMatch(serialized, /\bamk_[A-Za-z0-9_-]{12,}\b/);
  assert.doesNotMatch(serialized, /BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY/);
  assert.equal(envelope.redaction.raw_prompt_excluded, true);
  assert.equal(envelope.redaction.raw_tool_output_excluded, true);
  assert.equal(envelope.redaction.raw_payment_credentials_excluded, true);
});

test('CLI self-test is offline, no-spend, and successful', () => {
  const result = spawnSync(process.execPath, [cli, 'self-test'], {
    cwd: root,
    encoding: 'utf8',
    env: {
      PATH: process.env.PATH,
      AGORAGENTIC_NO_SPEND: '1',
      AGORAGENTIC_ALLOW_REAL_SPEND: '0',
    },
  });
  assert.equal(result.status, 0, result.stderr);
  const parsed = JSON.parse(result.stdout);
  assert.equal(parsed.ok, true);
  assert.equal(parsed.no_network, true);
  assert.equal(parsed.no_spend, true);
  assert.equal(parsed.authority_granted_by_cli, false);
});

test('package remains unpublished until review and release provenance are complete', () => {
  const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
  assert.equal(pkg.private, true);
  assert.equal(pkg.name, '@agoragentic/transaction-assurance');
  assert.equal(pkg.engines.node, '>=20');
});
