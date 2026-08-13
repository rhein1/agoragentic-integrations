import assert from 'node:assert/strict';
import { mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  LocalReferenceRiskForkAdapter,
  inspectLocalWorkspace,
} from '../src/adapters/local-reference.mjs';
import { canonicalize, sha256Ref } from '../src/canonical.mjs';
import {
  buildExecutionBinding,
  createForkIdentity,
  createSavepointCapsule,
  verifySavepointCapsule,
} from '../src/contracts.mjs';
import {
  createLifecycle,
  recordResourceState,
  transitionLifecycle,
  verifyLifecycle,
} from '../src/lifecycle.mjs';
import {
  createRiskForkReceipt,
  verifyRiskForkReceiptStructure,
} from '../src/receipt.mjs';
import {
  classifyRisk,
  createTrustedMcpServerVerifier,
  riskDecisionCanonicalBytes,
} from '../src/risk-classifier.mjs';
import { validateCommitCandidate } from '../src/taint-gate.mjs';

const NOW = new Date('2030-01-01T00:00:00.000Z');
const LATER = '2030-01-01T01:00:00.000Z';
const TRUST_EVALUATED_AT = new Date('2030-01-01T00:10:00.000Z');

function hash(value) {
  return sha256Ref(value);
}

const trustedServerVerifier = createTrustedMcpServerVerifier((request) => ({
  schema: 'agoragentic.risk-fork.trusted-mcp-server-verification.v1',
  status: 'verified',
  request_hash: hash(request),
  evidence_ref: 'trusted-boundary:core-classifier-tests',
  evidence_hash: hash({ request, verifier: 'core-classifier-tests' }),
}));

function exactTrustedServerInput(serverRef, serverOrigin) {
  const trustRegistryVersion = 'core-test-trust-registry-v1';
  const attestorRef = 'attestor:core-tests';
  const statement = {
    schema: 'agoragentic.risk-fork.mcp-server-attestation.v1',
    status: 'verified',
    server_ref: serverRef,
    server_origin: serverOrigin,
    attestor_ref: attestorRef,
    evidence_hash: hash('core-test-trust-evidence'),
    issued_at: '2030-01-01T00:00:00.000Z',
    expires_at: '2030-01-01T01:00:00.000Z',
    trust_registry_version: trustRegistryVersion,
    signature_ref: 'signature:core-test-trust',
    signature_hash: hash('core-test-trust-signature'),
  };
  const attestation = {
    ...statement,
    attestation_hash: hash(statement),
  };
  return {
    mcp_server_attestation: attestation,
    owner_policy: {
      trusted_server_refs: [serverRef],
      trusted_attestor_refs: [attestorRef],
      trusted_attestation_hashes: [attestation.attestation_hash],
      trust_registry_version: trustRegistryVersion,
    },
  };
}

function makeCapsule(overrides = {}) {
  const parent = {
    agent_id: 'parent-agent',
    session_id: 'parent-session',
    state_hash: hash('parent-state'),
    lineage_ref: 'lineage:1',
    lineage_hash: hash('lineage'),
    ...overrides.parent,
  };
  return createSavepointCapsule({
    capsule_id: overrides.capsule_id,
    created_at: overrides.created_at ?? NOW,
    expires_at: overrides.expires_at ?? LATER,
    parent,
    agent_configuration: {
      model_version_hash: hash('model'),
      system_instruction_hash: hash('system'),
      tool_manifest_hash: hash('tools'),
    },
    checkpoint: {
      goal_ref: 'goal:1',
      goal_hash: hash('goal'),
      task_graph_ref: 'task-graph:1',
      task_graph_hash: hash('task-graph'),
    },
    memory_roots: overrides.memory_roots ?? [],
    workspace: {
      snapshot_ref: 'workspace:1',
      digest: hash('workspace'),
      ...overrides.workspace,
    },
    governance: {
      policy_version: 'policy-v1',
      policy_hash: hash('policy'),
      mandate_version: 'mandate-v1',
      mandate_hash: hash('mandate'),
      budget_version: 'budget-v1',
      budget_hash: hash('budget'),
    },
    receipt_chain_head: hash('receipt-chain'),
    proposed_interaction: {
      mcp_server_ref: 'mcp-server:1',
      mcp_server_origin: 'https://mcp.example.invalid/',
      mcp_method: 'tools/call',
      tool_name: 'example_tool',
      effective_arguments_hash: hash({ value: 1 }),
      target_ref: 'target:1',
    },
    allowed_commit_types: overrides.allowed_commit_types ?? ['TYPED_RESULT'],
    authorized_result_schema_hash: hash({
      type: 'object',
      additionalProperties: false,
    }),
    runtime_snapshot: overrides.runtime_snapshot ?? { mode: 'none' },
  });
}

