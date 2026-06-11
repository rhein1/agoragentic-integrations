# PDF MCP Adapter Patch Plan

## Goal

Add a repository-native, dependency-light adapter that lets Agoragentic execute local PDF processing through an MCP server process, with a simple `execute()` wrapper, deterministic receipt metadata, and a runnable test that proves the MCP bridge path end to end.

## Evidence from the current repo

- `AGENTS.md` says new integrations must:
  - read and update `integrations.json`
  - keep existing `agoragentic_*` naming patterns
  - add or update a per-integration `README.md`
- `README.md` maintains the public integration table and points to `integrations.json` as the machine-readable index.
- `openfang/` is the closest pattern for a local bridge:
  - `agoragentic_openfang.mjs` exports reusable functions plus a CLI entrypoint
  - `agoragentic_openfang.test.mjs` uses `node:test`
  - `README.md` documents files, install, boundaries, and test commands
- `mcp/package.json` shows the repo already treats MCP bridges as Node 18+ stdio components.

## Files to add

### 1) `pdf-mcp/README.md`

Purpose:
- document what the adapter does
- explain that it is a local MCP client for a separately installed `pdf-mcp` server
- describe the `execute()` wrapper and receipt shape
- document env vars and test commands
- include sample input/output references

Key sections:
- title: `pdf-mcp + Agoragentic`
- status: `beta`
- files table
- install requirements: Node 18+, accessible `pdf-mcp` command through stdio
- quick start:
  - `node pdf-mcp/agoragentic_pdf_mcp.mjs inspect-tools`
  - `node pdf-mcp/agoragentic_pdf_mcp.mjs execute`
- env vars:
  - `PDF_MCP_COMMAND` default `npx`
  - `PDF_MCP_ARGS` default `-y pdf-mcp`
  - `PDF_MCP_TOOL_NAME` optional override
  - `PDF_MCP_TIMEOUT_MS` optional timeout
  - `PDF_INPUT_PATH` required for CLI execute mode
- output contract:
  - normalized `ok`
  - `text`
  - `pages`
  - `metadata`
  - `receipt`
- tests:
  - `node --check pdf-mcp/agoragentic_pdf_mcp.mjs`
  - `node --test pdf-mcp/agoragentic_pdf_mcp.test.mjs`

### 2) `pdf-mcp/agoragentic_pdf_mcp.mjs`

Purpose:
- be the actual adapter
- expose a local `execute()` wrapper around MCP stdio
- discover tools from the MCP server instead of hardcoding internals
- normalize results for Agoragentic-style downstream use

Exports:
- `createPdfMcpAdapter(options = {})`
- `selectPdfTool(tools, preferredToolName)`
- `normalizePdfResult(rawResult, context = {})`
- `executePdfMcp(params, options = {})`

Recommended adapter behavior:

1. Process launch
- use `node:child_process` `spawn`
- default command resolution:
  - `command = options.command || process.env.PDF_MCP_COMMAND || "npx"`
  - `args = options.args || parseArgString(process.env.PDF_MCP_ARGS) || ["-y", "pdf-mcp"]`
- use `stdio: ["pipe", "pipe", "pipe"]`

2. MCP session bootstrap
- send JSON-RPC `initialize`
- send `notifications/initialized`
- call `tools/list`

3. Tool selection
- if `PDF_MCP_TOOL_NAME` or explicit option is set, use exact name match
- otherwise choose the first tool whose name matches one of:
  - `/extract/i`
  - `/text/i`
  - `/read/i`
  - `/parse/i`
  - `/pdf/i`
- if no compatible tool is found, throw a bounded error listing discovered tool names

4. Input mapping
- primary input should be a local path, not inline secret-bearing blobs
- accepted execute params:
  - `pdfPath` required
  - `prompt` optional
  - `toolArguments` optional object override
- build tool call args conservatively:
  - include `path`, `pdf_path`, and `file_path` only when present in override or selected schema hints
  - include `prompt` only when provided
- validate that `pdfPath` exists before launching the MCP call

5. Result normalization
- support common MCP tool response forms:
  - `structuredContent`
  - `content[]` text blocks
  - plain object result
- normalize to:
  - `ok: true`
  - `text`
  - `pages`
  - `metadata`
  - `selected_tool`
  - `receipt`
- receipt should include:
  - `adapter: "pdf-mcp"`
  - `transport: "mcp-stdio"`
  - `command`
  - `args`
  - `request_id`
  - `selected_tool`
  - `discovered_tools`
  - `input_path`
  - `elapsed_ms`

6. Error handling
- surface bounded errors for:
  - process spawn failure
  - MCP initialize timeout
  - malformed JSON-RPC
  - no compatible tool discovered
  - tool call error
  - missing or unreadable input path
- include a `receipt` object on failures when possible:
  - `ok: false`
  - `stage`
  - `message`
  - `selected_tool`
  - `discovered_tools`

7. CLI mode
- support:
  - `inspect-tools`
  - `execute`
- `execute` reads:
  - `PDF_INPUT_PATH`
  - optional `PDF_PROMPT`
- print normalized JSON to stdout

Recommended structure:
- small helper for JSON-RPC framing
- small `McpStdioClient` class
- one normalization function
- one high-level adapter factory
- no external runtime deps

### 3) `pdf-mcp/agoragentic_pdf_mcp.test.mjs`

Purpose:
- prove the adapter works without requiring network access or a real installed `pdf-mcp`
- exercise the local `execute()` wrapper against a stub MCP server over stdio

