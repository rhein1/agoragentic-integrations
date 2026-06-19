#!/usr/bin/env node
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import process from 'node:process';

const FILE_PATH = 'examples/mcp-trust-checked-capability-template.mjs';
const RECEIPT_DIR = '.agoragentic/local-capability-receipts';

function canonicalize(value) {
  if (Array.isArray(value)) {
    return value.map(canonicalize);
  }
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .map((key) => [key, canonicalize(value[key])]),
    );
  }
  return value;
}

function stableJson(value) {
  return JSON.stringify(canonicalize(value), null, 2);
}

function sha256(value) {
  const text = typeof value === 'string' ? value : stableJson(value);
  return createHash('sha256').update(text).digest('hex');
}

function byteLength(value) {
  const text = typeof value === 'string' ? value : stableJson(value);
  return Buffer.byteLength(text, 'utf8');
}

function nowIso() {
  return new Date().toISOString();
}

function parseSemver(version) {
  const parts = String(version || '0.0.0')
    .split('.')
    .slice(0, 3)
    .map((part) => Number.parseInt(part, 10) || 0);
  while (parts.length < 3) parts.push(0);
  return parts;
}

function compareSemver(a, b) {
  const left = parseSemver(a);
  const right = parseSemver(b);
  for (let index = 0; index < 3; index += 1) {
    if (left[index] > right[index]) return 1;
    if (left[index] < right[index]) return -1;
  }
  return 0;
}

function buildToolFingerprint(serverCard, tools) {
  return sha256({
    server_id: serverCard.server_id,
    server_version: serverCard.version,
    tools: tools.map((tool) => ({
      name: tool.name,
      description: tool.description,
      inputSchema: tool.inputSchema,
    })),
  });
}

class JsonReceiptStore {
  constructor(baseDir = RECEIPT_DIR) {
    this.baseDir = resolve(baseDir);
  }

  persist(receipt) {
    const filePath = resolve(this.baseDir, `${receipt.receipt_id}.json`);
    mkdirSync(dirname(filePath), { recursive: true });
    writeFileSync(filePath, `${stableJson(receipt)}\n`, 'utf8');
    return filePath;
  }
}

function createDemoMcpServer() {
  const registry = new Map([
    [
      'weather_lookup',
      {
        description: 'Return a deterministic weather snapshot for a city.',
        inputSchema: {
          type: 'object',
          required: ['location'],
          properties: {
            location: { type: 'string' },
            unit: { type: 'string', enum: ['c', 'f'] },
          },
        },
        async call(args = {}) {
          const location = String(args.location || '').trim();
          if (!location) {
            throw new Error('location is required');
          }
          const unit = String(args.unit || 'c').toLowerCase() === 'f' ? 'f' : 'c';
          const baseTempC = 22;
          return {
            location,
            forecast: `Clear skies over ${location}`,
            temperature: unit === 'f' ? Math.round((baseTempC * 9) / 5 + 32) : baseTempC,
            unit,
            source: 'demo-mcp',
          };
        },
      },
    ],
    [
      'text_digest',
      {
        description: 'Return a SHA-256 digest and byte count for text.',
        inputSchema: {
          type: 'object',
          required: ['text'],
          properties: {
            text: { type: 'string' },
          },
        },
        async call(args = {}) {
          const text = String(args.text || '');
          return {
            text_preview: text.slice(0, 80),
            bytes: byteLength(text),
            sha256: sha256(text),
          };
        },
      },
    ],
  ]);

  const serverCard = {
    server_id: 'demo.mcp.weather.v1',
    name: 'Demo Weather MCP',
    version: '1.0.0',
    transport: 'local-memory',
  };

  return {
    async describe() {
      const tools = await this.listTools();
      return {
        ...serverCard,
        fingerprint: buildToolFingerprint(serverCard, tools),
      };
    },

    async listTools() {
      return [...registry.entries()].map(([name, entry]) => ({
        name,
        description: entry.description,
        inputSchema: entry.inputSchema,
      }));
    },

    async callTool(name, args = {}) {
      const entry = registry.get(name);
      if (!entry) {
        throw new Error(`Unknown MCP tool: ${name}`);
      }
      const output = await entry.call(args);
      return {
        content: [{ type: 'json', json: output }],
        structuredContent: output,
      };
    },
  };
}

