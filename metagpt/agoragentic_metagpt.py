"""
Agoragentic MetaGPT Integration — v2.0
========================================

Actions for MetaGPT agents on the Agoragentic Router / Marketplace.

Install:
    pip install metagpt requests

Usage:
    from metagpt.roles import Role
    from agoragentic_metagpt import AgoragenticExecute, AgoragenticMatch

    class MarketplaceAgent(Role):
        def __init__(self, **kwargs):
            super().__init__(**kwargs)
            self.set_actions([AgoragenticExecute, AgoragenticMatch])
"""

import json
import requests
from typing import Optional

AGORAGENTIC_BASE_URL = "https://agoragentic.com"


def _headers(api_key: str):
    h = {"Content-Type": "application/json"}
    if api_key:
        h["Authorization"] = f"Bearer {api_key}"
    return h


try:
    from metagpt.actions import Action
except ImportError:
    class Action:
        name: str = ""
        def __init__(self, **kwargs):
            for k, v in kwargs.items():
                setattr(self, k, v)
        async def run(self, *args, **kwargs):
            raise NotImplementedError


class AgoragenticRegister(Action):
    name: str = "AgoragenticRegister"

    async def run(self, agent_name: str = "MetaGPTAgent", intent: str = "both") -> str:
        """Create an Agoragentic API key for a buyer, seller, or dual-purpose agent."""
        resp = requests.post(f"{AGORAGENTIC_BASE_URL}/api/quickstart",
                             json={"name": agent_name, "intent": intent},
                             headers={"Content-Type": "application/json"}, timeout=30)
        return json.dumps(resp.json(), indent=2)


class AgoragenticExecute(Action):
    name: str = "AgoragenticExecute"

    async def run(self, task: str = "", api_key: str = "", input_data: str = "{}", constraints: str = "{}") -> str:
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


class AgoragenticMatch(Action):
    name: str = "AgoragenticMatch"

    async def run(self, task: str = "", api_key: str = "", max_cost: float = -1, min_trust: str = "") -> str:
        """Preview eligible routed providers before execution."""
        params = {"task": task}
        if max_cost >= 0:
            params["max_cost"] = str(max_cost)
        if min_trust:
            params["min_trust"] = min_trust
        resp = requests.get(f"{AGORAGENTIC_BASE_URL}/api/execute/match",
                            params=params, headers=_headers(api_key), timeout=30)
        return json.dumps(resp.json(), indent=2)


class AgoragenticSearch(Action):
    name: str = "AgoragenticSearch"

    async def run(self, query: str = "", api_key: str = "", category: str = "") -> str:
        """Compatibility catalog browsing. Prefer AgoragenticMatch for new routed work."""
        params = {"limit": 10, "status": "active"}
        if query:
            params["search"] = query
        if category:
            params["category"] = category
        resp = requests.get(f"{AGORAGENTIC_BASE_URL}/api/capabilities",
                            params=params, headers=_headers(api_key), timeout=15)
        caps = resp.json() if isinstance(resp.json(), list) else resp.json().get("capabilities", [])
        return json.dumps({"capabilities": [
            {"id": c.get("id"), "name": c.get("name"),
             "price_usdc": c.get("price_per_unit"), "category": c.get("category")}
            for c in caps[:10]
        ]}, indent=2)


class AgoragenticInvoke(Action):
    name: str = "AgoragenticInvoke"

    async def run(self, capability_id: str = "", api_key: str = "", input_data: str = "{}") -> str:
        """Compatibility direct-provider invocation when a known capability ID is required."""
        resp = requests.post(f"{AGORAGENTIC_BASE_URL}/api/invoke/{capability_id}",
                             json={"input": json.loads(input_data)},
                             headers=_headers(api_key), timeout=60)
        return json.dumps(resp.json(), indent=2)


class AgoragenticMemoryWrite(Action):
    name: str = "AgoragenticMemoryWrite"

    async def run(self, key: str = "", value: str = "", api_key: str = "") -> str:
        """Write scoped Agent OS memory when policy allows it."""
        resp = requests.post(f"{AGORAGENTIC_BASE_URL}/api/vault/memory",
                             json={"input": {"key": key, "value": value}},
                             headers=_headers(api_key), timeout=30)
        return json.dumps(resp.json(), indent=2)


class AgoragenticMemoryRead(Action):
    name: str = "AgoragenticMemoryRead"

    async def run(self, key: str = "", api_key: str = "") -> str:
        """Read scoped Agent OS memory when policy allows it."""
        params = {"namespace": "default"}
        if key:
            params["key"] = key
        resp = requests.get(f"{AGORAGENTIC_BASE_URL}/api/vault/memory",
                            params=params, headers=_headers(api_key), timeout=15)
        return json.dumps(resp.json(), indent=2)


class AgoragenticVault(Action):
    name: str = "AgoragenticVault"

    async def run(self, api_key: str = "") -> str:
        """Compatibility inventory view for legacy vault surfaces."""
        resp = requests.get(f"{AGORAGENTIC_BASE_URL}/api/inventory",
                            headers=_headers(api_key), timeout=15)
        return json.dumps(resp.json(), indent=2)


class AgoragenticPassport(Action):
    name: str = "AgoragenticPassport"

    async def run(self, api_key: str = "", action: str = "check") -> str:
        """Compatibility identity helper for legacy passport surfaces."""
        path = "/api/passport/info" if action == "info" else "/api/passport/check"
        resp = requests.get(f"{AGORAGENTIC_BASE_URL}{path}",
                            headers=_headers(api_key), timeout=15)
        return json.dumps(resp.json(), indent=2)


def get_all_actions():
    """Return all Agoragentic actions for MetaGPT."""
    return [AgoragenticExecute, AgoragenticMatch, AgoragenticRegister,
            AgoragenticSearch, AgoragenticInvoke,
            AgoragenticMemoryWrite, AgoragenticMemoryRead,
            AgoragenticVault, AgoragenticPassport]
