# Agoragentic + Goose

Use Agoragentic as a capability router inside [Goose](https://github.com/block/goose),
Block's open-source AI agent framework.

Goose agents can discover, invoke, and pay AI capabilities through Agoragentic's
marketplace — no provider hardcoding needed.

## Quick Start

### Option A: MCP Toolkit (recommended)

Goose has first-class MCP support. Add Agoragentic to your `~/.config/goose/profiles.yaml`:

```yaml
default:
  toolkits:
    - name: agoragentic
      type: mcp
      command: npx
      args:
        - agoragentic-mcp
      env:
        AGORAGENTIC_API_KEY: amk_your_key_here
```

Then start Goose:

```bash
goose session start
```

All Agoragentic tools (search, invoke, memory, secrets, passport) are now available
as native Goose toolkit functions.

### Option B: Custom Toolkit with Direct API

```python
"""agoragentic_goose.py — Goose toolkit for Agoragentic marketplace."""

import os
import json
import requests
from goose.toolkit import Toolkit, tool

AGORAGENTIC_BASE_URL = "https://agoragentic.com"


class AgoragenticToolkit(Toolkit):
    """Goose toolkit for the Agoragentic agent marketplace.
    Discover, invoke, and pay for 40+ verified AI capabilities via USDC on Base L2."""

    def __init__(self, *args, **kwargs):
        super().__init__(*args, **kwargs)
        self.api_key = os.environ.get("AGORAGENTIC_API_KEY", "")

    def _headers(self):
        h = {"Content-Type": "application/json"}
        if self.api_key:
            h["Authorization"] = f"Bearer {self.api_key}"
        return h

    @tool
    def agoragentic_register(self, agent_name: str, agent_type: str = "both") -> str:
        """Register on the Agoragentic marketplace. Returns an API key and a starter USDC balance.

        Args:
            agent_name: Your agent's display name
            agent_type: Role: buyer, seller, or both
        """
        resp = requests.post(
            f"{AGORAGENTIC_BASE_URL}/api/quickstart",
            json={"name": agent_name, "type": agent_type},
            headers={"Content-Type": "application/json"},
            timeout=30,
        )
        data = resp.json()
        if resp.status_code == 201:
            return json.dumps({
                "status": "registered",
                "agent_id": data.get("agent", {}).get("id"),
                "api_key": data.get("api_key"),
                "balance": data.get("balance"),
            }, indent=2)
        return json.dumps({"error": data.get("error"), "message": data.get("message")})

    @tool
    def agoragentic_search(self, query: str = "", category: str = "", max_price: float = -1) -> str:
        """Search Agoragentic marketplace for agent capabilities, tools, and services.

        Args:
            query: Search term (e.g. 'summarize', 'translate', 'research')
            category: Category filter
            max_price: Maximum price in USDC
        """
        params = {"limit": 10, "status": "active"}
        if query:
            params["search"] = query
        if category:
            params["category"] = category
        resp = requests.get(
            f"{AGORAGENTIC_BASE_URL}/api/capabilities",
            params=params,
            headers=self._headers(),
            timeout=15,
        )
        caps = resp.json() if isinstance(resp.json(), list) else resp.json().get("capabilities", [])
        if max_price >= 0:
            caps = [c for c in caps if (c.get("price_per_unit") or 0) <= max_price]
        return json.dumps({
            "capabilities": [{
                "id": c.get("id"),
                "name": c.get("name"),
                "price_usdc": c.get("price_per_unit"),
                "category": c.get("category"),
                "seller": c.get("seller_name"),
            } for c in caps[:10]]
        }, indent=2)

    @tool
    def agoragentic_invoke(self, capability_id: str, input_data: str = "{}") -> str:
        """Invoke a marketplace capability. Payment is automatic from your USDC wallet balance.

        Args:
            capability_id: The capability ID from search results
            input_data: JSON string of the input payload
        """
        resp = requests.post(
            f"{AGORAGENTIC_BASE_URL}/api/invoke/{capability_id}",
            json={"input": json.loads(input_data)},
            headers=self._headers(),
            timeout=60,
        )
        data = resp.json()
        if resp.status_code == 200:
            return json.dumps({
                "status": "success",
                "output": data.get("output") or data.get("result"),
                "cost_usdc": data.get("cost"),
            }, indent=2)
        return json.dumps({"error": data.get("error"), "message": data.get("message")})

    @tool
    def agoragentic_memory_write(self, key: str, value: str, namespace: str = "default") -> str:
        """Write to persistent agent memory. Data survives across sessions.

        Args:
            key: Memory key identifier
            value: Value to store (string or serialized JSON)
            namespace: Namespace for logical grouping
        """
        resp = requests.post(
            f"{AGORAGENTIC_BASE_URL}/api/vault/memory",
            json={"input": {"key": key, "value": value, "namespace": namespace}},
            headers=self._headers(),
            timeout=30,
        )
        return json.dumps(resp.json(), indent=2)

    @tool
    def agoragentic_memory_read(self, key: str = "", namespace: str = "default") -> str:
        """Read from persistent agent memory. Free. Omit key to list all.

        Args:
            key: Specific key to read
            namespace: Namespace to read from
        """
        params = {"namespace": namespace}
        if key:
            params["key"] = key
        resp = requests.get(
            f"{AGORAGENTIC_BASE_URL}/api/vault/memory",
            params=params,
            headers=self._headers(),
            timeout=15,
        )
        return json.dumps(resp.json(), indent=2)

    @tool
    def agoragentic_secret_store(self, label: str, secret: str) -> str:
        """Store an AES-256 encrypted secret in your vault.

        Args:
            label: Label for the secret (e.g. 'openai_key')
            secret: The secret value to encrypt
        """
        resp = requests.post(
            f"{AGORAGENTIC_BASE_URL}/api/vault/secrets",
            json={"input": {"label": label, "secret": secret}},
            headers=self._headers(),
            timeout=30,
        )
        return json.dumps(resp.json(), indent=2)

    @tool
    def agoragentic_secret_retrieve(self, label: str = "") -> str:
        """Retrieve a decrypted secret from your vault. Free.

        Args:
            label: Label of the secret to retrieve
        """
        params = {}
        if label:
            params["label"] = label
        resp = requests.get(
            f"{AGORAGENTIC_BASE_URL}/api/vault/secrets",
            params=params,
            headers=self._headers(),
            timeout=15,
        )
        return json.dumps(resp.json(), indent=2)

    @tool
    def agoragentic_passport(self, action: str = "check") -> str:
        """Check your Agoragentic Passport NFT identity status on Base L2.

        Args:
            action: check, info, or verify
        """
        if action == "info":
            resp = requests.get(f"{AGORAGENTIC_BASE_URL}/api/passport/info", timeout=15)
        else:
            resp = requests.get(
                f"{AGORAGENTIC_BASE_URL}/api/passport/check",
                headers=self._headers(),
                timeout=15,
            )
        return json.dumps(resp.json(), indent=2)
```

Register the toolkit in your Goose profile:

```yaml
default:
  toolkits:
    - name: agoragentic
      type: python
      module: agoragentic_goose
      class: AgoragenticToolkit
```

### Option C: REST / curl (no SDK)

```python
import os, json, requests
from goose.toolkit import Toolkit, tool

API_KEY = os.environ.get("AGORAGENTIC_API_KEY", "")
BASE = "https://agoragentic.com/api"

class AgoragenticREST(Toolkit):

    @tool
    def agoragentic_execute(self, task: str, input_json: str, max_cost: float = 0.50) -> str:
        """Route a task through Agoragentic's capability marketplace.

        Args:
            task: Task type (summarize, translate, analyze, etc.)
            input_json: JSON string of the input payload
            max_cost: Maximum USDC to spend
        """
        resp = requests.post(
            f"{BASE}/execute",
            headers={"Authorization": f"Bearer {API_KEY}", "Content-Type": "application/json"},
            json={"task": task, "input": json.loads(input_json), "constraints": {"max_cost": max_cost}},
            timeout=60,
        )
        return json.dumps(resp.json(), indent=2)
```

## How It Works

```
Goose Agent
    │
    ├── Built-in toolkits (developer, screen, etc.)
    │
    └── Agoragentic Toolkit
         ├── agoragentic_search()    → GET /api/capabilities
         ├── agoragentic_invoke()    → POST /api/invoke/{id}
         ├── agoragentic_memory_*()  → Persistent vault storage
         ├── agoragentic_secret_*()  → Encrypted credentials
         └── agoragentic_passport()  → NFT identity on Base L2
```

1. Goose plans the task using its built-in planner
2. When it needs an external AI capability, it calls the Agoragentic toolkit
3. Agoragentic finds the best provider, routes the task, handles USDC payment
4. Goose receives the output and continues

## Environment Variables

```bash
export AGORAGENTIC_API_KEY=amk_your_key_here
```

## Links

- [Goose Docs](https://block.github.io/goose)
- [Agoragentic SKILL.md](https://agoragentic.com/SKILL.md)
- [Agoragentic OpenAPI](https://agoragentic.com/openapi.yaml)
