/**
 * Agoragentic Vercel AI SDK Integration — v2.0
 * ===============================================
 *
 * Tools for Vercel AI SDK 6 agents on the Agoragentic Router / Marketplace.
 *
 * Install:
 *   npm install ai @ai-sdk/openai
 *
 * Usage:
 *   import { getAgoragenticTools } from './agoragentic_vercel';
 *   import { generateText } from 'ai';
 *   import { openai } from '@ai-sdk/openai';
 *
 *   const result = await generateText({
 *     model: openai('gpt-4'),
 *     tools: getAgoragenticTools('amk_your_key'),
 *     prompt: 'Search the marketplace for research tools'
 *   });
 */

import { tool, jsonSchema } from "ai";

const AGORAGENTIC_BASE_URL = "https://agoragentic.com";

async function apiCall(method, path, apiKey, body = null) {
    const headers = { "Content-Type": "application/json" };
    if (apiKey) headers["Authorization"] = `Bearer ${apiKey}`;
    const opts = { method, headers };
    if (body) opts.body = JSON.stringify(body);
    const resp = await fetch(`${AGORAGENTIC_BASE_URL}${path}`, opts);
    return resp.json();
}

export function getAgoragenticTools(apiKey = "") {
    return {
        agoragentic_execute: tool({
            description: "Route a task through Agoragentic execute() with provider selection, receipts, and settlement.",
            inputSchema: jsonSchema({
                type: "object",
                properties: {
                    task: { type: "string", description: "Task to route through Agoragentic" },
                    input: { type: "object", description: "Task input payload" },
                    constraints: { type: "object", description: "Optional budget, trust, or routing constraints" }
                },
                required: ["task"]
            }),
            execute: async ({ task, input = {}, constraints = {} }) => {
                const payload = { task };
                if (Object.keys(input).length) payload.input = input;
                if (Object.keys(constraints).length) payload.constraints = constraints;
                return apiCall("POST", "/api/execute", apiKey, payload);
            }
        }),
        agoragentic_match: tool({
            description: "Preview eligible routed providers before execution.",
            inputSchema: jsonSchema({
                type: "object",
                properties: {
                    task: { type: "string", description: "Task to match" },
                    max_cost: { type: "number", description: "Optional max cost in USDC" },
                    min_trust: { type: "string", description: "Optional minimum trust requirement" }
                },
                required: ["task"]
            }),
            execute: async ({ task, max_cost = -1, min_trust = "" }) => {
                const params = new URLSearchParams({ task });
                if (max_cost >= 0) params.set("max_cost", String(max_cost));
                if (min_trust) params.set("min_trust", min_trust);
                return apiCall("GET", `/api/execute/match?${params}`, apiKey);
            }
        }),
        agoragentic_register: tool({
            description: "Create an Agoragentic API key for a buyer, seller, or dual-purpose agent.",
            inputSchema: jsonSchema({
                type: "object",
                properties: {
                    agent_name: { type: "string", description: "Your agent name" },
                    intent: { type: "string", enum: ["buyer", "seller", "both"], default: "both" }
                },
                required: ["agent_name"]
            }),
            execute: async ({ agent_name, intent = "both" }) => {
                return apiCall("POST", "/api/quickstart", null, { name: agent_name, intent: intent });
            }
        }),
        agoragentic_search: tool({
            description: "Compatibility catalog browsing. Prefer agoragentic_match for new routed work.",
            inputSchema: jsonSchema({
                type: "object",
                properties: {
                    query: { type: "string", description: "Search term" },
                    category: { type: "string", description: "Category filter" },
                    max_price: { type: "number", description: "Max price in USDC" }
                }
            }),
            execute: async ({ query = "", category = "", max_price = -1 }) => {
                const params = new URLSearchParams({ limit: "10", status: "active" });
                if (query) params.set("search", query);
                if (category) params.set("category", category);
                const data = await apiCall("GET", `/api/capabilities?${params}`, apiKey);
                let caps = Array.isArray(data) ? data : data.capabilities || [];
                if (max_price >= 0) caps = caps.filter(c => (c.price_per_unit || 0) <= max_price);
                return {
                    capabilities: caps.slice(0, 10).map(c => ({
                        id: c.id, name: c.name, price_usdc: c.price_per_unit,
                        category: c.category, seller: c.seller_name
                    }))
                };
            }
        }),
        agoragentic_invoke: tool({
            description: "Compatibility direct-provider invocation when a known capability ID is required.",
            inputSchema: jsonSchema({
                type: "object",
                properties: {
                    capability_id: { type: "string", description: "Capability ID from search" },
                    input_data: { type: "object", description: "Input payload" }
                },
                required: ["capability_id"]
            }),
            execute: async ({ capability_id, input_data = {} }) => {
                return apiCall("POST", `/api/invoke/${capability_id}`, apiKey, { input: input_data });
            }
        }),
        agoragentic_vault: tool({
            description: "Compatibility inventory view for legacy vault surfaces.",
            inputSchema: jsonSchema({ type: "object", properties: { item_type: { type: "string" } } }),
            execute: async ({ item_type = "" }) => {
                const params = item_type ? `?type=${item_type}` : "";
                return apiCall("GET", `/api/inventory${params}`, apiKey);
            }
        }),
        agoragentic_memory_write: tool({
            description: "Write scoped Agent OS memory when policy allows it.",
            inputSchema: jsonSchema({
                type: "object",
                properties: {
                    key: { type: "string" }, value: { type: "string" },
                    namespace: { type: "string", default: "default" }
                },
                required: ["key", "value"]
            }),
            execute: async ({ key, value, namespace = "default" }) => {
                return apiCall("POST", "/api/vault/memory", apiKey, { input: { key, value, namespace } });
            }
        }),
        agoragentic_memory_read: tool({
            description: "Read scoped Agent OS memory when policy allows it.",
            inputSchema: jsonSchema({ type: "object", properties: { key: { type: "string" }, namespace: { type: "string" } } }),
            execute: async ({ key = "", namespace = "default" }) => {
                const params = new URLSearchParams({ namespace });
                if (key) params.set("key", key);
                return apiCall("GET", `/api/vault/memory?${params}`, apiKey);
            }
        }),
        agoragentic_secret_store: tool({
            description: "Store a policy-gated encrypted credential.",
            inputSchema: jsonSchema({
                type: "object",
                properties: { label: { type: "string" }, secret: { type: "string" } },
                required: ["label", "secret"]
            }),
            execute: async ({ label, secret }) => {
                return apiCall("POST", "/api/vault/secrets", apiKey, { input: { label, secret } });
            }
        }),
        agoragentic_secret_retrieve: tool({
            description: "Retrieve a policy-gated encrypted credential.",
            inputSchema: jsonSchema({ type: "object", properties: { label: { type: "string" } } }),
            execute: async ({ label = "" }) => {
                const params = label ? `?label=${label}` : "";
                return apiCall("GET", `/api/vault/secrets${params}`, apiKey);
            }
        }),
        agoragentic_passport: tool({
            description: "Compatibility identity helper for legacy passport surfaces.",
            inputSchema: jsonSchema({ type: "object", properties: { action: { type: "string", enum: ["check", "info"] } } }),
            execute: async ({ action = "check" }) => {
                const path = action === "info" ? "/api/passport/info" : "/api/passport/check";
                return apiCall("GET", path, action === "info" ? "" : apiKey);
            }
        })
    };
}

export default getAgoragenticTools;
