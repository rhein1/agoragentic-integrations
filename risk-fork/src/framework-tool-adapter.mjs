import { randomUUID } from 'node:crypto';
import { types as utilTypes } from 'node:util';

import { assertCanonicalJson, canonicalize, sha256Ref } from './canonical.mjs';
import { validateChildOperation } from './child-operation.mjs';
import { RISK_ACTIONS, RISK_LEVELS } from './constants.mjs';
import { isRiskForkHostBoundary } from './host-boundary.mjs';
import {
  assertAllowedKeys,
  assertPlainObject,
  deepFreeze,
  requireEnum,
  requireIsoDate,
  requireOpaqueRef,
  requireSha256Ref,
  safeEqual,
} from './util.mjs';

export const RISK_FORK_FRAMEWORKS = Object.freeze([
  'openai-agents',
  'langchain',
  'langgraph',
]);

export const RISK_FORK_FRAMEWORK_SCHEMAS = Object.freeze({
  request: 'agoragentic.risk-fork.framework-tool-request.v1',
  plan: 'agoragentic.risk-fork.framework-tool-plan.v1',
  planSource: 'agoragentic.risk-fork.framework-tool-plan-source.v1',
  executor: 'agoragentic.risk-fork.framework-tool-executor.v1',
  adapter: 'agoragentic.risk-fork.framework-tool-adapter.v1',
  receipt: 'agoragentic.risk-fork.framework-tool-receipt.v1',
});

export const RISK_FORK_FRAMEWORK_DIAGNOSTIC_CODES = Object.freeze({
  DISABLED: 'RISK_FORK_FRAMEWORK_ADAPTER_DISABLED',
  BOUNDARY_REQUIRED: 'RISK_FORK_FRAMEWORK_BOUNDARY_REQUIRED',
  PLAN_SOURCE_REQUIRED: 'RISK_FORK_FRAMEWORK_PLAN_SOURCE_REQUIRED',
  EXECUTOR_REQUIRED: 'RISK_FORK_FRAMEWORK_EXECUTOR_REQUIRED',
  ARGUMENTS_INVALID: 'RISK_FORK_FRAMEWORK_ARGUMENTS_INVALID',
  PLAN_REJECTED: 'RISK_FORK_FRAMEWORK_PLAN_REJECTED',
  BOUNDARY_REJECTED: 'RISK_FORK_FRAMEWORK_BOUNDARY_REJECTED',
  RESULT_REJECTED: 'RISK_FORK_FRAMEWORK_RESULT_REJECTED',
  OPTIONAL_FORK_BLOCKED: 'RISK_FORK_FRAMEWORK_OPTIONAL_FORK_BLOCKED',
  DIRECT_EFFECT_AMBIGUOUS: 'RISK_FORK_FRAMEWORK_DIRECT_EFFECT_AMBIGUOUS',
  PREPARED_PROVENANCE_INVALID: 'RISK_FORK_FRAMEWORK_PREPARED_PROVENANCE_INVALID',
  COMMIT_REJECTED: 'RISK_FORK_FRAMEWORK_COMMIT_REJECTED',
});

const MAX_FRAMEWORK_JSON_BYTES = 1024 * 1024;
const REQUEST_KEYS = Object.freeze([
  'schema',
  'request_id',
  'framework',
  'tool_name',
  'descriptor_ref',
  'arguments',
  'requested_at',
  'request_hash',
]);
const PLAN_KEYS = Object.freeze([
  'schema',
  'request_hash',
  'descriptor_ref',
  'operation_input',
  'plan_hash',
]);
const RISK_LABEL_FINGERPRINTS = new Set([
  'classification',
  'severity',
  'minimumlevel',
  'forceoptionalfork',
  'forceriskfork',
  'ownerpolicy',
  'toolannotations',
  'capabilities',
  'mcpservertrust',
  'promptinjectionindicators',
]);

const trustedPlanSourceCallbacks = new WeakMap();
const trustedExecutorCallbacks = new WeakMap();
const frameworkAdapterRecords = new WeakMap();
const preparedReceiptRecords = new WeakMap();

function frameworkError(code, message, _cause) {
  // Callback and provider errors can contain credentials, endpoints, or private
  // host state. Preserve only the closed diagnostic code and generic message.
  return new RiskForkFrameworkAdapterError(code, message);
}

