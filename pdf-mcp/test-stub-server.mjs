// Deterministic in-repo MCP stub server used only by the adapter tests.
// Speaks newline-delimited JSON-RPC over stdio like a real MCP server, so the
// test suite proves the client logic without network access or an installed
// `pdf-mcp` package.
//
// Modes (STUB_MODE env var):
//   default        — exposes `pdf_extract_text` (compatible) + `image_resize`
//   no-pdf-tools   — exposes only `audio_transcode` (nothing PDF-compatible)
import { createInterface } from 'node:readline';

const MODE = process.env.STUB_MODE || 'default';

const TOOLS = MODE === 'no-pdf-tools'
  ? [{
      name: 'audio_transcode',
      description: 'Transcode audio between formats.',
      inputSchema: { type: 'object', properties: { source: { type: 'string' } } },
    }]
  : [
      {
        name: 'pdf_extract_text',
        description: 'Extract text content from a PDF file.',
        inputSchema: {
          type: 'object',
          properties: { path: { type: 'string' }, prompt: { type: 'string' } },
          required: ['path'],
        },
      },
      {
        name: 'image_resize',
        description: 'Resize an image to the given dimensions.',
        inputSchema: { type: 'object', properties: { path: { type: 'string' }, width: { type: 'number' } } },
      },
    ];

function reply(id, result) {
  process.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', id, result })}\n`);
}

function replyError(id, message) {
  process.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', id, error: { code: -32601, message } })}\n`);
}

const lines = createInterface({ input: process.stdin });
lines.on('line', (line) => {
  const text = line.trim();
  if (!text) return;
  let message;
  try { message = JSON.parse(text); } catch { return; }
  const { id, method, params } = message;

  if (method === 'initialize') {
    reply(id, {
      protocolVersion: params?.protocolVersion || '2024-11-05',
      serverInfo: { name: 'pdf-mcp-test-stub', version: '1.0.0' },
      capabilities: { tools: {} },
    });
    return;
  }
  if (method === 'notifications/initialized') return; // notification, no reply
  if (method === 'tools/list') {
    reply(id, { tools: TOOLS });
    return;
  }
  if (method === 'tools/call') {
    if (params?.name === 'pdf_extract_text') {
      reply(id, {
        structuredContent: {
          text: 'Agoragentic PDF adapter smoke test.',
          pages: 1,
          metadata: { title: 'sample' },
        },
        content: [{ type: 'text', text: 'Agoragentic PDF adapter smoke test.' }],
      });
      return;
    }
    if (id !== undefined) replyError(id, `Unknown tool: ${params?.name}`);
    return;
  }
  if (id !== undefined) replyError(id, `Method not found: ${method}`);
});
