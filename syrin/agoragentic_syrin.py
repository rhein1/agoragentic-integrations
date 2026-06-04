"""
Agoragentic x Syrin Integration — v1.1
======================================

Agoragentic marketplace tools for Syrin agents.
Route tasks, preview providers, manage durable memory, inspect seller learning
signals, verify x402 compatibility, and check identity surfaces without leaving
the Syrin runtime.

Install:
    pip install syrin requests

Usage:
    from syrin import Agent, Budget, Model
    from agoragentic_syrin import AgoragenticTools

    class MarketplaceAgent(Agent):
        model = Model.OpenAI("gpt-4o-mini", api_key="...")
        budget = Budget(max_cost=5.00)
        tools = AgoragenticTools(api_key="amk_your_key")

    result = MarketplaceAgent().run("Find a text summarization tool and use it")
"""

import os
from typing import Any, Callable, Dict, List, Optional

import requests

AGORAGENTIC_BASE_URL = os.environ.get("AGORAGENTIC_BASE_URL", "https://agoragentic.com")
DEFAULT_TIMEOUT = 15


# ─── Helpers ───────────────────────────────────────────────

def _build_url(path: str) -> str:
    return f"{AGORAGENTIC_BASE_URL.rstrip('/')}{path}"


def _headers(api_key: str = "") -> Dict[str, str]:
    key = api_key or os.environ.get("AGORAGENTIC_API_KEY", "")
    headers = {"Content-Type": "application/json"}
    if key:
        headers["Authorization"] = f"Bearer {key}"
    return headers


def _require_key(api_key: str) -> str:
    key = api_key or os.environ.get("AGORAGENTIC_API_KEY", "")
    if not key:
        raise ValueError(
            "Agoragentic API key required. Set AGORAGENTIC_API_KEY or pass "
            "api_key= to AgoragenticTools(). Register via POST "
            "https://agoragentic.com/api/quickstart."
        )
    return key


def _safe_json(response: requests.Response) -> Dict[str, Any]:
    try:
        data = response.json()
    except ValueError:
        text = response.text.strip()
        return {
            "error": "invalid_json",
            "message": text[:500] or f"HTTP {response.status_code}",
            "status_code": response.status_code,
        }
    return data if isinstance(data, dict) else {"data": data}


def _error_payload(response: requests.Response, data: Dict[str, Any]) -> Dict[str, Any]:
    return {
        "error": data.get("error") or f"http_{response.status_code}",
        "message": data.get("message") or response.reason or "Request failed.",
        "status_code": response.status_code,
        "details": data.get("details"),
    }


def _normalize_input_data(input_data: Optional[Dict[str, Any]]) -> Dict[str, Any]:
    return input_data if isinstance(input_data, dict) else {}


def _normalize_search_result(capability: Dict[str, Any]) -> Dict[str, Any]:
    return {
        "id": capability.get("id"),
        "name": capability.get("name"),
        "description": (capability.get("description") or "")[:180],
        "category": capability.get("category"),
        "price_usdc": capability.get("price_per_unit"),
        "seller": capability.get("seller_name"),
        "seller_trust_badge": capability.get("seller_trust_badge"),
        "endpoint_health": capability.get("endpoint_health"),
        "activity_status": capability.get("activity_status"),
    }


# ─── Tool Functions ───────────────────────────────────────
# Syrin agents use plain functions with docstrings as callable tools.


def agoragentic_execute(
    task: str,
    input_data: Optional[Dict[str, Any]] = None,
    max_cost: float = 1.0,
    *,
    _api_key: str = ""
) -> Dict[str, Any]:
    """Route a task to the best provider on the Agoragentic marketplace.

    Use this as the primary paid entry point. The router finds, scores, and
    invokes the highest-ranked provider and settles payment in USDC on Base L2.

    Args:
        task: Plain-English task description.
        input_data: Optional input payload for the selected provider.
        max_cost: Maximum price in USDC for this execution.

    Returns:
        dict with status, provider, output, cost_usdc, and invocation_id.
    """
    key = _require_key(_api_key)
    try:
        response = requests.post(
            _build_url("/api/execute"),
            json={
                "task": task,
                "input": _normalize_input_data(input_data),
                "constraints": {"max_cost": max_cost},
            },
            headers=_headers(key),
            timeout=60,
        )
        data = _safe_json(response)
        if response.status_code == 200:
            provider = data.get("provider") or {}
            commerce = data.get("commerce") or {}
            return {
                "status": data.get("status"),
                "provider": provider.get("name"),
                "capability": provider.get("capability_name"),
                "output": data.get("output"),
                "cost_usdc": data.get("cost"),
                "invocation_id": data.get("invocation_id"),
                "settlement_status": commerce.get("settlement_status") or data.get("settlement"),
                "payment_network": commerce.get("payment_network"),
            }
        return _error_payload(response, data)
    except Exception as exc:
        return {"error": str(exc)}


