import { randomBytes } from 'node:crypto';
import {
  link,
  lstat,
  mkdir,
  open,
  opendir,
  readFile,
  rename,
  unlink,
  writeFile,
} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import {
  LocalReferenceRiskForkAdapter,
  RiskForkController,
  buildExecutionBinding,
  classifyRisk,
  createCleanupVerificationEvidence,
  createForkIdentity,
  createLifecycle,
  createMcpInterceptionPlan,
  createRiskForkReceipt,
  inspectLocalWorkspace,
  networkPolicy,
  sha256Ref,
  transitionLifecycle,
  verifyLifecycle,
  verifyRiskForkReceipt,
} from '../../src/index.mjs';
import {
  DEMO_EXPIRES_AT,
  DEMO_NOW,
  TYPED_RESULT_SCHEMA,
  createScenarioCapsule,
  demoTrustedServerVerifier,
  getScenario,
  listScenarios,
  scenarioEffectiveArguments,
} from './scenarios.mjs';
import {
  RISK_FORK_DEMO_BANNER,
  RISK_FORK_DEMO_LIMITS,
  assertDemoSecretFree,
  assertDemoTruth,
  createDemoTruth,
  initializeOwnedDemoRoot,
  inspectOwnedDemoTree,
  openOwnedDemoRoot,
  redactDemoValue,
  removeOwnedDemoEntry,
  resolveOwnedDemoPath,
  sanitizeDemoError,
  validateDemoOperation,
} from './security.mjs';
import {
  FAKE_E2B_DEMO_LABEL,
  FAKE_E2B_DEMO_PROFILE,
  HackathonFakeE2BAdapter,
  RISK_FORK_HACKATHON_PRODUCT_CLAIM,
} from './fake-e2b-profile.mjs';
import { MALICIOUS_MCP_PARENT_CREDENTIAL_REF } from '../fixtures/malicious-stdio-mcp.mjs';

const DEMO_RESULT_SCHEMA = 'agoragentic.risk-fork.hackathon-demo-result.v1';
const DEMO_PLAN_SCHEMA = 'agoragentic.risk-fork.hackathon-demo-plan.v1';
const DEMO_RECEIPT_SCHEMA = 'agoragentic.risk-fork.hackathon-demo-receipt.v1';
const DEMO_STATE_SCHEMA = 'agoragentic.risk-fork.hackathon-demo-state.v1';
const RUNS_DIRECTORY = 'runs';
const ACTIVE_LOCK = '.active-run.lock';
const RECOVERY_LOCK = '.cleanup-recovery.lock';
const RECOVERY_QUARANTINE_DIRECTORY = '.recovery-quarantine';
const STATE_FILE = 'state.json';
const DEFAULT_ROOT_NAME = 'agoragentic-risk-fork-hackathon-demo-v1';
const STATIC_CLOCK = () => new Date(DEMO_NOW);
const SYSTEM_CLOCK = () => new Date();
const OBSERVATIONS = new WeakMap();
const ADAPTER_OPTIONS = new WeakMap();
export const RISK_FORK_DEMO_MINIMUM_NODE_MAJOR = 20;
export const RISK_FORK_DEMO_SUPPORTED_NODE_RANGE = '>=20';
export const RISK_FORK_DEMO_TAINT_EVIDENCE_MAX_REFERENCE_BYTES = 64;
export const RISK_FORK_DEMO_TAINT_EVIDENCE_HASH_BYTES = 71;
export const RISK_FORK_DEMO_STALE_LOCK_GRACE_MS = 30_000;

const NODE_VERSION_PATTERN = /^(?:v)?(\d+)(?:\.\d+){2}(?:[-+][0-9A-Za-z.-]+)?$/;
const SHA256_REFERENCE_PATTERN = /^sha256:[a-f0-9]{64}$/;
const ACTIVE_LOCK_SCHEMA = 'agoragentic.risk-fork.hackathon-active-lock.v1';
const RECOVERY_LOCK_SCHEMA = 'agoragentic.risk-fork.hackathon-recovery-lock.v1';
const ACTIVE_LOCK_KEYS = Object.freeze([
  'schema',
  'root_id',
  'lock_id',
  'run_id',
  'pid',
  'created_at',
  'lock_hash',
]);
const RECOVERY_LOCK_KEYS = Object.freeze([
  'schema',
  'root_id',
  'recovery_id',
  'pid',
  'created_at',
  'lock_hash',
]);
const MAX_LOCK_BYTES = 4 * 1024;
const RUN_ID_PATTERN = /^run_[a-f0-9]{24}$/;
const LOCK_ID_PATTERN = /^lock_[a-f0-9]{32}$/;
const RECOVERY_ID_PATTERN = /^recovery_[a-f0-9]{32}$/;
const DEMO_LOCAL_EXECUTION_MODE = 'local_reference_protocol_execution';
const DEMO_FAKE_E2B_EXECUTION_MODE = 'fake_e2b_protocol_execution';

function demoFacingExecutionMode(value) {
  return value === 'isolated_execution' || value === 'isolated_execution_timeout_probe'
    ? DEMO_LOCAL_EXECUTION_MODE
    : value;
}

function deepFreeze(value) {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value)) deepFreeze(child);
  }
  return value;
}

function frozenCopy(value) {
  return deepFreeze(structuredClone(value));
}

export function evaluateDemoNodeRuntime(version = process.versions.node) {
  const match = typeof version === 'string' ? NODE_VERSION_PATTERN.exec(version.trim()) : null;
  const observedMajor = match ? Number.parseInt(match[1], 10) : null;
  const supported = Number.isSafeInteger(observedMajor)
    && observedMajor >= RISK_FORK_DEMO_MINIMUM_NODE_MAJOR;
  return frozenCopy({
    observed_major: observedMajor,
    minimum_major: RISK_FORK_DEMO_MINIMUM_NODE_MAJOR,
    supported_range: RISK_FORK_DEMO_SUPPORTED_NODE_RANGE,
    supported,
  });
}

function classifierVersion(name) {
  const match = typeof name === 'string' ? /(?:^|-)(v\d+)$/.exec(name) : null;
  if (!match) throw new Error('Deterministic classifier name is missing its version suffix');
  return match[1];
}

function cleanSummary(plan) {
  const decision = plan.risk_decision;
  return frozenCopy({
    level: decision.level,
    action: decision.action,
    directive: plan.directive,
    score: decision.score,
    reasons: decision.reasons.map((reason) => reason.code),
    classifier: decision.classifier.name,
    classifier_version: classifierVersion(decision.classifier.name),
    decision_hash: decision.decision_hash,
    plan_hash: plan.plan_hash,
  });
}

function lifecycleSummary(lifecycle) {
  if (!lifecycle) {
    return Object.freeze({ states: [], chain_head: null, verified: false });
  }
  let verified = false;
  try {
    verified = verifyLifecycle(lifecycle) === true;
  } catch {
    verified = false;
  }
  return frozenCopy({
    states: lifecycle.events.map((event) => event.to),
    chain_head: lifecycle.chain_head,
    verified,
  });
}

function evidenceClaim(status, outcome, label) {
  if (['not_applicable', 'requested', 'unknown'].includes(status)) {
    return { status, outcome };
  }
  const evidenceHash = sha256Ref({ label, status, outcome });
  return {
    status,
    outcome,
    evidence_ref: `demo-evidence:${evidenceHash.slice(7, 31)}`,
    evidence_hash: evidenceHash,
  };
}

function taintedOutputEvidence(resultHash = null) {
  const common = {
    sanitized: true,
    raw_output_included: false,
    max_reference_bytes: RISK_FORK_DEMO_TAINT_EVIDENCE_MAX_REFERENCE_BYTES,
    max_hash_bytes: RISK_FORK_DEMO_TAINT_EVIDENCE_HASH_BYTES,
  };
  if (resultHash === null) {
    return frozenCopy({
      status: 'not_produced',
      evidence_ref: null,
      evidence_hash: null,
      reference_bytes: 0,
      hash_bytes: 0,
      ...common,
    });
  }
  if (typeof resultHash !== 'string' || !SHA256_REFERENCE_PATTERN.test(resultHash)) {
    throw new Error('Tainted output evidence requires an exact SHA-256 reference');
  }
  const evidenceRef = `demo-tainted-output:${resultHash.slice(7, 31)}`;
  const referenceBytes = Buffer.byteLength(evidenceRef, 'utf8');
  const hashBytes = Buffer.byteLength(resultHash, 'utf8');
  if (referenceBytes > RISK_FORK_DEMO_TAINT_EVIDENCE_MAX_REFERENCE_BYTES
    || hashBytes !== RISK_FORK_DEMO_TAINT_EVIDENCE_HASH_BYTES) {
    throw new Error('Tainted output evidence exceeds its closed reference/hash bounds');
  }
  return frozenCopy({
    status: 'sanitized_hash_only',
    evidence_ref: evidenceRef,
    evidence_hash: resultHash,
    reference_bytes: referenceBytes,
    hash_bytes: hashBytes,
    ...common,
  });
}

function makeDemoReceipt({
  runId,
  scenario,
  finalState,
  plan,
  lifecycle,
  coreReceipt,
  coreReceiptVerified,
  cleanupStatus,
  exitCode,
}) {
  const draft = createDemoTruth({
    schema: DEMO_RECEIPT_SCHEMA,
    run_id: runId,
    scenario_id: scenario.id,
    final_state: finalState,
    risk_decision_hash: plan.risk_decision.decision_hash,
    interception_plan_hash: plan.plan_hash,
    lifecycle_chain_head: lifecycle?.chain_head ?? null,
    core_receipt_hash: coreReceipt?.receipt_hash ?? null,
    core_receipt_verified: coreReceiptVerified === true,
    cleanup_status: cleanupStatus,
    exit_code: exitCode,
    verified: true,
    demo_receipt_hash: null,
  });
  const demoReceiptHash = sha256Ref(draft);
  const {
    banner: _banner,
    demo_only: _demoOnly,
    local_protocol_simulator: _localProtocolSimulator,
    production_ready: _productionReady,
    live_traffic_protected: _liveTrafficProtected,
    authority_granted: _authorityGranted,
    provider_calls: _providerCalls,
    network_used: _networkUsed,
    credentials_used: _credentialsUsed,
    clean_commit_performed: _cleanCommitPerformed,
    ...receiptFields
  } = structuredClone(draft);
  const receipt = createDemoTruth({
    ...receiptFields,
    demo_receipt_hash: demoReceiptHash,
  });
  verifyDemoEnvelope(receipt);
  return receipt;
}

export function verifyDemoEnvelope(value) {
  assertDemoTruth(value);
  if (value.schema !== DEMO_RECEIPT_SCHEMA || value.verified !== true) {
    throw new Error('Demo receipt schema or verification marker is invalid');
  }
  if (typeof value.demo_receipt_hash !== 'string') {
    throw new Error('Demo receipt hash is required');
  }
  const expected = sha256Ref({ ...structuredClone(value), demo_receipt_hash: null });
  if (expected !== value.demo_receipt_hash) throw new Error('Demo receipt hash mismatch');
  return true;
}

