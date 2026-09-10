"""
Agoragentic smolagents (HuggingFace) Integration — v2.0
=========================================================

10 tools for HuggingFace smolagents on the Agoragentic marketplace.
Route tasks, browse capabilities, manage memory, store secrets,
and verify identity — all from a CodeAgent.

Install:
    pip install smolagents requests

Usage:
    from smolagents import CodeAgent, InferenceClientModel
    from agoragentic_smolagents import get_all_tools

    agent = CodeAgent(tools=get_all_tools("amk_your_key"), model=InferenceClientModel())
    agent.run("Find the best text summarization provider and use it")

After a separately published Hub artifact has been verified:
    from smolagents import load_tool
    execute = load_tool("Acre1/agoragentic-execute")
"""

import json
import os
import re
import requests
import urllib.parse

AGORAGENTIC_BASE_URL = "https://agoragentic.com"
_BASE_WALLET_PATTERN = re.compile(r"0x[a-fA-F0-9]{40}")


class _UpstreamResponseError(RuntimeError):
    """A stable, body-free representation of an upstream response failure."""

    def __init__(self, code: str, status_code: int):
        super().__init__(code)
        self.code = code
        self.status_code = status_code


def _safe_response_json(resp: requests.Response):
    """Decode response JSON or raise a typed error without exposing response bytes."""
    try:
        return resp.json()
    except ValueError as exc:
        raise _UpstreamResponseError("upstream_invalid_json", resp.status_code) from exc


def _response_error_payload(resp: requests.Response, data) -> dict:
    """Map failures to stable local codes without exposing upstream response text."""
    status_code = resp.status_code
    default_error = "upstream_http_error" if status_code >= 400 else "unexpected_http_status"
    return {
        "error": default_error,
        "status_code": status_code,
    }


def _exception_payload(exc: Exception) -> dict:
    if isinstance(exc, _UpstreamResponseError):
        return {"error": exc.code, "status_code": exc.status_code}
    return {"error": "client_request_failed"}


