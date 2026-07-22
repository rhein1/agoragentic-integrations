/**
 * Agoragentic OpenAI Agents helpers — TypeScript definitions
 */

import { AgoragenticClient, ExecuteConstraints } from './index';

export interface OpenAIAgentsTraceContext {
    trace_id?: string;
    span_id?: string;
    group_id?: string;
    workflow_name?: string;
    run_id?: string;
    session_id?: string;
    agent_name?: string;
    last_agent_name?: string;
    metadata?: Record<string, any>;
}

export interface OpenAIAgentsTraceBuildOptions extends OpenAIAgentsTraceContext {
    runResult?: any;
    run_result?: any;
    traceId?: string;
    spanId?: string;
    groupId?: string;
    workflowName?: string;
    runId?: string;
    sessionId?: string;
    agentName?: string;
    lastAgentName?: string;
}

export interface OpenAIAgentsTraceAttachOptions extends OpenAIAgentsTraceBuildOptions {
    trace_context?: OpenAIAgentsTraceContext;
    traceContext?: OpenAIAgentsTraceContext;
}

export interface OpenAIAgentsToolRuntimeContext {
    context?: any;
    tool_call_id?: string;
    toolCallId?: string;
    trace_context?: OpenAIAgentsTraceContext;
    traceContext?: OpenAIAgentsTraceContext;
    openai_agents_trace?: OpenAIAgentsTraceContext;
    [key: string]: any;
}

export interface OpenAIAgentsRouterOptions {
    defaultMaxCost?: number;
    default_max_cost?: number;
    requireApprovalAbove?: number;
    require_approval_above?: number;
    traceContext?: OpenAIAgentsTraceContext;
    trace_context?: OpenAIAgentsTraceContext;
    traceContextResolver?: (context: OpenAIAgentsToolRuntimeContext) => OpenAIAgentsTraceContext | null | undefined;
    trace_context_resolver?: (context: OpenAIAgentsToolRuntimeContext) => OpenAIAgentsTraceContext | null | undefined;
    traceWorkflowName?: string;
    trace_workflow_name?: string;
    includeMatch?: boolean;
    include_match?: boolean;
    includeQuote?: boolean;
    include_quote?: boolean;
    includeProcurementCheck?: boolean;
    include_procurement_check?: boolean;
    includeExecute?: boolean;
    include_execute?: boolean;
    includeReceipt?: boolean;
    include_receipt?: boolean;
    includeX402Claim?: boolean;
    include_x402_claim?: boolean;
}

export interface OpenAIAgentsRouterTool {
    type: 'function';
    name: string;
    description: string;
    parameters: Record<string, any>;
    handler: (args?: Record<string, any>, context?: OpenAIAgentsToolRuntimeContext) => Promise<Record<string, any>>;
    needsApproval?: (args?: Record<string, any>) => boolean;
}

export interface OpenAIAgentsRouterToolset {
    match?: OpenAIAgentsRouterTool;
    quote?: OpenAIAgentsRouterTool;
    procurement_check?: OpenAIAgentsRouterTool;
    execute?: OpenAIAgentsRouterTool;
    receipt?: OpenAIAgentsRouterTool;
    x402_claim?: OpenAIAgentsRouterTool;
}

export interface ExecuteIntentReconciliationOptions {
    max_cost?: number;
    maxCost?: number;
    trace_context?: OpenAIAgentsTraceContext;
    traceContext?: OpenAIAgentsTraceContext;
    runResult?: any;
    run_result?: any;
    workflowName?: string;
    workflow_name?: string;
}

export function buildTraceContext(options?: OpenAIAgentsTraceBuildOptions): OpenAIAgentsTraceContext;
export function attachTraceContext(result: Record<string, any>, options?: OpenAIAgentsTraceAttachOptions): Record<string, any>;
export function buildExecuteIntentReconciliation(task: string, inputData?: Record<string, any>, executionResult?: Record<string, any>, options?: ExecuteIntentReconciliationOptions): Record<string, any>;
export function buildRouterToolset(client: AgoragenticClient, options?: OpenAIAgentsRouterOptions): OpenAIAgentsRouterToolset;
export function buildRouterTools(client: AgoragenticClient, options?: OpenAIAgentsRouterOptions): OpenAIAgentsRouterTool[];

export type OpenAIAgentsExecuteConstraints = ExecuteConstraints & {
    openai_agents_trace?: OpenAIAgentsTraceContext;
    openaiAgentsTrace?: OpenAIAgentsTraceContext;
    trace_context?: OpenAIAgentsTraceContext;
    traceContext?: OpenAIAgentsTraceContext;
};