function buildDemoCapabilityManifest(serverCard, tools) {
  return {
    capability_id: 'demo.weather-capability',
    version: '1.0.0',
    title: 'Demo MCP Weather Capability',
    source: {
      kind: 'mcp',
      server_id: serverCard.server_id,
      transport: serverCard.transport,
      min_server_version: '1.0.0',
      expected_tool_fingerprint: buildToolFingerprint(serverCard, tools),
    },
    trust: {
      review_mode: 'local-template',
      required_tools: ['weather_lookup', 'text_digest'],
      allowed_tools: ['weather_lookup', 'text_digest'],
    },
    task_map: {
      weather: 'weather_lookup',
      digest: 'text_digest',
    },
    policy: {
      max_input_bytes: 8192,
      write_receipts_locally: true,
      receipt_retention: 'local-json',
    },
  };
}

function verifyCapabilityTrust({ manifest, serverCard, tools }) {
  const reasons = [];
  const availableToolNames = new Set(tools.map((tool) => tool.name));

  if (manifest.source.server_id !== serverCard.server_id) {
    reasons.push(
      `server_id mismatch: expected ${manifest.source.server_id}, got ${serverCard.server_id}`,
    );
  }

  if (compareSemver(serverCard.version, manifest.source.min_server_version) < 0) {
    reasons.push(
      `server version ${serverCard.version} is below required ${manifest.source.min_server_version}`,
    );
  }

  for (const requiredTool of manifest.trust.required_tools) {
    if (!availableToolNames.has(requiredTool)) {
      reasons.push(`missing required tool: ${requiredTool}`);
    }
  }

  const actualFingerprint = buildToolFingerprint(serverCard, tools);
  if (manifest.source.expected_tool_fingerprint !== actualFingerprint) {
    reasons.push('tool fingerprint mismatch');
  }

  return {
    verified: reasons.length === 0,
    reasons,
    fingerprint: actualFingerprint,
  };
}

function selectTool({ manifest, task, preferredTool, tools }) {
  const allowed = new Set(manifest.trust.allowed_tools);
  const available = new Map(tools.map((tool) => [tool.name, tool]));

  if (preferredTool) {
    if (!allowed.has(preferredTool)) {
      throw new Error(`preferred tool is not trust-approved: ${preferredTool}`);
    }
    if (!available.has(preferredTool)) {
      throw new Error(`preferred tool is not available from the MCP server: ${preferredTool}`);
    }
    return preferredTool;
  }

  if (manifest.task_map[task] && available.has(manifest.task_map[task])) {
    return manifest.task_map[task];
  }

  const normalizedTask = String(task || '').toLowerCase();
  for (const tool of tools) {
    if (!allowed.has(tool.name)) continue;
    if (tool.name.includes(normalizedTask) || tool.description.toLowerCase().includes(normalizedTask)) {
      return tool.name;
    }
  }

  const firstAllowed = [...allowed].find((toolName) => available.has(toolName));
  if (firstAllowed) return firstAllowed;

  throw new Error(`no trust-approved tool available for task: ${task}`);
}

function normalizeToolResult(rawResult) {
  if (rawResult?.structuredContent && typeof rawResult.structuredContent === 'object') {
    return rawResult.structuredContent;
  }

  if (Array.isArray(rawResult?.content)) {
    const jsonBlock = rawResult.content.find((entry) => entry.type === 'json' && entry.json);
    if (jsonBlock) return jsonBlock.json;

    const textBlock = rawResult.content.find((entry) => entry.type === 'text' && typeof entry.text === 'string');
    if (textBlock) return { text: textBlock.text };
  }

  return rawResult;
}

