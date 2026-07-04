# pdf-mcp + Agoragentic

**Status: Beta**

A local MCP stdio client that lets agents execute PDF processing through a
separately installed [`pdf-mcp`](https://www.npmjs.com/package/pdf-mcp) server
(or any MCP server that exposes a PDF tool), wrapped in a simple `execute()`
surface with deterministic receipt metadata.

Discovery-first by design: the adapter lists the server's tools, selects a
compatible PDF tool by name/description relevance, calls it, and normalizes the
response. It keeps working whether the upstream server exposes
`pdf_extract_text`, `extract_pdf_text`, or a similar variant, and an explicit
tool name override is available when you want exact control.

## Files

| File | Purpose |
|------|---------|
| `agoragentic_pdf_mcp.mjs` | The adapter: MCP stdio client, `executePdfMcp()`, adapter class, canonical tools, CLI |
| `agoragentic_pdf_mcp.test.mjs` | Offline test suite (`node:test`) — proves the MCP bridge end to end |
| `stub-mcp-server.mjs` | Deterministic in-repo MCP stub server used only by tests |
| `fixtures/sample.pdf` | Tiny one-page PDF fixture |
| `fixtures/sample-output.json` | Expected normalized adapter output shape |

## Install

- Node 18+ (no external runtime dependencies — uses only `node:*` builtins)
- A `pdf-mcp` command reachable through stdio, e.g. `npx -y pdf-mcp`

## Quick start

```bash
# See which tools the configured MCP server exposes
node pdf-mcp/agoragentic_pdf_mcp.mjs inspect-tools

# Process a PDF
PDF_INPUT_PATH=pdf-mcp/fixtures/sample.pdf node pdf-mcp/agoragentic_pdf_mcp.mjs execute
```

```js
import { executePdfMcp } from './pdf-mcp/agoragentic_pdf_mcp.mjs';

const result = await executePdfMcp({
  pdfPath: 'contracts/agreement.pdf',
  prompt: 'extract the executive summary',
});
// { ok, text, pages, metadata, selected_tool, raw_result, receipt }
```

For framework integrations, the canonical Agoragentic tool surface (see
`AGENTS.md`) is available too:

```js
import { createPdfMcpTools } from './pdf-mcp/agoragentic_pdf_mcp.mjs';

const tools = createPdfMcpTools();
// tools.agoragentic_match    — preview/rank the server's tools for a task
// tools.agoragentic_execute  — run the task, get output + a usage receipt
```

## Environment variables

| Variable | Default | Purpose |
|----------|---------|---------|
| `PDF_MCP_COMMAND` | `npx` | Command used to spawn the MCP server |
| `PDF_MCP_ARGS` | `-y pdf-mcp` | Arguments for the spawn command (whitespace-separated) |
| `PDF_MCP_TOOL_NAME` | _(unset)_ | Exact tool name override — skips discovery ranking |
| `PDF_MCP_TIMEOUT_MS` | `120000` | Per-request timeout |
| `PDF_INPUT_PATH` | _(required for CLI `execute`)_ | PDF file to process |
| `PDF_PROMPT` | _(optional)_ | Prompt/instruction forwarded to the tool |

## Output contract

`executePdfMcp()` always resolves (never throws on operational failures) with:

| Field | Meaning |
|-------|---------|
| `ok` | `true` on success; `false` with `error` + `stage` on failure |
| `text` | Extracted/produced text, normalized from `structuredContent`, `content[]` text blocks, or a plain object |
| `pages` | Page count when the server reports it, else `null` |
| `metadata` | Server-reported metadata object |
| `selected_tool` | The MCP tool actually invoked |
| `raw_result` | The unmodified `tools/call` result |
| `receipt` | `{ adapter: "pdf-mcp", transport: "mcp-stdio", command, args, request_id, selected_tool, discovered_tools, input_path, elapsed_ms }` |

Failure stages are bounded: `input_validation`, `mcp_session`, `tool_selection`
(the error lists every discovered tool name), and `tool_call`. Failure receipts
keep `discovered_tools` so callers can self-correct with `PDF_MCP_TOOL_NAME`.

See [`fixtures/sample-output.json`](fixtures/sample-output.json) for the
expected normalized success payload.

## Tests

```bash
node --check pdf-mcp/agoragentic_pdf_mcp.mjs
node --test pdf-mcp/agoragentic_pdf_mcp.test.mjs
```

The suite runs fully offline against `stub-mcp-server.mjs` (newline-delimited
JSON-RPC over stdio, like a real MCP server), covering: end-to-end extraction,
explicit tool override, the no-compatible-tool failure path, input validation,
all three result normalization forms, usage receipts, ranking, and `max_cost`
enforcement.

## Boundaries

- Local-only: spawns a local MCP server process; no hosted Agoragentic calls,
  no wallet spend, no network requirement.
- The primary input is a local file path — not inline secret-bearing blobs.
- `cost_usdc` figures in the marketplace-style usage receipt are local
  estimates for budgeting, not settled charges.
