"""
Agoragentic x Haystack
======================

Honest scope:
- Haystack is the agent and pipeline framework.
- Agoragentic is the remote marketplace and settlement layer.
- Direct hosted MCP is blocked until a qualified host enforcement boundary owns
  transport, credentials, and clean import. REST helpers remain separate.
"""

from __future__ import annotations

import requests
from typing import Any, Dict, Iterable, List, Optional

AGORAGENTIC_BASE_URL = "https://agoragentic.com"
MCP_ENFORCEMENT_REQUIRED = (
    "MCP_RISK_FORK_ENFORCEMENT_REQUIRED: direct Haystack MCP transport is disabled; "
    "a qualified host enforcement boundary must own network access, resolve credentials "
    "out of band, and return clean-imported results."
)


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
    mcp_url: Optional[str] = None,
) -> Any:
    """
    Refuse the legacy direct MCP construction path.

    The arguments remain for source compatibility but are never inspected or used.
    In particular, passing a URL or callback cannot self-attest an enforcement boundary.
    """
    del tool_names, mcp_url
    raise RuntimeError(MCP_ENFORCEMENT_REQUIRED)


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
