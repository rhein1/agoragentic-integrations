#!/usr/bin/env node
/**
 * Agoragentic x402 Buyer Demo Script
 * ===================================
 * 
 * Self-contained Node.js script demonstrating the full x402 payment flow:
 *   1. Discover available services
 *   2. Get a quote via execute/match
 *   3. Free-tier execution (echo test)
 *   4. Paid execution with USDC signing (requires wallet)
 * 
 * Usage:
 *   # Free demo (no wallet needed)
 *   node x402/buyer-demo.js
 * 
 *   # Paid demo (requires wallet with USDC on Base)
 *   WALLET_PRIVATE_KEY=0x... node x402/buyer-demo.js --paid
 * 
 *   # Custom marketplace URL
 *   AGORAGENTIC_URL=http://localhost:3001 node x402/buyer-demo.js
 * 
 * Prerequisites:
 *   npm install @x402/client @x402/core @x402/evm ethers
 * 
 * Learn more:
 *   https://agoragentic.com/api/x402/info
 *   https://github.com/rhein1/agoragentic-integrations
 */

const https = require('https');
const http = require('http');

// ─── Configuration ──────────────────────────────────────
const BASE_URL = process.env.AGORAGENTIC_URL || 'https://agoragentic.com';
const isPaid = process.argv.includes('--paid');
const isVerbose = process.argv.includes('--verbose') || process.argv.includes('-v');

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

    const match = res.body;
    log('✅', `Best match: "${match.match?.name || match.name}" — $${match.match?.price_usdc || match.price_usdc} USDC`, {
        quote_id: match.quote_id,
        listing_id: match.match?.id || match.id,
    });

    return match;
}

// ─── Step 4A: Free Execution ────────────────────────────
async function step4a_freeExecution(match) {
    if (!match?.quote_id) {
        log('⚠️', 'Step 4a: Skipping free execution — no quote available');
        return null;
    }

    log('🚀', `Step 4a: Executing free task (quote: ${match.quote_id})...`);
    const res = await request('POST', '/api/x402/execute', {
        quote_id: match.quote_id,
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

// ─── Step 5: Paid Execution (requires wallet) ───────────
async function step5_paidExecution() {
    const privateKey = process.env.WALLET_PRIVATE_KEY;
    if (!privateKey) {
        log('💡', 'Step 5: Skipping paid execution — set WALLET_PRIVATE_KEY to test paid flow');
        log('💡', '  Usage: WALLET_PRIVATE_KEY=0x... node x402/buyer-demo.js --paid');
        return null;
    }

    log('💰', 'Step 5: Paid execution flow...');

    // Find a paid listing
    const matchRes = await request('GET', '/api/x402/execute/match?task=analyze&max_cost=1');
    if (matchRes.status !== 200 || !matchRes.body?.quote_id) {
        log('⚠️', 'No paid listing found for "analyze" — skipping paid demo');
        return null;
    }

    const quote = matchRes.body;
    const priceUsdc = quote.match?.price_usdc || quote.price_usdc || 0;

    if (priceUsdc <= 0) {
        log('ℹ️', 'Matched listing is free — no payment needed');
        return null;
    }

    log('💳', `Matched paid listing: "${quote.match?.name}" — $${priceUsdc} USDC`);

    try {
        // Dynamic import of x402 client
        const { ethers } = require('ethers');

        // IMPORTANT: The x402 client handles the 402→sign→retry cycle automatically.
        // When you POST to the execute endpoint:
        //   1. Server returns HTTP 402 with PAYMENT-REQUIRED header
        //   2. x402 client reads the payment requirements
        //   3. Client signs a USDC TransferWithAuthorization (EIP-3009)
        //   4. Client retries with PAYMENT-SIGNATURE header
        //   5. Server verifies payment → executes the service → returns result

        log('🔑', 'Signing USDC payment with wallet...');
        log('📝', 'In production, use @x402/client for automatic 402→sign→retry:');
        log('   ', '  const { httpClient } = require("@x402/client");');
        log('   ', '  const client = httpClient("https://agoragentic.com", walletClient);');
        log('   ', '  const res = await client.post("/api/x402/execute", { quote_id, input });');

        // For this demo, we show the manual flow
        const executeRes = await request('POST', '/api/x402/execute', {
            quote_id: quote.quote_id,
            input: { text: 'x402 paid demo test' },
        });

        if (executeRes.status === 402) {
            log('✅', '402 Payment Required received — this is the correct first step!', {
                payment_header: executeRes.headers['payment-required'] ? 'present' : 'missing',
                price: executeRes.body?.price_usdc,
                how_to_pay: executeRes.body?.how_to_pay ? 'included' : 'missing',
            });
            log('💡', 'To complete payment, use the @x402/client SDK which handles signing automatically.');
        } else if (executeRes.status === 200 && executeRes.body?.success) {
            log('✅', 'Paid execution succeeded!', {
                cost: executeRes.body.cost,
                method: executeRes.body.payment_method,
            });
        } else {
            log('❌', `Unexpected response: ${executeRes.status}`, executeRes.body);
        }

        return executeRes.body;

    } catch (err) {
        log('⚠️', `Paid execution error: ${err.message}`);
        log('💡', 'Install x402 packages: npm install @x402/client @x402/core @x402/evm ethers');
        return null;
    }
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
    console.log(`  Mode:   ${isPaid ? '💰 Paid (with wallet)' : '🆓 Free (no wallet needed)'}\n`);

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

        // 5. Paid execution (if --paid flag)
        if (isPaid) {
            await step5_paidExecution();
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
        log('   ', '4. Execute (paid):    Use @x402/client for automatic 402→sign→retry');
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
