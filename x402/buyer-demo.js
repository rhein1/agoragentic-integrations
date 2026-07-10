#!/usr/bin/env node
/**
 * Agoragentic x402 Buyer Demo Script
 * ===================================
 * 
 * Self-contained Node.js script demonstrating x402 discovery and preflight:
 *   1. Discover available services
 *   2. Get a quote via execute/match
 *   3. Free-tier execution (echo test)
 *   4. Optional paid-route preflight that stops at the 402 challenge
 * 
 * Usage:
 *   # Free demo (no wallet needed)
 *   node x402/buyer-demo.js
 * 
 *   # Paid-route preflight (never reads a key, signs, retries, or spends)
 *   node x402/buyer-demo.js --paid-preflight
 * 
 *   # Custom marketplace URL
 *   AGORAGENTIC_URL=http://localhost:3001 node x402/buyer-demo.js
 * 
 * Prerequisite: Node.js 18+
 * 
 * Learn more:
 *   https://agoragentic.com/api/x402/info
 *   https://github.com/rhein1/agoragentic-integrations
 */

const https = require('https');
const http = require('http');

// ─── Configuration ──────────────────────────────────────
const BASE_URL = process.env.AGORAGENTIC_URL || 'https://agoragentic.com';
const isPaidPreflight = process.argv.includes('--paid-preflight');
const isVerbose = process.argv.includes('--verbose') || process.argv.includes('-v');

if (process.argv.includes('--paid')) {
    console.error('The old --paid mode never signed a payment. Use --paid-preflight for an honest no-spend 402 challenge check.');
    process.exit(2);
}

// ─── Helpers ────────────────────────────────────────────
function log(emoji, message, data = null) {
    console.log(`${emoji}  ${message}`);
    if (data && isVerbose) {
        console.log('   ', JSON.stringify(data, null, 2).split('\n').join('\n    '));
    }
}

function request(method, path, body = null) {
    return new Promise((resolve, reject) => {
        const url = new URL(path, BASE_URL);
        const isSecure = url.protocol === 'https:';
        const transport = isSecure ? https : http;

        const options = {
            hostname: url.hostname,
            port: url.port || (isSecure ? 443 : 80),
            path: url.pathname + url.search,
            method,
            headers: {
                'User-Agent': 'Agoragentic-x402-Demo/1.0',
                'Accept': 'application/json',
            },
        };

        if (body) {
            const payload = JSON.stringify(body);
            options.headers['Content-Type'] = 'application/json';
            options.headers['Content-Length'] = Buffer.byteLength(payload);
        }

        const req = transport.request(options, (res) => {
            const chunks = [];
            res.on('data', (chunk) => chunks.push(chunk));
            res.on('end', () => {
                const raw = Buffer.concat(chunks).toString();
                let json = null;
                try { json = JSON.parse(raw); } catch { }
                resolve({
                    status: res.statusCode,
                    headers: res.headers,
                    body: json || raw,
                });
            });
        });

        req.on('error', reject);
        req.setTimeout(30000, () => {
            req.destroy(new Error('Request timeout'));
        });

        if (body) {
            req.write(JSON.stringify(body));
        }
        req.end();
    });
}

// ─── Canonical match envelope ───────────────────────────
// GET /api/x402/execute/match returns:
//   body.quote.payment_required   ← authoritative free-vs-paid boolean
//   body.quote.quoted_price_usdc  ← price (number, USDC)
//   body.quote.quote_id, body.quote.next_step { method, url, body }
//   body.selected_provider        ← provider object (null when no match)
// Free-vs-paid is decided ONLY by payment_required === false. A missing
// boolean, missing price, or unrecognized envelope fails closed. next_step.url
// is honored only when URL resolution keeps it on the configured origin.
function sameOriginExecutePath(candidate) {
    const fallback = '/api/x402/execute';
    if (typeof candidate !== 'string' || candidate.length === 0) {
        return fallback;
    }
    try {
        const baseUrl = new URL(BASE_URL);
        const resolved = new URL(candidate, baseUrl);
        if (resolved.origin !== baseUrl.origin) {
            return fallback;
        }
        return `${resolved.pathname}${resolved.search}`;
    } catch {
        return fallback;
    }
}

function parseMatchEnvelope(body) {
    if (!body || typeof body !== 'object') {
        throw new Error('Match response is not a JSON object; refusing to guess payment terms');
    }
    if (!('quote' in body)) {
        throw new Error('Unrecognized match envelope: missing "quote" field; refusing to treat the route as free');
    }
    if (body.quote === null) {
        return null;
    }
    const quote = body.quote;
    if (typeof quote !== 'object') {
        throw new Error('Unrecognized match envelope: "quote" is not an object; refusing to treat the route as free');
    }
    if (typeof quote.payment_required !== 'boolean') {
        throw new Error('Quote is missing the boolean "quote.payment_required"; refusing to assume the route is free');
    }
    if (typeof quote.quoted_price_usdc !== 'number' || !Number.isFinite(quote.quoted_price_usdc) || quote.quoted_price_usdc < 0) {
        throw new Error('Quote is missing a finite "quote.quoted_price_usdc"; refusing to assume the route is free');
    }
    if (typeof quote.quote_id !== 'string' || quote.quote_id.length === 0) {
        throw new Error('Quote is missing "quote.quote_id"');
    }
    const executePath = sameOriginExecutePath(quote.next_step?.url);
    return {
        quoteId: quote.quote_id,
        paymentRequired: quote.payment_required,
        priceUsdc: quote.quoted_price_usdc,
        executePath,
        provider: body.selected_provider || null,
    };
}

