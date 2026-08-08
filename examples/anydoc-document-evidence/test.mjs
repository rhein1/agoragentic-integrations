import assert from 'node:assert/strict';
import test from 'node:test';
import {
  AnyDocEvidenceError,
  convertBytesToEvidence,
} from './agoragentic-anydoc.mjs';

const fakeAnyDoc = {
  formatFromBytes(bytes) {
    return Buffer.from(bytes).subarray(0, 4).toString('utf8') === 'PK\u0003\u0004' ? 'docx' : null;
  },
  formatFromPath(path) {
    return path.endsWith('.csv') ? 'csv' : null;
  },
  async toMarkdownBytes(bytes, format) {
    if (format === 'csv') return '# Sheet\n\n| name | value |\n| --- | --- |\n| alpha | 1 |';
    if (format === 'docx') return '# Report\n\nSafe paragraph.';
    throw Object.assign(new Error('unsupported'), { code: 'unsupported' });
  },
  async toDocument(_bytes, format) {
    if (format === 'csv') {
      return {
        blocks: [{
          kind: 'table',
          table: {
            grid: [[{ kind: 'origin', cell: { blocks: [], rowSpan: 1, colSpan: 1 } }]],
          },
        }],
        notes: [],
        assets: [],
      };
    }
    return {
      blocks: [{ kind: 'heading', content: [] }, { kind: 'paragraph', content: [] }],
      notes: [],
      assets: [{ data: Buffer.from('image'), mediaType: 'image/png' }],
    };
  },
};

const loader = async () => fakeAnyDoc;

test('builds a conservative ECF handoff and pending parse receipt', async () => {
  const result = await convertBytesToEvidence({
    bytes: Buffer.from('name,value\nalpha,1\n'),
    filename: 'sample.csv',
  }, { anydocLoader: loader });

  assert.equal(result.schema, 'agoragentic.anydoc-document-evidence.v1');
  assert.equal(result.parser.format, 'csv');
  assert.equal(result.parser.detected_by, 'filename');
  assert.equal(result.parser.network_used, false);
  assert.equal(result.source.raw_bytes_embedded, false);
  assert.equal(result.output.structure.table_count, 1);
  assert.equal(result.output.evidence_units.length, 1);
  assert.equal(result.output.evidence_units[0].trap_scan_status, 'not_scanned');
  assert.equal(result.risk.source_exact, false);
  assert.equal(result.risk.semantic_risk, 'high');
  assert(result.risk.limitations.includes('types_and_display_formats_are_not_authoritative'));
  assert.equal(result.ecf_handoff.context_packet_ready, false);
  assert.equal(result.ecf_handoff.receipt.status, 'pending');
  assert.equal(result.authority.grants_spend, false);
  assert.equal(result.authority.grants_publication, false);
});

test('content detection wins over a misleading extension', async () => {
  const result = await convertBytesToEvidence({
    bytes: Buffer.from([0x50, 0x4b, 0x03, 0x04, 1, 2, 3]),
    filename: 'misleading.pdf',
  }, { anydocLoader: loader });

  assert.equal(result.parser.format, 'docx');
  assert.equal(result.parser.detected_by, 'content');
  assert.equal(result.output.structure.asset_count, 1);
  assert(result.risk.limitations.includes('nested_tables_may_be_flattened'));
});

test('input byte limit fails before loading or parsing the document', async () => {
  let loaded = false;
  await assert.rejects(
    convertBytesToEvidence(
      { bytes: Buffer.alloc(11), filename: 'sample.csv' },
      {
        maxInputBytes: 10,
        anydocLoader: async () => {
          loaded = true;
          return fakeAnyDoc;
        },
      },
    ),
    error => error instanceof AnyDocEvidenceError && error.code === 'input_too_large',
  );
  assert.equal(loaded, false);
});

test('unsupported conversion errors are normalized without exposing source bytes', async () => {
  const broken = {
    ...fakeAnyDoc,
    formatFromBytes: () => 'pdf',
    async toMarkdownBytes() {
      throw Object.assign(new Error('image-only'), { code: 'unsupported' });
    },
  };

  await assert.rejects(
    convertBytesToEvidence(
      { bytes: Buffer.from('%PDF-image-only'), filename: 'scan.pdf' },
      { anydocLoader: async () => broken },
    ),
    error => (
      error instanceof AnyDocEvidenceError
      && error.code === 'unsupported_or_ocr_required'
      && error.causeCode === 'unsupported'
    ),
  );
});

test('invalid explicit formats fail closed', async () => {
  await assert.rejects(
    convertBytesToEvidence(
      { bytes: Buffer.from('x'), filename: 'x.bin', format: 'html' },
      { anydocLoader: loader },
    ),
    error => error instanceof AnyDocEvidenceError && error.code === 'unsupported_format',
  );
});