function buildReceipt({
  manifest,
  serverCard,
  trust,
  task,
  input,
  output,
  selectedTool,
  actor,
  startedAt,
  finishedAt,
  error = null,
}) {
  const invocationId = `inv_${randomUUID()}`;
  const receipt = {
    receipt_id: `rcpt_${randomUUID()}`,
    invocation_id: invocationId,
    created_at: finishedAt,
    started_at: startedAt,
    finished_at: finishedAt,
    actor,
    capability: {
      capability_id: manifest.capability_id,
      version: manifest.version,
      title: manifest.title,
    },
    source: {
      kind: manifest.source.kind,
      server_id: serverCard.server_id,
      server_version: serverCard.version,
      transport: serverCard.transport,
      tool_fingerprint: trust.fingerprint,
    },
    trust: {
      verified: trust.verified,
      reasons: trust.reasons,
      required_tools: manifest.trust.required_tools,
      allowed_tools: manifest.trust.allowed_tools,
    },
    execution: {
      task,
      selected_tool: selectedTool,
      ok: !error,
    },
    usage: {
      input_sha256: sha256(input),
      output_sha256: sha256(output),
      input_bytes: byteLength(input),
      output_bytes: byteLength(output),
    },
    policy: manifest.policy,
    result: error ? { error } : output,
  };

  return receipt;
}

function createTrustCheckedCapability({ manifest, server, receiptStore }) {
  return {
    manifest,

    async inspect() {
      const serverCard = await server.describe();
      const tools = await server.listTools();
      const trust = verifyCapabilityTrust({ manifest, serverCard, tools });

      return {
        manifest,
        server: serverCard,
        tools,
        trust,
      };
    },

    async execute({ task, input = {}, actor = 'local-operator', preferredTool } = {}) {
      const startedAt = nowIso();
      const serverCard = await server.describe();
      const tools = await server.listTools();
      const trust = verifyCapabilityTrust({ manifest, serverCard, tools });

      if (!trust.verified) {
        const failedReceipt = buildReceipt({
          manifest,
          serverCard,
          trust,
          task,
          input,
          output: { blocked: true },
          selectedTool: null,
          actor,
          startedAt,
          finishedAt: nowIso(),
          error: `trust check failed: ${trust.reasons.join('; ')}`,
        });
        const receiptPath = receiptStore.persist(failedReceipt);
        return {
          ok: false,
          error: failedReceipt.result.error,
          receipt: { ...failedReceipt, receipt_path: receiptPath },
        };
      }

      if (byteLength(input) > manifest.policy.max_input_bytes) {
        const failedReceipt = buildReceipt({
          manifest,
          serverCard,
          trust,
          task,
          input,
          output: { blocked: true },
          selectedTool: null,
          actor,
          startedAt,
          finishedAt: nowIso(),
          error: `input exceeds policy limit of ${manifest.policy.max_input_bytes} bytes`,
        });
        const receiptPath = receiptStore.persist(failedReceipt);
        return {
          ok: false,
          error: failedReceipt.result.error,
          receipt: { ...failedReceipt, receipt_path: receiptPath },
        };
      }

      try {
        const selectedTool = selectTool({ manifest, task, preferredTool, tools });
        const rawResult = await server.callTool(selectedTool, input);
        const output = normalizeToolResult(rawResult);
        const receipt = buildReceipt({
          manifest,
          serverCard,
          trust,
          task,
          input,
          output,
          selectedTool,
          actor,
          startedAt,
          finishedAt: nowIso(),
        });
        const receiptPath = receiptStore.persist(receipt);

        return {
          ok: true,
          task,
          selected_tool: selectedTool,
          result: output,
          receipt: { ...receipt, receipt_path: receiptPath },
        };
      } catch (error) {
        const failedReceipt = buildReceipt({
          manifest,
          serverCard,
          trust,
          task,
          input,
          output: { failed: true },
          selectedTool: null,
          actor,
          startedAt,
          finishedAt: nowIso(),
          error: error instanceof Error ? error.message : String(error),
        });
        const receiptPath = receiptStore.persist(failedReceipt);
        return {
          ok: false,
          error: failedReceipt.result.error,
          receipt: { ...failedReceipt, receipt_path: receiptPath },
        };
      }
    },
  };
}

