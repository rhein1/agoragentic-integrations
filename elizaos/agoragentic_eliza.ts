/**
 * Agoragentic ElizaOS Plugin — v2
 * ===============================
 *
 * Router-first ElizaOS integration for the Agoragentic marketplace.
 * Lead with execute()/match() for task routing. Use direct invoke only
 * when the agent already knows the exact listing ID.
 */

const DEFAULT_BASE_URL = "https://agoragentic.com";

type AnyRecord = Record<string, any>;

interface AgoragenticRuntime {
    cacheManager?: {
        get?: (key: string) => Promise<any>;
        set?: (key: string, value: any) => Promise<void>;
    };
    character?: {
        name?: string;
        settings?: AnyRecord;
    };
    getSetting?: (key: string) => any;
}

interface ApiCallOptions {
    method?: string;
    path: string;
    apiKey?: string | null;
    body?: AnyRecord | null;
    extraHeaders?: Record<string, string>;
}

function resolveSetting(runtime: AgoragenticRuntime, key: string): any {
    return runtime.getSetting?.(key)
        ?? runtime.character?.settings?.secrets?.[key]
        ?? runtime.character?.settings?.[key];
}

async function getCachedApiKey(runtime: AgoragenticRuntime): Promise<string> {
    const cached = await runtime.cacheManager?.get?.("agoragentic_api_key");
    return cached || resolveSetting(runtime, "AGORAGENTIC_API_KEY") || "";
}

function getBaseUrl(runtime: AgoragenticRuntime): string {
    return resolveSetting(runtime, "AGORAGENTIC_BASE_URL") || DEFAULT_BASE_URL;
}

function parseNaturalTask(text: string): string {
    return (text || "")
        .replace(/^(run|use|do|execute|route|find|preview|match|search)\s+/i, "")
        .replace(/\s+(on|through)\s+agoragentic$/i, "")
        .trim();
}

function parseReference(text: string): string | null {
    return text?.match(/(agt_[a-z0-9]+|cap_[a-z0-9]+|[a-f0-9-]{36}|agent:\/\/[a-z0-9._-]+)/i)?.[0] || null;
}

function buildQuery(params: Record<string, any>): string {
    const query = new URLSearchParams();
    for (const [key, value] of Object.entries(params)) {
        if (value === undefined || value === null || value === "") continue;
        query.set(key, String(value));
    }
    const qs = query.toString();
    return qs ? `?${qs}` : "";
}

async function apiCall(runtime: AgoragenticRuntime, options: ApiCallOptions): Promise<any> {
    const headers: Record<string, string> = {
        "Content-Type": "application/json",
        ...(options.extraHeaders || {}),
    };
    if (options.apiKey) headers.Authorization = `Bearer ${options.apiKey}`;

    const response = await fetch(`${getBaseUrl(runtime)}${options.path}`, {
        method: options.method || "GET",
        headers,
        body: options.body ? JSON.stringify(options.body) : undefined,
    });

    const raw = await response.text();
    let payload: any = null;
    try {
        payload = raw ? JSON.parse(raw) : null;
    } catch {
        payload = { raw };
    }

    if (!response.ok) {
        return {
            ok: false,
            status: response.status,
            error: payload?.error || payload?.message || raw || `HTTP ${response.status}`,
            payload,
        };
    }

    return {
        ok: true,
        status: response.status,
        payload,
        headers: {
            paymentReceipt: response.headers.get("Payment-Receipt"),
            paymentResponse: response.headers.get("PAYMENT-RESPONSE"),
        },
    };
}

function formatProvider(provider: AnyRecord): string {
    const seller = provider.seller_name || provider.seller_id || "unknown seller";
    const price = provider.price_per_unit ?? provider.quote?.amount ?? provider.cost ?? "n/a";
    const category = provider.category || provider.selected_category || "uncategorized";
    return `- ${provider.name || provider.id} | ${category} | $${price} | ${seller}`;
}

function formatProviders(list: AnyRecord[]): string {
    return list.slice(0, 5).map(formatProvider).join("\n");
}

function summarizeResult(result: AnyRecord): string {
    const output = result.output ?? result.result ?? result.payload ?? result;
    const text = typeof output === "string" ? output : JSON.stringify(output);
    return text.length > 600 ? `${text.slice(0, 600)}...` : text;
}

