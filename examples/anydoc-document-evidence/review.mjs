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
const PLATFORM_TRAP_BLOCKER = 'platform_document_trap_scan_required_before_context_attachment';
const SEMANTIC_REVIEW_BLOCKER = 'semantic_review_required_before_financial_or_decision_use';
const PDF_OCR_BLOCKER = 'ocr_fallback_required_when_text_extraction_is_unsupported';
const PINNED_PARSER = Object.freeze({ package: '@firecrawl/anydoc', package_version: '0.1.7', engine: 'firecrawl_anydoc' });
const PINNED_NATIVE_BINDINGS = new Set([
  '@firecrawl/anydoc-darwin-arm64', '@firecrawl/anydoc-darwin-x64',
  '@firecrawl/anydoc-linux-arm64-gnu', '@firecrawl/anydoc-linux-arm64-musl',
  '@firecrawl/anydoc-linux-x64-gnu', '@firecrawl/anydoc-linux-x64-musl',
  '@firecrawl/anydoc-win32-x64-msvc',
]);
const CUSTOM_PARSER = Object.freeze({ package: 'custom_parser_module', package_version: null, engine: 'custom_parser_module' });
const FORMAT_ALIASES = Object.freeze({
  docm: 'docx', pot: 'ppt', pps: 'ppt', pptm: 'pptx', ppsm: 'pptx', ppsx: 'pptx',
  xls: 'xlsx', xlsb: 'xlsx', xlsm: 'xlsx',
});
const ECF_DOCUMENT_TYPE = Object.freeze({
  doc: 'docx', docx: 'docx', odt: 'docx', rtf: 'docx', epub: 'markdown', pdf: 'pdf',
  ppt: 'pptx', pptx: 'pptx', odp: 'pptx', xlsx: 'xlsx', ods: 'xlsx', csv: 'xlsx',
});
const FORMAT_DETECTION = new Set(['caller', 'content', 'filename', 'extension_map']);
const exactKeys = (value, fields) => value && typeof value === 'object' && !Array.isArray(value) &&
  JSON.stringify(Object.keys(value).sort()) === JSON.stringify([...fields].sort());

function checkParserProfile(parser) {
  const provenance = parser?.provenance;
  assert(provenance && typeof provenance === 'object' && !Array.isArray(provenance), 'invalid_structure_provenance');
  let expected, parserMode;
  if (provenance.module_kind === 'pinned_dependency') {
    assert(exactKeys(provenance, ['package', 'package_version', 'native_binding', 'engine', 'module_kind', 'attested', 'version_verified_at_runtime']) &&
      provenance.package === PINNED_PARSER.package && provenance.package_version === PINNED_PARSER.package_version &&
      provenance.engine === PINNED_PARSER.engine && provenance.attested === true && provenance.version_verified_at_runtime === true,
    'invalid_structure_provenance');
    const binding = provenance.native_binding;
    const resolvedBinding = exactKeys(binding, ['package', 'package_version']) &&
      ((PINNED_NATIVE_BINDINGS.has(binding.package) && binding.package_version === PINNED_PARSER.package_version) ||
        (binding.package === 'bundled_or_unresolved_native_binding' && binding.package_version === null));
    assert(resolvedBinding, 'invalid_structure_provenance');
    expected = PINNED_PARSER;
    parserMode = 'isolated_local_fast_path';
  } else if (provenance.module_kind === 'test_only_custom_module') {
    assert(exactKeys(provenance, ['package', 'package_version', 'native_binding', 'engine', 'module_kind', 'module_reference', 'attested', 'version_verified_at_runtime']) &&
      provenance.package === CUSTOM_PARSER.package && provenance.package_version === CUSTOM_PARSER.package_version &&
      provenance.native_binding === null && provenance.engine === CUSTOM_PARSER.engine &&
      typeof provenance.module_reference === 'string' && provenance.module_reference.length > 0 && provenance.module_reference.length <= 255 &&
      !/[\u0000-\u001f\u007f]/.test(provenance.module_reference) &&
      provenance.attested === false && provenance.version_verified_at_runtime === false,
    'invalid_structure_provenance');
    expected = CUSTOM_PARSER;
    parserMode = 'isolated_custom_test_module';
  } else {
    fail('invalid_structure_provenance');
  }
  assert(parser.package === expected.package && parser.package_version === expected.package_version &&
    parser.engine === expected.engine && parser.ocr_used === (provenance.attested ? false : 'unknown'),
  'parser_provenance_mismatch');
  return { parserMode, provenance };
}