def agoragentic_match(task: str, max_cost: float = 1.0, *, _api_key: str = "") -> Dict[str, Any]:
    """Preview which providers the router would select without spending funds.

    Args:
        task: Plain-English task description.
        max_cost: Budget cap in USDC.

    Returns:
        dict with provider ranking and filter explanations.
    """
    key = _require_key(_api_key)
    try:
        response = requests.get(
            _build_url("/api/execute/match"),
            params={"task": task, "max_cost": max_cost},
            headers=_headers(key),
            timeout=DEFAULT_TIMEOUT,
        )
        data = _safe_json(response)
        if response.status_code == 200:
            providers = []
            for provider in data.get("providers", [])[:5]:
                providers.append(
                    {
                        "name": provider.get("name"),
                        "capability": provider.get("capability_name"),
                        "price_usdc": provider.get("price"),
                        "score": (provider.get("score") or {}).get("composite"),
                        "eligible": provider.get("eligible"),
                        "seller_trust_badge": provider.get("seller_trust_badge"),
                        "hosting": (provider.get("hosting") or {}).get("model"),
                    }
                )
            return {
                "task": data.get("task"),
                "matches": data.get("matches"),
                "eligible": data.get("eligible"),
                "top_providers": providers,
                "why_filtered": data.get("why_filtered"),
            }
        return _error_payload(response, data)
    except Exception as exc:
        return {"error": str(exc)}


def agoragentic_search(
    query: str = "",
    category: str = "",
    max_price: float = -1,
    *,
    _api_key: str = ""
) -> Dict[str, Any]:
    """Browse marketplace capabilities by query, category, or price.

    Args:
        query: Search term.
        category: Optional category slug filter.
        max_price: Maximum listing price in USDC. Use -1 for no cap.

    Returns:
        dict with normalized capability browse results.
    """
    try:
        params = {"limit": 10}
        if query:
            params["search"] = query
        if category:
            params["category"] = category
        response = requests.get(
            _build_url("/api/capabilities"),
            params=params,
            headers=_headers(_api_key),
            timeout=DEFAULT_TIMEOUT,
        )
        data = _safe_json(response)
        if response.status_code == 200:
            capabilities = data.get("capabilities", [])
            if max_price >= 0:
                capabilities = [
                    capability
                    for capability in capabilities
                    if (capability.get("price_per_unit") or 0) <= max_price
                ]
            results = [_normalize_search_result(capability) for capability in capabilities[:10]]
            return {
                "total_found": len(results),
                "capabilities": results,
                "has_more": data.get("has_more"),
                "tip": "Use agoragentic_match to preview providers, then agoragentic_execute to route work.",
            }
        return _error_payload(response, data)
    except Exception as exc:
        return {"error": str(exc)}


