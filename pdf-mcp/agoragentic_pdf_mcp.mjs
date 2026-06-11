// pdf-mcp + Agoragentic adapter.
//
// Local MCP stdio client for a separately installed `pdf-mcp` server, exposing a
// simple `execute()` wrapper with deterministic receipt metadata. Discovery-first:
// it lists the server's tools, selects a compatible PDF tool, calls it, and
// normalizes the response — so it keeps working across upstream tool renames
// (`pdf_extract_text`, `extract_pdf_text`, ...).
//
// Transport note: MCP stdio messages are newline-delimited JSON-RPC (one JSON
// object per line), matching the MCP spec and this repo's own `mcp/mcp-server.js`.
//
// No external runtime dependencies. Node 18+.
import { spawn } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { createInterface } from 'node:readline';
import { pathToFileURL } from 'node:url';

const DEFAULT_COMMAND = process.env.PDF_MCP_COMMAND || 'npx';
const DEFAULT_ARGS = parseArgString(process.env.PDF_MCP_ARGS) || ['-y', 'pdf-mcp'];
const DEFAULT_TIMEOUT_MS = numberFromEnv(process.env.PDF_MCP_TIMEOUT_MS, 120000);
const DEFAULT_COST_USDC = numberFromEnv(process.env.PDF_MCP_COST_USDC, 0.01);
const COMPATIBLE_NAME_PATTERNS = [/extract/i, /text/i, /read/i, /parse/i, /pdf/i];

function numberFromEnv(value, fallback) {
  if (value === undefined || value === null || value === '') return fallback;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function parseArgString(value) {
  if (!value) return null;
  return value.split(/\s+/).map((part) => part.trim()).filter(Boolean);
}

function stableId(prefix, parts) {
  const hash = createHash('sha256');
  for (const part of parts) {
    hash.update(String(part ?? ''));
    hash.update('');
  }
  return `${prefix}_${hash.digest('hex').slice(0, 24)}`;
}

function clone(value) {
  return value === undefined ? undefined : JSON.parse(JSON.stringify(value));
}

function normalizeToolDescriptor(tool) {
  return {
    name: String(tool?.name || ''),
    description: typeof tool?.description === 'string' ? tool.description : '',
    inputSchema: tool?.inputSchema && typeof tool.inputSchema === 'object'
      ? tool.inputSchema
      : { type: 'object', properties: {} },
  };
}

// ---------------------------------------------------------------------------
// MCP stdio client (newline-delimited JSON-RPC)
// ---------------------------------------------------------------------------

export class McpStdioClient {
  constructor(options = {}) {
    this.command = options.command || DEFAULT_COMMAND;
    this.args = options.args || DEFAULT_ARGS;
    this.cwd = options.cwd;
    this.env = { ...process.env, ...(options.env || {}) };
    this.timeoutMs = options.timeoutMs || DEFAULT_TIMEOUT_MS;
    this.protocolVersion = options.protocolVersion || '2024-11-05';
    this.requestId = 0;
    this.pending = new Map();
    this.stderr = [];
    this.process = null;
    this.ready = false;
    this.startPromise = null;
  }

  async start() {
    if (this.ready && this.process) return;
    if (!this.startPromise) {
      this.startPromise = this.#startInternal().finally(() => { this.startPromise = null; });
    }
    await this.startPromise;
  }

  async #startInternal() {
    if (this.process) return;

    // `npx`/`npm` are .cmd shims on Windows and need a shell to spawn.
    const needsShell = process.platform === 'win32'
      && /^(npx|npm)(\.cmd)?$/i.test(String(this.command));

    this.process = spawn(this.command, this.args, {
      cwd: this.cwd,
      env: this.env,
      stdio: ['pipe', 'pipe', 'pipe'],
      shell: needsShell,
      windowsHide: true,
    });

    const lines = createInterface({ input: this.process.stdout });
    lines.on('line', (line) => this.#onLine(line));
    this.process.stderr.on('data', (chunk) => {
      const text = chunk.toString('utf8').trim();
      if (text) this.stderr.push(text);
    });
    this.process.on('error', (error) => this.#failPending(error));
    this.process.on('exit', (code, signal) => {
      this.ready = false;
      this.#failPending(new Error(
        `pdf-mcp server exited${code !== null ? ` with code ${code}` : ''}${signal ? ` (signal ${signal})` : ''} before responding`,
      ));
    });

    const initializeResult = await this.#request('initialize', {
      protocolVersion: this.protocolVersion,
      clientInfo: { name: 'agoragentic-pdf-mcp-adapter', version: '1.0.0' },
      capabilities: {},
    });
    this.#write({ jsonrpc: '2.0', method: 'notifications/initialized', params: {} });
    this.ready = true;
    return initializeResult;
  }

  async listTools() {
    await this.start();
    const result = await this.#request('tools/list', {});
    return Array.isArray(result?.tools) ? result.tools.map(normalizeToolDescriptor) : [];
  }

  async callTool(name, args) {
    await this.start();
    return this.#request('tools/call', { name, arguments: args });
  }

  async close() {
    if (!this.process) return;
    const proc = this.process;
    this.process = null;
    this.ready = false;
    this.#failPending(new Error('pdf-mcp client closed'));
    if (!proc.killed) proc.kill();
  }

  #request(method, params) {
    const id = ++this.requestId;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`Timed out waiting for ${method} after ${this.timeoutMs}ms`));
      }, this.timeoutMs);
      this.pending.set(id, {
        resolve: (value) => { clearTimeout(timer); resolve(value); },
        reject: (error) => { clearTimeout(timer); reject(error); },
      });
      this.#write({ jsonrpc: '2.0', id, method, params });
    });
  }

  #write(message) {
    if (!this.process?.stdin?.writable) {
      throw new Error('pdf-mcp server process is not running');
    }
    this.process.stdin.write(`${JSON.stringify(message)}\n`);
  }

  #onLine(line) {
    const text = line.trim();
    if (!text) return;
    let message;
    try {
      message = JSON.parse(text);
    } catch {
      return; // tolerate non-JSON banner/diagnostic lines on stdout
    }
    if (!Object.prototype.hasOwnProperty.call(message, 'id')) return; // notification
    const pending = this.pending.get(message.id);
    if (!pending) return;
    this.pending.delete(message.id);
    if (message.error) {
      pending.reject(new Error(message.error.message || `MCP error for request ${message.id}`));
    } else {
      pending.resolve(message.result);
    }
  }

  #failPending(error) {
    for (const [id, pending] of this.pending.entries()) {
      this.pending.delete(id);
      pending.reject(error);
    }
  }
}

