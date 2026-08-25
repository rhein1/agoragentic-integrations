import { randomUUID } from 'node:crypto';

import { sha256Ref } from './canonical.mjs';
import { validateChildOperation } from './child-operation.mjs';
import {
  createForkIdentity,
  networkPolicy,
  verifyExecutionBinding,
  verifySavepointCapsule,
} from './contracts.mjs';
import {
  CommitAmbiguousError,
  commitPreparedArtifact,
} from './clean-commit.mjs';
import {
  createLifecycle,
  transitionLifecycle,
  verifyLifecycle,
} from './lifecycle.mjs';
import { assertRiskForkProvider } from './provider.mjs';
import {
  isPostgresDistributedCommitAuthority,
  isProductionPostgresDistributedCommitAuthority,
} from './adapters/postgres-authority.mjs';
import { classifyRisk } from './risk-classifier.mjs';
import { validateCommitCandidate, verifyCommitArtifact } from './taint-gate.mjs';
import {
  assertAllowedKeys,
  assertPlainObject,
  boundedInteger,
  cloneJson,
  deepFreeze,
  requireEnum,
  requireIsoDate,
  requireOpaqueRef,
  requireSha256Ref,
  safeEqual,
} from './util.mjs';

const CONTROLLER_MODES = Object.freeze(['demonstration', 'production']);
const CONTROLLER_DISTRIBUTED_AUTHORITIES = new WeakMap();

function elapsedMs(started) {
  return Math.max(0, Math.round(performance.now() - started));
}

function lifecycleEvidence(code, status = 'observed', source = {}) {
  const hash = sha256Ref({ code, status, source });
  return {
    status,
    ref: `controller-evidence:${hash.slice(7, 31)}`,
    hash,
    detail: code,
  };
}

function advance(lifecycle, to, input = {}) {
  return transitionLifecycle(lifecycle, {
    actor: 'clean_controller',
    expected_version: lifecycle.version,
    expected_chain_head: lifecycle.chain_head,
    to,
    at: input.at,
    reason: input.reason ?? to.toLowerCase(),
    evidence: input.evidence ?? lifecycleEvidence(to.toLowerCase()),
    ...(input.fork_resource_state
      ? { fork_resource_state: input.fork_resource_state }
      : {}),
  });
}

function assertCapsuleMatchesDecision(capsule, decision) {
  const proposed = capsule.proposed_interaction;
  const observed = decision.normalized_input;
  const comparisons = [
    ['mcp_phase', observed.mcp_phase, proposed.mcp_method],
    ['raw_method', observed.raw_method, proposed.raw_method],
    ['mcp_server_ref', observed.mcp_server_ref, proposed.mcp_server_ref],
    ['mcp_server_origin', observed.mcp_server_origin, proposed.mcp_server_origin],
    ['tool_name', observed.tool_name, proposed.tool_name],
  ];
  for (const [field, actual, expected] of comparisons) {
    if (actual !== expected) throw new Error(`Risk decision and Savepoint Capsule differ at ${field}`);
  }
}

function expectedBindingForCapsule(capsule, value = {}) {
  assertPlainObject(value, 'expected_binding');
  const capsuleGovernance = {
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
  };
  for (const [field, expected] of Object.entries(capsuleGovernance)) {
    if (Object.hasOwn(value, field) && value[field] !== expected) {
      throw new Error(`Expected binding governance differs from the Savepoint Capsule: ${field}`);
    }
  }
  return {
    ...cloneJson(value),
    ...capsuleGovernance,
  };
}

function normalizeProviderVerification(result, provider, capabilitiesHash) {
  assertPlainObject(result, 'provider profile verification');
  assertAllowedKeys(result, [
    'status',
    'provider_id',
    'capabilities_hash',
    'evidence_ref',
    'evidence_hash',
  ], 'provider profile verification');
  if (result.status !== 'verified'
    || result.provider_id !== provider.id
    || result.capabilities_hash !== capabilitiesHash) {
    throw new Error('Owner-approved provider profile was not verified for the exact capabilities');
  }
  return {
    status: 'verified',
    evidence_ref: requireOpaqueRef(result.evidence_ref, 'provider profile evidence_ref'),
    evidence_hash: requireSha256Ref(result.evidence_hash, 'provider profile evidence_hash'),
  };
}