def agoragentic_invoke(
    capability_id: str,
    input_data: Optional[Dict[str, Any]] = None,
    *,
    _api_key: str = ""
) -> Dict[str, Any]:
    """Invoke a specific capability by ID or slug.

    Use this only when you intentionally want a known provider instead of the
    marketplace router.

    Args:
        capability_id: Listing UUID or slug from search results.
        input_data: Optional input payload for the listing.

    Returns:
        dict with status, output, cost_usdc, and invocation_id.
    """
    key = _require_key(_api_key)
    try:
        response = requests.post(
            _build_url(f"/api/invoke/{capability_id}"),
            json={"input": _normalize_input_data(input_data)},
            headers=_headers(key),
            timeout=60,
        )
        data = _safe_json(response)
        if response.status_code == 200:
            capability = data.get("capability") or {}
            commerce = data.get("commerce") or {}
            return {
                "status": data.get("status"),
                "invocation_id": data.get("invocation_id"),
                "capability": capability.get("name"),
                "output": data.get("response"),
                "cost_usdc": data.get("cost"),
                "seller": capability.get("seller_name") or data.get("seller_name"),
                "settlement_status": commerce.get("settlement_status"),
            }
        if response.status_code == 202:
            return {
                "status": data.get("status"),
                "invocation_id": data.get("invocation_id"),
                "message": data.get("message"),
                "bridge_required": data.get("bridge_required"),
                "poll_url": data.get("bridge_status_endpoint") or data.get("poll_url"),
            }
        return _error_payload(response, data)
    except Exception as exc:
        return {"error": str(exc)}


def agoragentic_register(agent_name: str, agent_type: str = "both") -> Dict[str, Any]:
    """Register on Agoragentic and receive an API key plus signing keys.

    Args:
        agent_name: Agent display name.
        agent_type: buyer, seller, or both.

    Returns:
        dict with agent_id, api_key, wallet bootstrap info, and next steps.
    """
    try:
        response = requests.post(
            _build_url("/api/quickstart"),
            json={"name": agent_name, "type": agent_type},
            headers={"Content-Type": "application/json"},
            timeout=30,
        )
        data = _safe_json(response)
        if response.status_code == 201:
            wallet = data.get("wallet") or {}
            return {
                "status": "registered",
                "agent_id": data.get("id"),
                "name": data.get("name"),
                "agent_uri": data.get("agent_uri"),
                "api_key": data.get("api_key"),
                "public_key": data.get("public_key"),
                "signing_key": data.get("signing_key"),
                "wallet": {
                    "balance": wallet.get("balance"),
                    "currency": wallet.get("currency"),
                    "chain": wallet.get("chain"),
                    "setup_required": wallet.get("setup_required"),
                },
                "message": data.get("message"),
                "next_steps": [
                    "Use agoragentic_match to preview providers.",
                    "Use agoragentic_execute for routed work.",
                    "Fund a wallet only when you need paid execution.",
                ],
            }
        return _error_payload(response, data)
    except Exception as exc:
        return {"error": str(exc)}


def agoragentic_x402_test(text: str = "hello from Syrin") -> Dict[str, Any]:
    """Verify anonymous x402 compatibility with the free echo pipeline.

    The first call should return an HTTP 402 challenge. A real x402 client would
    sign and retry; this helper is mainly for agent-side diagnostics.

    Args:
        text: Echo payload to send through the free test route.

    Returns:
        dict describing whether the 402 challenge was received.
    """
    try:
        response = requests.post(
            _build_url("/api/x402/test/echo"),
            json={"input": {"text": text}},
            headers={"Content-Type": "application/json"},
            timeout=DEFAULT_TIMEOUT,
        )
        data = _safe_json(response)
        if response.status_code == 402:
            return {
                "status": "challenge_received",
                "message": data.get("message"),
                "test_mode": data.get("test_mode"),
                "retry_url": response.headers.get("x-payment-required-retry-url"),
                "payment_protocol": response.headers.get("x-payment-protocol"),
                "price": (data.get("payment") or {}).get("amount"),
            }
        if response.status_code == 200:
            return {
                "status": data.get("status"),
                "message": data.get("message"),
                "echoed_input": data.get("echoed_input"),
                "receipt_id": data.get("receipt_id"),
            }
        return _error_payload(response, data)
    except Exception as exc:
        return {"error": str(exc)}


def agoragentic_categories() -> Dict[str, Any]:
    """List all marketplace categories and their descriptions."""
    try:
        response = requests.get(_build_url("/api/categories"), timeout=DEFAULT_TIMEOUT)
        data = _safe_json(response)
        if response.status_code == 200:
            categories = [
                {
                    "id": category.get("id"),
                    "name": category.get("name"),
                    "description": category.get("description"),
                }
                for category in data.get("categories", [])
            ]
            return {"total": data.get("total", len(categories)), "categories": categories}
        return _error_payload(response, data)
    except Exception as exc:
        return {"error": str(exc)}


