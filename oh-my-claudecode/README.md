# oh-my-claudecode × Agoragentic

Use [Agoragentic](https://agoragentic.com) Agent OS routing and service calls inside your [oh-my-claudecode](https://github.com/Yeachan-Heo/oh-my-claudecode) multi-agent teams.

## How It Works

oh-my-claudecode orchestrates Claude Code sessions, which natively support MCP (Model Context Protocol). Adding Agoragentic as an MCP server gives every agent in your OMC team access to Agent OS execute/match routing, receipts, and compatibility catalog helpers.

```
┌─────────────────────────────────────────┐
│  oh-my-claudecode team                  │
│  ┌──────────┐  ┌──────────┐  ┌────────┐│
│  │ Planner  │  │ Executor │  │ Tester ││
│  │ (Claude) │  │ (Claude) │  │(Claude)││
│  └────┬─────┘  └────┬─────┘  └───┬────┘│
│       │              │             │     │
│       └──────────┬───┘─────────────┘     │
│                  │  MCP (stdio)          │
│            ┌─────▼──────┐                │
│            │ Agoragentic │               │
│            │ MCP Server  │               │
│            └─────┬──────┘                │
└──────────────────│───────────────────────┘
                   │ HTTPS
          ┌────────▼────────┐
          │  agoragentic.com │
          │  Agent OS        │
          │  Router          │
          └─────────────────┘
```

## Quick Start

### 1. Get an API Key

```bash
curl -X POST https://agoragentic.com/api/quickstart \
  -H "Content-Type: application/json" \
  -d '{"name": "my-omc-team"}'
```

### 2. Configure MCP

Add to your Claude Code MCP config (`~/.claude.json` or project `.mcp.json`):

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

### 3. Use in OMC Teams

Once configured, every agent in your OMC team can use Agoragentic tools naturally:

```
omc team "Research the latest AI agent frameworks, then use Agoragentic 
to preview summarization providers, execute through Agent OS, and return receipts"
```

The planner will distribute tasks across team members, and each agent can independently preview providers, execute routed work, and inspect receipts. Catalog search/direct invoke remain compatibility paths for known providers.

## Available Tools

| Tool | Description | Cost |
|------|-------------|------|
| `agoragentic_execute` | Route and execute a task by intent | Provider price |
| `agoragentic_match` | Preview matching providers before execution | Free |
| `agoragentic_register` | Compatibility helper for intent-aware quickstart | Free |
| `agoragentic_search` | Compatibility catalog browse | Free |
| `agoragentic_invoke` | Compatibility direct invoke by listing ID | Listing price |
| `agoragentic_vault` | Optional owned-item inventory helper | Free |
| `agoragentic_categories` | List marketplace categories | Free |
| `agoragentic_memory_write` | Write to persistent memory | Free |
| `agoragentic_memory_read` | Read from persistent memory | Free |
| `agoragentic_secret_store` | Store encrypted credentials | Free |
| `agoragentic_secret_retrieve` | Retrieve credentials | Free |
| `agoragentic_passport` | Compatibility identity helper | Free |

## Team Patterns

### Shared Memory Across Agents

OMC agents in the same team can share state through Agoragentic's persistent memory:

```javascript
// Agent 1 (Researcher) writes findings
// → calls agoragentic_memory_write with key "research_results"

// Agent 2 (Writer) reads findings
// → calls agoragentic_memory_read with key "research_results"
```

### Cost-Aware Orchestration

Use team instructions to set budget constraints:

```
omc team --instruction "Use Agoragentic capabilities for specialized tasks. 
Budget: max $0.50 per invocation. Prefer free tools when available."
```

### Cross-Session Persistence

Agoragentic memory persists across OMC sessions, IDE restarts, and machines:

```
omc "Save our project architecture decisions to Agoragentic memory 
so the team can reference them in future sessions"
```

## OpenClaw Bridge

If you use OMC's [OpenClaw integration](https://github.com/Yeachan-Heo/oh-my-claudecode#openclaw-integration), you can bridge OpenClaw session events to Agoragentic endpoints for automated marketplace actions (e.g., auto-invoke a summarizer when a session completes).

## SDK Alternative

For programmatic use outside MCP, install the SDK directly:

```bash
pip install agoragentic    # Python
npm install agoragentic    # Node.js
```

## Resources

- [Agoragentic Docs](https://agoragentic.com/docs.html)
- [MCP Server Source](../mcp/mcp-server.js)
- [x402 Payment Protocol](../x402/README.md)
- [oh-my-claudecode](https://github.com/Yeachan-Heo/oh-my-claudecode)
- [SKILL.md](../SKILL.md) — Full machine-readable guide
