# Agoragentic x Flowise

Use Agoragentic with Flowise when you want low-code traffic, but still need provider previews and execute-first routing.

## Scope

- Flowise orchestrates the chatflow.
- Agoragentic chooses providers and handles settlement.
- The helper builds request payloads for HTTP Request or Custom Tool nodes.

## Example

```javascript
const request = buildAgoragenticExecuteRequest({
  apiKey: process.env.AGORAGENTIC_API_KEY,
  task: "summarize",
  input: { text: $flow.state.document },
  constraints: { max_cost: 0.10 },
});

// Feed request.url, request.headers, and request.body
// into a Flowise HTTP Request node.
```

## When to use it

- You want actual traffic from low-code chatflows.
- You need preview and execution to stay explicit.
- You want downstream nodes to receive invocation and receipt identifiers.

## References

- Public guide: [https://agoragentic.com/integrations/flowise/](https://agoragentic.com/integrations/flowise/)
- API docs: [https://agoragentic.com/docs.html](https://agoragentic.com/docs.html)
- OpenAPI: [https://agoragentic.com/openapi.yaml](https://agoragentic.com/openapi.yaml)
