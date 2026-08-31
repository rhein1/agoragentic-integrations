import { canonicalize } from '../../src/index.mjs';
import { FAKE_E2B_DEMO_PROFILE } from './fake-e2b-profile.mjs';

// This tranche intentionally has no executable live path. Environment variables,
// approval-shaped caller data, and injected dependencies cannot change this value.
export const E2B_LIVE_CANARY_SOURCE_ENABLED = false;

const LIVE_REQUEST_KEYS = Object.freeze([
  'profile_id',
  'run_id',
  'maximum_provider_allocations',
  'maximum_runtime_seconds',
  'maximum_cost_usd',
  'synthetic_only',
]);

export const E2B_LIVE_CANARY_COMPOSITION = Object.freeze({
  schema: 'agoragentic.risk-fork.e2b-live-canary-composition.v1',
  status: 'source_disabled_not_executable',
  sdk: 'e2b@2.39.0',
  adapter_module: 'risk-fork/src/adapters/e2b.mjs',
  adapter_export: 'E2BRiskForkAdapter',
  qualification_harness: 'risk-fork/scripts/e2b-live-qualification.mjs',
  profile_id: FAKE_E2B_DEMO_PROFILE.id,
  source_gate_enabled: E2B_LIVE_CANARY_SOURCE_ENABLED,
  provider_io_allowed: false,
  provider_calls: 0,
  pre_io_gate_model: 'implemented_injectable_evaluation_only',
  required_host_bindings_before_source_activation: Object.freeze([
    'owner-authenticated approval verification from a pinned trusted authority',
    'durable atomic one-use run claim controlled by that authority',
    'local exact-version e2b SDK loader',
    'reviewed E2BRiskForkAdapter factory',
    'separate owner approval for the exact one-shot plan',
  ]),
});

function result(fields) {
  return Object.freeze({
    schema: 'agoragentic.risk-fork.e2b-live-canary-gate-result.v1',
    provider_calls: 0,
    credentials_serialized: false,
    ...fields,
  });
}

function blocked(code, gate, detail = {}) {
  return result({
    status: 'blocked',
    code,
    gate,
    provider_io_allowed: false,
    credentials_inspected: false,
    approval_verification_attempted: false,
    approval_authenticated: false,
    run_claim_attempted: false,
    run_consumed: false,
    ...detail,
  });
}

function exactDataObject(value, expectedKeys) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const descriptors = Object.getOwnPropertyDescriptors(value);
  if (Object.values(descriptors).some((descriptor) => (
    typeof descriptor.get === 'function' || typeof descriptor.set === 'function'
  ))) return false;
  return canonicalize(Object.keys(descriptors).sort()) === canonicalize([...expectedKeys].sort());
}

function validateRequest(request) {
  if (!exactDataObject(request, LIVE_REQUEST_KEYS)
    || request.profile_id !== FAKE_E2B_DEMO_PROFILE.id
    || typeof request.run_id !== 'string'
    || !/^e2b_demo_canary_[a-z0-9]{16,64}$/.test(request.run_id)
    || request.maximum_provider_allocations !== 1
    || request.maximum_runtime_seconds !== 180
    || request.maximum_cost_usd !== 0.00585
    || request.synthetic_only !== true) {
    return false;
  }
  return true;
}

function environmentValue(environment, key) {
  if (!environment || typeof environment !== 'object' || Array.isArray(environment)) return null;
  const descriptor = Object.getOwnPropertyDescriptor(environment, key);
  if (!descriptor || typeof descriptor.get === 'function' || typeof descriptor.set === 'function') {
    return null;
  }
  return descriptor.value;
}

function approvalMatches(value, request, observedAt) {
  if (!value
    || typeof value !== 'object'
    || Array.isArray(value)
    || value.authenticated !== true
    || value.profile_id !== request.profile_id
    || value.run_id !== request.run_id
    || value.maximum_provider_allocations !== request.maximum_provider_allocations
    || value.maximum_runtime_seconds !== request.maximum_runtime_seconds
    || value.maximum_cost_usd !== request.maximum_cost_usd
    || value.synthetic_only !== true
    || typeof value.approval_ref !== 'string'
    || !/^owner:[A-Za-z0-9._:-]{1,180}$/.test(value.approval_ref)) {
    return false;
  }
  const expiresAt = Date.parse(value.expires_at);
  return Number.isFinite(expiresAt) && expiresAt > observedAt && expiresAt <= observedAt + 60 * 60_000;
}

