import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import {
  AnyDocEvidenceError,
  convertBytesToEvidence,
} from './agoragentic-anydoc.mjs';

const parserModulePath = fileURLToPath(new URL('./test-fixtures/fake-anydoc.mjs', import.meta.url));
const customParser = Object.freeze({
  parserModulePath,
  allowTestOnlyCustomParser: true,
});

test('the distributable package carries its declared Apache-2.0 license', async () => {
  const license = await readFile(new URL('./LICENSE', import.meta.url), 'utf8');
  assert.match(license, /Apache License/);
  assert.match(license, /Version 2\.0, January 2004/);
});

test('custom parser provenance is explicit and blocks a complete receipt', async () => {
  const result = await convertBytesToEvidence({
    bytes: Buffer.from('name,value\nalpha,1\n'),
    filename: 'sample.csv',
  }, customParser);

  assert.equal(result.schema, 'agoragentic.anydoc-document-evidence.v1');
  assert.equal(result.parser.format, 'csv');
  assert.equal(result.parser.detected_by, 'filename');
  assert.equal(result.parser.package, 'custom_parser_module');
  assert.equal(result.parser.package_version, null);
  assert.equal(result.parser.provenance.attested, false);
  assert.equal(result.parser.network.status, 'not_observed');
  assert.equal(result.parser.network.verified_absent, false);
  assert.equal(result.parser.network.observation_scope, 'node_network_apis_only');
  assert.equal(result.parser.execution, 'isolated_child_process');
  assert.equal(result.parser.boundary.killable, true);
  assert.equal(result.parser.boundary.filesystem_policy, 'read_only_allowlist');
  assert.equal(result.source.raw_bytes_embedded, false);
  assert.equal(result.output.structure.table_count, 1);
  assert.equal(result.output.evidence_units.length, 1);
  assert.equal(result.output.evidence_units[0].trap_scan_status, 'not_scanned');
  assert.equal(result.output.evidence_coverage.complete, true);
  assert.equal(result.risk.source_exact, false);
  assert.equal(result.risk.semantic_risk, 'high');
  assert(result.risk.limitations.includes('types_and_display_formats_are_not_authoritative'));
  assert.equal(result.ecf_handoff.context_packet_ready, false);
  assert.equal(result.ecf_handoff.receipt.status, 'incomplete');
  assert(result.ecf_handoff.blockers.includes('custom_parser_provenance_unverified'));
  assert.equal(result.authority.grants_spend, false);
  assert.equal(result.authority.grants_publication, false);
});

test('content detection wins over a misleading extension', async () => {
  const result = await convertBytesToEvidence({
    bytes: Buffer.from([0x50, 0x4b, 0x03, 0x04, 1, 2, 3]),
    filename: 'misleading.pdf',
  }, customParser);

  assert.equal(result.parser.format, 'docx');
  assert.equal(result.parser.detected_by, 'content');
  assert.equal(result.output.structure.asset_count, 1);
  assert(result.risk.limitations.includes('nested_tables_may_be_flattened'));
});

test('input byte limit fails before resolving or starting the parser', async () => {
  await assert.rejects(
    convertBytesToEvidence(
      { bytes: Buffer.alloc(11), filename: 'sample.csv' },
      {
        maxInputBytes: 10,
        parserModulePath: 'does-not-exist.mjs',
        allowTestOnlyCustomParser: true,
      },
    ),
    error => error instanceof AnyDocEvidenceError && error.code === 'input_too_large',
  );
});

test('unsupported conversion errors are normalized without exposing source bytes', async () => {
  await assert.rejects(
    convertBytesToEvidence(
      { bytes: Buffer.from('UNSUPPORTED'), filename: 'scan.pdf', format: 'pdf' },
      customParser,
    ),
    error => (
      error instanceof AnyDocEvidenceError
      && error.code === 'unsupported_or_ocr_required'
      && error.causeCode === 'unsupported'
      && !error.message.includes('UNSUPPORTED')
    ),
  );
});

test('invalid explicit formats fail closed', async () => {
  await assert.rejects(
    convertBytesToEvidence(
      { bytes: Buffer.from('x'), filename: 'x.bin', format: 'html' },
      customParser,
    ),
    error => error instanceof AnyDocEvidenceError && error.code === 'unsupported_format',
  );
});

test('the former arbitrary in-process loader hook fails closed', async () => {
  await assert.rejects(
    convertBytesToEvidence(
      { bytes: Buffer.from('x'), filename: 'x.csv' },
      { anydocLoader: async () => ({}) },
    ),
    error => (
      error instanceof AnyDocEvidenceError
      && error.code === 'invalid_option'
      && /isolated child process/.test(error.message)
    ),
  );
});

test('advertised macro and binary format aliases normalize to canonical AnyDoc formats', async () => {
  for (const [alias, canonical] of Object.entries({
    docm: 'docx',
    pptm: 'pptx',
    xlsm: 'xlsx',
    xlsb: 'xlsx',
  })) {
    const result = await convertBytesToEvidence({
      bytes: Buffer.from(`alias:${alias}`),
      filename: `sample.${alias}`,
      format: alias,
    }, customParser);
    assert.equal(result.parser.format, canonical);
    assert.equal(result.parser.requested_format, alias);
    assert.equal(result.parser.format_alias_applied, true);
  }
});

