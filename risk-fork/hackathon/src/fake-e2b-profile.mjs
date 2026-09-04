import path from 'node:path';

import {
  E2BRiskForkAdapter,
  createCleanupVerificationEvidence,
  sha256Ref,
} from '../../src/index.mjs';
import {
  FAKE_E2B_BOOTSTRAP_COMMAND,
  FAKE_E2B_BOOTSTRAP_HASH,
  FAKE_E2B_MAX_TIMEOUT_MS,
  FAKE_E2B_RUNNER_COMMAND,
  FAKE_E2B_RUNNER_HASH,
  FAKE_E2B_SDK_CONTRACT_VERSION,
  FAKE_E2B_TEMPLATE_HASH,
  FAKE_E2B_TEMPLATE_ID,
  FAKE_E2B_TEMPLATE_PROVENANCE_HASH,
  createFakeE2BSdk,
} from './fake-e2b-sdk.mjs';

export const FAKE_E2B_DEMO_LABEL =
  'FAKE E2B — LOCAL CONTRACT SIMULATION — NOT AN ISOLATION BOUNDARY';
export const RISK_FORK_HACKATHON_PRODUCT_CLAIM =
  'Hackathon demonstration only. Not production-qualified. No live Agoragentic traffic is protected.';

export const FAKE_E2B_DEMO_PROFILE = Object.freeze({
  schema: 'agoragentic.risk-fork.fake-e2b-demo-profile.v1',
  id: 'e2b-fake-hackathon-v1',
  provider: 'e2b',
  provider_status: 'not_live_qualified',
  sdk_contract_version: FAKE_E2B_SDK_CONTRACT_VERSION,
  mode: 'fake_e2b_local_contract_simulation',
  maximum_active_sandboxes: 1,
  sandbox_timeout_ms: FAKE_E2B_MAX_TIMEOUT_MS,
  maximum_allocations_per_run: 1,
  automatic_retry: false,
  persistent_volumes: false,
  inherited_environment: false,
  child_provider_key: false,
  wallet_or_signing_credentials: false,
  production_secrets: false,
  public_ingress: false,
  external_side_effects: false,
  irreversible_execution: 'prepare_only',
  fallback_provider: null,
  provider_operation_after_ambiguous_state: 'prohibited_until_reconciled',
  network_denial_requested: true,
  ipv4_containment_status: 'fake_observation_only_not_live_qualified',
  ipv6_containment_status: 'fake_observation_only_not_live_qualified',
  compute: {
    vcpu: 2,
    memory_gib: 1,
    maximum_seconds: 180,
    posted_rate_snapshot: {
      source: 'prompt_pinned_demo_estimate',
      two_vcpu_usd_per_second: 0.000028,
      memory_usd_per_gib_second: 0.0000045,
    },
    estimated_maximum_cost_usd: 0.00585,
    provider_finalized_cost_usd: null,
  },
});

const OBSERVATIONS = new WeakMap();
const SDK_EVIDENCE = new WeakMap();
const CLEANUP_UNKNOWN = new WeakMap();

function freeze(value) {
  return Object.freeze(structuredClone(value));
}

function observe(adapter, stage, fields = {}) {
  OBSERVATIONS.get(adapter).push(freeze({ stage, ...fields }));
}

function sourceVerifier(request) {
  const evidenceHash = sha256Ref({
    profile: FAKE_E2B_DEMO_PROFILE.id,
    request_hash: request.request_hash,
    workspace_manifest_hash: request.workspace_manifest_hash,
    trusted_bootstrap_artifact_hash: request.trusted_bootstrap_artifact_hash,
    trusted_runner_artifact_hash: request.trusted_runner_artifact_hash,
  });
  return {
    schema: 'agoragentic.risk-fork.authority-free-source-attestation.v1',
    status: 'verified',
    request_hash: request.request_hash,
    evidence_ref: `fake-e2b-source:${evidenceHash.slice(7, 31)}`,
    evidence_hash: evidenceHash,
    workspace_digest: request.workspace_digest,
    workspace_manifest_hash: request.workspace_manifest_hash,
    trusted_bootstrap_artifact_hash: FAKE_E2B_BOOTSTRAP_HASH,
    trusted_runner_artifact_hash: FAKE_E2B_RUNNER_HASH,
    claims: {
      authority_free: true,
      credentials_absent: true,
      wallet_material_absent: true,
      execution_authority_absent: true,
      workspace_manifest_verified: true,
      immutable_export_verified: true,
      trusted_runtime_artifacts_verified: true,
    },
  };
}

