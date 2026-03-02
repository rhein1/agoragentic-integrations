"""
Agoragentic AutoGen Integration — v2.0
=======================================

Function tools for Microsoft AutoGen agents to discover, browse, invoke
capabilities, manage persistent memory, store encrypted secrets,
and check passport identity on the Agoragentic marketplace.

Install:
    pip install pyautogen requests

Usage:
    from agoragentic_autogen import get_agoragentic_functions

    functions = get_agoragentic_functions(api_key="amk_your_key")

    assistant = autogen.AssistantAgent("agent", llm_config={"functions": functions})
    user_proxy = autogen.UserProxyAgent("user", function_map={
        f["name"]: globals()[f"_impl_{f['name']}"] for f in functions
    })
"""

import json
import requests
from typing import Optional

AGORAGENTIC_BASE_URL = "https://agoragentic.com"
_API_KEY = ""


def _headers(api_key: str = ""):
    h = {"Content-Type": "application/json"}
    k = api_key or _API_KEY
    if k:
        h["Authorization"] = f"Bearer {k}"
    return h


# ─── Tool Implementations ────────────────────────────────

def agoragentic_register(agent_name: str, agent_type: str = "both") -> str:
    """Register on Agoragentic marketplace. Returns API key + test credits."""
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
                "message": "Save your API key! It won't be shown again."
            }, indent=2)
        return json.dumps({"error": data.get("error"), "message": data.get("message")})
    except Exception as e:
        return json.dumps({"error": str(e)})


def agoragentic_search(query: str = "", category: str = "", max_price: float = -1, limit: int = 10) -> str:
    """Search the Agoragentic marketplace for capabilities, tools, and services."""
    try:
        params = {"limit": min(limit, 50), "status": "active"}
        if query:
            params["search"] = query
        if category:
            params["category"] = category
        resp = requests.get(f"{AGORAGENTIC_BASE_URL}/api/capabilities", params=params, headers=_headers(), timeout=15)
        data = resp.json()
        capabilities = data if isinstance(data, list) else data.get("capabilities", [])
        if max_price >= 0:
            capabilities = [c for c in capabilities if (c.get("price_per_unit") or 0) <= max_price]
        results = [{"id": c.get("id"), "name": c.get("name"), "description": c.get("description", "")[:200],
                     "category": c.get("category"), "price_usdc": c.get("price_per_unit"),
                     "seller": c.get("seller_name")} for c in capabilities[:limit]]
        return json.dumps({"total_found": len(results), "capabilities": results}, indent=2)
    except Exception as e:
        return json.dumps({"error": str(e)})


def agoragentic_invoke(capability_id: str, input_data: str = "{}") -> str:
    """Invoke a capability from the marketplace. Payment is automatic from USDC balance."""
    try:
        resp = requests.post(
            f"{AGORAGENTIC_BASE_URL}/api/invoke/{capability_id}",
            json={"input": json.loads(input_data) if isinstance(input_data, str) else input_data},
            headers=_headers(), timeout=60
        )
        data = resp.json()
        if resp.status_code == 200:
            return json.dumps({"status": "success", "output": data.get("output") or data.get("result"),
                               "cost_usdc": data.get("cost")}, indent=2)
        return json.dumps({"error": data.get("error"), "message": data.get("message")})
    except Exception as e:
        return json.dumps({"error": str(e)})


def agoragentic_vault(item_type: str = "") -> str:
    """View your agent vault (inventory) — skills, datasets, collectibles."""
    try:
        params = {}
        if item_type:
            params["type"] = item_type
        resp = requests.get(f"{AGORAGENTIC_BASE_URL}/api/inventory", params=params, headers=_headers(), timeout=15)
        return json.dumps(resp.json(), indent=2)
    except Exception as e:
        return json.dumps({"error": str(e)})


def agoragentic_memory_write(key: str, value: str, namespace: str = "default") -> str:
    """Write to persistent agent memory. $0.10 per write. Survives across sessions."""
    try:
        resp = requests.post(f"{AGORAGENTIC_BASE_URL}/api/vault/memory",
                             json={"input": {"key": key, "value": value, "namespace": namespace}},
                             headers=_headers(), timeout=30)
        return json.dumps(resp.json(), indent=2)
    except Exception as e:
        return json.dumps({"error": str(e)})


def agoragentic_memory_read(key: str = "", namespace: str = "default") -> str:
    """Read from persistent agent memory. FREE."""
    try:
        params = {"namespace": namespace}
        if key:
            params["key"] = key
        resp = requests.get(f"{AGORAGENTIC_BASE_URL}/api/vault/memory", params=params, headers=_headers(), timeout=15)
        return json.dumps(resp.json(), indent=2)
    except Exception as e:
        return json.dumps({"error": str(e)})


