import { createHash } from 'node:crypto';

// Source-contract target, NOT a claim of installed or runtime-tested compatibility.
export const UPSTREAM = Object.freeze({
  release: 'v0.1.2',
  commit: '6648bd0c290efbc41ba131ee9831ee45cd431f94',
  sdk: '@nvidia/openshell-sdk',
});
export const ROLES = Object.freeze(['cartographer', 'emissary', 'steward']);
const REQUEST_SCHEMA = 'agoragentic.openshell.request.v1';
const PLAN_SCHEMA = 'agoragentic.openshell.plan.v1';
const FORBIDDEN_KEYS = new Set(['__proto__', 'prototype', 'constructor']);

function fail(code) {
  const error = new Error(code);
  error.code = code;
  throw error;
}

// Do not invoke getters/toJSON, accept class instances, or copy dangerous keys.
function dataOnly(value, depth = 0, seen = new Set(), budget = { nodes: 0 }) {
  if (++budget.nodes > 4096 || depth > 16) fail('input_too_complex');
  if (value === null || typeof value === 'boolean') return value;
  if (typeof value === 'string') {
    if (value.length > 4096) fail('input_string_too_long');
    return value;
  }
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (!value || typeof value !== 'object') fail('json_data_required');
  if (seen.has(value)) fail('cyclic_input');
  const array = Array.isArray(value);
  if (!array && ![Object.prototype, null].includes(Object.getPrototypeOf(value))) fail('plain_object_required');
  if (Object.getOwnPropertySymbols(value).length) fail('symbol_keys_denied');
  seen.add(value);
  const output = array ? [] : {};
  for (const key of Object.getOwnPropertyNames(value)) {
    if (array && key === 'length') continue;
    if (FORBIDDEN_KEYS.has(key)) fail('unsafe_key');
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor.enumerable || !Object.hasOwn(descriptor, 'value')) fail('accessor_or_hidden_field_denied');
    if (array && !/^(0|[1-9][0-9]*)$/.test(key)) fail('array_property_denied');
    output[key] = dataOnly(descriptor.value, depth + 1, seen, budget);
  }
  if (array && (value.length > 4096 || Object.keys(output).length !== value.length)) fail('sparse_array_denied');
  seen.delete(value);
  return output;
}

function fields(value, allowed, required = []) {
  if (!value || Array.isArray(value) || typeof value !== 'object') fail('object_required');
  if (Object.keys(value).some((key) => !allowed.includes(key))) fail('unknown_field');
  if (required.some((key) => !Object.hasOwn(value, key))) fail('missing_field');
}

function slug(value, max = 63) {
  if (typeof value !== 'string' || value.length > max || !/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/.test(value)) fail('invalid_identifier');
  return value;
}

function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

function digest(value) {
  return `sha256:${createHash('sha256').update(canonical(value)).digest('hex')}`;
}

function freeze(value) {
  if (value && typeof value === 'object') {
    Object.values(value).forEach(freeze);
    Object.freeze(value);
  }
  return value;
}

function endpoint(value) {
  fields(value, ['host', 'paths'], ['host', 'paths']);
  const { host, paths } = value;
  // Syntactic screening only: DNS resolution/rebinding checks belong to the host.
  if (typeof host !== 'string' || host.length > 253 || host !== host.toLowerCase()
    || !/^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/.test(host)
    || /(?:^|\.)(?:localhost|local|internal|lan|home|onion)$/.test(host)) fail('invalid_public_hostname');
  if (!Array.isArray(paths) || paths.length < 1 || paths.length > 16) fail('invalid_paths');
  for (const path of paths) {
    if (typeof path !== 'string' || path.length > 256 || !/^\/[A-Za-z0-9._~/-]*$/.test(path)
      || path.includes('//') || path.split('/').some((part) => part === '.' || part === '..')) fail('invalid_exact_path');
  }
  return { host, paths: [...new Set(paths)].sort() };
}

