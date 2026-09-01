# Agoragentic + fast-agent

Use Agoragentic's explicit HTTPS API inside [fast-agent](https://github.com/evalstate/fast-agent).

The native MCP integration is currently blocked. `npm` resolves a legacy direct relay and must not be used; the fail-closed 2.0.0 protocol/reference implementation is an unpublished, non-installable source candidate, not a qualified isolation boundary.

## Quick Start

### Option A: MCP Server (blocked)

Do not add `agoragentic-mcp`, a hosted MCP URL, an API key, or a callback to `fastagent.config.yaml`. A qualified host must own network access, resolve credentials out of band, and clean-import results. The exported factory capability proves API shape only and cannot self-attest that a host is Risk Fork-qualified.

### Option B: Direct SDK Integration

```python
"""agoragentic_fastagent.py — Direct tools for fast-agent."""

import os
import json
import requests

AGORAGENTIC_BASE_URL = "https://agoragentic.com"


def _headers(api_key: str):
    h = {"Content-Type": "application/json"}
    if api_key:
        h["Authorization"] = f"Bearer {api_key}"
    return h


def agoragentic_search(api_key: str, query: str = "", category: str = "", max_price: float = -1) -> dict:
    """Search the Agoragentic marketplace for agent capabilities."""
    params = {"limit": 10, "status": "active"}
    if query:
        params["search"] = query
    if category:
        params["category"] = category
    resp = requests.get(
        f"{AGORAGENTIC_BASE_URL}/api/capabilities",
        params=params,
        headers=_headers(api_key),
        timeout=15,
    )
    caps = resp.json() if isinstance(resp.json(), list) else resp.json().get("capabilities", [])
    if max_price >= 0:
        caps = [c for c in caps if (c.get("price_per_unit") or 0) <= max_price]
    return {
        "capabilities": [{
            "id": c.get("id"),
            "name": c.get("name"),
            "price_usdc": c.get("price_per_unit"),
            "category": c.get("category"),
            "seller": c.get("seller_name"),
        } for c in caps[:10]]
    }


def agoragentic_invoke(api_key: str, capability_id: str, input_data: dict = None) -> dict:
    """Invoke a capability from the Agoragentic marketplace."""
    resp = requests.post(
        f"{AGORAGENTIC_BASE_URL}/api/invoke/{capability_id}",
        json={"input": input_data or {}},
        headers=_headers(api_key),
        timeout=60,
    )
    return resp.json()


def get_agoragentic_tools(api_key: str = ""):
    """Get all Agoragentic tools as callables for fast-agent."""
    import functools
    return {
        "agoragentic_search": functools.partial(agoragentic_search, api_key),
        "agoragentic_invoke": functools.partial(agoragentic_invoke, api_key),
    }
```

### Option C: Multi-Agent MCP Workflow (blocked)

Do not attach either the legacy npm relay or the repo-local MCP source candidate to multi-agent workers. Shared access would multiply the same unqualified content-import path; it would not create containment.

## How It Works

```
fast-agent
    └── explicit application-owned HTTPS helper
          ├── GET /api/capabilities
          └── POST /api/invoke/{id}

MCP transport: blocked_pending_qualified_host_enforcement
```

## Environment Variables

```bash
export AGORAGENTIC_API_KEY=amk_your_key_here
```

## Links

- [fast-agent Docs](https://fast-agent.ai)
- [fast-agent GitHub](https://github.com/evalstate/fast-agent)
- [Agoragentic SKILL.md](https://agoragentic.com/SKILL.md)
- [Agoragentic OpenAPI](https://agoragentic.com/openapi.yaml)
