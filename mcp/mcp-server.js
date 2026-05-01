#!/usr/bin/env node
'use strict';

const readline = require('readline');
const { version: PACKAGE_VERSION } = require('./package.json');

const REMOTE_MCP_URL = process.env.AGORAGENTIC_MCP_URL || 'https://agoragentic.com/api/mcp';
const API_KEY = process.env.AGORAGENTIC_API_KEY || '';
const ACP_MODE = process.argv.includes('--acp');

const ACP_TOOLS = [
    {
        name: 'agoragentic_execute',
        description: 'Route a task through Agent OS execute() with provider selection, fallback, receipts, and settlement.',
    },
    {
        name: 'agoragentic_match',
        description: 'Preview routed providers before execution.',
    },
    {
        name: 'agoragentic_quote',
        description: 'Create a bounded quote before paid execution.',
    },
    {
        name: 'agoragentic_status',
        description: 'Inspect execution status for an invocation.',
    },
    {
        name: 'agoragentic_receipt',
        description: 'Fetch normalized receipt and settlement metadata.',
    },
    {
        name: 'agoragentic_browse_services',
        description: 'Browse stable x402 edge resources.',
    },
    {
        name: 'agoragentic_call_service',
        description: 'Call a stable x402 edge resource after payment challenge handling.',
    },
    {
        name: 'agoragentic_edge_receipt',
        description: 'Inspect x402 edge receipt metadata.',
    },
    {
        name: 'agoragentic_x402_test',
        description: 'Exercise the free x402 pipeline canary.',
    },
];

function buildRemoteTransport() {
    const { StreamableHTTPClientTransport } = require('@modelcontextprotocol/sdk/client/streamableHttp.js');
    const headers = {};
    if (API_KEY) {
        headers.Authorization = `Bearer ${API_KEY}`;
    }

    return new StreamableHTTPClientTransport(new URL(REMOTE_MCP_URL), {
        requestInit: {
            headers,
        },
    });
}

async function connectRemoteClient() {
    const { Client } = require('@modelcontextprotocol/sdk/client/index.js');
    const transport = buildRemoteTransport();
    const client = new Client(
        { name: 'agoragentic-mcp', version: PACKAGE_VERSION },
        { capabilities: { tools: {}, resources: {}, prompts: {} } }
    );

    client.onerror = (error) => {
        if (!error) return;
        const message = error instanceof Error ? error.message : String(error);
        console.error(`[agoragentic-mcp] remote client error: ${message}`);
    };

    await client.connect(transport);
    return { client, transport };
}

async function runMcpRelay() {
    const { Server } = require('@modelcontextprotocol/sdk/server/index.js');
    const { StdioServerTransport } = require('@modelcontextprotocol/sdk/server/stdio.js');
    const {
        CallToolRequestSchema,
        ListToolsRequestSchema,
        ListResourcesRequestSchema,
        ReadResourceRequestSchema,
        ListPromptsRequestSchema,
        GetPromptRequestSchema,
    } = require('@modelcontextprotocol/sdk/types.js');

    const { client, transport } = await connectRemoteClient();

    const server = new Server(
        { name: 'agoragentic', version: PACKAGE_VERSION },
        { capabilities: { tools: {}, resources: {}, prompts: {} } }
    );

    server.setRequestHandler(ListToolsRequestSchema, async (request) => {
        return client.listTools(request.params);
    });

    server.setRequestHandler(CallToolRequestSchema, async (request) => {
        return client.callTool(request.params);
    });

    server.setRequestHandler(ListResourcesRequestSchema, async (request) => {
        return client.listResources(request.params);
    });

    server.setRequestHandler(ReadResourceRequestSchema, async (request) => {
        return client.readResource(request.params);
    });

    server.setRequestHandler(ListPromptsRequestSchema, async (request) => {
        return client.listPrompts(request.params);
    });

    server.setRequestHandler(GetPromptRequestSchema, async (request) => {
        return client.getPrompt(request.params);
    });

    const stdio = new StdioServerTransport();
    await server.connect(stdio);

    const shutdown = async (signal) => {
        console.error(`[agoragentic-mcp] shutting down on ${signal}`);
        try {
            await transport.terminateSession();
        } catch {
            // Ignore session teardown failures during local shutdown.
        }
        try {
            await transport.close();
        } catch {
            // Ignore transport close failures during local shutdown.
        }
        process.exit(0);
    };

    process.on('SIGINT', () => {
        void shutdown('SIGINT');
    });
    process.on('SIGTERM', () => {
        void shutdown('SIGTERM');
    });

    console.error(`[agoragentic-mcp] stdio relay ${PACKAGE_VERSION} connected to ${REMOTE_MCP_URL}`);
}

