#!/usr/bin/env node
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import readline from 'node:readline';
import { createHash, randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';

const DEFAULT_PROTOCOL_VERSION = '2024-11-05';
const DEFAULT_TIMEOUT_MS = 30_000;
const DEFAULT_PROVIDER_ID = 'm3-memory-local';
const DEFAULT_PROVIDER_NAME = 'm3-memory';
const DEFAULT_TOOL_PATTERNS = [/execute/i, /run/i, /memory/i];
const DEFAULT_USAGE_LOG_PATH = path.join(process.cwd(), '.m3-memory-usage.jsonl');

function nowIso() {
  return new Date().toISOString();
}

function stableId(prefix, values = []) {
  const hash = createHash('sha256');
  for (const value of values) {
    hash.update(typeof value === 'string' ? value : JSON.stringify(value));
    hash.update('\u001f');
  }
  return `${prefix}_${hash.digest('hex').slice(0, 24)}`;
}

function deepClone(value) {
  return value === undefined ? undefined : JSON.parse(JSON.stringify(value));
}

function requireTask(task) {
  const normalized = String(task || '').trim();
  if (!normalized) throw new Error('task is required');
  return normalized;
}

function toFiniteNumber(value, fallback) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function ensureDirForFile(filePath) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
}

function appendJsonl(filePath, value) {
  ensureDirForFile(filePath);
  fs.appendFileSync(filePath, `${JSON.stringify(value)}\n`, 'utf8');
}

function lastLines(filePath, maxLines = 10) {
  if (!fs.existsSync(filePath)) return [];
  const lines = fs.readFileSync(filePath, 'utf8').split(/\r?\n/).filter(Boolean);
  return lines.slice(-maxLines).map((line) => JSON.parse(line));
}

function summarizeContentText(content = []) {
  if (!Array.isArray(content)) return '';
  return content
    .filter((item) => item && item.type === 'text' && typeof item.text === 'string')
    .map((item) => item.text.trim())
    .filter(Boolean)
    .join('\n\n');
}

function normalizeTool(tool) {
  return {
    name: String(tool?.name || ''),
    description: typeof tool?.description === 'string' ? tool.description : '',
    inputSchema: tool?.inputSchema && typeof tool.inputSchema === 'object'
      ? tool.inputSchema
      : { type: 'object', properties: {} },
  };
}

function normalizeMcpResult(result) {
  if (result?.structuredContent && typeof result.structuredContent === 'object') {
    return {
      output: deepClone(result.structuredContent),
      summary: typeof result.structuredContent.summary === 'string'
        ? result.structuredContent.summary
        : JSON.stringify(result.structuredContent),
      content: Array.isArray(result.content) ? deepClone(result.content) : [],
    };
  }

  if (Array.isArray(result?.content)) {
    const text = summarizeContentText(result.content);
    try {
      const parsed = text ? JSON.parse(text) : null;
      if (parsed && typeof parsed === 'object') {
        return {
          output: parsed,
          summary: typeof parsed.summary === 'string' ? parsed.summary : text,
          content: deepClone(result.content),
        };
      }
    } catch {
      // Plain text content.
    }
    return {
      output: { text },
      summary: text,
      content: deepClone(result.content),
    };
  }

  if (result && typeof result === 'object') {
    return {
      output: deepClone(result),
      summary: typeof result.summary === 'string' ? result.summary : JSON.stringify(result),
      content: [],
    };
  }

  const text = String(result ?? '');
  return {
    output: { text },
    summary: text,
    content: text ? [{ type: 'text', text }] : [],
  };
}

function scoreTool(tool, task = '', preferredName = '') {
  if (preferredName && tool.name === preferredName) return 1000;
  const haystack = `${tool.name} ${tool.description}`.toLowerCase();
  const taskText = String(task || '').toLowerCase();
  let score = 0;
  if (/execute|run|invoke/.test(haystack)) score += 15;
  if (/memory/.test(haystack)) score += 10;
  if (/tool/.test(haystack)) score += 2;
  if (taskText.includes('memory') && /memory/.test(haystack)) score += 10;
  if (taskText.includes('search') && /search/.test(haystack)) score += 4;
  if (taskText.includes('store') && /store|write|save/.test(haystack)) score += 4;
  return score;
}

