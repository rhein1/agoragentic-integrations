'use strict';

function buildTraceContext(options = {}) {
    const runResult = options.runResult || options.run_result;
    const traceMetadata = {
        ...normalizeMetadata(options.metadata),
    };

    const lastAgent = readAttr(runResult, 'last_agent');
    const finalOutput = readAttr(runResult, 'final_output');
    if (finalOutput !== undefined && finalOutput !== null && traceMetadata.has_final_output === undefined) {
        traceMetadata.has_final_output = true;
    }

    const traceContext = {
        trace_id: options.trace_id || options.traceId || readAttr(runResult, 'trace_id'),
        span_id: options.span_id || options.spanId || readAttr(runResult, 'span_id'),
        group_id: options.group_id || options.groupId || readAttr(runResult, 'group_id'),
        workflow_name: options.workflow_name || options.workflowName || readAttr(runResult, 'workflow_name'),
        run_id: options.run_id || options.runId || readAttr(runResult, 'run_id'),
        session_id: options.session_id || options.sessionId || readAttr(runResult, 'session_id'),
        agent_name: options.agent_name || options.agentName || readAttr(runResult, 'agent_name') || readAttr(readAttr(runResult, 'agent'), 'name'),
        last_agent_name: options.last_agent_name || options.lastAgentName || readAttr(lastAgent, 'name'),
        metadata: Object.keys(traceMetadata).length > 0 ? traceMetadata : undefined,
    };
    return compact(traceContext);
}

function attachTraceContext(result, options = {}) {
    const output = { ...(result || {}) };
    const traceContext = options.trace_context
        || options.traceContext
        || buildTraceContext(options);
    if (traceContext && Object.keys(traceContext).length > 0) {
        output.openai_agents_trace = traceContext;
    }
    return output;
}

function buildExecuteIntentReconciliation(task, inputData, executionResult, options = {}) {
    const result = { ...(executionResult || {}) };
    const provider = asObject(result.provider);
    const receipt = asObject(result.receipt);
    const traceContext = options.trace_context
        || options.traceContext
        || buildTraceContext({
            runResult: options.runResult || options.run_result,
            workflowName: options.workflowName || options.workflow_name,
        });

    const success = Boolean(result.success) || ['success', 'completed', 'settled'].includes(
        String(result.status || '').toLowerCase()
    );

    const evidenceRefs = [];
    const invocationId = result.invocation_id;
    const receiptId = result.receipt_id || receipt.receipt_id;
    if (invocationId) evidenceRefs.push(`invocation:${invocationId}`);
    if (receiptId) evidenceRefs.push(`receipt:${receiptId}`);

    const intentMetadata = {
        input_keys: Object.keys(asObject(inputData)).sort(),
    };
    const outcomeMetadata = {
        provider_id: provider.id,
        provider_name: provider.name,
        receipt_id: receiptId,
        invocation_id: invocationId,
    };

    if (traceContext && Object.keys(traceContext).length > 0) {
        intentMetadata.openai_agents_trace = traceContext;
        outcomeMetadata.openai_agents_trace = traceContext;
    }

    return {
        intent: {
            action: 'agoragentic_execute',
            task,
            expected_result: 'Marketplace-routed execution completes within spend policy.',
            max_cost_usdc: options.max_cost ?? options.maxCost ?? null,
            allowed_side_effects: {
                paid_invocation: true,
                external_calls_made: true,
            },
            metadata: compact(intentMetadata),
        },
        outcome: {
            status: success ? 'success' : 'failed',
            summary: summarizeExecutionResult(task, result),
            spend_usdc: result.cost,
            evidence_refs: evidenceRefs,
            side_effects: {
                paid_invocation: true,
                external_calls_made: true,
            },
            metadata: compact(outcomeMetadata),
        },
    };
}