Test shape:
- use `node:test` and `node:assert/strict`
- create temp working directory
- write a small fixture PDF path into temp
- spawn a local stub MCP server script from the test
- point adapter at that stub via explicit `command` and `args`
- verify:
  - initialize happens
  - tool discovery works
  - tool selection works
  - `executePdfMcp()` returns normalized text
  - receipt includes `selected_tool`, `transport`, `elapsed_ms`
  - failure path returns discovered tool list when no compatible tool exists

Core test cases:
1. `executePdfMcp extracts text through a discovered MCP tool`
2. `selectPdfTool honors explicit override when present`
3. `executePdfMcp fails with bounded error when no compatible PDF tool is exposed`

### 4) `pdf-mcp/test-stub-server.mjs`

Purpose:
- deterministic in-repo MCP server used only by tests

Behavior:
- reply to `initialize`
- accept `notifications/initialized`
- return from `tools/list`:
  - one compatible tool, e.g. `pdf_extract_text`
- return from `tools/call`:
  - `structuredContent` containing:
    - `text: "Agoragentic PDF adapter smoke test."`
    - `pages: 1`
    - `metadata: { title: "sample" }`

This keeps tests stable even if the external `pdf-mcp` package changes.

### 5) `pdf-mcp/fixtures/sample.pdf`

Purpose:
- give the test a real local file path to pass into `execute()`

Content:
- tiny one-page PDF
- simplest acceptable text payload:
  - visible text: `Agoragentic PDF adapter smoke test.`

### 6) `pdf-mcp/fixtures/sample-output.json`

Purpose:
- document the expected normalized adapter output
- reference it in the README and assert against it in tests where helpful

Expected shape:
- `ok: true`
- `text: "Agoragentic PDF adapter smoke test."`
- `pages: 1`
- `metadata.title: "sample"`
- `selected_tool: "pdf_extract_text"`
- `receipt.adapter: "pdf-mcp"`

## Files to update

### 7) `README.md`

Add one row to the integration table:

- Framework: `pdf-mcp`
- Language: `Javascript`
- Status: `Beta`
- Path: `pdf-mcp/agoragentic_pdf_mcp.mjs`
- Docs: `pdf-mcp/README.md`

Keep wording consistent with other rows.

### 8) `integrations.json`

Add a new integration entry:
- `id`: `pdf-mcp`
- `name`: `pdf-mcp`
- `language`: `javascript`
- `status`: `beta`
- `path`: `pdf-mcp/agoragentic_pdf_mcp.mjs`
- `install`: `npx -y pdf-mcp`
- `docs`: `pdf-mcp/README.md`

Also add references near the bottom:
- `pdf_mcp`: `pdf-mcp/README.md`
- `pdf_mcp_adapter`: `pdf-mcp/agoragentic_pdf_mcp.mjs`

## Implementation details that matter

### Normalized `execute()` contract

The adapter should return:

- `ok`
- `text`
- `pages`
- `metadata`
- `selected_tool`
- `raw_result`
- `receipt`

Example normalized success payload:

- `ok: true`
- `text: "Agoragentic PDF adapter smoke test."`
- `pages: 1`
- `metadata: { "title": "sample" }`
- `selected_tool: "pdf_extract_text"`
- `receipt: { "adapter": "pdf-mcp", "transport": "mcp-stdio", ... }`

### Why discovery-first is the right shape here

The exact external `pdf-mcp` tool name is the main uncertainty. Hardcoding a single tool ID would make the contribution brittle. A discovery-first adapter avoids coupling to one package revision and still remains bounded:
- list tools
- select a compatible candidate
- call it
- normalize the response

That makes the adapter immediately usable even if the upstream MCP server exposes `pdf_extract_text`, `extract_pdf_text`, or a similar variant.

### Why a stub server belongs in-repo

Using a stub MCP server gives maintainers:
- a stable regression test
- no dependency on external package availability
- no hidden install-time network requirement
- proof that the stdio MCP client logic is correct

## Test command matrix

Validation commands the PR should pass:

- `node --check pdf-mcp/agoragentic_pdf_mcp.mjs`
- `node --test pdf-mcp/agoragentic_pdf_mcp.test.mjs`

Optional manual smoke test once `pdf-mcp` is actually installed locally:

- `PDF_INPUT_PATH=pdf-mcp/fixtures/sample.pdf node pdf-mcp/agoragentic_pdf_mcp.mjs execute`

## Residual uncertainty

1. The upstream `pdf-mcp` package’s exact tool names and input schema are not visible from this repo.
   - Mitigation: use MCP `tools/list` discovery and configurable `PDF_MCP_TOOL_NAME`.

2. The upstream server may return either `structuredContent` or text blocks.
   - Mitigation: normalization must support both forms.

3. A real `pdf-mcp` package may require different spawn args than `npx -y pdf-mcp`.
   - Mitigation: expose `command` and `args` overrides plus `PDF_MCP_COMMAND` and `PDF_MCP_ARGS`.

## Acceptance criteria

This patch is complete when:
- `pdf-mcp/agoragentic_pdf_mcp.mjs` provides a reusable local `execute()` wrapper
- the adapter talks MCP over stdio
- the adapter emits bounded receipts and useful errors
- `node --test pdf-mcp/agoragentic_pdf_mcp.test.mjs` passes using the in-repo stub server
- `README.md` and `integrations.json` expose the new integration consistently