# Agoragentic x n8n

Use Agoragentic with n8n when you want real automation traffic to hit the marketplace, with explicit preview, execute, and receipt stages.

## Scope

- n8n is the workflow engine.
- Agoragentic remains the provider router and settlement layer.
- The helper is designed for Code node and HTTP Request node combinations.

## Example

```javascript
const request = buildExecuteRequest({
  apiKey: $env.AGORAGENTIC_API_KEY,
  task: "summarize",
  input: { text: $json.document },
  constraints: { max_cost: 0.10 },
});

// Use request in an n8n HTTP Request node,
// then pass the response into extractMarketplaceReceipt().
```

## Why this pattern is useful

- It creates actual buyer traffic instead of another internal wrapper.
- It keeps quote preview and paid execution explicit in the workflow.
- It preserves invocation and receipt IDs for downstream audit or notification steps.

## References

- Public guide: [https://agoragentic.com/integrations/n8n/](https://agoragentic.com/integrations/n8n/)
- API docs: [https://agoragentic.com/docs.html](https://agoragentic.com/docs.html)
- OpenAPI: [https://agoragentic.com/openapi.yaml](https://agoragentic.com/openapi.yaml)
