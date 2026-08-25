import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

import Ajv2020 from 'ajv/dist/2020.js';
import addFormats from 'ajv-formats';

import { sha256Ref } from '../src/canonical.mjs';
import {
  buildExecutionBinding,
  verifyExecutionBinding,
} from '../src/contracts.mjs';
import { RiskForkController } from '../src/controller.mjs';
import { RiskForkProvider } from '../src/provider.mjs';
import { classifyRisk } from '../src/risk-classifier.mjs';
import {
  NOW,
  LATER,
  makeBinding,
  makeCapsule,
  makeForkIdentity,
} from './helpers.mjs';

const RAW_METHOD = 'experimental/future-method-v9';

function unknownCapsule(rawMethod = RAW_METHOD) {
  return makeCapsule({
    proposed_interaction: {
      mcp_method: 'UNKNOWN',
      raw_method: rawMethod,
      tool_name: null,
    },
  });
}

function directBinding(overrides = {}) {
  return buildExecutionBinding({
    principal_ref: 'principal:unknown-method-test',
    action_operation: 'mcp_tool_call',
    fork_agent_id: 'fork-agent:unknown-method-test',
    session_id: 'fork-session:unknown-method-test',
    mcp_server_ref: 'mcp-server:unknown-method-test',
    mcp_server_origin: 'https://unknown-method.example.invalid/',
    mcp_method: 'UNKNOWN',
    raw_method: RAW_METHOD,
    tool_name: null,
    effective_arguments: {},
    provider_ref: 'provider:unknown-method-test',
    target_ref: null,
    policy_ref: 'policy:unknown-method-test',
    policy_version: 'policy-v1',
    policy_hash: sha256Ref('policy:unknown-method-test'),
    issued_at: NOW,
    not_before: NOW,
    expires_at: LATER,
    nonce: 'nonce:unknown-method-test',
    one_use_authorization_id: 'authorization:unknown-method-test',
    audience: 'risk-fork-clean-controller',
    authorization_ref: 'authorization-ref:unknown-method-test',
    authorization_hash: sha256Ref('authorization:unknown-method-test'),
    ...overrides,
  });
}

class NoCallProvider extends RiskForkProvider {
  constructor() {
    super({
      id: 'provider:unknown-method-no-call',
      capabilities: {
        supports_verified_destruction: true,
        isolation_class: 'test_only',
        adapter_implementation: 'test_double',
        mock_conformance: 'passed',
        credentialed_provider_validation: 'not_run',
        containment_claim: 'not_verified',
      },
    });
    this.calls = 0;
  }

  async createSavepoint() { this.calls += 1; throw new Error('must not run'); }
  async createFork() { this.calls += 1; throw new Error('must not run'); }
  async getForkStatus() { this.calls += 1; throw new Error('must not run'); }
  async executeInFork() { this.calls += 1; throw new Error('must not run'); }
  async collectEvidence() { this.calls += 1; throw new Error('must not run'); }
  async collectDiff() { this.calls += 1; throw new Error('must not run'); }
  async suspendFork() { this.calls += 1; throw new Error('must not run'); }
  async destroyFork() { this.calls += 1; throw new Error('must not run'); }
  async verifyDestroyed() { this.calls += 1; throw new Error('must not run'); }
  async destroySavepoint() { this.calls += 1; throw new Error('must not run'); }
  async verifySavepointDestroyed() { this.calls += 1; throw new Error('must not run'); }
}

test('UNKNOWN requires one bounded raw method in capsules and execution bindings', () => {
  const capsule = unknownCapsule();
  const identity = makeForkIdentity(capsule);
  const binding = makeBinding({ capsule, identity });

  assert.equal(capsule.proposed_interaction.mcp_method, 'UNKNOWN');
  assert.equal(capsule.proposed_interaction.raw_method, RAW_METHOD);
  assert.equal(binding.mcp.method, 'UNKNOWN');
  assert.equal(binding.mcp.raw_method, RAW_METHOD);
  assert.equal(verifyExecutionBinding(binding, { raw_method: RAW_METHOD }, { now: NOW }), true);

  assert.throws(
    () => directBinding({ raw_method: null }),
    /raw_method is required when method is UNKNOWN/,
  );
  assert.throws(
    () => directBinding({ mcp_method: 'tools/call', raw_method: RAW_METHOD }),
    /raw_method is permitted only when method is UNKNOWN/,
  );
});