function checkFormatEnvelope(packet) {
  const parser = packet?.parser, source = packet?.source;
  const requested = parser?.requested_format;
  const canonical = FORMAT_ALIASES[requested] || requested;
  const documentType = ECF_DOCUMENT_TYPE[parser?.format];
  assert(typeof requested === 'string' && requested.length > 0 && requested.length <= 16 &&
    canonical === parser.format && parser.format_alias_applied === (requested !== parser.format) &&
    FORMAT_DETECTION.has(parser.detected_by) && source?.source_format === parser.format &&
    source.requested_format === requested && source.ecf_document_type === documentType,
  'format_envelope_mismatch');
  return documentType;
}

// Consumer-side mirror of the producer's format risk contract. Packet mode
// validates submitted claims against this profile instead of displaying them
// as though a syntactically valid risk label were producer-compatible.
const FORMAT_RISK = Object.freeze({
  doc: ['medium', ['legacy_binary_document_may_reject_nonstandard_ole_containers', 'nested_tables_may_be_flattened', 'embedded_assets_need_separate_review']],
  docx: ['medium', ['nested_tables_may_be_flattened', 'embedded_assets_need_separate_review', 'layout_text_boxes_headers_and_footers_may_be_lossy']],
  odt: ['medium', ['layout_and_embedded_asset_semantics_may_be_lossy', 'nested_tables_may_be_flattened']],
  rtf: ['medium', ['producer_specific_control_words_may_be_lossy', 'nested_tables_may_be_flattened']],
  epub: ['medium', ['pathological_repeated_references_can_increase_parse_cost', 'layout_and_pagination_are_not_preserved']],
  pdf: ['medium', ['scanned_or_image_only_pdf_requires_ocr_fallback', 'pdf_document_model_and_embedded_assets_are_not_available', 'reading_order_may_be_ambiguous_in_complex_layouts']],
  ppt: ['medium', ['slide_boundaries_and_layout_may_be_lossy', 'embedded_assets_need_separate_review']],
  pptx: ['medium', ['untitled_slide_boundaries_may_be_lossy', 'speaker_notes_and_layout_need_output_review', 'embedded_assets_need_separate_review']],
  odp: ['medium', ['slide_boundaries_and_layout_may_be_lossy', 'embedded_assets_need_separate_review']],
  xlsx: ['high', ['hidden_rows_and_columns_may_be_exposed_as_visible_content', 'number_formats_may_be_dropped_or_change_interpretation', 'worksheet_identity_and_source_coordinates_may_be_incomplete', 'merged_cell_spans_may_be_clipped', 'formulas_are_not_independently_recalculated']],
  ods: ['high', ['hidden_rows_columns_and_display_formats_need_review', 'worksheet_source_coordinates_may_be_incomplete', 'formulas_are_not_independently_recalculated']],
  csv: ['high', ['csv_has_no_content_signature_and_requires_an_explicit_or_filename_format', 'types_and_display_formats_are_not_authoritative']],
});

function checkRisk(packet) {
  const { parser, source, risk, ecf_handoff: handoff } = packet;
  const expected = FORMAT_RISK[parser?.format];
  assert(expected && source?.source_format === parser.format, 'risk_format_mismatch');
  assert(risk.semantic_risk === expected[0] &&
    JSON.stringify(risk.limitations) === JSON.stringify(expected[1]), 'risk_profile_mismatch');
  const blockerCount = handoff.blockers.filter(code => code === SEMANTIC_REVIEW_BLOCKER).length;
  assert(blockerCount === (expected[0] === 'high' ? 1 : 0), 'risk_handoff_mismatch');
}

function checkHandoff(packet, completenessBlockers) {
  const expected = [PLATFORM_TRAP_BLOCKER, ...completenessBlockers];
  if (packet.risk.semantic_risk === 'high') expected.push(SEMANTIC_REVIEW_BLOCKER);
  if (packet.parser.format === 'pdf') expected.push(PDF_OCR_BLOCKER);
  const actual = packet.ecf_handoff.blockers;
  assert(actual.length === expected.length && new Set(actual).size === actual.length &&
    expected.every(code => actual.includes(code)), 'structure_handoff_mismatch');
}