const registerAction = {
    name: "AGORAGENTIC_REGISTER",
    description: "Register the current Eliza agent on Agoragentic and cache the returned API key.",
    similes: ["register on agoragentic", "join agoragentic", "get agoragentic api key"],
    validate: async () => true,
    handler: async (runtime: AgoragenticRuntime, message: any) => {
        const agentName = message.content?.name || runtime.character?.name || "ElizaAgent";
        const description = message.content?.description || "ElizaOS agent using Agoragentic execute-first routing";
        const result = await apiCall(runtime, {
            method: "POST",
            path: "/api/quickstart",
            body: {
                name: agentName,
                description,
                type: "both",
            },
        });

        if (!result.ok || !result.payload?.api_key) {
            return { text: `Registration failed: ${result.error}` };
        }

        await runtime.cacheManager?.set?.("agoragentic_api_key", result.payload.api_key);
        return {
            text: `Registered ${agentName}. Cached API key for future marketplace calls. Agent ID: ${result.payload.id || "pending"}.`,
        };
    },
    examples: [[
        { user: "user", content: { text: "Register this Eliza agent on Agoragentic" } },
        { user: "agent", content: { text: "I will register and cache the marketplace API key." } },
    ]],
};

const searchAction = {
    name: "AGORAGENTIC_SEARCH",
    description: "Browse public marketplace capabilities. Use this for rough discovery before a routed preview.",
    similes: ["search agoragentic", "browse marketplace", "find capabilities"],
    validate: async () => true,
    handler: async (runtime: AgoragenticRuntime, message: any) => {
        const query = message.content?.query || parseNaturalTask(message.content?.text || "");
        const result = await apiCall(runtime, {
            path: `/api/capabilities${buildQuery({ search: query, limit: 10 })}`,
            apiKey: await getCachedApiKey(runtime),
        });

        if (!result.ok) return { text: `Search failed: ${result.error}` };

        const capabilities = (Array.isArray(result.payload) ? result.payload : result.payload.capabilities || []).slice(0, 5);
        if (!capabilities.length) return { text: "No matching capabilities found." };
        return { text: `Top marketplace matches:\n${formatProviders(capabilities)}` };
    },
    examples: [[
        { user: "user", content: { text: "Search Agoragentic for research tools" } },
        { user: "agent", content: { text: "I will browse the marketplace and return the best matches." } },
    ]],
};

const matchAction = {
    name: "AGORAGENTIC_MATCH",
    description: "Preview routed providers for a task through GET /api/execute/match. No spend occurs.",
    similes: ["preview providers", "match this task", "route preview"],
    validate: async (runtime: AgoragenticRuntime) => !!(await getCachedApiKey(runtime)),
    handler: async (runtime: AgoragenticRuntime, message: any) => {
        const apiKey = await getCachedApiKey(runtime);
        const task = message.content?.task || parseNaturalTask(message.content?.text || "");
        const maxCost = message.content?.max_cost ?? message.content?.maxCost;
        const result = await apiCall(runtime, {
            path: `/api/execute/match${buildQuery({ task, max_cost: maxCost })}`,
            apiKey,
        });

        if (!result.ok) return { text: `Match failed: ${result.error}` };

        const providers = result.payload.providers || [];
        if (!providers.length) {
            const whyFiltered = result.payload.why_filtered ? JSON.stringify(result.payload.why_filtered) : "No providers matched.";
            return { text: `No eligible providers matched. ${whyFiltered}` };
        }

        return {
            text: [
                `Selected provider: ${result.payload.selected_provider?.name || result.payload.selected_provider?.id || "none"}`,
                result.payload.quote ? `Quote: $${result.payload.quote.amount} ${result.payload.quote.currency || "USDC"}` : null,
                formatProviders(providers),
            ].filter(Boolean).join("\n"),
        };
    },
    examples: [[
        { user: "user", content: { text: "Preview providers for summarizing a long transcript under $0.05" } },
        { user: "agent", content: { text: "I will run a routed match preview before spending." } },
    ]],
};

const executeAction = {
    name: "AGORAGENTIC_EXECUTE",
    description: "Execute a task through Agoragentic's router-first buyer path. This is the default paid integration path.",
    similes: ["execute through agoragentic", "route this task", "buy best provider"],
    validate: async (runtime: AgoragenticRuntime) => !!(await getCachedApiKey(runtime)),
    handler: async (runtime: AgoragenticRuntime, message: any) => {
        const apiKey = await getCachedApiKey(runtime);
        const task = message.content?.task || parseNaturalTask(message.content?.text || "");
        const input = message.content?.input || {};
        const constraints = message.content?.constraints || {};
        const result = await apiCall(runtime, {
            method: "POST",
            path: "/api/execute",
            apiKey,
            body: {
                task,
                input,
                ...constraints,
            },
        });

        if (!result.ok) return { text: `Execute failed: ${result.error}` };

        return {
            text: [
                `Executed ${task || "task"} via ${result.payload.provider?.name || result.payload.seller_name || "selected provider"}.`,
                result.payload.cost !== undefined ? `Cost: $${result.payload.cost} USDC` : null,
                result.payload.receipt_id ? `Receipt: ${result.payload.receipt_id}` : null,
                summarizeResult(result.payload),
            ].filter(Boolean).join("\n"),
        };
    },
    examples: [[
        { user: "user", content: { text: "Use Agoragentic to summarize this memo", task: "summarize", input: { text: "..." }, constraints: { max_cost: 0.05 } } },
        { user: "agent", content: { text: "I will route the task through execute() and return the result." } },
    ]],
};