export function assertDemoResultReceiptBinding(value) {
  assertDemoTruth(value);
  if (!value?.demo_receipt || typeof value.demo_receipt !== 'object') {
    throw new Error('Demo result receipt is required');
  }
  verifyDemoEnvelope(value.demo_receipt);
  if (value.final_state !== value.demo_receipt.final_state) {
    throw new Error('Demo result final state does not match its receipt');
  }
  if (value.exit_code !== value.demo_receipt.exit_code) {
    throw new Error('Demo result exit code does not match its receipt');
  }
  if ((value.cleanup?.status ?? 'unknown') !== value.demo_receipt.cleanup_status) {
    throw new Error('Demo result cleanup status does not match its receipt');
  }
  return true;
}

export function getDefaultDemoRoot() {
  return path.join(os.tmpdir(), DEFAULT_ROOT_NAME);
}

export function createDemoPlan(scenarioId) {
  const scenario = getScenario(scenarioId);
  const riskDecision = classifyRisk(scenario.risk_input, {
    trusted_server_verifier: demoTrustedServerVerifier,
    clock: STATIC_CLOCK,
  });
  const plan = createMcpInterceptionPlan({
    risk_input: scenario.risk_input,
    trusted_server_verifier: demoTrustedServerVerifier,
  }, { clock: STATIC_CLOCK });
  if (riskDecision.decision_hash !== plan.risk_decision.decision_hash) {
    throw new Error('Classifier and interception plan decisions differ');
  }
  return createDemoTruth({
    schema: DEMO_PLAN_SCHEMA,
    scenario: {
      id: scenario.id,
      title: scenario.title,
      expected_level: scenario.expected_level,
      expected_action: scenario.expected_action ?? null,
    },
    decision: cleanSummary(plan),
    enforcement_point: plan.enforcement_point,
    required_host_capabilities: structuredClone(plan.required_host_capabilities),
    writes_performed: false,
  });
}

function observe(adapter, stage, details = {}) {
  try {
    const sanitized = redactDemoValue({ stage, ...structuredClone(details) });
    assertDemoSecretFree(sanitized, 'Read-only demo observer record');
    OBSERVATIONS.get(adapter).push(frozenCopy(sanitized));
  } catch {
    // The observer is evidence-only: recording failure must never change controller flow.
    OBSERVATIONS.get(adapter)?.push(Object.freeze({
      stage: 'observer_record_rejected',
      code: 'DEMO_OBSERVER_SANITIZATION_FAILED',
    }));
  }
}

class DemoObservingLocalAdapter extends LocalReferenceRiskForkAdapter {
  constructor(options = {}) {
    const {
      cleanupUnknown = false,
      observationClock = STATIC_CLOCK,
      ...adapterOptions
    } = options;
    super(adapterOptions);
    OBSERVATIONS.set(this, []);
    ADAPTER_OPTIONS.set(this, Object.freeze({ cleanupUnknown, observationClock }));
  }

  observations() {
    return frozenCopy(OBSERVATIONS.get(this));
  }

  async createSavepoint(input = {}) {
    observe(this, 'savepoint_requested', {
      capsule_hash: input.capsule?.capsule_hash ?? null,
      workspace_digest: input.capsule?.workspace?.digest ?? null,
    });
    try {
      const result = await super.createSavepoint(input);
      observe(this, 'savepoint_ready', {
        savepoint_ref: result.savepoint_ref,
        savepoint_hash: result.savepoint_hash,
        workspace_digest: result.workspace_digest,
      });
      return result;
    } catch (error) {
      observe(this, 'savepoint_rejected', sanitizeDemoError(error, {
        code: 'DEMO_SAVEPOINT_REJECTED',
      }));
      throw error;
    }
  }

  async createFork(input = {}) {
    observe(this, 'fork_requested', {
      savepoint_ref: input.savepoint_ref,
      fork_identity_hash: input.fork_identity?.identity_hash ?? null,
      ttl_ms: input.ttl_ms,
      network_policy_hash: input.network_policy?.policy_hash ?? null,
    });
    try {
      const result = await super.createFork(input);
      observe(this, 'fork_ready', {
        fork_ref: result.fork_ref,
        fork_hash: result.fork_hash,
        expires_at: result.expires_at,
        isolation_class: result.isolation_class,
      });
      return result;
    } catch (error) {
      observe(this, 'fork_rejected', sanitizeDemoError(error, {
        code: 'DEMO_FORK_REJECTED',
      }));
      throw error;
    }
  }

  async executeInFork(input = {}) {
    observe(this, 'execution_requested', {
      fork_ref: input.fork_ref,
      execution_mode: demoFacingExecutionMode(input.execution_mode),
      isolation_boundary: false,
      timeout_ms: input.timeout_ms,
      action_count: input.operation?.actions?.length ?? 0,
    });
    try {
      const result = await super.executeInFork(input);
      observe(this, 'tainted_result_produced', {
        status: result.status,
        taint_status: result.taint_status,
        result_hash: result.result_hash,
      });
      return result;
    } catch (error) {
      observe(this, 'execution_rejected', sanitizeDemoError(error, {
        code: error?.code === 'LOCAL_REFERENCE_EXECUTION_TIMEOUT'
          ? 'DEMO_EXECUTION_TIMEOUT'
          : 'DEMO_EXECUTION_REJECTED',
      }));
      throw error;
    }
  }

  async destroyFork(input = {}) {
    observe(this, 'fork_destruction_requested', {
      fork_ref: input.fork_ref,
      reason: input.reason ?? 'unspecified',
      cleanup_request_hash: input.cleanup_request?.request_hash ?? null,
    });
    const result = await super.destroyFork(input);
    observe(this, 'fork_destruction_observed', {
      fork_ref: result.fork_ref,
      status: result.status,
      evidence_hash: result.evidence_hash,
    });
    return result;
  }

  async verifyDestroyed(input = {}) {
    const actual = await super.verifyDestroyed(input);
    observe(this, 'fork_absence_observed', {
      status: actual.status,
      outcome: actual.outcome,
      evidence_ref: actual.evidence_ref,
      evidence_hash: actual.evidence_hash,
    });
    if (!ADAPTER_OPTIONS.get(this).cleanupUnknown) return actual;
    if (!input.cleanup_request) {
      throw new Error('Synthetic cleanup-unknown requires an exact cleanup request');
    }
    const unknown = createCleanupVerificationEvidence(input.cleanup_request, {
      status: 'unknown',
      outcome: 'unknown',
      observation_hash: sha256Ref({
        scenario: 'cleanup-unknown',
        cleanup_request_hash: input.cleanup_request.request_hash,
        actual_absence_evidence_hash: actual.evidence_hash,
      }),
      observed_at: ADAPTER_OPTIONS.get(this).observationClock(),
    });
    observe(this, 'synthetic_cleanup_verification_unknown', {
      status: unknown.status,
      outcome: unknown.outcome,
      cleanup_request_hash: unknown.cleanup_request_hash,
      evidence_hash: unknown.evidence_hash,
      actual_absence_observed: actual.status === 'verified' && actual.outcome === 'success',
    });
    return unknown;
  }

  async destroySavepoint(input = {}) {
    observe(this, 'savepoint_destruction_requested', {
      savepoint_ref: input.savepoint_ref,
      cleanup_request_hash: input.cleanup_request?.request_hash ?? null,
    });
    const result = await super.destroySavepoint(input);
    observe(this, 'savepoint_destruction_observed', {
      savepoint_ref: result.savepoint_ref,
      status: result.status,
      evidence_hash: result.evidence_hash,
    });
    return result;
  }

  async verifySavepointDestroyed(input = {}) {
    const result = await super.verifySavepointDestroyed(input);
    observe(this, 'savepoint_absence_observed', {
      status: result.status,
      outcome: result.outcome,
      evidence_ref: result.evidence_ref,
      evidence_hash: result.evidence_hash,
    });
    return result;
  }
}

function createAuthorityFreeSourceVerifier(request) {
  const evidenceHash = sha256Ref({
    request_hash: request.request_hash,
    capsule_hash: request.capsule_hash,
    workspace_digest: request.workspace_digest,
    synthetic_source_only: true,
  });
  return {
    schema: 'agoragentic.risk-fork.local-authority-free-attestation.v1',
    status: 'verified',
    request_hash: request.request_hash,
    capsule_hash: request.capsule_hash,
    workspace_digest: request.workspace_digest,
    evidence_ref: `demo-authority-free:${evidenceHash.slice(7, 31)}`,
    evidence_hash: evidenceHash,
    claims: {
      authority_free: true,
      credentials_absent: true,
      wallet_material_absent: true,
      execution_authority_absent: true,
    },
  };
}

function createExecutionBindingFactory(scenario, { stale = false } = {}) {
  return async ({ capsule, fork_identity: forkIdentity, provider_ref: providerRef }) => {
    const action = scenario.operation.commit_candidate.action;
    const actionOperation = action.operation === 'deployment' ? 'deploy' : action.operation;
    const issuedAt = stale ? '2029-12-31T23:00:00.000Z' : DEMO_NOW;
    const notBefore = stale ? '2029-12-31T23:00:00.000Z' : DEMO_NOW;
    const expiresAt = stale ? '2029-12-31T23:01:00.000Z' : DEMO_EXPIRES_AT;
    return buildExecutionBinding({
      principal_ref: 'principal:risk-fork-synthetic-demo',
      action_operation: actionOperation,
      fork_agent_id: forkIdentity.fork_agent_id,
      session_id: forkIdentity.session_id,
      mcp_server_ref: capsule.proposed_interaction.mcp_server_ref,
      mcp_server_origin: capsule.proposed_interaction.mcp_server_origin,
      mcp_method: capsule.proposed_interaction.mcp_method,
      raw_method: capsule.proposed_interaction.raw_method,
      tool_name: capsule.proposed_interaction.tool_name,
      effective_arguments: scenarioEffectiveArguments(scenario),
      provider_ref: providerRef,
      target_ref: action.target_ref,
      amount: action.amount,
      currency: action.currency,
      payment_rail: action.payment_rail,
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
      issued_at: issuedAt,
      not_before: notBefore,
      expires_at: expiresAt,
      nonce: `nonce:synthetic-${scenario.id}`,
      one_use_authorization_id: `one-use:synthetic-${scenario.id}`,
      audience: 'audience:risk-fork-synthetic-demo',
      authorization_ref: capsule.execution_authorization.ref,
      authorization_hash: capsule.execution_authorization.hash,
    });
  };
}

function normalizedScenarioOperation(scenario) {
  const operation = structuredClone(scenario.operation);
  if (operation.commit_candidate?.type === 'CONSEQUENTIAL_ACTION_PROPOSAL'
    && operation.commit_candidate.action?.operation === 'deployment') {
    operation.commit_candidate.action.operation = 'deploy';
  }
  return operation;
}

