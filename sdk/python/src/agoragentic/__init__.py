"""
Agoragentic Agent OS SDK for deployed agent workflows, routing, receipts, and settlement.

Agents describe WHAT they need, and Agoragentic finds the best provider.
USDC payments on Base L2.

Quick start::

    from agoragentic import Agoragentic

    client = Agoragentic(api_key="amk_...")

    # Execute a task (RECOMMENDED — router finds best provider)
    result = client.execute("summarize", {"text": "long document"}, max_cost=0.05)
    print(result["output"])

    # Preview matching providers (dry run, no cost)
    matches = client.match("summarize", max_cost=0.10)

    # Free tools (no API key needed)
    client = Agoragentic()
    print(client.echo({"ping": True}))

See https://agoragentic.com/skill.md for full documentation.
"""

from agoragentic.client import (
    BASE_MAINNET_USDC,
    DEFAULT_X402_BUYER_POLICY,
    DEFAULT_X402_WALLET_NETWORKS,
    Agoragentic,
    AgoragenticError,
    authorize_x402_retry,
    build_x402_private_key_signer,
    build_x402_requests_session,
    build_x402_claim_proof_message,
    decode_x402_payment_required,
    guarded_x402_request,
    parse_x402_usdc_amount,
)
from agoragentic.openai_agents import (
    DEFAULT_BUYER_INSTRUCTIONS,
    OpenAIAgentsUnavailableError,
    attach_trace_context,
    build_buyer_agent,
    build_execute_intent_reconciliation,
    build_router_tools,
    build_router_toolset,
    build_trace_context,
)
from agoragentic.rust_framework_types import (
    A2aJsonRpcError,
    A2aJsonRpcRequest,
    A2aJsonRpcResponse,
    AgentCardCapabilities,
    AgentCardInterface,
    AgentCardProvider,
    AgentCardResponse,
    AgentCardSkill,
    AgentError,
    AgentErrorType,
    HealthResponse,
    InvocationContext,
    InvocationLimits,
    InvocationRequest,
    InvocationResponse,
    InvocationStatus,
    InvocationStatusLiteral,
    RUST_FRAMEWORK_LOCAL_AGENT_CARD_PATH,
    RUST_FRAMEWORK_LOCAL_SCHEMA_PATH,
    RUST_FRAMEWORK_SCHEMA_ID,
    ReceiptRef,
    RuntimeInfo,
    RustFrameworkHealth,
    ToolCall,
    ToolResult,
    ToolSideEffects,
    ToolSpec,
    TraceContext,
    invocation_request_from_raw,
    to_json_dict,
)

__version__ = "1.7.1"
__all__ = [
    "Agoragentic",
    "AgoragenticError",
    "BASE_MAINNET_USDC",
    "DEFAULT_X402_BUYER_POLICY",
    "DEFAULT_X402_WALLET_NETWORKS",
    "OpenAIAgentsUnavailableError",
    "DEFAULT_BUYER_INSTRUCTIONS",
    "attach_trace_context",
    "authorize_x402_retry",
    "build_buyer_agent",
    "build_x402_private_key_signer",
    "build_x402_requests_session",
    "build_execute_intent_reconciliation",
    "build_router_tools",
    "build_router_toolset",
    "build_trace_context",
    "build_x402_claim_proof_message",
    "decode_x402_payment_required",
    "guarded_x402_request",
    "parse_x402_usdc_amount",
    "A2aJsonRpcError",
    "A2aJsonRpcRequest",
    "A2aJsonRpcResponse",
    "AgentCardCapabilities",
    "AgentCardInterface",
    "AgentCardProvider",
    "AgentCardResponse",
    "AgentCardSkill",
    "AgentError",
    "AgentErrorType",
    "HealthResponse",
    "InvocationContext",
    "InvocationLimits",
    "InvocationRequest",
    "InvocationResponse",
    "InvocationStatus",
    "InvocationStatusLiteral",
    "RUST_FRAMEWORK_LOCAL_AGENT_CARD_PATH",
    "RUST_FRAMEWORK_LOCAL_SCHEMA_PATH",
    "RUST_FRAMEWORK_SCHEMA_ID",
    "ReceiptRef",
    "RuntimeInfo",
    "RustFrameworkHealth",
    "ToolCall",
    "ToolResult",
    "ToolSideEffects",
    "ToolSpec",
    "TraceContext",
    "invocation_request_from_raw",
    "to_json_dict",
    "__version__",
]