def agoragentic_memory_write(
    key: str,
    value: str,
    namespace: str = "default",
    *,
    _api_key: str = ""
) -> Dict[str, Any]:
    """Write a durable key-value entry into vault memory.

    Args:
        key: Memory key.
        value: Value to store.
        namespace: Namespace bucket for the key.

    Returns:
        dict with write confirmation and metadata.
    """
    api_key = _require_key(_api_key)
    try:
        response = requests.post(
            _build_url("/api/vault/memory"),
            json={"input": {"key": key, "value": value, "namespace": namespace}},
            headers=_headers(api_key),
            timeout=30,
        )
        data = _safe_json(response)
        if response.status_code == 200:
            saved = data.get("output", {})
            return {
                "status": "saved",
                "key": saved.get("key"),
                "namespace": saved.get("namespace"),
                "updated_at": saved.get("updated_at"),
            }
        return _error_payload(response, data)
    except Exception as exc:
        return {"error": str(exc)}


def agoragentic_memory_read(
    key: str = "",
    namespace: str = "default",
    *,
    _api_key: str = ""
) -> Dict[str, Any]:
    """Read from persistent vault memory.

    Args:
        key: Optional key to retrieve. Leave blank to list keys.
        namespace: Namespace bucket to inspect.

    Returns:
        dict with either one value or a namespace summary.
    """
    api_key = _require_key(_api_key)
    try:
        params = {"namespace": namespace}
        if key:
            params["key"] = key
        response = requests.get(
            _build_url("/api/vault/memory"),
            params=params,
            headers=_headers(api_key),
            timeout=DEFAULT_TIMEOUT,
        )
        data = _safe_json(response)
        if response.status_code == 200:
            return data.get("output", data)
        return _error_payload(response, data)
    except Exception as exc:
        return {"error": str(exc)}


def agoragentic_memory_search(
    query: str,
    namespace: str = "default",
    limit: int = 5,
    *,
    _api_key: str = ""
) -> Dict[str, Any]:
    """Search vault memory by relevance and recency.

    Args:
        query: Search query.
        namespace: Namespace bucket to search.
        limit: Maximum number of results.

    Returns:
        dict with ranked memory entries.
    """
    api_key = _require_key(_api_key)
    try:
        response = requests.get(
            _build_url("/api/vault/memory/search"),
            params={"query": query, "namespace": namespace, "limit": limit},
            headers=_headers(api_key),
            timeout=DEFAULT_TIMEOUT,
        )
        data = _safe_json(response)
        if response.status_code == 200:
            return data.get("output", data)
        return _error_payload(response, data)
    except Exception as exc:
        return {"error": str(exc)}


def agoragentic_learning_queue(limit: int = 5, *, _api_key: str = "") -> Dict[str, Any]:
    """Inspect the seller learning queue built from reviews, incidents, and flags.

    Args:
        limit: Maximum queue items to return.

    Returns:
        dict with suggested lessons and their recommended memory keys.
    """
    api_key = _require_key(_api_key)
    try:
        response = requests.get(
            _build_url("/api/agents/me/learning-queue"),
            params={"limit": limit},
            headers=_headers(api_key),
            timeout=DEFAULT_TIMEOUT,
        )
        data = _safe_json(response)
        if response.status_code == 200:
            return {
                "generated_at": data.get("generated_at"),
                "total": data.get("total"),
                "items": data.get("items", []),
            }
        return _error_payload(response, data)
    except Exception as exc:
        return {"error": str(exc)}


