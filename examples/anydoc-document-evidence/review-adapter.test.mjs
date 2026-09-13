import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { convertBytesToEvidence } from './agoragentic-anydoc.mjs';
import { inspectPacket, renderReview } from './review.mjs';

const customParser = Object.freeze({
  parserModulePath: fileURLToPath(new URL('./test-fixtures/fake-anydoc.mjs', import.meta.url)),
  allowTestOnlyCustomParser: true,
});

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

test('coordinated format relabel is rejected while the original remains unauthenticated and inert', async () => {
  const bytes = Buffer.from('name,value\nexample,42\n');
  const packet = await convertBytesToEvidence({ bytes, filename: 'example.csv', format: 'csv' });
  const candidate = structuredClone(packet);
  const beforeHashes = [candidate.source.source_hash, candidate.output.output_hash, candidate.output.parser_output_hash,
    ...candidate.output.evidence_units.map(unit => unit.provenance.output_hash)];
  candidate.parser.format = 'docx';
  candidate.source.source_format = 'docx';
  candidate.risk = { source_exact: false, semantic_risk: 'medium', limitations: [
    'nested_tables_may_be_flattened',
    'embedded_assets_need_separate_review',
    'layout_text_boxes_headers_and_footers_may_be_lossy',
  ] };
  candidate.ecf_handoff.blockers = candidate.ecf_handoff.blockers
    .filter(code => code !== 'semantic_review_required_before_financial_or_decision_use');

  const afterHashes = [candidate.source.source_hash, candidate.output.output_hash, candidate.output.parser_output_hash,
    ...candidate.output.evidence_units.map(unit => unit.provenance.output_hash)];
  assert.deepEqual(afterHashes, beforeHashes);
  assert.equal(candidate.source.filename, 'example.csv');
  assert.throws(() => inspectPacket(candidate, bytes), { code: 'format_envelope_mismatch' });

  const checked = inspectPacket(packet, bytes);
  assert.equal(checked.scope, 'local_packet_consistency');
  assert.equal(checked.source_bytes_hash_matches, true);
  assert.equal(checked.parser_authenticated, false);
  assert.equal(checked.semantic_correctness_verified, false);
  assert.equal(checked.context_approved, false);
  // `complete` is parse-envelope completeness only; the receipt remains pending.
  assert.equal(checked.complete, true);
  assert.equal(checked.receipt_status, 'pending');
  assert(Object.values(packet.authority).every(value => value === false));

  const authorityPromotion = structuredClone(packet);
  authorityPromotion.authority.grants_trust = true;
  assert.throws(() => inspectPacket(authorityPromotion, bytes), { code: 'authority_not_inert' });

  const contextPromotion = structuredClone(packet);
  contextPromotion.ecf_handoff.context_packet_ready = true;
  assert.throws(() => inspectPacket(contextPromotion, bytes), { code: 'handoff_not_pending' });
});

test('real custom adapter provenance cannot be relabeled across packet surfaces', async () => {
  const bytes = Buffer.from('name,value\nexample,42\n');
  const packet = await convertBytesToEvidence({ bytes, filename: 'example.csv', format: 'csv' }, customParser);
  assert.equal(inspectPacket(packet, bytes).receipt_status, 'incomplete');

  const beforeHashes = [packet.source.source_hash, packet.output.output_hash, packet.output.parser_output_hash,
    ...packet.output.evidence_units.map(unit => unit.provenance.output_hash)];
  const relabeled = structuredClone(packet);
  relabeled.parser.provenance.attested = true;
  relabeled.output.completeness = { status: 'complete', complete: true, blockers: [] };
  Object.assign(relabeled.ecf_handoff.receipt, { status: 'pending', completeness_status: 'complete', completeness_blockers: [] });
  relabeled.ecf_handoff.blockers = relabeled.ecf_handoff.blockers.filter(code => code !== 'custom_parser_provenance_unverified');
  const afterHashes = [relabeled.source.source_hash, relabeled.output.output_hash, relabeled.output.parser_output_hash,
    ...relabeled.output.evidence_units.map(unit => unit.provenance.output_hash)];
  assert.deepEqual(afterHashes, beforeHashes);
  assert.throws(() => inspectPacket(relabeled, bytes), { code: 'invalid_structure_provenance' });

  for (const [mutate, code] of [
    [candidate => { candidate.output.evidence_units[0].provenance.parser_attested = true; }, 'unit_provenance_mismatch'],
    [candidate => { candidate.ecf_handoff.receipt.parser_mode = 'isolated_local_fast_path'; }, 'receipt_parser_mismatch'],
  ]) {
    const candidate = structuredClone(packet); mutate(candidate);
    assert.throws(() => inspectPacket(candidate, bytes), { code });
  }
});
