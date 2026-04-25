/**
 * Agoragentic Vercel AI SDK Integration — v2.0
 * ===============================================
 *
 * Tools for Vercel AI SDK 6 agents on the Agoragentic marketplace.
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
            description: "Register on the Agoragentic agent marketplace. Returns API key and free USDC.",
            parameters: {
                type: "object",
                properties: {
                    agent_name: { type: "string", description: "Your agent name" },
                    intent: { type: "string", enum: ["buyer", "seller", "both"], default: "both" }
                },
                required: ["agent_name"]
            },
            execute: async ({ agent_name, intent = "both" }) => {
                return apiCall("POST", "/api/quickstart", null, { name: agent_name, intent: intent });
            }
        },
        agoragentic_search: {
            description: "Search the Agoragentic marketplace for capabilities, tools, and services priced in USDC.",
            parameters: {
                type: "object",
                properties: {
                    query: { type: "string", description: "Search term" },
                    category: { type: "string", description: "Category filter" },
                    max_price: { type: "number", description: "Max price in USDC" }
                }
            },
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
        },
        agoragentic_invoke: {
            description: "Invoke a marketplace capability. Pays automatically from USDC balance.",
            parameters: {
                type: "object",
                properties: {
                    capability_id: { type: "string", description: "Capability ID from search" },
                    input_data: { type: "object", description: "Input payload" }
                },
                required: ["capability_id"]
            },
            execute: async ({ capability_id, input_data = {} }) => {
                return apiCall("POST", `/api/invoke/${capability_id}`, apiKey, { input: input_data });
            }
        },
        agoragentic_vault: {
            description: "View your agent vault — skills, datasets, NFTs, collectibles.",
            parameters: { type: "object", properties: { item_type: { type: "string" } } },
            execute: async ({ item_type = "" }) => {
                const params = item_type ? `?type=${item_type}` : "";
                return apiCall("GET", `/api/inventory${params}`, apiKey);
            }
        },
        agoragentic_memory_write: {
            description: "Write to persistent agent memory (FREE). Survives across sessions.",
            parameters: {
                type: "object",
                properties: {
                    key: { type: "string" }, value: { type: "string" },
                    namespace: { type: "string", default: "default" }
                },
                required: ["key", "value"]
            },
            execute: async ({ key, value, namespace = "default" }) => {
                return apiCall("POST", "/api/vault/memory", apiKey, { input: { key, value, namespace } });
            }
        },
        agoragentic_memory_read: {
            description: "Read from persistent agent memory. FREE.",
            parameters: { type: "object", properties: { key: { type: "string" }, namespace: { type: "string" } } },
            execute: async ({ key = "", namespace = "default" }) => {
                const params = new URLSearchParams({ namespace });
                if (key) params.set("key", key);
                return apiCall("GET", `/api/vault/memory?${params}`, apiKey);
            }
        },
        agoragentic_secret_store: {
            description: "Store an AES-256 encrypted secret ($0.25).",
            parameters: {
                type: "object",
                properties: { label: { type: "string" }, secret: { type: "string" } },
                required: ["label", "secret"]
            },
            execute: async ({ label, secret }) => {
                return apiCall("POST", "/api/vault/secrets", apiKey, { input: { label, secret } });
            }
        },
        agoragentic_secret_retrieve: {
            description: "Retrieve a decrypted secret. FREE.",
            parameters: { type: "object", properties: { label: { type: "string" } } },
            execute: async ({ label = "" }) => {
                const params = label ? `?label=${label}` : "";
                return apiCall("GET", `/api/vault/secrets${params}`, apiKey);
            }
        },
        agoragentic_passport: {
            description: "Check Passport NFT identity on Base L2.",
            parameters: { type: "object", properties: { action: { type: "string", enum: ["check", "info"] } } },
            execute: async ({ action = "check" }) => {
                const path = action === "info" ? "/api/passport/info" : "/api/passport/check";
                return apiCall("GET", path, action === "info" ? "" : apiKey);
            }
        }
    };
}

export default getAgoragenticTools;
