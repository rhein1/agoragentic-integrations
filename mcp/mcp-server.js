#!/usr/bin/env node
'use strict';

const readline = require('readline');
const crypto = require('crypto');
const { version: PACKAGE_VERSION } = require('./package.json');

const REMOTE_MCP_URL = process.env.AGORAGENTIC_MCP_URL || 'https://agoragentic.com/api/mcp';
const AGORAGENTIC_BASE = process.env.AGORAGENTIC_BASE_URL || 'https://agoragentic.com';
const RAW_API_KEY = process.env.AGORAGENTIC_API_KEY || '';
const PLACEHOLDER_API_KEYS = new Set([
    'amk_glama_test_placeholder',
    'amk_your_key',
    'amk_your_key_here',
    'amk_placeholder',
    'amk_test_placeholder',
]);
const API_KEY = PLACEHOLDER_API_KEYS.has(RAW_API_KEY.trim()) ? '' : RAW_API_KEY.trim();
const ACP_MODE = process.argv.includes('--acp');

const ACP_TOOLS = [
    {
        name: 'agoragentic_execute',
        description: 'Route a task through Agent OS execute() with provider selection, fallback, receipts, and settlement.',
    },
    {
        name: 'agoragentic_match',
        description: 'Preview routed providers before execution.',
    },
    {
        name: 'agoragentic_quote',
        description: 'Create a bounded quote before paid execution.',
    },
    {
        name: 'agoragentic_status',
        description: 'Inspect execution status for an invocation.',
    },
    {
        name: 'agoragentic_receipt',
        description: 'Fetch normalized receipt and settlement metadata.',
    },
    {
        name: 'agoragentic_browse_services',
        description: 'Browse stable x402 edge resources.',
    },
    {
        name: 'agoragentic_call_service',
        description: 'Call a stable x402 edge resource after payment challenge handling.',
    },
    {
        name: 'agoragentic_edge_receipt',
        description: 'Inspect x402 edge receipt metadata.',
    },
    {
        name: 'agoragentic_x402_test',
        description: 'Exercise the free x402 pipeline canary.',
    },
];

function buildJsonContent(data) {
    return {
        content: [
            {
                type: 'text',
                text: typeof data === 'string' ? data : JSON.stringify(data, null, 2),
            },
        ],
    };
}

async function apiCall(method, path, body) {
    const headers = {
        'Content-Type': 'application/json',
        'User-Agent': `agoragentic-mcp/${PACKAGE_VERSION}`,
    };
    if (API_KEY) {
        headers.Authorization = `Bearer ${API_KEY}`;
    }

    const response = await fetch(`${AGORAGENTIC_BASE}${path}`, {
        method,
        headers,
        body: body === undefined ? undefined : JSON.stringify(body),
    });

    const text = await response.text();
    let data;
    try {
        data = text ? JSON.parse(text) : {};
    } catch {
        data = { raw: text };
    }

    if (!response.ok) {
        return {
            ok: false,
            status: response.status,
            error: data.error || data.message || response.statusText,
            details: data,
        };
    }

    return data;
}

function requireApiKey() {
    if (API_KEY) return null;
    return buildJsonContent({
        ok: false,
        error: 'missing_api_key',
        message: 'Set AGORAGENTIC_API_KEY for authenticated Router / Marketplace execution tools. Use agoragentic_register to create a key.',
    });
}

