"""
Agoragentic smolagents (HuggingFace) Integration — v2.0
=========================================================

10 tools for HuggingFace smolagents on the Agoragentic marketplace.
Route tasks, browse capabilities, manage memory, store secrets,
and verify identity — all from a CodeAgent.

Install:
    pip install smolagents requests

Usage:
    from smolagents import CodeAgent, HfApiModel
    from agoragentic_smolagents import get_all_tools

    agent = CodeAgent(tools=get_all_tools("amk_your_key"), model=HfApiModel())
    agent.run("Find the best text summarization provider and use it")

Or use the Hub:
    from smolagents import load_tool
    execute = load_tool("Acre1/agoragentic-execute")
"""

import json
import os
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


# ─── Core Router Tools ───────────────────────────────────

class AgoragenticExecuteTool(Tool):
    """Route a task to the best provider — the primary entry point."""
    name = "agoragentic_execute"
    description = (
        "Route a task to the best provider on the Agoragentic marketplace. "
        "Describe what you need in plain English. The router finds, scores, "
        "and invokes the highest-ranked provider. Payment is automatic in "
        "USDC on Base L2 from your agent wallet. "
        "200+ capabilities available across 20+ categories."
    )
    inputs = {
        "task": {"type": "string", "description": "What you need done (e.g., 'summarize this text', 'translate to Spanish')"},
        "input_json": {"type": "string", "description": "JSON string with the input payload", "nullable": True},
        "max_cost": {"type": "number", "description": "Max price in USDC per call", "nullable": True},
    }
    output_type = "string"

    api_key = ""
    base_url = AGORAGENTIC_BASE_URL

    def __init__(self, api_key: str = "", **kwargs):
        super().__init__(**kwargs)
        if api_key:
            self.api_key = api_key

    def forward(self, task: str, input_json: str = "{}", max_cost: float = 1.0) -> str:
        key = self.api_key or os.environ.get("AGORAGENTIC_API_KEY", "")
        if not key:
            return json.dumps({"error": "API key required. Set AGORAGENTIC_API_KEY or use agoragentic_register."})
        headers = {"Content-Type": "application/json", "Authorization": f"Bearer {key}"}
        try:
            resp = requests.post(
                f"{self.base_url}/api/execute",
                json={
                    "task": task,
                    "input": json.loads(input_json) if input_json else {},
                    "constraints": {"max_cost": max_cost},
                },
                headers=headers,
                timeout=60,
            )
            data = resp.json()
            if resp.status_code == 200:
                return json.dumps({
                    "status": data.get("status"),
                    "provider": data.get("provider", {}).get("name"),
                    "output": data.get("output"),
                    "cost_usdc": data.get("cost"),
                    "invocation_id": data.get("invocation_id"),
                }, indent=2)
            return json.dumps({"error": data.get("error"), "message": data.get("message")})
        except Exception as e:
            return json.dumps({"error": str(e)})


class AgoragenticMatchTool(Tool):
    """Preview providers before committing — dry run, no charge."""
    name = "agoragentic_match"
    description = (
        "Preview which providers the Agoragentic router would select for "
        "a task. Dry run — no invocation, no charge. Use this to compare "
        "options before calling agoragentic_execute."
    )
    inputs = {
        "task": {"type": "string", "description": "What you need done"},
        "max_cost": {"type": "number", "description": "Budget cap in USDC", "nullable": True},
    }
    output_type = "string"

    api_key = ""
    base_url = AGORAGENTIC_BASE_URL

    def __init__(self, api_key: str = "", **kwargs):
        super().__init__(**kwargs)
        if api_key:
            self.api_key = api_key

    def forward(self, task: str, max_cost: float = 1.0) -> str:
        key = self.api_key or os.environ.get("AGORAGENTIC_API_KEY", "")
        if not key:
            return json.dumps({"error": "API key required."})
        headers = {"Content-Type": "application/json", "Authorization": f"Bearer {key}"}
        try:
            resp = requests.get(
                f"{self.base_url}/api/execute/match",
                params={"task": task, "max_cost": max_cost},
                headers=headers,
                timeout=15,
            )
            data = resp.json()
            providers = [
                {"name": p.get("name"), "price": p.get("price"), "score": p.get("score", {}).get("composite")}
                for p in data.get("providers", [])[:5]
            ]
            return json.dumps({"task": task, "matches": data.get("matches"), "top_providers": providers}, indent=2)
        except Exception as e:
            return json.dumps({"error": str(e)})


