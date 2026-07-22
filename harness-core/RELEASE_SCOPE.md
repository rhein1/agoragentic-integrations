# Harness Core Selective OSS Release Scope

Issue #855 selects a narrow public release: open-source Harness Core as a portable policy, evidence, receipt, and readiness layer for agents built with any framework. Hosted Triptych OS (Agent OS), Router / Marketplace, settlement, private connectors, and Full ECF internals remain private.

## Positioning

Public positioning:

```text
A portable policy, evidence, receipt, and readiness layer for agents built with any framework.
```

Harness Core is not a replacement for LangChain, LangGraph, CrewAI, OpenAI Agents, AutoGen, PydanticAI, Mastra, MCP, Hermes, Codex, or local Rust agent runtimes. The model loop is not the moat. Harness Core wraps local frameworks with policy, receipts, Agent OS preview export, and marketplace-readiness checks.

## Public Scope

The public package may include:

- Harness Core CLI and package metadata.
- Harness JSON schemas and profiles.
- Local run ledger, event kernel, proof, receipt, status, owner-inbox, review-gate, worktree-session, and schedule-intent artifacts.
- Host evidence import adapters.
- Framework-wrapping examples for LangGraph, CrewAI, MCP, Codex, Hermes, and the Rust reference runtime.
- Rust reference runtime examples for self-hosted, local-only proof/export checks.
- Tests proving local artifacts remain preview/readiness-only.

## Private Scope

Do not export:

- Hosted Agent OS runtime provisioning internals.
- Router / Marketplace ranking, fraud, trust, retry, or settlement internals.
- Wallet custody, payout orchestration, or funded canary secrets.
- Private connector broker internals.
- Full ECF private runtime, enterprise context graphs, customer evidence, or resident context.
- Production admin routes, operator prompts, live deployment automation, or private analytics.

## Example Inventory

The framework examples are recorded in `examples/harness-core-frameworks/framework-wrapping-examples.json`.

Required example IDs:

- `langgraph`
- `crewai`
- `mcp`
- `codex`
- `hermes`
- `rust_reference_runtime`

Each example must set `framework_replacement:false`, `agent_os_preview_only:true`, and all authority boundary booleans to `false`.

## Rust Runtime Boundary

The Rust runtime is a self-hosted reference runtime only. It may show how a local runtime exposes an Agent Card, OpenAPI profile, `/health`, `/tools`, and Harness export packet. It must not be positioned as hosted Agent OS, the commercial live product, a marketplace executor, or a settlement runtime.

## Acceptance Checklist

- Public docs describe Harness Core as a portable governance/proof/readiness layer.
- Framework examples show wrapping, not framework replacement.
- Rust runtime is framed as a reference runtime only.
- Hosted Agent OS remains the commercial live product.
- Tests prove examples and adapters keep preview/readiness-only authority.