// ─── Step 1: Gateway Info ───────────────────────────────
async function step1_gatewayInfo() {
    log('ℹ️', 'Step 1: Checking x402 gateway info...');
    const res = await request('GET', '/api/x402/info');

    if (res.status !== 200) {
        throw new Error(`Gateway info failed: ${res.status}`);
    }

    log('✅', `Gateway: ${res.body.name || 'Agoragentic x402'}`, {
        protocol: res.body.protocol || 'x402',
        network: res.body.network,
        currency: res.body.currency,
    });

    return res.body;
}

// ─── Step 2: Browse Catalog ─────────────────────────────
async function step2_browseCatalog() {
    log('🔍', 'Step 2: Browsing x402 service catalog...');
    const res = await request('GET', '/api/x402/listings');

    if (res.status !== 200) {
        throw new Error(`Catalog fetch failed: ${res.status}`);
    }

    const listings = res.body.listings || res.body.capabilities || [];
    log('📋', `Found ${listings.length} available services`);

    // Show top 5
    const top5 = listings.slice(0, 5);
    for (const listing of top5) {
        const price = parseFloat(listing.price_usdc || listing.price_per_unit || 0);
        const label = price <= 0 ? 'FREE' : `$${price.toFixed(4)} USDC`;
        log('   ', `• ${listing.name} — ${label} (${listing.category || 'general'})`);
    }

    return listings;
}

// ─── Step 3: Match a Service ────────────────────────────
async function step3_executeMatch(task = 'echo') {
    log('🎯', `Step 3: Finding best match for "${task}"...`);
    const res = await request('GET', `/api/x402/execute/match?task=${encodeURIComponent(task)}&max_cost=0`);

    if (res.status !== 200) {
        log('⚠️', `No match found for "${task}" — this is normal if no free listings match`);
        return null;
    }

    const match = parseMatchEnvelope(res.body);
    if (!match) {
        log('⚠️', `No provider matched "${task}" — this is normal if no free listings match`);
        return null;
    }

    log('✅', `Best match: "${match.provider?.name || 'unnamed provider'}" — $${match.priceUsdc} USDC (${match.paymentRequired ? 'paid' : 'free'})`, {
        quote_id: match.quoteId,
        listing_id: match.provider?.id,
    });

    return match;
}

// ─── Step 4A: Free Execution ────────────────────────────
async function step4a_freeExecution(match) {
    if (!match) {
        log('⚠️', 'Step 4a: Skipping free execution — no quote available');
        return null;
    }
    if (match.paymentRequired !== false) {
        log('⚠️', 'Step 4a: Skipping free execution — the matched quote requires payment');
        return null;
    }

    log('🚀', `Step 4a: Executing free task (quote: ${match.quoteId})...`);
    const res = await request('POST', match.executePath, {
        quote_id: match.quoteId,
        input: {
            text: 'Hello from the x402 buyer demo! This is a test invocation.',
            timestamp: new Date().toISOString(),
        },
    });

    if (res.status === 200 && res.body.success) {
        log('✅', 'Free execution succeeded!', {
            method: res.body.payment_method,
            cost: res.body.cost,
            invocation_id: res.body.invocation_id,
            result: typeof res.body.result === 'object'
                ? JSON.stringify(res.body.result).slice(0, 200)
                : String(res.body.result || '').slice(0, 200),
        });
    } else {
        log('❌', `Free execution failed: ${res.body?.error || res.status}`, res.body);
    }

    return res.body;
}

// ─── Step 4B: Test Echo ─────────────────────────────────
async function step4b_testEcho() {
    log('🔊', 'Step 4b: Testing x402 echo endpoint (free pipeline validation)...');
    const res = await request('POST', '/api/x402/test/echo', {
        message: 'Hello from x402 buyer demo!',
        timestamp: new Date().toISOString(),
    });

    if (res.status === 200) {
        log('✅', 'Echo test passed!', {
            method: res.body.method || 'echo',
            echoed: typeof res.body.echoed === 'object'
                ? JSON.stringify(res.body.echoed).slice(0, 200)
                : String(res.body.result || res.body.echoed || '').slice(0, 200),
        });
    } else {
        log('⚠️', `Echo test returned ${res.status}`, res.body);
    }

    return res.body;
}

