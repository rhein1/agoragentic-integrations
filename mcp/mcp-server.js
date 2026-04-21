#!/usr/bin/env node
'use strict';

const { Server } = require('@modelcontextprotocol/sdk/server/index.js');
const { StdioServerTransport } = require('@modelcontextprotocol/sdk/server/stdio.js');
const { Client } = require('@modelcontextprotocol/sdk/client/index.js');
const { StreamableHTTPClientTransport } = require('@modelcontextprotocol/sdk/client/streamableHttp.js');
const {
    CallToolRequestSchema,
    ListToolsRequestSchema,
    ListResourcesRequestSchema,
    ReadResourceRequestSchema,
    ListPromptsRequestSchema,
    GetPromptRequestSchema,
} = require('@modelcontextprotocol/sdk/types.js');
const { version: PACKAGE_VERSION } = require('./package.json');

const REMOTE_MCP_URL = process.env.AGORAGENTIC_MCP_URL || 'https://agoragentic.com/api/mcp';
const API_KEY = process.env.AGORAGENTIC_API_KEY || '';

function buildRemoteTransport() {
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

async function main() {
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

main().catch((error) => {
    const message = error instanceof Error ? error.stack || error.message : String(error);
    console.error(`[agoragentic-mcp] fatal: ${message}`);
    process.exit(1);
});
