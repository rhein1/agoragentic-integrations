import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { govern, createDefaultPolicy } from '../sdk/node/local-governance.mjs';

const secret = 'private-payload-and-error';
for (const phase of ['approval', 'tool', 'evidence']) {
  for (const hostile of ['accessor', 'proxy']) {
    test(`${phase} failure safely records a ${hostile} error code`, async (t) => {
      const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'govern-error-code-'));
      t.after(() => fs.rmSync(cwd, { recursive: true, force: true }));
      const policy = createDefaultPolicy();
      policy.default_decision = phase === 'approval' ? 'ask' : 'allow';
      let accessorCalls = 0;
      let effects = 0;
      const failure = hostile === 'accessor'
        ? Object.defineProperty(new Error(secret), 'code', { get() {
          accessorCalls += 1;
          throw new Error('private-getter-error');
        } })
        : new Proxy(new Error(secret), { getOwnPropertyDescriptor() {
          throw new Error('private-descriptor-error');
        } });
      const fail = () => { throw failure; };
      const wrapped = govern(() => {
        effects += 1;
        if (phase === 'tool') fail();
        return secret;
      }, { cwd, policy, action: 'tool.run', approve: fail,
        evidence: phase === 'evidence' ? fail : undefined });
      let caught;
      try { await wrapped(); } catch (error) { caught = error; }
      assert.equal(caught, failure);
      assert.equal(accessorCalls, 0);
      assert.equal(effects, phase === 'approval' ? 0 : 1);
      const directory = path.join(cwd, '.agoragentic/receipts');
      const files = fs.readdirSync(directory);
      assert.equal(files.length, 1);
      const raw = fs.readFileSync(path.join(directory, files[0]), 'utf8');
      const receipt = JSON.parse(raw);
      assert.equal(receipt.outcome, { approval: 'approval_failed', tool: 'failed', evidence: 'completed_evidence_failed' }[phase]);
      assert.equal(receipt.evidence.error_code, 'error');
      assert.ok(!raw.includes('private-'));
    });
  }
}

for (const phase of ['approval', 'tool', 'evidence', 'notification']) {
  test(`persist one truthful receipt on ${phase} failure`, async (t) => {
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'govern-lifecycle-'));
    t.after(() => fs.rmSync(cwd, { recursive: true, force: true }));
    const policy = createDefaultPolicy();
    policy.actions['file.write'] = { decision: phase === 'approval' ? 'ask' : 'allow' };
    let delivered;
    const failure = new Error(secret);
    const fail = () => { throw failure; };
    const wrapped = govern(() => {
      fs.writeFileSync(path.join(cwd, 'effect.txt'), 'one bounded write');
      if (phase === 'tool') fail();
      return secret;
    }, {
      cwd, policy, action: 'file.write',
      approve: fail,
      evidence: phase === 'evidence' ? fail : undefined,
      onReceipt: (receipt) => { delivered = receipt; if (phase === 'notification') fail(); },
    });
    let error;
    try { await wrapped(secret); } catch (caught) { error = caught; }
    assert.ok(error);
    const files = fs.readdirSync(path.join(cwd, '.agoragentic/receipts'));
    assert.equal(files.length, 1);
    const raw = fs.readFileSync(path.join(cwd, '.agoragentic/receipts', files[0]), 'utf8');
    const receipt = JSON.parse(raw);
    assert.equal(receipt.outcome, { approval: 'approval_failed', tool: 'failed', evidence: 'completed_evidence_failed', notification: 'completed' }[phase]);
    assert.equal(fs.existsSync(path.join(cwd, 'effect.txt')), phase !== 'approval');
    assert.equal(receipt.schema, 'agoragentic.local-action-receipt.v1');
    assert.equal(receipt.decision.authority.retry, 'owner_only');
    for (const flag of ['provider_execution', 'payment', 'settlement']) assert.equal(receipt.proof_scope[flag], false);
    assert.ok(!raw.includes(secret));
    assert.equal(error.agoragenticReceipt.receipt_id, receipt.receipt_id);
    if (phase === 'notification') {
      assert.equal(error.code, 'receipt_callback_failed');
      assert.equal(error.cause, failure);
      assert.equal(delivered.receipt_id, receipt.receipt_id);
    } else assert.equal(error, failure);
  });
}

test('allow, paused ask, explicit approval, and deny share one bounded local fixture', async (t) => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'govern-flow-'));
  t.after(() => fs.rmSync(cwd, { recursive: true, force: true }));
  const policy = createDefaultPolicy();
  policy.actions = { '*': { decision: 'deny' }, 'file.read': { decision: 'allow' }, 'file.write': { decision: 'ask' } };
  const effects = [];
  const tool = () => { effects.push(1); fs.writeFileSync(path.join(cwd, 'bounded.txt'), 'one'); return secret; };
  assert.equal(await govern(() => 'ready', { cwd, policy, action: 'file.read' })(), 'ready');
  await assert.rejects(govern(tool, { cwd, policy, action: 'file.write' })(), { code: 'explicit_approval_required' });
  assert.equal(effects.length, 0);
  let approve;
  let entered;
  const pending = new Promise(resolve => { entered = resolve; });
  const invocation = govern(tool, { cwd, policy, action: 'file.write', approve: () => {
    entered(); return new Promise(resolve => { approve = resolve; });
  } })();
  await pending;
  assert.equal(effects.length, 0);
  approve(true);
  assert.equal(await invocation, secret);
  assert.equal(effects.length, 1);
  policy.actions['file.write'] = { decision: 'deny' };
  await assert.rejects(govern(tool, { cwd, policy, action: 'file.write', approved: true,
    approve: () => assert.fail('deny must not call approval'),
  })(), { code: 'policy_denied' });
  assert.equal(effects.length, 1);
  const receipts = fs.readdirSync(path.join(cwd, '.agoragentic/receipts')).map(name =>
    JSON.parse(fs.readFileSync(path.join(cwd, '.agoragentic/receipts', name))));
  assert.equal(receipts.length, 4);
  assert.equal(receipts.filter(r => r.outcome === 'completed').length, 2);
  assert.ok(!JSON.stringify(receipts).includes(secret));
});

test('receipts:false retains returns and failure phases without persistence', async (t) => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'govern-disabled-'));
  t.after(() => fs.rmSync(cwd, { recursive: true, force: true }));
  const policy = createDefaultPolicy();
  policy.default_decision = 'allow';
  const options = { cwd, policy, action: 'tool.run', receipts: false };
  let notified = 'unset';
  assert.equal(await govern(() => secret, { ...options, onReceipt: r => { notified = r; } })(), secret);
  assert.equal(notified, null);
  for (const failure of ['primitive', Object.freeze(new Error(secret))]) {
    try { await govern(() => { throw failure; }, options)(); assert.fail('must throw'); }
    catch (error) { assert.equal(error, failure); }
  }
  await assert.rejects(govern(() => secret, { ...options, onReceipt: () => { throw new Error(secret); } })(),
    error => error.code === 'receipt_callback_failed' && error.agoragenticReceipt === null);
  assert.equal(fs.existsSync(path.join(cwd, '.agoragentic')), false);
});