function makeReceipt() {
  const capsule = makeCapsule();
  const forkRef = 'fork:receipt-verifier';
  const providerRef = 'provider:1';
  const destructionClaim = {
    status: 'verified',
    outcome: 'success',
    evidence_ref: 'destruction:receipt-verifier',
    evidence_hash: hash('destruction:receipt-verifier'),
  };
  const destructionEvidence = {
    status: 'verified',
    provider_ref: providerRef,
    fork_ref: forkRef,
    evidence_ref: destructionClaim.evidence_ref,
    evidence_hash: destructionClaim.evidence_hash,
  };
  const forkIdentity = createForkIdentity({
    parent_agent_id: capsule.parent.agent_id,
    parent_session_id: capsule.parent.session_id,
    issued_at: NOW,
  });
  const resultSchema = {
    type: 'object',
    additionalProperties: false,
  };
  const artifact = validateCommitCandidate({
    candidate: {
      type: 'TYPED_RESULT',
      payload: {},
      payload_schema: resultSchema,
    },
    source_fork_id: forkRef,
    policy: { typed_result_schema_hash: capsule.authorized_result_schema_hash },
    validated_at: NOW,
  });
  let lifecycle = reachCommitReady(artifact.artifact_hash);
  lifecycle = next(lifecycle, 'PRECOMMIT_DESTROYING', {
    resource: 'DESTROY_REQUESTED',
  });
  lifecycle = next(lifecycle, 'CLEAN_COMMIT_READY', {
    resource: 'DESTROYED',
    evidence: {
      status: 'verified',
      ref: destructionClaim.evidence_ref,
      hash: destructionClaim.evidence_hash,
    },
  });
  const taintedResultDigest = lifecycle.events.find((event) => event.to === 'TAINTED').evidence.hash;
  const evidence = (name) => ({
    status: 'verified',
    outcome: 'success',
    evidence_ref: `evidence:${name}`,
    evidence_hash: hash(name),
  });
  return createRiskForkReceipt({
    created_at: lifecycle.events.at(-1).at,
    capsule,
    risk_decision: classifyRisk({
      mcp_phase: 'tools/call',
      mcp_server_ref: capsule.proposed_interaction.mcp_server_ref,
      mcp_server_origin: capsule.proposed_interaction.mcp_server_origin,
      mcp_server_trust: 'unknown',
      tool_name: capsule.proposed_interaction.tool_name,
    }),
    lifecycle,
    fork_identity: forkIdentity,
    fork_ref: forkRef,
    provider_ref: providerRef,
    provider_capabilities_hash: hash('provider-capabilities'),
    savepoint_claim: evidence('savepoint'),
    fork_start_claim: evidence('fork-start'),
    execution_claim: evidence('execution'),
    result_digest: taintedResultDigest,
    commit_artifact: artifact,
    accepted_commit_digest: null,
    validation_evidence_refs: [],
    credential_revocation_claim: {
      status: 'not_applicable',
      outcome: 'not_applicable',
    },
    destruction_claim: destructionClaim,
    destruction_evidence: destructionEvidence,
    transaction_assurance_evidence_refs: [],
    measurements: {},
  });
}

function clone(value) {
  return structuredClone(value);
}

function createTestLifecycle() {
  return createLifecycle({
    run_id: 'run:core-test',
    requested_at: NOW,
    actor: 'clean_controller',
    reason: 'risk_fork_requested',
    evidence: {
      status: 'observed',
      ref: 'event:requested',
      hash: hash('requested'),
    },
  });
}

