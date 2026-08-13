import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import Ajv2020 from 'ajv/dist/2020.js';
import addFormats from 'ajv-formats';

import { sha256Ref } from '../src/canonical.mjs';
import {
  RiskForkMcpBoundary,
  createMcpInterceptionPlan,
} from '../src/interception.mjs';
import {
  createRiskForkReceipt,
  verifyRiskForkReceipt,
  verifyRiskForkReceiptStructure,
} from '../src/receipt.mjs';
import {
  classifyRisk,
  createTrustedMcpServerVerifier,
  verifyRiskDecision,
} from '../src/risk-classifier.mjs';
import { validateCommitCandidate } from '../src/taint-gate.mjs';
import {
  NOW,
  closedResultSchema,
  hash,
  makeCapsule,
  makeForkIdentity,
  makePreparedLifecycle,
} from './helpers.mjs';

const SERVER_REF = 'server:trusted-example';
const SERVER_ORIGIN = 'https://trusted-mcp.example.invalid/';
const ATTESTOR_REF = 'trust-registry:owner-v1';
const TRUST_REGISTRY_VERSION = 'trust-registry-v1';
const EVALUATED_AT = '2030-01-01T00:10:00.000Z';
const ATTESTATION_EXPIRES_AT = '2030-01-01T00:30:00.000Z';

const SAFE_CAPABILITIES = Object.freeze({
  network_access: false,
  filesystem_read: false,
  filesystem_write: false,
  credential_access: false,
  wallet_or_payment: false,
  deployment: false,
  publication: false,
  communication: false,
  database_mutation: false,
  trust_or_reputation_mutation: false,
  external_side_effect: false,
  unknown_or_unclassified: false,
});

const SAFE_ANNOTATIONS = Object.freeze({
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: false,
});

function trustedServerAttestation(overrides = {}) {
  const statement = {
    schema: 'agoragentic.risk-fork.mcp-server-attestation.v1',
    status: 'verified',
    server_ref: SERVER_REF,
    server_origin: SERVER_ORIGIN,
    attestor_ref: ATTESTOR_REF,
    evidence_hash: hash('trusted-server-evidence'),
    issued_at: '2030-01-01T00:00:00.000Z',
    expires_at: ATTESTATION_EXPIRES_AT,
    trust_registry_version: TRUST_REGISTRY_VERSION,
    signature_ref: 'signature:trusted-server-attestation',
    signature_hash: hash('trusted-server-attestation-signature'),
    ...overrides,
  };
  return {
    ...statement,
    attestation_hash: sha256Ref(statement),
  };
}

function trustedOwnerPolicy(overrides = {}) {
  return {
    trusted_server_refs: [SERVER_REF],
    trusted_attestor_refs: [ATTESTOR_REF],
    trusted_attestation_hashes: [trustedServerAttestation().attestation_hash],
    trust_registry_version: TRUST_REGISTRY_VERSION,
    ...overrides,
  };
}

function safeToolRiskInput(overrides = {}) {
  return {
    request_id: 'request:mcp-trust-remediation',
    mcp_phase: 'tools/call',
    mcp_server_ref: SERVER_REF,
    mcp_server_origin: SERVER_ORIGIN,
    mcp_server_trust: 'verified',
    mcp_server_attestation: trustedServerAttestation(),
    tool_name: 'read_only_probe',
    tool_annotations: { ...SAFE_ANNOTATIONS },
    capabilities: { ...SAFE_CAPABILITIES },
    owner_policy: trustedOwnerPolicy(),
    ...overrides,
  };
}

const trustedServerVerifier = createTrustedMcpServerVerifier((request) => ({
  schema: 'agoragentic.risk-fork.trusted-mcp-server-verification.v1',
  status: 'verified',
  request_hash: sha256Ref(request),
  evidence_ref: 'trusted-boundary:mcp-server-verification',
  evidence_hash: hash({ request, verifier: 'test-clean-host' }),
}));
const trustClock = () => new Date(EVALUATED_AT);

function assertRiskForkRequired(decision, label) {
  assert.equal(decision.level, 'HIGH', label);
  assert.equal(decision.action, 'RISK_FORK_REQUIRED', label);
}

