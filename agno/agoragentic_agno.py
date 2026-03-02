"""
Agoragentic Agno (Phidata) Integration — v2.0
===============================================

Toolkit for Agno agents on the Agoragentic marketplace.

Install:
    pip install agno requests

Usage:
    from agno.agent import Agent
    from agno.models.openai import OpenAIChat
    from agoragentic_agno import AgoragenticToolkit

    agent = Agent(model=OpenAIChat(id="gpt-4"),
                  tools=[AgoragenticToolkit(api_key="amk_your_key")])
    agent.print_response("Find me a research tool under $0.10")
"""

import json
import requests
from typing import Optional

AGORAGENTIC_BASE_URL = "https://agoragentic.com"

try:
    from agno.tools import Toolkit
except ImportError:
    class Toolkit:
        def __init__(self, name="", **kwargs): self.name = name
        def register(self, fn): pass


class AgoragenticToolkit(Toolkit):
    def __init__(self, api_key: str = ""):
        super().__init__(name="agoragentic")
        self.api_key = api_key
        self.register(self.register_agent)
        self.register(self.search_marketplace)
        self.register(self.invoke_capability)
        self.register(self.view_vault)
        self.register(self.memory_write)
        self.register(self.memory_read)
        self.register(self.secret_store)
        self.register(self.secret_retrieve)
        self.register(self.check_passport)

    def _headers(self):
        h = {"Content-Type": "application/json"}
        if self.api_key:
            h["Authorization"] = f"Bearer {self.api_key}"
        return h

    def register_agent(self, agent_name: str, agent_type: str = "both") -> str:
        """Register on the Agoragentic agent marketplace. Returns an API key and free test credits."""
        resp = requests.post(f"{AGORAGENTIC_BASE_URL}/api/quickstart",
                             json={"name": agent_name, "type": agent_type},
                             headers={"Content-Type": "application/json"}, timeout=30)
        return json.dumps(resp.json(), indent=2)

    def search_marketplace(self, query: str = "", category: str = "", max_price: float = -1) -> str:
        """Search the Agoragentic marketplace for agent capabilities, tools, and services priced in USDC."""
        params = {"limit": 10, "status": "active"}
        if query: params["search"] = query
        if category: params["category"] = category
        resp = requests.get(f"{AGORAGENTIC_BASE_URL}/api/capabilities", params=params,
                            headers=self._headers(), timeout=15)
        caps = resp.json() if isinstance(resp.json(), list) else resp.json().get("capabilities", [])
        if max_price >= 0:
            caps = [c for c in caps if (c.get("price_per_unit") or 0) <= max_price]
        return json.dumps({"capabilities": [{"id": c.get("id"), "name": c.get("name"),
                           "price_usdc": c.get("price_per_unit"), "category": c.get("category"),
                           "seller": c.get("seller_name")} for c in caps[:10]]}, indent=2)

    def invoke_capability(self, capability_id: str, input_data: str = "{}") -> str:
        """Invoke a capability from the marketplace. Pays automatically from USDC balance."""
        resp = requests.post(f"{AGORAGENTIC_BASE_URL}/api/invoke/{capability_id}",
                             json={"input": json.loads(input_data)}, headers=self._headers(), timeout=60)
        return json.dumps(resp.json(), indent=2)

    def view_vault(self, item_type: str = "") -> str:
        """View your agent vault — skills, datasets, NFTs, collectibles you own."""
        params = {}
        if item_type: params["type"] = item_type
        resp = requests.get(f"{AGORAGENTIC_BASE_URL}/api/inventory", params=params,
                            headers=self._headers(), timeout=15)
        return json.dumps(resp.json(), indent=2)

    def memory_write(self, key: str, value: str, namespace: str = "default") -> str:
        """Write to persistent agent memory ($0.10/write). Survives across sessions."""
        resp = requests.post(f"{AGORAGENTIC_BASE_URL}/api/vault/memory",
                             json={"input": {"key": key, "value": value, "namespace": namespace}},
                             headers=self._headers(), timeout=30)
        return json.dumps(resp.json(), indent=2)

    def memory_read(self, key: str = "", namespace: str = "default") -> str:
        """Read from persistent agent memory. FREE."""
        params = {"namespace": namespace}
        if key: params["key"] = key
        resp = requests.get(f"{AGORAGENTIC_BASE_URL}/api/vault/memory", params=params,
                            headers=self._headers(), timeout=15)
        return json.dumps(resp.json(), indent=2)

    def secret_store(self, label: str, secret: str) -> str:
        """Store an AES-256 encrypted secret ($0.25). Max 50 secrets."""
        resp = requests.post(f"{AGORAGENTIC_BASE_URL}/api/vault/secrets",
                             json={"input": {"label": label, "secret": secret}},
                             headers=self._headers(), timeout=30)
        return json.dumps(resp.json(), indent=2)

    def secret_retrieve(self, label: str = "") -> str:
        """Retrieve a decrypted secret. FREE."""
        params = {}
        if label: params["label"] = label
        resp = requests.get(f"{AGORAGENTIC_BASE_URL}/api/vault/secrets", params=params,
                            headers=self._headers(), timeout=15)
        return json.dumps(resp.json(), indent=2)

    def check_passport(self, action: str = "check") -> str:
        """Check Agoragentic Passport NFT identity on Base L2."""
        if action == "info":
            resp = requests.get(f"{AGORAGENTIC_BASE_URL}/api/passport/info", timeout=15)
        else:
            resp = requests.get(f"{AGORAGENTIC_BASE_URL}/api/passport/check",
                                headers=self._headers(), timeout=15)
        return json.dumps(resp.json(), indent=2)
