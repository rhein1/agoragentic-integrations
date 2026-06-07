#!/usr/bin/env node
/**
 * Agoragentic x ElizaOS — Runnable Example
 *
 * Demonstrates the full marketplace cycle inside an ElizaOS character:
 *   1. Register on Agoragentic (or reuse existing key)
 *   2. Match providers for a task
 *   3. Execute routed work
 *   4. Retrieve receipt
 *
 * Usage:
 *   node elizaos/elizaos-example.js
 *   AGORAGENTIC_API_KEY=amk_... node elizaos/elizaos-example.js
 *
 * This is a standalone script. It does not require a running ElizaOS server.
 * It shows how the plugin actions work so you can copy them into your character.
 */

const BASE = process.env.AGORAGENTIC_BASE_URL || "https://agoragentic.com";

async function api(method, path, body, apiKey) {
  const headers = { "Content-Type": "application/json" };
  if (apiKey) headers.Authorization = `Bearer ${apiKey}`;

  const options = { method, headers };
  if (body) options.body = JSON.stringify(body);

  const response = await fetch(`${BASE}${path}`, options);
  const payload = await response.json();

  if (!response.ok) {
    const message = payload.error || payload.message || response.statusText;
    throw new Error(`${response.status} ${method} ${path}: ${message}`);
  }

  return payload;
}

async function register() {
  console.log("\n=== Step 1: Register ===");

  if (process.env.AGORAGENTIC_API_KEY) {
    console.log("  Using existing API key from env");
    return process.env.AGORAGENTIC_API_KEY;
  }

  console.log("  Registering new agent...");
  const result = await api("POST", "/api/quickstart", {
    name: `elizaos-demo-${Date.now()}`
  });

  console.log(`  Registered: ${result.agent?.name || "agent"}`);
  console.log(`  API Key: ${result.api_key}`);
  return result.api_key;
}

async function match(apiKey, task) {
  console.log("\n=== Step 2: Match Providers ===");
  console.log(`  Task: "${task}"`);

  const result = await api(
    "GET",
    `/api/execute/match?task=${encodeURIComponent(task)}&max_cost=1.00`,
    null,
    apiKey
  );

  const providers = result.matches || result.providers || [];
  console.log(`  Found ${providers.length} matching provider(s):`);

  for (const provider of providers.slice(0, 5)) {
    const price = provider.price_per_unit || provider.price || "?";
    const trust = provider.sandbox_status || provider.trust || "?";
    console.log(`    - ${provider.name || provider.id} | $${price} USDC | trust: ${trust}`);
  }

  return providers;
}

async function execute(apiKey, task, input) {
  console.log("\n=== Step 3: Execute ===");
  console.log(`  Task: "${task}"`);

  const result = await api("POST", "/api/execute", {
    task,
    input,
    constraints: { max_cost: 1.0 }
  }, apiKey);

  console.log("  Execution complete");
  console.log(`  Latency: ${result.latency_ms || "?"}ms`);
  console.log(`  Cost: $${result.cost || result.price || "0.00"} USDC`);
  console.log(`  Invocation ID: ${result.invocation_id || "?"}`);

  if (result.result) {
    const preview = JSON.stringify(result.result).slice(0, 200);
    console.log(`  Result: ${preview}${preview.length >= 200 ? "..." : ""}`);
  }

  return result;
}

async function receipt(apiKey, invocationId) {
  console.log("\n=== Step 4: Retrieve Receipt ===");

  if (!invocationId) {
    console.log("  No invocation ID; skipping receipt lookup");
    return null;
  }

  try {
    const result = await api("GET", `/api/execute/status/${invocationId}`, null, apiKey);
    console.log(`  Status: ${result.status || "?"}`);
    console.log(`  Amount: $${result.cost || result.amount || "?"} USDC`);
    console.log(`  Settled: ${result.settled_at || result.created_at || "?"}`);
    if (result.receipt_id) console.log(`  Receipt ID: ${result.receipt_id}`);
    return result;
  } catch (error) {
    console.log(`  Receipt lookup failed: ${error.message}`);
    return null;
  }
}

async function main() {
  console.log("Agoragentic x ElizaOS — Match -> Execute -> Receipt");

  const apiKey = await register();
  const task = "echo";
  const input = { message: "hello from elizaos" };

  await match(apiKey, task);
  const result = await execute(apiKey, task, input);
  await receipt(apiKey, result.invocation_id);

  console.log("\nDone.");
}

main().catch((error) => {
  console.error("\nError:", error.message);
  process.exit(1);
});
