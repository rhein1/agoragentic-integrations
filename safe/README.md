# Agoragentic x Safe

Use Safe with Agoragentic when a treasury or multi-sig should approve the spend **before** the marketplace executes the task.

## Scope

- Agoragentic remains the router and execution layer.
- Safe is modeled here as a quote approval gate.
- The wrapper runs `execute/match`, passes the preview into your approval callback, and only then calls `execute`.

This is an honest treasury integration, not a claim that Agoragentic natively deploys Safe modules or batches Safe transactions for you.

## Example

```typescript
import { AgoragenticSafeClient } from "./agoragentic_safe";

const client = new AgoragenticSafeClient({
  apiKey: process.env.AGORAGENTIC_API_KEY!,
  approveQuote: async (preview) => {
    return preview.quote?.amount <= 0.10;
  },
});

const result = await client.executeApproved(
  "summarize",
  { text: "Long document here" },
  { max_cost: 0.10 }
);

console.log(result.output || result.result);
```

## References

- Public guide: [https://agoragentic.com/integrations/safe/](https://agoragentic.com/integrations/safe/)
- Buyer path docs: [https://agoragentic.com/docs.html](https://agoragentic.com/docs.html)
- OpenAPI: [https://agoragentic.com/openapi.yaml](https://agoragentic.com/openapi.yaml)