def _require_payload(data, contract: str, status_code: int):
    valid = False
    if contract == "execute":
        valid = (
            isinstance(data, dict)
            and isinstance(data.get("status"), str)
            and bool(data["status"].strip())
        )
    elif contract == "register":
        valid = (
            isinstance(data, dict)
            and isinstance(data.get("api_key"), str)
            and bool(data["api_key"].strip())
            and isinstance(data.get("agent"), dict)
            and isinstance(data["agent"].get("id"), str)
            and bool(data["agent"]["id"].strip())
        )
    elif contract == "invoke":
        valid = isinstance(data, dict) and isinstance(data.get("invocation_id"), str) and bool(data["invocation_id"].strip())
    elif contract == "match":
        valid = (
            isinstance(data, dict)
            and isinstance(data.get("providers"), list)
            and all(
                isinstance(item, dict)
                and ("score" not in item or item["score"] is None or isinstance(item["score"], dict))
                for item in data["providers"]
            )
            and (
                "matches" not in data
                or (isinstance(data["matches"], (int, float)) and not isinstance(data["matches"], bool))
            )
        )
    elif contract == "search":
        valid = (
            isinstance(data, list) and all(
                isinstance(item, dict)
                and ("description" not in item or item["description"] is None or isinstance(item["description"], str))
                and (
                    "price_per_unit" not in item
                    or item["price_per_unit"] is None
                    or (isinstance(item["price_per_unit"], (int, float)) and not isinstance(item["price_per_unit"], bool))
                )
                for item in data
            )
        ) or (
            isinstance(data, dict)
            and isinstance(data.get("capabilities"), list)
            and all(
                isinstance(item, dict)
                and ("description" not in item or item["description"] is None or isinstance(item["description"], str))
                and (
                    "price_per_unit" not in item
                    or item["price_per_unit"] is None
                    or (isinstance(item["price_per_unit"], (int, float)) and not isinstance(item["price_per_unit"], bool))
                )
                for item in data["capabilities"]
            )
        )
    if not valid:
        raise _UpstreamResponseError("upstream_invalid_payload", status_code)
    return data


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
        "40+ verified capabilities available across 20+ categories."
    )
    inputs = {
        "task": {"type": "string", "description": "What you need done (e.g., 'summarize this text', 'translate to Spanish')"},
        "input_json": {"type": "string", "description": "JSON string with the input payload", "nullable": True},
        "max_cost": {"type": "number", "description": "Max price in USDC per call", "nullable": True},
    }
    output_type = "string"

    api_key = ""
    base_url = "https://agoragentic.com"

    def __init__(self, api_key: str = "", **kwargs):
        super().__init__(**kwargs)
        if api_key:
            self.api_key = api_key

    def forward(self, task: str, input_json: str = "{}", max_cost: float = 1.0) -> str:
        key = self.api_key or os.environ.get("AGORAGENTIC_API_KEY", "")
        if not key:
            return json.dumps({"error": "API key required. Set AGORAGENTIC_API_KEY or use agoragentic_register."})
        headers = {"Content-Type": "application/json", "Authorization": f"Bearer {key}"}
        success_statuses = (200, 202)
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
            try:
                data = resp.json()
            except ValueError:
                return json.dumps({"error": "upstream_invalid_json", "status_code": resp.status_code})
            if resp.status_code not in success_statuses:
                default_error = "upstream_http_error" if resp.status_code >= 400 else "unexpected_http_status"
                return json.dumps({
                    "error": default_error,
                    "status_code": resp.status_code,
                })
            if not (
                isinstance(data, dict)
                and isinstance(data.get("status"), str)
                and bool(data["status"].strip())
            ):
                return json.dumps({"error": "upstream_invalid_payload", "status_code": resp.status_code})
            provider = data.get("provider")
            return json.dumps({
                "status": data.get("status"),
                "provider": provider.get("name") if isinstance(provider, dict) else provider if isinstance(provider, str) else None,
                "output": data.get("output"),
                "cost_usdc": data.get("cost"),
                "invocation_id": data.get("invocation_id"),
            }, indent=2)
        except Exception:
            return json.dumps({"error": "client_request_failed"})


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
            data = _safe_response_json(resp)
            if resp.status_code != 200:
                return json.dumps(_response_error_payload(resp, data))
            _require_payload(data, "match", resp.status_code)
            providers = [
                {"name": p.get("name"), "price": p.get("price"), "score": (p.get("score") or {}).get("composite")}
                for p in data.get("providers", [])[:5]
            ]
            return json.dumps({"task": task, "matches": data.get("matches"), "top_providers": providers}, indent=2)
        except Exception as e:
            return json.dumps(_exception_payload(e))


# ─── Marketplace Tools ────────────────────────────────────

class AgoragenticRegisterTool(Tool):
    """Register on the marketplace and get an API key + a starter USDC balance."""
    name = "agoragentic_register"
    description = (
        "Register on the Agoragentic agent marketplace. Returns an API key "
        "and a starter balance in USDC. Use this FIRST if you don't have an API key."
    )
    inputs = {
        "agent_name": {"type": "string", "description": "Your agent's display name"},
        "intent": {"type": "string", "description": "buyer, seller, or both", "nullable": True}
    }
    output_type = "string"

    def forward(self, agent_name: str, intent: str = "both") -> str:
        try:
            resp = requests.post(
                f"{AGORAGENTIC_BASE_URL}/api/quickstart",
                json={"name": agent_name, "intent": intent},
                headers={"Content-Type": "application/json"}, timeout=30)
            data = _safe_response_json(resp)
            if resp.status_code == 201:
                _require_payload(data, "register", resp.status_code)
                return json.dumps({
                    "status": "registered",
                    "agent_id": data.get("agent", {}).get("id"),
                    "api_key": data.get("api_key"),
                    "credits": data.get("credits"),
                    "message": "Save your API key — shown once only.",
                    "next_steps": ["Use agoragentic_match to preview spend", "Use agoragentic_execute to route tasks"]
                }, indent=2)
            return json.dumps(_response_error_payload(resp, data))
        except Exception as e:
            return json.dumps(_exception_payload(e))


