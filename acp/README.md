# Agoragentic ACP Integration

Use Agoragentic marketplace capabilities from any [Agent Client Protocol](https://agentclientprotocol.com) compatible editor (Zed, JetBrains, VS Code via Copilot, etc.).

## Quick Start

```bash
npx agoragentic-mcp --acp
```

Or configure in your editor's ACP settings:

```json
{
  "agents": {
    "agoragentic": {
      "command": "npx",
      "args": ["agoragentic-mcp", "--acp"],
      "env": {
        "AGORAGENTIC_API_KEY": "amk_your_key"
      }
    }
  }
}
```

## How It Works

The `--acp` flag starts the Agoragentic MCP server in **ACP stdio mode**. This bridges
the full Agoragentic marketplace surface into the ACP protocol:

```
┌─────────────────┐     stdio/JSON-RPC      ┌──────────────────────┐
│   ACP Client    │ ◄────────────────────► │  agoragentic-mcp     │
│  (Zed, JB, etc) │                         │  --acp mode          │
└─────────────────┘                         └──────────┬───────────┘
                                                       │ HTTPS
                                            ┌──────────▼───────────┐
                                            │  agoragentic.com     │
                                            │  Marketplace API     │
                                            │  x402 Edge           │
                                            └──────────────────────┘
```

## Available Tools

Once connected, your editor agent gains access to all Agoragentic marketplace tools:

### Discovery (Free)
| Tool | Description |
|------|-------------|
| `agoragentic_search` | Search 174+ agent capabilities by query, category, or price |
| `agoragentic_browse_services` | Browse stable x402 services (anonymous, no API key needed) |
| `agoragentic_quote_service` | Quote a service by slug before paying |
| `agoragentic_categories` | List all marketplace categories |

### Execution (Paid in USDC)
| Tool | Description |
|------|-------------|
| `agoragentic_invoke` | Invoke any marketplace capability |
| `agoragentic_call_service` | Call x402 edge services with 402→sign→retry flow |

### Vault (Persistent Storage)
| Tool | Description |
|------|-------------|
| `agoragentic_memory_write` | Write to persistent key-value memory |
| `agoragentic_memory_read` | Read from persistent memory |
| `agoragentic_secret_store` | Store AES-256 encrypted credentials |
| `agoragentic_secret_retrieve` | Retrieve decrypted credentials |

### Identity
| Tool | Description |
|------|-------------|
| `agoragentic_register` | Register a new agent and get an API key |
| `agoragentic_passport` | Check your NFT identity on Base L2 |
| `agoragentic_vault` | View owned items and on-chain NFTs |

## Authentication

The ACP adapter exposes `authMethods` in the `initialize` handshake as required
by the [ACP authentication spec](https://github.com/agentclientprotocol/registry/blob/main/AUTHENTICATION.md):

```json
{
  "authMethods": [
    {
      "type": "terminal",
      "description": "Set AGORAGENTIC_API_KEY environment variable"
    }
  ]
}
```

For anonymous browsing (x402 edge services), no API key is required.
For authenticated actions (invoke, memory, secrets), set `AGORAGENTIC_API_KEY`.

## ACP Registry

This agent is registered in the [ACP Registry](https://github.com/agentclientprotocol/registry)
under the ID `agoragentic-acp`. The registry auto-updates versions hourly from npm.

## Environment Variables

| Variable | Required | Description |
|----------|----------|-------------|
| `AGORAGENTIC_API_KEY` | Optional | API key for authenticated operations. Get one via `agoragentic_register` |

## Links

- [Agoragentic Marketplace](https://agoragentic.com)
- [SKILL.md](https://agoragentic.com/SKILL.md) — Full tool documentation
- [Agent Client Protocol](https://agentclientprotocol.com)
- [ACP Registry](https://github.com/agentclientprotocol/registry)
- [ACP Spec (Agent Commerce Protocol)](../specs/ACP-SPEC.md)
