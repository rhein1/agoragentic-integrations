// demo uses simulated receipts in __main__; moves no real funds.

import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";

const DEFAULT_BASE_URL = process.env.AGORAGENTIC_BASE_URL || "https://agoragentic.com";

function nowIso() {
  return new Date().toISOString();
}

function sha256Json(value) {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

function safeJsonParse(text) {
  try {
    return JSON.parse(text);
  } catch {
    return { raw_text: text };
  }
}

function normalizeObject(value, fallback = {}) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : fallback;
}

function normalizeReceipt(rawReceipt, invocationId) {
  const receipt = normalizeObject(rawReceipt, {});
  return {
    receipt_id: receipt.receipt_id || receipt.id || null,
    invocation_id:
      receipt.invocation_id ||
      receipt.invocationId ||
      invocationId ||
      null,
    status: receipt.status || receipt.state || null,
    cost_usdc:
      receipt.cost_usdc ??
      receipt.amount_usdc ??
      receipt.price_usdc ??
      null,
    provider_id: receipt.provider_id || receipt.providerId || null,
    provider_name: receipt.provider_name || receipt.providerName || null,
    settled_at:
      receipt.settled_at ||
      receipt.completed_at ||
      receipt.created_at ||
      null,
    metadata: normalizeObject(receipt.metadata, {}),
    raw: receipt,
  };
}

function extractInvocationId(result) {
  const object = normalizeObject(result, {});
  return (
    object.invocation_id ||
    object.invocationId ||
    object.run_id ||
    object.runId ||
    object.id ||
    null
  );
}

function extractReceipt(result) {
  const object = normalizeObject(result, {});
  return (
    object.receipt ||
    object.usage_receipt ||
    object.execution_receipt ||
    object.settlement ||
    object.billing ||
    null
  );
}

function summarizeReceipt(receipt) {
  if (!receipt) {
    return { present: false };
  }
  return {
    present: true,
    receipt_id: receipt.receipt_id,
    invocation_id: receipt.invocation_id,
    status: receipt.status,
    cost_usdc: receipt.cost_usdc,
    provider_id: receipt.provider_id,
    provider_name: receipt.provider_name,
    settled_at: receipt.settled_at,
  };
}

function defaultLogger(entry) {
  console.error(JSON.stringify({ ts: nowIso(), ...entry }));
}

async function fetchJson(url, { method = "GET", headers = {}, body, fetchImpl = globalThis.fetch, timeoutMs = 90_000 } = {}) {
  if (typeof fetchImpl !== "function") {
    throw new Error("fetch is unavailable; pass fetchImpl or use a local executeImpl");
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new Error(`Request timed out after ${timeoutMs}ms`)), timeoutMs);

  try {
    const response = await fetchImpl(url, {
      method,
      headers,
      body,
      signal: controller.signal,
    });
    const text = await response.text();
    const data = safeJsonParse(text);
    return { response, data, text };
  } finally {
    clearTimeout(timer);
  }
}

async function remoteExecute({
  baseUrl,
  apiKey,
  task,
  input,
  constraints,
  metadata,
  fetchImpl,
  timeoutMs,
}) {
  const payload = {
    task,
    input,
    constraints,
    metadata,
  };

  const headers = {
    "content-type": "application/json",
    "x-idempotency-key": metadata.idempotency_key,
  };

  if (apiKey) {
    headers.authorization = `Bearer ${apiKey}`;
  }

  const { response, data, text } = await fetchJson(`${baseUrl}/api/execute`, {
    method: "POST",
    headers,
    body: JSON.stringify(payload),
    fetchImpl,
    timeoutMs,
  });

  if (!response.ok) {
    const error = new Error(`execute() failed with HTTP ${response.status}`);
    error.status = response.status;
    error.body = data;
    error.raw_text = text;
    throw error;
  }

  return data;
}

