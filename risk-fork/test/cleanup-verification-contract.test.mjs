import assert from 'node:assert/strict';
import test from 'node:test';

import {
  CLEANUP_VERIFICATION_EVIDENCE_SCHEMA,
  CLEANUP_VERIFICATION_REQUEST_SCHEMA,
  createCleanupVerificationEvidence,
  createCleanupVerificationRequest,
  verifyCleanupVerificationEvidence,
  verifyCleanupVerificationRequest,
} from '../src/provider.mjs';

const OBSERVATION_HASH = `sha256:${'a'.repeat(64)}`;

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function request(overrides = {}) {
  return createCleanupVerificationRequest({
    provider_id: 'provider:test',
    resource_kind: 'fork',
    resource_ref: 'fork:test-123',
    requested_at: '2026-08-29T12:00:00.000Z',
    request_nonce: 'nonce:test-123',
    ...overrides,
  });
}

function evidence(cleanupRequest, overrides = {}) {
  return createCleanupVerificationEvidence(cleanupRequest, {
    status: 'verified',
    outcome: 'success',
    observed_at: '2026-08-29T12:00:01.000Z',
    evidence_ref: 'absence:test-123',
    observation_hash: OBSERVATION_HASH,
    ...overrides,
  });
}

test('cleanup request and evidence form a closed provider/resource/method/time/hash contract', () => {
  const cleanupRequest = request();
  const cleanupEvidence = evidence(cleanupRequest);

  assert.equal(cleanupRequest.schema, CLEANUP_VERIFICATION_REQUEST_SCHEMA);
  assert.equal(cleanupRequest.destroy_method, 'destroyFork');
  assert.equal(cleanupRequest.verify_method, 'verifyDestroyed');
  assert.match(cleanupRequest.request_hash, /^sha256:[a-f0-9]{64}$/);
  assert.equal(cleanupEvidence.schema, CLEANUP_VERIFICATION_EVIDENCE_SCHEMA);
  assert.equal(cleanupEvidence.cleanup_request_hash, cleanupRequest.request_hash);
  assert.match(cleanupEvidence.evidence_hash, /^sha256:[a-f0-9]{64}$/);

  assert.deepEqual(
    verifyCleanupVerificationRequest(cleanupRequest, {
      provider_id: 'provider:test',
      resource_kind: 'fork',
      resource_ref: 'fork:test-123',
    }),
    cleanupRequest,
  );
  assert.deepEqual(
    verifyCleanupVerificationEvidence(cleanupEvidence, cleanupRequest, {
      now: '2026-08-29T12:00:02.000Z',
    }),
    cleanupEvidence,
  );
});

test('cleanup evidence rejects cross-provider and resource substitution', () => {
  const cleanupRequest = request();
  const cleanupEvidence = evidence(cleanupRequest);
  const crossProvider = { ...clone(cleanupEvidence), provider_id: 'provider:other' };
  const substitutedResource = { ...clone(cleanupEvidence), resource_ref: 'fork:other' };

  assert.throws(
    () => verifyCleanupVerificationEvidence(crossProvider, cleanupRequest, {
      now: '2026-08-29T12:00:02.000Z',
    }),
    /binding mismatch: provider_id/,
  );
  assert.throws(
    () => verifyCleanupVerificationEvidence(substitutedResource, cleanupRequest, {
      now: '2026-08-29T12:00:02.000Z',
    }),
    /binding mismatch: resource_ref/,
  );
});

test('cleanup evidence rejects stale observations, request replay, and hash tampering', () => {
  const cleanupRequest = request();
  const cleanupEvidence = evidence(cleanupRequest);
  const laterRequest = request({ request_nonce: 'nonce:test-456' });
  const tampered = { ...clone(cleanupEvidence), observation_hash: `sha256:${'b'.repeat(64)}` };

  assert.throws(
    () => verifyCleanupVerificationEvidence(cleanupEvidence, cleanupRequest, {
      now: '2026-08-29T12:10:02.000Z',
    }),
    /stale or outside the request window/,
  );
  assert.throws(
    () => verifyCleanupVerificationEvidence(cleanupEvidence, laterRequest, {
      now: '2026-08-29T12:00:02.000Z',
    }),
    /request binding mismatch/,
  );
  assert.throws(
    () => verifyCleanupVerificationEvidence(tampered, cleanupRequest, {
      now: '2026-08-29T12:00:02.000Z',
    }),
    /evidence hash mismatch/,
  );
});

test('cleanup schemas reject extra fields and method substitution', () => {
  const cleanupRequest = request();
  const cleanupEvidence = evidence(cleanupRequest);
  const extraEvidence = { ...clone(cleanupEvidence), provider_claim: 'trusted' };
  const substitutedMethod = { ...clone(cleanupRequest), verify_method: 'verifySavepointDestroyed' };

  assert.throws(
    () => verifyCleanupVerificationEvidence(extraEvidence, cleanupRequest, {
      now: '2026-08-29T12:00:02.000Z',
    }),
    /unsupported fields: provider_claim/,
  );
  assert.throws(
    () => verifyCleanupVerificationRequest(substitutedMethod),
    /verify_method/,
  );
});
