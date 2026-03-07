"""
Agoragentic LangChain Toolkit — v2.0
======================================

Drop-in tools for LangChain agents to discover, browse, invoke
capabilities, manage persistent memory, store encrypted secrets,
and check passport identity on the Agoragentic marketplace.

Install:
    pip install langchain requests

Usage:
    from agoragentic_tools import get_agoragentic_tools

    tools = get_agoragentic_tools(api_key="amk_your_key_here")
    agent = initialize_agent(tools, llm, agent=AgentType.STRUCTURED_CHAT_ZERO_SHOT_REACT_DESCRIPTION)
    agent.run("Find me an AI research tool and invoke it")
    agent.run("Save my findings to persistent memory")
    agent.run("Store my OpenAI key in the vault secrets locker")

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
    category: Optional[str] = Field(default=None, description="Category filter (e.g., 'research', 'creative', 'data', 'agent-upgrades')")
    max_price: Optional[float] = Field(default=None, description="Maximum price in USDC")
    limit: int = Field(default=10, description="Number of results to return (max 50)")


class InvokeInput(BaseModel):
    capability_id: str = Field(description="The ID of the capability to invoke")
    input_data: dict = Field(default_factory=dict, description="Input payload for the capability")


class VaultInput(BaseModel):
    item_type: Optional[str] = Field(default=None, description="Filter by type: skill, digital_asset, nft, license, subscription, collectible")
    include_nfts: bool = Field(default=False, description="Include on-chain NFTs from Base L2 blockchain")
    limit: int = Field(default=20, description="Number of items to return")


class MemoryWriteInput(BaseModel):
    key: str = Field(description="Memory key (max 256 chars)")
    value: str = Field(description="Value to store (max 64KB). Can be any string or JSON.")
    namespace: str = Field(default="default", description="Namespace to organize keys")
    ttl_seconds: Optional[int] = Field(default=None, description="Auto-expire after N seconds (optional)")


class MemoryReadInput(BaseModel):
    key: Optional[str] = Field(default=None, description="Specific key to read (omit to list all keys)")
    namespace: str = Field(default="default", description="Namespace to read from")
    prefix: Optional[str] = Field(default=None, description="Filter keys by prefix (only for listing)")


class SecretStoreInput(BaseModel):
    label: str = Field(description="Label for the secret (e.g., 'openai_key')")
    secret: str = Field(description="The secret value to encrypt and store")
    hint: Optional[str] = Field(default=None, description="Optional hint to help remember what this is")


class SecretRetrieveInput(BaseModel):
    label: Optional[str] = Field(default=None, description="Label of the secret to retrieve (omit to list all)")


class PassportInput(BaseModel):
    action: str = Field(default="check", description="check = your status, info = system overview, verify = verify a wallet")
    wallet_address: Optional[str] = Field(default=None, description="Wallet address (only for 'verify' action)")


# ─── Core Tools ───────────────────────────────────────────

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
                        "Use agoragentic_vault to check your inventory",
                        "Use agoragentic_memory_write to save persistent data",
                        "Use agoragentic_passport to check identity status"
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

            if max_price is not None:
                capabilities = [c for c in capabilities if (c.get("price_per_unit") or 0) <= max_price]

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
                    "output": data.get("output") or data.get("result") or data.get("response"),
                    "cost_usdc": data.get("cost") or data.get("price_charged"),
                    "seller": data.get("seller_name"),
                    "vault_item": data.get("vault_item") or data.get("vault"),
                    "nft": data.get("nft"),
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
        "Shows all items you own: skills, datasets, licenses, "
        "collectibles, and service results. "
        "Set include_nfts=True to also see on-chain NFTs from Base L2."
    )
    args_schema: Type[BaseModel] = VaultInput
    api_key: str = ""

    def _run(self, item_type: Optional[str] = None, include_nfts: bool = False, limit: int = 20) -> str:
        if not self.api_key:
            return json.dumps({"error": "API key required. Use agoragentic_register first."})
        try:
            params = {"limit": limit}
            if item_type:
                params["type"] = item_type
            if include_nfts:
                params["include"] = "nfts"

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
                } for item in items],
                "nfts": data.get("nfts")
            }, indent=2)
        except Exception as e:
            return json.dumps({"error": str(e)})


# ─── Vault Memory Tools ──────────────────────────────────

class AgoragenticMemoryWrite(BaseTool):
    """Write to persistent agent memory on Agoragentic."""

    name: str = "agoragentic_memory_write"
    description: str = (
        "Write a key-value pair to your persistent agent memory. "
        "Data survives across sessions, IDEs, and machines. "
        "500 keys max, 64KB per value. TTL auto-expiry supported. "
        "Costs $0.10 per write. Reads are free."
    )
    args_schema: Type[BaseModel] = MemoryWriteInput
    api_key: str = ""

    def _run(self, key: str, value: str, namespace: str = "default", ttl_seconds: Optional[int] = None) -> str:
        if not self.api_key:
            return json.dumps({"error": "API key required."})
        try:
            resp = requests.post(
                f"{AGORAGENTIC_BASE_URL}/api/vault/memory",
                json={"input": {"key": key, "value": value, "namespace": namespace, "ttl_seconds": ttl_seconds}},
                headers={
                    "Authorization": f"Bearer {self.api_key}",
                    "Content-Type": "application/json"
                },
                timeout=30
            )
            return json.dumps(resp.json(), indent=2)
        except Exception as e:
            return json.dumps({"error": str(e)})


class AgoragenticMemoryRead(BaseTool):
    """Read from persistent agent memory on Agoragentic (free)."""

    name: str = "agoragentic_memory_read"
    description: str = (
        "Read from your persistent agent memory. FREE. "
        "Provide a key to get a specific value, or omit to list all keys. "
        "Use prefix to filter keys. Use namespace to organize data."
    )
    args_schema: Type[BaseModel] = MemoryReadInput
    api_key: str = ""

    def _run(self, key: Optional[str] = None, namespace: str = "default", prefix: Optional[str] = None) -> str:
        if not self.api_key:
            return json.dumps({"error": "API key required."})
        try:
            params = {"namespace": namespace}
            if key:
                params["key"] = key
            if prefix:
                params["prefix"] = prefix

            resp = requests.get(
                f"{AGORAGENTIC_BASE_URL}/api/vault/memory",
                params=params,
                headers={"Authorization": f"Bearer {self.api_key}"},
                timeout=15
            )
            data = resp.json()
            return json.dumps(data.get("output", data), indent=2)
        except Exception as e:
            return json.dumps({"error": str(e)})


# ─── Vault Secrets Tools ─────────────────────────────────

class AgoragenticSecretStore(BaseTool):
    """Store an encrypted secret in the Agoragentic vault."""

    name: str = "agoragentic_secret_store"
    description: str = (
        "Store an encrypted secret (API key, token, password) in your vault. "
        "AES-256 encrypted at rest. 50 secrets max, 4KB each. "
        "Costs $0.25 per secret. Retrievals are free."
    )
    args_schema: Type[BaseModel] = SecretStoreInput
    api_key: str = ""

    def _run(self, label: str, secret: str, hint: Optional[str] = None) -> str:
        if not self.api_key:
            return json.dumps({"error": "API key required."})
        try:
            resp = requests.post(
                f"{AGORAGENTIC_BASE_URL}/api/vault/secrets",
                json={"input": {"label": label, "secret": secret, "hint": hint}},
                headers={
                    "Authorization": f"Bearer {self.api_key}",
                    "Content-Type": "application/json"
                },
                timeout=30
            )
            return json.dumps(resp.json(), indent=2)
        except Exception as e:
            return json.dumps({"error": str(e)})


class AgoragenticSecretRetrieve(BaseTool):
    """Retrieve a decrypted secret from the Agoragentic vault (free)."""

    name: str = "agoragentic_secret_retrieve"
    description: str = (
        "Retrieve a decrypted secret from your vault. FREE. "
        "Provide a label to decrypt a specific secret, or omit to list all labels."
    )
    args_schema: Type[BaseModel] = SecretRetrieveInput
    api_key: str = ""

    def _run(self, label: Optional[str] = None) -> str:
        if not self.api_key:
            return json.dumps({"error": "API key required."})
        try:
            params = {}
            if label:
                params["label"] = label

            resp = requests.get(
                f"{AGORAGENTIC_BASE_URL}/api/vault/secrets",
                params=params,
                headers={"Authorization": f"Bearer {self.api_key}"},
                timeout=15
            )
            data = resp.json()
            return json.dumps(data.get("output", data), indent=2)
        except Exception as e:
            return json.dumps({"error": str(e)})


# ─── Passport Tool ────────────────────────────────────────

class AgoragenticPassport(BaseTool):
    """Check or verify Agoragentic Passport NFT identity."""

    name: str = "agoragentic_passport"
    description: str = (
        "Check your Agoragentic Passport NFT status, get system info, "
        "or verify a wallet address. Passports are on-chain identity NFTs on Base L2. "
        "Actions: 'check' (your status), 'info' (system overview), 'verify' (verify a wallet)."
    )
    args_schema: Type[BaseModel] = PassportInput
    api_key: str = ""

    def _run(self, action: str = "check", wallet_address: Optional[str] = None) -> str:
        try:
            if action == "info":
                resp = requests.get(
                    f"{AGORAGENTIC_BASE_URL}/api/passport/info",
                    timeout=15
                )
                data = resp.json()
                return json.dumps(data.get("output", data), indent=2)

            if action == "verify" and wallet_address:
                resp = requests.get(
                    f"{AGORAGENTIC_BASE_URL}/api/passport/verify/{wallet_address}",
                    timeout=15
                )
                return json.dumps(resp.json(), indent=2)

            if not self.api_key:
                return json.dumps({"error": "API key required to check your passport status."})

            resp = requests.get(
                f"{AGORAGENTIC_BASE_URL}/api/passport/check",
                headers={"Authorization": f"Bearer {self.api_key}"},
                timeout=15
            )
            return json.dumps(resp.json(), indent=2)
        except Exception as e:
            return json.dumps({"error": str(e)})


# ─── Convenience Function ─────────────────────────────────

def get_agoragentic_tools(api_key: str = "") -> list:
    """
    Get all Agoragentic tools ready for use with a LangChain agent.

    Args:
        api_key: Your Agoragentic API key (starts with 'amk_').
                 If empty, only register, search, and passport info are available.

    Returns:
        List of LangChain BaseTool instances.

    Example:
        from agoragentic_tools import get_agoragentic_tools
        tools = get_agoragentic_tools("amk_your_key")
        agent = initialize_agent(tools, llm)
        agent.run("Search for research tools under $0.05")
        agent.run("Save my findings to memory with key 'research_notes'")
    """
    tools = [
        AgoragenticRegister(),
        AgoragenticSearch(api_key=api_key),
        AgoragenticPassport(api_key=api_key),
    ]

    if api_key:
        tools.extend([
            AgoragenticInvoke(api_key=api_key),
            AgoragenticVault(api_key=api_key),
            AgoragenticMemoryWrite(api_key=api_key),
            AgoragenticMemoryRead(api_key=api_key),
            AgoragenticSecretStore(api_key=api_key),
            AgoragenticSecretRetrieve(api_key=api_key),
        ])

    return tools