function createCoreReceipt(prepared) {
  const taintedEvent = prepared.lifecycle.events.find((event) => event.to === 'TAINTED');
  const receipt = createRiskForkReceipt({
    created_at: DEMO_NOW,
    capsule: prepared.capsule,
    risk_decision: prepared.risk_decision,
    lifecycle: prepared.lifecycle,
    fork_identity: prepared.fork_identity,
    fork_ref: prepared.artifact.source_fork_id,
    provider_ref: prepared.provider.ref,
    provider_capabilities_hash: prepared.provider.capabilities_hash,
    savepoint_claim: evidenceClaim('verified', 'success', 'demo-savepoint'),
    fork_start_claim: evidenceClaim('observed', 'success', 'demo-fork-start'),
    execution_claim: evidenceClaim('observed', 'success', 'demo-execution'),
    result_digest: taintedEvent.evidence.hash,
    commit_artifact: prepared.artifact,
    accepted_commit_digest: null,
    validation_evidence_refs: ['validation:risk-fork-hackathon-demo'],
    credential_revocation_claim: evidenceClaim(
      'not_applicable',
      'not_applicable',
      'demo-credential-revocation',
    ),
    destruction_claim: {
      status: 'verified',
      outcome: 'success',
      evidence_ref: prepared.destruction_evidence.evidence_ref,
      evidence_hash: prepared.destruction_evidence.evidence_hash,
    },
    destruction_evidence: prepared.destruction_evidence,
    transaction_assurance_evidence_refs: [],
    measurements: prepared.measurements,
  }, { trusted_server_verifier: demoTrustedServerVerifier });
  const verified = verifyRiskForkReceipt(receipt, {
    risk_decision: prepared.risk_decision,
    trusted_server_verifier: demoTrustedServerVerifier,
  });
  return { receipt, verified };
}

function cleanupFromPreparationError(error, observerRecords) {
  const lifecycle = error?.evidence?.lifecycle ?? null;
  const forkClaim = error?.evidence?.cleanup?.fork ?? null;
  const savepointClaim = error?.evidence?.cleanup?.savepoint ?? null;
  const statuses = [forkClaim?.status, savepointClaim?.status].filter(Boolean);
  const status = statuses.includes('failed')
    ? 'failed'
    : statuses.includes('unknown')
      ? 'unknown'
      : statuses.length > 0 && statuses.every((value) => value === 'verified')
        ? 'verified'
        : 'not_applicable';
  const actualAbsence = observerRecords.some((record) => (
    record.stage === 'fork_absence_observed'
      && record.status === 'verified'
      && record.outcome === 'success'
  ));
  return {
    lifecycle,
    cleanup: {
      requested: Boolean(lifecycle?.events?.some((event) => (
        ['PRECOMMIT_DESTROYING', 'DESTROYING'].includes(event.to)
      ))),
      absence: actualAbsence ? 'verified' : status,
      status,
    },
  };
}

function baseComponent({ scenario, plan, runId }) {
  return {
    run_id: runId,
    scenario: { id: scenario.id, title: scenario.title },
    action_summary: scenario.title,
    provider_profile: scenario.provider_profile ?? 'local-reference',
    provider_label: scenario.provider_profile === 'fake-e2b' ? FAKE_E2B_DEMO_LABEL : null,
    product_claim: RISK_FORK_HACKATHON_PRODUCT_CLAIM,
    decision: cleanSummary(plan),
    parent_state_hash: null,
    parent_state_hash_before: null,
    parent_state_hash_after: null,
    parent_state_unchanged: null,
    savepoint_capsule_hash: null,
    savepoint_status: 'not_allocated',
    sandbox_id: null,
    fork_identity_hash: null,
    execution_mode: 'not_executed',
    isolation_boundary: false,
    taint_status: 'not_produced',
    tainted_output_evidence: taintedOutputEvidence(),
    validation_status: 'not_applicable',
    lifecycle: lifecycleSummary(null),
    cleanup: { requested: false, absence: 'not_applicable', status: 'not_applicable' },
    limits: structuredClone(RISK_FORK_DEMO_LIMITS),
    final_state: 'blocked',
    exit_code: 2,
    local_adapter_calls: 0,
    simulated_sdk_events: 0,
    provider_evidence: null,
    accepted_typed_result: null,
    cost: scenario.provider_profile === 'fake-e2b'
      ? structuredClone(FAKE_E2B_DEMO_PROFILE.compute)
      : null,
    observer_records: [],
    core_receipt: null,
    core_receipt_verified: false,
  };
}

function finalizeResult({ scenario, plan, component, completedRunsAfter, ownedRunCleanup }) {
  const cleanupStatus = component.cleanup?.status ?? 'unknown';
  const demoReceipt = makeDemoReceipt({
    runId: component.run_id,
    scenario,
    finalState: component.final_state,
    plan,
    lifecycle: component.lifecycle?.chain_head
      ? { chain_head: component.lifecycle.chain_head }
      : null,
    coreReceipt: component.core_receipt,
    coreReceiptVerified: component.core_receipt_verified,
    cleanupStatus,
    exitCode: component.exit_code,
  });
  const result = createDemoTruth({
    schema: DEMO_RESULT_SCHEMA,
    ...structuredClone(component),
    completed_runs_after: completedRunsAfter,
    owned_run_cleanup: structuredClone(ownedRunCleanup),
    demo_receipt: demoReceipt,
  });
  assertDemoTruth(result);
  assertDemoResultReceiptBinding(result);
  return result;
}

async function ensureDirectory(rootHandle, relativePath) {
  const resolved = await resolveOwnedDemoPath(rootHandle, relativePath);
  if (!resolved.exists) await mkdir(resolved.absolute_path, { recursive: false, mode: 0o700 });
  return resolveOwnedDemoPath(rootHandle, relativePath, {
    mustExist: true,
    expectedType: 'directory',
  });
}

async function createRunWorkspace(rootHandle, runId) {
  await ensureDirectory(rootHandle, RUNS_DIRECTORY);
  const runRelative = `${RUNS_DIRECTORY}/${runId}`;
  const run = await ensureDirectory(rootHandle, runRelative);
  const source = await ensureDirectory(rootHandle, `${runRelative}/source`);
  const parent = await ensureDirectory(rootHandle, `${runRelative}/parent`);
  const adapter = await ensureDirectory(rootHandle, `${runRelative}/adapter`);
  return {
    run_relative: run.relative_path,
    source_absolute: source.absolute_path,
    parent_absolute: parent.absolute_path,
    adapter_absolute: adapter.absolute_path,
  };
}

async function removeExactRunAfterSetupFailure(rootHandle, runId) {
  const runRelative = `${RUNS_DIRECTORY}/${runId}`;
  const runs = await resolveOwnedDemoPath(rootHandle, RUNS_DIRECTORY);
  if (!runs.exists || runs.type === 'file') {
    const verifiedParent = await resolveOwnedDemoPath(rootHandle, RUNS_DIRECTORY);
    if (verifiedParent.exists !== runs.exists || verifiedParent.type !== runs.type) {
      throw lockError('DEMO_CLEANUP_UNKNOWN', 'Owned runs parent changed during setup cleanup');
    }
    return Object.freeze({
      status: 'verified_absent',
      relative_path: runRelative,
      removed: false,
    });
  }
  return removeOwnedDemoEntry(rootHandle, runRelative);
}

function lockError(code, message) {
  return Object.assign(new Error(message), { code });
}

function exactObjectKeys(value, keys) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  return actual.length === expected.length
    && actual.every((key, index) => key === expected[index]);
}

function exactIso(value) {
  if (typeof value !== 'string') return false;
  try {
    return new Date(value).toISOString() === value;
  } catch {
    return false;
  }
}

function lockHash(record) {
  return sha256Ref({ ...record, lock_hash: null });
}

function clockDate(clock) {
  const value = clock();
  const date = value instanceof Date ? new Date(value.getTime()) : new Date(value);
  if (!Number.isFinite(date.getTime())) throw lockError('DEMO_LOCK_CLOCK_INVALID', 'Demo lock clock returned an invalid time');
  return date;
}

function createActiveLockRecord(rootHandle, runId, clock) {
  if (!RUN_ID_PATTERN.test(runId)) throw lockError('DEMO_ACTIVE_LOCK_INVALID', 'Demo run identifier is invalid');
  const base = {
    schema: ACTIVE_LOCK_SCHEMA,
    root_id: rootHandle.root_id,
    lock_id: `lock_${randomBytes(16).toString('hex')}`,
    run_id: runId,
    pid: process.pid,
    created_at: clockDate(clock).toISOString(),
    lock_hash: null,
  };
  return Object.freeze({ ...base, lock_hash: lockHash(base) });
}

function createRecoveryLockRecord(rootHandle, clock) {
  const base = {
    schema: RECOVERY_LOCK_SCHEMA,
    root_id: rootHandle.root_id,
    recovery_id: `recovery_${randomBytes(16).toString('hex')}`,
    pid: process.pid,
    created_at: clockDate(clock).toISOString(),
    lock_hash: null,
  };
  return Object.freeze({ ...base, lock_hash: lockHash(base) });
}

function validateLockRecord(record, rootHandle, kind) {
  const active = kind === 'active';
  const keys = active ? ACTIVE_LOCK_KEYS : RECOVERY_LOCK_KEYS;
  const schema = active ? ACTIVE_LOCK_SCHEMA : RECOVERY_LOCK_SCHEMA;
  const idValid = active
    ? LOCK_ID_PATTERN.test(record?.lock_id ?? '') && RUN_ID_PATTERN.test(record?.run_id ?? '')
    : RECOVERY_ID_PATTERN.test(record?.recovery_id ?? '');
  if (!exactObjectKeys(record, keys)
    || record.schema !== schema
    || record.root_id !== rootHandle.root_id
    || !idValid
    || !Number.isSafeInteger(record.pid)
    || record.pid < 1
    || record.pid > 0x7fffffff
    || !exactIso(record.created_at)
    || typeof record.lock_hash !== 'string'
    || !SHA256_REFERENCE_PATTERN.test(record.lock_hash)
    || record.lock_hash !== lockHash(record)) {
    throw lockError(
      active ? 'DEMO_ACTIVE_LOCK_INVALID' : 'DEMO_RECOVERY_LOCK_INVALID',
      `Demo ${kind} lock failed its exact marker-bound contract`,
    );
  }
  return record;
}

async function readOwnedLock(rootHandle, relativePath, kind) {
  const resolved = await resolveOwnedDemoPath(rootHandle, relativePath, {
    mustExist: true,
    expectedType: 'file',
  });
  const bytes = await readFile(resolved.absolute_path);
  if (bytes.byteLength < 2 || bytes.byteLength > MAX_LOCK_BYTES) {
    throw lockError(
      kind === 'active' ? 'DEMO_ACTIVE_LOCK_INVALID' : 'DEMO_RECOVERY_LOCK_INVALID',
      `Demo ${kind} lock exceeds its closed size contract`,
    );
  }
  let record;
  try {
    record = JSON.parse(bytes.toString('utf8'));
  } catch {
    throw lockError(
      kind === 'active' ? 'DEMO_ACTIVE_LOCK_INVALID' : 'DEMO_RECOVERY_LOCK_INVALID',
      `Demo ${kind} lock is not valid JSON`,
    );
  }
  return { resolved, bytes, record: validateLockRecord(record, rootHandle, kind) };
}

