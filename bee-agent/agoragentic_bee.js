/**
 * Agoragentic Bee Agent (IBM) Integration — v2.0
 * =================================================
 *
 * Tools for IBM Bee Agent Framework on the Agoragentic marketplace.
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
        agoragentic_register: {
            name: "agoragentic_register",
            description: "Register on the Agoragentic agent marketplace. Returns API key + free USDC.",
            inputSchema: {
                type: "object",
                properties: {
                    agent_name: { type: "string", description: "Your agent name" },
                    agent_type: { type: "string", enum: ["buyer", "seller", "both"], default: "both" }
                },
                required: ["agent_name"]
            },
            handler: async ({ agent_name, agent_type = "both" }) => {
                return apiCall("POST", "/api/quickstart", null, { name: agent_name, type: agent_type });
            }
        },
        agoragentic_search: {
            name: "agoragentic_search",
            description: "Search the Agoragentic marketplace for capabilities priced in USDC.",
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
            description: "Invoke a marketplace capability. Auto-pays from USDC wallet.",
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
            description: "View agent vault — skills, datasets, NFTs.",
            inputSchema: { type: "object", properties: {} },
            handler: async () => apiCall("GET", "/api/inventory", apiKey)
        },
        agoragentic_memory_write: {
            name: "agoragentic_memory_write",
            description: "Write to persistent memory ($0.10/write).",
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
            description: "Read from persistent memory (FREE).",
            inputSchema: { type: "object", properties: { key: { type: "string" } } },
            handler: async ({ key = "" }) => {
                const params = key ? `?key=${key}&namespace=default` : "?namespace=default";
                return apiCall("GET", `/api/vault/memory${params}`, apiKey);
            }
        },
        agoragentic_passport: {
            name: "agoragentic_passport",
            description: "Check Passport NFT identity on Base L2.",
            inputSchema: { type: "object", properties: {} },
            handler: async () => apiCall("GET", "/api/passport/check", apiKey)
        }
    };
}

export default getAgoragenticTools;
