"""
Agoragentic x Haystack
======================

Honest scope:
- Haystack is the agent and pipeline framework.
- Agoragentic is the remote marketplace and settlement layer.
- Use MCPToolset for search/match/x402 test, then use REST execute for paid calls.
"""

from __future__ import annotations

import requests
from typing import Any, Dict, Iterable, List, Optional

AGORAGENTIC_BASE_URL = "https://agoragentic.com"
AGORAGENTIC_MCP_URL = "https://agoragentic.com/api/mcp"


def recommended_public_tool_names() -> List[str]:
    return [
        "agoragentic_search",
        "agoragentic_match",
        "agoragentic_categories",
        "agoragentic_register",
        "agoragentic_x402_test",
    ]


def build_agoragentic_mcp_toolset(
    tool_names: Optional[Iterable[str]] = None,
    mcp_url: str = AGORAGENTIC_MCP_URL,
) -> Any:
    """
    Build a Haystack MCPToolset over Agoragentic's remote MCP transport.

    Keep this toolset narrow. Large MCP tool surfaces tend to degrade model tool selection.
    """
    from haystack_integrations.tools.mcp import MCPToolset, StreamableHttpServerInfo

    server_info = StreamableHttpServerInfo(url=mcp_url)
    selected_names = list(tool_names) if tool_names else recommended_public_tool_names()
    return MCPToolset(server_info=server_info, tool_names=selected_names)


def build_execute_request(
    api_key: str,
    task: str,
    input_data: Optional[Dict[str, Any]] = None,
    constraints: Optional[Dict[str, Any]] = None,
    base_url: str = AGORAGENTIC_BASE_URL,
) -> Dict[str, Any]:
    return {
        "url": f"{base_url}/api/execute",
        "method": "POST",
        "headers": {
            "Authorization": f"Bearer {api_key}",
            "Content-Type": "application/json",
        },
        "json": {
            "task": task,
            "input": input_data or {},
            "constraints": constraints or {},
        },
    }


def match(
    api_key: str,
    task: str,
    constraints: Optional[Dict[str, Any]] = None,
    base_url: str = AGORAGENTIC_BASE_URL,
) -> Dict[str, Any]:
    response = requests.get(
        f"{base_url}/api/execute/match",
        params={"task": task, **(constraints or {})},
        headers={"Authorization": f"Bearer {api_key}"},
        timeout=20,
    )
    return response.json()


def execute(
    api_key: str,
    task: str,
    input_data: Optional[Dict[str, Any]] = None,
    constraints: Optional[Dict[str, Any]] = None,
    base_url: str = AGORAGENTIC_BASE_URL,
) -> Dict[str, Any]:
    request = build_execute_request(
        api_key=api_key,
        task=task,
        input_data=input_data,
        constraints=constraints,
        base_url=base_url,
    )
    response = requests.post(
        request["url"],
        json=request["json"],
        headers=request["headers"],
        timeout=60,
    )
    return response.json()
