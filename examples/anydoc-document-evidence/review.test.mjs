import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { inspectPacket, renderReview, readLocal, writeReview } from './review.mjs';
const hash = b => `sha256:${createHash('sha256').update(b).digest('hex')}`;
export function fixture(markdown = '# Example\nLocal evidence.\n') {
  const sourceHash = hash('synthetic document'), outputHash = hash(markdown), sourceId = `src_${sourceHash.slice(7,19)}`;
  const coverage = { total_chars: markdown.length, covered_chars: markdown.length, omitted_chars: 0, complete: true, coverage_kind: 'ordered_prefix', covered_output_hash: outputHash, first_omitted_char: null, max_unit_chars: 4000, max_units: 256 };
  const completeness = { status: 'complete', complete: true, blockers: [] };
  return { schema: 'agoragentic.anydoc-document-evidence.v1',
    parser: { document_model_status: 'available', format: 'docx', provenance: { attested: true } },
    source: { source_id: sourceId, source_hash: sourceHash, source_format: 'docx', size_bytes: Buffer.byteLength('synthetic document'), filename: 'example.docx', raw_bytes_embedded: false },
    output: { markdown, markdown_chars: markdown.length, original_markdown_chars: markdown.length, output_hash: outputHash, parser_output_hash: outputHash, evidence_coverage: coverage, completeness, truncated: false, truncation_reasons: [],
      structure: { status: 'available', block_count: 0, table_count: 0, note_count: 0, asset_count: 0, asset_bytes: 0, traversal_truncated: false },
      evidence_units: [{ schema: 'agoragentic.evidence-unit.v1', source_id: sourceId, reading_order: 0, markdown, source_char_range: [0, markdown.length], evidence_unit_id: `evu_${outputHash.slice(7,19)}_0`, trap_scan_status: 'not_scanned', provenance: { source_hash: sourceHash, output_hash: outputHash, aggregate_output_hash: outputHash } }] },
    risk: { source_exact: false, semantic_risk: 'medium', limitations: ['nested_tables_may_be_flattened', 'embedded_assets_need_separate_review', 'layout_text_boxes_headers_and_footers_may_be_lossy'] },
    authority: { grants_spend: false, grants_wallet_access: false, grants_deployment: false, grants_publication: false, grants_memory_write: false, grants_trust: false },
    ecf_handoff: { context_packet_ready: false, memory_write_allowed: false, marketplace_publication_allowed: false, x402_activation_allowed: false, trap_scan_required: true, trap_scan_status: 'not_scanned', blockers: ['platform_trap_scan_required'],
      receipt: { schema: 'agoragentic.parse-receipt.v1', receipt_id: `rcpt_parse_${hash(`${sourceHash}:${outputHash}`).slice(7,19)}`, status: 'pending', trap_scan_status: 'not_scanned', output_hash: outputHash, parser_output_hash: outputHash, source_hashes: [sourceHash], evidence_unit_count: 1, evidence_coverage: coverage, completeness_status: 'complete', completeness_blockers: [],
        table_count: 0, image_count: 0, formula_count: 0,
        public_boundary: { parse_receipt_only: true, parser_executed_by_schema: false, memory_written: false, marketplace_publication_triggered: false, x402_route_created: false, settlement_triggered: false, trust_mutated: false, private_context_exposed: false } } }
  };
}
test('valid packet remains pending without semantic or context approval', () => {
  const p = fixture(), before = JSON.stringify(p), r = inspectPacket(p);
  assert.equal(r.receipt_status, 'pending'); assert.equal(r.context_approved, false); assert.equal(r.parser_authenticated, false); assert.equal(JSON.stringify(p), before);
});
test('source bytes can be compared independently but incorrect bytes fail', () => {
  assert.equal(inspectPacket(fixture(), Buffer.from('synthetic document')).source_bytes_hash_matches, true);
  assert.throws(() => inspectPacket(fixture(), Buffer.from('wrong')), { code: 'source_bytes_mismatch' });
});
test('output, chunk and source substitutions are rejected', () => {
  for (const mutate of [p => p.output.markdown += 'changed', p => p.output.evidence_units[0].markdown = 'changed', p => p.output.evidence_units[0].provenance.source_hash = hash('wrong')]) {
    const p = fixture(); mutate(p); assert.throws(() => inspectPacket(p));
  }
});
test('receipt and coverage substitutions are rejected', () => {
  for (const mutate of [p => p.ecf_handoff.receipt.output_hash = hash('wrong'), p => p.output.evidence_units[0].source_char_range[0] = 1, p => p.output.evidence_coverage.covered_chars--]) {
    const p = fixture(); mutate(p); assert.throws(() => inspectPacket(p));
  }
});
test('authority, context promotion and unsupported schemas fail closed', () => {
  for (const mutate of [p => p.authority.grants_spend = true, p => p.ecf_handoff.context_packet_ready = true, p => p.schema = 'unknown', p => p.ecf_handoff.receipt.public_boundary.memory_written = true]) {
    const p = fixture(); mutate(p); assert.throws(() => inspectPacket(p));
  }
});
test('format, semantic risk and limitations remain exactly bound', () => {
  for (const mutate of [
    p => { p.risk.semantic_risk = 'unknown'; },
    p => { p.risk.limitations = []; },
    p => { p.risk.limitations.push('invented_limitation'); },
    p => { p.parser.format = 'csv'; },
    p => { p.source.source_format = 'csv'; },
  ]) {
    const p = fixture(); mutate(p); assert.throws(() => inspectPacket(p));
  }
});
test('high-risk formats require exactly one decision-use review blocker', () => {
  const high = fixture();
  high.parser.format = 'csv'; high.source.source_format = 'csv';
  high.risk = { source_exact: false, semantic_risk: 'high', limitations: [
    'csv_has_no_content_signature_and_requires_an_explicit_or_filename_format',
    'types_and_display_formats_are_not_authoritative',
  ] };
  high.ecf_handoff.blockers.push('semantic_review_required_before_financial_or_decision_use');
  assert.equal(inspectPacket(high).complete, true);
  high.ecf_handoff.blockers.pop();
  assert.throws(() => inspectPacket(high), { code: 'risk_handoff_mismatch' });
  high.ecf_handoff.blockers.push('semantic_review_required_before_financial_or_decision_use', 'semantic_review_required_before_financial_or_decision_use');
  assert.throws(() => inspectPacket(high), { code: 'risk_handoff_mismatch' });

  const medium = fixture();
  medium.ecf_handoff.blockers.push('semantic_review_required_before_financial_or_decision_use');
  assert.throws(() => inspectPacket(medium), { code: 'risk_handoff_mismatch' });
});
test('hostile document markup is literal and cannot execute or navigate', () => {
  const html = renderReview(fixture('<script>alert(1)</script><img src="https://example.invalid/x">'));
  assert(!html.includes('<script>')); assert(!html.includes('<img ')); assert(html.includes('&lt;script&gt;'));
  assert(html.includes("default-src 'none'")); assert(!html.includes('<a ')); assert(html.includes('UTF-16'));
});
test('incomplete prefix is retained as incomplete, not a failed or complete parse claim', () => {
  const p = fixture('abcdef'); const u = p.output.evidence_units[0];
  u.markdown = 'abc'; u.source_char_range = [0,3]; u.provenance.output_hash = hash('abc'); u.evidence_unit_id = `evu_${hash('abc').slice(7,19)}_0`;
  Object.assign(p.output.evidence_coverage, { covered_chars: 3, omitted_chars: 3, complete: false, covered_output_hash: hash('abc'), first_omitted_char: 3 });
  p.output.completeness = { complete: false, status: 'incomplete', blockers: ['evidence_unit_coverage_incomplete'] };
  p.output.truncated = true; p.output.truncation_reasons = ['evidence_unit_limit'];
  Object.assign(p.ecf_handoff.receipt, { status: 'incomplete', completeness_status: 'incomplete', completeness_blockers: p.output.completeness.blockers });
  p.ecf_handoff.blockers.push(...p.output.completeness.blockers);
  assert.equal(inspectPacket(p).receipt_status, 'incomplete');
  assert(renderReview(p).includes('3 of 6'));
});
test('write refuses an existing path and bounded read rejects oversized input', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'document-review-')); t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const file = path.join(root, 'review.html'); writeReview(file, renderReview(fixture()));
  const before = fs.readFileSync(file); assert.throws(() => writeReview(file, 'replacement'), { code: 'EEXIST' }); assert.deepEqual(fs.readFileSync(file), before);
  assert.throws(() => readLocal(file, 2), { code: 'invalid_local_file' });
  assert.throws(() => readLocal(root), { code: 'invalid_local_file' });
});

