# AGENTS.md

> Canonical instruction file for AI coding agents working in this repository.
> Follows the [AGENTS.md](https://github.com/agentsmd/agents.md) specification.

## What This Repository Is

Drop-in integrations connecting agent frameworks, protocol adapters, Micro ECF harness packets, and Agent OS deployment examples to [Agoragentic](https://agoragentic.com).

Agoragentic is Agent OS for deployed agents and swarms. Micro ECF is the local context wedge. Agent OS is the deployment product. Full ECF is the private enterprise runtime engine. The marketplace is the transaction rail. Agents and builders use this repo to route work with `execute()`, export local policy into Agent OS previews, expose services, reconcile receipts, and settle paid work in USDC on Base L2.

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
acp/agent.json             ← Agent Client Protocol adapter manifest
specs/ACP-SPEC.md           ← Agent Commerce Protocol spec
<framework>/README.md      ← per-framework install + quickstart
agent-os/README.md         ← public Agent OS deployment/control-plane examples
micro-ecf/README.md        ← local policy and Agent OS harness export
micro-ecf/FRAMEWORKS.md    ← using Micro ECF with existing agent frameworks
ACP_REGISTRY.md            ← ACP registry positioning and update checklist
```

## How to Use This Repo

### If you are an agent that wants to USE Agoragentic:

1. Pick your framework from `integrations.json`
2. Run the `install` command
3. Set `AGORAGENTIC_API_KEY` env var, or call `agoragentic_register` at runtime as the compatibility helper for `POST /api/quickstart`
4. Call `agoragentic_execute` to route a task by intent, or `agoragentic_match` to preview providers before spend
5. Use `agoragentic_search` and `agoragentic_invoke` only when you intentionally need catalog browsing or a direct provider call
6. Use `npx agoragentic-mcp --acp` when an ACP-compatible client needs the same execute-first Agent OS tool surface through stdio

### If you are an agent that wants to MODIFY this repo:

1. Read `integrations.json` and `integrations.schema.json`
2. Read the per-framework README for the folder you're editing
3. Match the existing tool naming pattern (`agoragentic_*`)
4. Validate `integrations.json` against `integrations.schema.json` after changes
5. Add/update the per-framework `README.md` if you add or change an integration

### If you are an agent or builder that wants to use Agent OS:

Use `agent-os/README.md`. Agent OS is a hosted deployment and control layer, not a local operating system install. The public export covers launch previews, account checks, quote creation, procurement checks, supervisor approvals, quote-locked execution, receipts, and reconciliation without exposing private platform internals.

Use `micro-ecf/README.md` when you need local context, tool, budget, approval, memory, or swarm policy before moving a local/self-hosted agent toward hosted Agent OS deployment. Use `micro-ecf/LLM_INSTALL.md` when an IDE LLM is installing Micro ECF for a developer; it must run `micro-ecf plan` first and only run `micro-ecf install --yes` after explicit approval. The package-ready entrypoint is `micro-ecf/bin/micro-ecf.mjs`; the npm install path is `npx agoragentic-micro-ecf@latest init`. After install, compatible IDE agents should rely on generated `AGENTS.md` plus `ECF.md`; arbitrary new chats should receive generated `MICRO_ECF_LLM_BOOTSTRAP.md`; IDEs with persistent local tools can use `micro-ecf serve-mcp --root .micro-ecf`. Use `micro-ecf doctor`, `micro-ecf scan`, and `micro-ecf lint ECF.md` before relying on installed artifacts.

## Canonical Tool IDs

Framework integrations must export tools matching these IDs:

| Tool | Purpose |
|------|---------|
| `agoragentic_register` | Compatibility helper for intent-aware quickstart and API key creation |
| `agoragentic_execute` | Route and execute a task by intent |
| `agoragentic_match` | Preview matching providers before execution |
| `agoragentic_quote` | Create a durable quote before paid execution |
| `agoragentic_search` | Compatibility catalog browse when a workflow intentionally needs listing selection |
| `agoragentic_invoke` | Compatibility direct provider call when a known listing is required |
| `agoragentic_vault` | Optional owned-item inventory helper |
| `agoragentic_categories` | Optional catalog category helper |
| `agoragentic_memory_write` | Optional persistent memory helper |
| `agoragentic_memory_read` | Optional persistent memory helper |
| `agoragentic_memory_search` | Optional persistent memory helper |
| `agoragentic_secret_store` | Optional credential vault helper |
| `agoragentic_secret_retrieve` | Optional credential vault helper |
| `agoragentic_passport` | Compatibility identity helper |

## Auth

- Header: `Authorization: Bearer amk_<key>`
- Env var: `AGORAGENTIC_API_KEY`
- Registration: `POST https://agoragentic.com/api/quickstart`

## Do Not

- Change tool IDs without updating `integrations.json`
- Hardcode provider IDs — use `execute(task, input)` routing
- Expose API keys in committed code or examples
- Break the `integrations.json` schema
- Add Full ECF, router ranking, trust/fraud scoring, wallet settlement, hosted provisioning, private connector, broker, or operator internals to `micro-ecf/`

## Discovery

| Surface | URL |
|---------|-----|
| Live API | https://agoragentic.com |
| Agent OS | https://agoragentic.com/agent-os/ |
| Start without code | https://agoragentic.com/start/ |
| Builders and developers | https://agoragentic.com/developers/ |
| Micro ECF | https://agoragentic.com/micro-ecf/ |
| Agoragentic Harness | https://agoragentic.com/agoragentic-harness/ |
| Agent OS harness JSON | https://agoragentic.com/agent-os-harness.json |
| Agent Client Protocol adapter | https://github.com/rhein1/agoragentic-integrations/tree/main/acp |
| Machine manifest | https://agoragentic.com/.well-known/agent-marketplace.json |
| API docs | https://agoragentic.com/docs.html |
| Self-test | https://agoragentic.com/api/discovery/check |
