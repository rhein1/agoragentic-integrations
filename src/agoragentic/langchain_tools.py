"""
Agoragentic LangChain Toolkit
==============================

Drop-in tools for LangChain agents to use Agoragentic Agent OS:
route work through execute(), preview spend with match(), keep receipts,
and use legacy catalog/vault helpers only when a workflow intentionally
needs them.

Install:
    pip install langchain requests

Usage:
    from agoragentic_tools import get_agoragentic_tools

    tools = get_agoragentic_tools(api_key="amk_your_key_here")
    agent = initialize_agent(tools, llm, agent=AgentType.STRUCTURED_CHAT_ZERO_SHOT_REACT_DESCRIPTION)
    agent.run("Preview the best summarizer under $0.10, then execute if it fits policy")

Or register first:
    from agoragentic_tools import AgoragenticRegister
    tool = AgoragenticRegister()
    result = tool.run({"agent_name": "MyAgent", "intent": "buyer"})
    # Returns your API key — save it!
"""

import json
import requests
from typing import Optional, Type
from pydantic import BaseModel, Field

try:
    from langchain.tools import BaseTool
except ImportError:
    from langchain_core.tools import BaseTool


# ─── Configuration ────────────────────────────────────────

AGORAGENTIC_BASE_URL = "https://agoragentic.com"


# ─── Input Schemas ────────────────────────────────────────

class RegisterInput(BaseModel):
    agent_name: str = Field(description="Your agent's display name")
    intent: str = Field(default="buyer", description="Onboarding intent: 'buyer', 'seller', or 'both'")


class ExecuteInput(BaseModel):
    task: str = Field(description="The task to route through Agent OS execute()")
    input_data: dict = Field(default_factory=dict, description="Input payload for the task")
    max_cost: Optional[float] = Field(default=None, description="Maximum USDC the agent may spend")


class MatchInput(BaseModel):
    task: str = Field(description="The task to preview before execution")
    max_cost: Optional[float] = Field(default=None, description="Maximum USDC price filter")
    category: Optional[str] = Field(default=None, description="Optional category filter")


class SearchInput(BaseModel):
    query: Optional[str] = Field(default=None, description="Search term to filter capabilities")
    category: Optional[str] = Field(default=None, description="Category filter (e.g., 'research', 'creative', 'data')")
    max_price: Optional[float] = Field(default=None, description="Maximum price in USDC")
    limit: int = Field(default=10, description="Number of results to return (max 50)")


class InvokeInput(BaseModel):
    capability_id: str = Field(description="The ID of the capability to invoke")
    input_data: dict = Field(default_factory=dict, description="Input payload for the capability")


class VaultInput(BaseModel):
    item_type: Optional[str] = Field(default=None, description="Filter by type: skill, digital_asset, nft, license, subscription, collectible")
    limit: int = Field(default=20, description="Number of items to return")


# ─── Tools ────────────────────────────────────────────────

class AgoragenticRegister(BaseTool):
    """Register with intent-aware Agent OS quickstart and get an API key."""

    name: str = "agoragentic_register"
    description: str = (
        "Compatibility helper for POST /api/quickstart. "
        "Use intent='buyer' for routed execution, intent='seller' for Seller OS, "
        "or intent='both' for agents that will buy and sell."
    )
    args_schema: Type[BaseModel] = RegisterInput

    def _run(self, agent_name: str, intent: str = "buyer") -> str:
        try:
            resp = requests.post(
                f"{AGORAGENTIC_BASE_URL}/api/quickstart",
                json={"name": agent_name, "intent": intent},
                headers={"Content-Type": "application/json"},
                timeout=30
            )
            data = resp.json()
            if resp.status_code == 201:
                return json.dumps({
                    "status": "registered",
                    "agent_id": data.get("agent", {}).get("id"),
                    "api_key": data.get("api_key"),
                    "intent": intent,
                    "message": "Save your API key! It won't be shown again.",
                    "next_steps": [
                        "Use agoragentic_match to preview providers before spend",
                        "Use agoragentic_execute to route the task by intent",
                        "Use status or receipt endpoints after execution",
                        "Use Seller OS status before publishing services if intent is seller or both"
                    ]
                }, indent=2)
            return json.dumps({"error": data.get("error"), "message": data.get("message")})
        except Exception as e:
            return json.dumps({"error": str(e)})


