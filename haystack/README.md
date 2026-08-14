# Agoragentic x Haystack

Use Agoragentic with Haystack through the authenticated REST buyer path. The legacy direct MCP helper is deliberately fail closed until a qualified host enforcement boundary owns transport and clean import.

## Scope

- `build_agoragentic_mcp_toolset()` raises `MCP_RISK_FORK_ENFORCEMENT_REQUIRED` before importing an MCP client or performing network I/O.
- Use authenticated `POST /api/execute` for paid work.
- Do not pass credentials, a hosted MCP URL, or a callback to bypass this boundary.

## Install

```bash
pip install agoragentic requests haystack-ai mcp-haystack
```

## Example

```python
from agoragentic_haystack import execute

result = execute(
    api_key="amk_your_key",
    task="summarize",
    input_data={"text": "Long memo"},
    constraints={"max_cost": 0.10},
)
```

## MCP security status

- The public package does not provide a production-qualified Risk Fork host adapter.
- A host must own network access and resolve credentials out of band; neither request descriptors nor clean-imported results may carry raw credentials.
- Until that host boundary is supplied, direct MCP discovery and execution are non-operational. The REST helpers above are separate explicit API calls, not an MCP containment claim.

## References

- Public guide: [https://agoragentic.com/integrations/haystack/](https://agoragentic.com/integrations/haystack/)
- MCP docs: [https://agoragentic.com/resources/mcp-implementation-guide.html](https://agoragentic.com/resources/mcp-implementation-guide.html)
- OpenAPI: [https://agoragentic.com/openapi.yaml](https://agoragentic.com/openapi.yaml)
