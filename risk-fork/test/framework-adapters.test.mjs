import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

import {
  RISK_FORK_FRAMEWORK_DIAGNOSTIC_CODES,
  RiskForkFrameworkAdapterError,
  createRiskForkFrameworkToolAdapter,
  createRiskForkFrameworkToolPlan,
  createTrustedRiskForkFrameworkExecutor,
  createTrustedRiskForkFrameworkPlanSource,
  isRiskForkFrameworkToolAdapter,
} from '../src/framework-tool-adapter.mjs';
import { createOpenAIAgentsRiskForkTool } from '../src/frameworks/openai-agents.mjs';
import { createLangChainRiskForkTool } from '../src/frameworks/langchain.mjs';
import { createLangGraphRiskForkNode } from '../src/frameworks/langgraph.mjs';
import { RISK_ACTIONS } from '../src/constants.mjs';
import {
  createRiskForkHostBoundary,
  createTrustedRiskDescriptor,
  createTrustedRiskDescriptorSource,
} from '../src/host-boundary.mjs';
import { sha256Ref } from '../src/canonical.mjs';

const NOW = '2026-09-05T15:00:00.000Z';

function completeCapabilities(overrides = {}) {
  return {
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
    ...overrides,
  };
}

function completeAnnotations(overrides = {}) {
  return {
    readOnlyHint: false,
    destructiveHint: true,
    idempotentHint: false,
    openWorldHint: true,
    ...overrides,
  };
}

function completeOwnerPolicy(overrides = {}) {
  return {
    minimum_level: 'LOW',
    force_risk_fork: false,
    deny_irreversible: false,
    trusted_server_refs: [],
    trusted_attestor_refs: [],
    trusted_attestation_hashes: [],
    trust_registry_version: null,
    allowed_egress: [],
    ...overrides,
  };
}

function riskDecision(level, riskInput, { blocked = false } = {}) {
  const decision = {
    schema: 'test.risk-decision.v1',
    request_id: riskInput.request_id,
    level,
    action: RISK_ACTIONS[level],
    blocked,
    reasons: [`test:${level.toLowerCase()}`],
    normalized_input: riskInput,
    decision_hash: null,
  };
  decision.decision_hash = sha256Ref(decision);
  return decision;
}

function makeHarness({
  framework = 'openai-agents',
  level = 'IRREVERSIBLE',
  enabled = true,
  planTransform = (plan) => plan,
  executeDirect = async (args) => ({ ok: true, args }),
  retainPrepared = async () => {},
  preparationMode = null,
  effectiveArgumentsTransform = (args) => args,
} = {}) {
  const calls = {
    descriptor: [],
    plan: [],
    prepare: [],
    direct: [],
    preparedAction: [],
    retained: [],
    commit: [],
  };
  const toolName = `${framework.replaceAll('-', '_')}_effect`;
  const descriptorRef = `descriptor:${toolName}`;
  const descriptorSource = createTrustedRiskDescriptorSource((request) => {
    calls.descriptor.push(request);
    return createTrustedRiskDescriptor(request, {
      mcp_phase: 'tools/call',
      raw_method: null,
      mcp_server_ref: `framework:${framework}`,
      mcp_server_origin: 'https://framework.example.test',
      mcp_server_trust: 'reachable',
      mcp_server_attestation: null,
      tool_name: toolName,
      tool_annotations: completeAnnotations(level === 'LOW' ? {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      } : {}),
      capabilities: completeCapabilities(level === 'IRREVERSIBLE' ? {
        communication: true,
        external_side_effect: true,
      } : level === 'HIGH' ? {
        filesystem_write: true,
      } : {}),
      prompt_injection_indicators: [],
      owner_policy: completeOwnerPolicy(),
    });
  });
  const controller = {
    async prepare(input) {
      calls.prepare.push(input);
      const mode = preparationMode ?? (level === 'LOW'
        ? 'direct_permitted'
        : level === 'ELEVATED'
          ? 'fork_optional'
          : 'prepared_for_clean_commit');
      return {
        mode,
        risk_decision: riskDecision(level, input.risk_input),
        authority_granted: false,
      };
    },
    async commit(prepared, input) {
      calls.commit.push({ prepared, input });
      return input.executeAction(
        { kind: 'framework_effect', value: 'approved' },
        { binding: { test: true } },
      );
    },
  };
  const boundary = createRiskForkHostBoundary({
    controller,
    trusted_descriptor_source: descriptorSource,
    clock: () => NOW,
  });
  const planSource = createTrustedRiskForkFrameworkPlanSource((request) => {
    calls.plan.push(request);
    const operationArguments = JSON.parse(JSON.stringify(request.arguments));
    const effectiveArguments = effectiveArgumentsTransform(
      JSON.parse(JSON.stringify(request.arguments)),
    );
    const plan = createRiskForkFrameworkToolPlan(request, {
      operation_input: {
        operation: {
          kind: 'framework_tool_call',
          arguments: operationArguments,
        },
        effective_arguments: effectiveArguments,
        expected_commit_type: 'CONSEQUENTIAL_ACTION_PROPOSAL',
      },
    });
    return planTransform(plan, request);
  });
  const executor = createTrustedRiskForkFrameworkExecutor({
    async execute_direct(args, context) {
      calls.direct.push({ args, context });
      return executeDirect(args, context);
    },
    execute_prepared_action(action, context) {
      calls.preparedAction.push({ action, context });
      return { committed: true, action };
    },
    async retain_prepared(receipt) {
      calls.retained.push(receipt);
      return retainPrepared(receipt);
    },
  });
  const adapter = createRiskForkFrameworkToolAdapter({
    enabled,
    framework,
    tool_name: toolName,
    descriptor_ref: descriptorRef,
    host_boundary: boundary,
    trusted_plan_source: planSource,
    trusted_executor: executor,
    clock: () => NOW,
  });
  return { adapter, boundary, planSource, executor, calls, toolName, descriptorRef };
}