// ---------------------------------------------------------------------------
// Tool selection
// ---------------------------------------------------------------------------

function scoreTool(tool, task = '', preferredToolName) {
  if (preferredToolName && tool.name === preferredToolName) return 1000;
  const text = `${tool.name} ${tool.description}`.toLowerCase();
  const taskText = String(task || '').toLowerCase();
  let score = 0;
  const addIf = (needle, points) => { if (text.includes(needle)) score += points; };
  addIf('pdf', 20);
  addIf('document', 8);
  addIf('extract', taskText.includes('extract') ? 20 : 8);
  addIf('text', taskText.includes('text') || taskText.includes('read') ? 18 : 6);
  addIf('read', taskText.includes('read') ? 18 : 5);
  addIf('parse', taskText.includes('parse') ? 18 : 5);
  addIf('ocr', taskText.includes('ocr') || taskText.includes('scan') ? 24 : 4);
  addIf('table', taskText.includes('table') ? 24 : 4);
  addIf('metadata', taskText.includes('metadata') ? 20 : 3);
  return score;
}

/**
 * Pick the pdf-capable tool from a discovered tool list.
 * Explicit `preferredToolName` wins when present in the list; otherwise tools
 * are ranked by name/description relevance. Returns null when nothing matches.
 */
export function selectPdfTool(tools, preferredToolName, task = 'extract pdf text') {
  const list = Array.isArray(tools) ? tools.map(normalizeToolDescriptor) : [];
  if (preferredToolName) {
    return list.find((tool) => tool.name === preferredToolName) || null;
  }
  const ranked = list
    .map((tool) => ({ tool, score: scoreTool(tool, task) }))
    .sort((a, b) => b.score - a.score);
  const top = ranked[0];
  if (!top) return null;
  const nameCompatible = COMPATIBLE_NAME_PATTERNS.some((re) => re.test(top.tool.name));
  if (top.score <= 0 && !nameCompatible) return null;
  return top.tool;
}

