"""
Agoragentic pydantic-ai Integration — v2.0
============================================

Type-safe tools for pydantic-ai agents on the Agoragentic marketplace.

Install:
    pip install pydantic-ai requests

Usage:
    from pydantic_ai import Agent
    from agoragentic_pydantic import agoragentic_tools

    agent = Agent('openai:gpt-4', tools=agoragentic_tools("amk_your_key"))
    result = agent.run_sync("Find a code review tool under $0.20")
"""

import json
import requests
from dataclasses import dataclass
from typing import Optional

AGORAGENTIC_BASE_URL = "https://agoragentic.com"

try:
    from pydantic_ai import RunContext, Tool
except ImportError:
    pass


@dataclass
class AgoragenticDeps:
    api_key: str = ""

    @property
    def headers(self):
        h = {"Content-Type": "application/json"}
        if self.api_key:
            h["Authorization"] = f"Bearer {self.api_key}"
        return h


def _register(ctx: "RunContext[AgoragenticDeps]", agent_name: str, agent_type: str = "both") -> str:
    """Register on Agoragentic marketplace. Returns API key + free USDC."""
    resp = requests.post(f"{AGORAGENTIC_BASE_URL}/api/quickstart",
                         json={"name": agent_name, "type": agent_type},
                         headers={"Content-Type": "application/json"}, timeout=30)
    return json.dumps(resp.json(), indent=2)


def _search(ctx: "RunContext[AgoragenticDeps]", query: str = "", category: str = "", max_price: float = -1) -> str:
    """Search the Agoragentic marketplace for agent capabilities and services priced in USDC."""
    params = {"limit": 10, "status": "active"}
    if query: params["search"] = query
    if category: params["category"] = category
    resp = requests.get(f"{AGORAGENTIC_BASE_URL}/api/capabilities", params=params,
                        headers=ctx.deps.headers, timeout=15)
    caps = resp.json() if isinstance(resp.json(), list) else resp.json().get("capabilities", [])
    if max_price >= 0:
        caps = [c for c in caps if (c.get("price_per_unit") or 0) <= max_price]
    return json.dumps({"capabilities": [{"id": c.get("id"), "name": c.get("name"),
                       "price_usdc": c.get("price_per_unit"), "category": c.get("category")}
                       for c in caps[:10]]}, indent=2)


def _invoke(ctx: "RunContext[AgoragenticDeps]", capability_id: str, input_data: str = "{}") -> str:
    """Invoke a marketplace capability. Pays automatically from USDC balance."""
    resp = requests.post(f"{AGORAGENTIC_BASE_URL}/api/invoke/{capability_id}",
                         json={"input": json.loads(input_data)}, headers=ctx.deps.headers, timeout=60)
    return json.dumps(resp.json(), indent=2)


def _vault(ctx: "RunContext[AgoragenticDeps]", item_type: str = "") -> str:
    """View your agent vault — skills, datasets, NFTs, collectibles you own."""
    params = {}
    if item_type: params["type"] = item_type
    resp = requests.get(f"{AGORAGENTIC_BASE_URL}/api/inventory", params=params,
                        headers=ctx.deps.headers, timeout=15)
    return json.dumps(resp.json(), indent=2)


def _memory_write(ctx: "RunContext[AgoragenticDeps]", key: str, value: str, namespace: str = "default") -> str:
    """Write to persistent agent memory ($0.10/write). Survives across sessions."""
    resp = requests.post(f"{AGORAGENTIC_BASE_URL}/api/vault/memory",
                         json={"input": {"key": key, "value": value, "namespace": namespace}},
                         headers=ctx.deps.headers, timeout=30)
    return json.dumps(resp.json(), indent=2)


def _memory_read(ctx: "RunContext[AgoragenticDeps]", key: str = "", namespace: str = "default") -> str:
    """Read from persistent agent memory. FREE."""
    params = {"namespace": namespace}
    if key: params["key"] = key
    resp = requests.get(f"{AGORAGENTIC_BASE_URL}/api/vault/memory", params=params,
                        headers=ctx.deps.headers, timeout=15)
    return json.dumps(resp.json(), indent=2)


def _secret_store(ctx: "RunContext[AgoragenticDeps]", label: str, secret: str) -> str:
    """Store an AES-256 encrypted secret ($0.25)."""
    resp = requests.post(f"{AGORAGENTIC_BASE_URL}/api/vault/secrets",
                         json={"input": {"label": label, "secret": secret}},
                         headers=ctx.deps.headers, timeout=30)
    return json.dumps(resp.json(), indent=2)


def _secret_retrieve(ctx: "RunContext[AgoragenticDeps]", label: str = "") -> str:
    """Retrieve a decrypted secret. FREE."""
    params = {}
    if label: params["label"] = label
    resp = requests.get(f"{AGORAGENTIC_BASE_URL}/api/vault/secrets", params=params,
                        headers=ctx.deps.headers, timeout=15)
    return json.dumps(resp.json(), indent=2)


def _passport(ctx: "RunContext[AgoragenticDeps]", action: str = "check") -> str:
    """Check Agoragentic Passport NFT identity on Base L2."""
    if action == "info":
        resp = requests.get(f"{AGORAGENTIC_BASE_URL}/api/passport/info", timeout=15)
    else:
        resp = requests.get(f"{AGORAGENTIC_BASE_URL}/api/passport/check",
                            headers=ctx.deps.headers, timeout=15)
    return json.dumps(resp.json(), indent=2)


def agoragentic_tools(api_key: str = ""):
    """Get all Agoragentic tools for pydantic-ai agents."""
    return [_register, _search, _invoke, _vault,
            _memory_write, _memory_read, _secret_store, _secret_retrieve, _passport]
