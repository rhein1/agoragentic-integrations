import assert from 'node:assert/strict';
import test from 'node:test';
import { canonicalize, hashValue } from '../index.mjs';
import {
  PRIME_AGENT_COMMAND_PREVIEW,
  PRIME_AGENT_HOST_CONTRACT,
  PRIME_AGENT_PACKAGE_VERSION,
  PRIME_AGENT_RUNTIME_ADAPTER_ID,
  PRIME_AGENT_RUNTIME_ADAPTER_VERSION,
  buildPrimeAgentCompatibilityPacket,
  buildPrimeAgentIntegrationDescriptor,
  buildPrimeAgentRuntimeRequest,
  validatePrimeAgentRuntimeEvidence,
  validatePrimeAgentRuntimePlan,
} from '../runtime-contract.mjs';

function request(overrides = {}) {
  return {
    owner_id: 'owner-prime-runtime',
    workspace_id: 'workspace-prime-runtime',
    deployment_id: 'deployment-prime-runtime',
    principal_ref: 'principal:owner-prime-runtime',
    goal: 'Run a bounded repository audit and return evidence.',
    sandbox_profile_ref: 'sandbox:agent-os-restricted-v1',
    harness_policy_ref: 'policy:harness-prime-runtime-v1',
    authority_ref: 'authority:prime-runtime-v1',
    provider_ref: 'provider:openai',
    model_ref: 'model:gpt-5.6',
    credential_profile_ref: 'credential-profile:prime-runtime-v1',
    runtime_image_ref: 'image:prime-agent-v0.7.1-restricted',
    runtime_image_digest: `sha256:${'1'.repeat(64)}`,
    extension_integrity_ref: `sha256:${'2'.repeat(64)}`,
    receipt_required: true,
    transaction_assurance_required: true,
    ...overrides,
  };
}

function planFromRequest(runtimeRequest) {
  const planBody = {
    schema: 'agoragentic.agent-os.prime-agent-runtime-plan.v1',
    adapter_id: PRIME_AGENT_RUNTIME_ADAPTER_ID,
    adapter_version: PRIME_AGENT_RUNTIME_ADAPTER_VERSION,
    runtime_provider: 'prime-agent',
    runtime_mode: 'rpc',
    runtime_status: 'contract_only',
    host_contract: PRIME_AGENT_HOST_CONTRACT,
    request: runtimeRequest,
    command_preview: PRIME_AGENT_COMMAND_PREVIEW,
    rpc_contract: {
      framing: 'jsonl_lf',
      stdin_stdout_only: true,
      diagnostics_on_stderr: true,
      shell: false,
      process_spawned: false,
      session_dir_is_private_mount: true,
      required_commands: ['prompt', 'abort', 'get_state', 'observe', 'unobserve'],
    },
    hard_enforcement_required: [
      'sandbox_process_boundary',
      'filesystem_policy',
      'network_egress_policy',
      'credential_broker',
      'payment_adapter',
      'owner_stop_and_revoke',
      'crash_recovery',
      'uncertain_side_effect_reconciliation',
      'transaction_assurance',
    ],
    integration_refs: {
      governance_extension: runtimeRequest.extension_ref,
      governance_extension_integrity: runtimeRequest.extension_integrity_ref,
      mcp_profile: runtimeRequest.mcp_profile_ref,
      harness_policy: runtimeRequest.harness_policy_ref,
      authority: runtimeRequest.authority_ref,
      credential_profile: runtimeRequest.credential_profile_ref,
      runtime_image: runtimeRequest.runtime_image_ref,
      runtime_image_digest: runtimeRequest.runtime_image_digest,
      transaction_assurance: runtimeRequest.transaction_assurance_ref,
    },
    decision: 'preview_ready',
    review_reasons: [],
    launch_allowed: false,
    runtime_executed: false,
    no_spawn: true,
    no_network: true,
    no_spend: true,
    authority_granted: false,
    authority_flags: {
      adapter_grants_authority: false,
      process_spawn_allowed: false,
      network_access_allowed: false,
      filesystem_write_allowed: false,
      credential_access_allowed: false,
      payment_allowed: false,
      wallet_mutation_allowed: false,
      deployment_allowed: false,
      publication_allowed: false,
      trust_mutation_allowed: false,
    },
  };
  return { ...planBody, plan_hash: hashValue(planBody) };
}

