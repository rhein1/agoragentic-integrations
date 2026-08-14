#!/usr/bin/env node
'use strict';

// Test-only trusted host fixture. Production `agoragentic-mcp` deliberately
// ships no network-owning enforcement adapter; an embedding host must supply
// one that performs real Risk Fork isolation and clean import.

const { Client, StreamableHTTPClientTransport } = require('@modelcontextprotocol/client');
const {
    MCP_ENFORCEMENT_SCHEMAS,
    MCP_V2_PROTOCOL_VERSION,
    computeMcpCleanImportEvidenceHash,
    createMcpEnforcementBoundary,
    runMcpRelay,
} = require('../../mcp-server.js');

function cleanImported(request, result) {
    const evidenceRef = `test-host:${request.request_id}`;
    return {
        schema: MCP_ENFORCEMENT_SCHEMAS.cleanImportedResult,
        request_id: request.request_id,
        request_hash: request.request_hash,
        phase: request.phase,
        clean_imported: true,
        authority_granted: false,
        evidence_ref: evidenceRef,
        evidence_hash: computeMcpCleanImportEvidenceHash(
            request.request_hash,
            result,
            evidenceRef,
        ),
        result,
    };
}

const boundary = createMcpEnforcementBoundary({
    async openSession(openRequest) {
        const apiKey = String(process.env.AGORAGENTIC_API_KEY || '').trim();
        const transport = new StreamableHTTPClientTransport(new URL(openRequest.mcp_server_ref), {
            authProvider: { token: async () => apiKey || undefined },
            onInsufficientScope: 'throw',
            requestInit: {
                redirect: 'error',
                headers: { 'User-Agent': 'agoragentic-mcp-test-enforced-host' },
            },
        });
        const client = new Client(
            { name: 'agoragentic-mcp-test-enforced-host', version: '1.0.0' },
            { versionNegotiation: { mode: { pin: MCP_V2_PROTOCOL_VERSION } } },
        );
        try {
            await client.connect(transport);
            if (client.getProtocolEra() !== 'modern'
                || client.getNegotiatedProtocolVersion() !== MCP_V2_PROTOCOL_VERSION
                || transport.sessionId !== undefined) {
                throw new Error('test host did not establish the pinned stateless protocol');
            }
        } catch (error) {
            try {
                await client.close();
            } catch {
                // Preserve the original test-host connection failure.
            }
            throw error;
        }

        return {
            schema: MCP_ENFORCEMENT_SCHEMAS.hostSession,
            discovery: cleanImported(openRequest, {
                protocol_version: MCP_V2_PROTOCOL_VERSION,
                stateless: true,
            }),
            async request(request) {
                let result;
                if (request.phase === 'tools/list') result = await client.listTools(request.params);
                else if (request.phase === 'tools/call') result = await client.callTool(request.params);
                else if (request.phase === 'resources/list') result = await client.listResources(request.params);
                else if (request.phase === 'resources/read') result = await client.readResource(request.params);
                else if (request.phase === 'prompts/list') result = await client.listPrompts(request.params);
                else if (request.phase === 'prompts/get') result = await client.getPrompt(request.params);
                else throw new Error(`unsupported enforced test phase ${request.phase}`);
                return cleanImported(request, result);
            },
            async close() {
                await client.close();
            },
        };
    },
    async executeFallback(request) {
        throw new Error(`test host does not permit fallback execution: ${request.tool_name}`);
    },
});

runMcpRelay({ enforcementBoundary: boundary }).catch((error) => {
    console.error(error instanceof Error ? error.stack || error.message : String(error));
    process.exit(1);
});
