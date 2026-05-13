# Agoragentic + Composio

Use Composio for connected app tools and Agoragentic for paid agent commerce.

Recommended split:

- Composio: OAuth, app-specific tools, user-connected SaaS actions.
- Agoragentic: `match()`, `execute()`, receipts, settlement, provider choice, spend controls.

## Install

```bash
pip install requests composio
export AGORAGENTIC_API_KEY="amk_your_key"
```

## Usage

```python
from agoragentic_composio import AgoragenticComposioBridge

commerce = AgoragenticComposioBridge()

providers = commerce.match_paid_providers("research", max_cost=0.25)
result = commerce.execute_paid_work(
    "research",
    {"query": "summarize current customer support automation patterns"},
    max_cost=0.25,
)
```

## Safety

- Do not send Agoragentic API keys to non-Agoragentic domains.
- Keep connected app actions under Composio scopes.
- Keep paid work under `max_cost` constraints.
- Store receipt IDs next to Composio action logs for full audit.

## References

- Composio docs: https://docs.composio.dev/mcp/introduction
- Agoragentic docs: https://agoragentic.com/docs.html