async function createExclusiveOwnedLock(rootHandle, relativePath, record, kind, existsCode) {
  const resolved = await resolveOwnedDemoPath(rootHandle, relativePath);
  const bytes = Buffer.from(`${JSON.stringify(record)}\n`, 'utf8');
  if (bytes.byteLength > MAX_LOCK_BYTES) throw lockError('DEMO_LOCK_INVALID', 'Demo lock exceeds its closed size contract');
  let handle;
  try {
    handle = await open(resolved.absolute_path, 'wx', 0o600);
    await handle.writeFile(bytes);
    await handle.sync();
  } catch (error) {
    await handle?.close().catch(() => {});
    if (error?.code === 'EEXIST') throw lockError(existsCode, `Demo ${kind} lock is already held`);
    throw error;
  }
  let handleClosed = false;
  let released = false;
  const closeHandle = async () => {
    if (handleClosed) return;
    await handle.close();
    handleClosed = true;
  };
  return {
    record,
    bytes,
    async release() {
      if (released) return { status: 'verified_absent', removed: false };
      let current;
      try {
        current = await readOwnedLock(rootHandle, relativePath, kind);
        if (!current.bytes.equals(bytes) || current.record.lock_hash !== record.lock_hash) {
          throw lockError('DEMO_LOCK_RACE', `Demo ${kind} lock changed before release`);
        }
      } catch (error) {
        try {
          await closeHandle();
        } catch {
          throw lockError('DEMO_LOCK_RELEASE_UNKNOWN', `Demo ${kind} lock handle could not be closed`);
        }
        throw error;
      }
      await closeHandle();
      const removed = await removeOwnedDemoEntry(rootHandle, relativePath);
      if ((await resolveOwnedDemoPath(rootHandle, relativePath)).exists) {
        throw lockError('DEMO_LOCK_RELEASE_UNKNOWN', `Demo ${kind} lock absence was not verified`);
      }
      released = true;
      return removed;
    },
  };
}

async function releaseAndVerifyRunLock(rootHandle, lock) {
  let failure = null;
  try {
    await lock.release();
  } catch (error) {
    failure = error;
  }
  let absent = false;
  try {
    absent = !(await resolveOwnedDemoPath(rootHandle, ACTIVE_LOCK)).exists;
  } catch (error) {
    failure ??= error;
  }
  return Object.freeze({
    status: absent ? 'verified_absent' : 'unknown',
    removed: absent,
    failure,
  });
}

async function acquireRecoveryLock(rootHandle, { clock = SYSTEM_CLOCK } = {}) {
  return createExclusiveOwnedLock(
    rootHandle,
    RECOVERY_LOCK,
    createRecoveryLockRecord(rootHandle, clock),
    'recovery',
    'DEMO_RECOVERY_IN_PROGRESS',
  );
}

function defaultOwnerLiveness(pid) {
  try {
    process.kill(pid, 0);
    return 'live';
  } catch (error) {
    if (error?.code === 'ESRCH') return 'dead';
    if (error?.code === 'EPERM') return 'live';
    return 'indeterminate';
  }
}

function quarantineIdentity(info) {
  return sha256Ref({
    device: String(info.dev),
    inode: String(info.ino),
    mode: info.mode,
    links: info.nlink,
    size: info.size,
    modified_ms: info.mtimeMs,
    changed_ms: info.ctimeMs,
    created_ms: info.birthtimeMs,
  });
}

function quarantineFailure(code, message) {
  return lockError(code, message);
}

function preserveQuarantineFailure(error) {
  if (error?.code === 'DEMO_RECOVERY_QUARANTINE_NOT_EMPTY'
    || error?.code === 'DEMO_RECOVERY_QUARANTINE_CHANGED'
    || error?.code === 'DEMO_RECOVERY_QUARANTINE_UNKNOWN') {
    return error;
  }
  if (error?.code === 'ENOENT' || error?.code === 'DEMO_PATH_MISSING') {
    return quarantineFailure(
      'DEMO_RECOVERY_QUARANTINE_CHANGED',
      'Demo recovery quarantine changed while admission was being verified',
    );
  }
  return quarantineFailure(
    'DEMO_RECOVERY_QUARANTINE_UNKNOWN',
    'Demo recovery quarantine could not be verified safely',
  );
}

async function captureEmptyQuarantine(rootHandle) {
  try {
    const first = await resolveOwnedDemoPath(rootHandle, RECOVERY_QUARANTINE_DIRECTORY, {
      expectedType: 'directory',
    });
    if (!first.exists) {
      const second = await resolveOwnedDemoPath(rootHandle, RECOVERY_QUARANTINE_DIRECTORY, {
        expectedType: 'directory',
      });
      if (second.exists) {
        throw quarantineFailure(
          'DEMO_RECOVERY_QUARANTINE_CHANGED',
          'Demo recovery quarantine changed while admission was being verified',
        );
      }
      return Object.freeze({ resolved: second, exists: false, identity_hash: null });
    }

    const before = await lstat(first.absolute_path);
    const beforeIdentity = quarantineIdentity(before);
    const directory = await opendir(first.absolute_path);
    try {
      if (await directory.read()) {
        throw quarantineFailure(
          'DEMO_RECOVERY_QUARANTINE_NOT_EMPTY',
          'Demo recovery quarantine contains unresolved evidence',
        );
      }
    } finally {
      await directory.close().catch((error) => {
        if (error?.code !== 'ERR_DIR_CLOSED') throw error;
      });
    }
    const second = await resolveOwnedDemoPath(rootHandle, RECOVERY_QUARANTINE_DIRECTORY, {
      mustExist: true,
      expectedType: 'directory',
    });
    const after = await lstat(second.absolute_path);
    const afterIdentity = quarantineIdentity(after);
    if (beforeIdentity !== afterIdentity) {
      throw quarantineFailure(
        'DEMO_RECOVERY_QUARANTINE_CHANGED',
        'Demo recovery quarantine changed while admission was being verified',
      );
    }
    return Object.freeze({ resolved: second, exists: true, identity_hash: afterIdentity });
  } catch (error) {
    throw preserveQuarantineFailure(error);
  }
}

function sameQuarantineSnapshot(left, right) {
  return left.exists === right.exists && left.identity_hash === right.identity_hash;
}

async function requireEmptyQuarantine(rootHandle) {
  return (await captureEmptyQuarantine(rootHandle)).resolved;
}

async function acquireRunLock(rootHandle, runId, controls = {}) {
  let recoveryLock;
  let activeLock;
  let cleanupFailure = null;
  try {
    // Admission and cleanup share one lock order: recovery first, then active.
    // This prevents cleanup from mutating quarantine between the two snapshots.
    recoveryLock = await acquireRecoveryLock(rootHandle, controls);
    const initialQuarantine = await captureEmptyQuarantine(rootHandle);
    await inspectOwnedDemoTree(rootHandle, {
      maxFiles: 10_000,
      maxBytes: RISK_FORK_DEMO_LIMITS.max_root_bytes,
    });
    activeLock = await createExclusiveOwnedLock(
      rootHandle,
      ACTIVE_LOCK,
      createActiveLockRecord(rootHandle, runId, controls.clock ?? SYSTEM_CLOCK),
      'active',
      'DEMO_CONCURRENCY_LIMIT',
    );
    const verifiedQuarantine = await captureEmptyQuarantine(rootHandle);
    if (!sameQuarantineSnapshot(initialQuarantine, verifiedQuarantine)) {
      throw quarantineFailure(
        'DEMO_RECOVERY_QUARANTINE_CHANGED',
        'Demo recovery quarantine changed while admission was being verified',
      );
    }
    await recoveryLock.release();
    recoveryLock = null;
    return activeLock;
  } catch (error) {
    if (activeLock) {
      try {
        await activeLock.release();
      } catch (releaseError) {
        cleanupFailure = releaseError;
      }
    }
    if (recoveryLock) {
      try {
        await recoveryLock.release();
      } catch (releaseError) {
        cleanupFailure ??= releaseError;
      }
    }
    if (cleanupFailure) {
      throw lockError(
        'DEMO_ADMISSION_CLEANUP_UNKNOWN',
        'Demo admission failed and its lock cleanup could not be verified',
      );
    }
    throw error;
  }
}

async function removeEmptyQuarantine(rootHandle) {
  const directory = await requireEmptyQuarantine(rootHandle);
  if (directory.exists) await removeOwnedDemoEntry(rootHandle, RECOVERY_QUARANTINE_DIRECTORY);
  if ((await resolveOwnedDemoPath(rootHandle, RECOVERY_QUARANTINE_DIRECTORY)).exists) {
    throw lockError('DEMO_RECOVERY_QUARANTINE_UNKNOWN', 'Demo recovery quarantine absence was not verified');
  }
}

async function recoverStaleActiveLock(rootHandle, recoveryLock, controls) {
  await requireEmptyQuarantine(rootHandle);
  const activePath = await resolveOwnedDemoPath(rootHandle, ACTIVE_LOCK);
  if (!activePath.exists) return null;
  const initial = await readOwnedLock(rootHandle, ACTIVE_LOCK, 'active');

  let liveness = 'indeterminate';
  try {
    liveness = await controls.ownerLiveness(initial.record.pid);
  } catch {
    liveness = 'indeterminate';
  }
  if (liveness === 'live') {
    throw lockError('DEMO_ACTIVE_LOCK_LIVE', 'Demo active lock owner is still live');
  }
  if (liveness !== 'dead') {
    throw lockError('DEMO_ACTIVE_LOCK_LIVENESS_UNKNOWN', 'Demo active lock owner liveness is indeterminate');
  }

  const ageMs = clockDate(controls.clock).getTime() - new Date(initial.record.created_at).getTime();
  if (ageMs < controls.staleLockGraceMs) {
    throw lockError('DEMO_ACTIVE_LOCK_YOUNG', 'Demo active lock has not passed the recovery grace period');
  }

  const current = await readOwnedLock(rootHandle, ACTIVE_LOCK, 'active');
  if (!current.bytes.equals(initial.bytes)
    || current.record.lock_hash !== initial.record.lock_hash
    || current.record.lock_id !== initial.record.lock_id
    || current.record.run_id !== initial.record.run_id) {
    throw lockError('DEMO_ACTIVE_LOCK_RACE', 'Demo active lock changed during recovery');
  }

  await ensureDirectory(rootHandle, RECOVERY_QUARANTINE_DIRECTORY);
  await requireEmptyQuarantine(rootHandle);
  const quarantineRelative = `${RECOVERY_QUARANTINE_DIRECTORY}/${recoveryLock.record.recovery_id}-${initial.record.lock_id}.json`;
  const quarantine = await resolveOwnedDemoPath(rootHandle, quarantineRelative);
  if (quarantine.exists) {
    throw lockError('DEMO_ACTIVE_LOCK_RACE', 'Demo recovery quarantine target already exists');
  }
  await rename(current.resolved.absolute_path, quarantine.absolute_path);

  const moved = await readOwnedLock(rootHandle, quarantineRelative, 'active');
  if (!moved.bytes.equals(initial.bytes)
    || moved.record.lock_hash !== initial.record.lock_hash
    || (await resolveOwnedDemoPath(rootHandle, ACTIVE_LOCK)).exists) {
    throw lockError('DEMO_ACTIVE_LOCK_RACE', 'Demo active lock quarantine verification failed');
  }
  return Object.freeze({
    run_id: moved.record.run_id,
    lock_id: moved.record.lock_id,
    quarantine_relative: quarantineRelative,
  });
}

