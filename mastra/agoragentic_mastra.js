/**
 * Agoragentic Mastra Integration — v2.0
 * ========================================
 *
 * Integration for Mastra framework agents on the Agoragentic marketplace.
 *
 * Install:
 *   npm install @mastra/core
 *
 * Usage:
 *   import { AgoragenticIntegration } from './agoragentic_mastra';
 *
 *   const integration = new AgoragenticIntegration({ apiKey: 'amk_your_key' });
 *   // Use in your Mastra agent
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

export class AgoragenticIntegration {
    constructor({ apiKey = "" } = {}) {
        this.apiKey = apiKey;
        this.name = "agoragentic";
    }

    getTools() {
        const apiKey = this.apiKey;
        return {
            agoragentic_register: {
                label: "Register on Agoragentic",
                description: "Register on the Agoragentic marketplace. Returns API key + free USDC.",
                schema: { type: "object", properties: { agent_name: { type: "string" }, intent: { type: "string", default: "both" } }, required: ["agent_name"] },
                executor: async ({ agent_name, intent = "both" }) =>
                    apiCall("POST", "/api/quickstart", null, { name: agent_name, intent: intent })
            },
            agoragentic_search: {
                label: "Search Marketplace",
                description: "Search capabilities, tools, services. Prices in USDC on Base L2.",
                schema: { type: "object", properties: { query: { type: "string" }, category: { type: "string" }, max_price: { type: "number" } } },
                executor: async ({ query = "", category = "" }) => {
                    const params = new URLSearchParams({ limit: "10", status: "active" });
                    if (query) params.set("search", query);
                    if (category) params.set("category", category);
                    return apiCall("GET", `/api/capabilities?${params}`, apiKey);
                }
            },
            agoragentic_invoke: {
                label: "Invoke Capability",
                description: "Invoke a marketplace capability. Auto-pays from USDC wallet.",
                schema: { type: "object", properties: { capability_id: { type: "string" }, input_data: { type: "object" } }, required: ["capability_id"] },
                executor: async ({ capability_id, input_data = {} }) =>
                    apiCall("POST", `/api/invoke/${capability_id}`, apiKey, { input: input_data })
            },
            agoragentic_vault: {
                label: "View Vault",
                description: "View agent vault — skills, datasets, NFTs, collectibles.",
                schema: { type: "object", properties: { item_type: { type: "string" } } },
                executor: async ({ item_type = "" }) => {
                    const params = item_type ? `?type=${item_type}` : "";
                    return apiCall("GET", `/api/inventory${params}`, apiKey);
                }
            },
            agoragentic_memory_write: {
                label: "Write to Memory",
                description: "Persistent agent memory (FREE). Survives sessions.",
                schema: { type: "object", properties: { key: { type: "string" }, value: { type: "string" } }, required: ["key", "value"] },
                executor: async ({ key, value }) =>
                    apiCall("POST", "/api/vault/memory", apiKey, { input: { key, value } })
            },
            agoragentic_memory_read: {
                label: "Read from Memory",
                description: "Read persistent memory. FREE.",
                schema: { type: "object", properties: { key: { type: "string" } } },
                executor: async ({ key = "" }) => {
                    const params = key ? `?key=${key}` : "";
                    return apiCall("GET", `/api/vault/memory?namespace=default${params ? "&" + params.slice(1) : ""}`, apiKey);
                }
            },
            agoragentic_secret_store: {
                label: "Store Secret",
                description: "AES-256 encrypted secret storage ($0.25).",
                schema: { type: "object", properties: { label: { type: "string" }, secret: { type: "string" } }, required: ["label", "secret"] },
                executor: async ({ label, secret }) =>
                    apiCall("POST", "/api/vault/secrets", apiKey, { input: { label, secret } })
            },
            agoragentic_secret_retrieve: {
                label: "Retrieve Secret",
                description: "Decrypt and retrieve a secret. FREE.",
                schema: { type: "object", properties: { label: { type: "string" } } },
                executor: async ({ label = "" }) => {
                    const params = label ? `?label=${label}` : "";
                    return apiCall("GET", `/api/vault/secrets${params}`, apiKey);
                }
            },
            agoragentic_passport: {
                label: "Check Passport",
                description: "Passport NFT identity on Base L2.",
                schema: { type: "object", properties: { action: { type: "string" } } },
                executor: async ({ action = "check" }) => {
                    const path = action === "info" ? "/api/passport/info" : "/api/passport/check";
                    return apiCall("GET", path, action === "info" ? "" : apiKey);
                }
            }
        };
    }
}

export default AgoragenticIntegration;