function buildToolArguments(tool, params) {
  if (params.toolArguments && typeof params.toolArguments === 'object' && !Array.isArray(params.toolArguments)) {
    return clone(params.toolArguments);
  }
  const properties = tool.inputSchema?.properties && typeof tool.inputSchema.properties === 'object'
    ? tool.inputSchema.properties
    : {};
  const args = {};
  const pathKeys = ['path', 'pdf_path', 'file_path', 'file', 'document_path', 'source_path'];
  const promptKeys = ['prompt', 'query', 'instructions', 'task'];

  const pathKey = pathKeys.find((key) => key in properties) || 'path';
  args[pathKey] = params.pdfPath;
  if (params.prompt) {
    const promptKey = promptKeys.find((key) => key in properties) || 'prompt';
    args[promptKey] = params.prompt;
  }
  return args;
}

// ---------------------------------------------------------------------------
// Result normalization
// ---------------------------------------------------------------------------

/**
 * Normalize an MCP tools/call result (structuredContent, content[] text blocks,
 * or a plain object) into `{ text, pages, metadata }`.
 */
export function normalizePdfResult(rawResult, context = {}) {
  const structured = rawResult?.structuredContent;
  if (structured && typeof structured === 'object') {
    return {
      text: typeof structured.text === 'string' ? structured.text : JSON.stringify(structured),
      pages: Number.isFinite(Number(structured.pages)) ? Number(structured.pages) : null,
      metadata: structured.metadata && typeof structured.metadata === 'object' ? structured.metadata : {},
    };
  }
  if (Array.isArray(rawResult?.content)) {
    const textParts = rawResult.content
      .filter((item) => item && item.type === 'text' && typeof item.text === 'string')
      .map((item) => item.text.trim())
      .filter(Boolean);
    const text = textParts.join('\n\n');
    // Some servers return JSON inside a single text block — surface it when so.
    try {
      const parsed = JSON.parse(text);
      if (parsed && typeof parsed === 'object') return normalizePdfResult({ structuredContent: parsed }, context);
    } catch { /* plain text */ }
    return { text, pages: context.pages ?? null, metadata: context.metadata ?? {} };
  }
  if (rawResult && typeof rawResult === 'object') {
    return {
      text: typeof rawResult.text === 'string' ? rawResult.text : JSON.stringify(rawResult),
      pages: Number.isFinite(Number(rawResult.pages)) ? Number(rawResult.pages) : null,
      metadata: rawResult.metadata && typeof rawResult.metadata === 'object' ? rawResult.metadata : {},
    };
  }
  return { text: String(rawResult ?? ''), pages: null, metadata: {} };
}

// ---------------------------------------------------------------------------
// High-level execute() wrapper (primary local entrypoint)
// ---------------------------------------------------------------------------

function failure(stage, message, extra = {}) {
  return {
    ok: false,
    error: message,
    stage,
    text: null,
    pages: null,
    metadata: {},
    selected_tool: extra.selected_tool ?? null,
    raw_result: null,
    receipt: {
      ok: false,
      adapter: 'pdf-mcp',
      transport: 'mcp-stdio',
      stage,
      message,
      selected_tool: extra.selected_tool ?? null,
      discovered_tools: extra.discovered_tools ?? [],
      ...extra.receipt,
    },
  };
}

/**
 * Run one PDF task through the pdf-mcp server and return a normalized result:
 * `{ ok, text, pages, metadata, selected_tool, raw_result, receipt }`.
 *
 * @param {{ pdfPath: string, prompt?: string, toolArguments?: object }} params
 * @param {{ command?, args?, env?, cwd?, timeoutMs?, toolName? }} options
 */