const invokeAction = {
    name: "AGORAGENTIC_INVOKE",
    description: "Directly invoke a known listing ID. Use only when the agent has already selected a provider.",
    similes: ["invoke listing", "call capability by id", "use exact provider"],
    validate: async (runtime: AgoragenticRuntime) => !!(await getCachedApiKey(runtime)),
    handler: async (runtime: AgoragenticRuntime, message: any) => {
        const apiKey = await getCachedApiKey(runtime);
        const capabilityId = message.content?.capability_id || parseReference(message.content?.text || "");
        if (!capabilityId) return { text: "Invoke requires a concrete capability ID." };

        const result = await apiCall(runtime, {
            method: "POST",
            path: `/api/invoke/${capabilityId}`,
            apiKey,
            body: { input: message.content?.input || {} },
        });

        if (!result.ok) return { text: `Invoke failed: ${result.error}` };

        return {
            text: [
                `Invoked ${capabilityId}.`,
                result.payload.cost !== undefined ? `Cost: $${result.payload.cost} USDC` : null,
                summarizeResult(result.payload),
            ].filter(Boolean).join("\n"),
        };
    },
    examples: [[
        { user: "user", content: { text: "Invoke capability cap_123 with this payload", capability_id: "cap_123", input: { text: "..." } } },
        { user: "agent", content: { text: "I will call the exact listing directly." } },
    ]],
};

const x402TestAction = {
    name: "AGORAGENTIC_X402_TEST",
    description: "Hit the free anonymous x402 echo endpoint to verify payment-stack compatibility without spending.",
    similes: ["test x402", "check anonymous buyer flow", "echo through x402"],
    validate: async () => true,
    handler: async (runtime: AgoragenticRuntime, message: any) => {
        const method = (message.content?.method || "POST").toUpperCase();
        const result = await apiCall(runtime, {
            method,
            path: "/api/x402/test/echo",
            body: method === "POST" ? { input: message.content?.input || { text: message.content?.text || "hello" } } : null,
        });

        if (!result.ok) return { text: `x402 test failed: ${result.error}` };
        return {
            text: `x402 test succeeded. ${summarizeResult(result.payload)}`,
        };
    },
    examples: [[
        { user: "user", content: { text: "Run the free x402 test echo" } },
        { user: "agent", content: { text: "I will hit the anonymous x402 test endpoint." } },
    ]],
};

const passportIdentityAction = {
    name: "AGORAGENTIC_PASSPORT_IDENTITY",
    description: "Read the public passport identity bridge for an agent ID, agent:// URI, or known marketplace ref.",
    similes: ["passport identity", "lookup passport", "check agent signing identity"],
    validate: async () => true,
    handler: async (runtime: AgoragenticRuntime, message: any) => {
        const ref = message.content?.agentRef || parseReference(message.content?.text || "") || resolveSetting(runtime, "AGORAGENTIC_AGENT_REF");
        if (!ref) return { text: "Passport identity lookup needs an agent ref, agent:// URI, or explicit AGORAGENTIC_AGENT_REF setting." };

        const result = await apiCall(runtime, {
            path: `/api/passport/identity/${encodeURIComponent(ref)}`,
            apiKey: await getCachedApiKey(runtime),
        });

        if (!result.ok) return { text: `Passport lookup failed: ${result.error}` };
        return { text: summarizeResult(result.payload) };
    },
    examples: [[
        { user: "user", content: { text: "Check the passport identity for agent://my-research-bot" } },
        { user: "agent", content: { text: "I will read the public identity bridge for that agent." } },
    ]],
};

export const agoragenticPlugin = {
    name: "agoragentic",
    description: "Router-first marketplace access for ElizaOS. Match and execute tasks, test x402, and inspect passport identity on Base.",
    actions: [
        registerAction,
        searchAction,
        matchAction,
        executeAction,
        invokeAction,
        x402TestAction,
        passportIdentityAction,
    ],
    evaluators: [],
    providers: [],
    services: [],
};

export default agoragenticPlugin;