function buildRouterToolset(client, options = {}) {
    assertClient(client);

    const defaultMaxCost = options.defaultMaxCost ?? options.default_max_cost;
    const requireApprovalAbove = options.requireApprovalAbove ?? options.require_approval_above;
    const traceContext = options.traceContext || options.trace_context;
    const traceContextResolver = options.traceContextResolver || options.trace_context_resolver;
    const traceWorkflowName = options.traceWorkflowName || options.trace_workflow_name;
    const includeMatch = options.includeMatch !== false && options.include_match !== false;
    const includeQuote = options.includeQuote !== false && options.include_quote !== false;
    const includeProcurementCheck = options.includeProcurementCheck !== false && options.include_procurement_check !== false;
    const includeExecute = options.includeExecute !== false && options.include_execute !== false;
    const includeReceipt = options.includeReceipt !== false && options.include_receipt !== false;
    const includeX402Claim = options.includeX402Claim === true || options.include_x402_claim === true;

    const toolset = {};

    if (includeMatch) {
        toolset.match = createTool({
            name: 'agoragentic_match',
            description: 'Preview matching providers for a task without spending.',
            parameters: {
                type: 'object',
                properties: {
                    task: { type: 'string', description: 'Task description for routing.' },
                    max_cost: { type: 'number', description: 'Maximum spend in USDC.' },
                    category: { type: 'string', description: 'Optional category preference.' },
                    max_latency_ms: { type: 'integer', description: 'Maximum acceptable latency in milliseconds.' },
                    prefer_trusted: { type: 'boolean', description: 'Prefer higher-trust providers when available.' },
                    payment_network: { type: 'string', description: 'Optional payment network constraint.' },
                },
                required: ['task'],
            },
            handler: async (args = {}) => client.match(args.task, compact({
                max_cost: args.max_cost,
                category: args.category,
                max_latency_ms: args.max_latency_ms,
                prefer_trusted: args.prefer_trusted,
                payment_network: args.payment_network,
            })),
        });
    }

    if (includeQuote) {
        toolset.quote = createTool({
            name: 'agoragentic_quote',
            description: 'Quote a known listing before spending.',
            parameters: {
                type: 'object',
                properties: {
                    capability_id: { type: 'string' },
                    listing_id: { type: 'string' },
                    slug: { type: 'string' },
                    units: { type: 'integer' },
                    payment_network: { type: 'string' },
                    payment_asset: { type: 'string' },
                },
            },
            handler: async (args = {}) => client.quote(
                quoteReference(args),
                compact({
                    units: args.units,
                    payment_network: args.payment_network,
                    payment_asset: args.payment_asset,
                })
            ),
        });
    }

    if (includeProcurementCheck) {
        toolset.procurement_check = createTool({
            name: 'agoragentic_procurement_check',
            description: 'Preflight a known listing against policy, budget, and approval state.',
            parameters: {
                type: 'object',
                properties: {
                    capability_id: { type: 'string' },
                    listing_id: { type: 'string' },
                    slug: { type: 'string' },
                    quoted_cost_usdc: { type: 'number' },
                },
            },
            handler: async (args = {}) => client.procurementCheck(
                quoteReference(args),
                compact({
                    quotedCostUsdc: args.quoted_cost_usdc,
                })
            ),
        });
    }

    if (includeExecute) {
        toolset.execute = createTool({
            name: 'agoragentic_execute',
            description: 'Execute paid routed work through Agoragentic with a hard spend cap.',
            parameters: {
                type: 'object',
                properties: {
                    task: { type: 'string', description: 'Task description for routing.' },
                    input_data: { type: 'object', description: 'Task input payload.', default: {} },
                    input: { type: 'object', description: 'Alias for input_data.', default: {} },
                    max_cost: { type: 'number', description: 'Maximum spend in USDC.' },
                    preferred_category: { type: 'string' },
                    max_latency_ms: { type: 'integer' },
                    max_retries: { type: 'integer' },
                    prefer_trusted: { type: 'boolean' },
                    quote_id: { type: 'string', description: 'Durable quote ID to consume.' },
                },
            },
            needsApproval: (args = {}) => executeNeedsApproval(args, defaultMaxCost, requireApprovalAbove),
            handler: async (args = {}, context = {}) => {
                const effectiveMaxCost = args.max_cost ?? defaultMaxCost;
                if (args.quote_id == null && effectiveMaxCost == null) {
                    throw new Error('agoragentic_execute requires max_cost or quote_id');
                }

                const constraints = compact({
                    max_cost: effectiveMaxCost,
                    preferred_category: args.preferred_category,
                    max_latency_ms: args.max_latency_ms,
                    max_retries: args.max_retries,
                    prefer_trusted: args.prefer_trusted,
                    quote_id: args.quote_id,
                    openai_agents_trace: resolveToolTraceContext(context, {
                        toolName: 'agoragentic_execute',
                        traceContext,
                        traceContextResolver,
                        traceWorkflowName,
                    }),
                });

                return client.execute(
                    args.task || null,
                    args.input_data || args.input || {},
                    constraints
                );
            },
        });
    }

    if (includeReceipt) {
        toolset.receipt = createTool({
            name: 'agoragentic_receipt',
            description: 'Fetch a normalized receipt after a paid routed execution.',
            parameters: {
                type: 'object',
                properties: {
                    receipt_id: { type: 'string', description: 'Receipt or invocation ID.' },
                },
                required: ['receipt_id'],
            },
            handler: async (args = {}) => client.receipt(args.receipt_id),
        });
    }

    if (includeX402Claim) {
        toolset.x402_claim = createTool({
            name: 'agoragentic_x402_claim',
            description: 'Build or submit a wallet proof for paid x402 receipt and vault access.',
            parameters: {
                type: 'object',
                properties: {
                    wallet_address: { type: 'string' },
                    signature: { type: 'string' },
                    message: { type: 'string' },
                    limit: { type: 'integer' },
                    offset: { type: 'integer' },
                    include_payload: { type: 'boolean' },
                },
                required: ['wallet_address'],
            },
            handler: async (args = {}) => client.x402Claim(compact({
                wallet_address: args.wallet_address,
                proof: compact({
                    message: args.message,
                    signature: args.signature,
                }),
                limit: args.limit,
                offset: args.offset,
                include_payload: args.include_payload,
            })),
        });
    }

    return toolset;
}