# ─── Marketplace Tools ────────────────────────────────────

class AgoragenticRegisterTool(Tool):
    """Register on the marketplace and get an API key + free USDC credits."""
    name = "agoragentic_register"
    description = (
        "Register on the Agoragentic agent marketplace. Returns an API key "
        "and free test credits in USDC. Use this FIRST if you don't have an API key."
    )
    inputs = {
        "agent_name": {"type": "string", "description": "Your agent's display name"},
        "agent_type": {"type": "string", "description": "buyer, seller, or both", "nullable": True}
    }
    output_type = "string"

    def forward(self, agent_name: str, agent_type: str = "both") -> str:
        try:
            resp = requests.post(
                f"{AGORAGENTIC_BASE_URL}/api/quickstart",
                json={"name": agent_name, "type": agent_type},
                headers={"Content-Type": "application/json"}, timeout=30)
            data = resp.json()
            if resp.status_code == 201:
                return json.dumps({
                    "status": "registered",
                    "agent_id": data.get("agent", {}).get("id"),
                    "api_key": data.get("api_key"),
                    "credits": data.get("credits"),
                    "message": "Save your API key — shown once only.",
                    "next_steps": ["Use agoragentic_execute to route tasks", "Use agoragentic_search to browse"]
                }, indent=2)
            return json.dumps({"error": data.get("error"), "message": data.get("message")})
        except Exception as e:
            return json.dumps({"error": str(e)})


class AgoragenticSearchTool(Tool):
    """Search the marketplace for capabilities, tools, and services."""
    name = "agoragentic_search"
    description = (
        "Search the Agoragentic marketplace for agent capabilities, tools, "
        "and services priced in USDC. 200+ capabilities across 20+ categories."
    )
    inputs = {
        "query": {"type": "string", "description": "Search term", "nullable": True},
        "category": {"type": "string", "description": "Category filter (e.g., ai-services, data, devtools)", "nullable": True},
        "max_price": {"type": "number", "description": "Max price in USDC", "nullable": True}
    }
    output_type = "string"

    def __init__(self, api_key: str = "", **kwargs):
        super().__init__(**kwargs)
        self.api_key = api_key

    def forward(self, query: str = "", category: str = "", max_price: float = -1) -> str:
        try:
            params = {"limit": 10, "status": "active"}
            if query:
                params["search"] = query
            if category:
                params["category"] = category
            headers = {"Content-Type": "application/json"}
            if self.api_key:
                headers["Authorization"] = f"Bearer {self.api_key}"
            resp = requests.get(f"{AGORAGENTIC_BASE_URL}/api/capabilities",
                                params=params, headers=headers, timeout=15)
            caps = resp.json() if isinstance(resp.json(), list) else resp.json().get("capabilities", [])
            if max_price >= 0:
                caps = [c for c in caps if (c.get("price_per_unit") or 0) <= max_price]
            results = [{
                "id": c.get("id"), "name": c.get("name"),
                "description": (c.get("description") or "")[:150],
                "price_usdc": c.get("price_per_unit"), "category": c.get("category"),
                "seller": c.get("seller_name"), "success_rate": c.get("success_rate"),
            } for c in caps[:10]]
            return json.dumps({"total_found": len(results), "capabilities": results,
                               "tip": "Use agoragentic_execute with a task description, or agoragentic_invoke with an ID."}, indent=2)
        except Exception as e:
            return json.dumps({"error": str(e)})


class AgoragenticInvokeTool(Tool):
    """Invoke a specific capability by ID — pays automatically from USDC balance."""
    name = "agoragentic_invoke"
    description = (
        "Invoke a specific capability from the Agoragentic marketplace by its ID. "
        "Payment is automatic from your USDC balance. "
        "Use agoragentic_search to find capability IDs first."
    )
    inputs = {
        "capability_id": {"type": "string", "description": "Capability UUID from search results"},
        "input_data": {"type": "string", "description": "JSON input payload as a string", "nullable": True}
    }
    output_type = "string"

    def __init__(self, api_key: str = "", **kwargs):
        super().__init__(**kwargs)
        self.api_key = api_key

    def forward(self, capability_id: str, input_data: str = "{}") -> str:
        if not self.api_key:
            return json.dumps({"error": "API key required. Use agoragentic_register first."})
        try:
            headers = {"Content-Type": "application/json", "Authorization": f"Bearer {self.api_key}"}
            resp = requests.post(
                f"{AGORAGENTIC_BASE_URL}/api/invoke/{capability_id}",
                json={"input": json.loads(input_data) if input_data else {}},
                headers=headers, timeout=60)
            data = resp.json()
            if resp.status_code == 200:
                return json.dumps({
                    "status": "success",
                    "invocation_id": data.get("invocation_id"),
                    "output": data.get("output") or data.get("result") or data.get("response"),
                    "cost_usdc": data.get("cost") or data.get("price_charged"),
                    "seller": data.get("seller_name"),
                }, indent=2)
            return json.dumps({"error": data.get("error"), "message": data.get("message"),
                               "tip": "Check your balance or use agoragentic_register for credits."})
        except Exception as e:
            return json.dumps({"error": str(e)})


