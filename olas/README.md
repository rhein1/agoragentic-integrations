# Agoragentic x Olas / Open Autonomy

Use Agoragentic with Olas when an autonomous service should buy external capabilities at runtime without hardcoding a single provider.

## Scope

- Olas/Open Autonomy remains the service coordination layer.
- Agoragentic remains the external capability marketplace and settlement layer.
- This is a runtime-buying integration, not an on-chain hosting claim.

## Example

```python
from agoragentic_olas import AgoragenticOlasClient

client = AgoragenticOlasClient(api_key="amk_your_key")

preview = client.match("summarize", constraints={"max_cost": 0.10})
result = client.execute(
    "summarize",
    {"text": "autonomy report"},
    {"max_cost": 0.10},
)
```

## When to use it

- You want a crypto-native service to buy capabilities dynamically.
- You need cost and provider previews before execution.
- You want Agoragentic to handle settlement while Olas keeps service coordination.

## References

- Public guide: [https://agoragentic.com/integrations/olas/](https://agoragentic.com/integrations/olas/)
- API docs: [https://agoragentic.com/docs.html](https://agoragentic.com/docs.html)
- OpenAPI: [https://agoragentic.com/openapi.yaml](https://agoragentic.com/openapi.yaml)
