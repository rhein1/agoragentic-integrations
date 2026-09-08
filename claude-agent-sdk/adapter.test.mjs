import assert from 'node:assert/strict';
import test from 'node:test';
import { ClaudeAgentSdkGatingAdapter, money } from './agoragentic_claude_agent.ts';
const adapter = new ClaudeAgentSdkGatingAdapter();
const call = cap => adapter.verifyToolPermission('agoragentic_execute', { constraints: { max_cost_usdc: cap }, approved: true });
test('pending approval never allows execution', () => assert.deepEqual(call('0.15'), { allowed: false, status: 'Approval_Required' }));
test('invalid monetary shapes fail closed', () => {
  for (const cap of [true, false, null, [], {}, '', 'NaN', 'Infinity', '-1', '1e-6', '0x10', '1\n', '1\r', ' 1', '1 ', '0.0000001', NaN, Infinity, -0]) {
    assert.deepEqual(call(cap), { allowed: false, status: 'Invalid_Spend_Cap' });
  }
});
test('exact decimal arithmetic and legacy finite numbers', () => {
  assert.equal(money('0.000001'), money(0.000001)); assert.equal(money('0.25'), money(0.25));
  assert.equal(call('0.250001').status, 'Denied_Spend_Limit_Exceeded');
});
test('unknown tool and MCP aliases do not inherit permission', () => {
  for (const name of ['Bash', 'apply_change', 'mcp__other__agoragentic_match', 'agoragentic_register']) {
    assert.equal(adapter.verifyToolPermission(name, {}).allowed, false);
  }
});
test('explicit read preflight only', () => {
  for (const name of ['agoragentic_match', 'agoragentic_search', 'agoragentic_categories']) {
    assert.deepEqual(adapter.verifyToolPermission(name, {}), { allowed: true, status: 'Read_Only_Preflight' });
  }
});
test('invalid policy types fail during construction', () => {
  for (const config of [null, [], { unknown: true }, { require_hitl_for_spend: 'false' }, { max_spend_usdc_per_call: true }]) {
    assert.throws(() => new ClaudeAgentSdkGatingAdapter(config));
  }
});
test('disabling HITL cannot activate a paid path', () => {
  const changed = new ClaudeAgentSdkGatingAdapter({ require_hitl_for_spend: false });
  assert.deepEqual(changed.verifyToolPermission('agoragentic_invoke', { constraints: { max_cost_usdc: '0' } }),
    { allowed: false, status: 'Paid_Execution_Unavailable' });
});
test('file hint cannot authorize file reads', () => {
  for (const value of [true, 'false', []]) assert.equal(adapter.verifyToolPermission('agoragentic_execute', {
    constraints: { max_cost_usdc: '0.1' }, input_data: { read_local_files: value } }).allowed, false);
});
test('SDK callback denies pending, never overrides host read permissions', async () => {
  const hook = adapter.sdkHooks().PreToolUse[0].hooks[0];
  assert.equal((await hook({ hook_event_name: 'PreToolUse', tool_name: 'agoragentic_execute',
    tool_input: { constraints: { max_cost_usdc: '0.1' } } })).hookSpecificOutput.permissionDecision, 'deny');
  assert.deepEqual(await hook({ hook_event_name: 'PreToolUse', tool_name: 'agoragentic_match', tool_input: {} }), {});
  assert.equal((await hook({})).hookSpecificOutput.permissionDecision, 'deny');
});
test('receipt projection removes all freeform and nested fields without mutation', () => {
  const source = { output: 'fixture-output', receipt: { status: 'completed', receipt_id: 'fixture-sensitive-id',
    transaction_hash: 'fixture-hash', settlement_address: 'fixture-address', nested: { authorization: 'fixture-secret' } } };
  const snapshot = structuredClone(source);
  assert.deepEqual(adapter.handlePostExecution(source).receipt, { projection: 'receipt_display_only', status: 'completed' });
  assert.deepEqual(source, snapshot);
});

import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { fixtureSummary } from './commerce/harness-evidence.mjs';
function demo() {
  const run = spawnSync(process.env.ADAPTER_CONFORMANCE_PYTHON || 'python',
    [fileURLToPath(new URL('./commerce/demo.py', import.meta.url))], { encoding: 'utf8', timeout: 10_000 });
  assert.equal(run.status, 0, run.stderr);
  return JSON.parse(run.stdout);
}
test('Python fixture evidence validates in the JavaScript Harness seam', () => {
  const summary = fixtureSummary(demo());
  assert.equal(summary.recorded_fixture_effects, 1);
  assert.equal(summary.independent_verification, false);
});
test('evidence cannot acquire payment or production authority', () => {
  for (const field of ['payment_attempted', 'production_authority', 'settlement_final', 'upstream_runtime_exercised']) {
    assert.throws(() => fixtureSummary({ ...demo(), [field]: true }), /fixture_boundary_invalid/);
  }
});
test('mutated evidence is rejected', () => {
  const evidence = demo(); evidence.events[0].action_executed = true;
  assert.throws(() => fixtureSummary(evidence), /fixture_evidence_hash_mismatch/);
});
test('no upstream/SDK import is required for fixture validation', () => {
  assert.equal(fixtureSummary(demo()).evidence_origin, 'self_reported_local_fixture');
});
