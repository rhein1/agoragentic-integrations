import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { govern, createDefaultPolicy } from '../sdk/node/local-governance.mjs';

function fixture(t) {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'receipt-identity-'));
  t.after(() => fs.rmSync(cwd, { recursive: true, force: true }));
  const policy = createDefaultPolicy();
  policy.default_decision = 'allow';
  const directory = path.join(cwd, '.agoragentic/receipts');
  return { cwd, policy, directory, read: () => fs.readdirSync(directory).map(name =>
    JSON.parse(fs.readFileSync(path.join(directory, name), 'utf8'))) };
}

for (const phase of ['approval', 'tool', 'evidence']) {
  test(`${phase} original error survives failed receipt persistence`, async t => {
    const f = fixture(t);
    if (phase === 'approval') f.policy.default_decision = 'ask';
    const original = new Error('private-original');
    let effects = 0;
    const fail = () => {
      fs.rmdirSync(f.directory);
      fs.writeFileSync(f.directory, 'private-obstruction');
      throw original;
    };
    const wrapped = govern(() => { effects++; if (phase === 'tool') fail(); return 'private-result'; }, {
      ...f, action: 'file.write', approve: fail, evidence: phase === 'evidence' ? fail : undefined,
    });
    await assert.rejects(wrapped(), error => {
      assert.equal(error, original);
      assert.equal(error.agoragenticReceipt, undefined);
      assert.deepEqual(error.agoragenticReceiptError, { code: 'receipt_persistence_failed', phase,
        action: 'file.write', outcome: { approval: 'approval_failed', tool: 'failed', evidence: 'completed_evidence_failed' }[phase] });
      return true;
    });
    assert.equal(effects, phase === 'approval' ? 0 : 1);
    assert.equal(fs.readFileSync(f.directory, 'utf8'), 'private-obstruction');
  });
}

for (const enabled of [true, false]) {
  test(`nested notification failure retains inner identity (outer receipts ${enabled})`, async t => {
    const f = fixture(t);
    let innerError;
    const inner = govern(() => 'done', { ...f, action: 'inner.run', onReceipt() { throw new Error('private'); } });
    const middle = govern(async () => { try { await inner(); } catch (e) { innerError = e; throw e; } },
      { ...f, action: 'middle.run', receipts: enabled });
    const outer = govern(middle, { ...f, action: 'outer.run' });
    await assert.rejects(outer(), error => {
      assert.equal(error, innerError);
      assert.equal(error.agoragenticReceipt, error.response.receipt);
      assert.equal(error.agoragenticReceipt.action, 'inner.run');
      assert.deepEqual(error.agoragenticEnclosingReceipts.map(r => r.action), enabled ? ['middle.run', 'outer.run'] : ['outer.run']);
      const receipts = f.read();
      assert.equal(receipts.length, enabled ? 3 : 2);
      for (const receipt of [error.agoragenticReceipt, ...error.agoragenticEnclosingReceipts]) {
        assert.equal(receipts.find(r => r.receipt_id === receipt.receipt_id).action, receipt.action);
      }
      return true;
    });
  });
}

test('notification mutation cannot alter canonical persisted receipt references', async t => {
  const f = fixture(t);
  const wrapped = govern(() => 'private-result', { ...f, action: 'file.write', onReceipt(receipt) {
    receipt.receipt_id = 'nonexistent';
    receipt.action = 'wrong.action';
    receipt.proof_scope.payment = true;
    throw new Error('private-callback');
  } });
  await assert.rejects(wrapped(), error => {
    const receipts = f.read();
    assert.equal(receipts.length, 1);
    assert.equal(error.agoragenticReceipt, error.response.receipt);
    assert.equal(error.agoragenticReceipt.receipt_id, receipts[0].receipt_id);
    assert.equal(error.agoragenticReceipt.action, 'file.write');
    assert.equal(error.agoragenticReceipt.proof_scope.payment, false);
    return true;
  });
});
