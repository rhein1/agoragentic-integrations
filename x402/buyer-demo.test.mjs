import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import test from 'node:test';

const require = createRequire(import.meta.url);

function quoteEnvelope({ quoteId, paymentRequired, priceUsdc }) {
    return {
        quote: {
            quote_id: quoteId,
            quoted_price_usdc: priceUsdc,
            payment_required: paymentRequired,
            next_step: {
                method: 'POST',
                url: '/api/x402/execute',
                body: { quote_id: quoteId, input: {} },
            },
        },
        selected_provider: { id: 'fixture-provider', name: 'Fixture Provider' },
    };
}

test('direct x402 demo stays route-first, no-network, and no-spend under fixtures', async (t) => {
    const http = require('node:http');
    const https = require('node:https');
    const originalHttpRequest = http.request;
    const originalHttpsRequest = https.request;
    let networkAttempts = 0;
    const rejectNetwork = () => {
        networkAttempts += 1;
        throw new Error('network access is forbidden in the hermetic x402 test');
    };
    http.request = rejectNetwork;
    https.request = rejectNetwork;
    t.after(() => {
        http.request = originalHttpRequest;
        https.request = originalHttpsRequest;
    });

    const demoPath = require.resolve('./buyer-demo.js');
    delete require.cache[demoPath];
    const { DIRECT_X402_FLOW, runDemo } = require(demoPath);
    const calls = [];

    const requestFn = async (method, path, body = null) => {
        calls.push({ method, path, body });
        if (method === 'GET' && path === '/api/x402/info') {
            return { status: 200, headers: {}, body: { name: 'Fixture Gateway', protocol: 'x402' } };
        }
        if (method === 'GET' && path === '/api/x402/listings') {
            return { status: 200, headers: {}, body: { listings: [] } };
        }
        if (method === 'GET' && path === '/api/x402/execute/match?task=echo&max_cost=0') {
            return { status: 200, headers: {}, body: quoteEnvelope({ quoteId: 'quote-free', paymentRequired: false, priceUsdc: 0 }) };
        }
        if (method === 'GET' && path === '/api/x402/execute/match?task=analyze&max_cost=1') {
            return { status: 200, headers: {}, body: quoteEnvelope({ quoteId: 'quote-paid', paymentRequired: true, priceUsdc: 0.05 }) };
        }
        if (method === 'POST' && path === '/api/x402/test/echo') {
            return { status: 200, headers: {}, body: { method: 'echo', echoed: body } };
        }
        if (method === 'POST' && path === '/api/x402/execute' && body?.quote_id === 'quote-free') {
            return { status: 200, headers: {}, body: { success: true, cost: 0, invocation_id: 'invocation-fixture' } };
        }
        if (method === 'POST' && path === '/api/x402/execute' && body?.quote_id === 'quote-paid') {
            return {
                status: 402,
                headers: { 'payment-required': 'fixture-challenge' },
                body: { error: 'payment_required', price_usdc: 0.05 },
            };
        }
        if (method === 'GET' && path === '/api/x402/invocations/invocation-fixture/proof') {
            return { status: 200, headers: {}, body: { decision_hash: 'fixture-hash', on_chain: { status: 'pending_submission' } } };
        }
        throw new Error(`unexpected fixture request: ${method} ${path}`);
    };

    const result = await runDemo({
        baseUrl: 'https://fixture.invalid',
        lineBreakFn: () => {},
        logFn: () => {},
        nowFn: () => '2026-01-01T00:00:00.000Z',
        paidPreflight: true,
        requestFn,
    });

    assert.deepEqual(DIRECT_X402_FLOW, {
        profile: 'direct_x402_route_first',
        matchPath: '/api/x402/execute/match',
        executePath: '/api/x402/execute',
    });
    assert.equal(result.execution.invocation_id, 'invocation-fixture');
    assert.equal(result.paidPreflight.error, 'payment_required');
    assert.equal(networkAttempts, 0);
    assert.equal(calls.some((call) => call.path === '/api/execute'), false);
    assert.equal(calls.some((call) => /\/api\/x402\/invoke\//.test(call.path)), false);

    const paidPosts = calls.filter((call) => call.method === 'POST' && call.path === '/api/x402/execute' && call.body?.quote_id === 'quote-paid');
    assert.equal(paidPosts.length, 1, 'the paid preflight must stop after the first unsigned 402');

    const serializedCalls = JSON.stringify(calls);
    assert.doesNotMatch(serializedCalls, /provider_id|listing_id|payment-signature|authorization|private[_-]?key|wallet/i);
});