export function selectExecuteTool(tools, preferredName = '', task = '') {
  const normalized = Array.isArray(tools) ? tools.map(normalizeTool) : [];
  if (preferredName) {
    return normalized.find((tool) => tool.name === preferredName) || null;
  }
  const ranked = normalized
    .map((tool) => ({ tool, score: scoreTool(tool, task) }))
    .sort((a, b) => b.score - a.score);
  const winner = ranked[0]?.tool || null;
  if (!winner) return null;
  if (ranked[0].score > 0) return winner;
  return DEFAULT_TOOL_PATTERNS.some((pattern) => pattern.test(winner.name)) ? winner : null;
}

function buildToolArguments(tool, { task, input = {}, constraints = {} }) {
  const properties = tool?.inputSchema?.properties && typeof tool.inputSchema.properties === 'object'
    ? tool.inputSchema.properties
    : {};
  const hasDeclaredProperties = Object.keys(properties).length > 0;
  const allowsAdditionalProperties = tool?.inputSchema?.additionalProperties !== false;
  const args = {};
  const setIfSchemaHas = (preferredKeys, fallbackKey, value) => {
    if (value === undefined) return;
    const schemaKey = preferredKeys.find((candidate) => Object.prototype.hasOwnProperty.call(properties, candidate));
    if (schemaKey) {
      args[schemaKey] = value;
      return;
    }
    if (!hasDeclaredProperties || allowsAdditionalProperties) {
      args[fallbackKey] = value;
    }
  };

  setIfSchemaHas(['task', 'prompt', 'query', 'instruction'], 'task', task);
  setIfSchemaHas(['input', 'payload', 'arguments', 'data'], 'input', input);
  if (Object.keys(constraints).length) {
    setIfSchemaHas(['constraints', 'options', 'policy'], 'constraints', constraints);
  }

  for (const [key, value] of Object.entries(input)) {
    if (!(key in args) && key in properties) args[key] = value;
  }

  return args;
}

export class LineJsonRpcClient {
  constructor(options = {}) {
    this.command = options.command || 'node';
    this.args = Array.isArray(options.args) ? [...options.args] : [];
    this.cwd = options.cwd || process.cwd();
    this.env = { ...process.env, ...(options.env || {}) };
    this.timeoutMs = toFiniteNumber(options.timeoutMs, DEFAULT_TIMEOUT_MS);
    this.protocolVersion = options.protocolVersion || DEFAULT_PROTOCOL_VERSION;
    this.process = null;
    this.requestId = 0;
    this.pending = new Map();
    this.stderr = [];
    this.started = false;
    this.startPromise = null;
  }

  async start() {
    if (this.started && this.process) return;
    if (!this.startPromise) {
      this.startPromise = this.#startInternal().finally(() => {
        this.startPromise = null;
      });
    }
    await this.startPromise;
  }

  async #startInternal() {
    if (this.process) return;
    this.process = spawn(this.command, this.args, {
      cwd: this.cwd,
      env: this.env,
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
    });

    this.process.on('error', (error) => this.#rejectAll(error));
    this.process.on('exit', (code, signal) => {
      const error = new Error(`local m3-memory process exited${code !== null ? ` with code ${code}` : ''}${signal ? ` (signal ${signal})` : ''}`);
      this.started = false;
      this.process = null;
      this.#rejectAll(error);
    });

    this.process.stderr.on('data', (chunk) => {
      const text = chunk.toString('utf8').trim();
      if (text) this.stderr.push(text);
    });

    const rl = readline.createInterface({ input: this.process.stdout, crlfDelay: Infinity });
    rl.on('line', (line) => this.#onLine(line));

    await this.request('initialize', {
      protocolVersion: this.protocolVersion,
      clientInfo: { name: 'agoragentic-m3-memory-adapter', version: '1.0.0' },
      capabilities: {},
    });
    this.notify('notifications/initialized', {});
    this.started = true;
  }

  async listTools() {
    await this.start();
    const result = await this.request('tools/list', {});
    return Array.isArray(result?.tools) ? result.tools.map(normalizeTool) : [];
  }

  async callTool(name, args = {}) {
    await this.start();
    return this.request('tools/call', { name, arguments: args });
  }

  notify(method, params = {}) {
    this.#write({ jsonrpc: '2.0', method, params });
  }

  request(method, params = {}) {
    const id = ++this.requestId;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`Timed out waiting for ${method} after ${this.timeoutMs}ms`));
      }, this.timeoutMs);
      this.pending.set(id, {
        resolve: (value) => {
          clearTimeout(timer);
          resolve(value);
        },
        reject: (error) => {
          clearTimeout(timer);
          reject(error);
        },
      });
      this.#write({ jsonrpc: '2.0', id, method, params });
    });
  }

  async close() {
    this.started = false;
    if (!this.process) return;
    const proc = this.process;
    this.process = null;
    this.#rejectAll(new Error('client closed'));
    if (!proc.killed) proc.kill();
  }

  #write(message) {
    if (!this.process?.stdin?.writable) {
      throw new Error('local m3-memory process is not running');
    }
    this.process.stdin.write(`${JSON.stringify(message)}\n`);
  }

  #onLine(line) {
    const text = String(line || '').trim();
    if (!text) return;
    let message;
    try {
      message = JSON.parse(text);
    } catch {
      return;
    }
    if (!Object.prototype.hasOwnProperty.call(message, 'id')) return;
    const pending = this.pending.get(message.id);
    if (!pending) return;
    this.pending.delete(message.id);
    if (message.error) {
      pending.reject(new Error(message.error.message || `JSON-RPC error for ${message.id}`));
      return;
    }
    pending.resolve(message.result);
  }

  #rejectAll(error) {
    for (const [id, pending] of this.pending.entries()) {
      this.pending.delete(id);
      pending.reject(error);
    }
  }
}

