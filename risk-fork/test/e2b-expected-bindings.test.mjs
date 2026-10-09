import assert from 'node:assert/strict';
import { generateKeyPairSync, sign } from 'node:crypto';
import test from 'node:test';
import { canonicalize, sha256Ref } from '../src/canonical.mjs';
import {
  E2B_EXTERNAL_BIRTH_CONTROLS,
  E2B_EXTERNAL_PROVIDER_CONTROLS,
  E2B_EXTERNAL_QUALIFICATION_EVIDENCE_REFS,
  E2B_QUALIFICATION_CONTROLS,
  applyE2BExternalQualificationObservation,
  createE2BExternalQualificationObservationVerifier,
  createE2BQualificationEvidence,
  createE2BQualificationTrustVerifier,
  isE2BQualificationEvidenceCanonical,
  sha256BytesRef,
  validateE2BQualificationEvidence,
  verifyE2BQualificationTrust,
} from '../src/e2b-qualification.mjs';

// Synthetic, provider-free provisional evidence. This never claims isolation,
// finalized billing, independent observation or production qualification.
function evidenceFixture() {
  return createE2BQualificationEvidence({
    provider: { name: 'e2b', project_ref_hash: sha256Ref('synthetic-project'), region: 'test-region' },
    sdk: { package: 'e2b', version: '2.39.0', integrity_hash: sha256Ref('synthetic-sdk') },
    template: {
      template_id_hash: sha256Ref('synthetic-template'),
      build_id_hash: sha256Ref('synthetic-build'),
      template_evidence_hash: sha256Ref('synthetic-template-evidence'),
      provenance_hash: sha256Ref('synthetic-provenance'),
    },
    runtime: {
      bootstrap_artifact_hash: sha256Ref('synthetic-bootstrap'),
      runner_artifact_hash: sha256Ref('synthetic-runner'),
      boot_guard_artifact_hash: sha256Ref('synthetic-boot-guard'),
    },
    run: {
      approval_ref_hash: sha256Ref('synthetic-approval-not-authority'),
      run_ref_hash: sha256Ref('synthetic-run'),
      started_at: '2030-01-01T00:00:00.000Z',
      completed_at: '2030-01-01T00:00:01.000Z',
      sandbox_count: 0,
      synthetic_workspace: true,
    },
    limits: { hard_ttl_ms: 60_000, idle_ttl_ms: 10_000, max_execution_ms: 5_000, max_cost_usd: '0.25' },
    observations: { fork_start_ms: 0, execution_ms: 0, cleanup_ms: 0, observed_cost_usd: null },
    controls: Object.fromEntries(E2B_QUALIFICATION_CONTROLS.map((key) => [
      key, 'unknown',
    ])),
    cleanup: { kill_requested: 'unknown', absence_verified: 'unknown', orphan_reconciliation: 'unknown' },
    evidence_refs: Object.values(E2B_EXTERNAL_QUALIFICATION_EVIDENCE_REFS).map((ref) => ({
      ref, hash: sha256Ref(`synthetic:${ref}`),
    })),
  });
}

function expectedFixture(evidence) {
  return {
    templateId: 'synthetic-template',
    templateHash: evidence.template.template_evidence_hash,
    bootstrapArtifactHash: evidence.runtime.bootstrap_artifact_hash,
    runnerArtifactHash: evidence.runtime.runner_artifact_hash,
  };
}

test('E2B expected-binding policy rejects misspelled and unsupported pins', () => {
  const evidence = evidenceFixture();
  for (const key of ['templateHASH', 'template_id_hash', 'adapterDigest', 'production_qualified']) {
    assert.throws(() => validateE2BQualificationEvidence(evidence, { [key]: sha256Ref('wrong') }),
      /expected E2B bindings/i);
    assert.equal(isE2BQualificationEvidenceCanonical(evidence, { [key]: sha256Ref('wrong') }), false);
  }
});

test('E2B expected-binding policy preserves valid pins and explicit unset values', () => {
  const evidence = evidenceFixture();
  const expected = expectedFixture(evidence);
  assert.deepEqual(validateE2BQualificationEvidence(evidence, expected), evidence);
  assert.deepEqual(validateE2BQualificationEvidence(evidence, Object.assign(Object.create(null), expected)), evidence);
  assert.deepEqual(validateE2BQualificationEvidence(evidence, Object.fromEntries(
    Object.keys(expected).map((key) => [key, null]),
  )), evidence);
  assert.deepEqual(validateE2BQualificationEvidence(evidence, Object.fromEntries(
    Object.keys(expected).map((key) => [key, undefined]),
  )), evidence);
  for (const key of Object.keys(expected)) {
    assert.throws(() => validateE2BQualificationEvidence(evidence, {
      ...expected, [key]: key === 'templateId' ? 'different-template' : sha256Ref('wrong'),
    }), /binding mismatch/i);
  }
});

test('E2B expected-binding policy rejects executable or hidden policy data without calling it', () => {
  const evidence = evidenceFixture();
  let calls = 0;
  const getter = {};
  Object.defineProperty(getter, 'templateHash', { enumerable: true, get() { calls += 1; return null; } });
  const hidden = {};
  Object.defineProperty(hidden, 'templateHash', { value: null });
  const symbol = { [Symbol('hidden-policy')]: sha256Ref('wrong') };
  const proxy = new Proxy({}, {
    getPrototypeOf() { calls += 1; return Object.prototype; },
    ownKeys() { calls += 1; return []; },
    get() { calls += 1; return null; },
  });
  const revoked = Proxy.revocable({}, {});
  revoked.revoke();
  for (const expected of [null, [], false, 'policy', getter, hidden, symbol, proxy, revoked.proxy,
    Object.create({ templateHash: sha256Ref('wrong') })]) {
    assert.throws(() => validateE2BQualificationEvidence(evidence, expected), /expected E2B bindings/i);
  }
  assert.equal(calls, 0);
});