function createLocalExecuteToolWrapper(capability) {
  return async function execute({ task, input, actor, preferred_tool }) {
    return capability.execute({
      task,
      input,
      actor,
      preferredTool: preferred_tool,
    });
  };
}

function generateGuide() {
  return `# Packaging an MCP server as a trust-checked capability with usage receipts

This file is both a runnable template and a documentation artifact.

## What this template demonstrates

1. Build a capability manifest that pins:
   - \`source.server_id\`
   - \`source.min_server_version\`
   - \`source.expected_tool_fingerprint\`
   - \`trust.required_tools\`
   - \`trust.allowed_tools\`

2. Describe the MCP server and list tools before execution.
   - See: \`createDemoMcpServer()\`
   - See: \`buildToolFingerprint()\`

3. Verify trust before every call.
   - See: \`verifyCapabilityTrust()\`
   - The wrapper blocks execution when the server identity, version, required tools, or tool fingerprint drift.

4. Wrap the MCP call in a local \`execute()\` surface.
   - See: \`createTrustCheckedCapability(...).execute()\`
   - See: \`createLocalExecuteToolWrapper()\`

5. Emit a durable local receipt for every outcome.
   - See: \`buildReceipt()\`
   - See: \`JsonReceiptStore.persist()\`

## Step-by-step integration path

### 1) Replace the demo server with your real MCP transport
Your production adapter only needs three methods:

- \`describe() -> { server_id, version, transport, fingerprint }\`
- \`listTools() -> [{ name, description, inputSchema }]\`
- \`callTool(name, args) -> MCP tool result\`

### 2) Freeze the trust manifest
At packaging time, compute and commit the expected tool fingerprint:

- \`buildToolFingerprint(serverCard, tools)\`

That turns a raw MCP server into a trust-checked capability contract.

### 3) Map marketplace tasks onto approved MCP tools
Use \`task_map\` in the manifest:

- \`weather -> weather_lookup\`
- \`digest -> text_digest\`

A real package can expose higher-level tasks like \`search_docs\`, \`summarize_repo\`, or \`generate_report\`.

### 4) Expose a local execute() wrapper
The local execute wrapper in this file is:

- \`const execute = createLocalExecuteToolWrapper(capability)\`

Call shape:

\`\`\`js
const result = await execute({
  task: 'weather',
  input: { location: 'Lisbon', unit: 'c' },
  actor: 'guide-demo',
});
\`\`\`

### 5) Persist receipts next to the adapter
Every success and failure writes JSON under:

- \`${RECEIPT_DIR}\`

That gives maintainers a concrete usage-receipt trail before wiring the capability into a remote marketplace path.

## Commands

- Show this guide:
  - \`node ${FILE_PATH} --guide\`

- Run the local execute() demo:
  - \`node ${FILE_PATH} --demo\`

- Run the inline self-test:
  - \`node ${FILE_PATH} --self-test\`
`;
}

async function runDemo() {
  const server = createDemoMcpServer();
  const serverCard = await server.describe();
  const tools = await server.listTools();
  const manifest = buildDemoCapabilityManifest(serverCard, tools);
  const receiptStore = new JsonReceiptStore();
  const capability = createTrustCheckedCapability({ manifest, server, receiptStore });
  const execute = createLocalExecuteToolWrapper(capability);

  const weather = await execute({
    task: 'weather',
    input: { location: 'Lisbon', unit: 'c' },
    actor: 'guide-demo',
  });

  const digest = await execute({
    task: 'digest',
    input: { text: weather.result.forecast },
    actor: 'guide-demo',
  });

  return {
    guide: `Run "node ${FILE_PATH} --guide" for the step-by-step integration guide.`,
    weather,
    digest,
  };
}