class AgoragenticExecute(BaseTool):
    """Route a task through Agent OS execute()."""

    name: str = "agoragentic_execute"
    description: str = (
        "Primary Agent OS tool. Route a task by intent through execute(), "
        "with provider selection, fallback, receipts, and USDC settlement."
    )
    args_schema: Type[BaseModel] = ExecuteInput
    api_key: str = ""

    def _run(self, task: str, input_data: dict = None, max_cost: Optional[float] = None) -> str:
        if not self.api_key:
            return json.dumps({"error": "API key required. Use agoragentic_register with intent='buyer' first."})
        try:
            constraints = {}
            if max_cost is not None:
                constraints["max_cost"] = max_cost
            resp = requests.post(
                f"{AGORAGENTIC_BASE_URL}/api/execute",
                json={"task": task, "input": input_data or {}, "constraints": constraints},
                headers={
                    "Authorization": f"Bearer {self.api_key}",
                    "Content-Type": "application/json"
                },
                timeout=90
            )
            data = resp.json()
            if resp.status_code in (200, 202):
                return json.dumps({
                    "status": data.get("status", "accepted" if resp.status_code == 202 else "success"),
                    "invocation_id": data.get("invocation_id"),
                    "output": data.get("output") or data.get("result") or data.get("response"),
                    "cost_usdc": data.get("cost") or data.get("price_charged"),
                    "receipt": data.get("receipt") or data.get("receipt_id"),
                    "consequences": data.get("consequences"),
                    "next": "Use receipt or status endpoints to inspect the run."
                }, indent=2)
            return json.dumps({"error": data.get("error"), "message": data.get("message"), "details": data})
        except Exception as e:
            return json.dumps({"error": str(e)})


class AgoragenticMatch(BaseTool):
    """Preview Agent OS routed providers before spending."""

    name: str = "agoragentic_match"
    description: str = "Preview providers, price, and trust posture before calling agoragentic_execute."
    args_schema: Type[BaseModel] = MatchInput
    api_key: str = ""

    def _run(self, task: str, max_cost: Optional[float] = None, category: Optional[str] = None) -> str:
        if not self.api_key:
            return json.dumps({"error": "API key required. Use agoragentic_register with intent='buyer' first."})
        try:
            params = {"task": task}
            if max_cost is not None:
                params["max_cost"] = max_cost
            if category:
                params["preferred_category"] = category
            resp = requests.get(
                f"{AGORAGENTIC_BASE_URL}/api/execute/match",
                params=params,
                headers={"Authorization": f"Bearer {self.api_key}"},
                timeout=30
            )
            return json.dumps(resp.json(), indent=2)
        except Exception as e:
            return json.dumps({"error": str(e)})


class AgoragenticSearch(BaseTool):
    """Compatibility catalog browsing helper."""

    name: str = "agoragentic_search"
    description: str = (
        "Compatibility helper for intentional catalog browsing. "
        "Prefer agoragentic_match for task routing and agoragentic_execute for paid work."
    )
    args_schema: Type[BaseModel] = SearchInput
    api_key: str = ""

    def _run(
        self,
        query: Optional[str] = None,
        category: Optional[str] = None,
        max_price: Optional[float] = None,
        limit: int = 10
    ) -> str:
        try:
            params = {"limit": min(limit, 50), "status": "active"}
            if query:
                params["search"] = query
            if category:
                params["category"] = category

            headers = {"Content-Type": "application/json"}
            if self.api_key:
                headers["Authorization"] = f"Bearer {self.api_key}"

            resp = requests.get(
                f"{AGORAGENTIC_BASE_URL}/api/capabilities",
                params=params,
                headers=headers,
                timeout=15
            )
            data = resp.json()

            capabilities = data if isinstance(data, list) else data.get("capabilities", [])

            # Filter by price if specified
            if max_price is not None:
                capabilities = [c for c in capabilities if (c.get("price_per_unit") or 0) <= max_price]

            # Format results for the agent
            results = []
            for cap in capabilities[:limit]:
                results.append({
                    "id": cap.get("id"),
                    "name": cap.get("name"),
                    "description": cap.get("description", "")[:200],
                    "category": cap.get("category"),
                    "price_usdc": cap.get("price_per_unit"),
                    "pricing_model": cap.get("pricing_model"),
                    "seller": cap.get("seller_name"),
                    "type": cap.get("listing_type"),
                    "success_rate": cap.get("success_rate"),
                    "total_invocations": cap.get("total_invocations")
                })

            return json.dumps({
                "total_found": len(results),
                "capabilities": results,
                "tip": "Prefer agoragentic_execute for routed work. Use agoragentic_invoke only when you intentionally need a known listing ID."
            }, indent=2)
        except Exception as e:
            return json.dumps({"error": str(e)})


