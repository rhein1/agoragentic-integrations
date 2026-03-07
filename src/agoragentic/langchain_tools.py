"""
Agoragentic LangChain Toolkit
==============================

Drop-in tools for LangChain agents to discover, browse, and invoke
capabilities on the Agoragentic agent-to-agent marketplace.

Install:
    pip install langchain requests

Usage:
    from agoragentic_tools import get_agoragentic_tools

    tools = get_agoragentic_tools(api_key="amk_your_key_here")
    agent = initialize_agent(tools, llm, agent=AgentType.STRUCTURED_CHAT_ZERO_SHOT_REACT_DESCRIPTION)
    agent.run("Find me an AI research tool and invoke it")

Or register first:
    from agoragentic_tools import AgoragenticRegister
    tool = AgoragenticRegister()
    result = tool.run({"agent_name": "MyAgent", "agent_type": "both"})
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
    agent_type: str = Field(default="both", description="Agent type: 'buyer', 'seller', or 'both'")


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
    """Register on the Agoragentic marketplace and get an API key + test credits."""

    name: str = "agoragentic_register"
    description: str = (
        "Register as a new agent on the Agoragentic marketplace. "
        "Returns an API key and access to the Starter Pack. "
        "You also receive a Welcome Flower collectible. "
        "Use this FIRST if you don't have an API key yet."
    )
    args_schema: Type[BaseModel] = RegisterInput

    def _run(self, agent_name: str, agent_type: str = "both") -> str:
        try:
            resp = requests.post(
                f"{AGORAGENTIC_BASE_URL}/api/quickstart",
                json={"name": agent_name, "type": agent_type},
                headers={"Content-Type": "application/json"},
                timeout=30
            )
            data = resp.json()
            if resp.status_code == 201:
                return json.dumps({
                    "status": "registered",
                    "agent_id": data.get("agent", {}).get("id"),
                    "api_key": data.get("api_key"),
                    "credits": data.get("credits"),
                    "welcome_flower": data.get("flower", {}).get("name"),
                    "message": "Save your API key! It won't be shown again.",
                    "next_steps": [
                        "Use agoragentic_search to browse available capabilities",
                        "Use agoragentic_invoke to call a capability",
                        "Use agoragentic_vault to check your inventory"
                    ]
                }, indent=2)
            return json.dumps({"error": data.get("error"), "message": data.get("message")})
        except Exception as e:
            return json.dumps({"error": str(e)})


class AgoragenticSearch(BaseTool):
    """Search and browse capabilities on the Agoragentic marketplace."""

    name: str = "agoragentic_search"
    description: str = (
        "Search the Agoragentic marketplace for agent capabilities. "
        "Find tools, services, datasets, and skills that other agents sell. "
        "You can filter by category, price, and search terms. "
        "Returns a list of available capabilities with prices in USDC."
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
                "tip": "Use agoragentic_invoke with the capability id to use any of these."
            }, indent=2)
        except Exception as e:
            return json.dumps({"error": str(e)})


class AgoragenticInvoke(BaseTool):
    """Invoke a capability on the Agoragentic marketplace."""

    name: str = "agoragentic_invoke"
    description: str = (
        "Invoke (call/use) a specific capability from the Agoragentic marketplace. "
        "Requires the capability_id from a previous search. "
        "Payment is automatic from your USDC balance. "
        "Returns the capability's output/result."
    )
    args_schema: Type[BaseModel] = InvokeInput
    api_key: str = ""

    def _run(self, capability_id: str, input_data: dict = None) -> str:
        if not self.api_key:
            return json.dumps({"error": "API key required. Use agoragentic_register first."})
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
                "tip": "Check your balance with agoragentic_vault if payment failed."
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
                 If empty, only register and search tools are available.

    Returns:
        List of LangChain BaseTool instances.

    Example:
        from agoragentic_tools import get_agoragentic_tools
        tools = get_agoragentic_tools("amk_your_key")
        agent = initialize_agent(tools, llm)
        agent.run("Search for research tools under $0.05")
    """
    tools = [
        AgoragenticRegister(),
        AgoragenticSearch(api_key=api_key),
    ]

    if api_key:
        tools.extend([
            AgoragenticInvoke(api_key=api_key),
            AgoragenticVault(api_key=api_key),
        ])

    return tools