test('framework adapters are default-off and fail before any host callback', async () => {
  const adapter = createRiskForkFrameworkToolAdapter({
    framework: 'openai-agents',
    tool_name: 'send_email',
    descriptor_ref: 'descriptor:send-email',
  });
  assert.equal(adapter.status.enabled, false);
  assert.equal(adapter.status.default_on, false);
  assert.equal(adapter.status.live_traffic_protected, false);
  assert.equal(isRiskForkFrameworkToolAdapter(adapter), true);
  await assert.rejects(
    adapter.invoke({ to: 'person@example.test' }),
    (error) => error instanceof RiskForkFrameworkAdapterError
      && error.code === RISK_FORK_FRAMEWORK_DIAGNOSTIC_CODES.DISABLED,
  );
});

test('enabled adapters reject missing and structural boundary capabilities', () => {
  assert.throws(
    () => createRiskForkFrameworkToolAdapter({
      enabled: true,
      framework: 'langchain',
      tool_name: 'publish',
      descriptor_ref: 'descriptor:publish',
    }),
    (error) => error.code === RISK_FORK_FRAMEWORK_DIAGNOSTIC_CODES.BOUNDARY_REQUIRED,
  );
  const current = makeHarness({ framework: 'langchain' });
  assert.throws(
    () => createRiskForkFrameworkToolAdapter({
      enabled: true,
      framework: 'langchain',
      tool_name: current.toolName,
      descriptor_ref: current.descriptorRef,
      host_boundary: { ...current.boundary },
      trusted_plan_source: current.planSource,
      trusted_executor: current.executor,
    }),
    (error) => error.code === RISK_FORK_FRAMEWORK_DIAGNOSTIC_CODES.BOUNDARY_REQUIRED,
  );
});

test('enabled adapters reject structural plan sources and executors', () => {
  const current = makeHarness({ framework: 'langchain' });
  assert.throws(
    () => createRiskForkFrameworkToolAdapter({
      enabled: true,
      framework: 'langchain',
      tool_name: current.toolName,
      descriptor_ref: current.descriptorRef,
      host_boundary: current.boundary,
      trusted_plan_source: { ...current.planSource },
      trusted_executor: current.executor,
    }),
    (error) => error.code === RISK_FORK_FRAMEWORK_DIAGNOSTIC_CODES.PLAN_SOURCE_REQUIRED,
  );
  assert.throws(
    () => createRiskForkFrameworkToolAdapter({
      enabled: true,
      framework: 'langchain',
      tool_name: current.toolName,
      descriptor_ref: current.descriptorRef,
      host_boundary: current.boundary,
      trusted_plan_source: current.planSource,
      trusted_executor: { ...current.executor },
    }),
    (error) => error.code === RISK_FORK_FRAMEWORK_DIAGNOSTIC_CODES.EXECUTOR_REQUIRED,
  );
});

