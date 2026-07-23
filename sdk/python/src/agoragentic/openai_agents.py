"""
OpenAI Agents SDK helpers for Agoragentic.

This module keeps the boundary explicit:
- OpenAI Agents SDK owns the agent loop, handoffs, approvals, and tracing.
- Agoragentic owns routing, quotes, receipts, spend controls, vault access,
  and USDC settlement.

The dependency on ``openai-agents`` is optional and loaded lazily.
"""

from __future__ import annotations

from typing import Any, Callable, Dict, List, Optional

from agoragentic.client import Agoragentic


DEFAULT_BUYER_INSTRUCTIONS = (
    "Use Agoragentic tools for external paid work. "
    "Prefer match or procurement_check before execute. "
    "Do not exceed explicit max_cost. "
    "Use receipt lookup after paid execution when auditability matters."
)


class OpenAIAgentsUnavailableError(ImportError):
    """Raised when the optional openai-agents dependency is not installed."""


def _load_openai_agents() -> Dict[str, Any]:
    try:
        from agents import Agent, RunContextWrapper, function_tool
    except ImportError as exc:
        raise OpenAIAgentsUnavailableError(
            "openai-agents is not installed. Install it with "
            "`pip install 'agoragentic[openai-agents]'` or `pip install openai-agents`."
        ) from exc
    return {
        "Agent": Agent,
        "RunContextWrapper": RunContextWrapper,
        "function_tool": function_tool,
    }


def build_trace_context(
    *,
    run_result: Any = None,
    trace_id: Optional[str] = None,
    span_id: Optional[str] = None,
    group_id: Optional[str] = None,
    workflow_name: Optional[str] = None,
    run_id: Optional[str] = None,
    session_id: Optional[str] = None,
    agent_name: Optional[str] = None,
    last_agent_name: Optional[str] = None,
    metadata: Optional[Dict[str, Any]] = None,
) -> Dict[str, Any]:
    """Build a lightweight trace envelope to attach to Agoragentic results."""
    resolved_trace_id = trace_id or _read_attr(run_result, "trace_id")
    resolved_span_id = span_id or _read_attr(run_result, "span_id")
    resolved_group_id = group_id or _read_attr(run_result, "group_id")
    resolved_workflow_name = workflow_name or _read_attr(run_result, "workflow_name")
    resolved_run_id = run_id or _read_attr(run_result, "run_id")
    resolved_session_id = session_id or _read_attr(run_result, "session_id")
    resolved_agent_name = agent_name or _read_attr(run_result, "agent_name")
    trace_metadata: Dict[str, Any] = dict(metadata or {})

    last_agent = _read_attr(run_result, "last_agent")
    resolved_last_agent_name = last_agent_name or _read_attr(last_agent, "name")
    if not resolved_agent_name:
        resolved_agent_name = _read_attr(_read_attr(run_result, "agent"), "name")

    final_output = _read_attr(run_result, "final_output")
    if final_output is not None and "has_final_output" not in trace_metadata:
        trace_metadata["has_final_output"] = True

    trace_context = {
        "trace_id": resolved_trace_id,
        "span_id": resolved_span_id,
        "group_id": resolved_group_id,
        "workflow_name": resolved_workflow_name,
        "run_id": resolved_run_id,
        "session_id": resolved_session_id,
        "agent_name": resolved_agent_name,
        "last_agent_name": resolved_last_agent_name,
        "metadata": trace_metadata or None,
    }
    return {key: value for key, value in trace_context.items() if value is not None}


def attach_trace_context(
    result: Dict[str, Any],
    *,
    run_result: Any = None,
    trace_context: Optional[Dict[str, Any]] = None,
    trace_id: Optional[str] = None,
    group_id: Optional[str] = None,
    workflow_name: Optional[str] = None,
    metadata: Optional[Dict[str, Any]] = None,
) -> Dict[str, Any]:
    """Attach OpenAI Agents trace metadata to an Agoragentic result payload."""
    output = dict(result or {})
    resolved_trace_context = trace_context or build_trace_context(
        run_result=run_result,
        trace_id=trace_id,
        group_id=group_id,
        workflow_name=workflow_name,
        metadata=metadata,
    )
    if resolved_trace_context:
        output["openai_agents_trace"] = resolved_trace_context
    return output


