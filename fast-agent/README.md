# Agoragentic + fast-agent

Use Agoragentic as a capability router inside [fast-agent](https://github.com/evalstate/fast-agent),
the MCP-native agent framework.

fast-agent agents can discover, invoke, and pay AI capabilities through Agoragentic's
marketplace via native MCP server integration.

## Quick Start

### Option A: MCP Server (recommended)

fast-agent has first-class MCP support. Add Agoragentic to your `fastagent.config.yaml`:

```yaml
mcp:
  servers:
    agoragentic:
      command: npx
      args:
        - agoragentic-mcp
      env:
        AGORAGENTIC_API_KEY: amk_your_key_here
```

Then use it in your agent:

```python
import fast_agent as fa

fast = fa.FastAgent("marketplace-agent")

@fast.agent(
    name="buyer",
    instruction="You are a research agent with access to the Agoragentic marketplace. Use agoragentic_search to find capabilities and agoragentic_invoke to execute them.",
    servers=["agoragentic"]
)

async def main():
    async with fast.run() as agent:
        result = await agent.buyer.send("Find and invoke a text summarizer for this article: [content]")
        print(result)

if __name__ == "__main__":
    import asyncio
    asyncio.run(main())
```

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

### Option C: Multi-Agent Workflow

```python
import fast_agent as fa

fast = fa.FastAgent("multi-agent-marketplace")

@fast.agent(
    name="researcher",
    instruction="Search the Agoragentic marketplace for relevant capabilities",
    servers=["agoragentic"]
)

@fast.agent(
    name="executor",
    instruction="Invoke the best marketplace capability and return results",
    servers=["agoragentic"]
)

@fast.chain(
    name="research_pipeline",
    sequence=["researcher", "executor"]
)

async def main():
    async with fast.run() as agent:
        result = await agent.research_pipeline.send(
            "Find a market analysis capability and analyze ETH price trends"
        )
        print(result)

if __name__ == "__main__":
    import asyncio
    asyncio.run(main())
```

## How It Works

```
fast-agent
    │
    ├── Agent (with MCP servers)
    │     └── agoragentic MCP server
    │           ├── agoragentic_search()     → GET /api/capabilities
    │           ├── agoragentic_invoke()     → POST /api/invoke/{id}
    │           ├── agoragentic_browse_services() → x402 edge catalog
    │           ├── agoragentic_call_service() → x402 paid execution
    │           ├── agoragentic_memory_*()   → Persistent vault storage
    │           └── agoragentic_secret_*()   → Encrypted credentials
    │
    ├── Chain (sequential multi-agent)
    ├── Parallel (concurrent execution)
    └── Router (dynamic agent selection)
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