function buildRouterTools(client, options = {}) {
    return Object.values(buildRouterToolset(client, options));
}

function createTool({ name, description, parameters, handler, needsApproval }) {
    const tool = {
        type: 'function',
        name,
        description,
        parameters,
        handler,
    };
    if (typeof needsApproval === 'function') {
        tool.needsApproval = needsApproval;
    }
    return tool;
}

function executeNeedsApproval(args, defaultMaxCost, requireApprovalAbove) {
    if (requireApprovalAbove == null) return false;
    const effectiveMaxCost = args.max_cost ?? defaultMaxCost;
    if (effectiveMaxCost == null && args.quote_id) return false;
    if (effectiveMaxCost == null) return true;
    const numeric = Number(effectiveMaxCost);
    if (!Number.isFinite(numeric)) return true;
    return numeric >= Number(requireApprovalAbove);
}

function resolveToolTraceContext(context, options = {}) {
    const resolved = {};
    const traceContextResolver = options.traceContextResolver;
    const staticTraceContext = options.traceContext;

    if (typeof traceContextResolver === 'function') {
        const dynamicTrace = traceContextResolver(context);
        if (dynamicTrace && typeof dynamicTrace === 'object' && !Array.isArray(dynamicTrace)) {
            Object.assign(resolved, dynamicTrace);
        }
    } else if (staticTraceContext && typeof staticTraceContext === 'object' && !Array.isArray(staticTraceContext)) {
        Object.assign(resolved, staticTraceContext);
    }

    const contextValue = readAttr(context, 'context') || context;
    const nestedTrace = readTraceValue(contextValue, 'openai_agents_trace') || readTraceValue(contextValue, 'trace_context');
    if (nestedTrace && typeof nestedTrace === 'object' && !Array.isArray(nestedTrace)) {
        for (const [key, value] of Object.entries(nestedTrace)) {
            if (resolved[key] === undefined && value !== undefined) {
                resolved[key] = value;
            }
        }
    }

    for (const key of ['trace_id', 'span_id', 'group_id', 'workflow_name', 'run_id', 'session_id', 'agent_name', 'last_agent_name']) {
        const value = readTraceValue(contextValue, key);
        if (value !== undefined && resolved[key] === undefined) {
            resolved[key] = value;
        }
    }

    if ((options.traceWorkflowName || options.trace_workflow_name) && resolved.workflow_name === undefined) {
        resolved.workflow_name = options.traceWorkflowName || options.trace_workflow_name;
    }

    const metadata = mergeMetadata(
        resolved.metadata,
        {
            tool_name: options.toolName,
            tool_call_id: readAttr(context, 'tool_call_id') || readAttr(context, 'toolCallId'),
        }
    );
    if (metadata) {
        resolved.metadata = metadata;
    }

    const compacted = compact(resolved);
    return Object.keys(compacted).length > 0 ? compacted : null;
}

function quoteReference(args = {}) {
    if (args.capability_id) return { capability_id: args.capability_id };
    if (args.listing_id) return { listing_id: args.listing_id };
    if (args.slug) return { slug: args.slug };
    throw new Error('capability_id, listing_id, or slug is required');
}

function summarizeExecutionResult(task, result) {
    const provider = asObject(result.provider);
    const providerName = provider.name || provider.id || 'unknown provider';
    const status = String(result.status || 'unknown');
    return `Task '${task}' completed with status '${status}' via ${providerName}.`;
}

function assertClient(client) {
    if (!client || typeof client.execute !== 'function' || typeof client.receipt !== 'function') {
        throw new Error('buildRouterToolset requires an Agoragentic client with execute() and receipt() methods');
    }
}

function readAttr(value, attr) {
    if (value == null) return undefined;
    if (typeof value === 'object' && Object.prototype.hasOwnProperty.call(value, attr)) {
        return value[attr];
    }
    return value[attr];
}

function readTraceValue(value, key) {
    if (value == null) return undefined;
    if (typeof value === 'object' && Object.prototype.hasOwnProperty.call(value, key)) {
        return value[key];
    }
    return value[key];
}

function normalizeMetadata(value) {
    return value && typeof value === 'object' && !Array.isArray(value)
        ? { ...value }
        : {};
}

function mergeMetadata(...values) {
    const merged = {};
    for (const value of values) {
        if (!value || typeof value !== 'object' || Array.isArray(value)) continue;
        for (const [key, entry] of Object.entries(value)) {
            if (entry !== undefined) {
                merged[String(key)] = entry;
            }
        }
    }
    return Object.keys(merged).length > 0 ? merged : null;
}

function compact(value) {
    return Object.fromEntries(
        Object.entries(value || {}).filter(([, entry]) => entry !== undefined && entry !== null)
    );
}

function asObject(value) {
    return value && typeof value === 'object' && !Array.isArray(value)
        ? value
        : {};
}

module.exports = {
    buildTraceContext,
    attachTraceContext,
    buildExecuteIntentReconciliation,
    buildRouterToolset,
    buildRouterTools,
};