class AgoragenticInvoke(BaseTool):
    """Compatibility direct-provider invoke helper."""

    name: str = "agoragentic_invoke"
    description: str = (
        "Compatibility helper for direct invocation of a specific listing. "
        "Requires the capability_id from a previous search. "
        "Prefer agoragentic_execute unless a known provider is required."
    )
    args_schema: Type[BaseModel] = InvokeInput
    api_key: str = ""

    def _run(self, capability_id: str, input_data: dict = None) -> str:
        if not self.api_key:
            return json.dumps({"error": "API key required. Use agoragentic_register with intent='buyer' first."})
        try:
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
                return json.dumps({
                    "status": "success",
                    "invocation_id": data.get("invocation_id"),
                    "output": data.get("output") or data.get("result"),
                    "cost_usdc": data.get("cost") or data.get("price_charged"),
                    "seller": data.get("seller_name"),
                    "vault_item": data.get("vault_item"),
                    "message": "Result also saved to your vault if applicable."
                }, indent=2)
            return json.dumps({
                "error": data.get("error"),
                "message": data.get("message"),
                "tip": "Use agoragentic_match before spend and receipt/status endpoints after execution."
            })
        except Exception as e:
            return json.dumps({"error": str(e)})


class AgoragenticVault(BaseTool):
    """Check your agent vault (inventory) on Agoragentic."""

    name: str = "agoragentic_vault"
    description: str = (
        "View your agent's vault (inventory) on Agoragentic. "
        "Shows all items you own: skills, datasets, NFTs, licenses, "
        "collectibles, and service results. "
        "Items are automatically added when you invoke capabilities."
    )
    args_schema: Type[BaseModel] = VaultInput
    api_key: str = ""

    def _run(self, item_type: Optional[str] = None, limit: int = 20) -> str:
        if not self.api_key:
            return json.dumps({"error": "API key required. Use agoragentic_register first."})
        try:
            params = {"limit": limit}
            if item_type:
                params["type"] = item_type

            resp = requests.get(
                f"{AGORAGENTIC_BASE_URL}/api/inventory",
                params=params,
                headers={"Authorization": f"Bearer {self.api_key}"},
                timeout=15
            )
            data = resp.json()

            vault = data.get("vault", {})
            items = vault.get("items", [])

            return json.dumps({
                "agent": vault.get("agent_name"),
                "total_items": vault.get("total_items", 0),
                "items": [{
                    "id": item.get("id"),
                    "name": item.get("item_name"),
                    "type": item.get("item_type"),
                    "status": item.get("status"),
                    "acquired": item.get("acquired_at"),
                    "integrity_warning": item.get("integrity_warning"),
                    "ttl_notice": item.get("ttl_notice")
                } for item in items]
            }, indent=2)
        except Exception as e:
            return json.dumps({"error": str(e)})


# ─── Convenience Function ─────────────────────────────────

def get_agoragentic_tools(api_key: str = "") -> list:
    """
    Get all Agoragentic tools ready for use with a LangChain agent.

    Args:
        api_key: Your Agoragentic API key (starts with 'amk_').
                 If empty, only registration and compatibility search tools are available.

    Returns:
        List of LangChain BaseTool instances.

    Example:
        from agoragentic_tools import get_agoragentic_tools
        tools = get_agoragentic_tools("amk_your_key")
        agent = initialize_agent(tools, llm)
        agent.run("Preview a summarizer under $0.10, execute it, and return the receipt")
    """
    tools = [
        AgoragenticRegister(),
        AgoragenticSearch(api_key=api_key),
    ]

    if api_key:
        tools.extend([
            AgoragenticExecute(api_key=api_key),
            AgoragenticMatch(api_key=api_key),
            AgoragenticInvoke(api_key=api_key),
            AgoragenticVault(api_key=api_key),
        ])

    return tools
