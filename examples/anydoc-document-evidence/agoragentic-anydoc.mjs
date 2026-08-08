import { fork } from 'node:child_process';
import { createHash } from 'node:crypto';
import { open } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { basename, dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const require = createRequire(import.meta.url);
const ANYDOC_PACKAGE = '@firecrawl/anydoc';
const ANYDOC_VERSION = '0.1.7';
const DEFAULT_MAX_INPUT_BYTES = 10 * 1024 * 1024;
const HARD_MAX_INPUT_BYTES = 50 * 1024 * 1024;
const DEFAULT_MAX_MARKDOWN_CHARS = 1_000_000;
const HARD_MAX_MARKDOWN_CHARS = 5_000_000;
const DEFAULT_CHUNK_CHARS = 4_000;
const MAX_EVIDENCE_UNITS = 256;
const DEFAULT_PARSER_TIMEOUT_MS = 30_000;
const HARD_PARSER_TIMEOUT_MS = 120_000;
const DEFAULT_PARSER_MEMORY_MB = 256;
const HARD_PARSER_MEMORY_MB = 1_024;
const MAX_TRAVERSAL_BLOCKS = 100_000;
const MAX_PARSER_STDERR_BYTES = 64 * 1024;
const READ_CHUNK_BYTES = 64 * 1024;
const WORKER_PATH = fileURLToPath(new URL('./parser-worker.mjs', import.meta.url));

const SUPPORTED_FORMATS = Object.freeze([
  'doc', 'docx', 'odt', 'pdf', 'ppt', 'pptx',
  'rtf', 'epub', 'xlsx', 'ods', 'odp', 'csv',
]);

const FORMAT_ALIASES = Object.freeze({
  docm: 'docx',
  pot: 'ppt',
  pps: 'ppt',
  pptm: 'pptx',
  ppsm: 'pptx',
  ppsx: 'pptx',
  xls: 'xlsx',
  xlsb: 'xlsx',
  xlsm: 'xlsx',
});

const SUPPORTED_INPUT_FORMATS = Object.freeze([
  ...SUPPORTED_FORMATS,
  ...Object.keys(FORMAT_ALIASES),
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
  if (Buffer.isBuffer(value) || value instanceof Uint8Array) return Buffer.from(value);
  throw new AnyDocEvidenceError('invalid_input', 'bytes must be a Buffer or Uint8Array.');
}

function normalizeFormat(value) {
  if (value === undefined || value === null || value === '') return null;
  const requested = String(value).trim().toLowerCase();
  const format = FORMAT_ALIASES[requested] || requested;
  if (!SUPPORTED_FORMATS.includes(format)) {
    throw new AnyDocEvidenceError(
      'unsupported_format',
      `format must be one of: ${SUPPORTED_INPUT_FORMATS.join(', ')}.`,
    );
  }
  return { requested, format };
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

function safeSliceEnd(value, start, proposedEnd) {
  let end = proposedEnd;
  const previous = value.charCodeAt(end - 1);
  const next = value.charCodeAt(end);
  if (previous >= 0xd800 && previous <= 0xdbff && next >= 0xdc00 && next <= 0xdfff) end -= 1;
  return end > start ? end : proposedEnd;
}

function preferredChunkEnd(markdown, start, maximumEnd, targetChars, minimumCoverageEnd) {
  if (maximumEnd >= markdown.length) return markdown.length;
  const minimumPreferred = Math.max(
    start + Math.floor(targetChars / 2),
    minimumCoverageEnd,
  );
  for (const separator of ['\n\n', '\n', ' ']) {
    const index = markdown.lastIndexOf(separator, maximumEnd - 1);
    const end = index < 0 ? -1 : index + separator.length;
    if (end >= minimumPreferred && end <= maximumEnd) return safeSliceEnd(markdown, start, end);
  }
  return safeSliceEnd(markdown, start, maximumEnd);
}

function splitMarkdown(markdown, targetChars, maxUnits) {
  const value = String(markdown);
  const chunks = [];
  let cursor = 0;

  while (cursor < value.length && chunks.length < maxUnits) {
    const remainingUnits = maxUnits - chunks.length;
    const maximumEnd = Math.min(cursor + targetChars, value.length);
    const minimumCoverageEnd = Math.min(
      maximumEnd,
      cursor + Math.max(1, value.length - cursor - ((remainingUnits - 1) * targetChars)),
    );
    const end = preferredChunkEnd(
      value,
      cursor,
      maximumEnd,
      targetChars,
      minimumCoverageEnd,
    );
    const chunk = value.slice(cursor, end);
    chunks.push({ markdown: chunk, start: cursor, end });
    cursor = end;
  }

  const coveredMarkdown = chunks.map((chunk) => chunk.markdown).join('');
  return {
    chunks,
    coverage: {
      total_chars: value.length,
      covered_chars: cursor,
      omitted_chars: value.length - cursor,
      complete: cursor === value.length,
      coverage_kind: 'ordered_prefix',
      covered_output_hash: sha256(coveredMarkdown),
      first_omitted_char: cursor === value.length ? null : cursor,
      max_unit_chars: targetChars,
      max_units: maxUnits,
    },
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
    { retryable: mapped[1], causeCode },
  );
}

function mapWorkerError(error) {
  const code = error?.code || 'parser_worker_failed';
  if (['unsupported', 'malformed', 'encrypted', 'resourceLimit', 'missingPart', 'io'].includes(code)) {
    return mapConvertError({ code });
  }
  if (code === 'network_disabled') {
    return new AnyDocEvidenceError(
      'network_boundary_violation',
      'The parser attempted a network operation and was stopped.',
      { causeCode: code },
    );
  }
  const known = {
    unsupported_format: 'The document format could not be detected or is unsupported.',
    empty_output: 'AnyDoc returned no meaningful Markdown.',
    incompatible_anydoc_api: 'The parser module does not expose the required AnyDoc API.',
    parser_version_mismatch: `The installed ${ANYDOC_PACKAGE} version does not match ${ANYDOC_VERSION}.`,
    invalid_worker_input: 'The isolated parser rejected its bounded input.',
  };
  return new AnyDocEvidenceError(
    known[code] ? code : 'parser_process_failed',
    known[code] || 'The isolated parser process failed.',
    { causeCode: error?.cause_code || code },
  );
}

function findNodeModulesRoot(entryPath) {
  let current = dirname(entryPath);
  while (dirname(current) !== current) {
    if (basename(current) === 'node_modules') return current;
    current = dirname(current);
  }
  return dirname(entryPath);
}

function parserDescriptor(options) {
  if (Object.prototype.hasOwnProperty.call(options, 'anydocLoader')) {
    throw new AnyDocEvidenceError(
      'invalid_option',
      'anydocLoader is not supported because parser code must run in the isolated child process.',
    );
  }

  if (options.parserModulePath === undefined) {
    return {
      kind: 'pinned_anydoc',
      specifier: ANYDOC_PACKAGE,
      label: ANYDOC_PACKAGE,
      readRoot: null,
    };
  }

  if (options.allowTestOnlyCustomParser !== true) {
    throw new AnyDocEvidenceError(
      'invalid_option',
      'parserModulePath is a test-only hook and requires allowTestOnlyCustomParser: true.',
    );
  }

  let moduleUrl;
  try {
    moduleUrl = options.parserModulePath instanceof URL
      ? options.parserModulePath
      : String(options.parserModulePath).startsWith('file:')
        ? new URL(String(options.parserModulePath))
        : pathToFileURL(resolve(String(options.parserModulePath)));
  } catch {
    throw new AnyDocEvidenceError('invalid_option', 'parserModulePath must be a local file path or file URL.');
  }
  if (moduleUrl.protocol !== 'file:') {
    throw new AnyDocEvidenceError('invalid_option', 'parserModulePath must use the file: protocol.');
  }
  const modulePath = fileURLToPath(moduleUrl);
  return {
    kind: 'custom_test_module',
    specifier: moduleUrl.href,
    label: safeFilename(modulePath),
    readRoot: dirname(modulePath),
  };
}

function permissionExecArgs(readRoots) {
  const flags = process.allowedNodeEnvironmentFlags;
  const permissionFlag = flags.has('--permission')
    ? '--permission'
    : flags.has('--experimental-permission')
      ? '--experimental-permission'
      : null;
  if (!permissionFlag || !flags.has('--allow-fs-read')) {
    throw new AnyDocEvidenceError(
      'parser_sandbox_unavailable',
      'This Node.js runtime cannot enforce the parser filesystem boundary.',
    );
  }

  const args = [permissionFlag];
  for (const root of [...new Set(readRoots)]) args.push(`--allow-fs-read=${root}`);
  if (flags.has('--allow-addons')) args.push('--allow-addons');
  return args;
}

function sanitizedParserEnvironment() {
  const allowedNames = new Set([
    'PATH', 'SYSTEMROOT', 'WINDIR', 'TEMP', 'TMP', 'HOME', 'USERPROFILE',
    'LANG', 'LC_ALL', 'LD_LIBRARY_PATH', 'DYLD_LIBRARY_PATH',
  ]);
  const environment = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (allowedNames.has(key.toUpperCase()) && value !== undefined) environment[key] = value;
  }
  environment.NAPI_RS_ENFORCE_VERSION_CHECK = '1';
  return environment;
}

function runParserProcess(job, limits, descriptor) {
  let anydocEntry;
  try {
    anydocEntry = require.resolve(ANYDOC_PACKAGE);
  } catch {
    throw new AnyDocEvidenceError(
      'parser_dependency_missing',
      `Install the pinned ${ANYDOC_PACKAGE}@${ANYDOC_VERSION} dependency before parsing.`,
    );
  }

  const readRoots = [dirname(WORKER_PATH), findNodeModulesRoot(anydocEntry)];
  if (descriptor.readRoot) readRoots.push(descriptor.readRoot);
  const execArgv = [
    `--max-old-space-size=${limits.parserMemoryMb}`,
    ...permissionExecArgs(readRoots),
  ];

  return new Promise((resolvePromise, rejectPromise) => {
    let child;
    try {
      child = fork(WORKER_PATH, [], {
        env: sanitizedParserEnvironment(),
        execArgv,
        serialization: 'advanced',
        stdio: ['ignore', 'ignore', 'pipe', 'ipc'],
        windowsHide: true,
      });
    } catch (error) {
      rejectPromise(new AnyDocEvidenceError(
        'parser_process_failed',
        'The isolated parser process could not be started.',
        { cause: error },
      ));
      return;
    }

    let settled = false;
    let stderrBytes = 0;

    const stop = () => {
      try {
        if (child.connected) child.disconnect();
      } catch {
        // The IPC channel already closed between the state check and disconnect.
      }
      try {
        if (!child.killed) child.kill('SIGKILL');
      } catch {
        // The process already exited between the state check and termination.
      }
    };
    const succeed = (value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      stop();
      resolvePromise({
        result: value,
        boundary: {
          process_isolated: true,
          killable: true,
          timeout_ms: limits.parserTimeoutMs,
          max_old_space_mb: limits.parserMemoryMb,
          max_input_bytes: limits.maxInputBytes,
          max_markdown_chars: limits.maxMarkdownChars,
          max_traversal_blocks: limits.maxTraversalBlocks,
          filesystem_policy: 'read_only_allowlist',
          child_process_allowed: false,
          network_policy: 'node_api_deny_guard',
          network_enforcement: 'node_api_guard',
          native_syscall_isolation: false,
        },
      });
    };
    const fail = (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      stop();
      rejectPromise(error);
    };

    const timer = setTimeout(() => {
      fail(new AnyDocEvidenceError(
        'parser_timeout',
        `The isolated parser exceeded ${limits.parserTimeoutMs} ms and was terminated.`,
      ));
    }, limits.parserTimeoutMs);
    timer.unref?.();

    child.stderr.on('data', (chunk) => {
      stderrBytes += chunk.byteLength;
      if (stderrBytes > MAX_PARSER_STDERR_BYTES) {
        fail(new AnyDocEvidenceError(
          'parser_resource_limit',
          'The isolated parser exceeded its diagnostic output limit.',
        ));
      }
    });
    child.once('error', () => {
      fail(new AnyDocEvidenceError('parser_process_failed', 'The isolated parser process failed to start.'));
    });
    child.once('exit', (code, signal) => {
      if (settled) return;
      const resourceFailure = signal || code === 134;
      fail(new AnyDocEvidenceError(
        resourceFailure ? 'parser_resource_limit' : 'parser_process_failed',
        resourceFailure
          ? 'The isolated parser was terminated by its process resource boundary.'
          : 'The isolated parser exited before returning a result.',
      ));
    });
    child.once('message', (message) => {
      if (!message || message.ok !== true) {
        fail(mapWorkerError(message?.error));
        return;
      }
      succeed(message.result);
    });

    child.send({
      ...job,
      parserKind: descriptor.kind,
      parserSpecifier: descriptor.specifier,
      parserLabel: descriptor.label,
      expectedPackage: ANYDOC_PACKAGE,
      expectedVersion: ANYDOC_VERSION,
      supportedFormats: SUPPORTED_FORMATS,
      formatAliases: FORMAT_ALIASES,
      extensionToFormat: EXTENSION_TO_FORMAT,
    }, (error) => {
      if (error) fail(new AnyDocEvidenceError('parser_process_failed', 'Parser input transfer failed.'));
    });
  });
}

function buildEvidenceUnits({ chunks, sourceId, sourceHash, outputHash, format, provenance }) {
  return chunks.map((chunk, index) => {
    const chunkHash = sha256(chunk.markdown);
    return {
      schema: 'agoragentic.evidence-unit.v1',
      evidence_unit_id: `evu_${chunkHash.slice(7, 19)}_${index}`,
      source_id: sourceId,
      document_type: ECF_DOCUMENT_TYPE[format] || 'markdown',
      source_format: format,
      section_path: sectionPathFromChunk(chunk.markdown, `chunk-${index + 1}`),
      page_range: [],
      source_char_range: [chunk.start, chunk.end],
      reading_order: index,
      content_type: 'markdown',
      text: '',
      markdown: chunk.markdown,
      html_table: '',
      formula_latex: '',
      image_refs: [],
      confidence: null,
      provenance: {
        parser_engine: provenance.engine,
        parser_version: provenance.package_version,
        parser_attested: provenance.attested,
        source_hash: sourceHash,
        output_hash: chunkHash,
        aggregate_output_hash: outputHash,
        citation: null,
      },
      trap_scan_status: 'not_scanned',
    };
  });
}

function parseCompleteness(parsed, coverage) {
  const blockers = [];
  if (parsed.markdown_truncated) blockers.push('markdown_output_limit_reached');
  if (!coverage.complete) blockers.push('evidence_unit_coverage_incomplete');
  if (parsed.document_model_status === 'failed') blockers.push('document_structure_extraction_failed');
  if (parsed.document_model_status === 'disabled_by_caller') blockers.push('document_structure_not_inspected');
  if (parsed.document_model_status === 'unsupported_for_pdf') blockers.push('document_structure_unavailable_for_pdf');
  if (parsed.structure.status === 'unavailable' && parsed.document_model_status === 'unavailable') {
    blockers.push('document_structure_unavailable');
  }
  if (parsed.structure.traversal_truncated) blockers.push('document_structure_traversal_incomplete');
  if (!parsed.provenance.attested) blockers.push('custom_parser_provenance_unverified');
  return {
    status: blockers.length === 0 ? 'complete' : 'incomplete',
    complete: blockers.length === 0,
    blockers,
  };
}

function buildReceipt({ sourceHash, outputHash, evidenceUnits, structure, parser, completeness, coverage }) {
  return {
    schema: 'agoragentic.parse-receipt.v1',
    receipt_type: 'document_parse_receipt',
    receipt_id: `rcpt_parse_${sha256(`${sourceHash}:${outputHash}`).slice(7, 19)}`,
    parse_job_id: null,
    context_packet_id: null,
    parser_engine: parser.engine,
    parser_version: parser.package_version,
    parser_mode: parser.attested ? 'isolated_local_fast_path' : 'isolated_custom_test_module',
    source_hashes: [sourceHash],
    output_hash: outputHash,
    evidence_unit_count: evidenceUnits.length,
    evidence_coverage: coverage,
    table_count: structure.table_count || 0,
    image_count: structure.asset_count || 0,
    formula_count: 0,
    trap_scan_status: 'not_scanned',
    completeness_status: completeness.status,
    completeness_blockers: completeness.blockers,
    status: completeness.complete ? 'pending' : 'incomplete',
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
  const parserTimeoutMs = boundedInteger(
    options.parserTimeoutMs,
    DEFAULT_PARSER_TIMEOUT_MS,
    1,
    HARD_PARSER_TIMEOUT_MS,
    'parserTimeoutMs',
  );
  const parserMemoryMb = boundedInteger(
    options.parserMemoryMb,
    DEFAULT_PARSER_MEMORY_MB,
    64,
    HARD_PARSER_MEMORY_MB,
    'parserMemoryMb',
  );
  const maxTraversalBlocks = boundedInteger(
    options.maxTraversalBlocks,
    MAX_TRAVERSAL_BLOCKS,
    1,
    MAX_TRAVERSAL_BLOCKS,
    'maxTraversalBlocks',
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

  const descriptor = parserDescriptor(options);
  const limits = {
    maxInputBytes,
    maxMarkdownChars,
    maxTraversalBlocks,
    parserMemoryMb,
    parserTimeoutMs,
  };
  const { result: parsed, boundary } = await runParserProcess({
    bytes,
    filename,
    explicitFormat: explicitFormat?.format || null,
    requestedFormat: explicitFormat?.requested || null,
    inspectStructure: options.inspectStructure !== false,
    maxMarkdownChars,
    maxTraversalBlocks,
  }, limits, descriptor);

  const sourceHash = sha256(bytes);
  const outputHash = sha256(parsed.markdown);
  const sourceId = `src_${sourceHash.slice(7, 19)}`;
  const { chunks, coverage } = splitMarkdown(parsed.markdown, chunkChars, maxEvidenceUnits);
  const evidenceUnits = buildEvidenceUnits({
    chunks,
    sourceId,
    sourceHash,
    outputHash,
    format: parsed.format,
    provenance: parsed.provenance,
  });
  const risk = riskProfile(parsed.format);
  const completeness = parseCompleteness(parsed, coverage);
  const truncationReasons = [];
  if (parsed.markdown_truncated) truncationReasons.push('markdown_output_limit');
  if (!coverage.complete) truncationReasons.push('evidence_unit_limit');
  if (parsed.structure.traversal_truncated) truncationReasons.push('document_structure_traversal_limit');

  const blockers = [
    'platform_document_trap_scan_required_before_context_attachment',
    ...completeness.blockers,
  ];
  if (risk.semantic_risk === 'high') {
    blockers.push('semantic_review_required_before_financial_or_decision_use');
  }
  if (parsed.format === 'pdf') blockers.push('ocr_fallback_required_when_text_extraction_is_unsupported');

  const receipt = buildReceipt({
    sourceHash,
    outputHash,
    evidenceUnits,
    structure: parsed.structure,
    parser: parsed.provenance,
    completeness,
    coverage,
  });

  return {
    schema: 'agoragentic.anydoc-document-evidence.v1',
    adapter_version: '0.1.0-alpha.0',
    parser: {
      package: parsed.provenance.package,
      package_version: parsed.provenance.package_version,
      engine: parsed.provenance.engine,
      provenance: parsed.provenance,
      format: parsed.format,
      requested_format: parsed.requested_format,
      format_alias_applied: parsed.format_alias_applied,
      detected_by: parsed.detected_by,
      execution: 'isolated_child_process',
      boundary,
      network: {
        status: parsed.network_boundary.attempts > 0 ? 'attempt_blocked' : 'not_observed',
        verified_absent: false,
        attempted_node_api_calls: parsed.network_boundary.attempts,
        observation_scope: 'node_network_apis_only',
      },
      ocr_used: parsed.provenance.attested ? false : 'unknown',
      parser_executed_by_adapter: true,
      document_model_status: parsed.document_model_status,
      document_model_error: parsed.document_model_error,
      resource_usage: parsed.resource_usage,
    },
    source: {
      source_id: sourceId,
      filename,
      source_format: parsed.format,
      requested_format: parsed.requested_format,
      ecf_document_type: ECF_DOCUMENT_TYPE[parsed.format] || 'markdown',
      size_bytes: bytes.byteLength,
      source_hash: sourceHash,
      raw_bytes_embedded: false,
    },
    output: {
      markdown: parsed.markdown,
      markdown_chars: parsed.markdown.length,
      original_markdown_chars: parsed.original_markdown_chars,
      output_hash: outputHash,
      truncated: truncationReasons.length > 0,
      truncation_reasons: truncationReasons,
      completeness,
      structure: parsed.structure,
      evidence_coverage: coverage,
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
      blockers: [...new Set(blockers)],
      next_safe_action: completeness.complete
        ? 'Run the Agoragentic document trap scan, review format-specific semantic warnings, then build an owner-scoped context packet.'
        : 'Resolve every parse completeness blocker by reparsing with bounded limits, splitting the source, or repairing structure extraction before trap scanning or context attachment.',
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

async function readFileBounded(filePath, maxInputBytes) {
  let handle;
  try {
    handle = await open(filePath, 'r');
    const fileStat = await handle.stat();
    if (!fileStat.isFile()) {
      throw new AnyDocEvidenceError('not_a_file', 'filePath must refer to a regular file.');
    }
    if (fileStat.size > maxInputBytes) {
      throw new AnyDocEvidenceError(
        'input_too_large',
        `Document is ${fileStat.size} bytes; the configured limit is ${maxInputBytes}.`,
      );
    }

    const chunks = [];
    let total = 0;
    while (total <= maxInputBytes) {
      const length = Math.min(READ_CHUNK_BYTES, maxInputBytes + 1 - total);
      const chunk = Buffer.allocUnsafe(length);
      const { bytesRead } = await handle.read(chunk, 0, length, null);
      if (bytesRead === 0) break;
      chunks.push(chunk.subarray(0, bytesRead));
      total += bytesRead;
    }
    if (total > maxInputBytes) {
      throw new AnyDocEvidenceError(
        'input_too_large',
        `Document exceeded the configured ${maxInputBytes}-byte limit while it was being read.`,
      );
    }
    return Buffer.concat(chunks, total);
  } catch (error) {
    if (error instanceof AnyDocEvidenceError) throw error;
    throw new AnyDocEvidenceError('io_error', 'The document could not be read.', {
      cause: error,
      retryable: true,
      causeCode: error?.code || null,
    });
  } finally {
    await handle?.close();
  }
}

export async function convertFileToEvidence(filePath, options = {}) {
  const maxInputBytes = boundedInteger(
    options.maxInputBytes,
    DEFAULT_MAX_INPUT_BYTES,
    1,
    HARD_MAX_INPUT_BYTES,
    'maxInputBytes',
  );
  const bytes = await readFileBounded(filePath, maxInputBytes);
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
  SUPPORTED_INPUT_FORMATS,
  FORMAT_ALIASES,
  DEFAULT_MAX_INPUT_BYTES,
  HARD_MAX_INPUT_BYTES,
  DEFAULT_MAX_MARKDOWN_CHARS,
  HARD_MAX_MARKDOWN_CHARS,
  MAX_EVIDENCE_UNITS,
  DEFAULT_PARSER_TIMEOUT_MS,
  HARD_PARSER_TIMEOUT_MS,
  DEFAULT_PARSER_MEMORY_MB,
  HARD_PARSER_MEMORY_MB,
  MAX_TRAVERSAL_BLOCKS,
});
