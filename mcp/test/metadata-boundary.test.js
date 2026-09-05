'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const {
    MCP_ENFORCEMENT_SCHEMAS,
    MCP_V2_PROTOCOL_VERSION,
    computeMcpCleanImportEvidenceHash,
    connectRemoteClient,
    createMcpEnforcementBoundary,
    stripOpaqueMcpMetadata,
} = require('../mcp-server.js');

const REMOTE_URL = 'https://mcp.agoragentic.com/rpc';
const OPAQUE_MARKER = 'opaque-client-metadata-must-not-cross';

function imported(request, result) {
    const evidenceRef = `test:${request.phase.replace('/', '-')}`;
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

function toolDescriptor() {
    return {
        name: 'metadata_echo',
        description: 'Returns a bounded test result.',
        inputSchema: {
            type: 'object',
            additionalProperties: false,
            properties: { message: { type: 'string' } },
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
}

function fixture() {
    const requests = [];
    let closeCount = 0;
    const hostAdapter = {
        async openSession(openRequest) {
            return {
                schema: MCP_ENFORCEMENT_SCHEMAS.hostSession,
                discovery: imported(openRequest, {
                    protocol_version: MCP_V2_PROTOCOL_VERSION,
                    stateless: true,
                }),
                async request(request) {
                    requests.push(request);
                    if (request.phase === 'tools/list') {
                        return imported(request, { tools: [toolDescriptor()] });
                    }
                    if (request.phase === 'tools/call') {
                        return imported(request, {
                            content: [{ type: 'text', text: 'clean result' }],
                            isError: false,
                        });
                    }
                    throw new Error(`unexpected phase: ${request.phase}`);
                },
                async close() { closeCount += 1; },
            };
        },
        async executeFallback() {
            throw new Error('fallback must not run');
        },
    };
    return {
        boundary: createMcpEnforcementBoundary(hostAdapter),
        closeCount: () => closeCount,
        requests,
    };
}

test('opaque MCP metadata is bounded, validated, and erased before host dispatch', async () => {
    const current = fixture();
    const session = await connectRemoteClient({
        remoteUrl: REMOTE_URL,
        enforcementBoundary: current.boundary,
    });
    const result = await session.callTool({
        name: 'metadata_echo',
        arguments: { message: 'bounded' },
        _meta: {
            progressToken: 'opaque-progress-17',
            'codex/workspace': { marker: OPAQUE_MARKER, root: 'C:/private/workspace' },
        },
    });
    await session.close();

    const call = current.requests.find((request) => request.phase === 'tools/call');
    assert.deepEqual(call.params, {
        arguments: { message: 'bounded' },
        name: 'metadata_echo',
    });
    assert.equal(Object.hasOwn(call.params, '_meta'), false);
    assert.equal(JSON.stringify(current.requests).includes(OPAQUE_MARKER), false);
    assert.equal(JSON.stringify(result).includes(OPAQUE_MARKER), false);
    assert.equal(current.closeCount(), 1);
});

test('malformed MCP metadata fails closed before host dispatch', async () => {
    for (const malformed of [null, 'opaque', [], 1]) {
        const current = fixture();
        const session = await connectRemoteClient({
            remoteUrl: REMOTE_URL,
            enforcementBoundary: current.boundary,
        });
        const before = current.requests.length;
        await assert.rejects(
            session.listResources({ _meta: malformed }),
            /_meta must be a plain object/,
        );
        assert.equal(current.requests.length, before);
        await session.close();
        assert.equal(current.closeCount(), 1);
    }
});

test('metadata erasure does not hide credential material in effective arguments', async () => {
    const current = fixture();
    const session = await connectRemoteClient({
        remoteUrl: REMOTE_URL,
        enforcementBoundary: current.boundary,
    });
    const before = current.requests.length;
    await assert.rejects(
        session.callTool({
            name: 'metadata_echo',
            arguments: { authorization: ['Bearer', 'authority-bearing-value'].join(' ') },
            _meta: { progressToken: OPAQUE_MARKER },
        }),
        (error) => error?.code === 'MCP_CREDENTIAL_MATERIAL_REJECTED',
    );
    assert.equal(current.requests.length, before);
    await session.close();
    assert.equal(current.closeCount(), 1);
});

test('standalone metadata sanitizer preserves the raw shape boundary', () => {
    const inherited = Object.create({ inherited: true });
    const accessorMetadata = {};
    Object.defineProperty(accessorMetadata, 'hidden', { get: () => OPAQUE_MARKER });
    assert.throws(() => stripOpaqueMcpMetadata(inherited, 'params'), /plain object/);
    assert.throws(
        () => stripOpaqueMcpMetadata({ _meta: accessorMetadata }, 'params'),
        /hidden or accessor-backed/,
    );
});
