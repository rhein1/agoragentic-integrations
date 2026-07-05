#!/usr/bin/env node
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const OUTPUT_RELATIVE_PATH = "docs/x402-tool-execute-integration.md";
const DOC_NOTE = "demo — moves no real funds unless a caller supplies a pay callback that authorizes an x402 challenge.";

function lines(...parts) {
  return parts.filter((part) => part !== undefined && part !== null).join("\n");
}

function renderExampleSource() {
  return [
    '#!/usr/bin/env node',
    '// demo — moves no real funds unless a caller supplies a pay callback that authorizes an x402 challenge.',
    '',
    'import { randomUUID } from "node:crypto";',
    'import { x402Fetch } from "agoragentic/x402-client";',
    '',
    'const EXECUTE_URL = process.env.AGORAGENTIC_EXECUTE_URL || "https://agoragentic.example/api/x402/execute";',
    '',
    'function readHeader(source, name) {',
    '  if (!source) return null;',
    '  if (typeof source.get === "function") {',
    '    return source.get(name) ?? source.get(String(name).toLowerCase()) ?? null;',
    '  }',
    '  const key = String(name).toLowerCase();',
    '  for (const [headerName, headerValue] of Object.entries(source.headers || source)) {',
    '    if (String(headerName).toLowerCase() === key) return headerValue;',
    '  }',
    '  return null;',
    '}',
    '',
    'async function safeJson(response) {',
    '  const text = await response.text();',
    '  if (!text) return null;',
    '  try {',
    '    return JSON.parse(text);',
    '  } catch {',
    '    return { raw: text };',
    '  }',
    '}',
    '',
    'function buildReceiptSummary({ response, payload, idempotencyKey, quoteId, capabilityId, toolName }) {',
    '  return {',
    '    capability_id: capabilityId,',
    '    tool_name: toolName,',
    '    quote_id: quoteId,',
    '    idempotency_key: idempotencyKey,',
    '    invocation_id: payload?.invocation_id ?? payload?.invocationId ?? null,',
    '    receipt_id: payload?.receipt_id ?? payload?.receipt?.id ?? readHeader(response, "payment-receipt") ?? null,',
    '    payment_response_header: readHeader(response, "payment-response"),',
    '    payment_receipt_header: readHeader(response, "payment-receipt"),',
    '    response_status: response.status,',
    '    residual_uncertainty: "Buyer-visible receipt metadata only; query a proof endpoint separately if terminal settlement is required."',
    '  };',
    '}',
    '',
    'export async function executeToolWithReceipt({',
    '  capabilityId,',
    '  quoteId,',
    '  toolName,',
    '  toolArguments,',
    '  pay,',
    '  fetchImpl = fetch,',
    '  executeUrl = EXECUTE_URL,',
    '  idempotencyKey = randomUUID(),',
    '}) {',
    '  if (!capabilityId) throw new Error("capabilityId is required");',
    '  if (!quoteId) throw new Error("quoteId is required");',
    '  if (!toolName) throw new Error("toolName is required");',
    '  if (!toolArguments || typeof toolArguments !== "object" || Array.isArray(toolArguments)) {',
    '    throw new Error("toolArguments must be an object");',
    '  }',
    '  if (typeof pay !== "function") {',
    '    throw new Error("pay callback is required for x402-paid execution");',
    '  }',
    '',
    '  const response = await x402Fetch(executeUrl, {',
    '    method: "POST",',
    '    headers: { "content-type": "application/json" },',
    '    body: JSON.stringify({',
    '      quote_id: quoteId,',
    '      capability_id: capabilityId,',
    '      task: `Run ${toolName} through execute()`,',
    '      input: {',
    '        transport: "mcp",',
    '        tool: toolName,',
    '        arguments: toolArguments,',
    '      },',
    '    }),',
    '    fetchImpl,',
    '    pay,',
    '    idempotencyKey,',
    '  });',
    '',
    '  const payload = await safeJson(response);',
    '  if (!response.ok) {',
    '    const error = new Error(`execute() failed with HTTP ${response.status}`);',
    '    error.status = response.status;',
    '    error.payload = payload;',
    '    error.idempotencyKey = idempotencyKey;',
    '    throw error;',
    '  }',
    '',
    '  return {',
    '    output: payload?.result ?? payload,',
    '    receipt: buildReceiptSummary({',
    '      response,',
    '      payload,',
    '      idempotencyKey,',
    '      quoteId,',
    '      capabilityId,',
    '      toolName,',
    '    }),',
    '  };',
    '}',
    '',
    'async function main() {',
    '  if (process.env.DOCS_LIVE_X402_DEMO !== "1") {',
    '    console.log("Set DOCS_LIVE_X402_DEMO=1 and provide a real pay callback in your own wrapper to run a live paid call.");',
    '    return;',
    '  }',
    '',
    '  const result = await executeToolWithReceipt({',
    '    capabilityId: "agoragentic.tool.web-fetch.v1",',
    '    quoteId: process.env.QUOTE_ID,',
    '    toolName: "mcp.web.fetch",',
    '    toolArguments: { url: "https://example.com/feed.xml" },',
    '    pay: async (paymentRequired, context) => {',
    '      throw new Error(`Docs mode refused to pay. Received challenge for ${context.url}: ${paymentRequired}`);',
    '    },',
    '  });',
    '',
    '  console.log(JSON.stringify(result, null, 2));',
    '}',
    '',
    'if (import.meta.url === new URL(process.argv[1], "file:").href) {',
    '  main().catch((error) => {',
    '    console.error(error);',
    '    process.exitCode = 1;',
    '  });',
    '}',
  ].join("\n");
}

