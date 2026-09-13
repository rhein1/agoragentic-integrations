import { test } from 'node:test';
import assert from 'node:assert/strict';
import { convertBytesToEvidence } from './agoragentic-anydoc.mjs';
import { inspectPacket, renderReview } from './review.mjs';

test('real pinned adapter CSV output reaches the local review unchanged', async () => {
  const bytes = Buffer.from('name,value\nexample,42\n');
  const packet = await convertBytesToEvidence({ bytes, filename: 'example.csv', format: 'csv' });
  const before = JSON.stringify(packet);
  const checked = inspectPacket(packet, bytes);
  assert.equal(checked.output_hash_matches, true);
  assert.equal(checked.context_approved, false);
  assert(renderReview(packet, bytes).includes('Document evidence, not approved context'));
  assert.equal(JSON.stringify(packet), before);
});

test('real pinned adapter CSV risk and decision-use blocker cannot be downgraded', async () => {
  const bytes = Buffer.from('name,value\nexample,42\n');
  const packet = await convertBytesToEvidence({ bytes, filename: 'example.csv', format: 'csv' });
  for (const mutate of [
    candidate => { candidate.risk.semantic_risk = 'unknown'; },
    candidate => { candidate.risk.limitations = []; },
    candidate => { candidate.ecf_handoff.blockers = candidate.ecf_handoff.blockers.filter(code => code !== 'semantic_review_required_before_financial_or_decision_use'); },
  ]) {
    const candidate = structuredClone(packet);
    mutate(candidate);
    assert.throws(() => inspectPacket(candidate, bytes));
  }
});
