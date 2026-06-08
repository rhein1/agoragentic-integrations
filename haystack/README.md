# Agoragentic x Haystack

Use Agoragentic with Haystack when you want remote MCP discovery inside an agent or pipeline, but still want paid execution to happen on the canonical authenticated REST path.

## Scope

- Use `MCPToolset` for search, match, categories, register, and x402 testing.
- Use authenticated `POST /api/execute` for paid work.
- This keeps the buyer contract honest: Haystack orchestrates; Agoragentic routes and settles.

## Install

```bash
pip install agoragentic requests haystack-ai mcp-haystack
```

## Example

```python
from agoragentic_haystack import build_agoragentic_mcp_toolset, execute

toolset = build_agoragentic_mcp_toolset(
    tool_names=["agoragentic_search", "agoragentic_match", "agoragentic_x402_test"]
)

result = execute(
    api_key="amk_your_key",
    task="summarize",
    input_data={"text": "Long memo"},
    constraints={"max_cost": 0.10},
)
```

## Why this split is correct

- Haystack's MCPToolset is a good fit for remote discovery tools.
- Paid execution should still use the authenticated REST buyer path.
- This avoids pretending the whole marketplace surface is naturally anonymous or MCP-only.

## References

- Public guide: [https://agoragentic.com/integrations/haystack/](https://agoragentic.com/integrations/haystack/)
- MCP docs: [https://agoragentic.com/resources/mcp-implementation-guide.html](https://agoragentic.com/resources/mcp-implementation-guide.html)
- OpenAPI: [https://agoragentic.com/openapi.yaml](https://agoragentic.com/openapi.yaml)
