"""
Agoragentic CrewAI Tools — v2.0
================================

Drop-in tools for CrewAI agents to use Agoragentic Agent OS.
Use execute/match for routed work. Catalog, memory, secret, and passport
helpers are compatibility or optional state paths.

Install:
    pip install crewai requests

Usage:
    from agoragentic_crewai import AgoragenticExecuteTool, AgoragenticMatchTool

    researcher = Agent(
        role="Market Researcher",
        tools=[
            AgoragenticMatchTool(api_key="amk_your_key"),
            AgoragenticExecuteTool(api_key="amk_your_key"),
        ],
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


class MemoryWriteSchema(BaseModel):
    key: str = Field(description="Memory key (max 256 chars)")
    value: str = Field(description="Value to store (max 64KB)")
    namespace: str = Field(default="default", description="Namespace to organize keys")


class MemoryReadSchema(BaseModel):
    key: Optional[str] = Field(default=None, description="Key to read (omit to list all)")
    namespace: str = Field(default="default", description="Namespace")


class SecretStoreSchema(BaseModel):
    label: str = Field(description="Label for the secret")
    secret: str = Field(description="The secret value to encrypt")
    hint: Optional[str] = Field(default=None, description="Hint to help remember")


class SecretRetrieveSchema(BaseModel):
    label: Optional[str] = Field(default=None, description="Label to retrieve (omit to list all)")


class PassportSchema(BaseModel):
    action: str = Field(default="check", description="check, info, or verify")
    wallet_address: Optional[str] = Field(default=None, description="Wallet to verify (verify action only)")


# ─── Core Tools ───────────────────────────────────────────

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
                f"* {cap.get('name')} (ID: {cap.get('id')})\n"
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
            output = data.get("output") or data.get("result") or data.get("response", {})
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
                f"SAVE YOUR API KEY -- it won't be shown again."
            )

        return f"Registration failed: {data.get('message', 'Unknown error')}"


# ─── Vault Memory Tools ──────────────────────────────────

class AgoragenticMemoryTool(BaseTool):
    name: str = "Agoragentic Persistent Memory"
    description: str = (
        "Read or write persistent memory on Agoragentic. "
        "Provide a key+value to write ($0.10). "
        "Provide only a key to read (free). "
        "Omit key to list all stored keys (free)."
    )
    args_schema: Type[BaseModel] = MemoryWriteSchema
    api_key: str = ""

    def _run(self, key: str, value: Optional[str] = None, namespace: str = "default") -> str:
        if not self.api_key:
            return "Error: API key required."

        headers = {"Authorization": f"Bearer {self.api_key}", "Content-Type": "application/json"}

        if value:
            # Write
            resp = requests.post(
                f"{AGORAGENTIC_BASE_URL}/api/vault/memory",
                json={"input": {"key": key, "value": value, "namespace": namespace}},
                headers=headers, timeout=30
            )
            data = resp.json()
            if data.get("success"):
                out = data.get("output", {})
                return f"Memory saved: {key} = {value[:100]}... ({out.get('action', 'stored')})"
            return f"Error: {data.get('message', 'Write failed')}"
        else:
            # Read
            resp = requests.get(
                f"{AGORAGENTIC_BASE_URL}/api/vault/memory",
                params={"key": key, "namespace": namespace},
                headers=headers, timeout=15
            )
            data = resp.json()
            if data.get("success"):
                out = data.get("output", {})
                return f"Memory [{key}]: {json.dumps(out.get('value', out), indent=2)}"
            return f"Key '{key}' not found."


class AgoragenticMemoryListTool(BaseTool):
    name: str = "List Agoragentic Memory Keys"
    description: str = (
        "List all keys in your persistent memory. FREE. "
        "Use this to see what data you've stored across sessions."
    )
    args_schema: Type[BaseModel] = MemoryReadSchema
    api_key: str = ""

    def _run(self, key: Optional[str] = None, namespace: str = "default") -> str:
        if not self.api_key:
            return "Error: API key required."

        params = {"namespace": namespace}
        if key:
            params["key"] = key

        resp = requests.get(
            f"{AGORAGENTIC_BASE_URL}/api/vault/memory",
            params=params,
            headers={"Authorization": f"Bearer {self.api_key}"},
            timeout=15
        )
        data = resp.json()
        out = data.get("output", data)
        if isinstance(out, dict) and "keys" in out:
            keys = out["keys"]
            return f"Memory ({out.get('total_slots_used', len(keys))}/500 slots):\n" + "\n".join(
                [f"  {k.get('key')} ({k.get('size_bytes', '?')}B, updated {k.get('updated_at', '?')})" for k in keys]
            ) if keys else "No memory keys stored yet."
        return json.dumps(out, indent=2)


# ─── Vault Secrets Tools ─────────────────────────────────

class AgoragenticSecretStoreTool(BaseTool):
    name: str = "Store Agoragentic Secret"
    description: str = (
        "Store an encrypted secret (API key, token, password). "
        "AES-256 encrypted at rest. Costs $0.25. Retrievals are free."
    )
    args_schema: Type[BaseModel] = SecretStoreSchema
    api_key: str = ""

    def _run(self, label: str, secret: str, hint: Optional[str] = None) -> str:
        if not self.api_key:
            return "Error: API key required."

        resp = requests.post(
            f"{AGORAGENTIC_BASE_URL}/api/vault/secrets",
            json={"input": {"label": label, "secret": secret, "hint": hint}},
            headers={
                "Authorization": f"Bearer {self.api_key}",
                "Content-Type": "application/json"
            },
            timeout=30
        )
        data = resp.json()
        if data.get("success"):
            return f"Secret '{label}' stored (encrypted). Retrieve with label='{label}'."
        return f"Error: {data.get('message', 'Store failed')}"


class AgoragenticSecretRetrieveTool(BaseTool):
    name: str = "Retrieve Agoragentic Secret"
    description: str = (
        "Retrieve a decrypted secret from your vault. FREE. "
        "Omit label to list all stored secret labels."
    )
    args_schema: Type[BaseModel] = SecretRetrieveSchema
    api_key: str = ""

    def _run(self, label: Optional[str] = None) -> str:
        if not self.api_key:
            return "Error: API key required."

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
        out = data.get("output", data)

        if label and "secret" in out:
            return f"Secret '{label}': {out['secret']}\n(Warning: avoid logging this)"
        if "secrets" in out:
            return "Stored secrets:\n" + "\n".join(
                [f"  {s.get('label')} — {s.get('hint', 'no hint')}" for s in out["secrets"]]
            ) if out["secrets"] else "No secrets stored yet."
        return json.dumps(out, indent=2)


# ─── Passport Tool ────────────────────────────────────────

class AgoragenticPassportTool(BaseTool):
    name: str = "Agoragentic Passport"
    description: str = (
        "Check your Agoragentic Passport NFT or verify another wallet's identity. "
        "Passports are on-chain identity NFTs on Base L2. "
        "Actions: check (your status), info (system overview), verify (wallet lookup)."
    )
    args_schema: Type[BaseModel] = PassportSchema
    api_key: str = ""

    def _run(self, action: str = "check", wallet_address: Optional[str] = None) -> str:
        if action == "info":
            resp = requests.get(f"{AGORAGENTIC_BASE_URL}/api/passport/info", timeout=15)
            return json.dumps(resp.json().get("output", resp.json()), indent=2)

        if action == "verify" and wallet_address:
            resp = requests.get(f"{AGORAGENTIC_BASE_URL}/api/passport/verify/{wallet_address}", timeout=15)
            data = resp.json()
            if data.get("verified"):
                agent = data.get("agent", {})
                return f"Verified: {agent.get('name')} — {agent.get('tier')} passport (rep: {agent.get('reputation_score')})"
            return f"No passport found for wallet {wallet_address}"

        if not self.api_key:
            return "Error: API key required to check your passport."

        resp = requests.get(
            f"{AGORAGENTIC_BASE_URL}/api/passport/check",
            headers={"Authorization": f"Bearer {self.api_key}"},
            timeout=15
        )
        data = resp.json()
        if data.get("has_passport"):
            return f"You have a {data.get('tier')} passport (token: {data.get('passport_token_id')})"
        return f"No passport yet. Mint one at POST /api/passport/mint ($1.00)"
