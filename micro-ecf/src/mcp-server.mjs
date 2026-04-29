import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';

import {
  DEFAULT_BASE_URL,
  buildArtifacts,
  exportAgentOsHarness,
  readJson,
  readPolicy,
  searchSourceMap,
} from './core.mjs';

const TOOLS = [
  {
    name: 'micro_ecf.search_context',
    description: 'Search local Micro ECF source-map summaries. Returns metadata only, not raw source contents.',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string' },
        limit: { type: 'number' },
      },
      required: ['query'],
    },
  },
  {
    name: 'micro_ecf.get_source',
    description: 'Read one source metadata record from the local source map by source id or path.',
    inputSchema: {
      type: 'object',
      properties: {
        source_id: { type: 'string' },
        path: { type: 'string' },
      },
    },
  },
  {
    name: 'micro_ecf.get_policy',
    description: 'Read the local Micro ECF policy file.',
    inputSchema: {
      type: 'object',
      properties: {},
    },
  },
  {
    name: 'micro_ecf.build_packet',
    description: 'Build local context-packet, policy-summary, source-map, and deployment-preview artifacts.',
    inputSchema: {
      type: 'object',
      properties: {},
    },
  },
  {
    name: 'micro_ecf.export_agent_os_harness',
    description: 'Export a no-spend Agent OS Harness packet from the local Micro ECF policy.',
    inputSchema: {
      type: 'object',
      properties: {
        output: { type: 'string' },
      },
    },
  },
];

export async function startStdioMcpServer({ root }) {
  const resolvedRoot = path.resolve(root);
  const rl = readline.createInterface({
    input: process.stdin,
    crlfDelay: Infinity,
  });

  for await (const line of rl) {
    if (!line.trim()) continue;
    const request = JSON.parse(line);
    try {
      const result = await handleRequest(request, resolvedRoot);
      writeResponse({ jsonrpc: '2.0', id: request.id, result });
    } catch (err) {
      writeResponse({
        jsonrpc: '2.0',
        id: request.id,
        error: {
          code: -32000,
          message: err.message,
        },
      });
    }
  }
}

async function handleRequest(request, root) {
  if (request.method === 'initialize') {
    return {
      protocolVersion: '2024-11-05',
      serverInfo: {
        name: 'micro-ecf',
        version: '0.1.0',
      },
      capabilities: {
        tools: {},
      },
    };
  }

  if (request.method === 'tools/list') {
    return { tools: TOOLS };
  }

  if (request.method === 'tools/call') {
    const name = request.params?.name;
    const args = request.params?.arguments || {};
    const payload = await callTool(name, args, root);
    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify(payload, null, 2),
        },
      ],
    };
  }

  return {};
}

async function callTool(name, args, root) {
  const policyPath = path.join(root, 'policy.json');
  const sourceMapPath = path.join(root, 'source-map.json');

  if (name === 'micro_ecf.search_context') {
    const sourceMap = readJson(sourceMapPath);
    return searchSourceMap(sourceMap, args.query, Number(args.limit || 10));
  }

  if (name === 'micro_ecf.get_source') {
    const sourceMap = readJson(sourceMapPath);
    const source = (sourceMap.sources || []).find((entry) => (
      entry.id === args.source_id || entry.path === args.path
    ));
    if (!source) throw new Error('Source metadata not found');
    return source;
  }

  if (name === 'micro_ecf.get_policy') {
    return readPolicy(policyPath).policy;
  }

  if (name === 'micro_ecf.build_packet') {
    return buildArtifacts({
      policyPath,
      sourceMapPath,
      outputDir: root,
    });
  }

  if (name === 'micro_ecf.export_agent_os_harness') {
    const outputPath = path.resolve(root, args.output || 'harness-export.json');
    const { output } = exportAgentOsHarness({
      policyPath,
      outputPath,
      baseUrl: DEFAULT_BASE_URL,
      artifactRefs: artifactRefsFor(root),
    });
    return {
      ok: true,
      output,
      no_spend: true,
    };
  }

  throw new Error(`Unknown tool: ${name}`);
}

function artifactRefsFor(root) {
  return {
    context_packet: path.join(root, 'context-packet.json').replace(/\\/g, '/'),
    policy_summary: path.join(root, 'policy-summary.json').replace(/\\/g, '/'),
    source_map: path.join(root, 'source-map.json').replace(/\\/g, '/'),
    deployment_preview: path.join(root, 'deployment-preview.json').replace(/\\/g, '/'),
  };
}

function writeResponse(response) {
  process.stdout.write(`${JSON.stringify(response)}\n`);
}

if (process.argv[1] && process.argv[1].endsWith('mcp-server.mjs')) {
  startStdioMcpServer({ root: process.argv[2] || '.micro-ecf' }).catch((err) => {
    console.error(JSON.stringify({ ok: false, error: err.message }, null, 2));
    process.exit(1);
  });
}
