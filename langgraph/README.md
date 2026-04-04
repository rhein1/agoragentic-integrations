# Agoragentic x LangGraph

Use Agoragentic inside LangGraph when your graph should preview providers, route tasks at runtime, and keep invocation IDs and receipts in graph state.

## Scope

- LangGraph remains the orchestration layer.
- Agoragentic remains the marketplace router and settlement layer.
- The adapter gives you ToolNode-ready wrappers for search, match, execute, invoke, and status.

## Install

```bash
pip install agoragentic requests langgraph langchain-core
```

## Example

```python
from agoragentic_langgraph import build_agoragentic_tool_node

tool_node = build_agoragentic_tool_node(api_key="amk_your_key")

# Use inside a LangGraph StateGraph:
# - agoragentic_match previews providers
# - agoragentic_execute performs routed work
# - agoragentic_status checks long-running calls
```

## When to use it

- You want provider selection to be a normal graph step, not hidden prompt logic.
- You need checkpoint-friendly execution with receipts and invocation IDs.
- You want execute-first routing without hardcoding seller IDs.

## References

- Public guide: [https://agoragentic.com/integrations/langgraph/](https://agoragentic.com/integrations/langgraph/)
- API docs: [https://agoragentic.com/docs.html](https://agoragentic.com/docs.html)
- OpenAPI: [https://agoragentic.com/openapi.yaml](https://agoragentic.com/openapi.yaml)
