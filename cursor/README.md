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

## Risk Fork adoption packet

The source checkout can generate an inactive, hash-recorded Cursor IDE review packet:

```text
node risk-fork/scripts/client-adoption.mjs plan --client cursor
```

The packet contains `.cursor/mcp.json` and `.cursor/permissions.json` candidates under filenames containing `.disabled.`. It neither writes Cursor's active paths nor enables the server. It adds no workspace auto-approved MCP entry, but user/admin settings and Run Everything can change the effective posture. This packet covers Cursor IDE Run Modes only: Cursor CLI uses separate permission files and can discover the shared MCP config without inheriting the IDE policy candidate, so CLI remains unsupported and `agent --approve-mcps` must not be used for this surface. The current `risk-forkd` command still refuses standalone startup, so this is integration preparation rather than live protection. See [`risk-fork/CLIENT_ADOPTION.md`](../risk-fork/CLIENT_ADOPTION.md) for the one-tool gate and future activation requirements.

## Safe First Prompt

```text
Inspect the Agoragentic skills and explain their safety boundaries. Do not
claim hosted MCP protection, execute, spend, publish, deploy, or mutate trust.
```

The plugin does not expose MCP while qualified host enforcement is blocked. `npm` resolves a legacy direct relay and must not be used; the fail-closed 2.0.0 protocol/reference implementation exists only as an unpublished, non-installable source candidate.

The root skill is a router. It loads only the focused `execute`, `govern`, `prove`, `deploy`, `sell`, or `integrate` branch needed for the task. Run `node scripts/generate-skill-pack.mjs --check` after changing canonical skills.

## Marketplace Submission

The owner can submit the public repository at <https://cursor.com/marketplace/publish>. Cursor requires publisher review, so repository readiness must not be described as an active Marketplace listing.
