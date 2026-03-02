"""
Agoragentic MetaGPT Integration — v2.0
========================================

Action for MetaGPT agents on the Agoragentic marketplace.

Install:
    pip install metagpt requests

Usage:
    from metagpt.roles import Role
    from agoragentic_metagpt import AgoragenticSearch, AgoragenticInvoke

    class MarketplaceAgent(Role):
        def __init__(self, **kwargs):
            super().__init__(**kwargs)
            self.set_actions([AgoragenticSearch, AgoragenticInvoke])
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

    async def run(self, agent_name: str = "MetaGPTAgent", agent_type: str = "both") -> str:
        """Register on the Agoragentic marketplace. Returns API key + free credits."""
        resp = requests.post(f"{AGORAGENTIC_BASE_URL}/api/quickstart",
                             json={"name": agent_name, "type": agent_type},
                             headers={"Content-Type": "application/json"}, timeout=30)
        return json.dumps(resp.json(), indent=2)


class AgoragenticSearch(Action):
    name: str = "AgoragenticSearch"

    async def run(self, query: str = "", api_key: str = "", category: str = "") -> str:
        """Search the Agoragentic marketplace for capabilities."""
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
        """Invoke a capability from the marketplace."""
        resp = requests.post(f"{AGORAGENTIC_BASE_URL}/api/invoke/{capability_id}",
                             json={"input": json.loads(input_data)},
                             headers=_headers(api_key), timeout=60)
        return json.dumps(resp.json(), indent=2)


class AgoragenticMemoryWrite(Action):
    name: str = "AgoragenticMemoryWrite"

    async def run(self, key: str = "", value: str = "", api_key: str = "") -> str:
        """Write to persistent agent memory ($0.10/write)."""
        resp = requests.post(f"{AGORAGENTIC_BASE_URL}/api/vault/memory",
                             json={"input": {"key": key, "value": value}},
                             headers=_headers(api_key), timeout=30)
        return json.dumps(resp.json(), indent=2)


class AgoragenticMemoryRead(Action):
    name: str = "AgoragenticMemoryRead"

    async def run(self, key: str = "", api_key: str = "") -> str:
        """Read from persistent agent memory. FREE."""
        params = {"namespace": "default"}
        if key:
            params["key"] = key
        resp = requests.get(f"{AGORAGENTIC_BASE_URL}/api/vault/memory",
                            params=params, headers=_headers(api_key), timeout=15)
        return json.dumps(resp.json(), indent=2)


class AgoragenticVault(Action):
    name: str = "AgoragenticVault"

    async def run(self, api_key: str = "") -> str:
        """View your agent vault — skills, datasets, NFTs, collectibles."""
        resp = requests.get(f"{AGORAGENTIC_BASE_URL}/api/inventory",
                            headers=_headers(api_key), timeout=15)
        return json.dumps(resp.json(), indent=2)


class AgoragenticPassport(Action):
    name: str = "AgoragenticPassport"

    async def run(self, api_key: str = "", action: str = "check") -> str:
        """Check Agoragentic Passport NFT identity on Base L2."""
        path = "/api/passport/info" if action == "info" else "/api/passport/check"
        resp = requests.get(f"{AGORAGENTIC_BASE_URL}{path}",
                            headers=_headers(api_key), timeout=15)
        return json.dumps(resp.json(), indent=2)


def get_all_actions():
    """Return all Agoragentic actions for MetaGPT."""
    return [AgoragenticRegister, AgoragenticSearch, AgoragenticInvoke,
            AgoragenticMemoryWrite, AgoragenticMemoryRead,
            AgoragenticVault, AgoragenticPassport]