async function fetchReceiptByInvocationId({
  baseUrl,
  apiKey,
  invocationId,
  fetchImpl,
  timeoutMs = 30_000,
}) {
  if (!invocationId) {
    return null;
  }

  const headers = {};
  if (apiKey) {
    headers.authorization = `Bearer ${apiKey}`;
  }

  const { response, data } = await fetchJson(
    `${baseUrl}/api/execute/receipt/${encodeURIComponent(invocationId)}`,
    {
      method: "GET",
      headers,
      fetchImpl,
      timeoutMs,
    },
  );

  if (!response.ok) {
    return null;
  }

  return data;
}

export async function defaultReceiptHandler({
  result,
  baseUrl,
  apiKey,
  fetchImpl,
  logger = defaultLogger,
}) {
  const invocationId = extractInvocationId(result);
  let receipt = extractReceipt(result);

  if (!receipt && invocationId) {
    logger({
      event: "receipt_fetch_attempt",
      invocation_id: invocationId,
    });
    receipt = await fetchReceiptByInvocationId({
      baseUrl,
      apiKey,
      invocationId,
      fetchImpl,
    });
  }

  return {
    invocation_id: invocationId,
    receipt: receipt ? normalizeReceipt(receipt, invocationId) : null,
  };
}

export function createGovernedExecuteTool(options = {}) {
  const {
    name = "agoragentic_execute_governed",
    description = "Wrap execute() with receipt capture and audit-friendly metadata logging.",
    baseUrl = DEFAULT_BASE_URL,
    apiKey = process.env.AGORAGENTIC_API_KEY || "",
    executeImpl,
    fetchImpl = globalThis.fetch,
    receiptHandler = defaultReceiptHandler,
    logger = defaultLogger,
    timeoutMs = 90_000,
    dryRun = !executeImpl && !apiKey,
  } = options;

  const executeWithFallback =
    executeImpl ||
    (dryRun
      ? async ({ task, input, constraints, metadata }) => ({
          invocation_id: `demo_${metadata.audit_id}`,
          status: "completed",
          output: {
            echoed_task: task,
            echoed_input: input,
            echoed_constraints: constraints,
          },
          receipt: {
            receipt_id: `demo_receipt_${metadata.audit_id}`,
            invocation_id: `demo_${metadata.audit_id}`,
            status: "simulated",
            cost_usdc: 0,
            provider_name: "local-demo",
            settled_at: nowIso(),
            metadata: {
              dry_run: true,
              source: metadata.source,
              request_fingerprint: metadata.request_fingerprint,
            },
          },
        })
      : async ({ task, input, constraints, metadata }) =>
          remoteExecute({
            baseUrl,
            apiKey,
            task,
            input,
            constraints,
            metadata,
            fetchImpl,
            timeoutMs,
          }));

  const parameters = {
    type: "object",
    additionalProperties: false,
    properties: {
      task: {
        type: "string",
        description: "Task or intent to route through execute().",
      },
      input: {
        type: "object",
        description: "Structured tool input passed to execute().",
        additionalProperties: true,
      },
      constraints: {
        type: "object",
        description: "Optional execution constraints such as budget or policy hints.",
        additionalProperties: true,
      },
      source: {
        type: "string",
        description: "Caller label for audit trails.",
      },
      tags: {
        type: "array",
        items: { type: "string" },
        description: "Optional audit tags.",
      },
      audit_id: {
        type: "string",
        description: "Optional caller-supplied audit ID.",
      },
      idempotency_key: {
        type: "string",
        description: "Optional idempotency key. Defaults to audit_id.",
      },
      context: {
        type: "object",
        additionalProperties: true,
        description: "Optional local wrapper context for custom executeImpl implementations.",
      },
    },
    required: ["task"],
  };

  async function execute(args = {}) {
    const task = typeof args.task === "string" ? args.task.trim() : "";
    if (!task) {
      throw new Error("task is required");
    }

    const input = normalizeObject(args.input, {});
    const constraints = normalizeObject(args.constraints, {});
    const context = normalizeObject(args.context, {});
    const auditId = args.audit_id || randomUUID();
    const idempotencyKey = args.idempotency_key || auditId;
    const started = Date.now();

    const metadata = {
      audit_id: auditId,
      idempotency_key: idempotencyKey,
      source: args.source || "openai-agents-sdk",
      tags: Array.isArray(args.tags) ? args.tags : [],
      request_fingerprint: sha256Json({ task, input, constraints }),
    };

    logger({
      event: "execute_start",
      tool: name,
      audit_id: auditId,
      source: metadata.source,
      tags: metadata.tags,
      request_fingerprint: metadata.request_fingerprint,
      dry_run: Boolean(dryRun),
    });

    let result;
    try {
      result = await executeWithFallback({
        task,
        input,
        constraints,
        context,
        metadata,
      });
    } catch (error) {
      logger({
        event: "execute_error",
        tool: name,
        audit_id: auditId,
        elapsed_ms: Date.now() - started,
        error_message: error?.message || String(error),
        http_status: error?.status || null,
      });
      throw error;
    }

    const handledReceipt = await receiptHandler({
      result,
      task,
      input,
      constraints,
      context,
      metadata,
      baseUrl,
      apiKey,
      fetchImpl,
      logger,
    });

    const normalizedReceipt = handledReceipt?.receipt || null;
    const invocationId =
      handledReceipt?.invocation_id || extractInvocationId(result) || null;

    logger({
      event: "execute_complete",
      tool: name,
      audit_id: auditId,
      invocation_id: invocationId,
      elapsed_ms: Date.now() - started,
      receipt: summarizeReceipt(normalizedReceipt),
    });

    return JSON.stringify(
      {
        ok: true,
        audit_id: auditId,
        invocation_id: invocationId,
        output: normalizeObject(result, result),
        receipt: normalizedReceipt,
      },
      null,
      2,
    );
  }

  async function toOpenAIAgentsTool() {
    try {
      const sdk = await import("@openai/agents");
      if (typeof sdk.tool === "function") {
        return sdk.tool({
          name,
          description,
          parameters,
          execute,
        });
      }
      if (typeof sdk.functionTool === "function") {
        return sdk.functionTool(execute, {
          name,
          description,
          parameters,
        });
      }
    } catch {
      // SDK is optional for the standalone demo.
    }

    return {
      name,
      description,
      parameters,
      execute,
    };
  }

  return {
    name,
    description,
    parameters,
    execute,
    toOpenAIAgentsTool,
  };
}