export class RiskForkFrameworkAdapterError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'RiskForkFrameworkAdapterError';
    this.code = code;
  }
}

function assertPlainDataObject(value, field, allowedKeys = null) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || utilTypes.isProxy(value)) {
    throw new TypeError(`${field} must be a plain data-only object`);
  }
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    throw new TypeError(`${field} must be a plain data-only object`);
  }
  if (Object.getOwnPropertySymbols(value).length > 0) {
    throw new TypeError(`${field} must not contain symbol keys`);
  }
  const descriptors = Object.getOwnPropertyDescriptors(value);
  for (const [key, descriptor] of Object.entries(descriptors)) {
    if (!descriptor.enumerable || descriptor.get || descriptor.set) {
      throw new TypeError(`${field}.${key} must be an enumerable data property`);
    }
  }
  if (allowedKeys) assertAllowedKeys(value, allowedKeys, field);
  return descriptors;
}

function riskKeyFingerprint(value) {
  return String(value).normalize('NFKC').replace(/[^A-Za-z0-9]+/g, '').toLowerCase();
}

function assertNoCallerRiskLabels(value, field) {
  const seen = new WeakSet();
  function walk(current, path) {
    if (!current || typeof current !== 'object') return;
    if (seen.has(current)) return;
    seen.add(current);
    if (Array.isArray(current)) {
      for (let index = 0; index < current.length; index += 1) {
        walk(current[index], `${path}[${index}]`);
      }
      return;
    }
    for (const [key, child] of Object.entries(current)) {
      const fingerprint = riskKeyFingerprint(key);
      if (fingerprint.startsWith('risk') || RISK_LABEL_FINGERPRINTS.has(fingerprint)) {
        throw frameworkError(
          RISK_FORK_FRAMEWORK_DIAGNOSTIC_CODES.ARGUMENTS_INVALID,
          'Framework tool arguments must not supply risk or policy labels',
        );
      }
      walk(child, `${path}.${key}`);
    }
  }
  walk(value, field);
}

function assertOrdinaryJsonTree(value, field) {
  const seen = new WeakSet();
  function walk(current, path) {
    if (current === null || typeof current !== 'object') return;
    if (utilTypes.isProxy(current) || seen.has(current)) {
      throw new TypeError(`${path} must contain only ordinary, unshared JSON values`);
    }
    seen.add(current);
    const prototype = Object.getPrototypeOf(current);
    if ((Array.isArray(current) && prototype !== Array.prototype)
      || (!Array.isArray(current) && prototype !== Object.prototype && prototype !== null)) {
      throw new TypeError(`${path} contains a non-plain object`);
    }
    if (Object.getOwnPropertySymbols(current).length > 0) {
      throw new TypeError(`${path} contains a symbol key`);
    }
    const descriptors = Object.getOwnPropertyDescriptors(current);
    for (const [key, descriptor] of Object.entries(descriptors)) {
      if (Array.isArray(current) && key === 'length') continue;
      if (!descriptor.enumerable || descriptor.get || descriptor.set) {
        throw new TypeError(`${path}.${key} is not an enumerable data property`);
      }
    }
    if (Array.isArray(current)) {
      if (Object.keys(current).length !== current.length) {
        throw new TypeError(`${path} is sparse or extended`);
      }
      for (let index = 0; index < current.length; index += 1) {
        if (!Object.hasOwn(current, index)) throw new TypeError(`${path} is sparse`);
        walk(descriptors[String(index)].value, `${path}[${index}]`);
      }
      return;
    }
    for (const [key, descriptor] of Object.entries(descriptors)) {
      walk(descriptor.value, `${path}.${key}`);
    }
  }
  walk(value, field);
}

function canonicalObject(value, field) {
  assertOrdinaryJsonTree(value, field);
  assertCanonicalJson(value);
  const serialized = canonicalize(value);
  if (Buffer.byteLength(serialized, 'utf8') > MAX_FRAMEWORK_JSON_BYTES) {
    throw new TypeError(`${field} exceeds ${MAX_FRAMEWORK_JSON_BYTES} bytes`);
  }
  const clone = JSON.parse(serialized);
  assertPlainObject(clone, field);
  return deepFreeze(clone);
}

