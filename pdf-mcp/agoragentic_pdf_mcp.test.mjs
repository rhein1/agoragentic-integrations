// Tests for the pdf-mcp Agoragentic adapter. They run fully offline against the
// in-repo stub MCP server (test-stub-server.mjs) — no network, no installed
// pdf-mcp package — and prove the stdio MCP client path end to end.
//
// Run: node --test pdf-mcp/agoragentic_pdf_mcp.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  PdfMcpAgoragenticAdapter,
  createPdfMcpAdapter,
  createPdfMcpTools,
  executePdfMcp,
  normalizePdfResult,
  selectPdfTool,
} from './agoragentic_pdf_mcp.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const STUB = path.join(HERE, 'test-stub-server.mjs');
const SAMPLE_PDF = path.join(HERE, 'fixtures', 'sample.pdf');

const stubOptions = (extraEnv = {}) => ({
  command: process.execPath,
  args: [STUB],
  env: extraEnv,
  timeoutMs: 10000,
});

test('executePdfMcp extracts text through a discovered MCP tool', async () => {
  const result = await executePdfMcp({ pdfPath: SAMPLE_PDF }, stubOptions());

  assert.equal(result.ok, true, JSON.stringify(result));
  assert.equal(result.text, 'Agoragentic PDF adapter smoke test.');
  assert.equal(result.pages, 1);
  assert.equal(result.metadata.title, 'sample');
  assert.equal(result.selected_tool, 'pdf_extract_text');

  assert.equal(result.receipt.adapter, 'pdf-mcp');
  assert.equal(result.receipt.transport, 'mcp-stdio');
  assert.equal(result.receipt.selected_tool, 'pdf_extract_text');
  assert.equal(result.receipt.input_path, SAMPLE_PDF);
  assert.ok(Number.isFinite(result.receipt.elapsed_ms));
  assert.deepEqual(result.receipt.discovered_tools.sort(), ['image_resize', 'pdf_extract_text']);
});

test('selectPdfTool honors explicit override when present', () => {
  const tools = [
    { name: 'pdf_extract_text', description: 'Extract text content from a PDF file.' },
    { name: 'image_resize', description: 'Resize an image.' },
  ];
  assert.equal(selectPdfTool(tools, 'image_resize').name, 'image_resize');
  assert.equal(selectPdfTool(tools, 'not_a_real_tool'), null);
  assert.equal(selectPdfTool(tools).name, 'pdf_extract_text');
});

test('executePdfMcp fails with bounded error when no compatible PDF tool is exposed', async () => {
  const result = await executePdfMcp({ pdfPath: SAMPLE_PDF }, stubOptions({ STUB_MODE: 'no-pdf-tools' }));

  assert.equal(result.ok, false);
  assert.equal(result.stage, 'tool_selection');
  assert.match(result.error, /no compatible PDF tool discovered/);
  assert.match(result.error, /audio_transcode/);
  assert.deepEqual(result.receipt.discovered_tools, ['audio_transcode']);
  assert.equal(result.receipt.ok, false);
});

test('executePdfMcp validates pdfPath before spawning anything', async () => {
  const missing = await executePdfMcp({ pdfPath: path.join(HERE, 'fixtures', 'nope.pdf') }, stubOptions());
  assert.equal(missing.ok, false);
  assert.equal(missing.stage, 'input_validation');

  const absent = await executePdfMcp({}, stubOptions());
  assert.equal(absent.ok, false);
  assert.equal(absent.stage, 'input_validation');
});

test('normalizePdfResult supports structuredContent, text blocks, and plain objects', () => {
  const fromStructured = normalizePdfResult({
    structuredContent: { text: 'hello', pages: 2, metadata: { title: 't' } },
  });
  assert.deepEqual(fromStructured, { text: 'hello', pages: 2, metadata: { title: 't' } });

  const fromBlocks = normalizePdfResult({ content: [{ type: 'text', text: 'block text' }] });
  assert.equal(fromBlocks.text, 'block text');

  const fromJsonBlock = normalizePdfResult({
    content: [{ type: 'text', text: JSON.stringify({ text: 'embedded', pages: 3 }) }],
  });
  assert.equal(fromJsonBlock.text, 'embedded');
  assert.equal(fromJsonBlock.pages, 3);

  const fromPlain = normalizePdfResult({ text: 'plain', pages: 5 });
  assert.equal(fromPlain.text, 'plain');
  assert.equal(fromPlain.pages, 5);
});

test('adapter execute() returns an agoragentic usage receipt', async () => {
  const adapter = createPdfMcpAdapter(stubOptions());
  assert.ok(adapter instanceof PdfMcpAgoragenticAdapter);

  const invocation = await adapter.execute('extract the text', { pdf_path: SAMPLE_PDF });
  assert.equal(invocation.status, 'completed');
  assert.equal(invocation.tool_name, 'pdf_extract_text');
  assert.equal(invocation.output.text, 'Agoragentic PDF adapter smoke test.');
  assert.equal(invocation.receipt.schema, 'agoragentic.usage-receipt.v1');
  assert.equal(invocation.receipt.status, 'settled');
  assert.ok(invocation.receipt.cost_usdc > 0);
  assert.ok(invocation.invocation_id.startsWith('inv_'));
  assert.equal(invocation.receipt.mcp.transport, 'mcp-stdio');
});

test('adapter match() ranks the pdf tool first and respects max_cost', async () => {
  const adapter = new PdfMcpAgoragenticAdapter(stubOptions());
  const matches = await adapter.match('extract pdf text');
  assert.ok(matches.length >= 2);
  assert.equal(matches[0].tool_name, 'pdf_extract_text');
  assert.ok(matches[0].match_score > matches[1].match_score);

  await assert.rejects(
    () => adapter.execute('extract', { pdf_path: SAMPLE_PDF }, { max_cost: 0 }),
    /exceeds max_cost/,
  );
});

test('createPdfMcpTools exposes the canonical agoragentic tool surface', async () => {
  const tools = createPdfMcpTools(stubOptions());
  assert.deepEqual(Object.keys(tools).sort(), ['agoragentic_execute', 'agoragentic_match']);
  assert.deepEqual(tools.agoragentic_execute.parameters.required, ['task']);

  const run = await tools.agoragentic_execute.execute({
    task: 'extract pdf text',
    input: { pdf_path: SAMPLE_PDF },
  });
  assert.equal(run.status, 'completed');
  assert.equal(run.receipt.schema, 'agoragentic.usage-receipt.v1');
});