function buildFallbackToolList() {
    return [
        {
            name: 'agoragentic_register',
            description:
                'Register a new agent with the Agoragentic marketplace and receive an API key. ' +
                'Use this as the first step before calling agoragentic_execute, agoragentic_match, or agoragentic_execute_status. ' +
                'This tool is idempotent: registering the same agent name returns the existing API key. ' +
                'No AGORAGENTIC_API_KEY environment variable is required to call this tool. ' +
                'Side effects: creates a persistent agent record on the Agoragentic server if one does not exist. ' +
                'Returns JSON with fields: ok (boolean), api_key (string), agent_id (string), and wallet address. ' +
                'On error, returns JSON with ok:false and an error message string.',
            inputSchema: {
                type: 'object',
                properties: {
                    name: { type: 'string', description: 'Human-readable agent name, e.g. "my-research-agent"' },
                    agent_name: { type: 'string', description: 'Alias for the name field (backward compatibility). Prefer using name instead.' },
                    intent: {
                        type: 'string',
                        enum: ['buyer', 'seller', 'both'],
                        description: 'Agent marketplace role: "buyer" to consume services, "seller" to provide them, or "both"',
                        default: 'buyer',
                    },
                    description: { type: 'string', description: 'One-line summary of what this agent does, e.g. "Summarizes web pages on demand"' },
                },
            },
        },
        {
            name: 'agoragentic_search',
            description:
                'Search the public Agoragentic marketplace for available agent capabilities and services. ' +
                'Use this to discover what services exist before calling agoragentic_execute or agoragentic_match. ' +
                'This is a read-only operation with no side effects and no USDC spend. ' +
                'No AGORAGENTIC_API_KEY is required. ' +
                'Returns JSON with an array of matching capabilities, each containing id, name, description, category, and price_usdc. ' +
                'Returns an empty array when no capabilities match the query.',
            inputSchema: {
                type: 'object',
                properties: {
                    query: { type: 'string', description: 'Free-text search query, e.g. "text summarization" or "web scraping"' },
                    category: { type: 'string', description: 'Filter results by category slug, e.g. "ai-ml", "data", or "web". Omit to search all categories.' },
                    limit: { type: 'number', description: 'Maximum number of results to return (1\u2013100)', default: 10 },
                },
            },
        },
        {
            name: 'agoragentic_preview_x402',
            description:
                'Preview route-first x402-eligible providers for a task WITHOUT registration, an API key, provider execution, or USDC spend. ' +
                'Calls the public GET /api/x402/execute/match endpoint and may return an expiring quote_id for a later x402 paid retry. ' +
                'Use this before agoragentic_register or authenticated agoragentic_match when the buyer has an external Base USDC wallet or wants a zero-auth preview. ' +
                'This is NOT read-only in the catalog sense: it can mint an expiring quote_id. It is still safe because it does not register an agent, execute a provider, move wallet funds, or settle payment. ' +
                'Returns JSON with matched providers, selected_provider, quote (including any quote_id), payment rails, and next-step execution metadata.',
            inputSchema: {
                type: 'object',
                properties: {
                    task: { type: 'string', description: 'Natural-language task to preview, e.g. "receipt reconciliation" or "audit agent discovery for a domain"' },
                    max_cost: { type: 'number', description: 'Maximum acceptable USDC price per call. Defaults server-side when omitted.' },
                    category: { type: 'string', description: 'Optional marketplace category filter.' },
                    max_latency_ms: { type: 'number', description: 'Optional maximum acceptable provider latency in milliseconds.' },
                    prefer_trusted: { type: 'boolean', description: 'When true, ask the router to prefer trusted providers when ranking.', default: false },
                    payment_network: { type: 'string', description: 'Optional requested payment network, e.g. "base" or "eip155:8453".' },
                    payment_asset: { type: 'string', description: 'Optional requested payment asset. Defaults to USDC server-side.' },
                },
                required: ['task'],
            },
        },
        {
            name: 'agoragentic_match',
            description:
                'Preview which providers the Agoragentic Router would select for a given task, without executing or spending USDC. ' +
                'Use this before agoragentic_execute to compare providers, check pricing, and verify availability. ' +
                'This is a read-only, non-destructive operation with no side effects. ' +
                'Requires the AGORAGENTIC_API_KEY environment variable to be set. Returns ok:false with error "missing_api_key" if the key is absent. ' +
                'Returns JSON with matched providers including their trust scores, estimated cost in USDC, and routing rationale.',
            inputSchema: {
                type: 'object',
                properties: {
                    task: { type: 'string', description: 'Natural-language task description to match against providers, e.g. "summarize this article"' },
                    max_cost: { type: 'number', description: 'Maximum acceptable USDC price per call. Providers above this price are excluded from results.' },
                    category: { type: 'string', description: 'Optional category filter to narrow provider matches, e.g. "ai-ml"' },
                    prefer_trusted: { type: 'boolean', description: 'When true, rank verified and trusted providers higher in results', default: true },
                },
                required: ['task'],
            },
        },
        {
            name: 'agoragentic_execute',
            description:
                'Execute a task through the Agoragentic Router / Marketplace. The Router selects a provider, invokes it, and returns the result with a receipt. ' +
                'IMPORTANT: This tool MAY SPEND USDC from the authenticated agent wallet based on the matched provider listing price. ' +
                'This tool is NOT idempotent \u2014 each call creates a new invocation and may incur a charge. ' +
                'Prefer agoragentic_match first to preview providers and pricing without spending. ' +
                'Use agoragentic_search to discover available capabilities before executing. ' +
                'Do NOT call this tool for read-only discovery; use agoragentic_search or agoragentic_match instead. ' +
                'Requires the AGORAGENTIC_API_KEY environment variable. Returns ok:false with error "missing_api_key" if the key is absent. ' +
                'On success, returns JSON with: invocation_id (string), output (provider result object), cost_usdc (number), provider_id (string), and receipt metadata. ' +
                'On failure, returns JSON with ok:false, a status code, and error details describing routing or provider errors.',
            inputSchema: {
                type: 'object',
                properties: {
                    task: {
                        type: 'string',
                        description: 'Natural-language task for the Router to match and execute, e.g. "summarize this article" or "scrape https://example.com"',
                    },
                    input: {
                        type: 'object',
                        description:
                            'Structured input payload forwarded to the matched provider. Shape depends on the provider API. ' +
                            'Example: {"text": "Hello world", "max_sentences": 3}',
                        default: {},
                    },
                    constraints: {
                        type: 'object',
                        description:
                            'Optional routing and budget constraints. Supported fields: max_cost (number, maximum USDC per call), ' +
                            'provider_id (string, pin to a specific provider), category (string). ' +
                            'Example: {"max_cost": 0.05, "category": "ai-ml"}',
                        default: {},
                    },
                    quote_id: {
                        type: 'string',
                        description: 'ID from a prior agoragentic_quote call to lock in a pre-agreed price. Omit for standard dynamic pricing.',
                    },
                    intent_contract_id: {
                        type: 'string',
                        description: 'Agent OS intent contract ID for auditable intent-to-execution tracking. Omit if not using intent contracts.',
                    },
                },
                required: ['task'],
            },
        },
        {
            name: 'agoragentic_execute_status',
            description:
                'Check the status, output, cost, and receipt of a previous agoragentic_execute invocation. ' +
                'Use this to poll for results of async executions or to retrieve receipt metadata after completion. ' +
                'This is a read-only operation with no side effects and no USDC spend. ' +
                'Requires the AGORAGENTIC_API_KEY environment variable. Returns ok:false with error "missing_api_key" if the key is absent. ' +
                'Returns JSON with: status ("pending", "completed", or "failed"), output (provider result), cost_usdc, provider_id, receipt_id, and timestamps. ' +
                'Returns ok:false with error "invalid_invocation_id" if the ID is empty or contains disallowed characters.',
            inputSchema: {
                type: 'object',
                properties: {
                    invocation_id: {
                        type: 'string',
                        description: 'The invocation_id string returned by a prior agoragentic_execute call, e.g. "inv_abc123def456"',
                    },
                },
                required: ['invocation_id'],
            },
        },
    ];
}

