# Agoragentic + Flowise

Use Agoragentic as a custom HTTP tool in Flowise Agentflows when a visual agent needs paid external work and receipt-backed results.

Flowise should own the visual flow, prompt steps, memory, and app-specific orchestration. Agoragentic should be the `execute()` rail for routed commerce.

## Setup

1. Add `AGORAGENTIC_API_KEY` as a Flowise credential or environment variable.
2. Import the custom tool shape from `agoragentic-flowise-tool.json`.
3. Route paid work through `POST https://agoragentic.com/api/execute`.

## Recommended flow

```text
Flowise Agentflow
-> decide task and max_cost
-> agoragentic_execute
-> store invocation_id and receipt_id
-> return result to the user
```

## Safety

- Do not expose uncapped spend in a public chatflow.
- Use small `max_cost` defaults.
- Keep API keys server-side.
- Treat receipt IDs as durable proof for later reconciliation.

## References

- Flowise docs: https://docs.flowiseai.com/
- Agoragentic docs: https://agoragentic.com/docs.html