function renderGuide() {
  const exampleSource = renderExampleSource();
  return lines(
    "# Integrate a tool with x402 receipts and `execute()`",
    "",
    DOC_NOTE,
    "",
    "This guide is a public-docs PR candidate for `rhein1/agoragentic-integrations`. It shows the smallest useful path for wrapping a tool behind `execute()`, paying only when the server returns HTTP 402, and capturing buyer-visible receipt evidence.",
    "",
    "## What this integration pattern guarantees",
    "",
    "- one stable capability id for the tool integration,",
    "- one caller-owned `pay` gate for any paid path,",
    "- one idempotency key reused across the whole retry sequence,",
    "- one receipt bundle with `quote_id`, `receipt_id`, and `invocation_id` when the server returns them.",
    "",
    "## Step 1: Pin the capability and tool contract",
    "",
    "Choose the identifiers before writing wrapper code:",
    "",
    "- capability id: `agoragentic.tool.web-fetch.v1`",
    "- upstream tool name: `mcp.web.fetch`",
    "- transport: `mcp` routed through `execute()`",
    "- required inputs: a `quote_id`, a tool name, and a narrow JSON object of tool arguments",
    "",
    "Keep routing, pricing, and approval policy out of the tool's business arguments.",
    "",
    "## Step 2: Match or quote before execution",
    "",
    "Run your normal match or quote flow first and carry the returned `quote_id` into the execute request. The `quote_id` is the anchor that lets you bind receipt evidence back to one logical purchase attempt.",
    "",
    "## Step 3: Call `execute()` with the shared x402 helper",
    "",
    "Do not hand-roll the payment loop. Import `x402Fetch`, require a caller-supplied `pay` callback, and pass one idempotency key through the whole request.",
    "",
    "```js",
    exampleSource,
    "```",
    "",
    "## Step 4: Capture the receipt bundle after success",
    "",
    "After a successful `execute()` response, save this minimal evidence bundle next to the tool result:",
    "",
    "- `quote_id` used for the call,",
    "- `idempotency_key` sent on the request,",
    "- `invocation_id` from the response body when present,",
    "- `receipt_id` from the body or `payment-receipt` header,",
    "- `payment-response` and `payment-receipt` headers when present,",
    "- the residual uncertainty that this is buyer-visible receipt evidence, not independent settlement proof.",
    "",
    "## Step 5: Keep retries payment-safe",
    "",
    "The helper matters because it already enforces the safety rules that usually get missed in ad hoc integrations:",
    "",
    "1. it authorizes payment only after an actual HTTP 402 challenge,",
    "2. it reuses the existing authorization on a transport retry,",
    "3. it keeps the same idempotency key on every attempt,",
    "4. it avoids double-paying a request just because the network dropped after authorization.",
    "",
    "## Step 6: Smoke-test the wrapper locally",
    "",
    "A maintainer should be able to review the docs PR with this exact loop:",
    "",
    "```bash",
    "node scripts/render_x402_execute_tool_integration_doc_pr.mjs --self-test",
    "node scripts/render_x402_execute_tool_integration_doc_pr.mjs --write",
    "```",
    "",
    "The generated document is safe to inspect without real wallets, secrets, or production spend. The embedded example refuses to pay unless the caller deliberately wires in a real `pay` callback.",
    "",
    "## Review checklist",
    "",
    "- [ ] The docs name one stable capability id.",
    "- [ ] The example imports `x402Fetch` from `agoragentic/x402-client`.",
    "- [ ] The example requires a caller-supplied `pay` callback.",
    "- [ ] The execute body includes `quote_id`, `capability_id`, and tool arguments.",
    "- [ ] Every paid request sends an idempotency key.",
    "- [ ] Receipt fields are captured without claiming terminal settlement.",
    "- [ ] The smoke test runs without production credentials.",
    "- [ ] The doc shows the next maintainer exactly where to copy the pattern."
  );
}