function evidenceFromPlan(plan) {
  const evidenceBody = {
    schema: 'agoragentic.agent-os.prime-agent-runtime-evidence.v1',
    adapter_id: PRIME_AGENT_RUNTIME_ADAPTER_ID,
    adapter_version: PRIME_AGENT_RUNTIME_ADAPTER_VERSION,
    host_contract_hash: PRIME_AGENT_HOST_CONTRACT.contract_hash,
    plan_hash: plan.plan_hash,
    evaluation_hash: `sha256:${'3'.repeat(64)}`,
    decision: 'preview_ready',
    blocker_count: 0,
    review_reason_count: 0,
    command_hash: hashValue(plan.command_preview),
    policy_ref_hash: hashValue(plan.request.harness_policy_ref),
    sandbox_profile_ref_hash: hashValue(plan.request.sandbox_profile_ref),
    runtime_image_digest: plan.request.runtime_image_digest,
    governance_extension_integrity: plan.request.extension_integrity_ref,
    runtime_executed: false,
    process_spawned: false,
    network_used: false,
    spend_occurred: false,
    authority_granted: false,
    public_safe: true,
  };
  return { ...evidenceBody, evidence_hash: hashValue(evidenceBody) };
}

function rehashEvidence(evidence, overrides = {}) {
  const body = { ...evidence, ...overrides };
  delete body.evidence_hash;
  return { ...body, evidence_hash: hashValue(body) };
}

function rehashPlan(plan, overrides = {}) {
  const body = { ...plan, ...overrides };
  delete body.plan_hash;
  return { ...body, plan_hash: hashValue(body) };
}

test('builds the exact closed Agent OS request used by the runtime lane', () => {
  const result = buildPrimeAgentRuntimeRequest(request());
  assert.equal(result.schema, 'agoragentic.agent-os.prime-agent-runtime-request.v1');
  assert.equal(result.extension_ref, `package:@agoragentic/prime-agent@${PRIME_AGENT_PACKAGE_VERSION}`);
  assert.equal(result.mcp_profile_ref, 'mcp-profile:agoragentic-private-v1');
  assert.equal(result.public_exposure_mode, 'private_only');
  assert.equal(result.receipt_required, true);
  assert.equal(result.transaction_assurance_required, true);
});

test('request builder rejects unknown fields, secret-like values, oversized IDs, and paid activation', () => {
  assert.throws(() => buildPrimeAgentRuntimeRequest(request({ extra: true })), /unsupported fields/);
  assert.throws(() => buildPrimeAgentRuntimeRequest(request({ goal: 'Use sk-abcdefghijklmnop' })), /secret-like/);
  assert.throws(() => buildPrimeAgentRuntimeRequest(request({ owner_id: `owner-${'x'.repeat(200)}` })), /exceeds/);
  assert.throws(() => buildPrimeAgentRuntimeRequest({
    ...request(),
    payment_policy: { paid_actions_enabled: true },
  }), /paid actions are not enabled/);
});

test('descriptor exposes both the Prime extension and runtime-contract entry without authority', () => {
  const descriptor = buildPrimeAgentIntegrationDescriptor();
  assert.equal(descriptor.package_name, '@agoragentic/prime-agent');
  assert.equal(descriptor.package_version, PRIME_AGENT_PACKAGE_VERSION);
  assert.equal(descriptor.extension_entry, './index.mjs');
  assert.equal(descriptor.runtime_contract_entry, './runtime-contract.mjs');
  assert.equal(descriptor.distribution_status, 'source_only');
  assert.ok(Object.values(descriptor.authority_boundary).every((value) => value === false));
});