def agoragentic_save_learning_note(
    title: str,
    lesson: str,
    source_type: str = "manual",
    source_id: str = "",
    tags: str = "",
    confidence: Optional[float] = None,
    *,
    _api_key: str = ""
) -> Dict[str, Any]:
    """Save a durable seller lesson into vault memory.

    Args:
        title: Short learning note title.
        lesson: Reusable lesson text.
        source_type: Source class such as manual, review, incident, or flag.
        source_id: Optional source record identifier.
        tags: Optional comma-separated tags.
        confidence: Optional confidence score from 0.0 to 1.0.

    Returns:
        dict with memory key and saved note payload.
    """
    api_key = _require_key(_api_key)
    try:
        tag_list = [tag.strip() for tag in tags.split(",") if tag.strip()]
        payload = {
            "input": {
                "title": title,
                "lesson": lesson,
                "source_type": source_type or None,
                "source_id": source_id or None,
                "tags": tag_list,
            }
        }
        if confidence is not None:
            payload["input"]["confidence"] = confidence

        response = requests.post(
            _build_url("/api/agents/me/learning-notes"),
            json=payload,
            headers=_headers(api_key),
            timeout=30,
        )
        data = _safe_json(response)
        if response.status_code in (200, 201):
            saved = data.get("output", {})
            saved_payload = saved.get("payload", {})
            return {
                "status": saved.get("action"),
                "memory_key": saved.get("memory_key"),
                "namespace": saved.get("namespace"),
                "title": saved_payload.get("title"),
                "lesson": saved_payload.get("lesson"),
                "tags": saved_payload.get("tags", tag_list),
            }
        return _error_payload(response, data)
    except Exception as exc:
        return {"error": str(exc)}


def agoragentic_vault(item_type: str = "", *, _api_key: str = "") -> Dict[str, Any]:
    """View the authenticated agent vault and inventory.

    Args:
        item_type: Optional item type filter such as skill, nft, or entitlement.

    Returns:
        dict with owned items and lightweight metadata.
    """
    api_key = _require_key(_api_key)
    try:
        params = {}
        if item_type:
            params["type"] = item_type
        response = requests.get(
            _build_url("/api/inventory"),
            params=params,
            headers=_headers(api_key),
            timeout=DEFAULT_TIMEOUT,
        )
        data = _safe_json(response)
        if response.status_code == 200:
            vault = data.get("vault", {})
            items = vault.get("items", [])
            return {
                "agent_id": vault.get("agent_id"),
                "total_items": vault.get("total_items"),
                "items": [
                    {
                        "id": item.get("id"),
                        "name": item.get("item_name"),
                        "item_type": item.get("item_type"),
                        "deployment_hint": item.get("deployment_hint"),
                        "status": item.get("status"),
                    }
                    for item in items
                ],
            }
        return _error_payload(response, data)
    except Exception as exc:
        return {"error": str(exc)}


def agoragentic_secret_store(
    label: str,
    secret: str,
    hint: str = "",
    *,
    _api_key: str = ""
) -> Dict[str, Any]:
    """Store an AES-256 encrypted secret in vault storage.

    Args:
        label: Secret label.
        secret: Secret value to encrypt.
        hint: Optional reminder text.

    Returns:
        dict with label and storage status.
    """
    api_key = _require_key(_api_key)
    try:
        payload = {"input": {"label": label, "secret": secret, "hint": hint}}
        response = requests.post(
            _build_url("/api/vault/secrets"),
            json=payload,
            headers=_headers(api_key),
            timeout=30,
        )
        data = _safe_json(response)
        if response.status_code == 200:
            output = data.get("output", {})
            return {
                "status": output.get("action"),
                "label": output.get("label"),
                "hint": output.get("hint"),
                "encrypted": output.get("encrypted"),
            }
        return _error_payload(response, data)
    except Exception as exc:
        return {"error": str(exc)}


def agoragentic_secret_retrieve(label: str = "", *, _api_key: str = "") -> Dict[str, Any]:
    """Retrieve one decrypted secret or list secret labels.

    Args:
        label: Optional label. Leave blank to list stored secret labels.

    Returns:
        dict with either the decrypted secret or the label inventory.
    """
    api_key = _require_key(_api_key)
    try:
        params = {}
        if label:
            params["label"] = label
        response = requests.get(
            _build_url("/api/vault/secrets"),
            params=params,
            headers=_headers(api_key),
            timeout=DEFAULT_TIMEOUT,
        )
        data = _safe_json(response)
        if response.status_code == 200:
            return data.get("output", data)
        return _error_payload(response, data)
    except Exception as exc:
        return {"error": str(exc)}


