/**
 * Static TypeScript compatibility declarations for Agoragentic Rust framework
 * HTTP/JSON runtimes.
 *
 * Schema artifact:
 * https://agoragentic.com/schema/agoragentic-rust-framework.v1.json
 *
 * Regenerate the schema snapshot with:
 * cargo run -p agoragentic-runtime --example export_schema
 */

export declare const RUST_FRAMEWORK_SCHEMA_ID: "https://agoragentic.com/schema/agoragentic-rust-framework.v1.json";
export declare const RUST_FRAMEWORK_LOCAL_SCHEMA_PATH: "/schema/agoragentic-rust-framework.json";
export declare const RUST_FRAMEWORK_LOCAL_AGENT_CARD_PATH: "/.well-known/agent-card.json";

export type JsonPrimitive = string | number | boolean | null;
export type JsonValue = JsonPrimitive | JsonObject | JsonValue[];

export interface JsonObject {
    [key: string]: JsonValue;
}

export type InvocationStatus =
    | "accepted"
    | "running"
    | "completed"
    | "failed"
    | "blocked"
    | "cancelled";

export type AgentErrorType =
    | "Serialization"
    | "Tool"
    | "DuplicateTool"
    | "Provider"
    | "InvalidRequest"
    | "NotFound"
    | "PolicyBlocked"
    | "Runtime";

export interface AgentError {
    type: AgentErrorType | string;
    message: string;
}

export interface TraceContext {
    trace_id?: string | null;
    parent_span_id?: string | null;
    marketplace_invocation_id?: string | null;
}

export interface ReceiptRef {
    receipt_id: string;
    vendor_id: string;
    amount_usdc: string;
}

export interface InvocationContext {
    messages?: JsonValue[];
    memory_refs?: string[];
    receipt_refs?: ReceiptRef[];
}

export interface InvocationLimits {
    timeout_ms?: number;
    max_tokens?: number;
    max_cost_usdc?: string;
}

export interface InvocationRequest {
    request_id?: string | null;
    agent_id?: string | null;
    task?: string | null;
    input: JsonValue;
    context?: InvocationContext;
    trace?: TraceContext | null;
    limits?: InvocationLimits;
}

export interface InvocationResponse {
    request_id?: string | null;
    agent_id?: string | null;
    status: InvocationStatus;
    output?: JsonValue | null;
    tool_calls?: JsonValue[];
    memory_refs?: string[];
    events?: JsonValue[];
    error?: AgentError | null;
    trace?: TraceContext | null;
}

export interface ToolSideEffects {
    network: boolean;
    filesystem: boolean;
    wallet: boolean;
    external_write: boolean;
}

export interface ToolSpec {
    name: string;
    description?: string;
    input_schema?: JsonValue | null;
    output_schema?: JsonValue | null;
    side_effects?: ToolSideEffects;
}

export interface ToolCall {
    call_id: string;
    name: string;
    input: JsonValue;
}

export interface ToolResult {
    call_id: string;
    name: string;
    output: JsonValue | null;
    error: string | null;
}

export interface RuntimeInfo {
    language: "rust";
    transport: "http-json";
    harness_compatible: boolean;
}

export interface RustFrameworkHealth {
    status: "ok";
    framework: "agoragentic-rust";
    framework_version: string;
    agent_id: string;
    runtime: RuntimeInfo;
}

export type HealthResponse = RustFrameworkHealth;

export interface AgentCardInterface {
    url: string;
    protocolBinding: "HTTP+JSON" | string;
    protocolVersion: string;
}

export interface AgentCardProvider {
    organization: string;
    url: string;
}

export interface AgentCardCapabilities {
    streaming: boolean;
    pushNotifications: boolean;
    stateTransitionHistory: boolean;
    extendedAgentCard: boolean;
}

export interface AgentCardSkill {
    id: string;
    name: string;
    description: string;
    tags: string[];
    inputModes: string[];
    outputModes: string[];
}

export interface AgentCardResponse {
    name: string;
    description: string;
    supportedInterfaces: AgentCardInterface[];
    provider: AgentCardProvider;
    version: string;
    documentationUrl: string;
    capabilities: AgentCardCapabilities;
    defaultInputModes: string[];
    defaultOutputModes: string[];
    skills: AgentCardSkill[];
    extensions: JsonObject;
}

export interface A2aJsonRpcRequest {
    jsonrpc: "2.0" | string;
    method: string;
    params?: JsonValue | null;
    id?: JsonValue | null;
}

export interface A2aJsonRpcError {
    code: number;
    message: string;
    data?: JsonValue | null;
}

export interface A2aJsonRpcResponse {
    jsonrpc: "2.0" | string;
    id?: JsonValue | null;
    result?: JsonValue | null;
    error?: A2aJsonRpcError | null;
}

export interface RustFrameworkSchemaDocument {
    [key: string]: JsonValue | undefined;
    $schema?: string;
    $id?: typeof RUST_FRAMEWORK_SCHEMA_ID;
    title?: "FrameworkSchema" | string;
    description?: string;
    definitions?: JsonObject;
    $defs?: JsonObject;
}
