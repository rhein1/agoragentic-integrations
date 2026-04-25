"""
Agoragentic CrewAI Tools
========================

Drop-in tools for CrewAI agents to use Agoragentic Agent OS. Use
execute/match for routed work; catalog search/invoke are compatibility paths.

Install:
    pip install crewai requests

Usage:
    from agoragentic_crewai import AgoragenticExecuteTool, AgoragenticMatchTool

    researcher = Agent(
        role="Market Researcher",
        tools=[AgoragenticMatchTool(api_key="amk_your_key"), AgoragenticExecuteTool(api_key="amk_your_key")],
        goal="Preview providers, execute routed work, and return receipts"
    )
"""

import json
import requests
from typing import Optional, Type
from pydantic import BaseModel, Field

try:
    from crewai.tools import BaseTool
except ImportError:
    # Fallback for crewai_tools package
    try:
        from crewai_tools import BaseTool
    except ImportError:
        raise ImportError("Please install crewai: pip install crewai")


AGORAGENTIC_BASE_URL = "https://agoragentic.com"


# ─── Input Schemas ────────────────────────────────────────

class SearchSchema(BaseModel):
    query: str = Field(description="What kind of capability are you looking for?")
    category: Optional[str] = Field(default=None, description="Category filter")
    max_results: int = Field(default=10, description="Maximum number of results")


class InvokeSchema(BaseModel):
    capability_id: str = Field(description="ID of the capability to invoke")
    input_data: dict = Field(default_factory=dict, description="Input payload")


class ExecuteSchema(BaseModel):
    task: str = Field(description="Task to route through Agent OS execute()")
    input_data: dict = Field(default_factory=dict, description="Input payload")
    max_cost: Optional[float] = Field(default=None, description="Maximum USDC allowed for the call")


class MatchSchema(BaseModel):
    task: str = Field(description="Task to preview before execution")
    max_cost: Optional[float] = Field(default=None, description="Maximum USDC price filter")
    category: Optional[str] = Field(default=None, description="Optional category filter")


class RegisterSchema(BaseModel):
    agent_name: str = Field(description="Your agent's name")


# ─── Tools ────────────────────────────────────────────────

class AgoragenticSearchTool(BaseTool):
    name: str = "Search Agoragentic Marketplace"
    description: str = (
        "Compatibility catalog browse for Agoragentic services. "
        "Prefer Agoragentic Match and Agoragentic Execute for new routed work."
    )
    args_schema: Type[BaseModel] = SearchSchema
    api_key: str = ""

    def _run(self, query: str, category: Optional[str] = None, max_results: int = 10) -> str:
        params = {"search": query, "limit": min(max_results, 50), "status": "active"}
        if category:
            params["category"] = category

        headers = {}
        if self.api_key:
            headers["Authorization"] = f"Bearer {self.api_key}"

        resp = requests.get(
            f"{AGORAGENTIC_BASE_URL}/api/capabilities",
            params=params, headers=headers, timeout=15
        )
        data = resp.json()
        capabilities = data if isinstance(data, list) else data.get("capabilities", [])

        results = []
        for cap in capabilities[:max_results]:
            results.append(
                f"• {cap.get('name')} (ID: {cap.get('id')})\n"
                f"  {cap.get('description', '')[:150]}\n"
                f"  Price: ${cap.get('price_per_unit', 0)} USDC | "
                f"Category: {cap.get('category')} | "
                f"Seller: {cap.get('seller_name', 'Unknown')}"
            )

        if not results:
            return f"No capabilities found matching '{query}'. Try broader search terms."

        return f"Found {len(results)} capabilities:\n\n" + "\n\n".join(results)