// Consumer profile for parser-worker's structure and parseCompleteness contract.
// These fields remain packet claims, never parser authentication or approval.
function checkStructure(packet) {
  const o = packet.output, p = packet.parser, s = o.structure;
  const fields = ['block_count', 'table_count', 'note_count', 'asset_count', 'asset_bytes'];
  assert(s && typeof s === 'object' && !Array.isArray(s) &&
    Object.keys(s).length === 7 && ['available', 'unavailable', 'failed'].includes(s.status) &&
    fields.every(k => count(s[k])) && typeof s.traversal_truncated === 'boolean' &&
    s.table_count <= s.block_count, 'invalid_structure');
  assert(p && ['available', 'unavailable', 'failed', 'disabled_by_caller', 'unsupported_for_pdf'].includes(p.document_model_status) &&
    typeof p.provenance?.attested === 'boolean', 'invalid_structure_provenance');
  const model = p.document_model_status;
  const expectedStatus = ['disabled_by_caller', 'unsupported_for_pdf'].includes(model) ? 'unavailable' : model;
  assert(s.status === expectedStatus && (s.status === 'available' ||
    (fields.every(k => s[k] === 0) && s.traversal_truncated === false)), 'contradictory_structure');
  assert((model === 'unsupported_for_pdf') === (p.format === 'pdf') &&
    (s.asset_count !== 0 || s.asset_bytes === 0), 'contradictory_structure');
  const blockers = [
    [o.original_markdown_chars > o.markdown.length, 'markdown_output_limit_reached'],
    [!o.evidence_coverage.complete, 'evidence_unit_coverage_incomplete'],
    [model === 'failed', 'document_structure_extraction_failed'],
    [model === 'disabled_by_caller', 'document_structure_not_inspected'],
    [model === 'unsupported_for_pdf', 'document_structure_unavailable_for_pdf'],
    [s.status === 'unavailable' && model === 'unavailable', 'document_structure_unavailable'],
    [s.traversal_truncated, 'document_structure_traversal_incomplete'],
    [s.asset_count > 0, 'embedded_assets_not_in_evidence_packet'],
    [s.note_count > 0, 'document_notes_require_review'],
    [!p.provenance.attested, 'custom_parser_provenance_unverified'],
  ].filter(([required]) => required).map(([, name]) => name).sort();
  assert(JSON.stringify([...o.completeness.blockers].sort()) === JSON.stringify(blockers), 'structure_completeness_mismatch');
  const r = packet.ecf_handoff.receipt;
  assert(r.table_count === s.table_count && r.image_count === s.asset_count && r.formula_count === 0,
    'structure_receipt_mismatch');
  return blockers;
}

