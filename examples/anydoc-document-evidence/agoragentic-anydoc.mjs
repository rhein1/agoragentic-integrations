import { createHash } from 'node:crypto';
import { readFile, stat } from 'node:fs/promises';
import { basename, extname } from 'node:path';

const ANYDOC_PACKAGE = '@firecrawl/anydoc';
const ANYDOC_VERSION = '0.1.7';
const DEFAULT_MAX_INPUT_BYTES = 10 * 1024 * 1024;
const HARD_MAX_INPUT_BYTES = 50 * 1024 * 1024;
const DEFAULT_MAX_MARKDOWN_CHARS = 1_000_000;
const HARD_MAX_MARKDOWN_CHARS = 5_000_000;
const DEFAULT_CHUNK_CHARS = 4_000;
const MAX_EVIDENCE_UNITS = 256;
const MAX_TRAVERSAL_BLOCKS = 100_000;

const SUPPORTED_FORMATS = Object.freeze([
  'doc', 'docx', 'odt', 'pdf', 'ppt', 'pptx',
  'rtf', 'epub', 'xlsx', 'ods', 'odp', 'csv',
]);

const EXTENSION_TO_FORMAT = Object.freeze({
  '.doc': 'doc',
  '.docm': 'docx',
  '.docx': 'docx',
  '.odt': 'odt',
  '.pdf': 'pdf',
  '.pot': 'ppt',
  '.pps': 'ppt',
  '.ppt': 'ppt',
  '.pptm': 'pptx',
  '.pptx': 'pptx',
  '.ppsm': 'pptx',
  '.ppsx': 'pptx',
  '.rtf': 'rtf',
  '.epub': 'epub',
  '.xls': 'xlsx',
  '.xlsb': 'xlsx',
  '.xlsm': 'xlsx',
  '.xlsx': 'xlsx',
  '.ods': 'ods',
  '.odp': 'odp',
  '.csv': 'csv',
});

const ECF_DOCUMENT_TYPE = Object.freeze({
  doc: 'docx',
  docx: 'docx',
  odt: 'docx',
  rtf: 'docx',
  epub: 'markdown',
  pdf: 'pdf',
  ppt: 'pptx',
  pptx: 'pptx',
  odp: 'pptx',
  xlsx: 'xlsx',
  ods: 'xlsx',
  csv: 'xlsx',
});

const FORMAT_LIMITATIONS = Object.freeze({
  doc: [
    'legacy_binary_document_may_reject_nonstandard_ole_containers',
    'nested_tables_may_be_flattened',
    'embedded_assets_need_separate_review',
  ],
  docx: [
    'nested_tables_may_be_flattened',
    'embedded_assets_need_separate_review',
    'layout_text_boxes_headers_and_footers_may_be_lossy',
  ],
  odt: [
    'layout_and_embedded_asset_semantics_may_be_lossy',
    'nested_tables_may_be_flattened',
  ],
  rtf: [
    'producer_specific_control_words_may_be_lossy',
    'nested_tables_may_be_flattened',
  ],
  epub: [
    'pathological_repeated_references_can_increase_parse_cost',
    'layout_and_pagination_are_not_preserved',
  ],
  pdf: [
    'scanned_or_image_only_pdf_requires_ocr_fallback',
    'pdf_document_model_and_embedded_assets_are_not_available',
    'reading_order_may_be_ambiguous_in_complex_layouts',
  ],
  ppt: [
    'slide_boundaries_and_layout_may_be_lossy',
    'embedded_assets_need_separate_review',
  ],
  pptx: [
    'untitled_slide_boundaries_may_be_lossy',
    'speaker_notes_and_layout_need_output_review',
    'embedded_assets_need_separate_review',
  ],
  odp: [
    'slide_boundaries_and_layout_may_be_lossy',
    'embedded_assets_need_separate_review',
  ],
  xlsx: [
    'hidden_rows_and_columns_may_be_exposed_as_visible_content',
    'number_formats_may_be_dropped_or_change_interpretation',
    'worksheet_identity_and_source_coordinates_may_be_incomplete',
    'merged_cell_spans_may_be_clipped',
    'formulas_are_not_independently_recalculated',
  ],
  ods: [
    'hidden_rows_columns_and_display_formats_need_review',
    'worksheet_source_coordinates_may_be_incomplete',
    'formulas_are_not_independently_recalculated',
  ],
  csv: [
    'csv_has_no_content_signature_and_requires_an_explicit_or_filename_format',
    'types_and_display_formats_are_not_authoritative',
  ],
});

