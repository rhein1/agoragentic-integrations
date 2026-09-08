#!/usr/bin/env node
'use strict';

const mcp = require('../../dist/mcp-server.cjs');
const { createRiskForkdService } = require('../../risk-forkd.js');

let eventIndex = 0;
let holdOpen;

function record(event, details = {}) {
    eventIndex += 1;
    console.error(`RISK_FORKD_EVENT ${JSON.stringify({ index: eventIndex, event, ...details })}`);
}

function cleanImported(request, result) {
    const evidenceRef = `risk-forkd-loopback:${request.request_id}`;
    return {
        schema: mcp.MCP_ENFORCEMENT_SCHEMAS.cleanImportedResult,
        request_id: request.request_id,
        request_hash: request.request_hash,
        phase: request.phase,
        clean_imported: true,
        authority_granted: false,
        evidence_ref: evidenceRef,
        evidence_hash: mcp.computeMcpCleanImportEvidenceHash(
            request.request_hash,
            result,
            evidenceRef,
        ),
        result,
    };
}

const readOnlyTool = {
    name: 'risk_forkd_loopback_read',
    description: 'Deterministic in-memory read-only risk-forkd fixture.',
    inputSchema: {
        type: 'object',
        properties: {
            value: { type: 'string' },
        },
        additionalProperties: false,
    },
    annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
    },
    capabilities: {
        network_access: false,
        filesystem_read: false,
        filesystem_write: false,
        credential_access: false,
        wallet_or_payment: false,
        deployment: false,
        publication: false,
        communication: false,
        database_mutation: false,
        trust_or_reputation_mutation: false,
        external_side_effect: false,
        unknown_or_unclassified: false,
    },
};

const enforcementBoundary = mcp.createMcpEnforcementBoundary({
    async openSession(openRequest) {
        record('host_request', { phase: openRequest.phase });
        holdOpen = setInterval(() => {}, 1000);
        return {
            schema: mcp.MCP_ENFORCEMENT_SCHEMAS.hostSession,
            discovery: cleanImported(openRequest, {
                protocol_version: mcp.MCP_V2_PROTOCOL_VERSION,
                stateless: true,
            }),
            async request(request) {
                record('host_request', { phase: request.phase });
                if (request.phase === 'tools/list') {
                    return cleanImported(request, { tools: [readOnlyTool] });
                }
                if (request.phase === 'tools/call') {
                    return cleanImported(request, {
                        content: [{
                            type: 'text',
                            text: JSON.stringify({
                                ok: true,
                                value: request.params.arguments?.value ?? null,
                            }),
                        }],
                    });
                }
                throw new Error(`unexpected loopback phase ${request.phase}`);
            },
            async close() {
                clearInterval(holdOpen);
                record('host_close');
            },
        };
    },
    async executeFallback(request) {
        record('fallback_bypass', { phase: request.phase });
        throw new Error('risk-forkd loopback fixture forbids fallback execution');
    },
});

const service = createRiskForkdService({ enforcementBoundary });
record('service_created', {
    service_keys: Reflect.ownKeys(service),
    status: service.status,
});
service.start().catch((error) => {
    console.error(error instanceof Error ? error.stack || error.message : String(error));
    process.exit(1);
});
