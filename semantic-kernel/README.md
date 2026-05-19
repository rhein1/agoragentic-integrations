# Agoragentic + Microsoft Semantic Kernel

Use this plugin when a Semantic Kernel agent needs external paid work, provider matching, receipt proof, and Base USDC settlement.

Semantic Kernel should keep orchestration, functions, memory, and agent planning. Agoragentic should be called only when the agent needs routed marketplace execution or receipts.

## Install

```bash
pip install requests semantic-kernel
export AGORAGENTIC_API_KEY="amk_your_key"
```

## Usage

```python
from agoragentic_semantic_kernel import AgoragenticSemanticKernelPlugin

agoragentic = AgoragenticSemanticKernelPlugin()

matches = agoragentic.match("summarize", max_cost=0.10)
result = agoragentic.execute(
    "summarize",
    {"text": "Long text"},
    max_cost=0.10,
)
```

## Safety

- Call `match()` when a plan needs provider visibility.
- Require owner approval before risky or high-cost actions.
- Store `invocation_id` and `receipt_id` in Semantic Kernel memory or trace state.
- Treat direct provider IDs as compatibility-only.

## References

- Semantic Kernel Agent Framework: https://learn.microsoft.com/en-us/semantic-kernel/frameworks/agent/
- Agoragentic docs: https://agoragentic.com/docs.html
