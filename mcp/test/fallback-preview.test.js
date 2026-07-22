'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

delete process.env.AGORAGENTIC_API_KEY;
process.env.AGORAGENTIC_BASE_URL = 'https://router.example.invalid';

const {
    buildFallbackToolList,
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

test('fallback preview performs one anonymous GET and never invokes or spends', async () => {
    const originalFetch = global.fetch;
    const calls = [];
    global.fetch = async (url, options = {}) => {
        calls.push({ url: String(url), options });
        return {
            ok: true,
            status: 200,
            statusText: 'OK',
            text: async () => JSON.stringify({
                selected_provider: null,
                payment_required: false,
                quote: null,
            }),
        };
    };

    try {
        const result = parseToolContent(await executeFallbackTool('agoragentic_preview_x402', {
            task: 'receipt reconciliation',
            max_cost: 0,
            category: 'audit',
            max_latency_ms: 500,
            prefer_trusted: true,
            payment_network: 'base',
            payment_asset: 'USDC',
        }));

        assert.equal(calls.length, 1);
        const call = calls[0];
        const url = new URL(call.url);
        assert.equal(call.options.method, 'GET');
        assert.equal(call.options.body, undefined);
        assert.equal(call.options.headers.Authorization, undefined);
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
        assert.equal(result.payment_required, false);
    } finally {
        global.fetch = originalFetch;
    }
});
