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

## Status

This is a community marketplace hosted by Agoragentic. It is not an Anthropic-operated or Anthropic-endorsed listing.

Run `node scripts/generate-skill-pack.mjs --check` after changing canonical skills. The check fails when a generated skill is missing or stale.

## Safe First Prompt

```text
Inspect the Agoragentic skills and explain their safety boundaries. Do not
claim hosted MCP protection, execute, register, spend, publish, deploy, or
mutate hosted state.
```