test('receipt identity substitution does not survive output consistency checks', () => { const p = fixture(); p.ecf_handoff.receipt.receipt_id = 'other'; assert.throws(() => inspectPacket(p), { code: 'receipt_mismatch' }); });

function parserTruncated() {
  const p = fixture('abcdef');
  p.parser.provenance.attested = false;
  p.output.original_markdown_chars = 6000;
  p.output.parser_output_hash = hash('abcdef'.repeat(1000));
  p.output.truncated = true;
  p.output.truncation_reasons = ['markdown_output_limit'];
  p.output.completeness = { status: 'incomplete', complete: false, blockers: ['custom_parser_provenance_unverified', 'markdown_output_limit_reached'] };
  Object.assign(p.ecf_handoff.receipt, { parser_output_hash: p.output.parser_output_hash, status: 'incomplete', completeness_status: 'incomplete', completeness_blockers: p.output.completeness.blockers });
  p.ecf_handoff.blockers.push(...p.output.completeness.blockers);
  return p;
}
test('unrelated completeness blockers cannot hide parser truncation', () => {
  const p = parserTruncated(); p.output.truncated = false; p.output.truncation_reasons = [];
  p.output.completeness.blockers.splice(1, 1);
  assert.throws(() => inspectPacket(p), { code: 'contradictory_truncation' });
});
test('parser retention and evidence-unit omissions have separate report totals', () => {
  const p = parserTruncated(), check = inspectPacket(p), html = renderReview(p);
  assert.deepEqual(check.parser_markdown, { original_chars: 6000, retained_chars: 6, omitted_chars: 5994 });
  assert.deepEqual(check.evidence_units, { available_chars: 6, covered_chars: 6, omitted_chars: 0 });
  assert(html.includes('6 of 6000')); assert(html.includes('5994 omitted before evidence-unit construction'));
  assert(html.includes('6 of 6 retained Markdown characters; 0 omitted from evidence units'));
});
test('truncation reason and blocker inconsistencies fail independently', () => {
  for (const mutate of [p => p.output.truncation_reasons.push('markdown_output_limit'), p => p.output.truncation_reasons.push('evidence_unit_limit'), p => p.output.completeness.blockers.splice(1, 1)]) {
    const p = parserTruncated(); mutate(p); assert.throws(() => inspectPacket(p), { code: 'contradictory_truncation' });
  }
});
test('structure traversal loss cannot hide behind another incomplete field', () => {
  const p = parserTruncated(); p.output.structure.traversal_truncated = true;
  assert.throws(() => inspectPacket(p), { code: 'contradictory_truncation' });
  p.output.truncation_reasons.push('document_structure_traversal_limit');
  p.output.completeness.blockers.push('document_structure_traversal_incomplete');
  p.ecf_handoff.blockers.push('document_structure_traversal_incomplete');
  assert.equal(inspectPacket(p).complete, false);
});
function localFiles(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'review-identity-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const original = path.join(root, 'input.json'), replacement = path.join(root, 'other.json');
  fs.writeFileSync(original, 'original'); fs.writeFileSync(replacement, 'replaced');
  return { root, original, replacement };
}
test('descriptor identity is checked before any bytes are consumed', t => {
  const { original, replacement } = localFiles(t), open = fs.openSync, read = fs.readSync;
  let reads = 0;
  t.mock.method(fs, 'openSync', function (file, ...args) { return open.call(fs, file === original ? replacement : file, ...args); });
  t.mock.method(fs, 'readSync', function (...args) { reads++; return read.apply(fs, args); });
  assert.throws(() => readLocal(original), { code: 'input_changed' });
  assert.equal(reads, 0);
});
test('replacement during a descriptor read is rejected after reading', t => {
  const { original, replacement } = localFiles(t), read = fs.readSync;
  let replaced = false;
  t.mock.method(fs, 'readSync', function (...args) {
    const n = read.apply(fs, args);
    if (!replaced) { replaced = true; fs.renameSync(original, `${original}.old`); fs.renameSync(replacement, original); }
    return n;
  });
  assert.throws(() => readLocal(original), { code: 'input_changed' });
});
test('regular-file read preserves bytes and refuses hard-linked identities', t => {
  const { original, root } = localFiles(t);
  assert.equal(readLocal(original).toString(), 'original');
  fs.linkSync(original, path.join(root, 'hardlink.json'));
  assert.throws(() => readLocal(original), { code: 'invalid_local_file' });
});

