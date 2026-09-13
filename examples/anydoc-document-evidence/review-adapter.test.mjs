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

test('real pinned adapter CSV rejects inconsistent one-field risk downgrades', async () => {
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

test('coordinated packet relabel stays unauthenticated and cannot promote context or authority', async () => {
  const bytes = Buffer.from('name,value\nexample,42\n');
  const packet = await convertBytesToEvidence({ bytes, filename: 'example.csv', format: 'csv' });
  const candidate = structuredClone(packet);
  candidate.parser.format = 'docx';
  candidate.source.source_format = 'docx';
  candidate.risk = { source_exact: false, semantic_risk: 'medium', limitations: [
    'nested_tables_may_be_flattened',
    'embedded_assets_need_separate_review',
    'layout_text_boxes_headers_and_footers_may_be_lossy',
  ] };
  candidate.ecf_handoff.blockers = candidate.ecf_handoff.blockers
    .filter(code => code !== 'semantic_review_required_before_financial_or_decision_use');

  const checked = inspectPacket(candidate, bytes);
  assert.equal(candidate.source.filename, 'example.csv');
  assert.equal(checked.scope, 'local_packet_consistency');
  assert.equal(checked.source_bytes_hash_matches, true);
  assert.equal(checked.parser_authenticated, false);
  assert.equal(checked.semantic_correctness_verified, false);
  assert.equal(checked.context_approved, false);
  // `complete` is parse-envelope completeness only; the receipt remains pending.
  assert.equal(checked.complete, true);
  assert.equal(checked.receipt_status, 'pending');
  assert(Object.values(candidate.authority).every(value => value === false));

  const authorityPromotion = structuredClone(candidate);
  authorityPromotion.authority.grants_trust = true;
  assert.throws(() => inspectPacket(authorityPromotion, bytes), { code: 'authority_not_inert' });

  const contextPromotion = structuredClone(candidate);
  contextPromotion.ecf_handoff.context_packet_ready = true;
  assert.throws(() => inspectPacket(contextPromotion, bytes), { code: 'handoff_not_pending' });
});
