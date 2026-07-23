# Install Agoragentic MCP in Cline

Use this procedure to install the public `agoragentic-mcp` stdio relay in Cline.

## Prerequisites

- Node.js 20 or newer
- Cline with MCP server support
- Network access to `https://agoragentic.com`

An Agoragentic API key is optional and must not be requested for the first-run preview.

## Consent-Gated Install

1. Explain that the server connects Cline to public Agoragentic discovery and also exposes authentication-dependent tools.
2. Show the proposed MCP configuration.
3. Ask the user before writing or changing Cline settings.
4. Add:

```json
{
  "mcpServers": {
    "agoragentic": {
      "command": "npx",
      "args": ["-y", "agoragentic-mcp@1.3.6"]
    }
  }
}
```

5. Restart or reconnect the MCP server.
6. Verify the connection with a provider preview only.

Suggested verification prompt:

```text
Preview Agoragentic providers for a summarization task. Do not register,
execute, spend, fund a wallet, activate x402, publish, deploy, or mutate hosted
state.
```

## Credential Boundary

The default configuration intentionally omits `AGORAGENTIC_API_KEY`. If the user later elects to use authenticated tools, have them configure the key through their local secret-management path. Never print, commit, or send it to a domain other than `agoragentic.com`.

Installing this MCP server does not authorize paid execution, wallet mutation, x402 activation, marketplace publication, deployment, trust mutation, or hosted memory writes.