function mergeFallbackTools(remoteTools = []) {
    const seen = new Set(remoteTools.map((tool) => tool.name));
    const merged = [...remoteTools];
    for (const tool of buildFallbackToolList()) {
        if (!seen.has(tool.name)) {
            merged.push(tool);
        }
    }
    return merged;
}

const FALLBACK_TOOL_NAMES = new Set(buildFallbackToolList().map((tool) => tool.name));

async function executeFallbackTool(name, args = {}) {
    if (name === 'agoragentic_register') {
        const agentName = args.agent_name || args.name || 'mcp-agent';
        const data = await apiCall('POST', '/api/quickstart', {
            name: agentName,
            intent: args.intent || 'buyer',
            description: args.description || 'Registered through agoragentic-mcp fallback tools.',
        });
        return buildJsonContent(data);
    }

    if (name === 'agoragentic_search') {
        const params = new URLSearchParams();
        if (args.query) params.set('q', args.query);
        if (args.category) params.set('category', args.category);
        if (args.limit !== undefined) params.set('limit', String(args.limit));
        const data = await apiCall('GET', `/api/capabilities?${params.toString()}`);
        return buildJsonContent(data);
    }

    if (name === 'agoragentic_preview_x402') {
        const task = String(args.task || '').trim();
        if (!task) {
            return buildJsonContent({
                ok: false,
                error: 'missing_task',
                message: 'task is required for agoragentic_preview_x402',
            });
        }
        const params = new URLSearchParams();
        params.set('task', task);
        if (args.max_cost !== undefined) params.set('max_cost', String(args.max_cost));
        if (args.category) params.set('category', args.category);
        if (args.max_latency_ms !== undefined) params.set('max_latency_ms', String(args.max_latency_ms));
        if (args.prefer_trusted !== undefined) params.set('prefer_trusted', args.prefer_trusted ? 'true' : 'false');
        if (args.payment_network) params.set('payment_network', args.payment_network);
        if (args.payment_asset) params.set('payment_asset', args.payment_asset);
        const data = await apiCall('GET', `/api/x402/execute/match?${params.toString()}`);
        return buildJsonContent(data);
    }

    if (name === 'agoragentic_match') {
        const missing = requireApiKey();
        if (missing) return missing;
        const params = new URLSearchParams();
        params.set('task', args.task);
        if (args.max_cost !== undefined) params.set('max_cost', String(args.max_cost));
        if (args.category) params.set('category', args.category);
        if (args.prefer_trusted !== undefined) params.set('prefer_trusted', args.prefer_trusted ? 'true' : 'false');
        const data = await apiCall('GET', `/api/execute/match?${params.toString()}`);
        return buildJsonContent(data);
    }

    if (name === 'agoragentic_execute') {
        const missing = requireApiKey();
        if (missing) return missing;
        const payload = {
            task: args.task,
            input: args.input || {},
            constraints: args.constraints || {},
        };
        if (args.quote_id) payload.quote_id = args.quote_id;
        if (args.intent_contract_id) payload.intent_contract_id = args.intent_contract_id;
        const data = await apiCall('POST', '/api/execute', payload);
        return buildJsonContent(data);
    }

    if (name === 'agoragentic_execute_status') {
        const missing = requireApiKey();
        if (missing) return missing;
        const invocationId = String(args.invocation_id || '').replace(/[^a-zA-Z0-9\-_]/g, '');
        if (!invocationId) return buildJsonContent({ ok: false, error: 'invalid_invocation_id' });
        const data = await apiCall('GET', `/api/execute/status/${invocationId}`);
        return buildJsonContent(data);
    }

    return buildJsonContent({
        ok: false,
        error: 'unknown_tool',
        tool: name,
    });
}

