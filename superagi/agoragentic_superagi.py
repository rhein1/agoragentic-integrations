"""
Agoragentic SuperAGI Integration — v2.0
=========================================

Tool module for SuperAGI agents on the Agoragentic Router / Marketplace.

Install:
    pip install requests

Usage:
    from agoragentic_superagi import AgoragenticSearchTool, AgoragenticInvokeTool
    # Add to your SuperAGI agent's tool list
"""

import json
import requests
from typing import Optional, Type

AGORAGENTIC_BASE_URL = "https://agoragentic.com"

try:
    from superagi.tools.base_tool import BaseTool
    from pydantic import BaseModel, Field
except ImportError:
    from pydantic import BaseModel, Field
    class BaseTool:
        name: str = ""
        description: str = ""
        def _execute(self, **kwargs):
            raise NotImplementedError


def _headers(api_key: str):
    h = {"Content-Type": "application/json"}
    if api_key: h["Authorization"] = f"Bearer {api_key}"
    return h


class SearchInput(BaseModel):
    query: str = Field(default="", description="Search term")
    category: str = Field(default="", description="Category filter")
    api_key: str = Field(default="", description="Agoragentic API key (amk_...)")


class ExecuteInput(BaseModel):
    task: str = Field(description="Task to route through Agoragentic")
    input_data: str = Field(default="{}", description="JSON input payload")
    constraints: str = Field(default="{}", description="JSON budget, trust, or routing constraints")
    api_key: str = Field(default="", description="Agoragentic API key")


class AgoragenticExecuteTool(BaseTool):
    name = "Agoragentic Execute"
    description = "Route a task through Agoragentic execute() with provider selection, receipts, and settlement."
    args_schema: Type[BaseModel] = ExecuteInput

    def _execute(self, task: str, input_data: str = "{}", constraints: str = "{}", api_key: str = "") -> str:
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


class MatchInput(BaseModel):
    task: str = Field(description="Task to match")
    max_cost: float = Field(default=-1, description="Optional max cost in USDC")
    min_trust: str = Field(default="", description="Optional minimum trust requirement")
    api_key: str = Field(default="", description="Agoragentic API key")


class AgoragenticMatchTool(BaseTool):
    name = "Agoragentic Match"
    description = "Preview eligible routed providers before execution."
    args_schema: Type[BaseModel] = MatchInput

    def _execute(self, task: str, max_cost: float = -1, min_trust: str = "", api_key: str = "") -> str:
        params = {"task": task}
        if max_cost >= 0:
            params["max_cost"] = str(max_cost)
        if min_trust:
            params["min_trust"] = min_trust
        resp = requests.get(f"{AGORAGENTIC_BASE_URL}/api/execute/match",
                            params=params, headers=_headers(api_key), timeout=30)
        return json.dumps(resp.json(), indent=2)


class AgoragenticSearchTool(BaseTool):
    name = "Agoragentic Search"
    description = "Compatibility catalog browsing. Prefer Agoragentic Match for new routed work."
    args_schema: Type[BaseModel] = SearchInput

    def _execute(self, query: str = "", category: str = "", api_key: str = "") -> str:
        params = {"limit": 10, "status": "active"}
        if query: params["search"] = query
        if category: params["category"] = category
        resp = requests.get(f"{AGORAGENTIC_BASE_URL}/api/capabilities",
                            params=params, headers=_headers(api_key), timeout=15)
        caps = resp.json() if isinstance(resp.json(), list) else resp.json().get("capabilities", [])
        return json.dumps({"capabilities": [
            {"id": c.get("id"), "name": c.get("name"), "price_usdc": c.get("price_per_unit")}
            for c in caps[:10]
        ]}, indent=2)


class InvokeInput(BaseModel):
    capability_id: str = Field(description="Capability ID from search results")
    input_data: str = Field(default="{}", description="JSON input payload")
    api_key: str = Field(default="", description="Agoragentic API key")


class AgoragenticInvokeTool(BaseTool):
    name = "Agoragentic Invoke"
    description = "Compatibility direct-provider invocation when a known capability ID is required."
    args_schema: Type[BaseModel] = InvokeInput

    def _execute(self, capability_id: str, input_data: str = "{}", api_key: str = "") -> str:
        resp = requests.post(f"{AGORAGENTIC_BASE_URL}/api/invoke/{capability_id}",
                             json={"input": json.loads(input_data)},
                             headers=_headers(api_key), timeout=60)
        return json.dumps(resp.json(), indent=2)


class RegisterInput(BaseModel):
    agent_name: str = Field(description="Your agent name")
    intent: str = Field(default="both", description="buyer, seller, or both")


class AgoragenticRegisterTool(BaseTool):
    name = "Agoragentic Register"
    description = "Create an Agoragentic API key for a buyer, seller, or dual-purpose agent."
    args_schema: Type[BaseModel] = RegisterInput

    def _execute(self, agent_name: str, intent: str = "both") -> str:
        resp = requests.post(f"{AGORAGENTIC_BASE_URL}/api/quickstart",
                             json={"name": agent_name, "intent": intent},
                             headers={"Content-Type": "application/json"}, timeout=30)
        return json.dumps(resp.json(), indent=2)


class MemoryInput(BaseModel):
    key: str = Field(description="Memory key")
    value: str = Field(default="", description="Value to store")
    api_key: str = Field(default="", description="API key")


class AgoragenticMemoryTool(BaseTool):
    name = "Agoragentic Memory"
    description = "Read or write scoped Agent OS memory when policy allows it."
    args_schema: Type[BaseModel] = MemoryInput

    def _execute(self, key: str, value: str = "", api_key: str = "") -> str:
        if value:
            resp = requests.post(f"{AGORAGENTIC_BASE_URL}/api/vault/memory",
                                 json={"input": {"key": key, "value": value}},
                                 headers=_headers(api_key), timeout=30)
        else:
            resp = requests.get(f"{AGORAGENTIC_BASE_URL}/api/vault/memory",
                                params={"key": key, "namespace": "default"},
                                headers=_headers(api_key), timeout=15)
        return json.dumps(resp.json(), indent=2)
