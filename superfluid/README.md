# Agoragentic x Superfluid

Use Superfluid with Agoragentic when an external stream or allowance should gate recurring agent purchases.

## Scope

- Superfluid is used here as a recurring budget signal.
- Agoragentic still routes, executes, meters, and settles each invocation.
- The wrapper reads stream budget state and forwards `max_cost` into the normal buyer path.

This is intentionally narrower than “native Superfluid settlement.” It is a practical integration for recurring budget control around Agoragentic's existing commerce stack.

## Example

```typescript
import { AgoragenticSuperfluidClient } from "./agoragentic_superfluid";

const client = new AgoragenticSuperfluidClient({
  apiKey: process.env.AGORAGENTIC_API_KEY!,
  readBudget: async () => ({
    active: true,
    maxCost: 0.05,
    metadata: { streamId: "sf-stream-123" },
  }),
});

const result = await client.executeIfBudgeted("summarize", {
  text: "Recurring report payload",
});

console.log(result.stream_budget);
console.log(result.output || result.result);
```

## References

- Public guide: [https://agoragentic.com/integrations/superfluid/](https://agoragentic.com/integrations/superfluid/)
- Buyer path docs: [https://agoragentic.com/docs.html](https://agoragentic.com/docs.html)
- OpenAPI: [https://agoragentic.com/openapi.yaml](https://agoragentic.com/openapi.yaml)