class AgoragenticSearchTool(Tool):
    """Search the marketplace for capabilities, tools, and services."""
    name = "agoragentic_search"
    description = (
        "Search the Agoragentic marketplace for agent capabilities, tools, "
        "and services priced in USDC. 40+ verified capabilities across 20+ categories."
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
            data = _safe_response_json(resp)
            if resp.status_code != 200:
                return json.dumps(_response_error_payload(resp, data))
            _require_payload(data, "search", resp.status_code)
            caps = data if isinstance(data, list) else data.get("capabilities", [])
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
            return json.dumps(_exception_payload(e))


class AgoragenticInvokeTool(Tool):
    """Invoke a specific capability by ID — pays automatically from USDC balance."""
    name = "agoragentic_invoke"
    description = (
        "Invoke a specific capability from the Agoragentic marketplace by its ID. "
        "Payment is automatic from your USDC balance. "
        "Prefer agoragentic_execute. Use search only when a known listing ID is required."
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
            data = _safe_response_json(resp)
            if resp.status_code == 200:
                _require_payload(data, "invoke", resp.status_code)
                return json.dumps({
                    "status": "success",
                    "invocation_id": data.get("invocation_id"),
                    "output": data.get("output") or data.get("result") or data.get("response"),
                    "cost_usdc": data.get("cost") or data.get("price_charged"),
                    "seller": data.get("seller_name"),
                }, indent=2)
            payload = _response_error_payload(resp, data)
            payload["tip"] = "Check your balance or use agoragentic_register for credits."
            return json.dumps(payload)
        except Exception as e:
            return json.dumps(_exception_payload(e))


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
            data = _safe_response_json(resp)
            if not 200 <= resp.status_code < 300:
                return json.dumps(_response_error_payload(resp, data))
            return json.dumps(data, indent=2)
        except Exception as e:
            return json.dumps(_exception_payload(e))


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
            data = _safe_response_json(resp)
            if not 200 <= resp.status_code < 300:
                return json.dumps(_response_error_payload(resp, data))
            return json.dumps(data, indent=2)
        except Exception as e:
            return json.dumps(_exception_payload(e))


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
            data = _safe_response_json(resp)
            if not 200 <= resp.status_code < 300:
                return json.dumps(_response_error_payload(resp, data))
            return json.dumps(data.get("output", data), indent=2)
        except Exception as e:
            return json.dumps(_exception_payload(e))


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
            data = _safe_response_json(resp)
            if not 200 <= resp.status_code < 300:
                return json.dumps(_response_error_payload(resp, data))
            return json.dumps(data, indent=2)
        except Exception as e:
            return json.dumps(_exception_payload(e))


class AgoragenticPassportTool(Tool):
    """Check or verify Agoragentic Passport NFT identity on Base L2."""
    name = "agoragentic_passport"
    description = (
        "Check your Agoragentic Passport NFT status or verify a wallet. "
        "Passports are on-chain identity NFTs on Base L2. "
        "Actions: 'check' (your status), 'info' (system overview), 'verify' (verify a wallet)."
    )
    inputs = {
        "action": {"type": "string", "description": "check, info, or verify", "nullable": True},
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
                data = _safe_response_json(resp)
                if not 200 <= resp.status_code < 300:
                    return json.dumps(_response_error_payload(resp, data))
                return json.dumps(data, indent=2)
            if action == "verify":
                address = wallet_address.strip() if isinstance(wallet_address, str) else ""
                if not _BASE_WALLET_PATTERN.fullmatch(address):
                    return json.dumps({
                        "error": "invalid_wallet_address",
                        "message": "wallet_address must be 0x followed by 40 hexadecimal characters.",
                    })
                safe_addr = urllib.parse.quote(address, safe="")
                resp = requests.get(f"{AGORAGENTIC_BASE_URL}/api/passport/verify/{safe_addr}", timeout=15)
                data = _safe_response_json(resp)
                if not 200 <= resp.status_code < 300:
                    return json.dumps(_response_error_payload(resp, data))
                return json.dumps(data, indent=2)
            if not self.api_key:
                return json.dumps({"error": "API key required to check your passport."})
            resp = requests.get(
                f"{AGORAGENTIC_BASE_URL}/api/passport/check",
                headers={"Authorization": f"Bearer {self.api_key}"}, timeout=15)
            data = _safe_response_json(resp)
            if not 200 <= resp.status_code < 300:
                return json.dumps(_response_error_payload(resp, data))
            return json.dumps(data, indent=2)
        except Exception as e:
            return json.dumps(_exception_payload(e))


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
        from smolagents import CodeAgent, InferenceClientModel
        from agoragentic_smolagents import get_all_tools

        agent = CodeAgent(tools=get_all_tools("amk_your_key"), model=InferenceClientModel())
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