test('long paragraphs are hard-split and evidence coverage reports every omitted character', async () => {
  const result = await convertBytesToEvidence({
    bytes: Buffer.from('LONG'),
    filename: 'long.csv',
    format: 'csv',
  }, {
    ...customParser,
    chunkChars: 500,
    maxEvidenceUnits: 3,
    maxMarkdownChars: 10_000,
  });

  assert.equal(result.output.markdown.includes('FINAL_MARKER'), true);
  assert.equal(result.output.evidence_units.length, 3);
  assert(result.output.evidence_units.every((unit) => unit.markdown.length <= 500));
  const covered = result.output.evidence_units.map((unit) => unit.markdown).join('');
  assert.equal(covered, result.output.markdown.slice(0, covered.length));
  assert.equal(result.output.evidence_coverage.covered_chars, covered.length);
  assert.equal(
    result.output.evidence_coverage.omitted_chars,
    result.output.markdown.length - covered.length,
  );
  assert.equal(result.output.evidence_coverage.complete, false);
  assert.equal(result.output.evidence_coverage.first_omitted_char, covered.length);
  assert.equal(result.output.truncated, true);
  assert(result.output.truncation_reasons.includes('evidence_unit_limit'));
  assert(result.output.completeness.blockers.includes('evidence_unit_coverage_incomplete'));
  assert.equal(result.ecf_handoff.receipt.status, 'incomplete');
  assert(!covered.includes('FINAL_MARKER'));
});

test('preferred boundaries do not waste available evidence capacity', async () => {
  const result = await convertBytesToEvidence({
    bytes: Buffer.from('COVERAGE_CAPACITY'),
    filename: 'capacity.csv',
    format: 'csv',
  }, {
    ...customParser,
    chunkChars: 500,
    maxEvidenceUnits: 2,
    maxMarkdownChars: 10_000,
  });

  assert.deepEqual(result.output.evidence_units.map((unit) => unit.markdown.length), [500, 500]);
  assert.equal(result.output.evidence_coverage.covered_chars, 1_000);
  assert.equal(result.output.evidence_coverage.omitted_chars, 0);
  assert.equal(result.output.evidence_coverage.complete, true);
  assert.equal(result.output.truncated, false);
});

test('document-model failures are completeness blockers', async () => {
  const result = await convertBytesToEvidence({
    bytes: Buffer.from('STRUCTURE_FAIL'),
    filename: 'structure.csv',
    format: 'csv',
  }, customParser);

  assert.equal(result.parser.document_model_status, 'failed');
  assert.equal(result.output.structure.status, 'failed');
  assert(result.output.completeness.blockers.includes('document_structure_extraction_failed'));
  assert(result.ecf_handoff.blockers.includes('document_structure_extraction_failed'));
  assert.equal(result.ecf_handoff.receipt.status, 'incomplete');
  assert.match(result.ecf_handoff.next_safe_action, /completeness blocker/);
});

test('bounded structure traversal is reported as incomplete', async () => {
  const result = await convertBytesToEvidence({
    bytes: Buffer.from('TRAVERSAL'),
    filename: 'traversal.csv',
    format: 'csv',
  }, {
    ...customParser,
    maxTraversalBlocks: 3,
  });

  assert.equal(result.output.structure.block_count, 3);
  assert.equal(result.output.structure.traversal_truncated, true);
  assert(result.output.truncation_reasons.includes('document_structure_traversal_limit'));
  assert(result.output.completeness.blockers.includes('document_structure_traversal_incomplete'));
});

test('global and named-import network attempts inside the parser process are denied', async () => {
  await assert.rejects(
    convertBytesToEvidence(
      { bytes: Buffer.from('NETWORK'), filename: 'network.csv', format: 'csv' },
      customParser,
    ),
    error => error instanceof AnyDocEvidenceError && error.code === 'network_boundary_violation',
  );

  let requests = 0;
  const server = createServer((_request, response) => {
    requests += 1;
    response.end('unexpected');
  });
  await new Promise((resolvePromise, rejectPromise) => {
    server.once('error', rejectPromise);
    server.listen(0, '127.0.0.1', resolvePromise);
  });
  try {
    const address = server.address();
    await assert.rejects(
      convertBytesToEvidence(
        {
          bytes: Buffer.from(`NETWORK_HTTP:${address.port}`),
          filename: 'network.csv',
          format: 'csv',
        },
        customParser,
      ),
      error => error instanceof AnyDocEvidenceError && error.code === 'network_boundary_violation',
    );
  } finally {
    await new Promise((resolvePromise) => server.close(resolvePromise));
  }
  assert.equal(requests, 0);
});

test('a hanging parser is killed at the configured deadline', async () => {
  const startedAt = Date.now();
  await assert.rejects(
    convertBytesToEvidence(
      { bytes: Buffer.from('HANG'), filename: 'hang.csv', format: 'csv' },
      { ...customParser, parserTimeoutMs: 100 },
    ),
    error => error instanceof AnyDocEvidenceError && error.code === 'parser_timeout',
  );
  assert(Date.now() - startedAt < 5_000);
});