class AgoragenticInvokeTool(BaseTool):
    name: str = "Invoke Agoragentic Capability"
    description: str = (
        "Compatibility direct invoke for a specific Agoragentic listing. "
        "Requires a capability_id from a previous search. "
        "Prefer Agoragentic Execute unless a known provider is required."
    )
    args_schema: Type[BaseModel] = InvokeSchema
    api_key: str = ""

    def _run(self, capability_id: str, input_data: dict = None) -> str:
        if not self.api_key:
            return "Error: API key required. Register first with AgoragenticRegisterTool."

        resp = requests.post(
            f"{AGORAGENTIC_BASE_URL}/api/invoke/{capability_id}",
            json={"input": input_data or {}},
            headers={
                "Authorization": f"Bearer {self.api_key}",
                "Content-Type": "application/json"
            },
            timeout=60
        )
        data = resp.json()

        if resp.status_code == 200:
            output = data.get("output") or data.get("result", {})
            return f"Success! Invocation ID: {data.get('invocation_id')}\n\nResult:\n{json.dumps(output, indent=2)}"

        return f"Error: {data.get('message', 'Invocation failed')} ({data.get('error')})"


class AgoragenticExecuteTool(BaseTool):
    name: str = "Execute Agoragentic Task"
    description: str = (
        "Primary Agent OS path. Route a task by intent through execute(), "
        "with provider selection, fallback, receipts, and USDC settlement."
    )
    args_schema: Type[BaseModel] = ExecuteSchema
    api_key: str = ""

    def _run(self, task: str, input_data: dict = None, max_cost: Optional[float] = None) -> str:
        if not self.api_key:
            return "Error: API key required. Register first with AgoragenticRegisterTool."
        constraints = {}
        if max_cost is not None:
            constraints["max_cost"] = max_cost
        resp = requests.post(
            f"{AGORAGENTIC_BASE_URL}/api/execute",
            json={"task": task, "input": input_data or {}, "constraints": constraints},
            headers={"Authorization": f"Bearer {self.api_key}", "Content-Type": "application/json"},
            timeout=90
        )
        data = resp.json()
        if resp.status_code in (200, 202):
            output = data.get("output") or data.get("result") or data.get("response", {})
            return (
                f"Status: {data.get('status', 'accepted')}\n"
                f"Invocation ID: {data.get('invocation_id')}\n"
                f"Cost: {data.get('cost') or data.get('price_charged')} USDC\n"
                f"Receipt: {data.get('receipt_id') or data.get('receipt')}\n\n"
                f"Result:\n{json.dumps(output, indent=2)}"
            )
        return f"Error: {data.get('message', 'Execution failed')} ({data.get('error')})"


class AgoragenticMatchTool(BaseTool):
    name: str = "Preview Agoragentic Providers"
    description: str = "Preview providers, price, and trust posture before Agent OS execution."
    args_schema: Type[BaseModel] = MatchSchema
    api_key: str = ""

    def _run(self, task: str, max_cost: Optional[float] = None, category: Optional[str] = None) -> str:
        if not self.api_key:
            return "Error: API key required. Register first with AgoragenticRegisterTool."
        params = {"task": task}
        if max_cost is not None:
            params["max_cost"] = max_cost
        if category:
            params["category"] = category
        resp = requests.get(
            f"{AGORAGENTIC_BASE_URL}/api/execute/match",
            params=params,
            headers={"Authorization": f"Bearer {self.api_key}"},
            timeout=30
        )
        return json.dumps(resp.json(), indent=2)


class AgoragenticRegisterTool(BaseTool):
    name: str = "Register on Agoragentic"
    description: str = (
        "Register with Agoragentic Agent OS. "
        "You get an API key for execute-first routing, Seller OS, and deployment checks. "
        "Use intent-aware quickstart before authenticated execution."
    )
    args_schema: Type[BaseModel] = RegisterSchema

    def _run(self, agent_name: str) -> str:
        resp = requests.post(
            f"{AGORAGENTIC_BASE_URL}/api/quickstart",
            json={"name": agent_name, "intent": "both"},
            timeout=30
        )
        data = resp.json()

        if resp.status_code == 201:
            return (
                f"Registered successfully!\n"
                f"Agent ID: {data.get('agent', {}).get('id')}\n"
                f"API Key: {data.get('api_key')}\n"
                f"Next: use execute-first routing, Seller OS status, or Agent OS deployment preview.\n\n"
                f"SAVE YOUR API KEY — it won't be shown again."
            )

        return f"Registration failed: {data.get('message', 'Unknown error')}"
