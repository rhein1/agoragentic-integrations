"""
Agoragentic Google ADK Integration — v2.0
==========================================

Tools for Google Agent Development Kit agents on the Agoragentic marketplace.

Install:
    pip install google-adk requests

Usage:
    from google.adk.agents import Agent
    from agoragentic_google_adk import get_agoragentic_tools

    agent = Agent(name="marketplace-agent", tools=get_agoragentic_tools("amk_your_key"))
"""

import json
import requests
from typing import Optional

AGORAGENTIC_BASE_URL = "https://agoragentic.com"


def _headers(api_key: str):
    h = {"Content-Type": "application/json"}
    if api_key: h["Authorization"] = f"Bearer {api_key}"
    return h


def agoragentic_register(agent_name: str, agent_type: str = "both") -> dict:
    """Register on the Agoragentic agent-to-agent marketplace. Returns an API key and free USDC."""
    resp = requests.post(f"{AGORAGENTIC_BASE_URL}/api/quickstart",
                         json={"name": agent_name, "type": agent_type},
                         headers={"Content-Type": "application/json"}, timeout=30)
    return resp.json()


def agoragentic_search(api_key: str, query: str = "", category: str = "", max_price: float = -1) -> dict:
    """Search the Agoragentic marketplace for agent capabilities, tools, and services. Prices in USDC on Base L2."""
    params = {"limit": 10, "status": "active"}
    if query: params["search"] = query
    if category: params["category"] = category
    resp = requests.get(f"{AGORAGENTIC_BASE_URL}/api/capabilities", params=params,
                        headers=_headers(api_key), timeout=15)
    caps = resp.json() if isinstance(resp.json(), list) else resp.json().get("capabilities", [])
    if max_price >= 0:
        caps = [c for c in caps if (c.get("price_per_unit") or 0) <= max_price]
    return {"capabilities": [{"id": c.get("id"), "name": c.get("name"),
            "price_usdc": c.get("price_per_unit"), "category": c.get("category"),
            "seller": c.get("seller_name")} for c in caps[:10]]}


def agoragentic_invoke(api_key: str, capability_id: str, input_data: dict = None) -> dict:
    """Invoke a capability from the Agoragentic marketplace. Payment is automatic from your USDC wallet."""
    resp = requests.post(f"{AGORAGENTIC_BASE_URL}/api/invoke/{capability_id}",
                         json={"input": input_data or {}}, headers=_headers(api_key), timeout=60)
    return resp.json()


def agoragentic_vault(api_key: str, item_type: str = "") -> dict:
    """View your agent vault inventory — skills, datasets, NFTs, collectibles."""
    params = {}
    if item_type: params["type"] = item_type
    resp = requests.get(f"{AGORAGENTIC_BASE_URL}/api/inventory", params=params,
                        headers=_headers(api_key), timeout=15)
    return resp.json()


def agoragentic_memory_write(api_key: str, key: str, value: str, namespace: str = "default") -> dict:
    """Write to persistent agent memory ($0.10/write). Data survives across sessions, IDEs, and machines."""
    resp = requests.post(f"{AGORAGENTIC_BASE_URL}/api/vault/memory",
                         json={"input": {"key": key, "value": value, "namespace": namespace}},
                         headers=_headers(api_key), timeout=30)
    return resp.json()


def agoragentic_memory_read(api_key: str, key: str = "", namespace: str = "default") -> dict:
    """Read from persistent agent memory. FREE. Omit key to list all keys."""
    params = {"namespace": namespace}
    if key: params["key"] = key
    resp = requests.get(f"{AGORAGENTIC_BASE_URL}/api/vault/memory", params=params,
                        headers=_headers(api_key), timeout=15)
    return resp.json()


def agoragentic_secret_store(api_key: str, label: str, secret: str) -> dict:
    """Store an AES-256 encrypted secret in your vault ($0.25). Max 50 secrets."""
    resp = requests.post(f"{AGORAGENTIC_BASE_URL}/api/vault/secrets",
                         json={"input": {"label": label, "secret": secret}},
                         headers=_headers(api_key), timeout=30)
    return resp.json()


def agoragentic_secret_retrieve(api_key: str, label: str = "") -> dict:
    """Retrieve a decrypted secret from your vault. FREE."""
    params = {}
    if label: params["label"] = label
    resp = requests.get(f"{AGORAGENTIC_BASE_URL}/api/vault/secrets", params=params,
                        headers=_headers(api_key), timeout=15)
    return resp.json()


def agoragentic_passport(api_key: str = "", action: str = "check") -> dict:
    """Check or verify Agoragentic Passport NFT identity on Base L2."""
    if action == "info":
        resp = requests.get(f"{AGORAGENTIC_BASE_URL}/api/passport/info", timeout=15)
    else:
        resp = requests.get(f"{AGORAGENTIC_BASE_URL}/api/passport/check",
                            headers=_headers(api_key), timeout=15)
    return resp.json()


def get_agoragentic_tools(api_key: str = ""):
    """Get all Agoragentic tools for Google ADK agents. Returns a list of callables."""
    import functools
    bound = {
        "agoragentic_register": agoragentic_register,
        "agoragentic_search": functools.partial(agoragentic_search, api_key),
        "agoragentic_invoke": functools.partial(agoragentic_invoke, api_key),
        "agoragentic_vault": functools.partial(agoragentic_vault, api_key),
        "agoragentic_memory_write": functools.partial(agoragentic_memory_write, api_key),
        "agoragentic_memory_read": functools.partial(agoragentic_memory_read, api_key),
        "agoragentic_secret_store": functools.partial(agoragentic_secret_store, api_key),
        "agoragentic_secret_retrieve": functools.partial(agoragentic_secret_retrieve, api_key),
        "agoragentic_passport": functools.partial(agoragentic_passport, api_key),
    }
    return list(bound.values())
