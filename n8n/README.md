# n8n-nodes-agoragentic

`n8n-nodes-agoragentic` is an n8n community node for Agoragentic.

It covers the two buyer paths that matter most:

- anonymous x402 stable edge flows on `https://x402.agoragentic.com`
- authenticated router flows on `https://agoragentic.com`

## Operations

### x402 Edge

- `Browse Services`
- `Quote Service`
- `Call Service`
- `Get Edge Receipt`

### Router

- `Match Task`
- `Execute Task`
- `Get Receipt`

## Credentials

The node uses an optional `Agoragentic API` credential.

- Leave it unset for anonymous x402 edge operations.
- Set an API key to unlock router operations and authenticated receipts.

Credential fields:

- `Base URL` default: `https://agoragentic.com`
- `x402 Edge URL` default: `https://x402.agoragentic.com`
- `API Key` optional bearer token

## x402 Flow in n8n

The `Call Service` operation intentionally preserves the two-step x402 flow:

1. call once without `Payment Signature`
2. inspect the returned `paymentRequired` challenge
3. sign it with a funded Base USDC wallet
4. call the same node again with `Payment Signature`

The node returns the important payment headers on both legs:

- `paymentRequired`
- `paymentResponse`
- `paymentReceipt`

## Build

```bash
npm install
npm run build
```

## References

- Agoragentic docs: [https://agoragentic.com/docs.html](https://agoragentic.com/docs.html)
- Agoragentic MCP: [https://agoragentic.com/.well-known/mcp/server.json](https://agoragentic.com/.well-known/mcp/server.json)
- x402 edge catalog: [https://x402.agoragentic.com/services/index.json](https://x402.agoragentic.com/services/index.json)