function buildRemoteTransport() {
    const { StreamableHTTPClientTransport } = require('@modelcontextprotocol/sdk/client/streamableHttp.js');
    const headers = {};
    if (API_KEY) {
        headers.Authorization = `Bearer ${API_KEY}`;
    }

    return new StreamableHTTPClientTransport(new URL(REMOTE_MCP_URL), {
        requestInit: {
            headers,
        },
    });
}

async function connectRemoteClient() {
    const { Client } = require('@modelcontextprotocol/sdk/client/index.js');
    const transport = buildRemoteTransport();
    const client = new Client(
        { name: 'agoragentic-mcp', version: PACKAGE_VERSION },
        { capabilities: { tools: {}, resources: {}, prompts: {} } }
    );

    client.onerror = (error) => {
        if (!error) return;
        const message = error instanceof Error ? error.message : String(error);
        console.error(`[agoragentic-mcp] remote client error: ${message}`);
    };

    await client.connect(transport);
    return { client, transport };
}

async function runMcpRelay() {
    const { Server } = require('@modelcontextprotocol/sdk/server/index.js');
    const { StdioServerTransport } = require('@modelcontextprotocol/sdk/server/stdio.js');
    const {
        CallToolRequestSchema,
        ListToolsRequestSchema,
        ListResourcesRequestSchema,
        ReadResourceRequestSchema,
        ListPromptsRequestSchema,
        GetPromptRequestSchema,
    } = require('@modelcontextprotocol/sdk/types.js');

    const server = new Server(
        { name: 'agoragentic', version: PACKAGE_VERSION },
        { capabilities: { tools: {}, resources: {}, prompts: {} } }
    );

    let remoteSession = null;
    try {
        remoteSession = await connectRemoteClient();
    } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        console.error(`[agoragentic-mcp] remote relay unavailable, using local fallback tools: ${message}`);
    }

    if (remoteSession) {
        const { client } = remoteSession;
        let remoteToolNames = null;

        async function listRemoteTools(params = {}) {
            const result = await client.listTools(params);
            remoteToolNames = new Set((result.tools || []).map((tool) => tool.name));
            return result;
        }

        async function hasRemoteTool(name) {
            if (!remoteToolNames) {
                await listRemoteTools();
            }
            return remoteToolNames.has(name);
        }

        server.setRequestHandler(ListToolsRequestSchema, async (request) => {
            const result = await listRemoteTools(request.params);
            return {
                ...result,
                tools: mergeFallbackTools(result.tools),
            };
        });

        server.setRequestHandler(CallToolRequestSchema, async (request) => {
            if (FALLBACK_TOOL_NAMES.has(request.params.name) && !(await hasRemoteTool(request.params.name))) {
                return executeFallbackTool(request.params.name, request.params.arguments || {});
            }
            return client.callTool(request.params);
        });

        server.setRequestHandler(ListResourcesRequestSchema, async (request) => {
            return client.listResources(request.params);
        });

        server.setRequestHandler(ReadResourceRequestSchema, async (request) => {
            return client.readResource(request.params);
        });

        server.setRequestHandler(ListPromptsRequestSchema, async (request) => {
            return client.listPrompts(request.params);
        });

        server.setRequestHandler(GetPromptRequestSchema, async (request) => {
            return client.getPrompt(request.params);
        });
    } else {
        server.setRequestHandler(ListToolsRequestSchema, async () => {
            return { tools: buildFallbackToolList() };
        });

        server.setRequestHandler(CallToolRequestSchema, async (request) => {
            return executeFallbackTool(request.params.name, request.params.arguments || {});
        });

        server.setRequestHandler(ListResourcesRequestSchema, async () => {
            return { resources: [] };
        });

        server.setRequestHandler(ReadResourceRequestSchema, async () => {
            throw new Error('Resources are unavailable while the remote Agoragentic MCP relay is unreachable.');
        });

        server.setRequestHandler(ListPromptsRequestSchema, async () => {
            return { prompts: [] };
        });

        server.setRequestHandler(GetPromptRequestSchema, async () => {
            throw new Error('Prompts are unavailable while the remote Agoragentic MCP relay is unreachable.');
        });
    }

    const stdio = new StdioServerTransport();
    await server.connect(stdio);

    const shutdown = async (signal) => {
        console.error(`[agoragentic-mcp] shutting down on ${signal}`);
        if (remoteSession) {
            try {
                await remoteSession.transport.terminateSession();
            } catch {
                // Ignore session teardown failures during local shutdown.
            }
            try {
                await remoteSession.transport.close();
            } catch {
                // Ignore transport close failures during local shutdown.
            }
        }
        process.exit(0);
    };

    process.on('SIGINT', () => {
        void shutdown('SIGINT');
    });
    process.on('SIGTERM', () => {
        void shutdown('SIGTERM');
    });

    if (remoteSession) {
        console.error(`[agoragentic-mcp] stdio relay ${PACKAGE_VERSION} connected to ${REMOTE_MCP_URL}`);
    } else {
        console.error(`[agoragentic-mcp] stdio fallback ${PACKAGE_VERSION} using ${AGORAGENTIC_BASE}`);
    }
}

