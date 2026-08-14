'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

delete process.env.AGORAGENTIC_API_KEY;
process.env.AGORAGENTIC_BASE_URL = 'https://router.example.invalid';

const {
    MCP_ENFORCEMENT_SCHEMAS,
    buildFallbackToolList,
    computeMcpCleanImportEvidenceHash,
    createMcpEnforcementBoundary,
    executeFallbackTool,
} = require('../mcp-server.js');

function cleanImported(request, result) {
    const evidenceRef = `fallback-test:${request.request_id}`;
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

function parseToolContent(result) {
    assert.equal(result.content.length, 1);
    assert.equal(result.content[0].type, 'text');
    return JSON.parse(result.content[0].text);
}

test('fallback tool discovery advertises the keyless x402 preview', () => {
    const tools = buildFallbackToolList();
    const preview = tools.find((tool) => tool.name === 'agoragentic_preview_x402');

    assert.ok(preview);
    assert.deepEqual(preview.inputSchema.required, ['task']);
    assert.match(preview.description, /WITHOUT registration/i);
    assert.match(preview.description, /does not register an agent, execute a provider, move wallet funds, or settle payment/i);
});

test('fallback preview rejects a missing task without any network or tool execution', async () => {
    const originalFetch = global.fetch;
    let fetchCalls = 0;
    global.fetch = async () => {
        fetchCalls += 1;
        throw new Error('network must not be called');
    };

    try {
        const result = parseToolContent(await executeFallbackTool('agoragentic_preview_x402', {}));
        assert.equal(result.ok, false);
        assert.equal(result.error, 'missing_task');
        assert.equal(fetchCalls, 0);
    } finally {
        global.fetch = originalFetch;
    }
});

test('fallback preview delegates one closed anonymous GET descriptor to the factory-created host capability', async () => {
    const originalFetch = global.fetch;
    const calls = [];
    let directFetchCalls = 0;
    global.fetch = async () => {
        directFetchCalls += 1;
        throw new Error('the MCP package must not own fallback network I/O');
    };
    const boundary = createMcpEnforcementBoundary({
        async openSession() {
            throw new Error('remote session must not open');
        },
        async executeFallback(request) {
            calls.push(request);
            return cleanImported(request, {
                selected_provider: null,
                payment_required: false,
                quote: null,
            });
        },
    });

    try {
        const result = parseToolContent(await executeFallbackTool('agoragentic_preview_x402', {
            task: 'receipt reconciliation',
            max_cost: 0,
            category: 'audit',
            max_latency_ms: 500,
            prefer_trusted: true,
            payment_network: 'base',
            payment_asset: 'USDC',
        }, { enforcementBoundary: boundary }));

        assert.equal(calls.length, 1);
        const call = calls[0];
        const url = new URL(call.mcp_server_ref);
        assert.equal(call.fallback_http.method, 'GET');
        assert.equal(call.fallback_http.body, null);
        assert.deepEqual(call.fallback_http.authentication, {
            mode: 'host_resolved_out_of_band',
        });
        assert.equal(url.origin, 'https://router.example.invalid');
        assert.equal(url.pathname, '/api/x402/execute/match');
        assert.equal(url.searchParams.get('task'), 'receipt reconciliation');
        assert.equal(url.searchParams.get('max_cost'), '0');
        assert.equal(url.searchParams.get('category'), 'audit');
        assert.equal(url.searchParams.get('max_latency_ms'), '500');
        assert.equal(url.searchParams.get('prefer_trusted'), 'true');
        assert.equal(url.searchParams.get('payment_network'), 'base');
        assert.equal(url.searchParams.get('payment_asset'), 'USDC');
        assert.doesNotMatch(url.pathname, /\/api\/(?:execute|invoke)(?:\/|$)/);
        assert.equal(call.phase, 'tools/call');
        assert.equal(call.tool_name, 'agoragentic_preview_x402');
        assert.equal(call.risk_profile.minimum_level, 'IRREVERSIBLE');
        assert.equal(call.risk_profile.prepare_only, true);
        assert.equal(call.transport_constraints.redirects, 'error');
        assert.equal(call.transport_constraints.direct_network_permitted, false);
        assert.equal(call.transport_constraints.response_acceptance, 'clean_import_only');
        assert.equal(directFetchCalls, 0);
        assert.equal(result.payment_required, false);
    } finally {
        global.fetch = originalFetch;
    }
});

test('valid fallback preview fails closed with zero I/O when no boundary is installed', async () => {
    const originalFetch = global.fetch;
    let fetchCalls = 0;
    global.fetch = async () => {
        fetchCalls += 1;
        throw new Error('network must remain blocked');
    };
    try {
        const result = await executeFallbackTool('agoragentic_preview_x402', {
            task: 'receipt reconciliation',
            max_cost: 0,
        });
        assert.equal(result.isError, true);
        assert.equal(parseToolContent(result).error, 'risk_fork_enforcement_required');
        assert.equal(fetchCalls, 0);
    } finally {
        global.fetch = originalFetch;
    }
});