function normalizeArguments(value) {
  const candidate = value === undefined ? {} : value;
  try {
    assertPlainDataObject(candidate, 'framework tool arguments');
    assertOrdinaryJsonTree(candidate, 'framework tool arguments');
    assertNoCallerRiskLabels(candidate, 'framework tool arguments');
    const envelope = validateChildOperation({
      kind: 'framework_tool_arguments',
      arguments: candidate,
    }, 'framework tool arguments');
    return envelope.arguments;
  } catch (error) {
    if (error instanceof RiskForkFrameworkAdapterError) throw error;
    throw frameworkError(
      RISK_FORK_FRAMEWORK_DIAGNOSTIC_CODES.ARGUMENTS_INVALID,
      'Framework tool arguments are not bounded authority-free JSON',
      error,
    );
  }
}

function verifyRequest(value) {
  const request = canonicalObject(value, 'framework tool request');
  assertAllowedKeys(request, REQUEST_KEYS, 'framework tool request');
  if (request.schema !== RISK_FORK_FRAMEWORK_SCHEMAS.request) {
    throw new TypeError('framework tool request schema is invalid');
  }
  const normalized = {
    schema: RISK_FORK_FRAMEWORK_SCHEMAS.request,
    request_id: requireOpaqueRef(request.request_id, 'framework tool request_id'),
    framework: requireEnum(request.framework, RISK_FORK_FRAMEWORKS, 'framework'),
    tool_name: requireOpaqueRef(request.tool_name, 'framework tool_name', { maxLength: 300 }),
    descriptor_ref: requireOpaqueRef(request.descriptor_ref, 'framework descriptor_ref'),
    arguments: normalizeArguments(request.arguments),
    requested_at: requireIsoDate(request.requested_at, 'framework requested_at'),
    request_hash: requireSha256Ref(request.request_hash, 'framework request_hash'),
  };
  const expectedHash = sha256Ref({ ...normalized, request_hash: null });
  if (!safeEqual(normalized.request_hash, expectedHash)) {
    throw new TypeError('framework tool request hash mismatch');
  }
  return deepFreeze(normalized);
}

function normalizePlan(value, request) {
  const plan = canonicalObject(value, 'framework tool plan');
  assertAllowedKeys(plan, PLAN_KEYS, 'framework tool plan');
  if (plan.schema !== RISK_FORK_FRAMEWORK_SCHEMAS.plan) {
    throw new TypeError('framework tool plan schema is invalid');
  }
  const operationInput = canonicalObject(
    plan.operation_input,
    'framework tool plan.operation_input',
  );
  if (!Object.hasOwn(operationInput, 'effective_arguments')) {
    throw new TypeError('framework tool plan requires host-derived effective_arguments');
  }
  const normalizedOperationInput = canonicalObject({
    ...operationInput,
    effective_arguments: normalizeArguments(operationInput.effective_arguments),
  }, 'framework tool plan.operation_input');
  const normalized = {
    schema: RISK_FORK_FRAMEWORK_SCHEMAS.plan,
    request_hash: requireSha256Ref(plan.request_hash, 'framework tool plan.request_hash'),
    descriptor_ref: requireOpaqueRef(plan.descriptor_ref, 'framework tool plan.descriptor_ref'),
    operation_input: normalizedOperationInput,
    plan_hash: requireSha256Ref(plan.plan_hash, 'framework tool plan.plan_hash'),
  };
  if (!safeEqual(normalized.request_hash, request.request_hash)
    || normalized.descriptor_ref !== request.descriptor_ref) {
    throw new TypeError('framework tool plan does not bind the exact request');
  }
  const expectedHash = sha256Ref({ ...normalized, plan_hash: null });
  if (!safeEqual(normalized.plan_hash, expectedHash)) {
    throw new TypeError('framework tool plan hash mismatch');
  }
  return deepFreeze(normalized);
}

function normalizeRiskDecision(value) {
  const decision = canonicalObject(value, 'Risk Fork risk decision');
  const level = requireEnum(decision.level, RISK_LEVELS, 'Risk Fork risk level');
  if (decision.action !== RISK_ACTIONS[level] || typeof decision.blocked !== 'boolean') {
    throw new TypeError('Risk Fork risk decision level, action, and block status disagree');
  }
  const decisionHash = requireSha256Ref(decision.decision_hash, 'Risk Fork decision_hash');
  if (!safeEqual(decisionHash, sha256Ref({ ...decision, decision_hash: null }))) {
    throw new TypeError('Risk Fork risk decision hash mismatch');
  }
  return deepFreeze({
    level,
    action: decision.action,
    blocked: decision.blocked,
    decision_hash: decisionHash,
  });
}