async function verifyOwnedAbsence(rootHandle, relativePath, label) {
  if ((await resolveOwnedDemoPath(rootHandle, relativePath)).exists) {
    throw lockError('DEMO_CLEANUP_UNKNOWN', `${label} absence was not verified`);
  }
  return 'verified_absent';
}

async function cleanupRecoveredRun(rootHandle, recovery) {
  const runRelative = `${RUNS_DIRECTORY}/${recovery.run_id}`;
  const forksRelative = `${runRelative}/adapter/forks`;
  const savepointsRelative = `${runRelative}/adapter/savepoints`;
  await removeOwnedDemoEntry(rootHandle, forksRelative);
  await removeOwnedDemoEntry(rootHandle, savepointsRelative);
  await removeOwnedDemoEntry(rootHandle, runRelative);
  for (const relative of ['records', 'configs', STATE_FILE]) {
    await removeOwnedDemoEntry(rootHandle, relative);
  }
  await removeOwnedDemoEntry(rootHandle, recovery.quarantine_relative);
  await removeEmptyQuarantine(rootHandle);
  return Object.freeze({
    active_lock: await verifyOwnedAbsence(rootHandle, ACTIVE_LOCK, 'Active lock'),
    quarantine: await verifyOwnedAbsence(
      rootHandle,
      recovery.quarantine_relative,
      'Recovery quarantine entry',
    ),
    run: await verifyOwnedAbsence(rootHandle, runRelative, 'Recovered run'),
    fork: await verifyOwnedAbsence(rootHandle, forksRelative, 'Recovered fork'),
    savepoint: await verifyOwnedAbsence(rootHandle, savepointsRelative, 'Recovered savepoint'),
    records: await verifyOwnedAbsence(rootHandle, 'records', 'Recorder artifacts'),
    state: await verifyOwnedAbsence(rootHandle, STATE_FILE, 'Run state'),
    configs: await verifyOwnedAbsence(rootHandle, 'configs', 'Generated configuration'),
  });
}

async function cleanupWithoutActiveRun(rootHandle) {
  for (const relative of [RUNS_DIRECTORY, 'records', 'configs', STATE_FILE]) {
    await removeOwnedDemoEntry(rootHandle, relative);
  }
  await removeEmptyQuarantine(rootHandle);
  return Object.freeze({
    active_lock: await verifyOwnedAbsence(rootHandle, ACTIVE_LOCK, 'Active lock'),
    quarantine: await verifyOwnedAbsence(
      rootHandle,
      RECOVERY_QUARANTINE_DIRECTORY,
      'Recovery quarantine',
    ),
    run: await verifyOwnedAbsence(rootHandle, RUNS_DIRECTORY, 'Owned runs'),
    fork: 'verified_absent',
    savepoint: 'verified_absent',
    records: await verifyOwnedAbsence(rootHandle, 'records', 'Recorder artifacts'),
    state: await verifyOwnedAbsence(rootHandle, STATE_FILE, 'Run state'),
    configs: await verifyOwnedAbsence(rootHandle, 'configs', 'Generated configuration'),
  });
}

async function readCompletedRuns(rootHandle) {
  const resolved = await resolveOwnedDemoPath(rootHandle, STATE_FILE);
  if (!resolved.exists) return 0;
  const bytes = await readFile(resolved.absolute_path);
  if (bytes.byteLength > 4 * 1024) throw new Error('Demo run state exceeds its closed size limit');
  const state = JSON.parse(bytes.toString('utf8'));
  if (state?.schema !== DEMO_STATE_SCHEMA
    || !Number.isSafeInteger(state.completed_runs)
    || state.completed_runs < 0
    || state.completed_runs > RISK_FORK_DEMO_LIMITS.max_completed_runs_before_reset) {
    throw new Error('Demo run state failed its closed contract');
  }
  return state.completed_runs;
}

async function writeCompletedRuns(rootHandle, completedRuns) {
  if (!Number.isSafeInteger(completedRuns)
    || completedRuns < 0
    || completedRuns > RISK_FORK_DEMO_LIMITS.max_completed_runs_before_reset) {
    throw new Error('Refusing to write an invalid demo run count');
  }
  const resolved = await resolveOwnedDemoPath(rootHandle, STATE_FILE);
  const state = {
    schema: DEMO_STATE_SCHEMA,
    completed_runs: completedRuns,
  };
  await writeFile(resolved.absolute_path, `${JSON.stringify(state)}\n`, {
    encoding: 'utf8',
    mode: 0o600,
  });
}

function observerSummary(adapter) {
  const records = adapter.observations();
  const forkRecord = records.find((record) => (
    record.stage === 'fork_requested' || record.stage === 'allocation_requested'
  ));
  const executionRecord = records.find((record) => record.stage === 'execution_requested');
  const taintRecord = records.find((record) => record.stage === 'tainted_result_produced');
  return {
    records,
    fork_identity_hash: forkRecord?.fork_identity_hash ?? forkRecord?.identity_hash ?? null,
    execution_mode: executionRecord?.execution_mode ?? 'not_executed',
    taint_status: taintRecord?.taint_status ?? 'not_produced',
    tainted_output_evidence: taintedOutputEvidence(taintRecord?.result_hash ?? null),
  };
}

function prepareInputForScenario({ scenario, capsule, sourceWorkspace }) {
  const expectedCommitType = scenario.expected_commit_type;
  const fakeE2B = scenario.provider_profile === 'fake-e2b';
  return {
    risk_input: scenario.risk_input,
    capsule,
    savepoint_input: { source_workspace: sourceWorkspace },
    operation: validateDemoOperation(normalizedScenarioOperation(scenario)),
    effective_arguments: scenarioEffectiveArguments(scenario),
    expected_commit_type: expectedCommitType,
    commit_policy: expectedCommitType === 'TYPED_RESULT'
      ? {
          typed_result_schema_hash: capsule.authorized_result_schema_hash,
          max_typed_result_bytes: RISK_FORK_DEMO_LIMITS.max_write_bytes,
          max_string_bytes: RISK_FORK_DEMO_LIMITS.max_write_bytes,
          max_nodes: 10_000,
        }
      : {},
    ...(expectedCommitType === 'CONSEQUENTIAL_ACTION_PROPOSAL'
      ? {
          createExecutionBinding: createExecutionBindingFactory(scenario, {
            stale: scenario.kind === 'stale_binding',
          }),
        }
      : {}),
    fork_ttl_ms: fakeE2B
      ? FAKE_E2B_DEMO_PROFILE.sandbox_timeout_ms
      : RISK_FORK_DEMO_LIMITS.fork_ttl_ms,
    ...(!fakeE2B ? { idle_ttl_ms: RISK_FORK_DEMO_LIMITS.fork_ttl_ms } : {}),
    max_execution_ms: RISK_FORK_DEMO_LIMITS.execution_timeout_ms,
    network_policy: { mode: 'blocked' },
    force_optional_fork: false,
  };
}

