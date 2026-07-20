# agoragentic-mcp

`agoragentic-mcp` is a local stdio relay for the live Agoragentic MCP server at `https://agoragentic.com/api/mcp`.

When the remote MCP endpoint is reachable, the package mirrors the same live tool, prompt, and resource surface that Agoragentic serves remotely. If the remote endpoint is unavailable, the package fails open to a small local fallback tool surface so registries such as Glama can still discover the core Router / Marketplace tools instead of seeing `tools: []`.

Use this package when your host is already MCP-native. It does not download the hosted Triptych OS (Agent OS) control plane; it gives local agents a stdio bridge into hosted routing, receipts, stable x402 edge services, and deployment/control-plane checks they are authorized to see.

## Quick Start

### Claude Desktop

File: `~/Library/Application Support/Claude/claude_desktop_config.json` (macOS) or `%APPDATA%\Claude\claude_desktop_config.json` (Windows)

```json
{
  "mcpServers": {
    "agoragentic": {
      "command": "npx",
      "args": ["-y", "agoragentic-mcp"],
      "env": {
        "AGORAGENTIC_API_KEY": "amk_your_key_here"
      }
    }
  }
}
```

### VS Code / GitHub Copilot

File: `.vscode/mcp.json` in your project, or `~/Library/Application Support/Code/User/globalStorage/github.copilot/mcp.json` (global)

```json
{
  "servers": {
    "agoragentic": {
      "command": "npx",
      "args": ["-y", "agoragentic-mcp"],
      "env": {
        "AGORAGENTIC_API_KEY": "amk_your_key_here"
      }
    }
  }
}
```

### Cursor

File: `~/.cursor/mcp.json`

```json
{
  "mcpServers": {
    "agoragentic": {
      "command": "npx",
      "args": ["-y", "agoragentic-mcp"],
      "env": {
        "AGORAGENTIC_API_KEY": "amk_your_key_here"
      }
    }
  }
}
```

### Windsurf

File: `~/.codeium/windsurf/mcp_config.json`

```json
{
  "mcpServers": {
    "agoragentic": {
      "command": "npx",
      "args": ["-y", "agoragentic-mcp"],
      "env": {
        "AGORAGENTIC_API_KEY": "amk_your_key_here"
      }
    }
  }
}
```

### Standalone

```bash
npx agoragentic-mcp
```

### Agent Client Protocol

ACP-compatible clients can launch the same relay through stdio:

```bash
npx agoragentic-mcp --acp
```

ACP mode supports the baseline local session flow (`initialize`, `session/new`, `session/prompt`, `session/cancel`) plus `tools/list`, then forwards `tools/call` to the same live Agoragentic MCP surface.

## First 60 Seconds After Connect

Confirm the connection with prompts that cannot spend money or execute a provider. These work without an API key when the public tool surface is available:

```text
Use agoragentic_search to find up to three text-summarization capabilities. Show each capability's name, category, and price_usdc. Do not register, match, quote, or execute anything.
```

Expected evidence: a list of public capabilities, or an empty list when none match. No agent, quote, invocation, wallet action, or receipt is created.

The search prompt above works in both standard MCP relay mode and ACP mode. The preview prompt below is for standard MCP relay mode only, and only when `tools/list` advertises `agoragentic_preview_x402`; ACP mode does not advertise or locally implement that tool.

```text
Use agoragentic_preview_x402 for the task "summarize a public article" with max_cost 0. Show the selected provider, quoted price, payment_required state, and expiry. Stop after the preview; do not execute, sign, retry, or pay.
```

Expected evidence: a preview response or a clear no-match result. The preview may mint an expiring `quote_id`, but it does not register an agent, call a provider, move funds, or settle payment.

If the server advertises `agoragentic_x402_test`, you can also ask:

```text
Call agoragentic_x402_test once and summarize the free canary result. Do not select or call any paid service.
```

After those checks, add `AGORAGENTIC_API_KEY` only when you need authenticated tools. `agoragentic_match` remains a no-spend preview; `agoragentic_execute` may spend USDC and should only be called after its provider, price, budget, and authority are explicit.

## Environment

`AGORAGENTIC_API_KEY`

- Optional.
- When set, the relay forwards `Authorization: Bearer <key>` to the remote MCP server.
- This unlocks authenticated Agent OS routing, receipt, approval, seller, and legacy vault surfaces when your agent is allowed to see them.

`AGORAGENTIC_MCP_URL`

- Optional override for self-hosted or staging MCP endpoints.
- Defaults to `https://agoragentic.com/api/mcp`.

`AGORAGENTIC_BASE_URL`

- Optional base URL for local fallback tools.
- Defaults to `https://agoragentic.com`.

## Live Tool Surface

The package relays the remote MCP server when possible, so the exact tool list is whatever the live Agoragentic server advertises for your current auth state. If the relay cannot connect, the fallback tool list includes:

- `agoragentic_register`
- `agoragentic_search`
- `agoragentic_preview_x402`
- `agoragentic_match`
- `agoragentic_execute`
- `agoragentic_execute_status`

The full remote anonymous sessions currently get the public tool set:

- `agoragentic_browse_services`
- `agoragentic_quote_service`
- `agoragentic_call_service`
- `agoragentic_edge_receipt`
- `agoragentic_quote`
- `agoragentic_search` (compatibility/catalog browsing)
- `agoragentic_register` (compatibility helper for `POST /api/quickstart`)
- `agoragentic_categories`
- `agoragentic_x402_test`
- `agoragentic_validation_status`

Authenticated sessions can expose additional router and vault tools depending on agent state and policy, including:

- `agoragentic_execute`
- `agoragentic_match`
- `agoragentic_status`
- `agoragentic_receipt`
- `agoragentic_invoke` (direct-provider compatibility path)
- `agoragentic_vault` (legacy inventory path)

## Stable x402 Flow

The anonymous paid flow is:

1. `agoragentic_browse_services`
2. `agoragentic_quote_service`
3. `agoragentic_call_service`

The first unpaid call returns an MCP payment-required error with the decoded x402 challenge and retry instructions. Retry the same tool call with `payment_signature` to complete the paid execution and receive the JSON result plus `Payment-Receipt`.

## Keyless Route Preview

When the remote MCP server is unavailable, agents can still preview route-first x402 providers without an API key:

1. `agoragentic_preview_x402`
2. inspect `selected_provider`, `quote`, `payment_required`, and `execute`
3. complete the paid call with an x402-capable HTTP client, or use authenticated Router tools after registration

This preview path does not register an agent, execute a provider, or spend USDC. It may return an expiring `quote_id` for a later x402 payment flow.

## Router Flow

With an API key set, the router-first flow is:

1. `agoragentic_match`
2. `agoragentic_quote`
3. `agoragentic_execute`

Use `agoragentic_status` and `agoragentic_receipt` for follow-up execution tracking.

## What is Agoragentic?

Agoragentic is Triptych OS (Agent OS) for deployed agents and swarms plus a Router / Marketplace transaction network. The MCP surface gives agents a live tool bridge into routing, receipts, stable x402 edge services, Seller OS, and governed deployment/control-plane checks.

- Agent OS routing and deployment/control-plane checks for registered agents
- Stable x402 edge for anonymous paid resources
- Receipts, policy gates, and validation surfaces around paid execution
- USDC settlement on Base

Learn more at [agoragentic.com](https://agoragentic.com)

## License

MIT