function next(lifecycle, to, options = {}) {
  return transitionLifecycle(lifecycle, {
    actor: 'clean_controller',
    expected_version: lifecycle.version,
    expected_chain_head: lifecycle.chain_head,
    to,
    at: options.at ?? new Date(NOW.getTime() + (lifecycle.version + 1) * 1000),
    reason: options.reason ?? `transition_to_${to.toLowerCase()}`,
    evidence: options.evidence ?? {
      status: 'observed',
      ref: `event:${to.toLowerCase()}`,
      hash: hash(`${to}:${lifecycle.version + 1}`),
    },
    ...(options.resource ? { fork_resource_state: options.resource } : {}),
  });
}

function reachCommitReady(artifactHash = hash('validated-artifact')) {
  let lifecycle = createTestLifecycle();
  lifecycle = next(lifecycle, 'SAVEPOINTING');
  lifecycle = next(lifecycle, 'SAVEPOINT_READY');
  lifecycle = next(lifecycle, 'FORK_STARTING');
  lifecycle = next(lifecycle, 'FORK_READY', { resource: 'ACTIVE' });
  lifecycle = next(lifecycle, 'EXECUTING');
  lifecycle = next(lifecycle, 'TAINTED');
  lifecycle = next(lifecycle, 'VALIDATING');
  lifecycle = next(lifecycle, 'COMMIT_READY', {
    evidence: {
      status: 'verified',
      ref: 'artifact:validated',
      hash: artifactHash,
    },
  });
  return lifecycle;
}

test('canonical JSON is deterministic for semantically identical key orderings', () => {
  const left = { z: 1, a: { d: 4, c: 3 }, list: [{ y: 2, x: 1 }] };
  const right = { list: [{ x: 1, y: 2 }], a: { c: 3, d: 4 }, z: 1 };

  assert.equal(
    canonicalize(left),
    '{"a":{"c":3,"d":4},"list":[{"x":1,"y":2}],"z":1}',
  );
  assert.equal(canonicalize(left), canonicalize(right));
  assert.equal(sha256Ref(left), sha256Ref(right));
});

test('canonical JSON rejects values that JSON would omit, coerce, or ambiguously encode', () => {
  const sparse = [];
  sparse.length = 1;
  const extraArrayField = [];
  extraArrayField.extra = true;
  const hidden = {};
  Object.defineProperty(hidden, 'secret', { value: 'hidden', enumerable: false });
  const accessor = {};
  Object.defineProperty(accessor, 'value', { enumerable: true, get: () => 1 });
  const symbolKey = { visible: true };
  symbolKey[Symbol('hidden')] = true;
  const cyclic = { safe: true };
  cyclic.self = cyclic;
  const tooDeep = {};
  let cursor = tooDeep;
  for (let depth = 0; depth < 66; depth += 1) {
    cursor.child = {};
    cursor = cursor.child;
  }

  for (const value of [
    undefined,
    { omitted: undefined },
    { callable: () => true },
    { bigint: 1n },
    { number: Number.NaN },
    { number: Number.POSITIVE_INFINITY },
    { number: -0 },
    { number: Number.MAX_SAFE_INTEGER + 1 },
    sparse,
    extraArrayField,
    hidden,
    accessor,
    symbolKey,
    new Date('2030-01-01T00:00:00.000Z'),
    cyclic,
    tooDeep,
  ]) {
    assert.throws(() => canonicalize(value), TypeError);
    assert.throws(() => sha256Ref(value), TypeError);
  }
});

test('taint gate rejects accessor candidates without invoking child code', () => {
  let getterCalls = 0;
  const candidate = {};
  Object.defineProperty(candidate, 'type', {
    enumerable: true,
    get() {
      getterCalls += 1;
      return 'TYPED_RESULT';
    },
  });

  assert.throws(
    () => validateCommitCandidate({
      candidate,
      source_fork_id: 'fork:accessor-attack',
      validated_at: NOW,
    }),
    /accessor/,
  );
  assert.equal(getterCalls, 0);
});