// Pure pre-I/O evaluator used by deterministic tests and by the source-disabled
// composition. It never loads an SDK or contacts a provider.
export async function evaluateE2BLiveCanaryPreIoGates(input = {}) {
  if (input.sourceEnabled !== true) {
    return blocked('E2B_LIVE_SOURCE_DISABLED', 'compile_time_source_gate');
  }
  const environment = input.environment;
  if (environmentValue(environment, 'RISK_FORK_DEMO_E2B_ENABLED') !== 'true') {
    return blocked('E2B_DEMO_ENABLE_REQUIRED', 'explicit_enable');
  }
  if (!validateRequest(input.request)) {
    return blocked('E2B_CANARY_EXACT_REQUEST_REQUIRED', 'immutable_profile_and_cost');
  }
  if (!input.approvalArtifact
    || typeof input.approvalAuthority?.verifyApproval !== 'function') {
    return blocked('E2B_OWNER_APPROVAL_REQUIRED', 'trusted_owner_approval');
  }
  const observedAt = Date.parse(input.now instanceof Date ? input.now.toISOString() : input.now);
  if (!Number.isFinite(observedAt)) {
    return blocked('E2B_CANARY_CLOCK_REQUIRED', 'trusted_clock');
  }
  let approval;
  try {
    approval = await input.approvalAuthority.verifyApproval({
      artifact: input.approvalArtifact,
      request: structuredClone(input.request),
      observed_at: new Date(observedAt).toISOString(),
    });
  } catch {
    return blocked('E2B_OWNER_APPROVAL_REQUIRED', 'trusted_owner_approval', {
      approval_verification_attempted: true,
    });
  }
  if (!approvalMatches(approval, input.request, observedAt)) {
    return blocked('E2B_OWNER_APPROVAL_REQUIRED', 'trusted_owner_approval', {
      approval_verification_attempted: true,
    });
  }
  const controllerKey = environmentValue(environment, 'E2B_API_KEY');
  if (typeof controllerKey !== 'string' || controllerKey.length === 0) {
    return blocked('E2B_API_KEY_PRESENCE_REQUIRED', 'controller_key_presence_after_approval', {
      approval_verification_attempted: true,
      approval_authenticated: true,
      credentials_inspected: true,
    });
  }
  if (typeof input.runClaimStore?.claimOnce !== 'function') {
    return blocked('E2B_DURABLE_RUN_CLAIM_REQUIRED', 'durable_atomic_one_use_claim', {
      approval_verification_attempted: true,
      approval_authenticated: true,
      credentials_inspected: true,
    });
  }
  let claim;
  try {
    claim = await input.runClaimStore.claimOnce({
      run_id: input.request.run_id,
      profile_id: input.request.profile_id,
      approval_ref: approval.approval_ref,
    });
  } catch {
    return blocked('E2B_DURABLE_RUN_CLAIM_FAILED', 'durable_atomic_one_use_claim', {
      approval_verification_attempted: true,
      approval_authenticated: true,
      credentials_inspected: true,
      run_claim_attempted: true,
    });
  }
  if (claim?.status !== 'claimed'
    || claim.run_id !== input.request.run_id
    || claim.durable !== true
    || claim.atomic !== true) {
    return blocked('E2B_CANARY_RUN_ALREADY_CONSUMED', 'durable_atomic_one_use_claim', {
      approval_verification_attempted: true,
      approval_authenticated: true,
      credentials_inspected: true,
      run_claim_attempted: true,
    });
  }
  return result({
    status: 'eligible_pre_io',
    code: 'E2B_PRE_IO_GATES_SATISFIED',
    gate: 'complete',
    provider_io_allowed: true,
    credentials_inspected: true,
    approval_verification_attempted: true,
    approval_authenticated: true,
    run_claim_attempted: true,
    run_consumed: true,
  });
}

export function evaluateE2BLiveCanaryGate(input) {
  if (!E2B_LIVE_CANARY_SOURCE_ENABLED) {
    return blocked('E2B_LIVE_SOURCE_DISABLED', 'compile_time_source_gate');
  }
  return evaluateE2BLiveCanaryPreIoGates({ ...input, sourceEnabled: true });
}

export async function composeE2BLiveCanary(input) {
  if (!E2B_LIVE_CANARY_SOURCE_ENABLED) {
    return Object.freeze({
      schema: 'agoragentic.risk-fork.e2b-live-canary-composition-result.v1',
      status: 'blocked',
      gate: blocked('E2B_LIVE_SOURCE_DISABLED', 'compile_time_source_gate'),
      adapter: null,
      sdk_loaded: false,
      provider_io_allowed: false,
      provider_calls: 0,
      credentials_serialized: false,
    });
  }
  const gate = await evaluateE2BLiveCanaryPreIoGates({ ...input, sourceEnabled: true });
  if (gate.status !== 'eligible_pre_io') {
    return Object.freeze({
      schema: 'agoragentic.risk-fork.e2b-live-canary-composition-result.v1',
      status: 'blocked',
      gate,
      adapter: null,
      sdk_loaded: false,
      provider_io_allowed: false,
      provider_calls: 0,
      credentials_serialized: false,
    });
  }
  if (typeof input.sdkLoader !== 'function' || typeof input.adapterFactory !== 'function') {
    return Object.freeze({
      schema: 'agoragentic.risk-fork.e2b-live-canary-composition-result.v1',
      status: 'blocked',
      gate: blocked('E2B_REVIEWED_COMPOSITION_DEPENDENCIES_REQUIRED', 'local_composition'),
      adapter: null,
      sdk_loaded: false,
      provider_io_allowed: false,
      provider_calls: 0,
      credentials_serialized: false,
    });
  }
  const sdk = await input.sdkLoader({ package_name: 'e2b', exact_version: '2.39.0' });
  const adapter = await input.adapterFactory({
    sdk,
    controller_api_key: environmentValue(input.environment, 'E2B_API_KEY'),
    immutable_profile: FAKE_E2B_DEMO_PROFILE,
  });
  return Object.freeze({
    schema: 'agoragentic.risk-fork.e2b-live-canary-composition-result.v1',
    status: 'ready_not_executed',
    gate,
    adapter,
    sdk_loaded: true,
    provider_io_allowed: true,
    provider_calls: 0,
    credentials_serialized: false,
  });
}