function normalizePreEffectResult(value, request, plan) {
  assertPlainDataObject(value, 'Risk Fork host pre-effect result', [
    'schema',
    'descriptor_ref',
    'descriptor_hash',
    'operation_hash',
    'prepared',
    'authority_granted',
    'provider_handle_exposed',
  ]);
  if (value.schema !== 'agoragentic.risk-fork.host-pre-effect-result.v1'
    || value.descriptor_ref !== request.descriptor_ref
    || value.descriptor_ref !== plan.descriptor_ref
    || value.authority_granted !== false
    || value.provider_handle_exposed !== false
    || !safeEqual(value.operation_hash, sha256Ref(plan.operation_input))) {
    throw new TypeError('Risk Fork host result does not bind the exact framework operation');
  }
  requireSha256Ref(value.descriptor_hash, 'Risk Fork host descriptor_hash');
  assertPlainDataObject(value.prepared, 'Risk Fork prepared result');
  if (value.prepared.authority_granted !== false) {
    throw new TypeError('Risk Fork prepared result must not grant authority');
  }
  const riskDecision = normalizeRiskDecision(value.prepared.risk_decision);
  const mode = requireEnum(value.prepared.mode, [
    'denied',
    'direct_permitted',
    'fork_optional',
    'prepared_for_clean_commit',
  ], 'Risk Fork prepared mode');
  if ((mode === 'denied') !== riskDecision.blocked
    || (mode === 'direct_permitted' && riskDecision.level !== 'LOW')
    || (mode === 'fork_optional' && riskDecision.level !== 'ELEVATED')
    || (mode === 'prepared_for_clean_commit'
      && !['ELEVATED', 'HIGH', 'IRREVERSIBLE'].includes(riskDecision.level))) {
    throw new TypeError('Risk Fork prepared mode disagrees with deterministic risk evidence');
  }
  return { mode, riskDecision };
}

function normalizeDirectResult(value) {
  const candidate = value === undefined ? null : value;
  try {
    assertOrdinaryJsonTree(candidate, 'framework direct result');
    const envelope = validateChildOperation({
      kind: 'framework_direct_result',
      result: candidate,
    }, 'framework direct result');
    return envelope.result;
  } catch (error) {
    throw frameworkError(
      RISK_FORK_FRAMEWORK_DIAGNOSTIC_CODES.RESULT_REJECTED,
      'Framework direct result is not bounded authority-free JSON',
      error,
    );
  }
}

function makeReceipt({ request, preEffectResult, mode, riskDecision, status, result = null }) {
  const receipt = {
    schema: RISK_FORK_FRAMEWORK_SCHEMAS.receipt,
    status,
    framework: request.framework,
    tool_name: request.tool_name,
    request_hash: request.request_hash,
    descriptor_ref: request.descriptor_ref,
    descriptor_hash: preEffectResult.descriptor_hash,
    operation_hash: preEffectResult.operation_hash,
    risk_decision: riskDecision,
    preparation_mode: mode,
    result,
    clean_commit_required: mode === 'prepared_for_clean_commit',
    authority_granted: false,
    provider_handle_exposed: false,
    live_traffic_protected: false,
    retry_allowed: false,
    receipt_hash: null,
  };
  receipt.receipt_hash = sha256Ref(receipt);
  return deepFreeze(receipt);
}

function cloneCommitInput(value) {
  const descriptors = assertPlainDataObject(value, 'Risk Fork clean commit input');
  if (Object.hasOwn(descriptors, 'executeAction')) {
    throw new TypeError('executeAction is fixed by the trusted framework executor');
  }
  return Object.fromEntries(Object.entries(descriptors).map(([key, descriptor]) => [key, descriptor.value]));
}

export function createTrustedRiskForkFrameworkPlanSource(resolvePlan) {
  if (typeof resolvePlan !== 'function') {
    throw new TypeError('Trusted Risk Fork framework plan source requires a host callback');
  }
  const source = Object.freeze({
    schema: RISK_FORK_FRAMEWORK_SCHEMAS.planSource,
    trust_mode: 'host_callback_identity',
  });
  trustedPlanSourceCallbacks.set(source, resolvePlan);
  return source;
}