async function executeControllerScenario({ scenario, plan, runId, workspace, runtime }) {
  const component = baseComponent({ scenario, plan, runId });
  const fakeE2B = scenario.provider_profile === 'fake-e2b';
  let parentBefore = null;
  if (fakeE2B) {
    await writeFile(
      path.join(workspace.parent_absolute, MALICIOUS_MCP_PARENT_CREDENTIAL_REF),
      'synthetic parent-only canary; never exported to the child\n',
      { encoding: 'utf8', mode: 0o600, flag: 'wx' },
    );
    await writeFile(
      path.join(workspace.source_absolute, 'sanitized-task.txt'),
      'bounded synthetic malicious-MCP containment task\n',
      { encoding: 'utf8', mode: 0o600, flag: 'wx' },
    );
    parentBefore = await inspectLocalWorkspace({
      source_workspace: workspace.parent_absolute,
      max_files: RISK_FORK_DEMO_LIMITS.max_workspace_files,
      max_bytes: RISK_FORK_DEMO_LIMITS.max_workspace_bytes,
    });
    component.parent_state_hash_before = parentBefore.workspace_digest;
  }
  const workspaceInfo = await inspectLocalWorkspace({
    source_workspace: workspace.source_absolute,
    max_files: RISK_FORK_DEMO_LIMITS.max_workspace_files,
    max_bytes: RISK_FORK_DEMO_LIMITS.max_workspace_bytes,
  });
  const capsule = createScenarioCapsule(scenario, workspaceInfo.workspace_digest, {
    ...(parentBefore ? { parent_state_hash: parentBefore.workspace_digest } : {}),
  });
  component.parent_state_hash = capsule.parent.state_hash;
  component.savepoint_capsule_hash = capsule.capsule_hash;
  const adapter = fakeE2B
    ? new HackathonFakeE2BAdapter({
        baseDirectory: workspace.adapter_absolute,
        maxFiles: RISK_FORK_DEMO_LIMITS.max_workspace_files,
        maxBytes: RISK_FORK_DEMO_LIMITS.max_workspace_bytes,
        clock: STATIC_CLOCK,
      })
    : new DemoObservingLocalAdapter({
        baseDirectory: workspace.adapter_absolute,
        maxFiles: RISK_FORK_DEMO_LIMITS.max_workspace_files,
        maxBytes: RISK_FORK_DEMO_LIMITS.max_workspace_bytes,
        clock: STATIC_CLOCK,
        observationClock: STATIC_CLOCK,
        verifyAuthorityFreeSource: createAuthorityFreeSourceVerifier,
        cleanupUnknown: scenario.kind === 'cleanup_unknown',
      });
  runtime.adapter = adapter;
  const controller = new RiskForkController({
    provider: adapter,
    mode: 'demonstration',
    clock: STATIC_CLOCK,
    trustedServerVerifier: demoTrustedServerVerifier,
  });
  try {
    const prepared = await controller.prepare(prepareInputForScenario({
      scenario,
      capsule,
      sourceWorkspace: workspace.source_absolute,
    }));
    const observer = observerSummary(adapter);
    component.observer_records = observer.records;
    component.local_adapter_calls = observer.records.length;
    component.fork_identity_hash = observer.fork_identity_hash;
    component.execution_mode = observer.execution_mode;
    component.taint_status = observer.taint_status;
    component.tainted_output_evidence = observer.tainted_output_evidence;
    if (fakeE2B) {
      const providerEvidence = adapter.providerEvidence();
      component.provider_evidence = providerEvidence;
      component.simulated_sdk_events = providerEvidence.events.length;
      component.sandbox_id = providerEvidence.sandbox_id;
    }
    if (prepared.mode === 'denied') {
      component.final_state = 'denied';
      component.exit_code = 0;
      component.validation_status = 'policy_denied_before_execution';
      return component;
    }
    if (prepared.mode === 'direct_permitted') {
      component.final_state = 'direct_permitted';
      component.exit_code = 0;
      component.validation_status = 'direct_route_not_executed_by_demo';
      return component;
    }
    if (prepared.mode === 'fork_optional') {
      component.final_state = 'fork_optional';
      component.exit_code = 0;
      component.validation_status = 'owner_policy_decision_required';
      return component;
    }
    if (prepared.mode !== 'prepared_for_clean_commit') {
      throw new Error('Controller returned an unsupported demonstration mode');
    }
    const { receipt: coreReceipt, verified: coreReceiptVerified } = createCoreReceipt(prepared);
    component.savepoint_status = 'verified_destroyed';
    component.fork_identity_hash = prepared.fork_identity.identity_hash;
    component.execution_mode = prepared.risk_decision.level === 'IRREVERSIBLE'
      ? 'prepare_only'
      : fakeE2B
        ? DEMO_FAKE_E2B_EXECUTION_MODE
        : DEMO_LOCAL_EXECUTION_MODE;
    component.taint_status = prepared.artifact.taint_status;
    const taintedEvent = prepared.lifecycle.events.find((event) => event.to === 'TAINTED');
    component.tainted_output_evidence = taintedOutputEvidence(
      observer.tainted_output_evidence.evidence_hash ?? taintedEvent?.evidence?.hash ?? null,
    );
    if (component.tainted_output_evidence.status !== 'sanitized_hash_only') {
      throw new Error('Prepared demo result is missing bounded tainted-output evidence');
    }
    component.validation_status = 'verified';
    component.lifecycle = lifecycleSummary(prepared.lifecycle);
    component.cleanup = { requested: true, absence: 'verified', status: 'verified' };
    component.final_state = 'prepared_not_committed';
    component.exit_code = 0;
    component.core_receipt = coreReceipt;
    component.core_receipt_verified = coreReceiptVerified;
    component.risk_decision = prepared.risk_decision;
    component.interception_plan = plan;
    component.prepared_artifact = {
      type: prepared.artifact.commit_type,
      artifact_hash: prepared.artifact.artifact_hash,
      clean_commit_required: prepared.artifact.authority_flags.clean_commit_required,
    };
    if (fakeE2B) {
      const parentAfter = await inspectLocalWorkspace({
        source_workspace: workspace.parent_absolute,
        max_files: RISK_FORK_DEMO_LIMITS.max_workspace_files,
        max_bytes: RISK_FORK_DEMO_LIMITS.max_workspace_bytes,
      });
      component.parent_state_hash_after = parentAfter.workspace_digest;
      component.parent_state_unchanged = parentAfter.workspace_digest === parentBefore.workspace_digest;
      if (!component.parent_state_unchanged) {
        throw new Error('Synthetic parent fixture changed during fake E2B execution');
      }
      const providerEvidence = adapter.providerEvidence();
      component.provider_evidence = providerEvidence;
      component.simulated_sdk_events = providerEvidence.events.length;
      component.sandbox_id = providerEvidence.sandbox_id;
      component.attack_attempts = providerEvidence.attack_attempts;
      component.accepted_typed_result = structuredClone(
        prepared.artifact.body.payload,
      );
      component.cost = {
        ...structuredClone(FAKE_E2B_DEMO_PROFILE.compute),
        observed_elapsed_ms: Math.round(Object.values(prepared.measurements)
          .filter((value) => Number.isFinite(value))
          .reduce((sum, value) => sum + value, 0)),
        estimate_kind: 'prompt_pinned_demo_estimate_not_a_bill_or_provider_receipt',
      };
    }

    if (scenario.kind === 'tamper') {
      const tamperedLifecycle = structuredClone(prepared.lifecycle);
      tamperedLifecycle.chain_head = sha256Ref('synthetic-tampered-lifecycle-head');
      let lifecycleHashRejected = false;
      try {
        verifyLifecycle(tamperedLifecycle);
      } catch {
        lifecycleHashRejected = true;
      }
      const tamperedReceipt = structuredClone(coreReceipt);
      tamperedReceipt.receipt_hash = sha256Ref('synthetic-tampered-receipt-hash');
      let receiptHashRejected = false;
      try {
        verifyRiskForkReceipt(tamperedReceipt, {
          risk_decision: prepared.risk_decision,
          trusted_server_verifier: demoTrustedServerVerifier,
        });
      } catch {
        receiptHashRejected = true;
      }
      if (!lifecycleHashRejected || !receiptHashRejected) {
        throw new Error('Malformed lifecycle or receipt was not rejected');
      }
      component.tamper_checks = {
        lifecycle_hash_rejected: lifecycleHashRejected,
        receipt_hash_rejected: receiptHashRejected,
      };
      component.validation_status = 'tamper_rejected';
      component.final_state = 'blocked';
      component.exit_code = 2;
    }
    return component;
  } catch (error) {
    const observer = observerSummary(adapter);
    const failure = cleanupFromPreparationError(error, observer.records);
    component.observer_records = observer.records;
    component.local_adapter_calls = observer.records.length;
    component.fork_identity_hash = observer.fork_identity_hash;
    component.execution_mode = demoFacingExecutionMode(observer.execution_mode);
    component.taint_status = observer.taint_status;
    component.tainted_output_evidence = observer.tainted_output_evidence;
    if (fakeE2B) {
      const providerEvidence = adapter.providerEvidence();
      component.provider_evidence = providerEvidence;
      component.simulated_sdk_events = providerEvidence.events.length;
      component.sandbox_id = providerEvidence.sandbox_id;
      component.attack_attempts = providerEvidence.attack_attempts;
      const parentAfter = await inspectLocalWorkspace({
        source_workspace: workspace.parent_absolute,
        max_files: RISK_FORK_DEMO_LIMITS.max_workspace_files,
        max_bytes: RISK_FORK_DEMO_LIMITS.max_workspace_bytes,
      });
      component.parent_state_hash_after = parentAfter.workspace_digest;
      component.parent_state_unchanged = parentAfter.workspace_digest === parentBefore.workspace_digest;
    }
    component.lifecycle = lifecycleSummary(failure.lifecycle);
    component.cleanup = failure.cleanup;
    component.savepoint_status = observer.records.some((record) => (
      record.stage === 'savepoint_ready'
    )) ? 'allocated_then_destroyed' : 'not_allocated';
    component.validation_status = scenario.kind === 'stale_binding'
      ? 'stale_binding_rejected'
      : scenario.kind === 'cleanup_unknown'
        ? 'readiness_blocked_by_cleanup'
        : 'failed_closed';
    component.final_state = 'blocked';
    component.exit_code = 2;
    component.failure = sanitizeDemoError(error, {
      code: scenario.kind === 'stale_binding'
        ? 'DEMO_STALE_BINDING_REJECTED'
        : scenario.kind === 'cleanup_unknown'
          ? 'DEMO_CLEANUP_UNKNOWN'
          : 'DEMO_PREPARATION_FAILED',
    });
    return component;
  }
}

function maliciousAttackOperation(attack) {
  if (attack === 'traversal') {
    return {
      kind: 'bounded_file_batch',
      actions: [{ type: 'write', path: '../escape.txt', content: 'synthetic\n' }],
      commit_candidate: {
        type: 'TYPED_RESULT',
        payload: { summary: 'synthetic', fixture_id: 'attack-traversal' },
        payload_schema: TYPED_RESULT_SCHEMA,
      },
    };
  }
  if (attack === 'secret') {
    const secretField = ['api', 'key'].join('_');
    const secretValue = ['synthetic', 'secret', 'material', '1234567890'].join('_');
    return {
      kind: 'bounded_file_batch',
      actions: [],
      commit_candidate: {
        type: 'TYPED_RESULT',
        payload: {
          fixture_id: 'attack-secret',
          [secretField]: secretValue,
        },
        payload_schema: TYPED_RESULT_SCHEMA,
      },
    };
  }
  if (attack === 'oversized') {
    return {
      kind: 'bounded_file_batch',
      actions: [{
        type: 'write',
        path: 'oversized.txt',
        content: 'x'.repeat(RISK_FORK_DEMO_LIMITS.max_write_bytes + 1),
      }],
      commit_candidate: {
        type: 'TYPED_RESULT',
        payload: { summary: 'synthetic', fixture_id: 'attack-oversized-write' },
        payload_schema: TYPED_RESULT_SCHEMA,
      },
    };
  }
  throw new Error(`Unsupported synthetic attack operation: ${attack}`);
}

function manualAdvance(lifecycle, to, input = {}) {
  const evidence = input.evidence ?? {
    status: 'observed',
    ref: null,
    hash: null,
    detail: `demo_${to.toLowerCase()}`,
  };
  return transitionLifecycle(lifecycle, {
    actor: 'clean_controller',
    expected_version: lifecycle.version,
    expected_chain_head: lifecycle.chain_head,
    to,
    at: DEMO_NOW,
    reason: `demo_${to.toLowerCase()}`,
    evidence,
    ...(input.fork_resource_state
      ? { fork_resource_state: input.fork_resource_state }
      : {}),
  });
}

function neverCompletingOperationRunner() {
  let rejectResult;
  let settled = false;
  const result = new Promise((_resolve, reject) => { rejectResult = reject; });
  return {
    result,
    async terminate(reason) {
      if (settled) return;
      settled = true;
      rejectResult(reason instanceof Error ? reason : new Error('Synthetic timeout terminated'));
      await result.catch(() => {});
    },
  };
}

