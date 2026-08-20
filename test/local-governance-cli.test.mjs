import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import test from 'node:test';

const require = createRequire(import.meta.url);
const { runCli } = require('../sdk/node/agent-os.js');
const {
  createDefaultPolicy,
  evaluatePolicy,
  govern,
  initializeProject,
} = require('../sdk/node/local-governance.js');

function workspace() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'agoragentic-governance-'));
}

function captureIo() {
  let stdout = '';
  let stderr = '';
  return {
    io: {
      stdout: { write: (value) => { stdout += value; } },
      stderr: { write: (value) => { stderr += value; } },
    },
    stdout: () => stdout,
    stderr: () => stderr,
  };
}

function fakeSpawn(exitCode = 0, calls = []) {
  return (executable, args, options) => {
    calls.push({ executable, args, options });
    const child = new EventEmitter();
    queueMicrotask(() => child.emit('exit', exitCode, null));
    return child;
  };
}

function readOnlyReceipt(cwd) {
  const directory = path.join(cwd, '.agoragentic', 'receipts');
  const files = fs.readdirSync(directory);
  assert.equal(files.length, 1);
  return {
    raw: fs.readFileSync(path.join(directory, files[0]), 'utf8'),
    value: JSON.parse(fs.readFileSync(path.join(directory, files[0]), 'utf8')),
  };
}

test('init is plan-first, detects markers, and writes only with explicit confirmation', async (t) => {
  const cwd = workspace();
  t.after(() => fs.rmSync(cwd, { recursive: true, force: true }));
  fs.writeFileSync(path.join(cwd, 'package.json'), '{}\n');

  const planned = captureIo();
  assert.equal(await runCli(['init'], {}, planned.io, { cwd }), 0);
  assert.equal(fs.existsSync(path.join(cwd, 'agoragentic.yaml')), false);
  const plan = JSON.parse(planned.stdout());
  assert.equal(plan.result.status, 'planned');
  assert.equal(plan.result.detected_adapters.some((adapter) => adapter.id === 'node'), true);

  const written = captureIo();
  assert.equal(await runCli(['init', '--yes'], {}, written.io, { cwd }), 0);
  assert.equal(fs.existsSync(path.join(cwd, 'agoragentic.yaml')), true);
  assert.equal(JSON.parse(written.stdout()).result.written, true);

  const refused = captureIo();
  assert.equal(await runCli(['init', '--yes'], {}, refused.io, { cwd }), 2);
  assert.match(refused.stderr(), /policy_exists/);
});

test('adapters distinguishes marker detection from enforcement', async (t) => {
  const cwd = workspace();
  t.after(() => fs.rmSync(cwd, { recursive: true, force: true }));
  fs.mkdirSync(path.join(cwd, '.claude'));
  fs.writeFileSync(path.join(cwd, '.claude', 'settings.json'), '{}\n');

  const captured = captureIo();
  assert.equal(await runCli(['adapters'], {}, captured.io, { cwd }), 0);
  const result = JSON.parse(captured.stdout()).result;
  assert.equal(result.adapters.find((adapter) => adapter.id === 'process').integration_level, 'pre_action_enforcement');
  assert.equal(result.adapters.find((adapter) => adapter.id === 'claude-code').detected, true);
  assert.match(result.note, /does not prove host activation/);
});

test('run fails closed on ask or deny without spawning', async (t) => {
  const cwd = workspace();
  t.after(() => fs.rmSync(cwd, { recursive: true, force: true }));
  fs.writeFileSync(path.join(cwd, 'agoragentic.yaml'), `${JSON.stringify(createDefaultPolicy(), null, 2)}\n`);
  const calls = [];

  const missingSeparator = captureIo();
  assert.equal(await runCli(['run', 'node', 'secret-value'], {}, missingSeparator.io, { cwd, spawn: fakeSpawn(0, calls) }), 2);
  assert.equal(calls.length, 0);
  assert.match(missingSeparator.stderr(), /requires.*--/);

  const ask = captureIo();
  assert.equal(await runCli(['run', '--', 'node', 'secret-value'], {}, ask.io, { cwd, spawn: fakeSpawn(0, calls) }), 3);
  assert.equal(calls.length, 0);
  assert.match(ask.stderr(), /explicit_approval_required/);

  fs.rmSync(path.join(cwd, '.agoragentic'), { recursive: true, force: true });
  const deniedPolicy = createDefaultPolicy();
  deniedPolicy.actions['process.run'].decision = 'deny';
  fs.writeFileSync(path.join(cwd, 'agoragentic.yaml'), `${JSON.stringify(deniedPolicy, null, 2)}\n`);
  const denied = captureIo();
  assert.equal(await runCli(['run', '--yes', '--', 'node', 'secret-value'], {}, denied.io, { cwd, spawn: fakeSpawn(0, calls) }), 3);
  assert.equal(calls.length, 0);
  assert.match(denied.stderr(), /policy_denied/);
});

