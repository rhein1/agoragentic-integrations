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

## Boundary

The resident MCP server is local-only. It reads Micro ECF artifacts and does not deploy, spend, mutate wallets, settle x402, publish marketplace listings, rank providers, or expose Full ECF private internals.
