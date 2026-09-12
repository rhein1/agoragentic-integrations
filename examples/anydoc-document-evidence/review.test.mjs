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
    source: { source_id: sourceId, source_hash: sourceHash, size_bytes: Buffer.byteLength('synthetic document'), filename: 'example.docx', raw_bytes_embedded: false },
    output: { markdown, markdown_chars: markdown.length, original_markdown_chars: markdown.length, output_hash: outputHash, parser_output_hash: outputHash, evidence_coverage: coverage, completeness, truncated: false, truncation_reasons: [],
      evidence_units: [{ schema: 'agoragentic.evidence-unit.v1', source_id: sourceId, reading_order: 0, markdown, source_char_range: [0, markdown.length], evidence_unit_id: `evu_${outputHash.slice(7,19)}_0`, trap_scan_status: 'not_scanned', provenance: { source_hash: sourceHash, output_hash: outputHash, aggregate_output_hash: outputHash } }] },
    risk: { source_exact: false, semantic_risk: 'medium', limitations: ['layout_may_be_lossy'] },
    authority: { grants_spend: false, grants_wallet_access: false, grants_deployment: false, grants_publication: false, grants_memory_write: false, grants_trust: false },
    ecf_handoff: { context_packet_ready: false, memory_write_allowed: false, marketplace_publication_allowed: false, x402_activation_allowed: false, trap_scan_required: true, trap_scan_status: 'not_scanned', blockers: ['platform_trap_scan_required'],
      receipt: { schema: 'agoragentic.parse-receipt.v1', receipt_id: `rcpt_parse_${hash(`${sourceHash}:${outputHash}`).slice(7,19)}`, status: 'pending', trap_scan_status: 'not_scanned', output_hash: outputHash, parser_output_hash: outputHash, source_hashes: [sourceHash], evidence_unit_count: 1, evidence_coverage: coverage, completeness_status: 'complete', completeness_blockers: [],
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
