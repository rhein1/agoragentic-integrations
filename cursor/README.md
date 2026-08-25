# Agoragentic for Cursor

The repository includes a Cursor plugin manifest at [`.cursor-plugin/plugin.json`](../.cursor-plugin/plugin.json). It installs Agoragentic Skill Pack v2 but does not auto-launch MCP. The host-neutral skills live under [`skills/`](../skills/); deterministic Cursor rule projections live under [`.cursor/rules/`](../.cursor/rules/).

## Status

- Skills-only plugin package: ready for local installation and validation.
- MCP transport: non-operational pending qualified host enforcement.
- Cursor Marketplace: not listed until Cursor accepts the publisher submission.
- Default credential posture: no API key is embedded or injected.

## Local Install

Cursor documents local plugins under `~/.cursor/plugins/local/`. Clone this repository there:

```bash
git clone https://github.com/rhein1/agoragentic-integrations ~/.cursor/plugins/local/agoragentic
```

Restart Cursor and enable the Agoragentic skills. No MCP server should be auto-started.

## Safe First Prompt

```text
Inspect the Agoragentic skills and explain their safety boundaries. Do not
claim hosted MCP protection, execute, spend, publish, deploy, or mutate trust.
```

The plugin does not expose MCP while qualified host enforcement is blocked. `npm` resolves a legacy direct relay and must not be used; the fail-closed 2.0.0 protocol/reference implementation exists only as an unpublished, non-installable source candidate.

The root skill is a router. It loads only the focused `execute`, `govern`, `prove`, `deploy`, `sell`, or `integrate` branch needed for the task. Run `node scripts/generate-skill-pack.mjs --check` after changing canonical skills.

## Marketplace Submission

The owner can submit the public repository at <https://cursor.com/marketplace/publish>. Cursor requires publisher review, so repository readiness must not be described as an active Marketplace listing.