function buildAcpInitializeResult() {
    return {
        protocolVersion: 1,
        agentInfo: {
            name: 'Agoragentic Agent OS',
            version: PACKAGE_VERSION,
            description:
                'Agent OS integrations for deployed agents and swarms: execute-first routing, receipts, x402 edge calls, and Base USDC settlement.',
            homepage: 'https://agoragentic.com',
        },
        agentCapabilities: {
            tools: true,
            streaming: false,
            resources: false,
            prompts: false,
            loadSession: false,
            promptCapabilities: {
                image: false,
            },
        },
        authMethods: [
            {
                type: 'env',
                name: 'AGORAGENTIC_API_KEY',
                configured: Boolean(API_KEY),
                required: false,
                instructions:
                    'Optional for public discovery and x402 edge calls. Required for authenticated execute/match/status/receipt. Create one with POST /api/quickstart and intent=buyer|seller|both.',
            },
        ],
    };
}

function buildAcpResponse(id, result) {
    return {
        jsonrpc: '2.0',
        id,
        result,
    };
}

function buildAcpError(id, code, message, data) {
    return {
        jsonrpc: '2.0',
        id,
        error: data ? { code, message, data } : { code, message },
    };
}

function writeAcpMessage(message) {
    process.stdout.write(`${JSON.stringify(message)}\n`);
}

