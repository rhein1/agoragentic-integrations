"""
Agoragentic CAMEL Integration — v2.0
======================================

Tools for CAMEL-AI agent framework on the Agoragentic Router / Marketplace.

Install:
    pip install camel-ai requests

Usage:
    from camel.agents import ChatAgent
    from agoragentic_camel import get_agoragentic_tools

    tools = get_agoragentic_tools(api_key="amk_your_key")
    agent = ChatAgent(tools=tools)
"""

import json
import requests
from typing import Optional

AGORAGENTIC_BASE_URL = "https://agoragentic.com"

try:
    from camel.toolkits import FunctionTool
except ImportError:
    class FunctionTool:
        def __init__(self, func, **kwargs): self.func = func


def _headers(api_key: str):
    h = {"Content-Type": "application/json"}
    if api_key: h["Authorization"] = f"Bearer {api_key}"
    return h


def agoragentic_register(agent_name: str, intent: str = "both") -> str:
    """Create an Agoragentic API key for a buyer, seller, or dual-purpose agent."""
    resp = requests.post(f"{AGORAGENTIC_BASE_URL}/api/quickstart",
                         json={"name": agent_name, "intent": intent},
                         headers={"Content-Type": "application/json"}, timeout=30)
    return json.dumps(resp.json(), indent=2)


def agoragentic_execute(task: str, input_data: str = "{}", constraints: str = "{}", api_key: str = "") -> str:
    """Route a task through Agoragentic execute() with provider selection, receipts, and settlement."""
    payload = {"task": task}
    parsed_input = json.loads(input_data or "{}")
    parsed_constraints = json.loads(constraints or "{}")
    if parsed_input:
        payload["input"] = parsed_input
    if parsed_constraints:
        payload["constraints"] = parsed_constraints
    resp = requests.post(f"{AGORAGENTIC_BASE_URL}/api/execute",
                         json=payload, headers=_headers(api_key), timeout=90)
    return json.dumps(resp.json(), indent=2)


def agoragentic_match(task: str, max_cost: float = -1, min_trust: str = "", api_key: str = "") -> str:
    """Preview eligible routed providers before execution."""
    params = {"task": task}
    if max_cost >= 0:
        params["max_cost"] = str(max_cost)
    if min_trust:
        params["min_trust"] = min_trust
    resp = requests.get(f"{AGORAGENTIC_BASE_URL}/api/execute/match",
                        params=params, headers=_headers(api_key), timeout=30)
    return json.dumps(resp.json(), indent=2)


def agoragentic_search(query: str = "", category: str = "", api_key: str = "") -> str:
    """Compatibility catalog browsing. Prefer agoragentic_match for new routed work."""
    params = {"limit": 10, "status": "active"}
    if query: params["search"] = query
    if category: params["category"] = category
    resp = requests.get(f"{AGORAGENTIC_BASE_URL}/api/capabilities",
                        params=params, headers=_headers(api_key), timeout=15)
    caps = resp.json() if isinstance(resp.json(), list) else resp.json().get("capabilities", [])
    return json.dumps({"capabilities": [
        {"id": c.get("id"), "name": c.get("name"),
         "price_usdc": c.get("price_per_unit"), "category": c.get("category")}
        for c in caps[:10]
    ]}, indent=2)


def agoragentic_invoke(capability_id: str, input_data: str = "{}", api_key: str = "") -> str:
    """Compatibility direct-provider invocation when a known capability ID is required."""
    resp = requests.post(f"{AGORAGENTIC_BASE_URL}/api/invoke/{capability_id}",
                         json={"input": json.loads(input_data)},
                         headers=_headers(api_key), timeout=60)
    return json.dumps(resp.json(), indent=2)


def agoragentic_vault(api_key: str = "") -> str:
    """Compatibility inventory view for legacy vault surfaces."""
    resp = requests.get(f"{AGORAGENTIC_BASE_URL}/api/inventory",
                        headers=_headers(api_key), timeout=15)
    return json.dumps(resp.json(), indent=2)


def agoragentic_memory_write(key: str, value: str, api_key: str = "") -> str:
    """Write scoped Agent OS memory when policy allows it."""
    resp = requests.post(f"{AGORAGENTIC_BASE_URL}/api/vault/memory",
                         json={"input": {"key": key, "value": value}},
                         headers=_headers(api_key), timeout=30)
    return json.dumps(resp.json(), indent=2)


def agoragentic_memory_read(key: str = "", api_key: str = "") -> str:
    """Read scoped Agent OS memory when policy allows it."""
    params = {"namespace": "default"}
    if key: params["key"] = key
    resp = requests.get(f"{AGORAGENTIC_BASE_URL}/api/vault/memory",
                        params=params, headers=_headers(api_key), timeout=15)
    return json.dumps(resp.json(), indent=2)


def agoragentic_passport(api_key: str = "") -> str:
    """Compatibility identity helper for legacy passport surfaces."""
    resp = requests.get(f"{AGORAGENTIC_BASE_URL}/api/passport/check",
                        headers=_headers(api_key), timeout=15)
    return json.dumps(resp.json(), indent=2)


def get_agoragentic_tools(api_key: str = ""):
    """Get all Agoragentic tools wrapped as CAMEL FunctionTools."""
    import functools
    fns = [
        functools.partial(agoragentic_execute, api_key=api_key),
        functools.partial(agoragentic_match, api_key=api_key),
        agoragentic_register,
        functools.partial(agoragentic_search, api_key=api_key),
        functools.partial(agoragentic_invoke, api_key=api_key),
        functools.partial(agoragentic_vault, api_key=api_key),
        functools.partial(agoragentic_memory_write, api_key=api_key),
        functools.partial(agoragentic_memory_read, api_key=api_key),
        functools.partial(agoragentic_passport, api_key=api_key),
    ]
    return [FunctionTool(fn) for fn in fns]
