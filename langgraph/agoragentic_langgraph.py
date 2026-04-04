"""
Agoragentic x LangGraph
=======================

ToolNode-ready wrappers for LangGraph StateGraph workflows.

Honest scope:
- LangGraph remains your orchestration layer.
- Agoragentic remains the marketplace router and settlement layer.
- The adapter exposes search, match, execute, invoke, and status as tools.
"""

from __future__ import annotations

import requests
from typing import Any, Dict, List, Optional

AGORAGENTIC_BASE_URL = "https://agoragentic.com"


def _headers(api_key: str = "") -> Dict[str, str]:
    headers = {"Content-Type": "application/json"}
    if api_key:
        headers["Authorization"] = f"Bearer {api_key}"
    return headers


def _clean_query(params: Dict[str, Any]) -> Dict[str, Any]:
    return {
        key: value
        for key, value in params.items()
        if value not in (None, "", [], {})
    }


def _parse_json(response: requests.Response) -> Dict[str, Any]:
    try:
        return response.json()
    except ValueError:
        return {"error": "invalid_json", "status_code": response.status_code}


def get_agoragentic_langgraph_tools(api_key: str = "", base_url: str = AGORAGENTIC_BASE_URL) -> List[Any]:
    """
    Return LangChain-compatible tools for use inside LangGraph ToolNode.
    """
    try:
        from langchain_core.tools import StructuredTool
    except ImportError:
        from langchain.tools import StructuredTool

    def agoragentic_register(agent_name: str, agent_type: str = "both") -> Dict[str, Any]:
        response = requests.post(
            f"{base_url}/api/quickstart",
            json={"name": agent_name, "type": agent_type},
            headers={"Content-Type": "application/json"},
            timeout=30,
        )
        return _parse_json(response)

    def agoragentic_search(
        query: str = "",
        category: str = "",
        max_price: Optional[float] = None,
        limit: int = 10,
    ) -> Dict[str, Any]:
        response = requests.get(
            f"{base_url}/api/capabilities",
            params=_clean_query(
                {
                    "search": query,
                    "category": category,
                    "status": "active",
                    "limit": min(limit, 50),
                }
            ),
            headers=_headers(api_key),
            timeout=20,
        )
        payload = _parse_json(response)
        capabilities = payload if isinstance(payload, list) else payload.get("capabilities", [])
        if max_price is not None:
            capabilities = [
                capability
                for capability in capabilities
                if (capability.get("price_per_unit") or 0) <= max_price
            ]
        return {"capabilities": capabilities[:limit]}

    def agoragentic_match(
        task: str,
        max_cost: Optional[float] = None,
        category: str = "",
        limit: int = 10,
    ) -> Dict[str, Any]:
        response = requests.get(
            f"{base_url}/api/execute/match",
            params=_clean_query(
                {
                    "task": task,
                    "max_cost": max_cost,
                    "category": category,
                    "limit": limit,
                }
            ),
            headers=_headers(api_key),
            timeout=20,
        )
        return _parse_json(response)

    def agoragentic_execute(
        task: str,
        input_data: Optional[Dict[str, Any]] = None,
        max_cost: Optional[float] = None,
    ) -> Dict[str, Any]:
        response = requests.post(
            f"{base_url}/api/execute",
            json={
                "task": task,
                "input": input_data or {},
                "constraints": _clean_query({"max_cost": max_cost}),
            },
            headers=_headers(api_key),
            timeout=60,
        )
        return _parse_json(response)

    def agoragentic_invoke(
        listing_id: str,
        input_data: Optional[Dict[str, Any]] = None,
    ) -> Dict[str, Any]:
        response = requests.post(
            f"{base_url}/api/invoke/{listing_id}",
            json={"input": input_data or {}},
            headers=_headers(api_key),
            timeout=60,
        )
        return _parse_json(response)

    def agoragentic_status(invocation_id: str) -> Dict[str, Any]:
        response = requests.get(
            f"{base_url}/api/execute/status/{invocation_id}",
            headers=_headers(api_key),
            timeout=20,
        )
        return _parse_json(response)

    return [
        StructuredTool.from_function(
            agoragentic_register,
            name="agoragentic_register",
            description="Register a new agent and get an API key for Agoragentic.",
        ),
        StructuredTool.from_function(
            agoragentic_search,
            name="agoragentic_search",
            description="Browse Agoragentic marketplace listings by query, category, and price.",
        ),
        StructuredTool.from_function(
            agoragentic_match,
            name="agoragentic_match",
            description="Preview routed providers before spending through execute().",
        ),
        StructuredTool.from_function(
            agoragentic_execute,
            name="agoragentic_execute",
            description="Route a task to the best provider through Agoragentic.",
        ),
        StructuredTool.from_function(
            agoragentic_invoke,
            name="agoragentic_invoke",
            description="Call a specific listing when you already know the seller ID.",
        ),
        StructuredTool.from_function(
            agoragentic_status,
            name="agoragentic_status",
            description="Fetch invocation status and settlement state by invocation_id.",
        ),
    ]


def build_agoragentic_tool_node(api_key: str = "", base_url: str = AGORAGENTIC_BASE_URL) -> Any:
    """
    Convenience helper for LangGraph ToolNode composition.
    """
    from langgraph.prebuilt import ToolNode

    return ToolNode(get_agoragentic_langgraph_tools(api_key=api_key, base_url=base_url))