async function executeTimeoutAttack({ scenario, plan, runId, workspace, runtime }) {
  const component = baseComponent({ scenario, plan, runId });
  const adapter = new DemoObservingLocalAdapter({
    baseDirectory: workspace.adapter_absolute,
    maxFiles: RISK_FORK_DEMO_LIMITS.max_workspace_files,
    maxBytes: RISK_FORK_DEMO_LIMITS.max_workspace_bytes,
    clock: STATIC_CLOCK,
    observationClock: STATIC_CLOCK,
    verifyAuthorityFreeSource: createAuthorityFreeSourceVerifier,
    operationRunner: neverCompletingOperationRunner,
  });
  runtime.adapter = adapter;
  const workspaceInfo = await inspectLocalWorkspace({
    source_workspace: workspace.source_absolute,
    max_files: RISK_FORK_DEMO_LIMITS.max_workspace_files,
    max_bytes: RISK_FORK_DEMO_LIMITS.max_workspace_bytes,
  });
  const capsule = createScenarioCapsule(scenario, workspaceInfo.workspace_digest);
  component.parent_state_hash = capsule.parent.state_hash;
  let lifecycle = createLifecycle({
    run_id: `timeout-${runId}`,
    requested_at: DEMO_NOW,
    reason: 'demo_timeout_requested',
    actor: 'clean_controller',
  });
  let savepoint;
  let fork;
  try {
    lifecycle = manualAdvance(lifecycle, 'SAVEPOINTING');
    savepoint = await adapter.createSavepoint({
      source_workspace: workspace.source_absolute,
      capsule,
    });
    lifecycle = manualAdvance(lifecycle, 'SAVEPOINT_READY');
    const identity = createForkIdentity({
      parent_agent_id: capsule.parent.agent_id,
      parent_session_id: capsule.parent.session_id,
      issued_at: DEMO_NOW,
    });
    lifecycle = manualAdvance(lifecycle, 'FORK_STARTING');
    fork = await adapter.createFork({
      savepoint_ref: savepoint.savepoint_ref,
      fork_identity: identity,
      network_policy: networkPolicy({ mode: 'blocked' }),
      ttl_ms: RISK_FORK_DEMO_LIMITS.fork_ttl_ms,
    });
    lifecycle = manualAdvance(lifecycle, 'FORK_READY', { fork_resource_state: 'ACTIVE' });
    lifecycle = manualAdvance(lifecycle, 'EXECUTING');
    const attackTimeoutMs = 100;
    let timeoutRejected = false;
    try {
      await adapter.executeInFork({
        fork_ref: fork.fork_ref,
        operation: validateDemoOperation(scenario.operation),
        execution_mode: 'isolated_execution',
        timeout_ms: attackTimeoutMs,
      });
    } catch (error) {
      timeoutRejected = error?.code === 'LOCAL_REFERENCE_EXECUTION_TIMEOUT';
    }
    if (!timeoutRejected) throw new Error('Synthetic timeout operation was not rejected');
    lifecycle = manualAdvance(lifecycle, 'EXECUTION_FAILED', {
      evidence: {
        status: 'failed',
        ref: 'demo-timeout:execution',
        hash: sha256Ref('demo-timeout-execution'),
        detail: 'execution_timeout_verified',
      },
    });
    lifecycle = manualAdvance(lifecycle, 'DESTROYING', {
      fork_resource_state: 'DESTROY_REQUESTED',
    });
    await adapter.destroyFork({ fork_ref: fork.fork_ref, reason: 'demo_timeout_cleanup' });
    const forkAbsence = await adapter.verifyDestroyed({ fork_ref: fork.fork_ref });
    await adapter.destroySavepoint({ savepoint_ref: savepoint.savepoint_ref });
    const savepointAbsence = await adapter.verifySavepointDestroyed({
      savepoint_ref: savepoint.savepoint_ref,
    });
    const combinedHash = sha256Ref({
      fork: forkAbsence.evidence_hash,
      savepoint: savepointAbsence.evidence_hash,
    });
    lifecycle = manualAdvance(lifecycle, 'DESTROYED', {
      fork_resource_state: 'DESTROYED',
      evidence: {
        status: 'verified',
        ref: `demo-timeout-cleanup:${combinedHash.slice(7, 31)}`,
        hash: combinedHash,
        detail: 'timeout_resources_absent',
      },
    });
    verifyLifecycle(lifecycle);
    const observer = observerSummary(adapter);
    component.observer_records = observer.records;
    component.local_adapter_calls = observer.records.length;
    component.fork_identity_hash = identity.identity_hash;
    component.savepoint_status = 'allocated_then_destroyed';
    component.execution_mode = DEMO_LOCAL_EXECUTION_MODE;
    component.validation_status = 'timeout_rejected';
    component.lifecycle = lifecycleSummary(lifecycle);
    component.cleanup = { requested: true, absence: 'verified', status: 'verified' };
    component.final_state = 'blocked';
    component.exit_code = 2;
    component.attack_evidence = {
      attack: 'timeout',
      rejected: true,
      actual_timeout_ms: attackTimeoutMs,
      configured_max_execution_ms: RISK_FORK_DEMO_LIMITS.execution_timeout_ms,
    };
    return component;
  } finally {
    await adapter.dispose().catch(() => {});
  }
}

async function executeAttackScenario({
  scenario,
  plan,
  runId,
  workspace,
  rootHandle,
}) {
  if (scenario.attack === 'timeout') {
    throw new Error('Timeout attack requires its dedicated adapter path');
  }
  const component = baseComponent({ scenario, plan, runId });
  component.validation_status = `${scenario.attack}_rejected`;
  component.final_state = 'blocked';
  component.exit_code = 2;
  let rejected = false;
  let failure = null;
  if (['traversal', 'secret', 'oversized'].includes(scenario.attack)) {
    try {
      validateDemoOperation(maliciousAttackOperation(scenario.attack));
    } catch (error) {
      rejected = true;
      failure = sanitizeDemoError(error, { code: 'DEMO_ATTACK_INPUT_REJECTED' });
    }
  } else if (scenario.attack === 'link') {
    const first = await resolveOwnedDemoPath(
      rootHandle,
      `${workspace.run_relative}/source/link-source.txt`,
    );
    const second = await resolveOwnedDemoPath(
      rootHandle,
      `${workspace.run_relative}/source/link-alias.txt`,
    );
    await writeFile(first.absolute_path, 'synthetic hard-link probe\n', {
      encoding: 'utf8',
      flag: 'wx',
      mode: 0o600,
    });
    await link(first.absolute_path, second.absolute_path);
    try {
      await inspectLocalWorkspace({
        source_workspace: workspace.source_absolute,
        max_files: RISK_FORK_DEMO_LIMITS.max_workspace_files,
        max_bytes: RISK_FORK_DEMO_LIMITS.max_workspace_bytes,
      });
    } catch (error) {
      rejected = true;
      failure = sanitizeDemoError(error, { code: 'DEMO_LINK_REJECTED' });
    } finally {
      await unlink(second.absolute_path).catch(() => {});
    }
  } else if (scenario.attack === 'concurrency') {
    try {
      await acquireRunLock(rootHandle, `run_${randomBytes(12).toString('hex')}`);
    } catch (error) {
      rejected = error?.code === 'DEMO_CONCURRENCY_LIMIT';
      failure = sanitizeDemoError(error, { code: 'DEMO_CONCURRENCY_REJECTED' });
    }
  } else {
    throw new Error(`Unknown synthetic attack: ${scenario.attack}`);
  }
  if (!rejected) throw new Error(`Synthetic ${scenario.attack} attack was not rejected`);
  component.failure = failure;
  component.attack_evidence = {
    attack: scenario.attack,
    rejected: true,
    before_local_adapter: true,
  };
  return component;
}

async function createInternalPlan(scenario) {
  const riskDecision = classifyRisk(scenario.risk_input, {
    trusted_server_verifier: demoTrustedServerVerifier,
    clock: STATIC_CLOCK,
  });
  const plan = createMcpInterceptionPlan({
    risk_input: scenario.risk_input,
    trusted_server_verifier: demoTrustedServerVerifier,
  }, { clock: STATIC_CLOCK });
  if (riskDecision.decision_hash !== plan.risk_decision.decision_hash) {
    throw new Error('Classifier and interception plan decisions differ');
  }
  return plan;
}

async function executeScenario({
  scenario,
  plan,
  runId,
  workspace,
  rootHandle,
  runtime,
}) {
  if (scenario.kind !== 'attack') {
    return executeControllerScenario({ scenario, plan, runId, workspace, runtime });
  }
  if (scenario.attack === 'timeout') {
    return executeTimeoutAttack({ scenario, plan, runId, workspace, runtime });
  }
  return executeAttackScenario({ scenario, plan, runId, workspace, rootHandle });
}

function admissionBlockedComponent({
  scenario,
  plan,
  runId,
  code,
  message,
  cleanupUnknown = false,
}) {
  const component = baseComponent({ scenario, plan, runId });
  component.validation_status = 'admission_blocked';
  component.final_state = 'blocked';
  component.exit_code = 2;
  component.failure = { status: 'failed', code, message };
  if (cleanupUnknown) {
    component.cleanup = { requested: false, absence: 'unknown', status: 'unknown' };
  }
  return component;
}

function sanitizedAdmissionFailure(error) {
  const candidate = typeof error?.code === 'string' ? error.code : '';
  const code = /^DEMO_[A-Z0-9_]{1,74}$/.test(candidate)
    ? candidate
    : 'DEMO_ADMISSION_UNKNOWN';
  const sanitized = code === 'DEMO_ADMISSION_UNKNOWN'
    ? { code, message: 'Demo run admission could not be verified safely' }
    : sanitizeDemoError(error, { code });
  return Object.freeze({
    code: sanitized.code,
    message: sanitized.message,
    cleanup_unknown: code === 'DEMO_RECOVERY_IN_PROGRESS'
      || code === 'DEMO_ADMISSION_CLEANUP_UNKNOWN'
      || code.startsWith('DEMO_RECOVERY_QUARANTINE_'),
  });
}

class DemoEngine {
  constructor({
    rootDirectory = getDefaultDemoRoot(),
    clock = SYSTEM_CLOCK,
    ownerLiveness = defaultOwnerLiveness,
    staleLockGraceMs = RISK_FORK_DEMO_STALE_LOCK_GRACE_MS,
  } = {}) {
    if (typeof rootDirectory !== 'string' || rootDirectory.trim() === '') {
      throw new TypeError('rootDirectory must be a non-empty path string');
    }
    if (typeof clock !== 'function' || typeof ownerLiveness !== 'function') {
      throw new TypeError('Demo lock clock and owner-liveness probe must be functions');
    }
    if (!Number.isSafeInteger(staleLockGraceMs)
      || staleLockGraceMs < 0
      || staleLockGraceMs > 24 * 60 * 60 * 1_000) {
      throw new TypeError('staleLockGraceMs must be an integer from 0 through 86400000');
    }
    this.rootDirectory = path.resolve(rootDirectory);
    this.lockControls = Object.freeze({ clock, ownerLiveness, staleLockGraceMs });
    this.receipts = new Map();
    this.active = null;
    this.admissionsClosed = false;
    this.abortPromise = null;
  }

  listScenarios() {
    return listScenarios();
  }

  plan(scenarioId) {
    return createDemoPlan(scenarioId);
  }

  status() {
    const ownedRootPathHash = sha256Ref(this.rootDirectory);
    return createDemoTruth({
      schema: 'agoragentic.risk-fork.hackathon-demo-status.v1',
      ready_for_local_demo: true,
      owned_root: {
        path_hash: ownedRootPathHash,
        absolute_path_redacted: true,
        initialized_by_status: false,
      },
      owned_root_path_hash: ownedRootPathHash,
      root_initialized_by_status: false,
      active_in_this_process: this.active !== null,
      admissions_closed: this.admissionsClosed,
      limits: structuredClone(RISK_FORK_DEMO_LIMITS),
    });
  }

  getReceipt(runId) {
    if (typeof runId !== 'string' || !this.receipts.has(runId)) {
      return createDemoTruth({
        schema: 'agoragentic.risk-fork.hackathon-demo-receipt-lookup.v1',
        found: false,
        exit_code: 2,
      });
    }
    return createDemoTruth({
      schema: 'agoragentic.risk-fork.hackathon-demo-receipt-lookup.v1',
      found: true,
      run_id: runId,
      receipt: frozenCopy(this.receipts.get(runId)),
      exit_code: 0,
    });
  }