def build_execute_intent_reconciliation(
    task: str,
    input_data: Optional[Dict[str, Any]],
    execution_result: Dict[str, Any],
    *,
    max_cost: Optional[float] = None,
    trace_context: Optional[Dict[str, Any]] = None,
    run_result: Any = None,
    workflow_name: Optional[str] = None,
) -> Dict[str, Any]:
    """Build an Agent OS intent-reconciliation payload from a routed execution result."""
    result = dict(execution_result or {})
    provider = dict(result.get("provider") or {})
    receipt = dict(result.get("receipt") or {})
    trace = trace_context or build_trace_context(
        run_result=run_result,
        workflow_name=workflow_name,
    )
    success = bool(result.get("success")) or str(result.get("status") or "").lower() in {
        "success",
        "completed",
        "settled",
    }

    evidence_refs: List[str] = []
    invocation_id = result.get("invocation_id")
    receipt_id = result.get("receipt_id") or receipt.get("receipt_id")
    if invocation_id:
        evidence_refs.append(f"invocation:{invocation_id}")
    if receipt_id:
        evidence_refs.append(f"receipt:{receipt_id}")

    intent_metadata: Dict[str, Any] = {
        "input_keys": sorted((input_data or {}).keys()),
    }
    outcome_metadata: Dict[str, Any] = {
        "provider_id": provider.get("id"),
        "provider_name": provider.get("name"),
        "receipt_id": receipt_id,
        "invocation_id": invocation_id,
    }
    if trace:
        intent_metadata["openai_agents_trace"] = trace
        outcome_metadata["openai_agents_trace"] = trace

    return {
        "intent": {
            "action": "agoragentic_execute",
            "task": task,
            "expected_result": "Marketplace-routed execution completes within spend policy.",
            "max_cost_usdc": max_cost,
            "allowed_side_effects": {
                "paid_invocation": True,
                "external_calls_made": True,
            },
            "metadata": _compact(intent_metadata),
        },
        "outcome": {
            "status": "success" if success else "failed",
            "summary": _summarize_execution_result(task, result),
            "spend_usdc": result.get("cost"),
            "evidence_refs": evidence_refs,
            "side_effects": {
                "paid_invocation": True,
                "external_calls_made": True,
            },
            "metadata": _compact(outcome_metadata),
        },
    }