test('Savepoint Capsule verifies canonical integrity, parent bindings, and validity window', () => {
  const capsule = makeCapsule();
  const expected = {
    now: NOW,
    expectedParentAgentId: 'parent-agent',
    expectedParentSessionId: 'parent-session',
    expectedParentStateHash: hash('parent-state'),
    expectedLineageHash: hash('lineage'),
  };

  assert.equal(verifySavepointCapsule(capsule, expected), true);

  const tampered = clone(capsule);
  tampered.parent.state_hash = hash('different-parent-state');
  assert.throws(
    () => verifySavepointCapsule(tampered, expected),
    /hash mismatch/,
  );

  assert.throws(
    () => verifySavepointCapsule(capsule, { ...expected, expectedParentAgentId: 'other-agent' }),
    /parent agent mismatch/,
  );
  assert.throws(
    () => verifySavepointCapsule(capsule, { ...expected, expectedParentSessionId: 'other-session' }),
    /parent session mismatch/,
  );
  assert.throws(
    () => verifySavepointCapsule(capsule, { ...expected, expectedParentStateHash: hash('other') }),
    /parent state mismatch/,
  );
  assert.throws(
    () => verifySavepointCapsule(capsule, { ...expected, expectedLineageHash: hash('other') }),
    /lineage mismatch/,
  );

  assert.throws(
    () => verifySavepointCapsule(capsule, { ...expected, now: LATER }),
    /stale/,
  );
  assert.equal(
    verifySavepointCapsule(capsule, { ...expected, now: LATER, allowExpired: true }),
    true,
  );
  assert.throws(
    () => verifySavepointCapsule(capsule, {
      ...expected,
      now: '2029-12-31T23:59:59.999Z',
    }),
    /not yet valid/,
  );
});

test('Savepoint Capsule creation rejects malformed boundaries and unverifiable runtime snapshots', () => {
  assert.throws(
    () => makeCapsule({
      parent: { state_hash: 'not-a-sha256-reference' },
    }),
    /parent\.state_hash/,
  );
  assert.throws(
    () => makeCapsule({
      runtime_snapshot: {
        mode: 'filesystem',
        provider_ref: 'provider:1',
        snapshot_ref: 'snapshot:1',
        snapshot_hash: hash('snapshot'),
        verification_status: 'verified',
      },
    }),
    /sanitization attestation/,
  );
  assert.throws(
    () => makeCapsule({
      runtime_snapshot: {
        mode: 'none',
        provider_ref: 'provider:1',
      },
    }),
    /mode none/,
  );
});

test('Savepoint Capsule v1 rejects verified filesystem-and-memory runtime snapshots', () => {
  assert.throws(
    () => makeCapsule({
      runtime_snapshot: {
        mode: 'filesystem_and_memory',
        provider_ref: 'provider:memory-snapshot',
        snapshot_ref: 'snapshot:memory-bearing',
        snapshot_hash: hash('memory-bearing-snapshot'),
        sanitization_attestation_ref: 'attestation:memory-snapshot',
        sanitization_attestation_hash: hash('memory-snapshot-attestation'),
        verification_status: 'verified',
      },
    }),
    /runtime_snapshot\.mode|filesystem_and_memory|snapshot mode/i,
  );
});

test('Savepoint Capsule verification rejects noncanonical hidden fields', () => {
  const capsule = clone(makeCapsule());
  Object.defineProperty(capsule, 'unbound_hidden_value', {
    value: 'must-not-be-ignored',
    enumerable: false,
  });

  assert.throws(
    () => verifySavepointCapsule(capsule, { now: NOW }),
    /hidden|unsupported|canonical/i,
  );
});

test('Savepoint Capsule identifier is integrity-bound', () => {
  const capsule = clone(makeCapsule());
  capsule.capsule_id = 'rfc_substituted_identifier';

  assert.throws(
    () => verifySavepointCapsule(capsule, { now: NOW }),
    /hash mismatch|canonical contract/i,
  );
});

test('risk classification is deterministic across input property ordering', () => {
  const left = classifyRisk({
    request_id: 'request:1',
    mcp_phase: 'tools/call',
    mcp_server_ref: 'server:1',
    mcp_server_origin: 'https://mcp.example.invalid/',
    mcp_server_trust: 'verified',
    tool_name: 'read_data',
    tool_annotations: {
      openWorldHint: false,
      readOnlyHint: true,
      idempotentHint: true,
    },
    capabilities: {
      filesystem_read: true,
      network_access: true,
    },
  }, { clock: () => NOW });
  const right = classifyRisk({
    capabilities: {
      network_access: true,
      filesystem_read: true,
    },
    tool_annotations: {
      idempotentHint: true,
      readOnlyHint: true,
      openWorldHint: false,
    },
    tool_name: 'read_data',
    mcp_server_trust: 'verified',
    mcp_server_origin: 'https://mcp.example.invalid/',
    mcp_server_ref: 'server:1',
    mcp_phase: 'tools/call',
    request_id: 'request:1',
  }, { clock: () => NOW });

  assert.equal(left.level, 'HIGH');
  assert.equal(left.decision_hash, right.decision_hash);
  assert.equal(riskDecisionCanonicalBytes(left), riskDecisionCanonicalBytes(right));
});