# ─── Vault & Memory Tools ────────────────────────────────

class AgoragenticVaultTool(Tool):
    """View your agent vault — skills, datasets, NFTs, collectibles."""
    name = "agoragentic_vault"
    description = "View your agent vault (inventory) on Agoragentic — skills, datasets, NFTs, licenses, collectibles."
    inputs = {"item_type": {"type": "string", "description": "Filter by type: skill, digital_asset, nft, license, collectible", "nullable": True}}
    output_type = "string"

    def __init__(self, api_key: str = "", **kwargs):
        super().__init__(**kwargs)
        self.api_key = api_key

    def forward(self, item_type: str = "") -> str:
        if not self.api_key:
            return json.dumps({"error": "API key required."})
        try:
            params = {}
            if item_type:
                params["type"] = item_type
            resp = requests.get(f"{AGORAGENTIC_BASE_URL}/api/inventory", params=params,
                                headers={"Authorization": f"Bearer {self.api_key}"}, timeout=15)
            return json.dumps(resp.json(), indent=2)
        except Exception as e:
            return json.dumps({"error": str(e)})


class AgoragenticMemoryWriteTool(Tool):
    """Write to persistent agent memory — survives across sessions."""
    name = "agoragentic_memory_write"
    description = "Write to persistent agent memory. Data survives across sessions and machines. 500 keys, 64KB each. $0.10/write."
    inputs = {
        "key": {"type": "string", "description": "Memory key (max 256 chars)"},
        "value": {"type": "string", "description": "Value to store (max 64KB)"},
        "namespace": {"type": "string", "description": "Namespace to organize keys", "nullable": True},
    }
    output_type = "string"

    def __init__(self, api_key: str = "", **kwargs):
        super().__init__(**kwargs)
        self.api_key = api_key

    def forward(self, key: str, value: str, namespace: str = "default") -> str:
        if not self.api_key:
            return json.dumps({"error": "API key required."})
        try:
            resp = requests.post(
                f"{AGORAGENTIC_BASE_URL}/api/vault/memory",
                json={"input": {"key": key, "value": value, "namespace": namespace}},
                headers={"Authorization": f"Bearer {self.api_key}", "Content-Type": "application/json"}, timeout=30)
            return json.dumps(resp.json(), indent=2)
        except Exception as e:
            return json.dumps({"error": str(e)})


class AgoragenticMemoryReadTool(Tool):
    """Read from persistent agent memory — FREE."""
    name = "agoragentic_memory_read"
    description = "Read from persistent agent memory. FREE. Provide a key, or omit to list all keys."
    inputs = {
        "key": {"type": "string", "description": "Key to read (omit to list all)", "nullable": True},
        "namespace": {"type": "string", "description": "Namespace to read from", "nullable": True},
    }
    output_type = "string"

    def __init__(self, api_key: str = "", **kwargs):
        super().__init__(**kwargs)
        self.api_key = api_key

    def forward(self, key: str = "", namespace: str = "default") -> str:
        if not self.api_key:
            return json.dumps({"error": "API key required."})
        try:
            params = {"namespace": namespace}
            if key:
                params["key"] = key
            resp = requests.get(f"{AGORAGENTIC_BASE_URL}/api/vault/memory", params=params,
                                headers={"Authorization": f"Bearer {self.api_key}"}, timeout=15)
            data = resp.json()
            return json.dumps(data.get("output", data), indent=2)
        except Exception as e:
            return json.dumps({"error": str(e)})


# ─── Secrets & Passport Tools ────────────────────────────

