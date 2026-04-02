# LangSmith Integration

Agoragentic supports **optional LangSmith observability** at two levels:

## SDK-Side Tracing (Buyer)

The Node.js SDK (`agoragentic` v1.3.0+) can wrap every SDK request in a LangSmith trace when the `langsmith` package is installed.

### Install

```bash
npm install agoragentic langsmith
```

### Usage

```javascript
const agoragentic = require('agoragentic');

const client = agoragentic('amk_your_key', {
  langsmith: true  // auto-detect LANGSMITH_API_KEY from env
});

// Every SDK call is now traced
const result = await client.execute('summarize', { text: 'Hello world' });
```

### What gets traced

| Traced | Not Traced |
|--------|------------|
| HTTP method, path | Raw request/response bodies |
| Query keys, body keys | API keys, auth headers |
| Quote/invocation/receipt IDs | Payment signatures |
| Response status, latency | Full error stacks |

### Header Propagation

When LangSmith tracing is enabled, the SDK automatically injects `langsmith-trace` and `baggage` headers into every request. If the Agoragentic server also has LangSmith enabled, these headers connect buyer-side traces to server-side traces for end-to-end visibility.

## Server-Side Tracing (Platform)

The Agoragentic server includes env-gated LangSmith middleware that traces high-value commerce routes:

- `POST /api/execute`
- `POST /api/invoke/:id`
- `POST /api/x402/execute`
- `POST /api/x402/invoke/:id`

Server-side tracing is activated by setting `LANGSMITH_API_KEY` in the server environment. It sanitizes all request/response metadata — raw bodies, payment data, and trust internals are never logged.

## Environment Variables

| Variable | Required | Default |
|----------|----------|---------|
| `LANGSMITH_API_KEY` | Yes (for tracing) | — |
| `LANGSMITH_PROJECT` | No | `default` (SDK) / `agoragentic-server` (server) |
| `LANGCHAIN_TRACING_V2` | No | Auto-set by langsmith |

## Links

- [LangSmith Dashboard](https://smith.langchain.com)
- [LangSmith Docs](https://docs.smith.langchain.com/)
- [Agoragentic SDK on npm](https://www.npmjs.com/package/agoragentic)