function bindCompleteness(p, blockers) {
  const complete = blockers.length === 0;
  p.output.completeness = { status: complete ? 'complete' : 'incomplete', complete, blockers };
  Object.assign(p.ecf_handoff.receipt, { status: complete ? 'pending' : 'incomplete',
    completeness_status: p.output.completeness.status, completeness_blockers: [...blockers],
    table_count: p.output.structure.table_count, image_count: p.output.structure.asset_count });
  p.ecf_handoff.blockers = ['platform_trap_scan_required', ...blockers];
}
test('structure object, strict booleans and counters cannot be missing or malformed', () => {
  for (const value of [undefined, null, {}, [], { status: 'failed', traversal_truncated: false }]) {
    const p = fixture(); p.output.structure = value; assert.throws(() => inspectPacket(p), { code: 'invalid_structure' });
  }
  for (const field of ['block_count', 'table_count', 'note_count', 'asset_count', 'asset_bytes', 'traversal_truncated']) {
    for (const value of [undefined, '0', 'false', -1, 0.5]) {
      const p = fixture(); p.output.structure[field] = value; assert.throws(() => inspectPacket(p));
    }
  }
});
test('every unavailable or failed model disposition has its exact completeness blocker', () => {
  for (const [model, status, blocker] of [
    ['failed', 'failed', 'document_structure_extraction_failed'],
    ['disabled_by_caller', 'unavailable', 'document_structure_not_inspected'],
    ['unsupported_for_pdf', 'unavailable', 'document_structure_unavailable_for_pdf'],
    ['unavailable', 'unavailable', 'document_structure_unavailable'],
  ]) {
    const p = fixture(); p.parser.document_model_status = model; p.parser.format = 'pdf'; p.source.source_format = 'pdf'; p.output.structure.status = status;
    p.risk.limitations = ['scanned_or_image_only_pdf_requires_ocr_fallback', 'pdf_document_model_and_embedded_assets_are_not_available', 'reading_order_may_be_ambiguous_in_complex_layouts'];
    assert.throws(() => inspectPacket(p), { code: 'structure_completeness_mismatch' });
    bindCompleteness(p, [blocker]); assert.equal(inspectPacket(p).complete, false);
    bindCompleteness(p, ['custom_parser_provenance_unverified']); p.parser.provenance.attested = false;
    assert.throws(() => inspectPacket(p), { code: 'structure_completeness_mismatch' });
  }
});
test('assets, notes and unattested parser each require independent blockers', () => {
  for (const [mutate, blocker] of [
    [p => { p.output.structure.asset_count = 1; }, 'embedded_assets_not_in_evidence_packet'],
    [p => { p.output.structure.note_count = 1; }, 'document_notes_require_review'],
    [p => { p.parser.provenance.attested = false; }, 'custom_parser_provenance_unverified'],
  ]) {
    const p = fixture(); mutate(p);
    assert.throws(() => inspectPacket(p), { code: 'structure_completeness_mismatch' });
    bindCompleteness(p, [blocker]); assert.equal(inspectPacket(p).complete, false);
    p.ecf_handoff.receipt.completeness_blockers = [];
    assert.throws(() => inspectPacket(p), { code: 'receipt_binding_mismatch' });
  }
});
test('contradictory model and structure status or unavailable counts fail closed', () => {
  for (const mutate of [p => p.parser.document_model_status = 'failed',
    p => { p.output.structure.status = 'failed'; },
    p => { p.output.structure.status = 'unavailable'; p.parser.document_model_status = 'unavailable'; p.output.structure.asset_count = 1; },
    p => { p.output.structure.status = 'unavailable'; p.parser.document_model_status = 'unsupported_for_pdf'; }]) {
    const p = fixture(); mutate(p); assert.throws(() => inspectPacket(p), { code: 'contradictory_structure' });
  }
});
test('missing model provenance and string-valued attestation are rejected', () => {
  for (const mutate of [p => delete p.parser, p => delete p.parser.document_model_status,
    p => delete p.parser.provenance, p => p.parser.provenance.attested = 'true']) {
    const p = fixture(); mutate(p); assert.throws(() => inspectPacket(p), { code: 'invalid_structure_provenance' });
  }
});
test('receipt structure tallies and handoff blockers stay bound', () => {
  const p = fixture(); p.output.structure.block_count = 1; p.output.structure.table_count = 1;
  assert.throws(() => inspectPacket(p), { code: 'structure_receipt_mismatch' });
  p.ecf_handoff.receipt.table_count = 1; assert.equal(inspectPacket(p).complete, true);
  p.output.structure.note_count = 1; bindCompleteness(p, ['document_notes_require_review']);
  p.ecf_handoff.blockers = []; assert.throws(() => inspectPacket(p), { code: 'structure_handoff_mismatch' });
});
test('duplicate and unsupported completeness blockers are not producer-compatible', () => {
  const p = fixture(); p.parser.provenance.attested = false;
  for (const blockers of [['custom_parser_provenance_unverified', 'custom_parser_provenance_unverified'], ['invented_blocker']]) {
    bindCompleteness(p, blockers); assert.throws(() => inspectPacket(p), { code: 'structure_completeness_mismatch' });
  }
});
