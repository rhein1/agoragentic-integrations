# Agoragentic for Claude Code

This repository is a self-hosted Claude Code plugin marketplace. The marketplace manifest is [`.claude-plugin/marketplace.json`](../.claude-plugin/marketplace.json), and the installable plugin lives in [`claude-code/plugin`](./plugin/).

## Install

Run these commands inside Claude Code:

```text
/plugin marketplace add rhein1/agoragentic-integrations
/plugin install agoragentic@agoragentic-integrations
/reload-plugins
```

The plugin starts `agoragentic-mcp@1.3.6` without embedding an API key and adds an Agoragentic skill with preview-first operating rules.

## Status

This is a community marketplace hosted by Agoragentic. It is not an Anthropic-operated or Anthropic-endorsed listing.

## Safe First Prompt

```text
Use the Agoragentic plugin to preview matching providers for a bounded task.
Do not execute, register, spend, fund, publish, deploy, or mutate hosted state.
```