export class UsageLogger {
  constructor(filePath = DEFAULT_USAGE_LOG_PATH) {
    this.filePath = filePath;
  }

  write(entry) {
    appendJsonl(this.filePath, entry);
    return this.filePath;
  }
}

function parseArgsEnv(value = '') {
  return String(value || '')
    .split(/\s+/)
    .map((part) => part.trim())
    .filter(Boolean);
}

function createDefaultClient(options = {}) {
  const command = options.command || process.env.M3_MEMORY_MCP_COMMAND;
  const args = Array.isArray(options.args)
    ? [...options.args]
    : parseArgsEnv(process.env.M3_MEMORY_MCP_ARGS);
  if (!command) {
    throw new Error(
      'M3MemoryExecuteAdapter requires an explicit client or command. ' +
      'Pass { client }, pass { command, args }, or set M3_MEMORY_MCP_COMMAND; ' +
      'the built-in mock server is only used by demo/selftest paths.'
    );
  }
  return new LineJsonRpcClient({
    command,
    args,
    cwd: options.cwd,
    env: options.env,
    timeoutMs: options.timeoutMs,
    protocolVersion: options.protocolVersion,
  });
}

function failureResult({
  providerId,
  providerName,
  invocationId,
  task,
  stage,
  error,
  startedAt,
  finishedAt,
  selectedTool = null,
  discoveredTools = [],
  requestId,
  usageLogPath,
  stderr = [],
}) {
  return {
    invocation_id: invocationId,
    status: 'failed',
    provider_id: providerId,
    provider_name: providerName,
    tool_name: selectedTool,
    task,
    output: null,
    error,
    receipt: {
      schema: 'agoragentic.usage-receipt.v1',
      receipt_id: stableId('rec', [invocationId, stage, error]),
      invocation_id: invocationId,
      provider_id: providerId,
      provider_name: providerName,
      tool_name: selectedTool,
      status: 'failed',
      stage,
      error,
      created_at: startedAt,
      settled_at: finishedAt,
      duration_ms: new Date(finishedAt).getTime() - new Date(startedAt).getTime(),
      usage_log_path: usageLogPath,
      mcp: {
        request_id: requestId,
        discovered_tools: discoveredTools,
        stderr: stderr.slice(-5),
      },
    },
  };
}

export class M3MemoryExecuteAdapter {
  constructor(options = {}) {
    this.providerId = options.providerId || DEFAULT_PROVIDER_ID;
    this.providerName = options.providerName || DEFAULT_PROVIDER_NAME;
    this.toolName = options.toolName || '';
    this.client = options.client || createDefaultClient(options);
    this.logger = options.logger || new UsageLogger(options.usageLogPath || DEFAULT_USAGE_LOG_PATH);
  }