test('MCP trust requires an exact fresh attestation from the owner-trusted registry', async (t) => {
  await t.test('a self-asserted verified state without an attestation remains HIGH', () => {
    const decision = classifyRisk({
      request_id: 'request:self-asserted-verified',
      mcp_phase: 'tools/call',
      mcp_server_ref: SERVER_REF,
      mcp_server_origin: SERVER_ORIGIN,
      mcp_server_trust: 'verified',
      tool_name: 'read_only_probe',
      tool_annotations: { ...SAFE_ANNOTATIONS },
      capabilities: { ...SAFE_CAPABILITIES },
      owner_policy: { trusted_server_refs: [SERVER_REF] },
    });

    assertRiskForkRequired(decision, 'raw verified assertions are not trust evidence');
  });

  const invalidCases = [
    {
      label: 'attestation for another server',
      input: safeToolRiskInput({
        mcp_server_attestation: trustedServerAttestation({
          server_ref: 'server:other',
        }),
      }),
    },
    {
      label: 'attestation for the wrong origin',
      input: safeToolRiskInput({
        mcp_server_attestation: trustedServerAttestation({
          server_origin: 'https://other-origin.example.invalid/',
        }),
      }),
    },
    {
      label: 'expired attestation',
      input: safeToolRiskInput(),
      clock: () => new Date('2030-01-01T00:31:00.000Z'),
    },
    {
      label: 'attestation at its exclusive expiry boundary',
      input: safeToolRiskInput(),
      clock: () => new Date(ATTESTATION_EXPIRES_AT),
    },
    {
      label: 'server outside trusted_server_refs',
      input: safeToolRiskInput({
        owner_policy: trustedOwnerPolicy({
          trusted_server_refs: ['server:somewhere-else'],
        }),
      }),
    },
  ];

  for (const { label, input, clock = trustClock } of invalidCases) {
    await t.test(label, () => {
      assertRiskForkRequired(classifyRisk(input, {
        trusted_server_verifier: trustedServerVerifier,
        clock,
      }), label);
    });
  }

  await t.test('an exact valid trusted attestation can lower a closed read-only call', () => {
    const decision = classifyRisk(safeToolRiskInput(), {
      trusted_server_verifier: trustedServerVerifier,
      clock: trustClock,
    });

    assert.equal(decision.level, 'LOW');
    assert.equal(decision.action, 'NORMAL_EXECUTION');
    assert.equal(decision.isolation_boundary, 'none');
    assert.equal(decision.normalized_input.evaluated_at, EVALUATED_AT);
    assert.equal(
      decision.normalized_input.mcp_server_attestation.attestation_hash,
      trustedServerAttestation().attestation_hash,
    );
  });
});

test('serializable policy and self-created attestation cannot lower trust without a clean verifier', () => {
  assertRiskForkRequired(
    classifyRisk(safeToolRiskInput(), { clock: trustClock }),
    'serialized trust inputs must not prove their own provenance',
  );

  const decision = classifyRisk(safeToolRiskInput(), {
    trusted_server_verifier: trustedServerVerifier,
    clock: trustClock,
  });
  assert.equal(decision.level, 'LOW');
  assert.equal(decision.classifier.trusted_server_verification.status, 'verified');
});

test('serialized input cannot backdate an expired attestation into a trusted LOW decision', () => {
  const expiredAttestation = trustedServerAttestation({
    issued_at: '2029-01-01T00:00:00.000Z',
    expires_at: '2029-01-01T01:00:00.000Z',
  });
  const backdatedInput = safeToolRiskInput({
    evaluated_at: '2029-01-01T00:30:00.000Z',
    mcp_server_attestation: expiredAttestation,
    owner_policy: trustedOwnerPolicy({
      trusted_attestation_hashes: [expiredAttestation.attestation_hash],
    }),
  });

  assert.throws(
    () => classifyRisk(backdatedInput, {
      trusted_server_verifier: trustedServerVerifier,
    }),
    /unsupported fields: evaluated_at|evaluated_at.*unsupported/i,
  );
});

