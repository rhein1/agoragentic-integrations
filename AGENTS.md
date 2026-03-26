# AGENTS.md

> Canonical instruction file for AI coding agents working in this repository.
> Follows the [AGENTS.md](https://github.com/agentsmd/agents.md) specification.

## What This Repository Is

Drop-in integrations connecting **20 agent frameworks** to the [Agoragentic](https://agoragentic.com) capability router. Agents can autonomously discover, browse, invoke, and pay for services — settled in USDC on Base L2.

## Machine-Readable Index

**Read `integrations.json` first.** It contains every integration, package, tool, env var, and discovery link in structured JSON. Schema: `integrations.schema.json`.

## Repository Structure

```
integrations.json          ← machine-readable index (start here)
integrations.schema.json   ← JSON Schema for the index
SKILL.md                   ← capability description for LLMs
llms.txt                   ← thin bootstrap for language models
llms-full.txt              ← expanded context for deep ingestion
AGENTS.md                  ← this file (agent instructions)
CITATION.cff               ← citation metadata
glama.json                 ← Glama registry entry
a2a/agent-card.json        ← A2A protocol card
specs/ACP-SPEC.md           ← Agent Commerce Protocol spec
<framework>/README.md      ← per-framework install + quickstart  
```

## How to Use This Repo

### If you are an agent that wants to USE Agoragentic:

1. Pick your framework from `integrations.json`
2. Run the `install` command
3. Set `AGORAGENTIC_API_KEY` env var (or call `agoragentic_register` at runtime)
4. Call `agoragentic_search` to browse, `agoragentic_invoke` to buy

### If you are an agent that wants to MODIFY this repo:

1. Read `integrations.json` and `integrations.schema.json`
2. Read the per-framework README for the folder you're editing
3. Match the existing tool naming pattern (`agoragentic_*`)
4. Validate `integrations.json` against `integrations.schema.json` after changes
5. Add/update the per-framework `README.md` if you add or change an integration

## Canonical Tool IDs

All integrations must export tools matching these IDs:

| Tool | Purpose |
|------|---------|
| `agoragentic_register` | Register agent, get API key |
| `agoragentic_search` | Browse marketplace |
| `agoragentic_invoke` | Call a capability |
| `agoragentic_vault` | Check owned items |
| `agoragentic_categories` | List categories |
| `agoragentic_memory_write` | Write persistent memory |
| `agoragentic_memory_read` | Read persistent memory |
| `agoragentic_memory_search` | Search memory |
| `agoragentic_secret_store` | Store encrypted credential |
| `agoragentic_secret_retrieve` | Retrieve credential |
| `agoragentic_passport` | NFT identity check |

## Auth

- Header: `Authorization: Bearer amk_<key>`
- Env var: `AGORAGENTIC_API_KEY`
- Registration: `POST https://agoragentic.com/api/quickstart`

## Do Not

- Change tool IDs without updating `integrations.json`
- Hardcode provider IDs — use `execute(task, input)` routing
- Expose API keys in committed code or examples
- Break the `integrations.json` schema

## Discovery

| Surface | URL |
|---------|-----|
| Live API | https://agoragentic.com |
| Machine manifest | https://agoragentic.com/.well-known/agent-marketplace.json |
| API docs | https://agoragentic.com/docs.html |
| Self-test | https://agoragentic.com/api/discovery/check |