  async match(task, constraints = {}) {
    const tools = await this.client.listTools();
    const preferredName = constraints.tool_name || this.toolName || '';
    return tools
      .map((tool) => ({ tool, score: scoreTool(tool, task, preferredName) }))
      .sort((a, b) => b.score - a.score)
      .map(({ tool, score }) => ({
        provider_id: this.providerId,
        provider_name: this.providerName,
        tool_name: tool.name,
        description: tool.description,
        match_score: score,
        local_only: true,
      }));
  }

  async execute(task, input = {}, constraints = {}) {
    const normalizedTask = requireTask(task);
    const startedAt = nowIso();
    const invocationId = stableId('inv', [normalizedTask, input, constraints, randomUUID()]);
    const requestId = stableId('req', [invocationId, startedAt]);
    let discoveredTools = [];
    let selectedTool = null;

    try {
      const tools = await this.client.listTools();
      discoveredTools = tools.map((tool) => tool.name);
      const preferredName = constraints.tool_name || this.toolName || '';
      const tool = selectExecuteTool(tools, preferredName, normalizedTask);
      if (!tool) {
        const result = failureResult({
          providerId: this.providerId,
          providerName: this.providerName,
          invocationId,
          task: normalizedTask,
          stage: 'tool_selection',
          error: preferredName
            ? `requested tool "${preferredName}" was not exposed by the local m3-memory runtime`
            : 'no compatible execute tool exposed by the local m3-memory runtime',
          startedAt,
          finishedAt: nowIso(),
          selectedTool: null,
          discoveredTools,
          requestId,
          usageLogPath: this.logger.filePath,
          stderr: this.client.stderr,
        });
        this.#logUsage(result, input, constraints);
        return result;
      }

      selectedTool = tool.name;
      const toolArguments = buildToolArguments(tool, {
        task: normalizedTask,
        input: deepClone(input),
        constraints: deepClone(constraints),
      });

      let rawResult;
      try {
        rawResult = await this.client.callTool(tool.name, toolArguments);
      } catch (error) {
        const result = failureResult({
          providerId: this.providerId,
          providerName: this.providerName,
          invocationId,
          task: normalizedTask,
          stage: 'tool_call',
          error: error.message,
          startedAt,
          finishedAt: nowIso(),
          selectedTool,
          discoveredTools,
          requestId,
          usageLogPath: this.logger.filePath,
          stderr: this.client.stderr,
        });
        this.#logUsage(result, input, constraints, toolArguments);
        return result;
      }

      if (rawResult?.isError) {
        const normalized = normalizeMcpResult(rawResult);
        const result = failureResult({
          providerId: this.providerId,
          providerName: this.providerName,
          invocationId,
          task: normalizedTask,
          stage: 'tool_execution',
          error: normalized.summary || `local tool ${tool.name} returned an error`,
          startedAt,
          finishedAt: nowIso(),
          selectedTool,
          discoveredTools,
          requestId,
          usageLogPath: this.logger.filePath,
          stderr: this.client.stderr,
        });
        this.#logUsage(result, input, constraints, toolArguments, rawResult);
        return result;
      }

      const normalized = normalizeMcpResult(rawResult);
      const finishedAt = nowIso();
      const output = {
        ...normalized.output,
        summary: normalized.summary,
      };
      const result = {
        invocation_id: invocationId,
        status: 'completed',
        provider_id: this.providerId,
        provider_name: this.providerName,
        tool_name: selectedTool,
        task: normalizedTask,
        output,
        error: null,
        receipt: {
          schema: 'agoragentic.usage-receipt.v1',
          receipt_id: stableId('rec', [invocationId, finishedAt, selectedTool]),
          invocation_id: invocationId,
          provider_id: this.providerId,
          provider_name: this.providerName,
          tool_name: selectedTool,
          status: 'completed',
          created_at: startedAt,
          settled_at: finishedAt,
          duration_ms: new Date(finishedAt).getTime() - new Date(startedAt).getTime(),
          usage_log_path: this.logger.filePath,
          mcp: {
            request_id: requestId,
            discovered_tools: discoveredTools,
            raw_content_count: Array.isArray(rawResult?.content) ? rawResult.content.length : 0,
          },
        },
      };
      this.#logUsage(result, input, constraints, toolArguments, rawResult);
      return result;
    } catch (error) {
      const result = failureResult({
        providerId: this.providerId,
        providerName: this.providerName,
        invocationId,
        task: normalizedTask,
        stage: 'adapter',
        error: error.message,
        startedAt,
        finishedAt: nowIso(),
        selectedTool,
        discoveredTools,
        requestId,
        usageLogPath: this.logger.filePath,
        stderr: this.client.stderr,
      });
      this.#logUsage(result, input, constraints);
      return result;
    }
  }

