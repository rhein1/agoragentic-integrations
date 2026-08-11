import assert from 'node:assert/strict';
import test from 'node:test';

import {
  RiskForkMcpBoundary,
  assertHostCanEnforce,
  createMcpInterceptionPlan,
} from '../src/interception.mjs';

const PRE_CALL_PHASES = Object.freeze([
  'initialize',
  'tools/list',
  'resources/list',
  'resources/read',
  'prompts/list',
  'prompts/get',
]);

const NO_CAPABILITIES = Object.freeze({
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

const REMOTE_SESSION_CAPABILITIES = Object.freeze([
  'can_block_before_remote_connect',
  'can_route_complete_remote_session',
]);

const TOOL_EXECUTION_CAPABILITIES = Object.freeze([
  'can_block_before_tool_execution',
  'can_route_tool_execution',
]);

function riskInput({ phase, trust = 'verified', capabilities = NO_CAPABILITIES }) {
  return {
    request_id: `request:${trust}:${phase}`,
    mcp_phase: phase,
    mcp_server_ref: 'server:interception-test',
    mcp_server_origin: 'https://mcp.example.invalid/',
    mcp_server_trust: trust,
    ...(phase === 'tools/call' ? { tool_name: 'example_tool' } : {}),
    tool_annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
    capabilities: { ...capabilities },
  };
}

test('unknown and untrusted pre-call phases require both remote-session controls before routing', async () => {
  for (const trust of ['unknown', 'untrusted']) {
    for (const phase of PRE_CALL_PHASES) {
      const input = riskInput({ phase, trust });
      const plan = createMcpInterceptionPlan({ risk_input: input });

      assert.equal(plan.risk_decision.level, 'HIGH', `${trust} ${phase}`);
      assert.equal(plan.enforcement_point, 'before_remote_connect', `${trust} ${phase}`);
      assert.equal(plan.directive, 'BLOCK_DIRECT_ROUTE_TO_RISK_FORK', `${trust} ${phase}`);
      assert.deepEqual(
        plan.required_host_capabilities,
        REMOTE_SESSION_CAPABILITIES,
        `${trust} ${phase}`,
      );
      assert.equal(plan.authority_flags.remote_connection_started, false);

      const incompleteHosts = [
        {
          label: 'missing pre-connect block',
          capabilities: { can_route_complete_remote_session: true },
          error: /can_block_before_remote_connect/,
        },
        {
          label: 'missing complete-session routing',
          capabilities: {
            can_block_before_remote_connect: true,
            can_route_complete_remote_session: false,
          },
          error: /can_route_complete_remote_session/,
        },
      ];

      for (const host of incompleteHosts) {
        let controllerCalls = 0;
        const boundary = new RiskForkMcpBoundary({
          hostCapabilities: host.capabilities,
          controller: {
            async prepare() {
              controllerCalls += 1;
              return { prepared: true };
            },
          },
        });

        await assert.rejects(
          boundary.route({ risk_input: input, prepare_input: {} }),
          host.error,
          `${trust} ${phase}: ${host.label}`,
        );
        assert.equal(controllerCalls, 0, `${trust} ${phase}: ${host.label}`);
      }

      let controllerCalls = 0;
      const boundary = new RiskForkMcpBoundary({
        hostCapabilities: {
          can_block_before_remote_connect: true,
          can_route_complete_remote_session: true,
        },
        controller: {
          async prepare() {
            controllerCalls += 1;
            return { prepared: true };
          },
        },
      });
      const routed = await boundary.route({ risk_input: input, prepare_input: {} });
      assert.equal(controllerCalls, 1, `${trust} ${phase}`);
      assert.equal(routed.routed, true, `${trust} ${phase}`);
      assert.equal(routed.remote_result, null, `${trust} ${phase}`);
    }
  }
});

test('HIGH tools/call routes exactly once through the controller', async () => {
  const input = riskInput({
    phase: 'tools/call',
    capabilities: {
      ...NO_CAPABILITIES,
      filesystem_write: true,
    },
  });
  const calls = [];
  const boundary = new RiskForkMcpBoundary({
    hostCapabilities: {
      can_block_before_tool_execution: true,
      can_route_tool_execution: true,
    },
    controller: {
      async prepare(value) {
        calls.push(value);
        return { prepared_ref: 'prepared:high-tool-call' };
      },
    },
  });

  const result = await boundary.route({
    risk_input: input,
    prepare_input: { request_context_ref: 'context:high-tool-call' },
  });

  assert.equal(result.plan.risk_decision.level, 'HIGH');
  assert.equal(result.plan.enforcement_point, 'before_execution');
  assert.equal(result.plan.directive, 'BLOCK_DIRECT_ROUTE_TO_RISK_FORK');
  assert.deepEqual(result.plan.required_host_capabilities, TOOL_EXECUTION_CAPABILITIES);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].request_context_ref, 'context:high-tool-call');
  assert.deepEqual(calls[0].risk_input, input);
  assert.deepEqual(result.prepared, { prepared_ref: 'prepared:high-tool-call' });
  assert.equal(result.routed, true);
  assert.equal(result.remote_result, null);
});

test('fully enumerated verified no-capability LOW tools/call stays direct without execution', async () => {
  const input = riskInput({ phase: 'tools/call' });
  let controllerCalls = 0;
  let remoteExecutionCalls = 0;
  const remoteExecution = async () => {
    remoteExecutionCalls += 1;
    return { remote: true };
  };
  const boundary = new RiskForkMcpBoundary({
    hostCapabilities: {
      can_block_before_remote_connect: true,
      can_route_complete_remote_session: true,
      can_block_before_tool_execution: true,
      can_route_tool_execution: true,
    },
    controller: {
      async prepare(value) {
        controllerCalls += 1;
        return value.remote_execution();
      },
    },
  });

  const result = await boundary.route({
    risk_input: input,
    prepare_input: { remote_execution: remoteExecution },
  });

  assert.equal(result.plan.risk_decision.level, 'LOW');
  assert.equal(result.plan.directive, 'ALLOW_DIRECT');
  assert.equal(result.plan.enforcement_point, 'none');
  assert.deepEqual(result.plan.required_host_capabilities, []);
  assert.equal(result.routed, false);
  assert.equal(result.remote_result, null);
  assert.equal(Object.hasOwn(result, 'prepared'), false);
  assert.equal(controllerCalls, 0);
  assert.equal(remoteExecutionCalls, 0);
});

test('interception plan hash rejects capability and hash tampering', () => {
  const plan = createMcpInterceptionPlan({
    risk_input: riskInput({ phase: 'initialize', trust: 'unknown' }),
  });
  const enforceableHost = {
    can_block_before_remote_connect: true,
    can_route_complete_remote_session: true,
  };
  assert.equal(assertHostCanEnforce(plan, enforceableHost), true);

  const capabilityTampered = structuredClone(plan);
  capabilityTampered.required_host_capabilities = [];
  assert.throws(
    () => assertHostCanEnforce(capabilityTampered, enforceableHost),
    /Interception plan hash mismatch/,
  );

  const hashTampered = structuredClone(plan);
  hashTampered.plan_hash = `sha256:${'0'.repeat(64)}`;
  assert.throws(
    () => assertHostCanEnforce(hashTampered, enforceableHost),
    /Interception plan hash mismatch/,
  );
});