test('OpenAI Agents function tool keeps approval on and retains high-risk work for clean commit', async () => {
  const current = makeHarness({ framework: 'openai-agents', level: 'IRREVERSIBLE' });
  const toolAdapter = createOpenAIAgentsRiskForkTool({ enforcement: current.adapter });
  const ignoredContext = new Proxy({}, {
    get() {
      throw new Error('SDK context must not be copied into Risk Fork input');
    },
  });
  assert.equal(Object.isFrozen(toolAdapter), true);
  assert.equal(toolAdapter.needsApproval, true);
  assert.equal('enforcement' in toolAdapter, false);
  const receipt = await toolAdapter.execute({ to: 'person@example.test' }, ignoredContext);
  assert.equal(receipt.status, 'prepared_for_clean_commit');
  assert.equal(receipt.risk_decision.level, 'IRREVERSIBLE');
  assert.equal(receipt.authority_granted, false);
  assert.equal(receipt.provider_handle_exposed, false);
  assert.equal(receipt.result, null);
  assert.equal(current.calls.plan.length, 1);
  assert.equal(current.calls.prepare.length, 1);
  assert.equal(current.calls.direct.length, 0);
  assert.equal(current.calls.retained[0], receipt);
  assert.deepEqual(current.calls.plan[0].arguments, { to: 'person@example.test' });
  assert.equal(Object.hasOwn(current.calls.plan[0], 'run_context'), false);

  await assert.rejects(
    current.adapter.commitPrepared({ ...receipt }, {}),
    (error) => error.code
      === RISK_FORK_FRAMEWORK_DIAGNOSTIC_CODES.PREPARED_PROVENANCE_INVALID,
  );
  const committed = await current.adapter.commitPrepared(receipt, {});
  assert.equal(committed.committed, true);
  assert.equal(current.calls.preparedAction.length, 1);
  await assert.rejects(
    current.adapter.commitPrepared(receipt, {}),
    (error) => error.code
      === RISK_FORK_FRAMEWORK_DIAGNOSTIC_CODES.PREPARED_PROVENANCE_INVALID,
  );
});

test('LangChain handler runs only a LOW decision through the hidden direct executor', async () => {
  const current = makeHarness({ framework: 'langchain', level: 'LOW' });
  const toolAdapter = createLangChainRiskForkTool({ enforcement: current.adapter });
  const ignoredConfig = new Proxy({}, {
    get() {
      throw new Error('RunnableConfig must not be copied into Risk Fork input');
    },
  });
  const receipt = await toolAdapter.handler({ query: 'public status' }, ignoredConfig);
  assert.equal(receipt.status, 'direct_effect_completed');
  assert.equal(receipt.risk_decision.level, 'LOW');
  assert.deepEqual(receipt.result, { args: { query: 'public status' }, ok: true });
  assert.equal(current.calls.direct.length, 1);
  assert.deepEqual(current.calls.direct[0].args, { query: 'public status' });
  assert.equal(current.calls.retained.length, 0);
});

test('LOW direct execution uses host-derived effective arguments, not raw caller arguments', async () => {
  const current = makeHarness({
    framework: 'langchain',
    level: 'LOW',
    effectiveArgumentsTransform(args) {
      return { message: args.message.trim() };
    },
  });
  const receipt = await current.adapter.invoke({ message: '  bounded  ' });
  assert.deepEqual(current.calls.plan[0].arguments, { message: '  bounded  ' });
  assert.deepEqual(current.calls.direct[0].args, { message: 'bounded' });
  assert.notEqual(
    current.calls.direct[0].context.caller_arguments_hash,
    current.calls.direct[0].context.effective_arguments_hash,
  );
  assert.deepEqual(receipt.result.args, { message: 'bounded' });
});

test('LangGraph node reads one explicit state field and returns one partial update', async () => {
  const current = makeHarness({ framework: 'langgraph', level: 'HIGH' });
  const nodeAdapter = createLangGraphRiskForkNode({
    enforcement: current.adapter,
    input_key: 'effect_input',
    output_key: 'effect_receipt',
  });
  const update = await nodeAdapter.node({
    effect_input: { path: 'notes/demo.txt', content: 'bounded' },
    unrelated_parent_state: { should_not_copy: true },
  });
  assert.deepEqual(Object.keys(update), ['effect_receipt']);
  assert.equal(update.effect_receipt.status, 'prepared_for_clean_commit');
  assert.equal(update.effect_receipt.risk_decision.level, 'HIGH');
  assert.deepEqual(current.calls.plan[0].arguments, {
    content: 'bounded',
    path: 'notes/demo.txt',
  });
  assert.equal(JSON.stringify(current.calls.plan[0]).includes('should_not_copy'), false);

  const accessorState = {};
  Object.defineProperty(accessorState, 'effect_input', {
    enumerable: true,
    get() {
      throw new Error('must not run');
    },
  });
  await assert.rejects(nodeAdapter.node(accessorState), /enumerable data property/);
});