test('a serialized LOW decision cannot reuse recorded trust verification as provenance', () => {
  const decision = classifyRisk(safeToolRiskInput(), {
    trusted_server_verifier: trustedServerVerifier,
    clock: trustClock,
  });
  const serializedDecision = JSON.parse(JSON.stringify(decision));

  assert.equal(serializedDecision.level, 'LOW');
  assert.equal(
    serializedDecision.classifier.trusted_server_verification.status,
    'verified',
  );
  assert.throws(
    () => verifyRiskDecision(serializedDecision),
    /deterministic closed contract|trust provenance/i,
  );
  assert.throws(
    () => verifyRiskDecision(serializedDecision, {
      trusted_server_verifier: JSON.parse(JSON.stringify(trustedServerVerifier)),
    }),
    /deterministic closed contract|trust provenance/i,
  );
  assert.equal(
    verifyRiskDecision(serializedDecision, {
      trusted_server_verifier: trustedServerVerifier,
    }),
    true,
  );
});

test('server/discover is represented and classified before the relay accepts remote content', async () => {
  const events = [];
  let remoteRequests = 0;
  const boundary = new RiskForkMcpBoundary({
    hostCapabilities: {
      can_block_before_remote_connect: true,
      can_route_complete_remote_session: true,
    },
    controller: {
      async prepare(input) {
        events.push('risk_fork_prepared');
        assert.equal(input.risk_input.mcp_phase, 'server/discover');
        assert.equal(remoteRequests, 0, 'the remote transport must not run before preparation');
        return { prepared_ref: 'prepared:server-discover' };
      },
    },
  });

  const riskInput = {
    request_id: 'request:server-discover',
    mcp_phase: 'server/discover',
    mcp_server_ref: 'server:loopback-relay',
    mcp_server_origin: 'https://loopback-relay.example.invalid/',
    mcp_server_trust: 'unknown',
    tool_annotations: { ...SAFE_ANNOTATIONS },
    capabilities: { ...SAFE_CAPABILITIES },
  };

  // This is the bounded host-side ordering exercised by the real relay's first
  // MCP 2026-07-28 method: preflight first, then connect and accept content.
  const routed = await boundary.route({
    risk_input: riskInput,
    prepare_input: { relay_phase: 'pre_connect' },
  });
  events.push('interception_plan_ready');
  assert.equal(remoteRequests, 0);
  assert.equal(routed.plan.risk_decision.level, 'HIGH');
  assert.equal(routed.plan.enforcement_point, 'before_remote_connect');
  assert.equal(routed.plan.directive, 'BLOCK_DIRECT_ROUTE_TO_RISK_FORK');
  assert.equal(routed.plan.authority_flags.remote_connection_started, false);

  remoteRequests += 1;
  events.push('remote_server_discover_sent');
  const remoteContent = { protocolVersion: '2026-07-28', instructions: 'untrusted' };
  events.push('remote_content_accepted');

  assert.equal(remoteContent.protocolVersion, '2026-07-28');
  assert.deepEqual(events, [
    'risk_fork_prepared',
    'interception_plan_ready',
    'remote_server_discover_sent',
    'remote_content_accepted',
  ]);
});

test('an unknown future MCP method is represented without parsing its content and fails HIGH', () => {
  const plan = createMcpInterceptionPlan({
    risk_input: {
      request_id: 'request:unknown-future-method',
      mcp_phase: 'UNKNOWN',
      raw_method: 'experimental/future-method-v9',
      mcp_server_ref: 'server:future-method',
      mcp_server_origin: 'https://future-method.example.invalid/',
      mcp_server_trust: 'verified',
      tool_annotations: { ...SAFE_ANNOTATIONS },
      capabilities: { ...SAFE_CAPABILITIES },
      owner_policy: { trusted_server_refs: ['server:future-method'] },
    },
  });

  assertRiskForkRequired(plan.risk_decision, 'unknown methods must fail high');
  assert.equal(plan.risk_decision.normalized_input.mcp_phase, 'UNKNOWN');
  assert.equal(
    plan.risk_decision.normalized_input.raw_method,
    'experimental/future-method-v9',
  );
  assert.equal(plan.enforcement_point, 'before_remote_connect');
  assert.equal(plan.directive, 'BLOCK_DIRECT_ROUTE_TO_RISK_FORK');
  assert.equal(plan.authority_flags.remote_connection_started, false);
});