export function renderDoc() {
  return renderGuide();
}

export function selfTest() {
  const guide = renderDoc();
  assert.ok(guide.startsWith("# Integrate a tool with x402 receipts and `execute()`\n"));
  assert.ok(guide.includes(DOC_NOTE));
  assert.ok(guide.includes('import { x402Fetch } from "agoragentic/x402-client";'));
  assert.ok(guide.includes("pay callback is required for x402-paid execution"));
  assert.ok(guide.includes("quote_id"));
  assert.ok(guide.includes("idempotency key"));
  assert.ok(guide.includes("receipt_id"));
  assert.ok(guide.includes("node scripts/render_x402_execute_tool_integration_doc_pr.mjs --self-test"));
  assert.ok((guide.match(/^## Step /gm) || []).length >= 6);
  assert.ok((guide.match(/^- \[ \]/gm) || []).length >= 8);
  return {
    output_relative_path: OUTPUT_RELATIVE_PATH,
    byte_length: Buffer.byteLength(guide, "utf8"),
    step_sections: (guide.match(/^## Step /gm) || []).length,
    checklist_items: (guide.match(/^- \[ \]/gm) || []).length,
  };
}

function resolveRepoRoot() {
  const here = path.dirname(fileURLToPath(import.meta.url));
  return path.resolve(here, "..");
}

function resolveDefaultOutputPath() {
  return path.join(resolveRepoRoot(), OUTPUT_RELATIVE_PATH);
}

export async function main(argv = process.argv.slice(2)) {
  const args = new Set(argv);
  const guide = renderDoc();

  if (args.has("--self-test")) {
    process.stdout.write(`${JSON.stringify(selfTest(), null, 2)}\n`);
    return;
  }

  if (args.has("--write")) {
    const outputPath = resolveDefaultOutputPath();
    fs.mkdirSync(path.dirname(outputPath), { recursive: true });
    fs.writeFileSync(outputPath, guide, "utf8");
    process.stdout.write(`${outputPath}\n`);
    return;
  }

  process.stdout.write(`${guide}\n`);
}

const isDirectRun = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isDirectRun) {
  main().catch((error) => {
    process.stderr.write(`${error.stack || error.message}\n`);
    process.exitCode = 1;
  });
}
