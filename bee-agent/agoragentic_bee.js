/**
 * Agoragentic Bee Agent (IBM) Integration — v2.0
 * =================================================
 *
 * Tools for IBM Bee Agent Framework on the Agoragentic Router / Marketplace.
 *
 * Install:
 *   npm install bee-agent-framework
 *
 * Usage:
 *   import { getAgoragenticTools } from './agoragentic_bee';
 *   const tools = getAgoragenticTools('amk_your_key');
 */

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
        agoragentic_execute: {
            name: "agoragentic_execute",
            description: "Route a task through Agoragentic execute() with provider selection, receipts, and settlement.",
            inputSchema: {
                type: "object",
                properties: {
                    task: { type: "string", description: "Task to route through Agoragentic" },
                    input: { type: "object", description: "Task input payload" },
                    constraints: { type: "object", description: "Optional budget, trust, or routing constraints" }
                },
                required: ["task"]
            },
            handler: async ({ task, input = {}, constraints = {} }) => {
                const payload = { task };
                if (Object.keys(input).length) payload.input = input;
                if (Object.keys(constraints).length) payload.constraints = constraints;
                return apiCall("POST", "/api/execute", apiKey, payload);
            }
        },
        agoragentic_match: {
            name: "agoragentic_match",
            description: "Preview eligible routed providers before execution.",
            inputSchema: {
                type: "object",
                properties: {
                    task: { type: "string", description: "Task to match" },
                    max_cost: { type: "number", description: "Optional max cost in USDC" },
                    min_trust: { type: "string", description: "Optional minimum trust requirement" }
                },
                required: ["task"]
            },
            handler: async ({ task, max_cost = -1, min_trust = "" }) => {
                const params = new URLSearchParams({ task });
                if (max_cost >= 0) params.set("max_cost", String(max_cost));
                if (min_trust) params.set("min_trust", min_trust);
                return apiCall("GET", `/api/execute/match?${params}`, apiKey);
            }
        },
        agoragentic_register: {
            name: "agoragentic_register",
            description: "Create an Agoragentic API key for a buyer, seller, or dual-purpose agent.",
            inputSchema: {
                type: "object",
                properties: {
                    agent_name: { type: "string", description: "Your agent name" },
                    intent: { type: "string", enum: ["buyer", "seller", "both"], default: "both" }
                },
                required: ["agent_name"]
            },
            handler: async ({ agent_name, intent = "both" }) => {
                return apiCall("POST", "/api/quickstart", null, { name: agent_name, intent: intent });
            }
        },
        agoragentic_search: {
            name: "agoragentic_search",
            description: "Compatibility catalog browsing. Prefer agoragentic_match for new routed work.",
            inputSchema: {
                type: "object",
                properties: {
                    query: { type: "string", description: "Search term" },
                    category: { type: "string", description: "Category filter" }
                }
            },
            handler: async ({ query = "", category = "" }) => {
                const params = new URLSearchParams({ limit: "10", status: "active" });
                if (query) params.set("search", query);
                if (category) params.set("category", category);
                return apiCall("GET", `/api/capabilities?${params}`, apiKey);
            }
        },
        agoragentic_invoke: {
            name: "agoragentic_invoke",
            description: "Compatibility direct-provider invocation when a known capability ID is required.",
            inputSchema: {
                type: "object",
                properties: {
                    capability_id: { type: "string", description: "Capability ID" },
                    input_data: { type: "object", description: "Input payload" }
                },
                required: ["capability_id"]
            },
            handler: async ({ capability_id, input_data = {} }) => {
                return apiCall("POST", `/api/invoke/${capability_id}`, apiKey, { input: input_data });
            }
        },
        agoragentic_vault: {
            name: "agoragentic_vault",
            description: "Compatibility inventory view for legacy vault surfaces.",
            inputSchema: { type: "object", properties: {} },
            handler: async () => apiCall("GET", "/api/inventory", apiKey)
        },
        agoragentic_memory_write: {
            name: "agoragentic_memory_write",
            description: "Write scoped Agent OS memory when policy allows it.",
            inputSchema: {
                type: "object",
                properties: { key: { type: "string" }, value: { type: "string" } },
                required: ["key", "value"]
            },
            handler: async ({ key, value }) => {
                return apiCall("POST", "/api/vault/memory", apiKey, { input: { key, value } });
            }
        },
        agoragentic_memory_read: {
            name: "agoragentic_memory_read",
            description: "Read scoped Agent OS memory when policy allows it.",
            inputSchema: { type: "object", properties: { key: { type: "string" } } },
            handler: async ({ key = "" }) => {
                const params = key ? `?key=${key}&namespace=default` : "?namespace=default";
                return apiCall("GET", `/api/vault/memory${params}`, apiKey);
            }
        },
        agoragentic_passport: {
            name: "agoragentic_passport",
            description: "Compatibility identity helper for legacy passport surfaces.",
            inputSchema: { type: "object", properties: {} },
            handler: async () => apiCall("GET", "/api/passport/check", apiKey)
        }
    };
}

export default getAgoragenticTools;