async function selfTest() {
  const events = [];
  const tool = createGovernedExecuteTool({
    dryRun: true,
    logger(entry) {
      events.push(entry);
    },
  });

  const raw = await tool.execute({
    task: "Summarize the current queue state",
    input: { queue: "review_open" },
    constraints: { max_cost_usdc: 0.05 },
    source: "self-test",
    tags: ["demo", "receipt"],
  });

  const parsed = JSON.parse(raw);
  assert.equal(parsed.ok, true);
  assert.equal(typeof parsed.audit_id, "string");
  assert.equal(parsed.output.status, "completed");
  assert.equal(parsed.receipt.status, "simulated");
  assert.equal(events.some((e) => e.event === "execute_start"), true);
  assert.equal(events.some((e) => e.event === "execute_complete"), true);
  return parsed;
}

async function main() {
  const parsed = await selfTest();
  const tool = createGovernedExecuteTool({ dryRun: true });
  const sdkTool = await tool.toOpenAIAgentsTool();

  console.log(
    JSON.stringify(
      {
        demo: "ok",
        sdk_tool_name: sdkTool.name || tool.name,
        invocation_id: parsed.invocation_id,
        receipt_id: parsed.receipt.receipt_id,
        request_fingerprint: parsed.receipt.metadata.request_fingerprint,
      },
      null,
      2,
    ),
  );
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((error) => {
    console.error(error?.stack || String(error));
    process.exitCode = 1;
  });
}