test('run executes after ask approval and writes a redacted local-only receipt', async (t) => {
  const cwd = workspace();
  t.after(() => fs.rmSync(cwd, { recursive: true, force: true }));
  fs.writeFileSync(path.join(cwd, 'agoragentic.yaml'), `${JSON.stringify(createDefaultPolicy(), null, 2)}\n`);
  const calls = [];
  const captured = captureIo();
  const secret = 'super-secret-token';

  assert.equal(await runCli(['run', '--yes', '--', 'node', '--token', secret], {}, captured.io, {
    cwd,
    spawn: fakeSpawn(0, calls),
    stdio: 'ignore',
  }), 0);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].options.shell, false);

  const receipt = readOnlyReceipt(cwd);
  assert.equal(receipt.value.classification, 'local_process_evidence');
  assert.equal(receipt.value.evidence.argument_count, 2);
  assert.equal(receipt.value.proof_scope.provider_execution, false);
  assert.equal(receipt.value.proof_scope.payment, false);
  assert.equal(receipt.raw.includes(secret), false);
});

test('govern blocks before invocation and emits shape-only evidence after approval', async (t) => {
  const cwd = workspace();
  t.after(() => fs.rmSync(cwd, { recursive: true, force: true }));
  const policy = createDefaultPolicy();
  policy.actions['email.send'] = { decision: 'ask', approval: 'owner_callback' };
  let calls = 0;
  const wrapped = govern(async (payload) => {
    calls += 1;
    return { delivered: true, secret: payload.secret };
  }, {
    action: 'email.send',
    policy,
    cwd,
    approve: async () => true,
  });

  const secret = 'private-message';
  assert.deepEqual(await wrapped({ secret }), { delivered: true, secret });
  assert.equal(calls, 1);
  const receipt = readOnlyReceipt(cwd);
  assert.equal(receipt.value.classification, 'local_tool_evidence');
  assert.deepEqual(receipt.value.evidence.result, { type: 'object', keys: ['delivered', 'secret'] });
  assert.equal(receipt.raw.includes(secret), false);
});

test('runtime validation refuses delegated spend or retry authority', () => {
  const delegatedSpend = createDefaultPolicy();
  delegatedSpend.authority.spend = 'agent';
  assert.throws(() => evaluatePolicy(delegatedSpend, 'process.run'), /authority\.spend must remain owner_only/);

  const delegatedRetry = createDefaultPolicy();
  delegatedRetry.authority.retry = 'agent';
  assert.throws(() => evaluatePolicy(delegatedRetry, 'process.run'), /authority\.retry must remain owner_only/);
});

test('policy and receipt paths cannot escape the project boundary', (t) => {
  const cwd = workspace();
  t.after(() => fs.rmSync(cwd, { recursive: true, force: true }));
  assert.throws(
    () => initializeProject({ cwd, policyPath: '../outside.yaml' }),
    /policy must stay inside the current project/
  );

  const policy = createDefaultPolicy();
  policy.receipts.directory = '../outside-receipts';
  let calls = 0;
  const wrapped = govern(async () => {
    calls += 1;
    return true;
  }, {
    action: 'process.run',
    policy,
    cwd,
    approved: true,
  });
  return assert.rejects(wrapped(), /receipt directory must stay inside the current project/).then(() => {
    assert.equal(calls, 0);
  });
});

test('ESM governance entry exposes the same public primitive', async () => {
  const module = await import('../sdk/node/local-governance.mjs');
  assert.equal(typeof module.govern, 'function');
  assert.equal(module.POLICY_SCHEMA, 'agoragentic.local-governance-policy.v1');
});
