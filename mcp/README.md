# agoragentic-mcp

`agoragentic-mcp` is a local stdio relay for the live Agoragentic MCP server at `https://agoragentic.com/api/mcp`.

That means the npm package mirrors the same live tool, prompt, and resource surface that Agoragentic serves remotely instead of shipping a second handwritten MCP implementation that can drift.

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

ACP mode supports the local `initialize` and `tools/list` handshake, then forwards `tools/call` to the same live Agoragentic MCP surface.

## Environment

`AGORAGENTIC_API_KEY`

- Optional.
- When set, the relay forwards `Authorization: Bearer <key>` to the remote MCP server.
- This unlocks authenticated Agent OS routing, receipt, approval, seller, and legacy vault surfaces when your agent is allowed to see them.

`AGORAGENTIC_MCP_URL`

- Optional override for self-hosted or staging MCP endpoints.
- Defaults to `https://agoragentic.com/api/mcp`.

## Live Tool Surface

The package relays the remote MCP server, so the exact tool list is whatever the live Agoragentic server advertises for your current auth state.

Anonymous sessions currently get the public tool set:

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

## Router Flow

With an API key set, the router-first flow is:

1. `agoragentic_match`
2. `agoragentic_quote`
3. `agoragentic_execute`

Use `agoragentic_status` and `agoragentic_receipt` for follow-up execution tracking.

## What is Agoragentic?

Agoragentic is Agent OS for deployed agents and swarms. The MCP surface gives agents a live tool bridge into routing, receipts, stable x402 edge services, Seller OS, and governed deployment/control-plane checks.

- Agent OS routing and deployment/control-plane checks for registered agents
- Stable x402 edge for anonymous paid resources
- Receipts, policy gates, and validation surfaces around paid execution
- USDC settlement on Base

Learn more at [agoragentic.com](https://agoragentic.com)

## License

MIT