export async function executePdfMcp(params = {}, options = {}) {
  const pdfPath = params.pdfPath;
  if (!pdfPath || typeof pdfPath !== 'string') {
    return failure('input_validation', 'params.pdfPath is required');
  }
  if (!existsSync(pdfPath)) {
    return failure('input_validation', `pdfPath does not exist: ${pdfPath}`);
  }

  const client = new McpStdioClient(options);
  const requestId = stableId('req', [pdfPath, params.prompt, randomUUID()]);
  const startedMs = Date.now();
  let discoveredTools = [];

  try {
    let tools;
    try {
      tools = await client.listTools();
    } catch (error) {
      return failure('mcp_session', `failed to start or list tools: ${error.message}`, {
        receipt: { command: client.command, args: client.args, request_id: requestId, stderr: client.stderr.slice(-5) },
      });
    }
    discoveredTools = tools.map((tool) => tool.name);

    const preferred = options.toolName || process.env.PDF_MCP_TOOL_NAME || undefined;
    const selected = selectPdfTool(tools, preferred, params.prompt);
    if (!selected) {
      return failure(
        'tool_selection',
        preferred
          ? `requested tool "${preferred}" not exposed by server; discovered: ${discoveredTools.join(', ') || '(none)'}`
          : `no compatible PDF tool discovered; discovered: ${discoveredTools.join(', ') || '(none)'}`,
        { discovered_tools: discoveredTools, receipt: { command: client.command, args: client.args, request_id: requestId } },
      );
    }

    const toolArguments = buildToolArguments(selected, params);
    let rawResult;
    try {
      rawResult = await client.callTool(selected.name, toolArguments);
    } catch (error) {
      return failure('tool_call', `tools/call ${selected.name} failed: ${error.message}`, {
        selected_tool: selected.name,
        discovered_tools: discoveredTools,
        receipt: { command: client.command, args: client.args, request_id: requestId, stderr: client.stderr.slice(-5) },
      });
    }
    if (rawResult?.isError) {
      const normalizedError = normalizePdfResult(rawResult);
      return failure('tool_call', normalizedError.text || `tool ${selected.name} reported an error`, {
        selected_tool: selected.name,
        discovered_tools: discoveredTools,
        receipt: { command: client.command, args: client.args, request_id: requestId },
      });
    }

    const normalized = normalizePdfResult(rawResult);
    return {
      ok: true,
      ...normalized,
      selected_tool: selected.name,
      raw_result: rawResult,
      receipt: {
        ok: true,
        adapter: 'pdf-mcp',
        transport: 'mcp-stdio',
        command: client.command,
        args: client.args,
        request_id: requestId,
        selected_tool: selected.name,
        discovered_tools: discoveredTools,
        input_path: pdfPath,
        elapsed_ms: Date.now() - startedMs,
      },
    };
  } finally {
    await client.close();
  }
}

/** Factory matching this PR's plan doc: a bound adapter with execute()/match(). */
export function createPdfMcpAdapter(options = {}) {
  return new PdfMcpAgoragenticAdapter(options);
}

// ---------------------------------------------------------------------------
// Marketplace-style adapter surface (agoragentic_* tools, usage receipts)
// ---------------------------------------------------------------------------

function estimateCostUsdc(task, configuredCost) {
  const complexity = typeof task === 'string' ? Math.min(task.length / 5000, 0.01) : 0;
  return Number((configuredCost + complexity).toFixed(6));
}

export class PdfMcpAgoragenticAdapter {
  constructor(options = {}) {
    this.options = options;
    this.costUsdc = options.costUsdc ?? DEFAULT_COST_USDC;
    this.providerId = options.providerId || 'pdf-mcp';
    this.providerName = options.providerName || 'pdf-mcp';
  }

  /** Preview the server's tools ranked for a task, with cost estimates. */
  async match(task, constraints = {}) {
    const client = new McpStdioClient({ ...this.options, timeoutMs: constraints.timeout_ms || this.options.timeoutMs });
    try {
      const tools = await client.listTools();
      const preferred = typeof constraints.tool_name === 'string' ? constraints.tool_name : undefined;
      return tools
        .map((tool) => ({ tool, score: scoreTool(tool, task, preferred) }))
        .sort((a, b) => b.score - a.score)
        .map(({ tool, score }) => ({
          provider_id: this.providerId,
          provider_name: this.providerName,
          tool_name: tool.name,
          description: tool.description,
          match_score: score,
          estimated_cost_usdc: this.costUsdc,
        }));
    } finally {
      await client.close();
    }
  }