export function createRiskForkFrameworkToolPlan(requestValue, input = {}) {
  const request = verifyRequest(requestValue);
  assertPlainDataObject(input, 'framework tool plan input', ['operation_input']);
  const plan = {
    schema: RISK_FORK_FRAMEWORK_SCHEMAS.plan,
    request_hash: request.request_hash,
    descriptor_ref: request.descriptor_ref,
    operation_input: canonicalObject(input.operation_input, 'framework tool plan.operation_input'),
    plan_hash: null,
  };
  plan.plan_hash = sha256Ref(plan);
  return normalizePlan(plan, request);
}

export function createTrustedRiskForkFrameworkExecutor(input = {}) {
  const descriptors = assertPlainDataObject(input, 'trusted framework executor', [
    'execute_direct',
    'execute_prepared_action',
    'retain_prepared',
  ]);
  const executeDirectCallback = descriptors.execute_direct?.value;
  const executePreparedActionCallback = descriptors.execute_prepared_action?.value;
  const retainPreparedCallback = descriptors.retain_prepared?.value;
  if (typeof executeDirectCallback !== 'function'
    || typeof executePreparedActionCallback !== 'function'
    || typeof retainPreparedCallback !== 'function') {
    throw new TypeError(
      'Trusted framework executor requires execute_direct, execute_prepared_action, and retain_prepared callbacks',
    );
  }
  const executor = Object.freeze({
    schema: RISK_FORK_FRAMEWORK_SCHEMAS.executor,
    trust_mode: 'host_callback_identity',
  });
  trustedExecutorCallbacks.set(executor, Object.freeze({
    executeDirect: executeDirectCallback.bind(input),
    executePreparedAction: executePreparedActionCallback.bind(input),
    retainPrepared: retainPreparedCallback.bind(input),
  }));
  return executor;
}

