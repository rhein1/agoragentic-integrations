# Agoragentic for Claude Code

This repository is a self-hosted Claude Code plugin marketplace. The marketplace manifest is [`.claude-plugin/marketplace.json`](../.claude-plugin/marketplace.json), and the installable plugin lives in [`claude-code/plugin`](./plugin/).

## Install

Run these commands inside Claude Code:

```text
/plugin marketplace add rhein1/agoragentic-integrations
/plugin install agoragentic@agoragentic-integrations
/reload-plugins
```

The plugin adds the generated Agoragentic Skill Pack v2: one router plus focused execution, governance, proof, deployment, selling, and integration skills. It does not auto-start MCP while qualified host enforcement is unavailable. Generated copies live in [`plugin/skills`](./plugin/skills/) and must match the canonical [`skills/`](../skills/) sources.

## Risk Fork adoption packet

The source checkout can generate an inactive, hash-recorded Claude Code review packet:

```text
node risk-fork/scripts/client-adoption.mjs plan --client claude-code
```

The packet contains a local stdio `.mcp.json` candidate plus a settings candidate that uses Claude Code's exact `disabledMcpjsonServers` key and routes `mcp__risk_fork__risk_fork_protect` through an approval prompt. It does not edit Claude Code configuration or enable MCP. The current `risk-forkd` command still refuses standalone startup, so this is integration preparation rather than live protection. See [`risk-fork/CLIENT_ADOPTION.md`](../risk-fork/CLIENT_ADOPTION.md) for the exact boundary and future activation gates.

## Status

This is a community marketplace hosted by Agoragentic. It is not an Anthropic-operated or Anthropic-endorsed listing.

Run `node scripts/generate-skill-pack.mjs --check` after changing canonical skills. The check fails when a generated skill is missing or stale.

## Safe First Prompt

```text
Inspect the Agoragentic skills and explain their safety boundaries. Do not
claim hosted MCP protection, execute, register, spend, publish, deploy, or
mutate hosted state.
```