  /** Execute a PDF task and return an invocation record with a usage receipt. */
  async execute(task, input = {}, constraints = {}) {
    const startedAt = new Date();
    const estimatedCostUsdc = estimateCostUsdc(task, this.costUsdc);
    if (constraints.max_cost !== undefined && estimatedCostUsdc > Number(constraints.max_cost)) {
      throw new Error(`Estimated cost ${estimatedCostUsdc} exceeds max_cost ${constraints.max_cost}`);
    }

    const result = await executePdfMcp(
      { pdfPath: input.pdf_path || input.pdfPath, prompt: input.prompt || task, toolArguments: input.tool_arguments },
      { ...this.options, timeoutMs: constraints.timeout_ms || this.options.timeoutMs, toolName: constraints.tool_name },
    );

    const finishedAt = new Date();
    const invocationId = stableId('inv', [task, result.selected_tool, startedAt.toISOString(), randomUUID()]);
    return {
      invocation_id: invocationId,
      status: result.ok ? 'completed' : 'failed',
      provider_id: this.providerId,
      provider_name: this.providerName,
      tool_name: result.selected_tool,
      task,
      input: clone(input),
      output: result.ok ? { text: result.text, pages: result.pages, metadata: result.metadata } : null,
      error: result.ok ? undefined : result.error,
      receipt: {
        schema: 'agoragentic.usage-receipt.v1',
        receipt_id: stableId('rec', [invocationId, estimatedCostUsdc, finishedAt.toISOString()]),
        invocation_id: invocationId,
        provider_id: this.providerId,
        provider_name: this.providerName,
        tool_name: result.selected_tool,
        task,
        status: result.ok ? 'settled' : 'failed',
        created_at: startedAt.toISOString(),
        settled_at: finishedAt.toISOString(),
        cost_usdc: result.ok ? estimatedCostUsdc : 0,
        duration_ms: finishedAt.getTime() - startedAt.getTime(),
        mcp: result.receipt,
      },
    };
  }
}

/** Canonical Agoragentic tool surface (see AGENTS.md) bound to a local pdf-mcp server. */
export function createPdfMcpTools(options = {}) {
  const adapter = new PdfMcpAgoragenticAdapter(options);
  return {
    agoragentic_match: {
      description: 'Preview pdf-mcp tools available for a PDF task with match scores and estimated cost.',
      parameters: {
        type: 'object',
        properties: { task: { type: 'string' }, constraints: { type: 'object' } },
        required: ['task'],
      },
      execute: async ({ task, constraints = {} }) => adapter.match(task, constraints),
    },
    agoragentic_execute: {
      description: 'Run a PDF processing task through a local pdf-mcp server and return output plus a usage receipt.',
      parameters: {
        type: 'object',
        properties: { task: { type: 'string' }, input: { type: 'object' }, constraints: { type: 'object' } },
        required: ['task'],
      },
      execute: async ({ task, input = {}, constraints = {} }) => adapter.execute(task, input, constraints),
    },
  };
}

export default PdfMcpAgoragenticAdapter;

// ---------------------------------------------------------------------------
// CLI: inspect-tools | execute
// ---------------------------------------------------------------------------

async function cli(mode) {
  if (mode === 'inspect-tools') {
    const client = new McpStdioClient({});
    try {
      const tools = await client.listTools();
      console.log(JSON.stringify({ ok: true, tools }, null, 2));
    } finally {
      await client.close();
    }
    return;
  }
  if (mode === 'execute') {
    const pdfPath = process.env.PDF_INPUT_PATH;
    if (!pdfPath) {
      console.error('Set PDF_INPUT_PATH to the PDF file to process (optional PDF_PROMPT).');
      process.exitCode = 1;
      return;
    }
    const result = await executePdfMcp({ pdfPath, prompt: process.env.PDF_PROMPT });
    console.log(JSON.stringify(result, null, 2));
    if (!result.ok) process.exitCode = 1;
    return;
  }
  console.error('Usage: node pdf-mcp/agoragentic_pdf_mcp.mjs <inspect-tools|execute>');
  process.exitCode = 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await cli(process.argv[2]);
}