function evidenceClaim(name, overrides = {}) {
  return {
    status: 'verified',
    outcome: 'success',
    evidence_ref: `evidence:${name}`,
    evidence_hash: hash(name),
    ...overrides,
  };
}

function receiptFixture({
  destructionRef = 'cleanup:verified',
  destructionHash = hash('cleanup'),
  capsule: suppliedCapsule = null,
  riskDecision = null,
} = {}) {
  const resultSchema = closedResultSchema();
  const capsule = suppliedCapsule ?? makeCapsule();
  const forkRef = 'fork:mcp-receipt-remediation';
  const providerRef = 'provider:receipt-remediation';
  const artifact = validateCommitCandidate({
    candidate: {
      type: 'TYPED_RESULT',
      payload: { answer: 'bounded' },
      payload_schema: resultSchema,
    },
    source_fork_id: forkRef,
    policy: { typed_result_schema_hash: hash(resultSchema) },
    validated_at: NOW,
  });
  const lifecycle = makePreparedLifecycle(artifact.artifact_hash);
  const destructionClaim = evidenceClaim('destruction', {
    evidence_ref: destructionRef,
    evidence_hash: destructionHash,
  });

  return {
    created_at: NOW,
    capsule,
    risk_decision: riskDecision ?? classifyRisk({
      mcp_phase: capsule.proposed_interaction.mcp_method,
      mcp_server_ref: capsule.proposed_interaction.mcp_server_ref,
      mcp_server_origin: capsule.proposed_interaction.mcp_server_origin,
      mcp_server_trust: 'unknown',
      tool_name: capsule.proposed_interaction.tool_name,
    }),
    lifecycle,
    fork_identity: makeForkIdentity(capsule),
    fork_ref: forkRef,
    provider_ref: providerRef,
    provider_capabilities_hash: hash('provider-capabilities'),
    savepoint_claim: evidenceClaim('savepoint'),
    fork_start_claim: evidenceClaim('fork-start'),
    execution_claim: evidenceClaim('execution'),
    result_digest: lifecycle.events.find((event) => event.to === 'TAINTED').evidence.hash,
    commit_artifact: artifact,
    accepted_commit_digest: null,
    validation_evidence_refs: ['validation:taint-gate'],
    credential_revocation_claim: {
      status: 'not_applicable',
      outcome: 'not_applicable',
      evidence_ref: null,
      evidence_hash: null,
    },
    destruction_claim: destructionClaim,
    destruction_evidence: {
      status: 'verified',
      provider_ref: providerRef,
      fork_ref: forkRef,
      evidence_ref: destructionClaim.evidence_ref,
      evidence_hash: destructionClaim.evidence_hash,
    },
    transaction_assurance_evidence_refs: [],
    measurements: {},
  };
}

function rehashReceipt(receipt) {
  const copy = structuredClone(receipt);
  copy.receipt_hash = null;
  copy.receipt_hash = sha256Ref({ ...copy, receipt_hash: null });
  return copy;
}

test('authoritative receipt verification requires the exact full risk decision', () => {
  const input = receiptFixture();
  const receipt = createRiskForkReceipt(input);
  const substituted = structuredClone(receipt);
  substituted.risk.level = 'ELEVATED';
  substituted.risk.action = 'RISK_FORK_OPTIONAL';
  substituted.risk.decision_hash = hash('attacker-substituted-risk-decision');
  const rehashed = rehashReceipt(substituted);

  assert.equal(verifyRiskForkReceiptStructure(receipt), true);
  assert.equal(
    verifyRiskForkReceiptStructure(rehashed),
    true,
    'structure-only validation deliberately cannot establish risk-decision provenance',
  );
  assert.throws(
    () => verifyRiskForkReceipt(receipt),
    /exact full risk decision|risk_decision.*required/i,
  );
  assert.throws(
    () => verifyRiskForkReceipt(rehashed),
    /exact full risk decision|risk_decision.*required/i,
  );
  assert.equal(verifyRiskForkReceipt(receipt, {
    risk_decision: input.risk_decision,
  }), true);
  assert.throws(
    () => verifyRiskForkReceipt(rehashed, {
      risk_decision: input.risk_decision,
    }),
    /exact verified risk decision|risk summary/i,
  );
});