def agoragentic_passport(
    action: str = "check",
    wallet_address: str = "",
    agent_ref: str = "",
    *,
    _api_key: str = ""
) -> Dict[str, Any]:
    """Check, verify, or inspect Agoragentic Passport identity surfaces.

    Args:
        action: check, info, verify, or identity.
        wallet_address: Wallet address for verify.
        agent_ref: Agent ID or agent:// slug for identity lookup.

    Returns:
        dict with passport or identity information.
    """
    try:
        if action == "info":
            response = requests.get(_build_url("/api/passport/info"), timeout=DEFAULT_TIMEOUT)
        elif action == "verify":
            if not wallet_address:
                return {
                    "error": "missing_wallet_address",
                    "message": "wallet_address is required when action='verify'.",
                }
            response = requests.get(
                _build_url(f"/api/passport/verify/{wallet_address}"),
                timeout=DEFAULT_TIMEOUT,
            )
        elif action == "identity":
            if not agent_ref:
                return {
                    "error": "missing_agent_ref",
                    "message": "agent_ref is required when action='identity'.",
                }
            response = requests.get(
                _build_url(f"/api/passport/identity/{agent_ref}"),
                timeout=DEFAULT_TIMEOUT,
            )
        elif action == "check":
            api_key = _require_key(_api_key)
            response = requests.get(
                _build_url("/api/passport/check"),
                headers=_headers(api_key),
                timeout=DEFAULT_TIMEOUT,
            )
        else:
            return {
                "error": "invalid_action",
                "message": "action must be one of: check, info, verify, identity.",
            }

        data = _safe_json(response)
        if response.status_code == 200:
            return data.get("output", data)
        return _error_payload(response, data)
    except Exception as exc:
        return {"error": str(exc)}


# ─── Syrin Toolset Class ──────────────────────────────────


class AgoragenticTools:
    """
    Agoragentic marketplace tools packaged for Syrin agents.

    Usage:
        from syrin import Agent, Budget, Model
        from agoragentic_syrin import AgoragenticTools

        class MyAgent(Agent):
            model = Model.OpenAI("gpt-4o-mini", api_key="...")
            budget = Budget(max_cost=5.00)
            tools = AgoragenticTools(api_key="amk_your_key")

    All 16 marketplace tools are automatically available to the agent.
    The API key can also be set via AGORAGENTIC_API_KEY.
    """

    def __init__(self, api_key: str = ""):
        self.api_key = api_key or os.environ.get("AGORAGENTIC_API_KEY", "")
        self._tools = self._build_tools()

    def _build_tools(self) -> List[Callable[..., Dict[str, Any]]]:
        """Build the tool list with API key pre-bound where required."""
        import functools

        key = self.api_key

        def bind(fn: Callable[..., Dict[str, Any]]) -> Callable[..., Dict[str, Any]]:
            @functools.wraps(fn)
            def wrapper(*args: Any, **kwargs: Any) -> Dict[str, Any]:
                kwargs.setdefault("_api_key", key)
                return fn(*args, **kwargs)

            return wrapper

        return [
            bind(agoragentic_execute),
            bind(agoragentic_match),
            bind(agoragentic_search),
            bind(agoragentic_invoke),
            agoragentic_register,
            agoragentic_x402_test,
            agoragentic_categories,
            bind(agoragentic_memory_write),
            bind(agoragentic_memory_read),
            bind(agoragentic_memory_search),
            bind(agoragentic_learning_queue),
            bind(agoragentic_save_learning_note),
            bind(agoragentic_vault),
            bind(agoragentic_secret_store),
            bind(agoragentic_secret_retrieve),
            bind(agoragentic_passport),
        ]

    def __iter__(self) -> Any:
        return iter(self._tools)

    def __len__(self) -> int:
        return len(self._tools)

    def __getitem__(self, idx: int) -> Callable[..., Dict[str, Any]]:
        return self._tools[idx]


def get_all_tools(api_key: str = "") -> List[Callable[..., Dict[str, Any]]]:
    """
    Get all Agoragentic tools as a flat list for Syrin agents.

    Args:
        api_key: Optional Agoragentic API key. Falls back to AGORAGENTIC_API_KEY.

    Returns:
        List of callable tool functions.
    """
    return list(AgoragenticTools(api_key=api_key))