test('unknown or untrusted MCP initialization and discovery are HIGH before remote connect', () => {
  const phases = [
    'initialize',
    'tools/list',
    'resources/list',
    'resources/read',
    'prompts/list',
    'prompts/get',
  ];
  for (const trust of ['unknown', 'untrusted', 'failed']) {
    for (const phase of phases) {
      const decision = classifyRisk({
        mcp_phase: phase,
        mcp_server_trust: trust,
        tool_annotations: { openWorldHint: false },
      });
      assert.equal(decision.level, 'HIGH', `${trust} ${phase}`);
      assert.equal(decision.action, 'RISK_FORK_REQUIRED', `${trust} ${phase}`);
      assert.equal(decision.isolation_boundary, 'before_remote_connect', `${trust} ${phase}`);
      assert.ok(
        decision.reasons.some((item) => item.code === 'instruction_bearing_pre_call_content'),
        `${trust} ${phase}`,
      );
    }
  }
});

test('read-only and idempotent hints cannot lower capability or owner-policy risk', () => {
  const annotations = {
    readOnlyHint: true,
    idempotentHint: true,
    openWorldHint: false,
  };
  const write = classifyRisk({
    mcp_phase: 'tools/call',
    mcp_server_trust: 'verified',
    tool_annotations: annotations,
    capabilities: { filesystem_write: true },
  });
  const spend = classifyRisk({
    mcp_phase: 'tools/call',
    mcp_server_trust: 'verified',
    tool_annotations: annotations,
    capabilities: { wallet_or_payment: true },
  });
  const ownerMinimum = classifyRisk({
    mcp_phase: 'tools/call',
    mcp_server_trust: 'verified',
    tool_annotations: annotations,
    owner_policy: { minimum_level: 'HIGH' },
  });

  assert.equal(write.level, 'HIGH');
  assert.equal(spend.level, 'IRREVERSIBLE');
  assert.equal(spend.action, 'RISK_FORK_PREPARE_CLEAN_COMMIT_REQUIRED');
  assert.equal(ownerMinimum.level, 'HIGH');
});

test('destructive hints remain irreversible and owner denial fails closed', () => {
  const decision = classifyRisk({
    mcp_phase: 'tools/call',
    mcp_server_trust: 'verified',
    tool_annotations: {
      readOnlyHint: true,
      idempotentHint: true,
      destructiveHint: true,
      openWorldHint: false,
    },
    owner_policy: { deny_irreversible: true },
  });

  assert.equal(decision.level, 'IRREVERSIBLE');
  assert.equal(decision.blocked, true);
  assert.equal(decision.action, 'DENY');
});

test('risk classifier rejects unknown fields and trust-state spoofing', () => {
  assert.throws(
    () => classifyRisk({ capabilities: { unexpected_capability: true } }),
    /unsupported fields/,
  );
  assert.throws(
    () => classifyRisk({ mcp_server_trust: 'Verified' }),
    /mcp_server_trust/,
  );
  assert.throws(
    () => classifyRisk({ tool_annotations: { read_only_hint: true } }),
    /unsupported fields/,
  );
});

test('absent or incomplete capability metadata defaults conservatively to HIGH', () => {
  const common = {
    mcp_phase: 'tools/call',
    mcp_server_ref: 'server:unclassified',
    mcp_server_origin: 'https://mcp.example.invalid/',
    mcp_server_trust: 'verified',
    tool_name: 'unclassified_tool',
    tool_annotations: { openWorldHint: false },
  };
  const incomplete = [
    ['absent capabilities', undefined],
    ['empty capabilities', {}],
    ['partial capabilities', { network_access: false }],
  ];

  for (const [label, capabilities] of incomplete) {
    const decision = classifyRisk({
      ...common,
      ...(capabilities === undefined ? {} : { capabilities }),
    });
    assert.equal(decision.level, 'HIGH', label);
    assert.equal(decision.action, 'RISK_FORK_REQUIRED', label);
    assert.equal(
      decision.normalized_input.capabilities.unknown_or_unclassified,
      true,
      label,
    );
  }

  const completeSafeCapabilities = {
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
  };
  assert.equal(
    classifyRisk({
      ...common,
      ...exactTrustedServerInput(common.mcp_server_ref, common.mcp_server_origin),
      capabilities: completeSafeCapabilities,
    }, {
      trusted_server_verifier: trustedServerVerifier,
      clock: () => TRUST_EVALUATED_AT,
    }).level,
    'LOW',
  );
});