export class AnyDocEvidenceError extends Error {
  constructor(code, message, options = {}) {
    super(message, options);
    this.name = 'AnyDocEvidenceError';
    this.code = code;
    this.retryable = options.retryable === true;
    this.causeCode = options.causeCode || null;
  }
}

function sha256(value) {
  const bytes = typeof value === 'string' ? Buffer.from(value, 'utf8') : Buffer.from(value);
  return `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
}

function boundedInteger(value, fallback, minimum, maximum, field) {
  if (value === undefined || value === null || value === '') return fallback;
  const number = Number(value);
  if (!Number.isInteger(number) || number < minimum || number > maximum) {
    throw new AnyDocEvidenceError(
      'invalid_option',
      `${field} must be an integer between ${minimum} and ${maximum}.`,
    );
  }
  return number;
}

function normalizeBytes(value) {
  if (Buffer.isBuffer(value)) return value;
  if (value instanceof Uint8Array) return Buffer.from(value);
  throw new AnyDocEvidenceError('invalid_input', 'bytes must be a Buffer or Uint8Array.');
}

function normalizeFormat(value) {
  if (value === undefined || value === null || value === '') return null;
  const format = String(value).trim().toLowerCase();
  if (!SUPPORTED_FORMATS.includes(format)) {
    throw new AnyDocEvidenceError(
      'unsupported_format',
      `format must be one of: ${SUPPORTED_FORMATS.join(', ')}.`,
    );
  }
  return format;
}

function safeFilename(value) {
  const name = basename(String(value || 'document.bin')).replace(/[\u0000-\u001f\u007f]/g, '');
  return name.slice(0, 255) || 'document.bin';
}

function sectionPathFromChunk(chunk, fallback) {
  const heading = String(chunk)
    .split(/\r?\n/, 1)[0]
    .match(/^#{1,6}\s+(.+)$/);
  return heading ? heading[1].trim().slice(0, 500) : fallback;
}

function splitMarkdown(markdown, targetChars, maxUnits) {
  const paragraphs = String(markdown).split(/\n{2,}/);
  const chunks = [];
  let current = '';

  for (const paragraph of paragraphs) {
    const candidate = current ? `${current}\n\n${paragraph}` : paragraph;
    if (candidate.length <= targetChars || !current) {
      current = candidate;
      continue;
    }

    chunks.push(current);
    current = paragraph;

    if (chunks.length >= maxUnits - 1) break;
  }

  if (current && chunks.length < maxUnits) chunks.push(current);
  if (chunks.length === 0 && markdown) chunks.push(String(markdown).slice(0, targetChars));
  return chunks;
}

function inspectDocumentModel(document) {
  if (!document || !Array.isArray(document.blocks)) {
    return {
      status: 'unavailable',
      block_count: 0,
      table_count: 0,
      note_count: 0,
      asset_count: 0,
      traversal_truncated: false,
    };
  }

  const queue = [...document.blocks];
  let blockCount = 0;
  let tableCount = 0;
  let traversalTruncated = false;

  while (queue.length > 0) {
    const block = queue.shift();
    blockCount += 1;
    if (blockCount > MAX_TRAVERSAL_BLOCKS) {
      traversalTruncated = true;
      break;
    }

    if (block?.kind === 'table' && block.table) {
      tableCount += 1;
      for (const row of block.table.grid || []) {
        for (const slot of row || []) {
          for (const nested of slot?.cell?.blocks || []) queue.push(nested);
        }
      }
    }
    for (const nested of block?.blocks || []) queue.push(nested);
    for (const item of block?.list?.items || []) {
      for (const nested of item?.blocks || []) queue.push(nested);
    }
  }

  return {
    status: 'available',
    block_count: Math.min(blockCount, MAX_TRAVERSAL_BLOCKS),
    table_count: tableCount,
    note_count: Array.isArray(document.notes) ? document.notes.length : 0,
    asset_count: Array.isArray(document.assets) ? document.assets.length : 0,
    asset_bytes: Array.isArray(document.assets)
      ? document.assets.reduce((sum, asset) => sum + (asset?.data?.byteLength || 0), 0)
      : 0,
    traversal_truncated: traversalTruncated,
  };
}

function riskProfile(format) {
  const highRisk = new Set(['xlsx', 'ods', 'csv']);
  const mediumRisk = new Set(['doc', 'docx', 'odt', 'rtf', 'epub', 'ppt', 'pptx', 'odp', 'pdf']);
  return {
    source_exact: false,
    semantic_risk: highRisk.has(format) ? 'high' : mediumRisk.has(format) ? 'medium' : 'unknown',
    limitations: [...(FORMAT_LIMITATIONS[format] || ['format_specific_loss_needs_review'])],
  };
}

function mapConvertError(error) {
  const causeCode = error?.code ? String(error.code) : null;
  const mapped = {
    unsupported: ['unsupported_or_ocr_required', false],
    malformed: ['malformed_document', false],
    encrypted: ['encrypted_document', false],
    resourceLimit: ['resource_limit', false],
    missingPart: ['missing_required_part', false],
    io: ['io_error', true],
  }[causeCode] || ['conversion_failed', false];

  return new AnyDocEvidenceError(
    mapped[0],
    `AnyDoc conversion failed${causeCode ? ` (${causeCode})` : ''}.`,
    { cause: error, retryable: mapped[1], causeCode },
  );
}

async function loadAnyDoc(loader) {
  const module = loader ? await loader() : await import(ANYDOC_PACKAGE);
  for (const name of ['formatFromBytes', 'formatFromPath', 'toMarkdownBytes', 'toDocument']) {
    if (typeof module?.[name] !== 'function') {
      throw new AnyDocEvidenceError(
        'incompatible_anydoc_api',
        `Expected ${ANYDOC_PACKAGE}@${ANYDOC_VERSION} to export ${name}().`,
      );
    }
  }
  return module;
}

function resolveFormat(anydoc, bytes, filename, explicitFormat) {
  if (explicitFormat) return { format: explicitFormat, detected_by: 'caller' };

  const contentFormat = anydoc.formatFromBytes(bytes);
  if (contentFormat) return { format: String(contentFormat), detected_by: 'content' };

  const pathFormat = filename ? anydoc.formatFromPath(filename) : null;
  if (pathFormat) return { format: String(pathFormat), detected_by: 'filename' };

  const extensionFormat = EXTENSION_TO_FORMAT[extname(filename).toLowerCase()] || null;
  if (extensionFormat) return { format: extensionFormat, detected_by: 'extension_map' };

  throw new AnyDocEvidenceError(
    'unsupported_format',
    'The document format could not be detected. CSV and signature-less input require a filename or explicit format.',
  );
}

function buildEvidenceUnits({ chunks, sourceId, sourceHash, outputHash, format }) {
  return chunks.map((chunk, index) => {
    const readingOrder = index;
    const chunkHash = sha256(chunk);
    return {
      schema: 'agoragentic.evidence-unit.v1',
      evidence_unit_id: `evu_${chunkHash.slice(7, 19)}_${index}`,
      source_id: sourceId,
      document_type: ECF_DOCUMENT_TYPE[format] || 'markdown',
      source_format: format,
      section_path: sectionPathFromChunk(chunk, `chunk-${index + 1}`),
      page_range: [],
      reading_order: readingOrder,
      content_type: 'markdown',
      text: '',
      markdown: chunk,
      html_table: '',
      formula_latex: '',
      image_refs: [],
      confidence: null,
      provenance: {
        parser_engine: 'firecrawl_anydoc',
        parser_version: ANYDOC_VERSION,
        source_hash: sourceHash,
        output_hash: chunkHash,
        aggregate_output_hash: outputHash,
        citation: null,
      },
      trap_scan_status: 'not_scanned',
    };
  });
}

function buildReceipt({ sourceHash, outputHash, evidenceUnits, structure, status = 'pending' }) {
  return {
    schema: 'agoragentic.parse-receipt.v1',
    receipt_type: 'document_parse_receipt',
    receipt_id: `rcpt_parse_${sha256(`${sourceHash}:${outputHash}`).slice(7, 19)}`,
    parse_job_id: null,
    context_packet_id: null,
    parser_engine: 'firecrawl_anydoc',
    parser_version: ANYDOC_VERSION,
    parser_mode: 'local_fast_path',
    source_hashes: [sourceHash],
    output_hash: outputHash,
    evidence_unit_count: evidenceUnits.length,
    table_count: structure.table_count || 0,
    image_count: structure.asset_count || 0,
    formula_count: 0,
    trap_scan_status: 'not_scanned',
    status,
    public_boundary: {
      parse_receipt_only: true,
      parser_executed_by_schema: false,
      memory_written: false,
      marketplace_publication_triggered: false,
      x402_route_created: false,
      settlement_triggered: false,
      trust_mutated: false,
      private_context_exposed: false,
    },
    created_at: new Date().toISOString(),
  };
}

export async function convertBytesToEvidence(input = {}, options = {}) {
  const startedAt = Date.now();
  const bytes = normalizeBytes(input.bytes);
  const filename = safeFilename(input.filename);
  const explicitFormat = normalizeFormat(input.format);
  const maxInputBytes = boundedInteger(
    options.maxInputBytes,
    DEFAULT_MAX_INPUT_BYTES,
    1,
    HARD_MAX_INPUT_BYTES,
    'maxInputBytes',
  );
  const maxMarkdownChars = boundedInteger(
    options.maxMarkdownChars,
    DEFAULT_MAX_MARKDOWN_CHARS,
    1_000,
    HARD_MAX_MARKDOWN_CHARS,
    'maxMarkdownChars',
  );
  const chunkChars = boundedInteger(
    options.chunkChars,
    DEFAULT_CHUNK_CHARS,
    500,
    20_000,
    'chunkChars',
  );
  const maxEvidenceUnits = boundedInteger(
    options.maxEvidenceUnits,
    MAX_EVIDENCE_UNITS,
    1,
    MAX_EVIDENCE_UNITS,
    'maxEvidenceUnits',
  );

  if (bytes.byteLength === 0) {
    throw new AnyDocEvidenceError('empty_document', 'The document has no bytes.');
  }
  if (bytes.byteLength > maxInputBytes) {
    throw new AnyDocEvidenceError(
      'input_too_large',
      `Document is ${bytes.byteLength} bytes; the configured limit is ${maxInputBytes}.`,
    );
  }

  const anydoc = await loadAnyDoc(options.anydocLoader);
  const resolved = resolveFormat(anydoc, bytes, filename, explicitFormat);
  const format = normalizeFormat(resolved.format);

  let markdown;
  try {
    markdown = await anydoc.toMarkdownBytes(bytes, format);
  } catch (error) {
    throw mapConvertError(error);
  }
  if (typeof markdown !== 'string' || !markdown.trim()) {
    throw new AnyDocEvidenceError('empty_output', 'AnyDoc returned no meaningful Markdown.');
  }

  let documentModel = null;
  let documentModelError = null;
  if (format !== 'pdf' && options.inspectStructure !== false) {
    try {
      documentModel = await anydoc.toDocument(bytes, format);
    } catch (error) {
      documentModelError = error?.code ? String(error.code) : 'document_model_failed';
    }
  }

  const originalMarkdownChars = markdown.length;
  const boundedMarkdown = markdown.slice(0, maxMarkdownChars);
  const outputTruncated = boundedMarkdown.length < originalMarkdownChars;
  const sourceHash = sha256(bytes);
  const outputHash = sha256(boundedMarkdown);
  const sourceId = `src_${sourceHash.slice(7, 19)}`;
  const chunks = splitMarkdown(boundedMarkdown, chunkChars, maxEvidenceUnits);
  const evidenceUnits = buildEvidenceUnits({
    chunks,
    sourceId,
    sourceHash,
    outputHash,
    format,
  });
  const structure = inspectDocumentModel(documentModel);
  const risk = riskProfile(format);
  const blockers = ['platform_document_trap_scan_required_before_context_attachment'];
  if (risk.semantic_risk === 'high') {
    blockers.push('semantic_review_required_before_financial_or_decision_use');
  }
  if (outputTruncated) blockers.push('output_truncated_requires_artifact_review');
  if (format === 'pdf') blockers.push('ocr_fallback_required_when_text_extraction_is_unsupported');

  const receipt = buildReceipt({
    sourceHash,
    outputHash,
    evidenceUnits,
    structure,
    status: 'pending',
  });

  return {
    schema: 'agoragentic.anydoc-document-evidence.v1',
    adapter_version: '0.1.0-alpha.0',
    parser: {
      package: ANYDOC_PACKAGE,
      package_version: ANYDOC_VERSION,
      engine: 'firecrawl_anydoc',
      format,
      detected_by: resolved.detected_by,
      execution: 'local',
      network_used: false,
      ocr_used: false,
      parser_executed_by_adapter: true,
      document_model_status: format === 'pdf'
        ? 'unsupported_for_pdf'
        : documentModelError
          ? 'failed'
          : structure.status,
      document_model_error: documentModelError,
    },
    source: {
      source_id: sourceId,
      filename,
      source_format: format,
      ecf_document_type: ECF_DOCUMENT_TYPE[format] || 'markdown',
      size_bytes: bytes.byteLength,
      source_hash: sourceHash,
      raw_bytes_embedded: false,
    },
    output: {
      markdown: boundedMarkdown,
      markdown_chars: boundedMarkdown.length,
      original_markdown_chars: originalMarkdownChars,
      output_hash: outputHash,
      truncated: outputTruncated,
      structure,
      evidence_units: evidenceUnits,
    },
    risk,
    ecf_handoff: {
      trap_scan_required: true,
      trap_scan_status: 'not_scanned',
      context_packet_ready: false,
      memory_write_allowed: false,
      marketplace_publication_allowed: false,
      x402_activation_allowed: false,
      receipt,
      blockers,
      next_safe_action: 'Run the Agoragentic document trap scan, review format-specific semantic warnings, then build an owner-scoped context packet.',
    },
    authority: {
      grants_spend: false,
      grants_wallet_access: false,
      grants_deployment: false,
      grants_publication: false,
      grants_memory_write: false,
      grants_trust: false,
    },
    timing: {
      processing_time_ms: Date.now() - startedAt,
    },
  };
}

export async function convertFileToEvidence(filePath, options = {}) {
  const fileStat = await stat(filePath);
  if (!fileStat.isFile()) {
    throw new AnyDocEvidenceError('not_a_file', 'filePath must refer to a regular file.');
  }
  const maxInputBytes = boundedInteger(
    options.maxInputBytes,
    DEFAULT_MAX_INPUT_BYTES,
    1,
    HARD_MAX_INPUT_BYTES,
    'maxInputBytes',
  );
  if (fileStat.size > maxInputBytes) {
    throw new AnyDocEvidenceError(
      'input_too_large',
      `Document is ${fileStat.size} bytes; the configured limit is ${maxInputBytes}.`,
    );
  }
  const bytes = await readFile(filePath);
  return convertBytesToEvidence({
    bytes,
    filename: options.filename || basename(filePath),
    format: options.format,
  }, options);
}

export const ANYDOC_EVIDENCE_CONSTANTS = Object.freeze({
  ANYDOC_PACKAGE,
  ANYDOC_VERSION,
  SUPPORTED_FORMATS,
  DEFAULT_MAX_INPUT_BYTES,
  HARD_MAX_INPUT_BYTES,
  DEFAULT_MAX_MARKDOWN_CHARS,
  HARD_MAX_MARKDOWN_CHARS,
  MAX_EVIDENCE_UNITS,
});