  async run(scenarioId) {
    const scenario = getScenario(scenarioId);
    const plan = await createInternalPlan(scenario);
    const runId = `run_${randomBytes(12).toString('hex')}`;
    if (this.admissionsClosed) {
      const component = admissionBlockedComponent({
        scenario,
        plan,
        runId,
        code: 'DEMO_ADMISSIONS_CLOSED',
        message: 'Demo run admission is closed after shutdown was requested',
      });
      return finalizeResult({
        scenario,
        plan,
        component,
        completedRunsAfter: null,
        ownedRunCleanup: { status: 'not_applicable', removed: false },
      });
    }

    const rootHandle = await initializeOwnedDemoRoot(this.rootDirectory);
    let lock;
    try {
      lock = await acquireRunLock(rootHandle, runId, this.lockControls);
    } catch (error) {
      const failure = sanitizedAdmissionFailure(error);
      const component = admissionBlockedComponent({
        scenario,
        plan,
        runId,
        code: failure.code,
        message: failure.message,
        cleanupUnknown: failure.cleanup_unknown,
      });
      return finalizeResult({
        scenario,
        plan,
        component,
        completedRunsAfter: null,
        ownedRunCleanup: { status: 'not_applicable', removed: false },
      });
    }

    let completedRuns = null;
    let workspace = null;
    let runtime = null;
    let component = null;
    let ownedRunCleanup = { status: 'not_applicable', removed: false };
    let stateUpdated = false;
    let completedRun = false;
    let setupCleanupRequested = false;
    let ownedCleanupFailure = null;
    let stateFailure = null;
    let rootVerificationFailure = null;
    let lockCleanup = { status: 'unknown', removed: false, failure: null };

    // From this point forward, the acquired lock and any exact run allocation are
    // owned by this single boundary. No post-lock failure may escape before both
    // resources have been closed, removed when safe, and absence-checked.
    try {
      try {
        completedRuns = await readCompletedRuns(rootHandle);
      } catch (error) {
        setupCleanupRequested = true;
        const failure = sanitizeDemoError(error, { code: 'DEMO_STATE_INVALID' });
        component = admissionBlockedComponent({
          scenario,
          plan,
          runId,
          code: 'DEMO_STATE_INVALID',
          message: failure.message,
        });
        component.validation_status = 'setup_blocked';
      }

      if (!component && completedRuns >= RISK_FORK_DEMO_LIMITS.max_completed_runs_before_reset) {
        component = admissionBlockedComponent({
          scenario,
          plan,
          runId,
          code: 'DEMO_COMPLETED_RUN_LIMIT',
          message: 'The local demo completed-run limit was reached; cleanup is required',
        });
      }

      if (!component && this.admissionsClosed) {
        component = admissionBlockedComponent({
          scenario,
          plan,
          runId,
          code: 'DEMO_ADMISSIONS_CLOSED',
          message: 'Demo run admission closed before owned execution began',
        });
      }

      if (!component) {
        try {
          workspace = await createRunWorkspace(rootHandle, runId);
        } catch (error) {
          setupCleanupRequested = true;
          const failure = sanitizedAdmissionFailure(error);
          component = admissionBlockedComponent({
            scenario,
            plan,
            runId,
            code: failure.code,
            message: failure.message,
          });
          component.validation_status = 'setup_blocked';
        }
      }

      if (!component) {
        let resolveSettled;
        const settled = new Promise((resolve) => { resolveSettled = resolve; });
        runtime = {
          adapter: null,
          rootHandle,
          workspace,
          lock,
          settled,
          resolveSettled,
        };
        this.active = runtime;
        completedRun = true;
        try {
          component = await executeScenario({
            scenario,
            plan,
            runId,
            workspace,
            rootHandle,
            runtime,
          });
        } catch (error) {
          component = admissionBlockedComponent({
            scenario,
            plan,
            runId,
            code: 'DEMO_INTERNAL_FAILURE',
            message: sanitizeDemoError(error, { code: 'DEMO_INTERNAL_FAILURE' }).message,
          });
        }
      }
    } catch (error) {
      setupCleanupRequested = true;
      const failure = sanitizedAdmissionFailure(error);
      component = admissionBlockedComponent({
        scenario,
        plan,
        runId,
        code: failure.code,
        message: failure.message,
      });
      component.validation_status = 'setup_blocked';
    } finally {
      if (runtime?.adapter) {
        try {
          await runtime.adapter.dispose();
        } catch (error) {
          ownedCleanupFailure = error;
        }
      }

      if (workspace) {
        try {
          ownedRunCleanup = await removeOwnedDemoEntry(rootHandle, workspace.run_relative);
        } catch (error) {
          ownedCleanupFailure ??= error;
          ownedRunCleanup = { status: 'unknown', removed: false };
        }
      } else if (setupCleanupRequested) {
        try {
          ownedRunCleanup = await removeExactRunAfterSetupFailure(rootHandle, runId);
        } catch (error) {
          ownedCleanupFailure ??= error;
          ownedRunCleanup = { status: 'unknown', removed: false };
        }
      }

      if (completedRun) {
        try {
          await writeCompletedRuns(rootHandle, completedRuns + 1);
          stateUpdated = true;
        } catch (error) {
          stateFailure = error;
        }
      }

      lockCleanup = await releaseAndVerifyRunLock(rootHandle, lock);

      try {
        await inspectOwnedDemoTree(rootHandle, {
          maxFiles: 10_000,
          maxBytes: RISK_FORK_DEMO_LIMITS.max_root_bytes,
        });
      } catch (error) {
        rootVerificationFailure = error;
      }

      const cleanupUnknown = ownedCleanupFailure !== null
        || lockCleanup.status !== 'verified_absent'
        || rootVerificationFailure !== null;
      if (setupCleanupRequested) {
        const setupAbsenceVerified = !cleanupUnknown
          && ownedRunCleanup.status === 'verified_absent';
        component.cleanup = {
          requested: true,
          absence: setupAbsenceVerified ? 'verified' : 'unknown',
          status: setupAbsenceVerified ? 'verified' : 'unknown',
        };
        component.final_state = 'blocked';
        component.exit_code = 2;
      } else if (cleanupUnknown) {
        component.cleanup = { requested: true, absence: 'unknown', status: 'unknown' };
        component.final_state = 'blocked';
        component.exit_code = 2;
      }

      if (ownedCleanupFailure) {
        component.cleanup_failure = sanitizeDemoError(ownedCleanupFailure, {
          code: 'DEMO_CLEANUP_UNKNOWN',
        });
      }
      if (stateFailure) {
        component.final_state = 'blocked';
        component.exit_code = 2;
        component.state_failure = sanitizeDemoError(stateFailure, {
          code: 'DEMO_STATE_UPDATE_FAILED',
        });
      }
      if (lockCleanup.status !== 'verified_absent') {
        component.lock_cleanup_failure = sanitizeDemoError(
          lockCleanup.failure ?? new Error('Demo active lock absence was not verified'),
          { code: 'DEMO_LOCK_CLEANUP_UNKNOWN' },
        );
      }
      if (rootVerificationFailure) {
        component.root_verification_failure = sanitizeDemoError(rootVerificationFailure, {
          code: 'DEMO_ROOT_VERIFICATION_FAILED',
        });
      }

      this.active = null;
      runtime?.resolveSettled({
        cleanup_status: ownedRunCleanup.status === 'verified_absent'
          && lockCleanup.status === 'verified_absent'
          && ownedCleanupFailure === null
          && rootVerificationFailure === null
          ? 'verified_absent'
          : 'unknown',
        state_updated: stateUpdated,
      });
    }

    const result = finalizeResult({
      scenario,
      plan,
      component,
      completedRunsAfter: stateUpdated ? completedRuns + 1 : completedRuns,
      ownedRunCleanup,
    });
    this.receipts.set(result.run_id, result.demo_receipt);
    return result;
  }

  abort() {
    if (this.abortPromise) return this.abortPromise;
    this.admissionsClosed = true;
    this.abortPromise = (async () => {
      const active = this.active;
      if (!active) {
        return createDemoTruth({
          schema: 'agoragentic.risk-fork.hackathon-demo-abort.v1',
          cleanup: { requested: false, absence: 'not_applicable', status: 'not_applicable' },
          exit_code: 0,
        });
      }
      let disposeFailed = false;
      if (active.adapter) {
        try {
          await active.adapter.dispose();
        } catch {
          disposeFailed = true;
        }
      }
      const settled = await active.settled;
      const verified = !disposeFailed && settled.cleanup_status === 'verified_absent';
      return createDemoTruth({
        schema: 'agoragentic.risk-fork.hackathon-demo-abort.v1',
        cleanup: {
          requested: true,
          absence: verified ? 'verified' : 'unknown',
          status: verified ? 'verified' : 'unknown',
        },
        exit_code: verified ? 0 : 2,
      });
    })();
    return this.abortPromise;
  }

  async cleanup() {
    if (this.active) await this.abort();
    let info;
    try {
      info = await lstat(this.rootDirectory);
    } catch (error) {
      if (error?.code === 'ENOENT') {
        return createDemoTruth({
          schema: 'agoragentic.risk-fork.hackathon-demo-cleanup.v1',
          cleanup: {
            requested: false,
            absence: 'verified',
            status: 'verified',
            stale_lock_recovered: false,
            verification: {
              active_lock: 'verified_absent',
              recovery_lock: 'verified_absent',
              quarantine: 'verified_absent',
              run: 'verified_absent',
              fork: 'verified_absent',
              savepoint: 'verified_absent',
            },
          },
          reset_completed_runs: true,
          exit_code: 0,
        });
      }
      throw error;
    }
    if (!info.isDirectory() || info.isSymbolicLink()) {
      return createDemoTruth({
        schema: 'agoragentic.risk-fork.hackathon-demo-cleanup.v1',
        cleanup: { requested: true, absence: 'unknown', status: 'unknown' },
        reset_completed_runs: false,
        exit_code: 2,
      });
    }
    const rootHandle = await openOwnedDemoRoot(this.rootDirectory);
    let recoveryLock;
    try {
      recoveryLock = await acquireRecoveryLock(rootHandle, this.lockControls);
    } catch (error) {
      return createDemoTruth({
        schema: 'agoragentic.risk-fork.hackathon-demo-cleanup.v1',
        cleanup: { requested: true, absence: 'unknown', status: 'unknown' },
        reset_completed_runs: false,
        exit_code: 2,
        failure: sanitizeDemoError(error, {
          code: error?.code ?? 'DEMO_CLEANUP_UNKNOWN',
        }),
      });
    }
    try {
      const recovered = await recoverStaleActiveLock(
        rootHandle,
        recoveryLock,
        this.lockControls,
      );
      const artifactVerification = recovered
        ? await cleanupRecoveredRun(rootHandle, recovered)
        : await cleanupWithoutActiveRun(rootHandle);
      await inspectOwnedDemoTree(rootHandle, {
        maxFiles: 10_000,
        maxBytes: RISK_FORK_DEMO_LIMITS.max_root_bytes,
      });
      await recoveryLock.release();
      const verification = Object.freeze({
        ...artifactVerification,
        recovery_lock: await verifyOwnedAbsence(
          rootHandle,
          RECOVERY_LOCK,
          'Recovery lock',
        ),
      });
      this.receipts.clear();
      this.admissionsClosed = false;
      this.abortPromise = null;
      return createDemoTruth({
        schema: 'agoragentic.risk-fork.hackathon-demo-cleanup.v1',
        cleanup: {
          requested: true,
          absence: 'verified',
          status: 'verified',
          stale_lock_recovered: recovered !== null,
          recovered_run_id: recovered?.run_id ?? null,
          verification,
        },
        reset_completed_runs: true,
        exit_code: 0,
      });
    } catch (error) {
      await recoveryLock.release().catch(() => {});
      return createDemoTruth({
        schema: 'agoragentic.risk-fork.hackathon-demo-cleanup.v1',
        cleanup: { requested: true, absence: 'unknown', status: 'unknown' },
        reset_completed_runs: false,
        exit_code: 2,
        failure: sanitizeDemoError(error, {
          code: error?.code ?? 'DEMO_CLEANUP_UNKNOWN',
        }),
      });
    }
  }
}

export function createDemoEngine(options = {}) {
  return new DemoEngine(options);
}

export {
  RISK_FORK_DEMO_BANNER,
  RISK_FORK_DEMO_LIMITS,
};