function buildAcpSessionId() {
    return `sess_${crypto.randomBytes(12).toString('hex')}`;
}

function extractAcpPromptText(content) {
    if (typeof content === 'string') return content;
    if (!Array.isArray(content)) return '';
    return content
        .map((part) => {
            if (!part || typeof part !== 'object') return '';
            if (part.type === 'text' && typeof part.text === 'string') return part.text;
            return '';
        })
        .filter(Boolean)
        .join('\n');
}

function buildAcpPromptReply(promptText) {
    const suffix = promptText ? ` Prompt received: ${promptText.slice(0, 240)}` : '';
    return [
        'Agoragentic ACP adapter is a tool bridge, not a code-editing chat agent.',
        'Use tools/list, then tools/call with agoragentic_execute, agoragentic_match, agoragentic_quote, agoragentic_receipt, or stable x402 service tools.',
        suffix,
    ]
        .filter(Boolean)
        .join(' ');
}

async function runAcpAdapter() {
    const rl = readline.createInterface({
        input: process.stdin,
        crlfDelay: Infinity,
        terminal: false,
    });

    let remoteSession = null;
    const acpSessions = new Map();

    async function getRemoteSession() {
        if (!remoteSession) {
            remoteSession = await connectRemoteClient();
        }
        return remoteSession;
    }

    async function shutdownRemote() {
        if (!remoteSession) return;
        try {
            await remoteSession.transport.terminateSession();
        } catch {
            // Ignore session teardown failures during local shutdown.
        }
        try {
            await remoteSession.transport.close();
        } catch {
            // Ignore transport close failures during local shutdown.
        }
        remoteSession = null;
    }

    process.on('SIGINT', () => {
        void shutdownRemote().finally(() => process.exit(0));
    });
    process.on('SIGTERM', () => {
        void shutdownRemote().finally(() => process.exit(0));
    });

    console.error(`[agoragentic-mcp] ACP adapter ${PACKAGE_VERSION} ready`);

    for await (const line of rl) {
        if (!line.trim()) continue;

        let request;
        try {
            request = JSON.parse(line);
        } catch (error) {
            writeAcpMessage(buildAcpError(null, -32700, 'Invalid JSON-RPC payload'));
            continue;
        }

        const hasId = Object.prototype.hasOwnProperty.call(request, 'id');
        const id = hasId ? request.id : null;

        function writeResponse(message) {
            if (hasId) writeAcpMessage(message);
        }

        try {
            if (request.method === 'initialize') {
                writeResponse(buildAcpResponse(id, buildAcpInitializeResult()));
            } else if (request.method === 'session/new') {
                const sessionId = buildAcpSessionId();
                acpSessions.set(sessionId, {
                    cwd: request.params?.cwd || process.cwd(),
                    createdAt: new Date().toISOString(),
                    cancelled: false,
                });
                writeResponse(buildAcpResponse(id, { sessionId }));
            } else if (request.method === 'session/prompt') {
                const sessionId = request.params?.sessionId;
                if (!sessionId || !acpSessions.has(sessionId)) {
                    writeResponse(buildAcpError(id, -32602, 'Unknown or missing ACP sessionId'));
                    continue;
                }

                const session = acpSessions.get(sessionId);
                session.cancelled = false;
                const promptText = extractAcpPromptText(request.params?.content);
                const reply = buildAcpPromptReply(promptText);

                writeAcpMessage({
                    jsonrpc: '2.0',
                    method: 'session/update',
                    params: {
                        sessionId,
                        update: {
                            sessionUpdate: 'agent_message_chunk',
                            content: {
                                type: 'text',
                                text: reply,
                            },
                        },
                    },
                });
                writeResponse(buildAcpResponse(id, { stopReason: session.cancelled ? 'cancelled' : 'end_turn' }));
            } else if (request.method === 'session/cancel') {
                const sessionId = request.params?.sessionId;
                if (sessionId && acpSessions.has(sessionId)) {
                    acpSessions.get(sessionId).cancelled = true;
                }
                writeResponse(buildAcpResponse(id, { ok: true }));
            } else if (request.method === 'tools/list') {
                writeResponse(buildAcpResponse(id, { tools: ACP_TOOLS }));
            } else if (request.method === 'tools/call') {
                const { client } = await getRemoteSession();
                const result = await client.callTool(request.params || {});
                writeResponse(buildAcpResponse(id, result));
            } else if (request.method === 'shutdown') {
                await shutdownRemote();
                writeResponse(buildAcpResponse(id, { ok: true }));
            } else {
                writeResponse(
                    buildAcpError(id, -32601, 'Unsupported ACP method', {
                        supported_methods: [
                            'initialize',
                            'session/new',
                            'session/prompt',
                            'session/cancel',
                            'tools/list',
                            'tools/call',
                            'shutdown',
                        ],
                    })
                );
            }
        } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            writeResponse(buildAcpError(id, -32000, message));
        }
    }

    await shutdownRemote();
}

const entrypoint = ACP_MODE ? runAcpAdapter : runMcpRelay;

if (require.main === module) {
    entrypoint().catch((error) => {
        const message = error instanceof Error ? error.stack || error.message : String(error);
        console.error(`[agoragentic-mcp] fatal: ${message}`);
        process.exit(1);
    });
}

module.exports = {
    buildFallbackToolList,
    executeFallbackTool,
};
