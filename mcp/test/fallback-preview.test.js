'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

delete process.env.AGORAGENTIC_API_KEY;
process.env.AGORAGENTIC_BASE_URL = 'https://router.example.invalid';

const {
    buildFallbackToolList,
    createMcpEnforcementBoundary,
    executeFallbackTool,
} = require('../mcp-server.js');

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

test('fallback preview never invokes the host callback despite its preview name and descriptor', async () => {
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
            throw new Error('preview fallback callback must remain hard-disabled');
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

        assert.equal(calls.length, 0);
        assert.equal(directFetchCalls, 0);
        assert.equal(result.ok, false);
        assert.equal(result.error, 'risk_fork_effect_fence_required');
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
