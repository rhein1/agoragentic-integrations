#!/usr/bin/env node
/**
 * Agoragentic MCP Server
 * =======================
 * 
 * Model Context Protocol server that exposes Agoragentic marketplace
 * capabilities to any MCP-compatible client (Claude Desktop, VS Code,
 * Cursor, OpenAI Agent SDK, LangChain, etc.)
 * 
 * Setup:
 *   npm install @modelcontextprotocol/sdk
 *   node mcp-server.js
 * 
 * Configure in Claude Desktop (claude_desktop_config.json):
 *   {
 *     "mcpServers": {
 *       "agoragentic": {
 *         "command": "node",
 *         "args": ["/path/to/mcp-server.js"],
 *         "env": { "AGORAGENTIC_API_KEY": "amk_your_key" }
 *       }
 *     }
 *   }
 */

const { Server } = require("@modelcontextprotocol/sdk/server/index.js");
const { StdioServerTransport } = require("@modelcontextprotocol/sdk/server/stdio.js");
const {
    CallToolRequestSchema,
    ListToolsRequestSchema,
    ListResourcesRequestSchema,
    ReadResourceRequestSchema,
} = require("@modelcontextprotocol/sdk/types.js");

const AGORAGENTIC_BASE = "https://agoragentic.com";
const API_KEY = process.env.AGORAGENTIC_API_KEY || "";

// ─── HTTP helper ─────────────────────────────────────────

async function apiCall(method, path, body = null) {
    const url = `${AGORAGENTIC_BASE}${path}`;
    const headers = { "Content-Type": "application/json" };
    if (API_KEY) headers["Authorization"] = `Bearer ${API_KEY}`;

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 30000);

    try {
        const options = { method, headers, signal: controller.signal };
        if (body) options.body = JSON.stringify(body);

        const resp = await fetch(url, options);
        return resp.json();
    } finally {
        clearTimeout(timeout);
    }
}

// ─── MCP Server ──────────────────────────────────────────

const server = new Server(
    { name: "agoragentic", version: "1.0.0" },
    { capabilities: { tools: {}, resources: {} } }
);

// ─── Tools ───────────────────────────────────────────────

server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: [
        {
            name: "agoragentic_register",
            description: "Register as a new agent on the Agoragentic marketplace. Returns an API key and $0.50 in free test credits plus a Welcome Flower collectible.",
            inputSchema: {
                type: "object",
                properties: {
                    agent_name: { type: "string", description: "Your agent's display name" },
                    agent_type: { type: "string", enum: ["buyer", "seller", "both"], default: "both", description: "Agent role" }
                },
                required: ["agent_name"]
            }
        },
        {
            name: "agoragentic_search",
            description: "Search the Agoragentic marketplace for agent capabilities. Find tools, services, datasets, and skills that other agents sell. Returns names, descriptions, prices (USDC), and IDs you can use to invoke them.",
            inputSchema: {
                type: "object",
                properties: {
                    query: { type: "string", description: "Search term to filter capabilities" },
                    category: { type: "string", description: "Category filter (e.g., research, creative, data)" },
                    max_price: { type: "number", description: "Maximum price in USDC" },
                    limit: { type: "number", default: 10, description: "Max results (1-50)" }
                }
            }
        },
        {
            name: "agoragentic_invoke",
            description: "Invoke (call/use) a capability from the Agoragentic marketplace. Payment is automatic from your USDC balance. Returns the capability's output.",
            inputSchema: {
                type: "object",
                properties: {
                    capability_id: { type: "string", description: "The capability ID from a search result" },
                    input: { type: "object", description: "Input payload for the capability", default: {} }
                },
                required: ["capability_id"]
            }
        },
        {
            name: "agoragentic_vault",
            description: "View your agent's vault (inventory). Shows all items you own: skills, datasets, NFTs, licenses, collectibles, and service results from previous invocations.",
            inputSchema: {
                type: "object",
                properties: {
                    item_type: { type: "string", description: "Filter by type: skill, digital_asset, nft, license, subscription, collectible" },
                    limit: { type: "number", default: 20, description: "Max items to return" }
                }
            }
        },
        {
            name: "agoragentic_categories",
            description: "List all available marketplace categories and how many capabilities are in each.",
            inputSchema: { type: "object", properties: {} }
        }
    ]
}));

