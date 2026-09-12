import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { pathToFileURL } from 'node:url';

const MAX_PACKET_BYTES = 16 * 1024 * 1024;
const MAX_SOURCE_BYTES = 50 * 1024 * 1024;
const hash = bytes => `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
const fail = code => { throw Object.assign(new Error(code), { code }); };
const assert = (ok, code) => { if (!ok) fail(code); };
const validHash = x => typeof x === 'string' && /^sha256:[a-f0-9]{64}$/.test(x);
const count = x => Number.isSafeInteger(x) && x >= 0;
const codes = x => Array.isArray(x) && x.length <= 128 && x.every(s => typeof s === 'string' && s.length <= 1024);
const escape = x => String(x).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

/** Check the existing adapter envelope. Integrity is not parser authentication or semantic truth. */
export function inspectPacket(packet, sourceBytes) {
  assert(packet?.schema === 'agoragentic.anydoc-document-evidence.v1', 'unsupported_packet');
  const { source: s, output: o, ecf_handoff: h, risk } = packet;
  const r = h?.receipt, c = o?.evidence_coverage, complete = o?.completeness;
  const authorityKeys = ['grants_spend', 'grants_wallet_access', 'grants_deployment', 'grants_publication', 'grants_memory_write', 'grants_trust'];
  assert(packet.authority && Object.keys(packet.authority).length === authorityKeys.length && authorityKeys.every(k => packet.authority[k] === false), 'authority_not_inert');
  assert(h?.context_packet_ready === false && h.memory_write_allowed === false && h.marketplace_publication_allowed === false && h.x402_activation_allowed === false && h.trap_scan_required === true && h.trap_scan_status === 'not_scanned', 'handoff_not_pending');
  assert(validHash(s?.source_hash) && s.raw_bytes_embedded === false && count(s.size_bytes) && s.size_bytes > 0 && s.size_bytes <= MAX_SOURCE_BYTES && typeof s.filename === 'string' && s.filename.length <= 255, 'invalid_source');
  assert(s.source_id === `src_${s.source_hash.slice(7, 19)}`, 'source_identity_mismatch');
  assert(typeof o?.markdown === 'string' && o.markdown.trim().length > 0 && o.markdown.length <= 5000000 && o.markdown_chars === o.markdown.length && count(o.original_markdown_chars) && o.original_markdown_chars >= o.markdown.length, 'invalid_output');
  assert(validHash(o.output_hash) && hash(o.markdown) === o.output_hash && validHash(o.parser_output_hash), 'output_hash_mismatch');
  if (o.original_markdown_chars === o.markdown.length) assert(o.parser_output_hash === o.output_hash, 'parser_output_hash_mismatch');
  assert(c && [c.total_chars, c.covered_chars, c.omitted_chars, c.max_units, c.max_unit_chars].every(count) && c.total_chars === o.markdown.length && c.covered_chars + c.omitted_chars === c.total_chars && c.coverage_kind === 'ordered_prefix' && c.complete === (c.omitted_chars === 0) && c.first_omitted_char === (c.complete ? null : c.covered_chars), 'invalid_coverage');
  assert(c.max_units >= 1 && c.max_units <= 256 && c.max_unit_chars >= 500 && c.max_unit_chars <= 20000, 'invalid_coverage_limits');
  assert(Array.isArray(o.evidence_units) && o.evidence_units.length > 0 && o.evidence_units.length <= c.max_units, 'invalid_units');
  let cursor = 0;
  for (const [index, u] of o.evidence_units.entries()) {
    assert(u.schema === 'agoragentic.evidence-unit.v1' && u.source_id === s.source_id && u.reading_order === index && typeof u.markdown === 'string' && u.markdown.length > 0 && u.markdown.length <= c.max_unit_chars && u.trap_scan_status === 'not_scanned', 'invalid_unit');
    const end = cursor + u.markdown.length, p = u.provenance;
    assert(Array.isArray(u.source_char_range) && u.source_char_range.length === 2 && u.source_char_range[0] === cursor && u.source_char_range[1] === end && o.markdown.slice(cursor, end) === u.markdown, 'unit_coverage_mismatch');
    assert(p?.source_hash === s.source_hash && p.aggregate_output_hash === o.output_hash && p.output_hash === hash(u.markdown) && u.evidence_unit_id === `evu_${p.output_hash.slice(7, 19)}_${index}`, 'unit_hash_mismatch');
    cursor = end;
  }
  assert(cursor === c.covered_chars && c.covered_output_hash === hash(o.markdown.slice(0, cursor)), 'coverage_hash_mismatch');
  assert(complete && ['complete', 'incomplete'].includes(complete.status) && complete.complete === (complete.status === 'complete') && codes(complete.blockers) && complete.complete === (complete.blockers.length === 0), 'invalid_completeness');
  assert(typeof o.truncated === 'boolean' && codes(o.truncation_reasons) && (!complete.complete || (!o.truncated && c.complete && o.original_markdown_chars === o.markdown.length)), 'contradictory_completeness');
  assert(r?.schema === 'agoragentic.parse-receipt.v1' && r.receipt_id === `rcpt_parse_${hash(`${s.source_hash}:${o.output_hash}`).slice(7, 19)}` && r.status === (complete.complete ? 'pending' : 'incomplete') && r.trap_scan_status === 'not_scanned' && r.output_hash === o.output_hash && r.parser_output_hash === o.parser_output_hash && r.evidence_unit_count === o.evidence_units.length && r.completeness_status === complete.status, 'receipt_mismatch');
  assert(Array.isArray(r.source_hashes) && r.source_hashes.length === 1 && r.source_hashes[0] === s.source_hash && JSON.stringify(r.evidence_coverage) === JSON.stringify(c) && JSON.stringify(r.completeness_blockers) === JSON.stringify(complete.blockers), 'receipt_binding_mismatch');
  const boundary = r.public_boundary;
  assert(boundary?.parse_receipt_only === true && ['parser_executed_by_schema', 'memory_written', 'marketplace_publication_triggered', 'x402_route_created', 'settlement_triggered', 'trust_mutated', 'private_context_exposed'].every(k => boundary[k] === false), 'receipt_authority_mismatch');
  assert(risk?.source_exact === false && ['high', 'medium', 'unknown'].includes(risk.semantic_risk) && codes(risk.limitations) && codes(h.blockers), 'invalid_risk');
  if (sourceBytes !== undefined) assert(Buffer.isBuffer(sourceBytes) && sourceBytes.length === s.size_bytes && hash(sourceBytes) === s.source_hash, 'source_bytes_mismatch');
  return { scope: 'local_packet_consistency', output_hash_matches: true, source_bytes_hash_matches: sourceBytes === undefined ? null : true,
    semantic_correctness_verified: false, parser_authenticated: false, context_approved: false,
    complete: complete.complete, receipt_status: r.status,
    warnings: [...new Set([...risk.limitations, ...complete.blockers, ...h.blockers])] };
}

/** Static HTML only: document text is escaped, never interpreted as HTML or instructions. */
export function renderReview(packet, sourceBytes) {
  const check = inspectPacket(packet, sourceBytes), s = packet.source, o = packet.output;
  const units = o.evidence_units.map((u, i) => `<details><summary>Evidence unit ${i + 1} · Markdown character offsets ${u.source_char_range[0]}–${u.source_char_range[1]}</summary><p><code>${escape(u.provenance.output_hash)}</code></p><pre>${escape(u.markdown)}</pre></details>`).join('\n');
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'">
<title>Local document evidence review</title>
<style>body{font:17px/1.55 system-ui,sans-serif;max-width:72rem;margin:2rem auto;padding:0 1.25rem}h1{font-size:2rem;line-height:1.15}section{margin:2rem 0}pre{white-space:pre-wrap;overflow-wrap:anywhere;border:1px solid;padding:1rem}code{overflow-wrap:anywhere}dt{font-weight:700}dd{margin:0 0 .7rem}summary{cursor:pointer;min-height:44px;padding:.4rem}aside{border:2px solid;padding:1rem}li{margin:.4rem 0}:focus-visible{outline:3px solid;outline-offset:4px}@media print{details{display:block}}</style></head>
<body><header><p>AGORAGENTIC · LOCAL REVIEW</p><h1>Document evidence, not approved context</h1><p>${escape(s.filename)}</p></header>
<aside><strong>Private document content.</strong> Do not publish this report. No upload, model call, OCR fallback, memory write, or context approval is performed by this review tool. Packet integrity does not prove parser authenticity, semantic correctness, or document safety.</aside>
<section><h2>Result and boundaries</h2><dl>
<dt>Parse receipt</dt><dd>${escape(check.receipt_status)} — trap scan and owner policy review remain required.</dd>
<dt>Extraction coverage</dt><dd>${o.evidence_coverage.covered_chars} of ${o.evidence_coverage.total_chars} bounded Markdown characters; ${o.evidence_coverage.omitted_chars} omitted from evidence units.</dd>
<dt>Local source bytes</dt><dd>${check.source_bytes_hash_matches ? 'Matched the packet source hash.' : 'Not supplied independently; source hash is a packet claim.'}</dd>
<dt>Output and evidence units</dt><dd>Hashes and ordered coverage match within the checked envelope.</dd>
<dt>Semantic risk</dt><dd>${escape(packet.risk.semantic_risk)}; source-exact extraction is not claimed.</dd>
<dt>Source hash</dt><dd><code>${escape(s.source_hash)}</code></dd>
<dt>Output hash</dt><dd><code>${escape(o.output_hash)}</code></dd>
</dl><p>Unit ranges are JavaScript/UTF-16 offsets in extracted Markdown, not independently verified original-document page, cell, or character coordinates.</p></section>
<section><h2>Warnings and unresolved checks</h2><ul>${check.warnings.map(w => `<li>${escape(w.replace(/_/g, ' '))}</li>`).join('')}</ul></section>
<section><h2>Extracted Markdown</h2><p>Untrusted source data, displayed literally.</p><pre>${escape(o.markdown)}</pre></section>
<section><h2>Evidence units</h2>${units}</section>
<section><h2>Next step</h2><p>Inspect omissions and semantic warnings against the original document. Keep the existing evidence JSON for the separately authorized platform trap scan and owner-scoped ECF handoff. Viewing this report does not satisfy either gate.</p></section></body></html>\n`;
}
export function readLocal(filename, max = MAX_PACKET_BYTES) {
  const initial = fs.lstatSync(filename);
  assert(initial.isFile() && !initial.isSymbolicLink() && initial.size <= max, 'invalid_local_file');
  const fd = fs.openSync(filename, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0));
  try {
    const s = fs.fstatSync(fd); assert(s.isFile() && s.size <= max, 'invalid_local_file');
    const buffer = Buffer.alloc(s.size + 1); let n = 0;
    while (n < buffer.length) { const got = fs.readSync(fd, buffer, n, buffer.length - n, null); if (!got) break; n += got; }
    const after = fs.fstatSync(fd);
    assert(n === s.size && after.size === s.size && after.mtimeMs === s.mtimeMs && after.ctimeMs === s.ctimeMs, 'input_changed');
    return buffer.subarray(0, n);
  } finally { fs.closeSync(fd); }
}
export function writeReview(filename, html) {
  assert(Buffer.byteLength(html) <= 32 * 1024 * 1024, 'report_too_large');
  const fd = fs.openSync(filename, 'wx', 0o600);
  try { fs.writeFileSync(fd, html); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
}
export async function main(argv = process.argv.slice(2)) {
  const [mode, input, output] = argv;
  assert(argv.length === 3 && ['document', 'packet'].includes(mode) && input && output, 'usage_document_or_packet_input_output');
  let packet, source;
  if (mode === 'document') {
    const { convertFileToEvidence } = await import('./agoragentic-anydoc.mjs');
    packet = await convertFileToEvidence(input);
    source = readLocal(input, MAX_SOURCE_BYTES);
  } else packet = JSON.parse(readLocal(input).toString('utf8'));
  writeReview(output, renderReview(packet, source));
  process.stdout.write('Private local review written. Context approval remains pending.\n');
}
if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) main().catch(error => {
  process.stderr.write(`Document review failed: ${/^[a-z_]+$/.test(error.code || '') ? error.code : 'local_review_failed'}\n`); process.exitCode = 1;
});