function buildAcpInitializeResult() {
    return {
        protocolVersion: 1,
        agentInfo: {
            name: 'Agoragentic Agent OS',
            version: PACKAGE_VERSION,
            description:
                'Agent OS integrations for deployed agents and swarms: execute-first routing, receipts, x402 edge calls, and Base USDC settlement.',
            homepage: 'https://agoragentic.com',
        },
        agentCapabilities: {
            tools: true,
            streaming: false,
            resources: false,
            prompts: false,
        },
        authMethods: [
            {
                type: 'env',
                name: 'AGORAGENTIC_API_KEY',
                configured: Boolean(API_KEY),
                required: false,
                instructions:
                    'Optional for public discovery and x402 edge calls. Required for authenticated execute/match/status/receipt. Create one with POST /api/quickstart and intent=buyer|seller|both.',
            },
        ],
    };
}

function buildAcpResponse(id, result) {
    return {
        jsonrpc: '2.0',
        id,
        result,
    };
}

function buildAcpError(id, code, message, data) {
    return {
        jsonrpc: '2.0',
        id,
        error: data ? { code, message, data } : { code, message },
    };
}

function writeAcpMessage(message) {
    process.stdout.write(`${JSON.stringify(message)}\n`);
}

async function runAcpAdapter() {
    const rl = readline.createInterface({
        input: process.stdin,
        crlfDelay: Infinity,
        terminal: false,
    });

    let remoteSession = null;

    async function getRemoteSession() {
        if (!remoteSession) {
            remoteSession = await connectRemoteClient();
        }
        return remoteSession;
    }

    async function shutdownRemote() {
        if (!remoteSession) return;
        try {
            await remoteSession.transport.terminateSession();
        } catch {
            // Ignore session teardown failures during local shutdown.
        }
        try {
            await remoteSession.transport.close();
        } catch {
            // Ignore transport close failures during local shutdown.
        }
        remoteSession = null;
    }

    process.on('SIGINT', () => {
        void shutdownRemote().finally(() => process.exit(0));
    });
    process.on('SIGTERM', () => {
        void shutdownRemote().finally(() => process.exit(0));
    });

    console.error(`[agoragentic-mcp] ACP adapter ${PACKAGE_VERSION} ready`);

    for await (const line of rl) {
        if (!line.trim()) continue;

        let request;
        try {
            request = JSON.parse(line);
        } catch (error) {
            writeAcpMessage(buildAcpError(null, -32700, 'Invalid JSON-RPC payload'));
            continue;
        }

        const id = Object.prototype.hasOwnProperty.call(request, 'id') ? request.id : null;

        try {
            if (request.method === 'initialize') {
                writeAcpMessage(buildAcpResponse(id, buildAcpInitializeResult()));
            } else if (request.method === 'tools/list') {
                writeAcpMessage(buildAcpResponse(id, { tools: ACP_TOOLS }));
            } else if (request.method === 'tools/call') {
                const { client } = await getRemoteSession();
                const result = await client.callTool(request.params || {});
                writeAcpMessage(buildAcpResponse(id, result));
            } else if (request.method === 'shutdown') {
                await shutdownRemote();
                writeAcpMessage(buildAcpResponse(id, { ok: true }));
            } else {
                writeAcpMessage(
                    buildAcpError(id, -32601, 'Unsupported ACP method', {
                        supported_methods: ['initialize', 'tools/list', 'tools/call', 'shutdown'],
                    })
                );
            }
        } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            writeAcpMessage(buildAcpError(id, -32000, message));
        }
    }

    await shutdownRemote();
}

const entrypoint = ACP_MODE ? runAcpAdapter : runMcpRelay;

entrypoint().catch((error) => {
    const message = error instanceof Error ? error.stack || error.message : String(error);
    console.error(`[agoragentic-mcp] fatal: ${message}`);
    process.exit(1);
});
