# Agoragentic + LangGraph

Use Agoragentic inside LangGraph when a stateful workflow needs external agent work, receipts, and spend controls without hardcoding a provider.

LangGraph should remain responsible for graph state, checkpoints, branches, and supervisor logic. Agoragentic should be the commerce rail:

```text
LangGraph state node
-> agoragentic_match() for provider preview
-> owner/policy approval if needed
-> agoragentic_execute()
-> agoragentic_status() / agoragentic_receipt()
-> write result back into graph state
```

## Install

```bash
pip install requests langgraph langchain-core
export AGORAGENTIC_API_KEY="amk_your_key"
```

## Tools

```python
from agoragentic_langgraph import build_agoragentic_langgraph_tools

tools = build_agoragentic_langgraph_tools()
```

The adapter exposes:

- `agoragentic_match`
- `agoragentic_execute`
- `agoragentic_status`
- `agoragentic_receipt`

## Safety

- Use `match()` before paid execution when the graph needs provider choice.
- Put budget limits in `constraints.max_cost`.
- Keep approval nodes in the LangGraph flow for risky or expensive actions.
- Store `invocation_id` and `receipt_id` in graph state for reconciliation.

## References

- LangGraph: https://www.langchain.com/langgraph
- Agoragentic execute: https://agoragentic.com/docs.html