// ─── Step 5: Paid-route preflight (no signing or spend) ─
async function step5_paidPreflight() {
    log('🧾', 'Step 5: Paid-route preflight (stops before signing)...');

    // Find a paid listing
    const matchRes = await request('GET', '/api/x402/execute/match?task=analyze&max_cost=1');
    if (matchRes.status !== 200) {
        log('⚠️', 'No paid listing found for "analyze" — skipping paid demo');
        return null;
    }

    const match = parseMatchEnvelope(matchRes.body);
    if (!match) {
        log('⚠️', 'No provider matched "analyze" — skipping paid demo');
        return null;
    }

    if (match.paymentRequired === false) {
        log('ℹ️', 'Matched listing is free (payment_required=false) — no payment needed');
        return null;
    }

    log('💳', `Matched paid listing: "${match.provider?.name || 'unnamed provider'}" — $${match.priceUsdc} USDC (payment_required=true)`);

    const executeRes = await request('POST', match.executePath, {
        quote_id: match.quoteId,
        input: { text: 'x402 paid-route preflight test' },
    });

    if (executeRes.status === 402) {
        const challenge = executeRes.headers['payment-required'];
        if (!challenge) {
            throw new Error('Received HTTP 402 without PAYMENT-REQUIRED; refusing to report a successful paid-route preflight');
        }
        log('✅', '402 Payment Required received (challenge header present); preflight stops here without signing or retrying.', {
            price: executeRes.body?.price_usdc,
            how_to_pay: executeRes.body?.how_to_pay ? 'included' : 'missing',
        });
    } else if (executeRes.status === 200 && executeRes.body?.success) {
        log('ℹ️', 'The matched route completed without a paid challenge; no payment was signed.');
    } else {
        log('⚠️', `Unexpected preflight response: ${executeRes.status}`, executeRes.body);
    }

    return executeRes.body;
}

// ─── Step 6: Verify Invocation Proof ────────────────────
async function step6_verifyProof(invocationId) {
    if (!invocationId) {
        log('ℹ️', 'Step 6: Skipping proof verification — no invocation ID');
        return null;
    }

    log('🔗', `Step 6: Checking on-chain invocation proof for ${invocationId}...`);
    const res = await request('GET', `/api/x402/invocations/${invocationId}/proof`);

    if (res.status === 200) {
        log('✅', 'Invocation proof:', {
            decision_hash: res.body.decision_hash,
            on_chain_status: res.body.on_chain?.status || 'pending',
            chain: res.body.on_chain?.chain || 'eip155:8453',
        });
    } else {
        log('⚠️', `Proof check returned ${res.status}`, res.body);
    }

    return res.body;
}

// ─── Main ───────────────────────────────────────────────
async function main() {
    console.log('\n╔══════════════════════════════════════════════════╗');
    console.log('║     Agoragentic x402 Buyer Demo                 ║');
    console.log('║     Agent-to-Agent Commerce on Base L2           ║');
    console.log('╚══════════════════════════════════════════════════╝\n');
    console.log(`  Target: ${BASE_URL}`);
    console.log(`  Mode:   ${isPaidPreflight ? '🧾 Paid-route preflight (no signing)' : '🆓 Free (no wallet needed)'}\n`);

    try {
        // 1. Gateway info
        await step1_gatewayInfo();
        console.log();

        // 2. Browse catalog
        const listings = await step2_browseCatalog();
        console.log();

        // 3. Match a service
        const match = await step3_executeMatch('echo');
        console.log();

        // 4a. Test echo
        await step4b_testEcho();
        console.log();

        // 4b. Free execution
        const execResult = await step4a_freeExecution(match);
        console.log();

        // 5. Paid-route preflight (if explicitly requested)
        if (isPaidPreflight) {
            await step5_paidPreflight();
            console.log();
        }

        // 6. Verify proof (if we got an invocation)
        const invocationId = execResult?.invocation_id;
        if (invocationId) {
            await step6_verifyProof(invocationId);
            console.log();
        }

        // ─── Summary ────────────────────────────────────
        console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n');
        log('🎉', 'Demo complete!');
        console.log();
        log('📖', 'Next steps:');
        log('   ', '1. Browse services:   GET  /api/x402/listings');
        log('   ', '2. Match a service:   GET  /api/x402/execute/match?task=<query>');
        log('   ', '3. Execute (free):    POST /api/x402/execute { quote_id, input }');
        log('   ', '4. Paid preflight:    Run --paid-preflight; it stops at 402 without signing');
        log('   ', '5. Verify proof:      GET  /api/x402/invocations/:id/proof');
        console.log();
        log('🔗', `API Reference: ${BASE_URL}/api/x402/info`);
        log('📦', 'SDK: npm install agoragentic');
        log('🐙', 'GitHub: https://github.com/rhein1/agoragentic-integrations');
        console.log();

    } catch (err) {
        log('❌', `Demo failed: ${err.message}`);
        if (isVerbose) console.error(err);
        process.exit(1);
    }
}

main();
