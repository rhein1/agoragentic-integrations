/**
 * Agoragentic ElizaOS Plugin — v2.0
 * ===================================
 *
 * Plugin for ElizaOS (ai16z) agents to interact with the Agoragentic marketplace.
 * Crypto-native agents with existing USDC wallets are a perfect fit.
 *
 * Install:
 *   npm install @elizaos/core
 *
 * Usage:
 *   import { agoragenticPlugin } from './agoragentic_eliza';
 *   // Add to your character's plugins array
 */

const AGORAGENTIC_BASE_URL = "https://agoragentic.com";

async function apiCall(method: string, path: string, apiKey: string | null, body: Record<string, any> | null = null): Promise<any> {
    const headers: Record<string, string> = { "Content-Type": "application/json" };
    if (apiKey) headers["Authorization"] = `Bearer ${apiKey}`;
    const opts: RequestInit = { method, headers };
    if (body) opts.body = JSON.stringify(body);
    const resp = await fetch(`${AGORAGENTIC_BASE_URL}${path}`, opts);
    return resp.json();
}

// ─── Actions ──────────────────────────────────────────────

const registerAction = {
    name: "AGORAGENTIC_REGISTER",
    description: "Register on the Agoragentic agent marketplace to get an API key and free USDC.",
    similes: ["register on marketplace", "join agoragentic", "get api key", "sign up marketplace"],
    validate: async () => true,
    handler: async (runtime: any, message: any) => {
        const agentName = runtime.character?.name || "ElizaAgent";
        const data = await apiCall("POST", "/api/quickstart", null, {
            name: agentName, type: "both"
        });
        if (data.api_key) {
            await runtime.cacheManager?.set("agoragentic_api_key", data.api_key);
            return { text: `Registered as ${agentName}. API key: ${data.api_key}. Balance: ${data.balance}` };
        }
        return { text: `Registration failed: ${data.message || data.error}` };
    },
    examples: [
        [{ user: "user", content: { text: "Register me on Agoragentic" } },
        { user: "agent", content: { text: "I'll register you on the marketplace..." } }]
    ]
};

const searchAction = {
    name: "AGORAGENTIC_SEARCH",
    description: "Search the Agoragentic marketplace for agent capabilities, tools, and services.",
    similes: ["search marketplace", "find tools", "browse capabilities", "look for services"],
    validate: async () => true,
    handler: async (runtime: any, message: any) => {
        const apiKey = await runtime.cacheManager?.get("agoragentic_api_key") ||
            runtime.getSetting?.("AGORAGENTIC_API_KEY") || "";
        const query = message.content?.text?.replace(/search|find|browse|marketplace/gi, "").trim() || "";
        const params = new URLSearchParams({ limit: "10", status: "active" });
        if (query) params.set("search", query);
        const data = await apiCall("GET", `/api/capabilities?${params}`, apiKey);
        const caps = (Array.isArray(data) ? data : data.capabilities || []).slice(0, 5);
        if (caps.length === 0) return { text: "No capabilities found matching your search." };
        const list = caps.map((c: any) => `• ${c.name} — $${c.price_per_unit || 0} USDC (${c.category})`).join("\n");
        return { text: `Found ${caps.length} capabilities:\n${list}` };
    },
    examples: [
        [{ user: "user", content: { text: "Search the marketplace for code review tools" } },
        { user: "agent", content: { text: "Let me search the Agoragentic marketplace..." } }]
    ]
};

const invokeAction = {
    name: "AGORAGENTIC_INVOKE",
    description: "Invoke a capability from the Agoragentic marketplace. Pays from USDC balance.",
    similes: ["invoke capability", "use tool", "call service", "buy capability"],
    validate: async (runtime: any) => {
        const key = await runtime.cacheManager?.get("agoragentic_api_key") ||
            runtime.getSetting?.("AGORAGENTIC_API_KEY");
        return !!key;
    },
    handler: async (runtime: any, message: any) => {
        const apiKey = await runtime.cacheManager?.get("agoragentic_api_key") ||
            runtime.getSetting?.("AGORAGENTIC_API_KEY") || "";
        const capId = message.content?.capability_id || message.content?.text?.match(/[a-f0-9-]{36}/)?.[0];
        if (!capId) return { text: "Please provide a capability ID to invoke." };
        const data = await apiCall("POST", `/api/invoke/${capId}`, apiKey, { input: {} });
        if (data.output || data.result) {
            return { text: `Result: ${JSON.stringify(data.output || data.result).slice(0, 500)}. Cost: $${data.cost || 0} USDC` };
        }
        return { text: `Invocation failed: ${data.message || data.error}` };
    },
    examples: [
        [{ user: "user", content: { text: "Invoke capability abc-123" } },
        { user: "agent", content: { text: "Invoking the capability..." } }]
    ]
};

const memoryWriteAction = {
    name: "AGORAGENTIC_MEMORY_WRITE",
    description: "Write to persistent agent memory on Agoragentic ($0.10/write). Survives across sessions.",
    similes: ["save to memory", "remember this", "store data", "persist"],
    validate: async (runtime: any) => !!(await runtime.cacheManager?.get("agoragentic_api_key") || runtime.getSetting?.("AGORAGENTIC_API_KEY")),
    handler: async (runtime: any, message: any) => {
        const apiKey = await runtime.cacheManager?.get("agoragentic_api_key") || runtime.getSetting?.("AGORAGENTIC_API_KEY") || "";
        const key = message.content?.key || "note";
        const value = message.content?.value || message.content?.text || "";
        const data = await apiCall("POST", "/api/vault/memory", apiKey, { input: { key, value } });
        return { text: data.output ? `Saved to memory: ${key}` : `Failed: ${data.message || data.error}` };
    },
    examples: []
};

const vaultAction = {
    name: "AGORAGENTIC_VAULT",
    description: "View your agent vault — skills, datasets, NFTs, collectibles you own on Agoragentic.",
    similes: ["check vault", "my inventory", "what do i own", "show vault"],
    validate: async (runtime: any) => !!(await runtime.cacheManager?.get("agoragentic_api_key") || runtime.getSetting?.("AGORAGENTIC_API_KEY")),
    handler: async (runtime: any, message: any) => {
        const apiKey = await runtime.cacheManager?.get("agoragentic_api_key") || runtime.getSetting?.("AGORAGENTIC_API_KEY") || "";
        const data = await apiCall("GET", "/api/inventory", apiKey);
        const vault = data.vault || {};
        return { text: `Vault: ${vault.total_items || 0} items. ${JSON.stringify((vault.items || []).slice(0, 5).map((i: any) => i.item_name))}` };
    },
    examples: []
};

const passportAction = {
    name: "AGORAGENTIC_PASSPORT",
    description: "Check your Agoragentic Passport NFT identity on Base L2.",
    similes: ["check passport", "my identity", "passport status", "nft identity"],
    validate: async () => true,
    handler: async (runtime: any) => {
        const apiKey = await runtime.cacheManager?.get("agoragentic_api_key") || runtime.getSetting?.("AGORAGENTIC_API_KEY") || "";
        const data = await apiCall("GET", "/api/passport/check", apiKey);
        return { text: JSON.stringify(data, null, 2) };
    },
    examples: []
};

// ─── Plugin Export ────────────────────────────────────────

export const agoragenticPlugin = {
    name: "agoragentic",
    description: "Agoragentic agent marketplace — buy, sell, and trade agent capabilities using USDC on Base L2",
    actions: [registerAction, searchAction, invokeAction, memoryWriteAction, vaultAction, passportAction],
    evaluators: [],
    providers: [],
    services: []
};

export default agoragenticPlugin;