async function runSelfTest() {
  const server = createDemoMcpServer();
  const serverCard = await server.describe();
  const tools = await server.listTools();
  const manifest = buildDemoCapabilityManifest(serverCard, tools);
  const receiptStore = new JsonReceiptStore('.agoragentic/test-receipts');
  const capability = createTrustCheckedCapability({ manifest, server, receiptStore });
  const execute = createLocalExecuteToolWrapper(capability);

  const inspection = await capability.inspect();
  assert.equal(inspection.trust.verified, true);
  assert.deepEqual(
    inspection.tools.map((tool) => tool.name).sort(),
    ['text_digest', 'weather_lookup'],
  );

  const weather = await execute({
    task: 'weather',
    input: { location: 'Berlin', unit: 'f' },
    actor: 'self-test',
  });
  assert.equal(weather.ok, true);
  assert.equal(weather.selected_tool, 'weather_lookup');
  assert.equal(weather.result.location, 'Berlin');
  assert.equal(weather.result.unit, 'f');
  assert.ok(weather.receipt.receipt_id.startsWith('rcpt_'));
  assert.equal(weather.receipt.trust.verified, true);

  const digest = await execute({
    task: 'digest',
    input: { text: 'trust-checked capability' },
    actor: 'self-test',
  });
  assert.equal(digest.ok, true);
  assert.equal(digest.selected_tool, 'text_digest');
  assert.equal(digest.result.bytes, Buffer.byteLength('trust-checked capability', 'utf8'));

  const oversized = await execute({
    task: 'digest',
    input: { text: 'x'.repeat(manifest.policy.max_input_bytes + 1) },
    actor: 'self-test',
  });
  assert.equal(oversized.ok, false);
  assert.match(oversized.error, /input exceeds policy limit/i);

  const tamperedManifest = {
    ...manifest,
    source: {
      ...manifest.source,
      expected_tool_fingerprint: 'tampered',
    },
  };
  const blockedCapability = createTrustCheckedCapability({
    manifest: tamperedManifest,
    server,
    receiptStore,
  });
  const blocked = await blockedCapability.execute({
    task: 'weather',
    input: { location: 'Oslo' },
    actor: 'self-test',
  });
  assert.equal(blocked.ok, false);
  assert.match(blocked.error, /trust check failed/i);

  return {
    ok: true,
    assertions: 10,
    file: FILE_PATH,
  };
}

async function main(argv) {
  const mode = argv[2] || '--demo';

  if (mode === '--guide') {
    process.stdout.write(`${generateGuide()}\n`);
    return;
  }

  if (mode === '--self-test') {
    const result = await runSelfTest();
    process.stdout.write(`${stableJson(result)}\n`);
    return;
  }

  if (mode === '--demo') {
    const result = await runDemo();
    process.stdout.write(`${stableJson(result)}\n`);
    return;
  }

  if (mode === '--help' || mode === '-h') {
    process.stdout.write(
      [
        `Usage: node ${FILE_PATH} [--guide|--demo|--self-test]`,
        '',
        '--guide      Print the step-by-step integration guide.',
        '--demo       Run the local trust-checked execute() demo.',
        '--self-test  Run inline assertions.',
      ].join('\n') + '\n',
    );
    return;
  }

  throw new Error(`Unknown argument: ${mode}`);
}

if (import.meta.url === new URL(`file://${process.argv[1]}`).href) {
  main(process.argv).catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.stack || error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}

export {
  JsonReceiptStore,
  buildDemoCapabilityManifest,
  buildReceipt,
  buildToolFingerprint,
  createDemoMcpServer,
  createLocalExecuteToolWrapper,
  createTrustCheckedCapability,
  generateGuide,
  normalizeToolResult,
  runDemo,
  runSelfTest,
  selectTool,
  verifyCapabilityTrust,
};