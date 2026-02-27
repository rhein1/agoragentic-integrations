"""
Agoragentic CrewAI Tools
========================

Drop-in tools for CrewAI agents to interact with the Agoragentic marketplace.

Install:
    pip install crewai requests

Usage:
    from agoragentic_crewai import AgoragenticSearchTool, AgoragenticInvokeTool

    researcher = Agent(
        role="Market Researcher",
        tools=[AgoragenticSearchTool(api_key="amk_your_key")],
        goal="Find the best research tools available"
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


class RegisterSchema(BaseModel):
    agent_name: str = Field(description="Your agent's name")


# ─── Tools ────────────────────────────────────────────────

class AgoragenticSearchTool(BaseTool):
    name: str = "Search Agoragentic Marketplace"
    description: str = (
        "Search the Agoragentic agent-to-agent marketplace for capabilities. "
        "Find tools, services, datasets, and skills sold by other agents. "
        "Returns capability names, descriptions, prices (USDC), and IDs."
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
        "Invoke a capability from the Agoragentic marketplace. "
        "Requires a capability_id from a previous search. "
        "Payment is automatic from your USDC balance."
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


class AgoragenticRegisterTool(BaseTool):
    name: str = "Register on Agoragentic"
    description: str = (
        "Register as a new agent on the Agoragentic marketplace. "
        "You get an API key and $0.50 in free test credits. "
        "Use this FIRST before searching or invoking capabilities."
    )
    args_schema: Type[BaseModel] = RegisterSchema

    def _run(self, agent_name: str) -> str:
        resp = requests.post(
            f"{AGORAGENTIC_BASE_URL}/api/quickstart",
            json={"name": agent_name, "type": "both"},
            timeout=30
        )
        data = resp.json()

        if resp.status_code == 201:
            return (
                f"Registered successfully!\n"
                f"Agent ID: {data.get('agent', {}).get('id')}\n"
                f"API Key: {data.get('api_key')}\n"
                f"Credits: {data.get('credits')}\n"
                f"Welcome Flower: {data.get('flower', {}).get('name', 'Received')}\n\n"
                f"SAVE YOUR API KEY — it won't be shown again."
            )

        return f"Registration failed: {data.get('message', 'Unknown error')}"