test('receipt verification rejects rehashed secret-shaped claim detail', () => {
  const receipt = clone(makeReceipt());
  receipt.claims.execution.detail = 'sk-synthetic-not-a-real-secret-1234567890';
  receipt.receipt_hash = hash({ ...receipt, receipt_hash: null });

  assert.throws(
    () => verifyRiskForkReceiptStructure(receipt),
    /secret|privacy|canonical closed contract/i,
  );
});

test('receipt verification rejects a rehashed receipt missing the capsule hash', () => {
  const receipt = clone(makeReceipt());
  delete receipt.savepoint.capsule_hash;
  receipt.receipt_hash = hash({ ...receipt, receipt_hash: null });

  assert.throws(
    () => verifyRiskForkReceiptStructure(receipt),
    /capsule_hash|savepoint|canonical closed contract/i,
  );
});

test('a child action proposal stays authority-free while the clean side attaches its binding', () => {
  const capsule = makeCapsule({
    allowed_commit_types: ['CONSEQUENTIAL_ACTION_PROPOSAL'],
  });
  const forkIdentity = createForkIdentity({
    parent_agent_id: capsule.parent.agent_id,
    parent_session_id: capsule.parent.session_id,
    issued_at: NOW,
  });
  const binding = buildExecutionBinding({
    principal_ref: 'principal:1',
    action_operation: 'mcp_tool_call',
    fork_agent_id: forkIdentity.fork_agent_id,
    session_id: forkIdentity.session_id,
    mcp_server_ref: capsule.proposed_interaction.mcp_server_ref,
    mcp_server_origin: capsule.proposed_interaction.mcp_server_origin,
    mcp_method: capsule.proposed_interaction.mcp_method,
    tool_name: capsule.proposed_interaction.tool_name,
    effective_arguments: { value: 1 },
    provider_ref: 'provider:1',
    target_ref: capsule.proposed_interaction.target_ref,
    policy_ref: capsule.governance.policy_ref,
    policy_version: capsule.governance.policy_version,
    policy_hash: capsule.governance.policy_hash,
    mandate_ref: capsule.governance.mandate_ref,
    mandate_version: capsule.governance.mandate_version,
    mandate_hash: capsule.governance.mandate_hash,
    budget_policy_ref: capsule.governance.budget_policy_ref,
    budget_version: capsule.governance.budget_version,
    budget_hash: capsule.governance.budget_hash,
    governance_epoch: capsule.governance.epoch,
    issued_at: NOW,
    not_before: NOW,
    expires_at: LATER,
    nonce: 'nonce:1',
    one_use_authorization_id: 'authorization:1',
    audience: 'risk-fork-clean-controller',
    authorization_ref: 'authorization-ref:1',
    authorization_hash: hash('authorization-record'),
  });
  const childCandidate = {
    type: 'CONSEQUENTIAL_ACTION_PROPOSAL',
    action: {
      operation: 'mcp_tool_call',
      target_ref: capsule.proposed_interaction.target_ref,
      provider_ref: binding.provider_ref,
      arguments: { value: 1 },
      amount: null,
      currency: null,
      payment_rail: null,
    },
  };
  const childBytes = canonicalize(childCandidate);
  assert.doesNotMatch(childBytes, /authorization|execution_binding|signature|private_key/i);

  const artifact = validateCommitCandidate({
    candidate: childCandidate,
    source_fork_id: 'fork:authority-free-proposal',
    execution_binding: binding,
    validated_at: NOW,
  });

  assert.equal(canonicalize(childCandidate), childBytes);
  assert.deepEqual(artifact.body.execution_binding, binding);
  assert.equal(artifact.body.execution_binding_hash, binding.binding_hash);
  assert.equal(artifact.authority_flags.artifact_grants_authority, false);
  assert.equal(artifact.authority_flags.child_can_commit, false);
  assert.throws(
    () => validateCommitCandidate({
      candidate: { ...childCandidate, execution_binding: binding },
      source_fork_id: 'fork:authority-smuggling-attempt',
      execution_binding: binding,
      validated_at: NOW,
    }),
    /unsupported fields/,
  );
});

