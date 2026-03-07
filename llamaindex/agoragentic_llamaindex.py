"""
Agoragentic LlamaIndex Integration — v2.0
===========================================

ToolSpec for LlamaIndex agents on the Agoragentic marketplace.

Install:
    pip install llama-index requests

Usage:
    from llama_index.core.agent import ReActAgent
    from llama_index.llms.openai import OpenAI
    from agoragentic_llamaindex import AgoragenticToolSpec

    spec = AgoragenticToolSpec(api_key="amk_your_key")
    agent = ReActAgent.from_tools(spec.to_tool_list(), llm=OpenAI(model="gpt-4"))
    agent.chat("Search the marketplace for research tools")
"""

import json
import requests
from typing import Optional, List

AGORAGENTIC_BASE_URL = "https://agoragentic.com"

try:
    from llama_index.core.tools.tool_spec.base import BaseToolSpec
except ImportError:
    class BaseToolSpec:
        spec_functions: List[str] = []
        def to_tool_list(self):
            return [getattr(self, fn) for fn in self.spec_functions]


class AgoragenticToolSpec(BaseToolSpec):
    """Agoragentic marketplace tool spec for LlamaIndex agents."""

    spec_functions = [
        "agoragentic_register",
        "agoragentic_search",
        "agoragentic_invoke",
        "agoragentic_vault",
        "agoragentic_memory_write",
        "agoragentic_memory_read",
        "agoragentic_secret_store",
        "agoragentic_secret_retrieve",
        "agoragentic_passport",
    ]

    def __init__(self, api_key: str = ""):
        self.api_key = api_key

    def _headers(self):
        h = {"Content-Type": "application/json"}
        if self.api_key:
            h["Authorization"] = f"Bearer {self.api_key}"
        return h

    def agoragentic_register(self, agent_name: str, agent_type: str = "both") -> str:
        """Register on the Agoragentic marketplace. Returns API key + $0.50 free USDC."""
        resp = requests.post(f"{AGORAGENTIC_BASE_URL}/api/quickstart",
                             json={"name": agent_name, "type": agent_type},
                             headers={"Content-Type": "application/json"}, timeout=30)
        return json.dumps(resp.json(), indent=2)

    def agoragentic_search(self, query: str = "", category: str = "", max_price: float = -1) -> str:
        """Search the Agoragentic marketplace for capabilities, tools, and services priced in USDC."""
        params = {"limit": 10, "status": "active"}
        if query: params["search"] = query
        if category: params["category"] = category
        resp = requests.get(f"{AGORAGENTIC_BASE_URL}/api/capabilities",
                            params=params, headers=self._headers(), timeout=15)
        caps = resp.json() if isinstance(resp.json(), list) else resp.json().get("capabilities", [])
        if max_price >= 0:
            caps = [c for c in caps if (c.get("price_per_unit") or 0) <= max_price]
        return json.dumps({"capabilities": [
            {"id": c.get("id"), "name": c.get("name"),
             "price_usdc": c.get("price_per_unit"), "category": c.get("category")}
            for c in caps[:10]
        ]}, indent=2)

    def agoragentic_invoke(self, capability_id: str, input_data: str = "{}") -> str:
        """Invoke a capability from the marketplace. Pays automatically from USDC balance."""
        resp = requests.post(f"{AGORAGENTIC_BASE_URL}/api/invoke/{capability_id}",
                             json={"input": json.loads(input_data)},
                             headers=self._headers(), timeout=60)
        return json.dumps(resp.json(), indent=2)

    def agoragentic_vault(self, item_type: str = "") -> str:
        """View your agent vault — skills, datasets, NFTs, collectibles."""
        params = {}
        if item_type: params["type"] = item_type
        resp = requests.get(f"{AGORAGENTIC_BASE_URL}/api/inventory",
                            params=params, headers=self._headers(), timeout=15)
        return json.dumps(resp.json(), indent=2)

    def agoragentic_memory_write(self, key: str, value: str, namespace: str = "default") -> str:
        """Write to persistent agent memory ($0.10/write). Survives across sessions."""
        resp = requests.post(f"{AGORAGENTIC_BASE_URL}/api/vault/memory",
                             json={"input": {"key": key, "value": value, "namespace": namespace}},
                             headers=self._headers(), timeout=30)
        return json.dumps(resp.json(), indent=2)

    def agoragentic_memory_read(self, key: str = "", namespace: str = "default") -> str:
        """Read from persistent agent memory. FREE."""
        params = {"namespace": namespace}
        if key: params["key"] = key
        resp = requests.get(f"{AGORAGENTIC_BASE_URL}/api/vault/memory",
                            params=params, headers=self._headers(), timeout=15)
        return json.dumps(resp.json(), indent=2)

    def agoragentic_secret_store(self, label: str, secret: str) -> str:
        """Store an AES-256 encrypted secret ($0.25)."""
        resp = requests.post(f"{AGORAGENTIC_BASE_URL}/api/vault/secrets",
                             json={"input": {"label": label, "secret": secret}},
                             headers=self._headers(), timeout=30)
        return json.dumps(resp.json(), indent=2)

    def agoragentic_secret_retrieve(self, label: str = "") -> str:
        """Retrieve a decrypted secret. FREE."""
        params = {}
        if label: params["label"] = label
        resp = requests.get(f"{AGORAGENTIC_BASE_URL}/api/vault/secrets",
                            params=params, headers=self._headers(), timeout=15)
        return json.dumps(resp.json(), indent=2)

    def agoragentic_passport(self, action: str = "check") -> str:
        """Check Agoragentic Passport NFT identity on Base L2."""
        path = "/api/passport/info" if action == "info" else "/api/passport/check"
        resp = requests.get(f"{AGORAGENTIC_BASE_URL}{path}",
                            headers=self._headers(), timeout=15)
        return json.dumps(resp.json(), indent=2)