test('E2B expected-binding policy does not inherit ambient prototype pins', () => {
  const evidence = evidenceFixture();
  const prior = Object.getOwnPropertyDescriptor(Object.prototype, 'templateHash');
  try {
    Object.defineProperty(Object.prototype, 'templateHash', { configurable: true, value: sha256Ref('wrong') });
    assert.deepEqual(validateE2BQualificationEvidence(evidence, {}), evidence);
  } finally {
    if (prior) Object.defineProperty(Object.prototype, 'templateHash', prior);
    else delete Object.prototype.templateHash;
  }
});

test('E2B expected-binding policy rejects noncanonical and non-string pin values', () => {
  const evidence = evidenceFixture();
  for (const expected of [
    { templateId: {} }, { templateId: '' }, { templateId: ' synthetic-template ' },
    { templateHash: {} }, { templateHash: true },
    { templateHash: ` ${evidence.template.template_evidence_hash} ` },
    { runnerArtifactHash: 'sha256:invalid' },
  ]) {
    assert.throws(() => validateE2BQualificationEvidence(evidence, expected), /expected E2B bindings/i);
  }
});

test('signed E2B trust entry points reject malformed pins before external observation verification', () => {
  const provisional = evidenceFixture();
  const observerKeys = generateKeyPairSync('ed25519');
  const trustKeys = generateKeyPairSync('ed25519');
  let clockCalls = 0;
  const keyHash = (key) => sha256BytesRef(key.export({ type: 'spki', format: 'der' }));
  const observer = createE2BExternalQualificationObservationVerifier({
    publicKey: observerKeys.publicKey,
    publicKeyHash: keyHash(observerKeys.publicKey),
    clock: () => { clockCalls += 1; return new Date('2030-01-01T00:00:03.000Z'); },
    maxReceiptAgeMs: 60_000,
    audience: {
      profile: 'agoragentic.risk-fork.e2b-qualification',
      project_ref_hash: provisional.provider.project_ref_hash,
      run_ref_hash: provisional.run.run_ref_hash,
      template_id_hash: provisional.template.template_id_hash,
      template_build_id_hash: provisional.template.build_id_hash,
    },
  });
  const observationPayload = observer.createPayload(provisional, {
    observed_at: '2030-01-01T00:00:02.000Z',
    issued_at: '2030-01-01T00:00:02.000Z',
    expires_at: '2030-01-01T00:00:30.000Z',
    observer_boundary: {
      producer_class: 'privileged_host_supervisor', status: 'unknown', evidence_hash: null,
      child_write_access: false, reusable_signing_authority_in_child: false,
    },
    birth_controls: Object.fromEntries(E2B_EXTERNAL_BIRTH_CONTROLS.map((key) => [
      key, { status: 'unknown', evidence_hash: null },
    ])),
    first_instruction_ipv4_egress_denied: false,
    first_instruction_ipv6_egress_denied: false,
    ipv6_provider_denial: { status: 'unknown', evidence_hash: null },
    provider_controls: Object.fromEntries(E2B_EXTERNAL_PROVIDER_CONTROLS.map((key) => [
      key, { status: 'unknown', evidence_hash: sha256Ref(`synthetic:${key}`) },
    ])),
    cost: {
      provider_cap: { amount_usd: '0.25', evidence_hash: sha256Ref('synthetic-cap-not-authority') },
      derived_estimate: { amount_usd: '0', evidence_hash: sha256Ref('synthetic-estimate') },
      aggregate_console_delta: { amount_usd: '0', evidence_hash: sha256Ref('synthetic-delta') },
      actual_sandbox: { status: 'unknown', amount_usd: null, evidence_hash: null },
    },
  });
  const signed = (payload, privateKey) => ({
    ...payload,
    signature: sign(null, Buffer.from(canonicalize(payload)), privateKey).toString('base64url'),
  });
  const finalized = applyE2BExternalQualificationObservation(
    provisional, signed(observationPayload, observerKeys.privateKey), observer,
  );
  const verifier = createE2BQualificationTrustVerifier({
    publicKey: trustKeys.publicKey, publicKeyHash: keyHash(trustKeys.publicKey),
  });
  const expected = expectedFixture(finalized);
  const payload = verifier.createPayload(finalized, expected, observer);
  const trust = signed(payload, trustKeys.privateKey);
  assert.deepEqual(verifyE2BQualificationTrust(finalized, trust, verifier, expected, observer), trust);
  const before = clockCalls;
  for (const badExpected of [{ templateHASH: sha256Ref('wrong') }, Object.create({ templateHash: null })]) {
    assert.throws(() => verifier.createPayload(finalized, badExpected, observer), /expected E2B bindings/i);
    assert.throws(() => verifier.verify(finalized, trust, badExpected, observer), /expected E2B bindings/i);
    assert.throws(() => verifyE2BQualificationTrust(finalized, trust, verifier, badExpected, observer),
      /expected E2B bindings/i);
  }
  assert.equal(clockCalls, before, 'malformed pins must fail before external observation callbacks');
  assert.notEqual(finalized.status, 'verified');
  assert.equal(finalized.authority_flags.production_activation_granted, false);
});