def build_router_toolset(
    client: Agoragentic,
    *,
    default_max_cost: Optional[float] = None,
    require_approval_above: Optional[float] = None,
    trace_context: Optional[Dict[str, Any]] = None,
    trace_context_resolver: Optional[Callable[[Any], Optional[Dict[str, Any]]]] = None,
    trace_workflow_name: Optional[str] = None,
    include_match: bool = True,
    include_quote: bool = True,
    include_procurement_check: bool = True,
    include_execute: bool = True,
    include_receipt: bool = True,
    include_x402_claim: bool = False,
) -> Dict[str, Any]:
    """Create OpenAI Agents function tools backed by the Agoragentic client."""
    sdk = _load_openai_agents()
    function_tool = sdk["function_tool"]
    RunContextWrapper = sdk["RunContextWrapper"]
    tools: Dict[str, Any] = {}

    def resolve_tool_trace_context(ctx: Any, tool_name: str) -> Optional[Dict[str, Any]]:
        return _resolve_tool_trace_context(
            ctx,
            tool_name=tool_name,
            trace_context=trace_context,
            trace_context_resolver=trace_context_resolver,
            trace_workflow_name=trace_workflow_name,
        )

    async def execute_needs_approval(_ctx: Any, params: Dict[str, Any], _call_id: str) -> bool:
        if require_approval_above is None:
            return False
        effective_max_cost = params.get("max_cost")
        if effective_max_cost is None:
            effective_max_cost = default_max_cost
        if effective_max_cost is None and params.get("quote_id"):
            return False
        if effective_max_cost is None:
            return True
        try:
            return float(effective_max_cost) >= float(require_approval_above)
        except (TypeError, ValueError):
            return True

    if include_match:
        @function_tool
        def agoragentic_match(
            task: str,
            max_cost: Optional[float] = None,
            category: Optional[str] = None,
            max_latency_ms: Optional[int] = None,
            prefer_trusted: bool = True,
            payment_network: Optional[str] = None,
        ) -> Dict[str, Any]:
            """Preview matching providers for a task without spending."""
            return client.match(
                task,
                max_cost=max_cost,
                category=category,
                max_latency_ms=max_latency_ms,
                prefer_trusted=prefer_trusted,
                payment_network=payment_network,
            )

        tools["match"] = agoragentic_match

    if include_quote:
        @function_tool
        def agoragentic_quote(
            capability_id: Optional[str] = None,
            listing_id: Optional[str] = None,
            slug: Optional[str] = None,
            units: Optional[int] = None,
            payment_network: Optional[str] = None,
            payment_asset: Optional[str] = None,
        ) -> Dict[str, Any]:
            """Quote a known listing before spending."""
            reference = _quote_reference(
                capability_id=capability_id,
                listing_id=listing_id,
                slug=slug,
            )
            return client.quote(
                reference,
                units=units,
                payment_network=payment_network,
                payment_asset=payment_asset,
            )

        tools["quote"] = agoragentic_quote

    if include_procurement_check:
        @function_tool
        def agoragentic_procurement_check(
            capability_id: Optional[str] = None,
            listing_id: Optional[str] = None,
            slug: Optional[str] = None,
            quoted_cost_usdc: Optional[float] = None,
        ) -> Dict[str, Any]:
            """Preflight a known listing against policy, budget, and approval state."""
            reference = _quote_reference(
                capability_id=capability_id,
                listing_id=listing_id,
                slug=slug,
            )
            return client.procurement_check(reference, quoted_cost_usdc=quoted_cost_usdc)

        tools["procurement_check"] = agoragentic_procurement_check

    if include_execute:
        execute_decorator = function_tool(
            needs_approval=execute_needs_approval if require_approval_above is not None else False
        )

        @execute_decorator
        def agoragentic_execute(
            ctx: RunContextWrapper[Any],
            task: Optional[str] = None,
            input_data: Optional[Dict[str, Any]] = None,
            max_cost: Optional[float] = None,
            preferred_category: Optional[str] = None,
            max_latency_ms: Optional[int] = None,
            max_retries: Optional[int] = None,
            prefer_trusted: Optional[bool] = None,
            quote_id: Optional[str] = None,
        ) -> Dict[str, Any]:
            """Execute paid routed work through Agoragentic with a hard spend cap."""
            effective_max_cost = max_cost if max_cost is not None else default_max_cost
            if quote_id is None and effective_max_cost is None:
                raise ValueError("agoragentic_execute requires max_cost or quote_id")
            constraints: Dict[str, Any] = {}
            if effective_max_cost is not None:
                constraints["max_cost"] = effective_max_cost
            if preferred_category is not None:
                constraints["preferred_category"] = preferred_category
            if max_latency_ms is not None:
                constraints["max_latency_ms"] = max_latency_ms
            if max_retries is not None:
                constraints["max_retries"] = max_retries
            if prefer_trusted is not None:
                constraints["prefer_trusted"] = prefer_trusted

            body: Dict[str, Any] = {
                "task": task,
                "input": input_data or {},
            }
            if constraints:
                body["constraints"] = constraints
            if quote_id is not None:
                body["quote_id"] = quote_id

            tool_trace = resolve_tool_trace_context(ctx, "agoragentic_execute")
            if tool_trace:
                body["openai_agents_trace"] = tool_trace

            return client._post("/api/execute", body)

        tools["execute"] = agoragentic_execute

    if include_receipt:
        @function_tool
        def agoragentic_receipt(receipt_id: str) -> Dict[str, Any]:
            """Fetch a normalized receipt after a paid routed execution."""
            return client.receipt(receipt_id)

        tools["receipt"] = agoragentic_receipt

    if include_x402_claim:
        @function_tool
        def agoragentic_x402_claim(
            wallet_address: str,
            signature: Optional[str] = None,
            message: Optional[str] = None,
            limit: Optional[int] = None,
            offset: Optional[int] = None,
            include_payload: bool = False,
        ) -> Dict[str, Any]:
            """Build or submit a wallet proof for paid x402 receipt and vault access."""
            return client.x402_claim(
                wallet_address=wallet_address,
                signature=signature,
                message=message,
                limit=limit,
                offset=offset,
                include_payload=include_payload,
            )

        tools["x402_claim"] = agoragentic_x402_claim

    return tools


def build_router_tools(
    client: Agoragentic,
    *,
    default_max_cost: Optional[float] = None,
    require_approval_above: Optional[float] = None,
    trace_context: Optional[Dict[str, Any]] = None,
    trace_context_resolver: Optional[Callable[[Any], Optional[Dict[str, Any]]]] = None,
    trace_workflow_name: Optional[str] = None,
    include_match: bool = True,
    include_quote: bool = True,
    include_procurement_check: bool = True,
    include_execute: bool = True,
    include_receipt: bool = True,
    include_x402_claim: bool = False,
) -> List[Any]:
    """Return Agoragentic-backed OpenAI function tools as a list for ``Agent.tools``."""
    toolset = build_router_toolset(
        client,
        default_max_cost=default_max_cost,
        require_approval_above=require_approval_above,
        trace_context=trace_context,
        trace_context_resolver=trace_context_resolver,
        trace_workflow_name=trace_workflow_name,
        include_match=include_match,
        include_quote=include_quote,
        include_procurement_check=include_procurement_check,
        include_execute=include_execute,
        include_receipt=include_receipt,
        include_x402_claim=include_x402_claim,
    )
    return list(toolset.values())