export function createRiskForkFrameworkToolAdapter(input = {}) {
  const descriptors = assertPlainDataObject(input, 'Risk Fork framework adapter input', [
    'enabled',
    'framework',
    'tool_name',
    'descriptor_ref',
    'host_boundary',
    'trusted_plan_source',
    'trusted_executor',
    'clock',
  ]);
  const enabled = descriptors.enabled === undefined ? false : descriptors.enabled.value;
  if (typeof enabled !== 'boolean') throw new TypeError('Risk Fork framework enabled must be a boolean');
  const framework = requireEnum(descriptors.framework?.value, RISK_FORK_FRAMEWORKS, 'framework');
  const toolName = requireOpaqueRef(
    descriptors.tool_name?.value,
    'Risk Fork framework tool_name',
    { maxLength: 300 },
  );
  const descriptorRef = requireOpaqueRef(
    descriptors.descriptor_ref?.value,
    'Risk Fork framework descriptor_ref',
  );
  const hostBoundary = descriptors.host_boundary?.value;
  const planSource = descriptors.trusted_plan_source?.value;
  const executor = descriptors.trusted_executor?.value;
  const clock = descriptors.clock?.value ?? (() => new Date());
  if (typeof clock !== 'function') throw new TypeError('Risk Fork framework clock is invalid');
  if (hostBoundary !== undefined && !isRiskForkHostBoundary(hostBoundary)) {
    throw frameworkError(
      RISK_FORK_FRAMEWORK_DIAGNOSTIC_CODES.BOUNDARY_REQUIRED,
      'Risk Fork framework adapter requires the exact factory-created host boundary',
    );
  }
  const resolvePlan = trustedPlanSourceCallbacks.get(planSource);
  if (planSource !== undefined && !resolvePlan) {
    throw frameworkError(
      RISK_FORK_FRAMEWORK_DIAGNOSTIC_CODES.PLAN_SOURCE_REQUIRED,
      'Risk Fork framework adapter requires the exact host-owned plan source',
    );
  }
  const executorCallbacks = trustedExecutorCallbacks.get(executor);
  if (executor !== undefined && !executorCallbacks) {
    throw frameworkError(
      RISK_FORK_FRAMEWORK_DIAGNOSTIC_CODES.EXECUTOR_REQUIRED,
      'Risk Fork framework adapter requires the exact host-owned executor',
    );
  }
  if (enabled && !hostBoundary) {
    throw frameworkError(
      RISK_FORK_FRAMEWORK_DIAGNOSTIC_CODES.BOUNDARY_REQUIRED,
      'Enabled Risk Fork framework adapter has no host boundary',
    );
  }
  if (enabled && !resolvePlan) {
    throw frameworkError(
      RISK_FORK_FRAMEWORK_DIAGNOSTIC_CODES.PLAN_SOURCE_REQUIRED,
      'Enabled Risk Fork framework adapter has no trusted plan source',
    );
  }
  if (enabled && !executorCallbacks) {
    throw frameworkError(
      RISK_FORK_FRAMEWORK_DIAGNOSTIC_CODES.EXECUTOR_REQUIRED,
      'Enabled Risk Fork framework adapter has no trusted executor',
    );
  }

  const status = deepFreeze({
    framework,
    tool_name: toolName,
    enabled,
    source_only: true,
    default_on: false,
    host_boundary_bound: Boolean(hostBoundary),
    trusted_plan_source_bound: Boolean(resolvePlan),
    trusted_executor_bound: Boolean(executorCallbacks),
    executor_qualified: false,
    framework_interception_verified: false,
    direct_tool_callback_exposed: false,
    clean_commit_exposed_to_framework: false,
    bundled_provider: false,
    provider_qualified: false,
    production_authority_granted: false,
    live_traffic_protected: false,
  });

  const adapter = Object.freeze({
    schema: RISK_FORK_FRAMEWORK_SCHEMAS.adapter,
    mode: enabled ? 'host_owned_pre_effect_and_execution' : 'disabled_fail_closed',
    status,
    invoke: async (argumentsValue = {}) => {
      const record = frameworkAdapterRecords.get(adapter);
      if (!record?.enabled) {
        throw frameworkError(
          RISK_FORK_FRAMEWORK_DIAGNOSTIC_CODES.DISABLED,
          'Risk Fork framework adapter is disabled; the tool call was not executed',
        );
      }
      const argumentsObject = normalizeArguments(argumentsValue);
      const request = {
        schema: RISK_FORK_FRAMEWORK_SCHEMAS.request,
        request_id: `risk-fork-framework:${randomUUID()}`,
        framework: record.framework,
        tool_name: record.toolName,
        descriptor_ref: record.descriptorRef,
        arguments: argumentsObject,
        requested_at: requireIsoDate(record.clock(), 'Risk Fork framework clock result'),
        request_hash: null,
      };
      request.request_hash = sha256Ref(request);
      const frozenRequest = verifyRequest(request);
      let planValue;
      try {
        planValue = await record.resolvePlan(frozenRequest);
      } catch (error) {
        throw frameworkError(
          RISK_FORK_FRAMEWORK_DIAGNOSTIC_CODES.PLAN_REJECTED,
          'Trusted framework plan source did not produce an enforceable plan',
          error,
        );
      }
      let plan;
      try {
        plan = normalizePlan(planValue, frozenRequest);
      } catch (error) {
        throw frameworkError(
          RISK_FORK_FRAMEWORK_DIAGNOSTIC_CODES.PLAN_REJECTED,
          'Trusted framework plan failed request-binding validation',
          error,
        );
      }
      let preEffectResult;
      try {
        preEffectResult = await record.preEffect({
          descriptor_ref: record.descriptorRef,
          operation_input: plan.operation_input,
        });
      } catch (error) {
        throw frameworkError(
          RISK_FORK_FRAMEWORK_DIAGNOSTIC_CODES.BOUNDARY_REJECTED,
          'Risk Fork host boundary rejected the framework tool call',
          error,
        );
      }
      let normalized;
      try {
        normalized = normalizePreEffectResult(preEffectResult, frozenRequest, plan);
      } catch (error) {
        throw frameworkError(
          RISK_FORK_FRAMEWORK_DIAGNOSTIC_CODES.RESULT_REJECTED,
          'Risk Fork host boundary returned an invalid or mismatched result',
          error,
        );
      }
      if (normalized.mode === 'fork_optional') {
        throw frameworkError(
          RISK_FORK_FRAMEWORK_DIAGNOSTIC_CODES.OPTIONAL_FORK_BLOCKED,
          'Elevated framework tool calls are blocked unless the host actually prepares a Risk Fork',
        );
      }
      if (normalized.mode === 'direct_permitted') {
        let directValue;
        try {
          directValue = await record.executeDirect(
            plan.operation_input.effective_arguments,
            deepFreeze({
              schema: 'agoragentic.risk-fork.framework-direct-execution-context.v1',
              framework: record.framework,
              tool_name: record.toolName,
              descriptor_ref: record.descriptorRef,
              request_hash: frozenRequest.request_hash,
              decision_hash: normalized.riskDecision.decision_hash,
              caller_arguments_hash: sha256Ref(argumentsObject),
              effective_arguments_hash: sha256Ref(plan.operation_input.effective_arguments),
            }),
          );
        } catch (error) {
          return makeReceipt({
            request: frozenRequest,
            preEffectResult,
            mode: normalized.mode,
            riskDecision: normalized.riskDecision,
            status: 'direct_effect_ambiguous',
          });
        }
        let result;
        try {
          result = normalizeDirectResult(directValue);
        } catch (error) {
          return makeReceipt({
            request: frozenRequest,
            preEffectResult,
            mode: normalized.mode,
            riskDecision: normalized.riskDecision,
            status: 'direct_effect_ambiguous',
          });
        }
        const receipt = makeReceipt({
          request: frozenRequest,
          preEffectResult,
          mode: normalized.mode,
          riskDecision: normalized.riskDecision,
          status: 'direct_effect_completed',
          result,
        });
        return receipt;
      }
      const receipt = makeReceipt({
        request: frozenRequest,
        preEffectResult,
        mode: normalized.mode,
        riskDecision: normalized.riskDecision,
        status: normalized.mode === 'denied' ? 'blocked' : 'prepared_for_clean_commit',
      });
      if (normalized.mode === 'prepared_for_clean_commit') {
        preparedReceiptRecords.set(receipt, Object.freeze({ adapter, preEffectResult }));
        try {
          await record.retainPrepared(receipt);
        } catch (error) {
          preparedReceiptRecords.delete(receipt);
          throw frameworkError(
            RISK_FORK_FRAMEWORK_DIAGNOSTIC_CODES.RESULT_REJECTED,
            'The trusted host did not retain the exact prepared receipt; clean commit remains blocked',
            error,
          );
        }
      }
      return receipt;
    },
    commitPrepared: async (receipt, cleanCommitInput = {}) => {
      const record = frameworkAdapterRecords.get(adapter);
      if (!record?.enabled) {
        throw frameworkError(
          RISK_FORK_FRAMEWORK_DIAGNOSTIC_CODES.DISABLED,
          'Risk Fork framework adapter is disabled; clean commit is unavailable',
        );
      }
      const provenance = preparedReceiptRecords.get(receipt);
      if (!provenance || provenance.adapter !== adapter) {
        throw frameworkError(
          RISK_FORK_FRAMEWORK_DIAGNOSTIC_CODES.PREPARED_PROVENANCE_INVALID,
          'Clean commit requires the exact in-memory receipt from this framework adapter',
        );
      }
      let inputClone;
      try {
        inputClone = cloneCommitInput(cleanCommitInput);
      } catch (error) {
        throw frameworkError(
          RISK_FORK_FRAMEWORK_DIAGNOSTIC_CODES.COMMIT_REJECTED,
          'Risk Fork clean commit input is invalid',
          error,
        );
      }
      // Enter a one-use commit attempt immediately before calling the host. A
      // failure can be ambiguous once the clean executor starts, so automatic
      // retry is never safe merely because the callback rejected.
      preparedReceiptRecords.delete(receipt);
      try {
        return await record.commitPrepared(provenance.preEffectResult, {
          ...inputClone,
          executeAction: record.executePreparedAction,
        });
      } catch (error) {
        throw frameworkError(
          RISK_FORK_FRAMEWORK_DIAGNOSTIC_CODES.COMMIT_REJECTED,
          'Risk Fork clean commit did not complete safely',
          error,
        );
      }
    },
  });
  frameworkAdapterRecords.set(adapter, Object.freeze({
    enabled,
    framework,
    toolName,
    descriptorRef,
    clock,
    resolvePlan,
    preEffect: hostBoundary?.preEffect.bind(hostBoundary),
    commitPrepared: hostBoundary?.commitPrepared.bind(hostBoundary),
    executeDirect: executorCallbacks?.executeDirect,
    executePreparedAction: executorCallbacks?.executePreparedAction,
    retainPrepared: executorCallbacks?.retainPrepared,
  }));
  return adapter;
}

export function isRiskForkFrameworkToolAdapter(value) {
  return frameworkAdapterRecords.has(value);
}
