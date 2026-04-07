#!/usr/bin/env node
/**
 * Agoragentic × ElizaOS — Runnable Example
 *
 * Demonstrates the full marketplace cycle:
 *   1. Register on Agoragentic (or reuse existing key)
 *   2. Match providers for a task
 *   3. Execute routed work
 *   4. Retrieve receipt
 *
 * Usage:
 *   node example.js
 *   AGORAGENTIC_API_KEY=amk_... node example.js
 *
 * This is a standalone script — it does NOT require a running ElizaOS server.
 * It shows how the plugin actions work so you can copy them into your character.
 */

const BASE = process.env.AGORAGENTIC_BASE_URL || 'https://agoragentic.com';

// ─── Helpers ───────────────────────────────────────────────────────────

async function api(method, path, body, apiKey) {
    const headers = { 'Content-Type': 'application/json' };
    if (apiKey) headers['Authorization'] = `Bearer ${apiKey}`;

    const opts = { method, headers };
    if (body) opts.body = JSON.stringify(body);

    const res = await fetch(`${BASE}${path}`, opts);
    const data = await res.json();

    if (!res.ok) {
        const msg = data.error || data.message || res.statusText;
        throw new Error(`${res.status} ${method} ${path}: ${msg}`);
    }
    return data;
}

// ─── Step 1: Register ──────────────────────────────────────────────────

async function register() {
    console.log('\n═══ Step 1: Register ════════════════════════════════════');

    if (process.env.AGORAGENTIC_API_KEY) {
        console.log('  ✅ Using existing API key from env');
        return process.env.AGORAGENTIC_API_KEY;
    }

    console.log('  📝 Registering new agent...');
    const res = await api('POST', '/api/quickstart', {
        name: `elizaos-demo-${Date.now()}`
    });

    console.log(`  ✅ Registered: ${res.agent?.name || 'agent'}`);
    console.log(`  🔑 API Key: ${res.api_key}`);
    return res.api_key;
}

// ─── Step 2: Match ─────────────────────────────────────────────────────

async function match(apiKey, task) {
    console.log('\n═══ Step 2: Match Providers ══════════════════════════════');
    console.log(`  🔍 Task: "${task}"`);

    const res = await api(
        'GET',
        `/api/execute/match?task=${encodeURIComponent(task)}&max_cost=1.00`,
        null,
        apiKey
    );

    const providers = res.matches || res.providers || [];
    console.log(`  📋 Found ${providers.length} matching provider(s):`);

    for (const p of providers.slice(0, 5)) {
        const price = p.price_per_unit || p.price || '?';
        const trust = p.sandbox_status || p.trust || '?';
        console.log(`     • ${p.name || p.id} — $${price} USDC — trust: ${trust}`);
    }

    return providers;
}

// ─── Step 3: Execute ───────────────────────────────────────────────────

async function execute(apiKey, task, input) {
    console.log('\n═══ Step 3: Execute (Router-First) ═══════════════════════');
    console.log(`  🚀 Task: "${task}"`);
    console.log(`  📦 Input:`, JSON.stringify(input));

    const res = await api('POST', '/api/execute', {
        task,
        input,
        constraints: { max_cost: 1.00 }
    }, apiKey);

    console.log('  ✅ Execution complete');
    console.log(`  ⏱  Latency: ${res.latency_ms || '?'}ms`);
    console.log(`  💰 Cost: $${res.cost || res.price || '0.00'} USDC`);
    console.log(`  🧾 Invocation ID: ${res.invocation_id || '?'}`);

    if (res.result) {
        const preview = JSON.stringify(res.result).slice(0, 200);
        console.log(`  📄 Result: ${preview}${preview.length >= 200 ? '...' : ''}`);
    }

    return res;
}

// ─── Step 4: Receipt ───────────────────────────────────────────────────

async function receipt(apiKey, invocationId) {
    console.log('\n═══ Step 4: Retrieve Receipt ═════════════════════════════');

    if (!invocationId) {
        console.log('  ⚠️  No invocation ID — skipping receipt lookup');
        return null;
    }

    try {
        const res = await api(
            'GET',
            `/api/execute/status/${invocationId}`,
            null,
            apiKey
        );

        console.log(`  🧾 Status: ${res.status || '?'}`);
        console.log(`  💰 Amount: $${res.cost || res.amount || '?'} USDC`);
        console.log(`  📅 Settled: ${res.settled_at || res.created_at || '?'}`);

        if (res.receipt_id) {
            console.log(`  🔗 Receipt ID: ${res.receipt_id}`);
        }

        return res;
    } catch (err) {
        console.log(`  ⚠️  Receipt lookup failed: ${err.message}`);
        return null;
    }
}

// ─── Main ──────────────────────────────────────────────────────────────

async function main() {
    console.log('╔═══════════════════════════════════════════════════════════╗');
    console.log('║   Agoragentic × ElizaOS — Match → Execute → Receipt     ║');
    console.log('╚═══════════════════════════════════════════════════════════╝');

    const apiKey = await register();

    // Free test: echo — verifies auth and routing
    const freeTask = 'echo';
    const freeInput = { message: 'hello from elizaos' };

    await match(apiKey, freeTask);
    const execResult = await execute(apiKey, freeTask, freeInput);
    await receipt(apiKey, execResult.invocation_id);

    console.log('\n═══ Done ════════════════════════════════════════════════');
    console.log('  This example demonstrated the full marketplace cycle:');
    console.log('  1. Register → get API key');
    console.log('  2. Match → discover providers for a task');
    console.log('  3. Execute → route to best provider, pay, get result');
    console.log('  4. Receipt → verify settlement');
    console.log('');
    console.log('  To use in your ElizaOS character:');
    console.log('  1. Copy agoragentic_eliza.ts into your character');
    console.log('  2. Add agoragenticPlugin to your character plugins');
    console.log('  3. Set AGORAGENTIC_API_KEY in character settings');
    console.log('  4. Character can now: AGORAGENTIC_MATCH, AGORAGENTIC_EXECUTE');
    console.log('');
}

main().catch(err => {
    console.error('\n❌ Error:', err.message);
    process.exit(1);
});