export class HackathonFakeE2BAdapter extends E2BRiskForkAdapter {
  constructor({
    baseDirectory,
    clock,
    fault = 'none',
    cleanupUnknown = false,
    maxFiles = 128,
    maxBytes = 4 * 1024 * 1024,
  } = {}) {
    if (typeof baseDirectory !== 'string' || baseDirectory.trim() === '') {
      throw new TypeError('Hackathon fake E2B baseDirectory is required');
    }
    const sdk = createFakeE2BSdk({ fault, now: clock().toISOString() });
    super({
      SandboxClass: sdk.Sandbox,
      offlineConformance: true,
      sdkVersion: FAKE_E2B_SDK_CONTRACT_VERSION,
      cleanTemplateId: FAKE_E2B_TEMPLATE_ID,
      cleanTemplateHash: FAKE_E2B_TEMPLATE_HASH,
      cleanTemplateProvenanceHash: FAKE_E2B_TEMPLATE_PROVENANCE_HASH,
      workspaceExportDirectory: path.join(baseDirectory, 'workspace-exports'),
      cleanupJournalDirectory: path.join(baseDirectory, 'cleanup-journal'),
      verifyAuthorityFreeSource: sourceVerifier,
      bootstrapCommand: FAKE_E2B_BOOTSTRAP_COMMAND,
      runnerCommand: FAKE_E2B_RUNNER_COMMAND,
      trustedBootstrapArtifactHash: FAKE_E2B_BOOTSTRAP_HASH,
      trustedRunnerArtifactHash: FAKE_E2B_RUNNER_HASH,
      birthAttestationTimeoutMs: 1_000,
      maxFiles,
      maxBytes,
      clock,
    });
    this.id = FAKE_E2B_DEMO_PROFILE.id;
    this.capabilities = Object.freeze({
      ...this.capabilities,
      supports_verified_destruction: true,
      isolation_class: 'fake_e2b_local_contract_simulation',
      adapter_implementation: 'hackathon_injected_fake_sdk_only',
      mock_conformance: 'deterministic_provider_api_absence_evidence',
      credentialed_provider_validation: 'not_run',
      containment_claim: 'not_verified',
    });
    OBSERVATIONS.set(this, []);
    SDK_EVIDENCE.set(this, sdk.evidence);
    CLEANUP_UNKNOWN.set(this, cleanupUnknown === true);
  }

  observations() {
    return freeze(OBSERVATIONS.get(this));
  }

  providerEvidence() {
    return SDK_EVIDENCE.get(this)();
  }

  async createSavepoint(input = {}) {
    observe(this, 'savepoint_requested', {
      capsule_hash: input.capsule?.capsule_hash ?? null,
      parent_state_hash: input.capsule?.parent?.state_hash ?? null,
      workspace_digest: input.capsule?.workspace?.digest ?? null,
    });
    const result = await super.createSavepoint(input);
    observe(this, 'savepoint_ready', {
      savepoint_ref: result.savepoint_ref,
      savepoint_hash: result.savepoint_hash,
      workspace_digest: result.workspace_digest,
    });
    return result;
  }

  async createFork(input = {}) {
    observe(this, 'allocation_requested', {
      savepoint_ref: input.savepoint_ref,
      identity_hash: input.fork_identity?.identity_hash ?? null,
      ttl_ms: input.ttl_ms,
      network_policy_hash: input.network_policy?.policy_hash ?? null,
    });
    const result = await super.createFork(input);
    const evidence = this.providerEvidence();
    observe(this, 'sandbox_id_observed', {
      fork_ref: result.fork_ref,
      fork_hash: result.fork_hash,
      sandbox_id: evidence.sandbox_id,
      expires_at: result.expires_at,
      network_status: result.network_status,
    });
    return result;
  }

  async executeInFork(input = {}) {
    observe(this, 'execution_requested', {
      fork_ref: input.fork_ref,
      execution_mode: input.execution_mode,
      timeout_ms: input.timeout_ms,
      action_count: input.operation?.actions?.length ?? 0,
    });
    const result = await super.executeInFork(input);
    observe(this, 'tainted_result_produced', {
      status: result.status,
      taint_status: result.taint_status,
      result_hash: result.result_hash,
      commit_candidate_hash: sha256Ref(result.commit_candidate),
    });
    return result;
  }

  async destroyFork(input = {}) {
    observe(this, 'fork_destruction_requested', {
      fork_ref: input.fork_ref,
      cleanup_request_hash: input.cleanup_request?.request_hash ?? null,
    });
    const result = await super.destroyFork(input);
    observe(this, 'kill_acknowledgement_observed', {
      fork_ref: result.fork_ref,
      status: result.status,
      evidence_status: result.evidence_status,
    });
    return result;
  }

  async verifyDestroyed(input = {}) {
    const actual = await super.verifyDestroyed(input);
    observe(this, 'provider_absence_observed', {
      status: actual.status,
      outcome: actual.outcome,
      evidence_ref: actual.evidence_ref,
      evidence_hash: actual.evidence_hash,
    });
    if (!CLEANUP_UNKNOWN.get(this)) return actual;
    const unknown = createCleanupVerificationEvidence(input.cleanup_request, {
      status: 'unknown',
      outcome: 'unknown',
      observation_hash: sha256Ref({
        profile: FAKE_E2B_DEMO_PROFILE.id,
        actual_absence_evidence_hash: actual.evidence_hash,
        forced_demo_unknown: true,
      }),
      observed_at: this.clock(),
    });
    observe(this, 'synthetic_cleanup_unknown', {
      status: unknown.status,
      outcome: unknown.outcome,
      actual_absence_observed: actual.status === 'verified',
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

  async dispose() {
    for (const record of this.forks.values()) {
      if (!record.destroyed_verified) {
        await this.destroyFork({ fork_ref: record.ref, reason: 'demo_dispose' }).catch(() => {});
        await this.verifyDestroyed({ fork_ref: record.ref }).catch(() => {});
      }
    }
    for (const record of this.savepoints.values()) {
      if (!record.destroyed) {
        await this.destroySavepoint({ savepoint_ref: record.ref }).catch(() => {});
        await this.verifySavepointDestroyed({ savepoint_ref: record.ref }).catch(() => {});
      }
    }
    const reconciliation = await this.reconcilePendingCleanup();
    if (reconciliation.unresolved.length > 0) {
      const error = new Error('Fake E2B cleanup reconciliation remains unresolved');
      error.code = 'DEMO_FAKE_E2B_CLEANUP_UNKNOWN';
      throw error;
    }
  }
}
