#!/usr/bin/env node
import assert from "node:assert/strict";
import process from "node:process";
import readline from "node:readline";
import { setTimeout as sleep } from "node:timers/promises";
import { pathToFileURL } from "node:url";

const DEFAULT_TOOL_NAME = "execute";
const DEFAULT_SERVER_NAME = "micro-mu-local-adapter";
const DEFAULT_MAX_ATTEMPTS = 3;
const ADVERTISED_MAX_ATTEMPTS = 10;
const DEFAULT_BASE_BACKOFF_MS = 25;
const DEFAULT_TIMEOUT_MS = 10_000;
const ADVERTISED_MAX_TIMEOUT_MS = 120_000;
const METRIC_SCHEMA = "agoragentic:usage-metrics:v1";

function nowIso() {
  return new Date().toISOString();
}

function cloneJson(value) {
  return value === undefined ? undefined : JSON.parse(JSON.stringify(value));
}

function stableStringify(value) {
  if (Array.isArray(value)) {
    return `[${value.map((item) => stableStringify(item)).join(",")}]`;
  }
  if (value && typeof value === "object") {
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

function summarizeError(error) {
  if (error instanceof Error) {
    return {
      name: error.name,
      message: error.message,
      transient: Boolean(error.transient),
      retryable: Boolean(error.retryable ?? error.transient),
    };
  }
  return {
    name: "Error",
    message: String(error),
    transient: false,
    retryable: false,
  };
}

function createMcpError(code, message, data) {
  return { code, message, data };
}

function methodNotFoundResponse(id, method) {
  return {
    jsonrpc: "2.0",
    id,
    error: createMcpError(-32601, `Method not found: ${method}`),
  };
}

function isSingleJsonRpcMessage(message) {
  return Boolean(message) && typeof message === "object" && !Array.isArray(message);
}

async function runWithAbortableTimeout(work, timeoutMs) {
  const controller = new AbortController();
  let timer;
  try {
    return await Promise.race([
      Promise.resolve(work(controller.signal)),
      new Promise((_, reject) => {
        timer = setTimeout(() => {
          controller.abort(new Error(`execution timed out after ${timeoutMs}ms`));
          reject(new TransientExecuteError(`execution timed out after ${timeoutMs}ms`));
        }, timeoutMs);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

class TransientExecuteError extends Error {
  constructor(message, details = {}) {
    super(message);
    this.name = "TransientExecuteError";
    this.transient = true;
    this.retryable = true;
    this.details = details;
  }
}

class PermanentExecuteError extends Error {
  constructor(message, details = {}) {
    super(message);
    this.name = "PermanentExecuteError";
    this.transient = false;
    this.retryable = false;
    this.details = details;
  }
}

class UsageMetricsLogger {
  constructor(options = {}) {
    this.serverName = options.serverName || DEFAULT_SERVER_NAME;
    this.records = [];
    this.counters = {
      total_calls: 0,
      succeeded_calls: 0,
      failed_calls: 0,
      retried_calls: 0,
      recovered_calls: 0,
    };
    this.sink = typeof options.sink === "function" ? options.sink : () => {};
  }

  log(record) {
    const entry = {
      schema: METRIC_SCHEMA,
      recorded_at: nowIso(),
      server_name: this.serverName,
      ...cloneJson(record),
    };
    this.records.push(entry);
    this.counters.total_calls += 1;
    if (entry.status === "ok") {
      this.counters.succeeded_calls += 1;
    } else {
      this.counters.failed_calls += 1;
    }
    if ((entry.attempt_count || 1) > 1) {
      this.counters.retried_calls += 1;
    }
    if (entry.recovered_after_retry) {
      this.counters.recovered_calls += 1;
    }
    try {
      this.sink(entry);
    } catch (error) {
      entry.sink_error = summarizeError(error);
    }
    return entry;
  }

  snapshot() {
    const latencies = this.records.map((record) => Number(record.duration_ms) || 0).filter((value) => value >= 0);
    const totalLatency = latencies.reduce((sum, value) => sum + value, 0);
    return {
      schema: METRIC_SCHEMA,
      server_name: this.serverName,
      counters: cloneJson(this.counters),
      total_records: this.records.length,
      average_duration_ms: latencies.length ? Number((totalLatency / latencies.length).toFixed(2)) : 0,
      last_record: this.records.length ? cloneJson(this.records[this.records.length - 1]) : null,
    };
  }
}

export class MicroMuLocalAdapter {
  constructor(options = {}) {
    if (typeof options.execute !== "function") {
      throw new Error("MicroMuLocalAdapter requires an execute function");
    }
    this.serverName = options.serverName || DEFAULT_SERVER_NAME;
    this.toolName = options.toolName || DEFAULT_TOOL_NAME;
    this.description =
      options.description ||
      "Execute a bounded micro/mu task through a local adapter with retry recovery and usage metrics.";
    this.executeImpl = options.execute;
    this.maxAttempts = normalizeBoundedPositiveInt(options.maxAttempts, DEFAULT_MAX_ATTEMPTS, ADVERTISED_MAX_ATTEMPTS, "maxAttempts");
    this.baseBackoffMs = normalizePositiveInt(options.baseBackoffMs, DEFAULT_BASE_BACKOFF_MS);
    this.defaultTimeoutMs = normalizeBoundedPositiveInt(options.timeoutMs, DEFAULT_TIMEOUT_MS, ADVERTISED_MAX_TIMEOUT_MS, "timeoutMs");
    this.metrics = options.metrics || new UsageMetricsLogger({
      serverName: this.serverName,
      sink: options.metricsSink,
    });
  }

  manifest() {
    return {
      server: this.serverName,
      tool: {
        name: this.toolName,
        description: this.description,
        inputSchema: {
          type: "object",
          additionalProperties: false,
          required: ["task"],
          properties: {
            task: { type: "string", minLength: 1 },
            input: { type: "object", additionalProperties: true },
            constraints: {
              type: "object",
              additionalProperties: true,
              properties: {
                max_attempts: { type: "integer", minimum: 1, maximum: 10 },
                timeout_ms: { type: "integer", minimum: 1, maximum: 120000 },
              },
            },
          },
        },
      },
    };
  }

  listTools() {
    const { tool } = this.manifest();
    return [cloneJson(tool)];
  }

  metricsSnapshot() {
    return this.metrics.snapshot();
  }

  async execute(request = {}) {
    const normalized = this.#normalizeRequest(request);
    const startedAt = Date.now();
    const timeline = [];
    let lastError = null;

    for (let attempt = 1; attempt <= normalized.maxAttempts; attempt += 1) {
      const attemptStarted = Date.now();
      timeline.push({ at: nowIso(), phase: "attempt_started", attempt });
      try {
        const result = await this.#executeWithTimeout(normalized, attempt);
        const durationMs = Date.now() - startedAt;
        timeline.push({
          at: nowIso(),
          phase: "attempt_succeeded",
          attempt,
          duration_ms: Date.now() - attemptStarted,
        });
        const response = {
          ok: true,
          server: this.serverName,
          tool: this.toolName,
          task: normalized.task,
          output: result,
          usage_metrics: this.metrics.log({
            task: normalized.task,
            status: "ok",
            attempt_count: attempt,
            recovered_after_retry: attempt > 1,
            duration_ms: durationMs,
            input_fingerprint: stableStringify({ task: normalized.task, input: normalized.input }).length,
          }),
          recovery: {
            recovered: attempt > 1,
            attempts: attempt,
            max_attempts: normalized.maxAttempts,
            last_error: lastError ? summarizeError(lastError) : null,
          },
          timeline,
        };
        return response;
      } catch (error) {
        lastError = error;
        const summary = summarizeError(error);
        timeline.push({
          at: nowIso(),
          phase: "attempt_failed",
          attempt,
          error: summary,
        });
        const shouldRetry = attempt < normalized.maxAttempts && summary.retryable;
        if (!shouldRetry) {
          const durationMs = Date.now() - startedAt;
          const finalError = {
            ok: false,
            server: this.serverName,
            tool: this.toolName,
            task: normalized.task,
            error: summary,
            usage_metrics: this.metrics.log({
              task: normalized.task,
              status: "error",
              attempt_count: attempt,
              recovered_after_retry: false,
              duration_ms: durationMs,
              input_fingerprint: stableStringify({ task: normalized.task, input: normalized.input }).length,
            }),
            recovery: {
              recovered: false,
              attempts: attempt,
              max_attempts: normalized.maxAttempts,
              last_error: summary,
            },
            timeline,
          };
          throw new PermanentExecuteError(summary.message, finalError);
        }
        const backoffMs = this.baseBackoffMs * attempt;
        timeline.push({ at: nowIso(), phase: "retry_scheduled", attempt, backoff_ms: backoffMs });
        await sleep(backoffMs);
      }
    }

    throw new PermanentExecuteError("unreachable execute loop state");
  }

  async callTool(name, args = {}) {
    if (name !== this.toolName) {
      throw new PermanentExecuteError(`unknown tool: ${name}`);
    }
    let result;
    let isError = false;
    try {
      result = await this.execute(args);
    } catch (error) {
      const details = error instanceof Error && error.details
        ? cloneJson(error.details)
        : { ok: false, error: summarizeError(error) };
      result = details;
      isError = true;
    }
    return {
      content: [
        {
          type: "text",
          text: JSON.stringify(
            {
              ok: result.ok,
              task: result.task,
              output: result.output,
              error: result.error,
              recovery: result.recovery,
            },
            null,
            2,
          ),
        },
      ],
      structuredContent: result,
      isError,
    };
  }

  async handleRpc(message) {
    if (Array.isArray(message)) {
      return this.#handleRpcBatch(message);
    }
    if (!isSingleJsonRpcMessage(message)) {
      return { jsonrpc: "2.0", id: null, error: createMcpError(-32600, "Invalid Request") };
    }

    const hasId = Object.prototype.hasOwnProperty.call(message, "id");
    const { id = null, method, params = {} } = message;
    if (!hasId) {
      return null;
    }
    try {
      if (method === "initialize") {
        return {
          jsonrpc: "2.0",
          id,
          result: {
            protocolVersion: "2025-03-26",
            serverInfo: { name: this.serverName, version: "0.1.0" },
            capabilities: { tools: {} },
          },
        };
      }
      if (method === "tools/list") {
        return {
          jsonrpc: "2.0",
          id,
          result: { tools: this.listTools() },
        };
      }
      if (method === "tools/call") {
        return this.#handleToolCall(id, params);
      }
      if (method === "metrics/get") {
        return {
          jsonrpc: "2.0",
          id,
          result: this.metricsSnapshot(),
        };
      }
      return methodNotFoundResponse(id, method);
    } catch (error) {
      return {
        jsonrpc: "2.0",
        id,
        error: createMcpError(
          -32000,
          error instanceof Error ? error.message : String(error),
          error instanceof Error && error.details ? cloneJson(error.details) : undefined,
        ),
      };
    }
  }

  async serveStdio({ input = process.stdin, output = process.stdout } = {}) {
    const rl = readline.createInterface({ input, crlfDelay: Infinity });
    for await (const line of rl) {
      if (!line.trim()) continue;
      let message;
      try {
        message = JSON.parse(line);
      } catch {
        output.write(`${JSON.stringify({ jsonrpc: "2.0", id: null, error: createMcpError(-32700, "Parse error") })}\n`);
        continue;
      }
      const response = await this.handleRpc(message);
      if (Array.isArray(response)) {
        output.write(`${JSON.stringify(response)}\n`);
      } else if (response) {
        output.write(`${JSON.stringify(response)}\n`);
      }
    }
  }

  async #handleRpcBatch(messages) {
    const responses = [];
    for (const item of messages) {
      const response = await this.handleRpc(item);
      if (response) responses.push(response);
    }
    return responses;
  }

  async #handleToolCall(id, params = {}) {
    const result = await this.callTool(params.name, params.arguments || {});
    return {
      jsonrpc: "2.0",
      id,
      result,
    };
  }

  #normalizeRequest(request) {
    if (!request || typeof request !== "object" || Array.isArray(request)) {
      throw new PermanentExecuteError("execute() requires an object payload");
    }
    const task = typeof request.task === "string" ? request.task.trim() : "";
    if (!task) {
      throw new PermanentExecuteError("task must be a non-empty string");
    }
    const input = request.input === undefined ? {} : request.input;
    if (!input || typeof input !== "object" || Array.isArray(input)) {
      throw new PermanentExecuteError("input must be an object when provided");
    }
    const constraints = request.constraints === undefined ? {} : request.constraints;
    if (!constraints || typeof constraints !== "object" || Array.isArray(constraints)) {
      throw new PermanentExecuteError("constraints must be an object when provided");
    }
    const maxAttempts = normalizeBoundedPositiveInt(constraints.max_attempts, this.maxAttempts, ADVERTISED_MAX_ATTEMPTS, "constraints.max_attempts");
    const timeoutMs = normalizeBoundedPositiveInt(constraints.timeout_ms, this.defaultTimeoutMs, ADVERTISED_MAX_TIMEOUT_MS, "constraints.timeout_ms");
    return {
      task,
      input: cloneJson(input),
      constraints: cloneJson(constraints),
      maxAttempts,
      timeoutMs,
    };
  }

  async #executeWithTimeout(normalized, attempt) {
    return runWithAbortableTimeout((signal) => this.executeImpl({
      task: normalized.task,
      input: cloneJson(normalized.input),
      constraints: cloneJson(normalized.constraints),
      attempt,
      signal,
    }), normalized.timeoutMs);
  }
}

function normalizePositiveInt(value, fallback) {
  if (value === undefined || value === null || value === "") {
    return fallback;
  }
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1) {
    throw new PermanentExecuteError(`expected positive integer, received ${value}`);
  }
  return parsed;
}

function normalizeBoundedPositiveInt(value, fallback, max, label) {
  const parsed = normalizePositiveInt(value, fallback);
  if (parsed > max) {
    throw new PermanentExecuteError(`${label} must be <= ${max}`);
  }
  return parsed;
}

export function createDemoMicroMuRuntime() {
  const seen = new Set();
  return async function execute({ task, input, attempt, signal }) {
    if (task === "always_fail") {
      throw new PermanentExecuteError("demo runtime rejected always_fail");
    }
    if (input.mode === "flaky-once") {
      const key = `${task}:${stableStringify(input)}`;
      if (!seen.has(key)) {
        seen.add(key);
        throw new TransientExecuteError("demo runtime lost its first attempt; retry should recover");
      }
    }
    if (input.mode === "slow") {
      await sleep(Number(input.delay_ms) || 50, undefined, { signal });
    }
    return {
      runtime: "micro/mu-demo",
      task,
      attempt,
      echoed_input: cloneJson(input),
      summary: `micro/mu completed ${task}`,
    };
  };
}

async function runSelfTest() {
  const metricEvents = [];
  const adapter = new MicroMuLocalAdapter({
    execute: createDemoMicroMuRuntime(),
    metricsSink: (record) => metricEvents.push(record),
  });

  const recovered = await adapter.execute({
    task: "draft_agent_reply",
    input: { mode: "flaky-once", topic: "micro/mu onboarding" },
    constraints: { max_attempts: 3, timeout_ms: 200 },
  });
  assert.equal(recovered.ok, true);
  assert.equal(recovered.recovery.recovered, true);
  assert.equal(recovered.recovery.attempts, 2);
  assert.equal(recovered.output.runtime, "micro/mu-demo");

  let failed = null;
  try {
    await adapter.execute({ task: "always_fail", input: {} });
  } catch (error) {
    failed = error;
  }
  assert.ok(failed instanceof PermanentExecuteError);
  assert.match(failed.message, /always_fail/);

  const snapshot = adapter.metricsSnapshot();
  assert.equal(snapshot.counters.total_calls, 2);
  assert.equal(snapshot.counters.succeeded_calls, 1);
  assert.equal(snapshot.counters.failed_calls, 1);
  assert.equal(snapshot.counters.retried_calls, 1);
  assert.equal(snapshot.counters.recovered_calls, 1);
  assert.equal(metricEvents.length, 2);

  const toolFailure = await adapter.callTool("execute", { task: "always_fail", input: {} });
  assert.equal(toolFailure.isError, true);
  assert.equal(toolFailure.structuredContent.ok, false);

  await assert.rejects(
    () => adapter.execute({ task: "too_many", input: {}, constraints: { max_attempts: 11 } }),
    /constraints\.max_attempts must be <= 10/,
  );
  await assert.rejects(
    () => adapter.execute({ task: "too_long", input: {}, constraints: { timeout_ms: 120001 } }),
    /constraints\.timeout_ms must be <= 120000/,
  );

  const noisyMetricsAdapter = new MicroMuLocalAdapter({
    execute: createDemoMicroMuRuntime(),
    metricsSink: () => {
      throw new Error("metrics offline");
    },
  });
  const noisyResult = await noisyMetricsAdapter.execute({ task: "metrics_best_effort", input: {} });
  assert.equal(noisyResult.ok, true);
  assert.equal(noisyResult.usage_metrics.sink_error.message, "metrics offline");

  const rpcAdapter = new MicroMuLocalAdapter({ execute: createDemoMicroMuRuntime() });
  const batchResponse = await rpcAdapter.handleRpc([
    { jsonrpc: "2.0", id: 1, method: "initialize", params: {} },
    { jsonrpc: "2.0", method: "notifications/cancelled", params: {} },
    { jsonrpc: "2.0", id: 2, method: "tools/list", params: {} },
  ]);
  assert.equal(batchResponse.length, 2);
  assert.equal(batchResponse[0].id, 1);
  assert.equal(batchResponse[1].id, 2);

  return {
    demo: "micro/mu local MCP adapter",
    recovered_execution: {
      task: recovered.task,
      attempts: recovered.recovery.attempts,
      summary: recovered.output.summary,
    },
    metrics: snapshot,
  };
}

async function main(argv = process.argv.slice(2)) {
  const adapter = new MicroMuLocalAdapter({
    execute: createDemoMicroMuRuntime(),
    metricsSink: (record) => process.stderr.write(`[metrics] ${JSON.stringify(record)}\n`),
  });

  if (argv.includes("--stdio")) {
    await adapter.serveStdio();
    return;
  }

  if (argv.includes("--self-test") || argv.length === 0) {
    const result = await runSelfTest();
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    return;
  }

  if (argv[0] === "execute") {
    const payload = argv[1] ? JSON.parse(argv[1]) : {};
    const result = await adapter.execute(payload);
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    return;
  }

  process.stderr.write("usage: micro_mu_local_mcp_execute_adapter.mjs [--self-test|--stdio|execute '<json>']\n");
  process.exitCode = 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    const details = error instanceof Error && error.details ? `\n${JSON.stringify(error.details, null, 2)}` : "";
    process.stderr.write(`${error instanceof Error ? error.stack || error.message : String(error)}${details}\n`);
    process.exitCode = 1;
  });
}