test('caller risk labels and secret-shaped arguments fail before planning', async () => {
  const current = makeHarness({ framework: 'openai-agents' });
  await assert.rejects(
    current.adapter.invoke({ risk_level: 'LOW', to: 'person@example.test' }),
    (error) => error.code === RISK_FORK_FRAMEWORK_DIAGNOSTIC_CODES.ARGUMENTS_INVALID,
  );
  await assert.rejects(
    current.adapter.invoke({ authorization: ['Bearer', 'abcdefghijklmnop'].join(' ') }),
    (error) => error.code === RISK_FORK_FRAMEWORK_DIAGNOSTIC_CODES.ARGUMENTS_INVALID,
  );
  assert.equal(current.calls.plan.length, 0);
  assert.equal(current.calls.prepare.length, 0);
});

test('proxy and accessor arguments fail before planning without invoking traps', async () => {
  const current = makeHarness({ framework: 'langchain' });
  let traps = 0;
  const proxy = new Proxy({ value: 'x' }, {
    ownKeys() {
      traps += 1;
      return ['value'];
    },
  });
  await assert.rejects(
    current.adapter.invoke(proxy),
    (error) => error.code === RISK_FORK_FRAMEWORK_DIAGNOSTIC_CODES.ARGUMENTS_INVALID,
  );
  const accessor = {};
  Object.defineProperty(accessor, 'value', {
    enumerable: true,
    get() {
      traps += 1;
      return 'x';
    },
  });
  await assert.rejects(
    current.adapter.invoke(accessor),
    (error) => error.code === RISK_FORK_FRAMEWORK_DIAGNOSTIC_CODES.ARGUMENTS_INVALID,
  );
  assert.equal(traps, 0);
  assert.equal(current.calls.plan.length, 0);
});

test('hostile inherited Array methods never run in arguments, plans, or direct output', async () => {
  let inheritedMapCalls = 0;
  class HostileArray extends Array {
    map() {
      inheritedMapCalls += 1;
      throw new Error('inherited map must not run');
    }
  }

  const argumentHarness = makeHarness({ framework: 'langchain', level: 'LOW' });
  await assert.rejects(
    argumentHarness.adapter.invoke({ values: new HostileArray('argument') }),
    (error) => error.code === RISK_FORK_FRAMEWORK_DIAGNOSTIC_CODES.ARGUMENTS_INVALID,
  );
  assert.equal(argumentHarness.calls.plan.length, 0);

  const planHarness = makeHarness({
    framework: 'langchain',
    level: 'LOW',
    planTransform(plan) {
      return {
        ...plan,
        operation_input: {
          ...plan.operation_input,
          effective_arguments: { values: new HostileArray('plan') },
        },
      };
    },
  });
  await assert.rejects(
    planHarness.adapter.invoke({ value: 'bounded' }),
    (error) => error.code === RISK_FORK_FRAMEWORK_DIAGNOSTIC_CODES.PLAN_REJECTED,
  );
  assert.equal(planHarness.calls.prepare.length, 0);

  const directHarness = makeHarness({
    framework: 'langchain',
    level: 'LOW',
    async executeDirect() {
      return { values: new HostileArray('direct') };
    },
  });
  const receipt = await directHarness.adapter.invoke({ value: 'bounded' });
  assert.equal(receipt.status, 'direct_effect_ambiguous');
  assert.equal(receipt.result, null);
  assert.equal(receipt.retry_allowed, false);
  assert.equal(inheritedMapCalls, 0);
});

test('plan substitutions fail request binding before the host boundary', async () => {
  const current = makeHarness({
    framework: 'langchain',
    planTransform(plan) {
      return {
        ...plan,
        operation_input: {
          operation: { kind: 'substituted' },
          effective_arguments: {},
          expected_commit_type: 'CONSEQUENTIAL_ACTION_PROPOSAL',
        },
      };
    },
  });
  await assert.rejects(
    current.adapter.invoke({ target: 'one' }),
    (error) => error.code === RISK_FORK_FRAMEWORK_DIAGNOSTIC_CODES.PLAN_REJECTED,
  );
  assert.equal(current.calls.descriptor.length, 0);
  assert.equal(current.calls.prepare.length, 0);
});

test('ELEVATED fork-optional results are blocked before direct execution', async () => {
  const current = makeHarness({ framework: 'langgraph', level: 'ELEVATED' });
  await assert.rejects(
    current.adapter.invoke({ value: 'bounded' }),
    (error) => error.code === RISK_FORK_FRAMEWORK_DIAGNOSTIC_CODES.OPTIONAL_FORK_BLOCKED,
  );
  assert.equal(current.calls.direct.length, 0);
  assert.equal(current.calls.retained.length, 0);
});