test('a different unknown raw method cannot reuse a Savepoint Capsule', async () => {
  const capsule = unknownCapsule();
  const provider = new NoCallProvider();
  const controller = new RiskForkController({
    provider,
    mode: 'demonstration',
    clock: () => new Date(NOW),
  });

  await assert.rejects(
    controller.prepare({
      risk_input: {
        mcp_phase: 'UNKNOWN',
        raw_method: 'experimental/different-method-v10',
        mcp_server_ref: capsule.proposed_interaction.mcp_server_ref,
        mcp_server_origin: capsule.proposed_interaction.mcp_server_origin,
        mcp_server_trust: 'unknown',
      },
      capsule,
      savepoint_input: {},
      operation: { kind: 'prepare-typed-result' },
      effective_arguments: { value: 1 },
      expected_commit_type: 'TYPED_RESULT',
      fork_ttl_ms: 60_000,
      network_policy: { mode: 'blocked' },
    }),
    /differ at raw_method/,
  );
  assert.equal(provider.calls, 0);
});

test('server/discover and UNKNOWN plus raw_method are accepted by closed public schemas', async () => {
  const ajv = new Ajv2020({ strict: true, allErrors: true });
  addFormats(ajv);
  const schemaFiles = [
    'savepoint-capsule.v1.json',
    'execution-binding.v1.json',
  ];
  const validators = {};
  for (const file of schemaFiles) {
    const schema = JSON.parse(await readFile(new URL(`../schema/${file}`, import.meta.url), 'utf8'));
    validators[file] = ajv.compile(schema);
  }

  const unknown = unknownCapsule();
  const unknownBinding = makeBinding({ capsule: unknown, identity: makeForkIdentity(unknown) });
  assert.equal(validators['savepoint-capsule.v1.json'](unknown), true);
  assert.equal(validators['execution-binding.v1.json'](unknownBinding), true);

  const discover = makeCapsule({
    proposed_interaction: {
      mcp_method: 'server/discover',
      raw_method: null,
      tool_name: null,
    },
  });
  assert.equal(validators['savepoint-capsule.v1.json'](discover), true);

  const missingRaw = structuredClone(unknown);
  missingRaw.proposed_interaction.raw_method = null;
  assert.equal(validators['savepoint-capsule.v1.json'](missingRaw), false);

  const unexpectedRaw = structuredClone(discover);
  unexpectedRaw.proposed_interaction.raw_method = RAW_METHOD;
  assert.equal(validators['savepoint-capsule.v1.json'](unexpectedRaw), false);
});

test('the classifier retains and fails high on the same raw method bound downstream', () => {
  const capsule = unknownCapsule();
  const decision = classifyRisk({
    mcp_phase: capsule.proposed_interaction.mcp_method,
    raw_method: capsule.proposed_interaction.raw_method,
    mcp_server_ref: capsule.proposed_interaction.mcp_server_ref,
    mcp_server_origin: capsule.proposed_interaction.mcp_server_origin,
    mcp_server_trust: 'verified',
  }, { clock: () => new Date(NOW) });

  assert.equal(decision.level, 'HIGH');
  assert.equal(decision.action, 'RISK_FORK_REQUIRED');
  assert.equal(decision.normalized_input.raw_method, RAW_METHOD);
});

test('ordinary future JSON-RPC method strings reach conservative classification unchanged', () => {
  for (const rawMethod of ['future method', '/future', 'C:/future']) {
    const decision = classifyRisk({
      mcp_phase: 'UNKNOWN',
      raw_method: rawMethod,
      mcp_server_ref: 'mcp-server:future-method-test',
      mcp_server_origin: 'https://future-method.example.invalid/',
      mcp_server_trust: 'unknown',
    }, { clock: () => new Date(NOW) });
    assert.equal(decision.level, 'HIGH');
    assert.equal(decision.action, 'RISK_FORK_REQUIRED');
    assert.equal(decision.normalized_input.raw_method, rawMethod);

    const capsule = unknownCapsule(rawMethod);
    const binding = makeBinding({ capsule, identity: makeForkIdentity(capsule) });
    assert.equal(binding.mcp.raw_method, rawMethod);
  }

  assert.throws(
    () => classifyRisk({ mcp_phase: 'UNKNOWN', raw_method: 'future\nmethod' }),
    /control character/,
  );
});