/** Compile an offline proposal. It is not an approval, executor, or sandbox. */
export function buildOpenShellPlan(input) {
  const request = dataOnly(input);
  fields(request, ['schema', 'role', 'runId', 'workspace', 'image', 'readEndpoints', 'maxRuntimeSeconds'],
    ['schema', 'role', 'runId', 'workspace', 'image']);
  if (request.schema !== REQUEST_SCHEMA) fail('unsupported_request_schema');
  if (!ROLES.includes(request.role)) fail('unsupported_role');
  slug(request.runId, 24);
  slug(request.workspace);
  if (typeof request.image !== 'string' || request.image.length > 300
    || !/^[a-z0-9]+(?:[._-][a-z0-9]+)*(?:\/[a-z0-9]+(?:[._-][a-z0-9]+)*)+@sha256:[a-f0-9]{64}$/.test(request.image)) fail('digest_pinned_image_required');
  const seconds = Object.hasOwn(request, 'maxRuntimeSeconds') ? request.maxRuntimeSeconds : 60;
  if (!Number.isInteger(seconds) || seconds < 1 || seconds > 300) fail('invalid_runtime_limit');
  const endpoints = Object.hasOwn(request, 'readEndpoints') ? request.readEndpoints : [];
  if (!Array.isArray(endpoints) || endpoints.length > 16) fail('invalid_endpoints');
  if (request.role !== 'cartographer' && endpoints.length) fail('role_egress_denied');
  const normalized = endpoints.map(endpoint).sort((a, b) => a.host < b.host ? -1 : a.host > b.host ? 1 : 0);
  if (new Set(normalized.map((item) => item.host)).size !== normalized.length) fail('duplicate_host');
  const normalizedRequest = { ...request, readEndpoints: normalized, maxRuntimeSeconds: seconds };
  const networkPolicies = {};
  normalized.forEach((item, index) => {
    const name = `read_${index}`;
    networkPolicies[name] = {
      name,
      binaries: [{ path: '/usr/bin/curl' }],
      endpoints: [{
        host: item.host, port: 443, protocol: 'rest',
        tls: 0, enforcement: 1,
        rules: item.paths.flatMap((path) => ['GET', 'HEAD'].map((method) => ({ allow: { method, path } }))),
      }],
    };
  });
  const policy = {
    version: 1,
    filesystem: {
      includeWorkdir: false,
      readOnly: ['/usr', '/bin', '/lib', '/lib64', '/etc/ssl/certs', '/etc/hosts', '/etc/resolv.conf', '/sandbox/input'],
      readWrite: ['/sandbox/output', '/tmp'],
    },
    landlock: { compatibility: 'hard_requirement' },
    process: { runAsUser: 'sandbox', runAsGroup: 'sandbox' },
    networkPolicies,
  };
  const plan = {
    schema: PLAN_SCHEMA,
    request: normalizedRequest,
    upstream: { ...UPSTREAM },
    status: 'offline_proposal',
    authority: { execution: false, provisioning: false, payment: false, trustMutation: false, policyApproval: false },
    // camelCase is the TypeScript SDK message-init shape, NOT CLI YAML.
    createSpec: {
      name: `ag-${request.role}-${request.runId}`,
      workspace: request.workspace,
      image: request.image,
      command: ['/bin/true'],
      tty: false,
      gpu: false,
      environment: {},
      providers: [],
      serviceExposures: [],
      policy,
    },
    hostRequirements: {
      maxRuntimeSeconds: seconds,
      deadlineEnforced: false,
      imageVerified: false,
      gatewayVerified: false,
      dnsAndRedirectContainmentVerified: false,
      runtimePolicyVerified: false,
      ownerApprovalRequired: true,
      credentialBoundary: 'control_plane_only',
    },
    policyDigest: digest(policy),
    evidenceClass: 'local_plan_not_runtime_proof',
  };
  return freeze({ ...plan, planDigest: digest(plan) });
}

/** Reject altered or extended plans, including self-rehashed policy overrides. */
export function validateOpenShellPlan(input) {
  const plan = dataOnly(input);
  const rebuilt = buildOpenShellPlan(plan.request);
  if (canonical(plan) !== canonical(rebuilt)) fail('plan_mismatch');
  return rebuilt;
}

/** Offline SDK-result shaping. Caller reports NEVER become verified receipts. */
export function summarizeOpenShellObservation(planInput, expectedSandboxId, input) {
  const plan = validateOpenShellPlan(planInput);
  if (typeof expectedSandboxId !== 'string' || !/^[A-Za-z0-9-]{1,80}$/.test(expectedSandboxId)) fail('invalid_sandbox_id');
  const observation = dataOnly(input);
  fields(observation, ['kind', 'sandboxId', 'exitCode', 'outcome'], ['kind', 'sandboxId']);
  if (observation.sandboxId !== expectedSandboxId) fail('sandbox_identity_mismatch');
  let reportedStatus;
  if (observation.kind === 'exec') {
    if (Object.hasOwn(observation, 'outcome')) fail('unexpected_outcome');
    if (!Number.isInteger(observation.exitCode) || observation.exitCode < 0 || observation.exitCode > 255) fail('terminal_exit_code_required');
    reportedStatus = observation.exitCode === 0 ? 'reported_success' : 'reported_failure';
  } else if (observation.kind === 'delete') {
    if (Object.hasOwn(observation, 'exitCode')) fail('unexpected_exit_code');
    const states = { completed: 'reported_completed', accepted: 'reported_pending', already_absent: 'reported_absent_unverified', unspecified: 'unknown', unknown: 'unknown' };
    if (!Object.hasOwn(states, observation.outcome)) fail('unknown_deletion_outcome');
    reportedStatus = states[observation.outcome];
  } else fail('unsupported_observation');
  return freeze({
    schema: 'agoragentic.openshell.observation.v1',
    runId: plan.request.runId,
    planDigest: plan.planDigest,
    sandboxId: expectedSandboxId,
    kind: observation.kind,
    reportedStatus,
    evidenceClass: 'caller_reported_unverified',
    verified: false,
    settlementProof: false,
    executionAuthority: false,
  });
}

export function openShellReadiness() {
  return freeze({
    status: 'scaffold_only', upstream: { ...UPSTREAM },
    activationSupported: false, liveTrafficProtected: false,
    blockers: ['qualified_host_adapter_missing', 'image_and_gateway_not_verified', 'live_containment_not_tested', 'owner_activation_not_approved'],
  });
}

export class OpenShellScaffoldAdapter {
  prepare(request) { return buildOpenShellPlan(request); }
  async invoke() { fail('openshell_activation_not_implemented'); }
}