test('an ELEVATED call is accepted only when the host actually prepared a fork', async () => {
  const current = makeHarness({
    framework: 'langgraph',
    level: 'ELEVATED',
    preparationMode: 'prepared_for_clean_commit',
  });
  const receipt = await current.adapter.invoke({ value: 'bounded' });
  assert.equal(receipt.status, 'prepared_for_clean_commit');
  assert.equal(receipt.risk_decision.level, 'ELEVATED');
  assert.equal(current.calls.direct.length, 0);
  assert.equal(current.calls.retained.length, 1);
});

test('post-invocation direct failures resolve ambiguously and suppress error retry', async () => {
  let attempts = 0;
  const current = makeHarness({
    framework: 'langchain',
    level: 'LOW',
    async executeDirect() {
      attempts += 1;
      throw new Error('transport ended after dispatch');
    },
  });
  async function retryRejected(callback) {
    for (let attempt = 0; attempt < 3; attempt += 1) {
      try {
        return await callback();
      } catch (error) {
        if (attempt === 2) throw error;
      }
    }
    throw new Error('unreachable');
  }
  const receipt = await retryRejected(() => current.adapter.invoke({ value: 'bounded' }));
  assert.equal(receipt.status, 'direct_effect_ambiguous');
  assert.equal(receipt.result, null);
  assert.equal(receipt.retry_allowed, false);
  assert.equal(receipt.authority_granted, false);
  assert.equal(receipt.provider_handle_exposed, false);
  assert.equal(receipt.live_traffic_protected, false);
  assert.equal(JSON.stringify(receipt).includes('transport ended'), false);
  assert.equal(attempts, 1);
});

test('invalid direct output resolves ambiguously and suppresses error retry', async () => {
  let attempts = 0;
  const current = makeHarness({
    framework: 'langchain',
    level: 'LOW',
    async executeDirect() {
      attempts += 1;
      return { credential: 'must-not-leave-host' };
    },
  });
  async function retryRejected(callback) {
    try {
      return await callback();
    } catch {
      return callback();
    }
  }
  const receipt = await retryRejected(() => current.adapter.invoke({ value: 'bounded' }));
  assert.equal(receipt.status, 'direct_effect_ambiguous');
  assert.equal(receipt.result, null);
  assert.equal(receipt.retry_allowed, false);
  assert.equal(JSON.stringify(receipt).includes('credential'), false);
  assert.equal(attempts, 1);
});

test('framework adapter callback errors do not expose raw host failure text', async () => {
  const current = makeHarness({
    framework: 'langchain',
    planTransform() {
      throw new Error(['Bearer', 'private-host-value'].join(' '));
    },
  });
  await assert.rejects(
    current.adapter.invoke({ value: 'bounded' }),
    (error) => error.code === RISK_FORK_FRAMEWORK_DIAGNOSTIC_CODES.PLAN_REJECTED
      && !error.message.includes('private-host-value')
      && error.cause === undefined,
  );
});

test('framework-specific wrappers reject unbranded and cross-framework adapters', () => {
  const openai = makeHarness({ framework: 'openai-agents' });
  const chain = makeHarness({ framework: 'langchain' });
  assert.throws(
    () => createOpenAIAgentsRiskForkTool({ enforcement: { ...openai.adapter } }),
    /exact OpenAI Agents Risk Fork enforcement adapter/,
  );
  assert.throws(
    () => createOpenAIAgentsRiskForkTool({ enforcement: chain.adapter }),
    /exact OpenAI Agents Risk Fork enforcement adapter/,
  );
  assert.throws(
    () => createLangChainRiskForkTool({ enforcement: openai.adapter }),
    /exact LangChain Risk Fork enforcement adapter/,
  );
});

test('framework shims have no runtime dependency on framework SDKs or network clients', async () => {
  const sources = await Promise.all([
    '../src/framework-tool-adapter.mjs',
    '../src/frameworks/openai-agents.mjs',
    '../src/frameworks/langchain.mjs',
    '../src/frameworks/langgraph.mjs',
  ].map((relative) => readFile(new URL(relative, import.meta.url), 'utf8')));
  for (const source of sources) {
    assert.doesNotMatch(source, /from ['"](?:@openai\/agents|langchain|@langchain\/langgraph)['"]/);
    assert.doesNotMatch(source, /from ['"]node:(?:http|https|net|tls)['"]/);
    assert.doesNotMatch(source, /\bfetch\s*\(/);
  }
});