test('validates a hash-bound Agent OS runtime plan without claiming runtime verification', () => {
  const runtimeRequest = buildPrimeAgentRuntimeRequest(request());
  const plan = planFromRequest(runtimeRequest);
  const validation = validatePrimeAgentRuntimePlan(plan);
  assert.equal(validation.valid, true);
  assert.deepEqual(validation.blockers, []);
  assert.equal(validation.plan_hash, plan.plan_hash);
  assert.equal(plan.launch_allowed, false);
  assert.equal(plan.runtime_executed, false);
  assert.equal(plan.no_spawn, true);
  assert.equal(plan.no_network, true);
  assert.equal(plan.no_spend, true);
  assert.equal(plan.authority_granted, false);
  assert.equal(validation.runtime_verified, false);
  assert.equal(validation.runtime_executed, false);
});

test('blocks stale hashes, host drift, command drift, request drift, and authority-shape drift', () => {
  const runtimeRequest = buildPrimeAgentRuntimeRequest(request());
  const plan = planFromRequest(runtimeRequest);
  const tampered = {
    ...plan,
    host_contract: { ...plan.host_contract, tag: 'v0.7.2' },
    command_preview: [...plan.command_preview, '--extra'],
    request: { ...plan.request, receipt_required: false },
    authority_flags: { ...plan.authority_flags, unexpected: false },
    rpc_contract: { ...plan.rpc_contract, framing: 'not-jsonl' },
    hard_enforcement_required: plan.hard_enforcement_required.slice(1),
    integration_refs: { ...plan.integration_refs, mcp_profile: 'mcp-profile:other' },
    runtime_executed: true,
    authority_granted: true,
  };
  const validation = validatePrimeAgentRuntimePlan(tampered);
  assert.equal(validation.valid, false);
  assert.ok(validation.blockers.includes('plan_hash_mismatch'));
  assert.ok(validation.blockers.includes('prime_agent_host_contract_mismatch'));
  assert.ok(validation.blockers.includes('command_preview_mismatch'));
  assert.ok(validation.blockers.includes('authority_boundary_broken'));
  assert.ok(validation.blockers.includes('rpc_contract_mismatch'));
  assert.ok(validation.blockers.includes('hard_enforcement_contract_mismatch'));
  assert.ok(validation.blockers.includes('integration_reference_mismatch'));
  assert.ok(validation.blockers.includes('receipt_requirement_missing'));
  assert.ok(validation.blockers.includes('execution_boundary_broken'));

  const missingBoundaryFields = { ...plan };
  delete missingBoundaryFields.runtime_executed;
  delete missingBoundaryFields.authority_granted;
  const missingBoundaryValidation = validatePrimeAgentRuntimePlan(rehashPlan(missingBoundaryFields));
  assert.equal(missingBoundaryValidation.valid, false);
  assert.ok(missingBoundaryValidation.blockers.includes('execution_boundary_broken'));
});

test('validates public-safe evidence only when it binds the same plan and zero-action boundary', () => {
  const runtimeRequest = buildPrimeAgentRuntimeRequest(request());
  const plan = planFromRequest(runtimeRequest);
  const evidence = evidenceFromPlan(plan);
  const validation = validatePrimeAgentRuntimeEvidence(evidence, plan);
  assert.equal(validation.valid, true);
  assert.deepEqual(validation.blockers, []);

  const tamperedBody = { ...evidence, network_used: true };
  delete tamperedBody.evidence_hash;
  const tampered = { ...tamperedBody, evidence_hash: hashValue(tamperedBody) };
  const tamperedValidation = validatePrimeAgentRuntimeEvidence(tampered, plan);
  assert.equal(tamperedValidation.valid, false);
  assert.ok(tamperedValidation.blockers.includes('evidence_boundary_broken'));
});

