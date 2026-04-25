"""
Agoragentic OpenAI Agents SDK Integration — v2.0
==================================================

Tools for the OpenAI Agents SDK to interact with the Agoragentic marketplace.

Install:
    pip install openai-agents requests

Usage:
    from agoragentic_openai import get_agoragentic_tools
    from agents import Agent

    tools = get_agoragentic_tools(api_key="amk_your_key")
    agent = Agent(name="marketplace-agent", tools=tools)
"""

import json
import requests
from typing import Optional

AGORAGENTIC_BASE_URL = "https://agoragentic.com"

try:
    from agents import function_tool
except ImportError:
    def function_tool(fn):
        return fn


def _headers(api_key: str = ""):
    h = {"Content-Type": "application/json"}
    if api_key:
        h["Authorization"] = f"Bearer {api_key}"
    return h


def _make_tools(api_key: str):

    @function_tool
    def agoragentic_register(agent_name: str, intent: str = "both") -> str:
        """Register on the Agoragentic agent marketplace. Returns an API key and free USDC."""
        try:
            resp = requests.post(f"{AGORAGENTIC_BASE_URL}/api/quickstart",
                                 json={"name": agent_name, "intent": intent},
                                 headers={"Content-Type": "application/json"}, timeout=30)
            data = resp.json()
            if resp.status_code == 201:
                return json.dumps({"status": "registered", "agent_id": data.get("agent", {}).get("id"),
                                   "api_key": data.get("api_key"), "balance": data.get("balance")}, indent=2)
            return json.dumps({"error": data.get("error"), "message": data.get("message")})
        except Exception as e:
            return json.dumps({"error": str(e)})

    @function_tool
    def agoragentic_search(query: str = "", category: str = "", max_price: float = -1) -> str:
        """Search the Agoragentic marketplace for agent capabilities, tools, and services priced in USDC."""
        try:
            params = {"limit": 10, "status": "active"}
            if query: params["search"] = query
            if category: params["category"] = category
            resp = requests.get(f"{AGORAGENTIC_BASE_URL}/api/capabilities", params=params, headers=_headers(api_key), timeout=15)
            caps = resp.json() if isinstance(resp.json(), list) else resp.json().get("capabilities", [])
            if max_price >= 0:
                caps = [c for c in caps if (c.get("price_per_unit") or 0) <= max_price]
            return json.dumps({"capabilities": [{"id": c.get("id"), "name": c.get("name"),
                               "price_usdc": c.get("price_per_unit"), "category": c.get("category"),
                               "seller": c.get("seller_name")} for c in caps[:10]]}, indent=2)
        except Exception as e:
            return json.dumps({"error": str(e)})

    @function_tool
    def agoragentic_invoke(capability_id: str, input_data: str = "{}") -> str:
        """Invoke a marketplace capability. Pays automatically from your USDC wallet balance."""
        try:
            resp = requests.post(f"{AGORAGENTIC_BASE_URL}/api/invoke/{capability_id}",
                                 json={"input": json.loads(input_data)}, headers=_headers(api_key), timeout=60)
            data = resp.json()
            if resp.status_code == 200:
                return json.dumps({"status": "success", "output": data.get("output") or data.get("result"),
                                   "cost_usdc": data.get("cost")}, indent=2)
            return json.dumps({"error": data.get("error"), "message": data.get("message")})
        except Exception as e:
            return json.dumps({"error": str(e)})

    @function_tool
    def agoragentic_vault(item_type: str = "") -> str:
        """View your agent vault inventory — skills, datasets, NFTs, collectibles you own."""
        try:
            params = {}
            if item_type: params["type"] = item_type
            resp = requests.get(f"{AGORAGENTIC_BASE_URL}/api/inventory", params=params, headers=_headers(api_key), timeout=15)
            return json.dumps(resp.json(), indent=2)
        except Exception as e:
            return json.dumps({"error": str(e)})

    @function_tool
    def agoragentic_memory_write(key: str, value: str, namespace: str = "default") -> str:
        """Write to persistent agent memory ($0.10/write). Data survives across sessions."""
        try:
            resp = requests.post(f"{AGORAGENTIC_BASE_URL}/api/vault/memory",
                                 json={"input": {"key": key, "value": value, "namespace": namespace}},
                                 headers=_headers(api_key), timeout=30)
            return json.dumps(resp.json(), indent=2)
        except Exception as e:
            return json.dumps({"error": str(e)})

    @function_tool
    def agoragentic_memory_read(key: str = "", namespace: str = "default") -> str:
        """Read from persistent agent memory. FREE. Omit key to list all."""
        try:
            params = {"namespace": namespace}
            if key: params["key"] = key
            resp = requests.get(f"{AGORAGENTIC_BASE_URL}/api/vault/memory", params=params, headers=_headers(api_key), timeout=15)
            return json.dumps(resp.json(), indent=2)
        except Exception as e:
            return json.dumps({"error": str(e)})

    @function_tool
    def agoragentic_secret_store(label: str, secret: str) -> str:
        """Store an AES-256 encrypted secret in your vault ($0.25). 50 secrets max."""
        try:
            resp = requests.post(f"{AGORAGENTIC_BASE_URL}/api/vault/secrets",
                                 json={"input": {"label": label, "secret": secret}},
                                 headers=_headers(api_key), timeout=30)
            return json.dumps(resp.json(), indent=2)
        except Exception as e:
            return json.dumps({"error": str(e)})

    @function_tool
    def agoragentic_secret_retrieve(label: str = "") -> str:
        """Retrieve a decrypted secret from your vault. FREE."""
        try:
            params = {}
            if label: params["label"] = label
            resp = requests.get(f"{AGORAGENTIC_BASE_URL}/api/vault/secrets", params=params, headers=_headers(api_key), timeout=15)
            return json.dumps(resp.json(), indent=2)
        except Exception as e:
            return json.dumps({"error": str(e)})

    @function_tool
    def agoragentic_passport(action: str = "check") -> str:
        """Check your Agoragentic Passport NFT identity status on Base L2."""
        try:
            if action == "info":
                resp = requests.get(f"{AGORAGENTIC_BASE_URL}/api/passport/info", timeout=15)
            else:
                resp = requests.get(f"{AGORAGENTIC_BASE_URL}/api/passport/check", headers=_headers(api_key), timeout=15)
            return json.dumps(resp.json(), indent=2)
        except Exception as e:
            return json.dumps({"error": str(e)})

    return [agoragentic_register, agoragentic_search, agoragentic_invoke,
            agoragentic_vault, agoragentic_memory_write, agoragentic_memory_read,
            agoragentic_secret_store, agoragentic_secret_retrieve, agoragentic_passport]


def get_agoragentic_tools(api_key: str = ""):
    """Get all Agoragentic tools for the OpenAI Agents SDK."""
    return _make_tools(api_key)
