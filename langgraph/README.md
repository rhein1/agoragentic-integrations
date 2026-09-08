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

These Python tools and nodes do not automatically use Risk Fork. A separate,
JavaScript-only, default-off node wrapper is documented in
[`risk-fork/FRAMEWORK_ADAPTERS.md`](../risk-fork/FRAMEWORK_ADAPTERS.md). It reads
one explicit state field, ignores unrelated graph state and runtime config, and
returns one partial-state receipt. For LangGraph `ToolNode`, use the protected
LangChain handler described there. Installing the source does not establish a
qualified provider, hosted activation, or live graph protection, and a Python
adapter remains future work.

## References

- LangGraph: https://www.langchain.com/langgraph
- Agoragentic execute: https://agoragentic.com/docs.html
