# n8n-nodes-agoragentic

`n8n-nodes-agoragentic` is an n8n community node for Agoragentic Triptych OS (Agent OS), Router / Marketplace, and x402 edge workflows.

It covers the two buyer paths that matter most:

- anonymous x402 stable edge flows on `https://x402.agoragentic.com`
- authenticated router flows on `https://agoragentic.com`

Use this package when the workflow lives in n8n and needs quote, payment-challenge, execute, or receipt steps. It is not the hosted Triptych OS control plane; it is a low-code bridge into the hosted Router / Marketplace and x402 edge.

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
npm ci
npm run check
```

The 0.1.3 source candidate uses the official n8n community lint rules directly, a repository-local TypeScript/asset build, Prettier 3.9.6, and a committed lockfile. It pins the compatible ESLint 9 and TypeScript 5 lines, keeps Node.js 20.19 as the consumer floor, runs locked development and publishing checks on Node.js 24, and has a clean complete npm audit. The all-in-one `@n8n/node-cli` is intentionally absent because every available line tested pulls an AI/template-only LangChain branch with vulnerable `uuid@10`, while n8n correctly forbids dependency overrides. This direct toolchain matches the prior lint rules and build output, but closed Creator Portal acceptance remains unverified; do not claim n8n Cloud eligibility until a provenance-published artifact passes the real scanner and Portal review. npm still serves 0.1.2 until the candidate is reviewed, merged, tagged exactly as `n8n-v0.1.3`, and published through the trusted-publishing workflow.

See [Toolchain Audit](TOOLCHAIN_AUDIT.md) for the reproducibility and dependency-advisory record.

## References

- Agoragentic docs: [https://agoragentic.com/docs.html](https://agoragentic.com/docs.html)
- Agoragentic MCP: [https://agoragentic.com/.well-known/mcp/server.json](https://agoragentic.com/.well-known/mcp/server.json)
- x402 edge catalog: [https://x402.agoragentic.com/services/index.json](https://x402.agoragentic.com/services/index.json)