/** Check the existing adapter envelope. Integrity is not parser authentication or semantic truth. */
export function inspectPacket(packet, sourceBytes) {
  assert(packet?.schema === 'agoragentic.anydoc-document-evidence.v1', 'unsupported_packet');
  const { source: s, output: o, ecf_handoff: h, risk } = packet;
  const r = h?.receipt, c = o?.evidence_coverage, complete = o?.completeness;
  const parserProfile = checkParserProfile(packet.parser);
  const documentType = checkFormatEnvelope(packet);
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
    assert(u.source_format === packet.parser.format && u.document_type === documentType, 'unit_format_mismatch');
    const end = cursor + u.markdown.length, p = u.provenance;
    assert(Array.isArray(u.source_char_range) && u.source_char_range.length === 2 && u.source_char_range[0] === cursor && u.source_char_range[1] === end && o.markdown.slice(cursor, end) === u.markdown, 'unit_coverage_mismatch');
    assert(p?.source_hash === s.source_hash && p.aggregate_output_hash === o.output_hash && p.output_hash === hash(u.markdown) && u.evidence_unit_id === `evu_${p.output_hash.slice(7, 19)}_${index}`, 'unit_hash_mismatch');
    assert(p.parser_engine === packet.parser.engine && p.parser_version === packet.parser.package_version &&
      p.parser_attested === parserProfile.provenance.attested, 'unit_provenance_mismatch');
    cursor = end;
  }
  assert(cursor === c.covered_chars && c.covered_output_hash === hash(o.markdown.slice(0, cursor)), 'coverage_hash_mismatch');
  assert(complete && ['complete', 'incomplete'].includes(complete.status) && complete.complete === (complete.status === 'complete') && codes(complete.blockers) && complete.complete === (complete.blockers.length === 0), 'invalid_completeness');
  // Truncation consistency is independent of unrelated completeness blockers.
  const parserOmitted = o.original_markdown_chars - o.markdown.length;
  const truncations = [
    [parserOmitted > 0, 'markdown_output_limit', 'markdown_output_limit_reached'],
    [!c.complete, 'evidence_unit_limit', 'evidence_unit_coverage_incomplete'],
    [o.structure?.traversal_truncated === true, 'document_structure_traversal_limit', 'document_structure_traversal_incomplete']
  ];
  const expectedReasons = truncations.filter(([lost]) => lost).map(([, reason]) => reason).sort();
  assert(typeof o.truncated === 'boolean' && codes(o.truncation_reasons) &&
    o.truncated === (expectedReasons.length > 0) &&
    JSON.stringify([...o.truncation_reasons].sort()) === JSON.stringify(expectedReasons), 'contradictory_truncation');
  for (const [lost, , blocker] of truncations) assert(complete.blockers.includes(blocker) === lost, 'contradictory_truncation');
  assert(!complete.complete || (!o.truncated && c.complete && parserOmitted === 0), 'contradictory_completeness');
  assert(r?.schema === 'agoragentic.parse-receipt.v1' && r.receipt_id === `rcpt_parse_${hash(`${s.source_hash}:${o.output_hash}`).slice(7, 19)}` && r.status === (complete.complete ? 'pending' : 'incomplete') && r.trap_scan_status === 'not_scanned' && r.output_hash === o.output_hash && r.parser_output_hash === o.parser_output_hash && r.evidence_unit_count === o.evidence_units.length && r.completeness_status === complete.status, 'receipt_mismatch');
  assert(Array.isArray(r.source_hashes) && r.source_hashes.length === 1 && r.source_hashes[0] === s.source_hash && JSON.stringify(r.evidence_coverage) === JSON.stringify(c) && JSON.stringify(r.completeness_blockers) === JSON.stringify(complete.blockers), 'receipt_binding_mismatch');
  assert(r.parser_engine === packet.parser.engine && r.parser_version === packet.parser.package_version &&
    r.parser_mode === parserProfile.parserMode, 'receipt_parser_mismatch');
  const boundary = r.public_boundary;
  assert(boundary?.parse_receipt_only === true && ['parser_executed_by_schema', 'memory_written', 'marketplace_publication_triggered', 'x402_route_created', 'settlement_triggered', 'trust_mutated', 'private_context_exposed'].every(k => boundary[k] === false), 'receipt_authority_mismatch');
  assert(risk?.source_exact === false && ['high', 'medium', 'unknown'].includes(risk.semantic_risk) && codes(risk.limitations) && codes(h.blockers), 'invalid_risk');
  const completenessBlockers = checkStructure(packet);
  checkRisk(packet);
  checkHandoff(packet, completenessBlockers);
  if (sourceBytes !== undefined) assert(Buffer.isBuffer(sourceBytes) && sourceBytes.length === s.size_bytes && hash(sourceBytes) === s.source_hash, 'source_bytes_mismatch');
  return { scope: 'local_packet_consistency', output_hash_matches: true, source_bytes_hash_matches: sourceBytes === undefined ? null : true,
    semantic_correctness_verified: false, parser_authenticated: false, context_approved: false,
    complete: complete.complete, receipt_status: r.status,
    parser_markdown: { original_chars: o.original_markdown_chars, retained_chars: o.markdown.length, omitted_chars: parserOmitted },
    evidence_units: { available_chars: c.total_chars, covered_chars: c.covered_chars, omitted_chars: c.omitted_chars },
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
<dt>Parser Markdown retention</dt><dd>${check.parser_markdown.retained_chars} of ${check.parser_markdown.original_chars} parser-produced Markdown characters retained; ${check.parser_markdown.omitted_chars} omitted before evidence-unit construction.</dd>
<dt>Evidence-unit coverage</dt><dd>${o.evidence_coverage.covered_chars} of ${o.evidence_coverage.total_chars} retained Markdown characters; ${o.evidence_coverage.omitted_chars} omitted from evidence units.</dd>
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
  assert(Number.isSafeInteger(max) && max >= 0 && max <= MAX_SOURCE_BYTES, 'invalid_local_file');
  let fd;
  const same = (a, b) => ['dev', 'ino', 'size', 'mtimeNs', 'ctimeNs', 'nlink'].every(k => a[k] === b[k]);
  try {
    // Open first, then validate the exact descriptor used for every read. No
    // pre-open pathname check can authorize a different file after replacement.
    fd = fs.openSync(filename, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0) | (fs.constants.O_NONBLOCK || 0));
    const s = fs.fstatSync(fd, { bigint: true });
    const named = fs.lstatSync(filename, { bigint: true });
    assert(s.isFile() && named.isFile() && !named.isSymbolicLink() && s.nlink === 1n &&
      s.ino !== 0n && s.size <= BigInt(max), 'invalid_local_file');
    assert(same(s, named), 'input_changed');
    const size = Number(s.size), buffer = Buffer.alloc(size + 1); let n = 0;
    while (n < buffer.length) { const got = fs.readSync(fd, buffer, n, buffer.length - n, null); if (!got) break; n += got; }
    const after = fs.fstatSync(fd, { bigint: true });
    const current = fs.lstatSync(filename, { bigint: true });
    assert(n === size && current.isFile() && !current.isSymbolicLink() && same(s, after) && same(s, current), 'input_changed');
    return buffer.subarray(0, n);
  } catch (error) {
    if (['input_changed', 'invalid_local_file'].includes(error.code)) throw error;
    fail('invalid_local_file');
  } finally { if (fd !== undefined) fs.closeSync(fd); }
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
