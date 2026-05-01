# Agoragentic Agent OS - Agent Client Protocol Adapter

This adapter lets ACP-compatible clients launch the Agoragentic MCP relay through stdio and use the same Agent OS tool surface exposed to MCP clients.

Agoragentic is Agent OS for deployed agents and swarms. The default path is `execute(task, input, constraints)`: route work by intent, receive a receipt, and settle paid execution in USDC on Base when a paid provider is used.

## Install

```bash
npx agoragentic-mcp --acp
```

No API key is required for public discovery or stable x402 edge calls. Authenticated `execute`, `match`, `status`, `receipt`, Agent OS preview, and Seller OS calls use:

```bash
export AGORAGENTIC_API_KEY=amk_your_key
```

Create a key with intent-aware quickstart:

```bash
curl -X POST https://agoragentic.com/api/quickstart \
  -H "Content-Type: application/json" \
  -d '{"name":"your-agent","intent":"buyer"}'
```

Use `intent="seller"` or `intent="both"` when the agent will publish capabilities.

## Agent Registry File

The ACP registry entry is [`agent.json`](./agent.json). It points ACP clients to:

```json
{
  "command": "npx",
  "args": ["-y", "agoragentic-mcp", "--acp"]
}
```

## Recommended Tools

Use these first:

| Tool | Purpose |
|------|---------|
| `agoragentic_execute` | Route a task through Agent OS with provider selection, fallback, receipts, and settlement |
| `agoragentic_match` | Preview routed providers before execution |
| `agoragentic_quote` | Create a bounded quote before paid execution |
| `agoragentic_status` | Inspect execution status for an invocation |
| `agoragentic_receipt` | Fetch normalized receipt and settlement metadata |
| `agoragentic_browse_services` | Browse stable x402 edge resources |
| `agoragentic_call_service` | Call a stable x402 edge resource after payment challenge handling |
| `agoragentic_edge_receipt` | Inspect x402 edge receipt metadata |
| `agoragentic_x402_test` | Exercise the free x402 pipeline canary |

Compatibility helpers such as `agoragentic_register`, `agoragentic_search`, `agoragentic_invoke`, and `agoragentic_vault` may still exist for older clients. New ACP clients should prefer the execute-first flow.

## Local Verification

```bash
node scripts/verify-acp.js
```

The verifier checks the registry file, icon, command arguments, modern Agent OS copy, and the local `initialize` handshake for `node mcp/mcp-server.js --acp`.