test('nonempty local sources require an external verifier and leave no copied .env', async () => {
  const sourceDirectory = await mkdtemp(path.join(os.tmpdir(), 'risk-fork-source-'));
  const adapterDirectory = await mkdtemp(path.join(os.tmpdir(), 'risk-fork-adapter-'));
  const adapter = new LocalReferenceRiskForkAdapter({
    baseDirectory: adapterDirectory,
    clock: () => NOW,
  });
  try {
    await writeFile(
      path.join(sourceDirectory, '.env'),
      'API_KEY=synthetic-not-a-real-secret-1234567890\n',
      'utf8',
    );
    const inspected = await inspectLocalWorkspace({ source_workspace: sourceDirectory });
    assert.deepEqual(inspected.files.map((item) => item.path), ['.env']);
    const capsule = makeCapsule({
      workspace: {
        snapshot_ref: 'workspace:synthetic-env',
        digest: inspected.workspace_digest,
      },
    });

    await assert.rejects(
      adapter.createSavepoint({
        capsule,
        source_workspace: sourceDirectory,
      }),
      /Non-empty local snapshots require an external clean-side authority-free verifier/,
    );

    assert.deepEqual(await readdir(path.join(adapterDirectory, 'savepoints')), []);
  } finally {
    await adapter.dispose();
    await rm(sourceDirectory, { recursive: true, force: true });
    await rm(adapterDirectory, { recursive: true, force: true });
  }
});

test('lifecycle enforces clean-controller authorship, legal transitions, time, and CAS', () => {
  assert.throws(
    () => createLifecycle({ run_id: 'run:bad-actor', actor: 'fork_runtime' }),
    /Only the clean controller/,
  );

  const lifecycle = createTestLifecycle();
  assert.equal(verifyLifecycle(lifecycle), true);
  assert.equal(lifecycle.version, 0);
  assert.equal(lifecycle.state, 'REQUESTED');
  assert.equal(lifecycle.fork_resource_state, 'NOT_CREATED');
  assert.ok(Object.isFrozen(lifecycle));

  const validInput = {
    actor: 'clean_controller',
    expected_version: lifecycle.version,
    expected_chain_head: lifecycle.chain_head,
    to: 'SAVEPOINTING',
    at: new Date(NOW.getTime() + 1000),
    reason: 'savepoint_starting',
    evidence: { status: 'observed' },
  };
  assert.throws(
    () => transitionLifecycle(lifecycle, { ...validInput, actor: 'fork_runtime' }),
    /Only the clean controller/,
  );
  assert.throws(
    () => transitionLifecycle(lifecycle, { ...validInput, expected_version: 1 }),
    /version conflict/,
  );
  assert.throws(
    () => transitionLifecycle(lifecycle, {
      ...validInput,
      expected_chain_head: hash('wrong-head'),
    }),
    /chain-head conflict/,
  );
  assert.throws(
    () => transitionLifecycle(lifecycle, { ...validInput, to: 'EXECUTING' }),
    /Invalid Risk Fork transition/,
  );
  assert.throws(
    () => transitionLifecycle(lifecycle, {
      ...validInput,
      at: '2029-12-31T23:59:59.999Z',
    }),
    /cannot move backward/,
  );
});

test('lifecycle event hash chain detects mutation and predecessor substitution', () => {
  let lifecycle = createTestLifecycle();
  lifecycle = next(lifecycle, 'SAVEPOINTING');
  lifecycle = next(lifecycle, 'SAVEPOINT_READY');
  assert.equal(verifyLifecycle(lifecycle), true);

  const mutated = clone(lifecycle);
  mutated.events[1].reason = 'mutated_reason';
  assert.throws(() => verifyLifecycle(mutated), /event hash mismatch/);

  const substituted = clone(lifecycle);
  substituted.events[2].previous_event_hash = hash('substituted-predecessor');
  assert.throws(() => verifyLifecycle(substituted), /predecessor mismatch/);

  const falseHead = clone(lifecycle);
  falseHead.chain_head = hash('false-head');
  assert.throws(() => verifyLifecycle(falseHead), /chain_head mismatch/);
});

