#!/usr/bin/env node
/**
 * Agoragentic MCP Server — v2.0
 * ==============================
 * 
 * Model Context Protocol server that exposes the full Agoragentic marketplace
 * to any MCP-compatible client (Claude Desktop, VS Code, Cursor, etc.)
 * 
 * v2.0 adds:
 *   - Vault Memory (persistent KV store)
 *   - Vault Secrets (encrypted credential storage)
 *   - Agent Passport (NFT identity)
 *   - x402 payment info
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
    ListPromptsRequestSchema,
    GetPromptRequestSchema,
    McpError,
} = require("@modelcontextprotocol/sdk/types.js");

const AGORAGENTIC_BASE = "https://agoragentic.com";
const X402_EDGE_BASE = "https://x402.agoragentic.com";
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

async function edgeRequest(method, path, body = null, extraHeaders = {}) {
    const url = `${X402_EDGE_BASE}${path}`;
    const headers = { ...extraHeaders };

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 30000);

    try {
        const options = { method, headers, signal: controller.signal };
        if (body !== null && body !== undefined) {
            options.headers["Content-Type"] = "application/json";
            options.body = JSON.stringify(body);
        }

        const resp = await fetch(url, options);
        const raw = await resp.text();
        return { response: resp, data: parseMaybeJson(raw) };
    } finally {
        clearTimeout(timeout);
    }
}

function parseMaybeJson(text) {
    if (!text) return null;
    try {
        return JSON.parse(text);
    } catch {
        return text;
    }
}

function slugifyService(value) {
    return String(value || "")
        .trim()
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, "-")
        .replace(/^-+|-+$/g, "");
}

function findEdgeService(services, slug) {
    const wanted = slugifyService(slug);
    if (!wanted) return null;
    return (services || []).find((service) => {
        const aliases = [service?.slug, ...(service?.route_aliases || [])]
            .map(slugifyService)
            .filter(Boolean);
        return aliases.includes(wanted);
    }) || null;
}

function decodeBase64JsonHeader(value) {
    if (!value || typeof value !== "string") return null;
    try {
        return JSON.parse(Buffer.from(value, "base64").toString("utf8"));
    } catch {
        return null;
    }
}

function buildMcpPaymentRequiredData({ toolName, args, response, routing = null, trust = null }) {
    const paymentRequiredHeader = response.headers.get("payment-required") || null;
    const decodedRequirements = decodeBase64JsonHeader(paymentRequiredHeader);
    const challenges = Array.isArray(decodedRequirements)
        ? decodedRequirements.map((challenge, index) => ({
            id: challenge?.extra?.quote_id || `challenge_${index + 1}`,
            method: challenge?.scheme || "exact",
            intent: "charge",
            network: challenge?.network || null,
            resource: challenge?.resource || null,
            request: {
                max_amount_required: challenge?.maxAmountRequired || null,
                asset: challenge?.asset || null,
                pay_to: challenge?.payTo || null,
                description: challenge?.description || null,
                extra: challenge?.extra || null,
            },
        }))
        : [];

    return {
        protocol: "x402",
        payment_required_header: paymentRequiredHeader,
        authenticate_header: response.headers.get("www-authenticate") || null,
        challenges,
        routing,
        trust,
        retry_tool_call: {
            name: toolName,
            arguments: {
                ...(args || {}),
                payment_signature: "<PAYMENT-SIGNATURE>",
            },
            payment_argument: "payment_signature",
            accepted_http_headers: ["PAYMENT-SIGNATURE", "Authorization: Payment"],
        },
    };
}

function buildMcpPaymentSuccessBody(response, body) {
    return {
        status_code: response.status,
        payment_receipt: response.headers.get("payment-receipt") || null,
        payment_response_header: response.headers.get("payment-response") || null,
        body,
    };
}

function summarizeEdgeService(service, options = {}) {
    const includeSchemas = options.includeSchemas === true;
    const includeTrust = options.includeTrust !== false;
    return {
        slug: service.slug,
        name: service.name,
        description: service.description,
        category: service.category,
        status: service.status,
        price_usdc: service.price_usdc,
        payable_url: service.payable_url,
        route_aliases: service.route_aliases || [],
        safe_to_retry: service.execution_contract?.safe_to_retry ?? service.trust?.safe_to_retry ?? null,
        max_runtime_ms: service.execution_contract?.max_runtime_ms ?? service.trust?.max_runtime_ms ?? null,
        payment_contract: service.payment_contract || null,
        sample_input: service.sample_input || null,
        trust: includeTrust ? (service.trust || null) : undefined,
        input_schema: includeSchemas ? (service.input_schema || null) : undefined,
        output_schema: includeSchemas ? (service.output_schema || null) : undefined,
    };
}

async function loadEdgeServices() {
    const { response, data } = await edgeRequest("GET", "/services/index.json");
    if (!response.ok) {
        throw new Error(`x402 edge service index failed with HTTP ${response.status}`);
    }
    return Array.isArray(data?.services) ? data.services : [];
}

// ─── MCP Server ──────────────────────────────────────────

const server = new Server(
    { name: "agoragentic", version: "2.0.0" },
    { capabilities: { tools: {}, resources: {}, prompts: {} } }
);

// ─── Tools ───────────────────────────────────────────────

server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: [
        // ── Core Marketplace ──
        {
            name: "agoragentic_browse_services",
            description: "Browse stable anonymous x402 services on x402.agoragentic.com. Use this as the accountless buyer catalog for bounded paid resources.",
            annotations: { title: "Browse x402 Services", readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
            inputSchema: {
                type: "object",
                properties: {
                    limit: { type: "number", default: 10, description: "Maximum number of services to return." },
                    include_schemas: { type: "boolean", default: false, description: "Include full input/output schemas in the response." },
                    include_trust: { type: "boolean", default: true, description: "Include trust and settlement metadata in the response." }
                }
            }
        },
        {
            name: "agoragentic_quote_service",
            description: "Quote one stable x402 service by slug. Returns price, retry behavior, trust metadata, sample input, and the exact payable URL without spending.",
            annotations: { title: "Quote x402 Service", readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
            inputSchema: {
                type: "object",
                properties: {
                    slug: { type: "string", description: "Stable x402 service slug, for example text-summarizer." },
                    max_price_usdc: { type: "number", description: "Optional safety bound. The tool errors if the quoted service exceeds this price." },
                    include_schemas: { type: "boolean", default: true, description: "Include full input/output schemas in the response." },
                    include_trust: { type: "boolean", default: true, description: "Include trust and settlement metadata in the response." }
                },
                required: ["slug"]
            }
        },
        {
            name: "agoragentic_call_service",
            description: "Call one stable x402 service by slug. The first unpaid attempt returns an x402 Payment Required payload. Retry the same tool call with payment_signature to complete the paid call.",
            annotations: { title: "Call x402 Service", readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
            inputSchema: {
                type: "object",
                properties: {
                    slug: { type: "string", description: "Stable x402 service slug, for example text-summarizer." },
                    payload: { type: "object", description: "JSON payload sent to the stable edge route.", default: {} },
                    payment_signature: { type: "string", description: "Optional PAYMENT-SIGNATURE value used on the paid retry." },
                    max_price_usdc: { type: "number", description: "Optional safety bound. The tool errors if the quoted service exceeds this price." }
                },
                required: ["slug"]
            }
        },
        {
            name: "agoragentic_edge_receipt",
            description: "Fetch one anonymous x402 edge receipt by receipt ID from x402.agoragentic.com.",
            annotations: { title: "Get x402 Edge Receipt", readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
            inputSchema: {
                type: "object",
                properties: {
                    receipt_id: { type: "string", description: "Stable edge receipt identifier, usually returned in the Payment-Receipt header." }
                },
                required: ["receipt_id"]
            }
        },
        {
            name: "agoragentic_register",
            description: "Register as a new agent on Agoragentic. Returns an API key and access to the Starter Pack. Starter pack rewards are fee discounts, not free credits.",
            annotations: { title: "Register Agent", readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
            inputSchema: {
                type: "object",
                properties: {
                    agent_name: { type: "string", description: "Your agent's display name (must be unique across the marketplace)" },
                    agent_type: { type: "string", enum: ["buyer", "seller", "both"], default: "both", description: "Agent role: buyer (consume services), seller (provide services), or both" }
                },
                required: ["agent_name"]
            }
        },
        {
            name: "agoragentic_search",
            description: "Search Agoragentic for agent capabilities. Find tools, services, datasets, and skills available through the capability router. Returns names, descriptions, prices (USDC), and IDs you can use to invoke them.",
            annotations: { title: "Search Capabilities", readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
            inputSchema: {
                type: "object",
                properties: {
                    query: { type: "string", description: "Search term to filter capabilities (e.g., 'summarize', 'translate', 'research')" },
                    category: { type: "string", description: "Category filter (e.g., research, creative, data, agent-upgrades, infrastructure)" },
                    max_price: { type: "number", description: "Maximum price in USDC to filter results by cost" },
                    limit: { type: "number", default: 10, description: "Maximum number of results to return (1 to 50)" }
                }
            }
        },
        {
            name: "agoragentic_invoke",
            description: "Invoke (call/use) a capability from the Agoragentic marketplace. Payment is automatic from your USDC balance. Returns the capability's output.",
            annotations: { title: "Invoke Capability", readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
            inputSchema: {
                type: "object",
                properties: {
                    capability_id: { type: "string", description: "The capability ID returned from a search result" },
                    input: { type: "object", description: "Input payload for the capability as a JSON object", default: {} }
                },
                required: ["capability_id"]
            }
        },
        {
            name: "agoragentic_vault",
            description: "View your agent's vault (inventory). Shows all items you own: skills, datasets, licenses, collectibles, and service results from previous invocations.",
            annotations: { title: "View Vault", readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
            inputSchema: {
                type: "object",
                properties: {
                    item_type: { type: "string", description: "Filter by item type: skill, digital_asset, nft, license, subscription, or collectible" },
                    include_nfts: { type: "boolean", description: "Include on-chain NFTs minted on Base L2 blockchain", default: false },
                    limit: { type: "number", default: 20, description: "Maximum number of vault items to return" }
                }
            }
        },
        {
            name: "agoragentic_categories",
            description: "List all available marketplace categories and how many capabilities are in each.",
            annotations: { title: "List Categories", readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
            inputSchema: { type: "object", properties: {} }
        },

        // ── Vault Memory ──
        {
            name: "agoragentic_memory_write",
            description: "Write a key value pair to your persistent agent memory. Survives across sessions, IDEs, and machines. Costs $0.10 per write via the marketplace.",
            annotations: { title: "Write Memory", readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
            inputSchema: {
                type: "object",
                properties: {
                    key: { type: "string", description: "Memory key identifier, maximum 256 characters" },
                    value: { type: "string", description: "Value to store, maximum 64KB. Can be any string or serialized JSON." },
                    namespace: { type: "string", default: "default", description: "Namespace to organize keys into logical groups" },
                    ttl_seconds: { type: "number", description: "Automatic expiration in seconds. Omit for permanent storage." }
                },
                required: ["key", "value"]
            }
        },
        {
            name: "agoragentic_memory_read",
            description: "Read from your persistent agent memory. Free, no cost to recall your own data. Returns a single key or lists all keys.",
            annotations: { title: "Read Memory", readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
            inputSchema: {
                type: "object",
                properties: {
                    key: { type: "string", description: "Specific key to read. Omit to list all stored keys." },
                    namespace: { type: "string", default: "default", description: "Namespace to read from" },
                    prefix: { type: "string", description: "Filter keys by prefix when listing all keys" }
                }
            }
        },

        // ── Vault Secrets ──
        {
            name: "agoragentic_secret_store",
            description: "Store an encrypted secret (API key, token, password) in your vault. AES 256 encrypted at rest. Costs $0.25 via the marketplace.",
            annotations: { title: "Store Secret", readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
            inputSchema: {
                type: "object",
                properties: {
                    label: { type: "string", description: "Label for the secret, for example 'openai_key' or 'stripe_token'" },
                    secret: { type: "string", description: "The secret value to encrypt and store securely" },
                    hint: { type: "string", description: "Optional human readable hint to help you remember what this secret is for" }
                },
                required: ["label", "secret"]
            }
        },
        {
            name: "agoragentic_secret_retrieve",
            description: "Retrieve a decrypted secret from your vault. Free, no cost to access your own credentials.",
            annotations: { title: "Retrieve Secret", readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
            inputSchema: {
                type: "object",
                properties: {
                    label: { type: "string", description: "Label of the secret to retrieve. Omit to list all stored secrets." }
                }
            }
        },

        // ── Passport ──
        {
            name: "agoragentic_passport",
            description: "Check your Agoragentic Passport NFT status, or get info about the passport system. Passports are on chain identity NFTs on Base L2.",
            annotations: { title: "Agent Passport", readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
            inputSchema: {
                type: "object",
                properties: {
                    action: {
                        type: "string",
                        enum: ["check", "info", "verify"],
                        default: "check",
                        description: "Action to perform: check your passport status, info for system overview, or verify a wallet address"
                    },
                    wallet_address: { type: "string", description: "Wallet address to verify ownership. Only used when action is set to verify." }
                }
            }
        }
    ]
}));

server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: args } = request.params;

    try {
        switch (name) {
            case "agoragentic_browse_services": {
                const services = await loadEdgeServices();
                const limit = Math.max(1, Math.min(Number(args.limit) || 10, 50));
                const summaries = services
                    .filter((service) => service && service.status === "available")
                    .slice(0, limit)
                    .map((service) => summarizeEdgeService(service, {
                        includeSchemas: args.include_schemas === true,
                        includeTrust: args.include_trust !== false,
                    }));

                return {
                    content: [{
                        type: "text",
                        text: JSON.stringify({
                            mode: "anonymous_x402_edge",
                            service_count: summaries.length,
                            base_url: X402_EDGE_BASE,
                            services: summaries,
                        }, null, 2)
                    }]
                };
            }

            case "agoragentic_quote_service": {
                const services = await loadEdgeServices();
                const service = findEdgeService(services, args.slug);
                if (!service) {
                    return {
                        content: [{
                            type: "text",
                            text: JSON.stringify({
                                error: "unknown_service",
                                slug: args.slug || null,
                                message: "Stable x402 service slug not found on the edge."
                            }, null, 2)
                        }],
                        isError: true
                    };
                }

                const quotedPrice = Number.parseFloat(service.price_usdc);
                if (Number.isFinite(Number(args.max_price_usdc)) && Number.isFinite(quotedPrice) && quotedPrice > Number(args.max_price_usdc)) {
                    return {
                        content: [{
                            type: "text",
                            text: JSON.stringify({
                                error: "price_exceeds_max",
                                slug: service.slug,
                                quoted_price_usdc: service.price_usdc,
                                max_price_usdc: Number(args.max_price_usdc)
                            }, null, 2)
                        }],
                        isError: true
                    };
                }

                return {
                    content: [{
                        type: "text",
                        text: JSON.stringify({
                            mode: "anonymous_x402_edge_quote",
                            ...summarizeEdgeService(service, {
                                includeSchemas: args.include_schemas !== false,
                                includeTrust: args.include_trust !== false,
                            })
                        }, null, 2)
                    }]
                };
            }

            case "agoragentic_call_service": {
                const services = await loadEdgeServices();
                const service = findEdgeService(services, args.slug);
                if (!service) {
                    return {
                        content: [{
                            type: "text",
                            text: JSON.stringify({
                                error: "unknown_service",
                                slug: args.slug || null,
                                message: "Stable x402 service slug not found on the edge."
                            }, null, 2)
                        }],
                        isError: true
                    };
                }

                const quotedPrice = Number.parseFloat(service.price_usdc);
                if (Number.isFinite(Number(args.max_price_usdc)) && Number.isFinite(quotedPrice) && quotedPrice > Number(args.max_price_usdc)) {
                    return {
                        content: [{
                            type: "text",
                            text: JSON.stringify({
                                error: "price_exceeds_max",
                                slug: service.slug,
                                quoted_price_usdc: service.price_usdc,
                                max_price_usdc: Number(args.max_price_usdc)
                            }, null, 2)
                        }],
                        isError: true
                    };
                }

                const requestHeaders = {};
                if (args.payment_signature) {
                    requestHeaders["PAYMENT-SIGNATURE"] = String(args.payment_signature);
                }

                const { response, data } = await edgeRequest(
                    "POST",
                    `/v1/${encodeURIComponent(service.slug)}`,
                    args.payload || {},
                    requestHeaders
                );

                if (response.status === 402) {
                    throw new McpError(-32042, "Payment Required", buildMcpPaymentRequiredData({
                        toolName: "agoragentic_call_service",
                        args: {
                            slug: service.slug,
                            payload: args.payload || {},
                            max_price_usdc: args.max_price_usdc
                        },
                        response,
                        routing: {
                            provider_count: 1,
                            selected_provider: service.slug,
                            route: `/v1/${service.slug}`,
                        },
                        trust: service.trust || {
                            status: service.status || "reachable",
                            method: "x402_edge_service_index",
                        }
                    }));
                }

                return {
                    content: [{
                        type: "text",
                        text: JSON.stringify({
                            slug: service.slug,
                            service_name: service.name,
                            payable_url: service.payable_url,
                            ...buildMcpPaymentSuccessBody(response, data)
                        }, null, 2)
                    }],
                    isError: response.status >= 400
                };
            }

            case "agoragentic_edge_receipt": {
                const { response, data } = await edgeRequest(
                    "GET",
                    `/v1/receipts/${encodeURIComponent(String(args.receipt_id || ""))}`
                );
                return {
                    content: [{
                        type: "text",
                        text: JSON.stringify({
                            status_code: response.status,
                            receipt: data
                        }, null, 2)
                    }],
                    isError: response.status >= 400
                };
            }

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
                            fee_rate: "3.00%",
                            message: "Save your API key! Set it as AGORAGENTIC_API_KEY environment variable.",
                            next: "Use agoragentic_search to find capabilities, or agoragentic_invoke to call one directly"
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
                            status: data.status,
                            output: data.response,
                            cost_usdc: data.cost,
                            balance_after: data.buyer_balance,
                            nft: data.nft || null,
                            vault_item: data.vault || null
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
                if (args.include_nfts) params.set("include", "nfts");

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
                            })),
                            nfts: data.nfts || null
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

            // ── Vault Memory ──

            case "agoragentic_memory_write": {
                if (!API_KEY) {
                    return { content: [{ type: "text", text: "Error: API key required." }] };
                }
                // Find the Memory Slots listing and invoke through marketplace
                const searchData = await apiCall("GET", "/api/capabilities?search=Vault+Memory+Slots&limit=1");
                const listings = Array.isArray(searchData) ? searchData : (searchData.capabilities || []);
                const memoryListing = listings.find(l => l.name === 'Vault Memory Slots');

                if (memoryListing) {
                    const data = await apiCall("POST", `/api/invoke/${memoryListing.id}`, {
                        input: {
                            key: args.key,
                            value: args.value,
                            namespace: args.namespace || 'default',
                            ttl_seconds: args.ttl_seconds
                        }
                    });
                    return {
                        content: [{
                            type: "text",
                            text: JSON.stringify({
                                status: data.status,
                                output: data.response?.output || data.response,
                                cost: data.cost,
                                balance_after: data.buyer_balance
                            }, null, 2)
                        }]
                    };
                }

                // Fallback: direct API call
                const data = await apiCall("POST", "/api/vault/memory", {
                    input: {
                        key: args.key,
                        value: args.value,
                        namespace: args.namespace || 'default',
                        ttl_seconds: args.ttl_seconds
                    }
                });
                return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
            }

            case "agoragentic_memory_read": {
                if (!API_KEY) {
                    return { content: [{ type: "text", text: "Error: API key required." }] };
                }
                const params = new URLSearchParams();
                if (args.key) params.set("key", args.key);
                if (args.namespace) params.set("namespace", args.namespace);
                if (args.prefix) params.set("prefix", args.prefix);

                const data = await apiCall("GET", `/api/vault/memory?${params}`);
                return {
                    content: [{
                        type: "text",
                        text: JSON.stringify(data.output || data, null, 2)
                    }]
                };
            }

            // ── Vault Secrets ──

            case "agoragentic_secret_store": {
                if (!API_KEY) {
                    return { content: [{ type: "text", text: "Error: API key required." }] };
                }
                const searchData = await apiCall("GET", "/api/capabilities?search=Vault+Secrets+Locker&limit=1");
                const listings = Array.isArray(searchData) ? searchData : (searchData.capabilities || []);
                const secretsListing = listings.find(l => l.name === 'Vault Secrets Locker');

                if (secretsListing) {
                    const data = await apiCall("POST", `/api/invoke/${secretsListing.id}`, {
                        input: {
                            label: args.label,
                            secret: args.secret,
                            hint: args.hint
                        }
                    });
                    return {
                        content: [{
                            type: "text",
                            text: JSON.stringify({
                                status: data.status,
                                output: data.response?.output || data.response,
                                cost: data.cost,
                                balance_after: data.buyer_balance
                            }, null, 2)
                        }]
                    };
                }

                const data = await apiCall("POST", "/api/vault/secrets", {
                    input: { label: args.label, secret: args.secret, hint: args.hint }
                });
                return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
            }

            case "agoragentic_secret_retrieve": {
                if (!API_KEY) {
                    return { content: [{ type: "text", text: "Error: API key required." }] };
                }
                const params = new URLSearchParams();
                if (args.label) params.set("label", args.label);

                const data = await apiCall("GET", `/api/vault/secrets?${params}`);
                return {
                    content: [{
                        type: "text",
                        text: JSON.stringify(data.output || data, null, 2)
                    }]
                };
            }

            // ── Passport ──

            case "agoragentic_passport": {
                const action = args.action || "check";

                if (action === "info") {
                    const data = await apiCall("GET", "/api/passport/info");
                    return { content: [{ type: "text", text: JSON.stringify(data.output || data, null, 2) }] };
                }

                if (action === "verify" && args.wallet_address) {
                    const data = await apiCall("GET", `/api/passport/verify/${args.wallet_address}`);
                    return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
                }

                if (!API_KEY) {
                    return { content: [{ type: "text", text: "Error: API key required to check passport." }] };
                }
                const data = await apiCall("GET", "/api/passport/check");
                return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
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
        },
        {
            uri: "agoragentic://vault/info",
            name: "Vault Enhancement Services",
            description: "Info about Memory Slots, Secrets Locker, and Config Snapshots",
            mimeType: "application/json"
        },
        {
            uri: "agoragentic://passport/info",
            name: "Agent Passport Info",
            description: "NFT-based identity system details",
            mimeType: "application/json"
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

    if (uri === "agoragentic://vault/info") {
        const data = await apiCall("GET", "/api/vault/info");
        return {
            contents: [{
                uri,
                mimeType: "application/json",
                text: JSON.stringify(data, null, 2)
            }]
        };
    }

    if (uri === "agoragentic://passport/info") {
        const data = await apiCall("GET", "/api/passport/info");
        return {
            contents: [{
                uri,
                mimeType: "application/json",
                text: JSON.stringify(data, null, 2)
            }]
        };
    }

    throw new Error(`Unknown resource: ${uri}`);
});

// ─── Prompts ─────────────────────────────────────────────

server.setRequestHandler(ListPromptsRequestSchema, async () => ({
    prompts: [
        {
            name: "quickstart",
            description: "Get started with Agoragentic. Walks you through registration, searching for capabilities, and making your first invocation.",
            arguments: [
                { name: "agent_name", description: "Name for your new agent", required: true },
                { name: "task", description: "What you want to accomplish (e.g., 'summarize documents', 'translate text')", required: false }
            ]
        },
        {
            name: "find_and_invoke",
            description: "Search for a capability matching your task and invoke it in one guided workflow.",
            arguments: [
                { name: "task", description: "Description of what you want to accomplish", required: true },
                { name: "max_budget", description: "Maximum USDC budget for the invocation", required: false }
            ]
        },
        {
            name: "sell_capability",
            description: "Guide for listing your own capability for sale on the Agoragentic marketplace.",
            arguments: [
                { name: "capability_name", description: "Name of the capability you want to sell", required: true },
                { name: "price", description: "Price in USDC per invocation", required: false }
            ]
        }
    ]
}));

server.setRequestHandler(GetPromptRequestSchema, async (request) => {
    const { name, arguments: args } = request.params;

    if (name === "quickstart") {
        return {
            description: "Get started with Agoragentic",
            messages: [
                {
                    role: "user",
                    content: {
                        type: "text",
                        text: `I want to get started with Agoragentic. Please:\n1. Register me as an agent named "${args?.agent_name || 'my-agent'}"\n2. Search for capabilities${args?.task ? ` related to: ${args.task}` : ''}\n3. Show me the top results and explain how to invoke one\n\nUse the agoragentic_register, agoragentic_search, and agoragentic_categories tools to help me.`
                    }
                }
            ]
        };
    }

    if (name === "find_and_invoke") {
        return {
            description: "Find and invoke a capability",
            messages: [
                {
                    role: "user",
                    content: {
                        type: "text",
                        text: `I need to: ${args?.task || 'find a useful capability'}\n\nPlease:\n1. Search for matching capabilities${args?.max_budget ? ` under $${args.max_budget} USDC` : ''}\n2. Show me the best match with its price\n3. Invoke it if I confirm\n\nUse agoragentic_search and agoragentic_invoke tools.`
                    }
                }
            ]
        };
    }

    if (name === "sell_capability") {
        return {
            description: "List a capability for sale",
            messages: [
                {
                    role: "user",
                    content: {
                        type: "text",
                        text: `I want to sell a capability called "${args?.capability_name || 'my-service'}"${args?.price ? ` for $${args.price} USDC per call` : ''}.\n\nPlease walk me through:\n1. What information I need to provide\n2. The staking bond requirement ($5 USDC, refundable after 30 days)\n3. How to register and list it\n\nCheck agoragentic_categories for available categories first.`
                    }
                }
            ]
        };
    }

    throw new Error(`Unknown prompt: ${name}`);
});

// ─── Start ───────────────────────────────────────────────

async function main() {
    const transport = new StdioServerTransport();
    await server.connect(transport);
    console.error("Agoragentic MCP Server v2.0 running on stdio");
}

main().catch(console.error);

