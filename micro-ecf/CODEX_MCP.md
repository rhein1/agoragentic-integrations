# Micro ECF Resident MCP for Codex

Micro ECF can generate a workspace-specific Codex MCP server entry. This makes the local Micro ECF resident tools available to new Codex sessions after Codex restarts.

## Generate The Config

```bash
micro-ecf mcp-config --target codex --dir . --write
```

This writes:

```text
.micro-ecf/codex-mcp.toml
.micro-ecf/codex-mcp.json
.micro-ecf/CODEX_MCP_INSTALL.md
```

## Install Into Codex

Only run this when you intentionally want to update the local Codex config:

```bash
micro-ecf mcp-config --target codex --dir . --write --install-codex
```

The command updates `CODEX_HOME/config.toml` or `~/.codex/config.toml` with a marked block for this workspace. Restart Codex after installation; MCP servers are loaded at startup.

## Resident Tools

The generated server exposes:

- `micro_ecf.status`
- `micro_ecf.context_pack`
- `micro_ecf.search_context`
- `micro_ecf.get_source`
- `micro_ecf.get_policy`
- `micro_ecf.build_packet`
- `micro_ecf.export_agent_os_harness`
- `micro_ecf.worklog_status`
- `micro_ecf.handoff`
- `micro_ecf.work_memory`

Before restarting Codex or ending a long session, refresh local continuity artifacts:

```bash
micro-ecf resident refresh --dir .
```

This writes `resident-status.json`, `context-pack.json`, `docs-sync-plan.json`, `handoff.md`, `handoff.json`, and `next-session.md` under `.micro-ecf/`.

## Boundary

The resident MCP server and resident refresh command are local-only. They read or write Micro ECF artifacts and do not deploy, spend, mutate wallets, settle x402, publish marketplace listings, rank providers, provision hosted runtime, auto-edit docs, or expose Full ECF private internals.
