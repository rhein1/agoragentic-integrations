import { sha256Ref } from './canonical.mjs';
import { classifyRisk } from './risk-classifier.mjs';
import {
  assertAllowedKeys,
  assertPlainObject,
  deepFreeze,
  requireSha256Ref,
} from './util.mjs';

function requiredHostCapabilities(decision) {
  if (decision.isolation_boundary === 'before_remote_connect') {
    return ['can_block_before_remote_connect', 'can_route_complete_remote_session'];
  }
  if (['HIGH', 'IRREVERSIBLE'].includes(decision.level)) {
    return ['can_block_before_tool_execution', 'can_route_tool_execution'];
  }
  return [];
}

export function createMcpInterceptionPlan(input = {}, options = {}) {
  assertAllowedKeys(input, ['risk_input', 'trusted_server_verifier'], 'MCP interception input');
  assertAllowedKeys(options, ['clock'], 'MCP interception options');
  assertPlainObject(input.risk_input, 'risk_input');
  const decision = classifyRisk(input.risk_input, {
    trusted_server_verifier: input.trusted_server_verifier ?? null,
    clock: options.clock,
  });
  let directive;
  if (decision.blocked) directive = 'DENY';
  else if (decision.level === 'LOW') directive = 'ALLOW_DIRECT';
  else if (decision.level === 'ELEVATED') directive = 'OWNER_POLICY_DECIDES_FORK';
  else if (decision.level === 'HIGH') directive = 'BLOCK_DIRECT_ROUTE_TO_RISK_FORK';
  else directive = 'BLOCK_DIRECT_PREPARE_ONLY';
  const plan = {
    schema: 'agoragentic.risk-fork.interception-plan.v1',
    directive,
    enforcement_point: decision.isolation_boundary,
    required_host_capabilities: requiredHostCapabilities(decision),
    risk_decision: decision,
    authority_flags: {
      plan_grants_authority: false,
      host_enforcement_proven: false,
      remote_connection_started: false,
      tool_execution_started: false,
    },
    plan_hash: null,
  };
  plan.plan_hash = sha256Ref({ ...plan, plan_hash: null });
  return deepFreeze(plan);
}

export function assertHostCanEnforce(plan, hostCapabilities = {}) {
  assertPlainObject(plan, 'interception plan');
  requireSha256Ref(plan.plan_hash, 'interception plan.plan_hash');
  const expectedHash = sha256Ref({ ...plan, plan_hash: null });
  if (expectedHash !== plan.plan_hash) throw new Error('Interception plan hash mismatch');
  assertPlainObject(hostCapabilities, 'hostCapabilities');
  for (const capability of plan.required_host_capabilities) {
    if (hostCapabilities[capability] !== true) {
      throw new Error(`Host cannot enforce Risk Fork boundary: ${capability}`);
    }
  }
  return true;
}

export class RiskForkMcpBoundary {
  constructor({
    controller,
    hostCapabilities,
    trustedServerVerifier = null,
    clock = () => new Date(),
  }) {
    if (!controller || typeof controller.prepare !== 'function') {
      throw new TypeError('RiskForkMcpBoundary requires a Risk Fork controller');
    }
    assertPlainObject(hostCapabilities, 'hostCapabilities');
    this.controller = controller;
    this.hostCapabilities = { ...hostCapabilities };
    this.trustedServerVerifier = trustedServerVerifier;
    if (typeof clock !== 'function') {
      throw new TypeError('RiskForkMcpBoundary clock must be a synchronous function');
    }
    this.clock = clock;
  }

  async route(input = {}) {
    assertAllowedKeys(input, ['risk_input', 'prepare_input'], 'MCP boundary route input');
    const plan = createMcpInterceptionPlan(
      {
        risk_input: input.risk_input,
        trusted_server_verifier: this.trustedServerVerifier,
      },
      { clock: this.clock },
    );
    assertHostCanEnforce(plan, this.hostCapabilities);
    if (['DENY', 'ALLOW_DIRECT', 'OWNER_POLICY_DECIDES_FORK'].includes(plan.directive)) {
      return deepFreeze({
        plan,
        routed: false,
        remote_result: null,
        authority_granted: false,
      });
    }
    assertPlainObject(input.prepare_input, 'prepare_input');
    const prepared = await this.controller.prepare({
      ...input.prepare_input,
      risk_input: input.risk_input,
    });
    return deepFreeze({
      plan,
      routed: true,
      prepared,
      remote_result: null,
      authority_granted: false,
    });
  }
}