test('recomputed hashes cannot legitimize undeclared secret, authority, settlement, or wallet evidence', () => {
  const runtimeRequest = buildPrimeAgentRuntimeRequest(request());
  const plan = planFromRequest(runtimeRequest);
  const evidence = evidenceFromPlan(plan);
  const adversarialFields = [
    ['api_key', 'sk-abcdefghijklmnop'],
    ['authority', { payment_allowed: true }],
    ['settlement_receipt', { status: 'settled' }],
    ['wallet', '0x0000000000000000000000000000000000000000'],
  ];
  for (const [field, value] of adversarialFields) {
    const adversarial = rehashEvidence(evidence, { [field]: value });
    const validation = validatePrimeAgentRuntimeEvidence(adversarial, plan);
    assert.equal(validation.valid, false, field);
    assert.ok(validation.blockers.includes('evidence_contract_not_closed'), field);
    assert.equal(buildPrimeAgentCompatibilityPacket({ plan, evidence: adversarial }).status, 'blocked', field);
  }
});

test('evidence fields are bound to the exact validated plan even after hash recomputation', () => {
  const runtimeRequest = buildPrimeAgentRuntimeRequest(request());
  const plan = planFromRequest(runtimeRequest);
  const evidence = evidenceFromPlan(plan);
  const cases = [
    ['adapter_id', 'other-adapter', 'evidence_adapter_contract_mismatch'],
    ['decision', 'review_required', 'evidence_decision_mismatch'],
    ['review_reason_count', 1, 'evidence_counts_mismatch'],
    ['command_hash', `sha256:${'4'.repeat(64)}`, 'evidence_command_hash_mismatch'],
    ['policy_ref_hash', `sha256:${'5'.repeat(64)}`, 'evidence_policy_hash_mismatch'],
    ['sandbox_profile_ref_hash', `sha256:${'6'.repeat(64)}`, 'evidence_sandbox_hash_mismatch'],
    ['runtime_image_digest', `sha256:${'7'.repeat(64)}`, 'evidence_runtime_image_mismatch'],
    ['governance_extension_integrity', `sha256:${'8'.repeat(64)}`, 'evidence_governance_extension_mismatch'],
  ];
  for (const [field, value, blocker] of cases) {
    const adversarial = rehashEvidence(evidence, { [field]: value });
    const validation = validatePrimeAgentRuntimeEvidence(adversarial, plan);
    assert.equal(validation.valid, false, field);
    assert.ok(validation.blockers.includes(blocker), field);
  }
});

test('recomputed plan hashes cannot legitimize undeclared or nested contract fields', () => {
  const runtimeRequest = buildPrimeAgentRuntimeRequest(request());
  const plan = planFromRequest(runtimeRequest);
  const topLevel = rehashPlan(plan, { provider_secret: 'sk-abcdefghijklmnop' });
  const nested = rehashPlan(plan, { rpc_contract: { ...plan.rpc_contract, payment_allowed: false } });
  for (const adversarial of [topLevel, nested]) {
    const validation = validatePrimeAgentRuntimePlan(adversarial);
    assert.equal(validation.valid, false);
    assert.ok(validation.blockers.includes('plan_contract_not_closed'));
  }
});

test('compatibility packet binds package, host, plan, and evidence while remaining non-executing', () => {
  const runtimeRequest = buildPrimeAgentRuntimeRequest(request());
  const plan = planFromRequest(runtimeRequest);
  const evidence = evidenceFromPlan(plan);
  const packet = buildPrimeAgentCompatibilityPacket({ plan, evidence });
  const body = { ...packet };
  delete body.packet_hash;
  assert.equal(packet.status, 'contract_compatible');
  assert.equal(packet.packet_hash, hashValue(body));
  assert.equal(packet.runtime_verified, false);
  assert.equal(packet.runtime_executed, false);
  assert.equal(packet.authority_granted, false);
  assert.equal(packet.partnership_claimed, false);
  assert.equal(canonicalize(packet.package.prime_agent_host_contract), canonicalize(PRIME_AGENT_HOST_CONTRACT));
});