function normalizeCleanupClaim(value, field) {
  assertPlainObject(value, field);
  const status = requireEnum(
    value.status,
    ['verified', 'failed', 'unknown'],
    `${field}.status`,
  );
  const outcome = requireEnum(
    value.outcome ?? 'unknown',
    ['success', 'failure', 'unknown'],
    `${field}.outcome`,
  );
  const evidenceRef = value.evidence_ref == null
    ? null
    : requireOpaqueRef(value.evidence_ref, `${field}.evidence_ref`);
  const evidenceHash = value.evidence_hash == null
    ? null
    : requireSha256Ref(value.evidence_hash, `${field}.evidence_hash`);
  if (status === 'verified'
    && (outcome !== 'success' || !evidenceRef || !evidenceHash)) {
    throw new Error(`${field} verified status requires bound success evidence`);
  }
  return {
    status,
    outcome,
    evidence_ref: evidenceRef,
    evidence_hash: evidenceHash,
  };
}

function safeCleanupClaim(value, field) {
  try {
    return normalizeCleanupClaim(value, field);
  } catch {
    return {
      status: 'unknown',
      outcome: 'unknown',
      evidence_ref: null,
      evidence_hash: null,
    };
  }
}

function markPreparationStageFailed(lifecycle, at) {
  const failureByState = {
    SAVEPOINTING: 'SAVEPOINT_FAILED',
    FORK_STARTING: 'FORK_FAILED',
    EXECUTING: 'EXECUTION_FAILED',
    VALIDATING: 'VALIDATION_FAILED',
  };
  const directFailure = failureByState[lifecycle.state];
  if (directFailure) {
    return advance(lifecycle, directFailure, {
      at,
      evidence: lifecycleEvidence('preparation_stage_failed', 'failed', {
        failed_state: lifecycle.state,
      }),
    });
  }
  if (['REQUESTED', 'SAVEPOINT_READY', 'FORK_READY', 'TAINTED', 'COMMIT_READY'].includes(
    lifecycle.state,
  )) {
    let failed = advance(lifecycle, 'ABORTING', {
      at,
      evidence: lifecycleEvidence('preparation_aborting_after_failure', 'failed', {
        failed_state: lifecycle.state,
      }),
    });
    failed = advance(failed, 'ABORTED', {
      at,
      evidence: lifecycleEvidence('preparation_aborted_after_failure', 'failed'),
    });
    return failed;
  }
  return lifecycle;
}

export class RiskForkPreparationError extends Error {
  constructor(message, evidence = {}) {
    super(message);
    this.name = 'RiskForkPreparationError';
    this.code = 'RISK_FORK_PREPARATION_FAILED';
    this.evidence = evidence;
  }
}

export class RiskForkCommitError extends Error {
  constructor(message, { lifecycle, cause }) {
    super(message);
    this.name = 'RiskForkCommitError';
    this.code = cause instanceof CommitAmbiguousError
      ? 'RISK_FORK_COMMIT_AMBIGUOUS'
      : 'RISK_FORK_COMMIT_FAILED';
    this.lifecycle = lifecycle;
    this.cause_code = String(cause?.code ?? cause?.name ?? 'error').slice(0, 200);
  }
}

export class RiskForkController {
  constructor(options = {}) {
    assertAllowedKeys(options, [
      'provider',
      'mode',
      'clock',
      'verifyProviderProfile',
      'trustedServerVerifier',
      'distributedCommitAuthority',
      'distributedClaimantRef',
    ], 'Risk Fork controller options');
    this.provider = assertRiskForkProvider(options.provider);
    Object.defineProperty(this, 'mode', {
      value: requireEnum(options.mode ?? 'demonstration', CONTROLLER_MODES, 'controller mode'),
      enumerable: true,
      writable: false,
      configurable: false,
    });
    this.clock = options.clock ?? (() => new Date());
    this.verifyProviderProfile = options.verifyProviderProfile ?? null;
    this.trustedServerVerifier = options.trustedServerVerifier ?? null;
    if (options.distributedCommitAuthority != null
      && !isPostgresDistributedCommitAuthority(options.distributedCommitAuthority)) {
      throw new TypeError('An exact concrete PostgresDistributedCommitAuthority is required');
    }
    if ((options.distributedCommitAuthority == null)
      !== (options.distributedClaimantRef == null)) {
      throw new TypeError('Distributed authority and claimant ref must be configured together');
    }
    if (this.mode === 'production'
      && !isProductionPostgresDistributedCommitAuthority(
        options.distributedCommitAuthority,
      )) {
      const error = new TypeError(
        'Production Risk Fork requires the exact verify-only, TLS-required PostgreSQL authority',
      );
      error.code = 'PRODUCTION_POSTGRES_AUTHORITY_CONFIGURATION_REQUIRED';
      throw error;
    }
    CONTROLLER_DISTRIBUTED_AUTHORITIES.set(this, Object.freeze({
      authority: options.distributedCommitAuthority ?? null,
      claimantRef: options.distributedClaimantRef == null
        ? null
        : requireOpaqueRef(options.distributedClaimantRef, 'distributedClaimantRef'),
    }));
  }