def build_buyer_agent(
    client: Agoragentic,
    *,
    model: str,
    name: str = "Agoragentic Buyer",
    instructions: Optional[str] = None,
    default_max_cost: Optional[float] = None,
    require_approval_above: Optional[float] = None,
    trace_context: Optional[Dict[str, Any]] = None,
    trace_context_resolver: Optional[Callable[[Any], Optional[Dict[str, Any]]]] = None,
    trace_workflow_name: Optional[str] = None,
    include_x402_claim: bool = False,
    **agent_kwargs: Any,
) -> Any:
    """Build an OpenAI agent with Agoragentic router tools attached."""
    sdk = _load_openai_agents()
    Agent = sdk["Agent"]
    tools = build_router_tools(
        client,
        default_max_cost=default_max_cost,
        require_approval_above=require_approval_above,
        trace_context=trace_context,
        trace_context_resolver=trace_context_resolver,
        trace_workflow_name=trace_workflow_name,
        include_x402_claim=include_x402_claim,
    )
    return Agent(
        name=name,
        model=model,
        instructions=instructions or DEFAULT_BUYER_INSTRUCTIONS,
        tools=tools,
        **agent_kwargs,
    )


def _quote_reference(
    *,
    capability_id: Optional[str] = None,
    listing_id: Optional[str] = None,
    slug: Optional[str] = None,
) -> Dict[str, Any]:
    if capability_id:
        return {"capability_id": capability_id}
    if listing_id:
        return {"listing_id": listing_id}
    if slug:
        return {"slug": slug}
    raise ValueError("capability_id, listing_id, or slug is required")


def _summarize_execution_result(task: str, result: Dict[str, Any]) -> str:
    provider = dict(result.get("provider") or {})
    provider_name = provider.get("name") or provider.get("id") or "unknown provider"
    status = str(result.get("status") or "unknown")
    return f"Task '{task}' completed with status '{status}' via {provider_name}."


def _read_attr(value: Any, attr: str) -> Any:
    if value is None:
        return None
    if hasattr(value, attr):
        return getattr(value, attr)
    if isinstance(value, dict):
        return value.get(attr)
    return None


def _read_trace_value(value: Any, key: str) -> Any:
    if value is None:
        return None
    if isinstance(value, dict):
        return value.get(key)
    if hasattr(value, key):
        return getattr(value, key)
    return None


def _merge_trace_metadata(*values: Optional[Dict[str, Any]]) -> Optional[Dict[str, Any]]:
    merged: Dict[str, Any] = {}
    for value in values:
        if not isinstance(value, dict):
            continue
        for key, entry in value.items():
            if entry is not None:
                merged[str(key)] = entry
    return merged or None


def _resolve_tool_trace_context(
    ctx: Any,
    *,
    tool_name: str,
    trace_context: Optional[Dict[str, Any]] = None,
    trace_context_resolver: Optional[Callable[[Any], Optional[Dict[str, Any]]]] = None,
    trace_workflow_name: Optional[str] = None,
) -> Optional[Dict[str, Any]]:
    resolved: Dict[str, Any] = {}

    if trace_context_resolver is not None:
        resolved_source = trace_context_resolver(ctx)
        if isinstance(resolved_source, dict):
            resolved.update(resolved_source)
    elif isinstance(trace_context, dict):
        resolved.update(trace_context)

    context_value = _read_attr(ctx, "context")
    nested_trace = _read_trace_value(context_value, "openai_agents_trace") or _read_trace_value(
        context_value, "trace_context"
    )
    if isinstance(nested_trace, dict):
        for key, value in nested_trace.items():
            resolved.setdefault(key, value)

    for key in (
        "trace_id",
        "span_id",
        "group_id",
        "workflow_name",
        "run_id",
        "session_id",
        "agent_name",
        "last_agent_name",
    ):
        value = _read_trace_value(context_value, key)
        if value is not None and resolved.get(key) is None:
            resolved[key] = value

    if trace_workflow_name and resolved.get("workflow_name") is None:
        resolved["workflow_name"] = trace_workflow_name

    metadata = _merge_trace_metadata(
        resolved.get("metadata"),
        {
            "tool_name": tool_name,
            "tool_call_id": _read_attr(ctx, "tool_call_id"),
        },
    )
    if metadata:
        resolved["metadata"] = metadata

    return _compact(resolved) or None


def _compact(value: Dict[str, Any]) -> Dict[str, Any]:
    return {key: entry for key, entry in value.items() if entry is not None}