test('receipt APIs keep trusted decision provenance out of band and exact-bound', async (t) => {
  const capsule = makeCapsule({
    proposed_interaction: {
      mcp_server_ref: SERVER_REF,
      mcp_server_origin: SERVER_ORIGIN,
      tool_name: 'read_only_probe',
    },
  });
  const cases = [
    {
      level: 'HIGH',
      capabilities: { ...SAFE_CAPABILITIES, filesystem_write: true },
    },
    {
      level: 'IRREVERSIBLE',
      capabilities: { ...SAFE_CAPABILITIES, wallet_or_payment: true },
    },
  ];

  for (const { level, capabilities } of cases) {
    await t.test(`${level} requires the original trusted verifier boundary`, () => {
      const decision = classifyRisk(safeToolRiskInput({ capabilities }), {
        trusted_server_verifier: trustedServerVerifier,
        clock: trustClock,
      });
      const input = receiptFixture({ capsule, riskDecision: decision });

      assert.equal(decision.level, level);
      assert.equal(decision.classifier.trusted_server_verification.status, 'verified');
      assert.throws(
        () => createRiskForkReceipt(input),
        /deterministic closed contract|trust provenance/i,
      );
      assert.throws(
        () => createRiskForkReceipt(input, {
          trusted_server_verifier: JSON.parse(JSON.stringify(trustedServerVerifier)),
        }),
        /deterministic closed contract|trust provenance/i,
      );

      const receipt = createRiskForkReceipt(input, {
        trusted_server_verifier: trustedServerVerifier,
      });
      assert.equal(receipt.risk.level, level);
      assert.equal(verifyRiskForkReceiptStructure(receipt), true);
      assert.throws(
        () => verifyRiskForkReceipt(receipt),
        /exact full risk decision|risk_decision.*required/i,
      );
      assert.throws(
        () => verifyRiskForkReceipt(receipt, { risk_decision: decision }),
        /original live trusted_server_verifier|trusted-server verification requires/i,
      );
      assert.throws(
        () => verifyRiskForkReceipt(receipt, {
          trusted_server_verifier: trustedServerVerifier,
        }),
        /exact full risk decision|risk_decision.*required/i,
      );
      assert.throws(
        () => verifyRiskForkReceipt(receipt, {
          risk_decision: decision,
          trusted_server_verifier: JSON.parse(JSON.stringify(trustedServerVerifier)),
        }),
        /deterministic closed contract|trust provenance/i,
      );
      assert.equal(verifyRiskForkReceipt(receipt, {
        risk_decision: decision,
        trusted_server_verifier: trustedServerVerifier,
      }), true);

      const substitutedDecisionHash = structuredClone(receipt);
      substitutedDecisionHash.risk.decision_hash = hash(`substituted-${level}`);
      const rehashed = rehashReceipt(substitutedDecisionHash);
      assert.equal(verifyRiskForkReceiptStructure(rehashed), true);
      assert.throws(
        () => verifyRiskForkReceipt(rehashed, {
          risk_decision: decision,
          trusted_server_verifier: trustedServerVerifier,
        }),
        /exact verified risk decision|risk summary/i,
      );
    });
  }

  const untrustedHighInput = receiptFixture();
  const untrustedHighReceipt = createRiskForkReceipt(untrustedHighInput);
  assert.equal(untrustedHighReceipt.risk.level, 'HIGH');
  assert.equal(verifyRiskForkReceiptStructure(untrustedHighReceipt), true);
  assert.equal(verifyRiskForkReceipt(untrustedHighReceipt, {
    risk_decision: untrustedHighInput.risk_decision,
  }), true);
});

