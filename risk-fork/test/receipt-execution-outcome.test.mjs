import assert from 'node:assert/strict';
import test from 'node:test';

import { sha256Ref } from '../src/canonical.mjs';
import { createLifecycle, transitionLifecycle } from '../src/lifecycle.mjs';
import {
  createRiskForkReceipt,
  verifyRiskForkReceipt,
  verifyRiskForkReceiptStructure,
} from '../src/receipt.mjs';
import { classifyRisk } from '../src/risk-classifier.mjs';
import {
  NOW,
  hash,
  makeCapsule,
  makeForkIdentity,
} from './helpers.mjs';

const CAPABILITY_KEYS = Object.freeze([
  'network_access',
  'filesystem_read',
  'filesystem_write',
  'credential_access',
  'wallet_or_payment',
  'deployment',
  'publication',
  'communication',
  'database_mutation',
  'trust_or_reputation_mutation',
  'external_side_effect',
  'unknown_or_unclassified',
]);

function fullCapabilities(overrides = {}) {
  return Object.fromEntries(CAPABILITY_KEYS.map((key) => [
    key,
    overrides[key] ?? false,
  ]));
}

function decisionFor(capsule) {
  return classifyRisk({
    mcp_phase: capsule.proposed_interaction.mcp_method,
    mcp_server_ref: capsule.proposed_interaction.mcp_server_ref,
    mcp_server_origin: capsule.proposed_interaction.mcp_server_origin,
    mcp_server_trust: 'verified',
    tool_name: capsule.proposed_interaction.tool_name,
    capabilities: fullCapabilities({ filesystem_write: true }),
  });
}

function append(lifecycle, to, options = {}) {
  return transitionLifecycle(lifecycle, {
    actor: 'clean_controller',
    expected_version: lifecycle.version,
    expected_chain_head: lifecycle.chain_head,
    to,
    at: NOW,
    reason: to.toLowerCase(),
    evidence: options.evidence ?? {
      status: 'observed',
      ref: `event:${to.toLowerCase()}`,
      hash: hash(to),
      detail: to.toLowerCase(),
    },
    ...(options.resource ? { fork_resource_state: options.resource } : {}),
  });
}

function failedExecutionLifecycle() {
  let lifecycle = createLifecycle({
    run_id: 'run:failed-execution-receipt',
    requested_at: NOW,
    actor: 'clean_controller',
    reason: 'requested',
    evidence: {
      status: 'observed',
      ref: 'event:requested',
      hash: hash('requested'),
      detail: 'requested',
    },
  });
  lifecycle = append(lifecycle, 'SAVEPOINTING');
  lifecycle = append(lifecycle, 'SAVEPOINT_READY');
  lifecycle = append(lifecycle, 'FORK_STARTING');
  lifecycle = append(lifecycle, 'FORK_READY', { resource: 'ACTIVE' });
  lifecycle = append(lifecycle, 'EXECUTING');
  lifecycle = append(lifecycle, 'EXECUTION_FAILED', {
    evidence: {
      status: 'failed',
      ref: 'event:execution-failed',
      hash: hash('execution-failed'),
      detail: 'execution_failed',
    },
  });
  lifecycle = append(lifecycle, 'DESTROYING', { resource: 'DESTROY_REQUESTED' });
  lifecycle = append(lifecycle, 'DESTROYED', {
    resource: 'DESTROYED',
    evidence: {
      status: 'verified',
      ref: 'event:destroyed',
      hash: hash('destroyed'),
      detail: 'resources_absent',
    },
  });
  return lifecycle;
}

function claim(name, status, outcome) {
  return {
    status,
    outcome,
    evidence_ref: `claim:${name}`,
    evidence_hash: hash(`claim:${name}`),
  };
}

function failedReceiptInput(overrides = {}) {
  const capsule = overrides.capsule ?? makeCapsule();
  const lifecycle = overrides.lifecycle ?? failedExecutionLifecycle();
  const destructionEvent = lifecycle.events.find((event) => event.to === 'DESTROYED');
  assert.ok(destructionEvent?.evidence?.ref);
  assert.ok(destructionEvent?.evidence?.hash);
  const destructionClaim = {
    status: 'verified',
    outcome: 'success',
    evidence_ref: destructionEvent.evidence.ref,
    evidence_hash: destructionEvent.evidence.hash,
  };
  return {
    created_at: NOW,
    capsule,
    risk_decision: decisionFor(capsule),
    lifecycle,
    fork_identity: makeForkIdentity(capsule),
    fork_ref: 'fork:failed-execution',
    provider_ref: 'provider:reference',
    provider_capabilities_hash: hash('provider-capabilities'),
    savepoint_claim: claim('savepoint', 'observed', 'success'),
    fork_start_claim: claim('fork-start', 'observed', 'success'),
    execution_claim: claim('execution-failed', 'failed', 'failure'),
    result_digest: null,
    credential_revocation_claim: {
      status: 'not_applicable',
      outcome: 'not_applicable',
      evidence_ref: null,
      evidence_hash: null,
    },
    destruction_claim: destructionClaim,
    destruction_evidence: {
      status: 'verified',
      provider_ref: 'provider:reference',
      fork_ref: 'fork:failed-execution',
      evidence_ref: destructionClaim.evidence_ref,
      evidence_hash: destructionClaim.evidence_hash,
    },
    transaction_assurance_evidence_refs: [],
    measurements: {},
    ...overrides,
  };
}

function correctlyRehash(receipt) {
  const copy = structuredClone(receipt);
  copy.receipt_hash = null;
  copy.receipt_hash = sha256Ref({ ...copy, receipt_hash: null });
  return copy;
}

test('receipt construction rejects a successful execution claim for EXECUTION_FAILED', () => {
  const input = failedReceiptInput();
  const failureDigest = input.lifecycle.events.find(
    (event) => event.to === 'EXECUTION_FAILED',
  ).evidence.hash;

  assert.throws(
    () => createRiskForkReceipt({
      ...input,
      execution_claim: claim('dishonest-success', 'observed', 'success'),
      result_digest: failureDigest,
    }),
    /execution|failed|TAINTED|lifecycle/i,
  );
});

test('receipt construction accepts an honestly failed execution without a result digest', () => {
  const input = failedReceiptInput();
  const receipt = createRiskForkReceipt(input);

  assert.equal(receipt.lifecycle.state, 'DESTROYED');
  assert.equal(receipt.claims.execution.status, 'failed');
  assert.equal(receipt.claims.execution.outcome, 'failure');
  assert.equal(receipt.taint.result_digest, null);
  assert.equal(verifyRiskForkReceipt(receipt, {
    risk_decision: input.risk_decision,
  }), true);
});

test('receipt verification rejects rehashed execution-outcome contradictions', async (t) => {
  const honest = createRiskForkReceipt(failedReceiptInput());

  await t.test('failure claim flipped to observed success', () => {
    const tampered = structuredClone(honest);
    tampered.claims.execution.status = 'observed';
    tampered.claims.execution.outcome = 'success';

    assert.throws(
      () => verifyRiskForkReceiptStructure(correctlyRehash(tampered)),
      /execution|result digest|failed|lifecycle/i,
    );
  });

  await t.test('failed outcome carrying a result digest', () => {
    const tampered = structuredClone(honest);
    tampered.taint.result_digest = hash('execution-failed');

    assert.throws(
      () => verifyRiskForkReceiptStructure(correctlyRehash(tampered)),
      /execution|result digest|failed|lifecycle/i,
    );
  });
});