  async #assertProviderAllowed(decision) {
    const capabilities = this.provider.capabilities;
    const capabilitiesHash = sha256Ref(capabilities);
    if (!capabilities.supports_verified_destruction) {
      throw new Error('Risk Fork commit requires provider-supported destruction verification');
    }
    if (this.mode === 'demonstration') {
      return {
        status: 'demonstration_only',
        capabilities_hash: capabilitiesHash,
        evidence_ref: null,
        evidence_hash: null,
      };
    }
    if (capabilities.isolation_class.startsWith('local_reference')) {
      throw new Error('The local reference adapter is never a production isolation boundary');
    }
    if (!capabilities.supports_hard_ttl
      || !capabilities.supports_idle_ttl
      || !capabilities.supports_max_execution_time) {
      throw new Error('Production Risk Fork requires hard, idle, and execution-time provider limits');
    }
    if (capabilities.child_credentials_mode !== 'prohibited'
      && !capabilities.supports_automatic_credential_expiry) {
      throw new Error('Production Risk Fork requires prohibited or automatically expiring child credentials');
    }
    if (['HIGH', 'IRREVERSIBLE'].includes(decision.level)
      && !capabilities.supports_network_policy) {
      throw new Error('This risk level requires a provider-enforced network policy');
    }
    if (capabilities.credentialed_provider_validation !== 'passed'
      || capabilities.containment_claim !== 'verified') {
      throw new Error('Provider containment is not live-validated for production Risk Fork execution');
    }
    if (typeof this.verifyProviderProfile !== 'function') {
      throw new Error('Production Risk Fork requires a trusted owner provider-profile verifier');
    }
    return {
      ...normalizeProviderVerification(
        await this.verifyProviderProfile({
          provider_id: this.provider.id,
          capabilities: cloneJson(capabilities),
          capabilities_hash: capabilitiesHash,
          risk_level: decision.level,
        }),
        this.provider,
        capabilitiesHash,
      ),
      capabilities_hash: capabilitiesHash,
    };
  }

  async #destroyResources({ forkRef, savepointRef }) {
    const result = {
      fork_request: null,
      fork_verification: null,
      savepoint_request: null,
      savepoint_verification: null,
    };
    if (forkRef) {
      try {
        result.fork_request = await this.provider.destroyFork({
          fork_ref: forkRef,
          reason: 'risk_fork_clean_boundary',
        });
      } catch (error) {
        result.fork_request = { status: 'failed', code: String(error?.code ?? 'destroy_failed') };
      }
      try {
        result.fork_verification = await this.provider.verifyDestroyed({ fork_ref: forkRef });
      } catch (error) {
        result.fork_verification = {
          status: 'unknown',
          outcome: 'unknown',
          code: String(error?.code ?? 'verify_destroyed_failed'),
        };
      }
    }
    if (savepointRef) {
      try {
        result.savepoint_request = await this.provider.destroySavepoint({
          savepoint_ref: savepointRef,
        });
      } catch (error) {
        result.savepoint_request = { status: 'failed', code: String(error?.code ?? 'delete_failed') };
      }
      try {
        result.savepoint_verification = await this.provider.verifySavepointDestroyed({
          savepoint_ref: savepointRef,
        });
      } catch (error) {
        result.savepoint_verification = {
          status: 'unknown',
          outcome: 'unknown',
          code: String(error?.code ?? 'verify_delete_failed'),
        };
      }
    }
    return result;
  }

  async prepare(input = {}) {
    assertAllowedKeys(input, [
      'risk_input',
      'capsule',
      'savepoint_input',
      'operation',
      'effective_arguments',
      'expected_commit_type',
      'commit_policy',
      'expected_binding',
      'createExecutionBinding',
      'fork_ttl_ms',
      'idle_ttl_ms',
      'max_execution_ms',
      'network_policy',
      'force_optional_fork',
    ], 'Risk Fork prepare input');
    assertPlainObject(input.risk_input, 'risk_input');
    assertPlainObject(input.savepoint_input ?? {}, 'savepoint_input');
    const operation = validateChildOperation(input.operation);
    const decision = classifyRisk(input.risk_input, {
      trusted_server_verifier: this.trustedServerVerifier,
      clock: this.clock,
    });
    if (decision.blocked) {
      return deepFreeze({ mode: 'denied', risk_decision: decision, authority_granted: false });
    }
    if (decision.level === 'LOW'
      || (decision.level === 'ELEVATED' && input.force_optional_fork !== true)) {
      return deepFreeze({
        mode: decision.level === 'LOW' ? 'direct_permitted' : 'fork_optional',
        risk_decision: decision,
        authority_granted: false,
      });
    }

    const now = requireIsoDate(this.clock(), 'clock result');
    verifySavepointCapsule(input.capsule, { now });
    assertCapsuleMatchesDecision(input.capsule, decision);
    const effectiveArgumentsHash = sha256Ref(input.effective_arguments);
    if (!safeEqual(
      effectiveArgumentsHash,
      input.capsule.proposed_interaction.effective_arguments_hash,
    )) {
      throw new Error('Effective arguments do not match the Savepoint Capsule');
    }
    const expectedCommitType = requireEnum(input.expected_commit_type, [
      'TYPED_RESULT',
      'WORKSPACE_DIFF',
      'CONSEQUENTIAL_ACTION_PROPOSAL',
    ], 'expected_commit_type');
    if (!input.capsule.allowed_commit_types.includes(expectedCommitType)) {
      throw new Error('Requested commit type is not authorized by the Savepoint Capsule');
    }
    if (decision.level === 'IRREVERSIBLE'
      && expectedCommitType !== 'CONSEQUENTIAL_ACTION_PROPOSAL') {
      throw new Error('Irreversible work may leave the fork only as a consequential action proposal');
    }
    if (expectedCommitType === 'CONSEQUENTIAL_ACTION_PROPOSAL'
      && typeof input.createExecutionBinding !== 'function') {
      throw new Error('A clean execution-binding factory is required for action proposals');
    }
    const expectedBinding = expectedBindingForCapsule(
      input.capsule,
      input.expected_binding ?? {},
    );
    const ttlMs = boundedInteger(
      input.fork_ttl_ms ?? 5 * 60 * 1000,
      'fork_ttl_ms',
      { min: 1_000, max: 24 * 60 * 60 * 1000 },
    );
    const idleTtlMs = boundedInteger(
      input.idle_ttl_ms ?? Math.min(ttlMs, 60_000),
      'idle_ttl_ms',
      { min: 1_000, max: ttlMs },
    );
    const maxExecutionMs = boundedInteger(
      input.max_execution_ms ?? Math.min(ttlMs, 60_000),
      'max_execution_ms',
      { min: 100, max: ttlMs },
    );
    const normalizedNetworkPolicy = networkPolicy(input.network_policy ?? { mode: 'blocked' });
    if (normalizedNetworkPolicy.mode === 'allowlist') {
      const ownerAllowed = new Set(decision.normalized_input.owner_policy.allowed_egress);
      const unauthorized = normalizedNetworkPolicy.allowlist.find((entry) => !ownerAllowed.has(entry));
      if (unauthorized) {
        throw new Error('Network policy requests egress outside the owner-approved allowlist');
      }
    }
    const providerVerification = await this.#assertProviderAllowed(decision);
    let lifecycle = createLifecycle({
      run_id: `risk-fork-${randomUUID()}`,
      requested_at: now,
      reason: 'risk_fork_requested',
      actor: 'clean_controller',
      evidence: lifecycleEvidence('risk_fork_requested', 'observed', {
        risk_decision_hash: decision.decision_hash,
      }),
    });
    let savepointRef = null;
    let forkRef = null;
    let forkIdentity = null;
    let executionBinding = null;
    let savepointCreationAttempted = false;
    let forkCreationAttempted = false;
    const measurements = {};

    try {
      lifecycle = advance(lifecycle, 'SAVEPOINTING', { at: requireIsoDate(this.clock(), 'clock result') });
      const savepointStarted = performance.now();
      savepointCreationAttempted = true;
      const savepoint = await this.provider.createSavepoint({
        ...cloneJson(input.savepoint_input),
        capsule: input.capsule,
      });
      measurements.savepoint_ms = elapsedMs(savepointStarted);
      savepointRef = requireOpaqueRef(savepoint.savepoint_ref, 'provider savepoint_ref');
      lifecycle = advance(lifecycle, 'SAVEPOINT_READY', {
        at: requireIsoDate(this.clock(), 'clock result'),
        evidence: lifecycleEvidence('savepoint_ready', 'observed', {
          savepoint_hash: requireSha256Ref(savepoint.savepoint_hash, 'provider savepoint_hash'),
        }),
      });

      forkIdentity = createForkIdentity({
        parent_agent_id: input.capsule.parent.agent_id,
        parent_session_id: input.capsule.parent.session_id,
        issued_at: requireIsoDate(this.clock(), 'clock result'),
      });
      lifecycle = advance(lifecycle, 'FORK_STARTING', {
        at: requireIsoDate(this.clock(), 'clock result'),
      });
      const forkStarted = performance.now();
      forkCreationAttempted = true;
      const fork = await this.provider.createFork({
        savepoint_ref: savepointRef,
        fork_identity: forkIdentity,
        network_policy: normalizedNetworkPolicy,
        ttl_ms: ttlMs,
        ...(this.provider.capabilities.supports_idle_ttl
          ? { idle_ttl_ms: idleTtlMs }
          : {}),
      });
      measurements.fork_start_ms = elapsedMs(forkStarted);
      forkRef = requireOpaqueRef(fork.fork_ref, 'provider fork_ref');
      lifecycle = advance(lifecycle, 'FORK_READY', {
        at: requireIsoDate(this.clock(), 'clock result'),
        fork_resource_state: 'ACTIVE',
        evidence: lifecycleEvidence('fork_ready', 'observed', {
          fork_hash: requireSha256Ref(fork.fork_hash, 'provider fork_hash'),
          identity_hash: forkIdentity.identity_hash,
        }),
      });

      if (expectedCommitType === 'CONSEQUENTIAL_ACTION_PROPOSAL') {
        executionBinding = await input.createExecutionBinding({
          capsule: input.capsule,
          fork_identity: forkIdentity,
          provider_ref: this.provider.id,
          risk_decision: decision,
          now: requireIsoDate(this.clock(), 'clock result'),
        });
        verifyExecutionBinding(executionBinding, {
          fork_agent_id: forkIdentity.fork_agent_id,
          session_id: forkIdentity.session_id,
          mcp_server_ref: input.capsule.proposed_interaction.mcp_server_ref,
          mcp_server_origin: input.capsule.proposed_interaction.mcp_server_origin,
          mcp_method: input.capsule.proposed_interaction.mcp_method,
          raw_method: input.capsule.proposed_interaction.raw_method,
          tool_name: input.capsule.proposed_interaction.tool_name,
          effective_arguments_hash: input.capsule.proposed_interaction.effective_arguments_hash,
          provider_ref: this.provider.id,
          target_ref: input.capsule.proposed_interaction.target_ref,
          ...(input.capsule.execution_authorization.ref
            ? {
                authorization_ref: input.capsule.execution_authorization.ref,
                authorization_hash: input.capsule.execution_authorization.hash,
              }
            : {}),
          ...expectedBinding,
        }, { now: requireIsoDate(this.clock(), 'clock result') });
      }

      lifecycle = advance(lifecycle, 'EXECUTING', { at: requireIsoDate(this.clock(), 'clock result') });
      const executionStarted = performance.now();
      const execution = await this.provider.executeInFork({
        fork_ref: forkRef,
        operation: cloneJson(operation),
        execution_mode: decision.level === 'IRREVERSIBLE' ? 'prepare_only' : 'isolated_execution',
        timeout_ms: maxExecutionMs,
      });
      measurements.execution_ms = elapsedMs(executionStarted);
      lifecycle = advance(lifecycle, 'TAINTED', {
        at: requireIsoDate(this.clock(), 'clock result'),
        evidence: lifecycleEvidence('fork_output_tainted', 'observed', {
          result_hash: requireSha256Ref(execution.result_hash, 'provider execution result_hash'),
        }),
      });

      let candidate;
      if (expectedCommitType === 'WORKSPACE_DIFF') {
        candidate = await this.provider.collectDiff({ fork_ref: forkRef });
      } else {
        candidate = execution.commit_candidate;
      }
      assertPlainObject(candidate, 'fork commit candidate');
      if (candidate.type !== expectedCommitType) {
        throw new Error('Fork returned a different commit type than the clean controller requested');
      }
      lifecycle = advance(lifecycle, 'VALIDATING', { at: requireIsoDate(this.clock(), 'clock result') });
      const validationStarted = performance.now();
      const artifact = validateCommitCandidate({
        candidate,
        source_fork_id: forkRef,
        policy: input.commit_policy ?? {},
        expected_binding: expectedBinding,
        execution_binding: executionBinding,
        validated_at: requireIsoDate(this.clock(), 'clock result'),
      });
      measurements.validation_ms = elapsedMs(validationStarted);
      lifecycle = advance(lifecycle, 'COMMIT_READY', {
        at: requireIsoDate(this.clock(), 'clock result'),
        evidence: {
          status: 'verified',
          ref: `artifact:${artifact.artifact_hash.slice(7, 31)}`,
          hash: artifact.artifact_hash,
          detail: 'tainted_artifact_validated',
        },
      });
      lifecycle = advance(lifecycle, 'PRECOMMIT_DESTROYING', {
        at: requireIsoDate(this.clock(), 'clock result'),
        fork_resource_state: 'DESTROY_REQUESTED',
      });
      const cleanupStarted = performance.now();
      const cleanup = await this.#destroyResources({ forkRef, savepointRef });
      measurements.cleanup_ms = elapsedMs(cleanupStarted);
      const forkClaim = normalizeCleanupClaim(cleanup.fork_verification, 'fork destruction verification');
      const savepointClaim = normalizeCleanupClaim(
        cleanup.savepoint_verification,
        'savepoint destruction verification',
      );
      const cleanupVerified = forkClaim.status === 'verified'
        && forkClaim.outcome === 'success'
        && savepointClaim.status === 'verified'
        && savepointClaim.outcome === 'success';
      if (!cleanupVerified) {
        const failed = [forkClaim.status, savepointClaim.status].includes('failed');
        lifecycle = advance(lifecycle, failed ? 'DESTRUCTION_FAILED' : 'DESTRUCTION_UNKNOWN', {
          at: requireIsoDate(this.clock(), 'clock result'),
          fork_resource_state: 'DESTROY_UNKNOWN',
          evidence: lifecycleEvidence(
            failed ? 'precommit_cleanup_failed' : 'precommit_cleanup_unknown',
            failed ? 'failed' : 'unknown',
            {
              fork_status: forkClaim.status,
              savepoint_status: savepointClaim.status,
            },
          ),
        });
        throw new RiskForkPreparationError('Risk Fork cleanup was not verified; commit is blocked', {
          lifecycle,
          cleanup,
        });
      }
      const combinedCleanupHash = sha256Ref({
        fork_evidence_hash: requireSha256Ref(forkClaim.evidence_hash, 'fork destruction evidence_hash'),
        savepoint_evidence_hash: requireSha256Ref(
          savepointClaim.evidence_hash,
          'savepoint destruction evidence_hash',
        ),
      });
      const cleanupLifecycleEvidence = {
        status: 'verified',
        ref: `cleanup:${combinedCleanupHash.slice(7, 31)}`,
        hash: combinedCleanupHash,
        detail: 'fork_and_savepoint_absence_verified',
      };
      lifecycle = advance(lifecycle, 'CLEAN_COMMIT_READY', {
        at: requireIsoDate(this.clock(), 'clock result'),
        fork_resource_state: 'DESTROYED',
        evidence: cleanupLifecycleEvidence,
      });
      const destructionEvidence = {
        status: 'verified',
        provider_ref: this.provider.id,
        fork_ref: forkRef,
        evidence_ref: cleanupLifecycleEvidence.ref,
        evidence_hash: cleanupLifecycleEvidence.hash,
      };
      return deepFreeze({
        mode: 'prepared_for_clean_commit',
        risk_decision: decision,
        capsule: input.capsule,
        fork_identity: forkIdentity,
        artifact,
        lifecycle,
        provider: {
          ref: this.provider.id,
          capabilities_hash: providerVerification.capabilities_hash,
          profile_verification: providerVerification,
        },
        destruction_evidence: destructionEvidence,
        savepoint_destruction: savepointClaim,
        measurements,
        authority_granted: false,
      });
    } catch (error) {
      if (error instanceof RiskForkPreparationError) throw error;
      const failedAt = requireIsoDate(this.clock(), 'clock result');
      lifecycle = markPreparationStageFailed(lifecycle, failedAt);
      const cleanup = await this.#destroyResources({ forkRef, savepointRef });
      const forkClaim = safeCleanupClaim(
        cleanup.fork_verification,
        'failed preparation fork destruction verification',
      );
      const savepointClaim = safeCleanupClaim(
        cleanup.savepoint_verification,
        'failed preparation savepoint destruction verification',
      );
      const forkAbsenceVerified = !forkCreationAttempted
        || (Boolean(forkRef) && forkClaim.status === 'verified' && forkClaim.outcome === 'success');
      const savepointAbsenceVerified = !savepointCreationAttempted
        || (Boolean(savepointRef)
          && savepointClaim.status === 'verified'
          && savepointClaim.outcome === 'success');
      if (['SAVEPOINT_FAILED', 'FORK_FAILED', 'EXECUTION_FAILED', 'VALIDATION_FAILED', 'ABORTED']
        .includes(lifecycle.state)) {
        lifecycle = advance(lifecycle, 'DESTROYING', {
          at: requireIsoDate(this.clock(), 'clock result'),
          fork_resource_state: 'DESTROY_REQUESTED',
          evidence: lifecycleEvidence('failed_preparation_cleanup_requested', 'observed'),
        });
      }
      if (lifecycle.state === 'PRECOMMIT_DESTROYING') {
        if (forkAbsenceVerified && savepointAbsenceVerified) {
          const cleanupHash = sha256Ref({
            fork: forkCreationAttempted ? forkClaim.evidence_hash : 'not_created',
            savepoint: savepointCreationAttempted ? savepointClaim.evidence_hash : 'not_created',
          });
          lifecycle = advance(lifecycle, 'DESTROYED', {
            at: requireIsoDate(this.clock(), 'clock result'),
            fork_resource_state: 'DESTROYED',
            evidence: {
              status: 'verified',
              ref: `failed-cleanup:${cleanupHash.slice(7, 31)}`,
              hash: cleanupHash,
              detail: 'failed_precommit_resources_absent',
            },
          });
        } else {
          const cleanupFailed = [forkClaim.status, savepointClaim.status].includes('failed');
          lifecycle = advance(
            lifecycle,
            cleanupFailed ? 'DESTRUCTION_FAILED' : 'DESTRUCTION_UNKNOWN',
            {
              at: requireIsoDate(this.clock(), 'clock result'),
              fork_resource_state: 'DESTROY_UNKNOWN',
              evidence: lifecycleEvidence(
                cleanupFailed
                  ? 'failed_precommit_cleanup_failed'
                  : 'failed_precommit_cleanup_unknown',
                cleanupFailed ? 'failed' : 'unknown',
              ),
            },
          );
        }
      }
      if (lifecycle.state === 'DESTROYING') {
        if (forkAbsenceVerified && savepointAbsenceVerified) {
          const cleanupHash = sha256Ref({
            fork: forkCreationAttempted ? forkClaim.evidence_hash : 'not_created',
            savepoint: savepointCreationAttempted ? savepointClaim.evidence_hash : 'not_created',
          });
          lifecycle = advance(lifecycle, 'DESTROYED', {
            at: requireIsoDate(this.clock(), 'clock result'),
            fork_resource_state: 'DESTROYED',
            evidence: {
              status: 'verified',
              ref: `failed-cleanup:${cleanupHash.slice(7, 31)}`,
              hash: cleanupHash,
              detail: 'failed_preparation_resources_absent',
            },
          });
        } else {
          const cleanupFailed = [forkClaim.status, savepointClaim.status].includes('failed');
          lifecycle = advance(
            lifecycle,
            cleanupFailed ? 'DESTRUCTION_FAILED' : 'DESTRUCTION_UNKNOWN',
            {
              at: requireIsoDate(this.clock(), 'clock result'),
              fork_resource_state: 'DESTROY_UNKNOWN',
              evidence: lifecycleEvidence(
                cleanupFailed
                  ? 'failed_preparation_cleanup_failed'
                  : 'failed_preparation_cleanup_unknown',
                cleanupFailed ? 'failed' : 'unknown',
              ),
            },
          );
        }
      }
      throw new RiskForkPreparationError('Risk Fork preparation failed closed', {
        lifecycle,
        cleanup,
        cause_code: String(error?.code ?? error?.name ?? 'error').slice(0, 200),
      });
    }
  }

  async commit(prepared, cleanCommitInput = {}) {
    assertPreparedForCleanCommit(prepared);
    assertPlainObject(cleanCommitInput, 'cleanCommitInput');
    if (Object.hasOwn(cleanCommitInput, 'distributedCommitAuthority')
      || Object.hasOwn(cleanCommitInput, 'distributedClaimantRef')) {
      throw new TypeError('Distributed authority is trusted controller construction state');
    }
    let lifecycle = advance(prepared.lifecycle, 'COMMITTING', {
      at: requireIsoDate(this.clock(), 'clock result'),
      evidence: lifecycleEvidence('clean_commit_started', 'observed', {
        artifact_hash: prepared.artifact.artifact_hash,
      }),
    });
    const distributed = CONTROLLER_DISTRIBUTED_AUTHORITIES.get(this);
    try {
      const result = await commitPreparedArtifact({
        ...cleanCommitInput,
        capsule: prepared.capsule,
        fork_identity: prepared.fork_identity,
        lifecycle,
        artifact: prepared.artifact,
        destruction_evidence: prepared.destruction_evidence,
        ...(distributed.authority
          ? {
              distributedCommitAuthority: distributed.authority,
              distributedClaimantRef: distributed.claimantRef,
            }
          : {}),
      }, {
        clock: this.clock,
        mode: this.mode,
      });
      lifecycle = advance(lifecycle, 'COMMITTED', {
        at: requireIsoDate(this.clock(), 'clock result'),
        evidence: {
          status: 'observed',
          ref: `commit-result:${result.result_hash.slice(7, 31)}`,
          hash: result.result_hash,
          detail: 'clean_commit_returned_success',
        },
      });
      return deepFreeze({ ...result, lifecycle });
    } catch (error) {
      lifecycle = advance(
        lifecycle,
        error instanceof CommitAmbiguousError ? 'COMMIT_AMBIGUOUS' : 'COMMIT_FAILED',
        {
          at: requireIsoDate(this.clock(), 'clock result'),
          evidence: lifecycleEvidence(
            error instanceof CommitAmbiguousError ? 'commit_ambiguous' : 'commit_failed',
            error instanceof CommitAmbiguousError ? 'unknown' : 'failed',
          ),
        },
      );
      throw new RiskForkCommitError('Risk Fork clean commit did not complete safely', {
        lifecycle,
        cause: error,
      });
    }
  }
}

export function assertPreparedForCleanCommit(prepared) {
  assertPlainObject(prepared, 'prepared Risk Fork result');
  if (prepared.mode !== 'prepared_for_clean_commit'
    || prepared.lifecycle?.state !== 'CLEAN_COMMIT_READY'
    || prepared.lifecycle?.fork_resource_state !== 'DESTROYED'
    || prepared.destruction_evidence?.status !== 'verified') {
    throw new Error('Risk Fork result is not at the verified clean commit boundary');
  }
  verifySavepointCapsule(prepared.capsule, { allowExpired: true, now: prepared.capsule.created_at });
  verifyLifecycle(prepared.lifecycle);
  verifyCommitArtifact(prepared.artifact);
  requireSha256Ref(prepared.capsule.parent.state_hash, 'prepared parent state hash');
  return true;
}