test('lifecycle verification rejects malformed event reasons even if rehashed', () => {
  const lifecycle = clone(createTestLifecycle());
  lifecycle.events[0].reason = 7;
  lifecycle.events[0].event_hash = hash({
    ...lifecycle.events[0],
    event_hash: null,
  });
  lifecycle.chain_head = lifecycle.events[0].event_hash;

  assert.throws(() => verifyLifecycle(lifecycle), /reason/);
});

test('fork resources cannot become active before the fork-ready lifecycle boundary', () => {
  const lifecycle = createTestLifecycle();

  assert.throws(
    () => recordResourceState(lifecycle, {
      actor: 'clean_controller',
      expected_version: lifecycle.version,
      expected_chain_head: lifecycle.chain_head,
      state: 'ACTIVE',
      at: new Date(NOW.getTime() + 1000),
      reason: 'premature_resource_activation',
      evidence: {
        status: 'observed',
        ref: 'provider:fork-resource',
        hash: hash('fork-resource'),
      },
    }),
    /FORK_READY|resource.*lifecycle|Invalid fork resource transition/i,
  );
});

test('CLEAN_COMMIT_READY requires destroyed resource state and verified destruction evidence', () => {
  let lifecycle = reachCommitReady();
  lifecycle = next(lifecycle, 'PRECOMMIT_DESTROYING', {
    resource: 'DESTROY_REQUESTED',
    evidence: {
      status: 'requested',
      ref: 'destruction:request',
      hash: hash('destruction-request'),
    },
  });

  assert.throws(
    () => next(lifecycle, 'CLEAN_COMMIT_READY', {
      evidence: {
        status: 'verified',
        ref: 'destruction:proof',
        hash: hash('destruction-proof'),
      },
    }),
    /requires verified fork destruction/,
  );
  assert.throws(
    () => next(lifecycle, 'CLEAN_COMMIT_READY', {
      resource: 'DESTROYED',
      evidence: {
        status: 'observed',
        ref: 'destruction:observation',
        hash: hash('destruction-observation'),
      },
    }),
    /requires a verified clean-boundary event/,
  );

  const ready = next(lifecycle, 'CLEAN_COMMIT_READY', {
    resource: 'DESTROYED',
    evidence: {
      status: 'verified',
      ref: 'destruction:proof',
      hash: hash('destruction-proof'),
    },
  });
  assert.equal(ready.state, 'CLEAN_COMMIT_READY');
  assert.equal(ready.fork_resource_state, 'DESTROYED');
  assert.equal(verifyLifecycle(ready), true);
});

test('verified destruction evidence must be hash-bound before CLEAN_COMMIT_READY', () => {
  let lifecycle = reachCommitReady();
  lifecycle = next(lifecycle, 'PRECOMMIT_DESTROYING', {
    resource: 'DESTROY_REQUESTED',
    evidence: { status: 'requested' },
  });

  assert.throws(
    () => next(lifecycle, 'CLEAN_COMMIT_READY', {
      resource: 'DESTROYED',
      evidence: { status: 'verified' },
    }),
    /evidence.*(?:ref|hash)|verified.*evidence/i,
  );
});

test('resource transition table rejects direct ACTIVE to DESTROYED state changes', () => {
  let lifecycle = createTestLifecycle();
  lifecycle = next(lifecycle, 'SAVEPOINTING');
  lifecycle = next(lifecycle, 'SAVEPOINT_READY');
  lifecycle = next(lifecycle, 'FORK_STARTING');
  lifecycle = next(lifecycle, 'FORK_READY', { resource: 'ACTIVE' });

  assert.throws(
    () => recordResourceState(lifecycle, {
      actor: 'clean_controller',
      expected_version: lifecycle.version,
      expected_chain_head: lifecycle.chain_head,
      state: 'DESTROYED',
      at: new Date(NOW.getTime() + (lifecycle.version + 1) * 1000),
      reason: 'skip_destroy_request',
      evidence: {
        status: 'verified',
        ref: 'destruction:proof',
        hash: hash('destruction-proof'),
      },
    }),
    /Invalid fork resource transition/,
  );
});