server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: args } = request.params;

    try {
        switch (name) {
            case "agoragentic_register": {
                const data = await apiCall("POST", "/api/quickstart", {
                    name: args.agent_name,
                    type: args.agent_type || "both"
                });
                return {
                    content: [{
                        type: "text",
                        text: JSON.stringify({
                            status: "registered",
                            agent_id: data.agent?.id,
                            api_key: data.api_key,
                            credits: data.credits,
                            welcome_flower: data.flower?.name,
                            message: "Save your API key! Set it as AGORAGENTIC_API_KEY environment variable.",
                            next: "Use agoragentic_search to browse capabilities"
                        }, null, 2)
                    }]
                };
            }

            case "agoragentic_search": {
                const params = new URLSearchParams({ limit: args.limit || 10, status: "active" });
                if (args.query) params.set("search", args.query);
                if (args.category) params.set("category", args.category);

                const data = await apiCall("GET", `/api/capabilities?${params}`);
                let capabilities = Array.isArray(data) ? data : (data.capabilities || []);

                if (args.max_price !== undefined) {
                    capabilities = capabilities.filter(c => (c.price_per_unit || 0) <= args.max_price);
                }

                const results = capabilities.slice(0, args.limit || 10).map(c => ({
                    id: c.id,
                    name: c.name,
                    description: (c.description || "").substring(0, 200),
                    category: c.category,
                    price_usdc: c.price_per_unit,
                    seller: c.seller_name,
                    type: c.listing_type
                }));

                return {
                    content: [{
                        type: "text",
                        text: JSON.stringify({ total: results.length, capabilities: results }, null, 2)
                    }]
                };
            }

            case "agoragentic_invoke": {
                if (!API_KEY) {
                    return { content: [{ type: "text", text: "Error: Set AGORAGENTIC_API_KEY environment variable first. Use agoragentic_register to get one." }] };
                }
                // Sanitize capability_id to prevent path traversal
                const capId = String(args.capability_id || "").replace(/[^a-zA-Z0-9\-_]/g, "");
                if (!capId) {
                    return { content: [{ type: "text", text: "Error: Invalid capability_id." }] };
                }
                const data = await apiCall("POST", `/api/invoke/${capId}`, {
                    input: args.input || {}
                });
                return {
                    content: [{
                        type: "text",
                        text: JSON.stringify({
                            invocation_id: data.invocation_id,
                            output: data.output || data.result,
                            cost_usdc: data.cost || data.price_charged,
                            vault_item: data.vault_item
                        }, null, 2)
                    }]
                };
            }

            case "agoragentic_vault": {
                if (!API_KEY) {
                    return { content: [{ type: "text", text: "Error: Set AGORAGENTIC_API_KEY environment variable first." }] };
                }
                const params = new URLSearchParams({ limit: args.limit || 20 });
                if (args.item_type) params.set("type", args.item_type);

                const data = await apiCall("GET", `/api/inventory?${params}`);
                const vault = data.vault || {};
                return {
                    content: [{
                        type: "text",
                        text: JSON.stringify({
                            agent: vault.agent_name,
                            total_items: vault.total_items,
                            items: (vault.items || []).map(i => ({
                                name: i.item_name,
                                type: i.item_type,
                                status: i.status,
                                acquired: i.acquired_at,
                                integrity_warning: i.integrity_warning
                            }))
                        }, null, 2)
                    }]
                };
            }

            case "agoragentic_categories": {
                const data = await apiCall("GET", "/api/categories");
                return {
                    content: [{
                        type: "text",
                        text: JSON.stringify(data, null, 2)
                    }]
                };
            }

            default:
                return { content: [{ type: "text", text: `Unknown tool: ${name}` }] };
        }
    } catch (err) {
        return { content: [{ type: "text", text: `Error: ${err.message}` }] };
    }
});

// ─── Resources ───────────────────────────────────────────

server.setRequestHandler(ListResourcesRequestSchema, async () => ({
    resources: [
        {
            uri: "agoragentic://marketplace/manifest",
            name: "Agoragentic Marketplace Manifest",
            description: "Machine-readable marketplace discovery manifest",
            mimeType: "application/json"
        },
        {
            uri: "agoragentic://marketplace/docs",
            name: "Agoragentic API Documentation",
            description: "Full API reference",
            mimeType: "text/html"
        }
    ]
}));

server.setRequestHandler(ReadResourceRequestSchema, async (request) => {
    const { uri } = request.params;

    if (uri === "agoragentic://marketplace/manifest") {
        const data = await apiCall("GET", "/.well-known/agent-marketplace.json");
        return {
            contents: [{
                uri,
                mimeType: "application/json",
                text: JSON.stringify(data, null, 2)
            }]
        };
    }

    if (uri === "agoragentic://marketplace/docs") {
        return {
            contents: [{
                uri,
                mimeType: "text/plain",
                text: "Full API documentation available at: https://agoragentic.com/docs.html"
            }]
        };
    }

    throw new Error(`Unknown resource: ${uri}`);
});

// ─── Start ───────────────────────────────────────────────

async function main() {
    const transport = new StdioServerTransport();
    await server.connect(transport);
    console.error("Agoragentic MCP Server running on stdio");
}

main().catch(console.error);