function acceptedDigestBeforeCommitReceipt() {
  const receipt = createRiskForkReceipt(receiptFixture());
  assert.equal(receipt.lifecycle.state, 'CLEAN_COMMIT_READY');
  assert.equal(receipt.timestamps.committed_at, null);
  assert.equal(receipt.commit.accepted_digest, null);
  const contradictory = structuredClone(receipt);
  contradictory.commit.accepted_digest = hash('accepted-before-committed');
  return rehashReceipt(contradictory);
}

test('receipt verifier rejects a correctly rehashed accepted digest before COMMITTED', () => {
  assert.throws(
    () => verifyRiskForkReceiptStructure(acceptedDigestBeforeCommitReceipt()),
    /accepted.*digest|COMMITTED|pre-commit/i,
  );
});

test('receipt schema rejects an accepted digest before COMMITTED', async () => {
  const schemaPath = fileURLToPath(new URL('../schema/receipt.v1.json', import.meta.url));
  const schema = JSON.parse(await readFile(schemaPath, 'utf8'));
  const ajv = new Ajv2020({ allErrors: true, strict: true });
  addFormats(ajv);
  const validate = ajv.compile(schema);

  assert.equal(
    validate(acceptedDigestBeforeCommitReceipt()),
    false,
    `receipt schema admitted a pre-commit accepted digest: ${ajv.errorsText(validate.errors)}`,
  );
});

test('destruction claim ref and hash must exactly match the verified lifecycle event', async (t) => {
  await t.test('construction rejects independently rehashed mismatched evidence', () => {
    assert.throws(
      () => createRiskForkReceipt(receiptFixture({
        destructionRef: 'destruction:unrelated-proof',
        destructionHash: hash('unrelated-destruction-proof'),
      })),
      /destruction.*(?:lifecycle|event|exact)|lifecycle.*destruction/i,
    );
  });

  await t.test('standalone verification rejects a rehashed destruction-claim substitution', () => {
    const receipt = createRiskForkReceipt(receiptFixture());
    const substituted = structuredClone(receipt);
    substituted.claims.destruction.evidence_ref = 'destruction:substituted-proof';
    substituted.claims.destruction.evidence_hash = hash('substituted-destruction-proof');

    assert.throws(
      () => verifyRiskForkReceiptStructure(rehashReceipt(substituted)),
      /destruction.*(?:lifecycle|event|exact)|lifecycle.*destruction/i,
    );
  });
});

function contradictoryDestructionReceipt({ activeResource = false } = {}) {
  const receipt = structuredClone(createRiskForkReceipt(receiptFixture()));
  receipt.claims.destruction.status = 'observed';
  if (activeResource) {
    receipt.lifecycle.fork_resource_state = 'ACTIVE';
    receipt.timestamps.destruction_requested_at = null;
    receipt.timestamps.destruction_verified_at = null;
  }
  return rehashReceipt(receipt);
}

test('receipt runtime enforces lifecycle/resource/destruction evidence in both directions', () => {
  assert.throws(
    () => verifyRiskForkReceiptStructure(contradictoryDestructionReceipt({
      activeResource: true,
    })),
    /destruction|resource|lifecycle/i,
  );
  assert.throws(
    () => verifyRiskForkReceiptStructure(contradictoryDestructionReceipt()),
    /destruction|resource|lifecycle/i,
  );
});

test('receipt schema enforces lifecycle/resource/destruction evidence in both directions', async () => {
  const schemaPath = fileURLToPath(new URL('../schema/receipt.v1.json', import.meta.url));
  const schema = JSON.parse(await readFile(schemaPath, 'utf8'));
  const ajv = new Ajv2020({ allErrors: true, strict: true });
  addFormats(ajv);
  const validate = ajv.compile(schema);

  for (const receipt of [
    contradictoryDestructionReceipt({ activeResource: true }),
    contradictoryDestructionReceipt(),
  ]) {
    assert.equal(
      validate(receipt),
      false,
      `receipt schema admitted contradictory destruction state: ${ajv.errorsText(validate.errors)}`,
    );
  }
});
