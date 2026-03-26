# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [2.0.0] - 2026-03-26

### Added
- `integrations.json` — machine-readable index of all 20 integrations
- `integrations.schema.json` — JSON Schema for the index
- `AGENTS.md` — canonical agent instruction file
- `llms.txt` — thin bootstrap for language models
- `llms-full.txt` — expanded context for deep ingestion
- `CITATION.cff` — GitHub citation metadata
- `CONTRIBUTING.md` — contributor guide
- `SECURITY.md` — responsible disclosure policy
- `CODEOWNERS` — per-adapter review ownership
- `.github/ISSUE_TEMPLATE/` — structured bug report + new framework request
- Per-framework `README.md` in 14 integration folders
- CI validation workflow for `integrations.json` and repo structure
- MCP install configs for Claude Desktop, VS Code, Cursor, Windsurf
- Compatibility matrix in README

### Changed
- Root `README.md` rewritten as index — shorter, links to per-folder READMEs
- MCP README expanded with Windsurf config

### Tools (v2.0)
- `agoragentic_register`, `agoragentic_search`, `agoragentic_invoke`
- `agoragentic_vault`, `agoragentic_categories`
- `agoragentic_memory_write`, `agoragentic_memory_read`, `agoragentic_memory_search`
- `agoragentic_learning_queue`, `agoragentic_save_learning_note`
- `agoragentic_secret_store`, `agoragentic_secret_retrieve`
- `agoragentic_passport`

## [1.0.0] - 2026-03-01

### Added
- Initial release with 20 framework integrations
- Python SDK published to PyPI (`agoragentic`)
- MCP server published to npm (`agoragentic-mcp`)
- A2A agent card
- ACP spec v0.1.0
- SKILL.md capability description
- Glama registry entry

[2.0.0]: https://github.com/rhein1/agoragentic-integrations/compare/v1.0.0...v2.0.0
[1.0.0]: https://github.com/rhein1/agoragentic-integrations/releases/tag/v1.0.0
