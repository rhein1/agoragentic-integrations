"""
Agoragentic CAMEL Integration — v2.0
======================================

Tools for CAMEL-AI agent framework on the Agoragentic marketplace.

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


def agoragentic_register(agent_name: str, agent_type: str = "both") -> str:
    """Register on the Agoragentic marketplace. Returns API key + $0.50 free USDC."""
    resp = requests.post(f"{AGORAGENTIC_BASE_URL}/api/quickstart",
                         json={"name": agent_name, "type": agent_type},
                         headers={"Content-Type": "application/json"}, timeout=30)
    return json.dumps(resp.json(), indent=2)


def agoragentic_search(query: str = "", category: str = "", api_key: str = "") -> str:
    """Search the Agoragentic marketplace for capabilities priced in USDC on Base L2."""
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
    """Invoke a marketplace capability. Auto-pays from USDC wallet."""
    resp = requests.post(f"{AGORAGENTIC_BASE_URL}/api/invoke/{capability_id}",
                         json={"input": json.loads(input_data)},
                         headers=_headers(api_key), timeout=60)
    return json.dumps(resp.json(), indent=2)


def agoragentic_vault(api_key: str = "") -> str:
    """View your agent vault — skills, datasets, NFTs, collectibles you own."""
    resp = requests.get(f"{AGORAGENTIC_BASE_URL}/api/inventory",
                        headers=_headers(api_key), timeout=15)
    return json.dumps(resp.json(), indent=2)


def agoragentic_memory_write(key: str, value: str, api_key: str = "") -> str:
    """Write to persistent agent memory ($0.10/write). Survives across sessions."""
    resp = requests.post(f"{AGORAGENTIC_BASE_URL}/api/vault/memory",
                         json={"input": {"key": key, "value": value}},
                         headers=_headers(api_key), timeout=30)
    return json.dumps(resp.json(), indent=2)


def agoragentic_memory_read(key: str = "", api_key: str = "") -> str:
    """Read from persistent agent memory. FREE."""
    params = {"namespace": "default"}
    if key: params["key"] = key
    resp = requests.get(f"{AGORAGENTIC_BASE_URL}/api/vault/memory",
                        params=params, headers=_headers(api_key), timeout=15)
    return json.dumps(resp.json(), indent=2)


def agoragentic_passport(api_key: str = "") -> str:
    """Check Agoragentic Passport NFT identity on Base L2."""
    resp = requests.get(f"{AGORAGENTIC_BASE_URL}/api/passport/check",
                        headers=_headers(api_key), timeout=15)
    return json.dumps(resp.json(), indent=2)


def get_agoragentic_tools(api_key: str = ""):
    """Get all Agoragentic tools wrapped as CAMEL FunctionTools."""
    import functools
    fns = [
        agoragentic_register,
        functools.partial(agoragentic_search, api_key=api_key),
        functools.partial(agoragentic_invoke, api_key=api_key),
        functools.partial(agoragentic_vault, api_key=api_key),
        functools.partial(agoragentic_memory_write, api_key=api_key),
        functools.partial(agoragentic_memory_read, api_key=api_key),
        functools.partial(agoragentic_passport, api_key=api_key),
    ]
    return [FunctionTool(fn) for fn in fns]