  async close() {
    await this.client.close();
  }

  #logUsage(result, input, constraints, toolArguments = {}, rawResult = null) {
    try {
      this.logger.write({
        schema: 'agoragentic.m3-memory-usage-log.v1',
        at: nowIso(),
        invocation_id: result.invocation_id,
        provider_id: result.provider_id,
        provider_name: result.provider_name,
        tool_name: result.tool_name,
        status: result.status,
        task: result.task,
        input_keys: input && typeof input === 'object' && !Array.isArray(input) ? Object.keys(input).sort() : [],
        constraint_keys: constraints && typeof constraints === 'object' && !Array.isArray(constraints) ? Object.keys(constraints).sort() : [],
        tool_argument_keys: toolArguments && typeof toolArguments === 'object' ? Object.keys(toolArguments).sort() : [],
        output_summary: result.output?.summary || null,
        error: result.error,
        receipt_id: result.receipt?.receipt_id || null,
        duration_ms: result.receipt?.duration_ms || null,
        raw_result_excerpt: rawResult ? JSON.stringify(rawResult).slice(0, 600) : null,
      });
      return true;
    } catch (error) {
      if (result?.receipt) {
        result.receipt.usage_log_error = error instanceof Error ? error.message : String(error);
      }
      return false;
    }
  }
}

export function createM3MemoryExecuteAdapter(options = {}) {
  return new M3MemoryExecuteAdapter(options);
}

async function startMockServer() {
  const tools = [
    {
      name: 'm3_memory.execute',
      description: 'Execute a local m3-memory task with bounded inputs.',
      inputSchema: {
        type: 'object',
        properties: {
          task: { type: 'string' },
          input: { type: 'object' },
          constraints: { type: 'object' },
        },
        required: ['task'],
      },
    },
  ];

  const rl = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
  for await (const line of rl) {
    const text = String(line || '').trim();
    if (!text) continue;
    let request;
    try {
      request = JSON.parse(text);
    } catch {
      continue;
    }

    if (request.method === 'initialize') {
      writeRpc({
        jsonrpc: '2.0',
        id: request.id,
        result: {
          protocolVersion: DEFAULT_PROTOCOL_VERSION,
          serverInfo: { name: 'mock-m3-memory', version: '0.1.0' },
          capabilities: { tools: {} },
        },
      });
      continue;
    }

    if (request.method === 'tools/list') {
      writeRpc({ jsonrpc: '2.0', id: request.id, result: { tools } });
      continue;
    }

    if (request.method === 'tools/call') {
      const name = request.params?.name;
      const args = request.params?.arguments || {};
      if (name !== 'm3_memory.execute') {
        writeRpc({
          jsonrpc: '2.0',
          id: request.id,
          result: {
            isError: true,
            content: [{ type: 'text', text: `unknown tool: ${name}` }],
          },
        });
        continue;
      }

      const task = String(args.task || '').trim();
      if (!task) {
        writeRpc({
          jsonrpc: '2.0',
          id: request.id,
          result: {
            isError: true,
            content: [{ type: 'text', text: 'task is required' }],
          },
        });
        continue;
      }

      if (/fail/i.test(task)) {
        writeRpc({
          jsonrpc: '2.0',
          id: request.id,
          result: {
            isError: true,
            content: [{ type: 'text', text: 'mock failure requested by task' }],
          },
        });
        continue;
      }

      const input = args.input && typeof args.input === 'object' ? args.input : {};
      const constraints = args.constraints && typeof args.constraints === 'object' ? args.constraints : {};
      writeRpc({
        jsonrpc: '2.0',
        id: request.id,
        result: {
          structuredContent: {
            summary: `m3-memory handled: ${task}`,
            echoed_input: input,
            constraints,
            usage: {
              bytes: Buffer.byteLength(JSON.stringify({ task, input, constraints })),
              local_only: true,
            },
          },
          content: [{ type: 'text', text: `executed ${task}` }],
        },
      });
    }
  }
}

function writeRpc(message) {
  process.stdout.write(`${JSON.stringify(message)}\n`);
}

