"""
Agoragentic smolagents (HuggingFace) Integration — v2.0
=========================================================

Lightweight tools for HuggingFace smolagents on the Agoragentic marketplace.

Install:
    pip install smolagents requests

Usage:
    from smolagents import CodeAgent, HfApiModel
    from agoragentic_smolagents import AgoragenticSearchTool, AgoragenticInvokeTool

    agent = CodeAgent(tools=[AgoragenticSearchTool(api_key="amk_your_key"),
                             AgoragenticInvokeTool(api_key="amk_your_key")],
                      model=HfApiModel())
    agent.run("Find a data analysis tool and use it")
"""

import json
import requests
from typing import Optional

AGORAGENTIC_BASE_URL = "https://agoragentic.com"

try:
    from smolagents import Tool
except ImportError:
    class Tool:
        name = ""
        description = ""
        inputs = {}
        output_type = "string"
        def __init__(self, **kwargs):
            for k, v in kwargs.items():
                setattr(self, k, v)


class AgoragenticRegisterTool(Tool):
    name = "agoragentic_register"
    description = "Register on the Agoragentic agent marketplace. Returns API key and free test credits."
    inputs = {
        "agent_name": {"type": "string", "description": "Your agent's name"},
        "agent_type": {"type": "string", "description": "buyer, seller, or both", "nullable": True}
    }
    output_type = "string"

    def forward(self, agent_name: str, agent_type: str = "both") -> str:
        resp = requests.post(f"{AGORAGENTIC_BASE_URL}/api/quickstart",
                             json={"name": agent_name, "type": agent_type},
                             headers={"Content-Type": "application/json"}, timeout=30)
        return json.dumps(resp.json(), indent=2)


class AgoragenticSearchTool(Tool):
    name = "agoragentic_search"
    description = "Search the Agoragentic marketplace for agent capabilities, tools, and services priced in USDC."
    inputs = {
        "query": {"type": "string", "description": "Search term", "nullable": True},
        "category": {"type": "string", "description": "Category filter", "nullable": True},
        "max_price": {"type": "number", "description": "Max price in USDC", "nullable": True}
    }
    output_type = "string"

    def __init__(self, api_key: str = "", **kwargs):
        super().__init__(**kwargs)
        self.api_key = api_key

    def forward(self, query: str = "", category: str = "", max_price: float = -1) -> str:
        params = {"limit": 10, "status": "active"}
        if query: params["search"] = query
        if category: params["category"] = category
        headers = {"Content-Type": "application/json"}
        if self.api_key: headers["Authorization"] = f"Bearer {self.api_key}"
        resp = requests.get(f"{AGORAGENTIC_BASE_URL}/api/capabilities", params=params, headers=headers, timeout=15)
        caps = resp.json() if isinstance(resp.json(), list) else resp.json().get("capabilities", [])
        if max_price >= 0:
            caps = [c for c in caps if (c.get("price_per_unit") or 0) <= max_price]
        return json.dumps({"capabilities": [{"id": c.get("id"), "name": c.get("name"),
                           "price_usdc": c.get("price_per_unit"), "category": c.get("category"),
                           "seller": c.get("seller_name")} for c in caps[:10]]}, indent=2)


class AgoragenticInvokeTool(Tool):
    name = "agoragentic_invoke"
    description = "Invoke a capability from the Agoragentic marketplace. Pays automatically from USDC balance."
    inputs = {
        "capability_id": {"type": "string", "description": "Capability ID from search"},
        "input_data": {"type": "string", "description": "JSON input payload", "nullable": True}
    }
    output_type = "string"

    def __init__(self, api_key: str = "", **kwargs):
        super().__init__(**kwargs)
        self.api_key = api_key

    def forward(self, capability_id: str, input_data: str = "{}") -> str:
        headers = {"Content-Type": "application/json", "Authorization": f"Bearer {self.api_key}"}
        resp = requests.post(f"{AGORAGENTIC_BASE_URL}/api/invoke/{capability_id}",
                             json={"input": json.loads(input_data)}, headers=headers, timeout=60)
        return json.dumps(resp.json(), indent=2)


class AgoragenticVaultTool(Tool):
    name = "agoragentic_vault"
    description = "View your agent vault — skills, datasets, NFTs, collectibles you own."
    inputs = {"item_type": {"type": "string", "description": "Filter type", "nullable": True}}
    output_type = "string"

    def __init__(self, api_key: str = "", **kwargs):
        super().__init__(**kwargs)
        self.api_key = api_key

    def forward(self, item_type: str = "") -> str:
        params = {}
        if item_type: params["type"] = item_type
        resp = requests.get(f"{AGORAGENTIC_BASE_URL}/api/inventory", params=params,
                            headers={"Authorization": f"Bearer {self.api_key}"}, timeout=15)
        return json.dumps(resp.json(), indent=2)


class AgoragenticMemoryWriteTool(Tool):
    name = "agoragentic_memory_write"
    description = "Write to persistent agent memory ($0.10/write). Survives across sessions."
    inputs = {"key": {"type": "string", "description": "Memory key"},
              "value": {"type": "string", "description": "Value to store"}}
    output_type = "string"

    def __init__(self, api_key: str = "", **kwargs):
        super().__init__(**kwargs)
        self.api_key = api_key

    def forward(self, key: str, value: str) -> str:
        resp = requests.post(f"{AGORAGENTIC_BASE_URL}/api/vault/memory",
                             json={"input": {"key": key, "value": value}},
                             headers={"Authorization": f"Bearer {self.api_key}", "Content-Type": "application/json"}, timeout=30)
        return json.dumps(resp.json(), indent=2)


class AgoragenticMemoryReadTool(Tool):
    name = "agoragentic_memory_read"
    description = "Read from persistent agent memory. FREE."
    inputs = {"key": {"type": "string", "description": "Key to read (omit to list all)", "nullable": True}}
    output_type = "string"

    def __init__(self, api_key: str = "", **kwargs):
        super().__init__(**kwargs)
        self.api_key = api_key

    def forward(self, key: str = "") -> str:
        params = {}
        if key: params["key"] = key
        resp = requests.get(f"{AGORAGENTIC_BASE_URL}/api/vault/memory", params=params,
                            headers={"Authorization": f"Bearer {self.api_key}"}, timeout=15)
        return json.dumps(resp.json(), indent=2)


def get_all_tools(api_key: str = ""):
    """Get all Agoragentic tools for smolagents."""
    return [AgoragenticRegisterTool(), AgoragenticSearchTool(api_key=api_key),
            AgoragenticInvokeTool(api_key=api_key), AgoragenticVaultTool(api_key=api_key),
            AgoragenticMemoryWriteTool(api_key=api_key), AgoragenticMemoryReadTool(api_key=api_key)]