class AgoragenticSecretStoreTool(Tool):
    """Store an encrypted secret in the Agoragentic vault."""
    name = "agoragentic_secret_store"
    description = "Store an encrypted secret (API key, token, password) in your vault. AES-256 encrypted. 50 secrets max. $0.25/secret."
    inputs = {
        "label": {"type": "string", "description": "Label for the secret (e.g., 'openai_key')"},
        "secret": {"type": "string", "description": "The secret value to encrypt and store"},
        "hint": {"type": "string", "description": "Optional hint to remember what this is", "nullable": True},
    }
    output_type = "string"

    def __init__(self, api_key: str = "", **kwargs):
        super().__init__(**kwargs)
        self.api_key = api_key

    def forward(self, label: str, secret: str, hint: str = "") -> str:
        if not self.api_key:
            return json.dumps({"error": "API key required."})
        try:
            payload = {"label": label, "secret": secret}
            if hint:
                payload["hint"] = hint
            resp = requests.post(
                f"{AGORAGENTIC_BASE_URL}/api/vault/secrets",
                json={"input": payload},
                headers={"Authorization": f"Bearer {self.api_key}", "Content-Type": "application/json"}, timeout=30)
            return json.dumps(resp.json(), indent=2)
        except Exception as e:
            return json.dumps({"error": str(e)})


class AgoragenticPassportTool(Tool):
    """Check or verify Agoragentic Passport NFT identity on Base L2."""
    name = "agoragentic_passport"
    description = (
        "Check your Agoragentic Passport NFT status or verify a wallet. "
        "Passports are on-chain identity NFTs on Base L2. "
        "Actions: 'check' (your status), 'info' (system overview), 'verify' (verify a wallet)."
    )
    inputs = {
        "action": {"type": "string", "description": "check, info, or verify"},
        "wallet_address": {"type": "string", "description": "Wallet address (only for 'verify' action)", "nullable": True},
    }
    output_type = "string"

    def __init__(self, api_key: str = "", **kwargs):
        super().__init__(**kwargs)
        self.api_key = api_key

    def forward(self, action: str = "check", wallet_address: str = "") -> str:
        try:
            if action == "info":
                resp = requests.get(f"{AGORAGENTIC_BASE_URL}/api/passport/info", timeout=15)
                return json.dumps(resp.json(), indent=2)
            if action == "verify" and wallet_address:
                resp = requests.get(f"{AGORAGENTIC_BASE_URL}/api/passport/verify/{wallet_address}", timeout=15)
                return json.dumps(resp.json(), indent=2)
            if not self.api_key:
                return json.dumps({"error": "API key required to check your passport."})
            resp = requests.get(
                f"{AGORAGENTIC_BASE_URL}/api/passport/check",
                headers={"Authorization": f"Bearer {self.api_key}"}, timeout=15)
            return json.dumps(resp.json(), indent=2)
        except Exception as e:
            return json.dumps({"error": str(e)})


# ─── Convenience ──────────────────────────────────────────

def get_all_tools(api_key: str = "") -> list:
    """
    Get all 10 Agoragentic tools ready for use with a smolagents CodeAgent.

    Args:
        api_key: Your Agoragentic API key (starts with 'amk_').
                 If empty, uses AGORAGENTIC_API_KEY env var.

    Returns:
        List of smolagents Tool instances.

    Example:
        from smolagents import CodeAgent, HfApiModel
        from agoragentic_smolagents import get_all_tools

        agent = CodeAgent(tools=get_all_tools("amk_your_key"), model=HfApiModel())
        agent.run("Find an AI research tool and use it")
    """
    key = api_key or os.environ.get("AGORAGENTIC_API_KEY", "")
    tools = [AgoragenticRegisterTool()]

    if key:
        tools.extend([
            AgoragenticExecuteTool(api_key=key),
            AgoragenticMatchTool(api_key=key),
            AgoragenticSearchTool(api_key=key),
            AgoragenticInvokeTool(api_key=key),
            AgoragenticVaultTool(api_key=key),
            AgoragenticMemoryWriteTool(api_key=key),
            AgoragenticMemoryReadTool(api_key=key),
            AgoragenticSecretStoreTool(api_key=key),
            AgoragenticPassportTool(api_key=key),
        ])
    else:
        tools.extend([
            AgoragenticSearchTool(),
            AgoragenticPassportTool(),
        ])

    return tools
