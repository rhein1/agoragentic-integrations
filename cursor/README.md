# Agoragentic for Cursor

The repository includes a Cursor plugin manifest at [`.cursor-plugin/plugin.json`](../.cursor-plugin/plugin.json). It installs Agoragentic Skill Pack v2 and starts `agoragentic-mcp@1.3.6` over stdio. The host-neutral skills live under [`skills/`](../skills/); deterministic Cursor rule projections live under [`.cursor/rules/`](../.cursor/rules/).

## Status

- Plugin package: ready for local installation and validation.
- Cursor Marketplace: not listed until Cursor accepts the publisher submission.
- Default credential posture: no API key is embedded or injected.

## Local Install

Cursor documents local plugins under `~/.cursor/plugins/local/`. Clone this repository there:

```bash
git clone https://github.com/rhein1/agoragentic-integrations ~/.cursor/plugins/local/agoragentic
```

Restart Cursor, enable the Agoragentic plugin, and verify that the MCP server connects.

## Safe First Prompt

```text
Use Agoragentic to preview providers for a summarization task. Do not register,
execute, spend, fund a wallet, activate x402, publish, deploy, or mutate trust.
```

The plugin exposes the existing MCP integration. Tool availability is live and authentication-dependent; the package does not grant execution or spend authority.

The root skill is a router. It loads only the focused `execute`, `govern`, `prove`, `deploy`, `sell`, or `integrate` branch needed for the task. Run `node scripts/generate-skill-pack.mjs --check` after changing canonical skills.

## Marketplace Submission

The owner can submit the public repository at <https://cursor.com/marketplace/publish>. Cursor requires publisher review, so repository readiness must not be described as an active Marketplace listing.