def agoragentic_secret_store(label: str, secret: str, hint: str = "") -> str:
    """Store an AES-256 encrypted secret. $0.25 per secret."""
    try:
        resp = requests.post(f"{AGORAGENTIC_BASE_URL}/api/vault/secrets",
                             json={"input": {"label": label, "secret": secret, "hint": hint or None}},
                             headers=_headers(), timeout=30)
        return json.dumps(resp.json(), indent=2)
    except Exception as e:
        return json.dumps({"error": str(e)})


def agoragentic_secret_retrieve(label: str = "") -> str:
    """Retrieve a decrypted secret. FREE."""
    try:
        params = {}
        if label:
            params["label"] = label
        resp = requests.get(f"{AGORAGENTIC_BASE_URL}/api/vault/secrets", params=params, headers=_headers(), timeout=15)
        return json.dumps(resp.json(), indent=2)
    except Exception as e:
        return json.dumps({"error": str(e)})


def agoragentic_passport(action: str = "check", wallet_address: str = "") -> str:
    """Check or verify Agoragentic Passport NFT identity on Base L2."""
    try:
        if action == "info":
            resp = requests.get(f"{AGORAGENTIC_BASE_URL}/api/passport/info", timeout=15)
        elif action == "verify" and wallet_address:
            resp = requests.get(f"{AGORAGENTIC_BASE_URL}/api/passport/verify/{wallet_address}", timeout=15)
        else:
            resp = requests.get(f"{AGORAGENTIC_BASE_URL}/api/passport/check", headers=_headers(), timeout=15)
        return json.dumps(resp.json(), indent=2)
    except Exception as e:
        return json.dumps({"error": str(e)})


# ─── AutoGen Function Schemas ─────────────────────────────

def get_agoragentic_functions(api_key: str = ""):
    """Get AutoGen-compatible function definitions for Agoragentic tools."""
    global _API_KEY
    _API_KEY = api_key

    return [
        {"name": "agoragentic_register", "description": "Register on Agoragentic marketplace. Returns API key.",
         "parameters": {"type": "object", "properties": {
             "agent_name": {"type": "string", "description": "Your agent name"},
             "agent_type": {"type": "string", "enum": ["buyer", "seller", "both"], "default": "both"}
         }, "required": ["agent_name"]}},
        {"name": "agoragentic_search", "description": "Search marketplace for capabilities, tools, services.",
         "parameters": {"type": "object", "properties": {
             "query": {"type": "string", "description": "Search term"},
             "category": {"type": "string", "description": "Category filter"},
             "max_price": {"type": "number", "description": "Max price in USDC"},
             "limit": {"type": "integer", "default": 10}
         }}},
        {"name": "agoragentic_invoke", "description": "Invoke a capability. Auto-pays from USDC balance.",
         "parameters": {"type": "object", "properties": {
             "capability_id": {"type": "string", "description": "Capability ID from search"},
             "input_data": {"type": "string", "description": "JSON input payload"}
         }, "required": ["capability_id"]}},
        {"name": "agoragentic_vault", "description": "View your vault inventory.",
         "parameters": {"type": "object", "properties": {
             "item_type": {"type": "string", "description": "Filter: skill, digital_asset, nft, collectible"}
         }}},
        {"name": "agoragentic_memory_write", "description": "Write to persistent memory. $0.10/write.",
         "parameters": {"type": "object", "properties": {
             "key": {"type": "string"}, "value": {"type": "string"},
             "namespace": {"type": "string", "default": "default"}
         }, "required": ["key", "value"]}},
        {"name": "agoragentic_memory_read", "description": "Read from persistent memory. FREE.",
         "parameters": {"type": "object", "properties": {
             "key": {"type": "string"}, "namespace": {"type": "string", "default": "default"}
         }}},
        {"name": "agoragentic_secret_store", "description": "Store AES-256 encrypted secret. $0.25.",
         "parameters": {"type": "object", "properties": {
             "label": {"type": "string"}, "secret": {"type": "string"}, "hint": {"type": "string"}
         }, "required": ["label", "secret"]}},
        {"name": "agoragentic_secret_retrieve", "description": "Retrieve decrypted secret. FREE.",
         "parameters": {"type": "object", "properties": {"label": {"type": "string"}}}},
        {"name": "agoragentic_passport", "description": "Check/verify Passport NFT identity on Base L2.",
         "parameters": {"type": "object", "properties": {
             "action": {"type": "string", "enum": ["check", "info", "verify"]},
             "wallet_address": {"type": "string"}
         }}}
    ]


# Function map for AutoGen UserProxyAgent
FUNCTION_MAP = {
    "agoragentic_register": agoragentic_register,
    "agoragentic_search": agoragentic_search,
    "agoragentic_invoke": agoragentic_invoke,
    "agoragentic_vault": agoragentic_vault,
    "agoragentic_memory_write": agoragentic_memory_write,
    "agoragentic_memory_read": agoragentic_memory_read,
    "agoragentic_secret_store": agoragentic_secret_store,
    "agoragentic_secret_retrieve": agoragentic_secret_retrieve,
    "agoragentic_passport": agoragentic_passport,
}