async function runSelfTest() {
  const usageLogPath = path.join(os.tmpdir(), `m3-memory-usage-${randomUUID()}.jsonl`);
  const adapter = createM3MemoryExecuteAdapter({
    command: process.execPath,
    args: [fileURLToPath(import.meta.url), '--mock-server'],
    usageLogPath,
    timeoutMs: 5_000,
  });

  try {
    const matches = await adapter.match('store memory note');
    assert.equal(matches[0].tool_name, 'm3_memory.execute');

    const success = await adapter.execute('store memory note', {
      memory_id: 'demo-1',
      content: 'Remember the bounded operator fallback behavior.',
    }, {
      max_steps: 1,
    });
    assert.equal(success.status, 'completed');
    assert.equal(success.tool_name, 'm3_memory.execute');
    assert.match(success.output.summary, /m3-memory handled/);

    const failure = await adapter.execute('fail this task', { memory_id: 'demo-2' });
    assert.equal(failure.status, 'failed');
    assert.match(failure.error, /mock failure requested/);

    const strictTool = {
      name: 'm3_memory.execute',
      inputSchema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          memory_id: { type: 'string' },
          content: { type: 'string' },
        },
      },
    };
    assert.deepEqual(
      buildToolArguments(strictTool, {
        task: 'store memory note',
        input: { memory_id: 'strict-1', content: 'strict schema content' },
        constraints: { max_steps: 1 },
      }),
      { memory_id: 'strict-1', content: 'strict schema content' }
    );

    const loggingFailureAdapter = createM3MemoryExecuteAdapter({
      command: process.execPath,
      args: [fileURLToPath(import.meta.url), '--mock-server'],
      logger: { filePath: usageLogPath, write() { throw new Error('log sink unavailable'); } },
      timeoutMs: 5_000,
    });
    const completedWithoutLog = await loggingFailureAdapter.execute('store memory note');
    assert.equal(completedWithoutLog.status, 'completed');
    assert.match(completedWithoutLog.receipt.usage_log_error, /log sink unavailable/);
    await loggingFailureAdapter.close();

    const logEntries = lastLines(usageLogPath, 2);
    assert.equal(logEntries.length, 2);
    assert.equal(logEntries[0].status, 'completed');
    assert.equal(logEntries[1].status, 'failed');

    console.log(JSON.stringify({
      ok: true,
      usage_log_path: usageLogPath,
      completed_receipt_id: success.receipt.receipt_id,
      failed_receipt_id: failure.receipt.receipt_id,
      matched_tool: matches[0].tool_name,
    }, null, 2));
  } finally {
    await adapter.close();
  }
}

function parseCli(argv = process.argv.slice(2)) {
  const options = {
    mode: 'demo',
    task: 'store memory note',
    input: { memory_id: 'demo', content: 'Local execute wrapper demo' },
    constraints: { max_steps: 1 },
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--mock-server') {
      options.mode = 'mock-server';
    } else if (arg === 'selftest') {
      options.mode = 'selftest';
    } else if (arg === 'demo') {
      options.mode = 'demo';
    } else if (arg === '--task' && argv[i + 1]) {
      options.task = argv[++i];
    } else if (arg === '--input-json' && argv[i + 1]) {
      options.input = JSON.parse(argv[++i]);
    } else if (arg === '--constraints-json' && argv[i + 1]) {
      options.constraints = JSON.parse(argv[++i]);
    }
  }

  return options;
}

async function runDemo() {
  const options = parseCli();
  const usageLogPath = path.join(process.cwd(), '.m3-memory-demo-usage.jsonl');
  const adapter = createM3MemoryExecuteAdapter({
    command: process.execPath,
    args: [fileURLToPath(import.meta.url), '--mock-server'],
    usageLogPath,
    timeoutMs: 5_000,
  });

  try {
    const result = await adapter.execute(options.task, options.input, options.constraints);
    console.log(JSON.stringify(result, null, 2));
  } finally {
    await adapter.close();
  }
}

const isMain = process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1]);

if (isMain) {
  const options = parseCli();
  if (options.mode === 'mock-server') {
    startMockServer().catch((error) => {
      console.error(error.message || error);
      process.exit(1);
    });
  } else if (options.mode === 'selftest') {
    runSelfTest().catch((error) => {
      console.error(error.stack || error.message || error);
      process.exit(1);
    });
  } else {
    runDemo().catch((error) => {
      console.error(error.stack || error.message || error);
      process.exit(1);
    });
  }
}
