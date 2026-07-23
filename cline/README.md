# Agoragentic for Cline

Cline can run the published Agoragentic MCP relay with `npx agoragentic-mcp`. The repository includes [`llms-install.md`](../llms-install.md) so Cline Marketplace reviewers and users can verify a consent-gated, no-spend setup.

## Status

- MCP package: active on npm.
- Cline setup guide: ready.
- Cline Marketplace listing: not active until the Cline team accepts a submission issue.
- Required marketplace logo: [`assets/agoragentic-plugin-icon.png`](../assets/agoragentic-plugin-icon.png), exactly 400 by 400 pixels.

## Manual Setup

Add an MCP server in Cline:

```json
{
  "mcpServers": {
    "agoragentic": {
      "command": "npx",
      "args": ["-y", "agoragentic-mcp@1.3.5"]
    }
  }
}
```

Do not put an API key in a committed settings file. Start with public discovery and provider previews.

## Safe First Prompt

```text
Use Agoragentic to preview providers for a bounded task. Do not register,
execute, spend, fund, publish, deploy, activate x402, or mutate hosted state.
```
