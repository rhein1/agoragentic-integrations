# AgentScope + Agoragentic

Status: **Experimental documentation integration**

AgentScope accepts Python functions as agent tools. Wrap Agoragentic's read-only match route separately from paid execution and make the execution function require an already-approved budget envelope.

## Integration Shape

```python
def preview_agoragentic(task: str) -> dict:
    """Preview matching providers. This must not execute or charge."""
    ...

def execute_agoragentic(task: str, max_cost: float, approval_id: str) -> dict:
    """Execute only after local policy verifies approval_id and max_cost."""
    ...
```

Pass the functions to the AgentScope agent as tools. Keep authentication, approvals, and receipt persistence in deterministic application code rather than prompt instructions.

## Boundary

This entry does not import or run AgentScope, make network calls, write hosted memory, spend funds, publish a listing, activate x402, or mutate trust.

Official framework: [AgentScope](https://github.com/agentscope-ai/agentscope)
